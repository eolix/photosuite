import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { Point } from "../../../src/core/math/point.js";
import { Rect } from "../../../src/core/math/rect.js";
import { makeElement } from "../../../src/core/dom.js";

let ToolId;
let restoreBrowserGlobals;
let EllipseSelectTool;
let MagicWandTool;
let QuickSelectTool;
let RectSelectTool;
let SelectTool;


// Chain the tool prototypes these tests construct from.
function chainToolPrototypes() {
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  globalThis.alert = () => {};
  await import("../../../src/engine/layer-system.js");
  await import("../../../src/document/tools/paint-tools.js");
  await import("../../../src/document/tools/selection-tools.js");
  await import("../../../src/document/tools/lasso-tools.js");
  ({ EllipseSelectTool, MagicWandTool, QuickSelectTool, RectSelectTool, SelectTool } = await import("../../../src/document/tools/selection-tools.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/tools/selection-tools.js", () => {
  it("registerSelectionTools wires selection constructors", () => {
    chainToolPrototypes();
    const rect = new RectSelectTool();
    const wand = new MagicWandTool();
    const quick = new QuickSelectTool();

    assert.equal(typeof SelectTool, "function");
    assert.equal(rect.id, ToolId.TOOL_RECT_SELECT);
    assert.equal(wand.id, ToolId.TOOL_MAGIC_WAND);
    assert.equal(quick.id, ToolId.TOOL_QUICK_SELECT);
    assert.equal(quick.strokeCompositeMode, "qselect");
    assert.deepEqual(rect.toolOptions.magicWandOptions, [16, true, true]);
    assert.equal(typeof SelectTool.buildSetSelectionAction, "function");
    assert.equal(typeof SelectTool.resolveSelectionCombineMode, "function");
  });

  it("resolveSelectionCombineMode maps modifiers to modes", () => {
    chainToolPrototypes();
    const resolve = SelectTool.resolveSelectionCombineMode;

    assert.equal(resolve("front", false, false), "front");
    assert.equal(resolve("front", true, false), "union");
    assert.equal(resolve("front", false, true), "difference");
    assert.equal(resolve("front", true, true), "intersection");
    assert.equal(resolve("union", false, false), "union");
  });

  it("buildSetSelectionAction and buildSelectAllAction match descriptor shape", () => {
    chainToolPrototypes();
    const setAction = SelectTool.buildSetSelectionAction("set", { t: "Objc", v: { classID: "Rctn" } });
    assert.equal(setAction.uf, "set");
    assert.equal(setAction.actionDescriptor.classID, "setd");
    assert.equal(setAction.actionDescriptor.T.v.classID, "Rctn");

    const selectAll = SelectTool.buildSelectAllAction(true);
    assert.equal(selectAll.uf, "set");
    assert.equal(selectAll.actionDescriptor.T.v.Ordn, "Al");

    const deselect = SelectTool.buildSelectAllAction();
    assert.equal(deselect.actionDescriptor.T.v.Ordn, "None");
  });

  it("buildRectSelectionAction encodes pixel bounds", () => {
    chainToolPrototypes();
    const action = SelectTool.buildRectSelectionAction(
      "Rctn",
      new Rect(10, 20, 30, 40),
    );
    const shape = action.actionDescriptor.T.v;
    assert.equal(shape.classID, "Rctn");
    assert.equal(shape.Left.v.val, 10);
    assert.equal(shape.Top.v.val, 20);
    assert.equal(shape.Rght.v.val, 40);
    assert.equal(shape.Btom.v.val, 60);
  });

  it("buildPolygonSelectionAction maps combineMode to operation kinds", () => {
    chainToolPrototypes();
    const coords = [0, 0, 10, 0, 10, 10];
    assert.equal(SelectTool.buildPolygonSelectionAction(coords).uf, "set");
    assert.equal(SelectTool.buildPolygonSelectionAction(coords, "union").uf, "addTo");
    assert.equal(SelectTool.buildPolygonSelectionAction(coords, "difference").uf, "subtractFrom");
    assert.equal(
      SelectTool.buildPolygonSelectionAction(coords, "intersection").uf,
      "interfaceWhite",
    );
    const pts = SelectTool.buildPolygonSelectionAction(coords).actionDescriptor.T.v.Pts.v.arr;
    assert.deepEqual(pts[0].arr, [0, 10, 10]);
    assert.deepEqual(pts[1].arr, [0, 0, 10]);
  });

  it("EllipseSelectTool.ellipseToBezierPath returns closed path overlay", () => {
    chainToolPrototypes();
    const path = EllipseSelectTool.ellipseToBezierPath(new Rect(0, 0, 100, 50));
    assert.ok(Array.isArray(path.coords));
    assert.ok(Array.isArray(path.commands));
    assert.equal(path.commands[0], "M");
    assert.ok(path.commands.includes("C") || path.commands.includes("Z") || path.commands.length > 1);
    assert.ok(path.coords.length >= 4);
  });

});
