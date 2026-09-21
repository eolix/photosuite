/**
 * Golden values for selection-utils (compositing).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { Point } from "../../../src/core/math/point.js";
import { Rect } from "../../../src/core/math/rect.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { allocBuffer, fillBuffer } from "../../../src/engine/compositing/buffer-utils.js";
import { contentBoundsChannel, copyChannel } from "../../../src/engine/compositing/pixel-ops.js";
import { allSegmentKnotsAreStraight, countSubpaths, flattenPathKnotCoords, isOrthogonalQuadPath, knotCountInSubpath, recordIndexForSubpath, subpathIndexForRecord, usesCompoundFill, usesEvenOddFill } from "../../../src/engine/compositing/path-records.js";
import { PathData, boundsOfPathRecords, buildNeighborOffsets, combineEdgeCosts, computeEdgeWeights, copyOp, differenceOp, extendBoundsWithCubicBezier, filterPathExcludingSubpaths, filterPathKeepingSubpaths, intersect, isZeroCrossing, minimumCornerAngleRad, pointOnPathAtParam, selectPointsInRect, signedSubpathArea, union, xorOp } from "../../../src/engine/compositing/selection-utils.js";

installBrowserGlobals();


function knot(x, y) {
  const p = new Point(x, y);
  return { type: 2, cp1: p.clone(), anchor: p.clone(), anchorOut: p.clone() };
}

function closedRectPath(x, y, w, h) {
  return [
    { type: 6 },
    { type: 8, all: 0 },
    { type: 0, length: 4, fillRule: 0 },
    knot(x, y),
    knot(x + w, y),
    knot(x + w, y + h),
    knot(x, y + h),
  ];
}

function createCompositing() {
  globalThis.paper = {
    Point: class {
      constructor(x, y) {
        this.x = x;
        this.y = y;
      }
    },
    Path: class {
      remove() {}
      add() {}
      simplify() {}
    },
  };
  globalThis.Typr = { U: { pathToSVG: () => "M0 0" } };
  globalThis.LayerEffectDefs = {
    StrokeStyleDefs: {
      lineCapTypes: ["butt"],
      join: ["miter"],
      alignTypes: ["center", "inside"],
    },
  };
  const Compositing = function Compositing() {};
  Compositing.KeyOrigins = { invalidateKeyOriginAtIndex() {} };
  Compositing.homography = { transformPointsArray() {} };
  Compositing.ImageRenderer = { warpCoordsThroughMesh() {} };
  return Compositing;
}

before(async () => {
});

describe("engine/compositing/selection-utils.js", () => {
  it("subpath indexing, fill rules, area, and orthogonal quad detection", () => {
    const { selectionUtils } = createCompositing();
    const path = closedRectPath(0, 0, 10, 10);
    assert.equal(countSubpaths(path), 1);
    assert.equal(recordIndexForSubpath(path, 0), 2);
    assert.equal(subpathIndexForRecord(path, 3), 0);
    assert.equal(knotCountInSubpath(path, 0), 5);
    assert.equal(usesEvenOddFill(path), true);
    assert.equal(usesCompoundFill(path), true);
    assert.equal(usesEvenOddFill([{ type: 6 }, { type: 8, all: 0 }]), true);
    assert.equal(signedSubpathArea(path), 100);
    assert.equal(allSegmentKnotsAreStraight(path), true);
    assert.equal(isOrthogonalQuadPath(path), true);
    assert.equal(minimumCornerAngleRad(path), 1.5707963267948966);
  });

  it("bounds, flatten coords, and point-on-path sampling", () => {
    const { selectionUtils } = createCompositing();
    const path = closedRectPath(0, 0, 10, 10);
    const bounds = boundsOfPathRecords(path);
    assert.equal(bounds.x, 0);
    assert.equal(bounds.y, 0);
    assert.equal(bounds.width, 10);
    assert.equal(bounds.height, 10);
    assert.deepEqual(flattenPathKnotCoords(path), [
      0, 0, 0, 0, 0, 0, 10, 0, 10, 0, 10, 0, 10, 10, 10, 10, 10, 10, 0, 10, 0, 10, 0, 10,
    ]);
    const mid = pointOnPathAtParam(path, 0.5);
    assert.equal(mid.x, 5);
    assert.equal(mid.y, 0);
  });

  it("selectPointsInRect and subpath filters", () => {
    const { selectionUtils } = createCompositing();
    const path = closedRectPath(0, 0, 10, 10);
    assert.deepEqual(selectPointsInRect(path, new Rect(-1, -1, 20, 20)), [
      [3, 4, 5, 6],
      [3, 4, 5, 6],
      [3, 4, 5, 6],
    ]);
    assert.equal(filterPathExcludingSubpaths(path, [0]).length, 2);
    assert.equal(filterPathKeepingSubpaths(path, [0]).length, 7);
  });

  it("cubic bounds extend and channel combine ops", () => {
    const { selectionUtils, channelOps } = createCompositing();
    const bez = new Float64Array(4);
    extendBoundsWithCubicBezier(0, 0, 0, 0, 10, 0, 10, 0, bez);
    assert.deepEqual(Array.from(bez), [0, 0, 10, 0]);
    const a = new Uint8Array([100, 50, 0, 255]);
    const b = new Uint8Array([50, 100, 200, 0]);
    const d = new Uint8Array(4);
    copyOp(a, b, d);
    assert.deepEqual(Array.from(d), [100, 50, 0, 255]);
    union(a, b, d);
    assert.deepEqual(Array.from(d), [150, 150, 200, 255]);
    differenceOp(a, b, d);
    assert.deepEqual(Array.from(d), [0, 50, 200, 0]);
    intersect(a, b, d);
    assert.deepEqual(Array.from(d), [19, 19, 0, 0]);
    xorOp(a, b, d);
    assert.deepEqual(Array.from(d), [130, 130, 200, 255]);
  });

  it("intelligent scissors edge costs and PathData frontier", () => {
    const gray = new Uint8Array(25);
    for (let i = 0; i < 25; i++) gray[i] = i * 10;
    const costs = computeEdgeWeights(gray, 5, 5, new ArrayBuffer(5 * 5 * 16));
    assert.deepEqual(Array.from(costs.slice(0, 16)), [
      255, 255, 255, 255, 16, 255, 255, 255, 255, 255, 255, 255, 17, 13, 255, 255,
    ]);
    assert.equal(combineEdgeCosts(0.5, 0.5, 0.5), 11);
    assert.equal(isZeroCrossing(10, -20, 5, 5, 5, 5), 1);
    const offsets = buildNeighborOffsets(5, 5, new ArrayBuffer(5 * 5 * 16));
    assert.deepEqual(Array.from(offsets.slice(0, 8)), [0, 0, 0, 1, 6, 5, 0, 0]);
    const frontier = new PathData(10);
    frontier.push(3, 5);
    frontier.push(1, 2);
    assert.equal(frontier.pop(), 1);
    assert.equal(frontier.count, 1);
    assert.equal(frontier.contains(3), true);
  });
});
