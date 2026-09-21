/**
 * PSD pattern / hatch sample-list codec: binary sample arrays inside `Patt` records.
 * Used by brush import and `PatternParser` on layer pattern resources.
 */

import { BinaryUtils } from "../../../core/binary/binary-utils.js";
import { ChannelImageCodec } from "./channel-image-codec.js";

/** Bytes after the Pascal name in compact (tool-preset) sample records. */
const COMPACT_NAME_TRAILER_BYTES = 9;
/** Bytes after the Pascal name in brush-style sample records. */
const BRUSH_NAME_TRAILER_BYTES = 7;
/** Fixed dword table length written before the duplicate bounds rect. */
const BRUSH_PATTERN_KIND_DWORD_COUNT = 56;
/** Channel bit depth stored in brush-style sample records. */
const BRUSH_SAMPLE_BIT_DEPTH = 8;
/** Raw channel compression tag used on write. */
const BRUSH_SAMPLE_COMPRESSION = 1;
/** Trailing pad after each compressed channel on write. */
const BRUSH_CHANNEL_TRAILER_BYTES = 8;

/**
 * Parse length-prefixed sample records from a byte range.
 * nameFormat selects compact tool-preset layout when equal to 1; otherwise brush layout.
 * formatVersion is reserved from the parent container and unused here.
 */
function parseSampleList(bytes, offset, blockSize, nameFormat, formatVersion) {
  var blockEnd = offset + blockSize;
  var samples = [];
  while (offset < blockEnd) {
    var recordSize = BinaryUtils.readUint32BE(bytes, offset);
    offset += 4;
    var recordStart = offset;
    var sample = {};
    samples.push(sample);

    var nameField = BinaryUtils.readPascalString(bytes, offset);
    offset += nameField.length;
    sample.id = nameField.str;

    if (nameFormat == 1) {
      offset = parseCompactSampleTail(bytes, offset, sample);
    } else {
      offset = parseBrushStyleSampleTail(bytes, offset, sample);
    }

    var channelDepth = BinaryUtils.readUint16(bytes, offset);
    offset += 2;
    var compression = bytes[offset];
    offset += 1;
    sample.channel = ChannelImageCodec.decompressChannel(
      false,
      channelDepth,
      bytes,
      sample.boundsRect.width,
      sample.boundsRect.height,
      offset,
      compression,
    );

    if (recordSize % 4 != 0) recordSize += 4 - (recordSize % 4);
    offset = recordStart + recordSize;
  }
  return samples;
}

/** Compact sample tail: skip fixed header, then read bounds. */
function parseCompactSampleTail(bytes, offset, sample) {
  offset += COMPACT_NAME_TRAILER_BYTES;
  sample.boundsRect = BinaryUtils.readRect(bytes, offset);
  offset += 16;
  return offset;
}

/** Brush-style sample tail: bounds, dword tables, and a discarded duplicate rect. */
function parseBrushStyleSampleTail(bytes, offset, sample) {
  offset += BRUSH_NAME_TRAILER_BYTES;
  offset += 4; // reserved dword after name trailer
  sample.boundsRect = BinaryUtils.readRect(bytes, offset);
  offset += 16;
  var patternKindDwordCount = BinaryUtils.readUint32BE(bytes, offset);
  offset += 4;
  offset += patternKindDwordCount * 4;
  offset += 4; // reserved dword
  offset += 4; // reserved dword
  offset += 16; // discarded duplicate bounds rect
  return offset;
}

/**
 * Write sample records into a growable buffer, returning the offset after the last byte.
 */
function writeSampleList(buffer, offset, samples) {
  for (var sampleIdx = 0; sampleIdx < samples.length; sampleIdx++) {
    offset = writeOneSample(buffer, offset, samples[sampleIdx]);
  }
  return offset;
}

function writeOneSample(buffer, offset, sample) {
  var recordStart = offset + 4;
  offset += 4; // record size patched at end

  BinaryUtils.writePascalString(buffer, offset, sample.id);
  offset += sample.id.length + 2;
  buffer.ensureCapacity(offset, 1);
  buffer.data[offset] = 1;
  offset += 3;
  BinaryUtils.writeSize(buffer, offset, 3);
  offset += 4;

  var innerSizePatchA = offset;
  offset += 4;
  BinaryUtils.writePsdRect(buffer, offset, sample.boundsRect);
  offset += 16;
  BinaryUtils.writeSize(buffer, offset, BRUSH_PATTERN_KIND_DWORD_COUNT);
  offset += 4;
  offset += BRUSH_PATTERN_KIND_DWORD_COUNT * 4;
  BinaryUtils.writeSize(buffer, offset - 4, 1);

  var innerSizePatchB = offset;
  offset += 4;
  BinaryUtils.writeSize(buffer, offset, 8);
  offset += 4;
  BinaryUtils.writePsdRect(buffer, offset, sample.boundsRect);
  offset += 16;
  BinaryUtils.writeUint16(buffer, offset, BRUSH_SAMPLE_BIT_DEPTH);
  offset += 2;
  buffer.ensureCapacity(offset, 1);
  buffer.data[offset] = BRUSH_SAMPLE_COMPRESSION;
  offset++;
  buffer.ensureCapacity(offset, sample.boundsRect.area() * 2);
  offset = ChannelImageCodec.compressChannel(
    false,
    sample.channel,
    buffer.data,
    sample.boundsRect.width,
    sample.boundsRect.height,
    offset,
    BRUSH_SAMPLE_COMPRESSION,
  );
  buffer.ensureCapacity(offset, BRUSH_CHANNEL_TRAILER_BYTES);
  offset += BRUSH_CHANNEL_TRAILER_BYTES;

  var recordSize = offset - recordStart;
  BinaryUtils.writeSize(buffer, recordStart - 4, recordSize);
  BinaryUtils.writeSize(buffer, innerSizePatchA, recordSize - 49);
  BinaryUtils.writeSize(buffer, innerSizePatchB, recordSize - 305);
  if (recordSize % 4 != 0) offset += 4 - (recordSize % 4);
  return offset;
}

export { parseSampleList, writeSampleList };
