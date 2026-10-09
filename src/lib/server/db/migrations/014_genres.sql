-- Genres and styles. Evidence is stored per source; release_genre holds the
-- one resolved answer that filters, pills and smart playlists read. See
-- docs/superpowers/specs/2026-10-09-genres-design.md.

-- Bandcamp purchases (the fan collection) and what their pages said.
-- Keyed by Bandcamp's own item id so a re-match never re-fetches a page.
CREATE TABLE bandcamp_item (
  item_id          TEXT PRIMARY KEY,           -- "<tralbum_type><tralbum_id>", e.g. a123
  url              TEXT NOT NULL,
  item_type        TEXT NOT NULL CHECK (item_type IN ('album','track')),
  artist           TEXT NOT NULL,              -- band_name
  title            TEXT NOT NULL,              -- item_title
  album_title      TEXT,
  primary_genre    TEXT,                       -- Bandcamp norm_name, e.g. 'electronic'
  tags             TEXT,                       -- JSON array, NULL until the page is fetched
  purchased_at     TEXT,
  page_fetched_at  TEXT,
  page_error       TEXT,
  release_id       TEXT REFERENCES release(id) ON DELETE SET NULL,
  match_state      TEXT NOT NULL DEFAULT 'unmatched' CHECK (match_state IN ('matched','ambiguous','unmatched'))
);
CREATE INDEX idx_bandcamp_item_release ON bandcamp_item(release_id);

-- Hand-set tags. Never touched by sync; journaled to annotations.log.
CREATE TABLE release_tag_manual (
  release_id  TEXT PRIMARY KEY REFERENCES release(id) ON DELETE CASCADE,
  genres      TEXT NOT NULL,                   -- JSON array
  styles      TEXT NOT NULL,                   -- JSON array
  set_at      TEXT NOT NULL
);

-- The resolved answer. Rebuilt by resolveGenres.
CREATE TABLE release_genre (
  release_id  TEXT NOT NULL REFERENCES release(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('genre','style')),
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL,
  origin      TEXT NOT NULL CHECK (origin IN ('manual','discogs','bandcamp','file')),
  PRIMARY KEY (release_id, kind, name)
);
CREATE INDEX idx_release_genre_name ON release_genre(kind, name);

-- Style → palette slot. Colours never move on their own; pinned = set by hand.
CREATE TABLE style_color (
  style   TEXT PRIMARY KEY,
  slot    INTEGER NOT NULL,
  pinned  INTEGER NOT NULL DEFAULT 0
);

-- Non-null makes a playlist smart: evaluated on open, never stored as membership.
ALTER TABLE playlist ADD COLUMN rule TEXT;
