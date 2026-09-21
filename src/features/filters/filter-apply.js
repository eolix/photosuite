/**
 * Smart-filter runtime: build filter FX descriptors, run gallery and adjustment
 * filters on pixels, and wire preview/commit paths for layer smart objects.
 */

import { Locale } from "../../core/i18n/locale.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { BinaryUtils } from "../../core/binary/binary-utils.js";

import { LayerSystem } from "../../engine/layer-system.js";
import { LENS_FLARE_PRESET_WIRE_KEYS } from "../../engine/compositing/effect-filters.js";
import { FileFormatRegistry } from "../../document/formats/registry/file-format-registry.js";
import { GalleryFilterDefs } from "./gallery/gallery-filter-defs.js";
import { AdjustmentEngine } from "../adjustments/adjustment-engine.js";
import { FilterDefs } from "./filter-registry.js";
import { CachedLayerData } from "./filter-data-cache.js";
import { applyCameraRawFilter } from "./camera-raw-apply.js";
import { normalizeCameraRawClassId } from "./camera-raw-descriptor.js";
import { makeElement } from "../../core/dom.js";
import { TransformToolBase } from "../../document/transform/transform-static.js";
import { transformPixels } from "../../document/render/raster-transform.js";
import { PlanarRgbaBuffer, allocBuffer, copyBuffer, downsampleHalfBox, equals, extractChannel, extractChannelByte, fillBuffer, grayChannelToRgba, interleavedToPlanar, planarToInterleaved, rgbaToGrayChannel } from "../../engine/compositing/buffer-utils.js";
import { copyPixels, premultiplyAlpha, resampleUint32UniformScale, unpremultiplyAlpha } from "../../engine/compositing/pixel-ops.js";
import { sampleBilinearPixel, samplePolarStrip, sampleRadialStrip, transposePixels } from "../../engine/compositing/homography.js";
import { solveLinearSystem } from "../../engine/compositing/matrix-math.js";
import { RngState, initRng } from "../../engine/compositing/compositing-ops.js";
import { invert } from "../../engine/compositing/color-math.js";
import { toRGBDesc } from "../../engine/compositing/psd-color-utils.js";
import { boxBlurRgba, boxBlurRgbaInPlace, gaussianBlurByte, gaussianBlurFloat, gaussianBlurRgbaInPlace } from "../../engine/compositing/blur.js";
import { buildToneCurveLut, transformCurvePoints } from "../../engine/compositing/tone-curves.js";
import { convolveRGBA, filterRGBA, findEdgesRGB, normalizeKernel, setPercentileFraction, presetKernels, selectMaximum, selectMinimum, selectPercentile, selectWeightedMean } from "../../engine/compositing/spatial-filters.js";
import { computeVertexUV, renderMesh } from "../../engine/compositing/path-renderer.js";
import { quantize, quantizeWithBorder } from "../../engine/compositing/quantizer.js";
import { filter } from "../../engine/compositing/diffuse.js";
import { applyCloudsNoise, applyDespeckle, applyDiffuseNoise, applyFragmentBoxDownsample, applySharpenEdges, applyWindBlend } from "../../engine/compositing/filter-kernels.js";
import {
  applyLensCorrectionColorEffects,
  fillLensCorrectionWarpMap,
  fillUncoveredEdges,
  resolveLensCorrectionEdgeMode,
} from "./lens-correction-apply.js";
import { applyWarp } from "../../engine/compositing/warp.js";
import { applyShadowHighlightCorrection, renderLensFlare } from "../../engine/compositing/effect-filters.js";

function planarRgbFromPackedInt(packedRgb) {
  return {
    h: packedRgb >> 16,
    l: packedRgb >> 8 & 255,
    O: packedRgb & 255
  };
}

function ensureFilterDestination(sourcePixels, destPixels) {
  if (destPixels == null) destPixels = {
    buffer: allocBuffer(sourcePixels.buffer.length),
    rect: sourcePixels.rect.clone()
  };
  copyBuffer(sourcePixels.buffer, destPixels.buffer);
  return destPixels;
}

function mergeFilterDescriptorDefaults(filterType, filterDescriptor) {
  const defaultFilterDescriptor = FilterDefs.create(filterType);
  if (filterDescriptor == null) return defaultFilterDescriptor;
  if (defaultFilterDescriptor)
    for (let defaultKey in defaultFilterDescriptor)
      if (filterDescriptor[defaultKey] == null) filterDescriptor[defaultKey] = defaultFilterDescriptor[defaultKey];
  return filterDescriptor;
}

FilterDefs.createFilterFxDescriptor = function(filterType, colorEnv) {
  const fgPlanar = planarRgbFromPackedInt(colorEnv.colorInt);
  const bgPlanar = planarRgbFromPackedInt(colorEnv.bgColor);
  let displayNameKey = FilterDefs.names[filterType];
  if (displayNameKey == null) displayNameKey = AdjustmentEngine.names[filterType];
  let descriptorKey = filterType;
  for (let adjKey in AdjustmentEngine.descriptorKeyMap)
    if (AdjustmentEngine.descriptorKeyMap[adjKey] == filterType) descriptorKey = adjKey;

  const filterFxDesc = {
      t: "Objc",
      v: {
        classID: "filterFX",
        Nm: {
          t: "TEXT",
          v: Locale.get(displayNameKey)
        },
        blendOptions: {
          t: "Objc",
          v: {
            classID: "blendOptions",
            Opct: {
              t: "UntF",
              v: {
                type: "#Prc",
                val: 100
              }
            },
            Md: {
              t: "enum",
              v: {
                blendMode: "Nrml"
              }
            }
          }
        },
        enab: {
          t: "bool",
          v: true
        },
        hasoptions: {
          t: "bool",
          v: true
        },
        FrgC: {
          t: "Objc",
          v: toRGBDesc(fgPlanar)
        },
        BckC: {
          t: "Objc",
          v: toRGBDesc(bgPlanar)
        },
        filterID: {
          t: "long",
          v: descriptorKey.length == 4 ? BinaryUtils.fourCCToUint32(descriptorKey) : 777
        }
      }
    };

  const defaultDescriptor = FilterDefs.create(filterType);
  if (defaultDescriptor) filterFxDesc.v.Fltr = {
    t: "Objc",
    v: defaultDescriptor
  };
  return filterFxDesc
};
FilterDefs.applyMorphologicalGradientFill = function(sourceRgba, destRgba, width, height, radius, selectorFn, selectorParams, unusedSelectorSlot) {
  filterRGBA(sourceRgba, destRgba, width, height, radius, selectorFn, selectorParams)
};
FilterDefs.applyPremultipliedBlur = function(blurFactor, blurFn, rgbaBuffer, rect) {
  premultiplyAlpha(rgbaBuffer);
  if (blurFactor < 1) {
    const kernelIdx = Math.round(blurFactor * 5);
    let kernel = [1, 2, 1, 2, [40, 26, 13, 6, 4, 2][kernelIdx], 2, 1, 2, 1];
    kernel = normalizeKernel(kernel);
    let scratch = rgbaBuffer.slice(0);
    convolveRGBA(scratch, rgbaBuffer, rect.width, rect.height, kernel, 255)
  } else blurFn(rgbaBuffer, rect, blurFactor);
  unpremultiplyAlpha(rgbaBuffer)
};
FilterDefs.sharedRgbaScratchBuffer = new ArrayBuffer(512);
FilterDefs.copyRgbaToSharedBuffer = function(sourceRgba) {
  let scratch = FilterDefs.sharedRgbaScratchBuffer;
  const byteLength = sourceRgba.length;
  if (scratch.byteLength < byteLength) FilterDefs.sharedRgbaScratchBuffer = scratch = new ArrayBuffer(byteLength);
  const scratchBytes = new Uint8Array(scratch);
  for (let i = 0; i < byteLength; i += 4) {
    scratchBytes[i] = sourceRgba[i];
    scratchBytes[i + 1] = sourceRgba[i + 1];
    scratchBytes[i + 2] = sourceRgba[i + 2];
    scratchBytes[i + 3] = sourceRgba[i + 3]
  }
  return scratch
};

// Private per-filter pixel applicators.

function applyGalleryEffectsFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  let enabledEffectList = [];
  if (filterDescriptor.GEfs) {
    const effectStyleList = filterDescriptor.GEfs.v;
    for (let effectIdx = 0; effectIdx < effectStyleList.length; effectIdx++) {
      const effectEntry = effectStyleList[effectIdx].v;
      if (effectEntry.GELv && effectEntry.GELv.v == false) continue;
      enabledEffectList.push(effectEntry)
    }
  } else enabledEffectList = [filterDescriptor];
  for (let effectIdx = 0; effectIdx < enabledEffectList.length; effectIdx++) {
    let scratchPixels;
    if (effectIdx == 0) GalleryFilterDefs.applyGalleryFilterToPixels(filterType, sourcePixels, enabledEffectList[effectIdx], fgRgb, bgRgb, destPixels, filterContext);
    else {
      if (scratchPixels == null) scratchPixels = {
        buffer: allocBuffer(sourcePixels.buffer.length),
        rect: sourcePixels.rect.clone()
      };
      copyBuffer(destPixels.buffer, scratchPixels.buffer);
      GalleryFilterDefs.applyGalleryFilterToPixels(filterType, scratchPixels, enabledEffectList[effectIdx], fgRgb, bgRgb, destPixels, filterContext)
    }
  }

}

function applyAdaptCorrectFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const sourceRect = sourcePixels.rect;
  let pixelWidth = sourceRect.width;
  let pixelHeight = sourceRect.height;
  const shadowDesc = filterDescriptor.sdwM.v;
  const shadowAmount = shadowDesc.Amnt.v.val / 100;
  const shadowWidth = shadowDesc.Wdth.v.val / 100;
  const shadowRadius = shadowDesc.Rds.v;
  const highlightDesc = filterDescriptor.hglM.v;
  const highlightAmount = highlightDesc.Amnt.v.val / 100;
  const highlightWidth = highlightDesc.Wdth.v.val / 100;
  const highlightRadius = highlightDesc.Rds.v;
  applyShadowHighlightCorrection(sourcePixels.buffer, destPixels.buffer, pixelWidth, pixelHeight, shadowAmount, shadowWidth, shadowRadius, highlightAmount, highlightWidth, highlightRadius, filterDescriptor.ClrC.v / 100, filterDescriptor.Cntr.v / 100)
}

function applyFibersFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const sourceRect = sourcePixels.rect;
  let pixelWidth = sourceRect.width;
  let pixelHeight = sourceRect.height;
  const fiberDensityMap = allocBuffer(pixelWidth * pixelHeight);
  const fiberStepSize = 1;
  for (let stripIdx = 0; stripIdx < pixelWidth * 100; stripIdx++) {
    let fiberX = Math.random() * pixelWidth;
    for (let row = 0; row < pixelHeight; row++) {
      const binIndex = ~~(fiberX + 4096) & 511;
      fiberDensityMap[row * pixelWidth + binIndex] = Math.min(255, fiberDensityMap[row * pixelWidth + binIndex] + 1);
      const randomOffset = Math.random();
      fiberX = fiberX - fiberStepSize + randomOffset * 2 * fiberStepSize
    }
  }
  invert(fiberDensityMap);
  destPixels.buffer.fill(255);
  grayChannelToRgba(fiberDensityMap, destPixels.buffer)
}

function applyFragmentFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const sourceRect = sourcePixels.rect;
  let pixelWidth = sourceRect.width;
  let pixelHeight = sourceRect.height;
  const premulScratch = sourcePixels.buffer.slice(0);
  premultiplyAlpha(premulScratch);
  applyFragmentBoxDownsample(premulScratch, pixelWidth, pixelHeight, destPixels.buffer);
  unpremultiplyAlpha(destPixels.buffer)
}

/**
 * Diffuse modes in descriptor order. The first three are neighbour blends handled
 * by the diffuse kernel; anisotropic is a separate edge-preserving diffusion.
 * The panel's dropdown is built from the same order, so the two must agree.
 */
export const DIFFUSE_MODES = ["Nrml", "DrkO", "LghO", "anisotropic"];

/** Index of the mode served by the anisotropic diffusion kernel. */
export const DIFFUSE_MODE_ANISOTROPIC = 3;

function applyDiffuseFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const sourceRect = sourcePixels.rect;
  let pixelWidth = sourceRect.width;
  let pixelHeight = sourceRect.height;
  // A descriptor from another editor can name a mode this build does not know;
  // treat that as Normal rather than returning an unfiltered buffer.
  let diffuseModeIndex = DIFFUSE_MODES.indexOf(filterDescriptor.Md.v.DfsM);
  if (diffuseModeIndex === -1) diffuseModeIndex = 0;
  if (diffuseModeIndex < DIFFUSE_MODE_ANISOTROPIC) applyDiffuseNoise(sourcePixels.buffer, pixelWidth, pixelHeight, destPixels.buffer, [diffuseModeIndex]);
  else {
    const diffuseFilterParams = [1.4, 1.6, 1, 4, false, 2, [0, 0, .001]];
    const contentRect = sourcePixels.rect.clone();
    contentRect.x = contentRect.y = 0;
    filter(sourcePixels.buffer, contentRect, destPixels.buffer, diffuseFilterParams)
  }
}

function applyTraceContourFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const sourceRect = sourcePixels.rect;
  let pixelWidth = sourceRect.width;
  const rowByteStride = pixelWidth << 2;
  let pixelHeight = sourceRect.height;
  const contourLevel = filterDescriptor.Lvl.v;
  const useLowerEdge = filterDescriptor.Edg.v.CntE == "Lwr";
  const srcBuffer = sourcePixels.buffer;
  const destBuffer = destPixels.buffer;
  fillBuffer(destBuffer, 16777215, 4278190080);

  function markUpperNeighbors(pixelOffsetA, pixelOffsetB) {
    clearUpperCrossing(pixelOffsetA, pixelOffsetB);
    clearUpperCrossing(pixelOffsetA + 1, pixelOffsetB + 1);
    clearUpperCrossing(pixelOffsetA + 2, pixelOffsetB + 2)
  }

  function markLowerNeighbors(pixelOffsetA, pixelOffsetB) {
    clearLowerCrossing(pixelOffsetA, pixelOffsetB);
    clearLowerCrossing(pixelOffsetA + 1, pixelOffsetB + 1);
    clearLowerCrossing(pixelOffsetA + 2, pixelOffsetB + 2)
  }

  function clearUpperCrossing(pixelOffsetA, pixelOffsetB) {
    const sampleA = srcBuffer[pixelOffsetA];
    const sampleB = srcBuffer[pixelOffsetB];
    if (sampleA >= contourLevel && sampleB < contourLevel) destBuffer[pixelOffsetA] = 0;
    if (sampleA < contourLevel && sampleB >= contourLevel) destBuffer[pixelOffsetB] = 0
  }

  function clearLowerCrossing(pixelOffsetA, pixelOffsetB) {
    const sampleA = srcBuffer[pixelOffsetA];
    const sampleB = srcBuffer[pixelOffsetB];
    if (sampleA > contourLevel && sampleB <= contourLevel) destBuffer[pixelOffsetB] = 0;
    if (sampleA <= contourLevel && sampleB > contourLevel) destBuffer[pixelOffsetA] = 0
  }
  if (useLowerEdge)
    for (let row = 1; row < pixelHeight; row++)
      for (let col = 1; col < pixelWidth; col++) {
        let rgbaOffset = row * pixelWidth + col << 2;
        markUpperNeighbors(rgbaOffset, rgbaOffset - 4);
        markUpperNeighbors(rgbaOffset, rgbaOffset - rowByteStride)
      } else
        for (let row = 1; row < pixelHeight; row++)
          for (let col = 1; col < pixelWidth; col++) {
            let rgbaOffset = row * pixelWidth + col << 2;
            markLowerNeighbors(rgbaOffset, rgbaOffset - 4);
            markLowerNeighbors(rgbaOffset, rgbaOffset - rowByteStride)
          }
}

function applyEmbossFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const sourceRect = sourcePixels.rect;
  let pixelWidth = sourceRect.width;
  let pixelHeight = sourceRect.height;
  const embossAngleRad = -filterDescriptor.Angl.v * Math.PI / 180;
  let embossHeight = filterDescriptor.Hght.v;
  const embossAmount = filterDescriptor.Amnt.v / 100;
  embossHeight /= 2;
  let offsetX = Math.cos(embossAngleRad) * embossHeight;
  let offsetY = Math.sin(embossAngleRad) * embossHeight;
  const srcBuffer = sourcePixels.buffer;
  const destBuffer = destPixels.buffer;
  destBuffer.fill(0);
  const srcUint32View = new Uint32Array(srcBuffer.buffer);
  const sampleBytes = new Uint8Array(4);
  const sampleUint32View = new Uint32Array(sampleBytes.buffer);
  for (let row = 0; row < pixelHeight; row++)
    for (let col = 0; col < pixelWidth; col++) {
      let embossR = 0;
      let embossG = 0;
      let embossB = 0;
      if (0 <= col + offsetX && col + offsetX < pixelWidth && 0 <= row + offsetY && row + offsetY < pixelHeight) {
        sampleBilinearPixel(col + offsetX + .5, row + offsetY + .5, srcUint32View, pixelWidth, pixelHeight, sampleUint32View, 0, 0);
        embossR += sampleBytes[0] - 128;
        embossG += sampleBytes[1] - 128;
        embossB += sampleBytes[2] - 128
      }
      if (0 <= col - offsetX && col - offsetX < pixelWidth && 0 <= row - offsetY && row - offsetY < pixelHeight) {
        sampleBilinearPixel(col - offsetX + .5, row - offsetY + .5, srcUint32View, pixelWidth, pixelHeight, sampleUint32View, 0, 0);
        embossR -= sampleBytes[0] - 128;
        embossG -= sampleBytes[1] - 128;
        embossB -= sampleBytes[2] - 128
      }
      let rgbaOffset = row * pixelWidth + col << 2;
      destBuffer[rgbaOffset] = Math.max(0, Math.min(255, embossR * embossAmount + 128));
      destBuffer[rgbaOffset + 1] = Math.max(0, Math.min(255, embossG * embossAmount + 128));
      destBuffer[rgbaOffset + 2] = Math.max(0, Math.min(255, embossB * embossAmount + 128));
      destBuffer[rgbaOffset + 3] = srcBuffer[rgbaOffset + 3]
    }
}

function applyShearEntryFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const sourceRect = sourcePixels.rect;
  let pixelWidth = sourceRect.width;
  let pixelHeight = sourceRect.height;
  applySharpenEdges(sourcePixels.buffer, pixelWidth, pixelHeight, destPixels.buffer)
}

function applyDisplaceEntryFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const sourceRect = sourcePixels.rect;
  let pixelWidth = sourceRect.width;
  let pixelHeight = sourceRect.height;
  applyDespeckle(sourcePixels.buffer, pixelWidth, pixelHeight, destPixels.buffer)
}

function applySolarizeFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const destBuffer = destPixels.buffer;
  const solarizeThreshold = 128;
  for (let rgbaOffset = 0; rgbaOffset < destBuffer.length; rgbaOffset += 4) {
    if (destBuffer[rgbaOffset] > solarizeThreshold) destBuffer[rgbaOffset] = 255 - destBuffer[rgbaOffset];
    if (destBuffer[rgbaOffset + 1] > solarizeThreshold) destBuffer[rgbaOffset + 1] = 255 - destBuffer[rgbaOffset + 1];
    if (destBuffer[rgbaOffset + 2] > solarizeThreshold) destBuffer[rgbaOffset + 2] = 255 - destBuffer[rgbaOffset + 2]
  }
}

function applyWindFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const sourceRect = sourcePixels.rect;
  let pixelWidth = sourceRect.width;
  let pixelHeight = sourceRect.height;
  const windModeNames = ["Wnd", "Blst", "Stgr"];
  const windModeKey = filterDescriptor.WndM.v.WndM;
  applyWindBlend(sourcePixels.buffer, pixelWidth, pixelHeight, destPixels.buffer, [windModeNames.indexOf(windModeKey), filterDescriptor.Drct.v.Drct != "Left"])
}

function applyBokehFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const sourceRect = sourcePixels.rect;
  let pixelWidth = sourceRect.width;
  let pixelHeight = sourceRect.height;
  const pixelCount = pixelWidth * pixelHeight;
  const byteLength = pixelCount * 4;
  let workingBuffer = sourcePixels.buffer.slice(0);
  const depthSourceMode = filterDescriptor && filterDescriptor.BkDi && filterDescriptor.BkDi.v ? filterDescriptor.BkDi.v.BtDi : "BeIn";
  const depthSourceChannelDesc = filterDescriptor ? filterDescriptor.BkDc : null;
  let targetDepth = (filterDescriptor && filterDescriptor.BkDp ? filterDescriptor.BkDp.v : 0) / 255;
  if (depthSourceMode == "BeIn") targetDepth = 0;
  const bokehRadius = 57 * (.3 + .7 * ((pixelWidth + pixelHeight) / 2) / 1750) * (((filterDescriptor && filterDescriptor.BkIb ? filterDescriptor.BkIb.v : 30) / 100)) * (1 + .2 * Math.pow(targetDepth, .1));
  const bladeCount = parseInt(((filterDescriptor && filterDescriptor.BkIs && filterDescriptor.BkIs.v ? filterDescriptor.BkIs.v.BtIs : "BeS6") + "").slice(3));
  const bladeRotationRad = -(filterDescriptor && filterDescriptor.BkIr ? filterDescriptor.BkIr.v : 0) * Math.PI / 180;
  const clipPolyPlaneCoeffs = [];
  for (let bladeIdx = 0; bladeIdx < 8; bladeIdx++) {
    const bladeAngleStart = bladeRotationRad + bladeIdx * (Math.PI * 2 / bladeCount);
    const bladeAngleEnd = bladeRotationRad + (bladeIdx + 1) * (Math.PI * 2 / bladeCount);
    const cosStart = Math.cos(bladeAngleStart);
    const sinStart = Math.sin(bladeAngleStart);
    const cosEnd = Math.cos(bladeAngleEnd);
    const sinEnd = Math.sin(bladeAngleEnd);
    const planeCoeffs = [0, 0, 0];
    solveLinearSystem([
      [cosStart, sinStart, 1, 0],
      [cosEnd, sinEnd, 1, 0],
      [1, 1, 1, 1]
    ], planeCoeffs);
    if (planeCoeffs[2] > 0) {
      planeCoeffs[0] *= -1;
      planeCoeffs[1] *= -1;
      planeCoeffs[2] *= -1
    }
    clipPolyPlaneCoeffs.push(planeCoeffs[0], planeCoeffs[1], planeCoeffs[2], 0)
  }
  if (depthSourceMode == "BeIn") {
    fillBuffer(workingBuffer, 0, 16777215);
    targetDepth = 1
  } else if (depthSourceMode == "BeIt" && depthSourceChannelDesc.v.BtDc == "BeCt") {} else {
    let depthChannelSource;
    if (depthSourceMode == "BeIt" && depthSourceChannelDesc.v.BtDc == "BeCm") depthChannelSource = filterContext[1];
    else if (depthSourceMode == "BeIa") depthChannelSource = filterContext[2][depthSourceChannelDesc.v];
    if (depthChannelSource == null) {
      fillBuffer(workingBuffer, 0, 16777215)
    } else {
      let depthChannelData;
      if (depthChannelSource.rect.equals(sourceRect)) depthChannelData = depthChannelSource.channel;
      else depthChannelData = depthChannelSource.rasterizeTo(sourceRect);
      extractChannel(depthChannelData, workingBuffer, 3)
    }
  }
  if (LayerSystem.webglEnabled) {
    const depthBuffer = workingBuffer;
    let workingWidth = pixelWidth;
    let workingHeight = pixelHeight;
    let downsampleScale = 1;
    const useInfiniteDepthShortcut = (((filterDescriptor && filterDescriptor.BkSb ? filterDescriptor.BkSb.v : 0) == 0) || ((filterDescriptor && filterDescriptor.BkSt ? filterDescriptor.BkSt.v : 255) == 255)) && depthSourceMode == "BeIn";
    if (!useInfiniteDepthShortcut) {
      let meanDepthDelta = 0;
      for (let byteOffset = 0; byteOffset < byteLength; byteOffset += 4) meanDepthDelta += Math.abs(targetDepth - workingBuffer[byteOffset + 3] * (1 / 255));
      meanDepthDelta = meanDepthDelta / pixelCount * bokehRadius;
      const estimatedSampleCount = 3.14 * meanDepthDelta * meanDepthDelta * pixelWidth * pixelHeight / 3e6;
      if (estimatedSampleCount > 2e3) return;
    }
    while (useInfiniteDepthShortcut && 3 * (bokehRadius / downsampleScale) * (bokehRadius / downsampleScale) * pixelWidth * pixelHeight > 500 * 2e3 * 2e3) {
      const downsampled = downsampleHalfBox(workingBuffer, new Rect(0, 0, workingWidth, workingHeight));
      workingBuffer = downsampled.buffer;
      workingWidth = downsampled.rect.width;
      workingHeight = downsampled.rect.height;
      downsampleScale *= 2
    }
    const depthTexture = LayerSystem.getPooledTexture(0, workingWidth, workingHeight);
    depthTexture.set(workingBuffer);
    const outputTexture = LayerSystem.getPooledTexture(1, pixelWidth, pixelHeight);
    LayerSystem.bindRenderTarget(outputTexture);
    LayerSystem.filter.render({
      type: LayerSystem.filter.DEPTH_BEVEL,
      invTexelSize: new Float32Array([1 / workingWidth, 1 / workingHeight]),
      targetDepth: targetDepth,
      bevelRadius: bokehRadius / downsampleScale,
      specularThresholds: new Float32Array([(filterDescriptor && filterDescriptor.BkSb ? filterDescriptor.BkSb.v : 0) / 100, (filterDescriptor && filterDescriptor.BkSt ? filterDescriptor.BkSt.v : 255) / 255]),
      noiseSettings: new Float32Array([(filterDescriptor && filterDescriptor.BkNa ? filterDescriptor.BkNa.v : 0) / 100, (filterDescriptor && filterDescriptor.BkNt && filterDescriptor.BkNt.v && filterDescriptor.BkNt.v.BtNt) == "BeNu" ? 0 : 1, (filterDescriptor && filterDescriptor.BkNm ? (filterDescriptor.BkNm.v ? 1 : 0) : 0)]),
      clipPolyMatrix0: new Float32Array(clipPolyPlaneCoeffs.slice(0, 16)),
      clipPolyMatrix1: new Float32Array(clipPolyPlaneCoeffs.slice(16))
    }, depthTexture.glTexture);
    outputTexture.get(destPixels.buffer);
    const destRgba = destPixels.buffer;
    for (let byteOffset = 0; byteOffset < byteLength; byteOffset += 4) destRgba[byteOffset + 3] = sourcePixels.buffer[byteOffset + 3]
  }
}

function applyRigidTransformFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const copyToSharedBuffer = FilterDefs.copyRgbaToSharedBuffer;
  const premulSourceRgba = sourcePixels.buffer.slice(0);
  let vertPairOffset = 0;
  let triIndexOffset = 0;
  premultiplyAlpha(premulSourceRgba);
  fillBuffer(destPixels.buffer, 0);
  let pixelWidth = sourcePixels.rect.width;
  let pixelHeight = sourcePixels.rect.height;
  const puppetShapes = filterDescriptor.puppetShapeList.v;
  const origVertPairs = [];
  const deformedVertPairs = [];
  const triangleIndices = [];
  const vertexUvCoords = [];
  for (let shapeIdx = 0; shapeIdx < puppetShapes.length; shapeIdx++) {
    const shapeDesc = puppetShapes[shapeIdx].v;
    const vertWriteOffset = vertPairOffset * 2;
    const indexWriteOffset = triIndexOffset * 3;
    const vertPairCount = shapeDesc.originalVertexArray.v.length >>> 2;
    const indexCount = shapeDesc.indexArray.v.length >>> 2;
    const origVertsFloat = new Float32Array(copyToSharedBuffer(shapeDesc.originalVertexArray.v));
    for (let vertIdx = 0; vertIdx < vertPairCount; vertIdx++) origVertPairs[vertWriteOffset + vertIdx] = origVertsFloat[vertIdx];
    const deformedVertsFloat = new Float32Array(copyToSharedBuffer(shapeDesc.deformedVertexArray.v));
    for (let vertIdx = 0; vertIdx < vertPairCount; vertIdx++) deformedVertPairs[vertWriteOffset + vertIdx] = deformedVertsFloat[vertIdx];
    const indexArrayUint = new Uint32Array(copyToSharedBuffer(shapeDesc.indexArray.v));
    for (let triIdx = 0; triIdx < indexCount; triIdx++) triangleIndices[indexWriteOffset + triIdx] = vertPairOffset + indexArrayUint[triIdx];
    const pinVertIndices = [];
    const pinDepths = [];
    const pinDepthList = shapeDesc.PnDp.v;
    for (let pinIdx = 0; pinIdx < pinDepthList.length; pinIdx++) {
      pinVertIndices.push(shapeDesc.pinVertexIndices.v[pinIdx].v);
      pinDepths.push(pinDepthList[pinIdx].v)
    }
    const vertexUvs = computeVertexUV(origVertsFloat, indexArrayUint, pinVertIndices, pinDepths);
    for (let uvIdx = 0; uvIdx < vertexUvs.length; uvIdx++) vertexUvCoords[vertPairOffset + uvIdx] = vertexUvs[uvIdx];
    vertPairOffset += vertPairCount >>> 1;
    triIndexOffset += ~~(indexCount / 3)
  }
  const sourceRect = sourcePixels.rect;
  pixelWidth = sourceRect.width;
  pixelHeight = sourceRect.height;
  renderMesh(premulSourceRgba, pixelWidth, pixelHeight, destPixels.buffer, pixelWidth, pixelHeight, origVertPairs, deformedVertPairs, vertexUvCoords, triangleIndices);
  unpremultiplyAlpha(destPixels.buffer)
}

function applyLightFilterGradient(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  function normalizeVec3(vec) {
    const invLen = 1 / Math.sqrt(vec[0] * vec[0] + vec[1] * vec[1] + vec[2] * vec[2]);
    vec[0] *= invLen;
    vec[1] *= invLen;
    vec[2] *= invLen
  }
  let pixelWidth = sourcePixels.rect.width;
  let pixelHeight = sourcePixels.rect.height;
  const pixelCount = pixelWidth * pixelHeight;
  const grayChannel = allocBuffer(pixelCount);
  const sobelForwardWeight = .3;
  const sobelBackwardWeight = .7;
  rgbaToGrayChannel(destPixels.buffer, grayChannel);
  const blurLargeGray = allocBuffer(pixelCount);
  gaussianBlurByte(grayChannel, blurLargeGray, destPixels.rect, 16);
  const blurSmallGray = allocBuffer(pixelCount);
  gaussianBlurByte(grayChannel, blurSmallGray, destPixels.rect, 8);
  const detailGray = grayChannel;
  const normalHeightField = new Float32Array(pixelCount);
  const detailCoeffs = filterDescriptor.Dtl.v;
  let coeffLarge = detailCoeffs[2].v;
  let coeffMedium = detailCoeffs[1].v;
  let coeffFine = detailCoeffs[0].v;
  const detailScale = filterDescriptor.Scl.v * 40 * filterDescriptor.textureScale.v / (coeffLarge + coeffMedium + coeffFine);
  coeffLarge *= detailScale;
  coeffMedium *= detailScale;
  coeffFine *= detailScale;
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    const largeBlurNorm = blurLargeGray[pixelIdx] * (1 / 255);
    const smallBlurNorm = blurSmallGray[pixelIdx] * (1 / 255);
    let detailNorm = detailGray[pixelIdx] * (1 / 255);
    detailNorm = detailNorm * detailNorm;
    normalHeightField[pixelIdx] = coeffLarge * largeBlurNorm + coeffMedium * smallBlurNorm + coeffFine * detailNorm
  }
  const normalBlurRadius = filterDescriptor.blur.v;
  if (normalBlurRadius != 0) {
    const blurScratch = normalHeightField.slice(0);
    gaussianBlurFloat(blurScratch, normalHeightField, destPixels.rect, normalBlurRadius)
  }
  const lastCol = pixelWidth - 1;
  const lastRow = pixelHeight - 1;
  for (let row = 1; row < lastRow; row++)
    for (let col = 1; col < lastCol; col++) {
      let pixelIdx = row * pixelWidth + col;
      let rgbaOffset = pixelIdx * 4;
      const heightSample = normalHeightField[pixelIdx];
      const gradX = sobelForwardWeight * (normalHeightField[pixelIdx + 1] - heightSample) + sobelBackwardWeight * (heightSample - normalHeightField[pixelIdx - 1]);
      const gradY = sobelForwardWeight * (normalHeightField[pixelIdx + pixelWidth] - heightSample) + sobelBackwardWeight * (heightSample - normalHeightField[pixelIdx - pixelWidth]);
      const tangentVec = [1, 0, gradX];
      const bitangentVec = [0, 1, gradY];
      normalizeVec3(tangentVec);
      normalizeVec3(bitangentVec);
      const tanX = tangentVec[0];
      const tanZ = tangentVec[2];
      const bitangentY = bitangentVec[1];
      const bitangentZ = bitangentVec[2];
      const normalR = -tanZ * bitangentY;
      const normalG = -tanX * bitangentZ;
      const normalB = tanX * bitangentY;
      destPixels.buffer[rgbaOffset] = ~~(127.5 + normalR * 127.5);
      destPixels.buffer[rgbaOffset + 1] = ~~(127.5 + normalG * 127.5);
      destPixels.buffer[rgbaOffset + 2] = ~~(127.5 + normalB * 127.5)
    }
}

function applyAverageFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  let blueSum = 0;
  let greenSum = 0;
  let redSum = 0;
  let alphaWeightSum = 0;
  const preserveBias = 1;
  for (let rgbaOffset = 0; rgbaOffset < sourcePixels.buffer.length; rgbaOffset += 4) {
    const alpha = sourcePixels.buffer[rgbaOffset + 3];
    redSum += sourcePixels.buffer[rgbaOffset] * alpha;
    greenSum += sourcePixels.buffer[rgbaOffset + 1] * alpha;
    blueSum += sourcePixels.buffer[rgbaOffset + 2] * alpha;
    alphaWeightSum += alpha
  }
  const invAlphaWeight = 1 / alphaWeightSum;
  blueSum = Math.round(preserveBias * (blueSum * invAlphaWeight) + (1 - preserveBias) * 255);
  greenSum = Math.round(preserveBias * (greenSum * invAlphaWeight) + (1 - preserveBias) * 255);
  redSum = Math.round(preserveBias * (redSum * invAlphaWeight) + (1 - preserveBias) * 255);
  fillBuffer(destPixels.buffer, blueSum << 16 | greenSum << 8 | redSum, 4278190080)
}

function applyBlurSharpenFamily(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const blurRadius = filterDescriptor.Rds.v.val;
  const blurInPlaceFn = filterType == "boxblur" ? boxBlurRgbaInPlace : gaussianBlurRgbaInPlace;
  FilterDefs.applyPremultipliedBlur(blurRadius, blurInPlaceFn, destPixels.buffer, destPixels.rect);
  if (filterType == "UnsM" || filterType == "smartSharpen") {
    let sharpenAmount = filterDescriptor.Amnt.v.val / 100;
    let sharpenThreshold = 0;
    if (filterType == "UnsM") sharpenThreshold = filterDescriptor.Thsh.v;
    else sharpenAmount *= .75;
    for (let channelIdx = 0; channelIdx < sourcePixels.buffer.length; channelIdx++) {
      if ((channelIdx & 3) == 3) {
        destPixels.buffer[channelIdx] = sourcePixels.buffer[channelIdx];
        continue
      }
      const srcSample = sourcePixels.buffer[channelIdx];
      const blurredSample = destPixels.buffer[channelIdx];
      let sharpenDelta = sharpenAmount * (srcSample - blurredSample);
      if (sharpenDelta > 0) sharpenDelta = Math.max(0, sharpenDelta - sharpenThreshold);
      else sharpenDelta = Math.min(0, sharpenDelta + sharpenThreshold);
      destPixels.buffer[channelIdx] = Math.max(0, Math.min(255, srcSample + sharpenDelta))
    }
  }
  if (filterType == "HghP")
    for (let channelIdx = 0; channelIdx < sourcePixels.buffer.length; channelIdx++) {
      if ((channelIdx & 3) == 3) {
        destPixels.buffer[channelIdx] = sourcePixels.buffer[channelIdx];
        continue
      }
      const srcSample = sourcePixels.buffer[channelIdx];
      const blurredSample = destPixels.buffer[channelIdx];
      destPixels.buffer[channelIdx] = Math.max(0, Math.min(255, 128 + srcSample - blurredSample))
    }
}

function applySurfaceBlurFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const surfaceBlurRadius = filterDescriptor.Rds.v.val;
  const surfaceBlurThreshold = filterDescriptor.Thsh.v;
  let pixelWidth = sourcePixels.rect.width;
  let pixelHeight = sourcePixels.rect.height;
  FilterDefs.applyMorphologicalGradientFill(sourcePixels.buffer, destPixels.buffer, pixelWidth, pixelHeight, surfaceBlurRadius, selectWeightedMean, [surfaceBlurThreshold], 2)
}

function applyAddNoiseFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const destRgbaView = new Uint8ClampedArray(destPixels.buffer.buffer);
  const noiseAmount = 255 * filterDescriptor.Nose.v.val / 100;
  let noiseSampleFn;
  if (filterDescriptor.Dstr.v.Dstr == "Gsn") noiseSampleFn = function() {
    return (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 2
  };
  else noiseSampleFn = function() {
    return Math.random() * 2 - 1
  };
  for (let rgbaOffset = 0; rgbaOffset < destRgbaView.length; rgbaOffset += 4) {
    let red = destRgbaView[rgbaOffset];
    let green = destRgbaView[rgbaOffset + 1];
    let blue = destRgbaView[rgbaOffset + 2];
    let noiseRed;
    let noiseGreen;
    let noiseBlue;
    if (filterDescriptor.Mnch.v) {
      noiseRed = noiseGreen = noiseBlue = noiseSampleFn()
    } else {
      noiseRed = noiseSampleFn();
      noiseGreen = noiseSampleFn();
      noiseBlue = noiseSampleFn()
    }
    red += noiseAmount * noiseRed;
    green += noiseAmount * noiseGreen;
    blue += noiseAmount * noiseBlue;
    destRgbaView[rgbaOffset] = red;
    destRgbaView[rgbaOffset + 1] = green;
    destRgbaView[rgbaOffset + 2] = blue
  }
}

function applyRankFilterFamily(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  let kernelRadius = 0;
  if (filterType == "Mdn " || filterType == "Mxm " || filterType == "Mnm ") kernelRadius = filterDescriptor.Rds.v.val;
  if (filterType == "DstS") kernelRadius = filterDescriptor.Rds.v;
  setPercentileFraction(.5);
  let rankSelectorFn = selectPercentile;
  if (filterType == "Mxm ") rankSelectorFn = selectMaximum;
  if (filterType == "Mnm ") rankSelectorFn = selectMinimum;
  let pixelWidth = sourcePixels.rect.width;
  let pixelHeight = sourcePixels.rect.height;

  const rankMode = {
    "Mdn ": 0,
    "Mxm ": 1,
    "Mnm ": 1,
    DstS: 2
  } [filterType];

  FilterDefs.applyMorphologicalGradientFill(sourcePixels.buffer, destPixels.buffer, pixelWidth, pixelHeight, kernelRadius, rankSelectorFn, [], rankMode);
  if (filterType == "DstS") {
    const dustThreshold = filterDescriptor.Thsh.v;
    for (let channelIdx = 0; channelIdx < pixelWidth * pixelHeight * 4; channelIdx++) {
      const channelDelta = Math.abs(sourcePixels.buffer[channelIdx] - destPixels.buffer[channelIdx]);
      if (channelDelta <= dustThreshold) destPixels.buffer[channelIdx] = sourcePixels.buffer[channelIdx]
    }
  }
}

function applyColorHalftoneFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const halftoneRect = sourcePixels.rect.clone();
  halftoneRect.x = halftoneRect.y = 0;
  let dotRadius = filterDescriptor.Rds.v;
  dotRadius = Math.round(dotRadius * Math.sqrt(2));
  let pixelWidth = halftoneRect.width;
  let pixelHeight = halftoneRect.height;
  const planarRgb = new PlanarRgbaBuffer(pixelWidth * pixelHeight);
  interleavedToPlanar(sourcePixels.buffer, planarRgb);
  invert(planarRgb.h);
  invert(planarRgb.l);
  invert(planarRgb.O);
  const halftoneCanvas = makeElement("canvas", "");
  halftoneCanvas.width = pixelWidth;
  halftoneCanvas.height = pixelHeight;
  const halftoneCtx = halftoneCanvas.getContext("2d");
  const channelScratch = allocBuffer(pixelWidth * pixelHeight * 4);
  for (let channelIdx = 0; channelIdx < 3; channelIdx++) {
    const channelPlane = channelIdx == 0 ? planarRgb.h : channelIdx == 1 ? planarRgb.l : planarRgb.O;
    const screenAngleRad = Math.PI * filterDescriptor["Ang" + (channelIdx + 1)].v / 180;
    const screenMatrix = new Matrix2D(1 / dotRadius, 0, 0, 1 / dotRadius, 0, 0);
    screenMatrix.rotate(screenAngleRad);
    extractChannel(channelPlane, channelScratch, 3);
    const transformed = transformPixels([channelScratch, halftoneRect], screenMatrix, true);
    const transformedRect = transformed.rect;
    halftoneCtx.clearRect(0, 0, pixelWidth, pixelHeight);
    const sinAngle = Math.sin(screenAngleRad);
    const cosAngle = Math.cos(screenAngleRad);
    for (let row = 0; row < transformedRect.height; row++)
      for (let col = 0; col < transformedRect.width; col++) {
        let screenX = (col + transformedRect.x + .5) * dotRadius;
        let screenY = (row + transformedRect.y + .5) * dotRadius;
        const unrotX = screenX;
        const unrotY = screenY;
        screenX = cosAngle * unrotX - sinAngle * unrotY;
        screenY = sinAngle * unrotX + cosAngle * unrotY;
        const alpha = transformed.buffer[(row * transformedRect.width + col << 2) + 3] * (1 / 255);
        const dotRadiusPx = dotRadius * Math.sqrt(alpha * (1 / Math.PI));
        halftoneCtx.beginPath();
        halftoneCtx.arc(screenX, screenY, dotRadiusPx, 0, 2 * Math.PI);
        halftoneCtx.fill()
      }
    const imageData = halftoneCtx.getImageData(0, 0, pixelWidth, pixelHeight);
    extractChannelByte(imageData.data, channelPlane, 3)
  }
  invert(planarRgb.h);
  invert(planarRgb.l);
  invert(planarRgb.O);
  planarToInterleaved(planarRgb, destPixels.buffer)
}

function applyCrystallizePaintFamily(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  let pixelWidth = sourcePixels.rect.width;
  let pixelHeight = sourcePixels.rect.height;
  const quantizeFn = filterType == "Crst" ? quantize : quantizeWithBorder;
  quantizeFn(sourcePixels.buffer, pixelWidth, pixelHeight, destPixels.buffer, filterDescriptor.ClSz.v, [Math.round(bgRgb.h), Math.round(bgRgb.l), Math.round(bgRgb.O)])
}

function applyMezzotintFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  let pixelWidth = sourcePixels.rect.width;
  let pixelHeight = sourcePixels.rect.height;
  const pixelCount = pixelWidth * pixelHeight;
  const planarRgb = new PlanarRgbaBuffer(pixelCount);
  const channelPlanes = [planarRgb.h, planarRgb.l, planarRgb.O];
  interleavedToPlanar(sourcePixels.buffer, planarRgb);
  const mezzotintTypeKey = filterDescriptor.MztT.v.MztT;

  const mezzotintParams = {
    FnDt: [.1, 0, .3, 1.4],
    MdmD: [.9, 0, .1, 1.4],
    GrnD: [3, 0, .2, 1.4],
    CrsD: [7, 0, .1, 1.4],
    ShrL: [0, 10, .16, 3],
    MdmL: [0, 22, .06, 3],
    LngL: [0, 25, .01, 4.5],
    ShSt: [3, 10, .05, 4.4],
    MdmS: [4, 25, .15, 4],
    LngS: [4, 30, .05, 4]
  } [mezzotintTypeKey];

  const thresholdField = [];
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    thresholdField[pixelIdx] = Math.random()
  }
  const spotSwapCount = Math.round(pixelCount * mezzotintParams[0]);
  const maxLinearIndex = pixelCount - pixelWidth - 1;
  for (let swapIdx = 0; swapIdx < spotSwapCount; swapIdx++) {
    let rand = Math.random();
    let swapStride = 1;
    if (rand < .5) {
      swapStride = pixelWidth;
      rand *= 2
    } else rand = 2 * (rand - .5);
    const srcIdx = Math.floor(rand * maxLinearIndex);
    const dstIdx = srcIdx + swapStride;
    thresholdField[srcIdx] = thresholdField[dstIdx]
  }
  const horizSwapPasses = Math.round(pixelWidth * mezzotintParams[1]);
  for (let row = 0; row < pixelHeight; row++)
    for (let passIdx = 0; passIdx < horizSwapPasses; passIdx++) {
      let rand = initRng(row * pixelCount + passIdx);
      const srcIdx = row * pixelWidth + Math.floor(rand * (pixelWidth - 1));
      thresholdField[srcIdx] = thresholdField[srcIdx + 1]
    }
  const toneCurveLut = new Float64Array(256);
  for (let toneIdx = 0; toneIdx < 256; toneIdx++) {
    let toneValue = toneIdx / 255;
    let contrastCurve = 2 * (toneValue < .5 ? toneValue : 1 - toneValue);
    contrastCurve = mezzotintParams[2] + Math.pow(contrastCurve, mezzotintParams[3]) * (1 - mezzotintParams[2]);
    toneValue = toneValue < .5 ? contrastCurve * .5 : 1 - contrastCurve * .5;
    toneCurveLut[toneIdx] = toneValue
  }
  for (let channelIdx = 0; channelIdx < 3; channelIdx++) {
    const channelPlane = channelPlanes[channelIdx];
    for (let row = 0; row < pixelHeight; row++) {
      for (let col = 0; col < pixelWidth; col++) {
        let pixelIdx = row * pixelWidth + col;
        const sampleValue = channelPlane[pixelIdx];
        const toneThreshold = toneCurveLut[sampleValue];
        const randThreshold = thresholdField[pixelIdx];
        channelPlane[pixelIdx] = randThreshold > toneThreshold ? 0 : 255
      }
    }
  }
  planarToInterleaved(planarRgb, destPixels.buffer)
}

function applyMosaicFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const cellSize = filterDescriptor.ClSz.v.val;
  let pixelWidth = sourcePixels.rect.width;
  let pixelHeight = sourcePixels.rect.height;
  const gridWidth = Math.ceil(pixelWidth / cellSize);
  const gridHeight = Math.ceil(pixelHeight / cellSize);
  const cellBuffer = allocBuffer(gridWidth * gridHeight * 4);
  resampleUint32UniformScale(sourcePixels.buffer, pixelWidth, pixelHeight, cellBuffer, gridWidth, gridHeight, 1 / cellSize);
  resampleUint32UniformScale(cellBuffer, gridWidth, gridHeight, destPixels.buffer, pixelWidth, pixelHeight, cellSize)
}

function applyCloudsDifferenceFamily(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  let pixelWidth = destPixels.rect.width;
  let pixelHeight = destPixels.rect.height;
  const pixelCount = pixelWidth * pixelHeight;
  const noiseGray = allocBuffer(pixelCount);
  if (filterType == "Clds") fillBuffer(destPixels.buffer, 4278190080);
  const fgBgGradientRgba = allocBuffer(256 * 4);
  for (let lutIdx = 0; lutIdx < 256; lutIdx++) {
    const lutOffset = lutIdx << 2;
    const blend = lutIdx / 255;
    const invBlend = 1 - blend;
    fgBgGradientRgba[lutOffset] = Math.round(blend * fgRgb.h + invBlend * bgRgb.h);
    fgBgGradientRgba[lutOffset + 1] = Math.round(blend * fgRgb.l + invBlend * bgRgb.l);
    fgBgGradientRgba[lutOffset + 2] = Math.round(blend * fgRgb.O + invBlend * bgRgb.O)
  }
  let cloudsNoiseSeed = Math.random();
  if (filterDescriptor != null && filterDescriptor.FlRs != null && typeof filterDescriptor.FlRs.v === "number" && !isNaN(filterDescriptor.FlRs.v))
    cloudsNoiseSeed = (filterDescriptor.FlRs.v >>> 0) / 4294967296;
  applyCloudsNoise(sourcePixels.buffer, pixelWidth, pixelHeight, noiseGray, cloudsNoiseSeed);
  const destRgba = destPixels.buffer;
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    let rgbaOffset = pixelIdx << 2;
    const gradOffset = noiseGray[pixelIdx] << 2;
    const gradRed = fgBgGradientRgba[gradOffset];
    const gradGreen = fgBgGradientRgba[gradOffset + 1];
    const gradBlue = fgBgGradientRgba[gradOffset + 2];
    if (filterType == "Clds") {
      destRgba[rgbaOffset] = gradRed;
      destRgba[rgbaOffset + 1] = gradGreen;
      destRgba[rgbaOffset + 2] = gradBlue
    } else {
      destRgba[rgbaOffset] = Math.abs(destRgba[4 * pixelIdx] - gradRed);
      destRgba[rgbaOffset + 1] = Math.abs(destRgba[4 * pixelIdx + 1] - gradGreen);
      destRgba[rgbaOffset + 2] = Math.abs(destRgba[4 * pixelIdx + 2] - gradBlue)
    }
  }
}

function applyLensFlareFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  let pixelWidth = sourcePixels.rect.width;
  let pixelHeight = sourcePixels.rect.height;
  const lensFlarePresetIndex = Math.max(0, LENS_FLARE_PRESET_WIRE_KEYS.indexOf(filterDescriptor.Lns.v.Lns));
  const flarePointDesc = filterDescriptor.FlrC.v;
  const lensFlareParams = [lensFlarePresetIndex, filterDescriptor.Brgh.v / 100, flarePointDesc.Hrzn.v, flarePointDesc.Vrtc.v];
  renderLensFlare(sourcePixels.buffer, pixelWidth, pixelHeight, destPixels.buffer, lensFlareParams)
}

const presetKernelFilterTypes = ["Blr ", "BlrM", "Shrp", "ShrM"];
const blurSharpenFilterTypes = ["GsnB", "boxblur", "smartSharpen", "UnsM", "HghP"];
const warpFilterTypes = "LqFy,Dspl,Pnch,Sphr,Twrl,Rple,Shr ,Wave,LnCr".split(",");

function applyPresetKernelFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const presetKernelIndex = presetKernelFilterTypes.indexOf(filterType);
  if (presetKernelIndex != -1) {
    const isSharpenKernel = presetKernelIndex > 1;
    let pixelWidth = sourcePixels.rect.width;
    let pixelHeight = sourcePixels.rect.height;
    const presetKernel = presetKernels[presetKernelIndex];
    const scratchRgba = sourcePixels.buffer.slice(0);
    if (!isSharpenKernel) premultiplyAlpha(scratchRgba);
    convolveRGBA(scratchRgba, destPixels.buffer, pixelWidth, pixelHeight, presetKernel, 255, false, isSharpenKernel);
    if (!isSharpenKernel) unpremultiplyAlpha(destPixels.buffer)
  }
}

function applyMotionBlurFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const motionAngleRad = -filterDescriptor.Angl.v * Math.PI / 180;
  const blurHalfDistance = filterDescriptor.Dstn.v.val / 2;
  let pixelWidth = sourcePixels.rect.width;
  let pixelHeight = sourcePixels.rect.height;
  const clipRect = sourcePixels.rect.clone();
  clipRect.x = clipRect.y = 0;
  if (LayerSystem.webglEnabled) {
    const workingRgba = destPixels.buffer;
    workingRgba.set(sourcePixels.buffer);
    premultiplyAlpha(workingRgba);
    const sourceTexture = LayerSystem.getPooledTexture(0, pixelWidth, pixelHeight);
    sourceTexture.set(workingRgba);
    const directionRgb = allocBuffer(4);
    directionRgb[0] = Math.round(128 + 127 * Math.cos(motionAngleRad));
    directionRgb[1] = Math.round(128 + 127 * Math.sin(motionAngleRad));
    new Uint32Array(workingRgba.buffer).fill(new Uint32Array(directionRgb.buffer)[0]);
    const tangentMapTexture = LayerSystem.getPooledTexture(1, pixelWidth, pixelHeight);
    tangentMapTexture.set(workingRgba);
    LayerSystem.bindRenderTarget(sourceTexture, clipRect);
    sourceTexture.saveBackup(clipRect);
    LayerSystem.filter.render({
      type: LayerSystem.filter.ANISOTROPIC,
      tangentMapTexture: tangentMapTexture.glTexture,
      invTexelSize: new Float32Array([1 / pixelWidth, 1 / pixelHeight]),
      blurSigma: blurHalfDistance / 2,
      blurExponent: 1
    }, sourceTexture.backupTexture);
    sourceTexture.get(workingRgba);
    unpremultiplyAlpha(workingRgba)
  } else {
    const rotateMatrix = new Matrix2D;
    rotateMatrix.rotate(motionAngleRad);
    const transformed = transformPixels([sourcePixels.buffer, sourcePixels.rect], rotateMatrix, false, null, true);
    FilterDefs.applyPremultipliedBlur(blurHalfDistance, boxBlurRgba, transformed.buffer, transformed.rect);
    rotateMatrix.invert();
    transformPixels([transformed.buffer, transformed.rect], rotateMatrix, false, destPixels.buffer.buffer, true, destPixels.rect)
  }
}

function applyRadialBlurFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  let pixelWidth = sourcePixels.rect.width;
  let pixelHeight = sourcePixels.rect.height;
  const blurAmount = filterDescriptor.Amnt.v;
  const isSpinMode = filterDescriptor.BlrM.v.BlrM == "Zm";
  const centerDesc = filterDescriptor.Cntr.v;
  const centerX = centerDesc.Hrzn.v;
  const centerY = centerDesc.Vrtc.v;
  const centerOffsetX = Math.max(centerX, 1 - centerX) * pixelWidth;
  const centerOffsetY = Math.max(centerY, 1 - centerY) * pixelHeight;
  const radialDistance = Math.sqrt(centerOffsetX * centerOffsetX + centerOffsetY * centerOffsetY);
  const circumference = 2 * Math.PI * radialDistance * 1.5;
  const stripWidth = Math.round(circumference);
  const stripHeight = Math.round(radialDistance);
  const stripRect = new Rect(0, 0, stripWidth, stripHeight);
  let stripBuffer = allocBuffer(stripWidth * stripHeight * 4);
  const sampleCount = isSpinMode ? 4 : 1;
  const blurScale = isSpinMode ? .6 : 8 * ((pixelWidth + pixelHeight) / 2) / 1400;
  const radialInner = .1;
  const radialStart = 1;
  const radialEnd = 1;
  sampleRadialStrip(sourcePixels.buffer, pixelWidth, pixelHeight, stripBuffer, stripWidth, stripHeight, centerX, centerY, sampleCount, radialInner, radialStart, radialEnd);
  let transposeScratch = isSpinMode ? allocBuffer(stripWidth * stripHeight * 4) : null;
  if (isSpinMode) {
    transposePixels(stripBuffer, transposeScratch, stripWidth, stripHeight);
    const swapTemp = transposeScratch;
    transposeScratch = stripBuffer;
    stripBuffer = swapTemp;
    stripRect.width = stripHeight;
    stripRect.height = stripWidth
  }
  FilterDefs.applyPremultipliedBlur(blurScale * blurAmount, boxBlurRgba, stripBuffer, stripRect);
  if (isSpinMode) {
    transposePixels(stripBuffer, transposeScratch, stripHeight, stripWidth);
    const swapTemp = transposeScratch;
    transposeScratch = stripBuffer;
    stripBuffer = swapTemp;
    stripRect.width = stripWidth;
    stripRect.height = stripHeight
  }
  samplePolarStrip(stripBuffer, stripWidth, stripHeight, destPixels.buffer, pixelWidth, pixelHeight, centerX, centerY, sampleCount, radialInner, radialStart, radialEnd)
}

function applyPolarCoordinatesFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  let pixelWidth = sourcePixels.rect.width;
  let pixelHeight = sourcePixels.rect.height;
  if (filterDescriptor.Cnvr.v.Cnvr == "RctP") samplePolarStrip(sourcePixels.buffer, pixelWidth, pixelHeight, destPixels.buffer, pixelWidth, pixelHeight, .5, .5, 1, 0, 2, pixelWidth / pixelHeight);
  else sampleRadialStrip(sourcePixels.buffer, pixelWidth, pixelHeight, destPixels.buffer, pixelWidth, pixelHeight, .5, .5, 1, 0, 2, pixelWidth / pixelHeight)
}

function applyFindEdgesFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  let pixelWidth = sourcePixels.rect.width;
  let pixelHeight = sourcePixels.rect.height;
  findEdgesRGB(sourcePixels.buffer, destPixels.buffer, pixelWidth, pixelHeight)
}

function applyOilPaintFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const lightAngleRad = filterDescriptor.LghD.v * Math.PI / 180;
  const lightDirection = [Math.cos(lightAngleRad), Math.sin(lightAngleRad), .001];
  const oilPaintParams = [filterDescriptor.stylization.v, filterDescriptor.cleanliness.v, filterDescriptor.brushScale.v, filterDescriptor.microBrush.v, filterDescriptor.lightingOn.v, filterDescriptor.specularity.v, lightDirection];
  const contentRect = sourcePixels.rect.clone();
  contentRect.x = contentRect.y = 0;
  filter(sourcePixels.buffer, contentRect, destPixels.buffer, oilPaintParams)
}

function applyOffsetFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  let pixelWidth = sourcePixels.rect.width;
  let pixelHeight = sourcePixels.rect.height;
  const srcUint32 = new Uint32Array(sourcePixels.buffer.buffer);
  const destUint32 = new Uint32Array(destPixels.buffer.buffer);
  let offsetX = filterDescriptor.Hrzn.v;
  let offsetY = filterDescriptor.Vrtc.v;
  const fillMode = filterDescriptor.Fl.v.FlMd;
  fillBuffer(destUint32, 0);
  if (fillMode == "Bckg" || fillMode == "Rpt") {
    const copyRect = sourcePixels.rect.clone();
    copyRect.offset(offsetX, offsetY);
    copyPixels(srcUint32, copyRect, destUint32, destPixels.rect)
  }
  if (fillMode == "Rpt") {
    let tileStartCol;
    let tileEndCol;
    let tileStartRow;
    let tileEndRow;
    let sourceIndex;
    offsetX = Math.max(-pixelWidth, Math.min(pixelWidth, offsetX));
    offsetY = Math.max(-pixelHeight, Math.min(pixelHeight, offsetY));
    tileStartCol = offsetX > 0 ? offsetX : 0;
    tileEndCol = offsetX > 0 ? pixelWidth : pixelWidth + offsetX;
    tileStartRow = offsetY > 0 ? 0 : offsetY + pixelHeight;
    tileEndRow = offsetY > 0 ? offsetY : pixelHeight;
    sourceIndex = offsetY > 0 ? 0 : pixelWidth * (pixelHeight - 1);
    for (let row = tileStartRow; row < tileEndRow; row++)
      for (let col = tileStartCol; col < tileEndCol; col++) destUint32[row * pixelWidth + col] = srcUint32[sourceIndex + col - offsetX];
    tileStartCol = offsetX > 0 ? 0 : pixelWidth + offsetX;
    tileEndCol = offsetX > 0 ? offsetX : pixelWidth;
    tileStartRow = offsetY > 0 ? offsetY : 0;
    tileEndRow = offsetY > 0 ? pixelHeight : pixelHeight + offsetY;
    sourceIndex = offsetX > 0 ? 0 : pixelWidth - 1;
    for (let row = tileStartRow; row < tileEndRow; row++)
      for (let col = tileStartCol; col < tileEndCol; col++) destUint32[row * pixelWidth + col] = srcUint32[sourceIndex + pixelWidth * (row - offsetY)];
    if (offsetX >= 0 && offsetY >= 0) {
      tileStartCol = 0;
      tileEndCol = offsetX;
      tileStartRow = 0;
      tileEndRow = offsetY;
      sourceIndex = 0
    }
    if (offsetX >= 0 && offsetY < 0) {
      tileStartCol = 0;
      tileEndCol = offsetX;
      tileStartRow = pixelHeight + offsetY;
      tileEndRow = pixelHeight;
      sourceIndex = pixelWidth * (pixelHeight - 1)
    }
    if (offsetX < 0 && offsetY >= 0) {
      tileStartCol = pixelWidth + offsetX;
      tileEndCol = pixelWidth;
      tileStartRow = 0;
      tileEndRow = offsetY;
      sourceIndex = pixelWidth - 1
    }
    if (offsetX < 0 && offsetY < 0) {
      tileStartCol = pixelWidth + offsetX;
      tileEndCol = pixelWidth;
      tileStartRow = pixelHeight + offsetY;
      tileEndRow = pixelHeight;
      sourceIndex = pixelWidth * pixelHeight - 1
    }
    for (let row = tileStartRow; row < tileEndRow; row++)
      for (let col = tileStartCol; col < tileEndCol; col++) destUint32[row * pixelWidth + col] = srcUint32[sourceIndex]
  }
  if (fillMode == "Wrp") {
    offsetX = (offsetX + 100 * pixelWidth) % pixelWidth;
    offsetY = (offsetY + 100 * pixelHeight) % pixelHeight;
    const wrapRect = new Rect(offsetX - pixelWidth, offsetY - pixelHeight, pixelWidth, pixelHeight);
    copyPixels(srcUint32, wrapRect, destUint32, destPixels.rect);
    wrapRect.offset(pixelWidth, 0);
    copyPixels(srcUint32, wrapRect, destUint32, destPixels.rect);
    wrapRect.offset(0, pixelHeight);
    copyPixels(srcUint32, wrapRect, destUint32, destPixels.rect);
    wrapRect.offset(-pixelWidth, 0);
    copyPixels(srcUint32, wrapRect, destUint32, destPixels.rect)
  }
}

/**
 * Displace scale unit → pixels. A scale of 100 shifts by up to 127 px, matching
 * the amount Photoshop's Horizontal / Vertical Scale fields ask for.
 */
const DISPLACE_SCALE_TO_PIXELS = 2.54;

/**
 * The linked-file item a Displace descriptor points at, or null when the tag
 * resolves to nothing — a document whose map was never chosen, or a file written
 * by another editor that stored an on-disk path instead of an embedded map. The
 * filter then leaves the pixels alone rather than displacing by an unrelated image.
 */
function findDisplacementMap(linkedItems, mapTag) {
  if (mapTag == null || mapTag === "") return null;
  for (let itemIdx = 0; itemIdx < linkedItems.length; itemIdx++) {
    if (linkedItems[itemIdx].tag == mapTag) {
      const linkedItem = linkedItems[itemIdx];
      linkedItem.getRasterData();
      return linkedItem.rasterCache ? linkedItem : null;
    }
  }
  return null;
}

/**
 * Split a decoded displacement map into the two planes that steer the warp.
 * A map with more than one distinct channel displaces horizontally by its first
 * channel and vertically by its second; a grey map displaces both axes by its
 * single value.
 * @returns {{ horizontal: Uint8Array, vertical: Uint8Array }}
 */
function displacementChannels(mapPixels, mapArea) {
  const horizontal = allocBuffer(mapArea);
  const vertical = allocBuffer(mapArea);
  extractChannelByte(mapPixels, horizontal, 0);
  extractChannelByte(mapPixels, vertical, 1);
  if (equals(horizontal, vertical)) return { horizontal, vertical: horizontal };
  return { horizontal, vertical };
}

/** Byte 0..255 → signed −0.5..0.5 displacement fraction. */
function displacementFraction(sample) {
  return -.5 + sample * (1 / 255);
}

/**
 * Stretch To Fit: the map covers the layer exactly, so the field keeps the map's
 * own resolution and the warp sampler scales it up. Scales are pre-divided by
 * that ratio because the sampler multiplies the field back by it.
 */
function buildStretchedDisplacementField(displacementMap, filterDescriptor, pixelWidth, pixelHeight) {
  const mapRect = displacementMap.rasterCache[1];
  const mapWidth = mapRect.width;
  const mapHeight = mapRect.height;
  const channels = displacementChannels(displacementMap.rasterCache[0], mapRect.area());
  const warpMap = {
    gridWidth: mapWidth,
    gridHeight: mapHeight,
    map: new Float32Array(mapWidth * mapHeight * 2)
  };
  const horizScale = DISPLACE_SCALE_TO_PIXELS * filterDescriptor.HrzS.v * mapWidth / pixelWidth;
  const vertScale = DISPLACE_SCALE_TO_PIXELS * filterDescriptor.VrtS.v * mapHeight / pixelHeight;
  for (let mapRow = 0; mapRow < mapHeight; mapRow++) {
    for (let mapCol = 0; mapCol < mapWidth; mapCol++) {
      const mapIndex = mapRow * mapWidth + mapCol;
      const fieldOffset = mapIndex << 1;
      warpMap.map[fieldOffset] = displacementFraction(channels.horizontal[mapIndex]) * horizScale;
      warpMap.map[fieldOffset + 1] = displacementFraction(channels.vertical[mapIndex]) * vertScale;
    }
  }
  return warpMap;
}

/**
 * Tile: the map is laid over the layer at its own pixel size and repeated from
 * the top-left corner, so the field is built at layer resolution and reads the
 * map with wrapped coordinates.
 */
function buildTiledDisplacementField(displacementMap, filterDescriptor, pixelWidth, pixelHeight) {
  const mapRect = displacementMap.rasterCache[1];
  const mapWidth = mapRect.width;
  const mapHeight = mapRect.height;
  const channels = displacementChannels(displacementMap.rasterCache[0], mapRect.area());
  const warpMap = {
    gridWidth: pixelWidth,
    gridHeight: pixelHeight,
    map: new Float32Array(pixelWidth * pixelHeight * 2)
  };
  const horizScale = DISPLACE_SCALE_TO_PIXELS * filterDescriptor.HrzS.v;
  const vertScale = DISPLACE_SCALE_TO_PIXELS * filterDescriptor.VrtS.v;
  for (let row = 0; row < pixelHeight; row++) {
    const mapRowOffset = row % mapHeight * mapWidth;
    for (let col = 0; col < pixelWidth; col++) {
      const mapIndex = mapRowOffset + col % mapWidth;
      const fieldOffset = row * pixelWidth + col << 1;
      warpMap.map[fieldOffset] = displacementFraction(channels.horizontal[mapIndex]) * horizScale;
      warpMap.map[fieldOffset + 1] = displacementFraction(channels.vertical[mapIndex]) * vertScale;
    }
  }
  return warpMap;
}

function applyWarpFamilyFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  const linkLayers = filterContext && filterContext[0] ? filterContext[0] : [];
  let pixelWidth = sourcePixels.rect.width;
  let pixelHeight = sourcePixels.rect.height;
  let warpMap;
  let edgeMode = 0;
  if (filterType == "LqFy") warpMap = CachedLayerData.parse(new Uint8Array(filterDescriptor.LqMe.v).buffer);
  else {
    const gridDivisor = (filterType == "LnCr" && filterDescriptor.__warpGridDivisor > 3)
      ? (filterDescriptor.__warpGridDivisor | 0)
      : 3;
    warpMap = {
      gridWidth: Math.floor(pixelWidth / gridDivisor),
      gridHeight: Math.floor(pixelHeight / gridDivisor)
    };
    warpMap.map = new Float32Array(warpMap.gridWidth * warpMap.gridHeight * 2);
    if (filterType == "LnCr") {
      fillLensCorrectionWarpMap(warpMap, filterDescriptor, filterDescriptor.lensProfileCalibration);
      edgeMode = resolveLensCorrectionEdgeMode(filterDescriptor);
    } else if (filterType == "Dspl") {
      edgeMode = filterDescriptor.UndA.v.UndA == "WrpA" ? 2 : 1;
      const displacementMap = findDisplacementMap(linkLayers, filterDescriptor.DspF.v.pth);
      if (displacementMap != null) {
        warpMap = filterDescriptor.DspM.v.DspM == "Tile"
          ? buildTiledDisplacementField(displacementMap, filterDescriptor, pixelWidth, pixelHeight)
          : buildStretchedDisplacementField(displacementMap, filterDescriptor, pixelWidth, pixelHeight);
      }
    } else if (filterType == "Pnch" || filterType == "Twrl" || filterType == "Sphr") {
      let warpAmount = 1;
      let twistAngleRad = Math.PI;
      let sphereModeIndex = 0;
      let sphereRadius = 3;
      let sphereScaleSign = 1.53;
      let raySign = 1;
      if (filterType == "Pnch" || filterType == "Sphr") warpAmount = filterDescriptor.Amnt.v / 100;
      if (filterType == "Twrl") twistAngleRad = filterDescriptor.Angl.v * Math.PI / 180;
      if (filterType == "Sphr") sphereModeIndex = ["Nrml", "HrzO", "VrtO"].indexOf(filterDescriptor.SphM.v.SphM);

      function pinchFalloff(normRadius) {
        normRadius = Math.pow(normRadius, 1 - normRadius * .3 - normRadius * normRadius * (normRadius * normRadius) * .5);
        return -.225 * Math.sin(normRadius * Math.PI)
      }

      function sphereRayDistance(originY, sphereCenterY, sphereRadius, rayOriginX, rayOriginY, hitNormX, hitNormY, sign) {
        const dirX = hitNormX - rayOriginX;
        const dirY = hitNormY - rayOriginY;
        const relX = rayOriginX - originY;
        const relY = rayOriginY - sphereCenterY;
        const dirLenSq = dirX * dirX + dirY * dirY;
        const dotTerm = 2 * (dirX * relX + dirY * relY);
        const relLenSq = relX * relX + relY * relY - sphereRadius * sphereRadius;
        const discriminant = Math.sqrt(dotTerm * dotTerm - 4 * dirLenSq * relLenSq);
        const invDenom = sign / (2 * dirLenSq);
        const nearRoot = (-dotTerm + discriminant) * invDenom;
        const farRoot = (-dotTerm - discriminant) * invDenom;
        return sign * Math.min(nearRoot, farRoot)
      }
      const mapWidth = warpMap.gridWidth;
      const mapHeight = warpMap.gridHeight;
      const halfMapWidth = warpMap.gridWidth / 2;
      const halfMapHeight = warpMap.gridHeight / 2;
      const invHalfWidth = 1 / halfMapWidth;
      let sphereRadiusFactor = Math.sqrt(sphereRadius * sphereRadius + 1) / sphereRadius;
      let sphereCenterOffset = sphereRadius + Math.sqrt(1 / (sphereRadius * sphereRadius));
      if (warpAmount < 0) {
        sphereRadius = 1.72;
        sphereRadiusFactor = 1;
        sphereCenterOffset = sphereRadius;
        sphereScaleSign = -1;
        raySign = -1
      }
      for (let mapRow = 0; mapRow < mapHeight; mapRow++) {
        let normY = (mapRow - halfMapHeight) / halfMapHeight;
        for (let mapCol = 0; mapCol < mapWidth; mapCol++) {
          let normX = (mapCol - halfMapWidth) * invHalfWidth;
          if (sphereModeIndex == 1) normY = 0;
          else if (sphereModeIndex == 2) normX = 0;
          let normRadius = Math.sqrt(normX * normX + normY * normY);
          if (normRadius < 1 && normRadius != 0) {
            const mapOffset = mapRow * warpMap.gridWidth + mapCol << 1;
            if (filterType == "Pnch") {
              const pinchScale = -warpAmount * pinchFalloff(normRadius) / normRadius;
              warpMap.map[mapOffset] = normX * pinchScale * halfMapWidth;
              warpMap.map[mapOffset + 1] = normY * pinchScale * halfMapHeight
            } else if (filterType == "Sphr") {
              const rayHit = sphereRayDistance(0, sphereCenterOffset, sphereRadiusFactor, 0, 0, normRadius, sphereRadius, raySign);
              const sphereScale = sphereScaleSign * warpAmount * (rayHit - 1);
              warpMap.map[mapOffset] = normX * sphereScale * halfMapWidth;
              warpMap.map[mapOffset + 1] = normY * sphereScale * halfMapHeight
            } else if (filterType == "Twrl") {
              const twistAngle = Math.atan2(normY, normX) - twistAngleRad * (1 - normRadius) * (1 - normRadius);
              const cosAngle = Math.cos(twistAngle);
              const sinAngle = Math.sin(twistAngle);
              warpMap.map[mapOffset] = (normRadius * cosAngle - normX) * halfMapWidth;
              warpMap.map[mapOffset + 1] = (normRadius * sinAngle - normY) * halfMapHeight
            }
          }
        }
      }
    } else if (filterType == "Shr ") {
      const curvePointsCopy = JSON.parse(JSON.stringify(filterDescriptor.ShrP.v));
      transformCurvePoints(curvePointsCopy, new Matrix2D(0, 255 / 127, 255 / 127, 0, -2, 0));
      const shearLut = buildToneCurveLut(curvePointsCopy, warpMap.gridHeight, true);
      edgeMode = filterDescriptor.UndA.v.UndA == "WrpA" ? 2 : 1;
      for (let mapRow = 0; mapRow < warpMap.gridHeight; mapRow++) {
        const horizShear = -shearLut[mapRow] * warpMap.gridWidth;
        for (let mapCol = 0; mapCol < warpMap.gridWidth; mapCol++) {
          const mapOffset = mapRow * warpMap.gridWidth + mapCol << 1;
          warpMap.map[mapOffset] = horizShear
        }
      }
    } else if (filterType == "Wave") {
      const numGenerators = filterDescriptor.NmbG.v;
      const minWavelength = filterDescriptor.WLMn.v;
      const maxWavelength = filterDescriptor.WLMx.v;
      const minAmplitude = filterDescriptor.AmMn.v * (Math.PI / 4);
      const maxAmplitude = filterDescriptor.AmMx.v * (Math.PI / 4);
      const horizWaveScale = filterDescriptor.SclH.v / 100;
      const vertWaveScale = filterDescriptor.SclV.v / 100;
      const waveType = filterDescriptor.Wvtp.v.Wvtp;
      let waveFn = Math.sin;
      if (waveType == "WvTr") waveFn = function(phase) {
        phase *= 2 / Math.PI;
        return -.5 + Math.abs(phase % 2 - 1)
      };
      if (waveType == "WvSq") waveFn = function(phase) {
        phase *= 2 / Math.PI;
        return 1 + 2 * Math.floor(phase % 2 - 1)
      };
      const generatorParams = [];
      const rngState = new RngState(filterDescriptor.RndS.v);
      for (let genIdx = 0; genIdx < numGenerators; genIdx++) {
        generatorParams.push(rngState.get() * 10);
        generatorParams.push(Math.PI * gridDivisor / (minWavelength + rngState.get() * (maxWavelength - minWavelength)));
        generatorParams.push(horizWaveScale * (minAmplitude + rngState.get() * (maxAmplitude - minAmplitude)) / gridDivisor);
        generatorParams.push(rngState.get() * 10);
        generatorParams.push(Math.PI * gridDivisor / (minWavelength + rngState.get() * (maxWavelength - minWavelength)));
        generatorParams.push(vertWaveScale * (minAmplitude + rngState.get() * (maxAmplitude - minAmplitude)) / gridDivisor)
      }
      const vertDisp = [];
      const horizDisp = [];
      const maxMapDim = Math.max(warpMap.gridWidth, warpMap.gridHeight);
      for (let dimIdx = 0; dimIdx < maxMapDim; dimIdx++) {
        let horizOffset = 0;
        let vertOffset = 0;
        for (let genIdx = 0; genIdx < numGenerators; genIdx++) {
          const paramOffset = genIdx * 6;
          horizOffset += generatorParams[paramOffset + 2] * waveFn(generatorParams[paramOffset] + dimIdx * generatorParams[paramOffset + 1]);
          vertOffset += generatorParams[paramOffset + 5] * waveFn(generatorParams[paramOffset + 3] + dimIdx * generatorParams[paramOffset + 4])
        }
        vertDisp[dimIdx] = vertOffset;
        horizDisp[dimIdx] = horizOffset
      }
      for (let mapRow = 0; mapRow < warpMap.gridHeight; mapRow++) {
        for (let mapCol = 0; mapCol < warpMap.gridWidth; mapCol++) {
          const mapOffset = mapRow * warpMap.gridWidth + mapCol << 1;
          warpMap.map[mapOffset] = horizDisp[mapRow];
          warpMap.map[mapOffset + 1] = vertDisp[mapCol]
        }
      }
      edgeMode = filterDescriptor.UndA.v.UndA == "WrpA" ? 2 : 1
    } else if (filterType == "Rple") {
      edgeMode = 1;
      const rippleAmount = filterDescriptor.Amnt.v / 100;
      const kernelSize = 4;
      let rippleKernel = [0, -.19, -.29, -.32, .92, .37, .93, .54, -.54, .42, -.29, -.58, -.67, .85, 0, .64];
      let freqScale = 1;
      let ampScale = 1;
      let kernelPhase = 0;
      const rippleSizeIndex = ["Sml", "Mdm", "Lrg"].indexOf(filterDescriptor.RplS.v.RplS);
      if (rippleSizeIndex == 0) {
        freqScale = 1;
        ampScale = .2;
        kernelPhase = 3
      }
      if (rippleSizeIndex == 2) {
        freqScale = 1;
        ampScale = 2;
        kernelPhase = -1;
        rippleKernel = rippleKernel.reverse()
      }

      const rippleSurface = function(u, n) {
        const cosFn = Math.cos;
        let sum = 0;
        for (let row = 0; row < kernelSize; row++)
          for (let col = 0; col < kernelSize; col++) sum += rippleKernel[row * kernelSize + col] * cosFn(u * (row + kernelPhase) - n * (col + kernelPhase));
        return sum
      };

      const tileSize = Math.floor(50 / gridDivisor);
      const rippleGradientTile = new Float32Array(tileSize * tileSize * 2);
      const gradientScale = ampScale * rippleAmount * .5 / gridDivisor;
      for (let tileRow = 0; tileRow < tileSize; tileRow++)
        for (let tileCol = 0; tileCol < tileSize; tileCol++) {
          const phaseU = freqScale * tileCol * 2 * Math.PI / tileSize;
          const phaseV = freqScale * tileRow * 2 * Math.PI / tileSize;
          const centerValue = rippleSurface(phaseU, phaseV);
          const gradX = (rippleSurface(phaseU + .01, phaseV) - centerValue) * 100;
          const gradY = (rippleSurface(phaseU, phaseV + .01) - centerValue) * 100;
          const tileOffset = (tileRow * tileSize + tileCol) * 2;
          rippleGradientTile[tileOffset] = gradX * gradientScale;
          rippleGradientTile[tileOffset + 1] = gradY * gradientScale
        }
      for (let mapRow = 0; mapRow < warpMap.gridHeight; mapRow++)
        for (let mapCol = 0; mapCol < warpMap.gridWidth; mapCol++) {
          let tileRow = mapRow % tileSize;
          let tileCol = mapCol % tileSize;
          const mapOffset = mapRow * warpMap.gridWidth + mapCol << 1;
          const tileOffset = tileRow * tileSize + tileCol << 1;
          warpMap.map[mapOffset] = rippleGradientTile[tileOffset];
          warpMap.map[mapOffset + 1] = rippleGradientTile[tileOffset + 1]
        }
    }
  }
  applyWarp(sourcePixels.buffer, destPixels.buffer, pixelWidth, pixelHeight, null, warpMap.map, warpMap.gridWidth, warpMap.gridHeight, edgeMode);
  if (filterType == "LnCr") {
    applyLensCorrectionColorEffects(destPixels.buffer, pixelWidth, pixelHeight, filterDescriptor);
    fillUncoveredEdges(destPixels.buffer, filterDescriptor);
  }
}

const filterPixelApplicators = {
  cameraRaw: applyCameraRawFilter,
  "AdNs": applyAddNoiseFilter,
  "Avrg": applyAverageFilter,
  "Bokh": applyBokehFilter,
  "Clds": applyCloudsDifferenceFamily,
  "ClrH": applyColorHalftoneFilter,
  "Crst": applyCrystallizePaintFamily,
  "DfrC": applyCloudsDifferenceFamily,
  "Dfs ": applyDiffuseFilter,
  "Dspc": applyDisplaceEntryFilter,
  "DstS": applyRankFilterFamily,
  "Embs": applyEmbossFilter,
  "Fbrs": applyFibersFilter,
  "FndE": applyFindEdgesFilter,
  "Frgm": applyFragmentFilter,
  "GEfc": applyGalleryEffectsFilter,
  "LnsF": applyLensFlareFilter,
  "Mdn ": applyRankFilterFamily,
  "Mnm ": applyRankFilterFamily,
  "Msc ": applyMosaicFilter,
  "MtnB": applyMotionBlurFilter,
  "Mxm ": applyRankFilterFamily,
  "Mztn": applyMezzotintFilter,
  "Ofst": applyOffsetFilter,
  "Plr ": applyPolarCoordinatesFilter,
  "Pntl": applyCrystallizePaintFamily,
  "RdlB": applyRadialBlurFilter,
  "ShrE": applyShearEntryFilter,
  "Slrz": applySolarizeFilter,
  "TrcC": applyTraceContourFilter,
  "Wnd ": applyWindFilter,
  "adaptCorrect": applyAdaptCorrectFilter,
  "lightFilterGradient": applyLightFilterGradient,
  "oilPaint": applyOilPaintFilter,
  "rigidTransform": applyRigidTransformFilter,
  "surfaceBlur": applySurfaceBlurFilter
};

function registerFilterApplicators(filterTypes, applicator) {
  for (let typeIdx = 0; typeIdx < filterTypes.length; typeIdx++) {
    filterPixelApplicators[filterTypes[typeIdx]] = applicator;
  }
}

registerFilterApplicators(blurSharpenFilterTypes, applyBlurSharpenFamily);
registerFilterApplicators(presetKernelFilterTypes, applyPresetKernelFilter);
registerFilterApplicators(warpFilterTypes, applyWarpFamilyFilter);

FilterDefs.applyFilterToPixels = function(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext) {
  filterType = normalizeCameraRawClassId(filterType);
  destPixels = ensureFilterDestination(sourcePixels, destPixels);
  filterDescriptor = mergeFilterDescriptorDefaults(filterType, filterDescriptor);
  const applyFilter = filterPixelApplicators[filterType];
  if (applyFilter) applyFilter(filterType, sourcePixels, filterDescriptor, fgRgb, bgRgb, destPixels, filterContext);
  return destPixels
};
export { FilterDefs };
