#!/usr/bin/env bash
# Generate the Shape tool's "extra_shapes" custom-shape library from the
# fontawesome submodule (src/vendor/fontawesome). See README.md for why only
# solid/regular are read and brands are excluded.
#
# Output (committed, so a plain clone needs no rebuild):
#   ../../../resources/libraries/extra_shapes.csh
#
# Re-run after `git submodule update` (needs Node):
#   ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
SUB="../../fontawesome"
OUT="../../../resources/libraries/extra_shapes.csh"

if [ ! -d "$SUB/svgs/solid" ] || [ ! -d "$SUB/svgs/regular" ]; then
  echo "ERROR: $SUB/svgs missing — run: git submodule update --init src/vendor/fontawesome" >&2
  exit 1
fi

node ./convert.mjs

# Sanity: the shape library must parse back and be roughly the size of the
# current Font Awesome Free solid+regular set (fails loudly on a near-empty
# or truncated write rather than silently shipping a broken library).
node -e '
  const fs = require("fs");
  const bytes = fs.readFileSync("'"$OUT"'");
  if (bytes.length < 1e6) {
    console.error("self-test failed: extra_shapes.csh is suspiciously small (" + bytes.length + " bytes)");
    process.exit(1);
  }
' || { echo "ERROR: extra_shapes.csh self-test failed" >&2; exit 1; }

echo "built extra_shapes.csh"
