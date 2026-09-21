/**
 * Golden values for pixel-engine (gallery pixel ops).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let PixelEngine;

before(async () => {
  ({ PixelEngine } = await import("../../../../src/features/filters/gallery/pixel-engine.js"));
  // Force JS fallbacks so goldens are independent of async wasm load timing.
  PixelEngine._medianWasm = null;
  PixelEngine._blurWasm = null;
  PixelEngine.loadMedianWasm = function () {};
  PixelEngine.loadBlurWasm = function () {};
});

describe("features/filters/gallery/pixel-engine.js", () => {
  it("boxBlur / medianBlurChan / medianBlurH match the golden buffers", () => {
    PixelEngine.init(4, 4);
    const gray = new Uint8Array(16);
    for (let i = 0; i < 16; i++) gray[i] = i * 16;

    const box = new Uint8Array(16);
    PixelEngine.boxBlur(gray, box, 3, 3);
    assert.deepEqual(
      [...box],
      [26, 37, 53, 64, 69, 80, 96, 106, 133, 144, 160, 170, 176, 186, 202, 213],
    );

    const median = new Uint8Array(16);
    PixelEngine.medianBlurChan(gray, median, 3, 1, false, 2);
    assert.deepEqual(
      [...median],
      [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224, 240],
    );

    const medianH = new Uint8Array(16);
    PixelEngine.medianBlurH(gray, medianH, 3, 3, 5);
    assert.deepEqual(
      [...medianH],
      [16, 32, 48, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 192, 208, 224],
    );
  });

  it("color / LUT / border helpers match values", () => {
    PixelEngine.init(4, 4);
    PixelEngine.seedRandom(1);

    const rgba = new Uint8ClampedArray(64);
    for (let i = 0; i < 16; i++) {
      rgba[i * 4] = 40 + i;
      rgba[i * 4 + 1] = 80;
      rgba[i * 4 + 2] = 120;
      rgba[i * 4 + 3] = 255;
    }

    const sharpened = new Uint8ClampedArray(64);
    PixelEngine.sharpenRGBA(rgba, sharpened, 50);
    assert.deepEqual([...sharpened.slice(0, 8)], [0, 80, 120, 255, 41, 80, 120, 255]);

    const hsv = new Uint8ClampedArray(rgba);
    PixelEngine.rgbToHSV(hsv);
    assert.deepEqual([...hsv.slice(0, 8)], [150, 170, 120, 255, 151, 167, 120, 255]);
    PixelEngine.hsvToRGB(hsv);
    assert.deepEqual([...hsv.slice(0, 8)], [40, 77, 120, 255, 41, 76, 120, 255]);

    const lut = PixelEngine.buildBrightnessLUT(10, 20);
    assert.equal(lut[0], 35);
    assert.equal(lut[128], 86);
    assert.equal(lut[255], 136);

    const border = new Uint8Array(16);
    PixelEngine.buildBorder(2, 2, 1, 1, 255, 0, border);
    assert.deepEqual(
      [...border],
      [255, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255],
    );

    const edge = new Uint8Array(16);
    PixelEngine.mergeEdge(edge, 2, 2, 1, 1);
    assert.deepEqual(
      [...edge],
      [255, 255, 0, 255, 255, 255, 0, 255, 0, 0, 0, 0, 255, 255, 0, 255],
    );

    assert.deepEqual(
      [PixelEngine.clamp(300), PixelEngine.clamp(-1), PixelEngine.clamp(12.7)],
      [255, 0, 12],
    );
    assert.deepEqual([PixelEngine.blurFactor(20), PixelEngine.blurFactor(45)], [0.5, 2.5]);

    const gray = new Uint8Array(16);
    for (let i = 0; i < 16; i++) gray[i] = i * 16;
    const grad = new Int32Array(16);
    PixelEngine.computeGradients(gray, grad);
    assert.deepEqual([...grad], [1, 5, 1, 5, 1, 5, 1, 0, 1, 5, 1, 5, 1, 5, 1, 0]);
  });
});
