import { FastifyPluginAsync } from 'fastify';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as { Terminal: any };
const { SerializeAddon } = require('@xterm/addon-serialize') as { SerializeAddon: any };
import { spawn } from 'child_process';
import { platform } from 'os';
import * as sessionManager from '../services/session-manager.js';
import { RESIZE_MARKER, registerPendingSpawn, getSessionTmuxServer } from '../services/session-manager.js';
import { getTracker } from '../services/session-state.js';
import { getDb } from '../db/index.js';

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  // List sessions
  app.get<{
    Querystring: { status?: string };
  }>('/sessions', async (req) => {
    const sessions = sessionManager.listSessions(req.query.status);
    return { sessions };
  });

  // Discover external detached sessions available for adoption
  // (must be registered before /sessions/:id to avoid parameterized route match)
  app.get<{
    Querystring: { project_path?: string };
  }>('/sessions/discoverable', async (req) => {
    const sessions = await sessionManager.discoverExternalSessions(req.query.project_path);
    return { sessions };
  });

  // Resume an external claude process inside OctoAlly (kills the PID, resumes via --resume <id>)
  app.post<{
    Body: { pid: number; session_id: string; project_path: string; task: string; project_id?: string };
  }>('/sessions/resume-external', async (req, reply) => {
    const { pid, session_id, project_path, task, project_id } = req.body as any;
    if (!pid || !session_id || !project_path) {
      return reply.status(400).send({ error: 'pid, session_id, and project_path are required' });
    }
    const session = await sessionManager.resumeExternalSession(pid, session_id, project_path, task, project_id);
    return { ok: true, session };
  });

  // Scan ALL running claude processes system-wide (not limited to hivemind sockets)
  app.get('/sessions/scan-all', async () => {
    const sessions = await sessionManager.scanAllClaudeSessions();
    return { sessions };
  });

  // Adopt an external detached session into OctoAlly
  app.post<{
    Body: { socket_path: string; project_id?: string };
  }>('/sessions/adopt', async (req, reply) => {
    const { socket_path, project_id } = req.body as any;
    if (!socket_path) {
      return reply.status(400).send({ error: 'socket_path is required' });
    }

    const session = await sessionManager.adoptDtachSession(socket_path, project_id);
    if (!session) {
      return reply.status(404).send({ error: 'Socket not found or not alive' });
    }

    return { ok: true, session };
  });

  // Get single session
  app.get<{
    Params: { id: string };
  }>('/sessions/:id', async (req, reply) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    return { session };
  });

  // Create and start a new session (or plain terminal)
  app.post<{
    Body: {
      project_path: string;
      task: string;
      project_id?: string;
      mode?: 'session' | 'terminal' | 'agent';
      agent_type?: string;
      cli_type?: 'claude' | 'codex';
    };
  }>('/sessions', async (req, reply) => {
    const { project_path, task, project_id, mode, agent_type, cli_type } = req.body as any;
    const cliType = cli_type === 'codex' ? 'codex' : 'claude';

    if (mode === 'terminal') {
      if (!project_path) {
        return reply.status(400).send({ error: 'project_path is required' });
      }
      const session = sessionManager.createSession(project_path, 'Terminal', project_id);
      registerPendingSpawn(session.id, { projectPath: project_path, task: 'Terminal', mode: 'terminal', projectId: project_id });
      return { ok: true, session };
    }

    if (!project_path || !task) {
      return reply.status(400).send({ error: 'project_path and task are required' });
    }

    if (mode === 'agent') {
      if (!agent_type) {
        return reply.status(400).send({ error: 'agent_type is required for agent mode' });
      }
      const session = sessionManager.createSession(project_path, `Agent (${agent_type}): ${task}`, project_id, cliType);
      registerPendingSpawn(session.id, { projectPath: project_path, task, mode: 'agent', agentType: agent_type, projectId: project_id, cliType });
      return { ok: true, session };
    }

    const session = sessionManager.createSession(project_path, task, project_id, cliType);
    registerPendingSpawn(session.id, { projectPath: project_path, task, mode: 'session', projectId: project_id, cliType });

    return { ok: true, session };
  });

  // Kill a session — never blocks longer than 3s
  app.delete<{
    Params: { id: string };
  }>('/sessions/:id', async (req, reply) => {
    const id = req.params.id;
    try {
      const killed = await Promise.race([
        sessionManager.killSession(id),
        new Promise<boolean>((resolve) => setTimeout(() => {
          console.log(`[KILL] Session ${id} kill timed out after 3s, forcing DB update`);
          // Force DB update even if kill is stuck
          try {
            getDb().prepare(`
              UPDATE sessions SET status = 'cancelled', completed_at = datetime('now'), updated_at = datetime('now')
              WHERE id = ? AND status IN ('running', 'pending', 'detached')
            `).run(id);
          } catch { /* ignore */ }
          resolve(true);
        }, 3000)),
      ]);
      if (!killed) return reply.status(404).send({ error: 'Session not found or not running' });
    } catch {
      // Kill threw — still mark as cancelled
      try {
        getDb().prepare(`
          UPDATE sessions SET status = 'cancelled', completed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status IN ('running', 'pending', 'detached')
        `).run(id);
      } catch { /* ignore */ }
    }
    return { ok: true };
  });

  // Concise context summary for cross-session awareness (low token cost)
  app.get('/context', async () => {
    const running = sessionManager.listSessions('running');
    if (running.length === 0) return { active: false, summary: 'No active OctoAlly sessions.' };

    const sessions = running.map(s => {
      const tracker = getTracker(s.id);
      const state = tracker?.state;
      const mins = s.started_at ? Math.round((Date.now() - new Date(s.started_at).getTime()) / 60000) : 0;
      return `${s.id}: "${s.task.slice(0, 80)}" [${state?.processState ?? 'unknown'}] ${mins}m`;
    });

    return { active: true, count: running.length, sessions };
  });

  // Reconnect to a detached tmux session
  app.post<{
    Params: { id: string };
  }>('/sessions/:id/reconnect', async (req, reply) => {
    const reconnected = await sessionManager.reconnectSession(req.params.id);
    if (!reconnected) return reply.status(404).send({ error: 'Session not found or not detached' });
    const session = sessionManager.getSession(req.params.id);
    return { ok: true, session };
  });

  // Paginated PTY output (stored in SQLite)
  app.get<{
    Params: { id: string };
    Querystring: { before?: string; limit?: string };
  }>('/sessions/:id/output', async (req, reply) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    const before = req.query.before ? parseInt(req.query.before, 10) : undefined;
    const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 2000);

    return sessionManager.querySessionOutput(req.params.id, { before, limit });
  });

  // Rendered terminal history — replays PTY data through a headless terminal,
  // processing resize markers so the terminal dimensions match the original
  // session at every point. This ensures TUI cursor movements render correctly.
  app.get<{
    Params: { id: string };
    Querystring: { cols?: string; rows?: string };
  }>('/sessions/:id/rendered-output', async (req, reply) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    // Fallback dimensions if no resize markers exist
    const fallbackCols = Math.min(parseInt(req.query.cols || '120', 10) || 120, 300);
    const fallbackRows = Math.min(parseInt(req.query.rows || '40', 10) || 40, 200);

    // Load PTY chunks (including resize markers). Cap at 50k chunks to
    // prevent the headless terminal from choking on very large sessions.
    const allChunks = sessionManager.querySessionOutput(req.params.id, { limit: 50000 });

    // Separate resize markers from data chunks. Find first resize to set
    // initial dimensions, then build ordered segments.
    let initCols = fallbackCols;
    let initRows = fallbackRows;

    // Find the first resize marker to use as initial dimensions
    for (const chunk of allChunks.chunks) {
      if (chunk.data.startsWith(RESIZE_MARKER)) {
        const parts = chunk.data.slice(RESIZE_MARKER.length).split(',');
        initCols = parseInt(parts[0], 10) || fallbackCols;
        initRows = parseInt(parts[1], 10) || fallbackRows;
        break;
      }
    }

    const term = new HeadlessTerminal({
      cols: initCols, rows: initRows, scrollback: 200000, allowProposedApi: true,
    });
    const serializeAddon = new SerializeAddon();
    term.loadAddon(serializeAddon);

    // Process chunks sequentially, resizing when markers are encountered.
    // Write in bounded batches (~512KB) so the headless terminal's internal
    // write queue can drain properly — one giant multi-MB write can stall.
    const MAX_BATCH = 512 * 1024;
    const rendered = await new Promise<string>((resolve) => {
      let idx = 0;

      function processNext() {
        let batchData = '';
        while (idx < allChunks.chunks.length) {
          const chunk = allChunks.chunks[idx];
          if (chunk.data.startsWith(RESIZE_MARKER)) {
            // Flush accumulated data first, then resize
            if (batchData) {
              term.write(batchData);
              batchData = '';
            }
            const parts = chunk.data.slice(RESIZE_MARKER.length).split(',');
            const newCols = parseInt(parts[0], 10);
            const newRows = parseInt(parts[1], 10);
            if (newCols > 0 && newRows > 0) {
              term.resize(newCols, newRows);
            }
            idx++;
            continue;
          }
          batchData += chunk.data;
          idx++;
          // Flush when batch exceeds size limit — use callback to chain next batch
          if (batchData.length >= MAX_BATCH) {
            term.write(batchData, () => processNext());
            return;
          }
        }

        // Flush remaining data then finalize. Always use the callback form
        // to drain the async write queue — previous term.write() calls (at
        // resize boundaries) may still be pending.
        term.write(batchData, () => finalize());
      }

      function finalize() {
        const result = serializeAddon.serialize();
        term.dispose();

        // Collapse runs of blank lines to max 1
        const isBlank = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '').trim() === '';
        const lines = result.split('\n');
        const collapsed: string[] = [];
        let blankRun = 0;
        for (const line of lines) {
          if (isBlank(line)) {
            blankRun++;
            if (blankRun <= 1) collapsed.push('');
          } else {
            blankRun = 0;
            collapsed.push(line);
          }
        }
        // Strip leading/trailing blanks
        while (collapsed.length > 0 && collapsed[0] === '') collapsed.shift();
        while (collapsed.length > 0 && collapsed[collapsed.length - 1] === '') collapsed.pop();
        resolve(collapsed.join('\n'));
      }

      processNext();
    });

    return { rendered };
  });

  // Pop out a session into an external terminal emulator
  app.post<{
    Params: { id: string };
  }>('/sessions/:id/pop-out', async (req, reply) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    const sessionId = req.params.id;
    const socketPath = sessionManager.getSessionSocketPath(sessionId);
    const tmuxSession = sessionManager.getSessionTmuxName(sessionId);

    // Build the attach command — prefer dtach socket, fall back to tmux session
    let attachCmd: string;
    if (socketPath) {
      attachCmd = `dtach -a ${socketPath} -Ez`;
    } else if (tmuxSession) {
      const tmuxServer = getSessionTmuxServer(req.params.id);
      attachCmd = `tmux -L ${tmuxServer} attach-session -t ${tmuxSession}`;
    } else {
      return reply.status(400).send({ error: 'No dtach socket or tmux session found' });
    }

    // Platform-specific terminal emulator lists
    const terminals = platform() === 'darwin'
      ? [
          // macOS: use osascript to open Terminal.app or iTerm2
          { cmd: 'osascript', args: ['-e', `tell application "iTerm2" to create window with default profile command "${attachCmd}"`] },
          { cmd: 'osascript', args: ['-e', `tell application "Terminal" to do script "${attachCmd}"`] },
        ]
      : [
          // Linux: try common terminal emulators
          { cmd: 'tilix', args: ['-e', attachCmd] },
          { cmd: 'gnome-terminal', args: ['--', 'bash', '-c', attachCmd] },
          { cmd: 'konsole', args: ['-e', attachCmd] },
          { cmd: 'xfce4-terminal', args: ['-e', attachCmd] },
          { cmd: 'alacritty', args: ['-e', 'bash', '-c', attachCmd] },
          { cmd: 'xterm', args: ['-e', attachCmd] },
        ];

    // Try each terminal until one launches successfully
    return new Promise((resolve) => {
      let resolved = false;
      let idx = 0;
      function tryNext(): void {
        if (idx >= terminals.length) {
          resolved = true;
          resolve({ ok: false, error: 'No terminal emulator found' });
          return;
        }
        const t = terminals[idx++];
        const child = spawn(t.cmd, t.args, {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();

        let failed = false;
        child.on('error', (err: NodeJS.ErrnoException) => {
          failed = true;
          if (err.code === 'ENOENT') {
            tryNext(); // not installed, try next
          } else if (!resolved) {
            resolved = true;
            resolve({ ok: false, error: err.message });
          }
        });

        // If no error within 300ms, assume it launched — release OctoAlly's hold
        setTimeout(() => {
          if (failed || resolved) return;
          resolved = true;
          sessionManager.releaseSession(sessionId);
          resolve({ ok: true, terminal: t.cmd, socketPath: socketPath || tmuxSession });
        }, 300);
      }
      tryNext();
    });
  });
};
