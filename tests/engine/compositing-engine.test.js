import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";
import { allocBuffer } from "../../src/engine/compositing/buffer-utils.js";
import { gaussianBlurByte } from "../../src/engine/compositing/blur.js";

let LayerSystem;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ LayerSystem } = await import("../../src/engine/layer-system.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("engine/layer-system.js composition root", () => {
  // The engine is plain modules; what is left here is the one piece with an
  // assembly order, the GL layer system the diffuse filter renders through.
  it("builds the layer system", () => {
    assert.ok(LayerSystem, "LayerSystem export should be defined");
  });

  it("leaves the rest of the engine as ordinary imports", () => {
    assert.equal(typeof allocBuffer, "function");
    assert.equal(typeof gaussianBlurByte, "function");
  });
});
