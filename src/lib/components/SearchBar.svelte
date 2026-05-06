<script lang="ts">
  /**
   * Debounced search input. Caller controls the value via two-way binding;
   * `onChange` fires after `delayMs` of input idleness.
   */
  let {
    value = $bindable(''),
    placeholder = 'Search…',
    delayMs = 250,
    onChange,
  }: {
    value?: string;
    placeholder?: string;
    delayMs?: number;
    onChange?: (v: string) => void;
  } = $props();

  let input: HTMLInputElement | undefined = $state();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function onInput(e: Event) {
    const v = (e.target as HTMLInputElement).value;
    value = v;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => onChange?.(v), delayMs);
  }

  export function focus() {
    input?.focus();
  }

  export function blur() {
    input?.blur();
  }

  export function clear() {
    value = '';
    onChange?.('');
  }
</script>

<input
  bind:this={input}
  class="search"
  type="text"
  {placeholder}
  {value}
  oninput={onInput}
/>

<style>
  .search {
    width: 100%;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-radius: 4px;
    padding: 5px 9px;
    color: var(--text);
    font-family: inherit;
    font-size: 13px;
    outline: none;
  }
  .search:focus { border-color: var(--accent-border); }
  .search::placeholder { color: var(--text-subtle); }
</style>
