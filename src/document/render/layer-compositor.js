/**
 * Turns a layer tree into pixels.
 *
 * `LayerGroup` is the tree — nesting, sibling order, hit-testing, geometry. This
 * module is the walk over it that produces an image: per-layer software and
 * WebGL composite paths, clipping-mask groups, adjustment layers, and the
 * panel thumbnails. Every function takes the tree node it renders as its first
 * argument, so the model stays data and the render policy lives in one place.
 *
 * The entry points are `compositeLayerGpu` (what `Document.composite` drives)
 * and `renderThumbnailCanvases`; the rest are the steps they walk through.
 */

import { Rect } from "../../core/math/rect.js";
import { LayerSystem } from "../../engine/layer-system.js";
import { AdjustmentEngine } from "../../features/adjustments/adjustment-engine.js";
import { LayerStyleRenderer } from "../../features/layer-styles/style-renderer.js";
import { LayerThumbnails } from "../layer-thumbnails.js";
import { adjustmentKeyOf } from "../formats/psd/adjustment-parsers.js";
import { allocBuffer, equals, extractChannelByte, fillBuffer, fillBufferRect } from "../../engine/compositing/buffer-utils.js";
import { copyAlphaToChannel, copyChannelToAlpha, copyPixels, multiplyAlphaByAlpha, multiplyBuffers, multiplyMaskByRegion, scaleRgbaAlphaByMask } from "../../engine/compositing/pixel-ops.js";
import { composite, compositeLayer } from "../../engine/compositing/compositing-ops.js";
import { LayerSectionType } from "../model/layer.js"

/** Fit width x height into a square of maxSize, preserving aspect ratio. */
function fitAspectDimensions(width, height, maxSize) {
  if (width > height) {
    return {
      width: maxSize,
      height: Math.floor(maxSize * (height / width)),
    };
  }
  return {
    width: Math.floor(maxSize * (width / height)),
    height: maxSize,
  };
}

/** Collect consecutive clipping-mask siblings starting after childIdx. */
function collectClippingMaskSections(children, childIdx) {
  const clipSections = [];
  for (let clipCursor = childIdx + 1; clipCursor < children.length; clipCursor++) {
    if (!children[clipCursor].layer.isClippingMask) break;
    clipSections.push(children[clipCursor]);
  }
  return clipSections;
}

/**
 * Render targets and the blends that write into them. WebGL-backed when a
 * context is available, plain RGBA buffers otherwise, so the composite walk
 * reads the same either way.
 */
function createTextureManager() {
  return {
    delete(existingTarget) {
      if (existingTarget && existingTarget.c) existingTarget.delete();
    },

    createRenderTarget(width, height) {
      return LayerSystem.webglEnabled
        ? new LayerSystem.RgbaTexture(width, height)
        : allocBuffer(width * height * 4);
    },

    ensureTexture(existingTarget, width, height) {
      if (LayerSystem.webglEnabled) {
        if (existingTarget == null || existingTarget.width !== width || existingTarget.height !== height) {
          this.delete(existingTarget);
          return new LayerSystem.RgbaTexture(width, height);
        }
      } else if (
        existingTarget == null ||
        !ArrayBuffer.isView(existingTarget) ||
        existingTarget.length !== width * height * 4
      ) {
        this.delete(existingTarget);
        return allocBuffer(width * height * 4);
      }
      return existingTarget;
    },

    copyChannel(srcBuffer, srcRect, destBuffer, destRect, clipRect) {
      (LayerSystem.webglEnabled ? LayerSystem.copyGpuTextureRegion : copyPixels)(
        srcBuffer,
        srcRect,
        destBuffer,
        destRect,
        clipRect,
      );
    },

    compositeWithClipping(
      clipSourceTex,
      srcRect,
      dstTex,
      dstRect,
      weightTex,
      weightRect,
      maskChannelFill,
      clipRect,
      weightScale,
      dissolveMode,
      colorSwitch,
    ) {
      (LayerSystem.webglEnabled
        ? LayerSystem.renderers.compositeWithClipping
        : compositeLayer)(
        clipSourceTex,
        srcRect,
        dstTex,
        dstRect,
        weightTex,
        weightRect,
        maskChannelFill,
        clipRect,
        weightScale,
        dissolveMode,
        colorSwitch,
      );
    },

    composite(blendMode, srcBuffer, srcRect, destBuffer, destRect, clipRect, opacity, shapeStyle) {
      if (LayerSystem.webglEnabled) {
        LayerSystem.renderers.composite(
          blendMode,
          srcBuffer,
          srcRect,
          destBuffer,
          destRect,
          clipRect,
          opacity,
          shapeStyle,
        );
      } else {
        composite(
          blendMode,
          srcBuffer,
          srcRect,
          destBuffer,
          destRect,
          clipRect,
          opacity,
          shapeStyle,
        );
      }
    },

    fillBuffer(buffer, colorLo, colorHi) {
      if (LayerSystem.webglEnabled) {
        LayerSystem.bindRenderTarget(buffer);
        LayerSystem.clearWithColor(colorLo, colorHi);
      } else {
        fillBuffer(buffer, colorLo, colorHi);
      }
    },

    applyMaskToBuffer(maskBuffer, maskRect, threshold, destBuffer, destRect) {
      if (LayerSystem.webglEnabled) {
        LayerSystem.renderers.compositeWithClipping(
          null,
          null,
          destBuffer,
          destRect,
          maskBuffer,
          maskRect,
          threshold,
          destRect,
          1,
          false,
        );
        return;
      }
      if (threshold === 255) {
        scaleRgbaAlphaByMask(maskBuffer, maskRect, destBuffer, destRect);
        return;
      }
      const workAlpha = allocBuffer(maskRect.area());
      copyAlphaToChannel(destBuffer, destRect, workAlpha, maskRect);
      multiplyBuffers(maskBuffer, workAlpha);
      fillBuffer(destBuffer, 0, 16777215);
      copyChannelToAlpha(workAlpha, maskRect, destBuffer, destRect);
    },

    multiplyAlphaLayers(srcAlpha, srcRect, destBuffer, destRect) {
      if (LayerSystem.webglEnabled) {
        LayerSystem.renderers.compositeWithClipping(
          null,
          null,
          destBuffer,
          destRect,
          srcAlpha,
          srcRect,
          0,
          destRect,
          1,
          false,
        );
      } else {
        multiplyAlphaByAlpha(srcAlpha, srcRect, destBuffer, destRect);
      }
    },
  };
}

const textureManager = createTextureManager();

/** Stand-in cache for a layer whose render result is not worth keeping. */
const DISCARD_RENDER_CACHE = { renderCache: {} };

export function renderThumbnailCanvases(section, doc, boundsRect, thumbSizePx) {
  const layer = section.layer;
  if (layer.isGroup() && layer.add.artb != null) boundsRect = layer.getArtboardRect();

  let { width: thumbW, height: thumbH } = fitAspectDimensions(
    boundsRect.width,
    boundsRect.height,
    thumbSizePx,
  );
  if ((layer.hasFillContent() && layer.add.vmsk == null) || layer.add.TySh) {
    thumbW = thumbH = Math.max(thumbH, 16);
  } else {
    thumbW = Math.max(thumbW, 6);
    thumbH = Math.max(thumbH, 6);
  }

  let maxThumbDim = thumbH;
  const hasStrokeFill = layer.hasFillContent() && layer.add.vmsk;
  if (hasStrokeFill) {
    maxThumbDim = renderStrokeFillThumbnail(section, layer, thumbSizePx);
  } else if (layer.add.TySh) {
    LayerThumbnails.drawTextLayerThumbnail(
      layer.layerCanvas,
      maxThumbDim,
      maxThumbDim,
      layer.add.TySh,
    );
  } else if (layer.add.SoCo) {
    maxThumbDim = Math.max(16, Math.min(thumbW, thumbH));
    LayerThumbnails.drawSolidColorFillThumbnail(
      layer.layerCanvas,
      maxThumbDim,
      maxThumbDim,
      layer.add.SoCo,
    );
  } else if (layer.add.GdFl) {
    LayerThumbnails.drawGradientFillThumbnail(
      layer.layerCanvas,
      maxThumbDim,
      maxThumbDim,
      layer.add.GdFl,
    );
  } else if (layer.add.PtFl) {
    LayerThumbnails.drawPatternFillThumbnail(
      layer.layerCanvas,
      maxThumbDim,
      maxThumbDim,
      layer.add.PtFl,
      doc,
    );
  } else if (adjustmentKeyOf(layer.add) != null) {
    LayerThumbnails.drawAdjustmentLayerThumbnail(
      layer.layerCanvas,
      maxThumbDim,
      maxThumbDim,
      layer.add,
    );
  } else if (layer.add.placedData) {
    LayerThumbnails.drawRasterThumbnail(
      layer.layerCanvas,
      thumbW,
      thumbH,
      boundsRect,
      layer.buffer,
      layer.rect,
      false,
    );
    LayerThumbnails.drawSmartObjectFrameOverlay(
      layer.layerCanvas,
      thumbW,
      thumbH,
      layer.add.placedData,
    );
  } else if (layer.isGroup()) {
    maxThumbDim = 16;
  } else if (layer.hasPixelData()) {
    LayerThumbnails.drawRasterThumbnail(
      layer.layerCanvas,
      thumbW,
      thumbH,
      boundsRect,
      layer.buffer,
      layer.rect,
      false,
    );
  } else {
    LayerThumbnails.drawMissingLayerThumbnail(
      layer.layerCanvas,
      maxThumbDim,
      maxThumbDim,
    );
  }

  const mask = layer.getMask();
  if (mask) {
    LayerThumbnails.drawMaskChannelThumbnail(
      layer.rasterMaskCanvas,
      thumbW,
      thumbH,
      boundsRect,
      mask,
    );
  }
  if (layer.hasSmartFilters() && layer.getLinkedPlacedItem(doc) && layer.getLinkedPlacedItem(doc).d) {
    const linkedMask = layer.getLinkedPlacedItem(doc).d;
    LayerThumbnails.drawMaskChannelThumbnail(
      layer.smartObjectCanvas,
      thumbW,
      thumbH,
      boundsRect,
      linkedMask,
    );
  }
  if (!hasStrokeFill && layer.add.vmsk) {
    LayerThumbnails.drawMaskChannelThumbnail(
      layer.vectorMaskCanvas,
      thumbW,
      thumbH,
      boundsRect,
      layer.add.vmsk.getMask(),
      true,
    );
  }
  if (layer.add.vmsk || mask) maxThumbDim = Math.max(maxThumbDim, thumbH);
  layer.thumbnailHeight = Math.max(maxThumbDim, 16);
  if (layer.isGroup() && layer.add.lsct === LayerSectionType.OpenGroup) {
    for (let childIdx = 0; childIdx < section.children.length; childIdx++) {
      renderThumbnailCanvases(section.children[childIdx], doc, boundsRect, thumbSizePx);
    }
  }
}

export function renderStrokeFillThumbnail(section, layer, thumbSizePx) {
  let layerRect = layer.rect.clone();
  if (layerRect.isEmpty()) layerRect = new Rect(0, 0, 20, 20);
  let { width: vecThumbW, height: vecThumbH } = fitAspectDimensions(
    layerRect.width,
    layerRect.height,
    thumbSizePx,
  );
  if (vecThumbW * vecThumbH === 0) vecThumbW = vecThumbH = 16;
  LayerThumbnails.drawRasterThumbnail(
    layer.layerCanvas,
    vecThumbW,
    vecThumbH,
    layerRect,
    layer.buffer,
    layer.rect,
    false,
  );
  LayerThumbnails.drawLinkedLayerFrameOverlay(
    layer.layerCanvas,
    vecThumbW,
    vecThumbH,
  );
  return vecThumbH;
}

export function renderLayerSoftware(section, destBuffer, destRect, clipRect, doc, clippingSections) {
  const layer = section.layer;
  if (!layer.isVisible()) return;
  if (layer.Opct === 255) {
    renderLayerCoreSoftware(section, destBuffer, destRect, clipRect, doc, clippingSections);
    return;
  }
  const opacityBuffer = destBuffer.slice(0);
  renderLayerCoreSoftware(section, opacityBuffer, destRect, clipRect, doc, clippingSections);
  compositeLayer(
    opacityBuffer,
    destRect,
    destBuffer,
    destRect,
    null,
    null,
    0,
    clipRect,
    layer.Opct / 255,
    layer.blendMode === "diss",
  );
}

export function renderLayerCoreSoftware(section, destBuffer, destRect, clipRect, doc, clippingSections) {
  const layer = section.layer;
  layer.ensureImportRasterReady(doc);
  const shapeStyle = LayerStyleRenderer.buildShapeRenderStyle(layer);
  const isAdjustment = adjustmentKeyOf(layer.add) != null;
  let alphaChannel;
  let effectStack;
  if (
    layer.isGroup() &&
    layer.blendMode === "pass" &&
    !layer.isVectorShape() &&
    !(clippingSections.length > 0 || shapeStyle.fill !== 1 || layer.hasEnabledEffects())
  ) {
    renderChildrenSoftware(section, destBuffer, destRect, clipRect, doc);
    return;
  }
  const passWithClipping =
    layer.isGroup() &&
    layer.blendMode === "pass" &&
    (clippingSections.length > 0 || shapeStyle.fill !== 1 || layer.hasEnabledEffects());
  let workRect = layer.rect;
  let rgbaBuffer = layer.buffer;
  if (layer.isGroup()) {
    workRect = section.getSelectionRect(doc, false);
    const groupRgba = allocBuffer(workRect.area() * 4);
    alphaChannel = allocBuffer(workRect.area());
    renderChildrenSoftware(section, groupRgba, workRect, clipRect, doc);
    extractChannelByte(groupRgba, alphaChannel, 3);
  } else if (isAdjustment) {
    workRect = destRect.clone();
    alphaChannel = allocBuffer(workRect.area());
    alphaChannel.fill(255);
  } else {
    workRect = layer.rect;
    alphaChannel = allocBuffer(workRect.area());
    extractChannelByte(rgbaBuffer, alphaChannel, 3);
  }
  if (layer.isVectorShape()) {
    const vectorRaster = layer.d.rasterizeTo(workRect);
    multiplyMaskByRegion(vectorRaster, workRect, alphaChannel, workRect);
  }
  if (layer.hasEnabledEffects()) {
    effectStack = LayerStyleRenderer.buildLayerStyleEffectStack(
      layer.add.lmfx,
      layer.add.fxrp,
      alphaChannel,
      workRect,
      doc,
    );
  }
  if (layer.hasEnabledEffects()) {
    LayerStyleRenderer.compositeEffectsOntoLayer(
      layer.add.lmfx,
      effectStack,
      workRect,
      destBuffer,
      destRect,
      clipRect,
    );
  }
  if (layer.isGroup()) {
    rgbaBuffer = allocBuffer(workRect.area() * 4);
    if (layer.blendMode === "pass") copyPixels(destBuffer, destRect, rgbaBuffer, workRect);
    if (passWithClipping) {
      const groupRgba = allocBuffer(workRect.area() * 4);
      renderChildrenSoftware(section, groupRgba, workRect, clipRect, doc);
      const childAlpha = allocBuffer(workRect.area());
      extractChannelByte(groupRgba, childAlpha, 3);
      scaleRgbaAlphaByMask(childAlpha, workRect, rgbaBuffer, workRect);
    }
    renderChildrenSoftware(section, rgbaBuffer, workRect, clipRect, doc);
  }
  if (isAdjustment) {
    rgbaBuffer = destBuffer.slice(0);
    fillBuffer(rgbaBuffer, 4278190080, 16777215);
    const adjKey = adjustmentKeyOf(layer.add);
    const shaderOpts = AdjustmentEngine.buildShaderOptions(adjKey, layer.add[adjKey]);
    AdjustmentEngine.applySoftware(shaderOpts, rgbaBuffer, rgbaBuffer, workRect);
  }
  const clippedBuffer = rgbaBuffer.slice(0);
  fillBuffer(clippedBuffer, 4278190080, 16777215);
  for (let clipIdx = 0; clipIdx < clippingSections.length; clipIdx++) {
    renderLayerSoftware(clippingSections[clipIdx], clippedBuffer, workRect, clipRect, doc, []);
  }
  const destBackup = allocBuffer(workRect.area() * 4);
  copyPixels(destBuffer, destRect, destBackup, workRect);
  if (isAdjustment) shapeStyle.preserveDestAlpha = true;
  composite(
    layer.blendMode === "pass" ? "norm" : layer.blendMode,
    clippedBuffer,
    workRect,
    destBackup,
    workRect,
    clipRect,
    1,
    shapeStyle,
  );
  if (layer.hasEnabledEffects()) {
    const frameFxList = layer.renderCache.gpuEffectsData.type.FrFX;
    let widestFrameFx = null;
    let effectsScratch;
    if (frameFxList.length !== 0) {
      widestFrameFx = frameFxList[0];
      for (let clipIdx = 0; clipIdx < frameFxList.length; clipIdx++) {
        if (frameFxList[clipIdx].compositeRect.width > widestFrameFx.compositeRect.width) {
          widestFrameFx = frameFxList[clipIdx];
        }
      }
      effectsScratch = allocBuffer(
        widestFrameFx.compositeRect.width * widestFrameFx.compositeRect.height * 4,
      );
      copyPixels(destBuffer, destRect, effectsScratch, widestFrameFx.compositeRect);
    }
    LayerStyleRenderer.rasterizeEffectsToBuffer(
      layer.add.lmfx,
      effectStack,
      workRect,
      destBuffer,
      destRect,
      clipRect,
      destBackup,
      effectsScratch,
      widestFrameFx ? widestFrameFx.compositeRect : null,
    );
  }
  compositeLayer(
    destBackup,
    workRect,
    destBuffer,
    destRect,
    alphaChannel,
    workRect,
    0,
    clipRect,
    1,
    layer.blendMode === "diss",
  );
}

export function renderChildrenSoftware(section, destBuffer, destRect, clipRect, doc) {
  const children = section.children;
  for (let childIdx = 0; childIdx < children.length; childIdx++) {
    const clipSections = collectClippingMaskSections(children, childIdx);
    renderLayerSoftware(children[childIdx], destBuffer, destRect, clipRect, doc, clipSections);
    childIdx += clipSections.length;
  }
}

export function compositeLayerGpu(section, destBuffer, destRect, clipRect, doc, clippingSections, depthLimit) {
  const isDepthNumber = typeof depthLimit === "number";
  if (
    !section.layer.isGroup() &&
    ((isDepthNumber && section.index > depthLimit) ||
      (!isDepthNumber && depthLimit.indexOf(section.index) === -1))
  ) {
    return;
  }
  const layer = section.layer;
  const shapeStyle = LayerStyleRenderer.buildShapeRenderStyle(layer);
  const texMgr = textureManager;
  const maskOrVector = layer.hasFillContent() ? layer.getMask() : layer.d;
  if (!layer.isVisible()) return;
  if (layer.isVectorShape() && maskOrVector.rect.isEmpty()) return;
  if (layer.add.vstk == null && section.getSelectionRect(doc, false).isEmpty() && layer.add.artb == null) {
    return;
  }
  const compositeRect = section.getSelectionRect(doc, true).intersect(clipRect);
  if (!destRect.equals(clipRect) && !clipRect.overlaps(compositeRect) && layer.add.artb == null) {
    return;
  }
  if (layer.isGroup() && layer.add.artb) {
    const artboardRect = layer.getArtboardRect();
    clipRect = clipRect.intersect(artboardRect);
    const artboardBg = layer.getArtboardBgColor();
    if (artboardBg !== 0) {
      if (LayerSystem.webglEnabled) {
        LayerSystem.bindRenderTarget(destBuffer, clipRect);
        LayerSystem.clearWithColor(artboardBg);
        LayerSystem.clearWithColor(artboardBg);
      } else {
        fillBufferRect(destBuffer, destRect, clipRect, artboardBg);
      }
    }
  }
  const needsOpacityWrap = needsOpacityWrapper(layer, clippingSections, shapeStyle);
  if (!needsOpacityWrap) {
    compositeLayerCoreGpu(section, destBuffer, destRect, clipRect, doc, clippingSections, depthLimit);
    return;
  }
  layer.renderCache.opacityWrapBuffer = texMgr.ensureTexture(
    layer.renderCache.opacityWrapBuffer,
    compositeRect.width,
    compositeRect.height,
  );
  texMgr.copyChannel(
    destBuffer,
    destRect,
    layer.renderCache.opacityWrapBuffer,
    compositeRect,
    clipRect,
  );
  compositeLayerCoreGpu(section, 
    layer.renderCache.opacityWrapBuffer,
    compositeRect,
    clipRect,
    doc,
    clippingSections,
    depthLimit,
  );
  texMgr.compositeWithClipping(
    layer.renderCache.opacityWrapBuffer,
    compositeRect,
    destBuffer,
    destRect,
    null,
    null,
    0,
    clipRect,
    layer.Opct / 255,
    layer.blendMode === "diss",
    shapeStyle.channelRestrictions,
  );
}

/**
 * True when the layer must be composited into a scratch buffer first: a
 * restricted channel, or partial opacity that has to apply to the group,
 * its clipping stack and its effects as a whole rather than per element.
 */
export function needsOpacityWrapper(layer, clippingSections, shapeStyle) {
  if (shapeStyle.channelRestrictions[0] * shapeStyle.channelRestrictions[1] * shapeStyle.channelRestrictions[2] === 0) return true;
  return (
    layer.Opct !== 255 &&
    (clippingSections.length !== 0 || layer.isGroup() || layer.hasEnabledEffects())
  );
}

export function compositeLayerCoreGpu(section, destBuffer, destRect, clipRect, doc, clippingSections, depthLimit) {
  const layer = section.layer;
  layer.ensureImportRasterReady(doc);
  const shapeStyle = LayerStyleRenderer.buildShapeRenderStyle(layer);
  const isAdjustment = adjustmentKeyOf(layer.add) != null;
  const texMgr = textureManager;
  const needsOpacityWrap = needsOpacityWrapper(layer, clippingSections, shapeStyle);
  const opacityScale = needsOpacityWrap ? 1 : layer.Opct / 255;
  const maskOrVector = layer.hasFillContent() ? layer.getMask() : layer.d;
  const childrenOnly =
    layer.isGroup() &&
    layer.blendMode === "pass" &&
    !(clippingSections.length > 0 || shapeStyle.fill !== 1 || layer.hasEnabledEffects());
  const layerOnly =
    !layer.isGroup() &&
    !isAdjustment &&
    !layer.hasEnabledEffects() &&
    clippingSections.length === 0;
  const adjOnly = isAdjustment && !layer.hasEnabledEffects() && clippingSections.length === 0;
  let layerTexture = null;
  let alphaTexture = null;
  let groupTexture = null;
  let blendSource;

  if (childrenOnly || layerOnly || adjOnly) {
    let fastDestTex = destBuffer;
    let fastDestRect = destRect;
    if (layer.isVectorShape()) {
      fastDestRect = section.getSelectionRect(doc, false);
      fastDestTex = layer.renderCache.tempBuffer = texMgr.ensureTexture(
        layer.renderCache.tempBuffer,
        fastDestRect.width,
        fastDestRect.height,
      );
      texMgr.copyChannel(destBuffer, destRect, layer.renderCache.tempBuffer, fastDestRect);
    }
    if (childrenOnly) compositeChildrenGpu(section, fastDestTex, fastDestRect, clipRect, doc, depthLimit);
    if (layerOnly) {
      texMgr.composite(
        layer.blendMode,
        layer.getLayerTexture(doc),
        layer.rect,
        fastDestTex,
        fastDestRect,
        clipRect,
        opacityScale,
        shapeStyle,
      );
    }
    if (adjOnly) {
      const renderRect =
        layer.isVectorShape() && maskOrVector.getThreshold() === 0
          ? maskOrVector.getSelectionRect().clone()
          : fastDestRect.clone();
      let adjCache = layer.renderCache;
      if (renderRect.equals(new Rect(0, 0, doc.width, doc.height))) {
        adjCache = DISCARD_RENDER_CACHE;
      }
      adjCache.adjustmentTexture = renderAdjustmentLayer(section, 
        fastDestTex,
        fastDestRect,
        adjCache.adjustmentTexture,
        renderRect,
        layer.add,
      );
      shapeStyle.preserveDestAlpha = true;
      texMgr.composite(
        layer.blendMode,
        adjCache.adjustmentTexture,
        renderRect,
        fastDestTex,
        fastDestRect,
        clipRect,
        opacityScale,
        shapeStyle,
      );
    }
    if (layer.isVectorShape()) {
      texMgr.compositeWithClipping(
        fastDestTex,
        fastDestRect,
        destBuffer,
        destRect,
        layer.getMaskTexture(),
        maskOrVector.getSelectionRect(),
        maskOrVector.getThreshold(),
        clipRect,
        1,
        layer.blendMode === "diss",
      );
    }
    layer.renderCache.markClean();
    return;
  }

  const passWithClipping =
    layer.isGroup() &&
    layer.blendMode === "pass" &&
    (clippingSections.length > 0 || shapeStyle.fill !== 1 || layer.hasEnabledEffects());
  let renderRect = layer.rect;
  if (layer.isGroup()) {
    renderRect = section.getSelectionRect(doc, false);
    groupTexture = layer.renderCache.groupBuffer = texMgr.ensureTexture(
      layer.renderCache.groupBuffer,
      renderRect.width,
      renderRect.height,
    );
    texMgr.fillBuffer(groupTexture, 0);
    compositeChildrenGpu(section, groupTexture, renderRect, renderRect, doc, depthLimit);
    alphaTexture = texMgr.ensureTexture(
      layer.renderCache.alphaBuffer,
      renderRect.width,
      renderRect.height,
    );
    texMgr.copyChannel(groupTexture, renderRect, alphaTexture, renderRect);
  } else if (isAdjustment) {
    renderRect =
      layer.isVectorShape() && maskOrVector.getThreshold() === 0
        ? maskOrVector.getSelectionRect().clone()
        : destRect.clone();
    alphaTexture = texMgr.ensureTexture(
      layer.renderCache.alphaBuffer,
      renderRect.width,
      renderRect.height,
    );
    texMgr.fillBuffer(alphaTexture, 4294967295);
  } else {
    renderRect = layer.rect;
    layerTexture = layer.getLayerTexture(doc);
    alphaTexture = texMgr.ensureTexture(
      layer.renderCache.alphaBuffer,
      renderRect.width,
      renderRect.height,
    );
    texMgr.copyChannel(layerTexture, renderRect, alphaTexture, renderRect);
  }
  layer.renderCache.alphaBuffer = alphaTexture;
  if (layer.isVectorShape()) {
    texMgr.applyMaskToBuffer(
      layer.getMaskTexture(),
      maskOrVector.getSelectionRect(),
      maskOrVector.getThreshold(),
      alphaTexture,
      renderRect,
    );
  }
  if (layer.hasEnabledEffects()) {
    if (
      layer.renderCache.dirtyRect ||
      layer.renderCache.dirty ||
      layer.renderCache.webglEnabled !== LayerSystem.webglEnabled ||
      layer.renderCache.needsRebuild ||
      layer.isGroup()
    ) {
      const effectAlpha = allocBuffer(renderRect.width * renderRect.height);
      if (LayerStyleRenderer.hasNonFillEffects(layer.add.lmfx)) {
        if (LayerSystem.webglEnabled) {
          if (!layer.isGroup() && layer.getMask() == null && layer.rect.equals(renderRect)) {
            extractChannelByte(layer.buffer, effectAlpha, 3);
          } else {
            const rgbaScratch = allocBuffer(renderRect.width * renderRect.height * 4);
            alphaTexture.get(rgbaScratch);
            extractChannelByte(rgbaScratch, effectAlpha, 3);
          }
        } else {
          extractChannelByte(alphaTexture, effectAlpha, 3);
        }
      }
      if (
        layer.renderCache.dirty ||
        layer.renderCache.webglEnabled !== LayerSystem.webglEnabled ||
        !equals(effectAlpha, layer.renderCache.cachedAlphaBuffer)
      ) {
        let vectorMaskRect = null;
        if (
          layer.hasFillContent() &&
          layer.add.vmsk &&
          layer.add.vmsk.isEnabled &&
          layer.add.vmsk.getMask().color === 0
        ) {
          vectorMaskRect = layer.add.vmsk.getMask().rect;
        }
        LayerStyleRenderer.uploadEffectStackToGpu(
          layer.renderCache.gpuEffectsData,
          effectAlpha,
          renderRect,
          layer.add.lmfx,
          layer.add.fxrp,
          doc,
          vectorMaskRect,
        );
        layer.renderCache.cachedAlphaBuffer = effectAlpha;
      }
    }
  }
  if (layer.hasEnabledEffects()) {
    LayerStyleRenderer.compositeEffectsOntoLayer(
      layer.add.lmfx,
      layer.renderCache.gpuEffectsData,
      renderRect,
      destBuffer,
      destRect,
      clipRect,
    );
  }
  if (layer.isGroup()) {
    layerTexture = texMgr.ensureTexture(
      layer.renderCache.tempBuffer,
      renderRect.width,
      renderRect.height,
    );
    texMgr.fillBuffer(layerTexture, 0);
    if (layer.blendMode === "pass") {
      texMgr.copyChannel(destBuffer, destRect, layerTexture, renderRect);
    }
    if (passWithClipping) {
      texMgr.multiplyAlphaLayers(groupTexture, renderRect, layerTexture, renderRect);
    }
    compositeChildrenGpu(section, layerTexture, renderRect, clipRect, doc, depthLimit);
    layer.renderCache.tempBuffer = layerTexture;
  }
  if (isAdjustment) {
    layerTexture = layer.renderCache.tempBuffer = renderAdjustmentLayer(section, 
      destBuffer,
      destRect,
      layer.renderCache.tempBuffer,
      renderRect,
      layer.add,
    );
  }
  if (layer.isGroup() || isAdjustment) {
    blendSource = layerTexture;
  } else {
    blendSource = texMgr.ensureTexture(
      layer.renderCache.tempBuffer,
      renderRect.width,
      renderRect.height,
    );
    texMgr.copyChannel(layerTexture, renderRect, blendSource, renderRect, clipRect);
    layer.renderCache.tempBuffer = blendSource;
  }
  texMgr.fillBuffer(blendSource, 4278190080, 16777215);
  for (let clipIdx = 0; clipIdx < clippingSections.length; clipIdx++) {
    compositeLayerGpu(clippingSections[clipIdx], blendSource, renderRect, clipRect, doc, [], depthLimit);
  }
  const destBackup = (layer.renderCache.destBackupBuffer = texMgr.ensureTexture(
    layer.renderCache.destBackupBuffer,
    renderRect.width,
    renderRect.height,
  ));
  texMgr.copyChannel(destBuffer, destRect, destBackup, renderRect, clipRect);
  if (isAdjustment) shapeStyle.preserveDestAlpha = true;
  texMgr.composite(
    layer.blendMode === "pass" ? "norm" : layer.blendMode,
    blendSource,
    renderRect,
    destBackup,
    renderRect,
    clipRect,
    1,
    shapeStyle,
  );
  if (layer.hasEnabledEffects()) {
    const frameFxList = layer.renderCache.gpuEffectsData.type.FrFX;
    let widestFrameFx = null;
    if (frameFxList.length !== 0) {
      widestFrameFx = frameFxList[0];
      for (let clipIdx = 0; clipIdx < frameFxList.length; clipIdx++) {
        if (frameFxList[clipIdx].compositeRect.width > widestFrameFx.compositeRect.width) {
          widestFrameFx = frameFxList[clipIdx];
        }
      }
      layer.renderCache.effectsBaseBuffer = texMgr.ensureTexture(
        layer.renderCache.effectsBaseBuffer,
        widestFrameFx.compositeRect.width,
        widestFrameFx.compositeRect.height,
      );
      texMgr.copyChannel(
        destBuffer,
        destRect,
        layer.renderCache.effectsBaseBuffer,
        widestFrameFx.compositeRect,
        clipRect,
      );
      layer.renderCache.effectsOutputBuffer = texMgr.ensureTexture(
        layer.renderCache.effectsOutputBuffer,
        widestFrameFx.compositeRect.width,
        widestFrameFx.compositeRect.height,
      );
    }
    LayerStyleRenderer.rasterizeEffectsToBuffer(
      layer.add.lmfx,
      layer.renderCache.gpuEffectsData,
      renderRect,
      destBuffer,
      destRect,
      clipRect,
      destBackup,
      layer.renderCache.effectsBaseBuffer,
      layer.renderCache.effectsOutputBuffer,
      widestFrameFx ? widestFrameFx.compositeRect : null,
    );
  }
  if (!LayerSystem.webglEnabled) {
    const alphaScratch = allocBuffer(renderRect.area());
    extractChannelByte(alphaTexture, alphaScratch, 3);
    alphaTexture = alphaScratch;
  }
  texMgr.compositeWithClipping(
    destBackup,
    renderRect,
    destBuffer,
    destRect,
    alphaTexture,
    renderRect,
    0,
    clipRect,
    1,
    layer.blendMode === "diss",
  );
  layer.renderCache.markClean();
}

export function renderAdjustmentLayer(section, destBuffer, destRect, existingTexture, renderRect, layerAdd) {
  const adjKey = adjustmentKeyOf(layerAdd);
  let shaderOpts;
  if (adjKey) shaderOpts = AdjustmentEngine.buildShaderOptions(adjKey, layerAdd[adjKey]);
  const texMgr = textureManager;
  existingTexture = texMgr.ensureTexture(existingTexture, renderRect.width, renderRect.height);
  if (!(LayerSystem.webglEnabled && destRect.equals(renderRect))) {
    texMgr.copyChannel(destBuffer, destRect, existingTexture, renderRect);
  }
  if (shaderOpts) {
    if (LayerSystem.webglEnabled) {
      const bindRect = renderRect.clone();
      bindRect.x = bindRect.y = 0;
      if (destRect.equals(renderRect)) {
        LayerSystem.bindRenderTarget(existingTexture, bindRect);
        AdjustmentEngine.applyGpu(shaderOpts, destBuffer.glTexture, bindRect);
      } else {
        LayerSystem.bindRenderTarget(existingTexture, renderRect);
        existingTexture.saveBackup(renderRect);
        AdjustmentEngine.applyGpu(shaderOpts, existingTexture.backupTexture, bindRect);
      }
    } else {
      AdjustmentEngine.applySoftware(shaderOpts, existingTexture, existingTexture, renderRect);
    }
  }
  return existingTexture;
}

export function compositeChildrenGpu(section, destBuffer, destRect, clipRect, doc, depthLimit) {
  const children = section.children;
  for (let childIdx = 0; childIdx < children.length; childIdx++) {
    const clipSections = collectClippingMaskSections(children, childIdx);
    compositeLayerGpu(
      children[childIdx],
      destBuffer,
      destRect,
      clipRect,
      doc,
      clipSections,
      depthLimit,
    );
    childIdx += clipSections.length;
  }
}
