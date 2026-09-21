/**
 * Rectangle set ops (subtract/merge/cluster) and document ruler / unit helpers.
 */

/* global NETXUS */

import { Rect } from "../../core/math/rect.js";
import { UnionFind } from "./region-polygon-trace.js";
import { allocBuffer, fillBuffer } from "./buffer-utils.js";
import { copyPixels } from "./pixel-ops.js";
import { rgbToHex } from "./color-math.js";

export const UNIT_NAMES = [
  "properties.drawMode.pixels",
  "properties.units.inches",
  "properties.units.centimeters",
  "properties.units.millimeters",
  "properties.units.percent",
];
export const UNIT_SUFFIXES = ["px", "in", "cm", "mm", "%"];
const UNIT_DECIMAL_PLACES = [2, 3, 2, 1, 2];
const PACK_INITIAL_SIZE = 1000;
const PACK_GROWTH_FACTOR = 1.1;
const RULER_BASE_PX = 16;
const RULER_DIGIT_CHARS = "0 1 2 3 4 5 6 7 8 9 -".split(" ");

const rulerDigitImageCache = { colorKey: null };

function unitScaleForIndex(unitIndex, dpi, docWidth) {
  return [1, dpi, dpi / 2.54, dpi / 25.4, docWidth / 100][unitIndex];
}

function dedupeContainedClips(clipRects) {
  const dedupedClips = [];
  for (let clipIdx = 0; clipIdx < clipRects.length; clipIdx++) {
    const clip = clipRects[clipIdx];
    let contained = false;
    for (let otherIdx = clipIdx + 1; otherIdx < clipRects.length; otherIdx++) {
      const other = clipRects[otherIdx];
      if (other[0] <= clip[0] && other[1] <= clip[1] && clip[2] <= other[2] && clip[3] <= other[3]) {
        contained = true;
        break;
      }
    }
    if (!contained) {
      dedupedClips.push(clip);
    }
  }
  return dedupedClips;
}

function subtractClipFromRects(result, clip) {
  for (let rectIdx = 0; rectIdx < result.length; rectIdx++) {
    const rect = result[rectIdx];
    const overlapLeft = Math.max(clip[0], rect[0]);
    const overlapRight = Math.min(clip[2], rect[2]);
    const overlapTop = Math.max(clip[1], rect[1]);
    const overlapBottom = Math.min(clip[3], rect[3]);
    if (overlapLeft < overlapRight && overlapTop < overlapBottom) {
      const fragments = [];
      if (rect[1] < clip[1]) {
        const topFrag = rect.slice(0);
        topFrag[3] = clip[1];
        fragments.push(topFrag);
      }
      if (rect[0] < clip[0]) {
        const leftFrag = rect.slice(0);
        leftFrag[1] = overlapTop;
        leftFrag[2] = clip[0];
        fragments.push(leftFrag);
      }
      if (clip[2] < rect[2]) {
        const rightFrag = rect.slice(0);
        rightFrag[1] = overlapTop;
        rightFrag[0] = clip[2];
        fragments.push(rightFrag);
      }
      if (clip[3] < rect[3]) {
        const bottomFrag = [overlapLeft, overlapBottom, overlapRight, rect[3]];
        fragments.push(bottomFrag);
      }
      if (fragments.length != 0) {
        result[rectIdx] = fragments[0];
        for (let fragIdx = 1; fragIdx < fragments.length; fragIdx++) {
          result.push(fragments[fragIdx]);
        }
      }
    }
  }
}

export function mergeRects(rects) {
  rects = rects.slice(0);
  for (let rectIdx = 0; rectIdx < rects.length; rectIdx++) {
    const rect = rects[rectIdx];
    let merged = null;
    if (rect[4] != null) {
      continue;
    }
    for (let otherIdx = 0; otherIdx < rects.length; otherIdx++) {
      const other = rects[otherIdx];
      if (rectIdx == otherIdx || other[4] != null) {
        continue;
      }
      const sameLeft = rect[0] == other[0];
      const sameTop = rect[1] == other[1];
      const sameRight = rect[2] == other[2];
      const sameBottom = rect[3] == other[3];
      if (sameTop && sameBottom && (rect[2] == other[0] || rect[0] == other[2])) {
        merged = [Math.min(rect[0], other[0]), rect[1], Math.max(rect[2], other[2]), rect[3]];
      }
      if (sameLeft && sameRight && (rect[3] == other[1] || rect[1] == other[3])) {
        merged = [rect[0], Math.min(rect[1], other[1]), rect[2], Math.max(rect[3], other[3])];
      }
      if (merged) {
        rects[rectIdx] = merged;
        rects.splice(otherIdx, 1);
        break;
      }
    }
    if (merged) {
      rectIdx--;
    }
  }
  return rects;
}

function shouldLinkNearbyRects(rectA, rectB) {
  if (rectA.overlaps(rectB)) {
    return true;
  }
  const rightA = rectA.x + rectA.width;
  const bottomA = rectA.y + rectA.height;
  const rightB = rectB.x + rectB.width;
  const bottomB = rectB.y + rectB.height;
  if ((rightA < rectB.x || rightB < rectA.x) && (bottomA < rectB.y || bottomB < rectA.y)) {
    return false;
  }
  let gapHoriz = 1e9;
  let gapVert = 1e9;
  if (!(bottomA < rectB.y || bottomB < rectA.y)) {
    gapHoriz = Math.min(Math.abs(rightA - rectB.x), Math.abs(rectA.x - rightB));
  }
  if (!(rightA < rectB.x || rightB < rectA.x)) {
    gapVert = Math.min(Math.abs(bottomA - rectB.y), Math.abs(rectA.y - bottomB));
  }
  const minGap = Math.min(gapHoriz, gapVert);
  const minSide = Math.min(rectA.width, rectA.height, rectB.width, rectB.height);
  return minGap < 0.3 * minSide;
}

function buildRectClusters(rects, linkNearby) {
  const unionFind = new UnionFind(rects.length);
  for (let rectIdx = 0; rectIdx < rects.length; rectIdx++) {
    for (let otherIdx = rectIdx + 1; otherIdx < rects.length; otherIdx++) {
      if (!linkNearby) {
        continue;
      }
      if (shouldLinkNearbyRects(rects[rectIdx], rects[otherIdx])) {
        unionFind.link(rectIdx, otherIdx);
      }
    }
  }
  const clusters = [];
  const clusterIdByRoot = {};
  for (let rectIdx = 0; rectIdx < rects.length; rectIdx++) {
    const root = unionFind.find(rectIdx);
    const rect = rects[rectIdx];
    if (clusterIdByRoot[root] == null) {
      clusterIdByRoot[root] = clusters.length;
      clusters.push([]);
    }
    clusters[clusterIdByRoot[root]].push(rect);
  }
  return clusters;
}

function packClusterBounds(clusterBounds) {
  const packRects = [];
  for (let clusterIdx = 0; clusterIdx < clusterBounds.length; clusterIdx++) {
    const packRect = clusterBounds[clusterIdx].clone();
    packRect.clusterIndex = clusterIdx;
    packRects.push(packRect);
  }
  packRects.sort(function (rectA, rectB) {
    return Math.max(rectB.height, rectB.width) - Math.max(rectA.height, rectA.width);
  });
  let packWidth = PACK_INITIAL_SIZE;
  let packHeight = PACK_INITIAL_SIZE;
  while (true) {
    let needResize = false;
    const packer = new NETXUS.RectanglePacker(packWidth, packHeight);
    packer.reset(packWidth, packHeight);
    for (let packIdx = 0; packIdx < packRects.length; packIdx++) {
      const coords = packer.findCoords(packRects[packIdx].width, packRects[packIdx].height);
      if (coords) {
        packRects[packIdx].x = coords.x;
        packRects[packIdx].y = coords.y;
      } else {
        packWidth = Math.floor(packWidth * PACK_GROWTH_FACTOR);
        packHeight = Math.floor(packHeight * PACK_GROWTH_FACTOR);
        needResize = true;
        break;
      }
    }
    if (needResize) {
      continue;
    }
    break;
  }
  return packRects;
}

function applyClusterPackOffsets(clusters, clusterBounds, packRects) {
  for (let clusterIdx = 0; clusterIdx < clusters.length; clusterIdx++) {
    const packed = packRects[clusterIdx];
    const clusterId = packed.clusterIndex;
    const bounds = clusterBounds[clusterId];
    const cluster = clusters[clusterId];
    const offsetX = packed.x - bounds.x;
    const offsetY = packed.y - bounds.y;
    for (let memberIdx = 0; memberIdx < cluster.length; memberIdx++) {
      cluster[memberIdx].offset(offsetX, offsetY);
    }
  }
}

function transposeRulerStrip(stripWidthPx, rulerThickness, tickStrip) {
  const stripBuf32 = new Uint32Array(tickStrip.pixelBuffer.buffer);
  const transposed = new Uint32Array(tickStrip.pixelBuffer.length);
  for (let col = 0; col < stripWidthPx; col++) {
    for (let row = 0; row < rulerThickness; row++) {
      transposed[col * rulerThickness + row] = stripBuf32[row * stripWidthPx + col];
    }
  }
  tickStrip.pixelBuffer = new Uint8Array(transposed.buffer);
}

function drawHorizontalRulerLabels(view, tickStrip, horizStart, horizEnd, screenOrigin, stepPx, stripWidthPx, rulerThickness) {
  const topRulerBuf = view.horizontalRulerImageData.data;
  const topDstRect = new Rect(0, 0, view.viewportRect.width, rulerThickness);
  const topSrcRect = new Rect(0, 0, stripWidthPx, rulerThickness);
  const digitSize = rulerDigitSize;
  const glyphDstRect = new Rect(0, Math.round(rulerThickness * 0.08), digitSize, digitSize);
  for (let tickIdx = 0; tickIdx < (horizEnd - horizStart) / tickStrip.step; tickIdx++) {
    topSrcRect.x = Math.round(screenOrigin.x + tickIdx * stepPx);
    copyPixels(tickStrip.pixelBuffer, topSrcRect, topRulerBuf, topDstRect, topSrcRect);
    const label = (horizStart + tickIdx * tickStrip.step).toString(10);
    for (let charIdx = 0; charIdx < label.length; charIdx++) {
      glyphDstRect.x = topSrcRect.x + 3 + charIdx * Math.round(digitSize * 0.8);
      const glyphData = rulerDigitImageCache[label[charIdx]];
      copyPixels(glyphData, new Rect(0, 0, digitSize, digitSize), topRulerBuf, topDstRect, glyphDstRect);
    }
  }
}

function drawVerticalRulerLabels(view, tickStrip, vertStart, vertEnd, screenOrigin, stepPx, stripWidthPx, rulerThickness) {
  const topRulerBuf = view.verticalRulerImageData.data;
  const topDstRect = new Rect(0, 0, rulerThickness, view.viewportRect.height);
  const topSrcRect = new Rect(0, 0, rulerThickness, stripWidthPx);
  const digitSize = rulerDigitSize;
  const glyphDstRect = new Rect(Math.round(rulerThickness * 0.2), 0, digitSize, digitSize);
  for (let tickIdx = 0; tickIdx < (vertEnd - vertStart) / tickStrip.step; tickIdx++) {
    topSrcRect.y = Math.round(screenOrigin.y + tickIdx * stepPx);
    copyPixels(tickStrip.pixelBuffer, topSrcRect, topRulerBuf, topDstRect, topSrcRect);
    const label = Math.abs(vertStart + tickIdx * tickStrip.step).toString(10);
    for (let charIdx = 0; charIdx < label.length; charIdx++) {
      glyphDstRect.y = topSrcRect.y + 3 + charIdx * Math.round(digitSize * 1.15);
      const glyphData = rulerDigitImageCache[label[charIdx]];
      copyPixels(glyphData, new Rect(0, 0, digitSize, digitSize), topRulerBuf, topDstRect, glyphDstRect);
    }
  }
}

function drawGuideMarkersOnRulers(view, guideX, guideY, tickBlue, rulerThickness) {
  const guideLen = Math.floor(rulerThickness * 0.6);
  const horizBuf32 = new Uint32Array(view.horizontalRulerImageData.data.buffer);
  const vertBuf32 = new Uint32Array(view.verticalRulerImageData.data.buffer);
  const guideColor = tickBlue < 128 ? 4278190080 : 4294967295;
  const viewWidth = view.viewportRect.width;
  const viewHeight = view.viewportRect.height;
  if (0 < guideX && guideX < viewWidth) {
    for (let row = 0; row < guideLen; row++) {
      horizBuf32[row * viewWidth + guideX] = guideColor;
    }
  }
  if (0 < guideY && guideY < viewHeight) {
    for (let row = 0; row < guideLen; row++) {
      vertBuf32[guideY * rulerThickness + row] = guideColor;
    }
  }
}

/**
 * Ruler thickness in device pixels, worked out once on first use — the ruler is
 * drawn into a bitmap, so it has to be a whole number of device pixels.
 */
let rulerThickness = 0;
export function rulerThicknessPx() {
  if (rulerThickness === 0) {
    rulerThickness = Math.floor(RULER_BASE_PX * (window.devicePixelRatio || 1));
  }
  return rulerThickness;
}

/** Side of one ruler digit glyph, set when the glyph sheet is built. */
let rulerDigitSize = 0;

export function subtractRects(baseRect, clipRects) {
  let result = [baseRect];
  const dedupedClips = dedupeContainedClips(clipRects);
  for (let clipIdx = 0; clipIdx < dedupedClips.length; clipIdx++) {
    const clip = dedupedClips[clipIdx];
    subtractClipFromRects(result, clip);
    result.push(clip);
    result = mergeRects(result);
  }
  result.sort(function (rectA, rectB) {
    return rectA[1] != rectB[1] ? rectA[1] - rectB[1] : rectA[0] - rectB[0];
  });
  return result;
}

export function boundingBox(rects) {
  let bounds = new Rect();
  for (let rectIdx = 0; rectIdx < rects.length; rectIdx++) {
    bounds = bounds.union(rects[rectIdx]);
  }
  return bounds;
}

export function clusterRects(rects, linkNearby) {
  const clusters = buildRectClusters(rects, linkNearby);
  const clusterBounds = [];
  for (let clusterIdx = 0; clusterIdx < clusters.length; clusterIdx++) {
    clusterBounds.push(boundingBox(clusters[clusterIdx]));
  }
  const packRects = packClusterBounds(clusterBounds);
  applyClusterPackOffsets(clusters, clusterBounds, packRects);
}

export function docUnitsToPixels(docLength, docState, unitIndex) {
  return docLength * unitScaleForIndex(unitIndex, docState.dpi, docState.width);
}

export function formatDocLength(pixelLength, dpi, appState, docWidth, includeSuffix) {
  const unitIndex = appState.prefs.AppWindow;
  const unitScale = unitScaleForIndex(unitIndex, dpi, docWidth);
  const decimalPlaces = UNIT_DECIMAL_PLACES[unitIndex];
  pixelLength = pixelLength / unitScale;
  const rounded = Math.round(pixelLength);
  let text = unitIndex == 0 && Math.abs(pixelLength - rounded) < 1e-6 ? rounded + "" : pixelLength.toFixed(decimalPlaces);
  if (includeSuffix) {
    text += " " + UNIT_SUFFIXES[unitIndex];
  }
  return text;
}

export function parseDocLengthToPixels(text, dpi, appState, docWidth) {
  const unitIndex = appState.prefs.AppWindow;
  const unitScale = unitScaleForIndex(unitIndex, dpi, docWidth);
  return parseFloat(text) * unitScale;
}

export function buildRulerDigitGlyphs(digitRgb, bgRgb) {
  const cacheKey = digitRgb + "," + bgRgb;
  if (rulerDigitImageCache.colorKey == cacheKey) {
    return;
  }
  const glyphSize = Math.round(rulerThicknessPx() * 0.5);
  rulerDigitSize = glyphSize;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = glyphSize;
  const ctx = canvas.getContext("2d");
  ctx.font = glyphSize * 1.5 + "px monospace";
  for (let charIdx = 0; charIdx < RULER_DIGIT_CHARS.length; charIdx++) {
    ctx.fillStyle = "#" + rgbToHex(bgRgb);
    ctx.fillRect(0, 0, glyphSize, glyphSize);
    ctx.fillStyle = "#" + rgbToHex(digitRgb);
    ctx.fillText(RULER_DIGIT_CHARS[charIdx], 0, glyphSize);
    rulerDigitImageCache[RULER_DIGIT_CHARS[charIdx]] = ctx.getImageData(0, 0, glyphSize, glyphSize).data;
  }
  rulerDigitImageCache.colorKey = cacheKey;
}

export function buildHorizontalRulerTicks(pixelsPerUnit, tickRgb, bgRgb) {
  let stepUnits;
  let minorDivisions;
  const minTickPx = 4 * rulerThicknessPx();
  for (let decade = 9; decade >= 0; decade--) {
    const decadeScale = Math.pow(10, decade);
    if (5 * decadeScale * pixelsPerUnit <= minTickPx) {
      stepUnits = 5 * decadeScale;
      minorDivisions = 10;
      break;
    }
    if (2 * decadeScale * pixelsPerUnit <= minTickPx) {
      stepUnits = 2 * decadeScale;
      minorDivisions = 4;
      break;
    }
    if (1 * decadeScale * pixelsPerUnit <= minTickPx) {
      stepUnits = 1 * decadeScale;
      minorDivisions = 10;
      break;
    }
  }
  if (stepUnits == null) {
    stepUnits = 1;
    minorDivisions = 10;
  }
  if (stepUnits == 0) {
    stepUnits = 1;
    minorDivisions = 10;
  }
  const rulerWidthPx = Math.ceil(stepUnits * pixelsPerUnit);
  const rulerThickness = rulerThicknessPx();
  const rulerBuf = allocBuffer(rulerWidthPx * rulerThickness * 4);
  fillBuffer(rulerBuf, 4278190080 | ((bgRgb & 0xff) << 16) | (bgRgb & 0xff00) | ((bgRgb >> 16) & 0xff));
  for (let row = 0; row < rulerThickness; row++) {
    writeRgbToBufferAtOffset(rulerBuf, 4 * row * rulerWidthPx, tickRgb);
  }
  for (let col = 0; col < rulerWidthPx; col++) {
    writeRgbToBufferAtOffset(rulerBuf, 4 * ((rulerThickness - 1) * rulerWidthPx + col), tickRgb);
  }
  if (stepUnits == 2) {
    minorDivisions = 2;
  }
  if (stepUnits == 5) {
    minorDivisions = 5;
  }
  if (stepUnits > 1 || (stepUnits == 1 && rulerWidthPx > 20)) {
    for (let divIdx = 1; divIdx < minorDivisions; divIdx++) {
      drawRulerMinorTick(rulerBuf, divIdx * (rulerWidthPx / minorDivisions), rulerWidthPx, (divIdx & 1) == 1 ? 0.8 : 0.7, tickRgb);
    }
  }
  return {
    pixelBuffer: rulerBuf,
    step: stepUnits,
  };
}

export function drawRulerMinorTick(rulerBuf, tickX, rulerWidth, tickHeightFrac, tickRgb) {
  const rulerThickness = rulerThicknessPx();
  tickX = Math.round(tickX);
  for (let row = Math.round(rulerThickness * tickHeightFrac); row < rulerThickness - 1; row++) {
    writeRgbToBufferAtOffset(rulerBuf, 4 * (row * rulerWidth + tickX), tickRgb);
  }
}

export function writeRgbToBufferAtOffset(buf, bufOff, rgb) {
  buf[bufOff + 0] = (rgb >> 16) & 255;
  buf[bufOff + 1] = (rgb >> 8) & 255;
  buf[bufOff + 2] = rgb & 255;
}

export function drawRulersOnView(view, tickRgbPacked, bgRgb, guideX, guideY) {
  const viewWidth = view.viewportRect.width;
  const viewHeight = view.viewportRect.height;
  const rulerThickness = rulerThicknessPx();
  const tickBlue = tickRgbPacked & 255;
  const tickGreen = (tickRgbPacked >> 8) & 255;
  const tickRed = (tickRgbPacked >> 16) & 255;
  tickRgbPacked = (Math.round(tickRed * 0.6) << 16) | (Math.round(tickGreen * 0.6) << 8) | Math.round(tickBlue * 0.6);
  buildRulerDigitGlyphs((Math.round(tickRed * 0.8) << 16) | (Math.round(tickGreen * 0.8) << 8) | Math.round(tickBlue * 0.8), bgRgb);
  const tickStrip = buildHorizontalRulerTicks(view.zoomScale, tickRgbPacked, bgRgb);
  const docTopLeft = view.screenToDocPoint(0, 0);
  const docBottomRight = view.screenToDocPoint(viewWidth, viewHeight);
  const horizStart = Math.floor(docTopLeft.x / tickStrip.step) * tickStrip.step;
  const horizEnd = Math.ceil(docBottomRight.x / tickStrip.step) * tickStrip.step;
  const vertStart = Math.floor(docTopLeft.y / tickStrip.step) * tickStrip.step;
  const vertEnd = Math.ceil(docBottomRight.y / tickStrip.step) * tickStrip.step;
  const screenOrigin = view.docToScreenPoint(horizStart, vertStart);
  const stepPx = tickStrip.step * view.zoomScale;
  const stripWidthPx = Math.ceil(stepPx);
  drawHorizontalRulerLabels(view, tickStrip, horizStart, horizEnd, screenOrigin, stepPx, stripWidthPx, rulerThickness);
  transposeRulerStrip(stripWidthPx, rulerThickness, tickStrip);
  drawVerticalRulerLabels(view, tickStrip, vertStart, vertEnd, screenOrigin, stepPx, stripWidthPx, rulerThickness);
  drawGuideMarkersOnRulers(view, guideX, guideY, tickBlue, rulerThickness);
}
