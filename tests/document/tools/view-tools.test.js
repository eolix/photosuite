import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { Point } from "../../../src/core/math/point.js";
import { makeElement } from "../../../src/core/dom.js";

let ToolId;
let restoreBrowserGlobals;
let EyedropperTool;
let HandTool;
let RotateViewTool;
let RulerTool;
let ZoomTool;


// Chain the tool prototypes these tests construct from.
function chainToolPrototypes() {
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  globalThis.alert = () => {};
  await import("../../../src/engine/layer-system.js");
  await import("../../../src/document/tools/view-tools.js");
  ({ EyedropperTool, HandTool, RotateViewTool, RulerTool, ZoomTool } = await import("../../../src/document/tools/view-tools.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/tools/view-tools.js", () => {
  it("registerViewTools wires view constructors", () => {
    chainToolPrototypes();
    const zoom = new ZoomTool();
    const hand = new HandTool();
    const ruler = new RulerTool();
    const eye = new EyedropperTool();
    const rotate = new RotateViewTool();

    assert.equal(zoom.id, ToolId.TOOL_ZOOM);
    assert.equal(hand.id, ToolId.TOOL_HAND);
    assert.equal(ruler.id, ToolId.TOOL_RULER);
    assert.equal(eye.id, ToolId.TOOL_EYEDROPPER);
    assert.equal(rotate.id, ToolId.TOOL_ROTATE_VIEW);
    assert.equal(typeof ZoomTool.fitZoomToBounds, "function");
    assert.equal(typeof HandTool.setViewScrollOrigin, "function");
  });

  it("ZoomTool.fitZoomToBounds matches goldens", () => {
    chainToolPrototypes();
    assert.equal(ZoomTool.fitZoomToBounds(1000, 800, 500, 400), 0.5);
    assert.equal(ZoomTool.fitZoomToBounds(100, 100, 500, 400), 1);
  });

  it("ZoomTool step/index helpers match goldens", () => {
    chainToolPrototypes();
    assert.equal(ZoomTool.findZoomStepIndex(1), 9);
    assert.equal(ZoomTool.findZoomStepIndex(0.5), 11);
    assert.equal(ZoomTool.findZoomStepIndex(3), 7);
    assert.equal(ZoomTool.stepZoomLevel(1, true), 2);
    assert.equal(ZoomTool.stepZoomLevel(1, false), 2 / 3);
    assert.equal(ZoomTool.ZOOM_STEPS[0], 32);
    assert.equal(ZoomTool.ZOOM_STEPS.at(-1), 1 / 64);
  });

  it("RulerTool.pointToSegmentDistance matches math", () => {
    chainToolPrototypes();
    assert.equal(
      RulerTool.pointToSegmentDistance(new Point(0, 0), new Point(10, 0), new Point(5, 3)),
      3,
    );
    assert.equal(
      RulerTool.pointToSegmentDistance(new Point(0, 0), new Point(0, 10), new Point(4, 5)),
      4,
    );
  });

  it("EyedropperTool.sampleCompositeColor averages a single-pixel sample", () => {
    chainToolPrototypes();
    const width = 4;
    const height = 4;
    const raster = new Uint8ClampedArray(width * height * 4);
    // pixel (1,1) = rgb(10,20,30)
    const off = 4 * (1 * width + 1);
    raster[off] = 10;
    raster[off + 1] = 20;
    raster[off + 2] = 30;
    raster[off + 3] = 255;
    const doc = {
      width,
      height,
      getRasterData: () => raster,
      pathViewport: {
        screenToDocPoint: (x, y) => new Point(x, y),
      },
    };
    const color = EyedropperTool.sampleCompositeColor(
      doc,
      { x: 1.2, y: 1.4 },
      1,
    );
    assert.equal(color, 10 << 16 | 20 << 8 | 30);
  });

  it("ZoomTool.setMaskViewMode maps modes to channel visibility + active", () => {
    chainToolPrototypes();
    const tool = new ZoomTool();
    function runMode(mode) {
      const maskTarget = { active: null };
      const doc = {
        selectedLayerIndices: [0],
        layers: [{ pixelContent: 1, getMask: () => maskTarget }],
        pathViewport: { channelVisibility: null },
        extraChannels: [{ active: true }],
        activeChannels: [1],
        dirty: false,
      };
      tool.setMaskViewMode(doc, { maskViewMode: mode });
      return {
        vis: doc.pathViewport.channelVisibility.join(""),
        active: maskTarget.active,
        extraCleared: doc.extraChannels[0].active === false,
        activeChannelsCleared: doc.activeChannels.length === 0,
      };
    }
    // Behaviour must match the per-mode if-ladder.
    assert.deepEqual(runMode(0), { vis: "111", active: false, extraCleared: true, activeChannelsCleared: true });
    assert.deepEqual(runMode(1), { vis: "111", active: true, extraCleared: true, activeChannelsCleared: true });
    assert.deepEqual(runMode(2), { vis: "000", active: true, extraCleared: true, activeChannelsCleared: true });
  });
});
