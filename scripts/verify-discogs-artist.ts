import { stripDisambiguation } from '../src/lib/server/sources/discogs/format';

function assertEq(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    process.exit(1);
  }
}

// Discogs appends " (N)" to tell same-named artists apart. It is not part of
// the name and never appears in a file's tags.
assertEq(stripDisambiguation('Picture (6)'), 'Picture', 'trailing suffix');
assertEq(stripDisambiguation('Speed Boat (2)'), 'Speed Boat', 'trailing suffix, two words');

// The search endpoint hands us the artists already joined; a suffix can sit
// before a separator as well as at the end.
assertEq(
  stripDisambiguation('Harvey Sutherland, Bermuda (6)'),
  'Harvey Sutherland, Bermuda',
  'joined list, suffix at end',
);
assertEq(
  stripDisambiguation('Bermuda (6), Harvey Sutherland'),
  'Bermuda, Harvey Sutherland',
  'joined list, suffix before comma',
);
assertEq(
  stripDisambiguation('Halo (3) & Atwater Feat. Mr. V (4)'),
  'Halo & Atwater Feat. Mr. V',
  'joined list, two suffixes',
);

// Names that merely contain digits or parentheses are left alone.
assertEq(stripDisambiguation('Blink-182'), 'Blink-182', 'digits without parens');
assertEq(stripDisambiguation('808 State'), '808 State', 'leading digits');
assertEq(stripDisambiguation('Picture (Six)'), 'Picture (Six)', 'non-numeric parens');
assertEq(stripDisambiguation('(unknown)'), '(unknown)', 'sentinel');
assertEq(stripDisambiguation('  Picture (6) '), 'Picture', 'trims whitespace');

console.log('verify-discogs-artist: all assertions passed');
