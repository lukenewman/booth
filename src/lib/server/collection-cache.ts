import { discogsFetch } from './discogs';
import { getUsername } from './username';

interface CollectionItem {
  basic_information: { id: number };
}
interface CollectionPage {
  pagination: { page: number; pages: number };
  releases: CollectionItem[];
}

const counts = new Map<number, number>();
let loaded = false;
let loading: Promise<void> | null = null;

async function loadAll(): Promise<void> {
  const username = await getUsername();
  counts.clear();
  let page = 1;
  while (true) {
    const data = (await discogsFetch(
      `/users/${encodeURIComponent(username)}/collection/folders/0/releases?per_page=100&page=${page}`,
    )) as CollectionPage;
    for (const item of data.releases ?? []) {
      const id = item.basic_information.id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    if (page >= (data.pagination?.pages ?? 1)) break;
    page++;
  }
  loaded = true;
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (loading) return loading;
  loading = loadAll().finally(() => {
    loading = null;
  });
  return loading;
}

export async function getCollectionIds(): Promise<number[]> {
  await ensureLoaded();
  const out: number[] = [];
  for (const [id, n] of counts) if (n > 0) out.push(id);
  return out;
}

export function markAdded(releaseId: number): void {
  counts.set(releaseId, (counts.get(releaseId) ?? 0) + 1);
}

export function markRemoved(releaseId: number): void {
  const n = (counts.get(releaseId) ?? 0) - 1;
  if (n <= 0) counts.delete(releaseId);
  else counts.set(releaseId, n);
}
