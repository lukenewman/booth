import { withCompilationArtist } from '../src/lib/server/sources/local/compilation';

function eq(a: unknown, e: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(e)) { console.error(`FAIL ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`); process.exit(1); }
}
const t = (artist: string, album: string, o: { compilation?: boolean; albumArtist?: string; year?: number } = {}) =>
  ({ artist, album, year: o.year ?? 2017, compilation: o.compilation, albumArtist: o.albumArtist });

const out = withCompilationArtist([
  t('Earth Boys', '2MR 2017 Label Sampler', { compilation: true }),
  t('Bottin', '2MR 2017 Label Sampler', { compilation: true }),
  t('Gel Set', '2MR 2017 Label Sampler', { compilation: true }),
  t('Solo', 'Untitled', { compilation: true }),                                  // one artist: keep it
  t('A', 'Mixed', { compilation: true, albumArtist: 'Label Name' }),              // album artist given: keep it
  t('B', 'Mixed', { compilation: true, albumArtist: 'Label Name' }),
  t('X', 'Same Name'), t('Y', 'Same Name'),                                       // not flagged: untouched
  t('P', 'Twice', { compilation: true, year: 2001 }), t('Q', 'Twice', { compilation: true, year: 2002 }), // different years: different albums
]);
eq(out.map((x) => x.albumArtist ?? null),
  ['Various Artists', 'Various Artists', 'Various Artists', null, 'Label Name', 'Label Name', null, null, null, null],
  'only multi-artist compilations without an album artist are grouped');
eq(out[0].artist, 'Earth Boys', 'track artist untouched');
console.log('ok verify-compilations');
