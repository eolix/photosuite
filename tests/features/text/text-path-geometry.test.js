/**
 * Golden values for text-on-path geometry helpers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeTextPathData,
  findPathIndex,
  getPathPosition,
} from "../../../src/features/text/text-path-geometry.js";

describe("features/text/text-path-geometry.js", () => {
  it("computeTextPathData samples a 100-unit cubic and reports arc length", () => {
    const data = computeTextPathData({
      Points: [0, 0, 0, 0, 100, 0, 100, 0],
      TextOnPathTRange: [0, 1],
      Reversed: false,
    });
    assert.equal(data[0].length, 800);
    assert.equal(data[1].length, 400);
    assert.equal(data[2].length, 400);
    assert.equal(data[3], 99.998128125);
    assert.equal(data[4], 0);
    assert.equal(data[5], 99.998128125);
    assert.deepEqual(data[0].slice(0, 8), [
      0,
      0,
      0.0018718750000000003,
      0,
      0.007475,
      0,
      0.016790624999999997,
      0,
    ]);
  });

  it("findPathIndex returns the first index at or past t", () => {
    assert.equal(findPathIndex(0.5, [0, 0.2, 0.5, 0.9, 1]), 2);
  });

  it("getPathPosition returns point and unit tangent", () => {
    assert.deepEqual(getPathPosition([0, 0, 10, 0, 20, 0], 5), [10, 0, 1, 0]);
  });
});
