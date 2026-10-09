import { staticVocabulary, mapTerms, splitFileGenre, inferGenres, mapBandcampGenre } from '../src/lib/server/genres/vocabulary';
import { display, fallbackSlot, PALETTE_SIZE } from '../src/lib/genres';

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) { console.error(`FAIL ${label}: got ${a}, want ${e}`); process.exit(1); }
}
const v = staticVocabulary();
const map = (raw: string) => mapTerms(splitFileGenre(raw), v);

eq(map('Deep House'), { genres: [], styles: ['Deep House'] }, 'plain style');
eq(map('deep-house'), { genres: [], styles: ['Deep House'] }, 'punctuation');
eq(map('R&B/Soul'), { genres: ['Funk / Soul'], styles: [] }, 'R&B not split on bare &');
eq(map('Techno (Peak Time / Driving)'), { genres: [], styles: ['Techno'] }, 'bracketed qualifier');
eq(map('Dance & House'), { genres: [], styles: ['House'] }, 'spaced & splits');
eq(map('Hip-Hop/Rap'), { genres: ['Hip Hop'], styles: [] }, 'genre alias beats Electronic style "Hip Hop"');
eq(map('HELP-OLO-GET-RICH'), { genres: [], styles: [] }, 'junk dropped');
eq(mapTerms(['moodymann', 'Detroit', 'experimental', 'drum & bass'], v), { genres: [], styles: ['Experimental', 'Drum n Bass'] }, 'bandcamp tags');
eq(inferGenres([], ['Deep House'], v), ['Electronic'], 'parent inference');
eq(inferGenres(['Jazz'], ['Deep House'], v), ['Jazz'], 'explicit wins');
eq(inferGenres([], ['Disco'], v).sort(), ['Electronic', 'Funk / Soul'], 'multi-parent');
eq(mapBandcampGenre('r-b-soul'), 'Funk / Soul', 'bandcamp genre');
eq(mapBandcampGenre('experimental'), null, 'unmapped bandcamp genre');
eq(display('Folk, World, & Country'), 'folk, world, & country', 'display lowercase');
eq(fallbackSlot('Deep House') === fallbackSlot('Deep House') && fallbackSlot('x') < PALETTE_SIZE, true, 'fallback slot stable and in range');
console.log('ok verify-genre-vocabulary');
