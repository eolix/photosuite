/**
 * Camera Raw filter raster develop.
 *
 * Stages run in the order the dialog's panels are stacked, each one skipped
 * outright when its panel switch is off or its sliders are at rest, so a panel
 * hidden in the dialog leaves the pixels byte-identical:
 *
 *   1. Basic — a colour cube covering white balance, exposure, contrast,
 *      whites, blacks, vibrance and saturation, then the spatial highlights /
 *      shadows, texture / clarity and dehaze passes.
 *   2. Curve — parametric highlights / lights / darks / shadows.
 *   3. Colour Mixer — per-band hue, saturation and luminance.
 *   4. Split Toning — highlight and shadow tints around a balance point.
 *   5. Calibration — primary rotation plus a shadow tint.
 *   6. Optics and Effects — distortion, vignetting, grain.
 *   7. Detail — sharpening and luminance / colour noise reduction.
 *   8. Geometry — Upright perspective correction.
 *
 * The colour cube is built once per call and sampled trilinearly, which keeps
 * the per-pixel cost of the Basic panel flat no matter how many of its sliders
 * are in play.
 */

import {
  CAMERA_RAW_MODE_RAW,
  COLOR_MIXER_BANDS,
  collectCameraRawScalars,
  createCameraRawDefaultDescriptor,
  isSectionEnabled,
  listCameraRawSliderSpecs,
  readScalar,
} from "./camera-raw-descriptor.js";
import {
  LUMA_BLUE,
  LUMA_GREEN,
  LUMA_RED,
  apply3x3,
  buildCalibrationMatrix,
  buildWhiteBalanceMatrix,
  hslToRgb,
  linearToSrgb,
  rgbToHsl,
  srgbToLinear,
} from "./camera-raw-color.js";

/** Samples per axis in the Basic panel's colour cube. */
const TONE_CUBE_EDGE = 33;

/** Where the exposure highlight shoulder starts, in linear light. */
const EXPOSURE_SHOULDER_KNEE = 0.75;

/** Display-space reach of the Whites and Blacks endpoint controls. */
const WHITES_REACH = 0.5;
const BLACKS_REACH = 0.35;

/** Hue rotation and lightness lift a Colour Mixer band reaches at ±100. */
const MIXER_HUE_ROTATION_DEGREES = 30;
const MIXER_LIGHTNESS_REACH = 0.25;

/** Unsharp radii for the two local-contrast controls, in preview pixels. */
const TEXTURE_RADIUS = 3;
const CLARITY_RADIUS_DIVISOR = 40;
const CLARITY_MIN_RADIUS = 8;

/** Green ↔ magenta reach of the Calibration shadow tint at ±100. */
const SHADOW_TINT_REACH = 0.15;

/**
 * Develop a pixel buffer with the Camera Raw filter.
 *
 * @param {string} filterType FilterDefs id (unused; the descriptor carries everything).
 * @param {{ buffer: Uint8Array, rect: { width: number, height: number } }} sourcePixels
 * @param {object} filterDescriptor Camera Raw descriptor, typed `{ t, v }` nodes.
 * @param {*} fgRgb Unused foreground colour.
 * @param {*} bgRgb Unused background colour.
 * @param {{ buffer: Uint8Array, rect: object }} destPixels Receives the developed pixels.
 * @returns {object} `destPixels`.
 */
export function applyCameraRawFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels) {
  const scalars = collectCameraRawScalars(filterDescriptor);
  // A full-resolution photograph needs four bytes of working float per pixel,
  // which is worth avoiding entirely when nothing has been asked for — opening
  // a camera file straight through is the common case.
  if (!hasAnySliderMoved(scalars)) {
    if (destPixels.buffer !== sourcePixels.buffer) destPixels.buffer.set(sourcePixels.buffer);
    return destPixels;
  }
  const width = sourcePixels.rect.width;
  const height = sourcePixels.rect.height;
  const floatRgba = new Float32Array(width * height * 4);
  bytesToFloat(sourcePixels.buffer, floatRgba);
  // Stages that resample or convolve read from a copy of the plate. They hand
  // the same copy back and forth rather than each allocating its own, which at
  // photographic sizes is the difference between one spare plate and five.
  const scratch = { buffer: null };

  if (isSectionEnabled(scalars, "EnableBasic")) developBasic(floatRgba, width, height, scalars);
  if (isSectionEnabled(scalars, "EnableToneCurve")) developParametricCurve(floatRgba, scalars);
  if (isSectionEnabled(scalars, "EnableColorAdjustments")) developColorMixer(floatRgba, scalars);
  if (isSectionEnabled(scalars, "EnableSplitToning")) developSplitToning(floatRgba, scalars);
  if (isSectionEnabled(scalars, "EnableCalibration")) developCalibration(floatRgba, scalars);
  if (isSectionEnabled(scalars, "EnableLensCorrections")) developOptics(floatRgba, width, height, scalars, scratch);
  if (isSectionEnabled(scalars, "EnableEffects")) developEffects(floatRgba, width, height, scalars);
  if (isSectionEnabled(scalars, "EnableDetail")) developDetail(floatRgba, width, height, scalars, scratch);
  if (isSectionEnabled(scalars, "EnableGeometry")) developGeometry(floatRgba, width, height, scalars, scratch);

  floatToBytes(floatRgba, destPixels.buffer);
  return destPixels;
}

/** Default value of every slider the panel offers, resolved once. */
const SLIDER_DEFAULTS = buildSliderDefaults();

function buildSliderDefaults() {
  const defaults = createCameraRawDefaultDescriptor();
  const specs = listCameraRawSliderSpecs();
  const byKey = Object.create(null);
  for (let i = 0; i < specs.length; i++) {
    byKey[specs[i].key] = readScalar(defaults, specs[i].key, 0);
  }
  return byKey;
}

/**
 * True when any control is off its rest position. Temperature, Tint and
 * Exposure are excluded for a camera file: the decoder consumed them, and their
 * rest position there is the camera's own white balance, not zero.
 */
function hasAnySliderMoved(scalars) {
  const decoderOwnsWhiteBalance = scalars.CMod === CAMERA_RAW_MODE_RAW;
  for (const key in SLIDER_DEFAULTS) {
    if (decoderOwnsWhiteBalance && (key === "Temp" || key === "Tint" || key === "Ex12")) continue;
    if ((scalars[key] || 0) !== SLIDER_DEFAULTS[key]) return true;
  }
  return (scalars.PerU || 0) > 0;
}

/** Hand out the shared spare plate, filled with the current pixels. */
function takeScratchCopy(floatRgba, scratch) {
  if (scratch == null) return floatRgba.slice(0);
  if (scratch.buffer == null || scratch.buffer.length !== floatRgba.length) {
    scratch.buffer = new Float32Array(floatRgba.length);
  }
  scratch.buffer.set(floatRgba);
  return scratch.buffer;
}

// --- Basic -------------------------------------------------------------------

function developBasic(floatRgba, width, height, scalars) {
  // Developing a camera file, the decoder has already applied Temperature,
  // Tint and Exposure in linear light against the camera's own primaries —
  // where there is still highlight headroom to spend — so this stage takes the
  // plate as given and starts at Contrast.
  const decoderOwnsWhiteBalance = scalars.CMod === CAMERA_RAW_MODE_RAW;
  const whiteBalance = decoderOwnsWhiteBalance
    ? null
    : buildWhiteBalanceMatrix(scalars.Temp || 0, scalars.Tint || 0);
  const exposure = decoderOwnsWhiteBalance ? 0 : (scalars.Ex12 || 0);
  const contrast = (scalars.Cr12 || 0) / 100;
  const whites = (scalars.Wh12 || 0) / 100;
  const blacks = (scalars.Bk12 || 0) / 100;
  const vibrance = (scalars.Vibr || 0) / 100;
  const saturation = (scalars.Strt || 0) / 100;

  if (whiteBalance || exposure || contrast || whites || blacks || vibrance || saturation) {
    const cube = buildToneCube(whiteBalance, exposure, contrast, whites, blacks, vibrance, saturation);
    sampleToneCube(floatRgba, cube);
  }
  applyHighlightsShadows(floatRgba, width, height, (scalars.Hi12 || 0) / 100, (scalars.Sh12 || 0) / 100);
  applyTextureClarity(floatRgba, width, height, (scalars.CrTx || 0) / 100, (scalars.Cl12 || 0) / 100);
  applyDehaze(floatRgba, width, height, (scalars.Dhze || 0) / 100);
}

/** Exposure gain in linear light, rolled off smoothly instead of hard-clipped. */
function compressHighlight(peak) {
  if (peak <= EXPOSURE_SHOULDER_KNEE) return peak;
  const headroom = 1 - EXPOSURE_SHOULDER_KNEE;
  return EXPOSURE_SHOULDER_KNEE + headroom * (1 - Math.exp(-(peak - EXPOSURE_SHOULDER_KNEE) / headroom));
}

/** Smoothstep about mid grey, and its exact inverse for negative contrast. */
function applyContrastCurve(channel, contrast) {
  if (!contrast) return channel;
  const curved = contrast > 0
    ? channel * channel * (3 - 2 * channel)
    : 0.5 - Math.sin(Math.asin(1 - 2 * channel) / 3);
  return channel + Math.abs(contrast) * (curved - channel);
}

/** Move the white end while holding black, and the black end while holding white. */
function applyEndpointCurves(channel, whites, blacks) {
  if (whites) channel += whites * WHITES_REACH * channel * channel;
  if (blacks) {
    const shadowWeight = 1 - channel;
    channel += blacks * BLACKS_REACH * shadowWeight * shadowWeight;
  }
  return channel;
}

/** Saturation scales every colour; vibrance weights the scale toward muted ones. */
function applyVibranceSaturation(rgb, vibrance, saturation) {
  const chroma = Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
  const scale = (1 + saturation) * (1 + vibrance * (1 - chroma));
  const mean = (rgb[0] + rgb[1] + rgb[2]) / 3;
  rgb[0] = clamp01(mean + (rgb[0] - mean) * scale);
  rgb[1] = clamp01(mean + (rgb[1] - mean) * scale);
  rgb[2] = clamp01(mean + (rgb[2] - mean) * scale);
}

/**
 * Run one cube corner through the whole Basic tone chain. White balance and
 * exposure work in linear light; the tone curves and the vibrance / saturation
 * pair work on the display-encoded values, which is where their pivots read the
 * way the slider labels promise.
 */
function developToneSample(rgb, whiteBalance, exposure, contrast, whites, blacks, vibrance, saturation) {
  if (whiteBalance || exposure) {
    let r = srgbToLinear(rgb[0]);
    let g = srgbToLinear(rgb[1]);
    let b = srgbToLinear(rgb[2]);
    if (whiteBalance) {
      apply3x3(whiteBalance, r, g, b, rgb);
      r = Math.max(0, rgb[0]);
      g = Math.max(0, rgb[1]);
      b = Math.max(0, rgb[2]);
    }
    if (exposure) {
      const gain = Math.pow(2, exposure);
      r *= gain;
      g *= gain;
      b *= gain;
      const peak = Math.max(r, g, b);
      if (peak > EXPOSURE_SHOULDER_KNEE) {
        const rolloff = compressHighlight(peak) / peak;
        r *= rolloff;
        g *= rolloff;
        b *= rolloff;
      }
    }
    rgb[0] = linearToSrgb(clamp01(r));
    rgb[1] = linearToSrgb(clamp01(g));
    rgb[2] = linearToSrgb(clamp01(b));
  }

  for (let channel = 0; channel < 3; channel++) {
    let value = clamp01(rgb[channel]);
    value = applyContrastCurve(value, contrast);
    value = applyEndpointCurves(clamp01(value), whites, blacks);
    rgb[channel] = clamp01(value);
  }

  if (vibrance || saturation) applyVibranceSaturation(rgb, vibrance, saturation);
}

function buildToneCube(whiteBalance, exposure, contrast, whites, blacks, vibrance, saturation) {
  const samples = new Float32Array(TONE_CUBE_EDGE * TONE_CUBE_EDGE * TONE_CUBE_EDGE * 3);
  const step = 1 / (TONE_CUBE_EDGE - 1);
  const rgb = [0, 0, 0];
  let offset = 0;
  for (let redIdx = 0; redIdx < TONE_CUBE_EDGE; redIdx++) {
    for (let greenIdx = 0; greenIdx < TONE_CUBE_EDGE; greenIdx++) {
      for (let blueIdx = 0; blueIdx < TONE_CUBE_EDGE; blueIdx++) {
        rgb[0] = redIdx * step;
        rgb[1] = greenIdx * step;
        rgb[2] = blueIdx * step;
        developToneSample(rgb, whiteBalance, exposure, contrast, whites, blacks, vibrance, saturation);
        samples[offset++] = rgb[0];
        samples[offset++] = rgb[1];
        samples[offset++] = rgb[2];
      }
    }
  }
  return samples;
}

function sampleToneCube(floatRgba, samples) {
  const edge = TONE_CUBE_EDGE;
  const scale = edge - 1.000001;
  const scratch = new Float32Array(12);
  const redStride = edge * edge * 3;
  const greenStride = edge * 3;
  for (let offset = 0; offset < floatRgba.length; offset += 4) {
    const redPos = scale * clamp01(floatRgba[offset]);
    const greenPos = scale * clamp01(floatRgba[offset + 1]);
    const bluePos = scale * clamp01(floatRgba[offset + 2]);
    const redIdx = redPos | 0;
    const greenIdx = greenPos | 0;
    const blueIdx = bluePos | 0;
    const redFraction = redPos - redIdx;
    const greenFraction = greenPos - greenIdx;
    const blueFraction = bluePos - blueIdx;
    const base = (redIdx * edge * edge + greenIdx * edge + blueIdx) * 3;

    mixTriple(samples, base, base + 3, blueFraction, 0, scratch);
    mixTriple(samples, base + greenStride, base + greenStride + 3, blueFraction, 3, scratch);
    mixTriple(scratch, 0, 3, greenFraction, 6, scratch);
    mixTriple(samples, base + redStride, base + redStride + 3, blueFraction, 0, scratch);
    mixTriple(samples, base + redStride + greenStride, base + redStride + greenStride + 3, blueFraction, 3, scratch);
    mixTriple(scratch, 0, 3, greenFraction, 9, scratch);
    mixTriple(scratch, 6, 9, redFraction, 0, scratch);

    floatRgba[offset] = scratch[0];
    floatRgba[offset + 1] = scratch[1];
    floatRgba[offset + 2] = scratch[2];
  }
}

function mixTriple(source, offsetA, offsetB, blend, destOffset, dest) {
  dest[destOffset] = source[offsetA] + (source[offsetB] - source[offsetA]) * blend;
  dest[destOffset + 1] = source[offsetA + 1] + (source[offsetB + 1] - source[offsetA + 1]) * blend;
  dest[destOffset + 2] = source[offsetA + 2] + (source[offsetB + 2] - source[offsetA + 2]) * blend;
}

/**
 * Highlights and Shadows lift or recover their end of the range through a
 * blurred gain map, so the correction follows large tonal regions instead of
 * per-pixel noise.
 */
function applyHighlightsShadows(floatRgba, width, height, highlights, shadows) {
  if (!highlights && !shadows) return;
  const pixelCount = width * height;
  const gain = new Float32Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4;
    const luma =
      floatRgba[offset] * LUMA_RED + floatRgba[offset + 1] * LUMA_GREEN + floatRgba[offset + 2] * LUMA_BLUE;
    gain[pixel] = luma < 0.3 ? shadows * 3 * (0.3 - luma) : highlights * 0.7 * (luma - 0.3);
  }
  const smoothed = new Float32Array(pixelCount);
  boxBlurPlane(gain, smoothed, width, height, 8);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4;
    const factor = 1 + smoothed[pixel];
    floatRgba[offset] = clamp01(floatRgba[offset] * factor);
    floatRgba[offset + 1] = clamp01(floatRgba[offset + 1] * factor);
    floatRgba[offset + 2] = clamp01(floatRgba[offset + 2] * factor);
  }
}

/**
 * Texture and Clarity are both unsharp masks on luminance, separated by radius
 * and by where they act: Texture works at a fine radius across the whole range,
 * Clarity at a broad radius weighted to the midtones.
 */
function applyTextureClarity(floatRgba, width, height, texture, clarity) {
  if (!texture && !clarity) return;
  const pixelCount = width * height;
  const luma = new Float32Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4;
    luma[pixel] =
      floatRgba[offset] * LUMA_RED + floatRgba[offset + 1] * LUMA_GREEN + floatRgba[offset + 2] * LUMA_BLUE;
  }
  const delta = new Float32Array(pixelCount);
  const smoothed = new Float32Array(pixelCount);

  if (texture) {
    boxBlurPlane(luma, smoothed, width, height, TEXTURE_RADIUS);
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      delta[pixel] += (luma[pixel] - smoothed[pixel]) * texture * 0.8;
    }
  }
  if (clarity) {
    const radius = Math.max(CLARITY_MIN_RADIUS, Math.round(Math.min(width, height) / CLARITY_RADIUS_DIVISOR));
    boxBlurPlane(luma, smoothed, width, height, radius);
    for (let pixel = 0; pixel < pixelCount; pixel++) {
      const midtoneWeight = 4 * luma[pixel] * (1 - luma[pixel]);
      delta[pixel] += (luma[pixel] - smoothed[pixel]) * clarity * 1.2 * midtoneWeight;
    }
  }
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4;
    const lift = delta[pixel];
    floatRgba[offset] = clamp01(floatRgba[offset] + lift);
    floatRgba[offset + 1] = clamp01(floatRgba[offset + 1] + lift);
    floatRgba[offset + 2] = clamp01(floatRgba[offset + 2] + lift);
  }
}

/**
 * Dehaze estimates the atmospheric light from the haziest region — the one with
 * the brightest dark channel — then divides the veil back out with a
 * transmission map derived from that same dark channel.
 */
function applyDehaze(floatRgba, width, height, dehaze) {
  if (!dehaze) return;
  const pixelCount = width * height;
  const darkChannel = new Float32Array(pixelCount);
  const grey = new Float32Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4;
    const r = floatRgba[offset];
    const g = floatRgba[offset + 1];
    const b = floatRgba[offset + 2];
    darkChannel[pixel] = Math.min(r, g, b);
    grey[pixel] = (r + g + b) / 3;
  }
  const radius = Math.max(1, Math.round(Math.min(width, height) / 80));
  const smoothedDark = new Float32Array(pixelCount);
  boxBlurPlane(darkChannel, smoothedDark, width, height, radius);

  let haziestPixel = 0;
  let haziestScore = -1;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const score = smoothedDark[pixel] * 0.7 + grey[pixel] * 0.3;
    if (score > haziestScore) {
      haziestScore = score;
      haziestPixel = pixel;
    }
  }
  const veilR = floatRgba[haziestPixel * 4];
  const veilG = floatRgba[haziestPixel * 4 + 1];
  const veilB = floatRgba[haziestPixel * 4 + 2];
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4;
    const transmission = Math.max(0.1, 1 - 0.9 * dehaze * smoothedDark[pixel]);
    const recover = 1 / transmission;
    floatRgba[offset] = clamp01((floatRgba[offset] - veilR) * recover + veilR);
    floatRgba[offset + 1] = clamp01((floatRgba[offset + 1] - veilG) * recover + veilG);
    floatRgba[offset + 2] = clamp01((floatRgba[offset + 2] - veilB) * recover + veilB);
  }
}

// --- Curve -------------------------------------------------------------------

/** Parametric tone curve: four overlapping tonal bands lifted or dropped. */
function developParametricCurve(floatRgba, scalars) {
  const highlights = (scalars.PC_H || 0) / 100;
  const lights = (scalars.PC_L || 0) / 100;
  const darks = (scalars.PC_D || 0) / 100;
  const shadows = (scalars.PC_S || 0) / 100;
  if (!highlights && !lights && !darks && !shadows) return;
  for (let offset = 0; offset < floatRgba.length; offset += 4) {
    const r = floatRgba[offset];
    const g = floatRgba[offset + 1];
    const b = floatRgba[offset + 2];
    const luma = r * LUMA_RED + g * LUMA_GREEN + b * LUMA_BLUE;
    const shadowWeight = Math.max(0, 1 - luma * 2);
    const highlightWeight = Math.max(0, luma * 2 - 1);
    const midWeight = 1 - shadowWeight - highlightWeight;
    const lift =
      shadows * shadowWeight * 0.45 +
      darks * (shadowWeight * 0.5 + midWeight * 0.35) +
      lights * (highlightWeight * 0.35 + midWeight * 0.5) +
      highlights * highlightWeight * 0.45;
    floatRgba[offset] = clamp01(r + lift);
    floatRgba[offset + 1] = clamp01(g + lift);
    floatRgba[offset + 2] = clamp01(b + lift);
  }
}

// --- Colour Mixer ------------------------------------------------------------

/**
 * Every band's weight comes from the pixel's original hue, so the eight bands
 * describe one simultaneous adjustment rather than a chain in which each band
 * sees the previous band's rotation.
 */
function developColorMixer(floatRgba, scalars) {
  const bandCount = COLOR_MIXER_BANDS.length;
  const hueShifts = new Float64Array(bandCount);
  const saturationShifts = new Float64Array(bandCount);
  const luminanceShifts = new Float64Array(bandCount);
  let anyShift = false;
  for (let bandIdx = 0; bandIdx < bandCount; bandIdx++) {
    const suffix = COLOR_MIXER_BANDS[bandIdx].suffix;
    hueShifts[bandIdx] = (scalars["HA_" + suffix] || 0) / 100;
    saturationShifts[bandIdx] = (scalars["SA_" + suffix] || 0) / 100;
    luminanceShifts[bandIdx] = (scalars["LA_" + suffix] || 0) / 100;
    if (hueShifts[bandIdx] || saturationShifts[bandIdx] || luminanceShifts[bandIdx]) anyShift = true;
  }
  if (!anyShift) return;

  const hsl = [0, 0, 0];
  const rgb = [0, 0, 0];
  for (let offset = 0; offset < floatRgba.length; offset += 4) {
    rgbToHsl(floatRgba[offset], floatRgba[offset + 1], floatRgba[offset + 2], hsl);
    const sourceHue = hsl[0];
    let hueDelta = 0;
    let saturationScale = 1;
    let lightnessDelta = 0;
    for (let bandIdx = 0; bandIdx < bandCount; bandIdx++) {
      const band = COLOR_MIXER_BANDS[bandIdx];
      const weight = bandWeight(sourceHue, band.centreHue, band.halfWidth);
      if (weight <= 0) continue;
      hueDelta += hueShifts[bandIdx] * MIXER_HUE_ROTATION_DEGREES * weight;
      saturationScale *= 1 + saturationShifts[bandIdx] * weight;
      lightnessDelta += luminanceShifts[bandIdx] * MIXER_LIGHTNESS_REACH * weight;
    }
    hslToRgb(
      sourceHue + hueDelta,
      clamp01(hsl[1] * saturationScale),
      clamp01(hsl[2] + lightnessDelta),
      rgb,
    );
    floatRgba[offset] = clamp01(rgb[0]);
    floatRgba[offset + 1] = clamp01(rgb[1]);
    floatRgba[offset + 2] = clamp01(rgb[2]);
  }
}

/** Triangular falloff from a band's centre hue, wrapping across 0°. */
function bandWeight(hue, centreHue, halfWidth) {
  let distance = Math.abs(hue - centreHue);
  if (distance > 180) distance = 360 - distance;
  if (distance >= halfWidth) return 0;
  return 1 - distance / halfWidth;
}

// --- Split Toning ------------------------------------------------------------

function developSplitToning(floatRgba, scalars) {
  const highlightSaturation = (scalars.STHS || 0) / 100;
  const shadowSaturation = (scalars.STSS || 0) / 100;
  if (!highlightSaturation && !shadowSaturation) return;
  const highlightHue = scalars.STHH || 0;
  const shadowHue = scalars.STSH || 0;
  const balance = (scalars.STB || 0) / 100;
  const highlightTint = hslToRgb(highlightHue, 1, 0.5, [0, 0, 0]);
  const shadowTint = hslToRgb(shadowHue, 1, 0.5, [0, 0, 0]);

  for (let offset = 0; offset < floatRgba.length; offset += 4) {
    let r = floatRgba[offset];
    let g = floatRgba[offset + 1];
    let b = floatRgba[offset + 2];
    const luma = r * LUMA_RED + g * LUMA_GREEN + b * LUMA_BLUE;
    const highlightMix = clamp01((luma - (0.5 + balance * 0.25)) / 0.5);
    const shadowMix = 1 - highlightMix;
    if (highlightSaturation > 0 && highlightMix > 0) {
      const strength = highlightSaturation * highlightMix * 0.5;
      r += (highlightTint[0] - r) * strength;
      g += (highlightTint[1] - g) * strength;
      b += (highlightTint[2] - b) * strength;
    }
    if (shadowSaturation > 0 && shadowMix > 0) {
      const strength = shadowSaturation * shadowMix * 0.5;
      r += (shadowTint[0] - r) * strength;
      g += (shadowTint[1] - g) * strength;
      b += (shadowTint[2] - b) * strength;
    }
    floatRgba[offset] = clamp01(r);
    floatRgba[offset + 1] = clamp01(g);
    floatRgba[offset + 2] = clamp01(b);
  }
}

// --- Calibration -------------------------------------------------------------

/**
 * The primary sliders rebuild the working space's primaries and recombine the
 * image over them; the shadow tint rides on top, pushing the darkest pixels
 * along the green ↔ magenta axis.
 */
function developCalibration(floatRgba, scalars) {
  const primaries = buildCalibrationMatrix(
    [scalars.RHue || 0, scalars.GHue || 0, scalars.BHue || 0],
    [scalars.RSat || 0, scalars.GSat || 0, scalars.BSat || 0],
  );
  const shadowTint = ((scalars.ShdT || 0) / 100) * SHADOW_TINT_REACH;
  if (!primaries && !shadowTint) return;

  const mixed = [0, 0, 0];
  for (let offset = 0; offset < floatRgba.length; offset += 4) {
    let r = floatRgba[offset];
    let g = floatRgba[offset + 1];
    let b = floatRgba[offset + 2];
    if (primaries) {
      apply3x3(primaries, srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), mixed);
      r = linearToSrgb(clamp01(mixed[0]));
      g = linearToSrgb(clamp01(mixed[1]));
      b = linearToSrgb(clamp01(mixed[2]));
    }
    if (shadowTint) {
      const luma = r * LUMA_RED + g * LUMA_GREEN + b * LUMA_BLUE;
      const shadowWeight = (1 - luma) * (1 - luma);
      const push = shadowTint * shadowWeight;
      r += push;
      g -= push;
      b += push;
    }
    floatRgba[offset] = clamp01(r);
    floatRgba[offset + 1] = clamp01(g);
    floatRgba[offset + 2] = clamp01(b);
  }
}

// --- Optics and Effects ------------------------------------------------------

function developOptics(floatRgba, width, height, scalars, scratch) {
  applyDistortion(floatRgba, width, height, (scalars.MDis || 0) / 100, scratch);
  applyVignette(floatRgba, width, height, (scalars.VigA || 0) / 100);
}

function developEffects(floatRgba, width, height, scalars) {
  applyVignette(floatRgba, width, height, (scalars.PCVA || 0) / 100);
  applyGrain(
    floatRgba,
    width,
    height,
    (scalars.GRNA || 0) / 100,
    (scalars.GrainSize || 0) / 100,
    (scalars.GrainFrequency || 0) / 100,
  );
}

/** Radial darkening (positive) or brightening (negative) toward the corners. */
function applyVignette(floatRgba, width, height, amount) {
  if (!amount) return;
  const centreX = (width - 1) * 0.5;
  const centreY = (height - 1) * 0.5;
  const maxDistance = Math.sqrt(centreX * centreX + centreY * centreY) || 1;
  for (let y = 0; y < height; y++) {
    const normalizedY = (y - centreY) / maxDistance;
    for (let x = 0; x < width; x++) {
      const normalizedX = (x - centreX) / maxDistance;
      const factor = 1 - amount * (normalizedX * normalizedX + normalizedY * normalizedY);
      const offset = (y * width + x) * 4;
      floatRgba[offset] = clamp01(floatRgba[offset] * factor);
      floatRgba[offset + 1] = clamp01(floatRgba[offset + 1] * factor);
      floatRgba[offset + 2] = clamp01(floatRgba[offset + 2] * factor);
    }
  }
}

/** Radial magnification, correcting barrel (positive) or pincushion (negative). */
function applyDistortion(floatRgba, width, height, distortion, scratch) {
  if (!distortion) return;
  const source = takeScratchCopy(floatRgba, scratch);
  const centreX = (width - 1) * 0.5;
  const centreY = (height - 1) * 0.5;
  const maxRadius = Math.sqrt(centreX * centreX + centreY * centreY) || 1;
  const strength = distortion * 0.35;
  for (let y = 0; y < height; y++) {
    const normalizedY = (y - centreY) / maxRadius;
    for (let x = 0; x < width; x++) {
      const normalizedX = (x - centreX) / maxRadius;
      const radiusSquared = normalizedX * normalizedX + normalizedY * normalizedY;
      const scale = 1 + strength * radiusSquared;
      const sourceX = centreX + (x - centreX) / scale;
      const sourceY = centreY + (y - centreY) / scale;
      const destOffset = (y * width + x) * 4;
      sampleBilinear(source, width, height, sourceX, sourceY, floatRgba, destOffset);
    }
  }
}

/** Two-octave film grain: a blocky base layer plus a per-pixel roughness layer. */
function applyGrain(floatRgba, width, height, amount, size, roughness) {
  if (!amount) return;
  const cell = Math.max(1, Math.round(1 + size * 6));
  const seed = (Math.round(roughness * 997) + 13) | 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const coarse = grainNoise(Math.floor(x / cell), Math.floor(y / cell), seed) - 0.5;
      const fine = (grainNoise(x, y, seed ^ 0x9e3779b9) - 0.5) * roughness;
      const delta = (coarse * (1 - roughness * 0.5) + fine) * amount * 0.25;
      const offset = (y * width + x) * 4;
      floatRgba[offset] = clamp01(floatRgba[offset] + delta);
      floatRgba[offset + 1] = clamp01(floatRgba[offset + 1] + delta);
      floatRgba[offset + 2] = clamp01(floatRgba[offset + 2] + delta);
    }
  }
}

function grainNoise(x, y, seed) {
  let hash = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  hash = (hash ^ (hash >>> 13)) * 1274126177;
  hash = hash ^ (hash >>> 16);
  return (hash & 0xffff) / 0xffff;
}

// --- Detail ------------------------------------------------------------------

function developDetail(floatRgba, width, height, scalars, scratch) {
  applyUnsharpMask(floatRgba, width, height, (scalars.Shrp || 0) / 100, scalars.ShpR || 1, scratch);
  applyLuminanceNoiseReduction(floatRgba, width, height, (scalars.LNR || 0) / 100, scratch);
  applyColorNoiseReduction(floatRgba, width, height, (scalars.CNR || 0) / 100, scratch);
}

function applyUnsharpMask(floatRgba, width, height, amount, radius, scratch) {
  if (amount <= 0) return;
  const source = takeScratchCopy(floatRgba, scratch);
  const span = Math.max(1, Math.round(radius));
  const sampleCount = (span * 2 + 1) * (span * 2 + 1);
  for (let y = span; y < height - span; y++) {
    for (let x = span; x < width - span; x++) {
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        let blurred = 0;
        for (let dy = -span; dy <= span; dy++) {
          for (let dx = -span; dx <= span; dx++) {
            blurred += source[((y + dy) * width + (x + dx)) * 4 + channel];
          }
        }
        blurred /= sampleCount;
        const value = source[offset + channel];
        floatRgba[offset + channel] = clamp01(value + (value - blurred) * amount);
      }
    }
  }
}

/** Blend each pixel toward its 3×3 mean; luminance detail goes with it. */
function applyLuminanceNoiseReduction(floatRgba, width, height, amount, scratch) {
  if (amount <= 0) return;
  const source = takeScratchCopy(floatRgba, scratch);
  const mean = [0, 0, 0];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const offset = (y * width + x) * 4;
      neighbourhoodMean(source, width, x, y, mean);
      floatRgba[offset] = clamp01(source[offset] + (mean[0] - source[offset]) * amount);
      floatRgba[offset + 1] = clamp01(source[offset + 1] + (mean[1] - source[offset + 1]) * amount);
      floatRgba[offset + 2] = clamp01(source[offset + 2] + (mean[2] - source[offset + 2]) * amount);
    }
  }
}

/**
 * Blend only the chroma toward the 3×3 mean, holding each pixel's own
 * luminance, so colour speckle smooths without softening detail.
 */
function applyColorNoiseReduction(floatRgba, width, height, amount, scratch) {
  if (amount <= 0) return;
  const source = takeScratchCopy(floatRgba, scratch);
  const mean = [0, 0, 0];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const offset = (y * width + x) * 4;
      neighbourhoodMean(source, width, x, y, mean);
      const meanLuma = mean[0] * LUMA_RED + mean[1] * LUMA_GREEN + mean[2] * LUMA_BLUE;
      const luma =
        source[offset] * LUMA_RED + source[offset + 1] * LUMA_GREEN + source[offset + 2] * LUMA_BLUE;
      for (let channel = 0; channel < 3; channel++) {
        const ownChroma = source[offset + channel] - luma;
        const meanChroma = mean[channel] - meanLuma;
        floatRgba[offset + channel] = clamp01(luma + ownChroma + (meanChroma - ownChroma) * amount);
      }
    }
  }
}

function neighbourhoodMean(source, width, x, y, out) {
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const offset = ((y + dy) * width + (x + dx)) * 4;
      sumR += source[offset];
      sumG += source[offset + 1];
      sumB += source[offset + 2];
    }
  }
  out[0] = sumR / 9;
  out[1] = sumG / 9;
  out[2] = sumB / 9;
  return out;
}

// --- Geometry ----------------------------------------------------------------

/**
 * Upright keystone correction. Level shears the frame around its centre row;
 * Vertical and Full scale each row toward or away from the centre column, which
 * is the horizontal component of a vertical perspective correction.
 */
function developGeometry(floatRgba, width, height, scalars, scratch) {
  const mode = scalars.PerU | 0;
  if (mode <= 0 || mode >= 5) return;
  const source = takeScratchCopy(floatRgba, scratch);
  const strength = mode === 4 ? 0.08 : mode === 3 ? 0.06 : 0.03;
  const centreX = (width - 1) * 0.5;
  const verticalCorrection = mode === 3 || mode === 4;
  for (let y = 0; y < height; y++) {
    const rowPosition = (y / (height - 1 || 1) - 0.5) * 2;
    for (let x = 0; x < width; x++) {
      const columnPosition = (x - centreX) / (centreX || 1);
      const sourceX = verticalCorrection
        ? centreX + (x - centreX) * (1 + rowPosition * strength)
        : x - columnPosition * rowPosition * strength * width * 0.15;
      sampleBilinear(source, width, height, sourceX, y, floatRgba, (y * width + x) * 4);
    }
  }
}

// --- Shared pixel helpers ----------------------------------------------------

/** Separable box blur over a single-channel plane. */
function boxBlurPlane(source, dest, width, height, radius) {
  if (radius < 1) {
    dest.set(source);
    return;
  }
  const scratch = new Float32Array(source.length);
  const normalize = 1 / (radius * 2 + 1);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) {
      sum += source[row + Math.max(0, Math.min(width - 1, x))];
    }
    for (let x = 0; x < width; x++) {
      scratch[row + x] = sum * normalize;
      sum += source[row + Math.min(width - 1, x + radius + 1)] - source[row + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) {
      sum += scratch[Math.max(0, Math.min(height - 1, y)) * width + x];
    }
    for (let y = 0; y < height; y++) {
      dest[y * width + x] = sum * normalize;
      sum += scratch[Math.min(height - 1, y + radius + 1) * width + x] -
        scratch[Math.max(0, y - radius) * width + x];
    }
  }
}

/** Bilinear resample, clamping at the edges so warps do not tear a black rim. */
function sampleBilinear(source, width, height, x, y, dest, destOffset) {
  const clampedX = Math.max(0, Math.min(width - 1, x));
  const clampedY = Math.max(0, Math.min(height - 1, y));
  const leftIdx = Math.min(width - 1, Math.floor(clampedX));
  const topIdx = Math.min(height - 1, Math.floor(clampedY));
  const rightIdx = Math.min(width - 1, leftIdx + 1);
  const bottomIdx = Math.min(height - 1, topIdx + 1);
  const fractionX = clampedX - leftIdx;
  const fractionY = clampedY - topIdx;
  const topLeft = (topIdx * width + leftIdx) * 4;
  const topRight = (topIdx * width + rightIdx) * 4;
  const bottomLeft = (bottomIdx * width + leftIdx) * 4;
  const bottomRight = (bottomIdx * width + rightIdx) * 4;
  for (let channel = 0; channel < 4; channel++) {
    const top = source[topLeft + channel] + (source[topRight + channel] - source[topLeft + channel]) * fractionX;
    const bottom =
      source[bottomLeft + channel] + (source[bottomRight + channel] - source[bottomLeft + channel]) * fractionX;
    dest[destOffset + channel] = top + (bottom - top) * fractionY;
  }
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function bytesToFloat(sourceBytes, floatRgba) {
  for (let i = 0; i < sourceBytes.length; i++) floatRgba[i] = sourceBytes[i] * (1 / 255);
}

function floatToBytes(floatRgba, destBytes) {
  for (let i = 0; i < floatRgba.length; i++) {
    const scaled = Math.round(floatRgba[i] * 255);
    destBytes[i] = scaled < 0 ? 0 : scaled > 255 ? 255 : scaled;
  }
}
