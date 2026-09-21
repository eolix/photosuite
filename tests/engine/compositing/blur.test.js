import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { Rect } from "../../../src/core/math/rect.js";
import { allocBuffer } from "../../../src/engine/compositing/buffer-utils.js";
import { boxBlur, boxBlurByte, boxBlurHorizRgba, gaussianBlurByte, gaussianBlurFloat, gaussianBoxWidths, getDivisionTable } from "../../../src/engine/compositing/blur.js";

let Compositing;

function createCompositing() {
  const namespace = function Compositing() {};
  return namespace;
}

before(async () => {
});

describe("engine/compositing/blur.js gaussianBoxWidths", () => {
  it("returns van-Vliet box widths for common sigma values", () => {
    const blur = createCompositing().blur;
    assert.deepEqual(gaussianBoxWidths(1, 3), [1, 1, 3]);
    assert.deepEqual(gaussianBoxWidths(2, 3), [3, 3, 5]);
    assert.deepEqual(gaussianBoxWidths(5, 2), [11, 13]);
    assert.deepEqual(gaussianBoxWidths(0.5, 3), [1, 1, 1]);
    assert.deepEqual(gaussianBoxWidths(10, 5), [15, 15, 15, 15, 17]);
  });
});

describe("engine/compositing/blur.js getDivisionTable", () => {
  it("builds and caches lookup tables by radius", () => {
    const blur = createCompositing().blur;
    const table = getDivisionTable(3);
    assert.equal(table.length, 1792);
    assert.equal(table[0], 0);
    assert.equal(table[256], 37);
    assert.equal(table[512], 73);
    assert.equal(getDivisionTable(3), table);
  });
});

describe("engine/compositing/blur.js box and gaussian blur", () => {
  it("boxBlurByte blurs a 5×5 gradient with radius 1", () => {
    const width = 5;
    const height = 5;
    // Byte buffers come from allocBuffer, which rounds up to a whole number of
    // 32-bit words; the blur copies by word, so a bare Uint8Array of 25 would
    // leave its tail behind.
    const src = allocBuffer(width * height);
    for (let idx = 0; idx < width * height; idx++) {
      src[idx] = idx;
    }
    const dst = allocBuffer(width * height);
    boxBlurByte(src, dst, new Rect(0, 0, width, height), 1);
    assert.deepEqual(
      Array.from(dst).slice(0, width * height),
      [2, 3, 4, 5, 6, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 18, 19, 20, 21, 22],
    );
  });

  it("gaussianBlurByte blurs a checkerboard patch", () => {
    const src = allocBuffer(16);
    src.set([0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
    const dst = allocBuffer(16);
    gaussianBlurByte(src, dst, new Rect(0, 0, 4, 4), 1);
    assert.deepEqual(
      Array.from(dst).slice(0, 16),
      [85, 85, 85, 85, 85, 85, 85, 85, 170, 170, 170, 170, 170, 170, 170, 170],
    );
  });

  it("boxBlur averages float samples on a 3×3 grid", () => {
    const src = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const dst = new Float32Array(9);
    boxBlur(src, dst, new Rect(0, 0, 3, 3), 1);
    const rounded = Array.from(dst).map((value) => Math.round(value * 1000) / 1000);
    assert.deepEqual(rounded, [1.333, 2, 2.667, 3.333, 4, 4.667, 5.333, 6, 6.667]);
  });
});

describe("engine/compositing/blur.js registration", () => {
  it("exposes public blur helpers on Compositing.blur", () => {
    assert.equal(typeof gaussianBlurByte, "function");
    assert.equal(typeof gaussianBlurFloat, "function");
    assert.equal(typeof boxBlurHorizRgba, "function");
  });
});
