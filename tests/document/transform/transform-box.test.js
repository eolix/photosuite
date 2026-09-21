import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { Point } from "../../../src/core/math/point.js";
import { Matrix2D } from "../../../src/core/math/matrix2d.js";
import { Rect } from "../../../src/core/math/rect.js";

let restoreBrowserGlobals;
let TransformBox;

function chainToolPrototypes() {
  }

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  chainToolPrototypes();
  ({ TransformBox } = await import("../../../src/document/transform/transform-box.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("TransformBox.projectOntoSegment", () => {
  const cases = [
    { in: [0, 0, 10, 0, 5, 5], out: [5, 0, 5] },
    { in: [0, 0, 100, 0, 50, 10], out: [50, 0, 10] },
    { in: [0, 0, 0, 100, 10, 50], out: [0, 50, 10] },
    { in: [10, 10, 20, 20, 15, 15], out: [15, 15, 0] },
  ];

  for (const fixture of cases) {
    it(`projects ${JSON.stringify(fixture.in)}`, () => {
      const result = TransformBox.projectOntoSegment(...fixture.in);
      assert.deepEqual(result, fixture.out);
    });
  }
});

describe("TransformBox.isConvexTransformQuad", () => {
  const cases = [
    { in: [0, 0, 100, 0, 100, 100, 0, 100], out: true },
    { in: [0, 0, 50, 50, 100, 0, 50, 25], out: false },
    { in: [0, 0, 10, 0, 10, 10, 0, 10], out: true },
    { in: [0, 0, 100, 0, 50, 50, 100, 100], out: false },
  ];

  for (const fixture of cases) {
    it(`convexity ${JSON.stringify(fixture.in)}`, () => {
      assert.equal(TransformBox.isConvexTransformQuad(fixture.in), fixture.out);
    });
  }
});

describe("TransformBox.getHandlePoints", () => {
  it("builds the 3×3 handle lattice for an axis-aligned quad", () => {
    const corners = [0, 0, 200, 0, 200, 100, 0, 100];
    const box = new TransformBox(corners, false, false, false, false, false, 0, false);
    const handlePoints = box.getHandlePoints(corners);
    assert.deepEqual(
      handlePoints.map((point) => [point.x, point.y]),
      [
        [0, 0],
        [100, 0],
        [200, 0],
        [0, 50],
        [100, 50],
        [200, 50],
        [0, 100],
        [100, 100],
        [200, 100],
      ],
    );
  });
});

describe("TransformBox.isAxisAlignedQuad", () => {
  it("detects axis-aligned corners", () => {
    const box = new TransformBox([0, 0, 10, 0, 10, 10, 0, 10], false, false, false, false, false, 0, false);
    assert.equal(box.isAxisAlignedQuad(), true);
  });

  it("rejects sheared corners", () => {
    const box = new TransformBox([0, 0, 10, 1, 10, 10, 0, 9], false, false, false, false, false, 0, false);
    assert.equal(box.isAxisAlignedQuad(), false);
  });
});
