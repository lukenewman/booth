import { nextIndex, prevTarget, type PlaybackContext } from '$lib/queue';
import { clampPitch, nextPitchRange, pitchToRate, type PitchRange } from '$lib/pitch';
import type { ResolvedBpm } from '$lib/bpm';

export interface NowPlaying {
  trackId: string;
  title: string;
  artist: string;
  thumbUrl?: string | null;
  /** Parent release, so the PlayerBar artwork can open its detail pane. Null for a track with no release. */
  releaseId?: string | null;
  /** Resting tempo, before pitch. Absent for the ~85% of tracks with no source for one. */
  bpm?: ResolvedBpm | null;
}

let nowPlaying = $state<NowPlaying | null>(null);
let isPlaying = $state(false);
let currentTime = $state(0);
let duration = $state(0);
let error = $state<string | null>(null);

/**
 * Turntable pitch, as a percentage. 0 is the centre detent.
 *
 * Kept across track changes on purpose: a fader on a deck does not spring back
 * when the next record goes on, and someone matching tempo across a set wants
 * the adjustment to persist. `resetPitch` is the way back to centre.
 */
let pitchPercent = $state(0);
/** Fader travel each way. ±8 is the Technics 1200 default; ±16 is the wide setting. */
let pitchRange = $state<PitchRange>(8);

let queue = $state<string[]>([]);
let queueIndex = $state(-1);
let context = $state<PlaybackContext | null>(null);
/**
 * Title/artist/artwork for ids we've seen. Seeded by the call site (it is
 * rendering those rows, so it already has them); filled on demand when the
 * queue advances past what was loaded. Audio never waits on this — it only
 * needs the id — so a miss costs a beat of stale text, not silence.
 */
let metaCache = new Map<string, NowPlaying>();

// Set by Player.svelte on mount so seekTo() can update the audio element directly.
let audioEl: HTMLAudioElement | null = null;
// Prevents ontimeupdate from snapping currentTime back during an in-progress seek.
let _seeking = false;

/** Metadata for a queued id, from cache or a single-track fetch. Null if it's gone. */
async function resolveMeta(trackId: string): Promise<NowPlaying | null> {
  const hit = metaCache.get(trackId);
  if (hit) return hit;
  try {
    const res = await fetch(`/api/library/tracks/${encodeURIComponent(trackId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const t = data.track;
    const meta: NowPlaying = {
      trackId: t.id,
      title: t.title,
      artist: t.artist,
      thumbUrl: t.thumb_url ?? null,
      releaseId: t.release_id ?? null,
      bpm: data.bpm ?? null,
    };
    metaCache.set(trackId, meta);
    return meta;
  } catch {
    return null;
  }
}

export const player = {
  get nowPlaying() { return nowPlaying; },
  get isPlaying() { return isPlaying; },
  get currentTime() { return currentTime; },
  get duration() { return duration; },
  get error() { return error; },
  get queue() { return queue; },
  get queueIndex() { return queueIndex; },
  get context() { return context; },
  get pitchPercent() { return pitchPercent; },
  get pitchRange() { return pitchRange; },
  /** What the audio element's playbackRate should be for the current pitch. */
  get playbackRate() { return pitchToRate(pitchPercent); },
  get hasNext() { return nextIndex(queueIndex, queue.length) !== null; },
  get hasPrev() { return queueIndex > 0; },

  play(track: NowPlaying) {
    nowPlaying = track;
    isPlaying = true;
    currentTime = 0;
    error = null;
  },

  /**
   * Start a track and capture the queue it belongs to. Playback starts
   * immediately; queue resolution happens after, so pressing play never waits
   * on a fetch. Release/playlist contexts carry their ids already.
   */
  async playFrom(ctx: PlaybackContext, trackId: string, meta: NowPlaying, seed?: NowPlaying[]) {
    this.play(meta);
    context = ctx;
    metaCache = new Map();
    for (const m of seed ?? []) metaCache.set(m.trackId, m);
    metaCache.set(meta.trackId, meta);

    let ids: string[];
    if (ctx.kind === 'library') {
      const params = new URLSearchParams();
      if (ctx.query.source) params.set('source', ctx.query.source);
      if (ctx.query.q) params.set('q', ctx.query.q);
      if (ctx.query.multiSource) params.set('multi_source', 'true');
      params.set('sort', ctx.query.sort);
      try {
        const res = await fetch(`/api/library/tracks/ids?${params.toString()}`);
        ids = res.ok ? ((await res.json()).ids ?? []) : [];
      } catch {
        ids = [];
      }
    } else {
      ids = ctx.ids;
    }

    // A newer play() may have landed while we were fetching; don't clobber it.
    if (nowPlaying?.trackId !== trackId) return;
    queue = ids;
    queueIndex = ids.indexOf(trackId);
  },

  /**
   * Move to `target`, skipping ids whose metadata no longer resolves (a track
   * deleted since the queue was captured). Bounded by the queue length so a run
   * of stale ids terminates instead of spinning.
   */
  async _goTo(target: number, step: number) {
    let i = target;
    for (let guard = 0; guard < queue.length; guard++) {
      if (i < 0 || i >= queue.length) break;
      const meta = await resolveMeta(queue[i]);
      if (meta) {
        queueIndex = i;
        this.play(meta);
        return;
      }
      i += step;
    }
    // Nothing left in that direction: stop, but keep the track loaded.
    isPlaying = false;
  },

  async next() {
    const target = nextIndex(queueIndex, queue.length);
    if (target === null) {
      isPlaying = false;
      return;
    }
    await this._goTo(target, 1);
  },

  async prev() {
    const action = prevTarget(currentTime, queueIndex, queue.length);
    if (action.kind === 'none') return;
    if (action.kind === 'restart') {
      this.seekTo(0);
      return;
    }
    await this._goTo(action.index, -1);
  },

  pause() { isPlaying = false; },
  resume() { isPlaying = true; },

  setPitch(percent: number) {
    pitchPercent = clampPitch(percent, pitchRange);
  },

  resetPitch() {
    pitchPercent = 0;
  },

  /**
   * Widen or narrow the fader. Narrowing re-clamps a pitch that no longer fits,
   * rather than leaving the audio at a rate the fader can no longer express.
   */
  setPitchRange(range: PitchRange) {
    pitchRange = range;
    this.setPitch(pitchPercent);
  },

  cyclePitchRange() {
    this.setPitchRange(nextPitchRange(pitchRange));
  },

  seekTo(t: number) {
    _seeking = true;
    currentTime = t;
    if (audioEl) audioEl.currentTime = t;
  },

  stop() {
    nowPlaying = null;
    isPlaying = false;
    currentTime = 0;
    duration = 0;
    error = null;
    queue = [];
    queueIndex = -1;
    context = null;
    metaCache = new Map();
  },

  // Called by Player.svelte only.
  _bindAudio(el: HTMLAudioElement | null) { audioEl = el; },
  _setCurrentTime(t: number) { if (!_seeking) currentTime = t; },
  _onSeeked() { _seeking = false; },
  _setDuration(d: number) { duration = d; },
  _setIsPlaying(v: boolean) { isPlaying = v; },
  _setError(e: string | null) { error = e; },
};
