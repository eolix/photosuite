/**
 * CSR sparse matrix with conjugate-gradient and SOR solvers.
 * Used by content-aware fill and path constraint solves.
 */

/** SOR over-relaxation factor shared by scalar and RGB solvers. */
const SOR_RELAXATION = 1.96;

function subtractScaled(dest, matVec, scale, out) {
  const len = dest.length;
  for (let i = 0; i < len; i++) out[i] = dest[i] - matVec[i] * scale
}

function addScaled(dest, direction, scale, out) {
  const len = dest.length;
  let idx = 0;
  while ((len - idx & 3) != 0) {
    out[idx] = dest[idx] + direction[idx] * scale;
    idx++
  }
  for (let i = idx; i < len; i += 4) {
    out[i] = dest[i] + direction[i] * scale;
    out[i + 1] = dest[i + 1] + direction[i + 1] * scale;
    out[i + 2] = dest[i + 2] + direction[i + 2] * scale;
    out[i + 3] = dest[i + 3] + direction[i + 3] * scale
  }
}

function multiplyDiagonal(diagInv, vec, out) {
  const len = vec.length;
  for (let i = 0; i < len; i++) out[i] = diagInv[i] * vec[i]
}

function dotProduct(a, b) {
  const len = a.length;
  let idx = 0;
  let sum = 0;
  while ((len - idx & 3) != 0) {
    sum += a[idx] * b[idx];
    idx++
  }
  for (let i = idx; i < len; i += 4) {
    sum += a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2] + a[i + 3] * b[i + 3]
  }
  return sum
}

/**
 * Compressed sparse row matrix with diagonal bookkeeping for SOR/CG.
 * @param {number} rowCount
 * @param {number} colCount
 */
export function SplineMatrix(rowCount, colCount) {
  this.values = [];
  this.rowPtr = [0];
  this.colIndices = [];
  this.offDiagValues = [];
  this.offDiagRowPtr = [0];
  this.offDiagColIndices = [];
  this.diagInverse = [];
  this.rows = rowCount;
  this.cols = colCount
}

function installSplineMatrixPrototype() {
  SplineMatrix.prototype.clone = function () {
    const source = this;
    const rowCount = source.rows;
    const colCount = source.cols;
    const copy = new SplineMatrix(rowCount, colCount);
    copy.values = source.values.slice(0);
    copy.rowPtr = source.rowPtr.slice(0);
    copy.colIndices = source.colIndices.slice(0);
    copy.offDiagValues = source.offDiagValues.slice(0);
    copy.offDiagRowPtr = source.offDiagRowPtr.slice(0);
    copy.offDiagColIndices = source.offDiagColIndices.slice(0);
    copy.diagInverse = source.diagInverse.slice(0);
    return copy
  };

  SplineMatrix.prototype.addRow = function (rowValues, colIndices, entryCount) {
    const rowIndex = this.rowPtr.length - 1;
    for (let i = 0; i < entryCount; i++) {
      const value = rowValues[i];
      let col = colIndices[i];
      this.values.push(value);
      this.colIndices.push(col);
      if (col == rowIndex) {
        this.diagInverse.push(value == 0 ? 0 : 1 / value)
      } else {
        this.offDiagValues.push(value);
        this.offDiagColIndices.push(col)
      }
    }
    this.rowPtr.push(this.values.length);
    this.offDiagRowPtr.push(this.offDiagValues.length)
  };

  SplineMatrix.prototype.multiplyVector = function (vec, out) {
    const matrix = this;
    const rowCount = matrix.rows;
    const values = matrix.values;
    const colIndices = matrix.colIndices;
    if (out == null) out = new Array(rowCount);
    for (let row = 0; row < rowCount; row++) {
      let start = matrix.rowPtr[row];
      const end = matrix.rowPtr[row + 1];
      let sum = 0;
      while ((end - start & 3) != 0) {
        sum += values[start] * vec[colIndices[start]];
        start++
      }
      for (let idx = start; idx < end; idx += 4) {
        sum += values[idx] * vec[colIndices[idx]] + values[idx + 1] * vec[colIndices[idx + 1]] +
          values[idx + 2] * vec[colIndices[idx + 2]] + values[idx + 3] * vec[colIndices[idx + 3]]
      }
      out[row] = sum
    }
    return out
  };

  SplineMatrix.prototype.multiply = function (right) {
    return this.multiplySparse(right.transpose())
  };

  /** Product when right stores rows of A^T (merge-join on column indices). */
  SplineMatrix.prototype.multiplySparse = function (right) {
    const left = this;
    const leftRows = left.rows;
    const rightRows = right.rows;
    const product = new SplineMatrix(leftRows, rightRows);
    const leftColsIdx = left.colIndices;
    const rightColsIdx = right.colIndices;
    for (let row = 0; row < leftRows; row++) {
      const rowValues = [];
      const rowColIndices = [];
      const leftStart = left.rowPtr[row];
      const leftEnd = left.rowPtr[row + 1];
      for (let rightRow = 0; rightRow < rightRows; rightRow++) {
        const rightStart = right.rowPtr[rightRow];
        const rightEnd = right.rowPtr[rightRow + 1];
        let dot = 0;
        let leftIdx = leftStart;
        let rightIdx = rightStart;
        while (leftIdx < leftEnd && rightIdx < rightEnd) {
          const minCol = Math.max(leftColsIdx[leftIdx], rightColsIdx[rightIdx]);
          while (leftIdx < leftEnd && leftColsIdx[leftIdx] < minCol) leftIdx++;
          while (rightIdx < rightEnd && rightColsIdx[rightIdx] < minCol) rightIdx++;
          if (leftIdx < leftEnd && rightIdx < rightEnd && leftColsIdx[leftIdx] == rightColsIdx[rightIdx]) {
            dot += left.values[leftIdx++] * right.values[rightIdx++]
          }
        }
        if (dot != 0) {
          rowValues.push(dot);
          rowColIndices.push(rightRow)
        }
      }
      product.addRow(rowValues, rowColIndices, rowValues.length)
    }
    return product
  };

  SplineMatrix.prototype.transpose = function () {
    const rowCount = this.rows;
    const colCount = this.cols;
    const buckets = [];
    for (let col = 0; col < colCount; col++) buckets.push([[], []]);
    const values = this.values;
    const rowPtr = this.rowPtr;
    const colIndices = this.colIndices;
    for (let row = 0; row < rowCount; row++) {
      let start = rowPtr[row];
      const end = rowPtr[row + 1];
      for (let idx = start; idx < end; idx++) {
        const bucket = buckets[colIndices[idx]];
        bucket[0].push(values[idx]);
        bucket[1].push(row)
      }
    }
    const transposed = new SplineMatrix(colCount, rowCount);
    for (let col = 0; col < colCount; col++) transposed.addRow(buckets[col][0], buckets[col][1], buckets[col][1].length);
    return transposed
  };

  SplineMatrix.prototype.toDense = function () {
    const rowCount = this.rows;
    const colCount = this.cols;
    const dense = new Array(rowCount);
    const values = this.values;
    const rowPtr = this.rowPtr;
    const colIndices = this.colIndices;
    for (let row = 0; row < rowCount; row++) {
      const denseRow = dense[row] = new Array(colCount);
      for (let col = 0; col < colCount; col++) denseRow[col] = 0;
      let start = rowPtr[row];
      const end = rowPtr[row + 1];
      for (let idx = start; idx < end; idx++) denseRow[colIndices[idx]] = values[idx]
    }
    return dense
  };

  /** Conjugate gradient (optional Jacobi / custom preconditioner). Mutates solution. */
  SplineMatrix.prototype.solve = function (solution, rhs, tolerance, preconditioner, smoother) {
    const usePreconditioner = preconditioner != null ? 2 : 1;
    let iter = 0;
    const matrix = this;
    const residual = solution.slice(0);
    const matTimesSolution = solution.slice(0);
    matrix.multiplyVector(solution, matTimesSolution);
    subtractScaled(rhs, matTimesSolution, 1, residual);
    let diagInv = this.diagInverse;
    if (usePreconditioner == 0) {
      diagInv = residual.slice(0);
      diagInv.fill(1)
    }
    const searchDir = residual.slice(0);
    multiplyDiagonal(diagInv, residual, searchDir);
    const prevSearchDir = searchDir.slice(0);
    let residualDot = dotProduct(residual, searchDir);
    const maxIterations = solution.length + 64;
    while (iter < maxIterations) {
      matrix.multiplyVector(prevSearchDir, matTimesSolution);
      const stepDenominator = dotProduct(prevSearchDir, matTimesSolution);
      if (stepDenominator == 0) break;
      const step = residualDot / stepDenominator;
      addScaled(solution, prevSearchDir, step, solution);
      subtractScaled(residual, matTimesSolution, step, residual);
      if ((iter & 7) == 0 && Math.sqrt(dotProduct(residual, residual)) < tolerance) break;
      if (usePreconditioner <= 1) multiplyDiagonal(diagInv, residual, searchDir);
      else {
        const smoothed = residual.slice(0);
        preconditioner.aiT(smoothed, residual);
        smoother.afm(searchDir, smoothed)
      }
      const newResidualDot = dotProduct(residual, searchDir);
      const beta = newResidualDot / residualDot;
      addScaled(searchDir, prevSearchDir, beta, prevSearchDir);
      residualDot = newResidualDot;
      iter++
    }
  };

  /** Scalar SOR; mutates solution. */
  SplineMatrix.prototype.solveScalar = function (solution, rhs, tolerance, timeLimitMs) {
    const startMs = Date.now();
    const relaxation = SOR_RELAXATION;
    if (tolerance == null) tolerance = 5e-6;
    if (timeLimitMs == null) timeLimitMs = 1e9;
    const damp = 1 - relaxation;
    const rowCount = this.rows;
    const offDiagValues = this.offDiagValues;
    const offDiagRowPtr = this.offDiagRowPtr;
    const offDiagColIndices = this.offDiagColIndices;
    const diagInverse = this.diagInverse;
    while (true) {
      let deltaSqSum = 0;
      for (let row = 0; row < rowCount; row++) {
        let adjustedRhs = rhs[row];
        const offStart = offDiagRowPtr[row];
        const offEnd = offDiagRowPtr[row + 1];
        if (offEnd - offStart == 4) {
          adjustedRhs -= offDiagValues[offStart] * solution[offDiagColIndices[offStart]] +
            offDiagValues[offStart + 1] * solution[offDiagColIndices[offStart + 1]] +
            offDiagValues[offStart + 2] * solution[offDiagColIndices[offStart + 2]] +
            offDiagValues[offStart + 3] * solution[offDiagColIndices[offStart + 3]]
        } else {
          for (let offIdx = offStart; offIdx < offEnd; offIdx++) {
            adjustedRhs -= offDiagValues[offIdx] * solution[offDiagColIndices[offIdx]]
          }
        }
        const next = solution[row] * damp + diagInverse[row] * adjustedRhs * relaxation;
        const delta = next - solution[row];
        deltaSqSum += delta * delta;
        solution[row] = next
      }
      if (deltaSqSum / rowCount < tolerance || Date.now() > startMs + timeLimitMs) break
    }
  };

  /** Interleaved RGB SOR (3 values per row); mutates solution. */
  SplineMatrix.prototype.solveVector3 = function (solution, rhs, tolerance, timeLimitMs) {
    const startMs = Date.now();
    const relaxation = SOR_RELAXATION;
    if (tolerance == null) tolerance = 5e-5;
    if (timeLimitMs == null) timeLimitMs = 1e9;
    const damp = 1 - relaxation;
    const rowCount = this.rows;
    const offDiagValues = this.offDiagValues;
    const offDiagRowPtr = this.offDiagRowPtr;
    const offDiagColIndices = this.offDiagColIndices;
    const diagInverse = this.diagInverse;
    while (true) {
      let weightedDeltaSq = 0;
      for (let row = 0; row < rowCount; row++) {
        const baseIdx = row * 3;
        let rhs0 = rhs[baseIdx];
        let rhs1 = rhs[baseIdx + 1];
        let rhs2 = rhs[baseIdx + 2];
        const offStart = offDiagRowPtr[row];
        const offEnd = offDiagRowPtr[row + 1];
        for (let offIdx = offStart; offIdx < offEnd; offIdx++) {
          const coeff = offDiagValues[offIdx];
          const colBase = offDiagColIndices[offIdx] * 3;
          rhs0 -= coeff * solution[colBase + 0];
          rhs1 -= coeff * solution[colBase + 1];
          rhs2 -= coeff * solution[colBase + 2]
        }
        const scale = diagInverse[row] * relaxation;
        const next0 = solution[baseIdx + 0] * damp + rhs0 * scale;
        const next1 = solution[baseIdx + 1] * damp + rhs1 * scale;
        const next2 = solution[baseIdx + 2] * damp + rhs2 * scale;
        const delta0 = next0 - solution[baseIdx + 0];
        const delta1 = next1 - solution[baseIdx + 1];
        const delta2 = next2 - solution[baseIdx + 2];
        weightedDeltaSq += .4 * delta0 * delta0 + .5 * delta1 * delta1 + .1 * delta2 * delta2;
        solution[baseIdx + 0] = next0;
        solution[baseIdx + 1] = next1;
        solution[baseIdx + 2] = next2
      }
      if (weightedDeltaSq / rowCount < tolerance || Date.now() > startMs + timeLimitMs) break
    }
  };
}

installSplineMatrixPrototype();
