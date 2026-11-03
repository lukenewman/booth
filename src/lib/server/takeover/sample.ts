import type { Database } from 'bun:sqlite';

/**
 * The sample takeover's suggestion: about ten releases, random, but spread so
 * the first takeover meets the awkward cases while it's small and undoable.
 * Never a release with a missing file or one already taken over.
 */

export interface SampleRelease {
  releaseId: string;
  title: string;
  artist: string;
  files: number;
  bytes: number;
  reasons: string[];
}

interface Candidate extends SampleRelease { kinds: Set<Kind> }
type Kind = 'm4a' | 'duplicate' | 'discogs' | 'annotated' | 'wav';

const REASON: Record<Kind, string> = {
  m4a: 'M4A: rekordbox can’t see stars on these',
  duplicate: 'has a duplicate in Needs attention',
  discogs: 'paired with Discogs',
  annotated: 'starred or has a note',
  wav: 'WAV: can’t carry tags, so its stars stay in Booth only',
};
const ORDER: Kind[] = ['m4a', 'duplicate', 'discogs', 'annotated', 'wav'];

/** A small seeded generator (mulberry32), so "draw again" is a new seed and a seed is repeatable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function candidates(db: Database): Candidate[] {
  const rows = db
    .prepare(
      `SELECT r.id AS releaseId, r.title, a.name AS artist, f.id AS fileId, f.path, f.size, f.present, f.excluded, f.ownership,
              (SELECT 1 FROM audio_file c WHERE c.copy_of = f.id) AS hasCopy,
              t.starred_at IS NOT NULL OR t.note IS NOT NULL AS annotated,
              EXISTS (SELECT 1 FROM source_link d WHERE d.entity_kind = 'release' AND d.source = 'discogs' AND d.entity_id = r.id) AS discogs
         FROM release r
         JOIN artist a ON a.id = r.artist_id
         JOIN track t ON t.release_id = r.id
         JOIN source_link sl ON sl.source = 'local' AND sl.entity_kind = 'track' AND sl.entity_id = t.id
         JOIN audio_file f ON f.id = sl.external_id`,
    )
    .all() as { releaseId: string; title: string; artist: string; fileId: string; path: string; size: number | null; present: number; excluded: number; ownership: string; hasCopy: number | null; annotated: number; discogs: number }[];
  const dupFiles = new Set<string>();
  for (const f of db.prepare(`SELECT file_ids FROM finding WHERE kind = 'duplicate' AND state = 'open'`).all() as { file_ids: string }[]) {
    for (const id of JSON.parse(f.file_ids) as string[]) dupFiles.add(id);
  }
  const by = new Map<string, Candidate & { blocked: boolean }>();
  for (const r of rows) {
    let c = by.get(r.releaseId);
    if (!c) { c = { releaseId: r.releaseId, title: r.title, artist: r.artist, files: 0, bytes: 0, reasons: [], kinds: new Set(), blocked: false }; by.set(r.releaseId, c); }
    if (!r.present || r.excluded || r.ownership === 'booth' || r.hasCopy) c.blocked = true;
    c.files++;
    c.bytes += r.size ?? 0;
    const ext = r.path.toLowerCase().split('.').pop();
    if (ext === 'm4a') c.kinds.add('m4a');
    if (ext === 'wav') c.kinds.add('wav');
    if (dupFiles.has(r.fileId)) c.kinds.add('duplicate');
    if (r.discogs) c.kinds.add('discogs');
    if (r.annotated) c.kinds.add('annotated');
  }
  return [...by.values()].filter((c) => !c.blocked).map(({ blocked: _, ...c }) => c).sort((a, b) => a.releaseId.localeCompare(b.releaseId));
}

export function suggestSample(db: Database, opts: { size?: number; seed?: number } = {}): SampleRelease[] {
  const size = opts.size ?? 10;
  const random = rng(opts.seed ?? Date.now());
  const pool = candidates(db);
  // A seeded shuffle, then one release per awkward kind first, then the rest in shuffled order.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked: Candidate[] = [];
  for (const kind of ORDER) {
    if (picked.length >= size) break;
    if (picked.some((p) => p.kinds.has(kind))) continue;
    const c = pool.find((x) => x.kinds.has(kind) && !picked.includes(x));
    if (c) picked.push(c);
  }
  for (const c of pool) {
    if (picked.length >= size) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked.map(({ kinds, ...c }) => ({ ...c, reasons: ORDER.filter((k) => kinds.has(k)).map((k) => REASON[k]) }));
}
