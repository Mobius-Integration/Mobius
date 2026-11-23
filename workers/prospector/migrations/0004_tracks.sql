-- Overture import, law firms and the partner track (2026-11-23).
-- source: where the prospect came from ('osm', 'overture').
-- kind:   a finer business type (Overture taxonomy id such as 'personal_injury_law' or 'accountant'); NULL for
--         the OpenStreetMap rows harvested before this migration.
-- track:  'client' (we pitch our services) or 'partner' (we ask them to refer their clients). See src/partners.js.
-- outreach.angle: which draft angle went out ('client', 'law-client', 'partner-lawyer', ...), for reply rates by angle.
ALTER TABLE prospects ADD COLUMN source TEXT NOT NULL DEFAULT 'osm';
ALTER TABLE prospects ADD COLUMN kind TEXT;
ALTER TABLE prospects ADD COLUMN track TEXT NOT NULL DEFAULT 'client';
ALTER TABLE outreach ADD COLUMN angle TEXT;
CREATE INDEX idx_prospects_track ON prospects(track, status, score DESC);
