#!/bin/bash
# Builds the downloadable Mac zips: dist/Booth-<version>-mac-<arch>.zip.
# Each one bundles the Bun runtime, so the person running it needs nothing
# installed. Usage: packaging/build-mac.sh [arm64|x64]...  (default: both)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${BOOTH_VERSION:-$(git describe --tags --always --dirty)}"
BUN_VERSION="$(bun --version)"
ARCHES=("$@"); [ ${#ARCHES[@]} -eq 0 ] && ARCHES=(arm64 x64)

bun run build

# Arch-independent part, staged once: built server, its runtime deps, migrations.
STAGE="$ROOT/dist/stage"
rm -rf "$STAGE" && mkdir -p "$STAGE/app"
cp -R build "$STAGE/app/build"
cp package.json bun.lock "$STAGE/app/"
cp -R src/lib/server/db/migrations "$STAGE/app/migrations"
cp desktop/settings.env.example "$STAGE/app/"
(cd "$STAGE/app" && bun install --production --frozen-lockfile --ignore-scripts)
rm "$STAGE/app/package.json" "$STAGE/app/bun.lock"
if find "$STAGE/app/node_modules" -name '*.node' | grep -q .; then
  echo "native module in node_modules — zips would not be arch-independent" >&2
  exit 1
fi
echo "$VERSION" > "$STAGE/app/VERSION"

for ARCH in "${ARCHES[@]}"; do
  case "$ARCH" in
    arm64) BUN_TARGET=bun-darwin-aarch64 ;;
    x64)   BUN_TARGET=bun-darwin-x64-baseline ;;  # runs on Intel Macs without AVX2
    *) echo "unknown arch: $ARCH" >&2; exit 1 ;;
  esac

  OUT="$ROOT/dist/$ARCH/Booth"
  rm -rf "$ROOT/dist/$ARCH" && mkdir -p "$OUT"
  cp -R "$STAGE/app" "$OUT/app"
  cp packaging/Booth.command packaging/README.txt "$OUT/"

  CACHE="$ROOT/dist/cache/$BUN_TARGET-$BUN_VERSION.zip"
  mkdir -p "$ROOT/dist/cache"
  [ -f "$CACHE" ] || curl -fL -o "$CACHE" \
    "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$BUN_TARGET.zip"
  mkdir -p "$OUT/app/runtime"
  unzip -jq "$CACHE" "$BUN_TARGET/bun" -d "$OUT/app/runtime"

  ZIP="$ROOT/dist/Booth-$VERSION-mac-$ARCH.zip"
  rm -f "$ZIP"
  (cd "$ROOT/dist/$ARCH" && ditto -c -k --keepParent Booth "$ZIP")
  echo "→ $ZIP ($(du -h "$ZIP" | cut -f1))"
done
