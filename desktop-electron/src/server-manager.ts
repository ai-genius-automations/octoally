import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';

/** Resolve the hivecommand CLI path (mirrors Rust logic in desktop/src/main.rs) */
export function resolveCliPath(): string {
  // Try readlink -f on the standard install path
  try {
    const resolved = execFileSync('readlink', ['-f', '/usr/local/bin/hivecommand'], {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch {}

  // Fallback: check ~/.local/bin
  const home = process.env.HOME;
  if (home) {
    const localPath = path.join(home, '.local/bin/hivecommand');
    if (fs.existsSync(localPath)) return localPath;
  }

  // Last resort: rely on PATH
  return 'hivecommand';
}

/** Check if HiveCommand server is currently running */
export function isServerRunning(cli: string): boolean {
  try {
    const stdout = execFileSync(cli, ['status'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return stdout.includes('running');
  } catch (e: any) {
    // CLI may exit non-zero but still output status — check stdout/stderr
    const output = (e.stdout || '') + (e.stderr || '');
    if (output.includes('running')) return true;
    return false;
  }
}

/** Check if the server is reachable via HTTP */
export function isServerReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:42010/api/health', (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Start the server via CLI */
export function startServer(cli: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cli, ['start'], { timeout: 15000 }, (err) => {
      resolve(!err);
    });
  });
}

/** Stop the server via CLI */
export function stopServer(cli: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cli, ['stop'], { timeout: 10000 }, (err) => {
      resolve(!err);
    });
  });
}

/** Stop whatever process is listening on port 42010 (for external/unknown servers) */
export function stopServerOnPort(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('fuser', ['-k', '42010/tcp'], { timeout: 10000 }, (err) => {
      resolve(!err);
    });
  });
}

/** Wait for the server to become reachable, polling every 500ms */
export async function waitForServer(maxWaitMs = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isServerReachable()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Check if the systemd/launchd service is installed */
export function isServiceInstalled(): boolean {
  if (process.platform === 'linux') {
    return fs.existsSync('/etc/systemd/system/hivecommand.service');
  }
  if (process.platform === 'darwin') {
    const home = process.env.HOME;
    if (home) {
      return fs.existsSync(
        path.join(home, 'Library/LaunchAgents/com.aigenius.hivecommand.plist'),
      );
    }
  }
  return false;
}

/** Toggle service install/uninstall */
export function toggleService(cli: string): Promise<boolean> {
  const installed = isServiceInstalled();
  const cmd = installed ? 'uninstall-service' : 'install-service';

  return new Promise((resolve) => {
    if (process.platform === 'linux') {
      // Use pkexec for graphical sudo prompt (same as Tauri version)
      execFile('pkexec', [cli, cmd], { timeout: 30000 }, (err) => {
        resolve(!err);
      });
    } else {
      execFile(cli, [cmd], { timeout: 30000 }, (err) => {
        resolve(!err);
      });
    }
  });
}
