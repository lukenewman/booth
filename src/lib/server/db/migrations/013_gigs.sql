-- Gigs: a playlist may carry ordered, user-named sections (the sketch) and a
-- crate of releases (the records being brought). Still Booth-native — none of
-- these tables touch source_link / match_key / source_facets.
--
-- playlist_track is rebuilt so membership survives a track disappearing from
-- the library (moved file, record leaving the Discogs collection): the FK is
-- now ON DELETE SET NULL and each row keeps a name snapshot, so the UI can show
-- it as missing and the post-sync relink can re-attach it. The old composite
-- primary key cannot hold a nullable track_id, hence the surrogate id; the
-- once-per-playlist rule moves to a partial unique index.

ALTER TABLE playlist ADD COLUMN target_minutes INTEGER;

CREATE TABLE playlist_section (
  id           TEXT PRIMARY KEY,
  playlist_id  TEXT NOT NULL REFERENCES playlist(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  position     INTEGER NOT NULL,
  is_unsorted  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_playlist_section_order ON playlist_section(playlist_id, position);
CREATE UNIQUE INDEX idx_playlist_section_unsorted ON playlist_section(playlist_id) WHERE is_unsorted = 1;

INSERT INTO playlist_section (id, playlist_id, name, position, is_unsorted)
  SELECT 'unsorted-' || id, id, 'Unsorted', 0, 1 FROM playlist;

CREATE TABLE playlist_track_new (
  id             TEXT PRIMARY KEY,
  playlist_id    TEXT NOT NULL REFERENCES playlist(id) ON DELETE CASCADE,
  section_id     TEXT NOT NULL REFERENCES playlist_section(id) ON DELETE CASCADE,
  track_id       TEXT REFERENCES track(id) ON DELETE SET NULL,
  position       INTEGER NOT NULL,
  added_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  snap_artist    TEXT NOT NULL DEFAULT '',
  snap_title     TEXT NOT NULL DEFAULT '',
  snap_album     TEXT,
  snap_position  TEXT
);

INSERT INTO playlist_track_new
    (id, playlist_id, section_id, track_id, position, added_at,
     snap_artist, snap_title, snap_album, snap_position)
  SELECT pt.playlist_id || ':' || pt.track_id, pt.playlist_id, 'unsorted-' || pt.playlist_id,
         pt.track_id, pt.position, pt.added_at,
         COALESCE(a.name, ''), COALESCE(t.title, ''), t.album, t.position
    FROM playlist_track pt
    LEFT JOIN track t  ON t.id = pt.track_id
    LEFT JOIN artist a ON a.id = t.artist_id;

DROP TABLE playlist_track;
ALTER TABLE playlist_track_new RENAME TO playlist_track;

CREATE UNIQUE INDEX idx_playlist_track_member ON playlist_track(playlist_id, track_id) WHERE track_id IS NOT NULL;
CREATE INDEX idx_playlist_track_order ON playlist_track(section_id, position);
CREATE INDEX idx_playlist_track_track ON playlist_track(track_id);

CREATE TABLE playlist_release (
  id           TEXT PRIMARY KEY,
  playlist_id  TEXT NOT NULL REFERENCES playlist(id) ON DELETE CASCADE,
  release_id   TEXT REFERENCES release(id) ON DELETE SET NULL,
  position     INTEGER NOT NULL,
  added_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  snap_artist  TEXT NOT NULL DEFAULT '',
  snap_title   TEXT NOT NULL DEFAULT '',
  snap_year    INTEGER
);
CREATE UNIQUE INDEX idx_playlist_release_member ON playlist_release(playlist_id, release_id) WHERE release_id IS NOT NULL;
CREATE INDEX idx_playlist_release_order ON playlist_release(playlist_id, position);
CREATE INDEX idx_playlist_release_release ON playlist_release(release_id);
