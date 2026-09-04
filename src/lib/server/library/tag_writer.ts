/**
 * Writing Booth's facts into an audio file.
 *
 * Two passes over the buffer because the library needs both: `applyTags` handles
 * standard frames and custom fields but silently ignores a rating, while the
 * file API's `setRating` writes POPM correctly. Opening the buffer `applyTags`
 * returns chains them without a second round trip through disk.
 *
 * **The audio must not change.** The writer fingerprints the temp file against
 * its source and refuses to publish a mismatch — that assertion is what makes
 * the migration's pass over 50GB of irreplaceable files defensible. Writing to a
 * temp file and renaming means a crash mid-write leaves the original intact.
 */
import { rename, unlink } from 'node:fs/promises';
import { TagLib, applyTags } from 'taglib-wasm';
import { audioFingerprint } from './fingerprint';
import { POPM_STAR_VALUES, toTagWrite, type BoothTrackFacts } from './tag_schema';

export class TagWriteError extends Error {
  constructor(
    readonly filePath: string,
    detail: string,
  ) {
    super(`could not tag ${filePath}: ${detail}`);
    this.name = 'TagWriteError';
  }
}

let taglib: Awaited<ReturnType<typeof TagLib.initialize>> | null = null;
async function lib() {
  taglib ??= await TagLib.initialize();
  return taglib;
}

/**
 * Write `facts` into `sourcePath`, producing `destPath` (the source itself by
 * default). Returns the written file's audio fingerprint, which equals the
 * source's — that is the point.
 */
export async function writeTags(
  sourcePath: string,
  facts: BoothTrackFacts,
  destPath: string = sourcePath,
): Promise<string> {
  const before = await audioFingerprint(sourcePath).catch((e) => {
    throw new TagWriteError(sourcePath, e instanceof Error ? e.message : String(e));
  });

  const write = toTagWrite(facts);
  const tmpPath = `${destPath}.booth-tmp`;

  try {
    // Custom BOOTH_* keys sit alongside the standard ones in the same object;
    // the library routes unknown keys to TXXX / freeform atoms by container.
    const tagInput: Record<string, unknown> = { ...write.custom };
    if (write.comment !== undefined) tagInput.comment = write.comment;
    if (write.bpm !== undefined) tagInput.bpm = write.bpm;
    const tagged = await applyTags(sourcePath, tagInput as Parameters<typeof applyTags>[1]);

    let bytes = new Uint8Array(tagged);
    if (write.ratingStars !== undefined) {
      const file = await (await lib()).open(bytes);
      try {
        // POPM_STAR_VALUES, not the library's toPopm(), which returns 255 for one
        // star and 0 for the rest.
        file.setRating(POPM_STAR_VALUES[write.ratingStars]);
        file.save();
        bytes = new Uint8Array(file.getFileBuffer());
      } finally {
        file.dispose();
      }
    }

    await Bun.write(tmpPath, bytes);

    const after = await audioFingerprint(tmpPath);
    if (after !== before) {
      throw new TagWriteError(sourcePath, `audio changed during tagging (${before} → ${after})`);
    }

    await rename(tmpPath, destPath);
    return after;
  } catch (e) {
    await unlink(tmpPath).catch(() => {});
    if (e instanceof TagWriteError) throw e;
    throw new TagWriteError(sourcePath, e instanceof Error ? e.message : String(e));
  }
}
