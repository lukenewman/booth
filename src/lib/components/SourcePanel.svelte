<script lang="ts">
  /**
   * Per-source detail panel — header (source dot + name + optional open-link),
   * body of key/value rows. Stub sources render dimmed with a placeholder.
   */
  interface Facet { key: string; value: string; mono?: boolean }

  let {
    sourceId,
    sourceName,
    facets = [],
    externalUrl = null,
    isStub = false,
  }: {
    sourceId: string;
    sourceName: string;
    facets?: Facet[];
    externalUrl?: string | null;
    isStub?: boolean;
  } = $props();
</script>

<div class="panel" class:stub={isStub}>
  <div class="header">
    <span class="dot {sourceId}"></span>
    <span class="name">{sourceName}</span>
    {#if externalUrl}
      <a class="open-link" href={externalUrl} target="_blank" rel="noreferrer">open ↗</a>
    {/if}
  </div>
  <div class="body">
    {#if isStub}
      <div class="empty">Source not yet implemented.</div>
    {:else if facets.length === 0}
      <div class="empty">No facets contributed.</div>
    {:else}
      {#each facets as facet}
        <div class="row">
          <span class="key">{facet.key}</span>
          <span class="value" class:mono={facet.mono}>{facet.value}</span>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .panel {
    border: 1px solid var(--border);
    border-radius: 4px;
    margin-bottom: 10px;
    overflow: hidden;
    background: var(--bg-raised);
  }
  .panel.stub { opacity: 0.45; }

  .header {
    padding: 7px 11px;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid var(--border);
  }
  .name { flex: 0 0 auto; }
  .open-link {
    margin-left: auto;
    color: var(--text-subtle);
    text-decoration: none;
    font-size: 10px;
    text-transform: none;
    letter-spacing: 0;
  }
  .open-link:hover { color: var(--accent); }

  .dot {
    width: 6px; height: 6px; border-radius: 50%;
    flex-shrink: 0;
  }
  .dot.discogs   { background: var(--src-discogs); }
  .dot.local    { background: var(--src-local); }
  .dot.rekordbox { background: var(--src-rekordbox); opacity: 0.45; }
  .dot.plex      { background: var(--src-plex);      opacity: 0.45; }

  .body { padding: 8px 11px 10px; font-size: 12px; }
  .row {
    display: grid;
    grid-template-columns: 78px 1fr;
    gap: 12px;
    padding: 2px 0;
  }
  .key { color: var(--text-subtle); font-size: 11px; }
  .value {
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .value.mono {
    font-family: var(--font-mono);
    font-size: 11.5px;
  }
  .empty { color: var(--text-subtle); font-size: 11px; }
</style>
