<script lang="ts">
  /**
   * rekordbox's collection export, shown above the local source's sync
   * history next to Bandcamp. Booth reads it after every local sync and
   * attaches tempo, key, beat grid and cues to the tracks whose files it
   * names; nothing is written back to rekordbox.
   */
  import { onMount } from 'svelte';

  interface Last {
    at: string;
    path: string;
    error?: string;
    entries?: number;
    matched?: number;
    withGrid?: number;
    withCues?: number;
    unmatchedCount?: number;
    unmatched?: { path: string; title: string | null; artist: string | null }[];
  }
  interface Status { path: string | null; modifiedAt: string | null; last: Last | null; suggested: string | null }

  let { onConnected }: { onConnected?: () => void } = $props();

  let status = $state<Status | null>(null);
  let path = $state('');
  let busy = $state(false);
  let problem = $state<string | null>(null);

  const PROBLEMS: Record<string, string> = {
    missing: 'No file there. In rekordbox: File → Export Collection in xml format.',
    no_permission: 'macOS won’t let Booth read that file.',
    not_an_export: 'That isn’t a rekordbox collection export.',
  };

  async function load() {
    status = await fetch('/api/setup/rekordbox').then((r) => r.json()).catch(() => status);
    if (status?.suggested && !path) path = status.suggested;
  }

  async function connect() {
    busy = true;
    problem = null;
    try {
      const res = await fetch('/api/setup/rekordbox', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: path.trim() }),
      });
      const body = await res.json();
      if (!res.ok) { problem = PROBLEMS[body.problem] ?? 'Something went wrong.'; return; }
      await load();
      // The import runs with the sync the connect started, which may first
      // wait out one already running: check back until it lands.
      const before = status?.last?.at;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        await load();
        if (status?.last && status.last.at !== before) break;
      }
      onConnected?.();
    } finally {
      busy = false;
    }
  }

  async function disconnect() {
    busy = true;
    try {
      await fetch('/api/setup/rekordbox', { method: 'DELETE' });
      await load();
      onConnected?.();
    } finally {
      busy = false;
    }
  }

  onMount(() => { void load(); });

  const n = (x: number | undefined) => (x ?? 0).toLocaleString();
  const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
</script>

<section class="rekordbox">
  {#if status?.path}
    <div class="line"><span class="label">rekordbox</span> <span class="name" title={status.path}>{status.path.split('/').pop()}</span>
      {#if status.modifiedAt}<span class="muted"> · exported {day(status.modifiedAt)}</span>{/if}</div>
    {#if status.last?.error}
      <div class="line problem">Couldn’t read it: {status.last.error}</div>
    {:else if status.last}
      <div class="line muted">
        {n(status.last.matched)} of {n(status.last.entries)} tracks matched · {n(status.last.withGrid)} with beat grids · {n(status.last.withCues)} with cues
      </div>
      {#if status.last.unmatchedCount}
        <details>
          <summary>{n(status.last.unmatchedCount)} rekordbox tracks aren’t in Booth</summary>
          <ul>
            {#each status.last.unmatched ?? [] as u, i (i)}
              <li title={u.path}>{u.title ?? u.path.split('/').pop()}{#if u.artist} <span class="muted">— {u.artist}</span>{/if}</li>
            {/each}
            {#if (status.last.unmatchedCount ?? 0) > (status.last.unmatched?.length ?? 0)}<li class="muted">…and {n((status.last.unmatchedCount ?? 0) - (status.last.unmatched?.length ?? 0))} more</li>{/if}
          </ul>
        </details>
      {/if}
      <p class="note">Re-export after changing cues or grids in rekordbox. Cues set on a USB stick inside rekordbox stay on the stick and never reach the export.
        <button class="link" disabled={busy} onclick={disconnect}>Disconnect</button></p>
    {:else}
      <div class="line muted">Reading it with the next sync…</div>
    {/if}
  {:else if status}
    <p>Connect rekordbox’s collection export to bring its tempo, key, beat grids and cues into Booth. Booth only reads it. Where rekordbox has a tempo, Booth shows it instead of its own analysis, file tags or taps.</p>
    <form onsubmit={(e) => { e.preventDefault(); void connect(); }}>
      <label class="visually-hidden" for="rekordbox-path">rekordbox export file</label>
      <input id="rekordbox-path" bind:value={path} placeholder="~/Documents/rekordbox.xml" spellcheck="false" autocomplete="off" disabled={busy} />
      <button class="button secondary" type="submit" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>
    </form>
    {#if problem}<p class="problem">{problem}</p>{/if}
  {/if}
</section>

<style>
  .rekordbox { margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  .line { line-height: 1.6; }
  .label { color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; font-size: 11px; }
  .name { color: var(--text); font-weight: 600; }
  .muted { color: var(--text-subtle); }
  p { margin: 0 0 8px; line-height: 1.5; color: var(--text-muted); }
  .note { margin-top: 6px; font-size: 11px; color: var(--text-subtle); }
  .problem { color: var(--danger); margin-top: 8px; }
  .link { background: none; border: 0; padding: 0; color: var(--text-subtle); text-decoration: underline; cursor: pointer; font: inherit; }
  details { margin-top: 4px; font-size: 12px; }
  summary { cursor: pointer; color: var(--text-muted); }
  ul { margin: 4px 0 0; padding-left: 16px; max-height: 180px; overflow-y: auto; }
  li { line-height: 1.5; }
  form { display: flex; gap: 8px; flex-wrap: wrap; }
  input {
    flex: 1; min-width: 0; height: 28px; padding: 0 10px;
    background: var(--bg-input); border: 1px solid var(--border-strong); border-radius: var(--radius); font-size: 12px;
  }
  .button {
    display: inline-flex; align-items: center; height: 28px; padding: 0 12px;
    border-radius: var(--radius); font-weight: 500; border: 1px solid transparent; white-space: nowrap;
  }
  .button.secondary { background: var(--bg-input); border-color: var(--border-strong); color: var(--text); }
  .button.secondary:hover:not(:disabled) { border-color: var(--text-subtle); }
  .button:disabled { opacity: 0.5; cursor: default; }
  .button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .visually-hidden {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
</style>
