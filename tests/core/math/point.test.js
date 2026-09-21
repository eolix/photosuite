import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Point, constrainEndpointToAxis } from "../../../src/core/math/point.js";

describe("core/math/point.js", () => {
  it("add and subtract", () => {
    const a = new Point(1, 2);
    const b = new Point(3, 4);
    const sum = a.add(b);
    assert.equal(sum.x, 4);
    assert.equal(sum.y, 6);
    const diff = b.subtract(a);
    assert.equal(diff.x, 2);
    assert.equal(diff.y, 2);
  });

  it("distance and lerp", () => {
    assert.equal(Point.distance(0, 0, 3, 4), 5);
    const mid = Point.lerp(new Point(0, 0), new Point(10, 20), 0.5);
    assert.equal(mid.x, 5);
    assert.equal(mid.y, 10);
  });

  it("mat4 identity transformPoint2D", () => {
    const mat = Point.mat4.create();
    const inVec = Point.vec4.create();
    const out = Point.vec4.create();
    inVec[0] = 2;
    inVec[1] = 3;
    Point.mat4.transformPoint2D(mat, inVec, out);
    assert.equal(out[0], 2);
    assert.equal(out[1], 3);
  });

  // A drag more than twice as long horizontally as vertically flattens onto the
  // horizontal axis, and keeps the length it was dragged.
  it("constrainEndpointToAxis locks shallow angles to horizontal", () => {
    const constrained = constrainEndpointToAxis(new Point(0, 0), new Point(10, 3));
    assert.ok(Math.abs(constrained.x - 10.44030650891055) < 1e-9);
    assert.equal(constrained.y, 0);
  });

  // A drag near 45 degrees keeps both axes.
  it("constrainEndpointToAxis keeps diagonals diagonal", () => {
    const constrained = constrainEndpointToAxis(new Point(0, 0), new Point(10, 8));
    assert.equal(constrained.x, constrained.y);
  });
});
