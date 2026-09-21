#!/bin/sh
# Regenerate only the five icons listed in src-tauri/tauri.conf.json bundle.icon.
# Source: src/assets/img/icon_full.png (do not use icon256/icon512 here).
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="${ICON_SRC:-$ROOT/src/assets/img/icon_full.png}"
OUT="$ROOT/src-tauri/icons"

if [ ! -f "$SRC" ]; then
  echo "error: missing source icon: $SRC" >&2
  exit 1
fi

mkdir -p "$OUT"

echo "Generating desktop bundle icons from $SRC (tauri → temp, five files only)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
(cd "$ROOT" && npx tauri icon "$SRC" -o "$TMP" >/dev/null)

for name in 32x32.png 128x128.png 128x128@2x.png icon.icns icon.ico; do
  mv "$TMP/$name" "$OUT/$name"
done
rm -rf "$TMP"
trap - EXIT HUP INT TERM

echo "done: $OUT (32x32, 128x128, 128x128@2x, icon.icns, icon.ico)"
