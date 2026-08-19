import type { Database } from 'bun:sqlite';

/**
 * Connection pragmas every Booth DB handle needs. Kept out of `index.ts` so
 * verification scripts can exercise it without pulling in `$lib/server/env`,
 * which does not resolve outside SvelteKit.
 */
export function applyPragmas(db: Database): void {
  db.exec('PRAGMA journal_mode = WAL');
  // Without a busy timeout SQLite fails a contended write immediately with
  // SQLITE_BUSY rather than waiting for the lock. One process was the norm
  // historically, so this never bit; the sync scheduler in an always-on
  // server plus a `bun dev` session alongside it makes two writers, and WAL
  // still permits only one at a time.
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
}
