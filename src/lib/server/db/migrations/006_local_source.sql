-- Merge the iTunes source into the renamed 'local' source. Apple Music
-- imports and vinyl rips are two ingest paths of one local-files source.
UPDATE source_link   SET source='local' WHERE source='itunes';
UPDATE source_facets SET source='local' WHERE source='itunes';
UPDATE source_state  SET source='local' WHERE source='itunes';
UPDATE sync_run      SET source='local' WHERE source='itunes';
