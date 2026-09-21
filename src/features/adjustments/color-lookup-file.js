// Feature: load an external colour-lookup file (.cube / .3dl / .icc / .look) and
// build a colour-LUT adjustment descriptor. Surfaced via the resource picker.
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { RenderBuffer } from "../../core/render-buffer.js";

const ColorLookupParser = {};

/**
 * Parse a LUT / ICC buffer into a colour-lookup descriptor list for the resource picker.
 */
ColorLookupParser.parse = function(rawBuffer, filename) {
  let data = new Uint8Array(rawBuffer);
  let format = detectLookupFormat(data, filename);
  if (format != "icc") {
    const parsed = ColorLookupParser.parseLUTText(data, format);
    const iccData = ColorLookupParser.buildIccProfile(parsed[0], parsed[1]);
    data = iccData
  }
  return [buildColorLookupDescriptor(data, filename)]
};

/** Return the embedded ICC profile bytes from a colour-lookup descriptor list. */
ColorLookupParser.serialize = function(descriptorArr) {
  const desc = descriptorArr[0];
  const bytes = new Uint8Array(desc.profile.v);
  return bytes.buffer
};

/** Set the display name on a colour-lookup descriptor. */
ColorLookupParser.setName = function(desc, name) {
  desc.Nm.v = name
};

/**
 * Wrap a 3D LUT as a minimal ICC profile with desc + A2B0 (mAB) tags.
 */
ColorLookupParser.buildIccProfile = function(lutSize, lutData) {
  const buf = new RenderBuffer;
  let pos = 128;
  buf.ensureCapacity(0, 128);
  const headerBytes = [0, 0, 14, 204, 65, 68, 66, 69, 4, 0, 0, 0, 108, 105, 110, 107, 82, 71, 66, 32, 82, 71, 66, 32, 7, 227, 0, 7, 0, 27, 0, 8, 0, 6, 0, 49, 97, 99, 115, 112, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 246, 214, 0, 1, 0, 0, 0, 0, 211, 45, 65, 68, 66, 69, 219, 126, 245, 21, 206, 223, 186, 23, 165, 212, 201, 219, 250, 10, 33, 62];
  for (let i = 0; i < headerBytes.length; i++) buf.data[i] = headerBytes[i];
  const tagNames = ["desc", "A2B0"];
  const tagCount = tagNames.length;
  let tagDataStart = 128 + 4 + tagCount * 12;
  BinaryUtils.writeSize(buf, pos, tagCount);
  pos += 4;
  for (let j = 0; j < tagCount; j++) {
    const tagName = tagNames[j];
    BinaryUtils.writeAscii(buf, pos, tagName);
    pos += 4;
    BinaryUtils.writeSize(buf, pos, tagDataStart);
    pos += 4;
    let tagPos = tagDataStart;
    if (tagName == "desc") tagPos = writeIccDescTag(buf, tagPos);
    if (tagName == "A2B0") tagPos = writeIccA2B0Tag(buf, tagPos, tagDataStart, lutSize, lutData);
    let tagSize = tagPos - tagDataStart;
    while ((tagSize & 3) != 0) tagSize++;
    BinaryUtils.writeSize(buf, pos, tagSize);
    pos += 4;
    tagDataStart += tagSize
  }
  BinaryUtils.writeSize(buf, 0, tagDataStart);
  return buf.data.slice(0, tagDataStart)
};

/**
 * Parse .cube / .3dl / .look text into lutSize plus flat RGB sample values.
 */
ColorLookupParser.parseLUTText = function(data, format) {
  format = "LUTFormat" + format.toUpperCase();
  const text = BinaryUtils.readUtf8(data, 0, data.length);
  let eol = detectTextLineEnding(data);
  if (format == "LUTFormatCUBE") return parseCubeLutText(text, eol);
  if (format == "LUTFormat3DL") return parse3dlLutText(text, eol);
  if (format == "LUTFormatLOOK") return parseLookLutText(text);
  throw new Error("Unsupported colour-lookup format: " + format)
};

/** Serialize a flat RGB LUT to Adobe .cube text. */
ColorLookupParser.serializeCube = function(lutData, lutSize, title) {
  const lines = ["#Created by PhotoSuite", "TITLE \"" + title + "\"", "", "#LUT size", "LUT_3D_SIZE " + lutSize, "", "#data domain", "DOMAIN_MIN 0.0 0.0 0.0", "DOMAIN_MAX 1.0 1.0 1.0", "", "#LUT data points"];
  const precision = 6;
  for (let i = 0; i < lutData.length; i += 3) {
    lines.push(lutData[i].toFixed(precision) + " " + lutData[i + 1].toFixed(precision) + " " + lutData[i + 2].toFixed(precision))
  }
  lines.push("");
  return BinaryUtils.encodeUtf8(lines.join("\n")).buffer;
};

/** Transpose a size³ RGB lattice from blue-major to red-major indexing. */
ColorLookupParser.transposeAxes = function(size, input) {
  const output = [];
  const voxelCount = size * size * size;
  for (let i = 0; i < voxelCount; i++) output.push(0, 0, 0);
  for (let r = 0; r < size; r++)
    for (let g = 0; g < size; g++)
      for (let blueIdx = 0; blueIdx < size; blueIdx++) {
        const srcIdx = 3 * (blueIdx + g * size + r * size * size);
        const dstIdx = 3 * (r + g * size + blueIdx * size * size);
        output[dstIdx] = input[srcIdx];
        output[dstIdx + 1] = input[srcIdx + 1];
        output[dstIdx + 2] = input[srcIdx + 2]
      }
  return output
};

export { ColorLookupParser };

function detectLookupFormat(data, filename) {
  const lowerName = filename ? String(filename).toLowerCase() : "";
  // Filename wins when present — asset misses often return HTML (leading '<'),
  // which would otherwise be mistaken for a .look XML LUT.
  if (lowerName.endsWith(".cube")) return "cube";
  if (lowerName.endsWith(".3dl")) return "3DL";
  if (lowerName.endsWith(".look")) return "look";
  if (lowerName.endsWith(".icc") || lowerName.endsWith(".icm")) return "icc";
  if (BinaryUtils.readUint32BE(data, 0) == data.length) return "icc";
  if (data[0] == "<".charCodeAt(0)) return "look";
  if (BinaryUtils.indexOfBytes(data, "LUT_3D_SIZE") != -1) return "cube";
  return "3DL"
}

function detectTextLineEnding(data) {
  let eol = "";
  for (let i = 0; i < data.length && eol == ""; i++) {
    if (data[i] == 10) eol = "\n";
    else if (data[i] == 13) {
      eol = "\r";
      if (data[i + 1] == 10) eol += "\n"
    }
  }
  return eol
}

function buildColorLookupDescriptor(profileBytes, filename) {
  const bytes = [];
  for (let i = 0; i < profileBytes.length; i++) bytes.push(profileBytes[i]);
  return {
    classID: "null",
    Dthr: {
      t: "bool",
      v: true
    },
    Nm: {
      t: "TEXT",
      v: filename ? filename : "file.icc"
    },
    lookupType: {
      t: "enum",
      v: {
        colorLookupType: "abstractProfile"
      }
    },
    profile: {
      t: "tdta",
      v: bytes
    }
  }
}

function writeIccDescTag(buf, tagPos) {
  BinaryUtils.writeAscii(buf, tagPos, "mluc");
  tagPos += 4;
  tagPos += 4;
  BinaryUtils.writeSize(buf, tagPos, 1);
  tagPos += 4;
  BinaryUtils.writeSize(buf, tagPos, 12);
  tagPos += 4;
  BinaryUtils.writeAscii(buf, tagPos, "enUS");
  tagPos += 4;
  const descText = "ICC by PhotoSuite\0";
  const descTextByteLen = descText.length * 2 + 2;
  BinaryUtils.writeSize(buf, tagPos, descTextByteLen);
  tagPos += 4;
  BinaryUtils.writeSize(buf, tagPos, 28);
  tagPos += 4;
  buf.ensureCapacity(tagPos, descTextByteLen);
  for (let i = 0; i < descText.length; i++) buf.data[tagPos + i * 2 + 1] = descText.charCodeAt(i);
  tagPos += descTextByteLen;
  return tagPos
}

function writeIccA2B0Tag(buf, tagPos, tagDataStart, lutSize, lutData) {
  BinaryUtils.writeAscii(buf, tagPos, "mAB ");
  tagPos += 4;
  tagPos += 4;
  buf.ensureCapacity(tagPos, 4);
  buf.data[tagPos] = 3;
  buf.data[tagPos + 1] = 3;
  tagPos += 4;
  buf.ensureCapacity(tagPos, 4 * 5);
  tagPos += 4 * 3;
  BinaryUtils.writeSize(buf, tagPos, tagPos + 8 - tagDataStart);
  tagPos += 4;
  tagPos += 4;
  buf.ensureCapacity(tagPos, 20);
  buf.data[tagPos] = lutSize;
  buf.data[tagPos + 1] = lutSize;
  buf.data[tagPos + 2] = lutSize;
  tagPos += 16;
  buf.data[tagPos] = 2;
  tagPos += 4;
  const lutDataCount = lutSize * lutSize * lutSize * 3;
  buf.ensureCapacity(tagPos, lutDataCount * 2);
  for (let i = 0; i < lutDataCount; i++) BinaryUtils.writeUint16Raw(buf.data, tagPos + i * 2, Math.max(0, Math.min(65535, Math.round(lutData[i] * 65535))));
  tagPos += lutDataCount * 2;
  return tagPos
}

function parseCubeLutText(text, eol) {
  const values = [];
  let lutSize = 0;
  const lines = text.split(eol);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] == "" || lines[i][0] == "#") continue;
    const fields = lines[i].split(" ");
    const keyword = fields[0];
    if (keyword == "LUT_3D_SIZE") {
      lutSize = parseInt(fields[1]);
      continue
    }
    if (["TITLE", "DOMAIN_MIN", "DOMAIN_MAX"].indexOf(keyword) != -1) continue;
    values.push(parseFloat(fields[0]), parseFloat(fields[1]), parseFloat(fields[2]))
  }
  return [lutSize, ColorLookupParser.transposeAxes(lutSize, values)]
}

function parse3dlLutText(text, eol) {
  const values = [];
  let lutSize = 0;
  const lines = text.split(eol);
  const factor = 1 / 4095;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line == "" || line == "3DMESH" || line.startsWith("Mesh") || line[0] == "#") continue;
    const fields = line.split(" ");
    if (lutSize == 0) {
      lutSize = fields.length;
      continue
    }
    values.push(parseFloat(fields[0]) * factor, parseFloat(fields[1]) * factor, parseFloat(fields[2]) * factor)
  }
  return [lutSize, values]
}

function parseLookLutText(text) {
  const values = [];
  const xmlParser = new DOMParser;
  const xmlDoc = xmlParser.parseFromString(text, "text/xml");
  const lutNode = xmlDoc.getElementsByTagName("LUT")[0];
  const sizeJson = lutNode.children[0].textContent;
  let lutSize = parseInt(JSON.parse(sizeJson));
  let dataHex = lutNode.children[1].textContent;
  dataHex = dataHex.replace(/"/g, "").replace(/\s/g, "");
  const totalComponents = 3 * lutSize * lutSize * lutSize;
  const totalBytes = totalComponents * 4;
  const hexBytes = new Uint8Array(totalBytes);
  for (let i = 0; i < totalBytes; i++) {
    const hexCharHi = dataHex.charCodeAt(i * 2);
    const hexCharLo = dataHex.charCodeAt(i * 2 + 1);
    const hiNibble = hexCharHi < 58 ? hexCharHi - 48 : hexCharHi - 55;
    const loNibble = hexCharLo < 58 ? hexCharLo - 48 : hexCharLo - 55;
    hexBytes[i] = (hiNibble << 4) + loNibble
  }
  for (let i = 0; i < totalComponents; i++) values.push(BinaryUtils.readFloat32LE(hexBytes, i << 2));
  return [lutSize, ColorLookupParser.transposeAxes(lutSize, values)]
}
