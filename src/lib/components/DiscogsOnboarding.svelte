<script lang="ts">
  /**
   * First-run screen for connecting Discogs: how to make a personal access
   * token, then a field to paste it. The server checks the token with Discogs
   * and saves it to the settings file, so booth carries on without a restart.
   * Once connected, an optional last step brings in the Apple Music library.
   */
  import MusicLibraryConnect from './MusicLibraryConnect.svelte';
  import { musicLibrary } from '$lib/stores/musicLibrary.svelte';

  let {
    reason,
    onDone,
  }: {
    reason: 'no_token' | 'invalid_token';
    onDone: () => void;
  } = $props();

  const DEVELOPERS_URL = 'https://www.discogs.com/settings/developers';

  type Phase =
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'error'; message: string }
    | { kind: 'connected'; username: string; savedTo: string };

  let token = $state('');
  let phase = $state<Phase>({ kind: 'idle' });
  let openedDiscogs = $state(false);
  let input: HTMLInputElement | undefined = $state();

  const connected = $derived(phase.kind === 'connected');
  // Offered only to someone whose Music library isn't connected already (a
  // replaced Discogs token brings people back here too). Decided when Discogs
  // connects, not derived: connecting Music flips the store mid-import, and
  // the step must stay to show how the import went.
  let offerMusic = $state(false);
  let musicDone = $state(false);

  $effect(() => {
    void musicLibrary.load();
  });

  const ERRORS: Record<string, string> = {
    malformed: 'That doesn’t look like a Discogs token. It’s a long run of letters and numbers, with no spaces.',
    rejected: 'Discogs didn’t accept that token. Generate a new one and paste it here.',
    unreachable: 'Couldn’t reach Discogs. Check your internet connection and try again.',
  };

  async function connect() {
    const value = token.trim();
    if (!value || phase.kind === 'checking' || connected) return;
    phase = { kind: 'checking' };
    try {
      const res = await fetch('/api/setup/discogs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        phase = { kind: 'error', message: ERRORS[data?.error] ?? ERRORS.unreachable };
        input?.focus();
        input?.select();
        return;
      }
      offerMusic = musicLibrary.connected === false;
      phase = { kind: 'connected', username: data.username, savedTo: data.savedTo };
      // Pull the collection in while the person reads the confirmation.
      void fetch('/api/sources/discogs/sync', { method: 'POST' }).catch(() => {});
    } catch {
      phase = { kind: 'error', message: ERRORS.unreachable };
    }
  }

  function onPaste() {
    // Pasting is the whole of step three; don't make them click as well.
    queueMicrotask(() => void connect());
  }

  function onInput() {
    if (phase.kind === 'error') phase = { kind: 'idle' };
  }
</script>

<main class="onboarding" class:connected>
  <div class="turntable" aria-hidden="true">
    <svg viewBox="0 0 320 320" class="deck">
      <rect x="4" y="4" width="312" height="312" rx="22" class="plinth" />
      <g class="platter">
        <circle cx="150" cy="160" r="128" class="vinyl" />
        {#each Array.from({ length: 16 }, (_, i) => 122 - i * 4.5) as r (r)}
          <circle cx="150" cy="160" {r} class="groove" />
        {/each}
        <circle cx="150" cy="160" r="40" class="label" />
        <text x="150" y="151" class="label-text">booth</text>
        <text x="150" y="179" class="label-sub">
          {connected && phase.kind === 'connected' ? phase.username : 'side a'}
        </text>
        <circle cx="150" cy="160" r="2.5" class="spindle" />
      </g>
      <path d="M 150 40 A 120 120 0 0 1 262 118" class="sheen" />
      <g class="arm">
        <circle cx="282" cy="52" r="15" class="pivot" />
        <path d="M 282 52 L 282 200 L 258 236" class="arm-tube" />
        <rect x="246" y="230" width="22" height="14" rx="3" transform="rotate(34 257 237)" class="headshell" />
      </g>
    </svg>
  </div>

  <section class="steps">
    <h1>Connect your Discogs collection</h1>
    <p class="lede">
      booth adds records to your Discogs collection and keeps your library in step with it.
      It needs a personal access token from your Discogs account — three steps, about a minute.
    </p>

    {#if reason === 'invalid_token' && phase.kind !== 'connected'}
      <p class="notice" role="status">
        The token booth had saved no longer works. Discogs may have revoked it, or it was generated again.
        Make a new one below.
      </p>
    {/if}

    <ol>
      <li class:done={openedDiscogs || connected}>
        <span class="marker">{openedDiscogs || connected ? '✓' : '1'}</span>
        <div class="body">
          <h2>Open your Discogs developer settings</h2>
          <p>Sign in to Discogs if it asks.</p>
          <a
            class="button secondary"
            href={DEVELOPERS_URL}
            target="_blank"
            rel="noreferrer"
            onclick={() => (openedDiscogs = true)}
          >Open Discogs settings ↗</a>
        </div>
      </li>

      <li class:done={connected}>
        <span class="marker">{connected ? '✓' : '2'}</span>
        <div class="body">
          <h2>Generate a token and copy it</h2>
          <p>Under <em>Personal access token</em>, click <em>Generate new token</em>, then copy the token it shows.</p>
          <figure class="mock" aria-label="Where to find the token on the Discogs page">
            <div class="mock-bar"><span></span><span></span><span></span></div>
            <div class="mock-page">
              <div class="mock-heading">Developers</div>
              <div class="mock-rule"></div>
              <div class="mock-label">Personal access token</div>
              <div class="mock-line short"></div>
              <div class="mock-row">
                <span class="mock-button">Generate new token</span>
                <span class="mock-cursor"></span>
              </div>
              <div class="mock-token">
                <span>Your token:</span>
                <code>kQzRb…7hTx</code>
                <span class="mock-copy">copy</span>
              </div>
            </div>
          </figure>
        </div>
      </li>

      <li class:done={connected} class:current={!connected}>
        <span class="marker">{connected ? '✓' : '3'}</span>
        <div class="body">
          <h2>Paste it here</h2>
          {#if phase.kind === 'connected'}
            <div class="success" role="status">
              <p>Connected as <strong>{phase.username}</strong>. Your collection is syncing now.</p>
              <p class="saved">Saved to {phase.savedTo}</p>
              {#if !offerMusic}
                <button class="button primary" onclick={onDone}>Open your library</button>
              {/if}
            </div>
          {:else}
            <form onsubmit={(e) => { e.preventDefault(); void connect(); }}>
              <label class="visually-hidden" for="discogs-token">Discogs personal access token</label>
              <input
                id="discogs-token"
                bind:this={input}
                bind:value={token}
                onpaste={onPaste}
                oninput={onInput}
                type="password"
                autocomplete="off"
                spellcheck="false"
                placeholder="Paste your token"
                aria-invalid={phase.kind === 'error'}
                aria-describedby={phase.kind === 'error' ? 'token-error' : undefined}
                disabled={phase.kind === 'checking'}
              />
              <button class="button primary" type="submit" disabled={!token.trim() || phase.kind === 'checking'}>
                {phase.kind === 'checking' ? 'Checking…' : 'Connect'}
              </button>
            </form>
            {#if phase.kind === 'error'}
              <p class="error" id="token-error" role="alert">{phase.message}</p>
            {:else}
              <p class="hint">booth checks it with Discogs, then saves it on this computer.</p>
            {/if}
          {/if}
        </div>
      </li>

      {#if offerMusic}
        <li class:done={musicDone} class:current={!musicDone}>
          <span class="marker">{musicDone ? '✓' : '4'}</span>
          <div class="body">
            <h2>Bring in your Apple Music library <span class="optional">optional</span></h2>
            <MusicLibraryConnect onConnected={() => (musicDone = true)} />
          </div>
        </li>
      {/if}
    </ol>

    {#if offerMusic}
      <div class="finish">
        <!-- Skipping here counts as having seen the offer: no library nudge later. -->
        <button
          class="button {musicDone ? 'primary' : 'secondary'}"
          onclick={() => { if (!musicDone) void musicLibrary.dismissNudge(); onDone(); }}
        >
          {musicDone ? 'Open your library' : 'Skip for now'}
        </button>
      </div>
    {/if}
  </section>
</main>

<style>
  .onboarding {
    min-height: calc(100vh - var(--titlebar-h));
    display: grid;
    grid-template-columns: minmax(220px, 340px) minmax(0, 520px);
    gap: 56px;
    align-items: center;
    justify-content: center;
    padding: 48px 32px;
  }

  /* --- Turntable ---------------------------------------------------------- */

  .deck { width: 100%; height: auto; display: block; }
  .plinth { fill: var(--bg-raised); stroke: var(--border); }
  .vinyl { fill: var(--bg-sunken); }
  .groove { fill: none; stroke: #2b2b28; stroke-width: 1.2; }
  .sheen { fill: none; stroke: rgba(230, 227, 220, 0.07); stroke-width: 14; stroke-linecap: round; }
  .label { fill: var(--accent); }
  .label-text {
    fill: var(--bg-sunken);
    font: 600 13px var(--font);
    text-anchor: middle;
  }
  .label-sub {
    fill: var(--accent-bg);
    font: 500 9px var(--font);
    text-anchor: middle;
  }
  .spindle { fill: var(--bg-sunken); }
  .pivot { fill: var(--bg-input); stroke: var(--border-strong); }
  .arm-tube { fill: none; stroke: var(--text-subtle); stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; }
  .headshell { fill: var(--text-muted); }

  /* The arm rests off the record until the token is accepted, then drops on
     and the record spins: the one moment of motion on this screen. */
  .arm {
    transform-origin: 282px 52px;
    transform: rotate(-5deg);
    transition: transform 900ms cubic-bezier(0.3, 0.7, 0.2, 1);
  }
  .platter { transform-origin: 150px 160px; }
  .connected .arm { transform: rotate(16deg); }
  .connected .platter { animation: spin 1.8s linear 600ms infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (prefers-reduced-motion: reduce) {
    .arm { transition: none; }
    .connected .platter { animation: none; }
  }

  /* --- Steps -------------------------------------------------------------- */

  h1 { font-size: 24px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 10px; }
  .lede { color: var(--text-muted); line-height: 1.55; margin: 0 0 28px; max-width: 60ch; }

  .notice {
    background: var(--warn-bg);
    border: 1px solid var(--warn-border);
    border-radius: var(--radius);
    padding: 10px 12px;
    margin: -12px 0 24px;
    line-height: 1.5;
  }

  ol { list-style: none; margin: 0; padding: 0; }
  li {
    display: grid;
    grid-template-columns: 28px 1fr;
    gap: 14px;
    position: relative;
    padding-bottom: 26px;
  }
  /* The thread joining the markers shows the steps are one path. */
  li:not(:last-child)::before {
    content: '';
    position: absolute;
    left: 13.5px;
    top: 30px;
    bottom: 4px;
    width: 1px;
    background: var(--border);
  }
  .marker {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 13px;
    font-weight: 600;
    background: var(--bg-raised);
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
  }
  li.current .marker { background: var(--accent-bg); border-color: var(--accent-border); color: var(--accent-strong); }
  li.done .marker { background: var(--accent); border-color: var(--accent); color: var(--bg-sunken); }

  h2 { font-size: 15px; font-weight: 600; margin: 4px 0 4px; }
  .optional { font-size: 12px; font-weight: 400; color: var(--text-subtle); margin-left: 6px; }
  .finish { padding-left: 42px; }
  .body p { margin: 0 0 10px; line-height: 1.5; color: var(--text-muted); }
  .body em { font-style: normal; color: var(--text); }

  .button {
    display: inline-flex;
    align-items: center;
    height: 34px;
    padding: 0 14px;
    border-radius: var(--radius);
    font-weight: 500;
    text-decoration: none;
    border: 1px solid transparent;
    white-space: nowrap;
  }
  .button.secondary { background: var(--bg-input); border-color: var(--border-strong); color: var(--text); }
  .button.secondary:hover { border-color: var(--text-subtle); }
  .button.primary { background: var(--accent); color: var(--bg-sunken); }
  .button.primary:hover:not(:disabled) { background: var(--accent-strong); }
  .button:disabled { opacity: 0.5; cursor: default; }
  .button:focus-visible, input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* --- Miniature of the Discogs page ------------------------------------- */

  .mock {
    margin: 4px 0 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    max-width: 360px;
    background: var(--bg-sunken);
  }
  .mock-bar { display: flex; gap: 5px; padding: 7px 9px; background: var(--bg-raised); border-bottom: 1px solid var(--border); }
  .mock-bar span { width: 7px; height: 7px; border-radius: 50%; background: var(--border-strong); }
  .mock-page { padding: 14px 16px 16px; font-size: 12px; }
  .mock-heading { font-weight: 600; font-size: 14px; color: var(--text); }
  .mock-rule { height: 1px; background: var(--border); margin: 8px 0 10px; }
  .mock-label { color: var(--text); font-weight: 500; margin-bottom: 6px; }
  .mock-line { height: 6px; border-radius: 3px; background: var(--bg-input); width: 85%; margin-bottom: 10px; }
  .mock-line.short { width: 62%; }
  .mock-row { position: relative; display: inline-block; margin-bottom: 10px; }
  .mock-button {
    display: inline-block;
    padding: 5px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    color: var(--text);
    box-shadow: 0 0 0 3px var(--accent-bg), 0 0 0 4px var(--accent-border);
  }
  .mock-cursor {
    position: absolute;
    right: -6px;
    bottom: -9px;
    width: 0;
    height: 0;
    border-left: 6px solid transparent;
    border-right: 6px solid transparent;
    border-bottom: 13px solid var(--text);
    transform: rotate(-35deg);
  }
  .mock-token {
    display: flex;
    gap: 8px;
    align-items: center;
    color: var(--text-muted);
  }
  .mock-token code {
    font-family: var(--font-mono);
    color: var(--text);
    background: var(--bg-input);
    padding: 2px 6px;
    border-radius: var(--radius-sm);
  }
  .mock-copy { color: var(--accent-strong); }

  /* --- Paste field -------------------------------------------------------- */

  form { display: flex; gap: 8px; margin-bottom: 8px; }
  input {
    flex: 1;
    min-width: 0;
    height: 34px;
    padding: 0 10px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    font-family: var(--font-mono);
    font-size: 13px;
  }
  input[aria-invalid='true'] { border-color: var(--danger); }
  .body .hint { font-size: 12px; color: var(--text-subtle); }
  .body .error { color: var(--danger); }
  .success p { color: var(--text); }
  .success strong { color: var(--accent-strong); font-weight: 600; }
  .body .saved { font-size: 12px; color: var(--text-subtle); }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  @media (max-width: 768px) {
    .onboarding {
      grid-template-columns: minmax(0, 1fr);
      gap: 24px;
      padding: 24px 16px 40px;
      align-items: start;
    }
    .turntable { width: 160px; justify-self: center; }
    h1 { font-size: 21px; }
  }
</style>
