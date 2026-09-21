# HarfBuzz (WASM)

`hb.wasm` — a WebAssembly build of [HarfBuzz](https://github.com/harfbuzz/harfbuzz),
the OpenType text-shaping engine. Used to turn Unicode runs + a font into
positioned glyphs (complex scripts, ligatures, kerning).

| | |
|---|---|
| **Upstream** | [harfbuzz/harfbuzz](https://github.com/harfbuzz/harfbuzz) |
| **License** | "Old MIT" — permissive (see `LICENSE`) |
| **Exports** | `hb_blob_*`, `hb_buffer_*`, `hb_face_*`, `hb_font_*`, `hb_shape` |
| **Loaded by** | `src/layers/layer-channel-canvas-adjust.js` → `Typr.U.initHB("vendor/wasm/harfbuzz/hb.wasm", …)` |

## Provenance

Identified by its `hb_*` export surface (the HarfBuzz C API). Prebuilt binary —
the stripped module carries no embedded version/toolchain string, so the exact
upstream commit is not recorded here. A from-source `build.sh` (submodule +
emscripten) is a future step; for now this is provenance-only (permissive
license, attribution satisfied by `LICENSE`).
