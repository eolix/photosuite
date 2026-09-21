import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { BinaryUtils } from "../../../../src/core/binary/binary-utils.js";
import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let PSDParser;
let restoreBrowserGlobals;

/** Goldens from PSDParser section helpers. */
const GOLDEN_HEADER_BYTES = [
  56, 66, 80, 83, 0, 1, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 10, 0, 0, 0, 20, 0, 8, 0, 3,
];

const mockWriteBuffer = (capacity = 64) => ({
  data: new Uint8Array(capacity),
  ensureCapacity() {},
});

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/engine/layer-system.js");
  await import("../../../../src/document/formats/registry/file-format-registry.js");
  ({ PSDParser } = await import("../../../../src/document/formats/psd/psd-parser.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/psd/psd-parser.js", () => {

  it("readHeader decodes a minimal 8BPS RGB header", () => {
    const headerBytes = new Uint8Array(26);
    BinaryUtils.writeAsciiRaw(headerBytes, 0, "8BPS");
    BinaryUtils.writeUint16Raw(headerBytes, 4, 1);
    BinaryUtils.writeUint16Raw(headerBytes, 12, 4);
    BinaryUtils.writeInt32BE(headerBytes, 14, 10);
    BinaryUtils.writeInt32BE(headerBytes, 18, 20);
    BinaryUtils.writeUint16Raw(headerBytes, 22, 8);
    BinaryUtils.writeUint16Raw(headerBytes, 24, 3);

    const documentModel = {};
    const nextPos = PSDParser.readHeader(documentModel, headerBytes, 0);
    assert.equal(nextPos, 26);
    assert.deepEqual(
      {
        isPSB: documentModel.isPSB,
        channelCount: documentModel.channelCount,
        width: documentModel.width,
        height: documentModel.height,
        bitDepth: documentModel.bitDepth,
        colorMode: documentModel.colorMode,
      },
      {
        isPSB: false,
        channelCount: 4,
        width: 20,
        height: 10,
        bitDepth: 8,
        colorMode: 3,
      },
    );
  });

  it("writeHeader encodes the same minimal header bytes", () => {
    const writeBuffer = mockWriteBuffer();
    const documentModel = { isPSB: false, width: 20, height: 10 };
    const nextPos = PSDParser.writeHeader(documentModel, writeBuffer, 0, 4);
    assert.equal(nextPos, 26);
    assert.deepEqual(Array.from(writeBuffer.data.slice(0, 26)), GOLDEN_HEADER_BYTES);
  });

  it("readColorModeData / writeColorModeData handle zero-length section", () => {
    const colorModeBytes = new Uint8Array(4);
    const documentModel = {};
    assert.equal(PSDParser.readColorModeData(documentModel, colorModeBytes, 0), 4);
    assert.equal(documentModel.indexedColorTable, undefined);

    const writeBuffer = mockWriteBuffer();
    assert.equal(PSDParser.writeColorModeData(documentModel, writeBuffer, 0), 4);
    assert.equal(BinaryUtils.readInt32BE(writeBuffer.data, 0), 0);
  });

  it("readGlobalLayerMask / writeGlobalLayerMask skip empty mask block", () => {
    const maskBytes = new Uint8Array(8);
    BinaryUtils.writeUint32BE(maskBytes, 0, 4);
    const documentModel = {};
    assert.equal(PSDParser.readGlobalLayerMask(documentModel, maskBytes, 0), 8);

    const writeBuffer = mockWriteBuffer();
    assert.equal(PSDParser.writeGlobalLayerMask(documentModel, writeBuffer, 0), 4);
    assert.equal(BinaryUtils.readInt32BE(writeBuffer.data, 0), 0);
  });

  it("writeImageResources / readImageResources round-trip a single block", () => {
    const sourceDoc = { resources: { r9999: new Uint8Array([1, 2, 3]) } };
    const writeBuffer = mockWriteBuffer(256);
    const writeEnd = PSDParser.writeImageResources(sourceDoc, writeBuffer, 0);
    const readDoc = { resources: {} };
    const readEnd = PSDParser.readImageResources(readDoc, writeBuffer.data, 0);
    assert.equal(writeEnd, 20);
    assert.equal(readEnd, 20);
    assert.deepEqual([...readDoc.resources.r9999], [1, 2, 3]);
  });
});
