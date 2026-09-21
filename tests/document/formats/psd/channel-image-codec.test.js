import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let ChannelImageCodec;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/engine/layer-system.js");
  ({ ChannelImageCodec } = await import("../../../../src/document/formats/psd/channel-image-codec.js"));
});

after(() => { if (restoreBrowserGlobals) restoreBrowserGlobals(); });

describe("document/formats/psd/channel-image-codec.js", () => {
  it("packBitsEncodeRow / packBitsDecodeRow round-trip a single row", () => {
    const input = new Uint8Array([10, 10, 10, 20, 30, 40, 40, 40]);
    const encoded = new Uint8Array(64);
    const encLen = ChannelImageCodec.packBitsEncodeRow(input, 0, input.length, encoded, 0);
    const decoded = new Uint8Array(input.length);
    ChannelImageCodec.packBitsDecodeRow(encoded, 0, encLen, decoded, 0);
    assert.deepEqual([...decoded], [...input]);
  });

  it("encodePackBits / decodePackBits round-trip a 2-row image (16-bit scanline table)", () => {
    const width = 4, height = 2;
    const input = new Uint8Array([1, 1, 1, 1, 2, 3, 4, 5]);
    const output = new Uint8Array(128);
    const tablePos = 0, dataPos = height * 2;
    ChannelImageCodec.encodePackBits(input, output, width, height, tablePos, dataPos, 2);
    const decoded = new Uint8Array(width * height);
    ChannelImageCodec.decodePackBits(output, decoded, width, height, tablePos, dataPos, 2);
    assert.deepEqual([...decoded], [...input]);
  });

  it("decompressChannel returns a zeroed padded buffer for empty input", () => {
    const buf = ChannelImageCodec.decompressChannel(false, 8, new Uint8Array(0), 4, 4, 0, 0, 0);
    assert.equal(buf.length, 16);
    assert.ok([...buf].every((b) => b === 0));
  });
});
