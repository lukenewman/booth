<script lang="ts">
  /**
   * Hand-set a release's genres and styles. Picking a style ticks its parent
   * genres (Deep House → electronic), which is what makes tagging a record in
   * the Untagged queue one gesture in the common case. Each chosen style's dot
   * opens the palette to recolour it everywhere.
   */
  import { onMount, untrack } from 'svelte';
  import StylePill from './StylePill.svelte';
  import { PALETTE, display } from '$lib/genres';
  import { genresStore } from '$lib/stores/genres.svelte';

  let {
    genres: initialGenres,
    styles: initialStyles,
    canRevert = false,
    onSave,
    onRevert,
    onCancel,
  }: {
    genres: string[];
    styles: string[];
    /** True when the current answer is a manual override. */
    canRevert?: boolean;
    onSave: (tags: { genres: string[]; styles: string[] }) => void;
    onRevert?: () => void;
    onCancel: () => void;
  } = $props();

  // A draft seeded once: the editor is remounted per release (keyed by its id).
  let genres = $state<string[]>(untrack(() => [...initialGenres]));
  let styles = $state<string[]>(untrack(() => [...initialStyles]));
  let query = $state('');
  let highlight = $state(0);
  let paletteFor = $state<string | null>(null);
  let input: HTMLInputElement | undefined = $state();

  onMount(() => input?.focus());

  function toggleGenre(g: string) {
    genres = genres.includes(g) ? genres.filter((x) => x !== g) : [...genres, g];
  }

  function addStyle(name: string) {
    const s = name.trim();
    if (!s || styles.includes(s)) return;
    styles = [...styles, s];
    for (const p of genresStore.parentsOf(s)) if (!genres.includes(p)) genres = [...genres, p];
    query = '';
    highlight = 0;
  }

  const matches = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return genresStore.styles.filter((s) => !styles.includes(s.name) && s.name.toLowerCase().includes(q)).slice(0, 8);
  });

  function save() {
    onSave({ genres: genresStore.genres.filter((g) => genres.includes(g)), styles });
  }

  function onKey(e: KeyboardEvent) {
    // Global shortcuts (s, v, g, arrows) must not fire while typing here.
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }
    if (e.key === 'ArrowDown' && matches.length) { e.preventDefault(); highlight = Math.min(highlight + 1, matches.length - 1); return; }
    if (e.key === 'ArrowUp' && matches.length) { e.preventDefault(); highlight = Math.max(highlight - 1, 0); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (matches[highlight]) addStyle(matches[highlight].name);
      // A typed style outside the vocabulary is allowed; it just has no parent genre.
      else if (query.trim()) addStyle(query);
      else save();
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="tag-editor" onkeydown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}>
  <div class="genres">
    {#each genresStore.genres as g (g)}
      <label class="genre">
        <input type="checkbox" checked={genres.includes(g)} onchange={() => toggleGenre(g)} />
        {display(g)}
      </label>
    {/each}
  </div>

  <div class="styles">
    {#each styles as s (s)}
      <span class="chosen">
        <button type="button" class="dot" style:background={PALETTE[genresStore.slotFor(s)].fg}
          aria-label="Colour for {display(s)}" title="Change colour" onclick={() => (paletteFor = paletteFor === s ? null : s)}></button>
        <StylePill style={s} />
        <button type="button" class="x" aria-label="Remove {display(s)}" onclick={() => (styles = styles.filter((x) => x !== s))}>×</button>
      </span>
    {/each}
    <div class="style-wrap">
      <input bind:this={input} class="style-input" placeholder="add a style…" bind:value={query}
        oninput={() => (highlight = 0)} onkeydown={onKey} spellcheck="false" autocomplete="off" aria-label="Add a style" />
      {#if matches.length}
        <div class="suggest">
          {#each matches as m, i (m.name)}
            <button type="button" class="suggest-item" class:hl={i === highlight}
              onmousedown={(e) => { e.preventDefault(); addStyle(m.name); }}>
              <StylePill style={m.name} />
              <span class="parents">{m.parents.map(display).join(', ')}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  {#if paletteFor}
    {@const target = paletteFor}
    <div class="palette" aria-label="Colours for {display(target)}">
      {#each PALETTE as c, slot}
        <button type="button" class="swatch" class:current={genresStore.slotFor(target) === slot}
          style:background={c.bg} style:color={c.fg} aria-label="Colour {slot + 1}"
          onclick={() => { void genresStore.pin(target, slot); paletteFor = null; }}>●</button>
      {/each}
    </div>
  {/if}

  <div class="buttons">
    <button type="button" class="btn primary" onclick={save}>Save<span class="kbd">⏎</span></button>
    {#if canRevert && onRevert}
      <button type="button" class="btn" onclick={onRevert} title="Drop the hand-set tags and use the sources' answer">Revert to source</button>
    {/if}
    <button type="button" class="btn quiet" onclick={onCancel}>Cancel<span class="kbd">esc</span></button>
  </div>
</div>

<style>
  .tag-editor {
    margin-top: 10px;
    padding: 10px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    background: var(--bg-sunken);
    font-size: 12px;
  }
  .genres {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 2px 10px;
    margin-bottom: 10px;
  }
  .genre { display: flex; gap: 6px; align-items: center; color: var(--text-muted); cursor: pointer; }
  .genre:has(input:checked) { color: var(--text); }
  .styles { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .chosen { display: inline-flex; align-items: center; gap: 3px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; border: 0; padding: 0; cursor: pointer; }
  .x { background: transparent; border: 0; color: var(--text-subtle); cursor: pointer; padding: 0 2px; font: inherit; }
  .x:hover { color: var(--text); }
  .style-wrap { position: relative; }
  .style-input {
    width: 140px; height: 22px; padding: 0 8px;
    background: var(--bg-input); border: 1px solid var(--border-strong); border-radius: 4px;
    font: inherit; color: var(--text);
  }
  .style-input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .suggest {
    position: absolute; top: calc(100% + 4px); left: 0; z-index: 20;
    background: var(--bg-raised); border: 1px solid var(--border-strong); border-radius: 6px;
    padding: 4px; min-width: 220px; box-shadow: 0 6px 24px rgb(0 0 0 / 0.4);
  }
  .suggest-item {
    display: flex; justify-content: space-between; align-items: center; gap: 8px;
    width: 100%; background: transparent; border: 0; padding: 3px 4px; border-radius: 4px; cursor: pointer;
  }
  .suggest-item.hl, .suggest-item:hover { background: var(--accent-bg); }
  .parents { color: var(--text-subtle); font-size: 10px; }
  .palette { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
  .swatch { width: 22px; height: 22px; border-radius: 4px; border: 1px solid transparent; cursor: pointer; font-size: 10px; padding: 0; }
  .swatch.current { border-color: var(--text); }
  .buttons { display: flex; gap: 6px; margin-top: 10px; }
  .btn {
    display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px;
    border-radius: var(--radius-sm, 4px); border: 1px solid var(--border-strong);
    background: var(--bg-input); color: var(--text); font: inherit; cursor: pointer;
  }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--bg-sunken); }
  .btn.quiet { background: transparent; color: var(--text-muted); }
  .kbd { font-size: 10px; opacity: 0.7; }
</style>
