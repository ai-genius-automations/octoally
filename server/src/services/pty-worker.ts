/**
 * PTY Worker — runs as a separate child process per session.
 *
 * Handles all blocking PTY/tmux/pipe-pane operations so they don't
 * starve the main Fastify server's event loop.
 *
 * IPC Protocol:
 *   Parent → Worker: spawn, reconnect, input, resize, kill, replay
 *   Worker → Parent: ready, output, exit, error, replay-chunk, replay-end
 */

import * as pty from 'node-pty-prebuilt-multiarch';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { existsSync, unlinkSync, mkdirSync, createReadStream, readFileSync, readdirSync, statSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import type { ReadStream } from 'fs';

const execFileAsync = promisify(execFile);

const TIMING_LOG = '/tmp/octoally-timing.log';
function tlog(s: string): void {
  try { appendFileSync(TIMING_LOG, `[${new Date().toISOString()}] ${s}\n`); } catch {}
}

/* ================================================================
   Types
   ================================================================ */

interface SpawnMessage {
  type: 'spawn';
  sessionId: string;
  projectPath: string;
  task: string;
  mode: 'hivemind' | 'terminal' | 'agent';
  agentType?: string;
  rufloCommand?: string;
  cliType?: 'claude' | 'codex';
  cols: number;
  rows: number;
  useTmux: boolean;
  useDtach: boolean;
  workingDir?: string;
}

interface ReconnectMessage {
  type: 'reconnect';
  sessionId: string;
  cols: number;
  rows: number;
  useTmux: boolean;
  useDtach: boolean;
}

interface AdoptMessage {
  type: 'adopt';
  sessionId: string;
  socketPath: string;
  projectPath: string;
  cols: number;
  rows: number;
  useTmux: boolean;
}

type ParentMessage =
  | SpawnMessage
  | ReconnectMessage
  | AdoptMessage
  | { type: 'input'; data: string; bracketedPaste?: boolean }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'capture' }
  | { type: 'kill' }
  | { type: 'release' };

/* ================================================================
   tmux helpers (same as session-manager but local to worker)
   ================================================================ */

const TMUX_SERVER = 'octoally';
const LEGACY_TMUX_SERVERS = ['hivecommand', 'openflow'];
const tmuxBaseArgs = ['-L', TMUX_SERVER];

function tmuxSessionName(sessionId: string): string {
  return `of-${sessionId}`;
}

/** Find which tmux server hosts a session (checks legacy servers too) */
function findTmuxServer(sessionId: string): string | null {
  const name = tmuxSessionName(sessionId);
  for (const server of [TMUX_SERVER, ...LEGACY_TMUX_SERVERS]) {
    try {
      execFileSync('tmux', ['-L', server, 'has-session', '-t', name], { stdio: 'ignore' });
      return server;
    } catch { /* try next */ }
  }
  return null;
}

function tmuxExists(sessionId: string): boolean {
  return findTmuxServer(sessionId) !== null;
}

async function tmuxCreate(
  sessionId: string,
  projectPath: string,
  cols: number,
  rows: number,
  command?: string,
): Promise<void> {
  const name = tmuxSessionName(sessionId);
  if (tmuxExists(sessionId)) {
    try { execFileSync('tmux', [...tmuxBaseArgs, 'kill-session', '-t', name], { stdio: 'ignore' }); } catch { /* ignore */ }
  }

  const shell = process.env.SHELL || '/bin/bash';
  const runArgs = command ? [shell, '-i', '-c', command] : [shell];

  await execFileAsync('tmux', [
    ...tmuxBaseArgs, 'new-session', '-d', '-s', name,
    '-x', String(cols), '-y', String(rows),
    ...runArgs,
  ], {
    cwd: projectPath,
    env: { ...process.env, TERM: 'xterm-256color', OCTOALLY_SESSION: '1', HIVECOMMAND_SESSION: '1', HEADLESS_WORKERS_DISABLED: '1' } as Record<string, string>,
  });

  try {
    await execFileAsync('tmux', [...tmuxBaseArgs, 'set-option', '-s', 'terminal-overrides', 'xterm-256color:smcup@:rmcup@']);
    await execFileAsync('tmux', [...tmuxBaseArgs, 'set-option', '-t', name, 'status', 'off']);
    await execFileAsync('tmux', [...tmuxBaseArgs, 'set-option', '-t', name, 'history-limit', '50000']);
  } catch { /* best effort */ }
}

async function tmuxKill(sessionId: string): Promise<void> {
  const name = tmuxSessionName(sessionId);
  // Kill on whichever server hosts it (may be legacy)
  for (const server of [TMUX_SERVER, ...LEGACY_TMUX_SERVERS]) {
    try {
      await execFileAsync('tmux', ['-L', server, 'kill-session', '-t', name]);
      return;
    } catch { /* try next */ }
  }
}

/* ================================================================
   dtach helpers
   ================================================================ */

function dtachSocket(sessionId: string): string {
  // Check legacy prefixes for existing sessions
  for (const prefix of ['octoally-', 'hivecommand-', 'openflow-']) {
    const sock = `/tmp/${prefix}${sessionId}.sock`;
    if (existsSync(sock)) return sock;
  }
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

async function dtachCreate(sessionId: string, projectPath: string, command: string): Promise<void> {
  const sock = dtachSocket(sessionId);
  if (existsSync(sock)) {
    try { unlinkSync(sock); } catch { /* ignore */ }
  }
  const shell = process.env.SHELL || '/bin/bash';
  await execFileAsync('dtach', [
    '-n', sock, '-Ez', shell, '-i', '-c', command,
  ], {
    cwd: projectPath,
    env: { ...process.env, TERM: 'xterm-256color', OCTOALLY_SESSION: '1', HIVECOMMAND_SESSION: '1', HEADLESS_WORKERS_DISABLED: '1' } as Record<string, string>,
  });
}

async function dtachKill(sessionId: string): Promise<void> {
  const sock = dtachSocket(sessionId);
  try {
    const { stdout } = await execFileAsync('fuser', [sock]);
    const pids = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* dead */ }
    }
    setTimeout(() => {
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* dead */ }
      }
    }, 2000);
  } catch { /* fuser failed */ }
  try { unlinkSync(sock); } catch { /* ignore */ }
}

/* ================================================================
   pipe-pane: capture raw application output via FIFO
   ================================================================ */

const PIPE_PANE_DIR = join(tmpdir(), 'octoally-pipes');
mkdirSync(PIPE_PANE_DIR, { recursive: true });

function setupPipePane(sessionId: string, server?: string): { stream: ReadStream; fifoPath: string } | null {
  const name = tmuxSessionName(sessionId);
  const serverArgs = ['-L', server || TMUX_SERVER];
  const fifoPath = join(PIPE_PANE_DIR, `${sessionId}.fifo`);

  try {
    try { unlinkSync(fifoPath); } catch { /* doesn't exist */ }
    execFileSync('mkfifo', [fifoPath]);
    const stream = createReadStream(fifoPath, { encoding: 'utf8' });
    execFileSync('tmux', [...serverArgs, 'pipe-pane', '-O', '-t', name, `cat > ${fifoPath}`]);
    return { stream, fifoPath };
  } catch (err) {
    console.error(`[PTY-WORKER] pipe-pane setup failed for ${sessionId}:`, err);
    try { unlinkSync(fifoPath); } catch { /* ignore */ }
    return null;
  }
}

function cleanupPipePane(sessionId: string, fifoPath?: string): void {
  const name = tmuxSessionName(sessionId);
  const server = findTmuxServer(sessionId) || TMUX_SERVER;
  try { execFileSync('tmux', ['-L', server, 'pipe-pane', '-t', name]); } catch { /* ignore */ }
  const path = fifoPath || join(PIPE_PANE_DIR, `${sessionId}.fifo`);
  try { unlinkSync(path); } catch { /* ignore */ }
}

/* ================================================================
   hivemind command builder
   ================================================================ */

function buildHiveMindCommand(task: string, direct = false, rufloCmd = 'npx ruflo@latest', cliType: 'claude' | 'codex' = 'claude'): string {
  const escaped = task.replace(/'/g, "'\\''");
  if (cliType === 'codex') {
    // For Codex: ruflo hive-mind spawn sets up the swarm but --codex workers run headlessly
    // and exit immediately. Instead, spawn the swarm then launch codex as the interactive session.
    const spawn = `${rufloCmd} hive-mind spawn '${escaped}' --codex 2>/dev/null;`;
    // --no-alt-screen prevents Codex from using the alternate screen buffer,
    // which fixes resize/reflow issues in tmux and embedded terminals
    const codex = `codex --no-alt-screen '${escaped}'`;
    const base = `${spawn} ${codex}`;
    if (direct) {
      return `command bash -c '${base.replace(/'/g, "'\\''")}'`;
    }
    return base;
  }
  // Claude: --claude flag launches an interactive Claude Code session directly
  if (direct) {
    return `command ${rufloCmd} hive-mind spawn '${escaped}' --claude`;
  }
  return `${rufloCmd} hive-mind spawn '${escaped}' --claude`;
}

function buildAgentCommand(agentType: string, task: string, direct = false, rufloCmd = 'npx ruflo@latest', cliType: 'claude' | 'codex' = 'claude'): string {
  const escapedType = agentType.replace(/'/g, "'\\''");
  const escapedTask = task.replace(/'/g, "'\\''");
  const register = `${rufloCmd} agent spawn --type '${escapedType}' 2>/dev/null;`;

  let agentCmd: string;
  if (cliType === 'codex') {
    // Codex CLI doesn't have --agent flag. Pass the agent role as part of the prompt.
    const prompt = task
      ? `You are a ${agentType} agent. ${task}`
      : `You are a ${agentType} agent. Ask me what I want you to do.`;
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    agentCmd = `codex --no-alt-screen '${escapedPrompt}'`;
  } else {
    // Claude CLI uses --agent to load agent definitions from .claude/agents/
    agentCmd = task
      ? `claude --agent '${escapedType}' '${escapedTask}'`
      : `claude --agent '${escapedType}'`;
  }

  const base = `${register} ${agentCmd}`;
  if (direct) {
    return `command bash -c '${base.replace(/'/g, "'\\''")}'`;
  }
  return base;
}

/* ================================================================
   Terminal response filter
   ================================================================ */

const TERMINAL_RESPONSE_RE = /\x1b\[\?[\d;]*c|\x1b\[>[\d;]*c|\x1b\[\d+n|\x1b\[\d+;\d+R/g;

// Focus reporting sequences — strip from PTY output so TUI programs (Codex)
// can't enable focus reporting on xterm.js.  When focus reporting is active,
// xterm.js sends \x1b[I / \x1b[O on focus/blur, which causes rendering
// corruption when switching terminal tabs or toggling grid/single view.
const FOCUS_REPORT_RE = /\x1b\[\?1004[hl]/g;

/* ================================================================
   Worker state
   ================================================================ */

let ptyProcess: pty.IPty | null = null;
let pipePaneStream: ReadStream | null = null;
let pipePaneFifo: string | null = null;
let currentSessionId: string | null = null;
let hasPipePane = false;
let useTmux = false;
let useDtach = false;

function send(msg: Record<string, unknown>): void {
  if (process.send) {
    process.send(msg);
  }
}

function wireOutput(): void {
  if (!ptyProcess) return;

  ptyProcess.onData((data: string) => {
    // Always send PTY output for state tracking in the parent
    send({ type: 'pty-data', data });

    if (!hasPipePane) {
      // No pipe-pane: PTY output IS the display output.
      // Strip focus reporting sequences so TUIs can't enable focus events on the client xterm.
      const filtered = data.replace(FOCUS_REPORT_RE, '');
      if (filtered) send({ type: 'output', data: filtered });
    }
  });

  if (pipePaneStream) {
    pipePaneStream.on('data', (chunk: string | Buffer) => {
      const raw = typeof chunk === 'string' ? chunk : chunk.toString();
      const data = raw.replace(FOCUS_REPORT_RE, '');
      if (data) send({ type: 'output', data });
    });

    pipePaneStream.on('error', (err) => {
      console.error(`[PTY-WORKER] pipe-pane stream error:`, err.message);
    });

    pipePaneStream.on('end', () => {
      // pipe-pane writer disconnected — the tmux session may have ended
    });
  }

  ptyProcess.onExit(({ exitCode, signal }) => {
    if (pipePaneStream) {
      pipePaneStream.destroy();
      if (currentSessionId) cleanupPipePane(currentSessionId, pipePaneFifo ?? undefined);
    }
    send({ type: 'exit', exitCode, signal });
    // Give parent time to process the exit message before dying
    setTimeout(() => process.exit(0), 500);
  });
}

/* ================================================================
   Spawn handlers
   ================================================================ */

async function handleSpawn(msg: SpawnMessage): Promise<void> {
  currentSessionId = msg.sessionId;
  useTmux = msg.useTmux;
  useDtach = msg.useDtach;
  const shell = process.env.SHELL || '/bin/bash';
  const rufloCmd = msg.rufloCommand || 'npx ruflo@latest';
  const cliType = msg.cliType || 'claude';

  try {
    if (msg.mode === 'terminal') {
      if (msg.useTmux) {
        await tmuxCreate(msg.sessionId, msg.projectPath, msg.cols, msg.rows);
        const pp = setupPipePane(msg.sessionId);
        if (pp) {
          pipePaneStream = pp.stream;
          pipePaneFifo = pp.fifoPath;
          hasPipePane = true;
        }
        ptyProcess = pty.spawn('tmux', [...tmuxBaseArgs, 'attach-session', '-t', tmuxSessionName(msg.sessionId)], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: { ...process.env } as Record<string, string>,
        });
      } else if (msg.useDtach) {
        await dtachCreate(msg.sessionId, msg.projectPath, shell);
        await new Promise(r => setTimeout(r, 100));
        ptyProcess = pty.spawn(shell, ['-c', `dtach -a ${dtachSocket(msg.sessionId)} -Ez`], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: { ...process.env } as Record<string, string>,
        });
      } else {
        ptyProcess = pty.spawn(shell, ['-i'], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: { ...process.env } as Record<string, string>,
        });
      }
    } else if (msg.mode === 'agent' && msg.agentType) {
      // agent mode — launch ruflo with --agent flag
      const command = buildAgentCommand(msg.agentType, msg.task, msg.useTmux, rufloCmd, cliType);
      if (msg.useTmux) {
        await tmuxCreate(msg.sessionId, msg.projectPath, msg.cols, msg.rows, command);
        const pp = setupPipePane(msg.sessionId);
        if (pp) {
          pipePaneStream = pp.stream;
          pipePaneFifo = pp.fifoPath;
          hasPipePane = true;
        }
        ptyProcess = pty.spawn('tmux', [...tmuxBaseArgs, 'attach-session', '-t', tmuxSessionName(msg.sessionId)], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: { ...process.env } as Record<string, string>,
        });
      } else if (msg.useDtach) {
        await dtachCreate(msg.sessionId, msg.projectPath, command);
        await new Promise(r => setTimeout(r, 100));
        ptyProcess = pty.spawn(shell, ['-c', `dtach -a ${dtachSocket(msg.sessionId)} -Ez`], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: { ...process.env } as Record<string, string>,
        });
      } else {
        ptyProcess = pty.spawn(shell, ['-i', '-c', command], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: { ...process.env } as Record<string, string>,
        });
      }
    } else {
      // hivemind mode
      if (msg.useTmux) {
        const command = buildHiveMindCommand(msg.task, true, rufloCmd, cliType);
        await tmuxCreate(msg.sessionId, msg.projectPath, msg.cols, msg.rows, command);
        const pp = setupPipePane(msg.sessionId);
        if (pp) {
          pipePaneStream = pp.stream;
          pipePaneFifo = pp.fifoPath;
          hasPipePane = true;
        }
        ptyProcess = pty.spawn('tmux', [...tmuxBaseArgs, 'attach-session', '-t', tmuxSessionName(msg.sessionId)], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: { ...process.env } as Record<string, string>,
        });
      } else if (msg.useDtach) {
        const command = buildHiveMindCommand(msg.task, false, rufloCmd, cliType);
        await dtachCreate(msg.sessionId, msg.projectPath, command);
        await new Promise(r => setTimeout(r, 100));
        ptyProcess = pty.spawn(shell, ['-c', `dtach -a ${dtachSocket(msg.sessionId)} -Ez`], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: { ...process.env } as Record<string, string>,
        });
      } else {
        const command = buildHiveMindCommand(msg.task, false, rufloCmd, cliType);
        ptyProcess = pty.spawn(shell, ['-i', '-c', command], {
          name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
          env: { ...process.env } as Record<string, string>,
        });
      }
    }

    wireOutput();
    send({ type: 'ready', pid: ptyProcess.pid });
  } catch (err: any) {
    send({ type: 'error', message: `Spawn failed: ${err.message}` });
    process.exit(1);
  }
}

async function handleReconnect(msg: ReconnectMessage): Promise<void> {
  const t0 = Date.now();
  currentSessionId = msg.sessionId;
  useTmux = msg.useTmux;
  useDtach = msg.useDtach;

  try {
    const hasTmuxSession = msg.useTmux && tmuxExists(msg.sessionId);
    const hasDtachSession = msg.useDtach && dtachExists(msg.sessionId);
    const log = (s: string) => appendFileSync('/tmp/octoally-timing.log', s + '\n');
    log(`[PTY-WORKER] ${msg.sessionId}: exists_check=${Date.now()-t0}ms`);

    if (!hasTmuxSession && !hasDtachSession) {
      send({ type: 'error', message: 'No tmux or dtach session found to reconnect' });
      process.exit(1);
      return;
    }

    if (hasTmuxSession) {
      const t2 = Date.now();
      const actualServer = findTmuxServer(msg.sessionId) || TMUX_SERVER;
      const serverArgs = ['-L', actualServer];
      const pp = setupPipePane(msg.sessionId, actualServer);
      log(`[PTY-WORKER] ${msg.sessionId}: pipe_pane=${Date.now()-t2}ms (server=${actualServer})`);
      if (pp) {
        pipePaneStream = pp.stream;
        pipePaneFifo = pp.fifoPath;
        hasPipePane = true;
      }
      const t3 = Date.now();
      ptyProcess = pty.spawn('tmux', [...serverArgs, 'attach-session', '-t', tmuxSessionName(msg.sessionId)], {
        name: 'xterm-256color', cols: msg.cols, rows: msg.rows,
        env: { ...process.env } as Record<string, string>,
      });
      log(`[PTY-WORKER] ${msg.sessionId}: pty_spawn=${Date.now()-t3}ms`);
    } else {
      const shell = process.env.SHELL || '/bin/bash';
      ptyProcess = pty.spawn(shell, ['-c', `dtach -a ${dtachSocket(msg.sessionId)} -Ez`], {
        name: 'xterm-256color', cols: msg.cols, rows: msg.rows,
        env: { ...process.env } as Record<string, string>,
      });
    }

    wireOutput();
    console.log(`[PTY-WORKER] ${msg.sessionId}: total_reconnect=${Date.now()-t0}ms`);
    send({ type: 'ready', pid: ptyProcess.pid, tmux: hasTmuxSession });
  } catch (err: any) {
    console.log(`[PTY-WORKER] ${msg.sessionId}: reconnect_failed=${Date.now()-t0}ms err=${err.message}`);
    send({ type: 'error', message: `Reconnect failed: ${err.message}` });
    process.exit(1);
  }
}

async function handleAdopt(msg: AdoptMessage): Promise<void> {
  currentSessionId = msg.sessionId;
  useTmux = msg.useTmux;

  try {
    // Use -r none on initial attach — the browser's resize will trigger SIGWINCH
    // naturally through tmux, causing the app to redraw at the correct size.
    if (msg.useTmux) {
      await tmuxCreate(msg.sessionId, msg.projectPath, msg.cols, msg.rows, `dtach -a ${msg.socketPath} -r none -Ez`);
      await new Promise(r => setTimeout(r, 100));
      const pp = setupPipePane(msg.sessionId);
      if (pp) {
        pipePaneStream = pp.stream;
        pipePaneFifo = pp.fifoPath;
        hasPipePane = true;
      }
      ptyProcess = pty.spawn('tmux', [...tmuxBaseArgs, 'attach-session', '-t', tmuxSessionName(msg.sessionId)], {
        name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
        env: { ...process.env } as Record<string, string>,
      });
    } else {
      const shell = process.env.SHELL || '/bin/bash';
      ptyProcess = pty.spawn(shell, ['-c', `dtach -a ${msg.socketPath} -r none -Ez`], {
        name: 'xterm-256color', cols: msg.cols, rows: msg.rows, cwd: msg.projectPath,
        env: { ...process.env } as Record<string, string>,
      });
    }

    wireOutput();
    send({ type: 'ready', pid: ptyProcess.pid });

    // Force a redraw: -r none starts blank, so do a cols-1→cols resize trick
    // to trigger SIGWINCH through dtach, making the app re-render its screen.
    // Delay to let pipe-pane fully initialize and start capturing.
    setTimeout(() => {
      if (ptyProcess && msg.useTmux) {
        try {
          execFileSync('tmux', [
            ...tmuxBaseArgs, 'resize-pane', '-t', tmuxSessionName(msg.sessionId), '-x', String(msg.cols - 1),
          ], { stdio: 'ignore' });
          setTimeout(() => {
            try {
              execFileSync('tmux', [
                ...tmuxBaseArgs, 'resize-pane', '-t', tmuxSessionName(msg.sessionId), '-x', String(msg.cols),
              ], { stdio: 'ignore' });
            } catch { /* ignore */ }
          }, 50);
        } catch { /* ignore */ }
      } else if (ptyProcess) {
        // Non-tmux: resize the PTY directly
        try {
          ptyProcess.resize(msg.cols - 1, msg.rows);
          setTimeout(() => {
            try { ptyProcess!.resize(msg.cols, msg.rows); } catch { /* ignore */ }
          }, 50);
        } catch { /* ignore */ }
      }
    }, 300);
  } catch (err: any) {
    send({ type: 'error', message: `Adopt failed: ${err.message}` });
    process.exit(1);
  }
}

function handleInput(data: string, isBracketedPaste = false): void {
  if (!ptyProcess) return;
  const cleaned = data.replace(TERMINAL_RESPONSE_RE, '');
  if (!cleaned) return;
  if (isBracketedPaste) {
    // Wrap in bracketed paste escape sequences so the shell/readline treats
    // the entire block as pasted text rather than executing each line
    ptyProcess.write(`\x1b[200~${cleaned}\x1b[201~`);
  } else {
    ptyProcess.write(cleaned);
  }
}

function handleResize(cols: number, rows: number): void {
  if (!ptyProcess) return;
  ptyProcess.resize(cols, rows);
}

/** Capture the current tmux pane content (with escape sequences) and send via IPC.
 *  This runs in the worker process so the blocking execFileSync doesn't affect
 *  the main server event loop. */
function handleCapture(): void {
  const t0 = Date.now();
  tlog(`[WORKER-CAPTURE] ${currentSessionId}: start`);
  if (!currentSessionId || !useTmux) {
    send({ type: 'capture', data: null });
    return;
  }

  // Pause pipe-pane stream to stop new output messages from entering IPC.
  if (pipePaneStream) pipePaneStream.pause();

  // Wait for any already-queued IPC writes to flush, then send capture.
  // Without this, the parent receives capture ~2.5s late due to output message flood.
  setImmediate(() => {
    const name = tmuxSessionName(currentSessionId!);
    try {
      const output = execFileSync('tmux', [
        ...tmuxBaseArgs, 'capture-pane', '-t', name, '-p', '-e', '-T',
      ], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
      tlog(`[WORKER-CAPTURE] ${currentSessionId}: tmux=${Date.now()-t0}ms, bytes=${output.length}`);
      send({ type: 'capture', data: output });
      tlog(`[WORKER-CAPTURE] ${currentSessionId}: sent, total=${Date.now()-t0}ms`);
    } catch {
      tlog(`[WORKER-CAPTURE] ${currentSessionId}: failed, total=${Date.now()-t0}ms`);
      send({ type: 'capture', data: null });
    }

    // Resume pipe-pane after capture is queued
    setImmediate(() => {
      if (pipePaneStream) pipePaneStream.resume();
    });
  });
}

async function handleKill(): Promise<void> {
  // Kill PTY process tree
  if (ptyProcess) {
    const pid = ptyProcess.pid;
    try {
      // Kill descendants first
      try {
        const { stdout } = await execFileAsync('pgrep', ['-P', String(pid)]);
        const children = stdout.trim().split('\n').filter(Boolean).map(Number);
        for (const child of children) {
          try { process.kill(child, 'SIGTERM'); } catch { /* dead */ }
        }
      } catch { /* no children */ }
      try { process.kill(pid, 'SIGTERM'); } catch { /* dead */ }
      try { process.kill(-pid, 'SIGTERM'); } catch { /* dead */ }
    } catch { /* already dead */ }
    try { ptyProcess.kill('SIGTERM'); } catch { /* dead */ }
  }

  // Kill tmux/dtach sessions
  if (currentSessionId) {
    if (useTmux) {
      await tmuxKill(currentSessionId).catch(() => {});
    }
    if (useDtach) {
      await dtachKill(currentSessionId).catch(() => {});
    }
    // Clean up pipe-pane
    if (pipePaneStream) {
      pipePaneStream.destroy();
      cleanupPipePane(currentSessionId, pipePaneFifo ?? undefined);
    }
  }

  send({ type: 'killed' });
  setTimeout(() => process.exit(0), 300);
}

/**
 * Release: detach the worker from the tmux/dtach session without killing it.
 * Used by pop-out so an external terminal can attach to the still-running session.
 */
async function handleRelease(): Promise<void> {
  // Kill the PTY process (our tmux attach client / dtach -a client) — this just detaches,
  // the tmux session / dtach master keeps running
  if (ptyProcess) {
    try { ptyProcess.kill('SIGTERM'); } catch { /* dead */ }
  }

  // Clean up pipe-pane (external terminal doesn't need it)
  if (currentSessionId && pipePaneStream) {
    pipePaneStream.destroy();
    cleanupPipePane(currentSessionId, pipePaneFifo ?? undefined);
  }

  send({ type: 'killed' });
  setTimeout(() => process.exit(0), 300);
}

/* ================================================================
   Main IPC message handler
   ================================================================ */

process.on('message', async (msg: ParentMessage) => {
  switch (msg.type) {
    case 'spawn':
      await handleSpawn(msg);
      break;
    case 'reconnect':
      await handleReconnect(msg);
      break;
    case 'adopt':
      await handleAdopt(msg as AdoptMessage);
      break;
    case 'input':
      handleInput(msg.data, msg.bracketedPaste);
      break;
    case 'resize':
      handleResize(msg.cols, msg.rows);
      break;
    case 'capture':
      handleCapture();
      break;
    case 'kill':
      await handleKill();
      break;
    case 'release':
      await handleRelease();
      break;
  }
});

// If the parent dies, clean up and exit
process.on('disconnect', () => {
  if (ptyProcess) {
    try { ptyProcess.kill('SIGTERM'); } catch { /* dead */ }
  }
  if (currentSessionId) {
    if (pipePaneStream) {
      pipePaneStream.destroy();
      cleanupPipePane(currentSessionId, pipePaneFifo ?? undefined);
    }
  }
  process.exit(0);
});

// Signal the parent that this worker is ready for messages
send({ type: 'worker-ready' });
