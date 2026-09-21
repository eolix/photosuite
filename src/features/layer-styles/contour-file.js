// Photoshop contour file (.shc) codec for the contour resource picker. Reads a
// `.shc` into an array of `ShpC` contour descriptors and serialises them back
// out. Curve points are the shared `CrPt` descriptor built by the compositing
// curve utilities.
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { RenderBuffer } from "../../core/render-buffer.js";
import { createCurvePoint } from "../../engine/compositing/tone-curves.js";

const FILE_SIGNATURE = "8BFS";
const FILE_VERSION = 1;

// Per-entry format tag: coordinates only, or coordinates followed by a
// continuity byte per point.
const ENTRY_FORMAT_POINTS_ONLY = 1;
const ENTRY_FORMAT_WITH_CONTINUITY = 2;

function ContourParser() {}

/**
 * Parse a `.shc` file.
 * @param {ArrayBuffer} arrayBuffer Raw file bytes.
 * @returns {object[]} One `ShpC` contour descriptor per entry.
 */
ContourParser.parse = function (arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const header = readFileHeader(bytes, 0);
  const contours = [];
  let cursor = header.cursor;
  for (let entryIdx = 0; entryIdx < header.entryCount; entryIdx++) {
    const entry = readContourEntry(bytes, cursor);
    contours.push(entry.contourDesc);
    cursor = entry.cursor;
  }
  return contours;
};

/**
 * Rename a contour descriptor in place.
 * @param {object} contourDesc A contour descriptor with an `Nm` name field.
 * @param {string} name New display name.
 */
ContourParser.setName = function (contourDesc, name) {
  contourDesc.Nm.v = name;
};

/**
 * Serialise contour descriptors into a `.shc` file. Every entry is written in
 * the with-continuity format.
 * @param {object[]} contourDescList Contour descriptors to write.
 * @returns {ArrayBuffer} The encoded file.
 */
ContourParser.serialize = function (contourDescList) {
  const buffer = new RenderBuffer();
  let cursor = 0;
  BinaryUtils.writeAscii(buffer, cursor, FILE_SIGNATURE);
  cursor += 4;
  BinaryUtils.writeUint16(buffer, cursor, FILE_VERSION);
  cursor += 2;
  BinaryUtils.writeSize(buffer, cursor, contourDescList.length);
  cursor += 4;
  for (let entryIdx = 0; entryIdx < contourDescList.length; entryIdx++) {
    cursor = writeContourEntry(buffer, cursor, contourDescList[entryIdx]);
  }
  return buffer.data.slice(0, cursor).buffer;
};

// Read the file envelope: the 4-byte signature and 2-byte version (both
// advanced past, not validated), then the big-endian entry count.
function readFileHeader(bytes, cursor) {
  BinaryUtils.readString(bytes, cursor, 4);
  cursor += 4;
  BinaryUtils.readUint16(bytes, cursor);
  cursor += 2;
  const entryCount = BinaryUtils.readUint32BE(bytes, cursor);
  cursor += 4;
  return { entryCount, cursor };
}

function readContourEntry(bytes, cursor) {
  const entryFormat = BinaryUtils.readUint32BE(bytes, cursor);
  cursor += 4;
  const contourDesc = createEmptyContourDescriptor();
  const name = BinaryUtils.readUnicodeName(bytes, cursor);
  contourDesc.Nm.v = name;
  cursor += 4 + name.length * 2 + 2;
  // Fixed per-entry curve-type marker (always 2); advanced past.
  BinaryUtils.readUint16(bytes, cursor);
  cursor += 2;
  const pointCount = BinaryUtils.readUint16(bytes, cursor);
  cursor += 2;
  cursor = readCurvePoints(bytes, cursor, contourDesc, pointCount);
  cursor = readContinuityFlags(bytes, cursor, contourDesc, pointCount, entryFormat);
  cursor = skipEntryTrailers(bytes, cursor);
  return { contourDesc, cursor };
}

function readCurvePoints(bytes, cursor, contourDesc, pointCount) {
  const curvePoints = contourDesc.Crv.v;
  for (let pointIdx = 0; pointIdx < pointCount; pointIdx++) {
    const curvePoint = createCurvePoint(0, 0, true);
    curvePoint.v.Vrtc.v = BinaryUtils.readUint16(bytes, cursor);
    cursor += 2;
    curvePoint.v.Hrzn.v = BinaryUtils.readUint16(bytes, cursor);
    cursor += 2;
    curvePoints.push(curvePoint);
  }
  return cursor;
}

// Points-only entries carry no continuity data. With-continuity entries store
// one byte per point (1 = corner/continuous).
function readContinuityFlags(bytes, cursor, contourDesc, pointCount, entryFormat) {
  if (entryFormat === ENTRY_FORMAT_POINTS_ONLY) return cursor;
  if (entryFormat !== ENTRY_FORMAT_WITH_CONTINUITY) {
    throw new Error("Unknown contour entry format: " + entryFormat);
  }
  const curvePoints = contourDesc.Crv.v;
  for (let pointIdx = 0; pointIdx < pointCount; pointIdx++) {
    curvePoints[pointIdx].v.Cnty.v = bytes[cursor] == 1;
    cursor += 1;
  }
  return cursor;
}

// Each entry ends with two big-endian uint32 trailers (unused); advance past.
function skipEntryTrailers(bytes, cursor) {
  BinaryUtils.readUint32BE(bytes, cursor);
  cursor += 4;
  BinaryUtils.readUint32BE(bytes, cursor);
  cursor += 4;
  return cursor;
}

function writeContourEntry(buffer, cursor, contourDesc) {
  BinaryUtils.writeSize(buffer, cursor, ENTRY_FORMAT_WITH_CONTINUITY);
  cursor += 4;
  BinaryUtils.writeUnicodeString(buffer, cursor, contourDesc.Nm.v + "\0");
  cursor += 4 + contourDesc.Nm.v.length * 2 + 2;
  BinaryUtils.writeUint16(buffer, cursor, 2);
  cursor += 2;
  const curvePoints = contourDesc.Crv.v;
  BinaryUtils.writeUint16(buffer, cursor, curvePoints.length);
  cursor += 2;
  cursor = writeCurvePointCoords(buffer, cursor, curvePoints);
  cursor = writeContinuityFlags(buffer, cursor, curvePoints);
  BinaryUtils.writeSize(buffer, cursor, 0);
  cursor += 4;
  BinaryUtils.writeSize(buffer, cursor, 0);
  cursor += 4;
  return cursor;
}

function writeCurvePointCoords(buffer, cursor, curvePoints) {
  for (let pointIdx = 0; pointIdx < curvePoints.length; pointIdx++) {
    const point = curvePoints[pointIdx];
    BinaryUtils.writeUint16(buffer, cursor, point.v.Vrtc.v);
    cursor += 2;
    BinaryUtils.writeUint16(buffer, cursor, point.v.Hrzn.v);
    cursor += 2;
  }
  return cursor;
}

function writeContinuityFlags(buffer, cursor, curvePoints) {
  buffer.ensureCapacity(cursor, curvePoints.length);
  for (let pointIdx = 0; pointIdx < curvePoints.length; pointIdx++) {
    buffer.data[cursor] = curvePoints[pointIdx].v.Cnty.v;
    cursor++;
  }
  return cursor;
}

function createEmptyContourDescriptor() {
  return {
    classID: "ShpC",
    Nm: { t: "TEXT", v: "" },
    Crv: { t: "VlLs", v: [] },
  };
}

export { ContourParser };
