import {
  normalizeArtistAlbumYear,
  normalizeFilePath,
} from '../src/lib/server/library/normalize';

function assertEq(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    process.exit(1);
  }
}

assertEq(
  normalizeArtistAlbumYear({ artist: 'Daft Punk', album: 'Homework', year: 1997 }),
  'daftpunk|homework|1997',
  'basic',
);
assertEq(
  normalizeArtistAlbumYear({ artist: 'Björk', album: 'Post', year: 1995 }),
  'bjork|post|1995',
  'diacritics',
);
assertEq(
  normalizeArtistAlbumYear({
    artist: 'Daft Punk*',
    album: 'Discovery (Reissue)',
    year: 2001,
  }),
  'daftpunk|discoveryreissue|2001',
  'punctuation',
);
assertEq(
  normalizeArtistAlbumYear({ artist: 'X', album: 'Y', year: null }),
  null,
  'null year',
);
assertEq(
  normalizeArtistAlbumYear({ artist: '', album: 'Y', year: 1999 }),
  null,
  'empty artist',
);

assertEq(
  normalizeFilePath('file:///Users/luke/Music/Around%20the%20World.m4a'),
  '/Users/luke/Music/Around the World.m4a',
  'file url',
);
assertEq(
  normalizeFilePath('/Users/luke/Music/x/'),
  '/Users/luke/Music/x',
  'trailing slash',
);
assertEq(
  normalizeFilePath('/Users/luke/Music/Around the World.m4a'),
  '/Users/luke/Music/Around the World.m4a',
  'plain path',
);

console.log('OK: normalize');
