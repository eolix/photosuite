# Vendored third-party code

Everything in this folder comes from somewhere else. Each library is pinned to a
specific upstream commit, keeps its own licence, and is listed below. The Pin
column names the tag where the checkout is one, or the branch it was taken
from; the exact commit is recorded in the gitlink and shown by
`git submodule status`.

Tauri serves `src/` as the web root, so these load as classic `<script>` globals
from [`../index.html`](../index.html) by relative path. Load order matters:
pako comes first because other libraries expect it.

> `src/wasm/` is **not** this folder — that is WebAssembly built from this
> repository (blur, median, WebP encode).

## Layout

```
src/vendor/
  <lib>/        git submodule, pinned upstream — loaded directly
  js/<lib>/     generated bundle + LICENSE + README + build.sh
  wasm/<lib>/   prebuilt .wasm + LICENSE + README (+ build.sh where required)
```

A library gets a `js/<lib>/` bundle when it needs a build, a wrapper, or a patch
to run here; otherwise its submodule is loaded straight from `index.html`.
Generated bundles are committed, so a plain clone runs without a build step.

## After cloning

```sh
bash scripts/submodules-setup.sh
```

Fetches every submodule, regenerates the bundles, and heals dangling vendor
symlinks. Re-run it after bumping a pin. It needs `git`, `node`, `npx` and
network access — some builds fetch esbuild or sparse-clone their upstream.

`wasm/fribidi/build.sh` and `wasm/libheif/build.sh` are not part of that run:
they need the Emscripten toolchain and exist as the LGPL relink paths. The
prebuilt binaries are committed.

## Libraries loaded directly

| Path | Upstream | Pin | Licence | Used for |
|------|----------|-----|---------|----------|
| `pako/` | [nodeca/pako](https://github.com/nodeca/pako) | `1.0.5` | MIT | zlib inflate/deflate |
| `paper/` | [paperjs/paper.js](https://github.com/paperjs/paper.js) | `v0.11.5` | MIT | vector path geometry and boolean ops |
| `upng/` | [photopea/UPNG.js](https://github.com/photopea/UPNG.js) | default branch | MIT | PNG and APNG |
| `utif/` | [photopea/UTIF.js](https://github.com/photopea/UTIF.js) | default branch | MIT | TIFF |
| `uzip/` | [photopea/UZIP.js](https://github.com/photopea/UZIP.js) | default branch | MIT | ZIP containers |
| `utex/` | [photopea/UTEX.js](https://github.com/photopea/UTEX.js) | default branch | MIT | TeX typesetting, DDS textures |
| `omggif/` | [deanm/omggif](https://github.com/deanm/omggif) | default branch | MIT | GIF read and write |
| `js-sha1/` | [emn178/js-sha1](https://github.com/emn178/js-sha1) | `v0.6.0` | MIT | SHA-1 digests |
| `pdfi/` | [eolix/PDFI.js](https://github.com/eolix/PDFI.js) | `master` | MIT | PDF, PostScript, EMF and WMF read/write |

**`pdfi/`** loads eight files in order and depends on pako. A fork of
NineBitsLLC/UDOC.js, itself a fork of won21kr/PDFI.js; the fork adds base-14
font-name normalization in `ToPDF`, without which saved PDFs reference missing
subset fonts and their text disappears in other viewers. The app uses only the
public surface: `UDOC.M/G/C/getState/getFont`, `From{PS,PDF,WMF,EMF}`,
`To{EMF,PDF}`.

## Libraries built into `js/`

| Bundle | Upstream | Pin | Licence | Notes |
|--------|----------|-----|---------|-------|
| `js/typr/` | [photopea/Typr.js](https://github.com/photopea/Typr.js) | `gh-pages` | MIT | Font parsing and HarfBuzz shaping |
| `js/acorn/` | [acornjs/acorn](https://github.com/acornjs/acorn) | `3.1.0` | MIT | JavaScript parser for the scripting engine |
| `js/exr/` | [dmnsgn/parse-exr](https://github.com/dmnsgn/parse-exr) | `v1.0.2` | MIT | OpenEXR; bundles fflate |
| `js/pdfjs-codecs/` | [mozilla/pdf.js](https://github.com/mozilla/pdf.js) | `v2.16.105` | Apache-2.0 | `JpegImage`, `JpxImage`, `Jbig2Image` as global `PDFJS` |
| `js/linear-solve/` | [lovasoa/linear-solve](https://github.com/lovasoa/linear-solve) | default branch | MIT | Linear systems; wrapped in an IIFE exposing global `linear` |
| `js/lensfun/` | [lensfun/lensfun](https://github.com/lensfun/lensfun) | default branch | LGPL (database CC) | `lens-database.json` for Lens Correction's Auto tab |

Why these pins:

- **acorn `3.1.0`** — the scripting engine calls `parse()` with no options, which
  acorn 8 rejects.
- **pdf.js `v2.16.105`** — the last release before the codecs moved to
  WebAssembly. `build.sh` sparse-clones roughly 6 MB of `src/`.
- **Typr** — this pin is newer than the API the shaping call sites were first
  written against: `shapeHB`/`shape` take an options object (`{ltr, fts, axs}`),
  not a boolean. `build.sh` also re-enables WASM memory growth, which upstream
  ships commented out; without it HarfBuzz overflows on `heapu8.set`.
- **lensfun** — only the measurement database is generated; the C++ library is
  not compiled or loaded.

## WebAssembly in `wasm/`

Binaries are committed so a clone needs no Emscripten. Each was identified by
its export surface rather than its filename, and ships with its licence.

| Path | Upstream | Identifying export | Licence |
|------|----------|--------------------|---------|
| `wasm/harfbuzz/hb.wasm` | [harfbuzz/harfbuzz](https://github.com/harfbuzz/harfbuzz) | `hb_shape`, `hb_buffer_*` | Old MIT |
| `wasm/fribidi/fribidi.wasm` | [fribidi/fribidi](https://github.com/fribidi/fribidi) `v1.0.16` | `fribidi_*` | **LGPL-2.1+** |
| `wasm/libwebp/webp.wasm` | [webmproject/libwebp](https://github.com/webmproject/libwebp) | `WebPDecodeARGB` | BSD-3 |
| `wasm/zstd/zstd.wasm` | [facebook/zstd](https://github.com/facebook/zstd) | `ZSTD_decompress` | BSD-3 |
| `wasm/stb-image/jpg.wasm` | [nothings/stb](https://github.com/nothings/stb) `stb_image.h` | `stbi_load_from_memory` | Public domain / MIT |
| `wasm/libheif/libheif.wasm` | [strukturag/libheif](https://github.com/strukturag/libheif) `v1.23.2` | `HeifDecoder` (through `libheif.js`) | **LGPL-3.0+** |

FriBidi and libheif are LGPL, so their folders also carry the matching source
(submodules `fribidi/` @ `v1.0.16` and `libheif/` @ `v1.23.2`) and a `build.sh`
as the relink path the licence requires. The others are permissive and ship with
provenance only.

**`wasm/libheif/`** is the one folder here holding a `.js` file as well: an
emscripten build is a `.wasm` binary plus the loader carrying its generated
bindings, and the two are replaced together. `libheif.js` loads from
`index.html` as the global `libheif`; the binary is fetched on the first HEIC
open. It decodes HEVC through libde265 `1.0.15` (also LGPL-3.0, linked in). AOM
is off, so AVIF still goes to the host WebView.

HarfBuzz and FriBidi are fetched at runtime by
[`features/text/text-layout.js`](../features/text/text-layout.js). The rest are
resolved through the `BINDB` map in [`../index.html`](../index.html), libheif
included (`wasm/libheif`).

## Conventions

- Vendored code keeps its upstream style, naming and licence headers. It is
  excluded from linting and from the project's own naming rules — do not
  reformat or rename inside these folders.
- Patch upstream through `build.sh` rather than by editing generated output, so
  the change survives the next regeneration.
- Every folder under `js/` and `wasm/` carries a `LICENSE` and a `README.md`
  giving its upstream URL, pinned ref, licence and build command.
