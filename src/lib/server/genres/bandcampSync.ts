import type { Database } from 'bun:sqlite';
import { fetchFanCollection, fetchItemPage } from './bandcamp';
import { parseItemPage, type BandcampPurchase } from './bandcampParse';
import { buildMatcher, loadMatchInputs } from './bandcampMatch';
import { resolveGenres } from './resolve';

export interface BandcampCounts { purchases: number; matched: number; ambiguous: number; unmatched: number }
export type BandcampSummary = (BandcampCounts & { pagesPending: number }) | { error: string };

/**
 * Upsert the purchases and re-match every one. Fetched tags survive: a
 * re-store only refreshes what the collection list itself says.
 */
export function storePurchases(db: Database, purchases: BandcampPurchase[]): BandcampCounts {
  const up = db.prepare(
    `INSERT INTO bandcamp_item (item_id, url, item_type, artist, title, album_title, primary_genre, purchased_at, art_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET url = excluded.url, artist = excluded.artist, title = excluded.title,
       album_title = excluded.album_title,
       primary_genre = COALESCE(bandcamp_item.primary_genre, excluded.primary_genre),
       purchased_at = excluded.purchased_at,
       art_id = COALESCE(excluded.art_id, bandcamp_item.art_id)`,
  );
  const { releases, tracks } = loadMatchInputs(db);
  const match = buildMatcher(releases, tracks);
  const set = db.prepare(`UPDATE bandcamp_item SET release_id = ?, match_state = ? WHERE item_id = ?`);
  const out: BandcampCounts = { purchases: purchases.length, matched: 0, ambiguous: 0, unmatched: 0 };
  db.transaction(() => {
    for (const p of purchases) {
      up.run(p.itemId, p.url, p.itemType, p.artist, p.title, p.albumTitle, p.primaryGenre, p.purchasedAt, p.artId ?? null);
      const r = match(p);
      out[r.state]++;
      set.run(r.state === 'matched' ? r.releaseId : null, r.state, p.itemId);
    }
  })();
  return out;
}

const PENDING = `FROM bandcamp_item WHERE match_state = 'matched' AND page_fetched_at IS NULL AND page_error IS NULL`;

function pendingCount(db: Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n ${PENDING}`).get() as { n: number }).n;
}

/** Refresh the purchases list (one request) and re-match. Never throws. */
export async function refreshBandcamp(db: Database, username: string): Promise<BandcampSummary> {
  try {
    const counts = storePurchases(db, await fetchFanCollection(username));
    return { ...counts, pagesPending: pendingCount(db) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

let pageLoop: Promise<{ fetched: number; failed: number }> | null = null;

/**
 * Fetch tags for matched items that have none, one page every couple of
 * seconds. Pages are cached forever — a release's tags don't change, and
 * re-fetching a thousand pages every sync is the likeliest way to get blocked.
 * Only matched items are fetched: an unmatched one has nowhere to put its tags.
 * One loop per process; a second call joins the one running.
 */
export function fetchPendingPages(
  db: Database,
  opts: {
    delayMs?: number;
    backoffMs?: number;
    fetcher?: typeof fetchItemPage;
    onResolved?: (releaseId: string) => void;
  } = {},
): Promise<{ fetched: number; failed: number }> {
  if (pageLoop) return pageLoop;
  const { delayMs = 2000, backoffMs = 30_000, fetcher = fetchItemPage, onResolved } = opts;
  pageLoop = (async () => {
    let fetched = 0;
    let failed = 0;
    let backoff = backoffMs;
    const next = db.prepare(`SELECT item_id, url, release_id ${PENDING} LIMIT 1`);
    const ok = db.prepare(
      `UPDATE bandcamp_item SET tags = ?, primary_genre = COALESCE(?, primary_genre), page_fetched_at = ? WHERE item_id = ?`,
    );
    const bad = db.prepare(`UPDATE bandcamp_item SET page_error = ? WHERE item_id = ?`);
    for (;;) {
      const row = next.get() as { item_id: string; url: string; release_id: string } | null;
      if (!row) break;
      let res: { status: number; html: string };
      try {
        res = await fetcher(row.url);
      } catch (e) {
        // Network down: stop quietly; the next sync picks up where this left off.
        console.warn('[bandcamp] page fetch failed:', e instanceof Error ? e.message : e);
        break;
      }
      if (res.status === 429) {
        await Bun.sleep(backoff);
        backoff = Math.min(backoff * 2, 15 * 60_000);
        continue;
      }
      backoff = backoffMs;
      if (res.status === 200) {
        const page = parseItemPage(res.html);
        ok.run(JSON.stringify(page.tags), page.primaryGenre, new Date().toISOString(), row.item_id);
        resolveGenres(db, [row.release_id]);
        onResolved?.(row.release_id);
        fetched++;
      } else if (res.status === 404 || res.status === 410) {
        // Gone for good: record it so the row stops being retried.
        bad.run(`http ${res.status}`, row.item_id);
        failed++;
      } else {
        // 5xx, a 403 from a bot wall, anything else: transient. Recording it
        // would silently drop this release's tags for good, so stop the run and
        // let the next sync pick up where this one left off.
        console.warn(`[bandcamp] page fetch stopped on http ${res.status}`);
        break;
      }
      if (delayMs) await Bun.sleep(delayMs);
    }
    return { fetched, failed };
  })().finally(() => {
    pageLoop = null;
  });
  return pageLoop;
}

export function bandcampStatus(db: Database, username: string | null) {
  const c = db.prepare(
    `SELECT COUNT(*) AS purchases,
            SUM(match_state = 'matched') AS matched,
            SUM(match_state = 'ambiguous') AS ambiguous,
            SUM(match_state = 'unmatched') AS unmatched
       FROM bandcamp_item`,
  ).get() as Record<string, number | null>;
  return {
    username,
    purchases: c.purchases ?? 0,
    matched: c.matched ?? 0,
    ambiguous: c.ambiguous ?? 0,
    unmatched: c.unmatched ?? 0,
    pagesPending: pendingCount(db),
  };
}
