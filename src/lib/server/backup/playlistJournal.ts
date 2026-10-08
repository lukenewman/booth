import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import type { PlaylistDetail } from '$lib/server/library/playlists';

/**
 * Append-only journal of playlist mutations — the sketch and crate for a gig
 * are hand-made and exist nowhere else, so they get the protection the
 * annotations journal gives stars and notes (see annotations.log for why a log
 * and not a state dump). Every event carries names, so a replay can re-find a
 * track whose ULID changed.
 */

export type PlaylistEventBody =
  | { action: 'baseline'; state: BaselineState }
  | { action: 'create'; targetMinutes: number | null }
  | { action: 'rename'; name: string }
  | { action: 'delete' }
  | { action: 'target'; minutes: number | null }
  | { action: 'section-add'; sectionId: string; name: string }
  | { action: 'section-rename'; sectionId: string; name: string }
  | { action: 'section-delete'; sectionId: string }
  | { action: 'section-order'; sectionIds: string[] }
  | { action: 'track-add'; entryId: string; sectionId: string; sectionName: string; trackId: string; artist: string; title: string; album: string | null; position: string | null }
  | { action: 'track-move'; entryId: string; sectionId: string; sectionName: string; index: number }
  | { action: 'track-order'; sectionId: string; entryIds: string[] }
  | { action: 'track-remove'; entryId: string }
  | { action: 'crate-add'; entryId: string; releaseId: string; artist: string; title: string; year: number | null }
  | { action: 'crate-remove'; entryId: string };
export type PlaylistEvent = { at: string; playlistId: string; playlistName: string; unsortedId: string } & PlaylistEventBody;
export interface ReplayedEntry { entryId: string; trackId: string | null; artist: string; title: string; album: string | null; position: string | null }
export interface ReplayedSection { id: string; name: string; isUnsorted: boolean; entryIds: string[] }
export interface ReplayedCrate { entryId: string; releaseId: string | null; artist: string; title: string; year: number | null }
export interface ReplayedPlaylist { id: string; name: string; targetMinutes: number | null; sections: ReplayedSection[]; entries: Record<string, ReplayedEntry>; crate: ReplayedCrate[] }
export type BaselineState = Omit<ReplayedPlaylist, 'id'>;

export function appendPlaylistEvent(logPath: string, e: PlaylistEvent): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(e) + '\n', 'utf8');
}

/** Lenient for the same reason as readEvents: a torn last line must not hide months of history. */
export function readPlaylistEvents(logPath: string): PlaylistEvent[] {
  if (!existsSync(logPath)) return [];
  const out: PlaylistEvent[] = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s) as PlaylistEvent;
      if (e && typeof e.playlistId === 'string' && typeof e.action === 'string') out.push(e);
    } catch {
      // skip
    }
  }
  return out;
}

export function baselineFromDetail(d: PlaylistDetail): BaselineState {
  const entries: Record<string, ReplayedEntry> = {};
  for (const s of d.sections) for (const e of s.entries) {
    entries[e.entryId] = { entryId: e.entryId, trackId: e.track?.id ?? null, ...e.snapshot };
  }
  return {
    name: d.name,
    targetMinutes: d.targetMinutes,
    sections: d.sections.map((s) => ({ id: s.id, name: s.name, isUnsorted: s.isUnsorted, entryIds: s.entries.map((e) => e.entryId) })),
    entries,
    crate: d.crate.map((c) => ({ entryId: c.entryId, releaseId: c.releaseId, artist: c.artist, title: c.title, year: c.year })),
  };
}

function fresh(e: PlaylistEvent): ReplayedPlaylist {
  return {
    id: e.playlistId,
    name: e.playlistName,
    targetMinutes: null,
    sections: [{ id: e.unsortedId, name: 'Unsorted', isUnsorted: true, entryIds: [] }],
    entries: {},
    crate: [],
  };
}

function sectionFor(p: ReplayedPlaylist, id: string, name: string): ReplayedSection {
  let s = p.sections.find((x) => x.id === id);
  if (!s) {
    s = { id, name, isUnsorted: false, entryIds: [] };
    p.sections.push(s);
  }
  return s;
}

function detach(p: ReplayedPlaylist, entryId: string): void {
  for (const s of p.sections) s.entryIds = s.entryIds.filter((id) => id !== entryId);
}

/** Fold the log into per-playlist state, optionally as of a moment. Later events win. */
export function replayPlaylistEvents(events: PlaylistEvent[], asOf?: string): Map<string, ReplayedPlaylist> {
  const out = new Map<string, ReplayedPlaylist>();
  for (const e of events) {
    if (asOf && e.at > asOf) continue;
    if (e.action === 'delete') { out.delete(e.playlistId); continue; }
    if (e.action === 'baseline') { out.set(e.playlistId, { id: e.playlistId, ...structuredClone(e.state) }); continue; }
    let p = out.get(e.playlistId);
    if (!p) { p = fresh(e); out.set(e.playlistId, p); }
    p.name = e.playlistName;
    switch (e.action) {
      case 'create': p.targetMinutes = e.targetMinutes; break;
      case 'rename': p.name = e.name; break;
      case 'target': p.targetMinutes = e.minutes; break;
      case 'section-add': sectionFor(p, e.sectionId, e.name); break;
      case 'section-rename': sectionFor(p, e.sectionId, e.name).name = e.name; break;
      case 'section-delete': {
        const s = p.sections.find((x) => x.id === e.sectionId);
        if (!s || s.isUnsorted) break;
        const unsorted = p.sections.find((x) => x.isUnsorted)!;
        unsorted.entryIds.push(...s.entryIds);
        p.sections = p.sections.filter((x) => x !== s);
        break;
      }
      case 'section-order': {
        const unsorted = p.sections.filter((s) => s.isUnsorted);
        const named = e.sectionIds.flatMap((id) => p!.sections.filter((s) => s.id === id && !s.isUnsorted));
        const rest = p.sections.filter((s) => !s.isUnsorted && !named.includes(s));
        p.sections = [...unsorted, ...named, ...rest];
        break;
      }
      case 'track-add': {
        detach(p, e.entryId);
        p.entries[e.entryId] = { entryId: e.entryId, trackId: e.trackId, artist: e.artist, title: e.title, album: e.album, position: e.position };
        sectionFor(p, e.sectionId, e.sectionName).entryIds.push(e.entryId);
        break;
      }
      case 'track-move': {
        if (!p.entries[e.entryId]) break;
        detach(p, e.entryId);
        const s = sectionFor(p, e.sectionId, e.sectionName);
        s.entryIds.splice(Math.max(0, Math.min(e.index, s.entryIds.length)), 0, e.entryId);
        break;
      }
      case 'track-order': {
        const s = p.sections.find((x) => x.id === e.sectionId);
        if (!s) break;
        const named = e.entryIds.filter((id) => s.entryIds.includes(id));
        s.entryIds = [...named, ...s.entryIds.filter((id) => !named.includes(id))];
        break;
      }
      case 'track-remove': detach(p, e.entryId); delete p.entries[e.entryId]; break;
      case 'crate-add':
        if (!p.crate.some((c) => c.entryId === e.entryId)) {
          p.crate.push({ entryId: e.entryId, releaseId: e.releaseId, artist: e.artist, title: e.title, year: e.year });
        }
        break;
      case 'crate-remove': p.crate = p.crate.filter((c) => c.entryId !== e.entryId); break;
    }
  }
  return out;
}
