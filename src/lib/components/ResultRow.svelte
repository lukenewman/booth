<script lang="ts">
  import type { DiscogsRelease } from '$lib/types';

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
    [release.format, release.year, release.country, release.label].filter(Boolean).join(' · '),
  );
</script>

<button class="row" class:highlighted {onclick} type="button">
  <div class="cover">
    {#if release.thumb}
      <img src={release.thumb} alt="" />
    {/if}
  </div>
  <div class="meta">
    <div class="title">
      {#if release.artist}<span class="artist">{release.artist}</span> — {/if}{release.title}
    </div>
    <div class="sub">{metaParts || '—'}</div>
  </div>
  {#if highlighted}
    <span class="kbd">↵</span>
  {/if}
</button>

<style>
  .row {
    display: flex;
    gap: 10px;
    padding: 8px;
    border-radius: var(--radius-sm);
    margin-bottom: 4px;
    align-items: center;
    background: transparent;
    border: 1px solid transparent;
    width: 100%;
    text-align: left;
  }
  .row.highlighted {
    background: var(--accent-bg);
    border-color: var(--accent-border);
  }
  .cover {
    width: 40px;
    height: 40px;
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
</style>
