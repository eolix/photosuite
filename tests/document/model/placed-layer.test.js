import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let LinkedFileItem;
let Layer;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  await import("../../../src/document/formats/registry/file-format-registry.js");
  ({ Layer } = await import("../../../src/document/model/layer.js"));
  ({ LinkedFileItem } = await import("../../../src/document/model/placed-layer.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/model/placed-layer.js", () => {
  it("registers LinkedFileItem on Layer", () => {
    assert.equal(Layer.LinkedFileItem, LinkedFileItem);
  });

  it("clone copies metadata and duplicates raw bytes", () => {
    const item = new LinkedFileItem();
    item.fileName = "embedded.psd";
    item.fileTypeFourCC = "8BPS";
    item.raw = new Uint8Array([1, 2, 3, 4]);
    const cloned = item.clone();
    assert.equal(cloned.fileName, "embedded.psd");
    assert.equal(cloned.fileTypeFourCC, "8BPS");
    assert.notEqual(cloned.raw.buffer, item.raw.buffer);
    assert.deepEqual([...cloned.raw], [1, 2, 3, 4]);
  });
});
