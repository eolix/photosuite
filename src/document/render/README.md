# document/render — turning a layer tree into pixels

`model/` is the document: layers, groups, nesting, geometry. This folder is the
walk over that tree which produces an image.

| File | Role |
|------|------|
| `layer-compositor.js` | The composite walk. `compositeLayerGpu` is what `Document.composite` drives; `renderThumbnailCanvases` builds the panel thumbnails. Software and WebGL paths, clipping-mask groups, opacity wrappers, adjustment layers. |
| `raster-transform.js` | Redrawing a layer's pixels under a matrix. `rasterizeWithMatrix` takes a mip chain and a matrix and returns the pixels as they should look — a smart object re-rasterises through it when its placement changes, and the vector importers bake a page into a bitmap with it. |

Every function takes the tree node it renders as its first argument, so a
`LayerGroup` stays data and the render policy lives here.

The compositor imports the adjustment engine and the layer-style renderer
directly. Vocabulary comes from whichever module owns it: `adjustmentKeyOf` in
`formats/psd/adjustment-parsers.js` answers which adjustment a layer carries,
and the engine holds its own shader ids and composite defaults.
