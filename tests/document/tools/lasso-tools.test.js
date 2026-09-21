import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let restoreBrowserGlobals;
let ToolBase;
let LassoTool;
let MagneticLassoTool;
let PolygonLassoTool;
let RectSelectTool;
let SelectTool;

// Chain the tool prototypes these tests construct from.
function chainToolPrototypes() {
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  await import("../../../src/document/tools/paint-tools.js");
  await import("../../../src/document/tools/selection-tools.js");
  await import("../../../src/document/tools/lasso-tools.js");
  ({ ToolBase } = await import("../../../src/document/model/tool-base.js"));
  ({ LassoTool, MagneticLassoTool, PolygonLassoTool } = await import("../../../src/document/tools/lasso-tools.js"));
  ({ RectSelectTool, SelectTool } = await import("../../../src/document/tools/selection-tools.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});


function installOverlayStub() {
  ToolBase.drawDimensionOverlay = () => {};
}

// A document carrying one vertical and one horizontal guide, at 22 and 150.
// Snapping pulls a coordinate in only from within four screen pixels, so 20
// lands on the guide at 22 while a point out in open canvas is left alone.
function createSnapDoc(Point) {
  return {
    width: 200,
    height: 200,
    selectionMask: null,
    selectedLayerIndices: [0],
    layers: [],
    extraChannels: [],
    guides: [[22, 150], [22, 150]],
    slices: [],
    selectedSliceIndices: [],
    dirty: false,
    toolOverlayState: { overlayTransform: null, floatingBitmapOverlays: [] },
    pathViewport: {
      zoomScale: 1,
      dimensionOverlay: null,
      screenToDocPoint(x, y) {
        return new Point(x, y);
      },
    },
  };
}

const NO_KEYS = { isPressed: () => false };
// showToggles selects what may be snapped to: guides only, so the assertions
// turn on the guides and nothing else.
const APP_DATA = {
  prefs: { showSelectionEdges: true, guides: true, showGrid: false, slices: false },
  extras: true,
  snapEnabled: true,
  showToggles: [true, false, false, false, false],
};
const pointerAt = (x, y, isDown) => ({ x, y, screenX: x, screenY: y, isDown });

describe("document/tools/lasso-tools.js", () => {
  it("registers the three lasso tools as SelectTool subclasses", () => {
    chainToolPrototypes();
    for (const Tool of [PolygonLassoTool, MagneticLassoTool, LassoTool]) {
      const tool = new Tool();
      assert.ok(tool instanceof SelectTool, Tool.name);
      assert.equal(tool.defaultCursorStyle, "crosshair", Tool.name);
    }
  });


  it("freehand lasso samples raw pointer positions, unsnapped", async () => {
    const { Point } = await import("../../../src/core/math/point.js");
    chainToolPrototypes();
    installOverlayStub();
    const tool = new LassoTool();
    const doc = createSnapDoc(Point);
    const dispatcher = { dispatch() {} };

    tool.onMouseDown(doc, dispatcher, APP_DATA, NO_KEYS, pointerAt(20, 20, true));
    for (const [x, y] of [[38, 24], [61, 47], [43, 72]]) {
      tool.onMouseMove(doc, dispatcher, APP_DATA, NO_KEYS, pointerAt(x, y, true));
    }

    // Anchor snaps at mouse-down (20,20 -> 22,22); the traced samples are not.
    assert.deepEqual(tool.polygonPathOverlay.coords, [22, 22, 38, 24, 61, 47, 43, 72]);
    assert.deepEqual(tool.polygonPathOverlay.commands, ["M", "L", "L", "L"]);
  });

  it("marquee still snaps its drag point to guides", async () => {
    const { Point } = await import("../../../src/core/math/point.js");
    chainToolPrototypes();
    installOverlayStub();
    const tool = new RectSelectTool();
    const doc = createSnapDoc(Point);
    const dispatcher = { dispatch() {} };

    tool.onMouseDown(doc, dispatcher, APP_DATA, NO_KEYS, pointerAt(20, 20, true));
    tool.onMouseMove(doc, dispatcher, APP_DATA, NO_KEYS, pointerAt(148, 152, true));
    assert.deepEqual([tool.cursorPos.x, tool.cursorPos.y], [150, 150]);
  });


  it("a traced outline is recorded as a Lasso Select history step", async () => {
    const { Point } = await import("../../../src/core/math/point.js");
    chainToolPrototypes();
    installOverlayStub();
    const tool = new LassoTool();
    const doc = createSnapDoc(Point);
    // Rasterising needs a real 2D context; only the history label matters here.
    tool.bezierPathToSelectionMask = () => null;
    const outcome = tool.applyScriptedShapeSelection(
      "set",
      SelectTool.buildPolygonSelectionAction([0, 0, 10, 0, 10, 10]).actionDescriptor,
      { dispatch() {} },
      doc,
      NO_KEYS,
      APP_DATA,
      null,
    );
    assert.equal(outcome.label, "tools.lassoSelect");
  });

  it("polygon lasso activity tracks its path overlay", () => {
    chainToolPrototypes();
    const tool = new PolygonLassoTool();
    assert.equal(tool.isActive(), false);
    assert.equal(tool.shouldCancelMouseDown(), false);
    tool.polygonPathOverlay = { coords: [0, 0, 1, 1], commands: ["M", "L"] };
    assert.equal(tool.isActive(), true);
    assert.equal(tool.shouldCancelMouseDown(), true);
    tool.clearPolygonPathOverlay(null);
    assert.equal(tool.polygonPathOverlay, null);
  });

  it("magnetic lasso maps pixel indices to centred overlay coords", () => {
    chainToolPrototypes();
    const doc = { width: 10 };
    const coords = MagneticLassoTool.indicesToOverlayCoords(doc, [0, 11, 25]);
    assert.deepEqual(coords, [0.5, 0.5, 1.5, 1.5, 5.5, 2.5]);
  });

  it("magnetic lasso clear resets search state and overlay", () => {
    chainToolPrototypes();
    const tool = new MagneticLassoTool();
    tool.nodes = [1, 2];
    tool.magneticAnchorPoints = [{ x: 0, y: 0 }];
    const doc = { toolOverlayState: { overlayTransform: {}, squareMarkerCoords: [1] }, dirty: false };
    tool.clear(doc);
    assert.deepEqual(tool.nodes, []);
    assert.deepEqual(tool.magneticAnchorPoints, []);
    assert.equal(doc.toolOverlayState.overlayTransform, null);
    assert.equal(doc.dirty, true);
  });
});
