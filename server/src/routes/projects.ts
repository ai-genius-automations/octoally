import { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/index.js';
import { nanoid } from 'nanoid';
import { readdir, mkdir, readFile, writeFile } from 'fs/promises';
import { join, resolve, basename } from 'path';
import { homedir } from 'os';
import { execFile, execFileSync } from 'child_process';
import { existsSync, mkdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Migrate hook paths in .claude/settings.json to absolute paths.
 *
 * Both ruflo init and DevCortex installers write relative or $CLAUDE_PROJECT_DIR
 * paths that break when CWD differs from the project root (e.g. npm scripts change
 * CWD to a subdirectory). $CLAUDE_PROJECT_DIR is not a real Claude Code env var.
 *
 * This runs AFTER any tool writes settings.json and patches all paths to absolute.
 * Idempotent — safe to call multiple times. Returns a log line or null.
 */
function migrateSettingsHookPaths(projectPath: string): string | null {
  const settingsPath = join(projectPath, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return null;
  try {
    let settings = readFileSync(settingsPath, 'utf-8');
    const oldSettings = settings;
    const pp = projectPath;
    // Fix relative node .claude/ paths → absolute
    settings = settings.replace(/("node )(\.claude\/)/g, `$1${pp}/.claude/`);
    // Fix broken $CLAUDE_PROJECT_DIR references → absolute (unquoted form)
    settings = settings.replace(/("node )\$CLAUDE_PROJECT_DIR\/(\.claude\/)/g, `$1${pp}/.claude/`);
    // Fix broken $CLAUDE_PROJECT_DIR with escaped quotes (ruflo init --force output)
    settings = settings.replace(/(node )(\\"\$CLAUDE_PROJECT_DIR\/)(\.claude\/)/g, `$1${pp}/.claude/`);
    // Clean up trailing escaped quotes left over from the above replacement
    settings = settings.replace(new RegExp(`(${pp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.claude/helpers/[^"]+)(\\\\")`, 'g'), '$1');
    // Fix relative find/rm .swarm/ paths → absolute
    settings = settings.replace(/(find |rm -f )(\.swarm\/)/g, `$1${pp}/.swarm/`);
    settings = settings.replace(/(find |rm -f )\$CLAUDE_PROJECT_DIR\/(\.swarm\/)/g, `$1${pp}/.swarm/`);
    if (settings !== oldSettings) {
      writeFileSync(settingsPath, settings, 'utf-8');
      return '[migrate] Patched hook paths to absolute: ' + pp;
    }
  } catch {
    // Non-fatal — settings file may be malformed
  }
  return null;
}

/** Shared ruflo-run.sh — created by DevCortex installer, shared with HiveCommand.
 *  Falls back to npx if the script doesn't exist (no DevCortex installed). */
const RUFLO_RUN = join(homedir(), '.hivecommand', 'ruflo-run.sh');
const HAS_RUFLO_RUN = existsSync(RUFLO_RUN);

/**
 * Check if a project already has a valid RuFlo memory database.
 * Returns true if .swarm/memory.db exists and has actual content (schema).
 * An empty 0-byte file (created by broken init) is treated as invalid.
 */
function hasValidMemoryDb(projectPath: string): boolean {
  const dbPath = join(projectPath, '.swarm', 'memory.db');
  if (!existsSync(dbPath)) return false;
  try {
    const stat = statSync(dbPath);
    // A properly initialized DB is ~155KB+; an empty/broken one is 0 bytes
    return stat.size > 1024;
  } catch {
    return false;
  }
}

/** Check which config files exist in a project that ruflo init would overwrite */
function checkRufloConflicts(projectPath: string): { settingsJson: boolean; claudeMd: boolean } {
  return {
    settingsJson: existsSync(join(projectPath, '.claude', 'settings.json')),
    claudeMd: existsSync(join(projectPath, 'CLAUDE.md')),
  };
}

/** Create timestamped .bak copies of files before ruflo init overwrites them */
function backupRufloConflicts(projectPath: string): string[] {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backed: string[] = [];
  const files = [
    join(projectPath, '.claude', 'settings.json'),
    join(projectPath, 'CLAUDE.md'),
  ];
  for (const f of files) {
    if (existsSync(f)) {
      const bakPath = `${f}.${ts}.bak`;
      try { writeFileSync(bakPath, readFileSync(f, 'utf-8'), 'utf-8'); backed.push(bakPath); } catch {}
    }
  }
  return backed;
}


export interface Project {
  id: string;
  name: string;
  path: string;
  description: string | null;
  ruflo_prompt: string | null;
  openclaw_prompt: string | null;
  default_web_url: string | null;
  created_at: string;
  updated_at: string;
}

/** ~/.hivecommand/projects.json — portable backup, not the source of truth */
const HIVECOMMAND_DIR = join(homedir(), '.hivecommand');
const PROJECTS_FILE = join(HIVECOMMAND_DIR, 'projects.json');

/** Export current DB projects to the config file (for portability across DB resets) */
async function exportToConfig(): Promise<void> {
  const db = getDb();
  const rows = db.prepare('SELECT name, path, description, ruflo_prompt, openclaw_prompt, default_web_url FROM projects ORDER BY name COLLATE NOCASE').all();
  await mkdir(HIVECOMMAND_DIR, { recursive: true });
  await writeFile(PROJECTS_FILE, JSON.stringify({ projects: rows }, null, 2), 'utf-8');
}

/**
 * Called once on startup. If the DB has no projects but the config file does,
 * import them (handles DB reset / fresh install with existing config).
 */
export async function initProjects(): Promise<void> {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) as n FROM projects').get() as { n: number }).n;

  if (count > 0) {
    // DB has projects — make sure config file is up to date
    await exportToConfig();
    return;
  }

  // DB is empty — try importing from config file
  try {
    const raw = await readFile(PROJECTS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const configs = Array.isArray(data.projects) ? data.projects : [];

    let imported = 0;
    for (const p of configs) {
      if (!p.name || !p.path) continue;
      const id = nanoid(12);
      db.prepare('INSERT INTO projects (id, name, path, description, ruflo_prompt, openclaw_prompt, default_web_url) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, p.name, p.path, p.description || null, p.ruflo_prompt || null, p.openclaw_prompt || null, p.default_web_url || null);
      imported++;
    }
    if (imported > 0) {
      console.log(`  Imported ${imported} projects from ~/.hivecommand/projects.json`);
    }
  } catch {
    // No config file — that's fine, new user starts with empty projects
  }
}

export const projectRoutes: FastifyPluginAsync = async (app) => {
  // List projects
  app.get('/projects', async () => {
    const db = getDb();
    const projects = db.prepare('SELECT * FROM projects ORDER BY name COLLATE NOCASE').all();
    return { projects };
  });

  // Get single project
  app.get<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    return { project };
  });

  // Create project
  app.post<{
    Body: { name: string; path: string; description?: string; ruflo_prompt?: string; openclaw_prompt?: string; default_web_url?: string };
  }>('/projects', async (req, reply) => {
    const { name, path, description, ruflo_prompt, openclaw_prompt, default_web_url } = req.body;
    if (!name || !path) return reply.status(400).send({ error: 'name and path are required' });

    const db = getDb();
    const id = nanoid(12);

    const existing = db.prepare('SELECT id FROM projects WHERE path = ?').get(path);
    if (existing) return reply.status(409).send({ error: 'Project with this path already exists' });

    db.prepare('INSERT INTO projects (id, name, path, description, ruflo_prompt, openclaw_prompt, default_web_url) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, path, description || null, ruflo_prompt || null, openclaw_prompt || null, default_web_url || null);

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    await exportToConfig();

    return { ok: true, project };
  });

  // Update project
  app.patch<{
    Params: { id: string };
    Body: { name?: string; description?: string; ruflo_prompt?: string | null; openclaw_prompt?: string | null; default_web_url?: string | null };
  }>('/projects/:id', async (req, reply) => {
    const db = getDb();
    const updates: string[] = [];
    const params: unknown[] = [];

    if (req.body.name) { updates.push('name = ?'); params.push(req.body.name); }
    if (req.body.description !== undefined) { updates.push('description = ?'); params.push(req.body.description); }
    if (req.body.ruflo_prompt !== undefined) { updates.push('ruflo_prompt = ?'); params.push(req.body.ruflo_prompt); }
    if (req.body.openclaw_prompt !== undefined) { updates.push('openclaw_prompt = ?'); params.push(req.body.openclaw_prompt); }
    if (req.body.default_web_url !== undefined) { updates.push('default_web_url = ?'); params.push(req.body.default_web_url); }

    if (updates.length === 0) return reply.status(400).send({ error: 'Nothing to update' });

    updates.push("updated_at = datetime('now')");
    params.push(req.params.id);

    const result = db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    if (result.changes === 0) return reply.status(404).send({ error: 'Project not found' });

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    await exportToConfig();

    return { ok: true, project };
  });

  // Delete project
  app.delete<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const db = getDb();
    // Nullify foreign key references before deleting (sessions/tasks/events may reference this project)
    db.prepare('UPDATE sessions SET project_id = NULL WHERE project_id = ?').run(req.params.id);
    db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').run(req.params.id);
    db.prepare('UPDATE events SET project_id = NULL WHERE project_id = ?').run(req.params.id);
    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return reply.status(404).send({ error: 'Project not found' });

    await exportToConfig();
    return { ok: true };
  });

  // RuFlo status for all projects
  app.get('/projects/ruflo-status', async () => {
    const db = getDb();
    const projects = db.prepare('SELECT id, path FROM projects').all() as { id: string; path: string }[];

    // Check all projects in parallel using file existence only (no npx calls - too slow)
    const entries = await Promise.all(
      projects.map(async (p) => {
        const hasMemory = hasValidMemoryDb(p.path);
        const hasSwarm = existsSync(join(p.path, '.swarm'));
        const hasClaudeFlow = existsSync(join(p.path, '.claude-flow', 'config.yaml'));
        const hasClaudeSettings = existsSync(join(p.path, '.claude', 'settings.json'));
        return [p.id, {
          installed: hasSwarm || hasMemory || hasClaudeFlow || hasClaudeSettings,
          version: null,
          memoryInitialized: hasMemory,
        }] as const;
      })
    );

    const statuses: Record<string, { installed: boolean; version: string | null; memoryInitialized: boolean }> = {};
    for (const [id, status] of entries) {
      statuses[id] = status;
    }

    return { statuses };
  });

  // Check for existing config files that ruflo init would overwrite
  app.get<{
    Params: { id: string };
  }>('/projects/:id/ruflo-check', async (req, reply) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Project | undefined;
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    return checkRufloConflicts(project.path);
  });

  // Install RuFlo for a project (full init — backs up existing config files first)
  app.post<{
    Params: { id: string };
  }>('/projects/:id/ruflo-install', async (req, reply) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Project | undefined;
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    // Ensure project directory exists (user may have typed a path that doesn't exist yet)
    if (!existsSync(project.path)) {
      mkdirSync(project.path, { recursive: true });
    }
    const opts = { cwd: project.path, timeout: 180_000 };
    const output: string[] = [];

    // Create .bak copies before init overwrites them
    const backed = backupRufloConflicts(project.path);
    if (backed.length > 0) {
      output.push(`[backup] ${backed.length} file(s) backed up`);
      for (const b of backed) output.push(`  → ${b}`);
    }

    // Run each step sequentially to avoid parallel npx downloads OOM on low-memory machines
    // Use shared ruflo-run.sh if available (fast), otherwise fall back to npx
    const rufloArgs = HAS_RUFLO_RUN
      ? { cmd: 'bash', args: (sub: string[]) => [RUFLO_RUN, ...sub] }
      : { cmd: npx, args: (sub: string[]) => ['ruflo@latest', ...sub] };
    try {
      const result = await execFileAsync(rufloArgs.cmd, rufloArgs.args(['init', '--force']), opts);
      output.push('[ruflo init] ' + (result.stdout || 'done'));
    } catch (err: any) {
      output.push('[error] ' + (err.message || String(err)));
      return reply.status(500).send({ ok: false, output: output.join('\n'), error: err.message });
    }

    // Initialize hive-mind (sequential — ruflo already cached from init above)
    try {
      const hmResult = await execFileAsync(rufloArgs.cmd, rufloArgs.args(['hive-mind', 'init']), opts);
      output.push('[hive-mind init] ' + (hmResult.stdout || 'done'));
    } catch (err: any) {
      output.push('[hive-mind init] ' + (err.message || 'skipped'));
    }

    // Patch relative/broken hook paths to absolute after ruflo writes settings
    const migrated = migrateSettingsHookPaths(project.path);
    if (migrated) output.push(migrated);

    // Clean up stale artifacts left by old ruflo versions.
    // agentdb is now bundled inside ruflo — stale local copies (v2 alpha) cause
    // "[AgentDB Patch] Controller index not found" warnings because the runtime patch
    // finds the wrong version. Matches DevCortex installer cleanup logic.
    // The agentdb-runtime-patch searches: cwd/node_modules/agentdb, then ../node_modules/agentdb,
    // then $HOME/node_modules/agentdb — so we must clean ALL of these locations.
    const cleanupDirs = [
      project.path,        // project's own node_modules
      homedir(),           // $HOME/node_modules (old ruflo scaffold at home level)
    ];
    // Also check parent directories up to $HOME (the patch walks up)
    let parent = resolve(project.path, '..');
    const home = homedir();
    while (parent.length >= home.length && parent !== project.path) {
      if (!cleanupDirs.includes(parent)) cleanupDirs.push(parent);
      const next = resolve(parent, '..');
      if (next === parent) break;
      parent = next;
    }

    for (const dir of cleanupDirs) {
      // Remove stale claude-flow.config.json (old ruflo v2 format).
      // The config loader walks cwd → parent → $HOME/.claude-flow/ and warns
      // "Invalid config … Required" when it finds the old JSON schema.
      // New ruflo uses .claude-flow/config.yaml — the old JSON is always stale.
      const staleConfig = join(dir, 'claude-flow.config.json');
      if (existsSync(staleConfig)) {
        try {
          const { unlink: unlinkAsync } = await import('fs/promises');
          await unlinkAsync(staleConfig);
          output.push(`[cleanup] Removed stale claude-flow.config.json in ${dir}`);
        } catch {}
      }

      // Remove stale agentdb (npm uninstall first, manual fallback)
      const staleAgentdb = join(dir, 'node_modules', 'agentdb');
      if (existsSync(staleAgentdb) && existsSync(join(dir, 'package.json'))) {
        try {
          await execFileAsync('npm', ['uninstall', 'agentdb'], { cwd: dir, timeout: 30_000 });
          output.push(`[cleanup] Removed legacy agentdb from ${dir} (now bundled in ruflo)`);
        } catch {
          try {
            const { rm } = await import('fs/promises');
            await rm(staleAgentdb, { recursive: true, force: true });
            output.push(`[cleanup] Removed stale node_modules/agentdb from ${dir} (manual)`);
          } catch {}
        }
        // If the package.json is the old "claude-flow-project" scaffold with no real
        // deps left, remove the whole thing (package.json, lock, empty node_modules)
        try {
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
          if (pkg.name === 'claude-flow-project') {
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            delete deps.agentdb; // already uninstalled
            if (Object.keys(deps).length === 0) {
              const { rm, unlink: unlinkAsync } = await import('fs/promises');
              await unlinkAsync(join(dir, 'package.json'));
              const staleLock = join(dir, 'package-lock.json');
              if (existsSync(staleLock)) await unlinkAsync(staleLock);
              const staleModules = join(dir, 'node_modules');
              if (existsSync(staleModules)) await rm(staleModules, { recursive: true, force: true });
              output.push(`[cleanup] Removed empty claude-flow-project scaffolding from ${dir}`);
            }
          }
        } catch {}
      }
    }

    return { ok: true, output: output.join('\n') };
  });

  // List available ruflo agent types for a project (reads .claude/agents/*.md frontmatter)
  app.get<{
    Params: { id: string };
  }>('/projects/:id/ruflo-agents', async (req, reply) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Project | undefined;
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    const agentsDir = join(project.path, '.claude', 'agents');
    if (!existsSync(agentsDir)) return { agents: [] };

    const agents: { name: string; type: string; description: string; category: string }[] = [];
    try {
      const walkDir = async (dir: string, category: string) => {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walkDir(fullPath, entry.name);
          } else if (entry.name.endsWith('.md')) {
            try {
              const content = await readFile(fullPath, 'utf-8');
              const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
              if (frontmatterMatch) {
                const fm = frontmatterMatch[1];
                const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim()?.replace(/^["']|["']$/g, '');
                const type = fm.match(/^type:\s*(.+)$/m)?.[1]?.trim()?.replace(/^["']|["']$/g, '') || '';
                const desc = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim()?.replace(/^["']|["']$/g, '') || '';
                if (name) {
                  agents.push({ name, type, description: desc, category });
                }
              }
            } catch {}
          }
        }
      };
      await walkDir(agentsDir, 'core');
    } catch {}

    // Deduplicate by name (some agents have copies in subdirectories)
    const seen = new Set<string>();
    const unique = agents.filter(a => {
      if (seen.has(a.name)) return false;
      seen.add(a.name);
      return true;
    });
    unique.sort((a, b) => a.name.localeCompare(b.name));

    return { agents: unique };
  });

  // DevCortex status for all projects
  app.get('/projects/devcortex-status', async () => {
    const db = getDb();
    const projects = db.prepare('SELECT id, name, path FROM projects').all() as { id: string; name: string; path: string }[];

    // Check global DevCortex config
    const globalConfigPath = join(homedir(), '.config', 'devcortex', 'config.json');
    const globalInstalled = existsSync(globalConfigPath);
    let globalConfig: { server_url?: string; api_key?: string } | null = null;
    if (globalInstalled) {
      try {
        globalConfig = JSON.parse(readFileSync(globalConfigPath, 'utf-8'));
      } catch {}
    }

    const statuses: Record<string, { installed: boolean; eligible: boolean; version?: string }> = {};
    for (const p of projects) {
      const isHivecommandProject = p.name.toLowerCase().startsWith('hivecommand');
      const devcortexFile = join(p.path, '.devcortex');
      const installed = existsSync(devcortexFile);
      let version: string | undefined;
      if (installed) {
        try {
          const data = JSON.parse(readFileSync(devcortexFile, 'utf-8'));
          version = data.local_version || undefined;
        } catch {}
      }
      statuses[p.id] = {
        installed,
        eligible: !isHivecommandProject && globalInstalled,
        version,
      };
    }

    return { globalInstalled, statuses };
  });

  // Install DevCortex for a project (runs the hivecommand installer script)
  app.post<{
    Params: { id: string };
  }>('/projects/:id/devcortex-install', async (req, reply) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Project | undefined;
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    // Don't allow install on hivecommand projects
    if (project.name.toLowerCase().startsWith('hivecommand')) {
      return reply.status(400).send({ error: 'DevCortex cannot be installed on HiveCommand projects' });
    }

    // Read global config for the API key
    const globalConfigPath = join(homedir(), '.config', 'devcortex', 'config.json');
    if (!existsSync(globalConfigPath)) {
      return reply.status(400).send({ error: 'DevCortex global config not found. Run the global setup first.' });
    }

    let globalConfig: { server_url?: string; api_key?: string };
    try {
      globalConfig = JSON.parse(readFileSync(globalConfigPath, 'utf-8'));
    } catch {
      return reply.status(500).send({ error: 'Failed to read DevCortex global config' });
    }

    if (!globalConfig.api_key || !globalConfig.server_url) {
      return reply.status(400).send({ error: 'DevCortex global config missing api_key or server_url' });
    }

    // Run the HiveCommand-specific DevCortex installer via curl
    const installUrl = `${globalConfig.server_url}/api/setup/install-hivecommand.sh?key=${globalConfig.api_key}`;
    try {
      const result = await execFileAsync('bash', ['-c', `curl -fsSL "${installUrl}" | bash`], {
        cwd: project.path,
        timeout: 60_000,
        env: { ...process.env, HOME: homedir() },
      });
      // Patch relative/broken hook paths after DevCortex writes settings
      const migrated = migrateSettingsHookPaths(project.path);
      const output = result.stdout || 'DevCortex installed';
      return { ok: true, output: migrated ? output + '\n' + migrated : output };
    } catch (err: any) {
      return reply.status(500).send({ ok: false, error: err.message || 'Install failed', output: err.stderr || '' });
    }
  });

  // Uninstall DevCortex from a project (removes .devcortex file)
  app.delete<{
    Params: { id: string };
  }>('/projects/:id/devcortex', async (req, reply) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Project | undefined;
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    const devcortexFile = join(project.path, '.devcortex');
    if (!existsSync(devcortexFile)) {
      return reply.status(404).send({ error: 'DevCortex not installed on this project' });
    }

    const { unlink } = await import('fs/promises');
    await unlink(devcortexFile);
    return { ok: true };
  });

  // Browse directories (for folder picker UI)
  app.get<{
    Querystring: { path?: string };
  }>('/browse', async (req, reply) => {
    const dirPath = resolve(req.query.path || homedir());

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const dirs: { name: string; path: string; hasChildren: boolean }[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue;
        if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;

        const fullPath = join(dirPath, entry.name);
        let hasChildren = false;
        try {
          const sub = await readdir(fullPath, { withFileTypes: true });
          hasChildren = sub.some(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');
        } catch {
          // Can't read subdirectory
        }

        dirs.push({ name: entry.name, path: fullPath, hasChildren });
      }

      dirs.sort((a, b) => a.name.localeCompare(b.name));

      return {
        path: dirPath,
        parent: dirPath === '/' ? null : resolve(dirPath, '..'),
        folderName: basename(dirPath),
        dirs,
      };
    } catch (err: any) {
      if (err.code === 'ENOENT') return reply.status(404).send({ error: 'Directory not found' });
      if (err.code === 'EACCES') return reply.status(403).send({ error: 'Permission denied' });
      return reply.status(500).send({ error: 'Failed to browse directory' });
    }
  });

};
