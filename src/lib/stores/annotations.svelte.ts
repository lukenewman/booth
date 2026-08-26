/**
 * Client mirror of the user's stars and vetted flags.
 *
 * Toggles are optimistic — the grind involves thousands of these, and waiting
 * a round-trip for the glyph to fill would make the whole feature feel sticky.
 * A failed request rolls the local state back.
 */
class AnnotationStore {
  starred = $state<Set<string>>(new Set());
  vetted = $state<Set<string>>(new Set());

  isStarred(trackId: string): boolean {
    return this.starred.has(trackId);
  }
  isVetted(releaseId: string): boolean {
    return this.vetted.has(releaseId);
  }

  /** Seed from a track list payload; rows carry `starred_at`. */
  hydrateTracks(rows: { id: string; starred_at?: string | null }[]) {
    const next = new Set(this.starred);
    for (const r of rows) {
      if (r.starred_at) next.add(r.id);
      else next.delete(r.id);
    }
    this.starred = next;
  }

  /** Seed from a release list payload; rows carry `vetted_at`. */
  hydrateReleases(rows: { id: string; vetted_at?: string | null }[]) {
    const next = new Set(this.vetted);
    for (const r of rows) {
      if (r.vetted_at) next.add(r.id);
      else next.delete(r.id);
    }
    this.vetted = next;
  }

  async toggleStar(trackId: string, next: boolean) {
    const prev = new Set(this.starred);
    const optimistic = new Set(this.starred);
    if (next) optimistic.add(trackId);
    else optimistic.delete(trackId);
    this.starred = optimistic;

    try {
      const res = await fetch(`/api/library/tracks/${trackId}/star`, {
        method: next ? 'PUT' : 'DELETE',
      });
      if (!res.ok) this.starred = prev;
    } catch {
      this.starred = prev;
    }
  }

  async toggleVetted(releaseId: string, next: boolean) {
    const prev = new Set(this.vetted);
    const optimistic = new Set(this.vetted);
    if (next) optimistic.add(releaseId);
    else optimistic.delete(releaseId);
    this.vetted = optimistic;

    try {
      const res = await fetch(`/api/library/releases/${releaseId}/vet`, {
        method: next ? 'PUT' : 'DELETE',
      });
      if (!res.ok) this.vetted = prev;
    } catch {
      this.vetted = prev;
    }
  }
}

export const annotations = new AnnotationStore();
