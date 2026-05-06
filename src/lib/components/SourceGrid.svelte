<script lang="ts">
  /**
   * Fixed 4-slot grid: D / i / R / P (Discogs, iTunes, Rekordbox, Plex).
   * `present` is the set of source ids the entity has a source_link for.
   */
  let { present }: { present: string[] } = $props();

  const SLOTS: { id: string; cls: string }[] = [
    { id: 'discogs', cls: 'discogs' },
    { id: 'itunes', cls: 'itunes' },
    { id: 'rekordbox', cls: 'rekordbox' },
    { id: 'plex', cls: 'plex' },
  ];

  const presentSet = $derived(new Set(present));
</script>

<span class="grid">
  {#each SLOTS as slot}
    <span class="slot {slot.cls}" class:on={presentSet.has(slot.id)} title={slot.id}></span>
  {/each}
</span>

<style>
  .grid {
    display: inline-grid;
    grid-template-columns: repeat(4, 8px);
    gap: 4px;
    align-items: center;
  }
  .slot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 1px solid var(--src-empty);
    background: transparent;
  }
  .slot.on.discogs   { background: var(--src-discogs);   border-color: var(--src-discogs); }
  .slot.on.itunes    { background: var(--src-itunes);    border-color: var(--src-itunes); }
  .slot.on.rekordbox { background: var(--src-rekordbox); border-color: var(--src-rekordbox); }
  .slot.on.plex      { background: var(--src-plex);      border-color: var(--src-plex); }
</style>
