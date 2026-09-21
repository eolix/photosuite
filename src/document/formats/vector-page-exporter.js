// Vector page exporter: renders a document into page-drawing callbacks
// (StartPage / Fill / Stroke / PutText / PutImage / ShowPage / Done) that a
// PDF / EMF / DXF writer consumes — one page per document artboard, or the
// whole canvas when the document has none.
/* global UDOC */
import { Point } from "../../core/math/point.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";

import { FileFormatRegistry } from "./registry/file-format-registry.js";
import { LayerStyleRenderer } from "../../features/layer-styles/style-renderer.js";
import { LayerEffectDefs } from "./psd/effect-defs.js";
import { TextEngineData } from "../../features/text/text-engine.js";
import { TextLayout } from "../../features/text/text-layout.js";
import { TextRenderer } from "../../features/text/text-renderer.js";
import { VectorPageBuilder } from "./vector-page-builder.js";
import { allocBuffer, extractChannelByte } from "../../engine/compositing/buffer-utils.js";
import { copyChannel, copyPixels, scaleRgbaAlphaByMask } from "../../engine/compositing/pixel-ops.js";
import { elevateQuadraticSegmentsToCubics, flattenPathRecordsToPath, splitPathBySubpathId, transformCoordPairs } from "../../engine/compositing/anti-alias.js";
import { placedTransformToMatrix } from "./psd/descriptor-codec.js";
import { boundsOfPathRecords } from "../../engine/compositing/selection-utils.js";
import { linearGradientEndpoints, psdColorToRgb } from "../../engine/compositing/psd-color-utils.js";

/** PDF user-space units per inch (for dpi → point scaling). */
const PDF_POINTS_PER_INCH = 72;
/** Gradient stop location denominator (PSD stores locations in 0..4096). */
const GRADIENT_LOCATION_MAX = 4096;
/** Effects at order index above this render outside the layer (behind it). */
const OUTER_EFFECT_INDEX_THRESHOLD = 7;
/** Stroke-alignment index meaning the stroke sits outside the path. */
const STROKE_ALIGN_OUTSIDE_INDEX = 2;

/**
 * Render a document to page-drawing callbacks on `pdfWriter`.
 * @param {object} doc
 * @param {Array} exportOptions [pageRange, jpegQuality, flatten, textAsText, textAsPaths, passthroughFormats]
 * @param {object} pdfWriter writer implementing StartPage/ShowPage/Done/PutImage/Fill/Stroke/PutText
 * @param {object} fontData font lookup forwarded to text renderers
 */
function renderDocumentToPdf(doc, exportOptions, pdfWriter, fontData) {
  var flatten = exportOptions[2];
  var jpegQuality = exportOptions[1];

  var useArtboards = false;
  var pages = [doc.root];
  var rootChildren = doc.root.children;
  if (doc.add.artd) {
    useArtboards = true;
    for (var i = 0; i < rootChildren.length; i++) {
      if (rootChildren[i].layer.add.artb == null) { useArtboards = false; break; }
    }
    if (useArtboards) pages = rootChildren;
  }

  var docRect = new Rect(0, 0, doc.width, doc.height);
  var pageIndices = parsePageRange(exportOptions[0], pages.length);
  var dpiScale = PDF_POINTS_PER_INCH / doc.dpi;

  for (var i = 0; i < pages.length; i++) {
    if (pageIndices.length !== 0 && pageIndices.indexOf(i + 1) === -1) continue;

    var pageNode = pages[i];
    var pageRect = useArtboards ? pageNode.layer.getArtboardRect() : docRect;
    var pdfWidth = Math.round(pageRect.width * dpiScale);
    var pdfHeight = Math.round(pageRect.height * dpiScale);
    pdfWriter.StartPage(0, 0, pdfWidth, pdfHeight);

    var pdfState = UDOC.getState([[0, 0, pdfWidth, pdfHeight]]);
    var pageTransform = new Matrix2D();
    pageTransform.translate(-pageRect.x, -pageRect.y - pageRect.height);
    pageTransform.scale(dpiScale, -dpiScale);

    if (flatten) {
      emitFlattenedPage(doc, docRect, pageRect, jpegQuality, pdfState, pdfWriter, pageTransform);
    } else {
      renderLayerToPdf(doc, pageNode, pdfState, pdfWriter, pageTransform, exportOptions, fontData);
    }
    pdfWriter.ShowPage();
  }
  pdfWriter.Done();
}

/**
 * Parse a page-range string ("1, 3-5, 7") into a 1-indexed page-number array,
 * dropping entries outside [1, pageCount]. A "-" token pops its left operand
 * and pushes the half-open range [left, right); the right operand closes it on
 * the next iteration.
 */
function parsePageRange(pageRangeStr, pageCount) {
  var rangeTokens = pageRangeStr
    .replace(/,/g, " ")
    .replace(/-/g, " - ")
    .replace(/  +/g, " ")
    .trim()
    .split(" ");

  var pageIndices = [];
  for (var i = 0; i < rangeTokens.length; i++) {
    if (rangeTokens[i] === "-") {
      var rangeStart = pageIndices.pop();
      var rangeEnd = parseInt(rangeTokens[i + 1]);
      if (rangeStart != null && !isNaN(rangeEnd)) {
        while (rangeStart < rangeEnd) pageIndices.push(rangeStart++);
      }
    } else {
      pageIndices.push(parseInt(rangeTokens[i]));
    }
  }
  for (var i = pageIndices.length - 1; i >= 0; i--) {
    if (isNaN(pageIndices[i]) || pageIndices[i] < 1 || pageIndices[i] > pageCount) pageIndices.splice(i, 1);
  }
  return pageIndices;
}

/** Emit a page as a single flattened composite bitmap. */
function emitFlattenedPage(doc, docRect, pageRect, jpegQuality, pdfState, pdfWriter, pageTransform) {
  var rasterData = doc.getRasterData();
  if (!docRect.equals(pageRect)) {
    rasterData = allocBuffer(pageRect.area() * 4);
    copyPixels(doc.getRasterData(), docRect, rasterData, pageRect);
  }
  if (jpegQuality !== 100) {
    var encoded = FileFormatRegistry.getFormat("JPG").encode([[rasterData.buffer]], pageRect.width, pageRect.height, [jpegQuality]);
    rasterData = new Uint8Array(encoded);
  }
  var imageOriginTransform = new Matrix2D();
  imageOriginTransform.translate(pageRect.x, pageRect.y);
  putImageToPdf(pdfState, pdfWriter, rasterData, pageRect, imageOriginTransform, pageTransform);
}

/**
 * Convert a PSD color to a normalized [r, g, b] triple (0..1). The h / l / O
 * fields on psdColorToRgb are the red / green / blue channels.
 */
function colorToRgb(psdColor) {
  psdColor = psdColorToRgb(psdColor);
  return [psdColor.h / 255, psdColor.l / 255, psdColor.O / 255];
}

/** Render one layer (recursing into groups) into page-drawing callbacks. */
function renderLayerToPdf(doc, layerNode, pdfState, pdfWriter, transform, exportOptions, fontData) {
  var layer = layerNode.layer;
  if (!layer || !layer.isVisible()) return;

  var multiFill = layer.add.lmfx;
  var vectorMask = layer.add.vmsk;
  var strokeStyle = layer.add.vstk;
  var textData = layer.add.TySh;

  var layerOpacity = layer.Opct / 255;
  var fillOpacity = layer.add.iOpa ? layer.add.iOpa / 255 : 1;
  pdfState.bmode = VectorPageBuilder.psdToBlendMode(layer.blendMode);
  pdfState.ca = pdfState.CA = layerOpacity * fillOpacity;

  var solidFillOverride = resolveSolidFillOverride(multiFill);
  var effectStack = computeLayerEffectStack(doc, layer, multiFill);

  if (effectStack.type) {
    renderLayerEffectsToPdf(layer, effectStack.mask, effectStack.type, pdfState, pdfWriter, transform, exportOptions, true);
  }

  if (layer.isGroup()) {
    for (var i = 0; i < layerNode.children.length; i++) {
      renderLayerToPdf(doc, layerNode.children[i], pdfState, pdfWriter, transform, exportOptions, fontData);
    }
  } else if (vectorMask && layer.hasFillContent()) {
    if (!emitShapeFillAndStroke(layer, vectorMask, strokeStyle, multiFill, pdfState, pdfWriter, transform)) return;
  } else if (textData && exportOptions[4]) {
    emitTextAsPaths(textData, solidFillOverride, pdfState, pdfWriter, transform, fontData);
  } else if (textData && exportOptions[3] === false) {
    emitTextAsElements(textData, solidFillOverride, pdfState, pdfWriter, transform, fontData);
  } else if (!layer.rect.isEmpty()) {
    if (!emitRasterLayer(doc, layer, solidFillOverride, exportOptions, pdfState, pdfWriter, transform)) return;
  }

  if (effectStack.type) {
    renderLayerEffectsToPdf(layer, effectStack.mask, effectStack.type, pdfState, pdfWriter, transform, exportOptions, false);
  }
}

/** First enabled solid-fill color override in the multi-fill chain, or null. */
function resolveSolidFillOverride(multiFill) {
  var override = multiFill;
  if (override) override = override.solidFillMulti.v[0];
  if (override) override = override.v;
  if (override && !override.enab.v) override = null;
  return override;
}

/**
 * Build the layer's effect-render stack (alpha mask + stack type) for a
 * non-group layer with enabled effects. Returns { mask, type }.
 */
function computeLayerEffectStack(doc, layer, multiFill) {
  if (!(layer.hasEnabledEffects() && !layer.isGroup())) return { mask: undefined, type: undefined };
  var effectAlphaMask = allocBuffer(layer.rect.area());
  extractChannelByte(layer.buffer, effectAlphaMask, 3);
  var type = LayerStyleRenderer.buildLayerStyleEffectStack(multiFill, null, effectAlphaMask, layer.rect, doc, layer.rect).type;
  return { mask: effectAlphaMask, type: type };
}

/**
 * Emit a vector shape layer's fill and stroke. Returns false when the stroke
 * color is missing (aborting the whole layer render, matching the original
 * control flow).
 */
function emitShapeFillAndStroke(layer, vectorMask, strokeStyle, multiFill, pdfState, pdfWriter, transform) {
  var shapeSelection = boundsOfPathRecords(vectorMask.pathRecords);
  var antiAliasedPath = flattenPathRecordsToPath(vectorMask.pathRecords);
  transformCoordPairs(antiAliasedPath.coords, transform, antiAliasedPath.coords);
  pdfState.pth = { cmds: antiAliasedPath.commands, crds: antiAliasedPath.coords };

  var hasFill = false;
  if (strokeStyle.fillEnabled.v) {
    applyFillPaint(pdfState, multiFill, layer.add, transform, shapeSelection);
    hasFill = true;
  }

  var defaultStroke = LayerStyleRenderer.defaultVectorStroke(multiFill);
  if (!strokeStyle.strokeEnabled.v && defaultStroke) strokeStyle = defaultStroke;

  var hasStroke = false;
  var isInsideStroke = false;
  if (strokeStyle.strokeEnabled.v) {
    if (strokeStyle.strokeStyleContent.v.Clr == null) return false;
    isInsideStroke = applyStrokePaint(pdfState, strokeStyle, transform);
    hasStroke = true;
  }

  // Inside strokes fill after stroking so the stroke does not clip the fill.
  if (hasFill && !isInsideStroke) pdfWriter.Fill(pdfState);
  if (hasStroke) pdfWriter.Stroke(pdfState);
  if (hasFill && isInsideStroke) pdfWriter.Fill(pdfState);
  return true;
}

/** Set the fill color (solid or gradient) on the page state. */
function applyFillPaint(pdfState, multiFill, layerAdd, transform, shapeSelection) {
  var mergedFills = LayerStyleRenderer.mergeMultiFillWithLayerFills(multiFill, layerAdd);
  var solidFill = mergedFills[0];
  var gradientFill = mergedFills[1];
  if (solidFill) {
    pdfState.colr = colorToRgb(solidFill.Clr.v);
  } else if (gradientFill) {
    pdfState.colr = gradientColorSpec(gradientFill, transform, shapeSelection);
  }
}

/** Build a parser gradient color spec from a gradient fill descriptor. */
function gradientColorSpec(gradientFill, transform, shapeSelection) {
  var gradientType = gradientFill.Type.v.GrdT === "Rdl" ? "rad" : "lin";
  var endpoints = linearGradientEndpoints(gradientFill, shapeSelection);
  var gradStart = transform.transformPoint(endpoints[0]);
  var gradEnd = transform.transformPoint(endpoints[1]);
  var gradCoords;
  if (gradientType === "rad") {
    gradCoords = [gradStart.x, gradStart.y, 0, gradStart.x, gradStart.y, Point.dist(gradStart, gradEnd)];
  } else {
    gradStart.setXY(gradEnd.x + (gradStart.x - gradEnd.x) * 2, gradEnd.y + (gradStart.y - gradEnd.y) * 2);
    gradCoords = [gradStart.x, gradStart.y, gradEnd.x, gradEnd.y];
  }
  var colorStops = gradientFill.Grad.v.Clrs.v;
  var gradientStops = [];
  for (var si = 0; si < colorStops.length; si++) {
    var stop = colorStops[si].v;
    gradientStops.push([stop.Lctn.v / GRADIENT_LOCATION_MAX, colorToRgb(stop.Clr.v)]);
  }
  return { typ: gradientType, mat: [1, 0, 0, 1, 0, 0], grad: gradientStops, crds: gradCoords };
}

/** Set stroke color/width/dash on the page state. Returns isInsideStroke. */
function applyStrokePaint(pdfState, strokeStyle, transform) {
  var strokeAlignIndex = LayerEffectDefs.StrokeStyleDefs.alignTypes.indexOf(strokeStyle.strokeStyleLineAlignment.v.strokeStyleLineAlignment);
  var strokeRgb = psdColorToRgb(strokeStyle.strokeStyleContent.v.Clr.v);
  pdfState.COLR = [strokeRgb.h / 255, strokeRgb.l / 255, strokeRgb.O / 255];
  pdfState.lwidth = strokeStyle.strokeStyleLineWidth.v.val * (strokeAlignIndex === STROKE_ALIGN_OUTSIDE_INDEX ? 2 : 1) * transform.getScale();
  pdfState.mlimit = strokeStyle.strokeStyleMiterLimit.v;
  pdfState.doff = strokeStyle.strokeStyleLineDashOffset.v.val;
  pdfState.ljoin = LayerEffectDefs.StrokeStyleDefs.join.indexOf(strokeStyle.strokeStyleLineJoinType.v.strokeStyleLineJoinType);
  pdfState.lcap = LayerEffectDefs.StrokeStyleDefs.lineCapTypes.indexOf(strokeStyle.strokeStyleLineCapType.v.strokeStyleLineCapType);
  pdfState.dash = strokeStyle.strokeStyleLineDashSet.v.map(function (d) { return d.v.val * pdfState.lwidth; });
  if (pdfState.dash.length === 1 && pdfState.dash[0] === 0) pdfState.dash = [];
  return strokeAlignIndex === STROKE_ALIGN_OUTSIDE_INDEX;
}

/** Emit a text layer as color-split filled glyph outlines. */
function emitTextAsPaths(textData, solidFillOverride, pdfState, pdfWriter, transform, fontData) {
  var engineData = textData.engineData;
  var textLayout = new TextLayout(engineData, fontData);
  var textPaths = TextRenderer.buildTextPaths(textLayout, textData);
  var pathsByColor = splitPathBySubpathId(textPaths);
  for (var colorKey in pathsByColor) {
    var colorHex = parseInt(colorKey.slice(1), 16);
    pdfState.colr = solidFillOverride
      ? colorToRgb(solidFillOverride.Clr.v)
      : [(colorHex >>> 16 & 255) / 255, (colorHex >>> 8 & 255) / 255, (colorHex & 255) / 255];
    var glyphPath = pathsByColor[colorKey];
    transformCoordPairs(glyphPath.coords, transform, glyphPath.coords);
    glyphPath = elevateQuadraticSegmentsToCubics(glyphPath);
    pdfState.pth = { cmds: glyphPath.commands, crds: glyphPath.coords };
    pdfWriter.Fill(pdfState);
  }
}

/** Emit a text layer as native text operators, one PutText per style run. */
function emitTextAsElements(textData, solidFillOverride, pdfState, pdfWriter, transform, fontData) {
  var engineData = textData.engineData;
  var flipMatrix = new Matrix2D(1, 0, 0, -1, 0, 0);
  flipMatrix.concat(textData.transform.clone());
  flipMatrix.concat(transform);
  var layerText = TextEngineData.getLayerText(engineData);
  var textLayout = new TextLayout(engineData, fontData);

  for (var paraIdx = 0; paraIdx < textLayout.paraStyle.length; paraIdx++) {
    var para = textLayout.paraStyle[paraIdx];
    if (para.wordRuns.length === 1 && para.wordRuns[0].isNewline) continue;
    for (var lineIdx = 0; lineIdx < para.nodes.length; lineIdx++) {
      var line = para.nodes[lineIdx];
      var lineOffsetY = para.offset.y + line.offset.y;
      var charStart = para.wordRuns[line.start].start;
      var charEnd = para.wordRuns[line.end - 1].end;
      var styleRuns = TextEngineData.getStyleRunCounts(engineData, charStart, charEnd);

      for (var runIdx = 0; runIdx < styleRuns.length; runIdx++) {
        var glyphBounds = textLayout.getGlyphBounds(charStart);
        var runLength = styleRuns[runIdx];
        var style = TextEngineData.getTextStyle(engineData, charStart, charStart);
        var fillColor = TextEngineData.fillColorToRgb(style.textStyle);
        pdfState.font.Tf = style.fontSet[style.textStyle.Font].Name;
        pdfState.font.Tfs = Math.round(style.textStyle.FontSize);
        pdfState.colr = solidFillOverride
          ? colorToRgb(solidFillOverride.Clr.v)
          : [fillColor.h / 255, fillColor.l / 255, fillColor.O / 255];

        var glyphText = layerText.slice(charStart, charStart + runLength);
        if (style.textStyle.FontCaps === 2) glyphText = glyphText.toUpperCase();

        var glyphTransform = new Matrix2D();
        glyphTransform.translate(glyphBounds.bounds.x, -lineOffsetY);
        glyphTransform.concat(flipMatrix);
        pdfState.ctm = [glyphTransform.a, glyphTransform.b, glyphTransform.c, glyphTransform.d, glyphTransform.tx, glyphTransform.ty];
        pdfWriter.PutText(pdfState, glyphText, 0);
        pdfState.ctm = [1, 0, 0, 1, 0, 0];
        charStart += runLength;
      }
    }
  }
}

/**
 * Emit a raster / smart-object layer as an image (plus a color-overlay rect
 * for passthrough embeds). Returns false when a placed link can't be resolved
 * (aborting the whole layer render, matching the original control flow).
 */
function emitRasterLayer(doc, layer, solidFillOverride, exportOptions, pdfState, pdfWriter, transform) {
  var imageBuffer;
  var imageRect;
  var isPassthroughFormat = false;
  var objectTransform = new Matrix2D();

  if (layer.add.placedData) {
    var placedData = layer.add.placedData;
    var linkedItem = doc.resolveLinkedItemRaster(placedData.Idnt.v, placedData.Crop ? placedData.Crop.v : null);
    if (linkedItem == null) return false;
    var linkedRaster = linkedItem.rasterCache;
    var detectedFormat = FileFormatRegistry.detectFormat(linkedItem.raw.buffer);
    if (exportOptions[5].indexOf(detectedFormat) !== -1) {
      imageBuffer = linkedItem.raw;
      isPassthroughFormat = true;
    } else {
      imageBuffer = linkedRaster[0];
    }
    imageRect = linkedRaster[1];
    objectTransform = placedTransformToMatrix(placedData);
  } else {
    imageBuffer = layer.buffer;
    imageRect = layer.rect;
    objectTransform.translate(imageRect.x, imageRect.y);
  }

  if (solidFillOverride && !isPassthroughFormat) {
    imageBuffer = LayerStyleRenderer.applyColorOverlayToBuffer(imageBuffer, solidFillOverride, imageRect);
  }
  putImageToPdf(pdfState, pdfWriter, imageBuffer, imageRect, objectTransform, transform);

  if (solidFillOverride && isPassthroughFormat) {
    emitPassthroughColorOverlay(solidFillOverride, imageRect, objectTransform, transform, pdfState, pdfWriter);
  }
  return true;
}

/** Draw a color rectangle over a passthrough image at the fill opacity. */
function emitPassthroughColorOverlay(solidFillOverride, imageRect, objectTransform, transform, pdfState, pdfWriter) {
  var overlayCorners = [0, 0, imageRect.width, 0, imageRect.width, imageRect.height, 0, imageRect.height];
  transformCoordPairs(overlayCorners, objectTransform, overlayCorners);
  transformCoordPairs(overlayCorners, transform, overlayCorners);
  var overlayState = JSON.parse(JSON.stringify(pdfState));
  overlayState.ca = solidFillOverride.Opct.v.val / 100;
  overlayState.pth = { cmds: ["M", "L", "L", "L", "Z"], crds: overlayCorners };
  overlayState.colr = colorToRgb(solidFillOverride.Clr.v);
  pdfWriter.Fill(overlayState);
}

/** Render a layer's blend-mode effects (drop shadow, glow, stroke, …) as images. */
function renderLayerEffectsToPdf(layer, effectAlphaMask, effectStack, pdfState, pdfWriter, transform, exportOptions, renderingBehind) {
  if (layer.add.TySh && !exportOptions[3] && !exportOptions[4]) return;

  var expandedRect = layer.rect.clone();
  var maskBuffer = effectAlphaMask;
  var savedOpacity = pdfState.ca;
  var savedBlendMode = pdfState.bmode;

  for (var i = LayerEffectDefs.order.length - 1; i >= 0; i--) {
    var effectKey = LayerEffectDefs.order[i];
    if (effectKey === "GrFl" || effectKey === "SoFi") continue;
    if (layer.add.vmsk && effectKey === "FrFX") continue;

    var effectEntries = effectStack[effectKey];
    var isOuter = i > OUTER_EFFECT_INDEX_THRESHOLD || effectKey === "FrFX";
    if (isOuter !== renderingBehind) continue;

    for (var j = 0; j < effectEntries.length; j++) {
      var effect = effectEntries[j];
      var effectRect = effect.effectRect.clone();
      effectRect.offset(layer.rect.x, layer.rect.y);

      if (!isOuter) {
        if (!expandedRect.containsRect(effectRect)) {
          var unionRect = expandedRect.union(effectRect);
          var unionBuffer = allocBuffer(unionRect.area());
          copyChannel(maskBuffer, expandedRect, unionBuffer, unionRect);
          maskBuffer = unionBuffer;
          expandedRect = unionRect;
        }
        scaleRgbaAlphaByMask(maskBuffer, expandedRect, effect.rgbaBuffer, effectRect);
      }

      if (isOuter && effectKey === "FrFX" && effect.outerStrokeMask) {
        scaleRgbaAlphaByMask(effect.outerStrokeMask, effectRect, effect.rgbaBuffer, effectRect);
      }

      var effectOriginTransform = new Matrix2D();
      effectOriginTransform.translate(effectRect.x, effectRect.y);
      pdfState.ca = effect.blendOpacity;
      pdfState.bmode = VectorPageBuilder.psdToBlendMode(effect.blendModeCode);
      putImageToPdf(pdfState, pdfWriter, effect.rgbaBuffer, effectRect, effectOriginTransform, transform);
    }
  }

  pdfState.ca = savedOpacity;
  pdfState.bmode = savedBlendMode;
}

/** Emit an image buffer via PutImage, setting the page CTM to place it. */
function putImageToPdf(pdfState, pdfWriter, imageBuffer, imageRect, objectTransform, docTransform) {
  var imageTransform = new Matrix2D();
  imageTransform.scale(imageRect.width, -imageRect.height);
  imageTransform.translate(0, imageRect.height);
  imageTransform.concat(objectTransform);
  imageTransform.concat(docTransform);
  pdfState.ctm = [imageTransform.a, imageTransform.b, imageTransform.c, imageTransform.d, imageTransform.tx, imageTransform.ty];
  pdfWriter.PutImage(pdfState, imageBuffer, imageRect.width, imageRect.height);
  pdfState.ctm = [1, 0, 0, 1, 0, 0];
}

const VectorPageExporter = {
  renderDocumentToPdf,
  colorToRgb,
  putImageToPdf,
};

export { VectorPageExporter };
