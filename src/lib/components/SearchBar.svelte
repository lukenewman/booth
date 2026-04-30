<script lang="ts">
  let {
    value = $bindable(''),
    onScan,
  }: {
    value?: string;
    onScan: () => void;
  } = $props();

  let inputEl: HTMLInputElement | undefined = $state();

  export function focus() {
    inputEl?.focus();
    inputEl?.select();
  }
</script>

<div class="bar">
  <span class="icon">⌕</span>
  <input
    bind:this={inputEl}
    bind:value
    type="text"
    placeholder="artist, album, catalog #..."
    autocomplete="off"
    spellcheck="false"
  />
  <button type="button" class="scan" onclick={onScan}>
    <span>⊞ Scan</span>
    <span class="kbd">s</span>
  </button>
</div>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    padding: 10px 12px;
    margin-bottom: 14px;
  }
  .bar:focus-within {
    border-color: var(--accent);
  }
  .icon {
    color: var(--accent);
    font-size: 16px;
  }
  input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-size: 14px;
  }
  .scan {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--text-muted);
    background: var(--bg-raised);
  }
  .scan:hover {
    color: var(--text);
  }
</style>
