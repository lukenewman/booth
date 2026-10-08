import { summarize, formatRunTime, formatTarget, parseLength } from '../src/lib/gig';
function fail(m: string): never { console.error(`FAIL: ${m}`); process.exit(1); }
function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

eq(summarize([]), { count: 0, ms: 0, partial: false, bpmMin: null, bpmMax: null }, 'empty');
eq(summarize([
  { duration_ms: 300000, bpm: { value: 118.4 } },
  { duration_ms: null, bpm: null },
  { duration_ms: 240000, bpm: { value: 96 } },
]), { count: 3, ms: 540000, partial: true, bpmMin: 96, bpmMax: 118 }, 'mixed');
eq(formatRunTime(0, false), '0 min', 'zero');
eq(formatRunTime(45 * 60000, false), '45 min', 'minutes');
eq(formatRunTime(134 * 60000, true), '2 hr 14 min+', 'hours partial');
eq(formatTarget(180), '3:00', 'target');
eq(formatTarget(95), '1:35', 'target odd');
eq(parseLength('3:00'), 180, 'h:mm');
eq(parseLength('1:30'), 90, 'h:mm 2');
eq(parseLength('3h'), 180, 'Nh');
eq(parseLength('2.5h'), 150, 'decimal h');
eq(parseLength('90'), 90, 'plain minutes');
eq(parseLength(' 90 min '), 90, 'min suffix');
eq(parseLength(''), null, 'empty');
eq(parseLength('soon'), null, 'junk');
eq(parseLength('0'), null, 'zero rejected');
eq(parseLength('1:75'), null, 'bad minutes');
console.log('PASS: gig summary helpers');
