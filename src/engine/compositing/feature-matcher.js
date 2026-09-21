/**
 * Feature matching for panorama alignment: SURF keypoints, ORB descriptors,
 * Hamming search trees, and RANSAC homographies.
 */

import { UnionFind } from "./region-polygon-trace.js";
import { allocBuffer, buildMipPyramidBox, downsampleTwoThirdsChannel, rgbaToGrayChannel } from "./buffer-utils.js";
import { composeHomographies, homographyTransformXY, invert, solveHomographyMatrix } from "./homography.js";
import { RngState } from "./compositing-ops.js";


const HAMMING_BIT_COUNT_LUT = new Uint8Array(256);
for (let byteVal = 0; byteVal < 256; byteVal++) {
  let setBitCount = 0;
  let bits = byteVal;
  while (bits != 0) {
    bits = bits & (bits - 1);
    setBitCount++;
  }
  HAMMING_BIT_COUNT_LUT[byteVal] = setBitCount;
}

const ORB_PATCH_RADIUS = 15;
const ORB_DESCRIPTOR_BITS = 256;
const SURF_FILTER_SIZE = 9;
const SURF_BORDER = 24;
const RANSAC_ITERATIONS = 3000;
const SEARCH_TREE_DEPTH = 4;
const DESCRIPTOR_BYTE_LEN = 32;

function buildIntegralImage(gray, width, height) {
  const integral = new Uint32Array(width * height);
  integral[0] = gray[0];
  for (let col = 1; col < width; col++) {
    integral[col] = integral[col - 1] + gray[col];
  }
  for (let row = 1; row < height; row++) {
    const rowOff = row * width;
    integral[rowOff] = integral[rowOff - width] + gray[rowOff];
    for (let col = 1; col < width; col++) {
      integral[rowOff + col] =
        gray[rowOff + col] +
        integral[rowOff + col - 1] +
        integral[rowOff + col - width] -
        integral[rowOff + col - width - 1];
    }
  }
  return integral;
}

function boxSum(integral, stride, left, right, top, bottom) {
  const topRow = (top - 1) * stride;
  const botRow = bottom * stride;
  return integral[botRow + right] - integral[botRow + left - 1] - integral[topRow + right] + integral[topRow + left - 1];
}

export function descriptorDistanceAtIndex(descA, descB, maxDistance) {
  let distance = 0;
  const byteLen = descA.length;
  for (let byteIdx = 0; byteIdx < byteLen && distance < maxDistance; byteIdx++) {
    distance += HAMMING_BIT_COUNT_LUT[descA[byteIdx] ^ descB[byteIdx]];
  }
  return distance;
}

export function considerMatchCandidate(srcKp, dstKp, dstIdx, topDistances, visited) {
  if (visited[dstIdx] == 1) {
    return;
  }
  const distance = descriptorDistanceAtIndex(srcKp.descriptorBytes, dstKp.descriptorBytes, topDistances[0]);
  if (distance < topDistances[0]) {
    if (distance < topDistances[2]) {
      topDistances[0] = topDistances[2];
      topDistances[1] = topDistances[3];
      topDistances[2] = distance;
      topDistances[3] = dstIdx;
    } else {
      topDistances[0] = distance;
      topDistances[1] = dstIdx;
    }
  }
  visited[dstIdx] = 1;
}

export function buildDescriptorSearchTree(keypoints) {
  const negativeSignIdx = [];
  const positiveSignIdx = [];
  const treesBySign = [[], []];
  for (let kpIdx = 0; kpIdx < keypoints.length; kpIdx++) {
    (keypoints[kpIdx].responseSign == 0 ? negativeSignIdx : positiveSignIdx).push(kpIdx);
  }
  for (let signIdx = 0; signIdx < 2; signIdx++) {
    const signList = signIdx == 0 ? negativeSignIdx : positiveSignIdx;
    const targetBucketSize = signList.length / 256;
    const candidates = [];
    for (let byteIdx = 0; byteIdx < DESCRIPTOR_BYTE_LEN; byteIdx++) {
      const buckets = new Array(256);
      let imbalance = 0;
      for (let bucketVal = 0; bucketVal < 256; bucketVal++) {
        buckets[bucketVal] = [];
      }
      for (let listIdx = 0; listIdx < signList.length; listIdx++) {
        const kpIdx = signList[listIdx];
        buckets[keypoints[kpIdx].descriptorBytes[byteIdx]].push(kpIdx);
      }
      for (let bucketVal = 0; bucketVal < 256; bucketVal++) {
        imbalance += Math.abs(buckets[bucketVal].length - targetBucketSize);
      }
      candidates.push([imbalance, byteIdx, buckets]);
    }
    candidates.sort(function (a, b) {
      return a[0] - b[0];
    });
    const byteIndices = [];
    const bucketLists = [];
    treesBySign[signIdx] = [byteIndices, bucketLists];
    for (let depthIdx = 0; depthIdx < SEARCH_TREE_DEPTH; depthIdx++) {
      byteIndices.push(candidates[depthIdx][1]);
      bucketLists.push(candidates[depthIdx][2]);
    }
  }
  return treesBySign;
}

export function matchDescriptors(srcKeypoints, dstKeypoints, searchTrees) {
  const matches = [];
  const bestForDst = new Uint16Array(dstKeypoints.length);
  bestForDst.fill(65535);
  const visited = new Uint8Array(dstKeypoints.length);
  const topDistances = new Uint32Array(4);
  for (let srcIdx = 0; srcIdx < srcKeypoints.length; srcIdx++) {
    const srcKp = srcKeypoints[srcIdx];
    const desc = srcKp.descriptorBytes;
    topDistances.fill(1e6);
    visited.fill(0);
    const tree = searchTrees[srcKp.responseSign];
    for (let depthIdx = 0; depthIdx < tree[1].length; depthIdx++) {
      const bucket = tree[1][depthIdx][desc[tree[0][depthIdx]]];
      for (let bucketIdx = 0; bucketIdx < bucket.length; bucketIdx++) {
        const dstIdx = bucket[bucketIdx];
        considerMatchCandidate(srcKp, dstKeypoints[dstIdx], dstIdx, topDistances, visited);
      }
    }
    if (topDistances[2] < 50 && topDistances[2] < topDistances[0] * 0.5) {
      const matchSlot = bestForDst[topDistances[3]];
      if (matchSlot == 65535) {
        bestForDst[topDistances[3]] = matches.length;
        matches.push([srcIdx, topDistances[3], topDistances[2]]);
      } else if (topDistances[2] < matches[matchSlot][2]) {
        matches[matchSlot] = [srcIdx, topDistances[3], topDistances[2]];
      }
    }
  }
  matches.sort(function (a, b) {
    return a[2] - b[2];
  });
  return matches;
}

export function ransacHomographyFromMatches(srcKeypoints, dstKeypoints, matches, inlierThresholdSq) {
  let bestHomography;
  let bestInlierCount = 0;
  let bestErrorSum = 0;
  const matchCount = matches.length;
  const mappedXY = new Float64Array(2);
  for (let iter = 0; iter < RANSAC_ITERATIONS; iter++) {
    const idx0 = ~~(Math.random() * matchCount);
    const idx1 = ~~(Math.random() * matchCount);
    const idx2 = ~~(Math.random() * matchCount);
    const idx3 = ~~(Math.random() * matchCount);
    let inlierCount = 0;
    let errorSum = 0;
    if (idx0 == idx1 || idx0 == idx2 || idx0 == idx3 || idx1 == idx2 || idx1 == idx3 || idx2 == idx3) {
      continue;
    }
    const match0 = matches[idx0];
    const match1 = matches[idx1];
    const match2 = matches[idx2];
    const match3 = matches[idx3];
    const src0 = srcKeypoints[match0[0]];
    const dst0 = dstKeypoints[match0[1]];
    const src1 = srcKeypoints[match1[0]];
    const dst1 = dstKeypoints[match1[1]];
    const src2 = srcKeypoints[match2[0]];
    const dst2 = dstKeypoints[match2[1]];
    const src3 = srcKeypoints[match3[0]];
    const dst3 = dstKeypoints[match3[1]];
    const srcCorners = [src0.x, src0.y, src1.x, src1.y, src2.x, src2.y, src3.x, src3.y];
    const dstCorners = [dst0.x, dst0.y, dst1.x, dst1.y, dst2.x, dst2.y, dst3.x, dst3.y];
    const homography = solveHomographyMatrix(srcCorners, dstCorners);
    if (homography[0] == 0 && homography[1] == 0 && homography[3] == 0 && homography[4] == 0) {
      continue;
    }
    const earlyStop = matchCount - bestInlierCount + 2;
    for (let matchIdx = 0; matchIdx < matchCount && matchIdx - inlierCount < earlyStop; matchIdx++) {
      const srcPt = srcKeypoints[matches[matchIdx][0]];
      const dstPt = dstKeypoints[matches[matchIdx][1]];
      homographyTransformXY(dstPt.x, dstPt.y, homography, mappedXY);
      const errX = mappedXY[0] - srcPt.x;
      const errY = mappedXY[1] - srcPt.y;
      const errSq = errX * errX + errY * errY;
      if (errSq < inlierThresholdSq) {
        inlierCount++;
        errorSum += errSq;
      }
    }
    if (inlierCount > bestInlierCount || (inlierCount == bestInlierCount && errorSum < bestErrorSum)) {
      bestHomography = homography;
      bestInlierCount = inlierCount;
      bestErrorSum = errorSum;
    }
  }
  return bestHomography;
}

export function buildGrayIntegralPyramid(grayBuf, bounds, includeTwoThirdsMip) {
  const levels = [];
  const boxMip = [grayBuf, bounds];
    buildMipPyramidBox(boxMip);
  let twoThirdsMip;
    if (includeTwoThirdsMip) {
    const twoThirds = downsampleTwoThirdsChannel(grayBuf, bounds);
    const twoThirdsRect = twoThirds.rect;
        twoThirdsMip = [twoThirds.buffer, twoThirdsRect];
    buildMipPyramidBox(twoThirdsMip);
  }
  for (let levelIdx = 0; levelIdx < boxMip.length; levelIdx++) {
    const levelGray = boxMip[2 * levelIdx];
    const levelRect = boxMip[2 * levelIdx + 1];
    const levelWidth = levelRect.width;
    const levelHeight = levelRect.height;
    const minDim = Math.min(levelWidth, levelHeight);
    if (minDim < 30) {
      break;
    }
    if (minDim < 1600) {
      levels.push({
        grayMip: levelGray,
        width: levelWidth,
        height: levelHeight,
        docScale: 1 << levelIdx,
        integralImage: buildIntegralImage(levelGray, levelWidth, levelHeight),
      });
    }
    if (!includeTwoThirdsMip) {
      continue;
    }
    const twoThirdsGray = twoThirdsMip[2 * levelIdx];
    const twoThirdsRect = twoThirdsMip[2 * levelIdx + 1];
    const twoThirdsWidth = twoThirdsRect.width;
    const twoThirdsHeight = twoThirdsRect.height;
    const twoThirdsMinDim = Math.min(twoThirdsWidth, twoThirdsHeight);
    if (twoThirdsMinDim < 30) {
      break;
    }
    if (twoThirdsMinDim < 1600) {
      levels.push({
        grayMip: twoThirdsGray,
        width: twoThirdsWidth,
        height: twoThirdsHeight,
        docScale: (1 << levelIdx) * 3 / 2,
        integralImage: buildIntegralImage(twoThirdsGray, twoThirdsWidth, twoThirdsHeight),
      });
    }
  }
  return levels;
}

function detectSurfKeypoints(pyramid, maxCount) {
  const keypoints = [];
  for (let levelIdx = 0; levelIdx < pyramid.length; levelIdx++) {
    const level = pyramid[levelIdx];
    const integral = level.integralImage;
    const levelWidth = level.width;
    const levelHeight = level.height;
    const filterSize = SURF_FILTER_SIZE;
    const step = 1;
    const border = SURF_BORDER;
    if (integral == null) {
      continue;
    }
    const response = new Float32Array(levelWidth * levelHeight);
    const polarity = new Uint8Array(levelWidth * levelHeight);
    const half = filterSize >>> 1;
    const third = half >>> 1;
    const thirdStep = Math.round(filterSize / 3);
    const norm = 1 / (filterSize * filterSize);
    const thresholdScale = 1.2 * (filterSize / 9);
    for (let row = half + 1; row < levelHeight - half; row += step) {
      for (let col = half + 1; col < levelWidth - half; col += step) {
        const haarX =
          boxSum(integral, levelWidth, col - third, col + third, row - half, row + half) -
          3 * boxSum(integral, levelWidth, col - third, col + third, row - half + thirdStep, row + half - thirdStep);
        const haarY =
          boxSum(integral, levelWidth, col - half, col + half, row - third, row + third) -
          3 * boxSum(integral, levelWidth, col - half + thirdStep, col + half - thirdStep, row - third, row + third);
        const left = col - half + 1;
        const right = col + half - 1;
        const top = row - half + 1;
        const bottom = row + half - 1;
        const haarXY =
          boxSum(integral, levelWidth, left, col - 1, top, row - 1) +
          boxSum(integral, levelWidth, col + 1, right, row + 1, bottom) -
          boxSum(integral, levelWidth, col + 1, right, top, row - 1) -
          boxSum(integral, levelWidth, left, col - 1, row + 1, bottom);
        const det = (haarY * haarX - 0.9 * haarXY * (0.9 * haarXY)) * (norm * norm);
        response[row * levelWidth + col] = Math.abs(det);
        polarity[row * levelWidth + col] = det < 0 ? 0 : 1;
      }
    }
    const rowStride = levelWidth * step;
    for (let row = border; row < levelHeight - border; row += step) {
      for (let col = border; col < levelWidth - border; col += step) {
        const off = row * levelWidth + col;
        const score = response[off];
        if (score < 16) {
          continue;
        }
        if (response[off - step] >= score || response[off + step] >= score) {
          continue;
        }
        if (
          response[off - rowStride - step] >= score ||
          response[off - rowStride] >= score ||
          response[off - rowStride + step] >= score
        ) {
          continue;
        }
        if (
          response[off + rowStride - step] >= score ||
          response[off + rowStride] >= score ||
          response[off + rowStride + step] >= score
        ) {
          continue;
        }
        keypoints.push({
          x: ~~(col * level.docScale + 0.5),
          y: ~~(row * level.docScale + 0.5),
          localX: col,
          localY: row,
          pyramidLevel: levelIdx,
          responseScore: score,
          responseSign: polarity[off],
          thresholdScale: thresholdScale,
        });
      }
    }
  }
  if (maxCount != null) {
    keypoints.sort(function (a, b) {
      return b.responseScore - a.responseScore;
    });
    return keypoints.slice(0, maxCount);
  }
  return keypoints;
}

function createOrbDescriptor() {
  const boxHalf = Math.round(ORB_PATCH_RADIUS / 8);
  const pairOffsets = [];

  function boxSampleAt(x, y, integral, stride) {
    const ix = ~~(x + 0.5);
    const iy = ~~(y + 0.5);
    return boxSum(integral, stride, ix - boxHalf, ix + boxHalf, iy - boxHalf, iy + boxHalf);
  }

  function ensurePairOffsets() {
    if (pairOffsets.length != 0) {
      return;
    }
    const rng = new RngState(16200817);
    const gaussScale = 8;
    let pairCount = 0;
    function gaussSample() {
      let unitA = 0;
      let unitB = 0;
      while (unitA === 0) {
        unitA = rng.get();
      }
      while (unitB === 0) {
        unitB = rng.get();
      }
      return Math.sqrt(-2 * Math.log(unitA)) * Math.cos(2 * Math.PI * unitB);
    }
    while (pairCount != ORB_DESCRIPTOR_BITS) {
      const pairAx = Math.max(-ORB_PATCH_RADIUS, Math.min(ORB_PATCH_RADIUS, gaussSample() * gaussScale));
      const pairAy = Math.max(-ORB_PATCH_RADIUS, Math.min(ORB_PATCH_RADIUS, gaussSample() * gaussScale));
      const pairBx = Math.max(-ORB_PATCH_RADIUS, Math.min(ORB_PATCH_RADIUS, gaussSample() * gaussScale));
      const pairBy = Math.max(-ORB_PATCH_RADIUS, Math.min(ORB_PATCH_RADIUS, gaussSample() * gaussScale));
      const dx = pairAx - pairBx;
      const dy = pairAy - pairBy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 3 || dist > 12) {
        continue;
      }
      pairOffsets.push(pairAx, pairAy, pairBx, pairBy);
      pairCount++;
    }
  }

  function computeOrientations(pyramid, keypoints) {
    for (let kpIdx = 0; kpIdx < keypoints.length; kpIdx++) {
      const kp = keypoints[kpIdx];
      let momentX = 0;
      let momentY = 0;
      const level = pyramid[kp.pyramidLevel];
      const grayMip = level.grayMip;
      const levelWidth = level.width;
      const levelHeight = level.height;
      for (let dy = -ORB_PATCH_RADIUS; dy <= ORB_PATCH_RADIUS; dy++) {
        for (let dx = -ORB_PATCH_RADIUS; dx <= ORB_PATCH_RADIUS; dx++) {
          const sampleX = dx + kp.localX;
          const sampleY = dy + kp.localY;
          if (
            dx * dx + dy * dy > ORB_PATCH_RADIUS * ORB_PATCH_RADIUS ||
            sampleX < 0 ||
            sampleY < 0 ||
            sampleX >= levelWidth ||
            sampleY >= levelHeight
          ) {
            continue;
          }
          const gray = grayMip[sampleY * levelWidth + sampleX];
          momentX += dx * gray;
          momentY += dy * gray;
        }
      }
      kp.orientation = Math.atan2(momentY, momentX);
    }
  }

  function computeDescriptors(pyramid, keypoints, _grayBuf, _width, _height) {
    ensurePairOffsets();
    for (let kpIdx = 0; kpIdx < keypoints.length; kpIdx++) {
      const kp = keypoints[kpIdx];
      const level = pyramid[kp.pyramidLevel];
      const integral = level.integralImage;
      const levelWidth = level.width;
      const localX = kp.localX;
      const localY = kp.localY;
      const angle = kp.orientation;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const descriptor = new Uint8Array(ORB_DESCRIPTOR_BITS >>> 3);
        kp.descriptorBytes = descriptor;
      for (let bitIdx = 0; bitIdx < ORB_DESCRIPTOR_BITS; bitIdx++) {
        const pairOff = bitIdx * 4;
        const pairAx = pairOffsets[pairOff + 0];
        const pairAy = pairOffsets[pairOff + 1];
        const pairBx = pairOffsets[pairOff + 2];
        const pairBy = pairOffsets[pairOff + 3];
        const rotX0 = cosA * pairAx - sinA * pairAy;
        const rotY0 = sinA * pairAx + cosA * pairAy;
        const rotX1 = cosA * pairBx - sinA * pairBy;
        const rotY1 = sinA * pairBx + cosA * pairBy;
        const sampleA = boxSampleAt(localX + rotX0, localY + rotY0, integral, levelWidth);
        const sampleB = boxSampleAt(localX + rotX1, localY + rotY1, integral, levelWidth);
        descriptor[bitIdx >>> 3] |= (sampleA < sampleB ? 0 : 1) << (bitIdx & 7);
      }
    }
  }

  return {
    computeOrientations,
    computeDescriptors,
  };
}

/**
 * The ORB sampling pairs are drawn once from a fixed seed, so every descriptor
 * in a session compares the same point pairs.
 */
let orbDescriptor = null;
function getOrbDescriptor() {
  if (orbDescriptor === null) orbDescriptor = createOrbDescriptor();
  return orbDescriptor;
}

export function detectKeypointsForLayers(layerPairs, skipDescriptors, maxKeypoints) {
  const keypointsPerLayer = [];
  for (let layerIdx = 0; layerIdx < layerPairs.length; layerIdx++) {
    const pixels = layerPairs[layerIdx][0];
    const bounds = layerPairs[layerIdx][1];
    const width = bounds.width;
    const height = bounds.height;
    const grayBuf = allocBuffer(bounds.area());
    rgbaToGrayChannel(pixels, grayBuf);
    const pyramid = buildGrayIntegralPyramid(grayBuf, bounds, true);
    const keypoints = detectSurfKeypoints(pyramid, maxKeypoints);
    if (!skipDescriptors) {
      getOrbDescriptor().computeOrientations(pyramid, keypoints);
      getOrbDescriptor().computeDescriptors(pyramid, keypoints, grayBuf, width, height);
    }
    keypointsPerLayer.push(keypoints);
  }
  return keypointsPerLayer;
}

export function estimatePanoramaHomographies(layerPairs, referenceIdx) {
  const layerCount = layerPairs.length;
  const keypointsPerLayer = detectKeypointsForLayers(layerPairs, false, 1e4);
  for (let layerIdx = 0; layerIdx < layerCount; layerIdx++) {
    const bounds = layerPairs[layerIdx][1];
    for (let kpIdx = 0; kpIdx < keypointsPerLayer[layerIdx].length; kpIdx++) {
      keypointsPerLayer[layerIdx][kpIdx].x += bounds.x;
      keypointsPerLayer[layerIdx][kpIdx].y += bounds.y;
    }
  }
  const searchTrees = [];
  for (let layerIdx = 0; layerIdx < layerCount; layerIdx++) {
    searchTrees[layerIdx] = buildDescriptorSearchTree(keypointsPerLayer[layerIdx]);
  }
  const pairMatches = [];
  for (let layerA = 0; layerA < layerCount - 1; layerA++) {
    for (let layerB = layerA + 1; layerB < layerCount; layerB++) {
      let matches = matchDescriptors(keypointsPerLayer[layerA], keypointsPerLayer[layerB], searchTrees[layerB]);
      matches = matches.slice(0, matches.length >>> 1);
      if (matches.length < 10) {
        return null;
      }
      const homography = ransacHomographyFromMatches(keypointsPerLayer[layerA], keypointsPerLayer[layerB], matches, 2);
      pairMatches.push([layerA, layerB, matches, homography]);
    }
  }
  pairMatches.sort(function (a, b) {
    return b[2].length - a[2].length;
  });
  const spanningPairs = [];
  const unionFind = new UnionFind(layerCount);
  for (let pairIdx = 0; pairIdx < pairMatches.length; pairIdx++) {
    const pair = pairMatches[pairIdx];
    const rootA = unionFind.find(pair[0]);
    const rootB = unionFind.find(pair[1]);
    if (rootA != rootB) {
      spanningPairs.push(pair);
      unionFind.link(rootA, rootB);
    }
  }
  const homographies = [];
  for (let layerIdx = 0; layerIdx < layerCount; layerIdx++) {
    homographies[layerIdx] = [1, 0, 0, 0, 1, 0, 0, 0];
  }
  const visitStack = [0];
  const visited = new Uint8Array(layerCount);
  visited[visitStack[0]] = 1;
  while (visitStack.length != 0) {
    const current = visitStack.pop();
    const currentH = homographies[current];
    for (let pairIdx = 0; pairIdx < spanningPairs.length; pairIdx++) {
      const pair = spanningPairs[pairIdx];
      const layerA = pair[0];
      const layerB = pair[1];
      if (layerA == current && visited[layerB] == 0) {
        homographies[layerB] = composeHomographies(currentH, pair[3]);
        visitStack.push(layerB);
        visited[layerB] = 1;
      }
      if (layerB == current && visited[layerA] == 0) {
        homographies[layerA] = composeHomographies(currentH, invert(pair[3]));
        visitStack.push(layerA);
        visited[layerA] = 1;
      }
    }
  }
  if (referenceIdx == null) {
    const txSort = [];
    for (let layerIdx = 0; layerIdx < layerCount; layerIdx++) {
      txSort.push([homographies[layerIdx][2], layerIdx]);
    }
    txSort.sort(function (a, b) {
      return a[0] - b[0];
    });
    referenceIdx = txSort[txSort.length >>> 1][1];
  }
  const refInv = invert(homographies[referenceIdx]);
  for (let layerIdx = 0; layerIdx < layerCount; layerIdx++) {
    homographies[layerIdx] = composeHomographies(homographies[layerIdx], refInv);
  }
  return homographies;
}

