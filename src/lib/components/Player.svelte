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
  onended={() => player.stop()}
></audio>
