// FPNG loader: an Adobe Fireworks source PNG — an ordinary PNG that carries the
// editable Fireworks document (layers, masks, effects) in private `mk*` chunks
// (mkBT / mkBS / mkTS / mkBF).
import { Point } from "../../core/math/point.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { Document } from "../model/document.js";
import { Layer, LayerSectionType } from "../model/layer.js";
import { LayerEffectDefs } from "./psd/effect-defs.js";
import { TextEngineData } from "../../features/text/text-engine.js";
import { Mask, VectorMask } from "../model/layer-masks.js";
import { allocBuffer, extractChannelByte, grayChannelToRgba } from "../../engine/compositing/buffer-utils.js";
import { copyPixels } from "../../engine/compositing/pixel-ops.js";
import { boundsOfPathRecords } from "../../engine/compositing/selection-utils.js";
import { invert } from "../../engine/compositing/color-math.js";
import { cssStopsToGradientDesc, gradientAngleFromPoints } from "../../engine/compositing/psd-color-utils.js";

/* global pako */

/** Fireworks `BLD` blend-mode code → Photoshop blend mode id. */
const FIREWORKS_BLEND_MODE_BY_CODE = {
  "0": "norm",
  "2": "mul ",
  "5": "scrn",
  "7": "diss",
  "9": "dark",
  "10": "lite",
  "37": "idiv",
  "30": "norm",
  "39": "lbrn",
  "41": "vLit",
};

// ---------------------------------------------------------------------------
// Color / buffer helpers
// ---------------------------------------------------------------------------

function argbToRgbaFractions(argb) {
  return [
    (argb >>> 24 & 255) / 255,
    (argb >>> 16 & 255) / 255,
    (argb >>> 8 & 255) / 255,
    (argb >>> 0 & 255) / 255,
  ];
}

function applyArgbToColorDesc(argb, colorDesc) {
  var rgba = argbToRgbaFractions(argb).slice(1);
  var rgbDesc = colorDesc.Clr.v;
  rgbDesc.Rd.v = rgba[0] * 255;
  rgbDesc.Grn.v = rgba[1] * 255;
  rgbDesc.Bl.v = rgba[2] * 255;
}

function fillBufferWithArgb(buffer, argb) {
  var packed = argb & 4278190080 | (argb & 255) << 16 | (argb >>> 8 & 255) << 8 | argb >>> 16 & 255;
  new Uint32Array(buffer.buffer).fill(packed);
}

// ---------------------------------------------------------------------------
// Fireworks binary record parser (mkTS / mkBS payload)
// ---------------------------------------------------------------------------

/**
 * @param {Uint8Array} byteView
 * @param {number} offset
 * @param {number} depth
 * @param {boolean} asArray
 * @returns {{ data: object|Array, pos: number }}
 */
function readBinaryRecord(byteView, offset, depth, asArray) {
  var fields = asArray ? [] : {};
  while (offset < byteView.length - 1 && byteView[offset] != 125) {
    var tag = BinaryUtils.readString(byteView, offset, 3);
    var fieldType = BinaryUtils.readString(byteView, offset + 3, 1);
    var value;
    offset += 4;
    offset++;
    if (fieldType == "v") {
      var childRecord = readBinaryRecord(
        byteView, offset, depth + 1, tag == "ELM" || tag == "TIL",
      );
      value = childRecord.data;
      offset = childRecord.pos;
    } else if (fieldType == "i" || fieldType == "f") {
      var endPos = offset;
      while (byteView[endPos] != 125) endPos++;
      var numberText = BinaryUtils.readString(byteView, offset, endPos - offset);
      value = fieldType == "i" ? parseInt(numberText, 16) : parseFloat(numberText);
      offset = endPos + 1;
    } else if (fieldType == "s") {
      var charCount = BinaryUtils.readUint16(byteView, offset);
      var text = "";
      offset += 2;
      for (var charIdx = 0; charIdx < charCount; charIdx++) {
        text += String.fromCharCode(byteView[offset + 2 * charIdx + 1]);
      }
      value = text;
      offset = offset + 2 * charCount + 1;
    } else if (fieldType == "b") {
      value = byteView[offset] == 49;
      offset = offset + 2;
    } else {
      throw "fpng: unsupported binary record field type";
    }
    if (asArray) {
      fields.push([tag, value]);
    } else if (fields[tag] == null) {
      fields[tag] = value;
    } else {
      if (!(fields[tag] instanceof Array)) fields[tag] = [fields[tag]];
      fields[tag].push(value);
    }
  }
  offset++;
  return { data: fields, pos: offset };
}

// ---------------------------------------------------------------------------
// Tiled pixel assembly (mkBT tiles + mkTS spec)
// ---------------------------------------------------------------------------

function assembleTiledImage(tileSpec, tileBytesById) {
  var tileSize = tileSpec.TSZ;
  var pixelWidth = tileSpec.WPX;
  var pixelHeight = tileSpec.HPX;
  var tiles = tileSpec.TIL;
  var fullRect = new Rect(0, 0, pixelWidth, pixelHeight);
  var outBuffer = allocBuffer(pixelWidth * pixelHeight * 4);
  var tileIdx = 0;
  for (var tileY = 0; tileY < pixelHeight; tileY += tileSize) {
    for (var tileX = 0; tileX < pixelWidth; tileX += tileSize) {
      var tileRect = new Rect(tileX, tileY, tileSize, tileSize);
      var tileBytes;
      var tile = tiles[tileIdx];
      if (tile[0] == "TMC") {
        tileBytes = allocBuffer(tileRect.area() * 4);
        fillBufferWithArgb(tileBytes, tile[1]);
      } else if (tile[0] == "TID") {
        tileBytes = tileBytesById[tile[1]];
      }
      copyPixels(tileBytes, tileRect, outBuffer, fullRect);
      tileIdx++;
    }
  }
  return [outBuffer, fullRect];
}

// ---------------------------------------------------------------------------
// Layer effects (Fireworks EPS → lmfx)
// ---------------------------------------------------------------------------

function setNumericEffectParam(effectParams, paramKey, effectDesc, descKey, offset) {
  var raw = effectParams[paramKey];
  if (offset == null) offset = 0;
  if (raw) effectDesc[descKey].v.val = parseInt(raw) + offset;
}

function applyHexColorToDesc(effectParams, colorKey, effectDesc, descKey) {
  var hex = effectParams[colorKey];
  if (!hex) return;
  hex = hex.slice(1);
  if (hex.length == 6) hex = hex + "ff";
  if (hex.length != 8) throw "fpng: invalid effect color hex";
  var rgba = argbToRgbaFractions(parseInt(hex, 16));
  var rgbDesc = effectDesc[descKey].v;
  rgbDesc.Rd.v = rgba[0] * 255;
  rgbDesc.Grn.v = rgba[1] * 255;
  rgbDesc.Bl.v = rgba[2] * 255;
  effectDesc.Opct.v.val = Math.round(effectDesc.Opct.v.val / 100 * rgba[3] * 100);
}

function buildEffectsDescriptor(effectsSpec, vectorMask) {
  var effectsRoot = LayerEffectDefs.createLmfxRootTemplate();
  for (var slotIdx = 0; slotIdx < LayerEffectDefs.order.length; slotIdx++) {
    effectsRoot[LayerEffectDefs.effectKeys[slotIdx]] = { t: "VlLs", v: [] };
  }
  if (effectsSpec == null) return effectsRoot;
  var effectEntries = effectsSpec.EPS;
  if (!(effectEntries instanceof Array)) effectEntries = [effectEntries];
  for (var effectIdx = 0; effectIdx < effectEntries.length; effectIdx++) {
    var descriptorCells = effectEntries[effectIdx].DCE;
    var params = {};
    for (var cellIdx = 0; cellIdx < descriptorCells.length; cellIdx++) {
      params[descriptorCells[cellIdx].DCK] = descriptorCells[cellIdx].DCV;
    }
    if (params.EffectIsVisible == "false") continue;
    var effectName = params.mkbFile_WriteOnly_TemporaryEffectUiName;
    if (effectName == "Gaussian Blur..." && vectorMask) {
      vectorMask.feather += parseFloat(params.gaussian_blur_radius);
      continue;
    }
    var knownIdx = ["Drop Shadow", "Inner Bevel", "Inner Glow"].indexOf(effectName);
    if (knownIdx == -1) continue;
    var effectKey = ["DrSh", "ebbl", "IrGl"][knownIdx];
    var listKey = LayerEffectDefs.effectKeys[LayerEffectDefs.order.indexOf(effectKey)];
    var effectTemplate = LayerEffectDefs.getEffectDefault(effectKey);
    effectsRoot[listKey].v.unshift({ t: "Objc", v: effectTemplate });
    if (effectKey == "DrSh") {
      effectTemplate.uglg.v = false;
      setNumericEffectParam(params, "ShadowDistance", effectTemplate, "Dstn");
      setNumericEffectParam(params, "ShadowBlur", effectTemplate, "blur");
      setNumericEffectParam(params, "ShadowAngle", effectTemplate, "lagl", 180);
      effectTemplate.Opct.v.val = 100;
      applyHexColorToDesc(params, "ShadowColor", effectTemplate, "Clr");
    }
    if (effectKey == "IrGl") {
      effectTemplate.Md.v.blendMode = "Nrml";
      var maskSoftness = params.MaskSoftness;
      var glowWidth = params.GlowWidth;
      if (maskSoftness && glowWidth) {
        maskSoftness = parseInt(maskSoftness);
        glowWidth = parseInt(glowWidth);
        effectTemplate.blur.v.val = glowWidth + maskSoftness;
        effectTemplate.Ckmt.v.val = Math.round(100 * glowWidth / (glowWidth + maskSoftness));
      }
      setNumericEffectParam(params, "BevelContrast", effectTemplate, "Opct");
      applyHexColorToDesc(params, "OuterBevelColor", effectTemplate, "Clr");
    }
    if (effectKey == "ebbl") {
      effectTemplate.uglg.v = false;
      setNumericEffectParam(params, "BevelWidth", effectTemplate, "blur");
      setNumericEffectParam(params, "AngleSoftness", effectTemplate, "Sftn");
      setNumericEffectParam(params, "BevelContrast", effectTemplate, "srgR");
      setNumericEffectParam(params, "LightAngle", effectTemplate, "lagl");
    }
  }
  return effectsRoot;
}

// ---------------------------------------------------------------------------
// Layer tree
// ---------------------------------------------------------------------------

function getLayerField(record, fieldKey, index) {
  var fieldValue = record[fieldKey];
  return fieldValue instanceof Array ? fieldValue[index] : fieldValue;
}

function buildLayer(layerSpec, doc, layerKind, tileBytesById) {
  var layer = doc.newLayer();
  if (layerSpec.VIS != null) layer.setVisible(layerSpec.VIS);
  if (layerSpec.VIF != null) layer.setVisible(layerSpec.VIF.VIS);
  if (layerSpec.OPA != null) layer.Opct = Math.round(255 * layerSpec.OPA / 1e3);
  layer.blendMode = layerSpec.CLL || layerKind == "GRP" ? "pass" : "norm";
  if (layerSpec.BLD != null) {
    var blendCode = layerSpec.BLD;
    var blendMode = FIREWORKS_BLEND_MODE_BY_CODE[blendCode + ""];
    if (blendMode == null) console.log(layerSpec.OBN, blendCode);
    else layer.blendMode = blendMode;
    if (blendCode == 30) layer.Opct >>>= 1;
  }
  if (layerSpec.CLL) {
    layer.setName(layerSpec.LNM);
    doc.layers.push(doc.createGroupEndLayer());
    var folderChildren = layerSpec.CLL.CEL.ELM;
    for (var childIdx = folderChildren.length - 1; childIdx >= 0; childIdx--) {
      buildLayer(folderChildren[childIdx][1], doc, folderChildren[childIdx][0], tileBytesById);
    }
    layer.add.lsct = layerSpec.DIS ? LayerSectionType.OpenGroup : LayerSectionType.ClosedGroup;
    layer.layerFlags |= 24;
  } else if (layerKind == "GRP") {
    var effectsRoot = layer.add.lmfx = buildEffectsDescriptor(layerSpec.EFL);
    var groupMaskSpec;
    doc.layers.push(doc.createGroupEndLayer());
    var groupChildren = layerSpec.ELM;
    if (layerSpec.MNA && layerSpec.MRX) {
      groupMaskSpec = groupChildren[0][1];
      groupChildren = groupChildren.slice(1);
    }
    layer.setName("Group: " + groupChildren.length + " objects");
    for (var childIdx = groupChildren.length - 1; childIdx >= 0; childIdx--) {
      buildLayer(groupChildren[childIdx][1], doc, groupChildren[childIdx][0], tileBytesById);
    }
    if (groupMaskSpec) {
      var tiledMask = assembleTiledImage(groupMaskSpec, tileBytesById);
      var groupMask = layer.d = new Mask;
      groupMask.rect = tiledMask[1].clone();
      groupMask.rect.x = groupMaskSpec.XLC;
      groupMask.rect.y = groupMaskSpec.YLC;
      groupMask.channel = allocBuffer(groupMask.rect.area());
      extractChannelByte(tiledMask[0], groupMask.channel, 0);
      invert(groupMask.channel);
    }
    layer.add.lsct = LayerSectionType.ClosedGroup;
    layer.layerFlags |= 24;
  } else if (layerKind == "IMG") {
    layer.setName(layerSpec.OBN ? layerSpec.OBN : "Bitmap");
    var tiledImage = assembleTiledImage(layerSpec, tileBytesById);
    layer.rect = tiledImage[1].clone();
    layer.rect.x = layerSpec.XLC;
    layer.rect.y = layerSpec.YLC;
    layer.buffer = tiledImage[0];
  } else if (layerKind == "TXT") {
    var textStyle = layerSpec.TFS;
    var runCount = textStyle.TRN instanceof Array ? textStyle.TRN.length : 1;
    var textContent = "";
    layer.add.lnsr = "rend";
    layer.add.TySh = TextEngineData.createTextLayerData(0, 0);
    layer.add.TySh.boundsRect = new Rect(0, 0, 100, 100);
    var textMatrix = new Matrix2D(1, 0, 0, 1, layerSpec.LFT, layerSpec.TOP);
    if (layerSpec.MTX) {
      var mtx = layerSpec.MTX;
      textMatrix.concat(new Matrix2D(mtx.M00, mtx.M01, mtx.M10, mtx.M11, mtx.M20, mtx.M21));
    }
    layer.add.TySh.transform = textMatrix;
    var engineData = layer.add.TySh.engineData;
    for (var runIdx = 0; runIdx < runCount; runIdx++) {
      var runText = getLayerField(textStyle, "TRN", runIdx);
      TextEngineData.insertText(engineData, textContent.length, runText);
      var styleRun = TextEngineData.getTextStyle(engineData, 0, 1);
      TextEngineData.setTextFont(styleRun, getLayerField(textStyle, "FON", runIdx));
      styleRun.textStyle.FontSize = Math.round(getLayerField(textStyle, "PTS", runIdx));
      var fillArgb = getLayerField(textStyle, "FCL", runIdx);
      styleRun.textStyle.FillColor = { Type: 1, Values: argbToRgbaFractions(fillArgb) };
      TextEngineData.applyStyle(engineData, textContent.length, textContent.length + runText.length, styleRun);
      textContent += runText;
    }
    layer.setName(textContent.slice(0, 255));
    var boxWidth = layerSpec.RIT - layerSpec.LFT;
    var boxHeight = layerSpec.BOT - layerSpec.TOP;
    if (layerSpec.IMG) {
      buildLayer(layerSpec.IMG, doc, "IMG", tileBytesById);
      var rasterLayer = doc.layers.pop();
      layer.buffer = rasterLayer.buffer;
      layer.rect = rasterLayer.rect;
    }
    TextEngineData.setTextType(engineData, 1);
    TextEngineData.setBoxBounds(engineData, [0, 0, boxWidth, boxHeight]);
  } else if (layerKind == "PTH") {
    layer.setName(layerSpec.OBN ? layerSpec.OBN : "Path");
    layer.layerFlags |= 16;
    var rasterizeBitmapInstead = false;
    var vectorMask = layer.add.vmsk = new VectorMask;
    var strokeStyle = layer.add.vstk = LayerEffectDefs.getStrokeStyleDefault();
    var effectsRoot = layer.add.lmfx = buildEffectsDescriptor(layerSpec.EFL, vectorMask);
    var pathBlocks = layerSpec.PBL.PBP;
    if (!(pathBlocks instanceof Array)) pathBlocks = [pathBlocks];
    for (var blockIdx = 0; blockIdx < pathBlocks.length; blockIdx++) {
      var knotList = pathBlocks[blockIdx].PBT;
      var knotType = pathBlocks[blockIdx].ISC ? 0 : 3;
      vectorMask.pathRecords.push({
        type: knotType,
        length: knotList.length,
        fillRule: 0,
        subpathHeaderFlags: 2,
        subpathUint32A: 0,
        subpathUint32B: 0,
      });
      for (var knotIdx = 0; knotIdx < knotList.length; knotIdx++) {
        var knot = knotList[knotIdx];
        var anchorX = knot.XLC;
        var anchorY = knot.YLC;
        var coords = [anchorX, anchorY, anchorX, anchorY, anchorX, anchorY];
        var coordKeys = "XPC YPC XLC YLC XSC YSC".split(" ");
        for (var coordIdx = 0; coordIdx < 6; coordIdx++) {
          var coordKey = coordKeys[coordIdx];
          var coordVal = knot[coordKey];
          if (coordVal != null) coords[coordIdx] = coordVal;
        }
        vectorMask.pathRecords.push({
          type: knotType + 2,
          anchor: new Point(anchorX, anchorY),
          cp1: new Point(coords[0], coords[1]),
          anchorOut: new Point(coords[4], coords[5]),
        });
      }
    }
    layer.updateVectorOrigins();
    var pathBounds = boundsOfPathRecords(vectorMask.pathRecords);
    var pathAttrs = layerSpec.PAT;
    var borderAttrs = pathAttrs.BPL;
    var fillAttrs = pathAttrs.FPL;
    var textureAttrs = pathAttrs.TXF;
    if (fillAttrs && fillAttrs.FEF) vectorMask.feather += fillAttrs.FEF / 2.4;
    if (borderAttrs) {
      var brushCategory = borderAttrs.CAT;
      strokeStyle.strokeEnabled.v = true;
      strokeStyle.strokeStyleLineWidth.v.val = borderAttrs.BDI;
      if (borderAttrs.BDI == 1) {
        strokeStyle.strokeStyleLineAlignment.v.strokeStyleLineAlignment = "strokeStyleAlignInside";
      }
      applyArgbToColorDesc(pathAttrs.BCL, strokeStyle.strokeStyleContent.v);
      if (brushCategory != "bc_Basic" && brushCategory != "bc_Pencil") rasterizeBitmapInstead = true;
    }
    if (fillAttrs == null) {
      strokeStyle.fillEnabled.v = false;
      layer.add.SoCo = LayerEffectDefs.getEffectDefault("SoFi");
      applyArgbToColorDesc(0, layer.add.SoCo);
    } else if (fillAttrs.CAT == "fc_Solid") {
      layer.add.SoCo = LayerEffectDefs.getEffectDefault("SoFi");
      applyArgbToColorDesc(layerSpec.PAT.FCL, layer.add.SoCo);
    } else if (
      fillAttrs.CAT == "fc_Linear" ||
      fillAttrs.CAT == "fc_Circular" ||
      fillAttrs.CAT == "fc_Elliptical"
    ) {
      var isLinear = fillAttrs.CAT == "fc_Linear";
      var gradDesc = layer.add.GdFl = LayerEffectDefs.getEffectDefault("GrFl");
      var gradPayload = gradDesc.Grad.v;
      var cssStops = [];
      var gradStops = fillAttrs.FGL.FGY;
      var colorStops = gradStops.FG0.FGI;
      var alphaStops = gradStops.FG1.FGI;
      for (var stopIdx = 0; stopIdx < colorStops.length; stopIdx++) {
        var colorStop = colorStops[stopIdx];
        var rgba = argbToRgbaFractions(colorStop.FGC);
        var alpha = 1;
        if (alphaStops.length == colorStops.length) {
          alpha = argbToRgbaFractions(alphaStops[stopIdx].FGC)[0];
        }
        cssStops.push([colorStop.FGP, rgba.slice(1), alpha]);
      }
      gradDesc.Type.v.GrdT = isLinear ? "Lnr" : "Rdl";
      cssStopsToGradientDesc(cssStops, gradPayload);
      gradPayload.Intr.v = 0;
      var gradGeom = layerSpec.PRI ? layerSpec.PRI : layerSpec;
      var gradStart = new Point(gradGeom.PSX, gradGeom.PSY);
      var gradEnd = new Point(gradGeom.PEX, gradGeom.PEY);
      if (fillAttrs.CAT == "fc_Elliptical" && gradGeom.PFX != null) {
        var focalPoint = new Point(gradGeom.PFX, gradGeom.PFY);
        var radiusA = Point.dist(gradStart, gradEnd);
        var radiusB = Point.dist(gradStart, focalPoint);
        if (radiusB < radiusA) {
          var swap = radiusA;
          radiusA = radiusB;
          radiusB = swap;
        }
        gradEnd = new Point(gradStart.x + (radiusA + radiusB) / 2, gradStart.y);
        if (radiusA / radiusB < 0.5) rasterizeBitmapInstead = true;
      }
      if (isLinear) {
        gradStart.x = (gradStart.x + gradEnd.x) / 2;
        gradStart.y = (gradStart.y + gradEnd.y) / 2;
      }
      gradientAngleFromPoints(gradStart, gradEnd, pathBounds, gradDesc);
    } else {
      console.log(fillAttrs.CAT);
    }
    if (fillAttrs && fillAttrs.FTB != 0) {
      var patternRaster = assembleTiledImage(textureAttrs.MSK, tileBytesById);
      var patternEntry = {};
      patternEntry.id = Document.generateUID();
      patternEntry.name = "someImage";
      patternEntry.pixelData = patternRaster;
      doc.registerPattern(patternEntry);
      var patternPixels = patternRaster[0];
      for (var pxOff = 0; pxOff < patternPixels.length; pxOff += 4) {
        patternPixels[pxOff + 3] = 255 - patternPixels[pxOff];
        patternPixels[pxOff] = patternPixels[pxOff + 1] = patternPixels[pxOff + 2] = 255;
      }
      var patternDesc = LayerEffectDefs.getEffectDefault("patternFill");
      patternDesc.Opct.v.val = Math.round(fillAttrs.FTB / 10);
      patternDesc.Algn.v = true;
      patternDesc.Ptrn.v.Idnt.v = patternEntry.id;
      effectsRoot.patternFillMulti.v.unshift({ t: "Objc", v: patternDesc });
    }
    if (rasterizeBitmapInstead && layerSpec.IMG) {
      buildLayer(layerSpec.IMG, doc, "IMG", tileBytesById);
      var bitmapLayer = doc.layers[doc.layers.length - 1];
      bitmapLayer.Opct = layer.Opct;
      return;
    }
    layer.invalidate(doc);
  } else {
    console.log("unknown layer type", layerKind, layerSpec);
  }
  doc.layers.push(layer);
}

// ---------------------------------------------------------------------------
// PNG chunk scan (mkTS / mkBT)
// ---------------------------------------------------------------------------

function parseMkChunks(bytes, doc) {
  var byteView = new Uint8Array(bytes);
  var offset = 8;
  var tileSpec;
  var tileBytesById = {};
  while (offset < byteView.length) {
    var chunkLength = BinaryUtils.readUint32BE(byteView, offset);
    offset += 4;
    var chunkTag = BinaryUtils.readString(byteView, offset, 4);
    offset += 4;
    if (chunkTag == "mkTS") {
      var inflated = pako.inflate(byteView.slice(offset, offset + chunkLength));
      tileSpec = readBinaryRecord(inflated, 0, 0).data;
    } else if (chunkTag == "mkBT") {
      var tileId = BinaryUtils.readUint32BE(byteView, offset + 4);
      var pixelFormat = BinaryUtils.readUint32BE(byteView, offset + 8);
      var inflated = pako.inflate(byteView.slice(offset + 76, offset + chunkLength));
      if (pixelFormat == 0) {
        for (var pxOff = 0; pxOff < inflated.length; pxOff += 4) {
          var alpha = inflated[pxOff];
          var blue = inflated[pxOff + 1];
          var green = inflated[pxOff + 2];
          var red = inflated[pxOff + 3];
          inflated[pxOff + 3] = alpha;
          inflated[pxOff + 2] = red;
          inflated[pxOff + 1] = green;
          inflated[pxOff] = blue;
        }
      } else {
        var rgbaBytes = allocBuffer(inflated.length * 4);
        rgbaBytes.fill(255);
        grayChannelToRgba(inflated, rgbaBytes);
        inflated = rgbaBytes;
      }
      tileBytesById[tileId] = inflated;
    }
    offset += chunkLength + 4;
  }
  var docSpec = tileSpec.PDC ? tileSpec.PDC : tileSpec.MKB;
  var docWidth = docSpec.WID;
  var docHeight = docSpec.HIT;
  var backgroundArgb = docSpec.BGC;
  doc.width = docWidth;
  doc.height = docHeight;
  if (backgroundArgb >>> 24 != 0) {
    var bgLayer = doc.newLayer();
    bgLayer.setName("Background");
    doc.layers.push(bgLayer);
    bgLayer.rect = new Rect(0, 0, docWidth, docHeight);
    bgLayer.buffer = allocBuffer(bgLayer.rect.area() * 4);
    fillBufferWithArgb(bgLayer.buffer, backgroundArgb);
  }
  var layerList = (docSpec.LYL ? docSpec : tileSpec).LYL.LAY;
  for (var layerIdx = 0; layerIdx < layerList.length; layerIdx++) {
    buildLayer(layerList[layerIdx], doc, null, tileBytesById);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Fireworks FPNG buffer into layer structure on `doc`.
 * @param {ArrayBuffer} bytes
 * @param {import("../model/document.js").Document} doc
 */
function parse(bytes, doc) {
  parseMkChunks(bytes, doc);
}

const FpngLoader = { parse };

export {
  FpngLoader,
  argbToRgbaFractions,
  getLayerField,
  FIREWORKS_BLEND_MODE_BY_CODE,
};
