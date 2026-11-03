import { isAbsolute, resolve, sep } from 'node:path';

/**
 * Where Booth's own folder may live. Booth's folder holds only files Booth
 * made, so it may not sit inside (or around) the music library, a folder
 * source or a backup; and while the current folder holds files, it stays put
 * (moving them is a later job).
 */
export class BoothFolderError extends Error {}

const overlaps = (a: string, b: string) => a === b || a.startsWith(b + sep) || b.startsWith(a + sep);

export function checkBoothFolder(
  path: string,
  opts: { current: { path: string; hasFiles: boolean }; forbidden: { path: string; why: string }[] },
): string {
  if (!isAbsolute(path)) throw new BoothFolderError('Give the folder’s full path.');
  const chosen = resolve(path).replace(/\/+$/, '');
  const current = resolve(opts.current.path).replace(/\/+$/, '');
  if (chosen === current) return chosen;
  if (opts.current.hasFiles) throw new BoothFolderError(`Booth’s folder already holds files at ${opts.current.path}. Moving them isn’t supported yet.`);
  for (const f of opts.forbidden) {
    if (overlaps(chosen, resolve(f.path).replace(/\/+$/, ''))) throw new BoothFolderError(`That folder overlaps ${f.why}. Pick a folder of its own.`);
  }
  return chosen;
}
