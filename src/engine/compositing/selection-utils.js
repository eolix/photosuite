/**
 * Path selection utilities, intelligent scissors (magnetic lasso), and channel
 * mask combine ops.
 *
 * {@link PathData} is the Dijkstra frontier the magnetic lasso walks while the
 * user drags.
 */

/* global paper, Typr */

/** Stroke cap descriptor enum → the canvas `lineCap` it draws as. */
const CANVAS_LINE_CAP = {
  strokeStyleButtCap: "butt",
  strokeStyleRoundCap: "round",
  strokeStyleSquareCap: "square",
};

/** Stroke join descriptor enum → the canvas `lineJoin` it draws as. */
const CANVAS_LINE_JOIN = {
  strokeStyleMiterJoin: "miter",
  strokeStyleRoundJoin: "round",
  strokeStyleBevelJoin: "bevel",
};

import { Point } from '../../core/math/point.js';
import { Rect } from '../../core/math/rect.js';
import { Matrix2D } from '../../core/math/matrix2d.js';
import { allocBuffer, extractChannelByte, fillBuffer } from "./buffer-utils.js";
import { contentBoundsChannel, copyAlphaToChannel, copyChannel } from "./pixel-ops.js";
import { boundsFromCoordPairs, filletCornerArcLengths, filletCornerBezierKnots, flattenPathRecordsToPath, strokeOffsetRoundCorners, subdividePathByFlatness, toTyprPath, transformCoordPairs } from "./anti-alias.js";
import { transformPointsArray } from "./homography.js";
import { ensurePaperJs, paperItemToPathRecords, pathRecordsToPaperPaths, unitePathRecordsWithPaper } from './path-paper-bridge.js';
import { allSegmentKnotsAreStraight, countSubpaths, flattenPathKnotCoords, isOrthogonalQuadPath, usesEvenOddFill, writeFlatCoordsToPathRecords } from "./path-records.js";
import { invalidateKeyOriginAtIndex } from "./key-origins.js";
import { getScratch2dContext } from "./color-math.js";
import { warpCoordsThroughMesh } from "./image-renderer.js";

/**
 * @type {object|null} Engine namespace, for the slices still assembled on it:
 * key origins, the image renderer, and the shared scratch 2d context.
 */


function unionRects(rectA, rectB) {
  const left = Math.min(rectA.x, rectB.x);
  const top = Math.min(rectA.y, rectB.y);
  const right = Math.max(rectA.x + rectA.width, rectB.x + rectB.width);
  const bottom = Math.max(rectA.y + rectA.height, rectB.y + rectB.height);
  return new Rect(left, top, right - left, bottom - top);
}


/** Fast fill for an axis-aligned rectangular selection mask with edge fade. */
function fillOrthogonalQuadMask(maskChannel, boundsRect, pathBounds) {
  const pixelCount = boundsRect.area();
  const width = boundsRect.width;
  const height = boundsRect.height;
  maskChannel.fill(255);
  if (pathBounds.area() == pixelCount) return;
  const fadeLeft = 1 - (pathBounds.x - boundsRect.x);
  const fadeTop = 1 - (pathBounds.y - boundsRect.y);
  const fadeRight = 1 - (boundsRect.x + boundsRect.width - (pathBounds.x + pathBounds.width));
  const fadeBottom = 1 - (boundsRect.x + boundsRect.height - (pathBounds.x + pathBounds.height));
  const colLeft = ~~(fadeLeft * 255);
  const colRight = ~~(fadeRight * 255);
  const rowTop = ~~(fadeTop * 255);
  const rowBottom = ~~(fadeBottom * 255);
  maskChannel.fill(rowTop, 0, width);
  maskChannel[0] = ~~(fadeLeft * fadeTop * 255);
  maskChannel[width - 1] = ~~(fadeRight * fadeTop * 255);
  for (let px = width; px < pixelCount; px += width) {
    maskChannel[px] = colLeft;
    maskChannel[px + width - 1] = colRight;
  }
  maskChannel.fill(rowBottom, (height - 1) * width, height * width);
  maskChannel[pixelCount - width] = ~~(fadeLeft * fadeBottom * 255);
  maskChannel[pixelCount - 1] = ~~(fadeRight * fadeBottom * 255);
}


/** Bucketed Dijkstra frontier keyed by path cost. */
export class PathData {
  constructor(pixelCount) {
    this.posIndex = new Uint32Array(pixelCount);
    this.list = [];
    this.count = 0;
    this.minCost = 4294967295;
  }

  isEmpty() {
    return this.count == 0;
  }

  push(pixelIdx, cost) {
    const buckets = this.list;
    if (buckets[cost] == null) buckets[cost] = [];
    buckets[cost].push(pixelIdx);
    this.count++;
    this.posIndex[pixelIdx] = buckets[cost].length - 1 + 1;
    this.minCost = Math.min(this.minCost, cost);
  }

  pop() {
    this.count--;
    const buckets = this.list;
    let cost = this.minCost;
    let pixelIdx = buckets[cost].pop();
    if (buckets[cost].length == 0) buckets[cost] = null;
    this.updateMinCost();
    this.posIndex[pixelIdx] = 0;
    return pixelIdx;
  }

  contains(pixelIdx) {
    return this.posIndex[pixelIdx] != 0;
  }

  remove(pixelIdx, cost) {
    this.count--;
    const buckets = this.list;
    const slot = this.posIndex[pixelIdx] - 1;
    if (slot == buckets[cost].length - 1) buckets[cost].pop();
    else {
      const moved = buckets[cost].pop();
      buckets[cost][slot] = moved;
      this.posIndex[moved] = slot + 1;
    }
    if (buckets[cost].length == 0) buckets[cost] = null;
    this.posIndex[pixelIdx] = 0;
    this.updateMinCost();
  }

  updateMinCost() {
    if (this.count == 0) {
      this.minCost = 4294967295;
      return;
    }
    let cost = this.minCost;
    const buckets = this.list;
    while (buckets[cost] == null) cost++;
    this.minCost = cost;
  }
}


export function hitTestPoint(pathRecords, point, preferCurves, tolerance) {
  ensurePaperJs();

  const hitOptions = preferCurves ? {
      curves: true,
      tolerance: tolerance
    } : null;

  const paperPoint = new paper.Point(point.x, point.y);
  const paperPaths = pathRecordsToPaperPaths(pathRecords);
  for (let pairIdx = paperPaths.length - 1; pairIdx >= 0; pairIdx--) {
    const paperPath = paperPaths[pairIdx][0];
    const hit = paperPath.hitTest(paperPoint, hitOptions);
    if (hit != null) {
      const loc = hit.location;
      return {
        idx: pairIdx,
        segmentIndex: preferCurves && loc != null ? loc.index : null
      };
    }
  }
  return {
    idx: -1
  };
}

export function selectPointsInRect(pathRecords, rect, componentFilter) {
  const selected = [
    [],
    [],
    []
  ];
  for (let recIdx = 0; recIdx < pathRecords.length; recIdx++) {
    let record = pathRecords[recIdx];
    if (record.type > 5 || record.type == 0 || record.type == 3) continue;
    const includeHandles = componentFilter == null ? true : componentFilter.indexOf(recIdx) != -1;
    if (rect.containsPoint(record.anchor)) selected[0].push(recIdx);
    if (rect.containsPoint(record.cp1) && includeHandles) selected[1].push(recIdx);
    if (rect.containsPoint(record.anchorOut) && includeHandles) selected[2].push(recIdx);
  }
  return selected;
}

export function removeSelectedSubpathsFromPath(pathRecords, removedRecordIndices, keyOriginIndices) {
  const keyOriginsKept = keyOriginIndices.slice(0);
  const originByRecord = [null, null];
  let subpathIndex = -1;
  let subpathHeader = null;
  for (let recIdx = 2; recIdx < pathRecords.length; recIdx++) {
    if ((pathRecords[recIdx].type == 0 || pathRecords[recIdx].type == 3) && pathRecords[recIdx].fillRule != -1) {
      subpathIndex++;
    }
    originByRecord[recIdx] = keyOriginIndices[subpathIndex];
  }
  keyOriginIndices = originByRecord;
  const outRecords = pathRecords.slice(0, 2);
  const outOrigins = keyOriginIndices.slice(0, 2);
  for (let recIdx = 2; recIdx < pathRecords.length; recIdx++) {
    if (pathRecords[recIdx].type == 0 || pathRecords[recIdx].type == 3) {
      subpathHeader = pathRecords[recIdx];
      outRecords.push(subpathHeader);
      outOrigins.push(keyOriginIndices[recIdx]);
    } else if (removedRecordIndices.indexOf(recIdx) == -1) {
      outRecords.push(pathRecords[recIdx]);
      outOrigins.push(keyOriginIndices[recIdx]);
    } else {
      subpathHeader.length--;
      invalidateKeyOriginAtIndex(keyOriginIndices, recIdx);
    }
  }
  for (let recIdx = 2; recIdx < outRecords.length; recIdx++) {
    const header = outRecords[recIdx];
    if (header.type != 0 && header.type != 3) continue;
    if (header.length == 0) {
      if (outRecords[recIdx + 1] && outRecords[recIdx + 1].fillRule == -1) {
        outRecords[recIdx + 1].fillRule = header.fillRule;
      }
      outOrigins.splice(recIdx, 1);
      outRecords.splice(recIdx, 1);
      recIdx--;
    }
  }
  for (let originIdx = 0; originIdx < keyOriginsKept.length; originIdx++) {
    if (outOrigins.indexOf(keyOriginsKept[originIdx]) == -1) {
      keyOriginsKept.splice(originIdx, 1);
      originIdx--;
    }
  }
  return outRecords;
}

export function filterPathExcludingSubpaths(pathRecords, excludedSubpathIndices) {
  const filtered = pathRecords.slice(0, 2);
  let subpathIndex = -1;
  for (let recIdx = 2; recIdx < pathRecords.length; recIdx++) {
    if ((pathRecords[recIdx].type == 0 || pathRecords[recIdx].type == 3) && pathRecords[recIdx].fillRule != -1) {
      subpathIndex++;
    }
    if (excludedSubpathIndices.indexOf(subpathIndex) == -1) filtered.push(pathRecords[recIdx]);
  }
  return filtered;
}

export function filterPathKeepingSubpaths(pathRecords, keptSubpathIndices) {
  const filtered = pathRecords.slice(0, 2);
  let subpathIndex = -1;
  for (let recIdx = 2; recIdx < pathRecords.length; recIdx++) {
    if ((pathRecords[recIdx].type == 0 || pathRecords[recIdx].type == 3) && pathRecords[recIdx].fillRule != -1) {
      subpathIndex++;
    }
    if (keptSubpathIndices.indexOf(subpathIndex) != -1) filtered.push(pathRecords[recIdx]);
  }
  return filtered;
}






export function minimumCornerAngleRad(pathRecords) {
  let minAngleDeg = 180;
  for (let recIdx = 0; recIdx < pathRecords.length; recIdx++) {
    if (pathRecords[recIdx].type != 0 && pathRecords[recIdx].type != 3) continue;
    let knotCount = pathRecords[recIdx].length;
    if (knotCount < 3) continue;
    for (let knotIdx = 0; knotIdx < knotCount; knotIdx++) {
      const prevKnot = pathRecords[recIdx + 1 + (knotIdx - 1 + knotCount) % knotCount];
      const cornerKnot = pathRecords[recIdx + 1 + knotIdx];
      let nextKnot = pathRecords[recIdx + 1 + (knotIdx + 1) % knotCount];
      const anchor = cornerKnot.anchor;
      const legIn = cornerKnot.cp1.equals(anchor) ? prevKnot.anchorOut : cornerKnot.cp1;
      const legOut = cornerKnot.anchorOut.equals(anchor) ? nextKnot.cp1 : cornerKnot.anchorOut;
      if (anchor.equals(legIn) || anchor.equals(legOut)) continue;
      const angleInDeg = Math.atan2(legIn.y - anchor.y, legIn.x - anchor.x) * 180 / Math.PI;
      const angleOutDeg = Math.atan2(legOut.y - anchor.y, legOut.x - anchor.x) * 180 / Math.PI;
      const deltaDeg = Math.abs(angleOutDeg - angleInDeg) % 360;
      const cornerAngleDeg = deltaDeg > 180 ? 360 - deltaDeg : deltaDeg;
      if (cornerAngleDeg < minAngleDeg) minAngleDeg = cornerAngleDeg;
    }
  }
  return minAngleDeg * Math.PI / 180;
}

export function signedSubpathArea(pathRecords) {
  if (pathRecords.length <= 5) return 0;
  let area = 0;
  let knotCount = pathRecords.length - 3 - 1;
  for (let knotIdx = 0; knotIdx < knotCount; knotIdx++) {
    const knotA = pathRecords[3 + knotIdx];
    const knotB = pathRecords[3 + knotIdx + 1];
    if (knotA.type == 0 || knotB.type == 0) return 0;
    area += (knotB.anchor.x - knotA.anchor.x) * (knotA.anchor.y + knotB.anchor.y);
  }
  area += (pathRecords[3].anchor.x - pathRecords[3 + knotCount].anchor.x) *
    (pathRecords[3 + knotCount].anchor.y + pathRecords[3 + 1].anchor.y);
  return -area * .5;
}



export function rasterizePathToMaskChannel(pathRecords, maskChannel, boundsRect, strokeStyle) {
  if (boundsRect.isEmpty()) return;
  const pixelCount = boundsRect.area();
  const tileMax = 16384;
  const width = boundsRect.width;
  const height = boundsRect.height;
  if (strokeStyle == null && allSegmentKnotsAreStraight(pathRecords)) {
    let allTwoPointSubpaths = true;
    for (let recIdx = 2; recIdx < pathRecords.length;) {
      if (pathRecords[recIdx].length == 2) recIdx += 3;
      else {
        allTwoPointSubpaths = false;
        break;
      }
    }
    if (allTwoPointSubpaths) return;
    if (isOrthogonalQuadPath(pathRecords)) {
      const pathBounds = boundsOfPathRecords(pathRecords);
      fillOrthogonalQuadMask(maskChannel, boundsRect, pathBounds);
      return;
    }
  }
  const tilesX = Math.ceil(width / tileMax);
  const tilesY = Math.ceil(height / tileMax);
  const tileW = Math.ceil(width / tilesX);
  const tileH = Math.ceil(height / tilesY);
  for (let tileY = 0; tileY < tilesY; tileY++) {
    for (let tileX = 0; tileX < tilesX; tileX++) {
      const originX = tileX * tileW;
      const originY = tileY * tileH;
      const tw = tileW;
      const th = tileH;
      const scratchCtx = getScratch2dContext(tw, th);
      if (!usesEvenOddFill(pathRecords)) scratchCtx.fillRect(0, 0, tw, th);
      renderPathOnContext(
        pathRecords, scratchCtx, -boundsRect.x - originX, -boundsRect.y - originY, strokeStyle
      );
      const rgba = new Uint8Array(scratchCtx.getImageData(0, 0, tw, th).data.buffer);
      if (tw == width && th == height) extractChannelByte(rgba, maskChannel, 3);
      else copyAlphaToChannel(rgba, new Rect(originX, originY, tw, th), maskChannel, new Rect(0, 0, width, height));
    }
  }
}

export function renderPathOnContext(pathRecords, ctx, offsetX, offsetY, strokeStyle) {
  if (strokeStyle != null && strokeStyle.fillEnabled.v) {
    let hasStrokeOnly = false;
    let hasFillRule = false;
    let fillRuleCount = 0;
    for (let recIdx = 0; recIdx < pathRecords.length; recIdx++) {
      let fillRule = pathRecords[recIdx].fillRule;
      if (fillRule != null) fillRuleCount++;
      if (fillRule == -1) hasStrokeOnly = true;
      if (fillRule > 0) hasFillRule = true;
    }
    if (!hasStrokeOnly && fillRuleCount < 20) {
      pathRecords = unitePathRecordsWithPaper(pathRecords);
    }
  }
  for (let recIdx = 0; recIdx < pathRecords.length; recIdx++) {
    if (pathRecords[recIdx].type > 5) continue;
    let knotCount = pathRecords[recIdx].length;
    if (knotCount == 0) continue;
    if (recIdx == pathRecords.length - 1) break;
    const openSubpath = pathRecords[recIdx].type == 3;
    let fillRule = pathRecords[recIdx].fillRule;
    if (fillRule == 3 && recIdx == 2) fillRule = 1;
    if (fillRule != -1 && strokeStyle == null) {
      ctx.globalCompositeOperation = ["xor", "source-over", "destination-out", "source-in"][fillRule];
    }
    if (pathRecords[recIdx].fillRule != -1) {
      ctx.beginPath();
      if (strokeStyle) {
        let lineWidth = strokeStyle.strokeStyleLineWidth.v.val;
        const alignment = strokeStyle.strokeStyleLineAlignment.v.strokeStyleLineAlignment;
        const capType = strokeStyle.strokeStyleLineCapType.v.strokeStyleLineCapType;
        const joinType = strokeStyle.strokeStyleLineJoinType.v.strokeStyleLineJoinType;
        const miterLimit = strokeStyle.strokeStyleMiterLimit.v;
        const dashScaled = [];
        const dashSet = strokeStyle.strokeStyleLineDashSet.v;
        for (let dashIdx = 0; dashIdx < dashSet.length; dashIdx++) {
          dashScaled.push(dashSet[dashIdx].v.val * lineWidth);
        }
        ctx.setLineDash(dashScaled);
        ctx.lineCap = CANVAS_LINE_CAP[capType];
        ctx.lineJoin = CANVAS_LINE_JOIN[joinType];
        // An inside- or outside-aligned stroke is drawn at double width and
        // clipped to the path; a centred one is drawn as specified.
        ctx.lineWidth = alignment == "strokeStyleAlignCenter" ? lineWidth : lineWidth *= 2;
        ctx.miterLimit = miterLimit;
      }
    }
    traceSubpathOnContext(ctx, pathRecords, recIdx + 1, knotCount, offsetX, offsetY, openSubpath);
    if (!openSubpath) ctx.closePath();
    if (pathRecords[recIdx + 1 + knotCount] == null || pathRecords[recIdx + 1 + knotCount].fillRule != -1) {
      if (strokeStyle) ctx.stroke();
      else ctx.fill(usesEvenOddFill(pathRecords) ? "evenodd" : "nonzero");
    }
    recIdx += knotCount;
  }
  ctx.globalCompositeOperation = "source-over";
}

export function traceSubpathOnContext(ctx, pathRecords, startIdx, segmentCount, offsetX, offsetY, openPath) {
  let knot = pathRecords[startIdx];
  let nextKnot = null;
  ctx.moveTo(knot.anchor.x + offsetX, knot.anchor.y + offsetY);
  let segIdx = startIdx;
  for (; segIdx < startIdx + segmentCount - 1; segIdx++) {
    knot = pathRecords[segIdx];
    nextKnot = pathRecords[segIdx + 1];
    ctx.bezierCurveTo(
      knot.anchorOut.x + offsetX, knot.anchorOut.y + offsetY,
      nextKnot.cp1.x + offsetX, nextKnot.cp1.y + offsetY,
      nextKnot.anchor.x + offsetX, nextKnot.anchor.y + offsetY
    );
  }
  if (!openPath) {
    knot = pathRecords[segIdx];
    nextKnot = pathRecords[startIdx];
    ctx.bezierCurveTo(
      knot.anchorOut.x + offsetX, knot.anchorOut.y + offsetY,
      nextKnot.cp1.x + offsetX, nextKnot.cp1.y + offsetY,
      nextKnot.anchor.x + offsetX, nextKnot.anchor.y + offsetY
    );
  }
}


export function simplifyPolylineToPathRecords(flatCoords, tolerance) {
  ensurePaperJs();
  const paperPath = new paper.Path;
  paperPath.remove();
  const lastIdx = flatCoords.length - 1;

  const closed = Math.sqrt((flatCoords[lastIdx - 1] - flatCoords[0]) * (flatCoords[lastIdx - 1] - flatCoords[0]) +
    (flatCoords[lastIdx] - flatCoords[1]) * (flatCoords[lastIdx] - flatCoords[1])) < 3;

  paperPath.closed = closed;
  for (let coordIdx = 0; coordIdx < flatCoords.length; coordIdx += 2) {
    paperPath.add(new paper.Point(flatCoords[coordIdx], flatCoords[coordIdx + 1]));
  }
  paperPath.simplify(tolerance);

  let pathRecords = [{
    type: 6
  }, {
    type: 8,
    all: 0
  }];

  pathRecords = pathRecords.concat(paperItemToPathRecords(paperPath));
  return pathRecords;
}

export function roundCornersOnSubpath(pathRecords, subpathHeaderIdx, cornerRadii) {
  let knotCount = pathRecords[subpathHeaderIdx].length;
  const knotType = pathRecords[subpathHeaderIdx].type;
  let insertOffset = 0;
  const knots = pathRecords.slice(subpathHeaderIdx + 1, subpathHeaderIdx + 1 + knotCount);
  for (let knotIdx = 0; knotIdx < knotCount; knotIdx++) {
    const prevRadius = cornerRadii[(knotIdx - 1 + knotCount) % knotCount];
    const nextRadius = cornerRadii[(knotIdx + 1 + knotCount) % knotCount];
    let radius = cornerRadii[knotIdx];
    if (radius != 0) {
      const prevAnchor = knots[(knotIdx - 1 + knotCount) % knotCount].anchor;
      const cornerAnchor = knots[(knotIdx + 0 + knotCount) % knotCount].anchor;
      const nextAnchor = knots[(knotIdx + 1 + knotCount) % knotCount].anchor;
      const legPrev = Point.dist(cornerAnchor, prevAnchor);
      const legNext = Point.dist(cornerAnchor, nextAnchor);

      const arcLen = filletCornerArcLengths(prevAnchor.x, prevAnchor.y,
        cornerAnchor.x, cornerAnchor.y, nextAnchor.x, nextAnchor.y, radius)[0];

      const clamped = Math.min(arcLen, prevRadius == 0 ? legPrev : legPrev / 2, nextRadius == 0 ? legNext : legNext / 2);
      radius *= clamped / arcLen;

      const bez = filletCornerBezierKnots(prevAnchor.x, prevAnchor.y,
          cornerAnchor.x, cornerAnchor.y, nextAnchor.x, nextAnchor.y, radius);

      const knotIn = {
        type: knotType + 1,
        cp1: new Point(bez[2], bez[3]),
        anchor: new Point(bez[2], bez[3]),
        anchorOut: new Point(bez[4], bez[5])
      };

      const knotOut = {
        type: knotType + 1,
        cp1: new Point(bez[6], bez[7]),
        anchor: new Point(bez[8], bez[9]),
        anchorOut: new Point(bez[8], bez[9])
      };

      pathRecords.splice(subpathHeaderIdx + insertOffset + 1, 1, knotIn, knotOut);
      insertOffset++;
      pathRecords[subpathHeaderIdx].length++;
    }
    insertOffset++;
  }
}






export function applyMatrixToPathRecords(pathRecords, matrix, subpathFilter, recordFilter) {
  const flatCoords = flattenPathKnotCoords(pathRecords, subpathFilter, recordFilter);
  transformPointsArray(matrix, flatCoords);
  writeFlatCoordsToPathRecords(flatCoords, pathRecords, subpathFilter, recordFilter);
}

export function applyMatrixToPathRecordsSmooth(pathRecords, matrix, subpathFilter, recordFilter) {
  if (subpathFilter == null && recordFilter == null) {
    const smoothed = smoothPathRecordsBySubdivision(pathRecords, 40);
    for (let recIdx = 0; recIdx < smoothed.length; recIdx++) pathRecords[recIdx] = smoothed[recIdx];
  }
  const flatCoords = flattenPathKnotCoords(pathRecords, subpathFilter, recordFilter);
  warpCoordsThroughMesh(matrix, flatCoords, boundsFromCoordPairs(flatCoords));
  writeFlatCoordsToPathRecords(flatCoords, pathRecords, subpathFilter, recordFilter);
}

export function smoothPathRecordsBySubdivision(pathRecords, smoothness) {
  const out = [];
  for (let recIdx = 0; recIdx < pathRecords.length; recIdx++) {
    let record = pathRecords[recIdx];
    if (record.type > 5) {
      out.push(JSON.parse(JSON.stringify(record)));
      continue;
    }
    let pathSpec = sliceSubpathToPathSpec(pathRecords, recIdx + 1, record.length);
    pathSpec = subdividePathByFlatness(pathSpec, smoothness);
    const segments = pathSpecToVertexLoop(pathSpec);
    recIdx += record.length;
    record = JSON.parse(JSON.stringify(record));
    record.length = segments.length;
    out.push(record);
    for (let segIdx = 0; segIdx < segments.length; segIdx++) out.push(segments[segIdx]);
  }
  return out;
}

export function sliceSubpathToPathSpec(pathRecords, startIdx, segmentCount) {
  let pathSpec = { commands: ["M"], coords: [] };
  const first = pathRecords[startIdx];
  const last = pathRecords[startIdx + segmentCount - 1];
  pathSpec.coords.push(first.anchor.x, first.anchor.y);
  for (let seg = 1; seg < segmentCount; seg++) {
    const prev = pathRecords[startIdx + seg - 1];
    const curr = pathRecords[startIdx + seg];
    pathSpec.commands.push("C");
    pathSpec.coords.push(prev.anchorOut.x, prev.anchorOut.y, curr.cp1.x, curr.cp1.y, curr.anchor.x, curr.anchor.y);
  }
  pathSpec.commands.push("C");
  pathSpec.coords.push(last.anchorOut.x, last.anchorOut.y, first.cp1.x, first.cp1.y, first.anchor.x, first.anchor.y);
  return pathSpec;
}

export function pathSpecToVertexLoop(pathSpec) {
  const segments = [];
  const commands = pathSpec.commands;
  const coords = pathSpec.coords;
  const coordLen = coords.length;
  segments.push({
    type: 2,
    cp1: new Point(coords[coordLen - 4], coords[coordLen - 3]),
    anchor: new Point(coords[0], coords[1]),
    anchorOut: new Point(coords[2], coords[3])
  });
  for (let cmdIdx = 0; cmdIdx < commands.length - 2; cmdIdx++) {
    const coordOff = cmdIdx * 6 + 4;
    segments.push({
      type: 2,
      cp1: new Point(coords[coordOff], coords[coordOff + 1]),
      anchor: new Point(coords[coordOff + 2], coords[coordOff + 3]),
      anchorOut: new Point(coords[coordOff + 4], coords[coordOff + 5])
    });
  }
  return segments;
}

export function measureRightAngleLeg(pathRecords) {
  for (let recIdx = 0; recIdx < pathRecords.length; recIdx++) {
    if (pathRecords[recIdx].type > 5) continue;
    const subpathLen = pathRecords[recIdx].length;
    if (!(subpathLen == 4 || subpathLen == 6 || subpathLen == 8)) {
      recIdx += subpathLen;
      continue;
    }
    for (let corner = 0; corner < subpathLen; corner++) {
      const knotA = pathRecords[recIdx + 1 + corner];
      const knotB = pathRecords[recIdx + 1 + (corner + 1) % subpathLen];
      let minX = Math.min(knotA.anchor.x, knotB.anchor.x);
      let minY = Math.min(knotA.anchor.y, knotB.anchor.y);
      let legHoriz = 0;
      let cornerDelta = 0;
      if (knotA.anchor.x < knotB.anchor.x) {
        legHoriz = knotA.anchor.y - minY;
        cornerDelta = legHoriz - (knotB.anchor.x - minX);
      } else {
        legHoriz = knotB.anchor.y - minY;
        cornerDelta = legHoriz - (knotA.anchor.x - minX);
      }
      if (Math.abs(cornerDelta) < .2 * legHoriz) return legHoriz;
    }
  }
  return -1;
}

export function boundsOfPathRecords(pathRecords, subpathFilter, unionMode) {
  let bounds = null;
  let subpathIndex = -1;
  let evenOddMode = !usesEvenOddFill(pathRecords);
  for (let recIdx = 0; recIdx < pathRecords.length; recIdx++) {
    let record = pathRecords[recIdx];
    if (record.type > 5) continue;
    if ((record.type == 0 || record.type == 3) && record.fillRule != -1) subpathIndex++;
    if (subpathFilter != null && subpathFilter.indexOf(subpathIndex) == -1) continue;
    if (recIdx == pathRecords.length - 1) break;
    const isClosed = record.type == 3;
    const subpathLen = record.length;
    let fillRule = record.fillRule;
    const segmentBounds = boundsOfSubpathSegments(pathRecords, recIdx + 1, subpathLen, isClosed);
    if (bounds == null) bounds = segmentBounds;
    else if (unionMode) bounds = unionRects(bounds, segmentBounds);
    else if (evenOddMode) {
      if (subpathFilter != null || fillRule == 0 || fillRule == -1 || fillRule == 2) bounds = unionRects(bounds, segmentBounds);
      else if (fillRule == 1) bounds = bounds;
      else if (fillRule == 3) {
        bounds = segmentBounds;
        evenOddMode = false;
      }
    } else {
      if (subpathFilter != null || fillRule == 0 || fillRule == -1 || fillRule == 1) bounds = unionRects(bounds, segmentBounds);
      else if (fillRule == 2) bounds = bounds;
      else if (fillRule == 3) bounds = bounds.intersect(segmentBounds);
    }
    recIdx += subpathLen;
  }
  if (bounds == null || bounds.width < 0 || bounds.height < 0) bounds = new Rect(0, 0, 0, 0);
  return bounds;
}

/** Reused by boundsOfSubpathSegments so a bounds walk allocates nothing. */
const cubicBoundsScratch = new Float64Array(4);

export function boundsOfSubpathSegments(pathRecords, startIdx, segmentCount, includeClosing) {
  const scratch = cubicBoundsScratch;
  scratch[0] = 1e30;
  scratch[1] = 1e30;
  scratch[2] = -1e30;
  scratch[3] = -1e30;
  const closing = pathRecords[startIdx + segmentCount - 1];
  if (!includeClosing) {
    extendBoundsWithCubicBezier(closing.anchor.x, closing.anchor.y, closing.anchorOut.x, closing.anchorOut.y,
      pathRecords[startIdx].cp1.x, pathRecords[startIdx].cp1.y,
      pathRecords[startIdx].anchor.x, pathRecords[startIdx].anchor.y, scratch);
  }
  for (let seg = startIdx; seg < startIdx + segmentCount - 1; seg++) {
    const knotA = pathRecords[seg];
    const knotB = pathRecords[seg + 1];
    extendBoundsWithCubicBezier(knotA.anchor.x, knotA.anchor.y, knotA.anchorOut.x, knotA.anchorOut.y,
      knotB.cp1.x, knotB.cp1.y, knotB.anchor.x, knotB.anchor.y, scratch);
  }
  return new Rect(scratch[0], scratch[1], scratch[2] - scratch[0], scratch[3] - scratch[1]);
}

export function extendBoundsWithCubicBezier(startX, startY, ctrlOutX, ctrlOutY, ctrlInX, ctrlInY, endX, endY, boundsOut) {
  if (startX == ctrlOutX && startY == ctrlOutY && ctrlInX == endX && ctrlInY == endY) {
    boundsOut[0] = Math.min(boundsOut[0], Math.min(startX, endX));
    boundsOut[1] = Math.min(boundsOut[1], Math.min(startY, endY));
    boundsOut[2] = Math.max(boundsOut[2], Math.max(startX, endX));
    boundsOut[3] = Math.max(boundsOut[3], Math.max(startY, endY));
    return;
  }
  let minX = startX;
  let minY = startY;
  let maxX = startX;
  let maxY = startY;
  const sampleCount = 40;
  const step = 1 / (sampleCount - 1);
  for (let sample = 0; sample < sampleCount; sample++) {
    const t = sample * step;
    const u = 1 - t;
    const basisA = u * u * u;
    const basisB = 3 * u * u * t;
    const basisC = 3 * u * t * t;
    const basisD = t * t * t;
    let px = basisA * startX + basisB * ctrlOutX + basisC * ctrlInX + basisD * endX;
    const py = basisA * startY + basisB * ctrlOutY + basisC * ctrlInY + basisD * endY;
    if (px < minX) minX = px;
    else if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    else if (py > maxY) maxY = py;
  }
  if (minX < boundsOut[0]) boundsOut[0] = minX;
  if (minY < boundsOut[1]) boundsOut[1] = minY;
  if (maxX > boundsOut[2]) boundsOut[2] = maxX;
  if (maxY > boundsOut[3]) boundsOut[3] = maxY;
}

export function pointOnPathAtParam(pathRecords, paramAlongPath) {
  const knotSpan = pathRecords.length - 3;
  const param = paramAlongPath % knotSpan;
  const knotIndex = Math.floor(param);
  if (paramAlongPath < 0 || knotIndex >= knotSpan) return null;
  const knotA = pathRecords[3 + knotIndex];
  const knotB = pathRecords[3 + (knotIndex + 1) % knotSpan];
  const anchorA = knotA.anchor;
  const outA = knotA.anchorOut;
  const cp1B = knotB.cp1;
  const anchorB = knotB.anchor;
  const t = param - knotIndex;
  const u = 1 - t;
  let px = u * u * u * anchorA.x + 3 * u * u * t * outA.x + 3 * u * t * t * cp1B.x + t * t * t * anchorB.x;
  const py = u * u * u * anchorA.y + 3 * u * u * t * outA.y + 3 * u * t * t * cp1B.y + t * t * t * anchorB.y;
  return new Point(px, py);
}

export function exportPathRecordsToSvg(pathRecords) {
  const curveSteps = 2;
  const subpathCount = countSubpaths(pathRecords);
  let useEvenOdd = false;
  for (let recIdx = 2; recIdx < pathRecords.length; recIdx++) {
    let fillRule = pathRecords[recIdx].fillRule;
    if (fillRule != null) {
      if (fillRule == 2 || fillRule == 0 || fillRule == 3) useEvenOdd = true;
    }
  }
  if (useEvenOdd && pathRecords.length < 15e3 && subpathCount > 1) pathRecords = unitePathRecordsWithPaper(pathRecords);
  const flattened = flattenPathRecordsToPath(pathRecords);
  return {
    pathSvg: Typr.U.pathToSVG(toTyprPath(flattened), curveSteps),
    evenOddFill: useEvenOdd ? 1 : 0
  };
}
export function buildEdgeCostField(gray, width, height) {
  const scratchBuf = new ArrayBuffer(width * height * 16);
  const edgeCosts = computeEdgeWeights(gray, width, height, scratchBuf);
  const neighborOffsets = buildNeighborOffsets(width, height, scratchBuf);
  return {
    neighborOffsets: neighborOffsets,
    edgeCosts: edgeCosts
  }
}

export function initPathSearch(neighborOffsets, edgeCosts, seedIdx) {
  const pixelCount = Math.round(neighborOffsets.length / 8);
  const distance = new Uint32Array(pixelCount);
  const visited = new Uint8Array(pixelCount);
  const predecessor = new Uint32Array(pixelCount);
  fillBuffer(distance, 4294967295, 0);
  distance[seedIdx] = 0;
  const frontier = new PathData(pixelCount);
  frontier.push(seedIdx, distance[seedIdx]);
  return {
    neighborOffsets: neighborOffsets,
    edgeCosts: edgeCosts,
    distance: distance,
    visited: visited,
    predecessor: predecessor,
    frontier: frontier,
    seedIndex: seedIdx
  }
}

export function runDijkstra(searchState, goalIdx) {
  const neighborOffsets = searchState.neighborOffsets;
  const edgeCosts = searchState.edgeCosts;
  const distance = searchState.distance;
  const visited = searchState.visited;
  const predecessor = searchState.predecessor;
  const frontier = searchState.frontier;
  while (!frontier.isEmpty() && (goalIdx == null || visited[goalIdx] == 0)) {
    const current = frontier.pop();
    visited[current] = 1;
    for (let dir = 0; dir < 8; dir++) {
      const offset = neighborOffsets[8 * current + dir];
      const neighbor = current + offset;
      if (offset == 0 || visited[neighbor]) continue;
      const newDist = distance[current] + edgeCosts[8 * current + dir];
      if (frontier.contains(neighbor) && newDist < distance[neighbor]) frontier.remove(neighbor, distance[neighbor]);
      if (!frontier.contains(neighbor)) {
        distance[neighbor] = newDist;
        predecessor[neighbor] = current;
        frontier.push(neighbor, distance[neighbor])
      }
    }
  }
}

export function computeLaplacian(gray, width, height, scratchBytes) {
  const laplacian = new Int16Array(scratchBytes);
  for (let row = 0; row < height; row++)
    for (let col = 0; col < width; col++) {
      let off = row * width + col;
      let sum = 0;
      if (1 < col && col < width - 2 && 1 < row && row < height - 2) {
        sum += gray[off - width - width];
        sum += gray[off - width - 1] + 2 * gray[off - width] + gray[off - width + 1];
        sum += gray[off - 2] + 2 * gray[off - 1] - 16 * gray[off] + 2 * gray[off + 1] + gray[off + 2];
        sum += gray[off + width - 1] + 2 * gray[off + width] + gray[off + width + 1];
        sum += gray[off + width + width]
      } else sum = -16 * gray[off];
      laplacian[off] = sum
    }
  return laplacian
}

export function computeZeroCrossings(laplacian, width, height, threshold) {
  if (threshold == null) threshold = 128;
  const crossings = new Uint8Array(width * height);
  for (let row = 1; row < height - 1; row++)
    for (let col = 1; col < width - 1; col++) {
      let off = row * width + col;
      crossings[off] = isZeroCrossing(laplacian[off], laplacian[off - 1], laplacian[off + 1], laplacian[off - width], laplacian[off + width], threshold)
    }
  return crossings
}

export function isZeroCrossing(center, left, right, up, down, threshold) {
  const absCenter = Math.abs(center);
  return center * left < 0 && absCenter < Math.abs(left) && Math.abs(left - center) > threshold || center * right < 0 && absCenter < Math.abs(right) && Math.abs(right - center) > threshold || center * up < 0 && absCenter < Math.abs(up) && Math.abs(up - center) > threshold || center * down < 0 && absCenter < Math.abs(down) && Math.abs(down - center) > threshold ? 1 : 0
}

export function computeGradientField(gray, width, height, scratchBytes) {
  const gradient = new Float32Array(scratchBytes);
  let maxMag = 0;
  new Uint32Array(scratchBytes).fill(0);
  for (let row = 0; row < height; row++)
    for (let col = 0; col < width; col++) {
      let gradX = 0;
      let gradY = 0;
      let off = row * width + col;
      const gradOff = off * 3;
      if (0 < col && col < width - 1) gradX = gray[off + 1] - gray[off - 1];
      if (0 < row && row < height - 1) gradY = gray[off + width] - gray[off - width];
      const mag = gradient[gradOff + 2] = Math.sqrt(gradX * gradX + gradY * gradY);
      if (mag != 0) {
        const invMag = 1 / mag;
        gradient[gradOff] = gradX * invMag;
        gradient[gradOff + 1] = gradY * invMag
      }
      if (mag > maxMag) maxMag = mag
    }
  const pixelCount = width * height;
  const invMax = maxMag == 0 ? 0 : 1 / maxMag;
  for (let off = 0; off < pixelCount; off++) gradient[off * 3 + 2] = 1 - gradient[off * 3 + 2] * invMax;
  return gradient
}

export function angularCost(dirX, dirY, lut) {
  return lut[~~((.5 + .5 * dirX) * 255)] + lut[~~((.5 + .5 * dirY) * 255)]
}

export function computeEdgeWeights(gray, width, height, scratchBytes) {
  const laplacian = computeLaplacian(gray, width, height, scratchBytes);
  const crossings = computeZeroCrossings(laplacian, width, height);
  const gradient = computeGradientField(gray, width, height, scratchBytes);
  const angleLut = new Float32Array(256);
  for (let lutIdx = 0; lutIdx < 256; lutIdx++) angleLut[lutIdx] = Math.acos(-1 + 2 * lutIdx / 255) * (.95 / Math.PI);
  const dirX = [-1, 0, 1, 1, 1, 0, -1, -1];
  const dirY = [-1, -1, -1, 0, 1, 1, 1, 0];
  for (let dir = 0; dir < 8; dir++) {
    const invLen = 1 / Math.sqrt(dirX[dir] * dirX[dir] + dirY[dir] * dirY[dir]);
    dirX[dir] *= invLen;
    dirY[dir] *= invLen
  }
  const edgeDirs = [dirX[0], dirY[0], dirX[1], dirY[1], dirX[2], dirY[2], dirX[3], dirY[3]];
  const neighborOff = [-width - 1, -width, -width + 1, 1];
  const edgeCosts = new Uint8Array(width * height * 8);
  new Uint32Array(edgeCosts.buffer).fill(4294967295);
  for (let row = 1; row < height - 1; row++)
    for (let col = 1; col < width - 1; col++) {
      let off = row * width + col;
      const lapCost = 1 - crossings[off];
      const gradMag = gradient[off * 3 + 2];
      let gradY = gradient[3 * off + 1];
      let gradX = -gradient[3 * off];
      for (let dirIdx = 0; dirIdx < 4; dirIdx++) {
        const neighbor = off + neighborOff[dirIdx];
        computeEdgeWeight(off, neighbor, dirIdx, edgeCosts, crossings, gradient, lapCost, gradMag, gradY, gradX, edgeDirs, angleLut)
      }
    }
  return edgeCosts
}

export function computeEdgeWeight(fromOff, toOff, dirIdx, edgeCosts, crossings, gradient, lapCostFrom, gradMagFrom, gradYFrom, gradXFrom, edgeDirs, angleLut) {
  const lapCostTo = 1 - crossings[toOff];
  const diagScale = (dirIdx & 1) == 0 ? 1 : Math.SQRT1_2;
  const gradMagTo = gradient[toOff * 3 + 2] * diagScale;
  const gradYTo = gradient[3 * toOff + 1];
  const gradXTo = -gradient[3 * toOff];
  const gradMagFromScaled = gradMagFrom * diagScale;
  const edgeDirX = edgeDirs[dirIdx + dirIdx];
  const edgeDirY = edgeDirs[dirIdx + dirIdx + 1];
  let projFrom = gradYFrom * edgeDirX + gradXFrom * edgeDirY;
  let projTo = gradYTo * edgeDirX + gradXTo * edgeDirY;
  if (projFrom + projTo < 0) {
    projFrom = -projFrom;
    projTo = -projTo
  }
  const angleCost = angularCost(projFrom, projTo, angleLut);
  edgeCosts[(fromOff << 3) + dirIdx] = combineEdgeCosts(lapCostTo, angleCost, gradMagTo);
  edgeCosts[(toOff << 3) + dirIdx + 4] = combineEdgeCosts(lapCostFrom, angleCost, gradMagFromScaled)
}

export function combineEdgeCosts(lapCost, angleCost, gradCost) {
  return 1 + ~~(.5 + 20 * (.43 * lapCost + .43 * angleCost + .14 * gradCost))
}

export function buildNeighborOffsets(width, height, scratchBytes) {
  const offsets = new Int16Array(scratchBytes);
  const out = offsets;
  let pixelIdx = 0;
  let writeOff = 0;
  new Uint32Array(scratchBytes).fill(0);
  for (let row = 0; row < height; row++)
    for (let col = 0; col < width; col++) {
      if (row > 0 && col > 0) out[writeOff + 0] = -width - 1;
      if (row > 0) out[writeOff + 1] = -width;
      if (row > 0 && col < width - 1) out[writeOff + 2] = -width + 1;
      if (col < width - 1) out[writeOff + 3] = 1;
      if (row < height - 1 && col < width - 1) out[writeOff + 4] = width + 1;
      if (row < height - 1) out[writeOff + 5] = width;
      if (row < height - 1 && col > 0) out[writeOff + 6] = width - 1;
      if (col > 0) out[writeOff + 7] = -1;
      pixelIdx++;
      writeOff += 8
    }
  return offsets
}
export function applyChannelOp(baseChannel, otherChannel, combineMode) {
  let outRect;
  let combineFn;
  if (combineMode == "front") {
    outRect = baseChannel.rect.clone();
    combineFn = copyOp
  }
  if (combineMode == "union") {
    outRect = baseChannel.rect.union(otherChannel.rect);
    combineFn = union
  }
  if (combineMode == "difference") {
    outRect = otherChannel.rect.clone();
    combineFn = differenceOp
  }
  if (combineMode == "intersection") {
    outRect = baseChannel.rect.intersect(otherChannel.rect);
    combineFn = intersect
  }
  if (combineMode == "xor") {
    outRect = baseChannel.rect.union(otherChannel.rect);
    combineFn = xorOp
  }
  if (outRect.isEmpty()) return null;
  let otherBuf = allocBuffer(outRect.area());
  copyChannel(otherChannel.channel, otherChannel.rect, otherBuf, outRect);
  const baseBuf = allocBuffer(outRect.area());
  copyChannel(baseChannel.channel, baseChannel.rect, baseBuf, outRect);
  combineFn(baseBuf, otherBuf, otherBuf);
  const tightRect = contentBoundsChannel(otherBuf, outRect);
  if (tightRect.isEmpty()) return null;
  if (!tightRect.equals(outRect)) {
    const tightBuf = allocBuffer(tightRect.area());
    copyChannel(otherBuf, outRect, tightBuf, tightRect);
    otherBuf = tightBuf;
    outRect = tightRect
  }
  return {
    channel: otherBuf,
    rect: outRect
  }
}

export function copyOp(srcA, srcB, dest) {
  for (let i = 0; i < srcA.length; i++) dest[i] = srcA[i]
}

export function union(srcA, srcB, dest) {
  for (let i = 0; i < srcA.length; i++) dest[i] = Math.min(srcA[i] + srcB[i], 255)
}

export function differenceOp(srcA, srcB, dest) {
  for (let i = 0; i < srcA.length; i++) dest[i] = Math.max(srcB[i] - srcA[i], 0)
}

export function intersect(srcA, srcB, dest) {
  const inv255 = 1 / 255;
  for (let i = 0; i < srcA.length; i++) dest[i] = srcA[i] * srcB[i] * inv255
}

export function xorOp(srcA, srcB, dest) {
  const inv255 = 1 / 255;
  for (let i = 0; i < srcA.length; i++) dest[i] = Math.min(srcA[i] + srcB[i], 255) - srcA[i] * srcB[i] * inv255
}
