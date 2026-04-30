<script lang="ts">
  import { toast } from '$lib/stores/toast.svelte';
</script>

<div class="container">
  {#each toast.messages as msg (msg.id)}
    <div class="toast" class:error={msg.kind === 'error'}>
      <span>{msg.text}</span>
      {#if msg.action}
        <button
          type="button"
          onclick={() => {
            msg.action?.onClick();
            toast.dismiss(msg.id);
          }}
        >
          {msg.action.label}
        </button>
      {/if}
    </div>
  {/each}
</div>

<style>
  .container {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 200;
  }
  .toast {
    background: var(--bg-raised);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    padding: 8px 14px;
    color: var(--text);
    font-size: 13px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .toast.error {
    border-color: rgba(219, 90, 90, 0.5);
  }
  button {
    background: transparent;
    border: none;
    color: var(--accent);
    font-size: 13px;
    padding: 0;
  }
</style>
