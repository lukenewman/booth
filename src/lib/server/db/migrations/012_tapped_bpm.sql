-- A BPM the user tapped out against the record itself.
--
-- Booth-native, like starred_at / vetted_at / note: it is the user's own
-- measurement, not a source's opinion, so it lives on the entity rather than in
-- source_facets and sync never touches it. It exists for the ~1,200 tracks with
-- no audio file behind them — vinyl the app knows about through Discogs but
-- cannot analyse — where a tap is the only reading taken from the pressing
-- actually on the deck.
--
-- Whole numbers: tapping jitter is far wider than a decimal, so storing one
-- would be false precision. The resolver's plausibility range still applies on
-- read, so a bad row renders as no reading rather than as a wrong one.
--
-- No index. Unlike stars there is no "show me the tapped ones" view; the column
-- is read by id alongside the track row it hangs off.

ALTER TABLE track ADD COLUMN tapped_bpm    INTEGER;  -- NULL = never tapped
ALTER TABLE track ADD COLUMN tapped_bpm_at TEXT;     -- ISO8601; when it was measured
