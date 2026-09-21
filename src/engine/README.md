# engine — raster / compositing engine

The pixel engine: the operations that read and write bitmaps, and the layer
system that renders them on the GPU. It knows nothing about files, panels, or
the document model. Depends only on `core/`; everything above (model, formats,
features, UI) depends on it.

| File / dir | Role |
|------------|------|
| `compositing/` | The operations, 42 modules: blend and composite ops, buffer and pixel helpers, colour maths and matrices, blur and convolution, warp and homography, quantisers, anti-aliasing, path and mesh rendering, selection maths, content-aware fill, healing, camera raw, feature matching |
| `layer-system.js` | `LayerSystem`: the GL context, the compiled shader programs, render targets and texture bookkeeping |

## Importing from here

Import the symbol from the module that defines it. There is no namespace and no
assembly step:

```js
import { allocBuffer } from "../engine/compositing/buffer-utils.js";
import { composite } from "../engine/compositing/compositing-ops.js";
import { LayerSystem } from "../engine/layer-system.js";
```

**Rule:** a new pixel operation is an exported function in the
`compositing/` module that owns its concern — it is not registered anywhere, and
it does not import the document model or the UI.

## The one live layer system

There is a single `LayerSystem` because it owns a GL context. Building the
object is pure — methods and shader-source tables — so it happens when
`layer-system.js` evaluates. The canvas and the GL context need a document, so
they wait for `initLayerSystemGl()`, which `main.js` calls once before the first
paint. Until then `LayerSystem.webglEnabled` is false and the CPU paths run,
which is what the tests exercise.

## What lives here and what does not

The engine imports nothing from above it. Anything the render paths need — the
adjustment shader ids, the default composite params, the canvas mapping for PSD
stroke caps and joins — is engine vocabulary and lives here. Anything that needs
to know what a layer *means* belongs in `document/` or `features/`.

A slice looked up by a runtime value stays a table rather than becoming loose
exports: `BLEND_FUNCTIONS` in `compositing-ops.js` is keyed by a layer's blend
mode code, and the gradient renderers by gradient style.

See [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for the full layering.
