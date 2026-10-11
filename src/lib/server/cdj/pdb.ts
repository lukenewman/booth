/**
 * Writer for the DeviceSQL database (`export.pdb`, `exportExt.pdb`) that
 * rekordbox puts on a USB stick for Pioneer players.
 *
 * Layout follows Deep Symmetry's reverse-engineered spec (crate-digger's
 * rekordbox_pdb.ksy) and rekordcrate's round-trip model. Where a field's
 * meaning is unknown, the value is the one rekordbox itself writes into a
 * freshly created export — the aim is to look like a clean rekordbox export,
 * not merely to parse.
 */

export const PAGE_SIZE = 4096;
const PAGE_HEADER = 0x28; // page header + data-page header; the heap starts here
const HEAP_SIZE = PAGE_SIZE - PAGE_HEADER;
const ROW_GROUP_BYTES = 0x24; // 16 offsets + presence flags + transaction flags

/** Table types in `export.pdb`, in the order rekordbox lists them. */
export const Table = {
	tracks: 0,
	genres: 1,
	artists: 2,
	albums: 3,
	labels: 4,
	keys: 5,
	colors: 6,
	playlistTree: 7,
	playlistEntries: 8,
	unknown9: 9,
	unknown10: 10,
	historyPlaylists: 11,
	historyEntries: 12,
	artwork: 13,
	unknown14: 14,
	unknown15: 15,
	columns: 16,
	menu: 17,
	unknown18: 18,
	history: 19
} as const;

// ---------------------------------------------------------------------------
// Byte helpers

class Bytes {
	private buf: number[] = [];
	get length() {
		return this.buf.length;
	}
	u8(v: number) {
		this.buf.push(v & 0xff);
		return this;
	}
	u16(v: number) {
		return this.u8(v).u8(v >> 8);
	}
	u32(v: number) {
		return this.u16(v & 0xffff).u16(v >>> 16);
	}
	raw(b: Uint8Array | number[]) {
		for (const x of b) this.buf.push(x);
		return this;
	}
	padTo(n: number) {
		while (this.buf.length % n) this.buf.push(0);
		return this;
	}
	setU8(at: number, v: number) {
		this.buf[at] = v & 0xff;
	}
	setU16(at: number, v: number) {
		this.buf[at] = v & 0xff;
		this.buf[at + 1] = (v >> 8) & 0xff;
	}
	done() {
		return Uint8Array.from(this.buf);
	}
}

export function hex(s: string): Uint8Array {
	return Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));
}

// ---------------------------------------------------------------------------
// DeviceSQL strings

/** Encodes a string the way rekordbox does: short ASCII when it fits, else long ASCII or UTF-16LE. */
export function deviceString(s: string): { bytes: Uint8Array; align: number } {
	const ascii = /^[\x00-\x7f]*$/.test(s);
	if (ascii && s.length <= 126) {
		const b = new Bytes().u8(((s.length + 1) << 1) | 1);
		for (const c of s) b.u8(c.charCodeAt(0));
		return { bytes: b.done(), align: 1 };
	}
	if (ascii) {
		const b = new Bytes().u8(0x40).u16(s.length + 4).u8(0);
		for (const c of s) b.u8(c.charCodeAt(0));
		return { bytes: b.done(), align: 1 };
	}
	const units: number[] = [];
	for (let i = 0; i < s.length; i++) units.push(s.charCodeAt(i));
	const b = new Bytes().u8(0x90).u16(units.length * 2 + 4).u8(0);
	for (const u of units) b.u16(u);
	// UTF-16 bodies sit on a 4-byte boundary within the row.
	return { bytes: b.done(), align: 4 };
}

/** Appends strings after a fixed row header, returning each one's offset from the row start. */
function appendStrings(row: Bytes, strings: string[]): number[] {
	return strings.map((s) => {
		const { bytes, align } = deviceString(s);
		row.padTo(align);
		const at = row.length;
		row.raw(bytes);
		return at;
	});
}

// ---------------------------------------------------------------------------
// Rows. Each builder takes the row's index within its page, because several
// row types carry `index_shift` = 0x20 × that index.

export type RowBuilder = (indexInPage: number) => Uint8Array;

export interface TrackRow {
	id: number;
	title: string;
	artistId: number;
	albumId: number;
	genreId: number;
	labelId: number;
	keyId: number;
	artworkId: number;
	sampleRate: number;
	sampleDepth: number;
	bitrate: number;
	fileSize: number;
	fileType: number;
	durationSec: number;
	tempoCenti: number;
	trackNumber: number;
	discNumber: number;
	year: number;
	rating: number;
	colorId: number;
	dateAdded: string;
	analyzePath: string;
	analyzeDate: string;
	comment: string;
	mixName: string;
	releaseDate: string;
	filename: string;
	filePath: string;
}

/** Audio file type codes used in the track row. */
export const FileType = { mp3: 1, m4a: 4, flac: 5, wav: 11, aiff: 12 } as const;

export function trackRow(t: TrackRow): RowBuilder {
	return (i) => {
		const r = new Bytes()
			.u16(0x24) // subtype: 16-bit string offsets
			.u16(0x20 * i)
			.u32(0x000c0700) // "bitmask", constant in every export seen
			.u32(t.sampleRate)
			.u32(0) // composer
			.u32(t.fileSize)
			.u32((t.id * 2654435761) >>> 0) // unknown, effectively random in real exports
			.u16(0xfa80) // unknown, constant within a database
			.u16(0x05e7) // unknown, constant within a database
			.u32(t.artworkId)
			.u32(t.keyId)
			.u32(0) // original artist
			.u32(t.labelId)
			.u32(0) // remixer
			.u32(t.bitrate)
			.u32(t.trackNumber)
			.u32(t.tempoCenti)
			.u32(t.genreId)
			.u32(t.albumId)
			.u32(t.artistId)
			.u32(t.id)
			.u16(t.discNumber)
			.u16(0) // play count
			.u16(t.year)
			.u16(t.sampleDepth)
			.u16(t.durationSec)
			.u16(0x29) // unknown, always 0x29
			.u8(t.colorId)
			.u8(t.rating)
			.u16(t.fileType)
			.u16(0x0003); // offset-array marker
		const offsetsAt = r.length;
		for (let k = 0; k < 21; k++) r.u16(0);
		const offsets = appendStrings(r, [
			'', // isrc
			'', // lyricist
			'3', // unknown, a small counter in real exports
			'3', // unknown, a small counter in real exports
			'',
			'', // message
			'', // publish track information
			'ON', // autoload hot cues
			'',
			'',
			t.dateAdded,
			t.releaseDate,
			t.mixName,
			'',
			t.analyzePath,
			t.analyzeDate,
			t.comment,
			t.title,
			'',
			t.filename,
			t.filePath
		]);
		offsets.forEach((o, k) => r.setU16(offsetsAt + 2 * k, o));
		return r.padTo(4).done();
	};
}

/** Artist row: name at an 8-bit offset (subtype 0x60). */
export function artistRow(id: number, name: string): RowBuilder {
	return (i) => {
		const r = new Bytes().u16(0x60).u16(0x20 * i).u32(id).u8(0x03).u8(0);
		const [at] = appendStrings(r, [name]);
		r.setU8(9, at);
		return r.padTo(4).done();
	};
}

/** Album row: name at an 8-bit offset (subtype 0x80). */
export function albumRow(id: number, artistId: number, name: string): RowBuilder {
	return (i) => {
		const r = new Bytes()
			.u16(0x80)
			.u16(0x20 * i)
			.u32(0)
			.u32(artistId)
			.u32(id)
			.u32(0)
			.u8(0x03)
			.u8(0);
		const [at] = appendStrings(r, [name]);
		r.setU8(21, at);
		return r.padTo(4).done();
	};
}

/** Genre and label rows share one shape: id, then the name. */
export function namedRow(id: number, name: string): RowBuilder {
	return () => new Bytes().u32(id).raw(deviceString(name).bytes).padTo(4).done();
}

/** Artwork row: id, then the path of the small thumbnail (`/PIONEER/Artwork/00001/a1.jpg`). */
export function artworkRow(id: number, path: string): RowBuilder {
	return () => new Bytes().u32(id).raw(deviceString(path).bytes).padTo(4).done();
}

export function keyRow(id: number, name: string): RowBuilder {
	return () => new Bytes().u32(id).u32(id).raw(deviceString(name).bytes).padTo(4).done();
}

export function playlistTreeRow(p: {
	id: number;
	parentId: number;
	sortOrder: number;
	isFolder: boolean;
	name: string;
}): RowBuilder {
	return () =>
		new Bytes()
			.u32(p.parentId)
			.u32(0)
			.u32(p.sortOrder)
			.u32(p.id)
			.u32(p.isFolder ? 1 : 0)
			.raw(deviceString(p.name).bytes)
			.padTo(4)
			.done();
}

/** `entryIndex` is 1-based, as rekordbox writes it. */
export function playlistEntryRow(entryIndex: number, trackId: number, playlistId: number): RowBuilder {
	return () => new Bytes().u32(entryIndex).u32(trackId).u32(playlistId).done();
}

export function rawRow(bytes: Uint8Array): RowBuilder {
	return () => bytes;
}

// ---------------------------------------------------------------------------
// Pages and the file

interface PageImage {
	index: number;
	bytes: Uint8Array;
}

function indexPage(index: number, type: number, nextPage: number, firstData: number | null): Uint8Array {
	const p = new Uint8Array(PAGE_SIZE);
	const v = new DataView(p.buffer);
	v.setUint32(4, index, true);
	v.setUint32(8, type, true);
	v.setUint32(12, nextPage, true);
	v.setUint32(16, 1, true);
	p[0x1b] = 0x64;
	v.setUint16(0x20, 0x1fff, true);
	v.setUint16(0x22, 0x1fff, true);
	v.setUint16(0x24, 0x03ec, true);
	v.setUint16(0x26, 0, true);
	v.setUint32(0x28, index, true);
	v.setUint32(0x2c, firstData ?? 0x03ffffff, true);
	v.setUint32(0x30, 0x03ffffff, true);
	v.setUint32(0x34, 0, true);
	v.setUint16(0x38, 0, true);
	v.setUint16(0x3a, 0x1fff, true);
	for (let at = 0x3c; at < PAGE_SIZE - 20; at += 4) v.setUint32(at, 0x1ffffff8, true);
	return p;
}

function indexBytes(rows: number) {
	return Math.ceil(rows / 16) * 4 + rows * 2;
}

/** Packs row builders into as few data pages as fit, returning each page's rows. */
function packRows(rows: RowBuilder[]): Uint8Array[][] {
	const pages: Uint8Array[][] = [];
	let current: Uint8Array[] = [];
	let used = 0;
	for (const build of rows) {
		let bytes = build(current.length);
		if (current.length > 0 && used + bytes.length + indexBytes(current.length + 1) > HEAP_SIZE) {
			pages.push(current);
			current = [];
			used = 0;
			bytes = build(0);
		}
		if (bytes.length + indexBytes(1) > HEAP_SIZE) throw new Error('row larger than a page');
		current.push(bytes);
		used += bytes.length;
	}
	if (current.length) pages.push(current);
	return pages;
}

function dataPage(index: number, type: number, nextPage: number, rows: Uint8Array[]): Uint8Array {
	const p = new Uint8Array(PAGE_SIZE);
	const v = new DataView(p.buffer);
	let used = 0;
	const offsets: number[] = [];
	for (const r of rows) {
		offsets.push(used);
		p.set(r, PAGE_HEADER + used);
		used += r.length;
	}
	const n = rows.length;
	v.setUint32(4, index, true);
	v.setUint32(8, type, true);
	v.setUint32(12, nextPage, true);
	v.setUint32(16, 1, true);
	const packed = (n & 0x1fff) | ((n & 0x7ff) << 13);
	p[0x18] = packed & 0xff;
	p[0x19] = (packed >> 8) & 0xff;
	p[0x1a] = (packed >> 16) & 0xff;
	p[0x1b] = 0x24;
	v.setUint16(0x1c, HEAP_SIZE - used - indexBytes(n), true);
	v.setUint16(0x1e, used, true);
	// A fresh export records every row as touched by one transaction.
	v.setUint16(0x20, n, true);
	v.setUint16(0x22, 0, true);
	for (let g = 0; g * 16 < n; g++) {
		const base = PAGE_SIZE - g * ROW_GROUP_BYTES;
		const inGroup = Math.min(16, n - g * 16);
		const flags = inGroup === 16 ? 0xffff : (1 << inGroup) - 1;
		v.setUint16(base - 4, flags, true);
		v.setUint16(base - 2, flags, true);
		for (let s = 0; s < inGroup; s++) v.setUint16(base - 6 - 2 * s, offsets[g * 16 + s], true);
	}
	return p;
}

/**
 * Builds a whole database. `tables` lists every table type in header order,
 * each with its rows (possibly none — players expect all tables to exist).
 */
export function buildDatabase(tables: { type: number; rows: RowBuilder[] }[]): Uint8Array {
	const pages: PageImage[] = [];
	let nextIndex = 1;
	const plan = tables.map((t) => {
		const packed = packRows(t.rows);
		const idx = nextIndex++;
		const data = packed.map(() => nextIndex++);
		return { ...t, packed, idx, data };
	});
	// Each table's "empty candidate" — the page it would grow into next — sits past the end.
	const emptyCandidates = plan.map((_, k) => nextIndex + k);
	const nextUnused = nextIndex + plan.length;

	const header = new Uint8Array(PAGE_SIZE);
	const hv = new DataView(header.buffer);
	hv.setUint32(4, PAGE_SIZE, true);
	hv.setUint32(8, tables.length, true);
	hv.setUint32(12, nextUnused, true);
	hv.setUint32(16, 5, true);
	hv.setUint32(20, 2, true);
	pages.push({ index: 0, bytes: header });

	plan.forEach((t, k) => {
		const ec = emptyCandidates[k];
		const first = t.data[0] ?? null;
		pages.push({ index: t.idx, bytes: indexPage(t.idx, t.type, first ?? ec, first) });
		t.packed.forEach((rows, j) => {
			const next = t.data[j + 1] ?? ec;
			pages.push({ index: t.data[j], bytes: dataPage(t.data[j], t.type, next, rows) });
		});
		const at = 28 + 16 * k;
		hv.setUint32(at, t.type, true);
		hv.setUint32(at + 4, ec, true);
		hv.setUint32(at + 8, t.idx, true);
		hv.setUint32(at + 12, t.data.at(-1) ?? t.idx, true);
	});

	const out = new Uint8Array(nextIndex * PAGE_SIZE);
	for (const p of pages) out.set(p.bytes, p.index * PAGE_SIZE);
	return out;
}

// ---------------------------------------------------------------------------
// Fixed content. These rows are identical in every fresh rekordbox export:
// the colour palette, the browse-menu column titles and layout, and a history
// sync stub. Captured from an empty rekordbox export.

export const STATIC_ROWS: Partial<Record<number, string[]>> = {
	[Table.colors]: [
		'00000000010100000b50696e6b000000',
		'000000000202000009526564',
		'00000000030300000f4f72616e676500',
		'00000000040400000f59656c6c6f7700',
		'00000000050500000d477265656e0000',
		'00000000060600000b41717561000000',
		'00000000070700000b426c7565000000',
		'00000000080800000f507572706c6500'
	],
	[Table.columns]: [
		'0100800090120000faff470045004e0052004500fbff0000',
		'0200810090140000faff410052005400490053005400fbff',
		'0300820090120000faff41004c00420055004d00fbff0000',
		'0400830090120000faff54005200410043004b00fbff0000',
		'05008500900e0000faff420050004d00fbff0000',
		'0600860090140000faff52004100540049004e004700fbff',
		'0700870090100000faff5900450041005200fbff',
		'0800880090160000faff520045004d004900580045005200fbff0000',
		'0900890090120000faff4c004100420045004c00fbff0000',
		'0a008a0090260000faff4f0052004900470049004e0041004c002000410052005400490053005400fbff0000',
		'0b008b00900e0000faff4b0045005900fbff0000',
		'0c008d00900e0000faff430055004500fbff0000',
		'0d008e0090120000faff43004f004c004f005200fbff0000',
		'0e00920090100000faff540049004d004500fbff',
		'0f00930090160000faff4200490054005200410054004500fbff0000',
		'10009400901a0000faff460049004c00450020004e0041004d004500fbff0000',
		'1100840090180000faff50004c00410059004c00490053005400fbff',
		'1200980090200000faff48004f00540020004300550045002000420041004e004b00fbff',
		'1300950090160000faff48004900530054004f0052005900fbff0000',
		'1400910090140000faff530045004100520043004800fbff',
		'1500960090180000faff43004f004d004d0045004e0054005300fbff',
		'16008c00901c0000faff4400410054004500200041004400440045004400fbff',
		'1700970090220000faff44004a00200050004c0041005900200043004f0055004e005400fbff0000',
		'1800900090140000faff46004f004c00440045005200fbff',
		'1900a10090160000faff440045004600410055004c005400fbff0000',
		'1a00a20090180000faff41004c00500048004100420045005400fbff',
		'1b00aa0090180000faff4d00410054004300480049004e004700fbff'
	],
	[Table.menu]: [
		'0100010063010000',
		'0500060005010000',
		'0600070063010000',
		'0700080063010000',
		'0800090063010000',
		'09000a0063010000',
		'0a000b0063010000',
		'0d000f0063010000',
		'0e00130004010000',
		'0f00140006010000',
		'1000150063010000',
		'1200170063010000',
		'0200020002000100',
		'0300030003000200',
		'0400040001000300',
		'0b000c0063000400',
		'1100050063000500',
		'1300160063000600',
		'1400120063000700',
		'1b001a0063020800',
		'1800110063000900',
		'16001b0063000a00'
	],
	[Table.unknown18]: [
		'0100060001000000',
		'1500070001000000',
		'0e00080001000000',
		'0800090001000000',
		'09000a0001000000',
		'0a000b0001000000',
		'0f000d0001000000',
		'0d000f0001000000',
		'1700100001000000',
		'1600110001000000',
		'1900000000010000',
		'1a00010000020000',
		'0200020000030000',
		'0300030000040000',
		'0500040000050000',
		'0600050000060000',
		'0b000c0000070000'
	],
	[Table.history]: ['80020000000000000000000017323032322d30322d3032191e0b3130303003000000000000000000']
};

/** `exportExt.pdb` from an empty rekordbox export: My Tag categories and defaults, no tagged tracks. */
export const EXPORT_EXT_TABLES: { type: number; rows: string[] }[] = [
	{ type: 0, rows: [] },
	{ type: 1, rows: [] },
	{ type: 2, rows: [] },
	{
		type: 3,
		rows: [
			'80060000000000000000000000000000000000000100000000000001031f250d47656e72650300000000000000000000',
			'8006200000000000000000000100000000000000c26ee78100000000031f2a174163696420486f75736503000000000000000000',
			'80064000000000000000000001000000010000007a8f9e1500000000031f2a174465657020486f75736503000000000000000000',
			'80066000000000000000000001000000020000008468d8fd00000000031f260f546563686e6f03000000000000000000',
			'800680000000000000000000010000000300000016a268bf00000000031f28134e7520446973636f030000000000000000000000',
			'8006a00000000000000000000100000004000000d8a9846d00000000031f2d1d456c656374726f20486f7573650300000000000000000000',
			'8006c00000000000000000000100000005000000a005a58900000000031f2a1742617373204d7573696303000000000000000000',
			'8006e0000000000000000000010000000600000034f8f58500000000031f240b54726170030000000000000000000000',
			'80060001000000000000000000000000010000000200000000000001031f2a17436f6d706f6e656e747303000000000000000000',
			'80062001000000000000000002000000000000003ae610f100000000031f250d53796e74680300000000000000000000',
			'8006400100000000000000000200000001000000b8940b0a00000000031f250d566f63616c0300000000000000000000',
			'80066001000000000000000002000000020000002e25232700000000031f240b42656174030000000000000000000000',
			'800680010000000000000000020000000300000044e7023a00000000031f28135375622042617373030000000000000000000000',
			'8006a00100000000000000000200000004000000fd0b382b00000000031f2a1750657263757373696f6e03000000000000000000',
			'8006c001000000000000000002000000050000006b204aa300000000031f250d5069616e6f0300000000000000000000',
			'8006e0010000000000000000020000000600000024225b9900000000031f240b4461726b030000000000000000000000',
			'8006000200000000000000000200000007000000e1f2d2d200000000031f250d55707065720300000000000000000000',
			'80062002000000000000000000000000020000000300000000000001031f2915536974756174696f6e0300000000000000000000',
			'80064002000000000000000003000000000000003d2c7fce00000000031f2a174d61696e20466c6f6f7203000000000000000000',
			'80066002000000000000000003000000010000007ff092e000000000031f2c1b5365636f6e6420466c6f6f72030000000000000000000000',
			'80068002000000000000000003000000020000005b80337300000000031f260f4c6f756e676503000000000000000000',
			'8006a00200000000000000000300000003000000033ed68100000000031f29154d6964204e696768740300000000000000000000',
			'8006c002000000000000000003000000040000009d0a812400000000031f27114d6f726e696e67030000000000000000',
			'8006e0020000000000000000030000000500000091d208be00000000031f28134275696c64207570030000000000000000000000',
			'8006000300000000000000000300000006000000aaafee6700000000031f29155065616b2054696d650300000000000000000000',
			'80062003000000000000000003000000070000009d6f0e0000000000031f2a174275696c6420646f776e03000000000000000000',
			'80064003000000000000000000000000030000000400000000000001031f2f21556e7469746c656420436f6c756d6e030000000000000000',
			'80066003000000000000000004000000000000006ca7d42900000000031f2a174d7920436f6d6d656e7403000000000000000000'
		]
	},
	{ type: 4, rows: [] },
	{ type: 5, rows: [] },
	{ type: 6, rows: [] },
	{
		type: 7,
		rows: [
			'00070000000000000000000000000000000000000000000081fae7050322232425260303030303000000000000000000000000000000000000000000'
		]
	},
	{ type: 8, rows: [] }
];
