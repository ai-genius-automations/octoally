import { getDb } from '../db/index.js';

export interface Event {
  id: number;
  session_id: string | null;
  type: string;
  tool_name: string | null;
  data: string | null;
  timestamp: string;
}

export interface EventInput {
  session_id?: string;
  project_id?: string;
  type: string;
  tool_name?: string;
  data?: Record<string, unknown>;
}

// Listeners for real-time streaming
type EventListener = (event: Event) => void;
const listeners = new Set<EventListener>();

export function subscribe(listener: EventListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners(event: Event) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Don't let one bad listener kill the stream
    }
  }
}

export function insertEvent(input: EventInput): Event {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO events (session_id, project_id, type, tool_name, data)
    VALUES (?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    input.session_id || null,
    input.project_id || null,
    input.type,
    input.tool_name || null,
    input.data ? JSON.stringify(input.data) : null
  );

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(result.lastInsertRowid) as Event;
  notifyListeners(event);
  return event;
}

export function getEvents(options?: {
  session_id?: string;
  project_id?: string;
  type?: string;
  limit?: number;
  since?: string;
}): Event[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.session_id) {
    conditions.push('session_id = ?');
    params.push(options.session_id);
  }
  if (options?.project_id) {
    conditions.push('project_id = ?');
    params.push(options.project_id);
  }
  if (options?.type) {
    conditions.push('type = ?');
    params.push(options.type);
  }
  if (options?.since) {
    conditions.push('timestamp > ?');
    params.push(options.since);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = options?.limit || 100;

  return db.prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT ?`).all(...params, limit) as Event[];
}

// ─── Transcript Management ──────────────────────────────────────

export interface TranscriptEntry {
  id: number;
  session_id: string;
  seq: number;
  role: string;
  content: string | null;
  tool_name: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  timestamp: string;
}

export function appendTranscript(entry: {
  session_id: string;
  seq: number;
  role: string;
  content?: string;
  tool_name?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
}): TranscriptEntry {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO transcripts (session_id, seq, role, content, tool_name, tokens_in, tokens_out, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    entry.session_id,
    entry.seq,
    entry.role,
    entry.content || null,
    entry.tool_name || null,
    entry.tokens_in || 0,
    entry.tokens_out || 0,
    entry.cost_usd || 0
  );
  return db.prepare('SELECT * FROM transcripts WHERE id = ?').get(result.lastInsertRowid) as TranscriptEntry;
}

export function getTranscript(session_id: string, options?: { limit?: number; offset?: number }): TranscriptEntry[] {
  const db = getDb();
  const limit = options?.limit || 1000;
  const offset = options?.offset || 0;
  return db.prepare(
    'SELECT * FROM transcripts WHERE session_id = ? ORDER BY seq ASC LIMIT ? OFFSET ?'
  ).all(session_id, limit, offset) as TranscriptEntry[];
}

export function compactTranscript(session_id: string, keepLast: number = 50): number {
  const db = getDb();
  const maxSeq = db.prepare(
    'SELECT MAX(seq) as max_seq FROM transcripts WHERE session_id = ?'
  ).get(session_id) as { max_seq: number | null };

  if (!maxSeq?.max_seq || maxSeq.max_seq <= keepLast) return 0;

  const cutoff = maxSeq.max_seq - keepLast;
  const result = db.prepare(
    'DELETE FROM transcripts WHERE session_id = ? AND seq <= ?'
  ).run(session_id, cutoff);
  return result.changes;
}

export function flushTranscript(session_id: string): number {
  const db = getDb();
  const result = db.prepare('DELETE FROM transcripts WHERE session_id = ?').run(session_id);
  return result.changes;
}
