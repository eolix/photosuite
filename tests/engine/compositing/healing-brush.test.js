/**
 * Golden values for healing-brush (compositing).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { applyCutToLabelArray, buildKdTree, buildPatchMatchPlan, copyInt16Slice, findNearestFeatureInKdTree, fwht64InPlace, fwhtInPlace64, getError, isPixelInBounds, kdTreePartitionPivot, moveCostIfUnlabeled, partitionFeaturesByAxis, rgbaPatchMoveCost, samplePatchFwhtBlock, swapFeatureRecords, unlabeledOverlapRatio } from "../../../src/engine/compositing/healing-brush.js";


function createCompositing() {
  const Compositing = function Compositing() {};
  return Compositing;
}

before(async () => {
});

describe("healing-brush helpers", () => {
  it("isPixelInBounds goldens", () => {
    assert.equal(isPixelInBounds(0, 0, 10, 10), true);
    assert.equal(isPixelInBounds(10, 0, 10, 10), false);
  });

  it("getError sums squared coefficient deltas", () => {
    const features = new Int16Array(48);
    features[4] = 100;
    features[28] = 90;
    features[32] = 50;
    features[56] = 45;
    assert.equal(getError(24, 0, features, 1e9), 2600);
  });

  it("copyInt16Slice copies into destination buffer", () => {
    const dst = new Int16Array(8);
    copyInt16Slice(new Int16Array([1, 2, 3, 4]), dst, 2, 4);
    assert.deepEqual([...dst], [0, 0, 1, 2, 3, 4, 0, 0]);
  });

  it("rgbaPatchMoveCost and moveCostIfUnlabeled goldens", () => {
    const rgba = new Uint8Array(16);
    rgba[0] = 100;
    rgba[1] = 100;
    rgba[2] = 100;
    rgba[4] = 110;
    rgba[5] = 100;
    rgba[6] = 100;
    const labelGrid = new Int32Array(4).fill(-1);
    assert.equal(rgbaPatchMoveCost(0, 0, 1, 0, 2, 2, rgba, labelGrid), 101);
    assert.equal(moveCostIfUnlabeled(0, 0, 4, 4, { x: 1, y: 0 }, labelGrid), 0);
  });

  it("fwht64InPlace checksum golden", () => {
    const block = new Int16Array(64);
    for (let coeffIdx = 0; coeffIdx < 64; coeffIdx++) {
      block[coeffIdx] = coeffIdx;
    }
    const scratch = new Int16Array(64);
    fwht64InPlace(block, scratch);
    assert.equal(block.reduce((sum, value) => sum + value, 0), 2544);
  });

  it("kd-tree build and nearest-neighbor lookup", () => {
    const features = new Int16Array(72);
    for (let featIdx = 0; featIdx < 3; featIdx++) {
      features[featIdx * 24] = featIdx;
      features[featIdx * 24 + 4] = featIdx * 5;
    }
    swapFeatureRecords(0, 24, features);
    // Records at byte offsets 0 and 24 swap: coeff at +4 moves 0↔5.
    assert.equal(features[4], 5);
    assert.equal(features[28], 0);
    const nodes = [];
    buildKdTree(0, 2, nodes, features, new Int16Array(48));
    assert.deepEqual(nodes.slice(0, 3), [99, 0, 2]);
    assert.equal(findNearestFeatureInKdTree(0, features, nodes, 1), 1);
  });

  it("patch overlap and cut application goldens", () => {
    const labelGrid = new Int32Array(16).fill(-1);
    const holePixels = [1, 1, 2, 1];
    assert.equal(unlabeledOverlapRatio({ x: 0, y: 0 }, labelGrid, holePixels, 4, 4), 1);
    const labels = [0, 1, 0];
    applyCutToLabelArray(labels, 4, [2, 0, 1, 2], [0], 2, 2);
    assert.deepEqual(labels, [2, 1, 0]);
  });

  it("buildPatchMatchPlan returns patch offsets and per-hole label indices", () => {
    const width = 10;
    const height = 10;
    const labelGrid = new Int32Array(width * height).fill(-1);
    const holes = [
      [5, 5],
      [5, 6],
      [6, 5],
    ];
    holes.forEach(([col, row], holeIdx) => {
      labelGrid[row * width + col] = holeIdx;
    });
    const holePixels = [];
    holes.forEach(([col, row]) => holePixels.push(col, row));
    const voteList = [
      { x: -3, y: 0, voteCount: 10, unlabeledOverlap: -1 },
      { x: 3, y: -2, voteCount: 6, unlabeledOverlap: -1 },
      { x: 0, y: 3, voteCount: 4, unlabeledOverlap: -1 },
    ];
    const originalRandom = Math.random;
    let seed = 123;
    Math.random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    try {
      const plan = buildPatchMatchPlan(width, height, voteList, labelGrid, holePixels, 3);
      assert.deepEqual(
        plan.patchOffsets.map((offset) => [offset.x, offset.y]),
        [
          [-3, 0],
          [3, -2],
        ],
      );
      assert.deepEqual(plan.labelIndices, [0, 1, 0]);
    } finally {
      Math.random = originalRandom;
    }
  });

  it("fwhtInPlace64 transforms a 64-sample block", () => {
    const bufA = new Int16Array(64);
    const bufB = new Int16Array(64);
    for (let i = 0; i < 64; i++) bufA[i] = i;
    fwhtInPlace64(64, bufA, bufB);
    assert.deepEqual(Array.from(bufA.slice(0, 4)), [2016, -32, -64, 0]);
    assert.equal(bufA.reduce((sum, value) => sum + value, 0), 0);
  });

  it("partitionFeaturesByAxis splits around the window midpoint value", () => {
    // Four records, axis 4 values 9, 1, 7, 3. Midpoint of [0,3] is record 1 (value 1),
    // so everything below the pivot is empty and the split lands at index 0.
    const features = new Int16Array(4 * 24);
    [9, 1, 7, 3].forEach((value, recordIdx) => {
      features[recordIdx * 24 + 4] = value;
    });
    const splitAt = partitionFeaturesByAxis(4, 0, 3, features);
    assert.ok(splitAt > 0 && splitAt <= 3);
    for (let recordIdx = 0; recordIdx < splitAt; recordIdx++) {
      assert.ok(features[recordIdx * 24 + 4] <= features[splitAt * 24 + 4]);
    }
  });

  it("partitionFeaturesByAxis terminates when every record shares a value", () => {
    const features = new Int16Array(8 * 24);
    for (let recordIdx = 0; recordIdx < 8; recordIdx++) features[recordIdx * 24 + 4] = 5;
    assert.equal(partitionFeaturesByAxis(4, 0, 7, features), 4);
  });

  it("kdTreePartitionPivot converges on the target record's axis value", () => {
    const values = [12, 3, 9, 1, 7, 15, 4, 8];
    const features = new Int16Array(values.length * 24);
    values.forEach((value, recordIdx) => {
      features[recordIdx * 24 + 4] = value;
    });
    const pivot = kdTreePartitionPivot(4, 0, values.length - 1, features, 4);
    // Quickselect around index 4 places the 5th smallest value there.
    assert.equal(pivot, [...values].sort((a, b) => a - b)[4]);
  });

  it("samplePatchFwhtBlock accepts a valid 8×8 patch", () => {
    const width = 12;
    const height = 12;
    const ycbcr = new Uint8Array(width * height * 4);
    const mask = new Uint8Array(width * height);
    for (let rgbaOff = 0; rgbaOff < ycbcr.length; rgbaOff += 4) {
      ycbcr[rgbaOff + 3] = 255;
    }
    const yBlock = new Int16Array(64);
    const cbBlock = new Int16Array(64);
    const crBlock = new Int16Array(64);
    assert.equal(samplePatchFwhtBlock(ycbcr, mask, 5, 5, width, height, yBlock, cbBlock, crBlock), 0);
  });
});
