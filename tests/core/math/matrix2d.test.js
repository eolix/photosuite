import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Matrix2D } from "../../../src/core/math/matrix2d.js";
import { Point } from "../../../src/core/math/point.js";

function expectPoint(actual, x, y) {
  assert.equal(actual.x, x);
  assert.equal(actual.y, y);
}

describe("core/math/matrix2d.js", () => {
  it("translate then transformPoint", () => {
    const m = new Matrix2D();
    m.translate(5, 10);
    expectPoint(m.transformPoint(new Point(1, 2)), 6, 12);
  });

  it("concat composes transforms", () => {
    const a = new Matrix2D(2, 0, 0, 2, 0, 0);
    const b = new Matrix2D(1, 0, 0, 1, 3, 4);
    a.concat(b);
    expectPoint(a.transformPoint(new Point(1, 1)), 5, 6);
  });

  it("invert undoes scale+translate", () => {
    const m = new Matrix2D(2, 0, 0, 2, 4, 6);
    const inv = m.clone();
    inv.invert();
    const roundTrip = m.transformPoint(inv.transformPoint(new Point(10, 20)));
    assert.ok(Math.abs(roundTrip.x - 10) < 1e-9);
    assert.ok(Math.abs(roundTrip.y - 20) < 1e-9);
  });
});
