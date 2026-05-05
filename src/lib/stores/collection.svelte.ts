class CollectionStore {
  ids = $state<Set<number>>(new Set());
  loaded = $state(false);

  async load() {
    try {
      const res = await fetch('/api/discogs/collection/ids');
      if (!res.ok) return;
      const data = await res.json();
      this.ids = new Set(data.ids ?? []);
      this.loaded = true;
    } catch {
      // silent: badges just won't show
    }
  }

  has(releaseId: number): boolean {
    return this.ids.has(releaseId);
  }

  markAdded(releaseId: number) {
    if (this.ids.has(releaseId)) return;
    const next = new Set(this.ids);
    next.add(releaseId);
    this.ids = next;
  }

  markRemoved(releaseId: number) {
    if (!this.ids.has(releaseId)) return;
    const next = new Set(this.ids);
    next.delete(releaseId);
    this.ids = next;
  }
}

export const collection = new CollectionStore();
