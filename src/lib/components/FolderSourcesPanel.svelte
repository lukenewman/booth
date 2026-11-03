<script lang="ts">
  /**
   * Folders Booth reads in place, shown above the local source's sync history.
   * Adding one starts a sync; removing one first says which tracks go with it.
   */
  import { onMount } from 'svelte';

  interface Folder { id: string; path: string; files: number | null; online: boolean | null }
  interface Impact { tracks: number; starred: number; withNotes: number; inPlaylists: number }

  let { onChanged }: { onChanged?: () => void } = $props();

  let folders = $state<Folder[]>([]);
  let path = $state('');
  let busy = $state(false);
  let problem = $state<string | null>(null);
  let removing = $state<{ id: string; impact: Impact } | null>(null);

  async function load() {
    folders = (await fetch('/api/folders').then((r) => r.json()).catch(() => ({ folders }))).folders;
  }

  async function add() {
    busy = true;
    problem = null;
    try {
      const res = await fetch('/api/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: path.trim() }) });
      const body = await res.json();
      if (!res.ok) { problem = body.error ?? 'Something went wrong.'; return; }
      path = '';
      await load();
      setTimeout(async () => { await load(); onChanged?.(); }, 5000);
    } finally {
      busy = false;
    }
  }

  async function askRemove(id: string) {
    const impact = await fetch(`/api/folders/${id}?preview=1`, { method: 'DELETE' }).then((r) => r.json());
    removing = { id, impact };
  }

  async function remove(id: string) {
    busy = true;
    try {
      await fetch(`/api/folders/${id}`, { method: 'DELETE' });
      removing = null;
      await load();
      onChanged?.();
    } finally {
      busy = false;
    }
  }

  function losses(i: Impact): string {
    if (!i.tracks) return 'No tracks leave the library: Music.app or another folder still lists all of them.';
    const extra = [i.starred && `${i.starred} starred`, i.withNotes && `${i.withNotes} with notes`, i.inPlaylists && `${i.inPlaylists} in playlists`].filter(Boolean);
    return `${i.tracks.toLocaleString()} ${i.tracks === 1 ? 'track leaves' : 'tracks leave'} the library${extra.length ? ` (${extra.join(', ')})` : ''}. The files stay on disk.`;
  }

  onMount(() => { void load(); });
</script>

<section class="folders">
  <div class="line"><span class="label">folders</span></div>
  {#each folders as f (f.id)}
    <div class="folder">
      <span class="path" title={f.path}>{f.path}</span>
      <span class="muted">{f.online === false ? 'offline' : f.files == null ? 'reading…' : `${f.files.toLocaleString()} files`}</span>
      {#if removing?.id === f.id}
        <div class="confirm">{losses(removing.impact)}
          <button class="button danger" disabled={busy} onclick={() => remove(f.id)}>Remove</button>
          <button class="button secondary" onclick={() => (removing = null)}>Cancel</button></div>
      {:else}
        <button class="link" onclick={() => askRemove(f.id)}>remove</button>
      {/if}
    </div>
  {/each}
  {#if !folders.length}
    <p>Point Booth at a folder of music, like a downloads folder or a drive. It reads the files where they are and never changes them.</p>
  {/if}
  <form onsubmit={(e) => { e.preventDefault(); if (path.trim()) void add(); }}>
    <label class="visually-hidden" for="folder-path">Folder path</label>
    <input id="folder-path" bind:value={path} placeholder="~/Music/Downloads" spellcheck="false" autocomplete="off" disabled={busy} />
    <button class="button secondary" type="submit" disabled={!path.trim() || busy}>Add folder</button>
  </form>
  {#if problem}<p class="problem">{problem}</p>{/if}
</section>

<style>
  .folders { margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  .line { line-height: 1.6; }
  .label { color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; font-size: 11px; }
  .folder { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; line-height: 1.6; }
  .path { color: var(--text); font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
  .muted { color: var(--text-subtle); }
  .confirm { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; color: var(--text-muted); font-size: 12px; }
  .link { background: none; border: 0; padding: 0; color: var(--text-subtle); cursor: pointer; font: inherit; font-size: 12px; margin-left: auto; }
  .link:hover { color: var(--text); }
  p { margin: 0 0 8px; line-height: 1.5; color: var(--text-muted); }
  .problem { color: var(--danger); margin-top: 8px; }
  form { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
  input {
    flex: 1; min-width: 0; height: 28px; padding: 0 10px;
    background: var(--bg-input); border: 1px solid var(--border-strong); border-radius: var(--radius); font-size: 12px;
  }
  .button {
    display: inline-flex; align-items: center; height: 26px; padding: 0 10px;
    border-radius: var(--radius); font-weight: 500; border: 1px solid transparent; white-space: nowrap; cursor: pointer;
  }
  .button.secondary { background: var(--bg-input); border-color: var(--border-strong); color: var(--text); }
  .button.danger { background: var(--bg-input); border-color: var(--danger); color: var(--danger); }
  .button:disabled { opacity: 0.5; cursor: default; }
  .visually-hidden {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
</style>
