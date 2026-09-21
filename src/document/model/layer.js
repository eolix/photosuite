/**
 * Layer: pixel buffer, masks, vector data, effects, and render cache for one
 * stack entry. {@link LayerSectionType} marks group open/close/divider roles.
 */

import { Point } from "../../core/math/point.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { BlendModes } from "./blend-modes.js";
import { LayerSystem } from "../../engine/layer-system.js";
import { Mask, VectorMask } from "./layer-masks.js";
import { cloneLayerAdditionalValue } from "../formats/psd/layer-data-parsers.js";
import { LayerEffectDefs } from "../formats/psd/effect-defs.js";
import { AdjustmentEngine } from "../../features/adjustments/adjustment-engine.js";
import { TextEngineData } from "../../features/text/text-engine.js";
import { FilterDefs } from "../../features/filters/filter-registry.js";
import { LayerStyleRenderer } from "../../features/layer-styles/style-renderer.js";
import { adjustmentKeyOf } from "../formats/psd/adjustment-parsers.js";
import { makeElement } from "../../core/dom.js";
import { unpackDoublesList } from "../formats/psd/descriptor-codec.js";
import { rasterizeWithMatrix } from "../render/raster-transform.js";
import { allocBuffer, copyBuffer, equals, extractChannel, extractChannelByte, fillBuffer } from "../../engine/compositing/buffer-utils.js";
import { contentBoundsChannel, copyChannel, copyChannelToAlpha, copyPixels, extendRgbaBuffer, getWhiteBuffer, getZeroBuffer, scaleBuffer, scaleRgbaAlphaByMask, trimRgbaToContent } from "../../engine/compositing/pixel-ops.js";
import { boundsFromCoordPairs } from "../../engine/compositing/anti-alias.js";
import { composeHomographies, cornersToHomography } from "../../engine/compositing/homography.js";
import { applyChannelOp, boundsOfPathRecords } from "../../engine/compositing/selection-utils.js";
import { flattenPathKnotCoords } from "../../engine/compositing/path-records.js";
import { createForSubpaths } from "../../engine/compositing/key-origins.js";
import { composite, compositeDissolvedDitheredClipped, compositeLayer } from "../../engine/compositing/compositing-ops.js";
import { invert } from "../../engine/compositing/color-math.js";
import { psdColorToRgb } from "../../engine/compositing/psd-color-utils.js";
import { getWarpControlPoints, isIdentityWarp } from "../../engine/compositing/warp.js";

const LayerSectionType = {
  Normal: 0,
  OpenGroup: 1,
  ClosedGroup: 2,
  BoundingDivider: 3
};

const BLEND_IF_CHANNEL_COUNT = 10;
const SCRATCH_CANVAS_SIZE = 30;
const SCRATCH_CANVAS_PROPERTY_NAMES = [
  "layerCanvas",
  "rasterMaskCanvas",
  "vectorMaskCanvas",
  "smartObjectCanvas",
];

function createDefaultBlendIfData() {
  const blendIfData = [];
  for (let channelIdx = 0; channelIdx < BLEND_IF_CHANNEL_COUNT; channelIdx++) {
    blendIfData.push(0, 0, 255, 255);
  }
  return blendIfData;
}

/**
 * Lazily allocate 30×30 scratch 2D contexts on first property access.
 */
function installLazyScratchCanvasGetters(proto) {

  SCRATCH_CANVAS_PROPERTY_NAMES.forEach(function (prop) {
    var backing = "_" + prop;
    Object.defineProperty(proto, prop, {
      configurable: true,
      get: function () {
        var ctx = this[backing];
        if (ctx == null) ctx = this[backing] = Layer.createLayerScratchContext2d();
        return ctx;
      },
      set: function (value) { this[backing] = value; }
    });
  });

}

/**
 * Snapshot raster/vector mask presence and relative offsets for invalidate().
 */
function buildMaskLayoutDescriptor(layer) {
  const descriptor = {
    hasRasterMask: false,
    hasVectorMask: false,
    rasterVectorOffsetX: 0,
    rasterVectorOffsetY: 0,
  };
  if (layer.add.vmsk && layer.add.vmsk.isEnabled) descriptor.hasVectorMask = true;
  const rasterMask = layer.getMask();
  if (rasterMask && rasterMask.isEnabled) descriptor.hasRasterMask = true;
  if (descriptor.hasRasterMask && descriptor.hasVectorMask) {
    descriptor.rasterVectorOffsetX = rasterMask.rect.x - layer.add.vmsk.getMask().rect.x;
    descriptor.rasterVectorOffsetY = rasterMask.rect.y - layer.add.vmsk.getMask().rect.y;
  }
  return descriptor;
}

class RenderCache {
  constructor() {

  this.needsRebuild = true;
  this.dirty = true;
  this.cachedAlphaBuffer = allocBuffer(0);
  this.cachedStrokeMask = allocBuffer(0);
  this.dirtyRect = null;
  this.gpuEffectsData = {};
  this.lastPlacedDataJson = null;
  this.contentOffsetFromMask = null;
  this.layerOffsetFromContent = null;
  this.layerTexture = null;
  this.maskTexture = null;
  this.opacityWrapBuffer = null;
  this.alphaBuffer = null;
  this.groupBuffer = null;
  this.tempBuffer = null;
  this.destBackupBuffer = null;
  this.effectsBaseBuffer = null;
  this.effectsOutputBuffer = null;
  this.webglEnabled = false
  }

  markClean() {
  this.needsRebuild = false;
  this.dirty = false;
  this.dirtyRect = null;
  this.webglEnabled = LayerSystem.webglEnabled
  }

  dispose() {
  LayerStyleRenderer.disposeEffectGpuResources(this.gpuEffectsData);
  this.cachedAlphaBuffer = allocBuffer(0);
  this.cachedStrokeMask = allocBuffer(0);
  if (this.layerTexture) this.layerTexture.delete();
  if (this.maskTexture) this.maskTexture.delete();
  this.layerTexture = null;
  this.maskTexture = null;
  var items = [this.opacityWrapBuffer, this.alphaBuffer, this.groupBuffer, this.tempBuffer, this.destBackupBuffer, this.effectsBaseBuffer];
  for (var cursor = 0; cursor < 6; cursor++)
    if (items[cursor] != null && items[cursor] instanceof LayerSystem.RgbaTexture) items[cursor].delete();
  this.opacityWrapBuffer = null;
  this.alphaBuffer = null;
  this.groupBuffer = null;
  this.tempBuffer = null;
  this.destBackupBuffer = null;
  this.effectsBaseBuffer = null
  }

}

export class Layer {
  constructor() {

  this.rect = null;
  this.blendMode = "norm";
  this.Opct = 255;
  this.isClippingMask = false;
  this.layerFlags = 0;
  this.groupIndex = 0;
  this.blendIfData = createDefaultBlendIfData();
  this.name = null;
  this.add = {};
  this.buffer = null;
  this.channelInfo = null;
  this.parsedMaskParams = null;
  this.d = null;
  this.warpData = null;
  this.thumbnailHeight = 30;
  // layerCanvas / rasterMaskCanvas / vectorMaskCanvas / smartObjectCanvas are
  // 30x30 scratch 2D contexts, created lazily via the prototype getters below.
  // Creating them eagerly here cost four canvas+context allocations per layer,
  // which is catastrophic for imports that build tens of thousands of layers
  // (e.g. a complex .ai file → ~92k contexts). Most layers never touch them.
  this.pixelContent = 0;
  this.pathLayerActive = false;
  this.pixCache = null;
  this.renderCache = new RenderCache
  }

  static createLayerScratchContext2d() {
  var createElement = makeElement("canvas");
  createElement.width = createElement.height = 30;
  createElement.setAttribute("draggable", "false");
  return createElement.getContext("2d");
  }

  static rectToArtboardDescriptor(rect) {
  var descriptor = {
    classID: "classFloatRect",
    Top: {
      t: "doub",
      v: 0
    },
    Left: {
      t: "doub",
      v: 0
    },
    Btom: {
      t: "doub",
      v: 0
    },
    Rght: {
      t: "doub",
      v: 0
    }
  };
  descriptor.Btom.v = rect.y + rect.height;
  descriptor.Left.v = rect.x;
  descriptor.Rght.v = rect.x + rect.width;
  descriptor.Top.v = rect.y;
  return descriptor;
  }

  markDirty(dirtyRect) {
  if (dirtyRect == null) dirtyRect = this.rect.clone();
  if (this.renderCache.dirtyRect == null) this.renderCache.dirtyRect = dirtyRect;
  else this.renderCache.dirtyRect = this.renderCache.dirtyRect.union(dirtyRect)
  }

  isGroup() {
  return this.add.lsct == LayerSectionType.OpenGroup || this.add.lsct == LayerSectionType.ClosedGroup;
  }

  hasFillContent() {
  var layerExtra = this.add;
  return layerExtra.SoCo != null || layerExtra.GdFl != null || layerExtra.PtFl != null;
  }

  invalidateAlignedFills() {
  var lmfx = this.add.lmfx;
  if (lmfx == null) return;
  var items = ["GrFl", "patternFill"];
  for (var cursor = 0; cursor < items.length; cursor++) {
    var SIdx = LayerEffectDefs.effectKeys[LayerEffectDefs.order.indexOf(items[cursor])],
      length = lmfx[SIdx].v;
    if (length.length == 0) continue;
    for (var cursor2 = 0; cursor2 < length.length; cursor2++) {
      var enab = length[cursor2].v;
      if (enab.enab.v && (enab.Algn == null || !enab.Algn.v)) this.renderCache.dirty = true
    }
  }
  }

  getMaskTexture() {
  var mask = this.d;
  if (this.hasFillContent()) mask = this.getMask();
  if (!LayerSystem.webglEnabled) return mask.getMaskBuffer();
  if (this.renderCache.maskTexture == null || this.renderCache.needsRebuild || LayerSystem.webglEnabled != this.renderCache.webglEnabled) {
    if (this.renderCache.maskTexture) this.renderCache.maskTexture.delete();
    this.renderCache.maskTexture = new LayerSystem.AlphaTexture(mask.getSelectionRect().width, mask.getSelectionRect().height);
    this.renderCache.maskTexture.set(mask.getMaskBuffer())
  }
  return this.renderCache.maskTexture;
  }

  getLayerTexture(doc) {
  var rect = this.rect,
    buffer = this.buffer;
  if (!LayerSystem.webglEnabled) {
    var applyFilterMask = this.applyFilterMask(doc, buffer, rect);
    if (applyFilterMask) {
      buffer = applyFilterMask.buffer;
      rect = applyFilterMask.rect
    }
    return buffer;
  }
  if (this.renderCache.dirtyRect != null || LayerSystem.webglEnabled != this.renderCache.webglEnabled) {
    var applyFilterMask = this.applyFilterMask(doc, buffer, rect);
    if (applyFilterMask) {
      buffer = applyFilterMask.buffer;
      rect = applyFilterMask.rect
    }
    var textureRect = rect;
    if (LayerSystem.webglEnabled != this.renderCache.webglEnabled || this.renderCache.layerTexture == null || this.renderCache.layerTexture.width != textureRect.width || this.renderCache.layerTexture.height != textureRect.height) {
      if (this.renderCache.layerTexture) this.renderCache.layerTexture.delete();
      this.renderCache.layerTexture = new LayerSystem.RgbaTexture(textureRect.width, textureRect.height);
      this.renderCache.layerTexture.set(buffer)
    } else {
      var clonedRect = this.renderCache.dirtyRect.clone();
      clonedRect.offset(-rect.x, -rect.y);
      this.renderCache.layerTexture.set(buffer, clonedRect)
    }
  }
  return this.renderCache.layerTexture;
  }

  isVectorShape() {
  var mask = this.d;
  if (this.hasFillContent()) mask = this.getMask();
  return mask != null && mask.isEnabled && (mask.getThreshold() == 0 || mask.getThreshold() != 0 && !mask.rect.isEmpty());
  }

  applyFilterMask(doc, layerBuffer, layerRect) {
  if (this.hasSmartFilters()) {
    var linkedItem = this.getLinkedPlacedItem(doc);
    if (linkedItem.d && linkedItem.d.isEnabled && (!linkedItem.d.rect.isEmpty() || linkedItem.d.color == 0)) {
      var filterFx = this.add.placedData.filterFX.v;
      linkedItem.d.density = filterFx.filterMaskDensity ? filterFx.filterMaskDensity.v : 255;
      linkedItem.d.feather = filterFx.filterMaskFeather ? filterFx.filterMaskFeather.v : 0;
      var filterMaskBuffer = linkedItem.buffer,
        rasterizedMask = linkedItem.d.rasterizeTo(layerRect);
      invert(rasterizedMask);
      layerBuffer = layerBuffer.slice(0);
      compositeLayer(filterMaskBuffer, linkedItem.rect, layerBuffer, layerRect, rasterizedMask, layerRect, 0, layerRect, 1);
      return {
        buffer: layerBuffer,
        rect: layerRect
      }
    }
  }
  }

  getMaskOffsets() {
    return buildMaskLayoutDescriptor(this);
  }

  invalidate(doc) {
  if (this.add.lsct == LayerSectionType.BoundingDivider) return;
  var layer = this,
    rasterMaskDirty = this.getMask() != null && this.getMask().maskCombineDirty,
    vectorMaskDirty = this.add.vmsk != null && this.add.vmsk.maskCombineDirty,
    getMaskOffsets = this.getMaskOffsets(),
    maskLayoutChanged = JSON.stringify(getMaskOffsets) != this.renderCache.lastPlacedDataJson || getMaskOffsets.hasRasterMask && rasterMaskDirty || getMaskOffsets.hasVectorMask && vectorMaskDirty;
  if (maskLayoutChanged) {
    if (getMaskOffsets.hasVectorMask) {
      var getMask = this.add.vmsk.getMask();
      if (getMaskOffsets.hasRasterMask) {
        this.d = this.getMask().combineWith(getMask);
        this.renderCache.contentOffsetFromMask = new Point(this.d.rect.x - this.getMask().rect.x, this.d.rect.y - this.getMask().rect.y)
      } else this.d = getMask
    }
    if (this.d) this.renderCache.needsRebuild = true;
    if (this.d) this.renderCache.layerOffsetFromContent = new Point(this.rect.x - this.d.rect.x, this.rect.y - this.d.rect.y);
    if (getMaskOffsets.hasRasterMask) this.getMask().maskCombineDirty = false;
    if (getMaskOffsets.hasVectorMask) this.add.vmsk.maskCombineDirty = false;
    this.markDirty()
  } else {
    if (getMaskOffsets.hasRasterMask && getMaskOffsets.hasVectorMask) {
      this.d.rect.x = this.getMask().rect.x + this.renderCache.contentOffsetFromMask.x;
      this.d.rect.y = this.getMask().rect.y + this.renderCache.contentOffsetFromMask.y
    }
  }
  if (layer.hasFillContent()) {
    if (doc && doc.deferFillRasterization) this.renderCache.needsFillRaster = true;
    else this.renderFillContent(doc);
  }
  if (layer.hasPixelData()) {
    var contentOffset;
    if (this.d) contentOffset = new Point(this.rect.x - this.d.rect.x, this.rect.y - this.d.rect.y);
    if (this.d && this.d.isEnabled && (this.renderCache.layerOffsetFromContent == null || !contentOffset.equals(this.renderCache.layerOffsetFromContent))) {
      this.renderCache.layerOffsetFromContent = contentOffset;
      this.markDirty();
      this.renderCache.needsRebuild = true
    }
  }
  if (adjustmentKeyOf(layer.add) != null) this.renderCache.needsRebuild = true;
  this.renderCache.lastPlacedDataJson = JSON.stringify(getMaskOffsets)
  }

  renderFillContent(doc) {
  var layer = this,
    vstk = layer.add.vstk,
    fillRect, vectorMask = layer.add.vmsk ? this.add.vmsk.getMask() : null,
    fillEnabled = true;
  if (vectorMask && vectorMask.isEnabled && vectorMask.getThreshold() == 0) fillRect = vectorMask.getSelectionRect().clone();
  else fillRect = new Rect(0, 0, doc.width, doc.height);
  var rasterMask = layer.getMask();
  if (rasterMask && rasterMask.isEnabled && rasterMask.getThreshold() == 0) fillRect = fillRect.intersect(layer.d.getSelectionRect());
  var hasStroke = vectorMask && vstk;
  if (vstk && (!vstk.strokeEnabled.v || vstk.strokeStyleLineWidth.v.val == 0)) hasStroke = false;
  if (vstk && !vstk.fillEnabled.v && hasStroke) fillEnabled = false;
  var buffer = allocBuffer(fillRect.area() * 4);
  if (fillEnabled) {
    if (layer.add.SoCo) LayerStyleRenderer.applySolidColorEffect(buffer, layer.add.SoCo.Clr.v);
    if (layer.add.GdFl) {
      var vectorBounds = vectorMask && vectorMask.color == 0 ? boundsOfPathRecords(layer.add.vmsk.pathRecords, null, true) : null;
      LayerStyleRenderer.applyGradientFillEffect(layer.add.GdFl, buffer, fillRect, doc, null, vectorBounds)
    }
    if (layer.add.PtFl) LayerStyleRenderer.applyPatternFillEffect(layer.add.PtFl, buffer, fillRect, doc, layer.add.fxrp)
  }
  var fillMaskChannel;
  if (vectorMask) {
    var density = vectorMask.density;
    if (hasStroke) vectorMask.density = 255;
    fillMaskChannel = allocBuffer(fillRect.area());
    if (vectorMask.getThreshold() != 0) fillMaskChannel.fill(Math.round(vectorMask.getThreshold()));
    if (vectorMask && vectorMask.isEnabled) {
      var maskSelectionRect = vectorMask.getSelectionRect(),
        maskBuffer = vectorMask.getMaskBuffer();
      if (maskSelectionRect.equals(fillRect)) copyBuffer(maskBuffer, fillMaskChannel);
      else copyChannel(maskBuffer, maskSelectionRect, fillMaskChannel, fillRect)
    }
    if (layer.add.SoCo && fillEnabled) {
      extractChannel(fillMaskChannel, buffer, 3)
    } else scaleRgbaAlphaByMask(fillMaskChannel, fillRect, buffer, fillRect);
    if (hasStroke) vectorMask.density = density
  }
  layer.buffer = buffer;
  layer.rect = fillRect;
  if (hasStroke) {
    var strokeAlignType = LayerEffectDefs.StrokeStyleDefs.alignTypes.indexOf(vstk.strokeStyleLineAlignment.v.strokeStyleLineAlignment),
      strokeContent = vstk.strokeStyleContent.v,
      strokeFillType = LayerEffectDefs.StrokeStyleDefs.fillLayerTypes.indexOf(strokeContent.classID),
      strokeVectorMask = this.add.vmsk.getMask(vstk);
    if (!layer.rect.equals(new Rect(0, 0, doc.width, doc.height)) && strokeAlignType != 0) {
      var unionRect = layer.rect.union(strokeVectorMask.getSelectionRect()),
        unionBuffer = allocBuffer(unionRect.area() * 4);
      copyPixels(layer.buffer, layer.rect, unionBuffer, unionRect);
      layer.buffer = unionBuffer;
      layer.rect = unionRect
    }
    var density = strokeVectorMask.density;
    strokeVectorMask.density = 255;
    var strokeAlphaMask = strokeVectorMask.rasterizeTo(layer.rect);
    strokeVectorMask.density = density;
    if (strokeVectorMask.color == 255) invert(strokeAlphaMask);
    var strokeFillBuffer = allocBuffer(layer.rect.area() * 4);
    if (strokeFillType == 0) LayerStyleRenderer.applySolidColorEffect(strokeFillBuffer, strokeContent.Clr.v);
    if (strokeFillType == 1) LayerStyleRenderer.applyGradientFillEffect(strokeContent, strokeFillBuffer, layer.rect, doc, null, vectorMask.color == 0 ? vectorMask.rect : null);
    if (strokeFillType == 2) LayerStyleRenderer.applyPatternFillEffect(strokeContent, strokeFillBuffer, layer.rect, doc, layer.add.fxrp);
    var strokeOpacity = vstk.strokeStyleOpacity.v.val / 100;
    if (strokeOpacity != 1) scaleBuffer(strokeAlphaMask, strokeOpacity);
    extractChannel(strokeAlphaMask, strokeFillBuffer, 3);
    if (strokeVectorMask.color == 255) strokeAlignType = 2 - strokeAlignType;
    if (strokeAlignType == 0) {
      composite("norm", strokeFillBuffer, layer.rect, layer.buffer, layer.rect, layer.rect, 1);
      scaleRgbaAlphaByMask(fillMaskChannel, layer.rect, layer.buffer, layer.rect)
    }
    if (strokeAlignType == 1) {
      composite("norm", strokeFillBuffer, layer.rect, layer.buffer, layer.rect, layer.rect, 1)
    }
    if (strokeAlignType == 2) {
      invert(fillMaskChannel);
      compositeLayer(strokeFillBuffer, layer.rect, layer.buffer, layer.rect, fillMaskChannel, fillRect, 255, layer.rect, 1, false);
      invert(fillMaskChannel)
    }
    if (strokeVectorMask.density != 255) {
      var strokeFillCopy = strokeFillBuffer.slice(0);
      fillBuffer(strokeFillCopy, 4278190080, 16777215);
      composite("norm", strokeFillCopy, layer.rect, layer.buffer, layer.rect, layer.rect, 1 - strokeVectorMask.density / 255)
    }
    density = vectorMask.density;
    vectorMask.density = 255;
    this.cachedStrokeMask = vectorMask.rasterizeTo(layer.rect);
    vectorMask.density = density
  }
  this.markDirty()
  }

  rasterizeSmartObject(doc, skipSmartFilters) {
  if (doc && doc.deferFillRasterization) {
    this.renderCache.needsSmartObjectRaster = true;
    return;
  }
  var layer = this,
    placedId = layer.add.placedData.Idnt.v,
    placedData = layer.add.placedData,
    contentBounds = boundsFromCoordPairs(unpackDoublesList(placedData.nonAffineTransform)),
    linkedRaster = doc.resolveLinkedItemRaster(placedId, placedData.Crop ? placedData.Crop.v : null, [contentBounds.width, contentBounds.height], placedData.Impr.v.classID);
  if (linkedRaster == null) return;
  var rasterCache = linkedRaster.rasterCache;
  placedData.Sz.v.Wdth.v = rasterCache[1].width;
  placedData.Sz.v.Hght.v = rasterCache[1].height;
  var warp = placedData.warp.v,
    transformCorners = unpackDoublesList(placedData.nonAffineTransform),
    homography = cornersToHomography(transformCorners, rasterCache[1]);
  if (warp && !isIdentityWarp(warp)) {
    var warpBounds = boundsFromCoordPairs(getWarpControlPoints(warp)),
      warpOriginX = warpBounds.x,
      warpOriginY = warpBounds.y,
      invWarpWidth = 1 / warpBounds.width,
      invWarpHeight = 1 / warpBounds.height;
    homography = cornersToHomography(transformCorners);
    homography = composeHomographies(homography, [invWarpWidth, 0, -warpOriginX * invWarpWidth, 0, invWarpHeight, -warpOriginY * invWarpHeight, 0, 0])
  }
  var rasterResult = rasterizeWithMatrix(rasterCache, skipSmartFilters ? 0 : 1, homography, warp, null, null, null, skipSmartFilters);
  if (rasterResult == null) {
    layer.buffer = allocBuffer();
    layer.rect = new Rect
  } else if (layer.hasSmartFilters()) {
    var filterLoaderItem = layer.getLinkedPlacedItem(doc);
    filterLoaderItem.buffer = rasterResult.buffer;
    filterLoaderItem.rect = rasterResult.rect.clone();
    this.applySmartFilters(doc, skipSmartFilters)
  } else {
    layer.buffer = rasterResult.buffer;
    layer.rect = rasterResult.rect
  }
  layer.invalidate(doc);
  layer.markDirty();
  doc.markDirty()
  }

  ensureImportRasterReady(doc) {
  if (this.renderCache.needsFillRaster) {
    this.renderCache.needsFillRaster = false;
    this.renderFillContent(doc);
  }
  if (this.renderCache.needsSmartObjectRaster) {
    this.renderCache.needsSmartObjectRaster = false;
    this.rasterizeSmartObject(doc, false);
  }
  }

  applySmartFilters(doc, skipSmartFilters) {
  if (skipSmartFilters == null) skipSmartFilters = false;
  var filterLoaderItem = this.getLinkedPlacedItem(doc),
    filterFx = this.add.placedData.filterFX.v,
    filterPadding = FilterDefs.maxFilterPaddingFromFxList(filterFx),
    docBounds = new Rect(0, 0, doc.width, doc.height),
    paddedBounds = filterLoaderItem.rect.union(docBounds),
    inflatedRect = filterLoaderItem.rect.clone();
  inflatedRect.inflate(filterPadding.x, filterPadding.y);
  var filterPixels = {
    buffer: null,
    rect: paddedBounds.intersect(inflatedRect)
  };
  filterPixels.buffer = allocBuffer(filterPixels.rect.area() * 4);
  copyPixels(filterLoaderItem.buffer, filterLoaderItem.rect, filterPixels.buffer, filterPixels.rect);
  if (filterFx.enab.v && skipSmartFilters == false) {
    var filterList = filterFx.filterFXList.v;
    for (var filterIdx = 0; filterIdx < filterList.length; filterIdx++) {
      var filterEntry = filterList[filterIdx].v;
      if (filterEntry.enab.v == false) continue;
      var blendOptions = filterEntry.blendOptions.v,
        blendMode = BlendModes.fromPSD(blendOptions.Md.v.blendMode),
        blendOpacity = blendOptions.Opct.v.val / 100,
        foregroundRgb = psdColorToRgb(filterEntry.FrgC.v),
        backgroundRgb = psdColorToRgb(filterEntry.BckC.v),
        filterClassId = FilterDefs.getFilterClassIdFromFx(filterEntry),
        filteredPixels = {
          buffer: allocBuffer(filterPixels.buffer.length),
          rect: filterPixels.rect.clone()
        },
        filterDescriptor = filterEntry.Fltr ? filterEntry.Fltr.v : null;
      if (AdjustmentEngine.descriptorKeyMap[filterClassId] != null) {
        var adjustmentKey = AdjustmentEngine.descriptorKeyMap[filterClassId],
          shaderOptions = AdjustmentEngine.buildShaderOptions(adjustmentKey, filterDescriptor);
        if (shaderOptions) AdjustmentEngine.applySoftware(shaderOptions, filterPixels.buffer, filteredPixels.buffer, filterPixels.rect)
      } else FilterDefs.applyFilterToPixels(filterClassId, filterPixels, filterDescriptor, foregroundRgb, backgroundRgb, filteredPixels, [doc.add.lnk2 ? doc.add.lnk2 : [], this.getMask(), doc.extraChannels]);
      if (blendMode == "norm" && blendOpacity == 1) filterPixels = filteredPixels;
      else if (blendMode == "norm") {
        compositeLayer(filteredPixels.buffer, filteredPixels.rect, filterPixels.buffer, filterPixels.rect, null, null, null, filterPixels.rect, blendOpacity)
      } else {
        composite(blendMode, filteredPixels.buffer, filteredPixels.rect, filterPixels.buffer, filterPixels.rect, filterPixels.rect, blendOpacity)
      }
    }
  }
  this.rect = filterPixels.rect;
  this.buffer = filterPixels.buffer;
  this.trimToContent();
  this.markDirty();
  doc.markDirty()
  }

  updatePixCache(doc, selection, preserveLayerBuffer) {
  this.pixCache = this.computeSelectionPixels(doc, selection, preserveLayerBuffer)
  }

  /**
   * Lift the selected pixels off this layer, or null when the selection misses the
   * layer's content. With `cutFromLayer` the result also carries this layer's own
   * pixels with the selected region erased, as `cutBuffer` / `cutRect`, so a caller
   * can lift and erase within one transaction. This layer is never mutated.
   */
  extractSelectionData(doc, selection, cutFromLayer) {
  var pixCacheEntry = this.computeSelectionPixels(doc, selection, !cutFromLayer);
  if (pixCacheEntry == null) return null;
  var selectionData = {
    pixelContentKind: pixCacheEntry.pixelContent,
    pixBuf: pixCacheEntry.selectionPixels,
    rect: pixCacheEntry.selectionRect
  };
  if (cutFromLayer) {
    selectionData.cutBuffer = pixCacheEntry.layerBufferBackup;
    selectionData.cutRect = pixCacheEntry.layerRect;
  }
  if (selectionData.pixelContentKind == 1 || selectionData.pixelContentKind == 3) {
    var dataRect = selectionData.rect,
      rgbaBuffer = allocBuffer(dataRect.width * dataRect.height * 4);
    extractChannel(selectionData.pixBuf, rgbaBuffer, 0);
    extractChannel(selectionData.pixBuf, rgbaBuffer, 1);
    extractChannel(selectionData.pixBuf, rgbaBuffer, 2);
    copyChannelToAlpha(doc.selectionMask.channel, doc.selectionMask.rect, rgbaBuffer, dataRect);
    selectionData.pixBuf = rgbaBuffer
  }
  return selectionData
  }

  computeSelectionPixels(doc, selection, preserveLayerBuffer) {
  var selectionMask, selectionPixels, layerBufferBackup, selectionRect, layerRect, channelBackup, rectBackup;
  if (this.pixelContent <= 0) {
    var alphaChannel = allocBuffer(this.rect.area());
    extractChannelByte(this.buffer, alphaChannel, 3);
    selectionMask = applyChannelOp(selection, {
      channel: alphaChannel,
      rect: this.rect
    }, "intersection");
    if (selectionMask == null) return null;
    var contentBounds = contentBoundsChannel(selectionMask.channel, selectionMask.rect);
    selectionRect = selectionMask.rect.clone();
    layerRect = this.rect.clone();
    selectionPixels = allocBuffer(selectionRect.area() * 4);
    copyPixels(this.buffer, layerRect, selectionPixels, selectionRect);
    extractChannel(selectionMask.channel, selectionPixels, 3);
    layerBufferBackup = this.buffer.slice(0);
    if (!preserveLayerBuffer) {
      var invertedSelection = selection.channel.slice(0);
      invert(invertedSelection);
      scaleRgbaAlphaByMask(invertedSelection, selection.rect, layerBufferBackup, layerRect)
    }
    channelBackup = this.buffer.slice(0);
    rectBackup = this.rect.clone()
  }
  if (this.pixelContent == 1 || this.pixelContent == 3) {
    var maskOrFilterMask = this.pixelContent == 1 ? this.getMask() : this.getLinkedPlacedItem(doc).d;
    selectionRect = selection.rect.clone();
    layerRect = maskOrFilterMask.rect.clone();
    selectionPixels = maskOrFilterMask.getMaskForRect(selectionRect);
    layerBufferBackup = maskOrFilterMask.channel.slice(0);
    if (!preserveLayerBuffer) compositeDissolvedDitheredClipped(maskOrFilterMask.color == 255 ? getWhiteBuffer(selectionRect.area()) : getZeroBuffer(selectionRect.area()), selectionRect, layerBufferBackup, layerRect, selection.channel, selectionRect, 1);
    channelBackup = maskOrFilterMask.channel.slice(0);
    rectBackup = maskOrFilterMask.rect.clone()
  }
  return {
    pixelContent: this.pixelContent,
    selectionPixels: selectionPixels,
    selectionRect: selectionRect,
    layerBufferBackup: layerBufferBackup,
    layerRect: layerRect,
    channelBackup: channelBackup,
    rectBackup: rectBackup
  };
  }

  restoreFromPixCache(doc, savedPixCache) {
  var pixCache = this.pixCache;
  if (pixCache.pixelContent == 0) {
    this.rect = pixCache.rectBackup;
    this.buffer = pixCache.channelBackup;
    this.markDirty()
  }
  if (pixCache.pixelContent == 1 || pixCache.pixelContent == 3) {
    var maskOrFilterMask = pixCache.pixelContent == 1 ? this.getMask() : this.getLinkedPlacedItem(doc).d;
    maskOrFilterMask.channel = pixCache.channelBackup;
    maskOrFilterMask.rect = pixCache.rectBackup;
    if (this.pixelContent == 1) {
      maskOrFilterMask.maskCombineDirty = true;
      this.invalidate(doc)
    }
    if (this.pixelContent == 3) this.markDirty()
  }
  this.pixCache = savedPixCache
  }

  checkPixelCache(doc, selection) {
  if (this.pixelContent <= 0 && selection.rect.equals(this.rect)) {
    var layerAlpha = allocBuffer(this.rect.area());
    extractChannelByte(this.buffer, layerAlpha, 3);
    if (equals(doc.selectionMask.channel, layerAlpha)) {
      var layerRect = this.rect,
        layerBuffer = this.buffer;
      this.pixCache = {
        pixelContent: this.pixelContent,
        selectionPixels: layerBuffer.slice(0),
        selectionRect: layerRect.clone(),
        layerBufferBackup: allocBuffer(0),
        layerRect: new Rect,
        channelBackup: allocBuffer(0),
        rectBackup: new Rect
      };
      return true
    }
  }
  var pixCache = this.pixCache;
  if (pixCache == null) return false;
  if (pixCache.pixelContent != this.pixelContent) return false;
  if (!selection.rect.equals(pixCache.selectionRect)) return false;
  var unionRect = pixCache.layerRect.union(pixCache.selectionRect);
  if (pixCache.pixelContent <= 0) {
    if (!unionRect.equals(this.rect)) return false;
    var cachedAlpha = allocBuffer(pixCache.selectionPixels.length >> 2);
    extractChannelByte(pixCache.selectionPixels, cachedAlpha, 3);
    if (!equals(selection.channel, cachedAlpha)) return false;
    var compositeBuffer = allocBuffer(unionRect.width * unionRect.height * 4);
    copyPixels(pixCache.layerBufferBackup, pixCache.layerRect, compositeBuffer, unionRect);
    composite("norm", pixCache.selectionPixels, pixCache.selectionRect, compositeBuffer, unionRect, unionRect, 1);
    return equals(compositeBuffer, this.buffer);
  }
  if (pixCache.pixelContent == 1 || pixCache.pixelContent == 3) {
    var maskOrFilterMask = pixCache.pixelContent == 1 ? this.getMask() : this.getLinkedPlacedItem(doc).d;
    if (!unionRect.equals(maskOrFilterMask.rect)) return false;
    var recomposedChannel = allocBuffer(unionRect.area());
    recomposedChannel.fill(maskOrFilterMask.color);
    copyChannel(pixCache.layerBufferBackup, pixCache.layerRect, recomposedChannel, unionRect);
    compositeDissolvedDitheredClipped(pixCache.selectionPixels, pixCache.selectionRect, recomposedChannel, unionRect, selection.channel, unionRect, 1);
    return equals(recomposedChannel, maskOrFilterMask.channel);
  }
  }

  syncSelectionOverlay(doc, deltaX, deltaY, selection) {
  var pixCache = this.pixCache;
  pixCache.selectionRect.offset(deltaX, deltaY);
  var unionRect = pixCache.layerRect.union(pixCache.selectionRect);
  if (pixCache.pixelContent <= 0) {
    var compositeBuffer = allocBuffer(unionRect.area() * 4);
    copyPixels(pixCache.layerBufferBackup, pixCache.layerRect, compositeBuffer, unionRect);
    composite("norm", pixCache.selectionPixels, pixCache.selectionRect, compositeBuffer, unionRect, unionRect, 1);
    this.buffer = compositeBuffer;
    this.rect = unionRect;
    this.markDirty()
  } else {
    var maskOrFilterMask = this.pixelContent == 1 ? this.getMask() : this.getLinkedPlacedItem(doc).d,
      channelBuffer = allocBuffer(unionRect.area());
    channelBuffer.fill(maskOrFilterMask.color);
    copyChannel(pixCache.layerBufferBackup, pixCache.layerRect, channelBuffer, unionRect);
    compositeDissolvedDitheredClipped(pixCache.selectionPixels, pixCache.selectionRect, channelBuffer, unionRect, selection.channel, unionRect, 1);
    maskOrFilterMask.channel = channelBuffer;
    maskOrFilterMask.rect = unionRect.clone();
    if (this.pixelContent == 1) {
      maskOrFilterMask.maskCombineDirty = true;
      this.invalidate(doc)
    }
    if (this.pixelContent == 3) this.markDirty()
  }
  }

  getChannelIds() {
  var items = [-1, 0, 1, 2];
  if (this.d) items.push(-2);
  if (this.warpData) items.push(-3);
  return items;
  }

  getName() {
  return this.add.luni ? this.add.luni : this.name
  }

  setName(newName) {
  this.add.luni = this.name = newName
  }

  syncTextName() {
  var lnsr = this.add.lnsr,
    TySh = this.add.TySh;
  if (lnsr == "rend" && TySh) this.setName(TextEngineData.getLayerText(TySh.engineData).replace(/(?:\r\n|\r|\n)/g, " ").slice(0, 32))
  }

  isVisible() {
  return (this.layerFlags & 1 << 1) == 0;
  }

  hasPixelData() {
  return (this.layerFlags & 1 << 4) == 0;
  }

  isEffectsExpanded() {
  return (this.layerFlags & 1 << 5) != 0;
  }

  convertToBackground() {
  var layer = this;
  if (layer.add.lnsr != "bgnd") {
    layer.add.lnsr = "bgnd";
    layer.setName("Background");
    layer.add.lspf = 1 << 2
  }
  }

  convertFromBackground() {
  var layer = this;
  if (layer.add.lnsr == "bgnd") {
    delete layer.add.lnsr;
    layer.setName("Layer 0");
    layer.add.lspf = 0
  }
  }

  isLockBitSet(lockBitIndex) {
  var lspf = this.add.lspf;
  return lspf == null ? false : (lspf >> lockBitIndex & 1) != 0;
  }

  setVisible(visible) {
  if (visible && !this.isVisible()) this.layerFlags -= 2;
  if (!visible && this.isVisible()) this.layerFlags += 2
  }

  hasLayerEffects() {
  var lmfx = this.add.lmfx;
  if (lmfx == null) return false;
  for (var key in lmfx) {
    if (key == "masterFXSwitch") continue;
    if (key == "Scl") continue;
    if (key == "classID") continue;
    if (lmfx[key].v.length > 0) return true
  }
  return false
  }

  hasSmartFilters() {
  return this.add.placedData != null && this.add.placedData.filterFX != null;
  }

  hasEnabledEffects() {
  var lmfx = this.add.lmfx;
  if (lmfx == null) return false;
  if (!lmfx.masterFXSwitch.v) return false;
  for (var key in lmfx) {
    if (key == "masterFXSwitch") continue;
    if (key == "Scl") continue;
    if (key == "classID") continue;
    var length = lmfx[key].v;
    for (var cursor = 0; cursor < length.length; cursor++)
      if (length[cursor].v.enab.v) return true
  }
  return false
  }

  getTransformBounds(doc, useSelectedComponents, includeDisabledChannels, wasPuppetWarpActive) {
  var bounds = new Rect,
    channelIds = this.getTransformableChannels(doc, includeDisabledChannels, wasPuppetWarpActive);
  if (channelIds.indexOf(0) != -1) bounds = bounds.union(this.rect);
  if (channelIds.indexOf(1) != -1) bounds = bounds.union(this.getMask().getSelectionRect());
  if (channelIds.indexOf(2) != -1) {
    var vectorMask = this.add.vmsk,
      pathBounds;
    if (useSelectedComponents) {
      if (vectorMask.selectedComponents.length > 1) {
        var flattenedCoords = flattenPathKnotCoords(vectorMask.pathRecords, null, vectorMask.selectedComponents);
        pathBounds = boundsFromCoordPairs(flattenedCoords)
      } else pathBounds = boundsOfPathRecords(vectorMask.pathRecords, vectorMask.C.length != 0 ? vectorMask.C : null)
    } else pathBounds = boundsOfPathRecords(vectorMask.pathRecords);
    bounds = bounds.union(pathBounds)
  }
  if (channelIds.indexOf(3) != -1) bounds = bounds.union(this.getLinkedPlacedItem(doc).d.getSelectionRect());
  if (channelIds.length == 0 && this.hasFillContent()) bounds = new Rect(0, 0, doc.width, doc.height);
  return bounds
  }

  getArtboardBgColor() {
  var artb = this.add.artb,
    backgroundType = artb.artboardBackgroundType.v,
    packedColor = 0;
  if (backgroundType == 1) packedColor = 4294967295;
  else if (backgroundType == 2) packedColor = 4278190080;
  else if (backgroundType == 3) packedColor = 0;
  else if (backgroundType == 4) {
    packedColor = artb.Clr.v;
    packedColor = 255 << 24 | packedColor.Bl.v << 16 | packedColor.Grn.v << 8 | packedColor.Rd.v
  } else throw backgroundType;
  return packedColor;
  }

  getArtboardRect() {
  var Btom = this.add.artb.artboardRect.v,
    bottom = Btom.Btom.v,
    left = Btom.Left.v,
    right = Btom.Rght.v,
    top = Btom.Top.v;
  return new Rect(left, top, right - left, bottom - top);
  }

  setArtboardRect(rect) {
  var rectToArtboardDescriptor = Layer.rectToArtboardDescriptor(rect);
  if (this.add.artb == null) this.add.artb = {
    classID: "artboard",
    artboardRect: {
      t: "Objc",
      v: null
    },
    artboardBackgroundType: {
      t: "long",
      v: 1
    }
  };
  this.add.artb.artboardRect.v = rectToArtboardDescriptor
  }

  getTransformableChannels(doc, includeDisabledChannels, wasPuppetWarpActive) {
  var channelIds = [],
    layer = this,
    pathLayerActive = this.pathLayerActive;
  if (!includeDisabledChannels && layer.pathLayerActive && wasPuppetWarpActive) {
    channelIds.push(2)
  } else if (layer.pixelContent <= 0 || includeDisabledChannels) {
    if (layer.hasPixelData())
      if (!this.rect.isEmpty()) channelIds.push(0);
    if (layer.getMask() && !layer.getMask().rect.isEmpty())
      if (layer.getMask().enabled || includeDisabledChannels) channelIds.push(1);
    if (layer.add.vmsk)
      if (layer.add.vmsk.enabled || includeDisabledChannels) channelIds.push(2);
    if (layer.hasSmartFilters() && layer.getLinkedPlacedItem(doc).d && !layer.getLinkedPlacedItem(doc).d.rect.isEmpty()) channelIds.push(3)
  } else if (layer.pixelContent == 1) {
    channelIds.push(1);
    if (layer.getMask().enabled && !layer.getMask().rect.isEmpty()) {
      if (layer.hasPixelData())
        if (!this.rect.isEmpty()) channelIds.push(0);
      if (layer.add.vmsk)
        if (layer.add.vmsk.enabled) channelIds.push(2)
    }
  } else if (layer.pixelContent == 3 && !layer.getLinkedPlacedItem(doc).d.rect.isEmpty()) channelIds.push(3);
  if (layer.add.artb && channelIds.indexOf(0) == -1) channelIds.push(0);
  channelIds.sort();
  return channelIds
  }

  getMask() {
  return this.warpData ? this.warpData : this.add.vmsk && this.add.vmsk.isEnabled ? null : this.d;
  }

  getLinkedPlacedItem(doc) {
  var placedId = this.add.placedData.placed.v,
    FEid = doc.add.FEid;
  if (FEid == null) return null;
  for (var cursor = 0; cursor < FEid.length; cursor++)
    if (FEid[cursor].id == placedId) return FEid[cursor];
  return null
  }

  extend(boundsRect) {
  extendRgbaBuffer(this, boundsRect)
  }

  expandRectForEffects(boundsRect, doc, includeEffects) {
  var expandedRect = boundsRect.clone();
  if (this.hasEnabledEffects()) {
    var layerEffects = this.add.lmfx,
      parentSection = doc.root.getSectionByIndex(doc.layers.indexOf(this)),
      gradientFills = layerEffects.gradientFillMulti.v,
      hasAlignedGradient = false;
    for (var fillIdx = 0; fillIdx < gradientFills.length; fillIdx++)
      if (gradientFills[fillIdx].v.enab.v && gradientFills[fillIdx].v.Algn.v) hasAlignedGradient = true;
    if (hasAlignedGradient) expandedRect = expandedRect.union(parentSection.getSelectionRect(doc, false));
    var effectsPadding = LayerStyleRenderer.buildLayerFillFromEffects(this, doc, includeEffects);
    expandedRect.offset(effectsPadding.x, effectsPadding.y);
    expandedRect.width += effectsPadding.width;
    expandedRect.height += effectsPadding.height
  }
  return expandedRect
  }

  trimToContent() {
  if (this.hasPixelData()) trimRgbaToContent(this);
  var getMask = this.getMask();
  if (getMask) getMask.trimToContent()
  }

  clone() {
  var psdLayer = new Layer;
  psdLayer.rect = this.rect.clone();
  psdLayer.buffer = this.buffer.slice(0);
  psdLayer.blendMode = this.blendMode;
  psdLayer.Opct = this.Opct;
  psdLayer.isClippingMask = this.isClippingMask;
  psdLayer.layerFlags = this.layerFlags;
  psdLayer.name = this.name;
  psdLayer.blendIfData = this.blendIfData.slice(0);
  if (this.d) psdLayer.d = this.d.clone();
  if (this.warpData) psdLayer.warpData = this.warpData.clone();
  for (var key in this.add) psdLayer.add[key] = cloneLayerAdditionalValue(key, this.add[key]);
  return psdLayer;
  }

  rasterize(doc) {
  var layer = this;
  if (layer.add.TySh) delete layer.add.TySh;
  if (layer.add.placedData) {
    var applyFilterMask = this.applyFilterMask(doc, this.buffer, this.rect);
    if (applyFilterMask) {
      this.buffer = applyFilterMask.buffer;
      this.rect = applyFilterMask.rect;
      this.markDirty()
    }
    delete layer.add.placedData
  }
  if (layer.add.SoCo || layer.add.GdFl || layer.add.PtFl) {
    if (layer.add.vogk) delete layer.add.vogk;
    if (layer.add.SoCo) delete layer.add.SoCo;
    if (layer.add.GdFl) delete layer.add.GdFl;
    if (layer.add.PtFl) delete layer.add.PtFl;
    if (layer.add.vmsk) {
      delete layer.add.vmsk;
      if (layer.warpData == null && layer.d) delete layer.d;
      else if (layer.warpData != null && layer.d != null) {
        layer.d = layer.warpData;
        delete layer.warpData
      }
    }
  }
  if (!layer.isGroup() && adjustmentKeyOf(layer.add) == null && !this.hasPixelData()) this.layerFlags -= 16
  }

  getMaskSettings(maskType) {
  var density = 255,
    feather = 0;
  if (maskType == 2) {
    var filterFx = this.add.placedData.filterFX.v;
    if (filterFx.filterMaskDensity) density = filterFx.filterMaskDensity.v;
    if (filterFx.filterMaskFeather) feather = filterFx.filterMaskFeather.v
  } else {
    var maskOrVectorMask = maskType == 0 ? this.getMask() : this.add.vmsk;
    density = maskOrVectorMask.density;
    feather = maskOrVectorMask.feather
  }
  return {
    maskType: maskType,
    density: density,
    feather: feather
  }
  }

  applyMaskSettings(settings) {
  var maskType = settings.maskType;
  var density = settings.density;
  var feather = settings.feather;
  if (maskType == 2) {
    var filterFx = this.add.placedData.filterFX.v;
    if (density == 255) delete filterFx.filterMaskDensity;
    else filterFx.filterMaskDensity = {
      t: "long",
      v: density
    };
    if (feather == 0) delete filterFx.filterMaskFeather;
    else filterFx.filterMaskFeather = {
      t: "doub",
      v: feather
    };
    this.markDirty()
  } else {
    var maskOrVectorMask = maskType == 0 ? this.getMask() : this.add.vmsk;
    maskOrVectorMask.density = density;
    maskOrVectorMask.feather = feather;
    maskOrVectorMask.maskCombineDirty = true
  }
  }

  updateVectorOrigins() {
  var layer = this,
    vmsk = layer.add.vmsk;
  if (vmsk == null) return;
  layer.add.vogk = createForSubpaths(vmsk.pathRecords)
  }

}

Layer.RenderCache = RenderCache;
installLazyScratchCanvasGetters(Layer.prototype);

// Undo/dispatch action-kind tokens. Each token's value is its own name
// (`Layer.setBlendMode === "setBlendMode"`), so history data reads as the action.
// Producers stamp `actionKind: Layer.<name>`; trackers dispatch on `event.actionKind`.
const LAYER_ACTION_NAMES = [
  "duplicateLayer", "deleteLayer", "linkLayers", "createSmartObject",
  "updateLinkedItem", "setSmartObjectStackMode", "replaceSmartObjectRaster",
  "placeSmartObject", "duplicateSmartObject", "rasterizeLayers", "rasterizeLayerStyle",
  "explodeLayerStyles", "mergeDown", "mergeCopy", "mergeLayers", "flattenImage",
  "timelineFrames", "toggleRasterMask", "toggleVectorMask", "toggleFilterMask",
  "deleteRasterMask", "copyRasterMask", "applyClipboardLayer", "deleteVectorMask",
  "moveVectorMask", "addRasterMask", "addVectorMask", "toggleRasterMaskEnabled",
  "toggleVectorMaskEnabled", "routeMaskFromSelection", "transformKeyOrigins",
  "extraChannelOp", "editArtboard", "setBlendMode", "setLayerOpacity",
  "toggleLayerLocks", "setFillOpacity", "setLayerType", "toggleVisibility",
  "selectChannelEdit", "selectLayer", "toggleGroupExpanded", "toggleEffectsExpanded",
  "toggleLayerEffectsMaster", "toggleLayerEffectVariant", "pasteLayers",
  "toggleClippingMask", "newLayer", "newFolder", "newAdjustmentLayer",
  "newLayerFromClipboard", "moveLayer", "copyLayerStyle", "groupOrUngroup",
  "moveSelection", "moveLayerRelative", "renameLayer", "renameDocument",
  "updateMetadata", "replaceLayerStack", "setLayerLabelColor", "convertTextToShape",
  "autoBlendLayers", "toggleSmartFiltersMaster", "toggleSmartFilterVariant",
  "addFilterMask", "deleteFilterMask", "clearSmartFilters", "moveSmartFilter",
  "deleteSmartFilter", "restoreFilterFxStack", "mutatePlacedDataLocks",
  "updateContentStyle", "newShapeLayer", "newLayerViaCopy", "newLayerViaCut",
  "maskDensityFeather",
  "splitOpenVectorPaths",
];
const LayerAction = Object.freeze(Object.fromEntries(LAYER_ACTION_NAMES.map((name) => [name, name])));
for (const actionKey in LayerAction) Layer[actionKey] = LayerAction[actionKey];
export { LayerAction, LayerSectionType };

/**
 * The fill a vector layer is currently painted with: a solid colour, gradient
 * or pattern descriptor, or kind 0 when the shape's fill is switched off.
 * Transforming or restyling a shape carries this across so the fill survives.
 */
export function getVectorStrokeStyleSnapshot(doc, layerIndex) {
  var layer = doc.layers[layerIndex],
    vectorStroke = layer.add.vstk,
    fillSnapshot = null;
  if (vectorStroke && !vectorStroke.fillEnabled.v) fillSnapshot = {
    fillKind: 0
  };
  else if (layer.add.SoCo) fillSnapshot = {
    fillKind: 1,
    fillDescriptor: layer.add.SoCo
  };
  else if (layer.add.GdFl) fillSnapshot = {
    fillKind: 2,
    fillDescriptor: layer.add.GdFl
  };
  else if (layer.add.PtFl) fillSnapshot = {
    fillKind: 3,
    fillDescriptor: layer.add.PtFl
  };
  return fillSnapshot
}

/** Paint a vector layer with a fill snapshot, replacing whatever it carried. */
export function applyVectorStrokeStyleSnapshot(layer, fillSnapshot) {
  var vectorMask = layer.add.vmsk,
    vectorStroke = layer.add.vstk,
    fillKind = fillSnapshot.fillKind;
  if (vectorStroke) vectorStroke.fillEnabled.v = fillKind != 0;
  if (fillKind > 0) {
    var fillKey = ["SoCo", "GdFl", "PtFl"][fillKind - 1];
    for (var kindIdx = 0; kindIdx < 3; kindIdx++) delete layer.add[["SoCo", "GdFl", "PtFl"][kindIdx]];
    layer.add[fillKey] = fillSnapshot.fillDescriptor
  }
}
