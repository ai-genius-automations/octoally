import dotenv from 'dotenv';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync, renameSync } from 'fs';
dotenv.config();

// Migrate from OpenFlow → OctoAlly or HiveCommand → OctoAlly (one-time, on first run after rename)
(() => {
  const oldOpenflowDir = join(homedir(), '.openflow');
  const oldHivecommandDir = join(homedir(), '.hivecommand');
  const newDir = join(homedir(), '.octoally');

  // First try ~/.openflow → ~/.octoally
  if (existsSync(oldOpenflowDir) && !existsSync(newDir)) {
    try {
      renameSync(oldOpenflowDir, newDir);
      console.log(`[MIGRATE] Renamed ~/.openflow → ~/.octoally`);
    } catch (err) {
      console.warn(`[MIGRATE] Could not rename ~/.openflow → ~/.octoally:`, err);
    }
  }
  // Then try ~/.hivecommand → ~/.octoally
  if (existsSync(oldHivecommandDir) && !existsSync(newDir)) {
    try {
      renameSync(oldHivecommandDir, newDir);
      console.log(`[MIGRATE] Renamed ~/.hivecommand → ~/.octoally`);
    } catch (err) {
      console.warn(`[MIGRATE] Could not rename ~/.hivecommand → ~/.octoally:`, err);
    }
  }
  if (existsSync(newDir)) {
    // Migrate openflow.db → octoally.db
    const oldOpenflowDb = join(newDir, 'openflow.db');
    const newDb = join(newDir, 'octoally.db');
    if (existsSync(oldOpenflowDb) && !existsSync(newDb)) {
      try {
        renameSync(oldOpenflowDb, newDb);
        for (const suffix of ['-wal', '-shm']) {
          const oldF = oldOpenflowDb + suffix;
          const newF = newDb + suffix;
          if (existsSync(oldF)) renameSync(oldF, newF);
        }
        console.log(`[MIGRATE] Renamed openflow.db → octoally.db`);
      } catch (err) {
        console.warn(`[MIGRATE] Could not rename openflow.db:`, err);
      }
    }
    // Migrate hivecommand.db → octoally.db
    const oldHivecommandDb = join(newDir, 'hivecommand.db');
    if (existsSync(oldHivecommandDb) && !existsSync(newDb)) {
      try {
        renameSync(oldHivecommandDb, newDb);
        for (const suffix of ['-wal', '-shm']) {
          const oldF = oldHivecommandDb + suffix;
          const newF = newDb + suffix;
          if (existsSync(oldF)) renameSync(oldF, newF);
        }
        console.log(`[MIGRATE] Renamed hivecommand.db → octoally.db`);
      } catch (err) {
        console.warn(`[MIGRATE] Could not rename hivecommand.db:`, err);
      }
    }
  }
})();

/** Check whether a binary is installed and usable */
function binaryAvailable(name: string): boolean {
  try {
    execFileSync(name, ['--help'], { stdio: 'ignore' });
    return true;
  } catch {
    // --help may exit non-zero but the binary exists
    try {
      execFileSync('which', [name], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

const wantDtach = (process.env.OCTOALLY_USE_DTACH || process.env.HIVECOMMAND_USE_DTACH) !== 'false';
const hasDtach = binaryAvailable('dtach');
const wantTmux = (process.env.OCTOALLY_USE_TMUX || process.env.HIVECOMMAND_USE_TMUX) !== 'false';
const hasTmux = binaryAvailable('tmux');

if (wantDtach && !hasDtach) {
  console.warn('  dtach not found — falling back to direct mode. Install with: sudo apt install dtach');
}
if (wantTmux && !hasTmux) {
  console.warn('  tmux not found — plain terminals will use dtach/direct mode. Install with: sudo apt install tmux');
}

export const config = {
  port: parseInt(process.env.PORT || '42010', 10),
  // Listen on loopback only — the API is unauthenticated. 'localhost' binds
  // both 127.0.0.1 and ::1 (see index.ts), which still lets the browser use
  // 127.0.0.1 and [::1] as separate hosts, doubling the per-host connection
  // limit (6→12) and preventing WebSocket connection queuing when many
  // terminals are open. Set HOST to override (e.g. 0.0.0.0 exposes the API).
  host: process.env.HOST || 'localhost',
  isDev: process.env.NODE_ENV !== 'production',
  logLevel: process.env.LOG_LEVEL || 'info',
  dbPath: process.env.DB_PATH || (() => {
    const dir = join(homedir(), '.octoally');
    mkdirSync(dir, { recursive: true });
    return join(dir, 'octoally.db');
  })(),
  /** Use dtach to persist sessions across server restarts. Enabled by default, set OCTOALLY_USE_DTACH=false to disable. */
  useDtach: wantDtach && hasDtach,
  /** Use tmux for plain terminal sessions. Provides proper resize/reflow handling
   *  and scrollback preservation. Enabled by default, set OCTOALLY_USE_TMUX=false to disable. */
  useTmux: wantTmux && hasTmux,
};
