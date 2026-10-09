import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** GET → { version } of a downloaded update waiting for a restart, or { version: null }. */
export const GET: RequestHandler = () => {
  const bridge = globalThis.__boothDesktop;
  if (!bridge) return json({ error: 'not_desktop' }, { status: 404 });
  return json({ version: bridge.pendingUpdate()?.version ?? null });
};

/** POST → install the pending update; the app quits and relaunches. */
export const POST: RequestHandler = () => {
  const bridge = globalThis.__boothDesktop;
  if (!bridge) return json({ error: 'not_desktop' }, { status: 404 });
  if (!bridge.pendingUpdate()) return json({ error: 'no_update' }, { status: 409 });
  bridge.restartToUpdate();
  return json({ ok: true });
};
