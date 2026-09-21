/**
 * Path mesh deformation and Delaunay refinement for puppet-warp style compositing.
 *
 * Builds half-edge triangle meshes from path contours, refines them with edge splits
 * and Delaunay flips, solves sparse position/tangent constraints to deform vertices,
 * and rasterizes deformed triangles with barycentric UV interpolation.
 */
/* global linear */
import { Rect } from '../../core/math/rect.js';
import { Matrix2D } from '../../core/math/matrix2d.js';
import { allocBuffer, extractChannelByte } from "./buffer-utils.js";
import { contentBoundsChannel, copyChannel, round } from "./pixel-ops.js";
import { boundsFromCoordPairs, douglasPeuckerSimplify, earClipTriangulate, transformCoordPairs } from "./anti-alias.js";
import { sampleBilinearFloat } from "./homography.js";
import { multiplyMatrices, multiplyMatrixByVector, subtractMatrices, transposeMatrix } from "./matrix-math.js";
import { minHeap } from "./filter-kernels.js";
import { getPathRecords, traceContours } from "./bitmap-contour-tracer.js";
import { SplineMatrix } from "./sparse-matrix.js";

/**
 * @type {object|null} Engine namespace, for the slices still assembled on it:
 * the sparse spline matrix, the contour tracer, and the min-heap.
 */


const PIN_WEIGHT = 1e3;
const POSITION_SOLVER_TOLERANCE = 0.01;
const TANGENT_SOLVER_TOLERANCE = 0.5;
const ALPHA_ROUND_THRESHOLD = 70;
const BARYCENTRIC_DET_EPSILON = 1e-9;
const CIRCUMCIRCLE_DET_EPSILON = 1e-5;
const CONTOUR_AREA_SAMPLE_FACTOR = 5e-4;
const DETAIL_TOLERANCE_SCALE = [0.1, 0.065, 0.035];
const BEZIER_SIMPLIFY_TOLERANCE = 1;
const MIN_HEAP_SENTINEL = "---";
const INFINITE_GRAPH_DISTANCE = 1e9;
const RELAXATION_STEP = 0.02;
const RELAXATION_ENERGY_THRESHOLD = 1e-4;
const FIT_PATH_MAX_ITERATIONS = 300;
const REFINE_EDGE_SPLIT_PASSES = 5;
const BOUNDARY_EDGE_LENGTH_MULTIPLIER = 2;
const INTERIOR_EDGE_LENGTH_MULTIPLIER = 1;
const ALPHA_CHANNEL_INDEX = 3;
const COORD_PAIR_STRIDE = 2;
const TRIANGLE_VERTEX_COUNT = 3;

const EDGE_RESIDUAL_TEMPLATES = [
  [
    [-1, 0, 1, 0, 0, 0],
    [0, -1, 0, 1, 0, 0],
  ],
  [
    [-1, 0, 1, 0, 0, 0, 0, 0],
    [0, -1, 0, 1, 0, 0, 0, 0],
  ],
];

/** @returns {number[]} */
function allocateZeroed(length) {
  const out = new Array(length);
  for (let idx = 0; idx < length; idx++) {
    out[idx] = 0;
  }
  return out;
}

/**
 * Half-edge record: [headVertex, twin, triangleIdx, nextHalfEdge].
 * Tail vertex walks two next links from the current edge.
 */
function readHalfEdgeVertices(halfEdge) {
  const headVertex = halfEdge[0];
  const twinHalfEdge = halfEdge[1];
  const leftVertex = halfEdge[3][0];
  const tailVertex = halfEdge[3][3][0];
  const rightVertex = twinHalfEdge ? twinHalfEdge[3][0] : leftVertex;
  return { tailVertex, headVertex, leftVertex, rightVertex, hasTwin: twinHalfEdge != null };
}

/**
 * @returns {{ baryU: number, baryV: number } | null}
 */
function barycentricCoordsAtOffset(relX, relY, edge01X, edge01Y, edge02X, edge02Y, invDet) {
  const baryU = (relX * edge02Y - edge02X * relY) * invDet;
  const baryV = (edge01X * relY - relX * edge01Y) * invDet;
  if (baryU >= 0 && baryV >= 0 && baryU + baryV <= 1) {
    return { baryU, baryV };
  }
  return null;
}

/** @returns {[number, number, number, number]} rowMin, rowMax, colMin, colMax */
function trianglePixelBounds(docX0, docY0, docX1, docY1, docX2, docY2, destWidth, destHeight) {
  const colMin = Math.max(0, Math.floor(Math.min(docX0, docX1, docX2)));
  const colMax = Math.min(destWidth, Math.ceil(Math.max(docX0, docX1, docX2)));
  const rowMin = Math.max(0, Math.floor(Math.min(docY0, docY1, docY2)));
  const rowMax = Math.min(destHeight, Math.ceil(Math.max(docY0, docY1, docY2)));
  return [rowMin, rowMax, colMin, colMax];
}

function clampSampleCoord(value, maxIndex) {
  return Math.max(0, Math.min(maxIndex, value));
}

/** Evaluate one cubic Bézier sample at parameter t. */
function evaluateCubicBezier(t, coordOff, coords) {
  const oneMinusT = 1 - t;
  const oneMinusTSquared = oneMinusT * oneMinusT;
  const oneMinusTCubed = oneMinusTSquared * oneMinusT;
  const paramSquared = t * t;
  const paramCubed = paramSquared * t;
  const sampleX =
    oneMinusTCubed * coords[coordOff + 0] +
    3 * oneMinusTSquared * t * coords[coordOff + 2] +
    3 * oneMinusT * paramSquared * coords[coordOff + 4] +
    paramCubed * coords[coordOff + 6];
  const sampleY =
    oneMinusTCubed * coords[coordOff + 1] +
    3 * oneMinusTSquared * t * coords[coordOff + 3] +
    3 * oneMinusT * paramSquared * coords[coordOff + 5] +
    paramCubed * coords[coordOff + 7];
  return [sampleX, sampleY];
}

/** Reverse flat x,y pairs by popping from the end of the source array. */
function reverseCoordPairStack(samples) {
  const reversed = [];
  const sampleLen = samples.length;
  for (let idx = 0; idx < sampleLen; idx += COORD_PAIR_STRIDE) {
    const popY = samples.pop();
    const popX = samples.pop();
    reversed.push(popX, popY);
  }
  return reversed;
}

function addUndirectedMeshEdge(vertexA, vertexB, adjacency, edgeLengths, coords) {
  const dx = coords[vertexA * 2] - coords[vertexB * 2];
  const dy = coords[vertexA * 2 + 1] - coords[vertexB * 2 + 1];
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (adjacency[vertexA].indexOf(vertexB) == -1) {
    adjacency[vertexA].push(vertexB);
    edgeLengths[vertexA].push(dist);
  }
  if (adjacency[vertexB].indexOf(vertexA) == -1) {
    adjacency[vertexB].push(vertexA);
    edgeLengths[vertexB].push(dist);
  }
}

/** True when every incident half-edge has a twin (interior vertex). */
function isInteriorMeshVertex(mesh, vertIdx) {
  const startHalfEdge = mesh.vertexHalfEdge[vertIdx];
  let walkHalfEdge = startHalfEdge;
  do {
    if (walkHalfEdge[1] == null) {
      return false;
    }
    walkHalfEdge = walkHalfEdge[1][3];
  } while (walkHalfEdge != startHalfEdge);
  return true;
}

/**
 * Pick the longest half-edge, doubling length for boundary edges (no twin).
 * @returns {{ halfEdge: object | null, edgeLength: number }}
 */
function pickLongestHalfEdge(halfEdges, coords, vertexDistanceFn) {
  let longestHalfEdge = null;
  let longestLength = 0;
  for (let heIdx = 0; heIdx < halfEdges.length; heIdx++) {
    const halfEdge = halfEdges[heIdx];
    const lengthMultiplier = halfEdge[1] ? INTERIOR_EDGE_LENGTH_MULTIPLIER : BOUNDARY_EDGE_LENGTH_MULTIPLIER;
    const edgeLength =
      vertexDistanceFn(coords, halfEdge[0], halfEdge[3][3][0]) * lengthMultiplier;
    if (edgeLength > longestLength) {
      longestHalfEdge = halfEdge;
      longestLength = edgeLength;
    }
  }
  return { halfEdge: longestHalfEdge, edgeLength: longestLength };
}

function countOrientedEdgeConstraints(halfEdges) {
  let edgeConstraintCount = 0;
  for (let heIdx = 0; heIdx < halfEdges.length; heIdx++) {
    edgeConstraintCount += halfEdges[heIdx][1] ? 0.5 : 1;
  }
  return edgeConstraintCount;
}

function buildLocalCoordinateFrame(restCoords, tailVertex, headVertex, leftVertex, rightVertex, hasTwin) {
  const tailX = restCoords[tailVertex * 2];
  const tailY = restCoords[tailVertex * 2 + 1];
  const headX = restCoords[headVertex * 2];
  const headY = restCoords[headVertex * 2 + 1];
  const leftX = restCoords[leftVertex * 2];
  const leftY = restCoords[leftVertex * 2 + 1];
  const rightX = restCoords[rightVertex * 2];
  const rightY = restCoords[rightVertex * 2 + 1];
  const frameMatrix = [
    [tailX, tailY, 1, 0],
    [tailY, -tailX, 0, 1],
    [headX, headY, 1, 0],
    [headY, -headX, 0, 1],
    [leftX, leftY, 1, 0],
    [leftY, -leftX, 0, 1],
  ];
  if (hasTwin) {
    frameMatrix.push([rightX, rightY, 1, 0], [rightY, -rightX, 0, 1]);
  }
  return { frameMatrix, tailX, tailY, headX, headY };
}

export function solveDeformation(pathState) {
  const constraintSystem = pathState.constraintSystem;
  const restVertexCoords = pathState.restVertexCoords;
  const solverRestCoords = pathState.solverRestCoords;
  const deformedVertexCoords = pathState.deformedVertexCoords;
  const pinWorldCoords = pathState.pinWorldCoords;
  const pinOffsets = pathState.pinOffsets;
  const multiplyVec = multiplyMatrixByVector;
  let edgeConstraintIdx = 0;

  const vertexCount = restVertexCoords.length >>> 1;
  const positionRhs = allocateZeroed(constraintSystem.totalConstraints * 2);
  const tangentRhsX = allocateZeroed(constraintSystem.totalConstraints);
  const tangentRhsY = allocateZeroed(constraintSystem.totalConstraints);

  for (let pinIdx = 0; pinIdx < pathState.pinVertexIndices.length; pinIdx++) {
    const constraintIdx = constraintSystem.edgeConstraintCount + pinIdx;
    const pinX = constraintSystem.pinWeight * (pinWorldCoords[pinIdx * 2] + pinOffsets[pinIdx * 2]);
    const pinY = constraintSystem.pinWeight * (pinWorldCoords[pinIdx * 2 + 1] + pinOffsets[pinIdx * 2 + 1]);
    positionRhs[constraintIdx * 2] = pinX;
    positionRhs[constraintIdx * 2 + 1] = pinY;
    tangentRhsX[constraintIdx] = pinX;
    tangentRhsY[constraintIdx] = pinY;
  }

  constraintSystem.positionSolver.solve(
    solverRestCoords,
    constraintSystem.transposeMatrix.multiplyVector(positionRhs),
    POSITION_SOLVER_TOLERANCE,
  );

  for (let heIdx = 0; heIdx < constraintSystem.mesh.halfEdges.length; heIdx++) {
    const halfEdge = constraintSystem.mesh.halfEdges[heIdx];
    const { tailVertex, headVertex, leftVertex, rightVertex, hasTwin } = readHalfEdgeVertices(halfEdge);
    if (hasTwin && tailVertex > headVertex) {
      continue;
    }

    const tailRestX = restVertexCoords[tailVertex * 2];
    const tailRestY = restVertexCoords[tailVertex * 2 + 1];
    const headRestX = restVertexCoords[headVertex * 2];
    const headRestY = restVertexCoords[headVertex * 2 + 1];
    const tailSolverX = solverRestCoords[tailVertex * 2];
    const tailSolverY = solverRestCoords[tailVertex * 2 + 1];
    const headSolverX = solverRestCoords[headVertex * 2];
    const headSolverY = solverRestCoords[headVertex * 2 + 1];
    const leftSolverX = solverRestCoords[leftVertex * 2];
    const leftSolverY = solverRestCoords[leftVertex * 2 + 1];
    const rightSolverX = solverRestCoords[rightVertex * 2];
    const rightSolverY = solverRestCoords[rightVertex * 2 + 1];

    const frameCoords = [tailSolverX, tailSolverY, headSolverX, headSolverY, leftSolverX, leftSolverY];
    if (hasTwin) {
      frameCoords.push(rightSolverX, rightSolverY);
    }

    const tangentVec = multiplyVec(constraintSystem.localFrames[edgeConstraintIdx], frameCoords);
    let tangentX = tangentVec[0];
    let tangentY = tangentVec[1];
    const invTangentLen = 1 / Math.sqrt(tangentX * tangentX + tangentY * tangentY);
    tangentX *= invTangentLen;
    tangentY *= invTangentLen;

    const edgeDx = headRestX - tailRestX;
    const edgeDy = headRestY - tailRestY;
    tangentRhsX[edgeConstraintIdx] = tangentX * edgeDx + tangentY * edgeDy;
    tangentRhsY[edgeConstraintIdx] = -tangentY * edgeDx + tangentX * edgeDy;
    edgeConstraintIdx++;
  }

  const solvedX = new Array(vertexCount);
  const solvedY = new Array(vertexCount);
  for (let vertexIdx = 0; vertexIdx < vertexCount; vertexIdx++) {
    solvedX[vertexIdx] = deformedVertexCoords[vertexIdx * 2];
    solvedY[vertexIdx] = deformedVertexCoords[vertexIdx * 2 + 1];
  }

  constraintSystem.tangentSolver.solve(
    solvedX,
    constraintSystem.tangentTranspose.multiplyVector(tangentRhsX),
    TANGENT_SOLVER_TOLERANCE,
  );
  constraintSystem.tangentSolver.solve(
    solvedY,
    constraintSystem.tangentTranspose.multiplyVector(tangentRhsY),
    TANGENT_SOLVER_TOLERANCE,
  );

  for (let vertexIdx = 0; vertexIdx < vertexCount; vertexIdx++) {
    deformedVertexCoords[vertexIdx * 2] = solvedX[vertexIdx];
    deformedVertexCoords[vertexIdx * 2 + 1] = solvedY[vertexIdx];
  }
}

export function buildConstraintSystem(meshInput) {
  const restVertexCoords = meshInput.restVertexCoords;
  const triangleIndices = meshInput.triangleIndices;
  const pinVertexIndices = meshInput.pinVertexIndices;
  const matrixMultiply = multiplyMatrices;
  const mesh = buildHalfEdgeMesh(restVertexCoords, triangleIndices);
  const vertexCount = restVertexCoords.length >>> 1;
  const edgeConstraintCount = countOrientedEdgeConstraints(mesh.halfEdges);
  const totalConstraints = edgeConstraintCount + pinVertexIndices.length;
  const localFrames = [];
  const positionMatrix = new SplineMatrix(totalConstraints * 2, vertexCount * 2);
  const tangentMatrix = new SplineMatrix(totalConstraints, vertexCount);
  const rowCols = [];
  const rowCoeffs = [];

  for (let heIdx = 0; heIdx < mesh.halfEdges.length; heIdx++) {
    const halfEdge = mesh.halfEdges[heIdx];
    const { tailVertex, headVertex, leftVertex, rightVertex, hasTwin } = readHalfEdgeVertices(halfEdge);
    if (hasTwin && tailVertex > headVertex) {
      continue;
    }

    const { frameMatrix, tailX, tailY, headX, headY } = buildLocalCoordinateFrame(
      restVertexCoords,
      tailVertex,
      headVertex,
      leftVertex,
      rightVertex,
      hasTwin,
    );
    const frameTranspose = transposeMatrix(frameMatrix);
    let localFrame = matrixMultiply(
      linear.invert(matrixMultiply(frameTranspose, frameMatrix)),
      frameTranspose,
    );
    localFrame.pop();
    localFrame.pop();
    localFrames.push(localFrame);

    const edgeDx = headX - tailX;
    const edgeDy = headY - tailY;
    let edgeResidual = EDGE_RESIDUAL_TEMPLATES[hasTwin ? 1 : 0];
    edgeResidual = subtractMatrices(
      edgeResidual,
      matrixMultiply(
        [
          [edgeDx, edgeDy],
          [edgeDy, -edgeDx],
        ],
        localFrame,
      ),
    );

    const vertexColIndices = [
      tailVertex * 2,
      tailVertex * 2 + 1,
      headVertex * 2,
      headVertex * 2 + 1,
      leftVertex * 2,
      leftVertex * 2 + 1,
      rightVertex * 2,
      rightVertex * 2 + 1,
    ];
    const coeffCount = hasTwin ? 8 : 6;
    const sparseEntries = [];
    for (let entryIdx = 0; entryIdx < coeffCount; entryIdx++) {
      sparseEntries.push([vertexColIndices[entryIdx], edgeResidual[0][entryIdx], edgeResidual[1][entryIdx]]);
    }
    sparseEntries.sort(function (entryA, entryB) {
      return entryA[0] - entryB[0];
    });

    for (let rowAxis = 0; rowAxis < 2; rowAxis++) {
      for (let entryIdx = 0; entryIdx < coeffCount; entryIdx++) {
        rowCols[entryIdx] = sparseEntries[entryIdx][0];
        rowCoeffs[entryIdx] = sparseEntries[entryIdx][1 + rowAxis];
      }
      positionMatrix.addRow(rowCoeffs, rowCols, coeffCount);
    }

    if (tailVertex < headVertex) {
      tangentMatrix.addRow([-1, 1], [tailVertex, headVertex], 2);
    } else {
      tangentMatrix.addRow([1, -1], [headVertex, tailVertex], 2);
    }
  }

  for (let pinIdx = 0; pinIdx < pinVertexIndices.length; pinIdx++) {
    const pinnedVertex = pinVertexIndices[pinIdx];
    positionMatrix.addRow([PIN_WEIGHT], [pinnedVertex * 2], 1);
    positionMatrix.addRow([PIN_WEIGHT], [pinnedVertex * 2 + 1], 1);
    tangentMatrix.addRow([PIN_WEIGHT], [pinnedVertex], 1);
  }

  const positionTranspose = positionMatrix.transpose();
  const positionSolver = positionTranspose.multiplySparse(positionTranspose);
  const tangentTranspose = tangentMatrix.transpose();
  const tangentSolver = tangentTranspose.multiplySparse(tangentTranspose);

  return {
    edgeConstraintCount: edgeConstraintCount,
    totalConstraints: totalConstraints,
    transposeMatrix: positionTranspose,
    positionSolver: positionSolver,
    tangentSolver: tangentSolver,
    tangentTranspose: tangentTranspose,
    mesh: mesh,
    localFrames: localFrames,
    pinWeight: PIN_WEIGHT,
  };
}

export function extractContours(srcPixels, width, height, detailLevel, blurPasses) {
  const srcRect = new Rect(0, 0, width, height);
  const alphaBuf = allocBuffer(srcRect.area());
  extractChannelByte(srcPixels, alphaBuf, ALPHA_CHANNEL_INDEX);
  round(alphaBuf, ALPHA_ROUND_THRESHOLD);

  const contentBounds = contentBoundsChannel(alphaBuf, srcRect);
  const simplifyTolerance =
    DETAIL_TOLERANCE_SCALE[detailLevel] * Math.max(contentBounds.width, contentBounds.height);
  const pad = blurPasses + 1;
  const paddedWidth = width + pad * 2;
  const paddedHeight = height + pad * 2;
  const paddedRect = new Rect(-pad, -pad, paddedWidth, paddedHeight);
  let paddedBuf = allocBuffer(paddedRect.area());
  copyChannel(alphaBuf, srcRect, paddedBuf, paddedRect);

  let scratchBuf = paddedBuf.slice(0);
  for (let blurIdx = 0; blurIdx < blurPasses; blurIdx++) {
    for (let row = 1; row < paddedHeight - 1; row++) {
      for (let col = 1; col < paddedWidth - 1; col++) {
        const off = row * paddedWidth + col;
        scratchBuf[off] =
          paddedBuf[off - paddedWidth] |
          paddedBuf[off - 1] |
          paddedBuf[off] |
          paddedBuf[off + 1] |
          paddedBuf[off + paddedWidth];
      }
    }
    const swap = scratchBuf;
    scratchBuf = paddedBuf;
    paddedBuf = swap;
  }

  const contourData = traceContours(
    paddedBuf,
    paddedWidth,
    paddedHeight,
    Math.round(contentBounds.area() * CONTOUR_AREA_SAMPLE_FACTOR),
  );
  const pathRecords = getPathRecords(contourData);
  const unpadMatrix = new Matrix2D(1, 0, 0, 1, -pad, -pad);

  for (let pathIdx = 0; pathIdx < pathRecords.length; pathIdx++) {
    const pathRecord = pathRecords[pathIdx];
    transformCoordPairs(pathRecord.path.coords, unpadMatrix, pathRecord.path.coords);
    pathRecord.restVertexCoords = sampleBezier(pathRecord.path);
    pathRecord.triangleIndices = earClipTriangulate(pathRecord.restVertexCoords);
    pathRecord.triangleIndices = fitPath(
      pathRecord.restVertexCoords,
      pathRecord.triangleIndices,
      simplifyTolerance,
    );
  }
  return pathRecords;
}

export function sampleBezier(path) {
  let samples = [];
  const coords = path.coords;
  const segmentCount = path.commands.length - 1;

  for (let segIdx = 0; segIdx < segmentCount; segIdx++) {
    const coordOff = segIdx * 6;
    const dx = coords[coordOff + 6] - coords[coordOff + 0];
    const dy = coords[coordOff + 7] - coords[coordOff + 1];
    const stepCount = Math.ceil(Math.sqrt(dx * dx + dy * dy));
    for (let stepIdx = 0; stepIdx < stepCount; stepIdx++) {
      const t = stepIdx / stepCount;
      const [sampleX, sampleY] = evaluateCubicBezier(t, coordOff, coords);
      samples.push(sampleX, sampleY);
    }
  }

  samples = douglasPeuckerSimplify(samples, BEZIER_SIMPLIFY_TOLERANCE);
  return reverseCoordPairStack(samples);
}

export function computeVertexUV(
  restVertexCoords,
  triangleIndices,
  pinVertexIndices,
  pinDepths,
) {
  const vertexCount = restVertexCoords.length >>> 1;
  const vertexUV = new Array(vertexCount);
  if (pinVertexIndices.length == 0) {
    vertexUV.fill(0);
    return vertexUV;
  }

  const adjacency = new Array(vertexCount);
  const edgeLengths = new Array(vertexCount);
  for (let vertexIdx = 0; vertexIdx < vertexCount; vertexIdx++) {
    adjacency[vertexIdx] = [];
    edgeLengths[vertexIdx] = [];
  }

  for (let triOff = 0; triOff < triangleIndices.length; triOff += TRIANGLE_VERTEX_COUNT) {
    addUndirectedMeshEdge(
      triangleIndices[triOff],
      triangleIndices[triOff + 1],
      adjacency,
      edgeLengths,
      restVertexCoords,
    );
    addUndirectedMeshEdge(
      triangleIndices[triOff],
      triangleIndices[triOff + 2],
      adjacency,
      edgeLengths,
      restVertexCoords,
    );
    addUndirectedMeshEdge(
      triangleIndices[triOff + 1],
      triangleIndices[triOff + 2],
      adjacency,
      edgeLengths,
      restVertexCoords,
    );
  }

  const distToPin = new Float64Array(vertexCount * 2);
  const nearestPinIdx = new Uint32Array(vertexCount * 2);
  distToPin.fill(INFINITE_GRAPH_DISTANCE);
  const visited = new Uint8Array(vertexCount);

  for (let pinSlot = 0; pinSlot < pinVertexIndices.length; pinSlot++) {
    visited.fill(0);
    const heap = [MIN_HEAP_SENTINEL, [0, pinVertexIndices[pinSlot]]];
    while (heap.length != 1) {
      const heapEntry = minHeap.pop(heap);
      const dist = heapEntry[0];
      const vertexIdx = heapEntry[1];
      if (visited[vertexIdx] == 1) {
        continue;
      }

      const distOff = vertexIdx << 1;
      if (dist < distToPin[distOff]) {
        distToPin[distOff + 1] = distToPin[distOff];
        nearestPinIdx[distOff + 1] = nearestPinIdx[distOff];
        distToPin[distOff] = dist;
        nearestPinIdx[distOff] = pinSlot;
      } else if (dist < distToPin[distOff + 1]) {
        distToPin[distOff + 1] = dist;
        nearestPinIdx[distOff + 1] = pinSlot;
      }

      visited[vertexIdx] = 1;
      const neighbors = adjacency[vertexIdx];
      const neighborDists = edgeLengths[vertexIdx];
      for (let neighborIdx = 0; neighborIdx < neighbors.length; neighborIdx++) {
        const neighborVertex = neighbors[neighborIdx];
        if (visited[neighborVertex] != 1) {
          minHeap.push(heap, [dist + neighborDists[neighborIdx], neighborVertex]);
        }
      }
    }
  }

  for (let vertexIdx = 0; vertexIdx < vertexCount; vertexIdx++) {
    const distOff = vertexIdx << 1;
    const distA = distToPin[distOff];
    const distB = distToPin[distOff + 1];
    const invSum = 1 / (distA + distB);
    vertexUV[vertexIdx] =
      (1 - distA * invSum) * pinDepths[nearestPinIdx[distOff]] +
      (1 - distB * invSum) * pinDepths[nearestPinIdx[distOff + 1]];
  }
  return vertexUV;
}

export function treeToPath(treeRoot) {
  const path = {
    commands: [],
    coords: [],
  };
  const stack = [treeRoot];
  while (stack.length != 0) {
    const node = stack.pop();
    const bounds = node.rectCoords;
    if (node.leftChild instanceof Array || node.rightChild instanceof Array) {
      path.commands.push("M", "L", "L", "L", "Z");
      path.coords.push(bounds[0], bounds[1], bounds[2], bounds[1], bounds[2], bounds[3], bounds[0], bounds[3]);
    } else {
      stack.push(node.leftChild, node.rightChild);
    }
  }
  return path;
}

export function renderMesh(
  sourcePixels,
  srcWidth,
  srcHeight,
  destPixels,
  destWidth,
  destHeight,
  meshUV,
  meshDocXY,
  jacobianDet,
  triangleIndices,
) {
  const triangleCount = Math.round(triangleIndices.length / TRIANGLE_VERTEX_COUNT);
  const drawOrder = new Array(triangleCount);
  for (let triIdx = 0; triIdx < triangleCount; triIdx++) {
    drawOrder[triIdx] = triIdx;
  }
  drawOrder.sort(function (triA, triB) {
    return jacobianDet[triangleIndices[triA * 3]] - jacobianDet[triangleIndices[triB * 3]];
  });

  for (let triIdx = 0; triIdx < triangleCount; triIdx++) {
    const triOff = drawOrder[triIdx] * 3;
    renderTriangle(
      triangleIndices[triOff] * 2,
      triangleIndices[triOff + 1] * 2,
      triangleIndices[triOff + 2] * 2,
      meshUV,
      meshDocXY,
      sourcePixels,
      srcWidth,
      srcHeight,
      destPixels,
      destWidth,
      destHeight,
    );
  }
}

export function renderTriangle(
  vertIdx0,
  vertIdx1,
  vertIdx2,
  meshUV,
  meshDocXY,
  sourcePixels,
  srcWidth,
  srcHeight,
  destPixels,
  destWidth,
  destHeight,
) {
  const sampleScratch = [0, 0, 0, 0];
  const docX0 = meshDocXY[vertIdx0];
  const docY0 = meshDocXY[vertIdx0 + 1];
  const docX1 = meshDocXY[vertIdx1];
  const docY1 = meshDocXY[vertIdx1 + 1];
  const docX2 = meshDocXY[vertIdx2];
  const docY2 = meshDocXY[vertIdx2 + 1];
  const uvU0 = clampSampleCoord(meshUV[vertIdx0], srcWidth - 1);
  const uvU1 = clampSampleCoord(meshUV[vertIdx1], srcWidth - 1);
  const uvU2 = clampSampleCoord(meshUV[vertIdx2], srcWidth - 1);
  const uvV0 = clampSampleCoord(meshUV[vertIdx0 + 1], srcHeight - 1);
  const uvV1 = clampSampleCoord(meshUV[vertIdx1 + 1], srcHeight - 1);
  const uvV2 = clampSampleCoord(meshUV[vertIdx2 + 1], srcHeight - 1);
  const edge01X = docX1 - docX0;
  const edge01Y = docY1 - docY0;
  const edge02X = docX2 - docX0;
  const edge02Y = docY2 - docY0;
  const invDet = 1 / (edge01X * edge02Y - edge02X * edge01Y + BARYCENTRIC_DET_EPSILON);
  const [rowMin, rowMax, colMin, colMax] = trianglePixelBounds(
    docX0,
    docY0,
    docX1,
    docY1,
    docX2,
    docY2,
    destWidth,
    destHeight,
  );

  for (let row = rowMin; row < rowMax; row++) {
    for (let col = colMin; col < colMax; col++) {
      const relX = col + 0.5 - docX0;
      const relY = row + 0.5 - docY0;
      const barycentric = barycentricCoordsAtOffset(relX, relY, edge01X, edge01Y, edge02X, edge02Y, invDet);
      if (barycentric) {
        const baryW = 1 - barycentric.baryU - barycentric.baryV;
        const sampleU = uvU0 * baryW + uvU1 * barycentric.baryU + uvU2 * barycentric.baryV;
        const sampleV = uvV0 * baryW + uvV1 * barycentric.baryU + uvV2 * barycentric.baryV;
        sampleBilinearFloat(
          sampleU,
          sampleV,
          sourcePixels,
          srcWidth,
          srcHeight,
          sampleScratch,
        );
        compositePixel(
          sampleScratch,
          destPixels,
          (row * destWidth + col) << 2,
        );
      }
    }
  }
}

export function compositePixel(sampleRgba, destPixels, destOff) {
  const destR = destPixels[destOff];
  const destG = destPixels[destOff + 1];
  const destB = destPixels[destOff + 2];
  const destA = destPixels[destOff + 3];
  const invSrcAlpha = 1 - sampleRgba[3] * (1 / 255);
  destPixels[destOff] = ~~(0.5 + sampleRgba[0] + destR * invSrcAlpha);
  destPixels[destOff + 1] = ~~(0.5 + sampleRgba[1] + destG * invSrcAlpha);
  destPixels[destOff + 2] = ~~(0.5 + sampleRgba[2] + destB * invSrcAlpha);
  destPixels[destOff + 3] = ~~(0.5 + sampleRgba[3] + destA * invSrcAlpha);
}

export function computeBarycentricWeights(coords, px, py, scratch) {
  const idx0 = scratch[0];
  const idx1 = scratch[1];
  const idx2 = scratch[2];
  const corner0X = coords[idx0 + 0];
  const corner0Y = coords[idx0 + 1];
  const corner1X = coords[idx1 + 0];
  const corner1Y = coords[idx1 + 1];
  const corner2X = coords[idx2 + 0];
  const corner2Y = coords[idx2 + 1];
  const edge01X = corner1X - corner0X;
  const edge01Y = corner1Y - corner0Y;
  const edge02X = corner2X - corner0X;
  const edge02Y = corner2Y - corner0Y;
  const relX = px - corner0X;
  const relY = py - corner0Y;
  const invDet = 1 / (edge01X * edge02Y - edge02X * edge01Y + BARYCENTRIC_DET_EPSILON);
  const barycentric = barycentricCoordsAtOffset(relX, relY, edge01X, edge01Y, edge02X, edge02Y, invDet);
  if (barycentric) {
    scratch[3] = 1 - barycentric.baryU - barycentric.baryV;
    scratch[4] = barycentric.baryU;
    scratch[5] = barycentric.baryV;
    return 1;
  }
  return 0;
}

export function pointInTriangleMesh(coords, triangleIndices, px, py) {
  const scratch = [0, 0, 0, 0, 0, 0];
  for (let triOff = 0; triOff < triangleIndices.length; triOff += TRIANGLE_VERTEX_COUNT) {
    scratch[0] = triangleIndices[triOff] * 2;
    scratch[1] = triangleIndices[triOff + 1] * 2;
    scratch[2] = triangleIndices[triOff + 2] * 2;
    if (computeBarycentricWeights(coords, px, py, scratch) == 1) {
      return true;
    }
  }
  return false;
}

export function triangleSignedArea(coords, vertIdx0, vertIdx1, vertIdx2) {
  const vert0X = coords[vertIdx0 * 2];
  const vert0Y = coords[vertIdx0 * 2 + 1];
  const vert1X = coords[vertIdx1 * 2];
  const vert1Y = coords[vertIdx1 * 2 + 1];
  const vert2X = coords[vertIdx2 * 2];
  const vert2Y = coords[vertIdx2 * 2 + 1];
  return (
    vert0X * vert1Y +
    vert1X * vert2Y +
    vert2X * vert0Y -
    vert2X * vert1Y -
    vert1X * vert0Y -
    vert0X * vert2Y
  );
}

export function buildHalfEdgeMesh(coords, triangleIndices) {
  const vertexHalfEdge = [];
  const triangleHalfEdge = [];
  const triangleCornerHalfEdge = [];
  const edgeMap = {};
  for (let triOff = 0; triOff < triangleIndices.length; triOff += TRIANGLE_VERTEX_COUNT) {
    const triIdx = ~~(triOff * (1 / 3));
    let vertIdx0 = triangleIndices[triOff + 0];
    let vertIdx1 = triangleIndices[triOff + 1];
    let vertIdx2 = triangleIndices[triOff + 2];
    const signedArea = triangleSignedArea(coords, vertIdx0, vertIdx1, vertIdx2);
    if (signedArea > 0) {
      const swap = vertIdx1;
      vertIdx1 = vertIdx2;
      vertIdx2 = swap;
    }
    const twin02 = edgeMap[vertIdx2 + "-" + vertIdx1];
    const twin10 = edgeMap[vertIdx1 + "-" + vertIdx0];
    const twin21 = edgeMap[vertIdx0 + "-" + vertIdx2];
    const halfEdge2 = [vertIdx2, twin02, triIdx, null];
    const halfEdge1 = [vertIdx1, twin10, triIdx, halfEdge2];
    const halfEdge0 = [vertIdx0, twin21, triIdx, halfEdge1];
    halfEdge2[3] = halfEdge0;
    if (twin02) {
      twin02[1] = halfEdge2;
    }
    if (twin10) {
      twin10[1] = halfEdge1;
    }
    if (twin21) {
      twin21[1] = halfEdge0;
    }
    edgeMap[vertIdx2 + "-" + vertIdx0] = halfEdge0;
    edgeMap[vertIdx0 + "-" + vertIdx1] = halfEdge1;
    edgeMap[vertIdx1 + "-" + vertIdx2] = halfEdge2;
    vertexHalfEdge[vertIdx0] = halfEdge1;
    triangleCornerHalfEdge[triOff] = halfEdge1;
    vertexHalfEdge[vertIdx1] = halfEdge2;
    triangleCornerHalfEdge[triOff + 1] = halfEdge2;
    vertexHalfEdge[vertIdx2] = halfEdge0;
    triangleCornerHalfEdge[triOff + 2] = halfEdge0;
    triangleHalfEdge[triIdx] = halfEdge1;
  }
  const halfEdges = [];
  for (const edgeKey in edgeMap) {
    halfEdges.push(edgeMap[edgeKey]);
  }
  return {
    vertexHalfEdge: vertexHalfEdge,
    triangleHalfEdge: triangleHalfEdge,
    triangleCornerHalfEdge: triangleCornerHalfEdge,
    halfEdges: halfEdges,
  };
}

export function getTriangleIndices(mesh) {
  const out = [];
  const triRoots = mesh.triangleHalfEdge;
  for (let triIdx = 0; triIdx < triRoots.length; triIdx++) {
    let he = triRoots[triIdx];
    out.push(he[0]);
    he = he[3];
    out.push(he[0]);
    he = he[3];
    out.push(he[0]);
  }
  return out;
}

export function circumcircle(coords, vertIdx0, vertIdx1, vertIdx2) {
  const corner0X = coords[vertIdx0 * 2];
  const corner0Y = coords[vertIdx0 * 2 + 1];
  const corner1X = coords[vertIdx1 * 2];
  const corner1Y = coords[vertIdx1 * 2 + 1];
  const corner2X = coords[vertIdx2 * 2];
  const corner2Y = coords[vertIdx2 * 2 + 1];
  const dx10 = corner1X - corner0X;
  const dy10 = corner1Y - corner0Y;
  const dx20 = corner2X - corner0X;
  const dy20 = corner2Y - corner0Y;
  const sum10 = dx10 * (corner0X + corner1X) + dy10 * (corner0Y + corner1Y);
  const sum20 = dx20 * (corner0X + corner2X) + dy20 * (corner0Y + corner2Y);
  const det = 2 * (dx10 * (corner2Y - corner1Y) - dy10 * (corner2X - corner1X));
  if (Math.abs(det) < CIRCUMCIRCLE_DET_EPSILON) {
    const minX = Math.min(corner0X, corner1X, corner2X);
    const minY = Math.min(corner0Y, corner1Y, corner2Y);
    const halfW = (Math.max(corner0X, corner1X, corner2X) - minX) * 0.5;
    const halfH = (Math.max(corner0Y, corner1Y, corner2Y) - minY) * 0.5;
    return [minX + halfW, minY + halfH, halfW * halfW + halfH * halfH, 1];
  }
  const cx = (dy20 * sum10 - dy10 * sum20) / det;
  const cy = (dx10 * sum20 - dx20 * sum10) / det;
  const rx = cx - corner0X;
  const ry = cy - corner0Y;
  return [cx, cy, rx * rx + ry * ry, 0];
}

export function delaunayFlip(coords, mesh, halfEdge) {
  const twin = halfEdge[1];
  const heNext = halfEdge[3];
  const heNextNext = heNext[3];
  const twinNext = twin[3];
  const twinNextNext = twinNext[3];
  const triA = halfEdge[2];
  const triB = twin[2];
  const vertTail = halfEdge[0];
  const vertTwinTail = twin[0];
  const vertOppA = heNext[0];
  const vertOppB = twinNext[0];
  const circum = circumcircle(coords, vertTwinTail, vertOppB, vertOppA);
  const testDx = coords[vertTail * 2] - circum[0];
  const testDy = coords[vertTail * 2 + 1] - circum[1];
  const shouldFlip =
    testDx * testDx + testDy * testDy > circum[2] &&
    circum[3] == 0 &&
    triangleSignedArea(coords, vertOppB, vertTail, vertOppA) < 0 &&
    triangleSignedArea(coords, vertOppA, vertTwinTail, vertOppB) < 0;
  if (shouldFlip) {
    halfEdge[0] = vertOppA;
    twin[0] = vertOppB;
    halfEdge[3] = heNextNext;
    heNextNext[3] = twinNext;
    twinNext[3] = halfEdge;
    twin[3] = twinNextNext;
    twinNextNext[3] = heNext;
    heNext[3] = twin;
    heNext[2] = triB;
    twinNext[2] = triA;
    mesh.triangleHalfEdge[triB] = twinNextNext;
    mesh.triangleHalfEdge[triA] = heNextNext;
    mesh.vertexHalfEdge[vertTwinTail] = twinNext;
    mesh.vertexHalfEdge[vertTail] = heNext;
  }
  return shouldFlip;
}

export function vertexDistance(coords, vA, vB) {
  const dx = coords[vA * 2] - coords[vB * 2];
  const dy = coords[vA * 2 + 1] - coords[vB * 2 + 1];
  return Math.sqrt(dx * dx + dy * dy);
}

export function subdivideEdge(coords, mesh, halfEdge) {
  const twin = halfEdge[1];
  const heNext = halfEdge[3];
  const heNextNext = heNext[3];
  let twinNext;
  let twinNextNext;
  const triA = halfEdge[2];
  let triB;
  const vertTail = halfEdge[0];
  const vertHead = heNextNext[0];
  const vertOppA = heNext[0];
  let vertOppB;
  if (twin) {
    twinNext = twin[3];
    twinNextNext = twinNext[3];
    triB = twin[2];
    vertOppB = twinNext[0];
  }
  const newVertIdx = coords.length >>> 1;
  coords[2 * newVertIdx] = (coords[2 * vertHead] + coords[2 * vertTail]) * 0.5;
  coords[2 * newVertIdx + 1] = (coords[2 * vertHead + 1] + coords[2 * vertTail + 1]) * 0.5;
  const leftTri = triA;
  const splitHe = halfEdge;
  const newTriIdx = mesh.triangleHalfEdge.length;
  const heMidToTail = [newVertIdx, null, leftTri, splitHe];
  const heOppToMid = [vertOppA, heMidToTail, newTriIdx, heNextNext];
  heMidToTail[1] = heOppToMid;
  const heMidToHead = [newVertIdx, null, newTriIdx, heOppToMid];
  heNext[3] = heMidToTail;
  heNextNext[3] = heMidToHead;
  heNextNext[2] = newTriIdx;
  mesh.triangleHalfEdge[leftTri] = heNext;
  mesh.triangleHalfEdge[newTriIdx] = heMidToHead;
  mesh.vertexHalfEdge[vertTail] = heNext;
  mesh.vertexHalfEdge[vertOppA] = heNextNext;
  mesh.halfEdges.push(heMidToTail, heOppToMid, heMidToHead);
  if (twin) {
    const rightTri = triB;
    const twinHe = twin;
    const rightNewTriIdx = newTriIdx + 1;
    heMidToHead[1] = twinHe;
    twinHe[1] = heMidToHead;
    const heMidToOppB = [newVertIdx, null, rightTri, twinHe];
    const heOppBToMid = [vertOppB, heMidToOppB, rightNewTriIdx, twinNextNext];
    heMidToOppB[1] = heOppBToMid;
    const heSplitTwin = [newVertIdx, splitHe, rightNewTriIdx, heOppBToMid];
    splitHe[1] = heSplitTwin;
    twinNext[3] = heMidToOppB;
    twinNextNext[3] = heSplitTwin;
    twinNextNext[2] = rightNewTriIdx;
    mesh.triangleHalfEdge[rightTri] = twinNext;
    mesh.triangleHalfEdge[rightNewTriIdx] = twinNextNext;
    mesh.vertexHalfEdge[vertHead] = twinNext;
    mesh.vertexHalfEdge[vertOppB] = twinNextNext;
    mesh.halfEdges.push(heMidToOppB, heOppBToMid, heSplitTwin);
  }
  mesh.vertexHalfEdge[newVertIdx] = splitHe;
}

export function runDelaunayFlips(coords, mesh) {
  let flipCount = 0;
  while (true) {
    const prevCount = flipCount;
    for (let heIdx = 0; heIdx < mesh.halfEdges.length; heIdx++) {
      const halfEdge = mesh.halfEdges[heIdx];
      if (halfEdge[1] == null) {
        continue;
      }
      if (delaunayFlip(coords, mesh, halfEdge)) {
        flipCount++;
        break;
      }
    }
    if (prevCount == flipCount) {
      break;
    }
  }
  return flipCount != 0;
}

export function refineByEdgeSplit(coords, mesh, maxEdgeLen, splitPasses) {
  let splitCount = 0;
  const vertexDistanceFn = vertexDistance;
  for (let pass = 0; pass < splitPasses; pass++) {
    const { halfEdge: longestEdge, edgeLength: longestLen } = pickLongestHalfEdge(
      mesh.halfEdges,
      coords,
      vertexDistanceFn,
    );
    if (longestLen > maxEdgeLen) {
      subdivideEdge(coords, mesh, longestEdge);
      splitCount++;
    }
  }
  return splitCount != 0;
}

export function relaxVertices(coords, mesh) {
  const force = [];
  let energy = 0;
  for (let idx = 0; idx < coords.length; idx++) {
    force.push(0);
  }
  for (let heIdx = 0; heIdx < mesh.halfEdges.length; heIdx++) {
    const halfEdge = mesh.halfEdges[heIdx];
    const vertIdxA = halfEdge[0];
    const vertIdxB = halfEdge[3][3][0];
    const ax = coords[vertIdxA * 2];
    const ay = coords[vertIdxA * 2 + 1];
    const bx = coords[vertIdxB * 2];
    const by = coords[vertIdxB * 2 + 1];
    const dx = ax - bx;
    const dy = ay - by;
    force[vertIdxA * 2] += -dx;
    force[vertIdxA * 2 + 1] += -dy;
    force[vertIdxB * 2] += dx;
    force[vertIdxB * 2 + 1] += dy;
  }
  for (let coordOff = 0; coordOff < coords.length; coordOff += COORD_PAIR_STRIDE) {
    const vertIdx = coordOff >>> 1;
    if (isInteriorMeshVertex(mesh, vertIdx)) {
      coords[coordOff] += RELAXATION_STEP * force[coordOff];
      coords[coordOff + 1] += RELAXATION_STEP * force[coordOff + 1];
      energy += RELAXATION_STEP * (force[coordOff] * force[coordOff] + force[coordOff + 1] * force[coordOff + 1]);
    }
  }
  return energy;
}

export function fitPath(coords, triangleIndices, maxEdgeLen) {
  boundsFromCoordPairs(coords);
  const mesh = buildHalfEdgeMesh(coords, triangleIndices);
  runDelaunayFlips(coords, mesh);
  for (let iter = 0; iter < FIT_PATH_MAX_ITERATIONS; iter++) {
    const didSplit = refineByEdgeSplit(
      coords,
      mesh,
      maxEdgeLen,
      REFINE_EDGE_SPLIT_PASSES,
    );
    let didFlip = false;
    if (didSplit) {
      didFlip = runDelaunayFlips(coords, mesh);
    }
    const relaxEnergy = relaxVertices(coords, mesh);
    if (!didSplit && !didFlip && relaxEnergy < RELAXATION_ENERGY_THRESHOLD) {
      break;
    }
  }
  return getTriangleIndices(mesh);
}
