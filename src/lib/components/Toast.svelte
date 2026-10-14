<script lang="ts">
  import { toast } from '$lib/stores/toast.svelte';
</script>

<div class="container">
  {#each toast.messages as msg (msg.id)}
    <div class="toast {msg.kind}">
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
  /* Tinted by kind, with a solid edge, so a toast reads at a glance against
     the dark UI instead of blending into the player bar. */
  .toast {
    background: var(--accent-bg);
    border: 1px solid var(--accent-border);
    border-left: 4px solid var(--accent);
    border-radius: var(--radius);
    padding: 8px 14px;
    color: var(--text);
    font-size: 13px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    gap: 12px;
    animation: toast-in 160ms ease-out;
  }
  .toast.success { background: var(--ok-bg); border-color: var(--ok-border); border-left-color: var(--ok); }
  .toast.error { background: var(--danger-bg); border-color: var(--danger-border); border-left-color: var(--danger); }
  @keyframes toast-in {
    from { opacity: 0; transform: translateY(8px); }
  }
  button {
    background: transparent;
    border: none;
    color: var(--accent);
    font-size: 13px;
    padding: 0;
  }
</style>
