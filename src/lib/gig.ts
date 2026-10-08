/**
 * Pure gig arithmetic, kept out of components so it can be verified without a
 * DOM. Durations are often missing (Discogs-only tracks), so every total
 * carries a `partial` flag and renders with a `+`.
 */

export interface SectionSummary {
  count: number;
  ms: number;
  partial: boolean;
  bpmMin: number | null;
  bpmMax: number | null;
}

export function summarize(tracks: { duration_ms: number | null; bpm?: { value: number } | null }[]): SectionSummary {
  let ms = 0;
  let partial = false;
  let bpmMin: number | null = null;
  let bpmMax: number | null = null;
  for (const t of tracks) {
    if (t.duration_ms) ms += t.duration_ms;
    else partial = true;
    const b = t.bpm?.value;
    if (b != null) {
      const r = Math.round(b);
      bpmMin = bpmMin == null ? r : Math.min(bpmMin, r);
      bpmMax = bpmMax == null ? r : Math.max(bpmMax, r);
    }
  }
  return { count: tracks.length, ms, partial, bpmMin, bpmMax };
}

/** Hours matter for a set, seconds don't. */
export function formatRunTime(ms: number, partial: boolean): string {
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  const label = h ? `${h} hr ${min % 60} min` : `${min} min`;
  return partial ? `${label}+` : label;
}

export function formatTarget(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Accepts "3:00", "3h", "2.5h", "90", "90 min". Returns minutes, or null. */
export function parseLength(input: string): number | null {
  const s = input.trim().toLowerCase();
  let m: RegExpMatchArray | null;
  let minutes: number | null = null;
  if ((m = s.match(/^(\d+):(\d{2})$/))) {
    const mm = Number(m[2]);
    if (mm < 60) minutes = Number(m[1]) * 60 + mm;
  } else if ((m = s.match(/^(\d+(?:\.\d+)?)\s*h(?:rs?|ours?)?$/))) {
    minutes = Math.round(Number(m[1]) * 60);
  } else if ((m = s.match(/^(\d+)\s*(?:m|min|mins|minutes)?$/))) {
    minutes = Number(m[1]);
  }
  return minutes && minutes > 0 && minutes <= 24 * 60 ? minutes : null;
}
