<script lang="ts">
  import { annotations } from '$lib/stores/annotations.svelte';

  /**
   * A track's note: dimmed prose when idle, a textarea when editing.
   *
   * Lives *outside* the track row's <button> — a textarea nested in a button
   * never receives its own keystrokes, because the button swallows them.
   */
  let {
    trackId,
    editing = false,
    readonly = false,
    onRequestEdit,
    onDone,
  }: {
    trackId: string;
    /**
     * Owned by the parent, which tracks a single editing row rather than a
     * per-row flag: only one editor should be open at a time, and a plain prop
     * avoids `bind:` to an undefined record member (props_invalid_value).
     */
    editing?: boolean;
    /** Track lists render notes but don't edit them. */
    readonly?: boolean;
    onRequestEdit?: () => void;
    onDone?: () => void;
  } = $props();

  const note = $derived(annotations.noteFor(trackId));

  let draft = $state('');
  let el = $state<HTMLTextAreaElement | null>(null);

  // Seed the draft when the editor opens, not on every keystroke.
  let wasEditing = false;
  $effect(() => {
    if (editing && !wasEditing) draft = note ?? '';
    wasEditing = editing;
  });

  $effect(() => {
    if (editing && el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      autogrow(el);
    }
  });

  function autogrow(node: HTMLTextAreaElement) {
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }

  function commit() {
    if (!editing) return;
    onDone?.();
    if ((draft.trim() || '') === (note ?? '')) return; // nothing changed
    annotations.setNote(trackId, draft);
  }

  function cancel() {
    onDone?.();
    draft = note ?? '';
  }

  function onKeydown(e: KeyboardEvent) {
    // Stop every key here: the global handler binds bare letters (s stars,
    // v vets), and typing a note must not trigger them.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commit();
    }
  }
</script>

{#if editing}
  <textarea
    bind:this={el}
    class="note-input"
    rows="1"
    placeholder="Note…  (Enter to save, Shift+Enter for a new line, Esc to cancel)"
    bind:value={draft}
    oninput={(e) => autogrow(e.currentTarget)}
    onkeydown={onKeydown}
    onblur={commit}
  ></textarea>
{:else if note}
  {#if readonly}
    <div class="note">{note}</div>
  {:else}
    <button class="note editable" onclick={() => onRequestEdit?.()} title="Edit note">
      {note}
    </button>
  {/if}
{/if}

<style>
  .note {
    color: var(--text-muted);
    font-size: 11px;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    text-align: left;
  }
  .note.editable {
    display: block;
    width: 100%;
    background: none;
    border: 0;
    padding: 0;
    font-family: inherit;
    cursor: text;
  }
  .note.editable:hover { color: var(--text); }

  .note-input {
    display: block;
    width: 100%;
    resize: none;
    overflow: hidden;
    background: var(--bg-input);
    border: 1px solid var(--accent-border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: inherit;
    font-size: 11px;
    line-height: 1.45;
    padding: 5px 7px;
  }
  .note-input:focus { outline: none; border-color: var(--accent); }
  .note-input::placeholder { color: var(--text-subtle); }
</style>
