import { Point } from "../../../core/math/point.js";
import { Rect } from "../../../core/math/rect.js";
import { BinaryUtils } from "../../../core/binary/binary-utils.js";
import { polygonFromFlatCoords } from "../../../engine/compositing/shape-primitives.js";

/**
 * Codec for vector path-record geometry: the 26-byte knot records that describe
 * pen paths, vector masks, and custom-shape outlines. The PSD parsers, the JPEG
 * clipping-path reader, and the pen/shape tools all share this; the .csh shape
 * library file format that builds on it lives in features/shape/.
 */

/** Bytes per path knot in PSD path resource blocks. */
const PATH_KNOT_BYTE_LENGTH = 26;

/** Namespace for PSD path knot read/write and shape-library round-trip. */
function PathRecordCodec() {}

PathRecordCodec.create = function () {
  return {
    boundsRect: new Rect(0, 0, 50, 50),
    shapeName: "",
    categoryName: "play",
    pathRecords: polygonFromFlatCoords(
      [.1, .1, .9, .5, .1, .9],
      0,
    ),
  };
};

PathRecordCodec.pathToSerializable = function (pathRecords) {
  var serialized = [];
  for (var recordIdx = 0; recordIdx < pathRecords.length; recordIdx++) {
    serialized.push(serializePathRecord(pathRecords[recordIdx]));
  }
  return serialized;
};

PathRecordCodec.serializableToPath = function (serialized) {
  var pathRecords = [];
  for (var entryIdx = 0; entryIdx < serialized.length; entryIdx++) {
    pathRecords.push(deserializePathRecord(serialized[entryIdx]));
  }
  return pathRecords;
};

PathRecordCodec.readPathPoints = function (bytes, offset, byteLength, scaleX, scaleY) {
  if (scaleX == null) scaleX = 1;
  if (scaleY == null) scaleY = 1;
  var pathRecords = [],
    knotCount = Math.floor(byteLength / PATH_KNOT_BYTE_LENGTH);
  for (var knotIdx = 0; knotIdx < knotCount; knotIdx++) {
    pathRecords.push(readPathKnot(bytes, offset + knotIdx * PATH_KNOT_BYTE_LENGTH, scaleX, scaleY));
  }
  return pathRecords;
};

PathRecordCodec.writePathPoints = function (buf, offset, pathRecords, scaleX, scaleY) {
  for (var knotIdx = 0; knotIdx < pathRecords.length; knotIdx++) {
    writePathKnot(buf, offset + knotIdx * PATH_KNOT_BYTE_LENGTH, pathRecords[knotIdx], scaleX, scaleY);
  }
};

function serializePathRecord(pathRecord) {
  var recordType = pathRecord.type,
    serialized = { type: recordType };
  if (recordType == 6) {
    return serialized;
  }
  if (recordType == 8) {
    serialized.all = pathRecord.all;
    return serialized;
  }
  if (recordType == 0 || recordType == 3) {
    serialized.length = pathRecord.length;
    serialized.frule = pathRecord.fillRule;
    serialized.subpathHeaderFlags = pathRecord.subpathHeaderFlags;
    serialized.subpathUint32A = pathRecord.subpathUint32A;
    serialized.subpathUint32B = pathRecord.subpathUint32B;
    return serialized;
  }
  serialized.c = [
    pathRecord.cp1.x,
    pathRecord.cp1.y,
    pathRecord.anchor.x,
    pathRecord.anchor.y,
    pathRecord.anchorOut.x,
    pathRecord.anchorOut.y,
  ];
  return serialized;
}

function deserializePathRecord(serializedEntry) {
  var recordType = serializedEntry.type,
    pathRecord = { type: recordType };
  if (recordType == 6) {
    return pathRecord;
  }
  if (recordType == 8) {
    pathRecord.all = serializedEntry.all;
    return pathRecord;
  }
  if (recordType == 0 || recordType == 3) {
    pathRecord.length = serializedEntry.length;
    pathRecord.fillRule = serializedEntry.frule;
    pathRecord.subpathHeaderFlags = serializedEntry.subpathHeaderFlags;
    pathRecord.subpathUint32A = serializedEntry.subpathUint32A;
    pathRecord.subpathUint32B = serializedEntry.subpathUint32B;
    return pathRecord;
  }
  var coordPairs = serializedEntry.c;
  pathRecord.cp1 = new Point(coordPairs[0], coordPairs[1]);
  pathRecord.anchor = new Point(coordPairs[2], coordPairs[3]);
  pathRecord.anchorOut = new Point(coordPairs[4], coordPairs[5]);
  return pathRecord;
}

function readScaledCoord(bytes, offset, axisScale) {
  var coord = BinaryUtils.readFixed8_24(bytes, offset) * axisScale,
    rounded = Math.round(coord);
  return Math.abs(coord - rounded) < 1e-6 ? rounded : coord;
}

function readPathKnot(bytes, knotOffset, scaleX, scaleY) {
  var readInt16 = BinaryUtils.readInt16BE,
    knot = {},
    paddingBytes = 0;
  knot.type = readInt16(bytes, knotOffset);
  knotOffset += 2;
  if (knot.type == 6) {
    paddingBytes = 24;
  }
  if (knot.type == 8) {
    knot.all = readInt16(bytes, knotOffset);
    knotOffset += 2;
    paddingBytes = 22;
  }
  if (knot.type == 0 || knot.type == 3) {
    knot.length = readInt16(bytes, knotOffset);
    knotOffset += 2;
    knot.fillRule = readInt16(bytes, knotOffset);
    knotOffset += 2;
    knot.subpathHeaderFlags = readInt16(bytes, knotOffset);
    knotOffset += 2;
    knot.subpathUint32A = BinaryUtils.readUint32BE(bytes, knotOffset);
    knotOffset += 4;
    knot.subpathUint32B = BinaryUtils.readUint32BE(bytes, knotOffset);
    knotOffset += 4;
    paddingBytes = 10;
  }
  if (knot.type == 1 || knot.type == 2 || knot.type == 4 || knot.type == 5) {
    var anchorX, anchorY;
    anchorY = readScaledCoord(bytes, knotOffset, scaleY);
    knotOffset += 4;
    anchorX = readScaledCoord(bytes, knotOffset, scaleX);
    knotOffset += 4;
    knot.cp1 = new Point(anchorX, anchorY);
    anchorY = readScaledCoord(bytes, knotOffset, scaleY);
    knotOffset += 4;
    anchorX = readScaledCoord(bytes, knotOffset, scaleX);
    knotOffset += 4;
    knot.anchor = new Point(anchorX, anchorY);
    anchorY = readScaledCoord(bytes, knotOffset, scaleY);
    knotOffset += 4;
    anchorX = readScaledCoord(bytes, knotOffset, scaleX);
    knotOffset += 4;
    knot.anchorOut = new Point(anchorX, anchorY);
    paddingBytes = 0;
  }
  for (var padIdx = 0; padIdx < paddingBytes; padIdx++) {
    if (bytes[knotOffset + padIdx] != 0) {
      console.log("Unexpected non-zero byte!", knot, padIdx, bytes[knotOffset + padIdx]);
    }
  }
  return knot;
}

function writePathKnot(buf, knotOffset, knot, scaleX, scaleY) {
  var writeUint16 = BinaryUtils.writeUint16Raw,
    writeCoord = BinaryUtils.writeFixed8_24Raw;
  writeUint16(buf, knotOffset, knot.type);
  knotOffset += 2;
  if (knot.type == 6) {
    return;
  }
  if (knot.type == 8) {
    writeUint16(buf, knotOffset, knot.all);
    return;
  }
  if (knot.type == 0 || knot.type == 3) {
    writeUint16(buf, knotOffset, knot.length);
    knotOffset += 2;
    writeUint16(buf, knotOffset, knot.fillRule);
    knotOffset += 2;
    writeUint16(buf, knotOffset, knot.subpathHeaderFlags);
    knotOffset += 2;
    return;
  }
  if (knot.type == 1 || knot.type == 2 || knot.type == 4 || knot.type == 5) {
    writeCoord(buf, knotOffset, knot.cp1.y / scaleY);
    knotOffset += 4;
    writeCoord(buf, knotOffset, knot.cp1.x / scaleX);
    knotOffset += 4;
    writeCoord(buf, knotOffset, knot.anchor.y / scaleY);
    knotOffset += 4;
    writeCoord(buf, knotOffset, knot.anchor.x / scaleX);
    knotOffset += 4;
    writeCoord(buf, knotOffset, knot.anchorOut.y / scaleY);
    knotOffset += 4;
    writeCoord(buf, knotOffset, knot.anchorOut.x / scaleX);
  }
}

export { PathRecordCodec };
