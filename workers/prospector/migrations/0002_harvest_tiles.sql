-- Tiled harvest: a small key/value table (holds the queue of map tiles still to harvest) and a
-- per-week count of how many OpenStreetMap objects shared each prospect's domain (chain filter
-- across tiles; the check batch and digest only consider rows with sightings < 3).
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
ALTER TABLE prospects ADD COLUMN sightings INTEGER NOT NULL DEFAULT 0;
