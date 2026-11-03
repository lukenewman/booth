/**
 * The sample takeover's suggestion (BOO-102 step 6a). Load-bearing claims:
 *  - ten releases, random but with one of each awkward kind the library has:
 *    an M4A, a release with a duplicate, a Discogs-paired one, one with a
 *    star or note, a WAV;
 *  - the same seed draws the same sample, another seed ("draw again") another;
 *  - never a release with a missing file or one already taken over.
 * An in-memory database built by hand.
 *
 * Run: bun verify scripts/verify-takeover-sample.ts
 */
import { Database } from 'bun:sqlite';
import { runMigrations } from '../src/lib/server/db/migrate';
import { suggestSample } from '../src/lib/server/takeover/sample';

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) fail(msg); }

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON');
runMigrations(db);
db.prepare(`INSERT INTO artist (id, name) VALUES ('a', 'Artist')`).run();

let n = 0;
function release(kind: string, opts: { ext?: string; missing?: boolean; taken?: boolean; discogs?: boolean; starred?: boolean; dup?: boolean } = {}) {
  const r = `r${++n}`;
  db.prepare(`INSERT INTO release (id, title, artist_id) VALUES (?, ?, 'a')`).run(r, `${kind} ${n}`);
  const t = `t${n}`, f = `f${n}`;
  db.prepare(`INSERT INTO track (id, title, artist_id, release_id, position, starred_at) VALUES (?, ?, 'a', ?, '1', ?)`).run(t, `T${n}`, r, opts.starred ? '2026-01-01' : null);
  db.prepare(`INSERT INTO audio_file (id, path, fingerprint, size, present) VALUES (?, ?, ?, 1000, ?)`).run(f, `/m/${n}.${opts.ext ?? 'mp3'}`, `fp${n}`, opts.missing ? 0 : 1);
  db.prepare(`INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method) VALUES ('track', ?, 'local', ?, 'test')`).run(t, f);
  if (opts.discogs) db.prepare(`INSERT INTO source_link (entity_kind, entity_id, source, external_id, match_method) VALUES ('release', ?, 'discogs', ?, 'test')`).run(r, `d${n}`);
  if (opts.dup) db.prepare(`INSERT INTO finding (id, kind, subject_key, file_ids) VALUES (?, 'duplicate', ?, ?)`).run(`dup${n}`, `fp${n}:x`, JSON.stringify([f, 'other']));
  if (opts.taken) {
    db.prepare(`INSERT INTO audio_file (id, path, ownership, copy_of) VALUES (?, ?, 'booth', ?)`).run(`c${n}`, `/booth/${n}.mp3`, f);
    db.prepare(`UPDATE source_link SET external_id = ? WHERE external_id = ?`).run(`c${n}`, f);
  }
  return r;
}
for (let i = 0; i < 40; i++) release('plain');
const special = {
  m4a: release('m4a', { ext: 'm4a' }),
  wav: release('wav', { ext: 'wav' }),
  discogs: release('discogs', { discogs: true }),
  starred: release('starred', { starred: true }),
  dup: release('dup', { dup: true }),
};
const missing = release('missing', { missing: true, starred: true });
const taken = release('taken', { taken: true, discogs: true });

const a = suggestSample(db, { seed: 1 });
assert(a.length === 10, `ten releases, got ${a.length}`);
for (const [kind, id] of Object.entries(special)) assert(a.some((x) => x.releaseId === id), `includes the ${kind} release, got ${JSON.stringify(a.map((x) => x.title))}`);
assert(a.find((x) => x.releaseId === special.m4a)!.reasons.some((r) => /M4A/.test(r)), 'says why it was picked');
assert(!a.some((x) => x.releaseId === missing || x.releaseId === taken), 'never a missing or taken-over release');
assert(JSON.stringify(suggestSample(db, { seed: 1 })) === JSON.stringify(a), 'the same seed draws the same sample');
const b = suggestSample(db, { seed: 2 });
assert(JSON.stringify(b.map((x) => x.releaseId).sort()) !== JSON.stringify(a.map((x) => x.releaseId).sort()), 'another seed draws another');
assert(suggestSample(db, { seed: 3, size: 3 }).length === 3, 'size is honoured');
console.log('PASS verify-takeover-sample');
