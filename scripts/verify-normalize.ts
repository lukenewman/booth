import {
  normalizeArtistAlbum,
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
    album: 'Discovery (Remixes)',
    year: 2001,
  }),
  'daftpunk|discoveryremixes|2001',
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
  normalizeArtistAlbum({ artist: 'ML Buch', album: 'Suntub' }),
  'mlbuch|suntub',
  'artist_album basic',
);
assertEq(
  normalizeArtistAlbum({ artist: 'Björk', album: 'Post' }),
  'bjork|post',
  'artist_album diacritics',
);
assertEq(
  normalizeArtistAlbum({ artist: 'X', album: '' }),
  null,
  'artist_album empty album',
);
assertEq(
  normalizeArtistAlbum({ artist: 'Seb Wildblood', album: ':~^' }),
  null,
  'artist_album unkeyable title',
);

// Edition tags in local titles — Bandcamp and Apple both append them — are not
// part of the album name and never appear on the Discogs side.
assertEq(
  normalizeArtistAlbum({ artist: 'Lotte Kærså & Græsrødderne', album: 'Jubiiilæum (Reissue)' }),
  normalizeArtistAlbum({ artist: 'Lotte Kærså & Græsrødderne', album: 'Jubiiilæum' }),
  'artist_album strips (Reissue)',
);
assertEq(
  normalizeArtistAlbumYear({ artist: 'Felbm', album: 'Tape 3/Tape 4 (Full Album)', year: 2020 }),
  'felbm|tape3tape4|2020',
  'artist_album_year strips (Full Album)',
);
assertEq(
  normalizeArtistAlbum({ artist: 'Daft Punk', album: 'Homework (25th Anniversary Edition)' }),
  'daftpunk|homework',
  'artist_album strips (… Edition)',
);
assertEq(
  normalizeArtistAlbum({ artist: 'Analog Tara', album: 'Intents + Purposes (20th Anniversary Reissue)' }),
  'analogtara|intentspurposes',
  'artist_album strips (… Reissue)',
);
assertEq(
  normalizeArtistAlbum({ artist: 'Chicago', album: 'Chicago 13 [Remastered]' }),
  'chicago|chicago13',
  'artist_album strips [Remastered]',
);
assertEq(
  normalizeArtistAlbum({ artist: 'Modjo', album: 'Modjo (2009 Remaster) (Reissue)' }),
  'modjo|modjo',
  'artist_album strips stacked edition tags',
);
// Parentheticals that name a different record stay in the key.
assertEq(
  normalizeArtistAlbum({ artist: 'X', album: 'Album (Remixes)' }),
  'x|albumremixes',
  'artist_album keeps (Remixes)',
);
assertEq(
  normalizeArtistAlbum({ artist: 'Sleep D', album: 'Red Rock (BSR014)' }),
  'sleepd|redrockbsr014',
  'artist_album keeps a catalogue number',
);
assertEq(
  normalizeArtistAlbum({ artist: 'X', album: 'Sneaky Pete (Edit)' }),
  'x|sneakypeteedit',
  'artist_album keeps (Edit)',
);
assertEq(
  normalizeArtistAlbum({ artist: 'X', album: '(Reissue)' }),
  'x|reissue',
  'artist_album does not strip the whole title',
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
