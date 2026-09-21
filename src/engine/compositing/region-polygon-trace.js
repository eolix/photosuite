/* global UPNG */
/**
 * Indexed-color geometry: UPNG / Lab quantize, small-region merge, and polygon
 * boundary tracing. Used by Filter Gallery Cutout; also suited to crop/straighten
 * and indexed-color export.
 */

/** Disjoint-set forest for region merge adjacency. */
class UnionFind {
  constructor(size) {
    this.parent = new Uint32Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }

  find(x) {
    let p = this.parent[x];
    while (p !== x) {
      x = p;
      p = this.parent[x];
    }
    return p;
  }

  link(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootA] = rootB;
  }
}

/** Axis-aligned integer rect used for index-buffer copies and path bounds. */
class IndexRect {
  constructor(x, y, w, h) {
    if (!x) x = 0;
    if (!y) y = 0;
    if (!w) w = 0;
    if (!h) h = 0;
    this.x = x;
    this.y = y;
    this.width = w;
    this.height = h;
  }

  intersectRect(other) {
    const left = Math.max(this.x, other.x);
    const top = Math.max(this.y, other.y);
    const right = Math.min(this.x + this.width, other.x + other.width);
    const bottom = Math.min(this.y + this.height, other.y + other.height);
    if (right < left || bottom < top) return new IndexRect();
    return new IndexRect(left, top, right - left, bottom - top);
  }

  containsRect(other) {
    return this.x <= other.x && this.y <= other.y
      && other.x + other.width <= this.x + this.width
      && other.y + other.height <= this.y + this.height;
  }

  isEmpty() {
    return this.width <= 0 || this.height <= 0;
  }
}

/** 2×3 affine used to map traced path coords into document space. */
class Affine2D {
  constructor(m00, m01, m10, m11, translateX, translateY) {
    if (typeof m00 === "undefined") {
      m00 = 1;
      m01 = 0;
      m10 = 0;
      m11 = 1;
      translateX = 0;
      translateY = 0;
    }
    this.m00 = m00;
    this.m01 = m01;
    this.m10 = m10;
    this.m11 = m11;
    this.translateX = translateX;
    this.translateY = translateY;
  }
}

function indexBytesPerPixel() {
  return 8;
}

function copyIndexBufferRect(srcIndices, srcRect, dstIndices, dstRect, clipRect) {
  let overlapRect = srcRect.intersectRect(dstRect);
  if (clipRect) overlapRect = overlapRect.intersectRect(clipRect);
  const srcOffsetX = Math.max(0, overlapRect.x - srcRect.x);
  const dstOffsetX = Math.max(0, overlapRect.x - dstRect.x);
  const srcOffsetY = Math.max(0, overlapRect.y - srcRect.y);
  const dstOffsetY = Math.max(0, overlapRect.y - dstRect.y);
  const copyWidth = overlapRect.width;
  const copyHeight = overlapRect.height;
  const srcBytesPerPixel = indexBytesPerPixel(srcIndices);
  const dstBytesPerPixel = indexBytesPerPixel(dstIndices);
  if (srcBytesPerPixel != dstBytesPerPixel) throw new Error("copyIndexBufferRect requires matching index bytes-per-pixel");
  const bytesPerIndex = srcBytesPerPixel >>> 3;
  const dstBuffer = new Uint8Array(dstIndices.buffer);
  for (let row = 0; row < copyHeight; row++) {
    const srcRowStart = (srcOffsetY + row) * srcRect.width + srcOffsetX;
    const dstRowStart = (dstOffsetY + row) * dstRect.width + dstOffsetX;
    dstBuffer.set(
      new Uint8Array(srcIndices.buffer, srcRowStart * bytesPerIndex, copyWidth * bytesPerIndex),
      dstRowStart * bytesPerIndex,
    );
  }
}

/** Convert UPNG plte entries into the palette tuple shape Cutout expects. */
function paletteFromQuantizeOutput(quantizePalette) {
  const palette = [];
  for (let i = 0; i < quantizePalette.length; i++) {
    const rgba = quantizePalette[i].est.q;
    palette.push(["", {
      red: rgba[0] * 255,
      green: rgba[1] * 255,
      blue: rgba[2] * 255,
      alpha: rgba[3] * 255,
    }]);
  }
  return palette;
}

function quantizeRgbaBuffer(rgbaBuffer, maxColors, width, height) {
  let quantResult = UPNG.quantize(rgbaBuffer, maxColors);
  quantResult = {
    indices: quantResult.inds,
    palette: paletteFromQuantizeOutput(quantResult.plte),
  };
  return quantResult;
}

// sRGB byte -> linear light, precomputed for the per-pixel assignment loop.
const SRGB_TO_LINEAR = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

function srgbChannelToLinear(channel) {
  channel /= 255;
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function labForwardComponent(t) {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

function rgbToLabTriple(r, g, b, out) {
  const linR = srgbChannelToLinear(r);
  const linG = srgbChannelToLinear(g);
  const linB = srgbChannelToLinear(b);
  const x = (linR * 0.4124 + linG * 0.3576 + linB * 0.1805) / 0.95047;
  const y = linR * 0.2126 + linG * 0.7152 + linB * 0.0722;
  const z = (linR * 0.0193 + linG * 0.1192 + linB * 0.9505) / 1.08883;
  const fx = labForwardComponent(x);
  const fy = labForwardComponent(y);
  const fz = labForwardComponent(z);
  out[0] = 116 * fy - 16;
  out[1] = 500 * (fx - fy);
  out[2] = 200 * (fy - fz);
}

function labInverseComponent(t) {
  const cube = t * t * t;
  return cube > 0.008856 ? cube : (t - 16 / 116) / 7.787;
}

function linearToSrgbChannel(channel) {
  const v = channel <= 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function labTripleToRgb(L, a, b) {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const x = 0.95047 * labInverseComponent(fx);
  const y = labInverseComponent(fy);
  const z = 1.08883 * labInverseComponent(fz);
  const linR = x * 3.2406 + y * -1.5372 + z * -0.4986;
  const linG = x * -0.9689 + y * 1.8758 + z * 0.0415;
  const linB = x * 0.0557 + y * -0.2040 + z * 1.0570;
  return [linearToSrgbChannel(linR), linearToSrgbChannel(linG), linearToSrgbChannel(linB)];
}

function assignNearestLabCluster(pixels, pixelCount, labCenters, clusterCount) {
  const indices = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const p = i * 4;
    const linR = SRGB_TO_LINEAR[pixels[p]];
    const linG = SRGB_TO_LINEAR[pixels[p + 1]];
    const linB = SRGB_TO_LINEAR[pixels[p + 2]];
    const x = (linR * 0.4124 + linG * 0.3576 + linB * 0.1805) / 0.95047;
    const y = linR * 0.2126 + linG * 0.7152 + linB * 0.0722;
    const z = (linR * 0.0193 + linG * 0.1192 + linB * 0.9505) / 1.08883;
    const fx = x > 0.008856 ? Math.cbrt(x) : 7.787 * x + 16 / 116;
    const fy = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116;
    const fz = z > 0.008856 ? Math.cbrt(z) : 7.787 * z + 16 / 116;
    const pixelL = 116 * fy - 16;
    const pixelA = 500 * (fx - fy);
    const pixelB = 200 * (fy - fz);
    let best = 0;
    let bestDist = Infinity;
    for (let k = 0; k < clusterCount; k++) {
      const deltaL = pixelL - labCenters[k * 3];
      const deltaA = pixelA - labCenters[k * 3 + 1];
      const deltaB = pixelB - labCenters[k * 3 + 2];
      const dist = deltaL * deltaL + deltaA * deltaA + deltaB * deltaB;
      if (dist < bestDist) {
        bestDist = dist;
        best = k;
      }
    }
    indices[i] = best;
  }
  return indices;
}

/**
 * k-means++ in CIELAB over proxy pixels. Deterministic LCG seeding.
 * @returns {{ paletteRgb: number[][], labCenters: Float32Array }}
 */
function labKMeansPalette(proxyPixels, colorCount) {
  const pixelCount = proxyPixels.length >> 2;
  const lab = new Float32Array(pixelCount * 3);
  const labTriple = [0, 0, 0];
  let i;
  let k;
  for (i = 0; i < pixelCount; i++) {
    rgbToLabTriple(proxyPixels[i * 4], proxyPixels[i * 4 + 1], proxyPixels[i * 4 + 2], labTriple);
    lab[i * 3] = labTriple[0];
    lab[i * 3 + 1] = labTriple[1];
    lab[i * 3 + 2] = labTriple[2];
  }
  const clusterCount = Math.min(colorCount, pixelCount);
  const centers = new Float32Array(clusterCount * 3);
  const nearestDistSq = new Float32Array(pixelCount);
  let lcgState = 0x9e3779b9;
  function nextRandom() {
    lcgState = (lcgState * 1103515245 + 12345) & 0x7fffffff;
    return lcgState / 0x7fffffff;
  }
  const firstSeed = (nextRandom() * pixelCount) | 0;
  centers[0] = lab[firstSeed * 3];
  centers[1] = lab[firstSeed * 3 + 1];
  centers[2] = lab[firstSeed * 3 + 2];
  for (i = 0; i < pixelCount; i++) nearestDistSq[i] = Infinity;
  for (k = 1; k < clusterCount; k++) {
    let distanceSum = 0;
    const prev = (k - 1) * 3;
    for (i = 0; i < pixelCount; i++) {
      const deltaL = lab[i * 3] - centers[prev];
      const deltaA = lab[i * 3 + 1] - centers[prev + 1];
      const deltaB = lab[i * 3 + 2] - centers[prev + 2];
      const distSq = deltaL * deltaL + deltaA * deltaA + deltaB * deltaB;
      if (distSq < nearestDistSq[i]) nearestDistSq[i] = distSq;
      distanceSum += nearestDistSq[i];
    }
    let target = nextRandom() * distanceSum;
    let pick = pixelCount - 1;
    for (i = 0; i < pixelCount; i++) {
      target -= nearestDistSq[i];
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    centers[k * 3] = lab[pick * 3];
    centers[k * 3 + 1] = lab[pick * 3 + 1];
    centers[k * 3 + 2] = lab[pick * 3 + 2];
  }
  const assignment = new Uint16Array(pixelCount);
  const sums = new Float64Array(clusterCount * 3);
  const counts = new Uint32Array(clusterCount);
  for (let iteration = 0; iteration < 14; iteration++) {
    for (i = 0; i < pixelCount; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (k = 0; k < clusterCount; k++) {
        const deltaL = lab[i * 3] - centers[k * 3];
        const deltaA = lab[i * 3 + 1] - centers[k * 3 + 1];
        const deltaB = lab[i * 3 + 2] - centers[k * 3 + 2];
        const dist = deltaL * deltaL + deltaA * deltaA + deltaB * deltaB;
        if (dist < bestDist) {
          bestDist = dist;
          best = k;
        }
      }
      assignment[i] = best;
    }
    sums.fill(0);
    counts.fill(0);
    for (i = 0; i < pixelCount; i++) {
      const cluster = assignment[i];
      sums[cluster * 3] += lab[i * 3];
      sums[cluster * 3 + 1] += lab[i * 3 + 1];
      sums[cluster * 3 + 2] += lab[i * 3 + 2];
      counts[cluster]++;
    }
    for (k = 0; k < clusterCount; k++) if (counts[k]) {
      centers[k * 3] = sums[k * 3] / counts[k];
      centers[k * 3 + 1] = sums[k * 3 + 1] / counts[k];
      centers[k * 3 + 2] = sums[k * 3 + 2] / counts[k];
    }
  }
  const paletteRgb = [];
  for (k = 0; k < clusterCount; k++) paletteRgb.push(labTripleToRgb(centers[k * 3], centers[k * 3 + 1], centers[k * 3 + 2]));
  return { paletteRgb: paletteRgb, labCenters: centers };
}

/**
 * Perceptual palette quantize for a flat, posterised look on photographs.
 *
 * Clusters colours in CIELAB and maps every pixel to its nearest cluster in the
 * same space, so both the palette and the per-pixel choice follow perceived
 * colour rather than raw RGB distance. A variance-in-RGB quantiser instead
 * spends most of its colours subdividing whichever region has the most pixels —
 * on a photo that is the dark background, which splinters into near-blacks and
 * navies while saturated regions (a beige beak, a red eye-ring) never earn a
 * colour. CIELAB collapses the low-chroma background to one entry and lets the
 * vivid minorities keep theirs.
 *
 * The palette is fitted on a downsampled proxy (clustering full megapixels is
 * slow and lets fine texture dominate), but assignment runs on every original
 * pixel so region edges stay crisp.
 *
 * Returns { indices: Uint8Array(width*height), palette } like quantizeRgbaBuffer.
 */
function quantizePerceptualViaProxy(rgbaBuffer, colorCount, width, height, maxProxyDim) {
  // Proxy size scales with the image (~quarter resolution), clamped to keep
  // k-means bounded. A small fixed proxy averages small saturated features (a
  // red eye-ring, a bright reflection) out of existence before clustering, so on
  // a large image no red/highlight colour survives; a proportional proxy keeps
  // them at any document size.
  if (maxProxyDim == null) maxProxyDim = Math.min(2000, Math.max(512, Math.round(Math.max(width, height) / 4)));
  const originalPixels = new Uint8Array(rgbaBuffer);
  const step = Math.max(1, Math.ceil(Math.max(width, height) / maxProxyDim));
  const proxyWidth = Math.max(1, Math.floor(width / step));
  const proxyHeight = Math.max(1, Math.floor(height / step));
  const proxy = new Uint8Array(proxyWidth * proxyHeight * 4);
  for (let proxyY = 0; proxyY < proxyHeight; proxyY++) {
    for (let proxyX = 0; proxyX < proxyWidth; proxyX++) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      for (let dy = 0; dy < step; dy++) {
        let srcRow = ((proxyY * step + dy) * width + proxyX * step) * 4;
        for (let dx = 0; dx < step; dx++) {
          sumR += originalPixels[srcRow];
          sumG += originalPixels[srcRow + 1];
          sumB += originalPixels[srcRow + 2];
          sumA += originalPixels[srcRow + 3];
          srcRow += 4;
        }
      }
      const area = step * step;
      const outIndex = (proxyY * proxyWidth + proxyX) * 4;
      proxy[outIndex] = sumR / area;
      proxy[outIndex + 1] = sumG / area;
      proxy[outIndex + 2] = sumB / area;
      proxy[outIndex + 3] = sumA / area;
    }
  }
  const clusters = labKMeansPalette(proxy, colorCount);
  const palette = [];
  for (let c = 0; c < clusters.paletteRgb.length; c++) {
    const rgb = clusters.paletteRgb[c];
    palette.push(["", { red: rgb[0], green: rgb[1], blue: rgb[2], alpha: 255 }]);
  }
  const indices = assignNearestLabCluster(originalPixels, width * height, clusters.labCenters, clusters.paletteRgb.length);
  return { indices: indices, palette: palette };
}

function transformPathCoords(srcCoords, affine, outCoords) {
  for (let i = 0; i < srcCoords.length; i += 2) {
    const x = srcCoords[i];
    const y = srcCoords[i + 1];
    outCoords[i] = x * affine.m00 + y * affine.m10 + affine.translateX;
    outCoords[i + 1] = x * affine.m01 + y * affine.m11 + affine.translateY;
  }
}

function pathBounds(coords, startIdx, endIdx) {
  if (startIdx == null) startIdx = 0;
  if (endIdx == null) endIdx = coords.length;
  let minX = 99999999999;
  let maxX = -minX;
  let minY = 99999999999;
  let maxY = -minY;
  for (let i = startIdx; i < endIdx; i += 2) {
    const x = coords[i];
    const y = coords[i + 1];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return new IndexRect(minX, minY, maxX - minX, maxY - minY);
}

/** Sort four palette ids ascending via adjacent swaps (network of 6). */
function sortFourPaletteIds(nw, n, w, c) {
  let tmp;
  if (c < w) { tmp = c; c = w; w = tmp; }
  if (w < n) { tmp = w; w = n; n = tmp; }
  if (n < nw) { tmp = n; n = nw; nw = tmp; }
  if (c < w) { tmp = c; c = w; w = tmp; }
  if (w < n) { tmp = w; w = n; n = tmp; }
  if (c < w) { tmp = c; c = w; w = tmp; }
  return [nw, n, w, c];
}

function countDistinctCornerAdjacencies(nw, n, w, c) {
  let cornerCount = 0;
  if (nw != n) cornerCount++;
  if (n != w) cornerCount++;
  if (w != c) cornerCount++;
  if (c != nw) cornerCount++;
  return cornerCount;
}

/** Mark pixels where a 2×2 neighborhood is a saddle or has ≥3 color corners. */
function markSaddleCornerFlags(workingMap, width, height) {
  const saddleFlags = new Uint8Array(width * height);
  saddleFlags[1 * width + 1] = saddleFlags[(height - 1) * width + 1] = saddleFlags[1 * width + width - 1] = saddleFlags[(height - 1) * width + width - 1] = 1;
  for (let row = 1; row < height; row++) {
    for (let col = 1; col < width; col++) {
      const idx = row * width + col;
      let nw = workingMap[idx - width - 1];
      let n = workingMap[idx - width];
      let w = workingMap[idx - 1];
      let c = workingMap[idx];
      const isSaddle = nw == c && n == w && nw != n;
      const sorted = sortFourPaletteIds(nw, n, w, c);
      nw = sorted[0];
      n = sorted[1];
      w = sorted[2];
      c = sorted[3];
      if (countDistinctCornerAdjacencies(nw, n, w, c) >= 3 || isSaddle) saddleFlags[idx] = 1;
    }
  }
  return saddleFlags;
}

function floodEraseRegion(indexMap, width, height, startCol, startRow) {
  const stack = [startRow * width + startCol];
  const regionValue = indexMap[startRow * width + startCol];
  indexMap[startRow * width + startCol] = 65535;
  while (stack.length != 0) {
    const idx = stack.pop();
    indexMap[idx] = 0;
    if (indexMap[idx + width] == regionValue) {
      stack.push(idx + width);
      indexMap[idx + width] = 65535;
    }
    if (indexMap[idx - width] == regionValue) {
      stack.push(idx - width);
      indexMap[idx - width] = 65535;
    }
    if (indexMap[idx - 1] == regionValue) {
      stack.push(idx - 1);
      indexMap[idx - 1] = 65535;
    }
    if (indexMap[idx + 1] == regionValue) {
      stack.push(idx + 1);
      indexMap[idx + 1] = 65535;
    }
  }
}

function sampleBoundaryNeighbor(indexMap, width, col, row, corner) {
  const idx = row * width + col;
  let neighborIdx = 0;
  if (corner == 0) neighborIdx = idx - width;
  else if (corner == 1) neighborIdx = idx;
  else if (corner == 2) neighborIdx = idx - 1;
  else if (corner == 3) neighborIdx = idx - width - 1;
  return indexMap[neighborIdx];
}

function traceBoundaryLoop(indexMap, width, height, startCol, startRow) {
  const stepDirs = [0, -1, 1, 0, 0, 1, -1, 0];
  let dir = 1;
  const loopCoords = [];
  let col = startCol;
  let row = startRow;
  const regionValue = sampleBoundaryNeighbor(indexMap, width, col, row, dir);
  do {
    loopCoords.push(col, row);
    col += stepDirs[dir * 2];
    row += stepDirs[dir * 2 + 1];
    if (sampleBoundaryNeighbor(indexMap, width, col, row, dir) != regionValue) dir = dir + 1 & 3;
    else if (sampleBoundaryNeighbor(indexMap, width, col, row, dir + 3 & 3) != regionValue) dir = dir;
    else if (sampleBoundaryNeighbor(indexMap, width, col, row, dir + 2 & 3) != regionValue) dir = dir + 3 & 3;
  } while (col != startCol || row != startRow);
  return loopCoords;
}

function buildRegionBoundaries(indexMap, width, height) {
  const pixelCount = width * height;
  const workingMap = new Uint16Array(width * height);
  for (let i = 0; i < pixelCount; i++) workingMap[i] = indexMap[i];
  const saddleFlags = markSaddleCornerFlags(workingMap, width, height);
  const boundaries = [];
  for (let row = 1; row < height; row++) {
    for (let col = 1; col < width; col++) {
      const idx = row * width + col;
      if (workingMap[idx] != workingMap[idx - 1]) {
        const loopCoords = traceBoundaryLoop(workingMap, width, height, col, row);
        const cornerIndices = [];
        for (let coordIdx = 0; coordIdx < loopCoords.length; coordIdx += 2)
          if (saddleFlags[loopCoords[coordIdx + 1] * width + loopCoords[coordIdx]] == 1) cornerIndices.push(coordIdx >>> 1);
        boundaries.push([loopCoords, cornerIndices]);
        floodEraseRegion(workingMap, width, height, col, row);
      }
    }
  }
  return boundaries;
}

function douglasPeucker(coords, tolerance) {
  const lastIdx = coords.length - 2;
  const startX = coords[0];
  const startY = coords[1];
  const endX = coords[lastIdx];
  const endY = coords[lastIdx + 1];
  const dx = endX - startX;
  const dy = endY - startY;
  const invLen = 1 / Math.sqrt(dx * dx + dy * dy);
  const lineCross = endX * startY - endY * startX;
  let farthestIdx = -1;
  let maxDist = -1;
  let farthestDistSq = 0;
  for (let i = 2; i < lastIdx; i += 2) {
    const px = coords[i];
    const py = coords[i + 1];
    const distSq = py * py * 1e6 + px * px;
    const perpDist = Math.abs(dy * px - dx * py + lineCross) * invLen;
    if (perpDist > maxDist || perpDist == maxDist && distSq > farthestDistSq) {
      maxDist = perpDist;
      farthestIdx = i;
      farthestDistSq = distSq;
    }
  }
  if (maxDist < tolerance) return [startX, startY, endX, endY];
  const leftHalf = douglasPeucker(coords.slice(0, farthestIdx + 2), tolerance);
  const rightHalf = douglasPeucker(coords.slice(farthestIdx), tolerance);
  for (let i = 2; i < rightHalf.length; i++) leftHalf.push(rightHalf[i]);
  return leftHalf;
}

function simplifyClosedPath(coords, tolerance, cornerIndices) {
  if (tolerance == null || tolerance == 0) return coords;
  const lastIdx = coords.length - 2;
  if (cornerIndices && cornerIndices.length != 0) {
    const firstCornerIdx = cornerIndices[0] * 2;
    const lastCornerIdx = cornerIndices[cornerIndices.length - 1] * 2;
    const prevCornerIdx = firstCornerIdx == 0 ? lastIdx : firstCornerIdx - 2;
    let merged = coords.slice(lastCornerIdx);
    for (let i = 0; i < firstCornerIdx; i++) merged.push(coords[i]);
    if (firstCornerIdx == lastCornerIdx) merged.push(.9 * coords[firstCornerIdx] + .1 * coords[prevCornerIdx], .9 * coords[firstCornerIdx + 1] + .1 * coords[prevCornerIdx + 1]);
    else merged.push(coords[firstCornerIdx], coords[firstCornerIdx + 1]);
    merged = douglasPeucker(merged, tolerance);
    merged.pop();
    merged.pop();
    for (let cornerIdx = 0; cornerIdx < cornerIndices.length - 1; cornerIdx++) {
      let segment = coords.slice(cornerIndices[cornerIdx] * 2, cornerIndices[cornerIdx + 1] * 2 + 2);
      segment = douglasPeucker(segment, tolerance);
      for (let segIdx = 0; segIdx < segment.length - 2; segIdx++) merged.push(segment[segIdx]);
    }
    return merged;
  }
  let closed = coords.slice(0);
  closed.push(.9 * coords[0] + .1 * coords[lastIdx], .9 * coords[1] + .1 * coords[lastIdx + 1]);
  closed = douglasPeucker(closed, tolerance);
  closed.pop();
  closed.pop();
  return closed;
}

function pointInPolygon(coords, testX, testY) {
  const vertexCount = coords.length >> 1;
  let prevX;
  let prevDy = coords[2 * vertexCount - 3] - testY;
  let prevDx = coords[2 * vertexCount - 2] - testX;
  let prevPy = coords[2 * vertexCount - 1] - testY;
  let upward = prevPy > prevDy;
  let crossings = 0;
  for (let i = 0; i < vertexCount; i++) {
    prevX = prevDx;
    prevDy = prevPy;
    prevDx = coords[2 * i] - testX;
    prevPy = coords[2 * i + 1] - testY;
    if (prevDy == prevPy) continue;
    upward = prevPy > prevDy;
  }
  for (let i = 0; i < vertexCount; i++) {
    prevX = prevDx;
    prevDy = prevPy;
    prevDx = coords[2 * i] - testX;
    prevPy = coords[2 * i + 1] - testY;
    if (prevDy < 0 && prevPy < 0) continue;
    if (prevDy > 0 && prevPy > 0) continue;
    if (prevX < 0 && prevDx < 0) continue;
    if (prevDy == prevPy && Math.min(prevX, prevDx) <= 0) return true;
    if (prevDy == prevPy) continue;
    const intersectX = prevX + (prevDx - prevX) * -prevDy / (prevPy - prevDy);
    if (intersectX == 0) return true;
    if (intersectX > 0) crossings++;
    if (prevDy == 0 && upward && prevPy > prevDy) crossings--;
    if (prevDy == 0 && !upward && prevPy < prevDy) crossings--;
    upward = prevPy > prevDy;
  }
  return (crossings & 1) == 1;
}

/** Nest each shape under the nearest enclosing parent (back-to-front order). */
function assignShapeParents(shapes) {
  for (let shapeIdx = 1; shapeIdx < shapes.length; shapeIdx++) {
    const shape = shapes[shapeIdx];
    const pathCoords = shape.path.coords;
    const edgeStartX = pathCoords[0];
    const edgeStartY = pathCoords[1];
    const edgeEndX = pathCoords[2];
    const edgeEndY = pathCoords[3];
    const dx = edgeEndX - edgeStartX;
    const dy = edgeEndY - edgeStartY;
    const testX = edgeStartX + .5 * dx - .001 * dy;
    const testY = edgeStartY + .5 * dy + .001 * dx;
    for (let parentIdx = shapeIdx - 1; parentIdx >= 0; parentIdx--) {
      const candidate = shapes[parentIdx];
      if (!candidate.bounds.containsRect(shape.bounds)) continue;
      if (!pointInPolygon(candidate.path.coords, testX, testY)) continue;
      shape.parent = parentIdx;
      break;
    }
  }
}

function tracePolygons(indexMap, width, height, simplifyTolerance) {
  const boundaries = buildRegionBoundaries(indexMap, width, height);
  const shapes = [];
  for (let boundaryIdx = 0; boundaryIdx < boundaries.length; boundaryIdx++) {
    const boundary = boundaries[boundaryIdx];
    let coords = boundary[0];
    const commands = ["M"];
    const colorIndex = indexMap[coords[1] * width + coords[0]];
    if (coords.length > 8) coords = simplifyClosedPath(coords, simplifyTolerance, boundary[1]);
    if (coords.length <= 4) continue;
    for (let cmdIdx = 2; cmdIdx < coords.length; cmdIdx += 2) commands.push("L");
    commands.push("Z");
    shapes.push({
      path: {
        coords: coords,
        commands: commands,
      },
      color: colorIndex,
      parent: -1,
      bounds: pathBounds(coords),
    });
  }
  assignShapeParents(shapes);
  return shapes;
}

function floodMeasureRegion(indexMap, width, height, startCol, startRow, visited, regionIds, regionId) {
  const stack = [startCol, startRow];
  const regionValue = indexMap[startRow * width + startCol];
  let pixelCount = 0;
  const boundary = [];
  visited[startRow * width + startCol] = 1;
  while (stack.length != 0) {
    const row = stack.pop();
    const col = stack.pop();
    const idx = row * width + col;
    regionIds[idx] = regionId;
    pixelCount++;
    if (row != height - 1)
      if (indexMap[idx + width] == regionValue) {
        if (visited[idx + width] == 0) {
          stack.push(col, row + 1);
          visited[idx + width] = 1;
        }
      } else boundary.push(col, row + 1);
    if (row != 0)
      if (indexMap[idx - width] == regionValue) {
        if (visited[idx - width] == 0) {
          stack.push(col, row - 1);
          visited[idx - width] = 1;
        }
      } else boundary.push(col, row - 1);
    if (col != width - 1)
      if (indexMap[idx + 1] == regionValue) {
        if (visited[idx + 1] == 0) {
          stack.push(col + 1, row);
          visited[idx + 1] = 1;
        }
      } else boundary.push(col + 1, row);
    if (col != 0)
      if (indexMap[idx - 1] == regionValue) {
        if (visited[idx - 1] == 0) {
          stack.push(col - 1, row);
          visited[idx - 1] = 1;
        }
      } else boundary.push(col - 1, row);
  }
  return [pixelCount, boundary];
}

/** Enumerate connected components; return regions and count of undersized ones. */
function measureAllRegions(indexMap, width, height, visited, regionIds, minArea) {
  const regions = [];
  let smallCount = 0;
  visited.fill(0);
  regionIds.fill(0);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col;
      if (visited[idx] == 0) {
        const regionId = regions.length;
        const measure = floodMeasureRegion(indexMap, width, height, col, row, visited, regionIds, regionId);
        regions.push([regionId, col, row, measure[0], measure[1], indexMap[idx]]);
        if (measure[0] < minArea) smallCount++;
      }
    }
  }
  return { regions: regions, smallCount: smallCount };
}

/** Link each small region to its largest abutting neighbor via UnionFind. */
function linkSmallRegionsToLargestNeighbor(regions, regionIds, width, minArea) {
  const regionCount = regions.length;
  const unionFind = new UnionFind(regionCount);
  const adjacency = [];
  for (let i = 0; i < regionCount; i++) adjacency.push([]);
  for (let i = 0; i < regionCount; i++) {
    const region = regions[i];
    const boundary = region[4];
    let bestNeighborId = 0;
    let bestNeighborArea = 0;
    if (region[3] >= minArea) continue;
    const regionId = region[0];
    for (let boundaryIdx = 0; boundaryIdx < boundary.length; boundaryIdx += 2) {
      const neighborId = regionIds[boundary[boundaryIdx + 1] * width + boundary[boundaryIdx]];
      const neighbor = regions[neighborId];
      if (neighbor[3] > bestNeighborArea) {
        bestNeighborArea = neighbor[3];
        bestNeighborId = neighborId;
      }
    }
    if (unionFind.find(regionId) != unionFind.find(bestNeighborId)) {
      unionFind.link(regionId, bestNeighborId);
      adjacency[regionId].push(bestNeighborId);
      adjacency[bestNeighborId].push(regionId);
    }
  }
  return adjacency;
}

function buildMergeColorTargets(regions, adjacency, indexMap, width) {
  const regionCount = regions.length;
  const mergeTarget = new Uint32Array(regionCount);
  mergeTarget.fill(4294967295);
  const mergeColor = new Uint32Array(regionCount);
  for (let i = 0; i < regionCount; i++) {
    if (mergeTarget[i] != 4294967295 || adjacency[i].length == 0) continue;
    const component = [i];
    const stack = [i];
    let largestId = i;
    let largestArea = regions[i][3];
    while (stack.length != 0) {
      const nodeId = stack.pop();
      const neighbors = adjacency[nodeId];
      for (let neighborIdx = 0; neighborIdx < neighbors.length; neighborIdx++) {
        const neighborId = neighbors[neighborIdx];
        if (component.indexOf(neighborId) == -1) {
          component.push(neighborId);
          stack.push(neighborId);
          const neighborRegion = regions[neighborId];
          if (neighborRegion[3] > largestArea) {
            largestArea = neighborRegion[3];
            largestId = neighborId;
          }
        }
      }
    }
    for (let componentIdx = 0; componentIdx < component.length; componentIdx++) {
      mergeTarget[component[componentIdx]] = largestId;
      const targetRegion = regions[largestId];
      mergeColor[component[componentIdx]] = indexMap[targetRegion[2] * width + targetRegion[1]];
    }
  }
  return { mergeTarget: mergeTarget, mergeColor: mergeColor };
}

function applyMergeTargets(indexMap, width, height, regionIds, mergeTarget, mergeColor) {
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col;
      const targetId = mergeTarget[regionIds[idx]];
      if (targetId != 4294967295) indexMap[idx] = mergeColor[targetId];
    }
  }
}

function mergeSmallRegions(indexMap, width, height, minArea) {
  if (minArea == 0) return;
  const regionIds = new Uint32Array(width * height);
  const visited = new Uint8Array(width * height);
  while (true) {
    const measured = measureAllRegions(indexMap, width, height, visited, regionIds, minArea);
    if (measured.smallCount == 0) break;
    const adjacency = linkSmallRegionsToLargestNeighbor(measured.regions, regionIds, width, minArea);
    const targets = buildMergeColorTargets(measured.regions, adjacency, indexMap, width);
    applyMergeTargets(indexMap, width, height, regionIds, targets.mergeTarget, targets.mergeColor);
  }
}

/** Copy a width×height index map into a (width+2)×(height+2) buffer with a 1px border. */
function padIndexMapOnePixel(indices, width, height) {
  const paddedWidth = width + 2;
  const paddedHeight = height + 2;
  const padded = new Uint8Array(paddedWidth * paddedHeight);
  copyIndexBufferRect(
    indices,
    new IndexRect(1, 1, width, height),
    padded,
    new IndexRect(0, 0, paddedWidth, paddedHeight),
  );
  return { buffer: padded, width: paddedWidth, height: paddedHeight };
}

export {
  IndexRect,
  Affine2D,
  UnionFind,
  copyIndexBufferRect,
  quantizeRgbaBuffer,
  quantizePerceptualViaProxy,
  mergeSmallRegions,
  tracePolygons,
  transformPathCoords,
  pathBounds,
  pointInPolygon,
  padIndexMapOnePixel,
};
