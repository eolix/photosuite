import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { Point } from "../../../src/core/math/point.js";
import { makeElement } from "../../../src/core/dom.js";

let ToolId;
let KeyboardHandler;
let restoreBrowserGlobals;
let CustomShapeTool;
let EllipseShapeTool;
let FreePenTool;
let LineShapeTool;
let ParametricShapeTool;
let RectShapeTool;
let ShapeToolBase;


// Chain the tool prototypes these tests construct from.
function chainToolPrototypes() {
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  globalThis.alert = () => {};
  await import("../../../src/engine/layer-system.js");
  ({ KeyboardHandler } = await import("../../../src/core/keyboard-handler.js"));
  await import("../../../src/document/tools/paint-tools.js");
  await import("../../../src/document/tools/pen-path-tools.js");
  await import("../../../src/document/tools/shape-tools.js");
  ({ CustomShapeTool, EllipseShapeTool, FreePenTool, LineShapeTool, ParametricShapeTool, RectShapeTool, ShapeToolBase } = await import("../../../src/document/tools/shape-tools.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/tools/shape-tools.js", () => {
  it("registerShapeTools wires shape constructors", () => {
    chainToolPrototypes();
    const rect = new RectShapeTool();
    const ellipse = new EllipseShapeTool();
    const line = new LineShapeTool();
    const parametric = new ParametricShapeTool();
    const custom = new CustomShapeTool();
    const freePen = new FreePenTool();

    assert.equal(typeof ShapeToolBase, "function");
    assert.equal(rect.id, ToolId.TOOL_RECT_SHAPE);
    assert.equal(ellipse.id, ToolId.TOOL_ELLIPSE_SHAPE);
    assert.equal(line.id, ToolId.TOOL_LINE_SHAPE);
    assert.equal(parametric.id, ToolId.TOOL_PARAMETRIC_SHAPE);
    assert.equal(custom.id, ToolId.TOOL_CUSTOM_SHAPE);
    assert.equal(freePen.id, ToolId.TOOL_FREE_PEN);
    assert.equal(rect.toolOptions.tmode, 1);
    assert.equal(rect.snapShapeToPixelGrid, true);
    assert.equal(line.snapShapeToPixelGrid, false);
  });

  it("constrainShapePoints matches goldens", () => {
    chainToolPrototypes();
    const kbNone = { isPressed: () => false };
    const kbShift = { isPressed: (key) => key === KeyboardHandler.Shift };
    const kbAlt = { isPressed: (key) => key === KeyboardHandler.Alt };

    let [start, end] = ShapeToolBase.constrainShapePoints(
      new Point(10.2, 20.7),
      new Point(50.9, 80.1),
      kbNone,
      true,
      { constraintMode: 0 },
    );
    assert.deepEqual({ x: start.x, y: start.y }, { x: 10, y: 20 });
    assert.deepEqual({ x: end.x, y: end.y }, { x: 51, y: 81 });

    [start, end] = ShapeToolBase.constrainShapePoints(
      new Point(0, 0),
      new Point(100, 50),
      kbShift,
      false,
      { constraintMode: 0 },
    );
    assert.deepEqual({ x: start.x, y: start.y }, { x: 0, y: 0 });
    assert.deepEqual({ x: end.x, y: end.y }, { x: 50, y: 50 });

    [start, end] = ShapeToolBase.constrainShapePoints(
      new Point(50, 50),
      new Point(100, 80),
      kbAlt,
      false,
      { constraintMode: 0 },
    );
    assert.deepEqual({ x: start.x, y: start.y }, { x: 0, y: 20 });
    assert.deepEqual({ x: end.x, y: end.y }, { x: 100, y: 80 });

    [start, end] = ShapeToolBase.constrainShapePoints(
      new Point(100, 100),
      new Point(150.4, 180.6),
      kbNone,
      true,
      { constraintMode: 2, constraintWidth: 40, constraintHeight: 60 },
    );
    assert.deepEqual({ x: start.x, y: start.y }, { x: 110, y: 121 });
    assert.deepEqual({ x: end.x, y: end.y }, { x: 150, y: 181 });

    [start, end] = ShapeToolBase.constrainShapePoints(
      new Point(0, 0),
      new Point(100, 40),
      kbNone,
      false,
      { constraintMode: 1, constraintWidth: 2, constraintHeight: 1 },
    );
    assert.deepEqual({ x: start.x, y: start.y }, { x: 0, y: 0 });
    assert.deepEqual({ x: end.x, y: end.y }, { x: 80, y: 40 });
  });

  it("RectShapeTool.buildShapePaths encodes Rctn key-origin bounds", () => {
    chainToolPrototypes();
    const rect = new RectShapeTool();
    rect.toolOptions.crad = 12;
    const [, shapeDescriptor] = rect.buildShapePaths(new Point(0, 0), new Point(100, 50), false);
    assert.equal(shapeDescriptor.v.classID, "Rctn");
    assert.equal(shapeDescriptor.v.Left.v.val, 0);
    assert.equal(shapeDescriptor.v.Top.v.val, 0);
    assert.equal(shapeDescriptor.v.Rght.v.val, 100);
    assert.equal(shapeDescriptor.v.Btom.v.val, 50);
    assert.equal(shapeDescriptor.v.topLeft.v.val, 12);
  });

  it("EllipseShapeTool and LineShapeTool buildShapePaths match descriptors", () => {
    chainToolPrototypes();
    const ellipse = new EllipseShapeTool();
    const [, ellipseDesc] = ellipse.buildShapePaths(new Point(10, 20), new Point(110, 120), false);
    assert.equal(ellipseDesc.v.classID, "Elps");
    assert.equal(ellipseDesc.v.Left.v.val, 10);
    assert.equal(ellipseDesc.v.Btom.v.val, 120);

    const line = new LineShapeTool();
    line.toolOptions.width = 5;
    const [, lineDesc] = line.buildShapePaths(new Point(0, 0), new Point(100, 0), false);
    assert.equal(lineDesc.v.classID, "Ln");
    assert.equal(lineDesc.v.Strt.v.Hrzn.v.val, 0);
    assert.equal(lineDesc.v.End.v.Hrzn.v.val, 100);
    assert.equal(lineDesc.v.Wdth.v.val, 5);
  });

  it("registration loop exposes every shape tool under its constructor name", () => {
    chainToolPrototypes();
    const shapeTools = [FreePenTool, RectShapeTool, EllipseShapeTool, ParametricShapeTool, LineShapeTool, CustomShapeTool];
    for (const Tool of shapeTools) {
      assert.equal(typeof Tool, "function", Tool.name);
      assert.ok(new Tool() instanceof ShapeToolBase, Tool.name);
    }
  });
});
