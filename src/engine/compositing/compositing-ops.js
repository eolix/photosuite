/**
 * PSD blend-mode math, lookup tables, and RGBA compositing pipelines.
 */

import { allocBuffer } from "./buffer-utils.js";
import { copyChannel, mulDiv255 } from "./pixel-ops.js";
import { luminanceFromRgb, rgbLuminance, rgbSaturation } from "./color-math.js";

const FILL_OPACITY_BLEND_MODES = "idiv,lbrn,div ,lddg,vLit,lLit,hMix,diff".split(",");
const NON_SEPARABLE_BLEND_MODES = "norm,dark,mul ,idiv,lbrn,lite,scrn,div ,lddg,over,sLit,hLit,vLit,lLit,pLit,hMix,diff,smud,fsub,fdiv".split(",");
const SEPARABLE_BLEND_MODES = "dkCl,lgCl,hue ,sat ,colr,lum ".split(",");

function createDefaultBlendStyleParams() {
  return { fill: 1, blendIfTable: null, style: false, preserveDestAlpha: false };
}

/** @returns {{ recipLut: Float64Array, divLut: Uint8Array, mulLut: Uint8Array }} */
function buildBlendLookupTables() {
  const recipLut = new Float64Array(256);
  const divLut = new Uint8Array(256 * 256);
  const mulLut = new Uint8Array(256 * 256);
  for (let lutIdx = 0; lutIdx < 256; lutIdx++) {
    recipLut[lutIdx] = 255 / lutIdx;
  }
  for (let row = 0; row < 256; row++) {
    for (let col = 0; col < 256; col++) {
      divLut[row * 256 + col] = row === 0 ? 0 : Math.round((col * 255) / row);
      mulLut[row * 256 + col] = Math.round((row * (255 - col)) / 255);
    }
  }
  return { recipLut, divLut, mulLut };
}

function intersectCompositeRegion(sourceRect, destRect, clipRect) {
  const intersectRect = sourceRect.intersect(destRect).intersect(clipRect);
  return {
    srcOffX: Math.max(0, intersectRect.x - sourceRect.x),
    dstOffX: Math.max(0, intersectRect.x - destRect.x),
    srcOffY: Math.max(0, intersectRect.y - sourceRect.y),
    dstOffY: Math.max(0, intersectRect.y - destRect.y),
    regionWidth: intersectRect.width,
    regionHeight: intersectRect.height,
    srcStride: sourceRect.width,
    dstStride: destRect.width,
  };
}

function lcg32(seed) {
  seed = seed ^ 61 ^ seed >>> 16;
  seed = seed + (seed << 3);
  seed = seed ^ seed >>> 4;
  seed = seed * 668265261;
  seed = seed ^ seed >>> 15;
  return seed;
}

function initRngUnit(seed) {
  seed = seed ^ 61 ^ seed >>> 16;
  seed = seed + (seed << 3);
  seed = seed ^ seed >>> 4;
  seed = seed * 668265261;
  seed = seed ^ seed >> 15;
  return (seed & 16777215) * (1 / 16777215);
}

function BlendRngState(seed) {
  this.seed = seed;
}
BlendRngState.prototype.get = function() {
  const state = (this.seed = lcg32(this.seed));
  return (state & 16777215) * (1 / 16777215);
};

/**
 * The per-channel blend function for each PSD blend mode, keyed by the mode's
 * four-character code with an "F" suffix — the key a layer's `Md` descriptor
 * resolves to. Modes whose code carries a trailing space keep it in the key.
 */
export const BLEND_FUNCTIONS = {
  "mul F": multiplyF,
  "div F": colorDivideF,
  "hue F": hueBlendF,
  "sat F": saturationBlendF,
  "lum F": luminosityBlendF,
  colorBurnF,
  colorDodgeF,
  normF,
  darkF,
  idivF,
  lbrnF,
  dkClF,
  liteF,
  scrnF,
  lddgF,
  lgClF,
  overF,
  sLitF,
  hLitF,
  vLitF,
  lLitF,
  pLitF,
  hMixF,
  diffF,
  smudF,
  fsubF,
  fdivF,
  colrF,
};

/** Reciprocal / divide / multiply lookups the blend maths reads per pixel. */
const { recipLut, divLut, mulLut } = buildBlendLookupTables();

export { BlendRngState as RngState, initRngUnit as initRng, lcg32, recipLut, divLut, mulLut };

function routeCompositeBlend(mode, sourceRgba, sourceRect, destRgba, destRect, clipRect, opacity, styleParams) {
  const blendFn = BLEND_FUNCTIONS[mode + "F"];
  const preserveDestAlpha = styleParams.preserveDestAlpha ? 1 : 0;
  if (styleParams.blendIfTable == null && mode == "norm") {
    compositeNormal(sourceRgba, sourceRect, destRgba, destRect, clipRect, opacity, blendFn, preserveDestAlpha);
  } else if (mode == "diss") {
    compositeDissolved(sourceRgba, sourceRect, destRgba, destRect, clipRect, opacity, blendFn, preserveDestAlpha);
  } else if (NON_SEPARABLE_BLEND_MODES.indexOf(mode) != -1) {
    compositeNonSeparable(sourceRgba, sourceRect, destRgba, destRect, clipRect, opacity, blendFn, styleParams);
  } else if (SEPARABLE_BLEND_MODES.indexOf(mode) != -1) {
    compositeSeparable(sourceRgba, sourceRect, destRgba, destRect, clipRect, opacity, blendFn, styleParams);
  }
}

/**
 * Smart-object stack modes: combine N per-layer pixel planes into one buffer by a
 * per-pixel statistic (mode is a Photoshop stack FourCC: avrg, maxx, minn, medn,
 * summ, stdv, vari, rang). Unrecognized modes leave {@code dst} unchanged.
 */
export function combineLayerPlanes(planes, dst, mode) {
  const planeCount = planes.length;
  const pixelCount = dst.length;
  if (planeCount === 1) {
    dst.set(planes[0]);
    return;
  }

  if (mode === "avrg" || mode === "stdv" || mode === "summ" || mode === "vari") {
    const invPlaneCount = 1 / planeCount;
    for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
      let channelSum = 0;
      for (let planeIdx = 0; planeIdx < planeCount; planeIdx++) {
        channelSum += planes[planeIdx][pixelIdx];
      }
      const mean = ~~(channelSum * invPlaneCount + 0.5);
      if (mode === "avrg" || (pixelIdx & 3) === 3) {
        dst[pixelIdx] = mean;
      } else if (mode === "summ") {
        dst[pixelIdx] = 255 * Math.pow(Math.min(255, channelSum) * (1 / 255), 1 / 2.4);
      } else {
        let varianceSum = 0;
        for (let planeIdx = 0; planeIdx < planeCount; planeIdx++) {
          const delta = planes[planeIdx][pixelIdx] - mean;
          varianceSum += delta * delta;
        }
        const stdNorm = Math.sqrt(varianceSum * invPlaneCount) * (1 / 255);
        if (mode === "stdv") dst[pixelIdx] = 255 * Math.pow(stdNorm, 1 / 2.4);
        else dst[pixelIdx] = 255 * Math.pow(stdNorm * stdNorm, 1 / 2.4);
      }
    }
    return;
  }

  if (mode === "maxx") {
    for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
      let peak = 0;
      for (let planeIdx = 0; planeIdx < planeCount; planeIdx++) {
        peak = Math.max(peak, planes[planeIdx][pixelIdx]);
      }
      dst[pixelIdx] = peak;
    }
    return;
  }

  if (mode === "minn") {
    for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
      let floor = 255;
      for (let planeIdx = 0; planeIdx < planeCount; planeIdx++) {
        floor = Math.min(floor, planes[planeIdx][pixelIdx]);
      }
      dst[pixelIdx] = floor;
    }
    return;
  }

  if (mode === "medn" || mode === "rang") {
    const scratch = new Array(planeCount);
    // Median averages the two central order statistics (indices m-1 and m of the
    // sorted plane values), matching the original stack-mode behavior.
    const medianHi = planeCount >>> 1;
    const medianLo = medianHi - 1;
    for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
      for (let planeIdx = 0; planeIdx < planeCount; planeIdx++) {
        scratch[planeIdx] = planes[planeIdx][pixelIdx];
      }
      scratch.sort((a, b) => a - b);
      if (mode === "medn") {
        dst[pixelIdx] = (scratch[medianLo] + scratch[medianHi]) >>> 1;
      } else {
        dst[pixelIdx] =
          (pixelIdx & 3) === 3
            ? scratch[planeCount - 1]
            : scratch[planeCount - 1] - scratch[0];
      }
    }
  }
}

/**
 * Composite a source buffer onto a destination under a PSD blend mode.
 * The mode picks a per-channel blend function and the pipeline that applies it.
 */
export function composite(mode, sourceRgba, sourceRect, destRgba, destRect, clipRect, opacity, styleParams) {
  if (styleParams == null) styleParams = createDefaultBlendStyleParams();
  if (FILL_OPACITY_BLEND_MODES.indexOf(mode) == -1) {
    opacity = opacity * styleParams.fill;
    styleParams.fill = 1;
    styleParams.style = false
  }
  routeCompositeBlend(mode, sourceRgba, sourceRect, destRgba, destRect, clipRect, opacity, styleParams);
}

export function colorBurnF(srcCh, dstCh, blendWeight) {
  var burnDenom = srcCh * blendWeight + 1 - blendWeight;
  return burnDenom < .001 ? 0 : 1 - Math.min(1, (1 - dstCh) / burnDenom)
}

export function colorDodgeF(srcCh, dstCh, blendWeight) {
  return srcCh * blendWeight == 1 ? 1 : Math.min(1, dstCh / (1 - srcCh * blendWeight))
}

export function softLightD(srcCh) {
  return srcCh <= .25 ? ((16 * srcCh - 12) * srcCh + 4) * srcCh : Math.sqrt(srcCh)
}

export function normF(srcCh, dstCh, blendWeight) {
  return srcCh
}

export function darkF(srcCh, dstCh, blendWeight) {
  return Math.min(srcCh, dstCh)
}

export function multiplyF(srcCh, dstCh, blendWeight) {
  return srcCh * dstCh
}

export function idivF(srcCh, dstCh, blendWeight) {
  var invDivDenom = srcCh * blendWeight + 1 - blendWeight;
  return dstCh == 1 ? 1 : 1 - dstCh >= invDivDenom ? 0 : 1 - (1 - dstCh) / invDivDenom
}

export function lbrnF(srcCh, dstCh, blendWeight) {
  return Math.max(0, srcCh * blendWeight + dstCh - blendWeight)
}

export function dkClF(srcRgb, dstRgb, outRgb) {
  var picked = rgbLuminance(srcRgb) < rgbLuminance(dstRgb) ? srcRgb : dstRgb;
  outRgb.h = picked.h;
  outRgb.l = picked.l;
  outRgb.O = picked.O;
  return outRgb
}

export function liteF(srcCh, dstCh, blendWeight) {
  return Math.max(srcCh, dstCh)
}

export function scrnF(srcCh, dstCh, blendWeight) {
  return dstCh + srcCh - dstCh * srcCh
}

export function colorDivideF(srcCh, dstCh, blendWeight) {
  srcCh *= blendWeight;
  return dstCh == 0 ? 0 : dstCh >= 1 - srcCh ? 1 : dstCh / (1 - srcCh)
}

export function lddgF(srcCh, dstCh, blendWeight) {
  srcCh *= blendWeight;
  return Math.min(1, srcCh + dstCh)
}

export function lgClF(srcRgb, dstRgb, outRgb) {
  var picked = rgbLuminance(srcRgb) > rgbLuminance(dstRgb) ? srcRgb : dstRgb;
  outRgb.h = picked.h;
  outRgb.l = picked.l;
  outRgb.O = picked.O;
  return outRgb
}

export function overF(srcCh, dstCh, blendWeight) {
  return hLitF(dstCh, srcCh, blendWeight);
}

export function sLitF(srcCh, dstCh, blendWeight) {
  return srcCh <= .5 ? dstCh - (1 - 2 * srcCh) * dstCh * (1 - dstCh) : dstCh + (2 * srcCh - 1) * (softLightD(dstCh) - dstCh);
}

export function hLitF(srcCh, dstCh, blendWeight) {
  return srcCh <= .5 ? multiplyF(2 * srcCh, dstCh, blendWeight) : scrnF(2 * srcCh - 1, dstCh, blendWeight);
}

export function vLitF(srcCh, dstCh, blendWeight) {
  return srcCh <= .5 ? colorBurnF(2 * srcCh, dstCh, blendWeight) : colorDodgeF(2 * srcCh - 1, dstCh, blendWeight);
}

export function lLitF(srcCh, dstCh, blendWeight) {
  return srcCh <= .5 ? lbrnF(2 * srcCh, dstCh, blendWeight) : lddgF(2 * srcCh - 1, dstCh, blendWeight);
}

export function pLitF(srcCh, dstCh, blendWeight) {
  return srcCh <= .5 ? darkF(2 * srcCh, dstCh, blendWeight) : liteF(2 * srcCh - 1, dstCh, blendWeight);
}

export function hMixF(srcCh, dstCh, blendWeight) {
  if (blendWeight > .99) return srcCh + dstCh < 1 ? 0 : 1;
  return Math.min(1, Math.max(0, (dstCh + srcCh * blendWeight - blendWeight) / (1 - blendWeight + 1e-6)))
}

export function diffF(srcCh, dstCh, blendWeight) {
  srcCh *= blendWeight;
  return Math.abs(srcCh - dstCh)
}

export function smudF(srcCh, dstCh, blendWeight) {
  return srcCh + dstCh - 2 * srcCh * dstCh
}

export function fsubF(srcCh, dstCh, blendWeight) {
  return Math.max(dstCh - srcCh, 0)
}

export function fdivF(srcCh, dstCh, blendWeight) {
  return Math.min(dstCh / srcCh, 1)
}

export function hueBlendF(srcRgb, dstRgb, outRgb) {
  setHueSaturation(srcRgb, rgbSaturation(dstRgb), outRgb);
  setLuminance(outRgb, rgbLuminance(dstRgb), outRgb)
}

export function saturationBlendF(srcRgb, dstRgb, outRgb) {
  setHueSaturation(dstRgb, rgbSaturation(srcRgb), outRgb);
  setLuminance(outRgb, rgbLuminance(dstRgb), outRgb)
}

export function colrF(srcRgb, dstRgb, outRgb) {
  setLuminance(srcRgb, rgbLuminance(dstRgb), outRgb)
}

export function luminosityBlendF(srcRgb, dstRgb, outRgb) {
  setLuminance(dstRgb, rgbLuminance(srcRgb), outRgb)
}

export function setLuminance(srcRgb, targetLum, outRgb) {
  var delta = targetLum - rgbLuminance(srcRgb);
  outRgb.h = srcRgb.h + delta;
  outRgb.l = srcRgb.l + delta;
  outRgb.O = srcRgb.O + delta;
  clampRgbToLuminance(outRgb)
}

export function clampRgbToLuminance(rgb) {
  var r = rgb.h,
    g = rgb.l,
    b = rgb.O,
    lum = luminanceFromRgb(r, g, b),
    minCh = Math.min(r, g, b),
    maxCh = Math.max(r, g, b);
  if (minCh < 0) {
    var scale = lum / (lum - minCh);
    r = lum + (r - lum) * scale;
    g = lum + (g - lum) * scale;
    b = lum + (b - lum) * scale
  }
  if (maxCh > 1) {
    var scale = (1 - lum) / (maxCh - lum);
    r = lum + (r - lum) * scale;
    g = lum + (g - lum) * scale;
    b = lum + (b - lum) * scale
  }
  rgb.h = r;
  rgb.l = g;
  rgb.O = b
}

export function setHueSaturation(srcRgb, saturation, outRgb) {
  var clip = clipColor,
    r = srcRgb.h,
    g = srcRgb.l,
    b = srcRgb.O;
  if (r == g && g == b) {
    outRgb.h = outRgb.l = outRgb.O = 0
  } else if (r > g) {
    if (r > b) {
      if (g > b) {
        outRgb.h = saturation;
        outRgb.l = clip(r, g, b, saturation);
        outRgb.O = 0
      } else {
        outRgb.h = saturation;
        outRgb.O = clip(r, b, g, saturation);
        outRgb.l = 0
      }
    } else {
      outRgb.O = saturation;
      outRgb.h = clip(b, r, g, saturation);
      outRgb.l = 0
    }
  } else {
    if (r < b) {
      if (g > b) {
        outRgb.l = saturation;
        outRgb.O = clip(g, b, r, saturation);
        outRgb.h = 0
      } else {
        outRgb.O = saturation;
        outRgb.l = clip(b, g, r, saturation);
        outRgb.h = 0
      }
    } else {
      outRgb.l = saturation;
      outRgb.h = clip(g, r, b, saturation);
      outRgb.O = 0
    }
  }
}

export function clipColor(maxCh, midCh, minCh, saturation) {
  return (midCh - minCh) * saturation / (maxCh - minCh)
}

export function compositeNormal(sourceRgba, sourceRect, destRgba, destRect, clipRect, opacity, blendFn, preserveDestAlpha) {
  const region = intersectCompositeRegion(sourceRect, destRect, clipRect),
    srcOffX = region.srcOffX,
    dstOffX = region.dstOffX,
    srcOffY = region.srcOffY,
    dstOffY = region.dstOffY,
    regionWidth = region.regionWidth,
    regionHeight = region.regionHeight,
    srcStride = region.srcStride,
    dstStride = region.dstStride,
    srcU32 = new Uint32Array(sourceRgba.buffer),
    dstU32 = new Uint32Array(destRgba.buffer);
  for (var row = 0; row < regionHeight; row++) {
    var srcRow = (srcOffY + row) * srcStride + srcOffX,
      dstRow = (dstOffY + row) * dstStride + dstOffX;
    for (var col = 0; col < regionWidth; col++) {
      var srcPx = srcU32[srcRow + col],
        dstAlphaByte = 255;
      if (srcPx >>> 24 == 0) continue;
      if (srcPx >>> 24 == 255 && opacity == 1 && preserveDestAlpha == 0) {
        dstU32[dstRow + col] = srcU32[srcRow + col];
        continue
      }
      var dstPx = dstU32[dstRow + col],
        srcAlphaScaled = 255 * opacity & 255;
      if (preserveDestAlpha == 0) {
        srcAlphaScaled = (srcPx >>> 24) * opacity & 255;
        dstAlphaByte = dstPx >>> 24
      }
      var dstAlphaScaled = mulLut[dstAlphaByte << 8 | srcAlphaScaled],
        outAlphaByte = srcAlphaScaled + dstAlphaScaled,
        srcB = srcPx & 255,
        srcG = srcPx >>> 8 & 255,
        srcR = srcPx >>> 16 & 255,
        dstB = dstPx & 255,
        dstG = dstPx >>> 8 & 255,
        dstR = dstPx >>> 16 & 255;
      dstU32[dstRow + col] = preserveDestAlpha * (dstPx >>> 24) + (1 - preserveDestAlpha) * outAlphaByte << 24 | divLut[outAlphaByte << 8 | mulDiv255(srcR * srcAlphaScaled + dstR * dstAlphaScaled)] << 16 | divLut[outAlphaByte << 8 | mulDiv255(srcG * srcAlphaScaled + dstG * dstAlphaScaled)] << 8 | divLut[outAlphaByte << 8 | mulDiv255(srcB * srcAlphaScaled + dstB * dstAlphaScaled)]
    }
  }
}

export function compositeNormalDithered(sourceRgba, sourceRect, destRgba, destRect, clipRect, opacity) {
  var intersectRect = sourceRect.intersect(destRect).intersect(clipRect),
    srcOffX = Math.max(0, intersectRect.x - sourceRect.x),
    dstOffX = Math.max(0, intersectRect.x - destRect.x),
    srcOffY = Math.max(0, intersectRect.y - sourceRect.y),
    dstOffY = Math.max(0, intersectRect.y - destRect.y),
    regionWidth = intersectRect.width,
    regionHeight = intersectRect.height,
    srcStride = sourceRect.width,
    dstStride = destRect.width,
    srcU32 = new Uint32Array(sourceRgba.buffer),
    dstU32 = new Uint32Array(destRgba.buffer),
    ditherSeed = Math.floor(Math.random() * 16777215),
    ditherBits = 0;
  for (var rowIdx = 0; rowIdx < regionHeight; rowIdx++) {
    var srcRow = (srcOffY + rowIdx) * srcStride + srcOffX,
      dstRow = (dstOffY + rowIdx) * dstStride + dstOffX;
    for (var col = 0; col < regionWidth; col++) {
      var srcPx = srcU32[srcRow + col];
      if (srcPx >>> 24 == 0) continue;
      if (srcPx >> 24 == 255 && opacity == 1) {
        dstU32[dstRow + col] = srcPx;
        continue
      }
      var dstPx = dstU32[dstRow + col],
        srcAlphaW = (srcPx >>> 24) * opacity * (1 / 255),
        dstAlphaW = (dstPx >>> 24) * (1 / 255),
        dstContrib = dstAlphaW * (1 - srcAlphaW),
        outAlphaW = srcAlphaW + dstContrib,
        srcB = srcPx & 255,
        srcG = srcPx >>> 8 & 255,
        srcR = srcPx >>> 16 & 255,
        dstB = dstPx & 255,
        dstG = dstPx >>> 8 & 255,
        dstR = dstPx >>> 16 & 255;
      ditherBits >>>= 8;
      if ((col & 3) == 0) ditherBits = lcg32(dstRow + col + ditherSeed);
      var invOutAlpha = outAlphaW == 0 ? 0 : 1 / outAlphaW,
        outAlphaByte = Math.floor(outAlphaW * (256 * 255)) + (ditherBits & 255) >>> 8,
        outR = Math.floor((srcR * srcAlphaW + dstR * dstContrib) * invOutAlpha + .5),
        outG = Math.floor((srcG * srcAlphaW + dstG * dstContrib) * invOutAlpha + .5),
        outB = Math.floor((srcB * srcAlphaW + dstB * dstContrib) * invOutAlpha + .5);
      dstU32[dstRow + col] = outAlphaByte << 24 | outR << 16 | outG << 8 | outB
    }
  }
}

export function applyLayerMask(srcR, srcG, srcB, dstR, dstG, dstB, dstAlpha, maskDesc) {
  var srcLum = luminanceFromRgb(srcR, srcG, srcB),
    dstLum = luminanceFromRgb(dstR, dstG, dstB),
    min = Math.min,
    sample = sampleMask,
    srcWeight = sample(srcLum, maskDesc, 0);
  srcWeight = min(srcWeight, sample(srcR, maskDesc, 8));
  srcWeight = min(srcWeight, sample(srcG, maskDesc, 16));
  srcWeight = min(srcWeight, sample(srcB, maskDesc, 24));
  var dstWeight = sample(dstLum, maskDesc, 4);
  dstWeight = min(dstWeight, sample(dstR, maskDesc, 12));
  dstWeight = min(dstWeight, sample(dstG, maskDesc, 20));
  dstWeight = min(dstWeight, sample(dstB, maskDesc, 28));
  dstWeight = Math.max(dstWeight, 1 - dstAlpha);
  var weight = Math.min(srcWeight, dstWeight);
  return weight < 0 ? 0 : weight > 1 ? 1 : weight
}

export function sampleMask(lum, maskDesc, bandOff) {
  return Math.min((lum - maskDesc[bandOff]) * maskDesc[bandOff + 1], (lum - maskDesc[bandOff + 3]) * maskDesc[bandOff + 2])
}

export function compositeNonSeparable(sourceRgba, sourceRect, destRgba, destRect, clipRect, opacity, blendFn, styleParams) {
  var inv255 = 1 / 255,
    opacityNorm = inv255 * opacity,
    preserveDestAlpha = styleParams.preserveDestAlpha ? 1 : 0,
    fillOpacity = styleParams.fill,
    isStyleLayer = styleParams.style,
    intersectRect = sourceRect.intersect(destRect).intersect(clipRect),
    srcOffX = Math.max(0, intersectRect.x - sourceRect.x),
    dstOffX = Math.max(0, intersectRect.x - destRect.x),
    srcOffY = Math.max(0, intersectRect.y - sourceRect.y),
    dstOffY = Math.max(0, intersectRect.y - destRect.y),
    regionWidth = intersectRect.width,
    regionHeight = intersectRect.height,
    srcStride = sourceRect.width,
    dstStride = destRect.width,
    srcU32 = new Uint32Array(sourceRgba.buffer),
    dstU32 = new Uint32Array(destRgba.buffer);
  for (var rowIdx = 0; rowIdx < regionHeight; rowIdx++) {
    var srcRow = (srcOffY + rowIdx) * srcStride + srcOffX,
      dstRow = (dstOffY + rowIdx) * dstStride + dstOffX;
    for (var col = 0; col < regionWidth; col++, srcRow++, dstRow++) {
      var srcPx = srcU32[srcRow],
        dstAlphaNorm = 1;
      if (srcPx >>> 24 == 0) continue;
      var dstPx = dstU32[dstRow],
        srcB = (srcPx & 255) * inv255,
        srcG = (srcPx >>> 8 & 255) * inv255,
        srcR = (srcPx >>> 16 & 255) * inv255,
        dstB = (dstPx & 255) * inv255,
        dstG = (dstPx >>> 8 & 255) * inv255,
        dstR = (dstPx >>> 16 & 255) * inv255,
        srcAlphaEff = opacity;
      if (preserveDestAlpha == 0) {
        srcAlphaEff = (srcPx >>> 24) * opacityNorm;
        dstAlphaNorm = (dstPx >>> 24) * inv255
      }
      if (styleParams.blendIfTable) srcAlphaEff *= applyLayerMask(srcB, srcG, srcR, dstB, dstG, dstR, dstAlphaNorm, styleParams.blendIfTable);
      var dstContrib = dstAlphaNorm * (1 - srcAlphaEff),
        outAlphaNorm = srcAlphaEff + dstContrib,
        outScale = outAlphaNorm == 0 ? 0 : 255 / outAlphaNorm,
        styleAlpha = isStyleLayer ? 1 : srcAlphaEff,
        outB = ((1 - dstAlphaNorm) * srcAlphaEff * srcB + (1 - styleAlpha) * dstAlphaNorm * dstB + styleAlpha * dstAlphaNorm * blendFn(srcB, dstB, (1 + srcAlphaEff - styleAlpha) * fillOpacity)) * outScale,
        outG = ((1 - dstAlphaNorm) * srcAlphaEff * srcG + (1 - styleAlpha) * dstAlphaNorm * dstG + styleAlpha * dstAlphaNorm * blendFn(srcG, dstG, (1 + srcAlphaEff - styleAlpha) * fillOpacity)) * outScale,
        outR = ((1 - dstAlphaNorm) * srcAlphaEff * srcR + (1 - styleAlpha) * dstAlphaNorm * dstR + styleAlpha * dstAlphaNorm * blendFn(srcR, dstR, (1 + srcAlphaEff - styleAlpha) * fillOpacity)) * outScale;
      var finalAlpha = srcAlphaEff * fillOpacity + dstAlphaNorm * (1 - srcAlphaEff * fillOpacity),
        outAlphaByte = ~~(finalAlpha * 255 + .5);
      dstU32[dstRow] = preserveDestAlpha * (dstPx >>> 24) + (1 - preserveDestAlpha) * outAlphaByte << 24 | outR << 16 | outG << 8 | outB
    }
  }
}

export function compositeSeparable(sourceRgba, sourceRect, destRgba, destRect, clipRect, opacity, blendFn, styleParams) {
  var inv255 = 1 / 255,
    opacityNorm = inv255 * opacity,
    preserveDestAlpha = styleParams.preserveDestAlpha ? 1 : 0,
    intersectRect = sourceRect.intersect(destRect).intersect(clipRect),
    srcOffX = Math.max(0, intersectRect.x - sourceRect.x),
    dstOffX = Math.max(0, intersectRect.x - destRect.x),
    srcOffY = Math.max(0, intersectRect.y - sourceRect.y),
    dstOffY = Math.max(0, intersectRect.y - destRect.y),
    regionWidth = intersectRect.width,
    regionHeight = intersectRect.height,
    srcU32 = new Uint32Array(sourceRgba.buffer),
    dstU32 = new Uint32Array(destRgba.buffer),
    srcRgb = {
      h: 0,
      l: 0,
      O: 0
    },
    dstRgb = {
      h: 0,
      l: 0,
      O: 0
    },
    outRgb = {
      h: 0,
      l: 0,
      O: 0
    };
  for (var rowIdx = 0; rowIdx < regionHeight; rowIdx++) {
    var srcRow = (srcOffY + rowIdx) * sourceRect.width + srcOffX,
      dstRow = (dstOffY + rowIdx) * destRect.width + dstOffX;
    for (var col = 0; col < regionWidth; col++, srcRow++, dstRow++) {
      var srcPx = srcU32[srcRow],
        dstPx = dstU32[dstRow],
        srcB = (srcPx & 255) * inv255,
        srcG = (srcPx >>> 8 & 255) * inv255,
        srcR = (srcPx >>> 16 & 255) * inv255,
        dstB = (dstPx & 255) * inv255,
        dstG = (dstPx >>> 8 & 255) * inv255,
        dstR = (dstPx >>> 16 & 255) * inv255,
        srcAlphaEff = opacity,
        dstAlphaNorm = 1;
      if (preserveDestAlpha == 0) {
        srcAlphaEff = (srcPx >>> 24) * opacityNorm;
        dstAlphaNorm = (dstPx >>> 24) * inv255
      }
      if (styleParams.blendIfTable) srcAlphaEff *= applyLayerMask(srcB, srcG, srcR, dstB, dstG, dstR, dstAlphaNorm, styleParams.blendIfTable);
      var dstContrib = dstAlphaNorm * (1 - srcAlphaEff),
        outAlphaNorm = srcAlphaEff + dstContrib,
        outScale = 255 / outAlphaNorm;
      srcRgb.h = srcB;
      srcRgb.l = srcG;
      srcRgb.O = srcR;
      dstRgb.h = dstB;
      dstRgb.l = dstG;
      dstRgb.O = dstR;
      blendFn(srcRgb, dstRgb, outRgb);
      var outB = (((1 - dstAlphaNorm) * srcB + dstAlphaNorm * outRgb.h) * srcAlphaEff + dstB * dstContrib) * outScale,
        outG = (((1 - dstAlphaNorm) * srcG + dstAlphaNorm * outRgb.l) * srcAlphaEff + dstG * dstContrib) * outScale,
        outR = (((1 - dstAlphaNorm) * srcR + dstAlphaNorm * outRgb.O) * srcAlphaEff + dstR * dstContrib) * outScale,
        outAlphaByte = preserveDestAlpha * (dstPx >>> 24) + (1 - preserveDestAlpha) * Math.round(outAlphaNorm * 255);
      dstU32[dstRow] = outAlphaByte << 24 | outR << 16 | outG << 8 | outB
    }
  }
}

export function compositeDissolved(sourceRgba, sourceRect, destRgba, destRect, clipRect, opacity, blendFn, preserveDestAlpha) {
  var dissolveThreshold = Math.round(opacity * (256 * 256 * 256 / 255)),
    intersectRect = sourceRect.intersect(destRect).intersect(clipRect),
    srcOffX = Math.max(0, intersectRect.x - sourceRect.x),
    dstOffX = Math.max(0, intersectRect.x - destRect.x),
    srcOffY = Math.max(0, intersectRect.y - sourceRect.y),
    dstOffY = Math.max(0, intersectRect.y - destRect.y),
    regionWidth = intersectRect.width,
    regionHeight = intersectRect.height,
    srcU32 = new Uint32Array(sourceRgba.buffer),
    dstU32 = new Uint32Array(destRgba.buffer);
  for (var rowIdx = 0; rowIdx < regionHeight; rowIdx++) {
    var srcRow = (srcOffY + rowIdx) * sourceRect.width + srcOffX,
      dstRow = (dstOffY + rowIdx) * destRect.width + dstOffX;
    for (var col = 0; col < regionWidth; col++, srcRow++, dstRow++) {
      var srcPx = srcU32[srcRow],
        dstPx = dstU32[dstRow],
        effectiveSrcAlpha = preserveDestAlpha * 255 + (1 - preserveDestAlpha) * (srcPx >>> 24);
      if ((lcg32(srcRow) & 16777215) >= effectiveSrcAlpha * dissolveThreshold) continue;
      dstU32[dstRow] = srcPx & 16777215 | preserveDestAlpha * (dstPx >>> 24) + (1 - preserveDestAlpha) * 255 << 24
    }
  }
}

export function undoAlphaPremult(srcRgba, dstRgba, alphaChannel) {
  for (var px = 0; px < srcRgba.length; px += 4) {
    var alpha = alphaChannel[px >>> 2];
    if (alpha == 0) continue;
    var alphaNorm = alpha * (1 / 255),
      invAlpha = 1 / alphaNorm,
      dstR = dstRgba[px],
      dstG = dstRgba[px + 1],
      dstB = dstRgba[px + 2],
      srcR = srcRgba[px],
      srcG = srcRgba[px + 1],
      srcB = srcRgba[px + 2];
    dstRgba[px] = Math.min(255, Math.max(0, Math.round((dstR - (1 - alphaNorm) * srcR) * invAlpha)));
    dstRgba[px + 1] = Math.min(255, Math.max(0, Math.round((dstG - (1 - alphaNorm) * srcG) * invAlpha)));
    dstRgba[px + 2] = Math.min(255, Math.max(0, Math.round((dstB - (1 - alphaNorm) * srcB) * invAlpha)));
    dstRgba[px + 3] = 255
  }
}

export function compositeLayer(sourceRgba, sourceRect, destRgba, destRect, maskChannel, maskRect, maskChannelFill, clipRect, fillOpacity, dissolved, fillRgb) {
  if (dissolved == null) dissolved = false;
  if (fillRgb == null) fillRgb = [1, 1, 1];
  var destReplaceMask = 255 << 24 | fillRgb[2] * 16711680 | fillRgb[1] * 65280 | fillRgb[0] * 255,
    destKeepMask = ~destReplaceMask;
  if (maskChannel && !sourceRect.equals(maskRect)) {
    var expandedMask = allocBuffer(sourceRect.area() * 4);
    expandedMask.fill(maskChannelFill);
    copyChannel(maskChannel, maskRect, expandedMask, sourceRect);
    maskChannel = expandedMask;
    maskRect = sourceRect
  }
  if (dissolved) {
    if (maskChannel == null) compositeDissolvedDirect(sourceRgba, sourceRect, destRgba, destRect, clipRect, fillOpacity, destReplaceMask, destKeepMask);
    else compositeDissolvedClipped(sourceRgba, sourceRect, destRgba, destRect, maskChannel, clipRect, fillOpacity)
  } else {
    if (maskChannel == null) compositeNormalDirect(sourceRgba, sourceRect, destRgba, destRect, clipRect, fillOpacity, destReplaceMask, destKeepMask);
    else compositeNormalClipped(sourceRgba, sourceRect, destRgba, destRect, maskChannel, clipRect, fillOpacity)
  }
}

export function compositeNormalDirect(sourceRgba, sourceRect, destRgba, destRect, clipRect, fillOpacity, destReplaceMask, destKeepMask) {
  var inv255 = 1 / 255,
    region = intersectCompositeRegion(sourceRect, destRect, clipRect),
    srcOffX = region.srcOffX,
    dstOffX = region.dstOffX,
    srcOffY = region.srcOffY,
    dstOffY = region.dstOffY,
    regionWidth = region.regionWidth,
    regionHeight = region.regionHeight,
    srcU32 = new Uint32Array(sourceRgba.buffer),
    dstU32 = new Uint32Array(destRgba.buffer),
    fillAlphaByte = fillOpacity * 255 & 255;
  for (var row = 0; row < regionHeight; row++) {
    var srcRow = (srcOffY + row) * sourceRect.width + srcOffX,
      dstRow = (dstOffY + row) * destRect.width + dstOffX;
    for (var col = 0; col < regionWidth; col++, srcRow++, dstRow++) {
      var srcPx = srcU32[srcRow],
        dstPx = dstU32[dstRow],
        srcAlpha = srcPx >>> 24,
        dstAlpha = dstPx >>> 24,
        outAlpha = mulDiv255(fillAlphaByte * srcAlpha + (255 - fillAlphaByte) * dstAlpha),
        srcWeight = mulDiv255(srcAlpha * fillAlphaByte),
        dstWeight = mulDiv255(dstAlpha * (255 - fillAlphaByte)),
        srcB = srcPx & 255,
        srcG = srcPx >>> 8 & 255,
        srcR = srcPx >>> 16 & 255,
        dstB = dstPx & 255,
        dstG = dstPx >>> 8 & 255,
        dstR = dstPx >>> 16 & 255,
        outB = srcWeight * srcB + dstB * dstWeight,
        outG = srcWeight * srcG + dstG * dstWeight,
        outR = srcWeight * srcR + dstR * dstWeight;
      outB = divLut[outAlpha << 8 | mulDiv255(outB)];
      outG = divLut[outAlpha << 8 | mulDiv255(outG)];
      outR = divLut[outAlpha << 8 | mulDiv255(outR)];
      var packed = outAlpha << 24 | outR << 16 | outG << 8 | outB;
      dstU32[dstRow] = destKeepMask & dstPx | destReplaceMask & packed
    }
  }
}

export function compositeDissolvedDirect(sourceRgba, sourceRect, destRgba, destRect, clipRect, fillOpacity, destReplaceMask, destKeepMask) {
  var inv255 = 1 / 255,
    intersectRect = sourceRect.intersect(destRect).intersect(clipRect),
    srcOffX = Math.max(0, intersectRect.x - sourceRect.x),
    dstOffX = Math.max(0, intersectRect.x - destRect.x),
    srcOffY = Math.max(0, intersectRect.y - sourceRect.y),
    dstOffY = Math.max(0, intersectRect.y - destRect.y),
    regionWidth = intersectRect.width,
    regionHeight = intersectRect.height,
    srcU32 = new Uint32Array(sourceRgba.buffer),
    dstU32 = new Uint32Array(destRgba.buffer),
    dissolveThreshold = fillOpacity * 16777215 & 16777215;
  for (var row = 0; row < regionHeight; row++) {
    var srcRow = (srcOffY + row) * sourceRect.width + srcOffX,
      dstRow = (dstOffY + row) * destRect.width + dstOffX;
    for (var col = 0; col < regionWidth; col++, srcRow++, dstRow++) {
      if ((lcg32(srcRow) & 16777215) < dissolveThreshold) {
        dstU32[dstRow] = destKeepMask & dstU32[dstRow] | destReplaceMask & srcU32[srcRow]
      }
    }
  }
}

export function compositeNormalClipped(sourceRgba, sourceRect, destRgba, destRect, maskChannel, clipRect, opacity) {
  var intersectRect = sourceRect.intersect(destRect).intersect(clipRect),
    srcOffX = Math.max(0, intersectRect.x - sourceRect.x),
    dstOffX = Math.max(0, intersectRect.x - destRect.x),
    srcOffY = Math.max(0, intersectRect.y - sourceRect.y),
    dstOffY = Math.max(0, intersectRect.y - destRect.y),
    regionWidth = intersectRect.width,
    regionHeight = intersectRect.height,
    srcU32 = new Uint32Array(sourceRgba.buffer),
    dstU32 = new Uint32Array(destRgba.buffer);
  for (var rowIdx = 0; rowIdx < regionHeight; rowIdx++) {
    var srcRow = (srcOffY + rowIdx) * sourceRect.width + srcOffX,
      dstRow = (dstOffY + rowIdx) * destRect.width + dstOffX;
    for (var col = 0; col < regionWidth; col++, srcRow++, dstRow++) {
      var maskWeight = maskChannel[srcRow] * opacity & 255;
      if (maskWeight == 0) continue;
      if (maskWeight == 255) {
        dstU32[dstRow] = srcU32[srcRow];
        continue
      }
      var srcPx = srcU32[srcRow],
        dstPx = dstU32[dstRow],
        srcAlpha = srcPx >>> 24,
        dstAlpha = dstPx >>> 24,
        outAlpha = mulDiv255(maskWeight * srcAlpha + (255 - maskWeight) * dstAlpha),
        srcWeight = mulDiv255(srcAlpha * maskWeight),
        dstWeight = mulDiv255(dstAlpha * (255 - maskWeight)),
        srcB = srcPx & 255,
        srcG = srcPx >>> 8 & 255,
        srcR = srcPx >>> 16 & 255,
        dstB = dstPx & 255,
        dstG = dstPx >>> 8 & 255,
        dstR = dstPx >>> 16 & 255,
        outB = divLut[outAlpha << 8 | mulDiv255(srcWeight * srcB + dstB * dstWeight)],
        outG = divLut[outAlpha << 8 | mulDiv255(srcWeight * srcG + dstG * dstWeight)],
        outR = divLut[outAlpha << 8 | mulDiv255(srcWeight * srcR + dstR * dstWeight)];
      dstU32[dstRow] = outAlpha << 24 | outR << 16 | outG << 8 | outB
    }
  }
}

export function compositeDissolvedClipped(sourceRgba, sourceRect, destRgba, destRect, maskChannel, clipRect, opacity) {
  var intersectRect = sourceRect.intersect(destRect).intersect(clipRect),
    srcOffX = Math.max(0, intersectRect.x - sourceRect.x),
    dstOffX = Math.max(0, intersectRect.x - destRect.x),
    srcOffY = Math.max(0, intersectRect.y - sourceRect.y),
    dstOffY = Math.max(0, intersectRect.y - destRect.y),
    regionWidth = intersectRect.width,
    regionHeight = intersectRect.height,
    srcU32 = new Uint32Array(sourceRgba.buffer),
    dstU32 = new Uint32Array(destRgba.buffer),
    dissolveScale = Math.round(opacity * 257);
  for (var rowIdx = 0; rowIdx < regionHeight; rowIdx++) {
    var srcRow = (srcOffY + rowIdx) * sourceRect.width + srcOffX,
      dstRow = (dstOffY + rowIdx) * destRect.width + dstOffX;
    for (var col = 0; col < regionWidth; col++, srcRow++, dstRow++) {
      var maskThreshold = maskChannel[srcRow] * dissolveScale;
      if ((lcg32(srcRow) & 65535) < maskThreshold) dstU32[dstRow] = srcU32[srcRow]
    }
  }
}

export function compositeNormalDitheredClipped(sourceRgba, sourceRect, destRgba, destRect, maskChannel, clipRect, opacity) {
  var intersectRect = sourceRect.intersect(destRect).intersect(clipRect),
    srcOffX = Math.max(0, intersectRect.x - sourceRect.x),
    dstOffX = Math.max(0, intersectRect.x - destRect.x),
    srcOffY = Math.max(0, intersectRect.y - sourceRect.y),
    dstOffY = Math.max(0, intersectRect.y - destRect.y),
    regionWidth = intersectRect.width,
    regionHeight = intersectRect.height,
    srcU32 = new Uint32Array(sourceRgba.buffer),
    dstU32 = new Uint32Array(destRgba.buffer),
    ditherSeed = Math.floor(Math.random() * destRect.area());
  for (var rowIdx = 0; rowIdx < regionHeight; rowIdx++) {
    var srcRow = (srcOffY + rowIdx) * sourceRect.width + srcOffX,
      dstRow = (dstOffY + rowIdx) * destRect.width + dstOffX;
    for (var col = 0; col < regionWidth; col++) {
      var maskWeight = maskChannel[srcRow + col] * opacity;
      if (maskWeight == 0) continue;
      if (maskWeight == 255) {
        dstU32[dstRow + col] = srcU32[srcRow + col];
        continue
      }
      var srcPx = srcU32[srcRow + col],
        dstPx = dstU32[dstRow + col],
        srcAlpha = srcPx >>> 24,
        dstAlpha = dstPx >>> 24,
        srcWeight = srcAlpha * maskWeight * (1 / 255),
        dstWeight = dstAlpha * (255 - maskWeight) * (1 / 255),
        srcB = srcPx & 255,
        srcG = srcPx >>> 8 & 255,
        srcR = srcPx >>> 16 & 255,
        dstB = dstPx & 255,
        dstG = dstPx >>> 8 & 255,
        dstR = dstPx >>> 16 & 255,
        ditherRand = lcg32(dstRow + col + ditherSeed),
        outAlpha = Math.floor((srcWeight + dstWeight) * 256 + .5) + (ditherRand >>> 0 & 255) >>> 8,
        invWeight = outAlpha == 0 ? 0 : 256 / (srcWeight + dstWeight),
        outBRaw = srcB * srcWeight + dstB * dstWeight,
        outGRaw = srcG * srcWeight + dstG * dstWeight,
        outRRaw = srcR * srcWeight + dstR * dstWeight,
        outB = Math.floor(outBRaw * invWeight + .5) + (ditherRand >>> 8 & 255) >>> 8,
        outG = Math.floor(outGRaw * invWeight + .5) + (ditherRand >>> 16 & 255) >>> 8,
        outR = Math.floor(outRRaw * invWeight + .5) + (ditherRand >>> 21 & 248) >>> 8;
      dstU32[dstRow + col] = outAlpha << 24 | outR << 16 | outG << 8 | outB
    }
  }
}

export function ditheredRound(value) {
  return Math.floor(value + Math.random())
}

export function compositeDissolvedDitheredClipped(sourceRgba, sourceRect, destRgba, destRect, maskChannel, clipRect, opacity) {
  var inv255 = 1 / 255,
    intersectRect = sourceRect.intersect(destRect).intersect(clipRect),
    srcOffX = Math.max(0, intersectRect.x - sourceRect.x),
    dstOffX = Math.max(0, intersectRect.x - destRect.x),
    srcOffY = Math.max(0, intersectRect.y - sourceRect.y),
    dstOffY = Math.max(0, intersectRect.y - destRect.y),
    regionWidth = intersectRect.width,
    regionHeight = intersectRect.height;
  for (var rowIdx = 0; rowIdx < regionHeight; rowIdx++) {
    var srcIdx = (srcOffY + rowIdx) * sourceRect.width + srcOffX,
      dstIdx = (dstOffY + rowIdx) * destRect.width + dstOffX;
    for (var col = 0; col < regionWidth; col++, srcIdx++, dstIdx++) {
      var maskWeight = opacity * maskChannel[srcIdx] * inv255;
      if (maskWeight == 0) continue;
      if (maskWeight == 1) {
        destRgba[dstIdx] = sourceRgba[srcIdx];
        continue
      }
      destRgba[dstIdx] = sourceRgba[srcIdx] * maskWeight + destRgba[dstIdx] * (1 - maskWeight)
    }
  }
}
