import { FastifyPluginAsync } from 'fastify';
import { readdir, stat, readFile, writeFile, rm, rename, cp } from 'fs/promises';
import { join, resolve, extname, dirname, basename } from 'path';
import { exec } from 'child_process';

interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  extension: string;
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

  // Delete a file or directory (recursive for directories)
  app.post<{
    Body: { path: string };
  }>('/files/delete', async (req, reply) => {
    const { path: targetPath } = req.body || {};
    if (!targetPath) return reply.status(400).send({ error: 'path is required' });
    const resolved = resolve(targetPath);

    try {
      await stat(resolved);
    } catch {
      return reply.status(404).send({ error: 'Path not found' });
    }

    try {
      await rm(resolved, { recursive: true, force: false });
      return { ok: true };
    } catch (err: any) {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        return reply.status(403).send({ error: 'Permission denied', detail: err.message });
      }
      return reply.status(500).send({ error: 'Failed to delete', detail: err.message });
    }
  });

  // Rename a file or directory in place (sibling rename only)
  app.post<{
    Body: { path: string; newName: string };
  }>('/files/rename', async (req, reply) => {
    const { path: targetPath, newName } = req.body || {};
    if (!targetPath) return reply.status(400).send({ error: 'path is required' });
    if (!newName || typeof newName !== 'string') return reply.status(400).send({ error: 'newName is required' });
    if (newName.includes('/') || newName.includes('\\') || newName === '.' || newName === '..') {
      return reply.status(400).send({ error: 'Invalid name (must not contain path separators)' });
    }

    const resolvedSrc = resolve(targetPath);
    const dest = join(dirname(resolvedSrc), newName);

    try {
      await stat(resolvedSrc);
    } catch {
      return reply.status(404).send({ error: 'Source not found' });
    }

    // Refuse if destination already exists (prevent silent overwrite)
    try {
      await stat(dest);
      return reply.status(409).send({ error: 'A file or folder with that name already exists' });
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        return reply.status(500).send({ error: 'Failed to check destination', detail: err.message });
      }
    }

    try {
      await rename(resolvedSrc, dest);
      return { ok: true, path: dest };
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to rename', detail: err.message });
    }
  });

  // Move a file or directory (cut + paste). Falls back to copy+delete across volumes.
  app.post<{
    Body: { src: string; destDir: string };
  }>('/files/move', async (req, reply) => {
    const { src, destDir } = req.body || {};
    if (!src || !destDir) return reply.status(400).send({ error: 'src and destDir are required' });

    const resolvedSrc = resolve(src);
    const resolvedDestDir = resolve(destDir);
    const dest = join(resolvedDestDir, basename(resolvedSrc));

    if (resolvedSrc === dest) {
      return reply.status(400).send({ error: 'Source and destination are the same' });
    }
    // Prevent moving a directory into itself or its descendants
    if (resolvedDestDir === resolvedSrc || resolvedDestDir.startsWith(resolvedSrc + '/')) {
      return reply.status(400).send({ error: 'Cannot move a folder into itself' });
    }

    try {
      await stat(resolvedSrc);
    } catch {
      return reply.status(404).send({ error: 'Source not found' });
    }
    try {
      const ds = await stat(resolvedDestDir);
      if (!ds.isDirectory()) return reply.status(400).send({ error: 'Destination is not a directory' });
    } catch {
      return reply.status(404).send({ error: 'Destination directory not found' });
    }
    try {
      await stat(dest);
      return reply.status(409).send({ error: 'A file or folder with that name already exists at the destination' });
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        return reply.status(500).send({ error: 'Failed to check destination', detail: err.message });
      }
    }

    try {
      await rename(resolvedSrc, dest);
      return { ok: true, path: dest };
    } catch (err: any) {
      // Cross-device — fall back to copy + delete
      if (err.code === 'EXDEV') {
        try {
          await cp(resolvedSrc, dest, { recursive: true, errorOnExist: true, force: false });
          await rm(resolvedSrc, { recursive: true, force: false });
          return { ok: true, path: dest };
        } catch (err2: any) {
          return reply.status(500).send({ error: 'Failed to move across volumes', detail: err2.message });
        }
      }
      return reply.status(500).send({ error: 'Failed to move', detail: err.message });
    }
  });

  // Copy a file or directory (recursive). Refuses to overwrite existing destination.
  app.post<{
    Body: { src: string; destDir: string };
  }>('/files/copy', async (req, reply) => {
    const { src, destDir } = req.body || {};
    if (!src || !destDir) return reply.status(400).send({ error: 'src and destDir are required' });

    const resolvedSrc = resolve(src);
    const resolvedDestDir = resolve(destDir);
    const dest = join(resolvedDestDir, basename(resolvedSrc));

    if (resolvedSrc === dest) {
      return reply.status(400).send({ error: 'Source and destination are the same' });
    }
    // Prevent copying a directory into itself or its descendants
    if (resolvedDestDir === resolvedSrc || resolvedDestDir.startsWith(resolvedSrc + '/')) {
      return reply.status(400).send({ error: 'Cannot copy a folder into itself' });
    }

    try {
      await stat(resolvedSrc);
    } catch {
      return reply.status(404).send({ error: 'Source not found' });
    }
    try {
      const ds = await stat(resolvedDestDir);
      if (!ds.isDirectory()) return reply.status(400).send({ error: 'Destination is not a directory' });
    } catch {
      return reply.status(404).send({ error: 'Destination directory not found' });
    }
    try {
      await stat(dest);
      return reply.status(409).send({ error: 'A file or folder with that name already exists at the destination' });
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        return reply.status(500).send({ error: 'Failed to check destination', detail: err.message });
      }
    }

    try {
      await cp(resolvedSrc, dest, { recursive: true, errorOnExist: true, force: false });
      return { ok: true, path: dest };
    } catch (err: any) {
      return reply.status(500).send({ error: 'Failed to copy', detail: err.message });
    }
  });

  // Open VS Code at a given path
  app.post<{
    Body: { path: string };
  }>('/open-vscode', async (req, reply) => {
    const { path } = req.body;
    if (!path) return reply.status(400).send({ error: 'path is required' });

    const resolved = resolve(path);

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
