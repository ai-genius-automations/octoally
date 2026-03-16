import type { FastifyPluginAsync } from 'fastify';
import { insertEvent, getEvents } from '../services/event-store.js';
import { getDb } from '../db/index.js';

/**
 * Check if a session_id exists in the sessions table.
 * External hooks (Claude Code) send their own session IDs that don't match
 * HiveCommand sessions, so we null them out to avoid FK constraint failures.
 */
function resolveSessionId(sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  const db = getDb();
  const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
  return row ? sessionId : undefined;
}

/**
 * Resolve a project path to a project_id.
 */
function resolveProjectId(projectPath?: string): string | undefined {
  if (!projectPath) return undefined;
  const db = getDb();
  const row = db.prepare('SELECT id FROM projects WHERE path = ?').get(projectPath) as { id: string } | undefined;
  return row?.id;
}

/**
 * Event routes — REST endpoints for Claude Code hooks
 * These need to be simple POST endpoints that hooks can curl to
 */
export const eventRoutes: FastifyPluginAsync = async (app) => {
  // Receive events from Claude Code hooks
  app.post<{
    Body: {
      type: string;
      session_id?: string;
      project_path?: string;
      tool_name?: string;
      data?: Record<string, unknown>;
    };
  }>('/events', async (req, reply) => {
    const { type, session_id, project_path, tool_name, data } = req.body;

    if (!type) {
      return reply.status(400).send({ error: 'type is required' });
    }

    // Store the original session_id in data for reference, use resolved one for FK
    const resolvedId = resolveSessionId(session_id);
    const projectId = resolveProjectId(project_path);
    const eventData = session_id && !resolvedId
      ? { ...data, claude_session_id: session_id }
      : data;

    const event = insertEvent({ type, session_id: resolvedId, project_id: projectId, tool_name, data: eventData });
    return { ok: true, event_id: event.id };
  });

  // Get recent events
  app.get<{
    Querystring: {
      session_id?: string;
      project_id?: string;
      project_path?: string;
      type?: string;
      limit?: string;
      since?: string;
    };
  }>('/events', async (req) => {
    const { session_id, project_id, project_path, type, limit, since } = req.query;

    // Allow querying by project_path (resolves to project_id)
    const resolvedProjectId = project_id || resolveProjectId(project_path);

    const events = getEvents({
      session_id,
      project_id: resolvedProjectId,
      type,
      limit: limit ? parseInt(limit, 10) : 100,
      since,
    });
    return { events };
  });
};
