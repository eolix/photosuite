#!/usr/bin/env bash
#
# Rebuild libheif.wasm and its libheif.js loader from the pinned ../../libheif
# source.
#
# This script is the LGPL-3.0 "means to relink": it lets anyone regenerate the
# shipped binary from the corresponding source (or from a modified copy of it).
# It documents the toolchain and flags; it does not need to have been run to be
# valid — it needs to enable a rebuild.
#
# Prerequisites (not installed by this repo):
#   - Emscripten SDK 3.1.61 (emcc, emcmake on PATH; `source emsdk_env.sh`).
#   - cmake, make, autoconf/libtool, curl, node.
#   - TypeScript 5 (`npm i -g typescript@5`) for the .d.ts pass.
#   - Network access: libheif's own build fetches the libde265 release tarball.
#
# Not run by scripts/submodules-setup.sh — that loop only covers
# src/vendor/js/*/build.sh, which need Node alone. The committed binary here is
# what a plain clone uses.
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# Pinned corresponding source, flat under src/vendor/ with the other vendored
# submodules (submodule strukturag/libheif @ v1.23.2).
SRC="$HERE/../../libheif"
BUILD="$SRC/buildjs"

# Decoder set: HEVC through libde265 (the codec HEIC files carry). AOM stays off
# — AVIF is decoded by the host WebView in src/document/formats/codecs/avif.js,
# so an AV1 decoder here would be ~1 MB of wasm nothing calls.
#
# USE_UNSAFE_EVAL=0 keeps the loader free of `new Function`, which WebView2's
# stricter CSP rejects. USE_WASM=1 emits the .wasm binary next to the loader
# rather than an asm.js blob.
mkdir -p "$BUILD"
cd "$BUILD"
ENABLE_LIBDE265=1 LIBDE265_VERSION=1.0.15 \
ENABLE_AOM=0 \
USE_WASM=1 USE_TYPESCRIPT=1 USE_UNSAFE_EVAL=0 \
  ../build-emscripten.sh ..

cp "$BUILD/libheif.js" "$HERE/libheif.js"
cp "$BUILD/libheif.wasm" "$HERE/libheif.wasm"
cp "$SRC/COPYING" "$HERE/LICENSE"

# Sanity: the loader must expose the decode surface the codec calls.
node -e '
const factory = require("'"$HERE"'/libheif.js");
const compiled = new WebAssembly.Module(require("fs").readFileSync("'"$HERE"'/libheif.wasm"));
const lib = factory({
  instantiateWasm: (imports, onSuccess) => onSuccess(new WebAssembly.Instance(compiled, imports), compiled),
});
if (typeof lib.HeifDecoder !== "function") { console.error("self-test failed"); process.exit(1); }
' || { echo "ERROR: libheif self-test failed — upstream build output changed; check build.sh" >&2; exit 1; }

echo "wrote $HERE/libheif.js and $HERE/libheif.wasm"
