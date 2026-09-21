# libwebp (WASM)

`webp.wasm` — a decode-only WebAssembly build of
[libwebp](https://github.com/webmproject/libwebp), used to decode WebP image
bytes to RGBA.

| | |
|---|---|
| **Upstream** | [webmproject/libwebp](https://github.com/webmproject/libwebp) |
| **License** | BSD-3-Clause (see `LICENSE`) |
| **Exports** | `WebPDecodeARGB`, `WebPFree` (decode only) |
| **Loaded by** | `src/document/io/codecs/webp-bmp-codecs.js` → `initWebpWasmDecoder`, via BINDB key `wasm/webp` (`src/index.html`) |

> WebP **encoding** is handled separately by the project's own Rust module
> (`src/wasm/webp-encode.wasm`); this binary is decode only.

## Provenance

Identified by `WebPDecodeARGB`/`WebPFree` (the libwebp decode API). Prebuilt
binary; the stripped module records no version string, so the exact upstream
commit is not captured here. A from-source `build.sh` is a future step — for now
provenance-only (permissive license, attribution satisfied by `LICENSE`).
