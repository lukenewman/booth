# Folder Sources Implementation Plan (step 4)

> Executed inline overnight on Luke's standing instruction (keep going on the migration project, trust judgement, stop only for his calls). Compact: the executor is the author.

**Goal:** Point Booth at a folder of music. Every audio file under it is in the file list, read in place; files no catalog lists become tracks from their own tags; files Music.app also lists stay one track.

**Spec:** `docs/superpowers/specs/2026-11-02-migration-and-sources-design.md`, section 1 ("file sources"), build step 4. *Verify:* a folder overlapping Music.app's files produces no duplicate tracks.

## Decisions (mine, for Luke)

- **Folders live in the database** (`folder_source`), not the settings file: a list, added and removed from the UI.
- **One file, one row, whatever its spelling.** Paths wanted by catalogs, Booth's folder and folder sources are reconciled Unicode-normalised before the scan, preferring the spelling the file list already has, then the catalog's. Without this, a folder walk (names as stored on disk) and Music.app (sometimes decomposed) would make two rows, two tracks and a false duplicate for one file.
- **Catalog first.** A file both a catalog and a folder reach is emitted once, with the catalog's names and facets (unchanged from today). Folder-only files use their tags, origin `folder`, date added as witnessed.
- **An unplugged folder is offline, not empty.** If a folder's root can't be read, its known files are emitted from the file list as they were (no scan, no presence change, no findings), so an external drive coming and going never prunes tracks or floods the list. The run summary says which folders were offline.
- **Removing a folder shows what goes first**: tracks only that folder reached, with their stars, notes and playlist entries. Booth's own folder and the drop folder are not folder sources and can't be removed.
- **Nested or overlapping folders** are fine: paths are deduplicated.

## Tasks

1. **Table and folder API.** Migration `020_folder_sources.sql`: `folder_source(id, path UNIQUE, added_at)`. `src/lib/server/library/folders.ts`: `listFolderSources`, `addFolderSource(db, path)` (must be an existing readable directory; stored resolved, no trailing slash), `removeFolderSource(db, id)`, `folderRemovalImpact(db, id)` (tracks whose file is under the folder and that no catalog or other folder reaches: count, starred, with notes, in playlists). *Test* `scripts/verify-folder-sources.ts`.
2. **Local result with folders.** `buildLocalResult` input gains `folders: { root: string; files: string[]; online: boolean }[]`; wanted paths reconciled by NFC; offline folders' known rows emitted from cache and left out of `fileIds`; folder-only files built by `ingestedFromFiles` with origin `folder`. `sync.ts` lists each folder (`online` = root readable). Summary `folders: { root, files, online }[]`. *Tests:* overlap with Music.app (same spelling and NFC/NFD) → one track each, no duplicate finding; folder-only file → track from tags; offline folder → its tracks stay, no findings, and come back to normal when it returns; removing a folder (after the impact check) removes only its own tracks; a different file with the same audio in a folder and in Music.app → one duplicate finding.
3. **API and panel.** `GET/POST /api/folders`, `DELETE /api/folders/[id]` (`?preview=1` → impact). `FolderSourcesPanel.svelte` in Sources → Local under rekordbox: folders with file counts and offline state from the last run, add-path field, remove with the impact confirmation; adding or removing starts a fresh local sync. *Verify:* `bun check`; copy server + headless Chrome with a scratch folder holding one copy of a library file and one new file.
4. **Context.** CONTEXT.md bullet.
