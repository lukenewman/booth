// Verifies the tracklist/player transport state machine.
//
// The tracklist used to derive its ▶ from `player.nowPlaying?.trackId === t.id`
// alone — "is the loaded track", not "is playing". A PAUSED track therefore
// rendered the same ▶ as a playing one, which under a real transport button
// would offer "play" while already loaded, or show ⏸ for a stopped track.
import { trackPlayState, transportGlyph, transportLabel } from '../src/lib/playback';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else console.log('ok:', msg);
}

assert(trackPlayState('t1', 't1', true) === 'playing', 'loaded + playing → playing');
assert(trackPlayState('t1', 't1', false) === 'paused', 'loaded + not playing → paused (the bug)');
assert(trackPlayState('t1', 't2', true) === 'idle', 'a different track playing → idle');
assert(trackPlayState('t1', null, false) === 'idle', 'nothing loaded → idle');
assert(trackPlayState('t1', undefined, true) === 'idle', 'undefined loaded id → idle');
assert(trackPlayState('t1', '', true) === 'idle', 'empty loaded id → idle');

assert(transportGlyph('playing') === '⏸', 'playing shows pause glyph');
assert(transportGlyph('paused') === '▶', 'paused shows play glyph');
assert(transportGlyph('idle') === '▶', 'idle shows play glyph');

assert(transportLabel('playing', 'Dust') === 'Pause Dust', 'playing labels as Pause');
assert(transportLabel('paused', 'Dust') === 'Resume Dust', 'paused labels as Resume');
assert(transportLabel('idle', 'Dust') === 'Play Dust', 'idle labels as Play');

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
