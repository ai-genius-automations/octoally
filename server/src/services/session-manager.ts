import { fork, execFile, execFileSync, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import { readFile, readdirSync, readFileSync, writeFileSync as fsWriteFileSync, existsSync, appendFileSync, statSync, readlinkSync, openSync, readSync, closeSync } from 'fs';
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

const TIMING_LOG = '/tmp/octoally-timing.log';
function tlog(s: string): void {
  try { appendFileSync(TIMING_LOG, `[${new Date().toISOString()}] ${s}\n`); } catch {}
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ================================================================
   Restart storm detection & session spawn guard
   ================================================================ */

const RESTART_LOG = '/tmp/octoally-restart-timestamps.json';
/** Max server starts within RESTART_WINDOW_MS before we skip auto-resume */
const RESTART_STORM_THRESHOLD = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
/** Max concurrent active sessions (workers). Generous to allow power users. */
const MAX_ACTIVE_SESSIONS = 30;
/** Max sessions to auto-reconnect concurrently (prevents thundering herd) */
const RECONNECT_BATCH_SIZE = 5;
/** Max times a single session can be auto-resumed before giving up */
const MAX_SESSION_RESUMES = 3;

function recordServerStart(): void {
  let timestamps: number[] = [];
  try {
    timestamps = JSON.parse(readFileSync(RESTART_LOG, 'utf-8'));
  } catch { /* first run or corrupt */ }
  const now = Date.now();
  timestamps.push(now);
  // Keep only timestamps within the window
  timestamps = timestamps.filter(ts => now - ts < RESTART_WINDOW_MS);
  try { fsWriteFileSync(RESTART_LOG, JSON.stringify(timestamps)); } catch {}
}

function isRestartStorm(): boolean {
  let timestamps: number[] = [];
  try {
    timestamps = JSON.parse(readFileSync(RESTART_LOG, 'utf-8'));
  } catch { return false; }
  const now = Date.now();
  const recent = timestamps.filter(ts => now - ts < RESTART_WINDOW_MS);
  return recent.length >= RESTART_STORM_THRESHOLD;
}

/**
 * Check if spawning another session would exceed the active session cap.
 * Returns true if the spawn should be blocked.
 */
export function isAtSessionLimit(): boolean {
  return activeSessions.size >= MAX_ACTIVE_SESSIONS;
}

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
  task: string; // 'Terminal' for plain shells, task description for session
  cliType?: 'claude' | 'codex'; // CLI type — Codex needs special capture handling
  externalSocket?: string; // external dtach socket (adopted sessions)
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
  mode: 'session' | 'terminal' | 'adopt' | 'agent';
  agentType?: string;
  projectId?: string;
  socketPath?: string;  // for adopt mode
  cliType?: 'claude' | 'codex';
  resumeSessionId?: string;  // for --resume <id> when resuming external sessions
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
    pendingInserts.clear();
  } catch (err) {
    console.error('Failed to flush pty_output inserts:', err);
    // Don't clear pendingInserts — retry on next flush cycle
  }

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

const TMUX_SERVER = 'octoally';
const LEGACY_TMUX_SERVERS = ['hivecommand', 'openflow'];
const tmuxBaseArgs = ['-L', TMUX_SERVER];

function tmuxSessionName(sessionId: string): string {
  return `of-${sessionId}`;
}

/** Get tmux args for the server that actually hosts a session (checks legacy servers) */
function tmuxArgsForSession(sessionId: string): string[] {
  const name = tmuxSessionName(sessionId);
  for (const server of [TMUX_SERVER, ...LEGACY_TMUX_SERVERS]) {
    try {
      execFileSync('tmux', ['-L', server, 'has-session', '-t', name], { stdio: 'ignore' });
      return ['-L', server];
    } catch { /* try next */ }
  }
  return tmuxBaseArgs;
}

/** Check if a tmux session is alive on any server (octoally, hivecommand, openflow) */
async function tmuxExistsAsync(sessionId: string): Promise<boolean> {
  const name = tmuxSessionName(sessionId);
  for (const server of [TMUX_SERVER, ...LEGACY_TMUX_SERVERS]) {
    try {
      await execFileAsync('tmux', ['-L', server, 'has-session', '-t', name]);
      return true;
    } catch { /* try next */ }
  }
  return false;
}

/** List all OctoAlly tmux session IDs that are still alive (checks legacy servers too) */
function tmuxListOctoallySessionIds(): string[] {
  const ids = new Set<string>();
  for (const server of [TMUX_SERVER, ...LEGACY_TMUX_SERVERS]) {
    try {
      const output = execFileSync('tmux', ['-L', server, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
      output
        .trim()
        .split('\n')
        .filter(name => name.startsWith('of-'))
        .map(name => name.replace('of-', ''))
        .forEach(id => ids.add(id));
    } catch { /* server not running */ }
  }
  return [...ids];
}

/* ================================================================
   dtach helpers — only used for status checks in the main process.
   ================================================================ */

const DTACH_PREFIXES = ['octoally-', 'hivecommand-', 'openflow-'];

/** Find the dtach socket for a session, checking all name prefixes */
function dtachSocket(sessionId: string): string {
  // Check legacy prefixes first (existing sessions), then new prefix
  for (const prefix of DTACH_PREFIXES) {
    const sock = `/tmp/${prefix}${sessionId}.sock`;
    if (existsSync(sock)) return sock;
  }
  // Default to new prefix for new sessions
  return `/tmp/octoally-${sessionId}.sock`;
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

/** List all OctoAlly dtach sessions that are still alive (checks legacy prefixes too) */
function dtachListOctoallySessions(): string[] {
  const ids = new Set<string>();
  try {
    const files = readdirSync('/tmp');
    for (const prefix of DTACH_PREFIXES) {
      files
        .filter(f => f.startsWith(prefix) && f.endsWith('.sock'))
        .forEach(f => {
          const sessionId = f.replace(prefix, '').replace('.sock', '');
          if (dtachExists(sessionId)) {
            ids.add(sessionId);
          }
        });
    }
  } catch { /* /tmp read failed */ }
  return [...ids];
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
        pushSystemEvent(`[OctoAlly] Session ${sessionId} ${status} (exit ${msg.exitCode}): ${taskSnippet}`);

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

export function createSession(_projectPath: string, task: string, projectId?: string, cliType?: 'claude' | 'codex'): Session {
  const db = getDb();
  const id = nanoid(12);

  db.prepare(`
    INSERT INTO sessions (id, project_id, task, status, cli_type)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(id, projectId || null, task, cliType || 'claude');

  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session;
}

export async function spawnSession(sessionId: string, projectPath: string, task: string, cols = 180, rows = 40, cliType: 'claude' | 'codex' = 'claude', resumeSessionId?: string): Promise<void> {
  const preSpawnFiles = snapshotClaudeSessionFiles(projectPath);

  const worker = await forkWorker();
  const active = wireWorker(sessionId, worker, projectPath, preSpawnFiles);
  active.cols = cols;
  active.task = task;
  active.cliType = cliType;

  let sessionCommand = cliType === 'codex'
    ? getSetting('session_codex_command')
    : getSetting('session_claude_command');

  // Check per-project skip_permissions flag
  const proj = getDb().prepare('SELECT skip_permissions FROM projects WHERE path = ?').get(projectPath) as { skip_permissions: number } | undefined;
  if (proj?.skip_permissions && cliType === 'claude' && !sessionCommand.includes('--dangerously-skip-permissions')) {
    sessionCommand += ' --dangerously-skip-permissions';
  }

  // Resume an existing claude session by ID (e.g. adopted from external process)
  if (resumeSessionId && cliType === 'claude') {
    sessionCommand += ` --resume ${resumeSessionId}`;
  }

  // Tell the worker to spawn the session
  worker.send({
    type: 'spawn',
    sessionId,
    projectPath,
    task,
    mode: 'session',
    cols,
    rows,
    useTmux: config.useTmux,
    useDtach: config.useDtach,
    sessionCommand,
    cliType,
  });

  insertEvent({
    session_id: sessionId,
    type: 'session_start',
    data: { task, projectPath, tmux: config.useTmux, dtach: config.useDtach },
  });

  pushSystemEvent(`[OctoAlly] Session ${sessionId} started: ${task.slice(0, 60)}`);
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

export async function spawnAgent(sessionId: string, projectPath: string, task: string, agentType: string, cols = 180, rows = 40, cliType: 'claude' | 'codex' = 'claude'): Promise<void> {
  const preSpawnFiles = snapshotClaudeSessionFiles(projectPath);

  const worker = await forkWorker();
  const active = wireWorker(sessionId, worker, projectPath, preSpawnFiles);
  active.cols = cols;
  active.task = `Agent (${agentType}): ${task}`;
  active.cliType = cliType;

  let sessionCommand = cliType === 'codex'
    ? getSetting('agent_codex_command')
    : getSetting('agent_claude_command');

  // Check per-project skip_permissions flag
  const proj = getDb().prepare('SELECT skip_permissions FROM projects WHERE path = ?').get(projectPath) as { skip_permissions: number } | undefined;
  if (proj?.skip_permissions && cliType === 'claude' && !sessionCommand.includes('--dangerously-skip-permissions')) {
    sessionCommand += ' --dangerously-skip-permissions';
  }

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
    sessionCommand,
    cliType,
  });

  insertEvent({
    session_id: sessionId,
    type: 'session_start',
    data: { task, projectPath, tmux: config.useTmux, mode: 'agent', agentType },
  });

  pushSystemEvent(`[OctoAlly] Agent ${agentType} session ${sessionId} started: ${task.slice(0, 60)}`);
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
    active.cliType = ((session as any).cli_type === 'codex' ? 'codex' : 'claude') as 'claude' | 'codex';

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
    // Session: fall back to tmux capture-pane (sessions redraw on SIGWINCH).
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
      // Fallback: capture-pane (for sessions or when DB has no data)
      try {
        const name = tmuxSessionName(sessionId);
        const { stdout: rawStdout } = await execFileAsync('tmux', [
          ...tmuxArgsForSession(sessionId), 'capture-pane', '-t', name, '-p', '-e', '-T', '-S', '-',
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
 *  reconnected session before pipe-pane data arrives).
 *
 *  When `preferCapture` is true, always use tmux capture-pane instead of the raw
 *  replay buffer. This produces a correct rendering at the current terminal width,
 *  which is important for TUIs like Codex that use cursor positioning — raw replay
 *  of chunks recorded at a different width produces garbled output. */
export function sendReplay(sessionId: string, ws: WebSocket, preferCapture = false): void {
  const active = activeSessions.get(sessionId);
  if (!active) return;

  // When tmux is available and capture is preferred (e.g. after resize),
  // use capture-pane for a pixel-perfect rendering at the current dimensions.
  if (preferCapture && config.useTmux) {
    // Invalidate stale capture cache so we get a fresh capture at new dimensions
    captureCache.delete(sessionId);
    tlog(`[REPLAY] ${sessionId}: preferCapture — using tmux capture-pane`);
    requestCapture(sessionId, ws).catch(() => {
      // Capture failed — fall back to buffer replay
      if (active.replayBuffer.length > 0) {
        const data = '\x1b[H\x1b[2J\x1b[3J' + active.replayBuffer.join('');
        try { ws.send(JSON.stringify({ type: 'output', sessionId, data })); } catch {}
      }
    });
    return;
  }

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
    // Always use -S - to capture full scrollback history. Duplicate output
    // from Codex redraws is prevented on the client side by skipping the
    // force-resize trick for Codex sessions (Terminal.tsx).
    const captureArgs = [
      ...tmuxArgsForSession(sessionId), 'capture-pane', '-t', name, '-p', '-e', '-T', '-S', '-',
    ];
    const proc = spawn('tmux', captureArgs, { stdio: ['ignore', 'pipe', 'ignore'] });

    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => chunks.push(chunk));

    proc.on('close', (code) => {
      const stdout = trimCaptureOutput(chunks.join(''));
      tlog(`[CAPTURE] ${sessionId}: done in ${Date.now() - t0}ms (${stdout.length} bytes, code=${code})`);
      if (code === 0 && stdout) {
        // Convert \n to \r\n for xterm.js — bare \n causes staircase (LF without CR)
        const converted = stdout.replace(/\r?\n/g, '\r\n');
        captureCache.set(sessionId, { data: converted, ts: Date.now() });

        // Replace the replay buffer with this clean capture — prevents stale
        // raw chunks (recorded at different widths) from being replayed on
        // future reconnects and causing duplicated/garbled content.
        const active = activeSessions.get(sessionId);
        if (active) {
          active.replayBuffer.length = 0;
          active.replayBuffer.push(converted);
          active.replayBytes = converted.length;
        }

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

export function writeToSession(sessionId: string, data: string, bracketedPaste?: boolean): boolean {
  const active = activeSessions.get(sessionId);
  if (!active) return false;
  // Send input to the worker process via IPC
  active.worker.send({ type: 'input', data, bracketedPaste });
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

  // 2. Run SONA session-end hook before killing (consolidates learning data)
  try {
    const sess = getDb().prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId) as { project_id: string | null } | undefined;
    if (sess?.project_id) {
      const proj = getDb().prepare('SELECT path FROM projects WHERE id = ?').get(sess.project_id) as { path: string } | undefined;
      const hookHandler = proj?.path ? join(proj.path, '.claude', 'helpers', 'hook-handler.cjs') : null;
      if (hookHandler && existsSync(hookHandler)) {
        await execFileAsync('node', [hookHandler, 'session-end'], {
          cwd: proj!.path, timeout: 5000,
        }).catch(() => { /* non-fatal — don't block kill */ });
      }
    }
  } catch { /* ignore */ }

  // 3. Delete pty_output immediately — no point keeping replay data for a killed session
  try {
    getDb().prepare('DELETE FROM pty_output WHERE session_id = ?').run(sessionId);
  } catch { /* ignore */ }

  // 4. Tell the worker to kill everything (non-blocking from our perspective)
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

  // 5. Kill adopted external session processes (fire and forget)
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

  // 8. Update DB immediately
  const db = getDb();
  const result = db.prepare(`
    UPDATE sessions SET status = 'cancelled', completed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND status IN ('running', 'pending', 'detached')
  `).run(sessionId);

  console.log(`[KILL] Session ${sessionId} killed (db_updated=${result.changes > 0})`);
  return !!active || result.changes > 0;
}

/**
 * Release an OctoAlly session back to its dtach socket without killing the process.
 * Used by pop-out: tears down the OctoAlly worker/tmux wrapper but leaves the
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
  // Return ALL active sessions (never drop them) plus the 50 most recent inactive ones
  return db.prepare(`
    SELECT * FROM sessions WHERE status IN ('running', 'pending', 'launching')
    UNION ALL
    SELECT * FROM (
      SELECT * FROM sessions WHERE status NOT IN ('running', 'pending', 'launching')
      ORDER BY created_at DESC LIMIT 50
    )
    ORDER BY created_at DESC
  `).all() as Session[];
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
 * For regular sessions, returns the OctoAlly dtach socket path.
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
  for (const server of [TMUX_SERVER, ...LEGACY_TMUX_SERVERS]) {
    try {
      execFileSync('tmux', ['-L', server, 'has-session', '-t', name], { stdio: 'ignore' });
      return name;
    } catch { /* try next */ }
  }
  return null;
}

/** Get the tmux server name that hosts a session */
export function getSessionTmuxServer(sessionId: string): string {
  const name = tmuxSessionName(sessionId);
  for (const server of [TMUX_SERVER, ...LEGACY_TMUX_SERVERS]) {
    try {
      execFileSync('tmux', ['-L', server, 'has-session', '-t', name], { stdio: 'ignore' });
      return server;
    } catch { /* try next */ }
  }
  return TMUX_SERVER;
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
// an OctoAlly tmux PTY, which incorrectly killed: (1) adopted external sessions
// whose claude runs on the real terminal's PTY, and (2) user-launched claude
// sessions in their own terminals. Per-session cleanup in cleanupStaleRunningSessions
// handles dead OctoAlly sessions individually via killOrphanedProcess.

/**
 * On server startup, handle sessions from previous run.
 */
export async function cleanupStaleRunningSessions(): Promise<void> {
  const t0 = Date.now();
  tlog(`[CLEANUP] start`);
  recordServerStart();
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
    const aliveDtach = config.useDtach ? new Set(dtachListOctoallySessions()) : new Set<string>();
    const aliveTmux = config.useTmux ? new Set(tmuxListOctoallySessionIds()) : new Set<string>();
    tlog(`[CLEANUP] session listing: ${Date.now() - t1}ms (${stale.length} stale, ${aliveTmux.size} tmux, ${aliveDtach.size} dtach)`);
    let detached = 0;
    let cleaned = 0;

    for (const { id, project_path: _project_path } of stale) {
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

    // Circuit breaker: skip auto-resume if server is restart-looping
    if (isRestartStorm()) {
      console.warn(`  [CIRCUIT BREAKER] Server restarted ${RESTART_STORM_THRESHOLD}+ times in ${RESTART_WINDOW_MS / 60000}min — skipping auto-resume of ${resumable.length} session(s) to prevent runaway spawning`);
      const markFailed = db.prepare(`
        UPDATE sessions SET status = 'failed', exit_code = -1, completed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `);
      for (const s of resumable) markFailed.run(s.id);
    } else {
      for (const session of resumable) {
        // Session cap: don't resume if we'd exceed the limit
        if (isAtSessionLimit()) {
          console.warn(`  [SESSION CAP] Already ${activeSessions.size} active sessions (max ${MAX_ACTIVE_SESSIONS}) — skipping resume of remaining sessions`);
          const markFailed = db.prepare(`
            UPDATE sessions SET status = 'failed', exit_code = -1, completed_at = datetime('now'), updated_at = datetime('now')
            WHERE id = ?
          `);
          for (const s of resumable.slice(resumable.indexOf(session))) markFailed.run(s.id);
          break;
        }

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
  }

  // NOTE: We no longer run killOrphanedClaudeProcesses() here.
  // That function killed ANY claude process not on an OctoAlly tmux PTY,
  // which is wrong — users run claude in their own terminals, and adopted
  // sessions have claude on external PTYs. Per-session cleanup above
  // already handles dead OctoAlly sessions individually.

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

/* ================================================================
   Stale pending session watchdog
   ================================================================ */

/** Max time (ms) a session can stay in "pending" before being auto-failed */
const PENDING_SESSION_TIMEOUT_MS = 90_000; // 90 seconds
let _pendingWatchdogTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start a periodic watchdog that auto-fails sessions stuck in "pending" status.
 * Sessions stay pending until the WebSocket connects and triggers the spawn.
 * If that never happens (e.g. browser tab closed, network issue, or spawn hang),
 * the session stays pending forever — blocking the user from knowing it failed.
 */
export function startPendingSessionWatchdog(): void {
  if (_pendingWatchdogTimer) return;
  _pendingWatchdogTimer = setInterval(() => {
    try {
      const db = getDb();
      const stale = db.prepare(`
        SELECT id FROM sessions
        WHERE status = 'pending'
        AND created_at < datetime('now', '-' || ? || ' seconds')
      `).all(Math.floor(PENDING_SESSION_TIMEOUT_MS / 1000)) as { id: string }[];

      for (const { id } of stale) {
        // Clean up any pending spawn record
        pendingSpawns.delete(id);
        db.prepare(`
          UPDATE sessions SET status = 'failed', exit_code = -1,
            completed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status = 'pending'
        `).run(id);
        console.log(`[WATCHDOG] Auto-failed stale pending session ${id}`);
      }
    } catch { /* non-fatal */ }
  }, 30_000); // check every 30s
}

/**
 * Auto-reconnect all detached sessions (tmux or dtach) after server startup.
 * Now non-blocking: forks a worker per session in parallel.
 */
export async function autoReconnectDetachedSessions(): Promise<void> {
  const t0 = Date.now();
  tlog(`[AUTO-RECONNECT] start`);
  if (!config.useDtach && !config.useTmux) { tlog(`[AUTO-RECONNECT] skipped (no tmux/dtach)`); return; }

  // Circuit breaker: skip if restart-looping
  if (isRestartStorm()) {
    console.warn(`  [CIRCUIT BREAKER] Restart storm detected — skipping auto-reconnect to prevent runaway spawning`);
    tlog(`[AUTO-RECONNECT] skipped (restart storm)`);
    return;
  }

  const db = getDb();
  const detached = db.prepare(`
    SELECT id FROM sessions WHERE status = 'detached'
  `).all() as { id: string }[];

  if (detached.length === 0) { tlog(`[AUTO-RECONNECT] no detached sessions`); return; }
  tlog(`[AUTO-RECONNECT] reconnecting ${detached.length} sessions (batch size: ${RECONNECT_BATCH_SIZE})`);

  _reconnecting = true;
  _reconnectTotal = detached.length;
  _reconnectDone = 0;

  // Reconnect in batches to prevent thundering herd of worker spawns
  let reconnected = 0;
  for (let i = 0; i < detached.length; i += RECONNECT_BATCH_SIZE) {
    // Check session cap before each batch
    if (isAtSessionLimit()) {
      console.warn(`  [SESSION CAP] Hit ${MAX_ACTIVE_SESSIONS} active sessions — stopping auto-reconnect (${_reconnectDone}/${detached.length} done)`);
      break;
    }

    const batch = detached.slice(i, i + RECONNECT_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(({ id }) => reconnectSession(id).finally(() => { _reconnectDone++; }))
    );
    reconnected += results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  }

  _reconnecting = false;
  tlog(`[AUTO-RECONNECT] done in ${Date.now() - t0}ms (${reconnected}/${detached.length} reconnected)`);
  if (reconnected > 0) {
    console.log(`  Auto-reconnected ${reconnected} detached session(s)`);
  }
}

/**
 * Resume a crashed session by spawning a fresh CLI process
 * and sending `/resume <uuid>` once it's ready for input.
 */
async function resumeCrashedSession(staleSession: Session, projectPath: string): Promise<void> {
  const db = getDb();
  const sessionId = staleSession.id;
  const claudeUuid = staleSession.claude_session_id!;
  const task = staleSession.task;

  // Per-session circuit breaker: don't resume sessions that keep crashing
  const resumeCount = (db.prepare(`
    SELECT COUNT(*) as cnt FROM events WHERE session_id = ? AND type = 'session_resume'
  `).get(sessionId) as { cnt: number })?.cnt || 0;
  if (resumeCount >= MAX_SESSION_RESUMES) {
    console.warn(`  [SESSION CIRCUIT BREAKER] Session ${sessionId} already resumed ${resumeCount} times — marking as failed to prevent crash loop`);
    db.prepare(`
      UPDATE sessions SET status = 'failed', exit_code = -1, completed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?
    `).run(sessionId);
    return;
  }

  console.log(`  Resuming crashed session ${sessionId} (Claude session ${claudeUuid}, attempt ${resumeCount + 1}/${MAX_SESSION_RESUMES})`);

  const preSpawnFiles = snapshotClaudeSessionFiles(projectPath);
  const worker = await forkWorker();
  const active = wireWorker(sessionId, worker, projectPath, preSpawnFiles);

  const tracker = getOrCreateTracker(sessionId);

  // Update DB: mark as running again
  db.prepare(`
    UPDATE sessions SET status = 'running', claude_session_id = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(sessionId);

  // Tell worker to spawn a session
  const sessionCliType = (staleSession as any).cli_type === 'codex' ? 'codex' as const : 'claude' as const;
  active.cliType = sessionCliType;
  const sessionCommand = sessionCliType === 'codex'
    ? getSetting('session_codex_command')
    : getSetting('session_claude_command');
  worker.send({
    type: 'spawn',
    sessionId,
    projectPath,
    task,
    mode: 'session',
    cols: 120,
    rows: 40,
    useTmux: config.useTmux,
    useDtach: config.useDtach,
    sessionCommand,
    cliType: sessionCliType,
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

  pushSystemEvent(`[OctoAlly] Session ${sessionId} resumed after crash: ${task.slice(0, 60)}`);
}

/* ================================================================
   External session discovery + adoption
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
  cliType?: 'claude' | 'codex';
}

async function fuserPidsAsync(sockPath: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('fuser', [sockPath], { encoding: 'utf8' });
    return stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function isOctoAllyOwnedAsync(pid: number): Promise<boolean> {
  try {
    const environ = await readFileAsync(`/proc/${pid}/environ`, 'utf8');
    return environ.includes('OCTOALLY_SESSION=') || environ.includes('HIVECOMMAND_SESSION=') || environ.includes('OPENFLOW_SESSION=');
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

      const ownerChecks = await Promise.all(hivePids.map(p => isOctoAllyOwnedAsync(p)));
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

  // Also discover released OctoAlly tmux sessions (popped-out sessions)
  // Collect socket paths already found by dtach scan to avoid duplicates
  const foundSockets = new Set(results.map(r => r.socketPath));
  try {
    const db = getDb();
    const releasedSessions = db.prepare(`
      SELECT s.id, s.task, s.created_at, s.project_id, s.external_socket, s.cli_type, COALESCE(p.path, '') as project_path
      FROM sessions s
      LEFT JOIN projects p ON s.project_id = p.id
      WHERE s.status = 'released'
    `).all() as Array<{ id: string; task: string; created_at: string; project_id: string; external_socket: string | null; cli_type: string | null; project_path: string }>;

    for (const s of releasedSessions) {
      // Skip if already tracked in activeSessions
      if (activeSessions.has(s.id)) continue;

      // Skip if this session's external dtach socket was already found by the dtach scan
      if (s.external_socket && foundSockets.has(s.external_socket)) continue;

      // Verify the tmux session is still alive (check all servers)
      const tmuxName = tmuxSessionName(s.id);
      const tmuxAlive = await tmuxExistsAsync(s.id);
      if (!tmuxAlive) {
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
        cliType: (s.cli_type === 'codex' ? 'codex' : 'claude') as 'claude' | 'codex',
      });
    }
  } catch { /* db read failed */ }

  return results;
}

export interface ScannedSession {
  pid: number;
  projectPath: string;
  sessionId: string;
  task: string;
  startedAt: string;
}

// Scan /proc for ALL running claude processes not owned by OctoAlly,
// then look up their session info from ~/.claude/projects/ JSONL files.
export async function scanAllClaudeSessions(): Promise<ScannedSession[]> {
  const results: ScannedSession[] = [];
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');

  let procEntries: string[];
  try {
    procEntries = readdirSync('/proc').filter(d => /^\d+$/.test(d));
  } catch {
    return results;
  }

  for (const pidStr of procEntries) {
    const pid = parseInt(pidStr, 10);
    try {
      // Check cmdline arg[0] is 'claude'
      const cmdlineRaw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      const arg0 = cmdlineRaw.split('\0')[0] || '';
      if (arg0 !== 'claude' && !arg0.endsWith('/claude')) continue;

      // Skip OctoAlly-owned sessions
      const environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
      if (
        environ.includes('OCTOALLY_SESSION=') ||
        environ.includes('HIVECOMMAND_SESSION=') ||
        environ.includes('OPENFLOW_SESSION=')
      ) continue;

      // Get working directory
      const cwd = readlinkSync(`/proc/${pid}/cwd`);

      // Find the corresponding ~/.claude/projects/ directory
      const encodedPath = cwd.replace(/\//g, '-');
      const projectDir = join(claudeProjectsDir, encodedPath);
      if (!existsSync(projectDir)) continue;

      // Find the most recently modified JSONL — that's the active session
      const jsonlFiles = readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          try {
            return { name: f, mtime: statSync(join(projectDir, f)).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => b!.mtime - a!.mtime) as { name: string; mtime: number }[];

      if (jsonlFiles.length === 0) continue;

      const sessionId = jsonlFiles[0].name.replace('.jsonl', '');

      // Skip sessions already tracked inside OctoAlly
      if (activeSessions.has(sessionId)) continue;

      // Read just the first 8 KB to find the task (first user message)
      let task = '(unknown task)';
      let startedAt = '';
      try {
        const jsonlPath = join(projectDir, jsonlFiles[0].name);
        const fd = openSync(jsonlPath, 'r');
        const buf = Buffer.alloc(8192);
        const bytesRead = readSync(fd, buf, 0, 8192, 0);
        closeSync(fd);
        const sample = buf.slice(0, bytesRead).toString('utf8');
        const lines = sample.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (!startedAt && obj.timestamp) startedAt = obj.timestamp;
            if (obj.type === 'user' && obj.message?.role === 'user') {
              const content = obj.message.content;
              if (typeof content === 'string' && content.trim().length > 5) {
                task = content.trim().slice(0, 120);
                break;
              } else if (Array.isArray(content)) {
                for (const c of content) {
                  if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim().length > 5) {
                    task = c.text.trim().slice(0, 120);
                    break;
                  }
                }
                if (task !== '(unknown task)') break;
              }
            }
          } catch { /* skip malformed line */ }
        }
      } catch { /* couldn't read JSONL */ }

      results.push({ pid, projectPath: cwd, sessionId, task, startedAt });
    } catch { /* process gone or unreadable */ }
  }

  return results;
}

// Kill an external claude process and resume its conversation inside OctoAlly.
// Returns the new OctoAlly session so the caller can register it as a tab.
export async function resumeExternalSession(
  pid: number,
  externalSessionId: string,
  projectPath: string,
  task: string,
  projectId?: string,
): Promise<Session> {
  // Gracefully stop the external process so it flushes its state before we resume
  try {
    process.kill(pid, 'SIGTERM');
    // Give claude up to 1.5 s to write its shutdown checkpoint
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
  } catch { /* already dead */ }

  const session = createSession(projectPath, task, projectId);
  registerPendingSpawn(session.id, {
    projectPath,
    task,
    mode: 'session',
    projectId,
    cliType: 'claude',
    resumeSessionId: externalSessionId,
  });

  pushSystemEvent(`[OctoAlly] Resuming external session ${externalSessionId}: ${task.slice(0, 60)}`);
  return session;
}

export async function adoptDtachSession(socketPath: string, projectId?: string): Promise<Session | null> {
  // Handle re-adoption of released OctoAlly tmux sessions
  if (socketPath.startsWith('tmux:')) {
    return readoptReleasedSession(socketPath.replace('tmux:', ''), projectId);
  }

  if (adoptedSockets.has(socketPath)) return null;
  if (!existsSync(socketPath)) return null;

  const socketPids = await fuserPidsAsync(socketPath);
  if (socketPids.length === 0) return null;

  const ownerChecks = await Promise.all(socketPids.map(p => isOctoAllyOwnedAsync(p)));
  if (ownerChecks.some(owned => owned)) return null;

  // Check if there's a released session that previously used this socket
  // (popped-out session being re-adopted). Reuse it instead of creating a duplicate.
  const db0 = getDb();
  const releasedRow = db0.prepare(
    `SELECT id FROM sessions WHERE external_socket = ? AND status = 'released' LIMIT 1`
  ).get(socketPath) as { id: string } | undefined;
  if (releasedRow) {
    const tmuxName = tmuxSessionName(releasedRow.id);
    return readoptReleasedSession(tmuxName, projectId);
  }

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
 * Re-adopt a released OctoAlly tmux session (popped-out and now being brought back).
 * Changes status from 'released' to 'detached' and reconnects via the existing reconnect path.
 */
async function readoptReleasedSession(tmuxName: string, _projectId?: string): Promise<Session | null> {
  // Extract session ID from tmux name (of-<id>)
  const sessionId = tmuxName.replace(/^of-/, '');
  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Session | undefined;
  if (!session || session.status !== 'released') return null;

  // Verify tmux session is still alive (check all servers)
  const serverArgs = tmuxArgsForSession(sessionId);
  if (!(await tmuxExistsAsync(sessionId))) {
    db.prepare(`UPDATE sessions SET status = 'failed', updated_at = datetime('now') WHERE id = ?`).run(sessionId);
    return null;
  }

  // Detach all external clients (e.g. tilix) from the tmux session
  // so they don't fight with OctoAlly's worker for input/output
  try {
    const { stdout } = await execFileAsync('tmux', [...serverArgs, 'list-clients', '-t', tmuxName, '-F', '#{client_tty}'], { encoding: 'utf8' });
    const ttys = stdout.trim().split('\n').filter(Boolean);
    for (const tty of ttys) {
      try {
        await execFileAsync('tmux', [...serverArgs, 'detach-client', '-t', tty]);
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
    await execFileAsync('tmux', [...serverArgs, 'resize-window', '-t', tmuxName, '-x', String(dashboardCols)]);
    // Unset window-size=manual that resize-window implicitly sets.
    // Without this, future clients (e.g. Tilix on next pop-out) can't resize the window.
    await execFileAsync('tmux', [...serverArgs, 'set-option', '-t', tmuxName, '-u', 'window-size']);
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
  // This disconnects the user's real terminal so it doesn't fight with OctoAlly.
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

  pushSystemEvent(`[OctoAlly] Adopted external session ${sessionId}: ${task.slice(0, 60)}`);
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
