import Database from 'better-sqlite3';
import { config } from '../config.js';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb(): void {
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create tables
  db.exec(`
    -- Projects registered with OctoAlly
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- RuFlo sessions
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id),
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed, cancelled
      pid INTEGER,
      started_at TEXT,
      completed_at TEXT,
      exit_code INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Events from Claude Code hooks
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT REFERENCES sessions(id),
      type TEXT NOT NULL,          -- tool_use, tool_result, edit, command, task, error
      tool_name TEXT,
      data TEXT,                   -- JSON payload
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Task queue
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id),
      title TEXT NOT NULL,
      description TEXT,
      priority INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',  -- queued, running, completed, failed
      session_id TEXT REFERENCES sessions(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT
    );

    -- PTY output storage (replaces in-memory buffer)
    CREATE TABLE IF NOT EXISTS pty_output (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- App settings (key-value store)
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_pty_output_session_seq ON pty_output(session_id, seq);
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  `);

  // Migrations — idempotent column additions
  try { db.exec('ALTER TABLE sessions ADD COLUMN claude_session_id TEXT'); } catch {}
  try { db.exec('ALTER TABLE projects ADD COLUMN ruflo_prompt TEXT'); } catch {}
  // Migrate old column name
  try { db.exec('ALTER TABLE projects RENAME COLUMN claude_flow_prompt TO ruflo_prompt'); } catch {}
  try { db.exec('ALTER TABLE projects ADD COLUMN openclaw_prompt TEXT'); } catch {}
  try { db.exec('ALTER TABLE sessions ADD COLUMN terminal_cols INTEGER DEFAULT 120'); } catch {}
  try { db.exec('ALTER TABLE sessions ADD COLUMN external_socket TEXT'); } catch {}
  try { db.exec('ALTER TABLE projects ADD COLUMN default_web_url TEXT'); } catch {}
  try { db.exec('ALTER TABLE events ADD COLUMN project_id TEXT REFERENCES projects(id)'); } catch {}
  try { db.exec('ALTER TABLE sessions ADD COLUMN pre_popout_cols INTEGER'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id)'); } catch {}
  // Codex support: track which CLI (claude or codex) launched the session
  try { db.exec("ALTER TABLE sessions ADD COLUMN cli_type TEXT DEFAULT 'claude'"); } catch {}

  // Note: orphaned process cleanup is handled by cleanupStaleRunningSessions()
  // which is called after initDb() in index.ts — it kills processes AND marks DB records.

  console.log('📦 Database initialized');
}
