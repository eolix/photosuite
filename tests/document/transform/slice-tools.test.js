import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { Point } from "../../../src/core/math/point.js";
import { Rect } from "../../../src/core/math/rect.js";

let restoreBrowserGlobals;
let SliceTool;

function chainToolPrototypes() {
}

function makeSliceList(left, top, right, bottom) {
  return [
    {
      v: {
        bounds: {
          v: {
            Left: { v: left },
            Top: { v: top },
            Rght: { v: right },
            Btom: { v: bottom },
          },
        },
      },
    },
    {
      v: {
        bounds: {
          v: {
            Left: { v: 20 },
            Top: { v: 0 },
            Rght: { v: 40 },
            Btom: { v: 50 },
          },
        },
      },
    },
  ];
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
  chainToolPrototypes();
  ({ SliceTool } = await import("../../../src/document/transform/slice-tools.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("SliceTool bounds helpers", () => {
  it("normalizeAxisAlignedBounds swaps inverted edges and enforces minimum size", () => {
    const boundsA = [10, 20, 5, 40];
    SliceTool.normalizeAxisAlignedBounds(boundsA);
    assert.deepEqual(boundsA, [5, 20, 10, 40]);

    const boundsB = [0, 0, 0, 10];
    SliceTool.normalizeAxisAlignedBounds(boundsB);
    assert.deepEqual(boundsB, [0, 0, 1, 10]);
  });

  it("readSliceBoundsArray returns left-top-right-bottom-index tuple", () => {
    const slices = makeSliceList(0, 0, 10, 10);
    assert.deepEqual(SliceTool.readSliceBoundsArray(slices, 0), [0, 0, 10, 10, 0]);
  });

  it("findSliceIndexAtPoint hits inside and misses outside", () => {
    const slices = makeSliceList(0, 0, 10, 10);
    assert.equal(SliceTool.findSliceIndexAtPoint(slices, new Point(5, 5)), 0);
    assert.equal(SliceTool.findSliceIndexAtPoint(slices, new Point(50, 50)), -1);
  });

  it("getUnionBoundsOfSliceIndices spans selected slices", () => {
    const slices = makeSliceList(0, 0, 10, 10);
    assert.deepEqual(SliceTool.getUnionBoundsOfSliceIndices(slices, [0, 1]), [0, 0, 40, 50]);
  });

  it("clampBoundsToCanvas clips to canvas extents", () => {
    const bounds = [-5, -5, 100, 100];
    SliceTool.clampBoundsToCanvas(bounds, [0, 0, 50, 50]);
    assert.deepEqual(bounds, [0, 0, 50, 50]);
  });
});
