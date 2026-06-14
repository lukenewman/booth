-- Playlists: a Booth-native organizational layer over the unified `track`
-- table. Not a source — these tables never touch source_link / match_key /
-- source_facets. A track may appear at most once per playlist (the join's
-- composite PK); membership and entities both cascade-delete.

CREATE TABLE playlist (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE playlist_track (
  playlist_id TEXT NOT NULL REFERENCES playlist(id) ON DELETE CASCADE,
  track_id    TEXT NOT NULL REFERENCES track(id)    ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  added_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (playlist_id, track_id)
);
CREATE INDEX idx_playlist_track_order ON playlist_track(playlist_id, position);
