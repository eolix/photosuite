# Third-party notices

PhotoSuite is distributed under the GNU General Public License v3.0 — see
[`LICENSE`](LICENSE). Its complete corresponding source, including every build
script named below, is at <https://github.com/eolix/photosuite>.

This file collects the attribution and licence notices for the third-party works
included in that source tree and in the distributed application. It is packaged
with the application, so a recipient of a binary has it without going back to
the repository.

## Where the full licence texts are

Each vendored library keeps its own unmodified licence text next to its code:
`src/vendor/<lib>/LICENSE`, `src/vendor/js/<lib>/LICENSE`,
`src/vendor/wasm/<lib>/LICENSE`, `src/assets/ico/LICENSE`. Tauri serves `src/`
as the application's web root and packages that tree into the binary, so those
texts travel with the application as well as with the source.

Libraries loaded straight from their upstream checkout (`pako`, `paper`, `upng`,
`utif`, `uzip`, `utex`, `omggif`, `js-sha1`, `pdfi`, `acorn`, `parse-exr`) keep
their licence text inside their own submodule. `scripts/submodules-setup.sh`
fetches them; a build made without running it has neither the code nor the text.

---

## GNU Lesser General Public License

The application includes the following LGPL works as WebAssembly modules.
The LGPL requires that a recipient be able to modify the library and relink it
into the application. Each module below is loaded from a plain file at runtime,
so relinking means replacing that file — no other part of the application has to
be rebuilt or relinked.

### FriBidi — LGPL-2.1-or-later

This product includes [FriBidi](https://github.com/fribidi/fribidi), used for
bidirectional text ordering, licensed under the GNU Lesser General Public
License version 2.1 or later. Full text: `src/vendor/wasm/fribidi/LICENSE`.

| | |
|---|---|
| Binary in the application | `src/vendor/wasm/fribidi/fribidi.wasm` |
| Corresponding source | submodule `src/vendor/fribidi`, pinned at `v1.0.16` (unmodified upstream) |
| Relink | `src/vendor/wasm/fribidi/build.sh` — needs the Emscripten SDK; see that folder's `README.md` for the pinned toolchain version and flags |

### libheif and libde265 — LGPL-3.0-or-later

This product includes [libheif](https://github.com/strukturag/libheif) and
[libde265](https://github.com/strukturag/libde265), used to decode HEIF/HEIC
images, licensed under the GNU Lesser General Public License version 3 or later.
Full text: `src/vendor/wasm/libheif/LICENSE`.

| | |
|---|---|
| Binary in the application | `src/vendor/wasm/libheif/libheif.wasm` and its generated loader `libheif.js` (one build artifact pair — replace both together) |
| Corresponding source | submodule `src/vendor/libheif`, pinned at `v1.23.2` (unmodified upstream). libde265 `1.0.15` is fetched from its upstream release tarball by that source's own build script rather than vendored here |
| Relink | `src/vendor/wasm/libheif/build.sh` — needs Emscripten, CMake and Node |

The committed `libheif.wasm` / `libheif.js` pair is prebuilt, taken from
[`libheif-js`](https://github.com/catdad-experiments/libheif-js) `1.23.2`, whose
CI runs the same upstream `build-emscripten.sh` against the same upstream commit
as the pinned submodule. Running `build.sh` regenerates both files from the
pinned source directly.

### Lensfun — LGPL-3.0

The camera and lens measurement database in `src/vendor/js/lensfun/` is derived
from [Lensfun](https://github.com/lensfun/lensfun). The Lensfun library itself is
LGPL-3.0 and is **not** compiled into or linked with this application — only its
database is used, under the licence in the next section.

---

## Apache License 2.0 — pdf.js

This product includes image decoders from
[Mozilla pdf.js](https://github.com/mozilla/pdf.js) (`JpegImage`, `JpxImage`,
`Jbig2Image`), Copyright the pdf.js contributors, licensed under the Apache
License, Version 2.0. Full text: `src/vendor/js/pdfjs-codecs/LICENSE`.

**Statement of changes** (Apache-2.0 §4(b)). `src/vendor/js/pdfjs-codecs/pdfjs-codecs.js`
is a modified redistribution of pdf.js `v2.16.105`, produced by
`src/vendor/js/pdfjs-codecs/build.sh`. The changes are:

- the three decoders are extracted from `src/` and bundled into a single file
  exposing the global `PDFJS`, using esbuild;
- `src/shared/compatibility.js` is emptied — it only loads core-js polyfills for
  legacy browsers and is not decoder code;
- a `var PDFJSDev = { test: () => false }` banner is prepended, which makes
  pdf.js's development-only guards evaluate false and drops its assert and debug
  blocks, as a production build would;
- the bundler is run with `--legal-comments=none`, so per-file copyright
  comments from the original sources are not carried into the generated bundle.
  The complete, unmodified `LICENSE` ships beside it and is packaged with the
  application.

The same `--legal-comments=none` applies to the generated bundles in
`src/vendor/js/acorn/` and `src/vendor/js/exr/` (both MIT); their `LICENSE`
files likewise ship beside them.

---

## Creative Commons Attribution-ShareAlike 3.0 — Lensfun database

`src/vendor/js/lensfun/lens-database.json` is adapted from the
[Lensfun](https://github.com/lensfun/lensfun) camera and lens measurement
database, © the Lensfun project and contributors, licensed under
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Full text:
`src/vendor/js/lensfun/LICENSE`.

It is an adaptation: `build.sh` and `convert.mjs` convert the upstream XML
database into JSON, keeping the distortion, TCA and vignetting models used by
the Lens Correction filter. **The copy inside the installed application remains
licensed under CC BY-SA 3.0**, as does any further adaptation of it.

---

## Creative Commons Attribution-ShareAlike 3.0 — Subtle Patterns

`src/resources/startup/patterns.pat` and
`src/resources/libraries/extra_patterns.pat` are adapted from
[Subtle Patterns](https://github.com/atlemo/SubtlePatterns), © Toptal with
individual patterns credited to their original designers, licensed under
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Full text and
attribution: `src/resources/libraries/LICENSE-subtlepatterns.txt`.

It is an adaptation: the upstream 341-pattern archive is split into a small
seed set (the patterns loaded into the Pattern tool on every launch) and the
rest (loaded on demand from the tool's "bundled library" row), with the
upstream credit-tile pattern entry dropped from both. **Both files remain
licensed under CC BY-SA 3.0**, as does any further adaptation of them.

---

## Creative Commons Attribution-NoDerivatives / Attribution-ShareAlike — Brusheezy brushes

Three "bundled library" rows in the Brush tool's picker are unmodified brush
packs from individual [Brusheezy](https://www.brusheezy.com) artists. Full
license text and attribution: `src/resources/libraries/LICENSE-brusheezy-brushes.txt`.

| File | Artist | Licence |
|---|---|---|
| `src/resources/libraries/Markers.abr` | brushchick | **CC BY-ND** — commercial use allowed, attribution required, **no modification** |
| `src/resources/libraries/Paintbrush_Set.abr` | lovelace | **CC BY-ND** — commercial use allowed, attribution required, **no modification** |
| `src/resources/libraries/Pencil_Scribbles.abr` | stuffwemake | **CC BY-SA** — attribution required; any adaptation stays CC BY-SA |

All three are used byte-identical to their upstream download — this matters
in particular for the two CC BY-ND files, whose license does not permit
modification in any form.

---

## MIT — uiGradients

`src/resources/libraries/extra_gradients.grd` is generated from
[ghosh/uiGradients](https://github.com/ghosh/uiGradients) (382 community-contributed
gradients), MIT licensed. The upstream `gradients.json` snapshot and licence text are
vendored at `src/vendor/js/uigradients/`; `src/vendor/js/uigradients/build.sh` converts
it into the `.grd` format.

---

## Web libraries vendored in `src/vendor`

Pinned upstream commits are recorded in the gitlinks and listed in
[`src/vendor/README.md`](src/vendor/README.md), which also documents why each pin
was chosen and how each generated bundle is produced.

| Library | Upstream | Licence |
|---------|----------|---------|
| pako | [nodeca/pako](https://github.com/nodeca/pako) | MIT |
| Paper.js | [paperjs/paper.js](https://github.com/paperjs/paper.js) | MIT |
| UPNG.js | [photopea/UPNG.js](https://github.com/photopea/UPNG.js) | MIT |
| UTIF.js | [photopea/UTIF.js](https://github.com/photopea/UTIF.js) | MIT |
| UZIP.js | [photopea/UZIP.js](https://github.com/photopea/UZIP.js) | MIT |
| UTEX.js | [photopea/UTEX.js](https://github.com/photopea/UTEX.js) | MIT |
| Typr.js | [photopea/Typr.js](https://github.com/photopea/Typr.js) | MIT |
| omggif | [deanm/omggif](https://github.com/deanm/omggif) | MIT |
| js-sha1 | [emn178/js-sha1](https://github.com/emn178/js-sha1) | MIT |
| PDFI.js | [eolix/PDFI.js](https://github.com/eolix/PDFI.js) | MIT |
| acorn | [acornjs/acorn](https://github.com/acornjs/acorn) | MIT |
| parse-exr (bundles fflate) | [dmnsgn/parse-exr](https://github.com/dmnsgn/parse-exr) | MIT |
| linear-solve | [lovasoa/linear-solve](https://github.com/lovasoa/linear-solve) | MIT |
| pdf.js codecs | [mozilla/pdf.js](https://github.com/mozilla/pdf.js) | Apache-2.0 (see above) |
| HarfBuzz (WASM) | [harfbuzz/harfbuzz](https://github.com/harfbuzz/harfbuzz) | Old MIT |
| FriBidi (WASM) | [fribidi/fribidi](https://github.com/fribidi/fribidi) | LGPL-2.1-or-later (see above) |
| libwebp (WASM) | [webmproject/libwebp](https://github.com/webmproject/libwebp) | BSD-3-Clause |
| zstd (WASM) | [facebook/zstd](https://github.com/facebook/zstd) | BSD-3-Clause |
| stb_image (WASM) | [nothings/stb](https://github.com/nothings/stb) | Public domain or MIT |
| libheif (WASM) | [strukturag/libheif](https://github.com/strukturag/libheif) | LGPL-3.0-or-later (see above) |

## Bundled assets

| Asset | Upstream | Licence |
|-------|----------|---------|
| Application icons in `src/assets/ico/` | [Tabler Icons](https://github.com/tabler/tabler-icons) (most; the rest drawn for this app) | MIT — `src/assets/ico/LICENSE` |
| `src/resources/libraries/shapes.csh` (custom shape library, "bundled library" row in the Shape tool's picker) | [Font Awesome Free](https://github.com/FortAwesome/Font-Awesome) `solid` + `regular` icon glyphs (submodule at `src/vendor/fontawesome`; `brands` icons are excluded — those are third-party trademarks, not covered by this grant) | Icons: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — Copyright Fonticons, Inc. Regenerate with `src/vendor/js/fontawesome/build.sh` after bumping the submodule pin. |
| `src/resources/startup/patterns.pat` (seed set) and `src/resources/libraries/extra_patterns.pat` (bundled library row) | [Subtle Patterns](https://github.com/atlemo/SubtlePatterns) — CC BY-SA 3.0, see below | See below |
| Colour Lookup presets in `src/resources/luts/*.CUBE` | [Fresh LUTs](https://freshluts.com) | CC0 — `src/resources/luts/LICENSE` |

## npm packages

None are redistributed. `@tauri-apps/plugin-store` is used for its TypeScript
types only — the application calls the plugin through the `window.__TAURI__`
global the webview provides. Everything else in `package.json` is a development
dependency (ESLint, the Tauri CLI) and is not part of any build output.

---

## Rust crates linked into the application

The desktop binary statically links the crates below. Nearly all are MIT or
Apache-2.0; both licences require their copyright and licence notices to be
retained in redistributions, which this list does. Each crate's full licence text
is in its published source at the linked repository and in the local registry
cache under `~/.cargo/registry`.

Crates under **MPL-2.0** are marked in the table. MPL-2.0 is file-level copyleft:
the source of those files, as used here, is the unmodified published crate at the
version listed.

Regenerate this section after changing Cargo dependencies:

```sh
node scripts/gen-crate-notices.mjs
```

<!-- BEGIN GENERATED CRATE LIST -->

_534 crates, generated by `scripts/gen-crate-notices.mjs` — do not edit by hand._

| Crate | Version | Licence |
|-------|---------|---------|
| [adler2](https://github.com/oyvindln/adler2) | 2.0.1 | 0BSD OR MIT OR Apache-2.0 |
| [aho-corasick](https://github.com/BurntSushi/aho-corasick) | 1.1.4 | Unlicense OR MIT |
| [alloc-no-stdlib](https://github.com/dropbox/rust-alloc-no-stdlib) | 2.0.4 | BSD-3-Clause |
| [alloc-stdlib](https://github.com/dropbox/rust-alloc-no-stdlib) | 0.2.2 | BSD-3-Clause |
| [android_system_properties](https://github.com/nical/android_system_properties) | 0.1.5 | MIT OR Apache-2.0 |
| [anyhow](https://github.com/dtolnay/anyhow) | 1.0.102 | MIT OR Apache-2.0 |
| [arboard](https://github.com/1Password/arboard) | 3.6.1 | MIT OR Apache-2.0 |
| [atk](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [atk-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [atomic-waker](https://github.com/smol-rs/atomic-waker) | 1.1.2 | Apache-2.0 OR MIT |
| [aws-lc-rs](https://github.com/aws/aws-lc-rs) | 1.18.1 | ISC AND (Apache-2.0 OR ISC) |
| [aws-lc-sys](https://github.com/aws/aws-lc-rs) | 0.45.0 | ISC AND (Apache-2.0 OR ISC) AND Apache-2.0 AND MIT AND BSD-3-Clause AND (Apache-2.0 OR ISC OR MIT) AND (Apache-2.0 OR ISC OR MIT-0) |
| [base64](https://github.com/marshallpierce/rust-base64) | 0.21.7 | MIT OR Apache-2.0 |
| [base64](https://github.com/marshallpierce/rust-base64) | 0.22.1 | MIT OR Apache-2.0 |
| [bit-set](https://github.com/contain-rs/bit-set) | 0.8.0 | Apache-2.0 OR MIT |
| [bit-vec](https://github.com/contain-rs/bit-vec) | 0.8.0 | Apache-2.0 OR MIT |
| [bitflags](https://github.com/bitflags/bitflags) | 1.3.2 | MIT OR Apache-2.0 |
| [bitflags](https://github.com/bitflags/bitflags) | 2.11.1 | MIT OR Apache-2.0 |
| [block-buffer](https://github.com/RustCrypto/utils) | 0.10.4 | MIT OR Apache-2.0 |
| [block2](https://github.com/madsmtm/objc2) | 0.6.2 | MIT |
| [brotli](https://github.com/dropbox/rust-brotli) | 8.0.2 | BSD-3-Clause AND MIT |
| [brotli-decompressor](https://github.com/dropbox/rust-brotli-decompressor) | 5.0.0 | BSD-3-Clause OR MIT |
| [bs58](https://github.com/Nullus157/bs58-rs) | 0.5.1 | MIT OR Apache-2.0 |
| [bumpalo](https://github.com/fitzgen/bumpalo) | 3.20.3 | MIT OR Apache-2.0 |
| [bytemuck](https://github.com/Lokathor/bytemuck) | 1.25.0 | Zlib OR Apache-2.0 OR MIT |
| [byteorder](https://github.com/BurntSushi/byteorder) | 1.5.0 | Unlicense OR MIT |
| [byteorder-lite](https://github.com/image-rs/byteorder-lite) | 0.1.0 | Unlicense OR MIT |
| [bytes](https://github.com/tokio-rs/bytes) | 1.11.1 | MIT |
| [cairo-rs](https://github.com/gtk-rs/gtk-rs-core) | 0.18.5 | MIT |
| [cairo-sys-rs](https://github.com/gtk-rs/gtk-rs-core) | 0.18.2 | MIT |
| [camino](https://github.com/camino-rs/camino) | 1.2.2 | MIT OR Apache-2.0 |
| [cargo_metadata](https://github.com/oli-obk/cargo_metadata) | 0.19.2 | MIT |
| [cargo-platform](https://github.com/rust-lang/cargo) | 0.1.9 | MIT OR Apache-2.0 |
| [cesu8](https://github.com/emk/cesu8-rs) | 1.1.0 | Apache-2.0 OR MIT |
| [cfb](https://github.com/mdsteele/rust-cfb) | 0.7.3 | MIT |
| [cfg-if](https://github.com/rust-lang/cfg-if) | 1.0.4 | MIT OR Apache-2.0 |
| [chacha20](https://github.com/RustCrypto/stream-ciphers) | 0.10.2 | MIT OR Apache-2.0 |
| [chrono](https://github.com/chronotope/chrono) | 0.4.44 | MIT OR Apache-2.0 |
| [clipboard-win](https://github.com/DoumanAsh/clipboard-win) | 5.4.1 | BSL-1.0 |
| [combine](https://github.com/Marwes/combine) | 4.6.7 | MIT |
| [cookie](https://github.com/SergioBenitez/cookie-rs) | 0.18.1 | MIT OR Apache-2.0 |
| [core-foundation](https://github.com/servo/core-foundation-rs) | 0.10.1 | MIT OR Apache-2.0 |
| [core-foundation](https://github.com/servo/core-foundation-rs) | 0.9.4 | MIT OR Apache-2.0 |
| [core-foundation-sys](https://github.com/servo/core-foundation-rs) | 0.8.7 | MIT OR Apache-2.0 |
| [core-graphics](https://github.com/servo/core-foundation-rs) | 0.25.0 | MIT OR Apache-2.0 |
| [core-graphics-types](https://github.com/servo/core-foundation-rs) | 0.2.0 | MIT OR Apache-2.0 |
| [cpufeatures](https://github.com/RustCrypto/utils) | 0.2.17 | MIT OR Apache-2.0 |
| [cpufeatures](https://github.com/RustCrypto/utils) | 0.3.1 | MIT OR Apache-2.0 |
| [crc32fast](https://github.com/srijs/rust-crc32fast) | 1.5.0 | MIT OR Apache-2.0 |
| [crossbeam-channel](https://github.com/crossbeam-rs/crossbeam) | 0.5.15 | MIT OR Apache-2.0 |
| [crossbeam-utils](https://github.com/crossbeam-rs/crossbeam) | 0.8.21 | MIT OR Apache-2.0 |
| [crunchy](https://github.com/eira-fransham/crunchy) | 0.2.4 | MIT |
| [crypto-common](https://github.com/RustCrypto/traits) | 0.1.7 | MIT OR Apache-2.0 |
| [cssparser](https://github.com/servo/rust-cssparser) | 0.36.0 | MPL-2.0 |
| [cssparser-macros](https://github.com/servo/rust-cssparser) | 0.6.1 | MPL-2.0 |
| [ctor](https://github.com/mmastrac/rust-ctor) | 0.8.0 | Apache-2.0 OR MIT |
| [ctor-proc-macro](https://github.com/mmastrac/rust-ctor) | 0.0.7 | Apache-2.0 OR MIT |
| [cups_rs](https://github.com/Gmin2/cups-rs) | 0.3.0 | MIT |
| [darling](https://github.com/TedDriggs/darling) | 0.23.0 | MIT |
| [darling_core](https://github.com/TedDriggs/darling) | 0.23.0 | MIT |
| [darling_macro](https://github.com/TedDriggs/darling) | 0.23.0 | MIT |
| [dbus](https://github.com/diwic/dbus-rs) | 0.9.11 | Apache-2.0 OR MIT |
| [deranged](https://github.com/jhpratt/deranged) | 0.5.8 | MIT OR Apache-2.0 |
| [derive_more](https://github.com/JelteF/derive_more) | 2.1.1 | MIT |
| [derive_more-impl](https://github.com/JelteF/derive_more) | 2.1.1 | MIT |
| [digest](https://github.com/RustCrypto/traits) | 0.10.7 | MIT OR Apache-2.0 |
| [dirs](https://github.com/soc/dirs-rs) | 6.0.0 | MIT OR Apache-2.0 |
| [dirs-sys](https://github.com/dirs-dev/dirs-sys-rs) | 0.5.0 | MIT OR Apache-2.0 |
| [dispatch2](https://github.com/madsmtm/objc2) | 0.3.1 | Zlib OR Apache-2.0 OR MIT |
| [displaydoc](https://github.com/yaahc/displaydoc) | 0.2.5 | MIT OR Apache-2.0 |
| [dlopen2](https://github.com/OpenByteDev/dlopen2) | 0.8.2 | MIT |
| [dlopen2_derive](https://github.com/OpenByteDev/dlopen2) | 0.4.3 | MIT |
| [dom_query](https://github.com/niklak/dom_query) | 0.27.0 | MIT |
| [downcast-rs](https://github.com/marcianx/downcast-rs) | 1.2.1 | MIT OR Apache-2.0 |
| [dpi](https://github.com/rust-windowing/winit) | 0.1.2 | Apache-2.0 AND MIT |
| [dtoa](https://github.com/dtolnay/dtoa) | 1.0.11 | MIT OR Apache-2.0 |
| [dtoa-short](https://github.com/upsuper/dtoa-short) | 0.3.5 | MPL-2.0 |
| [dtor](https://github.com/mmastrac/rust-ctor) | 0.3.0 | Apache-2.0 OR MIT |
| [dtor-proc-macro](https://github.com/mmastrac/rust-ctor) | 0.0.6 | Apache-2.0 OR MIT |
| [dunce](https://gitlab.com/kornelski/dunce) | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 |
| [dyn-clone](https://github.com/dtolnay/dyn-clone) | 1.0.20 | MIT OR Apache-2.0 |
| [embed_plist](https://github.com/nvzqz/embed-plist-rs) | 1.2.2 | MIT OR Apache-2.0 |
| [encoding_rs](https://github.com/hsivonen/encoding_rs) | 0.8.35 | (Apache-2.0 OR MIT) AND BSD-3-Clause |
| [equivalent](https://github.com/indexmap-rs/equivalent) | 1.0.2 | Apache-2.0 OR MIT |
| [erased-serde](https://github.com/dtolnay/erased-serde) | 0.4.10 | MIT OR Apache-2.0 |
| [errno](https://github.com/lambda-fairy/rust-errno) | 0.3.14 | MIT OR Apache-2.0 |
| [error-code](https://github.com/DoumanAsh/error-code) | 3.3.2 | BSL-1.0 |
| [fastrand](https://github.com/smol-rs/fastrand) | 2.4.1 | Apache-2.0 OR MIT |
| [fax](https://github.com/pdf-rs/fax) | 0.2.7 | MIT |
| [fdeflate](https://github.com/image-rs/fdeflate) | 0.3.7 | MIT OR Apache-2.0 |
| [field-offset](https://github.com/Diggsey/rust-field-offset) | 0.3.6 | MIT OR Apache-2.0 |
| [fixedbitset](https://github.com/petgraph/fixedbitset) | 0.5.7 | MIT OR Apache-2.0 |
| [flate2](https://github.com/rust-lang/flate2-rs) | 1.1.9 | MIT OR Apache-2.0 |
| [fmt-derive](https://github.com/danielschemmel/fmt-derive) | 0.1.2 | MIT OR Apache-2.0 |
| [fmt-derive-proc](https://github.com/danielschemmel/fmt-derive) | 0.1.2 | MIT OR Apache-2.0 |
| [fnv](https://github.com/servo/rust-fnv) | 1.0.7 | Apache-2.0  OR  MIT |
| [foldhash](https://github.com/orlp/foldhash) | 0.1.5 | Zlib |
| [foldhash](https://github.com/orlp/foldhash) | 0.2.0 | Zlib |
| [fontconfig-parser](https://github.com/Riey/fontconfig-parser) | 0.5.8 | MIT |
| [fontdb](https://github.com/RazrFalcon/fontdb) | 0.16.2 | MIT |
| [foreign-types](https://github.com/sfackler/foreign-types) | 0.5.0 | MIT OR Apache-2.0 |
| [foreign-types-macros](https://github.com/sfackler/foreign-types) | 0.2.3 | MIT OR Apache-2.0 |
| [foreign-types-shared](https://github.com/sfackler/foreign-types) | 0.3.1 | MIT OR Apache-2.0 |
| [form_urlencoded](https://github.com/servo/rust-url) | 1.2.2 | MIT OR Apache-2.0 |
| [futures-channel](https://github.com/rust-lang/futures-rs) | 0.3.32 | MIT OR Apache-2.0 |
| [futures-core](https://github.com/rust-lang/futures-rs) | 0.3.32 | MIT OR Apache-2.0 |
| [futures-executor](https://github.com/rust-lang/futures-rs) | 0.3.32 | MIT OR Apache-2.0 |
| [futures-io](https://github.com/rust-lang/futures-rs) | 0.3.32 | MIT OR Apache-2.0 |
| [futures-macro](https://github.com/rust-lang/futures-rs) | 0.3.32 | MIT OR Apache-2.0 |
| [futures-sink](https://github.com/rust-lang/futures-rs) | 0.3.32 | MIT OR Apache-2.0 |
| [futures-task](https://github.com/rust-lang/futures-rs) | 0.3.32 | MIT OR Apache-2.0 |
| [futures-util](https://github.com/rust-lang/futures-rs) | 0.3.32 | MIT OR Apache-2.0 |
| [gdk](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [gdk-pixbuf](https://github.com/gtk-rs/gtk-rs-core) | 0.18.5 | MIT |
| [gdk-pixbuf-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.0 | MIT |
| [gdk-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [gdkwayland-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [gdkx11](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [gdkx11-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [generic-array](https://github.com/fizyk20/generic-array.git) | 0.14.7 | MIT |
| [gethostname](https://codeberg.org/swsnr/gethostname.rs.git) | 1.1.0 | Apache-2.0 |
| [getrandom](https://github.com/rust-random/getrandom) | 0.2.17 | MIT OR Apache-2.0 |
| [getrandom](https://github.com/rust-random/getrandom) | 0.3.4 | MIT OR Apache-2.0 |
| [getrandom](https://github.com/rust-random/getrandom) | 0.4.2 | MIT OR Apache-2.0 |
| [gio](https://github.com/gtk-rs/gtk-rs-core) | 0.18.4 | MIT |
| [gio-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.1 | MIT |
| [glib](https://github.com/gtk-rs/gtk-rs-core) | 0.18.5 | MIT |
| [glib-macros](https://github.com/gtk-rs/gtk-rs-core) | 0.18.5 | MIT |
| [glib-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.1 | MIT |
| [glob](https://github.com/rust-lang/glob) | 0.3.3 | MIT OR Apache-2.0 |
| [gobject-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.0 | MIT |
| [gtk](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [gtk-sys](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [gtk3-macros](https://github.com/gtk-rs/gtk3-rs) | 0.18.2 | MIT |
| [h2](https://github.com/hyperium/h2) | 0.4.19 | MIT |
| [half](https://github.com/VoidStarKat/half-rs) | 2.7.1 | MIT OR Apache-2.0 |
| [hashbrown](https://github.com/rust-lang/hashbrown) | 0.12.3 | MIT OR Apache-2.0 |
| [hashbrown](https://github.com/rust-lang/hashbrown) | 0.15.5 | MIT OR Apache-2.0 |
| [hashbrown](https://github.com/rust-lang/hashbrown) | 0.17.1 | MIT OR Apache-2.0 |
| [heck](https://github.com/withoutboats/heck) | 0.4.1 | MIT OR Apache-2.0 |
| [heck](https://github.com/withoutboats/heck) | 0.5.0 | MIT OR Apache-2.0 |
| [hex](https://github.com/KokaKiwi/rust-hex) | 0.4.3 | MIT OR Apache-2.0 |
| [html5ever](https://github.com/servo/html5ever) | 0.38.0 | MIT OR Apache-2.0 |
| [http](https://github.com/hyperium/http) | 1.4.1 | MIT OR Apache-2.0 |
| [http-body](https://github.com/hyperium/http-body) | 1.0.1 | MIT |
| [http-body-util](https://github.com/hyperium/http-body) | 0.1.3 | MIT |
| [httparse](https://github.com/seanmonstar/httparse) | 1.10.1 | MIT OR Apache-2.0 |
| [hyper](https://github.com/hyperium/hyper) | 1.9.0 | MIT |
| [hyper-rustls](https://github.com/rustls/hyper-rustls) | 0.27.10 | Apache-2.0 OR ISC OR MIT |
| [hyper-util](https://github.com/hyperium/hyper-util) | 0.1.20 | MIT |
| [iana-time-zone](https://github.com/strawlab/iana-time-zone) | 0.1.65 | MIT OR Apache-2.0 |
| [iana-time-zone-haiku](https://github.com/strawlab/iana-time-zone) | 0.1.2 | MIT OR Apache-2.0 |
| [ico](https://github.com/mdsteele/rust-ico) | 0.5.0 | MIT |
| [icu_collections](https://github.com/unicode-org/icu4x) | 2.2.0 | Unicode-3.0 |
| [icu_locale_core](https://github.com/unicode-org/icu4x) | 2.2.0 | Unicode-3.0 |
| [icu_normalizer](https://github.com/unicode-org/icu4x) | 2.2.0 | Unicode-3.0 |
| [icu_normalizer_data](https://github.com/unicode-org/icu4x) | 2.2.0 | Unicode-3.0 |
| [icu_properties](https://github.com/unicode-org/icu4x) | 2.2.0 | Unicode-3.0 |
| [icu_properties_data](https://github.com/unicode-org/icu4x) | 2.2.0 | Unicode-3.0 |
| [icu_provider](https://github.com/unicode-org/icu4x) | 2.2.0 | Unicode-3.0 |
| [id-arena](https://github.com/fitzgen/id-arena) | 2.3.0 | MIT OR Apache-2.0 |
| [ident_case](https://github.com/TedDriggs/ident_case) | 1.0.1 | MIT OR Apache-2.0 |
| [idna](https://github.com/servo/rust-url/) | 1.1.0 | MIT OR Apache-2.0 |
| [idna_adapter](https://github.com/hsivonen/idna_adapter) | 1.2.2 | Apache-2.0 OR MIT |
| [image](https://github.com/image-rs/image) | 0.25.10 | MIT OR Apache-2.0 |
| [indexmap](https://github.com/bluss/indexmap) | 1.9.3 | Apache-2.0 OR MIT |
| [indexmap](https://github.com/indexmap-rs/indexmap) | 2.14.0 | Apache-2.0 OR MIT |
| [infer](https://github.com/bojand/infer) | 0.19.0 | MIT |
| [ipnet](https://github.com/krisprice/ipnet) | 2.12.0 | MIT OR Apache-2.0 |
| [is-docker](https://github.com/TheLarkInn/is-docker) | 0.2.0 | MIT |
| [is-wsl](https://github.com/TheLarkInn/is-wsl) | 0.4.0 | MIT |
| [itoa](https://github.com/dtolnay/itoa) | 1.0.18 | MIT OR Apache-2.0 |
| [javascriptcore-rs](https://github.com/tauri-apps/javascriptcore-rs) | 1.1.2 | MIT |
| [javascriptcore-rs-sys](https://github.com/tauri-apps/javascriptcore-rs) | 1.1.1 | MIT |
| [jni](https://github.com/jni-rs/jni-rs) | 0.21.1 | MIT OR Apache-2.0 |
| [jni](https://github.com/jni-rs/jni-rs) | 0.22.4 | MIT OR Apache-2.0 |
| [jni-macros](https://github.com/jni-rs/jni-rs) | 0.22.4 | MIT OR Apache-2.0 |
| [jni-sys](https://github.com/jni-rs/jni-sys) | 0.3.1 | MIT OR Apache-2.0 |
| [jni-sys](https://github.com/jni-rs/jni-sys) | 0.4.1 | MIT OR Apache-2.0 |
| [jni-sys-macros](https://github.com/jni-rs/jni-sys) | 0.4.1 | MIT OR Apache-2.0 |
| [js-sys](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/js-sys) | 0.3.99 | MIT OR Apache-2.0 |
| [json-patch](https://github.com/idubrov/json-patch) | 3.0.1 | MIT OR Apache-2.0 |
| [jsonptr](https://github.com/chanced/jsonptr) | 0.6.3 | MIT OR Apache-2.0 |
| [keyboard-types](https://github.com/pyfisch/keyboard-types) | 0.7.0 | MIT OR Apache-2.0 |
| [leb128fmt](https://github.com/bluk/leb128fmt) | 0.1.0 | MIT OR Apache-2.0 |
| libappindicator | 0.9.0 | Apache-2.0 OR MIT |
| libappindicator-sys | 0.9.0 | Apache-2.0 OR MIT |
| [libc](https://github.com/rust-lang/libc) | 0.2.186 | MIT OR Apache-2.0 |
| [libdbus-sys](https://github.com/diwic/dbus-rs) | 0.2.7 | Apache-2.0 OR MIT |
| [libloading](https://github.com/nagisa/rust_libloading/) | 0.7.4 | ISC |
| [libredox](https://gitlab.redox-os.org/redox-os/libredox.git) | 0.1.16 | MIT |
| [linux-raw-sys](https://github.com/sunfishcode/linux-raw-sys) | 0.12.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [litemap](https://github.com/unicode-org/icu4x) | 0.8.2 | Unicode-3.0 |
| [lock_api](https://github.com/Amanieu/parking_lot) | 0.4.14 | MIT OR Apache-2.0 |
| [log](https://github.com/rust-lang/log) | 0.4.30 | MIT OR Apache-2.0 |
| [lru-slab](https://github.com/Ralith/lru-slab) | 0.1.3 | MIT OR Apache-2.0 OR Zlib |
| [markup5ever](https://github.com/servo/html5ever) | 0.38.0 | MIT OR Apache-2.0 |
| [memchr](https://github.com/BurntSushi/memchr) | 2.8.0 | Unlicense OR MIT |
| [memmap2](https://github.com/RazrFalcon/memmap2-rs) | 0.9.10 | MIT OR Apache-2.0 |
| [memoffset](https://github.com/Gilnaa/memoffset) | 0.9.1 | MIT |
| [mime](https://github.com/hyperium/mime) | 0.3.17 | MIT OR Apache-2.0 |
| [miniz_oxide](https://github.com/Frommi/miniz_oxide/tree/master/miniz_oxide) | 0.8.9 | MIT OR Zlib OR Apache-2.0 |
| [mio](https://github.com/tokio-rs/mio) | 1.2.0 | MIT |
| [moxcms](https://github.com/awxkee/moxcms.git) | 0.8.1 | BSD-3-Clause OR Apache-2.0 |
| [muda](https://github.com/tauri-apps/muda) | 0.19.2 | Apache-2.0 OR MIT |
| [ndk](https://github.com/rust-mobile/ndk) | 0.9.0 | MIT OR Apache-2.0 |
| [ndk-sys](https://github.com/rust-mobile/ndk) | 0.6.0+11769913 | MIT OR Apache-2.0 |
| [new_debug_unreachable](https://github.com/mbrubeck/rust-debug-unreachable) | 1.0.6 | MIT |
| [nom](https://github.com/rust-bakery/nom) | 8.0.0 | MIT |
| [num_enum](https://github.com/illicitonion/num_enum) | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 |
| [num_enum_derive](https://github.com/illicitonion/num_enum) | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 |
| [num-conv](https://github.com/jhpratt/num-conv) | 0.2.2 | MIT OR Apache-2.0 |
| [num-traits](https://github.com/rust-num/num-traits) | 0.2.19 | MIT OR Apache-2.0 |
| [objc2](https://github.com/madsmtm/objc2) | 0.6.4 | MIT |
| [objc2-app-kit](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-cloud-kit](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-data](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-foundation](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-graphics](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-image](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-location](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-core-text](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-encode](https://github.com/madsmtm/objc2) | 4.1.0 | MIT |
| [objc2-exception-helper](https://github.com/madsmtm/objc2) | 0.1.1 | Zlib OR Apache-2.0 OR MIT |
| [objc2-foundation](https://github.com/madsmtm/objc2) | 0.3.2 | MIT |
| [objc2-io-surface](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-quartz-core](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-ui-kit](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-user-notifications](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [objc2-web-kit](https://github.com/madsmtm/objc2) | 0.3.2 | Zlib OR Apache-2.0 OR MIT |
| [once_cell](https://github.com/matklad/once_cell) | 1.21.4 | MIT OR Apache-2.0 |
| [open](https://github.com/Byron/open-rs) | 5.3.5 | MIT |
| [openssl-probe](https://github.com/rustls/openssl-probe) | 0.2.1 | MIT OR Apache-2.0 |
| [option-ext](https://github.com/soc/option-ext.git) | 0.2.0 | MPL-2.0 |
| [os_pipe](https://github.com/oconnor663/os_pipe.rs) | 1.2.3 | MIT |
| [pango](https://github.com/gtk-rs/gtk-rs-core) | 0.18.3 | MIT |
| [pango-sys](https://github.com/gtk-rs/gtk-rs-core) | 0.18.0 | MIT |
| [parking_lot](https://github.com/Amanieu/parking_lot) | 0.12.5 | MIT OR Apache-2.0 |
| [parking_lot_core](https://github.com/Amanieu/parking_lot) | 0.9.12 | MIT OR Apache-2.0 |
| [pathdiff](https://github.com/Manishearth/pathdiff) | 0.2.3 | MIT OR Apache-2.0 |
| [percent-encoding](https://github.com/servo/rust-url/) | 2.3.2 | MIT OR Apache-2.0 |
| [petgraph](https://github.com/petgraph/petgraph) | 0.8.3 | MIT OR Apache-2.0 |
| [phf](https://github.com/rust-phf/rust-phf) | 0.13.1 | MIT |
| [phf_generator](https://github.com/rust-phf/rust-phf) | 0.13.1 | MIT |
| [phf_macros](https://github.com/rust-phf/rust-phf) | 0.13.1 | MIT |
| [phf_shared](https://github.com/rust-phf/rust-phf) | 0.13.1 | MIT |
| [pin-project-lite](https://github.com/taiki-e/pin-project-lite) | 0.2.17 | Apache-2.0 OR MIT |
| [plist](https://github.com/ebarnard/rust-plist/) | 1.9.0 | MIT |
| [png](https://github.com/image-rs/image-png) | 0.17.16 | MIT OR Apache-2.0 |
| [png](https://github.com/image-rs/image-png) | 0.18.1 | MIT OR Apache-2.0 |
| [potential_utf](https://github.com/unicode-org/icu4x) | 0.1.5 | Unicode-3.0 |
| [powerfmt](https://github.com/jhpratt/powerfmt) | 0.2.0 | MIT OR Apache-2.0 |
| [precomputed-hash](https://github.com/emilio/precomputed-hash) | 0.1.1 | MIT |
| [prettyplease](https://github.com/dtolnay/prettyplease) | 0.2.37 | MIT OR Apache-2.0 |
| [proc-macro-crate](https://github.com/bkchr/proc-macro-crate) | 1.3.1 | MIT OR Apache-2.0 |
| [proc-macro-crate](https://github.com/bkchr/proc-macro-crate) | 2.0.2 | MIT OR Apache-2.0 |
| [proc-macro-crate](https://github.com/bkchr/proc-macro-crate) | 3.5.0 | MIT OR Apache-2.0 |
| [proc-macro-error](https://gitlab.com/CreepySkeleton/proc-macro-error) | 1.0.4 | MIT OR Apache-2.0 |
| [proc-macro-error-attr](https://gitlab.com/CreepySkeleton/proc-macro-error) | 1.0.4 | MIT OR Apache-2.0 |
| [proc-macro2](https://github.com/dtolnay/proc-macro2) | 1.0.106 | MIT OR Apache-2.0 |
| [pxfm](https://github.com/awxkee/pxfm) | 0.1.29 | BSD-3-Clause OR Apache-2.0 |
| [quick-error](http://github.com/tailhook/quick-error) | 2.0.1 | MIT OR Apache-2.0 |
| [quick-xml](https://github.com/tafia/quick-xml) | 0.39.4 | MIT |
| [quinn](https://github.com/quinn-rs/quinn) | 0.11.12 | MIT OR Apache-2.0 |
| [quinn-proto](https://github.com/quinn-rs/quinn) | 0.11.18 | MIT OR Apache-2.0 |
| [quinn-udp](https://github.com/quinn-rs/quinn) | 0.5.15 | MIT OR Apache-2.0 |
| [quote](https://github.com/dtolnay/quote) | 1.0.45 | MIT OR Apache-2.0 |
| [r-efi](https://github.com/r-efi/r-efi) | 5.3.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later |
| [r-efi](https://github.com/r-efi/r-efi) | 6.0.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later |
| [rand](https://github.com/rust-random/rand) | 0.10.3 | MIT OR Apache-2.0 |
| [rand_core](https://github.com/rust-random/rand_core) | 0.10.1 | MIT OR Apache-2.0 |
| [rand_pcg](https://github.com/rust-random/rngs) | 0.10.2 | MIT OR Apache-2.0 |
| [raw-window-handle](https://github.com/rust-windowing/raw-window-handle) | 0.6.2 | MIT OR Apache-2.0 OR Zlib |
| [redox_syscall](https://gitlab.redox-os.org/redox-os/syscall) | 0.5.18 | MIT |
| [redox_users](https://gitlab.redox-os.org/redox-os/users) | 0.5.2 | MIT |
| [ref-cast](https://github.com/dtolnay/ref-cast) | 1.0.25 | MIT OR Apache-2.0 |
| [ref-cast-impl](https://github.com/dtolnay/ref-cast) | 1.0.25 | MIT OR Apache-2.0 |
| [regex](https://github.com/rust-lang/regex) | 1.12.3 | MIT OR Apache-2.0 |
| [regex-automata](https://github.com/rust-lang/regex) | 0.4.14 | MIT OR Apache-2.0 |
| [regex-syntax](https://github.com/rust-lang/regex) | 0.8.10 | MIT OR Apache-2.0 |
| [reqwest](https://github.com/seanmonstar/reqwest) | 0.13.4 | MIT OR Apache-2.0 |
| [rfd](https://github.com/PolyMeilex/rfd) | 0.16.0 | MIT |
| [ring](https://github.com/briansmith/ring) | 0.17.14 | Apache-2.0 AND ISC |
| [roxmltree](https://github.com/RazrFalcon/roxmltree) | 0.20.0 | MIT OR Apache-2.0 |
| [rustc-hash](https://github.com/rust-lang/rustc-hash) | 2.1.2 | Apache-2.0 OR MIT |
| [rustix](https://github.com/bytecodealliance/rustix) | 1.1.4 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [rustls](https://github.com/rustls/rustls) | 0.23.45 | Apache-2.0 OR ISC OR MIT |
| [rustls-native-certs](https://github.com/rustls/rustls-native-certs) | 0.8.4 | Apache-2.0 OR ISC OR MIT |
| [rustls-pki-types](https://github.com/rustls/pki-types) | 1.15.1 | MIT OR Apache-2.0 |
| [rustls-platform-verifier](https://github.com/rustls/rustls-platform-verifier) | 0.7.0 | MIT OR Apache-2.0 |
| [rustls-platform-verifier-android](https://github.com/rustls/rustls-platform-verifier) | 0.1.1 | MIT OR Apache-2.0 |
| [rustls-webpki](https://github.com/rustls/webpki) | 0.103.15 | ISC |
| [rustversion](https://github.com/dtolnay/rustversion) | 1.0.22 | MIT OR Apache-2.0 |
| [ryu](https://github.com/dtolnay/ryu) | 1.0.23 | Apache-2.0 OR BSL-1.0 |
| [same-file](https://github.com/BurntSushi/same-file) | 1.0.6 | Unlicense OR MIT |
| [schannel](https://github.com/steffengy/schannel-rs) | 0.1.29 | MIT |
| [schemars](https://github.com/GREsau/schemars) | 0.8.22 | MIT |
| [schemars](https://github.com/GREsau/schemars) | 0.9.0 | MIT |
| [schemars](https://github.com/GREsau/schemars) | 1.2.1 | MIT |
| [schemars_derive](https://github.com/GREsau/schemars) | 0.8.22 | MIT |
| [scopeguard](https://github.com/bluss/scopeguard) | 1.2.0 | MIT OR Apache-2.0 |
| [security-framework](https://github.com/kornelski/rust-security-framework) | 3.7.0 | MIT OR Apache-2.0 |
| [security-framework-sys](https://github.com/kornelski/rust-security-framework) | 2.17.0 | MIT OR Apache-2.0 |
| [selectors](https://github.com/servo/stylo) | 0.36.1 | MPL-2.0 |
| [semver](https://github.com/dtolnay/semver) | 1.0.28 | MIT OR Apache-2.0 |
| [serde](https://github.com/serde-rs/serde) | 1.0.228 | MIT OR Apache-2.0 |
| [serde_core](https://github.com/serde-rs/serde) | 1.0.228 | MIT OR Apache-2.0 |
| [serde_derive](https://github.com/serde-rs/serde) | 1.0.228 | MIT OR Apache-2.0 |
| [serde_derive_internals](https://github.com/serde-rs/serde) | 0.29.1 | MIT OR Apache-2.0 |
| [serde_json](https://github.com/serde-rs/json) | 1.0.150 | MIT OR Apache-2.0 |
| [serde_repr](https://github.com/dtolnay/serde-repr) | 0.1.20 | MIT OR Apache-2.0 |
| [serde_spanned](https://github.com/toml-rs/toml) | 0.6.9 | MIT OR Apache-2.0 |
| [serde_spanned](https://github.com/toml-rs/toml) | 1.1.1 | MIT OR Apache-2.0 |
| [serde_urlencoded](https://github.com/nox/serde_urlencoded) | 0.7.1 | MIT OR Apache-2.0 |
| [serde_with](https://github.com/jonasbb/serde_with/) | 3.20.0 | MIT OR Apache-2.0 |
| [serde_with_macros](https://github.com/jonasbb/serde_with/) | 3.20.0 | MIT OR Apache-2.0 |
| [serde-untagged](https://github.com/dtolnay/serde-untagged) | 0.1.9 | MIT OR Apache-2.0 |
| [serialize-to-javascript](https://github.com/chippers/serialize-to-javascript) | 0.1.2 | MIT OR Apache-2.0 |
| [serialize-to-javascript-impl](https://github.com/chippers/serialize-to-javascript) | 0.1.2 | MIT OR Apache-2.0 |
| [servo_arc](https://github.com/servo/stylo) | 0.4.3 | MIT OR Apache-2.0 |
| [sha2](https://github.com/RustCrypto/hashes) | 0.10.9 | MIT OR Apache-2.0 |
| [shared_child](https://github.com/oconnor663/shared_child.rs) | 1.1.1 | MIT |
| [sigchld](https://github.com/oconnor663/sigchld.rs) | 0.2.4 | MIT |
| [signal-hook](https://github.com/vorner/signal-hook) | 0.3.18 | Apache-2.0 OR MIT |
| [signal-hook-registry](https://github.com/vorner/signal-hook) | 1.4.8 | MIT OR Apache-2.0 |
| [simd_cesu8](https://github.com/seancroach/simd_cesu8) | 1.2.0 | Apache-2.0 OR MIT |
| [simd-adler32](https://github.com/mcountryman/simd-adler32) | 0.3.9 | MIT |
| [simdutf8](https://github.com/rusticstuff/simdutf8) | 0.1.5 | MIT OR Apache-2.0 |
| [siphasher](https://github.com/jedisct1/rust-siphash) | 1.0.3 | MIT OR Apache-2.0 |
| [slab](https://github.com/tokio-rs/slab) | 0.4.12 | MIT |
| [slotmap](https://github.com/orlp/slotmap) | 1.1.1 | Zlib |
| [smallvec](https://github.com/servo/rust-smallvec) | 1.15.1 | MIT OR Apache-2.0 |
| [socket2](https://github.com/rust-lang/socket2) | 0.6.3 | MIT OR Apache-2.0 |
| [softbuffer](https://github.com/rust-windowing/softbuffer) | 0.4.8 | MIT OR Apache-2.0 |
| [soup3](https://gitlab.gnome.org/World/Rust/soup3-rs) | 0.5.0 | MIT |
| [soup3-sys](https://gitlab.gnome.org/World/Rust/soup3-rs) | 0.5.0 | MIT |
| [stable_deref_trait](https://github.com/storyyeller/stable_deref_trait) | 1.2.1 | MIT OR Apache-2.0 |
| [string_cache](https://github.com/servo/string-cache) | 0.9.0 | MIT OR Apache-2.0 |
| [strsim](https://github.com/rapidfuzz/strsim-rs) | 0.11.1 | MIT |
| [strum](https://github.com/Peternator7/strum) | 0.28.0 | MIT |
| [strum_macros](https://github.com/Peternator7/strum) | 0.28.0 | MIT |
| [subtle](https://github.com/dalek-cryptography/subtle) | 2.6.1 | BSD-3-Clause |
| [swift-rs](https://github.com/Brendonovich/swift-rs) | 1.0.7 | MIT OR Apache-2.0 |
| [syn](https://github.com/dtolnay/syn) | 1.0.109 | MIT OR Apache-2.0 |
| [syn](https://github.com/dtolnay/syn) | 2.0.117 | MIT OR Apache-2.0 |
| [sync_wrapper](https://github.com/Actyx/sync_wrapper) | 1.0.2 | Apache-2.0 |
| [synstructure](https://github.com/mystor/synstructure) | 0.13.2 | MIT |
| [system-configuration](https://github.com/mullvad/system-configuration-rs) | 0.7.0 | MIT OR Apache-2.0 |
| [system-configuration-sys](https://github.com/mullvad/system-configuration-rs) | 0.6.0 | MIT OR Apache-2.0 |
| [tao](https://github.com/tauri-apps/tao) | 0.35.3 | Apache-2.0 |
| [tao-macros](https://github.com/tauri-apps/tao) | 0.1.3 | MIT OR Apache-2.0 |
| [tauri](https://github.com/tauri-apps/tauri) | 2.11.2 | Apache-2.0 OR MIT |
| [tauri-codegen](https://github.com/tauri-apps/tauri) | 2.6.2 | Apache-2.0 OR MIT |
| [tauri-macros](https://github.com/tauri-apps/tauri) | 2.6.2 | Apache-2.0 OR MIT |
| [tauri-plugin-clipboard-manager](https://github.com/tauri-apps/plugins-workspace) | 2.3.2 | Apache-2.0 OR MIT |
| [tauri-plugin-dialog](https://github.com/tauri-apps/plugins-workspace) | 2.7.1 | Apache-2.0 OR MIT |
| [tauri-plugin-fs](https://github.com/tauri-apps/plugins-workspace) | 2.5.1 | Apache-2.0 OR MIT |
| [tauri-plugin-shell](https://github.com/tauri-apps/plugins-workspace) | 2.3.5 | Apache-2.0 OR MIT |
| [tauri-plugin-store](https://github.com/tauri-apps/plugins-workspace) | 2.4.3 | Apache-2.0 OR MIT |
| [tauri-runtime](https://github.com/tauri-apps/tauri) | 2.11.2 | Apache-2.0 OR MIT |
| [tauri-runtime-wry](https://github.com/tauri-apps/tauri) | 2.11.2 | Apache-2.0 OR MIT |
| [tauri-utils](https://github.com/tauri-apps/tauri) | 2.9.2 | Apache-2.0 OR MIT |
| [tendril](https://github.com/servo/html5ever) | 0.5.0 | MIT OR Apache-2.0 |
| [thiserror](https://github.com/dtolnay/thiserror) | 1.0.69 | MIT OR Apache-2.0 |
| [thiserror](https://github.com/dtolnay/thiserror) | 2.0.18 | MIT OR Apache-2.0 |
| [thiserror-impl](https://github.com/dtolnay/thiserror) | 1.0.69 | MIT OR Apache-2.0 |
| [thiserror-impl](https://github.com/dtolnay/thiserror) | 2.0.18 | MIT OR Apache-2.0 |
| [tiff](https://github.com/image-rs/image-tiff) | 0.11.3 | MIT |
| [time](https://github.com/time-rs/time) | 0.3.47 | MIT OR Apache-2.0 |
| [time-core](https://github.com/time-rs/time) | 0.1.8 | MIT OR Apache-2.0 |
| [time-macros](https://github.com/time-rs/time) | 0.2.27 | MIT OR Apache-2.0 |
| [tinystr](https://github.com/unicode-org/icu4x) | 0.8.3 | Unicode-3.0 |
| [tinyvec](https://github.com/Lokathor/tinyvec) | 1.11.0 | Zlib OR Apache-2.0 OR MIT |
| [tinyvec_macros](https://github.com/Soveu/tinyvec_macros) | 0.1.1 | MIT OR Apache-2.0 OR Zlib |
| [tokio](https://github.com/tokio-rs/tokio) | 1.52.3 | MIT |
| [tokio-macros](https://github.com/tokio-rs/tokio) | 2.7.0 | MIT |
| [tokio-rustls](https://github.com/rustls/tokio-rustls) | 0.26.5 | MIT OR Apache-2.0 |
| [tokio-util](https://github.com/tokio-rs/tokio) | 0.7.18 | MIT |
| [toml](https://github.com/toml-rs/toml) | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 |
| [toml_datetime](https://github.com/toml-rs/toml) | 0.6.3 | MIT OR Apache-2.0 |
| [toml_datetime](https://github.com/toml-rs/toml) | 1.1.1+spec-1.1.0 | MIT OR Apache-2.0 |
| [toml_edit](https://github.com/toml-rs/toml) | 0.19.15 | MIT OR Apache-2.0 |
| [toml_edit](https://github.com/toml-rs/toml) | 0.20.2 | MIT OR Apache-2.0 |
| [toml_edit](https://github.com/toml-rs/toml) | 0.25.11+spec-1.1.0 | MIT OR Apache-2.0 |
| [toml_parser](https://github.com/toml-rs/toml) | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 |
| [toml_writer](https://github.com/toml-rs/toml) | 1.1.1+spec-1.1.0 | MIT OR Apache-2.0 |
| [tower](https://github.com/tower-rs/tower) | 0.5.3 | MIT |
| [tower-http](https://github.com/tower-rs/tower-http) | 0.6.11 | MIT |
| [tower-layer](https://github.com/tower-rs/tower) | 0.3.3 | MIT |
| [tower-service](https://github.com/tower-rs/tower) | 0.3.3 | MIT |
| [tracing](https://github.com/tokio-rs/tracing) | 0.1.44 | MIT |
| [tracing-attributes](https://github.com/tokio-rs/tracing) | 0.1.31 | MIT |
| [tracing-core](https://github.com/tokio-rs/tracing) | 0.1.36 | MIT |
| [tray-icon](https://github.com/tauri-apps/tray-icon) | 0.23.1 | MIT OR Apache-2.0 |
| [tree_magic_mini](https://github.com/mbrubeck/tree_magic/) | 3.2.2 | MIT |
| [try-lock](https://github.com/seanmonstar/try-lock) | 0.2.5 | MIT |
| [ttf-parser](https://github.com/RazrFalcon/ttf-parser) | 0.20.0 | MIT OR Apache-2.0 |
| [typeid](https://github.com/dtolnay/typeid) | 1.0.3 | MIT OR Apache-2.0 |
| [typenum](https://github.com/paholg/typenum) | 1.20.0 | MIT OR Apache-2.0 |
| [unic-char-property](https://github.com/open-i18n/rust-unic/) | 0.9.0 | MIT OR Apache-2.0 |
| [unic-char-range](https://github.com/open-i18n/rust-unic/) | 0.9.0 | MIT OR Apache-2.0 |
| [unic-common](https://github.com/open-i18n/rust-unic/) | 0.9.0 | MIT OR Apache-2.0 |
| [unic-ucd-ident](https://github.com/open-i18n/rust-unic/) | 0.9.0 | MIT OR Apache-2.0 |
| [unic-ucd-version](https://github.com/open-i18n/rust-unic/) | 0.9.0 | MIT OR Apache-2.0 |
| [unicode-ident](https://github.com/dtolnay/unicode-ident) | 1.0.24 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| [unicode-segmentation](https://github.com/unicode-rs/unicode-segmentation) | 1.13.2 | MIT OR Apache-2.0 |
| [unicode-xid](https://github.com/unicode-rs/unicode-xid) | 0.2.6 | MIT OR Apache-2.0 |
| [untrusted](https://github.com/briansmith/untrusted) | 0.7.1 | ISC |
| [untrusted](https://github.com/briansmith/untrusted) | 0.9.0 | ISC |
| [url](https://github.com/servo/rust-url) | 2.5.8 | MIT OR Apache-2.0 |
| [urlpattern](https://github.com/denoland/rust-urlpattern) | 0.3.0 | MIT |
| [utf-8](https://github.com/SimonSapin/rust-utf8) | 0.7.6 | MIT OR Apache-2.0 |
| [utf8_iter](https://github.com/hsivonen/utf8_iter) | 1.0.4 | Apache-2.0 OR MIT |
| [uuid](https://github.com/uuid-rs/uuid) | 1.23.1 | Apache-2.0 OR MIT |
| [walkdir](https://github.com/BurntSushi/walkdir) | 2.5.0 | Unlicense OR MIT |
| [want](https://github.com/seanmonstar/want) | 0.3.1 | MIT |
| [wasi](https://github.com/bytecodealliance/wasi) | 0.11.1+wasi-snapshot-preview1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wasip2](https://github.com/bytecodealliance/wasi-rs) | 1.0.3+wasi-0.2.9 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wasip3](https://github.com/bytecodealliance/wasi-rs) | 0.4.0+wasi-0.3.0-rc-2026-01-06 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wasm-bindgen](https://github.com/wasm-bindgen/wasm-bindgen) | 0.2.122 | MIT OR Apache-2.0 |
| [wasm-bindgen-futures](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/futures) | 0.4.72 | MIT OR Apache-2.0 |
| [wasm-bindgen-macro](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro) | 0.2.122 | MIT OR Apache-2.0 |
| [wasm-bindgen-macro-support](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro-support) | 0.2.122 | MIT OR Apache-2.0 |
| [wasm-bindgen-shared](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/shared) | 0.2.122 | MIT OR Apache-2.0 |
| [wasm-encoder](https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wasm-encoder) | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wasm-metadata](https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wasm-metadata) | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wasm-streams](https://github.com/MattiasBuelens/wasm-streams/) | 0.5.0 | MIT OR Apache-2.0 |
| [wasmparser](https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wasmparser) | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wayland-backend](https://github.com/smithay/wayland-rs) | 0.3.15 | MIT |
| [wayland-client](https://github.com/smithay/wayland-rs) | 0.31.14 | MIT |
| [wayland-protocols](https://github.com/smithay/wayland-rs) | 0.32.12 | MIT |
| [wayland-protocols-wlr](https://github.com/smithay/wayland-rs) | 0.3.12 | MIT |
| [wayland-scanner](https://github.com/smithay/wayland-rs) | 0.31.10 | MIT |
| [wayland-sys](https://github.com/smithay/wayland-rs) | 0.31.11 | MIT |
| [web_atoms](https://github.com/servo/html5ever) | 0.2.4 | MIT OR Apache-2.0 |
| [web-sys](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/web-sys) | 0.3.99 | MIT OR Apache-2.0 |
| [web-time](https://github.com/daxpedda/web-time) | 1.1.0 | MIT OR Apache-2.0 |
| [webkit2gtk](https://github.com/tauri-apps/webkit2gtk-rs) | 2.0.2 | MIT |
| [webkit2gtk-sys](https://github.com/tauri-apps/webkit2gtk-rs) | 2.0.2 | MIT |
| [webpki-root-certs](https://github.com/rustls/webpki-roots) | 1.0.9 | CDLA-Permissive-2.0 |
| [webview2-com](https://github.com/wravery/webview2-rs) | 0.38.2 | MIT |
| [webview2-com-macros](https://github.com/wravery/webview2-rs) | 0.8.1 | MIT |
| [webview2-com-sys](https://github.com/wravery/webview2-rs) | 0.38.2 | MIT |
| [weezl](https://github.com/image-rs/weezl) | 0.1.12 | MIT OR Apache-2.0 |
| [winapi](https://github.com/retep998/winapi-rs) | 0.3.9 | MIT OR Apache-2.0 |
| [winapi-i686-pc-windows-gnu](https://github.com/retep998/winapi-rs) | 0.4.0 | MIT OR Apache-2.0 |
| [winapi-util](https://github.com/BurntSushi/winapi-util) | 0.1.11 | Unlicense OR MIT |
| [winapi-x86_64-pc-windows-gnu](https://github.com/retep998/winapi-rs) | 0.4.0 | MIT OR Apache-2.0 |
| [window-vibrancy](https://github.com/tauri-apps/tauri-plugin-vibrancy) | 0.6.0 | Apache-2.0 OR MIT |
| [windows](https://github.com/microsoft/windows-rs) | 0.61.3 | MIT OR Apache-2.0 |
| [windows](https://github.com/microsoft/windows-rs) | 0.62.2 | MIT OR Apache-2.0 |
| [windows_aarch64_gnullvm](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_aarch64_gnullvm](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_aarch64_gnullvm](https://github.com/microsoft/windows-rs) | 0.53.1 | MIT OR Apache-2.0 |
| [windows_aarch64_msvc](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_aarch64_msvc](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_aarch64_msvc](https://github.com/microsoft/windows-rs) | 0.53.1 | MIT OR Apache-2.0 |
| [windows_i686_gnu](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_i686_gnu](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_i686_gnu](https://github.com/microsoft/windows-rs) | 0.53.1 | MIT OR Apache-2.0 |
| [windows_i686_gnullvm](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_i686_gnullvm](https://github.com/microsoft/windows-rs) | 0.53.1 | MIT OR Apache-2.0 |
| [windows_i686_msvc](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_i686_msvc](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_i686_msvc](https://github.com/microsoft/windows-rs) | 0.53.1 | MIT OR Apache-2.0 |
| [windows_x86_64_gnu](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_x86_64_gnu](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_x86_64_gnu](https://github.com/microsoft/windows-rs) | 0.53.1 | MIT OR Apache-2.0 |
| [windows_x86_64_gnullvm](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_x86_64_gnullvm](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_x86_64_gnullvm](https://github.com/microsoft/windows-rs) | 0.53.1 | MIT OR Apache-2.0 |
| [windows_x86_64_msvc](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows_x86_64_msvc](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows_x86_64_msvc](https://github.com/microsoft/windows-rs) | 0.53.1 | MIT OR Apache-2.0 |
| [windows-collections](https://github.com/microsoft/windows-rs) | 0.2.0 | MIT OR Apache-2.0 |
| [windows-collections](https://github.com/microsoft/windows-rs) | 0.3.2 | MIT OR Apache-2.0 |
| [windows-core](https://github.com/microsoft/windows-rs) | 0.61.2 | MIT OR Apache-2.0 |
| [windows-core](https://github.com/microsoft/windows-rs) | 0.62.2 | MIT OR Apache-2.0 |
| [windows-future](https://github.com/microsoft/windows-rs) | 0.2.1 | MIT OR Apache-2.0 |
| [windows-future](https://github.com/microsoft/windows-rs) | 0.3.2 | MIT OR Apache-2.0 |
| [windows-implement](https://github.com/microsoft/windows-rs) | 0.60.2 | MIT OR Apache-2.0 |
| [windows-interface](https://github.com/microsoft/windows-rs) | 0.59.3 | MIT OR Apache-2.0 |
| [windows-link](https://github.com/microsoft/windows-rs) | 0.1.3 | MIT OR Apache-2.0 |
| [windows-link](https://github.com/microsoft/windows-rs) | 0.2.1 | MIT OR Apache-2.0 |
| [windows-numerics](https://github.com/microsoft/windows-rs) | 0.2.0 | MIT OR Apache-2.0 |
| [windows-numerics](https://github.com/microsoft/windows-rs) | 0.3.1 | MIT OR Apache-2.0 |
| [windows-registry](https://github.com/microsoft/windows-rs) | 0.6.1 | MIT OR Apache-2.0 |
| [windows-result](https://github.com/microsoft/windows-rs) | 0.3.4 | MIT OR Apache-2.0 |
| [windows-result](https://github.com/microsoft/windows-rs) | 0.4.1 | MIT OR Apache-2.0 |
| [windows-strings](https://github.com/microsoft/windows-rs) | 0.4.2 | MIT OR Apache-2.0 |
| [windows-strings](https://github.com/microsoft/windows-rs) | 0.5.1 | MIT OR Apache-2.0 |
| [windows-sys](https://github.com/microsoft/windows-rs) | 0.45.0 | MIT OR Apache-2.0 |
| [windows-sys](https://github.com/microsoft/windows-rs) | 0.52.0 | MIT OR Apache-2.0 |
| [windows-sys](https://github.com/microsoft/windows-rs) | 0.59.0 | MIT OR Apache-2.0 |
| [windows-sys](https://github.com/microsoft/windows-rs) | 0.60.2 | MIT OR Apache-2.0 |
| [windows-sys](https://github.com/microsoft/windows-rs) | 0.61.2 | MIT OR Apache-2.0 |
| [windows-targets](https://github.com/microsoft/windows-rs) | 0.42.2 | MIT OR Apache-2.0 |
| [windows-targets](https://github.com/microsoft/windows-rs) | 0.52.6 | MIT OR Apache-2.0 |
| [windows-targets](https://github.com/microsoft/windows-rs) | 0.53.5 | MIT OR Apache-2.0 |
| [windows-threading](https://github.com/microsoft/windows-rs) | 0.1.0 | MIT OR Apache-2.0 |
| [windows-threading](https://github.com/microsoft/windows-rs) | 0.2.1 | MIT OR Apache-2.0 |
| [windows-version](https://github.com/microsoft/windows-rs) | 0.1.7 | MIT OR Apache-2.0 |
| [winnow](https://github.com/winnow-rs/winnow) | 0.5.40 | MIT |
| [winnow](https://github.com/winnow-rs/winnow) | 1.0.3 | MIT |
| [winprint](https://github.com/ArcticLampyrid/winprint.rs/) | 0.2.1 | BSD-3-Clause |
| [wit-bindgen](https://github.com/bytecodealliance/wit-bindgen) | 0.51.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wit-bindgen](https://github.com/bytecodealliance/wit-bindgen) | 0.57.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wit-bindgen-core](https://github.com/bytecodealliance/wit-bindgen) | 0.51.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wit-bindgen-rust](https://github.com/bytecodealliance/wit-bindgen) | 0.51.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wit-bindgen-rust-macro](https://github.com/bytecodealliance/wit-bindgen) | 0.51.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wit-component](https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wit-component) | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wit-parser](https://github.com/bytecodealliance/wasm-tools/tree/main/crates/wit-parser) | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| [wl-clipboard-rs](https://github.com/YaLTeR/wl-clipboard-rs) | 0.9.3 | MIT OR Apache-2.0 |
| [writeable](https://github.com/unicode-org/icu4x) | 0.6.3 | Unicode-3.0 |
| [wry](https://github.com/tauri-apps/wry) | 0.55.1 | Apache-2.0 OR MIT |
| [x11](https://github.com/AltF02/x11-rs.git) | 2.21.0 | MIT |
| [x11-dl](https://github.com/AltF02/x11-rs.git) | 2.21.0 | MIT |
| [x11rb](https://github.com/psychon/x11rb) | 0.13.2 | MIT OR Apache-2.0 |
| [x11rb-protocol](https://github.com/psychon/x11rb) | 0.13.2 | MIT OR Apache-2.0 |
| [xml](https://github.com/kornelski/xml-rs) | 1.4.0 | MIT |
| [yoke](https://github.com/unicode-org/icu4x) | 0.8.2 | Unicode-3.0 |
| [yoke-derive](https://github.com/unicode-org/icu4x) | 0.8.2 | Unicode-3.0 |
| [zerocopy](https://github.com/google/zerocopy) | 0.8.50 | BSD-2-Clause OR Apache-2.0 OR MIT |
| [zerocopy-derive](https://github.com/google/zerocopy) | 0.8.50 | BSD-2-Clause OR Apache-2.0 OR MIT |
| [zerofrom](https://github.com/unicode-org/icu4x) | 0.1.8 | Unicode-3.0 |
| [zerofrom-derive](https://github.com/unicode-org/icu4x) | 0.1.7 | Unicode-3.0 |
| [zeroize](https://github.com/RustCrypto/utils) | 1.9.0 | Apache-2.0 OR MIT |
| [zeroize_derive](https://github.com/RustCrypto/utils) | 1.5.0 | Apache-2.0 OR MIT |
| [zerotrie](https://github.com/unicode-org/icu4x) | 0.2.4 | Unicode-3.0 |
| [zerovec](https://github.com/unicode-org/icu4x) | 0.11.6 | Unicode-3.0 |
| [zerovec-derive](https://github.com/unicode-org/icu4x) | 0.11.3 | Unicode-3.0 |
| [zmij](https://github.com/dtolnay/zmij) | 1.0.21 | MIT |
| [zune-core](https://github.com/etemesi254/zune-image) | 0.5.1 | MIT OR Apache-2.0 OR Zlib |
| [zune-jpeg](https://github.com/etemesi254/zune-image/tree/dev/crates/zune-jpeg) | 0.5.15 | MIT OR Apache-2.0 OR Zlib |
<!-- END GENERATED CRATE LIST -->
