/**
 * PSD per-channel image codec: raw, PackBits/RLE, ZIP, and ZIP-with-prediction
 * compression for layer channel planes and interleaved RGBA assembly.
 */
/* global pako */
import { BinaryUtils } from "../../../core/binary/binary-utils.js";
import { PlanarRgbaBuffer, allocBuffer, interleavedToPlanar, planarToInterleaved } from "../../../engine/compositing/buffer-utils.js";

/** PSD channel-compression scheme codes. */
const COMPRESS_RAW = 0;
const COMPRESS_RLE = 1;
const COMPRESS_ZIP = 2;
const COMPRESS_ZIP_PREDICTION = 3;

/** PSD image color modes. */
const COLOR_MODE_GRAYSCALE = 1;
const COLOR_MODE_RGB = 3;
const COLOR_MODE_CMYK = 4;

/** Special PSD channel ids. */
const CHANNEL_TRANSPARENCY = -1;
const CHANNEL_USER_MASK = -2;
const CHANNEL_VECTOR_MASK = -3;

function parse(layer, doc, data, pos) {
  return readLayerChannels(doc.isPSB, doc.bitDepth, doc.colorMode, layer, data, pos);
}

function serialize(isPSB, layer, buf, pos, channelDataOffset, options) {
  return writeLayerChannels(isPSB, layer, buf, pos, channelDataOffset, options);
}

/** Read every channel plane of a layer and assemble the interleaved buffer. */
function readLayerChannels(isPSB, bitDepth, colorMode, layer, data, pos) {
  var channelInfo = layer.channelInfo;
  var channels = {};
  for (var i = 0; i < channelInfo.length; i++) {
    var chEntry = channelInfo[i];
    var chId = chEntry.id;
    var chLength = chEntry.length;
    var chRect;
    if (chId == CHANNEL_VECTOR_MASK) chRect = layer.warpData.rect;
    else if (chId == CHANNEL_USER_MASK) chRect = layer.d.rect;
    else chRect = layer.rect;
    var chBuffer = readChannelBuffer(isPSB, bitDepth, data, chRect.width, chRect.height, pos, chLength);
    pos += chLength;
    if (chId == CHANNEL_VECTOR_MASK) layer.warpData.channel = chBuffer;
    else if (chId == CHANNEL_USER_MASK) layer.d.channel = chBuffer;
    else channels["c" + chId] = chBuffer;
  }

  var planarBuf = new PlanarRgbaBuffer(0);
  planarBuf.w = null;
  if (colorMode == COLOR_MODE_RGB) {
    planarBuf.h = channels.c0;
    planarBuf.l = channels.c1;
    planarBuf.O = channels.c2;
    planarBuf.w = channels["c-1"];
  } else if (colorMode == COLOR_MODE_GRAYSCALE) {
    planarBuf.h = channels.c0;
    planarBuf.l = channels.c0;
    planarBuf.O = channels.c0;
    planarBuf.w = channels["c-1"];
  } else if (colorMode == COLOR_MODE_CMYK) {
    convertCmykToRgb(channels.c0, channels.c1, channels.c2, channels.c3);
    planarBuf.h = channels.c0;
    planarBuf.l = channels.c1;
    planarBuf.O = channels.c2;
    planarBuf.w = channels["c-1"];
    console.log("converting from CMYK to RGB");
  }
  if (planarBuf.h == null) planarBuf.h = allocBuffer(0);
  if (planarBuf.w == null && planarBuf.h != null) {
    planarBuf.w = planarBuf.h.slice(0);
    planarBuf.w.fill(255);
  }
  if (planarBuf.l == null) planarBuf.l = planarBuf.h.slice(0);
  if (planarBuf.O == null) planarBuf.O = planarBuf.h.slice(0);
  layer.buffer = allocBuffer(Math.max(0, layer.rect.area() * 4));
  planarToInterleaved(planarBuf, layer.buffer);
  return pos;
}

/** Convert CMYK channel planes to RGB in place (c/m/y hold the result). */
function convertCmykToRgb(cCh, mCh, yCh, kCh) {
  var pixelCount = cCh.length;
  var kFactor = 1 / 255;
  for (var i = 0; i < pixelCount; i++) {
    var cVal = cCh[i];
    var mVal = mCh[i];
    var yVal = yCh[i];
    var k = kCh[i] * kFactor;
    cCh[i] = Math.round(cVal * k);
    mCh[i] = Math.round((.2 * cVal + .8 * mVal) * k);
    yCh[i] = Math.round((.2 * mVal + .8 * yVal) * k);
  }
}

/** Split a layer's interleaved buffer into channel planes and write them. */
function writeLayerChannels(isPSB, layer, buf, pos, channelDataOffset, options) {
  var channelIds = layer.getChannelIds();
  var planarBuf = new PlanarRgbaBuffer(layer.rect.area());
  interleavedToPlanar(layer.buffer, planarBuf);
  for (var i = 0; i < channelIds.length; i++) {
    var chId = channelIds[i];
    var chRect, chData;
    if (chId == CHANNEL_VECTOR_MASK) chRect = layer.warpData.rect;
    else if (chId == CHANNEL_USER_MASK) chRect = layer.d.rect;
    else chRect = layer.rect;
    if (chId == CHANNEL_VECTOR_MASK) chData = layer.warpData.channel;
    if (chId == CHANNEL_USER_MASK) chData = layer.d.channel;
    if (chId == CHANNEL_TRANSPARENCY) chData = planarBuf.w;
    if (chId == 0) chData = planarBuf.h;
    if (chId == 1) chData = planarBuf.l;
    if (chId == 2) chData = planarBuf.O;
    buf.ensureCapacity(pos, chRect.area() * 3 + 4);
    var startPos = pos;
    pos = writeChannelBuffer(isPSB, chData, buf.data, chRect.width, chRect.height, pos, options[1] ? COMPRESS_ZIP_PREDICTION : COMPRESS_RLE);
    var chSize = pos - startPos;
    if (isPSB) BinaryUtils.writeInt64BERaw(buf.data, channelDataOffset + i * 10 + 2, chSize);
    else BinaryUtils.writeUint32BE(buf.data, channelDataOffset + i * 6 + 2, chSize);
  }
  return pos;
}

/** Read one channel's [compression tag][data] block. */
function readChannelBuffer(isPSB, bitDepth, data, width, height, pos, byteLength) {
  var compression = BinaryUtils.readUint16(data, pos);
  pos += 2;
  return decompressChannel(isPSB, bitDepth, data, width, height, pos, compression, byteLength - 2);
}

/** Write one channel's [compression tag][data] block. */
function writeChannelBuffer(isPSB, channelData, data, width, height, pos, compression) {
  BinaryUtils.writeUint16Raw(data, pos, compression);
  pos += 2;
  return compressChannel(isPSB, channelData, data, width, height, pos, compression);
}

/** Decode a channel's compressed bytes into a raw sample buffer. */
function decompressChannel(isPSB, bitDepth, data, width, height, pos, compression, byteLength) {
  var output;
  var rawByteCount = width * height * (bitDepth >>> 3);
  var padding = rawByteCount & 3;
  var paddedByteCount = rawByteCount + (padding == 0 ? 0 : 4 - padding);
  if (byteLength <= 0) return allocBuffer(paddedByteCount);
  if (compression > COMPRESS_ZIP_PREDICTION) {
    console.log("unknown compression: " + compression, width, height, width * height, byteLength);
    compression = COMPRESS_RAW;
  }

  if (compression == COMPRESS_RAW) {
    if (pos + paddedByteCount <= data.length) {
      output = data.slice(pos, pos + paddedByteCount);
    } else {
      output = allocBuffer(rawByteCount);
      for (var i = 0; i < rawByteCount; i++) output[i] = data[pos + i];
    }
    pos += rawByteCount;
  } else if (compression == COMPRESS_RLE) {
    output = allocBuffer(rawByteCount);
    var scanlineEntrySize = isPSB ? 4 : 2;
    var packedBytesCount = decodePackBits(data, output, width, height, pos, pos + scanlineEntrySize * height, scanlineEntrySize);
    pos += scanlineEntrySize * height + packedBytesCount;
  } else if (compression == COMPRESS_ZIP || compression == COMPRESS_ZIP_PREDICTION) {
    var compressedSlice = new Uint8Array(data.buffer, pos + 2, byteLength - 6);
    var inflated = pako.inflateRaw(compressedSlice);
    if (compression == COMPRESS_ZIP_PREDICTION) {
      if (bitDepth == 8) unfilterPrediction8(inflated, width, height);
      else unfilterPrediction16(inflated, width, height);
    }
    if (inflated.length == paddedByteCount) {
      output = inflated;
    } else {
      output = allocBuffer(paddedByteCount);
      for (var i = 0; i < inflated.length; i++) output[i] = inflated[i];
    }
  }

  if (bitDepth == 16) {
    var buf16 = allocBuffer(width * height);
    for (var i = 0; i < rawByteCount; i += 2) buf16[i >>> 1] = output[i];
    output = buf16;
  }
  return output;
}

/** Undo per-row delta prediction on an 8-bit inflated channel, in place. */
function unfilterPrediction8(inflated, width, height) {
  for (var row = 0; row < height; row++) {
    var rowStart = row * width + 1;
    var rowEnd = rowStart + width - 1;
    var prevVal = inflated[rowStart - 1];
    for (var col = rowStart; col < rowEnd; col++) {
      prevVal += inflated[col];
      inflated[col] = prevVal & 255;
    }
  }
}

/** Undo per-row delta prediction on a 16-bit inflated channel, in place. */
function unfilterPrediction16(inflated, width, height) {
  for (var row = 0; row < height; row++) {
    var rowStart = row * width + 1;
    var rowEnd = rowStart + width - 1;
    var prevVal = inflated[2 * rowStart - 2] << 8 | inflated[2 * rowStart - 1];
    for (var col = rowStart; col < rowEnd; col++) {
      var colOffset = col << 1;
      prevVal += inflated[colOffset] << 8 | inflated[colOffset + 1];
      inflated[colOffset] = prevVal >>> 8;
      inflated[colOffset + 1] = prevVal & 255;
    }
  }
}

/** Encode a raw sample buffer into the given channel compression scheme. */
function compressChannel(isPSB, channelData, data, width, height, pos, compression) {
  var pixelCount = width * height;
  if (compression == COMPRESS_RAW) {
    for (var i = 0; i < pixelCount; i++) data[pos++] = channelData[i];
  } else if (compression == COMPRESS_RLE) {
    var scanlineEntrySize = isPSB ? 4 : 2;
    var packedBytesCount = encodePackBits(channelData, data, width, height, pos, pos + scanlineEntrySize * height, scanlineEntrySize);
    pos += scanlineEntrySize * height + packedBytesCount;
  } else if (compression == COMPRESS_ZIP || compression == COMPRESS_ZIP_PREDICTION) {
    if (compression == COMPRESS_ZIP_PREDICTION) channelData = filterPrediction8(channelData, width, height);
    data[pos] = 120;
    data[pos + 1] = 156;
    pos += 2;
    var deflated = pako.deflateRaw(channelData, { a8G: 4 });
    BinaryUtils.writeBytesRaw(data, pos, deflated);
    pos += deflated.length + 4;
  } else {
    console.log("Unknown compression: " + compression);
  }
  return pos;
}

/** Apply per-row delta prediction to an 8-bit channel, returning a new buffer. */
function filterPrediction8(channelData, width, height) {
  var predFiltered = new Uint8Array(channelData.length);
  for (var row = 0; row < height; row++) {
    var rowStart = row * width + 1;
    var rowEnd = rowStart + width - 1;
    var prevVal = channelData[rowStart - 1];
    predFiltered[rowStart - 1] = prevVal;
    for (var col = rowStart; col < rowEnd; col++) {
      predFiltered[col] = channelData[col] + (256 - prevVal) & 255;
      prevVal = channelData[col];
    }
  }
  return predFiltered;
}

/** Decode PackBits rows using the per-scanline length table. */
function decodePackBits(data, output, width, height, scanlineTablePos, pixelDataPos, scanlineEntrySize) {
  var initialPixelPos = pixelDataPos;
  var rowCount = height | 0;
  if (scanlineEntrySize == 2) {
    for (var row = 0; row < rowCount; row++) {
      var rowLen = BinaryUtils.readUint16(data, scanlineTablePos + (row << 1));
      packBitsDecodeRow(data, pixelDataPos, rowLen, output, row * width, width);
      pixelDataPos += rowLen;
    }
  } else {
    for (var row = 0; row < rowCount; row++) {
      var rowLen = BinaryUtils.readUint32BE(data, scanlineTablePos + (row << 2));
      packBitsDecodeRow(data, pixelDataPos, rowLen, output, row * width, width);
      pixelDataPos += rowLen;
    }
  }
  return pixelDataPos - initialPixelPos;
}

/** Encode PackBits rows, filling the per-scanline length table. */
function encodePackBits(input, output, width, height, scanlineTablePos, pixelDataPos, scanlineEntrySize) {
  var initialPixelPos = pixelDataPos;
  if (scanlineEntrySize == 2) {
    for (var row = 0; row < height; row++) {
      var rowLen = packBitsEncodeRow(input, row * width, width, output, pixelDataPos);
      BinaryUtils.writeUint16Raw(output, scanlineTablePos + row * 2, rowLen);
      pixelDataPos += rowLen;
    }
  } else {
    for (var row = 0; row < height; row++) {
      var rowLen = packBitsEncodeRow(input, row * width, width, output, pixelDataPos);
      BinaryUtils.writeUint32BE(output, scanlineTablePos + row * 4, rowLen);
      pixelDataPos += rowLen;
    }
  }
  return pixelDataPos - initialPixelPos;
}

/** PackBits-encode one row; returns the encoded byte length. */
function packBitsEncodeRow(input, startOffset, count, output, writeStart) {
  var runEnd, writePos, readPos, inputEnd, runLength, maxRun;
  inputEnd = startOffset + count;
  for (readPos = startOffset, writePos = writeStart; count > 0; readPos = runEnd, count -= runLength) {
    maxRun = count < 128 ? count : 128;
    if (readPos <= inputEnd - 3 && input[readPos + 1] == input[readPos + 0] && input[readPos + 2] == input[readPos + 0]) {
      for (runEnd = readPos + 3; runEnd < readPos + maxRun && input[runEnd] == input[readPos + 0];) ++runEnd;
      runLength = runEnd - readPos;
      output[writePos++] = 1 + 256 - runLength;
      output[writePos++] = input[readPos + 0];
    } else {
      for (runEnd = readPos; runEnd < readPos + maxRun;) {
        if (runEnd <= inputEnd - 3 && input[runEnd + 1] == input[runEnd + 0] && input[runEnd + 2] == input[runEnd + 0]) break;
        else ++runEnd;
      }
      runLength = runEnd - readPos;
      output[writePos++] = runLength - 1;
      for (var j = 0; j < runLength; j++) output[writePos + j] = input[readPos + j];
      writePos += runLength;
    }
  }
  return writePos - writeStart;
}

/** PackBits-decode one row into `output` at `writeOffset`. */
function packBitsDecodeRow(data, readPos, byteCount, output, writeOffset) {
  for (var bytesRead = 0; bytesRead < byteCount;) {
    var code = data[readPos++];
    if (code >= 128) {
      var value = data[readPos++];
      var runEnd = writeOffset + (257 - code);
      while (writeOffset + 1 < runEnd) {
        output[writeOffset++] = output[writeOffset++] = value;
      }
      if (writeOffset < runEnd) output[writeOffset++] = value;
      bytesRead += 2;
    } else {
      for (var j = 0; j <= code; j++) output[writeOffset + j] = data[readPos + j];
      readPos += code + 1;
      writeOffset += code + 1;
      bytesRead += 1 + 1 + code;
    }
  }
}

const ChannelImageCodec = {
  parse,
  serialize,
  readLayerChannels,
  writeLayerChannels,
  readChannelBuffer,
  writeChannelBuffer,
  decompressChannel,
  compressChannel,
  decodePackBits,
  encodePackBits,
  packBitsEncodeRow,
  packBitsDecodeRow,
};

export { ChannelImageCodec };
