# File formats

Reading and writing on-disk formats, and turning their bytes into the document
model.

At the folder **root** sits one `<ext>-format.js` per foreign document format —
`af-format.js`, `ai-format.js`, `cdr-format.js`, `dxf-format.js`,
`fig-format.js`, `fpng-format.js`, `sketch-format.js`, `svg-format.js`,
`xcf-format.js`, `xd-format.js`. Each owns both read and write where the format
supports both (e.g. SVG, DXF); a header comment names the full format.
`vector-page-builder.js` and `vector-page-exporter.js` sit beside them: the
shared page model the vector writers build into and render from.

Specialized buckets:

| Folder | Role |
|--------|------|
| `registry/` | Format detection + encode/decode dispatch + open/save helpers |
| `codecs/` | `FileFormatRegistry` codecs — raster, the `vector` group, and `layered-codec.js` for layered documents; each exports `{ encode?, decode?, isLayered? }` |
| `psd/` | PSD binary parsing and descriptor codecs |
| `metadata/` | ICC/XMP, colour transforms, and container parsers (plist, RIFF, IFF, SQLite) |

## Registry files

| File | Role |
|------|------|
| `registry/file-format-registry.js` | Public `FileFormatRegistry` API; assembles the format id → codec map |
| `registry/registry-helpers.js` | Leaf imports for codecs: `getFormat`, `codecLoaders`, `detectFormat`, `matchBytesAt`, `growWasmMemory`, `bytesToBase64` |
| `registry/registry-api.js` | `openFiles`, `encodeDocument`, data-URL helpers, `formatGroups` (imports helpers only — avoids codec cycles) |

A codec whose decoder is not available synchronously — because the host has to
render it, or because a WebAssembly binary has to load first — exports
`decodeAsync` instead of `decode`. `file-loader.js` takes that path when it is
present, keeps the open veil up until it settles, and `decode` then serves the
cached frames for a second open of the same bytes.

`main.js` calls `FileFormatRegistry.installLoaders({…})` once at startup so codecs can resolve `PSDParser`, `SVGLoader`, etc. through `codecLoaders` without `file-format-registry.js` importing those loaders (import-cycle break).

There is no barrel module under `codecs/`; the codec map is bound explicitly in
`registry/file-format-registry.js`.

## Adding a format

1. Add the codec to the matching `codecs/<group>.js` (or `codecs/layered-codec.js`
   for layered documents), e.g. `export const myFormatCodec = { encode?, decode?, isLayered? }`.
   Use `getFormat`, `codecLoaders`, `growWasmMemory` from `registry/registry-helpers.js`; do
   not import `registry/file-format-registry.js` from a codec.
2. Import it in `registry/file-format-registry.js` and add it to `formatCodecMap`.
3. Extend `detectFormat` in `registry/registry-helpers.js` if magic-byte detection is needed.
4. Add the id to `formatGroups` in `registry/registry-api.js` to surface it in export UI lists.

## Codec modules (grouped by format family)

| Module | Formats |
|--------|---------|
| `codecs/jpeg.js` | JPG |
| `codecs/webp.js` | WEBP (decode: `external/wasm/webp.wasm`, encode: canvas or `wasm/webp-encode.wasm`) |
| `codecs/avif.js` | AVIF (read-only; decoded by the host WebView through `createImageBitmap`) |
| `codecs/heic.js` | HEIC, HEIF (read-only; decoded by `vendor/wasm/libheif`, fetched on first open) |
| `codecs/raster-common.js` | PNG, GIF, ICO, TIFF |
| `codecs/raster-bitmap.js` | BMP, TGA, PPM, ILBM |
| `codecs/raster-texture.js` | DDS, VTF |
| `codecs/raster-hdr.js` | EXR, FITS |
| `codecs/raster-extra.js` | LIF, EXE |
| `codecs/camera-raw.js` | RAF, RAW |
| `codecs/vector.js` | SVG, EPS, PDF, AI, WMF, EMF, CDR, DXF |
| `codecs/layered-codec.js` | PSD, PXD, Sketch, XD, Figma, XCF, Figma-proto, PDN |
