import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Rect } from "../../../src/core/math/rect.js";

describe("core/math/rect.js", () => {
  it("intersect returns overlap", () => {
    const a = new Rect(0, 0, 10, 10);
    const b = new Rect(5, 5, 10, 10);
    const hit = a.intersect(b);
    assert.equal(hit.x, 5);
    assert.equal(hit.y, 5);
    assert.equal(hit.width, 5);
    assert.equal(hit.height, 5);
  });

  it("union expands bounds", () => {
    const a = new Rect(0, 0, 2, 2);
    const b = new Rect(3, 4, 1, 1);
    const u = a.union(b);
    assert.equal(u.x, 0);
    assert.equal(u.y, 0);
    assert.equal(u.width, 4);
    assert.equal(u.height, 5);
  });

  it("contains and isEmpty", () => {
    const r = new Rect(1, 1, 4, 4);
    assert.equal(r.contains(2, 2), true);
    assert.equal(r.contains(10, 10), false);
    assert.equal(new Rect(0, 0, 0, 5).isEmpty(), true);
  });
});
