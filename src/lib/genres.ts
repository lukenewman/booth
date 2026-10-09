/**
 * Discogs' fixed genre list — the short list every coarse question
 * ("all electronic", "not electronic") runs on. Stored in Discogs' casing so
 * Discogs data matches exactly; shown lowercase everywhere.
 */
export const GENRES = [
  'Electronic', 'Rock', 'Funk / Soul', 'Jazz', 'Hip Hop', 'Pop',
  'Folk, World, & Country', 'Latin', 'Reggae', 'Blues', 'Classical',
  'Stage & Screen', 'Non-Music', "Children's", 'Brass & Military',
] as const;

export function display(name: string): string {
  return name.toLowerCase();
}

/**
 * Twelve hues for style pills, tuned for the dark theme. More than this stop
 * reading as distinct, so styles beyond the top twelve share — see
 * `assignStyleColors` for who gets which.
 */
// Slots are handed out most-used first, so consecutive slots must be far apart
// on the wheel: the top three styles (house, deep house, techno) landing on
// neighbouring hues is exactly the confusion this exists to prevent.
const HUES = [25, 200, 115, 290, 70, 245, 160, 340, 95, 220, 135, 315];
export const PALETTE = HUES.map((h) => ({
  bg: `oklch(0.37 0.11 ${h})`,
  fg: `oklch(0.93 0.07 ${h})`,
}));
export const PALETTE_SIZE = PALETTE.length;

/** Colour for a style with no assigned slot yet (seen before the next resolve). */
export function fallbackSlot(style: string): number {
  let h = 0;
  for (const c of style) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % PALETTE_SIZE;
}
