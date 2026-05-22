import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/lib/server/db/migrate';

const db = new Database(':memory:');
runMigrations(db);

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r: any) => r.name);

const expected = ['_migrations', 'match_key', 'release', 'source_facets', 'source_link', 'track'];
for (const t of expected) {
  if (!tables.includes(t)) {
    console.error(`MISSING TABLE: ${t}`);
    process.exit(1);
  }
}

const applied = db.prepare('SELECT id FROM _migrations').all();
if (applied.length === 0) {
  console.error('No migrations recorded after runMigrations');
  process.exit(1);
}

// Re-run to confirm idempotency
runMigrations(db);
const applied2 = db.prepare('SELECT id FROM _migrations').all();
if (applied2.length !== applied.length) {
  console.error(`Re-run not idempotent: ${applied.length} → ${applied2.length}`);
  process.exit(1);
}

console.log('OK: tables created, migration recorded, re-run idempotent');
