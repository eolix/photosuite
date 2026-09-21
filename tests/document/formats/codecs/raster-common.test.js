import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let icoCodec;
let pngCodec;
let gifCodec;
let tiffCodec;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/document/formats/registry/file-format-registry.js");
  const mod = await import("../../../../src/document/formats/codecs/raster-common.js");
  icoCodec = mod.icoCodec;
  pngCodec = mod.pngCodec;
  gifCodec = mod.gifCodec;
  tiffCodec = mod.tiffCodec;
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/codecs/raster-common.js", () => {
  it("parseIcoDirectoryEntry reads width/height and offsets", () => {
    var bytes = new Uint8Array(16);
    bytes[0] = 32;
    bytes[1] = 64;
    BinaryUtils_writeUint16LE(bytes, 6, 32);
    BinaryUtils_writeUint32LE(bytes, 8, 100);
    BinaryUtils_writeUint32LE(bytes, 12, 22);
    var entry = icoCodec.parseIcoDirectoryEntry(bytes, 0);
    assert.equal(entry.width, 32);
    assert.equal(entry.height, 64);
    assert.equal(entry.bitsPerPixel, 32);
    assert.equal(entry.size, 100);
    assert.equal(entry.fileOffset, 22);
  });

  it("parseIcoDirectoryEntry treats 0×0 as 256×256", () => {
    var bytes = new Uint8Array(16);
    var entry = icoCodec.parseIcoDirectoryEntry(bytes, 0);
    assert.equal(entry.width, 256);
    assert.equal(entry.height, 256);
  });

});

function BinaryUtils_writeUint16LE(bytes, offset, value) {
  bytes[offset] = value & 255;
  bytes[offset + 1] = value >>> 8 & 255;
}

function BinaryUtils_writeUint32LE(bytes, offset, value) {
  bytes[offset] = value & 255;
  bytes[offset + 1] = value >>> 8 & 255;
  bytes[offset + 2] = value >>> 16 & 255;
  bytes[offset + 3] = value >>> 24 & 255;
}
