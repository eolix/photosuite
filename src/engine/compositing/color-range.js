/**
 * Colour quantization, graph segmentation, and the superpixel segmentation
 * quick-select cuts its selections out of.
 */

import { UnionFind } from './region-polygon-trace.js';

/** Superpixel side length quick-select aims for, in pixels. */
const MAX_SUPERPIXEL_SIZE = 16;

/** Ceiling on superpixels per layer, so labels stay inside a Uint16Array. */
const MAX_SUPERPIXEL_COUNT = 40000;

/** Neighbor offsets for quantize pass (includes extended ring). */
function buildQuantizeNeighborOffsets(width) {
  return [
    width, 1, -width, -1, width + 1, -width + 1, -width - 1, width - 1,
    width + width, 2, -width - width, -2, width + width - 1, width + width + 1,
    width + 2, -width + 2, -width - width + 1, -width - width - 1, -width - 2,
    width - 2, width + width + 2, -width - width + 2 - width - width - 2, width + width - 2,
  ];
}

export function rgbaSquaredDistanceToCluster(cluster, red, green, blue, alpha) {
  const centroid = cluster.est.q;
  const deltaRed = red - centroid[0];
  const deltaGreen = green - centroid[1];
  const deltaBlue = blue - centroid[2];
  const deltaAlpha = alpha - centroid[3];
  return deltaRed * deltaRed + deltaGreen * deltaGreen + deltaBlue * deltaBlue + deltaAlpha * deltaAlpha;
}

export function findNearestClusterWithinTolerance(kdtree, red, green, blue, alpha, tolerance) {
  const nearest = UPNG.quantize.getNearest(kdtree[0], red, green, blue, alpha);
  return rgbaSquaredDistanceToCluster(nearest, red, green, blue, alpha) < tolerance ? nearest : null;
}

export function rgbaGridEdgeWeight(rgbaBuffer, pixelIdxA, pixelIdxB) {
  const offA = pixelIdxA << 2;
  const offB = pixelIdxB << 2;
  const deltaRed = rgbaBuffer[offA] - rgbaBuffer[offB];
  const deltaGreen = rgbaBuffer[offA + 1] - rgbaBuffer[offB + 1];
  const deltaBlue = rgbaBuffer[offA + 2] - rgbaBuffer[offB + 2];
  const deltaAlpha = rgbaBuffer[offA + 3] - rgbaBuffer[offB + 3];
  return (deltaRed * deltaRed + deltaGreen * deltaGreen + deltaBlue * deltaBlue + deltaAlpha * deltaAlpha) >> 2;
}

export function buildGridAdjacencyWeights(rgbaBuffer, width, height) {
  const edgeWeights = new Uint16Array(width * height * 2);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const pixelIdx = row * width + col;
      edgeWeights[pixelIdx + pixelIdx] = col < width - 1
        ? rgbaGridEdgeWeight(rgbaBuffer, pixelIdx, pixelIdx + 1)
        : 65535;
      edgeWeights[pixelIdx + pixelIdx + 1] = row < height - 1
        ? rgbaGridEdgeWeight(rgbaBuffer, pixelIdx, pixelIdx + width)
        : 65535;
    }
  }
  return edgeWeights;
}

export function buildQuantizedSegmentLabels(imageData, width, height, maxClusters, colorTolerance) {
  var solidClusters = enumerateSolidColorTiles(imageData.buffer, width, height).colorClusters,
    clusterRgbaKeys = new Uint32Array(solidClusters.length);
  for (var clusterIdx = 0; clusterIdx < solidClusters.length; clusterIdx++) clusterRgbaKeys[clusterIdx] = solidClusters[clusterIdx].packedRgba;
  var kdtree = UPNG.quantize.getKDtree(new Uint8Array(clusterRgbaKeys.buffer), maxClusters),
    neighborOffsets = buildQuantizeNeighborOffsets(width),
    segmentLabels = new Uint8Array(width * height),
    pixels = imageData;
  for (var row = 0; row < height; row++)
    for (var col = 0; col < width; col++) {
      var pixelOff = row * width + col << 2,
        r = pixels[pixelOff] * (1 / 255),
        g = pixels[pixelOff + 1] * (1 / 255),
        b = pixels[pixelOff + 2] * (1 / 255),
        a = pixels[pixelOff + 3] * (1 / 255),
        matchedCluster = findNearestClusterWithinTolerance(kdtree, r, g, b, a, colorTolerance);
      if (matchedCluster == null) {
        var neighborCandidates = [],
          neighborIdx = 0;
        while (neighborIdx < 20) {
          var neighborOff = row * width + col + neighborOffsets[neighborIdx] << 2,
            nr = pixels[neighborOff] * (1 / 255),
            ng = pixels[neighborOff + 1] * (1 / 255),
            nb = pixels[neighborOff + 2] * (1 / 255),
            na = pixels[neighborOff + 3] * (1 / 255),
            neighborCluster = findNearestClusterWithinTolerance(kdtree, nr, ng, nb, na, .005);
          if (neighborCluster != null) {
            if (neighborCandidates.indexOf(neighborCluster) == -1) {
              neighborCandidates.push(neighborCluster);
              neighborCluster.neighborVoteCount = 1
            } else neighborCluster.neighborVoteCount++
          }
          neighborIdx++
        }
        neighborCandidates.sort(function(left, right) {
          return right.neighborVoteCount - left.neighborVoteCount
        });
        while (neighborCandidates.length != 0 && neighborCandidates[neighborCandidates.length - 1].neighborVoteCount < 3) neighborCandidates.pop();
        if (neighborCandidates.length == 0) matchedCluster = findNearestClusterWithinTolerance(kdtree, r, g, b, a, 100);
        else if (neighborCandidates.length == 1) matchedCluster = neighborCandidates[0];
        else if (neighborCandidates.length == 2) {
          var clusterA = neighborCandidates[0],
            clusterB = neighborCandidates[1],
            centroidA = clusterA.est.q,
            centroidB = clusterB.est.q,
            deltaR = centroidB[0] - centroidA[0],
            deltaG = centroidB[1] - centroidA[1],
            deltaB = centroidB[2] - centroidA[2],
            deltaA = centroidB[3] - centroidA[3],
            offsetR = r - centroidA[0],
            offsetG = g - centroidA[1],
            offsetB = b - centroidA[2],
            offsetA = a - centroidA[3],
            chordLenSq = deltaR * deltaR + deltaG * deltaG + deltaB * deltaB + deltaA * deltaA,
            distSq = offsetR * offsetR + offsetG * offsetG + offsetB * offsetB + offsetA * offsetA,
            projT = (offsetR * deltaR + offsetG * deltaG + offsetB * deltaB + offsetA * deltaA) / chordLenSq,
            perpDistSq = distSq - projT * projT * chordLenSq;
          if (perpDistSq < .5) matchedCluster = projT < .5 ? clusterA : clusterB;
          else {
            matchedCluster = findNearestClusterWithinTolerance(kdtree, r, g, b, a, 100)
          }
        } else {
          var clusterA = neighborCandidates[0],
            clusterB = neighborCandidates[1],
            clusterC = neighborCandidates[2],
            centroidA = clusterA.est.q,
            centroidB = clusterB.est.q,
            centroidC = clusterC.est.q,
            abR = centroidA[0] - centroidC[0],
            abG = centroidA[1] - centroidC[1],
            abB = centroidA[2] - centroidC[2],
            abA = centroidA[3] - centroidC[3],
            cbR = centroidB[0] - centroidC[0],
            cbG = centroidB[1] - centroidC[1],
            cbB = centroidB[2] - centroidC[2],
            cbA = centroidB[3] - centroidC[3],
            pcR = centroidC[0] - r,
            pcG = centroidC[1] - g,
            pcB = centroidC[2] - b,
            pcA = centroidC[3] - a,
            abLenSq = abR * abR + abG * abG + abB * abB + abA * abA,
            abDotCb = abR * cbR + abG * cbG + abB * cbB + abA * cbA,
            abDotPc = pcR * abR + pcG * abG + pcB * abB + pcA * abA,
            cbLenSq = cbR * cbR + cbG * cbG + cbB * cbB + cbA * cbA,
            cbDotPc = pcR * cbR + pcG * cbG + pcB * cbB + pcA * cbA,
            invDet = 1 / (abDotCb * abDotCb - abLenSq * cbLenSq),
            baryU = (cbLenSq * abDotPc - cbDotPc * abDotCb) * invDet,
            baryV = (cbDotPc * abLenSq - abDotPc * abDotCb) * invDet,
            baryW = 1 - baryU - baryV,
            maxBary = Math.max(baryU, baryV, baryW);
          if (maxBary == baryU) matchedCluster = clusterA;
          else if (maxBary == baryV) matchedCluster = clusterB;
          else matchedCluster = clusterC
        }
      }
      segmentLabels[pixelOff >> 2] = matchedCluster.ind
    }
  return {
    pixelSegmentIndices: segmentLabels,
    colorClusters: kdtree[1]
  }
}

export function enumerateSolidColorTiles(rgbaBuffer, width, height) {
  var clusters = [],
    clusterIndexByRgba = {},
    lastCol = width - 1,
    lastRow = height - 1,
    solidTileCount = 0,
    packedPixels = new Uint32Array(rgbaBuffer),
    neighborOffsets = [-width - 1, -width, -width + 1, -1, 1, width - 1, width, width + 1, width + width, 2, -width - width, -2, width + width - 1, width + width + 1, width + 2, -width + 2, -width - width + 1, -width - width - 1, -width - 2, width - 2, width + width + 2, -width - width + 2 - width - width - 2, width + width - 2];
  for (var row = 1; row < lastRow; row++)
    for (var col = 1; col < lastCol; col++) {
      var pixelIdx = row * width + col,
        packed = packedPixels[pixelIdx],
        isSolidTile = true;
      for (var nbrIdx = 0; nbrIdx < 8; nbrIdx++) isSolidTile = isSolidTile && packedPixels[pixelIdx + neighborOffsets[nbrIdx]] == packed;
      if (isSolidTile) {
        solidTileCount++;
        var clusterIdx = clusterIndexByRgba[packed];
        if (clusterIdx == null) {
          clusterIndexByRgba[packed] = clusters.length;
          clusters.push({
            packedRgba: packed,
            pixelCount: 1
          })
        } else clusters[clusterIdx].pixelCount++
      }
    }
  return {
    colorClusters: clusters,
    solidTileCount: solidTileCount
  }
}

export function mergeSegmentsWithQuantizedColors(rgbaBuffer, width, height, mergeThreshold) {
  var graph = segmentByColorSimilarityGraph(rgbaBuffer, width, height, mergeThreshold),
    pixelSegmentIndices = graph.pixelSegmentIndices,
    colorClusters = graph.colorClusters,
    segmentRgbaKeys = graph.segmentRgbaKeys,
    quantTree = UPNG.quantize.getKDtree(new Uint8Array(segmentRgbaKeys.buffer.slice(0)), 200),
    clusterToQuantIndex = [];
  for (var clusterIdx = 0; clusterIdx < colorClusters.length; clusterIdx++) {
    var rgbaSum = colorClusters[clusterIdx].rgbaSum,
      sumR = rgbaSum[0],
      sumG = rgbaSum[1],
      sumB = rgbaSum[2],
      sumA = rgbaSum[3];
    if (Math.min(sumR, sumG, sumB, sumA) < 0) throw new Error("ColorRange: negative color-sum accumulator");
    var nearest = UPNG.quantize.getNearest(quantTree[0], sumR / 255, sumG / 255, sumB / 255, sumA / 255);
    clusterToQuantIndex.push(quantTree[1].indexOf(nearest))
  }
  for (var pixelIdx = 0; pixelIdx < width * height; pixelIdx++) pixelSegmentIndices[pixelIdx] = clusterToQuantIndex[pixelSegmentIndices[pixelIdx]];
  return {
    pixelSegmentIndices: pixelSegmentIndices,
    colorClusters: quantTree[1]
  }
}

export function segmentByColorSimilarityGraph(rgbaBuffer, width, height, mergeThreshold) {
  var pixelCount = width * height,
    edgePairCount = 2 * pixelCount,
    edgeWeights = buildGridAdjacencyWeights(rgbaBuffer, width, height),
    weightBucketCount = 65535 + 1,
    weightHistogram = new Uint32Array(weightBucketCount),
    bucketBase = 0;
  for (var edgeIdx = 0; edgeIdx < edgePairCount; edgeIdx++) weightHistogram[edgeWeights[edgeIdx]]++;
  var bucketWriteCursor = new Uint32Array(weightBucketCount);
  for (var bucket = 0; bucket < weightBucketCount; bucket++) {
    bucketWriteCursor[bucket] = bucketBase;
    bucketBase += weightHistogram[bucket]
  }
  var edgesByWeight = new Uint32Array(edgePairCount);
  for (var edgeIdx = 0; edgeIdx < edgePairCount; edgeIdx++) {
    var weight = edgeWeights[edgeIdx];
    edgesByWeight[bucketWriteCursor[weight]] = edgeIdx;
    bucketWriteCursor[weight]++
  }
  var unionFind = new UnionFind(pixelCount),
    mergeThresholdByRoot = new Uint16Array(pixelCount),
    pixelCountByRoot = new Uint32Array(pixelCount);
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) pixelCountByRoot[pixelIdx] = 1;
  var remainingRoots = pixelCount,
    scale = 1e5 / (mergeThreshold * 10);
  for (var sortIdx = 0; sortIdx < edgePairCount; sortIdx++) {
    var edgeIdx = edgesByWeight[sortIdx],
      edgeWeight = edgeWeights[edgeIdx];
    if (edgeWeight == 65535) continue;
    var pixelA = edgeIdx >> 1,
      pixelB = pixelA + ((edgeIdx & 1) == 0 ? 1 : width),
      rootA = unionFind.find(pixelA),
      rootB = unionFind.find(pixelB),
      mergeLimit = Math.min(mergeThresholdByRoot[rootA] + scale / Math.sqrt(pixelCountByRoot[rootA]), mergeThresholdByRoot[rootB] + scale / Math.sqrt(pixelCountByRoot[rootB]));
    if (rootA != rootB && edgeWeight <= mergeLimit) {
      unionFind.link(pixelA, pixelB);
      remainingRoots--;
      var mergedRoot = unionFind.find(pixelA);
      pixelCountByRoot[mergedRoot] = pixelCountByRoot[rootA] + pixelCountByRoot[rootB];
      mergeThresholdByRoot[mergedRoot] = edgeWeight
    }
  }
  var clusters = [],
    clusterIndexByRoot = {},
    pixelSegmentIndices = new Uint16Array(pixelCount);
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    var root = unionFind.find(pixelIdx),
      clusterIdx = clusterIndexByRoot[root];
    if (clusterIdx == null) {
      clusterIndexByRoot[root] = clusterIdx = clusters.length;
      clusters.push({
        pixelCount: 0,
        rgbaSum: [0, 0, 0, 0]
      })
    }
    clusters[clusterIdx].pixelCount++;
    for (var ch = 0; ch < 4; ch++) clusters[clusterIdx].rgbaSum[ch] += rgbaBuffer[(pixelIdx << 2) + ch];
    pixelSegmentIndices[pixelIdx] = clusterIdx
  }
  var segmentRgbaKeys = new Uint32Array(clusters.length);
  for (var clusterIdx = 0; clusterIdx < clusters.length; clusterIdx++) {
    var cluster = clusters[clusterIdx];
    for (var ch = 0; ch < 4; ch++) cluster.rgbaSum[ch] = Math.round(cluster.rgbaSum[ch] / cluster.pixelCount);
    segmentRgbaKeys[clusterIdx] = cluster.rgbaSum[3] << 24 | cluster.rgbaSum[2] << 16 | cluster.rgbaSum[1] << 8 | cluster.rgbaSum[0]
  }
  return {
    pixelSegmentIndices: pixelSegmentIndices,
    colorClusters: clusters,
    segmentRgbaKeys: segmentRgbaKeys
  }
}

function pickSuperpixelAnchorCoords(rgba, width, height, gridCols, gridRows, searchRadius) {
  var anchors = [],
    scaleX = searchRadius,
    scaleY = searchRadius,
    halfSearch = searchRadius >>> 2;
  for (var gy = 0; gy < gridRows; gy++)
    for (var gx = 0; gx < gridCols; gx++) {
      var bestCol = ~~((gx + .5) * scaleX),
        bestRow = ~~((gy + .5) * scaleY),
        bestEnergy = 1e9,
        colMin = Math.max(0, bestCol - halfSearch),
        colMax = Math.min(width, bestCol + halfSearch + 1),
        rowMin = Math.max(0, bestRow - halfSearch),
        rowMax = Math.min(height, bestRow + halfSearch + 1);
      for (var row = rowMin; row < rowMax; row++)
        for (var col = colMin; col < colMax; col++) {
          var energy = edgeEnergyAtPixel(rgba, width, col, row);
          if (energy < bestEnergy) {
            bestCol = col;
            bestRow = row;
            bestEnergy = energy
          }
        }
      anchors.push(bestCol, bestRow)
    }
  return anchors
}
function edgeEnergyAtPixel(rgba, width, col, row) {
  var rgbaOff = (row * width + col) * 4,
    rowStride = width * 4,
    horiz = rgbChannelSquaredDiff(rgba, rgbaOff - 4, rgbaOff) + rgbChannelSquaredDiff(rgba, rgbaOff, rgbaOff + 4),
    vert = rgbChannelSquaredDiff(rgba, rgbaOff - rowStride, rgbaOff) + rgbChannelSquaredDiff(rgba, rgbaOff, rgbaOff + rowStride);
  return horiz + vert
}
function rgbChannelSquaredDiff(rgba, idxA, idxB) {
  var dr = rgba[idxA] - rgba[idxB],
    dg = rgba[idxA + 1] - rgba[idxB + 1],
    db = rgba[idxA + 2] - rgba[idxB + 2];
  return dr * dr + dg * dg + db * db
}
var floodFillMinBucket = 0,
  floodFillPendingCount = 0;
function enqueueFloodFillCell(buckets, col, row, priority) {
  floodFillPendingCount++;
  if (priority < floodFillMinBucket) floodFillMinBucket = priority;
  buckets[priority].push(col, row)
}
function advanceFloodFillQueue(buckets) {
  floodFillPendingCount--;
  while (buckets[floodFillMinBucket].length == 0) floodFillMinBucket++
}
/**
 * Grow the queued superpixel seeds outwards until the priority queue drains.
 * Each pixel joins the segment whose running colour and position average it is
 * closest to, and then offers its own unclaimed neighbours at that cost.
 */
function growFloodFillRegions(rgba, width, accumulators, buckets, labels, spatialWeight, scanlineLimit) {
  while (floodFillPendingCount != 0) {
    advanceFloodFillQueue(buckets);
    var segId = buckets[floodFillMinBucket].pop(),
      packedCoord = buckets[floodFillMinBucket].pop(),
      row = packedCoord >>> 16,
      col = packedCoord & 65535,
      pixelIdx = row * width + col;
    if (labels[pixelIdx] == 65535) {
      var accOff = segId * 6,
        rgbaOff = pixelIdx << 2;
      labels[pixelIdx] = segId;
      accumulators[accOff] += rgba[rgbaOff];
      accumulators[accOff + 1] += rgba[rgbaOff + 1];
      accumulators[accOff + 2] += rgba[rgbaOff + 2];
      accumulators[accOff + 3] += col;
      accumulators[accOff + 4] += row;
      accumulators[accOff + 5]++;
      if (row != scanlineLimit - 1 && labels[pixelIdx + width] == 65535) enqueueFloodFillCell(buckets, row + 1 << 16 | col, segId, floodFillNeighborCost(rgba, width, spatialWeight, col, row + 1, accumulators, accOff));
      if (row != 0 && labels[pixelIdx - width] == 65535) enqueueFloodFillCell(buckets, row - 1 << 16 | col, segId, floodFillNeighborCost(rgba, width, spatialWeight, col, row - 1, accumulators, accOff));
      if (col != 0 && labels[pixelIdx - 1] == 65535) enqueueFloodFillCell(buckets, row << 16 | col - 1, segId, floodFillNeighborCost(rgba, width, spatialWeight, col - 1, row, accumulators, accOff));
      if (col != width - 1 && labels[pixelIdx + 1] == 65535) enqueueFloodFillCell(buckets, row << 16 | col + 1, segId, floodFillNeighborCost(rgba, width, spatialWeight, col + 1, row, accumulators, accOff))
    }
  }
}

/**
 * Break an image into superpixels: seed one anchor per grid cell on the
 * lowest-gradient pixel nearby, then grow all the seeds at once.
 *
 * `segmentAccumulators` holds six running totals per segment — summed red,
 * green, blue, column, row, and pixel count — which give each segment's mean
 * colour and centroid without a second pass. `spatialWeight` is how much
 * distance counts against colour, and is kept so a later subdivision grows the
 * same way.
 */
function runQuickSelectSegmentation(rgba, width, height) {
  floodFillMinBucket = 0;
  floodFillPendingCount = 0;
  var pixelCount = width * height,
    superpixelSize = Math.round(Math.min(width, height) / 30);
  // A superpixel is the smallest thing quick-select can claim, so they are
  // kept near the size of a brush tip however large the image is. The cap on
  // how many there are keeps the labels inside 16 bits on very large images,
  // at the cost of coarser superpixels there.
  if (superpixelSize > MAX_SUPERPIXEL_SIZE) superpixelSize = MAX_SUPERPIXEL_SIZE;
  if (superpixelSize == 0) superpixelSize = 1;
  var sizeForSegmentCap = Math.ceil(Math.sqrt(pixelCount / MAX_SUPERPIXEL_COUNT));
  if (superpixelSize < sizeForSegmentCap) superpixelSize = sizeForSegmentCap;
  var spatialWeight = 30 / superpixelSize,
    gridCols = Math.floor(width / superpixelSize),
    gridRows = Math.floor(height / superpixelSize),
    pixelSegmentIndices = new Uint16Array(pixelCount);
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) pixelSegmentIndices[pixelIdx] = 65535;
  var anchors = pickSuperpixelAnchorCoords(rgba, width, height, gridCols, gridRows, superpixelSize),
    segmentCount = anchors.length >>> 1;
  if (segmentCount > 65535) throw segmentCount;
  var floodBuckets = [];
  for (var bucketIdx = 0; bucketIdx < 1e3 + height; bucketIdx++) floodBuckets.push([]);
  var segmentAccumulators = new Uint32Array(segmentCount * 6);
  for (var cellIdx = 0; cellIdx < segmentCount; cellIdx++) {
    var anchorPair = cellIdx * 2;
    enqueueFloodFillCell(floodBuckets, anchors[anchorPair + 1] << 16 | anchors[anchorPair], cellIdx, 0)
  }
  growFloodFillRegions(rgba, width, segmentAccumulators, floodBuckets, pixelSegmentIndices, spatialWeight, height);
  return {
    pixelSegmentIndices: pixelSegmentIndices,
    segmentCount: segmentCount,
    segmentAccumulators: segmentAccumulators,
    spatialWeight: spatialWeight,
    superpixelSize: superpixelSize
  }
}

function floodFillNeighborCost(rgba, width, spatialWeight, col, row, accumulators, accOff) {
  var rgbaOff = (row * width + col) * 4,
    count = accumulators[accOff + 5],
    invCount = 1 / count,
    dr = rgba[rgbaOff] * count - accumulators[accOff],
    dg = rgba[rgbaOff + 1] * count - accumulators[accOff + 1],
    db = rgba[rgbaOff + 2] * count - accumulators[accOff + 2],
    dc = col * count - accumulators[accOff + 3],
    drow = row * count - accumulators[accOff + 4],
    colorDist = Math.sqrt(dr * dr + dg * dg + db * db),
    spatialDist = Math.sqrt(dc * dc + drow * drow);
  return ~~((colorDist + spatialWeight * spatialDist) * invCount + .5)
}
/** The segmentation a quick-select session is built from. */
export function buildQuickSelectColorAnalysis(rgba, width, height) {
  return runQuickSelectSegmentation(rgba, width, height);
}

