ALTER TABLE office_run_messages ADD COLUMN piece_kind TEXT NOT NULL DEFAULT 'none';
ALTER TABLE office_run_messages ADD COLUMN piece_title TEXT NOT NULL DEFAULT '';
ALTER TABLE office_run_messages ADD COLUMN piece_text TEXT NOT NULL DEFAULT '';
ALTER TABLE office_run_messages ADD COLUMN library_id INTEGER;
ALTER TABLE office_run_messages ADD COLUMN use_state TEXT NOT NULL DEFAULT 'pending';
CREATE TABLE IF NOT EXISTS library (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('standup','builder')),
  source_ref TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','used','archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at TEXT
);
