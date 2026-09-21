// SVG document loader and exporter: parses an SVG DOM into layer trees
// (shapes, text, images, clip masks, gradients, filters) and serializes a
// document back out to SVG markup.
/* global Typr, DOMParser */
import { Point } from "../../core/math/point.js";
import { Matrix2D, scaleIgnoringRotation } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { BlendModes } from "../model/blend-modes.js";
import { CSS } from "../../features/css-export/css.js";

import { FileFormatRegistry } from "./registry/file-format-registry.js";

import { LayerStyleRenderer } from "../../features/layer-styles/style-renderer.js";
import { Document } from "../model/document.js";
import { Layer, LayerSectionType } from "../model/layer.js";
import { LayerEffectDefs } from "./psd/effect-defs.js";
import { TextEngineData } from "../../features/text/text-engine.js";
import { TextLayout } from "../../features/text/text-layout.js";
import { TextRenderer } from "../../features/text/text-renderer.js";
import { Mask, VectorMask } from "../model/layer-masks.js";
import { TransformToolBase } from "../transform/transform-static.js";
import { packDoublesList, placedTransformToMatrix } from "./psd/descriptor-codec.js";
import { resizeDocumentCanvas } from "../model/layer-translate.js";
import { allocBuffer, extractChannelByte } from "../../engine/compositing/buffer-utils.js";
import { buildCanvasPathRecords, flattenPathRecordsToPath, pixelAlignRect, rectToPathOutline, splitPathBySubpathId, toTyprPath, transformCoordPairs } from "../../engine/compositing/anti-alias.js";
import { ellipsePathRecords, polygonFromFlatCoords, rectanglePathRecords } from "../../engine/compositing/shape-primitives.js";
import { boundsOfPathRecords, exportPathRecordsToSvg } from "../../engine/compositing/selection-utils.js";
import { transformPathRecordCoords } from "../../engine/compositing/path-records.js";
import { cssStopsToGradientDesc, gradientAngleFromPoints, linearGradientEndpoints, toRGBDesc } from "../../engine/compositing/psd-color-utils.js";

/** Default font size (px) when an element declares none. */
const DEFAULT_FONT_SIZE = 13;
/** `ex` unit → px factor used when sizing the root document. */
const EX_UNIT_TO_PX = 13;
/** Largest canvas dimension (px) permitted when no size constraint is given. */
const MAX_UNCONSTRAINED_DIMENSION = 8192;
/** Group-flag bits marking a collapsed section layer. */
const GROUP_LAYER_FLAGS = 24;
/** Layer-flag bit marking a vector (shape) layer. */
const VECTOR_LAYER_FLAG = 16;

/** Element tags that produce a vector shape layer. */
const SHAPE_TAGS = ["path", "rect", "circle", "ellipse", "polygon", "polyline", "line"];
/** Style keys that are not inherited from an ancestor unless via `<use>`. */
const NON_INHERITED_STYLE_KEYS = ["display", "opacity", "fill-opacity", "filter", "clip-path"];
/** Presentation-attribute / style names collected for each element. */
const STYLE_ATTR_NAMES = "fill-rule fill stroke stroke-width stroke-dasharray stroke-opacity stroke-linejoin stroke-linecap stroke-miterlimit font-size font-weight font-family text-decoration text-anchor dominant-baseline stop-color stop-opacity filter display opacity fill-opacity paint-order clip-path mix-blend-mode xml:space".split(" ");

const LINE_JOIN_NAMES = ["miter", "round", "bevel"];
const LINE_CAP_NAMES = ["butt", "round", "square"];
const TEXT_ANCHOR_NAMES = ["start", "end", "middle"];
/** Fill-descriptor kinds, indexed to LayerEffectDefs stroke content keys. */
const FILL_DESCRIPTOR_KINDS = ["SoFi", "GrFl", "patternFill"];
/** Font family:weight → engine font name overrides. */
const FONT_ALIAS_MAP = {
  "'DejaVu Sans':normal": "DejaVuSans",
  "'DejaVu Sans':bold": "DejaVuSans-Bold",
  "'Nimbus Sans L':normal": "NimbusSanL-Reg",
  "'Nimbus Sans L':bold": "NimbusSanL-Bol",
  "Libre Franklin:300": "LibreFranklin-Light",
  "Libre Franklin:400": "LibreFranklin-Regular",
  "Libre Franklin:500": "LibreFranklin-Medium",
  "Libre Franklin:600": "LibreFranklin-SemiBold",
  "Libre Franklin:700": "LibreFranklin-Bold",
  "Source Sans Pro:normal": "SourceSansPro-Regular",
  "Source Sans Pro:bold": "SourceSansPro-Bold",
};

/** A transparent "no fill" solid-color descriptor. */
function transparentSoCo() {
  return {
    classID: "null",
    Clr: { t: "Objc", v: toRGBDesc({ h: 0, l: 0, O: 0 }) },
  };
}

/** Local part of a (possibly namespaced) element tag name. */
function getTagName(element) {
  return element.tagName ? element.tagName.split(":").pop() : null;
}

// ---------------------------------------------------------------------------
// Import: SVG DOM → document layers
// ---------------------------------------------------------------------------

/**
 * Parse an SVG buffer into layers on `doc`, sizing the canvas from the
 * viewBox / width / height and an optional size constraint.
 * @param {ArrayBuffer|Uint8Array} bytes
 * @param {import("../model/document.js").Document} doc
 * @param {?number[]} sizeConstraint [width, height] upper bound, or null
 */
function parse(bytes, doc, sizeConstraint) {
  bytes = new Uint8Array(bytes);
  var svgText = BinaryUtils.readUtf8(bytes, 0, bytes.length);
  var svgDoc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  var styleNode = svgDoc.getElementsByTagName("style")[0];
  var cssMap = styleNode ? Typr.U.SVG.cssMap(styleNode.textContent) : {};

  var svgRoot = svgDoc.firstChild;
  while (getTagName(svgRoot) != "svg") svgRoot = svgRoot.nextSibling;

  var layout = computeDocumentBounds(svgRoot, doc);
  var viewRect = layout.viewRect;
  var scaleFactor = layout.scaleFactor;
  while (sizeConstraint && Math.max(viewRect.width * (scaleFactor * 2), viewRect.height * (scaleFactor * 2)) <= Math.max(sizeConstraint[0], sizeConstraint[1])) {
    scaleFactor *= 2;
  }
  while (sizeConstraint == null && Math.max(viewRect.width, viewRect.height) * scaleFactor > MAX_UNCONSTRAINED_DIMENSION) {
    scaleFactor *= .5;
  }

  doc.pendingTextRasterization = true;
  doc.width = ~~(viewRect.width * scaleFactor);
  doc.height = ~~Math.abs(viewRect.height * scaleFactor);
  doc.buffer = allocBuffer(doc.width * doc.height * 4);
  var docMatrix = new Matrix2D(scaleFactor, 0, 0, scaleFactor, -viewRect.x * scaleFactor, -viewRect.y * scaleFactor);
  var renderContext = {
    inheritedStyle: getStyleProps(svgRoot),
    cssMap: cssMap,
    groupBlur: 0,
    luminanceMask: null,
  };
  processNodes(svgDoc, svgRoot.children, doc, docMatrix, renderContext, new Matrix2D, 0, false);
  if (doc.layers.length == 0) {
    var defaultLayer = doc.newLayer();
    defaultLayer.setName("Layer");
    doc.layers.push(defaultLayer);
  }
}

/**
 * Derive the pixel-aligned view rectangle and root scale factor from the SVG
 * root's viewBox / width / height, also stashing the viewBox on `doc`.
 * @returns {{viewRect: Rect, scaleFactor: number}}
 */
function computeDocumentBounds(svgRoot, doc) {
  var viewRect = new Rect(0, 0, 100, 100);
  var scaleFactor = 1;
  var viewBoxAttr = svgRoot.getAttribute("viewBox");
  var widthAttr = svgRoot.getAttribute("width");
  var heightAttr = svgRoot.getAttribute("height");
  var docWidth = widthAttr != null ? parseFloat(widthAttr) : parseFloat(heightAttr);
  var docHeight = heightAttr != null ? parseFloat(heightAttr) : parseFloat(widthAttr);
  if (widthAttr && widthAttr.endsWith("ex")) docWidth *= EX_UNIT_TO_PX;
  if (heightAttr && heightAttr.endsWith("ex")) docHeight *= EX_UNIT_TO_PX;
  if (viewBoxAttr) {
    var viewBoxParts = parseNumberList(viewBoxAttr);
    viewRect.x = viewBoxParts[0];
    viewRect.y = viewBoxParts[1];
    viewRect.width = viewBoxParts[2];
    viewRect.height = viewBoxParts[3];
    doc.svgViewBox = viewRect.clone();
    if (widthAttr != null) {
      if (widthAttr == "100%") docWidth = viewRect.width;
      if (heightAttr == "100%") docHeight = viewRect.height;
      var viewAspect = viewBoxParts[2] / viewBoxParts[3];
      var docAspect = docWidth / docHeight;
      if (docAspect > viewAspect) {
        var widthAdjust = viewBoxParts[3] * docAspect - viewRect.width;
        viewRect.x -= widthAdjust / 2;
        viewRect.width += widthAdjust;
      }
      if (docAspect < viewAspect) {
        var heightAdjust = viewBoxParts[2] / docAspect - viewRect.height;
        viewRect.y -= heightAdjust / 2;
        viewRect.height += heightAdjust;
      }
    }
    if (docWidth != null && !isNaN(docWidth)) scaleFactor = docWidth / Math.ceil(viewBoxParts[2]);
  } else if (widthAttr != null || heightAttr != null) {
    viewRect.width = docWidth;
    viewRect.height = docHeight;
  }
  return { viewRect: pixelAlignRect(viewRect), scaleFactor: scaleFactor };
}

/** Split a whitespace- or comma-separated number list into floats. */
function parseNumberList(text) {
  var separator = text.indexOf(",") != -1 ? "," : " ";
  return text.split(separator).map(parseFloat);
}

/** Whether a tag (with its context) is a container whose children are walked. */
function isContainerElement(tagName, element, fromUse) {
  if (tagName == "g" || tagName == "a" || tagName == "svg" || tagName == "switch") return true;
  if ((tagName == "text" || tagName == "textPath") && element.children.length > 0) return true;
  return tagName == "symbol" && fromUse;
}

/**
 * Walk a list of SVG elements, converting each into one or more layers under
 * the running transform, clip, and style context.
 */
function processNodes(svgDoc, nodeList, doc, nodeMatrix, renderContext, textCursor, clipDepth, fromUse) {
  var textAdvance = 0;
  for (var nodeIdx = 0; nodeIdx < nodeList.length; nodeIdx++) {
    var element = nodeList[nodeIdx];
    var tagName = getTagName(element);
    var elementId = element.getAttribute("id");
    if (elementId == null) elementId = element.getAttribute("data-name");
    var computedStyle = resolveComputedStyle(element, renderContext, fromUse);

    var fontSize = computedStyle["font-size"] ? parseLength(computedStyle["font-size"], DEFAULT_FONT_SIZE) : DEFAULT_FONT_SIZE;
    if (element.getAttribute("dx")) nodeMatrix.tx += parseLength(element.getAttribute("dx"), fontSize);
    if (element.getAttribute("dy")) nodeMatrix.ty += parseLength(element.getAttribute("dy"), fontSize);
    var localMatrix = getElementTransform(element);
    localMatrix.concat(nodeMatrix);

    var layer = doc.newLayer();
    if (element.getAttribute("visibility") == "hidden" || computedStyle.display == "none") layer.setVisible(false);
    layer.setName(elementId != null ? elementId.split(":::")[0] : "Layer");
    layer.Opct = Math.round(255 * elementOpacityFactor(computedStyle));
    applyBlendMode(layer, computedStyle);

    var clipLayer = applyClipOrMask(svgDoc, element, computedStyle, localMatrix, clipDepth, elementId, doc, renderContext);
    if (clipLayer) clipDepth++;
    var shapeBlur = applyElementFilter(svgDoc, element, computedStyle, localMatrix, layer);

    if (isContainerElement(tagName, element, fromUse)) {
      emitContainer(svgDoc, element, tagName, elementId, computedStyle, localMatrix, layer, shapeBlur, doc, renderContext, textCursor, clipDepth, fromUse);
    } else if (tagName == "use") {
      emitUse(svgDoc, element, computedStyle, localMatrix, doc, renderContext, textCursor, clipDepth);
    } else if (SHAPE_TAGS.indexOf(tagName) != -1) {
      emitShape(svgDoc, element, computedStyle, localMatrix, layer, shapeBlur, doc, renderContext);
    } else if ((tagName == "text" || tagName == "tspan") && element.textContent != "") {
      textCursor = getPosition(element, textCursor);
      textAdvance = emitText(element, tagName, elementId, computedStyle, localMatrix, textCursor, textAdvance, fontSize, layer, doc, renderContext);
    } else if (tagName == "image") {
      emitImage(doc, element, localMatrix, layer, renderContext);
    } else {
      console.log("unknown tag: " + tagName, element.children.length, element.textContent.length);
    }

    if (clipLayer != null) {
      doc.layers.push(clipLayer);
      clipDepth--;
    }
  }
}

/** Merge inherited style onto an element's own computed style. */
function resolveComputedStyle(element, renderContext, fromUse) {
  var computedStyle = getStyleProps(element, renderContext.cssMap);
  for (var styleKey in renderContext.inheritedStyle) {
    if ((NON_INHERITED_STYLE_KEYS.indexOf(styleKey) == -1 || fromUse) && computedStyle[styleKey] == null) {
      computedStyle[styleKey] = renderContext.inheritedStyle[styleKey];
    }
  }
  return computedStyle;
}

/** Combined layer opacity factor from `opacity` and non-zero `fill-opacity`. */
function elementOpacityFactor(computedStyle) {
  var opacityFactor = 1;
    if (computedStyle.opacity) opacityFactor *= parseFloat(computedStyle.opacity);
    if (computedStyle["fill-opacity"]) {
      var fillOpacityVal = parseFloat(computedStyle["fill-opacity"]);
    if (fillOpacityVal != 0) opacityFactor *= fillOpacityVal;
  }
  return opacityFactor;
}

/** Apply a CSS mix-blend-mode to the layer's PSD blend mode. */
function applyBlendMode(layer, computedStyle) {
  if (!computedStyle["mix-blend-mode"]) return;
      var blendModeIdx = BlendModes.cssNames.indexOf(computedStyle["mix-blend-mode"]);
  if (blendModeIdx != -1) layer.blendMode = BlendModes.psdCodes[blendModeIdx];
}

/**
 * Resolve an element's clip-path / mask reference. Sets a luminance mask on
 * the render context, or returns a clip-group layer to push after the element
 * (null when there is no clip).
 */
function applyClipOrMask(svgDoc, element, computedStyle, localMatrix, clipDepth, elementId, doc, renderContext) {
  var clipAttrName = "clip-path";
    if (element.getAttribute(clipAttrName) == null) clipAttrName = "mask";
  if (element.getAttribute(clipAttrName) == null && !computedStyle["clip-path"]) return null;

      var clipUrl = element.getAttribute(clipAttrName);
      if (clipUrl == null) clipUrl = computedStyle["clip-path"];
      clipUrl = clipUrl.slice(4, clipUrl.length - 1);
      var clipDef = svgDoc.getElementById(clipUrl.slice(1));
  if (!clipDef) return null;

  if (isLuminanceMaskClip(clipDef)) {
    var lumMaskGroup = clipDef.children[0];
    var lumMaskImage = lumMaskGroup.children[0].children[0];
    var lumMaskMatrix = getElementTransform(lumMaskGroup);
        lumMaskMatrix.concat(localMatrix);
    var lumRasterLayer = createRasterImageLayer(doc, lumMaskImage, lumMaskMatrix);
        if (lumRasterLayer) {
      var lumMask = new Mask;
          lumMask.rect = lumRasterLayer.rect.clone();
          lumMask.channel = allocBuffer(lumMask.rect.area());
          extractChannelByte(lumRasterLayer.buffer, lumMask.channel, 0);
      lumMask.parametersApplied = true;
      lumMask.enabled = true;
      lumMask.isEnabled = true;
      renderContext.luminanceMask = lumMask;
    }
    return null;
  }

  var clipLayer = doc.newLayer();
        clipLayer.setName("Clip-Path" + (elementId ? ": " + elementId : ""));
        clipLayer.add.lsct = clipDepth < 2 ? LayerSectionType.OpenGroup : LayerSectionType.ClosedGroup;
        clipLayer.blendMode = "pass";
  clipLayer.layerFlags = GROUP_LAYER_FLAGS;
  var clipMask = clipLayer.add.vmsk = new VectorMask;
        doc.layers.push(doc.createGroupEndLayer());

        var maskShapeNodes = [];
        if (clipDef.getAttribute(clipAttrName)) {
          var nestedClipUrl = clipDef.getAttribute(clipAttrName);
          nestedClipUrl = nestedClipUrl.slice(4, nestedClipUrl.length - 1);
    maskShapeNodes = svgDoc.getElementById(nestedClipUrl.slice(1)).children;
  }
  appendClipSubpaths(svgDoc, clipDef.children, localMatrix, clipMask, null);
  appendClipSubpaths(svgDoc, maskShapeNodes, localMatrix, clipMask, 3);
  for (var clipRecIdx = 0; clipRecIdx < clipMask.pathRecords.length; clipRecIdx++) {
          if (clipMask.pathRecords[clipRecIdx].fillRule != null) clipMask.pathRecords[clipRecIdx].fillRule = 0;
  }
        clipLayer.updateVectorOrigins();
        clipLayer.invalidate();
  return clipLayer;
}

/** Append transformed shape subpaths of `shapeNodes` onto a clip mask. */
function appendClipSubpaths(svgDoc, shapeNodes, localMatrix, clipMask, overrideFillRule) {
  for (var shapeIdx = 0; shapeIdx < shapeNodes.length; shapeIdx++) {
    var shapeMatrix = getElementTransform(shapeNodes[shapeIdx]);
    shapeMatrix.concat(localMatrix);
    var shapePath = svgShapeToPath(svgDoc, shapeNodes[shapeIdx], false).slice(2);
    if (overrideFillRule != null) {
      for (var recordIdx = 0; recordIdx < shapePath.length; recordIdx++) {
        if (shapePath[recordIdx].fillRule != null) shapePath[recordIdx].fillRule = overrideFillRule;
      }
    }
    transformPathRecordCoords(shapePath, shapeMatrix);
    clipMask.pathRecords = clipMask.pathRecords.concat(shapePath);
  }
}

/**
 * Apply an element's `filter` reference: attaches a drop/inner-shadow effect
 * and returns the feather-blur amount (0 when none).
 */
function applyElementFilter(svgDoc, element, computedStyle, localMatrix, layer) {
  if (!computedStyle.filter || computedStyle.filter == "none") return 0;
  var filterResult = parseFilterDef(svgDoc, computedStyle.filter, scaleIgnoringRotation(localMatrix));
  if (filterResult.shadowDesc) appendLayerEffect(layer, filterResult.effectListKey, filterResult.shadowDesc);
  return filterResult.blurAmount ? filterResult.blurAmount : 0;
}

/** Emit a container element (group/anchor/nested-svg/symbol/multi-run text). */
function emitContainer(svgDoc, element, tagName, elementId, computedStyle, localMatrix, layer, shapeBlur, doc, renderContext, textCursor, clipDepth, fromUse) {
  if (tagName == "text") textCursor = getPosition(element, textCursor);
  localMatrix = applyNestedViewBox(element, tagName, localMatrix);

  var childCount = element.children.length;
  var savedInheritedStyle = renderContext.inheritedStyle;
  var savedGroupBlur = renderContext.groupBlur;
      renderContext.inheritedStyle = computedStyle;
      renderContext.groupBlur = Math.max(renderContext.groupBlur, shapeBlur);

      var wrapInGroup = tagName != "text" && tagName != "textPath" || childCount > 1;
      if (wrapInGroup) {
        var groupVisible = layer.isVisible();
        layer.add.lsct = clipDepth < 2 && groupVisible && (elementId == null || !elementId.endsWith(":::")) ? LayerSectionType.OpenGroup : LayerSectionType.ClosedGroup;
        layer.blendMode = "pass";
    layer.layerFlags = GROUP_LAYER_FLAGS;
        layer.setVisible(groupVisible);
    doc.layers.push(doc.createGroupEndLayer());
  }
  processNodes(svgDoc, element.children, doc, localMatrix, renderContext, textCursor, clipDepth + 1, fromUse);
  if (wrapInGroup) {
    doc.layers.push(layer);
  } else {
        var lastLayer = doc.layers[doc.layers.length - 1];
        if (lastLayer) {
          lastLayer.Opct = layer.Opct;
      lastLayer.blendMode = layer.blendMode;
        }
      }
      renderContext.groupBlur = savedGroupBlur;
  renderContext.inheritedStyle = savedInheritedStyle;
}

/** Fold a nested `<svg>`/`<symbol>` viewBox into the local matrix. */
function applyNestedViewBox(element, tagName, localMatrix) {
  var nestedViewBox = element.getAttribute("viewBox");
  var nestedWidth = element.getAttribute("width");
  var nestedHeight = element.getAttribute("height");
  if (tagName == "svg" && nestedWidth && nestedHeight && nestedViewBox == null) nestedViewBox = "0 0 " + nestedWidth + " " + nestedHeight;
  if (!(nestedViewBox && (nestedWidth && nestedHeight || tagName == "symbol"))) return localMatrix;
  var nestedViewBoxParts = parseNumberList(nestedViewBox);
  var nestedPosition = getPosition(element);
  var nestedMatrix = new Matrix2D;
  nestedMatrix.translate(-nestedViewBoxParts[0], -nestedViewBoxParts[1]);
  if (nestedWidth && nestedHeight) nestedMatrix.scale(parseFloat(nestedWidth) / nestedViewBoxParts[2], parseFloat(nestedHeight) / nestedViewBoxParts[3]);
  nestedMatrix.translate(nestedPosition.tx, nestedPosition.ty);
  nestedMatrix.concat(localMatrix);
  return nestedMatrix;
}

/** Emit a `<use>` element by resolving and walking its target. */
function emitUse(svgDoc, element, computedStyle, localMatrix, doc, renderContext, textCursor, clipDepth) {
  var useMatrix = getPosition(element);
      useMatrix.concat(localMatrix);
  var useTarget = svgDoc.getElementById(getHref(element).slice(1));
  var savedInheritedStyle = renderContext.inheritedStyle;
      renderContext.inheritedStyle = computedStyle;
      if (useTarget) {
        if (computedStyle.filter) useTarget.setAttribute("filter", computedStyle.filter);
    processNodes(svgDoc, [useTarget], doc, useMatrix, renderContext, textCursor, clipDepth + 1, true);
  }
  renderContext.inheritedStyle = savedInheritedStyle;
}

/** Emit a vector shape element (path/rect/circle/…) as a shape layer. */
function emitShape(svgDoc, element, computedStyle, localMatrix, layer, shapeBlur, doc, renderContext) {
  layer.layerFlags |= VECTOR_LAYER_FLAG;
  layer.add.vmsk = new VectorMask;
  layer.add.vstk = LayerEffectDefs.getStrokeStyleDefault();
  layer.add.vstk.strokeEnabled.v = false;
  var vectorStroke = layer.add.vstk;
  var vectorMask = layer.add.vmsk;
  var fillPaint = computedStyle.fill;
  var emptyFill = fillPaint == "none" || computedStyle["fill-opacity"] && parseFloat(computedStyle["fill-opacity"]) == 0;
  var evenOddFill = computedStyle["fill-rule"] == "evenodd" ? 1 : 0;
  vectorMask.pathRecords = svgShapeToPath(svgDoc, element, evenOddFill == 1, emptyFill);
      vectorMask.evenOddFill = evenOddFill;
      transformPathRecordCoords(vectorMask.pathRecords, localMatrix);
  var pathBounds = boundsOfPathRecords(vectorMask.pathRecords);

  applyShapeStroke(svgDoc, computedStyle, localMatrix, pathBounds, emptyFill, layer, vectorStroke);
  vectorStroke.fillEnabled.v = !emptyFill;
  if (emptyFill) layer.add.SoCo = transparentSoCo();
  else applyShapeFill(svgDoc, fillPaint, localMatrix, pathBounds, layer);

  var featherBlur = Math.max(shapeBlur, renderContext.groupBlur);
  if (featherBlur != 0) vectorMask.feather = featherBlur;
  layer.updateVectorOrigins();
  layer.invalidate(doc);
  doc.layers.push(layer);
}

/** Configure the vector stroke style from an element's stroke properties. */
function applyShapeStroke(svgDoc, computedStyle, localMatrix, pathBounds, emptyFill, layer, vectorStroke) {
  var strokePaint = computedStyle.stroke;
  if (strokePaint == null || strokePaint == "none" || strokePaint == "null") return;
  var strokeWidthAttr = computedStyle["stroke-width"];
  var strokeDashAttr = computedStyle["stroke-dasharray"];
  var strokeJoinAttr = computedStyle["stroke-linejoin"] || "miter";
  var strokeCapAttr = computedStyle["stroke-linecap"] || "butt";
  var strokeMiterAttr = computedStyle["stroke-miterlimit"] == null ? 4 : parseFloat(computedStyle["stroke-miterlimit"]);
  var paintOrderAttr = computedStyle["paint-order"];
  var strokeOpacityFactor = computedStyle["stroke-opacity"] ? parseFloat(computedStyle["stroke-opacity"]) : 1;

  var strokePaintDesc = parsePaint(svgDoc, strokePaint, localMatrix, pathBounds);
  var strokeFillKind = FILL_DESCRIPTOR_KINDS.indexOf(strokePaintDesc.type);
  var strokeOpacityDesc = strokePaintDesc.desc.v.Opct.v;
  var strokeAlignment = 1;
        if (strokeOpacityDesc.val != 100 || strokeOpacityFactor != 1 && emptyFill) {
          layer.Opct = Math.round(strokeOpacityFactor * layer.Opct * strokeOpacityDesc.val / 100);
          strokeOpacityDesc.val = 100;
    strokeOpacityFactor = 1;
  }
  var strokeFieldKeys = LayerEffectDefs.fillPropertyKeyGroups[strokeFillKind];
  var strokeStyleContent = vectorStroke.strokeStyleContent.v = {
    classID: LayerEffectDefs.StrokeStyleDefs.fillLayerTypes[strokeFillKind],
  };
  for (var fieldIdx = 0; fieldIdx < strokeFieldKeys.length; fieldIdx++) {
    strokeStyleContent[strokeFieldKeys[fieldIdx]] = strokePaintDesc.desc.v[strokeFieldKeys[fieldIdx]];
  }
        strokeWidthAttr = strokeWidthAttr ? parseFloat(strokeWidthAttr) : 1;
        if (paintOrderAttr && paintOrderAttr.replace(/\s\s+/g, " ").slice(0, 11) == "stroke fill") {
          strokeAlignment = 2;
    strokeWidthAttr /= 2;
  }
  vectorStroke.strokeEnabled.v = true;
  vectorStroke.strokeStyleLineJoinType.v.strokeStyleLineJoinType = LayerEffectDefs.StrokeStyleDefs.join[LINE_JOIN_NAMES.indexOf(strokeJoinAttr)];
  vectorStroke.strokeStyleLineCapType.v.strokeStyleLineCapType = LayerEffectDefs.StrokeStyleDefs.lineCapTypes[LINE_CAP_NAMES.indexOf(strokeCapAttr)];
        vectorStroke.strokeStyleMiterLimit.v = strokeMiterAttr;
        vectorStroke.strokeStyleLineWidth.v.val = strokeWidthAttr * scaleIgnoringRotation(localMatrix);
        vectorStroke.strokeStyleLineAlignment.v.strokeStyleLineAlignment = LayerEffectDefs.StrokeStyleDefs.alignTypes[strokeAlignment];
        vectorStroke.strokeStyleOpacity.v.val = 100 * strokeOpacityFactor;
        if (strokeDashAttr != null && strokeDashAttr != "none") {
          var dashParts = strokeDashAttr.indexOf(",") != -1 ? strokeDashAttr.split(",") : strokeDashAttr.split(" ");
    vectorStroke.strokeStyleLineDashSet.v = LayerStyleRenderer.dashArrayToStrokeDescriptor(dashParts.map(parseFloat), 1 / strokeWidthAttr);
  }
  if (strokePaintDesc.fillTransform) layer.add._sstl = strokePaintDesc.fillTransform;
}

/** Attach a shape layer's fill descriptor (solid / gradient / pattern). */
function applyShapeFill(svgDoc, fillPaint, localMatrix, pathBounds, layer) {
  var fillPaintDesc = parsePaint(svgDoc, fillPaint, localMatrix, pathBounds);
  var fillAddKey = null;
  var fillFieldKeys = null;
        if (fillPaintDesc.type == "SoFi") {
          fillAddKey = "SoCo";
    fillFieldKeys = LayerEffectDefs.solidFillPropertyKeys;
        }
        if (fillPaintDesc.type == "GrFl") {
          fillAddKey = "GdFl";
    fillFieldKeys = LayerEffectDefs.gradientOverlayPropertyKeys;
        }
        if (fillPaintDesc.type == "patternFill") {
          fillAddKey = "PtFl";
    fillFieldKeys = LayerEffectDefs.patternOverlayPropertyKeys;
        }
  if (fillAddKey == null) return;
          var fillOpacityDesc = fillPaintDesc.desc.v.Opct.v;
          if (fillOpacityDesc.val != 100) {
            layer.Opct = Math.round(layer.Opct * fillOpacityDesc.val / 100);
    fillOpacityDesc.val = 100;
          }
  layer.add[fillAddKey] = { classID: "null" };
          for (var fillFieldIdx = 0; fillFieldIdx < fillFieldKeys.length; fillFieldIdx++) {
            var fillFieldKey = fillFieldKeys[fillFieldIdx];
    layer.add[fillAddKey][fillFieldKey] = fillPaintDesc.desc.v[fillFieldKey];
  }
  if (fillPaintDesc.fillTransform) layer.add._fstl = fillPaintDesc.fillTransform;
}

/**
 * Emit a `<text>`/`<tspan>` element as a text layer.
 * @returns {number} the updated horizontal text advance
 */
function emitText(element, tagName, elementId, computedStyle, localMatrix, textCursor, textAdvance, fontSize, layer, doc, renderContext) {
  var textMatrix = textCursor.clone();
      if (!(tagName == "tspan" && textCursor.tx != 0)) textMatrix.translate(textAdvance, 0);
      textMatrix.concat(localMatrix);
      if (element.children.length > 0) {
    var firstChildStyle = getStyleProps(element.children[0], renderContext.cssMap);
    for (var childStyleKey in firstChildStyle) {
      if (NON_INHERITED_STYLE_KEYS.indexOf(childStyleKey) == -1) computedStyle[childStyleKey] = firstChildStyle[childStyleKey];
    }
  }
  var textContent = element.textContent;
  if (computedStyle["xml:space"] == "preserve") textContent = textContent.replace(/\t/g, " ").replace(/\n/g, " ");
      if (elementId == null) layer.setName(textContent);
      layer.add.lnsr = "rend";
      layer.add.TySh = TextEngineData.createTextLayerData(0, 0);
      layer.add.TySh.boundsRect = new Rect(0, 0, 100, 100);
      layer.add.TySh.transform = textMatrix.clone();
      var engineData = layer.add.TySh.engineData;
      TextEngineData.insertText(engineData, 0, textContent);

  var baselineOffset = baselineOffsetFor(computedStyle["dominant-baseline"], fontSize);
      if (baselineOffset != 0) layer.add.TySh.transform.translate(0, baselineOffset);

      var textStyle = TextEngineData.getTextStyle(engineData, 0, 1);
  applyTextStyle(textStyle, computedStyle, fontSize);
  TextEngineData.applyStyle(engineData, 0, textContent.length, textStyle);

  var textStroke = computedStyle.stroke;
  if (textStroke != null && textStroke != "none") {
    var frameFx = LayerEffectDefs.getEffectDefault("FrFX");
    frameFx.Clr.v = toRGBDesc(CSS.parseCssColor(textStroke));
    frameFx.Sz.v.val = Math.round(parseFloat(computedStyle["stroke-width"]) * scaleIgnoringRotation(textMatrix));
    appendLayerEffect(layer, LayerEffectDefs.effectKeys[LayerEffectDefs.order.indexOf("FrFX")], frameFx);
  }
  if (tagName == "tspan") textAdvance += fontSize * textContent.length * .5 * scaleIgnoringRotation(textMatrix);
  doc.layers.push(layer);
  return textAdvance;
}

/** Baseline y-offset for a dominant-baseline value at a given font size. */
function baselineOffsetFor(dominantBaseline, fontSize) {
  if (dominantBaseline == "text-before-edge") return fontSize;
  if (dominantBaseline == "middle") return fontSize / 2;
  if (dominantBaseline == "hanging") return fontSize;
  return 0;
}

/** Populate a text style run from an element's font/fill/decoration props. */
function applyTextStyle(textStyle, computedStyle, fontSize) {
  var textFill = computedStyle.fill;
      if (textFill && textFill != "none") {
        var fillRgb = CSS.parseCssColor(textFill);
        textStyle.textStyle.FillColor = {
          Type: 1,
      Values: [1, fillRgb.h / 255, fillRgb.l / 255, fillRgb.O / 255],
    };
  }
  if (computedStyle["text-decoration"] == "underline") textStyle.textStyle.Underline = true;
  textStyle.textStyle.FontSize = Math.round(fontSize);
  var fontWeight = computedStyle["font-weight"];
      TextEngineData.setTextFont(textStyle, "LiberationSans");
      if (fontWeight == "bold") TextEngineData.setTextFont(textStyle, "LiberationSans-Bold");
  var fontFamily = computedStyle["font-family"];
      if (fontFamily) {
        fontFamily = fontFamily.split(",")[0].trim();
        if (fontFamily[0] == "\"") fontFamily = fontFamily.slice(1);
        if (fontFamily[fontFamily.length - 1] == "\"") fontFamily = fontFamily.slice(0, fontFamily.length - 1);
    var fontLookupKey = fontFamily + ":" + (fontWeight ? fontWeight : "normal");
    if (FONT_ALIAS_MAP[fontLookupKey]) TextEngineData.setTextFont(textStyle, FONT_ALIAS_MAP[fontLookupKey]);
    else TextEngineData.setTextFont(textStyle, fontFamily);
  }
  if (computedStyle["text-anchor"]) textStyle.paraStyle.Justification = TEXT_ANCHOR_NAMES.indexOf(computedStyle["text-anchor"]);
}

/** Emit an `<image>` element as a placed raster layer. */
function emitImage(doc, element, localMatrix, layer, renderContext) {
  var rasterLayer = createRasterImageLayer(doc, element, localMatrix);
  if (!rasterLayer) return;
        rasterLayer.setName(layer.getName());
        rasterLayer.layerFlags = layer.layerFlags;
  doc.layers.push(rasterLayer);
        if (renderContext.luminanceMask) {
    rasterLayer.d = renderContext.luminanceMask;
    renderContext.luminanceMask = null;
  }
}

/** Convert an SVG shape element into path records (or resolve a `use` ref). */
function svgShapeToPath(svgDoc, element, evenOdd, emptyFill) {
  var pathRecords = [{ type: 6 }, { type: 8, all: 0 }];
  var tagName = getTagName(element);
  if (tagName == "use") {
    var useTarget = svgDoc.getElementById(getHref(element).slice(1));
    var useMatrix = getTagName(useTarget) != "rect" ? getPosition(useTarget) : new Matrix2D;
    useMatrix.concat(getElementTransform(useTarget));
    pathRecords = svgShapeToPath(svgDoc, useTarget, evenOdd, emptyFill);
    transformPathRecordCoords(pathRecords, useMatrix);
  } else if (tagName == "path") {
    var pathData = element.getAttribute("d");
    if (pathData == null) return pathRecords;
    var typrPath = Typr.U.SVGToPath(pathData);
    pathRecords = buildCanvasPathRecords({ H: typrPath.crds, K: typrPath.cmds }, evenOdd, emptyFill);
  } else if (tagName == "rect") {
    var cornerRadius = element.getAttribute("rx");
    var position = getPosition(element);
    pathRecords = rectanglePathRecords(position.tx, position.ty, parseFloat(element.getAttribute("width")), parseFloat(element.getAttribute("height")), cornerRadius ? parseFloat(cornerRadius) : 0);
  } else if (tagName == "circle" || tagName == "ellipse") {
    var radii = [0, 0, 0, 0];
    var radiusAttrs = ["cx", "cy", "rx", "ry", "r"];
    for (var attrIdx = 0; attrIdx < 5; attrIdx++) {
      var attrVal = element.getAttribute(radiusAttrs[attrIdx]);
      if (attrVal) {
        attrVal = parseFloat(attrVal);
        if (attrIdx < 4) radii[attrIdx] = attrVal;
        else radii[2] = radii[3] = attrVal;
      }
    }
    pathRecords = ellipsePathRecords(radii[0] - radii[2], radii[1] - radii[3], 2 * radii[2], 2 * radii[3]);
  } else if (tagName == "polygon" || tagName == "polyline" || tagName == "line") {
    var flatCoords;
    var pointsAttr = element.getAttribute("points");
    if (tagName == "line") flatCoords = [element.getAttribute("x1"), element.getAttribute("y1"), element.getAttribute("x2"), element.getAttribute("y2")].map(parseFloat);
    else flatCoords = pointsAttr ? pointsAttr.trim().replace(/\s\s+/g, " ").split(",").join(" ").split(" ").map(parseFloat) : [];
    pathRecords = polygonFromFlatCoords(flatCoords, 0, tagName != "polygon");
  }
  return pathRecords;
}

/** Resolve an SVG length (em / m units scale by `defaultSize`) to pixels. */
function parseLength(lengthText, defaultSize) {
  if (lengthText.endsWith("em")) return defaultSize * parseFloat(lengthText.slice(0, lengthText.length - 2));
  if (lengthText.charAt(lengthText.length - 1) == "m") return defaultSize * parseFloat(lengthText.slice(0, lengthText.length - 2));
  return parseFloat(lengthText);
}

/** Whether a clip def is a luminance mask wrapping mask > g > g > image. */
function isLuminanceMaskClip(clipDef) {
  if (getTagName(clipDef) != "mask") return false;
  var maskChildren = clipDef.children;
  if (!maskChildren[0] || getTagName(maskChildren[0]) != "g") return false;
  var innerGroup = maskChildren[0].children[0];
  if (!innerGroup || getTagName(innerGroup) != "g") return false;
  var imageEl = innerGroup.children[0];
  return imageEl && getTagName(imageEl) == "image";
}

/** Build a placed smart-object layer from a data-URL `<image>` element. */
function createRasterImageLayer(doc, element, matrix) {
  var imageHref = getHref(element);
  if (!imageHref || imageHref.slice(0, 4) != "data") return null;
  var imageBytes = FileFormatRegistry.parseDataUrlToBytes(imageHref);
  var rasterLayer = doc.createSmartObjectLayer(imageBytes, "hey", 0, 0);
  var placedRect = rasterLayer.rect.clone();
  placedRect.x = placedRect.y = 0;
  var imageWidthAttr = element.getAttribute("width");
  var imageHeightAttr = element.getAttribute("height");
  if (imageWidthAttr) placedRect.width = parseFloat(imageWidthAttr);
  if (imageHeightAttr) placedRect.height = parseFloat(imageHeightAttr);
  var imageMatrix = getPosition(element);
  imageMatrix.concat(matrix);
  var outlineCoords = rectToPathOutline(placedRect).coords;
  transformCoordPairs(outlineCoords, imageMatrix, outlineCoords);
  rasterLayer.add.placedData.Trnf = packDoublesList(outlineCoords);
  rasterLayer.add.placedData.nonAffineTransform = packDoublesList(outlineCoords);
  rasterLayer.rasterizeSmartObject(doc, false);
  return rasterLayer;
}

/** Append a layer effect descriptor under the given effect-list key. */
function appendLayerEffect(layer, effectListKey, effectDesc) {
  var layerEffects = layer.add.lmfx;
  if (layerEffects == null) {
    layerEffects = LayerEffectDefs.createLmfxRootTemplate();
    for (var effectIdx = 0; effectIdx < LayerEffectDefs.order.length; effectIdx++) {
      layerEffects[LayerEffectDefs.effectKeys[effectIdx]] = { t: "VlLs", v: [] };
    }
    layer.add.lmfx = layerEffects;
  }
  layerEffects[effectListKey].v.push({ t: "Objc", v: effectDesc });
}

/**
 * Parse an SVG filter definition (blur / drop / inner shadow) into a shadow
 * effect descriptor and/or feather blur amount.
 */
function parseFilterDef(svgDoc, filterCssValue, matrixScale) {
  var result = { blurAmount: 0, shadowDesc: null, effectListKey: null };
  var filterEl = svgDoc.getElementById(filterCssValue.slice(5, filterCssValue.length - 1));
  if (!filterEl) return result;
  var hasBlur = false;
  var hasComposite = false;
  var hasOffset = false;
  var blurSigma = 0;
  var offsetDx = 0;
  var offsetDy = 0;
  var shadowColor = [0, 0, 0, .5];
  for (var childIdx = 0; childIdx < filterEl.children.length; childIdx++) {
    var filterPrimitive = filterEl.children[childIdx];
    var primitiveTag = getTagName(filterPrimitive);
    if (primitiveTag == "feGaussianBlur") {
      hasBlur = true;
      blurSigma = parseFloat(filterPrimitive.getAttribute("stdDeviation")) * matrixScale;
    } else if (primitiveTag == "feColorMatrix") {
      var matrixValues = filterPrimitive.getAttribute("values");
      if (matrixValues) {
        matrixValues = matrixValues.split(" ").map(parseFloat);
        shadowColor = [matrixValues[4], matrixValues[9], matrixValues[14], matrixValues[18]];
      }
    } else if (primitiveTag == "feComposite") {
      hasComposite = true;
    } else if (primitiveTag == "feOffset") {
      hasOffset = true;
      offsetDx = parseFloat(filterPrimitive.getAttribute("dx") || 0) * matrixScale;
      offsetDy = parseFloat(filterPrimitive.getAttribute("dy") || 0) * matrixScale;
    }
  }
  if (hasBlur && (hasComposite || hasOffset)) {
    var orderKey = hasComposite ? "IrSh" : "DrSh";
    var shadowDesc = LayerEffectDefs.getEffectDefault(orderKey);
    shadowDesc.blur.v.val = Math.round(blurSigma * 2.4);
    var offsetDist = Math.sqrt(offsetDx * offsetDx + offsetDy * offsetDy);
    shadowDesc.uglg.v = false;
    shadowDesc.Dstn.v.val = Math.round(offsetDist);
    shadowDesc.lagl.v.val = Math.round(Math.atan2(offsetDy, -offsetDx) * (180 / Math.PI));
    shadowDesc.Clr.v = toRGBDesc({
      h: shadowColor[0] * 255,
      l: shadowColor[1] * 255,
      O: shadowColor[2] * 255,
    });
    shadowDesc.Opct.v.val = Math.round(shadowColor[3] * 100);
    result.shadowDesc = shadowDesc;
    result.effectListKey = LayerEffectDefs.effectKeys[LayerEffectDefs.order.indexOf(orderKey)];
  } else if (hasBlur) {
    result.blurAmount = blurSigma;
  }
  return result;
}

/**
 * Parse an SVG paint value (color, url(#gradient), rgb/hsl function) into a
 * fill descriptor. Returns { type, desc, fillTransform }.
 */
function parsePaint(svgDoc, paintSpec, nodeMatrix, shapeBounds) {
  var paintType;
  var paintDesc;
  var fillTransform = null;
  var solidFillDefault = LayerEffectDefs.getEffectDefault("SoFi");
  var parenIndex = paintSpec != null ? paintSpec.indexOf("(") : -1;
  if (parenIndex != -1) {
    var funcName = paintSpec.slice(0, parenIndex).trim();
    var funcArg = paintSpec.slice(parenIndex + 1, paintSpec.indexOf(")")).trim();
    if (funcArg.charAt(0) == "'") funcArg = funcArg.slice(1, funcArg.length - 1);
    if (funcName == "url") {
      if (funcArg.charAt(0) == "#") {
        var gradientEl = svgDoc.getElementById(funcArg.slice(1));
        if (gradientEl && getTagName(gradientEl).toLowerCase().endsWith("gradient")) {
          var gradientResult = parseDescriptor(svgDoc, gradientEl, nodeMatrix, shapeBounds);
          paintType = "GrFl";
          paintDesc = { t: "Objc", v: gradientResult.desc };
          fillTransform = gradientResult.fillTransform;
        } else {
          paintType = "SoFi";
          paintDesc = { t: "Objc", v: solidFillDefault };
          }
      } else {
        console.log("unknown url", funcArg);
        }
    } else if (funcName == "rgb" || funcName == "rgba" || funcName == "hsl" || funcName == "hsla") {
      paintType = "SoFi";
      paintDesc = { t: "Objc", v: solidFillDefault };
      paintDesc.v.Clr.v = toRGBDesc(CSS.parseCssColor(paintSpec));
      if (funcName == "rgba" || funcName == "hsla") paintDesc.v.Opct.v.val = Math.round(100 * parseFloat(paintSpec.split(",").pop()));
    } else {
      console.log("unknown fill", paintSpec);
    }
  } else {
    paintType = "SoFi";
    paintDesc = { t: "Objc", v: solidFillDefault };
    var solidRgb = CSS.parseCssColor(paintSpec);
    paintDesc.v.Clr.v = toRGBDesc(solidRgb);
    if (solidRgb.AW != null) paintDesc.v.Opct.v.val = Math.round(100 * solidRgb.AW / 255);
  }
  return { type: paintType, desc: paintDesc, fillTransform: fillTransform };
}

/** Combined transform from an element's `transform` attribute and style. */
function getElementTransform(element) {
  var transformAttr = element.getAttribute("transform");
  var matrix = transformAttr ? parseTransform(transformAttr) : new Matrix2D;
  var styleAttr = element.getAttribute("style");
  if (styleAttr != null) {
    var styleProps = {};
    applyStyleString(styleProps, styleAttr, ["transform"]);
    if (styleProps.transform) matrix.concat(parseTransform(styleProps.transform));
  }
  return matrix;
}

/** Position matrix from x/y attributes, falling back to a previous cursor. */
function getPosition(element, prevCursor) {
  var positionMatrix = new Matrix2D;
  var xAttr = element.getAttribute("x");
  var yAttr = element.getAttribute("y");
  if (xAttr) positionMatrix.tx = parseFloat(xAttr);
  else if (prevCursor) positionMatrix.tx = prevCursor.tx;
  if (yAttr) positionMatrix.ty = parseFloat(yAttr);
  else if (prevCursor) positionMatrix.ty = prevCursor.ty;
  return positionMatrix;
}

/** Parse an SVG transform string into a Matrix2D. */
function parseTransform(transformText) {
  var t = Typr.U.SVG.readTrnf(transformText);
  return new Matrix2D(t[0], t[1], t[2], t[3], t[4], t[5]);
}

/**
 * Collect style properties for an element from presentation attributes, class
 * and id CSS rules, and inline style, in increasing precedence.
 */
function getStyleProps(element, cssMap) {
  var styleProps = {};
  for (var nameIdx = 0; nameIdx < STYLE_ATTR_NAMES.length; nameIdx++) {
    var attrValue = element.getAttribute(STYLE_ATTR_NAMES[nameIdx]);
    if (attrValue != null && attrValue != "inherit") styleProps[STYLE_ATTR_NAMES[nameIdx]] = attrValue;
  }
  var classAttr = element.getAttribute("class");
  if (cssMap != null && classAttr != null && cssMap["." + classAttr] != null) applyStyleString(styleProps, cssMap["." + classAttr], STYLE_ATTR_NAMES);
  var idAttr = element.getAttribute("id");
  if (cssMap != null && idAttr != null && cssMap["#" + idAttr] != null) applyStyleString(styleProps, cssMap["#" + idAttr], STYLE_ATTR_NAMES);
  var inlineStyle = element.getAttribute("style");
  if (inlineStyle != null) applyStyleString(styleProps, inlineStyle, STYLE_ATTR_NAMES);
  return styleProps;
}

/** Merge `prop: value;` declarations from a style string into `target`. */
function applyStyleString(target, styleText, allowedKeys) {
  var declarations = styleText.trim().split(";");
  for (var declIdx = 0; declIdx < declarations.length; declIdx++) {
    var declParts = declarations[declIdx].split(":");
    var propName = declParts[0] ? declParts[0].trim() : "";
    var propValue = declParts[1] ? declParts[1].trim() : "";
    for (var keyIdx = 0; keyIdx < allowedKeys.length; keyIdx++) {
      if (propName == allowedKeys[keyIdx] && propValue != "inherit") target[allowedKeys[keyIdx]] = propValue;
    }
  }
}

/** Resolve an element's href (xlink:href or href). */
function getHref(element) {
  var href = element.getAttribute("xlink:href");
  if (href == null) href = element.getAttribute("href");
  return href;
}

/**
 * Parse an SVG linear/radial gradient element into a gradient fill descriptor,
 * resolving stops (or following an xlink:href to a linked gradient).
 */
function parseDescriptor(svgDoc, gradientElement, nodeMatrix, shapeBounds) {
  var gradTransformAttr = gradientElement.getAttribute("gradientTransform");
  var gradMatrix = gradTransformAttr ? parseTransform(gradTransformAttr) : new Matrix2D;
  gradMatrix.concat(nodeMatrix);
  var gradDesc = LayerEffectDefs.getEffectDefault("GrFl");
  var gradPayload = gradDesc.Grad.v;
  gradPayload.Intr.v = 0;
  var gradTagName = getTagName(gradientElement);
  var startPoint = new Point(0, 0);
  var endPoint = new Point(shapeBounds.width, 0);
  if (gradTagName == "linearGradient") {
    gradDesc.Type.v.GrdT = "Lnr";
    if (gradientElement.getAttribute("x1")) startPoint.x = parseFloat(gradientElement.getAttribute("x1"));
    if (gradientElement.getAttribute("y1")) startPoint.y = parseFloat(gradientElement.getAttribute("y1"));
    if (gradientElement.getAttribute("x2")) endPoint.x = parseFloat(gradientElement.getAttribute("x2"));
    if (gradientElement.getAttribute("y2")) endPoint.y = parseFloat(gradientElement.getAttribute("y2"));
    startPoint.x = endPoint.x + .5 * (startPoint.x - endPoint.x);
    startPoint.y = endPoint.y + .5 * (startPoint.y - endPoint.y);
  }
  if (gradTagName == "radialGradient") {
    gradDesc.Type.v.GrdT = "Rdl";
    if (gradientElement.getAttribute("cx")) startPoint.x = parseFloat(gradientElement.getAttribute("cx"));
    if (gradientElement.getAttribute("cy")) startPoint.y = parseFloat(gradientElement.getAttribute("cy"));
    endPoint.setXY(startPoint.x, startPoint.y);
    if (gradientElement.getAttribute("r")) endPoint.x += parseFloat(gradientElement.getAttribute("r"));
  }
  if (gradientElement.getAttribute("gradientUnits") == "userSpaceOnUse") {
    startPoint = gradMatrix.transformPoint(startPoint);
    endPoint = gradMatrix.transformPoint(endPoint);
  } else {
    startPoint.x = shapeBounds.x + startPoint.x * shapeBounds.width;
    startPoint.y = shapeBounds.y + startPoint.y * shapeBounds.height;
    endPoint.x = shapeBounds.x + endPoint.x * shapeBounds.width;
    endPoint.y = shapeBounds.y + endPoint.y * shapeBounds.height;
  }
  gradientAngleFromPoints(startPoint, endPoint, shapeBounds, gradDesc);
  var stopNodes = gradientElement.children;
  if (stopNodes.length == 0) {
    var xlinkHref = getHref(gradientElement);
    if (xlinkHref == null) throw "gradient has no stops";
    var linkedGradEl = svgDoc.getElementById(xlinkHref.slice(1));
    if (linkedGradEl == null) {
      console.log(xlinkHref.slice(1));
      throw "svg: linked gradient not found";
    }
    gradDesc.Grad = parseDescriptor(svgDoc, linkedGradEl, gradMatrix, shapeBounds).desc.Grad;
  } else {
    var cssStops = [];
    for (var stopIdx = 0; stopIdx < stopNodes.length; stopIdx++) {
      var stopEl = stopNodes[stopIdx];
      var stopStyle = getStyleProps(stopEl);
      var stopColor = stopStyle["stop-color"] == null ? "#000000" : stopStyle["stop-color"];
      var stopOpacity = stopStyle["stop-opacity"] == null ? "1" : stopStyle["stop-opacity"];
      var offsetAttr = stopEl.getAttribute("offset");
      var offsetVal = offsetAttr ? parseFloat(offsetAttr) : 0;
      if (offsetAttr && offsetAttr.endsWith("%")) offsetVal /= 100;
      stopColor = CSS.parseCssColor(stopColor);
      cssStops.push([offsetVal, [stopColor.h / 255, stopColor.l / 255, stopColor.O / 255], parseFloat(stopOpacity)]);
    }
    cssStopsToGradientDesc(cssStops, gradPayload);
  }
  return { desc: gradDesc, fillTransform: gradMatrix };
}

// ---------------------------------------------------------------------------
// Export: document layers → SVG markup
// ---------------------------------------------------------------------------

/** Indentation unit for pretty-printed export ("\t" when pretty, else ""). */
let indentUnit = "";
/** Optional debug sink for exported path shapes; null disables the dump. */
let pathShapeDebugLog = null;

/**
 * Serialize a document to an SVG byte buffer.
 * @returns {ArrayBuffer}
 */
function exportSvg(doc, exportOptions, fontList) {
  var svgLines = [];
  indentUnit = exportOptions.prettyPrint ? "\t" : "";
  svgLines.push("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 " + doc.width + " " + doc.height + "\" width=\"" + exportOptions.exportWidth + "\" height=\"" + exportOptions.exportHeight + "\">");
  var exportState = {
    defsFragments: [],
    children: [],
    gradientCounter: 0,
    filterCounter: 0,
    clipPathCounter: 0,
    featherFilterMap: {},
    placedImageIdMap: {},
    imageDefCounter: 0,
    classStyleMap: {},
    styleKeyToClass: {},
    styleClassSeq: 0,
    fontNames: [],
  };
  serializeNodes(doc, exportState, doc.root.children, 1, exportOptions, fontList);
  if (exportState.defsFragments.length != 0) {
    svgLines.push(indent(1) + "<defs>");
    svgLines = svgLines.concat(exportState.defsFragments);
    svgLines.push(indent(1) + "</defs>");
  }
  svgLines.push(indent(1) + "<style>");
  svgLines.push(indent(2) + "tspan { white-space:pre }");
  for (var className in exportState.classStyleMap) svgLines.push(indent(2) + "." + className + " { " + exportState.classStyleMap[className] + " } ");
  svgLines.push(indent(1) + "</style>");
  svgLines = svgLines.concat(exportState.children);
  svgLines.push("</svg>");
  svgLines = svgLines.join(exportOptions.prettyPrint ? "\n" : "");
  var outBuffer = allocBuffer(Math.round(svgLines.length * 1.5));
  var byteLength = BinaryUtils.encodeUtf8Into(svgLines, outBuffer, 0);
  if (pathShapeDebugLog) dumpPathShapeDebugLog();
  return outBuffer.buffer.slice(0, byteLength);
}

/** Console-dump the collected path-shape debug entries. */
function dumpPathShapeDebugLog() {
  console.log(pathShapeDebugLog);
    var debugDump = "SVGParser.gen.db = [\n";
  for (var dumpIdx = 0; dumpIdx < pathShapeDebugLog.length; dumpIdx++) {
    var dumpEntry = pathShapeDebugLog[dumpIdx];
      debugDump += "{\n\tnam: \"" + dumpEntry.nameKey + "\",\n\tpts: [\n";
      for (var ptIdx = 0; ptIdx < dumpEntry.pathParts.length; ptIdx++) {
        var ptEntry = dumpEntry.pathParts[ptIdx];
      debugDump += "\t\t[\"" + ptEntry[0] + "\", { commands: " + JSON.stringify(ptEntry[1].commands) + ", coords:" + JSON.stringify(ptEntry[1].coords) + " } ]" + (ptIdx == dumpEntry.pathParts.length - 1 ? "" : ",") + "\n";
      }
    debugDump += "\t]\n}" + (dumpIdx == pathShapeDebugLog.length - 1 ? "" : ",") + "\n";
    }
    debugDump += "]\n";
  console.log(debugDump);
}

/** Indentation string for a given depth. */
function indent(depth) {
  var padding = "";
  for (var levelIdx = 0; levelIdx < depth; levelIdx++) padding += indentUnit;
  return padding;
}

/** Format a number for SVG output, trimming to 3 decimal places. */
function formatNumber(value) {
  return "" + parseFloat(value.toFixed(3));
}

/**
 * Serialize a list of layer nodes into SVG elements (groups, shapes, text,
 * images) under `exportState`.
 */
function serializeNodes(doc, exportState, layerNodes, indentDepth, exportOptions, fontList) {
  for (var nodeIdx = 0; nodeIdx < layerNodes.length; nodeIdx++) {
    var node = layerNodes[nodeIdx];
    var layer = node.layer;
    var vectorMask = layer.add.vmsk;
    var vectorStroke = layer.add.vstk;
    var textShape = layer.add.TySh;
    if (vectorMask && !vectorMask.isEnabled) vectorMask = vectorStroke = null;
    if (!exportOptions.hidden && !layer.isVisible()) continue;

    var inlineStyleParts = layerInlineStyle(layer);
    var attrParts = [];
    var classNames = [];
    var layerName = layer.getName();
    var nameDotIndex = layerName.indexOf(" .");
    if (nameDotIndex != -1) {
      classNames.push(layerName.slice(nameDotIndex + 2));
      layerName = layerName.slice(0, nameDotIndex);
    }
    if (exportOptions.names) attrParts.push("id=\"" + escapeXml(layerName) + "\"");
    var solidFill = enabledSolidFill(layer);

    var render = { layer: layer, node: node, vectorMask: vectorMask, vectorStroke: vectorStroke, textShape: textShape, inlineStyleParts: inlineStyleParts, attrParts: attrParts, classNames: classNames, solidFill: solidFill };
    if (layer.isGroup()) {
      serializeGroup(doc, exportState, render, indentDepth, exportOptions, fontList);
    } else if (layer.hasFillContent() && vectorMask == null) {
      serializeFullFillRect(doc, exportState, render, indentDepth);
    } else if (vectorMask && layer.add.placedData == null) {
      serializeVectorPath(doc, exportState, render, indentDepth);
    } else if (textShape && exportOptions.textAsPaths) {
      serializeTextAsPaths(exportState, render, indentDepth, fontList);
    } else if (textShape && exportOptions.textAsElements) {
      serializeTextAsElements(exportState, render, indentDepth);
    } else if (layer.add.placedData && exportOptions.embedRasterLayers) {
      if (!serializePlacedImage(doc, exportState, render, indentDepth, fontList)) return;
    } else if (!layer.rect.isEmpty() && (exportOptions.embedRasterLayers || textShape)) {
      serializeRasterImage(exportState, render, indentDepth);
    }
  }
}

/** Inline style declarations (opacity, fill-opacity, blend, display) for a layer. */
function layerInlineStyle(layer) {
  var inlineStyleParts = [];
  var layerOpacity = layer.Opct / 255;
  var fillOpacity = layer.add.iOpa ? layer.add.iOpa / 255 : 1;
  if (layerOpacity != 1) inlineStyleParts.push("opacity: " + formatNumber(layerOpacity));
  if (fillOpacity != 1) inlineStyleParts.push("fill-opacity: " + formatNumber(fillOpacity));
    if (layer.blendMode != "norm") {
      var blendModeCss = BlendModes.cssNames[BlendModes.psdCodes.indexOf(layer.blendMode)];
    if (blendModeCss != null) inlineStyleParts.push("mix-blend-mode: " + blendModeCss);
    }
    if (!layer.isVisible()) inlineStyleParts.push("display: none");
  return inlineStyleParts;
}

/** The layer's enabled solid-fill effect descriptor, or null. */
function enabledSolidFill(layer) {
    var solidFill = layer.add.lmfx;
    if (solidFill) solidFill = solidFill.solidFillMulti.v[0];
    if (solidFill) solidFill = solidFill.v;
    if (solidFill && !solidFill.enab.v) solidFill = null;
  return solidFill;
}

/** Push the `style="…"` attribute when there are inline style declarations. */
function pushInlineStyleAttr(render) {
  if (render.inlineStyleParts.length != 0) render.attrParts.push("style=\"" + render.inlineStyleParts.join(";") + "\"");
}

/** Intern an inline-style string as a CSS class, returning the class id. */
function classForStyle(exportState, styleKey, prefix) {
  var classId = exportState.styleKeyToClass[styleKey];
  if (classId == null) {
    classId = prefix + exportState.styleClassSeq;
          exportState.styleClassSeq++;
    exportState.styleKeyToClass[styleKey] = classId;
    exportState.classStyleMap[classId] = styleKey;
  }
  return classId;
}

/** Serialize a group layer as an `<g>` wrapping its serialized children. */
function serializeGroup(doc, exportState, render, indentDepth, exportOptions, fontList) {
  var childNodes = render.node.children;
  if (childNodes.length == 1 && childNodes[0].layer.add.placedData && !exportOptions.embedRasterLayers) return;
  if (pathShapeDebugLog && render.layer.getName().split("-").length == 3) {
    pathShapeDebugLog.push({ nameKey: render.layer.getName(), pathByteSize: 0, pathParts: [] });
  }
  appendClipPath(render.layer, render.vectorMask, exportState, render.attrParts);
  pushInlineStyleAttr(render);
  exportState.children.push(indent(indentDepth) + "<g " + buildAttrString(render.attrParts, render.classNames) + ">");
  serializeNodes(doc, exportState, childNodes, indentDepth + 1, exportOptions, fontList);
  exportState.children.push(indent(indentDepth) + "</g>");
}

/** Serialize a document-spanning fill layer as a full-canvas `<rect>`. */
function serializeFullFillRect(doc, exportState, render, indentDepth) {
  var shapeBounds = new Rect(0, 0, doc.width, doc.height);
  appendStyleAttrs(render.inlineStyleParts, render.layer.add, exportState, shapeBounds);
  pushInlineStyleAttr(render);
  exportState.children.push(indent(indentDepth) + "<rect width=\"" + doc.width + "\" height=\"" + doc.height + "\" " + buildAttrString(render.attrParts, render.classNames) + " />");
}

/** Serialize a vector-mask layer as a `<path>`. */
function serializeVectorPath(doc, exportState, render, indentDepth) {
  var shapeBounds = boundsOfPathRecords(render.vectorMask.pathRecords, null, true);
  var pathExport = exportPathRecordsToSvg(render.vectorMask.pathRecords);
  if (pathExport.evenOddFill != 0) render.attrParts.push("fill-rule=\"evenodd\"");
  appendStyleAttrs(render.inlineStyleParts, render.layer.add, exportState, shapeBounds);
  if (render.inlineStyleParts.length != 0) {
    render.classNames.push(classForStyle(exportState, render.inlineStyleParts.join(";"), "shp"));
  }
  exportState.children.push(indent(indentDepth) + "<path " + buildAttrString(render.attrParts, render.classNames) + " d=\"" + pathExport.pathSvg + "\" />");
  if (pathShapeDebugLog && pathShapeDebugLog[pathShapeDebugLog.length - 1]) {
    var flatPath = flattenPathRecordsToPath(render.vectorMask.pathRecords);
        flatPath.coords = flatPath.coords.map(Math.round);
    var debugEntry = pathShapeDebugLog[pathShapeDebugLog.length - 1];
        debugEntry.pathByteSize += JSON.stringify(flatPath).length;
    debugEntry.pathParts.push([render.inlineStyleParts[0].split("#").pop(), flatPath]);
  }
}

/** Serialize a text layer as color-split vector `<path>` elements. */
function serializeTextAsPaths(exportState, render, indentDepth, fontList) {
  var engineData = render.textShape.engineData;
  var curveData = new TextLayout(engineData, fontList);
  if (render.solidFill) render.attrParts.push("fill=\"" + CSS.psdColorToCss(render.solidFill.Clr.v) + "\"");
  var textPaths = TextRenderer.buildTextPaths(curveData, render.textShape);
  var pathsByColor = splitPathBySubpathId(textPaths);
      for (var fillColor in pathsByColor) {
    if (render.solidFill == null) render.attrParts.push("fill=\"" + fillColor + "\"");
    var subpathSvg = Typr.U.pathToSVG(toTyprPath(pathsByColor[fillColor]), 2);
    exportState.children.push(indent(indentDepth) + "<path " + buildAttrString(render.attrParts, render.classNames) + " d=\"" + subpathSvg + "\" />");
    if (render.solidFill == null) render.attrParts.pop();
  }
}

/** Serialize a text layer as a `<text>` element with per-run `<tspan>`s. */
function serializeTextAsElements(exportState, render, indentDepth) {
  var engineData = render.textShape.engineData;
  var textMatrix = render.textShape.transform.clone();
      if (TextEngineData.getTextType(engineData) == 1) {
    var justification = TextEngineData.getTextStyle(engineData, 0, 0).paraStyle.Justification;
    var boxWidth = TextEngineData.getBoxBounds(engineData)[2];
    var justifyOffset = 0;
        if (justification == 2) justifyOffset = boxWidth / 2;
        if (justification == 1) justifyOffset = boxWidth;
    textMatrix.translate(justifyOffset, 0);
  }
  render.inlineStyleParts.push("transform: " + matrixToTransformAttr(textMatrix));
  var layerText = TextEngineData.getLayerText(engineData);
  var paragraphRun = engineData.EngineDict.ParagraphRun;
  var runArray = paragraphRun.RunArray;
  var runLengths = paragraphRun.RunLengthArray;
  pushInlineStyleAttr(render);
  exportState.children.push(indent(indentDepth) + "<text " + buildAttrString(render.attrParts, render.classNames) + " >");
  var frameFx = render.layer.add.lmfx;
      if (frameFx) frameFx = frameFx.frameFXMulti.v[0];
      if (frameFx) frameFx = frameFx.v;
  var defaultFillColor = render.solidFill ? CSS.psdColorToCss(render.solidFill.Clr.v) : null;
  var textOffset = 0;
  var tspanY = 0;
      for (var runIdx = 0; runIdx < runArray.length; runIdx++) {
    var runLength = runLengths[runIdx];
    var runText = layerText.slice(textOffset, textOffset + runLength - 1);
    var runStyle = TextEngineData.getTextStyle(engineData, textOffset, textOffset);
    var fontName = runStyle.fontSet[runStyle.textStyle.Font].Name;
        if (exportState.fontNames.indexOf(fontName) == -1) exportState.fontNames.push(fontName);
    var tspanStyleParts = [];
    CSS.appendTextStyleRules(tspanStyleParts, runStyle, render.textShape.transform, true, true, defaultFillColor);
        if (frameFx) {
      render.inlineStyleParts.push("stroke: " + CSS.psdColorToCss(frameFx.Clr.v));
      render.inlineStyleParts.push("stroke-width: " + frameFx.Sz.v.val);
        }
        var lineAdvance = runStyle.textStyle.FontSize * 1.12;
        if (runIdx == 0) lineAdvance = TextEngineData.getTextType(engineData) == 0 ? 0 : runStyle.textStyle.FontSize;
        tspanY += lineAdvance;
        if (runText != "") {
      var tspanClassId = classForStyle(exportState, tspanStyleParts.join(";"), "txt");
      var trackingAttr = "";
          var tracking = runStyle.textStyle.Tracking;
          if (tracking != null && tracking != 0) {
            tracking = Math.round(tracking * runStyle.textStyle.FontSize / 1e3);
            trackingAttr = " dx=\"0";
            for (var charIdx = 1; charIdx < runText.length; charIdx++) trackingAttr += " " + tracking;
        trackingAttr += "\" ";
      }
      exportState.children.push(indent(indentDepth + 1) + "<tspan x=\"0\" y=\"" + formatNumber(tspanY) + "\" class=\"" + tspanClassId + "\"" + trackingAttr + ">" + escapeXml(runText) + "</tspan>");
    }
    textOffset += runLength;
  }
  exportState.children.push(indent(indentDepth) + "</text>");
}

/**
 * Serialize a placed (linked) raster/vector layer as a `<use>` of an embedded
 * `<image>`. Returns false when the linked raster can't be resolved (aborting
 * the enclosing serialize pass, matching the original control flow).
 */
function serializePlacedImage(doc, exportState, render, indentDepth, fontList) {
  var placedData = render.layer.add.placedData;
  var placedId = placedData.Idnt.v;
  var cropMode = placedData.Crop ? placedData.Crop.v : null;
  var imageDefId = exportState.placedImageIdMap[placedId];
  if (imageDefId == null) {
        exportState.imageDefCounter++;
        imageDefId = exportState.imageDefCounter;
        exportState.placedImageIdMap[placedId] = exportState.imageDefCounter;
    var linkedRaster = doc.resolveLinkedItemRaster(placedId, cropMode);
    if (linkedRaster == null) return false;
    var rasterFrames = linkedRaster.rasterCache;
    var linkedFormat = FileFormatRegistry.detectFormat(linkedRaster.raw.buffer);
    var dataUrl;
        if (linkedFormat == "pdf") {
      dataUrl = "data:image/svg+xml;base64," + FileFormatRegistry.bytesToBase64(renderPlacedPdfToSvg(placedData, linkedRaster, fontList));
        } else if (linkedFormat == "jpg" || linkedFormat == "png" || linkedFormat == "gif" || linkedFormat == "svg") {
          var mimeByFormat = {
            jpg: "image/jpg",
            png: "image/png",
            jpg: "image/jpg",
        splacedImageIdMap: "image/svg+xml",
          };
      dataUrl = "data:" + mimeByFormat[linkedFormat] + ";base64," + FileFormatRegistry.bytesToBase64(linkedRaster.raw.buffer);
        } else {
      dataUrl = FileFormatRegistry.bufferToDataUrl(rasterFrames[0].buffer, rasterFrames[1].width, rasterFrames[1].height);
    }
    exportState.defsFragments.push(indent(2) + "<image width=\"" + rasterFrames[1].width + "\" height=\"" + rasterFrames[1].height + "\" id=\"img" + imageDefId + "\" href=\"" + dataUrl + "\"/>");
  }
  var placedTransform = placedTransformToMatrix(placedData);
  var clipAttrParts = [];
  appendClipPath(render.layer, render.vectorMask, exportState, clipAttrParts);
  if (clipAttrParts.length != 0) exportState.children.push(indent(indentDepth) + "<g " + buildAttrString(clipAttrParts, render.classNames) + ">");
  pushInlineStyleAttr(render);
  var useAttrs = buildAttrString(render.attrParts, render.classNames);
  exportState.children.push(indent(indentDepth) + "<use " + useAttrs + " href=\"#img" + imageDefId + "\" transform=\"" + matrixToTransformAttr(placedTransform) + "\"/>");
  if (clipAttrParts.length != 0) exportState.children.push(indent(indentDepth) + "</g>");
  return true;
}

/** Render a placed PDF linked item into an SVG byte buffer. */
function renderPlacedPdfToSvg(placedData, linkedRaster, fontList) {
  var pdfDoc = new Document("h");
  FileFormatRegistry.getFormat("PDF").decode(linkedRaster.raw.buffer, pdfDoc);
  pdfDoc.rebuildLayerTree();
  pdfDoc.recalculateBounds();
  pdfDoc.markDirty();
  pdfDoc.composite();
  if (placedData.Crop && placedData.Crop.v == 1) {
    resizeDocumentCanvas(pdfDoc, pdfDoc.root.getSelectionRect(pdfDoc, true));
  }
  return FileFormatRegistry.getFormat("SVG").encode(pdfDoc, pdfDoc.width, pdfDoc.height, null, { fontNames: fontList });
}

/** Serialize a rasterized layer as a `<use>` of an embedded PNG `<image>`. */
function serializeRasterImage(exportState, render, indentDepth) {
  pushInlineStyleAttr(render);
  var useAttrs = buildAttrString(render.attrParts, render.classNames);
  var layerBuffer = render.layer.buffer;
  if (render.solidFill) layerBuffer = LayerStyleRenderer.applyColorOverlayToBuffer(layerBuffer, render.solidFill, render.layer.rect);
  var layerRect = render.layer.rect;
  exportState.imageDefCounter++;
  var dataUrl = FileFormatRegistry.bufferToDataUrl(layerBuffer.buffer, layerRect.width, layerRect.height, "png", null, true);
  exportState.defsFragments.push(indent(2) + "<image width=\"" + render.layer.rect.width + "\" height=\"" + render.layer.rect.height + "\" id=\"img" + exportState.imageDefCounter + "\" href=\"" + dataUrl + "\"/>");
  exportState.children.push(indent(indentDepth) + "<use " + useAttrs + " href=\"#img" + exportState.imageDefCounter + "\" x=\"" + layerRect.x + "\" y=\"" + layerRect.y + "\" />");
}

/** Join attribute parts, appending a class attribute when class names exist. */
function buildAttrString(attrParts, classNames) {
  if (classNames.length != 0) attrParts.push("class=\"" + classNames.join(" ") + "\"");
  return attrParts.join(" ");
}

/** Escape XML special characters for attribute/text content. */
function escapeXml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Format a matrix as an SVG `matrix(...)` transform value. */
function matrixToTransformAttr(matrix) {
  var matrixComponents = [matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty].map(formatNumber);
  return "matrix(" + matrixComponents.join(",") + ")";
}

/** Emit a clipPath def for a layer's vector mask or artboard, referencing it. */
function appendClipPath(layer, vectorMask, exportState, attrParts) {
  if (!(vectorMask || layer.add.artb)) return;
    var clipPathSvg;
  if (vectorMask) {
    clipPathSvg = exportPathRecordsToSvg(vectorMask.pathRecords).pathSvg;
  } else {
    var artboardOutline = rectToPathOutline(layer.getArtboardRect());
    clipPathSvg = Typr.U.pathToSVG(toTyprPath(artboardOutline), 2);
    }
    exportState.clipPathCounter++;
    attrParts.push("clip-path=\"url(#cp" + exportState.clipPathCounter + ")\"");
  exportState.defsFragments.push(indent(2) + "<clipPath clipPathUnits=\"userSpaceOnUse\" id=\"cp" + exportState.clipPathCounter + "\">");
  exportState.defsFragments.push(indent(3) + "<path d=\"" + clipPathSvg + "\" />");
  exportState.defsFragments.push(indent(2) + "</clipPath>");
}

/** Append fill/stroke/feather style declarations for a layer to `styleParts`. */
function appendStyleAttrs(styleParts, layerAdd, exportState, shapeBounds) {
  var vectorStroke = layerAdd.vstk;
  var vectorMask = layerAdd.vmsk;
  var layerEffects = layerAdd.lmfx;
  if (vectorMask && vectorMask.feather != 0) {
    var featherKey = formatNumber(vectorMask.feather);
    if (exportState.featherFilterMap[featherKey] == null) {
      exportState.filterCounter++;
      exportState.featherFilterMap[featherKey] = exportState.filterCounter;
      exportState.defsFragments.push(indent(2) + "<filter x=\"-50%\" y=\"-50%\" width=\"200%\" height=\"200%\" id=\"flt" + exportState.filterCounter + "\"> <feGaussianBlur stdDeviation=\"" + featherKey + "\" /> </filter>");
    }
    styleParts.push("filter: url(#flt" + exportState.featherFilterMap[featherKey] + ")");
  }
  var fillSources = LayerStyleRenderer.mergeMultiFillWithLayerFills(layerEffects, layerAdd);
  var solidFill = fillSources[0];
  var gradientFill = fillSources[1];
  if (vectorStroke && !vectorStroke.fillEnabled.v) styleParts.push("fill: none");
  else if (solidFill) styleParts.push("fill: " + CSS.psdColorToCss(solidFill.Clr.v));
  else if (gradientFill) {
    appendGradient(gradientFill, exportState, shapeBounds);
    styleParts.push("fill: url(#grd" + exportState.gradientCounter + ")");
  }
  if (vectorStroke == null || !vectorStroke.strokeEnabled.v) vectorStroke = LayerStyleRenderer.defaultVectorStroke(layerEffects);
  if (!(vectorStroke && vectorStroke.strokeEnabled.v)) return;
  appendStrokeStyle(styleParts, vectorStroke, exportState, shapeBounds);
}

/** Append stroke style declarations for an enabled vector stroke. */
function appendStrokeStyle(styleParts, vectorStroke, exportState, shapeBounds) {
  var strokeContent = vectorStroke.strokeStyleContent.v;
  if (strokeContent.classID == "solidColorLayer") {
    styleParts.push("stroke: " + CSS.psdColorToCss(strokeContent.Clr.v));
  } else {
    appendGradient(strokeContent, exportState, shapeBounds);
    styleParts.push("stroke: url(#grd" + exportState.gradientCounter + ")");
  }
  var lineCapIdx = LayerEffectDefs.StrokeStyleDefs.lineCapTypes.indexOf(vectorStroke.strokeStyleLineCapType.v.strokeStyleLineCapType);
  var lineJoinIdx = LayerEffectDefs.StrokeStyleDefs.join.indexOf(vectorStroke.strokeStyleLineJoinType.v.strokeStyleLineJoinType);
  var strokeOpacity = vectorStroke.strokeStyleOpacity.v.val / 100;
  var strokeWidth = vectorStroke.strokeStyleLineWidth.v.val;
  var alignmentIdx = LayerEffectDefs.StrokeStyleDefs.alignTypes.indexOf(vectorStroke.strokeStyleLineAlignment.v.strokeStyleLineAlignment);
    if (alignmentIdx == 2) {
      strokeWidth *= 2;
    styleParts.push("paint-order:stroke fill markers");
    }
  var dashSet = vectorStroke.strokeStyleLineDashSet.v;
  var dashArray = [];
    for (var dashIdx = 0; dashIdx < dashSet.length; dashIdx++) dashArray.push(Math.round(dashSet[dashIdx].v.val * strokeWidth));
  if (lineCapIdx != 0) styleParts.push("stroke-linecap:" + LINE_CAP_NAMES[lineCapIdx]);
  if (lineJoinIdx != 0) styleParts.push("stroke-linejoin:" + LINE_JOIN_NAMES[lineJoinIdx]);
  if (strokeOpacity != 1) styleParts.push("stroke-opacity:" + formatNumber(strokeOpacity));
  if (strokeWidth != 1) styleParts.push("stroke-width: " + formatNumber(strokeWidth));
  if (dashArray.length != 0) styleParts.push("stroke-dasharray: " + dashArray.join(","));
}

/** Emit a linear/radial gradient def and its stops from a gradient descriptor. */
function appendGradient(gradientDesc, exportState, shapeBounds) {
  exportState.gradientCounter++;
  var gradPayload = gradientDesc.Grad.v;
  var colorStops = JSON.parse(JSON.stringify(gradPayload.Clrs.v));
  var opacityStops = JSON.parse(JSON.stringify(gradPayload.Trns.v));
  var gradType = gradientDesc.Type.v.GrdT;
  var isRadial = gradType == "Rdl" ? 1 : 0;
  var gradTag = (isRadial == 1 ? "radial" : "linear") + "Gradient";
  var endpoints = linearGradientEndpoints(gradientDesc, shapeBounds);
  if (isRadial == 0) {
    endpoints[0].x = endpoints[1].x + 2 * (endpoints[0].x - endpoints[1].x);
    endpoints[0].y = endpoints[1].y + 2 * (endpoints[0].y - endpoints[1].y);
  }
  var gradOpen = indent(2) + "<" + gradTag + " id=\"grd" + exportState.gradientCounter + "\" gradientUnits=\"userSpaceOnUse\" ";
  if (isRadial == 0) exportState.defsFragments.push(gradOpen + " x1=\"" + formatNumber(endpoints[0].x) + "\" y1=\"" + formatNumber(endpoints[0].y) + "\" x2=\"" + formatNumber(endpoints[1].x) + "\" y2=\"" + formatNumber(endpoints[1].y) + "\">");
  if (isRadial == 1) exportState.defsFragments.push(gradOpen + " cx=\"" + formatNumber(endpoints[0].x) + "\" cy=\"" + formatNumber(endpoints[0].y) + "\" r=\"" + formatNumber(Point.dist(endpoints[0], endpoints[1])) + "\">");
  if (gradType == "Rflc") mirrorReflectedStops(colorStops, opacityStops);
  var reverseStops = gradientDesc.Rvrs.v;
  if (reverseStops) {
    colorStops.reverse();
    opacityStops.reverse();
  }
  for (var colorIdx = 0; colorIdx < colorStops.length; colorIdx++) {
    var colorStop = colorStops[colorIdx].v;
    var stopOpacity = colorIdx < opacityStops.length ? opacityStops[colorIdx].v.Opct.v.val / 100 : 1;
    var stopOpacityAttr = stopOpacity == 1 ? "" : "stop-opacity=\"" + formatNumber(stopOpacity) + "\"";
    var stopOffset = colorStop.Lctn.v / 4096;
    if (reverseStops) stopOffset = 1 - stopOffset;
    exportState.defsFragments.push(indent(3) + "<stop offset=\"" + formatNumber(stopOffset) + "\" stop-color=\"" + CSS.psdColorToCss(colorStop.Clr.v) + "\" " + stopOpacityAttr + " />");
  }
  exportState.defsFragments.push(indent(2) + "</" + gradTag + ">");
}

/** Expand a reflected gradient's stops into a mirrored, sorted stop list. */
function mirrorReflectedStops(colorStops, opacityStops) {
    for (var mirrorPass = 0; mirrorPass < 2; mirrorPass++) {
      var stopList = mirrorPass == 0 ? colorStops : opacityStops;
      for (var stopIdx = stopList.length - 1; stopIdx >= 0; stopIdx--) {
        var stopEntry = stopList[stopIdx];
        stopEntry.v.Lctn.v = 2048 + (stopEntry.v.Lctn.v >>> 1);
        var mirroredStop = JSON.parse(JSON.stringify(stopEntry));
        mirroredStop.v.Lctn.v = 4096 - mirroredStop.v.Lctn.v;
      stopList.push(mirroredStop);
      }
      stopList.sort(function(leftStop, rightStop) {
        return leftStop.v.Lctn.v - rightStop.v.Lctn.v;
    });
  }
}

const SVGLoader = {
  parse,
  exportSvg,
  getTagName,
  parseNumberList,
  parseLength,
  formatNumber,
  escapeXml,
  matrixToTransformAttr,
  getHref,
  parseTransform,
};

export { SVGLoader };
