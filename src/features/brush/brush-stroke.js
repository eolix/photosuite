// Brush-stroke engine: brush stamp construction, stroke plotting with pressure
// dynamics and spacing, plus brush-preset preview and cursor-glyph rendering.
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";

import { FilterDefs } from "../filters/filter-registry.js";
import { getDevicePixelRatio, makeElement } from "../../core/dom.js";
import { TransformToolBase } from "../../document/transform/transform-static.js";
import { transformPixels } from "../../document/render/raster-transform.js";
import { allocBuffer, buildMipPyramidBox, copyBuffer, extractChannel, extractChannelByte, fillBuffer } from "../../engine/compositing/buffer-utils.js";
import { copyChannel, copyPixels, isBufferUniform, traceChannelBoundary } from "../../engine/compositing/pixel-ops.js";
import { compositeNormalDithered, compositeNormalDitheredClipped } from "../../engine/compositing/compositing-ops.js";
import { hsvToRgb, rgbToHsv } from "../../engine/compositing/color-math.js";
import { boxBlurRgbaInPlace } from "../../engine/compositing/blur.js";
import { convolveChannel3x3, convolveRGBA, normalizeKernel } from "../../engine/compositing/spatial-filters.js";

/**
 * Paint a pressure-aware brush stroke into a pixel buffer.
 */
function BrushStroke(brushDescriptor, samples, patterns, strokeSettings, fgColor, bgColor, bufferRect, scratchBuffer) {
  this.samples = samples;
  this.patterns = patterns;
  this.bgColor = bgColor;
  this.strokeSettings = strokeSettings;
  if (strokeSettings.pressureDynamics == null) strokeSettings.pressureDynamics = [false, true];
  this.startPt = null;
  this.lastPt = null;
  this.lastPressure = 0;
  this.spacingRemainder = 0;
  this.prevSpacingSize = 0;
  this.lastSmearPt = 0;
  this.randSeed = 0;
  this.bufferRect = bufferRect;
  this.dirtyBounds = new Rect;
  this.segmentBounds = new Rect;
  if (scratchBuffer != null) {
    this.pixelBuffer = scratchBuffer
  } else {
    let sharedScratch = BrushStroke.scratchBuffer;
    if (sharedScratch.length != bufferRect.area() * 4) sharedScratch = allocBuffer(bufferRect.area() * 4);
    else sharedScratch.fill(0);
    this.pixelBuffer = BrushStroke.scratchBuffer = sharedScratch
  }
  this.rect = bufferRect.clone();
  this.strokePoints = [];
  this.strokePressures = [];
  this.cursorPos = null;
  this.colorInt = 0;
  this.brushDescriptor = null;
  this.brushCacheKey = "";
  this.brushShape = null;
  this.initBrushState(brushDescriptor, fgColor)
}
BrushStroke.scratchBuffer = allocBuffer(16);
BrushStroke.prototype.initBrushState = function(brushDescriptor, fgColor) {
  this.colorInt = fgColor;
  this.brushDescriptor = brushDescriptor;
  this.brushCacheKey = JSON.stringify(brushDescriptor) + JSON.stringify(this.strokeSettings.pixelSnap);
  this.brushShape = BrushStroke.buildBrushShape(brushDescriptor, this.samples, this.patterns)
};
BrushStroke.prototype.moveTo = function(x, y, pressure) {
  pressure = this.normalizePressure(pressure);
  this.lastPressure = pressure;
  const point = new Point(x, y);
  const brushDiameter = this.brushDescriptor.Brsh.v.diameter.v.val;
  this.startPt = point.clone();
  this.lastPt = point.clone();
  this.cursorPos = point.clone();
  this.strokePoints = [x, y];
  this.strokePressures = [pressure];
  const pressureDynamics = this.strokeSettings.pressureDynamics;
  if (this.strokeSettings.brushMode != BrushStroke.MODE_PENCIL) this.expandBounds(this.stampBrush(point, this.getDiameter() * (pressureDynamics[1] ? pressure : 1), this.strokeSettings.opacity * (pressureDynamics[0] ? pressure * .5 : 1), new Point(0, 0)));
  this.lastSmearPt = point.clone()
};
BrushStroke.prototype.lineTo = function(x, y, pressure) {
  pressure = this.normalizePressure(pressure);
  const strokePoints = this.strokePoints;
  let pointCount = strokePoints.length;
  const prevX = strokePoints[pointCount - 2];
  const prevY = strokePoints[pointCount - 1];
  if (x == prevX && y == prevY) return;
  const brushDiameter = this.brushDescriptor.Brsh.v.diameter.v.val;
  const padRadius = Math.ceil(brushDiameter) + 1;
  const prevBounds = new Rect(Math.round(prevX), Math.round(prevY), 0, 0);
  prevBounds.inflate(padRadius, padRadius);
  const nextBounds = new Rect(Math.round(x), Math.round(y), 0, 0);
  nextBounds.inflate(padRadius, padRadius);
  this.onSegmentBounds(prevBounds.union(nextBounds));
  this.strokePoints.push(x, y);
  this.strokePressures.push(pressure);
  pointCount += 2;
  if (pointCount >= 6) this.expandBounds(this.computeSegmentBounds(pointCount))
};
/** Clamp pressure into the stroke engine range. */
BrushStroke.prototype.normalizePressure = function(pressure) {
  if (pressure == null) pressure = 1;
  pressure = Math.max(.05, Math.min(5, pressure));
  if (isNaN(pressure)) throw new Error("Pressure is not a number");
  return pressure
};
BrushStroke.prototype.expandBounds = function(boundsRect) {
  this.segmentBounds = boundsRect;
  this.dirtyBounds = this.dirtyBounds.union(boundsRect)
};
BrushStroke.prototype.finish = function() {
  const strokePoints = this.strokePoints;
  let pointCount = strokePoints.length;
  let segmentBounds;
  if (pointCount == 4) segmentBounds = this.plotPoint(strokePoints[pointCount - 2], strokePoints[pointCount - 1], this.strokePressures[(pointCount >> 1) - 1], true);
  if (pointCount > 4) segmentBounds = this.computeSegmentBounds(pointCount + 2);
  if (segmentBounds) this.expandBounds(segmentBounds)
};
BrushStroke.prototype.computeSegmentBounds = function(pointIndex) {
  const strokePoints = this.strokePoints;
  const strokePressures = this.strokePressures;
  const segStartX = strokePoints[pointIndex - 6];
  const segStartY = strokePoints[pointIndex - 5];
  const segEndX = strokePoints[pointIndex - 4];
  const segEndY = strokePoints[pointIndex - 3];
  const pressure0 = strokePressures[(pointIndex >> 1) - 3];
  const pressure1 = strokePressures[(pointIndex >> 1) - 2];
  let tangentStart = new Point(0, 0);
  let tangentEnd = new Point(0, 0);
  if (8 <= pointIndex) tangentStart = BrushStroke.cubicBezierBounds(strokePoints[pointIndex - 8], strokePoints[pointIndex - 7], segStartX, segStartY, segEndX, segEndY);
  if (pointIndex <= strokePoints.length) tangentEnd = BrushStroke.cubicBezierBounds(strokePoints[pointIndex - 2], strokePoints[pointIndex - 1], segEndX, segEndY, segStartX, segStartY);
  const ctrlX0 = segStartX + tangentStart.x;
  const ctrlY0 = segStartY + tangentStart.y;
  const ctrlX1 = segEndX + tangentEnd.x;
  const ctrlY1 = segEndY + tangentEnd.y;
  let segmentRect = new Rect;
  for (let stepIdx = 0; stepIdx < 10; stepIdx++) {
    const t = (stepIdx + 1) * .1;
    const invT = 1 - t;
    const curveX = invT * invT * invT * segStartX + 3 * t * invT * invT * ctrlX0 + 3 * t * t * invT * ctrlX1 + t * t * t * segEndX;
    const curveY = invT * invT * invT * segStartY + 3 * t * invT * invT * ctrlY0 + 3 * t * t * invT * ctrlY1 + t * t * t * segEndY;
    let stampBounds = this.plotPoint(curveX, curveY, pressure0 + t * (pressure1 - pressure0));
    segmentRect = segmentRect.union(stampBounds)
  }
  return segmentRect
};
BrushStroke.cubicBezierBounds = function(x0, y0, x1, y1, x2, y2) {
  const dx01 = x0 - x1;
  const dy01 = y0 - y1;
  const dx12 = x2 - x1;
  const dy12 = y2 - y1;
  const len01 = Math.sqrt(dx01 * dx01 + dy01 * dy01);
  const len12 = Math.sqrt(dx12 * dx12 + dy12 * dy12);
  let angleFactor = Math.acos((dx01 * dx12 + dy01 * dy12) / (len01 * len12)) / Math.PI;
  const minSmooth = .35;
  const maxSmooth = .1;
  angleFactor = maxSmooth + angleFactor * (minSmooth - maxSmooth);
  const dx02 = x2 - x0;
  const dy02 = y2 - y0;
  const len02 = Math.sqrt(dx02 * dx02 + dy02 * dy02);
  let scale = angleFactor * len12 / len02;
  return new Point(dx02 * scale, dy02 * scale);
};
BrushStroke.prototype.plotPoint = function(x, y, pressure, forcePlot) {
  let stampBounds = new Rect;
  let smoothingRadius = this.strokeSettings.smoothing;
  if (smoothingRadius == null) smoothingRadius = 0;
  if (smoothingRadius == 0 || forcePlot) {
    stampBounds = this.paintAlongLine(x, y, pressure);
    return stampBounds
  }
  const cursorPos = this.cursorPos;
  let deltaX = x - cursorPos.x;
  let deltaY = y - cursorPos.y;
  const segmentLen = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  deltaX /= segmentLen;
  deltaY /= segmentLen;
  if (segmentLen > smoothingRadius) {
    const smoothX = cursorPos.x + deltaX * (segmentLen - smoothingRadius);
    const smoothY = cursorPos.y + deltaY * (segmentLen - smoothingRadius);
    stampBounds = this.paintAlongLine(smoothX, smoothY, pressure);
    this.cursorPos.setXY(smoothX, smoothY)
  }
  return stampBounds
};
BrushStroke.prototype.paintAlongLine = function(x, y, pressure) {
  let stampBounds = new Rect;
  const endPoint = new Point(x, y);
  const brushDiameter = this.brushDescriptor.Brsh.v.diameter.v.val;
  const brushMode = this.strokeSettings.brushMode;
  const direction = endPoint.subtract(this.lastPt);
  direction.normalize(1);
  const segmentLen = Point.dist(this.lastPt, endPoint);
  let spacingOffset = -this.spacingRemainder;
  let pencilAnchor = this.lastPt.clone();
  const pressureDynamics = this.strokeSettings.pressureDynamics;
  while (true) {
    const interpPressure = this.lastPressure + (pressure - this.lastPressure) * (Math.max(0, spacingOffset) / segmentLen);
    const stampDiameter = this.getDiameter() * (pressureDynamics[1] ? interpPressure : 1);
    let spacingStep = this.getSpacing() * (stampDiameter + this.prevSpacingSize) / 2;
    if (brushMode == BrushStroke.MODE_PENCIL) spacingStep = 1;
    if (spacingOffset + spacingStep < segmentLen) {
      spacingOffset += spacingStep;
      let stampPoint = new Point(this.lastPt.x + direction.x * spacingOffset, this.lastPt.y + direction.y * spacingOffset);
      let scatterCount = 1;
      if (brushMode == BrushStroke.MODE_PENCIL) {
        stampPoint = snapPencilStampPoint(pencilAnchor, direction, stampPoint);
        spacingOffset = Point.dist(stampPoint, this.lastPt)
      }
      if (this.brushDescriptor.useScatter.v == true) {
        scatterCount = this.brushDescriptor.Cnt.v;
        const countJitter = this.brushDescriptor.countDynamics.v.jitter.v.val / 100;
        const countRand = countJitter * (-1 + 2 * this.nextRand());
        scatterCount += Math.round(scatterCount * countRand)
      }
      for (let scatterIdx = 0; scatterIdx < scatterCount; scatterIdx++) {
        const stampRect = this.stampBrush(stampPoint, stampDiameter, this.strokeSettings.opacity * (pressureDynamics[0] ? interpPressure * .5 : 1), direction);
        stampBounds = stampBounds.union(stampRect)
      }
      pencilAnchor = stampPoint
    } else break
  }
  this.spacingRemainder = segmentLen - spacingOffset;
  this.lastPt = endPoint;
  this.lastPressure = pressure;
  return stampBounds
};
BrushStroke.prototype.getSpacing = function() {
  const brushShape = this.brushDescriptor.Brsh.v;
  const spacingPct = brushShape.Spcn.v.val;
  const roundnessPct = Math.max(5, brushShape.Rndn.v.val);
  return roundnessPct / 100 * (spacingPct / 100)
};
BrushStroke.prototype.getDiameter = function() {
  const brushDescriptor = this.brushDescriptor;
  let diameter = brushDescriptor.Brsh.v.diameter.v.val;
  if (brushDescriptor.useTipDynamics.v) {
    const minDiameter = diameter * (brushDescriptor.minimumDiameter.v.val / 100);
    diameter = minDiameter + (diameter - minDiameter) * (1 - this.nextRand() * (brushDescriptor.szVr.v.jitter.v.val / 100))
  }
  return diameter
};
BrushStroke.prototype.stampBrush = function(stampPoint, stampDiameter, opacity, direction) {
  opacity = Math.min(1, opacity);
  const brushDescriptor = this.brushDescriptor;
  const brushShape = brushDescriptor.Brsh.v;
  const baseDiameter = brushShape.diameter.v.val;
  const strokeSettings = this.strokeSettings;
  const brushMode = strokeSettings.brushMode;
  const strokeAfU = strokeSettings.afU;
  const stampMatrix = new Matrix2D;
  stampMatrix.translate(-this.brushShape.shapeRect.width / 2, -this.brushShape.shapeRect.height / 2);
  stampMatrix.scale(1 / this.brushShape.brushScale, 1 / this.brushShape.brushScale);
  stampMatrix.scale(stampDiameter / baseDiameter, stampDiameter / baseDiameter);
  stampMatrix.scale(1, Math.max(5, brushShape.Rndn.v.val) / 100);
  if (brushDescriptor.useTipDynamics.v) {
    const minRoundness = brushDescriptor.minimumRoundness.v.val / 100;
    stampMatrix.scale(1, minRoundness + (1 - minRoundness) * Math.round(100 - this.nextRand() * brushDescriptor.roundnessDynamics.v.jitter.v.val) / 100);
    stampMatrix.rotate((-.5 + this.nextRand()) * 4 * Math.PI * (brushDescriptor.angleDynamics.v.jitter.v.val / 100))
  }
  stampMatrix.rotate(brushShape.Angl.v.val * (Math.PI / 180));
  if (brushDescriptor.useScatter.v) {
    const scatterOffset = (-1 + 2 * this.nextRand()) * brushDescriptor.scatterDynamics.v.jitter.v.val / 100;
    stampMatrix.translate(-scatterOffset * stampDiameter * direction.y, scatterOffset * stampDiameter * direction.x)
  }
  stampMatrix.translate(stampPoint.x, stampPoint.y);
  const stampResult = this.fetchBrushStamp(stampMatrix, stampPoint);
  this.onSegmentBounds(stampResult.rect);
  const stampRect = stampResult.rect.clone();
  let stampCenter;
  if (brushMode == null) applyPaintStamp(this, brushDescriptor, stampResult, opacity);
  if (brushMode == BrushStroke.MODE_PENCIL) {
    stampCenter = new Point(stampResult.rect.x + stampResult.rect.width / 2, stampResult.rect.y + stampResult.rect.height / 2);
    applyPencilStamp(this, stampResult, stampCenter, opacity)
  }
  if (brushMode == BrushStroke.MODE_BLUR || brushMode == BrushStroke.MODE_SHARPEN || brushMode == BrushStroke.MODE_SMUDGE) {
    applyRetouchStamp(this, brushMode, stampResult, opacity)
  }
  this.prevSpacingSize = stampDiameter;
  this.lastSmearPt = stampCenter;
  return stampRect
};
BrushStroke.prototype.getStrokeColor = function(brushDescriptor) {
  let strokeRgb = BrushStroke.colorIntToRgb(this.colorInt);
  if (brushDescriptor.useColorDynamics && brushDescriptor.useColorDynamics.v) {
    const fgWeight = 1 - this.nextRand() * brushDescriptor.clVr.v.jitter.v.val / 100;
    const bgRgb = BrushStroke.colorIntToRgb(this.bgColor);
    strokeRgb.h = fgWeight * strokeRgb.h + (1 - fgWeight) * bgRgb.h;
    strokeRgb.l = fgWeight * strokeRgb.l + (1 - fgWeight) * bgRgb.l;
    strokeRgb.O = fgWeight * strokeRgb.O + (1 - fgWeight) * bgRgb.O;
    const hueJitter = (-.5 + this.nextRand()) * brushDescriptor.H.v.val / 100;
    const satJitter = (-1 + 2 * this.nextRand()) * brushDescriptor.Strt.v.val / 100;
    const valJitter = (-1 + 2 * this.nextRand()) * brushDescriptor.Brgh.v.val / 100;
    const hsv = rgbToHsv(strokeRgb.h, strokeRgb.l, strokeRgb.O);
    hsv.hue = (hsv.hue + hueJitter + 1) % 1;
    hsv.saturation = hsv.saturation + satJitter;
    if (hsv.saturation < 0) hsv.saturation = -hsv.saturation;
    if (hsv.saturation > 1) hsv.saturation = 1 - (hsv.saturation - 1);
    hsv.value = hsv.value + valJitter;
    if (hsv.value < 0) hsv.value = -hsv.value;
    if (hsv.value > 1) hsv.value = 1 - (hsv.value - 1);
    strokeRgb = hsvToRgb(hsv.hue, hsv.saturation, hsv.value)
  }
  return strokeRgb
};
BrushStroke.prototype.clamp01 = function(value) {
  return Math.max(0, Math.min(1, value))
};
BrushStroke.prototype.nextRand = function() {
  this.randSeed++;
  return BrushStroke.hashRandSeed(this.randSeed);
};
BrushStroke.colorIntToRgb = function(colorInt) {
  return {
    h: (colorInt >> 16 & 255) / 255,
    l: (colorInt >> 8 & 255) / 255,
    O: (colorInt >> 0 & 255) / 255
  }
};
BrushStroke.hashRandSeed = function(seed) {
  seed = seed ^ 61 ^ seed >> 16;
  seed = seed + (seed << 3);
  seed = seed ^ seed >> 4;
  seed = seed * 668265261;
  seed = seed ^ seed >> 15;
  return (seed & 16777215) / 16777215
};
BrushStroke.stampCache = [];
BrushStroke.matricesSimilar = function(matrixA, matrixB) {
  let scaleA = matrixA.getScale();
  let scaleB = matrixB.getScale();
  if (scaleA < scaleB) {
    const tmpScale = scaleA;
    scaleA = scaleB;
    scaleB = tmpScale
  }
  const deltaA = matrixA.a - matrixB.a;
  const deltaB = matrixA.b - matrixB.b;
  const deltaC = matrixA.c - matrixB.c;
  const deltaD = matrixA.d - matrixB.d;
  return scaleB != 0 && scaleA - scaleB < .025 && Math.max(deltaA * deltaA, deltaB * deltaB, deltaC * deltaC, deltaD * deltaD) <= .01
};
BrushStroke.prototype.fetchBrushStamp = function(transformMatrix, stampPoint) {
  let cacheBucket = null;
  let cachedStamp;
  for (let cacheIdx = 0; cacheIdx < BrushStroke.stampCache.length; cacheIdx++)
    if (BrushStroke.stampCache[cacheIdx].brushCacheKey == this.brushCacheKey) {
      cacheBucket = BrushStroke.stampCache[cacheIdx];
      BrushStroke.stampCache.splice(cacheIdx, 1)
    }if (cacheBucket == null) cacheBucket = {
      stamps: [],
      brushCacheKey: this.brushCacheKey,
      lastUsedAt: 0,
      cachedPixelArea: 0
    };
  const stampList = cacheBucket.stamps;
  const pixelSnap = this.strokeSettings.pixelSnap;
  if (pixelSnap) {
    transformMatrix = transformMatrix.clone();
    transformMatrix.tx = Math.floor(transformMatrix.tx);
    transformMatrix.ty = Math.floor(transformMatrix.ty)
  }
  const subpixelFrac = BrushStroke.subpixelOffset(transformMatrix.tx, transformMatrix.ty);
  for (let cacheIdx = 0; cacheIdx < stampList.length; cacheIdx++) {
    const listEntry = stampList[cacheIdx];
    if (!BrushStroke.matricesSimilar(listEntry.stampMatrix, transformMatrix)) continue;
    if (BrushStroke.subpixelDist(listEntry.subpixelOffset, subpixelFrac) < .2 || listEntry.rect.area() > 2500) {
      cachedStamp = listEntry;
      break
    }
  }
  const roundedDiameter = Math.round(this.brushDescriptor.Brsh.v.diameter.v.val);
  if (cachedStamp) {
    cachedStamp.rect.x = Math.round(cachedStamp.baseRect.x - cachedStamp.stampMatrix.tx + transformMatrix.tx);
    cachedStamp.rect.y = Math.round(cachedStamp.baseRect.y - cachedStamp.stampMatrix.ty + transformMatrix.ty);
    if (pixelSnap) {
      cachedStamp.rect.x = Math.round(stampPoint.x - cachedStamp.rect.width / 2);
      cachedStamp.rect.y = Math.round(stampPoint.y - cachedStamp.rect.height / 2)
    }
    cachedStamp.lastUsedAt = Date.now()
  } else {
    let rasterResult;
    if (pixelSnap && roundedDiameter <= 3) {
      rasterResult = {
        buffer: allocBuffer(roundedDiameter * roundedDiameter * 4),
        rect: new Rect(Math.round(stampPoint.x - roundedDiameter / 2), Math.round(stampPoint.y - roundedDiameter / 2), roundedDiameter, roundedDiameter)
      };
      fillBuffer(rasterResult.buffer, 4278190080)
    } else if (transformMatrix.a == 1 && transformMatrix.b == 0 && transformMatrix.c == 0 && transformMatrix.d == 1) {
      rasterResult = {
        buffer: this.brushShape.rgbaBuffer,
        rect: this.brushShape.shapeRect.clone()
      };
      rasterResult.rect.x = Math.round(transformMatrix.tx);
      rasterResult.rect.y = Math.round(transformMatrix.ty)
    } else rasterResult = transformPixels([this.brushShape.rgbaBuffer, this.brushShape.shapeRect], transformMatrix);
    if (pixelSnap) {
      for (let cacheIdx = 0; cacheIdx < rasterResult.buffer.length; cacheIdx++) rasterResult.buffer[cacheIdx] = rasterResult.buffer[cacheIdx] > 127 ? 255 : 0
    }
    if (rasterResult == null) rasterResult = {
      buffer: allocBuffer(0),
      rect: new Rect
    };
    const fracTx = transformMatrix.tx - Math.floor(transformMatrix.tx);
    const fracTy = transformMatrix.ty - Math.floor(transformMatrix.ty);
    cachedStamp = {
      rgbaBuffer: rasterResult.buffer,
      alphaChannel: allocBuffer(rasterResult.rect.area()),
      rect: rasterResult.rect,
      baseRect: rasterResult.rect.clone(),
      stampMatrix: transformMatrix,
      subpixelOffset: BrushStroke.subpixelOffset(transformMatrix.tx, transformMatrix.ty),
      lastUsedAt: Date.now()
    };
    extractChannelByte(cachedStamp.rgbaBuffer, cachedStamp.alphaChannel, 3);
    stampList.push(cachedStamp);
    cacheBucket.cachedPixelArea += rasterResult.rect.area();
    if (stampList.length > 2e3 || cacheBucket.cachedPixelArea > 100 * 100 * 400) {
      stampList.sort(function(entryA, entryB) {
        return entryB.lastUsedAt - entryA.lastUsedAt
      });
      while (stampList.length > 1e3 || cacheBucket.cachedPixelArea > 100 * 100 * 200) {
        const prunedEntry = stampList.pop();
        cacheBucket.cachedPixelArea -= prunedEntry.rect.area()
      }
    }
  }
  cacheBucket.stamps = stampList;
  cacheBucket.lastUsedAt = Date.now();
  BrushStroke.stampCache.push(cacheBucket);
  BrushStroke.stampCache.sort(function(entryA, entryB) {
    return entryB.lastUsedAt - entryA.lastUsedAt
  });
  while (BrushStroke.stampCache.length > 3) BrushStroke.stampCache.pop();
  return cachedStamp
};
BrushStroke.subpixelOffset = function(tx, ty) {
  return new Point(tx - Math.floor(tx), ty - Math.floor(ty));
};
BrushStroke.subpixelDist = function(offsetA, offsetB) {
  let bx = offsetB.x;
  let by = offsetB.y;
  let dx = Math.abs(bx - offsetA.x);
  let dy = Math.abs(by - offsetA.y);
  if (Math.abs(bx - 1 - offsetA.x) < dx) bx--;
  else if (Math.abs(bx + 1 - offsetA.x) < dx) bx++;
  if (Math.abs(by - 1 - offsetA.y) < dy) by--;
  else if (Math.abs(by + 1 - offsetA.y) < dy) by++;
  dx = offsetA.x - bx;
  dy = offsetA.y - by;
  return Math.sqrt(dx * dx + dy * dy)
};
BrushStroke.prototype.onSegmentBounds = function(boundsRect) {};

function rasterizeComputedBrushShape(brushDescriptor) {
  const hardness = brushDescriptor.Brsh.v.Hrdn.v.val / 100;
  const sizeFactor = 1 + .55 * (1 - hardness);
  let diameter = brushDescriptor.Brsh.v.diameter.v.val;
  let brushScale = diameter < 100 ? 1.2 : 1;
  let rasterSize = Math.round(brushScale * diameter * sizeFactor);
  let shapeRect = new Rect(0, 0, rasterSize, rasterSize);
  let shapeBuffer = allocBuffer(rasterSize * rasterSize * 4);
  const pixelView = new Uint32Array(shapeBuffer.buffer);
  const center = rasterSize / 2;
  const radiusScale = sizeFactor / center;
  const smoothnessTable = BrushStroke.buildSmoothnessTable(hardness);
  const innerBand = Math.round(8e3 / center);
  const smoothnessLUT = smoothnessTable[0];
  const innerThreshold = smoothnessTable[1] - innerBand;
  const outerThreshold = smoothnessTable[2] + innerBand;
  const halfSize = Math.min(rasterSize, (rasterSize >>> 1) + 1);
  for (let rowIdx = 0; rowIdx < halfSize; rowIdx++) {
    let innerRadiusSq = radiusScale * (rowIdx - center + .25);
    innerRadiusSq *= innerRadiusSq;
    let outerRadiusSq = radiusScale * (rowIdx - center + .75);
    outerRadiusSq *= outerRadiusSq;
    const rowBase = rowIdx * rasterSize;
    const mirrorRowBase = (rasterSize - 1 - rowIdx) * rasterSize;
    for (let colIdx = 0; colIdx < halfSize; colIdx++) {
      const innerCol = radiusScale * (colIdx - center + .25);
      const distIdx = Math.floor(Math.sqrt(innerCol * innerCol + innerRadiusSq) * (4e3 / 1.55));
      if (outerThreshold < distIdx) continue;
      else if (distIdx < innerThreshold) {
        const opaquePixel = 4278190080;
        while (colIdx < halfSize) {
          const mirrorCol = rasterSize - 1 - colIdx;
          pixelView[rowBase + colIdx] = opaquePixel;
          pixelView[rowBase + mirrorCol] = opaquePixel;
          pixelView[mirrorRowBase + colIdx] = opaquePixel;
          pixelView[mirrorRowBase + mirrorCol] = opaquePixel;
          colIdx++
        }
        break
      } else {
        const outerCol = radiusScale * (colIdx - center + .75);
        const distIdxInnerInner = Math.floor(Math.sqrt(innerCol * innerCol + innerRadiusSq) * (4e3 / 1.55));
        const distIdxOuterInner = Math.floor(Math.sqrt(outerCol * outerCol + innerRadiusSq) * (4e3 / 1.55));
        const distIdxInnerOuter = Math.floor(Math.sqrt(innerCol * innerCol + outerRadiusSq) * (4e3 / 1.55));
        const distIdxOuterOuter = Math.floor(Math.sqrt(outerCol * outerCol + outerRadiusSq) * (4e3 / 1.55));
        const alphaPixel = ~~(.5 + 255 * .25 * (smoothnessLUT[distIdxInnerInner] + smoothnessLUT[distIdxOuterInner] + smoothnessLUT[distIdxInnerOuter] + smoothnessLUT[distIdxOuterOuter])) << 24;
        const mirrorCol = rasterSize - 1 - colIdx;
        pixelView[rowBase + colIdx] = alphaPixel;
        pixelView[rowBase + mirrorCol] = alphaPixel;
        pixelView[mirrorRowBase + colIdx] = alphaPixel;
        pixelView[mirrorRowBase + mirrorCol] = alphaPixel
      }
    }
  }
  return {
    brushScale: brushScale,
    shapeRect: shapeRect,
    rgbaBuffer: shapeBuffer
  }
}

function loadSampledBrushShape(brushDescriptor, samples) {
  let sampleEntry;
  let diameter = brushDescriptor.Brsh.v.diameter.v.val;
  for (let sampleIdx = 0; sampleIdx < samples.length; sampleIdx++)
    if (samples[sampleIdx].id == brushDescriptor.Brsh.v.sampledData.v) sampleEntry = samples[sampleIdx];
  let shapeRect = new Rect(0, 0, sampleEntry.boundsRect.width, sampleEntry.boundsRect.height);
  let brushScale = Math.max(shapeRect.width, shapeRect.height) / diameter;
  let shapeBuffer = allocBuffer(shapeRect.area() * 4);
  extractChannel(sampleEntry.channel, shapeBuffer, 3);
  return {
    brushScale: brushScale,
    shapeRect: shapeRect,
    rgbaBuffer: shapeBuffer
  }
}

function downsampleBrushShapeIfNeeded(shapeBuffer, shapeRect, brushScale, diameter) {
  while (Math.min(shapeRect.width, shapeRect.height) > diameter * 2) {
    const downsampleRect = new Rect(shapeRect.x, shapeRect.y, Math.floor(shapeRect.width / 2), Math.floor(shapeRect.height / 2));
    const downsampled = transformPixels([shapeBuffer, shapeRect], new Matrix2D(downsampleRect.width / shapeRect.width, 0, 0, downsampleRect.height / shapeRect.height, 0, 0));
    brushScale *= downsampleRect.width / shapeRect.width;
    shapeRect = downsampled.rect;
    shapeBuffer = downsampled.buffer
  }
  return {
    brushScale: brushScale,
    shapeRect: shapeRect,
    rgbaBuffer: shapeBuffer
  }
}

/** Rasterise a brush tip into a cached shape buffer (computed or sampled). */
BrushStroke.buildBrushShape = function(brushDescriptor, samples, patterns) {
  let shapeParts;
  let diameter = brushDescriptor.Brsh.v.diameter.v.val;
  if (brushDescriptor.Brsh.v.classID == "computedBrush") shapeParts = rasterizeComputedBrushShape(brushDescriptor);
  if (brushDescriptor.Brsh.v.classID == "sampledBrush") shapeParts = loadSampledBrushShape(brushDescriptor, samples);
  return downsampleBrushShapeIfNeeded(shapeParts.rgbaBuffer, shapeParts.shapeRect, shapeParts.brushScale, diameter)
};
BrushStroke.smoothnessCache = [];
BrushStroke.buildSmoothnessTable = function(hardness) {
  if (BrushStroke.smoothnessCache[hardness]) return BrushStroke.smoothnessCache[hardness];
  const softness = Math.pow(hardness, .55);
  const table = new Float64Array(8e3);
  let fullRadiusIdx = 0;
  let zeroRadiusIdx = 8e3;
  for (let tableIdx = 0; tableIdx < 8e3; tableIdx++) {
    const softnessValue = BrushStroke.brushSoftness(tableIdx * (1.55 / 4e3), softness);
    if (softnessValue >= 1) fullRadiusIdx = tableIdx;
    else if (softnessValue <= 0 && zeroRadiusIdx == 8e3) zeroRadiusIdx = tableIdx;
    table[tableIdx] = softnessValue
  }
  const result = [table, fullRadiusIdx, zeroRadiusIdx];
  BrushStroke.smoothnessCache[hardness] = result;
  return result
};
BrushStroke.brushSoftness = function(radius, softness) {
  const value = radius < softness ? 1 : BrushStroke.gaussianFalloff((radius - softness) / Math.pow(1.001 - softness, .86));
  return value
};
BrushStroke.gaussianFalloff = function(x) {
  const scaled = x * .85;
  return Math.exp(-(scaled * scaled) * (1 / (2 * .4 * .4))) * (1 / (.4 * Math.sqrt(2 * Math.PI)))
};
BrushStroke.prototype.getSelectionRect = function() {
  return this.rect.clone()
};
BrushStroke.prototype.getSegmentBounds = function() {
  return this.segmentBounds.intersect(this.rect);
};
BrushStroke.prototype.getDirtyBounds = function() {
  return this.dirtyBounds.intersect(this.rect);
};
BrushStroke.prototype.getBuffer = function() {
  return this.pixelBuffer
};
BrushStroke.offscreenCanvas = null;
BrushStroke.renderCtx = null;
BrushStroke.renderPreview = function(brushDescriptor, samples, patterns, canvasWidth, canvasHeight, optionalCanvasWidth) {
  let offscreenCanvas = BrushStroke.offscreenCanvas;
  let renderCtx = BrushStroke.renderCtx;
  if (offscreenCanvas == null) {
    BrushStroke.offscreenCanvas = offscreenCanvas = makeElement("canvas", "");
    BrushStroke.renderCtx = renderCtx = offscreenCanvas.getContext("2d")
  }
  if (optionalCanvasWidth == null) optionalCanvasWidth = canvasWidth;
  if (offscreenCanvas.width != optionalCanvasWidth || offscreenCanvas.height != canvasHeight) {
    offscreenCanvas.width = optionalCanvasWidth;
    offscreenCanvas.height = canvasHeight
  } else renderCtx.clearRect(0, 0, optionalCanvasWidth, canvasHeight);
  if (brushDescriptor == null || brushDescriptor.Brsh == null || brushDescriptor.Brsh.v == null || brushDescriptor.Brsh.v.diameter == null || brushDescriptor.Brsh.v.diameter.v == null) {
    renderCtx.fillStyle = "rgba(0,0,0,0.15)";
    renderCtx.fillRect(0, 0, optionalCanvasWidth, canvasHeight);
    return offscreenCanvas.toDataURL()
  }
  renderCtx.fillStyle = "#000000";
  renderCtx.font = Math.floor(10 * getDevicePixelRatio()) + "px sans-serif";
  const brushDiameter = brushDescriptor.Brsh.v.diameter.v.val;
  const diameterLabel = "" + brushDiameter;
  const labelMetrics = renderCtx.measureText(diameterLabel);
  renderCtx.fillText(diameterLabel, (canvasWidth - labelMetrics.width) / 2, canvasHeight - 2);
  const previewWidth = canvasWidth;
  const previewHeight = canvasHeight - 10 * getDevicePixelRatio();
  const previewSize = Math.min(previewWidth, previewHeight);
  const brushClassId = brushDescriptor.Brsh.v.classID;
  if (brushClassId == "computedBrush") {
    renderCtx.translate(previewWidth / 2, previewHeight / 2);
    renderCtx.rotate(-brushDescriptor.Brsh.v.Angl.v.val * Math.PI / 180);
    renderCtx.scale(1, .1 + .9 * brushDescriptor.Brsh.v.Rndn.v.val / 100);
    const gradientRadius = Math.min(.95 * previewSize / 2, brushDiameter / 2) + .5;
    const hardnessStop = .9 * brushDescriptor.Brsh.v.Hrdn.v.val / 100;
    const radialGradient = renderCtx.createRadialGradient(0, 0, 0, 0, 0, gradientRadius);
    radialGradient.addColorStop(hardnessStop, "rgba(0,0,0,1)");
    radialGradient.addColorStop((.5 + hardnessStop) / 1.5, "rgba(0,0,0,.5)");
    radialGradient.addColorStop(1, "rgba(0,0,0,0)");
    renderCtx.fillStyle = radialGradient;
    renderCtx.fillRect(-gradientRadius, -gradientRadius, 2 * gradientRadius, 2 * gradientRadius);
    renderCtx.setTransform(1, 0, 0, 1, 0, 0)
  } else if (brushClassId == "sampledBrush") {
    let sampleEntry;
    let mipLevel = 0;
    for (let sampleIdx = 0; sampleIdx < samples.length; sampleIdx++)
      if (samples[sampleIdx].id == brushDescriptor.Brsh.v.sampledData.v) sampleEntry = samples[sampleIdx];
    let mipChain = sampleEntry.mipChain;
    if (mipChain == null) {
      mipChain = sampleEntry.mipChain = [sampleEntry.channel, sampleEntry.boundsRect];
      buildMipPyramidBox(mipChain)
    }
    let channelBuffer = sampleEntry.channel;
    let mipWidth = sampleEntry.boundsRect.width;
    let mipHeight = sampleEntry.boundsRect.height;
    while ((mipWidth > previewWidth || mipHeight > previewHeight) && mipChain[mipLevel + 2]) {
      mipLevel += 2;
      channelBuffer = mipChain[mipLevel];
      mipWidth = mipChain[mipLevel + 1].width;
      mipHeight = mipChain[mipLevel + 1].height
    }
    if (mipWidth * mipHeight != 0) {
      const rgbaBuffer = allocBuffer(mipWidth * mipHeight * 4);
      extractChannel(channelBuffer, rgbaBuffer, 3);
      const imageData = new ImageData(new Uint8ClampedArray(rgbaBuffer.buffer), mipWidth, mipHeight);
      renderCtx.putImageData(imageData, Math.round((previewWidth - mipWidth) / 2), Math.round((previewHeight - mipHeight) / 2))
    }
  } else {}
  return offscreenCanvas.toDataURL()
};
/** Build a one-shot tip stamp buffer for cursors / previews. */
BrushStroke.createBrushStamp = function(brushDescriptor, samples, scale, maxRadius) {
  if (scale == 0) scale = 1;
  const brushShape = brushDescriptor.Brsh.v;
  const savedDiameter = brushShape.diameter.v.val;
  const stampDiameter = brushShape.diameter.v.val = Math.min(maxRadius != null ? Math.round(maxRadius * 2.6) : 3e3, savedDiameter * scale);
  const hardness = brushShape.Hrdn ? brushShape.Hrdn.v.val / 100 : 1;
  let rasterSize = maxRadius != null ? maxRadius : Math.round(stampDiameter * (1 + .55 * (1 - hardness))) + 4;
  let stampBuffer;
  rasterSize = Math.max(15, Math.min(rasterSize, 3e3));
  const stampRect = new Rect(0, 0, rasterSize, rasterSize);

  const channelData = new BrushStroke(brushDescriptor, samples, null, {
    opacity: 1
  }, 16711712, 0, stampRect);

  brushShape.diameter.v.val = savedDiameter;
  channelData.moveTo(stampRect.width / 2, stampRect.height / 2);
  const pixelBuffer = channelData.getBuffer();
  const selectionRect = channelData.getSelectionRect();
  if (stampRect.equals(selectionRect)) stampBuffer = pixelBuffer;
  else {
    stampBuffer = allocBuffer(stampRect.area() * 4);
    copyPixels(pixelBuffer, selectionRect, stampBuffer, stampRect)
  }
  return [stampBuffer, stampRect, stampDiameter]
};
BrushStroke.createCursorGlyph = function(brushDescriptor, samples, viewScale, forceCrosshair) {
  const brushStamp = BrushStroke.createBrushStamp(brushDescriptor, samples, viewScale);
  const cursorBuffer = brushStamp[0].slice(0);
  const cursorRect = brushStamp[1];
  const stampDiameter = brushStamp[2];
  const pixelCount = cursorRect.area();
  let alphaChannel = allocBuffer(pixelCount);
  extractChannelByte(cursorBuffer, alphaChannel, 3);
  const edgeChannel = allocBuffer(pixelCount);
  traceChannelBoundary(alphaChannel, edgeChannel, cursorRect);
  if (stampDiameter < 3 || isBufferUniform(edgeChannel, 0) || forceCrosshair && stampDiameter > 12) {
    const rectWidth = cursorRect.width;
    const center = rectWidth >>> 1;
    const edgeBuf = edgeChannel;
    const crossValue = 255;
    for (let armIdx = 0; armIdx < 4; armIdx++) {
      edgeBuf[rectWidth * (center - 6 + armIdx) + center] = crossValue;
      edgeBuf[rectWidth * center + center - 6 + armIdx] = crossValue;
      edgeBuf[rectWidth * center + center + 6 - armIdx] = crossValue;
      edgeBuf[rectWidth * (center + 6 - armIdx) + center] = crossValue
    }
  }
  let blurKernel = [1, 2, 1, 2, 8, 2, 1, 2, 1];
  blurKernel = normalizeKernel(blurKernel);
  convolveChannel3x3(edgeChannel, alphaChannel, cursorRect.width, cursorRect.height, blurKernel);
  fillBuffer(cursorBuffer, 4294967295);
  extractChannel(alphaChannel, cursorBuffer, 3);
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++)
    if (edgeChannel[pixelIdx] == 255) {
      cursorBuffer[pixelIdx << 2] = cursorBuffer[(pixelIdx << 2) + 1] = cursorBuffer[(pixelIdx << 2) + 2] = 0;
      cursorBuffer[(pixelIdx << 2) + 3] = 255
    }return {
      pixelSource: cursorBuffer,
      boundsRect: cursorRect,
      hotspot: new Point(cursorRect.width / 2, cursorRect.height / 2)
    };
};
BrushStroke.MODE_PENCIL = "0";
BrushStroke.MODE_BLUR = "1";
BrushStroke.MODE_SHARPEN = "2";
BrushStroke.MODE_SMUDGE = "3";

function snapPencilStampPoint(pencilAnchor, direction, stampPoint) {
  const xSnap = pencilAnchor.clone();
  xSnap.x += direction.x > 0 ? 1 : -1;
  const ySnap = pencilAnchor.clone();
  ySnap.y += direction.y > 0 ? 1 : -1;
  if (Point.dist(xSnap, stampPoint) < Point.dist(ySnap, stampPoint)) return xSnap;
  return ySnap
}

function applyPaintStamp(stroke, brushDescriptor, stampResult, opacity) {
  let strokeRgb = stroke.getStrokeColor(brushDescriptor);
  fillBuffer(stampResult.rgbaBuffer, Math.round(strokeRgb.O * 255) << 16 | Math.round(strokeRgb.l * 255) << 8 | Math.round(strokeRgb.h * 255) << 0, 4278190080);
  if (stroke.dirtyBounds.isEmpty() && stroke.rect.equals(stampResult.rect) && opacity == 1) stroke.pixelBuffer = stampResult.rgbaBuffer.slice(0);
  else compositeNormalDithered(stampResult.rgbaBuffer, stampResult.rect, stroke.pixelBuffer, stroke.rect, stampResult.rect, opacity)
}

function applyPencilStamp(stroke, stampResult, stampCenter, opacity) {
  const smearDx = Math.round(stampCenter.x - stroke.lastSmearPt.x);
  const smearDy = Math.round(stampCenter.y - stroke.lastSmearPt.y);
  const shiftedRect = stampResult.rect.clone();
  shiftedRect.offset(-smearDx, -smearDy);
  const clipRect = shiftedRect.intersect(stroke.rect);
  clipRect.offset(smearDx, smearDy);
  copyPixels(stroke.pixelBuffer, stroke.rect, stampResult.rgbaBuffer, clipRect);
  compositeNormalDitheredClipped(stampResult.rgbaBuffer, stampResult.rect, stroke.pixelBuffer, stroke.rect, stampResult.alphaChannel, stampResult.rect, opacity)
}

function applyRetouchStamp(stroke, brushMode, stampResult, opacity) {
  const intersectRect = stampResult.rect.intersect(stroke.rect);
  let alphaChannel;
  if (intersectRect.equals(stampResult.rect)) alphaChannel = stampResult.alphaChannel;
  else {
    alphaChannel = allocBuffer(intersectRect.area());
    copyChannel(stampResult.alphaChannel, stampResult.rect, alphaChannel, intersectRect)
  }
  const rgbaBuffer = allocBuffer(intersectRect.area() * 4);
  copyPixels(stroke.pixelBuffer, stroke.rect, rgbaBuffer, intersectRect);
  if (brushMode == BrushStroke.MODE_SHARPEN) {
    const sharpenScratch = rgbaBuffer.slice(0);
    const sharpenKernel = normalizeKernel([-1, -1, -1, -1, 25, -1, -1, -1, -1]);
    convolveRGBA(rgbaBuffer, sharpenScratch, intersectRect.width, intersectRect.height, sharpenKernel, 0);
    copyBuffer(sharpenScratch, rgbaBuffer)
  } else if (brushMode == BrushStroke.MODE_SMUDGE) {
    const unsharpMask = FilterDefs.create("UnsM");
    unsharpMask.Amnt.v.val = 15;
    unsharpMask.Thsh.v = 0;
    unsharpMask.Rds.v.val = 5;
    const smudgeScratch = allocBuffer(rgbaBuffer.length);
    FilterDefs.applyFilterToPixels("UnsM", {
      buffer: rgbaBuffer,
      rect: intersectRect
    }, unsharpMask, 0, 0, {
      buffer: smudgeScratch,
      rect: intersectRect
    });
    copyBuffer(smudgeScratch, rgbaBuffer)
  } else {
    FilterDefs.applyPremultipliedBlur(1, boxBlurRgbaInPlace, rgbaBuffer, intersectRect)
  }
  compositeNormalDitheredClipped(rgbaBuffer, intersectRect, stroke.pixelBuffer, stroke.rect, alphaChannel, intersectRect, opacity)
}

export { BrushStroke };
