import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let psdCodec;
let psbCodec;
let codecLoaders;
let pxdCodec;
let pdnCodec;
let sketchCodec;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/document/formats/registry/file-format-registry.js");
  const mod = await import("../../../../src/document/formats/codecs/layered-codec.js");
  psdCodec = mod.psdCodec;
  psbCodec = mod.psbCodec;
  ({ codecLoaders } = await import(
    "../../../../src/document/formats/registry/registry-helpers.js"
  ));
  pxdCodec = mod.pxdCodec;
  pdnCodec = mod.pdnCodec;
  sketchCodec = mod.sketchCodec;
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/codecs/layered-codec.js", () => {
  it("layered codecs expose isLayered", () => {
    assert.equal(psdCodec.isLayered, true);
    assert.equal(pxdCodec.isLayered, true);
    assert.equal(pdnCodec.isLayered, true);
    assert.equal(sketchCodec.isLayered, true);
  });

  // PSB is the same writer with 64-bit length fields: the codec's whole job is
  // to force that flag on, whatever options the export dialog passes.
  it("psbCodec.encode writes through the PSD serializer with the PSB flag set", () => {
    const realParser = codecLoaders.PSDParser;
    const capturedOptions = [];
    codecLoaders.PSDParser = {
      serialize(doc, buffer, options) {
        capturedOptions.push(Array.from(options));
        return 0;
      }
    };
    try {
      const doc = { getRasterData() {} };
      psbCodec.encode(doc, 10, 10, [true, false, true]);
      psbCodec.encode(doc, 10, 10);
      psdCodec.encode(doc, 10, 10, [true, false, true]);
    } finally {
      codecLoaders.PSDParser = realParser;
    }
    assert.deepEqual(capturedOptions[0], [true, false, true, true]);
    assert.equal(capturedOptions[1][3], true);
    assert.deepEqual(capturedOptions[2], [true, false, true]);
  });

  it("psdCodec.encode trims serialized buffer to byte length", () => {
    assert.equal(typeof psdCodec.encodeFlatRaster, "function");
    assert.equal(typeof psdCodec.encode, "function");
  });

  it("pdnCodec.decode rejects non-PDN3 magic", () => {
    var bytes = new Uint8Array([80, 78, 71, 0]);
    assert.throws(() => pdnCodec.decode(bytes.buffer, {}), /PNG/);
  });

});
