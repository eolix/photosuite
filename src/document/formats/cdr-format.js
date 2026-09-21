// CDR (.cdr) RIFF loader — parses compressed cmpr lists, style tables,
// vector geometry, fills, outlines, and text runs into document layers.

import { Point } from "../../core/math/point.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { BinaryUtils } from "../../core/binary/binary-utils.js";

import { Layer, LayerSectionType } from "../model/layer.js";
import { LayerEffectDefs } from "./psd/effect-defs.js";
import { TextEngineData } from "../../features/text/text-engine.js";
import { VectorPageBuilder } from "./vector-page-builder.js";
import { ImportLayout } from "../import-layout.js";
import { RIFFParser } from "./metadata/chunk-container-parser.js";
import { VectorMask } from "../model/layer-masks.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { buildCanvasPathRecords, flattenPathRecordsToPath } from "../../engine/compositing/anti-alias.js";
import { ellipsePathRecords, rectanglePathRecords } from "../../engine/compositing/shape-primitives.js";
import { boundsOfPathRecords } from "../../engine/compositing/selection-utils.js";
import { transformPathRecordCoords } from "../../engine/compositing/path-records.js";
import { toRGBDesc } from "../../engine/compositing/psd-color-utils.js";

/* global pako, UDOC, alert */

function CdrLoader() {}

// ---------------------------------------------------------------------------
// Binary cursor readers (parseState: { data, n, cdrVersion, floatPairByteStride })
// ---------------------------------------------------------------------------

function readUint8AtCursor(parseState) {
  var value = parseState.data[parseState.n];
  parseState.n += 1;
  return value;
}

function readUint16LEAtCursor(parseState) {
  var value = BinaryUtils.readUint16LE(parseState.data, parseState.n);
  parseState.n += 2;
  return value;
}

function readFloat32LEAtCursor(parseState) {
  var value = BinaryUtils.readFloat32(parseState.data, parseState.n);
  parseState.n += 4;
  return value;
}

function readFloat32AtCursorPlus4(parseState) {
  var value = BinaryUtils.readFloat32(parseState.data, parseState.n);
  parseState.n += 8;
  return value;
}

function readInt16LEAtCursor(parseState) {
  var value = BinaryUtils.readInt16LE(parseState.data, parseState.n);
  parseState.n += 2;
  return value;
}

function readInt32LEAtCursor(parseState) {
  var value = BinaryUtils.readInt32LE(parseState.data, parseState.n);
  parseState.n += 4;
  return value;
}

function readFloat64LEAtCursor(parseState) {
  var value = BinaryUtils.readFloat64LE(parseState.data, parseState.n);
  parseState.n += 8;
  return value;
}

function readCStringAtCursor(parseState) {
  if (parseState.n >= parseState.data.length) throw "cdr: read past end of chunk";
  var length = 0;
  while (parseState.data[parseState.n + length] != 0) length++;
  var text = BinaryUtils.readString(parseState.data, parseState.n, length);
  parseState.n += length + 1;
  return text;
}

function readAngleRadiansAtCursor(parseState) {
  if (parseState.cdrVersion < 600) return Math.PI * readInt16LEAtCursor(parseState) / 1800;
  return Math.PI * readInt32LEAtCursor(parseState) / 18e7;
}

function readCoordAtCursor(parseState) {
  if (parseState.cdrVersion < 1500) return readSmallCoordAtCursor(parseState);
  else return readFloat64LEAtCursor(parseState) / 254e3;
}

function readSmallCoordAtCursor(parseState) {
  if (parseState.cdrVersion < 600) return readInt16LEAtCursor(parseState) / 1e3;
  else return readInt32LEAtCursor(parseState) / 254e3;
}

function readCoordOrFloatAtCursor(parseState) {
  if (parseState.cdrVersion < 600) return readUint16LEAtCursor(parseState);
  else return readFloat32LEAtCursor(parseState);
}

function readInt16OrInt32AtCursor(parseState) {
  if (parseState.cdrVersion < 600) return readInt16LEAtCursor(parseState);
  else return readInt32LEAtCursor(parseState);
}

function readFloat32IndexMap(parseState, skipTrailingBytes) {
  var indexMap = {},
    entryCount = readFloat32LEAtCursor(parseState);
  for (var entryIndex = 0; entryIndex < entryCount; entryIndex++) {
    var mapKey = readFloat32LEAtCursor(parseState);
    parseState.n += 4;
    var mapValue = readFloat32LEAtCursor(parseState);
    indexMap[mapKey] = mapValue;
    if (skipTrailingBytes) parseState.n += 48;
  }
  return indexMap;
}

function readPointPairAtCursor(parseState) {
  var x = readSmallCoordAtCursor(parseState),
    y = readSmallCoordAtCursor(parseState);
  return new Point(x, y);
}

function readTextBoxCornerAtCursor(parseState) {
  parseState.n += 4;
  var x = readSmallCoordAtCursor(parseState),
    y = readSmallCoordAtCursor(parseState);
  return new Point(x, y);
}

function buildPathFromCoordBlock(parseState, pointCount) {
  var coordByteStride = parseState.cdrVersion < 600 ? 2 : 4,
    coordBlockStart = parseState.n,
    path = {
      coords: [],
      commands: []
    },
    expectedCoordCount = 0;
  for (var pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    var x = readSmallCoordAtCursor(parseState),
      y = readSmallCoordAtCursor(parseState),
      pointFlags = parseState.data[coordBlockStart + pointCount * coordByteStride * 2 + pointIndex];
    if (!(pointFlags & 64) && !(pointFlags & 128)) {
      path.coords.push(x, y);
      path.commands.push("M");
      expectedCoordCount += 2;
    } else if (pointFlags & 64 && !(pointFlags & 128)) {
      path.coords.push(x, y);
      path.commands.push("L");
      expectedCoordCount += 2;
    } else if (!(pointFlags & 64) && pointFlags & 128) {
      path.coords.push(x, y);
      path.commands.push("C");
      expectedCoordCount += 6;
    } else if (pointFlags & 64 && pointFlags & 128) {
      path.coords.push(x, y);
    }
  }
  if (expectedCoordCount != path.coords.length) throw "cdr: path coord count mismatch";
  return path;
}

function readBezierPathAtCursor(parseState) {
  parseState.n += 4;
  var pointCount = readUint16LEAtCursor(parseState) + readUint16LEAtCursor(parseState);
  parseState.n += 16;
  return buildPathFromCoordBlock(parseState, pointCount);
}

function readPolylinePathAtCursor(parseState) {
  var pointCount = readUint16LEAtCursor(parseState);
  parseState.n += 2;
  return buildPathFromCoordBlock(parseState, pointCount);
}

function cdrVersionFromAsciiByte(asciiByte) {
  if (asciiByte == 32) return 300;
  else if (asciiByte < 49) return 0;
  else if (asciiByte < 58) return 100 * (asciiByte - 48);
  else if (asciiByte < 65) return 0;
  return 100 * (asciiByte - 55);
}

function readColorRgbFloats(parseState, useAltColorPath, colorId) {
  var cdrVersion = parseState.cdrVersion,
    colorModel = 0,
    packedColor = 0;
  if (cdrVersion >= 500) {
    colorModel = readUint16LEAtCursor(parseState);
    if (colorModel == 1 && cdrVersion >= 1300) colorModel = 25;
    if (colorModel == 25 || colorModel == 30) {
      var colorSubModel = 0;
      if (colorModel == 30) {
        colorModel = 25;
        colorSubModel = 30;
      } else {
        colorSubModel = readUint16LEAtCursor(parseState);
        parseState.n += 4;
      }
      var unusedWordA = readUint16LEAtCursor(parseState),
        unusedWordB = readUint16LEAtCursor(parseState);
    } else if (colorModel == 14) throw "cdr: unsupported color model 14";
    else {
      parseState.n += 6;
      packedColor = readFloat32LEAtCursor(parseState);
    }
  } else throw "cdr: color record requires CDR 500+";
  var rgbChannels = [];
  if (colorModel == 2 || colorModel == 9 || colorModel == 17) {
    var cmykBytes = [packedColor >>> 0 & 255, packedColor >>> 8 & 255, packedColor >>> 16 & 255, packedColor >>> 24 & 255];
    if (colorModel == 2)
      for (var channelIndex = 0; channelIndex < 4; channelIndex++) cmykBytes[channelIndex] = Math.round(255 * cmykBytes[channelIndex] / 100);
    for (var channelIndex = 0; channelIndex < 4; channelIndex++) cmykBytes[channelIndex] /= 255;
    rgbChannels = UDOC.C.cmykToRgb(cmykBytes);
  } else if (colorModel == 1 || colorModel == 5) {
    rgbChannels = [packedColor >>> 0 & 255, packedColor >>> 8 & 255, packedColor >>> 16 & 255];
    for (var channelIndex = 0; channelIndex < 3; channelIndex++) rgbChannels[channelIndex] = rgbChannels[channelIndex] / 255;
  }
  return rgbChannels;
}

function decodeIndexedBitmap(bytes, offset) {
  var readFloat32 = BinaryUtils.readFloat32;
  offset += 8;
  var width = readFloat32(bytes, offset);
  offset += 4;
  var height = readFloat32(bytes, offset);
  offset += 4;
  offset += 4 * 7;
  var paletteOffset = offset,
    pixelBuffer = allocBuffer(width * height * 4);
  offset += 1024;
  for (var row = 0; row < height; row++)
    for (var col = 0; col < width; col++) {
      var sourceIndex = row * width + col,
        destIndex = (height - row - 1) * width + col,
        paletteIndex = bytes[offset + sourceIndex] << 2,
        destByteOffset = destIndex << 2;
      pixelBuffer[destByteOffset + 0] = bytes[paletteOffset + paletteIndex + 2];
      pixelBuffer[destByteOffset + 1] = bytes[paletteOffset + paletteIndex + 1];
      pixelBuffer[destByteOffset + 2] = bytes[paletteOffset + paletteIndex + 0];
      pixelBuffer[destByteOffset + 3] = 255;
    }
  return {
    pixels: pixelBuffer,
    rect: new Rect(0, 0, width, height)
  };
}

// ---------------------------------------------------------------------------
// RIFF tree walk — populates chunk.parsedData and nested sub-lists
// ---------------------------------------------------------------------------

function parseRiffChunkList(parseState, chunks, doc, depth) {
  for (var chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    var savedCdrVersion = parseState.cdrVersion,
      chunk = chunks[chunkIndex];
    parseState.n = chunk.dataOffset + (chunk.tag == "LIST" ? 4 : 0);
    if (chunk.tag == "vrsn") {
      var versionNumber = readUint16LEAtCursor(parseState);
      parseState.cdrVersion = versionNumber;
      parseState.floatPairByteStride = versionNumber < 600 ? 16 : 32;
    } else if (chunk.tag == "DISP") {
    } else if (chunk.tag == "LIST" && chunk.listType == "cmpr") {
      var compressedSize = readFloat32LEAtCursor(parseState),
        unusedFloatA = readFloat32LEAtCursor(parseState),
        unusedFloatB = readFloat32LEAtCursor(parseState),
        unusedFloatC = readFloat32LEAtCursor(parseState),
        compressedBytes = new Uint8Array(parseState.data.buffer, parseState.n + 8 + 2, compressedSize - 6 - 8),
        inflatedPrimary = pako.inflateRaw(compressedBytes),
        primaryOffset = 0;
      parseState.n += compressedSize;
      compressedBytes = new Uint8Array(parseState.data.buffer, parseState.n + 8 + 2);
      var inflatedSecondary = pako.inflateRaw(compressedBytes),
        floatTable = [];
      for (var floatOffset = 0; floatOffset < inflatedSecondary.length; floatOffset += 4) floatTable.push(BinaryUtils.readFloat32(inflatedSecondary, floatOffset));
      chunk.sub = [];
      while (primaryOffset < inflatedPrimary.length) {
        var parsedChunk = RIFFParser.parseChunk(inflatedPrimary, primaryOffset, floatTable);
        primaryOffset = parsedChunk.dataOffset + parsedChunk.size;
        chunk.sub.push(parsedChunk);
      }
      var nestedParseState = {
        data: inflatedPrimary,
        n: 0,
        cdrVersion: savedCdrVersion,
        floatPairByteStride: parseState.floatPairByteStride
      };
      parseRiffChunkList(nestedParseState, chunk.sub, doc, depth + 1);
    } else if (chunk.tag == "LIST" && chunk.listType == "stlt") {
      var styleListStart = parseState.n,
        styleRecordStride = 32;
      chunk.parsedData = {};
      var styleEntryCount = readFloat32LEAtCursor(parseState);
      if (styleEntryCount == 0) return;
      chunk.parsedData.fillStyleIndexMap = readFloat32IndexMap(parseState, savedCdrVersion >= 1300);
      chunk.parsedData.outlineStyleIndexMap = readFloat32IndexMap(parseState);
      chunk.parsedData.fontMetricsById = {};
      var fontMetricsCount = readFloat32LEAtCursor(parseState);
      for (var metricsIndex = 0; metricsIndex < fontMetricsCount; metricsIndex++) {
        var fontMetricsId = readFloat32LEAtCursor(parseState);
        parseState.n += savedCdrVersion < 1e3 ? 12 : 20;
        var fontFaceId = readUint16LEAtCursor(parseState),
          typefaceId = readUint16LEAtCursor(parseState);
        parseState.n += 8;
        var fontSize = readSmallCoordAtCursor(parseState);
        parseState.n += savedCdrVersion < 1e3 ? 12 : 20;
        chunk.parsedData.fontMetricsById[fontMetricsId] = {
          fontFaceId: fontFaceId,
          typefaceId: typefaceId,
          fontSize: fontSize
        };
      }
      chunk.parsedData.textAlignmentByIndex = readFloat32IndexMap(parseState);
      var unknownRecordCount = readFloat32LEAtCursor(parseState);
      parseState.n += 52 * unknownRecordCount;
      var unknownBlockCountA = readFloat32LEAtCursor(parseState);
      parseState.n += 152 * unknownBlockCountA;
      var unknownBlockCountB = readFloat32LEAtCursor(parseState);
      parseState.n += 784 * unknownBlockCountB;
      var hyphenationRuleCount = readFloat32LEAtCursor(parseState);
      for (var hyphenIndex = 0; hyphenIndex < hyphenationRuleCount; hyphenIndex++) {
        parseState.n += 40;
        if (savedCdrVersion > 1300) parseState.n += 4;
        if (savedCdrVersion >= 1300) {
          if (readFloat32LEAtCursor(parseState)) parseState.n += 68;
          else parseState.n += 12;
        } else {
          parseState.n += 20;
          if (savedCdrVersion >= 1e3) parseState.n += 8;
          if (readFloat32LEAtCursor(parseState)) parseState.n += 8;
          parseState.n += 8;
        }
      }
      var tabStopCount = readFloat32LEAtCursor(parseState);
      chunk.parsedData.tabStopMetricsById = {};
      for (var tabIndex = 0; tabIndex < tabStopCount; tabIndex++) {
        var tabStopId = readFloat32LEAtCursor(parseState),
          tabStopMetrics = {};
        parseState.n += 12;
        tabStopMetrics.right = readSmallCoordAtCursor(parseState);
        tabStopMetrics.tabCenterOffset = readSmallCoordAtCursor(parseState);
        tabStopMetrics.left = readSmallCoordAtCursor(parseState);
        chunk.parsedData.tabStopMetricsById[tabStopId] = tabStopMetrics;
      }
      var styleAuxRecordCount = readFloat32LEAtCursor(parseState);
      if (savedCdrVersion >= 1300) styleRecordStride += 4;
      parseState.n += styleRecordStride * styleAuxRecordCount;
      var styleExtensionCount = readFloat32LEAtCursor(parseState);
      parseState.n += 28 * styleExtensionCount;
      if (savedCdrVersion > 800) {
        var stylePaddingCount = readFloat32LEAtCursor(parseState);
        parseState.n += 12 * stylePaddingCount;
      }
      chunk.parsedData.styleEntriesById = {};
      for (var styleIndex = 0; styleIndex < styleEntryCount; styleIndex++) {
        var styleTypeId = readFloat32LEAtCursor(parseState),
          styleEntryId = readFloat32LEAtCursor(parseState),
          styleEntry = {};
        styleEntry.parentStyleEntryId = readFloat32LEAtCursor(parseState);
        parseState.n += 8;
        var styleNameByteLength = readFloat32LEAtCursor(parseState);
        if (savedCdrVersion >= 1200) styleNameByteLength *= 2;
        parseState.n += styleNameByteLength;
        styleEntry.fillStyleIndex = readFloat32LEAtCursor(parseState);
        styleEntry.outlineStyleIndex = readFloat32LEAtCursor(parseState);
        if (styleTypeId > 1) {
          styleEntry.fontMetricsId = readFloat32LEAtCursor(parseState);
          styleEntry.alignmentIndex = readFloat32LEAtCursor(parseState);
          parseState.n += 8;
          if (savedCdrVersion > 800) parseState.n += 4;
        }
        if (styleTypeId > 2) parseState.n += 20;
        chunk.parsedData.styleEntriesById[styleEntryId] = styleEntry;
      }
    } else if (chunk.tag == "LIST") {
      parseRiffChunkList(parseState, chunk.sub, doc, depth + 1);
    } else if (chunk.tag == "txsm") {
      chunk.parsedData = {};
      if (savedCdrVersion < 600) throw "cdr: txsm requires CDR 600+";
      if (savedCdrVersion < 700) throw "cdr: txsm requires CDR 700+";
      if (savedCdrVersion >= 1600) throw "cdr: txsm not supported for CDR 1600+";
      if (savedCdrVersion >= 1500) parseState.n += 37;
      else parseState.n += 36;
      if (readFloat32LEAtCursor(parseState)) {
        if (savedCdrVersion < 800) parseState.n += 32;
      }
      if (savedCdrVersion < 800) parseState.n += 4;
      chunk.parsedData.textBlockHeader = readFloat32LEAtCursor(parseState);
      chunk.parsedData.textRuns = [];
      parseState.n += 48;
      if (savedCdrVersion >= 800) {
        if (readFloat32LEAtCursor(parseState)) {
          parseState.n += 32;
          if (savedCdrVersion >= 1300) parseState.n += 8;
        }
      }
      if (savedCdrVersion >= 1500) parseState.n += 12;
      var textRunMode = readFloat32LEAtCursor(parseState),
        runCount = 1,
        textParseAborted = false;
      if (!textRunMode) {
        if (savedCdrVersion >= 800) parseState.n += 4;
        if (savedCdrVersion > 800) parseState.n += 2;
        if (savedCdrVersion >= 1400) parseState.n += 2;
        parseState.n += 24;
        if (savedCdrVersion < 800) parseState.n += 8;
        runCount = readFloat32LEAtCursor(parseState);
      }
      for (var runIndex = 0; runIndex < runCount; runIndex++) {
        var styleEntryId = readFloat32LEAtCursor(parseState),
          charStyleIndex = 0;
        if (savedCdrVersion >= 1300 && textRunMode) parseState.n++;
        parseState.n++;
        var charStyleRunCount = readFloat32LEAtCursor(parseState),
          charStyleRuns = [];
        for (charStyleIndex = 0; charStyleIndex < charStyleRunCount; charStyleIndex++) {
          var charIndex = readUint8AtCursor(parseState),
            charStyleCursor = 0;
          readUint8AtCursor(parseState);
          var charStyleFlags = readUint8AtCursor(parseState);
          if (savedCdrVersion >= 800) charStyleCursor = readUint8AtCursor(parseState);
          var charStyleRun = {};
          if (charStyleFlags & 1) {
            charStyleRun.fontFaceId = readUint16LEAtCursor(parseState);
            var alternateFontFaceId = readUint16LEAtCursor(parseState);
            if (alternateFontFaceId) charStyleRun.alternateFontFaceId = alternateFontFaceId;
          }
          if (charStyleFlags & 2) parseState.n += 4;
          if (charStyleFlags & 4) charStyleRun.charSpacing = readSmallCoordAtCursor(parseState);
          if (charStyleFlags & 8) parseState.n += 4;
          if (charStyleFlags & 16) parseState.n += 4;
          if (charStyleFlags & 32) parseState.n += 4;
          if (charStyleFlags & 64) {
            charStyleRun.fillStyleIndex = readFloat32LEAtCursor(parseState);
            if (savedCdrVersion >= 1500) parseState.n += 48;
          }
          if (charStyleFlags & 128) {
            charStyleRun.outlineStyleIndex = readFloat32LEAtCursor(parseState);
          }
          if (charStyleCursor & 8) {
            if (savedCdrVersion >= 1300) {
              var extraCharByteCount = readFloat32LEAtCursor(parseState);
              if (parseState.n + extraCharByteCount * 2 >= parseState.data.length) {
                textParseAborted = true;
                break;
              }
              parseState.n += extraCharByteCount * 2;
            } else parseState.n += 4;
          }
          if (charStyleCursor & 32) {
            var hasExtendedCharStyle = readUint8AtCursor(parseState);
            if (hasExtendedCharStyle) parseState.n += 52;
          }
          if (charIndex == 2)
            if (savedCdrVersion >= 1300) parseState.n += 48;
          charStyleRuns.push(charStyleRun);
        }
        if (textParseAborted) {
          break;
        }
        var glyphCount = readFloat32LEAtCursor(parseState);
        if (parseState.n + glyphCount * 4 > parseState.data.length) break;
        var glyphFlags = [];
        for (charStyleIndex = 0; charStyleIndex < glyphCount; charStyleIndex++) {
          var rawGlyphWord = 0;
          if (savedCdrVersion >= 1200) rawGlyphWord = readFloat32AtCursorPlus4(parseState) & 4294967295;
          else rawGlyphWord = readFloat32LEAtCursor(parseState);
          glyphFlags[charStyleIndex] = rawGlyphWord >> 16 | rawGlyphWord & 1;
        }
        var stringByteLength = glyphCount;
        if (savedCdrVersion >= 1200) stringByteLength = readFloat32LEAtCursor(parseState);
        var runText = readCStringAtCursor(parseState);
        chunk.parsedData.textRuns.push({
          styleEntryId: styleEntryId,
          text: runText,
          charStyleRuns: charStyleRuns
        });
      }
    } else if (chunk.tag == "font") {
      var fontId = readUint16LEAtCursor(parseState),
        fontFlags = readUint16LEAtCursor(parseState);
      parseState.n += 14;
      var fontName = readCStringAtCursor(parseState);
      chunk.parsedData = {
        id: fontId,
        fontFlags: fontFlags,
        name: fontName
      };
    } else if (["IKEY", "ICMT", "pfrd", "bcfg"].indexOf(chunk.tag) != -1) {
    } else if (chunk.tag == "flgs") {
      chunk.parsedData = readFloat32LEAtCursor(parseState);
    } else if (chunk.tag == "bbox") {
      var bboxLeft = readSmallCoordAtCursor(parseState),
        bboxTop = readSmallCoordAtCursor(parseState),
        bboxRight = readSmallCoordAtCursor(parseState),
        bboxBottom = readSmallCoordAtCursor(parseState);
      chunk.parsedData = new Rect(bboxLeft, bboxTop, bboxRight - bboxLeft, bboxBottom - bboxTop);
    } else if (chunk.tag == "fild") {
      var fillStyleId = readFloat32LEAtCursor(parseState),
        gradientVariant = 0,
        fillPayload;
      if (savedCdrVersion >= 1300) {
        parseState.n += 4;
        gradientVariant = readUint16LEAtCursor(parseState);
        parseState.n += 2;
      }
      var fillType = readUint16LEAtCursor(parseState);
      if (fillType == 0) {
      } else if (fillType == 1) {
        parseState.n += savedCdrVersion >= 1300 ? 13 : 2;
        fillPayload = readColorRgbFloats(parseState);
      } else if (fillType == 2) {
        parseState.n += savedCdrVersion >= 1300 ? 8 : 2;
        var gradientType = readUint8AtCursor(parseState),
          transformSkip = 0;
        if (savedCdrVersion >= 1300) {
          parseState.n += 17;
          transformSkip = readInt16LEAtCursor(parseState);
        } else if (savedCdrVersion >= 600) {
          parseState.n += 19;
          transformSkip = readInt32LEAtCursor(parseState);
        } else {
          parseState.n += 11;
          transformSkip = readInt16LEAtCursor(parseState);
        }
        var gradientAngle = readAngleRadiansAtCursor(parseState),
          centerX = .5 + readInt16OrInt32AtCursor(parseState),
          centerY = .5 + readInt16OrInt32AtCursor(parseState) - .5;
        if (savedCdrVersion >= 600) parseState.n += 2;
        var gradientFlags = readCoordOrFloatAtCursor(parseState) & 255,
          gradientOpacity = readUint8AtCursor(parseState) / 100;
        parseState.n++;
        var stopCount = readCoordOrFloatAtCursor(parseState) & 65535;
        if (savedCdrVersion >= 1300) parseState.n += 3;
        var gradientStops = [];
        for (var stopIndex = 0; stopIndex < stopCount; stopIndex++) {
          var stopColor = readColorRgbFloats(parseState);
          if (savedCdrVersion >= 1300) {
            if (gradientVariant == 158 || savedCdrVersion >= 1600 && gradientVariant == 150) parseState.n += 26;
            else parseState.n += 5;
          }
          var stopPosition = readCoordOrFloatAtCursor(parseState) / 100;
          if (savedCdrVersion >= 1300) parseState.n += 3;
          gradientStops.push([stopPosition, stopColor]);
        }
        fillPayload = {
          typ: gradientType == 1 ? "lin" : "rad",
          crds: [centerX - Math.cos(gradientAngle) / 2, centerY - Math.sin(gradientAngle) / 2, centerX, centerY],
          grad: gradientStops,
          mat: [1, 0, 0, 1, 0, 0]
        };
      }
      chunk.parsedData = {
        id: fillStyleId,
        type: fillType,
        fillPayload: fillPayload
      };
    } else if (chunk.tag == "outl") {
      var outlineStyleId = readFloat32LEAtCursor(parseState);
      if (savedCdrVersion >= 1300) {
        var skipMarker = 0,
          skipBytes = 0;
        while (skipMarker != 1) {
          parseState.n += skipBytes;
          skipMarker = readFloat32LEAtCursor(parseState);
          skipBytes = readFloat32LEAtCursor(parseState);
        }
      }
      var outlineStyleFlags = readUint16LEAtCursor(parseState),
        outlineArrowheadFlags = readUint16LEAtCursor(parseState),
        outlineJoinFlags = readUint16LEAtCursor(parseState);
      if (savedCdrVersion < 1300 && savedCdrVersion >= 600) parseState.n += 2;
      var lineWidth = readSmallCoordAtCursor(parseState),
        lineOpacity = readUint16LEAtCursor(parseState) / 100;
      if (savedCdrVersion >= 600) parseState.n += 2;
      var outlineAngle = readAngleRadiansAtCursor(parseState);
      if (savedCdrVersion >= 1300) parseState.n += 46;
      else if (savedCdrVersion >= 600) parseState.n += 52;
      var outlineColor = readColorRgbFloats(parseState, outlineStyleId == 270963208 || outlineStyleId == 276198e3, outlineStyleId);
      chunk.parsedData = {
        id: outlineStyleId,
        outlineStyleFlags: outlineStyleFlags,
        outlineArrowheadFlags: outlineArrowheadFlags,
        outlineJoinFlags: outlineJoinFlags,
        lineWidth: lineWidth,
        color: outlineColor
      };
    } else if (chunk.tag == "mcfg") {
      if (1300 <= savedCdrVersion) parseState.n += 12;
      else if (900 <= savedCdrVersion) parseState.n += 4;
      else if (600 <= savedCdrVersion && savedCdrVersion < 700) parseState.n += 28;
      var pageWidthPt = 0,
        pageHeightPt = 0;
      if (savedCdrVersion < 400) throw "cdr: mcfg requires CDR 400+";
      else {
        pageWidthPt = readSmallCoordAtCursor(parseState);
        pageHeightPt = readSmallCoordAtCursor(parseState);
      }
      chunk.parsedData = {
        pageSizePt: new Point(pageWidthPt, pageHeightPt)
      };
    } else if (chunk.tag == "loda") {
      var lodaStart = parseState.n,
        lodaFieldA = readCoordOrFloatAtCursor(parseState),
        propertyCount = readCoordOrFloatAtCursor(parseState),
        propertyOffsetTablePos = readCoordOrFloatAtCursor(parseState),
        propertyTypeTablePos = readCoordOrFloatAtCursor(parseState),
        shapeKind = readCoordOrFloatAtCursor(parseState),
        propertyOffsets = [],
        propertyTypes = [];
      parseState.n = lodaStart + propertyOffsetTablePos;
      for (var propertyIndex = 0; propertyIndex < propertyCount; propertyIndex++) propertyOffsets[propertyIndex] = readCoordOrFloatAtCursor(parseState);
      parseState.n = lodaStart + propertyTypeTablePos;
      for (var propertyIndex = propertyCount - 1; propertyIndex >= 0; propertyIndex--) propertyTypes[propertyIndex] = readCoordOrFloatAtCursor(parseState);
      chunk.parsedData = {};
      for (var propertyIndex = 0; propertyIndex < propertyCount; propertyIndex++) {
        parseState.n = lodaStart + propertyOffsets[propertyIndex];
        var propertyType = propertyTypes[propertyIndex];
        if (propertyType == 10) chunk.parsedData.outlineStyleIndex = readFloat32LEAtCursor(parseState);
        else if (propertyType == 20) chunk.parsedData.fillStyleIndex = readFloat32LEAtCursor(parseState);
        else if (propertyType == 200) chunk.parsedData.reservedObjectField = readCoordOrFloatAtCursor(parseState);
        else if (propertyType == 30) {
          if (savedCdrVersion < 400) shapeKind--;
          if (shapeKind == 1) {
            var rectWidth = readCoordAtCursor(parseState),
              rectHeight = readCoordAtCursor(parseState),
              cornerRadiusTopLeft = 0,
              cornerRadiusTopRight = 0,
              cornerRadiusBottomRight = 0,
              cornerRadiusBottomLeft = 0;
            if (savedCdrVersion < 1500) {
              cornerRadiusBottomLeft = readCoordAtCursor(parseState);
              cornerRadiusBottomRight = savedCdrVersion < 900 ? cornerRadiusBottomLeft : readCoordAtCursor(parseState);
              cornerRadiusTopRight = savedCdrVersion < 900 ? cornerRadiusBottomLeft : readCoordAtCursor(parseState);
              cornerRadiusTopLeft = savedCdrVersion < 900 ? cornerRadiusBottomLeft : readCoordAtCursor(parseState);
            } else throw "cdr: rounded rect requires CDR before 1500";
            chunk.parsedData.path = flattenPathRecordsToPath(rectanglePathRecords(0, 0, rectWidth, rectHeight, cornerRadiusTopLeft));
          } else if (shapeKind == 2) {
            var ellipseRadiusX = readSmallCoordAtCursor(parseState),
              ellipseRadiusY = readSmallCoordAtCursor(parseState),
              ellipseStartAngle = readAngleRadiansAtCursor(parseState),
              ellipseEndAngle = readAngleRadiansAtCursor(parseState),
              ellipseWidth = Math.abs(ellipseRadiusX),
              ellipseHeight = Math.abs(ellipseRadiusY);
            chunk.parsedData.path = flattenPathRecordsToPath(ellipsePathRecords(0, 0, ellipseWidth, -ellipseHeight));
          } else if (shapeKind == 3) {
            chunk.parsedData.path = readPolylinePathAtCursor(parseState);
          } else if (shapeKind == 4) {
            chunk.parsedData.textPointAnchor = readPointPairAtCursor(parseState);
          } else if (shapeKind == 6) {
            chunk.parsedData.textBoxSize = readTextBoxCornerAtCursor(parseState);
          } else if (shapeKind == 37) {
            chunk.parsedData.path = readBezierPathAtCursor(parseState);
          }
        }
      }
    } else if (chunk.tag == "trfd") {
      var trfdStart = parseState.n,
        trfdFieldA = readCoordOrFloatAtCursor(parseState),
        transformEntryCount = readCoordOrFloatAtCursor(parseState),
        transformOffsetTablePos = readCoordOrFloatAtCursor(parseState);
      parseState.n = trfdStart + transformOffsetTablePos;
      var transformOffsets = [];
      for (var transformIndex = 0; transformIndex < transformEntryCount; transformIndex++) transformOffsets[transformIndex] = readCoordOrFloatAtCursor(parseState);
      for (var transformIndex = 0; transformIndex < transformEntryCount; transformIndex++) {
        parseState.n = trfdStart + transformOffsets[transformIndex];
        if (savedCdrVersion >= 1300) parseState.n += 8;
        var transformType = readUint16LEAtCursor(parseState);
        if (transformType == 8) {
          var matrixA, matrixB, translateX, matrixC, matrixD, translateY;
          if (savedCdrVersion >= 600) parseState.n += 6;
          if (savedCdrVersion >= 500) {
            matrixA = readFloat64LEAtCursor(parseState);
            matrixB = readFloat64LEAtCursor(parseState);
            translateX = readFloat64LEAtCursor(parseState) / (savedCdrVersion < 600 ? 1e3 : 254e3);
            matrixC = readFloat64LEAtCursor(parseState);
            matrixD = readFloat64LEAtCursor(parseState);
            translateY = readFloat64LEAtCursor(parseState) / (savedCdrVersion < 600 ? 1e3 : 254e3);
          } else throw "cdr: affine transform requires CDR 500+";
          chunk.transformMatrix = new Matrix2D(matrixA, matrixC, matrixB, matrixD, translateX, translateY);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Document emission
// ---------------------------------------------------------------------------

function findRiffChild(riffNode, tag) {
  var match = null;
  for (var childIndex = 0; childIndex < riffNode.sub.length; childIndex++) {
    var child = riffNode.sub[childIndex];
    if (child.tag == tag || child.listType == tag) match = child;
  }
  return match;
}

function resolveTextStyle(styleEntryId, pageRoot) {
  var styleListData = findRiffChild(pageRoot, "stlt").parsedData,
    resolvedStyle = JSON.parse(JSON.stringify(styleListData.styleEntriesById[styleEntryId]));
  if (resolvedStyle.parentStyleEntryId != 0) {
    var parentStyle = styleListData.styleEntriesById[resolvedStyle.parentStyleEntryId];
    for (var styleKey in parentStyle)
      if (resolvedStyle[styleKey] == null || resolvedStyle[styleKey] == 0) resolvedStyle[styleKey] = parentStyle[styleKey];
    delete resolvedStyle.parentStyleEntryId;
  }
  resolvedStyle.align = styleListData.textAlignmentByIndex[resolvedStyle.alignmentIndex];
  resolvedStyle.fill = pageRoot.fillStylesById[styleListData.fillStyleIndexMap[resolvedStyle.fillStyleIndex]];
  resolvedStyle.outlineStyle = pageRoot.outlineStylesById[styleListData.outlineStyleIndexMap[resolvedStyle.outlineStyleIndex]];
  resolvedStyle.fontMetrics = styleListData.fontMetricsById[resolvedStyle.fontMetricsId];
  return resolvedStyle;
}

function visitDrawNode(drawNode, pageRoot, doc, parentMatrix) {
  var nodeKind = drawNode.listType ? drawNode.listType : drawNode.tag,
    layerObjectNode = findRiffChild(drawNode, "lgob"),
    textSummaryNode = findRiffChild(drawNode, "txsm"),
    transformNode, objectDataNode;
  if (layerObjectNode) {
    transformNode = findRiffChild(layerObjectNode, "trfl");
    objectDataNode = findRiffChild(layerObjectNode, "loda");
  }
  var localMatrix = transformNode ? transformNode.sub[0].transformMatrix.clone() : new Matrix2D;
  localMatrix.concat(parentMatrix);
  var newLayer = doc.newLayer();
  if (nodeKind == "page" || nodeKind == "layr" || nodeKind == "grp ") {
    newLayer.setName((nodeKind == "page" ? "Page" : "Group") + " " + doc.layers.length);
    newLayer.add.lsct = LayerSectionType.OpenGroup;
    newLayer.blendMode = "pass";
    newLayer.layerFlags = 24;
    var childNodes = [];
    if (nodeKind == "page") childNodes = findRiffChild(drawNode, "gobj").sub;
    if (nodeKind == "layr") childNodes = drawNode.sub.slice(2);
    if (nodeKind == "grp ") childNodes = drawNode.sub.slice(4);
    if (childNodes.length == 0) return;
    doc.layers.push(doc.createGroupEndLayer());
    for (var childIndex = childNodes.length - 1; childIndex >= 0; childIndex--) visitDrawNode(childNodes[childIndex], pageRoot, doc, parentMatrix);
  } else if (nodeKind == "obj " && objectDataNode.parsedData && objectDataNode.parsedData.path) {
    newLayer.setName("Object " + doc.layers.length);
    var fillStyle = pageRoot.fillStylesById[objectDataNode.parsedData.fillStyleIndex],
      outlineStyle = pageRoot.outlineStylesById[objectDataNode.parsedData.outlineStyleIndex],
      hasFill = fillStyle && fillStyle.type != 0,
      fillRgb = hasFill && fillStyle.fillPayload != null ? fillStyle.fillPayload : [0, 0, 0];
    newLayer.layerFlags |= 16;
    newLayer.add.vstk = LayerEffectDefs.getStrokeStyleDefault();
    var strokeEffect = newLayer.add.vstk;
    strokeEffect.strokeEnabled.v = false;
    newLayer.add.vmsk = new VectorMask;
    if (outlineStyle && outlineStyle.outlineStyleFlags != 1) {
      strokeEffect.strokeEnabled.v = true;
      strokeEffect.strokeStyleLineAlignment.v.strokeStyleLineAlignment = "strokeStyleAlignCenter";
      strokeEffect.strokeStyleLineWidth.v.val = outlineStyle.lineWidth * parentMatrix.getScale();
      var outlineRgb = outlineStyle.color;
      strokeEffect.strokeStyleContent.v.Clr.v = toRGBDesc({
        h: outlineRgb[0] * 255,
        l: outlineRgb[1] * 255,
        O: outlineRgb[2] * 255
      });
    }
    var vectorPath = objectDataNode.parsedData.path;
    newLayer.add.vmsk.pathRecords = buildCanvasPathRecords(vectorPath, false);
    transformPathRecordCoords(newLayer.add.vmsk.pathRecords, localMatrix);
    VectorPageBuilder.applyFillStyle(fillRgb, newLayer, localMatrix, boundsOfPathRecords(newLayer.add.vmsk.pathRecords));
    strokeEffect.fillEnabled.v = hasFill;
    newLayer.updateVectorOrigins();
    newLayer.invalidate(doc);
  } else if (nodeKind == "obj " && textSummaryNode) {
    var textBoxSize = objectDataNode.parsedData.textBoxSize,
      textPointAnchor = objectDataNode.parsedData.textPointAnchor,
      fullText = "";
    newLayer.add.TySh = TextEngineData.createTextLayerData(0, 0);
    newLayer.add.TySh.transform.translate(localMatrix.tx, localMatrix.ty);
    var engineData = newLayer.add.TySh.engineData,
      textRuns = textSummaryNode.parsedData.textRuns;
    for (var runIndex = 0; runIndex < textRuns.length; runIndex++) {
      var textRun = textRuns[runIndex],
        insertOffset = fullText.length;
      fullText += textRun.text + "\n";
      TextEngineData.insertText(engineData, insertOffset, textRun.text + "\n");
      var runStyle = resolveTextStyle(textRun.styleEntryId, pageRoot),
        textStyleSpan = TextEngineData.getTextStyle(engineData, insertOffset, fullText.length);
      if (runStyle.align == 3) textStyleSpan.paraStyle.Justification = 1;
      else textStyleSpan.paraStyle.Justification = 0;
      var fillChannels = runStyle.fill.fillPayload;
      textStyleSpan.textStyle.FillColor = {
        Type: 1,
        Values: [1, fillChannels[0], fillChannels[1], fillChannels[2]]
      };
      textStyleSpan.textStyle.FontSize = Math.round(runStyle.fontMetrics.fontSize * localMatrix.getScale());
      TextEngineData.applyStyle(engineData, insertOffset, fullText.length - 1, textStyleSpan);
    }
    if (textPointAnchor) {
      TextEngineData.setTextType(engineData, 0);
    } else {
      TextEngineData.setTextType(engineData, 1);
      TextEngineData.setBoxBounds(engineData, [0, 0, Math.round(textBoxSize.x * localMatrix.a), Math.round(-textBoxSize.y * localMatrix.d)]);
    }
    newLayer.setName(fullText.slice(0, 10));
  } else {
    newLayer = null;
  }
  if (newLayer) doc.layers.push(newLayer);
}

function parse(bytes, doc) {
  var uint8Array = new Uint8Array(bytes);
  doc.pendingTextRasterization = true;
  var magic = BinaryUtils.readString(uint8Array, 0, 2);
  if (magic == "WL") {
    alert("Unsupported CDR version");
  } else {
    var parsedDoc = RIFFParser.parse(uint8Array.buffer),
      parseState = {
        data: uint8Array,
        n: 0,
        cdrVersion: cdrVersionFromAsciiByte(uint8Array[11])
      },
      renderScale = 300;
    parseState.floatPairByteStride = parseState.cdrVersion < 600 ? 16 : 32;
    parseRiffChunkList(parseState, parsedDoc.sub, doc, 0);
    var cmprNode = findRiffChild(parsedDoc, "cmpr").sub,
      pageRoot = cmprNode[0],
      pageChildren = cmprNode.slice(1),
      pageConfig = findRiffChild(pageRoot, "mcfg").parsedData,
      pageSizePt = pageConfig.pageSizePt;
    renderScale /= ImportLayout.computeDocumentDownscale(new Rect(0, 0, Math.round(pageSizePt.x * renderScale), Math.round(pageSizePt.y * renderScale)), 8192 * 8192);
    var docWidth = Math.round(pageSizePt.x * renderScale),
      docHeight = Math.round(pageSizePt.y * renderScale);
    doc.width = docWidth;
    doc.height = docHeight;
    doc.buffer = allocBuffer(doc.width * doc.height * 4);
    var fillStyleChunks = findRiffChild(pageRoot, "filt").sub,
      outlineStyleChunks = findRiffChild(pageRoot, "otlt").sub;
    pageRoot.fillStylesById = {};
    for (var styleIndex = 0; styleIndex < fillStyleChunks.length; styleIndex++) pageRoot.fillStylesById[fillStyleChunks[styleIndex].sub[0].parsedData.id] = fillStyleChunks[styleIndex].sub[0].parsedData;
    pageRoot.outlineStylesById = {};
    for (var styleIndex = 0; styleIndex < outlineStyleChunks.length; styleIndex++) pageRoot.outlineStylesById[outlineStyleChunks[styleIndex].parsedData.id] = outlineStyleChunks[styleIndex].parsedData;
    var pageTransform = new Matrix2D(renderScale, 0, 0, -renderScale, pageSizePt.x * renderScale / 2, pageSizePt.y * renderScale / 2),
      rootDrawNode = pageChildren[1];
    visitDrawNode(rootDrawNode, pageRoot, doc, pageTransform);
    doc.initArtboardDocument(1);
    doc.layers[doc.layers.length - 1].setArtboardRect(new Rect(0, 0, docWidth, docHeight));
  }
}

// ---------------------------------------------------------------------------
// Public surface (static methods preserved for registry and tests)
// ---------------------------------------------------------------------------

CdrLoader.parse = parse;
CdrLoader.findRiffChild = findRiffChild;
CdrLoader.visitDrawNode = visitDrawNode;
CdrLoader.resolveTextStyle = resolveTextStyle;
CdrLoader.parseRiffChunkList = parseRiffChunkList;
CdrLoader.readUint8AtCursor = readUint8AtCursor;
CdrLoader.readUint16LEAtCursor = readUint16LEAtCursor;
CdrLoader.readFloat32LEAtCursor = readFloat32LEAtCursor;
CdrLoader.readFloat32AtCursorPlus4 = readFloat32AtCursorPlus4;
CdrLoader.readInt16LEAtCursor = readInt16LEAtCursor;
CdrLoader.readInt32LEAtCursor = readInt32LEAtCursor;
CdrLoader.readFloat64LEAtCursor = readFloat64LEAtCursor;
CdrLoader.readCStringAtCursor = readCStringAtCursor;
CdrLoader.readAngleRadiansAtCursor = readAngleRadiansAtCursor;
CdrLoader.readCoordAtCursor = readCoordAtCursor;
CdrLoader.readSmallCoordAtCursor = readSmallCoordAtCursor;
CdrLoader.readCoordOrFloatAtCursor = readCoordOrFloatAtCursor;
CdrLoader.readInt16OrInt32AtCursor = readInt16OrInt32AtCursor;
CdrLoader.readFloat32IndexMap = readFloat32IndexMap;
CdrLoader.readPointPairAtCursor = readPointPairAtCursor;
CdrLoader.readTextBoxCornerAtCursor = readTextBoxCornerAtCursor;
CdrLoader.readBezierPathAtCursor = readBezierPathAtCursor;
CdrLoader.readPolylinePathAtCursor = readPolylinePathAtCursor;
CdrLoader.buildPathFromCoordBlock = buildPathFromCoordBlock;
CdrLoader.decodeIndexedBitmap = decodeIndexedBitmap;
CdrLoader.cdrVersionFromAsciiByte = cdrVersionFromAsciiByte;
CdrLoader.readColorRgbFloats = readColorRgbFloats;

export { CdrLoader };
