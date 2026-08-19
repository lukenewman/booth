/**
 * Sync scheduling, kept pure: no env, no registry, no DB. The caller supplies
 * which sources are eligible and how to sync one, which lets verification
 * scripts drive it without SvelteKit's `$lib` alias.
 */

export const DEFAULT_INTERVAL_MINUTES = 360;

/**
 * Parse BOOTH_SYNC_INTERVAL_MINUTES into minutes. `0` means disabled.
 * Anything unparseable or negative falls back to the default rather than
 * disabling — a typo in `.env` must not silently stop the library syncing,
 * which is the exact failure this scheduler exists to prevent.
 */
export function parseIntervalMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_MINUTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_INTERVAL_MINUTES;
  return Math.floor(n);
}

export interface SchedulerDeps {
  /** Eligible source ids, re-read each tick so registry/env changes are picked up. */
  sourceIds: () => string[];
  sync: (sourceId: string) => Promise<unknown>;
  onError?: (sourceId: string, err: unknown) => void;
}

export interface SyncScheduler {
  tick: () => Promise<void>;
  inFlight: () => string[];
}

/**
 * One tick syncs every eligible source that is not already syncing. Runs must
 * not stack: a source still in flight is skipped for this tick, never queued,
 * so a sync slower than the interval cannot pile up behind itself.
 */
export function createScheduler(deps: SchedulerDeps): SyncScheduler {
  const running = new Set<string>();

  return {
    inFlight: () => [...running],
    async tick() {
      await Promise.all(
        deps.sourceIds().map(async (id) => {
          if (running.has(id)) return;
          running.add(id);
          try {
            await deps.sync(id);
          } catch (err) {
            deps.onError?.(id, err);
          } finally {
            running.delete(id);
          }
        }),
      );
    },
  };
}
