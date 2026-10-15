-- A title set by hand. Booth-native like cover_override: while it is set,
-- sync shows it instead of the source's title and matches on it, so a local
-- album tagged "ITLP19 - Resort" can pair with Discogs' "Resort". NULL = the
-- sources decide.
ALTER TABLE release ADD COLUMN title_override TEXT;
