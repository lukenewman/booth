import { parseYouTubeId } from '../src/lib/server/sources/discogs/youtube';

function assertEq(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    process.exit(1);
  }
  console.log(`ok   ${label}`);
}

assertEq(parseYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ', 'watch?v');
assertEq(parseYouTubeId('http://youtube.com/watch?v=abc123&t=30s'), 'abc123', 'watch?v + extra params');
assertEq(parseYouTubeId('https://youtu.be/XYZ_-789'), 'XYZ_-789', 'youtu.be short');
assertEq(parseYouTubeId('https://music.youtube.com/watch?v=mYid0001'), 'mYid0001', 'music.youtube.com');
assertEq(parseYouTubeId('https://m.youtube.com/watch?v=mobileId1'), 'mobileId1', 'm.youtube.com');
assertEq(parseYouTubeId('https://www.youtube.com/embed/embedId99'), 'embedId99', '/embed/ path');
assertEq(parseYouTubeId('https://vimeo.com/12345'), null, 'non-youtube → null');
assertEq(parseYouTubeId('https://www.youtube.com/results?search_query=foo'), null, 'no video id → null');
assertEq(parseYouTubeId('not a url'), null, 'garbage → null');

console.log('\nparseYouTubeId: all cases passed.');
