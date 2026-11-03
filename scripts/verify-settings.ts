/**
 * Where settings are saved and how they're read back. Load-bearing claims:
 *  - under `bun dev` (no BOOTH_SETTINGS_PATH) settings go to
 *    `.booth-settings.env`, never `.env`: Vite restarts the dev server when
 *    `.env` changes, which took the server down when rekordbox was connected;
 *  - the file's values win over `.env`'s, and blank and comment lines are ignored.
 *
 * Run: bun verify scripts/verify-settings.ts
 */
import { defaultSettingsPath, parseSettings, upsertEnvLine } from '../src/lib/server/settings_file';

function fail(msg: string): never { console.error(`FAIL: ${msg}`); process.exit(1); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) fail(msg); }

assert(defaultSettingsPath('/repo', undefined) === '/repo/.booth-settings.env', `dev default, got ${defaultSettingsPath('/repo', undefined)}`);
assert(defaultSettingsPath('/repo', '/data/settings.env') === '/data/settings.env', 'the desktop app’s path wins');
assert(!defaultSettingsPath('/repo', '').endsWith('/.env'), 'an empty override is not .env');

const text = '# a comment\n\nREKORDBOX_XML_PATH=/Users/x/rb.xml\n  BOOTH_LIBRARY_PATH = /Users/x/Music/Booth \nJUNK\nQUOTED="/a b/c"\n';
const parsed = parseSettings(text);
assert(JSON.stringify(parsed) === JSON.stringify([['REKORDBOX_XML_PATH', '/Users/x/rb.xml'], ['BOOTH_LIBRARY_PATH', '/Users/x/Music/Booth'], ['QUOTED', '/a b/c']]), `parsed, got ${JSON.stringify(parsed)}`);
assert(upsertEnvLine('A=1\n', 'B', '2') === 'A=1\nB=2\n' && upsertEnvLine('A=1\nB=2\n', 'B', '3') === 'A=1\nB=3\n', 'upsert');
// A replacement value containing "$&" must be written literally.
assert(upsertEnvLine('A=1\n', 'A', '/x/$&y') === 'A=/x/$&y\n', `literal $ in values, got ${upsertEnvLine('A=1\n', 'A', '/x/$&y')}`);
console.log('PASS verify-settings');
