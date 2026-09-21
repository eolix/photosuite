/**
 * Adjustment layer pixel kernels and descriptor routing (`AdjustmentEngine`).
 * Maps PSD adjustment classIDs to CPU/GPU apply paths and preview LUT builders.
 */

import { KeyboardHandler } from "../../core/keyboard-handler.js";

import { SelectiveColorParser, CurvesParser, HueSaturationParser, LevelsParser } from "../../document/formats/psd/adjustment-parsers.js";
import { AdjustmentShaderType, LayerSystem } from "../../engine/layer-system.js";
import { ICC } from "../../document/formats/metadata/icc-profile.js";
import { ADJUSTMENT_NAMES } from "../../document/formats/psd/adjustment-parsers.js";
import { PlanarRgbaBuffer, allocBuffer, copyBuffer, extractChannelByte } from "../../engine/compositing/buffer-utils.js";
import { applyColorCurves } from "../../engine/compositing/pixel-ops.js";
import { hslToRgb, hsvToRgb, hueDiff, labSimilarity, rgbLuminance, rgbToHsl, rgbToHsv, rgbToLab } from "../../engine/compositing/color-math.js";
import { buildGradientLut, parseColorStops, psdColorToRgb } from "../../engine/compositing/psd-color-utils.js";
import { colorScaleMatrix, colorTranslationMatrix, multiplyColorMatrices, transformInterleaved, transformPlanarRgb } from "../../engine/compositing/color-matrix.js";
import { applyLutToChannel, buildCurveTable, buildToneCurveLut, createCurvePoint } from "../../engine/compositing/tone-curves.js";

/** Soft weight of a hue (degrees) inside a four-corner hue-sat range. */
function hueRangeWeight(hueDeg, boundStart, boundRampEnd, boundFallStart, boundEnd) {
  const lowerWeight = (hueDeg - boundStart) / (boundRampEnd - boundStart);
  const upperWeight = (hueDeg - boundFallStart) / (boundEnd - boundFallStart);
  if (lowerWeight < 0) return 0;
  if (lowerWeight < 1) return lowerWeight;
  if (upperWeight < 0) return 1;
  if (upperWeight < 1) return 1 - upperWeight;
  return 0
}

function buildBrightnessCurve(brightnessAmount, resolution) {
  const pts = [];
  const segCount = 3;
  for (let lutIdx = 0; lutIdx < segCount + 1; lutIdx++) pts.push(createCurvePoint(lutIdx / segCount * 255, lutIdx / segCount * 255, true));
  pts[1].v.Hrzn.v = 130 - brightnessAmount * 26;
  pts[1].v.Vrtc.v = 130 + brightnessAmount * 51;
  pts[2].v.Hrzn.v = 233 - brightnessAmount * 48;
  pts[2].v.Vrtc.v = 233 + brightnessAmount * 10;
  return buildToneCurveLut(pts, resolution);
}

const AdjustmentEngine = {};

/**
 * Return the first known adjustment type key present on a descriptor bag.
 */
/**
 * Build GPU/CPU shader options for an adjustment type and its PSD descriptor data.
 */
AdjustmentEngine.buildShaderOptions = function(adjustmentType, data) {
  const shaderTypes = AdjustmentShaderType;
  let result;
  if (adjustmentType == "brit") {
    const brightness = data.Brgh ? data.Brgh.v : 0;
    const contrast = data.Cntr ? data.Cntr.v : 0;
    const useLegacy = data.useLegacy ? data.useLegacy.v : false;
    if (useLegacy) {
      const normalizedBrightness = brightness / 255;
      let contrastMultiplier = 1 + contrast / 100;
      if (contrastMultiplier > 1) contrastMultiplier = 1 + Math.tan(Math.PI / 2 * contrast / 101);
      const colorOffset = (1 - contrastMultiplier) / 2;
      const inputMatrix = colorTranslationMatrix(normalizedBrightness, normalizedBrightness, normalizedBrightness);
      const contrastMatrix = [contrastMultiplier, 0, 0, colorOffset, 0, contrastMultiplier, 0, colorOffset, 0, 0, contrastMultiplier, colorOffset, 0, 0, 0, 1];
      const combinedMatrix = multiplyColorMatrices(inputMatrix, contrastMatrix);
      const lutBuffer = new PlanarRgbaBuffer(256);
      for (let lutIdx = 0; lutIdx < 256; lutIdx++) lutBuffer.h[lutIdx] = lutIdx;
      transformPlanarRgb(lutBuffer, lutBuffer, combinedMatrix);
      result = {
        type: shaderTypes.LookupTable,
        lutR: lutBuffer.h,
        lutG: lutBuffer.h,
        lutB: lutBuffer.h,
        toGray: false,
        preserveLuminosity: false
      }
    } else {
      const lutRes = 1024;
      const contrastAdjust = -30 + 60 * (contrast + 100) / 200;
      const curvePoints = [];
      for (let lutIdx = 0; lutIdx < 4; lutIdx++) curvePoints.push(createCurvePoint(lutIdx / 3 * 255, lutIdx / 3 * 255, true));
      curvePoints[1].v.Hrzn.v = 64;
      curvePoints[1].v.Vrtc.v = 64 - contrastAdjust;
      curvePoints[2].v.Hrzn.v = 128 + 64;
      curvePoints[2].v.Vrtc.v = 128 + 64 + contrastAdjust;
      curvePoints.sort(function(pointA, pointB) {
        return pointA.v.Hrzn.v - pointB.v.Hrzn.v;
      });
      const toneCurveLut = buildToneCurveLut(curvePoints, lutRes);
      let brightnessCurveLut = buildBrightnessCurve(Math.abs(brightness) / 100, lutRes);
      if (brightness < 0) {
        const invertedLut = [];
        const invStep = 1 / lutRes;
        for (let lutIdx = 0; lutIdx < lutRes; lutIdx++) {
          const norm = lutIdx * invStep;
          let idx = lutIdx;
          while (brightnessCurveLut[idx] > norm && idx > 1) idx--;
          invertedLut[lutIdx] = idx * invStep
        }
        brightnessCurveLut = invertedLut
      }
      const lut = new Uint8Array(lutRes);
      for (let lutIdx = 0; lutIdx < lutRes; lutIdx++) {
        const brightnessMappedIdx = Math.round((lutRes - 1) * brightnessCurveLut[lutIdx]);
        lut[lutIdx] = Math.round(255 * toneCurveLut[brightnessMappedIdx])
      }
      result = {
        type: shaderTypes.LookupTable,
        lutR: lut,
        lutG: lut,
        lutB: lut,
        toGray: false,
        preserveLuminosity: false
      }
    }
  }
  if (adjustmentType == "levl") {
    const channelLevels = [];
    let blackPoint;
    let scaleVal;
    let masterMatrix;
    let channelScaleMatrix;
    let channelOffsetMatrix;
    let channelMatrix;
    for (let lutIdx = 0; lutIdx < 4; lutIdx++) channelLevels.push(LevelsParser.getChannelLevel(data, lutIdx));
    blackPoint = -channelLevels[0][0] / 255;
    scaleVal = 1 / (channelLevels[0][1] / 255 - channelLevels[0][0] / 255);
    masterMatrix = multiplyColorMatrices(colorScaleMatrix(scaleVal, scaleVal, scaleVal), colorTranslationMatrix(blackPoint, blackPoint, blackPoint));
    channelScaleMatrix = colorScaleMatrix(1 / (channelLevels[1][1] / 255 - channelLevels[1][0] / 255), 1 / (channelLevels[2][1] / 255 - channelLevels[2][0] / 255), 1 / (channelLevels[3][1] / 255 - channelLevels[3][0] / 255));
    channelOffsetMatrix = colorTranslationMatrix(-channelLevels[1][0] / 255, -channelLevels[2][0] / 255, -channelLevels[3][0] / 255);
    channelMatrix = multiplyColorMatrices(channelScaleMatrix, channelOffsetMatrix);
    const levlLutBuf = new PlanarRgbaBuffer(256);
    for (let lutIdx = 0; lutIdx < 256; lutIdx++) levlLutBuf.h[lutIdx] = levlLutBuf.l[lutIdx] = levlLutBuf.O[lutIdx] = lutIdx;
    const masterGamma = 1 / (channelLevels[0][4] / 100);
    const redGamma = 1 / (channelLevels[1][4] / 100);
    const greenGamma = 1 / (channelLevels[2][4] / 100);
    const blueGamma = 1 / (channelLevels[3][4] / 100);
    transformPlanarRgb(levlLutBuf, levlLutBuf, channelMatrix);
    for (let lutIdx = 0; lutIdx < 256; lutIdx++) {
      levlLutBuf.h[lutIdx] = Math.round(Math.max(0, Math.min(255, 255 * Math.pow(levlLutBuf.h[lutIdx] / 255, redGamma))));
      levlLutBuf.l[lutIdx] = Math.round(Math.max(0, Math.min(255, 255 * Math.pow(levlLutBuf.l[lutIdx] / 255, greenGamma))));
      levlLutBuf.O[lutIdx] = Math.round(Math.max(0, Math.min(255, 255 * Math.pow(levlLutBuf.O[lutIdx] / 255, blueGamma))))
    }
    transformPlanarRgb(levlLutBuf, levlLutBuf, masterMatrix);
    for (let lutIdx = 0; lutIdx < 256; lutIdx++) {
      levlLutBuf.h[lutIdx] = Math.round(Math.max(0, Math.min(255, 255 * Math.pow(levlLutBuf.h[lutIdx] / 255, masterGamma))));
      levlLutBuf.l[lutIdx] = Math.round(Math.max(0, Math.min(255, 255 * Math.pow(levlLutBuf.l[lutIdx] / 255, masterGamma))));
      levlLutBuf.O[lutIdx] = Math.round(Math.max(0, Math.min(255, 255 * Math.pow(levlLutBuf.O[lutIdx] / 255, masterGamma))))
    }
    blackPoint = channelLevels[0][2] / 255;
    scaleVal = channelLevels[0][3] / 255 - channelLevels[0][2] / 255;
    masterMatrix = multiplyColorMatrices(colorTranslationMatrix(blackPoint, blackPoint, blackPoint), colorScaleMatrix(scaleVal, scaleVal, scaleVal));
    channelScaleMatrix = colorScaleMatrix(channelLevels[1][3] / 255 - channelLevels[1][2] / 255, channelLevels[2][3] / 255 - channelLevels[2][2] / 255, channelLevels[3][3] / 255 - channelLevels[3][2] / 255);
    channelOffsetMatrix = colorTranslationMatrix(channelLevels[1][2] / 255, channelLevels[2][2] / 255, channelLevels[3][2] / 255);
    channelMatrix = multiplyColorMatrices(channelOffsetMatrix, channelScaleMatrix);
    transformPlanarRgb(levlLutBuf, levlLutBuf, multiplyColorMatrices(masterMatrix, channelMatrix));
    result = {
      type: shaderTypes.LookupTable,
      lutR: levlLutBuf.h,
      lutG: levlLutBuf.l,
      lutB: levlLutBuf.O,
      toGray: false,
      preserveLuminosity: false
    }
  }
  if (adjustmentType == "curv") {
    const is256Curve = CurvesParser.getChannelCurve(data, 0).length == 256 ? 1 : 0;
    const channelLuts = [];
    if (is256Curve == 0) {
      const masterCurveTable = buildCurveTable(CurvesParser.getChannelCurve(data, 0), 256);
      for (let lutIdx = 1; lutIdx < 4; lutIdx++) {
        const channelTable = buildCurveTable(CurvesParser.getChannelCurve(data, lutIdx), 256);
        channelLuts.push(applyLutToChannel(channelTable, masterCurveTable))
      }
    } else {
      const rawChannelCurves = [];
      for (let lutIdx = 0; lutIdx < 4; lutIdx++) {
        const channelLut = new Uint8Array(256);
        rawChannelCurves.push(channelLut);
        const curveData = CurvesParser.getChannelCurve(data, lutIdx);
        for (let channelIdx = 0; channelIdx < 256; channelIdx++) channelLut[channelIdx] = curveData[channelIdx]
      }
      for (let lutIdx = 1; lutIdx < 4; lutIdx++) channelLuts.push(applyLutToChannel(rawChannelCurves[lutIdx], rawChannelCurves[0]))
    }
    result = {
      type: shaderTypes.LookupTable,
      lutR: channelLuts[0],
      lutG: channelLuts[1],
      lutB: channelLuts[2],
      toGray: false,
      preserveLuminosity: false
    }
  }
  if (adjustmentType == "expA") {
    const expsDescriptor = data.Exps;
    const offsetParam = data.Ofst;
    const gammaParam = data.gammaCorrection;
    const exposureVal = expsDescriptor ? expsDescriptor.v : 0;
    const offsetVal = offsetParam ? offsetParam.v : 0;
    const gammaVal = gammaParam ? gammaParam.v : 1;
    const lut = new Uint8Array(256);
    for (let lutIdx = 0; lutIdx < 256; lutIdx++) {
      let pixelNorm = lutIdx / 255;
      const offsetPow = Math.pow(Math.abs(offsetVal), 1 / (Math.PI / 2));
      if (offsetVal > 0) {
        pixelNorm = Math.max(offsetVal / Math.E, pixelNorm);
        pixelNorm = pixelNorm * Math.exp(offsetVal / 1.75 + exposureVal / Math.PI);
        pixelNorm = (1 - offsetPow) * pixelNorm + offsetPow * 1
      } else {
        pixelNorm = pixelNorm * Math.exp(-offsetVal * 1.75 + exposureVal / Math.PI);
        pixelNorm = pixelNorm + -offsetPow * 1.14
      }
      pixelNorm = Math.pow(pixelNorm, 1 / gammaVal);
      pixelNorm = Math.max(0, Math.min(1, pixelNorm));
      lut[lutIdx] = Math.round(pixelNorm * 255)
    }
    result = {
      type: shaderTypes.LookupTable,
      lutR: lut,
      lutG: lut,
      lutB: lut,
      toGray: false,
      preserveLuminosity: false
    }
  }
  if (adjustmentType == "vibA") {
    result = {
      type: shaderTypes.Vibrance,
      vibranceSat: [data.vibrance ? data.vibrance.v : 0, data.Strt ? data.Strt.v : 0]
    }
  }
  if (adjustmentType == "hue2") {
    const hueLookup = [];
    const satLookup = [];
    const lightLookup = [];
    const isColorize = data.Clrz ? data.Clrz.v : false;
    for (let lutIdx = 0; lutIdx < 256; lutIdx++) {
      hueLookup[lutIdx] = lutIdx / 255;
      satLookup[lutIdx] = 0;
      lightLookup[lutIdx] = 0
    }
    const masterChannel = HueSaturationParser.getChannelData(data, 0);
    const masterSatPow = AdjustmentEngine.satPow(masterChannel[1] / 100);
    if (isColorize) {
      const colorizeHue = masterChannel[0] / 360;
      for (let lutIdx = 0; lutIdx < 256; lutIdx++) {
        hueLookup[lutIdx] = colorizeHue;
        satLookup[lutIdx] = masterSatPow
      }
    } else {
      for (let lutIdx = 0; lutIdx < 256; lutIdx++) {
        let hue = hueLookup[lutIdx];
        hueLookup[lutIdx] += masterChannel[0] / 360;
        for (let channelIdx = 0; channelIdx < 6; channelIdx++) {
          const channelData = HueSaturationParser.getChannelData(data, channelIdx + 1);
          const hslShift = channelData.hslShift;
          let bounds = channelData.bounds;
          let weight = 0;
          for (let boundIdx = 1; boundIdx < 4; boundIdx++)
            if (bounds[boundIdx] < bounds[0]) bounds[boundIdx] += 360;
          const boundStart = bounds[0];
          const boundRampEnd = bounds[1];
          const boundFallStart = bounds[2];
          const boundEnd = bounds[3];
          let hueDeg = hue * 360;
          if (hueDeg < bounds[0]) hueDeg += 360;
          weight = hueRangeWeight(hueDeg, boundStart, boundRampEnd, boundFallStart, boundEnd);
          const satPowVal = AdjustmentEngine.satPow(hslShift[1] / 100);
          hueLookup[lutIdx] += weight * hslShift[0] / 360;
          satLookup[lutIdx] += weight * satPowVal;
          lightLookup[lutIdx] += weight * hslShift[2] / 100
        }
      }
      for (let lutIdx = 0; lutIdx < 256; lutIdx++) {
        satLookup[lutIdx] = (1 + satLookup[lutIdx]) * (1 + masterSatPow) - 1;
        lightLookup[lutIdx] = Math.max(-1, Math.min(1, lightLookup[lutIdx]))
      }
    }
    const hueLut = new Uint8Array(256);
    const satLut = new Uint8Array(256);
    const lightLut = new Uint8Array(256);
    for (let lutIdx = 0; lutIdx < 256; lutIdx++) {
      let finalHue = hueLookup[lutIdx];
      let finalSat = satLookup[lutIdx];
      let finalLight = lightLookup[lutIdx];
      if (finalHue > 1) finalHue--;
      if (finalHue < 0) finalHue++;
      finalSat = AdjustmentEngine.satPowInverse(finalSat);
      finalSat = (1 + finalSat) * .5;
      finalLight = (1 + finalLight) * .5;
      hueLut[lutIdx] = Math.round(255 * finalHue);
      satLut[lutIdx] = Math.round(255 * finalSat);
      lightLut[lutIdx] = Math.round(255 * finalLight)
    }
    const colorizeLightness = masterChannel[2] / 100;
    const absColorizeLightness = colorizeLightness < 0 ? -colorizeLightness : colorizeLightness;
    const colorizeDir = colorizeLightness < 0 ? 0 : 1;
    result = {
      type: shaderTypes.HueSat,
      hueLut: hueLut,
      satLut: satLut,
      lightLut: lightLut,
      colorizeA: absColorizeLightness * colorizeDir,
      colorizeB: 1 - absColorizeLightness,
      masterLightness: masterChannel[2] / 100,
      colorizeMode: isColorize ? 1 : 0
    }
  }
  if (adjustmentType == "nvrt") {
    const nvrtLut = new Uint8Array(256);
    for (let lutIdx = 0; lutIdx < 256; lutIdx++) nvrtLut[lutIdx] = 255 - lutIdx;
    result = {
      type: shaderTypes.LookupTable,
      lutR: nvrtLut,
      lutG: nvrtLut,
      lutB: nvrtLut,
      toGray: false,
      preserveLuminosity: false
    }
  }
  if (adjustmentType == "post") {
    const levels = data.Lvls.v;
    const postLut = new Uint8Array(256);
    const step = levels / 255.001;
    const scale = 255 / (levels - 1);
    for (let lutIdx = 0; lutIdx < 256; lutIdx++) postLut[lutIdx] = Math.floor(lutIdx * step) * scale;
    result = {
      type: shaderTypes.LookupTable,
      lutR: postLut,
      lutG: postLut,
      lutB: postLut,
      toGray: false,
      preserveLuminosity: false
    }
  }
  if (adjustmentType == "grdm") {
    const gradDescriptor = data.Grad.v;
    const reverseFlag = data.Rvrs;
    const colorStops = parseColorStops(gradDescriptor.Clrs.v, 0, 0);
    const lutSize = 1024;
    const gradientLut = buildGradientLut(gradDescriptor, colorStops, lutSize, reverseFlag ? reverseFlag.v : false);
    const redChannel = allocBuffer(lutSize);
    const greenChannel = allocBuffer(lutSize);
    const blueChannel = allocBuffer(lutSize);
    extractChannelByte(gradientLut, redChannel, 0);
    extractChannelByte(gradientLut, greenChannel, 1);
    extractChannelByte(gradientLut, blueChannel, 2);
    result = {
      type: shaderTypes.LookupTable,
      lutR: redChannel,
      lutG: greenChannel,
      lutB: blueChannel,
      toGray: true,
      preserveLuminosity: false
    }
  }
  if (adjustmentType == "selc") {
    const selcMatrix = new Float32Array(9 * 3 * 2);
    const isAbsolute = data.Mthd ? data.Mthd.v.CrcM == "Absl" : false;
    for (let channelIdx = 0; channelIdx < 9; channelIdx++) {
      const matrixOffset = channelIdx * 6;
      const channelValues = SelectiveColorParser.extract(data, channelIdx);
      const cyanVal = channelValues[0] / 100;
      const magentaVal = channelValues[1] / 100;
      const yellowVal = channelValues[2] / 100;
      const fuzziness = channelValues[3] / 100;
      if (isAbsolute) {
        selcMatrix[matrixOffset] = selcMatrix[matrixOffset + 1] = selcMatrix[matrixOffset + 2] = 1;
        selcMatrix[matrixOffset + 3] = cyanVal * (1 + fuzziness) + fuzziness;
        selcMatrix[matrixOffset + 4] = magentaVal * (1 + fuzziness) + fuzziness;
        selcMatrix[matrixOffset + 5] = yellowVal * (1 + fuzziness) + fuzziness
      } else {
        selcMatrix[matrixOffset + 0] = (1 + cyanVal) * (1 + fuzziness);
        selcMatrix[matrixOffset + 1] = (1 + magentaVal) * (1 + fuzziness);
        selcMatrix[matrixOffset + 2] = (1 + yellowVal) * (1 + fuzziness)
      }
    }
    result = {
      type: shaderTypes.SelectiveColor,
      selcMatrix: selcMatrix
    }
  }
  if (adjustmentType == "blwh") {
    const colorKeys = "Rd Yllw Grn Cyn Bl Mgnt".split(" ");
    const colorValues = [];
    let tintLower = 0;
    let tintUpper = 0;
    for (let lutIdx = 0; lutIdx < 6; lutIdx++) colorValues.push(data[colorKeys[lutIdx]].v);
    colorValues.push(data.useTint.v, data.tintColor.v);
    const hueWeights = [];
    for (let lutIdx = 0; lutIdx < 6; lutIdx++) hueWeights.push((colorValues[lutIdx] - 50) / 50);
    const tintRgb = psdColorToRgb(colorValues[7]);
    tintRgb.h /= 255;
    tintRgb.l /= 255;
    tintRgb.O /= 255;
    const tintHsv = rgbToHsv(tintRgb.h, tintRgb.l, tintRgb.O);
    const tintLum = rgbLuminance(hslToRgb(tintHsv.hue, 1, .5));
    const tintSat = tintHsv.saturation * tintHsv.value;
    if (tintLum == .5) tintLower = tintUpper = .5;
    else {
      tintLower = tintSat * (.5 - tintLum) / (.5 / tintLum - 1);
      tintUpper = 1 - tintSat * (.5 - tintLum) - 1 / (2 * (1 - tintLum));
      tintUpper /= 1 - 1 / (2 * (1 - tintLum))
    }
    result = {
      type: shaderTypes.BlackWhite,
      hueWeights: hueWeights,
      useTint: colorValues[6] ? 1 : 0,
      tintHue: tintHsv.hue,
      tintLum: tintLum,
      tintSat: tintSat,
      tintLower: tintLower,
      tintUpper: tintUpper
    }
  }
  if (adjustmentType == "blnc") {
    const colorBalance = [];
    const toneKeys = ["ShdL", "MdtL", "HghL"];
    for (let lutIdx = 0; lutIdx < 3; lutIdx++) {
      if (data[toneKeys[lutIdx]] == null) {
        colorBalance[lutIdx] = [0, 0, 0];
        continue
      }
      const toneValues = data[toneKeys[lutIdx]].v;
      const redShift = toneValues[0].v / 100;
      const greenShift = toneValues[1].v / 100;
      const blueShift = toneValues[2].v / 100;
      const lumPreserve = data.PrsL == null || data.PrsL.v ? (Math.min(redShift, greenShift, blueShift) + Math.max(redShift, greenShift, blueShift)) / 2 : 0;
      colorBalance[lutIdx] = [redShift - lumPreserve, greenShift - lumPreserve, blueShift - lumPreserve]
    }
    const blncLuts = [allocBuffer(256), allocBuffer(256), allocBuffer(256)];
    for (let channelIdx = 0; channelIdx < 3; channelIdx++)
      for (let lutIdx = 0; lutIdx < 256; lutIdx++) {
        let pixelVal = lutIdx * (1 / 255);
        let curveVal = 0;
        let toneShift = 0;
        let absShift = 0;
        toneShift = colorBalance[2][channelIdx];
        absShift = Math.abs(toneShift);
        if (toneShift < 0) curveVal = Math.pow(pixelVal, Math.SQRT2);
        else curveVal = 1.63 * (Math.pow(pixelVal + .04, .5) - .2);
        pixelVal = absShift * curveVal + (1 - absShift) * pixelVal;
        toneShift = colorBalance[1][channelIdx];
        absShift = Math.abs(toneShift);
        if (toneShift < 0) curveVal = Math.pow(pixelVal, 2);
        else curveVal = Math.min(2.35 * (Math.pow(pixelVal + .09, .5) - .3), Math.pow(pixelVal, 1 / 2));
        pixelVal = absShift * curveVal + (1 - absShift) * pixelVal;
        toneShift = colorBalance[0][channelIdx];
        absShift = Math.abs(toneShift);
        if (toneShift < 0) curveVal = pixelVal < .4 ? 0 : Math.pow((pixelVal - .4) / .6, Math.SQRT2);
        else curveVal = Math.pow(pixelVal, Math.SQRT2 / 2);
        pixelVal = absShift * curveVal + (1 - absShift) * pixelVal;
        pixelVal = Math.max(0, Math.min(1, pixelVal));
        blncLuts[channelIdx][lutIdx] = Math.round(pixelVal * 255)
      }
    result = {
      type: shaderTypes.LookupTable,
      lutR: blncLuts[0],
      lutG: blncLuts[1],
      lutB: blncLuts[2],
      toGray: false,
      preserveLuminosity: false
    }
  }
  if (adjustmentType == "phfl") {
    const filterColorRgb = psdColorToRgb(data.Clr.v);
    const filterColorNorm = [filterColorRgb.h / 255, filterColorRgb.l / 255, filterColorRgb.O / 255];
    const density = data.Dnst.v / 100;
    const phflLuts = [allocBuffer(256), allocBuffer(256), allocBuffer(256)];
    for (let channelIdx = 0; channelIdx < 3; channelIdx++)
      for (let lutIdx = 0; lutIdx < 256; lutIdx++) {
        let pixelVal = lutIdx * (1 / 255);
        let filteredVal = pixelVal * filterColorNorm[channelIdx];
        filteredVal = Math.max(0, Math.min(1, filteredVal));
        pixelVal = density * filteredVal + (1 - density) * pixelVal;
        phflLuts[channelIdx][lutIdx] = Math.round(pixelVal * 255)
      }
    result = {
      type: shaderTypes.LookupTable,
      lutR: phflLuts[0],
      lutG: phflLuts[1],
      lutB: phflLuts[2],
      toGray: false,
      preserveLuminosity: data.PrsL.v
    }
  }
  if (adjustmentType == "thrs") {
    const thrsLut = allocBuffer(256);
    for (let lutIdx = data.Lvl.v; lutIdx < 256; lutIdx++) thrsLut[lutIdx] = 255;
    result = {
      type: shaderTypes.LookupTable,
      lutR: thrsLut,
      lutG: thrsLut,
      lutB: thrsLut,
      toGray: true,
      preserveLuminosity: false
    }
  }
  if (adjustmentType == "mixr") {
    const mixerResult = AdjustmentEngine.parseChannelMixer(data);
    const mixMatrix = [];
    for (let lutIdx = 0; lutIdx < mixerResult.channelValues.length; lutIdx++)
      if (lutIdx % 5 != 3) mixMatrix.push(mixerResult.channelValues[lutIdx] / 100);
    if (mixerResult.isMonochrome) {
      for (let channelIdx = 1; channelIdx < 3; channelIdx++)
        for (let mixRow = 0; mixRow < 4; mixRow++) mixMatrix[channelIdx * 4 + mixRow] = mixMatrix[mixRow]
    }
    result = {
      type: shaderTypes.ColorMatrix,
      matrix: mixMatrix
    }
  }
  if (adjustmentType == "rplc") {
    const labMinDesc = data.Mnm.v;
    const labMaxDesc = data.Mxm.v;
    result = {
      type: shaderTypes.ReplaceColor,
      labMin: [labMinDesc.Lmnc.v, labMinDesc.A.v, labMinDesc.B.v],
      labMax: [labMaxDesc.Lmnc.v, labMaxDesc.A.v, labMaxDesc.B.v],
      shift: [data.H.v / 360, data.Strt.v / 100, data.Lght.v / 100],
      fuzziness: data.Fzns.v / 200
    }
  }
  if (adjustmentType == "clrL" && data.profile) {
    const profileData = new Uint8Array(data.profile.v);
    const iccProfile = ICC.parse(profileData.buffer);
    const lutResolution = 17;
    const sampledLut = ICC.buildSampledLUT(iccProfile, lutResolution);
    result = {
      type: shaderTypes.IccLut,
      pixBuf: ICC.lutToRGBA8(sampledLut, lutResolution),
      sampledLut: sampledLut,
      lutResolution: lutResolution
    }
  }
  return result
};
/** Auto-levels mode index for Levels descriptors, or -1 when not applicable. */
AdjustmentEngine.getAutoLevelsMode = function(adjustmentType, data) {
  let mode = -1;
  if (adjustmentType != "levl" || data == null) mode = -1;
  else if (data.Auto) mode = 0;
  else if (data.AuCo) mode = 1;
  else if (data.autoBlackWhite) mode = 2;
  return mode
};
/** Map signed saturation (-1..1) into the hue-sat shader power curve. */
AdjustmentEngine.satPow = function(saturation) {
  if (saturation < 0) return saturation;
  return Math.pow(Math.tan(Math.PI / 2 * saturation), 1.3)
};
AdjustmentEngine.satPowInverse = function(saturation) {
  if (saturation < 0) return saturation;
  saturation = Math.pow(saturation, 1 / 1.3);
  return Math.atan2(saturation, 1) / (Math.PI / 2)
};
// Private CPU apply kernels.

function applyIccLutSoftware(shaderOptions, srcBuffer, dstBuffer) {
  const iccLutData = shaderOptions.sampledLut;
  const iccLutRes = shaderOptions.lutResolution;
  ICC.applyLUT(iccLutData, iccLutRes, srcBuffer, dstBuffer);
  const pixelCount = srcBuffer.length;
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx += 4) dstBuffer[pixelIdx + 3] = srcBuffer[pixelIdx + 3]
}

function applyColorMatrixSoftware(shaderOptions, srcBuffer, dstBuffer) {
  transformInterleaved(srcBuffer, dstBuffer, shaderOptions.matrix);
}

function applyBlackWhiteSoftware(shaderOptions, srcBuffer, dstBuffer) {
  const tintSat = shaderOptions.tintSat;
  const tintLum = shaderOptions.tintLum;
  let tintLower = shaderOptions.tintLower;
  let tintUpper = shaderOptions.tintUpper;
  const pixelCount = srcBuffer.length;
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx += 4) {
    let rVal = srcBuffer[pixelIdx] * (1 / 255);
    let gVal = srcBuffer[pixelIdx + 1] * (1 / 255);
    let bVal = srcBuffer[pixelIdx + 2] * (1 / 255);
    const hsl = rgbToHsl(rVal, gVal, bVal);
    let hueAccum = 0;
    for (let hueBand = 0; hueBand < 6; hueBand++) hueAccum += Math.min(1, 1.7 * (1 - hsl.lightness)) * hsl.saturation * shaderOptions.hueWeights[hueBand] * AdjustmentEngine.hueWeight(hsl.hue, hueBand * (1 / 6));
    const lum = Math.max(0, Math.min(1, hsl.lightness * (1 + hueAccum)));
    if (shaderOptions.useTint == 1) {
      let tintedLum = 0;
      if (lum < tintLower) tintedLum = lum * (.5 / tintLum);
      else if (lum < tintUpper) tintedLum = lum + tintSat * (.5 - tintLum);
      else tintedLum = 1 - (1 - lum) * .5 / (1 - tintLum);
      hsl.hue = shaderOptions.tintHue;
      hsl.saturation = Math.min(1, tintSat + 3 * tintSat * Math.abs(lum - .5 * (tintLower + tintUpper)));
      hsl.lightness = tintedLum
    } else {
      hsl.hue = 0;
      hsl.saturation = 0;
      hsl.lightness = lum
    }
    const rgb = hslToRgb(hsl.hue, hsl.saturation, hsl.lightness);
    dstBuffer[pixelIdx] = Math.round(rgb.h * 255);
    dstBuffer[pixelIdx + 1] = Math.round(rgb.l * 255);
    dstBuffer[pixelIdx + 2] = Math.round(rgb.O * 255)
  }
}

function applySelectiveColorSoftware(shaderOptions, srcBuffer, dstBuffer) {
  const selcMat = shaderOptions.selcMatrix;
  const pixelCount = srcBuffer.length;
  const invByte = 1 / 255;
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx += 4) {
    let rVal = srcBuffer[pixelIdx] * invByte;
    let gVal = srcBuffer[pixelIdx + 1] * invByte;
    let bVal = srcBuffer[pixelIdx + 2] * invByte;
    const hsl = rgbToHsl(rVal, gVal, bVal);
    let maxRgb = Math.max(rVal, Math.max(gVal, bVal));
    let minRgb = Math.min(rVal, Math.min(gVal, bVal));
    let cyanComp = 1 - rVal;
    let magentaComp = 1 - gVal;
    let yellowComp = 1 - bVal;
    let cyanDelta = 0;
    let magentaDelta = 0;
    let yellowDelta = 0;
    for (let hueBand = 0; hueBand < 9; hueBand++) {
      const matOff = hueBand * 6;
      let colorWeight = 0;
      if (selcMat[matOff] == 1 && selcMat[matOff + 1] == 1 && selcMat[matOff + 2] == 1 && selcMat[matOff + 3] == 0 && selcMat[matOff + 4] == 0 && selcMat[matOff + 5] == 0) continue;
      const newCyan = cyanComp * selcMat[matOff] + selcMat[matOff + 3];
      const newMagenta = magentaComp * selcMat[matOff + 1] + selcMat[matOff + 4];
      const newYellow = yellowComp * selcMat[matOff + 2] + selcMat[matOff + 5];
      if (hueBand < 6) colorWeight = AdjustmentEngine.hueWeight(hsl.hue, hueBand * (1 / 6)) * hsl.saturation * 2 * Math.min(hsl.lightness, 1 - hsl.lightness);
      else if (hueBand == 6) colorWeight = Math.max(0, minRgb - .5) * 2;
      else if (hueBand == 7) colorWeight = 1 - (Math.abs(maxRgb - .5) + Math.abs(minRgb - .5));
      else colorWeight = Math.max(0, .5 - maxRgb) * 2;
      cyanDelta += (Math.max(0, Math.min(1, newCyan)) - cyanComp) * colorWeight;
      magentaDelta += (Math.max(0, Math.min(1, newMagenta)) - magentaComp) * colorWeight;
      yellowDelta += (Math.max(0, Math.min(1, newYellow)) - yellowComp) * colorWeight
    }
    cyanComp = Math.max(0, Math.min(1, cyanComp + cyanDelta));
    magentaComp = Math.max(0, Math.min(1, magentaComp + magentaDelta));
    yellowComp = Math.max(0, Math.min(1, yellowComp + yellowDelta));
    rVal = 1 - cyanComp;
    gVal = 1 - magentaComp;
    bVal = 1 - yellowComp;
    dstBuffer[pixelIdx] = Math.round(rVal * 255);
    dstBuffer[pixelIdx + 1] = Math.round(gVal * 255);
    dstBuffer[pixelIdx + 2] = Math.round(bVal * 255)
  }
}

function applyLookupTableSoftware(shaderOptions, srcBuffer, dstBuffer) {
  applyColorCurves(srcBuffer, dstBuffer, shaderOptions.lutR, shaderOptions.lutG, shaderOptions.lutB, shaderOptions.toGray, shaderOptions.preserveLuminosity)
  
}

function applyHueSatSoftware(shaderOptions, srcBuffer, dstBuffer) {
  const srcPixels = new Uint32Array(srcBuffer.buffer);
  const dstPixels = new Uint32Array(dstBuffer.buffer);
  const pixelCount = srcPixels.length;
  if (AdjustmentEngine.satPowLut == null) {
    AdjustmentEngine.satPowLut = new Float64Array(256);
    for (let pixelIdx = 0; pixelIdx < 256; pixelIdx++) AdjustmentEngine.satPowLut[pixelIdx] = AdjustmentEngine.satPow(-1 + 2 * pixelIdx / 255)
  }
  const satPowLut = AdjustmentEngine.satPowLut;
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    const packed = srcPixels[pixelIdx];
    let rVal = (packed & 255) * (1 / 255);
    let gVal = (packed >>> 8 & 255) * (1 / 255);
    let bVal = (packed >>> 16 & 255) * (1 / 255);
    const alpha = packed >>> 24;
    let minRgb = Math.min(rVal, gVal, bVal);
    let maxRgb = Math.max(rVal, gVal, bVal);
    let hue = 0;
    let satVal = 0;
    let lightness = 0;
    hue = rgbToHsl(rVal, gVal, bVal).hue;
    let lutIdx = ~~(hue * 255 + .5);
    const newHue = shaderOptions.hueLut[lutIdx] * (1 / 255);
    let satShift = shaderOptions.satLut[lutIdx] * (1 / 255) * 2 - 1;
    const lightShift = shaderOptions.lightLut[lutIdx] * (1 / 255) * 2 - 1;
    let lightAnchor = -lightShift;
    let lightBase = minRgb;
    if (0 < lightShift) {
      lightAnchor = lightShift;
      lightBase = maxRgb
    }
    const colorizeA = shaderOptions.colorizeA + shaderOptions.colorizeB * lightAnchor * lightBase;
    const colorizeB = shaderOptions.colorizeB * (1 - lightAnchor);
    rVal = colorizeA + colorizeB * rVal;
    gVal = colorizeA + colorizeB * gVal;
    bVal = colorizeA + colorizeB * bVal;
    maxRgb = Math.max(rVal, gVal, bVal);
    minRgb = Math.min(rVal, gVal, bVal);
    lightness = (maxRgb + minRgb) * .5;
    if (maxRgb != minRgb) {
      const chromaRange = maxRgb - minRgb;
      satVal = lightness > .5 ? chromaRange / (2 - (maxRgb + minRgb)) : chromaRange / (maxRgb + minRgb)
    }
    let finalSat = satShift;
    if (shaderOptions.colorizeMode == 0) {
      satShift = satPowLut[Math.floor((1 + satShift) * 127.5)];
      finalSat = Math.min(satVal * (1 + satShift), 1)
    }
    const rgb = hslToRgb(newHue, finalSat, lightness);
    rVal = rgb.h;
    gVal = rgb.l;
    bVal = rgb.O;
    dstPixels[pixelIdx] = alpha << 24 | bVal * 255 << 16 | gVal * 255 << 8 | rVal * 255
  }
}

function applyReplaceColorSoftware(shaderOptions, srcBuffer, dstBuffer) {
  copyBuffer(srcBuffer, dstBuffer);
  const srcPixels = new Uint32Array(srcBuffer.buffer);
  const dstPixels = new Uint32Array(dstBuffer.buffer);
  const pixelCount = srcPixels.length;
  const fuzziness = shaderOptions.fuzziness;
  const invFuzziness = 1 / fuzziness;

  const labMin = {
    labL: shaderOptions.labMin[0],
    labA: shaderOptions.labMin[1],
    labB: shaderOptions.labMin[2]
  };

  const labMax = {
    labL: shaderOptions.labMax[0],
    labA: shaderOptions.labMax[1],
    labB: shaderOptions.labMax[2]
  };

  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    const packed = srcPixels[pixelIdx];
    const rByte = packed & 255;
    const gByte = packed >>> 8 & 255;
    const bByte = packed >>> 16 & 255;
    let rVal = rByte * (1 / 255);
    let gVal = gByte * (1 / 255);
    let bVal = bByte * (1 / 255);
    const alpha = packed >>> 24;
    const labColor = rgbToLab(rByte, gByte, bByte);
    const similarity = labSimilarity(labColor, labMin, labMax, fuzziness, invFuzziness);
    if (similarity == 0) continue;
    const hsl = rgbToHsl(rVal, gVal, bVal);
    const newHue = 2 + hsl.hue + similarity * shaderOptions.shift[0];
    hsl.hue = newHue - ~~newHue;
    hsl.saturation = Math.max(0, Math.min(1, hsl.saturation + similarity * shaderOptions.shift[1]));
    hsl.lightness = Math.max(0, Math.min(1, hsl.lightness + similarity * shaderOptions.shift[2]));
    const rgb = hslToRgb(hsl.hue, hsl.saturation, hsl.lightness);
    rVal = rgb.h;
    gVal = rgb.l;
    bVal = rgb.O;
    dstPixels[pixelIdx] = alpha << 24 | bVal * 255 << 16 | gVal * 255 << 8 | rVal * 255
  }
}

function applyVibranceSoftware(shaderOptions, srcBuffer, dstBuffer) {
  const srcPixels = new Uint32Array(srcBuffer.buffer);
  const dstPixels = new Uint32Array(dstBuffer.buffer);
  const pixelCount = srcPixels.length;
  const vibranceAmount = shaderOptions.vibranceSat[0] / 100;
  const satAmount = shaderOptions.vibranceSat[1] / 100;
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    const packed = srcPixels[pixelIdx];
    let rVal = (packed & 255) * (1 / 255);
    let gVal = (packed >>> 8 & 255) * (1 / 255);
    let bVal = (packed >>> 16 & 255) * (1 / 255);
    const alpha = packed >>> 24;
    const hsv = rgbToHsv(rVal, gVal, bVal);
    let hue = hsv.hue;
    let saturation = hsv.saturation;
    const value = hsv.value;
    const skinToneRange = 45 / 360;
    const skinBias = hue < skinToneRange ? Math.cos(Math.PI / 2 * (hue - skinToneRange / 2) / (skinToneRange / 2)) : 0;
    saturation = saturation + .2 * (1 - .4 * skinBias) * vibranceAmount * Math.max(0, Math.sin(saturation * Math.PI));
    saturation = saturation * (1 + satAmount);
    saturation = Math.max(0, Math.min(1, saturation));
    const rgb = hsvToRgb(hue, saturation, value);
    rVal = rgb.h;
    gVal = rgb.l;
    bVal = rgb.O;
    dstPixels[pixelIdx] = alpha << 24 | bVal * 255 << 16 | gVal * 255 << 8 | rVal * 255
  }
}

/**
 * Apply shader options on the CPU (or via a temporary GPU path when beneficial).
 */
AdjustmentEngine.applySoftware = function(shaderOptions, srcBuffer, dstBuffer, bounds) {
  const types = AdjustmentShaderType;
  if (LayerSystem.webglEnabled && bounds.area() > 300 * 300 && shaderOptions.type != types.LookupTable && shaderOptions.type != types.IccLut) {
    bounds = bounds.clone();
    bounds.x = bounds.y = 0;
    const pooledTex = LayerSystem.getPooledTexture(0, bounds.width, bounds.height);
    pooledTex.set(srcBuffer);
    LayerSystem.bindRenderTarget(pooledTex, bounds);
    pooledTex.saveBackup(bounds);
    AdjustmentEngine.applyGpu(shaderOptions, pooledTex.backupTexture, bounds);
    pooledTex.get(dstBuffer);
    return
  }
  if (shaderOptions.type == types.IccLut) applyIccLutSoftware(shaderOptions, srcBuffer, dstBuffer);
  if (shaderOptions.type == types.ColorMatrix) applyColorMatrixSoftware(shaderOptions, srcBuffer, dstBuffer);
  if (shaderOptions.type == types.BlackWhite) applyBlackWhiteSoftware(shaderOptions, srcBuffer, dstBuffer);
  if (shaderOptions.type == types.SelectiveColor) applySelectiveColorSoftware(shaderOptions, srcBuffer, dstBuffer);
  if (shaderOptions.type == types.LookupTable) applyLookupTableSoftware(shaderOptions, srcBuffer, dstBuffer);
  if (shaderOptions.type == types.HueSat) applyHueSatSoftware(shaderOptions, srcBuffer, dstBuffer);
  if (shaderOptions.type == types.ReplaceColor) applyReplaceColorSoftware(shaderOptions, srcBuffer, dstBuffer);
  if (shaderOptions.type == types.Vibrance) applyVibranceSoftware(shaderOptions, srcBuffer, dstBuffer);
};
AdjustmentEngine.applyGpu = function(shaderOptions, srcTexture, bounds) {
  LayerSystem.adjLayerRenderer.render(shaderOptions, srcTexture)
};
AdjustmentEngine.hueWeight = function(hueAngle, rangeCenter) {
  const hueDelta = hueDiff(rangeCenter, hueAngle) * 6;
  return Math.max(0, Math.min(1, hueDelta < 0 ? 1 + hueDelta : 1 - hueDelta))
};
AdjustmentEngine.names = ADJUSTMENT_NAMES;
AdjustmentEngine.noGpuTypes = ["expA", "clrL", "selc"];
AdjustmentEngine.hueSatColorLabels = [
  "colour.labels.red",
  "colour.labels.yellow",
  "colour.labels.green",
  "colour.labels.cyan",
  "colour.labels.blue",
  "colour.labels.magenta"
];
AdjustmentEngine.cmykColorLabels = [
  "colour.labels.cyan",
  "colour.labels.magenta",
  "colour.labels.yellow",
  "colour.labels.black"
];
AdjustmentEngine.rgbColorLabels = [
  "colour.labels.red",
  "colour.labels.green",
  "colour.labels.blue"
];
AdjustmentEngine.descriptorKeyMap = {
  BrgC: "brit",
  Lvls: "levl",
  Crvs: "curv",
  Exps: "expA",
  vibrance: "vibA",
  HStr: "hue2",
  ClrB: "blnc",
  BanW: "blwh",
  photoFilter: "phfl",
  Invr: "nvrt",
  Pstr: "post",
  Thrs: "thrs",
  GrMp: "grdm",
  SlcC: "selc",
  ChnM: "mixr",
  colorLookup: "clrL",
  rplc: "rplc"
};
AdjustmentEngine.figmaDescriptorKeys = function() {
  const keyMap = JSON.parse(JSON.stringify(AdjustmentEngine.descriptorKeyMap));
  delete keyMap.GrMp;
  keyMap.GdMp = "grdm";
  return keyMap
}();
AdjustmentEngine.eventNames = {
  brit: "brightnessEvent",
  levl: "levels",
  curv: "curves",
  expA: "exposure",
  vibA: "vibrance",
  hue2: "hueSaturation",
  blnc: "colorBalance",
  blwh: "blackAndWhite",
  phfl: "photoFilter",
  mixr: "channelMixer",
  clrL: "colorLookup",
  nvrt: "invert",
  post: "posterization",
  thrs: "thresholdClassEvent",
  grdm: "gradientMapEvent",
  selc: "selectiveColor",
  rplc: "replaceColor"
};
AdjustmentEngine.keys = {
  levl: [KeyboardHandler.Ctrl, KeyboardHandler.KeyL],
  curv: [KeyboardHandler.Ctrl, KeyboardHandler.KeyM],
  hue2: [KeyboardHandler.Ctrl, KeyboardHandler.KeyU],
  nvrt: [KeyboardHandler.Ctrl, KeyboardHandler.KeyI],
  blnc: [KeyboardHandler.Ctrl, KeyboardHandler.KeyB]
};

const CHANNEL_MIX_KEYS = {
  Rd: 0,
  Grn: 1,
  Bl: 2,
  Cnst: 4
};

function buildChannelMixDescriptor(values, startIdx) {
  const channelMixDesc = {
    classID: "ChMx"
  };
  for (let key in CHANNEL_MIX_KEYS) channelMixDesc[key] = {
    t: "UntF",
    v: {
      type: "#Prc",
      val: values[startIdx + CHANNEL_MIX_KEYS[key]]
    }
  };
  return {
    t: "Objc",
    v: channelMixDesc
  }
}

function extractChannelMixValues(channelDesc, values, startIdx) {
  for (let key in CHANNEL_MIX_KEYS)
    if (channelDesc[key]) values[startIdx + CHANNEL_MIX_KEYS[key]] = channelDesc[key].v.val
}

/** Serialize channel-mixer UI state into a mixr descriptor. */
AdjustmentEngine.channelMixerToDescriptor = function(mixerData) {
  const descriptor = createChannelMixerDefault();
  descriptor.Mnch = {
    t: "bool",
    v: mixerData.isMonochrome
  };
  if (mixerData.isMonochrome) descriptor.Gry = buildChannelMixDescriptor(mixerData.channelValues, 0);
  else {
    descriptor.Rd = buildChannelMixDescriptor(mixerData.channelValues, 0);
    descriptor.Grn = buildChannelMixDescriptor(mixerData.channelValues, 5);
    descriptor.Bl = buildChannelMixDescriptor(mixerData.channelValues, 10)
  }
  return descriptor
};
/** Parse a channel-mixer descriptor into monochrome flag + 20 mix coefficients. */
AdjustmentEngine.parseChannelMixer = function(descriptor) {
  let result = {
    isMonochrome: false,
    channelValues: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  };
  if (descriptor.Mnch && descriptor.Mnch.v) result.isMonochrome = true;
  if (result.isMonochrome) extractChannelMixValues(descriptor.Gry.v, result.channelValues, 0);
  else {
    extractChannelMixValues(descriptor.Rd.v, result.channelValues, 0);
    extractChannelMixValues(descriptor.Grn.v, result.channelValues, 5);
    extractChannelMixValues(descriptor.Bl.v, result.channelValues, 10)
  }
  return result
};

export { AdjustmentEngine };

/**
 * A fresh `ChnM` channel-mixer descriptor at its Photoshop defaults: each output
 * channel takes 100% of its own source channel and nothing else.
 * Exported so the filter registry can offer it as the `mixr` default.
 */
export function createChannelMixerDefault() {
  return {
    __name: "Channel Mixer",
    classID: "ChnM",
    presetKind: {
      t: "enum",
      v: {
        presetKindType: "presetKindDefault"
      }
    },
    Rd: {
      t: "Objc",
      v: {
        classID: "ChMx",
        Rd: {
          t: "UntF",
          v: {
            type: "#Prc",
            val: 100
          }
        }
      }
    },
    Grn: {
      t: "Objc",
      v: {
        classID: "ChMx",
        Grn: {
          t: "UntF",
          v: {
            type: "#Prc",
            val: 100
          }
        }
      }
    },
    Bl: {
      t: "Objc",
      v: {
        classID: "ChMx",
        Bl: {
          t: "UntF",
          v: {
            type: "#Prc",
            val: 100
          }
        }
      }
    }
  }
}
