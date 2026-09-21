/**
 * PSD layer record (de)serializer: fixed header, channel table, blend mode,
 * opacity, flags, mask data, blend ranges, name, and additional layer info.
 */
/* global alert */
import { BinaryUtils } from "../../../core/binary/binary-utils.js";

import { PSDResourceParser } from "./psd-resource-parser.js";
import { Layer } from "../../model/layer.js";
import { Mask } from "../../model/layer-masks.js";

function parse(layer, context, buf, pos) {
  return readLayerRecord(layer, context, buf, pos);
}

function write(layer, context, buf, pos, channelDataOffsets) {
  return writeLayerRecord(layer, context, buf, pos, channelDataOffsets);
}

function readLayerRecord(layer, context, buf, pos) {
  layer.rect = BinaryUtils.readRect(buf, pos);
  pos += 16;
  var channelCount = BinaryUtils.readUint16(buf, pos);
  pos += 2;
  layer.channelInfo = [];
  var isPSB = context.isPSB;
  for (var i = 0; i < channelCount; i++) {
    layer.channelInfo[i] = {
      id: BinaryUtils.readInt16BE(buf, pos),
      length: (isPSB ? BinaryUtils.readInt64BE : BinaryUtils.readUint32BE)(buf, pos + 2),
    };
    pos += isPSB ? 10 : 6;
  }
  var sig = BinaryUtils.readString(buf, pos, 4);
  pos += 4;
  if (sig != "8BIM") {
    console.log("Invalid Blend mode signature: " + sig);
    alert("Error in Photoshop file: wrong signature.");
    throw "psd-layer: invalid blend-mode signature";
  }
  layer.blendMode = BinaryUtils.readString(buf, pos, 4);
  pos += 4;
  layer.Opct = buf[pos];
  pos += 1;
  layer.isClippingMask = buf[pos] == 1;
  pos += 1;
  layer.layerFlags = buf[pos];
  pos += 1;
  if (buf[pos] != 0) console.log("error in filler!");
  pos += 1;
  var extraDataLength = BinaryUtils.readUint32BE(buf, pos);
  pos += 4;
  var extraDataStart = pos;
  pos = readMaskData(layer, buf, pos);
  pos = readBlendRanges(layer, buf, pos);
  var nameResult = BinaryUtils.readPascalString(buf, pos);
  layer.name = nameResult.str;
  pos += nameResult.length;
  if (nameResult.length % 4 != 0) pos += 4 - nameResult.length % 4;
  pos = PSDResourceParser.parseAdditionalLayerInfo(buf, pos, extraDataStart + extraDataLength, layer.add, isPSB, context);
  if (layer.add.lsct) {
    if (layer.add.lsct.blendMode) layer.blendMode = layer.add.lsct.blendMode;
    layer.add.lsct = layer.add.lsct.type;
  }
  return pos;
}

function writeLayerRecord(layer, context, buf, pos, channelDataOffsets) {
  BinaryUtils.writePsdRect(buf, pos, layer.rect);
  pos += 16;
  var channelIds = layer.getChannelIds();
  BinaryUtils.writeUint16(buf, pos, channelIds.length);
  pos += 2;
  var isPSB = context.isPSB;
  channelDataOffsets.push(pos);
  for (var i = 0; i < channelIds.length; i++) {
    BinaryUtils.writeUint16(buf, pos, channelIds[i]);
    if (isPSB) BinaryUtils.writeInt64BE(buf, pos + 2, 0);
    else BinaryUtils.writeSize(buf, pos + 2, 0);
    pos += isPSB ? 10 : 6;
  }
  BinaryUtils.writeAscii(buf, pos, "8BIM");
  pos += 4;
  BinaryUtils.writeAscii(buf, pos, layer.blendMode);
  pos += 4;
  BinaryUtils.fillBytes(buf, pos, layer.Opct, 1);
  pos += 1;
  BinaryUtils.fillBytes(buf, pos, layer.isClippingMask ? 1 : 0, 1);
  pos += 1;
  BinaryUtils.fillBytes(buf, pos, layer.layerFlags, 1);
  pos += 1;
  BinaryUtils.fillBytes(buf, pos, 0, 1);
  pos += 1;
  var extraDataLengthPos = pos;
  BinaryUtils.writeSize(buf, pos, 0);
  pos += 4;
  var extraDataStart = pos;
  pos = writeMaskData(layer, buf, pos);
  pos = writeBlendRanges(layer, buf, pos);
  var nameLen = BinaryUtils.writePascalString(buf, pos, (layer.name || "").slice(0, 255));
  pos += nameLen;
  if (nameLen % 4 != 0) pos += 4 - nameLen % 4;
  if (layer.add.lsct) {
    layer.add.lsct = { type: layer.add.lsct };
    if (layer.blendMode == "pass") {
      layer.add.lsct.blendMode = "pass";
      layer.blendMode = "norm";
    }
  }
  if (layer.blendMode == "pass") layer.add.lsct = { type: layer.add.lsct, blendMode: "pass" };
  if (layer.add.brit) layer.add.CgEd = layer.add.brit;
  pos = PSDResourceParser.writeAdditionalLayerInfo(buf, pos, layer.add, isPSB, context);
  delete layer.add.CgEd;
  if (layer.add.lsct) {
    if (layer.add.lsct.blendMode) layer.blendMode = layer.add.lsct.blendMode;
    layer.add.lsct = layer.add.lsct.type;
  }
  var extraDataSize = pos - extraDataStart;
  BinaryUtils.writeSize(buf, extraDataLengthPos, extraDataSize);
  return pos;
}

function readMaskData(layer, buf, pos) {
  var maskDataSize = BinaryUtils.readUint32BE(buf, pos);
  pos += 4;
  if (maskDataSize == 0) return pos;
  var maskDataStart = pos;
  layer.d = new Mask;
  layer.d.rect = BinaryUtils.readRect(buf, pos);
  pos += 16;
  layer.d.color = buf[pos];
  pos += 1;
  var hasParams = readMaskFlags(layer.d, buf, pos);
  pos += 1;
  if (hasParams) {
    readMaskParams(layer, buf, pos);
  } else if (maskDataSize == 20) {
    pos += 2;
  } else {
    layer.warpData = readExtraMask(buf, pos);
    pos += 18;
  }
  return maskDataStart + maskDataSize;
}

/** Read the optional per-mask parameter block (warp mask, density, feather). */
function readMaskParams(layer, buf, pos) {
  var defaultDensity = 255;
  var defaultFeather = 0;
  var vectorDensity = 255;
  var vectorFeather = 0;
  var hasWarpMask = false;
  for (var i = 0; i < layer.channelInfo.length; i++) {
    if (layer.channelInfo[i].id == -3) hasWarpMask = true;
  }
  if (hasWarpMask) {
    layer.warpData = readExtraMask(buf, pos);
    pos += 18;
  }
  var paramFlagsPos = pos;
  var paramFlags = buf[pos];
  pos++;
  if (paramFlags >> 0 & 1) {
    defaultDensity = buf[pos];
    pos++;
  }
  if (paramFlags >> 1 & 1) {
    defaultFeather = BinaryUtils.readFloat64BE(buf, pos);
    pos += 8;
  }
  if (paramFlags >> 2 & 1) {
    vectorDensity = buf[pos];
    pos++;
  }
  if (paramFlags >> 3 & 1) {
    vectorFeather = BinaryUtils.readFloat64BE(buf, pos);
    pos += 8;
  }
  if ((pos - paramFlagsPos & 1) == 1) pos++;
  layer.parsedMaskParams = [defaultDensity, defaultFeather, vectorDensity, vectorFeather];
}

function writeMaskData(layer, buf, pos) {
  BinaryUtils.writeSize(buf, pos, 0);
  pos += 4;
  if (layer.d == null) return pos;
  var userMask = layer.getMask();
  var vectorMask = layer.add.vmsk;
  var maskDataStart = pos;
  var hasParams = true;
  BinaryUtils.writeSize(buf, pos, 0);
  BinaryUtils.writePsdRect(buf, pos, layer.d.rect);
  pos += 16;
  BinaryUtils.fillBytes(buf, pos, layer.d.color);
  pos += 1;
  writeMaskFlags(layer.d, buf, pos, hasParams);
  pos += 1;
  if (hasParams) {
    if (layer.warpData) {
      writeExtraMask(buf, pos, layer.warpData);
      pos += 18;
    }
    BinaryUtils.fillBytes(buf, pos, 15);
    pos += 1;
    BinaryUtils.fillBytes(buf, pos, userMask ? userMask.density : 255);
    pos += 1;
    BinaryUtils.writeFloat64BE(buf, pos, userMask ? userMask.feather : 0);
    pos += 8;
    BinaryUtils.fillBytes(buf, pos, vectorMask ? vectorMask.density : 255);
    pos += 1;
    BinaryUtils.writeFloat64BE(buf, pos, vectorMask ? vectorMask.feather : 0);
    pos += 8;
    pos++;
  }
  BinaryUtils.writeSize(buf, maskDataStart - 4, pos - maskDataStart);
  return pos;
}

function readExtraMask(buf, pos) {
  var mask = new Mask;
  readMaskFlags(mask, buf, pos);
  pos += 1;
  mask.color = buf[pos];
  pos += 1;
  mask.rect = BinaryUtils.readRect(buf, pos);
  pos += 16;
  return mask;
}

function writeExtraMask(buf, pos, mask) {
  writeMaskFlags(mask, buf, pos, false);
  pos += 1;
  BinaryUtils.fillBytes(buf, pos, mask.color);
  pos += 1;
  BinaryUtils.writePsdRect(buf, pos, mask.rect);
  pos += 16;
}

function readMaskFlags(mask, buf, pos) {
  var flags = buf[pos];
  mask.enabled = (flags >> 0 & 1) == 0;
  mask.isEnabled = (flags >> 1 & 1) == 0;
  mask.parametersApplied = (flags >> 3 & 1) == 1;
  return flags >> 4 & 1;
}

function writeMaskFlags(mask, buf, pos, hasParams) {
  var flags = 0;
  if (!mask.enabled) flags += 1 << 0;
  if (!mask.isEnabled) flags += 1 << 1;
  if (mask.parametersApplied) flags += 1 << 3;
  if (hasParams) flags += 1 << 4;
  BinaryUtils.fillBytes(buf, pos, flags);
}

function readBlendRanges(layer, buf, pos) {
  var dataSize = BinaryUtils.readUint32BE(buf, pos);
  pos += 4;
  if (dataSize == 0) return pos;
  if (dataSize != 5 * 8) console.log("unexpected Layer Blending Ranges content, size:", dataSize);
  for (var i = 0; i < dataSize; i++) layer.blendIfData[i] = buf[pos + i];
  return pos + 40;
}

function writeBlendRanges(layer, buf, pos) {
  BinaryUtils.writeSize(buf, pos, layer.blendIfData.length);
  pos += 4;
  buf.ensureCapacity(pos, 40);
  for (var i = 0; i < 40; i++) buf.data[pos + i] = layer.blendIfData[i];
  return pos + 40;
}

const LayerRecordParser = {
  parse,
  write,
  readLayerRecord,
  writeLayerRecord,
  readMaskData,
  writeMaskData,
  readExtraMask,
  writeExtraMask,
  readMaskFlags,
  writeMaskFlags,
  readBlendRanges,
  writeBlendRanges,
};

export { LayerRecordParser };
