# booth

A personal, local-only app for a DJ's record collection: one library across
vinyl (Discogs), digital files (Apple Music) and vinyl rips recorded straight
into it, with playback, playlists, gigs, BPM, and USB sticks that Pioneer DJ
players read, written without rekordbox in between.

It's built for one person's collection and machine. There are no accounts and
nothing leaves your computer except Discogs API calls.

## Running it

```sh
bun install
bun dev          # http://localhost:5173
```

The first run walks you through pasting a Discogs token and connecting the
Apple Music library. Data lives in `~/.booth/`. `ffmpeg` (`brew install ffmpeg`)
is needed for tempo analysis, artwork and audio fingerprints.

- `bun check`: type-check
- `bun run build && bun start`: production server on port 3000
- `desktop/build.sh`: the macOS app (see `docs/CONTEXT.md`)

`docs/CONTEXT.md` is the source of truth for how booth works and why.

## Acknowledgements

The Pioneer USB export stands on years of other people's reverse engineering.
Thank you to:

- **[baken](https://github.com/M-Igashi/baken)** by Masanari Higashi (MIT).
  Booth's cue writer is ported from its `cues.rs`. Its artwork layout and
  thumbnail recipe, and its implementation of the player's analysis-folder
  hash, are what made booth's sticks work on real hardware.
- **[fourfour](https://github.com/morizkraemer/fourfour)** by @morizkraemer, who
  recovered from rekordbox that players find a track's analysis by hashing its
  path.
- **[Deep Symmetry](https://github.com/Deep-Symmetry)**: James Elliott's
  [crate-digger](https://github.com/Deep-Symmetry/crate-digger) Kaitai specs
  for the export database and analysis files, and the
  [DJ Link analysis](https://djl-analysis.deepsymmetry.org/) built with Henry
  Betts, Fabian Lesniak and others.
- **[rekordcrate](https://github.com/Holzhaus/rekordcrate)** by Jan Holthuis and
  contributors (MPL-2.0). Booth's export is checked with its strict parser, and
  its real rekordbox exports were the reference for the database's fixed tables.
- **[pyrekordbox](https://github.com/dylanljones/pyrekordbox)** by @dylanljones,
  for its documentation of rekordbox's files.

Booth is built with [Bun](https://bun.sh), [SvelteKit](https://svelte.dev) and
[Svelte](https://svelte.dev), [Vite](https://vite.dev),
[Electrobun](https://electrobun.dev) for the desktop app,
[FFmpeg](https://ffmpeg.org),
[music-metadata](https://github.com/Borewit/music-metadata),
[taglib-wasm](https://github.com/CharlesWiltgen/taglib-wasm) (TagLib),
[ZXing](https://github.com/zxing-js/browser) for barcode scanning,
[plist](https://github.com/TooTallNate/plist.js) and
[ulid](https://github.com/ulid/javascript).

Release and collection data comes from the [Discogs](https://www.discogs.com)
API. Booth isn't affiliated with, or endorsed by, Discogs, Apple, AlphaTheta or
Pioneer DJ. rekordbox is a trademark of AlphaTheta Corporation.
