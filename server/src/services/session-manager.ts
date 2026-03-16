import { fork, execFile, execFileSync, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import { readFile, readdirSync, readFileSync, existsSync, unlinkSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { getDb } from '../db/index.js';
import { insertEvent } from './event-store.js';
import { config } from '../config.js';
import { getSetting } from '../routes/settings.js';
import { nanoid } from 'nanoid';
import type { WebSocket } from 'ws';
import { getOrCreateTracker, removeTracker, recoverFromBuffer } from './session-state.js';

const nodeRequire = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = nodeRequire('@xterm/headless') as { Terminal: any };
const { SerializeAddon } = nodeRequire('@xterm/addon-serialize') as { SerializeAddon: any };

const execFileAsync = promisify(execFile);
const readFileAsync = promisify(readFile);

const TIMING_LOG = '/tmp/hivecommand-timing.log';
function tlog(s: string): void {
  try { appendFileSync(TIMING_LOG, `[${new Date().toISOString()}] ${s}\n`); } catch {}
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the PTY worker script — resolved relative to this file */
const WORKER_SCRIPT = join(__dirname, 'pty-worker.js');
/** For tsx dev mode, use the .ts source directly */
const WORKER_SCRIPT_TS = join(__dirname, 'pty-worker.ts');

function getWorkerScript(): string {
  // In dev (tsx), use .ts source. In production (compiled), use .js.
  if (existsSync(WORKER_SCRIPT)) return WORKER_SCRIPT;
  return WORKER_SCRIPT_TS;
}

/* ================================================================
   OpenClaw system event push — notify the main session of significant
   session lifecycle events. Fire-and-forget, concise messages only.
   ================================================================ */

function pushSystemEvent(text: string): void {
  execFile('openclaw', ['system', 'event', '--text', text, '--mode', 'now'], (err) => {
    if (err) {
      // OpenClaw may not be running — silently ignore
    }
  });
}

export interface Session {
  id: string;
  project_id: string | null;
  task: string;
  status: string;
  pid: number | null;
  claude_session_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  exit_code: number | null;
  created_at: string;
  updated_at: string;
  terminal_cols: number | null;
}

interface ActiveSession {
  worker: ChildProcess;
  subscribers: Set<WebSocket>;
  seq: number; // monotonic counter for pty_output rows
  cols: number; // last known terminal column width
  task: string; // 'Terminal' for plain shells, task description for hivemind
  externalSocket?: string; // external hivemind dtach socket (adopted sessions)
  replayBuffer: string[];  // ring buffer of recent output chunks for instant replay
  replayBytes: number;     // total bytes in replayBuffer
  wsPendingData: string | null; // batched WS output waiting to be sent
}

const activeSessions = new Map<string, ActiveSession>();

/* Pending spawns: sessions created via REST API that await terminal dimensions
   from the first WebSocket connection before actually starting. */
interface PendingSpawn {
  projectPath: string;
  task: string;
  mode: 'hivemind' | 'terminal' | 'adopt' | 'agent';
  agentType?: string;
  projectId?: string;
  socketPath?: string;  // for adopt mode
}
const pendingSpawns = new Map<string, PendingSpawn>();

export function registerPendingSpawn(sessionId: string, info: PendingSpawn): void {
  pendingSpawns.set(sessionId, info);
}

export function getPendingSpawn(sessionId: string): PendingSpawn | undefined {
  return pendingSpawns.get(sessionId);
}

export function consumePendingSpawn(sessionId: string): PendingSpawn | undefined {
  const info = pendingSpawns.get(sessionId);
  if (info) pendingSpawns.delete(sessionId);
  return info;
}

/* ================================================================
   SQLite-backed PTY output storage (replaces in-memory buffer)
   ================================================================ */

import type Database from 'better-sqlite3';
let _insertStmt: Database.Statement | null = null;
function getInsertStmt(): Database.Statement {
  if (!_insertStmt) {
    _insertStmt = getDb().prepare(
      'INSERT INTO pty_output (session_id, seq, data) VALUES (?, ?, ?)'
    );
  }
  return _insertStmt;
}

// Batch insert buffer: accumulate chunks and flush every 100ms
const pendingInserts = new Map<string, { sessionId: string; seq: number; data: string }[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// Maximum rows to keep per session in pty_output (prevents unbounded growth)
const MAX_PTY_ROWS_PER_SESSION = 2000;
let pruneCounter = 0;

function queuePtyInsert(sessionId: string, seq: number, data: string): void {
  let batch = pendingInserts.get(sessionId);
  if (!batch) {
    batch = [];
    pendingInserts.set(sessionId, batch);
  }
  batch.push({ sessionId, seq, data });

  if (!flushTimer) {
    flushTimer = setTimeout(flushPtyInserts, 250);
  }
}

function flushPtyInserts(): void {
  flushTimer = null;
  const db = getDb();
  const stmt = getInsertStmt();

  // Coalesce: merge all chunks per session into one row to minimize DB writes
  const coalesced: { sessionId: string; seq: number; data: string }[] = [];
  for (const [sessionId, batch] of pendingInserts) {
    if (batch.length === 0) continue;
    if (batch.length === 1) {
      coalesced.push(batch[0]);
    } else {
      // Combine all chunks, use the last seq number
      const combined = batch.map(r => r.data).join('');
      coalesced.push({ sessionId, seq: batch[batch.length - 1].seq, data: combined });
    }
  }

  if (coalesced.length === 0) {
    pendingInserts.clear();
    return;
  }

  const insertAll = db.transaction(() => {
    for (const row of coalesced) {
      stmt.run(row.sessionId, row.seq, row.data);
    }
  });
  try {
    insertAll();
  } catch (err) {
    console.error('Failed to flush pty_output inserts:', err);
  }
  pendingInserts.clear();

  // Prune old rows every ~240 flushes (~60s) as a safety net.
  // Primary cleanup happens immediately on session kill/exit and at startup.
  pruneCounter++;
  if (pruneCounter >= 240) {
    pruneCounter = 0;
    prunePtyOutput();
  }
}

/** Delete old pty_output rows beyond the per-session cap */
function prunePtyOutput(): void {
  try {
    const db = getDb();
    // Delete rows for completed/cancelled/failed sessions entirely
    const dead = db.prepare(`
      DELETE FROM pty_output WHERE session_id IN (
        SELECT id FROM sessions WHERE status IN ('completed', 'cancelled', 'failed')
      )
    `).run();
    // For active sessions, keep only the last MAX_PTY_ROWS_PER_SESSION rows
    const trimmed = db.prepare(`
      DELETE FROM pty_output WHERE rowid IN (
        SELECT p.rowid FROM pty_output p
        JOIN sessions s ON p.session_id = s.id
        WHERE s.status IN ('running', 'detached')
        AND p.seq <= (
          SELECT MAX(p2.seq) - ? FROM pty_output p2 WHERE p2.session_id = p.session_id
        )
      )
    `).run(MAX_PTY_ROWS_PER_SESSION);

    // Periodic VACUUM when we deleted a lot of data
    const totalDeleted = dead.changes + trimmed.changes;
    if (totalDeleted > 500) {
      const freePages = (db.pragma('freelist_count') as { freelist_count: number }[])[0].freelist_count;
      const pageSize = (db.pragma('page_size') as { page_size: number }[])[0].page_size;
      const freeMB = freePages * pageSize / 1048576;
      if (freeMB > 10) {
        db.exec('VACUUM');
        console.log(`  VACUUM reclaimed ~${freeMB.toFixed(1)}MB after pruning ${totalDeleted} rows`);
      }
    }
  } catch (err) {
    console.error('Failed to prune pty_output:', err);
  }
}

/** Read last N chunks from SQLite for a session, ordered by seq */
function readRecentOutput(sessionId: string, limit: number): string[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT data FROM pty_output WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
  ).all(sessionId, limit) as { data: string }[];
  // Reverse so they're in chronological order
  return rows.reverse().map(r => r.data);
}

/**
 * Render stored pipe-pane output through a HeadlessTerminal + SerializeAddon.
 * Returns a serialized string that can be written to an xterm.js terminal to
 * perfectly restore the visual state. Handles resize markers so the headless
 * terminal dimensions match the original session at each point.
 */
async function serializeSessionOutput(sessionId: string, cols: number, rows: number): Promise<string | null> {
  const db = getDb();
  // Read up to 5000 chunks (enough for most sessions, caps processing time)
  const dbRows = db.prepare(
    'SELECT data FROM pty_output WHERE session_id = ? ORDER BY seq ASC LIMIT 5000'
  ).all(sessionId) as { data: string }[];
  if (dbRows.length === 0) return null;

  // Find first resize marker for initial dimensions
  let initCols = cols;
  let initRows = rows;
  for (const row of dbRows) {
    if (row.data.startsWith(RESIZE_MARKER)) {
      const parts = row.data.slice(RESIZE_MARKER.length).split(',');
      initCols = parseInt(parts[0], 10) || cols;
      initRows = parseInt(parts[1], 10) || rows;
      break;
    }
  }

  const term = new HeadlessTerminal({
    cols: initCols, rows: initRows, scrollback: 10000, allowProposedApi: true,
  });
  const serializeAddon = new SerializeAddon();
  term.loadAddon(serializeAddon);

  // Process chunks in batches with async write callbacks (HeadlessTerminal
  // has an internal write queue that needs to drain for large data volumes).
  const MAX_BATCH = 512 * 1024;
  await new Promise<void>((resolve) => {
    let idx = 0;

    function processNext() {
      let batchData = '';
      while (idx < dbRows.length) {
        const row = dbRows[idx];
        if (row.data.startsWith(RESIZE_MARKER)) {
          if (batchData) { term.write(batchData); batchData = ''; }
          const parts = row.data.slice(RESIZE_MARKER.length).split(',');
          const newCols = parseInt(parts[0], 10);
          const newRows = parseInt(parts[1], 10);
          if (newCols > 0 && newRows > 0) term.resize(newCols, newRows);
          idx++;
          continue;
        }
        // Skip null-byte prefixed entries (other markers)
        if (row.data.charCodeAt(0) === 0) { idx++; continue; }
        batchData += row.data;
        idx++;
        if (batchData.length >= MAX_BATCH) {
          term.write(batchData, () => processNext());
          return;
        }
      }
      term.write(batchData, () => resolve());
    }

    processNext();
  });

  // Resize to the target dimensions before serializing
  if (term.cols !== cols || term.rows !== rows) {
    term.resize(cols, rows);
  }

  const result = serializeAddon.serialize();
  term.dispose();

  // Strip trailing blank lines (headless terminal captures all visible rows)
  const lines = result.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].replace(/\x1b\[[0-9;]*m/g, '').trim() === '') {
    lines.pop();
  }
  // Convert \n → \r\n for xterm.js (bare \n = LF-only → staircase)
  const cleaned = lines.join('\r\n');
  return cleaned || null;
}

/** Paginated output query: chunks before a given seq (or from the end if no before) */
export function querySessionOutput(
  sessionId: string,
  opts: { before?: number; limit: number }
): { chunks: { seq: number; data: string }[]; hasMore: boolean; oldestSeq: number | null } {
  const db = getDb();
  const limit = Math.min(opts.limit, 500000);

  let rows: { seq: number; data: string }[];
  if (opts.before != null) {
    rows = db.prepare(
      'SELECT seq, data FROM pty_output WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?'
    ).all(sessionId, opts.before, limit + 1) as { seq: number; data: string }[];
  } else {
    rows = db.prepare(
      'SELECT seq, data FROM pty_output WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
    ).all(sessionId, limit + 1) as { seq: number; data: string }[];
  }

  const hasMore = rows.length > limit;
  if (hasMore) rows = rows.slice(0, limit);

  // Reverse to chronological order
  rows.reverse();

  return {
    chunks: rows,
    hasMore,
    oldestSeq: rows.length > 0 ? rows[0].seq : null,
  };
}

/** Query output chunks after a given seq cursor (for incremental polling) */
export function querySessionOutputSince(
  sessionId: string,
  opts: { since?: number; limit: number }
): { chunks: { seq: number; data: string }[]; hasMore: boolean; latestSeq: number | null } {
  const db = getDb();
  const limit = Math.min(opts.limit, 500000);

  let rows: { seq: number; data: string }[];
  if (opts.since != null) {
    rows = db.prepare(
      'SELECT seq, data FROM pty_output WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
    ).all(sessionId, opts.since, limit + 1) as { seq: number; data: string }[];
  } else {
    // No cursor — return the last `limit` chunks (most recent)
    rows = db.prepare(
      'SELECT seq, data FROM pty_output WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
    ).all(sessionId, limit + 1) as { seq: number; data: string }[];
    const hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);
    rows.reverse();
    return {
      chunks: rows,
      hasMore,
      latestSeq: rows.length > 0 ? rows[rows.length - 1].seq : null,
    };
  }

  const hasMore = rows.length > limit;
  if (hasMore) rows = rows.slice(0, limit);

  return {
    chunks: rows,
    hasMore,
    latestSeq: rows.length > 0 ? rows[rows.length - 1].seq : null,
  };
}

/* ================================================================
   tmux helpers — only used for status checks in the main process.
   All blocking tmux operations (create, attach, pipe-pane) are in
   the worker process.
   ================================================================ */

const TMUX_SERVER = 'hivecommand';
const tmuxBaseArgs = ['-L', TMUX_SERVER];

function tmuxSessionName(sessionId: string): string {
  return `of-${sessionId}`;
}

/** Check if a tmux session is alive (async, non-blocking) */
async function tmuxExistsAsync(sessionId: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', [...tmuxBaseArgs, 'has-session', '-t', tmuxSessionName(sessionId)]);
    return true;
  } catch {
    return false;
  }
}

/** List all hivecommand tmux session IDs that are still alive */
function tmuxListHivecommandSessionIds(): string[] {
  try {
    const output = execFileSync('tmux', [...tmuxBaseArgs, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
    return output
      .trim()
      .split('\n')
      .filter(name => name.startsWith('of-'))
      .map(name => name.replace('of-', ''));
  } catch {
    return [];
  }
}

/* ================================================================
   dtach helpers — only used for status checks in the main process.
   ================================================================ */

function dtachSocket(sessionId: string): string {
  return `/tmp/hivecommand-${sessionId}.sock`;
}

function dtachExists(sessionId: string): boolean {
  const sock = dtachSocket(sessionId);
  if (!existsSync(sock)) return false;
  try {
    const stdout = execFileSync('fuser', [sock], { encoding: 'utf8' });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Check if a dtach socket is alive (async, non-blocking) */
async function dtachExistsAsync(sessionId: string): Promise<boolean> {
  const sock = dtachSocket(sessionId);
  if (!existsSync(sock)) return false;
  try {
    const { stdout } = await execFileAsync('fuser', [sock], { encoding: 'utf8' });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** List all hivecommand dtach sessions that are still alive */
function dtachListHivecommandSessions(): string[] {
  try {
    const files = readdirSync('/tmp')
      .filter(f => f.startsWith('hivecommand-') && f.endsWith('.sock'));
    const alive: string[] = [];
    for (const f of files) {
      const sessionId = f.replace('hivecommand-', '').replace('.sock', '');
      if (dtachExists(sessionId)) {
        alive.push(sessionId);
      }
    }
    return alive;
  } catch {
    return [];
  }
}

/* ================================================================
   Worker lifecycle — fork a child process per session
   ================================================================ */

/** Snapshot existing .jsonl UUIDs in a Claude project dir (for diffing after spawn) */
function snapshotClaudeSessionFiles(projectPath: string): Set<string> {
  const claudeProjectDir = join(homedir(), '.claude', 'projects', projectPath.replace(/\//g, '-'));
  try {
    return new Set(
      readdirSync(claudeProjectDir)
        .filter(f => f.endsWith('.jsonl') && !f.includes('-topic-'))
        .map(f => f.replace('.jsonl', ''))
    );
  } catch {
    return new Set();
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Fork a PTY worker and wire up IPC message handlers.
 * The worker runs in a separate process, isolating all blocking PTY/tmux
 * operations from the main Fastify event loop.
 */
function wireWorker(sessionId: string, worker: ChildProcess, projectPath?: string, preSpawnFiles?: Set<string>): ActiveSession {
  const tracker = getOrCreateTracker(sessionId);

  if (projectPath) {
    tracker.setProjectPath(projectPath, preSpawnFiles);
  }

  // Resume seq counter from DB to avoid collisions after reconnect
  let startSeq = 0;
  try {
    const row = getDb().prepare(
      'SELECT MAX(seq) as maxSeq FROM pty_output WHERE session_id = ?'
    ).get(sessionId) as { maxSeq: number | null } | undefined;
    if (row?.maxSeq) startSeq = row.maxSeq;
  } catch { /* fresh session */ }

  const active: ActiveSession = {
    worker,
    subscribers: new Set(),
    seq: startSeq,
    cols: 120,
    task: '',  // set by caller (spawnSession/spawnTerminal/reconnectSession)
    replayBuffer: [],
    replayBytes: 0,
    wsPendingData: null,
  };

  activeSessions.set(sessionId, active);

  // Track Claude session UUID — persist to DB once found
  let uuidPersisted = false;

  function persistUuid(uuid: string): void {
    if (uuidPersisted) return;
    uuidPersisted = true;
    try {
      const db = getDb();
      db.prepare('UPDATE sessions SET claude_session_id = ? WHERE id = ? AND claude_session_id IS NULL')
        .run(uuid, sessionId);
      console.log(`  Captured Claude session UUID ${uuid} for session ${sessionId}`);
    } catch { /* ignore */ }

    if (projectPath) {
      const sanitized = projectPath.replace(/\//g, '-');
      const jsonlPath = join(homedir(), '.claude', 'projects', sanitized, uuid + '.jsonl');
      tracker.setJsonlFile(jsonlPath);
      console.log(`  JSONL output file: ${jsonlPath}`);
    }
  }

  // Fallback: diff ~/.claude/projects/<path>/ against pre-spawn snapshot
  if (projectPath && preSpawnFiles) {
    const claudeProjectDir = join(homedir(), '.claude', 'projects', projectPath.replace(/\//g, '-'));
    let fileScanDone = false;
    const unsub = tracker.onStateChange(async (state) => {
      if (fileScanDone || uuidPersisted) { fileScanDone = true; return; }
      if (state.processState === 'waiting_for_input' || state.processState === 'idle') {
        fileScanDone = true;
        unsub();
        try {
          const { readdir, stat: statAsync } = await import('fs/promises');
          const allFiles = await readdir(claudeProjectDir);
          const currentFiles = allFiles
            .filter(f => f.endsWith('.jsonl') && !f.includes('-topic-'))
            .map(f => f.replace('.jsonl', ''));
          const newFiles = currentFiles.filter(f => !preSpawnFiles.has(f) && UUID_RE.test(f));
          if (newFiles.length === 1) {
            persistUuid(newFiles[0]);
          } else if (newFiles.length > 1) {
            const sorted = await Promise.all(newFiles.map(async f => {
              const st = await statAsync(join(claudeProjectDir, f + '.jsonl'));
              return { uuid: f, mtime: st.mtimeMs };
            }));
            sorted.sort((a, b) => b.mtime - a.mtime);
            persistUuid(sorted[0].uuid);
          }
        } catch { /* dir may not exist yet */ }
      }
    });
  }

  // Handle IPC messages from the worker
  worker.on('message', (msg: any) => {
    switch (msg.type) {
      case 'output': {
        // Display output — store in DB for replay on restart
        active.seq++;
        queuePtyInsert(sessionId, active.seq, msg.data);

        // Maintain replay buffer (last ~200KB) for instant replay without tmux capture-pane
        active.replayBuffer.push(msg.data);
        active.replayBytes += msg.data.length;
        while (active.replayBytes > 200_000 && active.replayBuffer.length > 1) {
          const removed = active.replayBuffer.shift()!;
          active.replayBytes -= removed.length;
        }

        // Batch WebSocket output to avoid flooding the browser event queue.
        // Individual pipe-pane chunks are tiny and arrive hundreds/sec — sending
        // each as a separate WS message starves browser keyboard input events.
        if (!active.wsPendingData) {
          active.wsPendingData = msg.data;
          setTimeout(() => {
            const data = active.wsPendingData!;
            active.wsPendingData = null;
            for (const ws of active.subscribers) {
              try {
                ws.send(JSON.stringify({ type: 'output', sessionId, data }));
              } catch {
                active.subscribers.delete(ws);
              }
            }
          }, 16); // ~60fps — one WS message per frame
        } else {
          active.wsPendingData += msg.data;
        }
        break;
      }

      case 'pty-data': {
        // Raw PTY output for state tracking (not necessarily display output)
        tracker.onData(msg.data);
        if (!uuidPersisted && tracker.claudeSessionId) {
          persistUuid(tracker.claudeSessionId);
        }
        break;
      }

      case 'ready': {
        // Worker has spawned the PTY
        const db = getDb();
        db.prepare(`
          UPDATE sessions SET status = 'running', pid = ?, started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now')
          WHERE id = ?
        `).run(msg.pid, sessionId);
        break;
      }

      case 'exit': {
        // PTY exited in the worker — flush pending writes, then delete pty_output
        if (pendingInserts.has(sessionId)) {
          flushPtyInserts();
        }
        // Session is done — delete replay data immediately
        try { getDb().prepare('DELETE FROM pty_output WHERE session_id = ?').run(sessionId); } catch { /* ignore */ }
        removeTracker(sessionId);
        activeSessions.delete(sessionId);

        const db = getDb();
        const status = msg.exitCode === 0 ? 'completed' : 'failed';
        db.prepare(`
          UPDATE sessions SET status = ?, exit_code = ?, completed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status NOT IN ('detached', 'cancelled', 'released')
        `).run(status, msg.exitCode, sessionId);

        insertEvent({
          session_id: sessionId,
          type: 'session_end',
          data: { exitCode: msg.exitCode, signal: msg.signal },
        });

        const taskSnippet = (() => {
          try { return (getDb().prepare('SELECT task FROM sessions WHERE id = ?').get(sessionId) as any)?.task?.slice(0, 60) ?? ''; } catch { return ''; }
        })();
        pushSystemEvent(`[HiveCommand] Session ${sessionId} ${status} (exit ${msg.exitCode}): ${taskSnippet}`);

        for (const ws of active.subscribers) {
          try {
            ws.send(JSON.stringify({ type: 'exit', sessionId, exitCode: msg.exitCode, signal: msg.signal }));
          } catch { /* ignore */ }
        }
        break;
      }

      case 'killed': {
        // Worker acknowledged kill
        break;
      }

      case 'error': {
        console.error(`[WORKER] Error for session ${sessionId}: ${msg.message}`);
        break;
      }

      case 'worker-ready': {
        // Worker process started, ready to receive spawn/reconnect messages
        break;
      }
    }
  });

  // Handle worker process exit (crash, disconnect)
  worker.on('exit', async (code, _signal) => {
    if (activeSessions.has(sessionId)) {
      // Worker died unexpectedly — clean up
      if (pendingInserts.has(sessionId)) {
        flushPtyInserts();
      }
      removeTracker(sessionId);
      activeSessions.delete(sessionId);

      // Check if the underlying tmux/dtach session is still alive (async to avoid blocking)
      const tmuxAlive = config.useTmux ? await tmuxExistsAsync(sessionId) : false;
      const dtachAlive = config.useDtach ? await dtachExistsAsync(sessionId) : false;

      const db = getDb();
      if (tmuxAlive || dtachAlive) {
        db.prepare(`
          UPDATE sessions SET status = 'detached', updated_at = datetime('now')
          WHERE id = ? AND status = 'running'
        `).run(sessionId);
      } else {
        db.prepare(`
          UPDATE sessions SET status = 'failed', exit_code = ?, completed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status NOT IN ('detached', 'cancelled', 'completed', 'released')
        `).run(code ?? -1, sessionId);
      }

      for (const ws of active.subscribers) {
        try {
          ws.send(JSON.stringify({ type: 'exit', sessionId, exitCode: code ?? -1 }));
        } catch { /* ignore */ }
      }
    }
  });

  worker.on('error', (err) => {
    console.error(`[WORKER] Process error for session ${sessionId}:`, err);
  });

  return active;
}

/**
 * Fork a new PTY worker process. Returns a promise that resolves once
 * the worker signals it's ready to receive messages.
 */
function forkWorker(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const script = getWorkerScript();

    // fork() inherits process.execPath and process.execArgv from the parent.
    // When running under tsx (dev mode), this ensures the child also uses tsx
    // to handle .ts files. In production (compiled .js), plain node works.
    const worker = fork(script, [], {
      stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
    });

    const timeout = setTimeout(() => {
      reject(new Error('Worker startup timed out'));
      worker.kill('SIGKILL');
    }, 10000);

    worker.once('message', (msg: any) => {
      if (msg.type === 'worker-ready') {
        clearTimeout(timeout);
        resolve(worker);
      }
    });

    worker.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    worker.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}`));
      }
    });
  });
}

/* ================================================================
   Session lifecycle
   ================================================================ */

export function createSession(_projectPath: string, task: string, projectId?: string): Session {
  const db = getDb();
  const id = nanoid(12);

  db.prepare(`
    INSERT INTO sessions (id, project_id, task, status)
    VALUES (?, ?, ?, 'pending')
  `).run(id, projectId || null, task);

  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session;
}

export async function spawnClaudeFlow(sessionId: string, projectPath: string, task: string, cols = 180, rows = 40): Promise<void> {
  const preSpawnFiles = snapshotClaudeSessionFiles(projectPath);

  const worker = await forkWorker();
  const active = wireWorker(sessionId, worker, projectPath, preSpawnFiles);
  active.cols = cols;
  active.task = task;

  // Tell the worker to spawn the session
  worker.send({
    type: 'spawn',
    sessionId,
    projectPath,
    task,
    mode: 'hivemind',
    cols,
    rows,
    useTmux: config.useTmux,
    useDtach: config.useDtach,
    rufloCommand: getSetting('ruflo_command'),
  });

  insertEvent({
    session_id: sessionId,
    type: 'session_start',
    data: { task, projectPath, tmux: config.useTmux, dtach: config.useDtach },
  });

  pushSystemEvent(`[HiveCommand] Session ${sessionId} started: ${task.slice(0, 60)}`);
}

export async function spawnTerminal(sessionId: string, projectPath: string, cols = 180, rows = 40): Promise<void> {
  const worker = await forkWorker();
  const active = wireWorker(sessionId, worker, projectPath);
  active.cols = cols;
  active.task = 'Terminal';

  worker.send({
    type: 'spawn',
    sessionId,
    projectPath,
    task: 'Terminal',
    mode: 'terminal',
    cols,
    rows,
    useTmux: config.useTmux,
    useDtach: config.useDtach,
  });

  insertEvent({
    session_id: sessionId,
    type: 'session_start',
    data: { task: 'Terminal', projectPath, tmux: config.useTmux, mode: 'terminal' },
  });
}

export async function spawnAgent(sessionId: string, projectPath: string, task: string, agentType: string, cols = 180, rows = 40): Promise<void> {
  const preSpawnFiles = snapshotClaudeSessionFiles(projectPath);

  const worker = await forkWorker();
  const active = wireWorker(sessionId, worker, projectPath, preSpawnFiles);
  active.cols = cols;
  active.task = `Agent (${agentType}): ${task}`;

  worker.send({
    type: 'spawn',
    sessionId,
    projectPath,
    task,
    mode: 'agent',
    agentType,
    cols,
    rows,
    useTmux: config.useTmux,
    useDtach: config.useDtach,
    rufloCommand: getSetting('ruflo_command'),
  });

  insertEvent({
    session_id: sessionId,
    type: 'session_start',
    data: { task, projectPath, tmux: config.useTmux, mode: 'agent', agentType },
  });

  pushSystemEvent(`[HiveCommand] Agent ${agentType} session ${sessionId} started: ${task.slice(0, 60)}`);
}

/**
 * Reconnect to a detached session (tmux or dtach) after a server restart.
 * Forks a new worker process that attaches to the surviving session.
 */
export async function reconnectSession(sessionId: string, opts?: { skipPipePaneReplay?: boolean }): Promise<boolean> {
  const t0 = Date.now();
  if (activeSessions.has(sessionId)) return false;

  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Session | undefined;
  if (!session || session.status !== 'detached') return false;

  // Quick check if underlying session is alive before forking a worker (async to avoid blocking)
  const tCheck = Date.now();
  const hasTmuxSession = config.useTmux ? await tmuxExistsAsync(sessionId) : false;
  const hasDtachSession = config.useDtach ? await dtachExistsAsync(sessionId) : false;
  tlog(`[RECONNECT] ${sessionId}: exists_check=${Date.now() - tCheck}ms (tmux=${hasTmuxSession}, dtach=${hasDtachSession})`);
  if (!hasTmuxSession && !hasDtachSession) return false;

  try {
    const t1 = Date.now();
    const worker = await forkWorker();
    const forkTime = Date.now() - t1;
    tlog(`[RECONNECT] ${sessionId}: fork=${forkTime}ms`);

    const t2 = Date.now();
    const active = wireWorker(sessionId, worker);
    tlog(`[RECONNECT] ${sessionId}: wireWorker=${Date.now() - t2}ms`);
    active.cols = session.terminal_cols || 120;
    active.task = session.task || '';

    // Restore externalSocket for adopted sessions (persisted in DB column)
    if ((session as any).external_socket) {
      active.externalSocket = (session as any).external_socket;
    }

    worker.send({
      type: 'reconnect',
      sessionId,
      cols: session.terminal_cols || 120,
      rows: 40,
      useTmux: config.useTmux,
      useDtach: config.useDtach,
    });

    // Bootstrap state detection from the last few output chunks
    const t3 = Date.now();
    const recoveryChunks = readRecentOutput(sessionId, 20);
    if (recoveryChunks.length > 0) {
      recoverFromBuffer(sessionId, recoveryChunks);
    }
    tlog(`[RECONNECT] ${sessionId}: recovery=${Date.now() - t3}ms (${recoveryChunks.length} chunks)`);

    // Seed replay buffer for instant replay on client connect.
    // Plain terminals: render stored pipe-pane output through a HeadlessTerminal
    // + SerializeAddon to produce a clean, dimension-aware snapshot.
    // Hivemind: fall back to tmux capture-pane (hivemind redraws on SIGWINCH).
    const seedStart = Date.now();
    let seeded = false;
    if (session.task === 'Terminal' && !opts?.skipPipePaneReplay) {
      try {
        const serialized = await serializeSessionOutput(
          sessionId,
          session.terminal_cols || 120,
          40,
        );
        if (serialized) {
          active.replayBuffer.push(serialized);
          active.replayBytes = serialized.length;
          seeded = true;
          tlog(`[RECONNECT] ${sessionId}: serialize-seed=${Date.now() - seedStart}ms (${serialized.length} bytes)`);
        }
      } catch (err) { tlog(`[RECONNECT] ${sessionId}: serialize-seed error: ${err}`); }
    }
    if (!seeded && config.useTmux && hasTmuxSession) {
      // Fallback: capture-pane (for hivemind or when DB has no data)
      try {
        const name = tmuxSessionName(sessionId);
        const { stdout: rawStdout } = await execFileAsync('tmux', [
          ...tmuxBaseArgs, 'capture-pane', '-t', name, '-p', '-e', '-T', '-S', '-',
        ], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
        const stdout = trimCaptureOutput(rawStdout);
        if (stdout) {
          // Convert \n to \r\n for xterm.js — bare \n causes staircase (LF without CR)
          const converted = stdout.replace(/\r?\n/g, '\r\n');
          active.replayBuffer.push(converted);
          active.replayBytes = converted.length;
          captureCache.set(sessionId, { data: converted, ts: Date.now() });
        }
        tlog(`[RECONNECT] ${sessionId}: capture-seed=${Date.now() - seedStart}ms (${stdout?.length || 0} bytes)`);
      } catch { /* tmux might not be ready yet */ }
    }

    db.prepare(`
      UPDATE sessions SET status = 'running', updated_at = datetime('now')
      WHERE id = ?
    `).run(sessionId);

    insertEvent({
      session_id: sessionId,
      type: 'session_reconnect',
      data: { tmux: hasTmuxSession },
    });

    tlog(`[RECONNECT] ${sessionId}: total=${Date.now() - t0}ms`);
    return true;
  } catch (err) {
    console.error(`[RECONNECT] Failed to reconnect session ${sessionId}:`, err);
    return false;
  }
}

/* ================================================================
   Terminal attachment
   ================================================================ */

export function attachTerminal(sessionId: string, ws: WebSocket, options?: { skipReplay?: boolean; skipSubscribe?: boolean }): boolean {
  tlog(`[ATTACH] ${sessionId}: start (active=${activeSessions.has(sessionId)})`);
  const active = activeSessions.get(sessionId);
  if (!active) return false;

  if (!options?.skipSubscribe) {
    active.subscribers.add(ws);
    ws.on('close', () => {
      active.subscribers.delete(ws);
    });
  }

  if (!options?.skipReplay) {
    sendReplay(sessionId, ws);
  }

  tlog(`[ATTACH] ${sessionId}: done`);
  return true;
}

// Resize marker prefix stored in pty_output — allows history replay to
// resize the headless terminal at the correct points in the data stream.
export const RESIZE_MARKER = '\x00RESIZE:';

/** Send a replay of the current terminal state to a single WebSocket subscriber.
 *  Uses the in-memory replay buffer for instant replay (raw pipe-pane output).
 *  Falls back to tmux capture-pane only if the buffer is empty (e.g. freshly
 *  reconnected session before pipe-pane data arrives). */
export function sendReplay(sessionId: string, ws: WebSocket): void {
  const active = activeSessions.get(sessionId);
  if (!active) return;

  if (active.replayBuffer.length > 0) {
    // Fast path: replay from in-memory buffer (instant, no tmux round-trip)
    const data = '\x1b[H\x1b[2J\x1b[3J' + active.replayBuffer.join('');
    tlog(`[REPLAY] ${sessionId}: from buffer (${active.replayBytes} bytes)`);
    try {
      ws.send(JSON.stringify({ type: 'output', sessionId, data }));
    } catch { /* ws closed */ }
    return;
  }

  // Fallback: tmux capture-pane (only needed right after reconnect before
  // pipe-pane data arrives — typically fast at that point)
  requestCapture(sessionId, ws).catch(() => {});
}

/** Strip trailing blank lines from capture-pane output.
 *  capture-pane captures all visible rows, including empty ones below the prompt.
 *  This prevents replay from showing a bunch of blank space with the cursor at the bottom. */
function trimCaptureOutput(output: string): string {
  // Split by newlines, strip trailing empty/whitespace-only lines (may contain ANSI resets)
  const lines = output.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].replace(/\x1b\[[0-9;]*m/g, '').trim() === '') {
    lines.pop();
  }
  return lines.join('\n');
}

/**
 * Request a fresh tmux capture-pane from the worker and send it to a WebSocket.
 * This runs the blocking capture in the worker process, not the main server.
 * Returns a promise that resolves when the capture is sent (or if no capture available).
 */
// Cache capture-pane results to avoid hammering tmux server (which is single-threaded
// and may be busy processing pipe-pane output, causing 2.5s delays).
const captureCache = new Map<string, { data: string; ts: number }>();
const CAPTURE_CACHE_TTL = 2000; // 2 seconds

export function requestCapture(sessionId: string, ws: WebSocket): Promise<void> {
  const t0 = Date.now();
  if (!config.useTmux) return Promise.resolve();

  // Serve from cache if fresh
  const cached = captureCache.get(sessionId);
  if (cached && (Date.now() - cached.ts) < CAPTURE_CACHE_TTL) {
    tlog(`[CAPTURE] ${sessionId}: from cache (${cached.data.length} bytes)`);
    try {
      ws.send(JSON.stringify({
        type: 'output',
        sessionId,
        data: '\x1b[H\x1b[2J\x1b[3J' + cached.data,
      }));
    } catch { /* ws may have closed */ }
    return Promise.resolve();
  }

  tlog(`[CAPTURE] ${sessionId}: requesting (spawn)`);
  const name = tmuxSessionName(sessionId);
  return new Promise((resolve) => {
    const chunks: string[] = [];
    const proc = spawn('tmux', [
      ...tmuxBaseArgs, 'capture-pane', '-t', name, '-p', '-e', '-T',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => chunks.push(chunk));

    proc.on('close', (code) => {
      const stdout = trimCaptureOutput(chunks.join(''));
      tlog(`[CAPTURE] ${sessionId}: done in ${Date.now() - t0}ms (${stdout.length} bytes, code=${code})`);
      if (code === 0 && stdout) {
        // Convert \n to \r\n for xterm.js — bare \n causes staircase (LF without CR)
        const converted = stdout.replace(/\r?\n/g, '\r\n');
        captureCache.set(sessionId, { data: converted, ts: Date.now() });
        try {
          ws.send(JSON.stringify({
            type: 'output',
            sessionId,
            data: '\x1b[H\x1b[2J\x1b[3J' + converted,
          }));
        } catch { /* ws may have closed */ }
      }
      resolve();
    });

    proc.on('error', () => resolve());
  });
}

export function writeToSession(sessionId: string, data: string): boolean {
  const active = activeSessions.get(sessionId);
  if (!active) return false;
  // Send input to the worker process via IPC
  active.worker.send({ type: 'input', data });
  return true;
}

export function resizeSession(sessionId: string, cols: number, rows: number): boolean {
  const active = activeSessions.get(sessionId);
  if (!active) return false;

  // Send resize to the worker process via IPC
  active.worker.send({ type: 'resize', cols, rows });

  active.cols = cols;

  // Store resize event in the PTY output stream
  active.seq++;
  queuePtyInsert(sessionId, active.seq, `${RESIZE_MARKER}${cols},${rows}`);

  // Persist last known cols
  try {
    const db = getDb();
    db.prepare('UPDATE sessions SET terminal_cols = ? WHERE id = ?').run(cols, sessionId);
  } catch {}
  return true;
}

export function getSessionCols(sessionId: string): number {
  const active = activeSessions.get(sessionId);
  if (active) return active.cols;
  try {
    const db = getDb();
    const row = db.prepare('SELECT terminal_cols FROM sessions WHERE id = ?').get(sessionId) as { terminal_cols: number | null } | undefined;
    return row?.terminal_cols || 250;
  } catch {
    return 250;
  }
}

/* ================================================================
   Kill / cleanup
   ================================================================ */

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Kill an orphaned ruflo daemon and its headless worker children.
 */
function killOrphanedDaemon(workingDir: string): void {
  const pidFile = join(workingDir, '.ruflo', 'daemon.pid');
  if (!existsSync(pidFile)) return;

  let daemonPid: number;
  try {
    daemonPid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (isNaN(daemonPid) || !pidAlive(daemonPid)) {
      try { unlinkSync(pidFile); } catch { /* ignore */ }
      return;
    }
  } catch {
    return;
  }

  try {
    const cmdline = readFileSync(`/proc/${daemonPid}/cmdline`, 'utf-8');
    if (!cmdline.includes('cli.js') || !cmdline.includes('daemon')) {
      return;
    }
  } catch {
    return;
  }

  console.log(`  Killing orphaned ruflo daemon PID ${daemonPid} in ${workingDir}`);

  try {
    const pgrepOut = execFileSync('pgrep', ['-P', String(daemonPid)], { encoding: 'utf8' });
    const childPids = pgrepOut.trim().split('\n').filter(Boolean).map(Number);
    for (const childPid of childPids) {
      try {
        const childCmdline = readFileSync(`/proc/${childPid}/comm`, 'utf-8').trim();
        if (childCmdline === 'claude') {
          process.kill(childPid, 'SIGKILL');
        }
      } catch { /* child already dead */ }
    }
  } catch { /* no children or pgrep failed */ }

  try { process.kill(daemonPid, 'SIGTERM'); } catch { /* already dead */ }
  setTimeout(() => {
    if (pidAlive(daemonPid)) {
      try { process.kill(daemonPid, 'SIGKILL'); } catch { /* dead */ }
    }
    try { unlinkSync(pidFile); } catch { /* ignore */ }
  }, 1000);
}

/**
 * Recursively collect all descendant PIDs of a given PID via /proc.
 */
function getDescendantPids(pid: number): number[] {
  const descendants: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    try {
      const stdout = execFileSync('pgrep', ['-P', String(parent)], { encoding: 'utf8' });
      const children = stdout.trim().split('\n').filter(Boolean).map(Number);
      for (const child of children) {
        descendants.push(child);
        queue.push(child);
      }
    } catch { /* no children */ }
  }
  return descendants.reverse();
}

function killPidTree(pid: number): void {
  const descendants = getDescendantPids(pid);
  const allPids = [...descendants, pid];
  for (const p of allPids) {
    try { process.kill(p, 'SIGTERM'); } catch { /* dead */ }
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { /* process group kill */ }
  setTimeout(() => {
    for (const p of allPids) {
      try { process.kill(p, 'SIGKILL'); } catch { /* dead */ }
    }
    try { process.kill(-pid, 'SIGKILL'); } catch { /* dead */ }
  }, 3000);
}

export async function killSession(sessionId: string): Promise<boolean> {
  const active = activeSessions.get(sessionId);
  console.log(`[KILL] Killing session ${sessionId} (active=${!!active})`);

  // 1. Notify all subscribers of termination
  for (const ws of active?.subscribers ?? []) {
    try {
      ws.send(JSON.stringify({ type: 'exit', exitCode: -1 }));
    } catch { /* ignore */ }
  }

  // 2. Delete pty_output immediately — no point keeping replay data for a killed session
  try {
    getDb().prepare('DELETE FROM pty_output WHERE session_id = ?').run(sessionId);
  } catch { /* ignore */ }

  // 3. Tell the worker to kill everything (non-blocking from our perspective)
  if (active) {
    try {
      active.worker.send({ type: 'kill' });
    } catch { /* worker may be dead */ }

    // Give the worker 2s to clean up, then force-kill it
    setTimeout(() => {
      if (active.worker.connected) {
        active.worker.kill('SIGKILL');
      }
    }, 2000);

    activeSessions.delete(sessionId);
    removeTracker(sessionId);
  }

  // 4. Kill adopted external session processes (fire and forget)
  if (active?.externalSocket) {
    const sock = active.externalSocket;
    adoptedSockets.delete(sock);
    execFileAsync('fuser', [sock]).then(({ stdout }) => {
      const pids = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
      for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* dead */ }
      }
      setTimeout(() => {
        for (const pid of pids) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* dead */ }
        }
      }, 2000);
    }).catch(() => { /* fuser failed */ });
  }

  // 5. Kill orphaned ruflo daemon for this session's project
  try {
    const sess = getDb().prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId) as { project_id: string | null } | undefined;
    if (sess?.project_id) {
      const proj = getDb().prepare('SELECT path FROM projects WHERE id = ?').get(sess.project_id) as { path: string } | undefined;
      if (proj?.path) {
        killOrphanedDaemon(proj.path);
      }
    }
  } catch { /* ignore */ }

  // 6. Fallback: kill by DB PID if no active session (e.g. server restarted)
  if (!active) {
    try {
      const session = getDb().prepare('SELECT pid FROM sessions WHERE id = ?').get(sessionId) as { pid: number | null } | undefined;
      if (session?.pid && pidAlive(session.pid)) {
        console.log(`  Killing orphaned PID ${session.pid} for session ${sessionId}`);
        killPidTree(session.pid);
      }
    } catch { /* ignore */ }
  }

  // 7. Update DB immediately
  const db = getDb();
  const result = db.prepare(`
    UPDATE sessions SET status = 'cancelled', completed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND status IN ('running', 'pending', 'detached')
  `).run(sessionId);

  console.log(`[KILL] Session ${sessionId} killed (db_updated=${result.changes > 0})`);
  return !!active || result.changes > 0;
}

/**
 * Release an HiveCommand session back to its dtach socket without killing the process.
 * Used by pop-out: tears down the HiveCommand worker/tmux wrapper but leaves the
 * dtach master alive so a real terminal (or re-adopt) can connect to it.
 */
export function releaseSession(sessionId: string): boolean {
  const active = activeSessions.get(sessionId);
  if (!active) return false;

  console.log(`[RELEASE] Releasing session ${sessionId} to external terminal`);

  // Notify subscribers so the frontend closes the tab
  for (const ws of active.subscribers) {
    try {
      ws.send(JSON.stringify({ type: 'exit', sessionId, exitCode: 0, reason: 'popped-out' }));
    } catch { /* ignore */ }
  }

  // Release the worker (detach from the tmux/dtach session without killing it)
  // so the external terminal can attach to the still-running session.
  try {
    if (active.worker.connected) {
      active.worker.send({ type: 'release' });
    }
  } catch { /* worker may be dead */ }
  setTimeout(() => {
    try { active.worker.kill('SIGKILL'); } catch { /* dead */ }
  }, 2000);

  // Remove from adopted tracking so it becomes discoverable again
  const extSocket = active.externalSocket || getSessionSocketPath(sessionId);
  if (extSocket) {
    adoptedSockets.delete(extSocket);
  }

  activeSessions.delete(sessionId);
  removeTracker(sessionId);

  // Mark as released (still running externally, available for re-adoption)
  const db = getDb();
  db.prepare(`
    UPDATE sessions SET status = 'released', updated_at = datetime('now')
    WHERE id = ? AND status IN ('running', 'pending', 'detached')
  `).run(sessionId);

  return true;
}

export function getSession(id: string): Session | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session) || null;
}

export function listSessions(status?: string): Session[] {
  const db = getDb();
  if (status) {
    return db.prepare('SELECT * FROM sessions WHERE status = ? ORDER BY created_at DESC').all(status) as Session[];
  }
  return db.prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 50').all() as Session[];
}

export function isSessionActive(sessionId: string): boolean {
  return activeSessions.has(sessionId);
}

export function getActiveSession(sessionId: string): ActiveSession | undefined {
  return activeSessions.get(sessionId);
}

/**
 * Get the dtach socket path for a session.
 * For adopted sessions, returns the external socket path.
 * For regular sessions, returns the hivecommand dtach socket path.
 */
export function getSessionSocketPath(sessionId: string): string | null {
  const active = activeSessions.get(sessionId);
  if (active?.externalSocket) return active.externalSocket;
  const sock = dtachSocket(sessionId);
  if (existsSync(sock)) return sock;
  // Fallback: check the session's persisted external_socket column
  try {
    const row = getDb().prepare('SELECT external_socket FROM sessions WHERE id = ?').get(sessionId) as { external_socket: string | null } | undefined;
    if (row?.external_socket && existsSync(row.external_socket)) {
      return row.external_socket;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Get the tmux session name for a session (if it has an active tmux session).
 */
export function getSessionTmuxName(sessionId: string): string | null {
  const active = activeSessions.get(sessionId);
  if (!active) return null;
  const name = tmuxSessionName(sessionId);
  try {
    execFileSync('tmux', [...tmuxBaseArgs, 'has-session', '-t', name], { stdio: 'ignore' });
    return name;
  } catch {
    return null;
  }
}

/**
 * Gracefully shut down on server restart.
 * Preserves tmux sessions so they can be reconnected on next startup.
 * Only kills worker processes (they get re-forked by autoReconnectDetachedSessions).
 */
export function killAllSessions(): void {
  const db = getDb();
  for (const [id, active] of activeSessions) {
    // Kill the worker process only — leave tmux/dtach alive for reconnect.
    // Do NOT send { type: 'kill' } — that tells the worker to kill tmux too.
    try {
      active.worker.kill('SIGKILL');
    } catch { /* ignore */ }

    // Mark as detached so autoReconnectDetachedSessions picks them up on next startup
    try {
      db.prepare(`
        UPDATE sessions SET status = 'detached', updated_at = datetime('now')
        WHERE id = ? AND status IN ('running', 'pending')
      `).run(id);
    } catch { /* DB might already be closed */ }

    activeSessions.delete(id);
  }
}

// killOrphanedClaudeProcesses was removed — it killed ANY claude process not on
// an hivecommand tmux PTY, which incorrectly killed: (1) adopted external sessions
// whose claude runs on the real terminal's PTY, and (2) user-launched claude
// sessions in their own terminals. Per-session cleanup in cleanupStaleRunningSessions
// handles dead hivecommand sessions individually via killOrphanedDaemon/killOrphanedProcess.

/**
 * On server startup, handle sessions from previous run.
 */
export async function cleanupStaleRunningSessions(): Promise<void> {
  const t0 = Date.now();
  tlog(`[CLEANUP] start`);
  const db = getDb();

  if (config.useDtach || config.useTmux) {
    const stale = db.prepare(`
      SELECT s.id, s.pid, p.path as project_path FROM sessions s
      LEFT JOIN projects p ON s.project_id = p.id
      WHERE s.status IN ('running', 'pending', 'detached')
      OR (s.status = 'failed' AND (s.completed_at IS NULL OR s.completed_at > datetime('now', '-1 hour')))
    `).all() as { id: string; pid: number; project_path: string | null }[];

    if (stale.length === 0) { tlog(`[CLEANUP] no stale sessions, done in ${Date.now() - t0}ms`); return; }

    const t1 = Date.now();
    const aliveDtach = config.useDtach ? new Set(dtachListHivecommandSessions()) : new Set<string>();
    const aliveTmux = config.useTmux ? new Set(tmuxListHivecommandSessionIds()) : new Set<string>();
    tlog(`[CLEANUP] session listing: ${Date.now() - t1}ms (${stale.length} stale, ${aliveTmux.size} tmux, ${aliveDtach.size} dtach)`);
    let detached = 0;
    let cleaned = 0;

    for (const { id, project_path } of stale) {
      const inTmux = aliveTmux.has(id);
      const inDtach = aliveDtach.has(id);
      tlog(`[CLEANUP] session ${id}: tmux=${inTmux}, dtach=${inDtach}`);
      if (inTmux || inDtach) {
        db.prepare(`
          UPDATE sessions SET status = 'detached', updated_at = datetime('now')
          WHERE id = ?
        `).run(id);
        detached++;
      } else {
        if (project_path) {
          try { killOrphanedDaemon(project_path); } catch { /* ignore */ }
        }
        db.prepare(`
          UPDATE sessions SET status = 'failed', exit_code = -1, completed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `).run(id);
        cleaned++;
      }
    }

    tlog(`[CLEANUP] done in ${Date.now() - t0}ms (${detached} detached, ${cleaned} cleaned)`);
    if (detached > 0) console.log(`  Found ${detached} detached session(s) available for reconnect`);
    if (cleaned > 0) console.log(`  Cleaned up ${cleaned} dead session(s) from previous run`);
  } else {
    const stale = db.prepare(`
      SELECT id, pid, claude_session_id, project_id, task FROM sessions WHERE status IN ('running', 'pending') AND pid IS NOT NULL
    `).all() as { id: string; pid: number; claude_session_id: string | null; project_id: string | null; task: string }[];

    for (const { id, pid } of stale) {
      killOrphanedProcess(pid, id);
    }

    const resumable = stale.filter(s => s.claude_session_id && s.project_id);
    const nonResumable = stale.length - resumable.length;

    if (nonResumable > 0) {
      const updated = db.prepare(`
        UPDATE sessions SET status = 'failed', exit_code = -1, completed_at = datetime('now'), updated_at = datetime('now')
        WHERE status IN ('running', 'pending') AND (claude_session_id IS NULL OR project_id IS NULL)
      `).run();
      if (updated.changes > 0) {
        console.log(`  Cleaned up ${updated.changes} stale session(s) from previous crash`);
      }
    }

    for (const session of resumable) {
      const project = db.prepare('SELECT path FROM projects WHERE id = ?').get(session.project_id!) as { path: string } | undefined;
      if (!project) {
        db.prepare(`
          UPDATE sessions SET status = 'failed', exit_code = -1, completed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `).run(session.id);
        continue;
      }
      try {
        await resumeCrashedSession(session as Session, project.path);
      } catch (err) {
        console.error(`  Failed to resume session ${session.id}:`, err);
        db.prepare(`
          UPDATE sessions SET status = 'failed', exit_code = -1, completed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?
        `).run(session.id);
      }
    }
  }

  // NOTE: We no longer run killOrphanedClaudeProcesses() here.
  // That function killed ANY claude process not on an hivecommand tmux PTY,
  // which is wrong — users run claude in their own terminals, and adopted
  // sessions have claude on external PTYs. Per-session cleanup above
  // already handles dead hivecommand sessions individually.

  // Restore adoptedSockets from DB so adopted sessions aren't shown as
  // discoverable again after restart.
  try {
    const adopted = db.prepare(`
      SELECT external_socket FROM sessions
      WHERE external_socket IS NOT NULL
      AND status IN ('running', 'pending', 'detached')
    `).all() as { external_socket: string }[];
    for (const row of adopted) {
      if (existsSync(row.external_socket)) {
        adoptedSockets.add(row.external_socket);
      }
    }
    if (adoptedSockets.size > 0) {
      console.log(`  Restored ${adoptedSockets.size} adopted socket(s) from previous run`);
    }
  } catch { /* ignore */ }

  // Purge pty_output for dead sessions — keeps DB lean on startup.
  // Detached sessions are preserved (they need replay data for reconnect).
  try {
    const purged = db.prepare(`
      DELETE FROM pty_output WHERE session_id IN (
        SELECT id FROM sessions WHERE status IN ('completed', 'cancelled', 'failed')
      )
    `).run();
    if (purged.changes > 0) {
      console.log(`  Purged ${purged.changes} pty_output row(s) from dead sessions`);
    }
  } catch { /* ignore */ }

  // Reclaim disk space after purging — VACUUM rewrites the DB file without dead pages.
  try {
    const before = (db.pragma('page_count') as { page_count: number }[])[0].page_count;
    const freePages = (db.pragma('freelist_count') as { freelist_count: number }[])[0].freelist_count;
    if (freePages > 100) {
      db.exec('VACUUM');
      const after = (db.pragma('page_count') as { page_count: number }[])[0].page_count;
      const pageSize = (db.pragma('page_size') as { page_size: number }[])[0].page_size;
      const savedMB = ((before - after) * pageSize / 1048576).toFixed(1);
      console.log(`  VACUUM reclaimed ${savedMB}MB (${before - after} pages)`);
    }
  } catch (err) {
    console.error('  VACUUM failed:', err);
  }
}

/**
 * Auto-reconnect all detached sessions (tmux or dtach) after server startup.
 * Now non-blocking: forks a worker per session in parallel.
 */
export async function autoReconnectDetachedSessions(): Promise<void> {
  const t0 = Date.now();
  tlog(`[AUTO-RECONNECT] start`);
  if (!config.useDtach && !config.useTmux) { tlog(`[AUTO-RECONNECT] skipped (no tmux/dtach)`); return; }

  const db = getDb();
  const detached = db.prepare(`
    SELECT id FROM sessions WHERE status = 'detached'
  `).all() as { id: string }[];

  if (detached.length === 0) { tlog(`[AUTO-RECONNECT] no detached sessions`); return; }
  tlog(`[AUTO-RECONNECT] reconnecting ${detached.length} sessions`);

  _reconnecting = true;
  _reconnectTotal = detached.length;
  _reconnectDone = 0;

  // Reconnect all detached sessions in parallel — each gets its own worker
  const results = await Promise.allSettled(
    detached.map(({ id }) => reconnectSession(id).finally(() => { _reconnectDone++; }))
  );

  _reconnecting = false;
  const reconnected = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  tlog(`[AUTO-RECONNECT] done in ${Date.now() - t0}ms (${reconnected}/${detached.length} reconnected)`);
  if (reconnected > 0) {
    console.log(`  Auto-reconnected ${reconnected} detached session(s)`);
  }
}

/**
 * Resume a crashed session by spawning a fresh ruflo process
 * and sending `/resume <uuid>` once it's ready for input.
 */
async function resumeCrashedSession(staleSession: Session, projectPath: string): Promise<void> {
  const db = getDb();
  const sessionId = staleSession.id;
  const claudeUuid = staleSession.claude_session_id!;
  const task = staleSession.task;

  console.log(`  Resuming crashed session ${sessionId} (Claude session ${claudeUuid})`);

  const preSpawnFiles = snapshotClaudeSessionFiles(projectPath);
  const worker = await forkWorker();
  const active = wireWorker(sessionId, worker, projectPath, preSpawnFiles);

  const tracker = getOrCreateTracker(sessionId);

  // Update DB: mark as running again
  db.prepare(`
    UPDATE sessions SET status = 'running', claude_session_id = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(sessionId);

  // Tell worker to spawn a hivemind session
  worker.send({
    type: 'spawn',
    sessionId,
    projectPath,
    task,
    mode: 'hivemind',
    cols: 120,
    rows: 40,
    useTmux: config.useTmux,
    useDtach: config.useDtach,
    rufloCommand: getSetting('ruflo_command'),
  });

  // One-shot listener: send /resume when the process is ready for input
  let resumeSent = false;
  const unsubscribe = tracker.onStateChange((state) => {
    if (!resumeSent && state.processState === 'waiting_for_input') {
      resumeSent = true;
      active.worker.send({ type: 'input', data: `/resume ${claudeUuid}\n` });
      console.log(`  Sent /resume ${claudeUuid} to session ${sessionId}`);
      unsubscribe();
    }
  });

  insertEvent({
    session_id: sessionId,
    type: 'session_resume',
    data: { task, projectPath, claudeSessionId: claudeUuid },
  });

  pushSystemEvent(`[HiveCommand] Session ${sessionId} resumed after crash: ${task.slice(0, 60)}`);
}

/* ================================================================
   External hivemind session discovery + adoption
   ================================================================ */

const adoptedSockets = new Set<string>();

// Track whether auto-reconnect is in progress (exposed via health endpoint)
let _reconnecting = false;
let _reconnectTotal = 0;
let _reconnectDone = 0;
export function getReconnectStatus() {
  return { reconnecting: _reconnecting, total: _reconnectTotal, done: _reconnectDone };
}

export interface DiscoverableSession {
  socketPath: string;
  projectPath: string;
  task: string;
  startedAt: string;
}

async function fuserPidsAsync(sockPath: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('fuser', [sockPath], { encoding: 'utf8' });
    return stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function isHiveCommandOwnedAsync(pid: number): Promise<boolean> {
  try {
    const environ = await readFileAsync(`/proc/${pid}/environ`, 'utf8');
    return environ.includes('HIVECOMMAND_SESSION=') || environ.includes('OPENFLOW_SESSION=');
  } catch {
    return false;
  }
}

export async function discoverExternalSessions(projectPath?: string): Promise<DiscoverableSession[]> {
  const results: DiscoverableSession[] = [];
  try {
    const files = readdirSync('/tmp')
      .filter(f => f.startsWith('hivemind-') && f.endsWith('.sock'));

    for (const f of files) {
      const sockPath = `/tmp/${f}`;
      const baseName = f.replace('.sock', '');
      const infoPath = `/tmp/${baseName}.info`;
      const promptPath = `/tmp/${baseName}.prompt`;

      if (adoptedSockets.has(sockPath)) continue;
      if (!existsSync(sockPath)) continue;
      const hivePids = await fuserPidsAsync(sockPath);
      if (hivePids.length === 0) continue;

      const ownerChecks = await Promise.all(hivePids.map(p => isHiveCommandOwnedAsync(p)));
      if (ownerChecks.some(owned => owned)) continue;

      let sessionProjectPath = '';
      let startedAt = '';
      let task = '';
      try {
        const infoLines = readFileSync(infoPath, 'utf8').trim().split('\n');
        sessionProjectPath = infoLines[0] || '';
        startedAt = infoLines[1] || '';
      } catch { continue; }

      try {
        task = readFileSync(promptPath, 'utf8').trim();
      } catch {
        task = '(unknown task)';
      }

      if (projectPath && sessionProjectPath !== projectPath) continue;

      results.push({
        socketPath: sockPath,
        projectPath: sessionProjectPath,
        task,
        startedAt,
      });
    }
  } catch { /* /tmp read failed */ }

  // Also discover released HiveCommand tmux sessions (popped-out sessions)
  try {
    const db = getDb();
    const releasedSessions = db.prepare(`
      SELECT s.id, s.task, s.created_at, s.project_id, COALESCE(p.path, '') as project_path
      FROM sessions s
      LEFT JOIN projects p ON s.project_id = p.id
      WHERE s.status = 'released'
    `).all() as Array<{ id: string; task: string; created_at: string; project_id: string; project_path: string }>;

    for (const s of releasedSessions) {
      // Skip if already tracked in activeSessions
      if (activeSessions.has(s.id)) continue;

      // Verify the tmux session is still alive
      const tmuxName = tmuxSessionName(s.id);
      try {
        await execFileAsync('tmux', [...tmuxBaseArgs, 'has-session', '-t', tmuxName]);
      } catch {
        // tmux session is gone — mark as failed
        db.prepare(`UPDATE sessions SET status = 'failed', updated_at = datetime('now') WHERE id = ?`).run(s.id);
        continue;
      }

      if (projectPath && s.project_path !== projectPath) continue;

      results.push({
        socketPath: `tmux:${tmuxName}`,
        projectPath: s.project_path,
        task: s.task,
        startedAt: s.created_at,
      });
    }
  } catch { /* db read failed */ }

  return results;
}

export async function adoptDtachSession(socketPath: string, projectId?: string): Promise<Session | null> {
  // Handle re-adoption of released HiveCommand tmux sessions
  if (socketPath.startsWith('tmux:')) {
    return readoptReleasedSession(socketPath.replace('tmux:', ''), projectId);
  }

  if (adoptedSockets.has(socketPath)) return null;
  if (!existsSync(socketPath)) return null;

  const socketPids = await fuserPidsAsync(socketPath);
  if (socketPids.length === 0) return null;

  const ownerChecks = await Promise.all(socketPids.map(p => isHiveCommandOwnedAsync(p)));
  if (ownerChecks.some(owned => owned)) return null;

  const baseName = socketPath.replace('.sock', '');
  const infoPath = `${baseName}.info`;
  const promptPath = `${baseName}.prompt`;

  let projectPath = '';
  let task = '';
  try {
    const infoLines = readFileSync(infoPath, 'utf8').trim().split('\n');
    projectPath = infoLines[0] || '';
  } catch {
    return null;
  }
  try {
    task = readFileSync(promptPath, 'utf8').trim();
  } catch {
    task = 'Adopted external session';
  }

  const session = createSession(projectPath, task, projectId || undefined);
  const db = getDb();

  // Lazy adopt: register as pending spawn so the tmux wrapper is created
  // at the browser's actual dimensions (not hardcoded 120×40).
  // This prevents resizing the external dtach process to wrong dimensions.
  adoptedSockets.add(socketPath);
  // Persist the external socket path on the session row so it survives restarts
  db.prepare('UPDATE sessions SET external_socket = ? WHERE id = ?').run(socketPath, session.id);

  registerPendingSpawn(session.id, {
    projectPath,
    task,
    mode: 'adopt',
    projectId: projectId || undefined,
    socketPath,
  });

  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(session.id) as Session;
}

/**
 * Re-adopt a released HiveCommand tmux session (popped-out and now being brought back).
 * Changes status from 'released' to 'detached' and reconnects via the existing reconnect path.
 */
async function readoptReleasedSession(tmuxName: string, _projectId?: string): Promise<Session | null> {
  // Extract session ID from tmux name (of-<id>)
  const sessionId = tmuxName.replace(/^of-/, '');
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Session | undefined;
  if (!session || session.status !== 'released') return null;

  // Verify tmux session is still alive
  try {
    await execFileAsync('tmux', [...tmuxBaseArgs, 'has-session', '-t', tmuxName]);
  } catch {
    db.prepare(`UPDATE sessions SET status = 'failed', updated_at = datetime('now') WHERE id = ?`).run(sessionId);
    return null;
  }

  // Detach all external clients (e.g. tilix) from the tmux session
  // so they don't fight with HiveCommand's worker for input/output
  try {
    const { stdout } = await execFileAsync('tmux', [...tmuxBaseArgs, 'list-clients', '-t', tmuxName, '-F', '#{client_tty}'], { encoding: 'utf8' });
    const ttys = stdout.trim().split('\n').filter(Boolean);
    for (const tty of ttys) {
      try {
        await execFileAsync('tmux', [...tmuxBaseArgs, 'detach-client', '-t', tty]);
      } catch { /* client may have already disconnected */ }
    }
  } catch { /* no clients attached */ }

  // Resize tmux window back to the dashboard width before reconnecting.
  // The external terminal may have resized tmux to a different width, but our
  // terminal_cols in the DB still reflects the last dashboard width (the worker
  // was dead during the external session, so resizeSession was never called).
  // This ensures capture-pane grabs content at the correct dashboard width.
  const dashboardCols = session.terminal_cols || 120;
  try {
    await execFileAsync('tmux', [...tmuxBaseArgs, 'resize-window', '-t', tmuxName, '-x', String(dashboardCols)]);
    // Unset window-size=manual that resize-window implicitly sets.
    // Without this, future clients (e.g. Tilix on next pop-out) can't resize the window.
    await execFileAsync('tmux', [...tmuxBaseArgs, 'set-option', '-t', tmuxName, '-u', 'window-size']);
  } catch { /* ignore */ }

  // Mark as detached so reconnectSession() can pick it up
  db.prepare(`UPDATE sessions SET status = 'detached', updated_at = datetime('now') WHERE id = ?`).run(sessionId);

  // Skip pipe-pane replay: the stored data is stale (from before pop-out).
  // Commands run in the external terminal aren't captured by pipe-pane (worker was dead).
  // Use capture-pane instead to get the current tmux screen state.
  const ok = await reconnectSession(sessionId, { skipPipePaneReplay: true });
  if (!ok) return null;

  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Session;
}

/**
 * Actually spawn the adopt worker — called when the browser sends its real dimensions.
 */
export async function spawnAdopt(sessionId: string, socketPath: string, projectPath: string, task: string, cols: number, rows: number): Promise<void> {
  // Detach all existing dtach -a clients for this socket BEFORE we attach.
  // This disconnects the user's real terminal so it doesn't fight with HiveCommand.
  // We use pkill to SIGHUP dtach clients matching the socket path.
  // SIGHUP on a dtach client causes a clean detach (the master stays alive).
  try {
    // Find dtach -a processes for this specific socket path
    const { stdout: psOut } = await execFileAsync('ps', ['aux'], { encoding: 'utf8' });
    for (const line of psOut.split('\n')) {
      if (!line.includes('dtach') || !line.includes('-a') || !line.includes(socketPath)) continue;
      // Don't match grep/ps itself
      if (line.includes('ps aux')) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const pid = parseInt(parts[1], 10);
      if (pid > 0) {
        console.log(`[ADOPT] Detaching existing dtach client PID ${pid} for ${socketPath}`);
        try { process.kill(pid, 'SIGHUP'); } catch { /* already dead */ }
      }
    }
  } catch (err) {
    console.warn('[ADOPT] Failed to detach existing clients:', err);
  }

  const worker = await forkWorker();
  const active = wireWorker(sessionId, worker, projectPath);
  active.task = task;
  active.externalSocket = socketPath;
  active.cols = cols;

  worker.send({
    type: 'adopt',
    sessionId,
    socketPath,
    projectPath,
    cols,
    rows,
    useTmux: config.useTmux,
  });

  insertEvent({
    session_id: sessionId,
    type: 'session_adopt',
    data: { task, projectPath, externalSocket: socketPath, tmux: config.useTmux },
  });

  pushSystemEvent(`[HiveCommand] Adopted external session ${sessionId}: ${task.slice(0, 60)}`);
}

function killOrphanedProcess(pid: number, sessionId: string): void {
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }

  console.log(`  Killing orphaned process PID ${pid} (session ${sessionId})`);
  killPidTree(pid);
}
