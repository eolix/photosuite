/**
 * Golden values for path-renderer (compositing).
 */
import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';

import { installBrowserGlobals } from '../../helpers/stub-browser-globals.js';
import { earClipTriangulate } from "../../../src/engine/compositing/anti-alias.js";
import { buildHalfEdgeMesh, circumcircle, compositePixel, computeBarycentricWeights, computeVertexUV, fitPath, getTriangleIndices, pointInTriangleMesh, renderTriangle, runDelaunayFlips, sampleBezier, subdivideEdge, treeToPath, triangleSignedArea, vertexDistance } from "../../../src/engine/compositing/path-renderer.js";

installBrowserGlobals();


function createCompositing() {
  const Compositing = function Compositing() {};
  return Compositing;
}

/** Right triangle: (0,0), (4,0), (0,3). */
const TRIANGLE_COORDS = [0, 0, 4, 0, 0, 3];
const TRIANGLE_INDICES = [0, 1, 2];

before(async () => {
});

describe('engine/compositing/path-renderer.js delaunayMesh', () => {
  it('triangleSignedArea returns signed parallelogram half-area', () => {
    assert.equal(triangleSignedArea(TRIANGLE_COORDS, 0, 1, 2), 12);
    assert.equal(triangleSignedArea(TRIANGLE_COORDS, 0, 2, 1), -12);
  });

  it('vertexDistance returns Euclidean edge length', () => {
    assert.equal(vertexDistance(TRIANGLE_COORDS, 0, 1), 4);
  });

  it('circumcircle matches right-triangle center and radius squared', () => {
    const circum = circumcircle(TRIANGLE_COORDS, 0, 1, 2);
    assert.deepEqual(
      circum.map((value) => Math.round(value * 1e6) / 1e6),
      [2, 1.5, 6.25, 0],
    );
  });

  it('buildHalfEdgeMesh and getTriangleIndices round-trip a single triangle', () => {
    const mesh = buildHalfEdgeMesh(TRIANGLE_COORDS.slice(), TRIANGLE_INDICES);
    assert.deepEqual(getTriangleIndices(mesh), [2, 1, 0]);
    assert.equal(mesh.halfEdges.length, 3);
  });

  it('runDelaunayFlips leaves an already-Delaunay quad unchanged', () => {
    const coords = [0, 0, 10, 0, 10, 10, 0, 10];
    const mesh = buildHalfEdgeMesh(coords, [0, 1, 2, 0, 2, 3]);
    assert.equal(runDelaunayFlips(coords, mesh), false);
    assert.deepEqual(getTriangleIndices(mesh), [2, 1, 0, 3, 2, 0]);
  });

  it('subdivideEdge inserts an edge midpoint and re-triangulates', () => {
    const coords = [0, 0, 10, 0, 10, 10, 0, 10];
    const mesh = buildHalfEdgeMesh(coords, [0, 1, 2, 0, 2, 3]);
    const interiorEdge = mesh.halfEdges.find((halfEdge) => halfEdge[1] != null);
    subdivideEdge(coords, mesh, interiorEdge);
    assert.deepEqual(coords, [0, 0, 10, 0, 10, 10, 0, 10, 5, 5]);
    assert.equal(mesh.halfEdges.length, 12);
    assert.deepEqual(getTriangleIndices(mesh), [1, 4, 2, 3, 4, 0, 4, 1, 0, 2, 4, 3]);
  });
});

describe('engine/compositing/path-renderer.js pathRenderer', () => {
  it('compositePixel alpha-composites source over destination', () => {
    const dest = new Uint8ClampedArray([100, 150, 200, 128]);
    compositePixel([50, 75, 100, 200], dest, 0);
    assert.deepEqual(Array.from(dest), [72, 107, 143, 228]);
  });

  it('barycentric weights report inside weights and mesh membership', () => {
    const scratch = [0, 0, 0, 0, 0, 0];
    scratch[0] = 0;
    scratch[1] = 2;
    scratch[2] = 4;
    assert.equal(computeBarycentricWeights(TRIANGLE_COORDS, 1, 1, scratch), 1);
    assert.deepEqual(scratch.slice(3), [
      0.4166666667152778,
      0.24999999997916666,
      0.33333333330555553,
    ]);
    assert.equal(pointInTriangleMesh(TRIANGLE_COORDS, TRIANGLE_INDICES, 1, 1), true);
    assert.equal(pointInTriangleMesh(TRIANGLE_COORDS, TRIANGLE_INDICES, 5, 5), false);
  });

  // Samples are taken at t < 1 (the next segment supplies the endpoint), run
  // through Douglas-Peucker, then returned innermost-first. A cubic whose
  // control points are collinear simplifies away to the run's two ends.
  it('sampleBezier collapses a straight cubic to its ends', () => {
    const samples = sampleBezier({
      commands: ['M', 'C', 'Z'],
      coords: [0, 0, 1, 0, 2, 0, 3, 0],
    });
    assert.deepEqual(Array.from(samples), [2, 0, 0, 0]);
  });

  // A curve that genuinely bends keeps enough samples to follow it.
  it('sampleBezier keeps samples along a curve that bends', () => {
    const samples = sampleBezier({
      commands: ['M', 'C', 'Z'],
      coords: [0, 0, 0, 30, 30, 30, 30, 0],
    });
    assert.ok(samples.length > 4, 'a bending curve should not simplify to a line');
    assert.ok(samples.every((value) => typeof value === 'number'));
  });

  it('treeToPath emits a closed rect subpath for a leaf node', () => {
    const path = treeToPath({ rectCoords: [0, 0, 10, 10], leftChild: [1], rightChild: [2] });
    assert.deepEqual(path.commands, ['M', 'L', 'L', 'L', 'Z']);
    assert.deepEqual(path.coords, [0, 0, 10, 0, 10, 10, 0, 10]);
  });
});

describe('engine/compositing/path-renderer.js real-engine pipelines', () => {
  let Compositing;
  before(async () => {
    await import('../../../src/engine/layer-system.js');
  });

  it('fitPath refines a rectangle mesh via split/flip/relax', () => {
    const polygon = [0, 0, 20, 0, 20, 15, 0, 15];
    const coords = polygon.slice();
    const triangleIndices = fitPath(coords, earClipTriangulate(polygon.slice()), 6);
    assert.equal(coords.length, 92);
    assert.equal(triangleIndices.length / 3, 58);
    assert.equal(triangleIndices.reduce((sum, value) => sum + value, 0), 4567);
  });

  it('computeVertexUV blends pin depths by graph distance', () => {
    const coords = [0, 0, 10, 0, 10, 10, 0, 10, 5, 5];
    const triangleIndices = [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4];
    const uv = computeVertexUV(coords, triangleIndices, [0, 2], [0.2, 0.8]);
    assert.deepEqual(uv.map((value) => Math.round(value * 1e6) / 1e6), [0.2, 0.5, 0.8, 0.5, 0.5]);
    assert.deepEqual(computeVertexUV([0, 0, 10, 0, 5, 8], [0, 1, 2], [], []), [0, 0, 0]);
  });

  it('renderTriangle rasterizes a warped source triangle to a golden', () => {
    const src = new Float32Array(4 * 4 * 4);
    for (let i = 0; i < src.length; i++) src[i] = (i * 7) & 255;
    const dst = new Uint8ClampedArray(8 * 8 * 4);
    renderTriangle(0, 2, 4, [0, 0, 3, 0, 0, 3], [1, 1, 6, 1, 1, 6], src, 4, 4, dst, 8, 8);
    let checksum = 0;
    for (let i = 0; i < dst.length; i++) checksum = (checksum + dst[i] * (i % 7 + 1)) % 1000003;
    assert.equal(checksum, 25364);
  });
});
