/**
 * Golden values for matrix-math (compositing).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { addMatrices, diagonalMatrix, formatMatrix, matrixRowMeans, multiplyMatrices, multiplyMatrixByVector, solveLinearSystem, subtractMatrices, swapRows, transposeMatrix, vectorMagnitude, zeroMatrix } from "../../../src/engine/compositing/matrix-math.js";


describe("matrix-math", () => {
  it("transpose / add / subtract goldens", () => {
    assert.deepEqual(transposeMatrix([[1, 2, 3], [4, 5, 6]]), [[1, 4], [2, 5], [3, 6]]);
    assert.deepEqual(subtractMatrices([[5, 5], [5, 5]], [[1, 2], [3, 4]]), [[4, 3], [2, 1]]);
    assert.deepEqual(addMatrices([[1, 2], [3, 4]], [[10, 20], [30, 40]]), [[11, 22], [33, 44]]);
  });

  it("multiply odd/even inner and multiplyVec goldens", () => {
    assert.deepEqual(
      multiplyMatrices([[1, 2, 3], [4, 5, 6]], [[7, 8], [9, 10], [11, 12]]),
      [[58, 64], [139, 154]],
    );
    assert.deepEqual(multiplyMatrices([[1, 2, 3]], [[1], [2], [3]]), [[14]]);
    assert.deepEqual(multiplyMatrixByVector([[1, 2], [3, 4]], [10, 20]), [50, 110]);
    assert.throws(
      () => multiplyMatrices([[1, 2, 3]], [[1, 2]]),
      /inner dimensions do not match/,
    );
  });

  it("zeros / diagonal / rowMeans / magnitude / format goldens", () => {
    assert.deepEqual(zeroMatrix(2, 3), [[0, 0, 0], [0, 0, 0]]);
    assert.deepEqual(diagonalMatrix([1, 2, 3]), [[1, 0, 0], [0, 2, 0], [0, 0, 3]]);
    assert.deepEqual(matrixRowMeans([[1, 2, 3], [4, 5, 6]]), [2, 5]);
    assert.equal(vectorMagnitude([3, 4]), 5);
    assert.equal(formatMatrix([[1, 2], [3, 4]]), "[1,2;3,4]");
  });

  it("solveLinearSystem and swapRows goldens", () => {
    const out = [0, 0];
    assert.equal(solveLinearSystem([[1, 1, 5], [2, -1, 1]], out), 0);
    assert.deepEqual(out, [2, 3]);
    const swapM = [[1, 2], [3, 4]];
    swapRows(swapM, 0, 1);
    assert.deepEqual(swapM, [[3, 4], [1, 2]]);
  });

  it("solveLinearSystem returns 1 for a singular system", () => {
    const out = [];
    assert.equal(solveLinearSystem([[1, 1, 2], [2, 2, 4]], out), 1);
  });
});
