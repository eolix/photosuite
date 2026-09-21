import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { Rect } from "../../../src/core/math/rect.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { anisotropicBlur, bristleValue, computeStructureTensor, convolveKernel, filter, hash, lightDotProduct, padBorder } from "../../../src/engine/compositing/diffuse.js";

function createCompositing() {
  const Compositing = function Compositing() {};
  Compositing.blur = { gaussianBlurFloat: () => {} };
  Compositing.homography = {
    sampleBilinearFloat: (_x, _y, sourceRgba, _width, _height, out) => {
      out[0] = sourceRgba[0];
      out[1] = sourceRgba[1];
      out[2] = sourceRgba[2];
      out[3] = sourceRgba[3];
    },
  };
  // The CPU path is what these goldens cover; the layer system reports WebGL
  // off until something gives it a canvas, which nothing here does.
  return Compositing;
}

describe("engine/compositing/diffuse.js helpers", () => {
  it("hash and bristleValue are deterministic", () => {
    assert.equal(Math.round(hash(0.3, 0.7) * 1e6) / 1e6, 0.117007);
    assert.equal(Math.round(bristleValue(1.5, 2.5, 0.25, 0.4) * 1e6) / 1e6, 0.419897);
  });

  it("convolveKernel on a flat patch returns zero", () => {
    const solid = new Uint8ClampedArray(9 * 4);
    solid.fill(100);
    for (let idx = 3; idx < solid.length; idx += 4) {
      solid[idx] = 255;
    }
    assert.equal(convolveKernel(solid, 16, 12, [-1, 0, 1, -2, 0, 2, -1, 0, 1]), 0);
  });

  it("computeStructureTensor + padBorder produce the vertical-edge golden", () => {
    const width = 3;
    const height = 3;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const off = (row * width + col) * 4;
        const value = col < 1 ? 0 : 255;
        rgba[off] = value;
        rgba[off + 1] = value;
        rgba[off + 2] = value;
        rgba[off + 3] = 255;
      }
    }
    const tensor = new Float32Array(width * height * 4);
    computeStructureTensor(rgba, width, height, tensor);
    assert.deepEqual(
      [tensor[16], tensor[17], tensor[18]].map((value) => Math.round(value * 100) / 100),
      [3121200, 0, 0],
    );

    const padTensor = new Float32Array(9 * 4);
    padTensor[16] = 1;
    padTensor[17] = 2;
    padTensor[18] = 3;
    padBorder(padTensor, 3, 3);
    assert.deepEqual([padTensor[0], padTensor[1], padTensor[2]], [1, 2, 3]);
  });

  it("lightDotProduct returns 1 for a flat alpha field and z-up light", () => {
    const flat = new Uint8ClampedArray(9 * 4);
    for (let idx = 0; idx < 9; idx++) {
      flat[idx * 4] = 128;
      flat[idx * 4 + 1] = 128;
      flat[idx * 4 + 2] = 128;
      flat[idx * 4 + 3] = 200;
    }
    assert.equal(Math.round(lightDotProduct(1, 1, flat, 3, 3, [0, 0, 1]) * 1e6) / 1e6, 1);
  });
});

describe("engine/compositing/diffuse.js registration", () => {
  it("the CPU path preserves source alpha", () => {
    createCompositing();
    assert.equal(typeof filter, "function");
    assert.equal(typeof anisotropicBlur, "function");

    const rect = { width: 2, height: 2 };
    const source = new Uint8ClampedArray([
      10, 20, 30, 40,
      50, 60, 70, 80,
      90, 100, 110, 120,
      130, 140, 150, 160,
    ]);
    const dest = new Uint8ClampedArray(16);
    filter(source, rect, dest, [1, 0, 8, 0, false, 0, [0, 0, 1]]);
    assert.deepEqual([dest[3], dest[7], dest[11], dest[15]], [40, 80, 120, 160]);
  });
});


describe("engine/compositing/diffuse.js filter pipeline (real engine, goldens)", () => {
  let Compositing;
  before(async () => {
    installBrowserGlobals();
    // Nothing gives the layer system a canvas here, so it reports WebGL off
    // and these goldens exercise the CPU path.
    await import("../../../src/engine/layer-system.js");
  });
  const w = 16;
  const h = 12;
  const sum = (a) => Array.from(a).reduce((x, y) => x + y, 0);
  function makeImage() {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = (x * 15 + y * 3) & 255;
      rgba[i + 1] = (y * 20 + x * 2) & 255;
      rgba[i + 2] = (x * x + y * y) & 255;
      rgba[i + 3] = x < 8 ? 255 : 120;
    }
    return rgba;
  }

  it("filter (structure tensor + flow blur, no bristle) matches golden", () => {
    const dest = new Uint8ClampedArray(w * h * 4);
    filter(makeImage(), new Rect(0, 0, w, h), dest, [3, 4, 5, 6, false, 0.5, [0.3, 0.4, 0.85]]);
    assert.equal(sum(dest), 104815);
    assert.deepEqual([dest[0], dest[1], dest[2], dest[3]], [0, 0, 0, 255]);
    assert.deepEqual([dest[240], dest[241], dest[242], dest[243]], [173, 122, 151, 120]);
  });

  it("filter with bristle + specular matches golden", () => {
    const dest = new Uint8ClampedArray(w * h * 4);
    filter(makeImage(), new Rect(0, 0, w, h), dest, [3, 4, 5, 6, true, 0.5, [0.3, 0.4, 0.85]]);
    assert.equal(sum(dest), 129367);
    assert.deepEqual([dest[0], dest[1], dest[2], dest[240]], [0, 0, 0, 244]);
  });

  it("anisotropicBlur flows samples along an encoded tangent field", () => {
    const flow = new Uint8Array(w * h * 4);
    for (let i = 0; i < flow.length; i += 4) { flow[i] = 168; flow[i + 1] = 98; }
    const dest = new Uint8ClampedArray(w * h * 4);
    anisotropicBlur(makeImage(), dest, flow, w, h, 3);
    assert.equal(sum(dest), 103943);
    assert.deepEqual([dest[0], dest[1], dest[2], dest[100]], [0, 0, 0, 137]);
  });
});
