-- The reply kit (2026-11-24): when a prospect writes back, the Worker makes the short write-up the first
-- email offered (a PDF with screenshots, src/writeup.js) and leaves a reply draft in that Gmail thread for
-- the founder to read and send (src/replykit.js). Nothing here sends anything to a prospect.

-- One row per write-up made. The PDF itself lives in the WRITEUPS KV namespace under kv_key.
CREATE TABLE writeups (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id),
  kv_key TEXT,                        -- NULL when making it failed (see error)
  bytes INTEGER,
  url TEXT,                           -- the page that was opened (after redirects)
  findings_json TEXT,                 -- what the write-up says, for the reply draft and the board
  error TEXT,
  ms INTEGER,                         -- how long making it took
  via TEXT,                           -- 'reply' or 'board'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_writeups_prospect ON writeups(prospect_id, id);

-- One row per message a prospect sent us (people only: out-of-office replies and bounces never get here).
CREATE TABLE replies (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id),
  outreach_id INTEGER REFERENCES outreach(id),
  msg_id TEXT UNIQUE NOT NULL,        -- the Gmail message id
  thread_id TEXT,
  from_addr TEXT,
  from_name TEXT,
  subject TEXT,
  text TEXT,                          -- the reply without the quoted email under it (at most 600 characters)
  received_at TEXT,
  intent TEXT,                        -- yes | question | call | later | no | other
  question TEXT,                      -- what they asked, in a few words (when they asked something)
  state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'drafting', 'drafted', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  writeup_id INTEGER REFERENCES writeups(id),
  draft_id TEXT,
  draft_to TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX idx_replies_state ON replies(state, created_at);
CREATE INDEX idx_replies_prospect ON replies(prospect_id, id);
