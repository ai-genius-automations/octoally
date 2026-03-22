import { z } from 'zod';
import { router, publicProcedure } from './index.js';
import { getDb } from '../db/index.js';
import { getEvents } from '../services/event-store.js';
import * as sessionManager from '../services/session-manager.js';
import { nanoid } from 'nanoid';

export const appRouter = router({
  // Projects
  projects: router({
    list: publicProcedure.query(() => {
      const db = getDb();
      return db.prepare('SELECT * FROM projects ORDER BY name').all();
    }),

    create: publicProcedure
      .input(z.object({
        name: z.string().min(1),
        path: z.string().min(1),
        description: z.string().optional(),
      }))
      .mutation(({ input }) => {
        const db = getDb();
        const id = nanoid(12);
        db.prepare('INSERT INTO projects (id, name, path, description) VALUES (?, ?, ?, ?)')
          .run(id, input.name, input.path, input.description || null);
        return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
      }),

    delete: publicProcedure
      .input(z.object({ id: z.string() }))
      .mutation(({ input }) => {
        const db = getDb();
        const result = db.prepare('DELETE FROM projects WHERE id = ?').run(input.id);
        return { deleted: result.changes > 0 };
      }),
  }),

  // Sessions
  sessions: router({
    list: publicProcedure
      .input(z.object({ status: z.string().optional() }).optional())
      .query(({ input }) => {
        return sessionManager.listSessions(input?.status);
      }),

    get: publicProcedure
      .input(z.object({ id: z.string() }))
      .query(({ input }) => {
        return sessionManager.getSession(input.id);
      }),

    create: publicProcedure
      .input(z.object({
        projectPath: z.string(),
        task: z.string().min(1),
        projectId: z.string().optional(),
        cliType: z.enum(['claude', 'codex']).optional(),
      }))
      .mutation(({ input }) => {
        const cliType = input.cliType || 'claude';
        const session = sessionManager.createSession(input.projectPath, input.task, input.projectId, cliType);
        sessionManager.spawnClaudeFlow(session.id, input.projectPath, input.task, 180, 40, cliType);
        return session;
      }),

    kill: publicProcedure
      .input(z.object({ id: z.string() }))
      .mutation(({ input }) => {
        return { killed: sessionManager.killSession(input.id) };
      }),
  }),

  // Events
  events: router({
    list: publicProcedure
      .input(z.object({
        sessionId: z.string().optional(),
        type: z.string().optional(),
        limit: z.number().optional(),
        since: z.string().optional(),
      }).optional())
      .query(({ input }) => {
        return getEvents({
          session_id: input?.sessionId,
          type: input?.type,
          limit: input?.limit,
          since: input?.since,
        });
      }),
  }),

  // Health
  health: publicProcedure.query(() => ({
    name: 'octoally',
    version: '0.1.0',
    status: 'running',
    uptime: process.uptime(),
  })),
});

export type AppRouter = typeof appRouter;
