// Minimal SQLite reader: walks the b-tree pages of a SQLite container and
// returns each table's records as arrays of column values. Used to read Sketch
// documents stored as an SQLite archive.

/** B-tree page types (first payload byte of each page). */
const PAGE_INTERIOR_INDEX = 2;
const PAGE_INTERIOR_TABLE = 5;
const PAGE_LEAF_INDEX = 10;
const PAGE_LEAF_TABLE = 13;

/** The database header reserves the first 100 bytes of page 1. */
const HEADER_RESERVED_BYTES = 100;
/** A page-size field of 1 encodes the maximum 65536-byte page. */
const MAX_PAGE_SIZE = 65536;

/** Shared little-endian scratch buffer for big-endian → native conversions. */
const scratchNumberBuffer = new Uint8Array(8);
const int8View = new Int8Array(scratchNumberBuffer.buffer);
const int16View = new Int16Array(scratchNumberBuffer.buffer);
const int32View = new Int32Array(scratchNumberBuffer.buffer);
const float64View = new Float64Array(scratchNumberBuffer.buffer);

/**
 * Parse a SQLite database into per-table record lists. Returns an array whose
 * first entry is the schema (sqlite_master) rows and whose subsequent entries
 * are each table's rows; the schema rows' root-page column is rewritten to the
 * table's index in the result.
 * @param {ArrayBuffer|Uint8Array} bytes
 * @returns {Array<Array>}
 */
function parse(bytes) {
  var fileBytes = new Uint8Array(bytes);
  var header = parseSqliteHeader(fileBytes);
  var scratchBuffer = new Uint8Array(fileBytes.length);
  var schemaRecords = [];
  var allTables = [schemaRecords];
  parsePage(fileBytes, header, 1, scratchBuffer, schemaRecords);
  for (var pageIdx = 0; pageIdx < schemaRecords.length; pageIdx++) {
    var tableRecords = [];
    allTables.push(tableRecords);
    parsePage(fileBytes, header, schemaRecords[pageIdx][3], scratchBuffer, tableRecords);
    schemaRecords[pageIdx][3] = pageIdx + 1;
  }
  return allTables;
}

/** Walk one b-tree page, appending leaf-table records to `pageRecords`. */
function parsePage(bytes, header, pageNumber, scratchBuffer, pageRecords) {
  pageNumber--;
  var pageOffset = pageNumber * header.pageSize + (pageNumber == 0 ? HEADER_RESERVED_BYTES : 0);
  var pageType = bytes[pageOffset];
  if (readUint16(bytes, pageOffset + 1) != 0) throw "sqlite: free block in a page";
  var cellCount = readUint16(bytes, pageOffset + 3);
  var isInterior = pageType == PAGE_INTERIOR_INDEX || pageType == PAGE_INTERIOR_TABLE;
  if (isInterior) pageOffset += 4;

  var usablePageSize = header.pageSize - (pageNumber == 0 ? HEADER_RESERVED_BYTES : 0);
  for (var cellIdx = 0; cellIdx < cellCount; cellIdx++) {
    var cellOffset = pageNumber * header.pageSize + readUint16(bytes, pageOffset + 8 + 2 * cellIdx);
    var childPageNumber = -1;
    var payloadSizeVarint = 0;
    var rowidVarint = 0;
    if (pageType == PAGE_INTERIOR_INDEX || pageType == PAGE_INTERIOR_TABLE) {
      childPageNumber = readUint32BE(bytes, cellOffset);
      cellOffset += 4;
    }
    if (pageType == PAGE_INTERIOR_INDEX || pageType == PAGE_LEAF_INDEX || pageType == PAGE_LEAF_TABLE) {
      payloadSizeVarint = readVarint(bytes, cellOffset);
      cellOffset += payloadSizeVarint.byteCount;
    }
    if (pageType == PAGE_INTERIOR_TABLE || pageType == PAGE_LEAF_TABLE) {
      rowidVarint = readVarint(bytes, cellOffset);
      cellOffset += rowidVarint.byteCount;
    }
    if (pageType == PAGE_INTERIOR_TABLE) {
      parsePage(bytes, header, childPageNumber, scratchBuffer, pageRecords);
      continue;
    }
    var payloadSize = payloadSizeVarint.value;
    copyCellPayload(bytes, header, cellOffset, payloadSize, pageType == PAGE_LEAF_TABLE, usablePageSize, scratchBuffer);
    pageRecords.push(parseRecord(scratchBuffer, payloadSize));
  }
}

/**
 * Copy a cell's payload into `scratchBuffer`, following overflow-page chains
 * when the payload does not fit on the local page (SQLite overflow spec).
 */
function copyCellPayload(bytes, header, cellOffset, payloadSize, isTableLeaf, usablePageSize, scratchBuffer) {
  var maxLocalPayload = isTableLeaf ? usablePageSize - 35 : Math.floor((usablePageSize - 12) * 64 / 255) - 23;
  var minLocalPayload = Math.floor((usablePageSize - 12) * 32 / 255) - 23;
  var maxFragmentPayload = minLocalPayload + (payloadSize - minLocalPayload) % (usablePageSize - 4);
  if (payloadSize <= maxLocalPayload) {
    copyBytes(bytes, cellOffset, scratchBuffer, 0, payloadSize);
    return;
  }
  var localCopySize = maxFragmentPayload <= maxLocalPayload ? maxFragmentPayload : minLocalPayload;
  copyBytes(bytes, cellOffset, scratchBuffer, 0, localCopySize);
  var bytesCopied = localCopySize;
  var overflowPageNumber = readUint32BE(bytes, cellOffset + localCopySize);
  while (overflowPageNumber != 0) {
    var overflowOffset = (overflowPageNumber - 1) * header.pageSize;
    overflowPageNumber = readUint32BE(bytes, overflowOffset);
    var copyLength = Math.min(header.pageSize - 4, payloadSize - bytesCopied);
    copyBytes(bytes, overflowOffset + 4, scratchBuffer, bytesCopied, copyLength);
    bytesCopied += copyLength;
  }
}

/** Decode a record header + column values from a payload buffer. */
function parseRecord(bytes, recordLength) {
  var offset = 0;
  var headerSizeVarint = readVarint(bytes, offset);
  offset += headerSizeVarint.byteCount;
  var serialTypes = [];
  var values = [];
  while (offset < headerSizeVarint.value) {
    var typeVarint = readVarint(bytes, offset);
    offset += typeVarint.byteCount;
    serialTypes.push(typeVarint.value);
  }
  if (offset != headerSizeVarint.value) throw "sqlite: record header size mismatch";

  for (var typeIdx = 0; typeIdx < serialTypes.length; typeIdx++) {
    var serialType = serialTypes[typeIdx];
    if (serialType == 0) {
      values.push(null);
    } else if (serialType == 1) {
      values.push(readInt8(bytes, offset));
      offset += 1;
    } else if (serialType == 2) {
      values.push(readInt16BE(bytes, offset));
      offset += 2;
    } else if (serialType == 3) {
      values.push(readInt24BE(bytes, offset));
      offset += 3;
    } else if (serialType == 4) {
      values.push(readInt32BE(bytes, offset));
      offset += 4;
    } else if (serialType == 7) {
      values.push(readFloat64BE(bytes, offset));
      offset += 16;
    } else if (serialType == 8) {
      values.push(0);
    } else if (serialType == 9) {
      values.push(1);
    } else if (serialType >= 12 && (serialType & 1) == 0) {
      var blobLength = serialType - 13 >> 1;
      var blobBytes = new Uint8Array(blobLength);
      copyBytes(bytes, offset, blobBytes, 0, blobLength);
      values.push(blobBytes);
      offset += blobLength;
    } else if (serialType >= 13 && (serialType & 1) == 1) {
      var stringLength = serialType - 12 >> 1;
      values.push(readUtf8String(bytes, offset, stringLength));
      offset += stringLength;
    } else {
      throw "unknown type " + serialType;
    }
  }
  return values;
}

/** Read and validate the 100-byte database header. */
function parseSqliteHeader(bytes) {
  if (!(bytes[18] == 1 && bytes[19] == 1 && bytes[20] == 0 && bytes[21] == 64 && bytes[22] == 32 && bytes[23] == 32)) throw "unexpected SQL3 header";
  var header = {
    magicString: readString(bytes, 0, 15),
    pageSize: readUint16(bytes, 16),
    fileChangeCounter: readUint32BE(bytes, 24),
    size: readUint32BE(bytes, 28),
    firstFreelistTrunkPage: readUint32BE(bytes, 32),
    firstFreelistPage: readUint32BE(bytes, 36),
    schemaCookie: readUint32BE(bytes, 40),
    schemaFormatNumber: readUint32BE(bytes, 44),
    defaultPageCacheSize: readUint32BE(bytes, 48),
    largestRootBtreePage: readUint32BE(bytes, 52),
    textEncoding: readUint32BE(bytes, 56),
    userVersion: readUint32BE(bytes, 60),
    incrementalVacuumEnabled: readUint32BE(bytes, 64) != 0,
    applicationId: readUint32BE(bytes, 68),
    versionValidFor: readUint32BE(bytes, 92),
    sqliteVersionNumber: readUint32BE(bytes, 96),
  };
  if (header.pageSize == 1) header.pageSize = MAX_PAGE_SIZE;
  if (header.textEncoding != 1) throw "unsupported text encoding " + header.textEncoding;
  return header;
}

function readUint24BE(bytes, offset) {
  return bytes[offset] << 16 | bytes[offset + 1] << 8 | bytes[offset + 2];
}

function readInt24BE(bytes, offset) {
  var unsignedValue = readUint24BE(bytes, offset);
  return unsignedValue & 8388608 ? -(16777215 - unsignedValue + 1) : unsignedValue;
}

function readInt8(bytes, offset) {
  scratchNumberBuffer[0] = bytes[offset];
  return int8View[0];
}

function readInt16BE(bytes, offset) {
  scratchNumberBuffer[0] = bytes[offset + 1];
  scratchNumberBuffer[1] = bytes[offset];
  return int16View[0];
}

function readInt32BE(bytes, offset) {
  for (var byteIdx = 0; byteIdx < 4; byteIdx++) scratchNumberBuffer[byteIdx] = bytes[offset + 3 - byteIdx];
  return int32View[0];
}

function readUint16(bytes, offset) {
  return bytes[offset] << 8 | bytes[offset + 1];
}

function readUint32BE(bytes, offset) {
  return bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3];
}

function readFloat64BE(bytes, offset) {
  for (var byteIdx = 0; byteIdx < 8; byteIdx++) scratchNumberBuffer[byteIdx] = bytes[offset + 7 - byteIdx];
  return float64View[0];
}

/** Read a base-128 varint, returning its value and byte length. */
function readVarint(bytes, offset) {
  var startOffset = offset;
  var value = 0;
  while (true) {
    var byteVal = bytes[offset];
    offset++;
    value = value * 128 + (byteVal & 127);
    if (byteVal < 128) break;
  }
  return { value: value, byteCount: offset - startOffset };
}

/** Read `length` bytes as a latin1 (per-byte char code) string. */
function readString(bytes, offset, length) {
  var result = "";
  for (var charIdx = 0; charIdx < length; charIdx++) result += String.fromCharCode(bytes[offset + charIdx]);
  return result;
}

/** Read `length` bytes as a percent-decoded UTF-8 string. */
function readUtf8String(bytes, offset, length) {
  var result = "";
  for (var charIdx = 0; charIdx < length; charIdx++) result += "%" + padHex2(bytes[offset + charIdx].toString(16));
  return decodeURIComponent(result);
}

/** Copy `byteCount` bytes, throwing if either range runs past its buffer. */
function copyBytes(sourceBytes, sourceOffset, destBytes, destOffset, byteCount) {
  if (sourceBytes[sourceOffset + byteCount - 1] == null || destBytes[destOffset + byteCount - 1] == null) {
    console.log(sourceOffset, destOffset, byteCount);
    throw "sqlite: copy runs past buffer end";
  }
  for (var byteIdx = 0; byteIdx < byteCount; byteIdx++) destBytes[destOffset + byteIdx] = sourceBytes[sourceOffset + byteIdx];
}

/** Zero-pad a hex string to two digits. */
function padHex2(hexStr) {
  return hexStr.length < 2 ? "0" + hexStr : hexStr;
}

const SqliteParser = { parse, parseRecord, readVarint, parseSqliteHeader };

export { SqliteParser };
