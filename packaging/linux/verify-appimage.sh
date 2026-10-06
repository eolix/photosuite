#!/usr/bin/env bash
# Structural and delta-update checks on the exact AppImage about to be published. The AppImage
# is only unpacked, never launched, so this runs on a headless runner.
#
#   packaging/linux/verify-appimage.sh [dist/release/photosuite-<version>-linux-<arch>.AppImage]
#
# With no argument it checks the one AppImage in $DIST (default dist/release). Needs python3,
# zsync, desktop-file-utils (desktop-file-validate) and appstream (appstreamcli).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST="${DIST:-$ROOT/dist/release}"
APP_ID=io.github.eolix.PhotoSuite

if [ $# -gt 0 ]; then
  image="$1"
else
  shopt -s nullglob
  images=("$DIST"/*.AppImage)
  [ ${#images[@]} -eq 1 ] || { echo "expected one AppImage in $DIST, found ${#images[@]}" >&2; exit 1; }
  image="${images[0]}"
fi
image="$(cd "$(dirname "$image")" && pwd)/$(basename "$image")"
name="$(basename "$image")"

# The name must match the glob in the embedded update information, or AppImageUpdate would look
# for a .zsync the release doesn't carry.
case "$name" in
  photosuite-*-linux-x86_64.AppImage) arch=x86_64 ;;
  photosuite-*-linux-aarch64.AppImage) arch=aarch64 ;;
  *) echo "unexpected AppImage name: $name" >&2; exit 1 ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chmod +x "$image"

# A type-2 AppImage, and a .zsync control file that describes these bytes.
python3 - "$image" <<'PY'
import sys
from pathlib import Path

image = Path(sys.argv[1])
with image.open('rb') as f:
    header = f.read(11)
assert header[:4] == b'\x7fELF' and header[8:11] == b'AI\x02', 'not a type-2 AppImage'

control = Path(str(image) + '.zsync').read_bytes().split(b'\n\n', 1)[0].decode('utf-8')
fields = dict(line.split(': ', 1) for line in control.splitlines() if ': ' in line)
assert fields.get('Filename') == image.name, f"zsync Filename is {fields.get('Filename')!r}"
assert fields.get('URL') == image.name, f"zsync URL is {fields.get('URL')!r} (must be relative)"
assert int(fields.get('Length', -1)) == image.stat().st_size, 'zsync Length does not match the file'
PY

# The payload: a valid desktop entry, valid AppStream metadata, and the notices.
(
  cd "$work"
  env -u APPIMAGE_EXTRACT_AND_RUN "$image" --appimage-extract >/dev/null
  desktop-file-validate "squashfs-root/$APP_ID.desktop"
  # Errors fail; warnings are reported only, so a new style hint in a later appstream release
  # doesn't block a release.
  report="$(appstreamcli validate --no-net "squashfs-root/usr/share/metainfo/$APP_ID.metainfo.xml" 2>&1 || true)"
  echo "$report"
  if grep -q '^E:' <<<"$report"; then
    echo "AppStream metadata has errors" >&2
    exit 1
  fi
  for f in LICENSE-MIT LICENSE-APACHE NOTICE THIRD-PARTY-NOTICES.md THIRD-PARTY-CRATES.md; do
    test -s "squashfs-root/usr/share/doc/photosuite/$f" || { echo "missing from the AppImage: $f" >&2; exit 1; }
  done
  test -d squashfs-root/usr/share/photosuite/resources || { echo "missing from the AppImage: resources" >&2; exit 1; }

  # A delta update only helps if the control file can rebuild the image: rebuild it from
  # itself and compare byte for byte.
  zsync -q -i "$image" -o reconstructed.AppImage "$image.zsync"
  cmp "$image" reconstructed.AppImage
)

# Without this AppImageUpdate can't find the .zsync, and updates silently never happen.
repo="${PHOTOSUITE_UPDATE_REPO:-${GITHUB_REPOSITORY:-eolix/photosuite}}"
expected="gh-releases-zsync|${repo%%/*}|${repo#*/}|latest|photosuite-*-linux-$arch.AppImage.zsync"
actual="$(env -u APPIMAGE_EXTRACT_AND_RUN "$image" --appimage-updateinformation)"
if [ "$actual" != "$expected" ]; then
  echo "embedded update information mismatch" >&2
  echo "  expected: $expected" >&2
  echo "  actual:   $actual" >&2
  exit 1
fi

echo "AppImage OK: $name"
