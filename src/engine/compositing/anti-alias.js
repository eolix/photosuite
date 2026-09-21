/**
 * Vector path geometry for anti-aliased rasterization: command walking, cubic
 * subdivision, ear-clip triangulation, stroke offsets, and Typr/SVG path export.
 */

import { Rect } from "../../core/math/rect.js";
import { Point } from "../../core/math/point.js";
import { Matrix2D } from "../../core/math/matrix2d.js";

const PATH_COMMAND_COORD_COUNTS = {
  M: 2,
  L: 2,
  Q: 4,
  C: 6,
};

/**
 * Walk a path's commands in lockstep with its flat coords, calling
 * `visit(command, coordBase, arity, cmdIdx)` for each command. `coordBase` is
 * the index into the coords array where this command's values begin, and
 * `arity` is how many it consumes. Commands absent from
 * `PATH_COMMAND_COORD_COUNTS` (`Z`, `#`-prefixed subpath markers, `X`) report
 * arity 0. Centralizes the command/coord cursor so callers hold the per-command
 * logic without re-deriving the stride.
 */
function forEachPathSegment(commands, visit) {
  let coordBase = 0;
  for (let cmdIdx = 0; cmdIdx < commands.length; cmdIdx++) {
    const command = commands[cmdIdx];
    const arity = PATH_COMMAND_COORD_COUNTS[command] || 0;
    visit(command, coordBase, arity, cmdIdx);
    coordBase += arity;
  }
}

// ---------------------------------------------------------------------------
// Path canonicalize and Typr bridge
// ---------------------------------------------------------------------------

/** Flat path as { commands, coords } from compositing, Typr, or loader shapes. */
export function canonicalPath(path) {
  if (path == null) {
    throw new Error("antiAlias.canonicalPath: path is null or undefined");
  }
  const commands = path.commands != null
    ? path.commands
    : path.K != null
      ? path.K
      : path.cmds;
  const coords = path.coords != null
    ? path.coords
    : path.H != null
      ? path.H
      : path.crds;
  if (commands == null || coords == null) {
    throw new Error(
      "antiAlias.canonicalPath: missing command/coord arrays (keys: "
        + Object.keys(path).join(", ")
        + ")",
    );
  }
  return {
    commands: commands.slice(0),
    coords: coords.slice(0),
  };
}

export function pathHasDrawCommands(path) {
  return canonicalPath(path).commands.length !== 0;
}

export function clonePath(path) {
  return canonicalPath(path);
}

/** Shape for Typr.U.pathToContext and pathToSVG ({ cmds, crds }). */
export function toTyprPath(path) {
  const normalized = canonicalPath(path);
  return {
    cmds: normalized.commands,
    crds: normalized.coords,
  };
}

export function splitPathBySubpathId(path) {
  const canonical = canonicalPath(path);
  const subpathsById = {};
  let currentSubpath = null;

  forEachPathSegment(canonical.commands, (command, coordBase, arity) => {
    if (command.charAt(0) === "#") {
      if (subpathsById[command] == null) {
        subpathsById[command] = { coords: [], commands: [] };
      }
      currentSubpath = subpathsById[command];
    } else if (command !== "X") {
      currentSubpath.commands.push(command);
      for (let copyIdx = 0; copyIdx < arity; copyIdx++) {
        currentSubpath.coords.push(canonical.coords[coordBase + copyIdx]);
      }
    }
  });
  return subpathsById;
}

export function appendPath(destPath, srcPath, matrix) {
  if (matrix == null) matrix = new Matrix2D();
  const canonical = canonicalPath(srcPath);
  for (let coordIdx = 0; coordIdx < canonical.coords.length; coordIdx += 2) {
    const x = canonical.coords[coordIdx];
    const y = canonical.coords[coordIdx + 1];
    destPath.coords.push(
      x * matrix.a + y * matrix.c + matrix.tx,
      x * matrix.b + y * matrix.d + matrix.ty,
    );
  }
  for (let cmdIdx = 0; cmdIdx < canonical.commands.length; cmdIdx++) {
    destPath.commands.push(canonical.commands[cmdIdx]);
  }
}

// ---------------------------------------------------------------------------
// Polygon and coordinate geometry
// ---------------------------------------------------------------------------

export function isCounterClockwiseTurn(ax, ay, bx, by, cx, cy) {
  return (ay - by) * (cx - bx) + (bx - ax) * (cy - by) >= 0;
}

export function isPolygonConvex(flatCoords) {
  if (flatCoords.length < 6) return true;
  const lastPair = flatCoords.length - 4;
  for (let coordIdx = 0; coordIdx < lastPair; coordIdx += 2) {
    if (!isCounterClockwiseTurn(
      flatCoords[coordIdx],
      flatCoords[coordIdx + 1],
      flatCoords[coordIdx + 2],
      flatCoords[coordIdx + 3],
      flatCoords[coordIdx + 4],
      flatCoords[coordIdx + 5],
    )) {
      return false;
    }
  }
  if (!isCounterClockwiseTurn(
    flatCoords[lastPair],
    flatCoords[lastPair + 1],
    flatCoords[lastPair + 2],
    flatCoords[lastPair + 3],
    flatCoords[0],
    flatCoords[1],
  )) {
    return false;
  }
  if (!isCounterClockwiseTurn(
    flatCoords[lastPair + 2],
    flatCoords[lastPair + 3],
    flatCoords[0],
    flatCoords[1],
    flatCoords[2],
    flatCoords[3],
  )) {
    return false;
  }
  return true;
}

export function findNearestVertexIndex(flatCoords, testX, testY, maxDistance) {
  if (maxDistance == null) maxDistance = 1e9;
  let bestDistSq = 1e9;
  let bestVertexIdx = 0;
  for (let coordIdx = 0; coordIdx < flatCoords.length; coordIdx += 2) {
    const dx = testX - flatCoords[coordIdx];
    const dy = testY - flatCoords[coordIdx + 1];
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestVertexIdx = coordIdx >>> 1;
    }
  }
  return bestDistSq < maxDistance * maxDistance ? bestVertexIdx : -1;
}

export function lerpCoordPairs(fromCoords, toCoords, outCoords, t) {
  for (let coordIdx = 0; coordIdx < fromCoords.length; coordIdx += 2) {
    const fromX = fromCoords[coordIdx];
    const fromY = fromCoords[coordIdx + 1];
    const targetX = toCoords[coordIdx];
    const targetY = toCoords[coordIdx + 1];
    outCoords[coordIdx] = fromX + (targetX - fromX) * t;
    outCoords[coordIdx + 1] = fromY + (targetY - fromY) * t;
  }
}

export function transformCoordPairs(coords, matrix, outCoords) {
  for (let coordIdx = 0; coordIdx < coords.length; coordIdx += 2) {
    const x = coords[coordIdx];
    const y = coords[coordIdx + 1];
    outCoords[coordIdx] = x * matrix.a + y * matrix.c + matrix.tx;
    outCoords[coordIdx + 1] = x * matrix.b + y * matrix.d + matrix.ty;
  }
}

export function boundsFromCoordPairs(coords, startIdx, endIdx) {
  if (startIdx == null) startIdx = 0;
  if (endIdx == null) endIdx = coords.length;
  let minX = 99999999999;
  let maxX = -minX;
  let minY = 99999999999;
  let maxY = -minY;
  for (let coordIdx = startIdx; coordIdx < endIdx; coordIdx += 2) {
    const x = coords[coordIdx];
    const y = coords[coordIdx + 1];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return new Rect(minX, minY, maxX - minX, maxY - minY);
}

export function distanceFromPointToRect(point, rect) {
  const clampedX = Math.max(rect.x, Math.min(rect.x + rect.width, point.x));
  const clampedY = Math.max(rect.y, Math.min(rect.y + rect.height, point.y));
  const dx = point.x - clampedX;
  const dy = point.y - clampedY;
  return Math.sqrt(dx * dx + dy * dy);
}

export function pixelAlignRect(rect) {
  if (rect.isEmpty()) {
    return new Rect(
      Math.floor(rect.x),
      Math.floor(rect.y),
      Math.ceil(rect.width),
      Math.ceil(rect.height),
    );
  }
  const left = Math.floor(rect.x);
  const right = Math.ceil(rect.x + rect.width);
  const top = Math.floor(rect.y);
  const bottom = Math.ceil(rect.y + rect.height);
  return new Rect(left, top, right - left, bottom - top);
}

export function pixelAlignBoundsFromCoords(coords) {
  return pixelAlignRect(boundsFromCoordPairs(coords));
}

export function rectToPathOutline(rect) {
  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return {
    commands: ["M", "L", "L", "L", "Z"],
    coords: [left, top, right, top, right, bottom, left, bottom],
  };
}

export function douglasPeuckerSimplify(flatCoords, tolerance) {
  const lastIdx = flatCoords.length - 2;
  const startX = flatCoords[0];
  const startY = flatCoords[1];
  const endX = flatCoords[lastIdx];
  const endY = flatCoords[lastIdx + 1];
  const edgeDx = endX - startX;
  const edgeDy = endY - startY;
  const invEdgeLen = 1 / Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
  const lineConstant = endX * startY - endY * startX;
  let farthestIdx = -1;
  let farthestDist = -1;

  for (let coordIdx = 2; coordIdx < lastIdx; coordIdx += 2) {
    const px = flatCoords[coordIdx];
    const py = flatCoords[coordIdx + 1];
    const dist = Math.abs(edgeDy * px - edgeDx * py + lineConstant) * invEdgeLen;
    if (dist > farthestDist) {
      farthestDist = dist;
      farthestIdx = coordIdx;
    }
  }

  if (farthestDist < tolerance) {
    return [startX, startY, endX, endY];
  }

  const left = douglasPeuckerSimplify(
    flatCoords.slice(0, farthestIdx + 2),
    tolerance,
  );
  const right = douglasPeuckerSimplify(flatCoords.slice(farthestIdx), tolerance);
  for (let mergeIdx = 2; mergeIdx < right.length; mergeIdx++) {
    left.push(right[mergeIdx]);
  }
  return left;
}

export function polygonScanlineXsAtY(flatCoords, scanY) {
  const intersections = [];
  const vertexCount = flatCoords.length;
  for (let coordIdx = 0; coordIdx < vertexCount; coordIdx += 2) {
    let edgeStartX = flatCoords[coordIdx];
    let edgeStartY = flatCoords[coordIdx + 1];
    const edgeEndX = flatCoords[(coordIdx + 2) % vertexCount];
    let edgeEndY = flatCoords[(coordIdx + 3) % vertexCount];
    if (edgeEndY < edgeStartY) {
      const swapY = edgeStartY;
      edgeStartY = edgeEndY;
      edgeEndY = swapY;
    }
    if (edgeStartY < scanY && scanY < edgeEndY) {
      const t = (scanY - edgeStartY) / (edgeEndY - edgeStartY);
      intersections.push(edgeStartX + t * (edgeEndX - edgeStartX));
    }
  }
  intersections.sort((a, b) => a - b);
  return intersections;
}

// ---------------------------------------------------------------------------
// Path cubic normalize and subdivide
// ---------------------------------------------------------------------------

export function normalizePathToCubics(path) {
  const canonical = canonicalPath(path);
  const srcCoords = canonical.coords;
  const outCoords = [];
  const outCommands = [];
  let penX = 0;
  let penY = 0;
  let cp1x = 0;
  let cp1y = 0;
  let cp2x = 0;
  let cp2y = 0;
  let anchorX = 0;
  let anchorY = 0;

  forEachPathSegment(canonical.commands, (command, coordBase) => {
    if (command === "M") {
      penX = srcCoords[coordBase];
      penY = srcCoords[coordBase + 1];
      outCommands.push(command);
      outCoords.push(penX, penY);
    } else if (command === "C") {
      cp1x = srcCoords[coordBase];
      cp1y = srcCoords[coordBase + 1];
      cp2x = srcCoords[coordBase + 2];
      cp2y = srcCoords[coordBase + 3];
      anchorX = srcCoords[coordBase + 4];
      anchorY = srcCoords[coordBase + 5];
      outCommands.push(command);
      outCoords.push(cp1x, cp1y, cp2x, cp2y, anchorX, anchorY);
      penX = anchorX;
      penY = anchorY;
    } else if (command === "Q") {
      cp1x = srcCoords[coordBase];
      cp1y = srcCoords[coordBase + 1];
      cp2x = srcCoords[coordBase + 2];
      cp2y = srcCoords[coordBase + 3];
      const penToCtrlDx = cp1x - penX;
      const penToCtrlDy = cp1y - penY;
      const ctrlToEndDx = cp2x - cp1x;
      const ctrlToEndDy = cp2y - cp1y;
      outCommands.push("C");
      outCoords.push(
        penX + (2 / 3) * penToCtrlDx,
        penY + (2 / 3) * penToCtrlDy,
        cp1x + (1 / 3) * ctrlToEndDx,
        cp1y + (1 / 3) * ctrlToEndDy,
        cp2x,
        cp2y,
      );
      penX = cp2x;
      penY = cp2y;
    } else if (command === "L") {
      cp1x = srcCoords[coordBase];
      cp1y = srcCoords[coordBase + 1];
      outCommands.push("C");
      outCoords.push(penX, penY, cp1x, cp1y, cp1x, cp1y);
      penX = cp1x;
      penY = cp1y;
    } else {
      outCommands.push(command);
    }
  });
  return { commands: outCommands, coords: outCoords };
}

export function elevateQuadraticSegmentsToCubics(path) {
  const canonical = canonicalPath(path);
  const srcCoords = canonical.coords;
  const outCoords = [];
  const outCommands = [];

  forEachPathSegment(canonical.commands, (command, coordBase, arity) => {
    if (command === "Q") {
      const prevX = srcCoords[coordBase - 2];
      const prevY = srcCoords[coordBase - 1];
      const ctrlX = srcCoords[coordBase];
      const ctrlY = srcCoords[coordBase + 1];
      const endX = srcCoords[coordBase + 2];
      const endY = srcCoords[coordBase + 3];
      const prevToCtrlDx = ctrlX - prevX;
      const prevToCtrlDy = ctrlY - prevY;
      const ctrlToEndDx = endX - ctrlX;
      const ctrlToEndDy = endY - ctrlY;
      outCommands.push("C");
      outCoords.push(
        prevX + (2 / 3) * prevToCtrlDx,
        prevY + (2 / 3) * prevToCtrlDy,
        ctrlX + (1 / 3) * ctrlToEndDx,
        ctrlY + (1 / 3) * ctrlToEndDy,
        endX,
        endY,
      );
    } else {
      for (let copyIdx = 0; copyIdx < arity; copyIdx++) {
        outCoords.push(srcCoords[coordBase + copyIdx]);
      }
      outCommands.push(command);
    }
  });
  return { commands: outCommands, coords: outCoords };
}

export function subdivideCubicRecursive(
  x0,
  y0,
  x1,
  y1,
  x2,
  y2,
  x3,
  y3,
  maxError,
  outCommands,
  outCoords,
  depth,
) {
  const chordLen = Math.sqrt((x3 - x0) * (x3 - x0) + (y3 - y0) * (y3 - y0));
  const controlLen = Math.sqrt((x3 - x2) * (x3 - x2) + (y3 - y2) * (y3 - y2))
    + Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1))
    + Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
  const flatness = (chordLen + controlLen) / 2;

  if (flatness <= maxError) {
    outCommands.push("C");
    outCoords.push(x1, y1, x2, y2, x3, y3);
    return;
  }

  const mid01x = (x0 + x1) / 2;
  const mid01y = (y0 + y1) / 2;
  const mid12x = (x1 + x2) / 2;
  const mid12y = (y1 + y2) / 2;
  const mid23x = (x2 + x3) / 2;
  const mid23y = (y2 + y3) / 2;
  const mid012x = (mid01x + mid12x) / 2;
  const mid012y = (mid01y + mid12y) / 2;
  const mid123x = (mid12x + mid23x) / 2;
  const mid123y = (mid12y + mid23y) / 2;
  const splitX = (mid012x + mid123x) / 2;
  const splitY = (mid012y + mid123y) / 2;

  subdivideCubicRecursive(
    x0, y0, mid01x, mid01y, mid012x, mid012y, splitX, splitY,
    maxError, outCommands, outCoords, depth + 1,
  );
  subdivideCubicRecursive(
    splitX, splitY, mid123x, mid123y, mid23x, mid23y, x3, y3,
    maxError, outCommands, outCoords, depth + 1,
  );
}

export function subdividePathByFlatness(path, maxError) {
  const canonical = canonicalPath(path);
  const srcCoords = canonical.coords;
  const outCoords = [];
  const outCommands = [];
  let readIdx = 0;
  let penX = 0;
  let penY = 0;

  // Advances only for M and C: this receives cubic-only paths, and preserving
  // the exact cursor rule keeps output bit-identical on any input.
  for (let cmdIdx = 0; cmdIdx < canonical.commands.length; cmdIdx++) {
    const command = canonical.commands[cmdIdx];
    if (command === "M") {
      penX = srcCoords[readIdx];
      penY = srcCoords[readIdx + 1];
      readIdx += 2;
      outCommands.push(command);
      outCoords.push(penX, penY);
    } else if (command === "C") {
      const cp1x = srcCoords[readIdx];
      const cp1y = srcCoords[readIdx + 1];
      const cp2x = srcCoords[readIdx + 2];
      const cp2y = srcCoords[readIdx + 3];
      const anchorX = srcCoords[readIdx + 4];
      const anchorY = srcCoords[readIdx + 5];
      readIdx += 6;
      subdivideCubicRecursive(
        penX, penY, cp1x, cp1y, cp2x, cp2y, anchorX, anchorY,
        maxError, outCommands, outCoords, 0,
      );
      penX = anchorX;
      penY = anchorY;
    } else {
      outCommands.push(command);
    }
  }
  return { commands: outCommands, coords: outCoords };
}

function evaluateCubicAt(coordArray, baseIndex, t) {
  const oneMinusT = 1 - t;
  return oneMinusT * oneMinusT * oneMinusT * coordArray[baseIndex]
    + 3 * oneMinusT * oneMinusT * t * coordArray[baseIndex + 2]
    + 3 * oneMinusT * t * t * coordArray[baseIndex + 4]
    + t * t * t * coordArray[baseIndex + 6];
}

function parseCubicSubpathSpans(commands, coords) {
  const subpaths = [];
  let currentSubpath = null;
  let coordCursor = 0;

  // Advances only for M and C: cubic-only input, exact cursor rule preserved.
  for (let cmdIdx = 0; cmdIdx < commands.length; cmdIdx++) {
    const command = commands[cmdIdx];
    if (command === "M") {
      currentSubpath = {
        coordStart: coordCursor,
        cubicCount: 0,
        closed: false,
      };
      subpaths.push(currentSubpath);
      coordCursor += 2;
    }
    if (command === "C") {
      currentSubpath.cubicCount++;
      coordCursor += 6;
    }
    if (command === "Z") {
      currentSubpath.closed = true;
    }
  }
  return subpaths;
}

function filterSubpathsWithCubics(subpaths) {
  const cubicSubpaths = [];
  for (let subpathIdx = 0; subpathIdx < subpaths.length; subpathIdx++) {
    if (subpaths[subpathIdx].cubicCount !== 0) {
      cubicSubpaths.push(subpaths[subpathIdx]);
    }
  }
  return cubicSubpaths;
}

function computeSubpathWinding(subpath, coords) {
  const coordStart = subpath.coordStart;
  const coordEnd = coordStart + 2 + subpath.cubicCount * 6;
  const endsAtStart = coords[coordStart] === coords[coordEnd - 2]
    && coords[coordStart + 1] === coords[coordEnd - 1];

  subpath.bounds = boundsFromCoordPairs(coords, coordStart, coordEnd);

  let signedArea = 0;
  for (let cubicIdx = 0; cubicIdx < subpath.cubicCount; cubicIdx++) {
    const cubicCoordStart = coordStart + cubicIdx * 6;
    const cubicCoordEnd = cubicCoordStart + 6;
    signedArea += (coords[cubicCoordEnd] - coords[cubicCoordStart])
      * (coords[cubicCoordEnd + 1] + coords[cubicCoordStart + 1]);
  }

  if (subpath.cubicCount === 2) {
    const startX = coords[coordStart];
    const startY = coords[coordStart + 1];
    const midAnchorX = coords[coordStart + 6];
    const midAnchorY = coords[coordStart + 7];
    const endAnchorX = coords[coordStart + 6];
    const endAnchorY = coords[coordStart + 7];
    const midX = evaluateCubicAt(coords, coordStart, 0.5);
    const midY = evaluateCubicAt(coords, coordStart + 1, 0.5);
    const midEndX = evaluateCubicAt(coords, coordStart + 6, 0.5);
    const midEndY = evaluateCubicAt(coords, coordStart + 7, 0.5);
    signedArea = (midX - startX) * (midY - startY)
      + (midAnchorX - midX) * (midAnchorY - midY)
      + (midEndX - midAnchorX) * (midEndY - midAnchorY)
      + (endAnchorX - midEndX) * (endAnchorY - midEndY);
  }

  if (!endsAtStart) {
    signedArea += (coords[coordStart] - coords[coordEnd - 2])
      * (coords[coordStart + 1] + coords[coordEnd - 1]);
  }

  subpath.counterClockwise = signedArea <= 0;
}

function sortSubpathsByBoundsContainment(subpaths) {
  for (let outerIdx = 0; outerIdx < subpaths.length - 1; outerIdx++) {
    for (let innerIdx = outerIdx + 1; innerIdx < subpaths.length; innerIdx++) {
      const outerSubpath = subpaths[outerIdx];
      const innerSubpath = subpaths[innerIdx];
      if (innerSubpath.bounds.containsRect(outerSubpath.bounds)) {
        subpaths[outerIdx] = innerSubpath;
        subpaths[innerIdx] = outerSubpath;
      }
    }
  }
}

function resolveFillRuleFlag(subpath, subpathIdx, subpaths, skipFillRule, referenceClockwise) {
  let fillRuleFlag = subpath.counterClockwise === referenceClockwise && !skipFillRule
    ? 1
    : 0;

  if (!skipFillRule && subpathIdx !== 0) {
    if (
      subpaths[subpathIdx - 1].bounds.containsRect(subpath.bounds)
      && subpaths[subpathIdx - 1].counterClockwise !== subpath.counterClockwise
    ) {
      fillRuleFlag = 0;
    }
    for (let otherIdx = 0; otherIdx < subpaths.length; otherIdx++) {
      if (
        otherIdx !== subpathIdx
        && subpaths[otherIdx].bounds.containsRect(subpath.bounds)
      ) {
        fillRuleFlag = 0;
      }
    }
  }
  return fillRuleFlag;
}

function appendCubicSegmentRecords(
  records,
  coords,
  subpath,
  recordTypeBase,
) {
  const coordStart = subpath.coordStart;
  const coordEnd = coordStart + 2 + subpath.cubicCount * 6;
  const endsAtStart = coords[coordStart] === coords[coordEnd - 2]
    && coords[coordStart + 1] === coords[coordEnd - 1];

  for (let cubicIdx = 0; cubicIdx < subpath.cubicCount; cubicIdx++) {
    const cubicCoordIdx = coordStart + cubicIdx * 6;
    const anchor = new Point(coords[cubicCoordIdx], coords[cubicCoordIdx + 1]);
    const controlOut = new Point(coords[cubicCoordIdx + 2], coords[cubicCoordIdx + 3]);
    let anchorOut;
    if (cubicIdx === 0) {
      if (endsAtStart) {
        anchorOut = new Point(coords[coordEnd - 4], coords[coordEnd - 3]);
      } else {
        anchorOut = anchor.clonePath();
      }
    } else {
      anchorOut = new Point(coords[cubicCoordIdx - 2], coords[cubicCoordIdx - 1]);
    }
    records.push({
      type: recordTypeBase + 2,
      cp1: anchorOut,
      anchor,
      anchorOut: controlOut,
    });
  }

  if (!endsAtStart) {
    const closingAnchor = new Point(coords[coordEnd - 2], coords[coordEnd - 1]);
    records.push({
      type: recordTypeBase + 2,
      cp1: new Point(coords[coordEnd - 4], coords[coordEnd - 3]),
      anchor: closingAnchor,
      anchorOut: closingAnchor.clonePath(),
    });
  }
}

function downgradeDegenerateCanvasRecords(records) {
  for (let recordIdx = 0; recordIdx < records.length; recordIdx++) {
    const record = records[recordIdx];
    if (record.type > 5 || record.type === 0 || record.type === 3) continue;

    let isDegenerate = record.cp1.equals(record.anchor)
      || record.anchor.equals(record.anchorOut);
    if (!isDegenerate) {
      const cross = record.cp1.x * (record.anchor.y - record.anchorOut.y)
        + record.anchor.x * (record.anchorOut.y - record.cp1.y)
        + record.anchorOut.x * (record.cp1.y - record.anchor.y);
      if (Math.abs(cross) < 1e-6) isDegenerate = true;
    }
    if (isDegenerate) record.type--;
  }
}

/** Build canvas path records with winding and fill-rule metadata from a flat path. */
export function buildCanvasPathRecords(path, skipFillRule, evenOddFill) {
  const cubicPath = normalizePathToCubics(canonicalPath(path));
  const coords = cubicPath.coords;
  const commands = cubicPath.commands;

  let subpaths = parseCubicSubpathSpans(commands, coords);
  subpaths = filterSubpathsWithCubics(subpaths);

  for (let subpathIdx = 0; subpathIdx < subpaths.length; subpathIdx++) {
    computeSubpathWinding(subpaths[subpathIdx], coords);
  }
  sortSubpathsByBoundsContainment(subpaths);

  const referenceClockwise = subpaths.length === 0
    ? true
    : subpaths[0].counterClockwise;

  const records = [
    { type: 6 },
    { type: 8, all: 0 },
  ];

  for (let subpathIdx = 0; subpathIdx < subpaths.length; subpathIdx++) {
    const subpath = subpaths[subpathIdx];
    const coordStart = subpath.coordStart;
    const coordEnd = coordStart + 2 + subpath.cubicCount * 6;
    const endsAtStart = coords[coordStart] === coords[coordEnd - 2]
      && coords[coordStart + 1] === coords[coordEnd - 1];
    const recordTypeBase = subpath.closed || endsAtStart ? 0 : 3;
    const fillRuleFlag = resolveFillRuleFlag(
      subpath,
      subpathIdx,
      subpaths,
      skipFillRule,
      referenceClockwise,
    );

    records.push({
      type: recordTypeBase,
      length: subpath.cubicCount + (endsAtStart ? 0 : 1),
      fillRule: evenOddFill ? 1 : fillRuleFlag,
      subpathHeaderFlags: 2,
    });
    appendCubicSegmentRecords(records, coords, subpath, recordTypeBase);
  }

  downgradeDegenerateCanvasRecords(records);
  return records;
}

function appendPathRecordSegment(prevRecord, nextRecord, outPath, forceLine) {
  if (
    !forceLine
    && prevRecord.anchorOut.equals(prevRecord.anchor)
    && nextRecord.cp1.equals(nextRecord.anchor)
  ) {
    outPath.coords.push(nextRecord.anchor.x, nextRecord.anchor.y);
    outPath.commands.push("L");
  } else {
    outPath.coords.push(
      prevRecord.anchorOut.x,
      prevRecord.anchorOut.y,
      nextRecord.cp1.x,
      nextRecord.cp1.y,
      nextRecord.anchor.x,
      nextRecord.anchor.y,
    );
    outPath.commands.push("C");
  }
}

function appendSubpathFromRecords(outPath, records, startIdx, segmentCount, closed, forceLine) {
  const firstRecord = records[startIdx];
  outPath.coords.push(firstRecord.anchor.x, firstRecord.anchor.y);
  outPath.commands.push("M");
  let segIdx = startIdx;
  for (; segIdx < startIdx + segmentCount - 1; segIdx++) {
    appendPathRecordSegment(records[segIdx], records[segIdx + 1], outPath, forceLine);
  }
  if (!closed) {
    appendPathRecordSegment(records[segIdx], records[startIdx], outPath, forceLine);
  }
}

export function flattenPathRecordsToPath(records, forceLine) {
  if (forceLine == null) forceLine = false;
  const outPath = { coords: [], commands: [] };

  for (let recordIdx = 0; recordIdx < records.length; recordIdx++) {
    if (records[recordIdx].type > 5) continue;
    const segmentCount = records[recordIdx].length;
    if (segmentCount === 0) continue;
    if (recordIdx === records.length - 1) break;

    const closed = records[recordIdx].type === 3;
    appendSubpathFromRecords(
      outPath,
      records,
      recordIdx + 1,
      segmentCount,
      closed,
      forceLine,
    );
    if (!closed) outPath.commands.push("Z");
    recordIdx += segmentCount;
  }
  return outPath;
}

export function extractOpenSubpaths(path) {
  const canonical = canonicalPath(path);
  const coords = canonical.coords;
  const subpaths = [];
  let currentSubpath;
  let coordIdx = 0;

  for (let cmdIdx = 0; cmdIdx < canonical.commands.length; cmdIdx++) {
    const command = canonical.commands[cmdIdx];
    if (command === "C") {
      currentSubpath.push(
        coords[coordIdx++],
        coords[coordIdx++],
        coords[coordIdx++],
        coords[coordIdx++],
        coords[coordIdx++],
        coords[coordIdx++],
      );
    } else if (command === "Z") {
      // closed subpath marker — no coords consumed
    } else {
      currentSubpath = [];
      if (command !== "M") {
        currentSubpath.push(command);
        cmdIdx++;
      }
      currentSubpath.push(coords[coordIdx++], coords[coordIdx++]);
      subpaths.push(currentSubpath);
    }
  }
  return subpaths;
}

// ---------------------------------------------------------------------------
// Ear-clip triangulation
// ---------------------------------------------------------------------------

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const abx = cx - ax;
  const aby = cy - ay;
  const acx = bx - ax;
  const acy = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const denom = abx * abx + aby * aby;
  const dotAB = abx * acx + aby * acy;
  const dotAP = abx * apx + aby * apy;
  const dotAC = acx * acx + acy * acy;
  const dotCP = acx * apx + acy * apy;
  const invDenom = 1 / (denom * dotAC - dotAB * dotAB);
  const u = (dotAC * dotAP - dotAB * dotCP) * invDenom;
  const v = (denom * dotCP - dotAB * dotAP) * invDenom;
  return u >= 0 && v >= 0 && u + v < 1;
}

/** Ear-clipping triangulation of a simple polygon given as flat x,y pairs. */
export function earClipTriangulate(flatCoords) {
  const vertexCount = flatCoords.length >>> 1;
  if (vertexCount < 3) return [];

  const triangleIndices = [];
  const activeVerts = [];
  for (let vertexIdx = 0; vertexIdx < vertexCount; vertexIdx++) {
    activeVerts.push(vertexIdx);
  }

  let activeCount = vertexCount;
  let earIdx = 0;

  while (activeCount > 3) {
    const earVert0 = activeVerts[(earIdx + 0) % activeCount];
    const earVert1 = activeVerts[(earIdx + 1) % activeCount];
    const earVert2 = activeVerts[(earIdx + 2) % activeCount];
    const ax = flatCoords[2 * earVert0];
    const ay = flatCoords[2 * earVert0 + 1];
    const bx = flatCoords[2 * earVert1];
    const by = flatCoords[2 * earVert1 + 1];
    const cx = flatCoords[2 * earVert2];
    const cy = flatCoords[2 * earVert2 + 1];

    let isEar = false;
    if (isCounterClockwiseTurn(ax, ay, bx, by, cx, cy)) {
      isEar = true;
      for (let testIdx = 0; testIdx < activeCount; testIdx++) {
        const testVert = activeVerts[testIdx];
        if (testVert === earVert0 || testVert === earVert1 || testVert === earVert2) continue;
        if (pointInTriangle(
          flatCoords[2 * testVert],
          flatCoords[2 * testVert + 1],
          ax,
          ay,
          bx,
          by,
          cx,
          cy,
        )) {
          isEar = false;
          break;
        }
      }
    }

    if (isEar) {
      triangleIndices.push(earVert0, earVert1, earVert2);
      activeVerts.splice((earIdx + 1) % activeCount, 1);
      activeCount--;
      earIdx = 0;
    } else if (earIdx++ > 3 * activeCount) {
      break;
    }
  }

  triangleIndices.push(activeVerts[0], activeVerts[1], activeVerts[2]);
  return triangleIndices;
}

export function addTriangleEdgesToPath(flatCoords, vertA, vertB, outPath, edgeSeen) {
  if (vertA > vertB) {
    const swap = vertB;
    vertB = vertA;
    vertA = swap;
  }
  if (edgeSeen[vertA + "," + vertB]) return;
  edgeSeen[vertA + "," + vertB] = true;
  outPath.commands.push("M", "L");
  outPath.coords.push(
    flatCoords[vertA],
    flatCoords[vertA + 1],
    flatCoords[vertB],
    flatCoords[vertB + 1],
  );
}

export function wireframeTrianglesToPath(flatCoords, triangleIndices) {
  const edgeSeen = {};
  const outPath = { commands: [], coords: [] };
  for (let triIdx = 0; triIdx < triangleIndices.length; triIdx += 3) {
    const vertA = triangleIndices[triIdx] * 2;
    const vertB = triangleIndices[triIdx + 1] * 2;
    const vertC = triangleIndices[triIdx + 2] * 2;
    addTriangleEdgesToPath(flatCoords, vertA, vertB, outPath, edgeSeen);
    addTriangleEdgesToPath(flatCoords, vertA, vertC, outPath, edgeSeen);
    addTriangleEdgesToPath(flatCoords, vertB, vertC, outPath, edgeSeen);
  }
  return outPath;
}

// ---------------------------------------------------------------------------
// Stroke fillet math
// ---------------------------------------------------------------------------

export function solve2x2Intersection(ax, ay, bx, by, cx, cy, dx, dy) {
  const numerator = dx * (ay - cy) - dy * (ax - cx);
  const denominator = dy * bx - dx * by;
  if (denominator === 0) return 0;
  return numerator / denominator;
}

export function filletCornerArcLengths(x0, y0, x1, y1, x2, y2, radius) {
  const inDx = x0 - x1;
  const inDy = y0 - y1;
  const outDx = x2 - x1;
  const outDy = y2 - y1;
  const invInLen = 1 / Math.sqrt(inDx * inDx + inDy * inDy);
  const invOutLen = 1 / Math.sqrt(outDx * outDx + outDy * outDy);
  const inUnitX = inDx * invInLen;
  const inUnitY = inDy * invInLen;
  const outUnitX = outDx * invOutLen;
  const outUnitY = outDy * invOutLen;
  const offsetInY = inUnitY * radius;
  const offsetInX = -inUnitX * radius;
  const offsetOutY = -outUnitY * radius;
  const offsetOutX = outUnitX * radius;
  const cornerParam = solve2x2Intersection(
    offsetInY,
    offsetInX,
    inUnitX,
    inUnitY,
    offsetOutY,
    offsetOutX,
    outUnitX,
    outUnitY,
  );
  const cornerX = offsetInY + inUnitX * cornerParam;
  const cornerY = offsetInX + inUnitY * cornerParam;
  const cornerParam2 = solve2x2Intersection(
    0,
    0,
    inUnitX,
    inUnitY,
    cornerX,
    cornerY,
    -inUnitY,
    inUnitX,
  );
  const tangentX = inUnitX * cornerParam2;
  const tangentY = inUnitY * cornerParam2;
  return [
    Math.sqrt(tangentX * tangentX + tangentY * tangentY),
    inUnitX,
    inUnitY,
    outUnitX,
    outUnitY,
  ];
}

export function filletCornerBezierKnots(x0, y0, x1, y1, x2, y2, radius) {
  const arcMetrics = filletCornerArcLengths(x0, y0, x1, y1, x2, y2, radius);
  const arcRadius = arcMetrics[0];
  const inUnitX = arcMetrics[1];
  const inUnitY = arcMetrics[2];
  const outUnitX = arcMetrics[3];
  const outUnitY = arcMetrics[4];
  let sweepAngle = Math.atan2(
    inUnitX * outUnitY - inUnitY * outUnitX,
    inUnitX * outUnitX + inUnitY * outUnitY,
  );
  if (sweepAngle < 0) sweepAngle = sweepAngle * -1;
  const complement = Math.PI - sweepAngle;
  const handleScale = (4 / 3) * Math.tan(complement / 4);
  const startX = x1 + arcRadius * inUnitX;
  const startY = y1 + arcRadius * inUnitY;
  const endX = x1 + arcRadius * outUnitX;
  const endY = y1 + arcRadius * outUnitY;
  const cp1x = startX + handleScale * radius * -inUnitX;
  const cp1y = startY + handleScale * radius * -inUnitY;
  const cp2x = endX + handleScale * radius * -outUnitX;
  const cp2y = endY + handleScale * radius * -outUnitY;
  return [0, 0, startX, startY, cp1x, cp1y, cp2x, cp2y, endX, endY];
}

export function filletCornerControlPoints(
  x0,
  y0,
  x1,
  y1,
  x2,
  y2,
  radiusIn,
  radiusOut,
  edgeLenIn,
  edgeLenOut,
) {
  if (edgeLenIn == null) {
    edgeLenIn = Math.sqrt((x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0));
  }
  if (edgeLenOut == null) {
    edgeLenOut = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
  }
  const kappa = 0.553;
  let inDirX = 0;
  let inDirY = 0;
  let outDirX = 0;
  let outDirY = 0;
  if (edgeLenIn !== 0) {
    inDirX = (x1 - x0) / edgeLenIn;
    inDirY = (y1 - y0) / edgeLenIn;
  }
  if (edgeLenOut !== 0) {
    outDirX = (x2 - x1) / edgeLenOut;
    outDirY = (y2 - y1) / edgeLenOut;
  }
  const cpInX = x0 + radiusIn * inDirX;
  const cpInY = y0 + radiusIn * inDirY;
  const cpOutX = x1 - radiusOut * inDirX;
  const cpOutY = y1 - radiusOut * inDirY;
  return [
    cpInX,
    cpInY,
    cpOutX,
    cpOutY,
    x1 - radiusOut * inDirX * (1 - kappa),
    y1 - radiusOut * inDirY * (1 - kappa),
    x1 + radiusOut * outDirX * (1 - kappa),
    y1 + radiusOut * outDirY * (1 - kappa),
    x1 + radiusOut * outDirX,
    y1 + radiusOut * outDirY,
  ];
}

export function strokeOffsetRoundCorners(flatCoords, cornerRadii) {
  const adjustedRadii = cornerRadii.slice(0);
  const vertexCount = flatCoords.length / 2;
  const edgeLengths = [];
  const outCoords = [];

  for (let vertexIdx = 0; vertexIdx < vertexCount; vertexIdx++) {
    const nextIdx = (vertexIdx + 1) % vertexCount;
    const edgeDx = flatCoords[2 * vertexIdx] - flatCoords[2 * nextIdx];
    const edgeDy = flatCoords[2 * vertexIdx + 1] - flatCoords[2 * nextIdx + 1];
    edgeLengths[vertexIdx] = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
  }

  for (let vertexIdx = 0; vertexIdx < vertexCount; vertexIdx++) {
    const prevIdx = (vertexIdx - 1 + vertexCount) % vertexCount;
    const nextIdx = (vertexIdx + 1) % vertexCount;
    const radius = cornerRadii[vertexIdx];
    const sumPrev = radius + cornerRadii[prevIdx];
    const sumNext = radius + cornerRadii[nextIdx];
    if (sumPrev !== 0) {
      adjustedRadii[vertexIdx] = Math.min(
        adjustedRadii[vertexIdx],
        edgeLengths[prevIdx] * radius / sumPrev,
      );
    }
    if (sumNext !== 0) {
      adjustedRadii[vertexIdx] = Math.min(
        adjustedRadii[vertexIdx],
        edgeLengths[vertexIdx] * radius / sumNext,
      );
    }
  }

  for (let vertexIdx = 0; vertexIdx < vertexCount; vertexIdx++) {
    const nextIdx = (vertexIdx + 1) % vertexCount;
    const afterNextIdx = (vertexIdx + 2) % vertexCount;
    const radiusIn = adjustedRadii[vertexIdx];
    const radiusOut = adjustedRadii[nextIdx];
    const cornerX = flatCoords[2 * vertexIdx];
    const cornerY = flatCoords[2 * vertexIdx + 1];
    const nextX = flatCoords[2 * nextIdx];
    const nextY = flatCoords[2 * nextIdx + 1];
    const afterNextX = flatCoords[2 * afterNextIdx];
    const afterNextY = flatCoords[2 * afterNextIdx + 1];
    const edgeLen = edgeLengths[vertexIdx];
    const nextEdgeLen = edgeLengths[nextIdx];
    const handles = filletCornerControlPoints(
      cornerX, cornerY, nextX, nextY, afterNextX, afterNextY,
      radiusIn, radiusOut, edgeLen, nextEdgeLen,
    );
    outCoords.push(handles[0], handles[1], handles[0], handles[1], handles[2], handles[3]);
    outCoords.push(handles[2], handles[3], handles[4], handles[5], handles[6], handles[7]);
  }
  return outCoords;
}

// ---------------------------------------------------------------------------
// API installation
// ---------------------------------------------------------------------------


