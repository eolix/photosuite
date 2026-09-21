// Photoshop tool-preset library (.tpl). The file is an 8BTP envelope of 8BIM
// chunks: patterns (tppa), samples (tpbd), named tool descriptors (tptp),
// plus optional shape (tpsh) and style (tpst) sections on read.
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { RenderBuffer } from "../../core/render-buffer.js";
import { DescriptorCodec } from "../../document/formats/psd/descriptor-codec.js";
import { normalizeLayerEffectsOnRead } from "../../document/formats/psd/psd-layer-effects.js";
import { parseSampleList, writeSampleList } from "../../document/formats/psd/sample-list-codec.js";
import { PatternParser } from "../../document/formats/psd/layer-data-parsers.js";
import { ShapeFile } from "../shape/shape-file.js";

const FILE_SIGNATURE = "8BTP";
const CHUNK_SIGNATURE = "8BIM";
const WRITE_VERSION = 3;
const WRITE_COUNT = 1;
const DESCRIPTOR_PADDING_SIZE = 16;

function ToolPresetParser() {}

/**
 * Parse a `.tpl` tool-preset library.
 * @param {ArrayBuffer} arrayBuffer Raw file bytes.
 * @returns {{samples: object[], patterns: object[], list: Array, shapes: object[], layerStyles: object[]}}
 */
ToolPresetParser.parse = function (arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let cursor = skipFileHeader(bytes, 0);
  const bundle = createEmptyPresetBundle();
  while (cursor < bytes.length) {
    cursor = parseChunk(bytes, cursor, bundle);
  }
  return bundle;
};

/**
 * Rename a tptp list entry in place (`entry[0]` is the display name).
 * @param {Array} entry `[name, descriptor]`.
 * @param {string} name New display name.
 */
ToolPresetParser.setName = function (entry, name) {
  entry[0] = name;
};

/**
 * Serialise patterns, samples, and named tool descriptors into a version-3 `.tpl`.
 * Shape and style sections are read-only in this codec.
 * @param {{samples: object[], patterns: object[], list: Array}} data Resource lists.
 * @returns {ArrayBuffer}
 */
ToolPresetParser.serialize = function (data) {
  const buffer = new RenderBuffer();
  let cursor = writeFileHeader(buffer, 0);
  const chunks = [data.patterns, data.samples, data.list];
  for (let chunkIdx = 0; chunkIdx < 3; chunkIdx++) {
    if (chunks[chunkIdx].length === 0) continue;
    BinaryUtils.writeAscii(buffer, cursor, CHUNK_SIGNATURE);
    cursor += 4;
    const chunkTag = ["tppa", "tpbd", "tptp"][chunkIdx];
    BinaryUtils.writeAscii(buffer, cursor, chunkTag);
    cursor += 4;
    const chunkSizePos = cursor;
    cursor += 4;
    if (chunkTag === "tppa") {
      cursor = PatternParser.writeEntries(buffer, cursor, data.patterns);
    } else if (chunkTag === "tpbd") {
      cursor = writeSampleList(buffer, cursor, data.samples);
    } else if (chunkTag === "tptp") {
      cursor = writeToolListChunk(buffer, cursor, data.list);
    }
    BinaryUtils.writeSize(buffer, chunkSizePos, cursor - chunkSizePos - 4);
    while ((cursor & 3) !== 0) cursor++;
    buffer.ensureCapacity(cursor, 0);
  }
  return buffer.data.slice(0, cursor).buffer;
};

function createEmptyPresetBundle() {
  return {
    samples: [],
    patterns: [],
    list: [],
    shapes: [],
    layerStyles: [],
  };
}

function skipFileHeader(bytes, cursor) {
  BinaryUtils.readString(bytes, cursor, 4);
  cursor += 4;
  BinaryUtils.readUint32BE(bytes, cursor);
  cursor += 4;
  BinaryUtils.readUint32BE(bytes, cursor);
  cursor += 4;
  return cursor;
}

function writeFileHeader(buffer, cursor) {
  BinaryUtils.writeAscii(buffer, cursor, FILE_SIGNATURE);
  cursor += 4;
  BinaryUtils.writeSize(buffer, cursor, WRITE_VERSION);
  cursor += 4;
  BinaryUtils.writeSize(buffer, cursor, WRITE_COUNT);
  cursor += 4;
  return cursor;
}

function parseChunk(bytes, cursor, bundle) {
  BinaryUtils.readString(bytes, cursor, 4);
  cursor += 4;
  const tag = BinaryUtils.readString(bytes, cursor, 4);
  cursor += 4;
  const chunkSize = BinaryUtils.readUint32BE(bytes, cursor);
  cursor += 4;
  if (tag === "tppa") {
    bundle.patterns = PatternParser.extract(bytes, cursor, chunkSize);
    return cursor + chunkSize;
  }
  if (tag === "tpbd") {
    bundle.samples = parseSampleList(bytes, cursor, chunkSize, 1, 1);
    return cursor + chunkSize;
  }
  if (tag === "tptp") {
    return parseToolListChunk(bytes, cursor, bundle);
  }
  if (tag === "tpsh") {
    return parseShapeChunk(bytes, cursor, chunkSize, bundle);
  }
  if (tag === "tpst") {
    return parseStyleChunk(bytes, cursor, chunkSize, bundle);
  }
  throw new Error("Unknown tool-preset chunk tag: " + tag);
}

function parseToolListChunk(bytes, cursor, bundle) {
  const typeCount = BinaryUtils.readUint32BE(bytes, cursor);
  cursor += 4;
  for (let entryIdx = 0; entryIdx < typeCount; entryIdx++) {
    const typeName = BinaryUtils.readUnicodeName(bytes, cursor);
    cursor += 6 + typeName.length * 2;
    cursor += 4;
    const entry = {};
    cursor += DescriptorCodec.parseDescriptor(bytes, entry, cursor);
    bundle.list.push([typeName, entry]);
  }
  while ((cursor & 3) !== 0) cursor++;
  return cursor;
}

function parseShapeChunk(bytes, cursor, chunkSize, bundle) {
  const sectionStart = cursor;
  while (cursor < sectionStart + chunkSize) {
    BinaryUtils.readUint32BE(bytes, cursor);
    cursor += 4;
    cursor = ShapeFile.parseShape(bytes, cursor, "Shape", bundle.shapes);
  }
  return sectionStart + chunkSize;
}

function parseStyleChunk(bytes, cursor, chunkSize, bundle) {
  const sectionStart = cursor;
  cursor += 4;
  while (cursor < sectionStart + chunkSize) {
    const entrySize = BinaryUtils.readUint32BE(bytes, cursor);
    cursor += 4;
    const entryStart = cursor;
    BinaryUtils.readUint32BE(bytes, cursor);
    cursor += 4;
    const styleEntry = { styleInfo: {}, styleEffects: {} };
    bundle.layerStyles.push(styleEntry);
    cursor += 4;
    cursor += DescriptorCodec.parseDescriptor(bytes, styleEntry.styleInfo, cursor);
    cursor += 4;
    cursor += DescriptorCodec.parseDescriptor(bytes, styleEntry.styleEffects, cursor);
    cursor = entryStart + entrySize;
    ensureMasterFxSwitch(styleEntry.styleEffects.Lefx);
  }
  return sectionStart + chunkSize;
}

function ensureMasterFxSwitch(layerEffects) {
  if (!layerEffects) return;
  if (layerEffects.v.masterFXSwitch == null) {
    layerEffects.v.masterFXSwitch = { t: "bool", v: true };
  }
  normalizeLayerEffectsOnRead(layerEffects.v);
}

function writeToolListChunk(buffer, cursor, toolList) {
  BinaryUtils.writeSize(buffer, cursor, toolList.length);
  cursor += 4;
  for (let listIdx = 0; listIdx < toolList.length; listIdx++) {
    const entry = toolList[listIdx];
    BinaryUtils.writeUnicodeString(buffer, cursor, entry[0] + "\0");
    cursor += 6 + entry[0].length * 2;
    BinaryUtils.writeSize(buffer, cursor, DESCRIPTOR_PADDING_SIZE);
    cursor += 4;
    cursor += DescriptorCodec.writeDescriptor(buffer, entry[1], cursor);
  }
  return cursor;
}

export { ToolPresetParser };
