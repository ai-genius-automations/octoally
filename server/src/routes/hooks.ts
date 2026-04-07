import type { FastifyPluginAsync } from 'fastify';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { config } from '../config.js';
import { insertEvent } from '../services/event-store.js';

const OCTOALLY_HOOK_MARKER = '# octoally-events-hook';
const LEGACY_HOOK_MARKER = '# hivecommand-events-hook';

/**
 * Build the inline hook command that POSTs tool use events to OctoAlly.
 * Claude Code passes hook data as JSON on stdin. Capture it to a temp file,
 * then hand off a bounded background Node process so the hook itself exits fast.
 */
function buildHookCommand(projectPath: string): string {
  const port = config.port || 42010;
  const url = `http://localhost:${port}/api/events`;
  const escapedPath = projectPath.replace(/"/g, '\\"');
  const nodeScript = [
    "const fs=require('fs');",
    "const http=require('http');",
    "const https=require('https');",
    "try{",
    "const raw=fs.readFileSync(process.argv[1],'utf8');",
    "const input=raw?JSON.parse(raw):{};",
    "const body=JSON.stringify({",
    "type:'tool_use',",
    "tool_name:input.tool_name||'',",
    "session_id:input.session_id||'',",
    "project_path:process.argv[2],",
    "data:{",
    "tool:input.tool_name||'',",
    "session:input.session_id||'',",
    "file_path:input.tool_input?.file_path||input.tool_input?.path||'',",
    "command:input.tool_input?.command||'',",
    "pattern:input.tool_input?.pattern||'',",
    "description:input.tool_input?.description||''",
    "}",
    "});",
    "const target=new URL(process.argv[3]);",
    "const mod=target.protocol==='https:'?https:http;",
    "const req=mod.request(target,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},timeout:1500},res=>res.resume());",
    "req.on('error',()=>{});",
    "req.on('timeout',()=>req.destroy());",
    "req.end(body);",
    "}catch{}",
  ].join('');
  const escapedScript = nodeScript.replace(/["\\$`]/g, '\\$&');
  return `TMP=$(mktemp "\${TMPDIR:-/tmp}/octoally-hook.XXXXXX"); cat > "$TMP"; (node -e "${escapedScript}" "$TMP" "${escapedPath}" "${url}" >/dev/null 2>&1 || true; rm -f "$TMP") </dev/null >/dev/null 2>&1 & ${OCTOALLY_HOOK_MARKER}`;
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
    entry.hooks?.some((h) => h.command?.includes(OCTOALLY_HOOK_MARKER) || h.command?.includes(LEGACY_HOOK_MARKER))
  );
}

function installHook(settings: ClaudeSettings, projectPath: string): ClaudeSettings {
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];

  // Replace any existing OctoAlly/HiveCommand hook so installs upgrade stale commands.
  settings = uninstallHook(settings);
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];

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
    (entry) => !entry.hooks?.some((h) => h.command?.includes(OCTOALLY_HOOK_MARKER) || h.command?.includes(LEGACY_HOOK_MARKER))
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

// ─── Notification Hook Types ──────────────────────────────────
// 6 core notification hooks for system-wide event observation.

export type NotificationHookType =
  | 'rate_limit'       // Fired when API rate limit hit (429)
  | 'budget_warn'      // Fired when budget threshold crossed
  | 'session_complete' // Fired when a session finishes
  | 'tool_denied'      // Fired when a tool is denied by permission system
  | 'error_spike'      // Fired when error rate exceeds threshold
  | 'model_change';    // Fired when model changes mid-session

export interface NotificationHookRegistration {
  id: string;
  type: NotificationHookType;
  callback_url?: string;    // Optional webhook URL
  log_to_events: boolean;   // Whether to log to event store
  enabled: boolean;
  created_at: string;
}

export interface NotificationHookPayload {
  type: NotificationHookType;
  session_id?: string;
  detail: Record<string, unknown>;
  timestamp: string;
}

// In-memory hook registrations
const notificationHooks: Map<string, NotificationHookRegistration> = new Map();

const VALID_HOOK_TYPES: NotificationHookType[] = [
  'rate_limit', 'budget_warn', 'session_complete',
  'tool_denied', 'error_spike', 'model_change',
];

/**
 * Fire a notification hook. Iterates all registered hooks matching the type,
 * logs to event store if configured, and dispatches webhook if configured.
 * All webhook failures are non-fatal.
 */
export async function fireNotificationHook(payload: NotificationHookPayload): Promise<void> {
  for (const [, reg] of notificationHooks) {
    if (reg.type !== payload.type || !reg.enabled) continue;

    // Log to event store
    if (reg.log_to_events) {
      insertEvent({
        session_id: payload.session_id,
        type: `hook:${payload.type}`,
        data: payload.detail,
      });
    }

    // Fire webhook if configured
    if (reg.callback_url) {
      try {
        await fetch(reg.callback_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        // Webhook failures are non-fatal
      }
    }
  }
}

export const hooksRoutes: FastifyPluginAsync = async (app) => {
  // Check if the OctoAlly events hook is installed for a project
  app.get<{
    Querystring: { path: string };
  }>('/hooks/events-status', async (req, reply) => {
    const projectPath = req.query.path;
    if (!projectPath) return reply.status(400).send({ error: 'path is required' });

    const settings = await readSettings(projectPath);
    return { installed: isHookInstalled(settings) };
  });

  // Install or uninstall the OctoAlly events hook
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

  // ─── Notification Hook API Routes ───────────────────────────

  // List all notification hook registrations
  app.get('/hooks/notifications', async (_req, reply) => {
    const hooks = Array.from(notificationHooks.values());
    return reply.send({ ok: true, hooks });
  });

  // Register a new notification hook
  app.post<{
    Body: { type: NotificationHookType; callback_url?: string; log_to_events?: boolean };
  }>('/hooks/notifications/register', async (req, reply) => {
    const { type, callback_url, log_to_events } = req.body || {};

    if (!type || !VALID_HOOK_TYPES.includes(type)) {
      return reply.status(400).send({
        ok: false,
        error: `Invalid hook type. Valid: ${VALID_HOOK_TYPES.join(', ')}`,
      });
    }

    const id = `nhook_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const registration: NotificationHookRegistration = {
      id,
      type,
      callback_url,
      log_to_events: log_to_events !== false,
      enabled: true,
      created_at: new Date().toISOString(),
    };

    notificationHooks.set(id, registration);
    return reply.send({ ok: true, hook: registration });
  });

  // Enable/disable a notification hook
  app.patch<{
    Params: { id: string };
    Body: { enabled?: boolean };
  }>('/hooks/notifications/:id', async (req, reply) => {
    const reg = notificationHooks.get(req.params.id);
    if (!reg) {
      return reply.status(404).send({ ok: false, error: 'Hook not found' });
    }

    if (typeof req.body?.enabled === 'boolean') {
      reg.enabled = req.body.enabled;
    }

    return reply.send({ ok: true, hook: reg });
  });

  // Delete a notification hook
  app.delete<{
    Params: { id: string };
  }>('/hooks/notifications/:id', async (req, reply) => {
    if (notificationHooks.delete(req.params.id)) {
      return reply.send({ ok: true });
    }
    return reply.status(404).send({ ok: false, error: 'Hook not found' });
  });

  // Fire a notification hook manually (for testing)
  app.post<{
    Body: { type: NotificationHookType; session_id?: string; detail?: Record<string, unknown> };
  }>('/hooks/notifications/fire', async (req, reply) => {
    const { type, session_id, detail = {} } = req.body || {};

    if (!type || !VALID_HOOK_TYPES.includes(type)) {
      return reply.status(400).send({
        ok: false,
        error: `Invalid hook type. Valid: ${VALID_HOOK_TYPES.join(', ')}`,
      });
    }

    const payload: NotificationHookPayload = {
      type,
      session_id,
      detail,
      timestamp: new Date().toISOString(),
    };

    await fireNotificationHook(payload);
    return reply.send({ ok: true, fired: type });
  });
};
