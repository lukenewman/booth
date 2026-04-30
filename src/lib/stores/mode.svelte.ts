import type { AppMode } from '$lib/types';

class ModeStore {
  current = $state<AppMode>('search');

  setSearch() {
    this.current = 'search';
  }

  setScanner() {
    this.current = 'scanner';
  }

  toggle() {
    this.current = this.current === 'search' ? 'scanner' : 'search';
  }
}

export const mode = new ModeStore();
