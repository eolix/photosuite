/**
 * Golden values for spatial-filters (compositing).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { convolveChannel3x3, convolveChannel3x3Raw, convolveRGBA, filterChannel, filterRGBA, findEdgesChannel, findEdgesRGB, normalizeKernel, presetKernels, selectMaximum, selectMinimum, selectPercentile, selectWeightedMean } from "../../../src/engine/compositing/spatial-filters.js";

installBrowserGlobals();


// The rank filters are still assembled on the engine namespace.
before(async () => {
  await import("../../../src/engine/layer-system.js");
});

function rgba4() {
  const buf = new Uint8ClampedArray(4 * 4 * 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const i = (y * 4 + x) * 4;
      buf[i] = x * 60;
      buf[i + 1] = y * 60;
      buf[i + 2] = 100;
      buf[i + 3] = 255;
    }
  }
  return buf;
}

function mono4() {
  const buf = new Uint8Array(4 * 4);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) buf[y * 4 + x] = x * 40 + y * 10;
  }
  return buf;
}

before(async () => {
});

describe("engine/compositing/spatial-filters.js ConvolutionUtils", () => {
  it("normalizeKernel and soft convolveRGBA", () => {
    const norm = normalizeKernel([1, 2, 1, 2, 4, 2, 1, 2, 1]);
    assert.deepEqual(
      Array.from(norm).map((v) => +v.toFixed(6)),
      [0.0625, 0.125, 0.0625, 0.125, 0.25, 0.125, 0.0625, 0.125, 0.0625],
    );
    const dest = new Uint8ClampedArray(64);
    convolveRGBA(rgba4(), dest, 4, 4, presetKernels[1], 255, false, false);
    assert.deepEqual(Array.from(dest.slice(0, 16)), [
      15, 15, 100, 255, 60, 15, 100, 255, 120, 15, 100, 255, 165, 15, 100, 255,
    ]);
  });

  it("findEdgesRGB / Channel and 3x3 helpers", () => {
    const edges = new Uint8ClampedArray(64);
    findEdgesRGB(rgba4(), edges, 4, 4);
    assert.deepEqual(Array.from(edges.slice(0, 16)), [
      15, 15, 255, 0, 0, 15, 255, 0, 0, 15, 255, 0, 15, 15, 255, 0,
    ]);
    const chOut = new Uint8Array(16);
    convolveChannel3x3(mono4(), chOut, 4, 4, presetKernels[4], true);
    assert.deepEqual(Array.from(chOut), [0, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0]);
    const edgesCh = new Uint8Array(16);
    findEdgesChannel(mono4(), edgesCh, 4, 4);
    assert.deepEqual(Array.from(edgesCh), [
      255, 255, 255, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 255, 255,
    ]);
    const rawOut = new Float64Array(16);
    convolveChannel3x3Raw(mono4(), rawOut, 4, 4, presetKernels[4]);
    assert.equal(+rawOut[5].toFixed(6), 320);
    assert.equal(+rawOut[6].toFixed(6), 320);
  });
});

describe("engine/compositing/spatial-filters.js rankFilter", () => {
  it("filterChannel median / weightedMean / large-radius max", () => {
    const median = new Uint8Array(16);
    filterChannel(mono4(), median, 4, 4, 1, selectPercentile, null);
    assert.deepEqual(Array.from(median), [
      40, 50, 90, 120, 40, 60, 100, 120, 50, 70, 110, 130, 60, 70, 110, 140,
    ]);
    const mean = new Uint8Array(16);
    filterChannel(mono4(), mean, 4, 4, 1, selectWeightedMean, [2]);
    assert.deepEqual(
      Array.from(mean).map((v) => Math.round(v)),
      [0, 40, 80, 120, 10, 50, 90, 130, 20, 60, 100, 140, 30, 70, 110, 150],
    );
    const large = new Uint8Array(16);
    filterChannel(mono4(), large, 4, 4, 81, selectMaximum, null);
    assert.deepEqual(Array.from(large), Array(16).fill(150));
    const copy = new Uint8Array(16);
    filterChannel(mono4(), copy, 4, 4, 0, selectMaximum, null);
    assert.deepEqual(Array.from(copy), Array.from(mono4()));
  });

  it("filterRGBA max/min opaque and partial-alpha path", () => {
    const maxOut = new Uint8ClampedArray(64);
    filterRGBA(rgba4(), maxOut, 4, 4, 1, selectMaximum, null);
    assert.deepEqual(
      Array.from(maxOut),
      [
        60, 60, 100, 0, 120, 60, 100, 0, 180, 60, 100, 0, 180, 60, 100, 0, 60, 120, 100, 0, 120, 120,
        100, 0, 180, 120, 100, 0, 180, 120, 100, 0, 60, 180, 100, 0, 120, 180, 100, 0, 180, 180, 100,
        0, 180, 180, 100, 0, 60, 180, 100, 0, 120, 180, 100, 0, 180, 180, 100, 0, 180, 180, 100, 0,
      ],
    );
    const minOut = new Uint8ClampedArray(64);
    filterRGBA(rgba4(), minOut, 4, 4, 1, selectMinimum, null);
    assert.deepEqual(
      Array.from(minOut),
      [
        0, 0, 100, 0, 0, 0, 100, 0, 60, 0, 100, 0, 120, 0, 100, 0, 0, 0, 100, 0, 0, 0, 100, 0, 60, 0,
        100, 0, 120, 0, 100, 0, 0, 60, 100, 0, 0, 60, 100, 0, 60, 60, 100, 0, 120, 60, 100, 0, 0, 120,
        100, 0, 0, 120, 100, 0, 60, 120, 100, 0, 120, 120, 100, 0,
      ],
    );
    const partial = rgba4();
    partial[3] = 0;
    partial[7] = 128;
    const partialOut = new Uint8ClampedArray(64);
    filterRGBA(partial, partialOut, 4, 4, 1, selectMaximum, null);
    assert.deepEqual(
      Array.from(partialOut),
      [
        60, 60, 100, 0, 120, 60, 100, 0, 180, 60, 100, 128, 180, 60, 100, 255, 60, 120, 100, 0, 120,
        120, 100, 0, 180, 120, 100, 128, 180, 120, 100, 255, 60, 180, 100, 255, 120, 180, 100, 255,
        180, 180, 100, 255, 180, 180, 100, 255, 60, 180, 100, 255, 120, 180, 100, 255, 180, 180, 100,
        255, 180, 180, 100, 255,
      ],
    );
  });
});
