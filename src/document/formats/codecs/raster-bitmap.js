/**
 * Uncompressed bitmap codecs: BMP, TGA, PPM, ILBM (Amiga IFF).
 * Wired in `file-format-registry.js`.
 */

import { Rect } from "../../../core/math/rect.js";
import { BinaryUtils } from "../../../core/binary/binary-utils.js";
import { RenderBuffer } from "../../../core/render-buffer.js";
import { IFFParser } from "../metadata/chunk-container-parser.js";
import { codecLoaders } from "../registry/registry-helpers.js";
import { allocBuffer, extractChannelByte, fillBuffer } from "../../../engine/compositing/buffer-utils.js";
import { hasNonOpaquePixels } from "../../../engine/compositing/pixel-ops.js";

/* global alert */

// ---------------------------------------------------------------------------
// BMP (Windows DIB)
// ---------------------------------------------------------------------------

/** @param {Uint8Array} buffer @param {number} offset */
function readBmpInfoHeader(buffer, offset) {
  var header = {};
  header.width = BinaryUtils.readInt32LE(buffer, offset);
  offset += 4;
  header.height = BinaryUtils.readInt32LE(buffer, offset);
  offset += 4;
  header.colorPlanes = BinaryUtils.readUint16LE(buffer, offset);
  offset += 2;
  header.bitDepth = BinaryUtils.readUint16LE(buffer, offset);
  offset += 2;
  header.compression = BinaryUtils.readFloat32(buffer, offset);
  offset += 4;
  header.size = BinaryUtils.readFloat32(buffer, offset);
  offset += 4;
  BinaryUtils.readInt32LE(buffer, offset);
  offset += 4;
  BinaryUtils.readInt32LE(buffer, offset);
  offset += 4;
  header.paletteColorCount = BinaryUtils.readFloat32(buffer, offset);
  offset += 4;
  offset += 4;
  return header;
}

/** @param {Uint8Array} buffer @param {number} offset @param {object} header @param {number} rowStrideBytes */
function writeBmpInfoHeader(buffer, offset, header, rowStrideBytes) {
  BinaryUtils.writeFloat32Raw(buffer, offset, header.width);
  offset += 4;
  BinaryUtils.writeFloat32Raw(buffer, offset, header.height);
  offset += 4;
  BinaryUtils.writeUint16LEraw(buffer, offset, header.colorPlanes);
  offset += 2;
  BinaryUtils.writeUint16LEraw(buffer, offset, header.bitDepth);
  offset += 2;
  BinaryUtils.writeFloat32Raw(buffer, offset, header.compression);
  offset += 4;
  BinaryUtils.writeFloat32Raw(buffer, offset, header.size);
  offset += 4;
  BinaryUtils.writeFloat32Raw(buffer, offset, 2834);
  offset += 4;
  BinaryUtils.writeFloat32Raw(buffer, offset, 2834);
  offset += 4;
  BinaryUtils.writeFloat32Raw(buffer, offset, header.paletteColorCount);
  offset += 4;
  offset += 4;
}

function readNibbleFromPackedByte(packedByte, nibbleIndex) {
  return packedByte >>> 4 - ((nibbleIndex & 1) << 2) & 15;
}

function decompressBmpRle(buffer, offset, infoHeader) {
  var width = infoHeader.width;
  var height = Math.abs(infoHeader.height);
  var decompressed = new Uint8Array(width * height);
  var col = 0;
  var row = 0;
  var runIndex = 0;
  while (row < height) {
    var controlByte = buffer[offset++];
    var dataByte = buffer[offset++];
    var destOffset = row * width + col;
    if (controlByte > 0) {
      if (infoHeader.bitDepth === 4) {
        for (runIndex = 0; runIndex < controlByte; runIndex++) {
          decompressed[destOffset + runIndex] = readNibbleFromPackedByte(dataByte, runIndex);
        }
      } else {
        for (runIndex = 0; runIndex < controlByte; runIndex++) {
          decompressed[destOffset + runIndex] = dataByte;
        }
      }
      col += controlByte;
    } else if (controlByte === 0 && dataByte === 0) {
      row++;
      col = 0;
    } else if (controlByte === 0 && dataByte === 1) {
      break;
    } else if (controlByte === 0 && dataByte === 2) {
      col += buffer[offset++];
      row += buffer[offset++];
    } else {
      var absoluteRunBytes = dataByte;
      if (infoHeader.bitDepth === 4) {
        for (runIndex = 0; runIndex < dataByte; runIndex++) {
          decompressed[destOffset + runIndex] = readNibbleFromPackedByte(buffer[offset + (runIndex >>> 1)], runIndex);
        }
        absoluteRunBytes = Math.ceil(dataByte / 2);
      } else {
        for (runIndex = 0; runIndex < dataByte; runIndex++) {
          decompressed[destOffset + runIndex] = buffer[offset + runIndex];
        }
      }
      if ((absoluteRunBytes & 1) !== 0) absoluteRunBytes++;
      offset += absoluteRunBytes;
      col += dataByte;
    }
  }
  return decompressed;
}

function decodeBmpToLayerFrame(buffer, offset, pixelDataOffset) {
  buffer = new Uint8Array(buffer);
  var dibHeaderSize = BinaryUtils.readFloat32(buffer, offset);
  var infoHeader = readBmpInfoHeader(buffer, offset + 4);
  if (infoHeader.colorPlanes !== 1) alert("unsupported number of color planes: " + infoHeader.colorPlanes);
  if (infoHeader.compression !== 0 && infoHeader.compression !== 1 && infoHeader.compression !== 2 && infoHeader.compression !== 3) {
    alert("Unsupported BMP compression: " + infoHeader.compression);
    return;
  }
  offset += dibHeaderSize;
  var paletteOffset = offset;
  var sourceBuffer = buffer;
  if (pixelDataOffset == null) pixelDataOffset = offset;
  if (infoHeader.compression === 1 || infoHeader.compression === 2) {
    var decompressedPixels = decompressBmpRle(buffer, pixelDataOffset, infoHeader);
    infoHeader.bitDepth = 8;
    buffer = decompressedPixels;
    pixelDataOffset = 0;
  }
  var rowStrideBytes = 4 * Math.floor((infoHeader.bitDepth * infoHeader.width + 31) / 32);
  var width = infoHeader.width;
  var height = Math.abs(infoHeader.height);
  var rgbaBuffer = new Uint8Array(width * height * 4);
  rgbaBuffer.fill(255);
  if (infoHeader.bitDepth === 32) {
    for (var rowIndex = 0; rowIndex < height; rowIndex++) {
      var rowOffset = pixelDataOffset + (height - 1 - rowIndex) * rowStrideBytes;
      for (var colIndex = 0; colIndex < width; colIndex++) {
        var rgbaOffset = (rowIndex * width + colIndex) * 4;
        rgbaBuffer[rgbaOffset] = buffer[rowOffset + colIndex * 4 + 2];
        rgbaBuffer[rgbaOffset + 1] = buffer[rowOffset + colIndex * 4 + 1];
        rgbaBuffer[rgbaOffset + 2] = buffer[rowOffset + colIndex * 4 + 0];
        rgbaBuffer[rgbaOffset + 3] = buffer[rowOffset + colIndex * 4 + 3];
      }
    }
  } else if (infoHeader.bitDepth === 24) {
    for (var rowIndex = 0; rowIndex < height; rowIndex++) {
      var rowOffset = pixelDataOffset + (height - 1 - rowIndex) * rowStrideBytes;
      for (var colIndex = 0; colIndex < width; colIndex++) {
        var rgbaOffset = (rowIndex * width + colIndex) * 4;
        rgbaBuffer[rgbaOffset] = buffer[rowOffset + colIndex * 3 + 2];
        rgbaBuffer[rgbaOffset + 1] = buffer[rowOffset + colIndex * 3 + 1];
        rgbaBuffer[rgbaOffset + 2] = buffer[rowOffset + colIndex * 3 + 0];
      }
    }
  } else if (infoHeader.bitDepth === 16) {
    for (var rowIndex = 0; rowIndex < height; rowIndex++) {
      var rowOffset = pixelDataOffset + (height - 1 - rowIndex) * rowStrideBytes;
      for (var colIndex = 0; colIndex < width; colIndex++) {
        var rgbaOffset = (rowIndex * width + colIndex) * 4;
        var rgb565Value = buffer[rowOffset + colIndex * 2 + 1] << 8 | buffer[rowOffset + colIndex * 2];
        rgbaBuffer[rgbaOffset] = (rgb565Value >>> 11) * (255 / 31);
        rgbaBuffer[rgbaOffset + 1] = (rgb565Value >>> 5 & 63) * (255 / 63);
        rgbaBuffer[rgbaOffset + 2] = (rgb565Value & 31) * (255 / 31);
      }
    }
  } else if (infoHeader.bitDepth === 8) {
    for (var rowIndex = 0; rowIndex < height; rowIndex++) {
      var rowOffset = pixelDataOffset + (height - 1 - rowIndex) * rowStrideBytes;
      for (var colIndex = 0; colIndex < width; colIndex++) {
        var rgbaOffset = (rowIndex * width + colIndex) * 4;
        var paletteIndex = buffer[rowOffset + colIndex];
        rgbaBuffer[rgbaOffset] = sourceBuffer[paletteOffset + 4 * paletteIndex + 2];
        rgbaBuffer[rgbaOffset + 1] = sourceBuffer[paletteOffset + 4 * paletteIndex + 1];
        rgbaBuffer[rgbaOffset + 2] = sourceBuffer[paletteOffset + 4 * paletteIndex + 0];
      }
    }
  } else if (infoHeader.bitDepth === 4) {
    for (var rowIndex = 0; rowIndex < height; rowIndex++) {
      var rowOffset = pixelDataOffset + (height - 1 - rowIndex) * rowStrideBytes;
      for (var colIndex = 0; colIndex < width; colIndex++) {
        var rgbaOffset = (rowIndex * width + colIndex) * 4;
        var packedByte = buffer[rowOffset + (colIndex >> 1)];
        packedByte = packedByte >> 4 - 4 * (colIndex & 1);
        packedByte = packedByte & 15;
        rgbaBuffer[rgbaOffset] = sourceBuffer[paletteOffset + 4 * packedByte + 2];
        rgbaBuffer[rgbaOffset + 1] = sourceBuffer[paletteOffset + 4 * packedByte + 1];
        rgbaBuffer[rgbaOffset + 2] = sourceBuffer[paletteOffset + 4 * packedByte + 0];
      }
    }
  } else if (infoHeader.bitDepth === 1) {
    for (var rowIndex = 0; rowIndex < height; rowIndex++) {
      var rowOffset = pixelDataOffset + (height - 1 - rowIndex) * rowStrideBytes;
      for (var colIndex = 0; colIndex < width; colIndex++) {
        var rgbaOffset = (rowIndex * width + colIndex) * 4;
        var bitByte = buffer[rowOffset + (colIndex >> 3)];
        bitByte = bitByte >> 7 - (colIndex & 7);
        bitByte = bitByte & 1;
        rgbaBuffer[rgbaOffset] = sourceBuffer[paletteOffset + 4 * bitByte + 2];
        rgbaBuffer[rgbaOffset + 1] = sourceBuffer[paletteOffset + 4 * bitByte + 1];
        rgbaBuffer[rgbaOffset + 2] = sourceBuffer[paletteOffset + 4 * bitByte + 0];
      }
    }
  } else throw "Unknown bit depth " + infoHeader.bitDepth;
  if (infoHeader.height < 0) {
    var rgbaPixels = new Uint32Array(rgbaBuffer.buffer);
    var halfHeight = height >>> 1;
    for (var rowIndex = 0; rowIndex < halfHeight; rowIndex++) {
      var topRowStart = rowIndex * width;
      var bottomRowStart = (height - rowIndex - 1) * width;
      for (var colIndex = 0; colIndex < width; colIndex++) {
        var swapPixel = rgbaPixels[topRowStart + colIndex];
        rgbaPixels[topRowStart + colIndex] = rgbaPixels[bottomRowStart + colIndex];
        rgbaPixels[bottomRowStart + colIndex] = swapPixel;
      }
    }
  }
  return {
    rect: new Rect(0, 0, width, height),
    data: rgbaBuffer.buffer,
  };
}

function decodeBmpFromBuffer(buffer) {
  buffer = new Uint8Array(buffer);
  if (BinaryUtils.readFloat32(buffer, 0) === 40) return [decodeBmpToLayerFrame(buffer.buffer, 0)];
  var offset = 0;
  var signature = BinaryUtils.readString(buffer, offset, 2);
  offset += 2;
  if (signature !== "BM") {
    alert("Unsupported BMP format: " + signature);
    return;
  }
  BinaryUtils.readFloat32(buffer, offset);
  offset += 4;
  offset += 4;
  var pixelDataOffset = BinaryUtils.readFloat32(buffer, offset);
  offset += 4;
  return [decodeBmpToLayerFrame(buffer.buffer, offset, pixelDataOffset)];
}

function encodeBmpFromFrames(frames, width, height, unusedParam) {
  var rgbaBytes = new Uint8Array(frames[0][0]);
  var rgbaPixels = new Uint32Array(rgbaBytes.buffer);
  var paletteEntries = [];
  var colorToPaletteIndex = {};
  var bitDepth = 24;
  for (var colorIdx = 0; colorIdx < rgbaPixels.length; colorIdx++) {
    var rgbColor = rgbaPixels[colorIdx] & 16777215;
    if (colorToPaletteIndex[rgbColor] == null) {
      colorToPaletteIndex[rgbColor] = paletteEntries.length;
      paletteEntries.push(rgbColor);
      if (paletteEntries.length > 256) {
        paletteEntries = null;
        break;
      }
    }
  }
  if (paletteEntries) {
    bitDepth = 1;
    while (1 << bitDepth < paletteEntries.length) bitDepth *= 2;
    if (bitDepth === 2) bitDepth = 4;
  }
  var infoHeader = {
    width: width,
    height: height,
    colorPlanes: 1,
    bitDepth: bitDepth,
    compression: 0,
    size: 0,
  };
  var rowStrideBytes = 4 * Math.floor((infoHeader.bitDepth * infoHeader.width + 31) / 32);
  infoHeader.size = rowStrideBytes * infoHeader.height + 2;
  var outputBuffer = new RenderBuffer();
  var writeOffset = 0;
  var paletteByteSize = paletteEntries ? (1 << bitDepth) * 4 : 0;
  BinaryUtils.writeAscii(outputBuffer, writeOffset, "BM");
  writeOffset += 2;
  BinaryUtils.writeFloat32(outputBuffer, writeOffset, rowStrideBytes * height + 16 + 40 + paletteByteSize);
  writeOffset += 4;
  BinaryUtils.writeFloat32(outputBuffer, writeOffset, 0);
  writeOffset += 4;
  BinaryUtils.writeFloat32(outputBuffer, writeOffset, 54 + paletteByteSize);
  writeOffset += 4;
  outputBuffer.ensureCapacity(writeOffset, 40);
  BinaryUtils.writeFloat32(outputBuffer, writeOffset, 40);
  writeOffset += 4;
  writeBmpInfoHeader(outputBuffer.data, writeOffset, infoHeader, rowStrideBytes);
  writeOffset += 36;
  if (paletteEntries) {
    outputBuffer.ensureCapacity(writeOffset, paletteByteSize);
    var outputBytes = outputBuffer.data;
    for (var paletteIdx = 0; paletteIdx < paletteEntries.length; paletteIdx++) {
      var paletteEntryOffset = writeOffset + paletteIdx * 4;
      outputBytes[paletteEntryOffset] = paletteEntries[paletteIdx] >>> 16;
      outputBytes[paletteEntryOffset + 1] = paletteEntries[paletteIdx] >>> 8 & 255;
      outputBytes[paletteEntryOffset + 2] = paletteEntries[paletteIdx] & 255;
    }
    writeOffset += paletteByteSize;
  }
  outputBuffer.ensureCapacity(writeOffset, rowStrideBytes * height);
  if (bitDepth === 24) {
    for (var row = 0; row < height; row++) {
      var rowWriteOffset = writeOffset + (height - 1 - row) * rowStrideBytes;
      for (var col = 0; col < width; col++) {
        var rgbaOffset = (row * width + col) * 4;
        outputBuffer.data[rowWriteOffset + col * 3 + 2] = rgbaBytes[rgbaOffset];
        outputBuffer.data[rowWriteOffset + col * 3 + 1] = rgbaBytes[rgbaOffset + 1];
        outputBuffer.data[rowWriteOffset + col * 3 + 0] = rgbaBytes[rgbaOffset + 2];
      }
    }
  } else if (bitDepth === 8) {
    for (var row = 0; row < height; row++) {
      var rowWriteOffset = writeOffset + (height - 1 - row) * rowStrideBytes;
      for (var col = 0; col < width; col++) {
        var pixelIndex = row * width + col;
        var paletteIndex = colorToPaletteIndex[rgbaPixels[pixelIndex] & 16777215];
        outputBuffer.data[rowWriteOffset + col] |= paletteIndex;
      }
    }
  } else if (bitDepth === 4) {
    for (var row = 0; row < height; row++) {
      var rowWriteOffset = writeOffset + (height - 1 - row) * rowStrideBytes;
      for (var col = 0; col < width; col++) {
        var pixelIndex = row * width + col;
        var paletteIndex = colorToPaletteIndex[rgbaPixels[pixelIndex] & 16777215];
        outputBuffer.data[rowWriteOffset + (col >>> 1)] |= paletteIndex << 4 - (col & 1) * 4;
      }
    }
  } else if (bitDepth === 1) {
    for (var row = 0; row < height; row++) {
      var rowWriteOffset = writeOffset + (height - 1 - row) * rowStrideBytes;
      for (var col = 0; col < width; col++) {
        var pixelIndex = row * width + col;
        var paletteIndex = colorToPaletteIndex[rgbaPixels[pixelIndex] & 16777215];
        outputBuffer.data[rowWriteOffset + (col >>> 3)] |= paletteIndex << 7 - (col & 7);
      }
    }
  }
  writeOffset += rowStrideBytes * height + 2;
  return outputBuffer.data.slice(0, writeOffset).buffer;
}

export const bmpCodec = {
  decodeFromBuffer: decodeBmpFromBuffer,
  encodeFromFrames: encodeBmpFromFrames,
  decodeToLayerFrame: decodeBmpToLayerFrame,
};

// ---------------------------------------------------------------------------
// TGA (Targa)
// ---------------------------------------------------------------------------

function decodeTgaPixelBytes(buffer, offset, bitsPerPixel, outRgba) {
  var red;
  var green;
  var blue;
  var alpha = 255;
  if (bitsPerPixel === 24 || bitsPerPixel === 32) {
    blue = buffer[offset];
    green = buffer[offset + 1];
    red = buffer[offset + 2];
    if (bitsPerPixel === 32) alpha = buffer[offset + 3];
  } else if (bitsPerPixel === 16) {
    var rgb555 = buffer[offset + 1] << 8 | buffer[offset + 0];
    red = rgb555 >>> 10 & 31;
    green = rgb555 >>> 5 & 31;
    blue = rgb555 >>> 0 & 31;
    red = Math.round(red * (255 / 31));
    green = Math.round(green * (255 / 31));
    blue = Math.round(blue * (255 / 31));
  } else throw "bmp: unsupported RGB bit depth";
  outRgba[0] = red;
  outRgba[1] = green;
  outRgba[2] = blue;
  outRgba[3] = alpha;
}

export const tgaCodec = {};
tgaCodec.isLayered = false;
tgaCodec.decodeTgaPixels = decodeTgaPixelBytes;
tgaCodec.encode = function (frames, width, height, options) {
  var alphaPlane = frames[0][4];
  var rgbaBytes = new Uint8Array(frames[0][0]);
  var imageType = 2;
  var hasAlpha = alphaPlane ? true : false;
  var bytesPerPixel = hasAlpha ? 4 : 3;
  var pixelData = new Uint8Array(width * height * bytesPerPixel);
  for (var row = 0; row < height; row++) {
    for (var col = 0; col < width; col++) {
      var rgbaOffset = row * width + col << 2;
      var destOffset = ((height - row - 1) * width + col) * bytesPerPixel;
      pixelData[destOffset] = rgbaBytes[rgbaOffset + 2];
      pixelData[destOffset + 1] = rgbaBytes[rgbaOffset + 1];
      pixelData[destOffset + 2] = rgbaBytes[rgbaOffset + 0];
      if (hasAlpha) pixelData[destOffset + 3] = alphaPlane[0][row * width + col];
    }
  }
  if (true) {
    var uncompressedLength = pixelData.length;
    var compressedBuffer = new Uint8Array(uncompressedLength * 2);
    var writeOffset = 0;
    var readOffset = 0;
    var rowByteWidth = width * bytesPerPixel;
    while (readOffset < uncompressedLength) {
      var matchStart = readOffset;
      var matchLength = 0;
      var rowEnd = rowByteWidth * (Math.floor(readOffset / rowByteWidth) + 1);
      while (matchStart < rowEnd && matchLength < 128) {
        var pixelsMatch = true;
        for (var channel = 0; channel < bytesPerPixel; channel++) {
          pixelsMatch = pixelsMatch & pixelData[readOffset + channel] === pixelData[matchStart + channel];
        }
        if (!pixelsMatch) break;
        matchStart += bytesPerPixel;
        matchLength++;
      }
      if (matchLength === 1) {
        var rawRunLength = 1;
        while (rawRunLength < 128 && readOffset + (rawRunLength + 1) * bytesPerPixel < rowEnd) {
          var rawPixelsMatch = true;
          var rawRunOffset = readOffset + rawRunLength * bytesPerPixel;
          for (var channel = 0; channel < bytesPerPixel; channel++) {
            rawPixelsMatch = rawPixelsMatch & pixelData[rawRunOffset + channel] === pixelData[rawRunOffset + bytesPerPixel + channel];
          }
          if (rawPixelsMatch) break;
          rawRunLength++;
        }
        compressedBuffer[writeOffset++] = rawRunLength - 1;
        for (var rawIdx = 0; rawIdx < rawRunLength; rawIdx++) {
          for (var channel = 0; channel < bytesPerPixel; channel++) {
            compressedBuffer[writeOffset++] = pixelData[readOffset++];
          }
        }
      } else {
        compressedBuffer[writeOffset++] = 127 + matchLength;
        for (var channel = 0; channel < bytesPerPixel; channel++) {
          compressedBuffer[writeOffset + channel] = pixelData[readOffset + channel];
        }
        writeOffset += bytesPerPixel;
        readOffset += bytesPerPixel * matchLength;
      }
    }
    pixelData = compressedBuffer.slice(0, writeOffset);
    imageType += 8;
  }
  var outputBuffer = new Uint8Array(18 + pixelData.length + 26);
  outputBuffer[2] = imageType;
  BinaryUtils.writeUint16LEraw(outputBuffer, 12, width);
  BinaryUtils.writeUint16LEraw(outputBuffer, 14, height);
  outputBuffer[16] = bytesPerPixel * 8;
  outputBuffer[17] = bytesPerPixel === 4 ? 8 : 0;
  outputBuffer.set(pixelData, 18);
  BinaryUtils.writeAsciiRaw(outputBuffer, 18 + pixelData.length + 8, "TRUEVISION-XFILE.");
  return outputBuffer.buffer;
};
tgaCodec.decode = function (buffer) {
  var bytes = new Uint8Array(buffer);
  var idLength = bytes[0];
  var colorMapLength = bytes[6] * 256 + bytes[5];
  var colorMapEntrySize = bytes[7];
  var width = bytes[13] * 256 + bytes[12];
  var height = bytes[15] * 256 + bytes[14];
  var bitsPerPixel = bytes[16];
  var imageDescriptor = bytes[17];
  var descriptorFlags = imageDescriptor >>> 4;
  var imageType = bytes[2];
  var layerName = BinaryUtils.readString(bytes, 18, idLength);
  var rgbaBuffer = allocBuffer(width * height * 4);
  var offset = 18 + idLength + (colorMapLength * colorMapEntrySize >>> 3);
  var pixelBytes = new Uint8Array(bytes.buffer, offset);
  if (imageType > 3) {
    var sourceBytes = bytes;
    var decompressedPixels = new Uint8Array(width * height * bitsPerPixel >>> 3);
    var readOffset = offset;
    var writeOffset = 0;
    var bytesPerPixelPacked = bitsPerPixel >>> 3;
    while (writeOffset < decompressedPixels.length) {
      var packetHeader = sourceBytes[readOffset];
      readOffset++;
      if (packetHeader < 128) {
        for (var repeatIdx = 0; repeatIdx < packetHeader + 1; repeatIdx++) {
          for (var channel = 0; channel < bytesPerPixelPacked; channel++) {
            decompressedPixels[writeOffset] = sourceBytes[readOffset];
            writeOffset++;
            readOffset++;
          }
        }
      } else {
        for (var repeatIdx = 0; repeatIdx < packetHeader - 127; repeatIdx++) {
          for (var channel = 0; channel < bytesPerPixelPacked; channel++) {
            decompressedPixels[writeOffset] = sourceBytes[readOffset + channel];
            writeOffset++;
          }
        }
        readOffset += bytesPerPixelPacked;
      }
    }
    imageType -= 8;
    pixelBytes = decompressedPixels;
    offset = readOffset;
  } else {
    offset += width * height * bitsPerPixel >>> 3;
  }
  var scratchRgba = new Uint8Array(4);
  for (var row = 0; row < height; row++) {
    for (var col = 0; col < width; col++) {
      var sourcePixelIndex = (descriptorFlags & 2) === 0 ? (height - row - 1) * width + col : row * width + col;
      var destPixelIndex = row * width + col;
      var red;
      var green;
      var blue;
      var alpha = 255;
      var pixelByteOffset = sourcePixelIndex * bitsPerPixel >>> 3;
      if (imageType === 1) {
        var paletteIndex = 0;
        if (bitsPerPixel === 8) paletteIndex = pixelBytes[pixelByteOffset];
        else throw "bmp: palette decode requires 8 bpp";
        decodeTgaPixelBytes(bytes, 18 + idLength + bytes[4] * 256 + bytes[3] + (paletteIndex * bitsPerPixel >>> 3), bitsPerPixel, scratchRgba);
        red = scratchRgba[0];
        green = scratchRgba[1];
        blue = scratchRgba[2];
        alpha = scratchRgba[3];
      } else if (imageType === 2) {
        decodeTgaPixelBytes(pixelBytes, pixelByteOffset, bitsPerPixel, scratchRgba);
        red = scratchRgba[0];
        green = scratchRgba[1];
        blue = scratchRgba[2];
        alpha = scratchRgba[3];
      } else if (imageType === 3) {
        if (bitsPerPixel === 8) red = green = blue = pixelBytes[pixelByteOffset];
        else throw "bmp: palette decode requires 8 bpp";
      }
      var rgbaOffset = destPixelIndex * 4;
      rgbaBuffer[rgbaOffset] = red;
      rgbaBuffer[rgbaOffset + 1] = green;
      rgbaBuffer[rgbaOffset + 2] = blue;
      rgbaBuffer[rgbaOffset + 3] = alpha;
    }
  }
  var layerFrame = {
    rect: new Rect(0, 0, width, height),
    data: rgbaBuffer.buffer,
    layerName: layerName,
  };
  if (hasNonOpaquePixels(rgbaBuffer)) {
    var alphaChannel = allocBuffer(width * height);
    extractChannelByte(rgbaBuffer, alphaChannel, 3);
    fillBuffer(rgbaBuffer, 4278190080, 16777215);
    layerFrame.extraChannels = [alphaChannel];
  }
  return [layerFrame];
};

// ---------------------------------------------------------------------------
// PPM (Netpbm)
// ---------------------------------------------------------------------------

const PPM_WHITESPACE = [" ".charCodeAt(0), "\n".charCodeAt(0), "\t".charCodeAt(0), "\r".charCodeAt(0)];

export const ppmCodec = {};
ppmCodec.encode = function (frames, width, height, options) {
  var rgbaBytes = new Uint8Array(frames[0][0]);
  var pixelCount = width * height;
  var rgbByteCount = pixelCount * 3;
  var headerText = "P6\n" + width + " " + height + "\n255\n";
  var headerLength = headerText.length;
  var outputBuffer = allocBuffer(headerLength + rgbByteCount, true);
  for (var headerIdx = 0; headerIdx < headerLength; headerIdx++) {
    outputBuffer[headerIdx] = headerText.charCodeAt(headerIdx);
  }
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    var rgbaOffset = pixelIdx * 4;
    var rgbOffset = pixelIdx * 3 + headerLength;
    outputBuffer[rgbOffset] = rgbaBytes[rgbaOffset];
    outputBuffer[rgbOffset + 1] = rgbaBytes[rgbaOffset + 1];
    outputBuffer[rgbOffset + 2] = rgbaBytes[rgbaOffset + 2];
  }
  return outputBuffer.buffer;
};
ppmCodec.decode = function (buffer) {
  buffer = new Uint8Array(buffer);
  var offset = 0;
  var magic = String.fromCharCode(buffer[0]) + String.fromCharCode(buffer[1]);
  var headerTokens = [];
  var tokenState = 0;
  var headerFieldCount = magic === "P1" || magic === "P4" ? 2 : 3;
  for (offset = 2; offset < buffer.length; offset++) {
    var byte = buffer[offset];
    var char = String.fromCharCode(byte);
    if (byte === "#".charCodeAt(0)) {
      while (buffer[offset] !== "\n".charCodeAt(0)) offset++;
      continue;
    }
    var isWhitespace = PPM_WHITESPACE.indexOf(byte) !== -1;
    if (tokenState === 0 && !isWhitespace) {
      headerTokens.push(char);
      tokenState = 1;
      continue;
    }
    if (tokenState === 1 && !isWhitespace) {
      headerTokens[headerTokens.length - 1] += char;
      continue;
    }
    if (tokenState === 1 && isWhitespace) {
      tokenState = 0;
      if (headerTokens.length === headerFieldCount) break;
    }
  }
  var width = parseInt(headerTokens[0]);
  var height = parseInt(headerTokens[1]);
  var rgbaByteCount = width * height * 4;
  var maxSampleValue = magic === "P1" || magic === "P4" ? 1 : 255 / parseInt(headerTokens[2]);
  var rgbaBuffer = allocBuffer(rgbaByteCount);
  if (magic === "P1" || magic === "P2" || magic === "P3") {
    var asciiToken = "";
    var rgbaOffset = 0;
    tokenState = 0;
    var commentMarker = "#".charCodeAt(0);
    for (var dataIdx = offset; dataIdx < buffer.length; dataIdx++) {
      var dataByte = buffer[dataIdx];
      var dataChar = String.fromCharCode(dataByte);
      var isWhitespace = PPM_WHITESPACE.indexOf(dataByte) !== -1;
      if (dataByte === commentMarker) {
        while (buffer[dataIdx] !== "\n".charCodeAt(0)) dataIdx++;
      } else if (tokenState === 0 && !isWhitespace) {
        asciiToken = dataChar;
        tokenState = 1;
      } else if (tokenState === 1) {
        if (isWhitespace) {
          tokenState = 0;
          var sampleValue = parseInt(asciiToken);
          asciiToken = "";
          if (magic === "P1") {
            rgbaBuffer[rgbaOffset] = rgbaBuffer[rgbaOffset + 1] = rgbaBuffer[rgbaOffset + 2] = (1 - sampleValue) * 255;
            rgbaBuffer[rgbaOffset + 3] = 255;
            rgbaOffset += 4;
          }
          if (magic === "P2") {
            rgbaBuffer[rgbaOffset] = rgbaBuffer[rgbaOffset + 1] = rgbaBuffer[rgbaOffset + 2] = Math.round(sampleValue * maxSampleValue);
            rgbaBuffer[rgbaOffset + 3] = 255;
            rgbaOffset += 4;
          }
          if (magic === "P3") {
            rgbaBuffer[rgbaOffset] = Math.round(sampleValue * maxSampleValue);
            rgbaOffset++;
            if ((rgbaOffset & 3) === 3) {
              rgbaBuffer[rgbaOffset] = 255;
              rgbaOffset++;
            }
          }
        } else asciiToken += dataChar;
      }
    }
  }
  var pixelCount = width * height;
  if (magic === "P4") {
    for (var row = 0; row < height; row++) {
      var rowBitOffset = row * 8 * Math.ceil(width / 8);
      for (var col = 0; col < width; col++) {
        var bitIndex = rowBitOffset + col;
        var packedByte = buffer[offset + 1 + (bitIndex >> 3)];
        packedByte = packedByte >> 7 - (bitIndex & 7) & 1;
        var rgbaOffset = row * width + col << 2;
        rgbaBuffer[rgbaOffset] = rgbaBuffer[rgbaOffset + 1] = rgbaBuffer[rgbaOffset + 2] = (1 - packedByte) * 255;
        rgbaBuffer[rgbaOffset + 3] = 255;
      }
    }
  }
  if (magic === "P5") {
    for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
      var rgbaOffset = 4 * pixelIdx;
      rgbaBuffer[rgbaOffset] = rgbaBuffer[rgbaOffset + 1] = rgbaBuffer[rgbaOffset + 2] = Math.round(buffer[offset + 1 + pixelIdx] * maxSampleValue);
      rgbaBuffer[rgbaOffset + 3] = 255;
    }
  }
  if (magic === "P6") {
    for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
      var rgbaOffset = 4 * pixelIdx;
      var rgbOffset = offset + 1 + 3 * pixelIdx;
      rgbaBuffer[rgbaOffset] = Math.round(buffer[rgbOffset] * maxSampleValue);
      rgbaBuffer[rgbaOffset + 1] = Math.round(buffer[rgbOffset + 1] * maxSampleValue);
      rgbaBuffer[rgbaOffset + 2] = Math.round(buffer[rgbOffset + 2] * maxSampleValue);
      rgbaBuffer[rgbaOffset + 3] = 255;
    }
  }
  return [{
    rect: new Rect(0, 0, width, height),
    data: rgbaBuffer.buffer,
  }];
};

// ---------------------------------------------------------------------------
// ILBM (Amiga IFF interleaved bitmap)
// ---------------------------------------------------------------------------

export const ilbmCodec = {};
ilbmCodec.decode = function (buffer, options) {
  var iffTree = IFFParser.parse(buffer);
  var bytes = new Uint8Array(buffer);
  var rgbaBuffer;
  var width;
  var height;
  var numBitplanes;
  var masking;
  var cmapOffset = 0;
  var camgHasHam = 0;
  for (var chunkIdx = 0; chunkIdx < iffTree.sub.length; chunkIdx++) {
    var chunk = iffTree.sub[chunkIdx];
    var chunkOffset = chunk.dataOffset;
    if (chunk.tag === "BMHD") {
      var bmhdWords = [];
      for (var wordIdx = 0; wordIdx < 4; wordIdx++) {
        bmhdWords[wordIdx] = BinaryUtils.readUint16(bytes, chunkOffset + 2 * wordIdx);
      }
      chunkOffset += 8;
      width = bmhdWords[0];
      height = bmhdWords[1];
      rgbaBuffer = allocBuffer(width * height * 4);
      numBitplanes = bytes[chunkOffset++];
      masking = bytes[chunkOffset++];
      // Compression byte: the reader steps past it.
      chunkOffset++;
    } else if (chunk.tag === "CMAP") {
      cmapOffset = chunkOffset;
    } else if (chunk.tag === "CAMG") {
      var camgFlags = BinaryUtils.readUint32BE(bytes, chunkOffset);
      camgHasHam = camgFlags & 2048;
    } else if (chunk.tag === "BODY") {
      var rowByteWidth = width + 15 >>> 4 << 1;
      var planeCount = numBitplanes + masking;
      var packedBody = allocBuffer(rowByteWidth * height * planeCount);
      var hamBlue;
      var hamRed;
      var hamGreen;
      codecLoaders.ChannelImageCodec.packBitsDecodeRow(bytes, chunkOffset, chunk.size, packedBody, 0, packedBody.length);
      var hamBits = numBitplanes - 2;
      var hamMask = (1 << hamBits) - 1;
      var hamScale = Math.round(255 / hamMask);
      for (var row = 0; row < height; row++) {
        for (var col = 0; col < width; col++) {
          var pixelBits = 0;
          for (var planeIdx = 0; planeIdx < planeCount; planeIdx++) {
            var bitIndex = (row * planeCount + planeIdx) * rowByteWidth * 8 + col;
            var bitValue = packedBody[bitIndex >>> 3] >>> 7 - (bitIndex & 7) & 1;
            pixelBits |= bitValue << planeIdx;
          }
          var pixelIndex = row * width + col;
          var rgbaOffset = pixelIndex << 2;
          if (cmapOffset !== 0) {
            if (camgHasHam !== 0 && pixelBits >>> hamBits !== 0) {
              var hamOpcode = pixelBits >>> hamBits;
              var hamValue = (pixelBits & hamMask) * hamScale;
              if (hamOpcode === 1) hamBlue = hamValue;
              else if (hamOpcode === 2) hamRed = hamValue;
              else if (hamOpcode === 3) hamGreen = hamValue;
            } else {
              var cmapIndex = cmapOffset + pixelBits * 3;
              hamRed = bytes[cmapIndex + 0];
              hamGreen = bytes[cmapIndex + 1];
              hamBlue = bytes[cmapIndex + 2];
            }
          } else {
            hamRed = pixelBits >>> 0 & 255;
            hamGreen = pixelBits >>> 8 & 255;
            hamBlue = pixelBits >>> 16 & 255;
          }
          rgbaBuffer[rgbaOffset + 0] = hamRed;
          rgbaBuffer[rgbaOffset + 1] = hamGreen;
          rgbaBuffer[rgbaOffset + 2] = hamBlue;
          rgbaBuffer[rgbaOffset + 3] = 255;
        }
      }
    }
  }
  return [{
    rect: new Rect(0, 0, width, height),
    data: rgbaBuffer.buffer,
  }];
};
