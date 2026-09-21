/**
 * Golden values for sparse-matrix / SplineMatrix (compositing).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SplineMatrix } from "../../../src/engine/compositing/sparse-matrix.js";

/** Symmetric positive-definite tridiagonal 3×3 used for goldens. */
function spd3() {
  const m = new SplineMatrix(3, 3);
  m.addRow([4, -1], [0, 1], 2);
  m.addRow([-1, 4, -1], [0, 1, 2], 3);
  m.addRow([-1, 4], [1, 2], 2);
  return m;
}

function roundArr(arr, digits = 10) {
  return arr.map((x) => {
    const n = +(+x).toFixed(digits);
    return Object.is(n, -0) ? 0 : n;
  });
}

describe("engine/compositing/sparse-matrix.js", () => {
  it("a SplineMatrix reports the shape it was made with", () => {
    assert.equal(typeof SplineMatrix, "function");
    const m = new SplineMatrix(1, 1);
    assert.equal(m.rows, 1);
    assert.equal(m.cols, 1);
  });

  it("addRow / toDense / diagInverse / multiplyVector", () => {
    const m = spd3();
    assert.deepEqual(m.toDense(), [
      [4, -1, 0],
      [-1, 4, -1],
      [0, -1, 4],
    ]);
    assert.deepEqual(m.diagInverse, [0.25, 0.25, 0.25]);
    assert.deepEqual(m.multiplyVector([1, 2, 3]), [2, 4, 10]);
    assert.deepEqual(m.multiplyVector([1, 0, 0], null), [4, -1, 0]);
  });

  it("clone / transpose / multiply preserve dense layout", () => {
    const m = spd3();
    assert.deepEqual(m.clone().toDense(), m.toDense());
    assert.deepEqual(m.transpose().toDense(), [
      [4, -1, 0],
      [-1, 4, -1],
      [0, -1, 4],
    ]);
    assert.deepEqual(m.multiply(m).toDense(), [
      [17, -8, 1],
      [-8, 18, -8],
      [1, -8, 17],
    ]);
  });

  it("solve CG matches captured solution for Ax=b", () => {
    const m = spd3();
    const sol = [0, 0, 0];
    m.solve(sol, [1, 2, 3], 1e-10);
    assert.deepEqual(roundArr(sol), [0.4642857143, 0.8571428571, 0.9642857143]);
  });

  it("solveScalar SOR matches captured solution", () => {
    const m = spd3();
    const sol = [0, 0, 0];
    m.solveScalar(sol, [1, 2, 3], 1e-12, 5000);
    assert.deepEqual(roundArr(sol), [0.4642860527, 0.8571420882, 0.9642858343]);
  });

  it("solveVector3 RGB SOR matches captured solution", () => {
    const m = new SplineMatrix(2, 2);
    m.addRow([2, -1], [0, 1], 2);
    m.addRow([-1, 2], [0, 1], 2);
    const sol = [0, 0, 0, 0, 0, 0];
    m.solveVector3(sol, [1, 2, 3, 4, 5, 6], 1e-12, 5000);
    assert.deepEqual(
      roundArr(sol),
      [2.0000007253, 3.0000009752, 4.000001225, 3.0000003029, 4.0000003317, 5.0000003604],
    );
  });
});
