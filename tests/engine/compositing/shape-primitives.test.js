/**
 * Golden values for shape-primitives (compositing).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { Point } from "../../../src/core/math/point.js";
import { arrowPathRecords, ellipsePathRecords, linePathRecords, pieSlicePathRecords, polygonFromFlatCoords, rectanglePathRecords, regularPolygonPathRecords, starBurstPathRecords, starPathRecords } from "../../../src/engine/compositing/shape-primitives.js";


function polylineCoordsToKnots(flat) {
  const knots = [];
  for (let i = 0; i < flat.length; i += 2) {
    knots.push({
      type: 1,
      cp1: new Point(flat[i], flat[i + 1]),
      anchor: new Point(flat[i], flat[i + 1]),
      anchorOut: new Point(flat[i], flat[i + 1]),
    });
  }
  return knots;
}

function transformPathRecordCoords(pathRecords, matrix) {
  for (const rec of pathRecords) {
    if (!rec.anchor) continue;
    for (const key of ["cp1", "anchor", "anchorOut"]) {
      if (!rec[key]) continue;
      const p = matrix.transformPoint(rec[key]);
      rec[key].x = p.x;
      rec[key].y = p.y;
    }
  }
}

function transformCoordPairs(src, matrix, dst) {
  for (let i = 0; i < src.length; i += 2) {
    const p = matrix.transformPoint(new Point(src[i], src[i + 1]));
    dst[i] = p.x;
    dst[i + 1] = p.y;
  }
}

function anchors(pathRecords) {
  return pathRecords
    .filter((r) => r.anchor)
    .map((r) => [r.anchor.x, r.anchor.y]);
}

function roundAnchors(pathRecords, digits = 6) {
  return anchors(pathRecords).map(([x, y]) => {
    const rx = +x.toFixed(digits);
    const ry = +y.toFixed(digits);
    return [Object.is(rx, -0) ? 0 : rx, Object.is(ry, -0) ? 0 : ry];
  });
}

describe("engine/compositing/shape-primitives.js", () => {
  it("rectanglePathRecords anchors for 0,0,10,20", () => {
    const records = rectanglePathRecords(0, 0, 10, 20);
    assert.equal(records[2].type, 0);
    assert.equal(records[2].length, 4);
    assert.deepEqual(roundAnchors(records), [
      [0, 0],
      [10, 0],
      [10, 20],
      [0, 20],
    ]);
  });

  it("ellipsePathRecords anchors for 0,0,100,50 (signed radius)", () => {
    const records = ellipsePathRecords(0, 0, 100, 50);
    assert.equal(records[2].type, 0);
    assert.equal(records[2].length, 4);
    assert.deepEqual(roundAnchors(records), [
      [50, 50],
      [0, 25],
      [50, 0],
      [100, 25],
    ]);
  });

  it("regularPolygonPathRecords 4-gon at 50,50 r=40", () => {
    const records = regularPolygonPathRecords(50, 50, 40, 0, 4);
    assert.deepEqual(roundAnchors(records), [
      [90, 50],
      [50, 90],
      [10, 50],
      [50, 10],
    ]);
  });

  it("starPathRecords 5-point", () => {
    const records = starPathRecords(50, 50, 40, 0, 5, 0, 0.5);
    assert.equal(records[2].length, 10);
    assert.deepEqual(roundAnchors(records), [
      [90, 50],
      [66.18034, 61.755705],
      [62.36068, 88.042261],
      [43.81966, 69.02113],
      [17.63932, 73.51141],
      [30, 50],
      [17.63932, 26.48859],
      [43.81966, 30.97887],
      [62.36068, 11.957739],
      [66.18034, 38.244295],
    ]);
  });

  it("linePathRecords horizontal stroke", () => {
    const records = linePathRecords(0, 0, 100, 0, 10);
    assert.deepEqual(roundAnchors(records), [
      [0, 5],
      [0, -5],
      [100, -5],
      [100, 5],
    ]);
  });

  it("arrowPathRecords horizontal", () => {
    const records = arrowPathRecords(0, 0, 100, 0, 10, 1.5);
    assert.equal(records[2].length, 7);
    assert.deepEqual(roundAnchors(records), [
      [0, 5],
      [0, -5],
      [87, -5],
      [87, -7.5],
      [100, 0],
      [87, 7.5],
      [87, 5],
    ]);
  });

  it("pieSlicePathRecords 0→π/2", () => {
    const records = pieSlicePathRecords(50, 50, 40, 0, Math.PI / 2);
    assert.equal(records[2].type, 3);
    assert.equal(records[2].length, 5);
    assert.deepEqual(roundAnchors(records), [
      [90, 50],
      [86.955181, 65.307337],
      [78.284271, 78.284271],
      [65.307337, 86.955181],
      [50, 90],
    ]);
  });

  it("starBurstPathRecords 3 points", () => {
    const records = starBurstPathRecords(50, 50, 40, 0, 3);
    assert.equal(records[2].length, 9);
    assert.deepEqual(roundAnchors(records, 4), [
      [50, 50],
      [58, 42],
      [66, 50],
      [42, 74],
      [18, 50],
      [58, 10],
      [58, 26],
      [34, 50],
      [42, 58],
    ]);
  });

  it("polygonFromFlatCoords open (closedLoop true → type 3)", () => {
    const records = polygonFromFlatCoords([0, 0, 10, 0, 10, 10], 0, true);
    assert.equal(records[2].type, 3);
    assert.equal(records[2].length, 3);
    assert.deepEqual(roundAnchors(records), [
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });
});
