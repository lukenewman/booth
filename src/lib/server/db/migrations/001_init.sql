CREATE TABLE release (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL,
  year        INTEGER,
  country     TEXT,
  label       TEXT,
  catno       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE track (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  artist       TEXT NOT NULL,
  album        TEXT,
  duration_ms  INTEGER,
  release_id   TEXT REFERENCES release(id) ON DELETE SET NULL,
  position     TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE source_link (
  entity_kind   TEXT NOT NULL CHECK (entity_kind IN ('track','release')),
  entity_id     TEXT NOT NULL,
  source        TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  external_url  TEXT,
  match_method  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (entity_kind, source, external_id),
  UNIQUE      (entity_kind, entity_id, source)
);
CREATE INDEX idx_source_link_entity ON source_link(entity_kind, entity_id);

CREATE TABLE source_facets (
  entity_kind  TEXT NOT NULL CHECK (entity_kind IN ('track','release')),
  entity_id    TEXT NOT NULL,
  source       TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (entity_kind, entity_id, source, key)
);

CREATE TABLE match_key (
  entity_kind  TEXT NOT NULL CHECK (entity_kind IN ('track','release')),
  entity_id    TEXT NOT NULL,
  key_type     TEXT NOT NULL,
  key_value    TEXT NOT NULL,
  PRIMARY KEY (entity_kind, key_type, key_value),
  UNIQUE      (entity_kind, entity_id, key_type)
);
CREATE INDEX idx_match_key_entity ON match_key(entity_kind, entity_id);
