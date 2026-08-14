<script lang="ts">
  /**
   * Right-pane surface shown when a Sources rail item is selected with no
   * entity highlighted. Lists recent sync_run rows for that source.
   */
  interface SyncRun {
    id: string;
    source: string;
    started_at: string;
    finished_at: string | null;
    summary: {
      rowsIn: number;
      releasesUpserted: number;
      tracksUpserted: number;
      releasesDeleted: number;
      tracksDeleted: number;
      conflicts: number;
      input?: { path: string; mtime: string; generatedAt?: string };
      stale?: boolean;
    } | null;
    error: string | null;
  }

  let {
    sourceId,
    sourceName,
    isStub = false,
    syncing = false,
    reloadKey = 0,
  }: {
    sourceId: string;
    sourceName: string;
    isStub?: boolean;
    syncing?: boolean;
    reloadKey?: number;
  } = $props();

  let runs = $state<SyncRun[]>([]);
  let loading = $state(false);

  async function load() {
    if (isStub) {
      runs = [];
      return;
    }
    loading = true;
    try {
      const res = await fetch(`/api/sources/${sourceId}/runs?limit=20`).then((r) =>
        r.json(),
      );
      runs = res.items ?? [];
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    // Re-fetch whenever the selected source changes or the parent bumps reloadKey
    // (e.g. after a manual sync via the chip completes).
    sourceId;
    reloadKey;
    load();
  });

  function relativeTime(iso: string): string {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    const m = Math.floor(seconds / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  function durationLabel(started: string, finished: string | null): string {
    if (!finished) return '—';
    const ms = new Date(finished).getTime() - new Date(started).getTime();
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${Math.round(s % 60)}s`;
  }

  function summaryLabel(run: SyncRun): string {
    if (run.error) return run.error;
    if (!run.summary) return '…';
    const s = run.summary;
    const parts: string[] = [];
    if (s.tracksUpserted) parts.push(`${s.tracksUpserted} tracks`);
    if (s.releasesUpserted) parts.push(`${s.releasesUpserted} releases`);
    if (s.tracksDeleted || s.releasesDeleted) {
      parts.push(`−${s.tracksDeleted + s.releasesDeleted}`);
    }
    if (s.conflicts) parts.push(`${s.conflicts} conflicts`);
    return parts.length ? parts.join(' · ') : 'no changes';
  }

  /**
   * A stale run succeeded but re-read an input file that hadn't changed since
   * the run before it, so it cannot have picked up anything new. Name the file
   * and its age — that's what tells you which export went cold.
   */
  function staleLabel(run: SyncRun): string | null {
    if (run.error || !run.summary?.stale) return null;
    const input = run.summary.input;
    if (!input) return 'input unchanged since the previous sync';
    const stamp = input.generatedAt ?? input.mtime;
    const days = Math.floor((Date.now() - new Date(stamp).getTime()) / 86_400_000);
    const age = days >= 1 ? `${days}d old` : 'unchanged';
    return `${input.path.split('/').pop()} ${age} — unchanged since the previous sync`;
  }
</script>

<div class="history">
  <div class="header">
    <span class="dot {sourceId}"></span>
    <span class="name">{sourceName}</span>
    <span class="caption">Sync history</span>
  </div>

  {#snippet runRow(run: SyncRun)}
    {@const stale = staleLabel(run)}
    <div class="row" class:errored={!!run.error} class:stale={!!stale}>
      <span class="status" aria-hidden="true"
        >{run.error ? '✗' : stale ? '⚠' : run.finished_at ? '✓' : '…'}</span
      >
      <span class="when" title={run.started_at}>{relativeTime(run.started_at)}</span>
      <span class="dur">{durationLabel(run.started_at, run.finished_at)}</span>
      <span class="summary" class:err={!!run.error}>{summaryLabel(run)}</span>
      {#if stale}
        <span class="warn" title={run.summary?.input?.path}>{stale}</span>
      {/if}
    </div>
  {/snippet}

  {#if isStub}
    <div class="empty">Source not yet implemented.</div>
  {:else if syncing}
    <div class="row syncing">
      <span class="spinner" aria-hidden="true"></span>
      <span class="when">Running…</span>
    </div>
    {#each runs as run (run.id)}
      {@render runRow(run)}
    {/each}
  {:else if loading && runs.length === 0}
    <div class="empty">Loading…</div>
  {:else if runs.length === 0}
    <div class="empty">No sync runs yet.</div>
  {:else}
    {#each runs as run (run.id)}
      {@render runRow(run)}
    {/each}
  {/if}
</div>

<style>
  .history {
    padding: 18px 20px 24px;
    overflow-y: auto;
    height: 100%;
    font-size: 12px;
  }
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }
  .name { color: var(--text); font-weight: 600; }
  .caption { color: var(--text-subtle); margin-left: auto; text-transform: none; letter-spacing: 0; }

  .dot {
    width: 6px; height: 6px; border-radius: 50%;
    flex-shrink: 0;
  }
  .dot.discogs   { background: var(--src-discogs); }
  .dot.local    { background: var(--src-local); }
  .dot.rekordbox { background: var(--src-rekordbox); opacity: 0.45; }
  .dot.plex      { background: var(--src-plex); opacity: 0.45; }

  .row {
    display: grid;
    grid-template-columns: 14px 1fr auto;
    grid-template-rows: auto auto auto;
    grid-template-areas:
      "status when dur"
      ".      summary summary"
      ".      warn    warn";
    column-gap: 10px;
    row-gap: 2px;
    padding: 7px 0;
    border-bottom: 1px solid var(--border);
  }
  .row.errored .status { color: var(--accent, #c44); }
  .row.stale .status { color: var(--warn, #d69a2c); }
  .warn {
    grid-area: warn;
    color: var(--warn, #d69a2c);
    font-size: 11px;
    margin-top: 1px;
  }
  .status { grid-area: status; color: var(--text-subtle); font-size: 11px; }
  .when { grid-area: when; color: var(--text); }
  .dur {
    grid-area: dur;
    color: var(--text-subtle);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .summary {
    grid-area: summary;
    color: var(--text-muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .summary.err {
    color: var(--accent, #c44);
    white-space: normal;
  }

  .row.syncing { color: var(--text-muted); }

  .empty {
    color: var(--text-subtle);
    font-size: 11px;
    padding: 8px 0;
  }

  .spinner {
    grid-area: status;
    display: inline-block;
    width: 9px;
    height: 9px;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.75s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
