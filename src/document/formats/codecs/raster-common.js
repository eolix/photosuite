/**
 * Common interchange raster codecs: PNG, GIF, ICO, TIFF.
 * Wired in `file-format-registry.js`.
 */

import { Rect } from "../../../core/math/rect.js";
import { BinaryUtils } from "../../../core/binary/binary-utils.js";
import { RenderBuffer } from "../../../core/render-buffer.js";
import { getFormat, detectFormat } from "../registry/registry-helpers.js";
import { XMPData } from "../metadata/xmp-metadata.js";
import { allocBuffer } from "../../../engine/compositing/buffer-utils.js";
import { copyPixels } from "../../../engine/compositing/pixel-ops.js";
import { BAYER_PATTERNS, decodeSigmaRaw, lookupCameraBySize } from "../../../engine/compositing/raw-functions.js";

/* global UPNG, GifWriter, GifReader, UTIF, alert */

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

function pngCompressionLevelFromQuality(qualityPercent) {
  var compressionLevel = qualityPercent === 100 ? 0 : Math.max(2, Math.floor(qualityPercent * 5));
  if (compressionLevel === 5) compressionLevel = 4;
  return compressionLevel;
}

function buildPngLayerFrames(decodedPng, rgbaFrames, dpi) {
  if (rgbaFrames.length === 1) {
    return [{
      rect: new Rect(0, 0, decodedPng.width, decodedPng.height),
      data: rgbaFrames[0],
      dpi: dpi,
    }];
  }
  var layerFrames = [];
  for (var frameIdx = 0; frameIdx < rgbaFrames.length; frameIdx++) {
    layerFrames.push({
      layerName: "_a_frm" + frameIdx + "," + decodedPng.frames[frameIdx].delay,
      rect: new Rect(0, 0, decodedPng.width, decodedPng.height),
      data: rgbaFrames[frameIdx],
      dpi: dpi,
    });
  }
  return layerFrames;
}

export const pngCodec = {};
pngCodec.encode = function (frames, width, height, encodeOptions) {
  if (encodeOptions == null) encodeOptions = [100, false, 0, 0, 0];
  var pngMetadata = { sRGB: 1, loop: encodeOptions[3] };
  if (frames[0][2] != null) {
    var dpiPhys = Math.round(frames[0][2] * (1e4 / 254));
    pngMetadata.pHYs = [dpiPhys, dpiPhys, 1];
  }
  var imageBuffers = [];
  var frameDelays = [];
  for (var frameIdx = 0; frameIdx < frames.length; frameIdx++) {
    imageBuffers.push(frames[frameIdx][0]);
    frameDelays.push(frames[frameIdx][1]);
  }
  return UPNG.encode(
    imageBuffers,
    width,
    height,
    pngCompressionLevelFromQuality(encodeOptions[0]),
    frameDelays,
    pngMetadata,
    encodeOptions[1],
  );
};
pngCodec.encodeRawBuffer = function (buffer, width, height) {
  return UPNG.encodeLL([buffer], width, height, 3, 1, 8);
};
pngCodec.decode = function (buffer) {
  var decodedPng = UPNG.decode(buffer);
  var rgbaFrames = UPNG.toRGBA8(decodedPng);
  var dpi = 0;
  if (decodedPng.tabs.pHYs) dpi = Math.round(decodedPng.tabs.pHYs[0] * 254 / 1e4);
  return buildPngLayerFrames(decodedPng, rgbaFrames, dpi);
};

// ---------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------

function binarizeGifFrameAlpha(frameCopy, pixelByteCount) {
  for (var byteIdx = 0; byteIdx < pixelByteCount; byteIdx += 4) {
    var alpha = frameCopy[byteIdx + 3] = frameCopy[byteIdx + 3] > 127 ? 255 : 0;
    if (alpha === 0) frameCopy[byteIdx] = frameCopy[byteIdx + 1] = frameCopy[byteIdx + 2] = 0;
  }
}

function swapGifPaletteRedBlue(palette) {
  var transparentPaletteIndex = null;
  var swapBytes = new Uint8Array(4);
  var swapU32 = new Uint32Array(swapBytes.buffer);
  for (var paletteIdx = 0; paletteIdx < palette.length; paletteIdx++) {
    swapU32[0] = palette[paletteIdx];
    var tempByte = swapBytes[0];
    swapBytes[0] = swapBytes[2];
    swapBytes[2] = tempByte;
    palette[paletteIdx] = swapU32[0];
    if (swapU32[0] === 0) transparentPaletteIndex = paletteIdx;
  }
  while (palette.length < 256) palette.push(0);
  return transparentPaletteIndex;
}

/**
 * omggif's GifReader decodes each frame's indexed pixels (LZW + interlace) and
 * blits them onto a buffer we own, skipping transparent indices. It does not
 * composite across frames, so we keep a running RGBA canvas and apply the GIF
 * disposal method between frames ourselves, emitting a full-canvas snapshot each.
 */
function decodeGifFramesWithDisposal(bytes) {
  var reader = new GifReader(new Uint8Array(bytes));
  var width = reader.width;
  var height = reader.height;
  var canvas = new Uint8Array(width * height * 4);
  var savedCanvas = null;
  var fullRect = new Rect(0, 0, width, height);
  var frames = [];
  for (var frameIdx = 0; frameIdx < reader.numFrames(); frameIdx++) {
    var info = reader.frameInfo(frameIdx);
    if (info.disposal === 3) savedCanvas = canvas.slice(0);
    reader.decodeAndBlitFrameRGBA(frameIdx, canvas);
    frames.push({
      rect: fullRect.clone(),
      layerName: "_a_frm" + frameIdx + "," + info.delay * 10,
      data: canvas.slice(0).buffer,
    });
    if (info.disposal === 2) {
      for (var row = 0; row < info.height; row++) {
        var rowStart = ((info.y + row) * width + info.x) * 4;
        canvas.fill(0, rowStart, rowStart + info.width * 4);
      }
    } else if (info.disposal === 3 && savedCanvas) {
      canvas.set(savedCanvas);
    }
  }
  return frames;
}

export const gifCodec = {};
gifCodec.encode = function (frames, width, height, encodeOptions) {
  if (encodeOptions == null) encodeOptions = [100, 0, 0, 0, 0];
  var frameBuffers = [];
  var frameDelays = [];
  var pixelByteCount = width * height * 4;
  for (var frameIdx = 0; frameIdx < frames.length; frameIdx++) {
    var frameCopy = new Uint8Array(frames[frameIdx][0].slice(0));
    binarizeGifFrameAlpha(frameCopy, pixelByteCount);
    frameBuffers.push(frameCopy.buffer);
    frameDelays.push(frames[frameIdx][1]);
  }
  var paletteQuality = Math.round(2 + 254 * encodeOptions[0] / 100);
  var compressed = UPNG.encode.compress(frameBuffers, width, height, paletteQuality, [true, false, false, 8, false]);
  var transparentPaletteIndex = swapGifPaletteRedBlue(compressed.plte);
  var outputBuffer = new Uint8Array(2e3 + width * height * frames.length);
  var loopSetting = encodeOptions[2];
  var gifWriterOptions = { palette: compressed.plte };
  if (loopSetting !== 1) gifWriterOptions.loop = loopSetting === 0 ? 0 : loopSetting - 1;
  var gifWriter = new GifWriter(outputBuffer, width, height, gifWriterOptions);
  for (var frameIdx = 0; frameIdx < frames.length; frameIdx++) {
    var compressedFrame = compressed.frames[frameIdx];
    var frameRect = compressedFrame.rect;
    gifWriter.addFrame(frameRect.x, frameRect.y, frameRect.width, frameRect.height, compressedFrame.img, {
      transparent: transparentPaletteIndex,
      disposal: compressedFrame.dispose + 1,
      delay: Math.round(frameDelays[frameIdx] / 10),
    });
  }
  return outputBuffer.slice(0, gifWriter.end()).buffer;
};
gifCodec.decode = decodeGifFramesWithDisposal;

// ---------------------------------------------------------------------------
// ICO / CUR
// ---------------------------------------------------------------------------

/** @param {Uint8Array} bytes @param {number} offset */
function parseIcoDirectoryEntry(bytes, offset) {
  var entry = {};
  entry.width = bytes[offset];
  offset++;
  if (entry.width === 0) entry.width = 256;
  entry.height = bytes[offset];
  offset++;
  if (entry.height === 0) entry.height = 256;
  entry.colorCount = bytes[offset];
  offset++;
  offset++;
  entry.colorPlanes = BinaryUtils.readUint16LE(bytes, offset);
  offset += 2;
  entry.bitsPerPixel = BinaryUtils.readUint16LE(bytes, offset);
  offset += 2;
  entry.size = BinaryUtils.readFloat32(bytes, offset);
  offset += 4;
  entry.fileOffset = BinaryUtils.readFloat32(bytes, offset);
  offset += 4;
  return entry;
}

function decodeIcoEmbeddedImage(imageBytes, entry) {
  var detectedFormat = detectFormat(imageBytes);
  detectedFormat = detectedFormat ? detectedFormat : "bmp";
  if (detectedFormat === "png") {
    return getFormat(detectedFormat).decode(imageBytes)[0];
  }
  var bmpLayerFrame = getFormat("BMP").decodeToLayerFrame(imageBytes, 0);
  var rgbaBuffer = allocBuffer(entry.width * entry.height * 4);
  copyPixels(
    new Uint8Array(bmpLayerFrame.data),
    new Rect(0, 0, bmpLayerFrame.rect.width, bmpLayerFrame.rect.height),
    rgbaBuffer,
    new Rect(0, entry.height, entry.width, entry.height),
  );
  bmpLayerFrame.data = rgbaBuffer.buffer;
  bmpLayerFrame.rect.height = entry.height;
  return bmpLayerFrame;
}

export const icoCodec = {};
icoCodec.parseIcoDirectoryEntry = parseIcoDirectoryEntry;
icoCodec.encode = function (frames, width, height, encodeOptions) {
  if (width > 256 || height > 256) {
    alert("Maximum ICO size is 256x256 px. Will be cropped.", 4e3);
    var croppedWidth = Math.min(width, 256);
    var croppedHeight = Math.min(height, 256);
    var cropRect = new Rect(0, 0, croppedWidth, croppedHeight);
    var croppedBuffer = allocBuffer(cropRect.area() * 4);
    var sourceRect = new Rect(0, 0, width, height);
    var sourcePixels = new Uint8Array(frames[0][0]);
    copyPixels(sourcePixels, sourceRect, croppedBuffer, cropRect);
    frames[0][0] = croppedBuffer.buffer;
    width = croppedWidth;
    height = croppedHeight;
  }
  var renderBuffer = new RenderBuffer();
  var writeOffset = 0;
  var isHotspot = encodeOptions && encodeOptions[0] === true;
  BinaryUtils.writeUint16LE(renderBuffer, writeOffset, 0);
  writeOffset += 2;
  BinaryUtils.writeUint16LE(renderBuffer, writeOffset, isHotspot ? 2 : 1);
  writeOffset += 2;
  BinaryUtils.writeUint16LE(renderBuffer, writeOffset, 1);
  writeOffset += 2;
  var pngBytes = new Uint8Array(getFormat("png").encode(frames, width, height));
  renderBuffer.ensureCapacity(writeOffset, 16);
  renderBuffer.data[writeOffset] = width === 256 ? 0 : width;
  writeOffset++;
  renderBuffer.data[writeOffset] = height === 256 ? 0 : height;
  writeOffset++;
  writeOffset += 2;
  BinaryUtils.writeUint16LE(renderBuffer, writeOffset, isHotspot ? Math.round(width / 2) : 1);
  writeOffset += 2;
  BinaryUtils.writeUint16LE(renderBuffer, writeOffset, isHotspot ? Math.round(height / 2) : 32);
  writeOffset += 2;
  BinaryUtils.writeFloat32(renderBuffer, writeOffset, pngBytes.length);
  writeOffset += 4;
  BinaryUtils.writeFloat32(renderBuffer, writeOffset, 6 + 16);
  writeOffset += 4;
  renderBuffer.ensureCapacity(writeOffset, pngBytes.length);
  for (var byteIdx = 0; byteIdx < pngBytes.length; byteIdx++) {
    renderBuffer.data[writeOffset + byteIdx] = pngBytes[byteIdx];
  }
  writeOffset += pngBytes.length;
  var outputBytes = new Uint8Array(writeOffset);
  for (var byteIdx = 0; byteIdx < writeOffset; byteIdx++) {
    outputBytes[byteIdx] = renderBuffer.data[byteIdx];
  }
  return outputBytes.buffer;
};
icoCodec.decode = function (buffer) {
  buffer = new Uint8Array(buffer);
  var offset = 4;
  var imageCount = BinaryUtils.readUint16LE(buffer, offset);
  offset += 2;
  var directoryEntries = [];
  for (var entryIdx = 0; entryIdx < imageCount; entryIdx++) {
    var entry = parseIcoDirectoryEntry(buffer, offset + entryIdx * 16);
    var imageBytes = buffer.buffer.slice(entry.fileOffset, entry.fileOffset + entry.size);
    entry.layerFrame = decodeIcoEmbeddedImage(imageBytes, entry);
    directoryEntries.push(entry);
  }
  directoryEntries.sort(function (entryA, entryB) {
    if (entryA.width !== entryB.width) return entryA.width - entryB.width;
    return entryA.bitsPerPixel - entryB.bitsPerPixel;
  });
  return [directoryEntries.pop().layerFrame];
};

// ---------------------------------------------------------------------------
// TIFF (UTIF + camera RAW IFD branches)
// ---------------------------------------------------------------------------

function resolveTiffRawIfd(ifdList, buffer) {
  if (ifdList[0].t33421) return ifdList[0];
  if (ifdList[0].subIFD && ifdList[0].t271 && ifdList[0].t271[0] === "Hasselblad") {
    var hasselbladIfd = ifdList[0].subIFD[0];
    hasselbladIfd.t33421 = [2, 2];
    return hasselbladIfd;
  }
  if (ifdList[0].subIFD && ifdList[0].subIFD[0].t33421) {
    var subIfd = ifdList[0].subIFD[0];
    if (subIfd.t50706 == null && subIfd.t258[0] === 8) subIfd.t258[0] = 12;
    return subIfd;
  }
  if (ifdList[0].subIFD && ifdList[0].subIFD[0] && ifdList[0].subIFD[0].t262 && ifdList[0].subIFD[0].t262[0] === 34892) {
    return ifdList[0].subIFD[0];
  }
  if (ifdList[0].subIFD && ifdList[0].subIFD[1] && ifdList[0].subIFD[1].t33421) {
    return ifdList[0].subIFD[1];
  }
  if (ifdList[0].subIFD && ifdList[0].subIFD[2] && ifdList[0].subIFD[2].t33421) {
    return ifdList[0].subIFD[2];
  }
  if (ifdList[3] && ifdList[3].t50648) {
    var exifIfd = ifdList[0].exifIFD;
    var makerNote = exifIfd.makerNote;
    var nikonRawIfd = ifdList[3];
    var rawWidth = makerNote.t224[1];
    var rawHeight = makerNote.t224[2];
    nikonRawIfd.t256 = [rawWidth];
    nikonRawIfd.t257 = [rawHeight];
    nikonRawIfd.t258 = [16];
    nikonRawIfd.t259 = [7];
    nikonRawIfd.t262 = [32803];
    nikonRawIfd.t277 = [1];
    nikonRawIfd.t33421 = [2, 2];
    var bayerPatternIndex = nikonRawIfd.t50656[0];
    var bayerPattern = BAYER_PATTERNS[bayerPatternIndex];
    if (bayerPattern == null) throw "raw: unknown bayer pattern index";
    nikonRawIfd.t33422 = bayerPattern;
    return nikonRawIfd;
  }
  return null;
}

function mergeTiffRawIfdMetadata(rawIfd, rootIfd, ifdList, buffer) {
  UTIF.decodeImage(buffer, rawIfd, ifdList);
  for (var tagName in rootIfd) {
    if ((tagName[0] === "t" || tagName[0] === "e" || tagName[0] === "d") && rawIfd[tagName] == null) {
      rawIfd[tagName] = rootIfd[tagName];
    }
  }
  rawIfd.orientation = rootIfd.t274 ? rootIfd.t274[0] : 1;
  return [rawIfd];
}

function computeTiffSixteenBitScaleFactor(ifdList, buffer) {
  var scaleFactor = 1 / 256;
  var allSixteenBitSingleChannel = true;
  for (var pageIdx = 0; pageIdx < ifdList.length; pageIdx++) {
    if (ifdList[pageIdx].t258 && ifdList[pageIdx].t258[0] === 16 && ifdList[pageIdx].t277 && ifdList[pageIdx].t277[0] === 1) {
    } else allSixteenBitSingleChannel = false;
  }
  if (!allSixteenBitSingleChannel) return scaleFactor;
  var maxValue = 0;
  var sumValue = 0;
  var sampleCount = 0;
  for (var pageIdx = 0; pageIdx < ifdList.length; pageIdx++) {
    UTIF.decodeImage(buffer, ifdList[pageIdx], ifdList);
    var sampleData = ifdList[pageIdx].data;
    for (var sampleIdx = 0; sampleIdx < sampleData.length; sampleIdx += 2) {
      var sampleValue = sampleData[sampleIdx + 1] << 8 | sampleData[sampleIdx];
      if (sampleValue > maxValue) maxValue = sampleValue;
      sumValue += sampleValue;
      sampleCount++;
    }
  }
  return 1 / 256 * 65535 / (0.5 * maxValue + 0.5 * (2 * sumValue / sampleCount));
}

function decodeTiffRasterPages(buffer, ifdList, scaleFactor) {
  var layerFrames = [];
  for (var pageIdx = 0; pageIdx < ifdList.length; pageIdx++) {
    var ifd = ifdList[pageIdx];
    var dpi = 72;
    UTIF.decodeImage(buffer, ifd, ifdList);
    var xResolution = ifd.t282;
    var resolutionUnit = ifd.t296;
    if (xResolution != null && resolutionUnit != null) {
      dpi = xResolution[0][0] / xResolution[0][1];
      if (resolutionUnit[0] === 3) dpi = Math.round(dpi / 2.54);
    }
    if (ifd.width == null) continue;
    var rgbaBuffer = UTIF.toRGBA8(ifd, scaleFactor).buffer;
    var xmpMetadata = XMPData.readExifMetadata(ifd);
    layerFrames.push({
      rect: new Rect(0, 0, ifd.width, ifd.height),
      data: rgbaBuffer,
      dpi: dpi,
      xmpMetadata: xmpMetadata,
    });
  }
  return layerFrames;
}

export const tiffCodec = {};
tiffCodec.decode = function (buffer) {
  if (lookupCameraBySize(buffer.byteLength)) {
    return [decodeSigmaRaw(buffer)];
  }
  var ifdList = UTIF.decode(buffer);
  var rawIfd = resolveTiffRawIfd(ifdList, buffer);
  if (rawIfd) return mergeTiffRawIfdMetadata(rawIfd, ifdList[0], ifdList, buffer);
  var scaleFactor = computeTiffSixteenBitScaleFactor(ifdList, buffer);
  return decodeTiffRasterPages(buffer, ifdList, scaleFactor);
};
tiffCodec.encode = function (frames, width, height, encodeOptions) {
  if (encodeOptions == null) encodeOptions = [false];
  var tiffTags = {};
  var firstFrame = frames[0];
  if (firstFrame[3] != null && encodeOptions[0]) tiffTags = XMPData.writeExifMetadata(firstFrame[3]);
  if (firstFrame[2] != null) {
    tiffTags.t282 = tiffTags.t283 = [[Math.round(firstFrame[2]), 1]];
    tiffTags.t296 = [2];
  }
  return UTIF.encodeImage(firstFrame[0], width, height, tiffTags);
};
