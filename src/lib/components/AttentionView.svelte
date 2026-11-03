<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from '$lib/stores/toast.svelte';

  type Kind = 'missing' | 'duplicate' | 'unsupported';
  interface FFile {
    fileId: string; path: string; present: boolean;
    track: { id: string; title: string; artist: string; album: string | null } | null;
    starred: boolean; note: string | null; playlists: string[]; alsoIn: string[];
  }
  interface Finding { id: string; kind: Kind; raisedAt: string; files: FFile[] }

  let { onChanged }: { onChanged?: () => void } = $props();

  let findings = $state<Finding[]>([]);
  let loaded = $state(false);
  let busy = $state<string | null>(null);
  /** The destructive action waiting for a second click: finding id + action. */
  let confirming = $state<{ id: string; type: 'keep_one' | 'forget'; fileId?: string } | null>(null);
  let confirmingBulk = $state<Kind | null>(null);

  const KINDS: { kind: Kind; title: string; detail: string; bulk: string }[] = [
    { kind: 'missing', title: 'Missing files', detail: 'Music.app lists these, but the file isn’t on disk. Putting the file back, or fixing it in Music.app, clears it.', bulk: 'Leave all as they are' },
    { kind: 'duplicate', title: 'Duplicates', detail: 'The same audio in more than one file. Same recording on an album and a compilation can be fine.', bulk: 'Keep all copies' },
    { kind: 'unsupported', title: 'Unsupported files', detail: 'Booth can’t read these files’ tags. They stay listed in their source.', bulk: 'Acknowledge all' },
  ];
  const groups = $derived(KINDS.map((k) => ({ ...k, items: findings.filter((f) => f.kind === k.kind) })).filter((g) => g.items.length));

  async function load() {
    const res = await fetch('/api/attention');
    findings = (await res.json()).findings;
    loaded = true;
  }
  onMount(load);

  async function settle(id: string, body: Record<string, unknown>) {
    busy = id;
    confirming = null;
    try {
      const res = await fetch(`/api/attention/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) { toast.show((await res.text()) || 'Couldn’t settle that', { kind: 'error' }); return; }
      await load();
      onChanged?.();
    } finally {
      busy = null;
    }
  }

  async function settleAll(kind: Kind) {
    confirmingBulk = null;
    const res = await fetch('/api/attention/bulk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }) });
    if (!res.ok) { toast.show('Couldn’t settle those', { kind: 'error' }); return; }
    const { settled } = await res.json();
    toast.show(`Settled ${settled}`, { kind: 'success' });
    await load();
    onChanged?.();
  }

  /** What leaves with a track, in words, for the confirmation. */
  function losses(f: FFile): string {
    const parts: string[] = [];
    if (f.starred) parts.push('its star');
    if (f.note) parts.push('its note');
    if (f.playlists.length) parts.push(`its place in ${f.playlists.join(', ')}`);
    return parts.length ? parts.join(', ') : 'nothing you added';
  }
  function sourceName(id: string): string { return id === 'discogs' ? 'Discogs' : id; }
  function fileName(path: string): string { return path.split('/').slice(-3).join('/'); }
</script>

<div class="attention">
  {#if loaded && groups.length === 0}
    <div class="empty">Nothing needs attention.</div>
  {/if}
  {#each groups as g (g.kind)}
    <section class="group">
      <header>
        <h2>{g.title} <span class="n">{g.items.length}</span></h2>
        {#if confirmingBulk === g.kind}
          <span class="confirm">{g.bulk}: {g.items.length} {g.items.length === 1 ? 'item' : 'items'}?
            <button class="primary" onclick={() => settleAll(g.kind)}>Yes</button>
            <button onclick={() => (confirmingBulk = null)}>Cancel</button></span>
        {:else}
          <button onclick={() => (confirmingBulk = g.kind)}>{g.bulk}</button>
        {/if}
      </header>
      <p class="detail">{g.detail}</p>
      {#each g.items as f (f.id)}
        <div class="finding" class:busy={busy === f.id}>
          {#each f.files as file (file.fileId)}
            <div class="file">
              <div class="what">
                {#if file.track}<span class="title">{file.track.title}</span> <span class="sub">— {file.track.artist}{file.track.album ? ` · ${file.track.album}` : ''}</span>{/if}
                {#if file.starred}<span class="tag">★</span>{/if}
                {#if file.note}<span class="tag" title={file.note}>note</span>{/if}
                {#if file.playlists.length}<span class="tag" title={file.playlists.join(', ')}>{file.playlists.length} playlist{file.playlists.length === 1 ? '' : 's'}</span>{/if}
                <div class="path" title={file.path}>{fileName(file.path)}</div>
              </div>
              {#if f.kind === 'duplicate'}
                {#if confirming?.id === f.id && confirming.fileId === file.fileId}
                  <span class="confirm">Keep only this one? The others leave the library (their files stay on disk); their stars, notes, tapped BPMs and playlist places move here.
                    <button class="primary" onclick={() => settle(f.id, { type: 'keep_one', fileId: file.fileId })}>Keep this one</button>
                    <button onclick={() => (confirming = null)}>Cancel</button></span>
                {:else}
                  <button onclick={() => (confirming = { id: f.id, type: 'keep_one', fileId: file.fileId })}>Keep only this</button>
                {/if}
              {/if}
            </div>
          {/each}
          <div class="actions">
            {#if f.kind === 'duplicate'}
              <button onclick={() => settle(f.id, { type: 'keep_both' })}>Keep all</button>
            {:else if f.kind === 'missing'}
              <button onclick={() => settle(f.id, { type: 'leave' })}>Leave it</button>
              {#if confirming?.id === f.id && confirming.type === 'forget'}
                <span class="confirm">{#if f.files[0].alsoIn.length}The track stays (it’s also in {f.files[0].alsoIn.map(sourceName).join(', ')}); this only takes the missing file out of the library.{:else}Forget this track? It goes with {losses(f.files[0])}.{/if}
                  <button class="danger" onclick={() => settle(f.id, { type: 'forget' })}>Forget</button>
                  <button onclick={() => (confirming = null)}>Cancel</button></span>
              {:else}
                <button onclick={() => (confirming = { id: f.id, type: 'forget' })}>Forget the track…</button>
              {/if}
            {:else}
              <button onclick={() => settle(f.id, { type: 'acknowledge' })}>Acknowledge</button>
            {/if}
          </div>
        </div>
      {/each}
    </section>
  {/each}
</div>

<style>
  .attention { padding: 16px 20px; overflow-y: auto; height: 100%; }
  .empty { color: var(--text-subtle); padding: 40px 0; text-align: center; }
  .group { margin-bottom: 28px; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h2 { font-size: 14px; font-weight: 600; margin: 0; }
  .n { color: var(--text-subtle); font-weight: 400; margin-left: 4px; }
  .detail { color: var(--text-subtle); font-size: 12px; margin: 4px 0 10px; }
  .finding { border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; margin-bottom: 8px; }
  .finding.busy { opacity: 0.5; pointer-events: none; }
  .file { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 4px 0; }
  .file + .file { border-top: 1px dashed var(--border); }
  .what { min-width: 0; font-size: 13px; }
  .title { font-weight: 500; }
  .sub { color: var(--text-subtle); }
  .tag { font-size: 11px; color: var(--accent); margin-left: 6px; }
  .path { font-size: 11px; color: var(--text-subtle); font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actions { display: flex; gap: 8px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
  .confirm { font-size: 12px; display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  button { background: var(--bg-raised); border: 1px solid var(--border-strong); color: var(--text); border-radius: 3px; padding: 3px 8px; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap; }
  button:hover { background: var(--bg-row-hover); }
  button.primary { border-color: var(--accent); color: var(--accent); }
  button.danger { border-color: var(--danger); color: var(--danger); }
</style>
