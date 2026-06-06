export interface NowPlaying {
  trackId: string;
  title: string;
  artist: string;
}

let nowPlaying = $state<NowPlaying | null>(null);
let isPlaying = $state(false);
let currentTime = $state(0);
let duration = $state(0);
let error = $state<string | null>(null);

// Set by Player.svelte on mount so seekTo() can update the audio element directly.
let audioEl: HTMLAudioElement | null = null;

export const player = {
  get nowPlaying() { return nowPlaying; },
  get isPlaying() { return isPlaying; },
  get currentTime() { return currentTime; },
  get duration() { return duration; },
  get error() { return error; },

  play(track: NowPlaying) {
    nowPlaying = track;
    isPlaying = true;
    currentTime = 0;
    error = null;
  },

  pause() { isPlaying = false; },
  resume() { isPlaying = true; },

  seekTo(t: number) {
    currentTime = t;
    if (audioEl) audioEl.currentTime = t;
  },

  stop() {
    nowPlaying = null;
    isPlaying = false;
    currentTime = 0;
    duration = 0;
    error = null;
  },

  // Called by Player.svelte only.
  _bindAudio(el: HTMLAudioElement | null) { audioEl = el; },
  _setCurrentTime(t: number) { currentTime = t; },
  _setDuration(d: number) { duration = d; },
  _setIsPlaying(v: boolean) { isPlaying = v; },
  _setError(e: string | null) { error = e; },
};
