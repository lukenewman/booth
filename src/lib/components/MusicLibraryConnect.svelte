<script lang="ts">
  /**
   * Connecting the Apple Music library: find the export Music shares (or let
   * the person pick it), save its path, then run the first import. Used by the
   * first-run screen, the library nudge and the Sources → Local view.
   */
  import { musicLibrary } from '$lib/stores/musicLibrary.svelte';

  let {
    onConnected,
  }: {
    /** After the first import finishes, so the caller can reload its lists. */
    onConnected?: () => void;
  } = $props();

  type Phase =
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'problem'; problem: 'missing' | 'no_permission' | 'not_a_library' | 'unreachable'; path?: string }
    | { kind: 'importing'; trackCount: number }
    | { kind: 'done'; trackCount: number; modifiedAt: string; failed: boolean };

  let phase = $state<Phase>({ kind: 'idle' });
  let typing = $state(false);
  let typedPath = $state('');

  // Music rewrites the export within seconds of any library change, so one
  // untouched for weeks usually means sharing was switched off.
  const STALE_DAYS = 14;

  async function connect(path?: string) {
    if (phase.kind === 'checking' || phase.kind === 'importing') return;
    phase = { kind: 'checking' };
    let data: any;
    try {
      const res = await fetch('/api/setup/music', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(path ? { path } : {}),
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok) {
        phase = { kind: 'problem', problem: data?.problem ?? 'unreachable', path: data?.path };
        return;
      }
    } catch {
      phase = { kind: 'problem', problem: 'unreachable' };
      return;
    }

    musicLibrary.connected = true;
    phase = { kind: 'importing', trackCount: data.trackCount };
    let failed = false;
    try {
      const res = await fetch('/api/sources/local/sync', { method: 'POST' });
      failed = !res.ok;
    } catch {
      failed = true;
    }
    phase = { kind: 'done', trackCount: data.trackCount, modifiedAt: data.modifiedAt, failed };
    onConnected?.();
  }

  async function choose() {
    try {
      const res = await fetch('/api/setup/music/choose', { method: 'POST' });
      const data = await res.json();
      if (data?.path) await connect(data.path);
    } catch {
      phase = { kind: 'problem', problem: 'unreachable' };
    }
  }

  function isStale(iso: string): boolean {
    return Date.now() - new Date(iso).getTime() > STALE_DAYS * 86_400_000;
  }

  const busy = $derived(phase.kind === 'checking' || phase.kind === 'importing');
  const fmt = new Intl.NumberFormat();
</script>

<div class="connect">
  {#if phase.kind === 'done'}
    <div role="status">
      {#if phase.failed}
        <p>
          Connected, but the first import hit a problem. booth tries again on its next sync,
          and the Local source shows what went wrong.
        </p>
      {:else}
        <p class="good">Imported {fmt.format(phase.trackCount)} tracks from Music.</p>
      {/if}
      {#if isStale(phase.modifiedAt)}
        <p class="note">
          Music last updated this file on {new Date(phase.modifiedAt).toLocaleDateString()}. If you've
          changed your library since, check that sharing is still on (Music → Settings → Advanced).
        </p>
      {/if}
    </div>
  {:else if phase.kind === 'importing'}
    <p role="status">Found {fmt.format(phase.trackCount)} tracks. Importing…</p>
  {:else}
    {#if phase.kind === 'problem'}
      <div class="problem" role="alert">
        {#if phase.problem === 'missing'}
          <p>
            booth couldn't find the library file. In Music, choose <em>Music → Settings…</em>, open
            <em>Advanced</em>, and turn on <em>Share iTunes Library XML with other applications</em>.
            Music writes the file a few seconds later.
          </p>
        {:else if phase.problem === 'no_permission'}
          <p>
            macOS is keeping booth out of your Music folder. Open <em>System Settings → Privacy &amp; Security
            → Files and Folders</em>, turn on <em>Music Folder</em> under booth, then try again.
          </p>
        {:else if phase.problem === 'not_a_library'}
          <p>
            {phase.path ?? 'That file'} isn't a Music library export. The one booth needs is
            <em>Library.xml</em>, in the Music folder inside your Music folder.
          </p>
        {:else}
          <p>Something went wrong talking to booth. Try again.</p>
        {/if}
      </div>
    {:else}
      <p>
        booth reads the library file Music shares, so your tracks show up here and play in booth.
        macOS may ask to let booth into your Music folder. Allow it.
      </p>
    {/if}

    <div class="actions">
      <button class="button primary" onclick={() => connect()} disabled={busy}>
        {phase.kind === 'checking' ? 'Looking…' : phase.kind === 'problem' ? 'Try again' : 'Find my Music library'}
      </button>
      {#if musicLibrary.canChooseFile}
        <button class="button secondary" onclick={choose} disabled={busy}>Choose file…</button>
      {:else if !typing}
        <button class="button secondary" onclick={() => (typing = true)} disabled={busy}>Enter its location…</button>
      {/if}
    </div>

    {#if typing && !musicLibrary.canChooseFile}
      <form onsubmit={(e) => { e.preventDefault(); if (typedPath.trim()) void connect(typedPath.trim()); }}>
        <label class="visually-hidden" for="music-xml-path">Location of the library file</label>
        <input
          id="music-xml-path"
          bind:value={typedPath}
          spellcheck="false"
          autocomplete="off"
          placeholder="~/Music/Music/Library.xml"
          disabled={busy}
        />
        <button class="button secondary" type="submit" disabled={!typedPath.trim() || busy}>Use this file</button>
      </form>
    {/if}
  {/if}
</div>

<style>
  .connect p { margin: 0 0 10px; line-height: 1.5; color: var(--text-muted); }
  .connect em { font-style: normal; color: var(--text); }
  .connect .good { color: var(--text); }
  .connect .note { font-size: 12px; color: var(--text-subtle); }
  .problem p { color: var(--text); }

  .actions, form { display: flex; gap: 8px; flex-wrap: wrap; }
  form { margin-top: 8px; }

  .button {
    display: inline-flex;
    align-items: center;
    height: 32px;
    padding: 0 14px;
    border-radius: var(--radius);
    font-weight: 500;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .button.secondary { background: var(--bg-input); border-color: var(--border-strong); color: var(--text); }
  .button.secondary:hover:not(:disabled) { border-color: var(--text-subtle); }
  .button.primary { background: var(--accent); color: var(--bg-sunken); }
  .button.primary:hover:not(:disabled) { background: var(--accent-strong); }
  .button:disabled { opacity: 0.5; cursor: default; }
  .button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  input {
    flex: 1;
    min-width: 0;
    height: 32px;
    padding: 0 10px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    font-family: var(--font-mono);
    font-size: 13px;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>
