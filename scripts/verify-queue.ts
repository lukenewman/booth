// Verifies pure queue arithmetic: advancing, the 3s prev rule, and both
// boundaries. Kept free of Svelte/DOM so the rules can be asserted directly.
import {
  nextIndex,
  prevTarget,
  PREV_RESTART_THRESHOLD_S,
} from '../src/lib/queue';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else console.log('ok:', msg);
}

// next
assert(nextIndex(0, 5) === 1, 'next from the start advances');
assert(nextIndex(3, 5) === 4, 'next from the middle advances');
assert(nextIndex(4, 5) === null, 'next at the last index stops (no wrap)');
assert(nextIndex(-1, 0) === null, 'next with no queue is null');
assert(nextIndex(0, 0) === null, 'next over an empty queue is null');

// prev — past the threshold, always restart
assert(
  prevTarget(PREV_RESTART_THRESHOLD_S + 0.1, 3, 5).kind === 'restart',
  'prev past 3s restarts rather than stepping back',
);
assert(prevTarget(30, 0, 5).kind === 'restart', 'prev past 3s at index 0 restarts');

// prev — at or under the threshold, step back
const early = prevTarget(1, 3, 5);
assert(early.kind === 'move' && early.index === 2, 'prev under 3s steps back one');
const boundary = prevTarget(PREV_RESTART_THRESHOLD_S, 3, 5);
assert(
  boundary.kind === 'move' && boundary.index === 2,
  'exactly 3s still steps back (threshold is exclusive)',
);
assert(prevTarget(0, 0, 5).kind === 'restart', 'prev at index 0 restarts, never underflows');

// no queue
assert(prevTarget(10, -1, 0).kind === 'none', 'prev with no queue is a no-op');
assert(prevTarget(0, -1, 0).kind === 'none', 'prev with no queue is a no-op regardless of time');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
