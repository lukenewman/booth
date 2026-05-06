CREATE TABLE source_state (
  source          TEXT PRIMARY KEY,
  last_synced_at  TEXT,
  last_summary    TEXT
);
