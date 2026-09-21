import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { chamferDistance, colorDistance, getSelection, normalizeArray } from "../../../src/engine/compositing/color-sampler.js";

installBrowserGlobals();

// Border erosion filters through the engine's rank filter, so the engine has to
// be assembled before getSelection runs.
before(async () => {
  await import("../../../src/engine/layer-system.js");
});

describe("engine/compositing/color-sampler.js helpers", () => {
  it("colorDistance and normalizeArray match captured values", () => {
    const dist = colorDistance(new Uint8Array([100, 150, 200, 255]), 0, new Uint8Array([50, 50, 50]), 0);
    assert.equal(Math.round(dist * 1e6) / 1e6, 0.423552);
    const values = new Float32Array([1, 2, 4, 0]);
    normalizeArray(values);
    assert.deepEqual(Array.from(values), [0.25, 0.5, 1, 0]);
  });
});

describe("engine/compositing/color-sampler.js registration", () => {
  it("getSelection scores a border-based selection (real rankFilter + buffer deps)", () => {
    const w = 12;
    const h = 10;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = x * 20; rgba[i + 1] = y * 25; rgba[i + 2] = 128; rgba[i + 3] = 255;
    }
    const sel = getSelection(rgba, w, h);
    assert.equal(sel.length, 120);
    assert.equal(Array.from(sel).reduce((a, b) => a + b, 0), 9219);
    assert.deepEqual([sel[0], sel[55], sel[119]], [0, 255, 0]);
  });

  it("chamferDistance runs the MBD scan to a captured distance field", () => {
    const w = 12;
    const h = 10;
    const channel = new Uint8Array(w * h);
    for (let i = 0; i < channel.length; i++) channel[i] = (i * 7) & 255;
    const mask = new Uint8Array(w * h);
    mask[0] = 255;
    mask[w * h - 1] = 255;
    const out = new Uint16Array(w * h);
    chamferDistance(channel, mask, w, h, out);
    assert.equal(Array.from(out).reduce((a, b) => a + b, 0), 1519);
    assert.deepEqual([out[0], out[60], out[119]], [0, 5, 0]);
  });
});
