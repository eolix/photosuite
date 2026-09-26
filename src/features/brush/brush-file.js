// Photoshop brush-preset file (.abr) read/write. Parses the 8BIMsamp/patt/desc
// blocks into brush descriptors (and the version-2 tip format), and serialises
// brush presets back out. Built on the shared 8BIM/descriptor codec in
// document/formats/psd/.
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { RenderBuffer } from "../../core/render-buffer.js";

import { PatternParser } from "../../document/formats/psd/layer-data-parsers.js";
import { DescriptorCodec } from "../../document/formats/psd/descriptor-codec.js";
import { ChannelImageCodec } from "../../document/formats/psd/channel-image-codec.js";
import { parseSampleList, writeSampleList } from "../../document/formats/psd/sample-list-codec.js";
import { Document } from "../../document/model/document.js";
import { BrushPresetUtil } from "./brush-presets.js";

const BrushFileCodec = {};

/** Parse an .abr buffer into samples, patterns, and brush descriptor list. */
BrushFileCodec.parse = function(bytes) {
  const byteView = new Uint8Array(bytes);
  let offset = 0;
  const parsed = emptyBrushFile();
  const formatVersion = BinaryUtils.readUint16(byteView, offset);
  offset += 2;
  if (formatVersion <= 2) return BrushFileCodec.parseVersion2BrushFile(byteView);
  const sampleCount = BinaryUtils.readUint16(byteView, offset);
  offset += 2;
  const sampleBlock = readTaggedBlock(byteView, offset);
  offset = sampleBlock.nextOffset;
  if (sampleBlock.size > 0) {
    parsed.samples = parseSampleList(byteView, sampleBlock.dataOffset, sampleBlock.size, sampleCount, formatVersion)
  }
  const patternBlock = readTaggedBlock(byteView, offset);
  offset = patternBlock.nextOffset;
  if (patternBlock.size > 0) {
    parsed.patterns = PatternParser.extract(byteView, patternBlock.dataOffset, patternBlock.size)
  }
  const descBlock = readTaggedBlock(byteView, offset);
  offset = descBlock.nextOffset;
  if (descBlock.size > 0) {
    const descRoot = {};
    DescriptorCodec.parseDescriptor(byteView, descRoot, descBlock.dataOffset + 4);
    parsed.list = descRoot.Brsh.v
  }
  validateBrushList(parsed.list);
  return parsed
};

/** Set the brush display name on a list entry descriptor. */
BrushFileCodec.setName = function(descriptor, name) {
  descriptor.v.Nm.v = name
};

/** Parse version-1/2 tip-style .abr files into synthetic samples + brush list. */
BrushFileCodec.parseVersion2BrushFile = function(byteView) {
  const parsed = emptyBrushFile();
  let offset = 0;
  const formatVersion = BinaryUtils.readUint16(byteView, offset);
  offset += 2;
  const entryCount = BinaryUtils.readUint16(byteView, offset);
  offset += 2;
  for (let entryIdx = 0; entryIdx < entryCount; entryIdx++) {
    const entryType = BinaryUtils.readUint16(byteView, offset);
    offset += 2;
    const entrySize = BinaryUtils.readUint32BE(byteView, offset);
    offset += 4;
    let entryOffset = offset;
    if (entryType == 2) parseVersion2TipEntry(byteView, entryOffset, formatVersion, parsed);
    offset += entrySize
  }
  return parsed
};

/** Serialize samples, patterns, and brush descriptors to a version-6 .abr buffer. */
BrushFileCodec.serialize = function(brushFile) {
  const out = new RenderBuffer;
  let offset = 0;
  let blockStart = 0;
  BinaryUtils.writeUint16(out, offset, 6);
  offset += 2;
  BinaryUtils.writeUint16(out, offset, 2);
  offset += 2;
  offset = writeTaggedBlockHeader(out, offset, "8BIMsamp");
  blockStart = offset;
  offset = writeSampleList(out, offset, brushFile.samples);
  BinaryUtils.writeSize(out, blockStart - 4, offset - blockStart);
  offset = writeTaggedBlockHeader(out, offset, "8BIMpatt");
  blockStart = offset;
  offset = PatternParser.writeEntries(out, offset, brushFile.patterns);
  BinaryUtils.writeSize(out, blockStart - 4, offset - blockStart);

  const descRoot = {
    classID: "null",
    Brsh: {
      t: "VlLs",
      v: brushFile.list
    }
  };

  offset = writeTaggedBlockHeader(out, offset, "8BIMdesc");
  blockStart = offset;
  BinaryUtils.writeSize(out, offset, 16);
  offset += 4;
  offset += DescriptorCodec.writeDescriptor(out, descRoot, offset);
  BinaryUtils.writeSize(out, blockStart - 4, offset - blockStart);
  return out.data.slice(0, offset).buffer
};

export { BrushFileCodec };

function emptyBrushFile() {
  return {
    samples: [],
    patterns: [],
    list: []
  }
}

function readTaggedBlock(byteView, offset) {
  BinaryUtils.readString(byteView, offset, 8);
  offset += 8;
  const size = BinaryUtils.readUint32BE(byteView, offset);
  offset += 4;
  return {
    dataOffset: offset,
    size: size,
    nextOffset: offset + size
  }
}

function writeTaggedBlockHeader(out, offset, tag) {
  BinaryUtils.writeAscii(out, offset, tag);
  offset += 8;
  offset += 4;
  return offset
}

function validateBrushList(brushList) {
  for (let brushIdx = 0; brushIdx < brushList.length; brushIdx++) {
    BrushPresetUtil.brushDescriptorSchema.validate(brushList[brushIdx].v)
  }
}

function parseVersion2TipEntry(byteView, entryOffset, formatVersion, parsed) {
  const sample = {};
  parsed.samples.push(sample);
  BinaryUtils.readUint32BE(byteView, entryOffset);
  entryOffset += 4;
  const spacing = BinaryUtils.readUint16(byteView, entryOffset);
  entryOffset += 2;
  if (formatVersion == 2) {
    const unicodeName = BinaryUtils.readUnicodeName(byteView, entryOffset);
    entryOffset += 4 + unicodeName.length * 2 + 2
  }
  sample.id = Document.generateUID();
  entryOffset++;
  entryOffset += 8;
  sample.boundsRect = BinaryUtils.readRect(byteView, entryOffset);
  entryOffset += 16;
  const channelDepth = BinaryUtils.readUint16(byteView, entryOffset);
  entryOffset += 2;
  const compression = byteView[entryOffset];
  entryOffset++;
  sample.channel = ChannelImageCodec.decompressChannel(false, channelDepth, byteView, sample.boundsRect.width, sample.boundsRect.height, entryOffset, compression);
  const brushDesc = BrushPresetUtil.getDefaultBrushDescriptor(sample.id);
  const brushParams = brushDesc.Brsh.v;
  brushParams.diameter.v.val = sample.boundsRect.width;
  brushParams.Spcn.v.val = spacing;
  parsed.list.push({
    t: "Objc",
    v: brushDesc
  })
}
