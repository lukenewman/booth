import type { SessionEntry } from '$lib/types';

class SessionStore {
  entries = $state<SessionEntry[]>([]);

  count = $derived(this.entries.length);
  last = $derived(this.entries[0] ?? null);

  add(entry: SessionEntry) {
    this.entries = [entry, ...this.entries];
  }

  removeById(releaseId: number, instanceId: number) {
    this.entries = this.entries.filter(
      (e) => !(e.releaseId === releaseId && e.instanceId === instanceId),
    );
  }
}

export const session = new SessionStore();
