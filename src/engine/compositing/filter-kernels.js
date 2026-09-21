/**
 * Filter kernels: clouds noise, fragment downsample, diffuse dither,
 * wind, sharpen edges, despeckle, diffuse noise, and a 1-indexed min-heap
 * used by path rendering.
 */

import { Rect } from "../../core/math/rect.js";
import { convolveRGBA, findEdgesChannel, presetKernels } from "./spatial-filters.js";
import { filter } from "./diffuse.js";

const DIFFUSE_DITHER_LUT = [
  -1e3, 34, 51, 61, 71, 80, 87, 95, 101, 108, 113, 119, 124, 129, 134, 139, 143,
  148, 153, 157, 161, 165, 168, 172, 175, 180, 183, 186, 190, 194, 197, 200, 203,
  207, 210, 213, 216, 218, 222, 225, 228, 230, 233, 236, 239, 241, 244, 247, 250,
  252, 255,
];

const CLOUDS_GRAD_DIR_X = [1, -1, 1, -1, 1, -1, 0, 0];
const CLOUDS_GRAD_DIR_Y = [1, 1, -1, -1, 0, 0, 1, -1];

// ---------------------------------------------------------------------------
// Clouds (Perlin octaves) — perm table shuffled once at factory init
// ---------------------------------------------------------------------------

function fadeCurve(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerpScalar(a, b, t) {
  return (1 - t) * a + t * b;
}

function bitwiseAnd(a, b) {
  return a & b;
}

function modWrap(a, b) {
  return a % b;
}

function writeGrayByte(buf, off, value) {
  buf[off] = value;
}

/**
 * Build a clouds-noise renderer. Shuffles the permutation table once with
 * Math.random (same timing as the previous factory IIFE).
 * @returns {(dst: unknown, width: number, height: number, outGray: Uint8Array, seedFloat: number) => void}
 */
export function createCloudsNoiseRenderer() {
  const permTable = [];
  const gradHash = new Uint8Array(512);
  const gradX = new Float32Array(512);
  const gradY = new Float32Array(512);

  for (let shuffleIdx = 0; shuffleIdx < 256; shuffleIdx++) {
    permTable[shuffleIdx] = shuffleIdx;
  }
  let shuffleIdx = 256;
  while (shuffleIdx != 0) {
    shuffleIdx--;
    const swapIdx = Math.floor(Math.random() * shuffleIdx);
    permTable[swapIdx] ^= permTable[shuffleIdx] ^ (permTable[shuffleIdx] = permTable[swapIdx]);
  }

  function seedPermutation(seedFloat) {
    seedFloat = Math.floor(seedFloat * 65536);
    if (seedFloat < 256) {
      seedFloat |= seedFloat << 8;
    }
    for (let tableIdx = 0; tableIdx < 256; tableIdx++) {
      const mirrorIdx = tableIdx + 256;
      let hash = permTable[tableIdx] ^ (tableIdx & 1 ? seedFloat : seedFloat >> 8) & 255;
      gradHash[tableIdx] = gradHash[mirrorIdx] = hash;
      hash = hash % 8;
      gradX[tableIdx] = gradX[mirrorIdx] = CLOUDS_GRAD_DIR_X[hash];
      gradY[tableIdx] = gradY[mirrorIdx] = CLOUDS_GRAD_DIR_Y[hash];
    }
  }

  function perlinAt(x, y, wrapX, wrapY, wrapFn) {
    let gridX = Math.floor(x);
    let gridY = Math.floor(y);
    x = x - gridX;
    y = y - gridY;
    gridX = gridX & 255;
    gridY = gridY & 255;
    let gradIdx = gridX + gradHash[gridY];
    const corner00 = gradX[gradIdx] * x + gradY[gradIdx] * y;
    gradIdx = gridX + gradHash[wrapFn(gridY + 1, wrapY)];
    const corner01 = gradX[gradIdx] * x + gradY[gradIdx] * (y - 1);
    gradIdx = wrapFn(gridX + 1, wrapX) + gradHash[gridY];
    const corner10 = gradX[gradIdx] * (x - 1) + gradY[gradIdx] * y;
    gradIdx = wrapFn(gridX + 1, wrapX) + gradHash[wrapFn(gridY + 1, wrapY)];
    const corner11 = gradX[gradIdx] * (x - 1) + gradY[gradIdx] * (y - 1);
    const fadeX = fadeCurve(x);
    return lerpScalar(lerpScalar(corner00, corner10, fadeX), lerpScalar(corner01, corner11, fadeX), fadeCurve(y));
  }

  /** @param {*} dst Ignored: the noise is written to `outGray`. */
  function renderCloudsNoise(dst, width, height, outGray, seedFloat) {
    const octaveBase = Math.min(Math.min(width, 256), Math.min(256, height));
    const usePowerOfTwoWrap = octaveBase == 256 || octaveBase < 8;
    const octaveCount = 8;
    const wrapMaskX = new Uint32Array(octaveCount);
    const wrapMaskY = new Uint32Array(octaveCount);
    const octaveWeight = new Float32Array(octaveCount);
    const octaveScale = new Float32Array(octaveCount);
    let weight = 1;
    let freq = 1;
    const wrapFn = usePowerOfTwoWrap ? bitwiseAnd : modWrap;
    let scale;
    for (let octaveIdx = 0; octaveIdx < octaveCount; octaveIdx++) {
      scale = freq * 1 / octaveBase;
      if (usePowerOfTwoWrap) {
        wrapMaskY[octaveIdx] = (1 << Math.ceil(Math.log2(height * scale))) - 1;
        wrapMaskX[octaveIdx] = (1 << Math.ceil(Math.log2(width * scale))) - 1;
      } else {
        wrapMaskY[octaveIdx] = scale * height;
        wrapMaskX[octaveIdx] = scale * width;
      }
      octaveWeight[octaveIdx] = weight;
      octaveScale[octaveIdx] = scale;
      weight *= 0.5;
      freq = freq << 1;
    }
    const noiseSeed = typeof seedFloat === "number" && !isNaN(seedFloat) ? seedFloat : Math.random();
    seedPermutation(noiseSeed);
    for (let row = 0, dstOff = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        let noiseSum = 0;
        for (let octaveIdx = 0; octaveIdx < octaveCount; octaveIdx++) {
          scale = octaveScale[octaveIdx];
          noiseSum +=
            perlinAt(col * scale, row * scale, wrapMaskX[octaveIdx], wrapMaskY[octaveIdx], wrapFn) *
            octaveWeight[octaveIdx];
        }
        writeGrayByte(outGray, dstOff++, Math.round(Math.max(0, 255 * Math.min(1, 0.5 + noiseSum * 0.5))));
      }
    }
  }

  return renderCloudsNoise;
}

// ---------------------------------------------------------------------------
// Fragment box downsample (4-corner average)
// ---------------------------------------------------------------------------

export function applyFragmentBoxDownsample(src, width, height, dst, options) {
  const radius = options && options[0] ? options[0] : 4;
  for (let row = 0; row < height; row++) {
    const rowMin = Math.max(row - radius, 0);
    const rowMax = Math.min(row + radius, height - 1);
    for (let col = 0; col < width; col++) {
      const colMin = Math.max(col - radius, 0);
      const colMax = Math.min(col + radius, width - 1);
      let srcOff = (rowMin * width + colMin) << 2;
      let rSum = src[srcOff];
      let gSum = src[srcOff + 1];
      let bSum = src[srcOff + 2];
      let aSum = src[srcOff + 3];
      srcOff = (rowMin * width + colMax) << 2;
      rSum += src[srcOff];
      gSum += src[srcOff + 1];
      bSum += src[srcOff + 2];
      aSum += src[srcOff + 3];
      srcOff = (rowMax * width + colMin) << 2;
      rSum += src[srcOff];
      gSum += src[srcOff + 1];
      bSum += src[srcOff + 2];
      aSum += src[srcOff + 3];
      srcOff = (rowMax * width + colMax) << 2;
      rSum += src[srcOff];
      gSum += src[srcOff + 1];
      bSum += src[srcOff + 2];
      aSum += src[srcOff + 3];
      const dstOff = (row * width + col) << 2;
      dst[dstOff] = (rSum + 2) >>> 2;
      dst[dstOff + 1] = (gSum + 2) >>> 2;
      dst[dstOff + 2] = (bSum + 2) >>> 2;
      dst[dstOff + 3] = (aSum + 2) >>> 2;
    }
  }
}

// ---------------------------------------------------------------------------
// Diffuse dither
// ---------------------------------------------------------------------------

export function createDiffuseDither() {
  function applyDiffuseDither(gray, width, height, outMask, options) {
    const strength = options[0];
    const amountIdx = options[1];
    const thresholdScale =
      amountIdx <= 50
        ? DIFFUSE_DITHER_LUT[amountIdx] / 255
        : 1 + (255 - DIFFUSE_DITHER_LUT[101 - amountIdx]) / 255;
    const scanMode = options[2];
    const normGray = new Float32Array(gray.length);
    let streakLeft = 0;
    let lastRoll;
    const spreadK = 1 + (1 / 10) * strength;
    const rollBias = (1 - 1 / spreadK) / 2;
    const lumDeltaThreshold = 16 / 256;
    const lastCol = width - 1;
    let lastLum = 0;
    const onValue = 1;
    const offValue = 255;

    function ditherPixel(row, col) {
      const off = row * width + col;
      if (outMask[off] != onValue || row >= height || col >= width) {
        return;
      }
      const lum = normGray[off];
      const gap = thresholdScale - lum;
      const roll = Math.random();
      const biasedRoll = roll / spreadK + rollBias;
      if (streakLeft == 0 || Math.abs(lastLum - lum) > lumDeltaThreshold) {
        lastRoll = biasedRoll <= gap ? lastLum : offValue;
        streakLeft = ~~(Math.random() * strength);
      } else if (0.1 < roll) {
        streakLeft--;
      } else {
        streakLeft = 0;
      }
      outMask[off] = lastRoll;
      lastLum = lum;
    }

    for (let rowIdx = 0; rowIdx < gray.length; rowIdx++) {
      normGray[rowIdx] = gray[rowIdx] / 255;
      outMask[rowIdx] = strength == 1 ? (Math.random() < 1 / 255 ? offValue : onValue) : onValue;
    }

    if (scanMode == 0) {
      for (let rowIdx = 0; rowIdx < width; rowIdx++) {
        for (let colIdx = 0; colIdx < width; colIdx++) {
          const diagIdx = rowIdx + colIdx;
          if (diagIdx >= width) break;
          ditherPixel(colIdx, lastCol - diagIdx);
        }
        streakLeft = 0;
      }
      for (let rowIdx = 1; rowIdx < height; rowIdx++) {
        for (let colIdx = 0; colIdx < height; colIdx++) {
          const diagIdx = rowIdx + colIdx;
          if (diagIdx >= height || colIdx >= width) break;
          ditherPixel(diagIdx, lastCol - colIdx);
        }
        streakLeft = 0;
      }
    } else if (scanMode == 1) {
      for (let rowIdx = 0; rowIdx < height; rowIdx++) {
        for (let colIdx = 0; colIdx < width; colIdx++) {
          ditherPixel(rowIdx, colIdx);
        }
        streakLeft = 0;
      }
    } else if (scanMode == 2) {
      for (let rowIdx = 0; rowIdx < width; rowIdx++) {
        for (let colIdx = 0; colIdx < width; colIdx++) {
          const diagIdx = rowIdx + colIdx;
          if (diagIdx >= width) break;
          ditherPixel(colIdx, diagIdx);
        }
        streakLeft = 0;
      }
      for (let rowIdx = 1; rowIdx < height; rowIdx++) {
        for (let colIdx = 0; colIdx < height; colIdx++) {
          const diagIdx = rowIdx + colIdx;
          if (diagIdx >= height || colIdx >= width) break;
          ditherPixel(diagIdx, colIdx);
        }
        streakLeft = 0;
      }
    } else {
      for (let rowIdx = 0; rowIdx < width; rowIdx++) {
        for (let colIdx = 0; colIdx < height; colIdx++) {
          ditherPixel(colIdx, rowIdx);
        }
        streakLeft = 0;
      }
    }
  }

  return applyDiffuseDither;
}

// ---------------------------------------------------------------------------
// Min-heap (1-indexed)
// ---------------------------------------------------------------------------

function minHeapPush(heap, entry) {
  let idx = heap.length;
  heap.push(entry);
  let parent = idx >>> 1;
  while (parent != 0 && heap[idx][0] < heap[parent][0]) {
    const swap = heap[idx];
    heap[idx] = heap[parent];
    heap[parent] = swap;
    idx = parent;
    parent = idx >>> 1;
  }
}

function minHeapPop(heap) {
  if (heap.length == 2) return heap.pop();
  const top = heap[1];
  let idx = 1;
  heap[1] = heap.pop();
  const len = heap.length;
  while (true) {
    const left = idx << 1;
    const right = left + 1;
    let smallest = idx;
    if (left < len && heap[left][0] < heap[smallest][0]) smallest = left;
    if (right < len && heap[right][0] < heap[smallest][0]) smallest = right;
    if (smallest == idx) break;
    const swap = heap[idx];
    heap[idx] = heap[smallest];
    heap[smallest] = swap;
    idx = smallest;
  }
  return top;
}

// ---------------------------------------------------------------------------
// Wind blend
// ---------------------------------------------------------------------------

function sumRgba(buf, off) {
  return buf[off] + buf[off + 1] + buf[off + 2] + buf[off + 3];
}

function windSortMetric(buf, off) {
  return buf[off] + buf[off + 1] + buf[off + 2] + 2 * buf[off + 3];
}

function copyRgba(dst, dstOff, src, srcOff) {
  dst[dstOff] = src[srcOff];
  dst[dstOff + 1] = src[srcOff + 1];
  dst[dstOff + 2] = src[srcOff + 2];
  dst[dstOff + 3] = src[srcOff + 3];
}

function copyRgbaFromOffset(dst, dstOff, srcOff) {
  dst[dstOff] = dst[srcOff];
  dst[dstOff + 1] = dst[srcOff + 1];
  dst[dstOff + 2] = dst[srcOff + 2];
  dst[dstOff + 3] = dst[srcOff + 3];
}

function copyRgbaInvertAlpha(dst, src, srcOff) {
  dst[srcOff] = src[srcOff];
  dst[srcOff + 1] = src[srcOff + 1];
  dst[srcOff + 2] = src[srcOff + 2];
  dst[srcOff + 3] = 255 - src[srcOff + 3];
}

function invertAllAlpha(buf) {
  for (let rowOff = 0, len = buf.length; rowOff < len; rowOff += 4) {
    buf[rowOff + 3] = 255 - buf[rowOff + 3];
  }
}

function randomWindStretchDistance() {
  const roll = Math.random();
  if (roll > 0.5) return 0;
  if (roll > 0.25) return 1;
  if (roll > 0.1) return 2;
  if (roll > 0.02143) return 3;
  if (roll > 0.00445) return 4;
  if (roll > 65e-5) return 5;
  if (roll > 415e-6) return 6;
  if (roll > 55e-6) return 7;
  return 8;
}

function averageRgbaMidpoint(dst, dstOff, left, leftOff, right, rightOff) {
  dst[dstOff] = left[leftOff] + ((right[rightOff] - left[leftOff]) >> 1);
  dst[dstOff + 1] = left[leftOff + 1] + ((right[rightOff + 1] - left[leftOff + 1]) >> 1);
  dst[dstOff + 2] = left[leftOff + 2] + ((right[rightOff + 2] - left[leftOff + 2]) >> 1);
  dst[dstOff + 3] = left[leftOff + 3] + ((right[rightOff + 3] - left[leftOff + 3]) >> 1);
}

function averageRgbaPair(dst, dstOff, left, leftOff, right, rightOff) {
  dst[dstOff] = (right[rightOff] + left[leftOff]) >> 1;
  dst[dstOff + 1] = (right[rightOff + 1] + left[leftOff + 1]) >> 1;
  dst[dstOff + 2] = (right[rightOff + 2] + left[leftOff + 2]) >> 1;
  dst[dstOff + 3] = (right[rightOff + 3] + left[leftOff + 3]) >> 1;
}

function windExchangeStretchRow(
  rowBuf,
  dstOff,
  srcOff,
  sortKeys,
  stretchCounts,
  colIdx,
  scratchA,
  scratchB,
  rowStride,
) {
  let scratchLen = 0;
  let scratchUsed = 0;
  let stretchDone = 0;
  let stretchTarget = stretchCounts[colIdx];
  averageRgbaMidpoint(scratchB, 0, rowBuf, dstOff, rowBuf, srcOff);
  for (let pixelIdx = 0; pixelIdx < stretchTarget; pixelIdx++) {
    averageRgbaMidpoint(scratchB, (pixelIdx + 1) * 4, scratchB, pixelIdx * 4, rowBuf, srcOff);
  }
  scratchUsed = (stretchTarget + 1) * 4;
  stretchDone += stretchTarget;
  colIdx--;
  copyRgba(rowBuf, dstOff, scratchB, scratchUsed - 4);
  sortKeys[colIdx] = sumRgba(rowBuf, dstOff);
  dstOff -= rowStride;
  while (colIdx > 0 && sortKeys[colIdx - 1] < sortKeys[colIdx]) {
    const swapTmp = scratchB;
    scratchB = scratchA;
    scratchA = swapTmp;
    scratchLen = scratchUsed;
    averageRgbaPair(scratchB, 0, rowBuf, dstOff - rowStride, scratchA, 0);
    for (let pixelIdx = 4; pixelIdx < scratchLen; pixelIdx += 4) {
      averageRgbaPair(scratchB, pixelIdx, scratchB, pixelIdx - 4, scratchA, pixelIdx);
    }
    stretchTarget = stretchCounts[colIdx];
    for (let pixelIdx = stretchDone; pixelIdx < stretchTarget; pixelIdx++) {
      averageRgbaMidpoint(scratchB, scratchUsed, scratchB, scratchUsed - 4, scratchA, scratchLen - 4);
      scratchUsed += 4;
      stretchDone++;
    }
    colIdx--;
    copyRgba(rowBuf, dstOff, scratchB, scratchUsed - 4);
    sortKeys[colIdx] = sumRgba(rowBuf, dstOff);
    dstOff -= rowStride;
  }
}

function windStretchMethod0(srcBuf, width, height, workBuf, sortKeys) {
  let rowOff = 0;
  let pixelIdx;
  let lastStretch;
  const stretchCounts = new Uint8Array(width + 1);
  const scratchA = new Uint8Array(10 * 4);
  const scratchB = new Uint8Array(10 * 4);
  for (let rowIdx = 0; rowIdx < height; rowIdx++) {
    copyRgbaInvertAlpha(workBuf, srcBuf, rowOff);
    sortKeys[0] = sumRgba(workBuf, rowOff);
    stretchCounts[0] = randomWindStretchDistance();
    pixelIdx = rowOff;
    rowOff += 4;
    for (let colIdx = 1; colIdx < width; colIdx++) {
      copyRgbaInvertAlpha(workBuf, srcBuf, rowOff);
      sortKeys[colIdx] = sumRgba(workBuf, rowOff);
      lastStretch = randomWindStretchDistance();
      stretchCounts[colIdx] = lastStretch;
      if (sortKeys[colIdx - 1] < sortKeys[colIdx] && lastStretch > 0) {
        windExchangeStretchRow(workBuf, rowOff - 4, rowOff, sortKeys, stretchCounts, colIdx, scratchA, scratchB, 4);
      }
      rowOff += 4;
    }
    sortKeys[width] = sortKeys[0];
    stretchCounts[width] = stretchCounts[0];
    if (sortKeys[width - 1] < sortKeys[width] && lastStretch > 0) {
      windExchangeStretchRow(workBuf, rowOff, pixelIdx, sortKeys, stretchCounts, width, scratchA, scratchB, 4);
    }
  }
  invertAllAlpha(workBuf);
}

function randomWindSwapDistance() {
  const roll = Math.random();
  if (roll > 0.659755) return 0;
  if (roll > 0.1625) return 10;
  if (roll > 0.06) return 20;
  if (roll > 0.01) return 30;
  if (roll > 0.0035) return 40;
  if (roll > 65e-5) return 50;
  if (roll > 415e-6) return 60;
  if (roll > 55e-6) return 70;
  return 80;
}

function windReverseSwapRun(workBuf, dstOff, srcOff, sortKeys, colIdx, rowStride) {
  const swapDistance = randomWindSwapDistance() + 1;
  const sortKey = sortKeys[colIdx];
  for (let step = 1; step < swapDistance; step++) {
    if (colIdx < 0) break;
    if (sortKeys[colIdx - step] < sortKey) {
      copyRgbaFromOffset(workBuf, dstOff, srcOff);
    } else {
      break;
    }
    dstOff += rowStride;
  }
}

function windStretchMethod1(srcBuf, width, height, workBuf, sortKeys) {
  const rowByteStride = width * 4;
  let rowOff = 0;
  for (let rowIdx = 0; rowIdx < height; rowIdx++) {
    copyRgbaInvertAlpha(workBuf, srcBuf, rowOff);
    sortKeys[0] = sumRgba(workBuf, rowOff);
    rowOff += 4;
    let colIdx;
    for (colIdx = 1; colIdx < width; colIdx++) {
      copyRgbaInvertAlpha(workBuf, srcBuf, rowOff);
      sortKeys[colIdx] = sumRgba(srcBuf, rowOff);
      if (sortKeys[colIdx - 1] < sortKeys[colIdx]) {
        windReverseSwapRun(workBuf, rowOff - 4, rowOff, sortKeys, colIdx, -4);
      }
      rowOff += 4;
    }
    sortKeys[width] = sortKeys[0];
    if (sortKeys[colIdx - 1] < sortKeys[colIdx]) {
      windReverseSwapRun(workBuf, rowOff - 4, rowOff - rowByteStride, sortKeys, colIdx, -4);
    }
  }
  invertAllAlpha(workBuf);
}

function windProbabilisticSwap(workBuf, rowOff, sortKeys, colIdx, width, rowStride) {
  let attempt = 1;
  const savedPixel = new Uint8Array(4);
  while (Math.random() < 1 / attempt) {
    let dstOff = rowOff;
    if (colIdx <= 1) break;
    const sortKey = sortKeys[colIdx];
    const prevKey = sortKeys[colIdx - 1];
    if (sortKey <= prevKey) break;
    copyRgba(savedPixel, 0, workBuf, dstOff - rowStride);
    let didSwap = true;
    for (let col = colIdx; col < width; col++) {
      if (prevKey > sortKeys[col]) {
        copyRgba(workBuf, dstOff - rowStride, savedPixel, 0);
        sortKeys[col - 1] = prevKey;
        didSwap = false;
        break;
      }
      copyRgba(workBuf, dstOff - rowStride, workBuf, dstOff);
      sortKeys[col - 1] = sortKeys[col];
      dstOff += rowStride;
    }
    if (didSwap) {
      copyRgba(workBuf, dstOff - rowStride, savedPixel, 0);
      sortKeys[width - 1] = prevKey;
    }
    attempt++;
    colIdx--;
    rowOff -= rowStride;
  }
}

function windStretchMethod2(srcBuf, width, height, workBuf, sortKeys) {
  let rowOff = 0;
  for (let rowIdx = 0; rowIdx < height; rowIdx++) {
    const rowStart = rowOff;
    for (let colIdx = 0; colIdx < width; colIdx++) {
      copyRgbaInvertAlpha(workBuf, srcBuf, rowOff);
      sortKeys[colIdx] = windSortMetric(workBuf, rowOff);
      rowOff += 4;
    }
    rowOff = rowStart;
    for (let colIdx = 1; colIdx < width; colIdx++) {
      if (sortKeys[colIdx - 1] < sortKeys[colIdx] && Math.random() < 0.66) {
        windProbabilisticSwap(workBuf, rowOff + 4, sortKeys, colIdx, width, 4);
      }
      rowOff += 4;
    }
    rowOff += 4;
  }
  invertAllAlpha(workBuf);
}

function mirrorColumnsHorizontal(src, dst, width, height) {
  for (let rowIdx = 0; rowIdx < height; rowIdx++) {
    for (let colIdx = 0; colIdx < width; colIdx++) {
      const srcOff = (rowIdx * width + colIdx) << 2;
      const dstOff = (rowIdx * width + (width - 1 - colIdx)) << 2;
      dst[dstOff] = src[srcOff];
      dst[dstOff + 1] = src[srcOff + 1];
      dst[dstOff + 2] = src[srcOff + 2];
      dst[dstOff + 3] = src[srcOff + 3];
    }
  }
}

export function applyWindBlend(srcBuf, width, height, dstBuf, options) {
  const method = options[0];
  const flipHorizontal = options[1];
  const sortKeys = new Uint16Array(width + 1);
  let workSrc = srcBuf;
  let workDst = dstBuf;
  let scratch;
  if (flipHorizontal) {
    scratch = dstBuf.slice(0);
    mirrorColumnsHorizontal(srcBuf, dstBuf, width, height);
    workSrc = dstBuf;
    workDst = scratch;
  }
  if (method == 0) windStretchMethod0(workSrc, width, height, workDst, sortKeys);
  else if (method == 1) windStretchMethod1(workSrc, width, height, workDst, sortKeys);
  else if (method == 2) windStretchMethod2(workSrc, width, height, workDst, sortKeys);
  if (flipHorizontal) {
    mirrorColumnsHorizontal(scratch, dstBuf, width, height);
  }
}

// ---------------------------------------------------------------------------
// Sharpen edges / despeckle / diffuse noise
// ---------------------------------------------------------------------------

function createSharpenEdges() {
  function applySharpenEdges(src, width, height, dst) {
    const blurred = new Uint8Array(src.length);
    const grayFromBlur = new Uint8Array(src.length >>> 2);
    const edges = new Uint8Array(src.length >>> 2);
    convolveRGBA(
      src,
      blurred,
      width,
      height,
      presetKernels[2],
      0,
      true,
    );
    for (let off = 0; off < src.length; off += 4) {
      const gray = blurred[off + 0] * 0.3 + blurred[off + 1] * 0.59 + blurred[off + 2] * 0.11;
      grayFromBlur[off >>> 2] = gray;
      dst[off + 0] = src[off + 0];
      dst[off + 1] = src[off + 1];
      dst[off + 2] = src[off + 2];
      dst[off + 3] = src[off + 3];
    }
    findEdgesChannel(grayFromBlur, edges, width, height);
    for (let off = 0; off < src.length; off += 4) {
      blurred[off + 3] = ~~(Math.max(0, 255 - edges[off >>> 2] - 50) * (255 / 205));
    }
    for (let off = 0, end = src.length; off < end; off += 4) {
      const edgeWeight = blurred[off + 3] / 255;
      dst[off] = blurred[off] * edgeWeight + dst[off] * (1 - edgeWeight);
      dst[off + 1] = blurred[off + 1] * edgeWeight + dst[off + 1] * (1 - edgeWeight);
      dst[off + 2] = blurred[off + 2] * edgeWeight + dst[off + 2] * (1 - edgeWeight);
    }
  }
  return applySharpenEdges;
}

function createDespeckle() {
  function applyDespeckle(src, width, height, dst) {
    const edges = new Uint8Array(src.length >>> 2);
    const gray = new Uint8Array(src.length >>> 2);
    const edgeMask = new Uint8Array(src.length);
    for (let off = 0; off < src.length; off += 4) {
      const lum = src[off + 0] * 0.3 + src[off + 1] * 0.59 + src[off + 2] * 0.11;
      gray[off >>> 2] = lum;
      edgeMask[off] = src[off];
      edgeMask[off + 1] = src[off + 1];
      edgeMask[off + 2] = src[off + 2];
    }
    findEdgesChannel(gray, edges, width, height);
    convolveRGBA(
      src,
      dst,
      width,
      height,
      presetKernels[1],
      0,
      true,
    );
    for (let off = 0; off < src.length; off += 4) {
      edgeMask[off + 3] = 255 - edges[off >>> 2];
    }
    for (let off = 0, end = src.length; off < end; off += 4) {
      const edgeWeight = edgeMask[off + 3] / 255;
      dst[off] = edgeMask[off] * edgeWeight + dst[off] * (1 - edgeWeight);
      dst[off + 1] = edgeMask[off + 1] * edgeWeight + dst[off + 1] * (1 - edgeWeight);
      dst[off + 2] = edgeMask[off + 2] * edgeWeight + dst[off + 2] * (1 - edgeWeight);
    }
  }
  return applyDespeckle;
}

function diffuseNoisePixels(src, width, height, dst, blendFn) {
  const packed = new Uint32Array(src.buffer);
  let dstOff = 0;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++, dstOff += 4) {
      const pixel = packed[row * width + col];
      const r = pixel & 255;
      const g = (pixel >>> 8) & 255;
      const b = (pixel >>> 16) & 255;
      const a = (pixel >>> 24) & 255;
      const dirRoll = ~~(Math.random() * 8);
      const axis = dirRoll % 3;
      let deltaCol = 0;
      let deltaRow = 0;
      if (dirRoll < 3) {
        deltaRow--;
      } else if (dirRoll > 4) {
        deltaRow++;
      }
      if (axis == 0) {
        deltaCol--;
      } else if (axis == 2) {
        deltaCol++;
      }
      let neighborCol = col + deltaCol;
      let neighborRow = row + deltaRow;
      if (neighborCol < 0) neighborCol = 0;
      else if (neighborCol > width - 1) neighborCol = width - 1;
      if (neighborRow < 0) neighborRow = 0;
      else if (neighborRow > height - 1) neighborRow = height - 1;
      const neighbor = packed[neighborRow * width + neighborCol];
      const nr = neighbor & 255;
      const ng = (neighbor >>> 8) & 255;
      const nb = (neighbor >>> 16) & 255;
      const na = (neighbor >>> 24) & 255;
      dst[dstOff] = blendFn(r, nr);
      dst[dstOff + 1] = blendFn(g, ng);
      dst[dstOff + 2] = blendFn(b, nb);
      dst[dstOff + 3] = blendFn(a, na);
    }
  }
}

function diffuseCopyNeighborChannel(src, neighbor) {
  return neighbor;
}

function diffuseDarkenChannel(src, neighbor) {
  return src > neighbor ? neighbor : src;
}

function diffuseLightenChannel(src, neighbor) {
  return src < neighbor ? neighbor : src;
}

/**
 * Diffuse in its three neighbour-blend modes: normal, darken and lighten. The
 * filter's fourth mode, anisotropic, is a different algorithm entirely and is
 * served by {@code filter}, which `applyDiffuseFilter`
 * selects instead of this kernel.
 * @param {Uint8Array|Uint8ClampedArray} src
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Uint8ClampedArray} dst
 * @param {number[]} options `[mode]`
 */
export function applyDiffuseNoise(src, width, height, dst, options) {
  const mode = options[0];
  if (mode == 0) diffuseNoisePixels(src, width, height, dst, diffuseCopyNeighborChannel);
  else if (mode == 1) diffuseNoisePixels(src, width, height, dst, diffuseDarkenChannel);
  else if (mode == 2) diffuseNoisePixels(src, width, height, dst, diffuseLightenChannel);
  else console.error("Unexpected diffuse blend mode:", mode);
}

/**
 * Clouds and diffuse dither shuffle a permutation table when they are built, so
 * each is built once and reused. Build your own through the factory to control
 * the shuffle.
 */
export const applyCloudsNoise = createCloudsNoiseRenderer();
export const applyDiffuseDither = createDiffuseDither();
export const applySharpenEdges = createSharpenEdges();
export const applyDespeckle = createDespeckle();

/** A binary min-heap, used by the seam and scissors searches. */
export const minHeap = {
  push: minHeapPush,
  pop: minHeapPop,
};
