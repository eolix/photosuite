/**
 * HDR and scientific float codecs: EXR and FITS.
 * Wired in `file-format-registry.js`.
 */

import { Rect } from "../../../core/math/rect.js";
import { BinaryUtils } from "../../../core/binary/binary-utils.js";
import { allocBuffer } from "../../../engine/compositing/buffer-utils.js";
import { linearToSrgb } from "../../../engine/compositing/color-math.js";

/* global EXRLoader */

const FITS_HEADER_CARD_BYTES = 80;
const FITS_HEADER_MAX_CARDS = 306;
const FITS_DATA_BLOCK_BYTES = 2880;

/** Maps one linear HDR channel sample to an 8-bit sRGB byte. */
function linearChannelToByte(linearChannel) {
  return ~~(0.5 + linearToSrgb(Math.max(0, Math.min(1, linearChannel))) * 255);
}

function flipExrFloatRowsToRgba(exrData) {
  var width = exrData.width;
  var height = exrData.height;
  var rgbaBuffer = allocBuffer(width * height * 4);
  for (var rowIdx = 0; rowIdx < height; rowIdx++) {
    for (var colIdx = 0; colIdx < width; colIdx++) {
      var destOffset = (rowIdx * width + colIdx) * 4;
      var srcOffset = ((height - rowIdx - 1) * width + colIdx) * 4;
      rgbaBuffer[destOffset] = linearChannelToByte(exrData.data[srcOffset + 0]);
      rgbaBuffer[destOffset + 1] = linearChannelToByte(exrData.data[srcOffset + 1]);
      rgbaBuffer[destOffset + 2] = linearChannelToByte(exrData.data[srcOffset + 2]);
      rgbaBuffer[destOffset + 3] = linearChannelToByte(exrData.data[srcOffset + 3]);
    }
  }
  return { width: width, height: height, rgbaBuffer: rgbaBuffer };
}

function decodeExrDocument(buffer, doc) {
  var exrData = EXRLoader.parse(buffer);
  var rgbaResult = flipExrFloatRowsToRgba(exrData);
  return [{
    rect: new Rect(0, 0, rgbaResult.width, rgbaResult.height),
    data: rgbaResult.rgbaBuffer.buffer,
  }];
}

/** Reads FITS header cards until END; returns field map and byte offset to pixel data. */
function parseFitsHeader(bytes) {
  var headerOffset = 0;
  var headerFields = {};
  for (var cardIdx = 0; cardIdx < FITS_HEADER_MAX_CARDS; cardIdx++) {
    var keyword = BinaryUtils.readString(bytes, headerOffset, 8).trim();
    var value = BinaryUtils.readString(bytes, headerOffset + 9, 71).split("/")[0].trim();
    headerFields[keyword] = value;
    headerOffset += FITS_HEADER_CARD_BYTES;
    if (keyword === "END") {
      headerOffset = Math.ceil(headerOffset / FITS_DATA_BLOCK_BYTES) * FITS_DATA_BLOCK_BYTES;
      break;
    }
  }
  return { headerFields: headerFields, dataOffset: headerOffset };
}

function readFitsPixelValues(bytes, headerFields, dataOffset) {
  var width = parseInt(headerFields.NAXIS1);
  var height = parseInt(headerFields.NAXIS2);
  var pixelCount = width * height;
  var bitpix = parseInt(headerFields.BITPIX);
  var minValue = 1e9;
  var maxValue = -1e9;
  var pixelValues = new Float32Array(pixelCount);
  var floatView = new Float32Array(bytes.buffer, dataOffset, bytes.buffer.byteLength - dataOffset >>> 2);
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    var byteOffset32 = pixelIdx << 2;
    var byteOffset16 = pixelIdx << 1;
    if (bitpix === -32) {
      var swapByte = bytes[dataOffset + byteOffset32 + 0];
      bytes[dataOffset + byteOffset32 + 0] = bytes[dataOffset + byteOffset32 + 3];
      bytes[dataOffset + byteOffset32 + 3] = swapByte;
      swapByte = bytes[dataOffset + byteOffset32 + 1];
      bytes[dataOffset + byteOffset32 + 1] = bytes[dataOffset + byteOffset32 + 2];
      bytes[dataOffset + byteOffset32 + 2] = swapByte;
      pixelValues[pixelIdx] = floatView[pixelIdx];
    } else if (bitpix === 16) {
      pixelValues[pixelIdx] = BinaryUtils.readUint16LE(bytes, dataOffset + byteOffset16);
    } else throw bitpix;
    var sampleValue = pixelValues[pixelIdx];
    if (sampleValue < minValue) minValue = sampleValue;
    if (sampleValue > maxValue) maxValue = sampleValue;
  }
  return { width: width, height: height, pixelValues: pixelValues, maxValue: maxValue };
}

function fitsPixelsToRgba(pixelPayload, headerFields) {
  var width = pixelPayload.width;
  var height = pixelPayload.height;
  var pixelValues = pixelPayload.pixelValues;
  var pixelCount = width * height;
  var rgbaBuffer = allocBuffer(pixelCount * 4);
  var scaleFactor = 1 / pixelPayload.maxValue;
  for (var rowIdx = 0; rowIdx < height; rowIdx++) {
    for (var colIdx = 0; colIdx < width; colIdx++) {
      var pixelIdx = rowIdx * width + colIdx;
      var flippedPixelIdx = (height - rowIdx - 1) * width + colIdx;
      var rgbaOffset = flippedPixelIdx << 2;
      var normalizedValue = pixelValues[pixelIdx] * scaleFactor;
      rgbaBuffer[rgbaOffset] = rgbaBuffer[rgbaOffset + 1] = rgbaBuffer[rgbaOffset + 2] = 255 * normalizedValue;
      rgbaBuffer[rgbaOffset + 3] = 255;
    }
  }
  return {
    rect: new Rect(0, 0, width, height),
    data: rgbaBuffer,
    layerName: headerFields.OBJECT,
  };
}

function decodeFitsDocument(buffer) {
  var bytes = new Uint8Array(buffer);
  var header = parseFitsHeader(bytes);
  var pixelPayload = readFitsPixelValues(bytes, header.headerFields, header.dataOffset);
  return [fitsPixelsToRgba(pixelPayload, header.headerFields)];
}

export const exrCodec = {};
exrCodec.decode = decodeExrDocument;

export const fitsCodec = {};
fitsCodec.decode = decodeFitsDocument;
