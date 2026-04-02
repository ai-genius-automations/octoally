/**
 * Enrich process.env.PATH with node binary directories from version managers.
 *
 * Desktop-launched processes (task manager, dock, app menu) inherit the bare
 * session environment which lacks nvm/fnm/volta PATH entries that interactive
 * shells load via .bashrc/.zshrc. This causes spawned processes (PTY sessions,
 * agents, npx calls) to fail because `node`/`npx` are not found.
 *
 * Call once at server startup — all child processes inherit the enriched PATH.
 */

import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function discoverNodeDirs(): string[] {
  const home = homedir();
  const dirs: string[] = [];

  // nvm: pick the highest installed version
  const nvmDir = process.env.NVM_DIR || join(home, '.nvm');
  const nvmVersionsDir = join(nvmDir, 'versions', 'node');
  if (existsSync(nvmVersionsDir)) {
    try {
      const versions = readdirSync(nvmVersionsDir)
        .filter((d) => d.startsWith('v'))
        .sort((a, b) => {
          const pa = a.slice(1).split('.').map(Number);
          const pb = b.slice(1).split('.').map(Number);
          for (let i = 0; i < 3; i++) {
            if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
          }
          return 0;
        });
      if (versions.length > 0) {
        dirs.push(join(nvmVersionsDir, versions[versions.length - 1], 'bin'));
      }
    } catch {}
  }

  // fnm (Fast Node Manager)
  const fnmDir = join(home, '.local', 'share', 'fnm', 'node-versions');
  if (existsSync(fnmDir)) {
    try {
      const versions = readdirSync(fnmDir).filter((d) => d.startsWith('v')).sort();
      if (versions.length > 0) {
        dirs.push(join(fnmDir, versions[versions.length - 1], 'installation', 'bin'));
      }
    } catch {}
  }

  // volta
  const voltaBin = join(home, '.volta', 'bin');
  if (existsSync(voltaBin)) {
    dirs.push(voltaBin);
  }

  // Common system paths that may be missing from desktop sessions
  for (const p of ['/usr/local/bin', join(home, '.local', 'bin')]) {
    if (existsSync(p)) dirs.push(p);
  }

  return dirs;
}

export function enrichProcessPath(): void {
  const currentPath = process.env.PATH || '';
  const pathSet = new Set(currentPath.split(':'));
  const toAdd = discoverNodeDirs().filter((d) => !pathSet.has(d));

  if (toAdd.length > 0) {
    process.env.PATH = [...toAdd, currentPath].join(':');
  }
}
