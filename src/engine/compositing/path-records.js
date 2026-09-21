import { Point } from '../../core/math/point.js';
import { strokeOffsetRoundCorners, transformCoordPairs } from './anti-alias.js';

/**
 * The shape of a PSD vector path: how its records divide into subpaths, and
 * which fill rule each carries.
 *
 * A path is a flat record list. Record 0 and 1 are headers; each subpath opens
 * with a header record giving its knot count and fill rule, followed by that
 * many knot records. Everything that walks a path — the selection maths, the
 * paper.js bridge, the shape builders — agrees on this structure here.
 */

/** A subpath header that leaves the path open rather than closing it. */
export const OPEN_SUBPATH_TYPE = 3;
/** A subpath header that closes its loop. */
export const CLOSED_SUBPATH_TYPE = 0;
/** Records at or above this type carry no geometry. */
export const SKIP_RECORD_TYPE_MIN = 6;
/** Paper.js boolean op for each fill rule, by rule index. */
export const MERGE_OPS_BY_FILL_RULE = ['exclude', 'unite', 'subtract', 'intersect'];

export function countSubpaths(pathRecords) {
  let count = -1;
  for (let recIdx = 0; recIdx < pathRecords.length; recIdx++) {
    if ((pathRecords[recIdx].type == 0 || pathRecords[recIdx].type == 3) && pathRecords[recIdx].fillRule != -1) {
      count++;
    }
  }
  return count + 1;
}
export function recordIndexForSubpath(pathRecords, subpathIndex, includeOpenSubpaths) {
  let seen = -1;
  for (let recIdx = 0; recIdx < pathRecords.length; recIdx++) {
    if ((pathRecords[recIdx].type == 0 || pathRecords[recIdx].type == 3) &&
        (includeOpenSubpaths || pathRecords[recIdx].fillRule != -1)) {
      seen++;
      if (seen == subpathIndex) return recIdx;
    }
  }
  return -1;
}
export function subpathIndexForRecord(pathRecords, recordIndex, includeOpenSubpaths) {
  let subpathIndex = -1;
  for (let recIdx = 0; recIdx < pathRecords.length; recIdx++) {
    if ((pathRecords[recIdx].type == 0 || pathRecords[recIdx].type == 3) &&
        (includeOpenSubpaths || pathRecords[recIdx].fillRule != -1)) {
      if (recIdx >= recordIndex) return subpathIndex;
      subpathIndex++;
    }
  }
  return subpathIndex;
}
export function knotCountInSubpath(pathRecords, subpathIndex) {
  let currentSubpath = -1;
  let knotCount = 0;
  for (let recIdx = 0; recIdx < pathRecords.length; recIdx++) {
    if ((pathRecords[recIdx].type == 0 || pathRecords[recIdx].type == 3) && pathRecords[recIdx].fillRule != -1) {
      currentSubpath++;
    }
    if (currentSubpath == subpathIndex) knotCount++;
  }
  return knotCount;
}
export function lastSubpathHeaderRecord(pathRecords) {
  let lastHeaderIdx = 0;
  for (let recIdx = 0; recIdx < pathRecords.length; recIdx++) {
    if (pathRecords[recIdx].type == 0 || pathRecords[recIdx].type == 3) lastHeaderIdx = recIdx;
  }
  return pathRecords[lastHeaderIdx];
}
export function usesEvenOddFill(pathRecords) {
  const firstSubpath = pathRecords[2];
  let evenOdd = false;
  if (pathRecords.length == 2) evenOdd = pathRecords[1].all == 0;
  else if (pathRecords[1].all == 1) {
    evenOdd = firstSubpath.fillRule == 1 || firstSubpath.fillRule == 3;
  } else {
    evenOdd = firstSubpath.fillRule == 1 || firstSubpath.fillRule == 3 || firstSubpath.fillRule == 0;
  }
  return evenOdd;
}
export function usesCompoundFill(pathRecords) {
  let compound = usesEvenOddFill(pathRecords);
  for (let recIdx = 3; recIdx < pathRecords.length; recIdx++) {
    if (pathRecords[recIdx].fillRule == 3) compound = true;
  }
  return compound;
}

export function flattenPathKnotCoords(pathRecords, subpathFilter, recordFilter) {
  const flatCoords = [];
  let subpathIndex = -1;
  for (let recIdx = 0; recIdx < pathRecords.length; recIdx++) {
    let record = pathRecords[recIdx];
    if ((record.type == 0 || record.type == 3) && record.fillRule != -1) subpathIndex++;
    if (record.type > 5 || record.type == 0 || record.type == 3) continue;
    if (subpathFilter != null && subpathFilter.indexOf(subpathIndex) == -1) continue;
    if (recordFilter != null && recordFilter.indexOf(recIdx) == -1) continue;
    flatCoords.push(record.cp1.x);
    flatCoords.push(record.cp1.y);
    flatCoords.push(record.anchor.x);
    flatCoords.push(record.anchor.y);
    flatCoords.push(record.anchorOut.x);
    flatCoords.push(record.anchorOut.y);
  }
  return flatCoords;
}
export function writeFlatCoordsToPathRecords(flatCoords, pathRecords, subpathFilter, recordFilter) {
  let coordIdx = 0;
  let subpathIndex = -1;
  for (let recIdx = 0; recIdx < pathRecords.length; recIdx++) {
    let record = pathRecords[recIdx];
    if ((record.type == 0 || record.type == 3) && record.fillRule != -1) subpathIndex++;
    if (record.type > 5 || record.type == 0 || record.type == 3) continue;
    if (subpathFilter != null && subpathFilter.indexOf(subpathIndex) == -1) continue;
    if (recordFilter != null && recordFilter.indexOf(recIdx) == -1) continue;
    record.cp1.setXY(flatCoords[coordIdx], flatCoords[coordIdx + 1]);
    record.anchor.setXY(flatCoords[coordIdx + 2], flatCoords[coordIdx + 3]);
    record.anchorOut.setXY(flatCoords[coordIdx + 4], flatCoords[coordIdx + 5]);
    coordIdx += 6;
  }
}
export function allSegmentKnotsAreStraight(pathRecords) {
  for (let recIdx = 0; recIdx < pathRecords.length; recIdx++) {
    let record = pathRecords[recIdx];
    const recordType = record.type;
    if (recordType == 1 || recordType == 2 || recordType == 4 || recordType == 5) {
      if (!record.anchor.equals(record.cp1) || !record.anchor.equals(record.anchorOut)) return false;
    }
  }
  return true;
}
export function isOrthogonalQuadPath(pathRecords) {
  if (pathRecords.length != 7 || !allSegmentKnotsAreStraight(pathRecords)) return false;
  for (let startCorner = 0; startCorner < 4; startCorner++) {
    let isAxisAligned = true;
    for (let edgeIdx = 0; edgeIdx < 4; edgeIdx++) {
      const knotA = pathRecords[3 + (startCorner + edgeIdx & 3)];
      const knotB = pathRecords[3 + (startCorner + edgeIdx + 1 & 3)];
      if (knotA.anchor.x != knotB.anchor.x && knotA.anchor.y != knotB.anchor.y) isAxisAligned = false;
    }
    if (isAxisAligned) return true;
  }
  return false;
}

export function polylineCoordsToKnots(flatCoords, cornerRadii, closedLoop) {
  const knots = [];
  const knotType = closedLoop ? 4 : 1;
  let hasCornerRadii = false;
  if (cornerRadii != null) {
    for (let radiiIdx = 0; radiiIdx < cornerRadii.length; radiiIdx++) {
      if (cornerRadii[radiiIdx] != 0) {
        hasCornerRadii = true;
        break;
      }
    }
  }
  if (cornerRadii != null && hasCornerRadii) {
    const rounded = strokeOffsetRoundCorners(flatCoords, cornerRadii);
    const cornerCount = rounded.length / 6;
    for (let cornerIdx = 0; cornerIdx < cornerCount; cornerIdx++) {
      const flatOff = cornerIdx * 6;
      const prevOff = (cornerIdx - 1 + cornerCount) % cornerCount * 6;
      knots.push({
        type: knotType,
        cp1: new Point(rounded[prevOff + 4], rounded[prevOff + 5]),
        anchor: new Point(rounded[flatOff], rounded[flatOff + 1]),
        anchorOut: new Point(rounded[flatOff + 2], rounded[flatOff + 3])
      });
    }
  } else {
    for (let coordIdx = 0; coordIdx < flatCoords.length; coordIdx += 2) {
      const pt = new Point(flatCoords[coordIdx], flatCoords[coordIdx + 1]);
      knots.push({
        type: knotType,
        cp1: pt.clone(),
        anchor: pt.clone(),
        anchorOut: pt.clone()
      });
    }
  }
  return knots;
}

export function transformPathRecordCoords(pathRecords, matrix, subpathFilter, recordFilter) {
  const flatCoords = flattenPathKnotCoords(pathRecords, subpathFilter, recordFilter);
  transformCoordPairs(flatCoords, matrix, flatCoords);
  writeFlatCoordsToPathRecords(flatCoords, pathRecords, subpathFilter, recordFilter);
}
