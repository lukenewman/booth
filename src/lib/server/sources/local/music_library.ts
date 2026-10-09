import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Finding and vetting the Apple Music library export before booth saves its
 * path. Kept apart from the sync so the setup screen can say what is wrong
 * (no file, macOS blocking the Music folder, the wrong file) in plain terms.
 */

/**
 * Where Music writes the export when "Share iTunes Library XML with other
 * applications" is on, then where iTunes wrote it. Not `~/Music/Library.xml`:
 * that name is only ever a hand-made File → Export copy, which never updates.
 */
export function defaultMusicXmlPaths(): string[] {
  const music = join(homedir(), 'Music');
  return [join(music, 'Music', 'Library.xml'), join(music, 'iTunes', 'iTunes Library.xml')];
}

export type MusicXmlProblem = 'missing' | 'no_permission' | 'not_a_library';

export type MusicXmlCheck =
  | { ok: true; path: string; trackCount: number; modifiedAt: string }
  | { ok: false; path: string; problem: MusicXmlProblem };

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

export function tildePath(path: string): string {
  const home = homedir();
  return path.startsWith(home + '/') ? `~${path.slice(home.length)}` : path;
}

/**
 * Read the file and confirm it is a Music library export. Reading is what
 * makes macOS ask about the Music folder, so only call this from something
 * the person clicked. A text check rather than a full plist parse: the sync
 * parses it properly moments later, and this keeps the click responsive.
 */
export function checkMusicXml(path: string): MusicXmlCheck {
  let text: string;
  let modifiedAt: string;
  try {
    modifiedAt = statSync(path).mtime.toISOString();
    text = readFileSync(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, path, problem: 'missing' };
    // EPERM is macOS privacy protection (the Music folder); EACCES is plain
    // file permissions. Either way the fix is to grant access.
    if (code === 'EPERM' || code === 'EACCES') return { ok: false, path, problem: 'no_permission' };
    return { ok: false, path, problem: 'not_a_library' };
  }
  if (!text.includes('<plist') || !text.includes('<key>Tracks</key>')) {
    return { ok: false, path, problem: 'not_a_library' };
  }
  const trackCount = text.split('<key>Track ID</key>').length - 1;
  return { ok: true, path, trackCount, modifiedAt };
}

/**
 * Check the standard locations in order. The first one that exists decides
 * the answer, so a blocked Music folder reports as blocked, not as missing.
 */
export function findMusicXml(): MusicXmlCheck {
  const paths = defaultMusicXmlPaths();
  for (const path of paths) {
    const check = checkMusicXml(path);
    if (check.ok || check.problem !== 'missing') return check;
  }
  return { ok: false, path: paths[0]!, problem: 'missing' };
}
