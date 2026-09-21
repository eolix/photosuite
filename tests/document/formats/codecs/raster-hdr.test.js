import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let exrCodec;
let fitsCodec;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  globalThis.EXRLoader = {
    parse(buffer) {
      return {
        width: 1,
        height: 1,
        data: new Float32Array([1, 0.5, 0.25, 1]),
      };
    },
  };
  const mod = await import("../../../../src/document/formats/codecs/raster-hdr.js");
  exrCodec = mod.exrCodec;
  fitsCodec = mod.fitsCodec;
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

function fitsCard(keyword, value) {
  var card = keyword.padEnd(8, " ") + "= " + value;
  while (card.length < 80) card += " ";
  return card;
}

describe("document/formats/codecs/raster-hdr.js", () => {
  it("exrCodec.decode returns one flipped RGBA frame", () => {
    var frames = exrCodec.decode(new ArrayBuffer(8), null);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].rect.width, 1);
    assert.equal(frames[0].rect.height, 1);
    var rgba = new Uint8Array(frames[0].data);
    assert.equal(rgba.length, 4);
    assert.equal(rgba[3], 255);
  });

  it("fitsCodec.decode reads a minimal 16-bit FITS image", () => {
    var headerText =
      fitsCard("SIMPLE", "T") +
      fitsCard("BITPIX", "16") +
      fitsCard("NAXIS", "2") +
      fitsCard("NAXIS1", "1") +
      fitsCard("NAXIS2", "1") +
      fitsCard("OBJECT", "'star'") +
      fitsCard("END", "");
    var headerBytes = new TextEncoder().encode(headerText);
    var paddedHeader = new Uint8Array(2880);
    paddedHeader.set(headerBytes);
    var pixelBytes = new Uint8Array(2);
    pixelBytes[0] = 255;
    pixelBytes[1] = 0;
    var fileBytes = new Uint8Array(paddedHeader.length + pixelBytes.length);
    fileBytes.set(paddedHeader, 0);
    fileBytes.set(pixelBytes, paddedHeader.length);
    var frames = fitsCodec.decode(fileBytes.buffer);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].rect.width, 1);
    assert.equal(frames[0].rect.height, 1);
    assert.equal(frames[0].layerName, "'star'");
    assert.equal(frames[0].data[0], 255);
    assert.equal(frames[0].data[3], 255);
  });

});
