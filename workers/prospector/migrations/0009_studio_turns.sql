CREATE TABLE IF NOT EXISTS studio_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  input TEXT NOT NULL,
  deep INTEGER NOT NULL DEFAULT 0 CHECK (deep IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'claimed', 'done', 'fallback')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  done_at TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS studio_turns_state_created ON studio_turns(state, created_at);
