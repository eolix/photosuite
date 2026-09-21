/**
 * Content-aware healing fill: FWHT patch features, KD nearest-neighbor offset
 * voting, graph-cut label optimization, and Poisson blending into the destination.
 */

import { Rect } from "../../core/math/rect.js";
import { computeMinCut } from "./posterize.js";
import { allocBuffer } from "./buffer-utils.js";
import { contentBoundsChannel, copyChannel, copyPixels, resampleUint32UniformScale, resampleUint8UniformScale, round } from "./pixel-ops.js";
import { rgbaToYcbcr } from "./color-math.js";
import { solvePoissonFill } from "./content-aware-fill.js";



const FEATURE_RECORD_SIZE = 24;
const FWHT_SIZE = 64;
const KD_LEAF = 99;
const KD_LEAF_THRESHOLD = 16;
const KD_AXIS_RANGE_MIN = 3e4;
const KD_AXIS_RANGE_MAX = -3e4;
const INFINITE_COST = 1e9;
const BEST_COST_SENTINEL = 1e99;
const RGBA_INVALID_COST = 1e7;
const DOWNSAMPLE_AVG_TARGET = 400;
const PATCH_HALF = 3;
const Y_COEFF_COUNT = 12;
const CHROMA_COEFF_COUNT = 4;
const FEATURE_COEFF_START = 4;
const ALPHA_OPAQUE_MIN = 200;
const MASK_HOLE = 255;
const LABEL_SOURCE = -1;
const LABEL_TRANSPARENT = -2;
const MAX_SEED_OFFSETS = 60;
const MIN_OFFSET_DIST_SQ = 25;
const OPTIMIZE_TIME_MS = 12e3;
const POISSON_ITERATIONS = 1e3;
const PATCH_SIZE_DIVISOR = 15;
const VOTE_HISTOGRAM_ERROR_CAP = 1e99;

/**
 * Margin multipliers that expand the fill rect when cropping context.
 * @returns {{ marginX: number, marginY: number }}
 */
function computeExpandMargins(fillWidth, fillHeight) {
  return {
    marginX: fillWidth * 3 < fillHeight ? 2 : 1,
    marginY: fillHeight * 3 < fillWidth ? 2 : 1,
  };
}

/**
 * Uniform downsample factor so average side length stays near the target.
 */
function computeDownsampleFactor(width, height) {
  let downsampleFactor = 1;
  while ((width + height) / 2 / downsampleFactor > DOWNSAMPLE_AVG_TARGET) {
    downsampleFactor++;
  }
  return downsampleFactor;
}

/**
 * Swap interleaved Cr/Cb low-frequency slots inside one feature record.
 * Called after the record has been fully written; `recordEnd` is past the last slot.
 */
function swapFeatureCrCbCoefficients(featureBuffer, recordEnd) {
  const recordOff = recordEnd - FEATURE_RECORD_SIZE;
  const coeff5 = featureBuffer[recordOff + 5];
  const coeff6 = featureBuffer[recordOff + 6];
  featureBuffer[recordOff + 5] = featureBuffer[recordOff + 20];
  featureBuffer[recordOff + 6] = featureBuffer[recordOff + 16];
  featureBuffer[recordOff + 16] = coeff5;
  featureBuffer[recordOff + 20] = coeff6;
}

/**
 * Convert a sparse offset-vote histogram into votes sorted by count descending.
 */
function buildSortedOffsetVotes(voteHistogram, dsWidth, dsHeight) {
  const votes = [];
  const invHistRow = 1 / (2 * dsWidth);
  for (let voteIdx = 0; voteIdx < voteHistogram.length; voteIdx++) {
    if (voteHistogram[voteIdx] > 0) {
      const histRow = Math.floor(voteIdx * invHistRow);
      const histCol = voteIdx - histRow * 2 * dsWidth;
      votes.push({
        x: histCol - dsWidth,
        y: histRow - dsHeight,
        voteCount: voteHistogram[voteIdx],
        unlabeledOverlap: -1,
      });
    }
  }
  votes.sort(function (left, right) {
    return right.voteCount - left.voteCount;
  });
  return votes;
}

/**
 * Label every downsampled pixel: hole index, unlabeled source (-1), or transparent (-2).
 * @returns {{ labelGrid: Int32Array, holePixels: number[], holeCount: number }}
 */
function buildHoleLabelGrid(mask, rgba, dsWidth, dsHeight) {
  const pixelCount = dsWidth * dsHeight;
  const labelGrid = new Int32Array(pixelCount);
  const holePixels = [];
  let holeCount = 0;
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    if (mask[pixelIdx] == MASK_HOLE) {
      labelGrid[pixelIdx] = holeCount;
      holePixels.push(pixelIdx % dsWidth, Math.floor(pixelIdx / dsWidth));
      holeCount++;
    } else if (rgba[(pixelIdx << 2) + 3] < ALPHA_OPAQUE_MIN) {
      labelGrid[pixelIdx] = LABEL_TRANSPARENT;
    } else {
      labelGrid[pixelIdx] = LABEL_SOURCE;
    }
  }
  return { labelGrid, holePixels, holeCount };
}

/**
 * Expand source so it contains the fill rect (copies into a new buffer when needed).
 */
function ensureSourceContainsFill(srcRgba, srcRect, fillRect) {
  if (srcRect.containsRect(fillRect)) {
    return { srcRgba, srcRect };
  }
  const expandedBounds = srcRect.union(fillRect);
  const expandedPixels = allocBuffer(expandedBounds.area() * 4);
  copyPixels(srcRgba, srcRect, expandedPixels, expandedBounds);
  return { srcRgba: expandedPixels, srcRect: expandedBounds };
}

/**
 * When the fill is small relative to the document, crop source+mask to a padded window.
 */
function maybeCropAroundFill(srcRgba, srcRect, maskBuffer, fillRect) {
  const fillWidth = fillRect.width;
  const fillHeight = fillRect.height;
  const { marginX, marginY } = computeExpandMargins(fillWidth, fillHeight);
  if (fillRect.area() * (marginX * 2 + 1) * (marginY * 2 + 1) >= srcRect.area()) {
    return { srcRgba, srcRect, maskBuffer };
  }
  const expandedRect = new Rect(
    fillRect.x - fillWidth * marginX,
    fillRect.y - fillHeight * marginX,
    fillWidth * (marginX * 2 + 1),
    fillHeight * (marginY * 2 + 1),
  ).intersect(srcRect);
  const croppedRgba = allocBuffer(expandedRect.area() * 4);
  copyPixels(srcRgba, srcRect, croppedRgba, expandedRect);
  const croppedMask = allocBuffer(expandedRect.area());
  copyChannel(maskBuffer, srcRect, croppedMask, expandedRect);
  return { srcRgba: croppedRgba, srcRect: expandedRect, maskBuffer: croppedMask };
}

/**
 * Downsample RGBA + mask by a uniform factor.
 */
function downsampleSourceAndMask(srcRgba, srcRect, maskBuffer, downsampleFactor) {
  const dsWidth = Math.floor(srcRect.width / downsampleFactor);
  const dsHeight = Math.floor(srcRect.height / downsampleFactor);
  const dsRgba = allocBuffer(dsWidth * dsHeight * 4);
  resampleUint32UniformScale(
    srcRgba,
    srcRect.width,
    srcRect.height,
    dsRgba,
    dsWidth,
    dsHeight,
    1 / downsampleFactor,
  );
  const dsMask = allocBuffer(dsWidth * dsHeight);
  resampleUint8UniformScale(
    maskBuffer,
    srcRect.width,
    srcRect.height,
    dsMask,
    dsWidth,
    dsHeight,
    1 / downsampleFactor,
  );
  round(dsMask, 1);
  return { dsRgba, dsMask, dsWidth, dsHeight };
}

/**
 * Build FWHT feature records for every valid 8×8 source patch.
 * @returns {{ featureBuffer: Int16Array, featureCount: number } | null}
 */
function extractFwhtFeatureRecords(ycbcr, mask, dsWidth, dsHeight) {
  const featureBuffer = new Int16Array(dsWidth * dsHeight * FEATURE_RECORD_SIZE);
  const yBlock = new Int16Array(FWHT_SIZE);
  const cbBlock = new Int16Array(FWHT_SIZE);
  const crBlock = new Int16Array(FWHT_SIZE);
  const fwhtScratch = new Int16Array(FWHT_SIZE);
  let featureWriteOff = 0;
  let featureCount = 0;
  for (let row = PATCH_HALF; row < dsHeight - 4; row++) {
    for (let col = PATCH_HALF; col < dsWidth - 4; col++) {
      const pixelIdx = row * dsWidth + col;
      if (mask[pixelIdx] == MASK_HOLE) continue;
      if (samplePatchFwhtBlock(ycbcr, mask, col, row, dsWidth, dsHeight, yBlock, cbBlock, crBlock) != 0) {
        continue;
      }
      fwht64InPlace(yBlock, fwhtScratch);
      featureBuffer[featureWriteOff] = col;
      featureBuffer[featureWriteOff + 1] = row;
      copyInt16Slice(yBlock, featureBuffer, featureWriteOff + FEATURE_COEFF_START, Y_COEFF_COUNT);
      featureWriteOff += 16;
      fwht64InPlace(cbBlock, fwhtScratch);
      copyInt16Slice(cbBlock, featureBuffer, featureWriteOff, CHROMA_COEFF_COUNT);
      featureWriteOff += CHROMA_COEFF_COUNT;
      fwht64InPlace(crBlock, fwhtScratch);
      copyInt16Slice(crBlock, featureBuffer, featureWriteOff, CHROMA_COEFF_COUNT);
      featureWriteOff += CHROMA_COEFF_COUNT;
      swapFeatureCrCbCoefficients(featureBuffer, featureWriteOff);
      featureCount++;
    }
  }
  if (featureCount == 0) return null;
  return { featureBuffer, featureCount };
}

/**
 * Vote for translation offsets from each feature to its KD nearest neighbor.
 */
function accumulateOffsetVotes(featureBuffer, featureCount, kdNodes, minDistSq, dsWidth, dsHeight) {
  const voteHistogram = new Float32Array(dsWidth * dsHeight * 4);
  let totalError = 0;
  for (let featureIdx = 0; featureIdx < featureCount; featureIdx++) {
    const nearestIdx = findNearestFeatureInKdTree(featureIdx, featureBuffer, kdNodes, minDistSq);
    if (nearestIdx == -1) continue;
    const queryOff = featureIdx * FEATURE_RECORD_SIZE;
    const nearestOff = nearestIdx * FEATURE_RECORD_SIZE;
    const queryX = featureBuffer[queryOff];
    const queryY = featureBuffer[queryOff + 1];
    const nearestX = featureBuffer[nearestOff];
    const nearestY = featureBuffer[nearestOff + 1];
    totalError += getError(nearestOff, queryOff, featureBuffer, VOTE_HISTOGRAM_ERROR_CAP);
    const offsetX = nearestX - queryX;
    const offsetY = nearestY - queryY;
    voteHistogram[(dsHeight + offsetY) * 2 * dsWidth + (dsWidth + offsetX)] += 1;
  }
  return { voteHistogram, totalError };
}

/**
 * Copy labeled patch samples into the full-resolution fill window.
 */
function pasteLabeledPatches(
  fullResRgba,
  fullResRect,
  fullResMask,
  labelGrid,
  labelIds,
  patchOffsets,
  dsWidth,
  dsHeight,
  downsampleFactor,
  inflatedFillRect,
) {
  const healedRgba = allocBuffer(inflatedFillRect.area() * 4);
  const regionIds = allocBuffer(inflatedFillRect.area());
  copyPixels(fullResRgba, fullResRect, healedRgba, inflatedFillRect);
  const fullWidth = fullResRect.width;
  const fullHeight = fullResRect.height;
  for (let row = 0; row < fullHeight; row++) {
    for (let col = 0; col < fullWidth; col++) {
      if (fullResMask[row * fullWidth + col] == 0) continue;
      const dsCol = Math.min(Math.floor(col / downsampleFactor), dsWidth - 1);
      const dsRow = Math.min(Math.floor(row / downsampleFactor), dsHeight - 1);
      const holeIdx = labelGrid[dsRow * dsWidth + dsCol];
      const labelIdx = labelIds[holeIdx];
      const offset = patchOffsets[labelIdx];
      const sampleCol = col + offset.x * downsampleFactor;
      const sampleRow = row + offset.y * downsampleFactor;
      const sampleOff = (sampleRow * fullWidth + sampleCol) << 2;
      const destOff =
        ((row - inflatedFillRect.y + fullResRect.y) * inflatedFillRect.width +
          (col - inflatedFillRect.x + fullResRect.x)) <<
        2;
      healedRgba[destOff] = fullResRgba[sampleOff];
      healedRgba[destOff + 1] = fullResRgba[sampleOff + 1];
      healedRgba[destOff + 2] = fullResRgba[sampleOff + 2];
      healedRgba[destOff + 3] = fullResRgba[sampleOff + 3];
      healedRgba[destOff + 3] = fullResRgba[sampleOff + 3];
      regionIds[destOff >> 2] = labelIdx + 1;
    }
  }
  return { healedRgba, regionIds };
}

export function runHealingBrushFill(srcRgba, srcRect, maskChannel, dstRgba, fillRect) {
  ({ srcRgba, srcRect } = ensureSourceContainsFill(srcRgba, srcRect, fillRect));

  let maskBuffer = allocBuffer(srcRect.area());
  copyChannel(maskChannel, fillRect, maskBuffer, srcRect);
  round(maskBuffer);
  fillRect = fillRect.intersect(srcRect);

  ({ srcRgba, srcRect, maskBuffer } = maybeCropAroundFill(
    srcRgba,
    srcRect,
    maskBuffer,
    fillRect,
  ));

  const downsampleFactor = computeDownsampleFactor(srcRect.width, srcRect.height);
  const fullResRgba = srcRgba;
  const fullResRect = srcRect;
  const fullResMask = maskBuffer;

  const { dsRgba, dsMask, dsWidth, dsHeight } = downsampleSourceAndMask(
    fullResRgba,
    fullResRect,
    fullResMask,
    downsampleFactor,
  );
  srcRgba = dsRgba;
  maskBuffer = dsMask;

  const contentBounds = contentBoundsChannel(maskBuffer, new Rect(0, 0, dsWidth, dsHeight));
  if (contentBounds.isEmpty()) return 1;

  const minDistSq = Math.round((contentBounds.width + contentBounds.height) / 2 / PATCH_SIZE_DIVISOR);
  const ycbcr = allocBuffer(dsWidth * dsHeight * 4);
  rgbaToYcbcr(srcRgba, ycbcr);

  const features = extractFwhtFeatureRecords(
    ycbcr,
    maskBuffer,
    dsWidth,
    dsHeight,
  );
  if (features == null) return 2;
  const { featureBuffer, featureCount } = features;

  const kdNodes = [];
  buildKdTree(
    0,
    featureCount - 1,
    kdNodes,
    featureBuffer,
    new Int16Array(2 * FEATURE_RECORD_SIZE),
  );

  const { voteHistogram } = accumulateOffsetVotes(
    featureBuffer,
    featureCount,
    kdNodes,
    minDistSq,
    dsWidth,
    dsHeight,
  );

  const sortedVotes = buildSortedOffsetVotes(voteHistogram, dsWidth, dsHeight);
  const { labelGrid, holePixels, holeCount } = buildHoleLabelGrid(maskBuffer, srcRgba, dsWidth, dsHeight);

  const matchPlan = buildPatchMatchPlan(
    dsWidth,
    dsHeight,
    sortedVotes,
    labelGrid,
    holePixels,
    holeCount,
  );
  if (matchPlan == null) {
    return 3;
  }
  let labelIds = matchPlan.labelIndices;
  const patchOffsets = matchPlan.patchOffsets;
  labelIds = optimizePatchLabels(
    labelIds,
    srcRgba,
    dsWidth,
    dsHeight,
    patchOffsets,
    labelGrid,
    holePixels,
    holeCount,
  );

  let inflatedFillRect = fillRect.clone();
  inflatedFillRect.inflate(1, 1);
  inflatedFillRect = inflatedFillRect.intersect(fullResRect);
  const { healedRgba, regionIds } = pasteLabeledPatches(
    fullResRgba,
    fullResRect,
    fullResMask,
    labelGrid,
    labelIds,
    patchOffsets,
    dsWidth,
    dsHeight,
    downsampleFactor,
    inflatedFillRect,
  );

  solvePoissonFill(healedRgba, regionIds, inflatedFillRect, null, POISSON_ITERATIONS);

  copyPixels(healedRgba, inflatedFillRect, dstRgba, fillRect);
  return 0;
}

export function moveCostIfUnlabeled(col, row, width, height, offset, labelGrid) {
  return isPixelInBounds(col + offset.x, row + offset.y, width, height) &&
    labelGrid[(row + offset.y) * width + (col + offset.x)] == LABEL_SOURCE
    ? 0
    : INFINITE_COST;
}

export function optimizePatchLabels(
  labelIds,
  rgba,
  width,
  height,
  patchOffsets,
  labelGrid,
  holePixels,
  holeCount,
) {
  const startTime = Date.now();
  const neighborDeltas = [-1, 0, 0, -1, 1, 0, 0, 1];
  let bestCost = BEST_COST_SENTINEL;
  const edgeFrom = [];
  const edgeCost = [];
  let iteration = 0;
  let stallCost = BEST_COST_SENTINEL;
  while (true && Date.now() < startTime + OPTIMIZE_TIME_MS) {
    iteration++;
    let nextLabelIds = null;
    let roundBestCost = bestCost;
    for (let labelIdx = 0; labelIdx < patchOffsets.length; labelIdx++) {
      const candidateOffset = patchOffsets[labelIdx];
      let edgeCount = 0;
      let auxNodeId = holeCount + 2;
      let roundCostSum = 0;
      for (let holeIdx = 0; holeIdx < holeCount; holeIdx++) {
        const holeCol = holePixels[holeIdx * 2];
        const holeRow = holePixels[holeIdx * 2 + 1];
        const assignedOffset = patchOffsets[labelIds[holeIdx]];
        let sourceCost = moveCostIfUnlabeled(
          holeCol,
          holeRow,
          width,
          height,
          candidateOffset,
          labelGrid,
        );
        let sinkCost =
          labelIds[holeIdx] == labelIdx
            ? INFINITE_COST
            : moveCostIfUnlabeled(
                holeCol,
                holeRow,
                width,
                height,
                assignedOffset,
                labelGrid,
              );
        for (let dirIdx = 0; dirIdx < 4; dirIdx++) {
          if (
            (dirIdx == 0 && holeCol == 0) ||
            (dirIdx == 1 && holeRow == 0) ||
            (dirIdx == 2 && holeCol == width - 1) ||
            (dirIdx == 3 && holeRow == height - 1)
          ) {
            continue;
          }
          const dCol = neighborDeltas[2 * dirIdx];
          const dRow = neighborDeltas[2 * dirIdx + 1];
          const sampleCol = holeCol + dCol;
          const sampleRow = holeRow + dRow;
          const neighborLabelIdx = labelGrid[sampleRow * width + sampleCol];
          if (neighborLabelIdx == LABEL_TRANSPARENT) {
          } else if (neighborLabelIdx == LABEL_SOURCE) {
            sourceCost +=
              3 *
              rgbaPatchMoveCost(
                sampleCol + candidateOffset.x,
                sampleRow + candidateOffset.y,
                sampleCol,
                sampleRow,
                width,
                height,
                rgba,
                labelGrid,
              );
            sourceCost +=
              2 *
              rgbaPatchMoveCost(
                sampleCol + candidateOffset.x + dCol,
                sampleRow + candidateOffset.y + dRow,
                sampleCol + dCol,
                sampleRow + dRow,
                width,
                height,
                rgba,
                labelGrid,
              );
            sinkCost +=
              3 *
              rgbaPatchMoveCost(
                sampleCol + assignedOffset.x,
                sampleRow + assignedOffset.y,
                sampleCol,
                sampleRow,
                width,
                height,
                rgba,
                labelGrid,
              );
            sinkCost +=
              2 *
              rgbaPatchMoveCost(
                sampleCol + assignedOffset.x + dCol,
                sampleRow + assignedOffset.y + dRow,
                sampleCol + dCol,
                sampleRow + dRow,
                width,
                height,
                rgba,
                labelGrid,
              );
          } else if (dirIdx > 1) {
            if (labelIds[holeIdx] == labelIds[neighborLabelIdx]) {
              let pairCost = 0;
              pairCost += rgbaPatchMoveCost(
                holeCol + assignedOffset.x,
                holeRow + assignedOffset.y,
                holeCol + candidateOffset.x,
                holeRow + candidateOffset.y,
                width,
                height,
                rgba,
                labelGrid,
              );
              pairCost += rgbaPatchMoveCost(
                sampleCol + assignedOffset.x,
                sampleRow + assignedOffset.y,
                sampleCol + candidateOffset.x,
                sampleRow + candidateOffset.y,
                width,
                height,
                rgba,
                labelGrid,
              );
              edgeFrom[edgeCount] = holeIdx;
              edgeFrom[edgeCount + 1] = neighborLabelIdx;
              edgeCost[edgeCount] = pairCost;
              edgeCost[edgeCount + 1] = pairCost;
              edgeCount += 2
            } else {
              const neighborOffset = patchOffsets[labelIds[neighborLabelIdx]];
              const mergeNodeId = auxNodeId;
              let keepBothCost = 0;
              let relabelNeighborCost = 0;
              let relabelHoleCost = 0;
              auxNodeId++;
              keepBothCost += rgbaPatchMoveCost(
                holeCol + assignedOffset.x,
                holeRow + assignedOffset.y,
                holeCol + candidateOffset.x,
                holeRow + candidateOffset.y,
                width,
                height,
                rgba,
                labelGrid,
              );
              keepBothCost += rgbaPatchMoveCost(
                sampleCol + assignedOffset.x,
                sampleRow + assignedOffset.y,
                sampleCol + candidateOffset.x,
                sampleRow + candidateOffset.y,
                width,
                height,
                rgba,
                labelGrid,
              );
              relabelNeighborCost += rgbaPatchMoveCost(
                holeCol + neighborOffset.x,
                holeRow + neighborOffset.y,
                holeCol + candidateOffset.x,
                holeRow + candidateOffset.y,
                width,
                height,
                rgba,
                labelGrid,
              );
              relabelNeighborCost += rgbaPatchMoveCost(
                sampleCol + neighborOffset.x,
                sampleRow + neighborOffset.y,
                sampleCol + candidateOffset.x,
                sampleRow + candidateOffset.y,
                width,
                height,
                rgba,
                labelGrid,
              );
              relabelHoleCost += rgbaPatchMoveCost(
                holeCol + neighborOffset.x,
                holeRow + neighborOffset.y,
                holeCol + assignedOffset.x,
                holeRow + assignedOffset.y,
                width,
                height,
                rgba,
                labelGrid,
              );
              relabelHoleCost += rgbaPatchMoveCost(
                sampleCol + neighborOffset.x,
                sampleRow + neighborOffset.y,
                sampleCol + assignedOffset.x,
                sampleRow + assignedOffset.y,
                width,
                height,
                rgba,
                labelGrid,
              );
              edgeFrom[edgeCount] = holeIdx;
              edgeFrom[edgeCount + 1] = mergeNodeId;
              edgeCost[edgeCount] = keepBothCost;
              edgeCost[edgeCount + 1] = keepBothCost;
              edgeCount += 2;
              edgeFrom[edgeCount] = neighborLabelIdx;
              edgeFrom[edgeCount + 1] = mergeNodeId;
              edgeCost[edgeCount] = relabelNeighborCost;
              edgeCost[edgeCount + 1] = relabelNeighborCost;
              edgeCount += 2;
              edgeFrom[edgeCount] = mergeNodeId;
              edgeFrom[edgeCount + 1] = holeCount + 1;
              edgeCost[edgeCount] = relabelHoleCost;
              edgeCost[edgeCount + 1] = 0;
              edgeCount += 2
            }
          }
        }
        edgeFrom[edgeCount] = holeCount;
        edgeFrom[edgeCount + 1] = holeIdx;
        edgeCost[edgeCount] = sourceCost;
        edgeCost[edgeCount + 1] = 0;
        edgeCount += 2;
        edgeFrom[edgeCount] = holeIdx;
        edgeFrom[edgeCount + 1] = holeCount + 1;
        edgeCost[edgeCount] = sinkCost;
        edgeCost[edgeCount + 1] = 0;
        edgeCount += 2;
        roundCostSum += Math.min(sourceCost, sinkCost);
      }
      if (roundCostSum > roundBestCost) continue;
      const minCutResult = computeMinCut(
        auxNodeId,
        edgeCount,
        holeCount,
        holeCount + 1,
        edgeFrom,
        edgeCost,
        roundBestCost,
      );
      if (minCutResult.flow < roundBestCost) {
        roundBestCost = minCutResult.flow;
        const cutLabels = labelIds.slice(0);
        applyCutToLabelArray(
          cutLabels,
          edgeCount,
          edgeFrom,
          minCutResult.cut,
          labelIdx,
          holeCount,
        );
        nextLabelIds = cutLabels;
      }
    }
    if (roundBestCost * 1 >= bestCost) {
      break;
    }
    bestCost = roundBestCost;
    labelIds = nextLabelIds;
    if ((iteration & 3) == 0) {
      if (roundBestCost * 1.03 >= stallCost) break;
      stallCost = roundBestCost;
    }
    if ((iteration & 3) == 0) {
      const minOffsetsToKeep = 0 * patchOffsets.length;
      for (
        let offsetIdx = 0;
        offsetIdx < patchOffsets.length && patchOffsets.length > minOffsetsToKeep;
        offsetIdx++
      ) {
        if (labelIds.indexOf(offsetIdx) != -1) continue;
        patchOffsets.splice(offsetIdx, 1);
        for (let relabelIdx = 0; relabelIdx < labelIds.length; relabelIdx++) {
          if (labelIds[relabelIdx] > offsetIdx) labelIds[relabelIdx]--;
        }
        offsetIdx--;
      }
    }
  }
  return labelIds;
}

export function applyCutToLabelArray(labelIds, edgeCount, edges, cutEdges, newLabel, sinkId) {
  for (let cutIdx = 0; cutIdx < cutEdges.length; cutIdx++) {
    const edgeOff = cutEdges[cutIdx] << 1;
    let tailId = 0;
    let headId = 0;
    if (edgeOff < edgeCount) {
      tailId = edges[edgeOff];
      headId = edges[edgeOff + 1];
    } else {
      headId = edges[edgeOff];
      tailId = edges[edgeOff + 1];
    }
    if (tailId == sinkId && labelIds[headId] != newLabel) labelIds[headId] = newLabel;
  }
}

export function pickDistantPatchCandidate(
  patchOffsets,
  minDistSq,
  voteList,
  labelGrid,
  holePixels,
  width,
  height,
  col,
  row,
) {
  for (let voteIdx = 0; voteIdx < voteList.length; voteIdx++) {
    const candidate = voteList[voteIdx];
    let isFarEnough = true;
    if (
      col != null &&
      !(
        isPixelInBounds(col + candidate.x, row + candidate.y, width, height) &&
        labelGrid[width * (row + candidate.y) + col + candidate.x] == LABEL_SOURCE
      )
    ) {
      continue;
    }
    if (candidate.unlabeledOverlap == -1) {
      candidate.unlabeledOverlap = unlabeledOverlapRatio(
        candidate,
        labelGrid,
        holePixels,
        width,
        height,
      );
    }
    if (candidate.unlabeledOverlap <= 0) continue;
    for (let offsetIdx = 0; offsetIdx < patchOffsets.length; offsetIdx++) {
      const chosen = patchOffsets[offsetIdx];
      const dx = candidate.x - chosen.x;
      const dy = candidate.y - chosen.y;
      if (dx * dx + dy * dy < minDistSq) {
        isFarEnough = false;
        break;
      }
    }
    if (isFarEnough) return candidate;
  }
  return null;
}

export function unlabeledOverlapRatio(patchOffset, labelGrid, holePixels, width, height) {
  let unlabeledCount = 0;
  for (let pixIdx = 0; pixIdx < holePixels.length; pixIdx += 2) {
    const col = holePixels[pixIdx] + patchOffset.x;
    const row = holePixels[pixIdx + 1] + patchOffset.y;
    if (
      isPixelInBounds(col, row, width, height) &&
      labelGrid[width * row + col] == LABEL_SOURCE
    ) {
      unlabeledCount++;
    }
  }
  return unlabeledCount / (holePixels.length >> 1);
}

export function buildPatchMatchPlan(width, height, voteList, labelGrid, holePixels, holeCount) {
  const patchOffsets = [];
  for (let seedIdx = 0; seedIdx < MAX_SEED_OFFSETS; seedIdx++) {
    const candidate = pickDistantPatchCandidate(
      patchOffsets,
      MIN_OFFSET_DIST_SQ,
      voteList,
      labelGrid,
      holePixels,
      width,
      height,
    );
    if (candidate == null) break;
    else patchOffsets.push(candidate);
  }
  if (patchOffsets.length == 0) return null;
  const labelIndices = [];
  for (let holeIdx = 0; holeIdx < holeCount; holeIdx++) {
    const holeCol = holePixels[holeIdx * 2];
    const holeRow = holePixels[holeIdx * 2 + 1];
    let chosenIdx = -1;
    let attempt = 0;
    while (true) {
      attempt++;
      const roll = Math.random();
      chosenIdx = Math.floor(roll * 0.99999 * patchOffsets.length);
      const patch = patchOffsets[chosenIdx];
      const sampleCol = holeCol + patch.x;
      const sampleRow = holeRow + patch.y;
      if (
        isPixelInBounds(sampleCol, sampleRow, width, height) &&
        labelGrid[width * sampleRow + sampleCol] == LABEL_SOURCE
      ) {
        break;
      }
      if (attempt > 100) {
        const fallback = pickDistantPatchCandidate(
          patchOffsets,
          0,
          voteList,
          labelGrid,
          holePixels,
          width,
          height,
          holeCol,
          holeRow,
        );
        if (fallback == null) return null;
        patchOffsets.push(fallback);
        attempt = 0;
      }
    }
    labelIndices.push(chosenIdx);
  }
  return {
    patchOffsets: patchOffsets,
    labelIndices: labelIndices,
  };
}

export function rgbaPatchMoveCost(colA, rowA, colB, rowB, width, height, rgba, labelGrid) {
  if (colA == colB && rowA == rowB) return 0;
  if (
    colA < 0 ||
    rowA < 0 ||
    colA >= width ||
    rowA >= height ||
    colB < 0 ||
    rowB < 0 ||
    colB >= width ||
    rowB >= height ||
    labelGrid[rowA * width + colA] != LABEL_SOURCE ||
    labelGrid[rowB * width + colB] != LABEL_SOURCE
  ) {
    return RGBA_INVALID_COST;
  }
  const offA = (rowA * width + colA) << 2;
  const offB = (rowB * width + colB) << 2;
  const dr = rgba[offA] - rgba[offB];
  const dg = rgba[offA + 1] - rgba[offB + 1];
  const db = rgba[offA + 2] - rgba[offB + 2];
  return 1 + (dr * dr + dg * dg + db * db);
}

export function isPixelInBounds(col, row, width, height) {
  return col >= 0 && col < width && row >= 0 && row < height;
}

export function findNearestFeatureInKdTree(featureIdx, features, kdNodes, minDistSq) {
  const queryOff = FEATURE_RECORD_SIZE * featureIdx;
  const queryX = features[queryOff];
  const queryY = features[queryOff + 1];
  const distCutoff = minDistSq * minDistSq;
  let nodeIdx = 0;
  let bestErr = INFINITE_COST;
  while (kdNodes[nodeIdx] != KD_LEAF) {
    if (features[queryOff + kdNodes[nodeIdx]] < kdNodes[nodeIdx + 1]) nodeIdx = kdNodes[nodeIdx + 2];
    else nodeIdx = kdNodes[nodeIdx + 3];
  }
  const leafLo = kdNodes[nodeIdx + 1];
  const leafHi = kdNodes[nodeIdx + 2];
  let bestIdx = -1;
  for (let candIdx = leafLo; candIdx <= leafHi; candIdx++) {
    const candOff = candIdx * FEATURE_RECORD_SIZE;
    const candX = features[candOff];
    const candY = features[candOff + 1];
    if ((candX - queryX) * (candX - queryX) + (candY - queryY) * (candY - queryY) < distCutoff) continue;
    const err = getError(candOff, queryOff, features, bestErr);
    if (err < bestErr) {
      bestErr = err;
      bestIdx = candIdx;
    }
  }
  return bestIdx;
}

export function getError(candidateOff, queryOff, features, bestErr) {
  let err = 0;
  for (let coeffOff = FEATURE_COEFF_START; coeffOff < FEATURE_RECORD_SIZE; coeffOff += 4) {
    const delta0 = features[queryOff + coeffOff] - features[candidateOff + coeffOff];
    const delta1 = features[queryOff + coeffOff + 1] - features[candidateOff + coeffOff + 1];
    const delta2 = features[queryOff + coeffOff + 2] - features[candidateOff + coeffOff + 2];
    const delta3 = features[queryOff + coeffOff + 3] - features[candidateOff + coeffOff + 3];
    err += delta0 * delta0 + delta1 * delta1 + delta2 * delta2 + delta3 * delta3;
    if (err >= bestErr) return err + 1;
  }
  return err;
}

export function buildKdTree(lo, hi, nodes, features, axisRanges) {
  const leafThreshold = KD_LEAF_THRESHOLD;
  let lastEqualIdx = 0;
  if (hi - lo <= leafThreshold) {
    nodes.push(KD_LEAF, lo, hi);
    return;
  }
  accumulateFeatureAxisRanges(lo, hi, features, axisRanges);
  let splitAxis = -1;
  let maxSpan = -1;
  for (let axis = FEATURE_COEFF_START; axis < FEATURE_RECORD_SIZE; axis++) {
    const span = axisRanges[2 * axis + 1] - axisRanges[2 * axis];
    if (span > maxSpan) {
      maxSpan = span;
      splitAxis = axis;
    }
  }
  let midIdx = (lo + hi) >> 1;
  const pivotVal = kdTreePartitionPivot(midIdx, lo, hi, features, splitAxis);
  let firstEqualIdx = -1;
  for (let featIdx = lo; featIdx <= hi; featIdx++) {
    if (features[FEATURE_RECORD_SIZE * featIdx + splitAxis] == pivotVal) {
      if (firstEqualIdx == -1) firstEqualIdx = featIdx;
      lastEqualIdx = featIdx;
    }
  }
  if (lo + 8 < firstEqualIdx && firstEqualIdx - lo > hi - lastEqualIdx) midIdx = firstEqualIdx;
  else if (lastEqualIdx + 1 < hi - 8) midIdx = lastEqualIdx + 1;
  else if (hi - lo < 64) {
    nodes.push(KD_LEAF, lo, hi);
    return;
  } else midIdx = midIdx;
  const nodeSlot = nodes.length;
  nodes.push(splitAxis, pivotVal, 0, 0);
  nodes[nodeSlot + 2] = nodeSlot + 4;
  buildKdTree(lo, midIdx - 1, nodes, features, axisRanges);
  nodes[nodeSlot + 3] = nodes.length;
  buildKdTree(midIdx, hi, nodes, features, axisRanges);
}

export function accumulateFeatureAxisRanges(lo, hi, features, axisRanges) {
  for (let rangeOff = 0; rangeOff < FEATURE_RECORD_SIZE * 2; rangeOff += 4) {
    axisRanges[rangeOff] = KD_AXIS_RANGE_MIN;
    axisRanges[rangeOff + 1] = KD_AXIS_RANGE_MAX;
    axisRanges[rangeOff + 2] = KD_AXIS_RANGE_MIN;
    axisRanges[rangeOff + 3] = KD_AXIS_RANGE_MAX;
  }
  for (let featIdx = lo; featIdx <= hi; featIdx++) {
    const featOff = featIdx * FEATURE_RECORD_SIZE;
    for (let coeffIdx = 0; coeffIdx < FEATURE_RECORD_SIZE; coeffIdx++) {
      const val = features[featOff + coeffIdx];
      const minSlot = axisRanges[coeffIdx << 1];
      const maxSlot = axisRanges[(coeffIdx << 1) + 1];
      if (val < minSlot) axisRanges[coeffIdx << 1] = val;
      if (val > maxSlot) axisRanges[(coeffIdx << 1) + 1] = val;
    }
  }
}

export function swapFeatureRecords(offA, offB, buf) {
  for (let slot = 0; slot < FEATURE_RECORD_SIZE; slot++) {
    const tmp = buf[offA + slot];
    buf[offA + slot] = buf[offB + slot];
    buf[offB + slot] = tmp;
  }
}

/**
 * Hoare partition of the feature records in [lo, hi] around the axis value of
 * the window's midpoint record. Returns the index where the two halves meet.
 */
export function partitionFeaturesByAxis(axis, lo, hi, features) {
  const pivotVal = features[FEATURE_RECORD_SIZE * ((lo + hi) >>> 1) + axis];
  while (lo <= hi) {
    while (features[FEATURE_RECORD_SIZE * lo + axis] < pivotVal) lo++;
    while (features[FEATURE_RECORD_SIZE * hi + axis] > pivotVal) hi--;
    if (lo <= hi) {
      if (features[FEATURE_RECORD_SIZE * lo + axis] != features[FEATURE_RECORD_SIZE * hi + axis]) {
        swapFeatureRecords(lo * FEATURE_RECORD_SIZE, hi * FEATURE_RECORD_SIZE, features);
      }
      lo++;
      hi--;
    }
  }
  return lo;
}

export function kdTreePartitionPivot(targetIdx, lo, hi, features, axis) {
  let splitAt = 0;
  while (lo != hi) {
    splitAt = partitionFeaturesByAxis(axis, lo, hi, features);
    if (targetIdx < splitAt) hi = splitAt - 1;
    else lo = splitAt;
  }
  return features[targetIdx * FEATURE_RECORD_SIZE + axis];
}

export function copyInt16Slice(src, dst, dstOff, len) {
  for (let i = 0; i < len; i++) dst[dstOff + i] = src[i];
}

export function samplePatchFwhtBlock(
  ycbcr,
  mask,
  col,
  row,
  width,
  height,
  yBlock,
  cbBlock,
  crBlock,
) {
  let maskOff = (row - PATCH_HALF) * width + (col - PATCH_HALF);
  let rgbaOff = maskOff << 2;
  for (let rowInPatch = 0; rowInPatch < 8; rowInPatch++) {
    if (
      mask[maskOff] +
        mask[maskOff + 1] +
        mask[maskOff + 2] +
        mask[maskOff + 3] +
        mask[maskOff + 4] +
        mask[maskOff + 5] +
        mask[maskOff + 6] +
        mask[maskOff + 7] !=
        0 ||
      ycbcr[rgbaOff + 3] < ALPHA_OPAQUE_MIN ||
      ycbcr[rgbaOff + 7] < ALPHA_OPAQUE_MIN ||
      ycbcr[rgbaOff + 11] < ALPHA_OPAQUE_MIN ||
      ycbcr[rgbaOff + 15] < ALPHA_OPAQUE_MIN ||
      ycbcr[rgbaOff + 19] < ALPHA_OPAQUE_MIN ||
      ycbcr[rgbaOff + 23] < ALPHA_OPAQUE_MIN ||
      ycbcr[rgbaOff + 27] < ALPHA_OPAQUE_MIN ||
      ycbcr[rgbaOff + 31] < ALPHA_OPAQUE_MIN
    ) {
      return 1;
    }
    const blockOff = rowInPatch << 3;
    yBlock[blockOff + 0] = ycbcr[rgbaOff + 0];
    cbBlock[blockOff + 0] = ycbcr[rgbaOff + 1];
    crBlock[blockOff + 0] = ycbcr[rgbaOff + 2];
    yBlock[blockOff + 1] = ycbcr[rgbaOff + 4];
    cbBlock[blockOff + 1] = ycbcr[rgbaOff + 5];
    crBlock[blockOff + 1] = ycbcr[rgbaOff + 6];
    yBlock[blockOff + 2] = ycbcr[rgbaOff + 8];
    cbBlock[blockOff + 2] = ycbcr[rgbaOff + 9];
    crBlock[blockOff + 2] = ycbcr[rgbaOff + 10];
    yBlock[blockOff + 3] = ycbcr[rgbaOff + 12];
    cbBlock[blockOff + 3] = ycbcr[rgbaOff + 13];
    crBlock[blockOff + 3] = ycbcr[rgbaOff + 14];
    yBlock[blockOff + 4] = ycbcr[rgbaOff + 16];
    cbBlock[blockOff + 4] = ycbcr[rgbaOff + 17];
    crBlock[blockOff + 4] = ycbcr[rgbaOff + 18];
    yBlock[blockOff + 5] = ycbcr[rgbaOff + 20];
    cbBlock[blockOff + 5] = ycbcr[rgbaOff + 21];
    crBlock[blockOff + 5] = ycbcr[rgbaOff + 22];
    yBlock[blockOff + 6] = ycbcr[rgbaOff + 24];
    cbBlock[blockOff + 6] = ycbcr[rgbaOff + 25];
    crBlock[blockOff + 6] = ycbcr[rgbaOff + 26];
    yBlock[blockOff + 7] = ycbcr[rgbaOff + 28];
    cbBlock[blockOff + 7] = ycbcr[rgbaOff + 29];
    crBlock[blockOff + 7] = ycbcr[rgbaOff + 30];
    rgbaOff += width << 2;
    maskOff += width;
  }
  return 0;
}

export function fwht64InPlace(block, scratch) {
  scratch[0] = block[32] + block[0];
  scratch[1] = block[33] + block[1];
  scratch[2] = block[34] + block[2];
  scratch[3] = block[35] + block[3];
  scratch[4] = block[36] + block[4];
  scratch[5] = block[37] + block[5];
  scratch[6] = block[38] + block[6];
  scratch[7] = block[39] + block[7];
  scratch[8] = block[40] + block[8];
  scratch[9] = block[41] + block[9];
  scratch[10] = block[42] + block[10];
  scratch[11] = block[43] + block[11];
  scratch[12] = block[44] + block[12];
  scratch[13] = block[45] + block[13];
  scratch[14] = block[46] + block[14];
  scratch[15] = block[47] + block[15];
  scratch[16] = block[48] + block[16];
  scratch[17] = block[49] + block[17];
  scratch[18] = block[50] + block[18];
  scratch[19] = block[51] + block[19];
  scratch[20] = block[52] + block[20];
  scratch[21] = block[53] + block[21];
  scratch[22] = block[54] + block[22];
  scratch[23] = block[55] + block[23];
  scratch[24] = block[56] + block[24];
  scratch[25] = block[57] + block[25];
  scratch[26] = block[58] + block[26];
  scratch[27] = block[59] + block[27];
  scratch[28] = block[60] + block[28];
  scratch[29] = block[61] + block[29];
  scratch[30] = block[62] + block[30];
  scratch[31] = block[63] + block[31];
  scratch[32] = block[0] - block[32];
  scratch[33] = block[1] - block[33];
  scratch[34] = block[2] - block[34];
  scratch[35] = block[3] - block[35];
  scratch[36] = block[4] - block[36];
  scratch[37] = block[5] - block[37];
  scratch[38] = block[6] - block[38];
  scratch[39] = block[7] - block[39];
  scratch[40] = block[8] - block[40];
  scratch[41] = block[9] - block[41];
  scratch[42] = block[10] - block[42];
  scratch[43] = block[11] - block[43];
  scratch[44] = block[12] - block[44];
  scratch[45] = block[13] - block[45];
  scratch[46] = block[14] - block[46];
  scratch[47] = block[15] - block[47];
  scratch[48] = block[16] - block[48];
  scratch[49] = block[17] - block[49];
  scratch[50] = block[18] - block[50];
  scratch[51] = block[19] - block[51];
  scratch[52] = block[20] - block[52];
  scratch[53] = block[21] - block[53];
  scratch[54] = block[22] - block[54];
  scratch[55] = block[23] - block[55];
  scratch[56] = block[24] - block[56];
  scratch[57] = block[25] - block[57];
  scratch[58] = block[26] - block[58];
  scratch[59] = block[27] - block[59];
  scratch[60] = block[28] - block[60];
  scratch[61] = block[29] - block[61];
  scratch[62] = block[30] - block[62];
  scratch[63] = block[31] - block[63];
  block[0] = scratch[16] + scratch[0];
  block[1] = scratch[17] + scratch[1];
  block[2] = scratch[18] + scratch[2];
  block[3] = scratch[19] + scratch[3];
  block[4] = scratch[20] + scratch[4];
  block[5] = scratch[21] + scratch[5];
  block[6] = scratch[22] + scratch[6];
  block[7] = scratch[23] + scratch[7];
  block[8] = scratch[24] + scratch[8];
  block[9] = scratch[25] + scratch[9];
  block[10] = scratch[26] + scratch[10];
  block[11] = scratch[27] + scratch[11];
  block[12] = scratch[28] + scratch[12];
  block[13] = scratch[29] + scratch[13];
  block[14] = scratch[30] + scratch[14];
  block[15] = scratch[31] + scratch[15];
  block[16] = scratch[0] - scratch[16];
  block[17] = scratch[1] - scratch[17];
  block[18] = scratch[2] - scratch[18];
  block[19] = scratch[3] - scratch[19];
  block[20] = scratch[4] - scratch[20];
  block[21] = scratch[5] - scratch[21];
  block[22] = scratch[6] - scratch[22];
  block[23] = scratch[7] - scratch[23];
  block[24] = scratch[8] - scratch[24];
  block[25] = scratch[9] - scratch[25];
  block[26] = scratch[10] - scratch[26];
  block[27] = scratch[11] - scratch[27];
  block[28] = scratch[12] - scratch[28];
  block[29] = scratch[13] - scratch[29];
  block[30] = scratch[14] - scratch[30];
  block[31] = scratch[15] - scratch[31];
  scratch[0] = block[8] + block[0];
  scratch[1] = block[9] + block[1];
  scratch[2] = block[10] + block[2];
  scratch[3] = block[11] + block[3];
  scratch[4] = block[12] + block[4];
  scratch[5] = block[13] + block[5];
  scratch[6] = block[14] + block[6];
  scratch[7] = block[15] + block[7];
  scratch[8] = block[0] - block[8];
  scratch[9] = block[1] - block[9];
  scratch[10] = block[2] - block[10];
  scratch[11] = block[3] - block[11];
  scratch[12] = block[4] - block[12];
  scratch[13] = block[5] - block[13];
  scratch[14] = block[6] - block[14];
  scratch[15] = block[7] - block[15];
  block[0] = scratch[4] + scratch[0];
  block[1] = scratch[5] + scratch[1];
  block[2] = scratch[6] + scratch[2];
  block[3] = scratch[7] + scratch[3];
  block[4] = scratch[0] - scratch[4];
  block[5] = scratch[1] - scratch[5];
  block[6] = scratch[2] - scratch[6];
  block[7] = scratch[3] - scratch[7];
  block[8] = scratch[12] + scratch[8];
  block[9] = scratch[13] + scratch[9];
  block[10] = scratch[14] + scratch[10];
  block[11] = scratch[15] + scratch[11];
  block[12] = scratch[8] - scratch[12];
  block[13] = scratch[9] - scratch[13];
  block[14] = scratch[10] - scratch[14];
  block[15] = scratch[11] - scratch[15];
  scratch[0] = block[2] + block[0];
  scratch[1] = block[3] + block[1];
  scratch[2] = block[0] - block[2];
  scratch[3] = block[1] - block[3];
  scratch[4] = block[6] + block[4];
  scratch[5] = block[7] + block[5];
  scratch[6] = block[4] - block[6];
  scratch[7] = block[5] - block[7];
  scratch[8] = block[10] + block[8];
  scratch[9] = block[11] + block[9];
  scratch[10] = block[8] - block[10];
  scratch[11] = block[9] - block[11];
  scratch[12] = block[14] + block[12];
  scratch[13] = block[15] + block[13];
  scratch[14] = block[12] - block[14];
  scratch[15] = block[13] - block[15];
  block[0] = scratch[1] + scratch[0];
  block[1] = scratch[0] - scratch[1];
  block[2] = scratch[3] + scratch[2];
  block[3] = scratch[2] - scratch[3];
  block[4] = scratch[5] + scratch[4];
  block[5] = scratch[4] - scratch[5];
  block[6] = scratch[7] + scratch[6];
  block[7] = scratch[6] - scratch[7];
  block[8] = scratch[9] + scratch[8];
  block[9] = scratch[8] - scratch[9];
  block[10] = scratch[11] + scratch[10];
  block[11] = scratch[10] - scratch[11];
  block[12] = scratch[13] + scratch[12];
  block[13] = scratch[12] - scratch[13];
  block[14] = scratch[15] + scratch[14];
  block[15] = scratch[14] - scratch[15];
}

export function fwhtInPlace64(size, bufA, bufB) {
  let readBuf = bufA;
  let writeBuf = bufB;
  let log2Half = 0;
  let halfLen;
  let rowIdx;
  let negateBranch;
  while (size >> log2Half != 2) log2Half++;
  const stageParity = log2Half;
  for (halfLen = size >> 1; halfLen > 0; halfLen >>= 1, log2Half--) {
    for (rowIdx = 0; rowIdx < size; rowIdx++) {
      negateBranch = ((rowIdx >> log2Half) & 1) != 0;
      if (negateBranch) writeBuf[rowIdx] = readBuf[-halfLen + rowIdx] - readBuf[rowIdx];
      else writeBuf[rowIdx] = readBuf[halfLen + rowIdx] + readBuf[rowIdx];
    }
    const swap = readBuf;
    readBuf = writeBuf;
    writeBuf = swap;
  }
  if ((stageParity & 1) == 1) {
    for (rowIdx = 0; rowIdx < size; rowIdx++) bufB[rowIdx] = readBuf[rowIdx];
  }
}
