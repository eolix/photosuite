/**
 * JPEG codec: decode via WASM/libjpeg-turbo path and encode with optional XMP.
 * Format→codec map is assembled in `file-format-registry.js`.
 */

import { Rect } from "../../../core/math/rect.js";
import { Matrix2D } from "../../../core/math/matrix2d.js";
import { BinaryUtils } from "../../../core/binary/binary-utils.js";
import { formatByteSize } from "../../../core/file-names.js";
import { codecLoaders, getFormat, growWasmMemory, detectFormat, matchBytesAt, devToolsBinDb } from "../registry/registry-helpers.js";
import { dataUrlToBuffer } from "../registry/registry-api.js";
import { XMPData } from "../metadata/xmp-metadata.js";
import { rasterizeWithMatrix } from "../../render/raster-transform.js";
import { allocBuffer, fillBuffer } from "../../../engine/compositing/buffer-utils.js";
import { copyPixels, hasNonOpaquePixels } from "../../../engine/compositing/pixel-ops.js";
import { flipPixelsHoriz, matrix2DToHomography, transposePixels, warpWithAffineParams } from "../../../engine/compositing/homography.js";
import { composite } from "../../../engine/compositing/compositing-ops.js";
import { orientationMatrix } from "../../../engine/compositing/raw-functions.js";

/* global UTIF, PDFJS, DOMParser, alert, atob, window, WebAssembly */

export const jpegCodec = {};

// ---------------------------------------------------------------------------
// WASM STB image decode (jpg.wasm via BINDB)
// ---------------------------------------------------------------------------

function decodeViaWasmStbi(jpegBytes, frameHeader) {
  var wasmRuntime = jpegCodec.wasmInstance,
    byteLength = jpegBytes.byteLength,
    width = frameHeader.width,
    height = frameHeader.height,
    pixelCount = width * height,
    memorySize = 5e6 + 2 * byteLength + pixelCount * (frameHeader.progressive ? Math.max(2, frameHeader.numComponents) * 4 + 1 : 8),
    wasmExports = wasmRuntime.instance.exports;
  growWasmMemory(wasmExports, memorySize);
  var memoryView = new Uint8Array(wasmExports.memory.buffer),
    inputPtr = wasmExports.malloc(byteLength);
  memoryView.set(new Uint8Array(jpegBytes), inputPtr);
  var widthOutPtr = wasmExports.malloc(4),
    heightOutPtr = wasmExports.malloc(4),
    channelsOutPtr = wasmExports.malloc(4),
    outputPtr = wasmExports.stbi_load_from_memory(inputPtr, byteLength, widthOutPtr, heightOutPtr, channelsOutPtr, 4);
  wasmExports.free(inputPtr);
  wasmExports.free(widthOutPtr, heightOutPtr, channelsOutPtr);
  wasmExports.free(outputPtr);
  var rgbaBytes = memoryView.slice(outputPtr, outputPtr + pixelCount * 4);
  return rgbaBytes;
}

(function () {
  var wasmBytes = devToolsBinDb.get("wasm/jpg").buffer;
  if (window.WebAssembly == null) window.alert("Your browser is too old. Please, update it.");
  WebAssembly.instantiate(wasmBytes).then(function (wasmModule) {
    jpegCodec.wasmInstance = wasmModule;
  });
}());

// ---------------------------------------------------------------------------
// Marker scan and SOF header
// ---------------------------------------------------------------------------

function scanJpegMarkers(jpegBytes) {
  var scanOffset = 0,
    markersByCode = [],
    bufferLength = jpegBytes.length;
  while (scanOffset < bufferLength) {
    while (jpegBytes[scanOffset] != 255 && scanOffset < bufferLength) scanOffset++;
    while (jpegBytes[scanOffset] == 255) scanOffset++;
    var markerCode = jpegBytes[scanOffset];
    scanOffset++;
    if (markersByCode[markerCode] == null) markersByCode[markerCode] = [];
    markersByCode[markerCode].push(scanOffset - 2);
    if (markerCode == 216) continue;
    if (markerCode == 217) break;
    if (224 <= markerCode && markerCode <= 239 || markerCode == 218 || markerCode == 219 || markerCode == 192 || markerCode == 193 || markerCode == 194 || markerCode == 196 || markerCode == 221 || markerCode == 254) {
      var segmentLength = BinaryUtils.readUint16(jpegBytes, scanOffset);
      scanOffset += segmentLength;
      if (markerCode == 218) {
        while (scanOffset < bufferLength && (jpegBytes[scanOffset] != 255 || (jpegBytes[scanOffset + 1] == 0 || 208 <= jpegBytes[scanOffset + 1] && jpegBytes[scanOffset + 1] <= 215))) scanOffset++;
      }
      continue;
    }
    break;
  }
  if (markersByCode[217] == null) {
    var eoiInsertOffset = jpegBytes.length - 2;
    jpegBytes[eoiInsertOffset] = 255;
    jpegBytes[eoiInsertOffset + 1] = 217;
    markersByCode[217] = [eoiInsertOffset];
  }
  return markersByCode;
}

function readJpegFrameHeader(jpegBytes, markers) {
  var readOffset = (markers[192] ? markers[192] : markers[193] ? markers[193] : markers[194])[0] + 4,
    frameHeader = {};
  frameHeader.progressive = markers[194] != null;
  frameHeader.precision = jpegBytes[readOffset];
  readOffset++;
  frameHeader.height = BinaryUtils.readUint16(jpegBytes, readOffset);
  readOffset += 2;
  frameHeader.width = BinaryUtils.readUint16(jpegBytes, readOffset);
  readOffset += 2;
  frameHeader.numComponents = jpegBytes[readOffset];
  readOffset++;
  if (markers[224]) {
    var jfifBlock = frameHeader.jfif = {};
    readOffset = markers[224][0] + 2 + 2 + 5 + 2;
    jfifBlock.densityUnits = jpegBytes[readOffset];
    readOffset++;
    jfifBlock.xDensity = BinaryUtils.readUint16(jpegBytes, readOffset);
    readOffset += 2;
    jfifBlock.yDensity = BinaryUtils.readUint16(jpegBytes, readOffset);
    readOffset += 2;
  }
  if (markers[238]) {
    var adobeBlock = frameHeader.adobe = {};
    readOffset = markers[238][0] + 2 + 2 + 6;
    adobeBlock.version = jpegBytes[readOffset];
    readOffset++;
    adobeBlock.flags0 = BinaryUtils.readUint16(jpegBytes, readOffset);
    readOffset += 2;
    adobeBlock.flags1 = BinaryUtils.readUint16(jpegBytes, readOffset);
    readOffset += 2;
    adobeBlock.transform = jpegBytes[readOffset];
    readOffset++;
  }
  return frameHeader;
}

// ---------------------------------------------------------------------------
// APP1 metadata segments (Exif, XMP, XMP extension)
// ---------------------------------------------------------------------------

function decodeMcuStrip(jpegBytes, segmentOffset, frameHeader) {
  var readOffset = segmentOffset,
    segmentLength = BinaryUtils.readUint16(jpegBytes, readOffset);
  readOffset += 2;
  var identifierString = BinaryUtils.readString(jpegBytes, readOffset, 4);
  if (identifierString == "Exif") {
    readOffset += 6;
    var exifSlice = jpegBytes.slice(readOffset, readOffset + segmentLength - 8),
      exifDecoded;
    try {
      exifDecoded = UTIF.decode(exifSlice.buffer, {
        parseMN: false,
        debug: false
      });
    } catch (decodeErr) {}
    if (exifDecoded) frameHeader.exif = exifDecoded;
  } else if (identifierString == "http") {
    var nullTermLen = 0;
    while (jpegBytes[readOffset + nullTermLen] != 0) nullTermLen++;
    var namespaceUri = BinaryUtils.readString(jpegBytes, readOffset, nullTermLen);
    readOffset += nullTermLen + 1;
    if (namespaceUri == "http://ns.adobe.com/xmp/extension/") {
      var extensionGuid = BinaryUtils.readString(jpegBytes, readOffset, 32);
      readOffset += 32;
      readOffset += 8;
      var extensionPayloadLen = segmentOffset + segmentLength - readOffset;
      while (jpegBytes[readOffset + extensionPayloadLen - 1] == 0) extensionPayloadLen--;
      if (frameHeader.xmp_extn == null) frameHeader.xmp_extn = "";
      try {
        frameHeader.xmp_extn += BinaryUtils.readUtf8(jpegBytes, readOffset, extensionPayloadLen);
      } catch (decodeErr) {}
    } else if (namespaceUri == "http://ns.adobe.com/xap/1.0/") {
      var xmpPayload = BinaryUtils.readUtf8(jpegBytes.slice(readOffset, readOffset + segmentLength - nullTermLen - 3));
      if (xmpPayload[0] == "?") xmpPayload = "<" + xmpPayload;
      frameHeader.xmp = xmpPayload;
    }
  }
}

function packPlanarRgbToRgba(rgbSamples, pixelCount) {
  var rgbaBuffer = allocBuffer(pixelCount * 4);
  for (var idx = 0; idx < pixelCount; idx++) {
    var pixelOffset = idx << 2,
      rgbBaseOffset = pixelOffset - idx;
    rgbaBuffer[pixelOffset] = rgbSamples[rgbBaseOffset];
    rgbaBuffer[pixelOffset + 1] = rgbSamples[rgbBaseOffset + 1];
    rgbaBuffer[pixelOffset + 2] = rgbSamples[rgbBaseOffset + 2];
    rgbaBuffer[pixelOffset + 3] = 255;
  }
  return rgbaBuffer;
}

function parsePhotoshopApp13Resources(jpegBytes, app13MarkerOffsets, xmpMetadata) {
  var resourceIdList = [],
    pathResourceList = [];
  if (!app13MarkerOffsets) return { xmpMetadata: xmpMetadata, pathResourceList: pathResourceList };
  var growablePhotoshopBuffer = new Uint8Array(65536),
    photoshopWriteOffset = 0,
    segmentReadOffset = 0;
  for (var idx = 0; idx < app13MarkerOffsets.length; idx++) {
    segmentReadOffset = app13MarkerOffsets[idx] + 2;
    var segmentEnd = segmentReadOffset + BinaryUtils.readUint16(jpegBytes, segmentReadOffset);
    segmentReadOffset += 2;
    var stringStartOffset = segmentReadOffset;
    while (jpegBytes[segmentReadOffset] != 0) segmentReadOffset++;
    segmentReadOffset++;
    var resourceKey = BinaryUtils.readString(jpegBytes, stringStartOffset, segmentReadOffset - stringStartOffset - 1),
      resourcePayloadLen = segmentEnd - segmentReadOffset;
    while (photoshopWriteOffset + resourcePayloadLen > growablePhotoshopBuffer.length) {
      var doubledBuffer = new Uint8Array(growablePhotoshopBuffer.length * 2);
      doubledBuffer.set(growablePhotoshopBuffer);
      growablePhotoshopBuffer = doubledBuffer;
    }
    var resourceSlice = new Uint8Array(jpegBytes.buffer, segmentReadOffset, resourcePayloadLen);
    growablePhotoshopBuffer.set(resourceSlice, photoshopWriteOffset);
    photoshopWriteOffset += resourcePayloadLen;
  }
  segmentReadOffset = 0;
  var photoshopBuffer = growablePhotoshopBuffer;
  while (segmentReadOffset < photoshopWriteOffset) {
    var photoshopSignature = BinaryUtils.readString(photoshopBuffer, segmentReadOffset, 4);
    segmentReadOffset += 4;
    if (photoshopSignature != "8BIM" && photoshopSignature != "AgHg" && photoshopSignature != "PHUT" && photoshopSignature != "DCSR") throw photoshopSignature;
    var resourceId = BinaryUtils.readUint16(photoshopBuffer, segmentReadOffset);
    segmentReadOffset += 2;
    var resourceNameLen = photoshopBuffer[segmentReadOffset++],
      resourceName = BinaryUtils.readString(photoshopBuffer, segmentReadOffset, resourceNameLen);
    segmentReadOffset += resourceNameLen;
    if ((resourceNameLen & 1) == 0) segmentReadOffset++;
    var resourceDataLen = BinaryUtils.readUint32BE(photoshopBuffer, segmentReadOffset);
    segmentReadOffset += 4;
    var resourceEndOffset = segmentReadOffset + resourceDataLen + (resourceDataLen & 1);
    if (resourceId == 1028) {
      while (segmentReadOffset + 4 < resourceEndOffset) {
        var resourceTypeByte = photoshopBuffer[segmentReadOffset++],
          resourceSubtypeByte = photoshopBuffer[segmentReadOffset++],
          resourceChannelByte = photoshopBuffer[segmentReadOffset++],
          embeddedNameLen = BinaryUtils.readUint16(photoshopBuffer, segmentReadOffset);
        segmentReadOffset += 2;
        if (resourceTypeByte == 28 && resourceSubtypeByte == 2) resourceIdList.push([resourceChannelByte, BinaryUtils.readString(photoshopBuffer, segmentReadOffset, embeddedNameLen)]);
        segmentReadOffset += embeddedNameLen;
      }
    } else if ((resourceId & 2e3) == 2e3) {
      var pathPoints = codecLoaders.PathRecordCodec.readPathPoints(photoshopBuffer, segmentReadOffset, resourceDataLen);
      pathResourceList.push([resourceName, pathPoints]);
    }
    segmentReadOffset = resourceEndOffset;
  }
  if (resourceIdList.length != 0) xmpMetadata = XMPData.readPsdResources(resourceIdList, xmpMetadata);
  return { xmpMetadata: xmpMetadata, pathResourceList: pathResourceList };
}

function parseXmpExtensionLayers(xmpExtensionXml, layerFrames) {
  if (!xmpExtensionXml) return;
  var xmpDomParser = new DOMParser,
    xmpExtensionDoc = xmpDomParser.parseFromString(xmpExtensionXml, "image/svg+xml"),
    xmpExtensionRoot = xmpExtensionDoc.children[0].children[0].children[0],
    googleImageAttrs = [xmpExtensionRoot.getAttribute("GImage:Data"), xmpExtensionRoot.getAttribute("GDepth:Data")];
  for (var idx = 0; idx < googleImageAttrs.length; idx++) {
    if (googleImageAttrs[idx]) {
      var base64Payload = atob(googleImageAttrs[idx]),
        decodedBytes = new Uint8Array(base64Payload.length);
      BinaryUtils.writeAsciiRaw(decodedBytes, 0, base64Payload);
      decodedBytes = decodedBytes.buffer;
      var detectedFormat = detectFormat(decodedBytes),
        decodedLayers = getFormat(detectedFormat).decode(decodedBytes);
      layerFrames.push(decodedLayers[0]);
    }
  }
}

function parseSuffixTrailer(suffixBytes, layerFrames, width, height, pixelCount) {
  var suffixFourCC = BinaryUtils.readString(suffixBytes, 4, 4),
    embeddedJpegOffset = BinaryUtils.indexOfBytes(suffixBytes, String.fromCharCode(255) + String.fromCharCode(216) + String.fromCharCode(255));
  if (matchBytesAt(suffixBytes, [0, 0, 1, 10, 14, 0, 0, 0])) {
    var chunkReadOffset = 0;
    while (chunkReadOffset != suffixBytes.length) {
      var chunkType = BinaryUtils.readUint16LE(suffixBytes, chunkReadOffset + 2);
      chunkReadOffset += 4;
      var fixedFieldLen = {
        2272: 12,
        2320: 21,
        2561: 13,
        2625: 21,
        2721: 3,
        2608: 0
      }[chunkType];
      if (fixedFieldLen != null) {
        var stringByteLen = BinaryUtils.readFloat32(suffixBytes, chunkReadOffset);
        chunkReadOffset += 4;
        var chunkString = BinaryUtils.readString(suffixBytes, chunkReadOffset, stringByteLen);
        chunkReadOffset += stringByteLen;
        var chunkFixedField = BinaryUtils.readString(suffixBytes, chunkReadOffset, fixedFieldLen);
        chunkReadOffset += fixedFieldLen;
        if (chunkType == 2608) {
          var mp4Size = BinaryUtils.readUint32BE(suffixBytes, chunkReadOffset + 24);
          chunkReadOffset += mp4Size + 24;
          var skipSize = BinaryUtils.readUint32BE(suffixBytes, chunkReadOffset);
          chunkReadOffset += skipSize;
          alert("PhotoSuite found a " + formatByteSize(mp4Size) + " MP4 video inside your image.", 4e3);
        }
      } else if (chunkType == 18502) {
        while (BinaryUtils.readString(suffixBytes, chunkReadOffset, 4) != "SEFT") chunkReadOffset += 4;
        chunkReadOffset += 4;
      } else {
        break;
      }
    }
  } else if (suffixFourCC == "ftyp") {
    alert("PhotoSuite found a " + formatByteSize(suffixBytes.length) + " MP4 video inside your image.", 4e3);
  } else if (BinaryUtils.readString(suffixBytes, 0, 4) == "fixe") {
    alert("Unknown data - " + suffixBytes.length + " B - at the end of the file", 3e3);
    var chunkReadOffset = 4;
    chunkReadOffset += 12;
    chunkReadOffset += 84;
    chunkReadOffset += 32;
    chunkReadOffset += 8;
    chunkReadOffset += 32;
  } else if (BinaryUtils.readString(suffixBytes, 8, 13) == "FocusShot_Map") {
    BinaryUtils.readUint32BE(suffixBytes, 0);
    BinaryUtils.readFloat32(suffixBytes, 4);
    var focusMaskBuffer = allocBuffer(pixelCount * 4),
      focusDepthBuffer = allocBuffer(pixelCount * 4);
    for (var rowIdx = 0; rowIdx < height; rowIdx++) {
      for (var colIdx = 0; colIdx < width; colIdx++) {
        var pixelIdx = rowIdx * width + colIdx,
          pixelOffset = pixelIdx << 2,
          focusSampleOffset = 8 + 13 + ((rowIdx >>> 1) * width + colIdx >>> 1),
          maskValue = suffixBytes[focusSampleOffset],
          depthValue = suffixBytes[focusSampleOffset + (pixelCount >>> 2)];
        focusMaskBuffer[pixelOffset] = focusMaskBuffer[pixelOffset + 1] = focusMaskBuffer[pixelOffset + 2] = maskValue;
        focusMaskBuffer[pixelOffset + 3] = 255;
        focusDepthBuffer[pixelOffset] = focusDepthBuffer[pixelOffset + 1] = focusDepthBuffer[pixelOffset + 2] = depthValue;
        focusDepthBuffer[pixelOffset + 3] = 255;
      }
    }
    layerFrames.push({
      rect: new Rect(0, 0, width, height),
      data: focusMaskBuffer.buffer
    }, {
      rect: new Rect(0, 0, width, height),
      data: focusDepthBuffer.buffer
    });
  } else if (suffixFourCC == "edof") {
    var edofOrientation = suffixBytes[8 + 7],
      chunkReadOffset = 8 + 16,
      mapWidth = BinaryUtils.readUint16LE(suffixBytes, chunkReadOffset),
      mapHeight = BinaryUtils.readUint16LE(suffixBytes, chunkReadOffset + 2),
      depthPixelCount = mapWidth * mapHeight;
    chunkReadOffset += 4;
    chunkReadOffset += 32 + 16;
    var depthRgbaBuffer = allocBuffer(depthPixelCount * 4);
    for (var idx = 0; idx < depthPixelCount; idx++) {
      var pixelOffset = idx << 2;
      depthRgbaBuffer[pixelOffset] = depthRgbaBuffer[pixelOffset + 1] = depthRgbaBuffer[pixelOffset + 2] = suffixBytes[chunkReadOffset + idx];
      depthRgbaBuffer[pixelOffset + 3] = 255;
    }
    if (edofOrientation == 16) {
    } else if (edofOrientation == 19) {
      var transposedBuffer = depthRgbaBuffer.slice(0);
      transposePixels(depthRgbaBuffer, transposedBuffer, mapWidth, mapHeight);
      var swappedDim = mapWidth;
      mapWidth = mapHeight;
      mapHeight = swappedDim;
      flipPixelsHoriz(transposedBuffer, depthRgbaBuffer, mapWidth, mapHeight);
    } else throw "Unknown orientation of a depth map";
    layerFrames.push({
      rect: new Rect(0, 0, mapWidth, mapHeight),
      data: depthRgbaBuffer.buffer
    });
  } else if (embeddedJpegOffset != -1 && !(suffixBytes[0] == 255 && suffixBytes[1] == 129)) {
    try {
      if (embeddedJpegOffset != 0) suffixBytes = suffixBytes.slice(embeddedJpegOffset);
      var decodedLayers = getFormat("jpg").decode(suffixBytes.buffer);
      for (var idx = 0; idx < decodedLayers.length; idx++) layerFrames.push(decodedLayers[idx]);
    } catch (decodeErr) {}
  }
}

function normalizeAuxiliaryLayerSizes(layerFrames) {
  if (layerFrames.length <= 1) return;
  var mainLayerRect = layerFrames[0].rect;
  layerFrames[0].layerName = "Main";
  for (var idx = 1; idx < layerFrames.length; idx++) {
    layerFrames[idx].layerName = isGrayscaleRgbPixels(new Uint8Array(layerFrames[idx].data)) ? "Depth Map" : null;
    var layerRect = layerFrames[idx].rect;
    if (!layerRect.equals(mainLayerRect)) {
      var scaleX = mainLayerRect.width / layerRect.width,
        scaleY = mainLayerRect.height / layerRect.height,
        scaleMatrix = new Matrix2D;
      scaleMatrix.scale(scaleX, scaleY);
      var rasterizedLayer = rasterizeWithMatrix([new Uint8Array(layerFrames[idx].data), layerRect], 1, matrix2DToHomography(scaleMatrix));
      layerFrames[idx].rect = rasterizedLayer.rect;
      layerFrames[idx].data = rasterizedLayer.buffer;
    }
  }
}

function applyExifOrientationToFrames(layerFrames, orientationAffine) {
  if (jpegCodec.activeDecodeCount != 1) return;
  if (orientationAffine[2] == 1 && orientationAffine[6] == 1) return;
  for (var idx = 0; idx < layerFrames.length; idx++) {
    var layerFrame = layerFrames[idx],
      layerPixels = new Uint8Array(layerFrame.data),
      layerWidth = layerFrame.rect.width,
      layerHeight = layerFrame.rect.height,
      orientedWidth = orientationAffine[0],
      orientedHeight = orientationAffine[1],
      orientedBuffer = allocBuffer(orientedWidth * orientedHeight * 4);
    warpWithAffineParams(layerPixels, layerWidth, layerHeight, orientedBuffer, orientationAffine);
    layerFrame.rect = new Rect(0, 0, orientedWidth, orientedHeight);
    layerFrame.data = orientedBuffer.buffer;
  }
}

function isGrayscaleRgbPixels(rgbaPixels) {
  var isGrayscale = true;
  for (var idx = 0; idx < rgbaPixels.length; idx += 4) {
    isGrayscale = isGrayscale && rgbaPixels[idx] == rgbaPixels[idx + 1] && rgbaPixels[idx + 1] == rgbaPixels[idx + 2];
  }
  return isGrayscale;
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

function encode(layerFrames, width, height, encodeOptions) {
  if (encodeOptions == null) encodeOptions = [70];
  var firstLayerFrame = layerFrames[0],
    rgbaBuffer = new Uint8Array(firstLayerFrame[0]);
  if (hasNonOpaquePixels(rgbaBuffer)) {
    var opaqueBuffer = new Uint8Array(rgbaBuffer.length),
      fullRect = new Rect(0, 0, width, height);
    fillBuffer(opaqueBuffer, 4294967295);
    composite("norm", rgbaBuffer, fullRect, opaqueBuffer, fullRect, fullRect, 1);
    rgbaBuffer = opaqueBuffer;
  }
  var jpegBytes = new Uint8Array(dataUrlToBuffer(rgbaBuffer.buffer, width, height, "jpeg", encodeOptions[0] / 100));
  if (firstLayerFrame[2] != null) {
    var exifDpiOffset = scanJpegMarkers(jpegBytes)[224][0] + 2;
    exifDpiOffset += 9;
    jpegBytes[exifDpiOffset] = 1;
    BinaryUtils.writeUint16Raw(jpegBytes, exifDpiOffset + 1, firstLayerFrame[2]);
    BinaryUtils.writeUint16Raw(jpegBytes, exifDpiOffset + 3, firstLayerFrame[2]);
  }
  if (firstLayerFrame[3] != null && encodeOptions[1] == true && Object.keys(firstLayerFrame[3]).length != 0) {
    var exifSegmentSize = 0,
      xmpSegmentSize = 0,
      irbSegmentSize = 0,
      utifExif = XMPData.writeExifMetadata(firstLayerFrame[3]),
      exifBlob = new Uint8Array(UTIF.encode([utifExif])),
      xmpNamespace = "http://ns.adobe.com/xap/1.0/",
      irbDataSize = 0,
      writeOffset = 0,
      insertOffset = 20;
    exifSegmentSize = 4 + 6 + exifBlob.length;
    var xmpXml = XMPData.writeXmpXml(firstLayerFrame[3]),
      xmpUtf8 = BinaryUtils.encodeUtf8(xmpXml);
    xmpSegmentSize = 4 + xmpNamespace.length + 1 + xmpUtf8.length;
    var resourceEntries = XMPData.writePsdResources(firstLayerFrame[3]);
    for (var idx = 0; idx < resourceEntries.length; idx++) irbDataSize += 5 + resourceEntries[idx][1].length;
    var paddedIrbSize = irbDataSize + (irbDataSize & 1),
      irbBlock = allocBuffer(14 + 4 + 2 + 4 + paddedIrbSize);
    BinaryUtils.writeAsciiRaw(irbBlock, writeOffset, "Photoshop 3.0");
    writeOffset += 14;
    BinaryUtils.writeAsciiRaw(irbBlock, writeOffset, "8BIM");
    writeOffset += 4;
    irbBlock[writeOffset++] = 4;
    irbBlock[writeOffset++] = 4;
    writeOffset += 2;
    BinaryUtils.writeUint32BE(irbBlock, writeOffset, irbDataSize);
    writeOffset += 4;
    for (var idx = 0; idx < resourceEntries.length; idx++) {
      var resourceEntry = resourceEntries[idx],
        resourceName = resourceEntry[1];
      irbBlock[writeOffset++] = 28;
      irbBlock[writeOffset++] = 2;
      irbBlock[writeOffset++] = resourceEntry[0];
      BinaryUtils.writeUint16Raw(irbBlock, writeOffset, resourceName.length);
      writeOffset += 2;
      BinaryUtils.writeAsciiRaw(irbBlock, writeOffset, resourceName);
      writeOffset += resourceName.length;
    }
    irbSegmentSize = 4 + irbBlock.length;
    var totalInsertSize = exifSegmentSize + xmpSegmentSize + irbSegmentSize,
      outputBuffer = new Uint8Array(jpegBytes.length + totalInsertSize);
    for (var idx = 0; idx < 20; idx++) outputBuffer[idx] = jpegBytes[idx];
    for (var idx = 20; idx < jpegBytes.length; idx++) outputBuffer[idx + totalInsertSize] = jpegBytes[idx];
    outputBuffer[insertOffset] = 255;
    outputBuffer[insertOffset + 1] = 225;
    BinaryUtils.writeUint16Raw(outputBuffer, insertOffset + 2, exifSegmentSize - 2);
    BinaryUtils.writeAsciiRaw(outputBuffer, insertOffset + 4, "Exif");
    for (var idx = 0; idx < exifBlob.length; idx++) outputBuffer[insertOffset + 10 + idx] = exifBlob[idx];
    insertOffset += exifSegmentSize;
    outputBuffer[insertOffset] = 255;
    outputBuffer[insertOffset + 1] = 225;
    BinaryUtils.writeUint16Raw(outputBuffer, insertOffset + 2, xmpSegmentSize - 2);
    BinaryUtils.writeAsciiRaw(outputBuffer, insertOffset + 4, xmpNamespace);
    for (var idx = 0; idx < xmpUtf8.length; idx++) outputBuffer[insertOffset + 4 + xmpNamespace.length + 1 + idx] = xmpUtf8[idx];
    insertOffset += xmpSegmentSize;
    outputBuffer[insertOffset] = 255;
    outputBuffer[insertOffset + 1] = 237;
    BinaryUtils.writeUint16Raw(outputBuffer, insertOffset + 2, irbSegmentSize - 2);
    for (var idx = 0; idx < irbBlock.length; idx++) outputBuffer[insertOffset + 4 + idx] = irbBlock[idx];
    insertOffset += irbSegmentSize;
    jpegBytes = outputBuffer;
  }
  return jpegBytes.buffer;
}

function encodeRgbBufferToJpeg(jpegBuffer) {
  jpegBuffer = new Uint8Array(jpegBuffer);
  if (jpegBuffer[0] != 255) return jpegBuffer.buffer;
  var markers = scanJpegMarkers(jpegBuffer),
    frameHeader = readJpegFrameHeader(jpegBuffer, markers);
  if (frameHeader.numComponents != 4) return jpegBuffer.buffer;
  var width = frameHeader.width,
    height = frameHeader.height,
    layerFrames = decodeJpegToLayerFrames(jpegBuffer, markers, true);
  return encode([
    [layerFrames[0].data]
  ], width, height, [85]);
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

function decodeJpegToLayerFrames(jpegBytes, markers, forceRgb) {
  var frameHeader = readJpegFrameHeader(jpegBytes, markers),
    width = frameHeader.width,
    height = frameHeader.height,
    pixelCount = width * height,
    rgbaBuffer,
    adobeTransform = -1,
    dpi = 72,
    xmpMetadata;
  if (frameHeader.adobe) adobeTransform = frameHeader.adobe.transform;
  if (forceRgb || width * height > 15e7 || adobeTransform == 0 || adobeTransform == 2) {
    var pdfJsImage = new PDFJS.JpegImage;
    pdfJsImage.parse(jpegBytes);
    var pdfRgbData = pdfJsImage.getData({
      width: width,
      height: height,
      forceRGB: true,
      isSourcePDF: forceRgb
    });
    rgbaBuffer = packPlanarRgbToRgba(pdfRgbData, pixelCount);
  } else {
    rgbaBuffer = decodeViaWasmStbi(jpegBytes.buffer, frameHeader);
  }
  var app1MarkerOffsets = markers[225];
  if (app1MarkerOffsets) {
    for (var idx = 0; idx < app1MarkerOffsets.length; idx++) decodeMcuStrip(jpegBytes, app1MarkerOffsets[idx] + 2, frameHeader);
  }
  var suffixStartOffset = markers[217][0] + 2;
  if (suffixStartOffset != jpegBytes.length) frameHeader.suffix = jpegBytes.slice(suffixStartOffset);
  var orientationAffine = [width, height, 1, 0, 0, 0, 1, 0];
  if (frameHeader.jfif && frameHeader.jfif.densityUnits != 0) {
    dpi = Math.round([72, 1, 2.54][frameHeader.jfif.densityUnits] * frameHeader.jfif.xDensity);
  } else if (frameHeader.exif && frameHeader.exif[0].t282 != null) {
    var exifResolution = frameHeader.exif[0].t282[0];
    dpi = exifResolution[0] / exifResolution[1];
  }
  if (frameHeader.exif) {
    var exifFrames = frameHeader.exif;
    xmpMetadata = XMPData.readExifMetadata(exifFrames[0]);
    var orientationTag = exifFrames[0].t274;
    if (orientationTag) orientationTag = orientationTag[0];
    if (orientationTag != null && orientationTag > 1 && orientationTag < 20) orientationAffine = orientationMatrix(orientationTag, width, height);
  }
  if (frameHeader.xmp) {
    xmpMetadata = XMPData.readXmpXml(frameHeader.xmp, xmpMetadata);
  }
  var app13ParseResult = parsePhotoshopApp13Resources(jpegBytes, markers[237], xmpMetadata);
  xmpMetadata = app13ParseResult.xmpMetadata;
  var pathResourceList = app13ParseResult.pathResourceList;
  var layerFrames = [{
    rect: new Rect(0, 0, width, height),
    data: rgbaBuffer.buffer,
    dpi: dpi,
    xmpMetadata: xmpMetadata,
    pathResources: pathResourceList.length == 0 ? null : pathResourceList
  }];
  parseXmpExtensionLayers(frameHeader.xmp_extn, layerFrames);
  if (frameHeader.suffix) parseSuffixTrailer(frameHeader.suffix, layerFrames, width, height, pixelCount);
  normalizeAuxiliaryLayerSizes(layerFrames);
  applyExifOrientationToFrames(layerFrames, orientationAffine);
  return layerFrames;
}

function decodeLosslessJpeg(inputBytes, markers) {
  var losslessWidth = BinaryUtils.readUint16(inputBytes, markers[195][0] + 5),
    losslessHeight = BinaryUtils.readUint16(inputBytes, markers[195][0] + 7),
    losslessRgb = UTIF.LosslessJpegDecode(inputBytes),
    losslessPixelCount = losslessHeight * losslessWidth,
    rgbaBuffer = packPlanarRgbToRgba(losslessRgb, losslessPixelCount);
  return [{
    rect: new Rect(0, 0, losslessHeight, losslessWidth),
    data: rgbaBuffer.buffer
  }];
}

function decodeJbig2Image(inputBytes, sidecarBytes, invertBits) {
  var jbig2Bytes = inputBytes,
    jbig2Image = new PDFJS.Jbig2Image,
    jbig2Segments = [];
  if (sidecarBytes) {
    jbig2Segments.push({
      data: sidecarBytes,
      start: 0,
      end: sidecarBytes.length
    });
  }
  jbig2Segments.push({
    data: jbig2Bytes,
    start: 0,
    end: jbig2Bytes.length
  });
  var jbig2Bitmap = jbig2Image.parseChunks(jbig2Segments);
  if (!invertBits) {
    for (var idx = 0; idx < jbig2Bitmap.length; idx++) jbig2Bitmap[idx] = ~jbig2Bitmap[idx];
  }
  var jbig2Width = BinaryUtils.readUint32BE(inputBytes, 11),
    jbig2Height = BinaryUtils.readUint32BE(inputBytes, 15),
    rowByteCount = Math.ceil(jbig2Width / 8),
    jbig2Rgba = allocBuffer(jbig2Width * jbig2Height * 4);
  for (var rowIdx = 0; rowIdx < jbig2Height; rowIdx++) {
    var rowBaseOffset = rowIdx * rowByteCount;
    for (var colIdx = 0; colIdx < jbig2Width; colIdx++) {
      var pixelOffset = (rowIdx * jbig2Width + colIdx) * 4,
        bitValue = jbig2Bitmap[rowBaseOffset + (colIdx >>> 3)] >>> 7 - (colIdx & 7) & 1,
        grayValue = bitValue * 255;
      jbig2Rgba[pixelOffset] = grayValue;
      jbig2Rgba[pixelOffset + 1] = grayValue;
      jbig2Rgba[pixelOffset + 2] = grayValue;
      jbig2Rgba[pixelOffset + 3] = 255;
    }
  }
  return [{
    rect: new Rect(0, 0, jbig2Width, jbig2Height),
    data: jbig2Rgba.buffer
  }];
}

function decodeJpxImage(inputBytes) {
  var jpxImage = new PDFJS.JpxImage;
  jpxImage.parse(inputBytes);
  var jpxWidth = jpxImage.width,
    jpxHeight = jpxImage.height,
    jpxTiles = jpxImage.tiles,
    componentCount = jpxImage.componentsCount,
    jpxRgba = new Uint8Array(jpxWidth * jpxHeight * 4),
    fullRect = new Rect(0, 0, jpxWidth, jpxHeight);
  for (var tileIdx = 0; tileIdx < jpxTiles.length; tileIdx++) {
    var tile = jpxTiles[tileIdx],
      tileWidth = tile.width,
      tileHeight = tile.height,
      tilePixelCount = tileWidth * tileHeight,
      tileItems = tile.items,
      tileRect = new Rect(tile.left, tile.top, tileWidth, tileHeight),
      tileRgba = new Uint8Array(tilePixelCount * 4);
    if (componentCount == 1) {
      for (var idx = 0; idx < tilePixelCount; idx++) {
        var graySample = tileItems[idx],
          pixelOffset = idx * 4;
        tileRgba[pixelOffset] = graySample;
        tileRgba[pixelOffset + 1] = graySample;
        tileRgba[pixelOffset + 2] = graySample;
        tileRgba[pixelOffset + 3] = 255;
      }
    } else if (componentCount == 3) {
      for (var idx = 0; idx < tilePixelCount; idx++) {
        var rgbOffset = idx * 3,
          pixelOffset = idx * 4;
        tileRgba[pixelOffset] = tileItems[rgbOffset];
        tileRgba[pixelOffset + 1] = tileItems[rgbOffset + 1];
        tileRgba[pixelOffset + 2] = tileItems[rgbOffset + 2];
        tileRgba[pixelOffset + 3] = 255;
      }
    }
    copyPixels(tileRgba, tileRect, jpxRgba, fullRect);
  }
  return [{
    rect: fullRect,
    data: jpxRgba.buffer
  }];
}

function decode(inputBytes, sidecarBytes, invertBits) {
  inputBytes = new Uint8Array(inputBytes);
  if (inputBytes[0] == 255) {
    var markers = scanJpegMarkers(inputBytes);
    if (markers[195] == null) {
      jpegCodec.activeDecodeCount++;
      var layerFrames = decodeJpegToLayerFrames(inputBytes, markers, false);
      jpegCodec.activeDecodeCount--;
      return layerFrames;
    }
    return decodeLosslessJpeg(inputBytes, markers);
  } else if (inputBytes[0] == 0 && inputBytes[4] == 48 && inputBytes[6] == 1) {
    return decodeJbig2Image(inputBytes, sidecarBytes, invertBits);
  } else {
    return decodeJpxImage(inputBytes);
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

jpegCodec.wasmInstance = null;
jpegCodec.decodeViaWasmStbi = decodeViaWasmStbi;
jpegCodec.encode = encode;
jpegCodec.scanJpegMarkers = scanJpegMarkers;
jpegCodec.encodeRgbBufferToJpeg = encodeRgbBufferToJpeg;
jpegCodec.readJpegFrameHeader = readJpegFrameHeader;
jpegCodec.decodeMcuStrip = decodeMcuStrip;
jpegCodec.decodeJpegToLayerFrames = decodeJpegToLayerFrames;
jpegCodec.isGrayscaleRgbPixels = isGrayscaleRgbPixels;
jpegCodec.activeDecodeCount = 0;
jpegCodec.decode = decode;
