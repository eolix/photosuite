/**
 * HistogramCanvas handle hit-test goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let hitTestLevelHandle;
let shouldLinkOppositeHandlesOnDrag;
let clampLevelByte;
let CHANNEL_GRADIENT_END_HEX;
let HistogramCanvas;

before(async () => {
  ({
    hitTestLevelHandle,
    shouldLinkOppositeHandlesOnDrag,
    clampLevelByte,
    CHANNEL_GRADIENT_END_HEX,
    HistogramCanvas
  } = await import("../../../../src/ui/widgets/controls/histogram-canvas.js"));
});

describe("ui/widgets/controls/histogram-canvas.js", () => {
  it("hitTestLevelHandle goldens", () => {
    var thresholds = [0, 20, 200, 255];
    assert.equal(hitTestLevelHandle(-2, thresholds), 0);
    assert.equal(hitTestLevelHandle(22, thresholds), 1);
    assert.equal(hitTestLevelHandle(100, thresholds), -1);
    assert.equal(hitTestLevelHandle(198, thresholds), 2);
  });

  it("shouldLinkOppositeHandlesOnDrag goldens", () => {
    assert.equal(shouldLinkOppositeHandlesOnDrag(false, 0, [0, 20, 200, 255]), true);
    assert.equal(shouldLinkOppositeHandlesOnDrag(false, 0, [10, 10, 200, 255]), false);
    assert.equal(shouldLinkOppositeHandlesOnDrag(true, 0, [10, 10, 200, 255]), true);
  });

  it("clampLevelByte goldens", () => {
    assert.equal(clampLevelByte(-5), 0);
    assert.equal(clampLevelByte(300), 255);
    assert.equal(clampLevelByte(12.4), 12);
  });

  it("CHANNEL_GRADIENT_END_HEX + constructor", () => {
    assert.deepEqual(CHANNEL_GRADIENT_END_HEX, ["ffffff", "ff0000", "00ff00", "0000ff"]);
    assert.equal(typeof HistogramCanvas, "function");
  });
});
