/**
 * Quick-select: a minimum cut over superpixels that turns brush scribbles into
 * a selection snapped to the edges in the image.
 *
 * The layer is first broken into superpixels (`buildQuickSelectColorAnalysis`
 * in `color-range.js`). `buildSuperpixelGraph` turns that segmentation into a
 * region-adjacency graph: each node carries the superpixel's mean CIELAB
 * colour and centroid, and each arc the length and the colour contrast of the
 * boundary the two superpixels share.
 *
 * A scribble is then resolved by `cutRegionFromSeeds`. The superpixels the
 * brush marked are wired to a terminal at infinite cost; the superpixels
 * around them, out to a reach that grows with the length of the scribble, are
 * pulled towards foreground or background by how close their colour sits to a
 * k-means model of either side, and held to their neighbours by arc weights
 * that collapse where the boundary between them is a strong edge. The cheapest
 * cut of that network therefore runs along image edges rather than around the
 * outline of the brush, which is what separates this from a flood fill.
 *
 * Every function here is pure: the caller owns the segmentation, the scribble
 * marks and the mask that comes out.
 */

import { rgbToLab } from "./color-math.js";

/** Mark values in a scribble buffer. Anything else is unmarked. */
export const BACKGROUND_MARK = 0;
export const FOREGROUND_MARK = 255;

/** Cost of an arc that may not be cut: a scribbled superpixel's terminal arc. */
const TERMINAL_ANCHOR_COST = 1e9;

/** Share of a superpixel the brush has to cover for it to count as marked. */
const MINIMUM_MARK_COVERAGE = 0.3;

/** Colour-model clusters per side. Three covers a lit and a shadowed tone. */
const COLOR_CLUSTER_COUNT = 3;

/** Defaults for `cutRegionFromSeeds`, tuned on smooth ramps and hard edges. */
export const QUICK_SELECT_DEFAULTS = {
  /** Reach, as a multiple of how far the scribble itself travelled. */
  reachFactor: 1.6,
  /** Reach floor, as a multiple of the brush radius: one click claims about
   * what the brush covered, and painting is what makes a selection grow. */
  brushReachFactor: 1.25,
  /** Reach floor in pixels, for a brush finer than a superpixel. */
  minimumReach: 12,
  /** Superpixels this far out anchor the background side of the cut. */
  outerAnchorRatio: 0.95,
  /** ΔE past the scribble's own colour range at which a superpixel anchors
   * background. A dab carries one colour and so claims little; a drag across
   * several shades widens its own model and reaches further. */
  hardBackgroundDeltaE: 4,
  /** How much of the scribble's colour spread is added to that cutoff. */
  spreadTolerance: 1.5,
  /** Weight of the colour model against the boundary terms. */
  dataWeight: 30,
  /** Weight of boundary agreement: higher gives smoother, tighter silhouettes. */
  smoothnessWeight: 42,
};

/**
 * Build the region-adjacency graph a cut runs on.
 *
 * `segmentation` is what `buildQuickSelectColorAnalysis` returns: per-pixel
 * superpixel labels plus six running totals per superpixel (summed red, green,
 * blue, column, row, and pixel count).
 */
export function buildSuperpixelGraph(rgba, width, height, segmentation) {
  const segmentCount = segmentation.segmentCount;
  const labels = segmentation.pixelSegmentIndices;
  const accumulators = segmentation.segmentAccumulators;
  const labL = new Float32Array(segmentCount);
  const labA = new Float32Array(segmentCount);
  const labB = new Float32Array(segmentCount);
  const centroidX = new Float32Array(segmentCount);
  const centroidY = new Float32Array(segmentCount);
  const pixelCounts = new Uint32Array(segmentCount);
  for (let segId = 0; segId < segmentCount; segId++) {
    const accOff = segId * 6;
    const count = accumulators[accOff + 5];
    pixelCounts[segId] = count;
    if (count == 0) continue;
    const lab = rgbToLab(accumulators[accOff] / count, accumulators[accOff + 1] / count, accumulators[accOff + 2] / count);
    labL[segId] = lab.labL;
    labA[segId] = lab.labA;
    labB[segId] = lab.labB;
    centroidX[segId] = accumulators[accOff + 3] / count;
    centroidY[segId] = accumulators[accOff + 4] / count;
  }

  const neighborIds = [];
  const neighborLengths = [];
  const neighborContrastSums = [];
  const neighborSlots = [];
  for (let segId = 0; segId < segmentCount; segId++) {
    neighborIds.push([]);
    neighborLengths.push([]);
    neighborContrastSums.push([]);
    neighborSlots.push(new Map());
  }
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const pixelIdx = row * width + col;
      const segId = labels[pixelIdx];
      if (col != 0) recordBoundaryPixel(rgba, labels, neighborIds, neighborLengths, neighborContrastSums, neighborSlots, segId, pixelIdx, pixelIdx - 1);
      if (row != 0) recordBoundaryPixel(rgba, labels, neighborIds, neighborLengths, neighborContrastSums, neighborSlots, segId, pixelIdx, pixelIdx - width);
    }
  }

  let arcCount = 0;
  for (let segId = 0; segId < segmentCount; segId++) arcCount += neighborIds[segId].length;
  const arcStart = new Int32Array(segmentCount + 1);
  const arcSegment = new Int32Array(arcCount);
  const arcLength = new Float32Array(arcCount);
  const arcContrast = new Float32Array(arcCount);
  let contrastTotal = 0;
  let contrastCount = 0;
  let writeOff = 0;
  for (let segId = 0; segId < segmentCount; segId++) {
    arcStart[segId] = writeOff;
    const ids = neighborIds[segId];
    for (let slot = 0; slot < ids.length; slot++) {
      const boundaryLength = neighborLengths[segId][slot];
      const meanContrast = neighborContrastSums[segId][slot] / boundaryLength;
      arcSegment[writeOff] = ids[slot];
      arcLength[writeOff] = boundaryLength;
      arcContrast[writeOff] = meanContrast;
      writeOff++;
      contrastTotal += meanContrast;
      contrastCount++;
    }
  }
  arcStart[segmentCount] = writeOff;

  // The contrast a boundary has to beat to read as an edge is the contrast of
  // a typical boundary in this image, so the same weights work on a flat
  // studio shot and on a noisy one.
  const meanContrast = contrastCount == 0 ? 1 : contrastTotal / contrastCount;
  return {
    segmentCount: segmentCount,
    labels: labels,
    width: width,
    height: height,
    labL: labL,
    labA: labA,
    labB: labB,
    centroidX: centroidX,
    centroidY: centroidY,
    pixelCounts: pixelCounts,
    arcStart: arcStart,
    arcSegment: arcSegment,
    arcLength: arcLength,
    arcContrast: arcContrast,
    contrastSigma: Math.max(1, meanContrast),
    meanBoundaryLength: Math.max(1, segmentation.superpixelSize == null ? 16 : segmentation.superpixelSize),
  };
}

/**
 * Split the scribble marks in `brushMask` by the superpixel they landed on.
 *
 * A superpixel takes the side it carries more marks of, and only once the
 * brush has covered enough of it to mean it: clipping the corner of a
 * superpixel on the way past is not a claim on everything it holds, and
 * without that a click would always claim every cell it grazed. A side that
 * covered nothing that far still keeps its best-covered superpixel, so the
 * smallest brush on the coarsest superpixels still selects something.
 */
export function collectMarkedSegments(graph, brushMask, pixelCount) {
  const segmentCount = graph.segmentCount;
  const foregroundCounts = new Uint32Array(segmentCount);
  const backgroundCounts = new Uint32Array(segmentCount);
  const labels = graph.labels;
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    const markValue = brushMask[pixelIdx];
    if (markValue == FOREGROUND_MARK) foregroundCounts[labels[pixelIdx]]++;
    else if (markValue == BACKGROUND_MARK) backgroundCounts[labels[pixelIdx]]++;
  }
  const foregroundSegments = [];
  const backgroundSegments = [];
  let bestForegroundSeg = -1;
  let bestBackgroundSeg = -1;
  for (let segId = 0; segId < segmentCount; segId++) {
    const foregroundCount = foregroundCounts[segId];
    const backgroundCount = backgroundCounts[segId];
    if (foregroundCount == 0 && backgroundCount == 0) continue;
    const covered = graph.pixelCounts[segId] * MINIMUM_MARK_COVERAGE;
    if (foregroundCount >= backgroundCount) {
      if (bestForegroundSeg == -1 || foregroundCount > foregroundCounts[bestForegroundSeg]) bestForegroundSeg = segId;
      if (foregroundCount >= covered) foregroundSegments.push(segId);
    } else {
      if (bestBackgroundSeg == -1 || backgroundCount > backgroundCounts[bestBackgroundSeg]) bestBackgroundSeg = segId;
      if (backgroundCount >= covered) backgroundSegments.push(segId);
    }
  }
  if (foregroundSegments.length == 0 && bestForegroundSeg != -1) foregroundSegments.push(bestForegroundSeg);
  if (backgroundSegments.length == 0 && bestBackgroundSeg != -1) backgroundSegments.push(bestBackgroundSeg);
  return { foregroundSegments: foregroundSegments, backgroundSegments: backgroundSegments };
}

/**
 * Cut the region the seeds belong to out of the graph.
 *
 * `seedSegments` are wired to the source and grow; `opposingSegments` are
 * wired to the sink. `options.modelSegments` is what the foreground colour
 * model is fitted to, and defaults to the seeds — a stroke can then keep
 * growing from its newest marks while the model still knows every colour the
 * user has claimed. `options.windowRect` pins the reach to a rectangle
 * instead of deriving it from the seeds, and `options.candidateSegments` is a
 * flag per superpixel restricting which ones may join the foreground.
 *
 * Returns a flag per superpixel: 1 where the cut put it on the foreground side.
 */
export function cutRegionFromSeeds(graph, seedSegments, opposingSegments, options) {
  const settings = options == null ? {} : options;
  const segmentCount = graph.segmentCount;
  const selected = new Uint8Array(segmentCount);
  if (seedSegments.length == 0) return selected;

  const reachFactor = pick(settings.reachFactor, QUICK_SELECT_DEFAULTS.reachFactor);
  const modelSegments = settings.modelSegments == null || settings.modelSegments.length == 0 ? seedSegments : settings.modelSegments;
  const brushRadius = pick(settings.brushRadius, 0);
  const brushReach = brushRadius * pick(settings.brushReachFactor, QUICK_SELECT_DEFAULTS.brushReachFactor);
  const minimumReach = Math.max(pick(settings.minimumReach, QUICK_SELECT_DEFAULTS.minimumReach), brushReach);
  const outerAnchorRatio = pick(settings.outerAnchorRatio, QUICK_SELECT_DEFAULTS.outerAnchorRatio);
  const baseDeltaE = pick(settings.hardBackgroundDeltaE, QUICK_SELECT_DEFAULTS.hardBackgroundDeltaE);
  const spreadTolerance = pick(settings.spreadTolerance, QUICK_SELECT_DEFAULTS.spreadTolerance);
  const dataWeight = pick(settings.dataWeight, QUICK_SELECT_DEFAULTS.dataWeight);
  const smoothnessWeight = pick(settings.smoothnessWeight, QUICK_SELECT_DEFAULTS.smoothnessWeight);
  const candidateSegments = settings.candidateSegments == null ? null : settings.candidateSegments;

  // How far out the cut is allowed to look. A click reaches the floor; a long
  // drag reaches past everything it crossed, so the selection keeps up.
  // Reach is set by the whole scribble, not just the marks being resolved
  // now, so a stroke keeps reaching further the longer it is drawn; the
  // candidates are still gathered around the new marks.
  const reach = windowReach(graph, modelSegments, settings.windowRect, reachFactor, minimumReach, brushRadius * 2);
  const reachSquared = reach * reach;
  const anchorRadius = reach * outerAnchorRatio;
  const anchorRadiusSquared = anchorRadius * anchorRadius;

  const foregroundModel = fitColorClusters(graph, modelSegments, COLOR_CLUSTER_COUNT);
  const hardBackgroundDeltaE = baseDeltaE + spreadTolerance * modelColorSpread(graph, foregroundModel, modelSegments);
  const isSeed = new Uint8Array(segmentCount);
  for (let i = 0; i < seedSegments.length; i++) isSeed[seedSegments[i]] = 1;
  const isOpposing = new Uint8Array(segmentCount);
  for (let i = 0; i < opposingSegments.length; i++) isOpposing[opposingSegments[i]] = 1;

  // 0 outside the cut, 1 free, 2 anchored to the sink, 3 anchored to the source.
  const nodeRole = new Uint8Array(segmentCount);
  const anchorSegments = [];
  const colorAnchorSegments = [];
  const freeSegments = [];
  const seedBounds = seedCentroidBounds(graph, seedSegments);
  for (let segId = 0; segId < segmentCount; segId++) {
    if (graph.pixelCounts[segId] == 0) continue;
    if (isSeed[segId]) {
      nodeRole[segId] = 3;
      continue;
    }
    // Everything outside the scribble's own box plus the reach is out of
    // range without measuring it against each seed in turn.
    if (!isOpposing[segId] && (graph.centroidX[segId] < seedBounds.minX - reach || graph.centroidX[segId] > seedBounds.maxX + reach
      || graph.centroidY[segId] < seedBounds.minY - reach || graph.centroidY[segId] > seedBounds.maxY + reach)) continue;
    const seedDistanceSquared = nearestSeedDistanceSquared(graph, seedSegments, segId);
    if (seedDistanceSquared > reachSquared && !isOpposing[segId]) continue;
    const differsInColor = isOpposing[segId] || labDistanceToModel(graph, foregroundModel, segId) >= hardBackgroundDeltaE;
    if (differsInColor || seedDistanceSquared >= anchorRadiusSquared) {
      nodeRole[segId] = 2;
      anchorSegments.push(segId);
      // Only what actually differs in colour is worth fitting a background
      // model to. An anchor that is merely out of reach can be the same
      // object continuing, and fitting the model to that would tell every
      // superpixel between here and it that it is background.
      if (differsInColor) colorAnchorSegments.push(segId);
      continue;
    }
    if (candidateSegments != null && candidateSegments[segId] == 0) {
      nodeRole[segId] = 2;
      anchorSegments.push(segId);
      continue;
    }
    nodeRole[segId] = 1;
    freeSegments.push(segId);
  }

  // With nothing to cut against, everything in reach is foreground.
  if (anchorSegments.length == 0) {
    for (let segId = 0; segId < segmentCount; segId++) if (nodeRole[segId] != 0) selected[segId] = 1;
    return selected;
  }
  // With no anchor that differs in colour there is nothing to model the
  // background with: the scribble sits in the middle of one flat region, and
  // the ring of anchors around it is all that decides how far it reaches.
  const hasColorAnchors = colorAnchorSegments.length != 0;
  const backgroundModel = fitColorClusters(graph, colorAnchorSegments, COLOR_CLUSTER_COUNT);

  const nodeIndices = new Int32Array(segmentCount).fill(-1);
  const cutSegments = [];
  for (let segId = 0; segId < segmentCount; segId++) {
    if (nodeRole[segId] == 0) continue;
    nodeIndices[segId] = cutSegments.length;
    cutSegments.push(segId);
  }
  const nodeCount = cutSegments.length;
  const source = nodeCount;
  const sink = nodeCount + 1;
  const network = createFlowNetwork(nodeCount + 2);

  for (let node = 0; node < nodeCount; node++) {
    const segId = cutSegments[node];
    if (nodeRole[segId] == 3) {
      addFlowArc(network, source, node, TERMINAL_ANCHOR_COST, 0);
    } else if (nodeRole[segId] == 2) {
      addFlowArc(network, node, sink, TERMINAL_ANCHOR_COST, 0);
    } else if (!hasColorAnchors) {
      addFlowArc(network, source, node, dataWeight, 0);
    } else {
      const distanceToForeground = labDistanceToModel(graph, foregroundModel, segId);
      const distanceToBackground = labDistanceToModel(graph, backgroundModel, segId);
      const total = distanceToForeground + distanceToBackground + 0.001;
      addFlowArc(network, source, node, dataWeight * (distanceToBackground / total), 0);
      addFlowArc(network, node, sink, dataWeight * (distanceToForeground / total), 0);
    }
  }

  const contrastSigma = graph.contrastSigma;
  for (let node = 0; node < nodeCount; node++) {
    const segId = cutSegments[node];
    const arcEnd = graph.arcStart[segId + 1];
    for (let arc = graph.arcStart[segId]; arc < arcEnd; arc++) {
      const neighborSeg = graph.arcSegment[arc];
      if (neighborSeg < segId) continue;
      const neighborNode = nodeIndices[neighborSeg];
      if (neighborNode < 0) continue;
      // The evidence for an edge between two superpixels is the stronger of
      // the contrast across their shared boundary and the distance between
      // their mean colours; agreement decays as a Gaussian in it.
      const boundaryEvidence = Math.max(graph.arcContrast[arc], labDistanceBetweenSegments(graph, segId, neighborSeg));
      const agreement = Math.exp(-(boundaryEvidence * boundaryEvidence) / (2 * contrastSigma * contrastSigma));
      const weight = smoothnessWeight * agreement * (graph.arcLength[arc] / graph.meanBoundaryLength);
      addFlowArc(network, node, neighborNode, weight, weight);
    }
  }

  solveMaxFlow(network, source, sink);
  const sourceSide = collectSourceSide(network, source);
  for (let node = 0; node < nodeCount; node++) if (sourceSide[node]) selected[cutSegments[node]] = 1;
  return keepComponentsTouchingSeeds(graph, selected, seedSegments);
}

/**
 * Drop whatever the cut put on the foreground side without a path to a seed.
 * A region the other side of the image can be as cheap to claim as the one
 * under the brush when it happens to share its colours; the brush says where,
 * not only what, so only what the scribble can reach through the foreground
 * survives.
 */
function keepComponentsTouchingSeeds(graph, selected, seedSegments) {
  const connected = new Uint8Array(graph.segmentCount);
  const queue = new Int32Array(graph.segmentCount);
  let writeOff = 0;
  for (let i = 0; i < seedSegments.length; i++) {
    const segId = seedSegments[i];
    if (connected[segId] || !selected[segId]) continue;
    connected[segId] = 1;
    queue[writeOff++] = segId;
  }
  let readOff = 0;
  while (readOff < writeOff) {
    const segId = queue[readOff++];
    const arcEnd = graph.arcStart[segId + 1];
    for (let arc = graph.arcStart[segId]; arc < arcEnd; arc++) {
      const neighborSeg = graph.arcSegment[arc];
      if (connected[neighborSeg] || !selected[neighborSeg]) continue;
      connected[neighborSeg] = 1;
      queue[writeOff++] = neighborSeg;
    }
  }
  return connected;
}

/** Paint the selected superpixels into an 8-bit mask. */
export function rasterizeSegmentSelection(labels, segmentSelected, outMask, pixelCount) {
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) outMask[pixelIdx] = segmentSelected[labels[pixelIdx]] ? 255 : 0;
}

/**
 * Pull the mask off the superpixel grid and onto the pixels.
 *
 * Superpixel boundaries are a few pixels away from where the colour actually
 * changes, so every pixel within `bandRadius` of the mask border is reassigned
 * by whichever colour model it sits closer to, and the border is then given
 * one pass of coverage anti-aliasing.
 */
export function refineMaskBoundary(rgba, width, height, mask, foregroundModel, backgroundModel, bandRadius) {
  const radius = bandRadius == null ? 2 : bandRadius;
  const pixelCount = width * height;
  // 0 away from the border, 3 in the band and not yet decided, then 2 for a
  // pixel the colour models call foreground and 1 for background. Only the
  // band is ever walked again, so the cost is the length of the border rather
  // than the size of the image.
  const bandState = new Uint8Array(pixelCount);
  const bandPixels = [];
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const pixelIdx = row * width + col;
      const value = mask[pixelIdx];
      if ((col != 0 && mask[pixelIdx - 1] != value) || (col != width - 1 && mask[pixelIdx + 1] != value)
        || (row != 0 && mask[pixelIdx - width] != value) || (row != height - 1 && mask[pixelIdx + width] != value)) {
        bandState[pixelIdx] = 3;
        bandPixels.push(pixelIdx);
      }
    }
  }
  if (bandPixels.length == 0) return;

  let layerStart = 0;
  let layerEnd = bandPixels.length;
  for (let layer = 1; layer < radius; layer++) {
    for (let listOff = layerStart; listOff < layerEnd; listOff++) {
      const pixelIdx = bandPixels[listOff];
      const col = pixelIdx % width;
      const row = (pixelIdx - col) / width;
      if (col != 0 && bandState[pixelIdx - 1] == 0) { bandState[pixelIdx - 1] = 3; bandPixels.push(pixelIdx - 1); }
      if (col != width - 1 && bandState[pixelIdx + 1] == 0) { bandState[pixelIdx + 1] = 3; bandPixels.push(pixelIdx + 1); }
      if (row != 0 && bandState[pixelIdx - width] == 0) { bandState[pixelIdx - width] = 3; bandPixels.push(pixelIdx - width); }
      if (row != height - 1 && bandState[pixelIdx + width] == 0) { bandState[pixelIdx + width] = 3; bandPixels.push(pixelIdx + width); }
    }
    layerStart = layerEnd;
    layerEnd = bandPixels.length;
  }

  for (let listOff = 0; listOff < bandPixels.length; listOff++) {
    const pixelIdx = bandPixels[listOff];
    const rgbaOff = pixelIdx << 2;
    const lab = rgbToLab(rgba[rgbaOff], rgba[rgbaOff + 1], rgba[rgbaOff + 2]);
    const distanceToForeground = labDistanceToClusters(foregroundModel, lab.labL, lab.labA, lab.labB);
    const distanceToBackground = labDistanceToClusters(backgroundModel, lab.labL, lab.labA, lab.labB);
    bandState[pixelIdx] = distanceToForeground <= distanceToBackground ? 2 : 1;
  }

  // One pass of coverage anti-aliasing, so the border does not read as a
  // staircase of superpixel corners.
  for (let listOff = 0; listOff < bandPixels.length; listOff++) {
    const pixelIdx = bandPixels[listOff];
    const col = pixelIdx % width;
    const row = (pixelIdx - col) / width;
    let coverage = 0;
    let samples = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const sampleRow = row + dy;
      if (sampleRow < 0 || sampleRow >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const sampleCol = col + dx;
        if (sampleCol < 0 || sampleCol >= width) continue;
        const sampleIdx = sampleRow * width + sampleCol;
        const sampleState = bandState[sampleIdx];
        coverage += sampleState == 0 ? mask[sampleIdx] : sampleState == 2 ? 255 : 0;
        samples++;
      }
    }
    mask[pixelIdx] = Math.round(coverage / samples);
  }
}

/** The k-means colour clusters of a set of superpixels, as a flat L,a,b list. */
export function fitColorClusters(graph, segments, clusterCount) {
  const sampleCount = segments.length;
  const wanted = Math.max(1, Math.min(clusterCount, sampleCount));
  const clusters = new Float32Array(wanted * 3);
  if (sampleCount == 0) return clusters;
  // Seed the clusters evenly across the samples rather than at random, so the
  // same scribble always gives the same model.
  for (let clusterIdx = 0; clusterIdx < wanted; clusterIdx++) {
    const segId = segments[Math.floor(clusterIdx * sampleCount / wanted)];
    clusters[clusterIdx * 3] = graph.labL[segId];
    clusters[clusterIdx * 3 + 1] = graph.labA[segId];
    clusters[clusterIdx * 3 + 2] = graph.labB[segId];
  }
  const sums = new Float64Array(wanted * 3);
  const counts = new Uint32Array(wanted);
  for (let iteration = 0; iteration < 6; iteration++) {
    sums.fill(0);
    counts.fill(0);
    for (let sampleIdx = 0; sampleIdx < sampleCount; sampleIdx++) {
      const segId = segments[sampleIdx];
      let bestCluster = 0;
      let bestDistance = Infinity;
      for (let clusterIdx = 0; clusterIdx < wanted; clusterIdx++) {
        const distance = squaredLabDistance(graph.labL[segId], graph.labA[segId], graph.labB[segId],
          clusters[clusterIdx * 3], clusters[clusterIdx * 3 + 1], clusters[clusterIdx * 3 + 2]);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestCluster = clusterIdx;
        }
      }
      sums[bestCluster * 3] += graph.labL[segId];
      sums[bestCluster * 3 + 1] += graph.labA[segId];
      sums[bestCluster * 3 + 2] += graph.labB[segId];
      counts[bestCluster]++;
    }
    for (let clusterIdx = 0; clusterIdx < wanted; clusterIdx++) {
      if (counts[clusterIdx] == 0) continue;
      clusters[clusterIdx * 3] = sums[clusterIdx * 3] / counts[clusterIdx];
      clusters[clusterIdx * 3 + 1] = sums[clusterIdx * 3 + 1] / counts[clusterIdx];
      clusters[clusterIdx * 3 + 2] = sums[clusterIdx * 3 + 2] / counts[clusterIdx];
    }
  }
  return clusters;
}

/** Distance from a colour to the nearest cluster of a model. */
export function labDistanceToClusters(clusters, labL, labA, labB) {
  let best = Infinity;
  for (let clusterIdx = 0; clusterIdx * 3 < clusters.length; clusterIdx++) {
    const distance = squaredLabDistance(labL, labA, labB, clusters[clusterIdx * 3], clusters[clusterIdx * 3 + 1], clusters[clusterIdx * 3 + 2]);
    if (distance < best) best = distance;
  }
  return Math.sqrt(best);
}

/**
 * How far the scribble's own colours sit from the model fitted to them: near
 * zero for a dab on flat colour, and larger the more shades the stroke has
 * crossed. It is what the cutoff around the model is widened by.
 */
function modelColorSpread(graph, clusters, segments) {
  if (segments.length == 0) return 0;
  let total = 0;
  for (let i = 0; i < segments.length; i++) {
    total += labDistanceToModel(graph, clusters, segments[i]);
  }
  return total / segments.length;
}

function pick(value, fallback) {
  return value == null ? fallback : value;
}

function recordBoundaryPixel(rgba, labels, neighborIds, neighborLengths, neighborContrastSums, neighborSlots, segId, pixelIdx, neighborPixelIdx) {
  const neighborSeg = labels[neighborPixelIdx];
  if (neighborSeg == segId) return;
  const contrast = pixelLabDistance(rgba, pixelIdx << 2, neighborPixelIdx << 2);
  appendBoundarySample(neighborIds, neighborLengths, neighborContrastSums, neighborSlots, segId, neighborSeg, contrast);
  appendBoundarySample(neighborIds, neighborLengths, neighborContrastSums, neighborSlots, neighborSeg, segId, contrast);
}

function appendBoundarySample(neighborIds, neighborLengths, neighborContrastSums, neighborSlots, segId, neighborSeg, contrast) {
  const slots = neighborSlots[segId];
  let slot = slots.get(neighborSeg);
  if (slot == null) {
    slot = neighborIds[segId].length;
    slots.set(neighborSeg, slot);
    neighborIds[segId].push(neighborSeg);
    neighborLengths[segId].push(0);
    neighborContrastSums[segId].push(0);
  }
  neighborLengths[segId][slot]++;
  neighborContrastSums[segId][slot] += contrast;
}

function pixelLabDistance(rgba, offA, offB) {
  const labA = rgbToLab(rgba[offA], rgba[offA + 1], rgba[offA + 2]);
  const labB = rgbToLab(rgba[offB], rgba[offB + 1], rgba[offB + 2]);
  return Math.sqrt(squaredLabDistance(labA.labL, labA.labA, labA.labB, labB.labL, labB.labA, labB.labB));
}

function squaredLabDistance(l1, a1, b1, l2, a2, b2) {
  const dl = l1 - l2;
  const da = a1 - a2;
  const db = b1 - b2;
  return dl * dl + da * da + db * db;
}

function labDistanceBetweenSegments(graph, segA, segB) {
  return Math.sqrt(squaredLabDistance(graph.labL[segA], graph.labA[segA], graph.labB[segA], graph.labL[segB], graph.labA[segB], graph.labB[segB]));
}

function labDistanceToModel(graph, clusters, segId) {
  return labDistanceToClusters(clusters, graph.labL[segId], graph.labA[segId], graph.labB[segId]);
}

function nearestSeedDistanceSquared(graph, seedSegments, segId) {
  const x = graph.centroidX[segId];
  const y = graph.centroidY[segId];
  let best = Infinity;
  for (let i = 0; i < seedSegments.length; i++) {
    const dx = x - graph.centroidX[seedSegments[i]];
    const dy = y - graph.centroidY[seedSegments[i]];
    const distance = dx * dx + dy * dy;
    if (distance < best) best = distance;
  }
  return best;
}

function seedCentroidBounds(graph, seedSegments) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < seedSegments.length; i++) {
    const x = graph.centroidX[seedSegments[i]];
    const y = graph.centroidY[seedSegments[i]];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
}

/**
 * How far out of the scribble the cut may look.
 *
 * What the brush covered standing still is not travel, so the brush's own
 * width comes off the span before it counts: a click reaches the floor the
 * brush sets, and only painting past that makes the selection grow.
 */
function windowReach(graph, seedSegments, windowRect, reachFactor, minimumReach, brushDiameter) {
  if (windowRect != null) return Math.hypot(windowRect.width, windowRect.height);
  const bounds = seedCentroidBounds(graph, seedSegments);
  const span = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const travel = Math.max(0, span - brushDiameter);
  return Math.max(minimumReach, travel * reachFactor);
}

/**
 * A flow network as parallel arrays: `arcHead` indexes the first arc out of a
 * node and `arcNext` chains the rest, so arcs can be added without resizing
 * per-node lists. Each arc is stored with its reverse at the neighbouring
 * index, which is what `arcIdx ^ 1` relies on.
 */
function createFlowNetwork(nodeCount) {
  return {
    nodeCount: nodeCount,
    arcHead: new Int32Array(nodeCount).fill(-1),
    arcTarget: [],
    arcCapacity: [],
    arcNext: [],
  };
}

function addFlowArc(network, from, to, capacity, reverseCapacity) {
  network.arcTarget.push(to);
  network.arcCapacity.push(capacity);
  network.arcNext.push(network.arcHead[from]);
  network.arcHead[from] = network.arcTarget.length - 1;
  network.arcTarget.push(from);
  network.arcCapacity.push(reverseCapacity);
  network.arcNext.push(network.arcHead[to]);
  network.arcHead[to] = network.arcTarget.length - 1;
}

/** Dinic's algorithm: repeatedly saturate every shortest augmenting path. */
function solveMaxFlow(network, source, sink) {
  const levels = new Int32Array(network.nodeCount);
  const nextArc = new Int32Array(network.nodeCount);
  const queue = new Int32Array(network.nodeCount);
  while (buildLevelGraph(network, source, sink, levels, queue)) {
    nextArc.set(network.arcHead);
    let pushed = pushBlockingFlow(network, source, sink, Infinity, levels, nextArc);
    while (pushed > 0) pushed = pushBlockingFlow(network, source, sink, Infinity, levels, nextArc);
  }
}

function buildLevelGraph(network, source, sink, levels, queue) {
  levels.fill(-1);
  levels[source] = 0;
  queue[0] = source;
  let readOff = 0;
  let writeOff = 1;
  while (readOff < writeOff) {
    const node = queue[readOff++];
    for (let arc = network.arcHead[node]; arc != -1; arc = network.arcNext[arc]) {
      const target = network.arcTarget[arc];
      if (levels[target] != -1 || network.arcCapacity[arc] <= 1e-9) continue;
      levels[target] = levels[node] + 1;
      queue[writeOff++] = target;
    }
  }
  return levels[sink] != -1;
}

function pushBlockingFlow(network, node, sink, limit, levels, nextArc) {
  if (node == sink) return limit;
  for (; nextArc[node] != -1; nextArc[node] = network.arcNext[nextArc[node]]) {
    const arc = nextArc[node];
    const target = network.arcTarget[arc];
    if (levels[target] != levels[node] + 1 || network.arcCapacity[arc] <= 1e-9) continue;
    const pushed = pushBlockingFlow(network, target, sink, Math.min(limit, network.arcCapacity[arc]), levels, nextArc);
    if (pushed <= 1e-9) continue;
    network.arcCapacity[arc] -= pushed;
    network.arcCapacity[arc ^ 1] += pushed;
    return pushed;
  }
  return 0;
}

/** The nodes still reachable from the source once the flow is maximal. */
function collectSourceSide(network, source) {
  const reached = new Uint8Array(network.nodeCount);
  const queue = new Int32Array(network.nodeCount);
  reached[source] = 1;
  queue[0] = source;
  let readOff = 0;
  let writeOff = 1;
  while (readOff < writeOff) {
    const node = queue[readOff++];
    for (let arc = network.arcHead[node]; arc != -1; arc = network.arcNext[arc]) {
      const target = network.arcTarget[arc];
      if (reached[target] || network.arcCapacity[arc] <= 1e-9) continue;
      reached[target] = 1;
      queue[writeOff++] = target;
    }
  }
  return reached;
}
