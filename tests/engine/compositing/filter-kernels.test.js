/**
 * Golden values for filter-kernels (compositing).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { applyCloudsNoise, applyDespeckle, applyDiffuseDither, applyDiffuseNoise, applyFragmentBoxDownsample, applySharpenEdges, applyWindBlend, createCloudsNoiseRenderer, minHeap } from "../../../src/engine/compositing/filter-kernels.js";

installBrowserGlobals();


function checksum(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    sum = (sum + buf[i] * (i % 7 + 1)) % 1000003;
  }
  return sum;
}

function seedRandom(seed) {
  Math.random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

/** 8×8 patterned RGBA: R = 4 * pixelIndex, G=50, B=100, A=255. */
function makePatternedRgba(width, height) {
  const src = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    src[i] = 4 * p;
    src[i + 1] = 50;
    src[i + 2] = 100;
    src[i + 3] = 255;
  }
  return src;
}

function createCompositing(seedBeforeRegister) {
  if (seedBeforeRegister != null) seedRandom(seedBeforeRegister);
  const Compositing = function Compositing() {};
  return Compositing;
}

before(async () => {
});

describe("filter-kernels", () => {
  it("applyFragmentBoxDownsample matches golden", () => {
    const w = 8;
    const h = 8;
    const src = makePatternedRgba(w, h);
    const dst = new Uint8ClampedArray(src.length);
    applyFragmentBoxDownsample(src, w, h, dst, [2]);
    assert.equal(checksum(dst), 135502);
    assert.deepEqual(Array.from(dst.slice(0, 8)), [36, 50, 100, 255, 38, 50, 100, 255]);
  });

  // The renderer shuffles its permutation table when it is built, so the seed
  // has to be in place before the factory runs.
  it("applyCloudsNoise matches seeded golden", () => {
    seedRandom(999);
    const applyCloudsNoise = createCloudsNoiseRenderer();
    const w = 8;
    const h = 8;
    const src = makePatternedRgba(w, h);
    const gray = new Uint8Array(w * h);
    applyCloudsNoise(src, w, h, gray, 0.42);
    assert.equal(checksum(gray), 32066);
    assert.deepEqual(Array.from(gray.slice(0, 8)), [128, 140, 143, 126, 128, 121, 112, 123]);
  });

  it("applyDiffuseDither matches seeded golden", () => {
    seedRandom(7);
    const w = 8;
    const h = 8;
    const gray = new Uint8Array(w * h);
    for (let i = 0; i < gray.length; i++) gray[i] = (i * 17) & 255;
    const mask = new Uint8Array(w * h);
    applyDiffuseDither(gray, w, h, mask, [3, 25, 1]);
    assert.equal(checksum(mask), 45645);
    assert.deepEqual(Array.from(mask.slice(0, 8)), [0, 0, 255, 255, 0, 0, 255, 255]);
  });

  it("applyDiffuseNoise mode 0 matches seeded golden", () => {
    seedRandom(55);
    const w = 8;
    const h = 8;
    const src = makePatternedRgba(w, h);
    const dst = new Uint8ClampedArray(src.length);
    applyDiffuseNoise(src, w, h, dst, [0]);
    assert.equal(checksum(dst), 135604);
    assert.deepEqual(Array.from(dst.slice(0, 8)), [4, 50, 100, 255, 8, 50, 100, 255]);
  });

  it("applyWindBlend method 0 matches seeded golden", () => {
    seedRandom(9);
    const w = 8;
    const h = 8;
    const src = makePatternedRgba(w, h);
    const dst = new Uint8ClampedArray(src.length);
    applyWindBlend(src, w, h, dst, [0, 0]);
    assert.equal(checksum(dst), 136888);
    assert.deepEqual(Array.from(dst.slice(0, 8)), [13, 40, 82, 255, 17, 47, 96, 255]);
  });

  it("applyWindBlend method 2 with horizontal flip matches seeded golden", () => {
    seedRandom(4);
    const w = 8;
    const h = 8;
    const src = makePatternedRgba(w, h);
    const dst = new Uint8ClampedArray(src.length);
    applyWindBlend(src, w, h, dst, [2, 1]);
    assert.equal(checksum(dst), 135484);
    assert.deepEqual(Array.from(dst.slice(0, 8)), [0, 50, 100, 255, 4, 50, 100, 255]);
  });

  it("minHeap push/pop order matches golden", () => {
    const heap = [null];
    minHeap.push(heap, [5, "a"]);
    minHeap.push(heap, [2, "b"]);
    minHeap.push(heap, [8, "c"]);
    const keys = [
      minHeap.pop(heap)[0],
      minHeap.pop(heap)[0],
      minHeap.pop(heap)[0],
    ];
    assert.deepEqual(keys, [2, 5, 8]);
  });

  it("applySharpenEdges matches golden", () => {
    const w = 8;
    const h = 8;
    const src = makePatternedRgba(w, h);
    const dst = new Uint8ClampedArray(src.length);
    applySharpenEdges(src, w, h, dst);
    assert.equal(checksum(dst), 135484);
    // ClampedArray rounds float blends; sample bytes from the golden capture.
    assert.deepEqual(Array.from(dst.slice(0, 8)), [0, 50, 100, 255, 4, 50, 100, 255]);
  });

  it("applyDespeckle matches golden", () => {
    const w = 8;
    const h = 8;
    const src = makePatternedRgba(w, h);
    const dst = new Uint8ClampedArray(src.length);
    applyDespeckle(src, w, h, dst);
    assert.equal(checksum(dst), 70204);
    assert.deepEqual(Array.from(dst.slice(0, 8)), [9, 50, 100, 0, 12, 50, 100, 0]);
  });
});
