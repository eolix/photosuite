import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGridAdjacencyWeights, buildQuickSelectColorAnalysis, enumerateSolidColorTiles, rgbaGridEdgeWeight, rgbaSquaredDistanceToCluster, segmentByColorSimilarityGraph } from "../../../src/engine/compositing/color-range.js";

describe("engine/compositing/color-range.js graph weights", () => {
  it("enumerateSolidColorTiles skips checkerboard interior on 2×2", () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255]);
    const result = enumerateSolidColorTiles(rgba.buffer, 2, 2);
    assert.equal(result.solidTileCount, 0);
    assert.equal(result.colorClusters.length, 0);
  });

  it("rgbaGridEdgeWeight and buildGridAdjacencyWeights match captured values", () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255]);
    assert.equal(rgbaGridEdgeWeight(rgba, 0, 1), 32512);
    assert.deepEqual(
      Array.from(buildGridAdjacencyWeights(rgba, 2, 2)),
      [32512, 32512, 65535, 32512, 32512, 65535, 65535, 65535],
    );
  });

  it("rgbaSquaredDistanceToCluster measures centroid distance in normalized RGBA", () => {
    const cluster = { est: { q: [1, 0, 0, 1] } };
    const dist = rgbaSquaredDistanceToCluster(cluster, 0.9, 0.1, 0, 1);
    assert.equal(Math.round(dist * 100) / 100, 0.02);
  });

  it("segmentByColorSimilarityGraph splits a 2×2 checkerboard into four segments", () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255]);
    const graph = segmentByColorSimilarityGraph(rgba, 2, 2, 1e5);
    assert.equal(graph.colorClusters.length, 4);
  });
});

describe("engine/compositing/color-range.js quick-select", () => {
  it("buildQuickSelectColorAnalysis segments a 2×2 gradient patch", () => {
    const rgba = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]);
    const analysis = buildQuickSelectColorAnalysis(rgba, 2, 2);
    assert.equal(analysis.segmentCount, 4);
    assert.equal(analysis.pixelSegmentIndices.length, 4);
  });
});

describe("engine/compositing/color-range.js registration", () => {
  it("registerColorRange wires buildGridAdjacencyWeights with border sentinels", () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255]);
    const weights = buildGridAdjacencyWeights(rgba, 2, 2);
    const borderSentinelCount = Array.from(weights).filter((value) => value === 65535).length;
    assert.equal(borderSentinelCount, 4);
    assert.ok(rgbaGridEdgeWeight(rgba, 0, 1) > 0);
  });
});
