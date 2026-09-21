/**
 * Golden values for quantizer (compositing).
 * Mosaic paths use a seeded Math.random so jittered codebooks are deterministic.
 */
import assert from "node:assert/strict";
import { describe, it, before, beforeEach, afterEach } from "node:test";
import { bisectorDist, quantize, quantizeDithered, quantizeImpl, quantizeWithBorder, squaredDist } from "../../../src/engine/compositing/quantizer.js";

let originalRandom;

/** Park–Miller LCG used for golden capture. */
function installSeededRandom(seedStart = 1) {
  let seed = seedStart;
  Math.random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  return () => {
    seed = seedStart;
  };
}

function createSource(width, height) {
  const src = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    src[i * 4] = i * 10;
    src[i * 4 + 1] = i * 5;
    src[i * 4 + 2] = i * 3;
    src[i * 4 + 3] = 255;
  }
  return src;
}

function createCompositing() {
  const Compositing = function Compositing() {};
  return Compositing;
}

before(async () => {
});

beforeEach(() => {
  originalRandom = Math.random;
});

afterEach(() => {
  Math.random = originalRandom;
});

describe("engine/compositing/quantizer.js distance helpers", () => {
  it("squaredDist returns squared Euclidean distance to a codebook site", () => {
    assert.equal(squaredDist([0, 0, 3, 4], 2, 0, 0), 25);
  });

  it("bisectorDist measures distance to the perpendicular bisector", () => {
    assert.equal(bisectorDist([0, 0, 10, 0], 0, 2, 0, 5), 5);
  });
});

describe("engine/compositing/quantizer.js mosaic", () => {
  it("quantize matches seeded 4×4 mosaic", () => {
    const reset = installSeededRandom(1);
    const src = createSource(4, 4);
    const dst = new Uint8Array(64);
    reset();
    quantize(src, 4, 4, dst, 2);
    assert.deepEqual(
      Array.from(dst),
      [
        0, 0, 0, 255, 44, 22, 13, 255, 60, 30, 18, 255, 53, 27, 16, 255, 66, 33, 20, 255, 66, 33, 20, 255, 60, 30, 18,
        255, 98, 49, 29, 255, 80, 40, 24, 255, 75, 37, 22, 255, 100, 50, 30, 255, 150, 75, 45, 255, 86, 43, 26, 255, 93,
        47, 28, 255, 146, 73, 44, 255, 150, 75, 45, 255,
      ],
    );
  });

  it("quantizeWithBorder matches seeded border fill", () => {
    const reset = installSeededRandom(1);
    const src = createSource(4, 4);
    const dst = new Uint8Array(64);
    reset();
    quantizeWithBorder(src, 4, 4, dst, 2, [255, 0, 0]);
    assert.deepEqual(
      Array.from(dst),
      [
        29, 0, 2, 255, 171, 26, 5, 255, 154, 31, 6, 255, 255, 0, 0, 255, 68, 41, 24, 255, 72, 55, 16, 255, 71, 57, 10,
        255, 239, 5, 1, 255, 74, 51, 29, 255, 93, 47, 22, 255, 178, 32, 10, 255, 134, 77, 36, 255, 235, 6, 3, 255, 255,
        0, 0, 255, 225, 19, 9, 255, 123, 84, 39, 255,
      ],
    );
  });

  it("quantizeDithered matches seeded palette fill", () => {
    const reset = installSeededRandom(1);
    const src = createSource(4, 4);
    const dst = new Uint8Array(64);
    reset();
    quantizeDithered(src, 4, 4, dst, 2, [0, 0, 255], 1);
    assert.deepEqual(
      Array.from(dst),
      [
        0, 0, 0, 255, 0, 0, 164, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 229, 255, 0, 0, 0, 255, 0, 0, 0,
        255, 0, 0, 145, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 0, 255, 0, 0, 255, 255, 135, 68, 66, 255, 112, 56, 99,
        255, 88, 44, 132, 255,
      ],
    );
  });
});

describe("engine/compositing/quantizer.js registration", () => {
  it("registerQuantizer wires facade and impl APIs", () => {
    assert.equal(typeof quantize, "function");
    assert.equal(typeof quantizeWithBorder, "function");
    assert.equal(typeof quantizeDithered, "function");
    assert.equal(typeof quantizeImpl, "function");
    assert.equal(typeof squaredDist, "function");
    assert.equal(typeof bisectorDist, "function");
  });
});
