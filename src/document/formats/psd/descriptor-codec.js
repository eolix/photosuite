/**
 * Photoshop 8BIM / OSType descriptor (de)serializer shared by PSD parsing and
 * Adobe asset loaders. OSType codes and slot keys (`t`, `v`, `classID`) are wire format.
 */

import { BinaryUtils } from "../../../core/binary/binary-utils.js";
import { Rect } from "../../../core/math/rect.js";
import { cornersToHomography, toMatrix2D } from "../../../engine/compositing/homography.js";

/** Reference OSType codes → the OSKey fields each carries, in order. */
const OSTYPE_FIELDS = {
  name: ["classID"],
  prop: ["classID", "keyID"],
  Enmr: ["classID", "typeID", "enum"],
  indx: ["classID"],
};

/**
 * Four-char keys that are nonetheless length-prefixed on the wire (their
 * meaning would otherwise be ambiguous with padded short keys).
 */
const LONG_KEY_WORDS = "warp list Comp xx xy yx yy tx ty PinP PnRt PnOv PnDp xor PuX0 PuX1 PuX2 PuX3 PuY0 PuY1 PuY2 PuY3 base kana ruby box flow trim then else".split(" ");

/** Read a descriptor (name, classID, key/value fields) into `desc`. Returns bytes read. */
function parseDescriptor(data, desc, pos, debug, depth) {
  var startPos = pos;
  var name;
  if (depth == null) depth = 0;
  var nameLen = BinaryUtils.readUint32BE(data, pos);
  if (nameLen == 0) {
    name = "";
    pos += 4;
  } else {
    name = BinaryUtils.readUnicodeName(data, pos);
    pos += 4 + 2 * name.length + 2;
  }
  if (name != "") desc.__name = name;
  desc.classID = readOSKey(data, pos);
  if (debug) console.log("\t".repeat(depth), "- reading descriptor", desc.classID, pos);
  pos += keySize(data, pos);
  var fieldCount = BinaryUtils.readInt32BE(data, pos);
  pos += 4;
  for (var i = 0; i < fieldCount; i++) {
    var fieldKey = readOSKey(data, pos);
    pos += keySize(data, pos);
    var fieldVal = readValue(data, pos, debug, depth);
    desc[fieldKey] = fieldVal;
    pos += fieldVal.size;
    delete fieldVal.size;
  }
  return pos - startPos;
}

/** Write a descriptor. Returns bytes written. */
function writeDescriptor(buf, desc, pos) {
  var startPos = pos;
  var name = desc.__name;
  if (name == null) name = "";
  name += "\0";
  BinaryUtils.writeUnicodeString(buf, pos, name);
  pos += 4 + 2 * name.length;
  writeOSKey(buf, pos, desc.classID);
  pos += keySize(buf.data, pos);
  BinaryUtils.writeInt32(buf, pos, Object.keys(desc).length - 1 - (desc.__name == null ? 0 : 1));
  pos += 4;
  for (var key in desc) {
    if (key == "classID") continue;
    if (key == "__name") continue;
    writeOSKey(buf, pos, key);
    pos += keySize(buf.data, pos);
    pos += writeValue(buf, pos, desc[key]);
  }
  return pos - startPos;
}

/** Read a single typed value node { t, v }. Carries a transient `size` field. */
function readValue(data, pos, debug, depth) {
  var startPos = pos;
  var typeCode = BinaryUtils.readString(data, pos, 4);
  pos += 4;
  var result = { size: 0, t: typeCode, v: null };
  if (debug) console.log("\t".repeat(depth), "reading key", typeCode, startPos);
  switch (typeCode) {
    case "obj ":
    case "VlLs":
      result.v = [];
      var itemCount = BinaryUtils.readUint32BE(data, pos);
      pos += 4;
      for (var i = 0; i < itemCount; i++) {
        var item = readValue(data, pos, debug, depth + 1);
        pos += item.size;
        delete item.size;
        result.v.push(item);
      }
      break;
    case "UntF":
      result.v = { type: BinaryUtils.readString(data, pos, 4), val: BinaryUtils.readFloat64BE(data, pos + 4) };
      pos += 12;
      break;
    case "doub":
      result.v = BinaryUtils.readFloat64BE(data, pos);
      pos += 8;
      break;
    case "bool":
      result.v = data[pos] == 1;
      pos += 1;
      break;
    case "long":
      result.v = BinaryUtils.readInt32BE(data, pos);
      pos += 4;
      break;
    case "comp":
      result.v = BinaryUtils.readInt32BE(data, pos + 4);
      pos += 8;
      break;
    case "Objc":
      result.v = {};
      pos += parseDescriptor(data, result.v, pos, debug, depth + 1);
      break;
    case "TEXT":
      var textLen = BinaryUtils.readUint32BE(data, pos);
      if (textLen == 0) {
        result.v = "";
        pos += 4;
      } else {
        result.v = BinaryUtils.readUnicodeName(data, pos);
        pos += 4 + result.v.length * 2 + 2;
      }
      break;
    case "enum":
      var enumType = readOSKey(data, pos);
      pos += keySize(data, pos);
      var enumVal = readOSKey(data, pos);
      pos += keySize(data, pos);
      result.v = {};
      result.v[enumType] = enumVal;
      break;
    case "tdta":
      var dataLen = BinaryUtils.readInt32BE(data, pos);
      pos += 4;
      result.v = [];
      for (var i = 0; i < dataLen; i++) result.v.push(data[pos + i]);
      pos += dataLen;
      break;
    case "ObAr":
      pos = readObjectArray(data, pos, result);
      break;
    case "Pth ":
      var pathLen = BinaryUtils.readUint32BE(data, pos);
      pos += 4;
      var pathSig = BinaryUtils.readString(data, pos, 4);
      pos += 4;
      pos += 4;
      var pathStr = BinaryUtils.readUnicodeStringLE(data, pos);
      pos += 4 + pathStr.length * 2;
      result.v = { sig: pathSig, pth: pathStr };
      break;
    case "Clss":
    case "type":
    case "rele":
      var clssName = BinaryUtils.readUnicodeName(data, pos);
      pos += 4 + clssName.length * 2 + 2;
      var clssID = readOSKey(data, pos);
      pos += 4 + Math.max(4, clssID.length);
      result.v = { classID: clssID };
      if (clssName != "") result.v.__name = clssName;
      if (typeCode == "rele") {
        result.v.val = BinaryUtils.readInt32BE(data, pos);
        pos += 4;
      }
      break;
    case "prop":
    case "Enmr":
    case "indx":
    case "name":
      var fieldDefs = OSTYPE_FIELDS[typeCode];
      var refName = BinaryUtils.readUnicodeName(data, pos);
      pos += 4 + refName.length * 2 + 2;
      if (refName.length != 0) {
        console.log(typeCode, refName);
        throw "psd-descriptor: unexpected reference name";
      }
      result.v = {};
      for (var i = 0; i < fieldDefs.length; i++) {
        var refFieldVal = readOSKey(data, pos);
        pos += 4 + Math.max(4, refFieldVal.length);
        result.v[fieldDefs[i]] = refFieldVal;
      }
      if (typeCode == "name") {
        var nameVal = BinaryUtils.readUnicodeName(data, pos);
        pos += 4 + nameVal.length * 2 + 2;
        result.v.val = nameVal;
      }
      if (typeCode == "indx") {
        result.v.val = BinaryUtils.readUint32BE(data, pos);
        pos += 4;
      }
      break;
    case "alis":
      var alisLen = BinaryUtils.readUint32BE(data, pos);
      pos += 4;
      result.v = BinaryUtils.readString(data, pos, alisLen);
      pos += alisLen;
      break;
    default:
      console.log("unknown oskey: " + typeCode + ", " + startPos);
      throw "psd-descriptor: unknown OSType " + typeCode;
  }
  if (debug) {
    console.log("\t".repeat(depth), result.v);
    console.log("\t".repeat(depth), "======", pos);
  }
  result.size = pos - startPos;
  return result;
}

/** Read an ObAr (object array of per-channel float lists) into result.v. Returns pos. */
function readObjectArray(data, pos, result) {
  var arrCount = BinaryUtils.readUint32BE(data, pos);
  pos += 4;
  var arrName = BinaryUtils.readUnicodeName(data, pos);
  pos += 4 + 2 * arrName.length + 2;
  if (arrName != "") throw arrName;
  var arrClassID = readOSKey(data, pos);
  pos += 4 + Math.max(4, arrClassID.length);
  result.v = { classID: arrClassID, arr: [] };
  var channelCount = BinaryUtils.readUint32BE(data, pos);
  pos += 4;
  for (var i = 0; i < channelCount; i++) {
    var chID = readOSKey(data, pos);
    pos += 4 + Math.max(4, chID.length);
    var chType = BinaryUtils.readString(data, pos, 4);
    pos += 4;
    var chUID = BinaryUtils.readString(data, pos, 4);
    pos += 4;
    var ch = { id: chID, type: chType, uID: chUID, arr: [] };
    result.v.arr.push(ch);
    var valueCount = BinaryUtils.readUint32BE(data, pos, 4);
    pos += 4;
    for (var j = 0; j < valueCount; j++) {
      ch.arr.push(BinaryUtils.readFloat64BE(data, pos));
      pos += 8;
    }
  }
  return pos;
}

/** Write a single typed value node. Returns bytes written. */
function writeValue(buf, pos, node) {
  var startPos = pos;
  var typeCode = node.t;
  var value = node.v;
  BinaryUtils.writeAscii(buf, pos, typeCode);
  pos += 4;
  switch (typeCode) {
    case "obj ":
    case "VlLs":
      BinaryUtils.writeInt32(buf, pos, value.length);
      pos += 4;
      for (var i = 0; i < value.length; i++) pos += writeValue(buf, pos, value[i]);
      break;
    case "UntF":
      BinaryUtils.writeAscii(buf, pos, value.type);
      BinaryUtils.writeFloat64BE(buf, pos + 4, value.val);
      pos += 12;
      break;
    case "doub":
      BinaryUtils.writeFloat64BE(buf, pos, value);
      pos += 8;
      break;
    case "bool":
      BinaryUtils.fillBytes(buf, pos, value ? 1 : 0, 1);
      pos += 1;
      break;
    case "long":
      BinaryUtils.writeInt32(buf, pos, value);
      pos += 4;
      break;
    case "comp":
      BinaryUtils.writeInt32(buf, pos + 4, value);
      pos += 8;
      break;
    case "Objc":
      pos += writeDescriptor(buf, value, pos);
      break;
    case "TEXT":
      BinaryUtils.writeUnicodeString(buf, pos, value + "\0");
      pos += 4 + value.length * 2 + 2;
      break;
    case "enum":
      var enumType = Object.keys(value)[0];
      var enumVal = value[enumType];
      writeOSKey(buf, pos, enumType);
      pos += keySize(buf.data, pos);
      writeOSKey(buf, pos, enumVal);
      pos += keySize(buf.data, pos);
      break;
    case "tdta":
      BinaryUtils.writeSize(buf, pos, value.length);
      pos += 4;
      BinaryUtils.writeBytes(buf, pos, value);
      pos += value.length;
      break;
    case "ObAr":
      BinaryUtils.writeSize(buf, pos, value.arr[0].arr.length);
      pos += 4;
      BinaryUtils.writeUnicodeString(buf, pos, "\0");
      pos += 6;
      writeOSKey(buf, pos, value.classID);
      pos += 4 + Math.max(4, value.classID.length);
      BinaryUtils.writeSize(buf, pos, value.arr.length);
      pos += 4;
      for (var i = 0; i < value.arr.length; i++) {
        var ch = value.arr[i];
        writeOSKey(buf, pos, ch.id);
        pos += 4 + Math.max(4, ch.id.length);
        BinaryUtils.writeAscii(buf, pos, ch.type);
        pos += 4;
        BinaryUtils.writeAscii(buf, pos, ch.uID);
        pos += 4;
        BinaryUtils.writeSize(buf, pos, ch.arr.length);
        pos += 4;
        for (var j = 0; j < ch.arr.length; j++) {
          BinaryUtils.writeFloat64BE(buf, pos, ch.arr[j]);
          pos += 8;
        }
      }
      break;
    case "Pth ":
      var pathByteLen = value.pth.length * 2 + 4 + 8;
      BinaryUtils.writeSize(buf, pos, pathByteLen);
      pos += 4;
      BinaryUtils.writeAscii(buf, pos, value.sig);
      pos += 4;
      BinaryUtils.writeFloat32(buf, pos, pathByteLen);
      pos += 4;
      BinaryUtils.writeUnicodeStringLE(buf, pos, value.pth);
      pos += value.pth.length * 2 + 4;
      break;
    case "Clss":
    case "type":
    case "rele":
      var clssName = value.__name;
      if (clssName == null) clssName = "";
      BinaryUtils.writeUnicodeString(buf, pos, clssName + "\0");
      pos += 4 + clssName.length * 2 + 2;
      var clssID = value.classID;
      writeOSKey(buf, pos, clssID);
      pos += 4 + Math.max(4, clssID.length);
      if (typeCode == "rele") {
        BinaryUtils.writeInt32(buf, pos, value.val);
        pos += 4;
      }
      break;
    case "prop":
    case "Enmr":
    case "indx":
    case "name":
      var fieldDefs = OSTYPE_FIELDS[typeCode];
      BinaryUtils.writeSize(buf, pos, 1);
      pos += 6;
      for (var i = 0; i < fieldDefs.length; i++) {
        var refFieldVal = value[fieldDefs[i]];
        writeOSKey(buf, pos, refFieldVal);
        pos += 4 + Math.max(4, refFieldVal.length);
      }
      if (typeCode == "name") {
        BinaryUtils.writeUnicodeString(buf, pos, value.val + "\0");
        pos += 4 + value.val.length * 2 + 2;
      }
      if (typeCode == "indx") {
        BinaryUtils.writeSize(buf, pos, value.val);
        pos += 4;
      }
      break;
    case "alis":
      var alisLen = value.length;
      BinaryUtils.writeSize(buf, pos, alisLen);
      pos += 4;
      BinaryUtils.writeAscii(buf, pos, value);
      pos += alisLen;
      break;
    default:
      console.log("unknown oskey: " + typeCode);
      pos = startPos;
      break;
  }
  return pos - startPos;
}

/** Read a 4-char (or length-prefixed) OSType key. */
function readOSKey(data, pos) {
  var len = BinaryUtils.readInt32BE(data, pos);
  if (len > 1e3) throw "psd-descriptor: OSKey length out of range";
  if (len == 0) len = 4;
  return BinaryUtils.readString(data, pos + 4, len).trim();
}

/** Byte size of the OSType key at `pos` (4-byte padded, or 4 + length). */
function keySize(data, pos) {
  var len = BinaryUtils.readInt32BE(data, pos);
  return len == 0 ? 8 : 4 + len;
}

/** Write an OSType key, length-prefixing long keys and space-padding short ones. */
function writeOSKey(buf, pos, key) {
  var isLong = 4 < key.length || LONG_KEY_WORDS.indexOf(key) != -1;
  BinaryUtils.writeInt32(buf, pos, isLong ? key.length : 0);
  BinaryUtils.writeAscii(buf, pos + 4, key);
  if (key.length < 4 && !isLong) {
    var padding = "";
    for (var i = key.length; i < 4; i++) padding += " ";
    BinaryUtils.writeAscii(buf, pos + 4 + key.length, padding);
  }
}

/** Recursively strip type tags from a descriptor into a plain-value object. */
function flattenDescriptor(desc) {
  var result = {};
  for (var key in desc) {
    if (key == "classID") result[key] = desc[key];
    else if (key == "__name") result[key] = desc[key];
    else result[key] = flattenValue(desc[key]);
  }
  return result;
}

/** Recursively strip type tags from a value node into its plain value. */
function flattenValue(node) {
  if (node.t == "Objc") return flattenDescriptor(node.v);
  if (node.t == "VlLs") {
    var arr = [];
    for (var i = 0; i < node.v.length; i++) arr.push(flattenValue(node.v[i]));
    return arr;
  }
  if (node.t == "UntF") return node.v.val;
  return node.v;
}

const DescriptorCodec = {
  parseDescriptor,
  writeDescriptor,
  readValue,
  writeValue,
  readOSKey,
  writeOSKey,
  keySize,
  osTypeFields: OSTYPE_FIELDS,
  flattenDescriptor,
  flattenValue,
};

export { DescriptorCodec };

/** Deserialize a PSD doubles list descriptor to a flat number array. */
export function unpackDoublesList(descriptorList) {
  const values = [];
  const count = descriptorList.v.length;
  for (let idx = 0; idx < count; idx++) {
    values.push(descriptorList.v[idx].v);
  }
  return values;
}

/** Serialize a flat number array to a PSD doubles list descriptor. */
export function packDoublesList(values) {
  const descriptorList = {
    t: "VlLs",
    v: [],
  };
  for (let idx = 0; idx < values.length; idx++) {
    descriptorList.v.push({
      t: "doub",
      v: values[idx],
    });
  }
  return descriptorList;
}

/**
 * The placement matrix of a smart object or placed layer: its Trnf corner quad
 * mapped onto the size it was placed at.
 */
export function placedTransformToMatrix(transformDescriptor) {
  const unpackedCorners = unpackDoublesList(transformDescriptor.Trnf);
  const sizeDescriptor = transformDescriptor.Sz.v;
  const homographyMatrix = cornersToHomography(
    unpackedCorners,
    new Rect(0, 0, sizeDescriptor.Wdth.v, sizeDescriptor.Hght.v),
  );
  return toMatrix2D(homographyMatrix);
}
