CREATE TABLE IF NOT EXISTS studio_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  author TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS studio_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  labels TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS studio_brief (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  brief TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO studio_brief (id, brief) VALUES (1, '{"name":"Mobius Integration","one_liner":"A local tech partner for Tampa Bay businesses","audience":[],"personality":[],"avoid":[],"voice":{"do":[],"dont":[]},"palette":[],"type":{"display":"","text":""},"textures":[],"taglines":[],"decisions":[]}');
