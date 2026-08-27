import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { dirname } from 'path';

/**
 * Append-only journal of star / vet events.
 *
 * Why a log rather than a dump of current state: a backup that mirrors the
 * present cannot protect you from deletion — it faithfully mirrors the
 * deletion too. On 2026-08-26 a cleanup script cleared 29 real stars in about
 * ten seconds; any "export current annotations" job would have overwritten its
 * own good copy well inside that window. Only history lets you rewind.
 *
 * Each event also carries the artist / title / album it referred to, so the log
 * can be replayed against a database whose ULIDs have changed — a moved file
 * re-keys on its path and gets a new track row (see `pruneSource` in collate).
 */

export interface AnnotationEvent {
  /** When the mutation happened (ISO8601). Also the rewind axis. */
  at: string;
  kind: 'track' | 'release';
  /** Entity ULID — exact replay onto the same database. */
  id: string;
  action: 'star' | 'unstar' | 'vet' | 'unvet';
  /** Resulting starred_at / vetted_at, or null when cleared. */
  value: string | null;
  /** Name keys — replay onto a rebuilt database, where ULIDs won't match. */
  artist: string;
  title: string;
  album: string | null;
}

export interface ReplayResult {
  /** trackId -> starred_at */
  stars: Map<string, string>;
  /** releaseId -> vetted_at */
  vetted: Map<string, string>;
  /** "artist title" -> starred_at, for matching against a rebuilt database. */
  byName: Map<string, string>;
}

export function nameKey(artist: string, title: string): string {
  return `${artist} ${title}`;
}

/**
 * Fold the log into the state it describes, optionally as of a moment.
 *
 * `asOf` is the recovery path: replay everything up to just before an accident
 * and you have the state to restore. Later events win — this is a record of
 * what happened, not a merge.
 */
export function replayEvents(events: AnnotationEvent[], asOf?: string): ReplayResult {
  const stars = new Map<string, string>();
  const vetted = new Map<string, string>();
  const byName = new Map<string, string>();

  for (const e of events) {
    if (asOf && e.at > asOf) continue;
    switch (e.action) {
      case 'star':
        if (e.value) {
          stars.set(e.id, e.value);
          byName.set(nameKey(e.artist, e.title), e.value);
        }
        break;
      case 'unstar':
        stars.delete(e.id);
        byName.delete(nameKey(e.artist, e.title));
        break;
      case 'vet':
        if (e.value) vetted.set(e.id, e.value);
        break;
      case 'unvet':
        vetted.delete(e.id);
        break;
    }
  }

  return { stars, vetted, byName };
}

/** Append one event. Creates the directory and file on first write. */
export function appendEvent(logPath: string, event: AnnotationEvent): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(event) + '\n', 'utf8');
}

/**
 * Read the journal, skipping unparseable lines.
 *
 * Lenient on purpose: this file is the recovery artifact. A truncated final
 * line from a hard kill must not make the preceding months unreadable.
 */
export function readEvents(logPath: string): AnnotationEvent[] {
  if (!existsSync(logPath)) return [];
  const out: AnnotationEvent[] = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as AnnotationEvent;
      if (parsed && typeof parsed.id === 'string' && typeof parsed.action === 'string') {
        out.push(parsed);
      }
    } catch {
      // skip
    }
  }
  return out;
}
