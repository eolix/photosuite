/**
 * EA IFF-85 and RIFF chunk-container parsers: `[tag][size][payload]` trees with
 * nested FORM/LIST/CAT (IFF) or RIFF/LIST children; size field endianness differs.
 */
import { BinaryUtils } from "../../../core/binary/binary-utils.js";

/** Tags whose chunks contain a nested list of child chunks (IFF). */
const IFF_CONTAINER_TAGS = ["FORM", "LIST", "CAT "];
/** RIFF list types that hold opaque data rather than child chunks. */
const RIFF_OPAQUE_LIST_TYPES = ["cmpr", "stlt"];

/**
 * Parse one chunk (recursing into container chunks) per a format spec.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {{readSize: Function, hasListType: Function, isContainer: Function, sizeOverrideMap: ?object}} spec
 * @returns {object} chunk { tag, dataOffset, size, listType?, sub? }
 */
function parseChunk(bytes, offset, spec) {
  var chunk = {
    tag: BinaryUtils.readString(bytes, offset, 4),
    dataOffset: offset + 8,
    size: spec.readSize(bytes, offset + 4),
  };
  if (spec.sizeOverrideMap && spec.sizeOverrideMap[chunk.size] != null) chunk.size = spec.sizeOverrideMap[chunk.size];
  if (spec.hasListType(chunk)) chunk.listType = BinaryUtils.readString(bytes, offset + 8, 4);
  if (chunk.size < 0 || chunk.dataOffset + chunk.size > bytes.length) throw "chunk-container: chunk size exceeds buffer";

  if (spec.isContainer(chunk)) {
    chunk.sub = [];
    offset += 12;
    var chunkEnd = chunk.dataOffset + chunk.size;
    while (offset < chunkEnd) {
      var childChunk = parseChunk(bytes, offset, spec);
      chunk.sub.push(childChunk);
      offset += 8 + childChunk.size + (childChunk.size & 1);
    }
  }
  return chunk;
}

/** IFF: big-endian sizes; FORM/LIST/CAT tags recurse. */
const IFFParser = {
  parse(bytes) {
    return parseChunk(new Uint8Array(bytes), 0, IFFParser.spec);
  },
  parseChunk(bytes, offset) {
    return parseChunk(bytes, offset, IFFParser.spec);
  },
  spec: {
    readSize: BinaryUtils.readUint32BE,
    sizeOverrideMap: null,
    hasListType(chunk) { return IFF_CONTAINER_TAGS.indexOf(chunk.tag) !== -1; },
    isContainer(chunk) { return IFF_CONTAINER_TAGS.indexOf(chunk.tag) !== -1; },
  },
};

/** RIFF: little-endian sizes (with optional override map); RIFF/LIST recurse. */
const RIFFParser = {
  parse(bytes, sizeOverrideMap) {
    return parseChunk(new Uint8Array(bytes), 0, riffSpec(sizeOverrideMap));
  },
  parseChunk(bytes, offset, sizeOverrideMap) {
    return parseChunk(bytes, offset, riffSpec(sizeOverrideMap));
  },
};

function riffSpec(sizeOverrideMap) {
  return {
    readSize: BinaryUtils.readFloat32,
    sizeOverrideMap: sizeOverrideMap,
    hasListType(chunk) { return chunk.tag == "RIFF" || chunk.tag == "LIST"; },
    isContainer(chunk) {
      return chunk.tag == "RIFF" || chunk.tag == "LIST" && RIFF_OPAQUE_LIST_TYPES.indexOf(chunk.listType) === -1;
    },
  };
}

export { IFFParser, RIFFParser };
