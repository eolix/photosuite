import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { floodFillRegion, getPathRecords, pointInPolygon, traceContours } from "../../../src/engine/compositing/bitmap-contour-tracer.js";


function createCompositing() {
  const Compositing = function Compositing() {};
  return Compositing;
}

before(async () => {
});

describe("engine/compositing/bitmap-contour-tracer.js geometry", () => {
  it("pointInPolygon classifies square interior and exterior", () => {
    const square = [0, 0, 10, 0, 10, 10, 0, 10];
    assert.equal(pointInPolygon(square, 5, 5), true);
    assert.equal(pointInPolygon(square, 15, 15), false);
  });

  it("floodFillRegion clears a connected foreground run", () => {
    const mask = new Uint8Array([1, 1, 0, 0]);
    floodFillRegion(0, mask, 2, 0);
    assert.deepEqual(Array.from(mask), [0, 0, 0, 0]);
  });
});

describe("engine/compositing/bitmap-contour-tracer.js registration", () => {
  it("traceContours marches a filled square into one closed contour", () => {
    const w = 8;
    const h = 8;
    const mask = new Uint8Array(w * h);
    for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) mask[y * w + x] = 255;
    const contours = traceContours(mask, w, h, 1);
    assert.equal(contours.length, 1);
    assert.equal(contours[0].pointCount, 20);
    assert.equal(contours[0].color, 255);
    assert.equal(contours[0].sign, "+");
    assert.equal(contours[0].parent, -1);
    assert.equal(contours[0].cornerCount, 4);
  });

  it("getPathRecords emits a closed bezier path per contour", () => {
    const w = 8;
    const h = 8;
    const mask = new Uint8Array(w * h);
    for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) mask[y * w + x] = 255;
    const records = getPathRecords(traceContours(mask, w, h, 1));
    assert.equal(records.length, 1);
    assert.equal(records[0].color, 255);
    assert.equal(records[0].parent, -1);
    assert.deepEqual(records[0].path.commands, ["M", "C", "C", "C", "C", "Z"]);
    assert.deepEqual(
      records[0].path.coords,
      [1, 3.5, 1, 5.5, 1.5, 6, 3.5, 6, 5.5, 6, 6, 5.5, 6, 3.5, 6, 1.5, 5.5, 1, 3.5, 1, 1.5, 1, 1, 1.5, 1, 3.5],
    );
  });
});
