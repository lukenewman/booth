import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * POST → { path } picked in the desktop app's native Open dialog, or
 * { path: null } if cancelled. A web page can't learn a chosen file's path,
 * so outside the desktop app the setup screen asks for it typed instead.
 */
export const POST: RequestHandler = async () => {
  const bridge = globalThis.__boothDesktop;
  if (!bridge) return json({ error: 'not_desktop' }, { status: 404 });
  return json({ path: await bridge.chooseMusicLibrary() });
};
