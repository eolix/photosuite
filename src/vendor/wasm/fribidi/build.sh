#!/usr/bin/env bash
#
# Rebuild fribidi.wasm from the pinned upstream/ source.
#
# This script is the LGPL-2.1 "means to relink": it lets anyone regenerate the
# shipped binary from the corresponding source in ./upstream (or from a modified
# copy of it). It documents the toolchain and flags; it does not need to have
# been run to be valid — it needs to enable a rebuild.
#
# Prerequisites (not installed by this repo):
#   - Emscripten SDK (emcc) on PATH.
#   - meson + ninja (used once to generate fribidi-config.h and the Unicode
#     character-type tables under gen.tab/, which FriBidi's build produces from
#     the Unicode data files).
#
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# Pinned corresponding source lives with the other vendored submodules, flat
# under src/vendor/ (see ../../fribidi, submodule fribidi/fribidi @ v1.0.16).
SRC="$HERE/../../fribidi"

# 1. Generate config header + tables with a native meson configure pass.
#    (FriBidi derives fribidi-config.h and gen.tab/*.tab.i at build-configure
#    time; emcc then compiles the C sources against them.)
meson setup "$SRC/_gen" "$SRC" >/dev/null
ninja -C "$SRC/_gen" gen.tab/all 2>/dev/null || true

# 2. Compile the library to a standalone wasm exporting only what the app calls
#    (see ../README and src/layers/layer-channel-canvas-adjust.js).
EXPORTS='["_fribidi_get_bidi_types","_fribidi_get_bracket_types","_fribidi_get_par_embedding_levels_ex","_fribidi_utf8_to_unicode","_malloc","_free"]'

emcc \
  -Os -flto \
  -I "$SRC/lib" -I "$SRC/_gen" -I "$SRC/_gen/lib" -I "$SRC/gen.tab" \
  -DHAVE_CONFIG_H -DFRIBIDI_BUILD \
  "$SRC"/lib/*.c \
  -s EXPORTED_FUNCTIONS="$EXPORTS" \
  -s STANDALONE_WASM=1 \
  -s ERROR_ON_UNDEFINED_SYMBOLS=0 \
  --no-entry \
  -o "$HERE/fribidi.wasm"

echo "wrote $HERE/fribidi.wasm"
