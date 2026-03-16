import type { FastifyPluginAsync } from 'fastify';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { getDb } from '../db/index.js';

/**
 * Shared ruflo-run.sh location: ~/.hivecommand/ruflo-run.sh
 * Created/updated by the DevCortex installer. Keeps a local ruflo install
 * at ~/.hivecommand/ruflo/ and only downloads when a newer version exists.
 * Falls back to npx if the script doesn't exist (no DevCortex installed).
 */
const RUFLO_RUN = join(homedir(), '.hivecommand', 'ruflo-run.sh');
const RUFLO_CMD = existsSync(RUFLO_RUN) ? `bash ${RUFLO_RUN}` : 'npx ruflo@latest';

/** Default values for all settings */
const DEFAULTS: Record<string, string> = {
  ruflo_command: RUFLO_CMD,
};

export function getSetting(key: string): string {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? DEFAULTS[key] ?? '';
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  // Get all settings
  app.get('/settings', async () => {
    const db = getDb();
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const settings: Record<string, string> = { ...DEFAULTS };
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    return { settings };
  });

  // Update settings
  app.put<{
    Body: { settings: Record<string, string> };
  }>('/settings', async (req, reply) => {
    const { settings } = req.body;
    if (!settings || typeof settings !== 'object') {
      return reply.status(400).send({ error: 'settings object is required' });
    }

    const db = getDb();
    const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

    const allowed = new Set(Object.keys(DEFAULTS));
    for (const [key, value] of Object.entries(settings)) {
      if (!allowed.has(key)) continue;
      upsert.run(key, String(value));
    }

    // Return current state
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const current: Record<string, string> = { ...DEFAULTS };
    for (const row of rows) {
      current[row.key] = row.value;
    }
    return { ok: true, settings: current };
  });
};
