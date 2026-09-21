/**
 * Border-based color selection scoring (MBD / chamfer distance).
 */

import { allocBuffer, extractChannelByte } from "./buffer-utils.js";
import { filterChannel, selectMinimum } from "./spatial-filters.js";



export function colorDistance(rgba, offA, refRgb, offB) {
  const deltaRed = rgba[offA] - refRgb[offB];
  const deltaGreen = rgba[offA + 1] - refRgb[offB + 1];
  const deltaBlue = rgba[offA + 2] - refRgb[offB + 2];
  return Math.sqrt(deltaRed * deltaRed + deltaGreen * deltaGreen + deltaBlue * deltaBlue) * (1 / 441.7);
}

export function normalizeArray(values) {
  const len = values.length;
  let maxVal = 0;
  for (let idx = 0; idx < len; idx++) {
    maxVal = Math.max(maxVal, values[idx]);
  }
  const scale = 1 / maxVal;
  for (let idx = 0; idx < len; idx++) {
    values[idx] = values[idx] * scale;
  }
}

export function getSelection(rgba, width, height) {
  var pixelCount = width * height,
    borderMask = allocBuffer(pixelCount),
    borderBand = Math.round(height * .7),
    borderWidth = 1,
    edgeColorSums = new Uint32Array(12),
    edgeColorAvg = allocBuffer(12);
  for (var row = 0; row < borderBand; row++)
    for (var col = 0; col < width; col++) {
      if (col < borderWidth || row < borderWidth || col > width - borderWidth - 1 || row > height - borderWidth - 1) {
        var pixelIdx = row * width + col,
          rgbaOff = pixelIdx << 2,
          edgeBucket = 0;
        if (row < borderWidth) edgeBucket = 4;
        else if (col > width - borderWidth - 1) edgeBucket = 8;
        edgeColorSums[edgeBucket] += rgba[rgbaOff];
        edgeColorSums[edgeBucket + 1] += rgba[rgbaOff + 1];
        edgeColorSums[edgeBucket + 2] += rgba[rgbaOff + 2];
        edgeColorSums[edgeBucket + 3]++;
        borderMask[pixelIdx] = 255
      }
    }
  for (var bucketOff = 0; bucketOff < 12; bucketOff += 4)
    for (var ch = 0; ch < 3; ch++) edgeColorAvg[bucketOff + ch] = edgeColorSums[bucketOff + ch] / edgeColorSums[bucketOff + 3];
  var colorScore = new Float32Array(pixelCount);
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    var rgbaOff = pixelIdx * 4,
      distTop = colorDistance(rgba, rgbaOff, edgeColorAvg, 0),
      distSide = colorDistance(rgba, rgbaOff, edgeColorAvg, 4),
      distBottom = colorDistance(rgba, rgbaOff, edgeColorAvg, 8),
      maxDist = Math.max(distTop, Math.max(distSide, distBottom));
    colorScore[pixelIdx] = distTop + distSide + distBottom - maxDist
  }
  normalizeArray(colorScore);
  var combinedScore = new Float32Array(pixelCount),
    chamferPerChannel = [],
    channelScratch = allocBuffer(pixelCount);
  for (var ch = 0; ch < 3; ch++) {
    extractChannelByte(rgba, channelScratch, ch);
    var chamferDist = new Uint16Array(pixelCount);
    chamferPerChannel.push(chamferDist);
    chamferDistance(channelScratch, borderMask, width, height, chamferDist)
  }
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) combinedScore[pixelIdx] = chamferPerChannel[0][pixelIdx] + chamferPerChannel[1][pixelIdx] + chamferPerChannel[2][pixelIdx];
  normalizeArray(combinedScore);
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) combinedScore[pixelIdx] += .4 * colorScore[pixelIdx];
  var centerCol = width >>> 1,
    centerRow = height >>> 1,
    invCenterDist = 1 / Math.sqrt(centerCol * centerCol + centerRow * centerRow);
  for (var row = 0; row < height; row++)
    for (var col = 0; col < width; col++) {
      var dx = col - centerCol,
        dy = row - centerRow,
        radialWeight = 1 - Math.sqrt(dx * dx + dy * dy) * invCenterDist;
      combinedScore[row * width + col] *= radialWeight
    }
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) borderMask[pixelIdx] = combinedScore[pixelIdx] * 255;
  var erosionRadius = Math.round(width / 120),
    erosionPasses = Math.round(erosionRadius * .8);
  filterChannel(borderMask, channelScratch, width, height, erosionRadius, selectMinimum, []);
  borderMask.set(channelScratch);
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) combinedScore[pixelIdx] = borderMask[pixelIdx];
  normalizeArray(combinedScore);
  var sigmoidLut = allocBuffer(256);
  for (var lutIdx = 0; lutIdx < 256; lutIdx++) sigmoidLut[lutIdx] = 256 / (1 + Math.exp(-20 * (lutIdx / 255 - .5)));
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    var lutIdx = ~~(combinedScore[pixelIdx] * 255 + .5);
    borderMask[pixelIdx] = sigmoidLut[lutIdx]
  }
  return borderMask
}

export function chamferDistance(channel, mask, width, height, distOut) {
  var pixelCount = width * height,
    maxForward = channel.slice(0),
    minForward = channel.slice(0);
  for (var idx = 0; idx < pixelCount; idx++) distOut[idx] = mask[idx] == 255 ? 0 : 65535;
  chamferScanForward(channel, minForward, maxForward, distOut, width, height);
  chamferScanBackward(channel, minForward, maxForward, distOut, width, height);
  chamferScanForward(channel, minForward, maxForward, distOut, width, height);
  chamferScanBackward(channel, minForward, maxForward, distOut, width, height);
  return distOut
}

export function chamferScanForward(channel, minBuf, maxBuf, dist, width, height) {
  for (var col = 1; col < width; col++) chamferPropagate(col, -1, channel, minBuf, maxBuf, dist);
  for (var row = 1; row < height; row++) {
    chamferPropagate(row * width, -width, channel, minBuf, maxBuf, dist);
    for (var col = 1; col < width; col++) {
      var pixelIdx = row * width + col;
      chamferPropagate(pixelIdx, -1, channel, minBuf, maxBuf, dist);
      chamferPropagate(pixelIdx, -width, channel, minBuf, maxBuf, dist)
    }
  }
}

export function chamferScanBackward(channel, minBuf, maxBuf, dist, width, height) {
  for (var col = width - 2; col >= 0; col--) chamferPropagate(height * width - width + col, 1, channel, minBuf, maxBuf, dist);
  for (var row = height - 2; row >= 0; row--) {
    chamferPropagate(row * width + width - 1, width, channel, minBuf, maxBuf, dist);
    for (var col = width - 2; col >= 0; col--) {
      var pixelIdx = row * width + col;
      chamferPropagate(pixelIdx, 1, channel, minBuf, maxBuf, dist);
      chamferPropagate(pixelIdx, width, channel, minBuf, maxBuf, dist)
    }
  }
}

export function chamferPropagate(pixelIdx, neighborStep, channel, minBuf, maxBuf, dist) {
  var nbrIdx = pixelIdx + neighborStep,
    nbrMax = maxBuf[pixelIdx],
    nbrMin = minBuf[nbrIdx],
    curMin = dist[nbrIdx];
  if (nbrMin < nbrMax) nbrMin = nbrMax;
  else if (nbrMax < curMin) curMin = nbrMax;
  var newDist = nbrMin - curMin;
  if (dist[nbrIdx] != 65535 && newDist < dist[pixelIdx]) {
    dist[pixelIdx] = newDist;
    minBuf[pixelIdx] = nbrMin;
    maxBuf[pixelIdx] = curMin
  }
}

