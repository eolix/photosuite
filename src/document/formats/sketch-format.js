// Sketch (.sketch) importer.
//
// A .sketch package is a ZIP whose public layout is documented by Sketch and
// community tooling:
//   - `document.json` lists pages and foreign symbols
//   - each page is a JSON tree under `pages/` (layers, styles, symbols)
//   - bitmaps and pattern fills reference image blobs inside the archive
//
// This module unpacks that layout via PagedDocParser and builds Document layers
// (groups, vectors, bitmaps, text, symbol instances). It does not share control
// flow with any prior minified importer.
import { Point } from "../../core/math/point.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { BlendModes } from "../model/blend-modes.js";

import { FileFormatRegistry } from "./registry/file-format-registry.js";

import { HueSaturationParser } from "./psd/adjustment-parsers.js";
import { LayerStyleRenderer } from "../../features/layer-styles/style-renderer.js";
import { LayerEffectDefs } from "./psd/effect-defs.js";
import { FilterDefs } from "../../features/filters/filter-apply.js";
import { TextEngineData } from "../../features/text/text-engine.js";
import { Document } from "../model/document.js";
import { Layer, LayerSectionType } from "../model/layer.js";
import { PagedDocParser } from "./metadata/paged-doc-parser.js";
import { Mask, VectorMask } from "../model/layer-masks.js";
import { confirmUser } from "../../core/user-prompts.js";
import { TransformToolBase } from "../transform/transform-static.js";
import { packDoublesList } from "./psd/descriptor-codec.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { rectToPathOutline, transformCoordPairs } from "../../engine/compositing/anti-alias.js";
import { rectanglePathRecords } from "../../engine/compositing/shape-primitives.js";

import { buildKeyOriginFromGeom, createEmptyKeyOrigin } from "../../engine/compositing/key-origins.js";
import { polylineCoordsToKnots, transformPathRecordCoords } from "../../engine/compositing/path-records.js";
import { composite } from "../../engine/compositing/compositing-ops.js";
import { cssStopsToGradientDesc, toRGBDesc } from "../../engine/compositing/psd-color-utils.js";
import { boundingBox, clusterRects } from "../../engine/compositing/geometry.js";

/** Max composite pixels and longest side when importing Sketch documents. */
const SKETCH_MAX_IMPORT_PIXELS = 8192 * 8192;
const SKETCH_MAX_IMPORT_DIMENSION = 30000;
const SKETCH_PAGE_VERTICAL_GAP = 200;

const SKETCH_CONTAINER_CLASSES = ["page", "artboard", "group"];
const SKETCH_VECTOR_SHAPE_CLASSES = ["shapeGroup", "shapePath", "rectangle", "oval", "triangle", "polygon"];

/** Sketch blend indices → PSD FourCC blend names (wire-format strings). */
const SKETCH_BLEND_MODE_NAMES = "Nrml Drkn Mltp CBrn Lghn Scrn CDdg Ovrl SftL HrdL Dfrn Xclu H Strt Clr Lmns linearBurn linearDodge".split(" ");

/** PSD path knots store the incoming Bézier handle under the wire key `cp1`. */
const PATH_KNOT_INCOMING_HANDLE = "cp1";

function isContainerClass(className) {
  return SKETCH_CONTAINER_CLASSES.indexOf(className) != -1;
}

function isVectorShapeClass(className) {
  return SKETCH_VECTOR_SHAPE_CLASSES.indexOf(className) != -1;
}

function cloneDefaultVectorStroke() {
  return LayerEffectDefs.getStrokeStyleDefault();
}

// ---------------------------------------------------------------------------
// Package layout → Document
// ---------------------------------------------------------------------------

function parse(bytes, doc) {
  const parsedDoc = PagedDocParser.parse(bytes);
  let stackY = 0;
  if (parsedDoc.pages.length > 1) console.log(parsedDoc.pages.length, "pages");

  for (let pageIdx = 0; pageIdx < parsedDoc.pages.length; pageIdx++) {
    const pageEntry = parsedDoc.pages[pageIdx];
    if (pageEntry.Name == "Symbols") continue;
    const topLayers = pageEntry.layers;
    for (let topIdx = 0; topIdx < topLayers.length; topIdx++) {
      if (getSketchClassName(topLayers[topIdx]) == "group") topLayers[topIdx]._isArtb = true;
    }
  }

  const pageBoundsList = [];
  let documentBounds = new Rect();
  for (let pageIdx = 0; pageIdx < parsedDoc.pages.length; pageIdx++) {
    const pageEntry = parsedDoc.pages[pageIdx];
    const pageLayers = pageEntry.layers;
    let pageBounds = computeArtboardBounds(pageLayers, pageIdx);
    let hasExplicitArtboard = false;

    if (pageBounds.area() > SKETCH_MAX_IMPORT_PIXELS || pageBounds.width > SKETCH_MAX_IMPORT_DIMENSION || pageBounds.height > SKETCH_MAX_IMPORT_DIMENSION) {
      reflowOversizedArtboards(pageLayers, true);
      const reflowedBounds = computeArtboardBounds(pageLayers, pageIdx);
      if (reflowedBounds.area() >= pageBounds.area()) reflowOversizedArtboards(pageLayers, false);
    }

    pageBounds = computeArtboardBounds(pageLayers, pageIdx);
    for (let layerIdx = 0; layerIdx < pageLayers.length; layerIdx++) {
      if (getSketchClassName(pageLayers[layerIdx]) == "artboard") hasExplicitArtboard = true;
    }
    if (!hasExplicitArtboard) {
      console.log("sketch: wrapping page contents (missing artboard)");
      const pageWrapper = {};
      for (const fieldKey in pageEntry) pageWrapper[fieldKey] = pageEntry[fieldKey];
      pageWrapper._class = "group";
      pageEntry.layers = [pageWrapper];
    }

    pageBoundsList.push(pageBounds.clone());
    if (pageBounds.isEmpty()) continue;
    pageBounds.x = 0;
    pageBounds.y = stackY;
    stackY += pageBounds.height + SKETCH_PAGE_VERTICAL_GAP;
    documentBounds = documentBounds.union(pageBounds);
  }

  const symbolMap = {};
  if (parsedDoc.foreignSymbols) {
    for (let symbolIdx = 0; symbolIdx < parsedDoc.foreignSymbols.length; symbolIdx++) {
      const symbolMaster = parsedDoc.foreignSymbols[symbolIdx].symbolMaster;
      symbolMap[symbolMaster.symbolID] = { master: symbolMaster };
    }
  }
  collectSymbolMastersById(parsedDoc.pages, symbolMap);
  for (const symbolKey in symbolMap) {
    findNestedSymbolMaster(symbolMap[symbolKey].master.layers);
  }

  const downscale = computeSketchImportScale(documentBounds, SKETCH_MAX_IMPORT_PIXELS);
  doc.pendingTextRasterization = true;
  doc.width = Math.max(1, Math.round(documentBounds.width / downscale));
  doc.height = Math.max(1, Math.round(documentBounds.height / downscale));
  doc.buffer = allocBuffer(doc.width * doc.height * 4);

  const patternCache = new Map();
  const symbolMasterStack = [];

  stackY = 0;
  for (let pageIdx = 0; pageIdx < parsedDoc.pages.length; pageIdx++) {
    const pageEntry = parsedDoc.pages[pageIdx];
    const pageBounds = pageBoundsList[pageIdx];
    const pageMatrix = new Matrix2D(downscale, 0, 0, downscale, pageBounds.x, pageBounds.y - stackY);
    importSketchLayerTree(pageEntry.layers, doc, pageMatrix, symbolMap, {}, [], patternCache, symbolMasterStack);
    stackY += pageBounds.height + SKETCH_PAGE_VERTICAL_GAP;
  }

  let artboardCount = 0;
  for (let layerIdx = 0; layerIdx < doc.layers.length; layerIdx++) {
    if (doc.layers[layerIdx].add.artb) artboardCount++;
  }
  doc.initArtboardDocument(artboardCount);
  if (downscale != 1) alert("Sketch import scaled by " + downscale + "×");
  doc.sanitizeGroupDepth();
}

// ---------------------------------------------------------------------------
// Artboard layout
// ---------------------------------------------------------------------------

function getSketchClassName(layerNode) {
  let className = layerNode._class ? layerNode._class : layerNode.$class;
  if (className == "group" && layerNode._isArtb) className = "artboard";
  return className;
}

/** Sketch `contextSettings` carry opacity as `opacity` (0–1), not PSD `Opct`. */
function sketchContextOpacity(contextSettings) {
  if (contextSettings == null) return 1;
  let opacity = contextSettings.opacity;
  if (opacity == null) opacity = contextSettings.Opct;
  if (opacity == null) return 1;
  return opacity;
}

/**
 * Required import scale for a Sketch document bounds rect.
 * Tauri auto-scales (no sync confirm during parse — WebView cannot show it).
 * @param {Rect} boundsRect
 * @param {number} maxPixels
 * @returns {number}
 */
function computeSketchImportScale(boundsRect, maxPixels) {
  let scale = 1;
  while (
    Math.round(boundsRect.width / scale) * Math.round(boundsRect.height / scale) > maxPixels ||
    Math.max(Math.round(boundsRect.width / scale), Math.round(boundsRect.height / scale)) > 3e4
  ) {
    scale++;
  }
  return scale;
  if (
    scale != 1 &&
    !confirmUser(
      "This Sketch document is large (" +
        boundsRect.width +
        " × " +
        boundsRect.height +
        " px).\n" +
        "OK scales it down " +
        scale +
        "×; Cancel keeps the original size.",
    )
  ) {
    scale = 1;
  }
  return scale;
}

function computeArtboardBounds(layers, pageIndex) {
  const artboardRects = [];
  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layerNode = layers[layerIdx];
    const layerRect = readRect(layerNode.frame);
    if (pageIndex == 0 || getSketchClassName(layerNode) == "artboard") artboardRects.push(layerRect);
  }
  return boundingBox(artboardRects);
}

function reflowOversizedArtboards(layers, stackVertically) {
  const artboardRects = [];
  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layerNode = layers[layerIdx];
    const layerRect = readRect(layerNode.frame);
    layerRect.width += 150;
    layerRect.height += 150;
    artboardRects.push(layerRect);
  }
  const boundsBefore = boundingBox(artboardRects);
  clusterRects(artboardRects, stackVertically);
  const boundsAfter = boundingBox(artboardRects);
  if (
    boundsAfter.area() * 1.5 < boundsBefore.area() ||
    (boundsBefore.width > SKETCH_MAX_IMPORT_DIMENSION && boundsAfter.width <= SKETCH_MAX_IMPORT_DIMENSION) ||
    (boundsBefore.height > SKETCH_MAX_IMPORT_DIMENSION && boundsAfter.height <= SKETCH_MAX_IMPORT_DIMENSION)
  ) {
    alert("Sketch artboards reflowed to fit import limits");
    for (let artboardIdx = 0; artboardIdx < layers.length; artboardIdx++) {
      const reflowRect = artboardRects[artboardIdx];
      const layerNode = layers[artboardIdx];
      const sketchFrame = layerNode.frame;
      sketchFrame.x = reflowRect.x;
      sketchFrame.y = reflowRect.y;
    }
  }
}

// ---------------------------------------------------------------------------
// Scene tree
// ---------------------------------------------------------------------------

function collectSymbolMastersById(pages, symbolMap) {
  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const pageNode = pages[pageIdx];
    const className = getSketchClassName(pageNode);
    if (isContainerClass(className)) collectSymbolMastersById(pageNode.layers, symbolMap);
    else if (className == "symbolMaster") symbolMap[pageNode.symbolID] = { master: pageNode };
  }
}

function findNestedSymbolMaster(layers) {
  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layerNode = layers[layerIdx];
    const className = getSketchClassName(layerNode);
    let symbolHit = null;
    if (isContainerClass(className)) symbolHit = findNestedSymbolMaster(layerNode.layers);
    if (className == "symbolMaster" || className == "symbolInstance") symbolHit = layerNode;
    if (symbolHit != null) return symbolHit;
  }
  return null;
}

/**
 * Walk a Sketch layer list into Document layers.
 * @param {Map} [patternCache]
 * @param {Array} [symbolMasterStack]
 */
function importSketchLayerTree(
  layers,
  targetDoc,
  parentTransform,
  symbolMap,
  overrideMap,
  parentPath,
  patternCache,
  symbolMasterStack,
) {
  if (patternCache == null) patternCache = new Map();
  if (symbolMasterStack == null) symbolMasterStack = [];

  const pendingClipMaskLayers = [];
  for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
    const layerNode = layers[layerIndex];
    const layerBounds = layerNode.frame ? readRect(layerNode.frame) : null;
    const style = layerNode.style;
    let layerEffects = null;
    let usePatternImageFill = false;

    if (style == null) {
      console.log("sketch: layer has empty style");
    }

    const layerMatrix = buildLayerTransformMatrix(layerNode, parentTransform);
    const className = getSketchClassName(layerNode);
    const isVectorShape = isVectorShapeClass(className);
    let isContainerGroup = isContainerClass(className);

    if (className == "shapeGroup") {
      for (let childIndex = 0; childIndex < layerNode.layers.length; childIndex++) {
        if (getSketchClassName(layerNode.layers[childIndex]) == "shapeGroup") isContainerGroup = true;
      }
    }

    let layer = targetDoc.newLayer();
    layer.setVisible(layerNode.isVisible);
    let name = layerNode.name;
    if (!(typeof name == "string")) name = className;
    layer.setName(name.slice(0, 250));

    if (style != null) {
      layerEffects = buildLayerStyleFromSketchStyle(
        targetDoc,
        style,
        layerBounds,
        layerMatrix,
        isVectorShape || className == "artboard" || isContainerGroup,
        patternCache,
      );
    }

    if (className == "rectangle" && style && style.fills && style.fills[0]) {
      const fillType = style.fills[0];
      if (fillType.fillType == 4 && fillType.patternFillType > 1 && fillType.image != null) {
        usePatternImageFill = true;
      }
    }

    if (layerNode.shouldBreakMaskChain) {
      while (pendingClipMaskLayers.length != 0) pushClippingMaskGroupEnd(pendingClipMaskLayers.pop(), targetDoc);
    }

    if (isContainerGroup) {
      convertContainer(layer, layerNode, layerBounds, layerMatrix, className, targetDoc, symbolMap, overrideMap, parentPath, patternCache, symbolMasterStack);
    } else if (isVectorShape && !usePatternImageFill) {
      convertVectorShape(layer, layerNode, style, layerBounds, layerMatrix, layerEffects, parentTransform, targetDoc, parentPath, patternCache);
    } else if (className == "bitmap" || usePatternImageFill) {
      layer = convertBitmapOrPatternFill(layer, layerNode, style, layerBounds, layerMatrix, usePatternImageFill, targetDoc);
    } else if (className == "text") {
      if (layerNode.attributedString == null) continue;
      convertTextLayer(layer, layerNode, style, layerBounds, layerMatrix, overrideMap, parentPath);
    } else if (className == "symbolInstance" || className == "symbolMaster") {
      const converted = convertSymbolInstance(
        layer,
        layerNode,
        layerBounds,
        layerMatrix,
        targetDoc,
        symbolMap,
        overrideMap,
        parentPath,
        patternCache,
        symbolMasterStack,
      );
      if (!converted) continue;
    } else if (className == "slice") {
      console.log("sketch: skipping slice layer");
      continue;
    } else {
      console.log("sketch: unsupported layer class " + className, layerNode);
      continue;
    }

    if (style && style.contextSettings) {
      const contextSettings = style.contextSettings;
      const blendMode = contextSettings.blendMode;
      if (blendMode < SKETCH_BLEND_MODE_NAMES.length) {
        layer.blendMode = BlendModes.psdCodes[BlendModes.psdNames.indexOf(SKETCH_BLEND_MODE_NAMES[blendMode])];
        if (isContainerGroup && layer.blendMode == "norm") layer.blendMode = "pass";
      }
      layer.Opct = Math.round(layer.Opct * sketchContextOpacity(contextSettings));
    }

    if (layerEffects != null) {
      layer.add.lmfx = layerEffects;
    }

    targetDoc.layers.push(layer);
    if (layerNode.hasClippingMask && layers.length > 1) {
      pendingClipMaskLayers.push(layer);
      targetDoc.layers.push(targetDoc.createGroupEndLayer());
    }
  }
  while (pendingClipMaskLayers.length != 0) pushClippingMaskGroupEnd(pendingClipMaskLayers.pop(), targetDoc);
}

function convertContainer(
  layer,
  layerNode,
  layerBounds,
  layerMatrix,
  className,
  targetDoc,
  symbolMap,
  overrideMap,
  parentPath,
  patternCache,
  symbolMasterStack,
) {
  layer.add.lsct = layerNode.layerListExpandedType == 2 ? LayerSectionType.OpenGroup : LayerSectionType.ClosedGroup;
  layer.blendMode = "pass";
  layer.layerFlags = 24;
  layer.setVisible(layerNode.isVisible);
  targetDoc.layers.push(targetDoc.createGroupEndLayer());

  if (layerNode.hasBackgroundColor == null && layerNode.hasClickThrough == 0 && layerNode.name == "Frame" && layerBounds && !layerBounds.isEmpty()) {
    layer.add.vmsk = new VectorMask();
    layer.add.vstk = cloneDefaultVectorStroke();
    layer.add.vmsk.pathRecords = rectanglePathRecords(
      layerBounds.x,
      layerBounds.y,
      layerBounds.width,
      layerBounds.height,
      0,
    );
    layer.invalidate(targetDoc);
  }

  if (className == "artboard" && layerBounds) {
    const artboardRect = layerBounds.clone();
    const artboardScale = layerMatrix.getScale();
    artboardRect.x = -Math.floor(layerMatrix.tx / artboardScale);
    artboardRect.y = -Math.floor(layerMatrix.ty / artboardScale);
    artboardRect.width = Math.floor(artboardRect.width / artboardScale);
    artboardRect.height = Math.floor(artboardRect.height / artboardScale);
    layer.setArtboardRect(artboardRect);
    const backgroundColor = layerNode.backgroundColor;
    const artboardBackgroundRgb = backgroundColor
      ? {
          h: 255 * backgroundColor.red,
          l: 255 * backgroundColor.green,
          O: 255 * backgroundColor.blue,
        }
      : {
          h: 255,
          l: 255,
          O: 255,
        };
    layer.add.artb.Clr = {
      t: "Objc",
      v: toRGBDesc(artboardBackgroundRgb),
    };
    layer.add.artb.artboardBackgroundType = {
      t: "long",
      v: 4,
    };
  }

  importSketchLayerTree(
    layerNode.layers,
    targetDoc,
    layerMatrix,
    symbolMap,
    overrideMap,
    parentPath,
    patternCache,
    symbolMasterStack,
  );
}

function convertVectorShape(
  layer,
  layerNode,
  style,
  layerBounds,
  layerMatrix,
  layerEffects,
  parentTransform,
  targetDoc,
  parentPath,
  patternCache,
) {
  layer.add.vmsk = new VectorMask();
  layer.add.vstk = cloneDefaultVectorStroke();
  layer.add.vstk.strokeEnabled.v = false;
  layer.add.vogk = [];

  const hasSingleFrameEffect = layerEffects != null && layerEffects.frameFXMulti.v.length == 1;
  const sketchFills = style ? style.fills : null;
  const enabledFillDescriptors = style
    ? buildEnabledFillDescriptors(
        sketchFills,
        layerBounds,
        layerMatrix,
        targetDoc,
        findOverrideByNamePrefix(parentPath, layerNode.do_objectID + "_image"),
        patternCache,
      )
    : [];

  if (enabledFillDescriptors.length == 0) {
    if (hasSingleFrameEffect) layer.add.vstk.fillEnabled.v = false;
    else layer.add.iOpa = 0;
    layer.add.SoCo = {
      classID: "null",
      Clr: {
        t: "Objc",
        v: toRGBDesc({
          h: 0,
          l: 0,
          O: 0,
        }),
      },
    };
  } else {
    const fillDescriptor = enabledFillDescriptors[0];
    let fillLayerKey = null;
    let fillWireKeys = null;
    if (fillDescriptor.type == "SoFi") {
      fillLayerKey = "SoCo";
      fillWireKeys = LayerEffectDefs.solidFillPropertyKeys;
    }
    if (fillDescriptor.type == "GrFl") {
      fillLayerKey = "GdFl";
      fillWireKeys = LayerEffectDefs.gradientOverlayPropertyKeys;
    }
    if (fillDescriptor.type == "patternFill") {
      fillLayerKey = "PtFl";
      fillWireKeys = LayerEffectDefs.patternOverlayPropertyKeys;
    }
    if (fillLayerKey != null) {
      layer.add[fillLayerKey] = {
        classID: "null",
      };
      for (let wireKeyIndex = 0; wireKeyIndex < fillWireKeys.length; wireKeyIndex++) {
        const wireKey = fillWireKeys[wireKeyIndex];
        layer.add[fillLayerKey][wireKey] = fillDescriptor.value.v[wireKey];
      }
      const opacityPercent = fillDescriptor.value.v.Opct.v.val;
      if (hasSingleFrameEffect && opacityPercent == 0) layer.add.vstk.fillEnabled.v = false;
      else layer.add.iOpa = Math.round((255 * opacityPercent) / 100);
    }
  }

  layer.layerFlags |= 16;
  layer.add.vmsk.pathRecords = buildVectorPathFromShapeLayers(
    layerNode.layers ? layerNode.layers : [layerNode],
    layerNode.layers ? layerMatrix : parentTransform,
    layer.add.vogk,
  );

  const blurEffect = style ? style.blur : null;
  if (blurEffect && blurEffect.isEnabled && blurEffect.type <= 1) layer.add.vmsk.feather = blurEffect.radius;

  if (layer.add.vmsk.pathRecords.length == 2) {
    console.log("sketch: empty vector path for", layer.getName());
  }

  if (hasSingleFrameEffect) {
    const strokeEffectDescriptor = layerEffects.frameFXMulti.v[0].v;
    const vectorStroke = layer.add.vstk;
    layerEffects.frameFXMulti.v = [];
    LayerStyleRenderer.applyStrokeDescriptorFromStyle(strokeEffectDescriptor, vectorStroke);
    const borderOptions = style.borderOptions;
    const miterLimit = style.miterLimit;
    if (borderOptions) {
      const dashPattern = borderOptions.dashPattern;
      vectorStroke.strokeStyleLineCapType.v.strokeStyleLineCapType =
        LayerEffectDefs.StrokeStyleDefs.lineCapTypes[borderOptions.lineCapStyle];
      vectorStroke.strokeStyleLineJoinType.v.strokeStyleLineJoinType =
        LayerEffectDefs.StrokeStyleDefs.join[borderOptions.lineJoinStyle];
      if (dashPattern) {
        vectorStroke.strokeStyleLineDashSet.v = LayerStyleRenderer.dashArrayToStrokeDescriptor(
          dashPattern,
          1 / strokeEffectDescriptor.Sz.v.val,
        );
      }
      if (miterLimit != null) vectorStroke.strokeStyleMiterLimit.v = miterLimit;
    }
  }

  layer.invalidate(targetDoc);
}

function convertBitmapOrPatternFill(layer, layerNode, style, layerBounds, layerMatrix, usePatternImageFill, targetDoc) {
  const image = usePatternImageFill ? style.fills[0] : null;
  const bitmapBytes = usePatternImageFill ? image.image.bdata : layerNode.image.bdata;
  let smartObjectLayer = targetDoc.createSmartObjectLayer(bitmapBytes, layer.getName(), 0, 0);
  smartObjectLayer.layerFlags = layer.layerFlags;
  layer = smartObjectLayer;

  const blurEffect = style ? style.blur : null;
  const brightness = style ? style.colorControls : null;
  if (blurEffect || brightness) {
    layer.add.placedData.filterFX = FilterDefs.createEmptyFilterFxStyle();
    targetDoc.addPlacedItemId({
      id: layer.add.placedData.placed.v,
      rect: new Rect(),
      buffer: allocBuffer(1),
      d: new Mask(),
    });
    const filterFxList = layer.add.placedData.filterFX.v.filterFXList.v;
    if (blurEffect) {
      const blurFilterDescriptor = FilterDefs.createFilterFxDescriptor("GsnB", {});
      blurFilterDescriptor.v.enab.v = blurEffect.isEnabled;
      blurFilterDescriptor.v.Fltr.v.Rds.v.val = blurEffect.radius;
      filterFxList.push(blurFilterDescriptor);
    }
    if (brightness) {
      const brightnessValue = brightness.brightness;
      let contrast = brightness.contrast;
      const adjustHue = brightness.hue;
      const saturation = brightness.saturation;
      if (adjustHue != 0 || saturation != 1) {
        const hueFilterDescriptor = FilterDefs.createFilterFxDescriptor("hue2", {});
        hueFilterDescriptor.v.enab.v = brightness.isEnabled;
        HueSaturationParser.setChannelData(hueFilterDescriptor.v.Fltr.v, 0, [
          Math.round((adjustHue * 180) / Math.PI),
          Math.round((saturation - 1) * 100),
          0,
        ]);
        filterFxList.push(hueFilterDescriptor);
      }
      if (brightnessValue != 0 || contrast != 1) {
        const britFilterDescriptor = FilterDefs.createFilterFxDescriptor("brit", {});
        britFilterDescriptor.v.enab.v = brightness.isEnabled;
        contrast = contrast - 1;
        if (contrast > 0) contrast /= 2;
        const britFilterPayload = britFilterDescriptor.v.Fltr.v;
        britFilterPayload.Brgh.v = Math.round(brightnessValue * 255);
        britFilterPayload.Cntr.v = Math.round(contrast * 255);
        britFilterPayload.useLegacy.v = true;
        filterFxList.push(britFilterDescriptor);
      }
    }
  }

  if (usePatternImageFill) {
    const patternFillType = image.patternFillType;
    if (patternFillType == 3) {
      const layerAspectRatio = layer.rect.width / layer.rect.height;
      const boundsAspectRatio = layerBounds.width / layerBounds.height;
      if (layerAspectRatio < boundsAspectRatio) {
        layerMatrix.translate(-(layerBounds.width * (1 - layerAspectRatio / boundsAspectRatio)) / 2, 0);
        layerMatrix.scale(boundsAspectRatio / layerAspectRatio, 1);
      } else {
        layerMatrix.translate(0, -(layerBounds.height * (1 - boundsAspectRatio / layerAspectRatio)) / 2);
        layerMatrix.scale(1, layerAspectRatio / boundsAspectRatio);
      }
    }
  }

  layerBounds.x = layerBounds.y = 0;
  const coords = rectToPathOutline(layerBounds).coords;
  layerMatrix.invert();
  transformCoordPairs(coords, layerMatrix, coords);
  layer.add.placedData.Trnf = packDoublesList(coords);
  layer.add.placedData.nonAffineTransform = packDoublesList(coords);
  layer.rasterizeSmartObject(targetDoc, false);
  return layer;
}

function convertTextLayer(layer, layerNode, style, layerBounds, layerMatrix, overrideMap, parentPath) {
  const invertedTextMatrix = layerMatrix.clone();
  let runIndexPairs;
  let runAttributes;
  let runLengthSum = 0;
  invertedTextMatrix.invert();
  invertedTextMatrix.a = invertedTextMatrix.d = Math.min(invertedTextMatrix.a, invertedTextMatrix.d);
  layer.add.lnsr = "rend";
  layer.add.TySh = TextEngineData.createTextLayerData(0, 0);
  layer.add.TySh.boundsRect = new Rect(0, 0, layerBounds.width, layerBounds.height);
  layer.add.TySh.transform = invertedTextMatrix;

  let attributedString = layerNode.attributedString;
  if (attributedString.archivedAttributedString) attributedString = attributedString.archivedAttributedString;
  let NSString = attributedString.NSString;
  if (NSString == null) NSString = attributedString.string;
  if (NSString == null) NSString = "";
  if (NSString["NS.string"]) NSString = NSString["NS.string"];
  if (overrideMap[layerNode.do_objectID] != null) NSString = overrideMap[layerNode.do_objectID];
  const stringValueOverride = findOverrideByNamePrefix(parentPath, layerNode.do_objectID + "_stringValue");
  if (stringValueOverride) NSString = stringValueOverride.value;

  if (attributedString.attributes != null) {
    runIndexPairs = [];
    runAttributes = [];
    const attributes = attributedString.attributes;
    for (let attrIndex = 0; attrIndex < attributes.length; attrIndex++) {
      runIndexPairs.push(attributes[attrIndex].length, attrIndex);
      runAttributes.push(attributes[attrIndex].attributes);
    }
  } else if (attributedString.NSAttributeInfo == null) {
    runIndexPairs = [NSString.length, 0];
    runAttributes = [attributedString.NSAttributes];
  } else {
    runIndexPairs = attributedString.NSAttributeInfo["NS.data"];
    runAttributes = attributedString.NSAttributes;
    runIndexPairs = decodeNSStringAttributeRunIndex(runIndexPairs);
  }

  for (let runPairIndex = 0; runPairIndex < runIndexPairs.length; runPairIndex += 2) {
    runLengthSum += runIndexPairs[runPairIndex];
  }
  if (runLengthSum != NSString.length) {
    while (runLengthSum > NSString.length) {
      runIndexPairs[runIndexPairs.length - 2]--;
      runLengthSum--;
      if (runIndexPairs[runIndexPairs.length - 2] == 0) {
        runIndexPairs.pop();
        runIndexPairs.pop();
      }
    }
    runIndexPairs[runIndexPairs.length - 2] += NSString.length - runLengthSum;
  }

  NSString = NSString.replace(/\u2028/g, "\n");
  NSString = NSString.replace(/\u2029/g, "\n");
  NSString = NSString.replace(/\r/g, "\n");
  const engineData = layer.add.TySh.engineData;
  TextEngineData.insertText(engineData, 0, NSString);

  if (NSString != "") {
    const textBehaviour = layerNode.textBehaviour;
    const textStyle = style.textStyle;
    const verticalAlignment = textStyle ? textStyle.verticalAlignment : 0;
    let maxRunFontSize = applyAttributedStringStyles(engineData, runIndexPairs, runAttributes, NSString);
    const textScale = invertedTextMatrix.getScale();
    const baseTextStyle = TextEngineData.getTextStyle(engineData, 0, 1);
    let textOffsetX = 0;
    if (baseTextStyle.textStyle.Font) {
      const fontDisplayName = baseTextStyle.fontSet[baseTextStyle.textStyle.Font].Name;
      if (fontDisplayName == "FontAwesome" || fontDisplayName == "Ionicons") maxRunFontSize *= 0.87;
    }
    const leadingOffset = baseTextStyle.textStyle.AutoLeading ? 0 : baseTextStyle.textStyle.Leading * 0.6;
    let textOffsetY = Math.max(maxRunFontSize, leadingOffset) * textScale;
    const width = layerBounds.width;
    const height = layerBounds.height;
    if (textBehaviour == 0) {
      TextEngineData.setTextType(engineData, 0);
      const justification = TextEngineData.getJustification(baseTextStyle.paraStyle);
      if (justification == 1) textOffsetX = width * textScale;
      if (justification == 2) textOffsetX = width * textScale * 0.5;
      if (verticalAlignment == 0) textOffsetY *= 1;
      else textOffsetY *= 0.9;
    } else {
      TextEngineData.setTextType(engineData, 1);
      TextEngineData.setBoxBounds(engineData, [0, 0, Math.round(width), Math.round(height)]);
      if (textBehaviour == 2 && verticalAlignment == 0) textOffsetY = textOffsetY * 0.2;
      else if (textBehaviour == 2 && verticalAlignment == 1) {
        textOffsetY = textScale * 0.5 * (height - baseTextStyle.textStyle.FontSize);
      } else if (textBehaviour == 1 && verticalAlignment == 0) textOffsetY = textOffsetY * 0.2;
      else textOffsetY = textOffsetY * 0.35;
    }
    layer.add.TySh.transform.translate(textOffsetX, textOffsetY);
  }
}

/**
 * @returns {boolean} false when the instance should be skipped
 */
function convertSymbolInstance(
  layer,
  layerNode,
  layerBounds,
  layerMatrix,
  targetDoc,
  symbolMap,
  overrideMap,
  parentPath,
  patternCache,
  symbolMasterStack,
) {
  let symbolID = layerNode.symbolID;
  if (overrideMap[layerNode.do_objectID]) symbolID = overrideMap[layerNode.do_objectID].symbolID;
  const symbolIdOverride = findOverrideByNamePrefix(parentPath, layerNode.do_objectID + "_symbolID");
  if (symbolIdOverride) symbolID = symbolIdOverride.value;
  if (symbolID == "") return false;

  const instanceOverrides = {};
  for (const overrideKey in overrideMap) instanceOverrides[overrideKey] = overrideMap[overrideKey];
  if (layerNode.overrides) {
    for (const overrideKey in layerNode.overrides) instanceOverrides[overrideKey] = layerNode.overrides[overrideKey];
  }
  let overridePath = parentPath.slice(0);
  if (layerNode.overrideValues) overridePath = overridePath.concat(layerNode.overrideValues);

  const symbolEntry = symbolMap[symbolID];
  if (symbolEntry == null) {
    console.log("sketch: missing symbol master", layerNode.symbolID);
    return false;
  }

  const symbolMasterBounds = readRect(symbolEntry.master.frame);
  const symbolScaleX = symbolMasterBounds.width / layerBounds.width;
  const symbolScaleY = symbolMasterBounds.height / layerBounds.height;
  const symbolTransform = layerMatrix.clone();
  symbolTransform.scale(symbolScaleX, symbolScaleY);

  layer.add.lsct = LayerSectionType.ClosedGroup;
  layer.blendMode = "pass";
  layer.layerFlags = 24;
  layer.setVisible(layerNode.isVisible);
  targetDoc.layers.push(targetDoc.createGroupEndLayer());

  const symbolMasterNode = symbolEntry.master;
  if (symbolMasterStack.indexOf(symbolMasterNode) == -1) {
    symbolMasterStack.push(symbolMasterNode);
    importSketchLayerTree(
      symbolMasterNode.layers,
      targetDoc,
      symbolTransform,
      symbolMap,
      instanceOverrides,
      overridePath,
      patternCache,
      symbolMasterStack,
    );
    symbolMasterStack.pop();
  }
  return true;
}

// ---------------------------------------------------------------------------
// Text attribute runs
// ---------------------------------------------------------------------------

function findOverrideByNamePrefix(overrideValues, namePrefix) {
  for (let overrideIdx = 0; overrideIdx < overrideValues.length; overrideIdx++) {
    if (overrideValues[overrideIdx].overrideName.startsWith(namePrefix)) return overrideValues[overrideIdx];
  }
}

function decodeNSStringAttributeRunIndex(runIndexBytes) {
  let byteOffset = 0;
  const runIndexPairs = [];
  while (byteOffset + 1 < runIndexBytes.length) {
    let runLength = runIndexBytes[byteOffset];
    byteOffset++;
    if (runLength > 127) {
      runLength += 128 * (runIndexBytes[byteOffset] - 1);
      byteOffset++;
      if (runIndexBytes[byteOffset - 1] > 127) {
        runLength += 128 * (runIndexBytes[byteOffset] - 1);
        byteOffset++;
      }
    }
    const runAttributeIndex = runIndexBytes[byteOffset];
    byteOffset++;
    runIndexPairs.push(runLength, runAttributeIndex);
  }
  return runIndexPairs;
}

function applyAttributedStringStyles(engineData, runIndexPairs, runAttributesList, textContent) {
  let rtlCharCount = 0;
  let textOffset = 0;
  let maxFontSize = 0;
  for (let charIndex = 0; charIndex < textContent.length; charIndex++) {
    const charCode = textContent.charCodeAt(charIndex);
    const isHebrewChar =
      (1473 <= charCode && charCode <= 1479) ||
      (1488 <= charCode && charCode <= 1514) ||
      (1520 <= charCode && charCode <= 1524);
    const isArabicChar = (1569 <= charCode && charCode <= 1594) || (1600 <= charCode && charCode <= 1749);
    if (isHebrewChar || isArabicChar) rtlCharCount++;
  }
  const isRtlDominant = rtlCharCount > textContent.length / 2;

  for (let runPairIndex = 0; runPairIndex < runIndexPairs.length; runPairIndex += 2) {
    const runLength = runIndexPairs[runPairIndex];
    let fontSizePt = 14;
    let fontName = "DejaVuSans";
    if (runLength == 0) continue;
    const runAttributeIndex = runIndexPairs[runPairIndex + 1];
    const runAttributes = runAttributesList[runAttributeIndex];
    const textStyle = TextEngineData.getTextStyle(engineData, textOffset, textOffset + runLength - 1);
    let colorSpec = runAttributes.NSColor;
    if (colorSpec == null) {
      colorSpec = runAttributes.MSAttributedStringColorDictionaryAttribute;
      if (colorSpec == null) colorSpec = runAttributes.MSAttributedStringColorAttribute;
      if (colorSpec == null) colorSpec = "0 0 0";
      else colorSpec = [colorSpec.red, colorSpec.green, colorSpec.blue].join(" ");
    } else if (getSketchClassName(colorSpec) == "MSArchivedColor") {
      colorSpec = colorSpec.dr + " " + colorSpec.dg + " " + colorSpec.db;
    } else if (colorSpec.NSRGB) {
      colorSpec = colorSpec.NSRGB;
      colorSpec = BinaryUtils.readString(colorSpec, 0, colorSpec.length - 1);
    } else if (colorSpec.NSCMYK) {
      colorSpec = colorSpec.NSCMYK;
      colorSpec = BinaryUtils.readString(colorSpec, 0, colorSpec.length - 1);
      colorSpec = colorSpec.split(" ").map(parseFloat);
      const cmykC = 1 - colorSpec[0];
      const cmykM = 1 - colorSpec[1];
      const cmykY = 1 - colorSpec[2];
      const cmykK = 1 - colorSpec[3];
      colorSpec = cmykC * cmykK + " " + cmykM * cmykK + " " + cmykY * cmykK;
    } else if (colorSpec.NSWhite) {
      colorSpec = "1 1 1";
    }
    colorSpec = colorSpec.split(" ");
    textStyle.textStyle.FillColor = {
      Type: 1,
      Values: [1, parseFloat(colorSpec[0]), parseFloat(colorSpec[1]), parseFloat(colorSpec[2])],
    };

    let MSAttributedStringFontAttribute = runAttributes.MSAttributedStringFontAttribute;
    if (runAttributes.NSFont) {
      fontSizePt = runAttributes.NSFont.NSSize;
      fontName = runAttributes.NSFont.NSName;
    } else if (MSAttributedStringFontAttribute) {
      if (MSAttributedStringFontAttribute.attributes) {
        MSAttributedStringFontAttribute = MSAttributedStringFontAttribute.attributes;
        fontSizePt = MSAttributedStringFontAttribute.size;
        fontName = MSAttributedStringFontAttribute.name;
      } else {
        let NSFontDescriptorAttributes = MSAttributedStringFontAttribute.NSFontDescriptorAttributes;
        if (NSFontDescriptorAttributes == null) {
          NSFontDescriptorAttributes = MSAttributedStringFontAttribute.UIFontDescriptorAttributes;
        }
        MSAttributedStringFontAttribute = NSFontDescriptorAttributes;
        fontSizePt = MSAttributedStringFontAttribute.NSFontSizeAttribute;
        fontName = MSAttributedStringFontAttribute.NSFontNameAttribute;
      }
      if (fontName == null) fontName = "DejaVuSans";
    }

    maxFontSize = Math.max(maxFontSize, fontSizePt);
    textStyle.textStyle.FontSize = Math.round(fontSizePt);
    TextEngineData.setTextFont(textStyle, fontName);

    let NSKern = runAttributes.NSKern;
    if (NSKern == null) NSKern = runAttributes.kerning;
    if (NSKern != null) textStyle.textStyle.Tracking = Math.round((1e3 * NSKern) / fontSizePt);
    if (runAttributes.NSUnderline != null) textStyle.textStyle.Underline = runAttributes.NSUnderline > 0;

    let NSStrikethrough = runAttributes.NSStrikethrough;
    if (NSStrikethrough == null) NSStrikethrough = runAttributes.strikethroughStyle;
    if (NSStrikethrough != null) textStyle.textStyle.Strikethrough = NSStrikethrough > 0;
    if (runAttributes.MSAttributedStringTextTransformAttribute == 1) textStyle.textStyle.FontCaps = 2;

    let NSParagraphStyle = runAttributes.NSParagraphStyle;
    if (NSParagraphStyle == null) NSParagraphStyle = runAttributes.paragraphStyle;
    if (NSParagraphStyle) {
      const paragraphSpacing = NSParagraphStyle.paragraphSpacing;
      if (paragraphSpacing != null) {
        textStyle.paraStyle.SpaceAfter = paragraphSpacing;
      }
      let NSAlignment = NSParagraphStyle.NSAlignment;
      if (NSAlignment == null) NSAlignment = NSParagraphStyle.alignment;
      if (NSAlignment != null) {
        let justification = 0;
        if (NSAlignment == 1) justification = 1;
        else if (NSAlignment == 2) justification = 2;
        else if (NSAlignment == 4) justification = 0;
        else {
          justification = NSAlignment;
          console.log("sketch: unrecognized text alignment", NSAlignment);
        }
        if (isRtlDominant && justification < 2) justification = 1 - justification;
        textStyle.paraStyle.Justification = justification;
      }
      let minLineHeight = NSParagraphStyle.NSMinLineHeight;
      if (minLineHeight == null) minLineHeight = NSParagraphStyle.minimumLineHeight;
      if (minLineHeight != null) {
        textStyle.textStyle.AutoLeading = false;
        textStyle.textStyle.Leading = minLineHeight;
      }
    }
    textStyle.paraStyle._Direction = isRtlDominant ? 1 : 0;
    TextEngineData.applyStyle(engineData, textOffset, textOffset + runLength, textStyle);
    textOffset += runLength;
  }
  return maxFontSize;
}

// ---------------------------------------------------------------------------
// Styles → layer effects
// ---------------------------------------------------------------------------

function buildLayerStyleFromSketchStyle(
  targetDoc,
  sketchStyle,
  layerBounds,
  layerTransform,
  skipPrimaryFill,
  patternCache,
) {
  if (patternCache == null) patternCache = new Map();
  const effectsRoot = LayerEffectDefs.createLmfxRootTemplate();
  let hasEffects = false;
  for (let effectIndex = 0; effectIndex < LayerEffectDefs.order.length; effectIndex++) {
    effectsRoot[LayerEffectDefs.effectKeys[effectIndex]] = {
      t: "VlLs",
      v: [],
    };
  }

  const fills = sketchStyle.fills;
  const enabledFillDescriptors = buildEnabledFillDescriptors(
    fills,
    layerBounds,
    layerTransform,
    targetDoc,
    null,
    patternCache,
  );

  for (let shadowKindIndex = 0; shadowKindIndex < 2; shadowKindIndex++) {
    const shadowList = sketchStyle[["shadows", "innerShadows"][shadowKindIndex]];
    if (shadowList == null) continue;
    const effectKey = ["DrSh", "IrSh"][shadowKindIndex];
    const effectListKey = LayerEffectDefs.effectKeys[LayerEffectDefs.order.indexOf(effectKey)];
    for (let shadowIndex = 0; shadowIndex < shadowList.length; shadowIndex++) {
      const shadowEntry = shadowList[shadowIndex];
      if (!shadowEntry.isEnabled) continue;
      if (sketchContextOpacity(shadowEntry.contextSettings) == 0 || shadowEntry.color.alpha == 0) continue;
      const shadowEffectDesc = LayerEffectDefs.getEffectDefault(effectKey);
      effectsRoot[effectListKey].v.unshift({
        t: "Objc",
        v: shadowEffectDesc,
      });
      hasEffects = true;
      shadowEffectDesc.Clr.v = sketchColorToRgbDesc(shadowEntry.color);
      shadowEffectDesc.blur.v.val = Math.round(shadowEntry.blurRadius / layerTransform.getScale());
      const inverseTransform = layerTransform.clone();
      inverseTransform.tx = inverseTransform.ty = 0;
      inverseTransform.invert();
      const offsetPoint = inverseTransform.transformPoint(new Point(shadowEntry.offsetX, shadowEntry.offsetY));
      const shadowDistance = Math.sqrt(offsetPoint.x * offsetPoint.x + offsetPoint.y * offsetPoint.y);
      shadowEffectDesc.Dstn.v.val = Math.round(shadowDistance);
      shadowEffectDesc.lagl.v.val = Math.round(Math.atan2(offsetPoint.y, -offsetPoint.x) * (180 / Math.PI));
      if (shadowEffectDesc.layerConceals) shadowEffectDesc.layerConceals.v = enabledFillDescriptors.length != 0;
      applySketchContextToEffectDesc(shadowEntry, shadowEffectDesc);
    }
  }

  const borderList = sketchStyle.borders;
  if (borderList != null && (enabledFillDescriptors.length == 0 || sketchStyle.blur == null || !sketchStyle.blur.isEnabled)) {
    for (let borderIndex = 0; borderIndex < borderList.length; borderIndex++) {
      const borderEntry = borderList[borderIndex];
      if (!borderEntry.isEnabled) continue;
      const frameEffectDesc = LayerEffectDefs.getEffectDefault("FrFX");
      const effectListKey = LayerEffectDefs.effectKeys[LayerEffectDefs.order.indexOf("FrFX")];
      effectsRoot[effectListKey].v.unshift({
        t: "Objc",
        v: frameEffectDesc,
      });
      hasEffects = true;
      frameEffectDesc.Clr.v = sketchColorToRgbDesc(borderEntry.color);
      // Sketch JSON names it borderEntry.gradient; the PSD FrFX descriptor names it Grad.
      if (borderEntry.fillType != 0 && borderEntry.gradient) {
        const gradientEffectDesc = sketchGradientToEffectDesc(borderEntry.gradient, layerTransform);
        const gradientWireKeys = ["Type", "Angl", "Ofst", "Scl"];
        for (let wireKeyIndex = 0; wireKeyIndex < gradientWireKeys.length; wireKeyIndex++) {
          frameEffectDesc[gradientWireKeys[wireKeyIndex]] = gradientEffectDesc[gradientWireKeys[wireKeyIndex]];
        }
        frameEffectDesc.Grad.v = gradientEffectDesc.Grad.v;
        frameEffectDesc.PntT.v.FrFl = "GrFl";
      }
      frameEffectDesc.Sz.v.val = borderEntry.thickness / layerTransform.getScale();
      frameEffectDesc.Styl.v.FStl = ["CtrF", "InsF", "OutF"][borderEntry.position];
      applySketchContextToEffectDesc(borderEntry, frameEffectDesc);
    }
  }

  for (let fillIndex = skipPrimaryFill ? 1 : 0; fillIndex < enabledFillDescriptors.length; fillIndex++) {
    const fillDescriptor = enabledFillDescriptors[fillIndex];
    const effectListKey = LayerEffectDefs.effectKeys[LayerEffectDefs.order.indexOf(fillDescriptor.type)];
    effectsRoot[effectListKey].v.unshift(fillDescriptor.value);
    hasEffects = true;
  }
  return hasEffects ? effectsRoot : null;
}

function buildEnabledFillDescriptors(
  fills,
  layerBounds,
  layerTransform,
  targetDoc,
  imageOverride,
  patternCache,
) {
  if (fills == null) return [];
  if (patternCache == null) patternCache = new Map();

  const enabledFills = [];
  for (let fillIndex = 0; fillIndex < fills.length; fillIndex++) {
    if (fills[fillIndex].isEnabled) enabledFills.push(fills[fillIndex]);
  }
  fills = enabledFills;

  const fillDescriptors = [];
  for (let fillIndex = 0; fillIndex < fills.length; fillIndex++) {
    const fillEntry = fills[fillIndex];
    let effectType = null;
    let effectDescriptor = null;

    if (fillEntry.fillType == 0) {
      effectType = "SoFi";
      const solidFillDesc = LayerEffectDefs.getEffectDefault("SoFi");
      effectDescriptor = {
        t: "Objc",
        v: solidFillDesc,
      };
      effectDescriptor.v.Clr.v = sketchColorToRgbDesc(fillEntry.color);
    } else if (fillEntry.fillType == 1) {
      // Sketch JSON: fillEntry.gradient (PagedDocParser MSStyleFill key).
      effectType = "GrFl";
      effectDescriptor = {
        t: "Objc",
        v: sketchGradientToEffectDesc(fillEntry.gradient, layerTransform),
      };
    } else if (fillEntry.fillType == 4 && fillEntry.image != null) {
      let image = fillEntry.image;
      if (imageOverride) image = imageOverride.value;
      const detectFormat = FileFormatRegistry.detectFormat(image.bdata.buffer);
      if (detectFormat != null && detectFormat != "pdf" && detectFormat != "eps") {
        let patternRecord;
        let patternScale = 0;
        let phaseX = 0;
        let phaseY = 0;
        if (patternCache.has(image.key)) {
          patternRecord = patternCache.get(image.key);
        } else {
          const decodedImage = FileFormatRegistry.getFormat(detectFormat).decode(image.bdata)[0];
          const patternRect = decodedImage.rect.clone();
          patternRecord = {};
          patternRecord.id = Document.generateUID();
          patternRecord.name = "Sketch pattern";
          patternRecord.pixelData = [new Uint8Array(decodedImage.data), patternRect];
          targetDoc.registerPattern(patternRecord);
          patternCache.set(image.key, patternRecord);
        }
        const patternPixelRect = patternRecord.pixelData[1];
        const patternFillDesc = LayerEffectDefs.getEffectDefault("patternFill");
        effectType = "patternFill";
        effectDescriptor = {
          t: "Objc",
          v: patternFillDesc,
        };
        const patternFillType = fillEntry.patternFillType;
        const patternTileScale = fillEntry.patternTileScale;
        patternFillDesc.Algn.v = true;
        patternFillDesc.Ptrn.v.Idnt.v = patternRecord.id;
        if (patternFillType == 0) {
          patternScale = (patternTileScale * patternPixelRect.width) / Math.min(patternPixelRect.width, patternPixelRect.height);
          phaseX = -layerTransform.tx;
          phaseY = -layerTransform.ty;
        } else {
          patternScale = Math.max(layerBounds.width / patternPixelRect.width, layerBounds.height / patternPixelRect.height);
          phaseX = -layerTransform.tx - (patternPixelRect.width * patternScale - layerBounds.width) / 2;
          phaseY = -layerTransform.ty - (patternPixelRect.height * patternScale - layerBounds.height) / 2;
        }
        patternFillDesc.Scl.v.val = 100 * patternScale * (1 / layerTransform.getScale());
        patternFillDesc.phase.v.Hrzn.v = Math.round(phaseX / layerTransform.getScale());
        patternFillDesc.phase.v.Vrtc.v = Math.round(phaseY / layerTransform.getScale());
      }
    } else if (fillEntry.fillType == 5) {
      console.log("sketch: noise fill not implemented");
    } else {
      console.log("sketch: unrecognized fill type", fillEntry.fillType);
    }

    if (effectType != null) {
      applySketchContextToEffectDesc(fillEntry, effectDescriptor.v);
      fillDescriptors.push({
        type: effectType,
        value: effectDescriptor,
      });
    }
  }
  return fillDescriptors;
}

function mergeOpaqueUnderlayFills(fills) {
  const pixelRect = new Rect(0, 0, 1, 1);
  fills = fills.slice(0);
  while (true) {
    let mergedAny = false;
    for (let fillIdx = 0; fillIdx < fills.length - 1; fillIdx++) {
      const underFill = fills[fillIdx];
      const overFill = fills[fillIdx + 1];
      let mergedFill = null;
      let overContext = underFill.contextSettings;
      if (
        underFill.fillType == 0 &&
        (overContext == null || (sketchContextOpacity(overContext) == 1 && overContext.blendMode == 0)) &&
        underFill.color.alpha == 1
      ) {
        let blendMode = "norm";
        let opacityScale = 1;
        overContext = overFill.contextSettings;
        if (overContext) {
          opacityScale = sketchContextOpacity(overContext);
          blendMode = BlendModes.fromPSD(SKETCH_BLEND_MODE_NAMES[overContext.blendMode]);
        }
        if (overFill.fillType == 0) {
          mergedFill = JSON.parse(JSON.stringify(overFill));
          compositeSketchColorUnder(mergedFill.color, underFill.color, mergedFill.color, pixelRect, blendMode, opacityScale);
        }
        if (overFill.fillType == 1) {
          mergedFill = JSON.parse(JSON.stringify(overFill));
          // Sketch JSON: mergedFill.gradient.stops
          const stops = mergedFill.gradient.stops;
          for (let stopIdx = 0; stopIdx < stops.length; stopIdx++) {
            compositeSketchColorUnder(stops[stopIdx].color, underFill.color, stops[stopIdx].color, pixelRect, blendMode, opacityScale);
          }
        }
        if (mergedFill != null && mergedFill.contextSettings) {
          const normalizedContext = mergedFill.contextSettings;
          normalizedContext.opacity = 1;
          normalizedContext.blendMode = 0;
        }
      }
      if (mergedFill != null) {
        fills.splice(fillIdx, 0, mergedFill);
        mergedAny = true;
        break;
      }
    }
    if (!mergedAny || fills.length < 2) break;
  }
  return fills;
}

// ---------------------------------------------------------------------------
// Color / gradient helpers
// ---------------------------------------------------------------------------

function compositeSketchColorUnder(sourceColor, underColor, outColor, pixelRect, blendMode, opacity) {
  const sourceRgba = allocBuffer(4);
  writeSketchColorToRgba(sourceColor, sourceRgba);
  const destRgba = allocBuffer(4);
  writeSketchColorToRgba(underColor, destRgba);
  composite(blendMode, sourceRgba, pixelRect, destRgba, pixelRect, pixelRect, opacity);
  readRgbaToSketchColor(destRgba, outColor);
}

function writeSketchColorToRgba(color, rgbaOut) {
  rgbaOut[0] = 255 * color.red;
  rgbaOut[1] = 255 * color.green;
  rgbaOut[2] = 255 * color.blue;
  rgbaOut[3] = 255 * color.alpha;
}

function readRgbaToSketchColor(rgbaBuffer, colorOut) {
  colorOut.red = rgbaBuffer[0] / 255;
  colorOut.green = rgbaBuffer[1] / 255;
  colorOut.blue = rgbaBuffer[2] / 255;
  colorOut.alpha = rgbaBuffer[3] / 255;
}

function pushClippingMaskGroupEnd(maskLayer, targetDoc) {
  maskLayer = maskLayer.clone();
  maskLayer.layerFlags = 24;
  maskLayer.setName("Mask by " + maskLayer.getName());
  targetDoc.layers.push(maskLayer);
  maskLayer.add.lsct = LayerSectionType.OpenGroup;
  maskLayer.add.lyid = targetDoc.generateLayerId();
  delete maskLayer.add.lmfx;
  delete maskLayer.add.SoCo;
  delete maskLayer.add.GdFl;
  delete maskLayer.add.PtFl;
  delete maskLayer.add.iOpa;
  if (maskLayer.add.vmsk) maskLayer.add.vmsk.maskCombineDirty = true;
  maskLayer.invalidate(targetDoc);
  if ((maskLayer.layerFlags & 16) == 16) maskLayer.layerFlags -= 16;
  if ((maskLayer.layerFlags & 2) == 2) maskLayer.layerFlags -= 2;
  maskLayer.blendMode = "pass";
  maskLayer.Opct = 255;
}

function sketchGradientToEffectDesc(gradient, transform) {
  transform = transform.clone();
  transform.invert();
  transform.tx = transform.ty = 0;
  const getScale = transform.getScale();
  let gradientCenterX = 0;
  let gradientCenterY = 0;
  transform.scale(1 / getScale, 1 / getScale);
  const gradientEffectDesc = LayerEffectDefs.getEffectDefault("GrFl");
  // PSD GrFl descriptor wire key Grad (not Sketch JSON gradient).
  const gradDesc = gradientEffectDesc.Grad.v;
  gradDesc.Intr.v = 0;
  if (gradient == null) return gradientEffectDesc;

  const gradientType = gradient.gradientType;
  let gradientFrom = parseBracketedPoint(gradient.from);
  let gradientTo = parseBracketedPoint(gradient.to);
  gradientFrom.offset(-0.5, -0.5);
  gradientTo.offset(-0.5, -0.5);
  gradientFrom = transform.transformPoint(gradientFrom);
  gradientTo = transform.transformPoint(gradientTo);
  const atan2 = Math.atan2(-(gradientTo.y - gradientFrom.y), gradientTo.x - gradientFrom.x);
  gradientEffectDesc.Type.v.GrdT = ["Lnr", "Rdl", "Angl"][gradientType];
  gradientEffectDesc.Scl.v.val = 100 * Point.dist(gradientFrom, gradientTo);

  if (gradientType == 0) {
    gradientEffectDesc.Angl.v.val = (180 / Math.PI) * atan2;
    gradientEffectDesc.Scl.v.val = 100 * Point.dist(gradientFrom, gradientTo);
    gradientCenterX = (gradientFrom.x + gradientTo.x) / 2;
    gradientCenterY = (gradientFrom.y + gradientTo.y) / 2;
  }
  if (gradientType == 1) {
    gradientEffectDesc.Scl.v.val = 200 * Point.dist(gradientFrom, gradientTo);
    gradientCenterX = gradientFrom.x;
    gradientCenterY = gradientFrom.y;
  }
  if (gradientType == 2) {
    gradientEffectDesc.Angl.v.val = (180 / Math.PI) * (atan2 - Math.PI / 2);
  }

  const offsetDesc = gradientEffectDesc.Ofst.v;
  offsetDesc.Hrzn.v.val = gradientCenterX * 100;
  offsetDesc.Vrtc.v.val = gradientCenterY * 100;
  const cssStops = [];
  for (let stopIdx = 0; stopIdx < gradient.stops.length; stopIdx++) {
    const stopEntry = gradient.stops[stopIdx];
    const stopColor = stopEntry.color;
    cssStops.push([stopEntry.position, stopColor ? [stopColor.red, stopColor.green, stopColor.blue] : [0, 0, 0], stopColor.alpha]);
  }
  cssStopsToGradientDesc(cssStops, gradDesc);
  return gradientEffectDesc;
}

function applySketchContextToEffectDesc(sketchEffect, opacityScale) {
  let scale = 1;
  const contextSettings = sketchEffect.contextSettings;
  if (contextSettings != null) {
    opacityScale.Md.v.blendMode = SKETCH_BLEND_MODE_NAMES[contextSettings.blendMode];
    scale *= sketchContextOpacity(contextSettings);
  } else {
    opacityScale.Md.v.blendMode = SKETCH_BLEND_MODE_NAMES[0];
  }
  opacityScale.enab.v = sketchEffect.isEnabled;
  if (opacityScale.uglg != null) opacityScale.uglg.v = false;
  if (sketchEffect.color != null) scale *= sketchEffect.color.alpha;
  opacityScale.Opct.v.val = Math.round(scale * 100);
}

function sketchColorToRgbDesc(color) {
  return toRGBDesc(
    color
      ? {
          h: color.red * 255,
          l: color.green * 255,
          O: color.blue * 255,
        }
      : {
          h: 0,
          l: 0,
          O: 0,
        },
  );
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function createBezierPathRecord(recordType, incomingHandle, anchor, outgoingHandle) {
  const record = {
    type: recordType,
    anchor: anchor,
    anchorOut: outgoingHandle,
  };
  record[PATH_KNOT_INCOMING_HANDLE] = incomingHandle;
  return record;
}

function buildVectorPathFromShapeLayers(shapeLayers, layerTransform, pathOut) {
  let pathRecords = [
    {
      type: 6,
    },
    {
      type: 8,
      all: 0,
    },
  ];

  for (let shapeIndex = 0; shapeIndex < shapeLayers.length; shapeIndex++) {
    const shapeLayer = shapeLayers[shapeIndex];
    const booleanOperation = shapeLayer.booleanOperation;
    let fillRule = 0;
    const shapeClass = shapeLayer._class;
    let hasBezierCurves = false;

    if (shapeClass == "group" || shapeClass == "text" || shapeClass == "symbolInstance" || shapeClass == "slice") {
      console.log("sketch: non-path child in shape group:", shapeClass);
      continue;
    }

    if (booleanOperation == -1) fillRule = 0;
    else if (booleanOperation == 0) fillRule = 1;
    else if (booleanOperation == 1) fillRule = 2;
    else if (booleanOperation == 2) fillRule = 3;
    else if (booleanOperation == 3) fillRule = 0;
    if (shapeIndex == 0) fillRule = 1;

    const shapeBounds = readRect(shapeLayer.frame);
    const shapeMatrix = buildLayerTransformMatrix(shapeLayer, layerTransform);
    const pathSource = shapeLayer.path ? shapeLayer.path : shapeLayer;
    let subpathRecords = [
      {
        type: 0,
        length: 0,
        fillRule: fillRule,
        subpathHeaderFlags: 2,
        subpathUint32A: 0,
        subpathUint32B: 0,
      },
    ];
    const pathPoints = pathSource.points;

    for (let pointIndex = 0; pointIndex < pathPoints.length; pointIndex++) {
      const pointSpec = pathPoints[pointIndex];
      const curveToPoint = parseBracketedPoint(pointSpec.curveTo);
      const anchorPoint = parseBracketedPoint(pointSpec.point);
      const curveFromPoint = parseBracketedPoint(pointSpec.curveFrom);
      hasBezierCurves =
        hasBezierCurves ||
        (pointSpec.hasCurveFrom && !curveFromPoint.equals(anchorPoint)) ||
        (pointSpec.hasCurveTo && !curveToPoint.equals(anchorPoint));
    }

    let cornerRadii = [];
    if (!hasBezierCurves) {
      const flatCoordPairs = [];
      const pointCount = pathPoints.length;
      if (pointCount == 0) continue;
      for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
        cornerRadii[pointIndex] = pathPoints[pointIndex].cornerRadius;
        const anchorPoint = parseBracketedPoint(pathPoints[pointIndex].point);
        flatCoordPairs.push(anchorPoint.x, anchorPoint.y);
      }
      shapeMatrix.scale(1 / shapeBounds.width, 1 / shapeBounds.height);
      shapeMatrix.invert();
      transformCoordPairs(flatCoordPairs, shapeMatrix, flatCoordPairs);
      const knotRecords = polylineCoordsToKnots(flatCoordPairs, cornerRadii);
      subpathRecords = subpathRecords.concat(knotRecords);
      subpathRecords[0].length = subpathRecords.length - 1;
    } else {
      const pointCount = pathPoints.length;
      subpathRecords[0].length = pointCount;
      for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
        const pointSpec = pathPoints[pointIndex];
        const curveMode = pointSpec.curveMode;
        const anchorPoint = parseBracketedPoint(pointSpec.point);
        subpathRecords[1 + pointIndex] = createBezierPathRecord(
          curveMode == 2 || curveMode == 4 ? 1 : 2,
          pointSpec.hasCurveTo ? parseBracketedPoint(pointSpec.curveTo) : anchorPoint.clone(),
          anchorPoint,
          pointSpec.hasCurveFrom ? parseBracketedPoint(pointSpec.curveFrom) : anchorPoint.clone(),
        );
      }
      shapeMatrix.scale(1 / shapeBounds.width, 1 / shapeBounds.height);
      shapeMatrix.invert();
      transformPathRecordCoords(subpathRecords, shapeMatrix);
      cornerRadii = [];
      for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
        const pointSpec = pathPoints[pointIndex];
        const curveMode = pointSpec.curveMode;
        const cornerRadius = pointSpec.cornerRadius;
        if (curveMode == 1 && cornerRadius != 0) cornerRadii.push(cornerRadius);
        else cornerRadii.push(0);
      }
    }

    if (!pathSource.isClosed) {
      for (let recordIndex = 0; recordIndex < subpathRecords.length; recordIndex++) {
        subpathRecords[recordIndex].type += 3;
      }
    }
    pathRecords = pathRecords.concat(subpathRecords);

    let keyOrigin = createEmptyKeyOrigin();
    const className = getSketchClassName(shapeLayer);
    if (shapeMatrix.b == 0 && shapeMatrix.c == 0) {
      const originLeft = shapeMatrix.tx;
      const originTop = shapeMatrix.ty;
      const originRight = originLeft + shapeMatrix.a;
      const originBottom = originTop + shapeMatrix.d;
      const originBounds = [originLeft, originTop, originRight, originBottom];
      if (className == "rectangle" && cornerRadii.length == 4) {
        keyOrigin = buildKeyOriginFromGeom(2, originBounds, cornerRadii);
      }
      if (className == "oval") keyOrigin = buildKeyOriginFromGeom(5, originBounds);
    }
    pathOut.push(keyOrigin);
  }
  return pathRecords;
}

function buildLayerTransformMatrix(layer, parentTransform) {
  const layerTransform = parentTransform.clone();
  const layerBounds = layer.frame ? readRect(layer.frame) : null;
  if (layerBounds) layerTransform.translate(-layerBounds.x - layerBounds.width / 2, -layerBounds.y - layerBounds.height / 2);
  if (layer.isFlippedHorizontal) layerTransform.scale(-1, 1);
  if (layer.isFlippedVertical) layerTransform.scale(1, -1);
  layerTransform.rotate(-layer.rotation * (Math.PI / 180));
  if (layerBounds) layerTransform.translate(layerBounds.width / 2, layerBounds.height / 2);
  return layerTransform;
}

function parseBracketedPoint(bracketedPoint) {
  bracketedPoint = bracketedPoint.slice(1, bracketedPoint.length - 1).split(",");
  return new Point(parseFloat(bracketedPoint[0]), parseFloat(bracketedPoint[1]));
}

function readRect(frame) {
  return new Rect(frame.x, frame.y, frame.width, frame.height);
}

function rectToSketchFrameJson(rect) {
  return {
    _class: "rect",
    constrainProportions: false,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

// ---------------------------------------------------------------------------
// Public loader surface
// ---------------------------------------------------------------------------

const SketchLoader = {
  parse,
  getSketchClassName,
  sketchContextOpacity,
  computeSketchImportScale,
  computeArtboardBounds,
  reflowOversizedArtboards,
  collectSymbolMastersById,
  findNestedSymbolMaster,
  importSketchLayerTree,
  findOverrideByNamePrefix,
  decodeNSStringAttributeRunIndex,
  applyAttributedStringStyles,
  buildLayerStyleFromSketchStyle,
  buildEnabledFillDescriptors,
  mergeOpaqueUnderlayFills,
  compositeSketchColorUnder,
  writeSketchColorToRgba,
  readRgbaToSketchColor,
  pushClippingMaskGroupEnd,
  sketchGradientToEffectDesc,
  applySketchContextToEffectDesc,
  sketchColorToRgbDesc,
  buildVectorPathFromShapeLayers,
  buildLayerTransformMatrix,
  parseBracketedPoint,
  readRect,
  rectToSketchFrameJson,
  sketchBlendModeNames: SKETCH_BLEND_MODE_NAMES,
};

export {
  SketchLoader,
  SKETCH_BLEND_MODE_NAMES,
  getSketchClassName,
  sketchContextOpacity,
  computeSketchImportScale,
  readRect,
  parseBracketedPoint,
  sketchColorToRgbDesc,
  writeSketchColorToRgba,
  readRgbaToSketchColor,
  buildLayerTransformMatrix,
};
