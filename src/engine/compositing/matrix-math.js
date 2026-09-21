/**
 * Dense-matrix linear algebra: build and solve linear systems (Gaussian
 * elimination), transpose, multiply, and vector helpers. Used for homography
 * fitting, path-deformation solving, and curve fitting.
 */

function allocateDenseMatrix(rows, cols) {
  const result = new Array(rows);
  for (let row = 0; row < rows; row++) {
    result[row] = new Array(cols);
  }
  return result;
}

function elementwiseBinary(matrixA, matrixB, combine) {
  const rows = matrixA.length;
  const cols = matrixA[0].length;
  const result = allocateDenseMatrix(rows, cols);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      result[row][col] = combine(matrixA[row][col], matrixB[row][col]);
    }
  }
  return result;
}

function multiplyOddInner(matrixA, matrixB, rows, cols, inner) {
  const result = allocateDenseMatrix(rows, cols);
  for (let row = 0; row < rows; row++) {
    const rowA = matrixA[row];
    const resultRow = result[row];
    for (let col = 0; col < cols; col++) {
      let sum = 0;
      for (let k = 0; k < inner; k++) {
        sum += rowA[k] * matrixB[k][col];
      }
      resultRow[col] = sum;
    }
  }
  return result;
}

function multiplyEvenInner(matrixA, matrixB, rows, cols, inner) {
  const result = allocateDenseMatrix(rows, cols);
  for (let row = 0; row < rows; row++) {
    const rowA = matrixA[row];
    const resultRow = result[row];
    for (let col = 0; col < cols; col++) {
      let sum = 0;
      for (let k = 0; k < inner; k += 2) {
        sum += rowA[k] * matrixB[k][col] + rowA[k + 1] * matrixB[k + 1][col];
      }
      resultRow[col] = sum;
    }
  }
  return result;
}

export function transposeMatrix(matrix) {
  const rows = matrix.length;
  const cols = matrix[0].length;
  const result = allocateDenseMatrix(cols, rows);
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      result[col][row] = matrix[row][col];
    }
  }
  return result;
}

export function subtractMatrices(matrixA, matrixB) {
  return elementwiseBinary(matrixA, matrixB, function (left, right) {
    return left - right;
  });
}

export function addMatrices(matrixA, matrixB) {
  return elementwiseBinary(matrixA, matrixB, function (left, right) {
    return left + right;
  });
}

export function multiplyMatrices(matrixA, matrixB) {
  const rows = matrixA.length;
  const inner = matrixA[0].length;
  const cols = matrixB[0].length;
  if (inner != matrixB.length) {
    throw new Error("matrixMath.multiply: inner dimensions do not match");
  }
  if ((inner & 1) != 0) {
    return multiplyOddInner(matrixA, matrixB, rows, cols, inner);
  }
  return multiplyEvenInner(matrixA, matrixB, rows, cols, inner);
}

export function multiplyMatrixByVector(matrix, vec) {
  const rows = matrix.length;
  const cols = matrix[0].length;
  const result = new Array(rows);
  for (let row = 0; row < rows; row++) {
    let sum = 0;
    for (let col = 0; col < cols; col++) {
      sum += matrix[row][col] * vec[col];
    }
    result[row] = sum;
  }
  return result;
}

export function zeroMatrix(rows, cols) {
  const result = [];
  for (let row = 0; row < rows; row++) {
    result.push([]);
    for (let col = 0; col < cols; col++) {
      result[row].push(0);
    }
  }
  return result;
}

export function formatMatrix(matrix) {
  const rowStrings = [];
  for (let row = 0; row < matrix.length; row++) {
    rowStrings.push(matrix[row].join(","));
  }
  return "[" + rowStrings.join(";") + "]";
}

export function solveLinearSystem(augmented, out) {
  const size = augmented.length;
  for (let col = 0; col < size; col++) {
    let pivotRow = 0;
    let maxAbs = Number.NEGATIVE_INFINITY;
    for (let row = col; row < size; row++) {
      if (Math.abs(augmented[row][col]) > maxAbs) {
        pivotRow = row;
        maxAbs = Math.abs(augmented[row][col]);
      }
    }
    swapRows(augmented, col, pivotRow);
    for (let row = col + 1; row < size; row++) {
      if (augmented[col][col] == 0) {
        return 1;
      }
      const factor = augmented[row][col] / augmented[col][col];
      for (let coeffIdx = col; coeffIdx < size + 1; coeffIdx++) {
        augmented[row][coeffIdx] -= augmented[col][coeffIdx] * factor;
      }
    }
  }
  for (let row = size - 1; row >= 0; row--) {
    if (augmented[row][row] == 0) {
      return 1;
    }
    const value = augmented[row][size] / augmented[row][row];
    out[row] = value;
    for (let coeffIdx = row - 1; coeffIdx >= 0; coeffIdx--) {
      augmented[coeffIdx][size] -= augmented[coeffIdx][row] * value;
      augmented[coeffIdx][row] = 0;
    }
  }
  return 0;
}

export function swapRows(matrix, rowA, rowB) {
  const tmp = matrix[rowA];
  matrix[rowA] = matrix[rowB];
  matrix[rowB] = tmp;
}

export function diagonalMatrix(vec) {
  const size = vec.length;
  const result = zeroMatrix(size, size);
  for (let idx = 0; idx < size; idx++) {
    result[idx][idx] = vec[idx];
  }
  return result;
}

export function matrixRowMeans(matrix) {
  const rows = matrix.length;
  const cols = matrix[0].length;
  const result = new Array(rows);
  for (let row = 0; row < rows; row++) {
    result[row] = 0;
    for (let col = 0; col < cols; col++) {
      result[row] += matrix[row][col];
    }
    result[row] /= cols;
  }
  return result;
}

export function vectorMagnitude(vec) {
  let sumSquares = 0;
  for (let idx = 0; idx < vec.length; idx++) {
    sumSquares += vec[idx] * vec[idx];
  }
  return Math.sqrt(sumSquares);
}
