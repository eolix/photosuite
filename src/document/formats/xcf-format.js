// GIMP (.xcf) layered-image loader. Parses the XCF layer stack into the
// document model; property type ids live in metadata/xcf-prop-type.js.
/* global pako, DOMParser, alert */
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { CSS } from "../../features/css-export/css.js";

import { XcfPropType } from "./metadata/xcf-prop-type.js";
import { Layer, LayerSectionType } from "../model/layer.js";
import { TextEngineData } from "../../features/text/text-engine.js";
import { Mask } from "../model/layer-masks.js";
import { PlanarRgbaBuffer, allocBuffer, planarToInterleaved } from "../../engine/compositing/buffer-utils.js";
import { copyChannelsWithClip } from "../../engine/compositing/pixel-ops.js";
import { linearToSrgb } from "../../engine/compositing/color-math.js";

/** XCF tiles are 64x64 pixels. */
const TILE_SIZE = 64;
/** Layer-flag bits marking a collapsed group; hidden layers add this bit. */
const GROUP_LAYER_FLAGS = 24;
const HIDDEN_LAYER_FLAG = 2;
/** HDR float→byte lookup table resolution (0..1 sampled in 1/1000 steps). */
const HDR_LUT_SIZE = 1001;
/** RLE tag byte thresholds in the XCF tile compression stream. */
const RLE_LONG_RUN = 127;
const RLE_LONG_COPY = 128;

/** GIMP text style tokens split off the end of a font family name. */
const FONT_STYLE_TOKENS = "bold italic semi extra regular condensed light".split(" ");
/** GIMP text justification names, indexed to PSD Justification values. */
const JUSTIFY_NAMES = ["left", "right", "center", "fill"];

/** Number of raw sample channels for a given XCF bit-depth code. */
function channelCountForBitDepth(bitDepth) {
  if (bitDepth == 100 || bitDepth == 150) return 1;
  if (bitDepth == 200 || bitDepth == 250) return 2;
  if (bitDepth == 300 || bitDepth == 350) return 4;
  if (bitDepth == 500 || bitDepth == 550) return 2;
  if (bitDepth == 600 || bitDepth == 650) return 4;
  if (bitDepth == 700 || bitDepth == 750) return 8;
  alert("unsupported bit depth " + bitDepth);
  throw "xcf: unsupported bit depth";
}

/** Reader for id-sized offsets (4-byte uint or 8-byte int). */
function idReader(idSize) {
  return idSize == 4 ? BinaryUtils.readUint32BE : BinaryUtils.readInt64BE;
}

/**
 * Parse an XCF buffer into the document's layer stack.
 * @param {ArrayBuffer} arrayBuffer
 * @param {object} doc
 */
function parse(arrayBuffer, doc) {
  var bytes = new Uint8Array(arrayBuffer);
  var offset = 0;
  var idSize = 4;
  var bitDepth = 100;
  offset += 9;
  var versionTag = BinaryUtils.readString(bytes, offset, 4);
  offset += 4;
  offset++;
  doc.width = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  doc.height = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var colorMode = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  if (colorMode != 0) alert("Unsupported image format, not RGB!");
  if (["file", "v001", "v002", "v003"].indexOf(versionTag) == -1) {
    bitDepth = BinaryUtils.readUint32BE(bytes, offset);
    offset += 4;
    if (parseInt(versionTag.slice(1)) < 7) alert("Unknown XCF version: " + versionTag);
    idSize = 8;
  }

  var compressionProps = {};
  offset = readPropertyList(bytes, offset, compressionProps);
  var layerIds = [];
  offset = readIdList(bytes, offset, layerIds, idSize);
  var channelIds = [];
  offset = readIdList(bytes, offset, channelIds, idSize);

  doc.openGroupDepth = 0;
  for (var layerIdx = 0; layerIdx < layerIds.length; layerIdx++) {
    readLayer(bytes, layerIds[layerIdx], doc, compressionProps, idSize, bitDepth);
  }
  while (doc.openGroupDepth > 0) {
    doc.layers.push(doc.createGroupEndLayer());
    doc.openGroupDepth--;
  }
  doc.layers.reverse();
  delete doc.openGroupDepth;
  doc.buffer = allocBuffer(doc.width * doc.height * 4);
  if (doc.layers.length == 0) console.log("No layers!!!");

  for (var channelIdx = 0; channelIdx < channelIds.length; channelIdx++) {
    var channel = readChannel(bytes, channelIds[channelIdx], compressionProps, idSize, bitDepth);
    if (channel.properties[XcfPropType.PROP_SELECTION]) {
      doc.selectionMask = { channel: channel.channelPlane, rect: new Rect(0, 0, doc.width, doc.height) };
    }
  }
}

/** Read one layer (header, properties, text, pixel data) and push it. */
function readLayer(bytes, offset, doc, compressionProps, idSize, bitDepth) {
  var layer = doc.newLayer();
  var layerWidth = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var layerHeight = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  layer.rect = new Rect(0, 0, layerWidth, layerHeight);
  var baseType = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var layerName = BinaryUtils.readLengthPrefixedUtf8(bytes, offset);
  offset += layerName.size;
  layer.setName(layerName.str);

  var props = {};
  offset = readPropertyList(bytes, offset, props);
  var savedGroupDepth = 0;
  if (props[XcfPropType.PROP_ITEM_PATH]) savedGroupDepth = props[XcfPropType.PROP_ITEM_PATH].length / 4 - 1;
  applyLayerProps(layer, props);

  if (props[XcfPropType.PROP_PARASITES]) {
    var parasites = props[XcfPropType.PROP_PARASITES];
    for (var parasiteName in parasites) {
      if (parasiteName == "gimp-text-layer") applyGimpTextLayer(layer, parasites[parasiteName]);
      else console.log("Unknown property " + parasiteName);
    }
  }

  while (doc.openGroupDepth > savedGroupDepth) {
    doc.layers.push(doc.createGroupEndLayer());
    doc.openGroupDepth--;
  }
  doc.openGroupDepth = savedGroupDepth;
  if (layer.add.lsct == LayerSectionType.OpenGroup || layer.add.lsct == LayerSectionType.ClosedGroup) doc.openGroupDepth++;

  if (layer.hasPixelData()) readLayerPixelData(bytes, offset, layer, props, compressionProps, idSize, bitDepth);
  doc.layers.push(layer);
}

/** Apply offset / opacity / group / mode / visibility properties to a layer. */
function applyLayerProps(layer, props) {
  if (props[XcfPropType.PROP_OFFSETS]) {
    layer.rect.x = BinaryUtils.readInt32BE(props[XcfPropType.PROP_OFFSETS], 0);
    layer.rect.y = BinaryUtils.readInt32BE(props[XcfPropType.PROP_OFFSETS], 4);
  }
  if (props[XcfPropType.PROP_OPACITY]) layer.Opct = BinaryUtils.readUint32BE(props[XcfPropType.PROP_OPACITY], 0);
  if (props[XcfPropType.PROP_GROUP_ITEM]) {
    layer.add.lsct = LayerSectionType.OpenGroup;
    layer.rect = new Rect(0, 0, 0, 0);
    layer.buffer = allocBuffer(0);
    layer.layerFlags = GROUP_LAYER_FLAGS;
  }
  if (props[XcfPropType.PROP_MODE]) {
    var modeCode = BinaryUtils.readUint32BE(props[XcfPropType.PROP_MODE], 0);
    layer.blendMode = XcfPropType.psdBlendModeCodes[modeCode];
    if (layer.isGroup() && layer.blendMode == "norm") layer.blendMode = "pass";
  }
  if (props[XcfPropType.PROP_VISIBLE] && BinaryUtils.readUint32BE(props[XcfPropType.PROP_VISIBLE], 0) == 0) {
    layer.layerFlags += HIDDEN_LAYER_FLAG;
  }
  if (props[XcfPropType.PROP_GROUP_ITEM_FLAGS]) {
    var groupFlags = BinaryUtils.readUint32BE(props[XcfPropType.PROP_GROUP_ITEM_FLAGS], 0);
    layer.add.lsct = groupFlags & 1 == 1 ? LayerSectionType.OpenGroup : LayerSectionType.ClosedGroup;
  }
}

/** Read a layer's tiled pixel data and optional layer mask. */
function readLayerPixelData(bytes, offset, layer, props, compressionProps, idSize, bitDepth) {
  layer.buffer = allocBuffer(layer.rect.area() * 4);
  var planarPixels = new PlanarRgbaBuffer(layer.rect.area());
  var readId = idReader(idSize);
  var pixelDataOffset = readId(bytes, offset);
  offset += idSize;
  var maskChannelId = readId(bytes, offset);
  offset += idSize;
  readHierarchicalPixelData(bytes, pixelDataOffset, planarPixels, compressionProps, idSize, bitDepth);
  planarToInterleaved(planarPixels, layer.buffer);
  if (maskChannelId == 0) return;
  layer.d = new Mask;
  layer.d.color = 0;
  layer.d.rect = layer.rect.clone();
  layer.d.channel = readChannel(bytes, maskChannelId, compressionProps, idSize, bitDepth).channelPlane;
  if (props[XcfPropType.PROP_APPLY_MASK]) {
    layer.d.isEnabled = BinaryUtils.readUint32BE(props[XcfPropType.PROP_APPLY_MASK], 0) == 1;
  }
}

/** Build a text layer from a GIMP `gimp-text-layer` parasite. */
function applyGimpTextLayer(layer, parasiteData) {
  var textProps = parseTextParasite(parasiteData);
  var textContent = textProps.text;
  var fontName = textProps.font;
  var textColor = textProps.color;
  var fontSize = textProps["font-size"];
  if (textContent == null && textProps.markup) {
    var markup = parseTextMarkup(textProps.markup, fontName, textColor, fontSize);
    textContent = markup.textContent;
    fontName = markup.fontName;
    textColor = markup.textColor;
    fontSize = markup.fontSize;
  }

  layer.add.lnsr = "rend";
  layer.add.TySh = TextEngineData.createTextLayerData(0, 0);
  layer.add.TySh.boundsRect = new Rect(0, 0, 100, 100);
  layer.add.TySh.transform = new Matrix2D(1, 0, 0, 1, layer.rect.x, layer.rect.y);
  var engineData = layer.add.TySh.engineData;
  TextEngineData.insertText(engineData, 0, textContent);

  var textStyle = TextEngineData.getTextStyle(engineData, 0, 0);
  if (textColor) {
    textStyle.textStyle.FillColor = {
      Type: 1,
      Values: [1, parseFloat(textColor[1]), parseFloat(textColor[2]), parseFloat(textColor[3])],
    };
  }
  if (fontSize) {
    fontSize = Math.round(parseFloat(fontSize));
    textStyle.textStyle.FontSize = fontSize;
    layer.add.TySh.transform.ty += Math.min(17, fontSize * .17);
  }
  var lineSpacing = textProps["line-spacing"];
  if (lineSpacing) {
    lineSpacing = Math.round(parseFloat(lineSpacing) + textStyle.textStyle.FontSize * 1.2);
    textStyle.textStyle.Leading = lineSpacing;
    textStyle.textStyle.AutoLeading = false;
  }
  if (textProps.justify) textStyle.paraStyle.Justification = JUSTIFY_NAMES.indexOf(textProps.justify);
  if (fontName && fontName != "Sans-serif") TextEngineData.setTextFont(textStyle, resolveGimpFontName(fontName));
  TextEngineData.applyStyle(engineData, 0, textContent.length, textStyle);

  var boxWidth = textProps["box-width"];
  var boxHeight = textProps["box-height"];
  var parsedBoxWidth = boxWidth ? parseFloat(boxWidth) : layer.rect.width;
  var parsedBoxHeight = boxHeight ? parseFloat(boxHeight) : layer.rect.height;
  TextEngineData.setTextType(engineData, 1);
  TextEngineData.setBoxBounds(engineData, [0, 0, Math.ceil(parsedBoxWidth), Math.ceil(parsedBoxHeight)]);
}

/**
 * Resolve text content and style overrides from a GIMP Pango markup string,
 * following the innermost element's font / foreground / size attributes.
 * @returns {{textContent: string, fontName, textColor, fontSize}}
 */
function parseTextMarkup(markup, fontName, textColor, fontSize) {
  var svgRoot = new DOMParser().parseFromString(markup, "image/svg+xml");
  while (svgRoot.firstChild != null && svgRoot.firstChild.tagName != null) {
    svgRoot = svgRoot.firstChild;
    var svgFont = svgRoot.getAttribute("font");
    var svgForeground = svgRoot.getAttribute("foreground");
    var svgSize = svgRoot.getAttribute("size");
    if (svgFont != null) fontName = svgFont;
    if (svgForeground != null) {
      svgForeground = CSS.parseCssColor(svgForeground);
      textColor = [1, svgForeground.h / 255, svgForeground.l / 255, svgForeground.O / 255];
    }
    if (svgSize != null) fontSize = "" + parseFloat(svgSize) / 245;
  }
  return { textContent: svgRoot.textContent, fontName: fontName, textColor: textColor, fontSize: fontSize };
}

/** Rewrite a GIMP font family, splitting a trailing style suffix with a dash. */
function resolveGimpFontName(fontName) {
  var lowerFont = fontName.toLowerCase();
  var splitAt = lowerFont.length;
  for (var tokenIdx = 0; tokenIdx < FONT_STYLE_TOKENS.length; tokenIdx++) {
    var foundAt = lowerFont.indexOf(FONT_STYLE_TOKENS[tokenIdx]);
    if (foundAt != -1 && foundAt < splitAt && lowerFont[foundAt - 1] == " ") splitAt = foundAt;
  }
  if (splitAt != lowerFont.length) {
    fontName = fontName.slice(0, splitAt - 1).split(" ").join("") + "-" + fontName.slice(splitAt).split(" ").join("");
  }
  return fontName;
}

/** Parse a text-layer parasite's S-expression payload into a bindings object. */
function parseTextParasite(parasiteBytes) {
  var source = "(" + BinaryUtils.readUtf8(parasiteBytes, 0, parasiteBytes.length - 1) + ")";
  var tokens = [];
  var bindings = {};
  parseSExprTokens(source, 1, tokens);
  applySExprBindingsToObject(tokens, bindings);
  return bindings;
}

/** Fold parsed S-expression key/value lists into a target object. */
function applySExprBindingsToObject(tokens, target) {
  for (var tokenIdx = 0; tokenIdx < tokens.length; tokenIdx++) {
    var entry = tokens[tokenIdx];
    var key = entry[0];
    target[key] = entry.length == 2 ? entry[1] : entry.slice(1);
  }
}

/** Recursive-descent tokenizer for the S-expression parasite format. */
function parseSExprTokens(source, pos, outTokens) {
  while (true) {
    if (pos >= source.length) throw "xcf: unterminated s-expression";
    var ch = source.charAt(pos);
    pos++;
    if (ch == "(") {
      var nested = [];
      pos = parseSExprTokens(source, pos, nested);
      outTokens.push(nested);
    } else if (ch == " " || ch == "\n" || ch == "\r") {
      // whitespace separator
    } else if (ch == ")") {
      return pos;
    } else if (ch == "\"") {
      var tokenStart = pos;
      while (true) {
        var esc = source[pos];
        pos++;
        if (esc == "\"") break;
        if (esc == "\\") pos++;
      }
      outTokens.push(JSON.parse(source.slice(tokenStart - 1, pos)));
    } else {
      var tokenStart = pos - 1;
      while (source[pos] != " " && source[pos] != ")") pos++;
      outTokens.push(source.slice(tokenStart, pos));
    }
  }
}

/** Read a channel (name, properties, pixel plane) at `offset`. */
function readChannel(bytes, offset, compressionProps, idSize, bitDepth) {
  var channelWidth = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var channelHeight = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var channelName = BinaryUtils.readLengthPrefixedUtf8(bytes, offset);
  offset += channelName.size;
  var properties = {};
  offset = readPropertyList(bytes, offset, properties);
  var planarBuffer = new PlanarRgbaBuffer(channelWidth * channelHeight);
  var pixelDataOffset = idReader(idSize)(bytes, offset);
  offset += idSize;
  readHierarchicalPixelData(bytes, pixelDataOffset, planarBuffer, compressionProps, idSize, bitDepth);
  return { channelPlane: planarBuffer.h, properties: properties };
}

/** Read a hierarchy header and decode its level-0 tiled channel data. */
function readHierarchicalPixelData(bytes, offset, planarBuffer, compressionProps, idSize, bitDepth) {
  var tileWidth = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var tileHeight = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var bytesPerPixel = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var tiledDataOffset = idReader(idSize)(bytes, offset);
  offset += idSize;
  decodeTiledChannelData(bytes, tiledDataOffset, planarBuffer, compressionProps, bytesPerPixel, idSize, bitDepth);
}

/** Decode a tiled channel level into a planar RGBA buffer. */
function decodeTiledChannelData(bytes, offset, planarBuffer, compressionProps, bytesPerPixel, idSize, bitDepth) {
  var imageWidth = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var imageHeight = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var tileRect = new Rect(0, 0, imageWidth, imageHeight);
  var channelCount = channelCountForBitDepth(bitDepth);
  var sampleCount = bytesPerPixel / channelCount;
  channelCount = Math.round(bytesPerPixel / sampleCount);

  var tileIds = [];
  offset = readIdList(bytes, offset, tileIds, idSize);
  var tilePlanar = new PlanarRgbaBuffer(TILE_SIZE * TILE_SIZE * channelCount);
  var tileBounds = new Rect;
  var compressionType = compressionProps[XcfPropType.PROP_COMPRESSION][0];
  var channelSlices = [tilePlanar.h, tilePlanar.l, tilePlanar.O, tilePlanar.w];
  if (sampleCount == 3) tilePlanar.w.fill(255);

  var tileIndex = 0;
  for (var tileY = 0; tileY < imageHeight; tileY += TILE_SIZE) {
    for (var tileX = 0; tileX < imageWidth; tileX += TILE_SIZE) {
      var tileW = Math.min(imageWidth - tileX, TILE_SIZE);
      var tileH = Math.min(imageHeight - tileY, TILE_SIZE);
      var pixelCount = tileW * tileH;
      tileBounds.setXY(tileX, tileY, tileW, tileH);
      readTilePixels(bytes, tileIds[tileIndex++], pixelCount * channelCount, compressionType, sampleCount, channelSlices);
      if (bitDepth == 100 || bitDepth == 150) {
        // 8-bit samples: no unpacking needed.
      } else if (bitDepth == 250) {
        unpack16BitTo8(channelSlices, sampleCount, pixelCount);
      } else if (bitDepth == 600) {
        unpackHdrFloatTo8(channelSlices, sampleCount, pixelCount);
      } else {
        console.log("unknown data format", bitDepth);
      }
      copyChannelsWithClip(tilePlanar, tileBounds, planarBuffer, tileRect);
    }
  }
}

/** Collapse big-endian 16-bit samples to 8-bit in place. */
function unpack16BitTo8(channelSlices, sampleCount, pixelCount) {
  for (var ch = 0; ch < sampleCount; ch++) {
    var channelData = channelSlices[ch];
    for (var px = 0; px < pixelCount; px++) {
      var packed = channelData[px] << 8 | channelData[pixelCount + px];
      channelData[px] = Math.min(packed >>> 8, 255);
    }
  }
}

/** Collapse 32-bit float samples to sRGB 8-bit via the HDR lookup table. */
function unpackHdrFloatTo8(channelSlices, sampleCount, pixelCount) {
  var hdrLut = getHdrFloatByteLut();
  var floatBits = new Uint32Array(1);
  var floatView = new Float32Array(floatBits.buffer);
  for (var ch = 0; ch < sampleCount; ch++) {
    var channelData = channelSlices[ch];
    for (var px = 0; px < pixelCount; px++) {
      floatBits[0] = channelData[px] << 24 | channelData[pixelCount + px] << 16 | channelData[(pixelCount << 1) + px] << 8 | channelData[(pixelCount << 1) + pixelCount + px] << 0;
      var floatVal = floatView[0];
      if (floatVal < 0) floatVal = 0;
      else if (floatVal > 1) floatVal = 1;
      channelData[px] = hdrLut[~~(.5 + floatVal * 1e3)];
    }
  }
}

let hdrFloatByteLutCache = null;

/** Lazily build the 0..1 linear-float → sRGB-byte lookup table. */
function getHdrFloatByteLut() {
  if (hdrFloatByteLutCache != null) return hdrFloatByteLutCache;
  hdrFloatByteLutCache = new Uint8Array(HDR_LUT_SIZE);
  for (var lutIdx = 0; lutIdx < HDR_LUT_SIZE; lutIdx++) {
    hdrFloatByteLutCache[lutIdx] = ~~(.49 + 255 * linearToSrgb(lutIdx * .001));
  }
  return hdrFloatByteLutCache;
}

/** Decode one compressed tile's samples into the channel-slice planes. */
function readTilePixels(bytes, offset, byteLength, compressionType, sampleCount, channelSlices) {
  if (compressionType == 1) {
    decodeRleTile(bytes, offset, byteLength, sampleCount, channelSlices);
  } else if (compressionType == 2) {
    decodeZlibTile(bytes, offset, byteLength, channelSlices);
  } else {
    alert("Unknown compression " + compressionType);
  }
}

/** Decode a run-length-encoded tile into per-channel planes. */
function decodeRleTile(bytes, offset, byteLength, sampleCount, channelSlices) {
  for (var ch = 0; ch < sampleCount; ch++) {
    var channelData = channelSlices[ch];
    var writePos = 0;
    while (writePos < byteLength) {
      var runHeader = bytes[offset];
      offset++;
      if (runHeader < RLE_LONG_RUN) {
        var runValue = bytes[offset];
        offset++;
        runHeader++;
        for (var runIdx = 0; runIdx < runHeader; runIdx++) channelData[writePos + runIdx] = runValue;
      } else if (runHeader == RLE_LONG_RUN) {
        var runHi = bytes[offset];
        offset++;
        var runLo = bytes[offset];
        offset++;
        var runValue = bytes[offset];
        offset++;
        runHeader = runHi << 8 | runLo;
        for (var runIdx = 0; runIdx < runHeader; runIdx++) channelData[writePos + runIdx] = runValue;
      } else if (runHeader == RLE_LONG_COPY) {
        var runHi = bytes[offset];
        offset++;
        var runLo = bytes[offset];
        offset++;
        runHeader = runHi << 8 | runLo;
        for (var runIdx = 0; runIdx < runHeader; runIdx++) channelData[writePos + runIdx] = bytes[offset + runIdx];
        offset += runHeader;
      } else {
        runHeader = 256 - runHeader;
        for (var runIdx = 0; runIdx < runHeader; runIdx++) channelData[writePos + runIdx] = bytes[offset + runIdx];
        offset += runHeader;
      }
      writePos += runHeader;
    }
  }
}

/** Decode a zlib-compressed interleaved tile into per-channel planes. */
function decodeZlibTile(bytes, offset, byteLength, channelSlices) {
  var inflated = pako.inflate(bytes.slice(offset));
  var stride = Math.round(inflated.length / byteLength);
  for (var byteIdx = 0; byteIdx < byteLength; byteIdx++) {
    var src = byteIdx * stride;
    channelSlices[0][byteIdx] = inflated[src];
    channelSlices[1][byteIdx] = inflated[src + 1];
    channelSlices[2][byteIdx] = inflated[src + 2];
    channelSlices[3][byteIdx] = stride == 3 ? 255 : inflated[src + 3];
  }
}

/** Read a zero-terminated list of id-sized ids into `outIds`. */
function readIdList(bytes, offset, outIds, idSize) {
  var readId = idReader(idSize);
  while (true) {
    var id = readId(bytes, offset);
    offset += idSize;
    if (id == 0) break;
    outIds.push(id);
  }
  return offset;
}

/** Read a property list (type, size, payload) until PROP_END. */
function readPropertyList(bytes, offset, outProps) {
  while (true) {
    var propType = BinaryUtils.readUint32BE(bytes, offset);
    offset += 4;
    var propSize = BinaryUtils.readUint32BE(bytes, offset);
    offset += 4;
    if (propType == XcfPropType.PROP_END) break;
    if (propType == XcfPropType.PROP_PARASITES) outProps[propType] = readParasiteMap(bytes, offset, offset + propSize);
    else outProps[propType] = BinaryUtils.readBytes(bytes, offset, propSize);
    offset += propSize;
  }
  return offset;
}

/** Read a parasite map (name → data bytes) within [offset, endOffset). */
function readParasiteMap(bytes, offset, endOffset) {
  var parasites = {};
  while (offset < endOffset) {
    var nameEntry = BinaryUtils.readLengthPrefixedUtf8(bytes, offset);
    offset += nameEntry.size;
    var flags = BinaryUtils.readUint32BE(bytes, offset);
    offset += 4;
    if (flags != 1) console.log("unknown flags", flags);
    var dataSize = BinaryUtils.readUint32BE(bytes, offset);
    offset += 4;
    parasites[nameEntry.str] = BinaryUtils.readBytes(bytes, offset, dataSize);
    offset += dataSize;
  }
  return parasites;
}

const XCFParser = { parse, parseTextParasite, parseSExprTokens, channelCountForBitDepth, resolveGimpFontName };

export { XCFParser };
