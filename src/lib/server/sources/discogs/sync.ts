import { discogsFetch } from './api';
import { getUsername } from './username';
import { env } from '$lib/server/env';
import type { SourceRelease, SyncResult } from '../types';

interface DiscogsCollectionItem {
  id: number;
  instance_id: number;
  basic_information: {
    id: number;
    title: string;
    year: number;
    artists?: { name: string }[];
    labels?: { name: string; catno: string }[];
    formats?: { name: string }[];
    thumb?: string;
    cover_image?: string;
  };
}

interface DiscogsCollectionPage {
  pagination: { page: number; pages: number };
  releases: DiscogsCollectionItem[];
}

export async function syncDiscogsCollection(): Promise<SyncResult> {
  const folderId = env.DISCOGS_FOLDER_ID ?? '0'; // 0 = "all" folder for collection ids
  const username = await getUsername();
  const releases: SourceRelease[] = [];
  // Aggregate instances per release (collection allows duplicates).
  const instancesByRelease = new Map<number, number[]>();

  let page = 1;
  while (true) {
    const data = (await discogsFetch(
      `/users/${encodeURIComponent(username)}/collection/folders/${folderId}/releases?per_page=100&page=${page}`,
    )) as DiscogsCollectionPage;

    for (const item of data.releases ?? []) {
      const id = item.basic_information.id;
      const instances = instancesByRelease.get(id) ?? [];
      instances.push(item.instance_id);
      instancesByRelease.set(id, instances);
    }

    if (page >= (data.pagination?.pages ?? 1)) break;
    page++;
  }

  // Now build a single SourceRelease per unique release id (using the most recent
  // basic_information). Re-walk if needed; for now, simplest is to fetch by id...
  // but we already have basic_information from the loop above. Let's keep it from
  // the *last* item we saw (simpler, results are equivalent for our fields).
  const lastSeen = new Map<number, DiscogsCollectionItem>();
  page = 1;
  while (true) {
    const data = (await discogsFetch(
      `/users/${encodeURIComponent(username)}/collection/folders/${folderId}/releases?per_page=100&page=${page}`,
    )) as DiscogsCollectionPage;
    for (const item of data.releases ?? []) {
      lastSeen.set(item.basic_information.id, item);
    }
    if (page >= (data.pagination?.pages ?? 1)) break;
    page++;
  }

  for (const [releaseId, item] of lastSeen) {
    const bi = item.basic_information;
    const artist = bi.artists?.map((a) => a.name).join(', ') || '(unknown)';
    const label = bi.labels?.[0]?.name ?? null;
    const catno = bi.labels?.[0]?.catno ?? null;
    const format = bi.formats?.map((f) => f.name).join(', ') || null;
    releases.push({
      externalId: String(releaseId),
      title: bi.title,
      artist,
      year: bi.year || undefined,
      label: label ?? undefined,
      catno: catno ?? undefined,
      externalUrl: `https://www.discogs.com/release/${releaseId}`,
      thumbUrl: bi.thumb ?? undefined,
      coverUrl: bi.cover_image ?? undefined,
      facets: {
        thumb: bi.thumb ?? null,
        coverImage: bi.cover_image ?? null,
        format,
        instanceIds: instancesByRelease.get(releaseId) ?? [],
      },
    });
  }

  return { tracks: [], releases };
}
