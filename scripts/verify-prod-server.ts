/**
 * verify-prod-server.ts — the production build boots under Bun and reaches the DB.
 *
 * Booth's DB layer is `bun:sqlite`, so the built server has to run on Bun, not
 * Node. /api/sources calls getDb(), so a 200 from it proves the built bundle
 * resolved bun:sqlite, opened the database, and ran migrations.
 *
 * Run: bun run build && bun verify scripts/verify-prod-server.ts
 */
const BUILD = './build/index.js';
const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n    expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

if (!(await Bun.file(BUILD).exists())) {
  console.error(`✗ ${BUILD} not found — run \`bun run build\` first`);
  process.exit(1);
}

const proc = Bun.spawn(['bun', BUILD], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
  stdout: 'pipe',
  stderr: 'pipe',
});

/** Poll until the server answers, it dies, or we give up. */
async function waitForServer(timeoutMs = 20_000): Promise<Response | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return null; // server exited instead of listening
    try {
      return await fetch(`${BASE}/api/sources`);
    } catch {
      await Bun.sleep(250);
    }
  }
  return null;
}

try {
  const res = await waitForServer();
  check('server answers /api/sources', res?.status ?? 'no response', 200);

  if (res?.status === 200) {
    const body = (await res.json()) as Array<{ id: string }>;
    check('body is an array', Array.isArray(body), true);
    check('discogs source present (registry + DB reached)', Array.isArray(body) && body.some((s) => s.id === 'discogs'), true);
  }
} finally {
  proc.kill();
  if (failures > 0) {
    const stderr = await new Response(proc.stderr).text();
    if (stderr.trim()) console.error(`\n--- server stderr ---\n${stderr}`);
  }
}

console.log(failures === 0 ? '\nOK: production build boots under Bun and reaches the DB' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
