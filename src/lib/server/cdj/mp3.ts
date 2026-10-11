/**
 * MPEG audio frame positions, for the seek hints rekordbox stores with each cue.
 */
import { readFileSync } from 'node:fs';

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const SAMPLE_RATES_V1 = [44100, 48000, 32000, 0];

export interface FrameIndex {
	/** Byte offset of each frame from the end of the ID3v2 tag. */
	offsets: number[];
	samplesPerFrame: number;
	sampleRate: number;
}

/** Frame offsets of an MPEG-1 Layer III file, or null for anything else. */
export function mp3Frames(path: string): FrameIndex | null {
	const d = readFileSync(path);
	let pos = 0;
	if (d.subarray(0, 3).toString('latin1') === 'ID3') {
		pos = 10 + ((d[6] << 21) | (d[7] << 14) | (d[8] << 7) | d[9]);
		if (d[5] & 0x10) pos += 10;
	}
	const audioStart = pos;
	const offsets: number[] = [];
	let sampleRate = 0;
	while (pos + 4 <= d.length && d[pos] === 0xff && (d[pos + 1] & 0xfe) === 0xfa) {
		const bitrate = BITRATES_V1_L3[d[pos + 2] >> 4];
		sampleRate = SAMPLE_RATES_V1[(d[pos + 2] >> 2) & 3];
		if (!bitrate || !sampleRate) break;
		offsets.push(pos - audioStart);
		pos += Math.floor((144000 * bitrate) / sampleRate) + ((d[pos + 2] >> 1) & 1);
	}
	return offsets.length ? { offsets, samplesPerFrame: 1152, sampleRate } : null;
}

/** Frames rekordbox backs off before a cue, so the decoder's bit reservoir is primed. */
const PRIMING_FRAMES = 8;

/** rekordbox's seek hint for a cue: its time in 1/75 s, and the byte offset of the frame to start decoding from. */
export function seekHint(index: FrameIndex, seconds: number): { t75: number; byteOffset: number } {
	const frame = Math.floor((seconds * index.sampleRate) / index.samplesPerFrame) - PRIMING_FRAMES;
	const clamped = Math.min(Math.max(frame, 0), index.offsets.length - 1);
	return { t75: Math.floor(seconds * 75), byteOffset: seconds > 0 ? index.offsets[clamped] : 0 };
}
