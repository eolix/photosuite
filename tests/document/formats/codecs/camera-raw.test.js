import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let rafCodec;
let rawCodec;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  const mod = await import("../../../../src/document/formats/codecs/camera-raw.js");
  rafCodec = mod.rafCodec;
  rawCodec = mod.rawCodec;
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/codecs/camera-raw.js", () => {
  it("decodeFujiRafStrip expands a 2×2 strip", () => {
    var stripBytes = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]);
    var expanded = rafCodec.decodeFujiRafStrip(stripBytes, 2, 2);
    assert.equal(expanded.length, 8);
    assert.equal(expanded[0], 1);
    assert.equal(expanded[1], 3);
  });

  it("rawCodec.encode writes 8-bit RGB from RGBA", () => {
    var rgba = new Uint8Array([255, 128, 64, 255]);
    var buffer = rawCodec.encode([[rgba.buffer]], 1, 1, [1, 0, 0]);
    var out = new Uint8Array(buffer);
    assert.deepEqual(Array.from(out), [255, 128, 64]);
  });

  it("rawCodec has no in-dialog preview", () => {
    assert.equal(rawCodec.noPreviewAvailable, true);
  });

});
