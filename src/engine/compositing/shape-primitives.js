/**
 * Built-in vector shapes as path-record arrays (rect, ellipse, polygon, star,
 * line/arrow, pie, starburst).
 */

import { Point } from '../../core/math/point.js';
import { Matrix2D } from '../../core/math/matrix2d.js';
import { transformCoordPairs } from "./anti-alias.js";
import { polylineCoordsToKnots, transformPathRecordCoords } from "./path-records.js";


/** Cubic bezier kappa approximating a quarter-circle. */
const CIRCLE_BEZIER_KAPPA = .553;

/** Shared PSD-style path preamble: type-6 / type-8 headers. */
function emptyPathPreamble() {
  return [{
    type: 6
  }, {
    type: 8,
    all: 0
  }];
}

function closedSubpathHeader(knotCount) {
  return {
    type: 0,
    fillRule: 1,
    length: knotCount,
    subpathUint32A: 0,
    subpathUint32B: 0,
    subpathHeaderFlags: 1
  };
}

function openSubpathHeader(knotCount) {
  return {
    type: 3,
    fillRule: 1,
    length: knotCount,
    subpathUint32A: 0,
    subpathUint32B: 0,
    subpathHeaderFlags: 1
  };
}

/** Expand a scalar corner radius to one entry per vertex, or pass an array through. */
function normalizeCornerRadii(flatCoords, cornerRadii) {
  // No radius means square corners. An omitted argument has to land here too:
  // spreading it would give one undefined radius per corner, and the rounding
  // maths then collapses the whole outline onto the origin.
  if (cornerRadii == null || cornerRadii == 0) return null;
  if (cornerRadii instanceof Array) return cornerRadii;
  const radii = [];
  for (let coordIdx = 0; coordIdx < flatCoords.length; coordIdx += 2) radii.push(cornerRadii);
  return radii;
}

export function polygonFromFlatCoords(flatCoords, cornerRadii, closedLoop) {
  let pathRecords = emptyPathPreamble();
  // closedLoop true → open-subpath header type 3; false → closed type 0 (call-site contract).
  pathRecords.push({
    type: closedLoop ? 3 : 0,
    fillRule: 1,
    length: 0,
    subpathUint32A: 0,
    subpathUint32B: 0,
    subpathHeaderFlags: 1
  });
  const radii = normalizeCornerRadii(flatCoords, cornerRadii);
  pathRecords = pathRecords.concat(polylineCoordsToKnots(flatCoords, radii, closedLoop));
  pathRecords[2].length = pathRecords.length - 3;
  return pathRecords;
}

export function starBurstPathRecords(centerX, centerY, radius, startAngle, pointCount) {
  let knots = [];
  const mirrorKnots = [];
  const bezierK = CIRCLE_BEZIER_KAPPA;
  let traceX = 1;
  let traceY = -1;
  knots.push({
    type: 1,
    cp1: new Point(0, bezierK),
    anchor: new Point(0, 0),
    anchorOut: new Point(0, -bezierK)
  });
  pointCount += 2;
  for (let pointIdx = 0; pointIdx < pointCount; pointIdx++) {
    const knot = {
      type: 1
    };
    if (pointIdx == 0) {
      knot.anchor = new Point(1, -1);
      knot.cp1 = new Point(1 - bezierK, -1);
      knot.anchorOut = new Point(1 + bezierK, -1);
    } else {
      const angle = -(pointIdx + 2) * Math.PI / 2;
      let step = 1 + ((pointIdx & 1) == 1 ? pointIdx - 1 : pointIdx);
      const sinA = Math.sin(angle);
      const cosA = Math.cos(angle);
      traceX += step * (sinA - cosA);
      traceY += step * (cosA + sinA);
      knot.anchor = new Point(traceX, traceY);
      knot.cp1 = new Point(traceX + step * cosA * bezierK, traceY - step * sinA * bezierK);
      if ((pointIdx & 1) == 1) step += 2;
      knot.anchorOut = new Point(traceX - step * cosA * bezierK, traceY + step * sinA * bezierK);
    }
    const mirrored = {
      type: 1,
      cp1: new Point(-knot.anchorOut.x, -knot.anchorOut.y),
      anchor: new Point(-knot.anchor.x, -knot.anchor.y),
      anchorOut: new Point(-knot.cp1.x, -knot.cp1.y)
    };
    knots.push(knot);
    if (pointIdx < pointCount - 2) mirrorKnots.push(mirrored);
  }
  mirrorKnots.reverse();
  knots = knots.concat(mirrorKnots);
  let pathRecords = emptyPathPreamble();
  pathRecords.push(closedSubpathHeader(knots.length));
  pathRecords = pathRecords.concat(knots);
  const matrix = new Matrix2D(radius / pointCount, 0, 0, radius / pointCount, 0, 0);
  matrix.rotate(startAngle);
  matrix.translate(centerX, centerY);
  transformPathRecordCoords(pathRecords, matrix);
  return pathRecords;
}

export function rectanglePathRecords(x, y, width, height, cornerRadii) {
  let flat = [x, y, x + width, y, x + width, y + height, x, y + height];
  return polygonFromFlatCoords(flat, cornerRadii);
}

export function regularPolygonPathRecords(centerX, centerY, radius, startAngle, sides, cornerRadii) {
  let flat = [];
  const angleStep = 2 * Math.PI / sides;
  for (let sideIdx = 0; sideIdx < sides; sideIdx++) {
    flat.push(Math.cos(sideIdx * angleStep), Math.sin(sideIdx * angleStep));
  }
  const matrix = new Matrix2D(radius, 0, 0, radius, 0, 0);
  matrix.rotate(startAngle);
  matrix.translate(centerX, centerY);
  transformCoordPairs(flat, matrix, flat);
  return polygonFromFlatCoords(flat, cornerRadii);
}

export function starPathRecords(centerX, centerY, outerRadius, startAngle, points, cornerRadii, innerRadiusFactor) {
  let flat = [];
  const wedgeAngle = Math.PI / points;
  for (let pointIdx = 0; pointIdx < points * 2; pointIdx++) {
    const radiusScale = (pointIdx & 1) == 0 ? 1 : innerRadiusFactor;
    flat.push(radiusScale * Math.cos(pointIdx * wedgeAngle), radiusScale * Math.sin(pointIdx * wedgeAngle));
  }
  const matrix = new Matrix2D(outerRadius, 0, 0, outerRadius, 0, 0);
  matrix.rotate(startAngle);
  matrix.translate(centerX, centerY);
  transformCoordPairs(flat, matrix, flat);
  return polygonFromFlatCoords(flat, cornerRadii);
}

export function linePathRecords(startX, startY, endX, endY, strokeWidth) {
  return lineOrArrowFlatCoords(0, startX, startY, endX, endY, strokeWidth);
}

export function arrowPathRecords(startX, startY, endX, endY, strokeWidth, headScale) {
  return lineOrArrowFlatCoords(1, startX, startY, endX, endY, strokeWidth, headScale);
}

/**
 * Build a stroked line (style 0) or arrow (style 1) as a closed polygon outline.
 */
export function lineOrArrowFlatCoords(style, startX, startY, endX, endY, strokeWidth, headScale) {
  const length = Math.sqrt((endX - startX) * (endX - startX) + (endY - startY) * (endY - startY));
  let flat;
  strokeWidth /= 2;
  if (style == 0) flat = [-strokeWidth, 0, strokeWidth, 0, strokeWidth, length, -strokeWidth, length];
  else {
    const headLen = strokeWidth * 2 * headScale * 1.3 / 1.5;
    const headHalf = strokeWidth * headScale;
    flat = [-strokeWidth, 0, strokeWidth, 0, strokeWidth, length - headLen, headHalf, length - headLen, 0, length, -headHalf, length - headLen, -strokeWidth, length - headLen];
  }
  const matrix = new Matrix2D(1, 0, 0, 1, 0, 0);
  matrix.rotate(Math.atan2(-endY + startY, endX - startX) + Math.PI / 2);
  matrix.translate(startX, startY);
  transformCoordPairs(flat, matrix, flat);
  return polygonFromFlatCoords(flat, 0);
}

export function ellipsePathRecords(x, y, width, height) {
  let pathRecords = emptyPathPreamble();
  const kappa = CIRCLE_BEZIER_KAPPA;
  pathRecords.push(closedSubpathHeader(4));
  const left = x;
  const top = y;
  const right = x + width;
  const bottom = y + height;
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const radiusX = (left - right) / 2;
  const radiusY = (top - bottom) / 2;
  pathRecords.push({
    type: 1,
    cp1: new Point(centerX - kappa * radiusX, centerY - radiusY),
    anchor: new Point(centerX, centerY - radiusY),
    anchorOut: new Point(centerX + kappa * radiusX, centerY - radiusY)
  });
  pathRecords.push({
    type: 1,
    cp1: new Point(centerX + radiusX, centerY - kappa * radiusY),
    anchor: new Point(centerX + radiusX, centerY),
    anchorOut: new Point(centerX + radiusX, centerY + kappa * radiusY)
  });
  pathRecords.push({
    type: 1,
    cp1: new Point(centerX + kappa * radiusX, centerY + radiusY),
    anchor: new Point(centerX, centerY + radiusY),
    anchorOut: new Point(centerX - kappa * radiusX, centerY + radiusY)
  });
  pathRecords.push({
    type: 1,
    cp1: new Point(centerX - radiusX, centerY + kappa * radiusY),
    anchor: new Point(centerX - radiusX, centerY),
    anchorOut: new Point(centerX - radiusX, centerY - kappa * radiusY)
  });
  return pathRecords;
}

export function pieSlicePathRecords(centerX, centerY, radius, startAngle, endAngle) {
  let pathRecords = emptyPathPreamble();
  pathRecords.push(openSubpathHeader(5));
  const wedgeStep = (endAngle - startAngle) / 4;
  for (let wedgeIdx = 0; wedgeIdx < 5; wedgeIdx++) {
    const angle = wedgeIdx * wedgeStep;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const handleScale = CIRCLE_BEZIER_KAPPA * (wedgeStep / (Math.PI / 2));
    const handleSin = sinA * handleScale;
    const handleCos = -cosA * handleScale;
    const anchor = new Point(cosA, sinA);
    pathRecords.push({
      type: 4,
      cp1: wedgeIdx == 0 ? anchor.clone() : new Point(cosA + handleSin, sinA + handleCos),
      anchor: anchor,
      anchorOut: wedgeIdx == 4 ? anchor.clone() : new Point(cosA - handleSin, sinA - handleCos)
    });
  }
  const matrix = new Matrix2D;
  matrix.rotate(-startAngle);
  matrix.scale(radius, radius);
  matrix.translate(centerX, centerY);
  transformPathRecordCoords(pathRecords, matrix);
  return pathRecords;
}

