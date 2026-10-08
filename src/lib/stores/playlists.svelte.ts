import type { ResolvedBpm } from '$lib/bpm';
import { annotations } from '$lib/stores/annotations.svelte';
export interface PlaylistSummary {
  id: string; name: string; trackCount: number; coverUrl: string | null; mosaic: string[];
  isGig: boolean;
  targetMinutes: number | null;
}

export interface PlaylistTrack {
  id: string;
  title: string;
  artist: string;
  artist_id: string;
  album: string | null;
  duration_ms: number | null;
  release_id: string | null;
  position: string | null;
  thumb_url: string | null;
  sources: string[];
  canPlay: boolean;
  /** Resting tempo. Null for the majority of tracks until more BPM sources land. */
  bpm?: ResolvedBpm | null;
  starred_at?: string | null;
  note?: string | null;
}

export interface TrackSnapshot { artist: string; title: string; album: string | null; position: string | null }
export interface PlaylistEntry { entryId: string; sectionId: string; track: PlaylistTrack | null; snapshot: TrackSnapshot }
export interface PlaylistSection { id: string; name: string; isUnsorted: boolean; entries: PlaylistEntry[] }
export interface CrateEntry { entryId: string; releaseId: string | null; artist: string; title: string; year: number | null; thumbUrl: string | null; sketchedCount: number }
export interface PlaylistDetail {
  id: string; name: string; coverUrl: string | null; mosaic: string[]; tracks: PlaylistTrack[];
  targetMinutes: number | null;
  isGig: boolean;
  sections: PlaylistSection[];
  crate: CrateEntry[];
}

class PlaylistsStore {
  items = $state<PlaylistSummary[]>([]);
  openPlaylist = $state<PlaylistDetail | null>(null);
  // A track removal awaiting confirmation. Both the row × button and the
  // global Delete key set this; the confirm modal in PlaylistView reads it.
  pendingRemove = $state<{ playlistId: string; trackId: string; trackTitle: string } | null>(null);

  async loadList() {
    try {
      const res = await fetch('/api/playlists');
      if (!res.ok) return;
      const data = (await res.json()) as { items: PlaylistSummary[] };
      this.items = data.items ?? [];
    } catch {
      // silent — rail just won't show playlists
    }
  }

  /**
   * Bumped on every load; a response that comes back after a newer load was
   * started is stale and dropped, so an older refresh can't overwrite a newer
   * view (or an optimistic move) on its way in.
   */
  private loadSeq = 0;

  async loadPlaylist(id: string) {
    const seq = ++this.loadSeq;
    // A refresh of the same playlist must not dismiss an open remove-confirm.
    if (this.openPlaylist?.id !== id) this.pendingRemove = null;
    try {
      const res = await fetch(`/api/playlists/${id}`);
      if (seq !== this.loadSeq) return;
      if (!res.ok) {
        this.openPlaylist = null;
        return;
      }
      const detail = (await res.json()) as PlaylistDetail;
      if (seq !== this.loadSeq) return;
      // Hydrate stars and notes from the fetch callback (the house rule:
      // never from an effect that reads the store it writes), so gig and
      // playlist rows show them without the tracks being browsed elsewhere.
      annotations.hydrateTracks(detail.tracks);
      annotations.hydrateNotes(detail.tracks);
      this.openPlaylist = detail;
    } catch {
      if (seq === this.loadSeq) this.openPlaylist = null;
    }
  }

  async create(name: string): Promise<PlaylistSummary | null> {
    const res = await fetch('/api/playlists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return null;
    const created = (await res.json()) as PlaylistSummary;
    this.items = [...this.items, created].sort((a, b) => a.name.localeCompare(b.name));
    return created;
  }

  async rename(id: string, name: string) {
    const res = await fetch(`/api/playlists/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return;
    this.items = this.items
      .map((p) => (p.id === id ? { ...p, name } : p))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (this.openPlaylist?.id === id) this.openPlaylist = { ...this.openPlaylist, name };
  }

  async remove(id: string) {
    const res = await fetch(`/api/playlists/${id}`, { method: 'DELETE' });
    if (!res.ok) return;
    this.items = this.items.filter((p) => p.id !== id);
    if (this.openPlaylist?.id === id) this.openPlaylist = null;
  }



  async removeTrack(playlistId: string, trackId: string) {
    const res = await fetch(`/api/playlists/${playlistId}/tracks/${trackId}`, { method: 'DELETE' });
    if (!res.ok) return;
    const data = (await res.json()) as { trackCount: number };
    this.items = this.items.map((p) => (p.id === playlistId ? { ...p, trackCount: data.trackCount } : p));
    if (this.openPlaylist?.id === playlistId) {
      this.openPlaylist = {
        ...this.openPlaylist,
        tracks: this.openPlaylist.tracks.filter((t) => t.id !== trackId),
        sections: this.openPlaylist.sections.map((s) => ({ ...s, entries: s.entries.filter((e) => e.track?.id !== trackId) })),
      };
    }
  }

  async uploadCover(id: string, file: File) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`/api/playlists/${id}/cover`, { method: 'POST', body: fd });
    if (!res.ok) return;
    const { coverUrl } = (await res.json()) as { coverUrl: string };
    this.items = this.items.map((p) => (p.id === id ? { ...p, coverUrl } : p));
    if (this.openPlaylist?.id === id) this.openPlaylist = { ...this.openPlaylist, coverUrl };
  }

  async removeCover(id: string) {
    const res = await fetch(`/api/playlists/${id}/cover`, { method: 'DELETE' });
    if (!res.ok) return;
    this.items = this.items.map((p) => (p.id === id ? { ...p, coverUrl: null } : p));
    if (this.openPlaylist?.id === id) this.openPlaylist = { ...this.openPlaylist, coverUrl: null };
  }

  /** Ask for confirmation before removing a track (both × button and Delete key). */
  requestRemove(playlistId: string, trackId: string, trackTitle: string) {
    this.pendingRemove = { playlistId, trackId, trackTitle };
  }

  cancelRemove() {
    this.pendingRemove = null;
  }

  async confirmRemove() {
    const pr = this.pendingRemove;
    if (!pr) return;
    this.pendingRemove = null;
    await this.removeTrack(pr.playlistId, pr.trackId);
  }

  /** Optimistically reorder the open playlist, then persist. */
  async reorder(playlistId: string, orderedTrackIds: string[]) {
    if (this.openPlaylist?.id === playlistId) {
      const byId = new Map(this.openPlaylist.tracks.map((t) => [t.id, t]));
      const next = orderedTrackIds.map((id) => byId.get(id)).filter((t): t is PlaylistTrack => !!t);
      // Mirror the server rule in the Unsorted section the plain view renders:
      // present tracks take the present slots in the new order, missing rows
      // keep theirs.
      const sections = this.openPlaylist.sections.map((sec) => {
        if (!sec.isUnsorted) return sec;
        const present = sec.entries.filter((e) => e.track);
        const byTrack = new Map(present.map((e) => [e.track!.id, e]));
        const named = orderedTrackIds.flatMap((id) => (byTrack.has(id) ? [byTrack.get(id)!] : []));
        const queue = [...named, ...present.filter((e) => !named.includes(e))];
        return { ...sec, entries: sec.entries.map((e) => (e.track ? queue.shift()! : e)) };
      });
      this.openPlaylist = { ...this.openPlaylist, tracks: next, sections };
    }
    await fetch(`/api/playlists/${playlistId}/tracks`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: orderedTrackIds }),
    });
  }
  /** Reload both mirrors after a structural change; cheap, and keeps one source of truth. */
  private async refresh(playlistId: string) {
    await Promise.all([this.loadList(), this.openPlaylist?.id === playlistId ? this.loadPlaylist(playlistId) : null]);
  }

  /**
   * Gig writes go out one at a time, in the order they were made. Without
   * this a slow move could land after a later add's refresh had already read
   * the pre-move state, leaving the screen and the database disagreeing.
   */
  private writes: Promise<unknown> = Promise.resolve();

  private send(method: string, url: string, body?: unknown): Promise<Response> {
    const run = () =>
      fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const next = this.writes.then(run, run);
    this.writes = next.catch(() => undefined);
    return next;
  }

  async createGig(name: string, targetMinutes: number): Promise<PlaylistSummary | null> {
    const res = await this.send('POST', '/api/playlists', { name, targetMinutes });
    if (!res.ok) return null;
    const created = (await res.json()) as PlaylistSummary;
    this.items = [...this.items, created].sort((a, b) => a.name.localeCompare(b.name));
    return created;
  }

  async setTarget(id: string, minutes: number | null) {
    const res = await this.send('PATCH', `/api/playlists/${id}`, { targetMinutes: minutes });
    if (res.ok) await this.refresh(id);
  }

  async addTrack(playlistId: string, trackId: string, sectionId?: string): Promise<{ added: boolean; sectionName: string }> {
    const res = await this.send('POST', `/api/playlists/${playlistId}/tracks`, { trackId, sectionId });
    if (!res.ok) return { added: false, sectionName: '' };
    const data = (await res.json()) as { added: boolean; sectionName: string; trackCount: number };
    this.items = this.items.map((p) => (p.id === playlistId ? { ...p, trackCount: data.trackCount } : p));
    if (data.added) await this.refresh(playlistId);
    return { added: data.added, sectionName: data.sectionName };
  }

  /**
   * Drop a track onto a section. If the gig already holds it, that's a move —
   * the user is placing it, not adding it — so it never reads as a no-op.
   */
  async placeTrack(playlistId: string, trackId: string, sectionId: string): Promise<{ moved: boolean; added: boolean }> {
    const open = this.openPlaylist?.id === playlistId ? this.openPlaylist : null;
    const entry = open?.sections.flatMap((s) => s.entries).find((e) => e.track?.id === trackId);
    if (entry) {
      const target = open!.sections.find((s) => s.id === sectionId);
      if (entry.sectionId !== sectionId) await this.moveEntry(playlistId, entry.entryId, sectionId, target?.entries.length ?? 0);
      return { moved: entry.sectionId !== sectionId, added: false };
    }
    const { added } = await this.addTrack(playlistId, trackId, sectionId);
    return { moved: false, added };
  }

  async moveEntry(playlistId: string, entryId: string, sectionId: string, index: number) {
    const open = this.openPlaylist;
    if (open?.id === playlistId) {
      // Optimistic, so a drag lands immediately.
      const all = open.sections.flatMap((s) => s.entries);
      const moving = all.find((e) => e.entryId === entryId);
      if (moving) {
        const sections = open.sections.map((s) => ({ ...s, entries: s.entries.filter((e) => e.entryId !== entryId) }));
        const target = sections.find((s) => s.id === sectionId);
        if (target) {
          target.entries.splice(Math.max(0, Math.min(index, target.entries.length)), 0, { ...moving, sectionId });
          const tracks = sections.flatMap((s) => s.entries.flatMap((e) => (e.track ? [e.track] : [])));
          this.openPlaylist = { ...open, sections, tracks };
        }
      }
    }
    await this.send('PATCH', `/api/playlists/${playlistId}/entries/${entryId}`, { sectionId, index });
    await this.refresh(playlistId);
  }

  async removeEntry(playlistId: string, entryId: string) {
    const res = await this.send('DELETE', `/api/playlists/${playlistId}/entries/${entryId}`);
    if (res.ok) await this.refresh(playlistId);
  }

  async addSection(playlistId: string, name: string): Promise<{ id: string; name: string } | null> {
    const res = await this.send('POST', `/api/playlists/${playlistId}/sections`, { name });
    if (!res.ok) return null;
    const s = (await res.json()) as { id: string; name: string };
    await this.refresh(playlistId);
    return s;
  }

  async renameSection(playlistId: string, sectionId: string, name: string) {
    const res = await this.send('PATCH', `/api/playlists/${playlistId}/sections/${sectionId}`, { name });
    if (res.ok) await this.refresh(playlistId);
  }

  async deleteSection(playlistId: string, sectionId: string) {
    const res = await this.send('DELETE', `/api/playlists/${playlistId}/sections/${sectionId}`);
    if (res.ok) await this.refresh(playlistId);
  }

  async reorderSections(playlistId: string, orderedIds: string[]) {
    const open = this.openPlaylist;
    if (open?.id === playlistId) {
      const unsorted = open.sections.filter((s) => s.isUnsorted);
      const named = orderedIds.flatMap((id) => open.sections.filter((s) => s.id === id && !s.isUnsorted));
      const sections = [...unsorted, ...named];
      this.openPlaylist = { ...open, sections, tracks: sections.flatMap((s) => s.entries.flatMap((e) => (e.track ? [e.track] : []))) };
    }
    const res = await this.send('PATCH', `/api/playlists/${playlistId}/sections`, { order: orderedIds });
    if (!res.ok) await this.refresh(playlistId);
  }

  async addRelease(playlistId: string, releaseId: string): Promise<{ added: boolean }> {
    const res = await this.send('POST', `/api/playlists/${playlistId}/crate`, { releaseId });
    if (!res.ok) return { added: false };
    const { added } = (await res.json()) as { added: boolean };
    if (added) await this.refresh(playlistId);
    return { added };
  }

  async removeCrateEntry(playlistId: string, entryId: string) {
    const res = await this.send('DELETE', `/api/playlists/${playlistId}/crate/${entryId}`);
    if (res.ok) await this.refresh(playlistId);
  }
}

export const playlists = new PlaylistsStore();
