-- Auto-send and follow-ups (2026-11-23). See src/outbox.js.
-- outreach.auto_state: NULL for a manual draft, else queued | held | sent | cancelled.
-- outreach.send_at: when a queued auto-send is due (UTC, "YYYY-MM-DD HH:MM:SS").
-- outreach.quoted: JSON list of the finding families the draft quotes, re-checked right before sending.
-- prospects.c_*: the contact route found on the business's own website, so one lookup serves every later step.
ALTER TABLE outreach ADD COLUMN auto_state TEXT;
ALTER TABLE outreach ADD COLUMN send_at TEXT;
ALTER TABLE outreach ADD COLUMN hold_reason TEXT;
ALTER TABLE outreach ADD COLUMN thread_ref TEXT;
ALTER TABLE outreach ADD COLUMN bounced_at TEXT;
ALTER TABLE outreach ADD COLUMN quoted TEXT;
ALTER TABLE outreach ADD COLUMN no_followups INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outreach ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE prospects ADD COLUMN c_email TEXT;
ALTER TABLE prospects ADD COLUMN c_url TEXT;
ALTER TABLE prospects ADD COLUMN c_form INTEGER;
ALTER TABLE prospects ADD COLUMN c_hidden INTEGER;
ALTER TABLE prospects ADD COLUMN c_auto INTEGER;   -- 1 when the address is one the auto-sender may use (own domain or a free-mail address the site lists)
ALTER TABLE prospects ADD COLUMN c_checked_at TEXT;
CREATE INDEX idx_outreach_auto ON outreach(auto_state, send_at);

-- Follow-up emails: n = 1 (a nudge, day 4) or 2 (the last note, a week later). One row per outreach and n.
CREATE TABLE touches (
  id INTEGER PRIMARY KEY,
  outreach_id INTEGER NOT NULL REFERENCES outreach(id),
  prospect_id INTEGER NOT NULL REFERENCES prospects(id),
  n INTEGER NOT NULL,
  due_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sent','cancelled')),
  subject TEXT, body TEXT, sent_at TEXT, note TEXT,
  UNIQUE (outreach_id, n)
);
CREATE INDEX idx_touches_due ON touches(state, due_at);
