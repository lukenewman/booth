import { parseITunesLibrary } from '../src/lib/server/sources/itunes/parse';

const lib = parseITunesLibrary('scripts/fixtures/itunes-tiny.xml');

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (lib.tracks.length !== 2) fail(`expected 2 tracks, got ${lib.tracks.length}`);
if (lib.skipped !== 1) fail(`expected 1 skipped, got ${lib.skipped}`);

const t = lib.tracks.find((x) => x.trackId === 12345);
if (!t) fail('missing track 12345');
if (t.name !== 'Around the World') fail(`name: ${t.name}`);
if (t.album !== 'Homework') fail(`album: ${t.album}`);
if (t.year !== 1997) fail(`year: ${t.year}`);
if (t.rating !== 100) fail(`rating: ${t.rating}`);
if (!t.location.includes('Around%20the%20World.m4a')) fail(`location: ${t.location}`);

console.log('OK: itunes parse');
