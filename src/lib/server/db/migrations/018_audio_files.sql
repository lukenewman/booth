-- One row per audio file Booth knows about, wherever it lives. The track a
-- file backs is found through the local source_link, whose external_id is this
-- row's id. Identity across moves is the fingerprint: a hash of the coded audio
-- stream, unchanged by tag writes and renames.
--
-- size and mtime_ms are those of the last read; a file whose size and mtime
-- still match is not read again. fingerprint_tried is 1 once ffmpeg has had a
-- go (success or a per-file failure), so an unfingerprintable file isn't
-- retried every sync; it stays 0 when ffmpeg was missing, so the file is
-- fingerprinted once ffmpeg turns up.
CREATE TABLE audio_file (
  id                TEXT PRIMARY KEY,
  path              TEXT NOT NULL UNIQUE,
  fingerprint       TEXT,
  fingerprint_tried INTEGER NOT NULL DEFAULT 0,
  size              INTEGER,
  mtime_ms          INTEGER,
  tags              TEXT,
  ownership         TEXT NOT NULL DEFAULT 'in_place' CHECK (ownership IN ('in_place', 'booth')),
  present           INTEGER NOT NULL DEFAULT 1,
  missing_since     TEXT,
  first_seen_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at      TEXT
);
CREATE INDEX audio_file_fingerprint ON audio_file(fingerprint);

-- A catalog (Music.app today, rekordbox later) listing a file under its own id.
-- The catalog's id is what recognises a file the catalog itself moved, such
-- as Music.app renaming a folder after a retag.
CREATE TABLE catalog_entry (
  catalog    TEXT NOT NULL,
  catalog_id TEXT NOT NULL,
  file_id    TEXT NOT NULL REFERENCES audio_file(id) ON DELETE CASCADE,
  location   TEXT NOT NULL,
  seen_at    TEXT NOT NULL,
  PRIMARY KEY (catalog, catalog_id)
);
CREATE INDEX catalog_entry_file ON catalog_entry(file_id);
