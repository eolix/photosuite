#!/usr/bin/env bash
# Generate the EXR loader bundle from the parse-exr submodule (src/vendor/parse-exr, v1.0.2).
#
# parse-exr is a dependency-light port of three.js's EXRLoader. entry.js wraps it as the
# global `EXRLoader.parse(buffer)` returning Float32 RGBA pixels — the API the app used.
# esbuild bundles entry.js together with parse-exr and its only runtime dep (fflate) into a
# single self-contained IIFE (so no global pako is needed any more). Output was verified
# pixel-identical to the previous ext-exr.js on ZIP / PIZ / uncompressed test files.
#
# Output (committed, so a plain clone needs no rebuild): exr.js, LICENSE
#
# Re-run after `git submodule update` (needs Node + npx):
#   ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
SUB="../../parse-exr"

# parse-exr imports fflate; install it so esbuild can bundle it in.
# --no-package-lock keeps the submodule's working tree clean.
(cd "$SUB" && npm install --silent --no-audit --no-fund --no-package-lock)

npx --yes esbuild entry.js --bundle --format=iife --legal-comments=none > ./exr.js
cp "$SUB/LICENSE.md" ./LICENSE

# Sanity: the global must expose parse().
node -e 'global.globalThis=global; new Function(require("fs").readFileSync("./exr.js","utf8"))(); if(typeof globalThis.EXRLoader.parse!=="function"){console.error("self-test failed");process.exit(1);}' \
  || { echo "ERROR: exr.js self-test failed — parse-exr/esbuild changed; check build.sh" >&2; exit 1; }

echo "built exr.js (global EXRLoader.parse)"
