/**
 * Golden values for dithering (compositing).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ditheringPatterns,} from "../../../src/engine/compositing/dithering.js";

function round6(v) {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

function makePatterns() {
  const Compositing = function Compositing() {};
  return ditheringPatterns;
}

describe("dithering", () => {
  it("applyErrorDiffusion ramp + cache goldens", () => {
    const D = makePatterns();
    const ramp = D.applyErrorDiffusion(0.3, 2);
    assert.deepEqual(
      [0, 100, 500, 1000].map((i) => round6(ramp[i])),
      [1.976, 0.91357, 0.370748, 0.025642],
    );
    assert.equal(D.applyErrorDiffusion(0.3, 2), ramp);
  });

  it("applyPatternDithering mode 0 / 4 field goldens", () => {
    const D = makePatterns();
    const w = 4;
    const h = 4;

    const field0 = new Float64Array(w * h * 2);
    const out0 = [];
    D.applyPatternDithering(field0, w, h, 0, 1.5, 1.5, 2, 0.3, 2, 1, 0, out0, false);
    assert.deepEqual(
      Array.from(field0).map(round6),
      [
        0, 0, -0.275261, 0, -0.351029, 0, 0, 0, -0.275261, 0, -1.076784, 0, -1.75356, 0, -0.757947, 0, -0.275261, 0,
        -1.076784, 0, -1.75356, 0, -0.757947, 0, 0, 0, -0.275261, 0, -0.351029, 0, 0, 0,
      ],
    );

    const field4 = new Float64Array(w * h * 2);
    const out4 = new Int32Array(w * h).fill(-1);
    D.applyPatternDithering(field4, w, h, 4, 1.5, 1.5, 2, 0.5, 1.5, 0, 1, out4, false);
    assert.deepEqual(
      Array.from(out4).filter((v) => v >= 0),
      [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14],
    );
    assert.deepEqual(
      Array.from(field4).map(round6),
      [
        0, 0, -0.075437, -0.22631, 0.075437, -0.22631, 0, 0, -0.22631, -0.075437, -0.264364, -0.264364, 0.218404,
        -0.249044, 0.176883, -0.019075, -0.22631, 0.075437, -0.249044, 0.218404, 0.203084, 0.203084, 0.18035, 0.029477, 0,
        0, -0.019075, 0.176883, 0.029477, 0.18035, 0, 0,
      ],
    );
  });

  it("applyThreshold leaves linear gradient stable at interior samples", () => {
    const D = makePatterns();
    const w = 4;
    const h = 4;
    const grad = new Float64Array(w * h * 2);
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        const i = (row * w + col) * 2;
        grad[i] = col * 0.1;
        grad[i + 1] = row * 0.1;
      }
    }
    D.applyThreshold(w, h, grad, [5, 6, 9, 10], 2);
    assert.deepEqual(
      Array.from(grad).map(round6),
      [
        0, 0, 0.1, 0, 0.2, 0, 0.3, 0, 0, 0.1, 0.1, 0.1, 0.2, 0.1, 0.3, 0.1, 0, 0.2, 0.1, 0.2, 0.2, 0.2, 0.3, 0.2, 0, 0.3,
        0.1, 0.3, 0.2, 0.3, 0.3, 0.3,
      ],
    );
  });

  it("computePointBounds returns AABB of flat xy list", () => {
    const D = makePatterns();
    assert.deepEqual(D.computePointBounds([0, 0, 3, 1, 1, 4, -1, 2]), [-1, 0, 3, 4]);
  });
});
