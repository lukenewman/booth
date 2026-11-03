import type { BoothTrackFacts } from '../library/tag_schema';
import { BOOTH_KEYS } from '../library/tag_schema';
import type { FileTags } from '../library/tags';

/**
 * Rebuild-from-tags, per file: does what a copy's tags say match what Booth
 * knows? The takeover runs it on every copy before the release flips (a copy
 * whose tags didn't take is refused), and it is the restore test's unit: a
 * database rebuilt from the folder must say the same.
 */
export interface TagDifference { field: string; expected: string; got: string }

const strip = (k: string) => k.replace(/^BOOTH_/, '');

export function tagDifferences(facts: BoothTrackFacts, tags: FileTags): TagDifference[] {
  const out: TagDifference[] = [];
  const cmp = (field: string, expected: unknown, got: unknown) => {
    const e = expected == null || expected === '' ? '' : String(expected);
    const g = got == null || got === '' ? '' : String(got);
    if (e !== g) out.push({ field, expected: e, got: g });
  };
  if (facts.names) {
    const n = facts.names;
    cmp('title', n.title, tags.title);
    cmp('artist', n.artist, tags.artist);
    if (n.album) cmp('album', n.album, tags.album);
    if (n.albumArtist) cmp('album artist', n.albumArtist, tags.albumArtist);
    if (n.year) cmp('year', n.year, tags.year);
    if (n.trackNumber) cmp('track number', n.trackNumber, tags.trackNumber);
  }
  const b = tags.booth;
  cmp('date added', facts.dateAdded, b[strip(BOOTH_KEYS.dateAdded)]);
  cmp('date added as reported', facts.dateAddedReported, b[strip(BOOTH_KEYS.dateAddedReported)]);
  cmp('date added provenance', facts.dateAddedOrigin, b[strip(BOOTH_KEYS.dateAddedOrigin)]);
  cmp('starred', facts.starred ? '1' : '', b[strip(BOOTH_KEYS.starred)]);
  cmp('vetted', facts.vetted ? '1' : '', b[strip(BOOTH_KEYS.vetted)]);
  cmp('Discogs release', facts.discogsReleaseId, b[strip(BOOTH_KEYS.discogsReleaseId)]);
  cmp('origin', facts.origin, b[strip(BOOTH_KEYS.origin)]);
  if (facts.note) cmp('note', facts.note, tags.comment);
  if (facts.bpm !== undefined) cmp('tempo', Math.round(facts.bpm), tags.bpm != null ? Math.round(tags.bpm) : undefined);
  return out;
}
