import { Matrix2D } from "../../../core/math/matrix2d.js";
import { Rect } from "../../../core/math/rect.js";
import { BinaryUtils } from "../../../core/binary/binary-utils.js";
import { RenderBuffer } from "../../../core/render-buffer.js";

import { ChannelImageCodec } from "./channel-image-codec.js";
import { DescriptorCodec } from "./descriptor-codec.js";
import { PathRecordCodec } from "./path-record-codec.js";
import { SwatchColorCodec } from "./swatch-color-codec.js";
import { PSDResourceParser } from "./psd-resource-parser.js";
import { LayerRecordParser } from "./layer-record-parser.js";
import {
  createDefaultSliceDescriptor,
  writeSliceBoundsToDescriptor,
} from "./slice-descriptor.js";
import { TrackerRegistry } from "../../../features/trackers/tracker-registry.js";
import { Document } from "../../model/document.js";
import { Layer, LayerSectionType } from "../../model/layer.js";
import { XMPData } from "../metadata/xmp-metadata.js";
import { LayerEffectDefs } from "./effect-defs.js";
import { TextEngineData } from "../../../features/text/text-engine.js";
import { TextLayerData } from "../../../features/text/engine-data.js";
import { EngineDataCodec } from "../../../features/text/engine-data-codec.js";
import { Mask, VectorMask } from "../../model/layer-masks.js";
import { PlanarRgbaBuffer, allocBuffer, extractChannel, fillBuffer, interleavedToPlanar } from "../../../engine/compositing/buffer-utils.js";
import { copyChannel, copyPixels, hasNonOpaquePixels } from "../../../engine/compositing/pixel-ops.js";
import { transformCoordPairs } from "../../../engine/compositing/anti-alias.js";
import { countSubpaths } from "../../../engine/compositing/path-records.js";
import { createForSubpaths } from "../../../engine/compositing/key-origins.js";


/**
 * PSD/PSB document reader and writer: file header, color mode data, image
 * resources, layer records, channel image data, and merged composite. Orchestrates
 * the channel, descriptor, layer-record, and resource parsers in this folder.
 */

const UTIF = globalThis.UTIF;

function readHeader(doc, data, pos) {
  const signature = BinaryUtils.readString(data, pos, 4);
  pos += 4;
  if (signature !== "8BPS") alert("invalid header signature: " + signature);
  const version = BinaryUtils.readUint16(data, pos);
  pos += 2;
  doc.isPSB = version === 2;
  if (version !== 1 && version !== 2) alert("invalid version: " + version);
  pos += 6;
  doc.channelCount = BinaryUtils.readUint16(data, pos);
  pos += 2;
  doc.height = BinaryUtils.readInt32BE(data, pos);
  pos += 4;
  doc.width = BinaryUtils.readInt32BE(data, pos);
  pos += 4;
  doc.bitDepth = BinaryUtils.readUint16(data, pos);
  pos += 2;
  doc.colorMode = BinaryUtils.readUint16(data, pos);
  pos += 2;
  return pos;
}

function writeHeader(doc, buf, pos, channelCount) {
  buf.ensureCapacity(0, 64);
  BinaryUtils.writeAsciiRaw(buf.data, pos, "8BPS");
  pos += 4;
  BinaryUtils.writeUint16Raw(buf.data, pos, doc.isPSB ? 2 : 1);
  pos += 2;
  BinaryUtils.writeUint32BE(buf.data, pos, 0);
  pos += 4;
  BinaryUtils.writeUint16Raw(buf.data, pos, 0);
  pos += 2;
  BinaryUtils.writeUint16Raw(buf.data, pos, channelCount);
  pos += 2;
  BinaryUtils.writeInt32BE(buf.data, pos, doc.height);
  pos += 4;
  BinaryUtils.writeInt32BE(buf.data, pos, doc.width);
  pos += 4;
  BinaryUtils.writeUint16Raw(buf.data, pos, 8);
  pos += 2;
  BinaryUtils.writeUint16Raw(buf.data, pos, 3);
  pos += 2;
  return pos;
}

function readColorModeData(doc, data, pos) {
  const dataLen = BinaryUtils.readInt32BE(data, pos);
  pos += 4;
  if (dataLen !== 0) doc.indexedColorTable = data.slice(pos, pos + dataLen);
  pos += dataLen;
  return pos;
}

function writeColorModeData(doc, buf, pos) {
  BinaryUtils.writeInt32(buf, pos, 0);
  pos += 4;
  return pos;
}

function readImageResources(doc, data, pos) {
  const totalSize = BinaryUtils.readUint32BE(data, pos);
  let offset = 0;
  pos += 4;
  const unknownResourceIds = [];
  while (offset < totalSize) {
    const signature = BinaryUtils.readString(data, pos + offset, 4);
    offset += 4;
    const resId = BinaryUtils.readUint16(data, pos + offset);
    offset += 2;
    const nameResult = BinaryUtils.readPascalString(data, pos + offset);
    offset += nameResult.length;
    if (signature !== "8BIM") {
      unknownResourceIds.push(resId);
      console.log("Unknown Image Resources signature: " + signature + ", ID: " + resId);
    }
    const resSize = BinaryUtils.readUint32BE(data, pos + offset);
    offset += 4;
    if (doc.resources["r" + resId] != null) console.log("--- two resources with same ID");
    doc.resources["r" + resId] = BinaryUtils.readBytes(data, pos + offset, resSize);
    offset += resSize + (resSize & 1);
  }
  for (let i = 0; i < unknownResourceIds.length; i++) {
    delete doc.resources["r" + unknownResourceIds[i]];
  }
  return pos + totalSize;
}

function writeImageResources(doc, buf, pos) {
  const sectionStart = pos;
  let offset = 0;
  pos += 4;
  const resIds = [];
  for (const key in doc.resources) {
    resIds.push(parseInt(key.slice(1)));
  }
  resIds.sort((a, b) => a - b);
  for (let i = 0; i < resIds.length; i++) {
    BinaryUtils.writeAscii(buf, pos + offset, "8BIM");
    offset += 4;
    const resId = resIds[i];
    BinaryUtils.writeUint16(buf, pos + offset, resId);
    offset += 2;
    const nameLen = BinaryUtils.writePascalString(buf, pos + offset, "");
    offset += nameLen;
    const resData = doc.resources["r" + resId];
    const dataLen = resData.length;
    BinaryUtils.writeSize(buf, pos + offset, dataLen);
    offset += 4;
    BinaryUtils.writeBytes(buf, pos + offset, resData);
    offset += dataLen;
    if (dataLen % 2 === 1) offset++;
  }
  BinaryUtils.writeSize(buf, sectionStart, offset);
  return pos + offset;
}

function readLayerAndMaskInfo(doc, data, pos) {
  const sectionStart = pos;
  let sectionSize;
  let tempPos;
  const sizeField = doc.isPSB ? 8 : 4;
  if (doc.isPSB) sectionSize = BinaryUtils.readInt64BE(data, pos);
  else sectionSize = BinaryUtils.readUint32BE(data, pos);
  pos += sizeField;
  if (sectionSize === 0) return sectionStart + sizeField;
  tempPos = readLayerInfo(doc, data, pos);
  pos = tempPos;
  tempPos = readGlobalLayerMask(doc, data, pos);
  pos = tempPos;
  tempPos = PSDResourceParser.parseAdditionalLayerInfo(
    data,
    pos,
    sectionStart + sizeField + sectionSize,
    doc.add,
    doc.isPSB,
    doc
  );
  pos = tempPos;
  return sectionStart + sizeField + sectionSize;
}

function writeLayerAndMaskInfo(doc, buf, pos, options, hasTransparency) {
  const sectionStart = pos;
  BinaryUtils.writeSize(buf, pos, 0);
  pos += 4;
  if (doc.isPSB) {
    BinaryUtils.writeSize(buf, pos, 0);
    pos += 4;
  }
  pos = writeLayerInfo(doc, buf, pos, options, hasTransparency);
  pos = writeGlobalLayerMask(doc, buf, pos);
  pos = PSDResourceParser.writeAdditionalLayerInfo(buf, pos, doc.add, doc.isPSB, doc);
  if (doc.isPSB) BinaryUtils.writeInt64BE(buf, sectionStart, pos - sectionStart - 8);
  else BinaryUtils.writeSize(buf, sectionStart, pos - sectionStart - 4);
  return pos;
}

function readLayerInfo(doc, data, pos) {
  let layerInfoSize;
  const sizeField = doc.isPSB ? 8 : 4;
  if (doc.isPSB) layerInfoSize = BinaryUtils.readInt64BE(data, pos);
  else layerInfoSize = BinaryUtils.readUint32BE(data, pos);
  pos += sizeField;
  if (layerInfoSize !== 0) readLayerList(doc, data, pos);
  return pos + layerInfoSize;
}

function readLayerList(doc, data, pos) {
  const rawCount = BinaryUtils.readInt16BE(data, pos);
  pos += 2;
  const layerCount = Math.abs(rawCount);
  for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) {
    const layer = new Layer();
    pos = LayerRecordParser.parse(layer, doc, data, pos);
    doc.layers[layerIndex] = layer;
  }
  const canvasRect = new Rect(0, 0, doc.width, doc.height);
  for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) {
    const layer = doc.layers[layerIndex];
    const layerMask = layer.getMask();
    const nextPos = ChannelImageCodec.parse(layer, doc, data, pos);
    pos = nextPos;
    clipOversizedLayer(layer, canvasRect);
    if (layerMask) clipOversizedLayer(layerMask, canvasRect);
  }
}

function clipOversizedLayer(layerOrMask, canvasRect) {
  const area = layerOrMask.rect.area();
  const clipped = layerOrMask.rect.intersect(canvasRect);
  const coverage = clipped.area() / area;
  if (area > 2000 * 3000 && coverage < 0.5) {
    if (layerOrMask.buffer) {
      const newBuf = allocBuffer(clipped.area() * 4);
      copyPixels(layerOrMask.buffer, layerOrMask.rect, newBuf, clipped);
      layerOrMask.buffer = newBuf;
      layerOrMask.rect = clipped;
    } else {
      const newBuf = allocBuffer(clipped.area());
      copyChannel(layerOrMask.channel, layerOrMask.rect, newBuf, clipped);
      layerOrMask.channel = newBuf;
      layerOrMask.rect = clipped;
    }
    alert("Removing hidden parts of layers");
  }
}

function writeLayerInfo(doc, buf, pos, options, hasTransparency) {
  const sectionStart = pos;
  const isPSB = doc.isPSB;
  pos += isPSB ? 8 : 4;
  pos = writeLayerList(doc, buf, pos, options, hasTransparency);
  let sectionSize = pos - sectionStart - (isPSB ? 8 : 4);
  if (sectionSize % 2 !== 0) sectionSize++;
  if (isPSB) BinaryUtils.writeInt64BE(buf, sectionStart, sectionSize);
  else BinaryUtils.writeSize(buf, sectionStart, sectionSize);
  return sectionStart + sectionSize + (isPSB ? 8 : 4);
}

function writeLayerList(doc, buf, pos, options, hasTransparency) {
  const layerCount = doc.layers.length;
  BinaryUtils.writeUint16(buf, pos, hasTransparency ? -layerCount : layerCount);
  pos += 2;
  const channelDataOffsets = [];
  for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) {
    pos = LayerRecordParser.write(
      doc.layers[layerIndex],
      doc,
      buf,
      pos,
      channelDataOffsets
    );
  }
  for (let layerIndex = 0; layerIndex < layerCount; layerIndex++) {
    pos = ChannelImageCodec.serialize(
      doc.isPSB,
      doc.layers[layerIndex],
      buf,
      pos,
      channelDataOffsets[layerIndex],
      options
    );
  }
  return pos;
}

function readGlobalLayerMask(doc, data, pos) {
  const maskSize = BinaryUtils.readUint32BE(data, pos);
  pos += 4;
  pos += maskSize;
  return pos;
}

function writeGlobalLayerMask(doc, buf, pos) {
  BinaryUtils.writeSize(buf, pos, 0);
  pos += 4;
  return pos;
}

function readImageData(doc, data, pos) {
  const colorMode = doc.colorMode;
  const colorModeNames = "Bitmap Grayscale Indexed RGB CMYK Multichannel Duotone Lab".split(" ");
  const componentCounts = [1, 1, 1, 3, 4, 1, 1, 3];
  let channelNames;
  let channelData;
  if (colorMode !== 3) {
    if (colorMode === 1 || colorMode === 2 || colorMode === 4) {
      alert(
        "Project will be converted from " +
          colorModeNames[colorMode] +
          " to " +
          colorModeNames[3] +
          " mode."
      );
    } else {
      alert("Color mode " + colorModeNames[colorMode] + " is not supported yet :(");
    }
  }
  if (doc.resources.r1045) {
    channelNames = [];
    const extraChData = doc.resources.r1045;
    let nameOffset = 0;
    while (nameOffset < extraChData.length) {
      const name = BinaryUtils.readUnicodeName(extraChData, nameOffset);
      channelNames.push(name);
      nameOffset += 4 + 2 + name.length * 2;
    }
  }
  const baseChannels =
    componentCounts[colorMode] +
    (channelNames == null || channelNames[0] === "Transparency" ? 1 : 0);
  const width = doc.width;
  const height = doc.height;
  const pixelCount = width * height;
  const compression = BinaryUtils.readUint16(data, pos);
  pos += 2;
  doc.buffer = allocBuffer(pixelCount * 4);
  fillBuffer(doc.buffer, 4278190080);
  const scanlineTableStart = pos;
  for (let channelIndex = 0; channelIndex < doc.channelCount; channelIndex++) {
    if (compression === 0) {
      channelData = ChannelImageCodec.decompressChannel(
        doc.isPSB,
        doc.bitDepth,
        data,
        width,
        height,
        pos,
        compression
      );
      pos += pixelCount * (doc.bitDepth >>> 3);
    } else if (compression === 1) {
      channelData = allocBuffer(pixelCount);
      const scanlineSize = doc.isPSB ? 4 : 2;
      if (channelIndex === 0) pos += doc.channelCount * height * scanlineSize;
      pos += ChannelImageCodec.decodePackBits(
        data,
        channelData,
        width,
        height,
        scanlineTableStart + channelIndex * height * scanlineSize,
        pos,
        scanlineSize
      );
    } else {
      console.log("unknown compression of image data: ", compression);
      return;
    }
    if (channelIndex < baseChannels) {
      extractChannel(channelData, doc.buffer, channelIndex);
      if (doc.channelCount === 1 && channelIndex === 0) {
        extractChannel(channelData, doc.buffer, 1);
        extractChannel(channelData, doc.buffer, 2);
      }
    } else {
      const extraMask = new Mask();
      const extraIdx = channelIndex - baseChannels;
      const nameIdx = channelIndex - componentCounts[doc.colorMode];
      extraMask.name = channelNames ? channelNames[nameIdx] : "Alpha";
      if (extraMask.name === "Quick Mask") {
        extraMask.active = true;
        doc.activeChannels.push(extraIdx);
      }
      extraMask.rect = new Rect(0, 0, width, height);
      extraMask.channel = channelData;
      extraMask.color = 0;
      extraMask.trimToContent();
      doc.extraChannels[extraIdx] = extraMask;
      if (doc.resources.r1077) {
        const extraChInfo = doc.resources.r1077.slice(4 + nameIdx * 13);
        extraMask.overlayTintRgb = SwatchColorCodec.readSwatchColorAt(extraChInfo, 0);
        extraMask.displayOpacity = extraChInfo[11];
        extraMask.indicatorFlags = extraChInfo[12];
        if (extraMask.indicatorFlags === 2) extraMask.active = true;
      }
    }
  }
  doc.channelCount = 4;
  if (doc.colorMode === 2) {
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
      const bufferOffset = pixelIndex * 4;
      const paletteIndex = doc.buffer[bufferOffset];
      doc.buffer[bufferOffset] = doc.indexedColorTable[0 + paletteIndex];
      doc.buffer[bufferOffset + 1] = doc.indexedColorTable[256 + paletteIndex];
      doc.buffer[bufferOffset + 2] = doc.indexedColorTable[512 + paletteIndex];
    }
  }
  return pos;
}

function writeImageData(doc, buf, pos, isGrayscale, hasTransparency) {
  const compression = 1;
  const width = doc.width;
  const height = doc.height;
  let planar;
  let grayBuf;
  BinaryUtils.writeUint16(buf, pos, compression);
  pos += 2;
  const pixelCount = width * height;
  if (!isGrayscale) {
    planar = new PlanarRgbaBuffer(pixelCount);
    interleavedToPlanar(doc.buffer, planar);
    const redChannel = planar.h;
    const greenChannel = planar.l;
    const blueChannel = planar.O;
    const alphaChannel = planar.w;
    for (let i = 0; i < pixelCount; i++) {
      const alpha = alphaChannel[i] * (1 / 255);
      redChannel[i] = ~~(redChannel[i] * alpha + 255 * (1 - alpha));
      greenChannel[i] = ~~(greenChannel[i] * alpha + 255 * (1 - alpha));
      blueChannel[i] = ~~(blueChannel[i] * alpha + 255 * (1 - alpha));
    }
  } else grayBuf = allocBuffer(pixelCount);
  let channels = [grayBuf, grayBuf, grayBuf];
  if (!isGrayscale) channels = [planar.h, planar.l, planar.O];
  if (hasTransparency) channels.push(isGrayscale ? grayBuf : planar.w);
  for (let i = 0; i < doc.extraChannels.length; i++) {
    channels.push(doc.extraChannels[i].rasterizeTo(new Rect(0, 0, doc.width, doc.height)));
  }
  const scanlineTableStart = pos;
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
    buf.ensureCapacity(pos, width * height + 4);
    const chData = channels[channelIndex];
    if (compression === 0 || compression === 2 || compression === 3) {
      pos = ChannelImageCodec.compressChannel(
        doc.isPSB,
        chData,
        buf.data,
        width,
        height,
        pos,
        compression
      );
    } else {
      const scanlineSize = doc.isPSB ? 4 : 2;
      if (channelIndex === 0) pos += channels.length * height * scanlineSize;
      pos += ChannelImageCodec.encodePackBits(
        chData,
        buf.data,
        width,
        height,
        scanlineTableStart + channelIndex * height * scanlineSize,
        pos,
        scanlineSize
      );
    }
  }
  return pos;
}

/** Ensures a background layer exists when the PSD has no layer records. */
function ensureBackgroundLayer(doc) {
  if (doc.layers.length === 0) {
    const backgroundLayer = doc.newLayer();
    backgroundLayer.setName("Background");
    doc.layers.push(backgroundLayer);
    backgroundLayer.buffer = doc.buffer.slice(0);
    backgroundLayer.rect = new Rect(0, 0, doc.width, doc.height);
  }
}

function applyDpiFromResources(doc) {
  if (doc.resources.r1005) {
    doc.dpi = BinaryUtils.readFixed16_16(doc.resources.r1005, 0);
  }
}

function applyGroupIndicesFromResources(doc) {
  if (doc.resources.r1026) {
    const groupData = doc.resources.r1026;
    for (let pairOffset = 0; pairOffset < groupData.length; pairOffset += 2) {
      const layer = doc.layers[pairOffset >>> 1];
      if (layer) layer.groupIndex = BinaryUtils.readUint16(groupData, pairOffset);
    }
  }
}

function applyGuidesFromResources(doc) {
  if (doc.resources.r1032) {
    const guideData = doc.resources.r1032;
    const guideCount = BinaryUtils.readUint32BE(guideData, 12);
    for (let guideIndex = 0; guideIndex < guideCount; guideIndex++) {
      const axis = guideData[16 + guideIndex * 5 + 4];
      const position = BinaryUtils.readInt32BE(guideData, 16 + guideIndex * 5) / 32;
      doc.guides[axis].push(position);
    }
  }
}

function applySlicesFromResources(doc) {
  delete doc.resources.r1036;
  delete doc.resources.r1039;
  if (!doc.resources.r1050) return;
  const readUint32 = BinaryUtils.readUint32BE;
  const sliceData = doc.resources.r1050;
  const sliceVersion = BinaryUtils.readUint32BE(sliceData, 0);
  if (sliceVersion === 6) {
    let slicePos = 4;
    BinaryUtils.readRect(sliceData, slicePos);
    slicePos += 16;
    const docName = BinaryUtils.readUnicodeString(sliceData, slicePos);
    slicePos += 4 + docName.length * 2;
    const sliceCount = readUint32(sliceData, slicePos);
    slicePos += 4;
    const slices = doc.slices;
    for (let sliceIndex = 0; sliceIndex < sliceCount; sliceIndex++) {
      const sliceDesc = createDefaultSliceDescriptor();
      let layerID;
      slices.push(sliceDesc);
      const sliceValue = sliceDesc.v;
      sliceValue.sliceID.v = readUint32(sliceData, slicePos);
      slicePos += 4;
      sliceValue.groupID.v = readUint32(sliceData, slicePos);
      slicePos += 4;
      const sliceOrigin = readUint32(sliceData, slicePos);
      slicePos += 4;
      if (sliceOrigin === 1) {
        layerID = readUint32(sliceData, slicePos);
        slicePos += 4;
      }
      const sliceName = BinaryUtils.readUnicodeString(sliceData, slicePos);
      slicePos += 4 + sliceName.length * 2;
      readUint32(sliceData, slicePos);
      slicePos += 4;
      const bounds = [
        readUint32(sliceData, slicePos),
        readUint32(sliceData, slicePos + 4),
        readUint32(sliceData, slicePos + 8),
        readUint32(sliceData, slicePos + 12),
      ];
      slicePos += 16;
      writeSliceBoundsToDescriptor(slices, slices.length - 1, bounds);
      const urlStr = (sliceValue.url.v = BinaryUtils.readUnicodeString(sliceData, slicePos));
      slicePos += 4 + urlStr.length * 2;
      const nullStr = (sliceValue.null.v = BinaryUtils.readUnicodeString(sliceData, slicePos));
      slicePos += 4 + nullStr.length * 2;
      const msgStr = (sliceValue.Msge.v = BinaryUtils.readUnicodeString(sliceData, slicePos));
      slicePos += 4 + msgStr.length * 2;
      const altStr = (sliceValue.altTag.v = BinaryUtils.readUnicodeString(sliceData, slicePos));
      slicePos += 4 + altStr.length * 2;
      sliceValue.cellTextIsHTML.v = sliceData[slicePos] === 1;
      slicePos++;
      const cellText = (sliceValue.cellText.v = BinaryUtils.readUnicodeString(sliceData, slicePos));
      slicePos += 4 + cellText.length * 2;
      readUint32(sliceData, slicePos);
      slicePos += 4;
      readUint32(sliceData, slicePos);
      slicePos += 4;
      slicePos += 4;
      if (sliceOrigin !== 2) slices.pop();
    }
  } else if (sliceVersion === 8) {
    const sliceDesc = {};
    DescriptorCodec.parseDescriptor(sliceData, sliceDesc, 8, false);
    const slices = (doc.slices = sliceDesc.slices.v);
    for (let sliceIndex = 0; sliceIndex < slices.length; sliceIndex++) {
      if (slices[sliceIndex].v.origin.v.ESliceOrigin !== "userGenerated") {
        slices.splice(sliceIndex, 1);
        sliceIndex--;
      }
    }
  }
}

function applyXmpFromResources(doc) {
  if (doc.resources.r1058) {
    const tiffData = doc.resources.r1058;
    const tiffPages = UTIF.decode(tiffData.buffer, {
      parseMN: false,
      debug: false,
    });
    XMPData.readExifMetadata(tiffPages[0], doc.xmpMetadata);
    delete doc.resources.r1058;
  }
  if (doc.resources.r1060) {
    const xmpText = BinaryUtils.readUtf8(doc.resources.r1060);
    XMPData.readXmpXml(xmpText, doc.xmpMetadata);
    delete doc.resources.r1060;
  }
}

function applyLayerCompsFromResources(doc) {
  if (doc.resources.r1065) {
    const layerCompData = doc.resources.r1065;
    doc.layerComps = {};
    DescriptorCodec.parseDescriptor(layerCompData, doc.layerComps, 4, false);
  }
}

function applySelectionFromResources(doc) {
  if (doc.resources.r1069) {
    const selectedLayerData = doc.resources.r1069;
    const selectedLayers = [];
    for (let dataOffset = 2; dataOffset < selectedLayerData.length; dataOffset += 4) {
      const lyid = BinaryUtils.readUint32BE(selectedLayerData, dataOffset);
      for (let searchLayerIndex = 0; searchLayerIndex < doc.layers.length; searchLayerIndex++) {
        const layer = doc.layers[searchLayerIndex];
        if (layer.add.lyid === lyid && layer.add.lsct !== 3) {
          selectedLayers.push(searchLayerIndex);
        }
      }
    }
    doc.selectedLayerIndices = selectedLayers;
  }
}

function applyPathsFromResources(doc) {
  if (doc.resources.r1025) {
    const workingPathData = doc.resources.r1025;
    delete doc.resources.r1025;
    const pathPoints = PathRecordCodec.readPathPoints(
      workingPathData,
      0,
      workingPathData.length,
      doc.width,
      doc.height
    );
    const vmask = new VectorMask();
    vmask.pathRecords = pathPoints;
    doc.paths[0] = Document.createPathEntry("Working Path", {
      vmsk: vmask,
    });
  }
  const pathNames = doc.add.pths;
  delete doc.add.pths;
  let pathKeyData = doc.resources.r3000;
  if (pathKeyData) {
    pathKeyData = {};
    DescriptorCodec.parseDescriptor(doc.resources.r3000, pathKeyData, 4, false);
    delete doc.resources.r3000;
  }
  for (let pathIdx = 0; pathIdx <= 997; pathIdx++) {
    const resKey = "r" + (2000 + pathIdx);
    const pathData = doc.resources[resKey];
    if (pathData == null) break;
    const pathPoints = PathRecordCodec.readPathPoints(
      pathData,
      0,
      pathData.length,
      doc.width,
      doc.height
    );
    const pathName = pathNames
      ? pathNames.pathList.v[pathIdx].v.pathUnicodeName.v
      : "Path " + pathIdx;
    const pathOrigins = pathKeyData
      ? pathKeyData.keyRootDescriptorList.v[pathIdx].v.keyDescriptorList.v
      : createForSubpaths(pathPoints);
    const vmask = new VectorMask();
    vmask.pathRecords = pathPoints;
    doc.paths[pathIdx + 1] = Document.createPathEntry(pathName, {
      vmsk: vmask,
      vogk: pathOrigins,
    });
    delete doc.resources[resKey];
  }
}

/** Applies image-resource blocks to document fields after binary read. */
function applyImageResourcesToDocument(doc) {
  applyDpiFromResources(doc);
  applyGroupIndicesFromResources(doc);
  applyGuidesFromResources(doc);
  applySlicesFromResources(doc);
  applyXmpFromResources(doc);
  applyLayerCompsFromResources(doc);
  applySelectionFromResources(doc);
  applyPathsFromResources(doc);
}

function resolveTextDocumentModel(doc) {
  const txt2Resource = doc.add.Txt2;
  let textDocModel = txt2Resource;
  if (textDocModel) {
    textDocModel = textDocModel.parsedTree;
    if (textDocModel._DocumentResources == null) {
      textDocModel = EngineDataCodec.expandEngineDataWire(textDocModel);
    }
  }
  if (txt2Resource && txt2Resource.parsedTree._DocumentResources != null) {
    const ignoredKeys =
      "_Type _FrameMatrix _TextOnPathTRange _PathData _FirstBaselineAlignment _LineOrientation _RowGutter _ColumnGutter".split(
        " ",
      );
    const textFrameResources = txt2Resource.parsedTree._DocumentResources._TextFrameSet._Resources;
    for (let frameResourceIndex = 0; frameResourceIndex < textFrameResources.length; frameResourceIndex++) {}
  }
  return textDocModel;
}

function hydrateTextLayerFromTxt2(layer, doc, textDocModel) {
  const textIndex = layer.add.TySh.textDescriptor.TextIndex.v;
  if (textIndex === -1) return;
  const engineData = layer.add.TySh.engineData;
  const textRange = TextEngineData.getBoxBounds(engineData);
  let defaultFontSize = engineData.ResourceDict.StyleSheetSet[0].StyleSheetData.FontSize;
  if (defaultFontSize == null) defaultFontSize = 12;
  const styleRuns = engineData.EngineDict.StyleRun.RunArray;
  for (let styleRunIndex = 0; styleRunIndex < styleRuns.length; styleRunIndex++) {
    const styleSheet = styleRuns[styleRunIndex].StyleSheet.StyleSheetData;
    if (styleSheet.FontSize == null) {
      if (styleSheet.BaselineDirection == null) {
        styleSheet.FontSize = Math.round((defaultFontSize * doc.dpi) / 72);
      }
    }
  }
  const paraRuns = engineData.EngineDict.ParagraphRun.RunArray;
  let docTextObjects = textDocModel._DocumentObjects._TextObjects;
  if (docTextObjects.length <= textIndex) {
    console.log("Txt2 incomplete");
    return;
  }
  const textObjectModel = docTextObjects[textIndex]._Model;
  docTextObjects = textObjectModel._ParagraphRun._RunArray;
  if (docTextObjects == null) docTextObjects = [];
  const paraRunCount = Math.min(docTextObjects.length, paraRuns.length);
  for (let paraRunIndex = 0; paraRunIndex < paraRunCount; paraRunIndex++) {
    const paraProps = paraRuns[paraRunIndex].ParagraphSheet.Properties;
    const paraSheetRes = textDocModel._DocumentResources._ParagraphSheetSet._Resources;
    let paraSheet = docTextObjects[paraRunIndex]._RunData._ParagraphSheet;
    if (typeof paraSheet === "string") {
      paraSheet = paraSheetRes[parseInt(paraSheet.slice(1))]._Resource;
    }
    const parentSheet =
      paraSheet._Parent == null
        ? paraSheet
        : paraSheetRes[parseInt(paraSheet._Parent.slice(1))]._Resource;
    let paraDirection = paraSheet._Features._ParagraphDirection;
    if (paraDirection == null) paraDirection = parentSheet._Features._ParagraphDirection;
    if (paraDirection) paraProps._Direction = parseInt(paraDirection.slice(1));
  }
  // Glyphs the Glyphs panel inserted directly: each run pins its characters to
  // a glyph id that no codepoint reaches.
  const alternateGlyphWire = textObjectModel._AlternateGlyphRun;
  if (alternateGlyphWire) {
    const alternateRunsWire = alternateGlyphWire._RunArray;
    const alternateGlyphRun = (engineData.EngineDict.AlternateGlyphRun = TextEngineData.createRunGroup());
    for (let runIndex = 0; runIndex < alternateRunsWire.length; runIndex++) {
      const runWire = alternateRunsWire[runIndex];
      const runData = {};
      const alternateSheet = runWire._RunData._AlternateGlyphSheet;
      if (alternateSheet) runData.Glyph = parseInt(alternateSheet._Glyph.slice(1));
      alternateGlyphRun.RunArray.push(runData);
      alternateGlyphRun.RunLengthArray.push(parseInt(runWire._Length.slice(1)));
    }
  }
  const docResources = textDocModel._DocumentResources;
  const frameResources = docResources._TextFrameSet._Resources;
  const frameResource = frameResources[textIndex]._Resource;
  const frameData = frameResource._Data;
  const textMatrix = new Matrix2D(1, 0, 0, 1, 0, 0);
  if (frameResource._0) {
    const offsetX = parseFloat(frameResource._0[0].slice(1));
    const offsetY = parseFloat(frameResource._0[1].slice(1));
    textMatrix.translate(offsetX, offsetY);
  }
  if (textRange) {
    textMatrix.translate(textRange[0], textRange[1]);
    TextEngineData.setBoxBounds(engineData, [
      0,
      0,
      textRange[2] - textRange[0],
      textRange[3] - textRange[1],
    ]);
  } else if (frameResource._Bezier && frameResource._Bezier._Points) {
    const bezierPts = frameResource._Bezier._Points;
    const bezierOffsetX = parseFloat(bezierPts[0].slice(1));
    const bezierOffsetY = parseFloat(bezierPts[1].slice(1));
    if (bezierOffsetX !== 0 || bezierOffsetY !== 0) {
      textMatrix.translate(bezierOffsetX, bezierOffsetY);
    }
  }
  if (frameResource._Data && frameResource._Data._FrameMatrix) {
    let frameMx = frameResource._Data._FrameMatrix;
    frameMx = frameMx.map((v) => parseFloat(v.slice(1)));
    textMatrix.concat(
      new Matrix2D(frameMx[0], frameMx[1], frameMx[2], frameMx[3], frameMx[4], frameMx[5])
    );
  }
  textMatrix.concat(layer.add.TySh.transform);
  layer.add.TySh.transform = textMatrix;
  const frameType =
    frameData && frameData._Type ? parseInt(frameData._Type.slice(1)) : 0;
  if (frameType === 2 || (frameType === 1 && frameData._PathData._Spacing === "i-3")) {
    const parseVal = (v) => parseFloat(v.slice(1));
    const bezierPoints = frameResource._Bezier._Points.map(parseVal);
    if (textRange) {
      transformCoordPairs(
        bezierPoints,
        new Matrix2D(1, 0, 0, 1, -textRange[0], -textRange[1]),
        bezierPoints
      );
    }
    const isReversed = frameData._PathData ? frameData._PathData._Reversed : false;
    engineData.Curve = {
      Points: bezierPoints,
      TextOnPathTRange: frameData._TextOnPathTRange.map(parseVal),
      Reversed: isReversed == null ? false : isReversed,
    };
    layer.add.TySh.add = {
      vmsk: new VectorMask(),
      vogk: null,
    };
    TextEngineData.syncVmskToCurve(layer.add.TySh);
  }
}

/** Post-binary layer normalization: names, masks, fills, text, smart filters. */
function finalizeLayersAfterPsdRead(doc, textDocModel) {
  let needsNameFix = false;
  let groupNesting = 0;
  let hasTextLayers = false;
  let allTextEmpty = true;

  for (let layerIndex = 0; layerIndex < doc.layers.length; layerIndex++) {
    const layer = doc.layers[layerIndex];
    const sectionType = layer.add.lsct;
    const vectorMask = layer.add.vmsk;
    let userMask = layer.getMask();
    if (sectionType === LayerSectionType.BoundingDivider) {
      groupNesting++;
      layer.add.lspf = 0;
    } else if (
      sectionType === LayerSectionType.OpenGroup ||
      sectionType === LayerSectionType.ClosedGroup
    ) {
      groupNesting--;
    }
    if (layer.name === "") {
      layer.name = "Layer " + (layerIndex + 1);
      needsNameFix = true;
    }
    if (needsNameFix && layer.isGroup() && layer.blendMode === "norm") {
      layer.blendMode = "pass";
    }
    if (layer.hasSmartFilters() && layer.getLinkedPlacedItem(doc).d) {
      const smartFilterContext = layer.getLinkedPlacedItem(doc);
      smartFilterContext.d.isEnabled = layer.add.placedData.filterFX.v.filterMaskEnable.v;
    }
    if (vectorMask && layer.hasFillContent()) {
      if (layer.add.vstk == null) {
        layer.add.vstk = LayerEffectDefs.getStrokeStyleDefault();
      } else {
        const dashSetKey = "strokeStyleLineDashSet";
        if (layer.add.vstk[dashSetKey] == null) {
          layer.add.vstk[dashSetKey] = LayerEffectDefs.getStrokeStyleDefault()[dashSetKey];
        }
      }
      layer.add.vstk.strokeStyleResolution.v = doc.dpi;
    }
    if (
      vectorMask &&
      (layer.add.vogk == null ||
        countSubpaths(vectorMask.pathRecords) !==
          layer.add.vogk.length)
    ) {
      layer.updateVectorOrigins();
    }
    if (layer.add.placedData && layer.rect.isEmpty()) {
      console.log("redrawing smart instance");
      layer.rasterizeSmartObject(doc);
    }
    if (userMask == null && layer.d != null) {
      if (layer.d.parametersApplied === false) {
        layer.d.parametersApplied = true;
        layer.warpData = layer.d.clone();
      }
    }
    userMask = layer.getMask();
    if (layer.parsedMaskParams) {
      const maskParams = layer.parsedMaskParams;
      if (userMask) {
        userMask.density = maskParams[0];
        userMask.feather = maskParams[1];
      }
      if (vectorMask) {
        vectorMask.density = maskParams[2];
        vectorMask.feather = maskParams[3];
      }
      layer.parsedMaskParams = null;
    }
    if (
      userMask != null &&
      vectorMask != null &&
      (userMask.feather + vectorMask.feather !== 0 ||
        userMask.density + vectorMask.density !== 2 * 255)
    ) {
      layer.invalidate(doc);
    } else if (vectorMask != null && !layer.hasFillContent()) {
      layer.invalidate();
    }
    const artboard = layer.add.artb;
    if (artboard && artboard.artboardBackgroundType == null) {
      artboard.artboardBackgroundType = {
        t: "long",
        v: 1,
      };
    }
    if (artboard && groupNesting !== 0) delete layer.add.artb;
    const strokeData = layer.add.vstk;
    if (
      layer.hasFillContent() &&
      (layer.rect.isEmpty() ||
        (vectorMask && vectorMask.feather !== 0) ||
        (strokeData &&
          !strokeData.fillEnabled.v &&
          (!strokeData.strokeEnabled.v || strokeData.strokeStyleLineWidth.v.val === 0)))
    ) {
      layer.renderFillContent(doc);
    }
    if (layer.add.TySh) {
      hasTextLayers = true;
      if (!layer.rect.isEmpty()) {
        allTextEmpty = false;
        layer.textHasEmbeddedBuffer = true;
      }
    }
    if (layer.add.TySh && textDocModel) {
      hydrateTextLayerFromTxt2(layer, doc, textDocModel);
    }
  }
}

/** Hydrates document state after all PSD binary sections are read. */
function hydrateDocumentAfterPsdRead(doc) {
  ensureBackgroundLayer(doc);
  applyImageResourcesToDocument(doc);
  delete doc.isPSB;
  const textDocModel = resolveTextDocumentModel(doc);
  finalizeLayersAfterPsdRead(doc, textDocModel);
  TrackerRegistry.LayerCompTracker.offsetAllCompOrigins(doc, true);
}

const PATH_RESOURCE_IDS = [
  1025, 2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012, 2013,
  2014, 2015, 2016,
];

function buildDpiResource(doc) {
  doc.resources.r1005 = new Uint8Array([
    0, 0, 0, 0, 0, 1, 0, 2, 0, 0, 0, 0, 0, 1, 0, 2,
  ]);
  BinaryUtils.writeFixed16_16Raw(doc.resources.r1005, 0, doc.dpi);
  BinaryUtils.writeFixed16_16Raw(doc.resources.r1005, 8, doc.dpi);
}

function buildQuickMaskResource(doc) {
  if (doc.getQuickMask()) {
    doc.resources.r1022 = new Uint8Array([0, 3 + doc.extraChannels.length - 1, 0]);
  } else delete doc.resources.r1022;
}

function buildGroupIndexResource(doc) {
  doc.resources.r1026 = new Uint8Array(doc.layers.length * 2);
  for (let layerIndex = 0; layerIndex < doc.layers.length; layerIndex++) {
    BinaryUtils.writeUint16Raw(doc.resources.r1026, layerIndex * 2, doc.layers[layerIndex].groupIndex);
  }
}

function buildGuidesResource(doc) {
  const guides = doc.guides;
  const totalGuides = guides[0].length + guides[1].length;
  const guideRes = (doc.resources.r1032 = allocBuffer(16 + 5 * totalGuides, true));
  BinaryUtils.writeUint32BE(guideRes, 0, 1);
  BinaryUtils.writeUint32BE(guideRes, 4, 576);
  BinaryUtils.writeUint32BE(guideRes, 8, 576);
  BinaryUtils.writeUint32BE(guideRes, 12, totalGuides);
  let guideOffset = 16;
  for (let axis = 0; axis < 2; axis++) {
    for (let guideIndex = 0; guideIndex < guides[axis].length; guideIndex++) {
      BinaryUtils.writeInt32BE(guideRes, guideOffset, Math.round(guides[axis][guideIndex] * 32));
      guideRes[guideOffset + 4] = axis;
      guideOffset += 5;
    }
  }
}

function buildExtraChannelResources(doc, extraChannels) {
  delete doc.resources.r1045;
  delete doc.resources.r1006;
  delete doc.resources.r1077;
  const chNameBuf = new RenderBuffer();
  let nameOffset = 0;
  const chInfoBuf = new Uint8Array(4 + extraChannels.length * 13);
  chInfoBuf[3] = 1;
  for (let channelIndex = 0; channelIndex < extraChannels.length; channelIndex++) {
    const extraCh = extraChannels[channelIndex];
    const chName = extraCh.name + "\0";
    BinaryUtils.writeUnicodeString(chNameBuf, nameOffset, chName);
    nameOffset += 4 + chName.length * 2;
    const infoOffset = 4 + channelIndex * 13;
    SwatchColorCodec.writeSwatchColorAt(chInfoBuf, infoOffset, extraCh.overlayTintRgb);
    chInfoBuf[infoOffset + 11] = extraCh.displayOpacity;
    chInfoBuf[infoOffset + 12] = extraCh.indicatorFlags;
  }
  doc.resources.r1045 = chNameBuf.data.slice(0, nameOffset);
  doc.resources.r1077 = chInfoBuf;
}

function buildSliceResource(doc) {
  for (let sliceIndex = 0; sliceIndex < doc.slices.length; sliceIndex++) {
    doc.slices[doc.slices.length - sliceIndex - 1].v.sliceID.v = 2 + sliceIndex * 3;
  }
  const sliceDescriptor = {
    classID: "null",
    baseName: {
      t: "TEXT",
      v: "User",
    },
    bounds: {
      t: "Objc",
      v: {
        classID: "Rct1",
        Top: { t: "long", v: 0 },
        Left: { t: "long", v: 0 },
        Btom: { t: "long", v: 0 },
        Rght: { t: "long", v: 0 },
      },
    },
    slices: {
      t: "VlLs",
      v: doc.slices,
    },
  };
  const sliceBuf = new RenderBuffer();
  BinaryUtils.writeSize(sliceBuf, 0, 8);
  BinaryUtils.writeSize(sliceBuf, 4, 16);
  const descriptorSize = DescriptorCodec.writeDescriptor(sliceBuf, sliceDescriptor, 8);
  doc.resources.r1050 = sliceBuf.data.slice(0, descriptorSize + 8);
}

function buildLayerCompResource(doc) {
  const layerCompBuf = new RenderBuffer();
  BinaryUtils.writeSize(layerCompBuf, 0, 16);
  const descriptorSize = DescriptorCodec.writeDescriptor(layerCompBuf, doc.layerComps, 4);
  doc.resources.r1065 = layerCompBuf.data.slice(0, descriptorSize + 4);
}

function buildSelectionResource(doc) {
  const selectedLayers = doc.selectedLayerIndices;
  const guideRes = (doc.resources.r1069 = allocBuffer(
    2 + selectedLayers.length * 4,
    true
  ));
  BinaryUtils.writeUint16Raw(guideRes, 0, selectedLayers.length);
  for (let layerIndex = 0; layerIndex < selectedLayers.length; layerIndex++) {
    BinaryUtils.writeUint32BE(
      guideRes,
      2 + 4 * layerIndex,
      doc.layers[selectedLayers[layerIndex]].add.lyid
    );
  }
}

function buildXmpResources(doc, options) {
  delete doc.resources.r1058;
  delete doc.resources.r1060;
  if (Object.keys(doc.xmpMetadata).length === 0) return;
  const tiffIFDs = [
    {
      t274: [1],
      t282: [[72, 1]],
      t283: [[72, 1]],
      t296: [2],
    },
    {
      t259: [6],
      t282: [[72, 1]],
      t283: [[72, 1]],
      t296: [2],
      t513: [302],
      t514: [0],
    },
  ];
  XMPData.writeExifMetadata(doc.xmpMetadata, tiffIFDs[0], options[0] && options[1]);
  doc.resources.r1058 = new Uint8Array(UTIF.encode(tiffIFDs));
  const xmpText = XMPData.writeXmpXml(doc.xmpMetadata);
  doc.resources.r1060 = BinaryUtils.encodeUtf8(xmpText);
}

function buildPathResources(doc) {
  const pathNames = [];
  const pathKeyDescs = [];
  for (let pathIndex = 0; pathIndex < doc.paths.length; pathIndex++) {
    const pathEntry = doc.paths[pathIndex];
    const pathPoints = pathEntry.add.vmsk.pathRecords;
    if (pathIndex === 0 && pathPoints.length === 2) continue;
    const pathBuf = allocBuffer(pathPoints.length * 26);
    PathRecordCodec.writePathPoints(pathBuf, 0, pathPoints, doc.width, doc.height);
    const resId = pathIndex === 0 ? 1025 : 2000 + pathIndex - 1;
    doc.resources["r" + resId] = pathBuf;
    if (pathIndex !== 0) {
      pathNames.push({
        t: "Objc",
        v: {
          classID: "pathInfoClass",
          pathUnicodeName: {
            t: "TEXT",
            v: pathEntry.name,
          },
        },
      });
      pathKeyDescs.push({
        t: "Objc",
        v: {
          classID: "null",
          keyDescriptorList: {
            t: "VlLs",
            v: pathEntry.add.vogk,
          },
        },
      });
    }
  }
  if (pathNames.length !== 0) {
    doc.add.pths = {
      classID: "pathsDataClass",
      pathList: {
        t: "VlLs",
        v: pathNames,
      },
    };
    const pathKeyDescriptor = {
      classID: "null",
      keyRootDescriptorList: {
        t: "VlLs",
        v: pathKeyDescs,
      },
    };
    const pathKeyBuf = new RenderBuffer();
    BinaryUtils.writeSize(pathKeyBuf, 0, 16);
    const descriptorSize = DescriptorCodec.writeDescriptor(pathKeyBuf, pathKeyDescriptor, 4);
    doc.resources.r3000 = pathKeyBuf.data.slice(0, descriptorSize + 4);
  } else {
    delete doc.add.pths;
    delete doc.resources.r3000;
  }
}

/**
 * Prepares document resources and layer state before binary PSD write.
 * @returns {{ savedLayerBounds: Array, savedMeta: Array, extraChannels: Array, hasTransparency: boolean, writePos: number }}
 */
function beginPsdSerialize(doc, options) {
  TrackerRegistry.LayerCompTracker.ensureDefaultCompCaptured(doc);
  TrackerRegistry.LayerCompTracker.offsetAllCompOrigins(doc, false);
  doc.isPSB = options[3] === true;

  const textEngineDataList = [];
  const savedLayerBounds = [];

  for (let layerIndex = 0; layerIndex < doc.layers.length; layerIndex++) {
    const layer = doc.layers[layerIndex];
    if (layer.hasSmartFilters() && layer.getLinkedPlacedItem(doc).d) {
      layer.add.placedData.filterFX.v.filterMaskEnable.v =
        layer.getLinkedPlacedItem(doc).d.isEnabled;
    }
    if (layer.add.TySh) {
      const engineData = layer.add.TySh.engineData;
      const textFrameType = TextEngineData.getTextType(engineData);
      layer.add.TySh.textDescriptor.TextIndex = {
        t: "long",
        v: textEngineDataList.length,
      };
      textEngineDataList.push(engineData);
      if (textFrameType === 2) TextEngineData.syncCurveToVmsk(layer.add.TySh);
    }
    const strokeData = layer.add.vstk;
    if (strokeData) strokeData.strokeStyleResolution.v = doc.dpi;
    if (layer.hasFillContent() || (options[2] && layer.add.placedData)) {
      savedLayerBounds[layerIndex] = [layer.rect, layer.buffer];
      layer.rect = new Rect();
      layer.buffer = allocBuffer(0);
    }
  }

  if (textEngineDataList.length > 0) {
    const existingTxt2 = doc.add.Txt2 ? doc.add.Txt2.parsedTree : null;
    doc.add.Txt2 = {};
    doc.add.Txt2.parsedTree = TextLayerData.buildTxt2DocumentBlock(
      textEngineDataList,
      existingTxt2
    );
  }

  const savedMeta = { links: doc.add.lnk2, placedItems: doc.add.FEid, patterns: doc.add.Patt };
  const linkedResources = doc.filterLinkedResources(doc.layers);
  doc.setMeta(linkedResources);

  buildDpiResource(doc);
  buildQuickMaskResource(doc);
  buildGroupIndexResource(doc);
  buildGuidesResource(doc);

  const hasTransparency = hasNonOpaquePixels(doc.buffer);
  let extraChannels = [];
  if (hasTransparency) {
    extraChannels.push({
      name: "Transparency",
      overlayTintRgb: {
        h: 255,
        l: 0,
        O: 0,
      },
      displayOpacity: 100,
      indicatorFlags: 1,
    });
  }
  extraChannels = extraChannels.concat(doc.extraChannels);

  buildExtraChannelResources(doc, extraChannels);
  buildSliceResource(doc);
  buildLayerCompResource(doc);
  buildSelectionResource(doc);
  buildXmpResources(doc, options);
  buildPathResources(doc);

  return {
    savedLayerBounds,
    savedMeta,
    extraChannels,
    hasTransparency,
    writePos: 0,
  };
}

/** Restores layer buffers and document metadata after binary PSD write. */
function restoreAfterPsdSerialize(doc, options, savedLayerBounds, savedMeta) {
  for (let i = 0; i < PATH_RESOURCE_IDS.length; i++) {
    delete doc.resources["r" + PATH_RESOURCE_IDS[i]];
  }
  for (let layerIndex = 0; layerIndex < doc.layers.length; layerIndex++) {
    const layer = doc.layers[layerIndex];
    if (layer.hasFillContent() || (options[2] && layer.add.placedData)) {
      layer.rect = savedLayerBounds[layerIndex][0];
      layer.buffer = savedLayerBounds[layerIndex][1];
    }
  }
  doc.setMeta(savedMeta);
  TrackerRegistry.LayerCompTracker.offsetAllCompOrigins(doc, true);
  delete doc.isPSB;
}

function PSDParser() {}

PSDParser.readHeader = readHeader;
PSDParser.writeHeader = writeHeader;
PSDParser.readColorModeData = readColorModeData;
PSDParser.writeColorModeData = writeColorModeData;
PSDParser.readImageResources = readImageResources;
PSDParser.writeImageResources = writeImageResources;
PSDParser.readLayerAndMaskInfo = readLayerAndMaskInfo;
PSDParser.writeLayerAndMaskInfo = writeLayerAndMaskInfo;
PSDParser.readLayerInfo = readLayerInfo;
PSDParser.readLayerList = readLayerList;
PSDParser.writeLayerInfo = writeLayerInfo;
PSDParser.writeLayerList = writeLayerList;
PSDParser.readGlobalLayerMask = readGlobalLayerMask;
PSDParser.writeGlobalLayerMask = writeGlobalLayerMask;
PSDParser.readImageData = readImageData;
PSDParser.writeImageData = writeImageData;
PSDParser.clipOversizedLayer = clipOversizedLayer;

PSDParser.parse = function (rawBuffer, doc) {
  doc.isPSB = false;
  doc.bitDepth = 8;
  const data = new Uint8Array(rawBuffer);
  let sectionStart = 0;
  let sectionEnd = 0;

  sectionEnd = PSDParser.readHeader(doc, data, sectionStart);
  sectionStart = sectionEnd;

  sectionEnd = PSDParser.readColorModeData(doc, data, sectionStart);
  sectionStart = sectionEnd;

  sectionEnd = PSDParser.readImageResources(doc, data, sectionStart);
  sectionStart = sectionEnd;

  sectionEnd = PSDParser.readLayerAndMaskInfo(doc, data, sectionStart);
  sectionStart = sectionEnd;

  sectionEnd = PSDParser.readImageData(doc, data, sectionStart);

  hydrateDocumentAfterPsdRead(doc);
};

PSDParser.serialize = function (doc, buf, options) {
  const { savedLayerBounds, savedMeta, extraChannels, hasTransparency, writePos } =
    beginPsdSerialize(doc, options);
  let pos = writePos;

  pos = PSDParser.writeHeader(doc, buf, pos, 3 + extraChannels.length);
  pos = PSDParser.writeColorModeData(doc, buf, pos);
  pos = PSDParser.writeImageResources(doc, buf, pos);
  pos = PSDParser.writeLayerAndMaskInfo(doc, buf, pos, options, hasTransparency);
  pos = PSDParser.writeImageData(doc, buf, pos, options[0], hasTransparency);

  restoreAfterPsdSerialize(doc, options, savedLayerBounds, savedMeta);
  return pos;
};

// Register readLayerList on PSDResourceParser so parseAdditionalLayerInfo can handle the
// "Lr16" tag without importing this module (would create an import cycle).
PSDResourceParser.layerRecordHandler = PSDParser.readLayerList;

export { PSDParser };
