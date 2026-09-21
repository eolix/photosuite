# Zstandard (WASM)

`zstd.wasm` — a decompress-only WebAssembly build of
[Zstandard](https://github.com/facebook/zstd), used to inflate zstd-compressed
streams (e.g. inside Adobe Illustrator `.ai` payloads and some raster codecs).

| | |
|---|---|
| **Upstream** | [facebook/zstd](https://github.com/facebook/zstd) |
| **License** | BSD-3-Clause (see `LICENSE`; zstd is dual BSD/GPLv2, BSD chosen here) |
| **Exports** | `ZSTD_decompress`, `ZSTD_getFrameContentSize` (decompress only) |
| **Loaded by** | `src/document/formats/ai-format-loader.js` and `src/document/io/codecs/raster-ext-codecs.js`, via BINDB key `wasm/zstd` (`src/index.html`) |

## Provenance

Identified by its `ZSTD_*` export surface (the Zstandard C API). Prebuilt
binary; the stripped module records no version string, so the exact upstream
commit is not captured here. A from-source `build.sh` is a future step — for now
provenance-only (permissive license, attribution satisfied by `LICENSE`).
