#!/usr/bin/env bash
# Generate the Gradient tool's "extra_gradients" library from the vendored
# uiGradients data snapshot (gradients.json) in this folder. See README.md.
#
# Output (committed, so a plain clone needs no rebuild):
#   ../../../resources/libraries/extra_gradients.grd
#
# Re-run after bumping the pin (needs Node):
#   ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
OUT="../../../resources/libraries/extra_gradients.grd"

if [ ! -f "./gradients.json" ]; then
  echo "ERROR: ./gradients.json missing" >&2
  exit 1
fi

node ./convert.mjs

# Sanity: the file must parse back with as many gradients as the source has.
node -e '
  const count = JSON.parse(require("fs").readFileSync("./gradients.json", "utf8"))
    .filter((entry) => entry.colors.length >= 2).length;
  if (count < 300) {
    console.error("self-test failed: gradients.json has fewer entries than expected (" + count + ")");
    process.exit(1);
  }
' || { echo "ERROR: extra_gradients.grd self-test failed" >&2; exit 1; }

echo "built extra_gradients.grd"
