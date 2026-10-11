/**
 * rekordbox analysis files (ANLZ0000.DAT / .EXT / .2EX): beat grid, waveforms,
 * cue lists, VBR seek index. Big-endian; a `PMAI` header followed by tagged
 * sections, each `fourcc, header length, total length`.
 *
 * rekordbox keeps one set per collection track under its own USBANLZ folder
 * in the same format a USB export uses, so an export can copy them. The one
 * section that has to change is PPTH, the audio file's path, which must name
 * the file's location on the stick.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const REKORDBOX_ANLZ_ROOT = join(homedir(), 'Library/Pioneer/rekordbox/share/PIONEER/USBANLZ');

export interface AnlzSection {
	tag: string;
	bytes: Uint8Array;
}

export function readSections(file: Uint8Array): { header: Uint8Array; sections: AnlzSection[] } {
	const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
	const magic = String.fromCharCode(...file.subarray(0, 4));
	if (magic !== 'PMAI') throw new Error('not an ANLZ file');
	const headerLen = v.getUint32(4);
	const sections: AnlzSection[] = [];
	for (let at = headerLen; at + 12 <= file.length; ) {
		const tag = String.fromCharCode(...file.subarray(at, at + 4));
		const len = v.getUint32(at + 8);
		if (len < 12 || at + len > file.length) throw new Error(`bad ${tag} section length`);
		sections.push({ tag, bytes: file.subarray(at, at + len) });
		at += len;
	}
	return { header: file.subarray(0, headerLen), sections };
}

export function pathSection(path: string): Uint8Array {
	// UTF-16BE with a terminating NUL, preceded by its byte length.
	const units = [...path].flatMap((c) => {
		const code = c.codePointAt(0)!;
		if (code < 0x10000) return [code];
		const s = code - 0x10000;
		return [0xd800 + (s >> 10), 0xdc00 + (s & 0x3ff)];
	});
	units.push(0);
	const out = new Uint8Array(16 + units.length * 2);
	const v = new DataView(out.buffer);
	out.set([0x50, 0x50, 0x54, 0x48]); // PPTH
	v.setUint32(4, 16);
	v.setUint32(8, out.length);
	v.setUint32(12, units.length * 2);
	units.forEach((u, k) => v.setUint16(16 + 2 * k, u));
	return out;
}

export function readPath(section: Uint8Array): string {
	const v = new DataView(section.buffer, section.byteOffset, section.byteLength);
	const n = v.getUint32(12);
	let s = '';
	for (let k = 0; k + 1 < n; k += 2) {
		const u = v.getUint16(16 + k);
		if (u === 0) break;
		s += String.fromCharCode(u);
	}
	return s;
}

/** Copies an analysis file with its PPTH replaced, fixing the file length in the header. */
export function withPath(file: Uint8Array, usbPath: string): Uint8Array {
	const { header, sections } = readSections(file);
	const parts = sections.map((s) => (s.tag === 'PPTH' ? pathSection(usbPath) : s.bytes));
	const total = header.length + parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	out.set(header);
	new DataView(out.buffer).setUint32(8, total);
	let at = header.length;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/**
 * Where a player looks for a track's analysis. Players ignore the database's
 * analyze_path and hash the audio file's path on the stick (over UTF-16 code
 * units) to find the folder themselves, so an export must put the files exactly
 * there. Algorithm recovered from the rekordbox binary by the fourfour project,
 * as implemented in baken (MIT); verified against Luke's own gig stick.
 */
export function anlzFolder(usbPath: string): string {
	let h = 0;
	for (let i = 0; i < usbPath.length; i++) {
		const c = usbPath.charCodeAt(i);
		h = (Math.imul(h, 0x5bc9) + c) >>> 0;
		h = (Math.imul(h, 0x93b5) + c) >>> 0;
	}
	const r = h % 200003;
	const p =
		(r & 1) |
		((r >> 1) & 2) |
		((r >> 4) & 4) |
		((r >> 4) & 8) |
		((r >> 5) & 0x10) |
		((r >> 8) & 0x20) |
		((r >> 10) & 0x40);
	const hex = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, '0');
	return `/PIONEER/USBANLZ/P${hex(p, 3)}/${hex(r, 8)}`;
}

/**
 * Two paths can hash to one folder (about n²/400000 pairs for n tracks). rekordbox
 * then numbers the files: ANLZ0000 for the first track, ANLZ0001 for the next.
 */
export class AnlzSlots {
	private taken = new Map<string, number>();
	assign(usbPath: string): { folder: string; stem: string } {
		const folder = anlzFolder(usbPath);
		const n = this.taken.get(folder) ?? 0;
		this.taken.set(folder, n + 1);
		return { folder, stem: `ANLZ${n.toString().padStart(4, '0')}` };
	}
}

export interface BeatGrid {
	beats: { beatInBar: number; tempoCenti: number; timeMs: number }[];
}

export function readBeatGrid(file: Uint8Array): BeatGrid | null {
	const pqtz = readSections(file).sections.find((s) => s.tag === 'PQTZ');
	if (!pqtz) return null;
	const v = new DataView(pqtz.bytes.buffer, pqtz.bytes.byteOffset, pqtz.bytes.byteLength);
	const n = v.getUint32(20);
	const beats = [];
	for (let k = 0; k < n; k++) {
		const at = 24 + 8 * k;
		beats.push({ beatInBar: v.getUint16(at), tempoCenti: v.getUint16(at + 2), timeMs: v.getUint32(at + 4) });
	}
	return { beats };
}

export interface LocalAnalysis {
	dir: string;
	/** What rekordbox recorded for the audio file — locally, just "?/" and the file name. */
	path: string;
	grid: BeatGrid | null;
}

/**
 * Indexes rekordbox's local analysis store by audio file name. rekordbox's
 * local copies record only the file name (the full path lives in its
 * encrypted database), so a name can map to several tracks; callers
 * disambiguate.
 */
export function indexLocalAnalysis(root = REKORDBOX_ANLZ_ROOT): Map<string, LocalAnalysis[]> {
	const byName = new Map<string, LocalAnalysis[]>();
	if (!existsSync(root)) return byName;
	for (const a of readdirSync(root)) {
		const da = join(root, a);
		if (!statSync(da).isDirectory()) continue;
		for (const b of readdirSync(da)) {
			const dir = join(da, b);
			const dat = join(dir, 'ANLZ0000.DAT');
			if (!existsSync(dat)) continue;
			try {
				const file = readFileSync(dat);
				const ppth = readSections(file).sections.find((s) => s.tag === 'PPTH');
				if (!ppth) continue;
				const path = readPath(ppth.bytes);
				const name = path.split('/').at(-1)!.normalize('NFC');
				const list = byName.get(name) ?? [];
				list.push({ dir, path, grid: readBeatGrid(file) });
				byName.set(name, list);
			} catch {
				// A half-written or foreign file; skip it.
			}
		}
	}
	return byName;
}
