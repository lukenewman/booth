/**
 * Reads cues from rekordbox's collection XML export (File → Export Collection
 * in xml format), keyed by the audio file's local path. rekordbox's own
 * database is encrypted; this export is its documented interchange format.
 *
 *   <TRACK ... Location="file://localhost/Users/…/x.mp3">
 *     <POSITION_MARK Name="" Type="0" Start="12.345" Num="0" Red="40" Green="226" Blue="20"/>
 *
 * Num is 0–7 for hot cues A–H and -1 for memory cues; Type 4 is a loop (with End).
 */
import { readFileSync } from 'node:fs';
import type { Cue } from './cues';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s: string) =>
	s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
		e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e] ?? m)
	);

function attrs(tag: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of tag.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = unescape(m[2]);
	return out;
}

function locationToPath(location: string): string | null {
	const m = /^file:\/\/(?:localhost)?(\/.*)$/.exec(location);
	if (!m) return null;
	try {
		return decodeURIComponent(m[1]).normalize('NFC');
	} catch {
		return null;
	}
}

/** Cues per local file path (NFC). Fade-in/out and load markers are skipped. */
export function readRekordboxCues(xmlPath: string): Map<string, Cue[]> {
	const xml = readFileSync(xmlPath, 'utf8');
	const byPath = new Map<string, Cue[]>();
	// Collection tracks have bodies; playlist entries are self-closing <TRACK Key="…"/>.
	for (const m of xml.matchAll(/<TRACK\s([^>]*[^/])>([\s\S]*?)<\/TRACK>/g)) {
		const t = attrs(m[1]);
		const path = t.Location && locationToPath(t.Location);
		if (!path) continue;
		const cues: Cue[] = [];
		for (const pm of m[2].matchAll(/<POSITION_MARK\s([^>]*)\/?>/g)) {
			const a = attrs(pm[1]);
			const type = Number(a.Type);
			if (type !== 0 && type !== 4) continue;
			const cue: Cue = { start: Number(a.Start), num: Number(a.Num ?? -1), name: a.Name ?? '' };
			if (type === 4 && a.End !== undefined) cue.end = Number(a.End);
			if (a.Red !== undefined && a.Green !== undefined && a.Blue !== undefined) cue.rgb = [Number(a.Red), Number(a.Green), Number(a.Blue)];
			cues.push(cue);
		}
		if (cues.length) byPath.set(path, cues);
	}
	return byPath;
}
