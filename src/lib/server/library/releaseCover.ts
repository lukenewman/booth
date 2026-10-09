import type { Database } from 'bun:sqlite';

/**
 * Set (or with null, clear) a release's hand-set cover. Clearing empties the
 * displayed cover too, so the next sync or purchase backfill refills it from
 * the sources rather than leaving the hand-set image behind.
 */
export function setReleaseCover(db: Database, releaseId: string, url: string | null): void {
  db.prepare(`UPDATE release SET cover_override = ?, thumb_url = ?, cover_url = ? WHERE id = ?`)
    .run(url, url, url, releaseId);
}
