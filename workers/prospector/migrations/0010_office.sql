CREATE TABLE IF NOT EXISTS office_agents (
  role TEXT PRIMARY KEY,
  notebook TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS office_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot TEXT NOT NULL UNIQUE,
  thread_id TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT
);
CREATE TABLE IF NOT EXISTS office_run_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  step TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS office_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  why TEXT NOT NULL,
  owner TEXT NOT NULL,
  thread_id TEXT,
  state TEXT NOT NULL DEFAULT 'proposed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS office_runs_created ON office_runs(created_at);
CREATE INDEX IF NOT EXISTS office_messages_run ON office_run_messages(run_id,id);
-- The Office shares Studio's turn queue (studio_turns): these columns say which kind of turn it is and carry
-- an Office turn's run, role, step, prompt and output schema. (Added in review: the code used them but the
-- first draft of this migration never created them.)
ALTER TABLE studio_turns ADD COLUMN kind TEXT NOT NULL DEFAULT 'studio';
ALTER TABLE studio_turns ADD COLUMN run_id INTEGER;
ALTER TABLE studio_turns ADD COLUMN role TEXT;
ALTER TABLE studio_turns ADD COLUMN step TEXT;
ALTER TABLE studio_turns ADD COLUMN prompt TEXT;
ALTER TABLE studio_turns ADD COLUMN schema_json TEXT;
