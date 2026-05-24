CREATE TABLE sync_run (
  id           TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at  TEXT,
  summary      TEXT,
  error        TEXT
);
CREATE INDEX idx_sync_run_source_started ON sync_run(source, started_at DESC);
