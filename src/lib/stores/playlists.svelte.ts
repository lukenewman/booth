import type { ResolvedBpm } from '$lib/bpm';
export interface PlaylistSummary {
  id: string;
  name: string;
  trackCount: number;
  coverUrl: string | null;
  mosaic: string[];
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
}

export interface PlaylistDetail {
  id: string;
  name: string;
  coverUrl: string | null;
  mosaic: string[];
  tracks: PlaylistTrack[];
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

  async loadPlaylist(id: string) {
    this.pendingRemove = null;
    try {
      const res = await fetch(`/api/playlists/${id}`);
      if (!res.ok) {
        this.openPlaylist = null;
        return;
      }
      this.openPlaylist = (await res.json()) as PlaylistDetail;
    } catch {
      this.openPlaylist = null;
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

  async addTrack(playlistId: string, trackId: string): Promise<{ added: boolean }> {
    const res = await fetch(`/api/playlists/${playlistId}/tracks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trackId }),
    });
    if (!res.ok) return { added: false };
    const data = (await res.json()) as { added: boolean; trackCount: number };
    this.items = this.items.map((p) => (p.id === playlistId ? { ...p, trackCount: data.trackCount } : p));
    if (data.added && this.openPlaylist?.id === playlistId) await this.loadPlaylist(playlistId);
    return { added: data.added };
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
      this.openPlaylist = { ...this.openPlaylist, tracks: next };
    }
    await fetch(`/api/playlists/${playlistId}/tracks`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: orderedTrackIds }),
    });
  }
}

export const playlists = new PlaylistsStore();
