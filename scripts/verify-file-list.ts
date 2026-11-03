/**
 * The file list: one row per audio file Booth knows, identified by its audio
 * fingerprint, read through a size+mtime cache. Temp dirs and an in-memory
 * database only.
 *
 * Run: bun verify scripts/verify-file-list.ts
 */
import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/lib/server/db/migrate';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return db;
}

// --- schema --------------------------------------------------------
{
  const db = freshDb();
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
  for (const c of ['id', 'path', 'fingerprint', 'fingerprint_tried', 'size', 'mtime_ms', 'tags', 'ownership', 'present', 'missing_since'])
    assert(cols('audio_file').includes(c), `audio_file.${c}`);
  for (const c of ['catalog', 'catalog_id', 'file_id', 'location', 'seen_at'])
    assert(cols('catalog_entry').includes(c), `catalog_entry.${c}`);
}

console.log('PASS: file list');
