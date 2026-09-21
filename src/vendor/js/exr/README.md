# EXR loader (generated)

Browser bundle exposing the global `EXRLoader.parse(buffer)` → `{ width, height, data }`
(Float32 RGBA), **generated** from the [`parse-exr`](https://github.com/dmnsgn/parse-exr)
submodule at `src/vendor/parse-exr` (pinned **v1.0.2**, MIT — a dependency-light port of
three.js's `EXRLoader`). The app uses one call site
(`src/document/io/codecs/raster-ext-codecs.js`). Run `./build.sh` — don't edit by hand.

| File | Source |
|------|--------|
| `entry.js` | hand-written wrapper: `parse-exr` → global `EXRLoader.parse` (FloatType) |
| `exr.js` | `entry.js` + `parse-exr` + `fflate` bundled with esbuild (IIFE) |
| `LICENSE` | copied from the submodule (MIT) |

## Notes

- Replaces the old `ext-exr.js`, which was a minified three.js `EXRLoader` adapted to use
  global `pako`. `parse-exr` bundles its own decompressor (`fflate`), so **global pako is no
  longer required** for EXR.
- Verified **pixel-identical** to the old bundle on ZIP, PIZ and uncompressed test files
  (`maxPixelDiff = 0`).

## Regenerating

```sh
git submodule update --init src/vendor/parse-exr
src/vendor/js/exr/build.sh        # needs Node + npx (installs fflate, fetches esbuild)
```
