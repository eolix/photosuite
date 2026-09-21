# stb_image (WASM)

`jpg.wasm` — a decode-only WebAssembly build of [stb_image](https://github.com/nothings/stb)
(`stb_image.h`), used to decode JPEG (and other raster) bytes to RGBA.

| | |
|---|---|
| **Upstream** | [nothings/stb](https://github.com/nothings/stb) — `stb_image.h` (v2.30 at time of writing) |
| **License** | Public domain **or** MIT (dual; see `LICENSE`) |
| **Exports** | `stbi_load_from_memory`, `malloc`, `free` (no host imports) |
| **Loaded by** | `src/document/io/codecs/jpeg-codec.js` → `jpegCodec.decodeViaWasmStbi`, via BINDB key `wasm/jpg` (`src/index.html`) |

## Provenance

Identified unambiguously by its single public export `stbi_load_from_memory` —
the exact public API of `stb_image.h` and of no other library. Prebuilt binary;
the stripped module records no version string, so the exact source revision is
not captured here.

stb_image is public domain / MIT, so there is no obligation to retain source or
a build script — this is provenance-only, on par with the other permissive
binaries here. (Should byte-level reproducibility ever be wanted, stb_image.h is
a single public-domain header that builds to this exact export signature with a
decode-only, `STBI_NO_STDIO` emscripten wrapper.)
