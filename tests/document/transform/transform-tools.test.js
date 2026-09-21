import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let TransformToolBase;
let Rect;
let Point;
let ShapeToolBase;
let restoreBrowserGlobals;
let PuppetWarpTool;
let SliceSelectTool;
let SliceTool;
let ContentAwareScaleTool;
let FreeTransformTool;
let ObjectSelectTool;
let WarpTool;

function chainToolPrototypes() {
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ TransformToolBase } = await import("../../../src/document/transform/transform-static.js"));
  ({ Rect } = await import("../../../src/core/math/rect.js"));
  ({ Point } = await import("../../../src/core/math/point.js"));
  globalThis.alert = () => {};
  await import("../../../src/engine/layer-system.js");
  await import("../../../src/document/tools/paint-tools.js");
  await import("../../../src/document/tools/selection-tools.js");
  await import("../../../src/document/tools/lasso-tools.js");
  await import("../../../src/document/tools/move-tools.js");
  await import("../../../src/document/transform/transform-tools.js");
  ({ ShapeToolBase } = await import("../../../src/document/tools/shape-tools.js"));
  ({ PuppetWarpTool } = await import("../../../src/document/transform/puppet-warp-tool.js"));
  ({ SliceSelectTool, SliceTool } = await import("../../../src/document/transform/slice-tools.js"));
  ({ ContentAwareScaleTool, FreeTransformTool, ObjectSelectTool, WarpTool } = await import("../../../src/document/transform/transform-tools.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/transform/transform-tools.js registration", () => {
  it("registerTransformTools wires transform and slice constructors", () => {
    chainToolPrototypes();
    assert.equal(typeof FreeTransformTool, "function");
    assert.equal(typeof WarpTool, "function");
    assert.equal(typeof ContentAwareScaleTool, "function");
    assert.equal(typeof PuppetWarpTool, "function");
    assert.equal(typeof SliceTool, "function");
    assert.equal(typeof SliceSelectTool, "function");
    assert.equal(typeof ObjectSelectTool, "function");
    assert.equal(typeof TransformToolBase.prototype.previewTransform, "function");
  });
});

describe("ObjectSelectTool", () => {
  it("ObjectSelectTool.getSelection forwards the keyboard (not pointerState) to constrainShapePoints", () => {
    chainToolPrototypes();
    // getSelectionRect delegates to ShapeToolBase.constrainShapePoints; capture
    // which object lands in its keyboard slot. Forwarding pointerState there
    // instead crashes on .isPressed the moment there is no selection.
    const keyboard = { isPressed: () => false, tag: "keyboard" };
    const pointerState = { x: 50, y: 40, isDown: false, tag: "pointerState" };
    let keyboardArg;
    const realConstrainShapePoints = ShapeToolBase.constrainShapePoints;
    ShapeToolBase.constrainShapePoints = function (startPoint, endPoint, keyboardParam) {
      keyboardArg = keyboardParam;
      return [startPoint, endPoint];
    };
    const tool = new ObjectSelectTool();
    tool.startPos = new Point(0, 0);
    tool.cursorPos = new Point(50, 40);
    tool.exceededDragThreshold = true;
    tool.shiftModifierStage = 0;
    tool.altModifierStage = 0;
    const doc = {
      selectionMask: null,
      width: 100,
      height: 100,
      layers: [{ rect: new Rect(0, 0, 100, 100) }],
      selectedLayerIndices: [0],
    };
    let action;
    try {
      action = tool.getSelection(doc, {}, keyboard, pointerState);
    } finally {
      ShapeToolBase.constrainShapePoints = realConstrainShapePoints;
    }
    assert.equal(keyboardArg, keyboard, "constrainShapePoints must receive the keyboard, not pointerState");
    assert.equal(action.actionDescriptor.T.v.classID, "ObSl");
  });
});
