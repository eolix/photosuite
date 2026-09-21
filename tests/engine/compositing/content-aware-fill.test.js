import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { Rect } from "../../../src/core/math/rect.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { PlanarRgbaBuffer, allocBuffer, downsampleHalfAlphaWeighted, extractChannel, extractChannelByte, fillBuffer, interleavedToPlanar } from "../../../src/engine/compositing/buffer-utils.js";
import { blendAlpha, blendColorError, extractContourPixels, fill, patchCost, solvePoissonFill } from "../../../src/engine/compositing/content-aware-fill.js";


function createCompositing() {
  const Compositing = function Compositing() {};
  Compositing.blendOps = { initRng: () => 0.5 };
  Compositing.distanceFieldStroke = {
    computeNearestOffsets: () => new Int16Array(0),
  };
  Compositing.rankFilter = { filterChannel: () => {}, selectMinimum: 0 };
  return Compositing;
}

before(async () => {
});

describe("engine/compositing/content-aware-fill.js blend helpers", () => {
  it("alpha projects unknown RGB onto the fg/bg chord", () => {
    const unknown = (128 << 16) | (64 << 8) | 32;
    const fg = (200 << 16) | (100 << 8) | 50;
    const bg = (50 << 16) | (30 << 8) | 10;
    assert.equal(Math.round(blendAlpha(unknown, fg, bg) * 1e6) / 1e6, 0.515862);
  });

  it("blendColorError and patchCost match captured values", () => {
    const unknown = (128 << 16) | (64 << 8) | 32;
    const fg = (200 << 16) | (100 << 8) | 50;
    const bg = (50 << 16) | (30 << 8) | 10;
    assert.equal(Math.round(blendColorError(unknown, fg, bg) * 1000) / 1000, 2.589);
    assert.equal(
      Math.round(
        patchCost((5 << 16) | 7, unknown, (3 << 16) | 4, fg, (8 << 16) | 9, bg, 0.5, 0.5, 1e9) * 1000,
      ) / 1000,
      6.195,
    );
  });

  it("extractContourPixels finds fg/bg edges against unknown trimap", () => {
    const width = 5;
    const height = 5;
    const mask = new Uint8Array(width * height);
    mask.fill(128);
    for (let row = 0; row < height; row++) {
      mask[row * width] = 0;
      mask[row * width + 1] = 0;
      mask[row * width + 3] = 255;
      mask[row * width + 4] = 255;
    }
    assert.deepEqual(extractContourPixels(mask, width, height, 255, 128), [8, 13, 18]);
    assert.deepEqual(extractContourPixels(mask, width, height, 0, 128), [6, 11, 16]);
  });
});

describe("engine/compositing/content-aware-fill.js module surface", () => {
  it("exposes the fill pipeline and the Poisson solver", () => {
    assert.equal(typeof fill, "function");
    assert.equal(typeof solvePoissonFill, "function");
    const unknown = (100 << 16) | (100 << 8) | 100;
    const fg = (200 << 16) | (200 << 8) | 200;
    const bg = (0 << 16) | (0 << 8) | 0;
    const alpha = blendAlpha(unknown, fg, bg);
    assert.ok(alpha > 0 && alpha < 1);
  });
});

describe("engine/compositing/content-aware-fill.js pipelines (real engine, goldens)", () => {
  let Compositing;
  before(async () => {
    installBrowserGlobals();
    await import("../../../src/engine/layer-system.js");
  });
  const sum = (a) => Array.from(a).reduce((x, y) => x + y, 0);

  it("fill matte-refines an unknown trimap band", () => {
    const w = 12;
    const h = 10;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = x * 20; rgba[i + 1] = y * 25; rgba[i + 2] = 128; rgba[i + 3] = 255;
    }
    const trimap = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) trimap[y * w + x] = x < 3 ? 255 : x > 8 ? 0 : 128;
    const out = fill(new Rect(0, 0, w, h), rgba, trimap, 3, true);
    assert.equal(out.length, 480);
    assert.equal(sum(out), 45210);
    assert.deepEqual([out[0], out[240], out[241], out[242]], [0, 0, 125, 128]);
  });

  it("solvePoissonFill seamlessly clones into a masked region", () => {
    const w = 12;
    const h = 10;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = x * 20; rgba[i + 1] = y * 25; rgba[i + 2] = 128; rgba[i + 3] = 255;
    }
    const mask = new Uint8Array(w * h);
    for (let y = 3; y < 7; y++) for (let x = 4; x < 8; x++) mask[y * w + x] = 255;
    solvePoissonFill(rgba, mask, new Rect(0, 0, w, h), 1, 20);
    assert.equal(sum(rgba), 72665);
    assert.deepEqual([rgba[(4 * w + 5) * 4], rgba[(4 * w + 5) * 4 + 1], rgba[(4 * w + 5) * 4 + 2]], [97, 96, 128]);
  });
});
