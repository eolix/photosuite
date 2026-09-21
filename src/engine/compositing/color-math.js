/**
 * Color space conversion, sRGB/linear LUTs, scratch canvas pooling, and Lab/HSV
 * helpers used by adjustments, filters, and compositing pipelines.
 */

import { multiplyVec4, rgbToXyz, xyzToRgb } from "./color-matrix.js";

const SCRATCH_CANVAS_SIZES = [64, 64, 128, 256, 512, 1024, 2048];

const LUMA_RED = 0.3;
const LUMA_GREEN = 0.59;
const LUMA_BLUE = 0.11;

const SRGB_LINEAR_THRESHOLD = 0.0031308;
const SRGB_TO_LINEAR_THRESHOLD = 0.04045;

const LAB_EPSILON = 903.3;
const LAB_KAPPA = 0.008856;

function createScratchCanvasPool() {
  const contexts = [];
  for (let sizeIdx = 0; sizeIdx < SCRATCH_CANVAS_SIZES.length; sizeIdx++) {
    const side = SCRATCH_CANVAS_SIZES[sizeIdx];
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    contexts.push(canvas.getContext("2d"));
  }
  return contexts;
}

/**
 * The shared scratch canvases, made on first use: a canvas needs a document,
 * which is not there while modules evaluate.
 */
let scratchCanvasPool = null;
function getScratchCanvasPool() {
  if (scratchCanvasPool === null) scratchCanvasPool = createScratchCanvasPool();
  return scratchCanvasPool;
}

/**
 * The sRGB-to-linear and cube-root lookup tables, built on first use. They are
 * a thousand entries each and only the Lab conversions read them.
 */
let srgbLuts = null;
function getSrgbLuts() {
  if (srgbLuts === null) srgbLuts = buildSrgbLookupTables();
  return srgbLuts;
}

export function getScratch2dContext(width, height) {
  const pool = getScratchCanvasPool();
  let poolIdx = 1;
  const maxSide = Math.max(width, height);
  while (poolIdx < pool.length && maxSide > pool[poolIdx].canvas.width) {
    poolIdx++;
  }
  let ctx;
  if (poolIdx == pool.length) {
    ctx = pool[0];
    const canvas = ctx.canvas;
    canvas.width = width;
    canvas.height = height;
  } else {
    ctx = pool[poolIdx];
    ctx.clearRect(0, 0, width, height);
  }
  return ctx;
}

export function hasEnoughColorVariety(rgbaBuffer, width, height) {
  const seenPixels = {};
  let distinctCount = 0;
  let lowAlphaCount = 0;
  const pixels32 = new Uint32Array(rgbaBuffer.buffer);
  const timestamp = Date.now();
  for (let row = 1; row < height - 1; row++) {
    for (let col = 1; col < width - 1; col++) {
      const pixelIndex = row * width + col;
      const pixel = pixels32[pixelIndex];
      if (pixel >>> 24 < 230) {
        lowAlphaCount++;
      }
      if (seenPixels[pixel] == null) {
        seenPixels[pixel] = true;
        distinctCount++;
      }
    }
  }
  if (lowAlphaCount != 0 || distinctCount < 20) {
    return false;
  }
  return true;
}

export function checkerboardCell(row, col, cellSizeLog2) {
  return 255 - ((row >>> cellSizeLog2) + (col >>> cellSizeLog2) & 1) * 51;
}

export function drawCheckerboard(rgba, width, height, cellSize, offsetX, offsetY) {
  if (offsetX == null) {
    offsetX = offsetY = 0;
  }
  cellSize = Math.log(cellSize) / Math.log(2);
  cellSize = Math.round(cellSize);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const byteIndex = row * width + col << 2;
      const grayValue = checkerboardCell(row + offsetY, col + offsetX, cellSize);
      rgba[byteIndex] = rgba[byteIndex + 1] = rgba[byteIndex + 2] = grayValue;
      rgba[byteIndex + 3] = 255;
    }
  }
}

export function rgbToHex(rgb) {
  let hexStr = rgb.toString(16);
  while (hexStr.length < 6) {
    hexStr = "0" + hexStr;
  }
  return hexStr;
}

export function hexToRgb(hex) {
  return parseInt(hex, 16);
}

export function rgbLuminance(rgb) {
  return LUMA_RED * rgb.h + LUMA_GREEN * rgb.l + LUMA_BLUE * rgb.O;
}

export function rgbSaturation(rgb) {
  return Math.max(rgb.h, rgb.l, rgb.O) - Math.min(rgb.h, rgb.l, rgb.O);
}

export function luminanceFromRgb(r, g, b) {
  return LUMA_RED * r + LUMA_GREEN * g + LUMA_BLUE * b;
}

export function saturationFromRgb(r, g, b) {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

export function hueDiff(hueA, hueB) {
  let diff = hueB - hueA;
  const absDiff = Math.abs(diff);
  const diffMinusOne = diff - 1;
  const diffPlusOne = diff + 1;
  if (Math.abs(diffMinusOne) < absDiff) {
    diff = diffMinusOne;
  } else if (Math.abs(diffPlusOne) < absDiff) {
    diff = diffPlusOne;
  }
  return diff;
}

export function linearToSrgb(linear) {
  return linear < SRGB_LINEAR_THRESHOLD ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
}

export function srgbToLinear(srgb) {
  return srgb < SRGB_TO_LINEAR_THRESHOLD ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

export function rgbaToYcbcr(rgba, outYcbcr) {
  const length = Math.min(rgba.length, outYcbcr.length);
  for (let idx = 0; idx < length; idx += 4) {
    const red = rgba[idx];
    const green = rgba[idx + 1];
    const blue = rgba[idx + 2];
    outYcbcr[idx] = 16 + Math.floor(65.481 / 255 * red + 128.553 / 255 * green + 24.966 / 255 * blue + 0.5);
    outYcbcr[idx + 1] = 128 - Math.floor(37.797 / 255 * red - 74.203 / 255 * green + 112 / 255 * blue + 0.5);
    outYcbcr[idx + 2] = 128 + Math.floor(112 / 255 * red - 93.786 / 255 * green - 18.214 / 255 * blue + 0.5);
    outYcbcr[idx + 3] = rgba[idx + 3];
  }
}

function hueFromDominantChannel(maxChannel, r, g, b, delta) {
  switch (maxChannel) {
    case r:
      return (g - b) / delta + (g < b ? 6 : 0);
    case g:
      return (b - r) / delta + 2;
    default:
      return (r - g) / delta + 4;
  }
}

export function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let hue = 0;
  let saturation = 0;
  const lightness = (max + min) * 0.5;
  if (max != min) {
    const delta = max - min;
    saturation = lightness > 0.5 ? delta / (2 - (max + min)) : delta / (max + min);
    hue = hueFromDominantChannel(max, r, g, b, delta);
    hue *= 1 / 6;
  }
  return { hue, saturation, lightness };
}

export function hslHueToComponent(t1, t2, hue) {
  if (hue < 0) {
    hue += 1;
  }
  if (hue > 1) {
    hue -= 1;
  }
  if (hue < 1 / 6) {
    return t1 + (t2 - t1) * 6 * hue;
  }
  if (hue < 1 / 2) {
    return t2;
  }
  if (hue < 2 / 3) {
    return t1 + (t2 - t1) * (2 / 3 - hue) * 6;
  }
  return t1;
}

export function hslToRgb(hue, saturation, lightness) {
  let red;
  let green;
  let blue;
  if (saturation == 0) {
    red = green = blue = lightness;
  } else {
    const chroma = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
    const hueWrap = 2 * lightness - chroma;
    red = hslHueToComponent(hueWrap, chroma, hue + 1 / 3);
    green = hslHueToComponent(hueWrap, chroma, hue);
    blue = hslHueToComponent(hueWrap, chroma, hue - 1 / 3);
  }
  return { h: red, l: green, O: blue };
}

export function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let hue;
  const value = max;
  const delta = max - min;
  const saturation = max == 0 ? 0 : delta / max;
  if (max == min) {
    hue = 0;
  } else {
    hue = hueFromDominantChannel(max, r, g, b, delta);
    hue *= 1 / 6;
  }
  return { hue, saturation, value };
}

export function hsvToRgb(hue, saturation, value) {
  let red;
  let green;
  let blue;
  const sector = Math.floor(hue * 6);
  const frac = hue * 6 - sector;
  const p = value * (1 - saturation);
  const q = value * (1 - frac * saturation);
  const t = value * (1 - (1 - frac) * saturation);
  switch (sector % 6) {
    case 0:
      red = value; green = t; blue = p;
      break;
    case 1:
      red = q; green = value; blue = p;
      break;
    case 2:
      red = p; green = value; blue = t;
      break;
    case 3:
      red = p; green = q; blue = value;
      break;
    case 4:
      red = t; green = p; blue = value;
      break;
    default:
      red = value; green = p; blue = q;
      break;
  }
  return { h: red, l: green, O: blue };
}

function buildSrgbLookupTables() {
  const linearLut = [];
  const cubeRootLut = [];
  for (let idx = 0; idx < 2000; idx++) {
    const normalized = idx / 1000;
    linearLut[idx] = srgbToLinear(normalized);
    cubeRootLut[idx] = normalized > 0.008856 ? Math.pow(normalized, 1 / 3) : (903.3 * normalized + 16) * (1 / 116);
  }
  return [linearLut, cubeRootLut];
}

export function rgbToLab(r, g, b) {
  const linearLut = getSrgbLuts()[0];
  r = linearLut[~~(r * (1000 / 255))];
  g = linearLut[~~(g * (1000 / 255))];
  b = linearLut[~~(b * (1000 / 255))];
  const x = rgbToXyz[0] * r + rgbToXyz[1] * g + rgbToXyz[2] * b;
  const y = rgbToXyz[4] * r + rgbToXyz[5] * g + rgbToXyz[6] * b;
  const z = rgbToXyz[8] * r + rgbToXyz[9] * g + rgbToXyz[10] * b;
  return xyzToLab(x * (100 / 96.72), y * (100 / 100), z * (100 / 81.427));
}

export function xyzToLab(x, y, z) {
  const cubeRootLut = getSrgbLuts()[1];
  const fx = cubeRootLut[~~(x * 1000)];
  const fy = cubeRootLut[~~(y * 1000)];
  const fz = cubeRootLut[~~(z * 1000)];
  return {
    labL: 116 * fy - 16,
    labA: 500 * (fx - fy),
    labB: 200 * (fy - fz),
  };
}

export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116;
  const fyCubed = fy * fy * fy;
  const fzBase = fy - b / 200;
  const fzCubed = fzBase * fzBase * fzBase;
  const fxBase = a / 500 + fy;
  const fxCubed = fxBase * fxBase * fxBase;
  const zLinear = fzCubed > LAB_KAPPA ? fzCubed : (116 * fzBase - 16) / LAB_EPSILON;
  const yLinear = fyCubed > LAB_KAPPA ? fyCubed : (116 * fy - 16) / LAB_EPSILON;
  const xLinear = fxCubed > LAB_KAPPA ? fxCubed : (116 * fxBase - 16) / LAB_EPSILON;
  const xyzX = xLinear * 96.72;
  const xyzY = yLinear * 100;
  const xyzZ = zLinear * 81.427;
  const rgbLinear = multiplyVec4(
    xyzToRgb,
    [xyzX / 100, xyzY / 100, xyzZ / 100, 0],
  );
  for (let idx = 0; idx < 4; idx++) {
    rgbLinear[idx] = Math.max(0, Math.min(255, linearToSrgb(rgbLinear[idx]) * 255));
  }
  return { h: rgbLinear[0], l: rgbLinear[1], O: rgbLinear[2] };
}

/**
 * Ink percentages for an sRGB colour, each 0..1. The separation is the plain
 * one a picker shows without a press profile: black takes as much of the
 * neutral component as it can, and the three inks carry what is left.
 *
 * @param {number} r 0..255
 * @param {number} g 0..255
 * @param {number} b 0..255
 * @returns {{cyan: number, magenta: number, yellow: number, black: number}}
 */
export function rgbToCmyk(r, g, b) {
  const black = 1 - Math.max(r, g, b) / 255;
  if (black >= 1) {
    return { cyan: 0, magenta: 0, yellow: 0, black: 1 };
  }
  const inkRange = 1 - black;
  return {
    cyan: (1 - r / 255 - black) / inkRange,
    magenta: (1 - g / 255 - black) / inkRange,
    yellow: (1 - b / 255 - black) / inkRange,
    black,
  };
}

/**
 * The inverse of {@link rgbToCmyk}: ink percentages back to sRGB 0..255.
 * @returns {{h: number, l: number, O: number}}
 */
export function cmykToRgb(cyan, magenta, yellow, black) {
  const inkRange = 1 - black;
  return {
    h: 255 * Math.max(0, 1 - Math.min(1, cyan * inkRange + black)),
    l: 255 * Math.max(0, 1 - Math.min(1, magenta * inkRange + black)),
    O: 255 * Math.max(0, 1 - Math.min(1, yellow * inkRange + black)),
  };
}

function labAxisDelta(sampleValue, minValue, maxValue, scale) {
  if (sampleValue < minValue) {
    return (minValue - sampleValue) * scale;
  }
  if (maxValue < sampleValue) {
    return (maxValue - sampleValue) * scale;
  }
  return 0;
}

export function labSimilarity(sample, labMin, labMax, fuzziness, invFuzziness) {
  const deltaL = labAxisDelta(sample.labL, labMin.labL, labMax.labL, 1 / 100);
  const deltaA = labAxisDelta(sample.labA, labMin.labA, labMax.labA, 1 / 116);
  const deltaB = labAxisDelta(sample.labB, labMin.labB, labMax.labB, 1 / 116);
  const distance = Math.sqrt(deltaL * deltaL + deltaA * deltaA + deltaB * deltaB) * 1.35;
  return distance <= fuzziness ? Math.min(1, 1.17 * (1 - distance * invFuzziness)) : 0;
}

export function invert(buffer) {
  const words = new Uint32Array(buffer.buffer);
  for (let idx = 0; idx < words.length; idx++) {
    words[idx] = ~words[idx];
  }
}

export function invertRgb(rgba) {
  const length = rgba.length;
  for (let idx = 0; idx < length; idx += 4) {
    rgba[idx] = ~rgba[idx];
    rgba[idx + 1] = ~rgba[idx + 1];
    rgba[idx + 2] = ~rgba[idx + 2];
  }
}

export function invertAlpha(rgba) {
  const length = rgba.length;
  for (let idx = 3; idx < length; idx += 4) {
    rgba[idx] = ~rgba[idx];
  }
}


