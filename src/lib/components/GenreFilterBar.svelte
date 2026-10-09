<script lang="ts">
  /**
   * Genre and style filter chips. Used bound to the library filter
   * (explorerState.genre) and, in "rule" mode, to a smart playlist's rule.
   *
   * Genres cycle off → include → exclude → off from a menu of Discogs' fifteen;
   * styles come from a typeahead over the vocabulary (Enter includes,
   * Shift+Enter excludes). Excludes never match untagged records — the
   * Untagged view is where those live.
   */
  import type { Snippet } from 'svelte';
  import StylePill from './StylePill.svelte';
  import { display } from '$lib/genres';
  import { genresStore } from '$lib/stores/genres.svelte';

  type Sel = { include: string[]; exclude: string[] };
  type Value = { genres?: Sel; styles?: Sel };

  let {
    value,
    onchange,
    actions,
  }: {
    value: Value;
    onchange: (v: Value) => void;
    /** Extra controls at the end of the bar (e.g. "save as smart playlist"). */
    actions?: Snippet;
  } = $props();

  const empty = (): Sel => ({ include: [], exclude: [] });
  const genres = $derived(value.genres ?? empty());
  const styles = $derived(value.styles ?? empty());
  const hasAny = $derived(
    genres.include.length + genres.exclude.length + styles.include.length + styles.exclude.length > 0,
  );

  let menuOpen = $state(false);
  let styleQuery = $state('');
  let highlight = $state(0);

  function genreState(g: string): 'off' | 'in' | 'out' {
    return genres.include.includes(g) ? 'in' : genres.exclude.includes(g) ? 'out' : 'off';
  }

  function cycleGenre(g: string) {
    const st = genreState(g);
    const include = genres.include.filter((x) => x !== g);
    const exclude = genres.exclude.filter((x) => x !== g);
    if (st === 'off') include.push(g);
    else if (st === 'in') exclude.push(g);
    onchange({ ...value, genres: { include, exclude } });
  }

  function removeGenre(g: string) {
    onchange({ ...value, genres: { include: genres.include.filter((x) => x !== g), exclude: genres.exclude.filter((x) => x !== g) } });
  }

  function addStyle(s: string, exclude: boolean) {
    const include = styles.include.filter((x) => x !== s);
    const excl = styles.exclude.filter((x) => x !== s);
    (exclude ? excl : include).push(s);
    onchange({ ...value, styles: { include, exclude: excl } });
    styleQuery = '';
    highlight = 0;
  }

  function removeStyle(s: string) {
    onchange({ ...value, styles: { include: styles.include.filter((x) => x !== s), exclude: styles.exclude.filter((x) => x !== s) } });
  }

  const matches = $derived.by(() => {
    const q = styleQuery.trim().toLowerCase();
    if (!q) return [];
    const taken = new Set([...styles.include, ...styles.exclude]);
    return genresStore.styles
      .filter((s) => !taken.has(s.name) && s.name.toLowerCase().includes(q))
      .slice(0, 8);
  });

  function onStyleKey(e: KeyboardEvent) {
    // The global shortcuts must not see typing in here.
    e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight = Math.min(highlight + 1, matches.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight = Math.max(highlight - 1, 0); }
    else if (e.key === 'Enter' && matches[highlight]) { e.preventDefault(); addStyle(matches[highlight].name, e.shiftKey); }
    else if (e.key === 'Escape') { styleQuery = ''; (e.currentTarget as HTMLInputElement).blur(); }
  }
</script>

<div class="genre-bar">
  <div class="menu-wrap">
    <button type="button" class="menu-btn" class:active={menuOpen} onclick={() => (menuOpen = !menuOpen)}>genre ▾</button>
    {#if menuOpen}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="menu" onmouseleave={() => (menuOpen = false)}>
        {#each genresStore.genres as g (g)}
          {@const st = genreState(g)}
          <button type="button" class="menu-item {st}" onclick={() => cycleGenre(g)}
            title="Click to cycle: show only · exclude · off">
            <span class="mark">{st === 'in' ? '✓' : st === 'out' ? '–' : ''}</span>{display(g)}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="style-wrap">
    <input
      class="style-input"
      placeholder="style…"
      bind:value={styleQuery}
      onkeydown={onStyleKey}
      oninput={() => (highlight = 0)}
      spellcheck="false"
      autocomplete="off"
      aria-label="Filter by style"
    />
    {#if matches.length}
      <div class="suggest">
        {#each matches as m, i (m.name)}
          <button type="button" class="suggest-item" class:hl={i === highlight}
            onmousedown={(e) => { e.preventDefault(); addStyle(m.name, e.shiftKey); }}>
            <StylePill style={m.name} />
            <span class="count">{m.releases || ''}</span>
          </button>
        {/each}
        <div class="hint">⏎ include · ⇧⏎ exclude</div>
      </div>
    {/if}
  </div>

  <div class="chips">
    {#each genres.include as g (g)}
      <span class="chip">{display(g)}<button type="button" class="x" aria-label="Remove {display(g)}" onclick={() => removeGenre(g)}>×</button></span>
    {/each}
    {#each genres.exclude as g (g)}
      <span class="chip out">not {display(g)}<button type="button" class="x" aria-label="Remove not {display(g)}" onclick={() => removeGenre(g)}>×</button></span>
    {/each}
    {#each styles.include as s (s)}
      <span class="pill-chip"><StylePill style={s} onclick={() => removeStyle(s)} title="Remove {display(s)}" /></span>
    {/each}
    {#each styles.exclude as s (s)}
      <span class="pill-chip"><StylePill style={s} excluded onclick={() => removeStyle(s)} title="Remove not {display(s)}" /></span>
    {/each}
    {#if hasAny}
      <button type="button" class="clear" onclick={() => onchange({})}>clear</button>
    {/if}
  </div>

  {#if actions}<div class="actions">{@render actions()}</div>{/if}
</div>

<style>
  .genre-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 14px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    flex-wrap: wrap;
    font-size: 11px;
  }
  .menu-wrap, .style-wrap { position: relative; }
  .menu-btn {
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    color: var(--text-muted);
    padding: 3px 8px;
    font: inherit;
    cursor: pointer;
  }
  .menu-btn:hover, .menu-btn.active { color: var(--text); border-color: var(--text-muted); }
  .menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 20;
    background: var(--bg-raised);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 4px;
    min-width: 180px;
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.4);
  }
  .menu-item {
    display: flex;
    gap: 6px;
    width: 100%;
    background: transparent;
    border: 0;
    color: var(--text-muted);
    text-align: left;
    padding: 4px 6px;
    font: inherit;
    font-size: 12px;
    border-radius: 4px;
    cursor: pointer;
  }
  .menu-item:hover { background: var(--accent-bg); color: var(--text); }
  .menu-item.in { color: var(--text); }
  .menu-item.out { color: var(--text-subtle); text-decoration: line-through; }
  .mark { width: 10px; color: var(--accent); }
  .style-input {
    width: 110px;
    height: 22px;
    padding: 0 8px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    font: inherit;
    color: var(--text);
  }
  .style-input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .suggest {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    z-index: 20;
    background: var(--bg-raised);
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 4px;
    min-width: 200px;
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.4);
  }
  .suggest-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    background: transparent;
    border: 0;
    padding: 3px 4px;
    border-radius: 4px;
    cursor: pointer;
  }
  .suggest-item.hl, .suggest-item:hover { background: var(--accent-bg); }
  .count { color: var(--text-subtle); font-size: 10px; font-variant-numeric: tabular-nums; }
  .hint { color: var(--text-subtle); font-size: 10px; padding: 4px 4px 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-width: 0; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    color: var(--text);
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    padding: 0 2px 0 8px;
    line-height: 16px;
  }
  .chip.out { color: var(--text-muted); }
  .x {
    background: transparent;
    border: 0;
    color: var(--text-subtle);
    cursor: pointer;
    padding: 0 4px;
    font: inherit;
  }
  .x:hover { color: var(--text); }
  .clear {
    background: transparent;
    border: 0;
    color: var(--text-subtle);
    cursor: pointer;
    font: inherit;
    text-decoration: underline;
  }
  .clear:hover { color: var(--text); }
  .actions { margin-left: auto; display: flex; gap: 6px; }
</style>
