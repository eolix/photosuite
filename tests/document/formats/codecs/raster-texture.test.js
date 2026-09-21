import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let ddsCodec;
let vtfCodec;
let decodeVtfFrames;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  globalThis.UTEX = {
    DDS: {
      encode(buffer, width, height) {
        return new Uint8Array([width, height]).buffer;
      },
      decode(buffer) {
        return [{ width: 2, height: 2, image: new ArrayBuffer(16) }];
      },
    },
    U: {
      readASCII(data, offset, length) {
        return String.fromCharCode(data[offset]);
      },
      readUintLE(data, offset) {
        return data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16 | data[offset + 3] << 24;
      },
    },
    readBC1(data, offset, pixels, width, height) {
      return offset + 8;
    },
    readBC2(data, offset) {
      return offset + 8;
    },
    readBC3(data, offset) {
      return offset + 8;
    },
  };
  const mod = await import("../../../../src/document/formats/codecs/raster-texture.js");
  ddsCodec = mod.ddsCodec;
  vtfCodec = mod.vtfCodec;
  decodeVtfFrames = mod.decodeVtfFrames;
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

function writeUint32LE(bytes, offset, value) {
  bytes[offset] = value & 255;
  bytes[offset + 1] = value >>> 8 & 255;
  bytes[offset + 2] = value >>> 16 & 255;
  bytes[offset + 3] = value >>> 24 & 255;
}

function buildMinimalVtfBuffer(format, pixelBytes) {
  var headerSize = 64;
  var fileBytes = new Uint8Array(headerSize + pixelBytes.length);
  fileBytes[0] = 86;
  fileBytes[1] = 84;
  fileBytes[2] = 70;
  fileBytes[3] = 0;
  writeUint32LE(fileBytes, 4, headerSize);
  writeUint32LE(fileBytes, 8, 1);
  writeUint32LE(fileBytes, 12, headerSize);
  fileBytes[16] = 1;
  fileBytes[18] = 1;
  fileBytes[24] = 1;
  writeUint32LE(fileBytes, 52, format);
  fileBytes[56] = 1;
  fileBytes.set(pixelBytes, headerSize);
  return fileBytes.buffer;
}

describe("document/formats/codecs/raster-texture.js", () => {
  it("ddsCodec.encode pads to a 4-pixel block boundary", () => {
    var rgba = new Uint8Array(3 * 3 * 4);
    var encoded = new Uint8Array(ddsCodec.encode([[rgba.buffer]], 3, 3));
    assert.equal(encoded[0], 4);
    assert.equal(encoded[1], 4);
  });

  it("ddsCodec.decode wraps UTEX output as a layer frame", () => {
    var frames = ddsCodec.decode(new ArrayBuffer(8));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].rect.width, 2);
    assert.equal(frames[0].rect.height, 2);
  });

  it("decodeVtfFrames reads a 1×1 BGR888 mip", () => {
    var frames = decodeVtfFrames(buildMinimalVtfBuffer(2, new Uint8Array([10, 20, 30])));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].width, 1);
    assert.equal(frames[0].height, 1);
    var rgba = new Uint8Array(frames[0].image);
    assert.deepEqual(Array.from(rgba), [10, 20, 30, 255]);
  });

  it("decodeVtfFrames rejects unknown formats", () => {
    assert.throws(
      () => decodeVtfFrames(buildMinimalVtfBuffer(99, new Uint8Array(4))),
      /Unsupported VTF format: 99/,
    );
  });

});
