/**
 * Colour maths for the Camera Raw filter.
 *
 * Everything here is allocation-free on the hot path: conversions take scalars
 * and write into a caller-supplied 3-element array, and the two matrix builders
 * return a flat row-major 3x3 (`[m00, m01, m02, m10, …]`) or `null` when the
 * settings are an identity transform, so callers can skip the stage entirely.
 *
 * The working space is sRGB with a D65 white. White balance and camera
 * calibration are linear-light operations; hue / saturation / lightness work is
 * done on the display-encoded values, matching where those panels sit in the
 * develop order.
 */

import {
  chromaticityFromTemperatureAndTint,
  planckianLocusFromChromaticity,
  xyToNormalizedXyz
} from "../../engine/compositing/color-temperature.js";

/** CIE 1931 chromaticity of the D65 white the sRGB working space encodes for. */
const SRGB_WHITE_CHROMATICITY = { x: 0.3127, y: 0.3290 };

/**
 * Where the working white sits on the Planckian locus, as the correlated colour
 * temperature and the signed distance off the locus that reproduce it. Both
 * sliders move relative to this point, so temperature 0 / tint 0 reconstructs
 * the working white and leaves the image untouched.
 */
const WORKING_WHITE_ON_LOCUS = planckianLocusFromChromaticity(SRGB_WHITE_CHROMATICITY);

/**
 * Mired travelled per unit of the Temperature slider. At the ±100 limits the
 * assumed illuminant runs from roughly 4100 K to 15700 K, which brackets the
 * tungsten-to-deep-shade range the slider is expected to cover.
 */
const MIRED_PER_TEMPERATURE_UNIT = 0.9;

/** DNG tint units per unit of the Tint slider (positive is magenta). */
const TINT_UNITS_PER_SLIDER_UNIT = 1;

/** Hue rotation applied to a calibration primary at the ±100 slider limits. */
const CALIBRATION_HUE_ROTATION_DEGREES = 30;

/** Rec. 709 luminance weights, used wherever a neutral axis is needed. */
const LUMA_RED = 0.2126;
const LUMA_GREEN = 0.7152;
const LUMA_BLUE = 0.0722;

/** Linear sRGB to CIE XYZ (D65) and its inverse. */
const LINEAR_SRGB_TO_XYZ = [
  0.4124564, 0.3575761, 0.1804375,
  0.2126729, 0.7151522, 0.0721750,
  0.0193339, 0.1191920, 0.9503041
];
const XYZ_TO_LINEAR_SRGB = [
  3.2404542, -1.5371385, -0.4985314,
  -0.9692660, 1.8760108, 0.0415560,
  0.0556434, -0.2040259, 1.0572252
];

/** Bradford cone response matrix and its inverse. */
const BRADFORD = [
  0.8951, 0.2664, -0.1614,
  -0.7502, 1.7135, 0.0367,
  0.0389, -0.0685, 1.0296
];
const BRADFORD_INVERSE = [
  0.9869929, -0.1470543, 0.1599627,
  0.4323053, 0.5183603, 0.0492912,
  -0.0085287, 0.0400428, 0.9684867
];

/** Hue in degrees of each calibration primary before any rotation. */
const PRIMARY_HUE_DEGREES = [0, 120, 240];

export {
  LUMA_RED,
  LUMA_GREEN,
  LUMA_BLUE,
  srgbToLinear,
  linearToSrgb,
  multiply3x3,
  apply3x3,
  rgbToHsl,
  hslToRgb,
  buildWhiteBalanceMatrix,
  buildCalibrationMatrix,
  estimateTemperatureAndTintFromNeutral
};

/** sRGB electro-optical transfer function (display encoded → linear light). */
function srgbToLinear(channel) {
  return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/** Inverse sRGB transfer function (linear light → display encoded). */
function linearToSrgb(channel) {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
}

/** Row-major 3x3 product `left · right`. */
function multiply3x3(left, right) {
  const product = new Float64Array(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      product[row * 3 + col] =
        left[row * 3] * right[col] +
        left[row * 3 + 1] * right[3 + col] +
        left[row * 3 + 2] * right[6 + col];
    }
  }
  return product;
}

/** Multiply a colour by a row-major 3x3, writing `[r, g, b]` into `out`. */
function apply3x3(matrix, r, g, b, out) {
  out[0] = matrix[0] * r + matrix[1] * g + matrix[2] * b;
  out[1] = matrix[3] * r + matrix[4] * g + matrix[5] * b;
  out[2] = matrix[6] * r + matrix[7] * g + matrix[8] * b;
  return out;
}

/**
 * RGB → HSL with hue in degrees. Writes `[hue, saturation, lightness]`
 * into `out` so per-pixel loops do not allocate.
 */
function rgbToHsl(r, g, b, out) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  const lightness = (max + min) * 0.5;
  let hue = 0;
  let saturation = 0;
  if (chroma > 1e-9) {
    const denominator = 1 - Math.abs(2 * lightness - 1);
    saturation = denominator > 1e-9 ? chroma / denominator : 0;
    if (max === r) hue = ((g - b) / chroma) % 6;
    else if (max === g) hue = (b - r) / chroma + 2;
    else hue = (r - g) / chroma + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  out[0] = hue;
  out[1] = saturation;
  out[2] = lightness;
  return out;
}

/** HSL (hue in degrees) → RGB, written into `out`. */
function hslToRgb(hue, saturation, lightness, out) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (((hue % 360) + 360) % 360) / 60;
  const secondary = chroma * (1 - Math.abs((sector % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (sector < 1) { r = chroma; g = secondary; }
  else if (sector < 2) { r = secondary; g = chroma; }
  else if (sector < 3) { g = chroma; b = secondary; }
  else if (sector < 4) { g = secondary; b = chroma; }
  else if (sector < 5) { r = secondary; b = chroma; }
  else { r = chroma; b = secondary; }
  const offset = lightness - chroma * 0.5;
  out[0] = r + offset;
  out[1] = g + offset;
  out[2] = b + offset;
  return out;
}

/**
 * Linear-light sRGB matrix for the Temperature / Tint pair.
 *
 * The sliders name the illuminant the scene is assumed to have been lit by, so
 * the matrix adapts that illuminant onto D65: a warmer assumed illuminant makes
 * the rendered image cooler, and vice versa. Neutral input keeps its luminance
 * because Bradford maps the assumed white onto the D65 white at equal Y.
 *
 * @param {number} temperature -100…100, positive warms the image.
 * @param {number} tint -100…100, positive pushes magenta.
 * @returns {Float64Array|null} Row-major 3x3, or null when both are zero.
 */
function buildWhiteBalanceMatrix(temperature, tint) {
  if (!temperature && !tint) return null;
  const assumedMired =
    1e6 / WORKING_WHITE_ON_LOCUS.correlatedColorTemp - temperature * MIRED_PER_TEMPERATURE_UNIT;
  const assumedChromaticity = chromaticityFromTemperatureAndTint(
    1e6 / assumedMired,
    WORKING_WHITE_ON_LOCUS.tintBias + tint * TINT_UNITS_PER_SLIDER_UNIT
  );
  const adaptation = bradfordAdaptation(
    xyToNormalizedXyz(assumedChromaticity),
    xyToNormalizedXyz(SRGB_WHITE_CHROMATICITY)
  );
  return multiply3x3(XYZ_TO_LINEAR_SRGB, multiply3x3(adaptation, LINEAR_SRGB_TO_XYZ));
}

/**
 * Linear-light sRGB matrix for the Calibration panel's primaries.
 *
 * Each slider pair rotates and stretches one primary of the working space; the
 * output colour is the input's channels recombined over the moved primaries.
 * Every rotated primary is renormalised to the luminance of the primary it
 * replaces, so the sliders change hue and chroma without acting as a brightness
 * control.
 *
 * @param {number[]} hueShifts Red / green / blue hue sliders, -100…100.
 * @param {number[]} saturationShifts Red / green / blue saturation sliders, -100…100.
 * @returns {Float64Array|null} Row-major 3x3, or null when all six are zero.
 */
function buildCalibrationMatrix(hueShifts, saturationShifts) {
  let anyShift = false;
  for (let i = 0; i < 3; i++) {
    if (hueShifts[i] || saturationShifts[i]) anyShift = true;
  }
  if (!anyShift) return null;

  const matrix = new Float64Array(9);
  const primary = [0, 0, 0];
  for (let channel = 0; channel < 3; channel++) {
    movePrimary(channel, hueShifts[channel], saturationShifts[channel], primary);
    matrix[channel] = primary[0];
    matrix[3 + channel] = primary[1];
    matrix[6 + channel] = primary[2];
  }
  return matrix;
}

/**
 * Recover Temperature / Tint slider positions that neutralise a sampled colour,
 * used by the white-balance eyedropper. Searches the slider plane directly
 * because the forward transform is a matrix built from the Planckian locus and
 * has no closed-form inverse.
 *
 * @returns {{ temperature: number, tint: number }} Both rounded, clamped to ±100.
 */
function estimateTemperatureAndTintFromNeutral(r, g, b) {
  const linear = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  let bestTemperature = 0;
  let bestTint = 0;
  let bestError = neutralityError(linear, 0, 0);
  // Two passes: a coarse sweep of the slider plane, then a unit-step refinement.
  for (let temperature = -100; temperature <= 100; temperature += 5) {
    for (let tint = -100; tint <= 100; tint += 5) {
      const error = neutralityError(linear, temperature, tint);
      if (error < bestError) {
        bestError = error;
        bestTemperature = temperature;
        bestTint = tint;
      }
    }
  }
  const coarseTemperature = bestTemperature;
  const coarseTint = bestTint;
  for (let temperature = coarseTemperature - 5; temperature <= coarseTemperature + 5; temperature++) {
    for (let tint = coarseTint - 5; tint <= coarseTint + 5; tint++) {
      if (temperature < -100 || temperature > 100 || tint < -100 || tint > 100) continue;
      const error = neutralityError(linear, temperature, tint);
      if (error < bestError) {
        bestError = error;
        bestTemperature = temperature;
        bestTint = tint;
      }
    }
  }
  return { temperature: bestTemperature, tint: bestTint };
}

// --- private helpers ---------------------------------------------------------

/** How far a linear colour lands from the neutral axis under a slider pair. */
function neutralityError(linearRgb, temperature, tint) {
  const matrix = buildWhiteBalanceMatrix(temperature, tint);
  const balanced = [linearRgb[0], linearRgb[1], linearRgb[2]];
  if (matrix) apply3x3(matrix, linearRgb[0], linearRgb[1], linearRgb[2], balanced);
  const mean = (balanced[0] + balanced[1] + balanced[2]) / 3;
  if (mean <= 1e-9) return Number.MAX_VALUE;
  const dr = balanced[0] / mean - 1;
  const dg = balanced[1] / mean - 1;
  const db = balanced[2] / mean - 1;
  return dr * dr + dg * dg + db * db;
}

/** Bradford chromatic adaptation between two normalised XYZ whites. */
function bradfordAdaptation(sourceXyz, targetXyz) {
  const source = apply3x3(BRADFORD, sourceXyz.x, sourceXyz.y, sourceXyz.zChannel, [0, 0, 0]);
  const target = apply3x3(BRADFORD, targetXyz.x, targetXyz.y, targetXyz.zChannel, [0, 0, 0]);
  const coneScale = [
    target[0] / source[0], 0, 0,
    0, target[1] / source[1], 0,
    0, 0, target[2] / source[2]
  ];
  return multiply3x3(BRADFORD_INVERSE, multiply3x3(coneScale, BRADFORD));
}

/**
 * Rotate and stretch one working-space primary, keeping its original luminance.
 * Writes the linear-light replacement vector into `out`.
 */
function movePrimary(channel, hueShift, saturationShift, out) {
  const baseHue = PRIMARY_HUE_DEGREES[channel];
  const rotatedHue = baseHue + (hueShift / 100) * CALIBRATION_HUE_ROTATION_DEGREES;
  hslToRgb(rotatedHue, 1, 0.5, out);
  // hslToRgb at L=0.5 yields the fully saturated hue scaled to a 0…1 peak.
  const peak = Math.max(out[0], out[1], out[2]) || 1;
  out[0] /= peak;
  out[1] /= peak;
  out[2] /= peak;

  const chromaScale = 1 + saturationShift / 100;
  const grey = out[0] * LUMA_RED + out[1] * LUMA_GREEN + out[2] * LUMA_BLUE;
  out[0] = grey + (out[0] - grey) * chromaScale;
  out[1] = grey + (out[1] - grey) * chromaScale;
  out[2] = grey + (out[2] - grey) * chromaScale;

  const targetLuminance = channel === 0 ? LUMA_RED : channel === 1 ? LUMA_GREEN : LUMA_BLUE;
  const movedLuminance = out[0] * LUMA_RED + out[1] * LUMA_GREEN + out[2] * LUMA_BLUE;
  const normalise = movedLuminance > 1e-9 ? targetLuminance / movedLuminance : 1;
  out[0] *= normalise;
  out[1] *= normalise;
  out[2] *= normalise;
  return out;
}
