/* global UZIP */
/**
 * Content-aware seam carving: edge energy, dynamic-programming cost matrices,
 * seam matching/propagation, and resize by removing or duplicating seams.
 *
 */

import { allocBuffer } from "./buffer-utils.js";
import { warpWithAffineParams } from "./homography.js";

const SEAM_MARK_BASE = 65280;
const HIGH_SEAM_COST = 1e9;
const SEAM_COST_SCALE = 1e-4;

function min2(a, b) {
  return a < b ? a : b;
}

/** Absolute RGB Manhattan distance between two pixels in an RGBA buffer. */
function channelDeltaAbs(srcPixels, pxA, neighborB) {
  const offA = pxA << 2;
  const offB = neighborB << 2;
  const dr = srcPixels[offA] - srcPixels[offB];
  const dg = srcPixels[offA + 1] - srcPixels[offB + 1];
  const db = srcPixels[offA + 2] - srcPixels[offB + 2];
  return Math.abs(dr) + Math.abs(dg) + Math.abs(db);
}

/**
 * Accumulate forward-difference edge energy into a width×height Uint16 buffer.
 * Left/right border columns are doubled; zero cells become 1.
 */
export function computeEdgeEnergy(srcPixels, srcWidth, srcHeight, energy) {
  for (let col = 1; col < srcWidth; col++) {
    const delta = channelDeltaAbs(srcPixels, col, col - 1);
    energy[col - 1] += delta;
    energy[col] += delta;
  }
  for (let row = 1; row < srcHeight; row++) {
    const rowOff = row * srcWidth;
    const delta = channelDeltaAbs(srcPixels, rowOff, rowOff - srcWidth);
    energy[rowOff] += delta;
    energy[rowOff - srcWidth] += delta;
    for (let col = 1; col < srcWidth; col++) {
      const off = row * srcWidth + col;
      const deltaX = channelDeltaAbs(srcPixels, off, off - 1);
      const deltaY = channelDeltaAbs(srcPixels, off, off - srcWidth);
      energy[off - srcWidth] += deltaY;
      energy[off - 1] += deltaX;
      energy[off] += deltaY + deltaX;
    }
  }
  for (let row = 0; row < srcHeight; row++) {
    energy[row * srcWidth] *= 2;
    energy[row * srcWidth + srcWidth - 1] *= 2;
  }
  for (let off = 0; off < energy.length; off++)
    if (energy[off] == 0) energy[off] = 1;
}

/** Partition srcWidth into bandCount contiguous column widths (last gets remainder). */
function fillBandWidths(bandWidths, srcWidth, bandCount) {
  const bandBase = Math.floor(srcWidth / bandCount);
  for (let bandIdx = 0; bandIdx < bandCount; bandIdx++) {
    bandWidths[bandIdx] = bandIdx < bandCount - 1 ? bandBase : srcWidth - (bandCount - 1) * bandBase;
  }
}

function sumEnergyPerBand(energy, srcWidth, srcHeight, bandWidths, bandEnergySum) {
  const bandCount = bandWidths.length;
  for (let row = 0; row < srcHeight; row++) {
    let rowOff = row * srcWidth;
    for (let bandIdx = 0; bandIdx < bandCount; bandIdx++) {
      const bandW = bandWidths[bandIdx];
      for (let col = 0; col < bandW; col++) bandEnergySum[bandIdx] += energy[rowOff + col];
      rowOff += bandW;
    }
  }
}

/** Bottom-up DP: minimum cumulative path cost from each cell to the bottom row. */
function buildDpCostMatrix(energy, dpCost, srcWidth, srcHeight, bandWidths) {
  const bandCount = bandWidths.length;
  for (let col = 0; col < srcWidth; col++) {
    dpCost[(srcHeight - 1) * srcWidth + col] = energy[(srcHeight - 1) * srcWidth + col];
  }
  for (let row = srcHeight - 2; row >= 0; row--) {
    let rowOff = row * srcWidth;
    for (let bandIdx = 0; bandIdx < bandCount; bandIdx++) {
      const bandW = bandWidths[bandIdx];
      dpCost[rowOff] = energy[rowOff] + Math.min(dpCost[rowOff + srcWidth], dpCost[rowOff + srcWidth + 1]);
      for (let col = 1; col < bandW - 1; col++) {
        const off = rowOff + col;
        dpCost[off] = energy[off] + Math.min(
          dpCost[off + srcWidth - 1],
          Math.min(dpCost[off + srcWidth], dpCost[off + srcWidth + 1]),
        );
      }
      rowOff += bandW - 1;
      dpCost[rowOff] = energy[rowOff] + Math.min(dpCost[rowOff + srcWidth - 1], dpCost[rowOff + srcWidth]);
      rowOff++;
    }
  }
}

function matchCost(seamCost, dpCost, seamIdx, dpOff) {
  const seamWeight = seamCost[seamIdx];
  const cellCost = dpCost[dpOff];
  return ~~(seamWeight * cellCost * SEAM_COST_SCALE);
}

/**
 * Propagate seam order/cost one row down using seamDir marks from the previous row.
 * Dir 1 = keep column; otherwise swap with the next column (cross).
 */
export function propagateSeam(row, width, seamDir, energy, seamOrder, seamCost) {
  let col = 0;
  let off = row * width;
  while (col < width) {
    if (seamDir[off - width] == 1) {
      seamCost[col] = seamCost[col] + energy[off];
      col++;
      off++;
    } else {
      const swap = seamOrder[col];
      seamOrder[col] = seamOrder[col + 1];
      seamOrder[col + 1] = swap;
      const costA = seamCost[col];
      seamCost[col] = seamCost[col + 1] + energy[off];
      seamCost[col + 1] = costA + energy[off + 1];
      col += 2;
      off += 2;
    }
  }
}

/**
 * Forward seam matching: fill seamDir for the previous row, then propagate costs.
 */
function matchSeamsForward(energy, dpCost, seamOrder, seamCost, seamDir, srcWidth, srcHeight, bandWidths) {
  const bandCount = bandWidths.length;
  const rowMatchCost = new Uint32Array(srcWidth);
  for (let col = 0; col < srcWidth; col++) {
    seamOrder[col] = col;
    seamCost[col] = energy[col];
  }
  for (let row = 1; row < srcHeight; row++) {
    let bandStart = 0;
    let rowOff = row * srcWidth;
    for (let bandIdx = 0; bandIdx < bandCount; bandIdx++) {
      const bandW = bandWidths[bandIdx];
      let off = rowOff;
      rowMatchCost[bandStart] = matchCost(seamCost, dpCost, bandStart, off);
      const diagPair = rowMatchCost[bandStart] + matchCost(seamCost, dpCost, bandStart + 1, off + 1);
      const crossPair = matchCost(seamCost, dpCost, bandStart, off + 1) + matchCost(seamCost, dpCost, bandStart + 1, off);
      rowMatchCost[bandStart + 1] = min2(diagPair, crossPair);
      for (let col = 2; col < bandW; col++) {
        off = rowOff + col;
        const leftPath = rowMatchCost[bandStart + col - 1] + matchCost(seamCost, dpCost, bandStart + col - 1, off - 1);
        const skipPath = rowMatchCost[bandStart + col - 2]
          + matchCost(seamCost, dpCost, bandStart + col - 1, off - 2)
          + matchCost(seamCost, dpCost, bandStart + col - 2, off - 1);
        rowMatchCost[bandStart + col] = min2(leftPath, skipPath);
      }
      let col = bandW - 1;
      while (col >= 2) {
        off = rowOff + col;
        const leftPath = rowMatchCost[bandStart + col - 1] + matchCost(seamCost, dpCost, bandStart + col - 1, off - 1);
        const skipPath = rowMatchCost[bandStart + col - 2]
          + matchCost(seamCost, dpCost, bandStart + col - 1, off - 2)
          + matchCost(seamCost, dpCost, bandStart + col - 2, off - 1);
        if (rowMatchCost[bandStart + col] == leftPath) {
          seamDir[off - srcWidth] = 1;
          col -= 1;
        } else {
          seamDir[off - srcWidth] = 0;
          seamDir[off - srcWidth - 1] = 2;
          col -= 2;
        }
      }
      off = rowOff;
      if (col == 0) {
        seamDir[off - srcWidth] = 1;
      } else if (rowMatchCost[bandStart + 1] == diagPair) {
        seamDir[off + 1 - srcWidth] = 1;
        seamDir[off - srcWidth] = 1;
      } else {
        seamDir[off + 1 - srcWidth] = 0;
        seamDir[off - srcWidth] = 2;
      }
      rowOff += bandW;
      bandStart += bandW;
    }
    propagateSeam(row, srcWidth, seamDir, energy, seamOrder, seamCost);
  }
}

/**
 * Cost bundle tuple consumed by applySeams / resize:
 * [checksum, pixels, width, height, bandCount, bandWidths, bandEnergySum,
 *  seamOrder, seamCost, seamDir, edgeEnergy]
 */
export function computeCostMatrix(srcPixels, srcWidth, srcHeight) {
  const energy = new Uint16Array(srcWidth * srcHeight);
  const bandCount = 1;
  computeEdgeEnergy(srcPixels, srcWidth, srcHeight, energy);
  const bandEnergySum = new Uint32Array(bandCount);
  const bandWidths = new Uint32Array(bandCount);
  fillBandWidths(bandWidths, srcWidth, bandCount);
  sumEnergyPerBand(energy, srcWidth, srcHeight, bandWidths, bandEnergySum);
  const seamOrder = new Uint32Array(srcWidth);
  const seamCost = new Uint32Array(srcWidth);
  const dpCost = new Uint32Array(srcWidth * srcHeight);
  buildDpCostMatrix(energy, dpCost, srcWidth, srcHeight, bandWidths);
  const seamDir = new Uint8Array(srcWidth * srcHeight);
  matchSeamsForward(energy, dpCost, seamOrder, seamCost, seamDir, srcWidth, srcHeight, bandWidths);
  return [
    UZIP.adler(srcPixels, 0, srcPixels.length),
    srcPixels,
    srcWidth,
    srcHeight,
    bandCount,
    bandWidths,
    bandEnergySum,
    seamOrder,
    seamCost,
    seamDir,
    energy,
  ];
}

function copyRgbaPixel(dstPixels, srcPixels, dstIdx, srcIdx) {
  const dstOff = dstIdx << 2;
  const srcOff = srcIdx << 2;
  dstPixels[dstOff] = srcPixels[srcOff];
  dstPixels[dstOff + 1] = srcPixels[srcOff + 1];
  dstPixels[dstOff + 2] = srcPixels[srcOff + 2];
  dstPixels[dstOff + 3] = srcPixels[srcOff + 3];
}

/** Mark the lowest-cost seams (remove) or inflate costs (insert) into edgeEnergy. */
function selectAndMarkSeams(srcWidth, srcHeight, bandCount, bandWidths, seamOrder, seamCost, seamDir, edgeEnergy, targetWidth) {
  const seamDelta = Math.abs(srcWidth - targetWidth);
  const seamsPerBand = Math.floor(seamDelta / bandCount);
  const bandSeamCounts = new Uint32Array(bandCount);
  for (let bandIdx = 0; bandIdx < bandCount; bandIdx++) {
    bandSeamCounts[bandIdx] = bandIdx < bandCount - 1 ? seamsPerBand : seamDelta - (bandCount - 1) * seamsPerBand;
  }
  edgeEnergy.fill(0);
  let bandOff = 0;
  for (let bandIdx = 0; bandIdx < bandCount; bandIdx++) {
    const bandW = bandWidths[bandIdx];
    const bandSeams = bandSeamCounts[bandIdx];
    for (let seamIdx = 0; seamIdx < bandSeams; seamIdx++) {
      let bestCol = 0;
      let bestCost = HIGH_SEAM_COST;
      for (let col = 0; col < bandW; col++) {
        if (seamCost[bandOff + col] < bestCost) {
          bestCost = seamCost[bandOff + col];
          bestCol = bandOff + col;
        }
      }
      if (targetWidth < srcWidth) seamCost[bestCol] = HIGH_SEAM_COST;
      else seamCost[bestCol] *= 1.2;
      let seamX = seamOrder[bestCol];
      const mark = edgeEnergy[seamX];
      const nextMark = mark < SEAM_MARK_BASE ? SEAM_MARK_BASE : mark + 1;
      if (nextMark < SEAM_MARK_BASE) throw new Error("seam mark counter overflow");
      for (let row = 0; row < srcHeight; row++) {
        const off = row * srcWidth + seamX;
        edgeEnergy[off] = nextMark;
        seamX += seamDir[off] - 1;
      }
    }
    bandOff += bandW;
  }
}

function copyPixelsWithSeamMarks(srcPixels, dstPixels, srcWidth, srcHeight, targetWidth, edgeEnergy) {
  for (let row = 0; row < srcHeight; row++) {
    let srcCol = 0;
    const rowOff = row * srcWidth;
    for (let dstCol = 0; dstCol < targetWidth; dstCol++, srcCol++) {
      if (targetWidth < srcWidth) {
        while (edgeEnergy[rowOff + srcCol] == SEAM_MARK_BASE) srcCol++;
        copyRgbaPixel(dstPixels, srcPixels, row * targetWidth + dstCol, row * srcWidth + srcCol);
      } else {
        copyRgbaPixel(dstPixels, srcPixels, row * targetWidth + dstCol, row * srcWidth + srcCol);
        while (edgeEnergy[rowOff + srcCol] >= SEAM_MARK_BASE) {
          edgeEnergy[rowOff + srcCol]--;
          dstCol++;
          copyRgbaPixel(dstPixels, srcPixels, row * targetWidth + dstCol, row * srcWidth + srcCol);
        }
      }
    }
  }
}

export function applySeams(costBundle, targetWidth, dstPixels) {
  const parts = costBundle.slice(0);
  parts.shift();
  const srcPixels = parts.shift();
  const srcWidth = parts.shift();
  const srcHeight = parts.shift();
  const bandCount = parts.shift();
  const bandWidths = parts.shift();
  parts.shift();
  const seamOrder = parts.shift();
  const seamCost = parts.shift().slice(0);
  const seamDir = parts.shift();
  const edgeEnergy = parts.shift();
  selectAndMarkSeams(srcWidth, srcHeight, bandCount, bandWidths, seamOrder, seamCost, seamDir, edgeEnergy, targetWidth);
  copyPixelsWithSeamMarks(srcPixels, dstPixels, srcWidth, srcHeight, targetWidth, edgeEnergy);
}

export function computeSeams(srcPixels, srcWidth, srcHeight) {
  const transposedBuf = allocBuffer(srcWidth * srcHeight * 4);
  warpWithAffineParams(
    srcPixels, srcWidth, srcHeight, transposedBuf,
    [srcHeight, srcWidth, 0, 1, 0, 1, 0, 0],
  );
  return [
    computeCostMatrix(srcPixels, srcWidth, srcHeight),
    computeCostMatrix(transposedBuf, srcHeight, srcWidth),
  ];
}

export function resize(costBundles, targetRect) {
  let primaryBundle = costBundles[0];
  const secondaryBundle = costBundles[1];
  let outPixels = primaryBundle[1];
  const srcWidth = primaryBundle[2];
  const srcHeight = primaryBundle[3];
  const targetWidth = targetRect.width;
  const targetHeight = targetRect.height;
  if (srcWidth == targetWidth && srcHeight == targetHeight) {
    outPixels = outPixels.slice(0);
  } else if (srcHeight != targetHeight) {
    const heightSeamBuf = allocBuffer(srcWidth * targetHeight * 4);
    applySeams(secondaryBundle, targetHeight, heightSeamBuf);
    outPixels = allocBuffer(srcWidth * targetHeight * 4);
    warpWithAffineParams(
      heightSeamBuf, targetHeight, srcWidth, outPixels,
      [srcWidth, targetHeight, 0, 1, 0, 1, 0, 0],
    );
    if (srcWidth != targetWidth) {
      primaryBundle = computeCostMatrix(outPixels, srcWidth, targetHeight);
      outPixels = allocBuffer(targetWidth * targetHeight * 4);
      applySeams(primaryBundle, targetWidth, outPixels);
    }
  } else if (srcWidth != targetWidth) {
    outPixels = allocBuffer(targetWidth * srcHeight * 4);
    applySeams(primaryBundle, targetWidth, outPixels);
  }
  return outPixels;
}

