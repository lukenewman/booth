import { Database } from 'bun:sqlite';
import { env } from '$lib/server/env';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runMigrations } from './migrate';

const DEFAULT_PATH = join(homedir(), '.booth', 'booth.db');

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  const path = env.BOOTH_DB_PATH ?? DEFAULT_PATH;
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  _db = db;
  return db;
}
