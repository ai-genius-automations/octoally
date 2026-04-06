import type { FastifyPluginAsync } from 'fastify';
import { getSuggestions, getQuickActions } from '../services/magic-docs.js';

export const magicDocsRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/suggestions?context=<text>&file=<path>&max=<n>
  // Returns context-aware prompt suggestions.
  // - context: free-form text (treated as file content for analysis)
  // - file:    optional file path (used for extension-based hints)
  // - max:     optional max suggestions to return (default 5)
  app.get('/suggestions', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const context = q.context || '';
    const filePath = q.file || undefined;
    const maxSuggestions = Math.max(1, parseInt(q.max, 10) || 5);

    if (!context && !filePath) {
      return reply.status(400).send({ error: 'Provide at least one of: context, file' });
    }

    const suggestions = getSuggestions({
      filePath,
      fileContent: context || undefined,
      maxSuggestions,
    });

    return { suggestions, total: suggestions.length };
  });

  // GET /api/quick-actions?path=<file_path>
  // Returns quick action suggestions for the given file path.
  app.get('/quick-actions', async (req, reply) => {
    const filePath = (req.query as Record<string, string>).path;

    if (!filePath) {
      return reply.status(400).send({ error: 'path query parameter is required' });
    }

    const actions = getQuickActions(filePath);
    return { actions, total: actions.length };
  });
};
