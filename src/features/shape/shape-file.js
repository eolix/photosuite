// Photoshop custom-shape library (.csh) codec. The file stores named shape
// entries (category + Pascal name + bounds + path knots). Path knot I/O lives
// in PathRecordCodec; this module owns the cush envelope and unit-square
// normalisation applied on read.
import { Matrix2D } from "../../core/math/matrix2d.js";
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { RenderBuffer } from "../../core/render-buffer.js";
import { PathRecordCodec } from "../../document/formats/psd/path-record-codec.js";
import { boundsFromCoordPairs } from "../../engine/compositing/anti-alias.js";

import { flattenPathKnotCoords, transformPathRecordCoords } from "../../engine/compositing/path-records.js";

const FILE_SIGNATURE = "cush";
const WRITE_VERSION = 2;
const PATH_KNOT_BYTE_LENGTH = 26;

function ShapeFile() {}

/**
 * Parse a `.csh` custom-shape library.
 * @param {ArrayBuffer} arrayBuffer Raw file bytes.
 * @returns {object[]} Shape entries with category, name, path records, and bounds.
 */
ShapeFile.parse = function (arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let cursor = skipFileHeader(bytes, 0);
  const shapeCount = BinaryUtils.readUint32BE(bytes, cursor);
  cursor += 4;
  const shapes = [];
  for (let shapeIdx = 0; shapeIdx < shapeCount; shapeIdx++) {
    const category = readCategoryName(bytes, cursor);
    cursor = ShapeFile.parseShape(bytes, category.cursor, category.name, shapes);
  }
  return shapes;
};

/**
 * Parse one shape block (also used by tool-preset files that embed shapes).
 * @param {Uint8Array} bytes File bytes.
 * @param {number} offset Start of the shape block (after category name).
 * @param {string} categoryName Category label for the entry.
 * @param {object[]} outShapes Destination list; the new entry is pushed here.
 * @returns {number} Byte offset after the shape block.
 */
ShapeFile.parseShape = function (bytes, offset, categoryName, outShapes) {
  // Leading uint32 is unused by the reader (format reserved / count field).
  BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  const blockSize = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  let blockCursor = offset;
  const shapeName = BinaryUtils.readPascalString(bytes, blockCursor).str;
  blockCursor += shapeName.length + 1;
  const boundsRect = BinaryUtils.readRect(bytes, blockCursor);
  blockCursor += 16;
  const pathByteLength = blockSize - (blockCursor - offset);
  const pathRecords = PathRecordCodec.readPathPoints(bytes, blockCursor, pathByteLength);
  const pathBounds = normalizePathRecordsToUnitSquare(pathRecords);
  outShapes.push({
    categoryName,
    shapeName,
    pathRecords,
    boundsRect: usableDesignBounds(boundsRect, pathBounds),
  });
  return offset + blockSize;
};

/**
 * Rename a shape entry in place (category label).
 * @param {object} shapeEntry Shape entry with `categoryName`.
 * @param {string} name New category name.
 */
ShapeFile.setName = function (shapeEntry, name) {
  shapeEntry.categoryName = name;
};

/**
 * Serialise shape entries into a version-2 `.csh` file.
 * @param {object[]} shapes Shape entries to write.
 * @returns {ArrayBuffer} Encoded file bytes.
 */
ShapeFile.serialize = function (shapes) {
  const buffer = new RenderBuffer();
  let cursor = 0;
  BinaryUtils.writeAscii(buffer, cursor, FILE_SIGNATURE);
  cursor += 4;
  BinaryUtils.writeSize(buffer, cursor, WRITE_VERSION);
  cursor += 4;
  BinaryUtils.writeSize(buffer, cursor, shapes.length);
  cursor += 4;
  for (let shapeIdx = 0; shapeIdx < shapes.length; shapeIdx++) {
    cursor = writeShapeEntry(buffer, cursor, shapes[shapeIdx]);
  }
  return buffer.data.slice(0, cursor).buffer;
};

function skipFileHeader(bytes, cursor) {
  // Signature (4) + version (4); values are not validated.
  BinaryUtils.readString(bytes, cursor, 4);
  cursor += 4;
  BinaryUtils.readUint32BE(bytes, cursor);
  cursor += 4;
  return cursor;
}

function readCategoryName(bytes, cursor) {
  const name = BinaryUtils.readUnicodeName(bytes, cursor);
  cursor += name.length * 2 + 4 + 2;
  if ((name.length & 1) === 0) cursor += 2;
  return { name, cursor };
}

/**
 * Scale the knots into the unit square, and report the box they came from.
 *
 * The two axes are scaled independently, so the shape's proportions do not
 * survive this — {@link ShapeFile.parseShape} keeps the design box to restore
 * them. A shape with no extent on an axis (a flat line) keeps that axis as it
 * is rather than dividing by zero, which would leave every coordinate NaN.
 *
 * @param {object[]} pathRecords Knots, transformed in place.
 * @returns {object} The bounds the knots occupied before normalisation.
 */
function normalizePathRecordsToUnitSquare(pathRecords) {
  const flatCoords = flattenPathKnotCoords(pathRecords);
  const pathBounds = boundsFromCoordPairs(flatCoords);
  const scaleX = pathBounds.width > 0 ? 1 / pathBounds.width : 1;
  const scaleY = pathBounds.height > 0 ? 1 / pathBounds.height : 1;
  transformPathRecordCoords(
    pathRecords,
    new Matrix2D(scaleX, 0, 0, scaleY, -pathBounds.x * scaleX, -pathBounds.y * scaleY),
  );
  return pathBounds;
}

/**
 * The design box to keep for a shape.
 *
 * It is the only record of the shape's proportions once the knots are
 * normalised, so a library that stored a degenerate one — the bundled icon set
 * writes `bottom == top`, leaving a height of zero — would otherwise flatten
 * every preview and every placement. The box the knots actually occupied says
 * the same thing and is always there.
 */
function usableDesignBounds(storedBounds, pathBounds) {
  if (storedBounds != null && storedBounds.width > 0 && storedBounds.height > 0) return storedBounds;
  return pathBounds;
}

/**
 * Width-to-height ratio of a shape's design box, or 1 when it has none worth
 * trusting. Callers scale a unit-square path by this, so a zero or a
 * non-finite ratio does not reach the geometry.
 *
 * @param {{width: number, height: number}|null} boundsRect
 * @returns {number}
 */
export function shapeAspectRatio(boundsRect) {
  if (boundsRect == null) return 1;
  const ratio = boundsRect.width / boundsRect.height;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

function writeShapeEntry(buffer, cursor, shape) {
  const categoryLabel = shape.categoryName + "\0";
  BinaryUtils.writeUnicodeString(buffer, cursor, categoryLabel);
  cursor += 4 + categoryLabel.length * 2;
  if ((categoryLabel.length & 1) === 1) cursor += 2;
  BinaryUtils.writeSize(buffer, cursor, 1);
  cursor += 4;
  // Reserve the block-size field; filled after path knots are written.
  cursor += 4;
  const blockStart = cursor;
  BinaryUtils.writePascalString(buffer, cursor, shape.shapeName);
  cursor += shape.shapeName.length + 1;
  BinaryUtils.writePsdRect(buffer, cursor, shape.boundsRect);
  cursor += 16;
  buffer.ensureCapacity(cursor, shape.pathRecords.length * PATH_KNOT_BYTE_LENGTH);
  PathRecordCodec.writePathPoints(buffer.data, cursor, shape.pathRecords, 1, 1);
  cursor += shape.pathRecords.length * PATH_KNOT_BYTE_LENGTH;
  let blockSize = cursor - blockStart;
  if ((blockSize & 3) !== 0) blockSize += 4 - (blockSize & 3);
  BinaryUtils.writeSize(buffer, blockStart - 4, blockSize);
  return blockStart + blockSize;
}

export { ShapeFile };
