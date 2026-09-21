/**
 * Guided-filter harmonic solvers for mask refinement.
 */

import { Rect } from '../../core/math/rect.js';
import { PlanarRgbaBuffer, allocBuffer, downsampleHalfAlphaWeighted, extractChannel, extractChannelByte, fillBuffer, interleavedToPlanar } from "./buffer-utils.js";
import { boxBlur } from "./blur.js";

export function allocFloat32(length) {
  return new Float32Array(length);
}

export function byteToFloat(bytes) {
  const len = bytes.length;
  const out = new Float32Array(len);
  for (let idx = 0; idx < len; idx++) {
    out[idx] = bytes[idx] * (1 / 255);
  }
  return out;
}

export function pointwiseMul(a, b, out) {
  for (let idx = 0; idx < a.length; idx++) {
    out[idx] = a[idx] * b[idx];
  }
}

/**
 * Guided filter run at quarter resolution: the guide and source are halved
 * twice, filtered as single channels, and the resulting a/b coefficient maps
 * are doubled back up to full size before they are applied.
 */
export function guidedFilterDownsampled(guideBuffer, srcRgba, rect, radius, epsilon) {
  var width = rect.width,
    height = rect.height,
    pixelCount = width * height,
    rgbaScratch = allocBuffer(pixelCount * 4),
    halfRes;
  fillBuffer(rgbaScratch, 4294967295);
  var workRect = rect,
    guideMono = guideBuffer,
    srcMono = srcRgba,
    workRadius = radius;
  extractChannel(guideBuffer, rgbaScratch, 0);
  halfRes = downsampleHalfAlphaWeighted(rgbaScratch, rect);
  halfRes = downsampleHalfAlphaWeighted(halfRes.buffer, halfRes.rect);
  workRect = halfRes.rect;
  workRadius = radius >>> 2;
  guideMono = allocBuffer(workRect.area());
  extractChannelByte(halfRes.buffer, guideMono, 0);
  extractChannel(srcRgba, rgbaScratch, 0);
  halfRes = downsampleHalfAlphaWeighted(rgbaScratch, rect);
  halfRes = downsampleHalfAlphaWeighted(halfRes.buffer, halfRes.rect);
  srcMono = allocBuffer(workRect.area());
  extractChannelByte(halfRes.buffer, srcMono, 0);
  var monoCoeffs = guidedFilterMono(guideMono, srcMono, workRect, workRadius, epsilon),
    coeffA = monoCoeffs[0],
    coeffB = monoCoeffs[1],
    midRect = new Rect(0, 0, workRect.width * 2, workRect.height * 2);
  coeffA = upsample2x(coeffA, workRect, midRect, true);
  coeffA = upsample2x(coeffA, midRect, rect, true);
  coeffB = upsample2x(coeffB, workRect, midRect, true);
  coeffB = upsample2x(coeffB, midRect, rect, true);
  var output = allocBuffer(pixelCount);
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) output[pixelIdx] = Math.max(0, Math.min(255, Math.floor(.5 + (coeffA[pixelIdx] * srcRgba[pixelIdx] + 255 * coeffB[pixelIdx]))));
  return output
}

export function upsample2x(src, srcRect, dstRect, replicateEdges) {
  var dstWidth = dstRect.width,
    dstHeight = dstRect.height,
    srcWidth = srcRect.width,
    srcHeight = srcRect.height,
    dst = new Float32Array(dstWidth * dstHeight);
  for (var srcRow = 0; srcRow < srcHeight; srcRow++) {
    var dstRowOff = (srcRow + srcRow) * dstWidth;
    for (var srcCol = 0; srcCol < srcWidth; srcCol++) {
      if (true || srcCol == 0 || srcRow == 0 || srcCol == srcWidth - 1 || srcRow == srcHeight - 1) dst[dstRowOff] = dst[dstRowOff + 1] = dst[dstRowOff + dstWidth] = dst[dstRowOff + dstWidth + 1] = src[srcRow * srcWidth + srcCol];
      else {
        dst[dstRowOff] = bilinearInterp(srcCol + .25, srcRow + .25, src, srcWidth, srcHeight);
        dst[dstRowOff + 1] = bilinearInterp(srcCol + .75, srcRow + .25, src, srcWidth, srcHeight);
        dst[dstRowOff + dstWidth] = bilinearInterp(srcCol + .25, srcRow + .75, src, srcWidth, srcHeight);
        dst[dstRowOff + dstWidth + 1] = bilinearInterp(srcCol + .75, srcRow + .75, src, srcWidth, srcHeight)
      }
      dstRowOff += 2
    }
  }
  return dst
}

export function bilinearInterp(u, v, samples, width, height) {
  u -= .499999;
  v -= .499999;
  var col0 = Math.floor(u),
    row0 = Math.floor(v),
    baseIdx = row0 * width + col0,
    fracU = u - col0,
    fracV = v - row0,
    w00 = (1 - fracV) * (1 - fracU),
    w10 = (1 - fracV) * fracU,
    w01 = fracV * (1 - fracU),
    w11 = fracV * fracU;
  if (samples[baseIdx] == null || samples[baseIdx + width + 1] == null) {
    throw new Error("harmonic-solver bilinearInterp: sample index out of range");
  }
  return w00 * samples[baseIdx + 0] + w10 * samples[baseIdx + 1] + w01 * samples[baseIdx + width + 0] + w11 * samples[baseIdx + width + 1]
}

export function guidedFilterMono(guide, src, rect, radius, epsilon) {
  var width = rect.width,
    height = rect.height,
    pixelCount = width * height,
    srcF = byteToFloat(src),
    guideF = byteToFloat(guide),
    meanGuide = allocFloat32(pixelCount);
  boxBlur(guideF, meanGuide, rect, radius);
  var meanSrc = allocFloat32(pixelCount);
  boxBlur(srcF, meanSrc, rect, radius);
  var meanGuideSq = allocFloat32(pixelCount);
  pointwiseMul(guideF, guideF, meanGuideSq);
  boxBlur(meanGuideSq, meanGuideSq, rect, radius);
  var meanGuideSrc = allocFloat32(pixelCount);
  pointwiseMul(guideF, srcF, meanGuideSrc);
  boxBlur(meanGuideSrc, meanGuideSrc, rect, radius);
  var coeffA = allocFloat32(pixelCount),
    coeffB = allocFloat32(pixelCount);
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    var mg = meanGuide[pixelIdx],
      ms = meanSrc[pixelIdx],
      varGuide = meanGuideSq[pixelIdx] - mg * mg,
      covGuideSrc = meanGuideSrc[pixelIdx] - mg * ms,
      slope = covGuideSrc / (varGuide + epsilon),
      intercept = ms - slope * mg;
    coeffA[pixelIdx] = slope;
    coeffB[pixelIdx] = intercept
  }
  var blurredA = allocFloat32(pixelCount);
  boxBlur(coeffA, blurredA, rect, radius);
  var blurredB = allocFloat32(pixelCount);
  boxBlur(coeffB, blurredB, rect, radius);
  return [blurredA, blurredB]
}

export function guidedFilter(guideBuffer, srcRgba, rect, radius, epsilon) {
  var width = rect.width,
    height = rect.height,
    pixelCount = width * height,
    quarterRect = new Rect(0, 0, width >>> 2, height >>> 2),
    quarterRadius = radius >>> 2,
    guideQuarter = downsampleMono(guideBuffer, width, height),
    srcQuarter = downsampleRgba(srcRgba, width, height);
  var rgbCoeffs = guidedFilterRgb(guideQuarter, srcQuarter, quarterRect, quarterRadius, epsilon),
    coeffR = rgbCoeffs[0],
    coeffG = rgbCoeffs[1],
    coeffB = rgbCoeffs[2],
    coeffBias = rgbCoeffs[3];
  var output = allocBuffer(pixelCount);
  for (var row = 0; row < height; row++)
    for (var col = 0; col < width; col++) {
      var pixelIdx = row * width + col,
        quarterIdx = (row >>> 2) * (width >>> 2) + (col >>> 2),
        rgbaOff = pixelIdx << 2,
        filtered = coeffR[quarterIdx] * srcRgba[rgbaOff] + coeffG[quarterIdx] * srcRgba[rgbaOff + 1] + coeffB[quarterIdx] * srcRgba[rgbaOff + 2] + coeffBias[quarterIdx] * 255;
      output[pixelIdx] = Math.max(0, Math.min(255, ~~(.5 + filtered)))
    }
  return output
}

export function downsampleMono(src, width, height) {
  var quarterWidth = width >>> 2,
    quarterHeight = height >>> 2,
    dst = allocBuffer(width * height);
  for (var row = 0; row < quarterHeight; row++)
    for (var col = 0; col < quarterWidth; col++) dst[row * quarterWidth + col] = src[row * width + col << 2];
  return dst
}

export function downsampleRgba(src, width, height) {
  var quarterWidth = width >>> 2,
    quarterHeight = height >>> 2,
    dst = allocBuffer(width * height * 4);
  for (var row = 0; row < quarterHeight; row++)
    for (var col = 0; col < quarterWidth; col++) {
      var dstOff = row * quarterWidth + col << 2,
        srcOff = row * width + col << 4;
      dst[dstOff] = src[srcOff];
      dst[dstOff + 1] = src[srcOff + 1];
      dst[dstOff + 2] = src[srcOff + 2];
      dst[dstOff + 3] = src[srcOff + 3]
    }
  return dst
}

export function guidedFilterRgb(guide, srcRgba, rect, radius, epsilon) {
  var width = rect.width,
    height = rect.height,
    pixelCount = width * height,
    guideF = byteToFloat(guide),
    planar = new PlanarRgbaBuffer(width * height);
  interleavedToPlanar(srcRgba, planar);
  var srcChannelsF = [byteToFloat(planar.h), byteToFloat(planar.l), byteToFloat(planar.O)],
    cov = computeCovariance(guideF, srcChannelsF, rect, radius, epsilon),
    meanGuide = allocFloat32(pixelCount);
  boxBlur(guideF, meanGuide, rect, radius);
  var meanGuideR = allocFloat32(pixelCount);
  pointwiseMul(srcChannelsF[0], guideF, meanGuideR);
  boxBlur(meanGuideR, meanGuideR, rect, radius);
  var meanGuideG = allocFloat32(pixelCount);
  pointwiseMul(srcChannelsF[1], guideF, meanGuideG);
  boxBlur(meanGuideG, meanGuideG, rect, radius);
  var meanGuideB = allocFloat32(pixelCount);
  pointwiseMul(srcChannelsF[2], guideF, meanGuideB);
  boxBlur(meanGuideB, meanGuideB, rect, radius);
  var coeffR = allocFloat32(pixelCount),
    coeffG = allocFloat32(pixelCount),
    coeffB = allocFloat32(pixelCount),
    coeffBias = allocFloat32(pixelCount);
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    var mg = meanGuide[pixelIdx],
      meanR = cov.meanR[pixelIdx],
      meanG = cov.meanG[pixelIdx],
      meanB = cov.meanB[pixelIdx],
      deltaMeanR = meanGuideR[pixelIdx] - meanR * mg,
      deltaMeanG = meanGuideG[pixelIdx] - meanG * mg,
      deltaMeanB = meanGuideB[pixelIdx] - meanB * mg;
    coeffR[pixelIdx] = cov.invRR[pixelIdx] * deltaMeanR + cov.invRG[pixelIdx] * deltaMeanG + cov.invRB[pixelIdx] * deltaMeanB;
    coeffG[pixelIdx] = cov.invRG[pixelIdx] * deltaMeanR + cov.invGG[pixelIdx] * deltaMeanG + cov.invGB[pixelIdx] * deltaMeanB;
    coeffB[pixelIdx] = cov.invRB[pixelIdx] * deltaMeanR + cov.invGB[pixelIdx] * deltaMeanG + cov.invBB[pixelIdx] * deltaMeanB;
    coeffBias[pixelIdx] = mg - coeffR[pixelIdx] * meanR - coeffG[pixelIdx] * meanG - coeffB[pixelIdx] * meanB
  }
  boxBlur(coeffR, coeffR, rect, radius);
  boxBlur(coeffG, coeffG, rect, radius);
  boxBlur(coeffB, coeffB, rect, radius);
  boxBlur(coeffBias, coeffBias, rect, radius);
  return [coeffR, coeffG, coeffB, coeffBias]
}

export function computeCovariance(guideF, srcChannelsF, rect, radius, epsilon) {
  var width = rect.width,
    height = rect.height,
    pixelCount = width * height,
    stats = {};
  stats.meanR = allocFloat32(pixelCount);
  boxBlur(srcChannelsF[0], stats.meanR, rect, radius);
  stats.meanG = allocFloat32(pixelCount);
  boxBlur(srcChannelsF[1], stats.meanG, rect, radius);
  stats.meanB = allocFloat32(pixelCount);
  boxBlur(srcChannelsF[2], stats.meanB, rect, radius);
  var meanRR = allocFloat32(pixelCount);
  pointwiseMul(srcChannelsF[0], srcChannelsF[0], meanRR);
  boxBlur(meanRR, meanRR, rect, radius);
  var meanRG = allocFloat32(pixelCount);
  pointwiseMul(srcChannelsF[0], srcChannelsF[1], meanRG);
  boxBlur(meanRG, meanRG, rect, radius);
  var meanRB = allocFloat32(pixelCount);
  pointwiseMul(srcChannelsF[0], srcChannelsF[2], meanRB);
  boxBlur(meanRB, meanRB, rect, radius);
  var meanGG = allocFloat32(pixelCount);
  pointwiseMul(srcChannelsF[1], srcChannelsF[1], meanGG);
  boxBlur(meanGG, meanGG, rect, radius);
  var meanGB = allocFloat32(pixelCount);
  pointwiseMul(srcChannelsF[1], srcChannelsF[2], meanGB);
  boxBlur(meanGB, meanGB, rect, radius);
  var meanBB = allocFloat32(pixelCount);
  pointwiseMul(srcChannelsF[2], srcChannelsF[2], meanBB);
  boxBlur(meanBB, meanBB, rect, radius);
  stats.invRR = meanRR;
  stats.invRG = meanRG;
  stats.invRB = meanRB;
  stats.invGG = meanGG;
  stats.invGB = meanGB;
  stats.invBB = meanBB;
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    var mr = stats.meanR[pixelIdx],
      mg = stats.meanG[pixelIdx],
      mb = stats.meanB[pixelIdx],
      covRR = meanRR[pixelIdx] - mr * mr + epsilon,
      covRG = meanRG[pixelIdx] - mr * mg,
      covRB = meanRB[pixelIdx] - mr * mb,
      covGG = meanGG[pixelIdx] - mg * mg + epsilon,
      covGB = meanGB[pixelIdx] - mg * mb,
      covBB = meanBB[pixelIdx] - mb * mb + epsilon,
      detSub0 = covGG * covBB - covGB * covGB,
      detSub1 = covGB * covRB - covRG * covBB,
      detSub2 = covRG * covGB - covGG * covRB,
      detSub3 = covRR * covBB - covRB * covRB,
      detSub4 = covRB * covRG - covRR * covGB,
      detSub5 = covRR * covGG - covRG * covRG,
      det = detSub0 * covRR + detSub1 * covRG + detSub2 * covRB,
      invDet = 1 / det;
    stats.invRR[pixelIdx] = detSub0 * invDet;
    stats.invRG[pixelIdx] = detSub1 * invDet;
    stats.invRB[pixelIdx] = detSub2 * invDet;
    stats.invGG[pixelIdx] = detSub3 * invDet;
    stats.invGB[pixelIdx] = detSub4 * invDet;
    stats.invBB[pixelIdx] = detSub5 * invDet
  }
  return stats
}

