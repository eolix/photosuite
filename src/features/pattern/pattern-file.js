// Feature: Photoshop pattern file (.pat) codec for the pattern resource picker.
// Pattern pixel records are decoded by PatternParser in document/formats/psd/;
// this module owns the 8BPT envelope and the entry list around that codec.
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { RenderBuffer } from "../../core/render-buffer.js";
import { PatternParser } from "../../document/formats/psd/layer-data-parsers.js";

const PATTERN_FILE_SIGNATURE = "8BPT";
const PATTERN_FILE_WRITE_VERSION = 1;
const SIGNATURE_BYTE_LENGTH = 4;

function PatternFile() {}

function readFileHeader(bytes, cursor) {
  cursor += SIGNATURE_BYTE_LENGTH;
  const version = BinaryUtils.readUint16(bytes, cursor);
  cursor += 2;
  const entryCount = BinaryUtils.readUint32BE(bytes, cursor);
  cursor += 4;
  return {
    version: version,
    entryCount: entryCount,
    cursor: cursor
  };
}

function parsePatternEntries(bytes, cursor, entryCount) {
  const patterns = [];
  for (let entryIdx = 0; entryIdx < entryCount; entryIdx++) {
    const pattern = {};
    patterns.push(pattern);
    cursor = PatternParser.readPattern(bytes, cursor, pattern);
  }
  return patterns;
}

function writeFileEnvelope(buffer, cursor, entryCount) {
  BinaryUtils.writeAscii(buffer, cursor, PATTERN_FILE_SIGNATURE);
  cursor += SIGNATURE_BYTE_LENGTH;
  BinaryUtils.writeUint16(buffer, cursor, PATTERN_FILE_WRITE_VERSION);
  cursor += 2;
  BinaryUtils.writeSize(buffer, cursor, entryCount);
  cursor += 4;
  return cursor;
}

PatternFile.parse = function(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const header = readFileHeader(bytes, 0);
  return parsePatternEntries(bytes, header.cursor, header.entryCount);
};

PatternFile.setName = function(pattern, name) {
  pattern.name = name;
};

PatternFile.serialize = function(patterns) {
  const buffer = new RenderBuffer;
  let cursor = writeFileEnvelope(buffer, 0, patterns.length);
  for (let entryIdx = 0; entryIdx < patterns.length; entryIdx++) {
    cursor = PatternParser.writePattern(buffer, cursor, patterns[entryIdx]);
  }
  return buffer.data.slice(0, cursor).buffer;
};

export { PatternFile };
