CREATE TABLE prospects (
  id INTEGER PRIMARY KEY,
  osm_key TEXT NOT NULL,              -- "node/123" etc. of the first sighting
  domain TEXT UNIQUE NOT NULL,        -- normalized: lowercase host without leading www.
  website TEXT NOT NULL,              -- normalized URL we check (https:// added if missing)
  name TEXT NOT NULL,
  category TEXT NOT NULL,             -- one of the audience ids (src/_data/audiences.js)
  city TEXT, phone TEXT,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','checked','unreachable','robots_skip','digested','sent','skipped','suppressed')),
  score INTEGER,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX idx_prospects_status_score ON prospects(status, score DESC);

CREATE TABLE checks (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id),
  ok INTEGER NOT NULL, status_code INTEGER, ms INTEGER, final_url TEXT,
  https INTEGER, viewport INTEGER, imgs_total INTEGER, imgs_no_alt INTEGER,
  fields_unlabeled INTEGER, booking TEXT, issues_json TEXT, good_json TEXT, error TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_checks_prospect ON checks(prospect_id);

CREATE TABLE outreach (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id),
  digest_date TEXT NOT NULL, draft_subject TEXT, draft_body TEXT, model TEXT,
  founder_status TEXT NOT NULL DEFAULT 'drafted' CHECK (founder_status IN ('drafted','sent','skipped')),
  updated_at TEXT
);

CREATE TABLE suppression (
  value TEXT PRIMARY KEY,             -- a domain (example.com) or a full email address, lowercase
  reason TEXT, added_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ok INTEGER, detail TEXT
);
