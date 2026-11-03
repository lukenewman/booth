<script lang="ts">
  /**
   * Backups, above the local source's sync history: where they go, the last
   * one, what isn't in it, and a run in progress.
   */
  import { onMount } from 'svelte';
  import { backup, formatBytes } from '$lib/stores/backup.svelte';

  let path = $state('');
  let busy = $state(false);
  let problem = $state<string | null>(null);
  let changing = $state(false);

  const s = $derived(backup.status);
  const n = (x: number) => x.toLocaleString();

  async function choose() {
    busy = true;
    problem = await backup.setDestination(path.trim());
    busy = false;
    if (!problem) { changing = false; path = ''; }
  }

  function when(iso: string): string {
    const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
    return days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  }

  onMount(() => { void backup.load(); });
</script>

<section class="backup">
  <div class="line"><span class="label">backup</span>
    {#if s?.destination && !changing}<span class="name" title={s.destination.path}>{s.destination.path}</span>
      <button class="link" onclick={() => (changing = true)}>change</button>{/if}</div>

  {#if s?.destination && !changing}
    {#if s.destination.sameDisk}
      <p class="warn">This folder is on the same disk as your music, so it won’t help if that disk fails. A separate drive is safer.</p>
    {/if}
    {#if s.running}
      <div class="line muted">Backing up… {n(s.running.filesDone)} of {n(s.running.filesTotal)} files · {formatBytes(s.running.bytesDone)} of {formatBytes(s.running.bytesTotal)}</div>
      <progress max={s.running.bytesTotal || 1} value={s.running.bytesDone}></progress>
      <button class="button secondary" onclick={() => backup.stop()}>Stop</button>
    {:else}
      <div class="line muted">
        {#if s.lastBackupAt}Last backup {when(s.lastBackupAt)}.{:else}No backup yet.{/if}
        {#if s.releasesNotBackedUp}{n(s.releasesNotBackedUp)} release{s.releasesNotBackedUp === 1 ? '' : 's'} not in it ({formatBytes(s.bytesToCopy)} to copy).{:else if s.lastBackupAt}Everything is in it.{/if}
      </div>
      {#if s.lastRun && s.lastRun.state !== 'done'}
        <p class="warn">{s.lastRun.state === 'stopped' ? 'The last backup was stopped part-way; backing up again carries on from there.' : s.lastRun.error ?? 'The last backup failed.'}</p>
      {:else if s.lastRun?.failed}
        <p class="warn">{n(s.lastRun.failed)} file{s.lastRun.failed === 1 ? '' : 's'} couldn’t be copied last time; they’ll be tried again.</p>
      {/if}
      <div class="row">
        <button class="button secondary" onclick={() => backup.start()}>Back up now</button>
        {#if s.lastBackupAt}<button class="link" title="Re-read every copy and replace any that no longer match" onclick={() => backup.start(true)}>check every copy</button>{/if}
      </div>
    {/if}
  {:else if s}
    <p>Pick a folder on another drive (an external disk, a NAS, or a folder your cloud storage syncs). Booth copies your music and its database there, checks each copy, and keeps track of what isn’t backed up yet. Nothing in that folder is ever deleted.</p>
    <form onsubmit={(e) => { e.preventDefault(); if (path.trim()) void choose(); }}>
      <label class="visually-hidden" for="backup-path">Backup folder</label>
      <input id="backup-path" bind:value={path} placeholder="/Volumes/Backup" spellcheck="false" autocomplete="off" disabled={busy} />
      <button class="button secondary" type="submit" disabled={!path.trim() || busy}>Use this folder</button>
      {#if changing}<button class="link" type="button" onclick={() => (changing = false)}>cancel</button>{/if}
    </form>
    {#if problem}<p class="problem">{problem}</p>{/if}
  {/if}
</section>

<style>
  .backup { margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  .line { line-height: 1.6; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .label { color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; font-size: 11px; }
  .name { color: var(--text); font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%; }
  .muted { color: var(--text-subtle); display: block; }
  p { margin: 0 0 8px; line-height: 1.5; color: var(--text-muted); }
  .warn { color: var(--warn, #d69a2c); font-size: 12px; margin-top: 6px; }
  .problem { color: var(--danger); margin-top: 8px; }
  progress { width: 100%; height: 6px; margin: 4px 0 8px; }
  .row { display: flex; gap: 12px; align-items: center; margin-top: 6px; }
  .link { background: none; border: 0; padding: 0; color: var(--text-subtle); cursor: pointer; font: inherit; font-size: 12px; text-decoration: underline; }
  form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  input {
    flex: 1; min-width: 0; height: 28px; padding: 0 10px;
    background: var(--bg-input); border: 1px solid var(--border-strong); border-radius: var(--radius); font-size: 12px;
  }
  .button {
    display: inline-flex; align-items: center; height: 28px; padding: 0 12px;
    border-radius: var(--radius); font-weight: 500; border: 1px solid transparent; white-space: nowrap; cursor: pointer;
  }
  .button.secondary { background: var(--bg-input); border-color: var(--border-strong); color: var(--text); }
  .button:disabled { opacity: 0.5; cursor: default; }
  .visually-hidden {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
</style>
