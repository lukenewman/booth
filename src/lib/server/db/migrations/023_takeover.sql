-- Takeover (BOO-102 step 6a): Booth copies a release's files into its own
-- folder and the release's tracks switch to the copies. A copy is an
-- ordinary file-list row owned by Booth that names the original it replaced;
-- an original with a copy is "superseded": sync, findings, rekordbox and
-- backups treat the copy as the track's file. Originals are never changed.
ALTER TABLE audio_file ADD COLUMN copy_of TEXT REFERENCES audio_file(id);
CREATE INDEX audio_file_copy_of ON audio_file(copy_of);

-- A takeover job, release by release. A release flips only when every file
-- succeeded; `failed` carries why, `undone` that it was handed back.
CREATE TABLE takeover_run (
  id             TEXT PRIMARY KEY,
  started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at    TEXT,
  state          TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'done', 'failed', 'stopped')),
  sample         INTEGER NOT NULL DEFAULT 0,
  releases_total INTEGER NOT NULL DEFAULT 0,
  releases_done  INTEGER NOT NULL DEFAULT 0,
  bytes_total    INTEGER NOT NULL DEFAULT 0,
  bytes_done     INTEGER NOT NULL DEFAULT 0,
  error          TEXT
);
CREATE TABLE takeover_release (
  run_id      TEXT NOT NULL REFERENCES takeover_run(id) ON DELETE CASCADE,
  release_id  TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed', 'undone')),
  error       TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, release_id)
);
CREATE INDEX takeover_release_release ON takeover_release(release_id);

-- Findings gain the takeover kind (a release that couldn't be taken over,
-- and why: `detail`). The kind is a CHECK, so the table is rebuilt.
CREATE TABLE finding_new (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('missing', 'duplicate', 'unsupported', 'takeover')),
  subject_key   TEXT NOT NULL,
  file_ids      TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'settled', 'cleared')),
  resolution    TEXT,
  raised_run_id TEXT,
  raised_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  settled_at    TEXT,
  cleared_at    TEXT,
  detail        TEXT,
  UNIQUE (kind, subject_key)
);
INSERT INTO finding_new (id, kind, subject_key, file_ids, state, resolution, raised_run_id, raised_at, settled_at, cleared_at)
  SELECT id, kind, subject_key, file_ids, state, resolution, raised_run_id, raised_at, settled_at, cleared_at FROM finding;
DROP TABLE finding;
ALTER TABLE finding_new RENAME TO finding;
CREATE INDEX finding_state ON finding(state);
