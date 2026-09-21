/**
 * Selecting a region of colour.
 *
 * `sampleSelectionAtPoint` flattens the active layer, floods out from the
 * clicked pixel and returns the mask it reached. `floodSelectMask` does the
 * pixel work: contiguous mode walks a stack out from the seed, non-contiguous
 * thresholds the whole buffer, and either way border pixels fade out over one
 * tolerance width so the edge is not a staircase.
 *
 * Tolerance is a squared-distance in RGBA, so the comparisons stay integer.
 */

import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { LayerSectionType } from "../model/layer.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { blitChannelToBuffer, contentBoundsChannel, copyChannel, copyPixels } from "../../engine/compositing/pixel-ops.js";

export function sampleSelectionAtPoint(doc, samplePoint, wandOptions) {
  if (doc.selectedLayerIndices.length != 1) {
    alert("More than one layer selected.");
    return null;
  }
  const layer = doc.layers[doc.selectedLayerIndices[0]];
  const maskOrChannel = layer.pixelContent <= 0 ? null : layer.pixelContent == 1 ? layer.getMask() : layer.getLinkedPlacedItem(doc).d;
  if (maskOrChannel == null && layer.add.lsct != null && layer.add.lsct != LayerSectionType.Normal) {
    alert("No layer selected.");
    return null;
  }
  if (samplePoint.x < 0 || samplePoint.x > doc.width || samplePoint.y < 0 || samplePoint.y > doc.height) return null;
  const fullDocRect = new Rect(0, 0, doc.width, doc.height);
  let compositeBuffer;
  if (maskOrChannel == null && fullDocRect.equals(layer.rect)) compositeBuffer = layer.buffer;
  else {
    compositeBuffer = allocBuffer(fullDocRect.area() * 4);
    if (maskOrChannel == null) copyPixels(layer.buffer, layer.rect, compositeBuffer, fullDocRect);
    else blitChannelToBuffer(maskOrChannel.channel, maskOrChannel.rect, maskOrChannel.color, compositeBuffer, fullDocRect);
  }
  const floodMask = floodSelectMask(compositeBuffer, fullDocRect, samplePoint, null, wandOptions);
  const selectionBounds = contentBoundsChannel(floodMask, fullDocRect);
  const selectionChannel = allocBuffer(selectionBounds.area());
  copyChannel(floodMask, fullDocRect, selectionChannel, selectionBounds);
  return { rect: selectionBounds, channel: selectionChannel };
}

export function readSampleColors(rgbaBuffer, docRect, samplePoints) {
  const rectWidth = docRect.width;
  const rectHeight = docRect.height;
  const packedPixels = new Uint32Array(rgbaBuffer.buffer);
  const sampleColors = [];
  for (let pointIdx = 0; pointIdx < samplePoints.length; pointIdx++) {
    const samplePoint = samplePoints[pointIdx];
    let localX = Math.round(samplePoint.x - 0.5 - docRect.x);
    let localY = Math.round(samplePoint.y - 0.5 - docRect.y);
    localX = Math.max(0, Math.min(rectWidth - 1, localX));
    localY = Math.max(0, Math.min(rectHeight - 1, localY));
    const packedPixel = packedPixels[localY * rectWidth + localX];
    sampleColors.push([packedPixel & 255, packedPixel >> 8 & 255, packedPixel >> 16 & 255, packedPixel >>> 24]);
  }
  return sampleColors;
}

/**
 * Wand mask: contiguous mode runs a manual-stack flood fill from the sample
 * point; non-contiguous thresholds the whole buffer then anti-aliases border
 * pixels. Anti-alias alpha ramps down over one tolerance width.
 */
export function floodSelectMask(rgbaBuffer, docRect, samplePoint, sampleColors, wandOptions) {
  const packedPixels = new Uint32Array(rgbaBuffer.buffer);
  const rectWidth = docRect.width;
  const rectHeight = docRect.height;
  const pixelCount = rectWidth * rectHeight;
  if (sampleColors == null) sampleColors = readSampleColors(rgbaBuffer, docRect, [samplePoint]);
  const localX = Math.round(samplePoint.x - 0.5 - docRect.x);
  const localY = Math.round(samplePoint.y - 0.5 - docRect.y);
  const seedOffset = localY * rectWidth + localX;
  const maskBuffer = allocBuffer(pixelCount);
  const tolerance = wandOptions[0];
  const invTolerance = 1 / tolerance;
  const antiAliasMax = wandOptions[1] && tolerance > 0 ? 255 : 0;
  if (wandOptions[2]) {
    const visitedFlags = allocBuffer(maskBuffer.length);
    const floodStack = new Uint32Array(pixelCount);
    let stackSize = 1;
    floodStack[0] = localX << 16 | localY;
    visitedFlags[seedOffset] = 1;
    while (stackSize > 0) {
      const stackEntry = floodStack[--stackSize];
      const colIdx = stackEntry >>> 16;
      const rowIdx = stackEntry & 65535;
      const pixelIdx = rowIdx * rectWidth + colIdx;
      const distanceToSample = minColorDistance(packedPixels[pixelIdx], sampleColors);
      if (distanceToSample > tolerance) {
        const antiAliasAlpha = antiAliasMax * (1 - Math.max(0, Math.min(1, (distanceToSample - tolerance) * invTolerance)));
        maskBuffer[pixelIdx] = ~~antiAliasAlpha;
      } else {
        maskBuffer[pixelIdx] = 255;
        if (rowIdx != rectHeight - 1 && visitedFlags[pixelIdx + rectWidth] == 0) {
          floodStack[stackSize++] = colIdx << 16 | rowIdx + 1;
          visitedFlags[pixelIdx + rectWidth] = 1;
        }
        if (rowIdx != 0 && visitedFlags[pixelIdx - rectWidth] == 0) {
          floodStack[stackSize++] = colIdx << 16 | rowIdx - 1;
          visitedFlags[pixelIdx - rectWidth] = 1;
        }
        if (colIdx != rectWidth - 1 && visitedFlags[pixelIdx + 1] == 0) {
          floodStack[stackSize++] = colIdx + 1 << 16 | rowIdx;
          visitedFlags[pixelIdx + 1] = 1;
        }
        if (colIdx != 0 && visitedFlags[pixelIdx - 1] == 0) {
          floodStack[stackSize++] = colIdx - 1 << 16 | rowIdx;
          visitedFlags[pixelIdx - 1] = 1;
        }
      }
    }
  } else {
    for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
      if (minColorDistance(packedPixels[pixelIdx], sampleColors) <= tolerance) maskBuffer[pixelIdx] = 255;
    }
    for (let rowIdx = 0; rowIdx < rectHeight; rowIdx++) {
      for (let colIdx = 0; colIdx < rectWidth; colIdx++) {
        const pixelIdx = rowIdx * rectWidth + colIdx;
        if (maskBuffer[pixelIdx] != 0) continue;
        const touchesSelected =
          (colIdx > 0 && (maskBuffer[pixelIdx - 1] == 255 || rowIdx > 0 && maskBuffer[pixelIdx - rectWidth - 1] == 255 || rowIdx < rectHeight - 1 && maskBuffer[pixelIdx + rectWidth - 1] == 255)) ||
          (colIdx < rectWidth - 1 && (maskBuffer[pixelIdx + 1] == 255 || rowIdx > 0 && maskBuffer[pixelIdx - rectWidth + 1] == 255 || rowIdx < rectHeight - 1 && maskBuffer[pixelIdx + rectWidth + 1] == 255)) ||
          (rowIdx > 0 && maskBuffer[pixelIdx - rectWidth] == 255) ||
          (rowIdx < rectHeight - 1 && maskBuffer[pixelIdx + rectWidth] == 255);
        if (touchesSelected) {
          const distanceToSample = minColorDistance(packedPixels[pixelIdx], sampleColors);
          const antiAliasAlpha = antiAliasMax * (1 - Math.max(0, Math.min(1, (distanceToSample - tolerance) * invTolerance)));
          maskBuffer[pixelIdx] = ~~antiAliasAlpha;
        }
      }
    }
  }
  return maskBuffer;
}

export function minColorDistance(packedPixel, sampleColors) {
  let minDistance = colorDistance(packedPixel, sampleColors[0]);
  for (let sampleIdx = 1; sampleIdx < sampleColors.length; sampleIdx++) {
    minDistance = Math.min(minDistance, colorDistance(packedPixel, sampleColors[sampleIdx]));
  }
  return minDistance;
}

export function colorDistance(packedPixel, sampleRgba) {
  const blue = packedPixel & 255;
  const green = packedPixel >>> 8 & 255;
  const red = packedPixel >>> 16 & 255;
  const alpha = packedPixel >>> 24 & 255;
  if (sampleRgba[3] == 0) return alpha < 5 ? 0 : 255;
  const channelDelta = Math.max(Math.abs(blue - sampleRgba[0]), Math.max(Math.abs(green - sampleRgba[1]), Math.abs(red - sampleRgba[2])));
  return alpha == 0 ? 255 : channelDelta;
}
