<script lang="ts">
  /**
   * Backups, above the local source's sync history: each backup folder, its
   * last backup and what isn't in it, a run in progress, and adding another.
   */
  import { onMount } from 'svelte';
  import { backup, destinationLabel, formatBytes, type DestinationStatus } from '$lib/stores/backup.svelte';
  import { chooseFolder } from '$lib/pickFolder';

  let path = $state('');
  let busy = $state(false);
  let problem = $state<string | null>(null);
  let typing = $state(false);
  let removing = $state<string | null>(null);

  const s = $derived(backup.status);
  const dests = $derived(s?.destinations ?? []);
  const connected = $derived(dests.filter((d) => d.destination.online));
  const n = (x: number) => x.toLocaleString();

  async function add(given = path.trim()) {
    busy = true;
    problem = await backup.addDestination(given);
    busy = false;
    if (!problem) { typing = false; path = ''; }
  }

  async function pick() {
    busy = true;
    problem = null;
    const r = await chooseFolder('Choose a folder for a Booth backup', '/Volumes');
    busy = false;
    if (r.error) { problem = r.error; typing = true; return; }
    if (r.path) await add(r.path);
  }

  async function remove(id: string) {
    problem = await backup.removeDestination(id);
    removing = null;
  }

  function when(iso: string): string {
    const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
    return days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  }

  function summary(d: DestinationStatus): string {
    const last = d.lastBackupAt ? `Last backup ${when(d.lastBackupAt)}.` : d.filesHeld ? 'A backup was started but hasn’t finished.' : 'No backup yet.';
    if (d.releasesNotBackedUp) return `${last} ${n(d.releasesNotBackedUp)} release${d.releasesNotBackedUp === 1 ? '' : 's'} not in it (${formatBytes(d.bytesToCopy)} to copy).`;
    return d.lastBackupAt ? `${last} Everything is in it.` : last;
  }

  onMount(() => { void backup.load(); });
</script>

<section class="backup">
  <div class="line"><span class="label">backups</span>
    {#if connected.length > 1 && !s?.running}<button class="link right" onclick={() => backup.start()}>back up all</button>{/if}
    {#if s?.running}<button class="link right" onclick={() => backup.stop()}>stop</button>{/if}
  </div>

  {#if s && !dests.length}
    <p>Pick a folder on another drive (an external disk, a NAS, or a folder your cloud storage syncs). Booth copies your music and its database there, checks each copy, and keeps track of what isn’t backed up yet. It adds and updates copies and never removes your music from that folder; it keeps the newest 10 database snapshots. You can add more than one.</p>
  {/if}

  {#each dests as d (d.destination.id)}
    <div class="dest">
      <div class="line">
        <span class="name" title={d.destination.path}>{destinationLabel(d.destination.path)}</span>
        <span class="path">{d.destination.path}</span>
        {#if d.destination.sameDisk}<span class="tag" title="It won’t help if the disk your music is on fails.">same disk as your music</span>{/if}
      </div>
      {#if d.running}
        <div class="muted">{#if d.running.filesTotal}Backing up… {n(d.running.filesDone)} of {n(d.running.filesTotal)} files · {formatBytes(d.running.bytesDone)} of {formatBytes(d.running.bytesTotal)}{:else}Looking at what needs copying…{/if}</div>
        <progress max={d.running.bytesTotal || 1} value={d.running.bytesDone}></progress>
      {:else if !d.destination.online}
        <div class="muted">Not connected{#if d.lastBackupAt}; last backup {when(d.lastBackupAt)}{/if}. Connect it to back up or check it.</div>
      {:else}
        <div class="muted">{summary(d)}</div>
        {#if d.lastRun && d.lastRun.state !== 'done'}
          <p class="warn">{d.lastRun.state === 'stopped' ? 'The last backup was stopped part-way; backing up again carries on from there.' : d.lastRun.error ?? 'The last backup failed.'}</p>
        {:else if d.lastRun?.failed}
          <p class="warn">{n(d.lastRun.failed)} file{d.lastRun.failed === 1 ? '' : 's'} couldn’t be copied last time; they’ll be tried again.</p>
        {/if}
      {/if}
      {#if removing === d.destination.id}
        <div class="row confirm">Booth stops backing up here. The backup stays in the folder; add the folder again to pick it back up.
          <button class="button secondary" onclick={() => remove(d.destination.id)}>Remove</button>
          <button class="link" onclick={() => (removing = null)}>cancel</button></div>
      {:else if !d.running}
        <div class="row">
          {#if d.destination.online && !s?.running}
            <button class="button secondary" onclick={() => backup.start({ destinationId: d.destination.id })}>Back up now</button>
            {#if d.lastBackupAt}<button class="link" title="Re-read every copy and replace any that differ from what was backed up" onclick={() => backup.start({ destinationId: d.destination.id, verify: true })}>check every copy</button>{/if}
          {/if}
          <button class="link right" onclick={() => (removing = d.destination.id)}>remove</button>
        </div>
      {/if}
    </div>
  {/each}

  {#if s}
    {#if typing}
      <form onsubmit={(e) => { e.preventDefault(); if (path.trim()) void add(); }}>
        <label class="visually-hidden" for="backup-path">Backup folder</label>
        <input id="backup-path" bind:value={path} placeholder="/Volumes/Backup" spellcheck="false" autocomplete="off" disabled={busy} />
        <button class="button secondary" type="submit" disabled={!path.trim() || busy}>Add</button>
        <button class="link" type="button" onclick={() => (typing = false)}>use the chooser</button>
      </form>
    {:else}
      <div class="row">
        <button class="button secondary" disabled={busy} onclick={pick}>{busy ? 'Choosing…' : dests.length ? 'Add another backup…' : 'Choose a backup folder…'}</button>
        <button class="link" type="button" onclick={() => (typing = true)}>type a path</button>
      </div>
    {/if}
    {#if problem}<p class="problem">{problem}</p>{/if}
  {/if}
</section>

<style>
  .backup { margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  .line { line-height: 1.6; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .label { color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; font-size: 11px; }
  .name { color: var(--text); font-weight: 600; }
  .path { color: var(--text-subtle); font-size: 11px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
  .tag { font-size: 10px; color: var(--warn, #d69a2c); border: 1px solid currentColor; border-radius: 3px; padding: 0 4px; }
  .dest { padding: 8px 0; border-top: 1px solid var(--border); }
  .dest:first-of-type { border-top: 0; }
  .right { margin-left: auto; }
  .confirm { color: var(--text-muted); font-size: 12px; flex-wrap: wrap; }
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
