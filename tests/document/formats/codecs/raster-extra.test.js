import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let lifCodec;
let exeCodec;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  globalThis.DOMParser = class DOMParser {
    parseFromString() {
      return { firstChild: { firstChild: { children: [], firstChild: { firstChild: null } } } };
    }
  };
  await import("../../../../src/document/formats/registry/file-format-registry.js");
  const mod = await import("../../../../src/document/formats/codecs/raster-extra.js");
  lifCodec = mod.lifCodec;
  exeCodec = mod.exeCodec;
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/codecs/raster-extra.js", () => {
  it("lifCodec.decode rejects invalid marker byte", () => {
    var bytes = new Uint8Array(16);
    bytes.fill(0);
    assert.throws(() => lifCodec.decode(bytes.buffer), /e/);
  });

  it("exeCodec.decode returns empty array for non-PE buffers", () => {
    var layers = exeCodec.decode(new ArrayBuffer(4));
    assert.ok(Array.isArray(layers));
    assert.equal(layers.length, 0);
  });

});
