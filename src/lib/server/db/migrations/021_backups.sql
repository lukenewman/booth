-- Booth's own backups (BOO-103). A destination is a folder the user picked
-- (an external drive, a NAS mount, a cloud-synced folder); backup_item is
-- what that destination holds, so "releases not in the last backup" is a
-- query. Nothing is ever deleted from a destination.
--
-- A destination is identified by the id in the marker file Booth writes into
-- its "Booth Backup" folder, not by its path: an unplugged drive, an empty
-- mount point or a different drive at the same path is not the backup, and
-- what a destination holds is only trusted while its marker is there.
-- Switching destinations keeps the others (inactive) with their records.
CREATE TABLE backup_destination (
  id        TEXT PRIMARY KEY,
  kind      TEXT NOT NULL DEFAULT 'folder' CHECK (kind IN ('folder')),
  path      TEXT NOT NULL,
  active    INTEGER NOT NULL DEFAULT 1,
  same_disk INTEGER NOT NULL DEFAULT 0,
  added_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE backup_run (
  id             TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL REFERENCES backup_destination(id) ON DELETE CASCADE,
  started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at    TEXT,
  state          TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'failed', 'stopped')),
  files_total    INTEGER NOT NULL DEFAULT 0,
  files_done     INTEGER NOT NULL DEFAULT 0,
  bytes_total    INTEGER NOT NULL DEFAULT 0,
  bytes_done     INTEGER NOT NULL DEFAULT 0,
  failed         TEXT,
  error          TEXT
);
CREATE INDEX backup_run_started ON backup_run(destination_id, started_at DESC);

CREATE TABLE backup_item (
  destination_id TEXT NOT NULL REFERENCES backup_destination(id) ON DELETE CASCADE,
  file_id        TEXT NOT NULL,
  fingerprint    TEXT,
  -- sha256 of the copy's bytes, checked against the original's at copy time:
  -- what "check every copy" compares against (the fingerprint ignores tags).
  sha256         TEXT,
  size           INTEGER NOT NULL,
  mtime_ms       INTEGER NOT NULL,
  dest_path      TEXT NOT NULL,
  backed_at      TEXT NOT NULL,
  PRIMARY KEY (destination_id, file_id)
);
