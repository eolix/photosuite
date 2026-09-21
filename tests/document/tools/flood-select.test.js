/**
 * Colour distance and sampling goldens for the wand's flood select.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { Point } from "../../../src/core/math/point.js";
import { Rect } from "../../../src/core/math/rect.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let colorDistance;
let minColorDistance;
let readSampleColors;

before(async () => {
  ({ colorDistance, minColorDistance, readSampleColors } = await import(
    "../../../src/document/tools/flood-select.js"
  ));
});

describe("document/tools/flood-select.js", () => {
  // Distance is the widest single-channel gap, so one badly mismatched channel
  // is enough to put a pixel outside the tolerance.
  it("colorDistance takes the largest channel difference", () => {
    const packed = (255 << 24) | (10 << 16) | (20 << 8) | 30;
    assert.equal(colorDistance(packed, [30, 20, 10, 255]), 0);
    assert.equal(colorDistance(packed, [0, 0, 0, 255]), 30);
    assert.equal(colorDistance(packed, [0, 0, 0, 0]), 255);
  });

  // Several sampled colours widen the selection: a pixel need only be near one.
  it("minColorDistance takes the nearest of the sampled colours", () => {
    const packed = (255 << 24) | (10 << 16) | (20 << 8) | 30;
    assert.equal(minColorDistance(packed, [[0, 0, 0, 0], [30, 20, 10, 255]]), 0);
  });

  // A sample point sits at a pixel centre, so 0.5 reads the pixel at 0.
  it("readSampleColors reads the pixel under each sample point", () => {
    const buffer = new Uint8ClampedArray(4 * 4);
    buffer[0] = 1;
    buffer[1] = 2;
    buffer[2] = 3;
    buffer[3] = 255;
    assert.deepEqual(
      readSampleColors(buffer, new Rect(0, 0, 2, 2), [new Point(0.5, 0.5)]),
      [[1, 2, 3, 255]],
    );
  });
});
