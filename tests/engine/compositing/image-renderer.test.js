/**
 * Golden values for image-renderer (compositing).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { Point } from "../../../src/core/math/point.js";
import { Rect } from "../../../src/core/math/rect.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { allocBuffer } from "../../../src/engine/compositing/buffer-utils.js";
import { drawImageThroughMesh, evalBezierPatch, evalBezierTangentU, evalBezierTangentV, fillBernsteinBasis, fillBernsteinBasisDeriv, meshControlPointsFromRect, meshJacobianDeterminant, nearestUvOnMesh, rotateMeshControlPoints90, warpCoordsThroughMesh } from "../../../src/engine/compositing/image-renderer.js";

installBrowserGlobals();


function createCompositing() {
  const Compositing = function Compositing() {};
  return Compositing;
}

function checksum(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum = (sum + buf[i] * (i % 7 + 1)) % 1000003;
  return sum;
}

function unitSquareControlPoints() {
  const coeffs = [];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      coeffs.push(col / 3, row / 3);
    }
  }
  return coeffs;
}

function round6(values) {
  return values.map((value) => Math.round(value * 1e6) / 1e6);
}

before(async () => {
});

describe("image-renderer", () => {
  it("meshControlPointsFromRect builds a 4×4 grid", () => {
    const points = meshControlPointsFromRect(10, 20, 30, 40);
    assert.equal(points.length, 32);
    assert.deepEqual(points.slice(0, 4), [10, 20, 20, 20]);
    assert.deepEqual(points.slice(-4), [30, 60, 40, 60]);
    assert.equal(points.reduce((sum, value) => sum + value, 0), 1040);
  });

  it("rotateMeshControlPoints90 CW/CCW goldens", () => {
    const points = meshControlPointsFromRect(10, 20, 30, 40);
    const rotatedCw = rotateMeshControlPoints90(points, false);
    assert.equal(rotatedCw.reduce((sum, value) => sum + value, 0), 1040);
    assert.deepEqual(round6(rotatedCw.slice(0, 4)), [10, 60, 10, 46.666667]);
    const rotatedCcw = rotateMeshControlPoints90(points, true);
    assert.equal(rotatedCcw.reduce((sum, value) => sum + value, 0), 1040);
    assert.deepEqual(round6(rotatedCcw.slice(0, 4)), [40, 20, 40, 33.333333]);
  });

  it("Bernstein basis and Bezier eval goldens", () => {
    const scratch = new Array(10);
    fillBernsteinBasis(scratch, 0, 0.3);
    assert.deepEqual(round6(scratch.slice(0, 4)), [0.343, 0.441, 0.189, 0.027]);
    fillBernsteinBasisDeriv(scratch, 0, 0.3);
    assert.deepEqual(round6(scratch.slice(0, 4)), [-1.47, 0.21, 0.99, 0.27]);
    const controlMesh = unitSquareControlPoints();
    evalBezierPatch(controlMesh, 0.5, 0.25, scratch);
    // Identity control grid: patch point equals (u,v).
    assert.deepEqual([scratch[8], scratch[9]], [0.5, 0.25]);
    assert.equal(Math.round(meshJacobianDeterminant(controlMesh, 0.5, 0.5) * 1e9) / 1e9, 1);
  });

  it("evalBezierTangentU/V return the surface partials of a bowed patch", () => {
    const controlMesh = meshControlPointsFromRect(0, 0, 32, 24);
    controlMesh[10] += 8;
    controlMesh[11] -= 5;
    controlMesh[12] -= 6;
    const scratch = new Array(10);
    evalBezierTangentU(controlMesh, 0.4, 0.6, scratch);
    assert.deepEqual([Math.round(scratch[8] * 1e6) / 1e6, Math.round(scratch[9] * 1e6) / 1e6], [29.51168, 0.5184]);
    evalBezierTangentV(controlMesh, 0.4, 0.6, scratch);
    assert.deepEqual([Math.round(scratch[8] * 1e6) / 1e6, Math.round(scratch[9] * 1e6) / 1e6], [-1.65888, 26.0736]);
  });

  it("warpCoordsThroughMesh and nearestUvOnMesh goldens", () => {
    const controlMesh = unitSquareControlPoints();
    const coords = [0, 0, 1, 0, 0, 1, 1, 1];
    warpCoordsThroughMesh(controlMesh, coords, new Rect(0, 0, 1, 1));
    assert.deepEqual(round6(coords), [0, 0, 1, 0, 0, 1, 1, 1]);
    const nearest = nearestUvOnMesh(controlMesh, new Point(0.25, 0.75));
    assert.deepEqual(
      nearest.map((value) => Math.round(value * 1e4) / 1e4),
      [0.25, 0.75],
    );
  });
});

describe("image-renderer drawImage (real engine, bicubic Bézier warp)", () => {
  let Compositing;
  before(async () => {
    await import("../../../src/engine/layer-system.js");
  });

  it("warps a source image through a bowed control mesh to a golden", () => {
    const width = 32;
    const height = 24;
    const controlMesh = meshControlPointsFromRect(0, 0, width, height);
    controlMesh[10] += 8;
    controlMesh[11] -= 5;
    controlMesh[12] -= 6;
    const src = new Uint8Array(width * height * 4);
    for (let i = 0; i < src.length; i++) src[i] = (i * 13 + ((i >> 2) * 7)) & 255;
    const dst = new Uint8Array(width * height * 4);
    drawImageThroughMesh(controlMesh, src, width, height, dst, new Rect(0, 0, width, height));
    assert.equal(checksum(dst), 648767);
    assert.deepEqual(Array.from(dst.slice(0, 4)), [0, 13, 26, 39]);
  });
});
