-- Prospect board: one-tap buttons replace the SENT/SKIP/STOP reply commands.
-- outreach gains the contact route (looked up only for prospects picked for a digest), when and how
-- the email went out, and whether they replied. events logs every button press, auto-detected send
-- and command, for undo now and for reply rates by angle later.
ALTER TABLE outreach ADD COLUMN contact_email TEXT;
ALTER TABLE outreach ADD COLUMN contact_url TEXT;
ALTER TABLE outreach ADD COLUMN contact_form INTEGER;
ALTER TABLE outreach ADD COLUMN sent_at TEXT;
ALTER TABLE outreach ADD COLUMN sent_via TEXT;
ALTER TABLE outreach ADD COLUMN sent_to TEXT;
ALTER TABLE outreach ADD COLUMN replied_at TEXT;
CREATE INDEX idx_outreach_prospect ON outreach(prospect_id);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id),
  action TEXT NOT NULL,                -- sent, skip, never, replied, unreplied, undo
  via TEXT,                            -- board, email-button, gmail (hidden copy), command
  detail TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_prospect ON events(prospect_id, id);
