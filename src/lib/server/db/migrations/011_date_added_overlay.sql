-- Recovered acquisition dates from the old MacBook's Music library.
--
-- The current library was created fresh when the files moved machines on
-- 2025-08-25 rather than being migrated, so Music.app reports that one day as
-- Date Added for ~91% of tracks and the real 2009-2025 history survives only
-- in a manual export taken from the old machine. This table holds the graft:
-- built once from that export, read by the Apple Music import on every sync.
--
-- Keyed on the track's path below the media root, not its Persistent ID. The
-- two libraries share zero persistent IDs (Music.app minted new ones for the
-- new library) and zero absolute paths (different home directory, and the new
-- media tree carries an extra folder level), but the path below the media root
-- came through the move intact.
CREATE TABLE IF NOT EXISTS date_added_overlay (
  media_path   TEXT PRIMARY KEY,
  date_added   TEXT NOT NULL,
  match_method TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
