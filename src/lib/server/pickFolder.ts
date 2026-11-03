/**
 * The Mac's own folder chooser, opened by the server (it runs on the same Mac
 * as the browser). A browser's folder picker never reveals the real path, so
 * this is how a page gets one. The dialog opens in front of whichever app is
 * frontmost, so it lands over the browser rather than behind it.
 */
import { spawn } from 'node:child_process';

export class PickError extends Error {}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The chosen folder's path, or null when the chooser is cancelled. */
export function pickFolder(prompt: string, startIn?: string): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.reject(new PickError('The folder chooser only works on a Mac. Type the path instead.'));
  const where = startIn ? ` default location (POSIX file ${quote(startIn)})` : '';
  const script = [
    'set frontApp to path to frontmost application as text',
    `tell application frontApp to set chosen to choose folder with prompt ${quote(prompt)}${where}`,
    'return POSIX path of chosen',
  ];
  return new Promise((resolve, reject) => {
    const p = spawn('osascript', script.flatMap((l) => ['-e', l]));
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', () => reject(new PickError('Couldn’t open the folder chooser. Type the path instead.')));
    p.on('close', (code) => {
      if (code === 0) return resolve(out.trim().replace(/(.)\/$/, '$1'));
      // -128 is "User canceled."
      if (/-128/.test(err)) return resolve(null);
      reject(new PickError('Couldn’t open the folder chooser. Type the path instead.'));
    });
  });
}
