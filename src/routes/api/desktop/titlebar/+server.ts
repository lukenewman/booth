import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** POST → the title bar was double-clicked; zoom or minimize like a native one. */
export const POST: RequestHandler = () => {
  const bridge = globalThis.__boothDesktop;
  if (!bridge) return json({ error: 'not_desktop' }, { status: 404 });
  bridge.titlebarDoubleClick();
  return json({ ok: true });
};
