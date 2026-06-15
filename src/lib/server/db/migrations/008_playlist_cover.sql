-- Playlist cover art. NULL → the UI builds a mosaic from the playlist's track
-- cover art; non-NULL → a custom uploaded image (served from ~/.booth/artwork/
-- via /api/artwork, like every other cached cover).
ALTER TABLE playlist ADD COLUMN cover_url TEXT;
