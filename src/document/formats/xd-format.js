// Adobe XD (.xd) importer.
//
// An .xd package is a ZIP whose public layout is documented by Adobe tooling
// and community reverse-engineering of the container:
//   - `manifest` lists artwork children with `uxdesign#bounds`
//   - shared paints live in `resources/graphics/graphicContent.agc`
//   - each artboard is `artwork/<path>/graphics/graphicContent.agc` (AGC JSON)
//
// This module unpacks that layout and builds Document layers (groups, vectors,
// text, fills, drop shadows). It does not share control flow with any prior
// minified importer.
/* global UZIP, Typr */

import { Point } from "../../core/math/point.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { BinaryUtils } from "../../core/binary/binary-utils.js";

import { FileFormatRegistry } from "./registry/file-format-registry.js";

import { Document } from "../model/document.js";
import { Layer, LayerSectionType } from "../model/layer.js";
import { LayerEffectDefs } from "./psd/effect-defs.js";
import { TextEngineData } from "../../features/text/text-engine.js";
import { ImportLayout } from "../import-layout.js";
import { VectorMask } from "../model/layer-masks.js";
import { showToast } from "../../core/user-prompts.js";
import { TransformToolBase } from "../transform/transform-static.js";
import { packDoublesList } from "./psd/descriptor-codec.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { buildCanvasPathRecords, rectToPathOutline, transformCoordPairs } from "../../engine/compositing/anti-alias.js";
import { ellipsePathRecords, polygonFromFlatCoords, rectanglePathRecords } from "../../engine/compositing/shape-primitives.js";
import { boundsOfPathRecords } from "../../engine/compositing/selection-utils.js";
import { polylineCoordsToKnots, transformPathRecordCoords } from "../../engine/compositing/path-records.js";
import { cssStopsToGradientDesc, gradientAngleFromPoints, toRGBDesc } from "../../engine/compositing/psd-color-utils.js";

/** Soft cap on imported document pixels (~67 MP). */
const MAX_IMPORT_PIXELS = 8192 * 8192;

/** Skip vector clip paths larger than this area (too expensive to tessellate). */
const MAX_CLIP_PATH_AREA = 4_000_000;

/** PSD layer names are truncated past this length. */
const MAX_LAYER_NAME_CHARS = 255;

/**
 * XD drop-shadow `r` is a soft radius; Photoshop `DrSh.blur` expects a tighter
 * Gaussian parameter. Scale chosen so typical XD shadows match PSD preview.
 */
const XD_SHADOW_BLUR_TO_PSD = 2.3;

/** Aspect-ratio epsilon used when promoting a pattern fill to a smart object. */
const PATTERN_ASPECT_MATCH_EPS = 0.01;

const STROKE_ALIGN = ["inside", "center", "outside"];
const STROKE_CAP = ["butt", "round", "square"];
const PARA_ALIGN = ["left", "right", "center"];
const GRADIENT_KIND = ["linear", "radial"];
const GRADIENT_PSD_TYPE = ["Lnr", "Rdl", "Angl"];

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function readZipJson(zipEntries, entryPath) {
  const bytes = zipEntries[entryPath];
  if (bytes == null) throw new Error("XD package missing entry: " + entryPath);
  return JSON.parse(BinaryUtils.readUtf8(bytes));
}

function layerNameFromNode(node) {
  const raw = node.name;
  if (!raw) return "Layer";
  return raw.length > MAX_LAYER_NAME_CHARS ? raw.slice(0, MAX_LAYER_NAME_CHARS) : raw;
}

/** Map XD `{a,b,c,d,tx,ty}` into a Matrix2D (identity when absent). */
function jsonToMatrix(transformJson) {
  if (transformJson == null) return new Matrix2D();
  return new Matrix2D(
    transformJson.a,
    transformJson.b,
    transformJson.c,
    transformJson.d,
    transformJson.tx,
    transformJson.ty,
  );
}

function rgbDescFromChannels(r, g, b) {
  // Engine RGB descriptor convention uses { h, l, O } for the three channels.
  return toRGBDesc({ h: r, l: g, O: b });
}

function xdColorToRgbDesc(xdColorValue) {
  return rgbDescFromChannels(xdColorValue.r, xdColorValue.g, xdColorValue.b);
}

function concatInvert(parentMatrix, localMatrix) {
  const local = localMatrix.clone();
  local.invert();
  const combined = parentMatrix.clone();
  combined.concat(local);
  return combined;
}

function opacityByte(fraction) {
  return Math.round(255 * fraction);
}

// ---------------------------------------------------------------------------
// Package → artboard list
// ---------------------------------------------------------------------------

/**
 * Walk `manifest.children` for the `artwork` folder and load each artboard's
 * AGC root node. Returns `{ spec, bounds, root }` records (bounds in design px).
 */
function collectArtboards(manifest, zipEntries) {
  const artboards = [];
  const topLevel = manifest.children || [];
  for (let i = 0; i < topLevel.length; i++) {
    const folder = topLevel[i];
    if (folder.name !== "artwork") continue;
    const kids = folder.children || [];
    for (let j = 0; j < kids.length; j++) {
      const entry = kids[j];
      const boundsJson = entry["uxdesign#bounds"];
      if (!boundsJson) continue;
      const agcPath = "artwork/" + entry.path + "/graphics/graphicContent.agc";
      const graphicContent = readZipJson(zipEntries, agcPath);
      if (!graphicContent.children || graphicContent.children.length !== 1) {
        throw new Error("Each XD artboard AGC must have exactly one root child");
      }
      artboards.push({
        name: entry.name,
        bounds: ImportLayout.readRect(boundsJson),
        root: graphicContent.children[0],
      });
    }
  }
  return artboards;
}

function unionArtboardBounds(artboards) {
  let union = new Rect();
  for (let i = 0; i < artboards.length; i++) {
    union = union.union(artboards[i].bounds);
  }
  return union;
}

/**
 * Size the document canvas, allocate the composite buffer, and return the
 * design→document affine (includes import downscale).
 */
function prepareDocumentCanvas(doc, designBounds, artboardCount) {
  const downscale = ImportLayout.computeDocumentDownscale(designBounds, MAX_IMPORT_PIXELS);
  doc.pendingTextRasterization = true;
  doc.width = Math.round(designBounds.width / downscale);
  doc.height = Math.round(designBounds.height / downscale);
  doc.buffer = allocBuffer(doc.width * doc.height * 4);
  doc.initArtboardDocument(artboardCount);
  return new Matrix2D(downscale, 0, 0, downscale, designBounds.x, designBounds.y);
}

/**
 * Map one artboard's design-space bounds into document pixels under `docMatrix`.
 */
function artboardRectInDocument(sourceBounds, docMatrix) {
  const matrix = docMatrix.clone();
  const scale = matrix.getScale();
  matrix.translate(-sourceBounds.x, -sourceBounds.y);
  const rect = sourceBounds.clone();
  rect.x = -Math.floor(matrix.tx / scale);
  rect.y = -Math.floor(matrix.ty / scale);
  rect.width = Math.floor(rect.width / scale);
  rect.height = Math.floor(rect.height / scale);
  return rect;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function parse(bytes, doc) {
  const zipEntries = UZIP.parse(bytes);
  const manifest = readZipJson(zipEntries, "manifest");
  const resourcesRoot = readZipJson(zipEntries, "resources/graphics/graphicContent.agc");
  const resources = resourcesRoot.resources;
  const artboards = collectArtboards(manifest, zipEntries);
  const designBounds = unionArtboardBounds(artboards);
  const docMatrix = prepareDocumentCanvas(doc, designBounds, artboards.length);
  const patternCache = new Map();

  for (let i = 0; i < artboards.length; i++) {
    const board = artboards[i];
    const boardRect = artboardRectInDocument(board.bounds, docMatrix);
    convertNode(board.root, {
      doc,
      parentMatrix: docMatrix,
      resources,
      zipEntries,
      artboardRect: boardRect,
      patternCache,
    });
    const boardLayer = doc.layers[doc.layers.length - 1];
    boardLayer.setName(board.name);
    boardLayer.setArtboardRect(boardRect);
    // Sibling artboards are closed groups except the last (open for editing).
    if (i !== artboards.length - 1) {
      boardLayer.add.lsct = LayerSectionType.ClosedGroup;
    }
  }
}

// ---------------------------------------------------------------------------
// Style / paint extraction
// ---------------------------------------------------------------------------

function readNodeStyle(node) {
  const style = node.style;
  const out = {
    stroke: null,
    strokeType: "none",
    fill: null,
    fillType: "none",
    filters: null,
    clipPathRef: null,
  };
  if (!style) return out;

  out.stroke = style.stroke || null;
  out.strokeType = out.stroke ? out.stroke.type : "none";
  out.fill = style.fill || null;
  out.fillType = out.fill ? out.fill.type : "none";
  out.filters = style.filters || null;
  out.clipPathRef = style.clipPath || null;

  if (out.fillType === "pattern" && out.fill.pattern && out.fill.pattern.meta && out.fill.pattern.meta.ux) {
    if (out.fill.pattern.meta.ux.uid === "") out.fillType = "none";
  }
  return out;
}

function resolveClipChildren(node, styleInfo, resources) {
  let clip = styleInfo.clipPathRef;
  if (clip && resources.clipPaths && resources.clipPaths[clip.ref]) {
    return resources.clipPaths[clip.ref].children;
  }
  if (node.meta && node.meta.ux && node.meta.ux.clipPathResources) {
    return node.meta.ux.clipPathResources.children;
  }
  return null;
}

function applyStyleOpacity(layer, style, styleInfo) {
  if (style && style.opacity != null) layer.Opct = opacityByte(style.opacity);
  if (styleInfo.fillType === "solid" && styleInfo.fill.color && styleInfo.fill.color.alpha) {
    layer.Opct = Math.round(layer.Opct * styleInfo.fill.color.alpha);
  }
  if (!styleInfo.filters) return;
  for (let i = 0; i < styleInfo.filters.length; i++) {
    const filter = styleInfo.filters[i];
    if (filter.type !== "uxdesign#blur") continue;
    const params = filter.params;
    let brightness = params.brightnessAmount;
    if (brightness == null) brightness = 0;
    brightness = Math.abs(brightness / 100);
    const visible = filter.visible == null || filter.visible === true;
    if (visible && params.backgroundEffect) {
      layer.Opct = Math.round(layer.Opct * (brightness + (1 - brightness) * params.fillOpacity));
    }
  }
}

// ---------------------------------------------------------------------------
// Scene graph
// ---------------------------------------------------------------------------

function convertNode(node, ctx) {
  const kind = node.type;
  const payload = node[kind];
  const style = node.style;
  const styleInfo = readNodeStyle(node);
  const layerMatrix = concatInvert(ctx.parentMatrix, jsonToMatrix(node.transform));

  let layer = ctx.doc.newLayer();
  layer.setName(layerNameFromNode(node));
  if (node.visible != null) layer.setVisible(node.visible);

  if (style) {
    applyStyleOpacity(layer, style, styleInfo);
    if (styleInfo.filters) layer.add.lmfx = effectsFromFilters(styleInfo.filters);
  }

  const clipChildren = resolveClipChildren(node, styleInfo, ctx.resources);

  if (kind === "artboard" || kind === "group") {
    convertGroup(node, kind, payload, layer, layerMatrix, styleInfo, clipChildren, ctx);
  } else if (kind === "shape" && shouldPromotePatternRect(node, styleInfo)) {
    const smart = convertPatternRectAsSmartObject(node, layer, layerMatrix, styleInfo, ctx);
    // A pattern rect whose image is absent from the package contributes no layer.
    if (smart == null) return;
    layer = smart;
  } else if (kind === "shape") {
    convertShape(payload, layer, layerMatrix, styleInfo, ctx);
  } else if (kind === "text" && node.text) {
    convertText(node, layer, layerMatrix, styleInfo);
  } else {
    console.log("xd: unhandled node type", kind, node);
  }

  ctx.doc.layers.push(layer);
}

function applyVectorClip(layer, clipChildren, layerMatrix, doc) {
  if (!clipChildren || !clipChildren.length) return;
  const clipNode = clipChildren[0];
  const clipShape = clipNode.shape;
  const areaTooLarge =
    clipShape != null &&
    clipShape.type === "rect" &&
    clipShape.width * clipShape.height > MAX_CLIP_PATH_AREA;

  if (areaTooLarge) return;
  if (clipNode.type === "text") {
    showToast("Text clip paths are not imported");
    return;
  }
  if (!clipShape) return;

  const pathMatrix = concatInvert(layerMatrix, jsonToMatrix(clipNode.transform));
  layer.add.vmsk = new VectorMask();
  layer.add.vmsk.pathRecords = shapeToPath(clipShape);
  const inv = pathMatrix.clone();
  inv.invert();
  transformPathRecordCoords(layer.add.vmsk.pathRecords, inv);
  layer.invalidate(doc);
}

function convertGroup(node, kind, payload, layer, layerMatrix, styleInfo, clipChildren, ctx) {
  applyVectorClip(layer, clipChildren, layerMatrix, ctx.doc);

  layer.add.lsct = LayerSectionType.OpenGroup;
  layer.blendMode = "pass";
  layer.layerFlags = 24;
  if (node.visible != null) layer.setVisible(node.visible);
  ctx.doc.layers.push(ctx.doc.createGroupEndLayer());

  maybeAddGroupBackground(kind, layer, layerMatrix, styleInfo, ctx);

  const children = payload.children || [];
  for (let i = 0; i < children.length; i++) {
    convertNode(children[i], {
      doc: ctx.doc,
      parentMatrix: layerMatrix,
      resources: ctx.resources,
      zipEntries: ctx.zipEntries,
      artboardRect: ctx.artboardRect,
      patternCache: ctx.patternCache,
    });
  }
}

function maybeAddGroupBackground(kind, groupLayer, layerMatrix, styleInfo, ctx) {
  if (!styleInfo.fill) return;

  let colorValue = styleInfo.fill.color;
  if (colorValue) colorValue = colorValue.value;

  if (kind === "artboard" && styleInfo.fillType === "solid" && colorValue) {
    groupLayer.setArtboardRect(new Rect(0, 0, 10, 10));
    groupLayer.add.artb.Clr = { t: "Objc", v: xdColorToRgbDesc(colorValue) };
    groupLayer.add.artb.artboardBackgroundType = { t: "long", v: 4 };
    return;
  }

  const fillLayer = ctx.doc.newLayer();
  fillLayer.setName("Artboard fill");
  fillLayer.layerFlags |= 16;
  fillLayer.add.vstk = LayerEffectDefs.getStrokeStyleDefault();
  fillLayer.add.vmsk = new VectorMask();
  fillLayer.add.vmsk.pathRecords = shapeToPath({
    type: "rect",
    x: ctx.artboardRect.x,
    y: ctx.artboardRect.y,
    width: ctx.artboardRect.width,
    height: ctx.artboardRect.height,
  });
  applyFill(
    styleInfo.fill,
    styleInfo.fillType,
    layerMatrix,
    ctx.artboardRect,
    ctx.artboardRect,
    fillLayer,
    ctx,
  );
  fillLayer.invalidate(ctx.doc);
  ctx.doc.layers.push(fillLayer);
}

function shouldPromotePatternRect(node, styleInfo) {
  if (styleInfo.fillType !== "pattern") return false;
  if (node.shape.type !== "rect") return false;
  if (node.shape.r != null && node.shape.r !== 0) return false;
  const pattern = styleInfo.fill.pattern;
  const shapeAspect = node.shape.width / node.shape.height;
  const patternAspect = pattern.width / pattern.height;
  return Math.abs(shapeAspect - patternAspect) < PATTERN_ASPECT_MATCH_EPS;
}

/**
 * @returns {?object} the smart-object layer, or null when the pattern image is
 *   absent from the package.
 */
function convertPatternRectAsSmartObject(node, seedLayer, layerMatrix, styleInfo, ctx) {
  const pattern = styleInfo.fill.pattern;
  const ux = pattern.meta.ux;
  const zipBytes = ctx.zipEntries["resources/" + ux.uid];
  if (zipBytes == null) {
    console.warn("xd: missing pattern resource", ux.uid);
    return null;
  }

  const smart = ctx.doc.createSmartObjectLayer(zipBytes, seedLayer.getName(), 0, 0);
  smart.layerFlags = seedLayer.layerFlags;
  smart.Opct = seedLayer.Opct;

  const corners = rectToPathOutline(
    new Rect(0, 0, pattern.width, pattern.height),
  ).coords;
  const scaleMtx = new Matrix2D();
  scaleMtx.scale(pattern.width / node.shape.width, pattern.height / node.shape.height);
  if (ux.offsetX) scaleMtx.translate(-ux.offsetX * pattern.width, 0);
  if (ux.offsetY) scaleMtx.translate(0, -ux.offsetY * pattern.height);

  const placedMatrix = layerMatrix.clone();
  placedMatrix.concat(scaleMtx);
  placedMatrix.invert();
  transformCoordPairs(corners, placedMatrix, corners);
  smart.add.placedData.Trnf = packDoublesList(corners);
  smart.add.placedData.nonAffineTransform = packDoublesList(corners);
  smart.rasterizeSmartObject(ctx.doc, false);
  return smart;
}

function convertShape(shapePayload, layer, layerMatrix, styleInfo, ctx) {
  layer.layerFlags |= 16;
  layer.add.vstk = LayerEffectDefs.getStrokeStyleDefault();
  layer.add.vmsk = new VectorMask();
  layer.add.vmsk.pathRecords = shapeToPath(shapePayload);

  const designBounds = boundsOfPathRecords(layer.add.vmsk.pathRecords, null);
  const inv = layerMatrix.clone();
  inv.invert();
  transformPathRecordCoords(layer.add.vmsk.pathRecords, inv);
  const docBounds = boundsOfPathRecords(layer.add.vmsk.pathRecords, null);

  if (styleInfo.strokeType !== "none") {
    applyVectorStroke(layer, styleInfo.stroke);
  }

  if (styleInfo.filters) {
    for (let i = 0; i < styleInfo.filters.length; i++) {
      const filter = styleInfo.filters[i];
      if (filter.type === "uxdesign#blur" && filter.visible) {
        layer.add.vmsk.feather = filter.params.blurAmount;
      }
    }
  }

  applyFill(styleInfo.fill, styleInfo.fillType, layerMatrix, designBounds, docBounds, layer, ctx);
  layer.invalidate(ctx.doc);
}

function applyVectorStroke(layer, strokePaint) {
  const colorValue = strokePaint.color.value;
  const solidTemplate = LayerEffectDefs.getEffectDefault("SoFi");
  const solidDesc = { t: "Objc", v: solidTemplate };
  solidDesc.v.Clr.v = xdColorToRgbDesc(colorValue);

  let align = strokePaint.align;
  if (align == null) align = "center";
  const cap = strokePaint.cap;
  const vstk = layer.add.vstk;
  vstk.strokeEnabled.v = true;
  vstk.strokeStyleLineWidth.v.val = strokePaint.width;
  if (align) {
    vstk.strokeStyleLineAlignment.v.strokeStyleLineAlignment =
      LayerEffectDefs.StrokeStyleDefs.alignTypes[STROKE_ALIGN.indexOf(align)];
  }
  if (cap) {
    vstk.strokeStyleLineCapType.v.strokeStyleLineCapType =
      LayerEffectDefs.StrokeStyleDefs.lineCapTypes[STROKE_CAP.indexOf(cap)];
  }

  // Strokes currently import as solid fills only.
  const fillKind = 0;
  const propKeys = LayerEffectDefs.fillPropertyKeyGroups[fillKind];
  const content = (vstk.strokeStyleContent.v = {
    classID: LayerEffectDefs.StrokeStyleDefs.fillLayerTypes[fillKind],
  });
  for (let i = 0; i < propKeys.length; i++) {
    content[propKeys[i]] = solidDesc.v[propKeys[i]];
  }
}

function convertText(node, layer, layerMatrix, styleInfo) {
  const textPayload = node.text;
  const style = node.style;
  const fontSpec = style.font;
  const textAttributes = style.textAttributes;
  const textMatrix = layerMatrix.clone();
  textMatrix.invert();

  layer.add.lnsr = "rend";
  layer.add.TySh = TextEngineData.createTextLayerData(0, 0);
  layer.add.TySh.boundsRect = new Rect(0, 0, 100, 100);
  layer.add.TySh.transform = textMatrix;

  const engineData = layer.add.TySh.engineData;
  const rawText = textPayload.rawText.replace(/\r/g, "\n").replace(/\u000b/g, "\n");
  TextEngineData.insertText(engineData, 0, rawText);

  if (rawText !== "") {
    const run = TextEngineData.getTextStyle(engineData, 0, 1);
    let fontName = fontSpec.postscriptName;
    if (fontName == null) fontName = fontSpec.family;
    TextEngineData.setTextFont(run, fontName);
    run.textStyle.FontSize = Math.round(fontSpec.size);
    if (styleInfo.fill && styleInfo.fill.color) {
      const c = styleInfo.fill.color.value;
      run.textStyle.FillColor = {
        Type: 1,
        Values: [1, c.r / 255, c.g / 255, c.b / 255],
      };
    }
    if (textAttributes) {
      if (textAttributes.paragraphAlign) {
        run.paraStyle.Justification = PARA_ALIGN.indexOf(textAttributes.paragraphAlign);
      }
      if (textAttributes.letterSpacing) {
        run.textStyle.Tracking = Math.round(textAttributes.letterSpacing);
      }
      if (textAttributes.lineHeight) {
        run.textStyle.AutoLeading = false;
        run.textStyle.Leading = Math.round(textAttributes.lineHeight);
      }
    }
    TextEngineData.applyStyle(engineData, 0, rawText.length, run);
  }

  applyRangedStyles(node, engineData, rawText);

  const frame = textPayload.frame;
  if (frame.type === "area" || frame.type === "autoHeight") {
    TextEngineData.setTextType(engineData, 1);
    const boxH = frame.height != null ? frame.height : frame.width * 2;
    TextEngineData.setBoxBounds(engineData, [0, 0, frame.width, boxH]);
  }
}

function applyRangedStyles(node, engineData, rawText) {
  const ranges = node.meta && node.meta.ux && node.meta.ux.rangedStyles;
  if (!ranges) return;
  let cursor = 0;
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    const span = Math.min(range.length, rawText.length - cursor);
    const run = TextEngineData.getTextStyle(engineData, cursor, cursor + span);
    let fontName = range.postscriptName;
    if (fontName == null) fontName = range.family;
    if (fontName != null) TextEngineData.setTextFont(run, fontName);
    if (range.textScript && range.textScript !== "none") {
      run.textStyle.FontBaseline = range.textScript === "superscript" ? 1 : 2;
    }
    if (range.underline != null) run.textStyle.Underline = range.underline;
    if (range.fontSize != null) run.textStyle.FontSize = Math.round(range.fontSize);
    if (range.textTransform != null) {
      run.textStyle.FontCaps = range.textTransform === "uppercase" ? 2 : 0;
    }
    if (range.fill != null) {
      const packed = range.fill.value;
      run.textStyle.FillColor = {
        Type: 1,
        Values: [
          1,
          ((packed >>> 16) & 255) / 255,
          ((packed >>> 8) & 255) / 255,
          ((packed >>> 0) & 255) / 255,
        ],
      };
    }
    TextEngineData.applyStyle(engineData, cursor, cursor + span, run);
    cursor += span;
  }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function emptyPathHeader() {
  return [{ type: 6 }, { type: 8, all: 0 }];
}

function openSubpathHeader(knotCount) {
  return {
    type: 0,
    fillRule: 1,
    length: knotCount,
    subpathUint32A: 0,
    subpathUint32B: 0,
    subpathHeaderFlags: 1,
  };
}

/** Convert an XD shape object into PSD-style path records. */
function shapeToPath(shape) {
  const type = shape.type;
  if (type === "rect") return pathFromRect(shape);
  if (type === "circle") return pathFromCircle(shape);
  if (type === "ellipse") return pathFromEllipse(shape);
  if (type === "path" || type === "compound") return pathFromSvg(shape);
  if (type === "line") return pathFromLine(shape);
  if (type === "polygon") return pathFromPolygon(shape);
  console.log("xd: unhandled shape", type, shape);
  return emptyPathHeader();
}

function pathFromRect(shape) {
  const { x, y, width, height, r: radius } = shape;
  if (radius == null) {
    return rectanglePathRecords(x, y, width, height, 0);
  }
  const knots = polylineCoordsToKnots(
    [x, y, x + width, y, x + width, y + height, x, y + height],
    radius,
    false,
  );
  return emptyPathHeader().concat([openSubpathHeader(8)]).concat(knots);
}

function pathFromCircle(shape) {
  const r = shape.r;
  return ellipsePathRecords(
    shape.cx - r,
    shape.cy - r,
    2 * r,
    2 * r,
  );
}

function pathFromEllipse(shape) {
  return ellipsePathRecords(
    shape.cx - shape.rx,
    shape.cy - shape.ry,
    2 * shape.rx,
    2 * shape.ry,
  );
}

function pathFromSvg(shape) {
  const svgPath = Typr.U.SVGToPath(shape.path);
  return buildCanvasPathRecords(
    { K: svgPath.cmds, H: svgPath.crds },
    false,
  );
}

function pathFromLine(shape) {
  const knots = polylineCoordsToKnots(
    [shape.x1, shape.y1, shape.x2, shape.y2],
    0,
    true,
  );
  return emptyPathHeader().concat([openSubpathHeader(2)]).concat(knots);
}

function pathFromPolygon(shape) {
  const pts = shape.points;
  const flat = [];
  for (let i = 0; i < pts.length; i++) flat.push(pts[i].x, pts[i].y);
  // polygonFromFlatCoords already emits the type-6/8 header; drop it and reuse ours via concat slice.
  return emptyPathHeader().concat(
    polygonFromFlatCoords(flat, 0, false).slice(2),
  );
}

// ---------------------------------------------------------------------------
// Layer effects
// ---------------------------------------------------------------------------

function effectsFromFilters(filterList) {
  const lmfx = LayerEffectDefs.createLmfxRootTemplate();
  for (let i = 0; i < LayerEffectDefs.order.length; i++) {
    lmfx[LayerEffectDefs.effectKeys[i]] = { t: "VlLs", v: [] };
  }

  for (let i = 0; i < filterList.length; i++) {
    const filter = filterList[i];
    if (filter.type !== "dropShadow") continue;

    const listKey = LayerEffectDefs.effectKeys[LayerEffectDefs.order.indexOf("DrSh")];
    const desc = LayerEffectDefs.getEffectDefault("DrSh");
    lmfx[listKey].v.unshift({ t: "Objc", v: desc });

    const shadows = filter.params.dropShadows;
    if (shadows.length !== 1) {
      throw new Error("XD dropShadow expects a single shadow entry");
    }
    const shadow = shadows[0];
    const color = shadow.color;
    const dx = shadow.dx;
    const dy = shadow.dy;

    desc.Clr.v = xdColorToRgbDesc(color.value);
    desc.Opct.v.val = Math.round((color.alpha != null ? color.alpha : 1) * 100);
    desc.uglg.v = false;
    desc.enab.v = filter.visible != null ? filter.visible : true;
    // Photoshop light angle is opposite the shadow offset vector.
    desc.lagl.v.val = Math.round((180 / Math.PI) * Math.atan2(dy, -dx));
    desc.Dstn.v.val = Math.round(Math.hypot(dx, dy));
    desc.blur.v.val = Math.round(shadow.r * XD_SHADOW_BLUR_TO_PSD);
  }
  return lmfx;
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

function applyFill(fillPaint, fillType, layerMatrix, gradientBounds, fillBounds, targetLayer, ctx) {
  if (fillType === "none" || fillPaint == null) {
    targetLayer.add.vstk.fillEnabled.v = false;
    targetLayer.add.SoCo = {
      classID: "null",
      Clr: { t: "Objc", v: rgbDescFromChannels(0, 0, 0) },
    };
    return;
  }

  let fillClassKey = null;
  let propertyKeys = null;
  let fillDesc = null;

  if (fillType === "solid") {
    ({ fillClassKey, propertyKeys, fillDesc } = solidFillDescriptor(fillPaint));
  } else if (fillType === "gradient") {
    ({ fillClassKey, propertyKeys, fillDesc } = gradientFillDescriptor(
      fillPaint,
      layerMatrix,
      gradientBounds,
      fillBounds,
      ctx.resources,
    ));
  } else if (fillType === "pattern") {
    ({ fillClassKey, propertyKeys, fillDesc } = patternFillDescriptor(
      fillPaint,
      fillBounds,
      ctx,
    ));
  } else {
    console.log("xd: unhandled fill", fillType);
    return;
  }

  if (fillClassKey == null) return;
  targetLayer.add[fillClassKey] = { classID: "null" };
  for (let i = 0; i < propertyKeys.length; i++) {
    const key = propertyKeys[i];
    targetLayer.add[fillClassKey][key] = fillDesc.v[key];
  }
}

function solidFillDescriptor(fillPaint) {
  const template = LayerEffectDefs.getEffectDefault("SoFi");
  const desc = { t: "Objc", v: template };
  desc.v.Clr.v = xdColorToRgbDesc(fillPaint.color.value);
  return {
    fillClassKey: "SoCo",
    propertyKeys: LayerEffectDefs.solidFillPropertyKeys,
    fillDesc: desc,
  };
}

function gradientFillDescriptor(fillPaint, layerMatrix, gradientBounds, fillBounds, resources) {
  const template = LayerEffectDefs.getEffectDefault("GrFl");
  const grad = template.Grad.v;
  grad.Intr.v = 0;

  const paint = fillPaint.gradient;
  const resource = paint.ref
    ? resources.gradients[paint.ref]
    : paint.meta.ux.gradientResources;
  const kindIndex = GRADIENT_KIND.indexOf(resource.type);
  template.Type.v.GrdT = GRADIENT_PSD_TYPE[kindIndex];

  let start;
  let end;
  if (kindIndex === 0) {
    // Linear: PSD mapping uses the segment midpoint as the gradient origin.
    start = new Point(paint.x1, paint.y1);
    end = new Point(paint.x2, paint.y2);
    start.x = end.x + 0.5 * (start.x - end.x);
    start.y = end.y + 0.5 * (start.y - end.y);
  } else {
    start = new Point(paint.cx, paint.cy);
    end = new Point(paint.cx + paint.r, paint.cy);
  }

  if (paint.units === "objectBoundingBox") {
    const box = new Matrix2D(
      gradientBounds.width,
      0,
      0,
      gradientBounds.height,
      gradientBounds.x,
      gradientBounds.y,
    );
    start = box.transformPoint(start);
    end = box.transformPoint(end);
  }

  let xf = jsonToMatrix(paint.transform);
  start = xf.transformPoint(start);
  end = xf.transformPoint(end);
  xf = layerMatrix.clone();
  xf.invert();
  start = xf.transformPoint(start);
  end = xf.transformPoint(end);

  gradientAngleFromPoints(start, end, fillBounds, template);

  const cssStops = [];
  const stops = resource.stops;
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const c = stop.color.value;
    const alpha = stop.color.alpha == null ? 1 : stop.color.alpha;
    cssStops.push([stop.Ofst, [c.r / 255, c.g / 255, c.b / 255], alpha]);
  }
  cssStopsToGradientDesc(cssStops, grad);

  return {
    fillClassKey: "GdFl",
    propertyKeys: LayerEffectDefs.gradientOverlayPropertyKeys,
    fillDesc: { t: "Objc", v: template },
  };
}

function decodePatternPixels(patternFill, zipEntries) {
  const uid = patternFill.meta.ux.uid;
  const fileBytes = zipEntries["resources/" + uid].buffer;
  const formatId = FileFormatRegistry.detectFormat(fileBytes);
  let bounds = new Rect(0, 0, patternFill.width, patternFill.height);
  let pixelBuffer;
  if (bounds.isEmpty()) {
    bounds = new Rect(0, 0, 1, 1);
    pixelBuffer = new ArrayBuffer(4);
  } else {
    const handler = FileFormatRegistry.getFormat(formatId);
    if (handler.isLayered) {
      const nested = new Document();
      handler.decode(fileBytes, nested);
      pixelBuffer = nested.getRasterData().buffer;
    } else {
      pixelBuffer = handler.decode(fileBytes)[0].data;
    }
  }
  return { uid, bounds, pixelBuffer };
}

function patternFillDescriptor(fillPaint, fillBounds, ctx) {
  const template = LayerEffectDefs.getEffectDefault("patternFill");
  const patternFill = fillPaint.pattern;
  const ux = patternFill.meta.ux;
  const uid = ux.uid;

  let symbol = ctx.patternCache.get(uid);
  if (!symbol) {
    const decoded = decodePatternPixels(patternFill, ctx.zipEntries);
    symbol = {
      id: Document.generateUID(),
      name: "XD pattern",
      pixelData: [new Uint8Array(decoded.pixelBuffer), decoded.bounds],
    };
    ctx.doc.registerPattern(symbol);
    ctx.patternCache.set(uid, symbol);
  }

  const tileBounds = symbol.pixelData[1];
  template.Algn.v = true;
  template.Ptrn.v.Idnt.v = symbol.id;

  let scale = 1;
  let phaseX = 0;
  let phaseY = 0;
  const behaviour = ux.scaleBehavior;

  if (behaviour === "cover") {
    scale = Math.max(fillBounds.width / tileBounds.width, fillBounds.height / tileBounds.height);
    const coverScale = scale;
    if (ux.Scl != null) scale *= ux.Scl;
    phaseX = fillBounds.x - (tileBounds.width * scale - fillBounds.width) / 2;
    phaseY = fillBounds.y - (tileBounds.height * scale - fillBounds.height) / 2;
    if (ux.offsetX != null) phaseX += ux.offsetX * tileBounds.width * coverScale;
    if (ux.offsetY != null) phaseY += ux.offsetY * tileBounds.height * coverScale;
  } else if (behaviour === "fill") {
    scale =
      Math.min(fillBounds.width, fillBounds.height) /
      Math.max(tileBounds.width, tileBounds.height);
    phaseX = fillBounds.x - (tileBounds.width * scale - fillBounds.width) / 2;
    phaseY = fillBounds.y - (tileBounds.height * scale - fillBounds.height) / 2;
  } else {
    throw new Error("Unsupported XD pattern scaleBehavior: " + behaviour);
  }

  template.Scl.v.val = 100 * scale;
  template.phase.v.Hrzn.v = Math.round(phaseX);
  template.phase.v.Vrtc.v = Math.round(phaseY);

  return {
    fillClassKey: "PtFl",
    propertyKeys: LayerEffectDefs.patternOverlayPropertyKeys,
    fillDesc: { t: "Objc", v: template },
  };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

const XDLoader = {
  parse,
  jsonToMatrix,
  shapeToPath,
};

export { XDLoader, jsonToMatrix, shapeToPath };
