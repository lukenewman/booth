<script lang="ts">
  /**
   * Bandcamp connection + progress, shown above the local source's sync
   * history. Purchases are matched on each local sync; their album pages are
   * fetched behind it, which takes a while on the first run — hence the poll.
   */
  import { onMount } from 'svelte';

  interface Status {
    username: string | null;
    purchases: number;
    matched: number;
    ambiguous: number;
    unmatched: number;
    pagesPending: number;
  }

  let status = $state<Status | null>(null);
  let username = $state('');
  let busy = $state(false);
  let problem = $state<string | null>(null);

  const ERRORS: Record<string, string> = {
    malformed: 'That doesn’t look like a Bandcamp username.',
    not_found: 'No public Bandcamp profile with that name.',
    unreachable: 'Couldn’t reach Bandcamp. Try again in a moment.',
  };

  async function load() {
    status = await fetch('/api/bandcamp').then((r) => r.json()).catch(() => status);
  }

  async function connect() {
    busy = true;
    problem = null;
    try {
      const res = await fetch('/api/bandcamp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: username.trim() }),
      });
      const body = await res.json();
      if (!res.ok) problem = ERRORS[body.error] ?? 'Something went wrong.';
      else status = body;
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void load();
    const timer = setInterval(() => {
      if (status?.pagesPending) void load();
    }, 10_000);
    return () => clearInterval(timer);
  });

  const n = (x: number) => x.toLocaleString();
</script>

<section class="bandcamp">
  {#if status?.username}
    <div class="line"><span class="label">bandcamp</span> <span class="name">{status.username}</span></div>
    <div class="line muted">
      {n(status.purchases)} purchases · {n(status.matched)} matched{#if status.ambiguous} · {n(status.ambiguous)} ambiguous{/if} · {n(status.unmatched)} unmatched{#if status.pagesPending} · <span class="pending">{n(status.pagesPending)} pages to fetch</span>{/if}
    </div>
  {:else if status}
    <p>Connect your Bandcamp account to pull genres and styles for your purchases.</p>
    <form onsubmit={(e) => { e.preventDefault(); if (username.trim()) void connect(); }}>
      <label class="visually-hidden" for="bandcamp-username">Bandcamp username</label>
      <input id="bandcamp-username" bind:value={username} placeholder="bandcamp username" spellcheck="false" autocomplete="off" disabled={busy} />
      <button class="button secondary" type="submit" disabled={!username.trim() || busy}>{busy ? 'Connecting…' : 'Connect'}</button>
    </form>
    {#if problem}<p class="problem">{problem}</p>{/if}
  {/if}
</section>

<style>
  .bandcamp {
    margin-bottom: 14px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  .line { line-height: 1.6; }
  .label { color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; font-size: 11px; }
  .name { color: var(--text); font-weight: 600; }
  .muted { color: var(--text-subtle); }
  .pending { color: var(--text-muted); }
  p { margin: 0 0 8px; line-height: 1.5; color: var(--text-muted); }
  .problem { color: var(--danger); margin-top: 8px; }
  form { display: flex; gap: 8px; flex-wrap: wrap; }
  input {
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 10px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    font-size: 12px;
  }
  .button {
    display: inline-flex;
    align-items: center;
    height: 28px;
    padding: 0 12px;
    border-radius: var(--radius);
    font-weight: 500;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .button.secondary { background: var(--bg-input); border-color: var(--border-strong); color: var(--text); }
  .button.secondary:hover:not(:disabled) { border-color: var(--text-subtle); }
  .button:disabled { opacity: 0.5; cursor: default; }
  .button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .visually-hidden {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }
</style>
