/**
 * Whether the Apple Music library is connected, shared by the library nudge,
 * the Sources → Local view and the first-run screen.
 */
class MusicLibraryStore {
  /** null until the first load lands. */
  connected = $state<boolean | null>(null);
  nudgeDismissed = $state(false);
  /** The desktop app can show a native Open dialog; a browser can't give a path. */
  canChooseFile = $state(false);

  async load() {
    try {
      const res = await fetch('/api/setup/music');
      if (!res.ok) return;
      const data = await res.json();
      this.connected = data.status === 'connected';
      this.nudgeDismissed = !!data.nudgeDismissed;
      this.canChooseFile = !!data.canChooseFile;
    } catch {
      // silent: the nudge just won't show
    }
  }

  async dismissNudge() {
    this.nudgeDismissed = true;
    await fetch('/api/setup/music/dismiss', { method: 'POST' }).catch(() => {});
  }
}

export const musicLibrary = new MusicLibraryStore();
