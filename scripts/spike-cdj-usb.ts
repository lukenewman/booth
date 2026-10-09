/**
 * Spike: write a booth playlist to a folder laid out like a rekordbox USB
 * export — audio under /Contents, the DeviceSQL database, and per-track
 * analysis copied from rekordbox's local store with its path rewritten.
 *
 *   bun scripts/spike-cdj-usb.ts --playlist "STEREO OCTOBER" --out /path/to/usb-root
 *
 * Reads the booth database read-only. Tracks without a local file, or that
 * rekordbox has not analysed, are skipped and listed.
 */
import { Database } from 'bun:sqlite';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { indexLocalAnalysis, withPath, type LocalAnalysis } from '../src/lib/server/cdj/anlz';
import {
	EXPORT_EXT_TABLES,
	FileType,
	STATIC_ROWS,
	Table,
	albumRow,
	artistRow,
	buildDatabase,
	hex,
	namedRow,
	playlistEntryRow,
	playlistTreeRow,
	rawRow,
	trackRow,
	type RowBuilder,
	type TrackRow
} from '../src/lib/server/cdj/pdb';

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1] : undefined;
}
const playlistName = arg('playlist');
const outRoot = arg('out');
// Offsets analysis folder names (hex), so a test can share a stick with a rekordbox export.
const anlzBase = parseInt(arg('anlz-base') ?? '0', 16);
if (!playlistName || !outRoot) {
	console.error('usage: bun scripts/spike-cdj-usb.ts --playlist NAME --out DIR');
	process.exit(1);
}

const db = new Database(process.env.BOOTH_DB_PATH ?? join(homedir(), '.booth/booth.db'), { readonly: true });
const rows = db
	.query(
		`SELECT pt.position, t.id, t.title, a.name AS artist, t.album, t.duration_ms, r.year,
		        mk.key_value AS path
		   FROM playlist p
		   JOIN playlist_track pt ON pt.playlist_id = p.id
		   JOIN track t ON t.id = pt.track_id
		   JOIN artist a ON a.id = t.artist_id
		   LEFT JOIN release r ON r.id = t.release_id
		   LEFT JOIN match_key mk ON mk.entity_kind = 'track' AND mk.entity_id = t.id AND mk.key_type = 'file_path'
		  WHERE p.name = ?
		  ORDER BY pt.position`
	)
	.all(playlistName) as {
	position: number;
	id: string;
	title: string;
	artist: string;
	album: string | null;
	duration_ms: number | null;
	year: number | null;
	path: string | null;
}[];
if (!rows.length) throw new Error(`no playlist named ${playlistName}`);

const facetQuery = db.query(
	`SELECT key, value FROM source_facets WHERE entity_kind = 'track' AND source = 'local' AND entity_id = ?`
);
function facets(trackId: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const f of facetQuery.all(trackId) as { key: string; value: string }[]) {
		try {
			out[f.key] = JSON.parse(f.value);
		} catch {
			out[f.key] = f.value;
		}
	}
	return out;
}

console.log('indexing rekordbox analysis…');
const analysis = indexLocalAnalysis();

/** Picks rekordbox's analysis for a file: same name, and a beat grid that ends inside the track. */
function findAnalysis(path: string, durationMs: number | null): LocalAnalysis | null {
	const candidates = analysis.get(basename(path).normalize('NFC')) ?? [];
	const fits = candidates.filter((c) => {
		const last = c.grid?.beats.at(-1)?.timeMs;
		return last !== undefined && (durationMs == null || (last <= durationMs && last > durationMs - 20_000));
	});
	return fits.length === 1 ? fits[0] : null;
}

const fat = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || '_';
const today = new Date().toISOString().slice(0, 10);

const artists = new Map<string, number>();
const albums = new Map<string, number>();
const genres = new Map<string, number>();
const idFor = (m: Map<string, number>, k: string) => {
	if (!m.has(k)) m.set(k, m.size + 1);
	return m.get(k)!;
};

const tracks: TrackRow[] = [];
const skipped: string[] = [];
for (const r of rows) {
	const label = `${r.artist} — ${r.title}`;
	if (!r.path || !existsSync(r.path)) {
		skipped.push(`${label}: no local file`);
		continue;
	}
	const found = findAnalysis(r.path, r.duration_ms);
	if (!found) {
		skipped.push(`${label}: no unambiguous rekordbox analysis`);
		continue;
	}
	const ext = extname(r.path).toLowerCase().slice(1);
	const fileType = (FileType as Record<string, number>)[ext === 'aif' ? 'aiff' : ext];
	if (!fileType) {
		skipped.push(`${label}: unsupported file type ${ext}`);
		continue;
	}
	const f = facets(r.id);
	const id = tracks.length + 1;
	const usbPath = `/Contents/${fat(r.artist)}/${fat(r.album ?? 'Unknown Album')}/${fat(basename(r.path))}`;
	const anlzDir = `/PIONEER/USBANLZ/P${(id >> 12).toString(16).toUpperCase().padStart(3, '0')}/${(anlzBase + id).toString(16).toUpperCase().padStart(8, '0')}`;

	// Audio
	mkdirSync(dirname(join(outRoot, usbPath)), { recursive: true });
	copyFileSync(r.path, join(outRoot, usbPath));
	// Analysis, with PPTH naming the file's place on the stick
	mkdirSync(join(outRoot, anlzDir), { recursive: true });
	for (const name of ['ANLZ0000.DAT', 'ANLZ0000.EXT', 'ANLZ0000.2EX']) {
		const src = join(found.dir, name);
		if (existsSync(src)) writeFileSync(join(outRoot, anlzDir, name), withPath(readFileSync(src), usbPath));
	}

	const artistId = idFor(artists, r.artist);
	tracks.push({
		id,
		title: r.title,
		artistId,
		albumId: r.album ? idFor(albums, `${artistId}\u0000${r.album}`) : 0,
		genreId: typeof f.genre === 'string' && f.genre ? idFor(genres, f.genre) : 0,
		labelId: 0,
		keyId: 0,
		artworkId: 0,
		sampleRate: Number(f.sampleRate) || 44100,
		sampleDepth: 16,
		bitrate: Number(f.bitRate) || 0,
		fileSize: statSync(r.path).size,
		fileType,
		durationSec: Math.round((r.duration_ms ?? 0) / 1000),
		tempoCenti: found.grid!.beats[0].tempoCenti,
		trackNumber: 0,
		discNumber: 0,
		year: r.year ?? 0,
		rating: 0,
		colorId: 0,
		dateAdded: today,
		analyzePath: `${anlzDir}/ANLZ0000.DAT`,
		analyzeDate: today,
		comment: '',
		mixName: '',
		releaseDate: '',
		filename: basename(usbPath),
		filePath: usbPath
	});
	console.log(`  ✓ ${label}  (${(found.grid!.beats[0].tempoCenti / 100).toFixed(2)} BPM, ${found.grid!.beats.length} beats)`);
}

const albumArtist = new Map([...albums.keys()].map((k) => [k, Number(k.split('\u0000')[0])]));
const tableRows: Partial<Record<number, RowBuilder[]>> = {
	[Table.tracks]: tracks.map(trackRow),
	[Table.genres]: [...genres].map(([name, id]) => namedRow(id, name)),
	[Table.artists]: [...artists].map(([name, id]) => artistRow(id, name)),
	[Table.albums]: [...albums].map(([k, id]) => albumRow(id, albumArtist.get(k)!, k.split('\u0000')[1])),
	[Table.playlistTree]: [playlistTreeRow({ id: 1, parentId: 0, sortOrder: 0, isFolder: false, name: playlistName })],
	[Table.playlistEntries]: tracks.map((t, k) => playlistEntryRow(k + 1, t.id, 1))
};
for (const [type, hexRows] of Object.entries(STATIC_ROWS)) tableRows[Number(type)] = hexRows!.map((h) => rawRow(hex(h)));

const exportPdb = buildDatabase(
	Object.values(Table).map((type) => ({ type, rows: tableRows[type] ?? [] }))
);
const exportExtPdb = buildDatabase(EXPORT_EXT_TABLES.map((t) => ({ type: t.type, rows: t.rows.map((h) => rawRow(hex(h))) })));
mkdirSync(join(outRoot, 'PIONEER/rekordbox'), { recursive: true });
writeFileSync(join(outRoot, 'PIONEER/rekordbox/export.pdb'), exportPdb);
writeFileSync(join(outRoot, 'PIONEER/rekordbox/exportExt.pdb'), exportExtPdb);

console.log(`\nwrote ${tracks.length} tracks, ${artists.size} artists, ${albums.size} albums to ${outRoot}`);
if (skipped.length) console.log(`skipped ${skipped.length}:\n  ${skipped.join('\n  ')}`);
