/**
 * Camera RAW codecs: RAF and generic RAW develop path.
 * Wired in `file-format-registry.js`.
 */

import { BinaryUtils } from "../../../core/binary/binary-utils.js";
import { extractChannelByte } from "../../../engine/compositing/buffer-utils.js";

/* global UTIF, alert */

const FUJI_MAKER_NOTE_FIELD_BYTES = 32;

/** @param {Uint8Array} targetBytes @param {number} bitOffset @param {number} valueBits */
function writeBitsIntoBuffer(targetBytes, bitOffset, valueBits) {
  valueBits = valueBits << (8 - (bitOffset & 7));
  var byteIndex = bitOffset >>> 3;
  targetBytes[byteIndex] |= valueBits >>> 16;
  targetBytes[byteIndex + 1] |= valueBits >>> 8;
  targetBytes[byteIndex + 2] |= valueBits;
}

/** Reorders packed sample bytes for 16-, 14-, and 12-bit RAF strip layouts. */
function byteSwapRawStripForBitDepth(stripBytes, bitsPerPixel) {
  var dataLength = stripBytes.length;
  if (bitsPerPixel == 16) {
    for (var swapIdx = 0; swapIdx < dataLength; swapIdx += 2) {
      var swapTemp = stripBytes[swapIdx];
      stripBytes[swapIdx] = stripBytes[swapIdx + 1];
      stripBytes[swapIdx + 1] = swapTemp;
    }
  } else if (bitsPerPixel == 14) {
    for (var swapIdx = 0; swapIdx < dataLength; swapIdx += 4) {
      var swapTemp = stripBytes[swapIdx];
      stripBytes[swapIdx] = stripBytes[swapIdx + 3];
      stripBytes[swapIdx + 3] = swapTemp;
      swapTemp = stripBytes[swapIdx + 1];
      stripBytes[swapIdx + 1] = stripBytes[swapIdx + 2];
      stripBytes[swapIdx + 2] = swapTemp;
    }
  } else if (bitsPerPixel == 12) {
    for (var swapIdx = 0; swapIdx < dataLength; swapIdx += 3) {
      var packedPixels =
        stripBytes[swapIdx + 2] << 16 | stripBytes[swapIdx + 1] << 8 | stripBytes[swapIdx + 0];
      packedPixels = packedPixels >>> 12 | (packedPixels & 4095) << 12;
      stripBytes[swapIdx] = packedPixels >>> 16 & 255;
      stripBytes[swapIdx + 1] = packedPixels >>> 8 & 255;
      stripBytes[swapIdx + 2] = packedPixels & 255;
    }
  }
  return stripBytes;
}

/**
 * Expands a Fuji RAF strip when width/height are stored transposed (portrait tags).
 * @param {Uint8Array} stripBytes
 * @param {number} imageWidth
 * @param {number} imageHeight
 */
function unpackFujiRafStrip(stripBytes, imageWidth, imageHeight) {
  stripBytes = new Uint16Array(stripBytes.buffer);
  var outputPixels = new Uint16Array(imageWidth * imageHeight * 2);
  for (var rowIdx = 0; rowIdx < imageHeight; rowIdx += 2) {
    for (var colIdx = 0; colIdx < imageWidth; colIdx++) {
      var srcIndex = rowIdx * imageWidth + colIdx;
      var destIndex = srcIndex * 2;
      var currentPixel = stripBytes[srcIndex];
      var nextRowPixel = stripBytes[srcIndex + imageWidth];
      outputPixels[destIndex + 1] = outputPixels[destIndex + 2 * imageWidth] = nextRowPixel;
      if (((rowIdx >>> 1) + colIdx & 1) == 0) {
        outputPixels[destIndex] = currentPixel;
        outputPixels[destIndex + 2 * imageWidth + 1] = stripBytes[srcIndex + 1];
      } else {
        outputPixels[destIndex] = stripBytes[srcIndex - 1];
        outputPixels[destIndex + 2 * imageWidth + 1] = currentPixel;
      }
    }
  }
  return outputPixels;
}

export const rafCodec = {};

rafCodec.decode = function (buffer) {
  var bytes = new Uint8Array(buffer);
  var offset = 16;
  BinaryUtils.readString(bytes, offset, 4);
  offset += 4;
  BinaryUtils.readString(bytes, offset, 8);
  offset += 8;

  var makerNoteFieldSize = FUJI_MAKER_NOTE_FIELD_BYTES;
  while (bytes[offset + makerNoteFieldSize - 1] == 0) makerNoteFieldSize--;

  var cameraModel = BinaryUtils.readString(bytes, offset, makerNoteFieldSize);
  offset += FUJI_MAKER_NOTE_FIELD_BYTES;
  BinaryUtils.readString(bytes, offset, 4);
  offset += 4;
  offset += 20;

  BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var ifdOffset = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var rawDataOffset = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  var rawDataSize = BinaryUtils.readUint32BE(bytes, offset);

  var imageWidth = 0;
  var imageHeight = 0;
  var cameraMakeModel = "FujiFilm " + cameraModel;
  var cfaPattern = [0, 1, 1, 2];
  if (cameraMakeModel == "FujiFilm X10") {
    cameraMakeModel = "FujiFilm FinePix X10";
    cfaPattern = [2, 1, 1, 0];
  }

  var exifTags = {
    t271: ["FujiFilm"],
    t272: [cameraMakeModel],
    t277: [1],
    t33421: [2, 2],
    t33422: cfaPattern,
    orientation: 1,
  };

  offset = ifdOffset;
  var stripOffsets = [];
  var readUint16 = BinaryUtils.readUint16;
  var ifdEntryCount = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;

  for (var ifdEntryIdx = 0; ifdEntryIdx < ifdEntryCount; ifdEntryIdx++) {
    var tagId = readUint16(bytes, offset);
    offset += 2;
    var tagDataSize = readUint16(bytes, offset);
    offset += 2;

    if (tagId == 256) {
      imageWidth = readUint16(bytes, offset);
      imageHeight = readUint16(bytes, offset + 2);
    } else if (tagId == 272) {
      stripOffsets = [readUint16(bytes, offset), readUint16(bytes, offset + 2)];
    } else if (tagId == 273) {
      stripOffsets.push(readUint16(bytes, offset), readUint16(bytes, offset + 2));
    } else if (tagId == 305) {
      var cfaSideLength = Math.round(Math.sqrt(tagDataSize));
      var patternBytes = [];
      for (var patternIdx = 0; patternIdx < tagDataSize; patternIdx++) {
        patternBytes.push(bytes[offset + patternIdx]);
      }
      patternBytes.reverse();
      exifTags.t33421 = [cfaSideLength, cfaSideLength];
      exifTags.t33422 = patternBytes;
    } else if (tagId == 12272) {
      var focalNumerator = readUint16(bytes, offset);
      var focalDenominatorX = readUint16(bytes, offset + 2);
      var focalDenominatorY = readUint16(bytes, offset + 6);
      exifTags.t50728 = [focalNumerator / focalDenominatorX, 1, focalNumerator / focalDenominatorY];
    }
    offset += tagDataSize;
  }

  var dimensionsSwapped = imageWidth < imageHeight;
  var rawStripBytes = bytes.slice(rawDataOffset, rawDataOffset + rawDataSize);
  var bitsPerSample = Math.round((rawDataSize * 8) / (imageWidth * imageHeight));

  if (rawStripBytes[0] == 73 && rawStripBytes[1] == 73 && rawStripBytes[2] == 42) {
    var embeddedTiffIfd = UTIF.decode(rawStripBytes.buffer)[0].fujiIFD;
    bitsPerSample = embeddedTiffIfd.t61443[0];
    var focalPlaneResolution = embeddedTiffIfd.t61454;
    exifTags.t50728 = [
      focalPlaneResolution[0] / focalPlaneResolution[1],
      1,
      focalPlaneResolution[0] / focalPlaneResolution[2],
    ];
    var stripByteOffset = embeddedTiffIfd.t61447[0];
    rawStripBytes = rawStripBytes.slice(
      stripByteOffset,
      stripByteOffset + embeddedTiffIfd.t61448[0]
    );
  }

  var dataLength = rawStripBytes.length;
  var isCompressed = dataLength * 8 < imageWidth * imageHeight * bitsPerSample;
  if (isCompressed) alert("Compressed RAF is not supported yet :(");

  var bitsPerPixel = (dataLength * 8) / (imageWidth * imageHeight);
  byteSwapRawStripForBitDepth(rawStripBytes, bitsPerPixel);

  if (dimensionsSwapped) {
    rawStripBytes = unpackFujiRafStrip(rawStripBytes, imageWidth, imageHeight);
  }

  var widthScaleFactor = dimensionsSwapped ? 2 : 1;
  imageWidth *= widthScaleFactor;
  exifTags.t256 = [imageWidth];
  exifTags.t257 = [imageHeight];
  exifTags.t258 = [bitsPerSample];
  exifTags.t50719 = [stripOffsets[1], stripOffsets[0] * widthScaleFactor];
  exifTags.t50720 = [stripOffsets[3], stripOffsets[2] * widthScaleFactor];
  exifTags.width = imageWidth;
  exifTags.height = imageHeight;
  exifTags.data = new Uint8Array(rawStripBytes.buffer);
  return [exifTags];
};

rafCodec.decodeFujiRafStrip = unpackFujiRafStrip;

export const rawCodec = {};
rawCodec.noPreviewAvailable = true;

rawCodec.encode = function (layerFrames, width, height, encodeOptions) {
  var sourcePixels = new Uint8Array(layerFrames[0][0]);
  var pixelCount = width * height;
  var channelCount = [1, 3, 4][encodeOptions[0]];
  var bitDepth = 8 + 8 * encodeOptions[1];
  var byteOrder = encodeOptions[2];

  if (channelCount == 1) {
    var grayPixels = new Uint8Array(width * height);
    extractChannelByte(sourcePixels, grayPixels, 0);
    sourcePixels = grayPixels;
  }

  if (channelCount == 3) {
    var rgbPixels = new Uint8Array(width * height * 3);
    for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
      var srcOffset = pixelIdx * 4;
      var destOffset = pixelIdx * 3;
      rgbPixels[destOffset] = sourcePixels[srcOffset];
      rgbPixels[destOffset + 1] = sourcePixels[srcOffset + 1];
      rgbPixels[destOffset + 2] = sourcePixels[srcOffset + 2];
    }
    sourcePixels = rgbPixels;
  }

  if (bitDepth == 16) {
    var sourceLength = sourcePixels.length;
    var widePixels = new Uint8Array(sourceLength * 2);
    for (var pixelIdx = 0; pixelIdx < sourceLength; pixelIdx++) {
      var sampleValue = Math.round(sourcePixels[pixelIdx] * (65535 / 255));
      widePixels[pixelIdx * 2 + byteOrder] = sampleValue >>> 8;
      widePixels[pixelIdx * 2 + 1 - byteOrder] = sampleValue & 255;
    }
    sourcePixels = widePixels;
  }

  return sourcePixels.buffer;
};
