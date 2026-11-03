-- Folders the user pointed Booth at. Every audio file under one is in the
-- file list, read in place; files no catalog lists become tracks from their
-- own tags. Booth's own folder and the drop folder are not listed here.
CREATE TABLE folder_source (
  id        TEXT PRIMARY KEY,
  path      TEXT NOT NULL UNIQUE,
  added_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
