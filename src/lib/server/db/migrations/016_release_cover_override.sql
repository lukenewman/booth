-- A cover set by hand. Booth-native like vetted_at: copied into thumb_url /
-- cover_url for display, and while it is set no sync or backfill replaces
-- those (collate's release upsert checks it). NULL = the sources decide.
ALTER TABLE release ADD COLUMN cover_override TEXT;
