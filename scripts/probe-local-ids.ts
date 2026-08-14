/**
 * probe-local-ids.ts — diagnostic: why are XML tracks failing to link?
 *
 * Replays collate's match logic (read-only) for every XML track that currently
 * has no source_link, and reports which branch blocked it.
 */
import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseITunesLibrary } from '../src/lib/server/sources/local/parse';
import { normalizeFilePath } from '../src/lib/server/library/normalize';

const xmlPath = process.env.ITUNES_XML_PATH ?? join(homedir(), 'Music', 'Library.xml');
const db = new Database(join(homedir(), '.booth', 'booth.db'), { readonly: true });

const lib = parseITunesLibrary(xmlPath);
const linked = new Set(
  (
    db
      .prepare(`SELECT external_id FROM source_link WHERE source='local' AND entity_kind='track'`)
      .all() as { external_id: string }[]
  ).map((r) => r.external_id),
);

const unlinked = lib.tracks.filter((t) => !linked.has((t.persistentId ?? String(t.trackId))));
console.log(`Unlinked XML tracks: ${unlinked.length} of ${lib.tracks.length}\n`);

// Which entity does each unlinked track's file path resolve to, and what local
// link does that entity already hold?
const byFp = db.prepare(
  `SELECT entity_id FROM match_key
    WHERE entity_kind='track' AND key_type='file_path' AND key_value=?`,
);
const linkOfEntity = db.prepare(
  `SELECT external_id FROM source_link
    WHERE entity_kind='track' AND entity_id=? AND source='local'`,
);

let fpHitsOtherLink = 0;
let fpNoMatch = 0;
const samples: string[] = [];
for (const t of unlinked) {
  const fp = t.location ? normalizeFilePath(t.location) : null;
  const hit = fp ? (byFp.get(fp) as { entity_id: string } | undefined) : undefined;
  if (hit) {
    const held = linkOfEntity.get(hit.entity_id) as { external_id: string } | undefined;
    if (held && held.external_id !== (t.persistentId ?? String(t.trackId))) {
      fpHitsOtherLink++;
      if (samples.length < 5) {
        samples.push(
          `  "${t.name}" (XML id ${t.trackId}) → entity ${hit.entity_id} already linked to id ${held.external_id}`,
        );
      }
    }
  } else {
    fpNoMatch++;
  }
}
console.log(`file_path resolves to an entity already holding a DIFFERENT local id: ${fpHitsOtherLink}`);
console.log(`file_path matches nothing in Booth (genuinely new file): ${fpNoMatch}`);
if (samples.length) console.log(`\nsamples:\n${samples.join('\n')}`);

// Are duplicate file paths the cause? Count XML tracks sharing a normalized path.
const pathCounts = new Map<string, number>();
for (const t of lib.tracks) {
  if (!t.location) continue;
  const fp = normalizeFilePath(t.location);
  pathCounts.set(fp, (pathCounts.get(fp) ?? 0) + 1);
}
const dupPaths = [...pathCounts.values()].filter((n) => n > 1);
console.log(
  `\nXML tracks sharing a normalized file path: ${dupPaths.reduce((a, b) => a + b, 0)} rows across ${dupPaths.length} paths`,
);

// What did the user actually add recently? Group unlinked by album.
const byAlbum = new Map<string, { n: number; newest: string }>();
for (const t of unlinked) {
  const key = `${t.albumArtist ?? t.artist} — ${t.album ?? '(no album)'}`;
  const cur = byAlbum.get(key) ?? { n: 0, newest: '' };
  cur.n++;
  if ((t.dateAdded ?? '') > cur.newest) cur.newest = t.dateAdded ?? '';
  byAlbum.set(key, cur);
}
const recent = [...byAlbum.entries()].sort((a, b) => b[1].newest.localeCompare(a[1].newest));
console.log(`\nUnlinked albums (${byAlbum.size} total), 15 most recently added:`);
for (const [name, v] of recent.slice(0, 15)) {
  console.log(`  ${v.newest.slice(0, 10)}  ${v.n.toString().padStart(3)} tracks  ${name}`);
}
