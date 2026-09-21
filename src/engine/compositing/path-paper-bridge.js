/**
 * Paper.js setup and import/export for vector path records on selectionUtils.
 */

/* global paper */

import { Point } from '../../core/math/point.js';
import { makeElement } from "../../core/dom.js";
import { CLOSED_SUBPATH_TYPE, MERGE_OPS_BY_FILL_RULE, OPEN_SUBPATH_TYPE, SKIP_RECORD_TYPE_MIN, usesCompoundFill } from "./path-records.js";

const CLOSE_POINT_EPS = 1e-5;
const AREA_EPS = 1e-5;
const PREVIEW_FILL_RGB = [1, 0, 0];

function knotFromPaperSegment(seg, knotType) {
  const handleIn = new Point(seg.handleIn.x, seg.handleIn.y);
  const handleOut = new Point(seg.handleOut.x, seg.handleOut.y);
  const anchor = new Point(seg.point.x, seg.point.y);
  return {
    type: knotType,
    cp1: anchor.add(handleIn),
    anchor: anchor,
    anchorOut: anchor.add(handleOut),
  };
}

/**
 * Drop a duplicate closing knot and, for open→closed promotion, rewrite knot types.
 */
function collapseClosingDuplicateKnot(pathRecords, headerIdx, firstKnot, lastKnot, subpathType) {
  if (Point.dist(firstKnot.anchor, lastKnot.anchor) >= CLOSE_POINT_EPS) {
    return;
  }
  pathRecords.pop();
  pathRecords[headerIdx].length--;
  firstKnot.cp1 = lastKnot.cp1;
  if (subpathType == OPEN_SUBPATH_TYPE) {
    for (let fixIdx = headerIdx; fixIdx < pathRecords.length; fixIdx++) {
      pathRecords[fixIdx].type -= OPEN_SUBPATH_TYPE;
    }
  }
}

function appendPaperItemToPathRecords(pathRecords, item) {
  const segments = item.segments;
  const subpathType = item.closed ? CLOSED_SUBPATH_TYPE : OPEN_SUBPATH_TYPE;
  const headerIdx = pathRecords.length;
  let firstKnot = null;
  if (segments.length <= 1) {
    return;
  }
  pathRecords.push({
    type: subpathType,
    length: segments.length,
    fillRule: 0,
    subpathHeaderFlags: 2,
  });
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const knot = knotFromPaperSegment(segments[segIdx], subpathType + 1);
    if (firstKnot == null) {
      firstKnot = knot;
    }
    pathRecords.push(knot);
    if (segIdx + 1 == segments.length) {
      collapseClosingDuplicateKnot(pathRecords, headerIdx, firstKnot, knot, subpathType);
    }
  }
}

function buildPaperSegmentDataFromKnots(pathRecords, headerIdx, knotCount) {
  const segmentData = [];
  for (let knotOff = 0; knotOff < knotCount; knotOff++) {
    const knot = pathRecords[headerIdx + 1 + knotOff];
    const inDelta = knot.cp1.subtract(knot.anchor);
    const outDelta = knot.anchorOut.subtract(knot.anchor);
    segmentData.push([
      [knot.anchor.x, knot.anchor.y],
      [inDelta.x, inDelta.y],
      [outDelta.x, outDelta.y],
    ]);
  }
  return segmentData;
}

function resolveMergeOp(pathRecords, recIdx) {
  if (recIdx == 2) {
    return usesCompoundFill(pathRecords) ? 'unite' : 'subtract';
  }
  return MERGE_OPS_BY_FILL_RULE[pathRecords[recIdx].fillRule];
}

function preparePaperPath(paperPath, openSubpath) {
  paperPath.remove();
  paperPath.closed = !openSubpath;
  paperPath.fillRule = 'evenodd';
}

function mergePaperPathPairs(paperPairs) {
  let mergedPath = null;
  const orphanPaths = [];
  for (let pairIdx = 0; pairIdx < paperPairs.length; pairIdx++) {
    const paperPath = paperPairs[pairIdx][0];
    const mergeOp = paperPairs[pairIdx][1];
    if (Math.abs(paperPath.area) < AREA_EPS) {
      orphanPaths.push(paperPath);
    } else if (mergedPath == null) {
      mergedPath = paperPath;
    } else {
      if (!paperPath.closed) {
        paperPath.closed = true;
      }
      mergedPath = mergedPath[mergeOp](paperPath);
      mergedPath.remove();
    }
  }
  if (mergedPath == null) {
    mergedPath = new paper.CompoundPath(orphanPaths);
  } else {
    if (mergedPath.segments) {
      mergedPath = new paper.CompoundPath(mergedPath);
    }
    for (let orphanIdx = 0; orphanIdx < orphanPaths.length; orphanIdx++) {
      mergedPath.addChild(orphanPaths[orphanIdx]);
    }
  }
  return mergedPath;
}

export /** Paper.js is set up once, lazily: it needs a canvas, so not at import. */
let paperJsReady = null;

export function ensurePaperJs() {
  if (paperJsReady == null) {
    const scratchCanvas = makeElement('canvas');
    paper.setup(scratchCanvas);
    paperJsReady = true;
  }
}

export function paperItemToPathRecords(paperItem) {
  const items = paperItem.segments ? [paperItem] : paperItem.children;
  const pathRecords = [];
  for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
    appendPaperItemToPathRecords(pathRecords, items[itemIdx]);
  }
  return pathRecords;
}

export function pathRecordsToPaperPaths(pathRecords) {
  ensurePaperJs();
  const pairs = [];
  let compoundPath;
  const previewFill = new paper.Color(PREVIEW_FILL_RGB[0], PREVIEW_FILL_RGB[1], PREVIEW_FILL_RGB[2]);

  for (let recIdx = 0; recIdx < pathRecords.length; recIdx++) {
    if (pathRecords[recIdx].type > SKIP_RECORD_TYPE_MIN - 1) {
      continue;
    }
    const knotCount = pathRecords[recIdx].length;
    if (recIdx == pathRecords.length - 1) {
      break;
    }
    const openSubpath = pathRecords[recIdx].type == OPEN_SUBPATH_TYPE;
    const mergeOp = resolveMergeOp(pathRecords, recIdx);
    if (pathRecords[recIdx].fillRule != -1) {
      compoundPath = new paper.CompoundPath();
      pairs.push([compoundPath, mergeOp]);
      compoundPath.fillRule = 'evenodd';
      compoundPath.fillColor = previewFill;
    }
    const segmentData = buildPaperSegmentDataFromKnots(pathRecords, recIdx, knotCount);
    const subpath = new paper.Path(segmentData);
    preparePaperPath(subpath, openSubpath);
    compoundPath.addChild(subpath);
    recIdx += knotCount;
  }
  return pairs;
}

export function unitePathRecordsWithPaper(pathRecords) {
  ensurePaperJs();
  const paperPairs = pathRecordsToPaperPaths(pathRecords);
  const mergedPath = mergePaperPathPairs(paperPairs);
  let rebuilt = pathRecords.slice(0, 2);
  rebuilt = rebuilt.concat(paperItemToPathRecords(mergedPath));
  if (rebuilt[2]) {
    rebuilt[2].fillRule = 1;
  }
  for (let recIdx = 3; recIdx < rebuilt.length; recIdx++) {
    if (rebuilt[recIdx].fillRule != null) {
      rebuilt[recIdx].fillRule = -1;
    }
  }
  return rebuilt;
}

export function subpathIndicesIntersectingRect(pathRecords, queryRect) {
  ensurePaperJs();
  const hitSubpaths = [];
  const paperPairs = pathRecordsToPaperPaths(pathRecords);
  const queryPath = new paper.Path.Rectangle(
    new paper.Rectangle(queryRect.x, queryRect.y, queryRect.width, queryRect.height),
  );
  queryPath.remove();
  queryPath.fillColor = new paper.Color(PREVIEW_FILL_RGB[0], PREVIEW_FILL_RGB[1], PREVIEW_FILL_RGB[2]);
  for (let pairIdx = 0; pairIdx < paperPairs.length; pairIdx++) {
    if (
      queryPath.intersects(paperPairs[pairIdx][0]) ||
      queryPath.contains(paperPairs[pairIdx][0].children[0].segments[0].point)
    ) {
      hitSubpaths.push(pairIdx);
    }
  }
  return hitSubpaths;
}
