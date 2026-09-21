/**
 * Tone-curve utilities: CrPt descriptors, cubic spline segments, LUTs, and
 * preview rendering.
 */

import { Point } from '../../core/math/point.js';
import { makeElement } from "../../core/dom.js";
import { solveLinearSystem } from "./matrix-math.js";
import { zeroMatrix } from "./matrix-math.js";


export function createCurvePoint(horizontal, vertical, continuous) {
  return {
    t: "Objc",
    v: {
      classID: "CrPt",
      Hrzn: {
        t: "doub",
        v: horizontal
      },
      Vrtc: {
        t: "doub",
        v: vertical
      },
      Cnty: {
        t: "bool",
        v: continuous
      }
    }
  };
}

export function transformCurvePoints(curvePoints, matrix) {
  for (let i = 0; i < curvePoints.length; i++) {
    const knot = curvePoints[i].v;
    const mapped = matrix.transformPoint(new Point(knot.Hrzn.v, knot.Vrtc.v));
    knot.Hrzn.v = Math.round(mapped.x);
    knot.Vrtc.v = Math.round(mapped.y)
  }
}

export function computeSplineCoefficients(knotX, knotY, coeffsOut) {
  const segmentCount = knotX.length - 1;
  const system = zeroMatrix(segmentCount + 1, segmentCount + 2);
  for (let i = 1; i < segmentCount; i++) {
    system[i][i - 1] = 1 / (knotX[i] - knotX[i - 1]);
    system[i][i] = 2 * (1 / (knotX[i] - knotX[i - 1]) + 1 / (knotX[i + 1] - knotX[i]));
    system[i][i + 1] = 1 / (knotX[i + 1] - knotX[i]);
    system[i][segmentCount + 1] = 3 * ((knotY[i] - knotY[i - 1]) / ((knotX[i] - knotX[i - 1]) * (knotX[i] - knotX[i - 1])) +
      (knotY[i + 1] - knotY[i]) / ((knotX[i + 1] - knotX[i]) * (knotX[i + 1] - knotX[i])))
  }
  system[0][0] = 2 / (knotX[1] - knotX[0]);
  system[0][1] = 1 / (knotX[1] - knotX[0]);
  system[0][segmentCount + 1] = 3 * (knotY[1] - knotY[0]) / ((knotX[1] - knotX[0]) * (knotX[1] - knotX[0]));
  system[segmentCount][segmentCount - 1] = 1 / (knotX[segmentCount] - knotX[segmentCount - 1]);
  system[segmentCount][segmentCount] = 2 / (knotX[segmentCount] - knotX[segmentCount - 1]);
  system[segmentCount][segmentCount + 1] = 3 * (knotY[segmentCount] - knotY[segmentCount - 1]) /
    ((knotX[segmentCount] - knotX[segmentCount - 1]) * (knotX[segmentCount] - knotX[segmentCount - 1]));
  solveLinearSystem(system, coeffsOut)
}

/** First knot index whose X is >= sampleX (clamped past ends handled by callers). */
function findSegmentEndIndex(sampleX, knotX) {
  let seg = 1;
  while (knotX[seg] < sampleX) seg++;
  return seg;
}

export function evaluateSpline(sampleX, knotX, knotY, coeffs) {
  if (sampleX <= knotX[0]) return knotY[0];
  if (sampleX >= knotX[knotX.length - 1]) return knotY[knotY.length - 1];
  let seg = findSegmentEndIndex(sampleX, knotX);
  const segmentEndX = knotX[seg];
  const segmentStartX = knotX[seg - 1];
  const segmentEndY = knotY[seg];
  const segmentStartY = knotY[seg - 1];
  const t = (sampleX - segmentStartX) / (segmentEndX - segmentStartX);
  const startTangent = coeffs[seg - 1] * (segmentEndX - segmentStartX) - (segmentEndY - segmentStartY);
  const endTangent = -coeffs[seg] * (segmentEndX - segmentStartX) + (segmentEndY - segmentStartY);
  return (1 - t) * segmentStartY + t * segmentEndY + t * (1 - t) * (startTangent * (1 - t) + endTangent * t)
}

export function buildToneCurveSegments(knotX, knotY, continuity, segmentsOut) {
  let segment = {
    knotX: [knotX[0]],
    knotY: [knotY[0]],
    splineCoeffs: []
  };
  segmentsOut[0] = segment;
  let i = 1;
  for (; i < knotX.length - 1; i++) {
    segment.knotX.push(knotX[i]);
    segment.knotY.push(knotY[i]);
    if (continuity[i] == false) {
      computeSplineCoefficients(segment.knotX, segment.knotY, segment.splineCoeffs);
      segment = {
        knotX: [knotX[i]],
        knotY: [knotY[i]],
        splineCoeffs: []
      }
    }
    segmentsOut[i] = segment
  }
  segment.knotX.push(knotX[i]);
  segment.knotY.push(knotY[i]);
  computeSplineCoefficients(segment.knotX, segment.knotY, segment.splineCoeffs);
  segmentsOut[i] = segment
}

export function applyToneCurve(sampleX, knotX, knotY, segments) {
  if (sampleX <= knotX[0]) return knotY[0];
  if (sampleX >= knotX[knotX.length - 1]) return knotY[knotY.length - 1];
  let seg = findSegmentEndIndex(sampleX, knotX);
  const active = segments[seg - 1];
  return evaluateSpline(sampleX, active.knotX, active.knotY, active.splineCoeffs);
}

export function extractCurvePoints(curvePoints) {
  const extracted = {
    knotX: [],
    knotY: [],
    continuity: []
  };
  for (let i = 0; i < curvePoints.length; i++) {
    extracted.knotX[i] = curvePoints[i].v.Hrzn.v;
    extracted.knotY[i] = curvePoints[i].v.Vrtc.v;
    extracted.continuity[i] = curvePoints[i].v.Cnty ? curvePoints[i].v.Cnty.v : true
  }
  return extracted
}

export function buildToneCurveLut(curvePoints, lutSize, unclamped) {
  let minVal = 0;
  let maxVal = 255;
  if (unclamped) {
    minVal = -1e9;
    maxVal = 1e9
  }
  const knots = extractCurvePoints(curvePoints);
  const segments = [];
  buildToneCurveSegments(knots.knotX, knots.knotY, knots.continuity, segments);
  const lut = [];
  for (let i = 0; i < lutSize; i++) {
    lut[i] = 1 / 255 * Math.max(minVal, Math.min(maxVal,
      applyToneCurve(i * (255 / (lutSize - 1)), knots.knotX, knots.knotY, segments)));
  }
  return lut
}

export function padCurveLut(lut, targetLength, padStart) {
  const padCount = Math.round(lut.length / 20);
  const missing = targetLength - lut.length;
  const slope = padStart ? (lut[padCount] - lut[0]) / padCount : 0;
  const edge = padStart ? lut[0] - missing * slope : lut[lut.length - 1];
  const extension = [];
  for (let i = 0; i < missing; i++) extension.push(edge + i * slope);
  return padStart ? extension.concat(lut) : lut.concat(extension)
}

export function buildCurveTable(curvePoints, tableSize, softenHighlights) {
  const knots = extractCurvePoints(curvePoints);
  const segments = [];
  buildToneCurveSegments(knots.knotX, knots.knotY, knots.continuity, segments);
  const table = new Uint8Array(tableSize);
  const xScale = tableSize / 256;
  for (let i = 0; i < tableSize; i++) {
    table[i] = Math.max(0, Math.min(tableSize - 1,
      applyToneCurve(i * xScale, knots.knotX, knots.knotY, segments)));
  }
  if (softenHighlights) {
    table[0] = 0;
    if (table[1] > 100) table[1] = .4 * table[1];
    if (table[2] > 150) table[1] = .7 * table[2]
  }
  return table
}

export function applyLutToChannel(channel, lut) {
  const mapped = new Uint8Array(channel.length);
  for (let i = 0; i < channel.length; i++) mapped[i] = lut[channel[i]];
  return mapped
}

export function renderCurvePreview(curvePoints, width, height) {
  const canvas = makeElement("canvas", "");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const curveTable = buildCurveTable(curvePoints, 256);
  ctx.scale(width / 255, height / 255);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 255, 255);
  ctx.fillStyle = "#333";
  ctx.beginPath();
  ctx.moveTo(0, 255);
  for (let i = 0; i < curveTable.length; i++) ctx.lineTo(i, 255 - curveTable[i]);
  ctx.lineTo(255, 255);
  ctx.closePath();
  ctx.fill();
  return canvas.toDataURL()
}

