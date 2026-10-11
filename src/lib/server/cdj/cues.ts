/**
 * Hot cues and memory cues in the analysis files. rekordbox's local analysis
 * carries empty cue sections and fills them from its database at export time;
 * here they are filled from the rekordbox XML export's POSITION_MARK entries.
 *
 * Ported from baken's cues.rs (MIT), whose layouts were read off a real export
 * and are tested byte for byte there:
 *  - `.DAT`: PCOB hot (A–C), PCOB memory
 *  - `.EXT`: PCOB hot (D–H), PCOB memory (empty), PCO2 hot (all), PCO2 memory
 */
import { readSections } from './anlz';

export interface Cue {
	/** Seconds from the start of the track. */
	start: number;
	/** Loop end in seconds, for loops. */
	end?: number;
	/** 0–7 for hot cues A–H, -1 for memory cues. */
	num: number;
	name: string;
	rgb?: [number, number, number];
}

const HOT = 1;
const MEMORY = 0;
const NONE = 0xffffffff;
const DAT_HOT_CUES = 3;

const ms = (s: number) => Math.round(s * 1000);
const isLoop = (c: Cue) => c.end !== undefined && c.end > c.start;
const hotNumber = (c: Cue) => (c.num >= 0 ? c.num + 1 : 0);
const cueType = (c: Cue) => (isLoop(c) ? 2 : 1);
const loopMs = (c: Cue) => (isLoop(c) ? ms(c.end!) : NONE);

class Be {
	b: number[] = [];
	u8(v: number) {
		this.b.push(v & 0xff);
		return this;
	}
	u16(v: number) {
		return this.u8(v >> 8).u8(v);
	}
	u32(v: number) {
		return this.u16((v >>> 16) & 0xffff).u16(v & 0xffff);
	}
	raw(x: ArrayLike<number>) {
		for (let i = 0; i < x.length; i++) this.b.push(x[i]);
		return this;
	}
	tag(s: string) {
		return this.raw([...s].map((c) => c.charCodeAt(0)));
	}
}

function section(tag: string, headerLen: number, payload: number[]): Uint8Array {
	return Uint8Array.from(new Be().tag(tag).u32(headerLen).u32(12 + payload.length).raw(payload).b);
}

/** rekordbox writes each list in the reverse of the XML's order; hot cues past H are dropped. */
function split(cues: Cue[]): { hot: Cue[]; mem: Cue[] } {
	const kept = cues.filter((c) => c.num < 8);
	return { hot: kept.filter((c) => c.num >= 0).reverse(), mem: kept.filter((c) => c.num < 0).reverse() };
}

function pcob(list: number, cues: Cue[]): Uint8Array {
	const p = new Be()
		.u32(list)
		.u16(0)
		.u16(cues.length)
		.u32(list === MEMORY && cues.length ? cues.length - 1 : NONE);
	cues.forEach((c, i) => {
		const n = cues.length;
		const [prev, next] = list === HOT ? [0xffff, 0xffff] : [i === 0 ? 0xffff : i - 1, i + 1 === n ? 0xffff : i + 1];
		p.tag('PCPT').u32(0x1c).u32(0x38).u32(hotNumber(c)).u32(0).u32(0x00010000);
		p.u16(prev).u16(next).u8(cueType(c)).raw([0x00, 0x03, 0xe8]).u32(ms(c.start)).u32(loopMs(c));
		p.raw(new Array(16).fill(0));
	});
	return section('PCOB', 0x18, p.b);
}

/** The 16 hot cue colours: (code, colour the XML gives, colour bytes the player uses). */
const HOT_CUE_COLOURS: [number, [number, number, number], [number, number, number]][] = [
	[0x01, [48, 90, 255], [0x00, 0x00, 0xff]],
	[0x05, [80, 180, 255], [0x00, 0x70, 0xff]],
	[0x09, [0, 224, 255], [0x00, 0xe0, 0xff]],
	[0x0e, [31, 163, 146], [0x00, 0xff, 0xa3]],
	[0x12, [16, 177, 118], [0x00, 0xff, 0x47]],
	[0x16, [40, 226, 20], [0x1a, 0xff, 0x00]],
	[0x1a, [165, 225, 22], [0x80, 0xff, 0x00]],
	[0x1e, [180, 190, 4], [0xe6, 0xff, 0x00]],
	[0x20, [195, 175, 4], [0xff, 0xe8, 0x00]],
	[0x26, [224, 100, 27], [0xff, 0x5e, 0x00]],
	[0x2a, [230, 40, 40], [0xff, 0x00, 0x00]],
	[0x2d, [255, 18, 123], [0xff, 0x00, 0x45]],
	[0x31, [222, 68, 207], [0xff, 0x00, 0xa1]],
	[0x38, [180, 50, 255], [0xb3, 0x00, 0xff]],
	[0x3c, [170, 114, 255], [0x4d, 0x00, 0xff]],
	[0x3e, [100, 115, 255], [0x1a, 0x00, 0xff]]
];
/** Green and "no colour" both go out as code 0 with green bytes, as rekordbox writes them. */
const NO_COLOUR = [0, 0x1a, 0xff, 0x00];

function hotColour(c: Cue): number[] {
	if (!c.rgb) return NO_COLOUR;
	const [r, g, b] = c.rgb;
	const d = ([pr, pg, pb]: [number, number, number]) => (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
	const [code, , bytes] = HOT_CUE_COLOURS.reduce((best, x) => (d(x[1]) < d(best[1]) ? x : best));
	return code === 0x16 ? NO_COLOUR : [code, ...bytes];
}

function loopFraction(c: Cue, bpm: number): [number, number] {
	if (!isLoop(c) || bpm <= 0) return [0, 0];
	const beats = ((c.end! - c.start) * bpm) / 60;
	const rounded = Math.round(beats);
	return rounded >= 1 && Math.abs(beats - rounded) < 0.02 ? [rounded, 1] : [0, 0];
}

function pco2(list: number, cues: Cue[], bpm: number): Uint8Array {
	const p = new Be().u32(list).u16(cues.length).u16(0);
	for (const c of cues) {
		const comment: number[] = [];
		if (c.name) {
			for (let i = 0; i < c.name.length; i++) comment.push(c.name.charCodeAt(i) >> 8, c.name.charCodeAt(i) & 0xff);
			comment.push(0, 0);
		}
		const len = 0x2c + comment.length + 4 + 40;
		const e = new Be().tag('PCP2').u32(0x10).u32(len).u32(hotNumber(c)).u8(cueType(c)).raw([0x00, 0x03, 0xe8]);
		e.u32(ms(c.start)).u32(loopMs(c)).u8(0).raw([0x01, 0, 0, 0, 0, 0, 0]);
		const [num, den] = loopFraction(c, bpm);
		e.u16(num).u16(den).u32(comment.length).raw(comment).raw(list === HOT ? hotColour(c) : [0, 0, 0, 0]);
		while (e.b.length < len) e.u8(0);
		p.raw(e.b);
	}
	return section('PCO2', 0x14, p.b);
}

export function cueSections(kind: 'DAT' | 'EXT', cues: Cue[], bpm: number): Uint8Array[] {
	const { hot, mem } = split(cues);
	const datHot = hot.filter((c) => c.num < DAT_HOT_CUES);
	const extHot = hot.filter((c) => c.num >= DAT_HOT_CUES);
	return kind === 'DAT'
		? [pcob(HOT, datHot), pcob(MEMORY, mem)]
		: [pcob(HOT, extHot), pcob(MEMORY, []), pco2(HOT, hot, bpm), pco2(MEMORY, mem, bpm)];
}

/** Replaces an analysis file's cue sections, keeping rekordbox's section order. */
export function withCues(file: Uint8Array, kind: 'DAT' | 'EXT', cues: Cue[], bpm: number): Uint8Array {
	const { header, sections } = readSections(file);
	const fresh = cueSections(kind, cues, bpm);
	const parts = sections.map((s) => (s.tag === 'PCOB' || s.tag === 'PCO2' ? (fresh.shift() ?? s.bytes) : s.bytes));
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
