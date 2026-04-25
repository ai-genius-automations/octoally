import { FastifyPluginAsync } from 'fastify';
import {
  attachTerminal, writeToSession, resizeSession, reconnectSession,
  getPendingSpawn, consumePendingSpawn, spawnSession, spawnTerminal, spawnAdopt, spawnAgent,
  sendReplay,
} from '../services/session-manager.js';
import { getDb } from '../db/index.js';

/**
 * Terminal WebSocket route
 * Connect to /api/terminal/:sessionId to get live PTY output and send input
 *
 * Supports "lazy spawn": sessions created via REST stay pending until the
 * first WebSocket sends a resize with actual terminal dimensions. This
 * ensures tmux is created at the exact right size — no resize/redraw needed.
 */
export const terminalRoutes: FastifyPluginAsync = async (app) => {
  app.get<{
    Params: { sessionId: string };
    Querystring: { passive?: string; attempt?: string };
  }>('/terminal/:sessionId', { websocket: true }, (socket, req) => {
    const { sessionId } = req.params;
    const isPassive = req.query.passive === '1';
    const attempt = req.query.attempt || '?';

    // Check if this is a pending session that needs to be spawned.
    // Use getPendingSpawn (peek) instead of consume — React StrictMode
    // double-mounts effects, so the first WebSocket may close immediately.
    // Only consume after successful spawn.
    const pending = getPendingSpawn(sessionId);
    if (pending) {
      let spawned = false;

      // If this WebSocket closes before spawning, do nothing — the pending
      // spawn stays in the map for the next connection to pick up.
      socket.on('close', () => {
        // nothing to clean up if not yet spawned
      });

      socket.on('message', async (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString());

          if (!spawned && msg.type === 'resize') {
            // Now consume — this connection will own the spawn
            const info = consumePendingSpawn(sessionId);
            if (!info) {
              // Another connection beat us — try normal attach
              const attached = attachTerminal(sessionId, socket);
              if (attached) { spawned = true; }
              return;
            }

            spawned = true;
            try {
              if (info.mode === 'adopt' && info.socketPath) {
                await spawnAdopt(sessionId, info.socketPath, info.projectPath, info.task, msg.cols, msg.rows);
              } else if (info.mode === 'terminal') {
                await spawnTerminal(sessionId, info.projectPath, msg.cols, msg.rows);
              } else if (info.mode === 'agent' && info.agentType) {
                await spawnAgent(sessionId, info.projectPath, info.task, info.agentType, msg.cols, msg.rows, info.cliType);
              } else {
                await spawnSession(sessionId, info.projectPath, info.task, msg.cols, msg.rows, info.cliType, info.resumeSessionId);
              }
              const attached = attachTerminal(sessionId, socket);
              if (!attached) {
                socket.send(JSON.stringify({ type: 'error', message: 'Failed to attach after spawn' }));
                socket.close();
              }
            } catch (err: any) {
              socket.send(JSON.stringify({ type: 'error', message: `Spawn failed: ${err.message}` }));
              socket.close();
            }
            return;
          }

          if (spawned) {
            switch (msg.type) {
              case 'input':
                writeToSession(sessionId, msg.data, msg.paste);
                break;
              case 'resize':
                resizeSession(sessionId, msg.cols, msg.rows);
                break;
            }
          }
        } catch {
          if (spawned) writeToSession(sessionId, raw.toString());
        }
      });

      socket.send(JSON.stringify({ type: 'connected', sessionId }));
      return;
    }

    // Normal flow: session already running.
    //
    // Passive connections (grid/thumbnail terminals): subscribe + replay
    // immediately — they never send resize so we can't wait for one.
    //
    // Active connections: don't subscribe yet. Wait for the browser to send
    // its resize so we can resize the tmux pane, wait for reflow, then send
    // a clean capture-pane snapshot. Only THEN subscribe for live output.
    // This prevents tmux resize-redraw garbage from reaching the client.

    // Both passive and active paths need async reconnect (worker fork),
    // so wrap in an async IIFE to handle awaiting properly.
    (async () => {
      if (isPassive) {
        let attached = attachTerminal(sessionId, socket);
        if (!attached) {
          await reconnectSession(sessionId);
          attached = attachTerminal(sessionId, socket);
        }
        if (!attached) {
          // Mark dead sessions as failed so they stop appearing in the grid
          getDb().prepare(`
            UPDATE sessions SET status = 'failed', completed_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ? AND status IN ('running', 'detached')
          `).run(sessionId);
          socket.send(JSON.stringify({ type: 'error', message: 'Session not found or not running' }));
          socket.close();
          return;
        }
        // Passive terminals forward input and handle refresh
        socket.on('message', (raw: Buffer | string) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'input') writeToSession(sessionId, msg.data, msg.paste);
            else if (msg.type === 'refresh') {
              console.log(`[REFRESH] ${sessionId}: passive client requested capture-pane refresh`);
              sendReplay(sessionId, socket, true);
            }
          } catch { /* ignore */ }
        });
        socket.send(JSON.stringify({ type: 'connected', sessionId }));
        return;
      }

      // Active connection: subscribe + replay.
      let attached = attachTerminal(sessionId, socket);
      if (!attached) {
        await reconnectSession(sessionId);
        attached = attachTerminal(sessionId, socket);
      }
      if (!attached) {
        getDb().prepare(`
          UPDATE sessions SET status = 'failed', completed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status IN ('running', 'detached')
        `).run(sessionId);
        socket.send(JSON.stringify({ type: 'error', message: 'Session not found or not running' }));
        socket.close();
        return;
      }

      // Handle incoming messages from the browser terminal
      socket.on('message', (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString());

          switch (msg.type) {
            case 'input':
              writeToSession(sessionId, msg.data, msg.paste);
              break;

            case 'resize':
              resizeSession(sessionId, msg.cols, msg.rows);
              break;

            case 'refresh':
              // Client requested a fresh display — use tmux capture-pane
              // to get the current visual state (like adopt does).
              // This fixes Codex rendering issues without pop-out/re-adopt.
              console.log(`[REFRESH] ${sessionId}: client requested capture-pane refresh`);
              sendReplay(sessionId, socket, true);
              break;
          }
        } catch {
          writeToSession(sessionId, raw.toString());
        }
      });

      socket.send(JSON.stringify({ type: 'connected', sessionId }));
    })().catch((err) => {
      console.error(`[WS] Error in terminal handler for ${sessionId}:`, err);
      try {
        socket.send(JSON.stringify({ type: 'error', message: 'Internal error' }));
        socket.close();
      } catch { /* ignore */ }
    });
  });
};
