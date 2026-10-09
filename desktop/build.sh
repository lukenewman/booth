#!/bin/bash
# Builds Booth.app for this Mac's architecture (Hutch builds for the host only).
# Needs Bun and Hutch on PATH; see "Desktop app" in docs/CONTEXT.md.
#
#   desktop/build.sh            stable build → desktop/artifacts/ (DMG + update files)
#   desktop/build.sh dev        quick unpackaged build → desktop/build/dev-*/Booth-dev.app
set -euo pipefail

ENV="${1:-stable}"
DESKTOP="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$DESKTOP")"

# 1. Booth's production server, with only its runtime dependencies.
(cd "$ROOT" && bun run build)
STAGE="$DESKTOP/booth"
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp -R "$ROOT/build" "$STAGE/build"
cp -R "$ROOT/src/lib/server/db/migrations" "$STAGE/migrations"
cp "$DESKTOP/settings.env.example" "$STAGE/"
cp "$ROOT/package.json" "$ROOT/bun.lock" "$STAGE/"
(cd "$STAGE" && bun install --production --frozen-lockfile --ignore-scripts)
rm "$STAGE/package.json" "$STAGE/bun.lock"

# 2. Dock icon, drawn by the same script as the web icons.
rm -rf "$DESKTOP/icon.iconset"
bun "$ROOT/scripts/gen-icons.ts" --mac "$DESKTOP/icon.iconset"

# 3. The app.
cd "$DESKTOP"
hutch install --frozen-lockfile
rm -rf artifacts
hutch electrobun build --env="$ENV"
