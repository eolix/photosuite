/**
 * Box and Gaussian blur for byte, RGBA, and float buffers. Gaussian blur is
 * approximated by repeated box filters (van Vliet and Young, 1995).
 */

import { allocBuffer, copyBuffer } from "./buffer-utils.js";

/** Reused scratch buffers sized on demand. */
const scratchState = {
  byteBuffer: new Uint8Array(0),
  floatBuffer: new Float32Array(0),
  divisionTableCache: [],
};

export function getByteBuffer(minLength) {
  if (scratchState.byteBuffer.length < minLength) {
    scratchState.byteBuffer = allocBuffer(minLength);
  }
  return scratchState.byteBuffer;
}

export function getFloatBuffer(minLength) {
  if (scratchState.floatBuffer.length < minLength) {
    scratchState.floatBuffer = new Float32Array(minLength);
  }
  return scratchState.floatBuffer;
}

/**
 * Box-kernel widths that approximate a Gaussian with the given sigma.
 * @param {number} sigma
 * @param {number} passCount
 * @returns {number[]}
 */
export function gaussianBoxWidths(sigma, passCount) {
  const ideal = Math.sqrt((12 * sigma * sigma) / passCount + 1);
  let small = Math.floor(ideal);
  if (small % 2 === 0) {
    small--;
  }
  const large = small + 2;
  const blend =
    (12 * sigma * sigma - passCount * small * small - 4 * passCount * small - 3 * passCount)
    / (-4 * small - 4);
  const largeCount = Math.round(blend);
  const widths = [];
  for (let pass = 0; pass < passCount; pass++) {
    widths.push(pass < largeCount ? small : large);
  }
  return widths;
}

export function getDivisionTable(radius) {
  if (scratchState.divisionTableCache[radius]) {
    return scratchState.divisionTableCache[radius];
  }
  const scale = 1 / (radius + radius + 1);
  const tableLen = (radius + radius + 1) * 256;
  const table = allocBuffer(tableLen);
  for (let idx = 0; idx < tableLen; idx++) {
    table[idx] = Math.round(idx * scale);
  }
  scratchState.divisionTableCache[radius] = table;
  return table;
}

function boxRadiusFromWidth(boxWidth) {
  return (boxWidth - 1) >> 1;
}

function runGaussianBytePasses(src, dst, width, height, sigma, passCount) {
  const boxWidths = gaussianBoxWidths(sigma, passCount);
  const scratch = getByteBuffer(width * height);
  copyBuffer(src, dst);
  for (let pass = 0; pass < passCount; pass++) {
    boxBlurBytePasses(dst, scratch, width, height, boxRadiusFromWidth(boxWidths[pass]));
  }
}

function runGaussianRgbaPasses(rgba, width, height, sigma, passCount) {
  const boxWidths = gaussianBoxWidths(sigma, passCount);
  const scratch = getByteBuffer(width * height * 4);
  for (let pass = 0; pass < passCount; pass++) {
    boxBlurRgbaPasses(rgba, scratch, width, height, boxRadiusFromWidth(boxWidths[pass]));
  }
}

function runGaussianFloatPasses(src, dst, width, height, sigma, passCount) {
  const boxWidths = gaussianBoxWidths(sigma, passCount);
  const scratch = getFloatBuffer(width * height);
  copyBuffer(src, dst);
  for (let pass = 0; pass < passCount; pass++) {
    boxBlurFloatPasses(dst, scratch, width, height, (boxWidths[pass] - 1) / 2);
  }
}

export function gaussianBlurByte(src, dst, rect, sigma) {
  runGaussianBytePasses(src, dst, rect.width, rect.height, sigma, 3);
}

export function gaussianBlurRgba(src, dst, rect, sigma) {
  runGaussianBytePasses(src, dst, rect.width, rect.height, sigma, 2);
}

export function gaussianBlurRgbaInPlace(rgba, rect, sigma) {
  runGaussianRgbaPasses(rgba, rect.width, rect.height, sigma, 3);
}

export function gaussianBlurFloat(src, dst, rect, sigma, passCount) {
  runGaussianFloatPasses(
    src,
    dst,
    rect.width,
    rect.height,
    sigma,
    passCount == null ? 3 : passCount,
  );
}

export function boxBlurByte(src, dst, rect, radius) {
  const width = rect.width;
  const height = rect.height;
  radius = Math.round(radius);
  const scratch = getByteBuffer(width * height);
  copyBuffer(src, dst);
  boxBlurBytePasses(dst, scratch, width, height, radius);
}

export function boxBlurRgbaInPlace(rgba, rect, radius) {
  const width = rect.width;
  const height = rect.height;
  radius = Math.round(radius);
  const scratch = getByteBuffer(width * height * 4);
  boxBlurRgbaPasses(rgba, scratch, width, height, radius);
}

export function boxBlur(src, dst, rect, radius) {
  const width = rect.width;
  const height = rect.height;
  radius = Math.round(radius);
  const scratch = getFloatBuffer(width * height);
  copyBuffer(src, dst);
  boxBlurFloatPasses(dst, scratch, width, height, radius);
}

export function boxBlurRgba(rgba, rect, radius) {
  const width = rect.width;
  const height = rect.height;
  radius = Math.round(radius);
  const scratch = getByteBuffer(width * height * 4);
  boxBlurHorizRgba(rgba, scratch, width, height, radius);
  copyBuffer(scratch, rgba);
}

export function boxBlurBytePasses(src, scratch, width, height, radius) {
  boxBlurHorizByte(src, scratch, width, height, radius);
  boxBlurVertByte(scratch, src, width, height, radius);
}

export function boxBlurRgbaPasses(src, scratch, width, height, radius) {
  boxBlurHorizRgba(src, scratch, width, height, radius);
  boxBlurVertRgba(scratch, src, width, height, radius);
}

export function boxBlurFloatPasses(src, scratch, width, height, radius) {
  boxBlurHorizFloat(src, scratch, width, height, radius);
  boxBlurVertFloat(scratch, src, width, height, radius);
}

export function boxBlurHorizByte(src, dst, width, height, radius) {
  const innerWidth = width - radius - radius - 1;
  const divTable = getDivisionTable(radius);
  for (let row = 0; row < height; row++) {
    let rowOff = row * width;
    let leadOff = rowOff;
    let trailOff = rowOff + radius;
    const edgeVal = src[rowOff];
    const farEdgeVal = src[rowOff + width - 1];
    let windowSum = (radius + 1) * edgeVal;
    for (let col = 0; col < radius; col++) {
      windowSum += src[rowOff + col];
    }
    for (let col = 0; col <= radius; col++) {
      windowSum += src[trailOff + col] - edgeVal;
      dst[rowOff + col] = divTable[windowSum];
    }
    trailOff += radius + 1;
    rowOff += radius + 1;
    for (let col = 0; col < innerWidth; col++) {
      windowSum += src[trailOff + col] - src[leadOff + col];
      dst[rowOff + col] = divTable[windowSum];
    }
    trailOff += innerWidth;
    leadOff += innerWidth;
    rowOff += innerWidth;
    for (let col = width - radius; col < width; col++) {
      windowSum += farEdgeVal - src[leadOff++];
      dst[rowOff++] = divTable[windowSum];
    }
  }
}

export function boxBlurHorizRgba(src, dst, width, height, radius) {
  const rowStride = width << 2;
  const radiusBytes = radius << 2;
  const innerWidth = width - radius - radius - 1;
  const innerBytes = innerWidth << 2;
  const divTable = getDivisionTable(radius);
  for (let row = 0; row < height; row++) {
    let rowOff = row * rowStride;
    let leadOff = rowOff;
    let trailOff = rowOff + radiusBytes;
    const farRowOff = rowOff + rowStride;
    let rEdge = src[rowOff];
    let gEdge = src[rowOff + 1];
    let bEdge = src[rowOff + 2];
    let aEdge = src[rowOff + 3];
    let rSum = (radius + 1) * rEdge;
    let gSum = (radius + 1) * gEdge;
    let bSum = (radius + 1) * bEdge;
    let aSum = (radius + 1) * aEdge;
    for (let col = 0; col < radiusBytes; col += 4) {
      rSum += src[rowOff + col];
      gSum += src[rowOff + col + 1];
      bSum += src[rowOff + col + 2];
      aSum += src[rowOff + col + 3];
    }
    for (let col = 0; col <= radiusBytes; col += 4) {
      rSum += src[trailOff] - rEdge;
      dst[rowOff] = divTable[rSum];
      gSum += src[trailOff + 1] - gEdge;
      dst[rowOff + 1] = divTable[gSum];
      bSum += src[trailOff + 2] - bEdge;
      dst[rowOff + 2] = divTable[bSum];
      aSum += src[trailOff + 3] - aEdge;
      dst[rowOff + 3] = divTable[aSum];
      trailOff += 4;
      rowOff += 4;
    }
    for (let col = 0; col < innerBytes; col += 4) {
      rSum += src[trailOff + col] - src[leadOff + col];
      dst[rowOff + col] = divTable[rSum];
      gSum += src[trailOff + col + 1] - src[leadOff + col + 1];
      dst[rowOff + col + 1] = divTable[gSum];
      bSum += src[trailOff + col + 2] - src[leadOff + col + 2];
      dst[rowOff + col + 2] = divTable[bSum];
      aSum += src[trailOff + col + 3] - src[leadOff + col + 3];
      dst[rowOff + col + 3] = divTable[aSum];
    }
    trailOff += innerBytes;
    leadOff += innerBytes;
    rowOff += innerBytes;
    rEdge = src[farRowOff - 4];
    gEdge = src[farRowOff - 3];
    bEdge = src[farRowOff - 2];
    aEdge = src[farRowOff - 1];
    for (let col = width - radius; col < width; col++) {
      rSum += rEdge - src[leadOff];
      dst[rowOff] = divTable[rSum];
      gSum += gEdge - src[leadOff + 1];
      dst[rowOff + 1] = divTable[gSum];
      bSum += bEdge - src[leadOff + 2];
      dst[rowOff + 2] = divTable[bSum];
      aSum += aEdge - src[leadOff + 3];
      dst[rowOff + 3] = divTable[aSum];
      leadOff += 4;
      rowOff += 4;
    }
  }
}

export function boxBlurHorizFloat(src, dst, width, height, radius) {
  const invWindow = 1 / (radius + radius + 1);
  const innerWidth = width - radius - radius - 1;
  for (let row = 0; row < height; row++) {
    let rowOff = row * width;
    let leadOff = rowOff;
    let trailOff = rowOff + radius;
    const edgeVal = src[rowOff];
    const farEdgeVal = src[rowOff + width - 1];
    let windowSum = (radius + 1) * edgeVal;
    for (let col = 0; col < radius; col++) {
      windowSum += src[rowOff + col];
    }
    for (let col = 0; col <= radius; col++) {
      windowSum += src[trailOff + col] - edgeVal;
      dst[rowOff + col] = windowSum * invWindow;
    }
    trailOff += radius + 1;
    rowOff += radius + 1;
    for (let col = 0; col < innerWidth; col++) {
      windowSum += src[trailOff + col] - src[leadOff + col];
      dst[rowOff + col] = windowSum * invWindow;
    }
    trailOff += innerWidth;
    leadOff += innerWidth;
    rowOff += innerWidth;
    for (let col = width - radius; col < width; col++) {
      windowSum += farEdgeVal - src[leadOff++];
      dst[rowOff++] = windowSum * invWindow;
    }
  }
}

export function boxBlurVertByte(src, dst, width, height, radius) {
  const innerHeight = height - radius - radius - 1;
  const divTable = getDivisionTable(radius);
  for (let col = 0; col < width; col++) {
    let colOff = col;
    let leadOff = colOff;
    let trailOff = colOff + radius * width;
    const edgeVal = src[colOff];
    const farEdgeVal = src[colOff + width * (height - 1)];
    let windowSum = (radius + 1) * edgeVal;
    for (let row = 0; row < radius; row++) {
      windowSum += src[colOff + row * width];
    }
    for (let row = 0; row <= radius; row++) {
      windowSum += src[trailOff] - edgeVal;
      dst[colOff] = divTable[windowSum];
      trailOff += width;
      colOff += width;
    }
    for (let row = 0; row < innerHeight; row++) {
      const rowDelta = row * width;
      windowSum += src[trailOff + rowDelta] - src[leadOff + rowDelta];
      dst[colOff + rowDelta] = divTable[windowSum];
    }
    leadOff += innerHeight * width;
    trailOff += innerHeight * width;
    colOff += innerHeight * width;
    for (let row = height - radius; row < height; row++) {
      windowSum += farEdgeVal - src[leadOff];
      dst[colOff] = divTable[windowSum];
      leadOff += width;
      colOff += width;
    }
  }
}

export function boxBlurVertRgba(src, dst, width, height, radius) {
  const rowStride = width << 2;
  const innerHeight = height - radius - radius - 1;
  const divTable = getDivisionTable(radius);
  for (let col = 0; col < width; col++) {
    let colOff = col << 2;
    let leadOff = colOff;
    let trailOff = colOff + radius * rowStride;
    const farColOff = colOff + rowStride * (height - 1);
    let rEdge = src[colOff];
    let gEdge = src[colOff + 1];
    let bEdge = src[colOff + 2];
    let aEdge = src[colOff + 3];
    let rSum = (radius + 1) * rEdge;
    let gSum = (radius + 1) * gEdge;
    let bSum = (radius + 1) * bEdge;
    let aSum = (radius + 1) * aEdge;
    for (let row = 0; row < radius; row++) {
      const sampleOff = colOff + row * rowStride;
      rSum += src[sampleOff];
      gSum += src[sampleOff + 1];
      bSum += src[sampleOff + 2];
      aSum += src[sampleOff + 3];
    }
    for (let row = 0; row <= radius; row++) {
      rSum += src[trailOff] - rEdge;
      dst[colOff] = divTable[rSum];
      gSum += src[trailOff + 1] - gEdge;
      dst[colOff + 1] = divTable[gSum];
      bSum += src[trailOff + 2] - bEdge;
      dst[colOff + 2] = divTable[bSum];
      aSum += src[trailOff + 3] - aEdge;
      dst[colOff + 3] = divTable[aSum];
      trailOff += rowStride;
      colOff += rowStride;
    }
    for (let row = 0; row < innerHeight; row++) {
      const rowDelta = row * rowStride;
      rSum += src[trailOff + rowDelta] - src[leadOff + rowDelta];
      dst[colOff + rowDelta] = divTable[rSum];
      gSum += src[trailOff + rowDelta + 1] - src[leadOff + rowDelta + 1];
      dst[colOff + rowDelta + 1] = divTable[gSum];
      bSum += src[trailOff + rowDelta + 2] - src[leadOff + rowDelta + 2];
      dst[colOff + rowDelta + 2] = divTable[bSum];
      aSum += src[trailOff + rowDelta + 3] - src[leadOff + rowDelta + 3];
      dst[colOff + rowDelta + 3] = divTable[aSum];
    }
    leadOff += innerHeight * rowStride;
    trailOff += innerHeight * rowStride;
    colOff += innerHeight * rowStride;
    rEdge = src[farColOff];
    gEdge = src[farColOff + 1];
    bEdge = src[farColOff + 2];
    aEdge = src[farColOff + 3];
    for (let row = height - radius; row < height; row++) {
      rSum += rEdge - src[leadOff];
      dst[colOff] = divTable[rSum];
      gSum += gEdge - src[leadOff + 1];
      dst[colOff + 1] = divTable[gSum];
      bSum += bEdge - src[leadOff + 2];
      dst[colOff + 2] = divTable[bSum];
      aSum += aEdge - src[leadOff + 3];
      dst[colOff + 3] = divTable[aSum];
      leadOff += rowStride;
      colOff += rowStride;
    }
  }
}

export function boxBlurVertFloat(src, dst, width, height, radius) {
  const invWindow = 1 / (radius + radius + 1);
  const innerHeight = height - radius - radius - 1;
  for (let col = 0; col < width; col++) {
    let colOff = col;
    let leadOff = colOff;
    let trailOff = colOff + radius * width;
    const edgeVal = src[colOff];
    const farEdgeVal = src[colOff + width * (height - 1)];
    let windowSum = (radius + 1) * edgeVal;
    for (let row = 0; row < radius; row++) {
      windowSum += src[colOff + row * width];
    }
    for (let row = 0; row <= radius; row++) {
      windowSum += src[trailOff] - edgeVal;
      dst[colOff] = windowSum * invWindow;
      trailOff += width;
      colOff += width;
    }
    for (let row = 0; row < innerHeight; row++) {
      const rowDelta = row * width;
      windowSum += src[trailOff + rowDelta] - src[leadOff + rowDelta];
      dst[colOff + rowDelta] = windowSum * invWindow;
    }
    leadOff += innerHeight * width;
    trailOff += innerHeight * width;
    colOff += innerHeight * width;
    for (let row = height - radius; row < height; row++) {
      windowSum += farEdgeVal - src[leadOff];
      dst[colOff] = windowSum * invWindow;
      leadOff += width;
      colOff += width;
    }
  }
}

