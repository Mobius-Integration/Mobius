-- The subject test (2026-11-24): which subject line a queued client email uses. 'A' is the drafted
-- subject, 'B' a plain "Question about <business>'s website". NULL for partners and for emails queued
-- before the test. The board's results panel compares reply rates by variant (src/board.js).
ALTER TABLE outreach ADD COLUMN variant TEXT;
