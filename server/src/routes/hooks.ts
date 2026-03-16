import type { FastifyPluginAsync } from 'fastify';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { config } from '../config.js';

const HIVECOMMAND_HOOK_MARKER = '# hivecommand-events-hook';

/**
 * Build the inline hook command that POSTs tool use events to HiveCommand.
 * Claude Code passes hook data as JSON on stdin — we read it, extract fields,
 * and POST to the HiveCommand events API. Uses jq for lightweight JSON processing.
 * Falls back to sending raw stdin if jq is not available.
 */
function buildHookCommand(projectPath: string): string {
  const port = config.port || 42010;
  const url = `http://localhost:${port}/api/events`;
  // Read stdin JSON, extract tool_name and tool_input, build POST payload
  // jq constructs the payload; curl sends it. All in one pipeline, backgrounded.
  const escapedPath = projectPath.replace(/"/g, '\\"');
  return `INPUT=$(cat); echo "$INPUT" | jq -c '{type:"tool_use",tool_name:.tool_name,session_id:.session_id,project_path:"${escapedPath}",data:{tool:.tool_name,session:.session_id,file_path:(.tool_input.file_path // .tool_input.path // ""),command:(.tool_input.command // ""),pattern:(.tool_input.pattern // ""),description:(.tool_input.description // "")}}' 2>/dev/null | curl -s -X POST "${url}" -H "Content-Type: application/json" -d @- > /dev/null 2>&1 &  ${HIVECOMMAND_HOOK_MARKER}`;
}

interface ClaudeSettings {
  hooks?: {
    PostToolUse?: Array<{
      matcher?: string;
      hooks?: Array<{
        type: string;
        command: string;
        timeout?: number;
      }>;
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function getSettingsPath(projectPath: string): string {
  return join(projectPath, '.claude', 'settings.json');
}

async function readSettings(projectPath: string): Promise<ClaudeSettings> {
  try {
    const content = await readFile(getSettingsPath(projectPath), 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function saveSettings(projectPath: string, settings: ClaudeSettings): Promise<void> {
  const settingsPath = getSettingsPath(projectPath);
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

function isHookInstalled(settings: ClaudeSettings): boolean {
  const entries = settings.hooks?.PostToolUse || [];
  return entries.some((entry) =>
    entry.hooks?.some((h) => h.command?.includes(HIVECOMMAND_HOOK_MARKER))
  );
}

function installHook(settings: ClaudeSettings, projectPath: string): ClaudeSettings {
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];

  // Don't double-install
  if (isHookInstalled(settings)) return settings;

  settings.hooks.PostToolUse.push({
    hooks: [
      {
        type: 'command',
        command: buildHookCommand(projectPath),
        timeout: 5000,
      },
    ],
  });

  return settings;
}

function uninstallHook(settings: ClaudeSettings): ClaudeSettings {
  if (!settings.hooks?.PostToolUse) return settings;

  settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(
    (entry) => !entry.hooks?.some((h) => h.command?.includes(HIVECOMMAND_HOOK_MARKER))
  );

  // Clean up empty arrays
  if (settings.hooks.PostToolUse.length === 0) {
    delete settings.hooks.PostToolUse;
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  return settings;
}

export const hooksRoutes: FastifyPluginAsync = async (app) => {
  // Check if the HiveCommand events hook is installed for a project
  app.get<{
    Querystring: { path: string };
  }>('/hooks/events-status', async (req, reply) => {
    const projectPath = req.query.path;
    if (!projectPath) return reply.status(400).send({ error: 'path is required' });

    const settings = await readSettings(projectPath);
    return { installed: isHookInstalled(settings) };
  });

  // Install or uninstall the HiveCommand events hook
  app.post<{
    Body: { path: string; action: 'install' | 'uninstall' };
  }>('/hooks/events', async (req, reply) => {
    const { path: projectPath, action } = req.body || {};
    if (!projectPath) return reply.status(400).send({ error: 'path is required' });
    if (!action || !['install', 'uninstall'].includes(action)) {
      return reply.status(400).send({ error: 'action must be install or uninstall' });
    }

    let settings = await readSettings(projectPath);

    if (action === 'install') {
      settings = installHook(settings, projectPath);
    } else {
      settings = uninstallHook(settings);
    }

    await saveSettings(projectPath, settings);
    return { ok: true, installed: isHookInstalled(settings) };
  });
};
