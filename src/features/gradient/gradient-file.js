// Photoshop gradient file (.grd) codec: reads a `.grd` into an array of gradient
// descriptors and serialises gradient descriptors back out. Gradient stop data
// (colour stops, transparency stops) is decoded by the shared GradientParser in
// document/formats/psd/; this module handles the file envelope and the version
// dispatch on top of it.
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { RenderBuffer } from "../../core/render-buffer.js";
import { DescriptorCodec } from "../../document/formats/psd/descriptor-codec.js";
import { GradientParser } from "../../document/formats/psd/layer-data-parsers.js";

const FILE_SIGNATURE = "8BGR";
const WRITE_VERSION = 5;

// After each version-3 gradient entry the stop codec leaves six trailing bytes
// (two interpolation shorts) that the entry reader does not consume.
const VERSION3_ENTRY_TRAILER_BYTES = 6;

function GradientFile() {}

/**
 * Parse a `.grd` file.
 * @param {ArrayBuffer} arrayBuffer Raw file bytes.
 * @returns {object[]} One gradient descriptor per gradient in the file.
 */
GradientFile.parse = function (arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const header = readFileHeader(bytes, 0);
  return header.version <= 3
    ? parseVersion3GradientList(bytes, header.cursor)
    : parseDescriptorGradientList(bytes, header.cursor);
};

/**
 * Serialise gradient descriptors into a version-5 `.grd` file.
 * @param {object[]} gradients Gradient descriptors to write.
 * @returns {ArrayBuffer} The encoded file.
 */
GradientFile.serialize = function (gradients) {
  const buffer = new RenderBuffer();
  let cursor = 0;
  BinaryUtils.writeAscii(buffer, cursor, FILE_SIGNATURE);
  cursor += 4;
  BinaryUtils.writeUint16(buffer, cursor, WRITE_VERSION);
  cursor += 2;
  BinaryUtils.writeSize(buffer, cursor, 16);
  cursor += 4;
  cursor += DescriptorCodec.writeDescriptor(buffer, buildGradientListDescriptor(gradients), cursor);
  return buffer.data.slice(0, cursor).buffer;
};

/**
 * Rename a gradient descriptor in place.
 * @param {object} gradientDesc A gradient descriptor with an `Nm` name field.
 * @param {string} name New display name.
 */
GradientFile.setName = function (gradientDesc, name) {
  gradientDesc.Nm.v = name;
};

// Read the file envelope: the 4-byte signature (advanced past, not validated)
// and the 2-byte format version.
function readFileHeader(bytes, cursor) {
  BinaryUtils.readString(bytes, cursor, 4);
  cursor += 4;
  const version = BinaryUtils.readUint16(bytes, cursor);
  cursor += 2;
  return { version, cursor };
}

// Versions ≤3 store a flat list: a uint16 count, then per gradient a
// length-prefixed name followed by a raw stop-codec entry.
function parseVersion3GradientList(bytes, cursor) {
  const gradients = [];
  const count = BinaryUtils.readUint16(bytes, cursor);
  cursor += 2;
  for (let entryIdx = 0; entryIdx < count; entryIdx++) {
    const nameLength = bytes[cursor++];
    const name = BinaryUtils.readString(bytes, cursor, nameLength);
    cursor += nameLength;
    const [gradient, entryEnd] = GradientParser.readGradientEntry(bytes, cursor, name);
    gradients.push(gradient);
    cursor = entryEnd + VERSION3_ENTRY_TRAILER_BYTES;
  }
  return gradients;
}

// Versions ≥4 store the gradients inside a single descriptor tree under the
// `GrdL` value list; each list item wraps the gradient under `Grad`.
function parseDescriptorGradientList(bytes, cursor) {
  const descriptorRoot = {};
  DescriptorCodec.parseDescriptor(bytes, descriptorRoot, cursor + 4);
  const gradientList = descriptorRoot.GrdL.v;
  const gradients = [];
  for (let entryIdx = 0; entryIdx < gradientList.length; entryIdx++) {
    gradients[entryIdx] = gradientList[entryIdx].v.Grad.v;
  }
  return gradients;
}

// Build the version-5 descriptor tree: a `GrdL` value list of `Grdn` objects,
// each carrying its gradient under `Grad`.
function buildGradientListDescriptor(gradients) {
  const descriptor = { classID: "null", GrdL: { t: "VlLs", v: [] } };
  const gradientList = descriptor.GrdL.v;
  for (let entryIdx = 0; entryIdx < gradients.length; entryIdx++) {
    gradientList[entryIdx] = {
      t: "Objc",
      v: {
        classID: "Grdn",
        __name: "Gradient ",
        Grad: { t: "Objc", v: gradients[entryIdx] },
      },
    };
  }
  return descriptor;
}

export { GradientFile };
