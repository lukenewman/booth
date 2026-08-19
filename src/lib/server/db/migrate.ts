import type { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Where the .sql files live at runtime.
 *
 * In dev — and in the `scripts/verify-*.ts` runners, which import this module
 * directly under bare Bun — `migrations/` sits next to this file. The
 * production build breaks that assumption: Rollup relocates this module to
 * `build/server/chunks/chunks/`, and the SQL files do not move with it, so the
 * sibling lookup resolves to a directory that was never created.
 *
 * So try the sibling first, then the repo-relative path. The built server is
 * started from the repo root (`bun start` → `bun ./build/index.js`), which is
 * also where the checkout that produced the build lives.
 *
 * Deliberately not bundled into JS: keeping migrations as plain .sql files a
 * developer can drop in is worth more than making `build/` self-contained for
 * a single-user app that is served from its own checkout.
 */
function resolveMigrationsDir(): string {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), 'migrations'),
    join(process.cwd(), 'src', 'lib', 'server', 'db', 'migrations'),
  ];
  const found = candidates.find((dir) => existsSync(dir));
  if (!found) {
    throw new Error(
      `migrations directory not found (looked in: ${candidates.join(', ')}). ` +
        'The production server must be started from the repository root.',
    );
  }
  return found;
}

export function runMigrations(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);

  const applied = new Set(
    db.prepare('SELECT id FROM _migrations').all().map((r: any) => r.id),
  );

  const migrationsDir = resolveMigrationsDir();
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (id) VALUES (?)').run(file);
    });
    tx();
    console.log(`[db] applied ${file}`);
  }
}
