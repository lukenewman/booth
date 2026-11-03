/**
 * Backup status, shared by the panel in Sources → Local and the nudge above
 * the library. Polls while a run is going.
 */
export interface DestinationStatus {
  destination: { id: string; path: string; sameDisk: boolean; online: boolean };
  lastBackupAt: string | null;
  daysSince: number | null;
  releasesNotBackedUp: number;
  filesToCopy: number;
  bytesToCopy: number;
  filesHeld: number;
  running: { startedAt: string; filesTotal: number; filesDone: number; bytesTotal: number; bytesDone: number } | null;
  lastRun: { state: string; finishedAt: string | null; error: string | null; failed: number; copied: number; moved: number; checked: number; verify: boolean } | null;
}

export interface BackupStatus {
  destinations: DestinationStatus[];
  lastBackupAt: string | null;
  daysSince: number | null;
  releasesNotBackedUp: number;
  running: boolean;
}

const post = (url: string, body?: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

class BackupStore {
  status = $state<BackupStatus | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;

  async load() {
    try {
      this.status = await fetch('/api/backup').then((r) => r.json());
    } catch { /* keep the last status */ }
    if (this.timer) clearTimeout(this.timer);
    // A queued "back up all" has gaps between destinations, so keep polling a moment after.
    if (this.status?.running) this.timer = setTimeout(() => void this.load(), 2000);
  }

  async addDestination(path: string): Promise<string | null> {
    const res = await post('/api/backup', { path });
    if (!res.ok) return (await res.json().catch(() => ({}))).error ?? 'Something went wrong.';
    await this.load();
    return null;
  }

  async removeDestination(id: string): Promise<string | null> {
    const res = await fetch(`/api/backup/${id}`, { method: 'DELETE' });
    await this.load();
    return res.ok ? null : ((await res.json().catch(() => ({}))).error ?? 'Something went wrong.');
  }

  /** One destination, or every connected one when `destinationId` is omitted. */
  async start(opts: { destinationId?: string; verify?: boolean } = {}) {
    await post('/api/backup/run', opts);
    await this.load();
  }

  async stop() {
    await post('/api/backup/stop');
    await this.load();
  }
}

export const backup = new BackupStore();

export const formatBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

/** A destination's short name: the drive's name for an external one, else the folder's. */
export function destinationLabel(path: string): string {
  const vol = /^\/Volumes\/([^/]+)/.exec(path);
  if (vol) return vol[1];
  return path.split('/').filter(Boolean).pop() ?? path;
}
