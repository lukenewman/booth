/**
 * Backup status, shared by the panel in Sources → Local and the nudge above
 * the library. Polls while a run is going.
 */
export interface BackupStatus {
  destination: { id: string; path: string; sameDisk: boolean } | null;
  lastBackupAt: string | null;
  daysSince: number | null;
  releasesNotBackedUp: number;
  filesToCopy: number;
  bytesToCopy: number;
  running: { startedAt: string; filesTotal: number; filesDone: number; bytesTotal: number; bytesDone: number } | null;
  lastRun: { state: string; finishedAt: string | null; error: string | null; failed: number } | null;
}

class BackupStore {
  status = $state<BackupStatus | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;

  async load() {
    try {
      this.status = await fetch('/api/backup').then((r) => r.json());
    } catch { /* keep the last status */ }
    if (this.timer) clearTimeout(this.timer);
    if (this.status?.running) this.timer = setTimeout(() => void this.load(), 2000);
  }

  async setDestination(path: string): Promise<string | null> {
    const res = await fetch('/api/backup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
    if (!res.ok) return (await res.json().catch(() => ({}))).error ?? 'Something went wrong.';
    await this.load();
    return null;
  }

  async start(verify = false) {
    await fetch('/api/backup/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verify }) });
    await this.load();
  }

  async stop() {
    await fetch('/api/backup/stop', { method: 'POST' });
    await this.load();
  }
}

export const backup = new BackupStore();

export const formatBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
