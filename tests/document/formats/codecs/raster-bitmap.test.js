import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let bmpCodec;
let tgaCodec;
let ppmCodec;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  const mod = await import("../../../../src/document/formats/codecs/raster-bitmap.js");
  bmpCodec = mod.bmpCodec;
  tgaCodec = mod.tgaCodec;
  ppmCodec = mod.ppmCodec;
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/codecs/raster-bitmap.js", () => {
  it("ppmCodec.decode parses a 1×1 P6 image", () => {
    var header = "P6\n1 1\n255\n";
    var bytes = new Uint8Array(header.length + 3);
    for (var i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i);
    bytes[header.length] = 255;
    bytes[header.length + 1] = 0;
    bytes[header.length + 2] = 128;
    var frames = ppmCodec.decode(bytes.buffer);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].rect.width, 1);
    assert.equal(frames[0].rect.height, 1);
    var rgba = new Uint8Array(frames[0].data);
    assert.equal(rgba[0], 255);
    assert.equal(rgba[1], 0);
    assert.equal(rgba[2], 128);
    assert.equal(rgba[3], 255);
  });

  it("tgaCodec.decodeTgaPixels unpacks 24-bit BGR", () => {
    var pixelBytes = new Uint8Array([10, 20, 30]);
    var out = new Uint8Array(4);
    tgaCodec.decodeTgaPixels(pixelBytes, 0, 24, out);
    assert.deepEqual(Array.from(out), [30, 20, 10, 255]);
  });

  it("bmpCodec exposes decodeFromBuffer, encodeFromFrames, decodeToLayerFrame", () => {
    assert.equal(typeof bmpCodec.decodeFromBuffer, "function");
    assert.equal(typeof bmpCodec.encodeFromFrames, "function");
    assert.equal(typeof bmpCodec.decodeToLayerFrame, "function");
  });

  it("TGA is a single-frame codec", () => {
    // Layered codecs are handed the whole frame list; TGA gets one image.
    assert.equal(tgaCodec.isLayered, false);
  });
});
