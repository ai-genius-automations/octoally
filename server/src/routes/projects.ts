import { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/index.js';
import { nanoid } from 'nanoid';
import { readdir, mkdir, readFile, writeFile, rm, unlink, copyFile } from 'fs/promises';
import { join, resolve, basename } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, lstatSync, unlinkSync } from 'fs';
import { promisify } from 'util';
import { getSetting } from './settings.js';
import { installDefaultAgents } from '../data/default-agents.js';

const execFileAsync = promisify(execFile);

/* ================================================================
   Ruflo deprecation helpers
   ================================================================ */

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


/**
 * Strip ruflo-managed hooks from .claude/settings.json while preserving user config.
 * Returns list of removed hook descriptions for logging.
 */
function stripRufloHooks(projectPath: string): string[] {
  const settingsPath = join(projectPath, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return [];
  try {
    const raw = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.hooks) return [];
    const removed: string[] = [];
    for (const [hookType, entries] of Object.entries(parsed.hooks) as [string, any[]][]) {
      if (!Array.isArray(entries)) continue;
      parsed.hooks[hookType] = entries.filter((entry: any) => {
        const hooks = entry.hooks || [];
        // Check both command content AND matcher for ruflo/devcortex references
        const matcherStr = (entry.matcher || '').toLowerCase();
        const isMatcherRuflo = matcherStr.includes('devcortex') ||
          matcherStr.includes('ruflo') ||
          matcherStr.includes('claude-flow') ||
          matcherStr.includes('hive-mind') ||
          matcherStr.includes('hive_mind');
        const isRuflo = isMatcherRuflo || hooks.some((h: any) =>
          h.command && (
            h.command.includes('ruflo') ||
            h.command.includes('claude-flow') ||
            h.command.includes('hook-handler.cjs') ||
            h.command.includes('devcortex') ||
            h.command.includes('.hivecommand') ||
            h.command.includes('sona') ||
            h.command.includes('hive-cleanup') ||
            h.command.includes('memory-sync') ||
            h.command.includes('auto-memory') ||
            h.command.includes('debate-gate') ||
            h.command.includes('graph-state') ||
            h.command.includes('intelligence-hook') ||
            h.command.includes('ranked-context')
          )
        );
        if (isRuflo) {
          removed.push(`${hookType}: ${entry.matcher || '(all)'}`);
        }
        return !isRuflo;
      });
      // Remove empty arrays
      if (parsed.hooks[hookType].length === 0) {
        delete parsed.hooks[hookType];
      }
    }
    if (Object.keys(parsed.hooks).length === 0) {
      delete parsed.hooks;
    }
    if (removed.length > 0) {
      writeFileSync(settingsPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
    }
    return removed;
  } catch {
    return [];
  }
}

/**
 * Remove ruflo/devcortex artifacts from a single project.
 * Returns a list of cleaned items for logging.
 */
async function cleanRufloFromProject(projectPath: string): Promise<string[]> {
  const cleaned: string[] = [];

  // Backup and remove .claude/settings.json (ruflo polluted it with hooks)
  // Leave the rest of .claude/ intact — rules, skills, agents, commands are user content
  const claudeSettings = join(projectPath, '.claude', 'settings.json');
  if (existsSync(claudeSettings)) {
    try {
      await copyFile(claudeSettings, join(projectPath, '.claude', 'settings.json.pre-cleanup-backup'));
      await unlink(claudeSettings);
      cleaned.push('backed up and removed .claude/settings.json');
    } catch { /* non-fatal */ }
  }

  // Nuke all ruflo/claude-flow directories (.swarm/ is kept — used by octoally-swarm)
  const dirsToRemove = [
    '.claude-flow',
    '.codex',
    '.devcortex-cli',
    '.hive-mind',
    '.ruflo',
  ];
  for (const dir of dirsToRemove) {
    const fullPath = join(projectPath, dir);
    if (existsSync(fullPath)) {
      try {
        await rm(fullPath, { recursive: true, force: true });
        cleaned.push(`removed ${dir}/`);
      } catch { /* non-fatal */ }
    }
  }

  // Remove all ruflo-related files
  const filesToRemove = [
    'CLAUDE.md',
    'AGENTS.md',
    '.devcortex',
    'claude-flow.config.json',
    '.mcp.json',
    'hooks/on-tool-use.sh',
    'ruvector.db',
    '.claude/helpers/hook-handler.cjs',
    '.claude/helpers/learning-service.mjs',
    '.claude/helpers/learning-hooks.sh',
    '.claude/helpers/sona-bridge.cjs',
    '.claude/helpers/intelligence.cjs',
  ];
  for (const file of filesToRemove) {
    const fullPath = join(projectPath, file);
    if (existsSync(fullPath)) {
      try {
        await unlink(fullPath);
        cleaned.push(`removed ${file}`);
      } catch { /* non-fatal */ }
    }
  }

  // Remove hooks/ directory if empty (not a standard folder — was added by OctoAlly)
  const hooksDir = join(projectPath, 'hooks');
  if (existsSync(hooksDir)) {
    try {
      const remaining = readdirSync(hooksDir);
      if (remaining.length === 0) {
        await rm(hooksDir, { recursive: true });
        cleaned.push('removed empty hooks/');
      }
    } catch { /* non-fatal */ }
  }

  // Deregister ruflo/devcortex/claude-flow MCP servers (idempotent)
  for (const server of ['ruflo', 'devcortex', 'claude-flow']) {
    try {
      await execFileAsync('claude', ['mcp', 'remove', server], {
        cwd: projectPath,
        timeout: 15_000,
      });
      cleaned.push(`deregistered ${server} MCP server`);
    } catch { /* already removed or CLI not found */ }
  }

  return cleaned;
}

/** Check if ruflo/claude-flow artifacts exist at a project path. */
function hasRufloArtifacts(projectPath: string): boolean {
  if (existsSync(join(projectPath, '.claude-flow')) ||
    existsSync(join(projectPath, '.ruflo')) ||
    existsSync(join(projectPath, '.hive-mind')) ||
    existsSync(join(projectPath, '.devcortex-cli'))) return true;

  // Check CLAUDE.md for ruflo markers
  try {
    const content = readFileSync(join(projectPath, 'CLAUDE.md'), 'utf-8');
    if (content.includes('RuFlo') || content.includes('claude-flow') ||
      content.includes('Swarm Orchestration') || content.includes('hive-mind')) return true;
  } catch { /* file doesn't exist */ }

  // Check .claude/settings.json for claude-flow references
  try {
    const content = readFileSync(join(projectPath, '.claude', 'settings.json'), 'utf-8');
    if (content.includes('claude-flow') || content.includes('ruflo') ||
      content.includes('claudeFlow')) return true;
  } catch { /* file doesn't exist */ }

  return false;
}


export interface Project {
  id: string;
  name: string;
  path: string;
  description: string | null;
  session_prompt: string | null;
  openclaw_prompt: string | null;
  default_web_url: string | null;
  skip_permissions: number;
  color: string;
  created_at: string;
  updated_at: string;
}

/** ~/.octoally/projects.json — portable backup, not the source of truth */
const OCTOALLY_DIR = join(homedir(), '.octoally');
const PROJECTS_FILE = join(OCTOALLY_DIR, 'projects.json');

/** Export current DB projects to the config file (for portability across DB resets) */
async function exportToConfig(): Promise<void> {
  const db = getDb();
  const rows = db.prepare('SELECT name, path, description, session_prompt, openclaw_prompt, default_web_url FROM projects ORDER BY name COLLATE NOCASE').all();
  await mkdir(OCTOALLY_DIR, { recursive: true });
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
      db.prepare('INSERT INTO projects (id, name, path, description, session_prompt, openclaw_prompt, default_web_url) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, p.name, p.path, p.description || null, p.session_prompt || null, p.openclaw_prompt || null, p.default_web_url || null);
      imported++;
    }
    if (imported > 0) {
      console.log(`  Imported ${imported} projects from ~/.octoally/projects.json`);
    }
  } catch {
    // No config file — that's fine, new user starts with empty projects
  }
}

async function ensureMcpJson(projectPath: string): Promise<string | null> {
  const mcpJsonPath = join(projectPath, '.mcp.json');
  if (existsSync(mcpJsonPath)) return null;

  const mcpConfig = {
    mcpServers: {
      ruflo: {
        command: 'npx',
        args: ['-y', '@claude-flow/cli@latest', 'mcp', 'start'],
        env: {
          npm_config_update_notifier: 'false',
          CLAUDE_FLOW_MODE: 'v3',
          CLAUDE_FLOW_TOPOLOGY: 'hierarchical',
          CLAUDE_FLOW_MAX_AGENTS: '4',
          CLAUDE_FLOW_MEMORY_BACKEND: 'local',
        },
        autoStart: false,
      },
    },
  };

  try {
    await mkdir(projectPath, { recursive: true });
    await writeFile(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf-8');
    return mcpJsonPath;
  } catch {
    return null;
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
    Body: { name: string; path: string; description?: string; session_prompt?: string; openclaw_prompt?: string; default_web_url?: string; color?: string };
  }>('/projects', async (req, reply) => {
    const { name, path, description, session_prompt, openclaw_prompt, default_web_url, color } = req.body;
    if (!name || !path) return reply.status(400).send({ error: 'name and path are required' });

    const db = getDb();
    const id = nanoid(12);

    const existing = db.prepare('SELECT id FROM projects WHERE path = ?').get(path);
    if (existing) return reply.status(409).send({ error: 'Project with this path already exists' });

    db.prepare('INSERT INTO projects (id, name, path, description, session_prompt, openclaw_prompt, default_web_url, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, path, description || null, session_prompt || null, openclaw_prompt || null, default_web_url || null, color || '');

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    await exportToConfig();
    const mcpPlaced = await ensureMcpJson(path);

    // Ensure default agents are installed (no-op if marker exists)
    try { installDefaultAgents(); } catch { /* non-fatal */ }

    return { ok: true, project };
  });

  // Update project
  app.patch<{
    Params: { id: string };
    Body: { name?: string; path?: string; description?: string; session_prompt?: string | null; openclaw_prompt?: string | null; default_web_url?: string | null; skip_permissions?: number; color?: string };
  }>('/projects/:id', async (req, reply) => {
    const db = getDb();
    const updates: string[] = [];
    const params: unknown[] = [];

    if (req.body.name) { updates.push('name = ?'); params.push(req.body.name); }
    if (req.body.path !== undefined) {
      const newPath = resolve(req.body.path);
      if (!existsSync(newPath)) return reply.status(400).send({ error: `Path does not exist: ${newPath}` });
      const dup = db.prepare('SELECT id FROM projects WHERE path = ? AND id != ?').get(newPath, req.params.id) as { id: string } | undefined;
      if (dup) return reply.status(409).send({ error: 'Another project already uses this path' });
      updates.push('path = ?'); params.push(newPath);
    }
    if (req.body.description !== undefined) { updates.push('description = ?'); params.push(req.body.description); }
    if (req.body.session_prompt !== undefined) { updates.push('session_prompt = ?'); params.push(req.body.session_prompt); }
    if (req.body.openclaw_prompt !== undefined) { updates.push('openclaw_prompt = ?'); params.push(req.body.openclaw_prompt); }
    if (req.body.default_web_url !== undefined) { updates.push('default_web_url = ?'); params.push(req.body.default_web_url); }
    if (req.body.skip_permissions !== undefined) { updates.push('skip_permissions = ?'); params.push(req.body.skip_permissions ? 1 : 0); }
    if (req.body.color !== undefined) { updates.push('color = ?'); params.push(req.body.color); }

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

  // Uninstall ruflo/devcortex from a single project
  app.post<{
    Params: { id: string };
  }>('/projects/:id/ruflo-uninstall', async (req, reply) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Project | undefined;
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    const cleaned = await cleanRufloFromProject(project.path);
    return { ok: true, cleaned };
  });

  // Bulk uninstall ruflo/devcortex from ALL projects + global cleanup
  app.post('/projects/ruflo-uninstall-all', async () => {
    const db = getDb();
    const projects = db.prepare('SELECT id, path FROM projects').all() as { id: string; path: string }[];

    let projectsCleaned = 0;
    const globalCleaned: string[] = [];

    // Clean each project
    for (const p of projects) {
      const result = await cleanRufloFromProject(p.path);
      if (result.length > 0) projectsCleaned++;
    }

    // Remove broken symlinks in ~/.octoally/ (leftover from hivecommand migration)
    const octoallyDir = join(homedir(), '.octoally');
    try {
      for (const entry of readdirSync(octoallyDir)) {
        const full = join(octoallyDir, entry);
        try {
          const stat = lstatSync(full);
          if (stat.isSymbolicLink() && !existsSync(full)) {
            unlinkSync(full);
            globalCleaned.push(`removed broken symlink ${entry}`);
          }
        } catch { /* skip */ }
      }
    } catch { /* non-fatal */ }

    // Global cleanup
    const globalDirs = [
      join(homedir(), '.octoally', 'ruflo'),
      join(homedir(), '.hivecommand'),
      join(homedir(), '.config', 'devcortex'),
    ];
    for (const dir of globalDirs) {
      if (existsSync(dir)) {
        try {
          await rm(dir, { recursive: true, force: true });
          globalCleaned.push(`removed ${dir}`);
        } catch { /* non-fatal */ }
      }
    }

    // Global files
    const globalFiles = [
      join(homedir(), '.octoally', 'ruflo-run.sh'),
      join(homedir(), '.hivecommand', 'ruflo-run.sh'),
    ];
    for (const file of globalFiles) {
      if (existsSync(file)) {
        try {
          await unlink(file);
          globalCleaned.push(`removed ${file}`);
        } catch { /* non-fatal */ }
      }
    }

    // Remove ruflo-generated global CLAUDE.md files
    const globalClaudeMdFiles = [
      join(homedir(), 'CLAUDE.md'),
      join(homedir(), '.claude', 'CLAUDE.md'),
    ];
    for (const file of globalClaudeMdFiles) {
      if (existsSync(file)) {
        try {
          const content = readFileSync(file, 'utf-8');
          if (content.includes('ruflo') || content.includes('CLAUDE-FLOW') || content.includes('claude-flow') || content.includes('RuFlo')) {
            await unlink(file);
            globalCleaned.push(`removed ${file}`);
          }
        } catch { /* non-fatal */ }
      }
    }

    // Deregister ruflo/devcortex MCP globally
    try {
      await execFileAsync('claude', ['mcp', 'remove', 'ruflo'], { timeout: 15_000 });
      globalCleaned.push('deregistered ruflo MCP (global)');
    } catch { /* already removed */ }
    try {
      await execFileAsync('claude', ['mcp', 'remove', 'devcortex'], { timeout: 15_000 });
      globalCleaned.push('deregistered devcortex MCP (global)');
    } catch { /* already removed */ }

    // Reset session commands to plain defaults
    const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    upsert.run('session_claude_command', 'claude');
    upsert.run('session_codex_command', 'codex');
    upsert.run('agent_claude_command', 'claude');
    upsert.run('agent_codex_command', 'codex');
    // Clean any stale old-named keys
    db.prepare('DELETE FROM settings WHERE key IN (?, ?, ?)').run('ruflo_command', 'hivemind_claude_command', 'hivemind_codex_command');

    // Update disposition to 'removed'
    upsert.run('ruflo_disposition', 'removed');

    // Re-install default agents (ruflo cleanup may have deleted .claude/agents/)
    try {
      const { installed } = installDefaultAgents(true);
      if (installed.length > 0) globalCleaned.push(`installed ${installed.length} default agent(s)`);
    } catch { /* non-fatal */ }

    return { ok: true, projectsCleaned, globalCleaned };
  });

  // Set skip_permissions for all projects at once
  app.put<{
    Body: { skip_permissions: boolean };
  }>('/projects/skip-permissions-all', async (req, reply) => {
    const db = getDb();
    const val = req.body.skip_permissions ? 1 : 0;
    const result = db.prepare('UPDATE projects SET skip_permissions = ?, updated_at = datetime(\'now\')').run(val);
    return { ok: true, updated: result.changes };
  });

  // Get ruflo disposition and detection status
  app.get('/projects/ruflo-disposition', async () => {
    const disposition = getSetting('ruflo_disposition');
    const db = getDb();
    const projects = db.prepare('SELECT path FROM projects').all() as { path: string }[];

    let rufloDetected = false;
    for (const p of projects) {
      if (hasRufloArtifacts(p.path)) {
        rufloDetected = true;
        break;
      }
    }

    return { disposition, rufloDetected };
  });

  // Set ruflo disposition
  app.put<{
    Body: { disposition: string };
  }>('/projects/ruflo-disposition', async (req, reply) => {
    const { disposition } = req.body as any;
    if (!['undecided', 'keep', 'remove_all', 'removed'].includes(disposition)) {
      return reply.status(400).send({ error: 'Invalid disposition. Must be: undecided, keep, remove_all, removed' });
    }
    const db = getDb();
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('ruflo_disposition', disposition);
    return { ok: true, disposition };
  });

  // List available agent types for a project (reads .claude/agents/*.md from project + global)
  app.get<{
    Params: { id: string };
  }>('/projects/:id/ruflo-agents', async (req, reply) => {
    const db = getDb();
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Project | undefined;
    if (!project) return reply.status(404).send({ error: 'Project not found' });

    const agents: { name: string; type: string; description: string; category: string }[] = [];

    const walkDir = async (dir: string, category: string) => {
      if (!existsSync(dir)) return;
      try {
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
      } catch {}
    };

    // Scan both global and project-level agent directories
    await walkDir(join(homedir(), '.claude', 'agents'), 'global');
    await walkDir(join(project.path, '.claude', 'agents'), 'project');

    // Deduplicate by name (project-level overrides global)
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
        eligible: globalInstalled,
        version,
      };
    }

    return { globalInstalled, statuses };
  });

  // DEPRECATED: DevCortex install — no longer supported
  app.post<{
    Params: { id: string };
  }>('/projects/:id/devcortex-install', async (_req, reply) => {
    return reply.status(410).send({ error: 'DevCortex installation has been deprecated.' });
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
