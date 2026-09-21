# Typr (generated)

Browser scripts for font parsing and HarfBuzz text shaping, **generated** from the
[`photopea/Typr.js`](https://github.com/photopea/Typr.js) submodule at
`src/vendor/typr`. Do not edit the `.js` files here by hand — run `./build.sh`.

| File | Source |
|------|--------|
| `Typr.js` | copied verbatim from `vendor/typr/src/Typr.js` |
| `Typr.U.SVG.js` | copied verbatim from `vendor/typr/src/Typr.U.SVG.js` |
| `Typr.U.js` | `vendor/typr/src/Typr.U.js` **+ one patch** (see below) |
| `LICENSE` | copied from the submodule (MIT, © Photopea) |

## Why a build step

The only branch photopea publishes (`gh-pages`) ships `Typr.U.js` with the
HarfBuzz WASM memory-growth lines in `shapeHB()` commented out. With our bundled
`hb.wasm` that overflows the heap (`RangeError: … out of bounds` in
`heapu8.set`) on any font larger than the initial 16 MB page - `build.sh` re-enables it:

```js
var olen = mem.buffer.byteLength, nlen = 2*fdata.length + str.length*16 + 4e6;
if (olen < nlen) mem["grow"](((nlen - olen) >>> 16) + 4);
```

`build.sh` aborts if those upstream lines move, so the patch can't silently
become a no-op after a submodule bump.

## Regenerating

```sh
git submodule update --remote src/vendor/typr   # optional: pull newer upstream
src/vendor/js/typr/build.sh
```

The generated files are committed so a fresh clone runs without rebuilding.
