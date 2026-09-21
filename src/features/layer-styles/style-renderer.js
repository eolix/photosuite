// PSD layer styles: gradients, strokes, shadows, pattern fill, and style descriptors.
import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { BlendModes } from "../../document/model/blend-modes.js";
import { generateUuid } from "../../core/uid.js";
import { LayerSystem, defaultShapeStyleParams } from "../../engine/layer-system.js";
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { findPattern } from "../../document/formats/psd/layer-data-parsers.js";
import { allocBuffer, buildMipPyramidAlpha, copyBuffer, extractChannel, fillBuffer, rgbaToGrayChannel } from "../../engine/compositing/buffer-utils.js";
import { applyLookupTable, copyChannel, copyPixels, fillScaledPatternToBuffer, patternFromImageData } from "../../engine/compositing/pixel-ops.js";
import { composite, compositeLayer } from "../../engine/compositing/compositing-ops.js";
import { invert } from "../../engine/compositing/color-math.js";
import { applyGradient, linearGradientEndpoints, psdColorToRgb } from "../../engine/compositing/psd-color-utils.js";
import { boxBlur, boxBlurByte, gaussianBlurByte, gaussianBlurFloat, gaussianBoxWidths } from "../../engine/compositing/blur.js";
import { buildCurveTable, buildToneCurveLut, padCurveLut } from "../../engine/compositing/tone-curves.js";
import { applyStrokeMask, applyStrokeNoise, computeDistanceField, positionHash } from "../../engine/compositing/distance-field-stroke.js";


function getFirstEnabledMultiFillEntry(multiFill, listKey) {
  if (multiFill == null) return null;
  const entries = multiFill[listKey].v;
  let firstEntry;
  if (entries.length != 0) {
    firstEntry = entries[0].v;
    if (!firstEntry.enab.v) firstEntry = null;
  }
  return firstEntry;
}

function createRasterStackItem(rgbaBuffer, effectRect, effectEntry, extraFields) {
  const item = {
    rgbaBuffer: rgbaBuffer,
    effectRect: effectRect,
    blendModeCode: BlendModes.fromPSD(effectEntry.Md.v.blendMode),
    blendOpacity: effectEntry.Opct.v.val / 100
  };
  if (extraFields) {
    for (let key in extraFields) item[key] = extraFields[key];
  }
  return item;
}

const LayerStyleRenderer = {};
LayerStyleRenderer.mergeMultiFillWithLayerFills = function(multiFill, layerAdd) {
  const solidColorFill = layerAdd.SoCo;
  const gradientFill = layerAdd.GdFl;
  const solidMultiFill = getFirstEnabledMultiFillEntry(multiFill, "solidFillMulti");
  const gradientMultiFill = getFirstEnabledMultiFillEntry(multiFill, "gradientFillMulti");
  if (solidMultiFill == null && gradientMultiFill == null) return [solidColorFill, gradientFill];
  const blendColors = LayerStyleRenderer.blendForegroundIntoBackground;
  if (solidColorFill && solidMultiFill && gradientMultiFill == null) {
    const mergedSolid = JSON.parse(JSON.stringify(solidColorFill));
    mergedSolid.Clr.v = blendColors(solidMultiFill.Clr.v, solidColorFill.Clr.v, solidMultiFill);
    return [mergedSolid, null]
  }
  if (gradientFill && solidMultiFill && gradientMultiFill == null) {
    var mergedGradient = JSON.parse(JSON.stringify(gradientFill));
    var colorStops = mergedGradient.Grad.v.Clrs.v;
    for (let stopIdx = 0; stopIdx < colorStops.length; stopIdx++) {
      var stopColor = colorStops[stopIdx].v.Clr;
      stopColor.v = blendColors(solidMultiFill.Clr.v, stopColor.v, solidMultiFill)
    }
    return [null, mergedGradient]
  }
  if (solidColorFill && gradientMultiFill) {
    var mergedGradient = JSON.parse(JSON.stringify(gradientMultiFill));
    var colorStops = mergedGradient.Grad.v.Clrs.v;
    for (let stopIdx = 0; stopIdx < colorStops.length; stopIdx++) {
      var stopColor = colorStops[stopIdx].v.Clr;
      stopColor.v = blendColors(stopColor.v, solidColorFill.Clr.v, gradientMultiFill)
    }
    return [null, mergedGradient]
  }
  return [solidMultiFill, gradientMultiFill]
};
LayerStyleRenderer.blendScratchBuffers = {
  foregroundRgba: allocBuffer(4),
  backgroundRgba: allocBuffer(4),
  scratchRect: new Rect(0, 0, 1, 1)
};
LayerStyleRenderer.blendForegroundIntoBackground = function(foregroundColor, backgroundColor, fillDescriptor) {
  const blendMode = BlendModes.fromPSD(fillDescriptor.Md.v.blendMode);
  const opacity = fillDescriptor.Opct.v.val / 100;
  const scratch = LayerStyleRenderer.blendScratchBuffers;
  foregroundColor = psdColorToRgb(foregroundColor);
  backgroundColor = psdColorToRgb(backgroundColor);
  scratch.foregroundRgba[0] = foregroundColor.h;
  scratch.foregroundRgba[1] = foregroundColor.l;
  scratch.foregroundRgba[2] = foregroundColor.O;
  scratch.foregroundRgba[3] = 255;
  scratch.backgroundRgba[0] = backgroundColor.h;
  scratch.backgroundRgba[1] = backgroundColor.l;
  scratch.backgroundRgba[2] = backgroundColor.O;
  scratch.backgroundRgba[3] = 255;
  composite(blendMode, scratch.foregroundRgba, scratch.scratchRect, scratch.backgroundRgba, scratch.scratchRect, scratch.scratchRect, opacity);
  return {
    classID: "RGBC",
    Rd: {
      t: "doub",
      v: scratch.backgroundRgba[0]
    },
    Grn: {
      t: "doub",
      v: scratch.backgroundRgba[1]
    },
    Bl: {
      t: "doub",
      v: scratch.backgroundRgba[2]
    }
  }
};
LayerStyleRenderer.applyColorOverlayToBuffer = function(pixelBuffer, overlayEffect, boundsRect) {
  const originalAlpha = pixelBuffer;
  pixelBuffer = pixelBuffer.slice(0);
  const blendModeCode = BlendModes.psdCodes[BlendModes.psdNames.indexOf(overlayEffect.Md.v.blendMode)];
  const overlayRgb = psdColorToRgb(overlayEffect.Clr.v);
  const packedColor = 4278190080 | Math.round(overlayRgb.O) << 16 | Math.round(overlayRgb.l) << 8 | Math.round(overlayRgb.h);
  const overlayBuffer = allocBuffer(boundsRect.area() * 4);
  fillBuffer(overlayBuffer, packedColor);
  composite(blendModeCode, overlayBuffer, boundsRect, pixelBuffer, boundsRect, boundsRect, overlayEffect.Opct.v.val / 100);
  for (let pixelIdx = 0; pixelIdx < pixelBuffer.length; pixelIdx += 4) pixelBuffer[pixelIdx + 3] = originalAlpha[pixelIdx + 3];
  return pixelBuffer
};
LayerStyleRenderer.scaleLayerEffectSizes = function(layerEffects, scaleFactor) {
  const sizeKeys = ["Sz", "blur", "Sftn", "Dstn"];
  for (let orderIdx = 0; orderIdx < LayerEffectDefs.order.length; orderIdx++) {
    const effectClassId = LayerEffectDefs.order[orderIdx];
    const effectList = layerEffects[LayerEffectDefs.effectKeys[orderIdx]].v;
    for (let entryIdx = 0; entryIdx < effectList.length; entryIdx++) {
      const effectEntry = effectList[entryIdx].v;
      for (let keyIdx = 0; keyIdx < sizeKeys.length; keyIdx++) {
        const sizeField = effectEntry[sizeKeys[keyIdx]];
        if (sizeField) {
          const oldVal = sizeField.v.val;
          let newVal = oldVal;
          newVal = Math.max(oldVal == 0 ? 0 : 1, newVal * scaleFactor);
          if (effectClassId == "ChFX") newVal = Math.min(newVal, 250);
          if (effectClassId == "ebbl") {
            if (sizeKeys[keyIdx] == "blur") newVal = Math.min(newVal, 250);
            if (sizeKeys[keyIdx] == "Sftn") newVal = Math.min(newVal, 16)
          }
          sizeField.v.val = Math.round(newVal)
        }
      }
      if (effectClassId == "ebbl" || effectClassId == "patternFill" || effectClassId == "FrFX")
        if (effectEntry.Ptrn && effectEntry.Scl) effectEntry.Scl.v.val = Math.max(1, Math.min(1e3, effectEntry.Scl.v.val * scaleFactor))
    }
  }
};
LayerStyleRenderer.buildLayerFillFromEffects = function(layer, doc, includeInnerEffects) {
  let boundsRect = new Rect(-.5, -.5, 1, 1);
  const lmfx = layer.add.lmfx;
  for (let orderIdx = 0; orderIdx < LayerEffectDefs.order.length; orderIdx++) {
    const effectClassId = LayerEffectDefs.order[orderIdx];
    const effectList = lmfx[LayerEffectDefs.effectKeys[orderIdx]].v;
    for (let entryIdx = 0; entryIdx < effectList.length; entryIdx++) {
      const effectEntry = effectList[entryIdx].v;
      let effectBounds;
      if (!effectEntry.enab.v) continue;
      var blurRadius = effectEntry.blur ? effectEntry.blur.v.val + 1 : 0;
      const chokeRatio = effectEntry.Ckmt ? effectEntry.Ckmt.v.val / 100 : 0;
      const chokePixels = Math.round(blurRadius * chokeRatio);
      if (effectClassId == "DrSh" || effectClassId == "IrSh" && includeInnerEffects) {
        effectBounds = new Rect(-.5, -.5, 1, 1);
        effectBounds.inflate(blurRadius, blurRadius);
        LayerStyleRenderer.applyGradientEffect(effectBounds, effectEntry, doc, 0)
      }
      if (effectClassId == "OrGl" || effectClassId == "IrGl" && includeInnerEffects) {
        effectBounds = new Rect(-.5, -.5, 1, 1);
        effectBounds.inflate(blurRadius, blurRadius)
      }
      if (effectClassId == "FrFX") {
        const strokePadding = LayerStyleRenderer.getFrameEffectStrokePadding(effectEntry);
        let outerPadding = strokePadding[1];
        if (includeInnerEffects) outerPadding = Math.max(strokePadding[0], outerPadding);
        effectBounds = new Rect(-.5, -.5, 1, 1);
        effectBounds.inflate(Math.ceil(outerPadding), Math.ceil(outerPadding))
      }
      if (effectClassId == "ebbl") {
        var blurRadius = effectEntry.blur.v.val;
        let bevelStyle = effectEntry.bvlS.v.BESl;
        if (bevelStyle == "Embs" || bevelStyle == "PlEb") blurRadius /= 2;
        const bevelStyleIds = ["OtrB", "InrB", "Embs", "PlEb", "strokeEmboss"];
        const bevelTechniques = ["SfBL", "PrBL", "Slmt"];
        const bevelDirections = ["In", "Out"];
        const softBevelRadius = effectEntry.bvlT.v.bvlT != "SfBL" ? blurRadius : blurRadius * .43;
        const bevelRoundRadius = Math.round(blurRadius);
        effectBounds = new Rect(-bevelRoundRadius - 1, -bevelRoundRadius - 1, 2 * bevelRoundRadius + 2, 2 * bevelRoundRadius + 2)
      }
      if (includeInnerEffects && effectClassId == "ChFX") {
        effectBounds = new Rect(-.5, -.5, 1, 1);
        effectBounds.inflate(blurRadius, blurRadius);
        const j = effectBounds.clone();
        LayerStyleRenderer.applyGradientEffect(effectBounds, effectEntry, doc, 0);
        LayerStyleRenderer.applyGradientEffect(j, effectEntry, doc, Math.PI);
        effectBounds = effectBounds.union(j)
      }
      if (effectBounds) boundsRect = boundsRect.union(effectBounds)
    }
  }
  if (boundsRect.x != Math.ceil(boundsRect.x)) {
    boundsRect.x = Math.ceil(boundsRect.x);
    boundsRect.width -= 1
  }
  if (boundsRect.y != Math.ceil(boundsRect.y)) {
    boundsRect.y = Math.ceil(boundsRect.y);
    boundsRect.height -= 1
  }
  boundsRect.width = Math.floor(boundsRect.width);
  boundsRect.height = Math.floor(boundsRect.height);
  return boundsRect
};
LayerStyleRenderer.getFrameEffectStrokePadding = function(strokeEffect) {
  let innerPadding = 0;
  let outerPadding = 0;
  const strokeAlign = strokeEffect.Styl.v.FStl;
  const strokeSize = strokeEffect.Sz.v.val;
  if (strokeAlign == "OutF") outerPadding = strokeSize;
  if (strokeAlign == "InsF") innerPadding = strokeSize;
  if (strokeAlign == "CtrF") innerPadding = outerPadding = strokeSize / 2;
  return [innerPadding, outerPadding]
};
LayerStyleRenderer.disposeEffectGpuResources = function(gpuStack) {
  if (gpuStack.all == null) return;
  for (let entryIdx = 0; entryIdx < gpuStack.all.length; entryIdx++) {
    const effectEntry = gpuStack.all[entryIdx];
    if (effectEntry.rgbaTexture) effectEntry.rgbaTexture.delete();
    if (effectEntry.innerMaskTexture) effectEntry.innerMaskTexture.delete();
    if (effectEntry.outerMaskTexture) effectEntry.outerMaskTexture.delete()
  }
};
LayerStyleRenderer.uploadEffectStackToGpu = function(gpuStack, alphaChannel, chokePadding, layerEffects, fxReferencePoint, doc, boundsRect) {
  LayerStyleRenderer.disposeEffectGpuResources(gpuStack);
  const builtStack = LayerStyleRenderer.buildLayerStyleEffectStack(layerEffects, fxReferencePoint, alphaChannel, chokePadding, doc, boundsRect);
  gpuStack.type = builtStack.type;
  gpuStack.all = builtStack.all;
  if (LayerSystem.webglEnabled)
    for (let entryIdx = 0; entryIdx < gpuStack.all.length; entryIdx++) {
      const effectEntry = gpuStack.all[entryIdx];
      effectEntry.rgbaTexture = new LayerSystem.RgbaTexture(effectEntry.effectRect.width, effectEntry.effectRect.height);
      effectEntry.rgbaTexture.set(effectEntry.rgbaBuffer);
      delete effectEntry.rgbaBuffer;
      if (effectEntry.innerStrokeMask) {
        effectEntry.innerMaskTexture = new LayerSystem.AlphaTexture(effectEntry.effectRect.width, effectEntry.effectRect.height);
        effectEntry.innerMaskTexture.set(effectEntry.innerStrokeMask);
        delete effectEntry.innerStrokeMask
      }
      if (effectEntry.outerStrokeMask) {
        effectEntry.outerMaskTexture = new LayerSystem.AlphaTexture(effectEntry.effectRect.width, effectEntry.effectRect.height);
        effectEntry.outerMaskTexture.set(effectEntry.outerStrokeMask);
        delete effectEntry.outerStrokeMask
      }
    }
};
LayerStyleRenderer.hasNonFillEffects = function(layerEffects) {
  for (let orderIdx = 0; orderIdx < LayerEffectDefs.order.length; orderIdx++) {
    const effectClassId = LayerEffectDefs.order[orderIdx];
    const effectKey = LayerEffectDefs.effectKeys[orderIdx];
    const effectList = layerEffects[effectKey].v;
    for (let entryIdx = 0; entryIdx < effectList.length; entryIdx++) {
      const effectEntry = effectList[entryIdx].v;
      if (effectEntry.enab.v && ["patternFill", "GrFl", "SoFi"].indexOf(effectClassId) == -1) return true
    }
  }
  return false
};
LayerStyleRenderer.buildLayerStyleEffectStack = function(layerEffects, fxReferencePoint, alphaChannel, boundsRect, doc, gradientBoundsRect) {
  if (gradientBoundsRect == null) gradientBoundsRect = boundsRect;
  let maxChokePad = 0;
  let maxOuterStroke = 0;
  for (let idx = 0; idx < LayerEffectDefs.order.length; idx++) {
    var effectClassId = LayerEffectDefs.order[idx];
    var effectKey = LayerEffectDefs.effectKeys[idx];
    const effectList = layerEffects[effectKey].v;
    for (let scanIdx = 0; scanIdx < effectList.length; scanIdx++) {
      const scanEntry = effectList[scanIdx].v;
      if (effectClassId == "DrSh" && scanEntry.enab.v && scanEntry.Ckmt.v.val > 0 && scanEntry.blur.v.val > 0) maxChokePad = Math.max(maxChokePad, Math.ceil(scanEntry.Ckmt.v.val * scanEntry.blur.v.val / 100));
      if (effectClassId == "OrGl" && scanEntry.enab.v && scanEntry.Ckmt.v.val > 0 && scanEntry.blur.v.val > 0 && scanEntry.GlwT.v.BETE == "SfBL") maxChokePad = Math.max(maxChokePad, Math.ceil(scanEntry.Ckmt.v.val * scanEntry.blur.v.val / 100));
      if (effectClassId == "OrGl" && scanEntry.enab.v && scanEntry.blur.v.val > 0 && scanEntry.GlwT.v.BETE == "PrBL") maxChokePad = Math.max(maxChokePad, scanEntry.blur.v.val);
      if (effectClassId == "FrFX" && scanEntry.enab.v && scanEntry.Sz.v.val > 0) {
        if (scanEntry.Styl.v.FStl == "OutF") maxChokePad = Math.max(maxChokePad, scanEntry.Sz.v.val);
        if (scanEntry.Styl.v.FStl == "CtrF") maxChokePad = Math.max(maxChokePad, Math.ceil(scanEntry.Sz.v.val / 2));
        maxOuterStroke = Math.max(maxOuterStroke, LayerStyleRenderer.getFrameEffectStrokePadding(scanEntry)[1])
      }
    }
  }
  const rasterCtx = new LayerStyleRenderer.EffectRasterContext(alphaChannel, boundsRect, maxChokePad, LayerStyleRenderer.hasNonFillEffects(layerEffects));
  const offsetX = -boundsRect.x;
  const offsetY = -boundsRect.y;

  const stack = {
    type: {},
    all: []
  };

  for (let orderIdx = 0; orderIdx < LayerEffectDefs.order.length; orderIdx++) {
    var effectClassId = LayerEffectDefs.order[orderIdx];
    var effectKey = LayerEffectDefs.effectKeys[orderIdx];
    stack.type[effectClassId] = [];
    for (let revIdx = layerEffects[effectKey].v.length - 1; revIdx >= 0; revIdx--) {
      const effectEntry = layerEffects[effectKey].v[revIdx].v;
      if (!effectEntry.enab.v) continue;
      var blurRadius = effectEntry.blur ? effectEntry.blur.v.val : 0;
      const chokeRatio = effectEntry.Ckmt ? effectEntry.Ckmt.v.val / 100 : 0;
      const chokePixels = blurRadius * chokeRatio;
      if (effectClassId == "DrSh") {
        var blurMask = rasterCtx.buildStrokeBlurMask(chokePixels, blurRadius - chokePixels, true);
        var maskPixels = blurMask.pixels;
        var effectRect = blurMask.rect;
        effectRect.offset(offsetX, offsetY);
        LayerStyleRenderer.setEffectStrokeAlign(maskPixels, effectEntry, false);
        LayerStyleRenderer.applyGradientEffect(effectRect, effectEntry, doc, 0);
        var rgbaBuf = allocBuffer(effectRect.area() * 4);
        LayerStyleRenderer.applySolidColorEffect(rgbaBuf, effectEntry.Clr.v);
        extractChannel(maskPixels, rgbaBuf, 3);

        var stackItem = createRasterStackItem(rgbaBuf, effectRect, effectEntry, {
          knocksOutLayer: effectEntry.layerConceals.v
        });

        stack.type[effectClassId].push(stackItem);
        stack.all.push(stackItem)
      }
      if (effectClassId == "IrSh") {
        var blurMask = rasterCtx.buildStrokeBlurMask(chokePixels, blurRadius - chokePixels, false);
        LayerStyleRenderer.applyGradientEffect(blurMask.rect, effectEntry, doc, 0);
        var effectRect = rasterCtx.rect().clone();
        var maskPixels = allocBuffer(effectRect.area());
        maskPixels.fill(255);
        copyChannel(blurMask.pixels, blurMask.rect, maskPixels, effectRect);
        LayerStyleRenderer.setEffectStrokeAlign(maskPixels, effectEntry, true);
        var rgbaBuf = allocBuffer(effectRect.area() * 4);
        LayerStyleRenderer.applySolidColorEffect(rgbaBuf, effectEntry.Clr.v);
        extractChannel(maskPixels, rgbaBuf, 3);
        effectRect.offset(offsetX, offsetY);

        var stackItem = {
          rgbaBuffer: rgbaBuf,
          effectRect: effectRect,
          blendModeCode: BlendModes.fromPSD(effectEntry.Md.v.blendMode),
          blendOpacity: effectEntry.Opct.v.val / 100
        };

        stack.type[effectClassId].push(stackItem);
        stack.all.push(stackItem)
      }
      if (effectClassId == "GrFl") {
        var rgbaBuf = allocBuffer(rasterCtx.rect().area() * 4);
        LayerStyleRenderer.applyGradientFillEffect(effectEntry, rgbaBuf, rasterCtx.rect(), doc, null, gradientBoundsRect);
        var effectRect = rasterCtx.rect().clone();
        effectRect.offset(offsetX, offsetY);
        var stackItem = {
          rgbaBuffer: rgbaBuf,
          effectRect: effectRect,
          blendModeCode: BlendModes.fromPSD(effectEntry.Md.v.blendMode),
          blendOpacity: effectEntry.Opct.v.val / 100
        };
        stack.type[effectClassId].push(stackItem);
        stack.all.push(stackItem)
      }
      if (effectClassId == "SoFi") {
        var rgbaBuf = allocBuffer(rasterCtx.channel().length * 4);
        LayerStyleRenderer.applySolidColorEffect(rgbaBuf, effectEntry.Clr.v);
        var effectRect = rasterCtx.rect().clone();
        effectRect.offset(offsetX, offsetY);
        var stackItem = {
          rgbaBuffer: rgbaBuf,
          effectRect: effectRect,
          blendModeCode: BlendModes.fromPSD(effectEntry.Md.v.blendMode),
          blendOpacity: effectEntry.Opct.v.val / 100
        };
        stack.type[effectClassId].push(stackItem);
        stack.all.push(stackItem)
      }
      if (effectClassId == "ebbl") {
        const debugBevel = false;
        if (debugBevel) console.log(effectEntry);
        const bevelStartMs = Date.now();
        let bevelStyle = effectEntry.bvlS.v.BESl;
        if (bevelStyle == "strokeEmboss") {
          let frameStrokeList = layerEffects.frameFXMulti.v;
          if (frameStrokeList.length == 0) continue;
          frameStrokeList = frameStrokeList[0].v;
          if (!frameStrokeList.enab.v) continue;
          const frameAlign = frameStrokeList.Styl.v.FStl;
          if (frameAlign == "OutF") bevelStyle = "OtrB";
          if (frameAlign == "CtrF") bevelStyle = "Embs";
          if (frameAlign == "InsF") bevelStyle = "InrB"
        }
        var blurRadius = effectEntry.blur.v.val;
        if (blurRadius == 0) blurRadius = .7;
        if (bevelStyle == "Embs" || bevelStyle == "PlEb") blurRadius /= 2;
        const bevelStyleIds = ["OtrB", "InrB", "Embs", "PlEb", "strokeEmboss"];
        const bevelTechniques = ["SfBL", "PrBL", "Slmt"];
        const bevelDirections = ["In", "Out"];
        const bevelSoftRadius = effectEntry.bvlT.v.bvlT != "SfBL" ? blurRadius : blurRadius * .45;
        const bevelRoundRadius = Math.round(blurRadius);
        const sourceRect = rasterCtx.rect().clone();
        let paddedRect = sourceRect.clone();
        paddedRect.inflate(bevelRoundRadius, bevelRoundRadius);
        let padWidth = paddedRect.width;
        let padHeight = paddedRect.height;
        const pixelCount = padWidth * padHeight;
        const paddedAlpha = allocBuffer(pixelCount);
        copyChannel(rasterCtx.channel(), sourceRect, paddedAlpha, paddedRect);
        var innerDistField = new Float64Array(pixelCount);
        const outerDistField = new Float64Array(pixelCount);
        computeDistanceField(paddedAlpha, innerDistField, padWidth, padHeight);
        invert(paddedAlpha);
        computeDistanceField(paddedAlpha, outerDistField, padWidth, padHeight);
        if (debugBevel) console.log("distTransform computed", Date.now() - bevelStartMs);
        for (let idx = 0; idx < pixelCount; idx++) outerDistField[idx] = outerDistField[idx] - innerDistField[idx];
        for (let idx = 0; idx < pixelCount; idx++) {
          const distSample = outerDistField[idx];
          if (distSample < -bevelSoftRadius) outerDistField[idx] = -bevelSoftRadius;
          else if (distSample > bevelSoftRadius) outerDistField[idx] = bevelSoftRadius
        }
        if (debugBevel) console.log("summing + cropping", Date.now() - bevelStartMs);
        if (effectEntry.bvlT.v.bvlT == "SfBL") {
          let blurSigma = Math.pow(blurRadius * .21, 1.22);
          if (true) blurSigma = Math.max(blurSigma, 2);
          const boxWidths = gaussianBoxWidths(blurSigma, 2);
          boxBlur(outerDistField, innerDistField, paddedRect, boxWidths[0] >>> 1);
          boxBlur(innerDistField, outerDistField, paddedRect, boxWidths[1] >>> 1)
        }
        if (debugBevel) console.log("blurring", Date.now() - bevelStartMs);
        const shapedDist = outerDistField;
        const origDist = shapedDist.slice(0);
        if (effectEntry.useShape.v) {
          let shapeRange = Math.min(100, effectEntry.Inpr.v.val + 1) / 100;
          if (bevelStyle != "OtrB" && bevelStyle != "InrB") shapeRange = 1;
          var toneCurve = buildToneCurveLut(effectEntry.MpgS.v.Crv.v, 2e3);
          const curvePad = Math.round(2e3 / shapeRange);
          toneCurve = padCurveLut(toneCurve, curvePad, bevelStyle == "InrB");
          var invBevelRadius = .5 / bevelSoftRadius;
          for (let idx = 0; idx < pixelCount; idx++) {
            const shapeDist = shapedDist[idx];
            const curveT = .99999 * (shapeDist + bevelSoftRadius) * invBevelRadius;
            shapedDist[idx] = -bevelSoftRadius + 2 * bevelSoftRadius * toneCurve[~~(curveT * (curvePad - 1))]
          }
          if (debugBevel) console.log("applying shape", Date.now() - bevelStartMs)
        }
        if (effectEntry.useTexture.v) {
          const patternRgba = allocBuffer(padWidth * padHeight * 4);
          LayerStyleRenderer.applyPatternFillEffect(effectEntry, patternRgba, paddedRect, doc, fxReferencePoint);
          let patternGray = allocBuffer(padWidth * padHeight);
          rgbaToGrayChannel(patternRgba, patternGray);
          const blurredGray = allocBuffer(padWidth * padHeight);
          boxBlurByte(patternGray, blurredGray, paddedRect, 1);
          patternGray = blurredGray;
          let textureDepthScale = blurRadius * effectEntry.textureDepth.v.val * (1 / 100) * (1 / 255);
          if (effectEntry.InvT.v) textureDepthScale = -textureDepthScale;
          for (let idx = 0; idx < pixelCount; idx++) shapedDist[idx] += -textureDepthScale * patternGray[idx];
          if (debugBevel) console.log("applying texture", Date.now() - bevelStartMs)
        }
        const depthScale = (effectEntry.bvlT.v.bvlT == "SfBL" ? 1 : .5) * (effectEntry.bvlD.v.BESs == "In" ? 1 : -1) * effectEntry.srgR.v.val / 100;
        for (let idx = 0; idx < pixelCount; idx++) shapedDist[idx] *= depthScale;
        if (debugBevel) console.log("scaling", Date.now() - bevelStartMs);
        let localLightAngle = effectEntry.uglg && effectEntry.uglg.v ? doc.getRotationAngle() : effectEntry.lagl.v.val;
        localLightAngle = localLightAngle * (Math.PI / 180);
        let globalLightAngle = effectEntry.uglg && effectEntry.uglg.v ? doc.getGlobalLightAngle() : effectEntry.Lald.v.val;
        globalLightAngle = globalLightAngle * (Math.PI / 180);
        const lightX = Math.cos(localLightAngle) * Math.cos(globalLightAngle);
        const lightY = -Math.sin(localLightAngle) * Math.cos(globalLightAngle);
        const lightZ = Math.sin(globalLightAngle);
        var highlightField = new Float64Array(pixelCount);
        var shadowField = new Float64Array(pixelCount);
        const isPillowEmboss = bevelStyle == "PlEb";
        for (let rowIdx = 0; rowIdx < padHeight; rowIdx++)
          for (let colIdx = 0; colIdx < padWidth; colIdx++) {
            var idx = rowIdx * padWidth + colIdx;
            let normalX = 0;
            let normalY = 0;
            let normalZ = 1;
            if (rowIdx != 0 && rowIdx != padHeight - 1 && colIdx != 0 && colIdx != padWidth - 1) {
              const nwDist = shapedDist[idx - padWidth - 1];
              const neDist = shapedDist[idx - padWidth + 1];
              const swDist = shapedDist[idx + padWidth - 1];
              const seDist = shapedDist[idx + padWidth + 1];
              normalX = -.125 * (neDist + 2 * shapedDist[idx + 1] + seDist - (nwDist + 2 * shapedDist[idx - 1] + swDist));
              normalY = -.125 * (swDist + 2 * shapedDist[idx + padWidth] + seDist - (nwDist + 2 * shapedDist[idx - padWidth] + neDist))
            } else {
              const centerDist = shapedDist[idx];
              normalY = -(rowIdx == 0 ? shapedDist[idx + padWidth] - centerDist : rowIdx == padHeight - 1 ? centerDist - shapedDist[idx - padWidth] : .5 * (shapedDist[idx + padWidth] - shapedDist[idx - padWidth]));
              normalX = -(colIdx == 0 ? shapedDist[idx + 1] - centerDist : colIdx == padWidth - 1 ? centerDist - shapedDist[idx - 1] : .5 * (shapedDist[idx + 1] - shapedDist[idx - 1]))
            }
            const invNormalLen = 1 / Math.sqrt(normalX * normalX + normalY * normalY + 1);
            normalX *= invNormalLen;
            normalY *= invNormalLen;
            normalZ *= invNormalLen;
            const litDot = normalX * lightX + normalY * lightY + normalZ * lightZ;
            let shadowDot = litDot;
            if (isPillowEmboss) shadowDot = -normalX * lightX - normalY * lightY + normalZ * lightZ;
            if (litDot > 0) highlightField[idx] = litDot;
            if (shadowDot > 0) shadowField[idx] = shadowDot
          }
        if (debugBevel) console.log("raycasting", Date.now() - bevelStartMs);
        if (effectEntry.Sftn.v.val != 0) {
          gaussianBlurFloat(highlightField, innerDistField, paddedRect, effectEntry.Sftn.v.val * .43);
          var swapTemp = innerDistField;
          var innerDistField = highlightField;
          var highlightField = swapTemp;
          if (isPillowEmboss) {
            gaussianBlurFloat(shadowField, innerDistField, paddedRect, effectEntry.Sftn.v.val * .43);
            var swapTemp = innerDistField;
            var innerDistField = shadowField;
            var shadowField = swapTemp;
          } else copyBuffer(highlightField, shadowField)
        }
        if (debugBevel) console.log("softening", Date.now() - bevelStartMs);
        var toneCurve = buildToneCurveLut(effectEntry.TrnS.v.Crv.v, 1024);
        for (let idx = 0; idx < pixelCount; idx++) {
          highlightField[idx] = toneCurve[~~(highlightField[idx] * 1024)];
          shadowField[idx] = toneCurve[~~(shadowField[idx] * 1024)]
        }
        if (debugBevel) console.log("contour remap", Date.now() - bevelStartMs);
        padWidth = Math.round(padWidth);
        padHeight = Math.round(padHeight);
        const innerHighlightBuf = allocBuffer(padWidth * padHeight * 4);
        LayerStyleRenderer.applySolidColorEffect(innerHighlightBuf, effectEntry.hglC.v);
        const innerShadowBuf = allocBuffer(padWidth * padHeight * 4);
        LayerStyleRenderer.applySolidColorEffect(innerShadowBuf, effectEntry.sdwC.v);
        const outerHighlightBuf = allocBuffer(padWidth * padHeight * 4);
        LayerStyleRenderer.applySolidColorEffect(outerHighlightBuf, effectEntry.hglC.v);
        const outerShadowBuf = allocBuffer(padWidth * padHeight * 4);
        LayerStyleRenderer.applySolidColorEffect(outerShadowBuf, effectEntry.sdwC.v);
        const highlightDiv = 1 / lightZ;
        const shadowDiv = 1 / (1 - lightZ);
        var invBevelRadius = 1 / bevelSoftRadius;
        const falloffLut = new Float64Array(1e3);
        for (let idx = 0; idx < 1e3; idx++) falloffLut[idx] = Math.pow(idx * .001, .2);
        for (let rowIdx = 0; rowIdx < padHeight; rowIdx++)
          for (let colIdx = 0; colIdx < padWidth; colIdx++) {
            var idx = rowIdx * padWidth + colIdx;
            const alphaIdx = 4 * idx + 3;
            let highlightVal = 0;
            let shadowVal = 0;
            highlightVal = highlightField[idx];
            shadowVal = shadowField[idx];
            let falloff = Math.max(0, Math.min(.9999, (origDist[idx] + bevelSoftRadius * .993) * invBevelRadius));
            falloff = falloffLut[Math.floor(falloff * 1e3)];
            const innerShadowAlpha = falloff * (1 - Math.min(1, highlightVal * highlightDiv));
            const innerHighlightAlpha = falloff * (1 - Math.min(1, (1 - highlightVal) * shadowDiv));
            const outerShadowAlpha = falloff * (1 - Math.min(1, shadowVal * highlightDiv));
            const outerHighlightAlpha = falloff * (1 - Math.min(1, (1 - shadowVal) * shadowDiv));
            innerShadowBuf[alphaIdx] = Math.round(255 * innerShadowAlpha);
            innerHighlightBuf[alphaIdx] = Math.round(255 * innerHighlightAlpha);
            outerShadowBuf[alphaIdx] = Math.round(255 * outerShadowAlpha);
            outerHighlightBuf[alphaIdx] = Math.round(255 * outerHighlightAlpha)
          }
        if (debugBevel) console.log("baking textures", Date.now() - bevelStartMs);
        paddedRect = rasterCtx.rect().clone();
        paddedRect.inflate(bevelRoundRadius, bevelRoundRadius);
        paddedRect.offset(offsetX, offsetY);

        const bevelEntry = {
          strokeEmbossFlag: effectEntry.bvlS.v.BESl == "strokeEmboss"
        };

        if (["InrB", "Embs", "PlEb"].indexOf(bevelStyle) != -1) {
          bevelEntry.innerHighlightPass = {
            rgbaBuffer: innerHighlightBuf,
            effectRect: paddedRect,
            blendModeCode: BlendModes.fromPSD(effectEntry.hglM.v.blendMode),
            blendOpacity: effectEntry.hglO.v.val / 100
          };
          bevelEntry.innerShadowPass = {
            rgbaBuffer: innerShadowBuf,
            effectRect: paddedRect,
            blendModeCode: BlendModes.fromPSD(effectEntry.sdwM.v.blendMode),
            blendOpacity: effectEntry.sdwO.v.val / 100
          };
          stack.all.push(bevelEntry.innerHighlightPass, bevelEntry.innerShadowPass)
        }
        if (["OtrB", "Embs", "PlEb"].indexOf(bevelStyle) != -1) {
          bevelEntry.outerHighlightPass = {
            rgbaBuffer: outerHighlightBuf,
            effectRect: paddedRect,
            blendModeCode: BlendModes.fromPSD(effectEntry.hglM.v.blendMode),
            blendOpacity: effectEntry.hglO.v.val / 100
          };
          bevelEntry.outerShadowPass = {
            rgbaBuffer: outerShadowBuf,
            effectRect: paddedRect,
            blendModeCode: BlendModes.fromPSD(effectEntry.sdwM.v.blendMode),
            blendOpacity: effectEntry.sdwO.v.val / 100
          };
          stack.all.push(bevelEntry.outerHighlightPass, bevelEntry.outerShadowPass)
        }
        if (debugBevel) console.log(Date.now() - bevelStartMs);
        stack.type[effectClassId].push(bevelEntry)
      }
      if (effectClassId == "patternFill") {
        const patternBounds = rasterCtx.rect();
        var rgbaBuf = allocBuffer(patternBounds.area() * 4);
        LayerStyleRenderer.applyPatternFillEffect(effectEntry, rgbaBuf, patternBounds, doc, fxReferencePoint);
        var effectRect = patternBounds.clone();
        effectRect.offset(offsetX, offsetY);

        var stackItem = {
          rgbaBuffer: rgbaBuf,
          effectRect: effectRect,
          blendModeCode: BlendModes.fromPSD(effectEntry.Md.v.blendMode),
          blendOpacity: effectEntry.Opct.v.val / 100
        };

        stack.type[effectClassId].push(stackItem);
        stack.all.push(stackItem)
      }
      if (effectClassId == "ChFX") {
        var rgbaBuf = allocBuffer(rasterCtx.channel().length * 4);
        LayerStyleRenderer.applySolidColorEffect(rgbaBuf, effectEntry.Clr.v);
        var blurRadius = effectEntry.blur.v.val;
        const chokeBounds = rasterCtx.rect().clone();
        chokeBounds.inflate(blurRadius, blurRadius);
        const blurredMask = allocBuffer(chokeBounds.area());
        const expandedMask = allocBuffer(chokeBounds.area());
        copyChannel(rasterCtx.channel(), rasterCtx.rect(), expandedMask, chokeBounds);
        gaussianBlurByte(expandedMask, blurredMask, chokeBounds, blurRadius * .43);
        const contourLut = buildCurveTable(effectEntry.MpgS.v.Crv.v, 256, true);
        applyLookupTable(blurredMask, contourLut);
        const gradMaskA = allocBuffer(rasterCtx.channel().length);
        const gradMaskB = allocBuffer(rasterCtx.channel().length);
        let gradRect = rasterCtx.rect().clone();
        LayerStyleRenderer.applyGradientEffect(gradRect, effectEntry, doc, 0);
        copyChannel(blurredMask, chokeBounds, gradMaskA, gradRect);
        gradRect = rasterCtx.rect().clone();
        LayerStyleRenderer.applyGradientEffect(gradRect, effectEntry, doc, Math.PI);
        copyChannel(blurredMask, chokeBounds, gradMaskB, gradRect);
        const maskLen = gradMaskA.length;
        for (let idx = 0; idx < maskLen; idx++) rgbaBuf[4 * idx + 3] = Math.abs(gradMaskA[idx] - gradMaskB[idx]);
        if (effectEntry.Invr.v)
          for (let idx = 0; idx < maskLen; idx++) rgbaBuf[4 * idx + 3] = 255 - rgbaBuf[4 * idx + 3];
        var effectRect = rasterCtx.rect().clone();
        effectRect.offset(offsetX, offsetY);

        var stackItem = {
          rgbaBuffer: rgbaBuf,
          effectRect: effectRect,
          blendModeCode: BlendModes.fromPSD(effectEntry.Md.v.blendMode),
          blendOpacity: effectEntry.Opct.v.val / 100
        };

        stack.type[effectClassId].push(stackItem);
        stack.all.push(stackItem)
      }
      if (effectClassId == "OrGl") {
        var blurMask;
        if (effectEntry.GlwT.v.BETE == "SfBL") blurMask = rasterCtx.buildStrokeBlurMask(chokePixels, blurRadius - chokePixels, true);
        else blurMask = rasterCtx.buildBevelMask(blurRadius, chokeRatio, true);
        var maskPixels = blurMask.pixels;
        var effectRect = blurMask.rect;
        const glowOriginal = maskPixels.slice(0);
        LayerStyleRenderer.initEffectStroke(maskPixels, effectEntry);
        var rgbaBuf = allocBuffer(effectRect.area() * 4);
        if (effectEntry.Grad == null) {
          LayerStyleRenderer.applySolidColorEffect(rgbaBuf, effectEntry.Clr.v);
          LayerStyleRenderer.setEffectStrokeAlign(maskPixels, effectEntry, false)
        } else {
          LayerStyleRenderer.setEffectStrokeAlign(maskPixels, effectEntry, null);

          var gradientMesh = {
            meshDistances: maskPixels,
            meshMin: 255,
            meshMax: 0,
            meshRect: effectRect
          };

          LayerStyleRenderer.applyGradientFillEffect(effectEntry, rgbaBuf, effectRect, doc, gradientMesh);
          const noiseAmount = effectEntry.Nose.v.val / 100;
          const glowWidth = effectRect.width;
          for (let idx = 0; idx < glowOriginal.length; idx++) {
            let noseCap = 255;
            const glowSample = glowOriginal[idx];
            if (glowSample < 32) {
              const noseSmoothed = (glowSample + glowOriginal[idx - 1] + glowOriginal[idx + 1] + glowOriginal[idx - glowWidth] + glowOriginal[idx + glowWidth]) * .2 - 1;
              noseCap = Math.min(255, Math.round(Math.max(0, noseSmoothed) * 8))
            }
            maskPixels[idx] = noseCap
          }
          LayerStyleRenderer.applyBevelNoseHighlight(maskPixels, effectEntry)
        }
        extractChannel(maskPixels, rgbaBuf, 3);
        effectRect.offset(offsetX, offsetY);

        var stackItem = {
          rgbaBuffer: rgbaBuf,
          effectRect: effectRect,
          blendModeCode: BlendModes.fromPSD(effectEntry.Md.v.blendMode),
          blendOpacity: effectEntry.Opct.v.val / 100
        };

        stack.type[effectClassId].push(stackItem);
        stack.all.push(stackItem)
      }
      if (effectClassId == "IrGl") {
        var blurMask;
        if (effectEntry.GlwT.v.BETE == "SfBL") blurMask = rasterCtx.buildStrokeBlurMask(chokePixels, blurRadius - chokePixels, false);
        else blurMask = rasterCtx.buildBevelMask(blurRadius, chokeRatio, false);
        var maskPixels = blurMask.pixels;
        var effectRect = blurMask.rect;
        LayerStyleRenderer.initEffectStroke(maskPixels, effectEntry);
        if (effectEntry.glwS.v.IGSr == "SrcC") invert(maskPixels);
        var rgbaBuf = allocBuffer(effectRect.area() * 4);
        if (effectEntry.Grad == null) {
          LayerStyleRenderer.applySolidColorEffect(rgbaBuf, effectEntry.Clr.v);
          LayerStyleRenderer.setEffectStrokeAlign(maskPixels, effectEntry, true)
        } else {
          LayerStyleRenderer.setEffectStrokeAlign(maskPixels, effectEntry, null);
          var gradientMesh = {
            meshDistances: maskPixels,
            meshMin: 255,
            meshMax: 0,
            meshRect: effectRect
          };
          LayerStyleRenderer.applyGradientFillEffect(effectEntry, rgbaBuf, effectRect, doc, gradientMesh);
          maskPixels.fill(255);
          LayerStyleRenderer.applyBevelNoseHighlight(maskPixels, effectEntry)
        }
        extractChannel(maskPixels, rgbaBuf, 3);
        effectRect.offset(offsetX, offsetY);

        var stackItem = {
          rgbaBuffer: rgbaBuf,
          effectRect: effectRect,
          blendModeCode: BlendModes.fromPSD(effectEntry.Md.v.blendMode),
          blendOpacity: effectEntry.Opct.v.val / 100
        };

        stack.type[effectClassId].push(stackItem);
        stack.all.push(stackItem)
      }
      if (effectClassId == "FrFX") {
        const strokePaddingPair = LayerStyleRenderer.getFrameEffectStrokePadding(effectEntry);
        const innerStrokePad = strokePaddingPair[0];
        const outerStrokePad = strokePaddingPair[1];
        var effectRect = rasterCtx.rect().clone();
        let innerStrokeMask = null;
        let outerStrokeMask = null;
        effectRect.inflate(Math.ceil(maxOuterStroke), Math.ceil(maxOuterStroke));
        if (outerStrokePad > 0) {
          var blurMask = rasterCtx.buildStrokeBlurMask(outerStrokePad, 0, true);
          outerStrokeMask = blurMask.pixels;
          if (outerStrokeMask.length < effectRect.area()) {
            outerStrokeMask = allocBuffer(effectRect.area());
            copyChannel(blurMask.pixels, blurMask.rect, outerStrokeMask, effectRect)
          }
        }
        if (innerStrokePad > 0) {
          var blurMask = rasterCtx.buildStrokeBlurMask(innerStrokePad, 0, false);
          innerStrokeMask = allocBuffer(effectRect.area());
          innerStrokeMask.fill(255);
          copyChannel(blurMask.pixels, blurMask.rect, innerStrokeMask, effectRect)
        }
        effectRect.offset(offsetX, offsetY);
        var rgbaBuf = allocBuffer(effectRect.area() * 4);
        const strokeFillType = effectEntry.PntT.v.FrFl;
        if (strokeFillType == "SClr") LayerStyleRenderer.applySolidColorEffect(rgbaBuf, effectEntry.Clr.v);
        if (strokeFillType == "GrFl") LayerStyleRenderer.applyGradientFillEffect(effectEntry, rgbaBuf, effectRect, doc, rasterCtx.buildGradientField(innerStrokePad, outerStrokePad));
        if (strokeFillType == "Ptrn") LayerStyleRenderer.applyPatternFillEffect(effectEntry, rgbaBuf, effectRect, doc, fxReferencePoint);

        var stackItem = {
          rgbaBuffer: rgbaBuf,
          effectRect: effectRect,
          blendModeCode: BlendModes.fromPSD(effectEntry.Md.v.blendMode),
          blendOpacity: effectEntry.Opct.v.val / 100,
          outerStrokeMask: outerStrokeMask,
          innerStrokeMask: innerStrokeMask
        };

        stack.type[effectClassId].push(stackItem);
        stack.all.push(stackItem)
      }
    }
  }
  return stack
};
LayerStyleRenderer.normalizeVec3 = function(vec) {
  const invLen = 1 / Math.sqrt(vec.x * vec.x + vec.y * vec.y + vec.z * vec.z);
  vec.x *= invLen;
  vec.y *= invLen;
  vec.z *= invLen
};
LayerStyleRenderer.crossVec3 = function(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  }
};
LayerStyleRenderer.dotVec3 = function(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z
};
LayerStyleRenderer.applyBevelNoseHighlight = function(pixelMask, effectEntry) {
  const noiseAmount = effectEntry.Nose.v.val / 100;
  if (noiseAmount > 0)
    for (let pixelIdx = 0; pixelIdx < pixelMask.length; pixelIdx++) {
      let clampedVal = pixelMask[pixelIdx];
      clampedVal = Math.min(510 - (1 + noiseAmount) * positionHash(pixelIdx), clampedVal);
      pixelMask[pixelIdx] = clampedVal
    }
};
LayerStyleRenderer.buildShapeRenderStyle = function(layer) {
  const defaults = defaultShapeStyleParams();
  let blendIfData = layer.blendIfData;
  let hasBlendRanges = false;
  for (let rangeIdx = 0; rangeIdx < 32; rangeIdx += 8)
    if (blendIfData[rangeIdx] + blendIfData[rangeIdx + 1] + blendIfData[4] + blendIfData[5] != 0 || blendIfData[rangeIdx + 2] + blendIfData[rangeIdx + 3] + blendIfData[6] + blendIfData[7] != 1020) hasBlendRanges = true;
  if (hasBlendRanges) {
    blendIfData = blendIfData.slice(0);
    for (let rangeIdx = 0; rangeIdx < 40; rangeIdx += 4) {
      const rangeMin = blendIfData[rangeIdx] / 255;
      const rangeMax = blendIfData[rangeIdx + 1] / 255;
      const rangeLow = blendIfData[rangeIdx + 2] / 255;
      const rangeHigh = blendIfData[rangeIdx + 3] / 255;
      blendIfData[rangeIdx] = rangeMin - 1e-4;
      blendIfData[rangeIdx + 1] = rangeMin == rangeMax ? 1e9 : 1 / (rangeMax - (rangeMin - 1e-4));
      blendIfData[rangeIdx + 2] = rangeLow == rangeHigh ? -1e9 : 1 / (rangeLow - (rangeHigh + 1e-4));
      blendIfData[rangeIdx + 3] = rangeHigh + 1e-4
    }
  }
  let fillOpacity = layer.add.iOpa != null ? layer.add.iOpa / 255 : defaults.fill;
  const vectorStroke = layer.add.vstk;
  if (vectorStroke && !vectorStroke.fillEnabled.v && (!vectorStroke.strokeEnabled.v || vectorStroke.strokeStyleLineWidth.v.val == 0)) fillOpacity = 0;
  return {
    fill: fillOpacity,
    blendIfTable: hasBlendRanges ? blendIfData : null,
    channelRestrictions: layer.add.brst != null ? layer.add.brst : defaults.channelRestrictions,
    knockout: layer.add.knko != null ? layer.add.knko : defaults.knockout,
    style: false,
    preserveDestAlpha: false
  }
};
LayerStyleRenderer.refreshPatternPickerWidgets = function(layerEffectsJson, patternRegistry, patternList) {
  const multiFillKeys = ["patternFillMulti", "ebblMulti", "frameFXMulti"];
  for (let keyIdx = 0; keyIdx < multiFillKeys.length; keyIdx++) {
    const effectList = layerEffectsJson.v[multiFillKeys[keyIdx]].v;
    for (let entryIdx = 0; entryIdx < effectList.length; entryIdx++)
      if (effectList[entryIdx].v.Ptrn) patternRegistry.registerPattern(findPattern(effectList[entryIdx].v.Ptrn.v, patternList))
  }
};
LayerStyleRenderer.reloadPatternPresetsIfMoved = function(layerEffectsJson, layer, patternList) {
  const multiFillKeys = ["patternFillMulti", "ebblMulti", "frameFXMulti"];
  for (let keyIdx = 0; keyIdx < multiFillKeys.length; keyIdx++) {
    const effectList = layerEffectsJson.v[multiFillKeys[keyIdx]].v;
    for (let entryIdx = 0; entryIdx < effectList.length; entryIdx++)
      if (effectList[entryIdx].v.Ptrn) {
        const patternRef = effectList[entryIdx].v.Ptrn.v;
        const foundPreset = findPattern(patternRef, patternList);
        const layerPreset = findPattern(patternRef, layer.add.Patt);
        if (foundPreset == null && layerPreset) patternList.push(layerPreset)
      }
  }
};
LayerStyleRenderer.applyPatternFillEffect = function(effectEntry, destBuffer, boundsRect, doc, anchorPoint) {
  const pattern = findPattern(effectEntry.Ptrn.v, doc.add.Patt);
  if (pattern != null && !boundsRect.isEmpty()) {
    const mipPixels = pattern.pixelData;
    let mipWidth = mipPixels[0];
    let mipHeight = mipPixels[1];
    let mipLevel = 0;
    buildMipPyramidAlpha(mipPixels);
    let patternScale = effectEntry.Scl.v.val / 100;
    while ((patternScale < .3 || patternScale == .5) && mipPixels[mipLevel + 2]) {
      patternScale *= mipHeight.width / mipPixels[mipLevel + 3].width;
      mipLevel += 2;
      mipWidth = mipPixels[mipLevel];
      mipHeight = mipPixels[mipLevel + 1]
    }
    const scaledPattern = patternFromImageData(mipWidth, mipHeight.width, mipHeight.height);
    let phaseX = -boundsRect.x + effectEntry.phase.v.Hrzn.v - 1;
    let phaseY = -boundsRect.y + effectEntry.phase.v.Vrtc.v - 1;
    if (effectEntry.Algn != null && !effectEntry.Algn.v) {} else {
      phaseX += anchorPoint.x;
      phaseY += anchorPoint.y
    }
    fillScaledPatternToBuffer(scaledPattern, destBuffer, boundsRect.width, boundsRect.height, patternScale, patternScale, phaseX + 1, phaseY + 1)
  }
};
LayerStyleRenderer.applyGradientFillEffect = function(effectEntry, destBuffer, boundsRect, doc, meshField, gradientBoundsRect) {
  if (gradientBoundsRect == null) gradientBoundsRect = boundsRect;
  const gradientType = effectEntry.Type ? effectEntry.Type.v.GrdT : "shapeburst";
  const alignRect = effectEntry.Algn && effectEntry.Algn.v ? gradientBoundsRect : new Rect(0, 0, doc.width, doc.height);
  const endpoints = effectEntry.Angl ? linearGradientEndpoints(effectEntry, alignRect) : [new Point(0, 0), new Point(100, 0)];
  const startX = endpoints[0].x;
  const startY = endpoints[0].y;
  const deltaX = endpoints[1].x - startX;
  const deltaY = endpoints[1].y - startY;
  let invLenSq = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  invLenSq = 1 / (2 * invLenSq * invLenSq);
  const transform = [deltaX * invLenSq, deltaY * invLenSq, -deltaY * invLenSq, deltaX * invLenSq];
  const reverse = effectEntry.Rvrs ? effectEntry.Rvrs.v : false;
  const dither = effectEntry.Dthr ? effectEntry.Dthr.v : false;
  applyGradient(effectEntry.Grad.v, destBuffer, boundsRect, transform, startX, startY, reverse, LayerEffectDefs.gradientTypeOptions.types.indexOf(gradientType), 0, 0, meshField, dither)
};
LayerStyleRenderer.clearEffectCache = function(effectStack, layerOffset) {
  for (let entryIdx = 0; entryIdx < effectStack.all.length; entryIdx++) {
    const effectEntry = effectStack.all[entryIdx];
    effectEntry.compositeRect = effectEntry.effectRect.clone();
    effectEntry.compositeRect.offset(layerOffset.x, layerOffset.y)
  }
};
LayerStyleRenderer.compositeEffectsOntoLayer = function(layerEffects, effectStack, layerRect, destBuffer, destRect, clipRect) {
  const compositeFn = LayerSystem.webglEnabled ? LayerStyleRenderer.compositeEffectsGpu : LayerStyleRenderer.compositeEffectsCpu;
  LayerStyleRenderer.clearEffectCache(effectStack, layerRect);
  const dropShadows = effectStack.type.DrSh;
  for (let entryIdx = 0; entryIdx < dropShadows.length; entryIdx++)
    if (!dropShadows[entryIdx].knocksOutLayer) compositeFn(dropShadows[entryIdx], destBuffer, destRect, clipRect)
};
LayerStyleRenderer.rasterizeEffectsToBuffer = function(layerEffects, effectStack, layerRect, destBuffer, destRect, clipRect, blendedBuffer, strokeBaseBuffer, strokeOutputBuffer, strokeAlignRect) {
  const effectsLayerRect = layerRect;
  const compositeFn = LayerSystem.webglEnabled ? LayerStyleRenderer.compositeEffectsGpu : LayerStyleRenderer.compositeEffectsCpu;
  const clipCompositeFn = LayerSystem.webglEnabled ? LayerSystem.renderers.compositeWithClipping : compositeLayer;
  var effectGroup;
  effectGroup = effectStack.type.DrSh;
  for (let entryIdx = 0; entryIdx < effectGroup.length; entryIdx++)
    if (effectGroup[entryIdx].knocksOutLayer) compositeFn(effectGroup[entryIdx], destBuffer, destRect, clipRect);
  effectGroup = effectStack.type.OrGl;
  for (let entryIdx = 0; entryIdx < effectGroup.length; entryIdx++) compositeFn(effectGroup[entryIdx], destBuffer, destRect, clipRect);
  const fillEffectKinds = "patternFill GrFl SoFi ChFX IrGl IrSh".split(" ");
  for (let kindIdx = 0; kindIdx < fillEffectKinds.length; kindIdx++) {
    var effectGroup = effectStack.type[fillEffectKinds[kindIdx]];
    for (let entryIdx = 0; entryIdx < effectGroup.length; entryIdx++) compositeFn(effectGroup[entryIdx], blendedBuffer, effectsLayerRect, clipRect)
  }
  const bevelEntry = effectStack.type.ebbl[0];
  const strokeEmbossActive = bevelEntry != null && bevelEntry.strokeEmbossFlag;
  effectGroup = effectStack.type.FrFX;
  for (let entryIdx = 0; entryIdx < effectGroup.length; entryIdx++) {
    const frameEntry = effectGroup[entryIdx];
    (LayerSystem.webglEnabled ? LayerSystem.copyGpuTextureRegion : copyPixels)(strokeBaseBuffer, strokeAlignRect, strokeOutputBuffer, strokeAlignRect, clipRect);
    compositeFn(frameEntry, strokeOutputBuffer, strokeAlignRect, clipRect);
    if (strokeEmbossActive && entryIdx == effectGroup.length - 1) {
      if (bevelEntry.outerShadowPass) compositeFn(bevelEntry.outerShadowPass, strokeOutputBuffer, strokeAlignRect, clipRect);
      if (bevelEntry.outerHighlightPass) compositeFn(bevelEntry.outerHighlightPass, strokeOutputBuffer, strokeAlignRect, clipRect);
      if (bevelEntry.innerShadowPass) compositeFn(bevelEntry.innerShadowPass, strokeOutputBuffer, strokeAlignRect, clipRect);
      if (bevelEntry.innerHighlightPass) compositeFn(bevelEntry.innerHighlightPass, strokeOutputBuffer, strokeAlignRect, clipRect)
    }
    if (frameEntry.innerStrokeMask || frameEntry.innerMaskTexture) clipCompositeFn(strokeOutputBuffer, strokeAlignRect, blendedBuffer, effectsLayerRect, LayerSystem.webglEnabled ? frameEntry.innerMaskTexture : frameEntry.innerStrokeMask, frameEntry.compositeRect, 0, clipRect, 1);
    if (frameEntry.outerStrokeMask || frameEntry.outerMaskTexture) clipCompositeFn(strokeOutputBuffer, strokeAlignRect, destBuffer, destRect, LayerSystem.webglEnabled ? frameEntry.outerMaskTexture : frameEntry.outerStrokeMask, frameEntry.compositeRect, 0, clipRect, 1)
  }
  if (!strokeEmbossActive && bevelEntry != null) {
    if (bevelEntry.outerShadowPass) compositeFn(bevelEntry.outerShadowPass, destBuffer, destRect, clipRect);
    if (bevelEntry.outerHighlightPass) compositeFn(bevelEntry.outerHighlightPass, destBuffer, destRect, clipRect);
    if (bevelEntry.innerShadowPass) compositeFn(bevelEntry.innerShadowPass, blendedBuffer, effectsLayerRect, clipRect);
    if (bevelEntry.innerHighlightPass) compositeFn(bevelEntry.innerHighlightPass, blendedBuffer, effectsLayerRect, clipRect)
  }
};
LayerStyleRenderer.compositeEffectsCpu = function(effectEntry, destBuffer, destRect, clipRect) {
  const shapeStyle = defaultShapeStyleParams();
  shapeStyle.fill = effectEntry.blendOpacity;
  shapeStyle.style = true;
  composite(effectEntry.blendModeCode, effectEntry.rgbaBuffer, effectEntry.compositeRect, destBuffer, destRect, clipRect, 1, shapeStyle)
};
LayerStyleRenderer.compositeEffectsGpu = function(effectEntry, destBuffer, destRect, clipRect) {
  const shapeStyle = defaultShapeStyleParams();
  shapeStyle.fill = effectEntry.blendOpacity;
  shapeStyle.style = true;
  LayerSystem.renderers.composite(effectEntry.blendModeCode, effectEntry.rgbaTexture, effectEntry.compositeRect, destBuffer, destRect, clipRect, 1, shapeStyle)
};
LayerStyleRenderer.initEffectStroke = function(pixelMask, effectEntry) {
  const rangeFactor = 1 - effectEntry.Inpr.v.val / 100;
  let scaleFactor = 1 + Math.tan(rangeFactor * (Math.PI / 2));
  const pixelCount = pixelMask.length;
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) pixelMask[pixelIdx] = Math.min(255, Math.round(pixelMask[pixelIdx] * scaleFactor))
};
LayerStyleRenderer.setEffectStrokeAlign = function(pixelMask, effectEntry, invertNoise) {
  let blurRadius = effectEntry.blur.v.val;
  const chokePixels = Math.round(blurRadius * (effectEntry.Ckmt.v.val / 100));
  if (blurRadius > chokePixels) {
    const contourLut = buildCurveTable(effectEntry.TrnS.v.Crv.v, 256, true);
    applyLookupTable(pixelMask, contourLut)
  }
  if (invertNoise != null && effectEntry.Nose.v.val > 0) applyStrokeNoise(pixelMask, effectEntry.Nose.v.val / 100, invertNoise)
};
LayerStyleRenderer.applySolidColorEffect = function(destBuffer, psdColor, alpha) {
  if (alpha == null) alpha = 255;
  const rgb = psdColorToRgb(psdColor);
  const packedColor = alpha << 24 | rgb.O << 16 | rgb.l << 8 | rgb.h;
  const wordView = new Uint32Array(destBuffer.buffer);
  wordView.fill(packedColor)
};
LayerStyleRenderer.applyGradientEffect = function(boundsRect, effectEntry, doc, angleOffset) {
  let angleRad = effectEntry.uglg && effectEntry.uglg.v ? doc.getRotationAngle() : effectEntry.lagl.v.val;
  angleRad = angleRad * Math.PI / 180 + angleOffset;
  const offsetX = Math.cos(angleRad) * effectEntry.Dstn.v.val;
  const offsetY = Math.sin(angleRad) * effectEntry.Dstn.v.val;
  boundsRect.x -= Math.round(offsetX);
  boundsRect.y += Math.round(offsetY)
};
LayerStyleRenderer.defaultVectorStroke = function(layer) {
  if (layer == null) return null;
  let frameStrokeList = layer.frameFXMulti.v;
  if (frameStrokeList.length == 0) return null;
  frameStrokeList = frameStrokeList[0].v;
  const strokeDescriptor = LayerEffectDefs.getStrokeStyleDefault();
  LayerStyleRenderer.applyStrokeDescriptorFromStyle(frameStrokeList, strokeDescriptor);
  return strokeDescriptor
};
LayerStyleRenderer.applyStrokeDescriptorFromStyle = function(strokeEffect, strokeDescriptor) {
  const fillTypeIdx = LayerEffectDefs.strokePositionOptions.fillKinds.indexOf(strokeEffect.PntT.v.FrFl);
  const contentKeys = LayerEffectDefs.fillPropertyKeyGroups[fillTypeIdx];

  const contentNode = strokeDescriptor.strokeStyleContent.v = {
    classID: LayerEffectDefs.StrokeStyleDefs.fillLayerTypes[fillTypeIdx]
  };

  for (let keyIdx = 0; keyIdx < contentKeys.length; keyIdx++) contentNode[contentKeys[keyIdx]] = strokeEffect[contentKeys[keyIdx]];
  strokeDescriptor.strokeEnabled = strokeEffect.enab;
  strokeDescriptor.strokeStyleLineWidth = strokeEffect.Sz;
  strokeDescriptor.strokeStyleLineAlignment.v.strokeStyleLineAlignment = LayerEffectDefs.StrokeStyleDefs.alignTypes[LayerEffectDefs.strokePositionOptions.types.indexOf(strokeEffect.Styl.v.FStl)];
  strokeDescriptor.strokeStyleOpacity = strokeEffect.Opct;
  strokeDescriptor.strokeStyleBlendMode = strokeEffect.Md
};
LayerStyleRenderer.dashArrayToStrokeDescriptor = function(dashArray, scaleFactor) {
  const dashEntries = [];
  for (let dashIdx = 0; dashIdx < dashArray.length; dashIdx++) dashEntries.push({
    t: "UntF",
    v: {
      type: "#Nne",
      val: Math.round(dashArray[dashIdx] * scaleFactor)
    }
  });
  return dashEntries
};
LayerStyleRenderer.EffectRasterContext = function(alphaChannel, boundsRect, chokePadding, ownAlphaCopy) {
  this._rect = boundsRect.clone();
  this._paddedRect = boundsRect.clone();
  this._paddedRect.inflate(chokePadding, chokePadding);
  // Effects that read outside the layer's alpha need a one-pixel margin, so
  // they work on a copy rather than the layer's own channel.
  if (ownAlphaCopy) {
    this._rect.inflate(1, 1);
    this._channel = allocBuffer(this._rect.area());
    copyChannel(alphaChannel, boundsRect, this._channel, this._rect)
  } else this._channel = alphaChannel;
  this._invertedChannel = null;
  this._distanceField = null;
  this._paddedDistanceField = null
};
LayerStyleRenderer.EffectRasterContext.prototype.channel = function() {
  return this._channel
};
LayerStyleRenderer.EffectRasterContext.prototype.rect = function() {
  return this._rect
};
LayerStyleRenderer.EffectRasterContext.prototype.paddedRect = function() {
  return this._paddedRect
};
LayerStyleRenderer.EffectRasterContext.prototype.invertedChannel = function() {
  if (this._invertedChannel) return this._invertedChannel;
  this._invertedChannel = this.channel().slice(0);
  invert(this._invertedChannel);
  return this._invertedChannel
};
LayerStyleRenderer.EffectRasterContext.prototype.distanceField = function() {
  if (this._distanceField) return this._distanceField;
  this._distanceField = new Float64Array(this.rect().area());
  computeDistanceField(this.invertedChannel(), this._distanceField, this.rect().width, this.rect().height);
  return this._distanceField
};
LayerStyleRenderer.EffectRasterContext.prototype.paddedDistanceField = function() {
  if (this._paddedDistanceField) return this._paddedDistanceField;
  let paddedRect = this.paddedRect();
  const paddedAlpha = allocBuffer(paddedRect.area());
  copyChannel(this.channel(), this.rect(), paddedAlpha, paddedRect);
  this._paddedDistanceField = new Float64Array(paddedRect.area());
  computeDistanceField(paddedAlpha, this._paddedDistanceField, paddedRect.width, paddedRect.height);
  return this._paddedDistanceField
};
LayerStyleRenderer.EffectRasterContext.prototype.buildGradientField = function(innerRadius, outerRadius) {
  const meshField = {
    meshMin: -outerRadius,
    meshMax: innerRadius,
    meshRect: null,
    meshDistances: null
  };

  if (outerRadius == 0) {
    meshField.meshRect = this.rect();
    meshField.meshDistances = this.distanceField();
    return meshField
  }
  const paddedDist = this.paddedDistanceField().slice(0);
  let paddedRect = this.paddedRect();
  meshField.meshRect = paddedRect;
  meshField.meshDistances = paddedDist;
  for (let pixelIdx = 0; pixelIdx < paddedDist.length; pixelIdx++) paddedDist[pixelIdx] = -paddedDist[pixelIdx];
  if (innerRadius == 0) return meshField;
  const sourceDist = this.distanceField();
  const sourceRect = this.rect();
  for (let rowIdx = 0; rowIdx < sourceRect.height; rowIdx++)
    for (let colIdx = 0; colIdx < sourceRect.width; colIdx++) {
      const sourceIdx = rowIdx * sourceRect.width + colIdx;
      const destIdx = (rowIdx + sourceRect.y - paddedRect.y) * paddedRect.width + colIdx + sourceRect.x - paddedRect.x;
      paddedDist[destIdx] += sourceDist[sourceIdx]
    }
  return meshField
};
LayerStyleRenderer.EffectRasterContext.prototype.buildStrokeBlurMask = function(chokeRadius, blurRadius, outer) {
  const inflatePad = Math.ceil(chokeRadius + blurRadius);

  const result = {
    rect: this.rect().clone(),
    pixels: null
  };

  result.rect.inflate(inflatePad, inflatePad);
  result.pixels = allocBuffer(result.rect.area());
  if (chokeRadius == 0 && blurRadius == 0) copyBuffer(outer ? this.channel() : this.invertedChannel(), result.pixels);
  else {
    const workMask = allocBuffer(result.rect.area());
    copyChannel(this.channel(), this.rect(), workMask, result.rect);
    if (!outer) invert(workMask);
    if (chokeRadius != 0) {
      if (outer) applyStrokeMask(workMask, result.rect, this.paddedDistanceField(), this.paddedRect(), chokeRadius);
      else applyStrokeMask(workMask, result.rect, this.distanceField(), this.rect(), chokeRadius)
    }
    if (blurRadius != 0) gaussianBlurByte(workMask, result.pixels, result.rect, Math.max(1, blurRadius * .43));
    else result.pixels = workMask
  }
  return result
};
LayerStyleRenderer.EffectRasterContext.prototype.buildBevelMask = function(blurRadius, chokeRatio, outer) {
  const chokeOffset = blurRadius * (chokeRatio - .5);

  const result = {
    rect: this.rect().clone(),
    pixels: null
  };

  if (outer) result.rect.inflate(blurRadius, blurRadius);
  result.pixels = allocBuffer(result.rect.area());
  var maskWidth = result.rect.width;
  var maskHeight = result.rect.height;
  const distField = outer ? this.paddedDistanceField() : this.distanceField();
  const distRect = outer ? this.paddedRect() : this.rect();
  const outRect = result.rect;
  const intersectRect = outRect.intersect(distRect);
  var maskWidth = intersectRect.width;
  var maskHeight = intersectRect.height;
  const offsetX = intersectRect.x - outRect.x;
  const offsetY = intersectRect.y - outRect.y;
  const distOffsetX = intersectRect.x - distRect.x;
  const distOffsetY = intersectRect.y - distRect.y;
  const chokeScale = 1 - chokeRatio * 2;
  for (let rowIdx = 0; rowIdx < maskHeight; rowIdx++)
    for (let colIdx = 0; colIdx < maskWidth; colIdx++) {
      const distVal = distField[(rowIdx + distOffsetY) * distRect.width + colIdx + distOffsetX];
      const normDist = distVal / blurRadius;
      result.pixels[(rowIdx + offsetY) * outRect.width + colIdx + offsetX] = Math.max(0, Math.min(255, 255 - 255 * ((normDist + chokeScale) / (1 + chokeScale))))
    }
  return result
};
LayerStyleRenderer.applyGlobalLightAngle = function(stylesJson, layer, scaleFactor) {
  const linkedEffects = stylesJson.Lefx;
  let blendOptions = stylesJson.blendOptions;
  if (linkedEffects) {
    const existingLmfx = layer.add.lmfx;
    if (scaleFactor == null) scaleFactor = existingLmfx ? existingLmfx.Scl.v.val : 100;
    layer.add.lmfx = JSON.parse(JSON.stringify(linkedEffects.v));
    if (layer.add.lmfx.Scl == null) layer.add.lmfx.Scl = {
      t: "UntF",
      v: {
        type: "#Prc",
        val: 100
      }
    };
    LayerStyleRenderer.scaleLayerEffectSizes(layer.add.lmfx, scaleFactor / layer.add.lmfx.Scl.v.val);
    if (existingLmfx) layer.add.lmfx.Scl.v.val = existingLmfx.Scl.v.val
  } else delete layer.add.lmfx;
  if (blendOptions) {
    blendOptions = blendOptions.v;
    if (blendOptions.Md) layer.blendMode = BlendModes.fromPSD(blendOptions.Md.v.blendMode);
    if (blendOptions.Opct) layer.Opct = Math.round(blendOptions.Opct.v.val * 255 / 100);
    if (blendOptions.fillOpacity) layer.add.iOpa = Math.round(blendOptions.fillOpacity.v.val * 255 / 100);
    if (blendOptions.Blnd) {
      const blendIfArray = [];
      for (let channelIdx = 0; channelIdx < 10; channelIdx++) blendIfArray.push(0, 0, 255, 255);
      const blendEntries = blendOptions.Blnd.v;
      const blendKeys = "SrcB Srcl SrcW Srcm DstB Dstl DstW Dstt".split(" ");
      for (let channelIdx = 0; channelIdx < blendEntries.length; channelIdx++) {
        const blendEntry = blendEntries[channelIdx].v;
        const channelBase = 8 * ["Gry", "Rd", "Grn", "Bl"].indexOf(blendEntry.Chnl.v[0].v.enum);
        for (let blendKeyIdx = 0; blendKeyIdx < 8; blendKeyIdx++) {
          blendIfArray[channelBase + blendKeyIdx] = blendEntry[blendKeys[blendKeyIdx]].v
        }
      }
      layer.blendIfData = blendIfArray
    }
  }
};
LayerStyleRenderer.cloneLayerEffectsJson = function(layer) {
  const blendKeyNames = "SrcB Srcl SrcW Srcm DstB Dstl DstW Dstt".split(" ");
  const blendEntries = [];
  let blendIfData = layer.blendIfData;
  for (let channelIdx = 0; channelIdx < 4; channelIdx++) {
    const rangeBase = channelIdx * 8;
    if (blendIfData[rangeBase] + blendIfData[rangeBase + 1] + blendIfData[rangeBase + 4] + blendIfData[rangeBase + 5] == 0 && blendIfData[rangeBase + 2] + blendIfData[rangeBase + 3] + blendIfData[rangeBase + 6] + blendIfData[rangeBase + 7] == 4 * 255) continue;
    const blendEntry = {
      t: "Objc",
      v: {
        classID: "Blnd",
        Chnl: {
          t: "obj ",
          v: [{
            t: "Enmr",
            v: {
              classID: "Chnl",
              typeID: "Chnl",
              enum: ["Gry", "Rd", "Grn", "Bl"][channelIdx]
            }
          }]
        }
      }
    };
    blendEntries.push(blendEntry);
    for (let keyIdx = 0; keyIdx < 8; keyIdx++) blendEntry.v[blendKeyNames[keyIdx]] = {
      t: "long",
      v: blendIfData[channelIdx * 8 + keyIdx]
    }
  }

  let blendOptions = {
    classID: "blendOptions"
  };

  if (layer.blendMode != "norm") blendOptions.Md = {
    t: "enum",
    v: {
      blendMode: BlendModes.toPSD(layer.blendMode)
    }
  };
  if (layer.Opct != 255) blendOptions.Opct = {
    t: "UntF",
    v: {
      type: "#Prc",
      val: Math.round(layer.Opct * 100 / 255)
    }
  };
  if (layer.add.iOpa != null) blendOptions.fillOpacity = {
    t: "UntF",
    v: {
      type: "#Prc",
      val: Math.round(layer.add.iOpa * 100 / 255)
    }
  };
  if (blendEntries.length != 0) blendOptions.Blnd = {
    t: "VlLs",
    v: blendEntries
  };

  const styleJson = {
      styleInfo: {
        classID: "null",
        Idnt: {
          t: "TEXT",
          v: generateUuid()
        },
        Nm: {
          t: "TEXT",
          v: "Custom Style"
        }
      },
      styleEffects: {
        classID: "Styl",
        blendOptions: {
          t: "Objc",
          v: blendOptions
        }
      }
    };

  const lmfx = layer.add.lmfx;
  if (lmfx) styleJson.styleEffects.Lefx = {
    t: "Objc",
    v: lmfx
  };
  return styleJson
};
export {
  LayerStyleRenderer,
};
