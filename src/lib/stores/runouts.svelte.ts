import { SvelteMap } from 'svelte/reactivity';
import { runoutLines, type Identifier, type RunoutLine } from '$lib/discogs/runout';

// Runout lines per Discogs release id, loaded in the background so the add
// flow's version list can be filtered by what's etched in the dead wax. Search
// hits don't carry identifiers; only the full /releases/{id} record does, so
// filtering N versions costs N requests — hence two at a time, backing off
// before the rate limit runs dry rather than after.

type Entry = { ok: true; lines: RunoutLine[] } | { ok: false };

const WORKERS = 2;
// Leave this many requests in Discogs's one-minute window for whatever the
// user does next (opening a version, adding it).
const RESERVE = 10;
const RESERVE_PAUSE_MS = 5000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class RunoutStore {
  entries = new SvelteMap<number, Entry>();
  /** The ids the current load is working through, for progress. */
  wanted = $state<number[]>([]);
  /** Set while paused on the rate limit, so the UI can say why it stalled. */
  waiting = $state(false);
  private gen = 0;

  get(id: number): Entry | undefined {
    return this.entries.get(id);
  }

  /** Load runouts for `ids`, replacing any load in progress. */
  load(ids: number[]) {
    const gen = ++this.gen;
    this.wanted = ids;
    this.waiting = false;
    const queue = ids.filter((id) => !this.entries.has(id));
    const worker = async () => {
      while (gen === this.gen) {
        const id = queue.shift();
        if (id === undefined) return;
        await this.fetchOne(id, gen, queue);
      }
    };
    for (let i = 0; i < WORKERS; i++) void worker();
  }

  /** Stop loading (leaving the version list). Cached entries are kept. */
  stop() {
    this.gen++;
    this.wanted = [];
    this.waiting = false;
  }

  private async fetchOne(id: number, gen: number, queue: number[]) {
    try {
      const res = await fetch(`/api/discogs/releases/${id}`);
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) {
        // Put it back and wait out the window Discogs asked for.
        queue.unshift(id);
        this.waiting = true;
        await sleep((Number(data?.retryAfter) || 60) * 1000);
        if (gen === this.gen) this.waiting = false;
        return;
      }
      if (!res.ok) {
        this.entries.set(id, { ok: false });
        return;
      }
      this.entries.set(id, { ok: true, lines: runoutLines((data.identifiers ?? []) as Identifier[]) });
      if (typeof data.rateRemaining === 'number' && data.rateRemaining < RESERVE) {
        this.waiting = true;
        await sleep(RESERVE_PAUSE_MS);
        if (gen === this.gen) this.waiting = false;
      }
    } catch {
      this.entries.set(id, { ok: false });
    }
  }
}

export const runouts = new RunoutStore();
