import { FastifyPluginAsync } from 'fastify';
import { getDb } from '../db/index.js';
import { nanoid } from 'nanoid';
import { readdir, mkdir, readFile, writeFile } from 'fs/promises';
import { join, resolve, basename } from 'path';
import { homedir } from 'os';
import { execFile, execFileSync } from 'child_process';
import { existsSync, statSync, readFileSync, writeFileSync } from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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

/** ~/.openflow/projects.json — portable backup, not the source of truth */
const OPENFLOW_DIR = join(homedir(), '.openflow');
const PROJECTS_FILE = join(OPENFLOW_DIR, 'projects.json');

/** Export current DB projects to the config file (for portability across DB resets) */
async function exportToConfig(): Promise<void> {
  const db = getDb();
  const rows = db.prepare('SELECT name, path, description, ruflo_prompt, openclaw_prompt, default_web_url FROM projects ORDER BY name COLLATE NOCASE').all();
  await mkdir(OPENFLOW_DIR, { recursive: true });
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
      console.log(`  Imported ${imported} projects from ~/.openflow/projects.json`);
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
    // Nullify foreign key references before deleting (sessions/tasks may reference this project)
    db.prepare('UPDATE sessions SET project_id = NULL WHERE project_id = ?').run(req.params.id);
    db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').run(req.params.id);
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
    const opts = { cwd: project.path, timeout: 180_000 };
    const output: string[] = [];

    // Create .bak copies before init overwrites them
    const backed = backupRufloConflicts(project.path);
    if (backed.length > 0) {
      output.push(`[backup] ${backed.length} file(s) backed up`);
      for (const b of backed) output.push(`  → ${b}`);
    }

    try {
      const result = await execFileAsync(npx, ['ruflo@latest', 'init', '--force', '--start-all'], opts);
      output.push('[ruflo init] ' + (result.stdout || 'done'));
    } catch (err: any) {
      output.push('[error] ' + (err.message || String(err)));
      return reply.status(500).send({ ok: false, output: output.join('\n'), error: err.message });
    }

    // Initialize hive-mind (ruflo init doesn't do this automatically)
    try {
      const hmResult = await execFileAsync(npx, ['ruflo@latest', 'hive-mind', 'init'], opts);
      output.push('[hive-mind init] ' + (hmResult.stdout || 'done'));
    } catch (err: any) {
      output.push('[hive-mind init] ' + (err.message || 'skipped'));
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
