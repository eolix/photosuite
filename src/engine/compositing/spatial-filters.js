/**
 * Spatial convolution kernels and histogram rank filters (median / min / max /
 * percentile / weighted mean).
 */

import { allocBuffer, extractChannel, extractChannelByte } from "./buffer-utils.js";
import { hasNonOpaquePixels } from "./pixel-ops.js";

/** The built-in convolution kernels, normalised once: blur, sharpen, edges... */
export const presetKernels = buildPresetKernels(normalizeKernel);

export function normalizeKernel(kernel) {
  const normalized = kernel.slice(0);
  let sum = 0;
  for (let i = 0; i < kernel.length; i++) sum += kernel[i];
  for (let i = 0; i < kernel.length; i++) normalized[i] /= sum;
  return normalized
}

function buildPresetKernels(normalize) {
  return [
    normalize([1, 2, 1, 2, 16, 2, 1, 2, 1]),
    normalize([1, 2, 1, 2, 4, 2, 1, 2, 1]),
    normalize([0, -1, 0, -1, 8, -1, 0, -1, 0]),
    normalize([-.7, -1, -.7, -1, 10, -1, -.7, -1, -.7]),
    [-1, 0, 1, -2, 0, 2, -1, 0, 1],
    [1, 2, 1, 0, 0, 0, -1, -2, -1]
  ]
}

export function convolveRGBA(source, dest, width, height, kernel, alphaWriteMask, takeAbs, clampAndSkipTransparent) {
  if (takeAbs == null) takeAbs = false;
  if (clampAndSkipTransparent == null) clampAndSkipTransparent = false;
  const kernelSide = Math.floor(Math.sqrt(kernel.length));
  const half = kernelSide - 1 >>> 1;
  const srcPixels = new Uint32Array(source.buffer);
  const destBytes = new Uint8ClampedArray(dest.buffer);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let accumR = 0;
      let accumG = 0;
      let accumB = 0;
      let accumA = 0;
      for (let ky = 0; ky < kernelSide; ky++)
        for (let kx = 0; kx < kernelSide; kx++) {
          const weight = kernel[ky * kernelSide + kx];
          if (weight == 0) continue;
          let sampleX = x - half + kx;
          let sampleY = y - half + ky;
          if (sampleX < 0) sampleX = 0;
          else if (sampleX > width - 1) sampleX = width - 1;
          if (sampleY < 0) sampleY = 0;
          else if (sampleY > height - 1) sampleY = height - 1;
          if (clampAndSkipTransparent && srcPixels[sampleY * width + sampleX] >>> 24 == 0) {
            sampleY = y;
            sampleX = x
          }
          const packed = srcPixels[sampleY * width + sampleX];
          accumR += (packed & 255) * weight;
          accumG += (packed >>> 8 & 255) * weight;
          accumB += (packed >>> 16 & 255) * weight;
          accumA += (packed >>> 24 & 255) * weight
        }
      if (takeAbs) {
        if (accumR < 0) accumR = -accumR;
        if (accumG < 0) accumG = -accumG;
        if (accumB < 0) accumB = -accumB;
        if (accumA < 0) accumA = -accumA
      }
      if (clampAndSkipTransparent) {
        accumR = Math.max(0, Math.min(255, accumR));
        accumG = Math.max(0, Math.min(255, accumG));
        accumB = Math.max(0, Math.min(255, accumB));
        accumA = Math.max(0, Math.min(255, accumA))
      }
      const destIndex = y * width + x << 2;
      destBytes[destIndex] = ~~(.5 + accumR);
      destBytes[destIndex + 1] = ~~(.5 + accumG);
      destBytes[destIndex + 2] = ~~(.5 + accumB);
      destBytes[destIndex + 3] = 255 - alphaWriteMask & destBytes[destIndex + 3] | alphaWriteMask & ~~(.5 + accumA)
    }
}

export function findEdgesRGB(source, dest, width, height) {
  const length = source.length;
  const vertical = new Uint8Array(length);
  convolveRGBA(source, dest, width, height, presetKernels[4], 0, true);
  convolveRGBA(source, vertical, width, height, presetKernels[5], 0, true);
  for (let i = 0; i < length; i += 4) {
    const horizR = dest[i];
    const horizG = dest[i + 1];
    const horizB = dest[i + 2];
    const vertR = vertical[i];
    const vertG = vertical[i + 1];
    const vertB = vertical[i + 2];
    dest[i] = 255 - Math.max(0, Math.min(255, Math.sqrt(horizR * horizR + vertR * vertR)));
    dest[i + 1] = 255 - Math.max(0, Math.min(255, Math.sqrt(horizG * horizG + vertG * vertG)));
    dest[i + 2] = 255 - Math.max(0, Math.min(255, Math.sqrt(horizB * horizB + vertB * vertB)))
  }
}

export function findEdgesChannel(source, dest, width, height) {
  const length = source.length;
  const vertical = new Uint8Array(length);
  convolveChannel3x3(source, dest, width, height, presetKernels[4], true);
  convolveChannel3x3(source, vertical, width, height, presetKernels[5], true);
  for (let i = 0; i < length; i++) {
    const horizGrad = dest[i];
    const vertGrad = vertical[i];
    dest[i] = 255 - Math.max(0, Math.min(255, Math.sqrt(horizGrad * horizGrad + vertGrad * vertGrad)))
  }
}

export function convolveChannel3x3(source, dest, width, height, kernel, takeAbs) {
  dest = new Uint8ClampedArray(dest.buffer);
  const lastRow = height - 1;
  const lastCol = width - 1;
  for (let y = 1; y < lastRow; y++)
    for (let x = 1; x < lastCol; x++) {
      const index = y * width + x;
      let value = dot3x3(source, index, width, kernel);
      if (takeAbs) {
        if (value < 0) value = -value
      }
      dest[index] = ~~(value + .5)
    }
}

export function dot3x3(buffer, center, stride, kernel) {
  return buffer[center - stride - 1] * kernel[0] + buffer[center - stride] * kernel[1] + buffer[center - stride + 1] * kernel[2] + buffer[center - 1] * kernel[3] + buffer[center] * kernel[4] + buffer[center + 1] * kernel[5] + buffer[center + stride - 1] * kernel[6] + buffer[center + stride] * kernel[7] + buffer[center + stride + 1] * kernel[8]
}

export function convolveChannel3x3Raw(source, dest, width, height, kernel) {
  const lastRow = height - 1;
  const lastCol = width - 1;
  for (let y = 1; y < lastRow; y++)
    for (let x = 1; x < lastCol; x++) {
      const index = y * width + x;
      dest[index] = dot3x3Raw(source, index, width, kernel)
    }
}

export function dot3x3Raw(buffer, center, stride, kernel) {
  return buffer[center - stride - 1] * kernel[0] + buffer[center - stride] * kernel[1] + buffer[center - stride + 1] * kernel[2] + buffer[center - 1] * kernel[3] + buffer[center] * kernel[4] + buffer[center + 1] * kernel[5] + buffer[center + stride - 1] * kernel[6] + buffer[center + stride] * kernel[7] + buffer[center + stride + 1] * kernel[8]
}

function addToBins(hist, value, base, delta) {
  hist[base | value] += delta;
  hist[base | 256 | value >>> 4] += delta
}

function addColorPixel(hist, source, byteOffset, delta) {
  const weight = delta * source[byteOffset + 3];
  hist[300] += weight;
  addToBins(hist, source[byteOffset], 0, weight);
  addToBins(hist, source[byteOffset + 1], 512, weight);
  addToBins(hist, source[byteOffset + 2], 1024, weight)
}

function accumulateColorRowSpan(hist, source, startIdx, endIdx, sign) {
  let byteOffset = startIdx << 2;
  const endByte = endIdx << 2;
  while (byteOffset < endByte) {
    addColorPixel(hist, source, byteOffset, sign);
    byteOffset += 4
  }
}

function accumulateColorColumnDiamond(hists, source, startIdx, endIdx, sign, half) {
  const addPixel = addColorPixel;
  addPixel(hists[half - 1], source, startIdx - 1 << 2, sign);
  addPixel(hists[half - 1], source, endIdx - 1 << 2, -sign);
  addPixel(hists[half + 1], source, endIdx << 2, sign);
  addPixel(hists[half + 1], source, startIdx << 2, -sign);
  for (let offset = 1; offset < half; offset++) {
    const histLow = hists[half - offset - 1];
    const histHigh = hists[half + offset + 1];
    for (let j = 0; j <= offset; j++) {
      addPixel(histLow, source, startIdx - 1 - j << 2, sign);
      addPixel(histLow, source, endIdx - 1 - j << 2, -sign);
      addPixel(histHigh, source, endIdx + j << 2, sign);
      addPixel(histHigh, source, startIdx + j << 2, -sign)
    }
  }
  accumulateColorRowSpan(hists[half], source, startIdx, endIdx, sign)
}

function filterColorChannels(source, dest, width, height, radius, selectorPair, params) {
  let count = 0;
  const histBuffer = new ArrayBuffer(512 * 4 * 3);
  const colorHist = [new Int32Array(histBuffer, 0), new Int32Array(histBuffer, 2048), new Int32Array(histBuffer, 2 * 2048)];
  const windowSize = 1 + 2 * Math.round(Math.sqrt(radius));
  const half = windowSize >>> 1;
  const rowHists = new Array(windowSize);
  const rowHistMain = new Array(windowSize);
  for (let k = 0; k < windowSize; k++) {
    const rowBuffer = new ArrayBuffer(512 * 4 * 3);
    rowHists[k] = [new Int32Array(rowBuffer, 0), new Int32Array(rowBuffer, 2048), new Int32Array(rowBuffer, 2 * 2048)];
    rowHistMain[k] = rowHists[k][0]
  }
  const selectSingle = selectorPair[0];
  const selectDual = selectorPair[1];
  const hist = colorHist[0];
  for (let x = 0; x < width; x++)
    if (x < radius || x > width - radius - windowSize - 1) {
      hist.fill(0);
      const colStart = Math.max(x - radius, 0);
      const colEnd = Math.min(width, x + radius + 1);
      for (let row = 0; row < radius; row++) accumulateColorRowSpan(hist, source, row * width + colStart, row * width + colEnd, 1);
      for (let row = 0; row < height; row++) {
        const exitRow = row - radius - 1;
        const enterRow = row + radius;
        if (enterRow < height) accumulateColorRowSpan(hist, source, enterRow * width + colStart, enterRow * width + colEnd, 1);
        if (exitRow >= 0) accumulateColorRowSpan(hist, source, exitRow * width + colStart, exitRow * width + colEnd, -1);
        const dstOffset = row * width + x << 2;
        count = hist[300];
        if (count != 0)
          for (let ch = 0; ch < 3; ch++) dest[dstOffset + ch] = selectSingle(colorHist[ch], source[dstOffset + ch], count, params)
      }
    } else {
      for (let k = 0; k < windowSize; k++) rowHistMain[k].fill(0);
      const colStart = x - radius + half;
      const colEnd = x + radius + 1 + half;
      for (let row = 0; row < radius; row++) accumulateColorColumnDiamond(rowHistMain, source, row * width + colStart, row * width + colEnd, 1, half);
      for (let row = 0; row < height; row++) {
        const exitRow = row - radius - 1;
        const enterRow = row + radius;
        if (exitRow >= 0) accumulateColorColumnDiamond(rowHistMain, source, exitRow * width + colStart, exitRow * width + colEnd, -1, half);
        if (enterRow < height) accumulateColorColumnDiamond(rowHistMain, source, enterRow * width + colStart, enterRow * width + colEnd, 1, half);
        const centerHists = rowHists[half];
        count = centerHists[0][300];
        for (let k = 0; k < half; k++) {
          const above = half - 1 - k;
          const below = half + 1 + k;
          const histAbove = rowHists[above];
          const histBelow = rowHists[below];
          const countAbove = count + histAbove[0][300];
          const countBelow = count + histBelow[0][300];
          const offsetAbove = row * width + x + above << 2;
          const offsetBelow = row * width + x + below << 2;
          if (countAbove != 0)
            for (let ch = 0; ch < 3; ch++) dest[offsetAbove + ch] = selectDual(centerHists[ch], histAbove[ch], source[offsetAbove + ch], countAbove, params);
          if (countBelow != 0)
            for (let ch = 0; ch < 3; ch++) dest[offsetBelow + ch] = selectDual(centerHists[ch], histBelow[ch], source[offsetBelow + ch], countBelow, params)
        }
        const dstOffset = row * width + x + half << 2;
        if (count != 0)
          for (let ch = 0; ch < 3; ch++) dest[dstOffset + ch] = selectSingle(centerHists[ch], source[dstOffset + ch], count, params)
      }
      x += windowSize - 1
    }
}

export function filterRGBA(source, dest, width, height, radius, selector, params) {
  if (radius == 0) {
    dest.set(source);
    return
  }
  const srcChannelBuf = allocBuffer(width * height);
  const dstChannelBuf = allocBuffer(width * height);
  if (hasNonOpaquePixels(source)) {
    filterColorChannels(source, dest, width, height, radius, selector, params);
    const minMax = [selectMinimum, selectMaximum];
    const selectorIdx = minMax.indexOf(selector);
    const alphaSelector = selectorIdx != -1 ? minMax[1 - selectorIdx] : selector;
    extractChannelByte(source, srcChannelBuf, 3);
    filterChannel(srcChannelBuf, dstChannelBuf, width, height, radius, alphaSelector, params);
    extractChannel(dstChannelBuf, dest, 3)
  } else {
    for (let ch = 0; ch < 3; ch++) {
      extractChannelByte(source, srcChannelBuf, ch);
      filterChannel(srcChannelBuf, dstChannelBuf, width, height, radius, selector, params);
      extractChannel(dstChannelBuf, dest, ch)
    }
  }
}

function accumulateChannelSpan(hist, source, start, end, sign) {
  while (start < end) addToBins(hist, source[start++], 0, sign)
}

function accumulateChannelDiamond(hists, source, startIdx, endIdx, sign, half) {
  const addBin = addToBins;
  addBin(hists[half - 1], source[startIdx - 1], 0, sign);
  addBin(hists[half - 1], source[endIdx - 1], 0, -sign);
  addBin(hists[half + 1], source[endIdx], 0, sign);
  addBin(hists[half + 1], source[startIdx], 0, -sign);
  for (let offset = 1; offset < half; offset++) {
    const histLow = hists[half - offset - 1];
    const histHigh = hists[half + offset + 1];
    for (let j = 0; j <= offset; j++) {
      addBin(histLow, source[startIdx - 1 - j], 0, sign);
      addBin(histLow, source[endIdx - 1 - j], 0, -sign);
      addBin(histHigh, source[endIdx + j], 0, sign);
      addBin(histHigh, source[startIdx + j], 0, -sign)
    }
  }
  accumulateChannelSpan(hists[half], source, startIdx, endIdx, sign)
}

function addFineBins(dst, src, dstBase, srcBase) {
  dst[dstBase] += src[srcBase];
  dst[dstBase + 1] += src[srcBase + 1];
  dst[dstBase + 2] += src[srcBase + 2];
  dst[dstBase + 3] += src[srcBase + 3]
}

function removeFineBins(dst, src, dstBase, srcBase) {
  dst[dstBase] -= src[srcBase];
  dst[dstBase + 1] -= src[srcBase + 1];
  dst[dstBase + 2] -= src[srcBase + 2];
  dst[dstBase + 3] -= src[srcBase + 3]
}

function accumulateColumn(colHists, colCounts, source, width, row, sign) {
  const rowBase = row * width;
  for (let col = 0; col < width; col++) {
    addToBins(colHists, source[rowBase + col], col << 9, sign);
    colCounts[col] += sign
  }
}

function addColumnHist(runningHist, colHists, col) {
  for (let coarse = 0; coarse < 16; coarse++) {
    const coarseVal = colHists[col << 9 | 256 | coarse];
    if (coarseVal == 0) continue;
    runningHist[256 | coarse] += coarseVal;
    const fineBase = coarse << 4;
    const srcBase = col << 9 | fineBase;
    addFineBins(runningHist, colHists, fineBase, srcBase);
    addFineBins(runningHist, colHists, fineBase + 4, srcBase + 4);
    addFineBins(runningHist, colHists, fineBase + 8, srcBase + 8);
    addFineBins(runningHist, colHists, fineBase + 12, srcBase + 12)
  }
}

function removeColumnHist(runningHist, colHists, col) {
  for (let coarse = 0; coarse < 16; coarse++) {
    const coarseVal = colHists[col << 9 | 256 | coarse];
    if (coarseVal == 0) continue;
    runningHist[256 | coarse] -= coarseVal;
    const fineBase = coarse << 4;
    const srcBase = col << 9 | fineBase;
    removeFineBins(runningHist, colHists, fineBase, srcBase);
    removeFineBins(runningHist, colHists, fineBase + 4, srcBase + 4);
    removeFineBins(runningHist, colHists, fineBase + 8, srcBase + 8);
    removeFineBins(runningHist, colHists, fineBase + 12, srcBase + 12)
  }
}

function filterChannelSmall(source, dest, width, height, radius, selectorPair, params) {
  let count = 0;
  const hist = new Int32Array(512);
  const windowSize = 1 + 2 * Math.round(Math.sqrt(radius));
  const half = windowSize >>> 1;
  const rowHists = new Array(windowSize);
  for (let k = 0; k < windowSize; k++) rowHists[k] = new Int32Array(512);
  const selectSingle = selectorPair[0];
  const selectDual = selectorPair[1];
  for (let x = 0; x < width; x++)
    if (x < radius || x > width - radius - windowSize - 1) {
      hist.fill(0);
      count = 0;
      const colStart = Math.max(x - radius, 0);
      const colEnd = Math.min(width, x + radius + 1);
      const colCount = colEnd - colStart;
      for (let row = 0; row < radius; row++) {
        count += colCount;
        accumulateChannelSpan(hist, source, row * width + colStart, row * width + colEnd, 1)
      }
      for (let row = 0; row < height; row++) {
        const exitRow = row - radius - 1;
        const enterRow = row + radius;
        if (exitRow >= 0) {
          count -= colCount;
          accumulateChannelSpan(hist, source, exitRow * width + colStart, exitRow * width + colEnd, -1)
        }
        if (enterRow < height) {
          count += colCount;
          accumulateChannelSpan(hist, source, enterRow * width + colStart, enterRow * width + colEnd, 1)
        }
        const result = selectSingle(hist, source[row * width + x], count, params);
        dest[row * width + x] = result
      }
    } else {
      for (let k = 0; k < windowSize; k++) rowHists[k].fill(0);
      count = 0;
      const colStart = x - radius + half;
      const colEnd = x + radius + 1 + half;
      const colCount = colEnd - colStart;
      for (let row = 0; row < radius; row++) {
        count += colCount;
        accumulateChannelDiamond(rowHists, source, row * width + colStart, row * width + colEnd, 1, half)
      }
      for (let row = 0; row < height; row++) {
        const exitRow = row - radius - 1;
        const enterRow = row + radius;
        if (exitRow >= 0) {
          count -= colCount;
          accumulateChannelDiamond(rowHists, source, exitRow * width + colStart, exitRow * width + colEnd, -1, half)
        }
        if (enterRow < height) {
          count += colCount;
          accumulateChannelDiamond(rowHists, source, enterRow * width + colStart, enterRow * width + colEnd, 1, half)
        }
        for (let k = 0; k < half; k++) {
          const above = half - 1 - k;
          const below = half + 1 + k;
          dest[row * width + x + above] = selectDual(rowHists[half], rowHists[above], source[row * width + x + above], count, params);
          dest[row * width + x + below] = selectDual(rowHists[half], rowHists[below], source[row * width + x + below], count, params)
        }
        dest[row * width + x + half] = selectSingle(rowHists[half], source[row * width + x + half], count, params)
      }
      x += windowSize - 1
    }
}

function filterChannelLarge(source, dest, width, height, radius, selectorPair, params) {
  let count = 0;
  const hist = new Int32Array(512);
  const colCounts = new Int32Array(width);
  const colHists = new Int32Array(512 * width);
  const initCols = Math.min(radius, width);
  const initRows = Math.min(radius, height);
  const selectSingle = selectorPair[0];
  for (let row = 0; row < initRows; row++) accumulateColumn(colHists, colCounts, source, width, row, 1);
  for (let row = 0; row < height; row++) {
    if (row + radius < height) accumulateColumn(colHists, colCounts, source, width, row + radius, 1);
    if (row - radius - 1 >= 0) accumulateColumn(colHists, colCounts, source, width, row - radius - 1, -1);
    hist.fill(0);
    count = 0;
    for (let col = 0; col < initCols; col++) {
      count += colCounts[col];
      addColumnHist(hist, colHists, col)
    }
    for (let col = 0; col < width; col++) {
      const exitCol = col - radius - 1;
      const enterCol = col + radius;
      if (exitCol >= 0 && colCounts[exitCol] != 0) {
        count -= colCounts[exitCol];
        removeColumnHist(hist, colHists, exitCol)
      }
      if (enterCol < width && colCounts[enterCol] != 0) {
        count += colCounts[enterCol];
        addColumnHist(hist, colHists, enterCol)
      }
      const result = count == 0 ? 0 : selectSingle(hist, source[row * width + col], count, params);
      dest[row * width + col] = result
    }
  }
}

export function filterChannel(source, dest, width, height, radius, selectorPair, params) {
  if (radius == 0) {
    dest.set(source);
    return
  }
  if (radius <= 80) filterChannelSmall(source, dest, width, height, radius, selectorPair, params);
  else filterChannelLarge(source, dest, width, height, radius, selectorPair, params)
}

function selectMaximumSingle(hist) {
  let idx = 15;
  while (hist[256 | idx] == 0 && idx > 0) idx--;
  idx = (idx << 4) + 15;
  while (hist[idx] == 0 && idx > 0) idx--;
  return idx
}

function selectMaximumDual(histA, histB) {
  let idx = 15;
  while (histA[256 | idx] + histB[256 | idx] == 0 && idx > 0) idx--;
  idx = (idx << 4) + 15;
  while (histA[idx] + histB[idx] == 0 && idx > 0) idx--;
  return idx
}

function selectMinimumSingle(hist) {
  let idx = 0;
  while (hist[256 | idx] == 0 && idx < 15) idx++;
  idx = idx << 4;
  while (hist[idx] == 0 && idx < 255) idx++;
  return idx
}

function selectMinimumDual(histA, histB) {
  let idx = 0;
  while (histA[256 | idx] + histB[256 | idx] == 0 && idx < 15) idx++;
  idx = idx << 4;
  while (histA[idx] + histB[idx] == 0 && idx < 255) idx++;
  return idx
}

function selectPercentileSingle(hist, center, count) {
  const target = ~~(.5 + percentileFraction * count);
  let cumulative = 0;
  let idx = 256;
  while (cumulative + hist[idx] <= target) cumulative += hist[idx++];
  idx = idx - 256 << 4;
  while (cumulative <= target) cumulative += hist[idx++];
  return idx - 1
}

function selectPercentileDual(histA, histB, center, count) {
  const target = ~~(.5 + percentileFraction * count);
  let cumulative = 0;
  let idx = 256;
  while (cumulative + histA[idx] + histB[idx] <= target) {
    cumulative += histA[idx] + histB[idx];
    idx++
  }
  idx = idx - 256 << 4;
  while (cumulative <= target) {
    cumulative += histA[idx] + histB[idx];
    idx++
  }
  return idx - 1
}

function selectWeightedMeanSingle(hist, center, count, params) {
  const radius = params[0];
  let weightedSum = 0;
  let total = 0;
  let idx = Math.max(0, center - radius);
  const end = Math.min(256, center + radius + 1);
  while (idx < end) {
    const bin = hist[idx];
    weightedSum += idx * bin;
    total += bin;
    idx++
  }
  return total == 0 ? 0 : weightedSum / total
}

function selectWeightedMeanDual(histA, histB, center, count, params) {
  const radius = params[0];
  let weightedSum = 0;
  let total = 0;
  let idx = Math.max(0, center - radius);
  const end = Math.min(256, center + radius + 1);
  while (idx < end) {
    const bin = histA[idx] + histB[idx];
    weightedSum += idx * bin;
    total += bin;
    idx++
  }
  return total == 0 ? 0 : weightedSum / total
}

/**
 * Rank selectors, each a [single-channel, dual-channel] pair chosen by the
 * filter's channel count.
 */
export const selectMaximum = [selectMaximumSingle, selectMaximumDual];
export const selectMinimum = [selectMinimumSingle, selectMinimumDual];
export const selectPercentile = [selectPercentileSingle, selectPercentileDual];
export const selectWeightedMean = [selectWeightedMeanSingle, selectWeightedMeanDual];
let percentileFraction = 0.5;

/**
 * Where selectPercentile cuts, as a fraction of the window. A filter sets it
 * before running and restores it afterwards, so it reads as a parameter of the
 * call rather than of the module.
 */
export function setPercentileFraction(fraction) {
  percentileFraction = fraction;
}


