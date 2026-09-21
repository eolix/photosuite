/**
 * PSD gradient descriptors, color conversion, and gradient rasterization.
 *
 * Gradient building and PSD colour descriptors:
 * clamp/quantize utilities, gradient position functions and renderers, PSD color
 * descriptors ↔ RGB, LUT builders, and linear-gradient geometry.
 */

import { Point } from '../../core/math/point.js';
import { hsvToRgb, labToRgb } from "./color-math.js";

const LUT_MAX = 1023;
const LOCATION_SCALE = 4096;
const INV_LOCATION_SCALE = 1 / LOCATION_SCALE;
const CHANNEL_COUNT = 4;

const GRADIENT_STYLE_LINEAR = 0;
const GRADIENT_STYLE_RADIAL = 1;
const GRADIENT_STYLE_ANGULAR = 2;
const GRADIENT_STYLE_REFLECTED = 3;
const GRADIENT_STYLE_DIAMOND = 4;
const GRADIENT_STYLE_MESH = 5;

const FLOYD_STEINBERG_WEIGHTS = Object.freeze([
  7 / 16,
  3 / 16,
  5 / 16,
  1 / 16,
]);

/**
 * Map normalized gradient coordinates to a scalar position for LUT lookup.
 * @param {number} style gradient style index (0–4)
 * @param {number} u transformed x
 * @param {number} v transformed y
 * @returns {number}
 */
function gradientPositionForStyle(style, u, v) {
  if (style === GRADIENT_STYLE_LINEAR) return u + 0.5;
  if (style === GRADIENT_STYLE_RADIAL) return 2 * Math.sqrt(u * u + v * v);
  if (style === GRADIENT_STYLE_ANGULAR) return (Math.PI + Math.atan2(-v, -u)) / (2 * Math.PI);
  if (style === GRADIENT_STYLE_REFLECTED) return Math.abs(u * 2);
  if (style === GRADIENT_STYLE_DIAMOND) return 2 * (Math.abs(u) + Math.abs(v));
  return 0;
}

/** @param {number} width pixel row width */
function allocateErrorBuffers(width) {
  const byteLength = width * CHANNEL_COUNT + 8;
  return {
    errCur: new Float64Array(byteLength),
    errNext: new Float64Array(byteLength),
  };
}

/**
 * Quantize one channel with Floyd–Steinberg dithering.
 * @returns {number} quantized byte value (0–255)
 */
function floydSteinbergQuantizeChannel(sample, errCur, errNext, errOffset, channelIndex) {
  const clamped = Math.max(0, Math.min(254.999, sample + errCur[errOffset + 4 + channelIndex]));
  let quant = Math.floor(clamped);
  if (Math.random() < clamped - quant) quant++;
  const frac = clamped - quant;
  errCur[errOffset + 8 + channelIndex] = frac * FLOYD_STEINBERG_WEIGHTS[0];
  errNext[errOffset + 0 + channelIndex] = frac * FLOYD_STEINBERG_WEIGHTS[1];
  errNext[errOffset + 4 + channelIndex] = frac * FLOYD_STEINBERG_WEIGHTS[2];
  errNext[errOffset + 8 + channelIndex] = frac * FLOYD_STEINBERG_WEIGHTS[3];
  return quant;
}

/**
 * Resolve one color-stop entry to `{ h, l, O }` RGB channels.
 */
function parseStopRgb(stopEntry, fgColor, bgColor) {
  const stopType = stopEntry.v.Type.v.Clry;
  if (stopType === "FrgC") {
    return {
      h: fgColor >> 16 & 255,
      l: fgColor >> 8 & 255,
      O: fgColor & 255,
    };
  }
  if (stopType === "BckC") {
    return {
      h: bgColor >> 16 & 255,
      l: bgColor >> 8 & 255,
      O: bgColor & 255,
    };
  }
  const clrDesc = stopEntry.v.Clr;
  if (clrDesc && clrDesc.v) {
    return psdColorToRgb(clrDesc.v);
  }
  return { h: 0, l: 0, O: 0 };
}

function renderGradientFromLut(outPixels, lut, matrix, rect, offsetX, offsetY, lutMax, positionFn) {
  const uCoeffX = matrix[0];
  const uCoeffY = matrix[1];
  const vCoeffX = matrix[2];
  const vCoeffY = matrix[3];
  const width = rect.width;
  const height = rect.height;
  let pixelIndex = 0;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++, pixelIndex++) {
      const docX = col + offsetX;
      const docY = row + offsetY;
      const u = uCoeffX * docX + uCoeffY * docY;
      const v = vCoeffX * docX + vCoeffY * docY;
      outPixels[pixelIndex] = lut[clampRound(positionFn(u, v), lutMax)];
    }
  }
}

/**
 * A gradient renderer per gradient style, indexed by the style a `Grdn`
 * descriptor names: linear, radial, angular, reflected, diamond.
 */
export const gradientRenderers = [
  linearGradientPos,
  radialGradientPos,
  angularGradientPos,
  reflectedGradientPos,
  diamondGradientPos,
].map((positionFn) => (
  function gradientRenderer(outPixels, lut, matrix, rect, offsetX, offsetY, lutMax) {
    renderGradientFromLut(
      outPixels,
      lut,
      matrix,
      rect,
      offsetX,
      offsetY,
      lutMax,
      positionFn,
    );
  }
));

function renderMeshGradient(outRgba, lutBytes, bounds, meshState, lutMax) {
  const outW = bounds.width;
  const outH = bounds.height;
  const meshSpan = meshState.meshMax - meshState.meshMin;
  const invMeshSpan = 1 / meshSpan;
  const meshPadX = meshState.meshRect.width - bounds.width >> 1;
  const meshPadY = meshState.meshRect.height - bounds.height >> 1;
  const meshStride = meshState.meshRect.width;
  const sampleT0 = -0.6 * invMeshSpan;
  const sampleT1 = (-0.6 + 0.4) * invMeshSpan;
  const sampleT2 = (-0.6 + 2 * 0.4) * invMeshSpan;
  const sampleT3 = (-0.6 + 3 * 0.4) * invMeshSpan;

  for (let row = 0, px = 0; row < outH; row++) {
    for (let col = 0; col < outW; col++, px += 4) {
      let alphaAcc = 0;
      let redAcc = 0;
      let greenAcc = 0;
      let blueAcc = 0;
      const meshIdx = (row + meshPadY) * meshStride + col + meshPadX;
      const meshT = (meshState.meshDistances[meshIdx] - meshState.meshMin) * invMeshSpan;
      let lutOff = 0;

      if (meshT <= 0 || meshT >= 1) {
        lutOff = (meshT <= 0 ? 0 : lutMax) << 2;
        outRgba[px] = lutBytes[lutOff];
        outRgba[px + 1] = lutBytes[lutOff + 1];
        outRgba[px + 2] = lutBytes[lutOff + 2];
        outRgba[px + 3] = lutBytes[lutOff + 3];
        continue;
      }

      lutOff = Math.max(0, Math.min(lutMax - 1, Math.round((meshT + sampleT0) * lutMax))) << 2;
      redAcc += lutBytes[lutOff];
      greenAcc += lutBytes[lutOff + 1];
      blueAcc += lutBytes[lutOff + 2];
      alphaAcc += lutBytes[lutOff + 3];
      lutOff = Math.max(0, Math.min(lutMax - 1, Math.round((meshT + sampleT1) * lutMax))) << 2;
      redAcc += lutBytes[lutOff];
      greenAcc += lutBytes[lutOff + 1];
      blueAcc += lutBytes[lutOff + 2];
      alphaAcc += lutBytes[lutOff + 3];
      lutOff = Math.max(0, Math.min(lutMax - 1, Math.round((meshT + sampleT2) * lutMax))) << 2;
      redAcc += lutBytes[lutOff];
      greenAcc += lutBytes[lutOff + 1];
      blueAcc += lutBytes[lutOff + 2];
      alphaAcc += lutBytes[lutOff + 3];
      lutOff = Math.max(0, Math.min(lutMax - 1, Math.round((meshT + sampleT3) * lutMax))) << 2;
      redAcc += lutBytes[lutOff];
      greenAcc += lutBytes[lutOff + 1];
      blueAcc += lutBytes[lutOff + 2];
      alphaAcc += lutBytes[lutOff + 3];
      outRgba[px] = redAcc >>> 2;
      outRgba[px + 1] = greenAcc >>> 2;
      outRgba[px + 2] = blueAcc >>> 2;
      outRgba[px + 3] = alphaAcc >>> 2;
    }
  }
}

/**
 * Round a normalized scalar into `[0, maxIndex]` for LUT indexing.
 * @param {number} value normalized position
 * @param {number} maxIndex inclusive upper bound
 */
export function clampRound(value, maxIndex) {
  let idx = ~~(0.499 + value * maxIndex);
  if (idx < 0) return 0;
  if (idx > maxIndex) return maxIndex;
  return idx;
}

export function linearGradientPos(u, v) {
  return u + 0.5;
}

export function radialGradientPos(u, v) {
  return 2 * Math.sqrt(u * u + v * v);
}

export function angularGradientPos(u, v) {
  return (Math.PI + Math.atan2(-v, -u)) / (2 * Math.PI);
}

export function reflectedGradientPos(u, v) {
  return Math.abs(u * 2);
}

export function diamondGradientPos(u, v) {
  return 2 * (Math.abs(u) + Math.abs(v));
}

/**
 * Fill packed RGBA pixels by sampling a byte LUT with Floyd–Steinberg dithering.
 */
export function warpBilinear(
  outPixels,
  lut,
  matrix,
  rect,
  offsetX,
  offsetY,
  lutMax,
  gradientStyle,
) {
  const uCoeffX = matrix[0];
  const uCoeffY = matrix[1];
  const vCoeffX = matrix[2];
  const vCoeffY = matrix[3];
  const width = rect.width;
  const height = rect.height;
  let buffers = allocateErrorBuffers(width);
  let errCur = buffers.errCur;
  let errNext = buffers.errNext;

  for (let row = 0, pixelIndex = 0; row < height; row++) {
    const swap = errCur;
    errCur = errNext;
    errNext = swap;
    errNext.fill(0);

    for (let col = 0; col < width; col++, pixelIndex++) {
      const docX = col + offsetX;
      const docY = row + offsetY;
      const u = uCoeffX * docX + uCoeffY * docY;
      const v = vCoeffX * docX + vCoeffY * docY;
      const gradPos = gradientPositionForStyle(gradientStyle, u, v);
      const lutOffset = clampRound(gradPos, lutMax) * 4;
      const errOffset = col * 4;
      let packed = 0;

      for (let channel = 0; channel < CHANNEL_COUNT; channel++) {
        const quant = floydSteinbergQuantizeChannel(
          lut[lutOffset + channel],
          errCur,
          errNext,
          errOffset,
          channel,
        );
        packed |= quant << channel * 8;
      }
      outPixels[pixelIndex] = packed;
    }
  }
}

/**
 * Read a scalar from a PSD descriptor field (plain or unit value).
 */
export function readDescriptorScalar(field) {
  if (field == null) return null;
  if (field.v != null && typeof field.v === "object" && field.v.val != null) return field.v.val;
  if (field.v != null) return field.v;
  return null;
}

/**
 * Convert a PSD color descriptor object to `{ h, l, O }` RGB channels.
 */
export function psdColorToRgb(psdColor) {
  let rgbOut;
  const colorClassId = psdColor.classID;

  if (colorClassId === "RGBC") {
    if (psdColor.Rd) {
      rgbOut = {
        h: psdColor.Rd.v,
        l: psdColor.Grn.v,
        O: psdColor.Bl.v,
      };
    } else {
      rgbOut = {
        h: psdColor.redFloat.v * 255,
        l: psdColor.greenFloat.v * 255,
        O: psdColor.blueFloat.v * 255,
      };
    }
  } else if (colorClassId === "HSBC") {
    const hueField = psdColor.H != null ? psdColor.H : psdColor.coords;
    let hue = readDescriptorScalar(hueField);
    let saturation = readDescriptorScalar(psdColor.Strt);
    let brightness = readDescriptorScalar(psdColor.Brgh);
    if (hue == null) hue = 0;
    if (saturation == null) saturation = 0;
    if (brightness == null) brightness = 0;
    rgbOut = hsvToRgb(hue / 360, saturation / 100, brightness / 100);
    rgbOut.h *= 255;
    rgbOut.l *= 255;
    rgbOut.O *= 255;
  } else if (colorClassId === "CMYC") {
    const cyanPct = 100 - psdColor.Cyn.v;
    const magentaPct = 100 - psdColor.Mgnt.v;
    const yellowPct = 100 - psdColor.Ylw.v;
    const blackPct = 100 - psdColor.Blck.v;
    const outR = 255 * cyanPct * blackPct * 1e-4;
    const outG = 255 * (0.2 * cyanPct + 0.8 * magentaPct) * blackPct * 1e-4;
    const outB = 255 * (0.2 * magentaPct + 0.8 * yellowPct) * blackPct * 1e-4;
    rgbOut = { h: outR, l: outG, O: outB };
  } else if (colorClassId === "Grsc") {
    rgbOut = {
      h: 255 - psdColor.Gry.v,
      l: 255 - psdColor.Gry.v,
      O: 255 - psdColor.Gry.v,
    };
  } else if (colorClassId === "LbCl") {
    rgbOut = labToRgb(psdColor.Lmnc.v, psdColor.A.v, psdColor.B.v);
  } else {
    rgbOut = { h: 0, l: 0, O: 0 };
  }

  if (rgbOut == null || isNaN(rgbOut.h)) {
    rgbOut = { h: 0, l: 0, O: 0 };
  }
  return rgbOut;
}

/** Build an `RGBC` descriptor from `{ h, l, O }` channel values. */
export function toRGBDesc(rgb) {
  return {
    classID: "RGBC",
    Rd: { t: "doub", v: rgb.h },
    Grn: { t: "doub", v: rgb.l },
    Bl: { t: "doub", v: rgb.O },
  };
}

/**
 * Resolve a PSD color-stop list to `{ h, l, O }` entries.
 */
export function parseColorStops(colorStopList, fgColor, bgColor) {
  const rgbStops = [];
  for (let stopIndex = 0; stopIndex < colorStopList.length; stopIndex++) {
    rgbStops.push(parseStopRgb(colorStopList[stopIndex], fgColor, bgColor));
  }
  return rgbStops;
}

/**
 * Smooth-step blend factor between two gradient stops at `position`.
 */
export function gradientStopBlend(stopList, locationScale, stopIndex, position, smoothness) {
  if (stopList.length === 2) smoothness *= 0.5;
  const locLo = stopList[stopIndex].v.Lctn.v * locationScale;
  const locHi = stopList[stopIndex + 1].v.Lctn.v * locationScale;
  const midLoc = locLo + stopList[stopIndex + 1].v.Mdpn.v * 0.01 * (locHi - locLo);
  let blendT;
  if (position < midLoc) {
    blendT = 0.5 * (position - locLo) / (midLoc - locLo);
  } else {
    blendT = 0.5 + 0.5 * (position - midLoc) / (locHi - midLoc);
  }
  blendT = 0.5 + 0.5 * (smoothness * Math.cos(Math.PI * blendT) + (1 - smoothness) * (1 - 2 * blendT));
  return blendT;
}

/**
 * Interpolate RGBA at normalized `position` along color and opacity stops.
 * @returns {[number, number, number, number]}
 */
export function interpolateGradientStop(gradDesc, rgbStops, position) {
  const smoothness = gradDesc.Intr.v * INV_LOCATION_SCALE;
  const colorStops = gradDesc.Clrs.v;
  const opacityStops = gradDesc.Trns.v;
  const lastColorIdx = colorStops.length - 1;
  const lastOpacityIdx = opacityStops.length - 1;
  let stopIdx = -1;
  let alpha = 0;
  let red = 0;
  let green = 0;
  let blue = 0;

  while (stopIdx < lastOpacityIdx && opacityStops[stopIdx + 1].v.Lctn.v <= position * LOCATION_SCALE) {
    stopIdx++;
  }
  if (stopIdx === -1) {
    alpha = opacityStops[0].v.Opct.v.val * (255 / 100);
  } else if (stopIdx === lastOpacityIdx) {
    alpha = opacityStops[stopIdx].v.Opct.v.val * (255 / 100);
  } else {
    const opacityBlend = gradientStopBlend(
      opacityStops,
      INV_LOCATION_SCALE,
      stopIdx,
      position,
      smoothness,
    );
    alpha = (
      opacityBlend * opacityStops[stopIdx].v.Opct.v.val
      + (1 - opacityBlend) * opacityStops[stopIdx + 1].v.Opct.v.val
    ) * (255 / 100);
  }

  stopIdx = -1;
  while (stopIdx < lastColorIdx && colorStops[stopIdx + 1].v.Lctn.v <= position * LOCATION_SCALE) {
    stopIdx++;
  }
  if (stopIdx === -1) {
    const rgb = rgbStops[0];
    red = rgb.h;
    green = rgb.l;
    blue = rgb.O;
  } else if (stopIdx === lastColorIdx) {
    const rgb = rgbStops[stopIdx];
    red = rgb.h;
    green = rgb.l;
    blue = rgb.O;
  } else {
    const rgbLo = rgbStops[stopIdx];
    const rgbHi = rgbStops[stopIdx + 1];
    const colorBlend = gradientStopBlend(
      colorStops,
      INV_LOCATION_SCALE,
      stopIdx,
      position,
      smoothness,
    );
    red = colorBlend * rgbLo.h + (1 - colorBlend) * rgbHi.h;
    green = colorBlend * rgbLo.l + (1 - colorBlend) * rgbHi.l;
    blue = colorBlend * rgbLo.O + (1 - colorBlend) * rgbHi.O;
  }
  return [red, green, blue, alpha];
}

/** Sample a packed RGBA LUT entry at normalized `position`. */
export function sampleGradientColor(gradDesc, rgbStops, position) {
  const rgba = interpolateGradientStop(gradDesc, rgbStops, position);
  const red = ~~(0.5 + rgba[0]);
  const green = ~~(0.5 + rgba[1]);
  const blue = ~~(0.5 + rgba[2]);
  const alpha = ~~(0.5 + rgba[3]);
  return alpha << 24 | blue << 16 | green << 8 | red;
}

/** Build a byte-array LUT for dithered gradient rendering. */
export function buildDitheredLut(gradDesc, rgbStops, lutSize, reverseLut) {
  const lut = [];
  const invSpan = 1 / (lutSize - 0);
  for (let lutIdx = 0; lutIdx < lutSize; lutIdx++) {
    const byteOff = lutIdx * 4;
    const rgba = interpolateGradientStop(
      gradDesc,
      rgbStops,
      (reverseLut ? lutSize - 1 - lutIdx : lutIdx) * invSpan,
    );
    lut[byteOff] = rgba[0];
    lut[byteOff + 1] = rgba[1];
    lut[byteOff + 2] = rgba[2];
    lut[byteOff + 3] = rgba[3];
  }
  return lut;
}

/** Build a packed `Uint32Array` LUT for non-dithered gradient rendering. */
export function buildGradientLut(gradDesc, rgbStops, lutSize, reverseLut) {
  const lut = new Uint32Array(lutSize);
  const invSpan = 1 / (lutSize - 0);
  for (let lutIdx = 0; lutIdx < lutSize; lutIdx++) {
    lut[lutIdx] = sampleGradientColor(
      gradDesc,
      rgbStops,
      (reverseLut ? lutSize - 1 - lutIdx : lutIdx) * invSpan,
    );
  }
  return lut;
}

/**
 * Rasterize a PSD gradient descriptor into an RGBA buffer.
 */
export function applyGradient(
  gradDesc,
  outRgba,
  bounds,
  matrix,
  originX,
  originY,
  reverseLut,
  gradientStyle,
  fgColor,
  bgColor,
  meshState,
  dither,
) {
  if (gradDesc.Clrs == null) return;

  const outPacked = new Uint32Array(outRgba.buffer);
  const rgbStops = parseColorStops(gradDesc.Clrs.v, fgColor, bgColor);
  const offsetX = bounds.x - originX;
  const offsetY = bounds.y - originY;

  if (dither) {
    const ditherLut = buildDitheredLut(gradDesc, rgbStops, LUT_MAX + 1, reverseLut);
    warpBilinear(outPacked, ditherLut, matrix, bounds, offsetX, offsetY, LUT_MAX, gradientStyle);
    return;
  }

  const lutPacked = buildGradientLut(gradDesc, rgbStops, LUT_MAX + 1, reverseLut);
  if (gradientStyle < GRADIENT_STYLE_MESH) {
    gradientRenderers[gradientStyle](outPacked, lutPacked, matrix, bounds, offsetX, offsetY, LUT_MAX);
    return;
  }

  renderMeshGradient(outRgba, new Uint8Array(lutPacked.buffer), bounds, meshState, LUT_MAX);
}

/**
 * Compute linear-gradient start/end points from descriptor angle, scale, and offset.
 * @returns {[Point, Point]}
 */
export function linearGradientEndpoints(gradDesc, rect) {
  const angleRad = Math.PI * gradDesc.Angl.v.val / 180;
  const scale = gradDesc.Scl.v.val / 100;
  const offset = gradDesc.Ofst.v;
  const offsetX = offset.Hrzn.v.val / 100;
  const offsetY = offset.Vrtc.v.val / 100;
  const cosA = Math.cos(angleRad);
  const sinA = -Math.sin(angleRad);
  const halfH = 0.5 * rect.height;
  const vertReach = halfH * (cosA / sinA);
  const vertLen = Math.sqrt(halfH * halfH + vertReach * vertReach);
  const halfW = 0.5 * rect.width;
  const horizReach = halfW * (sinA / cosA);
  const horizLen = Math.sqrt(halfW * halfW + horizReach * horizReach);
  const halfLen = Math.min(vertLen, horizLen) * scale;
  const centerX = rect.x + rect.width / 2 + offsetX * rect.width;
  const centerY = rect.y + rect.height / 2 + offsetY * rect.height;
  return [new Point(centerX, centerY), new Point(centerX + cosA * halfLen, centerY + sinA * halfLen)];
}

/** Write angle, scale, and offset back into `gradDesc` from drag handles. */
export function gradientAngleFromPoints(startPt, endPt, rect, gradDesc) {
  const dx = endPt.x - startPt.x;
  const dy = -(endPt.y - startPt.y);
  const span = Math.sqrt(dx * dx + dy * dy);
  const angleRad = Math.atan2(dy, dx);
  const cosA = Math.cos(angleRad);
  const sinA = -Math.sin(angleRad);
  const halfH = 0.5 * rect.height;
  const vertReach = halfH * (cosA / sinA);
  const vertLen = Math.sqrt(halfH * halfH + vertReach * vertReach);
  const halfW = 0.5 * rect.width;
  const horizReach = halfW * (sinA / cosA);
  const horizLen = Math.sqrt(halfW * halfW + horizReach * horizReach);
  const scaleFactor = span / Math.min(vertLen, horizLen);
  const offsetX = (startPt.x - rect.x - rect.width / 2) / rect.width;
  const offsetY = (startPt.y - rect.y - rect.height / 2) / rect.height;
  gradDesc.Angl.v.val = 180 * angleRad / Math.PI;
  gradDesc.Scl.v.val = scaleFactor * 100;
  const offset = gradDesc.Ofst.v;
  offset.Hrzn.v.val = offsetX * 100;
  offset.Vrtc.v.val = offsetY * 100;
}

/** Populate color and transparency stop arrays from CSS-style tuples. */
export function cssStopsToGradientDesc(cssStops, gradDesc) {
  for (let stopIdx = 0; stopIdx < cssStops.length; stopIdx++) {
    const cssStop = cssStops[stopIdx];
    const location = Math.round(cssStop[0] * 4096);
    const rgb = cssStop[1];
    let opacity = cssStop[2];
    let midpoint = cssStop[3];
    if (opacity == null) opacity = 1;
    if (midpoint == null) midpoint = 0.5;
    const rgbDesc = toRGBDesc({
      h: rgb[0] * 255,
      l: rgb[1] * 255,
      O: rgb[2] * 255,
    });
    gradDesc.Clrs.v[stopIdx] = {
      t: "Objc",
      v: {
        classID: "Clrt",
        Lctn: { t: "long", v: location },
        Mdpn: { t: "long", v: Math.round(midpoint * 100) },
        Clr: { t: "Objc", v: rgbDesc },
        Type: { t: "enum", v: { Clry: "UsrS" } },
      },
    };
    gradDesc.Trns.v[stopIdx] = {
      t: "Objc",
      v: {
        classID: "TrnS",
        Lctn: { t: "long", v: location },
        Mdpn: { t: "long", v: Math.round(midpoint * 100) },
        Opct: {
          t: "UntF",
          v: { type: "#Prc", val: Math.round(opacity * 100) },
        },
      },
    };
  }
}
