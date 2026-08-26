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

  /**
   * Seed from a list or detail payload.
   *
   * Bails out when nothing actually changed. Callers hydrate from inside an
   * $effect, and components read the same sets back through isStarred /
   * isVetted — so an unconditional reassignment makes the effect retrigger
   * itself forever and starves every other effect in the app (the URL-sync
   * effect stops running, and the rendered list silently stops matching state).
   */
  private static seed<T extends { id: string }>(
    current: Set<string>,
    rows: T[],
    flagged: (row: T) => boolean,
  ): Set<string> | null {
    let changed = false;
    const next = new Set(current);
    for (const r of rows) {
      if (flagged(r)) {
        if (!next.has(r.id)) { next.add(r.id); changed = true; }
      } else if (next.delete(r.id)) {
        changed = true;
      }
    }
    return changed ? next : null;
  }

  /** Seed from a track payload; rows carry `starred_at`. */
  hydrateTracks(rows: { id: string; starred_at?: string | null }[]) {
    const next = AnnotationStore.seed(this.starred, rows, (r) => !!r.starred_at);
    if (next) this.starred = next;
  }

  /** Seed from a release payload; rows carry `vetted_at`. */
  hydrateReleases(rows: { id: string; vetted_at?: string | null }[]) {
    const next = AnnotationStore.seed(this.vetted, rows, (r) => !!r.vetted_at);
    if (next) this.vetted = next;
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
