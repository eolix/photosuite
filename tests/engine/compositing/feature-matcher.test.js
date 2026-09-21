/**
 * Golden values for feature-matcher (compositing).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { Rect } from "../../../src/core/math/rect.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import * as FM from "../../../src/engine/compositing/feature-matcher.js";

installBrowserGlobals();

function makeTexturedLayer(width, height, offsetX, offsetY) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = (Math.sin((x + offsetX) * 0.3) * Math.cos((y + offsetY) * 0.27) * 90 + 128 + ((x * 7 + y * 13) & 31)) & 255;
      rgba[i] = v;
      rgba[i + 1] = (v * 3) & 255;
      rgba[i + 2] = (v + 80) & 255;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function seedRandom(seed) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}


before(async () => {
});

describe("feature-matcher", () => {
  it("descriptorDistanceAtIndex / considerMatchCandidate goldens", () => {
    const a = new Uint8Array([0xff, 0x00, 0xaa]);
    const b = new Uint8Array([0x00, 0xff, 0xaa]);
    assert.equal(FM.descriptorDistanceAtIndex(a, b, 1e9), 16);

    const top = new Uint32Array(4);
    top.fill(1e6);
    const visited = new Uint8Array(4);
    const srcKp = { descriptorBytes: new Uint8Array([0x0f, 0x00]) };
    FM.considerMatchCandidate(srcKp, { descriptorBytes: new Uint8Array([0x00, 0x00]) }, 0, top, visited);
    FM.considerMatchCandidate(srcKp, { descriptorBytes: new Uint8Array([0xff, 0xff]) }, 1, top, visited);
    FM.considerMatchCandidate(srcKp, { descriptorBytes: new Uint8Array([0x0f, 0x01]) }, 2, top, visited);
    assert.deepEqual(Array.from(top), [4, 0, 1, 2]);
  });

  it("buildGrayIntegralPyramid integral golden", () => {
    const w = 32;
    const h = 32;
    const gray = new Uint8Array(w * h);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        gray[row * w + col] = (col + row * 3) & 255;
      }
    }
    const pyramid = FM.buildGrayIntegralPyramid(gray, new Rect(0, 0, w, h), false);
    assert.equal(pyramid.length, 1);
    assert.equal(pyramid[0].docScale, 1);
    assert.deepEqual(
      [
        pyramid[0].integralImage[0],
        pyramid[0].integralImage[w - 1],
        pyramid[0].integralImage[w],
        pyramid[0].integralImage[w * h - 1],
      ],
      [0, 496, 3, 63488],
    );
  });

  it("detectKeypointsForLayers runs SURF + ORB to golden keypoints/descriptors", () => {
    const w = 96;
    const h = 80;
    const layer = [makeTexturedLayer(w, h, 0, 0), new Rect(0, 0, w, h)];
    const [keypoints] = FM.detectKeypointsForLayers([layer], false, 120);
    assert.equal(keypoints.length, 120);
    assert.deepEqual(
      [keypoints[0].x, keypoints[0].y, keypoints[0].responseSign, keypoints[0].pyramidLevel],
      [26, 47, 1, 0],
    );
    assert.deepEqual(Array.from(keypoints[0].descriptorBytes.slice(0, 5)), [18, 146, 137, 8, 124]);
    let checksum = 0;
    for (const kp of keypoints) {
      checksum = (checksum + kp.x * 31 + kp.y * 17 + kp.responseSign * 7) % 1000003;
      for (const byte of kp.descriptorBytes) {
        checksum = (checksum * 131 + byte) % 1000003;
      }
    }
    assert.equal(checksum, 315687);
  });

  it("estimatePanoramaHomographies aligns two overlapping layers (seeded)", () => {
    const w = 96;
    const h = 80;
    const layer0 = [makeTexturedLayer(w, h, 0, 0), new Rect(0, 0, w, h)];
    const layer1 = [makeTexturedLayer(w, h, 18, 9), new Rect(12, 6, w, h)];
    const origRandom = Math.random;
    Math.random = seedRandom(99);
    try {
      const homographies = FM.estimatePanoramaHomographies([layer0, layer1], 0);
      assert.equal(homographies.length, 2);
      assert.deepEqual(homographies[0], [1, 0, 0, 0, 1, 0, 0, 0]);
      assert.deepEqual(
        homographies[1].map((v) => {
          const r = Math.round(v * 1e6) / 1e6;
          return Object.is(r, -0) ? 0 : r;
        }),
        [1, 0, -15, 0, 1, 3, 0, 0],
      );
    } finally {
      Math.random = origRandom;
    }
  });

  it("match + seeded ransacHomographyFromMatches goldens", () => {
    function makeKp(x, y, sign, desc) {
      return {
        x,
        y,
        localX: x,
        localY: y,
        responseSign: sign,
        descriptorBytes: desc,
        orientation: 0,
        pyramidLevel: 0,
        responseScore: 100,
      };
    }
    const s0 = new Uint8Array(32);
    s0.fill(0x11);
    s0[0] = 0x11;
    s0[1] = 0x22;
    const s1 = new Uint8Array(32);
    s1.fill(0xaa);
    const s2 = new Uint8Array(32);
    s2.fill(0x01);
    const d0 = s0.slice();
    d0[31] ^= 1;
    const d1 = s1.slice();
    d1[30] ^= 1;
    const junk = new Uint8Array(32);
    junk.fill(0xff);
    const src = [makeKp(5, 5, 1, s0), makeKp(10, 8, 1, s1), makeKp(20, 15, 0, s2)];
    const dst = [makeKp(6, 5, 1, d0), makeKp(11, 8, 1, d1), makeKp(21, 15, 0, s2.slice()), makeKp(0, 0, 1, junk)];
    const trees = FM.buildDescriptorSearchTree(dst);
    assert.deepEqual(FM.matchDescriptors(src, dst, trees), [
      [2, 2, 0],
      [0, 0, 1],
      [1, 1, 1],
    ]);

    let seed = 42;
    const origRandom = Math.random;
    Math.random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    try {
      const srcK = [];
      const dstK = [];
      const matchList = [];
      for (let i = 0; i < 16; i++) {
        const x = (i % 4) * 3;
        const y = ((i / 4) | 0) * 3;
        srcK.push({ x, y });
        dstK.push({ x: x + 2, y: y + 1 });
        matchList.push([i, i, 0]);
      }
      const H = FM.ransacHomographyFromMatches(srcK, dstK, matchList, 4);
      assert.deepEqual(
        H.map((v) => {
          const r = Math.round(v * 1e6) / 1e6;
          return Object.is(r, -0) ? 0 : r;
        }),
        [1, 0, -2, 0, 1, -1, 0, 0],
      );
    } finally {
      Math.random = origRandom;
    }
  });
});
