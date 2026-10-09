-- The purchase's cover image id from the fan collection list, so a release
-- whose files carry no artwork can borrow Bandcamp's (see artworkBackfill.ts).
ALTER TABLE bandcamp_item ADD COLUMN art_id TEXT;
