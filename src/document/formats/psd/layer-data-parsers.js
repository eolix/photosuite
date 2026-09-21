/**
 * PSD layer-data parsers: pattern (`Patt`) planar images and gradient (`Grdn`)
 * color/transparency stop lists. Descriptor FourCC keys are wire format.
 */
/* global alert */
import { Rect } from "../../../core/math/rect.js";
import { BinaryUtils } from "../../../core/binary/binary-utils.js";

import { ChannelImageCodec } from "./channel-image-codec.js";
import { SwatchColorCodec } from "./swatch-color-codec.js";
import { PlanarRgbaBuffer, allocBuffer, interleavedToPlanar, planarToInterleaved } from "../../../engine/compositing/buffer-utils.js";
import { psdColorToRgb, toRGBDesc } from "../../../engine/compositing/psd-color-utils.js";

// ---------------------------------------------------------------------------
// Pattern (Patt) resource
// ---------------------------------------------------------------------------

/** Read a list of length-prefixed, 4-byte-aligned pattern entries. */
function extractPatterns(data, start, length) {
  var end = start + length;
  var items = [];
  while (start < end) {
    var item = {};
    var itemSize = BinaryUtils.readUint32BE(data, start);
    start += 4;
    var itemStart = start;
    start = readPattern(data, start, item);
    if (!item.pixelData[1].isEmpty()) items.push(item);
    if (itemSize % 4 != 0) itemSize += 4 - itemSize % 4;
    start = itemStart + itemSize;
  }
  return items;
}

/** Write pattern entries with length prefixes and 4-byte alignment. */
function writePatternEntries(buf, pos, items) {
  for (var idx = 0; idx < items.length; idx++) {
    var item = items[idx];
    pos += 4;
    var chunkStart = pos;
    pos = writePattern(buf, pos, item);
    var chunkSize = pos - chunkStart;
    BinaryUtils.writeSize(buf, chunkStart - 4, chunkSize);
    if (chunkSize % 4 != 0) chunkStart += 4 - chunkSize % 4;
    pos = chunkStart + chunkSize;
  }
  return pos;
}

/** Read one pattern (header, name, id, planar pixels) into `pattern`. */
function readPattern(data, pos, pattern) {
  var version = BinaryUtils.readUint32BE(data, pos);
  pos += 4;
  if (version != 1) alert("Unknown version of pattern");
  var colorMode = BinaryUtils.readUint32BE(data, pos);
  pos += 4;
  if (colorMode != 1 && colorMode != 2 && colorMode != 3) console.log("Unsupported mode of pattern: " + colorMode);
  var height = BinaryUtils.readUint16(data, pos);
  pos += 2;
  var width = BinaryUtils.readUint16(data, pos);
  pos += 2;
  var rect = new Rect(0, 0, width, height);
  pattern.name = BinaryUtils.readUnicodeName(data, pos);
  pos += 4 + 2 * pattern.name.length + 2;
  var idLength = data[pos];
  pos++;
  pattern.id = BinaryUtils.readString(data, pos, idLength);
  pos += pattern.id.length;

  var indexedColorsOffset = -1;
  if (colorMode == 2) {
    indexedColorsOffset = pos;
    pos += 3 * 256 + 4;
  }
  var planarBuf = new PlanarRgbaBuffer(width * height);
  pos = parsePatternPlanarBuffer(data, pos, planarBuf);
  if (colorMode == 2) applyIndexedPalette(planarBuf, data, indexedColorsOffset);

  var pixelBuf = allocBuffer(rect.area() * 4);
  planarToInterleaved(planarBuf, pixelBuf);
  pattern.pixelData = [pixelBuf, rect];
  return pos;
}

/** Remap indexed-color pattern samples through the 256-entry RGB palette. */
function applyIndexedPalette(planarBuf, data, indexedColorsOffset) {
  for (var idx = 0; idx < planarBuf.h.length; idx++) {
    var colorOffset = 3 * planarBuf.h[idx];
    planarBuf.h[idx] = data[indexedColorsOffset + colorOffset + 0];
    planarBuf.l[idx] = data[indexedColorsOffset + colorOffset + 1];
    planarBuf.O[idx] = data[indexedColorsOffset + colorOffset + 2];
  }
}

function writePattern(buf, pos, pattern) {
  var pixelBuf = pattern.pixelData[0];
  var rect = pattern.pixelData[1];
  BinaryUtils.writeSize(buf, pos, 1);
  pos += 4;
  BinaryUtils.writeSize(buf, pos, 3);
  pos += 4;
  BinaryUtils.writeUint16(buf, pos, rect.height);
  pos += 2;
  BinaryUtils.writeUint16(buf, pos, rect.width);
  pos += 2;
  BinaryUtils.writeUnicodeString(buf, pos, pattern.name + "\0");
  pos += 4 + 2 * pattern.name.length + 2;
  BinaryUtils.fillBytes(buf, pos, pattern.id.length);
  pos++;
  BinaryUtils.writeAscii(buf, pos, pattern.id);
  pos += pattern.id.length;
  var planarBuf = new PlanarRgbaBuffer(rect.area());
  interleavedToPlanar(pixelBuf, planarBuf);
  return writePatternPlanarBuffer(buf, pos, planarBuf, rect);
}

/** Read the virtual-memory-array planar channel data of a pattern. */
function parsePatternPlanarBuffer(data, pos, planarBuf) {
  var channelInfo = { rect: null, channels: [], userMaskChannel: null, alphaChannel: null };
  var header = BinaryUtils.readUint32BE(data, pos);
  pos += 4;
  var format = BinaryUtils.readUint32BE(data, pos);
  pos += 4;
  channelInfo.rect = BinaryUtils.readRect(data, pos);
  pos += 16;
  var channelCount = BinaryUtils.readUint32BE(data, pos);
  pos += 4;
  for (var idx = 0; idx < channelCount + 2; idx++) {
    var channelPresent = BinaryUtils.readUint32BE(data, pos);
    pos += 4;
    if (channelPresent == 0) continue;
    var channelDataLen = BinaryUtils.readUint32BE(data, pos);
    pos += 4;
    if (channelDataLen == 0) continue;
    var bitDepth = BinaryUtils.readUint32BE(data, pos);
    pos += 4;
    var channelRect = BinaryUtils.readRect(data, pos);
    pos += 16;
    var compressionMode = BinaryUtils.readUint16(data, pos);
    pos += 2;
    var compression = data[pos];
    pos++;
    var channelData = ChannelImageCodec.decompressChannel(false, bitDepth, data, channelRect.width, channelRect.height, pos, compression);
    if (idx < channelCount) channelInfo.channels.push(channelData);
    if (idx == channelCount) channelInfo.userMaskChannel = channelData;
    if (idx == channelCount + 1) channelInfo.alphaChannel = channelData;
    pos += channelDataLen - 23;
  }
  if (!channelInfo.rect.isEmpty()) {
    if (channelInfo.channels[0]) planarBuf.h = channelInfo.channels[0];
    if (channelInfo.channels[1]) planarBuf.l = channelInfo.channels[1];
    else planarBuf.l = channelInfo.channels[0].slice(0);
    if (channelInfo.channels[2]) planarBuf.O = channelInfo.channels[2];
    else planarBuf.O = channelInfo.channels[0].slice(0);
    if (channelInfo.alphaChannel) planarBuf.w = channelInfo.alphaChannel;
    else planarBuf.w.fill(255);
  }
  return pos;
}

function writePatternPlanarBuffer(buf, pos, planarBuf, rect) {
  var startPos = pos;
  var channelInfo = { rect: rect, channels: [planarBuf.h, planarBuf.l, planarBuf.O], userMaskChannel: null, alphaChannel: planarBuf.w };
  BinaryUtils.writeSize(buf, pos, 3);
  pos += 4;
  BinaryUtils.writeSize(buf, pos, 0);
  pos += 4;
  BinaryUtils.writePsdRect(buf, pos, rect);
  pos += 16;
  BinaryUtils.writeSize(buf, pos, 24);
  pos += 4;
  for (var idx = 0; idx < 24 + 2; idx++) {
    var entryStart = pos;
    var channelPresent = idx < 3 || idx == 25 ? 1 : 0;
    BinaryUtils.writeSize(buf, pos, channelPresent);
    pos += 4;
    if (channelPresent == 0) continue;
    BinaryUtils.writeSize(buf, pos, 0);
    pos += 4;
    BinaryUtils.writeSize(buf, pos, 8);
    pos += 4;
    BinaryUtils.writePsdRect(buf, pos, rect);
    pos += 16;
    BinaryUtils.writeUint16(buf, pos, 8);
    pos += 2;
    BinaryUtils.fillBytes(buf, pos, 1, 1);
    pos++;
    var channelData = idx < 3 ? channelInfo.channels[idx] : channelInfo.alphaChannel;
    buf.ensureCapacity(pos, rect.area() + 2);
    pos = ChannelImageCodec.compressChannel(false, channelData, buf.data, rect.width, rect.height, pos, 1);
    BinaryUtils.writeSize(buf, entryStart + 4, pos - entryStart - 8);
  }
  BinaryUtils.writeSize(buf, startPos + 4, pos - startPos - 8);
  return pos;
}

const PatternParser = {
  extract: extractPatterns,
  writeEntries: writePatternEntries,
  readPattern,
  writePattern,
  parsePlanarBuffer: parsePatternPlanarBuffer,
  writePlanarBuffer: writePatternPlanarBuffer,
};

// ---------------------------------------------------------------------------
// Gradient (Grdn) stops
// ---------------------------------------------------------------------------

/** Build a gradient color-stop descriptor from a raw RGB color + positions. */
function buildColorStop(rawColor, location, midpoint) {
  return {
    t: "Objc",
    v: {
      classID: "Clrt",
      Clr: {
        t: "Objc",
        v: {
          classID: "RGBC",
          Rd: { t: "doub", v: rawColor.h },
          Grn: { t: "doub", v: rawColor.l },
          Bl: { t: "doub", v: rawColor.O },
        },
      },
      Type: { t: "enum", v: { Clry: "UsrS" } },
      Lctn: { t: "long", v: location },
      Mdpn: { t: "long", v: midpoint },
    },
  };
}

/** Build a gradient transparency-stop descriptor from opacity + positions. */
function buildTransparencyStop(location, midpoint, opacity) {
  return {
    t: "Objc",
    v: {
      classID: "TrnS",
      Opct: { t: "UntF", v: { type: "#Prc", val: Math.round(100 * opacity / 255) } },
      Lctn: { t: "long", v: location },
      Mdpn: { t: "long", v: midpoint },
    },
  };
}

/** Read a gradient entry (color + transparency stops) into a Grdn descriptor. */
function readGradientEntry(data, pos, name) {
  var gradient = {
    classID: "Grdn",
    Clrs: { t: "VlLs", v: [] },
    GrdF: { t: "enum", v: { GrdF: "CstS" } },
    Intr: { t: "doub", v: 4096 },
    Nm: { t: "TEXT", v: name },
    Trns: { t: "VlLs", v: [] },
  };
  var colorStopCount = BinaryUtils.readUint16(data, pos);
  pos += 2;
  if (colorStopCount == 0) throw "psd-gradient: no color stops";
  for (var idx = 0; idx < colorStopCount; idx++) {
    var location = BinaryUtils.readUint32BE(data, pos);
    var midpoint = BinaryUtils.readUint32BE(data, pos + 4);
    var rawColor = SwatchColorCodec.readSwatchColorAt(data, pos + 8);
    gradient.Clrs.v.push(buildColorStop(rawColor, location, midpoint));
    pos += 20;
  }
  var transparencyCount = BinaryUtils.readUint16(data, pos);
  pos += 2;
  for (var idx = 0; idx < transparencyCount; idx++) {
    var location = BinaryUtils.readUint32BE(data, pos);
    var midpoint = BinaryUtils.readUint32BE(data, pos + 4);
    var opacity = BinaryUtils.readUint16(data, pos + 8);
    gradient.Trns.v.push(buildTransparencyStop(location, midpoint, opacity));
    pos += 10;
  }
  return [gradient, pos];
}

function writeGradientStops(buf, pos, gradient) {
  var colorStopCount = gradient.Clrs.v.length;
  BinaryUtils.writeUint16(buf, pos, colorStopCount);
  pos += 2;
  for (var idx = 0; idx < colorStopCount; idx++) {
    var colorStop = gradient.Clrs.v[idx];
    BinaryUtils.writeSize(buf, pos, colorStop.v.Lctn.v);
    BinaryUtils.writeSize(buf, pos + 4, colorStop.v.Mdpn.v);
    BinaryUtils.writeUint16(buf, pos + 8, 0);
    var rgbDesc = toRGBDesc(psdColorToRgb(colorStop.v.Clr.v));
    var channelBytes = [rgbDesc.Rd.v, rgbDesc.Grn.v, rgbDesc.Bl.v, 0];
    for (var channelIdx = 0; channelIdx < 4; channelIdx++) BinaryUtils.writeUint16(buf, pos + 10 + channelIdx * 2, Math.round(65535 * (channelBytes[channelIdx] / 255)));
    pos += 20;
  }
  var transparencyCount = gradient.Trns.v.length;
  BinaryUtils.writeUint16(buf, pos, transparencyCount);
  pos += 2;
  for (var idx = 0; idx < transparencyCount; idx++) {
    var transparencyStop = gradient.Trns.v[idx];
    BinaryUtils.writeSize(buf, pos, transparencyStop.v.Lctn.v);
    BinaryUtils.writeSize(buf, pos + 4, transparencyStop.v.Mdpn.v);
    BinaryUtils.writeUint16(buf, pos + 8, Math.round(255 * transparencyStop.v.Opct.v.val / 100));
    pos += 10;
  }
  return pos;
}

const GradientParser = {
  readGradientEntry,
  writeGradientStops,
};

/**
 * Find the pattern a descriptor's `Idnt` refers to in `patternList` — a
 * document's `add.Patt`, a layer's own patterns, or the preset library.
 * Returns null when the list has no entry with that id.
 */
function findPattern(patternDescriptor, patternList) {
  if (patternList == null) return null;
  const patternId = patternDescriptor.Idnt.v;
  for (let listIdx = 0; listIdx < patternList.length; listIdx++)
    if (patternList[listIdx].id == patternId) return patternList[listIdx];
  return null;
}

/** Deep-copy one additional-layer-info value for undo / duplicate. */
export function cloneLayerAdditionalValue(key, value) {
  if (key === "TySh") {
    const cloned = {
      transform: value.transform.clone(),
      textDescriptor: JSON.parse(JSON.stringify(value.textDescriptor)),
      warpDescriptor: JSON.parse(JSON.stringify(value.warpDescriptor)),
      boundsRect: value.boundsRect.clone(),
      engineData: JSON.parse(JSON.stringify(value.engineData)),
    };
    if (value.add) {
      cloned.add = {
        vmsk: value.add.vmsk.clone(),
        vogk: JSON.parse(JSON.stringify(value.add.vogk)),
      };
    }
    return cloned;
  }
  if (key === "fxrp" || key === "vmsk") {
    return value.clone();
  }
  return JSON.parse(JSON.stringify(value));
}

export { PatternParser, GradientParser, findPattern };
