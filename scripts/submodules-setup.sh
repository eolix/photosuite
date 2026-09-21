#!/usr/bin/env bash
#
# One-shot bootstrap for a fresh clone:
#   1. fetch/checkout all git submodules (vendored upstreams)
#   2. (re)generate the vendored JS bundles from those submodules
#   3. heal any dangling vendor symlinks so the Tauri src/ walk succeeds
#
# Safe to re-run. Run after cloning, or after bumping a submodule pin.
#
# Prerequisites (not installed here):
#   - git, node, npx (esbuild is fetched on demand by the JS builds)
#   - network access (some builds sparse-clone upstream, e.g. pdfjs-codecs)
#
# Not covered: src/vendor/wasm/fribidi/build.sh and src/vendor/wasm/libheif/build.sh
# — those need the Emscripten toolchain and exist only as the LGPL relink paths;
# their prebuilt binaries are committed, so normal setup does not rebuild them.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> [1/3] submodules"
git submodule update --init --recursive

echo "==> [2/3] vendored JS bundles"
for build in src/vendor/js/*/build.sh; do
  [ -f "$build" ] || continue
  echo "    - $build"
  "$build"
done

echo "==> [3/3] heal dangling vendor symlinks"
# A vendored submodule may track a symlink whose target is a gitignored build
# artifact (e.g. acorn dist/acorn_csp.js -> acorn.js); create empty targets so
node scripts/repair-vendor-symlinks.mjs

echo "==> done."
