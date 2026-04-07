import { FastifyPluginAsync } from 'fastify';
import { readdir, stat, readFile, writeFile } from 'fs/promises';
import { join, resolve, extname } from 'path';
import { exec } from 'child_process';
import { getDb } from '../db/index.js';

interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  extension: string;
}

/**
 * Validate that a resolved path is within one of the registered project directories.
 * Returns true if the path is allowed, false if it's outside all project dirs.
 */
function isPathAllowed(resolvedPath: string): boolean {
  try {
    const db = getDb();
    const projects = db.prepare('SELECT path FROM projects').all() as { path: string }[];
    for (const { path: projectPath } of projects) {
      const normalizedProject = resolve(projectPath);
      // Path must be the project dir itself or a descendant
      if (resolvedPath === normalizedProject || resolvedPath.startsWith(normalizedProject + '/')) {
        return true;
      }
    }
    return false;
  } catch {
    // If DB is unavailable, deny by default
    return false;
  }
}

export const fileRoutes: FastifyPluginAsync = async (app) => {
  // List directory contents
  app.get<{
    Querystring: { path: string; showHidden?: string };
  }>('/files', async (req, reply) => {
    const dirPath = req.query.path;
    if (!dirPath) return reply.status(400).send({ error: 'path query parameter is required' });
    const showHidden = req.query.showHidden === 'true';

    const resolved = resolve(dirPath);

    if (!isPathAllowed(resolved)) {
      return reply.status(403).send({ error: 'Access denied: path is outside registered project directories' });
    }

    try {
      const entries = await readdir(resolved, { withFileTypes: true });
      const files: FileEntry[] = [];

      for (const entry of entries) {
        // Skip hidden files/dirs starting with . (unless showHidden)
        if (!showHidden && entry.name.startsWith('.')) continue;
        // Always skip .git internals and node_modules
        if (entry.name === 'node_modules' || entry.name === '.git') continue;

        try {
          const fullPath = join(resolved, entry.name);
          const stats = await stat(fullPath);
          files.push({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: stats.size,
            extension: entry.isDirectory() ? '' : extname(entry.name).slice(1),
          });
        } catch {
          // Skip files we can't stat (permission errors, etc.)
        }
      }

      // Sort: directories first, then alphabetical
      files.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return { path: resolved, files };
    } catch (err: any) {
      if (err.code === 'ENOENT') return reply.status(404).send({ error: 'Directory not found' });
      if (err.code === 'ENOTDIR') return reply.status(400).send({ error: 'Path is not a directory' });
      return reply.status(500).send({ error: 'Failed to read directory' });
    }
  });

  // Read file contents (for the file viewer)
  app.get<{
    Querystring: { path: string };
  }>('/files/read', async (req, reply) => {
    const filePath = req.query.path;
    if (!filePath) return reply.status(400).send({ error: 'path query parameter is required' });

    const resolved = resolve(filePath);

    if (!isPathAllowed(resolved)) {
      return reply.status(403).send({ error: 'Access denied: path is outside registered project directories' });
    }

    try {
      const stats = await stat(resolved);
      // Limit to 1MB files
      if (stats.size > 1024 * 1024) {
        return reply.status(413).send({ error: 'File too large (max 1MB)' });
      }

      const content = await readFile(resolved, 'utf-8');
      const ext = extname(resolved).slice(1);

      return { path: resolved, content, extension: ext, size: stats.size };
    } catch (err: any) {
      if (err.code === 'ENOENT') return reply.status(404).send({ error: 'File not found' });
      return reply.status(500).send({ error: 'Failed to read file' });
    }
  });

  // Write file contents
  app.put<{
    Body: { path: string; content: string };
  }>('/files/write', async (req, reply) => {
    const { path: filePath, content } = req.body || {};
    if (!filePath) return reply.status(400).send({ error: 'path is required' });
    if (typeof content !== 'string') return reply.status(400).send({ error: 'content is required' });

    const resolved = resolve(filePath);

    if (!isPathAllowed(resolved)) {
      return reply.status(403).send({ error: 'Access denied: path is outside registered project directories' });
    }

    try {
      // Verify file exists (won't create new files)
      await stat(resolved);
      await writeFile(resolved, content, 'utf-8');
      const newStats = await stat(resolved);
      return { ok: true, size: newStats.size };
    } catch (err: any) {
      if (err.code === 'ENOENT') return reply.status(404).send({ error: 'File not found' });
      return reply.status(500).send({ error: 'Failed to write file' });
    }
  });

  // Diff two files (unified diff output)
  app.post<{
    Body: { pathA: string; pathB: string };
  }>('/files/diff', async (req, reply) => {
    const { pathA, pathB } = req.body || {};
    if (!pathA || !pathB) return reply.status(400).send({ error: 'pathA and pathB are required' });

    const resolvedA = resolve(pathA);
    const resolvedB = resolve(pathB);

    if (!isPathAllowed(resolvedA) || !isPathAllowed(resolvedB)) {
      return reply.status(403).send({ error: 'Access denied: path is outside registered project directories' });
    }

    // Verify both files exist
    try { await stat(resolvedA); } catch { return reply.status(404).send({ error: `File not found: ${pathA}` }); }
    try { await stat(resolvedB); } catch { return reply.status(404).send({ error: `File not found: ${pathB}` }); }

    return new Promise((resolvePromise) => {
      // Use -U3 for 3-line context (default) and histogram algorithm for better hunk splitting.
      // git diff --no-index exits 1 when files differ — that's not an error.
      exec(
        `git diff --no-index -U1 --diff-algorithm=histogram -- "${resolvedA}" "${resolvedB}"`,
        { maxBuffer: 5 * 1024 * 1024 },
        (err, stdout) => {
          // Exit code 1 = files differ (normal), 0 = identical
          if (err && err.code !== 1) {
            // Fallback to diff -u if git not available
            exec(
              `diff -u "${resolvedA}" "${resolvedB}"`,
              { maxBuffer: 5 * 1024 * 1024 },
              (err2, stdout2) => {
                reply.send({ diff: stdout2 || '' });
                resolvePromise(undefined);
              }
            );
            return;
          }
          reply.send({ diff: stdout || '' });
          resolvePromise(undefined);
        }
      );
    });
  });

  // Open VS Code at a given path
  app.post<{
    Body: { path: string };
  }>('/open-vscode', async (req, reply) => {
    const { path } = req.body;
    if (!path) return reply.status(400).send({ error: 'path is required' });

    const resolved = resolve(path);

    if (!isPathAllowed(resolved)) {
      return reply.status(403).send({ error: 'Access denied: path is outside registered project directories' });
    }

    return new Promise((resolvePromise) => {
      exec(`code "${resolved}"`, (err) => {
        if (err) {
          reply.status(500).send({ error: 'Failed to open VS Code', details: err.message });
        } else {
          reply.send({ ok: true, path: resolved });
        }
        resolvePromise(undefined);
      });
    });
  });
};
