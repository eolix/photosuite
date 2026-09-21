import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { Point } from "../../../src/core/math/point.js";
import { Rect } from "../../../src/core/math/rect.js";

let restoreBrowserGlobals;
let PuppetWarpTool;

function chainToolPrototypes() {
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  globalThis.alert = () => {};
  await import("../../../src/engine/layer-system.js");
  await import("../../../src/document/tools/paint-tools.js");
  await import("../../../src/document/tools/selection-tools.js");
  await import("../../../src/document/tools/lasso-tools.js");
  await import("../../../src/document/tools/move-tools.js");
  await import("../../../src/document/transform/transform-tools.js");
  ({ PuppetWarpTool } = await import("../../../src/document/transform/puppet-warp-tool.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("PuppetWarpTool registration", () => {
  it("installs constructor and static mesh helpers", () => {
    chainToolPrototypes();
    assert.equal(typeof PuppetWarpTool, "function");
    assert.equal(typeof PuppetWarpTool.canActivatePuppetWarp, "function");
    assert.equal(typeof PuppetWarpTool.buildPuppetMesh, "function");
    assert.equal(typeof PuppetWarpTool.meshToPathOverlay, "function");
    assert.equal(typeof PuppetWarpTool.addPuppetPin, "function");
    assert.equal(typeof PuppetWarpTool.drawPuppetOverlay, "function");
  });

  it("canActivatePuppetWarp rejects null and multi-selection", () => {
    chainToolPrototypes();
    assert.equal(PuppetWarpTool.canActivatePuppetWarp(null), false);
    assert.equal(
      PuppetWarpTool.canActivatePuppetWarp({
        selectedLayerIndices: [0, 1],
        layers: [{}, {}],
        ensureLayerEditableForTools: () => true,
      }),
      false,
    );
  });
});
