// Vector page builder: a callback receiver that PDF / PostScript / metafile /
// vector-format parsers drive (StartPage, Stroke, Fill, PutText, PutImage,
// ShowPage, Done) to emit pages of shape, text, and image layers into a
// document, one artboard per page.
/* global UDOC, UTIF */
import { Point } from "../../core/math/point.js";
import { Matrix2D, scaleIgnoringRotation } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";

import { FileFormatRegistry } from "./registry/file-format-registry.js";

import { LayerStyleRenderer } from "../../features/layer-styles/style-renderer.js";
import { Layer, LayerSectionType } from "../model/layer.js";
import { LayerEffectDefs } from "./psd/effect-defs.js";
import { TextEngineData } from "../../features/text/text-engine.js";
import { Mask, VectorMask } from "../model/layer-masks.js";
import { TransformToolBase } from "../transform/transform-static.js";
import { packDoublesList } from "./psd/descriptor-codec.js";
import { allocBuffer, extractChannel, extractChannelByte } from "../../engine/compositing/buffer-utils.js";
import { boundsFromCoordPairs, buildCanvasPathRecords, rectToPathOutline, transformCoordPairs } from "../../engine/compositing/anti-alias.js";
import { boundsOfPathRecords } from "../../engine/compositing/selection-utils.js";
import { flattenPathKnotCoords, transformPathRecordCoords } from "../../engine/compositing/path-records.js";
import { cssStopsToGradientDesc, gradientAngleFromPoints, toRGBDesc } from "../../engine/compositing/psd-color-utils.js";

/** Twice the max canvas area a single page may occupy before downscaling. */
const MAX_PAGE_PIXELS = 2 * 8192 * 8192;
/** Largest canvas dimension (px) a row of pages may span before wrapping. */
const MAX_CANVAS_DIMENSION = 8192;
/** Horizontal gap (px) inserted between pages laid out in a row. */
const PAGE_GAP = 30;
/** Vertical gap (px) inserted between rows of pages. */
const ROW_GAP = 120;
/** Minimum rendered stroke width (px). */
const MIN_STROKE_WIDTH = .4;
/** Max points in a single subpath; longer vector layers are dropped. */
const MAX_SUBPATH_POINTS = 32767;
/** Zero-width space code point, skipped as empty text. */
const ZERO_WIDTH_SPACE = 8203;
/** Hebrew combining-mark code point range (for RTL line detection). */
const HEBREW_MARK_MIN = 1473;
const HEBREW_MARK_MAX = 1524;
/** Group-flag bits marking a collapsed section layer. */
const GROUP_LAYER_FLAGS = 24;
/** Layer-flag bit marking a vector (shape) layer. */
const VECTOR_LAYER_FLAG = 16;

/** PDF blend-mode name → PSD blend code. */
const BLEND_MODE_MAP = {
  "/Normal": "norm",
  "/Multiply": "mul ",
  "/Screen": "scrn",
  "/Overlay": "over",
  "/Darken": "dark",
  "/Lighten": "lite",
  "/ColorDodge": "div ",
  "/ColorBurn": "idiv",
  "/HardLight": "hLit",
  "/SoftLight": "sLit",
  "/Difference": "diff",
  "/Exclusion": "smud",
  "/Hue": "hue ",
  "/Saturation": "sat ",
  "/Color": "colr",
  "/Luminosity": "lum ",
};

/** Embedded-font PostScript name → engine font name overrides. */
const FONT_ALIASES = {
  "NimbusRomNo9L-Medi": "NimbusRomNo9L-Med",
  "NimbusRomNo9L-Regu": "NimbusRomNo9L-Reg",
  "NimbusRomNo9L-MediItal": "NimbusRomNo9L-MedIta",
  "NimbusRomNo9L-ReguItal": "NimbusRomNo9L-RegIta",
  CMTT9: "NimbusMono-Regular",
  Arial: "ArialMT",
  "BebasNeue-Regular": "BebasNeueRegular",
};

/** Set the fill rule on every subpath-start record. */
function setFillRule(pathRecords, fillRule) {
  for (var loopIdx = 0; loopIdx < pathRecords.length; loopIdx++) {
    if (pathRecords[loopIdx].fillRule != null) pathRecords[loopIdx].fillRule = fillRule;
  }
}

/** Absolute scale (sqrt of the determinant) of a flat [a,b,c,d,e,f] matrix. */
function matrixScale(matrixArray) {
  return Math.sqrt(Math.abs(matrixArray[0] * matrixArray[3] - matrixArray[1] * matrixArray[2]));
}

/** Build a Matrix2D from a flat [a,b,c,d,e,f] array. */
function arrayToMatrix(matrixArray) {
  return new Matrix2D(matrixArray[0], matrixArray[1], matrixArray[2], matrixArray[3], matrixArray[4], matrixArray[5]);
}

/** Build a fill descriptor (solid or gradient) from a parser color spec. */
function buildFillDescriptor(fillColor, pageMatrix, boundsRect) {
  if (fillColor.length != null) {
    var solidFillDefaults = LayerEffectDefs.getEffectDefault("SoFi");
    var solidWrapper = { t: "Objc", v: solidFillDefaults };
    solidWrapper.v.Clr.v = VectorPageBuilder.rgbFractionsToColorDesc(fillColor);
    return { type: "SoFi", value: solidWrapper };
  }
  var gradientDesc = buildGradientFillDescriptor(fillColor, pageMatrix, boundsRect);
  return { type: "GrFl", value: { t: "Objc", v: gradientDesc } };
}

/** Build a gradient fill descriptor from a parser gradient spec. */
function buildGradientFillDescriptor(gradientSpec, pageMatrix, boundsRect) {
  var gradientDesc = LayerEffectDefs.getEffectDefault("GrFl");
  var gradientStops = gradientDesc.Grad.v;
  gradientStops.Intr.v = 0;
  var gradientMatrix = arrayToMatrix(gradientSpec.mat);
  gradientMatrix.concat(pageMatrix);
  var gradientStart = new Point(0, 0);
  var gradientEnd = new Point(boundsRect.width, 0);
  var gradientCoords = gradientSpec.crds != null ? gradientSpec.crds : gradientSpec.coords;
  if (gradientSpec.typ == "rad") {
    gradientDesc.Type.v.GrdT = "Rdl";
    var centerWeight = .7;
    gradientStart.x = (1 - centerWeight) * gradientCoords[0] + centerWeight * gradientCoords[3];
    gradientStart.y = (1 - centerWeight) * gradientCoords[1] + centerWeight * gradientCoords[4];
    gradientEnd.x = gradientStart.x;
    gradientEnd.y = gradientStart.y;
    gradientEnd.x += Math.max(gradientCoords[2], gradientCoords[5]);
  } else {
    gradientDesc.Type.v.GrdT = "Lnr";
    gradientStart.x = gradientCoords[0];
    gradientStart.y = gradientCoords[1];
    gradientEnd.x = gradientCoords[2];
    gradientEnd.y = gradientCoords[3];
    gradientStart.x = gradientEnd.x + .5 * (gradientStart.x - gradientEnd.x);
    gradientStart.y = gradientEnd.y + .5 * (gradientStart.y - gradientEnd.y);
  }
  gradientStart = gradientMatrix.transformPoint(gradientStart);
  gradientEnd = gradientMatrix.transformPoint(gradientEnd);
  gradientAngleFromPoints(gradientStart, gradientEnd, boundsRect, gradientDesc);
  cssStopsToGradientDesc(gradientSpec.grad, gradientStops);
  return gradientDesc;
}

/** Apply page opacity and PDF blend mode to a layer. */
function applyBlendStyle(pageState, layer) {
  layer.Opct = Math.round(255 * pageState.ca);
  var blendMode = BLEND_MODE_MAP[pageState.bmode];
  if (blendMode == null) console.log("Unknown blend mode", blendMode);
  else layer.blendMode = blendMode;
}

/** Normalize parser pixel data to a 4-byte RGBA buffer (or PNG/JPEG bytes). */
function normalizeImageData(pixelData, width, height) {
  var detectedFormat = FileFormatRegistry.detectFormat(pixelData.buffer);
  if (detectedFormat == "jpg") {
    try {
      pixelData = new Uint8Array(FileFormatRegistry.getFormat("JPG").encodeRgbBufferToJpeg(pixelData.buffer));
    } catch (decodeError) {
      pixelData = new Uint8Array(width * height * 4);
    }
  } else if (pixelData.length != width * height * 4) {
    var rgbaBuffer = new Uint8Array(width * height * 4);
    var g4Mask = new Uint8Array(Math.ceil(width * height / 8));
    UTIF.decode._decodeG4(pixelData, 0, pixelData.length, g4Mask, 0, width, 1);
    for (var loopIdx = 0; loopIdx < width * height; loopIdx++) {
      var rgbaOffset = loopIdx * 4;
      var grayValue = (g4Mask[loopIdx >> 3] >> 7 - (loopIdx & 7) & 1) * 255;
      rgbaBuffer[rgbaOffset] = grayValue;
      rgbaBuffer[rgbaOffset + 1] = grayValue;
      rgbaBuffer[rgbaOffset + 2] = grayValue;
      rgbaBuffer[rgbaOffset + 3] = 255;
    }
    pixelData = rgbaBuffer;
  }
  return pixelData;
}

/** Decode compressed parser image data to an RGBA buffer. */
function decodeImageData(pixelData, width, height, decodeOpt, isAlphaChannel) {
  if (pixelData.length != width * height * 4) {
    var detectedFormat = FileFormatRegistry.detectFormat(pixelData.buffer);
    var codec = FileFormatRegistry.getFormat(detectedFormat);
    if (codec == null || detectedFormat == "tga") codec = FileFormatRegistry.getFormat("jpg");
    pixelData = new Uint8Array(codec.decode(pixelData, decodeOpt, isAlphaChannel)[0].data);
  }
  return pixelData;
}

/** Encode an RGBA buffer to PNG bytes via the PNG codec. */
function encodeRgbaToPng(pixelData, width, height) {
  return new Uint8Array(FileFormatRegistry.getFormat("PNG").encode([[pixelData.buffer, 0]], width, height));
}

class VectorPageBuilder {
  constructor(doc, pageMatrix, invertY) {
    this.doc = doc;
    this.pageMatrix = pageMatrix;
    this.invertY = invertY;
    this.cursor = new Point(0, 0);
    this.pageFilter = -1;
    this.pageCount = 0;
    this.rowHeight = 0;
    this.documentRect = new Rect;
    this.textStateByLayer = [];
    this.currentTextStyle = null;
    this.pageBounds = null;
    this.prevPageBounds = null;
    this.clipPathKey = null;
    this.clipRect = null;
    this.clipGroupLayer = null;
  }

  StartPage(left, top, right, bottom, pixelBudget) {
    var pageMatrix = this.pageMatrix;
    var pageScale = pageMatrix.getScale();
    var downscaleFactor = 1;
    var pixelCount = pixelBudget != null ? pixelBudget : (right - left) * (bottom - top);
    while (pixelCount * pageScale * pageScale / (downscaleFactor * downscaleFactor) > MAX_PAGE_PIXELS) downscaleFactor++;
    pageMatrix.scale(1 / downscaleFactor, 1 / downscaleFactor);
    this.pageBounds = [left, top, right, bottom];
    var scaledPageScale = pageMatrix.getScale();
    left = Math.round(left * scaledPageScale);
    top = Math.round(top * scaledPageScale);
    right = Math.round(right * scaledPageScale);
    bottom = Math.round(bottom * scaledPageScale);
    var prevBounds = this.prevPageBounds;
    if (prevBounds == null) {
      pageMatrix.tx = -left;
    } else {
      var prevWidth = prevBounds[2] - prevBounds[0] + PAGE_GAP;
      var pageWidth = Math.round(right - left) + PAGE_GAP;
      if (this.cursor.x + prevWidth + pageWidth > MAX_CANVAS_DIMENSION) {
        pageMatrix.tx = -left;
        this.cursor.x = 0;
        this.cursor.y += this.rowHeight + ROW_GAP;
        this.rowHeight = 0;
      } else {
        pageMatrix.tx += prevWidth;
        this.cursor.x += prevWidth;
      }
    }
    pageMatrix.ty = this.cursor.y + (this.invertY ? bottom : -top);
    this.rowHeight = Math.max(this.rowHeight, Math.round(bottom - top));
    this.prevPageBounds = [left, top, right, bottom];
    this.doc.layers.push(this.doc.createGroupEndLayer());
  }

  getLastLayer() {
    return this.doc.layers[this.doc.layers.length - 1];
  }

  makeDefaultStroke() {
    var strokeStyle = LayerEffectDefs.getStrokeStyleDefault();
    strokeStyle.strokeStyleLineAlignment.v.strokeStyleLineAlignment = "strokeStyleAlignCenter";
    strokeStyle.strokeEnabled.v = false;
    strokeStyle.fillEnabled.v = false;
    return strokeStyle;
  }

  addPathLayer() {
    var pathLayer = this.doc.newLayer();
    pathLayer.setName("Path " + this.doc.layers.length);
    this.doc.layers.push(pathLayer);
    pathLayer.layerFlags |= VECTOR_LAYER_FLAG;
    pathLayer.add.SoCo = {
      classID: "null",
      Clr: { t: "Objc", v: toRGBDesc({ h: 0, l: 0, O: 0 }) },
    };
    pathLayer.add.vmsk = new VectorMask;
    pathLayer.add.vstk = this.makeDefaultStroke();
    return pathLayer;
  }

  pathToVectorMask(pathState) {
    var pathRecords = buildCanvasPathRecords({ H: pathState.crds, K: pathState.cmds }, false);
    transformPathRecordCoords(pathRecords, this.pageMatrix);
    return pathRecords;
  }

  Stroke(pageState) {
    if (this.pageFilter != -1 && this.pageFilter != this.pageCount) return;
    if (pageState.pth.cmds.length <= 1) return;
    var pathRecords = this.pathToVectorMask(pageState.pth);
    if (pathRecords.length <= 2) return;
    this.updateClipPath(pageState);
    setFillRule(pathRecords, -1);
    pathRecords[2].fillRule = 1;
    var strokeColorDesc = VectorPageBuilder.rgbFractionsToColorDesc(pageState.COLR);
    var lastLayer = this.getLastLayer();
    var strokeStyle = this.makeDefaultStroke();
    VectorPageBuilder.applyStrokeStyleFromPathState(strokeStyle, pageState, this.pageMatrix.getScale(), strokeColorDesc);
    var canExtendPath = lastLayer != null && lastLayer.add.vmsk != null && !lastLayer.isGroup();
    var canReuseStrokeLayer = canExtendPath && !lastLayer.add.vstk.strokeEnabled.v && VectorMask.pathsMatchForStrokeReuse(lastLayer.add.vmsk.pathRecords, pathRecords, true);
    var canReuseFillStroke = canExtendPath && !lastLayer.add.vstk.fillEnabled.v && JSON.stringify(strokeStyle) == JSON.stringify(lastLayer.add.vstk);
    if (canReuseFillStroke) {
      lastLayer.add.vmsk.pathRecords = lastLayer.add.vmsk.pathRecords.concat(pathRecords.slice(2));
    } else if (canReuseStrokeLayer) {
      lastLayer.add.vstk = strokeStyle;
      strokeStyle.fillEnabled.v = true;
    } else {
      lastLayer = this.addPathLayer();
      lastLayer.add.vmsk.pathRecords = pathRecords;
      lastLayer.add.vstk = strokeStyle;
    }
  }

  Fill(pageState, unusedFillArg) {
    if (this.pageFilter != -1 && this.pageFilter != this.pageCount) return;
    if (pageState.ca == 0) return;
    var pathCommands = pageState.pth.cmds;
    if (pathCommands.length == 0) return;
    if (pathCommands.length == 2 && JSON.stringify(pathCommands) == "[\"M\",\"L\"]") return;
    var clipBounds = boundsFromCoordPairs(pageState.cpth.crds);
    var pathBounds = boundsFromCoordPairs(pageState.pth.crds);
    if (pathBounds.intersect(clipBounds).isEmpty()) return;

    var fillPath = pageState.pth;
    if (this.clipPathKey == null && UDOC.G.isBox(fillPath, [pathBounds.x, pathBounds.y, pathBounds.x + pathBounds.width, pathBounds.y + pathBounds.height]) && pathBounds.containsRect(clipBounds)) {
      fillPath = pageState.cpth;
    } else {
      this.updateClipPath(pageState);
    }
    var pathRecords = this.pathToVectorMask(fillPath);
    var boundsOutline = rectToPathOutline(pathBounds);
    transformCoordPairs(boundsOutline.coords, this.pageMatrix, boundsOutline.coords);
    pathBounds = boundsFromCoordPairs(boundsOutline.coords);
    var fillDescriptor = buildFillDescriptor(pageState.colr, this.pageMatrix, pathBounds);
    var lastLayer = this.getLastLayer();
    var canMergeFill = this.canMergeSolidFill(lastLayer, pageState, fillDescriptor, pathRecords);
    if (canMergeFill) {
      var mergedPathRecords = lastLayer.add.vmsk.pathRecords;
      for (var loopIdx = 2; loopIdx < pathRecords.length; loopIdx++) mergedPathRecords.push(pathRecords[loopIdx]);
    } else {
      lastLayer = this.addPathLayer();
      delete lastLayer.add.SoCo;
      lastLayer.add.vmsk.pathRecords = VectorMask.clonePathRecords(pathRecords);
      VectorPageBuilder.applyFillStyle(pageState.colr, lastLayer, this.pageMatrix, pathBounds);
      applyBlendStyle(pageState, lastLayer);
    }
  }

  /** Whether a new solid fill can be merged into the previous layer's mask. */
  canMergeSolidFill(lastLayer, pageState, fillDescriptor, pathRecords) {
    var canMerge = this.mergeFills !== false && lastLayer != null && lastLayer.Opct == Math.round(255 * pageState.ca) && lastLayer.add.vstk != null && !lastLayer.add.vstk.strokeEnabled.v && lastLayer.add.SoCo && fillDescriptor.type == "SoFi" && JSON.stringify(lastLayer.add.SoCo.Clr.v) == JSON.stringify(fillDescriptor.value.v.Clr.v);
    if (!canMerge) return false;
    var hasEvenOddFill = false;
    for (var loopIdx = 0; loopIdx < pathRecords.length; loopIdx++) {
      if (pathRecords[loopIdx].fillRule == 0 || pathRecords[loopIdx].fillRule == 2) hasEvenOddFill = true;
    }
    if (!hasEvenOddFill) return true;
    // Even-odd fills only merge when their bounds don't overlap the existing mask.
    var lastLayerBounds = boundsFromCoordPairs(flattenPathKnotCoords(lastLayer.add.vmsk.pathRecords));
    var newPathBounds = boundsFromCoordPairs(flattenPathKnotCoords(pathRecords));
    return lastLayerBounds.intersect(newPathBounds).isEmpty();
  }

  updateClipPath(pageState) {
    var doc = this.doc;
    var clipPath = pageState.cpth;
    var clipPathKey = clipPath.cmds.join("") + " " + clipPath.crds.join(",");
    var clipIsPageBox = UDOC.G.isBox(clipPath, this.pageBounds);
    if (clipIsPageBox && this.clipPathKey == null) return;
    if (clipPathKey == this.clipPathKey) return;
    this.finalizeClipGroup();
    if (clipIsPageBox) return;
    this.clipPathKey = clipPathKey;
    doc.layers.push(doc.createGroupEndLayer());
    var clipLayer = doc.newLayer();
    clipLayer.setName("Mask");
    clipLayer.add.lsct = LayerSectionType.ClosedGroup;
    clipLayer.blendMode = "pass";
    clipLayer.layerFlags = GROUP_LAYER_FLAGS;
    var clipVectorMask = clipLayer.add.vmsk = new VectorMask;
    clipVectorMask.pathRecords = this.pathToVectorMask(pageState.cpth);
    if (UDOC.G.isBox(clipPath)) {
      this.clipRect = boundsOfPathRecords(clipVectorMask.pathRecords);
      this.clipRect.inflate(3, 3);
    } else {
      this.clipRect = null;
    }
    this.clipGroupLayer = clipLayer;
  }

  finalizeClipGroup() {
    var doc = this.doc;
    if (this.clipPathKey == null) return;
    var lastLayerIndex = doc.layers.length - 1;
    var groupEndIndex = lastLayerIndex;
    while (groupEndIndex >= 0 && doc.layers[groupEndIndex].add.lsct != LayerSectionType.BoundingDivider) groupEndIndex--;
    var clipIsRedundant = false;
    var clipRect = this.clipRect;
    if (clipRect) {
      var contentBounds = new Rect;
      var layerIndex = lastLayerIndex;
      while (layerIndex > groupEndIndex) {
        contentBounds = doc.layers[layerIndex].getTransformBounds(this.doc, false, true);
        layerIndex--;
      }
      clipIsRedundant = clipRect.containsRect(contentBounds);
    }
    if (clipIsRedundant) {
      this.textStateByLayer.splice(groupEndIndex, 1);
      doc.layers.splice(groupEndIndex, 1);
    } else {
      doc.layers.push(this.clipGroupLayer);
    }
    this.clipPathKey = null;
  }

  PutText(pageState, text, charSpacing, boxSize) {
    if (this.pageFilter != -1 && this.pageFilter != this.pageCount) return;
    var firstCharCode = text.charCodeAt(0);
    if (text.length == 0 || text.length == 1 && (firstCharCode == 0 || firstCharCode == ZERO_WIDTH_SPACE)) return;
    this.updateClipPath(pageState);
    var doc = this.doc;
    var fontState = pageState.font;
    var pageCtm = arrayToMatrix(pageState.ctm);
    pageCtm.concat(this.pageMatrix);
    var fontMatrix = arrayToMatrix(fontState.Tm);
    fontMatrix.concat(pageCtm);
    var textScale = scaleIgnoringRotation(fontMatrix);
    var textMatrix = new Matrix2D(1 / textScale, 0, 0, -1 / textScale, 0, 0);
    textMatrix.concat(fontMatrix);
    var fontSize = fontState.Tfs * textScale;
    if (fontState.Th != 100 || fontState.Trise != 0) console.log(fontState);

    var appended = this.appendToExistingTextRun(pageState, text, textMatrix, fontSize, boxSize);
    var textLayer = appended.layer;
    var textLayerIndex = appended.layerIndex;
    text = appended.text;
    if (textLayer == null) {
      textLayerIndex = doc.layers.length;
      this.textStateByLayer[textLayerIndex] = {
        finalizedLines: [],
        penOffsetX: 0,
        lineBaselineY: textMatrix.ty,
        pendingText: "",
        lineFontSize: fontSize,
      };
      textLayer = doc.newLayer();
      doc.layers.push(textLayer);
      textLayer.add.lnsr = "rend";
      textLayer.add.TySh = TextEngineData.createTextLayerData(0, 0);
      textLayer.add.TySh.transform = textMatrix;
    }

    var textState = this.textStateByLayer[textLayerIndex];
    textState.penOffsetX += charSpacing * fontSize;
    textState.pendingText += text;
    var engineData = textLayer.add.TySh.engineData;
    var layerText = TextEngineData.getLayerText(engineData);
    if (boxSize) {
      TextEngineData.setTextType(engineData, 1);
      TextEngineData.setBoxBounds(engineData, [0, 0, Math.ceil(boxSize[0] * textScale), Math.ceil(boxSize[1] * textScale)]);
    }
    var insertIndex = layerText.length - 1;
    var endIndex = insertIndex + text.length;
    TextEngineData.insertText(engineData, insertIndex, text);
    if (this.currentTextStyle == null) this.currentTextStyle = TextEngineData.getTextStyle(engineData, insertIndex, insertIndex);
    var textStyle = this.currentTextStyle;
    this.applyRunTextStyle(textStyle, pageState, fontState, fontSize, textState);
    TextEngineData.applyStyle(engineData, insertIndex, endIndex - 1, textStyle);
    textLayer.syncTextName();
    textLayer.Opct = Math.round(255 * pageState.ca);
  }

  /**
   * Try to append text to the current text layer (as a continuation run or a
   * wrapped line). Returns { layer, layerIndex, text } — layer is null when a
   * fresh text layer is needed; text may gain a leading space or newline.
   */
  appendToExistingTextRun(pageState, text, textMatrix, fontSize, boxSize) {
    var doc = this.doc;
    var textLayerIndex = doc.layers.length - 1;
    while (textLayerIndex >= 0 && doc.layers[textLayerIndex].add.TySh == null) textLayerIndex--;
    if (!(textMatrix.b * textMatrix.b + textMatrix.c * textMatrix.c < .001 && boxSize == null && textLayerIndex >= 0 && doc.layers[textLayerIndex].add.TySh && doc.layers[textLayerIndex].Opct == Math.round(255 * pageState.ca))) {
      return { layer: null, layerIndex: textLayerIndex, text: text };
    }
    var existingLayer = doc.layers[textLayerIndex];
    var textState = this.textStateByLayer[textLayerIndex];
    var layerMatrix = existingLayer.add.TySh.transform;
    var charAdvance = (layerMatrix.tx + textState.penOffsetX - textMatrix.tx) / fontSize;
    var absAdvance = Math.abs(charAdvance);
    var isSingleWord = text.indexOf(" ") == -1;
    var sameOrientation = layerMatrix.a == textMatrix.a && layerMatrix.b == textMatrix.b && layerMatrix.c == textMatrix.c && layerMatrix.d == textMatrix.d;
    var canAppendRun = sameOrientation && Math.abs(textState.lineBaselineY - textMatrix.ty) < 1e-5 && absAdvance < .6;
    var lineGap = textMatrix.ty - textState.lineBaselineY;
    if (canAppendRun) {
      textState.penOffsetX = textMatrix.tx - layerMatrix.tx;
      if (charAdvance > .2 && isSingleWord && [".", ",", "?", ":", "!"].indexOf(text) == -1) text = " " + text;
      return { layer: existingLayer, layerIndex: textLayerIndex, text: text };
    }
    if (sameOrientation && Math.abs(textMatrix.tx - layerMatrix.tx) < 1e-5 && 0 < lineGap && lineGap < fontSize * 1.7 && textState.lineFontSize == fontSize) {
      this.finalizeTextLine(textState);
      textState.lineBaselineY = textMatrix.ty;
      return { layer: existingLayer, layerIndex: textLayerIndex, text: "\n" + text };
    }
    return { layer: null, layerIndex: textLayerIndex, text: text };
  }

  /** Populate a text style run from the current font/paragraph state. */
  applyRunTextStyle(textStyle, pageState, fontState, fontSize, textState) {
    textStyle.textStyle.FontSize = Math.round(fontSize);
    textStyle.textStyle.Tracking = Math.round(fontState.Tc * 100);
    textStyle.textStyle.Underline = fontState.Tun == 1;
    textStyle.textStyle.FillColor = { Type: 1, Values: [1, pageState.colr[0], pageState.colr[1], pageState.colr[2]] };
    if (fontState.Tal != null) textStyle.paraStyle.Justification = fontState.Tal;
    if (textState.finalizedLines.length != 0) {
      textStyle.textStyle.AutoLeading = false;
      textStyle.textStyle.Leading = textState.lineBaselineY - textState.finalizedLines[textState.finalizedLines.length - 1].baselineY;
    }
    var fontName = fontState.Tf;
    fontName = fontName.replace(/#2B/g, "+");
    fontName = fontName.replace(/#2C/g, "-");
    fontName = fontName.split("+").pop();
    if (FONT_ALIASES[fontName]) fontName = FONT_ALIASES[fontName];
    TextEngineData.setTextFont(textStyle, fontName);
  }

  finalizeTextLine(textState) {
    textState.finalizedLines.push({
      xOffset: textState.penOffsetX,
      textFragment: textState.pendingText.slice(textState.finalizedLines.length == 0 ? 0 : 1) + "\n",
      baselineY: textState.lineBaselineY,
      fontSize: textState.lineFontSize,
    });
    textState.penOffsetX = 0;
    textState.pendingText = "";
  }

  PutImage(pageState, pixelData, width, height, alphaData, rgbDecodeOpt, alphaDecodeOpt) {
    if (this.pageFilter != -1 && this.pageFilter != this.pageCount) return;
    var doc = this.doc;
    if (pageState.font.Tmode == 7 && doc.layers[doc.layers.length - 1].add.TySh) return;
    this.updateClipPath(pageState);
    var imageMatrix = arrayToMatrix(pageState.ctm);
    imageMatrix.concat(this.pageMatrix);
    var scaleMatrix = new Matrix2D(1 / width, 0, 0, -1 / height, 0, 1);
    scaleMatrix.concat(imageMatrix);
    imageMatrix = scaleMatrix;

    pixelData = normalizeImageData(pixelData, width, height);
    if (alphaData) alphaData = normalizeImageData(alphaData, width, height);
    if (alphaData == null) {
      if (pixelData.length == width * height * 4) pixelData = encodeRgbaToPng(pixelData, width, height);
    } else {
      pixelData = decodeImageData(pixelData, width, height, rgbDecodeOpt, false);
      alphaData = decodeImageData(alphaData, width, height, alphaDecodeOpt, true);
      var alphaChannel = allocBuffer(width * height);
      extractChannelByte(alphaData, alphaChannel, 0);
      extractChannel(alphaChannel, pixelData, 3);
      pixelData = encodeRgbaToPng(pixelData, width, height);
    }

    var imageLayer = doc.createSmartObjectLayer(pixelData, "Bitmap", 0, 0);
    var layerRect = imageLayer.rect.clone();
    layerRect.x = layerRect.y = 0;
    var cornerCoords = rectToPathOutline(layerRect).coords;
    transformCoordPairs(cornerCoords, imageMatrix, cornerCoords);
    imageLayer.add.placedData.Trnf = packDoublesList(cornerCoords);
    imageLayer.add.placedData.nonAffineTransform = packDoublesList(cornerCoords);
    imageLayer.rasterizeSmartObject(doc, false);
    applyBlendStyle(pageState, imageLayer);
    doc.layers.push(imageLayer);
  }

  ShowPage() {
    var doc = this.doc;
    this.pageCount++;
    var prevBounds = this.prevPageBounds;
    this.finalizeClipGroup();
    var pageLayer = doc.newLayer();
    doc.layers.push(pageLayer);
    var artboardRect = new Rect(Math.round(this.cursor.x), Math.round(this.cursor.y), Math.round(prevBounds[2] - prevBounds[0]), Math.round(prevBounds[3] - prevBounds[1]));
    this.documentRect = this.documentRect.union(artboardRect);
    pageLayer.setArtboardRect(artboardRect);
    pageLayer.add.artb.artboardBackgroundType.v = 3;
    pageLayer.setName("Page " + this.pageCount);
    pageLayer.add.lsct = LayerSectionType.ClosedGroup;
    pageLayer.blendMode = "pass";
    pageLayer.layerFlags = GROUP_LAYER_FLAGS;
  }

  Print(message) {
    console.log("Print:", message);
  }

  Done() {
    var doc = this.doc;
    if (this.pageCount == 1) doc.layers[doc.layers.length - 1].add.lsct = LayerSectionType.OpenGroup;
    doc.initArtboardDocument(this.pageCount);
    for (var loopIdx = 0; loopIdx < doc.layers.length; loopIdx++) {
      var layer = doc.layers[loopIdx];
      var vectorMask = layer.add.vmsk;
      var textShape = layer.add.TySh;
      var textState = this.textStateByLayer[loopIdx];
      layer.updateVectorOrigins();
      if (vectorMask && this.dropIfSubpathTooLong(loopIdx)) {
        loopIdx--;
        continue;
      }
      layer.invalidate(doc);
      if (textShape && textState.finalizedLines.length != 0) this.finalizeTextBox(textShape, textState);
      if (textShape) this.applyTextLineDirection(textShape);
    }
    doc.pendingTextRasterization = true;
    doc.width = this.documentRect.width;
    doc.height = this.documentRect.height;
    doc.buffer = allocBuffer(this.documentRect.area() * 4);
  }

  /** Drop a vector layer whose subpath exceeds the point limit. */
  dropIfSubpathTooLong(loopIdx) {
    var doc = this.doc;
    var pathRecords = doc.layers[loopIdx].add.vmsk.pathRecords;
    var pathTooLong = false;
    for (var recordIdx = 0; recordIdx < pathRecords.length; recordIdx++) {
      var pathRecord = pathRecords[recordIdx];
      if ((pathRecord.type == 0 || pathRecord.type == 3) && pathRecord.length > MAX_SUBPATH_POINTS) pathTooLong = true;
    }
    if (!pathTooLong) return false;
    doc.layers.splice(loopIdx, 1);
    return true;
  }

  /** Finalize a multi-line text layer's box bounds and baseline offset. */
  finalizeTextBox(textShape, textState) {
    this.finalizeTextLine(textState);
    var engineData = textShape.engineData;
    var lineCount = textState.finalizedLines.length;
    var firstLine = textState.finalizedLines[0];
    var maxLineWidth = 0;
    for (var lineIdx = 0; lineIdx < lineCount; lineIdx++) maxLineWidth = Math.max(maxLineWidth, textState.finalizedLines[lineIdx].xOffset);
    TextEngineData.setTextType(engineData, 1);
    textShape.transform.ty -= firstLine.fontSize * .7;
    TextEngineData.setBoxBounds(engineData, [0, 0, Math.ceil(maxLineWidth * 1.1), Math.ceil(textState.finalizedLines[lineCount - 1].baselineY - firstLine.baselineY + firstLine.fontSize * 2)]);
  }

  /** Merge runs and reverse predominantly-Hebrew lines to RTL order. */
  applyTextLineDirection(textShape) {
    var engineData = textShape.engineData;
    TextEngineData.mergeAdjacentRuns(engineData);
    var textLines = TextEngineData.getLayerText(engineData).split("\n");
    for (var lineIdx = 0; lineIdx < textLines.length - 1; lineIdx++) {
      var lineText = textLines[lineIdx];
      var hebrewMarkCount = 0;
      for (var charIdx = 0; charIdx < lineText.length; charIdx++) {
        var charCode = lineText.charCodeAt(charIdx);
        if (HEBREW_MARK_MIN <= charCode && charCode <= HEBREW_MARK_MAX) hebrewMarkCount++;
      }
      if (hebrewMarkCount > lineText.length / 2) {
        textLines[lineIdx] = lineText.split("").reverse().join("");
        var paragraphProps = engineData.EngineDict.ParagraphRun.RunArray[lineIdx].ParagraphSheet.Properties;
        paragraphProps._Direction = 1;
        paragraphProps.Justification = TextEngineData.getJustification(paragraphProps);
      }
    }
    TextEngineData.setLayerText(engineData, textLines.join("\n"));
  }

  static rgbFractionsToColorDesc(rgbFractions) {
    return toRGBDesc({ h: rgbFractions[0] * 255, l: rgbFractions[1] * 255, O: rgbFractions[2] * 255 });
  }

  static applyStrokeStyleFromPathState(strokeStyle, pathState, pageScale, colorDesc) {
    strokeStyle.strokeEnabled.v = true;
    strokeStyle.strokeStyleMiterLimit.v = pathState.mlimit;
    strokeStyle.strokeStyleLineDashSet.v = LayerStyleRenderer.dashArrayToStrokeDescriptor(pathState.dash, 1 / pathState.lwidth);
    strokeStyle.strokeStyleLineDashOffset.v.val = pathState.doff;
    strokeStyle.strokeStyleLineJoinType.v.strokeStyleLineJoinType = LayerEffectDefs.StrokeStyleDefs.join[pathState.ljoin];
    strokeStyle.strokeStyleLineCapType.v.strokeStyleLineCapType = LayerEffectDefs.StrokeStyleDefs.lineCapTypes[pathState.lcap];
    strokeStyle.strokeStyleLineWidth.v.val = Math.max(MIN_STROKE_WIDTH, pathState.lwidth * matrixScale(pathState.ctm) * pageScale);
    strokeStyle.strokeStyleContent.v.Clr.v = colorDesc;
  }

  static applyFillStyle(fillColor, layer, pageMatrix, boundsRect) {
    var fillDescriptor = buildFillDescriptor(fillColor, pageMatrix, boundsRect);
    var layerKey = null;
    var descriptorKeys = null;
    layer.add.vstk.fillEnabled.v = true;
    if (fillDescriptor.type == "SoFi") {
      layerKey = "SoCo";
      descriptorKeys = LayerEffectDefs.solidFillPropertyKeys;
    }
    if (fillDescriptor.type == "GrFl") {
      layerKey = "GdFl";
      descriptorKeys = LayerEffectDefs.gradientOverlayPropertyKeys;
    }
    if (fillDescriptor.type == "patternFill") {
      layerKey = "PtFl";
      descriptorKeys = LayerEffectDefs.patternOverlayPropertyKeys;
    }
    if (layerKey == null) return;
    layer.add[layerKey] = { classID: "null" };
    for (var loopIdx = 0; loopIdx < descriptorKeys.length; loopIdx++) {
      var propKey = descriptorKeys[loopIdx];
      layer.add[layerKey][propKey] = fillDescriptor.value.v[propKey];
    }
  }

  static psdToBlendMode(psdBlendCode) {
    for (var pdfBlendName in BLEND_MODE_MAP) {
      if (BLEND_MODE_MAP[pdfBlendName] == psdBlendCode) return pdfBlendName;
    }
  }
}

export { VectorPageBuilder };
