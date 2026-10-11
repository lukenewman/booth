# Landing page — design

## Goal

A minimal product page for booth: what it is, its main features, a download
link that always points at the newest release, and a short install/setup guide.

**Audience:** mostly friends and DJ peers sent the link directly, but it should
explain itself to a stranger who lands on it cold.

**Success:** a DJ friend goes from the link to booth running with their
collection loaded without messaging Luke; a stranger understands what booth is
within five seconds.

## Page

One static scrolling page, dark, in the app's own palette and system font stack
(`src/app.css` tokens: warm graphite, lavender accent).

1. **Hero** — name, a one-line pitch, a primary "Download for Apple Silicon"
   button with a smaller Intel link under it, and a hero screenshot (release
   grid with a release open).
2. **Features** — four blocks, each a heading, one or two sentences, and a
   screenshot:
   - One library across Discogs and Apple Music
   - Add records by search or barcode
   - Record vinyl straight into the library, with track splitting
   - Stars, notes, and gig planning
   Keyboard-first is a line, not a block.
3. **Install & setup** — numbered steps:
   1. Download the DMG (Apple Silicon) or the zip (Intel).
   2. First launch: macOS refuses; System Settings → Privacy & Security →
      Open Anyway. Screenshot of this step.
   3. Paste a Discogs token (link to discogs.com/settings/developers).
   4. Optional: Music.app → Settings → Advanced → "Share Library XML with
      other applications", then point booth at it. Expect Music-folder,
      camera and microphone prompts when those features are first used.
   5. Optional: `brew install ffmpeg` for tempo analysis.
   6. Updates install themselves.
4. **Footer** — "Mac only. A personal project." plus GitHub and release links.

Out of scope: analytics, changelog page, custom domain (easy later), CDJ export.

## Download links

The release workflow also uploads the DMG and Intel zip under fixed names —
`booth-apple-silicon.dmg`, `booth-intel.zip` — so
`https://github.com/lukenewman/booth/releases/latest/download/<name>` always
resolves. Self-update reads the Electrobun-named files, which stay untouched.
The fixed names exist from the next tagged release on; until then the buttons
point at the latest release page.

## Screenshots from a demo library

- Copy `~/.booth/booth.db` with `sqlite3 .backup` into a separate data folder,
  then prune the **copy** down to a hand-picked set of Luke's releases.
- Run booth against that folder on its own port with syncing switched off
  (new `BOOTH_NO_SYNC=1`: skips the boot sync and the scheduler — otherwise the
  boot sync pulls the whole Discogs collection back into the demo DB), and with
  backups and recordings pointed into the demo folder.
- Capture screenshots in headless Chrome over CDP at 2x, save as optimized
  WebP/PNG in the site folder. The recording screenshot uses a short throwaway
  take so the split view has a waveform.
- The real library and the running dev server are never touched.

## Hosting

`site/` in the booth repo holds plain HTML/CSS plus images — no build step. A
`pages` workflow deploys it to GitHub Pages on pushes that touch `site/`.
