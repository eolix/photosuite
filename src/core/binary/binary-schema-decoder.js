/**
 * Decoder for a compact binary schema + message format (Figma importer).
 * {@link parseSchema} builds a type registry; {@link decodeMessage} reads payloads against it.
 */

import { BinaryUtils } from "./binary-utils.js";

var BinarySchemaDecoder = function () {
  var buf, pos;

  var rotBuf = new ArrayBuffer(4);
  var rotBytes = new Uint8Array(rotBuf);
  var rotBits = new Uint32Array(rotBuf);
  var rotFloat = new Float32Array(rotBuf);

  function readVarint() {
    var result = 0;
    var shift = 0;
    var byteVal;
    do {
      byteVal = buf[pos++];
      result |= (byteVal & 0x7F) << shift;
      shift += 7;
    } while (byteVal & 0x80 && shift < 35);
    return result >>> 0;
  }

  function readNullUtf8(start) {
    var end = start;
    while (buf[end] !== 0) end++;
    var len = end - start;
    return [BinaryUtils.readUtf8(buf, start, len), len];
  }

  function readNullAscii(start) {
    var end = start;
    var c;
    while ((c = buf[end]) !== 0) {
      if (c > 127) throw "binary-schema: non-ASCII byte in schema name";
      end++;
    }
    return BinaryUtils.readString(buf, start, end - start);
  }

  function decodeValue(wireType, typeRegistry, depth) {
    if (wireType & 1) {
      switch (wireType) {
        case 1:
          return buf[pos++] === 1;
        case 5: {
          var v = readVarint();
          return v & 1 ? ~(v >>> 1) : v >>> 1;
        }
        case 7:
          return readVarint();
        case 9:
          if (buf[pos] === 0) {
            pos++;
            return 0;
          }
          rotBytes[0] = buf[pos];
          rotBytes[1] = buf[pos + 1];
          rotBytes[2] = buf[pos + 2];
          rotBytes[3] = buf[pos + 3];
          var bits = rotBits[0];
          rotBits[0] = (bits << 23) | (bits >>> 9);
          pos += 4;
          return rotFloat[0];
        case 11: {
          var pair = readNullUtf8(pos);
          pos += pair[1] + 1;
          return pair[0];
        }
        default:
          throw wireType;
      }
    }

    var typeDef = typeRegistry[wireType >>> 1];
    if (typeDef[0] === "enum") {
      var idx = buf[pos++];
      if (idx > 127) throw "binary-schema: enum index out of range";
      return typeDef[2][idx];
    }

    var sub = decodeMessage(buf, pos, typeRegistry, typeDef, depth + 1);
    pos = sub[1];
    return sub[0];
  }

  function decodeMessage(bytes, offset, typeRegistry, fieldDefs, depth) {
    buf = bytes;
    pos = offset;

    var isMsg = fieldDefs[0] === "mesg";
    var fields = fieldDefs[2];
    var fieldMap = fieldDefs[3];
    var result = {};
    var fieldIdx = 1;
    var limit = isMsg ? 1e9 : fields.length;

    while (fieldIdx <= limit) {
      var tag = fieldIdx;
      if (isMsg) {
        tag = readVarint();
        if (tag === 0) break;
      }

      var def = fieldMap.get(tag);
      var wt = def[2];
      var repeated = def[1] === 1;
      var count = repeated ? readVarint() : 1;

      if (wt === 3) {
        if (!repeated) throw "binary-schema: byte blob field must be repeated";
        result[def[3]] = buf.slice(pos, pos + count);
        pos += count;
      } else if (repeated) {
        var arr = new Array(count);
        for (var i = 0; i < count; i++) {
          arr[i] = decodeValue(wt, typeRegistry, depth);
        }
        result[def[3]] = arr;
      } else {
        result[def[3]] = decodeValue(wt, typeRegistry, depth);
      }

      fieldIdx++;
    }

    return [result, pos];
  }

  function parseSchema(bytes) {
    buf = bytes;
    pos = 1;
    var types = [];

    while (pos < bytes.length) {
      var name = readNullAscii(pos);
      pos += name.length + 1;

      var kind = readVarint();
      if (kind > 2) throw "binary-schema: unknown type kind";

      var count = readVarint();
      var fields = new Array(count);
      var fieldMap = new Map();

      for (var i = 0; i < count; i++) {
        var fieldName = readNullAscii(pos);
        pos += fieldName.length + 1;

        var wireType = readVarint();
        var isRepeated = readVarint();
        var fieldTag = readVarint();

        if (kind === 0) {
          fields[i] = fieldName;
        } else {
          var entry = [fieldTag, isRepeated, wireType, fieldName];
          fields[i] = entry;
          fieldMap.set(fieldTag, entry);
        }
      }

      var kindLabel = kind === 0 ? "enum" : kind === 1 ? "strc" : "mesg";
      types.push([kindLabel, name, fields, fieldMap]);
    }

    return types;
  }

  return {
    parseSchema: parseSchema,
    decodeMessage: decodeMessage,
  };
}();

export { BinarySchemaDecoder };
