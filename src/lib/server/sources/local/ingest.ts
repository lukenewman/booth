import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readTags, type FileTags } from '../../library/tags';
import type { SourceRelease, SourceTrack } from '../types';
import { dedupePath, ingestTargetPath, isAudioFile, pickStable } from './ingest_paths';

/**
 * The drop folder: files land in the inbox, and ingest moves them into Booth's
 * own library tree where the local sync picks them up like any other file.
 *
 * Why a move rather than indexing in place: the inbox is a staging area, and an
 * inbox that is never emptied becomes the library — you lose the ability to see
 * at a glance what has not been dealt with, and every scan has to re-derive
 * which files it has already seen. Emptying it makes "is it in?" observable
 * without asking the database.
 */

export interface IngestSummary {
  /** Files moved into the library this pass. */
  ingested: number;
  /** Files seen but still settling — they will be picked up next pass. */
  waiting: number;
  /** Files that could not be ingested, with the reason. */
  failed: { path: string; error: string }[];
}

/**
 * Sizes from the previous pass, for the settle check in `pickStable`.
 *
 * Process-local on purpose: it is a debounce, not state worth persisting. A
 * restart costs one extra pass before a half-copied file is ingested, which is
 * the safe direction to fail.
 */
let previousSizes = new Map<string, number>();

/** Every audio file under `root`, recursively. Missing root reads as empty. */
export function listAudioFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // Skip dotted directories: Booth's own .tmp staging, Spotlight indexes,
      // and anything else that is not the user's music.
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && isAudioFile(path)) out.push(path);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * One ingest pass: move every settled file out of the inbox and into the
 * library tree. Safe to call on a schedule; does nothing when the inbox is empty.
 */
export async function runInboxIngest(
  inboxRoot: string,
  libraryRoot: string,
): Promise<IngestSummary> {
  const summary: IngestSummary = { ingested: 0, waiting: 0, failed: [] };

  // Create the inbox rather than skipping: a folder you are supposed to drop
  // files into has to exist before anyone can drop anything into it.
  mkdirSync(inboxRoot, { recursive: true });

  const current = new Map<string, number>();
  for (const path of listAudioFiles(inboxRoot)) {
    try {
      current.set(path, statSync(path).size);
    } catch {
      // Vanished between listing and stat — a move finishing underneath us.
    }
  }

  const ready = new Set(pickStable(previousSizes, current));
  summary.waiting = current.size - ready.size;

  for (const path of ready) {
    try {
      const tags = await readTags(path);
      const target = dedupePath(ingestTargetPath(libraryRoot, tags, path), existsSync);
      mkdirSync(dirname(target), { recursive: true });
      moveFile(path, target);
      summary.ingested++;
      current.delete(path);
    } catch (err) {
      // Leave the file in the inbox: it stays visible and gets retried, which
      // is better than a silent quarantine nobody thinks to look in.
      summary.failed.push({ path, error: err instanceof Error ? err.message : String(err) });
      current.delete(path);
    }
  }

  previousSizes = current;
  if (summary.ingested > 0) pruneEmptyDirs(inboxRoot);
  return summary;
}

/**
 * Move, falling back to copy + delete across filesystems. A Downloads folder
 * and the library commonly sit on different volumes, where rename fails with
 * EXDEV. The copy is verified by size before the original goes.
 */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  copyFileSync(from, to);
  if (statSync(to).size !== statSync(from).size) {
    unlinkSync(to);
    throw new Error(`copy of ${from} came out a different size`);
  }
  unlinkSync(from);
}

/** Drop directories the ingest emptied, so an album folder doesn't linger. */
function pruneEmptyDirs(root: string): void {
  const walk = (dir: string): boolean => {
    let empty = true;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(path)) {
          try {
            rmdirSync(path);
          } catch {
            empty = false;
          }
        } else empty = false;
      } else if (entry.name !== '.DS_Store') empty = false;
    }
    return empty;
  };
  if (existsSync(root)) walk(root);
}

/**
 * Read the ingested library tree into the shape a sync contributes.
 *
 * These are emitted as part of the local source's normal result rather than
 * written directly, which is what keeps them safe: a track present in the sync
 * result is never pruned, so ingested files need none of the special-casing
 * vinyl rips require. Deleting a file from the tree correctly removes it.
 */
export async function scanIngestedLibrary(
  libraryRoot: string,
  groupIdFor: (tags: FileTags) => string | undefined,
): Promise<{ releases: SourceRelease[]; tracks: SourceTrack[] }> {
  const files = listAudioFiles(libraryRoot);
  const tracks: SourceTrack[] = [];
  const releaseOf = new Map<string, SourceRelease>();

  const BATCH = 20;
  for (let i = 0; i < files.length; i += BATCH) {
    const read = await Promise.all(
      files.slice(i, i + BATCH).map(async (path) => {
        try {
          return { path, tags: await readTags(path) };
        } catch {
          // An unreadable file is skipped rather than failing the whole sync —
          // one corrupt download must not stop the library updating.
          return null;
        }
      }),
    );

    for (const entry of read) {
      if (!entry) continue;
      const { path, tags } = entry;
      const releaseExternalId = groupIdFor(tags);
      const artist = (tags.albumArtist ?? tags.artist ?? '').trim();

      if (releaseExternalId && !releaseOf.has(releaseExternalId)) {
        releaseOf.set(releaseExternalId, {
          externalId: releaseExternalId,
          title: tags.album!,
          artist,
          year: tags.year,
          facets: { origin: 'download' },
        });
      }

      tracks.push({
        // The absolute path, as vinyl rips already use: a file Booth moved has
        // no persistent id from anywhere else, and the path is what identifies it.
        externalId: path,
        title: tags.title ?? path.split('/').pop()!,
        artist: (tags.artist ?? artist).trim(),
        album: tags.album,
        durationMs: tags.durationMs,
        position: tags.trackNumber != null ? String(tags.trackNumber) : undefined,
        filePath: path,
        releaseExternalId,
        facets: pickDefined({
          origin: 'download',
          bpm: tags.bpm,
          genre: tags.genre,
          rating: tags.rating,
        }),
      });
    }
  }

  return { releases: [...releaseOf.values()], tracks };
}

function pickDefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as any)[k] = v;
  return out;
}
