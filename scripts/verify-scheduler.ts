/**
 * verify-scheduler.ts — sync scheduling and connection pragmas.
 *
 * Covers the two defects that only appear on an always-on server: boot-only
 * syncing (the library silently stops updating) and an unset busy_timeout
 * (a second writer fails immediately instead of waiting).
 *
 * Run: bun verify scripts/verify-scheduler.ts
 */
import { Database } from 'bun:sqlite';
import { applyPragmas } from '../src/lib/server/db/pragmas';
import { createScheduler, parseIntervalMinutes } from '../src/lib/server/library/scheduler';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

// --- interval parsing ------------------------------------------------------

check('unset → default', parseIntervalMinutes(undefined), 360);
check('blank → default', parseIntervalMinutes('   '), 360);
check('explicit 0 disables', parseIntervalMinutes('0'), 0);
check('explicit 15', parseIntervalMinutes('15'), 15);
// A typo must not silently stop syncing — that is the failure mode this whole
// task exists to fix, so unparseable input falls back to the default.
check('garbage → default', parseIntervalMinutes('later'), 360);
check('negative → default', parseIntervalMinutes('-5'), 360);

// --- a tick fires every eligible source ------------------------------------

const calls: string[] = [];
const s1 = createScheduler({
  sourceIds: () => ['discogs', 'local'],
  sync: async (id) => { calls.push(id); },
});
await s1.tick();
check('tick fires each source once', [...calls].sort(), ['discogs', 'local']);

// --- runs must not stack ---------------------------------------------------

const gate = deferred<void>();
const calls2: string[] = [];
const s2 = createScheduler({
  sourceIds: () => ['discogs'],
  sync: async (id) => { calls2.push(id); await gate.promise; },
});

const first = s2.tick(); // deliberately not awaited — leaves discogs in flight
check('source marked in flight', s2.inFlight(), ['discogs']);
await s2.tick();
check('second tick skips the in-flight source', calls2, ['discogs']);
gate.resolve();
await first;
check('lock released after completion', s2.inFlight(), []);
await s2.tick();
check('a later tick runs it again', calls2, ['discogs', 'discogs']);

// --- a failing sync must not wedge the lock --------------------------------

const errs: string[] = [];
const s3 = createScheduler({
  sourceIds: () => ['discogs'],
  sync: async () => { throw new Error('boom'); },
  onError: (id, err) => errs.push(`${id}:${(err as Error).message}`),
});
await s3.tick();
check('onError receives the failure', errs, ['discogs:boom']);
check('lock released after failure', s3.inFlight(), []);

// --- connection pragmas ----------------------------------------------------

const db = new Database(':memory:');
applyPragmas(db);
check('busy_timeout set', (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000);
check('foreign_keys on', (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);

console.log(failures === 0 ? '\nOK: scheduling and pragmas behave' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
