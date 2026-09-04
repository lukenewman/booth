/**
 * Content-addressed identity for audio files.
 *
 * Hashes the *coded audio stream* and nothing else, so the fingerprint is
 * unchanged by tag writes, renames and moves — the operations that actually
 * happen to a music file, and the ones that broke every identity scheme this
 * library has used. Music.app persistent IDs shared zero overlap across the
 * 2025-08-25 machine move; file paths (what the date-added overlay had to
 * settle for) break silently on retag.
 *
 * `-c copy` rather than a decode: an order of magnitude faster across 50GB, and
 * the coded stream is what stays constant. The container and its tag blocks are
 * excluded by `-map 0:a`.
 */
import { FfmpegMissingError } from '../analysis/decode';

export class FingerprintError extends Error {
  constructor(
    readonly filePath: string,
    detail: string,
  ) {
    super(`could not fingerprint ${filePath}: ${detail}`);
    this.name = 'FingerprintError';
  }
}

export async function audioFingerprint(filePath: string): Promise<string> {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', filePath,
    '-map', '0:a',
    '-c', 'copy',
    '-f', 'md5',
    '-',
  ];

  let proc;
  try {
    proc = Bun.spawn(['ffmpeg', ...args], { stdout: 'pipe', stderr: 'pipe' });
  } catch {
    throw new FfmpegMissingError();
  }

  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new FingerprintError(filePath, err.trim().split('\n').slice(-2).join(' ') || `ffmpeg exited ${code}`);
  }

  const match = out.match(/MD5=([0-9a-f]{32})/);
  if (!match) throw new FingerprintError(filePath, `unexpected ffmpeg output: ${out.trim().slice(0, 80)}`);
  return match[1];
}
