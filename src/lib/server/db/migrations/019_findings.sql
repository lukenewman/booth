-- A file the user took out of the library from the "needs attention" list
-- (kept another copy, or forgot a missing track). The local result skips it,
-- so the ordinary prune removes its track; the row stays so the decision
-- survives every later sync, and findings ignore it.
ALTER TABLE audio_file ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;

-- The "needs attention" list. One row per (kind, subject): the subject is a
-- file id for missing and unsupported, and fingerprint + the sorted file ids
-- for a duplicate, so a third copy is a new subject and a new finding.
--   open     raised and waiting for the user
--   settled  the user decided; never reopened for the same subject
--   cleared  the problem went away on its own; reopens if it returns
CREATE TABLE finding (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('missing', 'duplicate', 'unsupported')),
  subject_key   TEXT NOT NULL,
  file_ids      TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'settled', 'cleared')),
  resolution    TEXT,
  raised_run_id TEXT,
  raised_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  settled_at    TEXT,
  cleared_at    TEXT,
  UNIQUE (kind, subject_key)
);
CREATE INDEX finding_state ON finding(state);
