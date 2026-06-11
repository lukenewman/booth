import { mkdirSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { extractRegionToFile, readWavMeta } from './wav';
import { sanitizeName } from './paths';
import type { SessionState } from './session';

/**
 * Writes confirmed regions to disk and the DB. Files are extracted to .part
 * then renamed into place; all DB writes run in one transaction. On any
 * failure, moved files are removed so a release is never half-saved.
 */

export interface CommitRegion {
  takeId: string;
  startMs: number;
  endMs: number;
  trackId: string;
  title: string; // possibly edited in review
}

export interface CommitResult {
  written: number;
  conflicts: string[]; // trackIds that already have a local link (when replace=false)
}

export function commitRegions(
  db: Database,
  root: string,
  session: SessionState,
  regions: CommitRegion[],
  replace: boolean,
): CommitResult {
  // 0. Conflict check first — don't touch disk if we'll 409.
  const conflicts: string[] = [];
  const existingLink = db.prepare(
    `SELECT external_id FROM source_link WHERE entity_kind='track' AND entity_id=? AND source='local'`,
  );
  for (const r of regions) {
    if (existingLink.get(r.trackId)) conflicts.push(r.trackId);
  }
  if (conflicts.length > 0 && !replace) return { written: 0, conflicts };

  // 1. Resolve release info for the directory name + the Discogs release id facet.
  const rel = db
    .prepare(
      `SELECT r.title, r.catno, a.name AS artist
         FROM release r JOIN artist a ON a.id = r.artist_id WHERE r.id = ?`,
    )
    .get(session.releaseId) as { title: string; catno: string | null; artist: string } | undefined;
  if (!rel) throw new Error(`release not found: ${session.releaseId}`);
  const discogsLink = db
    .prepare(
      `SELECT external_id FROM source_link WHERE entity_kind='release' AND entity_id=? AND source='discogs'`,
    )
    .get(session.releaseId) as { external_id: string } | undefined;
  const sourceDiscogsReleaseId = discogsLink?.external_id ?? null;

  const dirLabel = rel.catno ? `${rel.title} [${rel.catno}]` : rel.title;
  const dir = join(root, sanitizeName(`${rel.artist} — ${dirLabel}`));
  mkdirSync(dir, { recursive: true });

  // 2. Extract every region to a .part file, then rename into place.
  const finals: { region: CommitRegion; path: string; sampleRate: number; bitDepth: number }[] = [];
  const parts: string[] = [];
  try {
    for (const r of regions) {
      const take = session.takes.find((t) => t.id === r.takeId);
      if (!take) throw new Error(`unknown take: ${r.takeId}`);
      const pos = db.prepare(`SELECT position FROM track WHERE id=?`).get(r.trackId) as
        | { position: string | null }
        | undefined;
      const fileName = sanitizeName(`${(pos?.position ?? '0').padStart(2, '0')} ${r.title}.wav`);
      const finalPath = join(dir, fileName);
      const partPath = `${finalPath}.part`;
      extractRegionToFile(take.path, partPath, r.startMs, r.endMs);
      parts.push(partPath);
      const meta = readWavMeta(partPath);
      finals.push({ region: r, path: finalPath, sampleRate: meta.sampleRate, bitDepth: meta.bitDepth });
    }
    for (let i = 0; i < finals.length; i++) renameSync(parts[i], finals[i].path);
  } catch (err) {
    for (const p of parts) {
      try {
        unlinkSync(p);
      } catch {
        /* already moved or missing */
      }
    }
    throw err;
  }

  // 3. One DB transaction for all rows. On failure, remove the moved files.
  try {
    const tx = db.transaction(() => {
      const now = new Date().toISOString();
      for (const f of finals) {
        const { region, path } = f;
        if (replace) {
          // Drop any prior local link/key for this entity (path may have changed).
          const old = db
            .prepare(
              `SELECT external_id FROM source_link WHERE entity_kind='track' AND entity_id=? AND source='local'`,
            )
            .get(region.trackId) as { external_id: string } | undefined;
          db.prepare(
            `DELETE FROM source_link WHERE entity_kind='track' AND entity_id=? AND source='local'`,
          ).run(region.trackId);
          db.prepare(
            `DELETE FROM match_key WHERE entity_kind='track' AND entity_id=? AND key_type='file_path'`,
          ).run(region.trackId);
          if (
            old &&
            old.external_id !== path &&
            old.external_id.startsWith(root) &&
            existsSync(old.external_id)
          ) {
            try {
              unlinkSync(old.external_id);
            } catch {
              /* keep going */
            }
          }
        }
        db.prepare(
          `INSERT INTO source_link (entity_kind, entity_id, source, external_id, external_url, match_method)
           VALUES ('track', ?, 'local', ?, NULL, 'file_path')`,
        ).run(region.trackId, path);
        db.prepare(
          `INSERT INTO match_key (entity_kind, entity_id, key_type, key_value)
           VALUES ('track', ?, 'file_path', ?)
           ON CONFLICT(entity_kind, key_type, key_value) DO UPDATE SET entity_id=excluded.entity_id`,
        ).run(region.trackId, path);
        const facets: Record<string, unknown> = {
          origin: 'vinyl',
          recordedAt: now,
          sampleRate: f.sampleRate,
          bitDepth: f.bitDepth,
          takeId: region.takeId,
          sourceDiscogsReleaseId,
        };
        const facetStmt = db.prepare(
          `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
           VALUES ('track', ?, 'local', ?, ?)
           ON CONFLICT(entity_kind, entity_id, source, key) DO UPDATE SET
             value=excluded.value, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        );
        for (const [k, v] of Object.entries(facets)) {
          if (v === null || v === undefined) continue;
          facetStmt.run(region.trackId, k, JSON.stringify(v));
        }
        // Title edit + duration backfill (the rip establishes the real length).
        db.prepare(
          `UPDATE track SET title=?, duration_ms=COALESCE(duration_ms, ?),
                  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
        ).run(region.title, Math.round(region.endMs - region.startMs), region.trackId);
      }
    });
    tx();
  } catch (err) {
    for (const f of finals) {
      try {
        unlinkSync(f.path);
      } catch {
        /* best effort */
      }
    }
    throw err;
  }

  return { written: finals.length, conflicts: replace ? conflicts : [] };
}
