<script lang="ts">
  import type { MobileTab } from './tabs';

  let { tab, onSelect }: { tab: MobileTab; onSelect: (t: MobileTab) => void } = $props();

  const tabs: Array<{ id: MobileTab; label: string; glyph: string }> = [
    { id: 'library', label: 'Library', glyph: '▤' },
    { id: 'playlists', label: 'Playlists', glyph: '≡' },
    { id: 'add', label: 'Add', glyph: '+' },
    { id: 'search', label: 'Search', glyph: '⌕' },
  ];
</script>

<nav class="tabbar">
  {#each tabs as t (t.id)}
    <button
      class="tab"
      class:active={tab === t.id}
      aria-current={tab === t.id ? 'page' : undefined}
      onclick={() => onSelect(t.id)}
    >
      <span class="glyph" aria-hidden="true">{t.glyph}</span>
      <span class="label">{t.label}</span>
    </button>
  {/each}
</nav>

<style>
  .tabbar {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    border-top: 1px solid var(--border);
    background: var(--bg-raised);
    /* Keep the row clear of the home indicator. viewport-fit=cover in app.html
       is what makes this inset non-zero. */
    padding-bottom: env(safe-area-inset-bottom);
    flex: none;
  }
  .tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    min-height: 52px;
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 10px;
    letter-spacing: 0.02em;
  }
  .tab.active { color: var(--accent); }
  .glyph { font-size: 17px; line-height: 1; }
</style>
