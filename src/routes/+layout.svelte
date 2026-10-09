<script lang="ts">
  import '../app.css';
  import Toast from '$lib/components/Toast.svelte';
  import DesktopTitlebar from '$lib/components/DesktopTitlebar.svelte';
  let { children } = $props();

  // The server marks the page when it's running inside the desktop app.
  const desktop = typeof document !== 'undefined' && document.documentElement.hasAttribute('data-desktop');
</script>

{#if desktop}<DesktopTitlebar />{/if}
{@render children()}
<Toast />
