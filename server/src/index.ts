// Increase libuv thread pool for async execFile / fs operations
process.env.UV_THREADPOOL_SIZE = '16';

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initDb } from './db/index.js';
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
import { killAllSessions, cleanupStaleRunningSessions, autoReconnectDetachedSessions, getReconnectStatus } from './services/session-manager.js';
import { config } from './config.js';
import { appendFileSync, writeFileSync } from 'fs';
const tlog = (s: string) => { try { appendFileSync('/tmp/hivecommand-timing.log', `[${new Date().toISOString()}] ${s}\n`); } catch {} };

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
  try { writeFileSync('/tmp/hivecommand-timing.log', ''); } catch {}

  // Initialize database, load projects from user config, and clean up orphaned sessions
  let t = Date.now();
  initDb();
  tlog(`[STARTUP] initDb: ${Date.now() - t}ms`);
  t = Date.now();
  await initProjects();
  tlog(`[STARTUP] initProjects: ${Date.now() - t}ms`);
  t = Date.now();
  await cleanupStaleRunningSessions();
  tlog(`[STARTUP] cleanupStale: ${Date.now() - t}ms`);
  // Auto-reconnect detached sessions in background — don't block server startup.
  // Sessions become available as their workers connect.
  autoReconnectDetachedSessions().catch((err) => {
    console.error('Auto-reconnect failed:', err);
  });

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
  const GITHUB_RELEASES_URL = 'https://api.github.com/repos/ai-genius-automations/hivecommand/releases?per_page=20';
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
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'HiveCommand' },
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
      name: 'hivecommand',
      version: serverVersion,
      status: 'running',
      uptime: process.uptime(),
      reconnecting: reconnect.reconnecting,
      reconnectTotal: reconnect.total,
      reconnectDone: reconnect.done,
    };
  });

  // Serve dashboard in production
  if (!config.isDev) {
    const dashboardPath = resolve(__dirname, '../../dashboard/dist');
    await app.register(fastifyStatic, {
      root: dashboardPath,
      prefix: '/',
    });

    // SPA fallback
    app.setNotFoundHandler(async (_req, reply) => {
      return reply.sendFile('index.html');
    });
  }

  // Start
  t = Date.now();
  await app.listen({ port: config.port, host: config.host });
  tlog(`[STARTUP] listen: ${Date.now() - t}ms`);
  tlog(`[STARTUP] server ready, accepting connections`);
  console.log(`\n🌊 HiveCommand running at http://localhost:${config.port}`);
  console.log(`   API: http://localhost:${config.port}/api`);
  if (config.isDev) {
    console.log(`   Dashboard: http://localhost:42011 (Vite dev server)`);
  }
}

start().catch((err) => {
  console.error('Failed to start HiveCommand:', err);
  process.exit(1);
});

// Graceful shutdown — kill all PTY sessions
function shutdown() {
  console.log('\n🌊 Shutting down HiveCommand...');
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
