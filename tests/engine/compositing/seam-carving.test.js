/**
 * Golden values for seam-carving (compositing).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { allocBuffer } from "../../../src/engine/compositing/buffer-utils.js";
import { applySeams, computeCostMatrix, computeEdgeEnergy, computeSeams, resize } from "../../../src/engine/compositing/seam-carving.js";

installBrowserGlobals();


function gradientRgba(width, height) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      pixels[i] = x * 20;
      pixels[i + 1] = y * 30;
      pixels[i + 2] = 100;
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

// The seam cache keys on an adler checksum of the source pixels, which the
// app takes from UZIP.
function installUzipChecksum() {
  globalThis.UZIP = {
    adler(buf, off, len) {
      let a = 1;
      let b = 0;
      for (let i = off; i < off + len; i++) {
        a = (a + buf[i]) % 65521;
        b = (b + a) % 65521;
      }
      return (b << 16) | a;
    },
  };
}

before(() => {
  installUzipChecksum();
});

describe("engine/compositing/seam-carving.js", () => {
  it("computeEdgeEnergy on a 4×3 gradient", () => {
    const energy = new Uint16Array(4 * 3);
    computeEdgeEnergy(gradientRgba(4, 3), 4, 3, energy);
    assert.deepEqual(Array.from(energy), [100, 70, 70, 100, 160, 100, 100, 160, 100, 70, 70, 100]);
  });

  it("computeCostMatrix seam order / cost / dir for 5×4", () => {
    const bundle = computeCostMatrix(gradientRgba(5, 4), 5, 4);
    assert.equal(bundle[0], 240853601);
    assert.deepEqual(Array.from(bundle[7]), [1, 0, 2, 3, 4]);
    assert.deepEqual(Array.from(bundle[8]), [370, 490, 340, 340, 520]);
    assert.deepEqual(Array.from(bundle[9].slice(0, 15)), [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 0, 1, 1, 1]);
  });

  it("applySeams shrinks 5→3 preserving first-row RGB samples", () => {
    const bundle = computeCostMatrix(gradientRgba(5, 4), 5, 4);
    const dst = new Uint8Array(3 * 4 * 4);
    applySeams(bundle, 3, dst);
    assert.deepEqual(Array.from(dst.slice(0, 12)), [0, 0, 100, 255, 20, 0, 100, 255, 80, 0, 100, 255]);
  });

  it("resize width and height via computeSeams bundles", () => {
    const src = gradientRgba(4, 3);
    const to33 = resize(computeSeams(src, 4, 3), { width: 3, height: 3 });
    assert.equal(to33.length, 36);
    assert.deepEqual(Array.from(to33.slice(0, 16)), [
      0, 0, 100, 255, 20, 0, 100, 255, 60, 0, 100, 255, 0, 30, 100, 255,
    ]);
    const to42 = resize(computeSeams(src, 4, 3), { width: 4, height: 2 });
    assert.equal(to42.length, 32);
    assert.deepEqual(Array.from(to42.slice(0, 16)), [
      0, 30, 100, 255, 20, 0, 100, 255, 40, 0, 100, 255, 60, 0, 100, 255,
    ]);
  });
});
