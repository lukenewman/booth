/**
 * Album art on the stick: two thumbnails per image, made the way rekordbox
 * makes them — 80 and 240 pixels square, the picture scaled to fit and centred
 * on black, baseline JPEG. Layout and sizes from baken (MIT), which measured
 * them on 1,091 of rekordbox's own thumbnails.
 */
import { spawnSync } from 'node:child_process';

export const SMALL = 80;
export const MEDIUM = 240;

/**
 * `/PIONEER/Artwork/00001/a1.jpg`. Folders are numbered `id / 20 + 1`, so ids
 * 1–19 share 00001 and every later folder holds twenty. export.pdb names the
 * small `a` file; `_m` is the medium one beside it.
 */
export function artworkPath(id: number, medium: boolean): string {
	const folder = String(Math.floor(id / 20) + 1).padStart(5, '0');
	return `/PIONEER/Artwork/${folder}/a${id}${medium ? '_m' : ''}.jpg`;
}

/** The picture embedded in an audio file as one square thumbnail, or null when it has none. */
function thumbnail(audioPath: string, side: number): Buffer | null {
	const fit = `scale=${side}:${side}:force_original_aspect_ratio=decrease:flags=lanczos`;
	const pad = `pad=${side}:${side}:(ow-iw)/2:(oh-ih)/2:black`;
	const r = spawnSync(
		'ffmpeg',
		['-v', 'error', '-i', audioPath, '-an', '-map', '0:v:0', '-frames:v', '1', '-vf', `${fit},${pad},format=yuvj420p`, '-q:v', '3', '-map_metadata', '-1', '-f', 'mjpeg', 'pipe:1'],
		{ maxBuffer: 16 * 1024 * 1024 }
	);
	return r.status === 0 && r.stdout.length > 0 ? r.stdout : null;
}

export function thumbnailsFor(audioPath: string): { small: Buffer; medium: Buffer } | null {
	const small = thumbnail(audioPath, SMALL);
	const medium = small && thumbnail(audioPath, MEDIUM);
	return small && medium ? { small, medium } : null;
}
