-- Artist as first-class entity (BOO-28).
-- Promotes the denormalized release.artist / track.artist text columns into a
-- proper artist table with FKs, and extends source_link / source_facets /
-- match_key to allow entity_kind='artist' so adapters can later link source-
-- side artist records (e.g. Discogs artist IDs) to local artist rows.

-- Defer FK enforcement to commit: track.release_id → release.id is recreated
-- mid-migration, which would otherwise trip the immediate FK check.
PRAGMA defer_foreign_keys = ON;

-- 1. artist table -------------------------------------------------
CREATE TABLE artist (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_artist_name ON artist(name COLLATE NOCASE);

-- 2. Backfill artist rows from existing denormalized strings.
-- Dedup by LOWER(name); pick the lexicographically first casing as canonical.
-- (Diacritic-level dedup is a future concern — pure-SQL normalization can't
-- strip combining marks, so "Björk" / "Bjork" stay distinct here. The collate
-- code uses squashAlphanumLower for match_keys, which will catch identical
-- normalized keys on the next sync.)
INSERT INTO artist (id, name)
SELECT
  lower(hex(randomblob(8))) AS id,
  MIN(artist) AS name
FROM (
  SELECT artist FROM release WHERE artist IS NOT NULL AND artist != ''
  UNION ALL
  SELECT artist FROM track   WHERE artist IS NOT NULL AND artist != ''
)
GROUP BY LOWER(artist);

-- Sentinel "(unknown)" artist for any row whose source had no artist string.
-- Guarantees we always have a FK target without making artist_id nullable.
INSERT INTO artist (id, name)
SELECT lower(hex(randomblob(8))), '(unknown)'
WHERE NOT EXISTS (SELECT 1 FROM artist WHERE LOWER(name) = '(unknown)');

-- 3. Recreate release with artist_id NOT NULL; drop denormalized artist column.
CREATE TABLE release_new (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  artist_id   TEXT NOT NULL REFERENCES artist(id) ON DELETE RESTRICT,
  year        INTEGER,
  country     TEXT,
  label       TEXT,
  catno       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO release_new (id, title, artist_id, year, country, label, catno, created_at, updated_at)
SELECT
  r.id, r.title,
  COALESCE(
    (SELECT a.id FROM artist a WHERE LOWER(a.name) = LOWER(r.artist) LIMIT 1),
    (SELECT a.id FROM artist a WHERE a.name = '(unknown)' LIMIT 1)
  ),
  r.year, r.country, r.label, r.catno, r.created_at, r.updated_at
FROM release r;
DROP TABLE release;
ALTER TABLE release_new RENAME TO release;
CREATE INDEX idx_release_artist ON release(artist_id);

-- 4. Recreate track similarly.
CREATE TABLE track_new (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  artist_id    TEXT NOT NULL REFERENCES artist(id) ON DELETE RESTRICT,
  album        TEXT,
  duration_ms  INTEGER,
  release_id   TEXT REFERENCES release(id) ON DELETE SET NULL,
  position     TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO track_new (id, title, artist_id, album, duration_ms, release_id, position, created_at, updated_at)
SELECT
  t.id, t.title,
  COALESCE(
    (SELECT a.id FROM artist a WHERE LOWER(a.name) = LOWER(t.artist) LIMIT 1),
    (SELECT a.id FROM artist a WHERE a.name = '(unknown)' LIMIT 1)
  ),
  t.album, t.duration_ms, t.release_id, t.position, t.created_at, t.updated_at
FROM track t;
DROP TABLE track;
ALTER TABLE track_new RENAME TO track;
CREATE INDEX idx_track_artist ON track(artist_id);
CREATE INDEX idx_track_release ON track(release_id);

-- 5. Extend source_link.entity_kind to include 'artist'.
CREATE TABLE source_link_new (
  entity_kind   TEXT NOT NULL CHECK (entity_kind IN ('track','release','artist')),
  entity_id     TEXT NOT NULL,
  source        TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  external_url  TEXT,
  match_method  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (entity_kind, source, external_id),
  UNIQUE      (entity_kind, entity_id, source)
);
INSERT INTO source_link_new SELECT * FROM source_link;
DROP TABLE source_link;
ALTER TABLE source_link_new RENAME TO source_link;
CREATE INDEX idx_source_link_entity ON source_link(entity_kind, entity_id);

-- 6. Extend source_facets.entity_kind to include 'artist'.
CREATE TABLE source_facets_new (
  entity_kind  TEXT NOT NULL CHECK (entity_kind IN ('track','release','artist')),
  entity_id    TEXT NOT NULL,
  source       TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (entity_kind, entity_id, source, key)
);
INSERT INTO source_facets_new SELECT * FROM source_facets;
DROP TABLE source_facets;
ALTER TABLE source_facets_new RENAME TO source_facets;

-- 7. Extend match_key.entity_kind to include 'artist'.
CREATE TABLE match_key_new (
  entity_kind  TEXT NOT NULL CHECK (entity_kind IN ('track','release','artist')),
  entity_id    TEXT NOT NULL,
  key_type     TEXT NOT NULL,
  key_value    TEXT NOT NULL,
  PRIMARY KEY (entity_kind, key_type, key_value),
  UNIQUE      (entity_kind, entity_id, key_type)
);
INSERT INTO match_key_new SELECT * FROM match_key;
DROP TABLE match_key;
ALTER TABLE match_key_new RENAME TO match_key;
CREATE INDEX idx_match_key_entity ON match_key(entity_kind, entity_id);
