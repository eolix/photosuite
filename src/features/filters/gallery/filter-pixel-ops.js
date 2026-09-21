/**
 * Filter Gallery pixel kernels: per-filter scanline ops over `PixelEngine` buffers.
 * `KERNELS` is the dispatch table shared with `FilterBandRunner` workers so
 * multi-threaded bands match single-threaded output.
 */

import { PixelEngine } from './pixel-engine.js';
import { applyCutout } from '../../../engine/compositing/cutout-filter.js';


// Convolution helpers for edge-style gallery kernels.
function normalizeKernelWeights(weights) {
    const normalized = weights.slice(0);
    let weightSum = 0;
    for (let i = 0; i < weights.length; i++) weightSum += weights[i];
    for (let i = 0; i < normalized.length; i++) normalized[i] /= weightSum;
    return normalized;
}

function sampleChannelKernel3x3(channel, centerIndex, width, kernel) {
  return channel[centerIndex - width - 1] * kernel[0] + channel[centerIndex - width] * kernel[1] + channel[centerIndex - width + 1] * kernel[2] + channel[centerIndex - 1] * kernel[3] + channel[centerIndex] * kernel[4] + channel[centerIndex + 1] * kernel[5] + channel[centerIndex + width - 1] * kernel[6] + channel[centerIndex + width] * kernel[7] + channel[centerIndex + width + 1] * kernel[8];
}

function convolveChannelInterior(sourceChannel, destChannel, width, height, kernel, useAbsolute) {
  destChannel = new Uint8ClampedArray(destChannel.buffer);
  for (let row = 1; row < height - 1; row++)
    for (let col = 1; col < width - 1; col++) {
        const centerIndex = row * width + col;
        let sample = sampleChannelKernel3x3(sourceChannel, centerIndex, width, kernel);
        if (useAbsolute) {
          if (sample < 0) sample = -sample
        }
        destChannel[centerIndex] = ~~(sample + .5)
    }
}

function rgbaBitDepth(buffer) {
  return buffer instanceof Float32Array ? 32 : buffer instanceof Uint16Array ? 16 : 8;
}

function maxValueForBitDepth(bitDepth) {
  return bitDepth == 8 ? 255 : bitDepth == 16 ? 65535 : 1;
}

function convolveRgba(sourceRgba, destRgba, width, height, kernel, writeAlpha, useAbsolute) {
    if (useAbsolute == null) useAbsolute = false;
    const kernelSize = Math.floor(Math.sqrt(kernel.length));
    const kernelRadius = kernelSize - 1 >>> 1;
    const bitDepth = rgbaBitDepth(sourceRgba);
    const maxChannel = maxValueForBitDepth(bitDepth);
    const sourceWords = new Uint32Array(sourceRgba.buffer);
    const destBytes = new Uint8ClampedArray(destRgba.buffer);
    for (let row = 0; row < height; row++)
      for (let col = 0; col < width; col++) {
          let sumR = 0;
          let sumG = 0;
          let sumB = 0;
          let sumA = 0;
          for (let ky = 0; ky < kernelSize; ky++)
            for (let kx = 0; kx < kernelSize; kx++) {
                const weight = kernel[ky * kernelSize + kx];
                if (weight == 0) continue;
                let sampleCol = col - kernelRadius + kx;
                let sampleRow = row - kernelRadius + ky;
                if (sampleCol < 0) sampleCol = 0;
                else if (sampleCol > width - 1) sampleCol = width - 1;
                if (sampleRow < 0) sampleRow = 0;
                else if (sampleRow > height - 1) sampleRow = height - 1;
                if (bitDepth == 8) {
                  const packed = sourceWords[sampleRow * width + sampleCol];
                  sumR += (packed & 255) * weight;
                  sumG += (packed >>> 8 & 255) * weight;
                  sumB += (packed >>> 16 & 255) * weight;
                  sumA += (packed >>> 24 & 255) * weight
                } else {
                  const rgbaIndex = sampleRow * width + sampleCol << 2;
                  sumR += sourceRgba[rgbaIndex] * weight;
                  sumG += sourceRgba[rgbaIndex + 1] * weight;
                  sumB += sourceRgba[rgbaIndex + 2] * weight;
                  sumA += sourceRgba[rgbaIndex + 3] * weight
                }
            }
          if (useAbsolute) {
            if (sumR < 0) sumR = -sumR;
            if (sumG < 0) sumG = -sumG;
            if (sumB < 0) sumB = -sumB;
            if (sumA < 0) sumA = -sumA
          }
          const outIndex = row * width + col << 2;
          if (bitDepth == 8) {
            destBytes[outIndex] = ~~(.5 + sumR);
            destBytes[outIndex + 1] = ~~(.5 + sumG);
            destBytes[outIndex + 2] = ~~(.5 + sumB);
            if (writeAlpha) destBytes[outIndex + 3] = ~~(.5 + sumA)
          } else {
            destRgba[outIndex] = Math.max(0, Math.min(maxChannel, sumR));
            destRgba[outIndex + 1] = Math.max(0, Math.min(maxChannel, sumG));
            destRgba[outIndex + 2] = Math.max(0, Math.min(maxChannel, sumB));
            if (writeAlpha) destRgba[outIndex + 3] = Math.max(0, Math.min(maxChannel, sumA))
          }
      }
}

function sobelMagnitudeChannel(sourceChannel, destChannel, width, height) {
    const channelLength = sourceChannel.length;
    const scratch = new Uint8Array(channelLength);
    convolveChannelInterior(sourceChannel, destChannel, width, height, SOBEL_KERNELS[0], true);
    convolveChannelInterior(sourceChannel, scratch, width, height, SOBEL_KERNELS[1], true);
    for (let i = 0; i < channelLength; i++) {
        const gx = destChannel[i];
        const gy = scratch[i];
        destChannel[i] = 255 - Math.max(0, Math.min(255, Math.sqrt(gx * gx + gy * gy)))
    }
}

const BLUR_KERNEL_SOFT = normalizeKernelWeights([1, 2, 1, 2, 16, 2, 1, 2, 1]);
const BLUR_KERNEL_MEDIUM = normalizeKernelWeights([1, 2, 1, 2, 4, 2, 1, 2, 1]);
const SHARPEN_KERNEL = normalizeKernelWeights([0, -1, 0, -1, 8, -1, 0, -1, 0]);
const SHARPEN_KERNEL_SOFT = normalizeKernelWeights([-.7, -1, -.7, -1, 10, -1, -.7, -1, -.7]);
const SOBEL_KERNELS = [
  [-1, 0, 1, -2, 0, 2, -1, 0, 1],
  [1, 2, 1, 0, 0, 0, -1, -2, -1]
];
const PRESET_CONVOLVE_KERNELS = [BLUR_KERNEL_SOFT, BLUR_KERNEL_MEDIUM, SHARPEN_KERNEL, SHARPEN_KERNEL_SOFT, SOBEL_KERNELS[0], SOBEL_KERNELS[1]];

function applyEdgeQuantizePasses(sourceChannel, scratchChannel, engine, passCount) {
    let inputPlane = sourceChannel;
    let outputPlane = scratchChannel;
    for (let passIdx = 0; passIdx < passCount; passIdx++) {
      FilterPixelOps.edgeQuantize(inputPlane, outputPlane, engine);
      let swap = inputPlane;
      inputPlane = outputPlane;
      outputPlane = swap
    }
    return inputPlane;
}

export const FilterPixelOps = {};

FilterPixelOps.accentedEdges = function (src, width, height, dst, params) {
    const edgeWidth = params[0] + 1;
    const edgeBrightness = params[1];
    const brightnessScale = Math.abs(edgeBrightness - 25) / 4;
    const smoothness = params[2];
    const medianRank = smoothness % 2 + smoothness * smoothness >> 1;
    const engine = PixelEngine;
    engine.init(width, height);
    const valuePlane = engine.allocArray(1);
    const lowMedian = engine.allocArray(1);
    const highMedian = engine.allocArray(1);
    engine.medianBlurHRGBA(src, dst, smoothness, smoothness, medianRank);
    engine.rgbToHSV(dst);
    engine.readChannel(dst, valuePlane);
    engine.medianBlurH(valuePlane, lowMedian, edgeWidth, edgeWidth, 1);
    engine.medianBlurH(valuePlane, highMedian, edgeWidth, edgeWidth, edgeWidth * edgeWidth);
    engine.subtract(highMedian, lowMedian);
    engine.multiplyScalar(lowMedian, brightnessScale);
    (edgeBrightness < 25 ? engine.subtract : engine.add)(valuePlane, lowMedian);
    engine.writeChannel(lowMedian, dst);
    engine.hsvToRGB(dst)
};
FilterPixelOps.angledStrokes = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const threshold = params[0] * 2.55;
    const strokeLength = params[1];
    const medianRank = strokeLength >> 1;
    const sharpenAmount = params[2] * .25;
    const lightStrokes = engine.allocArray(4);
    const grayPlane = engine.allocArray(1);
    const edgeMask = engine.allocArray(1);
    engine.medianBlurRGBA(src, lightStrokes, strokeLength, 1, true, medianRank);
    engine.medianBlurRGBA(src, dst, strokeLength, 1, false, medianRank);
    engine.rgbaToGray(src, grayPlane);
    engine.threshold(grayPlane, threshold);
    engine.boxBlur(grayPlane, edgeMask, 3);
    engine.blendRGBAByMask(dst, edgeMask, lightStrokes);
    engine.sharpenRGBA(lightStrokes, dst, sharpenAmount);
};
FilterPixelOps.chalkCharcoal = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    engine.seedRandom(params[3]);
    const chalkLevels = params[0] * -3 + 80;
    const charcoalLevels = params[1] * -3 + 80;
    const strength = params[2] / 2 + .5;
    const charcoalColor = params[4];
    const chalkColor = params[5];
    const charcoalMask = engine.allocArray(1);
    const chalkMask = engine.allocArray(1);
    const scratchA = engine.allocArray(1);
    const scratchB = engine.allocArray(1);
    const chalkRgba = engine.allocArray(4);
    const charcoalRgba = engine.allocArray(4);
    engine.rgbaToGray(src, charcoalMask);
    engine.copyArray(charcoalMask, chalkMask);
    engine.applyLevels(charcoalMask, charcoalLevels, 5);
    engine.randomReplace(charcoalMask, .4, 0);
    engine.boxBlur(charcoalMask, scratchA, 3);
    engine.medianBlurChan(scratchA, charcoalMask, 9, 3, true, 27);
    engine.copyArray(chalkMask, scratchA);
    engine.invertChannel(scratchA);
    const chalkLut = engine.computeLevelLUT(chalkLevels, 5, scratchA);
    for (let n = 0; n < engine.pixelCount; n++) {
        chalkMask[n] = chalkLut[255 - chalkMask[n]];
    }
    engine.randomReplace(chalkMask, .4, 0);
    engine.copyArray(chalkMask, scratchA);
    engine.boxBlur(scratchA, scratchB, 2);
    engine.medianBlurChan(scratchB, scratchA, 5, 3, false, 15);
    engine.multiplyScalar(charcoalMask, strength);
    engine.multiplyScalar(scratchA, strength);
    engine.fillColor(dst, 2155905279);
    engine.fillColor(charcoalRgba, charcoalColor);
    engine.fillColor(chalkRgba, chalkColor);
    engine.blendRGBAByMask(charcoalRgba, charcoalMask, dst);
    engine.blendRGBAByMask(chalkRgba, scratchA, dst);
};
FilterPixelOps.charcoal = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const contrastLut = new Uint8Array(256);
    let contrastSpread = 5 + 10 * params[1];
    contrastSpread += params[1] > 3 ? (params[1] - 3) * 10 : 0;
    const midpoint = ~~(params[2] * .73) + 50;
    const upper = Math.min(midpoint + contrastSpread, 128);
    const range = upper - midpoint;
    let lutAccum = -255 * midpoint;
    for (let n = 0; n < 256; n++) {
        contrastLut[n] = engine.clamp(lutAccum / range);
        lutAccum += 255;
    }
    const grayPlane = engine.allocArray(1);
    const blurScratch = engine.allocArray(1);
    const grayCopy = engine.allocArray(1);
    engine.rgbaToGray(src, grayPlane);
    engine.copyArray(grayPlane, grayCopy);
    engine.boxBlur(grayPlane, blurScratch, 2 * params[0] + 1);
    engine.subtract(blurScratch, grayPlane);
    engine.multiplyScalar(grayPlane, 65);
    engine.medianBlurChan(grayPlane, blurScratch, 9, 3, true, 20);
    for (let n = 0; n < engine.pixelCount; n++) {
        const origGray = grayCopy[n];
        const detail = blurScratch[n];
        grayPlane[n] = detail > 0 ? ~~((detail * origGray + (255 - detail) * 128) / 255) : 128;
    }
    engine.boxBlur(grayPlane, blurScratch, 3);
    engine.medianBlurChan(blurScratch, grayPlane, 15, 2, true, 16);
    engine.medianBlurChan(blurScratch, grayCopy, 15, 2, false, 15);
    engine.average(grayPlane, grayCopy);
    engine.sharpenChan(grayCopy, blurScratch, 2);
    engine.applyLUT(blurScratch, contrastLut);
    engine.boxBlur(blurScratch, grayPlane, 2);
    engine.writeOutput(grayPlane, dst);
};
FilterPixelOps.colorPencil = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const blurSize = 2 * params[0] + 1;
    const strokePressure = engine.blurAmounts[params[1]];
    const paperValue = params[2] * 5.1;
    const paperColor = params[3];
    const detailMask = engine.allocArray(1);
    const grayPlane = engine.allocArray(1);
    const workRgba = engine.allocArray(4);
    const smoothScratch = engine.allocArray(4);
    engine.fillColor(workRgba, paperColor);
    engine.rgbToHSV(workRgba, dst);
    engine.fillScalar(detailMask, paperValue);
    engine.writeChannel(detailMask, dst);
    engine.hsvToRGB(dst, workRgba);
    engine.rgbaToGray(src, grayPlane);
    engine.boxBlur(grayPlane, detailMask, blurSize);
    engine.subtract(detailMask, grayPlane);
    engine.multiplyScalar(grayPlane, strokePressure);
    engine.medianBlurChan(grayPlane, detailMask, 9, 3, true, 20);
    engine.blendRGBAByMask(src, detailMask, workRgba);
    engine.boxBlurRGBA(workRgba, dst, 3);
    engine.medianBlurRGBA(dst, workRgba, 15, 2, true, 16);
    engine.medianBlurRGBA(dst, smoothScratch, 15, 2, false, 16);
    engine.average(workRgba, smoothScratch);
    engine.sharpenRGBA(smoothScratch, dst, 2);
};
FilterPixelOps.conteCreyon = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const foregroundPressure = (15 - params[0]) / 4 + 1;
    const backgroundPressure = (15 - params[1]) / 4 + 1;
    const patternId = params[2];
    const patternScale = params[3];
    const blurFactor = engine.blurFactor(params[4]);
    const directionCount = params[5] + 1;
    const patternParam = params[6];
    const backgroundColor = params[7];
    const foregroundColor = params[8];
    const blurScratch = engine.allocArray(1);
    const backgroundStroke = engine.allocArray(1);
    const patternPlane = engine.allocArray(1);
    const foregroundStroke = engine.allocArray(1);
    const highlightRgba = engine.allocArray(4);
    const backgroundRgba = engine.allocArray(4);
    engine.applyPattern(patternPlane, patternId, patternScale, patternParam);
    engine.rgbaToGray(src, backgroundStroke);
    engine.boxBlur(backgroundStroke, blurScratch, 5);
    engine.applyDirKernel(patternPlane, blurScratch, foregroundStroke, directionCount, blurFactor);
    engine.multiplyScalar(foregroundStroke, foregroundPressure);
    engine.invertScale(foregroundStroke, 2);
    engine.invertChannel(blurScratch);
    engine.applyDirKernel(patternPlane, blurScratch, backgroundStroke, directionCount, blurFactor);
    engine.multiplyScalar(backgroundStroke, backgroundPressure);
    engine.invertScale(backgroundStroke, 2);
    engine.fillColor(highlightRgba, 2155905279);
    engine.fillColor(backgroundRgba, backgroundColor);
    engine.fillColor(dst, foregroundColor);
    engine.blendRGBAByMask(highlightRgba, backgroundStroke, backgroundRgba);
    engine.blendRGBAByMask(backgroundRgba, foregroundStroke, dst);
};
FilterPixelOps.craquelure = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    engine.seedRandom(params[3]);
    const gridSize = params[0];
    const highlightStrength = params[1] / 10;
    const shadowStrength = params[2] / 10;
    const workPlane = engine.allocArray(1);
    const scratchPlane = engine.allocArray(1);
    const maxChanCopy = engine.allocArray(1);
    const noiseGradients = engine.allocInt32();
    const imageGradients = engine.allocInt32();
    const gradientScratch = engine.allocInt32();
    engine.randomFill(workPlane);
    engine.boxBlur(workPlane, scratchPlane, 11);
    engine.boxBlur(scratchPlane, workPlane, 11);
    engine.computeGradients(workPlane, noiseGradients);
    engine.rgbaMaxChan(src, workPlane);
    engine.copyArray(workPlane, maxChanCopy);
    engine.boxBlur(workPlane, scratchPlane, 9);
    engine.boxBlur(scratchPlane, workPlane, 9);
    engine.computeGradients(workPlane, imageGradients);
    engine.boxBlurRG(imageGradients, gradientScratch, 5);
    engine.boxBlurRG(gradientScratch, imageGradients, 5);
    engine.addCoordBias(noiseGradients, .8);
    engine.blendCoords(noiseGradients, imageGradients, .8, .9);
    engine.buildGrid(imageGradients, workPlane, gridSize);
    engine.medianBlurH(workPlane, scratchPlane, 2, 2, 1);
    engine.medianBlurH(scratchPlane, workPlane, 2, 2, 3);
    engine.medianBlurH(workPlane, scratchPlane, 2, 2, 3);
    engine.medianBlurH(maxChanCopy, workPlane, 5, 5, 13);
    engine.screenBlend(scratchPlane, workPlane, scratchPlane, highlightStrength);
    engine.multiplyBlend(workPlane, scratchPlane, scratchPlane, shadowStrength);
    engine.applyDirKernel(scratchPlane, scratchPlane, workPlane, 5, 1);
    engine.rgbToHSV(src, dst);
    engine.writeChannel(workPlane, dst);
    engine.hsvToRGB(dst);
};
FilterPixelOps.crosshatch = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const strokeLength = params[0];
    const sharpenAmount = params[1] / 2;
    const passCount = params[2];
    const medianRank = strokeLength / 2;
    const lightStrokes = engine.allocArray(4);
    const darkStrokes = engine.allocArray(4);
    engine.copyArray(src, dst);
    for (let passIdx = 0; passIdx < passCount; passIdx++) {
        engine.medianBlurRGBA(dst, lightStrokes, strokeLength, 1, true, medianRank);
        engine.medianBlurRGBA(dst, darkStrokes, strokeLength, 1, false, medianRank);
        engine.average(darkStrokes, lightStrokes);
        engine.boxBlurRGBA(lightStrokes, darkStrokes, 2);
        engine.sharpenRGBA(darkStrokes, dst, sharpenAmount);
    }
};
FilterPixelOps.darkStrokes = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const percentile = params[0] * 10;
    const levelBlack = params[1] * 4.9;
    const levelWhite = params[2] * 4.9;
    const grayPlane = engine.allocArray(1);
    const edgeMask = engine.allocArray(1);
    const lightMedian = engine.allocArray(4);
    engine.rgbaToGray(src, grayPlane);
    engine.threshold(grayPlane, engine.findPercentile(grayPlane, percentile));
    engine.boxBlur(grayPlane, edgeMask, 3);
    engine.medianBlurRGBA(src, lightMedian, 5, 1, false, 1);
    engine.medianBlurRGBA(src, dst, 15, 2, true, 16);
    engine.blendRGBAByMask(dst, edgeMask, lightMedian);
    engine.rgbToHSV(lightMedian, dst);
    engine.readChannel(dst, grayPlane);
    engine.applyLevels(grayPlane, levelBlack, levelWhite);
    engine.writeChannel(grayPlane, dst);
    engine.hsvToRGB(dst);
};
FilterPixelOps.diffuseGlow = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    engine.seedRandom(params[4]);
    const grainScale = params[0] / 20;
    const glowAmount = [0, .75, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.45, 1.5, 1.6, 1.7, 1.8, 2, 2.5, 3, 3.5, 4][params[1]];
    const clearAmount = [0, .25, .5, .75, .9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.25, 2.5, 3, 3.5, 4][params[2]];
    const glowColor = params[3];
    const grainOffsetLut = new Int16Array(256);
    for (let n = 0; n < 256; n++) {
        grainOffsetLut[n] = ~~((n - 128) * grainScale);
    }
    const grayPlane = engine.allocArray(1);
    const glowMask = engine.allocArray(1);
    const glowRgba = engine.allocArray(4);
    engine.rgbaToGray(src, grayPlane);
    engine.boxBlur(grayPlane, glowMask, 25);
    engine.multiplyScalar(glowMask, glowAmount);
    engine.invertScale(glowMask, clearAmount);
    engine.boxBlur(glowMask, grayPlane, 25);
    engine.randomFill(glowMask);
    engine.applyLUTOffset(grayPlane, glowMask, grainOffsetLut);
    engine.copyArray(src, dst);
    engine.fillColor(glowRgba, glowColor);
    engine.blendRGBAByMask(glowRgba, grayPlane, dst);
};
FilterPixelOps.dryBrush = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const detailSize = params[0] + 5;
    const brushSize = 15 - params[1];
    const detailRank = detailSize * detailSize / 2;
    const texture = 1 - (3 - params[2]) / 10;
    const lightRank = ~~(brushSize * brushSize * texture - 1);
    let darkRank = ~~(brushSize * brushSize * (1 - texture));
    if (darkRank == 0) darkRank = 1;
    const detailMedian = engine.allocArray(1);
    const blurredGray = engine.allocArray(1);
    const grayPlane = engine.allocArray(1);
    const lightBrushRgba = engine.allocArray(4);
    engine.rgbaToGray(src, grayPlane);
    engine.medianBlurH(grayPlane, detailMedian, detailSize, detailSize, detailRank);
    engine.boxBlur(grayPlane, blurredGray, detailSize);
    engine.subtract(detailMedian, blurredGray);
    engine.threshold(blurredGray, 1);
    engine.medianBlurHRGBA(src, lightBrushRgba, brushSize, brushSize, lightRank);
    engine.medianBlurHRGBA(src, dst, brushSize, brushSize, darkRank);
    engine.blendRGBAByMask(lightBrushRgba, blurredGray, dst);
};
FilterPixelOps.filmGrain = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    engine.seedRandom(params[3]);
    const grainScale = (20 - params[0]) * .05;
    const levelBlack = params[1] * -2.75 + 60;
    const levelWhite = 65 - levelBlack;
    const grainPlane = engine.allocArray(1);
    const valuePlane = engine.allocArray(1);
    engine.rgbaMaxChan(src, valuePlane);
    const levelLut = engine.computeLevelLUT(levelBlack, levelWhite, valuePlane);
    engine.rgbToHSV(src, dst);
    engine.readChannel(dst, valuePlane);
    engine.randomFill(grainPlane);
    engine.scalePreserve(valuePlane, grainPlane, grainScale);
    engine.applyLUT(valuePlane, levelLut);
    engine.multiplyScalar(valuePlane, params[2] / 10);
    engine.add(grainPlane, valuePlane);
    engine.writeChannel(valuePlane, dst);
    engine.hsvToRGB(dst);
};
FilterPixelOps.fresco = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const detailSize = 5 + params[0];
    const brushSize = 15 - params[1];
    const detailRank = detailSize * detailSize / 2 + detailSize * detailSize % 2 * 1;
    const texture = 1 - (3 - params[2]) / 10;
    const lightRank = ~~(brushSize * brushSize * texture - 1);
    let darkRank = ~~(brushSize * brushSize * (1 - texture));
    if (darkRank == 0) darkRank = 1;
    const detailMedian = engine.allocArray(1);
    const maxChan = engine.allocArray(1);
    const darkBrush = engine.allocArray(1);
    const edgeMask = engine.allocArray(1);
    const blurredBase = engine.allocArray(1);
    engine.rgbaMaxChan(src, maxChan);
    engine.sharpenChan(maxChan, detailMedian, 3);
    engine.medianBlurH(detailMedian, maxChan, 2, 2, 1);
    const contrastLut = engine.computeLevelLUT(20, 20, maxChan);
    engine.applyLUT(maxChan, contrastLut);
    engine.boxBlur(maxChan, blurredBase, 5);
    engine.medianBlurH(blurredBase, detailMedian, detailSize, detailSize, detailRank);
    engine.medianBlurH(blurredBase, maxChan, brushSize, brushSize, lightRank);
    engine.medianBlurH(blurredBase, darkBrush, brushSize, brushSize, darkRank);
    engine.boxBlur(blurredBase, edgeMask, detailSize);
    engine.subtract(detailMedian, edgeMask);
    engine.threshold(edgeMask, 1);
    engine.blendByMask(maxChan, edgeMask, darkBrush);
    engine.rgbToHSV(src, dst);
    engine.writeChannel(darkBrush, dst);
    engine.hsvToRGB(dst);
};
FilterPixelOps.grain = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    engine.seedRandom(params[5]);
    const pixelCount = engine.pixelCount;
    const rgbaLen = engine.rgbaLen;
    const intensity = params[0];
    const grainType = params[1];
    const contrast = params[2];
    const grainColor = params[3];
    const highlightColor = params[4];
    const sharpenAmount = .05 * intensity + 1;
    const intensityFrac = intensity / 100;
    const noiseSpread = intensity >> 1;
    const speckleBias = 2 * intensity - 100;
    const isVerticalType = +(grainType == 9);
    const brightnessMid = [50, 75][isVerticalType];
    const medianRank = [4, 1][isVerticalType];
    const medianSize = [3, 2][isVerticalType];
    const brightnessContrast = grainType < 4 ? contrast : (contrast >> 1) + 50;
    const brightnessLut = engine.buildBrightnessLUT(brightnessMid, brightnessContrast);
    const grainRgb = engine.unpackARGB(grainColor);
    const highlightRgb = engine.unpackARGB(highlightColor);
    const scratchRgbaA = engine.allocArray(4);
    const scratchRgbaB = engine.allocArray(4);
    const scratchChanA = engine.allocArray(1);
    const scratchChanB = engine.allocArray(1);

    function applyBrightness(rgba) {
        if (brightnessContrast != 50) {
            engine.applyLUTToRGBA(rgba, brightnessLut);
        }
    }

    function addNoiseChannel(chan, noise) {
        for (let n = 0; n < pixelCount; n++) {
            chan[n] = engine.clamp(chan[n] + (noise[n] - 128) * intensityFrac);
        }
    }

    function addNoiseRgb(rgba, noise) {
        for (let n = 0, off = 0; n < pixelCount; n++) {
            rgba[off] = engine.clamp(rgba[off] + (noise[off] - 128) * intensityFrac);
            rgba[off + 1] = engine.clamp(rgba[off + 1] + (noise[off + 1] - 128) * intensityFrac);
            rgba[off + 2] = engine.clamp(rgba[off + 2] + (noise[off + 2] - 128) * intensityFrac);
            off += 4;
        }
    }

    function grainRegular(srcRgba, dstRgba) {
        engine.randomFill(scratchRgbaB);
        engine.copyArray(srcRgba, dstRgba);
        addNoiseRgb(dstRgba, scratchRgbaB);
        applyBrightness(dstRgba);
    }

    function gaussianNoiseSample(value) {
        let sum = 0;
        for (let noiseSampleIdx = 0; noiseSampleIdx < 12; noiseSampleIdx++) sum += engine.random();
        return engine.clamp(noiseSpread * (sum - 6) + value);
    }

    function grainSoft(srcRgba, dstRgba) {
        engine.copyArray(srcRgba, dstRgba);
        for (let off = 0; off < rgbaLen; off += 4) {
            dstRgba[off] = gaussianNoiseSample(dstRgba[off]);
            dstRgba[off + 1] = gaussianNoiseSample(dstRgba[off + 1]);
            dstRgba[off + 2] = gaussianNoiseSample(dstRgba[off + 2]);
        }
        applyBrightness(dstRgba);
    }

    function grainSprinkle(srcRgba, dstRgba) {
        engine.copyArray(srcRgba, dstRgba);
        for (let off = 0; off < rgbaLen; off += 4) {
            if (engine.random() < intensityFrac) {
                dstRgba[off] = grainRgb[0];
                dstRgba[off + 1] = grainRgb[1];
                dstRgba[off + 2] = grainRgb[2];
            }
        }
        applyBrightness(dstRgba);
    }

    function grainClumped(srcRgba, dstRgba) {
        engine.randomFill(scratchRgbaA);
        engine.medianBlurHRGBA(scratchRgbaA, scratchRgbaB, medianSize, medianSize, medianRank);
        engine.copyArray(srcRgba, scratchRgbaA);
        addNoiseRgb(scratchRgbaA, scratchRgbaB);
        engine.medianBlurHRGBA(scratchRgbaA, dstRgba, 5, 5, 13);
        applyBrightness(dstRgba);
    }

    function grainContrasty(srcRgba, dstRgba) {
        engine.randomFill(scratchRgbaB);
        engine.copyArray(srcRgba, scratchRgbaA);
        addNoiseRgb(scratchRgbaA, scratchRgbaB);
        applyBrightness(dstRgba);
        engine.medianBlurHRGBA(scratchRgbaA, dstRgba, medianSize, medianSize, medianRank);
    }

    function grainSpeckle(srcRgba, dstRgba) {
        engine.copyArray(srcRgba, scratchRgbaA);
        applyBrightness(dstRgba);
        engine.rgbaToGray(scratchRgbaA, scratchChanA);
        for (let n = 0, off = 0; n < pixelCount; n++) {
            const threshold = ((speckleBias - scratchChanA[n] + 255) * 128.5 + .5) / 32767;
            if (engine.random() <= threshold) {
                dstRgba[off++] = highlightRgb[0];
                dstRgba[off++] = highlightRgb[1];
                dstRgba[off++] = highlightRgb[2];
            } else {
                dstRgba[off++] = grainRgb[0];
                dstRgba[off++] = grainRgb[1];
                dstRgba[off++] = grainRgb[2];
            }
            dstRgba[off] = srcRgba[off];
            off++;
        }
    }

    function grainEnlarged(srcRgba, dstRgba) {
        engine.rgbToHSV(srcRgba, dstRgba);
        engine.readChannel(dstRgba, scratchChanA);
        engine.sharpenChan(scratchChanA, scratchChanB, sharpenAmount);
        engine.medianBlurH(scratchChanB, scratchChanA, medianSize, medianSize, medianRank);
        engine.applyLUT(scratchChanA, brightnessLut);
        engine.writeChannel(scratchChanA, dstRgba);
        engine.hsvToRGB(dstRgba);
    }

    function fillStreakNoise(chan) {
        let writeOff = 0;
        if (grainType == 8) {
            for (let col = 0; col < width; col++) {
                chan[writeOff++] = ~~(engine.random() * 255);
            }
            for (let row = 1; row < height; row++) {
                for (let col = 0; col < width; col++) {
                    chan[writeOff++] = chan[col];
                }
            }
        } else {
            for (let row = 0; row < height; row++) {
                const randomGray = ~~(engine.random() * 255);
                for (let col = 0; col < width; col++) {
                    chan[writeOff++] = randomGray;
                }
            }
        }
    }

    function grainStreak(srcRgba, dstRgba) {
        engine.rgbaToGray(srcRgba, scratchChanA);
        engine.randomFill(scratchChanB);
        addNoiseChannel(scratchChanA, scratchChanB);
        fillStreakNoise(scratchChanB);
        addNoiseChannel(scratchChanA, scratchChanB);
        engine.boxBlurRGBA(srcRgba, scratchRgbaA, 9);
        engine.boxBlurRGBA(scratchRgbaA, scratchRgbaB, 9);
        engine.boxBlur(scratchChanA, scratchChanB, 2);
        engine.applyLUT(scratchChanB, brightnessLut);
        engine.boxBlur(scratchChanB, scratchChanA, 2);
        engine.rgbToHSV(scratchRgbaB, dstRgba);
        engine.writeChannel(scratchChanA, dstRgba);
        engine.hsvToRGB(dstRgba);
    }

    [grainRegular, grainSoft, grainSprinkle, grainClumped, grainClumped, grainContrasty, grainSpeckle, grainStreak, grainStreak, grainEnlarged][grainType](src, dst);
};
FilterPixelOps.graphicPen = function (src, width, height, dst, params) {
    const DENSITY_LUT = [-1e3, 34, 51, 61, 71, 80, 87, 95, 101, 108, 113, 119, 124, 129, 134, 139, 143, 148, 153, 157, 161, 165, 168, 172, 175, 180, 183, 186, 190, 194, 197, 200, 203, 207, 210, 213, 216, 218, 222, 225, 228, 230, 233, 236, 239, 241, 244, 247, 250, 252, 255];
    const engine = PixelEngine;
    const BLACK = 0;
    const PEN_ON = 1;
    const WHITE = 255;
    engine.init(width, height);
    engine.seedRandom(params[3]);
    const grayChan = engine.allocArray(1);
    const penChannel = engine.allocArray(1);
    engine.rgbaToGray(src, grayChan);
    const strokeLength = params[0];
    const density = params[1];
    const densityThreshold = density <= 50 ? DENSITY_LUT[density] / 255 : 1 + (255 - DENSITY_LUT[101 - density]) / 255;
    const direction = params[2];
    const normalizedGray = new Float32Array(grayChan.length);
    const randomScale = 1 + 1 / 10 * strokeLength;
    const randomOffset = (1 - 1 / randomScale) / 2;
    const valueThreshold = 16 / 256;
    const lastCol = width - 1;
    let streakCounter = 0;
    let penValue;
    let prevGray;
    for (let n = 0; n < engine.pixelCount; n++) {
        normalizedGray[n] = grayChan[n] / 255;
        penChannel[n] = strokeLength == 1 ? engine.random() < 1 / 255 ? WHITE : PEN_ON : PEN_ON;
    }

    // Advance the pen along a scan direction: at each still-blank pixel, decide
    // black/white from a density-weighted random, and hold that value for a
    // random streak length while the gray stays roughly constant.
    function penStep(row, col) {
        const index = row * width + col;
        if (penChannel[index] != PEN_ON || row >= height || col >= width) {
            return;
        }
        const gray = normalizedGray[index];
        const delta = densityThreshold - gray;
        const roll = engine.random();
        const scaledRoll = roll / randomScale + randomOffset;
        if (streakCounter == 0 || Math.abs(prevGray - gray) > valueThreshold) {
            penValue = scaledRoll <= delta ? BLACK : WHITE;
            streakCounter = ~~(engine.random() * strokeLength);
        } else if (.1 < roll) {
            streakCounter--;
        } else {
            streakCounter = 0;
        }
        penChannel[index] = penValue;
        prevGray = gray;
    }
    if (direction == 0) {
        for (let line = 0; line < width; line++) {
            for (let step = 0; step < width; step++) {
                const sum = line + step;
                if (sum >= width) break;
                penStep(step, lastCol - sum);
            }
            streakCounter = 0;
        }
        for (let line = 1; line < height; line++) {
            for (let step = 0; step < height; step++) {
                const sum = line + step;
                if (sum >= height || step >= width) break;
                penStep(sum, lastCol - step);
            }
            streakCounter = 0;
        }
    } else if (direction == 1) {
        for (let line = 0; line < height; line++) {
            for (let step = 0; step < width; step++) {
                penStep(line, step);
            }
            streakCounter = 0;
        }
    } else if (direction == 2) {
        for (let line = 0; line < width; line++) {
            for (let step = 0; step < width; step++) {
                const sum = line + step;
                if (sum >= width) break;
                penStep(step, sum);
            }
            streakCounter = 0;
        }
        for (let line = 1; line < height; line++) {
            for (let step = 0; step < height; step++) {
                const sum = line + step;
                if (sum >= height || step >= width) break;
                penStep(sum, step);
            }
            streakCounter = 0;
        }
    } else {
        for (let line = 0; line < width; line++) {
            for (let step = 0; step < height; step++) {
                penStep(step, line);
            }
            streakCounter = 0;
        }
    }
    engine.writeOutput(penChannel, dst);
};
FilterPixelOps.inkOutlines = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const strokeLength = params[0];
    const levelBlack = params[1];
    const levelWhite = params[2];
    const grayPlane = engine.allocArray(1);
    const lightMedian = engine.allocArray(1);
    const edgeMedian = engine.allocArray(1);
    const alphaChan = engine.allocArray(1);
    const lightStrokeRgba = engine.allocArray(4);
    const whiteRgba = engine.allocArray(4);
    engine.readChannel(src, alphaChan, 3, 4);
    engine.rgbaToGray(src, grayPlane);
    engine.medianBlurH(grayPlane, lightMedian, 3, 3, 1);
    engine.medianBlurH(grayPlane, edgeMedian, 3, 3, 9);
    engine.subtract(edgeMedian, lightMedian);
    engine.boxBlur(lightMedian, grayPlane, 3);
    engine.applyLevels(grayPlane, 40, 10, alphaChan);
    engine.medianBlurRGBA(src, dst, strokeLength, 2, false, strokeLength);
    engine.medianBlurRGBA(src, lightStrokeRgba, strokeLength, 2, true, strokeLength);
    engine.fillColor(whiteRgba, 255);
    engine.blendRGBAByMask(dst, grayPlane, whiteRgba);
    engine.blendRGBAByMask(whiteRgba, grayPlane, lightStrokeRgba);
    engine.sharpenRGBA(lightStrokeRgba, dst, 1);
    engine.rgbToHSV(dst);
    engine.readChannel(dst, grayPlane);
    engine.applyLevels(grayPlane, levelBlack, levelWhite, alphaChan);
    engine.writeChannel(grayPlane, dst);
    engine.hsvToRGB(dst);
};
FilterPixelOps.mosaicTiles = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    engine.seedRandom(params[3]);
    const cellSize = params[1];
    const shadowStrength = params[2] / 10;
    const gridSize = params[0] + cellSize;
    const workPlane = engine.allocArray(1);
    const scratchPlane = engine.allocArray(1);
    const gradients = engine.allocInt32();
    const gradientScratch = engine.allocInt32();
    engine.randomFill(workPlane);
    engine.boxBlur(workPlane, scratchPlane, 11);
    engine.boxBlur(scratchPlane, workPlane, 11);
    engine.computeGradients(workPlane, gradients);
    engine.boxBlurRG(gradients, gradientScratch, 5);
    engine.boxBlurRG(gradientScratch, gradients, 5);
    engine.addCoordBias(gradientScratch, .97);
    engine.buildGrid(gradientScratch, workPlane, gridSize);
    engine.medianBlurH(workPlane, scratchPlane, cellSize, cellSize, 1);
    engine.rgbaMaxChan(src, workPlane);
    engine.screenBlend(scratchPlane, workPlane, scratchPlane, .6);
    engine.multiplyBlend(workPlane, scratchPlane, scratchPlane, shadowStrength);
    engine.applyDirKernel(scratchPlane, scratchPlane, workPlane, 5, 1);
    engine.rgbToHSV(src, dst);
    engine.writeChannel(workPlane, dst);
    engine.hsvToRGB(dst);
};
FilterPixelOps.neonGlow = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const glowWidth = Math.abs(params[0]);
    const outerBlur = glowWidth + [1, 0, 1, 2, 1, 2, 1, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 4, 3, 4, 5, 4, 5, 4, 5][glowWidth];
    const innerBlur = 2 * glowWidth + 1;
    const brightness = params[1] / 10;
    const coreBrightness = brightness * 13 / 15;
    const grayGlow = engine.allocArray(1);
    const midGlow = engine.allocArray(1);
    const origGray = engine.allocArray(1);
    const blurScratch = engine.allocArray(1);
    const glowLayer1 = engine.allocArray(4);
    const glowLayer2 = engine.allocArray(4);
    const glowColor1Rgba = engine.allocArray(4);
    const glowColor2Rgba = engine.allocArray(4);
    const coreColorRgba = engine.allocArray(4);
    engine.rgbaToGray(src, grayGlow);
    if (params[0] >= 0) {
        engine.invertChannel(grayGlow);
    }
    engine.copyArray(grayGlow, origGray);
    engine.boxBlur(grayGlow, blurScratch, outerBlur);
    engine.boxBlur(blurScratch, grayGlow, outerBlur);
    engine.multiplyScalar(grayGlow, brightness);
    engine.copyArray(grayGlow, midGlow);
    engine.boxBlur(grayGlow, blurScratch, innerBlur);
    engine.boxBlur(blurScratch, grayGlow, innerBlur);
    engine.multiplyScalar(grayGlow, coreBrightness);
    engine.fillColor(glowColor1Rgba, params[2]);
    engine.fillColor(glowColor2Rgba, params[3]);
    engine.fillColor(coreColorRgba, params[4]);
    engine.blendRGBAByMask(glowColor1Rgba, grayGlow, glowColor2Rgba, glowLayer1);
    engine.blendRGBAByMask(coreColorRgba, midGlow, glowLayer1, glowLayer2);
    engine.blendRGBAByMask(glowColor2Rgba, origGray, glowLayer2, dst);
    engine.readChannel(src, origGray, 3);
    engine.writeChannel(origGray, dst, 3);
};
FilterPixelOps.notePaper = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    engine.seedRandom(params[5]);
    const threshold = params[0] * 5.1;
    const grainAmount = params[1] / 100;
    const blurFactor = engine.blurFactors[params[2]];
    const grayMask = engine.allocArray(1);
    const paperChan = engine.allocArray(1);
    const grainChan = engine.allocArray(1);
    engine.rgbaToGray(src, grayMask);
    engine.fillScalar(paperChan, 255);
    engine.randomFill(grainChan);
    engine.threshold(grayMask, threshold);
    engine.scalePreserve(paperChan, grayMask, .7);
    engine.scalePreserve(grainChan, grayMask, grainAmount);
    engine.applyDirKernel(grayMask, grayMask, paperChan, 5, blurFactor);
    engine.copyArray(src, dst);
    engine.posterize2(dst, threshold, params[4], params[3]);
    engine.rgbToHSV(dst);
    engine.writeChannel(paperChan, dst);
    engine.hsvToRGB(dst);
};
FilterPixelOps.paletteKnife = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const tileSize = params[0];
    const modeBlurPasses = 4 - params[1];
    const smoothness = 11 - params[2];
    const modeScratch = engine.allocArray(1);
    const maxChan = engine.allocArray(1);
    const resultRgba = engine.allocArray(4);
    engine.rgbaMaxChan(src, maxChan);
    for (let passIdx = 0; passIdx < modeBlurPasses; passIdx++) {
        engine.copyArray(maxChan, modeScratch);
        engine.modeBlur(modeScratch, maxChan, tileSize, tileSize);
    }
    engine.boxBlurRGBA(src, resultRgba, tileSize);
    engine.rgbToHSV(resultRgba, resultRgba);
    engine.writeChannel(maxChan, resultRgba);
    engine.hsvToRGB(resultRgba, resultRgba);
    (smoothness < 11 ? engine.smoothRGBA : engine.copyArray)(resultRgba, dst, smoothness);
};
FilterPixelOps.patchwork = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    engine.seedRandom(params[2]);
    const cellSize = params[0] + 5;
    const edgeMerge = ~~(cellSize / 5 + 1);
    const medianSize = ~~(cellSize / 2) + 1;
    const medianRank = medianSize * medianSize;
    const boxSize = ~~(cellSize / 3);
    const dirBlur = engine.blurFactors[params[1]];
    const offsetLut = new Array(256);
    for (let n = 0; n < 256; n++) {
        offsetLut[n] = ~~(.2 * (n - 128));
    }
    const valueChan = engine.allocArray(1);
    const grainChan = engine.allocArray(1);
    engine.gaussBlur(src, dst, cellSize);
    engine.rgbToHSV(dst);
    engine.readChannel(dst, valueChan);
    engine.randomFill(grainChan);
    engine.applyLUTOffset(valueChan, grainChan, offsetLut);
    engine.mergeEdge(grainChan, cellSize, cellSize, edgeMerge, edgeMerge);
    engine.screenBlend(valueChan, grainChan, valueChan, 1);
    engine.boxBlur(valueChan, grainChan, boxSize);
    engine.boxBlur(grainChan, valueChan, boxSize);
    engine.medianBlurH(valueChan, grainChan, medianSize, medianSize, medianRank);
    engine.applyDirKernel(grainChan, grainChan, valueChan, 5, dirBlur);
    engine.writeChannel(valueChan, dst);
    engine.hsvToRGB(dst);
};
FilterPixelOps.plaster = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const grayPlane = engine.allocArray(1);
    const scratchPlane = engine.allocArray(1);
    const resultPlane = engine.allocArray(1);
    const gradients = engine.allocInt32();
    const gradientScratch = engine.allocInt32();
    engine.rgbaToGray(src, grayPlane);
    engine.boxBlur(grayPlane, scratchPlane, params[2]);
    engine.threshold(scratchPlane, params[0] * 5.1);
    engine.medianBlurH(scratchPlane, grayPlane, 2, 2, 4);
    engine.boxBlur(grayPlane, scratchPlane, 3);
    engine.boxBlur(scratchPlane, grayPlane, 3);
    engine.copyArray(grayPlane, resultPlane);
    engine.boxBlur(grayPlane, scratchPlane, 5);
    engine.boxBlur(scratchPlane, grayPlane, 5);
    engine.computeGradients(grayPlane, gradients);
    engine.boxBlurRG(gradients, gradientScratch, 5);
    engine.boxBlurRG(gradientScratch, gradients, 5);
    engine.applyTexture(gradients, scratchPlane, params[1]);
    engine.invertChannel(scratchPlane);
    engine.screenBlend(resultPlane, scratchPlane, resultPlane, 1);
    engine.writeOutput(resultPlane, dst);
};
FilterPixelOps.posterEdges = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const posterizeStep = 1 << 7 - params[2];
    const blurredMax = engine.allocArray(1);
    const maxChan = engine.allocArray(1);
    const edgeBlur = engine.allocArray(1);
    engine.rgbaMaxChan(src, maxChan);
    engine.boxBlur(maxChan, blurredMax, 3);
    engine.copyArray(blurredMax, maxChan);
    engine.boxBlur(blurredMax, edgeBlur, params[0] + 5);
    engine.subtract(edgeBlur, maxChan);
    engine.applyLevels(maxChan, 1, params[1]);
    engine.multiplyScalar(blurredMax, 1 / posterizeStep);
    engine.multiplyScalar(blurredMax, posterizeStep);
    engine.subtract(blurredMax, maxChan);
    engine.rgbToHSV(src, dst);
    engine.writeChannel(maxChan, dst);
    engine.hsvToRGB(dst);
};
FilterPixelOps.reticulation = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    engine.seedRandom(params[3]);
    const grayPlane = engine.allocArray(1);
    const noisePlane = engine.allocArray(1);
    const resultPlane = engine.allocArray(1);
    engine.rgbaToGray(src, grayPlane);
    engine.randomBinary(noisePlane, params[0] / 50);
    engine.boxBlur(noisePlane, resultPlane, 3);
    engine.medianBlurH(grayPlane, noisePlane, 9, 9, 41);
    engine.applyLevels(noisePlane, params[1], params[2]);
    engine.screenBlend(noisePlane, resultPlane, resultPlane, .75);
    engine.multiplyBlend(noisePlane, resultPlane, noisePlane, .5);
    engine.copyArray(noisePlane, grayPlane);
    engine.medianBlurH(grayPlane, resultPlane, 3, 3, 8);
    engine.screenBlend(resultPlane, noisePlane, resultPlane, .75);
    engine.multiplyScalar(resultPlane, 1.2);
    engine.sharpenChan(resultPlane, grayPlane, 1);
    engine.boxBlur(grayPlane, resultPlane, 2);
    engine.sharpenChan(resultPlane, grayPlane, 2);
    engine.multiplyScalar(grayPlane, 1.2);
    engine.boxBlur(grayPlane, resultPlane, 2);
    engine.writeOutput(resultPlane, dst);
};
FilterPixelOps.roughPastels = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const strokeLength = params[0] + 9;
    const dirAmount = params[1] / 2;
    const patternId = params[2];
    const patternScale = params[3];
    const blurFactor = engine.blurFactor(params[4]);
    const directionCount = params[5] + 1;
    const patternParam = params[6];
    const patternChan = engine.allocArray(1);
    const patternPlane = engine.allocArray(1);
    const diagBlurRgba = engine.allocArray(4);
    const dirRgba = engine.allocArray(4);
    engine.applyPattern(patternPlane, patternId, patternScale, patternParam);
    engine.diagonalBlur(src, dst, strokeLength, 1, 1);
    engine.diagonalBlur(dst, diagBlurRgba, strokeLength, 1, 1);
    engine.applyDirKernelRGB(diagBlurRgba, diagBlurRgba, dirRgba, 7, dirAmount);
    engine.multiplyScalar(dirRgba, 1.2);
    engine.invertScale(dirRgba, 1.2);
    engine.applyDirKernel(patternPlane, patternChan, patternChan, directionCount, blurFactor);
    engine.multiplyScalar(patternChan, 3);
    engine.copyArray(src, dst);
    engine.blendRGBAByMask(dirRgba, patternChan, dst);
};
FilterPixelOps.smudgeStick = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    engine.seedRandom(params[3]);
    let medianSize = params[0] + 4;
    const medianRank = medianSize * 2 / 5 + (medianSize % 5 | 0);
    medianSize--;
    const levelBlack = params[1] * -2.75 + 60;
    const levelWhite = 65 - levelBlack;
    const intensity = params[2] / 10;
    const grainChan = engine.allocArray(1);
    const valueChan = engine.allocArray(1);
    engine.randomFill(grainChan);
    engine.rgbaMaxChan(src, valueChan);
    const levelLut = engine.computeLevelLUT(levelBlack, levelWhite, valueChan);
    engine.rgbToHSV(src, dst);
    engine.readChannel(dst, valueChan);
    engine.scalePreserve(valueChan, grainChan, .8);
    engine.applyLUT(valueChan, levelLut);
    engine.multiplyScalar(valueChan, intensity);
    engine.add(grainChan, valueChan);
    engine.medianBlurChan(valueChan, grainChan, medianSize, 3, false, medianRank);
    engine.writeChannel(grainChan, dst);
    engine.hsvToRGB(dst);
};
FilterPixelOps.sponge = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    engine.seedRandom(params[3]);
    const cellSize = params[0] + 5;
    const cellRank = (cellSize * cellSize >> 1) + cellSize % 2;
    const sharpen = params[1] / 10;
    const smoothSize = params[2];
    const smoothRank = (smoothSize * smoothSize >> 1) + smoothSize % 2;
    const valueGray = engine.allocArray(1);
    const edgeMask = engine.allocArray(1);
    const grainThenGray = engine.allocArray(1);
    const lightRgba = engine.allocArray(4);
    const darkRgba = engine.allocArray(4);
    const hsvRgba = engine.allocArray(4);
    engine.randomFill(grainThenGray);
    engine.rgbToHSV(src, hsvRgba);
    engine.readChannel(hsvRgba, valueGray);
    engine.scalePreserve(valueGray, grainThenGray, .8);
    engine.boxBlur(grainThenGray, valueGray, 3);
    engine.sharpenChan(valueGray, grainThenGray, sharpen);
    engine.writeChannel(grainThenGray, hsvRgba);
    engine.hsvToRGB(hsvRgba, hsvRgba);
    engine.rgbaToGray(hsvRgba, grainThenGray);
    engine.medianBlurH(grainThenGray, valueGray, cellSize, cellSize, cellRank);
    engine.boxBlur(grainThenGray, edgeMask, cellSize);
    engine.subtract(valueGray, edgeMask);
    engine.threshold(edgeMask, 1);
    engine.medianBlurHRGBA(hsvRgba, lightRgba, 7, 7, 40);
    engine.medianBlurHRGBA(hsvRgba, darkRgba, 7, 7, 10);
    engine.blendRGBAByMask(lightRgba, edgeMask, darkRgba);
    engine.medianBlurHRGBA(darkRgba, dst, smoothSize, smoothSize, smoothRank);
};
FilterPixelOps.stamp = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const smoothness = params[0];
    let threshold = 255;
    if (smoothness < 2) threshold = smoothness;
    else if (smoothness < 12) threshold = 5 * smoothness - 5;
    else if (smoothness < 47) threshold = 2 * smoothness + 28;
    else if (smoothness < 50) {
        const excess = smoothness - 47;
        threshold = 125 + 12.5 * excess + 12.5 * excess * excess;
    }
    const smudgeLut = new Uint8Array(256);
    for (let lutIdx = 75, lutVal = 15; lutIdx < 256; lutIdx++, lutVal += 24) {
        smudgeLut[lutIdx] = Math.min(255, lutVal);
    }
    const edgeGray = engine.allocArray(1);
    const blurScratch = engine.allocArray(1);
    const blurScratch2 = engine.allocArray(1);
    engine.rgbaToGray(src, edgeGray);
    engine.boxBlur(edgeGray, blurScratch, 11);
    engine.boxBlur(blurScratch, blurScratch2, 11);
    engine.subtract(blurScratch2, edgeGray);
    engine.multiplyScalar(edgeGray, 8);
    engine.subtract(blurScratch2, edgeGray);
    engine.threshold(edgeGray, threshold);
    engine.invertChannel(edgeGray);
    engine.boxBlur(edgeGray, blurScratch, 5);
    engine.threshold(blurScratch, 51);
    engine.boxBlur(blurScratch, edgeGray, params[1]);
    engine.boxBlur(edgeGray, blurScratch, params[1]);
    engine.invertChannel(blurScratch);
    engine.applyLUT(blurScratch, smudgeLut);
    engine.writeOutput(blurScratch, dst);
};
FilterPixelOps.sumie = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const strokeAmount = engine.blurAmounts[params[1]];
    const levelBlack = params[2];
    const levelWhite = levelBlack * 1.5;
    const maxScratch = engine.allocArray(1);
    const detailChan = engine.allocArray(1);
    const strokeChan = engine.allocArray(1);
    engine.rgbaMaxChan(src, maxScratch);
    engine.medianBlurChan(maxScratch, detailChan, 15, 2, true, 15);
    engine.copyArray(detailChan, strokeChan);
    engine.applyLevels(strokeChan, levelBlack, levelWhite);
    engine.boxBlur(strokeChan, maxScratch, 3);
    engine.boxBlur(detailChan, strokeChan, params[0]);
    engine.subtract(strokeChan, detailChan);
    engine.multiplyScalar(detailChan, strokeAmount);
    engine.subtract(maxScratch, detailChan);
    engine.boxBlur(detailChan, maxScratch, 3);
    engine.medianBlurChan(maxScratch, detailChan, 3, 1, false, 1);
    engine.boxBlurRGBA(src, dst, 15);
    engine.rgbToHSV(dst);
    engine.writeChannel(detailChan, dst);
    engine.hsvToRGB(dst);
};
FilterPixelOps.tornEdges = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    engine.seedRandom(params[3]);
    const threshold = params[0] * 5.1;
    const blurSize = 16 - params[1];
    const contrast = [1, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.45, 1.5, 1.6, 1.7, 1.8, 2, 2.25, 2.5, 2.75, 3, 3.5, 4, 5, 6, 8, 10][params[2]];
    const maskPlane = engine.allocArray(1);
    const scratchPlane = engine.allocArray(1);
    const grainChan = engine.allocArray(1);
    engine.rgbaToGray(src, maskPlane);
    engine.threshold(maskPlane, threshold);
    engine.boxBlur(maskPlane, scratchPlane, blurSize);
    engine.boxBlur(scratchPlane, maskPlane, blurSize);
    engine.randomFill(grainChan);
    engine.multiplyBlend(maskPlane, grainChan, grainChan, 1);
    engine.screenBlend(maskPlane, grainChan, maskPlane, .75);
    engine.multiplyScalar(maskPlane, contrast);
    engine.invertScale(maskPlane, contrast);
    engine.medianBlurH(maskPlane, scratchPlane, 2, 2, 2);
    engine.writeOutput(scratchPlane, dst);
};
FilterPixelOps.underpainting = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const modeSize = params[0] + 9;
    const boxSize = params[1] + 9;
    const patternId = params[2];
    const patternScale = params[3];
    const blurFactor = engine.blurFactor(params[4]);
    const directionCount = params[5] + 1;
    const patternParam = params[6];
    const maxChan = engine.allocArray(1);
    const patternPlane = engine.allocArray(1);
    const blurredMax = engine.allocArray(1);
    const detailCopy = engine.allocArray(1);
    const diffPlane = engine.allocArray(1);
    const hsvRgba = engine.allocArray(4);
    engine.rgbaMaxChan(src, maxChan);
    engine.modeBlur(maxChan, blurredMax, modeSize, modeSize);
    engine.boxBlur(blurredMax, maxChan, boxSize);
    engine.copyArray(blurredMax, diffPlane);
    engine.copyArray(maxChan, detailCopy);
    engine.subtract(diffPlane, detailCopy);
    engine.subtract(maxChan, diffPlane);
    engine.add(diffPlane, detailCopy);
    engine.multiplyScalar(detailCopy, 10);
    engine.applyPattern(patternPlane, patternId, patternScale, patternParam);
    engine.applyDirKernel(patternPlane, maxChan, diffPlane, directionCount, blurFactor);
    engine.blendByMask(diffPlane, detailCopy, blurredMax, .8);
    engine.boxBlurRGBA(src, hsvRgba, 9);
    engine.boxBlurRGBA(hsvRgba, dst, 9);
    engine.rgbToHSV(dst);
    engine.writeChannel(blurredMax, dst);
    engine.hsvToRGB(dst);
};
FilterPixelOps.watercolor = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const brushSize = 16 - params[0];
    const levelBlack = params[1] * 8;
    const texture = 1 - (3 - params[2]) / 10;
    const lightRank = ~~(brushSize * brushSize * texture - 1);
    let darkRank = ~~(brushSize * brushSize * (1 - texture));
    if (darkRank == 0) darkRank = 1;
    const valueChan = engine.allocArray(1);
    const edgeMask = engine.allocArray(1);
    const grayScratch = engine.allocArray(1);
    const lightRgba = engine.allocArray(4);
    engine.rgbaToGray(src, grayScratch);
    engine.medianBlurH(grayScratch, valueChan, 7, 7, 25);
    engine.boxBlur(grayScratch, edgeMask, 7);
    engine.subtract(valueChan, edgeMask);
    engine.threshold(edgeMask, 1);
    engine.medianBlurHRGBA(src, lightRgba, brushSize, brushSize, lightRank);
    engine.medianBlurHRGBA(src, dst, brushSize, brushSize, darkRank);
    engine.blendRGBAByMask(lightRgba, edgeMask, dst);
    engine.rgbToHSV(dst);
    engine.readChannel(dst, valueChan);
    engine.medianBlurH(valueChan, grayScratch, 3, 3, 1);
    engine.medianBlurH(valueChan, edgeMask, 3, 3, 9);
    engine.subtract(edgeMask, grayScratch);
    engine.copyArray(grayScratch, edgeMask);
    engine.subtract(valueChan, grayScratch);
    engine.subtract(grayScratch, edgeMask);
    engine.medianBlurH(edgeMask, valueChan, 3, 3, 8);
    engine.applyLevels(valueChan, levelBlack, 1);
    engine.writeChannel(valueChan, dst);
    engine.hsvToRGB(dst);
};
FilterPixelOps.waterPaper = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    engine.seedRandom(params[3]);
    const fiberSize = params[0];
    const brightness = params[1];
    const contrast = params[2];
    const blurSize = fiberSize >> 1;
    const medianRank1 = Math.max(~~(fiberSize / 5), 1);
    const medianRank2 = Math.max(~~(fiberSize * 2 / 3), 1);
    const brightnessLut = engine.buildBrightnessLUT(brightness, contrast);
    const maxChan = engine.allocArray(1);
    const hFiber = engine.allocArray(1);
    const noisePlane = engine.allocArray(1);
    const vFiber = engine.allocArray(1);
    const blurRgba = engine.allocArray(4);
    engine.rgbaMaxChan(src, maxChan);
    engine.buildBorder(2147483647, 4, 2, 2, 0, 255, hFiber);
    engine.buildBorder(4, 2147483647, 2, 2, 0, 255, vFiber);
    engine.randomFill(noisePlane);
    engine.multiplyBlend(hFiber, noisePlane, hFiber, 1);
    engine.multiplyBlend(vFiber, noisePlane, vFiber, 1);
    engine.multiplyBlend(hFiber, maxChan, hFiber, 1);
    engine.multiplyBlend(vFiber, maxChan, vFiber, 1);
    engine.boxBlurRGBA(src, blurRgba, blurSize);
    engine.boxBlurRGBA(blurRgba, dst, blurSize);
    engine.medianBlurH(hFiber, maxChan, 1, fiberSize, medianRank1);
    engine.medianBlurH(maxChan, hFiber, 3, fiberSize, medianRank2);
    engine.medianBlurH(vFiber, maxChan, fiberSize, 1, medianRank1);
    engine.medianBlurH(maxChan, vFiber, fiberSize, 3, medianRank2);
    engine.average(hFiber, vFiber);
    engine.rgbToHSV(dst);
    engine.writeChannel(vFiber, dst);
    engine.hsvToRGB(dst);
    engine.applyLUTToRGBA(dst, brightnessLut);
};
FilterPixelOps.edgeQuantize = function (sourceChannel, destChannel, engine) {
    const width = engine.width;
    const height = engine.height;
    const planeNW = engine.allocArray(1);
    const planeN = engine.allocArray(1);
    const planeNE = engine.allocArray(1);
    const planeW = engine.allocArray(1);
    const planeC = engine.allocArray(1);
    const planeE = engine.allocArray(1);
    const planeSW = engine.allocArray(1);
    const planeS = engine.allocArray(1);
    const planeSE = engine.allocArray(1);
    convolveChannelInterior(sourceChannel, planeNW, width, height, normalizeKernelWeights([8, 5, 2, 5, 2, -1, 2, -1, -4]));
    convolveChannelInterior(sourceChannel, planeN, width, height, normalizeKernelWeights([5, 5, 5, 2, 2, 2, -1, -1, -1]));
    convolveChannelInterior(sourceChannel, planeNE, width, height, normalizeKernelWeights([2, 5, 8, -1, 2, 5, -4, -1, 2]));
    convolveChannelInterior(sourceChannel, planeW, width, height, normalizeKernelWeights([5, 2, -1, 5, 2, -1, 5, 2, -1]));
    convolveChannelInterior(sourceChannel, planeC, width, height, normalizeKernelWeights([2, 2, 2, 2, 2, 2, 2, 2, 2]));
    convolveChannelInterior(sourceChannel, planeE, width, height, normalizeKernelWeights([-1, 2, 5, -1, 2, 5, -1, 2, 5]));
    convolveChannelInterior(sourceChannel, planeSW, width, height, normalizeKernelWeights([2, -1, -4, 5, 2, -1, 8, 5, 2]));
    convolveChannelInterior(sourceChannel, planeS, width, height, normalizeKernelWeights([-1, -1, -1, 2, 2, 2, 5, 5, 5]));
    convolveChannelInterior(sourceChannel, planeSE, width, height, normalizeKernelWeights([-4, -1, 2, -1, 2, 5, 2, 5, 8]));
    const directionPlanes = [planeNW, planeN, planeNE, planeW, planeC, planeE, planeSW, planeS, planeSE];
    for (let rowIdx = 0; rowIdx < height; rowIdx++) {
        for (let colIdx = 0; colIdx < width; colIdx++) {
            const pixelIndex = rowIdx * width + colIdx;
            const centerValue = sourceChannel[pixelIndex];
            let bestDelta = null;
            let bestValue = 0;
            for (let dRow = -1; dRow < 2; dRow++) {
                for (let dCol = -1; dCol < 2; dCol++) {
                    const plane = directionPlanes[(dRow + 1) * 3 + dCol + 1];
                    let sampleRow = Math.max(0, Math.min(rowIdx + dRow, height - 1));
                    let sampleCol = Math.max(0, Math.min(colIdx + dCol, width - 1));
                    const sampleValue = plane[sampleRow * width + sampleCol];
                    const delta = Math.abs(sampleValue - centerValue);
                    if (bestDelta == null || delta < bestDelta) {
                        bestDelta = delta;
                        bestValue = sampleValue
                    }
                }
            }
            destChannel[pixelIndex] = bestValue
        }
    }
}
FilterPixelOps.glowingEdges = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    engine.init(width, height);
    const channelPlane = engine.allocArray(1);
    const scratchPlane = engine.allocArray(1);
    for (let channelIdx = 0; channelIdx < 4; channelIdx++) {
        engine.readChannel(src, channelPlane, channelIdx);
        let resultPlane = channelPlane;
        if (channelIdx < 3) resultPlane = applyEdgeQuantizePasses(channelPlane, scratchPlane, engine, 9);
        engine.writeChannel(resultPlane, dst, channelIdx)
    }
};

// Seeded fractal Perlin noise (8 octaves) rendered to a grayscale plane. The
// permutation and gradient tables are built once; each render re-hashes them
// from an optional seed. Wrapping is bitmask-based for power-of-two-ish periods
// and modulo otherwise, so tiled octaves repeat seamlessly.
FilterPixelOps.perlinNoise = function () {
    const GRADIENT_X = [1, -1, 1, -1, 1, -1, 0, 0];
    const GRADIENT_Y = [1, 1, -1, -1, 0, 0, 1, -1];
    const basePermutation = [];
    const permutation = new Uint8Array(512);
    const gradientX = new Float32Array(512);
    const gradientY = new Float32Array(512);
    let i = 0;
    for (; i < 256; i++) basePermutation[i] = i;
    let permutationSeed = 25236627;
    const nextRandom = function () {
        permutationSeed = (permutationSeed * 1664525 + 1013904223) & 0xffffffff;
        return ((permutationSeed >>> 1) & 0x3fffffff) / 0x40000000;
    };
    while (i != 0) {
        i--;
        const swapIdx = Math.floor(nextRandom() * i);
        basePermutation[swapIdx] ^= basePermutation[i] ^ (basePermutation[i] = basePermutation[swapIdx]);
    }

    // Re-hash the doubled permutation + per-entry gradient tables from a seed.
    function buildPermutation(seed) {
        seed = Math.floor(seed * 65536);
        if (seed < 256) seed |= seed << 8;
        for (let n = 0; n < 256; n++) {
            const mirror = n + 256;
            const permValue = basePermutation[n] ^ (n & 1 ? seed : seed >> 8) & 255;
            permutation[n] = permutation[mirror] = permValue;
            const gradIdx = permValue % 8;
            gradientX[n] = gradientX[mirror] = GRADIENT_X[gradIdx];
            gradientY[n] = gradientY[mirror] = GRADIENT_Y[gradIdx];
        }
    }

    function fadeCurve(t) {
        return t * t * t * (t * (t * 6 - 15) + 10);
    }

    function lerp(a, b, t) {
        return (1 - t) * a + t * b;
    }

    function wrapAnd(value, mask) {
        return value & mask;
    }

    function wrapMod(value, period) {
        return value % period;
    }

    function noise2d(x, y, periodX, periodY, wrap) {
        let cellX = Math.floor(x);
        let cellY = Math.floor(y);
        const fracX = x - cellX;
        const fracY = y - cellY;
        cellX = cellX & 255;
        cellY = cellY & 255;
        let hashIdx = cellX + permutation[cellY];
        const corner00 = gradientX[hashIdx] * fracX + gradientY[hashIdx] * fracY;
        hashIdx = cellX + permutation[wrap(cellY + 1, periodY)];
        const corner01 = gradientX[hashIdx] * fracX + gradientY[hashIdx] * (fracY - 1);
        hashIdx = wrap(cellX + 1, periodX) + permutation[cellY];
        const corner10 = gradientX[hashIdx] * (fracX - 1) + gradientY[hashIdx] * fracY;
        hashIdx = wrap(cellX + 1, periodX) + permutation[wrap(cellY + 1, periodY)];
        const corner11 = gradientX[hashIdx] * (fracX - 1) + gradientY[hashIdx] * (fracY - 1);
        const fadeX = fadeCurve(fracX);
        return lerp(lerp(corner00, corner10, fadeX), lerp(corner01, corner11, fadeX), fadeCurve(fracY));
    }

    // Per-octave periods, amplitudes, and frequencies, plus the wrap function.
    function buildOctaveTables(width, height, octaveCount, seed) {
        const minDim = Math.min(Math.min(width, 256), Math.min(256, height));
        const useBitmaskWrap = minDim == 256 || minDim < 8;
        const periodX = new Uint32Array(octaveCount);
        const periodY = new Uint32Array(octaveCount);
        const amplitude = new Float32Array(octaveCount);
        const frequency = new Float32Array(octaveCount);
        let amp = 1;
        let octaveScale = 1;
        const wrap = useBitmaskWrap ? wrapAnd : wrapMod;
        for (let n = 0; n < octaveCount; n++) {
            const freq = octaveScale * 1 / minDim;
            if (useBitmaskWrap) {
                periodY[n] = (1 << Math.ceil(Math.log2(height * freq))) - 1;
                periodX[n] = (1 << Math.ceil(Math.log2(width * freq))) - 1;
            } else {
                periodY[n] = freq * height;
                periodX[n] = freq * width;
            }
            amplitude[n] = amp;
            frequency[n] = freq;
            amp *= .5;
            octaveScale = octaveScale << 1;
        }
        buildPermutation(seed == null ? Math.random() : seed);
        return [periodX, periodY, frequency, amplitude, wrap];
    }

    return function perlinNoiseKernel(srcRgba, width, height, dstChannel, params, seed) {
        const octaveCount = 8;
        const octaves = buildOctaveTables(width, height, octaveCount, seed);
        const periodX = octaves[0];
        const periodY = octaves[1];
        const frequency = octaves[2];
        const amplitude = octaves[3];
        const wrap = octaves[4];
        for (let row = 0, dstIdx = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
                let sum = 0;
                for (let octave = 0; octave < octaveCount; octave++) {
                    const freq = frequency[octave];
                    sum += noise2d(col * freq, row * freq, periodX[octave], periodY[octave], wrap) * amplitude[octave];
                }
                dstChannel[dstIdx++] = Math.round(Math.max(0, 255 * Math.min(1, .5 + sum * .5)));
            }
        }
    };
}();
// Sobel edge magnitude drawn as inverted alpha over a softly-blurred copy of the
// source: dark outlines on the blurred image.
FilterPixelOps.findEdges = function (srcRgba, width, height, dstRgba) {
    const edgeChannel = new Uint8Array(srcRgba.length >>> 2);
    const grayChannel = new Uint8Array(srcRgba.length >>> 2);
    const srcRgbCopy = new Uint8Array(srcRgba.length);
    for (let i = 0; i < srcRgba.length; i += 4) {
        grayChannel[i >>> 2] = srcRgba[i] * .3 + srcRgba[i + 1] * .59 + srcRgba[i + 2] * .11;
        srcRgbCopy[i] = srcRgba[i];
        srcRgbCopy[i + 1] = srcRgba[i + 1];
        srcRgbCopy[i + 2] = srcRgba[i + 2];
    }
    sobelMagnitudeChannel(grayChannel, edgeChannel, width, height);
    convolveRgba(srcRgba, dstRgba, width, height, PRESET_CONVOLVE_KERNELS[1], false, true);
    for (let i = 0; i < srcRgba.length; i += 4) {
        srcRgbCopy[i + 3] = 255 - edgeChannel[i >>> 2];
    }
    for (let i = 0, len = srcRgba.length; i < len; i += 4) {
        const alphaNorm = srcRgbCopy[i + 3] / 255;
        dstRgba[i] = srcRgbCopy[i] * alphaNorm + dstRgba[i] * (1 - alphaNorm);
        dstRgba[i + 1] = srcRgbCopy[i + 1] * alphaNorm + dstRgba[i + 1] * (1 - alphaNorm);
        dstRgba[i + 2] = srcRgbCopy[i + 2] * alphaNorm + dstRgba[i + 2] * (1 - alphaNorm);
    }
};
// Sharpened edges rendered as a glowing outline: the sharpened image's edge
// magnitude becomes a glow alpha that composites the sharpened colour over the
// original.
FilterPixelOps.neon = function (srcRgba, width, height, dstRgba) {
    const sharpenedRgba = new Uint8Array(srcRgba.length);
    const grayChannel = new Uint8Array(srcRgba.length >>> 2);
    const edgeChannel = new Uint8Array(srcRgba.length >>> 2);
    convolveRgba(srcRgba, sharpenedRgba, width, height, PRESET_CONVOLVE_KERNELS[2], false, true);
    for (let i = 0; i < srcRgba.length; i += 4) {
        grayChannel[i >>> 2] = sharpenedRgba[i] * .3 + sharpenedRgba[i + 1] * .59 + sharpenedRgba[i + 2] * .11;
        dstRgba[i] = srcRgba[i];
        dstRgba[i + 1] = srcRgba[i + 1];
        dstRgba[i + 2] = srcRgba[i + 2];
        dstRgba[i + 3] = srcRgba[i + 3];
    }
    sobelMagnitudeChannel(grayChannel, edgeChannel, width, height);
    for (let i = 0; i < srcRgba.length; i += 4) {
        sharpenedRgba[i + 3] = ~~(Math.max(0, 255 - edgeChannel[i >>> 2] - 50) * (255 / 205));
    }
    for (let i = 0, len = srcRgba.length; i < len; i += 4) {
        const alphaNorm = sharpenedRgba[i + 3] / 255;
        dstRgba[i] = sharpenedRgba[i] * alphaNorm + dstRgba[i] * (1 - alphaNorm);
        dstRgba[i + 1] = sharpenedRgba[i + 1] * alphaNorm + dstRgba[i + 1] * (1 - alphaNorm);
        dstRgba[i + 2] = sharpenedRgba[i + 2] * alphaNorm + dstRgba[i + 2] * (1 - alphaNorm);
    }
};
// "Wind"-style directional streaks. Per row, bright-to-dark transitions seed
// streaks that carry pixels rightward; three modes vary how the streak is
// blended/propagated. The vertical variant flips horizontally, streaks, then
// flips back. Runs on inverted alpha so streaks fade over transparency.
FilterPixelOps.pixelate = function () {
    function pixelSum(rgba, off) {
        return rgba[off] + rgba[off + 1] + rgba[off + 2] + rgba[off + 3];
    }

    function pixelWeightAlpha2(rgba, off) {
        return rgba[off] + rgba[off + 1] + rgba[off + 2] + 2 * rgba[off + 3];
    }

    function copyPixel(dst, dstOff, src, srcOff) {
        dst[dstOff] = src[srcOff];
        dst[dstOff + 1] = src[srcOff + 1];
        dst[dstOff + 2] = src[srcOff + 2];
        dst[dstOff + 3] = src[srcOff + 3];
    }

    function copyPixelWithin(rgba, dstOff, srcOff) {
        rgba[dstOff] = rgba[srcOff];
        rgba[dstOff + 1] = rgba[srcOff + 1];
        rgba[dstOff + 2] = rgba[srcOff + 2];
        rgba[dstOff + 3] = rgba[srcOff + 3];
    }

    // Copy RGB from src to dst at the same offset, storing inverted alpha.
    function copyPixelInvertAlpha(dst, src, off) {
        dst[off] = src[off];
        dst[off + 1] = src[off + 1];
        dst[off + 2] = src[off + 2];
        dst[off + 3] = 255 - src[off + 3];
    }

    function invertAlphas(rgba) {
        for (let i = 0, len = rgba.length; i < len; i += 4) {
            rgba[i + 3] = 255 - rgba[i + 3];
        }
    }

    // Short streak length, heavily weighted toward 0 (rare long streaks).
    function randomShortStreak() {
        const roll = Math.random();
        if (roll > .5) return 0;
        if (roll > .25) return 1;
        if (roll > .1) return 2;
        if (roll > .02143) return 3;
        if (roll > .00445) return 4;
        if (roll > 65e-5) return 5;
        if (roll > 415e-6) return 6;
        if (roll > 55e-6) return 7;
        return 8;
    }

    // dst = a + (b - a) / 2, i.e. the midpoint biased toward a.
    function blendHalfToward(dst, dstOff, a, aOff, b, bOff) {
        dst[dstOff] = a[aOff] + (b[bOff] - a[aOff] >> 1);
        dst[dstOff + 1] = a[aOff + 1] + (b[bOff + 1] - a[aOff + 1] >> 1);
        dst[dstOff + 2] = a[aOff + 2] + (b[bOff + 2] - a[aOff + 2] >> 1);
        dst[dstOff + 3] = a[aOff + 3] + (b[bOff + 3] - a[aOff + 3] >> 1);
    }

    // dst = (a + b) / 2.
    function blendAverage(dst, dstOff, a, aOff, b, bOff) {
        dst[dstOff] = b[bOff] + a[aOff] >> 1;
        dst[dstOff + 1] = b[bOff + 1] + a[aOff + 1] >> 1;
        dst[dstOff + 2] = b[bOff + 2] + a[aOff + 2] >> 1;
        dst[dstOff + 3] = b[bOff + 3] + a[aOff + 3] >> 1;
    }

    // Mode 0 streak: build a fading trail in scratchB, then bubble it leftward
    // through columns while the running sum keeps increasing, averaging trails.
    function propagateStreak(rgba, byteOff, byteOff2, sums, streaks, colIdx, scratchA, scratchB, stride) {
        let prevByteLen = 0;
        let streakByteLen = 0;
        let filledCount = 0;
        let k;
        let streakLen = streaks[colIdx];
        let swap;
        blendHalfToward(scratchB, 0, rgba, byteOff, rgba, byteOff2);
        for (k = 0; k < streakLen; k++) {
            blendHalfToward(scratchB, (k + 1) * 4, scratchB, k * 4, rgba, byteOff2);
        }
        streakByteLen = (streakLen + 1) * 4;
        filledCount += streakLen;
        colIdx--;
        copyPixel(rgba, byteOff, scratchB, streakByteLen - 4);
        sums[colIdx] = pixelSum(rgba, byteOff);
        byteOff -= stride;
        while (colIdx > 0 && sums[colIdx - 1] < sums[colIdx]) {
            swap = scratchB;
            scratchB = scratchA;
            scratchA = swap;
            prevByteLen = streakByteLen;
            blendAverage(scratchB, 0, rgba, byteOff - stride, scratchA, 0);
            for (k = 4; k < prevByteLen; k += 4) {
                blendAverage(scratchB, k, scratchB, k - 4, scratchA, k);
            }
            streakLen = streaks[colIdx];
            for (k = filledCount; k < streakLen; k++) {
                blendHalfToward(scratchB, streakByteLen, scratchB, streakByteLen - 4, scratchA, prevByteLen - 4);
                streakByteLen += 4;
                filledCount++;
            }
            colIdx--;
            copyPixel(rgba, byteOff, scratchB, streakByteLen - 4);
            sums[colIdx] = pixelSum(rgba, byteOff);
            byteOff -= stride;
        }
    }

    function windMode0(srcRgba, width, height, dstRgba, sums) {
        const streaks = new Uint8Array(width + 1);
        const scratchA = new Uint8Array(10 * 4);
        const scratchB = new Uint8Array(10 * 4);
        let byteOff = 0;
        let rowStartOff;
        let streakLen;
        for (let row = 0; row < height; row++) {
            copyPixelInvertAlpha(dstRgba, srcRgba, byteOff);
            sums[0] = pixelSum(dstRgba, byteOff);
            streaks[0] = randomShortStreak();
            rowStartOff = byteOff;
            byteOff += 4;
            for (let col = 1; col < width; col++) {
                copyPixelInvertAlpha(dstRgba, srcRgba, byteOff);
                sums[col] = pixelSum(dstRgba, byteOff);
                streakLen = randomShortStreak();
                streaks[col] = streakLen;
                if (sums[col - 1] < sums[col] && streakLen > 0) {
                    propagateStreak(dstRgba, byteOff - 4, byteOff, sums, streaks, col, scratchA, scratchB, 4);
                }
                byteOff += 4;
            }
            sums[width] = sums[0];
            streaks[width] = streaks[0];
            if (sums[width - 1] < sums[width] && streakLen > 0) {
                propagateStreak(dstRgba, byteOff, rowStartOff, sums, streaks, width, scratchA, scratchB, 4);
            }
        }
        invertAlphas(dstRgba);
    }

    // Longer streak length for mode 1, weighted toward 0.
    function randomLongStreak() {
        const roll = Math.random();
        if (roll > .659755) return 0;
        if (roll > .1625) return 10;
        if (roll > .06) return 20;
        if (roll > .01) return 30;
        if (roll > .0035) return 40;
        if (roll > 65e-5) return 50;
        if (roll > 415e-6) return 60;
        if (roll > 55e-6) return 70;
        return 80;
    }

    // Mode 1 streak: copy the current pixel leftward across columns whose sum is
    // below the threshold, up to a random streak length.
    function propagateStreakSimple(rgba, byteOff, srcOff, sums, colIdx, stride) {
        const streakLen = randomLongStreak() + 1;
        const threshold = sums[colIdx];
        for (let n = 1; n < streakLen; n++) {
            if (colIdx < 0) break;
            if (sums[colIdx - n] < threshold) copyPixelWithin(rgba, byteOff, srcOff);
            else break;
            byteOff += stride;
        }
    }

    function windMode1(srcRgba, width, height, dstRgba, sums) {
        const rowByteLen = width * 4;
        let byteOff = 0;
        let col;
        for (let row = 0; row < height; row++) {
            copyPixelInvertAlpha(dstRgba, srcRgba, byteOff);
            sums[0] = pixelSum(dstRgba, byteOff);
            byteOff += 4;
            for (col = 1; col < width; col++) {
                copyPixelInvertAlpha(dstRgba, srcRgba, byteOff);
                sums[col] = pixelSum(srcRgba, byteOff);
                if (sums[col - 1] < sums[col]) propagateStreakSimple(dstRgba, byteOff - 4, byteOff, sums, col, -4);
                byteOff += 4;
            }
            sums[width] = sums[0];
            if (sums[col - 1] < sums[col]) propagateStreakSimple(dstRgba, byteOff - 4, byteOff - rowByteLen, sums, col, -4);
        }
        invertAlphas(dstRgba);
    }

    // Mode 2 streak: insertion-sort the pixel leftward by running sum, a random
    // number of steps, carrying the displaced pixel along.
    function propagateStreakSort(rgba, byteOff, sums, colIdx, width, stride) {
        let iteration = 1;
        let currentSum;
        let prevSum;
        const tempPixel = new Uint8Array(4);
        let inserted;
        let scanOff = byteOff;
        while (Math.random() < 1 / iteration) {
            scanOff = byteOff;
            if (colIdx <= 1) break;
            currentSum = sums[colIdx];
            prevSum = sums[colIdx - 1];
            if (currentSum <= prevSum) break;
            copyPixel(tempPixel, 0, rgba, scanOff - stride);
            inserted = true;
            for (let n = colIdx; n < width; n++) {
                if (prevSum > sums[n]) {
                    copyPixel(rgba, scanOff - stride, tempPixel, 0);
                    sums[n - 1] = prevSum;
                    inserted = false;
                    break;
                }
                copyPixel(rgba, scanOff - stride, rgba, scanOff);
                sums[n - 1] = sums[n];
                scanOff += stride;
            }
            if (inserted) {
                copyPixel(rgba, scanOff - stride, tempPixel, 0);
                sums[width - 1] = prevSum;
            }
            iteration++;
            colIdx--;
            byteOff -= stride;
        }
    }

    function windMode2(srcRgba, width, height, dstRgba, sums) {
        let scanOff = 0;
        let rowStartOff;
        for (let row = 0; row < height; row++) {
            rowStartOff = scanOff;
            for (let col = 0; col < width; col++) {
                copyPixelInvertAlpha(dstRgba, srcRgba, scanOff);
                sums[col] = pixelWeightAlpha2(dstRgba, scanOff);
                scanOff += 4;
            }
            scanOff = rowStartOff;
            for (let col = 1; col < width; col++) {
                if (sums[col - 1] < sums[col] && Math.random() < .66) propagateStreakSort(dstRgba, scanOff + 4, sums, col, width, 4);
                scanOff += 4;
            }
            scanOff += 4;
        }
        invertAlphas(dstRgba);
    }

    function flipHorizontal(srcRgba, dstRgba, width, height) {
        for (let row = 0; row < height; row++)
            for (let col = 0; col < width; col++) {
                const srcOff = row * width + col << 2;
                const dstOff = row * width + (width - 1 - col) << 2;
                dstRgba[dstOff] = srcRgba[srcOff];
                dstRgba[dstOff + 1] = srcRgba[srcOff + 1];
                dstRgba[dstOff + 2] = srcRgba[srcOff + 2];
                dstRgba[dstOff + 3] = srcRgba[srcOff + 3];
            }
    }

    return function windKernel(srcRgba, width, height, dstRgba, params) {
        const filterMode = params[0];
        const vertical = params[1];
        const sums = new Uint16Array(width + 1);
        let workingSrc = srcRgba;
        let workingDst = dstRgba;
        let flippedDst;
        if (vertical) {
            flippedDst = dstRgba.slice(0);
            flipHorizontal(srcRgba, dstRgba, width, height);
            workingSrc = dstRgba;
            workingDst = flippedDst;
        }
        if (filterMode == 0) windMode0(workingSrc, width, height, workingDst, sums);
        else if (filterMode == 1) windMode1(workingSrc, width, height, workingDst, sums);
        else if (filterMode == 2) windMode2(workingSrc, width, height, workingDst, sums);
        if (vertical) flipHorizontal(flippedDst, dstRgba, width, height);
    };
}();
FilterPixelOps.stainedGlass = function (src, width, height, dst, params) {
    const engine = PixelEngine;
    let cellScale = 1;
    let writeIdx = 0;
    let readIdx = 0;
    engine.init(width, height);
    engine.seedRandom(params[2]);
    const tanOffset = 3 << 13;
    const angleBase = Math.PI / 2.43;
    const angleStep = angleBase / 256;
    const freqStep = Math.PI * 2 / 256;

    // A random height contribution shaped by a tangent-of-angle and cosine term.
    function randomHeight() {
        const angleSample = engine.random() * 256;
        const cosSample = engine.random() * 256;
        return cellScale * ~~(Math.tan(angleBase - angleSample * angleStep) * 325 * Math.cos(cosSample * freqStep) * 256) + tanOffset >> 16;
    }
    cellScale = params[0];
    const cellSize = params[1];
    const halfWeight = (cellSize + 2) / 2;
    const rowSeed = engine.random() * 255;
    const heightField = engine.allocArray(1);
    for (let row = 0; row < height; row++) {
        let runningHeight = engine.clamp(randomHeight() + rowSeed);
        for (let colIdx = 0; colIdx < width; colIdx++) {
            runningHeight = engine.clamp(randomHeight() + runningHeight);
            heightField[writeIdx++] = runningHeight;
        }
    }
    writeIdx = width;
    for (let row = 1; row < height; row++) {
        let runningHeight = engine.clamp(randomHeight() + heightField[readIdx++]);
        heightField[writeIdx++] = runningHeight;
        for (let colIdx = 1; colIdx < width; colIdx++) {
            let rightIdx = readIdx + 1;
            if (colIdx + 1 == width) {
                rightIdx--;
            }
            const average = (halfWeight + runningHeight + heightField[rightIdx] + heightField[readIdx] * cellSize) / (cellSize + 2);
            runningHeight = engine.clamp(randomHeight() + average);
            heightField[writeIdx++] = runningHeight;
            readIdx++;
        }
    }
    engine.writeOutput(heightField, dst);
};

FilterPixelOps.cutout = function (src, width, height, dst, params) {
    applyCutout(src, width, height, dst, params);
};

