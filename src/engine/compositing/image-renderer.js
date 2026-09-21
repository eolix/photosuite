/**
 * Bezier-patch image warp: mesh control points, Bernstein evaluation, and
 * triangle-mesh rasterization into a destination rect.
 */

import { Rect } from "../../core/math/rect.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { allocBuffer } from "./buffer-utils.js";
import { copyPixels, premultiplyAlpha, unpremultiplyAlpha } from "./pixel-ops.js";
import { transformCoordPairs } from "./anti-alias.js";
import { renderMesh } from "./path-renderer.js";



/** Grown on demand by drawImage; never shrunk, so a redraw reuses it. */
let drawImageScratchBuffer = allocBuffer(0);

const MESH_GRID_SIZE = 4;
const MESH_GRID_LAST = MESH_GRID_SIZE - 1;
const MESH_CONTROL_STRIDE = 2;
const DRAW_PAD_PX = 2;
const MESH_DIVISIONS = 50;
const NEAREST_GRID_STEPS = 200;
const BEZIER_SCRATCH_LEN = 10;

/** Reused by the Bezier patch evaluators so a warp allocates nothing. */
const bezierEvalScratch = new Array(BEZIER_SCRATCH_LEN);
const BASIS_V_OFF = 0;
const BASIS_U_OFF = 4;
const RESULT_X_OFF = 8;
const RESULT_Y_OFF = 9;
const NEAREST_DIST_SENTINEL = 1e9;

/**
 * Build UV coords, triangle indices, and per-vertex Jacobian determinants for a unit-square mesh.
 */
function buildWarpMeshGeometry(controlMesh, paddedWidth, paddedHeight, meshDivisions) {
  const meshUV = [];
  const triangleIndices = [];
  const jacobianDet = [];
  const vertsPerRow = meshDivisions + 1;
  for (let row = 0; row < vertsPerRow; row++) {
    for (let col = 0; col < vertsPerRow; col++) {
      const u = col / meshDivisions;
      const v = row / meshDivisions;
      meshUV.push(paddedWidth * u, paddedHeight * v);
      if (col < meshDivisions && row < meshDivisions) {
        const topLeft = row * vertsPerRow + col;
        const topRight = topLeft + 1;
        const bottomLeft = topLeft + vertsPerRow;
        const bottomRight = bottomLeft + 1;
        triangleIndices.push(topLeft, topRight, bottomLeft);
        triangleIndices.push(bottomLeft, topRight, bottomRight);
      }
      const det = meshJacobianDeterminant(controlMesh, u, v);
      jacobianDet.push(-det);
    }
  }
  return { meshUV, triangleIndices, jacobianDet };
}

/**
 * Allocate or clear the padded scratch buffer and copy the source into its inner rect.
 */
function ensurePaddedScratchBuffer(srcPixels, srcWidth, srcHeight) {
  const pad = DRAW_PAD_PX;
  const paddedWidth = srcWidth + 2 * pad;
  const paddedHeight = srcHeight + 2 * pad;
  const srcInner = new Rect(pad, pad, srcWidth, srcHeight);
  const srcPadded = srcInner.clone();
  srcPadded.inflate(pad, pad);
  let scratch = drawImageScratchBuffer;
  if (scratch.length != srcPadded.area() * 4) {
    scratch = drawImageScratchBuffer = allocBuffer(srcPadded.area() * 4);
  } else {
    scratch.fill(0);
  }
  copyPixels(srcPixels, srcInner, scratch, srcPadded);
  return { scratch, paddedWidth, paddedHeight, pad };
}

/**
 * Weighted sum of the 4×4 Bezier control points into scratch[8]/scratch[9].
 */
function accumulateBezierWeightedPoint(controlMesh, basisV0, basisV1, basisV2, basisV3, basisU0, basisU1, basisU2, basisU3, scratch) {
  let outX = 0;
  let outY = 0;
  let weight = basisV0 * basisU0;
  outX += controlMesh[0] * weight;
  outY += controlMesh[1] * weight;
  weight = basisV0 * basisU1;
  outX += controlMesh[2] * weight;
  outY += controlMesh[3] * weight;
  weight = basisV0 * basisU2;
  outX += controlMesh[4] * weight;
  outY += controlMesh[5] * weight;
  weight = basisV0 * basisU3;
  outX += controlMesh[6] * weight;
  outY += controlMesh[7] * weight;
  weight = basisV1 * basisU0;
  outX += controlMesh[8] * weight;
  outY += controlMesh[9] * weight;
  weight = basisV1 * basisU1;
  outX += controlMesh[10] * weight;
  outY += controlMesh[11] * weight;
  weight = basisV1 * basisU2;
  outX += controlMesh[12] * weight;
  outY += controlMesh[13] * weight;
  weight = basisV1 * basisU3;
  outX += controlMesh[14] * weight;
  outY += controlMesh[15] * weight;
  weight = basisV2 * basisU0;
  outX += controlMesh[16] * weight;
  outY += controlMesh[17] * weight;
  weight = basisV2 * basisU1;
  outX += controlMesh[18] * weight;
  outY += controlMesh[19] * weight;
  weight = basisV2 * basisU2;
  outX += controlMesh[20] * weight;
  outY += controlMesh[21] * weight;
  weight = basisV2 * basisU3;
  outX += controlMesh[22] * weight;
  outY += controlMesh[23] * weight;
  weight = basisV3 * basisU0;
  outX += controlMesh[24] * weight;
  outY += controlMesh[25] * weight;
  weight = basisV3 * basisU1;
  outX += controlMesh[26] * weight;
  outY += controlMesh[27] * weight;
  weight = basisV3 * basisU2;
  outX += controlMesh[28] * weight;
  outY += controlMesh[29] * weight;
  weight = basisV3 * basisU3;
  outX += controlMesh[30] * weight;
  outY += controlMesh[31] * weight;
  scratch[RESULT_X_OFF] = outX;
  scratch[RESULT_Y_OFF] = outY;
}

export function meshControlPointsFromRect(left, top, width, height) {
  const points = [];
  for (let row = 0; row < MESH_GRID_SIZE; row++) {
    for (let col = 0; col < MESH_GRID_SIZE; col++) {
      points.push(left + (width * col) / MESH_GRID_LAST, top + (height * row) / MESH_GRID_LAST);
    }
  }
  return points;
}

export function rotateMeshControlPoints90(controlPoints, counterClockwise) {
  const rotated = controlPoints.slice(0);
  for (let srcRow = 0; srcRow < MESH_GRID_SIZE; srcRow++) {
    for (let srcCol = 0; srcCol < MESH_GRID_SIZE; srcCol++) {
      let srcOff = MESH_CONTROL_STRIDE * (srcRow * MESH_GRID_SIZE + srcCol);
      let dstOff = MESH_CONTROL_STRIDE * (srcCol * MESH_GRID_SIZE + (MESH_GRID_LAST - srcRow));
      if (counterClockwise) {
        const swap = srcOff;
        srcOff = dstOff;
        dstOff = swap;
      }
      rotated[dstOff] = controlPoints[srcOff];
      rotated[dstOff + 1] = controlPoints[srcOff + 1];
    }
  }
  return rotated;
}

export function drawImageThroughMesh(controlMesh, srcPixels, srcWidth, srcHeight, dstPixels, dstRect, unused) {
  const { scratch, paddedWidth, paddedHeight, pad } = ensurePaddedScratchBuffer(srcPixels, srcWidth, srcHeight);
  premultiplyAlpha(scratch);
  const { meshUV, triangleIndices, jacobianDet } = buildWarpMeshGeometry(
    controlMesh,
    paddedWidth,
    paddedHeight,
    MESH_DIVISIONS,
  );
  const meshDocXY = meshUV.slice(0);
  warpCoordsThroughMesh(controlMesh, meshDocXY, new Rect(pad, pad, srcWidth, srcHeight));
  transformCoordPairs(meshDocXY, new Matrix2D(1, 0, 0, 1, -dstRect.x, -dstRect.y), meshDocXY);
  renderMesh(
    scratch,
    paddedWidth,
    paddedHeight,
    dstPixels,
    dstRect.width,
    dstRect.height,
    meshUV,
    meshDocXY,
    jacobianDet,
    triangleIndices,
  );
  unpremultiplyAlpha(dstPixels);
}

export function nearestUvOnMesh(controlMesh, targetPt) {
  let bestU = 0;
  let bestV = 0;
  let bestDistSq = NEAREST_DIST_SENTINEL;
  const scratch = bezierEvalScratch;
  for (let row = 0; row < NEAREST_GRID_STEPS + 1; row++) {
    for (let col = 0; col < NEAREST_GRID_STEPS + 1; col++) {
      const u = col / NEAREST_GRID_STEPS;
      const v = row / NEAREST_GRID_STEPS;
      evalBezierPatch(controlMesh, u, v, scratch);
      const dx = scratch[RESULT_X_OFF] - targetPt.x;
      const dy = scratch[RESULT_Y_OFF] - targetPt.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestU = u;
        bestV = v;
      }
    }
  }
  return [bestU, bestV];
}

export function warpCoordsThroughMesh(controlMesh, coords, bounds) {
  const originX = bounds.x;
  const originY = bounds.y;
  const invWidth = 1 / bounds.width;
  const invHeight = 1 / bounds.height;
  const scratch = bezierEvalScratch;
  for (let off = 0; off < coords.length; off += 2) {
    const u = (coords[off] - originX) * invWidth;
    const v = (coords[off + 1] - originY) * invHeight;
    evalBezierPatch(controlMesh, u, v, scratch);
    coords[off] = scratch[RESULT_X_OFF];
    coords[off + 1] = scratch[RESULT_Y_OFF];
  }
}

/**
 * Signed area scaling of the patch at (u,v): cross product of the two surface
 * tangents (∂S/∂u × ∂S/∂v). Drives per-vertex mip/anti-alias weighting.
 */
export function meshJacobianDeterminant(controlMesh, u, v) {
  const scratch = bezierEvalScratch;
  evalBezierTangentU(controlMesh, u, v, scratch);
  const tangentUx = scratch[RESULT_X_OFF];
  const tangentUy = scratch[RESULT_Y_OFF];
  evalBezierTangentV(controlMesh, u, v, scratch);
  const tangentVx = scratch[RESULT_X_OFF];
  const tangentVy = scratch[RESULT_Y_OFF];
  return tangentUx * tangentVy - tangentUy * tangentVx;
}

/** Surface point S(u,v) of the bicubic Bézier patch, written to scratch[8..9]. */
export function evalBezierPatch(controlMesh, u, v, scratch) {
  fillBernsteinBasis(scratch, BASIS_V_OFF, v);
  fillBernsteinBasis(scratch, BASIS_U_OFF, u);
  evaluateBezierSurface(controlMesh, scratch);
}

/** Tangent ∂S/∂u: derivative Bernstein basis on u, ordinary basis on v. */
export function evalBezierTangentU(controlMesh, u, v, scratch) {
  fillBernsteinBasis(scratch, BASIS_V_OFF, v);
  fillBernsteinBasisDeriv(scratch, BASIS_U_OFF, u);
  evaluateBezierSurface(controlMesh, scratch);
}

/** Tangent ∂S/∂v: derivative Bernstein basis on v, ordinary basis on u. */
export function evalBezierTangentV(controlMesh, u, v, scratch) {
  fillBernsteinBasisDeriv(scratch, BASIS_V_OFF, v);
  fillBernsteinBasis(scratch, BASIS_U_OFF, u);
  evaluateBezierSurface(controlMesh, scratch);
}

/** Cubic Bernstein basis derivative [B0',B1',B2',B3'](t) into out[off..off+3]. */
export function fillBernsteinBasisDeriv(out, off, t) {
  const oneMinus = 1 - t;
  out[off] = -3 * (oneMinus * oneMinus);
  out[off + 1] = 3 * (oneMinus * oneMinus) - 6 * (t * oneMinus);
  out[off + 2] = 6 * (t * oneMinus) - 3 * (t * t);
  out[off + 3] = 3 * (t * t);
}

/** Cubic Bernstein basis [(1-t)³, 3t(1-t)², 3t²(1-t), t³] into out[off..off+3]. */
export function fillBernsteinBasis(out, off, t) {
  const oneMinus = 1 - t;
  out[off] = oneMinus * (oneMinus * oneMinus);
  out[off + 1] = 3 * t * (oneMinus * oneMinus);
  out[off + 2] = 3 * (t * t) * oneMinus;
  out[off + 3] = t * t * t;
}

/**
 * Tensor-product bicubic Bézier: S = ΣᵢΣⱼ Bᵢ(v)·Bⱼ(u)·P(i,j), where the 16
 * control points P live in controlMesh as interleaved x,y pairs and the basis
 * values are in scratch[0..3] (v) and scratch[4..7] (u).
 */
export function evaluateBezierSurface(controlMesh, scratch) {
  accumulateBezierWeightedPoint(
    controlMesh,
    scratch[0],
    scratch[1],
    scratch[2],
    scratch[3],
    scratch[4],
    scratch[5],
    scratch[6],
    scratch[7],
    scratch,
  );
}
