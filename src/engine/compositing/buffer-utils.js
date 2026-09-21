/**
 * Byte-buffer utilities and the planar RGBA container type for compositing.
 *
 * Planar channel keys follow the compositing wire layout:
 * {@code h}=red, {@code l}=green, {@code O}=blue, {@code w}=alpha.
 */
import { Rect } from "../../core/math/rect.js";


const DEFAULT_LUMA_WEIGHTS = [0.3, 0.59, 0.11];

const MASK_BYTE = 255;
const MASK_LOW16 = 65280;
const MASK_HIGH16 = 16711680;
const MASK_HIGH8 = 4278190080;

/**
 * Converts interleaved RGBA bytes to a single-channel grayscale buffer.
 */
export function rgbaToGrayChannel(rgba, gray, weights) {
  const length = rgba.length;
  let weightR = DEFAULT_LUMA_WEIGHTS[0];
  let weightG = DEFAULT_LUMA_WEIGHTS[1];
  let weightB = DEFAULT_LUMA_WEIGHTS[2];
  if (weights) {
    weightR = weights[0];
    weightG = weights[1];
    weightB = weights[2];
  }
  for (let idx = 0; idx < length; idx += 4) {
    gray[idx >> 2] = ~~(rgba[idx] * weightR + rgba[idx + 1] * weightG + rgba[idx + 2] * weightB + 0.5);
  }
}

export function grayChannelToRgba(gray, rgba) {
  const length = rgba.length;
  for (let idx = 0; idx < length; idx += 4) {
    const grayVal = gray[idx >>> 2];
    rgba[idx] = grayVal;
    rgba[idx + 1] = grayVal;
    rgba[idx + 2] = grayVal;
  }
}

function packFourPlanarPixels(out32, idx, byte3Plane32, byte2Plane32, byte1Plane32, byte0Plane32) {
  const byte3Packed = byte3Plane32[idx >> 2];
  const byte2Packed = byte2Plane32[idx >> 2];
  const byte1Packed = byte1Plane32[idx >> 2];
  const byte0Packed = byte0Plane32[idx >> 2];
  out32[idx] = byte3Packed << 24 | (byte2Packed & MASK_BYTE) << 16 | (byte1Packed & MASK_BYTE) << 8 | byte0Packed & MASK_BYTE;
  out32[idx + 1] = (byte3Packed & MASK_LOW16) << 16 | (byte2Packed & MASK_LOW16) << 8 | byte1Packed & MASK_LOW16 | (byte0Packed & MASK_LOW16) >>> 8;
  out32[idx + 2] = (byte3Packed & MASK_HIGH16) << 8 | byte2Packed & MASK_HIGH16 | (byte1Packed & MASK_HIGH16) >>> 8 | (byte0Packed & MASK_HIGH16) >>> 16;
  out32[idx + 3] = byte3Packed & MASK_HIGH8 | (byte2Packed & MASK_HIGH8) >>> 8 | (byte1Packed & MASK_HIGH8) >>> 16 | (byte0Packed & MASK_HIGH8) >>> 24;
}

function unpackFourInterleavedPixels(in32, idx, byte3Plane32, byte2Plane32, byte1Plane32, byte0Plane32) {
  const word0 = in32[idx];
  const word1 = in32[idx + 1];
  const word2 = in32[idx + 2];
  const word3 = in32[idx + 3];
  byte0Plane32[idx >> 2] = word0 & MASK_BYTE | (word1 & MASK_BYTE) << 8 | (word2 & MASK_BYTE) << 16 | word3 << 24;
  byte1Plane32[idx >> 2] = (word0 & MASK_LOW16) >> 8 | word1 & MASK_LOW16 | (word2 & MASK_LOW16) << 8 | (word3 & MASK_LOW16) << 16;
  byte3Plane32[idx >> 2] = word0 >>> 24 | word1 >>> 24 << 8 | word2 >>> 24 << 16 | word3 & MASK_HIGH8;
  byte2Plane32[idx >> 2] = (word0 & MASK_HIGH16) >> 16 | (word1 & MASK_HIGH16) >> 8 | word2 & MASK_HIGH16 | (word3 & MASK_HIGH16) << 8;
}

export function planarToInterleaved(planar, interleaved) {
  const byte0Plane = planar.h;
  const byte1Plane = planar.l;
  const byte2Plane = planar.O;
  const byte3Plane = planar.w;
  const length = Math.min(planar.h.length, interleaved.buffer.byteLength >>> 2);
  const bulkLength = 4 * Math.floor(length / 4);
  const out32 = new Uint32Array(interleaved.buffer);
  const byte3Plane32 = new Uint32Array(byte3Plane.buffer);
  const byte2Plane32 = new Uint32Array(byte2Plane.buffer);
  const byte1Plane32 = new Uint32Array(byte1Plane.buffer);
  const byte0Plane32 = new Uint32Array(byte0Plane.buffer);
  for (let idx = 0; idx < bulkLength; idx += 4) {
    packFourPlanarPixels(out32, idx, byte3Plane32, byte2Plane32, byte1Plane32, byte0Plane32);
  }
  for (let idx = bulkLength; idx < length; idx++) {
    out32[idx] = byte3Plane[idx] << 24 | byte2Plane[idx] << 16 | byte1Plane[idx] << 8 | byte0Plane[idx];
  }
}

export function interleavedToPlanar(interleaved, planar) {
  const byte0Plane = planar.h;
  const byte1Plane = planar.l;
  const byte2Plane = planar.O;
  const byte3Plane = planar.w;
  const length = Math.min(planar.h.length, interleaved.buffer.byteLength >>> 2);
  const bulkLength = 4 * Math.floor(length / 4);
  const in32 = new Uint32Array(interleaved.buffer);
  const byte3Plane32 = new Uint32Array(byte3Plane.buffer);
  const byte2Plane32 = new Uint32Array(byte2Plane.buffer);
  const byte1Plane32 = new Uint32Array(byte1Plane.buffer);
  const byte0Plane32 = new Uint32Array(byte0Plane.buffer);
  for (let idx = 0; idx < bulkLength; idx += 4) {
    unpackFourInterleavedPixels(in32, idx, byte3Plane32, byte2Plane32, byte1Plane32, byte0Plane32);
  }
  for (let idx = bulkLength; idx < length; idx++) {
    const pixel = in32[idx];
    byte0Plane[idx] = pixel >> 0 & MASK_BYTE;
    byte1Plane[idx] = pixel >> 8 & MASK_BYTE;
    byte2Plane[idx] = pixel >> 16 & MASK_BYTE;
    byte3Plane[idx] = pixel >> 24 & MASK_BYTE;
  }
}

export function extractChannelByte(rgba, channel, channelIndex) {
  const rgbaBytes = new Uint8Array(rgba.buffer);
  const count = Math.min(rgbaBytes.length / 4, channel.length);
  for (let idx = 0; idx < count; idx++) {
    channel[idx] = rgbaBytes[(idx << 2) + channelIndex];
  }
}

export function extractChannel(rgba, out, channelIndex) {
  const outBytes = new Uint8Array(out.buffer);
  const rgba32 = new Uint32Array(rgba.buffer);
  const count = Math.min(outBytes.length / 4, rgba.length);
  let idx = 0;
  while (idx + 4 < count) {
    const word = rgba32[idx >>> 2];
    outBytes[(idx << 2) + channelIndex] = word & MASK_BYTE;
    outBytes[(idx << 2) + channelIndex + 4] = word >>> 8 & MASK_BYTE;
    outBytes[(idx << 2) + channelIndex + 8] = word >>> 16 & MASK_BYTE;
    outBytes[(idx << 2) + channelIndex + 12] = word >>> 24;
    idx += 4;
  }
  while (idx < count) {
    outBytes[(idx << 2) + channelIndex] = rgba[idx];
    idx++;
  }
}

export function fillBuffer(buffer, value, mask) {
  if (mask == null) {
    mask = 0;
  }
  const words = new Uint32Array(buffer.buffer);
  for (let idx = 0; idx < words.length; idx++) {
    words[idx] = words[idx] & mask | value;
  }
}

export function fillBufferRect(buffer, bounds, fillRect, value, mask) {
  if (mask == null) {
    mask = 0;
  }
  const words = new Uint32Array(buffer.buffer);
  fillRect = fillRect.intersect(bounds);
  const offsetX = fillRect.x - bounds.x;
  const offsetY = fillRect.y - bounds.y;
  const fillWidth = fillRect.width;
  const fillHeight = fillRect.height;
  const boundsWidth = bounds.width;
  for (let row = 0; row < fillHeight; row++) {
    let idx = (offsetY + row) * boundsWidth + offsetX;
    for (let col = 0; col < fillWidth; col++) {
      words[idx] = words[idx] & mask | value;
      idx++;
    }
  }
}

export function copyBuffer(src, dst) {
  const byteLength = Math.min(src.buffer.byteLength, dst.buffer.byteLength);
  const wordCount = byteLength >>> 2;
  const srcWords = new Uint32Array(src.buffer, 0, wordCount);
  const dstWords = new Uint32Array(dst.buffer, 0, wordCount);
  dstWords.set(srcWords);
}

export function equals(a, b) {
  const byteLengthA = a.buffer.byteLength;
  const byteLengthB = b.buffer.byteLength;
  if (byteLengthA != byteLengthB) {
    return false;
  }
  const wordsA = new Uint32Array(a.buffer, 0, byteLengthA >> 2);
  const wordsB = new Uint32Array(b.buffer, 0, byteLengthB >> 2);
  for (let idx = 0; idx < wordsA.length; idx++) {
    if (wordsB[idx] != wordsA[idx]) {
      return false;
    }
  }
  return true;
}

export function alignToFour(size) {
  return size + (size % 4 == 0 ? 0 : 4 - size % 4);
}

export function allocBuffer(byteLength, skipAlign) {
  if (skipAlign == null) {
    skipAlign = false;
  }
  if (!skipAlign) {
    byteLength = alignToFour(byteLength);
  }
  try {
    return new Uint8Array(byteLength);
  } catch (ramError) {
    alert("Not enough RAM! (need " + Math.round(byteLength / (1 << 20)) + " MB)", 7000);
    throw "low_ram";
  }
}

function appendMipLevel(mipChain, level) {
  mipChain.push(level.buffer, level.rect);
}

export function buildMipPyramidAlpha(mipChain) {
  let srcBuffer = mipChain[mipChain.length - 2];
  let srcRect = mipChain[mipChain.length - 1];
  while (srcRect.width >= 2 && srcRect.height >= 2) {
    const level = downsampleHalfAlphaWeighted(srcBuffer, srcRect);
    appendMipLevel(mipChain, level);
    srcBuffer = level.buffer;
    srcRect = level.rect;
  }
}

/**
 * Halve a single channel with a 2×2 box average (rounded). Pass `channel == null`
 * to compute only the destination rect.
 * @returns {{ buffer?: Uint8Array, rect: Rect }}
 */
export function downsampleHalfChannel(channel, rect, reuseBuffer) {
  const srcWidth = rect.width;
  const dstWidth = srcWidth >> 1;
  const dstHeight = rect.height >> 1;
  const dstRect = new Rect(rect.x, rect.y, dstWidth, dstHeight);
  if (channel == null) {
    return { rect: dstRect };
  }
  const out = reuseBuffer && reuseBuffer.length >= dstWidth * dstHeight
    ? reuseBuffer
    : allocBuffer(dstWidth * dstHeight);
  for (let row = 0; row < dstHeight; row++) {
    const dstRowOff = row * dstWidth;
    for (let col = 0; col < dstWidth; col++) {
      const srcOff = (row << 1) * srcWidth + (col << 1);
      out[dstRowOff + col] =
        (2 + channel[srcOff] + channel[srcOff + 1] + channel[srcOff + srcWidth] + channel[srcOff + srcWidth + 1]) >>> 2;
    }
  }
  return { rect: dstRect, buffer: out };
}

/**
 * Scale a single channel to 2/3 size, mapping each 3×3 source block to a 2×2
 * destination block with weighted averages summing to 9.
 * @returns {{ buffer?: Uint8Array, rect: Rect }}
 */
export function downsampleTwoThirdsChannel(channel, rect, reuseBuffer) {
  const srcWidth = rect.width;
  const dstWidth = 2 * Math.floor(srcWidth / 3);
  const dstHeight = 2 * Math.floor(rect.height / 3);
  const dstRect = new Rect(rect.x, rect.y, dstWidth, dstHeight);
  if (channel == null) {
    return { rect: dstRect };
  }
  const out = reuseBuffer && reuseBuffer.length >= dstWidth * dstHeight
    ? reuseBuffer
    : allocBuffer(dstWidth * dstHeight);
  const inv9 = 1 / 9;
  for (let row = 0; row < dstHeight; row += 2) {
    for (let col = 0; col < dstWidth; col += 2) {
      const dstOff = row * dstWidth + col;
      const srcOff = ((row * 3) >>> 1) * srcWidth + ((col * 3) >>> 1);
      const topLeft = channel[srcOff] << 2;
      const topMid = channel[srcOff + 1] << 1;
      const topRight = channel[srcOff + 2] << 2;
      const midLeft = channel[srcOff + srcWidth] << 1;
      const center = channel[srcOff + 1 + srcWidth];
      const midRight = channel[srcOff + 2 + srcWidth] << 1;
      const botLeft = channel[srcOff + srcWidth + srcWidth] << 2;
      const botMid = channel[srcOff + 1 + srcWidth + srcWidth] << 1;
      const botRight = channel[srcOff + 2 + srcWidth + srcWidth] << 2;
      out[dstOff] = ~~(0.5 + (topLeft + topMid + midLeft + center) * inv9);
      out[dstOff + 1] = ~~(0.5 + (topRight + topMid + midRight + center) * inv9);
      out[dstOff + dstWidth] = ~~(0.5 + (botLeft + botMid + midLeft + center) * inv9);
      out[dstOff + dstWidth + 1] = ~~(0.5 + (botRight + botMid + midRight + center) * inv9);
    }
  }
  return { rect: dstRect, buffer: out };
}

export function buildMipPyramidBox(mipChain) {
  let srcBuffer = mipChain[mipChain.length - 2];
  let srcRect = mipChain[mipChain.length - 1];
  while (srcRect.width >= 2 && srcRect.height >= 2) {
    const level = downsampleHalfChannel(srcBuffer, srcRect);
    appendMipLevel(mipChain, level);
    srcBuffer = level.buffer;
    srcRect = level.rect;
  }
}

function packRgbaWord(red, green, blue, alpha) {
  return alpha << 24 | blue << 16 | green << 8 | red;
}

function averageOpaqueQuadrant(topLeft, topRight, bottomLeft, bottomRight) {
  const red = (topLeft >>> 0 & MASK_BYTE) + (topRight >>> 0 & MASK_BYTE) + (bottomLeft >>> 0 & MASK_BYTE) + (bottomRight >>> 0 & MASK_BYTE) + 2 >>> 2;
  const green = (topLeft >>> 8 & MASK_BYTE) + (topRight >>> 8 & MASK_BYTE) + (bottomLeft >>> 8 & MASK_BYTE) + (bottomRight >>> 8 & MASK_BYTE) + 2 >>> 2;
  const blue = (topLeft >>> 16 & MASK_BYTE) + (topRight >>> 16 & MASK_BYTE) + (bottomLeft >>> 16 & MASK_BYTE) + (bottomRight >>> 16 & MASK_BYTE) + 2 >>> 2;
  return packRgbaWord(red, green, blue, 255);
}

function averageAlphaWeightedQuadrant(topLeft, topRight, bottomLeft, bottomRight) {
  const alphaTL = topLeft >>> 24;
  const alphaTR = topRight >>> 24;
  const alphaBL = bottomLeft >>> 24;
  const alphaBR = bottomRight >>> 24;
  const alphaSum = alphaTL + alphaTR + alphaBL + alphaBR;
  if (alphaSum == 1020) {
    return averageOpaqueQuadrant(topLeft, topRight, bottomLeft, bottomRight);
  }
  if (alphaSum == 0) {
    return 0;
  }
  let red = (topLeft >>> 0 & MASK_BYTE) * alphaTL + (topRight >>> 0 & MASK_BYTE) * alphaTR + (bottomLeft >>> 0 & MASK_BYTE) * alphaBL + (bottomRight >>> 0 & MASK_BYTE) * alphaBR;
  let green = (topLeft >>> 8 & MASK_BYTE) * alphaTL + (topRight >>> 8 & MASK_BYTE) * alphaTR + (bottomLeft >>> 8 & MASK_BYTE) * alphaBL + (bottomRight >>> 8 & MASK_BYTE) * alphaBR;
  let blue = (topLeft >>> 16 & MASK_BYTE) * alphaTL + (topRight >>> 16 & MASK_BYTE) * alphaTR + (bottomLeft >>> 16 & MASK_BYTE) * alphaBL + (bottomRight >>> 16 & MASK_BYTE) * alphaBR;
  const invAlphaSum = 1 / alphaSum;
  red = ~~(red * invAlphaSum + 0.5);
  green = ~~(green * invAlphaSum + 0.5);
  blue = ~~(blue * invAlphaSum + 0.5);
  return packRgbaWord(red, green, blue, alphaSum + 2 >>> 2);
}

export function downsampleHalfAlphaWeighted(src, srcRect, dst) {
  const srcWidth = srcRect.width;
  const srcHeight = srcRect.height;
  const dstWidth = srcWidth >> 1;
  const dstHeight = srcHeight >> 1;
  const dstRect = new Rect(srcRect.x, srcRect.y, dstWidth, dstHeight);
  const dstBuffer = dst && dst.length == dstWidth * dstHeight * 4 ? dst : allocBuffer(dstWidth * dstHeight * 4);
  const src32 = new Uint32Array(src.buffer);
  const dst32 = new Uint32Array(dstBuffer.buffer);
  for (let dstRow = 0; dstRow < dstHeight; dstRow++) {
    for (let dstCol = 0; dstCol < dstWidth; dstCol++) {
      const dstIndex = dstRow * dstWidth + dstCol;
      const srcIndex = (dstRow << 1) * srcWidth + (dstCol << 1);
      dst32[dstIndex] = averageAlphaWeightedQuadrant(
        src32[srcIndex],
        src32[srcIndex + 1],
        src32[srcIndex + srcWidth],
        src32[srcIndex + srcWidth + 1],
      );
    }
  }
  return { rect: dstRect, buffer: dstBuffer };
}

function averageBoxQuadrant(topLeft, topRight, bottomLeft, bottomRight) {
  const red = 2 + (topLeft >>> 0 & MASK_BYTE) + (topRight >>> 0 & MASK_BYTE) + (bottomLeft >>> 0 & MASK_BYTE) + (bottomRight >>> 0 & MASK_BYTE) >>> 2;
  const green = 2 + (topLeft >>> 8 & MASK_BYTE) + (topRight >>> 8 & MASK_BYTE) + (bottomLeft >>> 8 & MASK_BYTE) + (bottomRight >>> 8 & MASK_BYTE) >>> 2;
  const blue = 2 + (topLeft >>> 16 & MASK_BYTE) + (topRight >>> 16 & MASK_BYTE) + (bottomLeft >>> 16 & MASK_BYTE) + (bottomRight >>> 16 & MASK_BYTE) >>> 2;
  const alpha = 2 + (topLeft >>> 24 & MASK_BYTE) + (topRight >>> 24 & MASK_BYTE) + (bottomLeft >>> 24 & MASK_BYTE) + (bottomRight >>> 24 & MASK_BYTE) >>> 2;
  return packRgbaWord(red, green, blue, alpha);
}

export function downsampleHalfBox(src, srcRect, dst) {
  const srcWidth = srcRect.width;
  const srcHeight = srcRect.height;
  const dstWidth = srcWidth >> 1;
  const dstHeight = srcHeight >> 1;
  const dstRect = new Rect(srcRect.x, srcRect.y, dstWidth, dstHeight);
  const dstBuffer = dst && dst.length == dstWidth * dstHeight * 4 ? dst : allocBuffer(dstWidth * dstHeight * 4);
  const src32 = new Uint32Array(src.buffer);
  const dst32 = new Uint32Array(dstBuffer.buffer);
  for (let dstRow = 0; dstRow < dstHeight; dstRow++) {
    for (let dstCol = 0; dstCol < dstWidth; dstCol++) {
      const dstIndex = dstRow * dstWidth + dstCol;
      const srcIndex = (dstRow << 1) * srcWidth + (dstCol << 1);
      dst32[dstIndex] = averageBoxQuadrant(
        src32[srcIndex],
        src32[srcIndex + 1],
        src32[srcIndex + srcWidth],
        src32[srcIndex + srcWidth + 1],
      );
    }
  }
  return { rect: dstRect, buffer: dstBuffer };
}

function weightedAlphaSample(pixel, alphaShift) {
  const alphaWeight = pixel >>> 24 << alphaShift;
  return {
    alphaWeight,
    redWeight: (pixel >>> 16 & MASK_BYTE) * alphaWeight,
    greenWeight: (pixel >>> 8 & MASK_BYTE) * alphaWeight,
    blueWeight: (pixel & MASK_BYTE) * alphaWeight,
  };
}

function weightedBoxSample(pixel, channelShift) {
  return {
    red: (pixel >>> 16 & MASK_BYTE) << channelShift,
    green: (pixel >>> 8 & MASK_BYTE) << channelShift,
    blue: (pixel & MASK_BYTE) << channelShift,
  };
}

function blendWeightedAlphaBlock(samples, invAlpha) {
  const red = ~~(0.5 + (samples[0].blueWeight + samples[1].blueWeight + samples[2].blueWeight + samples[3].blueWeight) * invAlpha);
  const green = ~~(0.5 + (samples[0].greenWeight + samples[1].greenWeight + samples[2].greenWeight + samples[3].greenWeight) * invAlpha);
  const blue = ~~(0.5 + (samples[0].redWeight + samples[1].redWeight + samples[2].redWeight + samples[3].redWeight) * invAlpha);
  const alpha = ~~(0.5 + (samples[0].alphaWeight + samples[1].alphaWeight + samples[2].alphaWeight + samples[3].alphaWeight) * (1 / 9));
  return packRgbaWord(red, green, blue, alpha);
}

function blendWeightedBoxBlock(samples) {
  const red = ~~(0.5 + (samples[0].blue + samples[1].blue + samples[2].blue + samples[3].blue) * (1 / 9));
  const green = ~~(0.5 + (samples[0].green + samples[1].green + samples[2].green + samples[3].green) * (1 / 9));
  const blue = ~~(0.5 + (samples[0].red + samples[1].red + samples[2].red + samples[3].red) * (1 / 9));
  return packRgbaWord(red, green, blue, 255);
}

export function downsampleTwoThirdsAlphaWeighted(src, srcRect, dst) {
  const srcWidth = srcRect.width;
  const srcHeight = srcRect.height;
  const dstWidth = 2 * Math.floor(srcWidth / 3);
  const dstHeight = 2 * Math.floor(srcHeight / 3);
  const dstRect = new Rect(srcRect.x, srcRect.y, dstWidth, dstHeight);
  const dstBuffer = dst && dst.length == dstWidth * dstHeight * 4 ? dst : allocBuffer(dstWidth * dstHeight * 4);
  const src32 = new Uint32Array(src.buffer);
  const dst32 = new Uint32Array(dstBuffer.buffer);
  for (let dstRow = 0; dstRow < dstHeight; dstRow += 2) {
    for (let dstCol = 0; dstCol < dstWidth; dstCol += 2) {
      const dstIndex = dstRow * dstWidth + dstCol;
      const srcIndex = (dstRow * 3 >>> 1) * srcWidth + (dstCol * 3 >>> 1);
      const sample00 = src32[srcIndex];
      const sample01 = src32[srcIndex + 1];
      const sample02 = src32[srcIndex + 2];
      const sample10 = src32[srcIndex + srcWidth];
      const sample11 = src32[srcIndex + 1 + srcWidth];
      const sample12 = src32[srcIndex + 2 + srcWidth];
      const sample20 = src32[srcIndex + srcWidth + srcWidth];
      const sample21 = src32[srcIndex + 1 + srcWidth + srcWidth];
      const sample22 = src32[srcIndex + 2 + srcWidth + srcWidth];
      const weighted00 = weightedAlphaSample(sample00, 2);
      const weighted01 = weightedAlphaSample(sample01, 1);
      const weighted02 = weightedAlphaSample(sample02, 2);
      const weighted10 = weightedAlphaSample(sample10, 1);
      const weighted11 = weightedAlphaSample(sample11, 0);
      const weighted12 = weightedAlphaSample(sample12, 1);
      const weighted20 = weightedAlphaSample(sample20, 2);
      const weighted21 = weightedAlphaSample(sample21, 1);
      const weighted22 = weightedAlphaSample(sample22, 2);
      const alphaSum00 = weighted00.alphaWeight + weighted01.alphaWeight + weighted10.alphaWeight + weighted11.alphaWeight;
      const alphaSum01 = weighted02.alphaWeight + weighted01.alphaWeight + weighted12.alphaWeight + weighted11.alphaWeight;
      const alphaSum10 = weighted20.alphaWeight + weighted21.alphaWeight + weighted10.alphaWeight + weighted11.alphaWeight;
      const alphaSum11 = weighted22.alphaWeight + weighted21.alphaWeight + weighted12.alphaWeight + weighted11.alphaWeight;
      const invAlpha00 = alphaSum00 == 0 ? 0 : 1 / alphaSum00;
      const invAlpha01 = alphaSum01 == 0 ? 0 : 1 / alphaSum01;
      const invAlpha10 = alphaSum10 == 0 ? 0 : 1 / alphaSum10;
      const invAlpha11 = alphaSum11 == 0 ? 0 : 1 / alphaSum11;
      dst32[dstIndex] = blendWeightedAlphaBlock([weighted00, weighted01, weighted10, weighted11], invAlpha00);
      dst32[dstIndex + 1] = blendWeightedAlphaBlock([weighted02, weighted01, weighted12, weighted11], invAlpha01);
      dst32[dstIndex + dstWidth] = blendWeightedAlphaBlock([weighted20, weighted21, weighted10, weighted11], invAlpha10);
      dst32[dstIndex + dstWidth + 1] = blendWeightedAlphaBlock([weighted22, weighted21, weighted12, weighted11], invAlpha11);
    }
  }
  return { rect: dstRect, buffer: dstBuffer };
}

export function downsampleTwoThirdsBox(src, srcRect, dst) {
  const srcWidth = srcRect.width;
  const srcHeight = srcRect.height;
  const dstWidth = 2 * Math.floor(srcWidth / 3);
  const dstHeight = 2 * Math.floor(srcHeight / 3);
  const dstRect = new Rect(srcRect.x, srcRect.y, dstWidth, dstHeight);
  const dstBuffer = dst && dst.length == dstWidth * dstHeight * 4 ? dst : allocBuffer(dstWidth * dstHeight * 4);
  const src32 = new Uint32Array(src.buffer);
  const dst32 = new Uint32Array(dstBuffer.buffer);
  for (let dstRow = 0; dstRow < dstHeight; dstRow += 2) {
    for (let dstCol = 0; dstCol < dstWidth; dstCol += 2) {
      const dstIndex = dstRow * dstWidth + dstCol;
      const srcIndex = (dstRow * 3 >>> 1) * srcWidth + (dstCol * 3 >>> 1);
      const box00 = weightedBoxSample(src32[srcIndex], 2);
      const box01 = weightedBoxSample(src32[srcIndex + 1], 1);
      const box02 = weightedBoxSample(src32[srcIndex + 2], 2);
      const box10 = weightedBoxSample(src32[srcIndex + srcWidth], 1);
      const box11 = weightedBoxSample(src32[srcIndex + 1 + srcWidth], 0);
      const box12 = weightedBoxSample(src32[srcIndex + 2 + srcWidth], 1);
      const box20 = weightedBoxSample(src32[srcIndex + srcWidth + srcWidth], 2);
      const box21 = weightedBoxSample(src32[srcIndex + 1 + srcWidth + srcWidth], 1);
      const box22 = weightedBoxSample(src32[srcIndex + 2 + srcWidth + srcWidth], 2);
      dst32[dstIndex] = blendWeightedBoxBlock([box00, box01, box10, box11]);
      dst32[dstIndex + 1] = blendWeightedBoxBlock([box02, box01, box12, box11]);
      dst32[dstIndex + dstWidth] = blendWeightedBoxBlock([box20, box21, box10, box11]);
      dst32[dstIndex + dstWidth + 1] = blendWeightedBoxBlock([box22, box21, box12, box11]);
    }
  }
  return { rect: dstRect, buffer: dstBuffer };
}

/**
 * Deep-copies planar channel buffers onto a fresh buffer instance.
 * The one-pixel allocation is a placeholder: each plane is replaced with a
 * sliced copy immediately after, so its size never matters.
 *
 * @param {{ w: Uint8Array, h: Uint8Array, l: Uint8Array, O: Uint8Array }} source
 */
function clonePlanarPlanes(source) {
  const copy = new PlanarRgbaBuffer(1);
  copy.w = source.w.slice(0);
  copy.h = source.h.slice(0);
  copy.l = source.l.slice(0);
  copy.O = source.O.slice(0);
  return copy;
}

/**
 * Four separate byte planes for one image. The plane names are the app's
 * internal convention, not RGBA order — see the planar/interleaved converters.
 */
export function PlanarRgbaBuffer(pixelCount) {
  this.w = allocBuffer(pixelCount);
  this.h = allocBuffer(pixelCount);
  this.l = allocBuffer(pixelCount);
  this.O = allocBuffer(pixelCount)
}

PlanarRgbaBuffer.prototype.clone = function () {
  return clonePlanarPlanes(this);
};
