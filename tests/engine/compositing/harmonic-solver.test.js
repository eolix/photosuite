import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { Rect } from "../../../src/core/math/rect.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { PlanarRgbaBuffer, allocBuffer, downsampleHalfAlphaWeighted, extractChannel, extractChannelByte, fillBuffer, interleavedToPlanar } from "../../../src/engine/compositing/buffer-utils.js";
import { bilinearInterp, byteToFloat, guidedFilter, guidedFilterRgb, pointwiseMul } from "../../../src/engine/compositing/harmonic-solver.js";


function createCompositing() {
  const Compositing = function Compositing() {};
  PlanarRgbaBuffer = function PlanarRgbaBuffer() {
    this.h = this.l = this.O = new Uint8Array(0);
  };
  Compositing.blur = { boxBlur: () => {} };
  return Compositing;
}

before(async () => {
});

describe("engine/compositing/harmonic-solver.js helpers", () => {
  it("byteToFloat, pointwiseMul, and bilinearInterp match captured values", () => {
    const floats = byteToFloat(new Uint8Array([0, 128, 255]));
    assert.deepEqual(Array.from(floats).map((value) => Math.round(value * 1000) / 1000), [0, 0.502, 1]);
    const out = new Float32Array(3);
    pointwiseMul(floats, floats, out);
    assert.deepEqual(Array.from(out).map((value) => Math.round(value * 1000) / 1000), [0, 0.252, 1]);
    assert.equal(
      Math.round(bilinearInterp(0.75, 0.75, new Float32Array([1, 2, 3, 4]), 2, 2) * 1000) / 1000,
      1.75,
    );
  });
});

describe("engine/compositing/harmonic-solver.js registration", () => {
  it("registerHarmonicSolver wires guidedFilter after install", () => {
    assert.equal(typeof guidedFilter, "function");
    assert.equal(typeof guidedFilterRgb, "function");
    const floats = byteToFloat(new Uint8Array([255]));
    assert.equal(floats[0], 1);
  });
});


describe("engine/compositing/harmonic-solver.js guidedFilter (real engine, golden)", () => {
  let Compositing;
  before(async () => {
    installBrowserGlobals();
    await import("../../../src/engine/layer-system.js");
  });

  it("guidedFilter edge-preserves a soft step under a ramp guide", () => {
    const w = 16;
    const h = 16;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const guide = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const i = p * 4;
      guide[p] = Math.min(255, x * 16);
      const v = x < 8 ? 60 : 200;
      rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
    }
    const out = guidedFilter(guide, rgba, new Rect(0, 0, w, h), 4, 0.01);
    assert.equal(out.length, 256);
    assert.equal(Array.from(out).reduce((a, b) => a + b, 0), 24576);
    assert.deepEqual([out[0], out[8], out[135], out[255]], [25, 151, 41, 167]);
  });
});
