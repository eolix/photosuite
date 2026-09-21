/**
 * Golden values for effect-filters (compositing).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { applyShadowHighlightCorrection, renderLensFlare } from "../../../src/engine/compositing/effect-filters.js";

installBrowserGlobals();


function checksum(buf, modulus = 11) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    sum = (sum + buf[i] * (i % modulus + 1)) % 1000003;
  }
  return sum;
}

function seedRandom(seed) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

describe("effect-filters", () => {
  it("applyShadowHighlightCorrection matches golden", () => {
    const w = 8;
    const h = 8;
    const src = new Uint8ClampedArray(w * h * 4);
    const dst = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const i = (row * w + col) * 4;
        const v = Math.round((col / (w - 1)) * 255);
        src[i] = v;
        src[i + 1] = v;
        src[i + 2] = v;
        src[i + 3] = 255;
      }
    }
    applyShadowHighlightCorrection(src, dst, w, h, 0.4, 0.5, 1, 0.3, 0.4, 1, 0.2, 0);
    assert.equal(checksum(dst, 7), 101454);
    assert.deepEqual([dst[0], dst[1], dst[2]], [0, 0, 0]);
    assert.deepEqual([dst[36 * 4], dst[36 * 4 + 1], dst[36 * 4 + 2]], [142, 142, 142]);
    assert.deepEqual([dst[dst.length - 4], dst[dst.length - 3], dst[dst.length - 2]], [255, 255, 255]);
  });

  it("renderLensFlare presets match seeded goldens", () => {
    const src = new Uint8ClampedArray(32 * 32 * 4);
    for (let i = 0; i < src.length; i += 4) {
      src[i] = 40;
      src[i + 1] = 50;
      src[i + 2] = 60;
      src[i + 3] = 255;
    }
    const origRandom = Math.random;
    const cases = [
      { preset: [0, 0.8, 0.3, 0.4], sum: 654577, center: [68, 59, 67, 255], corner: [40, 50, 60, 255] },
      { preset: [1, 0.5, 0.2, 0.2], sum: 703403, center: [43, 52, 67, 255], corner: [63, 68, 79, 255] },
      { preset: [2, 0.6, 0.5, 0.5], sum: 710418, center: [255, 255, 255, 255], corner: [40, 50, 60, 255] },
      { preset: [3, 0.7, 0.25, 0.35], sum: 682465, center: [49, 53, 62, 255], corner: [40, 50, 60, 255] },
    ];
    try {
      for (const { preset, sum, center, corner } of cases) {
        Math.random = seedRandom(12345);
        const dst = new Uint8ClampedArray(32 * 32 * 4);
        renderLensFlare(src, 32, 32, dst, preset);
        assert.equal(checksum(dst, 11), sum);
        const ci = (16 * 32 + 16) * 4;
        assert.deepEqual([dst[ci], dst[ci + 1], dst[ci + 2], dst[ci + 3]], center);
        assert.deepEqual([dst[0], dst[1], dst[2], dst[3]], corner);
      }
    } finally {
      Math.random = origRandom;
    }
  });
});
