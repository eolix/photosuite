/**
 * Content-aware trimap fill and Poisson seamless cloning.
 */

import { Rect } from '../../core/math/rect.js';
import { allocBuffer, extractChannel } from "./buffer-utils.js";
import { initRng } from "./compositing-ops.js";
import { guidedFilter } from "./harmonic-solver.js";
import { computeNearestOffsets } from "./distance-field-stroke.js";
import { SplineMatrix } from "./sparse-matrix.js";

export function blendAlpha(unknownPackedRgb, fgPackedRgb, bgPackedRgb) {
  const unknownRed = unknownPackedRgb >>> 16;
  const unknownGreen = unknownPackedRgb >>> 8 & 255;
  const unknownBlue = unknownPackedRgb & 255;
  const fgRed = fgPackedRgb >>> 16;
  const fgGreen = fgPackedRgb >>> 8 & 255;
  const fgBlue = fgPackedRgb & 255;
  const bgRed = bgPackedRgb >>> 16;
  const bgGreen = bgPackedRgb >>> 8 & 255;
  const bgBlue = bgPackedRgb & 255;
  const chordRed = fgRed - bgRed;
  const chordGreen = fgGreen - bgGreen;
  const chordBlue = fgBlue - bgBlue;
  const deltaRed = unknownRed - bgRed;
  const deltaGreen = unknownGreen - bgGreen;
  const deltaBlue = unknownBlue - bgBlue;
  const chordLenSq = chordRed * chordRed + chordGreen * chordGreen + chordBlue * chordBlue;
  const projectionT = chordLenSq == 0 ? 0.5 : (deltaRed * chordRed + deltaGreen * chordGreen + deltaBlue * chordBlue) / chordLenSq;
  return Math.max(0, Math.min(1, projectionT));
}

export function blendColorError(unknownPackedRgb, fgPackedRgb, bgPackedRgb) {
  const unknownRed = unknownPackedRgb >>> 16;
  const unknownGreen = unknownPackedRgb >>> 8 & 255;
  const unknownBlue = unknownPackedRgb & 255;
  const fgRed = fgPackedRgb >>> 16;
  const fgGreen = fgPackedRgb >>> 8 & 255;
  const fgBlue = fgPackedRgb & 255;
  const bgRed = bgPackedRgb >>> 16;
  const bgGreen = bgPackedRgb >>> 8 & 255;
  const bgBlue = bgPackedRgb & 255;
  const blendT = blendAlpha(unknownPackedRgb, fgPackedRgb, bgPackedRgb);
  const errRed = unknownRed - (blendT * fgRed + (1 - blendT) * bgRed);
  const errGreen = unknownGreen - (blendT * fgGreen + (1 - blendT) * bgGreen);
  const errBlue = unknownBlue - (blendT * fgBlue + (1 - blendT) * bgBlue);
  return Math.sqrt(errRed * errRed + errGreen * errGreen + errBlue * errBlue);
}

export function patchCost(unknownPackedPos, unknownPackedRgb, fgPackedPos, fgPackedRgb, bgPackedPos, bgPackedRgb, fgDistWeight, bgDistWeight, maxCost) {
  const unknownCol = unknownPackedPos >>> 16;
  const unknownRow = unknownPackedPos & 65535;
  const fgDeltaCol = unknownCol - (fgPackedPos >>> 16);
  const fgDeltaRow = unknownRow - (fgPackedPos & 65535);
  const bgDeltaCol = unknownCol - (bgPackedPos >>> 16);
  const bgDeltaRow = unknownRow - (bgPackedPos & 65535);
  const fgGeomCost = Math.sqrt(fgDeltaCol * fgDeltaCol + fgDeltaRow * fgDeltaRow) * fgDistWeight;
  const bgGeomCost = Math.sqrt(bgDeltaCol * bgDeltaCol + bgDeltaRow * bgDeltaRow) * bgDistWeight;
  if (fgGeomCost + bgGeomCost >= maxCost) {
    return 1e9;
  }
  return blendColorError(unknownPackedRgb, fgPackedRgb, bgPackedRgb) + fgGeomCost + bgGeomCost;
}

export function extractContourPixels(mask, width, height, targetValue, neighborValue) {
  const contourIndices = [];
  const lastCol = width - 1;
  const lastRow = height - 1;
  for (let row = 1; row < lastRow; row++) {
    for (let col = 1; col < lastCol; col++) {
      const pixelIdx = row * width + col;
      if (
        mask[pixelIdx] == targetValue &&
        (mask[pixelIdx - width - 1] == neighborValue ||
          mask[pixelIdx - width] == neighborValue ||
          mask[pixelIdx - width + 1] == neighborValue ||
          mask[pixelIdx - 1] == neighborValue ||
          mask[pixelIdx + 1] == neighborValue ||
          mask[pixelIdx + width - 1] == neighborValue ||
          mask[pixelIdx + width] == neighborValue ||
          mask[pixelIdx + width + 1] == neighborValue)
      ) {
        contourIndices.push(pixelIdx);
      }
    }
  }
  return contourIndices;
}

function packContourSamples(contourIndices, rgba, imgWidth, invImgWidth) {
  const sampleCount = contourIndices.length;
  const packed = new Array(sampleCount * 2);
  for (let idx = 0; idx < sampleCount; idx++) {
    const pixelIdx = contourIndices[idx];
    const row = ~~(pixelIdx * invImgWidth);
    const col = pixelIdx - row * imgWidth;
    const rgbaOff = pixelIdx << 2;
    packed[idx * 2] = col << 16 | row;
    packed[idx * 2 + 1] = rgba[rgbaOff] << 16 | rgba[rgbaOff + 1] << 8 | rgba[rgbaOff + 2];
  }
  return packed;
}

/** Stop the running fill at the end of its current iteration. */
export function cancel() {}

export function fill(rect, sourceRgba, trimapMask, iterationCount, preserveKnownTrimap) {
  if (iterationCount == null) iterationCount = 3;
  if (preserveKnownTrimap == null) preserveKnownTrimap = true;
  var width = rect.width,
    height = rect.height,
    invWidth = 1 / width,
    pixelCount = width * height,
    fgContourIndices = extractContourPixels(trimapMask, width, height, 255, 128),
    bgContourIndices = extractContourPixels(trimapMask, width, height, 0, 128),
    pyramidLevels = 0;
  var contourBrightnessSort = function(pixelIdxA, pixelIdxB) {
    var rgbaOffA = pixelIdxA << 2,
      rgbaOffB = pixelIdxB << 2;
    return sourceRgba[rgbaOffA] + sourceRgba[rgbaOffA + 1] + sourceRgba[rgbaOffA + 2] - (sourceRgba[rgbaOffB] + sourceRgba[rgbaOffB + 1] + sourceRgba[rgbaOffB + 2])
  };
  fgContourIndices.sort(contourBrightnessSort);
  bgContourIndices.sort(contourBrightnessSort);
  var fgDistanceSeed = allocBuffer(pixelCount),
    bgDistanceSeed = allocBuffer(pixelCount),
    unknownPixelIndices = [],
    unknownIndexByPixel = new Uint32Array(width * height);
  unknownIndexByPixel.fill(4294967295);
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++)
    if (trimapMask[pixelIdx] == 0) bgDistanceSeed[pixelIdx] = 255;
    else if (trimapMask[pixelIdx] == 255) fgDistanceSeed[pixelIdx] = 255;
    else {
      unknownIndexByPixel[pixelIdx] = unknownPixelIndices.length;
      unknownPixelIndices.push(pixelIdx)
    }
  var fgContourCount = fgContourIndices.length,
    bgContourCount = bgContourIndices.length,
    unknownCount = unknownPixelIndices.length;

    var fgPackedSamples = packContourSamples(fgContourIndices, sourceRgba, width, invWidth),
    bgPackedSamples = packContourSamples(bgContourIndices, sourceRgba, width, invWidth),
    unknownPackedSamples = packContourSamples(unknownPixelIndices, sourceRgba, width, invWidth);
  var fgNearestOffsets = computeNearestOffsets(fgDistanceSeed, width, height, true),
    bgNearestOffsets = computeNearestOffsets(bgDistanceSeed, width, height, true),
    fgDistWeight = new Array(unknownCount),
    bgDistWeight = new Array(unknownCount),
    fgPatchIndex = new Array(unknownCount),
    bgPatchIndex = new Array(unknownCount),
    patchCosts = new Array(unknownCount);
  for (var unknownIdx = 0; unknownIdx < unknownCount; unknownIdx++) {
    var pixelIdx = unknownPixelIndices[unknownIdx],
      row = ~~(pixelIdx * invWidth),
      col = pixelIdx - row * width,
      fgOffX = fgNearestOffsets[pixelIdx << 1],
      fgOffY = fgNearestOffsets[(pixelIdx << 1) + 1],
      fgDist = Math.sqrt(fgOffX * fgOffX + fgOffY * fgOffY),
      bgOffX = bgNearestOffsets[pixelIdx << 1],
      bgOffY = bgNearestOffsets[(pixelIdx << 1) + 1],
      bgDist = Math.sqrt(bgOffX * bgOffX + bgOffY * bgOffY);
    fgDistWeight[unknownIdx] = 1 / fgDist;
    bgDistWeight[unknownIdx] = 1 / bgDist;
    var initFgPatch = Math.floor(initRng(pixelIdx * 17) * fgContourCount),
      initBgPatch = Math.floor(initRng(pixelIdx * 19) * bgContourCount);
    fgPatchIndex[unknownIdx] = initFgPatch;
    bgPatchIndex[unknownIdx] = initBgPatch;
    patchCosts[unknownIdx] = patchCost(unknownPackedSamples[unknownIdx * 2], unknownPackedSamples[unknownIdx * 2 + 1], fgPackedSamples[initFgPatch * 2], fgPackedSamples[initFgPatch * 2 + 1], bgPackedSamples[initBgPatch * 2], bgPackedSamples[initBgPatch * 2 + 1], fgDistWeight[unknownIdx], bgDistWeight[unknownIdx], 1e9)
  }
  var neighborOffsets8 = [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1];
  while (Math.floor(Math.max(fgContourCount, bgContourCount) * Math.pow(.5, pyramidLevels)) > 1) pyramidLevels++;
  for (var iterRound = 0; iterRound < iterationCount; iterRound++) {
    var totalCostSum = 0;
    for (var unknownIdx = 0; unknownIdx < unknownCount; unknownIdx++) {
      var pixelIdx = unknownPixelIndices[unknownIdx],
        row = ~~(pixelIdx * invWidth),
        col = pixelIdx - row * width,
        fgWeight = fgDistWeight[unknownIdx],
        bgWeight = bgDistWeight[unknownIdx],
        unknownPackedPos = unknownPackedSamples[unknownIdx * 2],
        unknownPackedRgb = unknownPackedSamples[unknownIdx * 2 + 1],
        bestCost = patchCosts[unknownIdx],
        bestFgPatch = fgPatchIndex[unknownIdx],
        bestBgPatch = bgPatchIndex[unknownIdx],
        searchRadiusScale = 1;
      if (row != 0 && col != 0 && col != width - 1 && row != height - 1)
        for (var nbrDir = 0; nbrDir < 8; nbrDir++) {
          var nbrUnknownIdx = unknownIndexByPixel[pixelIdx + neighborOffsets8[nbrDir]];
          if (nbrUnknownIdx == 4294967295) continue;
          var nbrFgPatch = fgPatchIndex[nbrUnknownIdx],
            nbrBgPatch = bgPatchIndex[nbrUnknownIdx];
          if (nbrFgPatch == bestFgPatch && nbrBgPatch == bestBgPatch) continue;
          var nbrCost = patchCost(unknownPackedPos, unknownPackedRgb, fgPackedSamples[nbrFgPatch * 2], fgPackedSamples[nbrFgPatch * 2 + 1], bgPackedSamples[nbrBgPatch * 2], bgPackedSamples[nbrBgPatch * 2 + 1], fgWeight, bgWeight, bestCost);
          if (nbrCost < bestCost) {
            bestCost = nbrCost;
            bestFgPatch = nbrFgPatch;
            bestBgPatch = nbrBgPatch
          }
        }
      for (var pyramidLevel = 0; pyramidLevel < pyramidLevels; pyramidLevel++) {
        var fgSearchRadius = ~~(fgContourCount * searchRadiusScale),
          bgSearchRadius = ~~(bgContourCount * searchRadiusScale);
        searchRadiusScale *= .5;
        var fgRng = initRng(pixelIdx + iterRound * 17 + pyramidLevel * 31),
          bgRng = initRng(pixelIdx + iterRound * 29 + pyramidLevel * 63),
          fgMin = Math.max(0, bestFgPatch - fgSearchRadius),
          fgMax = Math.min(bestFgPatch + fgSearchRadius, fgContourCount - 1),
          bgMin = Math.max(0, bestBgPatch - bgSearchRadius),
          bgMax = Math.min(bestBgPatch + bgSearchRadius, bgContourCount - 1),
          tryFgPatch = fgMin + ~~(fgRng * (fgMax - fgMin)),
          tryBgPatch = bgMin + ~~(bgRng * (bgMax - bgMin)),
          tryCost = patchCost(unknownPackedPos, unknownPackedRgb, fgPackedSamples[tryFgPatch * 2], fgPackedSamples[tryFgPatch * 2 + 1], bgPackedSamples[tryBgPatch * 2], bgPackedSamples[tryBgPatch * 2 + 1], fgWeight, bgWeight, bestCost);
        if (tryCost < bestCost) {
          bestCost = tryCost;
          bestFgPatch = tryFgPatch;
          bestBgPatch = tryBgPatch
        }
      }
      patchCosts[unknownIdx] = bestCost;
      fgPatchIndex[unknownIdx] = bestFgPatch;
      bgPatchIndex[unknownIdx] = bestBgPatch;
      totalCostSum += bestCost
    }
  }
  var refinedTrimap = trimapMask.slice(0);
  for (var unknownIdx = 0; unknownIdx < unknownCount; unknownIdx++) {
    var alphaValue = blendAlpha(unknownPackedSamples[unknownIdx * 2 + 1], fgPackedSamples[fgPatchIndex[unknownIdx] * 2 + 1], bgPackedSamples[bgPatchIndex[unknownIdx] * 2 + 1]);
    refinedTrimap[unknownPixelIndices[unknownIdx]] = ~~(.5 + 255 * alphaValue)
  }
  refinedTrimap = guidedFilter(refinedTrimap, sourceRgba, new Rect(0, 0, width, height), 16, .01 * .01);
  if (preserveKnownTrimap)
    for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++)
      if (trimapMask[pixelIdx] == 255 || trimapMask[pixelIdx] == 0) refinedTrimap[pixelIdx] = trimapMask[pixelIdx];
  var outputRgba = sourceRgba.slice(0);
  for (var unknownIdx = 0; unknownIdx < unknownCount; unknownIdx++) {
    var outPixelIdx = unknownPixelIndices[unknownIdx],
      fgSourcePixel = fgContourIndices[fgPatchIndex[unknownIdx]],
      rgbaOff = outPixelIdx << 2,
      trimapValue = refinedTrimap[outPixelIdx],
      samplePixelIdx = (trimapValue >= 250 ? outPixelIdx : fgSourcePixel) << 2;
    outputRgba[rgbaOff] = sourceRgba[samplePixelIdx];
    outputRgba[rgbaOff + 1] = sourceRgba[samplePixelIdx + 1];
    outputRgba[rgbaOff + 2] = sourceRgba[samplePixelIdx + 2]
  }
  extractChannel(refinedTrimap, outputRgba, 3);
  return outputRgba
}

/**
 * Reconstruct the masked pixels of `destRgba` by solving Poisson's equation
 * over them: every unknown pixel is pulled toward the average of its four
 * neighbours, with the unmasked pixels around the region holding the edges in
 * place. `bounds` frames the region; `strength` and `iterations` tune the
 * solver.
 */
export function solvePoissonFill(destRgba, regionMask, bounds, strength, iterations) {
  var width = bounds.width,
    height = bounds.height,
    pixelCount = width * height,
    unknownIndex = new Int32Array(pixelCount),
    unknownCount = 0;
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++)
    if (regionMask[pixelIdx] != 0) {
      unknownIndex[pixelIdx] = unknownCount;
      unknownCount++
    } else if (destRgba[(pixelIdx << 2) + 3] < 200) {
    unknownIndex[pixelIdx] = -2
  } else unknownIndex[pixelIdx] = -1;
  if (unknownCount == 0) return;
  var matrix = new SplineMatrix(unknownCount, unknownCount),
    rhsRgb = new Array(3 * unknownCount),
    solutionRgb = new Array(3 * unknownCount);
  for (var rgbIdx = 0; rgbIdx < solutionRgb.length; rgbIdx++) solutionRgb[rgbIdx] = rhsRgb[rgbIdx] = 0;
  var neighborOff = [-width, -1, 1, width],
    rowCoeffs = [],
    rowCols = [];
  for (var row = 0; row < height; row++)
    for (var col = 0; col < width; col++) {
      var pixelIdx = row * width + col,
        rgbaOff = pixelIdx << 2,
        unkIdx = unknownIndex[pixelIdx],
        rgbBase = unkIdx * 3,
        neighborCount = 0,
        diagCol = 0,
        coeffCount = 0;
      if (unkIdx == -1 || unkIdx == -2) continue;
      for (var nbrDir = 0; nbrDir < 4; nbrDir++) {
        if (nbrDir == 2) {
          diagCol = coeffCount;
          rowCoeffs[coeffCount] = 0;
          rowCols[coeffCount] = unkIdx;
          coeffCount++
        }
        var nbrIdx = pixelIdx + neighborOff[nbrDir],
          nbrRgbaOff = nbrIdx << 2,
          nbrUnk = unknownIndex[nbrIdx];
        if (nbrDir == 0 && row == 0 || nbrDir == 1 && col == 0 || nbrDir == 2 && col == width - 1 || nbrDir == 3 && row == height - 1 || nbrUnk == -2) continue;
        neighborCount++;
        if (nbrUnk == -1) {
          rhsRgb[rgbBase + 0] += destRgba[nbrRgbaOff + 0];
          rhsRgb[rgbBase + 1] += destRgba[nbrRgbaOff + 1];
          rhsRgb[rgbBase + 2] += destRgba[nbrRgbaOff + 2]
        } else {
          rowCoeffs[coeffCount] = -1;
          rowCols[coeffCount] = nbrUnk;
          coeffCount++;
          if (regionMask[pixelIdx] == regionMask[nbrIdx]) {
            rhsRgb[rgbBase + 0] += destRgba[rgbaOff + 0] - destRgba[nbrRgbaOff + 0];
            rhsRgb[rgbBase + 1] += destRgba[rgbaOff + 1] - destRgba[nbrRgbaOff + 1];
            rhsRgb[rgbBase + 2] += destRgba[rgbaOff + 2] - destRgba[nbrRgbaOff + 2]
          }
        }
      }
      rowCoeffs[diagCol] = neighborCount;
      matrix.addRow(rowCoeffs, rowCols, coeffCount)
    }
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++)
    if (unknownIndex[pixelIdx] != -1) {
      var rgbaOff = pixelIdx << 2,
        unkIdx = unknownIndex[pixelIdx],
        solOff = unkIdx * 3;
      solutionRgb[solOff] = destRgba[rgbaOff + 0];
      solutionRgb[solOff + 1] = destRgba[rgbaOff + 1];
      solutionRgb[solOff + 2] = destRgba[rgbaOff + 2]
    }
  matrix.solveVector3(solutionRgb, rhsRgb, strength, iterations);
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    var unkIdx = unknownIndex[pixelIdx],
      solOff = unkIdx * 3,
      rgbaOff = pixelIdx << 2;
    if (unkIdx == -1 || destRgba[rgbaOff + 3] != 255) continue;
    destRgba[rgbaOff + 0] = ~~(.5 + Math.max(0, Math.min(255, solutionRgb[solOff + 0])));
    destRgba[rgbaOff + 1] = ~~(.5 + Math.max(0, Math.min(255, solutionRgb[solOff + 1])));
    destRgba[rgbaOff + 2] = ~~(.5 + Math.max(0, Math.min(255, solutionRgb[solOff + 2])))
  }
}
