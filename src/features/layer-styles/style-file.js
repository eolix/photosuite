// Photoshop style library (.asl) codec. A style file is a patterns block
// (shared pattern entries) followed by a count of named layer-style entries;
// each entry pairs a style-info descriptor (name and identifier) with a
// style-effects descriptor (blend options plus the layer-effects tree).
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { RenderBuffer } from "../../core/render-buffer.js";
import { DescriptorCodec } from "../../document/formats/psd/descriptor-codec.js";
import { PatternParser } from "../../document/formats/psd/layer-data-parsers.js";
import { normalizeLayerEffectsOnRead, normalizeLayerEffectsOnWrite } from "../../document/formats/psd/psd-layer-effects.js";

const FILE_SIGNATURE = "8BSL";
const WRITE_VERSION = 3;

// The file opens with a fixed 2-byte prefix before the signature.
const HEADER_PREFIX = 2;

// Each style entry pads both descriptors to a 16-byte-aligned size field.
const DESCRIPTOR_PADDING_SIZE = 16;

function StyleParser() {}

/**
 * Parse a `.asl` file.
 * @param {ArrayBuffer} bytes Raw file bytes.
 * @returns {{patterns: object[], layerStyles: object[]}} The pattern entries and
 *   the named layer-style entries (each `{ styleInfo, styleEffects }`).
 */
StyleParser.parse = function (bytes) {
  const byteView = new Uint8Array(bytes);
  let cursor = HEADER_PREFIX;
  const bundle = createEmptyStyleBundle();
  const header = readStyleFileHeader(byteView, cursor);
  cursor = header.cursor;
  bundle.patterns = PatternParser.extract(byteView, cursor, header.patternBlockSize);
  cursor += header.patternBlockSize;
  const styleCount = BinaryUtils.readUint32BE(byteView, cursor);
  cursor += 4;
  for (let styleIdx = 0; styleIdx < styleCount; styleIdx++) {
    const parsedEntry = parseStyleEntry(byteView, cursor);
    bundle.layerStyles.push(parsedEntry.styleEntry);
    cursor = parsedEntry.cursor;
  }
  return bundle;
};

/**
 * Rename a layer-style entry in place.
 * @param {object} styleEntry An entry with a `styleInfo` descriptor.
 * @param {string} name New display name.
 */
StyleParser.setName = function (styleEntry, name) {
  styleEntry.styleInfo.Nm.v = name;
};

/**
 * Serialise a style bundle into a version-3 `.asl` file.
 * @param {{patterns: object[], layerStyles: object[]}} bundle Patterns and styles.
 * @returns {ArrayBuffer} The encoded file.
 */
StyleParser.serialize = function (bundle) {
  const buffer = new RenderBuffer();
  let cursor = 0;
  BinaryUtils.writeUint16(buffer, cursor, HEADER_PREFIX);
  cursor += 2;
  BinaryUtils.writeAscii(buffer, cursor, FILE_SIGNATURE);
  cursor += 4;
  BinaryUtils.writeUint16(buffer, cursor, WRITE_VERSION);
  cursor += 2;
  const patternBlockStart = cursor;
  cursor += 4;
  cursor = PatternParser.writeEntries(buffer, cursor, bundle.patterns);
  BinaryUtils.writeSize(buffer, patternBlockStart, cursor - patternBlockStart - 4);
  const styleCount = bundle.layerStyles.length;
  BinaryUtils.writeSize(buffer, cursor, styleCount);
  cursor += 4;
  for (let styleIdx = 0; styleIdx < styleCount; styleIdx++) {
    cursor = writeStyleEntry(buffer, cursor, bundle.layerStyles[styleIdx]);
  }
  return buffer.data.slice(0, cursor).buffer;
};

function readStyleFileHeader(bytes, cursor) {
  const signature = BinaryUtils.readString(bytes, cursor, 4);
  cursor += 4;
  const version = BinaryUtils.readUint16(bytes, cursor);
  cursor += 2;
  const patternBlockSize = BinaryUtils.readUint32BE(bytes, cursor);
  cursor += 4;
  return { signature, version, patternBlockSize, cursor };
}

function parseStyleEntry(bytes, cursor) {
  const entrySize = BinaryUtils.readUint32BE(bytes, cursor);
  cursor += 4;
  const entryStart = cursor;
  const styleEntry = createEmptyStyleEntry();
  // Each descriptor is prefixed by a 4-byte padded-size field, skipped here.
  cursor += 4;
  cursor += DescriptorCodec.parseDescriptor(bytes, styleEntry.styleInfo, cursor);
  cursor += 4;
  cursor += DescriptorCodec.parseDescriptor(bytes, styleEntry.styleEffects, cursor);
  cursor = entryStart + entrySize;
  const layerEffects = styleEntry.styleEffects.Lefx;
  if (layerEffects) {
    ensureMasterFxSwitch(layerEffects);
    normalizeLayerEffectsOnRead(layerEffects.v);
  }
  return { styleEntry, cursor };
}

function writeStyleEntry(buffer, cursor, styleEntry) {
  // Reserve the 4-byte entry-size field, filled in once the entry is written.
  cursor += 4;
  const entryStart = cursor;
  BinaryUtils.writeSize(buffer, cursor, DESCRIPTOR_PADDING_SIZE);
  cursor += 4;
  cursor += DescriptorCodec.writeDescriptor(buffer, styleEntry.styleInfo, cursor);
  const layerEffects = styleEntry.styleEffects.Lefx;
  // Normalise a deep copy so the caller's live descriptor is not mutated, then
  // restore the original reference after the copy is written.
  if (layerEffects) {
    styleEntry.styleEffects.Lefx = JSON.parse(JSON.stringify(layerEffects));
    normalizeLayerEffectsOnWrite(styleEntry.styleEffects.Lefx.v);
  }
  BinaryUtils.writeSize(buffer, cursor, DESCRIPTOR_PADDING_SIZE);
  cursor += 4;
  cursor += DescriptorCodec.writeDescriptor(buffer, styleEntry.styleEffects, cursor);
  if (layerEffects) styleEntry.styleEffects.Lefx = layerEffects;
  BinaryUtils.writeSize(buffer, entryStart - 4, cursor - entryStart);
  return cursor;
}

function ensureMasterFxSwitch(layerEffects) {
  if (layerEffects.v.masterFXSwitch == null) {
    layerEffects.v.masterFXSwitch = { t: "bool", v: true };
  }
}

function createEmptyStyleBundle() {
  return { patterns: [], layerStyles: [] };
}

function createEmptyStyleEntry() {
  return { styleInfo: {}, styleEffects: {} };
}

export { StyleParser };
