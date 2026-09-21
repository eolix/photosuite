/**
 * Voronoi-style mosaic quantizer for posterize / pixelate effects.
 *
 * Builds a jittered codebook of sample points over a cell grid, then for each
 * output pixel blends the nearest (and optionally second-nearest) codebook
 * colors with an optional border or dither-palette fill.
 */

const INF_DIST_SQ = 1e9;
const BORDER_CELL_BASE = 3;
const BORDER_CELL_SCALE = 0.75;
const DITHER_CELL_SCALE = 2.2;
const BORDER_INIT_JITTER = 64;
const CHANNEL_COUNT = 4;

/** 3×3 neighborhood offsets in codebook cell index space. */
const NEIGHBOR_CELL_OFFSETS = Object.freeze([
  -1, 0, 1,
]);

/**
 * @param {number} gridCols
 * @returns {number[]} flat neighbor offsets into codebook XY (×2 stride)
 */
function buildNeighborOffsets(gridCols) {
  const offsets = [];
  for (let rowDelta of [-1, 0, 1]) {
    for (let colDelta of NEIGHBOR_CELL_OFFSETS) {
      offsets.push((rowDelta * gridCols + colDelta));
    }
  }
  return offsets;
}

/**
 * @param {number[]} codebookXY
 * @param {number} pointIdx even index into codebookXY
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
export function squaredDist(codebookXY, pointIdx, x, y) {
  const dx = x - codebookXY[pointIdx];
  const dy = y - codebookXY[pointIdx + 1];
  return dx * dx + dy * dy;
}

/**
 * Signed distance from (x, y) to the perpendicular bisector of codebook points A and B.
 * @param {number[]} codebookXY
 * @param {number} idxA
 * @param {number} idxB
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
export function bisectorDist(codebookXY, idxA, idxB, x, y) {
  const ax = codebookXY[idxA];
  const ay = codebookXY[idxA + 1];
  const bx = codebookXY[idxB];
  const by = codebookXY[idxB + 1];
  const midX = (ax + bx) * 0.5;
  const midY = (ay + by) * 0.5;
  const perpX = midX + (by - ay);
  const perpY = midY - (bx - ax);
  const lineDx = perpX - midX;
  const lineDy = perpY - midY;
  return Math.abs(lineDy * x - lineDx * y + perpX * midY - perpY * midX) /
    Math.sqrt(lineDx * lineDx + lineDy * lineDy);
}

/**
 * Sample jittered codebook sites and colors from the source image.
 * @returns {{ codebookXY: number[], codebookRgba: Uint8Array, gridCols: number, gridRows: number, cellSize: number, borderInset: number }}
 */
function buildCodebook(srcRgba, width, height, cellSize, borderRgb, ditherPalette) {
  let workingCellSize = cellSize;
  let borderInset = 0;
  if (borderRgb) {
    borderInset = workingCellSize * 0.5;
    workingCellSize = BORDER_CELL_BASE + Math.round((workingCellSize - BORDER_CELL_BASE) * BORDER_CELL_SCALE);
  }
  if (ditherPalette) {
    workingCellSize = Math.round(workingCellSize * DITHER_CELL_SCALE);
  }

  const invCellSize = 1 / workingCellSize;
  const gridCols = Math.floor(width * invCellSize) + 1;
  const gridRows = Math.floor(height * invCellSize) + 1;
  const codebookXY = [];
  const codebookRgba = new Uint8Array(gridCols * gridRows * CHANNEL_COUNT);
  const jitterScale = ditherPalette ? 0.5 : 1;
  const initJitter = borderRgb ? BORDER_INIT_JITTER : 0;

  for (let gridRow = 0; gridRow < gridRows; gridRow++) {
    const rowJitter = ditherPalette ? 0.5 * (gridRow & 1) : 0;
    for (let gridCol = 0; gridCol < gridCols; gridCol++) {
      const sampleX = (gridCol + Math.random() * jitterScale + rowJitter) * workingCellSize;
      const sampleY = (gridRow + Math.random() * jitterScale) * workingCellSize;
      codebookXY.push(sampleX, sampleY);
      const pxCol = Math.min(width - 1, Math.floor(sampleX));
      const pxRow = Math.min(height - 1, Math.floor(sampleY));
      const srcOff = (pxRow * width + pxCol) * CHANNEL_COUNT;
      const codeOff = (gridRow * gridCols + gridCol) * CHANNEL_COUNT;
      for (let ch = 0; ch < CHANNEL_COUNT; ch++) {
        codebookRgba[codeOff + ch] = Math.max(
          0,
          Math.min(255, Math.floor(srcRgba[srcOff + ch] + (Math.random() - 0.5) * initJitter)),
        );
      }
    }
  }

  return {
    codebookXY,
    codebookRgba,
    gridCols,
    gridRows,
    cellSize: workingCellSize,
    borderInset,
    invCellSize,
  };
}

/**
 * Find the three nearest codebook sites among the 3×3 neighborhood of a cell.
 * @returns {{ nearestIdx: number, nearestDistSq: number, secondIdx: number, secondDistSq: number, thirdIdx: number, thirdDistSq: number }}
 */
function findNearestInNeighborhood(codebookXY, codebookLen, neighborOffsets, cellIdx, pixelX, pixelY) {
  let nearestIdx = 0;
  let nearestDistSq = INF_DIST_SQ;
  let secondIdx = 0;
  let secondDistSq = INF_DIST_SQ;
  let thirdIdx = 0;
  let thirdDistSq = INF_DIST_SQ;

  for (let ni = 0; ni < neighborOffsets.length; ni++) {
    const neighborIdx = (cellIdx + neighborOffsets[ni]) * 2;
    if (neighborIdx < 0 || neighborIdx >= codebookLen) continue;
    const distSq = squaredDist(codebookXY, neighborIdx, pixelX, pixelY);
    if (distSq < thirdDistSq) {
      if (distSq < secondDistSq) {
        if (distSq < nearestDistSq) {
          thirdIdx = secondIdx;
          thirdDistSq = secondDistSq;
          secondIdx = nearestIdx;
          secondDistSq = nearestDistSq;
          nearestIdx = neighborIdx;
          nearestDistSq = distSq;
        } else {
          thirdIdx = secondIdx;
          thirdDistSq = secondDistSq;
          secondIdx = neighborIdx;
          secondDistSq = distSq;
        }
      } else {
        thirdIdx = neighborIdx;
        thirdDistSq = distSq;
      }
    }
  }

  return { nearestIdx, nearestDistSq, secondIdx, secondDistSq, thirdIdx, thirdDistSq };
}

/**
 * Blend nearest / second / fill colors into one destination pixel (alpha from source).
 */
function writeBlendedPixel(
  dstRgba,
  srcRgba,
  dstOff,
  codebookRgba,
  nearestIdx,
  secondIdx,
  weightNear,
  weightSecond,
  fillRgb,
) {
  const weightFill = 1 - weightSecond - weightNear;
  const nearColorOff = nearestIdx << 1;
  const secondColorOff = secondIdx << 1;
  dstRgba[dstOff] = Math.floor(
    0.5 + weightNear * codebookRgba[nearColorOff] + weightSecond * codebookRgba[secondColorOff] + weightFill * fillRgb[0],
  );
  dstRgba[dstOff + 1] = Math.floor(
    0.5 + weightNear * codebookRgba[nearColorOff + 1] + weightSecond * codebookRgba[secondColorOff + 1] + weightFill * fillRgb[1],
  );
  dstRgba[dstOff + 2] = Math.floor(
    0.5 + weightNear * codebookRgba[nearColorOff + 2] + weightSecond * codebookRgba[secondColorOff + 2] + weightFill * fillRgb[2],
  );
  dstRgba[dstOff + 3] = srcRgba[dstOff + 3];
}

/** Quantise into `cellSize` blocks, outlining each block in `borderRgb`. */
export function quantizeWithBorder(srcRgba, width, height, dstRgba, cellSize, borderRgb) {
  quantizeImpl(srcRgba, width, height, dstRgba, cellSize, borderRgb, null, 0);
}

export function quantize(srcRgba, width, height, dstRgba, cellSize) {
  quantizeImpl(srcRgba, width, height, dstRgba, cellSize, null, null, 0);
}

export function quantizeDithered(srcRgba, width, height, dstRgba, cellSize, fillRgb, borderThickness) {
  quantizeImpl(srcRgba, width, height, dstRgba, cellSize, null, fillRgb, borderThickness * 0.5);
}

export function quantizeImpl(
  srcRgba,
  width,
  height,
  dstRgba,
  cellSize,
  borderRgb,
  ditherPalette,
  edgeMargin,
) {
  const codebook = buildCodebook(srcRgba, width, height, cellSize, borderRgb, ditherPalette);
  const { codebookXY, codebookRgba, gridCols, borderInset, invCellSize } = codebook;
  const fillRgb = borderRgb ? borderRgb : ditherPalette ? ditherPalette : [0, 0, 0];
  const codebookLen = gridCols * codebook.gridRows * 2;
  const neighborOffsets = buildNeighborOffsets(gridCols);

  let nearestIdx = 0;
  let nearestDistSq = INF_DIST_SQ;
  let secondIdx = 0;
  let secondDistSq = INF_DIST_SQ;
  let thirdIdx = 0;
  let thirdDistSq = INF_DIST_SQ;
  let skipSearchCount = 0;
  let distToSecond = 0;
  let distToNearest = 0;

  for (let row = 0; row < height; row++) {
    skipSearchCount = 0;
    for (let col = 0; col < width; col++) {
      const pixelX = col + 0.5;
      const pixelY = row + 0.5;
      const gridY = Math.floor(pixelY * invCellSize);
      const gridX = Math.floor(pixelX * invCellSize);
      const cellIdx = gridY * gridCols + gridX;
      let weightNear = 0;
      let weightSecond = 0;

      if (skipSearchCount > 1 + edgeMargin) {
        nearestDistSq = squaredDist(codebookXY, nearestIdx, pixelX, pixelY);
        distToNearest = Math.sqrt(nearestDistSq);
        skipSearchCount--;
      } else {
        const nearest = findNearestInNeighborhood(
          codebookXY,
          codebookLen,
          neighborOffsets,
          cellIdx,
          pixelX,
          pixelY,
        );
        nearestIdx = nearest.nearestIdx;
        nearestDistSq = nearest.nearestDistSq;
        secondIdx = nearest.secondIdx;
        secondDistSq = nearest.secondDistSq;
        thirdIdx = nearest.thirdIdx;
        thirdDistSq = nearest.thirdDistSq;
        distToNearest = Math.sqrt(nearestDistSq);
        distToSecond = Math.sqrt(secondDistSq);
        skipSearchCount = distToSecond - (distToNearest + distToSecond) * 0.5;
      }

      if (ditherPalette == null) {
        const midDist = (distToNearest + distToSecond) * 0.5;
        const borderClip = borderRgb ? Math.max(0, midDist - borderInset) : 0;
        weightNear = Math.max(0, Math.min(1, 0.5 + midDist - distToNearest - borderClip));
        weightSecond = Math.max(0, Math.min(1, 1 - (0.5 + midDist - distToNearest) - borderClip));
      } else {
        const bisectorDistVal = Math.min(
          bisectorDist(codebookXY, nearestIdx, secondIdx, pixelX, pixelY),
          bisectorDist(codebookXY, nearestIdx, thirdIdx, pixelX, pixelY),
        );
        weightNear = Math.max(0, Math.min(1, bisectorDistVal - edgeMargin * 0.5));
        if (pixelX < edgeMargin || width - edgeMargin < pixelX || pixelY < edgeMargin || height - edgeMargin < pixelY) {
          weightNear = 0;
        }
        weightSecond = 0;
      }

      writeBlendedPixel(
        dstRgba,
        srcRgba,
        row * width + col << 2,
        codebookRgba,
        nearestIdx,
        secondIdx,
        weightNear,
        weightSecond,
        fillRgb,
      );
    }
  }
}

