/**
 * Golden values for distance-field-stroke (compositing).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Rect } from "../../../src/core/math/rect.js";
import { applyStrokeMask, computeColumnDistanceTransform, computeDistanceField, computeDistanceFieldFast, computeEuclideanDistance, computeNearestOffsets, computeSurfaceNormals, edtEdgeSubpixelCorrection, positionHash, stroke } from "../../../src/engine/compositing/distance-field-stroke.js";

function makeCompositing() {
  const Compositing = function Compositing() {};
  return Compositing.distanceFieldStroke;
}

function centerFilledMask(width, height) {
  const mask = new Uint8Array(width * height);
  for (let row = 1; row <= 2; row++) {
    for (let col = 1; col <= 2; col++) {
      mask[row * width + col] = 255;
    }
  }
  return mask;
}

describe("distance-field-stroke", () => {
  it("positionHash matches goldens", () => {
    const dfs = makeCompositing();
    assert.deepEqual([0, 1, 42, 1000].map((i) => positionHash(i)), [106, 157, 25, 82]);
  });

  it("edtEdgeSubpixelCorrection matches golden", () => {
    const dfs = makeCompositing();
    assert.equal(edtEdgeSubpixelCorrection(0.8, 0.2, 0.5), 0);
    assert.equal(Math.round(edtEdgeSubpixelCorrection(0.8, 0.2, 0.3) * 1e6) / 1e6, 0.16);
  });

  it("computeNearestOffsets / distance / stroke mask goldens on 4x4 binary", () => {
    const dfs = makeCompositing();
    const w = 4;
    const h = 4;
    const mask = centerFilledMask(w, h);

    const offsets = computeNearestOffsets(mask, w, h, true);
    assert.deepEqual(Array.from(offsets.slice(0, 8)), [1, 1, 0, 1, 0, 1, -1, 1]);

    const dist = new Float64Array(w * h);
    computeDistanceField(mask, dist, w, h);
    assert.deepEqual(
      Array.from(dist).map((v) => Math.round(v * 1000) / 1000),
      [1.061, 0.5, 0.5, 1.061, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0.5, 1.061, 0.5, 0.5, 1.061],
    );

    const dest = new Uint8Array(w * h);
    const rect = new Rect(0, 0, w, h);
    applyStrokeMask(dest, rect, dist, rect, 1);
    assert.deepEqual(Array.from(dest), [112, 255, 255, 112, 255, 255, 255, 255, 255, 255, 255, 255, 112, 255, 255, 112]);
  });

  it("computeDistanceFieldFast / column + Euclidean goldens", () => {
    const dfs = makeCompositing();
    const w = 4;
    const h = 4;
    const mask = centerFilledMask(w, h);

    const fast = new Float64Array(w * h);
    computeDistanceFieldFast(mask, fast, w, h, 0);
    assert.deepEqual(
      Array.from(fast).map((v) => Math.round(v * 1000) / 1000),
      [1.414, 1, 1, 1.414, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1.414],
    );

    const colDist = new Int32Array(w * h);
    computeColumnDistanceTransform(mask, colDist, w, h, 0);
    assert.deepEqual(Array.from(colDist.slice(0, 8)), [-9, 1, 1, -9, -10, 0, 0, -10]);

    const euc = new Int16Array(w * h * 2);
    computeEuclideanDistance(mask, euc, w, h, 0);
    assert.deepEqual(Array.from(euc.slice(0, 8)), [1, 1, 0, 1, 0, 1, -1, 1]);
  });

  it("computeSurfaceNormals on 3x3 peak", () => {
    const dfs = makeCompositing();
    const heights = new Float64Array([0, 0, 0, 0, 1, 0, 0, 0, 0]);
    const normals = new Float64Array(18);
    computeSurfaceNormals(heights, 3, 3, normals);
    assert.deepEqual([normals[8], normals[9]].map((v) => Math.round(v * 1000) / 1000), [0, 0]);
  });

  it("stroke matches full golden mask", () => {
    const dfs = makeCompositing();
    const w = 4;
    const h = 4;
    const mask = centerFilledMask(w, h);
    const dest = new Uint8Array(w * h);
    stroke(mask, dest, new Rect(0, 0, w, h), 1);
    assert.deepEqual(
      Array.from(dest),
      [112, 255, 255, 112, 255, 255, 255, 255, 255, 255, 255, 255, 112, 255, 255, 112],
    );
  });
});
