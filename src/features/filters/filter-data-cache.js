// Smart-filter cache: decodes the cached layer-data record used to restore
// adjustment/smart-filter previews. Not an on-disk asset format.
import { BinaryUtils } from "../../core/binary/binary-utils.js";

const MESH_CACHE_TAG = "yfqLhseM";

const MESH_VERSION_DENSE = 2;
const MESH_VERSION_SPARSE = 3;
const MESH_VERSION_SPARSE_ALT = 4;

const DENSE_MAP_BYTE_OFFSET = 32;
const SPARSE_V3_DATA_OFFSET = 32;
const SPARSE_V4_DATA_OFFSET = 16 + 8 + 40;

function CachedLayerData() {}

function readMeshHeader(bytes) {
  let cursor = 0;
  const version = BinaryUtils.readUint32BE(bytes, cursor);
  cursor += 4;
  BinaryUtils.readString(bytes, cursor, 8);
  cursor += 8;
  BinaryUtils.readFloat32(bytes, cursor);
  cursor += 4;
  const gridWidth = BinaryUtils.readFloat32(bytes, cursor);
  cursor += 4;
  const gridHeight = BinaryUtils.readFloat32(bytes, cursor);
  return {
    version: version,
    gridWidth: gridWidth,
    gridHeight: gridHeight
  };
}

function parseDenseMeshMap(arrayBuffer) {
  return new Float32Array(arrayBuffer, DENSE_MAP_BYTE_OFFSET, arrayBuffer.byteLength - DENSE_MAP_BYTE_OFFSET >>> 2);
}

function parseSparseMeshMap(bytes, gridWidth, gridHeight, dataOffset) {
  let displacementMap = new Float32Array(gridWidth * gridHeight * 2);
  let rowBase = 0;
  let columnCursor = 0;
  let expectingSkipRun = true;
  let cursor = dataOffset;
  while (cursor < bytes.length) {
    const runLength = BinaryUtils.readFloat32(bytes, cursor);
    cursor += 4;
    if (expectingSkipRun) columnCursor += runLength;
    else {
      for (let sampleIdx = 0; sampleIdx < runLength; sampleIdx++) {
        const mapOffset = rowBase + columnCursor + sampleIdx << 1;
        displacementMap[mapOffset] = BinaryUtils.readFloat32LE(bytes, cursor);
        displacementMap[mapOffset + 1] = BinaryUtils.readFloat32LE(bytes, cursor + 4);
        cursor += 8
      }
      columnCursor += runLength
    }
    expectingSkipRun = !expectingSkipRun;
    if (runLength != 0 && columnCursor == gridWidth) {
      rowBase += gridWidth;
      columnCursor = 0;
      expectingSkipRun = true;
      if (rowBase == gridWidth * gridHeight) break
    }
  }
  return displacementMap;
}

function writeSparseMeshRows(bytes, startCursor, gridWidth, gridHeight, displacementMap) {
  let cursor = startCursor;
  let mapCursor = 0;
  for (let row = 0; row < gridHeight; row++) {
    BinaryUtils.writeFloat32Raw(bytes, cursor, 0);
    cursor += 4;
    BinaryUtils.writeFloat32Raw(bytes, cursor, gridWidth);
    cursor += 4;
    for (let col = 0; col < gridWidth; col++) {
      BinaryUtils.writeFloat32LERaw(bytes, cursor, displacementMap[mapCursor]);
      BinaryUtils.writeFloat32LERaw(bytes, cursor + 4, displacementMap[mapCursor + 1]);
      mapCursor += 2;
      cursor += 8
    }
  }
  return cursor;
}

CachedLayerData.parse = function(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const header = readMeshHeader(bytes);
  const version = header.version;
  const gridWidth = header.gridWidth;
  const gridHeight = header.gridHeight;
  let displacementMap;
  if (version == MESH_VERSION_DENSE) {
    displacementMap = parseDenseMeshMap(arrayBuffer)
  } else if (version == MESH_VERSION_SPARSE || version == MESH_VERSION_SPARSE_ALT) {
    const dataOffset = version == MESH_VERSION_SPARSE ? SPARSE_V3_DATA_OFFSET : SPARSE_V4_DATA_OFFSET;
    displacementMap = parseSparseMeshMap(bytes, gridWidth, gridHeight, dataOffset)
  } else throw new Error("unknown Mesh version: " + version);
  return {
    gridWidth: gridWidth,
    gridHeight: gridHeight,
    map: displacementMap
  };
};

CachedLayerData.serialize = function(meshData) {
  const gridWidth = meshData.gridWidth;
  const gridHeight = meshData.gridHeight;
  let displacementMap = meshData.map;
  const bytes = new Uint8Array(32 + gridHeight * gridWidth * 8 + gridHeight * 8);
  let cursor = 0;
  BinaryUtils.writeUint32BE(bytes, cursor, MESH_VERSION_SPARSE);
  cursor += 4;
  BinaryUtils.writeAsciiRaw(bytes, cursor, MESH_CACHE_TAG);
  cursor += 8;
  BinaryUtils.writeFloat32Raw(bytes, cursor, 2);
  cursor += 4;
  BinaryUtils.writeFloat32Raw(bytes, cursor, gridWidth);
  cursor += 4;
  BinaryUtils.writeFloat32Raw(bytes, cursor, gridHeight);
  cursor += 4;
  BinaryUtils.writeFloat32Raw(bytes, cursor, 0);
  cursor += 4;
  BinaryUtils.writeFloat32Raw(bytes, cursor, 1);
  cursor += 4;
  writeSparseMeshRows(bytes, cursor, gridWidth, gridHeight, displacementMap);
  return bytes.buffer;
};

export { CachedLayerData };
