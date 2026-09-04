/**
 * What Booth fact goes into which tag field.
 *
 * Two carriers, chosen by whether anything else can read the field:
 *
 * - **Standard frames** for facts other software consumes — tempo and comment
 *   are what rekordbox reads, so an analysed BPM belongs in the tempo field and
 *   a note in the comment, not in a Booth-private field nothing will look at.
 * - **`BOOTH_*` custom fields** for everything standard tags cannot express:
 *   acquisition date, its provenance, vetted-ness, the fingerprint, Discogs
 *   linkage, rip origin.
 *
 * A star is carried in *both*. The standard rating is what makes it visible in
 * rekordbox; the Booth field is what survives a rebuild, and is the only carrier
 * on M4A, where the rating does not write at all.
 */

/** Custom field names. Containers spell the prefix differently; the reader strips it. */
export const BOOTH_KEYS = {
  dateAdded: 'BOOTH_DATE_ADDED',
  dateAddedReported: 'BOOTH_DATE_ADDED_REPORTED',
  dateAddedOrigin: 'BOOTH_DATE_ADDED_ORIGIN',
  starred: 'BOOTH_STARRED',
  vetted: 'BOOTH_VETTED',
  fingerprint: 'BOOTH_FINGERPRINT',
  discogsReleaseId: 'BOOTH_DISCOGS_RELEASE_ID',
  origin: 'BOOTH_ORIGIN',
} as const;

/**
 * POPM byte values by star count, from taglib-wasm's own table.
 *
 * Copied deliberately rather than imported: the library ships a `RatingUtils.toPopm()`
 * helper that returns 255 for one star and 0 for two through five. The table is
 * right and the helper is not, so the table is what Booth uses.
 */
export const POPM_STAR_VALUES = [0, 1, 64, 128, 196, 255] as const;

export interface BoothTrackFacts {
  /** Effective acquisition date — recovered where the overlay supplied one. */
  dateAdded?: string;
  /** What Music.app reported, kept so a grafted date stays distinguishable. */
  dateAddedReported?: string;
  /** 'recovered' | 'reported'. */
  dateAddedOrigin?: string;
  starred?: boolean;
  /** Free-text note. Goes to the standard comment field, which rekordbox displays. */
  note?: string;
  /** Release-level flag, denormalised onto each of the release's tracks. */
  vetted?: boolean;
  /** Analysed tempo. Goes to the standard tempo field. */
  bpm?: number;
  fingerprint?: string;
  discogsReleaseId?: string;
  /** 'vinyl' for rips written by the recording feature. */
  origin?: string;
}

export interface TagWrite {
  comment?: string;
  bpm?: number;
  /** 0..5; undefined means "write no rating", which is not the same as zero stars. */
  ratingStars?: number;
  custom: Record<string, string>;
}

export function toTagWrite(facts: BoothTrackFacts): TagWrite {
  const custom: Record<string, string> = {};
  const put = (key: string, value: string | undefined) => {
    if (value !== undefined && value !== '') custom[key] = value;
  };

  put(BOOTH_KEYS.dateAdded, facts.dateAdded);
  put(BOOTH_KEYS.dateAddedReported, facts.dateAddedReported);
  put(BOOTH_KEYS.dateAddedOrigin, facts.dateAddedOrigin);
  put(BOOTH_KEYS.fingerprint, facts.fingerprint);
  put(BOOTH_KEYS.discogsReleaseId, facts.discogsReleaseId);
  put(BOOTH_KEYS.origin, facts.origin);
  // Flags are written only when true. A "0" would claim the user actively
  // un-starred something, which is a different fact from never having starred it.
  if (facts.starred) put(BOOTH_KEYS.starred, '1');
  if (facts.vetted) put(BOOTH_KEYS.vetted, '1');

  const write: TagWrite = { custom };
  if (facts.note) write.comment = facts.note;
  if (facts.bpm !== undefined) write.bpm = facts.bpm;
  if (facts.starred) write.ratingStars = 5;
  return write;
}
