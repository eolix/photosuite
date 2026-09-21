/**
 * Adobe Illustrator (.ai) import: parses the PostScript/PDF hybrid stream and
 * binary tree into layers, paths, text, gradients, and placed images via
 * {@link VectorPageBuilder}.
 */

import { Point } from "../../core/math/point.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { BinaryUtils } from "../../core/binary/binary-utils.js";

import { FileFormatRegistry } from "./registry/file-format-registry.js";

import { BinaryTreeParser } from "./psd/engine-binary-parsers.js";
import { Document } from "../model/document.js";
import { Layer, LayerSectionType } from "../model/layer.js";
import { LayerEffectDefs } from "./psd/effect-defs.js";
import { TextEngineData } from "../../features/text/text-engine.js";
import { TextLayerData } from "../../features/text/engine-data.js";
import { EngineDataCodec } from "../../features/text/engine-data-codec.js";
import { ImportLayout } from "../import-layout.js";
import { VectorPageBuilder } from "./vector-page-builder.js";
import { Mask, VectorMask } from "../model/layer-masks.js";
import { TransformToolBase } from "../transform/transform-static.js";
import { packDoublesList } from "./psd/descriptor-codec.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { boundsFromCoordPairs, buildCanvasPathRecords, rectToPathOutline, transformCoordPairs } from "../../engine/compositing/anti-alias.js";
import { hasEnoughColorVariety } from "../../engine/compositing/color-math.js";
import { cssStopsToGradientDesc, gradientAngleFromPoints } from "../../engine/compositing/psd-color-utils.js";

const AI_BLEND_MODES = "norm,mul ,scrn,over,sLit,hLit,div ,idiv,dark,lite,diff,smud,hue ,sat ,colr,lum ".split(",");

function matrixToArray(matrix) {
  return [matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty];
}

function AiFormatLoader() {}
AiFormatLoader.parse = function () {

  // ---------------------------------------------------------------------------
  // Top-level entry point
  // ---------------------------------------------------------------------------

  function parseAiDocument(bytes, doc, maxSize) {
    var aiBytes    = readAiBytes(bytes);
    var aiTree     = parseAiStructure(aiBytes);
    if (aiTree.Layer == null) aiTree.Layer = [{ _begin: aiTree.Setup._end, _end: aiBytes.length }];
    var layerBlocks = aiTree.Layer;
    var header      = aiTree.Header;

    aiTree.Setup.Gradient     = loadGradients(aiTree.Setup.Gradient, aiBytes);
    aiTree.Setup.Pattern      = loadPatterns(aiTree.Setup.Pattern, aiBytes);
    aiTree.Setup.Symbol       = loadSymbols(aiTree.Setup.Symbol, aiBytes);
    aiTree.Setup.Palette      = loadPalette(aiTree.Setup.Palette, aiBytes);
    aiTree.Setup.DocumentData = loadStructuredSetup(aiTree.Setup.DocumentData, aiBytes);
    aiTree.Setup.SVGFilter    = loadStructuredSetup(aiTree.Setup.SVGFilter, aiBytes);
    if (aiTree.Setup.ArtStyles) aiTree.Setup.ArtStyles = loadStructuredSetup(aiTree.Setup.ArtStyles, aiBytes);

    doc.patternDocs = doc.patternDocs || {};
    doc.patternIds  = doc.patternIds  || {};

    var cropmarks  = header.Cropmarks;
    var bboxArr    = header.BoundingBox.split(" ").map(parseFloat);
    var artSizeArr = header.ArtSize
      ? header.ArtSize.split(" ").map(parseFloat)
      : [bboxArr[2] - bboxArr[0], bboxArr[3] - bboxArr[1]];

    doc.width  = Math.round(Math.abs(artSizeArr[0]));
    doc.height = Math.round(Math.abs(artSizeArr[1]));

    // Maps AI coordinates (y-up) to screen space (y-down).
    var docTransform = [
      1, 0, 0, 1,
      -bboxArr[0] + (doc.width  - (bboxArr[2] - bboxArr[0])) / 2,
      -bboxArr[1] + (doc.height - (bboxArr[3] - bboxArr[1])) / 2
    ];
    docTransform[3] = -1;
    docTransform[5] = doc.height - docTransform[5];

    if (cropmarks) {
      var cropBounds = cropmarks.split(" ").map(parseFloat);
      doc.width       = Math.round(cropBounds[2] - cropBounds[0]);
      doc.height      = Math.round(cropBounds[3] - cropBounds[1]);
      docTransform    = [1, 0, 0, -1, -cropBounds[0], doc.height + cropBounds[1]];
    }

    var documentData = aiTree.Setup.DocumentData;
    if (documentData && documentData[0] && documentData[0].ArtboardArray) {
      var artboards     = documentData[0].ArtboardArray;
      if (artboards.length !== 1) console.log(artboards.length, "artboards");
      var artboardUnion = new Rect();
      for (var layerIdx = 0; layerIdx < artboards.length; layerIdx++) {
        var artboard   = artboards[layerIdx];
        var pos1     = artboard.PositionPoint1, pos2 = artboard.PositionPoint2;
        var abLeft   = pos1[0];
        var abTop    = Math.min(pos1[1], pos2[1]);
        var abRight  = pos2[0];
        var abBottom = Math.max(pos1[1], pos2[1]);
        artboardUnion = artboardUnion.union(new Rect(abLeft, abTop, abRight - abLeft, abBottom - abTop));
      }
      doc.width        = Math.round(artboardUnion.width);
      doc.height       = Math.round(artboardUnion.height);
      docTransform[4]  = -artboardUnion.x;
      docTransform[5]  = artboardUnion.y + doc.height;
    }

    var scaleFactor = 1 / ImportLayout.computeDocumentDownscale(new Rect(0, 0, doc.width, doc.height), 8192 * 8192);
    if (Math.max(doc.width * scaleFactor, doc.height * scaleFactor) < 800) scaleFactor *= 2;
    while (maxSize && Math.max(doc.width * scaleFactor, doc.height * scaleFactor) < Math.max(maxSize[0], maxSize[1])) scaleFactor++;

    doc.width  = Math.round(doc.width  * scaleFactor);
    doc.height = Math.round(doc.height * scaleFactor);
    doc.dpi    = Math.round(72 * scaleFactor);
    doc.buffer = allocBuffer(doc.width * doc.height * 4);
    for (var i = 0; i < 6; i++) docTransform[i] *= scaleFactor;

    var styleState = { fillKind: "SoCo", strokeKind: "SoCo", fillColor: [0, 0, 0], strokeColor: [0, 0, 0] };

    for (var layerIdx = 0; layerIdx < layerBlocks.length; layerIdx++) {
      var layerBlock  = layerBlocks[layerIdx];
      layerBlock.Raster = collectNestedResources(layerBlock, "Raster");
      layerBlock.Place  = collectNestedResources(layerBlock, "Place");
      var layerLines  = extractLayerLines(aiBytes, layerBlock);
      interpretLayerStream(doc, layerLines, docTransform, aiTree, layerBlock, aiBytes, styleState);
    }
  }

  // ---------------------------------------------------------------------------
  // PostScript-subset interpreter
  // ---------------------------------------------------------------------------

  function interpretLayerStream(doc, lines, ctm, aiTree, layerBlock, rawBytes, styleState) {
    var layerNameStack = [];
    var rasterIdx    = 0;
    var pathOps      = UDOC.G;
    var state        = UDOC.getState();
    var blendMode    = "norm";
    var opacity      = 1;
    var fillKind     = "SoCo";
    var inCompound   = false;
    var compoundFlags = 0;
    var artDictLines          = null;
    var artDictBinary         = false;
    var artDictXContentDepth  = 0;
    var meshLines    = null;
    var meshLineAccum = "";
    var imageParams  = null;
    var colorspaceName = null;
    var isolateFlag  = 0;
    var layerKind    = 0;
    var visFlag      = 0;
    var pathRotation = 0;
    var symbolActive = false;
    var symbolMatrix = null;
    var symbolName   = null;
    var fillColor    = [0, 0, 0];
    var strokeColor  = [0, 0, 0];
    var clipPathStack = [];
    var groupIsolatedStack = [];
    var groupVisibleStack  = [];
    var clipGroupStartStack = [];
    var clipFillPending = false;

    state.ctm = ctm;

    for (var lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      var line = lines[lineIdx];

      // Comment lines, ArtDictionary accumulation, Mesh data accumulation.
      if (line[0] === "%" && !line.endsWith(" Xh")) {
        if (line === "%_/ArtDictionary :") {
          artDictLines         = [line.slice(2)];
          artDictBinary        = false;
          artDictXContentDepth = 0;
        } else if (artDictLines != null) {
          if (line === "%_" && artDictXContentDepth === 0) {
            var artDict = parseStructuredData(artDictLines);
            var uidName = artDict.AI10_ArtUID;
            if (uidName && !uidName.startsWith("XMLID"))
              doc.layers[doc.layers.length - 1].setName(decodeArtUidName(uidName));
            artDictLines = null;
          } else {
            artDictLines.push(line.slice(artDictBinary ? 1 : 2));
            if (line === "%_X=") artDictXContentDepth++;
            if (line === "%_X+") artDictXContentDepth--;
            if (line === "%_/Binary : /ASCII85Decode ,") artDictBinary = true;
            if (artDictBinary && line.endsWith("~>")) artDictBinary = false;
          }
        } else if (meshLines) {
          meshLineAccum += (meshLineAccum === "" ? "" : " ") + line.slice(2);
          if (meshLineAccum.endsWith("X#")) {
            meshLines.push(meshLineAccum.slice(0, meshLineAccum.length - 3));
            meshLineAccum = "";
          }
        }
        continue;
      } else if (line === "/Mesh X!") {
        meshLines     = [];
        meshLineAccum = "";
        continue;
      } else if (line === "/End X!") {
        var meshMask = lookaheadOpacityMask(lines, lineIdx);
        renderMeshGradient(meshLines, state, doc, blendMode, opacity, visFlag, meshMask);
        meshLines = null;
        continue;
      } else if (line.startsWith("/SymbolInstance")) {
        symbolActive = true;
        continue;
      }

      line = line.trim();
      var tokens  = line.split(" ");
      var op      = tokens[tokens.length - 1];
      var opLower = op.toLowerCase();
      var nums    = tokens.map(parseFloat);

      if (op === "m") {
        pathOps.moveTo(state, nums[0], nums[1]);

      } else if (op === "L" || op === "l") {
        pathOps.lineTo(state, nums[0], nums[1]);

      } else if (op === "V" || op === "v") {
        var prevCrds = state.pth.crds, cposX = state.cpos[0], cposY = state.cpos[1];
        pathOps.curveTo(state, cposX, cposY, nums[0], nums[1], nums[2], nums[3]);
        var crdLen = prevCrds.length;
        prevCrds[crdLen - 6] = cposX;
        prevCrds[crdLen - 5] = cposY;

      } else if (op === "Y" || op === "y") {
        pathOps.curveTo(state, nums[0], nums[1], nums[2], nums[3], nums[2], nums[3]);

      } else if (op === "C" || op === "c") {
        pathOps.curveTo(state, nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]);

      } else if (op === "H" || op === "h") {
        if (op === opLower) pathOps.closePath(state);
        clipPathStack.push(JSON.parse(JSON.stringify(state.pth)));

      } else if (op === "XR") {
        pathRotation = nums[0];

      } else if (op === "Xy") {
        blendMode = AI_BLEND_MODES[nums[0]];
        opacity   = nums[1];
        if (blendMode == null) { blendMode = "norm"; console.log("unknown blend mode", nums[0]); }

      } else if (op === "Xd") {
        var lastLayer   = doc.layers[doc.layers.length - 1];
        lastLayer.Opct      = Math.round(255 * opacity);
        lastLayer.blendMode = lastLayer.isGroup() && blendMode === "norm" ? "pass" : blendMode;

      } else if (op === "AE") { isolateFlag = nums[0];
      } else if (op === "Ae") { layerKind   = nums[0];
      } else if (op === "Xw") { visFlag     = nums[0];

      } else if (op === "*") {
        var guideCrds = state.pth.crds;
        var guideAxis = guideCrds[0] === guideCrds[2] ? 0 : 1;
        doc.guides[guideAxis].push(guideCrds[guideAxis]);
        pathOps.newPath(state);

      } else if (symbolActive) {
        if (op === "/RTransformMatrix") {
          symbolMatrix = arrayToMatrix(nums);
        } else if (op === ",") {
          symbolName = extractParenString(line);
        } else if (op === ";") {
          var symEntry = aiTree.Setup.Symbol[symbolName];
          var symXform = new Matrix2D();
          symXform.scale(1, -1);
          if (symbolMatrix) symXform.concat(symbolMatrix);
          symXform.concat(arrayToMatrix(state.ctm));
          if (symEntry) interpretLayerStream(doc, symEntry.VS, matrixToArray(symXform), aiTree, layerBlock, rawBytes, styleState);
          symbolActive = false;
          symbolMatrix = null;
          symbolName   = null;
        }

      } else if (op === "Xh") { imageParams    = nums;
      } else if (op === "XN") { colorspaceName = tokens[0];

      } else if (op === "XI") {
        if (layerBlock.Raster == null) { console.log("no Raster"); continue; }
        var rasterEntry = layerBlock.Raster[rasterIdx++].Data;
        var dataStart   = rasterEntry._begin;
        var dataEnd     = rasterEntry._end;
        while (rawBytes[dataStart] !== 88) dataStart++;
        dataStart += 3;
        var imageData    = rawBytes.slice(dataStart, dataEnd);
        var imgWidth     = imageParams[8];
        var imgHeight    = imageParams[9];
        var pixelCount   = imgWidth * imgHeight;
        var pixelBuf     = allocBuffer(pixelCount * 4);
        pixelBuf.fill(255);
        var chanCount    = { "/DeviceRGB": 3, "/DeviceCMYK": 4, "/DeviceGray": 1 }[colorspaceName];
        var decodeParamLine = lines[lineIdx - 2];
        decodeParamLine = decodeParamLine.slice(decodeParamLine.indexOf("]") + 2).split(" ").map(parseFloat);
        var bitsPerSample = decodeParamLine[6];
        var rowBytes      = Math.ceil(imgWidth * chanCount * bitsPerSample / 8);
        if (colorspaceName === "/DeviceGray") {
          if (bitsPerSample === 8) {
            for (var pi = 0; pi < pixelCount; pi++)
              for (var ch = 0; ch < 3; ch++) pixelBuf[4 * pi + ch] = imageData[pi];
          } else if (bitsPerSample === 1) {
            for (var row = 0; row < imgHeight; row++)
              for (var col = 0; col < imgWidth; col++)
                for (var ch = 0; ch < 3; ch++)
                  pixelBuf[4 * (row * imgWidth + col) + ch] =
                    255 * (imageData[row * rowBytes + (col >>> 3)] >>> (7 - (col & 7)) & 1);
          } else throw bitsPerSample;
        } else if (colorspaceName === "/DeviceRGB") {
          for (var pi = 0; pi < pixelCount; pi++)
            for (var ch = 0; ch < 3; ch++) pixelBuf[4 * pi + ch] = imageData[3 * pi + ch];
        } else if (colorspaceName === "/DeviceCMYK") {
          for (var pi = 0; pi < pixelCount; pi++) {
            var rgb = cmykToRgb([imageData[4*pi]/255, imageData[4*pi+1]/255, imageData[4*pi+2]/255, imageData[4*pi+3]/255]);
            pixelBuf[4*pi] = rgb[0]*255; pixelBuf[4*pi+1] = rgb[1]*255; pixelBuf[4*pi+2] = rgb[2]*255;
          }
        } else throw colorspaceName;
        var totalBytes = imgHeight * rowBytes;
        if (dataEnd - dataStart > totalBytes)
          for (var pi = 0; pi < pixelCount; pi++) pixelBuf[4 * pi + 3] = imageData[totalBytes + pi];
        var fmt        = hasEnoughColorVariety(pixelBuf, imgWidth, imgHeight) ? "JPG" : "PNG";
        var encoded    = FileFormatRegistry.getFormat(fmt).encode([[pixelBuf.buffer]], imgWidth, imgHeight);
        var imgLayer   = doc.createSmartObjectLayer(new Uint8Array(encoded), "<Image>", 0, 0);
        doc.layers.push(imgLayer);
        imgLayer.blendMode = blendMode;
        imgLayer.Opct      = Math.round(255 * opacity);
        imgLayer.setVisible(visFlag === 0);
        var imgMatrix  = new Matrix2D();
        imgMatrix.scale(1, -1);
        imgMatrix.concat(arrayToMatrix(imageParams.slice(1)));
        imgMatrix.concat(arrayToMatrix(state.ctm));
        var imgRect    = imgLayer.rect.clone(); imgRect.x = imgRect.y = 0;
        var corners    = rectToPathOutline(imgRect).coords;
        transformCoordPairs(corners, imgMatrix, corners);
        imgLayer.add.placedData.Trnf              = packDoublesList(corners);
        imgLayer.add.placedData.nonAffineTransform = packDoublesList(corners);
        imgLayer.rasterizeSmartObject(doc, false);

      } else if (op === "Ln") {
        // Push the layer name; the matching layer-end (LB) pops it. Groups and
        // paths are NOT named after their parent layer — the original appends an
        // always-empty suffix here, so a single shared layerName variable (as in
        // the first port) wrongly glued "Layer 1" onto every <Group>/<Path>.
        layerNameStack.push(extractParenString(line));

      } else if (op === "W") {
        // Marks the current path as a clip mask; if it is also filled, that fill
        // is the clip group's background rather than a top-most object.
        clipFillPending = true;

      } else if (op === "u" || op === "q" || op === "Lb") {
        groupIsolatedStack.push(layerKind === 1);
        groupVisibleStack.push((op === "Lb" ? 1 - nums[0] : visFlag) === 0);
        if (inCompound) continue;
        doc.layers.push(doc.createGroupEndLayer());
        if (op === "q") clipGroupStartStack.push(doc.layers.length);

      } else if (op === "U" || op === "Q" || op === "LB") {
        if (groupIsolatedStack.length === 0 || groupVisibleStack.length === 0) throw lineIdx;
        var isIsolated = groupIsolatedStack.pop();
        var isVisible  = groupVisibleStack.pop();
        if (op === "LB") isIsolated = isolateFlag === 1;
        if (inCompound) continue;
        var groupLayer = doc.newLayer();
        groupLayer.setName(op === "U" ? "<Group>" : "<Clip Group>");
        if (op === "LB") groupLayer.setName(layerNameStack.pop());
        if (op === "Q") {
          var clipGroupStart = clipGroupStartStack.pop();
          var clipPath = clipPathStack.pop();
          if (clipPath && !UDOC.G.isBox(clipPath, [0, 0, doc.width, doc.height]))
            attachVectorMask(groupLayer, clipPath, doc);
          if (clipGroupStart != null) moveClipFillToGroupBottom(doc, clipGroupStart);
        }
        groupLayer.add.lsct  = isIsolated ? LayerSectionType.OpenGroup : LayerSectionType.ClosedGroup;
        groupLayer.blendMode = "pass";
        groupLayer.layerFlags = 24;
        groupLayer.setVisible(isVisible);
        doc.layers.push(groupLayer);

      } else if (op === "Bb" || op === "Bh" || op === "BB") {
        // no-op

      } else if (op === "Bg") {
        var gradEntry = aiTree.Setup.Gradient[extractParenString(line)];
        fillKind  = "GdFl";
        fillColor = buildGradientDesc(gradEntry.gradientType, gradEntry.colorStops);

      } else if (op === "Bm" || op === "Xm") {
        var gradType    = fillColor.Type.v.GrdT;
        if (gradType === "Lnr" && op !== "Xm" || gradType === "Rdl" && op !== "Bm") continue;
        var shapeBounds = boundsFromCoordPairs(state.pth.crds);
        var gradOrigin  = new Point(0, 0), gradEnd = new Point(1, 0);
        var gradMat     = new Matrix2D();
        gradMat.concat(arrayToMatrix(nums));
        gradMat.concat(arrayToMatrix(state.ctm));
        gradOrigin = gradMat.transformPoint(gradOrigin);
        gradEnd    = gradMat.transformPoint(gradEnd);
        if (gradType === "Lnr") {
          gradOrigin.x = (gradOrigin.x + gradEnd.x) / 2;
          gradOrigin.y = (gradOrigin.y + gradEnd.y) / 2;
        }
        gradientAngleFromPoints(gradOrigin, gradEnd, shapeBounds, fillColor);

      } else if (op === "p") {
        var patName  = extractParenString(line);
        var patEntry = aiTree.Setup.Pattern[patName];
        if (patEntry.raw == null) {
          var patBounds = patEntry.patternBounds;
          var patW      = Math.round(patBounds[2] - patBounds[0]);
          var patH      = Math.round(patBounds[3] - patBounds[1]);
          var patDoc    = new Document();
          patDoc.width  = patW; patDoc.height = patH;
          patDoc.buffer = allocBuffer(patW * patH * 4);
          interpretLayerStream(patDoc, patEntry.VS || patEntry.patternLines,
            [1, 0, 0, -1, -patEntry.patternBounds[0], patH + patEntry.patternBounds[1]]);
          patEntry.raw = new Uint8Array(FileFormatRegistry.getFormat("PSD").encode(patDoc));
        }
        var afterParen  = line.slice(line.indexOf(")") + 2);
        var patXform    = afterParen.slice(0, afterParen.indexOf("[") - 1).split(" ").map(parseFloat);
        var patMat      = afterParen.slice(afterParen.indexOf("[") + 1, afterParen.indexOf("]")).split(" ").map(parseFloat);
        fillKind  = "patt";
        fillColor = [patName, patXform, patMat];

      } else if (op === "J" || op === "j" || op === "w" || op === "M" || op === "d") {
        for (var ti = 1; ti < tokens.length; ti++) {
          var attrOp = tokens[ti], attrVal = nums[ti - 1];
          if (attrOp === "w") state.lwidth = attrVal;
          if (attrOp === "j") state.ljoin  = attrVal;
          if (attrOp === "J") state.lcap   = attrVal;
          if (attrOp === "d") {
            var dashStr = line.slice(line.indexOf("[") + 1, line.indexOf("]")).trim();
            if (dashStr.length !== 0) state.dash = dashStr.split(" ").map(parseFloat);
          }
        }

      } else if (opLower === "xa" || opLower === "xx") {
        var rgbColor = [nums[4], nums[5], nums[6]];
        fillKind = "SoCo";
        if (op === "Xa" || op === "Xx") fillColor   = rgbColor;
        else                             strokeColor = rgbColor;

      } else if (opLower === "xk") {
        var xkMode  = nums[nums.length - 2];
        var xkColor;
        if      (xkMode === 0) xkColor = cmykToRgb(nums);
        else if (xkMode === 1) xkColor = [nums[4], nums[5], nums[6]];
        else throw line;
        fillKind = "SoCo";
        if (op === "Xk") fillColor   = xkColor;
        else             strokeColor = xkColor;

      } else if (opLower === "k" || opLower === "x") {
        var kNums = nums.slice();
        if (opLower === "x") {
          kNums.pop();
          var kScale = 1 - kNums.pop();
          for (var ci = 0; ci < 4; ci++) kNums[ci] *= kScale;
        }
        var kColor = cmykToRgb(kNums);
        fillKind = "SoCo";
        if (op === opLower) fillColor   = kColor;
        else                strokeColor = kColor;

      } else if (opLower === "g") {
        var grayColor = [nums[0], nums[0], nums[0]];
        fillKind = "SoCo";
        if (op === opLower) fillColor   = grayColor;
        else                strokeColor = grayColor;

      } else if (opLower === "n") {
        clipFillPending = false;
        pathOps.newPath(state);

      } else if (op === "*u") {
        inCompound    = true;
        compoundFlags = 0;

      } else if (op === "*U" || opLower === "s" || opLower === "f" || opLower === "b") {
        if (op !== "*U" && inCompound) {
          if (opLower === "f" || opLower === "b") compoundFlags |= 1;
          if (opLower === "s" || opLower === "b") compoundFlags |= 2;
          continue;
        }
        if (op === opLower) pathOps.closePath(state);
        if (op === "*U") inCompound = false;

        var layer;
        if (fillKind === "patt") {
          var pEntry  = aiTree.Setup.Pattern[fillColor[0]];
          layer       = doc.createSmartObjectLayer(pEntry.raw, "<Pattern>", 0, 0);
          var pRect   = layer.rect.clone(); pRect.x = pRect.y = 0;
          var pCorners = rectToPathOutline(pRect).coords;
          var pMat    = arrayToMatrix(fillColor[2]); pMat.tx = pMat.ty = 0;
          transformCoordPairs(pCorners, pMat, pCorners);
          layer.add.placedData.Trnf              = packDoublesList(pCorners);
          layer.add.placedData.nonAffineTransform = packDoublesList(pCorners);
          layer.rasterizeSmartObject(doc, false);
        } else {
          layer = doc.newLayer();
          layer.layerFlags |= 16;
          var vstk = layer.add.vstk = LayerEffectDefs.getStrokeStyleDefault();
          vstk.strokeEnabled.v = vstk.fillEnabled.v = false;
          if (fillKind === "SoCo") {
            layer.add.SoCo = LayerEffectDefs.getEffectDefault("SoFi");
            writeRgbToColorDesc(layer.add.SoCo.Clr.v, fillColor);
          }
          if (fillKind === "GdFl") layer.add.GdFl = fillColor;
          if (opLower === "f" || opLower === "b" || (op === "*U" && compoundFlags & 1)) vstk.fillEnabled.v = true;
          if (opLower === "s" || opLower === "b" || (op === "*U" && compoundFlags & 2))
            VectorPageBuilder.applyStrokeStyleFromPathState(vstk, state, 1, VectorPageBuilder.rgbFractionsToColorDesc(strokeColor));
        }
        layer.setName("<" + (op === "*U" ? "Compound " : "") + "Path>");
        layer.blendMode = blendMode;
        layer.Opct      = Math.round(255 * opacity);
        layer.setVisible(visFlag === 0);
        attachVectorMask(layer, state.pth, doc);
        doc.layers.push(layer);
        if (clipFillPending) { layer.aiClipFill = true; clipFillPending = false; }
        pathOps.newPath(state);

      } else if (op === "," && tokens[1] === "/StoryIndex") {
        var textDocData = aiTree.Setup.TextDocument;
        if (!(textDocData instanceof Array))
          textDocData = aiTree.Setup.TextDocument = loadTextDocument(textDocData, rawBytes);
        var textResources = textDocData[0];
        var rulerOrigin   = textDocData[2];
        if (textResources._DocumentResources)
          textResources = textDocData[0] = EngineDataCodec.collapseEngineDataWire(textResources);

        var textLayer    = doc.newLayer();
        textLayer.add.lnsr = "rend";
        textLayer.add.TySh = TextEngineData.createTextLayerData(0, 0);
        var edBlocks = TextLayerData.buildEngineDataFromResources(textResources);
        var engineData = textLayer.add.TySh.engineData = edBlocks[nums[0]];
        if (engineData == null) { console.log("text not found"); continue; }
        textLayer.setName(TextEngineData.getLayerText(engineData).slice(0, 50));
        textLayer.blendMode = blendMode;
        textLayer.Opct      = Math.round(255 * opacity);
        textLayer.setVisible(visFlag === 0);

        var storyRef   = textResources._1._1[nums[0]]._1._0[0]._0;
        var storyIndex = parseInt(storyRef.slice(1));
        var frameList  = textResources._0._8._0;
        var frame      = frameList[storyIndex]._0;
        var textPos;
        if (frame._0)       textPos = parseNumericStrings(frame._0);
        else if (frame._1)  textPos = parseNumericStrings(frame._1._0);
        else                textPos = parseNumericStrings(frame._2._2).slice(3);
        if (textPos.length !== 2) {
          var frameBounds = boundsFromCoordPairs(textPos);
          textPos = [frameBounds.x, frameBounds.y];
          if (frameBounds.area() !== 0) {
            TextEngineData.setTextType(engineData, 1);
            TextEngineData.setBoxBounds(engineData, [0, 0, Math.round(frameBounds.width), Math.round(frameBounds.height)]);
          }
        }

        var textMat   = new Matrix2D();
        var posMat    = new Matrix2D(1, 0, 0, 1, textPos[0], textPos[1]);
        var originOff = new Matrix2D(1, 0, 0, 1, -rulerOrigin[0], -rulerOrigin[1]);
        var ctmMat    = arrayToMatrix(state.ctm);
        var sdMat     = new Matrix2D();
        if (frame._2 && frame._2._2) {
          var sdArr = parseNumericStrings(frame._2._2);
          sdMat = new Matrix2D(sdArr[0], sdArr[1], sdArr[2], sdArr[3], sdArr[4], sdArr[5]);
        }
        textMat.concat(posMat);
        textMat.concat(sdMat);
        textMat.concat(originOff);
        textMat.scale(1, -1);
        textMat.concat(ctmMat);
        textLayer.add.TySh.transform = textMat;
        doc.layers.push(textLayer);
        doc.pendingTextRasterization = true;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Mesh gradient renderer
  // ---------------------------------------------------------------------------

  // A mesh fill is a grid of bezier-bounded Coons patches, each carrying a
  // colour (and alpha) at its four corners. The colour varies smoothly in two
  // dimensions across every patch, so a single linear gradient cannot represent
  // it. The patches are rasterised with Gouraud-interpolated colour into an RGBA
  // bitmap, which is then placed as an image layer clipped to the fill outline.
  function renderMeshGradient(meshData, state, doc, blendMode, opacity, visFlag, maskData) {
    var pathOps    = UDOC.G;
    var segments   = [];
    var patches    = [];
    var patchCorners = [];
    var colorSpace = null;
    var chanCount  = 0;
    var cmykMat    = [];
    var version    = 2;

    for (var vi = 0; vi < meshData.length; vi++) {
      var mline = meshData[vi];
      if (mline.endsWith("/Version")) {
        version = parseFloat(mline);

      } else if (mline.endsWith(" /CS")) {
        var nchIdx   = mline.indexOf("/NChannel");
        var processIdx = mline.indexOf("/Process");
        if (mline.startsWith("/DeviceRGB")) {
          colorSpace = "/DeviceRGB"; chanCount = 3;
        } else if (mline.startsWith("/DeviceGray")) {
          colorSpace = "/DeviceGray"; chanCount = 1;
        } else if (mline.startsWith("/DeviceCMYK")) {
          colorSpace = "/DeviceCMYK"; chanCount = 4;
          cmykMat = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
        } else if (nchIdx !== -1) {
          colorSpace = "/DeviceCMYK";
          chanCount  = parseInt(mline.slice(nchIdx - 2, nchIdx - 1));
          var bi = 1;
          for (var di = 0; di < chanCount; di++) {
            bi = mline.indexOf("[", bi);
            cmykMat[chanCount - 1 - di] = mline.slice(bi + 1, bi + 8).split(" ").map(parseFloat);
            bi++;
          }
        } else if (processIdx !== -1) {
          colorSpace = "/DeviceGray"; chanCount = 1;
        } else throw mline;

      } else if (mline[0] === "[") {
        var cb      = mline.indexOf("]");
        var segVals = mline.slice(1, cb).split(" ").map(parseFloat);
        var segKey  = mline.slice(cb + 2);
        if (segKey === "/Size" || segKey === "/P" || segKey === "/R") continue;
        // Geometry offset: with version 2 the colour channels are followed by a
        // single flag value before the corner point and its two bezier handles.
        var base = chanCount + (version === 1 ? 0 : 1);
        var x1, y1, x2, y2, x3, y3;
        if (segKey === "/S" || segKey === "/A") {
          x1 = segVals[0]; y1 = segVals[1]; x2 = segVals[2]; y2 = segVals[3];
          x3 = segVals[4]; y3 = segVals[5];
        } else if (segKey === "/N") {
          x1 = segVals[base + 0]; y1 = segVals[base + 1];
          x2 = segVals[base + 2]; y2 = segVals[base + 3];
          x3 = segVals[base + 5]; y3 = segVals[base + 6];
          var rgb;
          if (colorSpace === "/DeviceRGB") {
            rgb = segVals.slice(0, 3);
          } else if (colorSpace === "/DeviceGray") {
            rgb = [segVals[0], segVals[0], segVals[0]];
          } else if (colorSpace === "/DeviceCMYK") {
            var acc = [0,0,0,0];
            for (var di = 0; di < chanCount; di++) {
              var cv = segVals[di], cw = cmykMat[di];
              acc[0] += cv*cw[0]; acc[1] += cv*cw[1]; acc[2] += cv*cw[2]; acc[3] += cv*cw[3];
            }
            rgb = cmykToRgb(acc);
          } else throw colorSpace;
          // x1/y1 is the corner, x2/y2 the outgoing handle, x3/y3 the incoming.
          patchCorners.push({
            p:   [x1, y1],
            out: [x2, y2],
            in:  [x3, y3],
            col: [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, segVals[chanCount] * 255]
          });
        } else throw segKey;
        segments.push([segKey, x3, y3, x1, y1, x2, y2, x1, y1]);

      } else if (mline === "/E") {
        var sorted = segments.slice(0), nCount = 0;
        for (var di = 0; di < segments.length; di++) {
          if (segments[di][0] === "/N") { nCount++; continue; }
          var es = di, ee = di + 1;
          while (ee < segments.length && segments[ee][0] !== "/N") ee++;
          if (nCount === 0 || nCount === 3) {
            for (var fi = 0; fi < ee - es; fi++) sorted[es + fi] = segments[ee - 1 - fi];
          } else {
            for (var fi = es; fi < ee; fi++) {
              var seg = sorted[fi], tmp;
              tmp = seg[1]; seg[1] = seg[5]; seg[5] = tmp;
              tmp = seg[2]; seg[2] = seg[6]; seg[6] = tmp;
            }
          }
          di = ee - 1;
        }
        var flat = [];
        for (var di = 0; di < sorted.length; di++) {
          var sg = sorted[di];
          flat.push(sg[1], sg[2], sg[3], sg[4], sg[5], sg[6]);
        }
        var fc = flat.length;
        pathOps.moveTo(state, flat[2], flat[3]);
        for (var di = 0; di < fc; di += 6)
          pathOps.curveTo(state, flat[(di+4)%fc], flat[(di+5)%fc], flat[(di+6)%fc],
            flat[(di+7)%fc], flat[(di+8)%fc], flat[(di+9)%fc]);
        pathOps.closePath(state);
        segments = [];
        if (patchCorners.length === 4) patches.push(patchCorners);
        patchCorners = [];
      }
    }

    if (patches.length === 0) { pathOps.newPath(state); return; }
    // An opacity mask (a mesh in the layer's /Mask dictionary) modulates the
    // fill's alpha — used for soft glass reflections that fade to transparent.
    var maskPatches = maskData ? parseMeshPatches(maskData) : null;
    rasterizeMeshPatches(patches, state, doc, blendMode, opacity, visFlag, maskPatches);
    pathOps.newPath(state);
  }

  // Parses the colour/geometry of each Coons patch without building a fill
  // outline; used for opacity-mask meshes whose silhouette is not needed.
  function parseMeshPatches(meshData) {
    var patches = [], patchCorners = [];
    var colorSpace = null, chanCount = 0, cmykMat = [], version = 2;
    for (var vi = 0; vi < meshData.length; vi++) {
      var mline = meshData[vi];
      if (mline.endsWith("/Version")) {
        version = parseFloat(mline);
      } else if (mline.endsWith(" /CS")) {
        var nchIdx = mline.indexOf("/NChannel"), processIdx = mline.indexOf("/Process");
        if (mline.startsWith("/DeviceRGB")) { colorSpace = "/DeviceRGB"; chanCount = 3; }
        else if (mline.startsWith("/DeviceGray")) { colorSpace = "/DeviceGray"; chanCount = 1; }
        else if (mline.startsWith("/DeviceCMYK")) {
          colorSpace = "/DeviceCMYK"; chanCount = 4;
          cmykMat = [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]];
        } else if (nchIdx !== -1) {
          colorSpace = "/DeviceCMYK";
          chanCount = parseInt(mline.slice(nchIdx - 2, nchIdx - 1));
          var bi = 1;
          for (var di = 0; di < chanCount; di++) {
            bi = mline.indexOf("[", bi);
            cmykMat[chanCount - 1 - di] = mline.slice(bi + 1, bi + 8).split(" ").map(parseFloat);
            bi++;
          }
        } else if (processIdx !== -1) { colorSpace = "/DeviceGray"; chanCount = 1; }
        else throw mline;
      } else if (mline[0] === "[") {
        var cb = mline.indexOf("]");
        var segVals = mline.slice(1, cb).split(" ").map(parseFloat);
        if (mline.slice(cb + 2) !== "/N") continue;
        var base = chanCount + (version === 1 ? 0 : 1);
        var rgb;
        if (colorSpace === "/DeviceRGB") rgb = segVals.slice(0, 3);
        else if (colorSpace === "/DeviceGray") rgb = [segVals[0], segVals[0], segVals[0]];
        else if (colorSpace === "/DeviceCMYK") {
          var acc = [0,0,0,0];
          for (var di = 0; di < chanCount; di++) {
            var cv = segVals[di], cw = cmykMat[di];
            acc[0] += cv*cw[0]; acc[1] += cv*cw[1]; acc[2] += cv*cw[2]; acc[3] += cv*cw[3];
          }
          rgb = cmykToRgb(acc);
        } else throw colorSpace;
        patchCorners.push({
          p:   [segVals[base + 0], segVals[base + 1]],
          out: [segVals[base + 2], segVals[base + 3]],
          in:  [segVals[base + 5], segVals[base + 6]],
          col: [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, segVals[chanCount] * 255]
        });
      } else if (mline === "/E") {
        if (patchCorners.length === 4) patches.push(patchCorners);
        patchCorners = [];
      }
    }
    return patches;
  }

  // Scans ahead from a mesh's end for an immediately-following layer /Mask whose
  // art is itself a mesh, returning that mask mesh's data lines (or null).
  function lookaheadOpacityMask(lines, startIdx) {
    var i = startIdx + 1;
    while (i < lines.length && lines[i] === "") i++;
    if (lines[i] !== "%_/ArtDictionary :") return null;
    var inMask = false, maskLines = null, accum = "";
    for (; i < lines.length; i++) {
      var line = lines[i];
      if (line === "%_/Mask :") { inMask = true; continue; }
      if (!inMask) { if (line === "%_") return null; continue; }
      if (line === "%_/Mesh X!") { maskLines = []; accum = ""; continue; }
      if (line === "%_/End X!") break;
      if (maskLines && line.startsWith("%_")) {
        accum += (accum === "" ? "" : " ") + line.slice(2);
        if (accum.endsWith("X#")) { maskLines.push(accum.slice(0, accum.length - 3)); accum = ""; }
      }
    }
    return maskLines;
  }

  // A filled clip-path object is the clip group's background, not a foreground
  // object. The stream draws it last (on top); move it below the clipped content.
  function moveClipFillToGroupBottom(doc, groupStart) {
    for (var i = doc.layers.length - 1; i >= groupStart; i--) {
      if (doc.layers[i].aiClipFill) {
        var layer = doc.layers.splice(i, 1)[0];
        delete layer.aiClipFill;
        doc.layers.splice(groupStart, 0, layer);
        return;
      }
    }
  }

  // Tessellates and Gouraud-rasterises the collected Coons patches into a
  // device-space RGBA bitmap, then inserts that bitmap as a clipped image layer.
  function rasterizeMeshPatches(patches, state, doc, blendMode, opacity, visFlag, maskPatches) {
    var ctmMat = arrayToMatrix(state.ctm);
    var grids  = [];
    var minX =  Infinity, minY =  Infinity, maxX = -Infinity, maxY = -Infinity;

    for (var pi = 0; pi < patches.length; pi++) {
      var patch = patches[pi];
      // Edge control polygons, in boundary order: each edge runs from a corner's
      // outgoing handle to the next corner's incoming handle.
      var edges = [], colors = [];
      for (var ci = 0; ci < 4; ci++) {
        var a = patch[ci], b = patch[(ci + 1) % 4];
        var p0 = ctmMat.transformPoint(new Point(a.p[0],  a.p[1]));
        var p1 = ctmMat.transformPoint(new Point(a.out[0], a.out[1]));
        var p2 = ctmMat.transformPoint(new Point(b.in[0],  b.in[1]));
        var p3 = ctmMat.transformPoint(new Point(b.p[0],  b.p[1]));
        edges.push([p0.x, p0.y, p1.x, p1.y, p2.x, p2.y, p3.x, p3.y]);
        colors.push(patch[ci].col);
      }
      var corners = [
        [edges[0][0], edges[0][1]],  // C0
        [edges[1][0], edges[1][1]],  // C1
        [edges[2][0], edges[2][1]],  // C2
        [edges[3][0], edges[3][1]]   // C3
      ];
      var longest = 0;
      for (var ci = 0; ci < 4; ci++) {
        var dx = corners[(ci + 1) % 4][0] - corners[ci][0];
        var dy = corners[(ci + 1) % 4][1] - corners[ci][1];
        longest = Math.max(longest, Math.sqrt(dx * dx + dy * dy));
      }
      var steps = Math.max(2, Math.min(24, Math.ceil(longest / 3)));

      var gx = [], gy = [], gr = [], gg = [], gb = [], ga = [];
      for (var iv = 0; iv <= steps; iv++) {
        var v = iv / steps;
        for (var iu = 0; iu <= steps; iu++) {
          var u = iu / steps;
          var pt = coonsPatchPoint(edges, corners, u, v);
          gx.push(pt[0]); gy.push(pt[1]);
          var c0 = colors[0], c1 = colors[1], c2 = colors[2], c3 = colors[3];
          var w00 = (1 - u) * (1 - v), w10 = u * (1 - v), w11 = u * v, w01 = (1 - u) * v;
          gr.push(w00 * c0[0] + w10 * c1[0] + w11 * c2[0] + w01 * c3[0]);
          gg.push(w00 * c0[1] + w10 * c1[1] + w11 * c2[1] + w01 * c3[1]);
          gb.push(w00 * c0[2] + w10 * c1[2] + w11 * c2[2] + w01 * c3[2]);
          ga.push(w00 * c0[3] + w10 * c1[3] + w11 * c2[3] + w01 * c3[3]);
          if (pt[0] < minX) minX = pt[0];
          if (pt[0] > maxX) maxX = pt[0];
          if (pt[1] < minY) minY = pt[1];
          if (pt[1] > maxY) maxY = pt[1];
        }
      }
      grids.push({ steps: steps, gx: gx, gy: gy, gr: gr, gg: gg, gb: gb, ga: ga });
    }

    var bx = Math.floor(minX), by = Math.floor(minY);
    var bw = Math.ceil(maxX) - bx, bh = Math.ceil(maxY) - by;
    if (bw <= 0 || bh <= 0 || bw > 16384 || bh > 16384) { return; }
    var bitmap = allocBuffer(bw * bh * 4);

    for (var gi = 0; gi < grids.length; gi++) {
      var grid = grids[gi], n = grid.steps, row = n + 1;
      for (var iv = 0; iv < n; iv++) {
        for (var iu = 0; iu < n; iu++) {
          var i00 = iv * row + iu, i10 = i00 + 1, i01 = i00 + row, i11 = i01 + 1;
          fillGouraudTriangle(bitmap, bw, bh, bx, by, grid, i00, i10, i11);
          fillGouraudTriangle(bitmap, bw, bh, bx, by, grid, i00, i11, i01);
        }
      }
    }

    // An opacity mask scales the fill's alpha by the mask art's coverage
    // (luminance × alpha). Pixels the mask does not reach become transparent,
    // which carves the soft reflection shape out of the underlying fill.
    if (maskPatches) {
      var coverage = new Float32Array(bw * bh);
      for (var mpi = 0; mpi < maskPatches.length; mpi++) {
        var mpatch = maskPatches[mpi];
        var medges = [], mcov = [];
        for (var ci = 0; ci < 4; ci++) {
          var ma = mpatch[ci], mb = mpatch[(ci + 1) % 4];
          var q0 = ctmMat.transformPoint(new Point(ma.p[0],  ma.p[1]));
          var q1 = ctmMat.transformPoint(new Point(ma.out[0], ma.out[1]));
          var q2 = ctmMat.transformPoint(new Point(mb.in[0],  mb.in[1]));
          var q3 = ctmMat.transformPoint(new Point(mb.p[0],  mb.p[1]));
          medges.push([q0.x, q0.y, q1.x, q1.y, q2.x, q2.y, q3.x, q3.y]);
          var mc = mpatch[ci].col;
          mcov.push((0.299 * mc[0] + 0.587 * mc[1] + 0.114 * mc[2]) / 255 * (mc[3] / 255));
        }
        var mcorners = [
          [medges[0][0], medges[0][1]], [medges[1][0], medges[1][1]],
          [medges[2][0], medges[2][1]], [medges[3][0], medges[3][1]]
        ];
        var mlong = 0;
        for (var ci = 0; ci < 4; ci++) {
          var mdx = mcorners[(ci + 1) % 4][0] - mcorners[ci][0];
          var mdy = mcorners[(ci + 1) % 4][1] - mcorners[ci][1];
          mlong = Math.max(mlong, Math.sqrt(mdx * mdx + mdy * mdy));
        }
        var msteps = Math.max(2, Math.min(24, Math.ceil(mlong / 3)));
        var mgx = [], mgy = [], mgc = [];
        for (var iv = 0; iv <= msteps; iv++) {
          var mv = iv / msteps;
          for (var iu = 0; iu <= msteps; iu++) {
            var mu = iu / msteps;
            var mpt = coonsPatchPoint(medges, mcorners, mu, mv);
            mgx.push(mpt[0]); mgy.push(mpt[1]);
            var mw00 = (1 - mu) * (1 - mv), mw10 = mu * (1 - mv), mw11 = mu * mv, mw01 = (1 - mu) * mv;
            mgc.push(mw00 * mcov[0] + mw10 * mcov[1] + mw11 * mcov[2] + mw01 * mcov[3]);
          }
        }
        for (var iv = 0; iv < msteps; iv++) {
          for (var iu = 0; iu < msteps; iu++) {
            var mrow = msteps + 1, mi00 = iv * mrow + iu, mi10 = mi00 + 1, mi01 = mi00 + mrow, mi11 = mi01 + 1;
            fillCoverageTriangle(coverage, bw, bh, bx, by, mgx, mgy, mgc, mi00, mi10, mi11);
            fillCoverageTriangle(coverage, bw, bh, bx, by, mgx, mgy, mgc, mi00, mi11, mi01);
          }
        }
      }
      for (var p = 0; p < bw * bh; p++) bitmap[p * 4 + 3] = Math.round(bitmap[p * 4 + 3] * coverage[p]);
    }

    var meshLayer = doc.createSmartObjectLayer(
      new Uint8Array(FileFormatRegistry.getFormat("PNG").encode([[bitmap.buffer, 0]], bw, bh)),
      "<Mesh>", 0, 0);
    var placeMat = new Matrix2D(1, 0, 0, 1, bx, by);
    var layerRect = meshLayer.rect.clone(); layerRect.x = layerRect.y = 0;
    var corners = rectToPathOutline(layerRect).coords;
    transformCoordPairs(corners, placeMat, corners);
    meshLayer.add.placedData.Trnf              = packDoublesList(corners);
    meshLayer.add.placedData.nonAffineTransform = packDoublesList(corners);
    meshLayer.rasterizeSmartObject(doc, false);
    meshLayer.blendMode = blendMode;
    meshLayer.Opct      = Math.round(255 * opacity);
    meshLayer.setVisible(visFlag === 0);
    attachVectorMask(meshLayer, state.pth, doc);
    doc.layers.push(meshLayer);
  }

  function cubicValue(p0, p1, p2, p3, t) {
    var mt = 1 - t;
    return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
  }

  // Coons surface from four bezier boundary edges. The parameter square maps
  // (0,0)->C0, (1,0)->C1, (1,1)->C2, (0,1)->C3, matching the corner colours.
  function coonsPatchPoint(edges, corners, u, v) {
    var out = [0, 0];
    for (var axis = 0; axis < 2; axis++) {
      var e0 = edges[0], e1 = edges[1], e2 = edges[2], e3 = edges[3];
      var bottom = cubicValue(e0[axis], e0[axis + 2], e0[axis + 4], e0[axis + 6], u);
      var right  = cubicValue(e1[axis], e1[axis + 2], e1[axis + 4], e1[axis + 6], v);
      var top    = cubicValue(e2[axis], e2[axis + 2], e2[axis + 4], e2[axis + 6], 1 - u);
      var left   = cubicValue(e3[axis], e3[axis + 2], e3[axis + 4], e3[axis + 6], 1 - v);
      var c0 = corners[0][axis], c1 = corners[1][axis], c2 = corners[2][axis], c3 = corners[3][axis];
      out[axis] = (1 - v) * bottom + v * top + (1 - u) * left + u * right
        - ((1 - u) * (1 - v) * c0 + u * (1 - v) * c1 + u * v * c2 + (1 - u) * v * c3);
    }
    return out;
  }

  function fillGouraudTriangle(bitmap, width, height, offX, offY, grid, ia, ib, ic) {
    var ax = grid.gx[ia] - offX, ay = grid.gy[ia] - offY;
    var bx = grid.gx[ib] - offX, by = grid.gy[ib] - offY;
    var cx = grid.gx[ic] - offX, cy = grid.gy[ic] - offY;
    var area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0) return;
    var inv = 1 / area;
    var minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    var maxX = Math.min(width  - 1, Math.ceil(Math.max(ax, bx, cx)));
    var minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    var maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
    for (var py = minY; py <= maxY; py++) {
      for (var px = minX; px <= maxX; px++) {
        var fx = px + 0.5, fy = py + 0.5;
        var w0 = ((bx - fx) * (cy - fy) - (by - fy) * (cx - fx)) * inv;
        var w1 = ((cx - fx) * (ay - fy) - (cy - fy) * (ax - fx)) * inv;
        var w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        var o = (py * width + px) * 4;
        bitmap[o]     = w0 * grid.gr[ia] + w1 * grid.gr[ib] + w2 * grid.gr[ic];
        bitmap[o + 1] = w0 * grid.gg[ia] + w1 * grid.gg[ib] + w2 * grid.gg[ic];
        bitmap[o + 2] = w0 * grid.gb[ia] + w1 * grid.gb[ib] + w2 * grid.gb[ic];
        bitmap[o + 3] = w0 * grid.ga[ia] + w1 * grid.ga[ib] + w2 * grid.ga[ic];
      }
    }
  }

  // Single-channel Gouraud fill for opacity-mask coverage in [0,1].
  function fillCoverageTriangle(coverage, width, height, offX, offY, gx, gy, gc, ia, ib, ic) {
    var ax = gx[ia] - offX, ay = gy[ia] - offY;
    var bx = gx[ib] - offX, by = gy[ib] - offY;
    var cx = gx[ic] - offX, cy = gy[ic] - offY;
    var area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0) return;
    var inv = 1 / area;
    var minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    var maxX = Math.min(width  - 1, Math.ceil(Math.max(ax, bx, cx)));
    var minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    var maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
    for (var py = minY; py <= maxY; py++) {
      for (var px = minX; px <= maxX; px++) {
        var fx = px + 0.5, fy = py + 0.5;
        var w0 = ((bx - fx) * (cy - fy) - (by - fy) * (cx - fx)) * inv;
        var w1 = ((cx - fx) * (ay - fy) - (cy - fy) * (ax - fx)) * inv;
        var w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        coverage[py * width + px] = w0 * gc[ia] + w1 * gc[ib] + w2 * gc[ic];
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function buildGradientDesc(gradType, colorStops) {
    var desc = LayerEffectDefs.getEffectDefault("GrFl");
    var grad = desc.Grad.v;
    grad.Intr.v      = 0;
    desc.Type.v.GrdT = ["Lnr", "Rdl"][gradType];
    cssStopsToGradientDesc(colorStops, grad);
    return desc;
  }

  function extractParenString(line) {
    return line.slice(line.indexOf("(") + 1, line.indexOf(")"));
  }

  function writeRgbToColorDesc(colorDesc, rgb) {
    colorDesc.Rd.v  = rgb[0] * 255;
    colorDesc.Grn.v = rgb[1] * 255;
    colorDesc.Bl.v  = rgb[2] * 255;
  }

  function parseNumericStrings(arr) {
    var out = [];
    for (var i = 0; i < arr.length; i++) out[i] = parseFloat(arr[i].slice(1));
    return out;
  }

  function arrayToMatrix(arr) {
    return new Matrix2D(arr[0], arr[1], arr[2], arr[3], arr[4], arr[5]);
  }

  function cmykToRgb(cmyk) {
    return UDOC.C.cmykToRgb(cmyk);
  }

  function attachVectorMask(layer, path, doc) {
    layer.add.vmsk = new VectorMask();
    if (path.crds.length !== 0) layer.add.vmsk.pathRecords = buildVectorMask(path);
    layer.updateVectorOrigins();
    layer.invalidate(doc);
  }

  function buildVectorMask(path) {
    return buildCanvasPathRecords({ H: path.crds, K: path.cmds }, false);
  }

  // ---------------------------------------------------------------------------
  // Section / line extraction
  // ---------------------------------------------------------------------------

  function extractLayerLines(bytes, block) {
    var skipRanges = [], skipped = 0;
    for (var sx = 0; sx < 2; sx++) {
      var key = ["Raster", "Place"][sx], items = block[key];
      if (items == null) continue;
      for (var i = 0; i < items.length; i++) {
        for (var qi = 0; qi < 3; qi++) {
          var chunk = items[i][["Data", "Document", "PlacedObjectPreview"][qi]];
          if (chunk == null) continue;
          if (chunk._begin != null) chunk = [chunk];
          for (var ci = 0; ci < chunk.length; ci++) {
            var begin = chunk[ci]._begin, end = chunk[ci]._end;
            if (begin > end) begin = end;
            skipRanges.push([begin, end]);
          }
        }
      }
    }
    skipRanges.sort(function (a, b) { return a[0] - b[0]; });
    var parts = [block._begin];
    for (var i = 0; i < skipRanges.length; i++) {
      var from = skipRanges[i][0] + 32;
      parts.push(from, skipRanges[i][1]);
      skipped += skipRanges[i][1] - from;
    }
    parts.push(block._end);
    var out = new Uint8Array(block._end - block._begin - skipped), at = 0;
    for (var i = 0; i < parts.length; i += 2) {
      var from = parts[i], len = parts[i + 1] - from;
      out.set(new Uint8Array(bytes.buffer, from, len), at);
      at += len;
    }
    return BinaryUtils.readUtf8(out).split(/\r\n|\r|\n/);
  }

  function loadTextDocument(block, rawBytes) {
    if (block == null) return [];
    var lines = extractLayerLines(rawBytes, block);
    var part0 = "", part1 = "", partIdx = 0, rulerOrigin;
    for (var i = 2; i < lines.length; i++) {
      var line = lines[i];
      if (line[0] === "%") { (partIdx === 0 ? (part0 += line.slice(1)) : (part1 += line.slice(1))); }
      else if (line === ";") partIdx++;
      else if (line.endsWith("/RulerOrigin ,")) rulerOrigin = line.split(" ").slice(0, 2).map(parseFloat);
    }
    var result = [], parts = [part0, part1];
    for (var i = 0; i < 2; i++) {
      var raw = new Uint8Array(parts[i].length);
      BinaryUtils.writeAsciiRaw(raw, 0, parts[i]);
      result.push(BinaryTreeParser.parse(FromPS.F.ASCII85Decode({ buff: raw, off: 0 })));
    }
    result.push(rulerOrigin);
    return result;
  }

  function loadStructuredSetup(block, rawBytes) {
    if (block == null) return [];
    var lines = extractLayerLines(rawBytes, block).slice(1);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.startsWith("%AI17_Begin_Content_if_version_gt") || line === "%AI17_Alternate_Content" || line === "%AI17_End_Versioned_Content") lines[i] = "";
      else if (line[0] === "%") lines[i] = line.slice(line[1] === "_" ? 2 : 1);
    }
    return parseStructuredData(lines);
  }

  function loadPatterns(entries, rawBytes) {
    var map = {};
    if (entries == null) return map;
    for (var i = 0; i < entries.length; i++) {
      var lines  = extractLayerLines(rawBytes, entries[i]);
      var hdr    = lines[1];
      var name   = extractParenString(hdr);
      var xform  = hdr.slice(hdr.indexOf(")") + 2).split(" ").map(parseFloat);
      var body   = [];
      for (var j = 2; j < lines.length; j++) body.push(lines[j].slice(2));
      map[name] = { patternBounds: xform, patternLines: body, VS: body };
    }
    return map;
  }

  function loadGradients(entries, rawBytes) {
    var map = {};
    if (entries == null) return map;
    var gradName, gradType, stops = [];
    for (var i = 0; i < entries.length; i++) {
      var lines = extractLayerLines(rawBytes, entries[i]);
      for (var j = 0; j < lines.length; j++) {
        var line = lines[j];
        if (line[0] === "(") {
          var parts = line.split(")");
          gradName = parts[0].slice(1);
          gradType = parseInt(parts[1].split(" ")[1]);
        } else if (line.endsWith("%_BS")) {
          var vals = line.split(" "); vals.pop(); vals = vals.map(parseFloat);
          var pos = vals.pop(), mid = vals.pop(), mode = vals.pop();
          var col, opa = 1;
          if      (mode === 0) col = [vals[0], vals[0], vals[0]];
          else if (mode === 2) col = [vals[4], vals[5], vals[6]];
          else if (mode === 1 || mode === 3) col = cmykToRgb(vals);
          else if (mode === 6) {
            col = vals.length === 3 ? [vals[0], vals[0], vals[0]] : cmykToRgb(vals);
            opa = vals.pop();
          } else throw mode;
          stops.push([pos / 100, col, opa, mid / 100]);
        } else if (line === "BD") {
          for (var si = 0; si < stops.length - 1; si++) stops[si][3] = stops[si + 1][3];
          stops.sort(function (a, b) { return a[0] - b[0]; });
          map[gradName] = { gradientType: gradType, colorStops: stops };
          stops = [];
        }
      }
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // AI file structure parser
  // ---------------------------------------------------------------------------

  function parseAiStructure(bytes) {
    var sectionTypes = "Gradient PluginObject Symbol Pattern PatternLayer BrushPattern Encoding Raster Layer Resource Place Rider Document".split(" ");
    var pos = 0, len = bytes.length;
    var root = { Header: {} };
    var nodeStack = [root];

    while (pos < len) {
      var lineEnd = pos;
      while (lineEnd !== len && bytes[lineEnd] !== 13 && bytes[lineEnd] !== 10) lineEnd++;
      if (bytes[pos] === 37 && bytes[pos+1] === 95 && bytes[pos+2] === 37) pos += 2;

      if (bytes[pos] === 37 && (bytes[pos+1] === 37 || bytes[pos+1] === 65)) {
        var text = BinaryUtils.readString(bytes, pos, lineEnd - pos);
        if (text === "%%EOF") break;
        if (text !== "%%EndComments" && text !== "%EndComments" &&
            text !== "%AI5_Begin_NonPrinting" && text !== "%AI5_End_NonPrinting--" &&
            !text.startsWith("%AI17_Begin_Content_if_version_gt") && text !== "%AI17_End_Versioned_Content") {
          var beginIdx = text.indexOf("Begin");
          var endIdx   = text.indexOf("End");
          if (beginIdx !== -1) {
            var secName = text.slice(beginIdx + 5).split(":")[0];
            var node    = { _begin: pos, _end: pos };
            var parent  = nodeStack[nodeStack.length - 1];
            if (sectionTypes.indexOf(secName) !== -1) {
              if (parent[secName] == null) parent[secName] = [];
              parent[secName].push(node);
            } else {
              if (parent[secName] != null) { console.log(nodeStack); throw text; }
              parent[secName] = node;
            }
            nodeStack.push(node);
            if (text.startsWith("%%BeginData"))         lineEnd = BinaryUtils.indexOfBytes(bytes, "%%EndData", pos);
            else if (text === "%AI9_BeginDocumentData")  lineEnd = BinaryUtils.indexOfBytes(bytes, "%AI9_EndDocumentData", lineEnd);
            else if (text === "%AI11_BeginTextDocument") lineEnd = BinaryUtils.indexOfBytes(bytes, "%AI11_EndTextDocument", lineEnd);
          } else if (endIdx !== -1) {
            nodeStack.pop()._end = pos;
          } else if (nodeStack.length === 1 && (text.startsWith("%AI") || (text.startsWith("%%") && text.indexOf(" ") !== -1))) {
            var keyStart = 1;
            if (text.startsWith("%AI")) while (text[keyStart] !== "_" && keyStart < text.length) keyStart++;
            var sep = text.indexOf(":");
            if (sep === -1) sep = text.indexOf(" ");
            root.Header[text.slice(keyStart + 1, sep)] = text.slice(sep + 1).trim();
          }
        }
      }
      pos = lineEnd;
      if (bytes[pos] === 13) pos++;
      if (bytes[pos] === 10) pos++;
    }
    return root;
  }

  // ---------------------------------------------------------------------------
  // PDF / EPS private-data extraction and decompression
  // ---------------------------------------------------------------------------

  function decodeAiPrivateStream(data, filters) {
    if (filters != null && typeof filters === "string") filters = [filters];
    if (filters) {
      for (var i = 0; i < filters.length; i++) {
        var filterName = filters[i];
        if      (filterName === "/FlateDecode")    data = pako.inflate(data);
        else if (filterName === "/ASCIIHexDecode") data = FromPS.F.HexDecode({ buff: data, off: 0 });
        else if (filterName === "/ASCII85Decode")  data = FromPS.F.ASCII85Decode({ buff: data, off: 0 });
        else throw filterName;
      }
    }
    return data;
  }

  function readAiPrivateDataFromPdf(pdfBytes, objectMap) {
    var blocks     = new Array(objectMap.length);
    var isDeflated = false, isZstd = false, searchPos = 0;
    for (var i = 0; i < objectMap.length; i++) {
      var objIdx = objectMap[i][0], objNum = objectMap[i][1], filters = null;
      searchPos = BinaryUtils.indexOfBytes(pdfBytes, objNum + " 0 obj", searchPos);
      if (searchPos === -1) searchPos = BinaryUtils.indexOfBytes(pdfBytes, objNum + " 0 obj", 0);
      if (searchPos === -1) throw "ai: PDF object not found";
      var dictStart = BinaryUtils.indexOfBytes(pdfBytes, "<<", searchPos);
      var dictEnd = BinaryUtils.indexOfBytes(pdfBytes, ">>", dictStart);
      var dictBytes = new Uint8Array(pdfBytes.buffer, dictStart, dictEnd - dictStart);
      var filterOff = BinaryUtils.indexOfBytes(dictBytes, "/Filter");
      if (filterOff !== -1) {
        var bracketOff = dictBytes.indexOf("[".charCodeAt(0)) + 1;
        if (bracketOff !== 0) {
          var bracketClose = dictBytes.indexOf("]".charCodeAt(0));
          filters = BinaryUtils.readString(dictBytes, bracketOff, bracketClose - bracketOff).trim().split(/\s+/);
        } else {
          filters = ["/" + BinaryUtils.readString(dictBytes, filterOff + 8, 30).split("/")[0]];
        }
      }
      var lengthOff = BinaryUtils.indexOfBytes(pdfBytes, "/Length", dictStart) + 8, lengthEnd = lengthOff;
      while (lengthEnd < pdfBytes.length && 48 <= pdfBytes[lengthEnd] && pdfBytes[lengthEnd] <= 57) lengthEnd++;
      var streamLen = parseInt(BinaryUtils.readString(pdfBytes, lengthOff, lengthEnd - lengthOff));
      var streamPos = BinaryUtils.indexOfBytes(pdfBytes, "stream", lengthEnd) + 6;
      if (pdfBytes[streamPos] === 13) streamPos++;
      if (pdfBytes[streamPos] === 10) streamPos++;
      var streamHeader = BinaryUtils.readString(pdfBytes, streamPos, 20);
      if      (streamHeader === "%AI12_CompressedData")  { streamPos += 20; streamLen -= 20; isDeflated = true; }
      else if (streamHeader === "%AI24_ZStandard_Data")  { streamPos += 20; streamLen -= 20; isZstd     = true; }
      blocks[objIdx - 1] = decodeAiPrivateStream(new Uint8Array(pdfBytes.buffer, streamPos, streamLen), filters);
    }
    return { blocks, isDeflated, isZstd };
  }

  function aiPdfIndexOfXref(pdfBytes) {
    if (pdfBytes.length < 8) throw "no xref";
    var scanPos = pdfBytes.length - 3;
    while (scanPos >= 0 && FromPS.B.readASCII(pdfBytes, scanPos, 3) !== "%%E") scanPos--;
    if (scanPos < 0) throw "no xref";
    while (scanPos > 0 && pdfBytes[scanPos - 1] === 37) scanPos--;
    var eofMark = scanPos; scanPos--;
    while (scanPos >= 0 && FromPS.isEOL(pdfBytes[scanPos])) scanPos--;
    while (scanPos >= 0 && !FromPS.isEOL(pdfBytes[scanPos])) scanPos--;
    if (scanPos < 0) throw "no xref";
    var offset = parseInt(FromPS.B.readASCII(pdfBytes, scanPos + 1, eofMark - scanPos - 1));
    if (isNaN(offset)) throw "no xref";
    return offset;
  }

  function readAiPrivateDataViaXref(pdfBytes, objectMap) {
    var xrefPos   = aiPdfIndexOfXref(pdfBytes);
    var xrefTable = [];
    var pdfCtx    = { buff: pdfBytes, off: 0 };
    FromPDF.readXrefTrail(pdfBytes, xrefPos, xrefTable);
    var blocks = new Array(objectMap.length), isDeflated = false, isZstd = false;
    for (var i = 0; i < objectMap.length; i++) {
      var objIdx = objectMap[i][0], objNum = objectMap[i][1];
      if (xrefTable[objNum] == null) return { blocks, isDeflated, isZstd, xrefRetry: true, xrefPos };
      var obj = FromPDF.getIndirect(objNum, 0, pdfCtx, xrefTable);
      if (obj == null) return { blocks, isDeflated, isZstd, xrefRetry: true, xrefPos };
      var streamData = obj.buff, filters = obj["/Filter"];
      if (streamData == null) return { blocks, isDeflated, isZstd, xrefRetry: true, xrefPos };
      var headerOff = 0, streamHeader = BinaryUtils.readString(streamData, 0, 20);
      if      (streamHeader === "%AI12_CompressedData") { headerOff = 20; isDeflated = true; }
      else if (streamHeader === "%AI24_ZStandard_Data") { headerOff = 20; isZstd     = true; }
      streamData = new Uint8Array(streamData.buffer, streamData.byteOffset + headerOff, streamData.length - headerOff);
      blocks[objIdx - 1] = decodeAiPrivateStream(streamData, filters);
    }
    return { blocks, isDeflated, isZstd, xrefRetry: false, xrefPos };
  }

  function decompressZstd(compressed) {
    const wasm = FileFormatRegistry.aiCodec.zstdWasmExports;
    var srcLen = compressed.length, mult = 8;
    FileFormatRegistry.growWasmMemory(wasm, 1e6 + srcLen);
    var mem = new Uint8Array(wasm.memory.buffer);
    var srcPtr = wasm.malloc(srcLen);
    mem.set(compressed, srcPtr);
    while (true) {
      FileFormatRegistry.growWasmMemory(wasm, srcLen * (mult + 2) + 1e6);
      var dstPtr = wasm.malloc(srcLen * mult);
      var result = wasm.ZSTD_decompress(dstPtr, srcLen * mult, srcPtr, srcLen);
      if (result === -70) {
        wasm.free(dstPtr);
        if (mult > 256) throw "ai: zstd output buffer too small";
        mult += 4;
      } else {
        var out = new Uint8Array(wasm.memory.buffer).slice(dstPtr, dstPtr + result);
        wasm.free(dstPtr);
        wasm.free(srcPtr);
        return out;
      }
    }
  }

  function readAiBytes(bytes) {
    var raw   = new Uint8Array(bytes);
    var isPdf = raw[2] === 68; // 'D' — PDF magic byte
    var aiData;

    if (isPdf) {
      var metaPos = BinaryUtils.indexOfBytes(raw, "/AIMetaData ");
      if (metaPos === -1) throw "ai: /AIMetaData not found in PDF";
      while (metaPos > 0 && raw[metaPos] !== 60) metaPos--;
      if (metaPos <= 0) throw "ai: malformed /AIMetaData anchor";
      metaPos--;
      var dictEnd   = BinaryUtils.indexOfBytes(raw, ">>", metaPos);
      var parts     = BinaryUtils.readString(raw, metaPos + 2, dictEnd - metaPos - 2).split("/");
      var objectMap = [];
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        var isPrivateChunk  = part.startsWith("AIPrivateData");
        var isPdfPrivateChunk = part.startsWith("AIPDFPrivateData");
        if (!isPrivateChunk && !isPdfPrivateChunk) continue;
        var fieldParts = part.trim().split(/\s+/);
        objectMap.push([parseInt(fieldParts[0].slice(isPrivateChunk ? 13 : 16)), parseInt(fieldParts[1])]);
      }
      var pdfBuf = raw, pdfResult = null;
      for (var attempt = 0; attempt < 32; attempt++) {
        try {
          var xrefResult = readAiPrivateDataViaXref(pdfBuf, objectMap);
          if (!xrefResult.xrefRetry) { pdfResult = xrefResult; break; }
          if (xrefResult.xrefPos <= 0 || pdfBuf.length < 64) break;
          console.log("extra xref after AI");
          pdfBuf = pdfBuf.slice(0, xrefResult.xrefPos);
        } catch (e) { break; }
      }
      if (pdfResult == null) pdfResult = readAiPrivateDataFromPdf(raw, objectMap);
      var blocks     = pdfResult.blocks;
      var isDeflated = pdfResult.isDeflated;
      var isZstd     = pdfResult.isZstd;
      var firstHeader = BinaryUtils.readString(blocks[0], 0, 13);
      if (firstHeader === "%%BoundingBox" || firstHeader === "%AI7_Thumbnai") blocks = blocks.slice(1);
      var secondHeader = BinaryUtils.readString(blocks[0], 0, 13);
      if (secondHeader === "%AI24_ZStanda") { blocks[0] = blocks[0].slice(20); isZstd     = true; }
      if (BinaryUtils.readString(blocks[0], 0, 13) === "%AI12_Compres") { blocks[0] = blocks[0].slice(20); isDeflated = true; }
      aiData = concatPrivateDataBlocks(blocks);
      if (isDeflated) aiData = UZIP.inflate(aiData);
      if (isZstd)     aiData = decompressZstd(aiData);

    } else {
      var epsText = BinaryUtils.readUtf8(raw);
      if (epsText.indexOf("%AI5_BeginLayer") !== -1 || epsText.indexOf("%AI5_NumLayers") !== -1) {
        aiData = raw;
      } else {
        var epsLines = epsText.split(/[\n\r]+/), encoded = [], inStream = false;
        for (var i = 0; i < epsLines.length; i++) {
          var line = epsLines[i].trim();
          if (line === "%AI9_PrivateDataEnd") { break; }
          else if (line === "%AI9_DataStream" || line === "%AI24_DataStream") inStream = true;
          else if (inStream) encoded.push(line.slice(1));
        }
        var encodedBytes  = BinaryUtils.encodeUtf8(encoded.join(""));
        var decodedBytes = FromPS.F.ASCII85Decode({ buff: encodedBytes, off: 0 });
        aiData  = (decodedBytes[0] === 120 && decodedBytes[1] === 156) ? UZIP.inflate(decodedBytes) : decompressZstd(decodedBytes);
      }
    }
    return aiData;
  }

  function concatPrivateDataBlocks(blocks) {
    var total = 0, offset = 0;
    for (var i = 0; i < blocks.length; i++) total += blocks[i].length;
    var out = new Uint8Array(total);
    for (var i = 0; i < blocks.length; i++) { out.set(blocks[i], offset); offset += blocks[i].length; }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Utility / name helpers
  // ---------------------------------------------------------------------------

  function startsWithAny(str, prefixes) {
    for (var i = 0; i < prefixes.length; i++) if (str.startsWith(prefixes[i])) return true;
    return false;
  }

  function decodeArtUidName(encoded) {
    var out = "";
    for (var i = 0; i < encoded.length; i++) {
      if (encoded[i] === "_" && encoded[i + 1] === "x") {
        out += String.fromCharCode(parseInt(encoded.slice(i + 2, i + 4), 16));
        i += 4;
      } else if (encoded[i] === "_") {
        out += " ";
      } else {
        out += encoded[i];
      }
    }
    return out;
  }

  function flattenXmlNode(node) {
    var NAME = "xmlnode-nodename", VALUE = "xmlnode-nodevalue", ATTRS = "xmlnode-attributes", KIDS = "xmlnode-children";
    var attrs = node[ATTRS], children = node[KIDS];
    var out = { _nam: node[NAME] };
    for (var key in attrs) {
      var attr = attrs[key];
      if (Object.keys(attr[ATTRS]).length !== 0 || attr[KIDS].length !== 0) throw "ai: xml attribute node must be flat";
      if (attr[NAME] !== key) throw "ai: xml attribute name mismatch";
      out[key] = attr[VALUE];
    }
    if (children.length === 0) return out;
    var flat = out.cln = [];
    for (var i = 0; i < children.length; i++) flat.push(flattenXmlNode(children[i]));
    return out;
  }

  // ---------------------------------------------------------------------------
  // Structured-data parser (stack-based AI format)
  // ---------------------------------------------------------------------------

  function parseStructuredData(lines) {
    var typeHints = { "/Filter": 3, "/Visible": 1, "/FillOrStroke": 1, "/PluginFileName": 1, "/Title": 1 };
    var defs = {}, stack = [], tokens = tokenizeStructuredLines(lines.join(" "));
    while (tokens.length !== 0) {
      var tok = tokens.shift();
      if (tok === "/Recorded" || tok === "/NotRecorded") {
        continue;
      } else if (tok === "/Dict" || tok === "/Execution") {
        stack.pop();
        var dv = stack.pop(), dh = stack[stack.length - 1];
        if (typeof dh !== "object" || dh === null || typeof dh === "string") throw "ai: dict stack parent must be object";
        dh[tok] = dv;
      } else if (tok === "/Part") {
        stack.pop();
        var pv = stack.pop(), ph = stack[stack.length - 1];
        if (ph[tok] == null) ph[tok] = [];
        ph[tok].push(pv);
        tokens.shift();
      } else if (tok === "/Def") {
        stack.pop();
        var defVal = stack.pop(), defKey = stack[0];
        if (defs[defKey] == null) defs[defKey] = [];
        if (defKey === "/KnownStyle") { defVal = { val: defVal }; defVal[tokens.shift()] = tokens.shift(); }
        stack.pop();
        defs[defKey].push(defVal);
        tokens.shift();
      } else if (tok === ":") {
        var tn = stack.pop();
        if (tn === "/Dictionary" || tn === "/ArtDictionary" || tn === "/XMLNode" || tn === "/Mask" || tn === "/ActiveStyle") stack.push({});
        else if (tn === "/CompoundFilter" || tn === "/BasicFilter") stack.push({ typ: "Filter" });
        else if (tn === "/SVGFilter" || tn === "/KnownStyle") stack.push(tn);
        else if (tn === "/Array" || tn === "/Document") stack.push([]);
        else if (tn === "/Binary") {
          if (tokens.shift() !== "/ASCII85Decode") throw "ai: expected /ASCII85Decode filter";
          tokens.shift(); stack.push(tokens.shift());
        } else if (tn === "/XMLUID" || tn === "/XMLUIDREF") { tokens[1] = tn; }
        else if (tn === "/GObjRef") { stack.push(tokens.shift()); stack.push("/String"); tokens.shift(); tokens.shift(); }
        else throw tn;
        if (tokens[0] === "/NotRecorded") { tokens.shift(); tokens.shift(); }
      } else if (tok === ",") {
        var top = stack.pop(), key, val;
        if (top[0] === "/" && top[1] === top[1].toUpperCase() && top[1] !== "\\" || top === ";") { key = top; top = null; }
        else key = stack.pop();
        if (key === "/Name") { stack.push(key); continue; }
        if (typeHints[key]) {
          val = stack.slice(stack.length - typeHints[key]);
          for (var ti = 0; ti < typeHints[key]; ti++) stack.pop();
          var ho = stack.pop();
          if (typeof ho !== "object" || ho === null || typeof ho === "string") throw "ai: typed field parent must be object";
          ho[key] = val; stack.push(ho); continue;
        }
        if (key === "/RealPoint" || key === "/RealPointRelToROrigin") {
          var yv = stack.pop(); val = [parseFloat(stack.pop()), parseFloat(yv)];
        } else if (key === "/RealMatrix") {
          val = []; for (var mi = 0; mi < 6; mi++) val.push(parseFloat(stack.pop())); val.reverse();
        } else if (key === "/String" && typeof stack[stack.length - 1] !== "string") {
          val = "";
        } else {
          var raw = stack.pop();
          if (key === ";") val = raw;
          else if (key === "/String" || key === "/UnicodeString" || key === "/XMLUID" || key === "/XMLUIDREF") {
            val = raw; while (typeof stack[stack.length - 1] === "string") val = stack.pop() + val;
          } else if (key === "/Int" || key === "/Real") val = parseFloat(raw);
          else if (key === "/Bool") val = raw === "1";
          else throw JSON.stringify(key);
        }
        if (stack.length === 0) throw "ai: structured-data stack underflow";
        if (key === "/String" || key === "/UnicodeString") {
          while (stack.length && stack[stack.length - 1] === key) stack.pop();
        }
        var container = stack.pop();
        if (top == null && !(container instanceof Array)) continue;
        if (typeof container === "string") {
          var pk = container; container = stack.pop();
          if (typeof container !== "object" || container === null) throw "ai: string key parent must be object";
          container[pk] = val; stack.push(container); continue;
        }
        if (top) container[top] = val;
        else container.push(val);
        stack.push(container);
      } else {
        stack.push(tok);
      }
    }
    return stack.length === 0 ? defs : stack[0];
  }

  function tokenizeStructuredLines(text) {
    var out = [], i = 0;
    while (i < text.length) {
      var ch = text[i], code = ch.charCodeAt(0);
      if (ch === " ") { i++; }
      else if (ch === "," || ch === ";" || ch === ":") {
        out.push(ch); i++;
        var prev = out[out.length - 2];
        if (prev === "/ASCII85Decode") {
          var s = i;
          while (s + 1 < text.length && !(text[s] === "~" && text[s+1] === ">")) s++;
          if (s + 1 >= text.length) throw "ai: unterminated ASCII85 blob";
          s += 2;
          out.push(FromPS.F.ASCII85Decode({ off: 0, buff: BinaryUtils.encodeUtf8(text.slice(i, s)) }));
          i = s;
        } else if (prev === "/StrokeStyle" || prev === "/FillStyle" || prev === "/BlendStyle" || prev === "/SimpleStyle" || prev === "/SmoothShadingStyle") {
          var se = i;
          while (se < text.length && text[se] !== ";") se++;
          if (se >= text.length) throw "ai: unterminated style string";
          out.pop(); out.pop();
          out.push(text.slice(i, se)); out.push("/String");
          i = se + 1;
        }
      } else if (ch === "(") {
        var endPos = i + 1;
        while (endPos < text.length && !(text[endPos] === ")" && (text[endPos-1] !== "\\" || text[endPos-2] === "\\"))) endPos++;
        if (endPos >= text.length) throw "ai: unterminated parenthesized string";
        out.push(text.slice(i + 1, endPos)); i = endPos + 1;
      } else if (ch === "/" || ch === "-" || (48 <= code && code <= 57)) {
        var endPos = i;
        while (endPos < text.length && text[endPos] !== " ") endPos++;
        out.push(text.slice(i, endPos)); i = endPos;
      } else if (ch === "X" && text[i+1] === "=") {
        var endPos = i, depth = 0;
        while (endPos < text.length) {
          if (text[endPos] === "X" && text[endPos+1] === "=") depth++;
          if (text[endPos] === "X" && text[endPos+1] === "+") {
            var af = text[endPos+2];
            if (af === " " || af === ";" || endPos + 2 >= text.length) { depth--; if (depth === 0) break; }
          }
          endPos++;
        }
        if (depth !== 0) throw "ai: unbalanced hex blob depth";
        out.push(text.slice(i + 3, endPos)); out.push("/String"); i = endPos + 2;
      } else {
        console.log(out);
        console.log(text.slice(Math.max(0, i - 600), i + 10));
        throw ch;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Resource loaders
  // ---------------------------------------------------------------------------

  function collectNestedResources(block, key) {
    var list = block[key];
    if (list == null) list = [];
    if (block.Layer) {
      for (var i = 0; i < block.Layer.length; i++)
        list = list.concat(collectNestedResources(block.Layer[i], key));
      list.sort(function (a, b) { return a._begin - b._begin; });
    }
    return list;
  }

  function loadSymbols(entries, rawBytes) {
    var map = {};
    if (entries == null) return map;
    for (var i = 0; i < entries.length; i++) {
      var lines = extractLayerLines(rawBytes, entries[i]);
      map[parseAiName(lines[1])] = { VS: lines.slice(2) };
    }
    return map;
  }

  function loadPalette(entries, rawBytes) {
    var list = [];
    if (entries == null) return list;
    var lines = extractLayerLines(rawBytes, entries);
    var nameEntry = null, colorEntry = null;
    for (var i = 1; i < lines.length; i++) {
      var line = lines[i];
      if (line === "0 0 Pb" || line === "PB" || line === "") {}
      else if (line.endsWith("Pc"))  list.push([nameEntry, colorEntry]);
      else if (line[0] === "(")      nameEntry  = parseAiName(line);
      else if (line.endsWith("Bg"))  colorEntry = [1, parseAiName(line)];
      else if (line.endsWith("Pg") || line.endsWith("p")) colorEntry = [2, parseAiName(line)];
      else if (line.endsWith("Xa") || line.endsWith("Xz") || line.endsWith("Xx") || line.endsWith("Xk") ||
               line.endsWith(" g")  || line.endsWith(" x")  || line.endsWith(" k"))  colorEntry = [0, line];
      else if (line.endsWith("Xs")) colorEntry = [0, [0, 0, 0]];
      else if (line.startsWith("%AI17_")) {}
      else if (line === "0 BB" || line === "Bb" || line.endsWith("Bh")) {}
      else throw line;
    }
    return list;
  }

  function parseAiName(text) {
    var end = text.indexOf(")");
    while (text[end - 1] === "\\") end = text.indexOf(")", end + 1);
    return text.slice(text.indexOf("(") + 1, end).replaceAll("\\", "");
  }

  return parseAiDocument;
}();

export { AiFormatLoader };
