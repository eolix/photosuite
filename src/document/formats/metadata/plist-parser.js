/**
 * Apple binary property list (bplist / NSKeyedArchiver keyed-archive) parser.
 */
import { BinaryUtils } from "../../../core/binary/binary-utils.js";

const TRAILER_BYTE_COUNT = 31;

/** @param {Uint8Array} bytes @param {number} offset */
function readPtrByte(bytes, offset) {
  return bytes[offset];
}

/** @param {Uint8Array} bytes @param {number} offset */
function readPtrUint16(bytes, offset) {
  return bytes[offset] << 8 | bytes[offset + 1];
}

/** @param {Uint8Array} bytes @param {number} offset */
function readPtrUint32(bytes, offset) {
  return bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3];
}

/**
 * Reads a variable-width big-endian integer prefixed by a type nibble byte.
 * @returns {{ value: number, byteCount: number }}
 */
function readVariableIntBE(bytes, offset) {
  var byteCount = 1 << (bytes[offset] & 15);
  var value = 0;
  for (var byteIdx = 0; byteIdx < byteCount; byteIdx++) {
    value = value << 8 | bytes[offset + 1 + byteIdx];
  }
  return { value: value, byteCount: byteCount + 1 };
}

/** @param {Uint8Array} bytes @param {number} offset */
function parseTrailer(bytes, offset) {
  var trailer = {};
  offset += 6;
  trailer.wordSize = bytes[offset];
  offset++;
  trailer.ptrWidth = bytes[offset];
  offset++;
  offset += 4;
  trailer.objectCount = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  offset += 4;
  trailer.root = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  offset += 4;
  trailer.trailerFlags = BinaryUtils.readUint32BE(bytes, offset);
  return trailer;
}

/**
 * @param {Uint8Array} bytes
 * @param {number[]} ptrTable
 * @param {number} ptrIndex
 * @param {{ ptrWidth: number }} trailer
 */
function readObjectValue(bytes, ptrTable, ptrIndex, trailer) {
  var ptrWidth = trailer.ptrWidth;
  var readPtr =
    ptrWidth === 4 ? readPtrUint32 : ptrWidth === 2 ? readPtrUint16 : readPtrByte;
  var objectOffset = ptrTable[ptrIndex];
  var typeByte = bytes[objectOffset];
  var typeClass = typeByte >> 4;
  var typeInfo = typeByte & 15;
  var decodedValue = null;

  objectOffset += 1;

  if ([4, 5, 6, 10, 12, 13].indexOf(typeClass) !== -1 && typeInfo === 15) {
    var extendedLength = readVariableIntBE(bytes, objectOffset);
    objectOffset += extendedLength.byteCount;
    typeInfo = extendedLength.value;
  }

  if (typeClass === 0) {
    decodedValue = typeInfo === 8 ? false : typeInfo === 9 ? true : null;
  } else if (typeClass === 1) {
    decodedValue = readVariableIntBE(bytes, objectOffset - 1).value;
  } else if (typeClass === 2) {
    var valueByteLength = 1 << typeInfo;
    decodedValue =
      valueByteLength === 4
        ? BinaryUtils.readFloat32BE(bytes, objectOffset)
        : BinaryUtils.readFloat64BE(bytes, objectOffset);
  } else if (typeClass === 3) {
    decodedValue = BinaryUtils.readFloat64BE(bytes, objectOffset);
  } else if (typeClass === 4) {
    decodedValue = new Uint8Array(bytes.buffer, objectOffset, typeInfo);
  } else if (typeClass === 5) {
    decodedValue = BinaryUtils.readString(bytes, objectOffset, typeInfo);
  } else if (typeClass === 6) {
    decodedValue = BinaryUtils.readStringBE(bytes, objectOffset, typeInfo);
  } else if (typeClass === 8) {
    decodedValue = 0;
    for (var byteIdx = 0; byteIdx < typeInfo + 1; byteIdx++) {
      decodedValue = decodedValue << 8 | bytes[objectOffset + byteIdx];
    }
  } else if (typeClass === 10) {
    decodedValue = [];
    for (var elemIdx = 0; elemIdx < typeInfo; elemIdx++) {
      decodedValue.push(
        readObjectValue(bytes, ptrTable, readPtr(bytes, objectOffset + ptrWidth * elemIdx), trailer)
      );
    }
  } else if (typeClass === 12) {
    decodedValue = [];
    for (var elemIdx = 0; elemIdx < typeInfo; elemIdx++) {
      decodedValue.push(
        readObjectValue(bytes, ptrTable, readPtr(bytes, objectOffset + ptrWidth * elemIdx), trailer)
      );
    }
  } else if (typeClass === 13) {
    decodedValue = {};
    for (var elemIdx = 0; elemIdx < typeInfo; elemIdx++) {
      var mapKey = readObjectValue(
        bytes,
        ptrTable,
        readPtr(bytes, objectOffset + ptrWidth * elemIdx),
        trailer
      );
      var mapValue = readObjectValue(
        bytes,
        ptrTable,
        readPtr(bytes, objectOffset + ptrWidth * (typeInfo + elemIdx)),
        trailer
      );
      decodedValue[mapKey] = mapValue;
    }
  } else {
    throw new Error("unknown mask " + typeClass);
  }

  return decodedValue;
}

/**
 * Parse an Apple binary property list.
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
function parseBinaryPlist(bytes, offset) {
  BinaryUtils.readString(bytes, offset, 8);
  offset += 8;

  var trailer = parseTrailer(bytes, bytes.length - TRAILER_BYTE_COUNT);
  var ptrTable = [];

  if (trailer.wordSize === 1) {
    var ptrTableOffset = bytes.length - TRAILER_BYTE_COUNT - trailer.wordSize * trailer.objectCount;
    for (var ptrIdx = 0; ptrIdx < trailer.objectCount; ptrIdx++) {
      ptrTable.push(bytes[ptrTableOffset + ptrIdx]);
    }
  } else if (trailer.wordSize === 2) {
    var ptrTableOffset = bytes.length - TRAILER_BYTE_COUNT - trailer.wordSize * trailer.objectCount;
    for (var ptrIdx = 0; ptrIdx < trailer.objectCount; ptrIdx++) {
      ptrTable.push(BinaryUtils.readUint16(bytes, ptrTableOffset + ptrIdx * 2));
    }
  } else if (trailer.wordSize === 4) {
    var ptrTableOffset = bytes.length - TRAILER_BYTE_COUNT - trailer.wordSize * trailer.objectCount;
    for (var ptrIdx = 0; ptrIdx < trailer.objectCount; ptrIdx++) {
      ptrTable.push(BinaryUtils.readUint32BE(bytes, ptrTableOffset + ptrIdx * 4));
    }
  } else {
    throw new Error("unsupported object ref width");
  }

  return readObjectValue(bytes, ptrTable, trailer.root, trailer);
}

export const BinaryPlistParser = { parse: parseBinaryPlist };

export { parseBinaryPlist };
