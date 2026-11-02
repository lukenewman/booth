# Migration and library sources — design

> **Status:** approved in conversation 2026-11-02, written spec awaiting review.
> Linear: project *Migration + library sourcing*, BOO-102.
> Builds on, and in places replaces, `2026-09-01-file-owned-library-design.md` (see "What changes from the file-owned design").

## Goal

Bring anyone's existing music setup into Booth, and keep it in step afterwards, without risking their files or the work they have put into them: stars, notes, cue points, beat grids, playlists.

**Audience:** DJ friends and peers first, as in the landing-page design. Strangers should be able to get through it alone. Setups will vary a lot: Music.app with or without iCloud Music Library, rekordbox, Serato, Traktor, Engine, plain folders of downloads, Discogs-only collectors, libraries on external drives.

**Success:**
- A DJ goes from their current setup to Booth running on their whole library without messaging Luke.
- Nothing is lost: no file, star, note, cue point, grid or playlist.
- Nothing is deleted until a separate, verified backup exists, and never without the user saying so.
- Eventually, a DJ can stop using rekordbox entirely: Booth owns analysis, cues and the stick export (project *Analysis + stick export*).

## Decisions

| Question | Decision |
|---|---|
| Does Booth always take over files? | No. **Read in place first, take over by choice.** |
| Unit of takeover | **Per release.** Gradual migration, not one pass. |
| Trying it out | **Sample migration**: a real first takeover of ~10 releases, with undo. |
| Review | **A standing "needs attention" list** fed by every sync and run. The wizard's review step is that list narrowed to the run. |
| What Booth settles alone | **Only what clears itself.** Never deletes, merges or picks a winner on its own. Bulk settling is available. |
| Sources in the first version | Music.app, **rekordbox as a full source**, plain folders, plus Discogs and Bandcamp as today. Designed so Serato, Traktor and Engine slot in later. |
| Sources disagree | **Per field**, with a natural owner for each kind of fact; a finding only when it matters. |
| When cutover happens | **User's choice, defaulting to once at the end**; any batch can be cut over early. |
| Where Booth's folder lives | **A Booth folder in the Music folder by default**, asked at the first takeover; external drives allowed. |
| Renaming | **Needs takeover.** Booth never keeps names of its own for files it doesn't own. |
| Originals | **Kept through a holding period and until a verified separate backup exists.** Deleting them is always the user's decision. |
| Backup destinations | **The user's own storage first** (drive, NAS, their cloud account); a hosted service stays possible as another destination later. |

## 1. The file list and sources

**One list of every audio file Booth knows about.** Each entry records where the file is, its audio fingerprint (the coded audio stream only, so retagging never changes it), whether it is *read in place* or *owned by Booth*, and whether it is present or missing.

**A track is one of those files.** Stars, notes, crates, playlists and Discogs pairings hang off it, and its identity never changes when the file moves or is taken over.

**Two kinds of local source:**

- **File sources** say "this file exists": folders the user points Booth at, Booth's own folder, the drop folder, vinyl rips. Booth scans them.
- **Catalog sources** describe files by location: Music.app and rekordbox now; Serato, Traktor, Engine later. They contribute ratings, play counts, dates added, tempo, key, grids, cue points and playlists to whichever file sits at the location they name. **They never create tracks.** A location with no file behind it becomes a missing-file finding.

Discogs and Bandcamp are unchanged record sources.

**Identity:**
- The fingerprint recognises a file that moved (Music.app renames folders when tags change), and the location is updated quietly.
- Two *different* files with the same fingerprint are a duplicate finding, never merged automatically. The same recording on an album and on a compilation may be legitimately separate.

**Cost:** the first scan fingerprints everything (measured: ~2 minutes for 50 GB). After that, only files whose size or modified time changed are re-read. This also replaces the drop-folder scan's re-read of every file on every sync.

**Read in place means hands off.** Booth never writes to a file it does not own.

## 2. The "needs attention" list

Each finding records what it is about, which run raised it, and whether it is open, settled by the user, or cleared on its own.

| Finding | Raised when | Actions |
|---|---|---|
| Duplicate | Two files share a fingerprint | Keep both; or keep one in the library (the other file stays on disk) |
| Missing file | A catalog lists a file that isn't there, or a known file disappeared | Point Booth at it; or forget the track, after being shown what goes with it (stars, notes, crates) |
| Unsupported format | Booth can't read or tag a file | Acknowledge; it stays listed in its source |
| Sources disagree | Two sources hold real, different values for title, artist or album (not formatting, not empty) | Pick which source's value Booth shows. Booth never invents a value. |
| Possibly the same record | A local album and a Discogs record nearly match (title variants, BOO-99) | Merge; or "not the same" |
| Ready to cut over | A taken-over release still has originals elsewhere | Opens the cutover guide for that batch |
| Originals can be deleted | Holding period passed and a verified backup holds the copies | Delete, or keep indefinitely |

**Rules:**
- **Clears itself** when the problem disappears: a file comes back, a duplicate goes away, sources stop disagreeing.
- **Settled stays settled.** A decision is remembered against the files involved, so the same pair never comes back. A new circumstance (a third copy) is a new finding.
- **Bulk:** findings group by kind, with "settle all like this", showing how many it will affect first.
- **Nothing on this list deletes audio**, except the explicit "originals can be deleted" action, which is gated as described in section 5.

**Where it shows:** a "Needs attention" sidebar item with a count; the wizard's review step (the list narrowed to its run); the sync status ("3 new").

## 3. Takeover, the sample, and undo

**Takeover is per release.** Loose tracks with no album count as a release of their own.

**For each file:**
1. Copy into Booth's folder as `artist / album / number title`. That location is fixed from then on; later tag changes never move the file.
2. Write everything Booth knows into the copy's tags (section 4).
3. Fingerprint the copy; refuse it if the audio differs from the original.
4. Point the track at the copy and mark it Booth-owned.

The original is never touched. **A release flips only when every one of its files succeeds**; otherwise it stays in place and a finding says why.

**Running:** a background job showing releases and gigabytes done, pausable, resumes after a restart. Its findings land in the list, narrowed to the run.

**The sample** is the first takeover:
- Booth suggests ~10 releases, random but spread to include awkward cases: an M4A (rekordbox can't see its stars), a duplicate, a Discogs-paired record, something starred or with a note. "Draw again" and "pick my own" are offered.
- This is where Booth asks where its folder should live.
- It says plainly that other apps won't see changes to these releases until they are cut over.

**After takeover:**
- Edits to an owned release (stars, cues, renames) are written straight into its files with the safe writer, batched so a burst of edits is one rewrite.
- Files from the drop folder arrive already owned, with tags written (BOO-77).
- Renaming is offered only on owned releases. On a release read in place it reads "Take over this release to rename it".

**Undo** is per release, for as long as that release's originals exist:
- Points the tracks back at the originals and deletes the copies.
- Stars, notes and crates survive: they were always Booth's own facts.
- Anything that existed only in the copy's tags (a rename) is lost, because Booth won't write to an original. The confirmation lists exactly what will be lost.

## 4. Who owns each fact

Every fact on a track has one owner, a source or Booth. Booth shows and exports the owner's value and keeps the others.

| Fact | Default owner |
|---|---|
| Title, artist, album, year, track number | The file's tags. Other sources' versions only raise "sources disagree". |
| Tempo, beat grid, key, cues | rekordbox if it has them, Booth's analysis otherwise |
| Play counts, date added | Music.app or rekordbox, with the recovered date history (date-added overlay) on top |
| Stars | Combined: starred anywhere counts |
| Notes, crates, gigs, vetted | Always Booth |

- **Edited in Booth means Booth owns it.** Editing a cue, grid or key in Booth makes Booth the owner of that fact for that track. Later imports don't overwrite it. "Go back to rekordbox's version" undoes that.
- **Booth's analysis never overrides an import on its own.** When Booth's own grids are trustworthy enough to prefer is decided in the *Analysis + stick export* project, measured against rekordbox and spot-checked by ear (rekordbox is not ground truth either).
- **Retiring a source hands its facts to Booth.** Booth keeps the last imported values and becomes their owner.
- **For files read in place**, facts edited in Booth (cues, grids, key) live in Booth's database until takeover. They are analysis data, not names, so this does not break the "no Booth-only names" rule.

**Where things live in an owned file:**
- Standard tags for what other software reads: title, artist, album, tempo, key, rating, comment.
- Booth fields for what nothing else reads: date added and its provenance, vetted, Discogs link, fingerprint.
- Grid and cues as one compact Booth field. Also writing them in Serato's format is deferred.
- Playlists, crates and gigs as playlist files beside the folder.
- **Rebuilding the database from the folder must reproduce all of it, ownership included.**

## 5. Cutover, holding period, and deleting originals

**Cutover and deletion are separate steps.**

**Cutting over a batch** moves its originals into a *kept originals* folder outside Booth's folder. On the same disk that is a rename, not a copy. This:
- makes other apps see those files as missing, which is what their relocate tools need (left in place, they'd keep playing the originals);
- keeps the originals safe, and makes undo a move back.

**Per app, the user chooses relocate or retire:**

| | Relocate | Retire |
|---|---|---|
| rekordbox | Guided missing-file search pointed at Booth's folder; keeps cues and grids (re-importing would lose them). Try on a copy of rekordbox's library or a small batch first. | Booth stops importing and owns rekordbox's facts. rekordbox shows those tracks as missing, as expected. |
| Music.app | No bulk relocate: remove and re-add the batch. Its play counts and playlist membership are lost in Music.app (Booth keeps both). iCloud Music Library changes this; the wizard asks. | Likely default for anyone who doesn't sync an iPhone. |

**Deleting originals** is offered (never done automatically) only when both hold:
1. **A holding period has passed** since the release was cut over: 30 days by default, adjustable.
2. **A separate backup verifiably contains the copies**: checked by fingerprint against what Booth recorded in that backup, on another drive or off this machine. A copy on the same disk does not count.

Keeping the originals forever is a valid choice. Undo for a release lasts as long as its originals exist.

## 6. Backups (BOO-103, reshaped)

- **Destinations are the user's own:** an external drive or NAS, or a cloud storage account they hold. Pluggable, so a Booth-hosted service could be one more destination later; that decision sits with the *Remote access* project.
- **Booth runs the backup**: the owned folder, the kept originals, and the database (via SQLite's own backup, never a plain copy).
- **Booth records what each backup contains** (fingerprints), so "Y releases aren't in the last backup" is a query.
- **The nudge:** "You haven't backed up in X days. Y releases aren't in the last backup. Back up now."
- **Periodic restore test:** rebuild a database from the backup's tags and compare.

## 7. The wizard, end to end

1. **Connect.** Booth finds folders, Music.app and rekordbox, and walks through rekordbox's collection export.
2. **Read in place.** Fingerprint everything; import what each source knows.
3. **Review.** The list, narrowed to this run.
4. **Use it.** Stars, crates, gigs and stick exports all work on files read in place.
5. **Sample takeover**, which asks where Booth's folder lives.
6. **More takeovers**, whenever.
7. **Cutover**, per batch or all at once: originals to the holding folder, then relocate or retire each app.
8. **Back up** to a separate destination.
9. **After the holding period, with a verified backup,** the list offers to delete originals.

## What changes from the file-owned design

- **One verified pass → per-release takeover.** The existing migration pass (BOO-74) becomes the takeover engine, run on a chosen set of releases instead of the whole library. Its copy, tag, fingerprint and refuse-on-mismatch steps stand.
- **Music.app's export stops creating tracks**; it becomes a catalog source describing files. This absorbs BOO-101's handover: existing tracks are mapped onto their files once, keeping their ids.
- **Cutover gains a holding folder, a retire option, and a backup gate on deletion.** BOO-75's ordering survives; deleting originals moves out of it.
- **The tree's location** is chosen by the user at the first takeover. Files the drop folder has already filed into Booth's hidden folder move there then (they are already owned).
- Unchanged: paths are frozen once in Booth's folder; originals are never modified; the fingerprint is identity; rebuild-from-tags is the test of the whole premise.

## Unknowns to test first

Each is a small test on a copy of the app's library, before the cutover is built on it:
- Does rekordbox's missing-file search keep cues and grids in every case, including when the folder layout differs?
- Can Music.app relocate anything in bulk, or is remove-and-re-add the only path?
- What does iCloud Music Library do on a re-add?

## Build order and verification

Ordered so nothing writes to a real file until a separate backup exists.

1. **The file list.** Fingerprint-based identity; file and catalog sources; Music.app re-expressed as a catalog; existing tracks mapped onto files. No visible change. *Verify:* on a copy of the real database, every local track maps to a file, keeps its id, and keeps its stars, notes, playlists and crate rows; a second sync changes nothing.
2. **The "needs attention" list** with missing, duplicate and unsupported findings, fed by sync. Folds in BOO-67. *Verify:* the 9 known missing files and the 22 known fingerprint collisions appear; a settled finding stays settled across syncs; a returning file clears itself.
3. **rekordbox as a catalog source** (BOO-82), per-field ownership, "edited in Booth owns it", "sources disagree" and "possibly the same record" findings. *Verify:* importing twice is idempotent; a Booth-edited cue survives a re-import.
4. **Folder sources:** point Booth at a folder. *Verify:* a folder overlapping Music.app's files produces no duplicate tracks.
5. **Backups** to the user's own destination, with recorded contents and the nudge (BOO-103). *Verify:* a restore test rebuilds a matching database. **A real backup of Luke's library exists before step 6 runs on it.**
6. **Takeover, sample and undo**, renames on owned releases (BOO-100), writes on edit, drop folder writing tags (BOO-77). *Verify:* sample on a copy; undo restores exactly; rebuild-from-tags matches.
7. **Cutover**, after the three unknowns are tested: holding folder, relocate and retire guides (BOO-75).
8. **Deleting originals**, gated on holding period and verified backup.
9. **The wizard shell** stitching steps 1–8 into one guided flow, replacing today's separate Discogs and Music.app setup steps. Pieces ship usable on their own before the shell exists.

Verification follows the project's existing pattern: a verify script per behaviour against an in-memory database, then a run against a backup copy of the real database on a throwaway server. Never against the real library before step 5 is in place.

## Non-goals (for now)

- Serato, Traktor and Engine sources (the source design must allow them).
- A Booth-hosted backup service.
- Writing cues in Serato's tag format.
- Deciding when Booth's analysis beats rekordbox's (*Analysis + stick export*).
- Moving files when tags change (paths stay frozen).
