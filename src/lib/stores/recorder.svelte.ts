/**
 * Recording session store (Svelte 5 runes). Owns the capture pipeline
 * (getUserMedia → AudioWorklet → chunked upload), the live meters, and the
 * per-take split proposals returned by the server.
 */

import { toDbfs, classifyPeak, type LevelStatus } from '$lib/loudness';

export type RecorderPhase =
  | 'idle'
  | 'arming'
  | 'preview'
  | 'recording'
  | 'analyzing'
  | 'reviewing'
  | 'committing'
  | 'done';

export interface ExpectedTrackClient {
  trackId: string;
  title: string;
  durationMs: number | null;
  position: string;
  discogsPosition: string | null;
  side: string | null;
}
export interface RegionClient {
  startMs: number;
  endMs: number;
  trackId: string | null;
  confidence: number;
  title: string; // editable; prefilled from the assigned track
}
export interface TakeClient {
  takeId: string;
  durationMs: number;
  peaks: number[];
  regions: RegionClient[];
  sideGuess: string | null;
}

let phase = $state<RecorderPhase>('idle');
let sessionId = $state<string | null>(null);
let expected = $state<ExpectedTrackClient[]>([]);
let takes = $state<TakeClient[]>([]);
let elapsedMs = $state(0);
let levelL = $state(0);
let levelR = $state(0);
let heldPeakL = $state(0);
let heldPeakR = $state(0);
let clipped = $state(false);
let err = $state<string | null>(null);
let sampleRate = $state(0);

// Non-reactive capture plumbing.
let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let worklet: AudioWorkletNode | null = null;
let analyserL: AnalyserNode | null = null;
let analyserR: AnalyserNode | null = null;
let channelSplitter: ChannelSplitterNode | null = null;
let currentTakeId: string | null = null;
let pending: Float32Array[] = [];
let pendingSamples = 0;
let uploadChain: Promise<void> = Promise.resolve();
let recordStart = 0;
let meterRaf = 0;

// Live waveform: one peak per ~50ms hop, accumulated across the take as it
// records. Plain (non-reactive) array drawn by RecordSession's own rAF loop.
let livePeaks: number[] = [];
let livePeakMax = 0;
let livePeakSamples = 0;
let liveHopFrames = 2400; // sampleRate * 0.05, set per take

const FLUSH_SAMPLES = 48000 * 2; // ~1s of stereo interleaved samples

async function flushPending(): Promise<void> {
  if (pendingSamples === 0 || !sessionId || !currentTakeId) return;
  const buf = new Float32Array(pendingSamples);
  let o = 0;
  for (const c of pending) {
    buf.set(c, o);
    o += c.length;
  }
  pending = [];
  pendingSamples = 0;
  const sid = sessionId;
  const tid = currentTakeId;
  uploadChain = uploadChain.then(async () => {
    const res = await fetch(`/api/recordings/sessions/${sid}/takes/${tid}/chunk`, {
      method: 'POST',
      body: buf,
      headers: { 'content-type': 'application/octet-stream' },
    });
    if (!res.ok) throw new Error(`chunk upload failed: ${res.status}`);
  });
  await uploadChain.catch((e) => {
    err = String(e);
  });
}

function meterLoop() {
  if (!analyserL || !analyserR) return;
  const a = new Float32Array(analyserL.fftSize);
  analyserL.getFloatTimeDomainData(a);
  const b = new Float32Array(analyserR.fftSize);
  analyserR.getFloatTimeDomainData(b);
  let pl = 0;
  let pr = 0;
  for (let i = 0; i < a.length; i++) {
    const v = Math.abs(a[i]);
    if (v > pl) pl = v;
  }
  for (let i = 0; i < b.length; i++) {
    const v = Math.abs(b[i]);
    if (v > pr) pr = v;
  }
  levelL = pl;
  levelR = pr;
  if (pl > heldPeakL) heldPeakL = pl;
  if (pr > heldPeakR) heldPeakR = pr;
  if (pl >= 0.999 || pr >= 0.999) clipped = true;
  if (phase === 'recording') elapsedMs = performance.now() - recordStart;
  meterRaf = requestAnimationFrame(meterLoop);
}

function resetHold() {
  heldPeakL = 0;
  heldPeakR = 0;
}

export const recorder = {
  get phase() {
    return phase;
  },
  get expected() {
    return expected;
  },
  get takes() {
    return takes;
  },
  get elapsedMs() {
    return elapsedMs;
  },
  get levelL() {
    return levelL;
  },
  get levelR() {
    return levelR;
  },
  get clipped() {
    return clipped;
  },
  get heldPeakL() {
    return heldPeakL;
  },
  get heldPeakR() {
    return heldPeakR;
  },
  get levelStatus(): LevelStatus {
    return classifyPeak(toDbfs(Math.max(heldPeakL, heldPeakR)), clipped);
  },
  resetPeakHold() {
    resetHold();
  },
  get error() {
    return err;
  },
  get sampleRate() {
    return sampleRate;
  },
  /** Accumulating per-hop peaks for the current take (drawn live). */
  get livePeaks(): readonly number[] {
    return livePeaks;
  },

  /** Open session + input device; enter live preview. */
  async start(release: string, deviceId?: string) {
    if (phase !== 'idle') return; // single global session — guard double-start
    err = null;
    phase = 'arming';
    try {
      const res = await fetch('/api/recordings/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ releaseId: release }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `session create failed (${res.status})`);
      }
      const data = (await res.json()) as { sessionId: string; tracks: ExpectedTrackClient[] };
      sessionId = data.sessionId;
      expected = data.tracks;

      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
        },
      });
      ctx = new AudioContext();
      sampleRate = ctx.sampleRate;
      await ctx.audioWorklet.addModule('/pcm-recorder-worklet.js');
      const src = ctx.createMediaStreamSource(stream);
      channelSplitter = ctx.createChannelSplitter(2);
      analyserL = ctx.createAnalyser();
      analyserL.fftSize = 2048;
      analyserR = ctx.createAnalyser();
      analyserR.fftSize = 2048;
      src.connect(channelSplitter);
      channelSplitter.connect(analyserL, 0);
      channelSplitter.connect(analyserR, 1);
      worklet = new AudioWorkletNode(ctx, 'pcm-recorder', { numberOfInputs: 1, numberOfOutputs: 0 });
      worklet.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (phase !== 'recording') return;
        const data = e.data;
        pending.push(data);
        pendingSamples += data.length;
        if (pendingSamples >= FLUSH_SAMPLES) void flushPending();
        // Accumulate one peak per hop for the live waveform.
        for (let i = 0; i + 1 < data.length; i += 2) {
          const a = data[i] < 0 ? -data[i] : data[i];
          const b = data[i + 1] < 0 ? -data[i + 1] : data[i + 1];
          const m = a > b ? a : b;
          if (m > livePeakMax) livePeakMax = m;
          if (++livePeakSamples >= liveHopFrames) {
            livePeaks.push(livePeakMax);
            livePeakMax = 0;
            livePeakSamples = 0;
          }
        }
      };
      src.connect(worklet);
      clipped = false;
      resetHold();
      phase = 'preview';
      meterLoop();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      phase = 'idle';
      this.teardownAudio();
    }
  },

  async recordTake() {
    if (!sessionId || !ctx) return;
    clipped = false;
    resetHold();
    err = null;
    const res = await fetch(`/api/recordings/sessions/${sessionId}/takes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sampleRate: ctx.sampleRate, channels: 2 }),
    });
    if (!res.ok) {
      err = `take create failed (${res.status})`;
      return;
    }
    currentTakeId = ((await res.json()) as { takeId: string }).takeId;
    livePeaks = [];
    livePeakMax = 0;
    livePeakSamples = 0;
    liveHopFrames = Math.max(1, Math.round(ctx.sampleRate * 0.05));
    recordStart = performance.now();
    elapsedMs = 0;
    phase = 'recording';
  },

  async stopTake() {
    if (!sessionId || !currentTakeId) return;
    phase = 'analyzing';
    await flushPending();
    await uploadChain;
    const res = await fetch(
      `/api/recordings/sessions/${sessionId}/takes/${currentTakeId}/finalize`,
      { method: 'POST' },
    );
    if (!res.ok) {
      err = `finalize failed (${res.status})`;
      phase = 'preview';
      return;
    }
    const data = (await res.json()) as {
      durationMs: number;
      peaks: number[];
      sideGuess: string | null;
      regions: { startMs: number; endMs: number; trackId: string | null; confidence: number }[];
    };
    const byId = new Map(expected.map((t) => [t.trackId, t]));
    takes = [
      ...takes,
      {
        takeId: currentTakeId,
        durationMs: data.durationMs,
        peaks: data.peaks,
        sideGuess: data.sideGuess,
        regions: data.regions.map((r) => ({
          ...r,
          title: r.trackId ? (byId.get(r.trackId)?.title ?? '') : '',
        })),
      },
    ];
    currentTakeId = null;
    phase = 'preview'; // RecordSession shows the "another side?" prompt
  },

  review() {
    phase = 'reviewing';
    this.teardownAudio();
  },

  async commit(replace = false): Promise<boolean> {
    if (!sessionId) return false;
    phase = 'committing';
    const regions = takes.flatMap((t) =>
      t.regions
        .filter((r) => r.trackId)
        .map((r) => ({
          takeId: t.takeId,
          startMs: Math.round(r.startMs),
          endMs: Math.round(r.endMs),
          trackId: r.trackId as string,
          title: r.title,
        })),
    );
    const res = await fetch(`/api/recordings/sessions/${sessionId}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ regions, replace }),
    });
    if (res.status === 409) {
      phase = 'reviewing';
      return false; // caller prompts to replace
    }
    if (!res.ok) {
      err = `commit failed (${res.status})`;
      phase = 'reviewing';
      return true;
    }
    phase = 'done';
    return true;
  },

  async cancel() {
    if (sessionId) {
      await fetch(`/api/recordings/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => {});
    }
    this.teardownAudio();
    sessionId = null;
    expected = [];
    takes = [];
    err = null;
    phase = 'idle';
  },

  teardownAudio() {
    cancelAnimationFrame(meterRaf);
    worklet?.disconnect();
    worklet = null;
    channelSplitter?.disconnect();
    channelSplitter = null;
    analyserL = null;
    analyserR = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    void ctx?.close();
    ctx = null;
  },

  previewUrl(takeId: string, startMs: number, endMs: number): string {
    return `/api/recordings/sessions/${sessionId}/takes/${takeId}/audio?startMs=${Math.round(startMs)}&endMs=${Math.round(endMs)}`;
  },
};
