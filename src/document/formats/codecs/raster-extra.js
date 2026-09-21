/**
 * Uncommon raster codecs: LIF and EXE embedded-image extraction.
 * Wired in `file-format-registry.js`.
 */

import { Rect } from "../../../core/math/rect.js";
import { BinaryUtils } from "../../../core/binary/binary-utils.js";
import { getFormat, detectFormat } from "../registry/registry-helpers.js";
import { allocBuffer, extractChannel, fillBuffer } from "../../../engine/compositing/buffer-utils.js";

/* global DOMParser */

const LIF_NODE_TYPE = 112;
const LIF_MARKER_BYTE = 42;
const EXE_EMBEDDED_IMAGE_FORMATS = ["bmp", "png", "ico"];

function collectLifImageDataOffsets(bytes) {
  var offset = 8;
  var markerByte = bytes[offset];
  offset++;
  if (markerByte !== LIF_MARKER_BYTE) throw "lif: bad marker byte";
  var nameLength = BinaryUtils.readFloat32(bytes, offset);
  offset += 4;
  var svgMarkup = BinaryUtils.readStringLE(bytes, offset, nameLength);
  offset += nameLength * 2;
  var imageDataOffsets = [];
  while (offset < bytes.length) {
    var nodeTypeOrMarker = BinaryUtils.readFloat32(bytes, offset);
    offset += 4;
    if (nodeTypeOrMarker !== LIF_NODE_TYPE) throw nodeTypeOrMarker;
    offset += 4;
    nodeTypeOrMarker = bytes[offset];
    offset++;
    if (nodeTypeOrMarker !== LIF_MARKER_BYTE) throw nodeTypeOrMarker;
    var payloadSize = BinaryUtils.readFloat32(bytes, offset);
    offset += 4;
    var markerCheck = bytes[offset];
    offset++;
    if (markerCheck !== LIF_MARKER_BYTE) {
      offset -= 5;
      payloadSize = BinaryUtils.readFloat32(bytes, offset);
      offset += 8;
      nodeTypeOrMarker = bytes[offset];
      offset++;
      if (nodeTypeOrMarker !== LIF_MARKER_BYTE) throw nodeTypeOrMarker;
    }
    var dataBlockSize = BinaryUtils.readFloat32(bytes, offset) * 2;
    offset += 4;
    if (payloadSize > 0) imageDataOffsets.push(offset + dataBlockSize);
    offset += dataBlockSize + payloadSize;
  }
  return { svgMarkup: svgMarkup, imageDataOffsets: imageDataOffsets };
}

function readLifChannelPlane(bytes, dataOffset, width, height, bytesPerSample) {
  var channelBuffer = allocBuffer(width * height);
  if (bytesPerSample === 1) {
    for (var pixelIdx = 0; pixelIdx < channelBuffer.length; pixelIdx++) {
      channelBuffer[pixelIdx] = bytes[dataOffset + pixelIdx];
    }
  } else if (bytesPerSample === 2) {
    for (var pixelIdx = 0; pixelIdx < channelBuffer.length; pixelIdx++) {
      channelBuffer[pixelIdx] = Math.min(255, (bytes[dataOffset + pixelIdx * 2 + 1] << 8 | bytes[dataOffset + pixelIdx * 2]) >>> 2);
    }
  } else throw bytesPerSample;
  return channelBuffer;
}

function decodeLifImageNode(xmlNode, bytes, dataOffsets, layerFrames) {
  var contentNode = xmlNode.firstChild.firstChild;
  if (contentNode.tagName === "Image") {
    var imageDescription = contentNode.getElementsByTagName("ImageDescription")[0];
    var channelDefs = imageDescription.children[0].children;
    var dimensionDefs = imageDescription.children[1].children;
    var dataOffset = dataOffsets.shift();
    var elementCounts = [];
    for (var dimIdx = 0; dimIdx < dimensionDefs.length; dimIdx++) {
      elementCounts.push(parseInt(dimensionDefs[dimIdx].getAttribute("NumberOfElements")));
    }
    while (elementCounts.length > 3) elementCounts[2] *= elementCounts.pop();
    var channelCount = channelDefs.length;
    var width = elementCounts[0];
    var height = elementCounts[1];
    var sliceCount = elementCounts[2];
    var bytesPerSample = parseInt(dimensionDefs[0].getAttribute("BytesInc"));
    for (var sliceIdx = 0; sliceIdx < sliceCount; sliceIdx++) {
      var rgbaBuffer = allocBuffer(width * height * 4);
      fillBuffer(rgbaBuffer, 4278190080);
      for (var channelIdx = 0; channelIdx < channelCount; channelIdx++) {
        var channelBuffer = readLifChannelPlane(bytes, dataOffset, width, height, bytesPerSample);
        if (channelIdx !== 3) extractChannel(channelBuffer, rgbaBuffer, channelIdx);
        if (channelCount === 1) {
          extractChannel(channelBuffer, rgbaBuffer, 1);
          extractChannel(channelBuffer, rgbaBuffer, 2);
        }
        dataOffset += width * height * bytesPerSample;
      }
      layerFrames.push({
        rect: new Rect(0, 0, width, height),
        data: rgbaBuffer.buffer,
      });
    }
  } else {
    var childNodes = xmlNode.children;
    var childrenNodeIdx = 0;
    while (childrenNodeIdx < childNodes.length && childNodes[childrenNodeIdx].tagName !== "Children") {
      childrenNodeIdx++;
    }
    if (childrenNodeIdx === childNodes.length) throw "lif: child node index out of range";
    childNodes = childNodes[childrenNodeIdx].children;
    for (var childIdx = 0; childIdx < childNodes.length; childIdx++) {
      decodeLifImageNode(childNodes[childIdx], bytes, dataOffsets, layerFrames);
    }
  }
}

function decodeLifDocument(buffer) {
  var bytes = new Uint8Array(buffer);
  var lifPayload = collectLifImageDataOffsets(bytes);
  var domParser = new DOMParser();
  var svgDocumentRoot = domParser.parseFromString(lifPayload.svgMarkup, "image/svg+xml").firstChild.firstChild;
  var layerFrames = [];
  decodeLifImageNode(svgDocumentRoot, bytes, lifPayload.imageDataOffsets, layerFrames);
  return layerFrames;
}

function tryDecodeEmbeddedResourceImage(entryValue, resourcePath) {
  var detectedFormat = detectFormat(entryValue.buffer);
  if (!detectedFormat || EXE_EMBEDDED_IMAGE_FORMATS.indexOf(detectedFormat) === -1) return;
  var formatCodec = getFormat(detectedFormat);
  if (formatCodec.isLayered) return;
  var decodedFrames = null;
  try {
    decodedFrames = formatCodec.decode(entryValue.buffer);
  } catch (decodeError) {}
  if (!decodedFrames) return;
  decodedFrames[0].layerName = resourcePath[1];
  return decodedFrames[0];
}

function parsePeResourceTree(bytes, sectionBase, entryOffset, pathSegments, sectionBounds, extractedLayers) {
  BinaryUtils.readFloat32(bytes, entryOffset);
  BinaryUtils.readFloat32(bytes, entryOffset + 4);
  BinaryUtils.readFloat32(bytes, entryOffset + 8);
  var namedEntryCount = BinaryUtils.readUint16LE(bytes, entryOffset + 12);
  var idEntryCount = BinaryUtils.readUint16LE(bytes, entryOffset + 14);
  entryOffset += 16;
  var entries = {};
  for (var entryIdx = 0; entryIdx < namedEntryCount + idEntryCount; entryIdx++) {
    var keyOrId = BinaryUtils.readFloat32(bytes, entryOffset);
    var valueOrOffset = BinaryUtils.readFloat32(bytes, entryOffset + 4);
    var entryKey;
    var entryValue;
    if (keyOrId >>> 31 === 1) keyOrId = keyOrId & 16777215;
    if (entryIdx < namedEntryCount) {
      entryKey = BinaryUtils.readStringLE(bytes, sectionBase + keyOrId + 2, BinaryUtils.readUint16LE(bytes, sectionBase + keyOrId));
    } else entryKey = "id" + keyOrId;
    var childPath = pathSegments.slice(0);
    childPath.push(entryKey);
    if (valueOrOffset >>> 31 === 1) {
      valueOrOffset = valueOrOffset & 268435455;
      entryValue = parsePeResourceTree(bytes, sectionBase, sectionBase + valueOrOffset, childPath, sectionBounds, extractedLayers);
    } else {
      var resourceOffset = BinaryUtils.readFloat32(bytes, sectionBase + valueOrOffset);
      var resourceSize = BinaryUtils.readFloat32(bytes, sectionBase + valueOrOffset + 4);
      BinaryUtils.readFloat32(bytes, sectionBase + valueOrOffset + 8);
      var resourceFlags = BinaryUtils.readFloat32(bytes, sectionBase + valueOrOffset + 12);
      if (resourceFlags !== 0) throw "lif: unexpected resource flags";
      if (resourceOffset < sectionBounds[0] || resourceOffset > sectionBounds[0] + sectionBounds[1]) throw "lif: resource offset out of section";
      var absoluteDataOffset = sectionBounds[2] + resourceOffset - sectionBounds[0];
      entryValue = bytes.slice(absoluteDataOffset, absoluteDataOffset + resourceSize);
      var embeddedLayer = tryDecodeEmbeddedResourceImage(entryValue, childPath);
      if (embeddedLayer) extractedLayers.push(embeddedLayer);
    }
    entries[entryKey] = entryValue;
    entryOffset += 8;
  }
  return entries;
}

function decodeExeEmbeddedImages(buffer) {
  var extractedLayers = [];
  var bytes = new Uint8Array(buffer);
  var offset = 0;
  BinaryUtils.readUint16LE(bytes, offset);
  offset += 2;
  offset += 58;
  var peHeaderOffset = BinaryUtils.readFloat32(bytes, offset);
  offset += 4;
  offset = peHeaderOffset;
  BinaryUtils.readString(bytes, offset, 4);
  offset += 4;
  BinaryUtils.readUint16LE(bytes, offset);
  offset += 2;
  var sectionCount = BinaryUtils.readUint16LE(bytes, offset);
  offset += 2;
  BinaryUtils.readFloat32(bytes, offset);
  offset += 4;
  BinaryUtils.readFloat32(bytes, offset);
  offset += 4;
  BinaryUtils.readFloat32(bytes, offset);
  offset += 4;
  var optionalHeaderSize = BinaryUtils.readUint16LE(bytes, offset);
  offset += 2;
  BinaryUtils.readUint16LE(bytes, offset);
  offset += 2;
  offset += optionalHeaderSize;
  var sectionTable = {};
  for (var sectionIdx = 0; sectionIdx < sectionCount; sectionIdx++) {
    var nameEndOffset = offset;
    while (bytes[nameEndOffset] !== 0) nameEndOffset++;
    var sectionName = BinaryUtils.readString(bytes, offset, nameEndOffset - offset);
    var virtSize = BinaryUtils.readFloat32(bytes, offset + 8);
    var virtAddr = BinaryUtils.readFloat32(bytes, offset + 12);
    var rawDataSize = BinaryUtils.readFloat32(bytes, offset + 16);
    var rawDataOffset = BinaryUtils.readFloat32(bytes, offset + 20);
    var relocPtr = BinaryUtils.readFloat32(bytes, offset + 24);
    var lineNumPtr = BinaryUtils.readFloat32(bytes, offset + 28);
    BinaryUtils.readUint16LE(bytes, offset + 32);
    BinaryUtils.readUint16LE(bytes, offset + 34);
    BinaryUtils.readFloat32(bytes, offset + 36);
    sectionTable[sectionName] = [virtAddr, virtSize, rawDataOffset, rawDataSize];
    if (relocPtr + lineNumPtr !== 0) throw "lif: relocation table not empty";
    offset += 40;
  }
  for (var sectionName in sectionTable) {
    var sectionInfo = sectionTable[sectionName];
    offset = sectionInfo[2];
    if (sectionName === ".resources") {
      parsePeResourceTree(bytes, offset, offset, [], sectionInfo, extractedLayers);
    }
  }
  return extractedLayers;
}

export const lifCodec = {};
lifCodec.decode = decodeLifDocument;
lifCodec.decodeLifImageNode = decodeLifImageNode;

export const exeCodec = {};
exeCodec.decode = decodeExeEmbeddedImages;
