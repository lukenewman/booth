#!/bin/bash
# Starts booth and opens it in the browser. Closing this window stops booth.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="$HOME/.booth"
PORT="${BOOTH_PORT:-4747}"
URL="http://localhost:$PORT"

mkdir -p "$DATA"
if [ ! -f "$DATA/settings.env" ]; then
  cp "$HERE/app/settings.env.example" "$DATA/settings.env"
fi
# No Discogs token yet: open the settings file so it can be pasted in.
if ! grep -qE '^DISCOGS_TOKEN=.+' "$DATA/settings.env"; then
  open -e "$DATA/settings.env"
fi

# Already running (another window, or a previous launch)? Just open it.
if curl -fs -o /dev/null "$URL/api/sources"; then
  open "$URL"
  exit 0
fi

echo "Starting booth at $URL — keep this window open while you use it."
(
  for _ in $(seq 1 60); do
    if curl -fs -o /dev/null "$URL/api/sources"; then open "$URL"; exit 0; fi
    sleep 0.5
  done
  echo "booth didn't start — see the messages above." >&2
) &

cd "$DATA"
export PORT HOST=127.0.0.1 BOOTH_MIGRATIONS_DIR="$HERE/app/migrations"
exec "$HERE/app/runtime/bun" --env-file="$DATA/settings.env" "$HERE/app/build/index.js"
