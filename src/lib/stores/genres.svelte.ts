import { fallbackSlot } from '$lib/genres';

export interface StyleInfo {
  name: string;
  parents: string[];
  slot: number | null;
  pinned: boolean;
  releases: number;
}

/**
 * The genre vocabulary and each style's colour, loaded once and refreshed
 * after syncs and tag saves. A style with no slot yet (seen before the next
 * resolve assigns one) borrows a stable hashed colour.
 */
class GenresStore {
  genres = $state<string[]>([]);
  styles = $state<StyleInfo[]>([]);
  private slots = $derived(new Map(this.styles.map((s) => [s.name, s.slot])));
  private loading: Promise<void> | null = null;

  load(force = false): Promise<void> {
    if (this.loading && !force) return this.loading;
    this.loading = fetch('/api/genres')
      .then((r) => r.json())
      .then((v: { genres: string[]; styles: StyleInfo[] }) => {
        this.genres = v.genres;
        this.styles = v.styles;
      })
      .catch(() => {});
    return this.loading;
  }

  slotFor(style: string): number {
    return this.slots.get(style) ?? fallbackSlot(style);
  }

  parentsOf(style: string): string[] {
    return this.styles.find((s) => s.name === style)?.parents ?? [];
  }

  async pin(style: string, slot: number) {
    this.styles = this.styles.map((s) => (s.name === style ? { ...s, slot, pinned: true } : s));
    await fetch(`/api/genres/styles/${encodeURIComponent(style)}/color`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot }),
    });
  }

  async reassign() {
    const v = await fetch('/api/genres/colors/reassign', { method: 'POST' }).then((r) => r.json());
    this.genres = v.genres;
    this.styles = v.styles;
  }
}

export const genresStore = new GenresStore();
