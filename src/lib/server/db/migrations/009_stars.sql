-- Booth-native annotations: the user's own judgments about their collection.
-- Like playlists, these never touch source_link / source_facets / match_key.
-- Unlike playlists they need no join table — a star is strictly 1:1 with its
-- track, and vetted-ness 1:1 with its release — so they are columns here.
--
-- Timestamps rather than booleans: truthiness is `IS NOT NULL` (identical cost
-- to a 0/1 check) but the column also answers "what did I star recently" and
-- "when did I go through this record". A boolean discards that for no saving.
--
-- `vetted_at` records that the user listened through a release and made their
-- calls. It cannot be derived from "has starred tracks": that would conflate
-- "not listened to yet" with "listened to and nothing made the cut", and would
-- permanently re-surface every record already dismissed.

ALTER TABLE track   ADD COLUMN starred_at TEXT;  -- ISO8601; NULL = not starred
ALTER TABLE release ADD COLUMN vetted_at  TEXT;  -- ISO8601; NULL = not vetted

-- Partial: the starred set stays small against ~5,700 tracks and the vetted set
-- grows from zero, so each index stays proportional to the data that exists
-- rather than to the table it hangs off.
CREATE INDEX idx_track_starred  ON track(starred_at)   WHERE starred_at IS NOT NULL;
CREATE INDEX idx_release_vetted ON release(vetted_at)  WHERE vetted_at  IS NOT NULL;
