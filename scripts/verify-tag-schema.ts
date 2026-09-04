/**
 * verify-tag-schema.ts — what Booth fact goes into which tag field.
 *
 * Pure mapping, so this is the cheapest place to pin the decisions down: which
 * facts get a standard frame (because another tool reads them) and which get a
 * BOOTH_ custom field (because nothing standard expresses them).
 *
 * Run: bun verify scripts/verify-tag-schema.ts
 */
import { toTagWrite, BOOTH_KEYS, POPM_STAR_VALUES } from '../src/lib/server/library/tag_schema';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? '✓' : '✗'} ${label}` +
      (ok ? '' : `\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`),
  );
}

// Facts other tools read go to standard fields.
const analysed = toTagWrite({ bpm: 124, note: 'peak time' });
check('analysed tempo goes to the standard field', analysed.bpm, 124);
check('a note goes to the standard comment', analysed.comment, 'peak time');

// A star is a keeper flag, not a rating — it maps to the top of the scale so
// other software shows five stars rather than "1 out of 255".
const starred = toTagWrite({ starred: true });
check('a star writes full marks', starred.ratingStars, 5);
check('POPM value for five stars', POPM_STAR_VALUES[5], 255);
check('unstarred writes no rating at all', toTagWrite({ starred: false }).ratingStars, undefined);

// Facts nothing standard expresses go to Booth's own fields.
const facts = toTagWrite({
  dateAdded: '2020-10-05T18:22:00Z',
  dateAddedReported: '2025-08-25T13:37:11Z',
  dateAddedOrigin: 'recovered',
  starred: true,
  vetted: true,
  fingerprint: 'abc123',
  discogsReleaseId: '98765',
  origin: 'vinyl',
});
check('acquisition date', facts.custom[BOOTH_KEYS.dateAdded], '2020-10-05T18:22:00Z');
check('what Music.app reported', facts.custom[BOOTH_KEYS.dateAddedReported], '2025-08-25T13:37:11Z');
check('date provenance', facts.custom[BOOTH_KEYS.dateAddedOrigin], 'recovered');
check('star also carried as a Booth field', facts.custom[BOOTH_KEYS.starred], '1');
check('vetted, denormalised from the release', facts.custom[BOOTH_KEYS.vetted], '1');
check('fingerprint', facts.custom[BOOTH_KEYS.fingerprint], 'abc123');
check('discogs linkage', facts.custom[BOOTH_KEYS.discogsReleaseId], '98765');
check('rip provenance', facts.custom[BOOTH_KEYS.origin], 'vinyl');

// Absent facts must not write empty fields — an empty tag is worse than none.
check('nothing set writes nothing', toTagWrite({}), { custom: {} });
check('false flags write nothing', toTagWrite({ starred: false, vetted: false }), { custom: {} });

// The star is carried twice on purpose: the standard field is what rekordbox
// reads, the Booth field is what survives a rebuild on M4A (where the standard
// rating does not write at all).
check('both carriers present for a star', Object.keys(starred.custom), [BOOTH_KEYS.starred]);

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
