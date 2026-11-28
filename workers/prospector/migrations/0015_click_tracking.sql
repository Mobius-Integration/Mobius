ALTER TABLE outreach ADD COLUMN link_code TEXT;
CREATE UNIQUE INDEX idx_outreach_link_code ON outreach(link_code);

CREATE TABLE clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  outreach_id INTEGER NOT NULL REFERENCES outreach(id),
  prospect_id INTEGER NOT NULL REFERENCES prospects(id),
  clicked_at TEXT NOT NULL DEFAULT (datetime('now')),
  likely_bot INTEGER NOT NULL CHECK (likely_bot IN (0, 1)),
  ua_kind TEXT NOT NULL
);
CREATE INDEX idx_clicks_outreach_time ON clicks(outreach_id, clicked_at);
