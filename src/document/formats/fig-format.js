// Figma (.fig) document loader: unpacks the Kiwi-schema message, rebuilds the
// node tree, and converts each Figma node into document layers — vector shapes,
// text, image fills, symbol instances, effects, and clip masks.
/* global UZIP */
import { Point } from "../../core/math/point.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { BinarySchemaDecoder } from "../../core/binary/binary-schema-decoder.js";
import { BlendModes } from "../model/blend-modes.js";
import { FileFormatRegistry } from "./registry/file-format-registry.js";

import { LayerStyleRenderer } from "../../features/layer-styles/style-renderer.js";
import { Document } from "../model/document.js";
import { Layer, LayerSectionType } from "../model/layer.js";
import { LayerEffectDefs } from "./psd/effect-defs.js";
import { FilterDefs } from "../../features/filters/filter-apply.js";
import { TextEngineData } from "../../features/text/text-engine.js";
import { Mask, VectorMask } from "../model/layer-masks.js";
import { confirmUser } from "../../core/user-prompts.js";
import { TransformToolBase } from "../transform/transform-static.js";
import { packDoublesList } from "./psd/descriptor-codec.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { buildCanvasPathRecords, pixelAlignRect, rectToPathOutline, transformCoordPairs } from "../../engine/compositing/anti-alias.js";
import { flipPixelsHoriz } from "../../engine/compositing/homography.js";
import { ellipsePathRecords, pieSlicePathRecords, rectanglePathRecords, regularPolygonPathRecords, starPathRecords } from "../../engine/compositing/shape-primitives.js";
import { boundsOfPathRecords, roundCornersOnSubpath } from "../../engine/compositing/selection-utils.js";
import { allSegmentKnotsAreStraight, isOrthogonalQuadPath, transformPathRecordCoords } from "../../engine/compositing/path-records.js";
import { cssStopsToGradientDesc, gradientAngleFromPoints, psdColorToRgb, toRGBDesc } from "../../engine/compositing/psd-color-utils.js";

/** Max pixels in the document composite buffer (~256 MP). */
const MAX_COMPOSITE_PIXELS = 268435456;
/** Max pixels and longest side a single import scale step must fit within. */
const MAX_IMPORT_PIXELS = 8192 * 8192;
const MAX_IMPORT_DIMENSION = 30000;
/** Vertical gap inserted between stacked Figma pages in the merged canvas. */
const PAGE_VERTICAL_GAP = 100;
/** Chunks at this schema scale factor or above are ZSTD-compressed. */
const ZSTD_SCALE_FACTOR = 70;

const SHAPE_NODE_TYPES =
  "BOOLEAN_OPERATION LINE RECTANGLE ROUNDED_RECTANGLE ELLIPSE VECTOR REGULAR_POLYGON STAR".split(" ");

// ---------------------------------------------------------------------------
// Import scale
// ---------------------------------------------------------------------------

/**
 * Pick the integer downscale that fits a Figma document into the engine's
 * raster limits. No confirm dialog — the Tauri WebView cannot show a sync
 * confirm during parse (confirmUser fails closed, reading as "Cancel"),
 * so the scale is applied silently and reported afterward.
 * @param {Rect} documentBounds
 * @returns {number} integer scale >= 1
 */
function computeFigmaImportScale(documentBounds) {
  var scale = 1;
  while (
    scaledArea(documentBounds, scale) > MAX_IMPORT_PIXELS ||
    scaledLongestSide(documentBounds, scale) > MAX_IMPORT_DIMENSION
  ) {
    scale++;
  }
  while (scaledArea(documentBounds, scale) > MAX_COMPOSITE_PIXELS) {
    scale++;
  }
  return scale;
}

function scaledArea(rect, scale) {
  return Math.round(rect.width / scale) * Math.round(rect.height / scale);
}

function scaledLongestSide(rect, scale) {
  return Math.max(Math.round(rect.width / scale), Math.round(rect.height / scale));
}

// ---------------------------------------------------------------------------
// ZSTD chunk inflate
// ---------------------------------------------------------------------------

/**
 * Inflate one ZSTD chunk through the registry's WASM decoder, growing the
 * output buffer until the frame fits. Returns an empty array if the decoder
 * is unavailable.
 * @param {Uint8Array} compressed
 * @returns {Uint8Array}
 */
function decompressZstd(compressed) {
  var wasm = FileFormatRegistry.aiCodec.zstdWasmExports;
  if (wasm == null) return new Uint8Array(0);
  var srcLen = compressed.length;
  var sizeMultiple = 8;
  FileFormatRegistry.growWasmMemory(wasm, 1e6 + srcLen);
  var mem = new Uint8Array(wasm.memory.buffer);
  var srcPtr = wasm.malloc(srcLen);
  mem.set(compressed, srcPtr);
  while (true) {
    FileFormatRegistry.growWasmMemory(wasm, srcLen * (sizeMultiple + 2) + 1e6);
    var dstPtr = wasm.malloc(srcLen * sizeMultiple);
    var decompressedLen = wasm.ZSTD_decompress(dstPtr, srcLen * sizeMultiple, srcPtr, srcLen);
    if (decompressedLen === -ZSTD_SCALE_FACTOR) {
      // Output buffer too small — free it, enlarge, and retry.
      wasm.free(dstPtr);
      if (sizeMultiple > 256) throw "fig: zstd output buffer too small";
      sizeMultiple += 4;
    } else {
      var out = new Uint8Array(wasm.memory.buffer).slice(dstPtr, dstPtr + decompressedLen);
      wasm.free(dstPtr);
      wasm.free(srcPtr);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Document entry
// ---------------------------------------------------------------------------

/**
 * Parse a Figma `.fig` buffer into layer structure on `doc`.
 * @param {ArrayBuffer} bytes
 * @param {import("../model/document.js").Document} doc
 */
function parse(bytes, doc) {
  doc.deferFillRasterization = true;
  try {
    parseFigmaDocument(bytes, doc);
  } finally {
    doc.deferFillRasterization = false;
  }
}

function parseFigmaDocument(bytes, doc) {
  var decoded = decodeFigmaMessage(bytes);
  var figmaRoot = decoded.figmaRoot;
  doc.pendingTextRasterization = true;
  var loadContext = buildLoadContext(figmaRoot, decoded.zipEntries);
  var canvasChildren = figmaRoot.nodeChanges[0].children;

  var layout = layoutPages(canvasChildren);
  var downscale = computeFigmaImportScale(new Rect(0, 0, layout.bounds.width, layout.bounds.height));
  doc.width = Math.round(layout.bounds.width / downscale);
  doc.height = Math.round(layout.bounds.height / downscale);
  doc.buffer = allocBuffer(doc.width * doc.height * 4);

  var artboardCount = 0;
  for (var pageIdx = 0; pageIdx < canvasChildren.length; pageIdx++) {
    var pageNode = canvasChildren[pageIdx];
    var pageLayers = pageNode.children;
    if (pageNode.name === "Internal Only Canvas" || pageLayers == null) continue;
    pageLayers.sort(compareLayerOrder);
    var pageMatrix = new Matrix2D(
      1, 0, 0, 1,
      -layout.pageBounds[pageIdx].x,
      layout.pageYOffsets[pageIdx] - layout.pageBounds[pageIdx].y,
    );
    pageMatrix.scale(1 / downscale, 1 / downscale);
    for (var layerIdx = 0; layerIdx < pageLayers.length; layerIdx++) {
      nodeToLayer(pageLayers[layerIdx], [], pageMatrix, figmaRoot.blobs, doc, 0, loadContext);
      artboardCount++;
    }
  }
  doc.initArtboardDocument(artboardCount);
  doc.needsFillRasterization = true;
  if (downscale !== 1) {
    setTimeout(function() { alert("File scaled down " + downscale + "x"); }, 0);
  }
}

/**
 * Unwrap the optional PK zip envelope, inflate each schema chunk, and decode
 * the root Kiwi message.
 * @returns {{figmaRoot: object, zipEntries: ?object}} decoded message and the
 *   parsed zip entries (null when the buffer is not zip-wrapped)
 */
function decodeFigmaMessage(bytes) {
  var byteView = new Uint8Array(bytes);
  var offset = 8;
  var zipEntries = null;
  if (byteView[0] === 80 && byteView[1] === 75) {
    zipEntries = UZIP.parse(bytes);
    byteView = zipEntries["canvas.fig"];
  }
  var scaleFactor = BinaryUtils.readFloat32(byteView, offset);
  offset += 4;
  var chunks = [];
  while (offset < byteView.length) {
    var chunkLength = BinaryUtils.readFloat32(byteView, offset);
    offset += 4;
    var chunkBytes = byteView.slice(offset, offset + chunkLength);
    if (byteView[offset] === 137 && byteView[offset + 1] === 80) {
      // PNG chunk — leave as-is.
    } else if (scaleFactor >= ZSTD_SCALE_FACTOR && chunks.length !== 0) {
      var zstdOut = decompressZstd(chunkBytes);
      chunkBytes = zstdOut.length === 0 ? UZIP.inflateRaw(chunkBytes) : zstdOut;
    } else {
      chunkBytes = UZIP.inflateRaw(chunkBytes);
    }
    chunks.push(chunkBytes);
    offset += chunkLength;
  }

  // Chunk 0 is the schema; chunk 1 is the root message encoded against it.
  var schemaEntries = BinarySchemaDecoder.parseSchema(chunks[0]);
  var messageSchemaIndex = 0;
  for (var schemaIdx = 0; schemaIdx < schemaEntries.length; schemaIdx++) {
    if (schemaEntries[schemaIdx][1] === "Message") messageSchemaIndex = schemaIdx;
  }
  var figmaRoot = BinarySchemaDecoder.decodeMessage(
    chunks[1], 0, schemaEntries, schemaEntries[messageSchemaIndex], 0,
  )[0];
  return { figmaRoot: figmaRoot, zipEntries: zipEntries };
}

/**
 * Index nodes by guid and wire children to their parents.
 * @returns {object} load context carried through node conversion
 */
function buildLoadContext(figmaRoot, zipEntries) {
  var loadContext = {
    clipMaskState: {},
    nodesByGuidKey: {},
    patternCacheByBlobId: {},
    zipEntries: zipEntries,
  };
  var nodeChanges = figmaRoot.nodeChanges;
  for (var nodeIdx = 0; nodeIdx < nodeChanges.length; nodeIdx++) {
    var nodeChange = nodeChanges[nodeIdx];
    var guid = nodeChange.guid;
    loadContext.nodesByGuidKey[guid.sessionID + "," + guid.localID] = nodeChange;
  }
  for (var nodeIdx = 0; nodeIdx < nodeChanges.length; nodeIdx++) {
    var nodeChange = nodeChanges[nodeIdx];
    var parentIndex = nodeChange.parentIndex;
    if (parentIndex) {
      var parentNode = guidLookup(loadContext.nodesByGuidKey, parentIndex.guid);
      if (parentNode.children == null) parentNode.children = [];
      parentNode.children.push(nodeChange);
    }
  }
  return loadContext;
}

/**
 * Stack each page vertically and accumulate the merged document bounds.
 * @returns {{bounds: Rect, pageBounds: Rect[], pageYOffsets: number[]}}
 */
function layoutPages(canvasChildren) {
  var documentBounds = new Rect();
  var pageBounds = [];
  var pageYOffsets = [];
  for (var pageIdx = 0; pageIdx < canvasChildren.length; pageIdx++) {
    var pageNode = canvasChildren[pageIdx];
    var pageLayers = pageNode.children;
    if (pageNode.name === "Internal Only Canvas" || pageLayers == null) continue;
    var bounds = new Rect();
    for (var layerIdx = 0; layerIdx < pageLayers.length; layerIdx++) {
      var layerNode = pageLayers[layerIdx];
      var transform = layerNode.transform;
      var size = layerNode.size;
      if (transform.m00 === 1 && transform.m10 === 0 && transform.m01 === 0 && transform.m11 === 1) {
        bounds = bounds.union(new Rect(transform.m02, transform.m12, size.x, size.y));
      }
    }
    var yOffset = documentBounds.height === 0 ? 0 : documentBounds.height + PAGE_VERTICAL_GAP;
    var stacked = bounds.clone();
    stacked.x = 0;
    stacked.y = yOffset;
    documentBounds = documentBounds.union(stacked);
    pageBounds[pageIdx] = bounds;
    pageYOffsets[pageIdx] = yOffset;
  }
  return { bounds: documentBounds, pageBounds: pageBounds, pageYOffsets: pageYOffsets };
}

// ---------------------------------------------------------------------------
// Node → layer conversion
// ---------------------------------------------------------------------------

/**
 * Convert one Figma node (and its subtree) into document layers.
 * @param {object} node
 * @param {object[]} symbolOverrides instance overrides inherited from ancestors
 * @param {Matrix2D} parentMatrix
 * @param {object} blobs
 * @param {import("../model/document.js").Document} doc
 * @param {number} depth
 * @param {object} loadContext
 */
function nodeToLayer(node, symbolOverrides, parentMatrix, blobs, doc, depth, loadContext) {
  symbolOverrides = symbolOverrides.slice(0);
  node = applySymbolOverrides(node, symbolOverrides);

  var nodeType = node.type;
  var children = node.children;
  var nodeSize = node.size || { x: 0, y: 0 };
  var effects = node.effects;

  var layer = doc.newLayer();
  layer.setName(node.name);
  layer.setVisible(node.visible);
  layer.Opct = Math.round(node.opacity * 255);

  var worldMatrix = figmaTransformToMatrix(node.transform);
  worldMatrix.concat(parentMatrix);
  var layerRect = boundsRectFor(worldMatrix, nodeSize);

  var fillPaints = resolveFillPaints(node.fillPaints, node.inheritFillStyleID, loadContext);
  var primaryFill = fillPaints[0];
  if (primaryFill && primaryFill.type === "IMAGE" &&
      resolveImageBytes(blobs, imageHashFromFill(primaryFill), loadContext, true) == null) {
    primaryFill = null;
  }
  var strokePaints = resolveFillPaints(node.strokePaints, node.inheritFillStyleIDForStroke, loadContext);

  var isShape = SHAPE_NODE_TYPES.indexOf(nodeType) !== -1;
  var vectorMask = null;
  var isOrthoQuad = false;
  if (isShape || nodeType === "FRAME" || nodeType === "INSTANCE") {
    vectorMask = new VectorMask();
    buildShapeGeometry(node, blobs, vectorMask);
    isOrthoQuad = isOrthogonalQuadPath(vectorMask.pathRecords);
    transformPathRecordCoords(vectorMask.pathRecords, worldMatrix);
    var pathBounds = pixelAlignRect(
      boundsOfPathRecords(vectorMask.pathRecords),
    );
    if (!pathBounds.isEmpty()) layerRect = pathBounds;
    mergeClipMaskIntoVectorMask(loadContext, vectorMask, primaryFill);
  }

  var imageFill = describeImageFill(primaryFill, nodeSize, blobs, loadContext);

  if (nodeType === "FRAME") {
    // Frame fill is emitted by the trailing FRAME branch below.
  } else if (isShape && isOrthoQuad && imageFill && imageFillRendersAsSmartObject(imageFill)) {
    layer = importImageFillAsSmartObject(
      node, layer, primaryFill, imageFill, effects, nodeSize, worldMatrix, blobs, doc, loadContext,
    );
  } else if (isShape) {
    applyLayerFillAndStroke(layer, vectorMask, node, primaryFill, strokePaints, worldMatrix, layerRect, blobs, doc, loadContext);
    applyForegroundBlurFeather(effects, vectorMask);
    layer.invalidate(doc);
  } else if (nodeType === "TEXT") {
    buildTextLayer(node, layer, nodeSize, worldMatrix, blobs, doc, loadContext);
  } else if (nodeType === "SYMBOL") {
    // Symbol definition — produces no layer; instances pull its children.
  } else if (nodeType === "INSTANCE" && node.symbolData) {
    var symbolData = node.symbolData;
    var symbolNode = guidLookup(loadContext.nodesByGuidKey, symbolData.symbolID);
    if (symbolNode) children = symbolNode.children;
    else console.log(node.name, "symbol not found", symbolData.symbolID);
    for (var overrideIdx = 0; overrideIdx < symbolData.symbolOverrides.length; overrideIdx++) {
      symbolOverrides.push(symbolData.symbolOverrides[overrideIdx]);
    }
  } else {
    console.log(nodeType);
  }

  if (children && !isShape) {
    emitGroupLayer(node, layer, children, fillPaints, strokePaints, vectorMask, layerRect, worldMatrix, blobs, doc, depth, symbolOverrides, loadContext);
  } else if (nodeType === "FRAME" && primaryFill && vectorMask) {
    applyLayerFillAndStroke(layer, vectorMask, node, primaryFill, strokePaints, worldMatrix, layerRect, blobs, doc, loadContext);
    layer.invalidate(doc);
    doc.layers.push(layer);
  } else if (node.mask) {
    if (vectorMask) loadContext.clipMaskState.vectorMask = vectorMask;
  } else {
    emitLayerEffects(node, layer, nodeType, isShape, fillPaints, strokePaints, effects, children, worldMatrix, layerRect, blobs, doc, loadContext);
  }
}

/**
 * Merge ancestor instance overrides keyed to this node, consuming one guid hop
 * per nested override. Returns the (possibly merged) node.
 */
function applySymbolOverrides(node, symbolOverrides) {
  var overrideKey = node.overrideKey ? node.overrideKey : node.guid;
  for (var idx = 0; idx < symbolOverrides.length; idx++) {
    var override = symbolOverrides[idx];
    var guidPath = override.guidPath.guids;
    if (guidEquals(guidPath[0], overrideKey)) {
      if (guidPath.length === 1) {
        var merged = {};
        for (var propKey in node) {
          merged[propKey] = override[propKey] != null ? override[propKey] : node[propKey];
        }
        node = merged;
      } else {
        override.guidPath.guids = guidPath.slice(1);
      }
    }
  }
  return node;
}

/** Resolve fill paints, following an inherited fill style when present. */
function resolveFillPaints(paints, inheritStyleId, loadContext) {
  if (inheritStyleId) {
    var styleNode = guidLookup(loadContext.nodesByGuidKey, inheritStyleId);
    if (styleNode) paints = styleNode.fillPaints;
  }
  if (paints == null) paints = [];
  return normalizeFills(paints);
}

/** World-space pixel bounds for a node, with a 100px fallback for empty rects. */
function boundsRectFor(worldMatrix, nodeSize) {
  var rect = new Rect(
    Math.round(worldMatrix.tx),
    Math.round(worldMatrix.ty),
    Math.round(nodeSize.x * worldMatrix.getScale()),
    Math.round(nodeSize.y * worldMatrix.getScale()),
  );
  if (rect.width === 0 || isNaN(rect.width)) rect.width = 100;
  if (rect.height === 0 || isNaN(rect.height)) rect.height = 100;
  return rect;
}

/** Append the active clip mask's subpaths (as holes) to an image-backed shape. */
function mergeClipMaskIntoVectorMask(loadContext, vectorMask, primaryFill) {
  if (!(loadContext.clipMaskState.vectorMask && primaryFill)) return;
  var clipPaths = VectorMask.clonePathRecords(loadContext.clipMaskState.vectorMask.pathRecords);
  for (var clipIdx = 2; clipIdx < clipPaths.length; clipIdx++) {
    if (clipPaths[clipIdx].fillRule != null) clipPaths[clipIdx].fillRule = 3;
  }
  vectorMask.pathRecords = vectorMask.pathRecords.concat(clipPaths.slice(2));
}

/**
 * Inspect a primary image fill, resolving original dimensions from the decoded
 * raster when the node does not carry them.
 * @returns {?object} image fill summary, or null when not an image fill
 */
function describeImageFill(primaryFill, nodeSize, blobs, loadContext) {
  if (!(primaryFill && primaryFill.type === "IMAGE")) return null;
  var originalW = primaryFill.originalImageWidth;
  var originalH = primaryFill.originalImageHeight;
  if (originalW * originalH === 0) {
    var rasterPayload = resolveImageBytes(blobs, imageHashFromFill(primaryFill), loadContext);
    originalW = rasterPayload.rect.width;
    originalH = rasterPayload.rect.height;
  }
  return {
    scaleMode: primaryFill.imageScaleMode,
    aspectDelta: Math.abs(originalW / originalH - nodeSize.x / nodeSize.y),
  };
}

/** Whether an image fill should round-trip through a placed smart object. */
function imageFillRendersAsSmartObject(imageFill) {
  return imageFill.scaleMode === "FIT" ||
    (imageFill.scaleMode === "FILL" && imageFill.aspectDelta <= 0.05) ||
    (imageFill.scaleMode === "STRETCH" && imageFill.aspectDelta <= 0.05);
}

/**
 * Replace the layer with a placed smart object holding the fill image, carrying
 * over Figma blur / exposure / vibrance paint adjustments as smart filters.
 * @returns {Layer} the smart object layer
 */
function importImageFillAsSmartObject(node, layer, primaryFill, imageFill, effects, nodeSize, worldMatrix, blobs, doc, loadContext) {
  var imageBytes = resolveImageBytes(blobs, imageHashFromFill(primaryFill), loadContext, true);
  var smartLayer = doc.createSmartObjectLayer(imageBytes, layer.getName(), 0, 0);
  smartLayer.layerFlags = layer.layerFlags;
  smartLayer.Opct = layer.Opct;

  var fitRect = new Rect(0, 0, nodeSize.x, nodeSize.y);
  if (imageFill.scaleMode === "FIT") {
    var imgW = primaryFill.originalImageWidth;
    var imgH = primaryFill.originalImageHeight;
    var fitScale = Math.min(nodeSize.x / imgW, nodeSize.y / imgH);
    var fittedW = imgW * fitScale;
    var fittedH = imgH * fitScale;
    fitRect = new Rect(
      fitRect.x + (fitRect.width - fittedW) / 2,
      fitRect.y + (fitRect.height - fittedH) / 2,
      fittedW, fittedH,
    );
  }
  var cornerCoords = rectToPathOutline(fitRect).coords;
  transformCoordPairs(cornerCoords, worldMatrix, cornerCoords);
  smartLayer.add.placedData.Trnf = packDoublesList(cornerCoords);
  smartLayer.add.placedData.nonAffineTransform = packDoublesList(cornerCoords);

  var filterList = buildImageFillSmartFilters(primaryFill.paintFilter, effects, worldMatrix);
  if (filterList.length !== 0) {
    smartLayer.add.placedData.filterFX = FilterDefs.createEmptyFilterFxStyle();
    doc.addPlacedItemId({
      id: smartLayer.add.placedData.placed.v,
      rect: new Rect(),
      buffer: allocBuffer(1),
      d: new Mask(),
    });
    smartLayer.add.placedData.filterFX.v.filterFXList.v = filterList;
  }
  smartLayer.rasterizeSmartObject(doc, false);
  copyClipMaskToLayer(loadContext, smartLayer, doc);
  return smartLayer;
}

/** Translate Figma foreground blur and paint adjustments into filter descriptors. */
function buildImageFillSmartFilters(paintFilter, effects, worldMatrix) {
  var filterList = [];
  if (effects) {
    for (var effectIdx = 0; effectIdx < effects.length; effectIdx++) {
      if (effects[effectIdx].type === "FOREGROUND_BLUR") {
        var blurEffect = effects[effectIdx];
        var blurFilter = FilterDefs.createFilterFxDescriptor("GsnB", {});
        filterList.push(blurFilter);
        blurFilter.v.enab.v = blurEffect.visible;
        blurFilter.v.Fltr.v.Rds.v.val = blurEffect.radius / 2.4;
      }
    }
  }
  if (paintFilter && paintFilter.exposure !== 0) {
    var exposureFilter = FilterDefs.createFilterFxDescriptor("brit", {});
    filterList.push(exposureFilter);
    exposureFilter.v.Fltr.v.Brgh.v = Math.round(paintFilter.exposure * 160);
    exposureFilter.v.Fltr.v.useLegacy.v = true;
  }
  if (paintFilter && paintFilter.vibrance !== 0) {
    var vibranceFilter = FilterDefs.createFilterFxDescriptor("vibA", {});
    filterList.push(vibranceFilter);
    vibranceFilter.v.Fltr.v.Strt.v = Math.round(Math.round(paintFilter.vibrance * 100));
  }
  return filterList;
}

/** Apply the first foreground-blur effect as vector-mask feathering. */
function applyForegroundBlurFeather(effects, vectorMask) {
  if (!effects) return;
  for (var effectIdx = 0; effectIdx < effects.length; effectIdx++) {
    if (effects[effectIdx].type === "FOREGROUND_BLUR") {
      vectorMask.feather = effects[effectIdx].radius / 2.4;
    }
  }
}

/** Build a text layer with engine data, alignment, auto-resize, and styles. */
function buildTextLayer(node, layer, nodeSize, worldMatrix, blobs, doc, loadContext) {
  var textData = node.textData;
  var layoutSize = textData.layoutSize || node.size;
  var alignIdx = ["LEFT", "RIGHT", "CENTER"].indexOf(node.textAlignHorizontal);
  if (alignIdx === -1) alignIdx = 0;

  layer.add.lnsr = "rend";
  layer.add.TySh = TextEngineData.createTextLayerData(0, 0);
  layer.add.TySh.boundsRect = new Rect(0, 0, 100, 100);
  var textMatrix = worldMatrix.clone();
  layer.add.TySh.transform = textMatrix;
  var engineData = layer.add.TySh.engineData;

  var characters = normalizeTextCharacters(textData.characters, node.textCase);
  TextEngineData.insertText(engineData, 0, characters);

  var baselines = textData.baselines;
  var textAutoResize = node.textAutoResize;
  if (textAutoResize === "WIDTH_AND_HEIGHT") {
    var hAlignOffset = alignIdx === 0 ? 0 : alignIdx === 1 ? layoutSize.x : layoutSize.x / 2;
    var vAlignOffset = baselines ? baselines[0].position.y : node.fontSize;
    textMatrix.translate(hAlignOffset * worldMatrix.getScale(), vAlignOffset * worldMatrix.getScale());
    TextEngineData.setTextType(engineData, 0);
  } else if (textAutoResize === "HEIGHT" || textAutoResize === "NONE" || textAutoResize == null) {
    var topOffset = baselines ? baselines[0].position.y - node.fontSize * 0.7 : 0;
    textMatrix.translate(0, topOffset * worldMatrix.getScale());
    TextEngineData.setTextType(engineData, 1);
    TextEngineData.setBoxBounds(engineData, [
      0, 0,
      Math.round(layoutSize.x),
      Math.round((textAutoResize === "NONE" ? 1.8 : 1) * layoutSize.y),
    ]);
  } else {
    throw "fig: unsupported textAutoResize " + textAutoResize;
  }

  if (characters !== "") {
    applyTextStyleRuns(node, characters, textData, engineData, worldMatrix, nodeSize, layer, blobs, doc, loadContext);
  }
}

/** Apply title-case and collapse Figma line separators to plain newlines. */
function normalizeTextCharacters(characters, textCase) {
  if (textCase === "TITLE") {
    for (var charIdx = 0; charIdx < characters.length; charIdx++) {
      if (charIdx === 0 || characters[charIdx - 1] === " ") {
        characters = characters.slice(0, charIdx) + characters[charIdx].toUpperCase() + characters.slice(charIdx + 1);
      }
    }
  }
  characters = characters.replace(/\u2028/g, "\n");
  characters = characters.replace(/\u2029/g, "\n");
  characters = characters.replace(/\r\n/g, " \n");
  return characters;
}

/** Apply the base style then each character-style-override run. */
function applyTextStyleRuns(node, characters, textData, engineData, worldMatrix, nodeSize, layer, blobs, doc, loadContext) {
  var textStyle = TextEngineData.getTextStyle(engineData, 0, 1);
  applyTextStyle(node, worldMatrix, nodeSize, textStyle, layer, blobs, doc, loadContext);
  TextEngineData.applyStyle(engineData, 0, characters.length, textStyle);

  var charStyleIds = textData.characterStyleIDs;
  var styleOverrideTable = textData.styleOverrideTable;
  if (!charStyleIds) return;

  charStyleIds = charStyleIds.slice(0);
  for (var charIdx = 0; charIdx < charStyleIds.length; charIdx++) {
    if (characters[charIdx] === "\n") charStyleIds[charIdx] = -charIdx - 1;
  }
  // Pack runs as [start, length, start, length, …] of constant style id.
  var styleRunBreaks = [0];
  var runCharCount = 0;
  for (var charIdx = 0; charIdx < charStyleIds.length; charIdx++) {
    runCharCount++;
    if (charIdx !== 0 && charStyleIds[charIdx] !== charStyleIds[charIdx - 1]) {
      styleRunBreaks.push(runCharCount - 1, charIdx);
      runCharCount = 1;
    }
  }
  styleRunBreaks.push(runCharCount);

  for (var breakIdx = 0; breakIdx < styleRunBreaks.length; breakIdx += 2) {
    var runStart = styleRunBreaks[breakIdx];
    var runLen = styleRunBreaks[breakIdx + 1];
    if (characters[runStart] === "\n") continue;
    var styleIdAt = charStyleIds[runStart];
    if (styleIdAt === 0) continue;
    var overrideStyleNode;
    for (var scanIdx = 0; scanIdx < styleOverrideTable.length; scanIdx++) {
      if (styleOverrideTable[scanIdx].styleID === styleIdAt) overrideStyleNode = styleOverrideTable[scanIdx];
    }
    textStyle = TextEngineData.getTextStyle(engineData, runStart, runStart + 1);
    applyTextStyle(overrideStyleNode, worldMatrix, nodeSize, textStyle, layer, blobs, doc, loadContext);
    TextEngineData.applyStyle(engineData, runStart, runStart + runLen, textStyle);
  }
}

/**
 * Emit a closed group layer plus its child layers, optional background fill,
 * artboard rect (top level), and frame clip mask.
 */
function emitGroupLayer(node, layer, children, fillPaints, strokePaints, vectorMask, layerRect, worldMatrix, blobs, doc, depth, symbolOverrides, loadContext) {
  var nodeType = node.type;
  doc.layers.push(doc.createGroupEndLayer());
  var addedBackground = false;
  var isTopLevelGroup = depth === 0 && nodeType !== "SYMBOL" && nodeType !== "INSTANCE";
  if (isTopLevelGroup) {
    if (layerRect.isEmpty()) console.log(layerRect);
    layer.setArtboardRect(layerRect);
  }

  var groupFill = fillPaints[fillPaints.length - 1];
  if (groupFill && groupFill.type === "IMAGE" &&
      resolveImageBytes(blobs, imageHashFromFill(groupFill), loadContext, true) == null) {
    groupFill = null;
  }
  if (isTopLevelGroup && groupFill && groupFill.type === "SOLID") {
    layer.add.artb.artboardBackgroundType.v = 4;
    layer.add.artb.Clr = figmaColorToDesc(groupFill.color);
  } else if ((groupFill || strokePaints[0]) && vectorMask) {
    var bgLayer = doc.newLayer();
    bgLayer.setName("Background");
    applyLayerFillAndStroke(bgLayer, vectorMask, node, groupFill, strokePaints, worldMatrix, layerRect, blobs, doc, loadContext);
    bgLayer.invalidate(doc);
    doc.layers.push(bgLayer);
    addedBackground = true;
  }

  children.sort(compareLayerOrder);
  var savedClipState = loadContext.clipMaskState;
  loadContext.clipMaskState = {};
  for (var childIdx = 0; childIdx < children.length; childIdx++) {
    nodeToLayer(children[childIdx], symbolOverrides, worldMatrix, blobs, doc, depth + 1, loadContext);
  }
  loadContext.clipMaskState = savedClipState;

  layer.add.lsct = LayerSectionType.ClosedGroup;
  layer.blendMode = "pass";
  var wasVisible = layer.isVisible();
  layer.layerFlags = 24;
  layer.setVisible(wasVisible);

  var needsClipMask = depth !== 0 && fillPaints.length !== 0 &&
    !node.frameMaskDisabled && node.containerSupportsFillStrokeAndCorners;
  if (!addedBackground && needsClipMask && vectorMask) {
    layer.add.vmsk = vectorMask;
    layer.invalidate(doc);
  } else {
    copyClipMaskToLayer(loadContext, layer, doc);
  }
  doc.layers.push(layer);
}

/**
 * Emit drop and inner shadows, fills, and strokes as layer effects (lmfx) on a
 * leaf layer.
 */
function emitLayerEffects(node, layer, nodeType, isShape, fillPaints, strokePaints, effects, children, worldMatrix, layerRect, blobs, doc, loadContext) {
  var effectPairs = [];
  appendShadowEffects(effectPairs, effects, worldMatrix);

  var fillStartIdx = 1;
  if (nodeType === "TEXT" && fillPaints[0] && fillPaints[0].type !== "SOLID") fillStartIdx = 0;
  for (var fillIdx = fillStartIdx; fillIdx < fillPaints.length; fillIdx++) {
    var fillDescPair = fillToDescriptor(node, fillPaints[fillIdx], worldMatrix, layerRect, blobs, doc, loadContext);
    if (fillDescPair[0] === "GdFl") effectPairs.push(["GrFl", fillDescPair[1]]);
    else if (fillDescPair[0] === "SoCo") effectPairs.push(["SoFi", fillDescPair[1]]);
    else if (fillDescPair[0] === "PtFl") effectPairs.push(["patternFill", fillDescPair[1]]);
    else if (fillDescPair[0] === "None") {
      // Invisible fill — no effect.
    } else throw "fig: unknown fill descriptor " + fillDescPair[0];
  }

  if (!isShape) appendStrokeFrameEffects(effectPairs, node, strokePaints, worldMatrix, layerRect, blobs, doc, loadContext);

  if (effectPairs.length !== 0) {
    var lmfxTemplate = LayerEffectDefs.createLmfxRootTemplate();
    for (var slotIdx = 0; slotIdx < LayerEffectDefs.order.length; slotIdx++) {
      lmfxTemplate[LayerEffectDefs.effectKeys[slotIdx]] = { t: "VlLs", v: [] };
    }
    for (var pairIdx = 0; pairIdx < effectPairs.length; pairIdx++) {
      var effectPair = effectPairs[pairIdx];
      var slotKey = LayerEffectDefs.effectKeys[LayerEffectDefs.order.indexOf(effectPair[0])];
      lmfxTemplate[slotKey].v.unshift({ t: "Objc", v: effectPair[1] });
    }
    if (children == null) layer.add.lmfx = lmfxTemplate;
  }
  doc.layers.push(layer);
}

/** Append drop-shadow / inner-shadow effect descriptors from Figma effects. */
function appendShadowEffects(effectPairs, effects, worldMatrix) {
  if (!effects) return;
  for (var effectIdx = 0; effectIdx < effects.length; effectIdx++) {
    var effectEntry = effects[effectIdx];
    var shadowKind = ["DROP_SHADOW", "INNER_SHADOW"].indexOf(effectEntry.type);
    if (shadowKind === -1) continue;
    var effectColor = effectEntry.color;
    var effectKey = ["DrSh", "IrSh"][shadowKind];
    var effectDesc = LayerEffectDefs.getEffectDefault(effectKey);
    effectPairs.push([effectKey, effectDesc]);
    effectDesc.enab.v = effectEntry.visible;
    effectDesc.Md.v.blendMode = BlendModes.toPSD(figmaToBlendMode(effectEntry.blendMode));
    effectDesc.Opct.v.val = Math.round(100 * effectColor.a);
    effectDesc.blur.v.val = Math.round(effectEntry.radius * worldMatrix.getScale());
    effectDesc.Clr = figmaColorToDesc(effectColor);
    var offsetX = effectEntry.offset.x;
    var offsetY = effectEntry.offset.y;
    effectDesc.uglg.v = false;
    effectDesc.lagl.v.val = Math.round(180 / Math.PI * Math.atan2(offsetY, -offsetX));
    effectDesc.Dstn.v.val = Math.round(Math.sqrt(offsetX * offsetX + offsetY * offsetY) * worldMatrix.getScale());
  }
}

/** Append solid strokes as frame (FrFX) effects on non-shape layers. */
function appendStrokeFrameEffects(effectPairs, node, strokePaints, worldMatrix, layerRect, blobs, doc, loadContext) {
  for (var strokeIdx = 0; strokeIdx < strokePaints.length; strokeIdx++) {
    var strokeDescPair = fillToDescriptor(node, strokePaints[strokeIdx], worldMatrix, layerRect, blobs, doc, loadContext);
    if (strokeDescPair[0] !== "SoCo") continue;
    var frameFx = LayerEffectDefs.getEffectDefault("FrFX");
    effectPairs.push(["FrFX", frameFx]);
    frameFx.enab = strokeDescPair[1].enab;
    frameFx.Opct = strokeDescPair[1].Opct;
    frameFx.Md = strokeDescPair[1].Md;
    frameFx.Clr = strokeDescPair[1].Clr;
    frameFx.Sz.v.val = Math.round(node.strokeWeight);
    if (node.strokeAlign) {
      frameFx.Styl.v.FStl = LayerEffectDefs.strokePositionOptions.types[["INSIDE", "CENTER", "OUTSIDE"].indexOf(node.strokeAlign)];
    }
  }
}

// ---------------------------------------------------------------------------
// Fill / stroke descriptors
// ---------------------------------------------------------------------------

/** Apply combined vector mask, fill, and stroke style to a shape layer. */
function applyLayerFillAndStroke(layer, vectorMask, node, primaryFill, strokePaints, worldMatrix, layerRect, blobs, doc, loadContext) {
  layer.layerFlags |= 16;
  layer.add.vmsk = vectorMask;
  var strokeDesc = layer.add.vstk = LayerEffectDefs.getStrokeStyleDefault();

  var fillDescPair = fillToDescriptor(node, primaryFill, worldMatrix, layerRect, blobs, doc, loadContext);
  strokeDesc.fillEnabled.v = fillDescPair[0] !== "None";
  if (fillDescPair[0] === "None") {
    layer.add.SoCo = fillDescPair[1];
  } else {
    applyFillOpacityToLayer(fillDescPair, layer);
    layer.add[fillDescPair[0]] = fillDescPair[1];
  }

  var strokeFillPair = fillToDescriptor(node, strokePaints[0], worldMatrix, layerRect, blobs, doc, loadContext);
  if (strokeFillPair[0] === "None") return;

  strokeDesc = layer.add.vstk;
  strokeDesc.strokeEnabled.v = true;
  strokeDesc.strokeStyleLineWidth.v.val = node.strokeWeight * worldMatrix.getScale();
  strokeDesc.strokeStyleLineAlignment.v.strokeStyleLineAlignment =
    LayerEffectDefs.StrokeStyleDefs.alignTypes[["INSIDE", "CENTER", "OUTSIDE"].indexOf(node.strokeAlign)];
  var strokeFillKind = { SoCo: "SoFi", GdFl: "GrFl", PtFl: "patternFill" }[strokeFillPair[0]];
  var strokeFillKindIdx = ["SoFi", "GrFl", "patternFill"].indexOf(strokeFillKind);
  var strokeFieldKeys = LayerEffectDefs.fillPropertyKeyGroups[strokeFillKindIdx];
  strokeDesc.strokeStyleContent.v = { classID: LayerEffectDefs.StrokeStyleDefs.fillLayerTypes[0] };
  if (node.dashPattern) {
    strokeDesc.strokeStyleLineDashSet.v = LayerStyleRenderer.dashArrayToStrokeDescriptor(
      node.dashPattern, 1 / node.strokeWeight,
    );
  }
  var strokeContent = strokeDesc.strokeStyleContent.v = {
    classID: LayerEffectDefs.StrokeStyleDefs.fillLayerTypes[strokeFillKindIdx],
  };
  for (var keyIdx = 0; keyIdx < strokeFieldKeys.length; keyIdx++) {
    strokeContent[strokeFieldKeys[keyIdx]] = strokeFillPair[1][strokeFieldKeys[keyIdx]];
  }
  if (!strokeDesc.fillEnabled.v) applyFillOpacityToLayer(strokeFillPair, layer);
}

/** Fold a fill descriptor's sub-100% opacity into the layer opacity. */
function applyFillOpacityToLayer(fillDescPair, layer) {
  var fillOpacity = fillDescPair[1].Opct.v.val;
  if (fillOpacity !== 100) {
    layer.Opct = Math.round(layer.Opct / 255 * (fillOpacity / 100) * 255);
  }
}

/** Sort sibling nodes by their fractional stacking position. */
function compareLayerOrder(nodeA, nodeB) {
  return nodeA.parentIndex.position > nodeB.parentIndex.position ? 1 : -1;
}

/**
 * Drop invisible / empty image fills and promote opaque image fills and
 * thumbnails. Mutates and returns the fill list.
 */
function normalizeFills(fills) {
  for (var idx = 1; idx < fills.length; idx++) {
    var fillEntry = fills[idx];
    if (fillEntry.type === "IMAGE" && fillEntry.opacity === 1) {
      fills = fills.slice(idx);
      break;
    }
  }
  for (var idx = 0; idx < fills.length; idx++) {
    fillEntry = fills[idx];
    var thumbnail = fillEntry.imageThumbnail;
    var isImage = fillEntry.type === "IMAGE";
    if (isImage && (fillEntry.image == null || fillEntry.image.dataBlob == null) && thumbnail && thumbnail.dataBlob) {
      fillEntry.image = thumbnail;
    }
    if (!fillEntry.visible || (isImage && fillEntry.image == null)) {
      fills.splice(idx, 1);
      idx--;
    }
  }
  return fills;
}

/** Clone the active clip mask onto a layer when one is in effect. */
function copyClipMaskToLayer(loadContext, layer, doc) {
  if (loadContext.clipMaskState.vectorMask) {
    layer.add.vmsk = loadContext.clipMaskState.vectorMask.clone();
    layer.invalidate(doc);
  }
}

/** Apply font, size, leading, alignment, and fill color to a text style run. */
function applyTextStyle(node, worldMatrix, nodeSize, textStyle, layer, blobs, doc, loadContext) {
  var fontSize = node.fontSize;
  var lineHeight = node.lineHeight;
  var fontName = node.fontName;
  var textAlign = node.textAlignHorizontal;
  var tracking = node.textTracking;
  var textCase = node.textCase;
  var textDecoration = node.textDecoration;
  if (fontSize == null) fontSize = textStyle.textStyle.FontSize;
  if (fontName) {
    var postscript = fontName.postscript;
    if (postscript === "") {
      postscript = fontName.family.split(" ").join("") + "-" + fontName.style;
    }
    TextEngineData.setTextFont(textStyle, postscript);
  }
  if (fontSize != null) textStyle.textStyle.FontSize = Math.round(fontSize);
  if (textDecoration === "UNDERLINE") textStyle.textStyle.Underline = true;
  if (tracking) textStyle.textStyle.Tracking = Math.round(tracking * 1000);
  if (textCase) textStyle.textStyle.FontCaps = textCase === "UPPER" ? 2 : 0;
  if (lineHeight && (lineHeight.units !== "PERCENT" || lineHeight.value !== 100)) {
    if (fontSize == null) fontSize = 15;
    var leadingPx = lineHeight.value;
    if (lineHeight.units === "PERCENT") leadingPx = fontSize * leadingPx / 100;
    if (lineHeight.units === "RAW") leadingPx = fontSize * leadingPx;
    textStyle.textStyle.AutoLeading = false;
    textStyle.textStyle.Leading = Math.round(leadingPx);
  }
  if (textAlign) textStyle.paraStyle.Justification = ["LEFT", "RIGHT", "CENTER"].indexOf(textAlign);

  var fillPaints = node.fillPaints;
  var inheritStyleId = node.inheritFillStyleID;
  if (inheritStyleId) {
    var styleNode = guidLookup(loadContext.nodesByGuidKey, inheritStyleId);
    if (styleNode) fillPaints = styleNode.fillPaints;
  }
  if (fillPaints && fillPaints[0]) {
    var fillDescPair = fillToDescriptor(node, fillPaints[0], worldMatrix, nodeSize, blobs, doc, loadContext);
    if (fillDescPair[0] === "SoCo") {
      var rgb = psdColorToRgb(fillDescPair[1].Clr.v);
      textStyle.textStyle.FillColor = {
        Type: 1,
        Values: [1, rgb.h / 255, rgb.l / 255, rgb.O / 255],
      };
      applyFillOpacityToLayer(fillDescPair, layer);
    }
  }
}

/**
 * Convert one Figma paint into a fill descriptor.
 * @returns {[string, object]} fill kind (one of SoCo, GdFl, PtFl, None) and
 *   the matching descriptor
 */
function fillToDescriptor(node, fillPaint, worldMatrix, layerRect, blobs, doc, loadContext) {
  var fillKind;
  var descriptor;
  var nodeSize = node.size || { x: 0, y: 0 };
  if (fillPaint) {
    var paintType = fillPaint.type;
    var gradientIdx = ["GRADIENT_LINEAR", "GRADIENT_RADIAL", "GRADIENT_DIAMOND", "GRADIENT_ANGULAR"].indexOf(paintType);
    if (paintType === "SOLID") {
      fillKind = "SoCo";
      descriptor = cloneEffectDefault("SoFi");
      descriptor.Clr = figmaColorToDesc(fillPaint.color);
    } else if (paintType === "PATTERN") {
      fillKind = "SoCo";
      descriptor = cloneEffectDefault("SoFi");
      descriptor.Clr = figmaColorToDesc(fillPaint.color);
    } else if (gradientIdx !== -1) {
      fillKind = "GdFl";
      descriptor = buildGradientDescriptor(fillPaint, gradientIdx, worldMatrix, layerRect, nodeSize);
    } else if (paintType === "IMAGE") {
      fillKind = "PtFl";
      descriptor = buildImagePatternDescriptor(fillPaint, worldMatrix, nodeSize, blobs, doc, loadContext);
    } else if (paintType === "VIDEO") {
      fillKind = "SoCo";
      descriptor = cloneEffectDefault("SoFi");
      descriptor.Clr = figmaColorToDesc({ r: 1, g: 0, b: 1, a: 1 });
    } else {
      console.log("fig: unknown fill type " + paintType);
    }
    if (descriptor) {
      descriptor.Opct = {
        t: "UntF",
        v: { type: "#Prc", val: Math.round(fillPaint.opacity * 100) },
      };
    }
  }
  if (fillKind == null || (fillPaint && fillPaint.opacity < 0.001)) {
    fillKind = "None";
    descriptor = {
      classID: "null",
      Clr: { t: "Objc", v: toRGBDesc({ h: 0, l: 0, O: 0 }) },
    };
  }
  return [fillKind, descriptor];
}

function cloneEffectDefault(effectKey) {
  return LayerEffectDefs.getEffectDefault(effectKey);
}

/** Build a gradient fill descriptor from a Figma gradient paint. */
function buildGradientDescriptor(fillPaint, gradientIdx, worldMatrix, layerRect, nodeSize) {
  var gradDesc = cloneEffectDefault("GrFl");
  var gradStops = gradDesc.Grad.v;
  gradStops.Intr.v = 0;
  gradDesc.Type.v.GrdT = ["Lnr", "Rdl", "Dmnd", "Angl"][gradientIdx];

  var cssStops = [];
  for (var stopIdx = 0; stopIdx < fillPaint.stops.length; stopIdx++) {
    var stopEntry = fillPaint.stops[stopIdx];
    var stopColor = stopEntry.color;
    cssStops.push([stopEntry.position, [stopColor.r, stopColor.g, stopColor.b], stopColor.a]);
  }
  cssStopsToGradientDesc(cssStops, gradStops);

  var paintMatrix = figmaTransformToMatrix(fillPaint.transform);
  paintMatrix.invert();
  var scaledMatrix = paintMatrix.clone();
  if (nodeSize) scaledMatrix.scale(nodeSize.x, nodeSize.y);
  scaledMatrix.concat(worldMatrix);
  var gradStart = scaledMatrix.transformPoint(new Point(0, 0.5));
  var gradEnd = scaledMatrix.transformPoint(new Point(1, 0.5));
  gradStart.x = gradEnd.x + 0.5 * (gradStart.x - gradEnd.x);
  gradStart.y = gradEnd.y + 0.5 * (gradStart.y - gradEnd.y);
  gradientAngleFromPoints(gradStart, gradEnd, layerRect, gradDesc);
  if (gradientIdx === 3 && scaledMatrix.a * scaledMatrix.d - scaledMatrix.b * scaledMatrix.c < 0) {
    gradDesc.Rvrs.v = !gradDesc.Rvrs.v;
  }
  return gradDesc;
}

/** Build a pattern fill descriptor, registering the image pattern once per blob. */
function buildImagePatternDescriptor(fillPaint, worldMatrix, nodeSize, blobs, doc, loadContext) {
  var patternDesc = cloneEffectDefault("patternFill");
  var fillTransform = figmaTransformToMatrix(fillPaint.transform);
  fillTransform.invert();
  var blobKey = imageHashFromFill(fillPaint);
  var cachedPattern = loadContext.patternCacheByBlobId[blobKey];
  if (cachedPattern == null) {
    var rasterPayload = resolveImageBytes(blobs, blobKey, loadContext);
    if (rasterPayload == null) {
      rasterPayload = { data: allocBuffer(4), rect: new Rect(0, 0, 1, 1) };
    }
    cachedPattern = loadContext.patternCacheByBlobId[blobKey] = {};
    cachedPattern.id = Document.generateUID();
    var pixelData = new Uint8Array(rasterPayload.data);
    var patternW = rasterPayload.rect.width;
    var patternH = rasterPayload.rect.height;
    if (fillTransform.a < 0) {
      var flipped = new Uint8Array(pixelData.length);
      flipPixelsHoriz(pixelData, flipped, patternW, patternH);
      pixelData = flipped;
    }
    cachedPattern.pixelData = [pixelData, rasterPayload.rect];
    cachedPattern.name = "someImage";
    doc.registerPattern(cachedPattern);
  }
  if (fillTransform.a < 0) fillTransform.a = -fillTransform.a;
  var scaleModeIndex = ["FILL", "FIT", "STRETCH", "TILE"].indexOf(fillPaint.imageScaleMode);
  var tileScale = scaleModeIndex === 3 ? fillPaint.scale : 1;
  applyImagePatternToDescriptor(
    cachedPattern, patternDesc, nodeSize.x, nodeSize.y, scaleModeIndex, worldMatrix, fillTransform, tileScale,
  );
  return patternDesc;
}

/**
 * Place an image pattern into a pattern-fill descriptor: scale to the layer
 * per scale mode, then encode angle, scale, and phase from the world matrix.
 */
function applyImagePatternToDescriptor(patternEntry, patternDesc, layerWidth, layerHeight, scaleModeIndex, worldMatrix, fillTransform, tileScale) {
  if (tileScale == null) tileScale = 1;
  if (fillTransform == null) fillTransform = new Matrix2D();
  var patternRect = patternEntry.pixelData[1];
  var patternW = patternRect.width;
  var patternH = patternRect.height;
  var patternMatrix = new Matrix2D();
  var centerPattern = scaleModeIndex < 2;
  if (centerPattern) patternMatrix.translate(-patternW / 2, -patternH / 2);
  if (scaleModeIndex === 0) {
    tileScale *= Math.max(layerWidth / patternW, layerHeight / patternH);
  } else if (scaleModeIndex === 1) {
    tileScale *= Math.min(layerWidth / patternW, layerHeight / patternH);
  } else if (scaleModeIndex === 2) {
    patternMatrix.scale(1 / patternW, 1 / patternH);
    patternMatrix.concat(fillTransform);
    patternMatrix.scale(layerWidth, layerHeight);
  }
  patternMatrix.scale(tileScale, tileScale);
  if (centerPattern) patternMatrix.translate(layerWidth / 2, layerHeight / 2);
  patternMatrix.concat(worldMatrix);
  patternDesc.Ptrn.v.Idnt.v = patternEntry.id;
  patternDesc.Scl.v.val = Math.round(100 * patternMatrix.getScale());
  if (patternDesc.Angl == null) {
    patternDesc.Angl = { t: "UntF", v: { type: "#Ang", val: 0 } };
  }
  patternDesc.Angl.v.val = Math.round(180 * Math.atan2(-patternMatrix.c, patternMatrix.a) / Math.PI);
  patternDesc.Algn.v = true;
  var phase = patternDesc.phase.v;
  phase.Hrzn.v = Math.round(patternMatrix.tx);
  phase.Vrtc.v = Math.round(patternMatrix.ty);
}

// ---------------------------------------------------------------------------
// Image blob resolution
// ---------------------------------------------------------------------------

/** Resolve a fill's image hash: explicit dataBlob, else 20-byte hash as hex. */
function imageHashFromFill(fillPaint) {
  var imageRef = fillPaint.image;
  var blobRef = imageRef.dataBlob;
  if (blobRef == null) {
    blobRef = "";
    for (var byteIdx = 0; byteIdx < 20; byteIdx++) {
      blobRef += imageRef.hash[byteIdx].toString(16).padStart(2, "0");
    }
  }
  return blobRef;
}

/**
 * Resolve image data for a blob key from inline blobs or the zip image folder.
 * @param {boolean} [bytesOnly] return raw bytes instead of a decoded raster
 * @returns {?(Uint8Array|object)}
 */
function resolveImageBytes(blobs, blobKey, loadContext, bytesOnly) {
  if (blobs[blobKey]) {
    var blobEntry = blobs[blobKey];
    if (bytesOnly) return blobEntry.bytes;
    if (blobEntry.decodedRaster) return blobEntry.decodedRaster;
    blobEntry.decodedRaster = decodeRasterBuffer(blobEntry.bytes.buffer);
    return blobEntry.decodedRaster;
  }
  if (loadContext.zipEntries == null) return null;
  if (bytesOnly) return loadContext.zipEntries["images/" + blobKey];
  var zipBytes = loadContext.zipEntries["images/" + blobKey];
  if (zipBytes == null) return null;
  var cacheKey = "images/-" + blobKey;
  if (loadContext.zipEntries[cacheKey]) return loadContext.zipEntries[cacheKey];
  loadContext.zipEntries[cacheKey] = decodeRasterBuffer(zipBytes.buffer);
  return loadContext.zipEntries[cacheKey];
}

/** Decode an image buffer to 8-bit raster pixels, falling back to a 1×1 pixel. */
function decodeRasterBuffer(bytesBuffer) {
  var formatId = FileFormatRegistry.detectFormat(bytesBuffer);
  if (formatId === "fpng") formatId = "png";
  var formatHandler = FileFormatRegistry.getFormat(formatId);
  try {
    var decoded = formatHandler.decode(bytesBuffer)[0];
    if (decoded.depth === 16) {
      decoded.depth = 8;
      var src16 = new Uint16Array(decoded.data);
      var dst8 = new Uint8Array(src16.length);
      for (var idx = 0; idx < src16.length; idx++) dst8[idx] = src16[idx] >> 8;
      decoded.data = dst8.buffer;
    }
    if (decoded.rect == null && decoded.width != null) {
      decoded.rect = new Rect(0, 0, decoded.width, decoded.height);
    }
    return decoded;
  } catch (decodeErr) {
    return { data: allocBuffer(4), rect: new Rect(0, 0, 1, 1) };
  }
}

// ---------------------------------------------------------------------------
// Shape geometry
// ---------------------------------------------------------------------------

/**
 * Build vector-mask path records for a Figma shape node — rectangles, ellipses
 * and arcs, lines, stars, polygons, boolean operations, and vector networks.
 * @param {object} node
 * @param {object} blobs
 * @param {VectorMask} vectorMask
 */
function buildShapeGeometry(node, blobs, vectorMask) {
  var shapeType = node.type;
  var size = node.size;
  var shapeW = size.x;
  var shapeH = size.y;
  var pathRecords;

  if (shapeType === "RECTANGLE" || shapeType === "ROUNDED_RECTANGLE" || shapeType === "FRAME" || shapeType === "INSTANCE") {
    pathRecords = rectanglePathRecords(0, 0, shapeW, shapeH, cornerRadiiOf(node));
  } else if (shapeType === "ELLIPSE") {
    pathRecords = buildEllipseGeometry(node, shapeW, shapeH);
  } else if (shapeType === "LINE") {
    pathRecords = rectanglePathRecords(0, 0, shapeW, shapeH, 0);
    pathRecords.pop();
    pathRecords.pop();
    pathRecords[2].length = 2;
  } else if (shapeType === "STAR") {
    pathRecords = starPathRecords(
      shapeW / 2, shapeH / 2, shapeW / 2, 2 * Math.PI * 0.25, 5, 0, node.starInnerScale,
    );
  } else if (shapeType === "REGULAR_POLYGON") {
    pathRecords = regularPolygonPathRecords(0.5, 0.5, 0.5, Math.PI / 2, node.count, 0);
    var scaleMatrix = new Matrix2D();
    scaleMatrix.scale(shapeW, shapeH);
    transformPathRecordCoords(pathRecords, scaleMatrix);
  } else if (shapeType === "BOOLEAN_OPERATION") {
    pathRecords = buildBooleanGeometry(node, blobs);
  } else if (shapeType === "VECTOR") {
    pathRecords = buildVectorNetworkGeometry(node, blobs);
    if (pathRecords == null) return;
  }
  vectorMask.pathRecords = pathRecords;
}

/** Per-corner radii, defaulting each to the node's uniform cornerRadius. */
function cornerRadiiOf(node) {
  var cornerRadius = node.cornerRadius == null ? 0 : node.cornerRadius;
  var radii = [cornerRadius, cornerRadius, cornerRadius, cornerRadius];
  var radiusKeys = [
    "rectangleTopLeftCornerRadius", "rectangleTopRightCornerRadius",
    "rectangleBottomRightCornerRadius", "rectangleBottomLeftCornerRadius",
  ];
  for (var idx = 0; idx < 4; idx++) {
    if (node[radiusKeys[idx]] != null) radii[idx] = node[radiusKeys[idx]];
  }
  return radii;
}

/** Ellipse, pie-slice arc, and donut (inner-radius) geometry. */
function buildEllipseGeometry(node, shapeW, shapeH) {
  var arcData = node.arcData;
  var startAngle = arcData ? arcData.startingAngle : 0;
  var endAngle = arcData ? arcData.endingAngle : 2 * Math.PI;
  var innerRadius = arcData ? arcData.innerRadius : 0;
  var pathRecords;
  if (startAngle === 0 && endAngle > 1.999 * Math.PI) {
    pathRecords = ellipsePathRecords(0, 0, shapeW, shapeH);
  } else {
    pathRecords = pieSlicePathRecords(
      shapeW / 2, shapeH / 2, shapeH / 2, startAngle, endAngle,
    );
  }
  if (innerRadius !== 0 && innerRadius !== 1) {
    var innerSlice = VectorMask.clonePathRecords(pathRecords).slice(3);
    innerSlice.reverse();
    for (var sliceIdx = 0; sliceIdx < innerSlice.length; sliceIdx++) {
      var knot = innerSlice[sliceIdx];
      var swapTmp = knot.cp1;
      knot.cp1 = knot.anchorOut;
      knot.anchorOut = swapTmp;
    }
    var innerMatrix = new Matrix2D();
    innerMatrix.translate(-shapeW / 2, -shapeH / 2);
    innerMatrix.scale(innerRadius, innerRadius);
    innerMatrix.translate(shapeW / 2, shapeH / 2);
    transformPathRecordCoords(innerSlice, innerMatrix);
    pathRecords = pathRecords.concat(innerSlice);
    pathRecords[2].length *= 2;
  }
  return pathRecords;
}

/** Combine child shape subpaths under a boolean operation's fill rule. */
function buildBooleanGeometry(node, blobs) {
  var pathRecords = [{ type: 6 }, { type: 8, all: 0 }];
  var boolOpIdx = ["XOR", "UNION", "SUBTRACT", "INTERSECT"].indexOf(node.booleanOperation);
  if (boolOpIdx === -1) throw "fig: unknown boolean operation";
  var childNodes = node.children || [];
  for (var childIdx = 0; childIdx < childNodes.length; childIdx++) {
    var childNode = childNodes[childIdx];
    var childMask = new VectorMask();
    buildShapeGeometry(childNode, blobs, childMask);
    if (childMask.pathRecords == null) continue;
    transformPathRecordCoords(
      childMask.pathRecords, figmaTransformToMatrix(childNode.transform),
    );
    pathRecords = pathRecords.concat(childMask.pathRecords.slice(2));
  }
  for (var recIdx = 3; recIdx < pathRecords.length; recIdx++) {
    if (pathRecords[recIdx].fillRule != null) pathRecords[recIdx].fillRule = boolOpIdx;
  }
  return pathRecords;
}

/**
 * Parse a Figma vector-network blob (vertices, Bézier segments, fill regions)
 * into path records, ordering open paths into a single walked loop, applying
 * corner rounding, and rescaling from normalized to node size.
 * @returns {?object[]} path records, or null when the node has no vector data
 */
function buildVectorNetworkGeometry(node, blobs) {
  var vectorData = node.vectorData;
  if (vectorData == null) return null;
  var normSize = vectorData.normalizedSize;
  var blobBytes = blobs[vectorData.vectorNetworkBlob].bytes;
  var u32View = new Uint32Array(blobBytes.buffer);
  var f32View = new Float32Array(blobBytes.buffer);

  var headerOffset = 3;
  var vertexCount = u32View[0];
  var segmentCount = u32View[1];
  var regionCount = u32View[2];
  var segmentOffset = headerOffset + vertexCount * 3;
  var regionOffset = segmentOffset + segmentCount * 7;

  var vertices = [];
  for (var vertIdx = 0; vertIdx < vertexCount; vertIdx++) {
    var vertBase = headerOffset + vertIdx * 3;
    if (Math.abs(f32View[vertBase]) > 1e-7) throw "fig: invalid vector vertex";
    vertices.push(new Point(f32View[vertBase + 1], f32View[vertBase + 2]));
  }
  // Each segment: [flags, startVertex, startTangentX, startTangentY, endVertex, endTangentX, endTangentY].
  var segments = [];
  for (var segIdx = 0; segIdx < segmentCount; segIdx++) {
    var segBase = segmentOffset + segIdx * 7;
    segments.push([
      u32View[segBase], u32View[segBase + 1],
      f32View[segBase + 2], f32View[segBase + 3],
      u32View[segBase + 4], f32View[segBase + 5], f32View[segBase + 6],
    ]);
  }
  var regions = readVectorRegions(u32View, regionOffset, regionCount);
  if (regions.length === 0 && segments.length !== 0) {
    regions = [walkOpenPath(vertices, segments)];
  }

  var pathRecords = segmentsToPathRecords(vertices, segments, regions);
  pathRecords = buildCanvasPathRecords(pathRecords, false);
  if (node.cornerRadius != null && node.cornerRadius !== 0) {
    applyVectorCornerRadius(pathRecords, node.cornerRadius);
  }
  var normMatrix = new Matrix2D();
  normMatrix.scale(
    normSize.x === 0 ? 1 : node.size.x / normSize.x,
    normSize.y === 0 ? 1 : node.size.y / normSize.y,
  );
  transformPathRecordCoords(pathRecords, normMatrix);
  return pathRecords;
}

/** Read the region → loop → segment-index lists from the network blob tail. */
function readVectorRegions(u32View, regionOffset, regionCount) {
  var regions = [];
  var cursor = regionOffset;
  for (var regionIdx = 0; regionIdx < regionCount; regionIdx++) {
    var loopCount = u32View[cursor + 1];
    var loops = regions[regionIdx] = [];
    cursor += 2;
    for (var loopIdx = 0; loopIdx < loopCount; loopIdx++) {
      var segListLen = u32View[cursor++];
      var segList = loops[loopIdx] = [];
      for (var segListIdx = 0; segListIdx < segListLen; segListIdx++) {
        segList[segListIdx] = u32View[cursor + segListIdx];
      }
      cursor += segListLen;
    }
  }
  if (cursor !== u32View.length && cursor !== u32View.length - 1) {
    throw "fig: vector network size mismatch";
  }
  return regions;
}

/**
 * Order a region-less segment list into one continuous loop, flipping segment
 * direction as needed so each connects end-to-start. Returns a single loop.
 */
function walkOpenPath(vertices, segments) {
  var endpointCounts = new Uint8Array(vertices.length);
  var endpointFlags = new Uint8Array(vertices.length);
  for (var segIdx = 0; segIdx < segments.length; segIdx++) {
    var seg = segments[segIdx];
    endpointCounts[seg[1]]++;
    endpointCounts[seg[4]]++;
    endpointFlags[seg[1]] = 1;
  }
  var openEndpoint = -1;
  for (var vertIdx = 0; vertIdx < vertices.length; vertIdx++) {
    if (endpointCounts[vertIdx] === 1 && endpointFlags[vertIdx] === 1) {
      openEndpoint = vertIdx;
      break;
    }
  }
  if (openEndpoint !== -1) {
    for (var segIdx = 0; segIdx < segments.length; segIdx++) {
      if (segments[segIdx][1] === openEndpoint) {
        swapArrayItems(segments, 0, segIdx);
        break;
      }
    }
  }
  var walkEnd = segments[0][4];
  for (var segIdx = 1; segIdx < segments.length; segIdx++) {
    var swapIdx = -1;
    for (var scanIdx = segIdx; scanIdx < segments.length; scanIdx++) {
      if (segments[scanIdx][4] === walkEnd) swapIdx = scanIdx;
    }
    for (var scanIdx = segIdx; scanIdx < segments.length; scanIdx++) {
      if (segments[scanIdx][1] === walkEnd) swapIdx = scanIdx;
    }
    if (swapIdx !== -1) {
      var swapSeg = segments[swapIdx];
      segments[swapIdx] = segments[segIdx];
      segments[segIdx] = swapSeg;
      if (swapSeg[1] !== walkEnd) reverseSegment(swapSeg);
    }
    walkEnd = segments[segIdx][4];
  }
  var loop = [];
  for (var segIdx = 0; segIdx < segments.length; segIdx++) loop.push(segIdx);
  return [loop];
}

function swapArrayItems(arr, i, j) {
  var tmp = arr[i];
  arr[i] = arr[j];
  arr[j] = tmp;
}

/** Swap a segment's start and end vertex + tangent fields in place. */
function reverseSegment(seg) {
  var tmp = seg[1];
  seg[1] = seg[4];
  seg[4] = tmp;
  tmp = seg[2];
  seg[2] = seg[5];
  seg[5] = tmp;
  tmp = seg[3];
  seg[3] = seg[6];
  seg[6] = tmp;
}

/** Emit move and curve commands plus flat coordinates from region loops. */
function segmentsToPathRecords(vertices, segments, regions) {
  var flatCoords = [];
  var pathCommands = [];
  for (var regionIdx = 0; regionIdx < regions.length; regionIdx++) {
    for (var loopIdx = 0; loopIdx < regions[regionIdx].length; loopIdx++) {
      var segIndices = regions[regionIdx][loopIdx];
      var winding = 0;
      if (segIndices.length > 1) {
        winding = segments[segIndices[0]][4] === segments[segIndices[1]][1] ? 1 : 0;
      }
      for (var segListIdx = 0; segListIdx < segIndices.length; segListIdx++) {
        var segment = segments[segIndices[segListIdx]];
        var startField = winding === 0 ? 1 : 4;
        var endField = winding === 0 ? 4 : 1;
        var startPt = vertices[segment[startField]];
        var endPt = vertices[segment[endField]];
        if (segListIdx === 0) {
          pathCommands.push("M");
          flatCoords.push(startPt.x, startPt.y);
        }
        pathCommands.push("C");
        flatCoords.push(
          startPt.x + segment[startField + 1], startPt.y + segment[startField + 2],
          endPt.x + segment[endField + 1], endPt.y + segment[endField + 2],
          endPt.x, endPt.y,
        );
      }
    }
  }
  return { H: flatCoords, K: pathCommands };
}

/** Round all straight-segment corners on the first subpath. */
function applyVectorCornerRadius(pathRecords, cornerRadius) {
  var cornerRadii = [];
  var knotCount = pathRecords[2].length;
  for (var radIdx = 0; radIdx < knotCount; radIdx++) cornerRadii.push(cornerRadius);
  if (allSegmentKnotsAreStraight(pathRecords)) {
    roundCornersOnSubpath(pathRecords, 2, cornerRadii);
  }
}

// ---------------------------------------------------------------------------
// Guid / color / transform helpers
// ---------------------------------------------------------------------------

function guidLookup(nodesByGuidKey, guid) {
  return nodesByGuidKey[guid.sessionID + "," + guid.localID];
}

function guidEquals(guidA, guidB) {
  return guidA.sessionID === guidB.sessionID && guidA.localID === guidB.localID;
}

/** Map a Figma blend-mode name to its PSD four-character key. */
function figmaToBlendMode(blendMode) {
  var psdBlendMode = {
    NORMAL: "norm",
    MULTIPLY: "mul ",
    LIGHTEN: "lite",
    SCREEN: "scrn",
    COLOR_DODGE: "div ",
    LINEAR_DODGE: "lddg",
    COLOR_BURN: "idiv",
    LINEAR_BURN: "lbrn",
    SOFT_LIGHT: "sLit",
    HARD_LIGHT: "hLit",
    DARKEN: "dark",
    LUMINOSITY: "lum ",
    OVERLAY: "over",
    DIFFERENCE: "diff",
    COLOR: "colr",
  }[blendMode];
  if (psdBlendMode == null) throw "fig: unsupported blend mode " + blendMode;
  return psdBlendMode;
}

/** Wrap a 0..1 RGBA Figma color as an RGBC color descriptor. */
function figmaColorToDesc(color) {
  return {
    t: "Objc",
    v: toRGBDesc({
      h: color.r * 255,
      l: color.g * 255,
      O: color.b * 255,
    }),
  };
}

/**
 * Build a Matrix2D from a Figma affine transform, snapping denormal
 * coefficients to zero. Null transform → identity.
 */
function figmaTransformToMatrix(transform) {
  if (transform == null) return new Matrix2D();
  var coeffs = [transform.m00, transform.m10, transform.m01, transform.m11, transform.m02, transform.m12];
  for (var idx = 0; idx < 6; idx++) {
    if (Math.abs(coeffs[idx]) < 1e-20) coeffs[idx] = 0;
  }
  return new Matrix2D(coeffs[0], coeffs[1], coeffs[2], coeffs[3], coeffs[4], coeffs[5]);
}

const FigmaLoader = {
  parse,
  nodeToLayer,
  buildShapeGeometry,
  applyLayerFillAndStroke,
  applyFillOpacityToLayer,
  compareLayerOrder,
  normalizeFills,
  copyClipMaskToLayer,
  applyTextStyle,
  fillToDescriptor,
  imageHashFromFill,
  resolveImageBytes,
  decodeRasterBuffer,
  guidLookup,
  guidEquals,
  figmaToBlendMode,
  figmaColorToDesc,
  figmaTransformToMatrix,
};

export { FigmaLoader };
