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

/** One beat-grid section: from `start` seconds the beat is `bpm`, `beat` (1–4) is that first beat's place in the bar. */
export interface GridSection {
	start: number;
	bpm: number;
	meter: string;
	beat: number;
}

/** One track of the collection export, as rekordbox knows it. Blank or zero values are null. */
export interface RekordboxTrack {
	trackId: string;
	/** Decoded from the file URL, not Unicode-normalised: match it against the file list with normalisation on both sides. */
	path: string;
	title: string | null;
	artist: string | null;
	bpm: number | null;
	key: string | null;
	grid: GridSection[];
	cues: Cue[];
	rating: number | null;
	playCount: number | null;
	dateAdded: string | null;
}

function decodedPath(location: string): string | null {
	const m = /^file:\/\/(?:localhost)?(\/.*)$/.exec(location);
	if (!m) return null;
	try {
		return decodeURIComponent(m[1]);
	} catch {
		return null;
	}
}

const positive = (s: string | undefined) => {
	const n = Number(s);
	return s !== undefined && s !== '' && Number.isFinite(n) && n > 0 ? n : null;
};
const text = (s: string | undefined) => (s && s.trim() ? s : null);

/** Every collection track with a local file. Playlist entries (self-closing `<TRACK Key=…/>`) are not tracks. */
export function readRekordboxCollection(xmlPath: string): RekordboxTrack[] {
	const xml = readFileSync(xmlPath, 'utf8');
	const out: RekordboxTrack[] = [];
	for (const m of xml.matchAll(/<TRACK\s([^>]*[^/])>([\s\S]*?)<\/TRACK>/g)) {
		const t = attrs(m[1]);
		const path = t.Location && decodedPath(t.Location);
		if (!path || !t.TrackID) continue;
		const grid: GridSection[] = [];
		for (const tm of m[2].matchAll(/<TEMPO\s([^>]*)\/?>/g)) {
			const a = attrs(tm[1]);
			const start = Number(a.Inizio);
			const bpm = Number(a.Bpm);
			if (!Number.isFinite(start) || !(bpm > 0)) continue;
			grid.push({ start, bpm, meter: a.Metro ?? '4/4', beat: Number(a.Battito ?? 1) });
		}
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
		out.push({
			trackId: t.TrackID,
			path,
			title: text(t.Name),
			artist: text(t.Artist),
			bpm: positive(t.AverageBpm),
			key: text(t.Tonality),
			grid,
			cues,
			rating: positive(t.Rating),
			playCount: positive(t.PlayCount),
			dateAdded: text(t.DateAdded),
		});
	}
	return out;
}
