/**
 * verify-playlist-order.ts — playlist reorder arithmetic.
 *
 * The gesture moved to pointer events (so touch works), but the ordering maths
 * is what actually decides what gets persisted. Kept pure and covered here
 * because the gesture layer itself needs a DOM and a finger.
 *
 * Run: bun verify scripts/verify-playlist-order.ts
 */
import { moveByDelta, reorderTo } from '../src/lib/playlistOrder';

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

const ids = ['a', 'b', 'c', 'd'];

// --- reorderTo -------------------------------------------------------------

check('drag first onto third', reorderTo(ids, 'a', 'c'), ['b', 'c', 'a', 'd']);
check('drag last onto first', reorderTo(ids, 'd', 'a'), ['d', 'a', 'b', 'c']);
// Regression: the old implementation always inserted before the target, so
// this exact case returned the list unchanged — a dead zone where a row could
// not be moved down by one.
check('drag onto next row moves it down', reorderTo(ids, 'b', 'c'), ['a', 'c', 'b', 'd']);
check('drag onto previous row moves it up', reorderTo(ids, 'c', 'b'), ['a', 'c', 'b', 'd']);
check('drop on self is a no-op', reorderTo(ids, 'b', 'b'), null);
// Dragged in from another view: the rail owns adding, so reorder must decline.
check('unknown moved id declines', reorderTo(ids, 'zz', 'b'), null);
check('unknown target declines', reorderTo(ids, 'b', 'zz'), null);
check('input array is not mutated', ids, ['a', 'b', 'c', 'd']);

// --- moveByDelta -----------------------------------------------------------

check('nudge up', moveByDelta(ids, 'c', -1), ['a', 'c', 'b', 'd']);
check('nudge down', moveByDelta(ids, 'b', 1), ['a', 'c', 'b', 'd']);
check('up past the top declines', moveByDelta(ids, 'a', -1), null);
check('down past the end declines', moveByDelta(ids, 'd', 1), null);
check('unknown id declines', moveByDelta(ids, 'zz', 1), null);
check('still not mutated', ids, ['a', 'b', 'c', 'd']);

// A drag and the equivalent keyboard nudge must agree, or the two affordances
// would disagree about what "move one slot down" means.
check('nudge down == drag onto the next row', moveByDelta(ids, 'b', 1), reorderTo(ids, 'b', 'c'));

console.log(failures === 0 ? '\nOK: playlist reorder arithmetic' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
