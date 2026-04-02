// Increase libuv thread pool for async execFile / fs operations
process.env.UV_THREADPOOL_SIZE = '16';

// Enrich PATH for desktop-launched environments (task manager, dock, app menu).
// Interactive shells load nvm/fnm/volta via .bashrc/.zshrc, but desktop-launched
// processes inherit the bare session environment which typically lacks these.
import { enrichProcessPath } from './utils/enrich-path.js';
enrichProcessPath();

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initDb, getDb } from './db/index.js';
import { eventRoutes } from './routes/events.js';
import { sessionRoutes } from './routes/sessions.js';
import { taskRoutes } from './routes/tasks.js';
import { streamRoutes } from './routes/stream.js';
import { projectRoutes, initProjects } from './routes/projects.js';
import { terminalRoutes } from './routes/terminal.js';
import { fileRoutes } from './routes/files.js';
import { gitRoutes } from './routes/git.js';
import { agentRoutes } from './routes/agent.js';
import { settingsRoutes } from './routes/settings.js';
import { appRouter } from './trpc/router.js';
import {
  fastifyTRPCPlugin,
  type FastifyTRPCPluginOptions,
} from '@trpc/server/adapters/fastify';
import type { AppRouter } from './trpc/router.js';
import { killAllSessions, cleanupStaleRunningSessions, autoReconnectDetachedSessions, getReconnectStatus, startPendingSessionWatchdog } from './services/session-manager.js';
import { config } from './config.js';
import { appendFileSync, writeFileSync, readdirSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
const tlog = (s: string) => { try { appendFileSync('/tmp/octoally-timing.log', `[${new Date().toISOString()}] ${s}\n`); } catch {} };

const __dirname = dirname(fileURLToPath(import.meta.url));

// Event loop lag detector — logs when the event loop is blocked for >100ms
let _lagLast = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = now - _lagLast - 50; // expected 50ms interval
  _lagLast = now;
  if (lag > 100) {
    tlog(`[LAG] Event loop blocked for ${lag}ms`);
  }
}, 50).unref();

async function start() {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true },
      },
    },
  });

  // Clear timing log for fresh run
  try { writeFileSync('/tmp/octoally-timing.log', ''); } catch {}

  // Clean stale agentdb v2 from all locations. agentdb 2.x has keepalive timers
  // that prevent ruflo hooks from exiting, hanging session-end indefinitely.
  // agentdb is now bundled inside ruflo — standalone copies are always stale.
  try {
    let cleaned = 0;
    // 1. Remove standalone agentdb from the shared ruflo install
    const rufloAgentdbPaths = [
      join(homedir(), '.octoally', 'ruflo', 'node_modules', 'agentdb'),
      join(homedir(), '.hivecommand', 'ruflo', 'node_modules', 'agentdb'),
    ];
    for (const p of rufloAgentdbPaths) {
      if (existsSync(p)) {
        try { rmSync(p, { recursive: true, force: true }); cleaned++; } catch {}
      }
    }
    // 2. Remove stale npx caches with @claude-flow/cli that have standalone agentdb
    const npxDir = join(homedir(), '.npm', '_npx');
    if (existsSync(npxDir)) {
      for (const entry of readdirSync(npxDir)) {
        const cacheDir = join(npxDir, entry);
        const cfPkg = join(cacheDir, 'node_modules', '@claude-flow', 'cli', 'package.json');
        if (!existsSync(cfPkg)) continue;
        const staleAgentdb = join(cacheDir, 'node_modules', 'agentdb');
        if (existsSync(staleAgentdb)) {
          try { rmSync(cacheDir, { recursive: true, force: true }); cleaned++; } catch {}
        }
      }
    }
    if (cleaned > 0) console.log(`  Cleaned ${cleaned} stale agentdb location(s)`);
  } catch { /* non-fatal */ }

  // Initialize database, load projects from user config, and clean up orphaned sessions
  let t = Date.now();
  initDb();
  tlog(`[STARTUP] initDb: ${Date.now() - t}ms`);

  // Override port from settings DB if not set via env var
  if (!process.env.PORT) {
    try {
      const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get('server_port') as { value: string } | undefined;
      if (row?.value) {
        const parsed = parseInt(row.value, 10);
        if (parsed > 0 && parsed < 65536) config.port = parsed;
      }
    } catch {}
  }

  t = Date.now();
  await initProjects();
  tlog(`[STARTUP] initProjects: ${Date.now() - t}ms`);
  // Migrate stale `npx @claude-flow/cli@latest` references in project hooks
  // to the local ruflo binary. This is the #1 cause of hivemind session hangs:
  // the stop hook calls npx which downloads the entire package on every session end.
  // Targeted one-time fix — only rewrites files that contain the broken pattern.
  try {
    const db = getDb();
    const projects = db.prepare('SELECT path FROM projects').all() as { path: string }[];
    // Check both current and legacy ruflo install paths
    const rufloPrimary = join(homedir(), '.octoally', 'ruflo', 'node_modules', '.bin', 'ruflo');
    const rufloLegacy = join(homedir(), '.hivecommand', 'ruflo', 'node_modules', '.bin', 'ruflo');
    const localRuflo = existsSync(rufloPrimary) ? rufloPrimary : existsSync(rufloLegacy) ? rufloLegacy : null;
    let migrated = 0;

    // Match all stale npx package names: @claude-flow/cli@latest, claude-flow@alpha, etc.
    const staleNpxPattern = /npx\s+(?:@claude-flow\/cli@\S+|claude-flow@\S+)/g;
    const staleNpxCheck = (s: string) => s.includes('npx @claude-flow/cli') || s.includes('npx claude-flow@');

    if (!localRuflo) {
      console.log(`  [hook-migration] No local ruflo binary found (checked ${rufloPrimary} and ${rufloLegacy})`);
    } else {
      for (const { path: projectPath } of projects) {
        // 1. Patch hook shell scripts
        const hookFiles = [
          join(projectPath, '.claude', 'hooks', 'session-end.sh'),
          join(projectPath, '.claude', 'helpers', 'pre-commit'),
          join(projectPath, '.claude', 'helpers', 'post-commit'),
        ];
        for (const file of hookFiles) {
          try {
            if (!existsSync(file)) continue;
            const content = readFileSync(file, 'utf-8');
            if (!staleNpxCheck(content)) continue;
            const fixed = content.replace(staleNpxPattern, `"${localRuflo}"`);
            if (fixed !== content) {
              writeFileSync(file, fixed, 'utf-8');
              migrated++;
            }
          } catch (err: any) {
            console.error(`  [hook-migration] Failed to migrate ${file}: ${err.message}`);
          }
        }

        // 2. Patch settings.json hook commands that call stale npx packages directly
        // No quotes around the path — it's already inside a JSON string value
        const settingsPath = join(projectPath, '.claude', 'settings.json');
        try {
          if (existsSync(settingsPath)) {
            let content = readFileSync(settingsPath, 'utf-8');
            // Repair damage from v1.0.51 which inserted literal quotes inside JSON strings:
            //   ""/path/.bin/ruflo"  →  /path/.bin/ruflo
            // The spurious quotes wrap the ruflo path inside a JSON string value.
            const repaired = content.replace(/"(\/[^"]*\/\.bin\/ruflo)"/g, '$1');
            if (repaired !== content) {
              try {
                JSON.parse(repaired);
                content = repaired;
                writeFileSync(settingsPath, content, 'utf-8');
                migrated++;
                console.log(`  [hook-migration] Repaired malformed JSON in ${settingsPath}`);
              } catch { /* still broken, skip */ }
            }
            if (staleNpxCheck(content)) {
              const fixed = content.replace(staleNpxPattern, localRuflo);
              try {
                JSON.parse(fixed);
                writeFileSync(settingsPath, fixed, 'utf-8');
                migrated++;
              } catch {
                console.error(`  [hook-migration] Skipped ${settingsPath} — replacement would produce invalid JSON`);
              }
            }
          }
        } catch (err: any) {
          console.error(`  [hook-migration] Failed to migrate ${settingsPath}: ${err.message}`);
        }

        // 3. Ensure Stop/SessionEnd hooks have timeouts.
        // ruflo hooks session-end hangs due to agentdb keepalive timers.
        // Parse as JSON and add timeout to any hook entry that lacks one.
        try {
          const sp = join(projectPath, '.claude', 'settings.json');
          if (existsSync(sp)) {
            const raw = readFileSync(sp, 'utf-8');
            let parsed: any;
            try { parsed = JSON.parse(raw); } catch { parsed = null; }
            if (parsed?.hooks) {
              let changed = false;
              for (const key of ['Stop', 'SessionEnd', 'SubagentStop']) {
                const entries = parsed.hooks[key];
                if (!Array.isArray(entries)) continue;
                for (const entry of entries) {
                  if (!Array.isArray(entry.hooks)) continue;
                  for (const h of entry.hooks) {
                    if (h.type === 'command' && !h.timeout) {
                      h.timeout = 5000;
                      changed = true;
                    }
                  }
                }
              }
              if (changed) {
                writeFileSync(sp, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
                migrated++;
              }
            }
          }
        } catch { /* non-fatal */ }
      }
    }
    if (migrated > 0) {
      console.log(`  Migrated ${migrated} hook file(s) from npx @claude-flow/cli to local ruflo`);
    } else {
      console.log(`  [hook-migration] Checked ${projects.length} project(s), 0 needed migration (ruflo: ${localRuflo})`);
    }
  } catch (err: any) {
    console.error(`  [hook-migration] Error: ${err.message}`);
  }

  t = Date.now();
  await cleanupStaleRunningSessions();
  tlog(`[STARTUP] cleanupStale: ${Date.now() - t}ms`);
  // Auto-reconnect detached sessions in background — don't block server startup.
  // Sessions become available as their workers connect.
  autoReconnectDetachedSessions().catch((err) => {
    console.error('Auto-reconnect failed:', err);
  });
  // Watchdog: auto-fail sessions stuck in "pending" for >90s (e.g. browser closed
  // before WebSocket connected, or spawn command hangs on registry check/npm install)
  startPendingSessionWatchdog();

  // Plugins
  await app.register(cors, {
    origin: config.isDev ? true : false,
  });
  await app.register(fastifyWebsocket);

  // API routes (REST for hooks, will add tRPC later)
  await app.register(eventRoutes, { prefix: '/api' });
  await app.register(sessionRoutes, { prefix: '/api' });
  await app.register(taskRoutes, { prefix: '/api' });
  await app.register(streamRoutes, { prefix: '/api' });
  await app.register(projectRoutes, { prefix: '/api' });
  await app.register(terminalRoutes, { prefix: '/api' });
  await app.register(fileRoutes, { prefix: '/api' });
  await app.register(gitRoutes, { prefix: '/api' });
  await app.register(agentRoutes, { prefix: '/api' });
  await app.register(settingsRoutes, { prefix: '/api' });

  // tRPC
  await app.register(fastifyTRPCPlugin, {
    prefix: '/api/trpc',
    trpcOptions: { router: appRouter } as FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
  });

  // Open URL in system browser (used by Tauri webview where window.open doesn't work)
  app.post('/api/open-url', async (req, reply) => {
    const { url } = req.body as { url?: string };
    if (!url || typeof url !== 'string' || !(url.startsWith('http://') || url.startsWith('https://'))) {
      return reply.status(400).send({ error: 'Invalid URL' });
    }
    const { execFile } = await import('child_process');
    execFile('xdg-open', [url], (err) => {
      if (err) execFile('open', [url]); // macOS fallback
    });
    return { ok: true };
  });

  // Open file manager at a directory path
  app.post('/api/open-folder', async (req, reply) => {
    const { path } = req.body as { path?: string };
    if (!path || typeof path !== 'string') {
      return reply.status(400).send({ error: 'Invalid path' });
    }
    const { spawn } = await import('child_process');
    const isMac = process.platform === 'darwin';
    // macOS: 'open' opens Finder; Linux: 'xdg-open' opens default file manager
    const cmd = isMac ? 'open' : 'xdg-open';
    spawn(cmd, [path], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  });

  // Open terminal at a directory path
  app.post('/api/open-terminal', async (req, reply) => {
    const { path } = req.body as { path?: string };
    if (!path || typeof path !== 'string') {
      return reply.status(400).send({ error: 'Invalid path' });
    }
    const { spawn, exec } = await import('child_process');
    const isMac = process.platform === 'darwin';

    if (isMac) {
      // macOS: open Terminal.app at the given path
      spawn('open', ['-a', 'Terminal', path], { detached: true, stdio: 'ignore' }).unref();
    } else {
      // Linux: find and launch the first available terminal emulator
      exec('which gnome-terminal xfce4-terminal konsole alacritty kitty wezterm xterm', { timeout: 3000 }, (_err, stdout) => {
        const terminals = (stdout || '').trim().split('\n').filter(Boolean);
        if (terminals.length === 0) {
          spawn('xdg-open', [path], { detached: true, stdio: 'ignore' }).unref();
          return;
        }
        const term = terminals[0];
        const basename = term.split('/').pop() || '';
        let args: string[] = [];
        if (basename === 'gnome-terminal' || basename === 'xfce4-terminal') {
          args = ['--working-directory', path];
        } else if (basename === 'konsole') {
          args = ['--workdir', path];
        }
        spawn(term, args, { cwd: path, detached: true, stdio: 'ignore' }).unref();
      });
    }
    return { ok: true };
  });

  // Version check via GitHub releases — used by dashboard and desktop app
  // Supports ?channel=stable|beta|alpha query param (default: stable)
  // - stable: prefer newest non-prerelease; fall back to newest prerelease if no stable exists
  // - beta: newest prerelease
  // - alpha: newest release of any kind
  const GITHUB_RELEASES_URL = 'https://api.github.com/repos/ai-genius-automations/octoally/releases?per_page=20';
  const _versionCache = new Map<string, { version: string; name: string; url: string; prerelease: boolean; checkedAt: number }>();

  interface GitHubRelease {
    tag_name?: string;
    name?: string;
    html_url?: string;
    prerelease?: boolean;
    draft?: boolean;
  }

  app.get('/api/version-check', async (req, reply) => {
    try {
      const channel = (req.query as Record<string, string>).channel || 'stable';
      const now = Date.now();
      const cached = _versionCache.get(channel);
      if (cached && (now - cached.checkedAt) < 300_000) {
        return { current: serverVersion, latest: cached.version, name: cached.name, url: cached.url, prerelease: cached.prerelease, channel, updateAvailable: cached.version !== '' && cached.version !== serverVersion };
      }

      const resp = await fetch(GITHUB_RELEASES_URL, {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'OctoAlly' },
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) {
        return reply.status(502).send({ error: 'GitHub API request failed' });
      }

      const releases = (await resp.json() as GitHubRelease[]).filter(r => !r.draft);

      let pick: GitHubRelease | undefined;
      if (channel === 'stable') {
        // Prefer first non-prerelease; fall back to newest prerelease if no stable exists
        pick = releases.find(r => !r.prerelease) || releases[0];
      } else if (channel === 'beta') {
        pick = releases.find(r => r.prerelease) || releases[0];
      } else {
        // alpha/canary — newest of any kind
        pick = releases[0];
      }

      const latestVersion = (pick?.tag_name || '').replace(/^v/, '');
      const entry = { version: latestVersion, name: pick?.name || '', url: pick?.html_url || '', prerelease: pick?.prerelease || false, checkedAt: now };
      _versionCache.set(channel, entry);

      return {
        current: serverVersion,
        latest: latestVersion,
        name: entry.name,
        url: entry.url,
        prerelease: entry.prerelease,
        channel,
        updateAvailable: latestVersion !== '' && latestVersion !== serverVersion,
      };
    } catch {
      return reply.status(500).send({ error: 'Version check failed' });
    }
  });

  // Return the update command — the dashboard handles copy-to-clipboard.
  app.get('/api/update-command', async () => {
    return {
      command: 'npx -y octoally@latest',
    };
  });

  // Health check — read version from package.json
  let serverVersion = '0.0.0';
  try {
    const { readFileSync } = await import('fs');
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));
    serverVersion = pkg.version || '0.0.0';
  } catch {}

  app.get('/api/health', async () => {
    const reconnect = getReconnectStatus();
    return {
      name: 'octoally',
      version: serverVersion,
      status: 'running',
      uptime: process.uptime(),
      reconnecting: reconnect.reconnecting,
      reconnectTotal: reconnect.total,
      reconnectDone: reconnect.done,
    };
  });

  // Restart server — exits the process so the parent (CLI/systemd/Electron) can relaunch
  app.post('/api/restart', async () => {
    setTimeout(() => process.exit(0), 500);
    return { ok: true, message: 'Server restarting...' };
  });

  // Network info — returns local IP addresses for the settings UI hint
  app.get('/api/network-info', async () => {
    const { networkInterfaces } = await import('os');
    const nets = networkInterfaces();
    const addresses: string[] = [];
    for (const iface of Object.values(nets)) {
      if (!iface) continue;
      for (const net of iface) {
        if (!net.internal && net.family === 'IPv4') {
          addresses.push(net.address);
        }
      }
    }
    return { addresses, port: config.port };
  });

  // Serve dashboard in production
  if (!config.isDev) {
    const dashboardPath = resolve(__dirname, '../../dashboard/dist');
    await app.register(fastifyStatic, {
      root: dashboardPath,
      prefix: '/',
      cacheControl: false,
    });

    // No-cache for index.html so Electron always picks up new builds
    app.addHook('onSend', async (_req, reply, payload) => {
      const ct = reply.getHeader('content-type');
      if (typeof ct === 'string' && ct.includes('text/html')) {
        reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
      return payload;
    });

    // SPA fallback
    app.setNotFoundHandler(async (_req, reply) => {
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      return reply.sendFile('index.html');
    });
  }

  // Start
  t = Date.now();
  await app.listen({ port: config.port, host: config.host });
  tlog(`[STARTUP] listen: ${Date.now() - t}ms`);
  tlog(`[STARTUP] server ready, accepting connections`);
  console.log(`\n🌊 OctoAlly running at http://localhost:${config.port}`);
  console.log(`   API: http://localhost:${config.port}/api`);
  if (config.isDev) {
    console.log(`   Dashboard: http://localhost:42011 (Vite dev server)`);
  }
}

start().catch((err) => {
  console.error('Failed to start OctoAlly:', err);
  process.exit(1);
});

// Graceful shutdown — kill all PTY sessions
function shutdown() {
  console.log('\n🌊 Shutting down OctoAlly...');
  killAllSessions();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception — cleaning up sessions:', err);
  killAllSessions();
  process.exit(1);
});
