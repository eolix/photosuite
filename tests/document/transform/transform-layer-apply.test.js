import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let rasterizeWithMatrix;
let transformPixels;
let restoreBrowserGlobals;
let installTransformLayerApplyStatics;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ rasterizeWithMatrix, transformPixels } = await import("../../../src/document/render/raster-transform.js"));
  ({ installTransformLayerApplyStatics } = await import(
    "../../../src/document/transform/transform-layer-apply.js"
  ));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("installTransformLayerApplyStatics", () => {
  it("attaches capture, restore, and apply statics", () => {
    function TransformToolBase() {}

    installTransformLayerApplyStatics(TransformToolBase, {});

    assert.equal(typeof TransformToolBase.getSelectionRect, "function");
    assert.equal(typeof TransformToolBase.captureLayerSnapshots, "function");
    assert.equal(typeof TransformToolBase.restoreLayerSnapshots, "function");
    assert.equal(typeof TransformToolBase.applyTransformToLayers, "function");
    assert.equal(typeof TransformToolBase.transformChannelMask, "function");
  });

  // Redrawing pixels under a matrix is not a tool concern, so the two entry
  // points the tool statics call stand on their own in the render module.
  it("leaves the rasterizer to the render module", () => {
    assert.equal(typeof rasterizeWithMatrix, "function");
    assert.equal(typeof transformPixels, "function");
  });
});
