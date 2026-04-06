import type { FastifyPluginAsync } from 'fastify';
import {
  grantPermissions,
  checkPermission,
  revokePermissions,
  getPermissions,
} from '../services/session-manager.js';

export const permissionsRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/permissions/grant
  // Body: { parentId: string, childId: string, permissions?: string[] }
  // permissions maps to restrictTools — narrows the allowed set for the child.
  app.post<{
    Body: { parentId?: string; childId?: string; permissions?: string[] };
  }>('/permissions/grant', async (req, reply) => {
    const { parentId, childId, permissions } = req.body || {};

    if (!childId || typeof childId !== 'string') {
      return reply.status(400).send({ ok: false, error: 'childId is required' });
    }

    const resolvedParentId = (parentId && typeof parentId === 'string') ? parentId : null;

    const grant = grantPermissions(
      childId,
      resolvedParentId,
      permissions && permissions.length > 0 ? { restrictTools: permissions } : undefined,
    );

    return reply.send({ ok: true, grant });
  });

  // GET /api/permissions/check?sessionId=X&tool=Y
  // Returns { allowed: boolean, reason: string }
  app.get<{
    Querystring: { sessionId?: string; tool?: string };
  }>('/permissions/check', async (req, reply) => {
    const { sessionId, tool } = req.query;

    if (!sessionId || typeof sessionId !== 'string') {
      return reply.status(400).send({ ok: false, error: 'sessionId query parameter is required' });
    }
    if (!tool || typeof tool !== 'string') {
      return reply.status(400).send({ ok: false, error: 'tool query parameter is required' });
    }

    const grant = getPermissions(sessionId);
    const allowed = checkPermission(sessionId, tool);

    let reason: string;
    if (!grant) {
      reason = 'no_grant_root_session';
    } else if (!allowed) {
      const isDenied = grant.deniedTools.some(
        (d) => tool.startsWith(d) || d === tool,
      );
      reason = isDenied ? 'explicitly_denied' : 'not_in_allowlist';
    } else {
      reason = 'allowed';
    }

    return reply.send({ allowed, reason });
  });

  // POST /api/permissions/revoke
  // Body: { parentId?: string, childId: string }
  // Revokes the permission grant for childId.
  app.post<{
    Body: { parentId?: string; childId?: string };
  }>('/permissions/revoke', async (req, reply) => {
    const { childId } = req.body || {};

    if (!childId || typeof childId !== 'string') {
      return reply.status(400).send({ ok: false, error: 'childId is required' });
    }

    const existed = revokePermissions(childId);
    if (!existed) {
      return reply.status(404).send({ ok: false, error: 'No permission grant found for childId' });
    }

    return reply.send({ ok: true });
  });
};
