/**
 * GPU/game texture codecs: DDS and VTF.
 * Wired in `file-format-registry.js`.
 */

import { Rect } from "../../../core/math/rect.js";
import { fillBuffer } from "../../../engine/compositing/buffer-utils.js";
import { copyPixels } from "../../../engine/compositing/pixel-ops.js";

/* global UTEX */

/** VTF image format ids handled by {@link decodeVtfFrames}. */
const VTF_FORMAT_RGBA8888 = 0;
const VTF_FORMAT_BGRA8888 = 12;
const VTF_FORMAT_BGR888 = 2;
const VTF_FORMAT_DXT1 = 13;
const VTF_FORMAT_DXT3 = 14;
const VTF_FORMAT_DXT5 = 15;

/** Pads RGBA dimensions up to a multiple of four for DXT block encoding. */
function padRgbaToBlockMultiple(pixelBytes, width, height) {
  if ((width & 3) === 0 && (height & 3) === 0) {
    return { pixelBytes: pixelBytes, width: width, height: height };
  }
  var paddedWidth = width + (4 - (width & 3));
  var paddedHeight = height + (4 - (height & 3));
  var paddedPixels = new Uint8Array(paddedWidth * paddedHeight * 4);
  fillBuffer(paddedPixels, 4278190080);
  copyPixels(pixelBytes, new Rect(0, 0, width, height), paddedPixels, new Rect(0, 0, paddedWidth, paddedHeight));
  return { pixelBytes: paddedPixels, width: paddedWidth, height: paddedHeight };
}

function encodeDdsFromFrames(frames, width, height, encodeOptions) {
  var pixelBytes = new Uint8Array(frames[0][0]);
  var padded = padRgbaToBlockMultiple(pixelBytes, width, height);
  return UTEX.DDS.encode(padded.pixelBytes.buffer, padded.width, padded.height);
}

function decodeDdsToLayerFrames(buffer) {
  var decodedFrame = UTEX.DDS.decode(buffer)[0];
  return [{
    rect: new Rect(0, 0, decodedFrame.width, decodedFrame.height),
    data: decodedFrame.image,
  }];
}

export const ddsCodec = {};
ddsCodec.encode = encodeDdsFromFrames;
ddsCodec.decode = decodeDdsToLayerFrames;

/**
 * Valve VTF texture decoder. The container header is parsed here; block-compressed
 * mip levels are expanded with the bundled UTEX helpers (readBC1/readBC2/readBC3).
 */

function readVtfUint16LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8);
}

/**
 * @param {Uint8Array} data
 * @param {number} offset
 * @param {Record<string, number>} header
 * @returns {number} byte offset to mip/thumbnail payload (third uint32 in the file header)
 */
function parseVtfHeader(data, offset, header) {
  var readU32 = UTEX.U.readUintLE;
  var readASCII = UTEX.U.readASCII;

  readASCII(data, offset, 4);
  offset += 4;
  readU32(data, offset);
  offset += 4;
  var version = readU32(data, offset);
  offset += 4;
  var dataOffset = readU32(data, offset);
  offset += 4;
  header.width = readVtfUint16LE(data, offset);
  offset += 2;
  header.height = readVtfUint16LE(data, offset);
  offset += 2;
  header.flags = readU32(data, offset);
  offset += 4;
  header.frames = readVtfUint16LE(data, offset);
  offset += 2;
  readVtfUint16LE(data, offset);
  offset += 2;
  offset += 4;
  offset += 12;
  offset += 4;
  offset += 4;
  header.format = readU32(data, offset);
  offset += 4;
  header.mipCount = data[offset++];
  readU32(data, offset);
  offset += 4;
  header.thumbWidth = data[offset++];
  header.thumbHeight = data[offset++];
  if (version >= 2) {
    header.depth = readVtfUint16LE(data, offset);
    offset += 2;
    if (version >= 3) {
      offset += 3;
      readU32(data, offset);
      offset += 4;
    }
  }
  return dataOffset;
}

function decodeVtfUncompressedRgba(data, offset, pixels, width, height, format) {
  var pixelCount = width * height;
  if (format === VTF_FORMAT_RGBA8888 || format === VTF_FORMAT_BGRA8888) {
    var channelOrder = format === VTF_FORMAT_RGBA8888 ? [0, 1, 2, 3] : [2, 1, 0, 3];
    var redChannel = channelOrder[0];
    var greenChannel = channelOrder[1];
    var blueChannel = channelOrder[2];
    var alphaChannel = channelOrder[3];
    for (var pixelIdx = 0; pixelIdx < pixels.length; pixelIdx += 4) {
      pixels[pixelIdx + redChannel] = data[offset++];
      pixels[pixelIdx + greenChannel] = data[offset++];
      pixels[pixelIdx + blueChannel] = data[offset++];
      pixels[pixelIdx + alphaChannel] = data[offset++];
    }
    return offset;
  }
  if (format === VTF_FORMAT_BGR888) {
    for (var pixelIdx = 0; pixelIdx < pixels.length; pixelIdx += 4) {
      pixels[pixelIdx] = data[offset++];
      pixels[pixelIdx + 1] = data[offset++];
      pixels[pixelIdx + 2] = data[offset++];
      pixels[pixelIdx + 3] = 255;
    }
    return offset;
  }
  if (format === VTF_FORMAT_DXT1) return UTEX.readBC1(data, offset, pixels, width, height);
  if (format === VTF_FORMAT_DXT3) return UTEX.readBC2(data, offset, pixels, width, height);
  if (format === VTF_FORMAT_DXT5) return UTEX.readBC3(data, offset, pixels, width, height);
  throw new Error("Unsupported VTF format: " + format);
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {{ width: number, height: number, image: ArrayBuffer }[]}
 */
export function decodeVtfFrames(buffer) {
  var data = new Uint8Array(buffer);
  var header = {};
  var offset = parseVtfHeader(data, 0, header);

  var thumbWidth = header.thumbWidth;
  var thumbHeight = header.thumbHeight;
  if (thumbWidth * thumbHeight !== 0) {
    var thumbPixels = new Uint8Array(thumbWidth * thumbHeight * 4);
    offset = UTEX.readBC1(data, offset, thumbPixels, thumbWidth, thumbHeight);
  }

  var format = header.format;
  var mipLevels = header.mipCount;
  var frames = [];

  for (var mipLevel = 0; mipLevel < mipLevels; mipLevel++) {
    var mipWidth = header.width >>> mipLevels - 1 - mipLevel;
    var mipHeight = header.height >>> mipLevels - 1 - mipLevel;
    for (var frameIdx = 0; frameIdx < header.frames; frameIdx++) {
      var pixels = new Uint8Array(mipWidth * mipHeight * 4);
      offset = decodeVtfUncompressedRgba(data, offset, pixels, mipWidth, mipHeight, format);
      frames.push({
        width: mipWidth,
        height: mipHeight,
        image: pixels.buffer,
      });
    }
  }
  return frames;
}

function decodeVtfToLayerFrames(buffer) {
  var frame = decodeVtfFrames(buffer).pop();
  return [{
    rect: new Rect(0, 0, frame.width, frame.height),
    data: frame.image,
  }];
}

export const vtfCodec = {};
vtfCodec.decode = decodeVtfToLayerFrames;
