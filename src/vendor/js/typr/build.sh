#!/usr/bin/env bash
# Generate the Typr scripts loaded by the app from the photopea/Typr.js submodule
# (src/vendor/typr). See README.md for why this build step exists.
#
# Output (committed, so a plain clone needs no rebuild):
#   Typr.js, Typr.U.js (patched), Typr.U.SVG.js, LICENSE
#
# Re-run after `git submodule update`:
#   ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
SUB="../../typr"
SRC="$SUB/src"

cp "$SRC/Typr.js"        ./Typr.js
cp "$SRC/Typr.U.SVG.js"  ./Typr.U.SVG.js
cp "$SUB/LICENSE"        ./LICENSE

# Re-enable WASM memory growth in shapeHB (uncomment the two guarded lines).
# Upstream gh-pages ships these commented, which overflows hb.wasm's heap on
# fonts larger than the initial page.
sed -E \
  -e 's#^([[:space:]]*)//(var olen = mem\.buffer\.byteLength.*)$#\1\2#' \
  -e 's#^([[:space:]]*)//(if\(olen<nlen\) mem\["grow"\].*)$#\1\2#' \
  "$SRC/Typr.U.js" > ./Typr.U.js

# Fail loudly if the upstream lines moved and the patch became a no-op.
if grep -qE '^[[:space:]]*var olen = mem\.buffer\.byteLength' ./Typr.U.js \
   && grep -qE '^[[:space:]]*if\(olen<nlen\) mem\["grow"\]' ./Typr.U.js; then
  echo "built Typr.js, Typr.U.js (memory-growth patch applied), Typr.U.SVG.js, LICENSE"
else
  echo "ERROR: memory-growth patch did not apply — upstream Typr.U.js changed; update build.sh" >&2
  exit 1
fi
