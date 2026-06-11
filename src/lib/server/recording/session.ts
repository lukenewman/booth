import { mkdirSync, rmSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { ExpectedTrack } from './matcher';

/**
 * In-memory recording session registry + expected-track loading. Sessions are
 * process-local (single-user app); their WAV takes live under <root>/.tmp.
 */

export interface TakeState {
  id: string; // 'take-1', 'take-2', …
  path: string;
  sampleRate: number;
  channels: number;
  finalized: boolean;
}

export interface SessionState {
  id: string;
  releaseId: string;
  tmpDir: string;
  createdAt: number;
  takes: TakeState[];
}

const sessions = new Map<string, SessionState>();

export function createSession(root: string, releaseId: string): SessionState {
  sweepStaleTmp(root);
  const id = ulid();
  const tmpDir = join(root, '.tmp', id);
  mkdirSync(tmpDir, { recursive: true });
  const s: SessionState = { id, releaseId, tmpDir, createdAt: Date.now(), takes: [] };
  sessions.set(id, s);
  return s;
}

export function getSession(id: string): SessionState | undefined {
  return sessions.get(id);
}

export function addTake(s: SessionState, sampleRate: number, channels: number): TakeState {
  const id = `take-${s.takes.length + 1}`;
  const take: TakeState = {
    id,
    path: join(s.tmpDir, `${id}.wav`),
    sampleRate,
    channels,
    finalized: false,
  };
  s.takes.push(take);
  return take;
}

export function destroySession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  rmSync(s.tmpDir, { recursive: true, force: true });
  sessions.delete(id);
}

/** Remove .tmp session dirs older than 24h (server-restart leftovers). */
export function sweepStaleTmp(root: string): void {
  const tmp = join(root, '.tmp');
  if (!existsSync(tmp)) return;
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const name of readdirSync(tmp)) {
    const p = join(tmp, name);
    try {
      if (statSync(p).mtimeMs < cutoff && !sessions.has(name)) {
        rmSync(p, { recursive: true, force: true });
      }
    } catch {
      /* raced with another sweep; ignore */
    }
  }
}

/** Expected tracks for a release, grouped into side blocks for the matcher. */
export function loadExpectedTracks(
  db: Database,
  releaseId: string,
): { tracks: ExpectedTrack[]; blocks: ExpectedTrack[][] } {
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.duration_ms, t.position,
              (SELECT sf.value FROM source_facets sf
                WHERE sf.entity_kind='track' AND sf.entity_id=t.id
                  AND sf.source='discogs' AND sf.key='discogsPosition') AS dpos
         FROM track t
        WHERE t.release_id = ?
        ORDER BY CAST(t.position AS INTEGER)`,
    )
    .all(releaseId) as Array<{
      id: string;
      title: string;
      duration_ms: number | null;
      position: string | null;
      dpos: string | null;
    }>;

  const tracks: ExpectedTrack[] = rows.map((r) => {
    const discogsPosition = r.dpos ? (JSON.parse(r.dpos) as string) : null;
    const side = discogsPosition?.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() ?? null;
    return {
      trackId: r.id,
      title: r.title,
      durationMs: r.duration_ms,
      position: r.position ?? '',
      discogsPosition,
      side,
    };
  });

  // Group contiguous side blocks; if any track lacks a side, fall back to one block.
  const blocks: ExpectedTrack[][] = [];
  if (tracks.some((t) => !t.side)) {
    if (tracks.length > 0) blocks.push(tracks);
  } else {
    let current: ExpectedTrack[] = [];
    for (const t of tracks) {
      if (current.length && current[0].side !== t.side) {
        blocks.push(current);
        current = [];
      }
      current.push(t);
    }
    if (current.length) blocks.push(current);
  }
  return { tracks, blocks };
}
