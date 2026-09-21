/**
 * The graph cut quick-select turns brush scribbles into a selection with.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildQuickSelectColorAnalysis } from "../../../src/engine/compositing/color-range.js";
import {
  buildSuperpixelGraph,
  collectMarkedSegments,
  cutRegionFromSeeds,
  fitColorClusters,
  labDistanceToClusters,
  rasterizeSegmentSelection,
  refineMaskBoundary,
} from "../../../src/engine/compositing/quick-select-graph-cut.js";

const WIDTH = 240;
const HEIGHT = 180;

/**
 * A red disc and a green square on a blue ground: two objects with hard edges,
 * far enough apart that nothing but the cut can join them.
 */
function twoObjectImage() {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 4;
      const inDisc = Math.hypot(x - 150, y - 90) < 45;
      const inSquare = x > 25 && x < 75 && y > 30 && y < 80;
      rgba[i] = inDisc ? 210 : inSquare ? 40 : 30;
      rgba[i + 1] = inDisc ? 60 : inSquare ? 180 : 40;
      rgba[i + 2] = inDisc ? 50 : inSquare ? 70 : 160;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function analyse(rgba) {
  const segmentation = buildQuickSelectColorAnalysis(rgba, WIDTH, HEIGHT);
  return buildSuperpixelGraph(rgba, WIDTH, HEIGHT, segmentation);
}

/** Mark a round dab of foreground (255) or background (0), as the brush does. */
function dab(marks, centerX, centerY, radius, value) {
  for (let y = centerY - radius; y <= centerY + radius; y++) {
    for (let x = centerX - radius; x <= centerX + radius; x++) {
      if (Math.hypot(x - centerX, y - centerY) <= radius) marks[y * WIDTH + x] = value;
    }
  }
  return marks;
}

function emptyMarks() {
  return new Uint8Array(WIDTH * HEIGHT).fill(128);
}

function maskArea(mask) {
  let area = 0;
  for (let i = 0; i < WIDTH * HEIGHT; i++) if (mask[i] > 127) area++;
  return area;
}

describe("engine/compositing/quick-select-graph-cut.js", () => {
  // Every superpixel has to carry the colour and position the cut reasons
  // about, and every pair that touches has to be joined by exactly one arc in
  // each direction.
  it("gives the graph a node per superpixel and symmetric arcs", () => {
    const graph = analyse(twoObjectImage());
    assert.ok(graph.segmentCount > 1);
    assert.equal(graph.labL.length, graph.segmentCount);
    assert.equal(graph.centroidX.length, graph.segmentCount);
    for (let segId = 0; segId < graph.segmentCount; segId++) {
      for (let arc = graph.arcStart[segId]; arc < graph.arcStart[segId + 1]; arc++) {
        const neighborSeg = graph.arcSegment[arc];
        let mirrored = 0;
        for (let back = graph.arcStart[neighborSeg]; back < graph.arcStart[neighborSeg + 1]; back++) {
          if (graph.arcSegment[back] == segId) mirrored++;
        }
        assert.equal(mirrored, 1);
      }
    }
  });

  // A click claims about what the brush covered. Growing a selection is what
  // painting is for, so one dab does not take the whole object with it.
  it("keeps a single dab to about the size of the brush", () => {
    const rgba = twoObjectImage();
    const graph = analyse(rgba);
    const brushRadius = 10;
    const marks = dab(emptyMarks(), 150, 90, brushRadius, 255);
    const seeds = collectMarkedSegments(graph, marks, WIDTH * HEIGHT);
    const selected = cutRegionFromSeeds(graph, seeds.foregroundSegments, seeds.backgroundSegments, { brushRadius: brushRadius });
    const mask = new Uint8Array(WIDTH * HEIGHT);
    rasterizeSegmentSelection(graph.labels, selected, mask, WIDTH * HEIGHT);
    const brushArea = Math.PI * brushRadius * brushRadius;
    // A few superpixels' worth around the dab, not the disc it landed in.
    assert.ok(maskArea(mask) > brushArea * 0.5);
    assert.ok(maskArea(mask) < brushArea * 7);
    assert.ok(maskArea(mask) < Math.PI * 45 * 45 * 0.5);
    assert.equal(mask[90 * WIDTH + 150], 255);
    // Nowhere near the ground around the disc.
    assert.equal(mask[10 * WIDTH + 10], 0);
  });

  // Painting across an object is what claims it: the cut then reaches as far
  // as the stroke did, and stops at the object's edges rather than at the
  // outline of the brush.
  it("claims the object out to its edges when painted across", () => {
    const rgba = twoObjectImage();
    const graph = analyse(rgba);
    const marks = emptyMarks();
    const selected = new Uint8Array(graph.segmentCount);
    for (const centerX of [120, 135, 150, 165, 180]) {
      dab(marks, centerX, 90, 5, 255);
      const seeds = collectMarkedSegments(graph, marks, WIDTH * HEIGHT);
      const grown = cutRegionFromSeeds(graph, seeds.foregroundSegments, seeds.backgroundSegments, { brushRadius: 5 });
      for (let segId = 0; segId < graph.segmentCount; segId++) if (grown[segId]) selected[segId] = 1;
    }
    const mask = new Uint8Array(WIDTH * HEIGHT);
    rasterizeSegmentSelection(graph.labels, selected, mask, WIDTH * HEIGHT);
    const discArea = Math.PI * 45 * 45;
    assert.ok(maskArea(mask) > discArea * 0.85);
    assert.ok(maskArea(mask) < discArea * 1.15);
    // The square shares no colour with the disc and is nowhere near it.
    assert.equal(mask[55 * WIDTH + 50], 0);
  });

  // A region that resembles the scribble but has no path to it through the
  // foreground is somebody else's object, however cheap it would be to claim.
  it("leaves matching colour that the scribble cannot reach", () => {
    const rgba = twoObjectImage();
    // A second disc of the same red, on the far side of the image.
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        if (Math.hypot(x - 50, y - 130) >= 25) continue;
        const i = (y * WIDTH + x) * 4;
        rgba[i] = 210;
        rgba[i + 1] = 60;
        rgba[i + 2] = 50;
      }
    }
    const graph = analyse(rgba);
    const marks = dab(emptyMarks(), 150, 90, 5, 255);
    const seeds = collectMarkedSegments(graph, marks, WIDTH * HEIGHT);
    const selected = cutRegionFromSeeds(graph, seeds.foregroundSegments, seeds.backgroundSegments, {});
    const mask = new Uint8Array(WIDTH * HEIGHT);
    rasterizeSegmentSelection(graph.labels, selected, mask, WIDTH * HEIGHT);
    assert.equal(mask[130 * WIDTH + 50], 0);
    assert.equal(mask[90 * WIDTH + 150], 255);
  });

  // Marks win over the cut around them: a background scribble names a region
  // to cut back out of the selection.
  it("cuts a scribbled region back out of what is selected", () => {
    const rgba = twoObjectImage();
    const graph = analyse(rgba);
    const marks = dab(emptyMarks(), 150, 90, 5, 255);
    const seeds = collectMarkedSegments(graph, marks, WIDTH * HEIGHT);
    const selected = cutRegionFromSeeds(graph, seeds.foregroundSegments, seeds.backgroundSegments, {});
    assert.ok(selected.some((flag) => flag == 1));

    const subtractMarks = dab(emptyMarks(), 150, 90, 5, 0);
    const subtractSeeds = collectMarkedSegments(graph, subtractMarks, WIDTH * HEIGHT);
    const removed = cutRegionFromSeeds(graph, subtractSeeds.backgroundSegments, [], {
      candidateSegments: selected,
    });
    for (let segId = 0; segId < graph.segmentCount; segId++) if (removed[segId]) selected[segId] = 0;
    assert.ok(selected.every((flag) => flag == 0));
  });

  // A superpixel mask steps along superpixel corners; the refinement pass
  // pulls it onto the colour boundary and feathers the last pixel of it.
  it("refines the mask onto the colour boundary", () => {
    const rgba = twoObjectImage();
    const graph = analyse(rgba);
    const marks = dab(emptyMarks(), 150, 90, 5, 255);
    const seeds = collectMarkedSegments(graph, marks, WIDTH * HEIGHT);
    const selected = cutRegionFromSeeds(graph, seeds.foregroundSegments, seeds.backgroundSegments, {});
    const mask = new Uint8Array(WIDTH * HEIGHT);
    rasterizeSegmentSelection(graph.labels, selected, mask, WIDTH * HEIGHT);

    const foregroundSegments = [];
    const backgroundSegments = [];
    for (let segId = 0; segId < graph.segmentCount; segId++) {
      if (selected[segId]) foregroundSegments.push(segId);
      else backgroundSegments.push(segId);
    }
    const foregroundModel = fitColorClusters(graph, foregroundSegments, 3);
    const backgroundModel = fitColorClusters(graph, backgroundSegments, 3);
    refineMaskBoundary(rgba, WIDTH, HEIGHT, mask, foregroundModel, backgroundModel);

    assert.equal(mask[90 * WIDTH + 150], 255);
    assert.equal(mask[10 * WIDTH + 10], 0);
    const partial = Array.from(mask).filter((value) => value > 0 && value < 255).length;
    assert.ok(partial > 0);
  });

  // The colour model is what pulls unmarked superpixels to one side or the
  // other, so it has to sit on the colours of the superpixels it was fitted to.
  it("fits colour clusters to the superpixels it is given", () => {
    const graph = analyse(twoObjectImage());
    const marks = dab(emptyMarks(), 150, 90, 5, 255);
    const seeds = collectMarkedSegments(graph, marks, WIDTH * HEIGHT);
    const model = fitColorClusters(graph, seeds.foregroundSegments, 3);
    const seedSeg = seeds.foregroundSegments[0];
    assert.ok(labDistanceToClusters(model, graph.labL[seedSeg], graph.labA[seedSeg], graph.labB[seedSeg]) < 5);
  });
});
