# File-owned library — design

> **Status:** approved design, pre-implementation.
> **Scope:** Booth takes ownership of the digital library — a watched drop folder, a Booth-managed file tree, content-addressed track identity, and metadata written into the audio files themselves. Retires the Apple Music XML as an ingest path. Does not cover reading *from* rekordbox, and does not change the vinyl-recording ingest path.
> **Ticket:** none yet.

## Goal

Make the digital library's metadata independent of Music.app, of `Library.xml`, and ultimately of Booth itself. Today Booth is a mirror of an export: it learns what Music.app deigns to tell it, in a file Music.app only writes when asked, keyed on identifiers Music.app regenerates without warning. Every fact Booth holds about a track — stars, notes, tempo, when the record entered the collection — lives in one SQLite file on one disk, invisible to every other tool.

After this change the audio files are the record. Booth files them, tags them, and can rebuild its entire database by rescanning the tree. Rekordbox sees Booth's annotations for free, because tags are the one channel it reads.

## What forced this

Three findings, in order of discovery:

**The current library is not the old one.** It was created fresh on the machine move of 2025-08-25 rather than migrated. It shares zero persistent IDs and zero absolute paths with its predecessor, so ~91% of tracks report that single day as their acquisition date. The genuine 2009–2025 history survived only in a manual export from the old MacBook, and was grafted back on 2026-08-28 (migration `011`, see the date-added overlay in CONTEXT.md).

**That graft keys on file path, and path is not identity.** Path was the only field with any overlap between the two libraries — persistent IDs had none. It works, but it breaks the moment a retag causes Music.app to rename a folder, and the failure is silent: the date reverts to something plausible.

**Music.app cannot be made the source of truth.** `date added` is read-only in its scripting interface — the only property in that region that is — and the XML is export-only, never read back. There is no path where Music.app holds this data correctly. Booth is custodian by necessity.

## Identity: hash the audio, not the file

**A track is identified by a hash of its audio stream**, with the container and tag blocks excluded. Verified on both formats in this library: the stream hash is byte-identical before and after a tag write, on MP3 and M4A alike.

This is the first identity Booth has had that survives everything that actually happens to a music file — renaming, retagging, moving between folders, being re-tagged by rekordbox, being copied to another machine. It replaces the Music.app persistent ID as the local source's `external_id`.

**Why not a whole-file hash:** writing a tag would change it, so identity would break on the very operation this design introduces.

**Why not path:** see above. Path is what the date-added overlay had to settle for, and its known weakness.

**Why this was impossible before:** fingerprinting requires the files. The old MacBook's library came across as a *description* of files, not the files themselves, so nothing content-based was available to the graft.

### Re-keying the existing library

The 4,344 local tracks are currently keyed on persistent IDs. Switching to fingerprints re-keys every one of them, which is precisely the operation that cascade-deleted 924 tracks on 2026-08-14. It must ride on `upsertSourceLink`'s existing relink-don't-delete path, not a fresh implementation, and the verification script must assert zero entity deletions across the transition.

## The tree

Booth owns a library root (configurable; default under the user's music directory). Layout is `Artist/Album/NN Title.ext`, derived from tags **at import and then frozen**.

**Paths are never recomputed.** Music.app and rekordbox both store absolute paths and mark tracks missing when files move. If the tree tracked tags, then fixing a misspelled artist — routine maintenance — would move the file and break every external index. The tree therefore drifts from the tags over time, and that is the accepted cost: drift is cosmetic, a broken index is not.

Duplicates are detected by fingerprint, not filename.

## The drop folder

Booth watches a folder. On a file that has finished being written: read its tags, fingerprint it, file it into the tree, write Booth's tags, record it.

**The acquisition date is the moment Booth observes the file.** Not a tag, not an export, not an inference — an event Booth witnesses and writes down. This is what makes the date-added overlay a one-time historical repair rather than permanent infrastructure: everything acquired after the switch is dated correctly at the source.

Handled explicitly: partial writes (wait for size stability before touching a file), a fingerprint already in the library (skip, don't duplicate), and unsupported formats (leave in place, report).

**Music.app's auto-add folder overlaps with this.** It lives inside the media folder, so repointing Music.app at Booth's tree would put two watchers on one folder. Booth's watcher owns the drop folder; Music.app is added to the tree by an explicit library add, not by racing for the same files.

## What Booth writes into files

**Standard fields, for interop:** tempo, rating, comment, genre, artwork. These are what rekordbox and everything else read.

**Custom fields, for Booth's own facts:** acquisition date, vetted flag, Discogs linkage, vinyl-rip provenance. These round-trip cleanly and are ignored by tools that don't know them.

**The acquisition date written is the effective one** — the recovered date where the overlay supplied it, Music.app's otherwise. This is how the date-added overlay graduates: once every file carries its true date in a tag, the overlay table and the old MacBook export stop being load-bearing and become history. The provenance markers (`dateAddedReported`, `dateAddedOrigin`) are written alongside, so a grafted date stays distinguishable from a witnessed one even after the database is rebuilt from tags.

**Two things cannot live in a tag:**

- *Playlists* are ordered and span many files. They are written as playlist files alongside the tree, which rekordbox also reads.
- *Vetted* is per-release, but files are per-track. It is stamped onto every track of the release and re-derived on rebuild.

Playback and queue state, sync history, the Discogs graph, and the artwork cache stay database-only. They are working state or re-fetchable, not facts about the music.

## The migration: one verified pass

For each of the 4,355 files: read the original, write a tagged copy into Booth's tree, fingerprint both, assert the audio stream is identical, record the result.

**Originals are never modified.** This is the reason tagging and migration are one operation rather than two: the copy already rewrites every file, so tags cost nothing extra — and a botched tag write is a bad copy to discard, not damage to an irreplaceable original. Deleting the originals is a **separate command**, run after reviewing the results.

Per-file atomic (temp file, then rename), resumable, with a dry run. The library is 50GB against 1.3TB free, so the duplicate-space approach is affordable.

Cutover, once and in order: verify, delete originals, repoint Music.app's media folder with *Copy files* and *Keep organized* both off, re-index rekordbox. Never run Music.app's *Consolidate Files*, which copies everything regardless of those settings.

## Rebuild: the claim, made testable

**A command rescans the tree and reconstructs the database from tags alone.**

This is not a recovery afterthought — it is the test of the entire premise. If rebuild does not reproduce the library, then "the files are the truth" is an aspiration rather than a fact, and the design has silently failed. It gets a verification script like any other load-bearing behaviour, and that script is the one that must never be allowed to rot.

It also settles the backup question underneath this work: the database becomes disposable. Losing it costs a rescan, not history.

## Backups

**What changes:** Booth's database stops being the only copy of stars, notes, dates and tempo. Those facts distribute across 4,355 files, and any backup of the music inherently protects them. This removes the failure mode that matters most on an unattended machine.

**What gets more precious:** the 50GB of audio, which now carries the annotations inside it.

**What is still missing, and is not a Booth problem:** this machine has no Time Machine destination configured. Nothing on it is backed up anywhere. An external drive covers the library, the database, and the old MacBook export in one move, and is the highest-value action available independent of this design.

**For the Mac mini:** automated off-machine copies plus a *periodic restore test*. An unverified backup is a guess. The rebuild-from-tags check doubles as the restore test for metadata.

**Retained regardless:** the old MacBook export (`~/.booth/Old_MacBook_Library.xml`, copied off-machine 2026-08-28) remains the only source for pre-migration acquisition dates until the graft is written into tags by this work — after which the tags carry it and the XML becomes historical.

## Slices

Ordered so the premise is proved before anything is written or moved.

1. **Fingerprint + rebuild-from-tags, read-only.** Hash every file in place, measure the cost across 50GB, and prove a database can be reconstructed from tags. No writes. If this slice disappoints, the design changes before any file is touched.
2. **Tag schema + writer.** Resolve the library choice, write the round-trip verification, confirm what rekordbox actually reads.
3. **Migration pass.** Copy, tag, verify, report. Originals kept.
4. **Drop-folder watcher.** New arrivals land correctly; acquisition dates become witnessed facts.
5. **Cutover.** Delete originals, repoint Music.app, re-index rekordbox.
6. **Backup hardening.** Off-machine target, restore test, Mac mini story.

## Open questions

- **Which tag-writing library.** Booth's current one is read-only. ffmpeg (already a dependency) handles custom fields and tempo correctly, but wrote the comment field to the wrong frame in testing — and the standard frames are exactly the ones rekordbox reads. Resolved in slice 2 by a spike, not by assumption.
- **Does rekordbox read the standard rating field?** Determines whether stars survive the trip. Confirm before committing stars to it.
- **Hashing cost across 50GB.** Shapes whether migration is one pass or batched. Measured in slice 1.
- **M4A tag writing is fiddlier than MP3.** 175 files, worth a targeted check rather than an assumption.

## Non-goals

- Reading cue points, beatgrids or play history *from* rekordbox. Its library is SQLCipher-encrypted (verified: no SQLite header, ciphertext from byte zero); decryption keys break on version updates. The documented interop channel is rekordbox XML, and it is a separate piece of work.
- Changing the vinyl-recording ingest path, which already writes files Booth owns.
- Writing play counts back to Music.app. Scriptable, but not worth the coupling this design exists to remove.
