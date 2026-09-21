import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let jpegCodec;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  // jpeg.js imports registry-api, which pulls psd-document → file-format-registry →
  // webp before registry-api finishes initializing; bootstrap the registry first.
  await import("../../../../src/document/formats/registry/file-format-registry.js");
  const mod = await import("../../../../src/document/formats/codecs/jpeg.js");
  jpegCodec = mod.jpegCodec;
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/codecs/jpeg.js", () => {
  it("scanJpegMarkers finds SOI and EOI in a minimal JPEG", () => {
    var bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    var markers = jpegCodec.scanJpegMarkers(bytes);
    assert.ok(markers[216]);
    assert.ok(markers[217]);
  });

  it("isGrayscaleRgbPixels detects gray RGBA", () => {
    var gray = new Uint8Array([10, 10, 10, 255, 20, 20, 20, 255]);
    var color = new Uint8Array([10, 20, 10, 255]);
    assert.equal(jpegCodec.isGrayscaleRgbPixels(gray), true);
    assert.equal(jpegCodec.isGrayscaleRgbPixels(color), false);
  });

});
