import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { Rect } from "../../../src/core/math/rect.js";

let actions;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  actions = await import("../../../src/document/tools/selection-actions.js");
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/tools/selection-actions.js", () => {
  it("buildModifySelectionAction maps every modify op to its wire amount key", () => {
    // Each op names the wire key its amount is written under. An op missing
    // from the map writes its amount under `undefined`, and the scripted
    // selection change is silently dropped.
    const cases = [
      ["expand", "By"],
      ["contract", "By"],
      ["border", "Wdth"],
      ["feather", "Rds"],
      ["smoothness", "Rds"],
    ];
    for (const [op, wireKey] of cases) {
      const action = actions.buildModifySelectionAction(op, 7, true);
      assert.equal(action.uf, op);
      assert.deepEqual(action.actionDescriptor[wireKey], { t: "UntF", v: { type: "#Pxl", val: 7 } }, op);
      assert.ok(!("undefined" in action.actionDescriptor), op);
    }
    assert.ok(!("selectionModifyEffectAtCanvasBounds" in actions.buildModifySelectionAction("border", 3, true).actionDescriptor));
  });

  it("buildRectSelectionAction and buildSelectAllAction keep descriptor shape", () => {
    const rectAction = actions.buildRectSelectionAction("Rctn", new Rect(2, 3, 10, 20));
    const shape = rectAction.actionDescriptor.T.v;
    assert.equal(shape.classID, "Rctn");
    assert.deepEqual([shape.Left.v.val, shape.Top.v.val, shape.Rght.v.val, shape.Btom.v.val], [2, 3, 12, 23]);
    assert.equal(actions.buildSelectAllAction(true).actionDescriptor.T.v.Ordn, "Al");
    assert.equal(actions.buildSelectAllAction().actionDescriptor.T.v.Ordn, "None");
  });

  it("buildPolygonSelectionAction splits flat coords into paired arrays", () => {
    const action = actions.buildPolygonSelectionAction([1, 2, 3, 4, 5, 6], "union");
    assert.equal(action.uf, "addTo");
    const arrs = action.actionDescriptor.T.v.Pts.v.arr;
    assert.deepEqual(arrs[0].arr, [1, 3, 5]);
    assert.deepEqual(arrs[1].arr, [2, 4, 6]);
  });

  it("resolveSelectionCombineMode matches modifier precedence", () => {
    assert.equal(actions.resolveSelectionCombineMode("front", false, false), "front");
    assert.equal(actions.resolveSelectionCombineMode("front", true, false), "union");
    assert.equal(actions.resolveSelectionCombineMode("front", false, true), "difference");
    assert.equal(actions.resolveSelectionCombineMode("front", true, true), "intersection");
  });

  it("growOrShrinkSelection pads the work rect and returns a mask", () => {
    const mask = {
      channel: new Uint8Array(16).fill(255),
      rect: new Rect(4, 4, 4, 4),
    };
    const grown = actions.growOrShrinkSelection(mask, 2, 2);
    assert.equal(grown.rect.x, 2);
    assert.equal(grown.rect.width, 8);
    assert.equal(grown.channel.length, grown.rect.area());
  });

  it("refineSelectionMask blurs into an inflated rect clipped to canvas", () => {
    const mask = {
      channel: new Uint8Array(16).fill(255),
      rect: new Rect(0, 0, 4, 4),
    };
    const refined = actions.refineSelectionMask(mask, 2, false, new Rect(0, 0, 10, 10), false);
    assert.ok(refined.rect.width >= 4);
    assert.ok(refined.rect.width <= 10);
    assert.equal(refined.channel.length, refined.rect.area());
  });
});
