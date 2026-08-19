<script lang="ts">
  import { onMount } from 'svelte';
  import { player } from '$lib/stores/player.svelte';

  let audio: HTMLAudioElement;
  // Plain (non-reactive) var so writes don't re-trigger the $effect.
  let loadedTrackId: string | null = null;

  onMount(() => {
    player._bindAudio(audio);
    return () => player._bindAudio(null);
  });

  $effect(() => {
    const np = player.nowPlaying;
    const shouldPlay = player.isPlaying;

    if (!np) {
      audio.pause();
      audio.removeAttribute('src');
      loadedTrackId = null;
      return;
    }

    if (np.trackId !== loadedTrackId) {
      loadedTrackId = np.trackId;
      audio.src = `/api/stream/${np.trackId}`;
      audio.currentTime = 0;
      if (shouldPlay) {
        audio.play().catch((e: unknown) => player._setError(String(e)));
      }
    } else {
      if (shouldPlay && audio.paused) {
        audio.play().catch(() => {});
      } else if (!shouldPlay && !audio.paused) {
        audio.pause();
      }
    }
  });

  /**
   * Mirror now-playing into the OS media session, so the lock screen, AirPods,
   * and Now Playing widget show the track and drive transport. Without this a
   * phone shows "booth" and a dead pause button.
   */
  $effect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const np = player.nowPlaying;
    if (!np) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: np.title,
      artist: np.artist,
      artwork: np.thumbUrl ? [{ src: np.thumbUrl, sizes: '512x512' }] : [],
    });
    navigator.mediaSession.playbackState = player.isPlaying ? 'playing' : 'paused';
  });

  /**
   * Registered once, not per-track: these delegate to the store, which already
   * knows the queue. Re-registering on every track change would churn handlers
   * the OS is holding.
   */
  $effect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const actions = ['play', 'pause', 'nexttrack', 'previoustrack'] as const;
    ms.setActionHandler('play', () => player.resume());
    ms.setActionHandler('pause', () => player.pause());
    ms.setActionHandler('nexttrack', () => void player.next());
    ms.setActionHandler('previoustrack', () => void player.prev());
    return () => {
      for (const a of actions) ms.setActionHandler(a, null);
    };
  });
</script>

<!-- svelte-ignore a11y_media_has_caption -->
<audio
  bind:this={audio}
  ontimeupdate={() => player._setCurrentTime(audio.currentTime)}
  ondurationchange={() => player._setDuration(isNaN(audio.duration) ? 0 : audio.duration)}
  onplay={() => player._setIsPlaying(true)}
  onpause={() => { if (!audio.seeking) player._setIsPlaying(false); }}
  onseeked={() => player._onSeeked()}
  onerror={() => player._setError('Could not load audio')}
  onended={() => player.next()}
></audio>
