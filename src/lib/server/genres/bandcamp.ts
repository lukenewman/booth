import { parseCollectionItem, type BandcampPurchase } from './bandcampParse';

const UA = 'Mozilla/5.0 (booth; personal library)';

/**
 * There is no usable Bandcamp API (the public one closed to new developers in
 * 2013). This is the endpoint Bandcamp's own fan page uses; one request returns
 * the whole public purchase history with exact item URLs.
 */
/**
 * Above the collection's size, so one ~3s request returns everything. At 1,000
 * Bandcamp paged through overlapping results instead: four requests and ~12s
 * for 1,042 purchases (measured 2026-10-13). collectPages still handles paging
 * should a collection outgrow this.
 */
const COLLECTION_COUNT = 5000;

export async function fetchFanCollection(username: string): Promise<BandcampPurchase[]> {
  const page = await fetch(`https://bandcamp.com/${encodeURIComponent(username)}`, { headers: { 'User-Agent': UA } });
  if (!page.ok) throw new Error(`bandcamp fan page ${page.status}`);
  const html = (await page.text()).replace(/&quot;/g, '"');
  const fanId = html.match(/"fan_id":(\d+)/)?.[1];
  if (!fanId) throw new BandcampFanNotFound(username);

  return collectPages(async (token) => {
    const res = await fetch('https://bandcamp.com/api/fancollection/1/collection_items', {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fan_id: Number(fanId), older_than_token: token, count: COLLECTION_COUNT }),
    });
    if (!res.ok) throw new Error(`bandcamp collection ${res.status}`);
    return (await res.json()) as CollectionPage;
  });
}

interface CollectionPage { items?: Record<string, unknown>[]; more_available?: boolean; last_token?: string }

/**
 * Walk the collection pages. Observed 2026-10-09: with count=1000 Bandcamp
 * keeps answering more_available with pages that overlap the ones already
 * seen (1,042 purchases came back as 3,985 rows). So purchases are keyed by
 * item id, and a page that adds nothing new ends the walk.
 */
export async function collectPages(fetchPage: (token: string) => Promise<CollectionPage>): Promise<BandcampPurchase[]> {
  const out = new Map<string, BandcampPurchase>();
  let token = `${Math.floor(Date.now() / 1000) + 86400}::a::`;
  for (let guard = 0; guard < 50; guard++) {
    const data = await fetchPage(token);
    const before = out.size;
    for (const raw of data.items ?? []) {
      const p = parseCollectionItem(raw);
      if (!out.has(p.itemId)) out.set(p.itemId, p);
    }
    if (!data.more_available || !data.last_token || out.size === before) break;
    token = data.last_token;
  }
  return [...out.values()];
}

export class BandcampFanNotFound extends Error {
  constructor(username: string) {
    super(`no public Bandcamp fan profile for "${username}"`);
    this.name = 'BandcampFanNotFound';
  }
}

export async function fetchItemPage(url: string): Promise<{ status: number; html: string }> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  return { status: res.status, html: res.ok ? await res.text() : '' };
}
