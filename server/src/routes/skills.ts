import type { FastifyPluginAsync } from 'fastify';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';

export interface SkillItem {
  id: string;
  name: string;
  category: string;
  command: string;
  scope: 'global' | 'project';
  description?: string;
}

export function scanSkillsDir(dir: string, scope: 'global' | 'project'): SkillItem[] {
  const skills: SkillItem[] = [];
  if (!existsSync(dir)) return skills;

  function walk(currentDir: string, categoryPath: string) {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // Skip hidden directories
        if (entry.name.startsWith('.')) continue;
        const nested = categoryPath === 'root' ? entry.name : `${categoryPath}:${entry.name}`;
        walk(join(currentDir, entry.name), nested);
      } else if (entry.name.endsWith('.md')) {
        const name = entry.name.replace(/\.md$/, '');
        const category = categoryPath;
        const id = category === 'root' ? name : `${category}:${name}`;
        // Read first non-empty, non-frontmatter line as description
        let description: string | undefined;
        try {
          const content = readFileSync(join(currentDir, entry.name), 'utf-8');
          const lines = content.split('\n');
          let inFrontmatter = false;
          for (const line of lines) {
            if (line.trim() === '---') { inFrontmatter = !inFrontmatter; continue; }
            if (inFrontmatter) continue;
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
              description = trimmed.slice(0, 120);
              break;
            }
          }
        } catch {}
        skills.push({
          id,
          name,
          category: category === 'root' ? 'general' : category,
          command: `/${id}`,
          scope,
          description,
        });
      }
    }
  }

  walk(dir, 'root');
  return skills;
}

export const skillsRoutes: FastifyPluginAsync = async (app) => {
  // GET /skills — returns all available skills
  app.get('/skills', async (req) => {
    const projectPath = (req.query as Record<string, string>).project_path;

    // User-level skills
    const userDir = join(homedir(), '.claude', 'commands');
    const skills = scanSkillsDir(userDir, 'global');

    // Project-level skills (if project_path provided, with path traversal protection)
    if (projectPath) {
      const resolved = resolve(projectPath);
      if (projectPath === resolved && existsSync(resolved) && statSync(resolved).isDirectory()) {
        const projectDir = join(resolved, '.claude', 'commands');
        skills.push(...scanSkillsDir(projectDir, 'project'));
      }
    }

    // Sort: project skills first, then alphabetically by category and name
    skills.sort((a, b) => {
      if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1;
      if (a.category !== b.category) return a.category.localeCompare(b.category);
      return a.name.localeCompare(b.name);
    });

    // Derive categories
    const categories = [...new Set(skills.map(s => s.category))].sort();

    return { skills, categories, total: skills.length };
  });

  // GET /system/status — returns system features and integrations
  app.get('/system/status', async () => {
    const features = [];
    const integrations = [];

    const nexusRoot = process.env.ALETHEIA_NEXUS_PATH || '/home/hemang/ALETHEIA-NEXUS';

    // Check RAG status
    const ragStore = `${nexusRoot}/config/rag_store`;
    features.push({
      id: 'local-rag',
      name: 'Local RAG',
      description: 'LanceDB + Ollama embeddings (849 chunks)',
      enabled: existsSync(ragStore),
      status: existsSync(ragStore) ? 'ok' : 'error',
      details: { store: ragStore },
    });

    // Check SmartRouter
    const routerDb = `${nexusRoot}/config/router_telemetry.db`;
    features.push({
      id: 'smart-router',
      name: 'Smart Router',
      description: 'Dual-model routing with telemetry',
      enabled: true,
      status: existsSync(routerDb) ? 'ok' : 'degraded',
      details: { telemetry: routerDb },
    });

    // Check Ollama
    integrations.push({
      id: 'ollama',
      name: 'Ollama',
      connected: false, // Will be checked client-side or via health endpoint
      status: 'unknown' as const,
      details: { url: 'http://127.0.0.1:11434' },
    });

    // Check Gemini CLI
    const geminiDispatch = `${nexusRoot}/scripts/gemini_dispatch.sh`;
    integrations.push({
      id: 'gemini-cli',
      name: 'Gemini CLI',
      connected: existsSync(geminiDispatch),
      status: existsSync(geminiDispatch) ? 'ok' : 'error',
      details: { script: geminiDispatch },
    });

    // Check ALETHEIA-NEXUS
    integrations.push({
      id: 'aletheia-nexus',
      name: 'ALETHEIA-NEXUS',
      connected: existsSync(join(nexusRoot, '.venv', 'bin', 'python')),
      status: existsSync(join(nexusRoot, '.venv', 'bin', 'python')) ? 'ok' : 'error',
      details: { path: nexusRoot },
    });

    return { features, integrations };
  });
};
