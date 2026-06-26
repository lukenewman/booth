// Verifies the pure helpers behind master-grouped Discogs add search:
// buildFormatLabel (rich color/weight format string from Discogs `formats[]`)
// and groupByMaster (collapse search hits into master groups + singletons).
import { buildFormatLabel } from '../src/lib/server/sources/discogs/format';
import { groupByMaster, type SearchHit } from '../src/lib/discogs/group';

let failures = 0;
const assert = (c: boolean, m: string) => {
  if (!c) {
    console.error('FAIL:', m);
    failures++;
  } else console.log('ok:', m);
};
const eq = (a: unknown, b: unknown, m: string) =>
  assert(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)})`);

// --- buildFormatLabel ---
eq(
  buildFormatLabel([{ name: 'Vinyl', qty: '1', text: 'Clear, 180g', descriptions: ['LP', 'Album'] }]),
  'Vinyl, LP, Album, Clear, 180g',
  'name + descriptions + text',
);
eq(
  buildFormatLabel([{ name: 'Vinyl', qty: '1', descriptions: ['LP', 'Album'] }]),
  'Vinyl, LP, Album',
  'no text',
);
eq(buildFormatLabel([]), null, 'empty formats → null');
eq(buildFormatLabel(undefined), null, 'undefined formats → null');
eq(
  buildFormatLabel([{ name: 'Vinyl', qty: '2', descriptions: ['LP', 'Album'] }]),
  '2×Vinyl, LP, Album',
  'qty>1 prefixed',
);
eq(
  buildFormatLabel([{ name: 'Vinyl', descriptions: ['LP'] }, { name: 'CD' }]),
  'Vinyl, LP / CD',
  'multiple format objects joined with /',
);
eq(
  buildFormatLabel([{ name: 'Vinyl', text: '  Clear ,  180g ', descriptions: ['LP'] }]),
  'Vinyl, LP, Clear, 180g',
  'text parts trimmed',
);

// --- groupByMaster ---
const hit = (id: number, masterId: number | null, year: number | null, extra: Partial<SearchHit> = {}): SearchHit => ({
  id,
  masterId,
  year,
  title: 'Great Doubt',
  artist: 'Astrid Sonne',
  country: 'Denmark',
  label: 'Escho',
  catno: 'ESC192',
  format: 'Vinyl, LP, Album',
  thumb: `thumb-${id}`,
  coverImage: null,
  ...extra,
});

{
  // 5 versions sharing a master + 1 single-version master + 1 no-master release
  const groups = groupByMaster([
    hit(1, 100, 2024),
    hit(2, 100, 2024),
    hit(3, 100, 2025),
    hit(4, 100, 2024),
    hit(5, 100, 2025),
    hit(6, 200, 2023), // single-version master
    hit(7, null, 2022), // no master
  ]);
  eq(groups.length, 3, 'three display groups');
  // sorted by earliest year asc → no-master(2022), single master(2023), big master(2024)
  eq(
    groups.map((g) => g.key),
    ['release:7', 'release:6', 'master:100'],
    'groups sorted by earliest year asc',
  );
  const big = groups.find((g) => g.key === 'master:100')!;
  assert(big.isMaster === true, 'multi-version master isMaster');
  eq(big.versionCount, 5, 'master version count');
  eq(big.yearLabel, '2024–2025', 'master year range');
  eq(big.versions.map((v) => v.id), [1, 2, 4, 3, 5], 'versions year-asc, stable within year');
  const single = groups.find((g) => g.key === 'release:6')!;
  assert(single.isMaster === false, 'single-version master is a plain release row');
  eq(single.versionCount, 1, 'singleton count');
  const nomaster = groups.find((g) => g.key === 'release:7')!;
  assert(nomaster.isMaster === false, 'no-master release is a plain row');
  eq(nomaster.masterId, null, 'no-master masterId null');
}

{
  // all same year → single year label
  const groups = groupByMaster([hit(1, 100, 2024), hit(2, 100, 2024)]);
  eq(groups[0].yearLabel, '2024', 'single year label when min==max');
}
{
  // all null years → null label
  const groups = groupByMaster([hit(1, 100, null), hit(2, 100, null)]);
  eq(groups[0].yearLabel, null, 'null year label when all null');
}
{
  // masterId 0 is treated as no-master (Discogs sentinel)
  const groups = groupByMaster([hit(1, 0, 2024), hit(2, 0, 2024)]);
  eq(groups.length, 2, 'masterId 0 → two singletons (not grouped)');
  eq(groups.every((g) => g.key.startsWith('release:')), true, 'masterId 0 → release rows');
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
} else {
  console.log('\nall master-grouping checks passed');
}
