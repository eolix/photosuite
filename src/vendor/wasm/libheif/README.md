# libheif (WASM)

`libheif.wasm` plus its `libheif.js` loader — a WebAssembly build of
[libheif](https://github.com/strukturag/libheif), the ISO/IEC 23008-12 (HEIF)
reader. Used to decode `.heic` / `.heif` stills to RGBA.

| | |
|---|---|
| **Upstream** | [strukturag/libheif](https://github.com/strukturag/libheif) — pinned submodule at `src/vendor/libheif` @ `v1.23.2` |
| **License** | **LGPL-3.0-or-later** (see `LICENSE`) |
| **Decoder** | HEVC through [libde265](https://github.com/strukturag/libde265) `1.0.15` (LGPL-3.0), statically linked. AOM is off — AVIF goes through the host WebView instead |
| **Exports** | `HeifDecoder`, `HeifImage` (`get_width`, `get_height`, `display`, `free`) |
| **Loaded by** | `src/document/formats/codecs/heic.js` — `libheif.js` as a `<script>` global from `index.html`, the `.wasm` fetched on first HEIC open through `BINDB["wasm/libheif"]` |

The two files are one build artifact pair: the loader carries the JS bindings
emscripten generated for this exact binary, so they are replaced together.

`libheif.js` compiles its wasm synchronously, which Chromium — and so WebView2 —
refuses on the main thread for anything over 4 KB. `heic.js` therefore compiles
the binary itself with `WebAssembly.compile` and hands the ready module to the
loader through emscripten's `instantiateWasm` hook.

## License notice (LGPL-3.0+)

This product includes libheif and libde265, licensed under the GNU Lesser
General Public License, version 3 or later. The full license text is in
`LICENSE`.

LGPL compliance for this statically-linked WebAssembly module is satisfied by
providing the **corresponding source** and the **means to relink**:

- The corresponding source is the pinned submodule at `src/vendor/libheif`
  (`v1.23.2`, unmodified upstream). libde265 `1.0.15` is fetched from its
  upstream release tarball by that source's own build script.
- `build.sh` regenerates both files from that source (or from a modified copy
  of it), documenting the toolchain — this is the relink path.
- The app loads the binary at runtime from a plain file; replacing
  `libheif.wasm` and `libheif.js` with a rebuilt pair needs no other change.

## Reproduction

```sh
git submodule update --init src/vendor/libheif
src/vendor/wasm/libheif/build.sh    # needs emscripten 3.1.61, cmake, node
```

The checked-in binary is prebuilt, taken from
[`libheif-js`](https://github.com/catdad-experiments/libheif-js) `1.23.2`, whose
CI runs the same upstream `build-emscripten.sh` against this same commit. To
guarantee byte-for-byte source↔binary correspondence (and the cleanest LGPL
posture), run `build.sh` and let its output replace the prebuilt pair.
