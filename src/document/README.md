# Document module

File I/O, PSD parsing, and the editing tools. Code is grouped by responsibility; import the module that owns what you need.

## Where to work

| Path | When you are changing… |
|------|----------------------|
| [`model/`](model/) | The runtime document model: `Document`, `Layer`, `LayerGroup`, masks, placed layers, the viewport, and the geometry every tool shares (guide snapping, layer translation) |
| [`tools/`](tools/) | The tools a user activates from the toolbar, grouped by family (paint, selection, lasso, pen/path, shape, crop, retouch, view, move, text) |
| [`transform/`](transform/) | The transform gesture: the handle quad and warp mesh, applying a transform to layers, and the free-transform / warp / puppet-warp / slice tools |
| [`render/`](render/) | The walk that turns a layer tree into pixels: software and WebGL composite paths, clipping groups, adjustment layers, and redrawing a layer under a matrix |
| `layer-thumbnails.js` | Thumbnail painters for the layers, channels and paths panels |
| `import-layout.js` | Clamping an oversized imported document to the pixel budget, and reading a bounds rect from a frame — shared by the vector and app-document loaders |
| [`formats/registry/`](formats/registry/) | Format detection, encode/decode dispatch, open/save helpers |
| [`formats/codecs/`](formats/codecs/) | `FileFormatRegistry` raster encode/decode codecs (JPEG, WebP, camera-raw, …) |
| [`formats/psd/`](formats/psd/) | PSD binary parsing and descriptor codecs |
| [`formats/`](formats/) | One module per foreign document format at the folder root (`<ext>-format.js`: pdf, svg, ai, cdr, fig, dxf, …) |
| [`formats/metadata/`](formats/metadata/) | ICC/XMP, colour transforms, container parsers (plist, RIFF, IFF, SQLite) |

## Common entry points

```js
import { ToolId, ToolBase } from "../document/model/tool-base.js";
import { BrushTool } from "../document/tools/paint-tools.js";
import { FileFormatRegistry } from "../document/formats/registry/file-format-registry.js";
import { PSDParser } from "../document/formats/psd/psd-parser.js";
```

- **Tools** — each tool is a named export of the module for its family. `ToolId` and `EventChannel` in `model/tool-base.js` are the id tables tools are selected and routed by.
- **Open/save** — `formats/registry/file-format-registry.js` (`detectFormat`, `getFormat`, `encodeDocument`, `openFiles`).
- **PSD** — `formats/psd/psd-parser.js` and siblings under `formats/psd/`.
- **New file format** — add a codec to the matching `formats/codecs/<group>.js`, then register it in `formatCodecMap` in `formats/registry/file-format-registry.js`. Layered documents (PSD, PXD, Sketch, XD, Figma, XCF, FPNG, PDN) go in `formats/codecs/layered-codec.js`.

## Conventions

- **Tool modules** export the tools they define and, at module scope, chain each tool's prototype onto the base it extends with `Object.create(Base.prototype)`. Naming a base means importing it, and an imported module is evaluated first, so the base is finished before anything extends it — there is no registration order to keep.
- **A tool owns its gesture, not its maths.** Anything a second tool needs belongs in a module of its own: snapping a drag to guides, translating layers, flooding a selection out from a pixel, and building a selection or shape action all live beside the model or the tools rather than on whichever tool class reached them first.
- **Loaders vs codecs** — the `<ext>-format.js` modules and `formats/metadata/*` turn bytes into layer trees (or helpers); `formats/codecs/*` implement the `FileFormatRegistry` raster encode/decode surface.
- **Format file names** — one `<ext>-format.js` per foreign document format, keyed by the file extension (`ai`, `cdr`, `fig`, `af`, `dxf`, …) and owning both read and write where the format supports both; a header comment names the full format where the extension is terse. Standalone container parsers in `metadata/` keep the `<name>-parser.js` suffix.
