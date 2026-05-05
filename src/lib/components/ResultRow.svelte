<script lang="ts">
  import type { DiscogsRelease } from '$lib/types';
  import { collection } from '$lib/stores/collection.svelte';

  let {
    release,
    highlighted = false,
    onclick,
  }: {
    release: DiscogsRelease;
    highlighted?: boolean;
    onclick?: () => void;
  } = $props();

  let metaParts = $derived(
    [release.format, release.year, release.country, release.label, release.catno]
      .filter(Boolean)
      .join(' · '),
  );
  let owned = $derived(collection.has(release.id));
</script>

<div class="row" class:highlighted class:owned>
  <button class="select" {onclick} type="button">
    <div class="cover">
      {#if release.thumb}
        <img src={release.thumb} alt="" />
      {/if}
    </div>
    <div class="meta">
      <div class="title">
        {#if release.artist}<span class="artist">{release.artist}</span> — {/if}{release.title}
        {#if owned}<span class="badge">✓ in collection</span>{/if}
      </div>
      <div class="sub">{metaParts || '—'}</div>
    </div>
    {#if highlighted}
      <span class="kbd">↵</span>
    {/if}
  </button>
</div>

<style>
  .row {
    border-radius: var(--radius-sm);
    margin-bottom: 4px;
    background: transparent;
    border: 1px solid transparent;
  }
  .row.highlighted {
    background: var(--accent-bg);
    border-color: var(--accent-border);
  }
  .select {
    display: flex;
    gap: 12px;
    padding: 8px;
    align-items: center;
    background: transparent;
    border: none;
    width: 100%;
    text-align: left;
    cursor: pointer;
    color: inherit;
  }
  .cover {
    width: 80px;
    height: 80px;
    background: #2a2a2a;
    border-radius: 3px;
    flex-shrink: 0;
    overflow: hidden;
  }
  .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .meta {
    flex: 1;
    min-width: 0;
  }
  .title {
    font-size: 13px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .artist {
    color: var(--text);
  }
  .sub {
    font-size: 11px;
    color: var(--text-muted);
  }
  .row.owned .cover {
    outline: 2px solid #4caf50;
    outline-offset: -2px;
  }
  .row.owned .title {
    color: var(--text-muted);
  }
  .badge {
    margin-left: 6px;
    padding: 1px 6px;
    border-radius: 10px;
    background: rgba(76, 175, 80, 0.15);
    color: #6fcf72;
    font-size: 10px;
    font-weight: 500;
    vertical-align: middle;
    white-space: nowrap;
  }
</style>
