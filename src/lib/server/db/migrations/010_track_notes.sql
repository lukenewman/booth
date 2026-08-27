-- Track notes: short free-text blurbs the user writes while listening.
--
-- A column rather than a side table for the same reason as starred_at: a note
-- is strictly 1:1 with its track. NULL means no note; the empty string is
-- normalised to NULL on write so "has a note" is a single check.
--
-- Like the other annotations this is hand-entered data that exists nowhere
-- else, so every write is mirrored into the append-only journal
-- (src/lib/server/backup/journal.ts) rather than trusting the database alone.

ALTER TABLE track ADD COLUMN note TEXT;

-- Partial, like the star index: most tracks will never carry a note, so the
-- index stays proportional to the notes that exist rather than to the table.
CREATE INDEX idx_track_note ON track(id) WHERE note IS NOT NULL;
