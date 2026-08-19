import { Database } from 'bun:sqlite';
import { env } from '$lib/server/env';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runMigrations } from './migrate';
import { applyPragmas } from './pragmas';

const DEFAULT_PATH = join(homedir(), '.booth', 'booth.db');

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  const path = env.BOOTH_DB_PATH ?? DEFAULT_PATH;
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  applyPragmas(db);
  runMigrations(db);
  _db = db;
  return db;
}
