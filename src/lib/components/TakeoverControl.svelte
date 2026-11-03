<script lang="ts">
  /**
   * On a release's detail: "Booth's copy" with undo once Booth has taken the
   * release over, or "Take over this release" (the pick-my-own path).
   */
  let { releaseId }: { releaseId: string } = $props();

  interface State { owned: number; inPlace: number; missing: number; undo: { files: { copy: string; original: string }[]; lost: string[] } | null }
  let s = $state<State | null>(null);
  let confirming = $state(false);
  let busy = $state(false);
  let problem = $state<string | null>(null);
  let note = $state<string | null>(null);

  async function load(id: string) {
    s = null; confirming = false; problem = null; note = null;
    try { s = await fetch(`/api/takeover/release/${id}`).then((r) => r.json()); } catch { s = null; }
  }
  $effect(() => { void load(releaseId); });

  async function takeOver() {
    busy = true;
    problem = null;
    const res = await fetch('/api/takeover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ releaseIds: [releaseId] }) });
    busy = false;
    if (!res.ok) { problem = (await res.json()).error ?? 'Couldn’t start.'; return; }
    note = 'Taking it over… Sources → Local shows progress.';
  }

  async function undo() {
    busy = true;
    const res = await fetch(`/api/takeover/release/${releaseId}`, { method: 'DELETE' });
    busy = false;
    if (!res.ok) { problem = (await res.json()).error ?? 'Couldn’t undo.'; return; }
    await load(releaseId);
  }
</script>

{#if s && (s.owned || s.inPlace)}
  <div class="takeover-control">
    {#if s.owned && !s.inPlace}
      <span class="badge" title="Its files are Booth’s copies, in Booth’s folder">Booth’s copy</span>
      {#if confirming}
        <span class="confirm">Go back to the original files? Booth’s {s.owned} cop{s.owned === 1 ? 'y is' : 'ies are'} deleted; stars, notes and playlists stay.{#if s.undo?.lost.length} Lost: {s.undo.lost.join(', ')}.{/if}
          <button disabled={busy} onclick={undo}>Undo takeover</button>
          <button class="link" onclick={() => (confirming = false)}>cancel</button></span>
      {:else}
        <button class="link" onclick={() => (confirming = true)}>undo…</button>
      {/if}
    {:else if !s.missing}
      {#if note}<span class="muted">{note}</span>{:else}<button class="link" disabled={busy} onclick={takeOver}>take over this release</button>{/if}
    {/if}
    {#if problem}<span class="problem">{problem}</span>{/if}
  </div>
{/if}

<style>
  .takeover-control { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: 12px; margin: 4px 0; }
  .badge { font-size: 10px; color: var(--accent); border: 1px solid currentColor; border-radius: 3px; padding: 0 4px; }
  .confirm { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; color: var(--text-muted); }
  .muted { color: var(--text-subtle); }
  .problem { color: var(--danger); }
  .link { background: none; border: 0; padding: 0; color: var(--text-subtle); cursor: pointer; font: inherit; font-size: 12px; text-decoration: underline; }
  button:not(.link) { font: inherit; font-size: 12px; cursor: pointer; border-radius: var(--radius); padding: 2px 8px; background: var(--bg-input); border: 1px solid var(--border-strong); color: var(--text); }
</style>
