<script lang="ts">
  /**
   * Taking releases over, in Sources → Local: where Booth's folder lives, the
   * sample takeover (the first one), a run in progress, and the releases
   * Booth has taken over, each with undo.
   */
  import { onMount } from 'svelte';
  import { chooseFolder } from '$lib/pickFolder';
  import { formatBytes } from '$lib/stores/backup.svelte';

  interface SampleRelease { releaseId: string; title: string; artist: string; files: number; bytes: number; reasons: string[] }
  interface Status {
    folder: { path: string; chosen: boolean; hasFiles: boolean };
    running: { sample: boolean; releasesTotal: number; releasesDone: number; bytesTotal: number; bytesDone: number } | null;
    lastRun: { state: string; finishedAt: string | null; done: number; failed: { releaseId: string; title: string; error: string }[]; error: string | null } | null;
    owned: { releaseId: string; title: string; artist: string; files: number }[];
  }

  let status = $state<Status | null>(null);
  let sample = $state<{ seed: number; releases: SampleRelease[] } | null>(null);
  let folderChoice = $state('~/Music/Booth');
  let problem = $state<string | null>(null);
  let busy = $state(false);
  let undoing = $state<{ releaseId: string; files: number } | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function load() {
    try { status = await fetch('/api/takeover').then((r) => r.json()); } catch { /* keep the last */ }
    if (timer) clearTimeout(timer);
    if (status?.running) timer = setTimeout(() => void load(), 1500);
  }

  async function draw() {
    sample = await fetch(`/api/takeover/sample?seed=${Date.now()}`).then((r) => r.json());
    if (status?.folder.chosen) folderChoice = status.folder.path;
  }

  async function pickFolder() {
    const r = await chooseFolder('Choose where Booth keeps the files it takes over', '~/Music');
    if (r.error) { problem = r.error; return; }
    if (r.path) folderChoice = r.path;
  }

  async function start() {
    if (!sample) return;
    busy = true;
    problem = null;
    try {
      if (!status?.folder.chosen || folderChoice !== status.folder.path) {
        const res = await fetch('/api/takeover/folder', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folderChoice }) });
        if (!res.ok) { problem = (await res.json()).error ?? 'That folder won’t do.'; return; }
      }
      const res = await fetch('/api/takeover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ releaseIds: sample.releases.map((r) => r.releaseId), sample: true }) });
      if (!res.ok) { problem = (await res.json()).error ?? 'Couldn’t start.'; return; }
      sample = null;
      await load();
    } finally {
      busy = false;
    }
  }

  async function undo(releaseId: string) {
    busy = true;
    const res = await fetch(`/api/takeover/release/${releaseId}`, { method: 'DELETE' });
    busy = false;
    undoing = null;
    problem = res.ok ? null : ((await res.json()).error ?? 'Couldn’t undo.');
    await load();
  }

  const sampleBytes = $derived(sample?.releases.reduce((n, r) => n + r.bytes, 0) ?? 0);
  onMount(() => { void load(); return () => { if (timer) clearTimeout(timer); }; });
</script>

<section class="takeover">
  <div class="line"><span class="label">Booth’s folder</span>
    {#if status?.folder.chosen}<span class="name" title={status.folder.path}>{status.folder.path}</span>{/if}</div>

  {#if status?.running}
    <div class="muted"><span class="spinner" aria-hidden="true"></span>Taking over… {status.running.releasesDone} of {status.running.releasesTotal} releases · {formatBytes(status.running.bytesDone)} of {formatBytes(status.running.bytesTotal)}</div>
    <progress max={status.running.releasesTotal || 1} value={status.running.releasesDone}></progress>
    <button class="button secondary" onclick={async () => { await fetch('/api/takeover/stop', { method: 'POST' }); await load(); }}>Stop after this release</button>
  {:else if sample}
    <p>Booth copies these releases into its own folder, writes what it knows (stars, notes, date added, Discogs link) into the copies’ tags, checks every copy, and switches the tracks to them. <strong>Your original files are never changed.</strong> You can undo any release while its originals exist.</p>
    <p>Until you cut these releases over, Music.app and rekordbox keep using the originals, so they won’t see changes Booth makes to these releases.</p>
    <ul class="sample">
      {#each sample.releases as r (r.releaseId)}
        <li><span class="rtitle">{r.title}</span> <span class="sub">— {r.artist} · {r.files} file{r.files === 1 ? '' : 's'}</span>
          {#if r.reasons.length}<div class="reasons">{r.reasons.join(' · ')}</div>{/if}</li>
      {/each}
    </ul>
    <div class="row"><button class="link" onclick={draw} disabled={busy}>draw again</button><span class="muted inline">{formatBytes(sampleBytes)} to copy</span></div>
    <div class="line folder-line"><span class="muted inline">Booth’s folder:</span> <span class="name">{folderChoice}</span>
      {#if !status?.folder.hasFiles}<button class="link" onclick={pickFolder}>choose…</button>{/if}</div>
    <div class="row">
      <button class="button primary" disabled={busy || !sample.releases.length} onclick={start}>{busy ? 'Starting…' : `Take over ${sample.releases.length} releases`}</button>
      <button class="link" onclick={() => (sample = null)}>cancel</button>
    </div>
  {:else if status}
    {#if !status.owned.length}
      <p>Booth reads your music where it is. Taking a release over copies it into Booth’s own folder, so Booth can keep its stars, notes and edits in the files themselves. Start with a small sample you can undo.</p>
    {/if}
    {#if status.lastRun && (status.lastRun.failed.length || status.lastRun.error || status.lastRun.state === 'stopped')}
      <p class="warn">
        {#if status.lastRun.state === 'stopped'}The last takeover was stopped; {status.lastRun.done} release{status.lastRun.done === 1 ? '' : 's'} done.{/if}
        {#if status.lastRun.error}{status.lastRun.error}{/if}
        {#if status.lastRun.failed.length}{status.lastRun.failed.length} release{status.lastRun.failed.length === 1 ? '' : 's'} couldn’t be taken over and stayed as they were; Needs attention says why.{/if}
      </p>
    {/if}
    <div class="row"><button class="button secondary" onclick={draw}>{status.owned.length ? 'Take over another sample…' : 'Try a sample takeover…'}</button></div>
    {#if status.owned.length}
      <div class="owned-head muted">{status.owned.length} release{status.owned.length === 1 ? '' : 's'} taken over</div>
      {#each status.owned as o (o.releaseId)}
        <div class="owned">
          <span class="rtitle">{o.title}</span> <span class="sub">— {o.artist}</span>
          {#if undoing?.releaseId === o.releaseId}
            <span class="confirm">The tracks go back to the original files and Booth’s {o.files} cop{o.files === 1 ? 'y is' : 'ies are'} deleted. Stars, notes and playlists stay.
              <button class="button secondary" disabled={busy} onclick={() => undo(o.releaseId)}>Undo</button>
              <button class="link" onclick={() => (undoing = null)}>cancel</button></span>
          {:else}
            <button class="link right" onclick={() => (undoing = { releaseId: o.releaseId, files: o.files })}>undo</button>
          {/if}
        </div>
      {/each}
    {/if}
  {/if}
  {#if problem}<p class="problem">{problem}</p>{/if}
</section>

<style>
  .takeover { margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--border); }
  .line { line-height: 1.6; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .label { color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; font-size: 11px; }
  .name { color: var(--text); font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%; }
  .muted { color: var(--text-subtle); display: block; }
  .muted.inline { display: inline; }
  p { margin: 0 0 8px; line-height: 1.5; color: var(--text-muted); }
  .warn { color: var(--warn, #d69a2c); font-size: 12px; }
  .problem { color: var(--danger); margin-top: 8px; }
  progress { width: 100%; height: 6px; margin: 4px 0 8px; }
  .row { display: flex; gap: 12px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
  .folder-line { margin-top: 8px; }
  .sample { list-style: none; padding: 0; margin: 6px 0; }
  .sample li { padding: 4px 0; border-top: 1px solid var(--border); }
  .rtitle { color: var(--text); }
  .sub { color: var(--text-subtle); font-size: 12px; }
  .reasons { color: var(--text-subtle); font-size: 11px; }
  .owned-head { margin-top: 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
  .owned { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; padding: 3px 0; }
  .confirm { flex-basis: 100%; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; color: var(--text-muted); font-size: 12px; }
  .right { margin-left: auto; }
  .link { background: none; border: 0; padding: 0; color: var(--text-subtle); cursor: pointer; font: inherit; font-size: 12px; text-decoration: underline; }
  .button {
    display: inline-flex; align-items: center; height: 28px; padding: 0 12px;
    border-radius: var(--radius); font-weight: 500; border: 1px solid transparent; white-space: nowrap; cursor: pointer;
  }
  .button.secondary { background: var(--bg-input); border-color: var(--border-strong); color: var(--text); }
  .button.primary { background: var(--bg-input); border-color: var(--accent); color: var(--accent); }
  .button:disabled { opacity: 0.5; cursor: default; }
  .spinner {
    display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px;
    border: 1.5px solid var(--border-strong); border-top-color: var(--accent); border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }
</style>
