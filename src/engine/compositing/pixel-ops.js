/**
 * Pixel buffer ops for compositing: channel/RGBA copy, downsample chains, alpha
 * multiply, histograms, content bounds, hit tests, CFA upscale helpers, and
 * canvas-backed scale interpolation.
 */

import { Rect } from '../../core/math/rect.js';
import { allocBuffer, copyBuffer, downsampleHalfAlphaWeighted, downsampleHalfBox, downsampleHalfChannel, downsampleTwoThirdsAlphaWeighted, downsampleTwoThirdsBox, downsampleTwoThirdsChannel, extractChannel, extractChannelByte, grayChannelToRgba, interleavedToPlanar } from "./buffer-utils.js";
import { pixelAlignBoundsFromCoords, rectToPathOutline, transformCoordPairs } from "./anti-alias.js";
import { luminanceFromRgb } from "./color-math.js";


// Opacity scan reads 8 alphas per 32-byte block; the sub-block remainder is skipped.
const OPACITY_SCAN_BLOCK_BYTES = 32;
const HIT_TEST_ALPHA_THRESHOLD = 128;
const DEFAULT_ROUND_THRESHOLD = 128;
// A downsample factor at or below this halves the buffer; above it takes a 2/3 step.
const HALVE_STEP_SCALE = 0.499;
const HALF_VS_TWO_THIRDS_SCALE = 0.5001;

/**
 * Fast test for any non-opaque pixel. Samples alpha 8 pixels at a time and
 * ignores the final partial block, so it is an approximation for tiny buffers.
 */
export function hasNonOpaquePixels(rgba) {
  let alphaMask = 255;
  const scanLength = rgba.length - (rgba.length & (OPACITY_SCAN_BLOCK_BYTES - 1));
  for (let off = 3; off < scanLength; off += OPACITY_SCAN_BLOCK_BYTES) {
    alphaMask &= rgba[off] & rgba[off + 4] & rgba[off + 8] & rgba[off + 12] & rgba[off + 16] & rgba[off + 20] & rgba[off + 24] & rgba[off + 28];
  }
  return alphaMask != 255;
}

/**
 * Downsample RGBA to `targetScale` by repeated halving, finishing with either a
 * final halve or a 2/3 step. Uses box filtering when fully opaque, alpha-weighted
 * otherwise.
 * @returns {{ buffer: Uint8Array, rect: Rect }}
 */
export function resampleDown(sourceRgba, sourceRect, targetScale, reuseBuffer) {
  let halveStep = downsampleHalfAlphaWeighted;
  let twoThirdsStep = downsampleTwoThirdsAlphaWeighted;
  if (!hasNonOpaquePixels(sourceRgba)) {
    halveStep = downsampleHalfBox;
    twoThirdsStep = downsampleTwoThirdsBox;
  }
  return resampleByRepeatedHalving(sourceRgba, sourceRect, targetScale, reuseBuffer, halveStep, twoThirdsStep);
}

/**
 * Single-channel counterpart of {@link resampleDown}.
 * @returns {{ buffer: Uint8Array, rect: Rect }}
 */
export function resampleDownChannel(sourceChannel, sourceRect, targetScale, reuseBuffer) {
  return resampleByRepeatedHalving(
    sourceChannel,
    sourceRect,
    targetScale,
    reuseBuffer,
    downsampleHalfChannel,
    downsampleTwoThirdsChannel,
  );
}

/** Shared halve-until-close then final halve-or-2/3-step loop. */
function resampleByRepeatedHalving(sourceBuffer, sourceRect, targetScale, reuseBuffer, halveStep, twoThirdsStep) {
  let halveCount = 0;
  let scale = targetScale;
  while (scale < HALVE_STEP_SCALE) {
    halveCount++;
    scale *= 2;
  }
  let state = { buffer: sourceBuffer, rect: sourceRect };
  for (let step = 0; step < halveCount; step++) {
    state = halveStep(state.buffer, state.rect, reuseBuffer);
  }
  if (scale < HALF_VS_TWO_THIRDS_SCALE) {
    state = halveStep(state.buffer, state.rect, reuseBuffer);
  } else {
    state = twoThirdsStep(state.buffer, state.rect, reuseBuffer);
  }
  return state;
}



/**
 * Overlap of source and destination rects (optionally clipped), expressed as
 * per-buffer local offsets and a shared copy size.
 * @returns {{ srcOffX: number, dstOffX: number, srcOffY: number, dstOffY: number, width: number, height: number }}
 */
function clipRegion(srcRect, dstRect, clipRect) {
  let region = srcRect.intersect(dstRect);
  if (clipRect) {
    region = region.intersect(clipRect);
  }
  return {
    srcOffX: Math.max(0, region.x - srcRect.x),
    dstOffX: Math.max(0, region.x - dstRect.x),
    srcOffY: Math.max(0, region.y - srcRect.y),
    dstOffY: Math.max(0, region.y - dstRect.y),
    width: region.width,
    height: region.height,
  };
}

export function copyChannel(srcChannel, srcRect, dstChannel, dstRect, clipRect) {
  const region = clipRegion(srcRect, dstRect, clipRect);
  for (let row = 0; row < region.height; row++) {
    const srcRowOff = (region.srcOffY + row) * srcRect.width + region.srcOffX;
    const dstRowOff = (region.dstOffY + row) * dstRect.width + region.dstOffX;
    for (let col = 0; col < region.width; col++) {
      dstChannel[dstRowOff + col] = srcChannel[srcRowOff + col];
    }
  }
}

/**
 * Expand a grayscale channel into an RGBA buffer, over a ground of `fillColor`.
 * Pixels the channel does not cover keep the fill, and alpha is left opaque.
 */
export function blitChannelToBuffer(srcChannel, srcRect, fillColor, dstRgba, dstRect) {
  const grayChannelBuffer = allocBuffer(dstRect.area());
  grayChannelBuffer.fill(fillColor);
  copyChannel(srcChannel, srcRect, grayChannelBuffer, dstRect);
  dstRgba.fill(255);
  grayChannelToRgba(grayChannelBuffer, dstRgba);
}

/** Write a single channel into the alpha byte of an RGBA buffer. */
export function copyChannelToAlpha(srcChannel, srcRect, dstRgba, dstRect) {
  if (srcRect.equals(dstRect)) {
    extractChannel(srcChannel, dstRgba, 3);
    return;
  }
  const region = clipRegion(srcRect, dstRect);
  for (let row = 0; row < region.height; row++) {
    const srcRowOff = (region.srcOffY + row) * srcRect.width + region.srcOffX;
    const dstRowOff = (region.dstOffY + row) * dstRect.width + region.dstOffX;
    for (let col = 0; col < region.width; col++) {
      dstRgba[((dstRowOff + col) << 2) + 3] = srcChannel[srcRowOff + col];
    }
  }
}

/** Read the alpha byte of an RGBA buffer into a single channel. */
export function copyAlphaToChannel(srcRgba, srcRect, dstChannel, dstRect) {
  const region = clipRegion(srcRect, dstRect);
  for (let row = 0; row < region.height; row++) {
    const srcRowOff = (region.srcOffY + row) * srcRect.width + region.srcOffX;
    const dstRowOff = (region.dstOffY + row) * dstRect.width + region.dstOffX;
    for (let col = 0; col < region.width; col++) {
      dstChannel[dstRowOff + col] = srcRgba[((srcRowOff + col) << 2) + 3];
    }
  }
}

/** Copy RGBA pixels row by row as 32-bit words, honoring an optional clip rect. */
export function copyPixels(srcRgba, srcRect, dstRgba, dstRect, clipRect) {
  if (srcRect.equals(dstRect) && (clipRect == null || clipRect.equals(dstRect))) {
    copyBuffer(srcRgba, dstRgba);
    return;
  }
  const srcWords = new Uint32Array(srcRgba.buffer);
  const dstWords = new Uint32Array(dstRgba.buffer);
  const region = clipRegion(srcRect, dstRect, clipRect);
  for (let row = 0; row < region.height; row++) {
    const srcRowOff = (region.srcOffY + row) * srcRect.width + region.srcOffX;
    const dstRowOff = (region.dstOffY + row) * dstRect.width + region.dstOffX;
    dstWords.set(new Uint32Array(srcWords.buffer, srcRowOff * 4, region.width), dstRowOff);
  }
}

/**
 * Copy all four planes of a planar image. Planes use the internal RGB plane
 * convention: `w` alpha, `h` red, `l` green, `O` blue.
 */
export function copyChannelsWithClip(srcPlanes, srcRect, dstPlanes, dstRect) {
  const region = clipRegion(srcRect, dstRect);
  const srcOffX = region.srcOffX;
  const dstOffX = region.dstOffX;
  const srcOffY = region.srcOffY;
  const dstOffY = region.dstOffY;
  const copyWidth = region.width;
  const copyHeight = region.height;
  const srcAlphaPlane = srcPlanes.w;
  const srcRedPlane = srcPlanes.h;
  const srcGreenPlane = srcPlanes.l;
  const srcBluePlane = srcPlanes.O;
  const dstAlphaPlane = dstPlanes.w;
  const dstRedPlane = dstPlanes.h;
  const dstGreenPlane = dstPlanes.l;
  const dstBluePlane = dstPlanes.O;
  for (let row = 0; row < copyHeight; row++) {
    const srcRowOff = (srcOffY + row) * srcRect.width + srcOffX;
    const dstRowOff = (dstOffY + row) * dstRect.width + dstOffX;
    for (let col = 0; col < copyWidth; col++) {
      dstRedPlane[dstRowOff + col] = srcRedPlane[srcRowOff + col];
      dstGreenPlane[dstRowOff + col] = srcGreenPlane[srcRowOff + col];
      dstBluePlane[dstRowOff + col] = srcBluePlane[srcRowOff + col];
      dstAlphaPlane[dstRowOff + col] = srcAlphaPlane[srcRowOff + col];
    }
  }
}

/** Multiply RGB by alpha/255 in place, skipping fully opaque pixels. */
export function premultiplyAlpha(rgba) {
  const inv255 = 1 / 255;
  for (let off = 0; off < rgba.length; off += 4) {
    const alpha = rgba[off + 3];
    if (alpha == 255) {
      continue;
    }
    rgba[off] = ~~(rgba[off] * alpha * inv255 + 0.5);
    rgba[off + 1] = ~~(rgba[off + 1] * alpha * inv255 + 0.5);
    rgba[off + 2] = ~~(rgba[off + 2] * alpha * inv255 + 0.5);
  }
}

/** Divide RGB by alpha/255 in place, skipping fully transparent or opaque pixels. */
export function unpremultiplyAlpha(rgba) {
  for (let off = 0; off < rgba.length; off += 4) {
    const alpha = rgba[off + 3];
    if (alpha == 0 || alpha == 255) {
      continue;
    }
    const invAlpha = 255 / alpha;
    rgba[off] = ~~(rgba[off] * invAlpha + 0.5);
    rgba[off + 1] = ~~(rgba[off + 1] * invAlpha + 0.5);
    rgba[off + 2] = ~~(rgba[off + 2] * invAlpha + 0.5);
  }
}

export function isBufferUniform(buffer, value) {
  for (let idx = 0; idx < buffer.length; idx++) {
    if (buffer[idx] != value) {
      return false;
    }
  }
  return true;
}

/** Fast integer `round(value / 255)` for a product of two bytes. */
export function mulDiv255(value) {
  return (value + 1 + (value >>> 8)) >>> 8;
}

/** Binarize a buffer in place: below `threshold` → 0, else 255. */
export function round(buffer, threshold) {
  if (threshold == null) {
    threshold = DEFAULT_ROUND_THRESHOLD;
  }
  for (let idx = 0; idx < buffer.length; idx++) {
    buffer[idx] = buffer[idx] < threshold ? 0 : 255;
  }
}

export function scaleBuffer(buffer, scale) {
  for (let idx = 0; idx < buffer.length; idx++) {
    buffer[idx] = Math.round(buffer[idx] * scale);
  }
}

/** Per-channel multiply of two equally sized RGBA buffers, writing into `dstRgba`. */
export function multiplyBuffers(srcRgba, dstRgba) {
  const srcPx = new Uint32Array(srcRgba.buffer);
  const dstPx = new Uint32Array(dstRgba.buffer);
  for (let idx = 0; idx < srcPx.length; idx++) {
    const src = srcPx[idx];
    const dst = dstPx[idx];
    dstPx[idx] =
      mulDiv255((src >>> 24) * (dst >>> 24)) << 24 |
      mulDiv255((src >>> 16 & 255) * (dst >>> 16 & 255)) << 16 |
      mulDiv255((src >>> 8 & 255) * (dst >>> 8 & 255)) << 8 |
      mulDiv255((src & 255) * (dst & 255));
  }
}

/** Scale each RGBA alpha by the matching mask value (full-buffer, aligned). */
export function multiplyAlphaByMask(maskChannel, rgba) {
  for (let idx = 0; idx < maskChannel.length; idx++) {
    rgba[(idx << 2) + 3] = mulDiv255(rgba[(idx << 2) + 3] * maskChannel[idx]);
  }
}

/**
 * Overlap of two rects as per-rect local offsets and a raw span. A non-overlap
 * yields a non-positive width/height, so callers simply iterate zero rows.
 * @returns {{ aOffX: number, bOffX: number, aOffY: number, bOffY: number, width: number, height: number }}
 */
function rectOverlap(a, b) {
  return {
    aOffX: Math.max(0, b.x - a.x),
    bOffX: Math.max(0, a.x - b.x),
    aOffY: Math.max(0, b.y - a.y),
    bOffY: Math.max(0, a.y - b.y),
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/** Multiply a destination mask by a source mask over their overlap. */
export function multiplyMaskByRegion(maskChannel, maskRect, dstMask, dstRect) {
  const overlap = rectOverlap(maskRect, dstRect);
  for (let row = 0; row < overlap.height; row++) {
    let maskRowOff = (overlap.aOffY + row) * maskRect.width + overlap.aOffX;
    let dstRowOff = (overlap.bOffY + row) * dstRect.width + overlap.bOffX;
    for (let col = 0; col < overlap.width; col++) {
      dstMask[dstRowOff] = mulDiv255(dstMask[dstRowOff] * maskChannel[maskRowOff]);
      maskRowOff++;
      dstRowOff++;
    }
  }
}

/** Scale an RGBA buffer's alpha by a mask over their overlap. */
export function scaleRgbaAlphaByMask(maskChannel, maskRect, rgba, rgbaRect) {
  const overlap = rectOverlap(maskRect, rgbaRect);
  for (let row = 0; row < overlap.height; row++) {
    let maskRowOff = (overlap.aOffY + row) * maskRect.width + overlap.aOffX;
    let rgbaAlphaOff = (((overlap.bOffY + row) * rgbaRect.width + overlap.bOffX) << 2) + 3;
    for (let col = 0; col < overlap.width; col++) {
      rgba[rgbaAlphaOff] = mulDiv255(rgba[rgbaAlphaOff] * maskChannel[maskRowOff]);
      maskRowOff++;
      rgbaAlphaOff += 4;
    }
  }
}

/** Multiply a destination RGBA's alpha by a source RGBA's alpha over their overlap. */
export function multiplyAlphaByAlpha(srcRgba, srcRect, dstRgba, dstRect) {
  const overlap = rectOverlap(srcRect, dstRect);
  for (let row = 0; row < overlap.height; row++) {
    let srcAlphaOff = (((overlap.aOffY + row) * srcRect.width + overlap.aOffX) << 2) + 3;
    let dstAlphaOff = (((overlap.bOffY + row) * dstRect.width + overlap.bOffX) << 2) + 3;
    for (let col = 0; col < overlap.width; col++) {
      dstRgba[dstAlphaOff] = mulDiv255(dstRgba[dstAlphaOff] * srcRgba[srcAlphaOff]);
      srcAlphaOff += 4;
      dstAlphaOff += 4;
    }
  }
}

/**
 * Alpha-weighted per-channel histograms.
 * @returns {[Float64Array, Float64Array, Float64Array, Float64Array, number, number]}
 *   [combined, red, green, blue, pixelCount, weightedAlpha]
 */
export function computeHistogram(rgba) {
  const combined = new Float64Array(256);
  const histR = new Float64Array(256);
  const histG = new Float64Array(256);
  const histB = new Float64Array(256);
  const inv255 = 1 / 255;
  let alphaSum = 0;
  for (let off = 0; off < rgba.length; off += 4) {
    const alpha = rgba[off + 3];
    const weight = alpha * inv255;
    histR[rgba[off + 0]] += weight;
    histG[rgba[off + 1]] += weight;
    histB[rgba[off + 2]] += weight;
    alphaSum += alpha;
  }
  for (let idx = 0; idx < 256; idx++) {
    combined[idx] = histR[idx] + histG[idx] + histB[idx];
  }
  return [combined, histR, histG, histB, rgba.length >>> 2, alphaSum / 255];
}

/** Map every RGBA channel byte through a 256-entry lookup table in place. */
export function applyLookupTable(rgba, lut) {
  const px = new Uint32Array(rgba.buffer);
  for (let idx = 0; idx < px.length; idx++) {
    const pixel = px[idx];
    const b = pixel & 255;
    const g = pixel >> 8 & 255;
    const r = pixel >> 16 & 255;
    const a = pixel >> 24 & 255;
    px[idx] = lut[b] | lut[g] << 8 | lut[r] << 16 | lut[a] << 24;
  }
}

/**
 * Apply per-channel tone curves. `useLuma` drives all channels from luminance;
 * `preserveLuma` rescales the result back toward the source luminance. Curves may
 * be finer than 256 entries; `curveShift` picks the sub-step. Alpha is preserved.
 */
export function applyColorCurves(srcRgba, dstRgba, curveB, curveG, curveR, useLuma, preserveLuma) {
  const srcPx = new Uint32Array(srcRgba.buffer);
  const dstPx = new Uint32Array(dstRgba.buffer);
  const pxCount = srcPx.length;
  let curveShift = 0;
  while (256 << curveShift < curveB.length) {
    curveShift++;
  }
  if (!preserveLuma && !useLuma) {
    for (let idx = 0; idx != pxCount; idx++) {
      const pixel = srcPx[idx];
      const outB = curveB[(pixel & 255) << curveShift];
      const outG = curveG[(pixel >>> 8 & 255) << curveShift];
      const outR = curveR[(pixel >>> 16 & 255) << curveShift];
      dstPx[idx] = outB | outG << 8 | outR << 16 | pixel & 4278190080;
    }
    return;
  }
  for (let idx = 0; idx < pxCount; idx++) {
    const pixel = srcPx[idx];
    let blueIdx = (pixel & 255) << curveShift;
    let greenIdx = (pixel >>> 8 & 255) << curveShift;
    let redIdx = (pixel >>> 16 & 255) << curveShift;
    if (useLuma) {
      blueIdx = greenIdx = redIdx = Math.round(blueIdx * 0.3 + greenIdx * 0.59 + redIdx * 0.11);
    }
    let outB = curveB[blueIdx];
    let outG = curveG[greenIdx];
    let outR = curveR[redIdx];
    if (preserveLuma) {
      const srcLuma = luminanceFromRgb(blueIdx, greenIdx, redIdx);
      const dstLuma = luminanceFromRgb(outB, outG, outR);
      if (srcLuma > dstLuma) {
        const scale = (srcLuma - dstLuma) / (255 - dstLuma);
        outB += scale * (255 - outB);
        outG += scale * (255 - outG);
        outR += scale * (255 - outR);
      } else if (dstLuma == 0) {
        outB = outG = outR = 0;
      } else {
        const scale = srcLuma / dstLuma;
        outB = scale * outB;
        outG = scale * outG;
        outR = scale * outR;
      }
    }
    dstPx[idx] = outB | outG << 8 | outR << 16 | pixel & 4278190080;
  }
}

/**
 * Tightest rect enclosing all non-zero channel values, in document space.
 * Returns an empty rect when the channel is entirely zero.
 */
export function contentBoundsChannel(channel, rect) {
  const width = rect.width;
  const height = rect.height;
  let top = 0;
  let left = 0;
  let bottomTrim = 0;
  let rightTrim = 0;
  let rowOr = 0;
  for (let row = 0; row < height; row++) {
    const rowOff = row * width;
    for (let col = 0; col < width; col++) {
      rowOr |= channel[rowOff + col];
    }
    if (rowOr != 0) break;
    top++;
  }
  if (top == height) {
    return new Rect(0, 0, 0, 0);
  }
  rowOr = 0;
  for (let row = height - 1; row >= 0; row--) {
    const rowOff = row * width;
    for (let col = 0; col < width; col++) {
      rowOr |= channel[rowOff + col];
    }
    if (rowOr != 0) break;
    bottomTrim++;
  }
  const bottomRow = height - bottomTrim;
  rowOr = 0;
  for (let col = 0; col < width; col++) {
    for (let row = top; row < bottomRow; row++) {
      rowOr |= channel[row * width + col];
    }
    if (rowOr != 0) break;
    left++;
  }
  rowOr = 0;
  for (let col = width - 1; col >= 0; col--) {
    for (let row = top; row < bottomRow; row++) {
      rowOr |= channel[row * width + col];
    }
    if (rowOr != 0) break;
    rightTrim++;
  }
  return new Rect(rect.x + left, rect.y + top, width - left - rightTrim, height - top - bottomTrim);
}

/**
 * Tightest rect enclosing all pixels differing from a sentinel color, trimming
 * only the sides selected by `trimSides` ([top, left, bottom, right]).
 * `sentinelIndex` picks the sentinel: 0 = top-left pixel, 1 = bottom-right, 2 = transparent.
 */
export function computeContentBoundsRgba(rgba, rect, sentinelIndex, trimSides) {
  if (trimSides == null) {
    trimSides = [true, true, true, true];
  }
  if (sentinelIndex == null) {
    sentinelIndex = 0;
  }
  const px = new Uint32Array(rgba.buffer);
  const width = rect.width;
  const height = rect.height;
  const sentinel = [px[0], px[px.length - 1], 0][sentinelIndex];
  let top = 0;
  let left = 0;
  let bottomTrim = 0;
  let rightTrim = 0;
  let found = false;
  if (trimSides[0]) {
    for (let row = 0; row < height; row++) {
      const rowOff = row * width;
      for (let col = 0; col < width; col++) {
        if (px[rowOff + col] != sentinel) found = true;
      }
      if (found) break;
      top++;
    }
  }
  found = false;
  if (trimSides[2]) {
    for (let row = height - 1; row >= 0; row--) {
      const rowOff = row * width;
      for (let col = 0; col < width; col++) {
        if (px[rowOff + col] != sentinel) found = true;
      }
      if (found) break;
      bottomTrim++;
    }
  }
  found = false;
  if (trimSides[1]) {
    for (let col = 0; col < width; col++) {
      for (let row = 0; row < height; row++) {
        if (px[row * width + col] != sentinel) found = true;
      }
      if (found) break;
      left++;
    }
  }
  found = false;
  if (trimSides[3]) {
    for (let col = width - 1; col >= 0; col--) {
      for (let row = 0; row < height; row++) {
        if (px[row * width + col] != sentinel) found = true;
      }
      if (found) break;
      rightTrim++;
    }
  }
  const bounds = new Rect(rect.x + left, rect.y + top, width - left - rightTrim, height - top - bottomTrim);
  return bounds.isEmpty() ? new Rect(0, 0, 0, 0) : bounds;
}

/** Crop a `{ channel, rect }` bundle in place to its content bounds. */
export function trimChannelToContent(channelBundle) {
  const tightRect = contentBoundsChannel(channelBundle.channel, channelBundle.rect);
  if (tightRect.equals(channelBundle.rect)) {
    return;
  }
  const tightChannel = allocBuffer(tightRect.area());
  copyChannel(channelBundle.channel, channelBundle.rect, tightChannel, tightRect);
  channelBundle.channel = tightChannel;
  channelBundle.rect = tightRect;
}

/** Crop a `{ buffer, rect }` RGBA bundle in place to its alpha content bounds. */
export function trimRgbaToContent(rgbaBundle) {
  const alphaChannel = allocBuffer(rgbaBundle.buffer.length >> 2);
  extractChannelByte(rgbaBundle.buffer, alphaChannel, 3);
  const tightRect = contentBoundsChannel(alphaChannel, rgbaBundle.rect);
  if (tightRect.equals(rgbaBundle.rect)) {
    return;
  }
  const tightRgba = allocBuffer(tightRect.area() * 4);
  copyPixels(rgbaBundle.buffer, rgbaBundle.rect, tightRgba, tightRect);
  rgbaBundle.buffer = tightRgba;
  rgbaBundle.rect = tightRect;
}

/** Grow a `{ channel, rect }` bundle to cover `targetRect`, optionally filling new area. */
export function extend(channelBundle, targetRect, fillValue) {
  if (channelBundle.rect.containsRect(targetRect)) {
    return;
  }
  const unionRect = channelBundle.rect.union(targetRect);
  const expanded = allocBuffer(unionRect.area());
  if (fillValue != null) {
    expanded.fill(fillValue);
  }
  copyChannel(channelBundle.channel, channelBundle.rect, expanded, unionRect);
  channelBundle.rect = unionRect;
  channelBundle.channel = expanded;
}

/** Grow a `{ buffer, rect }` RGBA bundle to cover `targetRect`. */
export function extendRgbaBuffer(rgbaBundle, targetRect) {
  if (targetRect.isEmpty() || rgbaBundle.rect.containsRect(targetRect)) {
    return;
  }
  const unionRect = rgbaBundle.rect.union(targetRect);
  const expanded = allocBuffer(unionRect.area() * 4);
  copyPixels(rgbaBundle.buffer, rgbaBundle.rect, expanded, unionRect);
  rgbaBundle.rect = unionRect;
  rgbaBundle.buffer = expanded;
}

export function hitTestChannel(point, channel, rect) {
  if (!rect.containsPoint(point)) {
    return false;
  }
  const localX = Math.floor(point.x) - rect.x;
  const localY = Math.floor(point.y) - rect.y;
  return channel[localY * rect.width + localX] > HIT_TEST_ALPHA_THRESHOLD;
}

export function hitTestRgba(point, rgba, rect) {
  if (!rect.containsPoint(point)) {
    return false;
  }
  const localX = Math.floor(point.x) - rect.x;
  const localY = Math.floor(point.y) - rect.y;
  return rgba[4 * (localY * rect.width + localX) + 3] > HIT_TEST_ALPHA_THRESHOLD;
}

/** Shared all-255 buffer, grown on demand. */
/** Grown on demand by getWhiteBuffer / getZeroBuffer; never handed out shorter
 * than asked for, and never shrunk, so callers may keep a reference. */
let whiteBufferCache = allocBuffer(0);
let zeroBufferCache = allocBuffer(0);

export function getWhiteBuffer(minLength) {
  if (whiteBufferCache.length < minLength) {
    whiteBufferCache = allocBuffer(minLength);
    whiteBufferCache.fill(255);
  }
  return whiteBufferCache;
}

/** Shared all-zero buffer, grown on demand. */
export function getZeroBuffer(minLength) {
  if (zeroBufferCache.length < minLength) {
    zeroBufferCache = allocBuffer(minLength);
  }
  return zeroBufferCache;
}

/**
 * Mark the boundary of a thresholded mask into dstGray. A source sample at or
 * above mid-gray is written as 255 when it sits on the mask edge — on an image
 * border, or with a neighbour below the threshold. Used to outline a brush
 * stamp's alpha for the cursor ring.
 * @param {Uint8Array} srcGray source mask channel
 * @param {Uint8Array} dstGray destination edge channel
 * @param {{width:number, height:number}} bounds channel dimensions
 */
export function traceChannelBoundary(srcGray, dstGray, bounds) {
  const threshold = 128;
  const width = bounds.width;
  const height = bounds.height;
  let off = 0;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      if (srcGray[off] >= threshold && (col == 0 || srcGray[off - 1] < threshold || (col == width - 1 || srcGray[off + 1] < threshold) || (row == 0 || srcGray[off - width] < threshold) || (row == height - 1 || srcGray[off + width] < threshold))) dstGray[off] = 255;
      off++;
    }
  }
}

/**
 * Draw the boundary of a mask channel into an RGBA buffer as a two-tone stipple
 * (marching-ants style). A masked pixel (high bit set) that touches the mask
 * edge is written with an alternating black/white pixel; interior and
 * background pixels are left untouched. Limited to clipRect when supplied.
 * @param {Uint8Array} srcGray source mask channel
 * @param {Uint8Array} dstPixels destination RGBA buffer
 * @param {{x:number, y:number, width:number, height:number}} bounds
 * @param {?{x:number, y:number, width:number, height:number}} clipRect
 */
export function renderMaskBoundaryOverlay(srcGray, dstPixels, bounds, clipRect) {
  const palette = new Uint32Array([4278190080, 4294967295]);
  const width = bounds.width;
  const height = bounds.height;
  let minX = 0;
  let minY = 0;
  let maxX = width;
  let maxY = height;
  if (clipRect) {
    minX = clipRect.x - bounds.x;
    minY = clipRect.y - bounds.y;
    maxX = minX + clipRect.width;
    maxY = minY + clipRect.height;
  }
  const dstBuf = new Uint32Array(dstPixels.buffer);
  for (let row = minY; row < maxY; row++) {
    for (let col = minX; col < maxX; col++) {
      const off = row * width + col;
      if ((srcGray[off] & 128) != 0 && (row == 0 || (srcGray[off - width] & 128) == 0 || col == 0 || (srcGray[off - 1] & 128) == 0 || col == width - 1 || (srcGray[off + 1] & 128) == 0 || row == height - 1 || (srcGray[off + width] & 128) == 0)) {
        dstBuf[off] = palette[(col + row & 4) >>> 2];
      }
    }
  }
}

/**
 * Fill an RGBA buffer from a mask channel. With invertMode 1 each pixel becomes
 * a half-intensity darkening of the source value; otherwise the source value is
 * written as an opaque gray. Limited to clipRect when supplied.
 * @param {Uint8Array} srcGray source mask channel
 * @param {Uint8Array} dstPixels destination RGBA buffer
 * @param {{x:number, y:number, width:number, height:number}} bounds
 * @param {?{x:number, y:number, width:number, height:number}} clipRect
 * @param {number} invertMode 1 for inverted half-intensity fill, else gray fill
 */
export function renderMaskFillOverlay(srcGray, dstPixels, bounds, clipRect, invertMode) {
  const width = bounds.width;
  const height = bounds.height;
  let minX = 0;
  let minY = 0;
  let maxX = width;
  let maxY = height;
  if (clipRect) {
    minX = clipRect.x - bounds.x;
    minY = clipRect.y - bounds.y;
    maxX = minX + clipRect.width;
    maxY = minY + clipRect.height;
  }
  const dstBuf = new Uint32Array(dstPixels.buffer);
  for (let row = minY; row < maxY; row++) {
    for (let col = minX; col < maxX; col++) {
      const off = row * width + col;
      const value = srcGray[off];
      if (invertMode == 1) dstBuf[off] = 255 - value >>> 1 << 24 | 255;
      else dstBuf[off] = 255 << 24 | (value << 16 | value << 8 | value);
    }
  }
}

function cfaPhaseWriters(cfaPhase) {
  const corner = writeCornerPixel;
  const horiz = writeHorizPixel;
  const vert = writeVertPixel;
  const cross = writeCrossPixel;

  if (cfaPhase === 0) {
    return [corner, horiz, vert, cross];
  }
  if (cfaPhase === 1) {
    return [horiz, corner, cross, vert];
  }
  if (cfaPhase === 2) {
    return [cross, vert, horiz, corner];
  }
  return [vert, cross, corner, horiz];
}

/**
 * @param {Uint8Array} srcGray
 * @param {number} srcStride
 * @param {number} srcHeight
 * @param {Uint8Array} dstRgb
 * @param {number} srcX
 * @param {number} srcY
 * @param {number} destWidth
 * @param {number} destHeight
 * @param {number} cfaPhase
 */
function upsampleBlockWithPhase(srcGray, srcStride, srcHeight, dstRgb, srcX, srcY, destWidth, destHeight, cfaPhase) {
  let colStart = 2;
  let colEnd = srcStride - 2;
  let rowStart = 2;
  if ((srcX & 1) === 1) {
    colStart++;
    colEnd--;
  }
  let rowEnd = srcHeight - 2;
  if ((srcY & 1) === 1) {
    rowStart++;
    rowEnd--;
  }
  if (cfaPhase === 1 || cfaPhase === 3) {
    colStart++;
    colEnd--;
  }

  const scratch = srcGray.slice(0);
  padBorderHoriz(scratch, 0, srcStride);
  padBorderVert(scratch, 0, srcStride, srcHeight);
  padBorderVert(scratch, srcStride - 2, srcStride, srcHeight);
  padBorderHoriz(scratch, (srcHeight - 2) * srcStride, srcStride);

  for (let row = rowStart; row < rowEnd; row += 2) {
    for (let col = colStart; col < colEnd; col += 2) {
      const bufOff = row * srcStride + col;
      const greenEst = edgeDirectedSample(scratch, bufOff, srcStride);
      const redEst = edgeDirectedSample(scratch, bufOff + srcStride + 1, srcStride);
      scratch[bufOff] = Math.max(0, greenEst);
      scratch[bufOff + srcStride + 1] = Math.max(0, redEst);
    }
  }

  let outWidth = destWidth;
  let outHeight = destHeight;
  if (srcY + destHeight === srcHeight) {
    outHeight -= 2;
    splitRowPixels(
      srcGray,
      (srcHeight - 2) * srcStride + srcX,
      srcStride,
      dstRgb,
      (destHeight - 2) * destWidth * 3,
      destWidth,
    );
  }
  if (srcX + destWidth === srcStride) {
    outWidth -= 2;
    splitColPixels(
      srcGray,
      srcY * srcStride + srcX + destWidth - 2,
      srcStride,
      dstRgb,
      (destWidth - 2) * 3,
      destWidth,
      destHeight,
    );
  }

  const [writeA, writeB, writeC, writeD] = cfaPhaseWriters(cfaPhase);
  for (let row = 0; row < outHeight; row += 2) {
    for (let col = 0; col < outWidth; col += 2) {
      let srcOff = (row + srcY) * srcStride + col + srcX;
      let dstOff = (row * destWidth + col) * 3;
      writeA(dstRgb, dstOff, srcGray, scratch, srcOff, srcStride);
      writeB(dstRgb, dstOff + 3, srcGray, scratch, srcOff + 1, srcStride);
      srcOff += srcStride;
      dstOff += 3 * destWidth;
      writeC(dstRgb, dstOff, srcGray, scratch, srcOff, srcStride);
      writeD(dstRgb, dstOff + 3, srcGray, scratch, srcOff + 1, srcStride);
    }
  }
}

export function grayscaleToRgb(srcGray, srcStride, srcHeight, dstRgb, destX, destY, destWidth, destHeight) {
  for (let row = 0; row < destHeight; row++) {
    for (let col = 0; col < destWidth; col++) {
      const dstOff = 3 * (row * destWidth + col);
      const srcRow = row + destY;
      const srcCol = col + destX;
      const gray = srcGray[srcRow * srcStride + srcCol];
      dstRgb[dstOff] = gray;
      dstRgb[dstOff + 1] = gray;
      dstRgb[dstOff + 2] = gray;
    }
  }
}

export function seamColorSample(srcGray, srcStride, srcHeight, dstRgb, destX, destY, destWidth, destHeight, tileSize, tileIndexBuf) {
  const channelScale = [0, 1, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 7, 1 / 8, 1 / 9];
  const tileInv = 1 / tileSize;
  const neighborOff = [-1, -1, 0, -1, 1, -1, -1, 0, 1, 0, -1, 1, 0, 1, 1, 1];
  const channelAcc = new Uint32Array(6);
  for (let row = 0; row < destHeight; row++) {
    for (let col = 0; col < destWidth; col++) {
      const dstOff = 3 * (row * destWidth + col);
      const srcRow = row + destY;
      const srcCol = col + destX;
      channelAcc[0] = 0;
      channelAcc[1] = 0;
      channelAcc[2] = 0;
      channelAcc[3] = 0;
      channelAcc[4] = 0;
      channelAcc[5] = 0;
      for (let nbrIdx = 0; nbrIdx < 16; nbrIdx += 2) {
        const sampleCol = srcCol + neighborOff[nbrIdx];
        const sampleRow = srcRow + neighborOff[nbrIdx + 1];
        const tileCol = sampleCol - tileSize * ~~(sampleCol * tileInv);
        const tileRow = sampleRow - tileSize * ~~(sampleRow * tileInv);
        const channelIdx = tileIndexBuf[tileRow * tileSize + tileCol];
        channelAcc[channelIdx] += srcGray[sampleRow * srcStride + sampleCol];
        channelAcc[channelIdx + 3]++;
      }
      const tileCol = srcCol - tileSize * ~~(srcCol * tileInv);
      const tileRow = srcRow - tileSize * ~~(srcRow * tileInv);
      const centerChannel = tileIndexBuf[tileRow * tileSize + tileCol];
      channelAcc[centerChannel] = srcGray[srcRow * srcStride + srcCol];
      channelAcc[centerChannel + 3] = 1;
      dstRgb[dstOff] = channelAcc[0] * channelScale[channelAcc[3]];
      dstRgb[dstOff + 1] = channelAcc[1] * channelScale[channelAcc[4]];
      dstRgb[dstOff + 2] = channelAcc[2] * channelScale[channelAcc[5]];
    }
  }
}

export function padBorderHoriz(buf, bufOff, rowWidth) {
  for (let col = 0; col < rowWidth; col += 2) {
    buf[bufOff + col] = buf[bufOff + col + 1];
  }
  bufOff = bufOff + rowWidth;
  for (let col = 0; col < rowWidth; col += 2) {
    buf[bufOff + col + 1] = buf[bufOff + col];
  }
}

export function padBorderVert(buf, bufOff, rowStride, rowCount) {
  for (let row = 0; row < rowCount; row += 2) {
    const rowOff = bufOff + row * rowStride;
    buf[rowOff] = buf[rowOff + rowStride];
    buf[rowOff + rowStride + 1] = buf[rowOff + 1];
  }
}

export function splitPixelPair(dstRgb, dstOffA, dstOffB, srcGray, srcIdxA, srcIdxB) {
  const greenAtA = srcGray[srcIdxA];
  const redAtA = srcGray[srcIdxA + 1];
  const greenAtB = srcGray[srcIdxB];
  const redAtB = srcGray[srcIdxB + 1];
  const blendGreen = redAtA + greenAtB >>> 1;
  dstRgb[dstOffA] = dstRgb[dstOffA + 3] = dstRgb[dstOffB] = dstRgb[dstOffB + 3] = greenAtA;
  dstRgb[dstOffA + 1] = blendGreen;
  dstRgb[dstOffA + 4] = redAtA;
  dstRgb[dstOffB + 1] = greenAtB;
  dstRgb[dstOffB + 4] = blendGreen;
  dstRgb[dstOffA + 2] = dstRgb[dstOffA + 5] = dstRgb[dstOffB + 2] = dstRgb[dstOffB + 5] = redAtB;
}

export function splitRowPixels(srcGray, srcOff, srcStride, dstRgb, dstOff, pairCount) {
  const rowRgbStride = pairCount * 3;
  for (let pairIdx = 0; pairIdx < pairCount; pairIdx += 2) {
    const srcIdx = srcOff + pairIdx;
    const dstIdx = dstOff + pairIdx * 3;
    splitPixelPair(dstRgb, dstIdx, dstIdx + rowRgbStride, srcGray, srcIdx, srcIdx + srcStride);
  }
}

export function splitColPixels(srcGray, srcOff, srcStride, dstRgb, dstOff, pairCount, colPairCount) {
  const colRgbStride = pairCount * 3;
  for (let pairIdx = 0; pairIdx < colPairCount; pairIdx += 2) {
    const srcIdx = srcOff + pairIdx * srcStride;
    const dstIdx = dstOff + pairIdx * pairCount * 3;
    splitPixelPair(dstRgb, dstIdx, dstIdx + colRgbStride, srcGray, srcIdx, srcIdx + srcStride);
  }
}

export function edgeDirectedSample(buf, bufOff, rowStride) {
  const neighborUp2 = buf[bufOff - rowStride - rowStride];
  const neighborUp1 = buf[bufOff - rowStride];
  const neighborLeft2 = buf[bufOff - 2];
  const neighborLeft1 = buf[bufOff - 1];
  const centerSample = buf[bufOff];
  const neighborRight1 = buf[bufOff + 1];
  const neighborRight2 = buf[bufOff + 2];
  const neighborDown1 = buf[bufOff + rowStride];
  const neighborDown2 = buf[bufOff + rowStride + rowStride];
  const vertGrad = Math.abs(neighborUp1 - neighborDown1);
  const horizGrad = Math.abs(neighborLeft1 - neighborRight1);
  const diagUpCost = Math.abs(centerSample - neighborUp2) * 2 + vertGrad;
  const diagRightCost = Math.abs(centerSample - neighborRight2) * 2 + horizGrad;
  const diagLeftCost = Math.abs(centerSample - neighborLeft2) * 2 + horizGrad;
  const diagDownCost = Math.abs(centerSample - neighborDown2) * 2 + vertGrad;
  const minCost = Math.min(diagUpCost, Math.min(diagRightCost, Math.min(diagLeftCost, diagDownCost)));
  if (minCost === diagUpCost) {
    return neighborUp1 * 3 + neighborDown1 + centerSample - neighborUp2 >> 2;
  }
  if (minCost === diagRightCost) {
    return neighborRight1 * 3 + neighborLeft1 + centerSample - neighborRight2 >> 2;
  }
  if (minCost === diagLeftCost) {
    return neighborLeft1 * 3 + neighborRight1 + centerSample - neighborLeft2 >> 2;
  }
  return neighborDown1 * 3 + neighborUp1 + centerSample - neighborDown2 >> 2;
}

export function interpolateEdge(edgeA, edgeMid, edgeB, valueA, valueB) {
  if (edgeA < edgeMid && edgeMid < edgeB || edgeA > edgeMid && edgeMid > edgeB) {
    return ~~(0.5 + valueA + (valueB - valueA) * (edgeMid - edgeA) / (edgeB - edgeA));
  }
  return (valueA + valueB >> 1) + (edgeMid + edgeMid - edgeA - edgeB >> 2);
}

export function selectDiagonalInterp(srcGray, scratchBuf, bufOff, rowStride) {
  const scratchNw = scratchBuf[bufOff - rowStride - 1];
  const scratchNe = scratchBuf[bufOff - rowStride + 1];
  const scratchN = scratchBuf[bufOff];
  const scratchSw = scratchBuf[bufOff + rowStride - 1];
  const scratchSe = scratchBuf[bufOff + rowStride + 1];
  const srcNw = srcGray[bufOff - rowStride - 1];
  const srcNe = srcGray[bufOff - rowStride + 1];
  const srcN = srcGray[bufOff];
  const srcSw = srcGray[bufOff + rowStride - 1];
  const srcSe = srcGray[bufOff + rowStride + 1];
  const neSeCost = Math.abs(srcNe - srcSe)
    + Math.abs(srcGray[bufOff - rowStride - rowStride + 2] - srcN)
    + Math.abs(srcN - srcGray[bufOff + rowStride + rowStride - 2])
    + Math.abs(scratchNe - scratchN)
    + Math.abs(scratchN - scratchSw);
  const nwSwCost = Math.abs(srcNw - srcSw)
    + Math.abs(srcGray[bufOff - rowStride - rowStride - 2] - srcN)
    + Math.abs(srcN - srcGray[bufOff + rowStride + rowStride + 2])
    + Math.abs(scratchNw - scratchN)
    + Math.abs(scratchN - scratchSe);
  if (neSeCost < nwSwCost) {
    return interpolateEdge(scratchNe, scratchN, scratchSw, srcNe, srcSe);
  }
  return interpolateEdge(scratchNw, scratchN, scratchSe, srcNw, srcSw);
}

export function writeCornerPixel(dstRgb, dstOff, srcGray, scratchBuf, srcOff, rowStride) {
  dstRgb[dstOff + 0] = srcGray[srcOff];
  dstRgb[dstOff + 1] = scratchBuf[srcOff];
  dstRgb[dstOff + 2] = selectDiagonalInterp(srcGray, scratchBuf, srcOff, rowStride);
}

export function writeHorizPixel(dstRgb, dstOff, srcGray, scratchBuf, srcOff, rowStride) {
  const green = scratchBuf[srcOff];
  dstRgb[dstOff + 0] = interpolateEdge(scratchBuf[srcOff - 1], green, scratchBuf[srcOff + 1], srcGray[srcOff - 1], srcGray[srcOff + 1]);
  dstRgb[dstOff + 1] = green;
  dstRgb[dstOff + 2] = interpolateEdge(scratchBuf[srcOff - rowStride], green, scratchBuf[srcOff + rowStride], srcGray[srcOff - rowStride], srcGray[srcOff + rowStride]);
}

export function writeVertPixel(dstRgb, dstOff, srcGray, scratchBuf, srcOff, rowStride) {
  const green = scratchBuf[srcOff];
  dstRgb[dstOff + 0] = interpolateEdge(scratchBuf[srcOff - rowStride], green, scratchBuf[srcOff + rowStride], srcGray[srcOff - rowStride], srcGray[srcOff + rowStride]);
  dstRgb[dstOff + 1] = green;
  dstRgb[dstOff + 2] = interpolateEdge(scratchBuf[srcOff - 1], green, scratchBuf[srcOff + 1], srcGray[srcOff - 1], srcGray[srcOff + 1]);
}

export function writeCrossPixel(dstRgb, dstOff, srcGray, scratchBuf, srcOff, rowStride) {
  dstRgb[dstOff + 0] = selectDiagonalInterp(srcGray, scratchBuf, srcOff, rowStride);
  dstRgb[dstOff + 1] = scratchBuf[srcOff];
  dstRgb[dstOff + 2] = srcGray[srcOff];
}

export function upsampleBlock(srcGray, srcStride, srcHeight, dstRgb, srcX, srcY, destWidth, destHeight, cfaPhase) {
  upsampleBlockWithPhase(srcGray, srcStride, srcHeight, dstRgb, srcX, srcY, destWidth, destHeight, cfaPhase);
}

/**
 * Two scratch canvases the pattern fills draw through. They are made on first
 * use: a canvas needs a document, which is not there while modules evaluate.
 */
let scratchCanvas = null;
let scratchCtx = null;
function patternScratch() {
  if (scratchCanvas === null) {
    scratchCanvas = document.createElement("canvas");
    scratchCtx = scratchCanvas.getContext("2d");
  }
  return { canvas: scratchCanvas, ctx: scratchCtx };
}

export function patternFromImageData(pixelBuf, width, height) {
  const { canvas, ctx } = patternScratch();
  canvas.width = width;
  canvas.height = height;
  const imageData = new ImageData(new Uint8ClampedArray(pixelBuf.buffer), width, height);
  ctx.putImageData(imageData, 0, 0);
  return ctx.createPattern(canvas, "repeat");
}

export function fillScaledPatternToPlanar(pattern, planarBuf, outWidth, outHeight, scaleX, scaleY, offsetX, offsetY) {
  const imageData = fillTransformedPattern(pattern, outWidth, outHeight, scaleX, scaleY, offsetX, offsetY);
  interleavedToPlanar(imageData.data, planarBuf);
}

export function fillScaledPatternToBuffer(pattern, dstBuf, outWidth, outHeight, scaleX, scaleY, offsetX, offsetY) {
  const imageData = fillTransformedPattern(pattern, outWidth, outHeight, scaleX, scaleY, offsetX, offsetY);
  copyBuffer(imageData.data, dstBuf);
}

export function fillTransformedPattern(pattern, outWidth, outHeight, scaleX, scaleY, offsetX, offsetY) {
  const { canvas, ctx } = patternScratch();
  canvas.width = outWidth;
  canvas.height = outHeight;
  ctx.rect(0, 0, outWidth, outHeight);
  ctx.translate(offsetX, offsetY);
  ctx.scale(scaleX, scaleY);
  ctx.fillStyle = pattern;
  ctx.fill();
  return ctx.getImageData(0, 0, outWidth, outHeight);
}

export function resampleUint8WithMatrix(srcGray, srcRect, matrix, dstGray, dstRect) {
  const invMatrix = matrix.clone();
  invMatrix.invert();
  const dstWidth = dstRect.width;
  const dstHeight = dstRect.height;
  const outlineCoords = rectToPathOutline(srcRect).coords;
  transformCoordPairs(outlineCoords, invMatrix, outlineCoords);
  const clipBounds = pixelAlignBoundsFromCoords(outlineCoords).intersect(dstRect);
  const minX = clipBounds.x;
  const minY = clipBounds.y;
  const maxX = minX + clipBounds.width;
  const maxY = minY + clipBounds.height;
  const srcX0 = ~~srcRect.x;
  const srcY0 = ~~srcRect.y;
  const srcWidth = ~~srcRect.width;
  const srcHeight = ~~srcRect.height;
  for (let dstY = minY; dstY < maxY; dstY++) {
    for (let dstX = minX; dstX < maxX; dstX++) {
      const docX = dstX + 0.5;
      const docY = dstY + 0.5;
      const srcX = matrix.a * docX + matrix.c * docY + matrix.tx - srcX0;
      const srcY = matrix.b * docX + matrix.d * docY + matrix.ty - srcY0;
      if (0 <= srcX && 0 <= srcY && srcX < srcWidth && srcY < srcHeight) {
        dstGray[dstY * dstWidth + dstX] = srcGray[~~srcY * srcWidth + ~~srcX];
      }
    }
  }
}

export function resampleImageBufferWithMatrix(srcPixels, srcRect, matrix, dstPixels, dstRect) {
  const srcBuf = new Uint32Array(srcPixels.buffer);
  const dstBuf = new Uint32Array(dstPixels.buffer);
  const invMatrix = matrix.clone();
  invMatrix.invert();
  const dstWidth = dstRect.width;
  const dstHeight = dstRect.height;
  const outlineCoords = rectToPathOutline(srcRect).coords;
  transformCoordPairs(outlineCoords, invMatrix, outlineCoords);
  const clipBounds = pixelAlignBoundsFromCoords(outlineCoords).intersect(dstRect);
  const minX = clipBounds.x;
  const minY = clipBounds.y;
  const maxX = minX + clipBounds.width;
  const maxY = minY + clipBounds.height;
  const srcX0 = ~~srcRect.x;
  const srcY0 = ~~srcRect.y;
  const srcWidth = ~~srcRect.width;
  const srcHeight = ~~srcRect.height;
  for (let dstY = minY; dstY < maxY; dstY++) {
    for (let dstX = minX; dstX < maxX; dstX++) {
      const docX = dstX + 0.5;
      const docY = dstY + 0.5;
      const srcX = matrix.a * docX + matrix.c * docY + matrix.tx - srcX0;
      const srcY = matrix.b * docX + matrix.d * docY + matrix.ty - srcY0;
      if (0 <= srcX && 0 <= srcY && srcX < srcWidth && srcY < srcHeight) {
        dstBuf[dstY * dstWidth + dstX] = srcBuf[~~srcY * srcWidth + ~~srcX];
      }
    }
  }
}

export function resampleUint8UniformScale(srcGray, srcWidth, srcHeight, dstGray, dstWidth, dstHeight, scale) {
  if (scale < 1) {
    downscaleBlockAverage(srcGray, srcWidth, srcHeight, dstGray, dstWidth, dstHeight, Math.round(1 / scale));
  } else {
    upscaleBlockRepeat(srcGray, srcWidth, srcHeight, dstGray, dstWidth, dstHeight, scale);
  }
}

export function resampleUint32UniformScale(srcPixels, srcWidth, srcHeight, dstPixels, dstWidth, dstHeight, scale, clipRect) {
  if (clipRect) {
    clipRect = clipRect.intersect(new Rect(0, 0, srcWidth, srcHeight));
  }
  srcPixels = new Uint32Array(srcPixels.buffer);
  dstPixels = new Uint32Array(dstPixels.buffer);
  if (scale < 1) {
    downscaleUint32BlockAverage(srcPixels, srcWidth, srcHeight, dstPixels, dstWidth, dstHeight, Math.round(1 / scale), clipRect);
  } else {
    upscaleUint32BlockRepeat(srcPixels, srcWidth, srcHeight, dstPixels, dstWidth, dstHeight, scale);
  }
}

export function upscaleBlockRepeat(srcGray, srcWidth, srcHeight, dstGray, dstWidth, dstHeight, blockSize) {
  for (let srcRow = 0; srcRow < srcHeight; srcRow++) {
    for (let srcCol = 0; srcCol < srcWidth; srcCol++) {
      const value = srcGray[srcRow * srcWidth + srcCol];
      const blockW = Math.min(blockSize, dstWidth - srcCol * blockSize);
      const blockH = Math.min(blockSize, dstHeight - srcRow * blockSize);
      for (let dy = 0; dy < blockH; dy++) {
        for (let dx = 0; dx < blockW; dx++) {
          dstGray[(blockSize * srcRow + dy) * dstWidth + blockSize * srcCol + dx] = value;
        }
      }
    }
  }
}

export function downscaleBlockAverage(srcGray, srcWidth, srcHeight, dstGray, dstWidth, dstHeight, blockSize) {
  for (let dstRow = 0; dstRow < dstHeight; dstRow++) {
    for (let dstCol = 0; dstCol < dstWidth; dstCol++) {
      let sum = 0;
      const blockW = Math.min(blockSize, srcWidth - dstCol * blockSize);
      const blockH = Math.min(blockSize, srcHeight - dstRow * blockSize);
      for (let dy = 0; dy < blockH; dy++) {
        for (let dx = 0; dx < blockW; dx++) {
          sum += srcGray[(blockSize * dstRow + dy) * srcWidth + (blockSize * dstCol + dx)];
        }
      }
      dstGray[dstRow * dstWidth + dstCol] = Math.round(sum / (blockW * blockH));
    }
  }
}

export function upscaleUint32BlockRepeat(srcBuf, srcWidth, srcHeight, dstBuf, dstWidth, dstHeight, blockSize) {
  for (let srcRow = 0; srcRow < srcHeight; srcRow++) {
    for (let srcCol = 0; srcCol < srcWidth; srcCol++) {
      const px = srcBuf[srcRow * srcWidth + srcCol];
      const blockW = Math.min(blockSize, dstWidth - srcCol * blockSize);
      const blockH = Math.min(blockSize, dstHeight - srcRow * blockSize);
      for (let dy = 0; dy < blockH; dy++) {
        for (let dx = 0; dx < blockW; dx++) {
          dstBuf[(blockSize * srcRow + dy) * dstWidth + blockSize * srcCol + dx] = px;
        }
      }
    }
  }
}

export function downscaleUint32BlockAverage(srcBuf, srcWidth, srcHeight, dstBuf, dstWidth, dstHeight, blockSize, clipRect) {
  let colStart = 0;
  let colEnd = dstWidth;
  let rowStart = 0;
  let rowEnd = dstHeight;
  if (clipRect) {
    colStart = Math.floor(clipRect.x / blockSize);
    colEnd = Math.ceil((clipRect.x + clipRect.width) / blockSize);
    rowStart = Math.floor(clipRect.y / blockSize);
    rowEnd = Math.ceil((clipRect.y + clipRect.height) / blockSize);
  }
  for (let dstRow = rowStart; dstRow < rowEnd; dstRow++) {
    for (let dstCol = colStart; dstCol < colEnd; dstCol++) {
      let alphaSum = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      const blockW = Math.min(blockSize, srcWidth - dstCol * blockSize);
      const blockH = Math.min(blockSize, srcHeight - dstRow * blockSize);
      for (let dy = 0; dy < blockH; dy++) {
        for (let dx = 0; dx < blockW; dx++) {
          const px = srcBuf[(blockSize * dstRow + dy) * srcWidth + blockSize * dstCol + dx];
          const alpha = px >>> 24;
          alphaSum += alpha;
          sumR += alpha * (px >>> 16 & 255);
          sumG += alpha * (px >>> 8 & 255);
          sumB += alpha * (px & 255);
        }
      }
      if (alphaSum !== 0) {
        const invAlpha = 1 / alphaSum;
        dstBuf[dstRow * dstWidth + dstCol] = alphaSum / (blockW * blockH) << 24 | sumR * invAlpha << 16 | sumG * invAlpha << 8 | sumB * invAlpha;
      } else {
        dstBuf[dstRow * dstWidth + dstCol] = 0;
      }
    }
  }
}
