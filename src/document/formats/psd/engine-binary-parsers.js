/**
 * Photoshop text-engine binary parsers: EngineData (`<< /Key value >>` in TySh)
 * and BinaryTree typed scalar trees.
 */

import { BinaryUtils } from "../../../core/binary/binary-utils.js";


/** Whether a byteVal is EngineData/tree whitespace (tab, newline, space). */
function isFormatWhitespace(byteVal) {
  return byteVal == 9 || byteVal == 10 || byteVal == 32;
}

/** Advance past run of whitespace bytes. */
function skipWhitespace(source, pos) {
  while (source[pos] == " ".charCodeAt(0) || source[pos] == "\t".charCodeAt(0) || source[pos] == "\n".charCodeAt(0)) pos++;
  return pos;
}

// ---------------------------------------------------------------------------
// EngineData  (<< /Key value >>)
// ---------------------------------------------------------------------------

function parseEngineData(source) {
  var result = {};
  parseEngineDict(source, result, 0, 0);
  return result;
}

function serializeEngineData(dict, buf) {
  return writeEngineDict(dict, buf, 0, 0);
}

function parseEngineDict(source, dict, pos, depth) {
  while (source[pos] != "<".charCodeAt(0)) pos++;
  pos += 2;
  while (true) {
    if (source[pos] == "/".charCodeAt(0)) {
      pos++;
      var spaceIdx = BinaryUtils.indexOf(source, " ".charCodeAt(0), pos, pos + 50);
      var newlineIdx = BinaryUtils.indexOf(source, "\n".charCodeAt(0), pos, pos + 50);
      if (newlineIdx == -1) newlineIdx = Infinity;
      if (spaceIdx == -1) spaceIdx = Infinity;
      var endIdx = Math.min(newlineIdx, spaceIdx);
      var key = BinaryUtils.readString(source, pos, endIdx - pos);
      var parsed = parseEngineValue(source, endIdx + 1, depth + 1, key);
      dict[key] = parsed.value;
      pos = endIdx + 1;
      pos += parsed.size;
    } else if (source[pos] == ">".charCodeAt(0)) {
      pos += 2;
      break;
    } else {
      var byteVal = source[pos];
      if (byteVal == 10 || byteVal == 9 || byteVal == 32) {
        pos++;
      } else {
        console.log("unknown byte: " + byteVal + ", char: " + String.fromCharCode(byteVal), pos);
        pos++;
      }
    }
  }
  return pos;
}

function writeEngineDict(dict, buf, pos, depth) {
  BinaryUtils.writeAscii(buf, pos, "<<\n");
  pos += 3;
  for (var key in dict) {
    BinaryUtils.fillBytes(buf, pos, "\t".charCodeAt(0), depth + 1);
    pos += depth + 1;
    BinaryUtils.writeAscii(buf, pos, "/" + key);
    pos += 1 + key.length;
    if (isEnginePrimitive(dict[key]) || dict[key] instanceof Array) {
      BinaryUtils.writeAscii(buf, pos, " ");
      pos++;
    } else {
      BinaryUtils.writeAscii(buf, pos, "\n");
      pos++;
      BinaryUtils.fillBytes(buf, pos, "\t".charCodeAt(0), depth + 1);
      pos += depth + 1;
    }
    pos = writeEngineValue(dict[key], buf, pos, depth + 1);
    BinaryUtils.writeAscii(buf, pos, "\n");
    pos++;
  }
  BinaryUtils.fillBytes(buf, pos, "\t".charCodeAt(0), depth);
  pos += depth;
  BinaryUtils.writeAscii(buf, pos, ">>");
  pos += 2;
  return pos;
}

function parseEngineValue(source, pos, depth, key) {
  var startPos = pos;
  var result = { size: 0, value: 0 };
  while (true) {
    pos = skipWhitespace(source, pos);
    if (source[pos] == "<".charCodeAt(0)) {
      result.value = {};
      pos = parseEngineDict(source, result.value, pos, depth + 1);
      break;
    } else if (source[pos] == "(".charCodeAt(0)) {
      pos += 3;
      var end = pos;
      while (true) {
        if (source[end - 1] != "\\".charCodeAt(0) && source[end] == ")".charCodeAt(0) && (source[end + 1] == "\n".charCodeAt(0) || source[end + 1] == " ".charCodeAt(0))) break;
        else end++;
      }
      result.value = BinaryUtils.readPdfString(source, pos, end);
      pos = end + 2;
      break;
    } else if (source[pos] == "[".charCodeAt(0)) {
      pos++;
      result.value = [];
      pos = skipWhitespace(source, pos);
      while (source[pos] != "]".charCodeAt(0)) {
        var item = parseEngineValue(source, pos, depth + 1, key);
        result.value.push(item.value);
        pos += item.size;
        pos = skipWhitespace(source, pos);
      }
      pos++;
      break;
    } else {
      var spaceIdx = BinaryUtils.indexOf(source, " ".charCodeAt(0), pos, pos + 50);
      var newlineIdx = BinaryUtils.indexOf(source, "\n".charCodeAt(0), pos, pos + 50);
      if (newlineIdx == -1) newlineIdx = Infinity;
      if (spaceIdx == -1) spaceIdx = Infinity;
      var token = BinaryUtils.readString(source, pos, Math.min(spaceIdx, newlineIdx) - pos).trim();
      var numVal = parseFloat(token);
      if (!isNaN(numVal)) {
        result.value = parseFloat(token);
        pos = Math.min(spaceIdx, newlineIdx) + 1;
        break;
      } else if (token == "true" || token == "false") {
        result.value = token == "true";
        pos = Math.min(spaceIdx, newlineIdx) + 1;
        break;
      } else if (token == "null" || token == "NaN" || token == "undefined") {
        result.value = 0;
        pos = Math.min(spaceIdx, newlineIdx) + 1;
        break;
      } else {
        console.log("unknown identifier: " + token);
        throw "engine-data: unknown identifier " + token;
      }
    }
  }
  result.size = pos - startPos;
  return result;
}

function writeEngineValue(value, buf, pos, depth) {
  if (value instanceof Array) {
    var isFlat = value.length == 0 || typeof value[0] == "number";
    if (isFlat) {
      BinaryUtils.writeAscii(buf, pos, "[ ");
      pos += 2;
      for (var i = 0; i < value.length; i++) {
        var str = value[i] + " ";
        BinaryUtils.writeAscii(buf, pos, str);
        pos += str.length;
      }
      BinaryUtils.writeAscii(buf, pos, "]");
      pos += 1;
    } else {
      BinaryUtils.writeAscii(buf, pos, "[\n");
      pos += 2;
      for (var i = 0; i < value.length; i++) {
        BinaryUtils.fillBytes(buf, pos, "\t".charCodeAt(0), depth);
        pos += depth;
        pos = writeEngineValue(value[i], buf, pos, depth);
        BinaryUtils.writeAscii(buf, pos, "\n");
        pos++;
      }
      BinaryUtils.fillBytes(buf, pos, "\t".charCodeAt(0), depth);
      pos += depth;
      BinaryUtils.writeAscii(buf, pos, "]");
      pos += 1;
    }
  } else if (value instanceof Object) {
    pos = writeEngineDict(value, buf, pos, depth);
  } else if (typeof value == "string") {
    BinaryUtils.writeAscii(buf, pos, "(");
    pos++;
    BinaryUtils.fillBytes(buf, pos, 254);
    pos++;
    BinaryUtils.fillBytes(buf, pos, 255);
    pos++;
    pos = BinaryUtils.writePdfString(buf, pos, value);
    BinaryUtils.writeAscii(buf, pos, ")");
    pos += 1;
  } else {
    var str = value + "";
    BinaryUtils.writeAscii(buf, pos, str);
    pos += str.length;
  }
  return pos;
}

function isEnginePrimitive(value) {
  var type = typeof value;
  return type == "string" || type == "number" || type == "boolean";
}

const EngineDataParser = {
  parse: parseEngineData,
  serialize: serializeEngineData,
  parseDict: parseEngineDict,
  writeDict: writeEngineDict,
  parseValue: parseEngineValue,
  writeValue: writeEngineValue,
  isPrimitive: isEnginePrimitive,
};

// ---------------------------------------------------------------------------
// BinaryTree  (typed variant; scalars carry a one-char type prefix)
// ---------------------------------------------------------------------------

function parseBinaryTree(source) {
  var result = {};
  parseTreeEntries(source, result, 0, 0);
  return result;
}

function serializeBinaryTree(dict, buf) {
  var pos = 0;
  BinaryUtils.writeAscii(buf, pos, " ");
  pos++;
  pos = writeTreeEntries(dict, buf, pos, 0);
  pos--;
  buf.ensureCapacity(pos, 2);
  buf.data[pos] = buf.data[pos + 1] = 0;
  pos += 2;
  return pos;
}

function parseTreeDict(source, dict, pos, depth) {
  while (source[pos] != "<".charCodeAt(0)) pos++;
  pos += 2;
  return parseTreeEntries(source, dict, pos, depth);
}

function writeTreeDict(dict, buf, pos, depth) {
  BinaryUtils.writeAscii(buf, pos, "<< ");
  pos += 3;
  pos = writeTreeEntries(dict, buf, pos, depth);
  BinaryUtils.writeAscii(buf, pos, ">>");
  pos += 2;
  return pos;
}

function parseTreeEntries(source, dict, pos, depth) {
  while (true) {
    while (isFormatWhitespace(source[pos]) || source[pos] == 0) pos++;
    if (pos >= source.length) break;
    if (source[pos] == "/".charCodeAt(0)) {
      pos++;
      var keyStart = pos;
      while (!isFormatWhitespace(source[keyStart])) keyStart++;
      var key = BinaryUtils.readString(source, pos, keyStart - pos);
      pos = keyStart + 1;
      var parsed = parseTreeValue(source, pos, depth, key);
      dict["_" + key] = parsed.value;
      pos += parsed.size;
    } else if (source[pos] == ">".charCodeAt(0)) {
      pos += 2;
      break;
    } else {
      var byteVal = source[pos];
      console.log(BinaryUtils.readString(source, pos, pos + 100));
      console.log("unknown byte: " + byteVal + ", char: " + String.fromCharCode(byteVal) + ", offset: " + pos);
      pos++;
      throw "binary-tree: unknown byte " + byteVal;
    }
  }
  return pos;
}

function writeTreeEntries(dict, buf, pos, depth) {
  for (var prop in dict) {
    var key = prop.substring(1, prop.length);
    BinaryUtils.writeAscii(buf, pos, "/" + key);
    pos += 1 + key.length;
    BinaryUtils.writeAscii(buf, pos, " ");
    pos++;
    pos = writeTreeValue(dict[prop], buf, pos, depth + 1);
    BinaryUtils.writeAscii(buf, pos, " ");
    pos++;
  }
  return pos;
}

function parseTreeValue(source, pos, depth, key) {
  var startPos = pos;
  var result = { type: "", size: 0, value: 0 };
  while (isFormatWhitespace(source[pos])) pos++;
  if (source[pos] == "<".charCodeAt(0)) {
    result.type = "Object";
    result.value = {};
    pos = parseTreeDict(source, result.value, pos, depth + 1);
  } else if (source[pos] == "(".charCodeAt(0)) {
    result.type = "String";
    pos++;
    if (source[pos] == ")".charCodeAt(0)) {
      result.value = "s";
      pos++;
    } else {
      pos += 2;
      var end = pos;
      while (true) {
        if (source[end] == ")".charCodeAt(0) && source[end - 1] != "\\".charCodeAt(0)) break;
        else end += 1;
      }
      result.value = "s" + BinaryUtils.readPdfString(source, pos, end);
      pos = end + 2;
    }
  } else if (source[pos] == "[".charCodeAt(0)) {
    pos++;
    result.value = [];
    result.type = "Array";
    while (isFormatWhitespace(source[pos])) pos++;
    while (source[pos] != "]".charCodeAt(0)) {
      var item = parseTreeValue(source, pos, depth + 1, key);
      if (item == -1) return -1;
      result.value.push(item.value);
      pos += item.size;
      delete item.size;
      while (isFormatWhitespace(source[pos])) pos++;
    }
    pos++;
  } else {
    var tokenStart = pos;
    while (!isFormatWhitespace(source[tokenStart])) tokenStart++;
    var token = BinaryUtils.readString(source, pos, tokenStart - pos);
    var numVal = parseFloat(token);
    if (!isNaN(numVal) && token.indexOf(".") != -1) {
      result.type = "Float";
      result.value = "f" + parseFloat(token);
    } else if (!isNaN(numVal) && token.indexOf(".") == -1) {
      result.type = "Integer";
      result.value = "i" + parseInt(token);
    } else if (token == "true" || token == "false") {
      result.type = "Boolean";
      result.value = token == "true";
    } else if (token.charAt(0) == "/") {
      result.type = "BString";
      result.value = token;
    } else if (token == "NaN") {
      result.type = "Float";
      result.value = "f0";
    } else {
      console.log("unknown value", JSON.stringify(token));
      throw "binary-tree: unknown value " + token;
    }
    pos = tokenStart + 1;
  }
  result.size = pos - startPos;
  return result;
}

function formatTreeFloat(value) {
  if (value == Math.round(value)) return value + ".0";
  var str = value.toFixed(5);
  if (0 < value && value < 1) str = str.substring(1, str.length);
  if (-1 < value && value < 0) str = "-" + str.substring(2, str.length);
  return str;
}

function writeTreeValue(value, buf, pos, depth) {
  var typePrefix = typeof value == "string" ? value.charAt(0) : "";
  if (value instanceof Array) {
    BinaryUtils.writeAscii(buf, pos, "[ ");
    pos += 2;
    for (var i = 0; i < value.length; i++) {
      pos = writeTreeValue(value[i], buf, pos, depth);
      BinaryUtils.writeAscii(buf, pos, " ");
      pos++;
    }
    BinaryUtils.writeAscii(buf, pos, "]");
    pos += 1;
  } else if (value instanceof Object) {
    pos = writeTreeDict(value, buf, pos, depth);
  } else if (typePrefix == "s") {
    BinaryUtils.writeAscii(buf, pos, "(");
    pos++;
    BinaryUtils.fillBytes(buf, pos, 254);
    pos++;
    BinaryUtils.fillBytes(buf, pos, 255);
    pos++;
    pos = BinaryUtils.writePdfString(buf, pos, value.substring(1));
    BinaryUtils.writeAscii(buf, pos, ")");
    pos++;
  } else if (typePrefix == "/") {
    BinaryUtils.writeAscii(buf, pos, value);
    pos += value.length;
  } else if (typePrefix == "f") {
    var str = formatTreeFloat(parseFloat(value.substring(1)));
    BinaryUtils.writeAscii(buf, pos, str);
    pos += str.length;
  } else if (typePrefix == "i") {
    BinaryUtils.writeAscii(buf, pos, value.substring(1));
    pos += value.length - 1;
  } else {
    var str = value + "";
    BinaryUtils.writeAscii(buf, pos, str);
    pos += str.length;
  }
  return pos;
}

const BinaryTreeParser = {
  parse: parseBinaryTree,
  serialize: serializeBinaryTree,
  parseDict: parseTreeDict,
  writeDict: writeTreeDict,
  parseEntries: parseTreeEntries,
  writeEntries: writeTreeEntries,
  parseValue: parseTreeValue,
  writeValue: writeTreeValue,
  isWhitespace: isFormatWhitespace,
  formatFloat: formatTreeFloat,
};

export { EngineDataParser, BinaryTreeParser };