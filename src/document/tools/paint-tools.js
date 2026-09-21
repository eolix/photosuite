/**
 * Paint-family tools: brush, pencil, eraser, gradient, paint bucket, dodge/burn,
 * sponge, and color replacement. Share `PaintTool` stroke rasterization and
 * brush dynamics; chained before the selection and retouch tools that extend PaintTool.
 */

import { Point, constrainEndpointToAxis } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { KeyboardHandler, mergeOpacityDigitPercent } from "../../core/keyboard-handler.js";

import { Matrix2D } from "../../core/math/matrix2d.js";
import { AxisDragAnchor } from "../model/axis-drag-anchor.js";
import { BlendModes } from "../model/blend-modes.js";
import { HueSaturationParser } from "../formats/psd/adjustment-parsers.js";
import { LayerStyleRenderer } from "../../features/layer-styles/style-renderer.js";
import { HistoryEntry } from "../model/document.js";
import { BrushStroke } from "../../features/brush/brush-stroke.js";
import { FilterDefs } from "../../features/filters/filter-registry.js";
import { AdjustmentEngine } from "../../features/adjustments/adjustment-engine.js";
import { LayerEffectDefs } from "../formats/psd/effect-defs.js";
import { PopupTypes } from "../../ui/config/popup-types.js";
import { BrushPresetUtil } from "../../features/brush/brush-presets.js";
import { TrackerRegistry } from "../../features/trackers/tracker-registry.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { getDevicePixelRatio, makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { transformPixels } from "../render/raster-transform.js";
import { ToolBase, ToolId } from "../model/tool-base.js";
import { snapPointToGuides } from "../model/guide-snapping.js";
import { growOrShrinkSelection } from "./selection-actions.js";
import { floodSelectMask, readSampleColors, sampleSelectionAtPoint } from "./flood-select.js";
import { quickSelectSession, recomputeQuickSelectSelection } from "./quick-select-session.js";
import { allocBuffer, copyBuffer, extractChannel, extractChannelByte, fillBuffer, rgbaToGrayChannel } from "../../engine/compositing/buffer-utils.js";
import { blitChannelToBuffer, copyChannel, copyPixels, getWhiteBuffer, getZeroBuffer, multiplyAlphaByMask, multiplyBuffers, round, scaleBuffer, scaleRgbaAlphaByMask } from "../../engine/compositing/pixel-ops.js";
import { drawCheckerboard, invert, luminanceFromRgb } from "../../engine/compositing/color-math.js";
import { composite, compositeDissolvedDitheredClipped, compositeLayer } from "../../engine/compositing/compositing-ops.js";
import { applyGradient, psdColorToRgb, toRGBDesc } from "../../engine/compositing/psd-color-utils.js";
import { union } from "../../engine/compositing/selection-utils.js";
import { runHealingBrushFill } from "../../engine/compositing/healing-brush.js";
import { solvePoissonFill } from "../../engine/compositing/content-aware-fill.js";



function createDefaultPaintToolOptions(labelKey) {
  return {
    brush: labelKey ? BrushPresetUtil.getDefaultBrushDescriptor() : null,
    bmode: "norm",
    Opct: 1,
    flow: 1,
    smth: 0,
    samp: 0,
    prsr: [false, true],
    emode: 0,
    wconf: [40, true, true],
    algnd: false,
    sfrom: 0,
    alt: [false],
    expo: 0.5,
    rng: 1,
    strn: 0.5,
    pdetail: true,
    smode: 1,
    qsmode: 0,
    setop: "front",
    patch: 0,
  };
}

function createDefaultGradientToolOptions() {
  return {
    gradientPreset: LayerEffectDefs.descriptorTemplates.foregroundBackgroundGradient.v,
    gradientStyle: "Lnr",
    reverseGradient: false,
    ditherGradient: false,
    gradientBlendMode: "norm",
    opacity: 1,
  };
}

function dispatchCursorOverlay(dispatcher, cursorOverlayId) {
  const cursorEvent = new AppEvent(EventType.uiDispatch, true);
  cursorEvent.data = {
    dispatchKind: UiCommand.splashOptionsUpdate,
    cursorOverlayId,
  };
  dispatcher.dispatch(cursorEvent);
}

function clampPointToDocRect(point, boundsRect) {
  const clampedX = Math.max(boundsRect.x, Math.min(boundsRect.x + boundsRect.width - 1, point.x));
  const clampedY = Math.max(boundsRect.y, Math.min(boundsRect.y + boundsRect.height - 1, point.y));
  return new Point(clampedX, clampedY);
}

export function PaintTool(labelKey, toolId, iconPath) {
  ToolBase.call(this, labelKey, toolId, iconPath);
  this.toolOptions = createDefaultPaintToolOptions(labelKey);
  this.appData = null;
  this.strokeData = null;
  this.lastStrokePointDoc = null;
  this.straightLineAnchorDoc = null;
  this.strokePathKnot = null;
  this.rightDragAnchor = null;
  this.brushSizeDragState = null;
  this.strokeHealBuffer = null;
  this.sourceSampleRect = null;
  this.sourcePixelBuffer = null;
  this.cloneSampleRect = null;
  this.cloneSamplePixels = null;
  this.selectionBeforeStroke = null;
  this.viewScaleAtStroke = 1;
  this.usePenPressure = false;
  this.strokeCompositeMode = null;
  this.caller = null
};


function installPaintToolPrototype() {

PaintTool.prototype.wantsInput = function(pointerState, keyboard) {
  return pointerState.isDown && keyboard.isPressed(KeyboardHandler.Shift);
};
PaintTool.prototype.onRightMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (keyboard.isPressed(KeyboardHandler.Alt)) {
    this.rightDragAnchor = new Point(pointerState.x, pointerState.y);
    var brushShape = this.toolOptions.brush.Brsh.v,
      brushDiameter = brushShape.diameter.v.val,
      brushHardness = brushShape.Hrdn != null ? brushShape.Hrdn.v.val : -1;
    this.brushSizeDragState = [brushDiameter, brushHardness, true, JSON.parse(JSON.stringify(this.toolOptions.brush)), pointerState];
    this.updateCursor(appData)
  }
};
PaintTool.prototype.updateBrushSizeFromRightDrag = function(doc, appData, pointerState) {
  var dragState = this.brushSizeDragState,
    viewScale = doc.pathViewport.zoomScale,
    deltaX = pointerState.x - dragState[4].x,
    deltaY = pointerState.y - dragState[4].y,
    diameter = dragState[0],
    hardness = dragState[1],
    draggingDiameter = Math.abs(deltaX) > Math.abs(deltaY);
  if (draggingDiameter && dragState[2]) {
    var delta = Math.round(2 * deltaX / viewScale);
    diameter += delta;
    pointerState.x -= deltaX - .5 * delta * viewScale
  }
  if (!draggingDiameter && !dragState[2] && hardness != -1) {
    var delta = Math.round(.25 * deltaY);
    hardness += delta;
    pointerState.y -= deltaY - 4 * delta
  }
  diameter = Math.max(1, diameter);
  hardness = dragState[1] == -1 ? -1 : Math.max(0, Math.min(100, hardness));
  var brushClone = dragState[3];
  brushClone.Brsh.v.diameter.v.val = diameter;
  if (hardness != -1) brushClone.Brsh.v.Hrdn.v.val = hardness;
  this.brushSizeDragState = [diameter, hardness, draggingDiameter, brushClone, pointerState];
  var brushStamp = BrushStroke.createBrushStamp(brushClone, appData.brushPresets.samples, viewScale),
    stampBounds = brushStamp[1];
  stampBounds.x = Math.round(this.rightDragAnchor.x - stampBounds.width / 2);
  stampBounds.y = Math.round(this.rightDragAnchor.y - stampBounds.height / 2);
  doc.toolOverlayState.brushStampOverlays = [brushStamp];
  var anchorDocPoint = doc.pathViewport.screenToDocPoint(this.rightDragAnchor.x, this.rightDragAnchor.y);
  doc.toolOverlayState.measureOverlay = {
    highlightRects: [],
    guideSegments: [anchorDocPoint.x - diameter / 2, anchorDocPoint.y, anchorDocPoint.x + diameter / 2, anchorDocPoint.y]
  };
  if (hardness != -1) doc.toolOverlayState.measureOverlay.guideSegments.push(anchorDocPoint.x + 50 / viewScale, anchorDocPoint.y - hardness / 2, anchorDocPoint.x + 50 / viewScale, anchorDocPoint.y + hardness / 2);
  doc.dirty = true
};
PaintTool.prototype.onRightMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (this.id == ToolId.TOOL_PATCH) return;
  if (this.rightDragAnchor) {
    this.rightDragAnchor = null;
    this.dispatchBrushPresetPopup(JSON.parse(JSON.stringify(this.brushSizeDragState[3])));
    doc.toolOverlayState.brushStampOverlays = [];
    doc.toolOverlayState.measureOverlay = null;
    doc.dirty = true;
    return
  }
  var uiDispatchEvent = new AppEvent(EventType.uiDispatch, true);
  uiDispatchEvent.data = {
    dispatchKind: UiCommand.forwardActiveToolGesture,
    routingChannel: this.id,
    brushOptionsSubAction: "showBrushOpts",
    popupAnchorPoint: new Point(pointerState.screenX + 4, pointerState.screenY)
  };
  dispatcher.dispatch(uiDispatchEvent)
};
PaintTool.prototype.dispatchBrushPresetPopup = function(brushDescriptor) {
  var uiDispatchEvent = new AppEvent(EventType.uiDispatch, true);
  uiDispatchEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.SCRIPTS,
    brushPreset: brushDescriptor
  };
  this.caller.dispatch(uiDispatchEvent)
};
PaintTool.buildFillAction = function(fillContentKind, blendMode, opacity, colorDescriptor, preserveTransparency) {
  if (fillContentKind == null) fillContentKind = "FrgC";
  if (blendMode == null) blendMode = "norm";
  if (opacity == null) opacity = 1;
  if (preserveTransparency == null) preserveTransparency = false;
  var fillDescriptor = {
    classID: "Fl",
    Usng: {
      t: "enum",
      v: {
        FlCn: fillContentKind
      }
    },
    Opct: {
      t: "UntF",
      v: {
        type: "#Prc",
        val: Math.round(opacity * 100)
      }
    },
    PrsT: {
      t: "bool",
      v: preserveTransparency
    },
    Md: {
      t: "enum",
      v: {
        blendMode: BlendModes.toPSD(blendMode)
      }
    }
  };
  if (fillContentKind == "Clr") fillDescriptor.Clr = {
    t: "Objc",
    v: colorDescriptor
  };
  if (fillContentKind == "contentAware") fillDescriptor.contentAwareColorAdaptationFill = {
    t: "bool",
    v: true
  };
  return {
    uf: "fill",
    actionDescriptor: fillDescriptor
  }
};
PaintTool.prototype.handleInput = function(event, dispatcher, doc, keyboard, pointerState) {
  this.appDispatcher = dispatcher;
  var activeChannelCount = doc.activeChannels.length;
  if (activeChannelCount == 0 && !doc.ensureLayerEditableForTools()) return;
  var targetLayerIndex = activeChannelCount != 0 ? -1 - doc.activeChannels[0] : doc.selectedLayerIndices[0],
    targetLayer = doc.layers[targetLayerIndex];
  if (event.actionKind == "fromAction") {
    var actionPayload = event.scriptActionPayload;
    if (actionPayload.uf == "fill") this.applyScriptedFill(doc, targetLayer, actionPayload.actionDescriptor, pointerState);
    else if (actionPayload.uf == "delete") this.applyScriptedDelete(doc, targetLayerIndex, targetLayer, pointerState)
  }
  if (event.actionKind == "stroke") {
    var strokeDescriptor = event.strokeDescriptor,
      selectionMask = doc.selectionMask;
    if (selectionMask == null) {
      selectionMask = {
        rect: targetLayer.rect.clone(),
        channel: allocBuffer(targetLayer.rect.area())
      };
      extractChannelByte(targetLayer.buffer, selectionMask.channel, 3)
    }
    var strokePadding = LayerStyleRenderer.getFrameEffectStrokePadding(strokeDescriptor),
      strokeSelection = growOrShrinkSelection(selectionMask, Math.ceil(strokePadding[0]), Math.ceil(strokePadding[1])),
      strokeRgb = psdColorToRgb(strokeDescriptor.Clr.v),
      strokeRed = Math.round(strokeRgb.h),
      strokeGreen = Math.round(strokeRgb.l),
      strokeBlue = Math.round(strokeRgb.O);
    this.fillRegionWithColor(doc, targetLayer, strokeSelection, strokeRed, strokeGreen, strokeBlue, Math.round(255 * strokeDescriptor.Opct.v.val / 100), BlendModes.fromPSD(strokeDescriptor.Md.v.blendMode), "layerEffects.stroke")
  }
  if (event.actionKind == "fillBMP") {
    this.applyFillToTarget(doc, targetLayer, doc.selectionMask, event.fillPixels, event.fillBlendMode, event.historyLabelKey)
  }
  if (event.actionKind == "draw") {
    var drawPayload = event.clipboardPixelPayload,
      drawRect = drawPayload.rect;
    this.capturePaintSourceBuffers(doc);
    var activeLayer = doc.layers[doc.selectedLayerIndices[0]];
    if (event.clearSelectionAfter && activeLayer && activeLayer.pixelContent <= 0 && doc.activeChannels.length == 0) {
      drawRect = TrackerRegistry.LayerEffectsTracker.getLayerBoundsForMask(drawPayload, doc);
      activeLayer.buffer = drawPayload.buffer.slice(0);
      activeLayer.rect = drawRect.clone()
    } else {
      var savedBlendMode = this.toolOptions.bmode;
      this.toolOptions.bmode = "norm";
      this.compositeStrokeToLayer(doc, "draw", drawPayload.buffer, drawRect, drawRect.intersect(new Rect(0, 0, doc.width, doc.height)));
      this.toolOptions.bmode = savedBlendMode
    }
    this.invalidatePaintDirtyRegion(doc, drawRect);
    doc.stateChanged = true;
    this.finish(doc, drawRect, event.historyLabelKey, event.clearSelectionAfter)
  }
};
/** Scripted Edit > Fill: solid color, content-aware heal, with optional transparency lock. */
PaintTool.prototype.applyScriptedFill = function(doc, targetLayer, fillDescriptor, pointerState) {
  var preserveTransparency = fillDescriptor.PrsT ? fillDescriptor.PrsT.v : false,
    originalLspf = targetLayer.add.lspf,
    fillColorInt;
  if (preserveTransparency) {
    targetLayer.add.lspf = originalLspf == null ? 1 : originalLspf | 1
  }
  var fillOpacity = (fillDescriptor.Opct ? fillDescriptor.Opct.v.val : 100) / 100,
    fillBlendMode = fillDescriptor.Md ? BlendModes.fromPSD(fillDescriptor.Md.v.blendMode) : "norm",
    fillContentKind = fillDescriptor.Usng.v.FlCn;
  if (fillContentKind == "contentAware") {
    if (doc.selectionMask == null) {
      alert("Select an area to heal first.");
      return
    }
    if (!doc.ensureLayerEditableForTools()) return;
    this.capturePaintSourceBuffers(doc);
    this.bindSourceBuffersForStroke(doc, 0);
    var selectionMask = doc.selectionMask,
      healChannelBuffer = allocBuffer(selectionMask.rect.area() * 4);
    extractChannel(selectionMask.channel, healChannelBuffer, 3);
    this.compositeStrokeToLayer(doc, "sheal", healChannelBuffer, selectionMask.rect, selectionMask.rect);
    this.invalidatePaintDirtyRegion(doc, selectionMask.rect);
    this.finish(doc, selectionMask.rect)
  } else {
    if (fillContentKind == "FrgC") fillColorInt = pointerState.colorInt;
    else if (fillContentKind == "BckC") fillColorInt = pointerState.bgColor;
    else if (fillContentKind == "Blck") fillColorInt = 0;
    else if (fillContentKind == "Wht") fillColorInt = 16777215;
    else if (fillContentKind == "Gry") fillColorInt = 8421504;
    else if (fillContentKind == "Clr") {
      var psdRgb = psdColorToRgb(fillDescriptor.Clr.v);
      fillColorInt = psdRgb.h << 16 | psdRgb.l << 8 | psdRgb.O
    }
    var fillRed = fillColorInt >> 16 & 255,
      fillGreen = fillColorInt >> 8 & 255,
      fillBlue = fillColorInt >> 0 & 255;
    this.fillRegionWithColor(doc, targetLayer, doc.selectionMask, fillRed, fillGreen, fillBlue, Math.round(255 * fillOpacity), fillBlendMode, "edit.fill")
  }
  if (preserveTransparency) {
    targetLayer.add.lspf = originalLspf == null ? 0 : originalLspf
  }
};
/** Scripted Edit > Clear: erase the selected region of pixels, mask, or channel. */
PaintTool.prototype.applyScriptedDelete = function(doc, targetLayerIndex, targetLayer, pointerState) {
  var pixelContentKind = targetLayerIndex < 0 ? 1 : targetLayer.pixelContent,
    selectionMask = doc.selectionMask,
    clearBuffer;
  if (selectionMask == null) return;
  var maskOrSmartFilter = this.resolvePaintTarget(doc).maskTarget,
    sourceRect = pixelContentKind <= 0 ? targetLayer.rect : maskOrSmartFilter.rect,
    clearRect = pixelContentKind <= 0 ? selectionMask.rect.intersect(sourceRect) : selectionMask.rect.clone();
  if (clearRect.isEmpty()) return;
  var clearPixelCount = clearRect.area();
  if (pixelContentKind <= 0) {
    clearBuffer = allocBuffer(clearPixelCount * 4);
    copyPixels(targetLayer.buffer, targetLayer.rect, clearBuffer, clearRect)
  } else {
    clearBuffer = allocBuffer(clearPixelCount);
    maskOrSmartFilter.extend(clearRect);
    copyChannel(maskOrSmartFilter.channel, maskOrSmartFilter.rect, clearBuffer, clearRect)
  }
  if (0 <= targetLayerIndex && targetLayer.checkPixelCache(doc, selectionMask)) {
    if (pixelContentKind <= 0) {
      fillBuffer(clearBuffer, 0);
      copyPixels(targetLayer.pixCache.layerBufferBackup, targetLayer.pixCache.layerRect, clearBuffer, clearRect)
    } else {
      clearBuffer.fill(255);
      copyChannel(targetLayer.pixCache.layerBufferBackup, targetLayer.pixCache.layerRect, clearBuffer, clearRect)
    }
  } else {
    if (pixelContentKind <= 0) {
      var alphaChannelBuffer = allocBuffer(clearBuffer.length >> 2);
      extractChannelByte(clearBuffer, alphaChannelBuffer, 3);
      compositeDissolvedDitheredClipped(getZeroBuffer(selectionMask.rect.area()), selectionMask.rect, alphaChannelBuffer, clearRect, selectionMask.channel, clearRect, 1);
      extractChannel(alphaChannelBuffer, clearBuffer, 3)
    } else {
      var backgroundLuminanceBuffer = allocBuffer(selectionMask.rect.area()),
        bgRed = pointerState.bgColor >>> 16 & 255,
        bgGreen = pointerState.bgColor >> 8 & 255,
        bgBlue = pointerState.bgColor >> 0 & 255;
      backgroundLuminanceBuffer.fill(Math.round(luminanceFromRgb(bgRed, bgGreen, bgBlue)));
      compositeDissolvedDitheredClipped(backgroundLuminanceBuffer, selectionMask.rect, clearBuffer, clearRect, selectionMask.channel, clearRect, 1)
    }
  }
  this.pushPaintHistory(doc, true, "edit.clear", targetLayerIndex, pixelContentKind, clearRect, clearBuffer)
};
PaintTool.prototype.fillRegionWithColor = function(doc, layer, selectionMask, red, green, blue, alpha, blendMode, historyLabelKey) {
  var fillRect = selectionMask == null ? new Rect(0, 0, doc.width, doc.height) : selectionMask.rect,
    packedRgba = alpha << 24 | blue << 16 | green << 8 | red << 0,
    fillRgba = allocBuffer(fillRect.area() * 4);
  fillBuffer(fillRgba, packedRgba);
  this.applyFillToTarget(doc, layer, selectionMask, fillRgba, blendMode, historyLabelKey)
};
PaintTool.prototype.applyFillToTarget = function(doc, layer, selectionMask, fillRgba, blendMode, historyLabelKey) {
  var paintTarget = this.resolvePaintTarget(doc),
    layerIndex = paintTarget.layerIndex,
    pixelContentKind = paintTarget.pixelContentKind,
    maskOrSmartFilter = paintTarget.maskTarget,
    targetRect = selectionMask == null ? new Rect(0, 0, doc.width, doc.height) : selectionMask.rect,
    selectionChannel = selectionMask == null ? getWhiteBuffer(doc.width * doc.height) : selectionMask.channel,
    pixelCount = targetRect.area(),
    destBuffer, grayMask = null;
  if (pixelContentKind <= 0) {
    destBuffer = allocBuffer(pixelCount * 4);
    copyPixels(layer.buffer, layer.rect, destBuffer, targetRect)
  } else {
    destBuffer = allocBuffer(pixelCount);
    maskOrSmartFilter.extend(targetRect);
    copyChannel(maskOrSmartFilter.channel, maskOrSmartFilter.rect, destBuffer, targetRect)
  }
  if (selectionMask != null) multiplyAlphaByMask(selectionChannel, fillRgba);
  if (pixelContentKind > 0) {
    grayMask = allocBuffer(pixelCount);
    rgbaToGrayChannel(fillRgba, grayMask)
  }
  if (0 <= layerIndex && selectionMask && layer.checkPixelCache(doc, selectionMask)) {
    var pixCacheBefore = layer.pixCache.selectionPixels,
      pixCacheAfter = layer.pixCache.selectionPixels.slice(0);
    if (pixelContentKind <= 0) copyBuffer(fillRgba, pixCacheAfter);
    else copyBuffer(grayMask, pixCacheAfter);
    var tempHistoryEntry = new HistoryEntry("edit.fill", this);
    tempHistoryEntry.data = {
      actionKind: "drawtemp",
      layerIndex: doc.selectedLayerIndices[0],
      pixelContentKind: pixelContentKind,
      pixCacheBefore: pixCacheBefore,
      pixCacheAfter: pixCacheAfter
    };
    doc.pushHistory(tempHistoryEntry);
    this.redo(tempHistoryEntry.data, doc)
  } else {
    if (pixelContentKind <= 0) {
      var transparencyLockBuffer;
      if (layer.isLockBitSet(0)) {
        transparencyLockBuffer = allocBuffer(targetRect.area());
        extractChannelByte(destBuffer, transparencyLockBuffer, 3)
      }
      composite(blendMode, fillRgba, targetRect, destBuffer, targetRect, targetRect, 1);
      if (layer.isLockBitSet(0)) extractChannel(transparencyLockBuffer, destBuffer, 3)
    } else compositeDissolvedDitheredClipped(grayMask, targetRect, destBuffer, targetRect, selectionChannel, targetRect, 1);
    this.pushPaintHistory(doc, true, historyLabelKey, layerIndex, pixelContentKind, targetRect, destBuffer)
  }
};
PaintTool.prototype.isModifierKey = function(keyCode) {
  if (KeyboardHandler.DIGIT_KEYS.indexOf(keyCode) != -1) return true;
  return false
};
PaintTool.prototype.onKeyEvent = function(doc, dispatcher, appData, keyboard) {
  var brushDescriptor = this.toolOptions.brush,
    altPressed = keyboard.isPressed(KeyboardHandler.Alt),
    altPressureChanged = altPressed != this.usePenPressure,
    adjustedBrushDescriptor = PaintTool.adjustBrushSizeFromKeys(brushDescriptor, keyboard);
  if (adjustedBrushDescriptor != null) this.dispatchBrushPresetPopup(adjustedBrushDescriptor);
  if (!keyboard.isPressed(KeyboardHandler.Ctrl) && keyboard.getActiveDigit() != -1) {
    var mergedOpacity = mergeOpacityDigitPercent(Math.round(this.toolOptions.Opct * 100), keyboard.getActiveDigit()) / 100;
    this.dispatchToolOptionUpdate({
      Opct: mergedOpacity
    }, dispatcher)
  }
  if (this.id == ToolId.TOOL_QUICK_SELECT && altPressureChanged && doc != null) {
    var quickSelectMode = this.toolOptions.qsmode;
    if (quickSelectMode == 2) quickSelectMode = doc.selectionMask == null ? 0 : 1;
    else quickSelectMode = 2;
    this.dispatchToolOptionUpdate({
      qsmode: quickSelectMode
    }, dispatcher)
  }
  this.usePenPressure = altPressed;
  if (altPressureChanged) {
    if (doc) this.viewScaleAtStroke = doc.pathViewport.zoomScale;
    this.updateCursor(appData, keyboard)
  }
};
PaintTool.adjustBrushSizeFromKeys = function(brushDescriptor, keyboard) {
  var diameter = brushDescriptor.Brsh.v.diameter.v.val,
    hardness = brushDescriptor.Brsh.v.Hrdn != null ? brushDescriptor.Brsh.v.Hrdn.v.val : -1,
    originalDiameter = diameter,
    originalHardness = hardness,
    shiftPressed = keyboard.isPressed(KeyboardHandler.Shift);
  if (keyboard.isPressed(KeyboardHandler.BracketLeft)) {
    if (shiftPressed) hardness = 25 * Math.floor((hardness - 1) / 25);
    else {
      if (diameter <= 10) diameter--;
      else if (diameter <= 50) diameter = 5 * Math.floor((diameter - 1) / 5);
      else if (diameter <= 100) diameter = 10 * Math.floor((diameter - 1) / 10);
      else if (diameter <= 200) diameter = 25 * Math.floor((diameter - 1) / 25);
      else if (diameter <= 400) diameter = 50 * Math.floor((diameter - 1) / 50);
      else diameter = 100 * Math.floor((diameter - 1) / 100)
    }
  }
  if (keyboard.isPressed(KeyboardHandler.BracketRight)) {
    if (shiftPressed) hardness = 25 * Math.ceil((hardness + 1) / 25);
    else {
      if (diameter < 10) diameter++;
      else if (diameter < 50) diameter = 5 * Math.ceil((diameter + 1) / 5);
      else if (diameter < 100) diameter = 10 * Math.ceil((diameter + 1) / 10);
      else if (diameter < 200) diameter = 25 * Math.ceil((diameter + 1) / 25);
      else if (diameter < 400) diameter = 50 * Math.ceil((diameter + 1) / 50);
      else diameter = 100 * Math.ceil((diameter + 1) / 100)
    }
  }
  diameter = Math.max(1, diameter);
  hardness = Math.max(0, Math.min(100, hardness));
  if (originalHardness == -1) hardness = -1;
  if (diameter != originalDiameter || hardness != originalHardness) {
    var updatedBrushDescriptor = JSON.parse(JSON.stringify(brushDescriptor));
    updatedBrushDescriptor.Brsh.v.diameter.v.val = diameter;
    if (originalHardness != -1) updatedBrushDescriptor.Brsh.v.Hrdn.v.val = hardness;
    return updatedBrushDescriptor
  }
  return null
};
PaintTool.prototype.updateCursor = function(appData, keyboard, doc, pointerState) {
  if (appData.brushPresets.list.length == 0 && this.toolOptions.brush == null) return;
  var toolId = this.id,
    cursorPayload;
  if ((toolId == ToolId.TOOL_CLONE_STAMP || toolId == ToolId.TOOL_HEAL_BRUSH || toolId == ToolId.TOOL_BRUSH || toolId == ToolId.TOOL_PENCIL) && (keyboard != null && keyboard.isPressed(KeyboardHandler.Alt) || this.toolOptions.alt[0])) cursorPayload = "crosshair";
  else {
    var viewScale = this.viewScaleAtStroke,
      brushDescriptor = this.toolOptions.brush;
    if ((toolId == ToolId.TOOL_CLONE_STAMP || toolId == ToolId.TOOL_HEAL_BRUSH) && doc && this.cloneSamplePixels && this.cloneSamplePixels.length == this.cloneSampleRect.area() * 4) {
      var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y),
        cloneOffset = this.resolveCloneOffsetForPoint(docPoint),
        samplePixels = this.cloneSamplePixels,
        sampleRect = this.cloneSampleRect,
        placedSampleRect = new Rect(sampleRect.x + cloneOffset.x, sampleRect.y + cloneOffset.y, sampleRect.width, sampleRect.height),
        brushStamp = BrushStroke.createBrushStamp(brushDescriptor, appData.brushPresets.samples, viewScale),
        stampAlphaMask = brushStamp[0],
        stampRect = brushStamp[1],
        halfStampSize = Math.ceil(stampRect.width / viewScale),
        previewRect = new Rect(Math.round(docPoint.x - halfStampSize / 2), Math.round(docPoint.y - halfStampSize / 2), halfStampSize, halfStampSize),
        previewBuffer = allocBuffer(previewRect.area() * 4),
        scaledBuffer, scaledRect;
      copyPixels(samplePixels, placedSampleRect, previewBuffer, previewRect);
      if (viewScale == 1) {
        scaledBuffer = previewBuffer;
        scaledRect = previewRect
      } else {
        var scaleMatrix = new Matrix2D(viewScale, 0, 0, viewScale, 0, 0),
          transformResult = transformPixels([previewBuffer, previewRect], scaleMatrix, true);
        scaledRect = stampRect.clone();
        scaledRect.x = transformResult.rect.x;
        scaledRect.y = transformResult.rect.y;
        if (scaledRect.equals(transformResult.rect)) scaledBuffer = transformResult.buffer;
        else {
          scaledBuffer = allocBuffer(scaledRect.area() * 4);
          copyPixels(transformResult.buffer, transformResult.rect, scaledBuffer, scaledRect)
        }
      }
      var opacityFactor = this.toolOptions.Opct / 255;
      for (var pixelOffset = 0; pixelOffset < scaledBuffer.length; pixelOffset += 4) scaledBuffer[pixelOffset + 3] = opacityFactor * (stampAlphaMask[pixelOffset + 3] * scaledBuffer[pixelOffset + 3]);
      cursorPayload = {
        pixelSource: scaledBuffer,
        boundsRect: scaledRect,
        hotspot: new Point(scaledRect.width / 2, scaledRect.height / 2)
      }
    } else cursorPayload = BrushStroke.createCursorGlyph(brushDescriptor, appData.brushPresets.samples, viewScale, toolId == ToolId.TOOL_COLOR_REPLACEMENT)
  }
  var cursorEvent = new AppEvent(EventType.uiDispatch, true);
  cursorEvent.data = {
    dispatchKind: UiCommand.splashOptionsUpdate,
    cursorOverlayId: cursorPayload
  };
  if (this.caller) this.caller.dispatch(cursorEvent)
};
PaintTool.prototype.enable = function(doc, dispatcher, appData, keyboard) {
  this.appData = appData;
  this.caller = dispatcher;
  this.dispatchBrushPresetPopup(JSON.parse(JSON.stringify(this.toolOptions.brush)));
  if (doc && doc.pathViewport.zoomScale != 0) this.viewScaleAtStroke = doc.pathViewport.zoomScale;
  this.updateCursor(appData, keyboard)
};
PaintTool.prototype.onUpdate = function(appData, popupType) {
  if (popupType == PopupTypes.SCRIPTS) {
    this.toolOptions.brush = appData.brushPresets.activeBrushPreset;
    this.updateCursor(appData)
  }
};
PaintTool.prototype.applyAction = function(actionPayload, dispatcher, doc, keyboard, appData) {
  for (var optionKey in actionPayload) this.toolOptions[optionKey] = actionPayload[optionKey];
  if (this.toolOptions.alt[0]) this.updateCursor(appData, keyboard, doc)
};
/**
 * Resolve the surface a paint operation writes to: the active extra channel,
 * the layer's raster mask, its smart-filter mask, or the layer pixels.
 * `maskTarget` is null when painting layer pixels; `pixelBuffer`/`sampleRect`
 * always reference the painted surface.
 */
PaintTool.prototype.resolvePaintTarget = function(doc) {
  var layerIndex = doc.activeChannels.length != 0 ? -1 - doc.activeChannels[0] : doc.selectedLayerIndices[0],
    layer = doc.layers[layerIndex],
    pixelContentKind = layerIndex < 0 ? 1 : layer.pixelContent,
    maskTarget = layerIndex < 0 ? doc.extraChannels[-layerIndex - 1] : pixelContentKind <= 0 ? null : pixelContentKind == 1 ? layer.getMask() : layer.getLinkedPlacedItem(doc).d;
  return {
    layerIndex: layerIndex,
    layer: layer,
    pixelContentKind: pixelContentKind,
    maskTarget: maskTarget,
    pixelBuffer: maskTarget ? maskTarget.channel : layer.buffer,
    sampleRect: (maskTarget ? maskTarget.rect : layer.rect).clone()
  };
};
PaintTool.prototype.capturePaintSourceBuffers = function(doc, skipSlice) {
  this.selectionBeforeStroke = doc.selectionMask == null ? null : {
    rect: doc.selectionMask.rect.clone(),
    channel: doc.selectionMask.channel.slice(0)
  };
  var paintTarget = this.resolvePaintTarget(doc);
  this.sourcePixelBuffer = paintTarget.pixelBuffer;
  this.sourceSampleRect = paintTarget.sampleRect;
  var documentBounds = new Rect(0, 0, doc.width, doc.height),
    unionBounds = documentBounds.union(this.sourceSampleRect);
  if ((this.usesPerPixelBuffer() && paintTarget.pixelContentKind <= 0 || unionBounds.equals(this.sourceSampleRect)) && skipSlice != true) this.sourcePixelBuffer = this.sourcePixelBuffer.slice(0);
  else {
    if (paintTarget.maskTarget) paintTarget.maskTarget.extend(unionBounds);
    else paintTarget.layer.extend(unionBounds)
  }
};
PaintTool.prototype.bindSourceBuffersForStroke = function(doc, sourceFromOverride) {
  var paintTarget = this.resolvePaintTarget(doc),
    samplePixels = paintTarget.pixelBuffer,
    sampleRect = paintTarget.sampleRect,
    sourceFrom = sourceFromOverride != null ? sourceFromOverride : this.toolOptions.sfrom;
  if (paintTarget.pixelContentKind <= 0 && sourceFrom != 0) {
    sampleRect = new Rect(0, 0, doc.width, doc.height);
    samplePixels = doc.getRasterData(sourceFrom == 1 && doc.selectedLayerIndices[0] != doc.layers.length - 1 ? doc.selectedLayerIndices[0] : null).slice(0)
  }
  this.cloneSampleRect = sampleRect.clone();
  this.cloneSamplePixels = samplePixels.slice(0)
};
PaintTool.prototype.forwardEyedropperIfAlt = function(keyboard, dispatcher, pointerState) {
  if (keyboard.isPressed(KeyboardHandler.Alt)) {
    var eyedropperEvent = new AppEvent(EventType.documentAction, true);
    eyedropperEvent.routingChannel = ToolId.TOOL_EYEDROPPER;
    eyedropperEvent.data = {
      actionKind: "pickhere",
      pointerState: pointerState
    };
    dispatcher.dispatch(eyedropperEvent);
    return true
  }
  return false
};
PaintTool.prototype.beginStroke = function(doc, appData, keyboard, pointerState, flowOpacity, brushMode) {
  if (!doc.ensureLayerEditableForTools(this.caller)) {
    this.strokeData = null;
    return
  }
  this.capturePaintSourceBuffers(doc);
  var docBoundsRect = new Rect(0, 0, doc.width, doc.height),
    perPixelBuffer = null;
  if (brushMode != null) {
    var sourceChannel = this.resolvePaintTarget(doc).maskTarget;
    perPixelBuffer = allocBuffer(docBoundsRect.area() * 4);
    if (sourceChannel) blitChannelToBuffer(this.sourcePixelBuffer, this.sourceSampleRect, sourceChannel.color, perPixelBuffer, docBoundsRect);
    else copyPixels(this.sourcePixelBuffer, this.sourceSampleRect, perPixelBuffer, docBoundsRect)
  }
  var toolOptions = this.toolOptions;
  if (this.strokeData && this.id == ToolId.TOOL_QUICK_SELECT && toolOptions.qsmode != 0 && doc.selectionMask != null) {} else {
    var foregroundColor = appData.colorInt,
      backgroundColor = appData.bgColor;
    if (this.strokeCompositeMode == "erase") {
      var swappedColor = foregroundColor;
      foregroundColor = backgroundColor;
      backgroundColor = swappedColor
    }
    var strokeSampleRect = this.id == ToolId.TOOL_QUICK_SELECT ? this.sourceSampleRect : docBoundsRect;
    this.strokeData = new BrushStroke(toolOptions.brush, appData.brushPresets.samples, appData.brushPresets.patterns, {
      opacity: flowOpacity,
      brushMode: brushMode,
      smoothing: toolOptions.smth * 50 * getDevicePixelRatio() / doc.pathViewport.zoomScale,
      pixelSnap: this.id == ToolId.TOOL_PENCIL || toolOptions.emode == 1,
      gp: toolOptions.prsr
    }, foregroundColor, backgroundColor, strokeSampleRect, perPixelBuffer)
  }
  if (this.id == ToolId.TOOL_QUICK_SELECT) {
    this.strokeData.initBrushState(toolOptions.brush, toolOptions.qsmode == 2 ? 0 : 16777215)
  }
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
  if (keyboard.isPressed(KeyboardHandler.Shift) && this.lastStrokePointDoc) {
    var shiftAnchorPoint = this.lastStrokePointDoc;
    this.strokeData.moveTo(shiftAnchorPoint.x, shiftAnchorPoint.y, pointerState.pressure);
    this.strokeData.lineTo(.001 * shiftAnchorPoint.x + .999 * docPoint.x, .001 * shiftAnchorPoint.y + .999 * docPoint.y, pointerState.pressure);
    this.strokeData.lineTo(docPoint.x, docPoint.y, pointerState.pressure)
  } else this.strokeData.moveTo(docPoint.x, docPoint.y, pointerState.pressure);
  this.lastStrokePointDoc = docPoint;
  this.straightLineAnchorDoc = docPoint.clone();
  this.strokePathKnot = new AxisDragAnchor(docPoint, doc.pathViewport.rotationRadians)
};
PaintTool.prototype.syncBrushScaleToZoom = function(doc, dispatcher, appData) {
  if (doc && doc.pathViewport.zoomScale != 0 && doc.pathViewport.zoomScale != this.viewScaleAtStroke) {
    this.viewScaleAtStroke = doc.pathViewport.zoomScale;
    this.updateCursor(appData)
  }
};
PaintTool.prototype.refreshHoverCursor = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (this.strokeData != null || this.rightDragAnchor != null) return;
  this.updateCursor(appData, keyboard, doc, pointerState)
};
PaintTool.prototype.continueStroke = function(doc, appData, keyboard, pointerState) {
  if (this.strokeData == null) return;
  var activeLayer = doc.layers[doc.selectedLayerIndices[0]],
    rawDocPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y),
    smoothedDocPoint = this.strokePathKnot.constrainAxisDragPoint(rawDocPoint, keyboard);
  if (smoothedDocPoint.equals(this.lastStrokePointDoc)) return 1;
  this.strokeData.lineTo(smoothedDocPoint.x, smoothedDocPoint.y, pointerState.pressure);
  this.lastStrokePointDoc = smoothedDocPoint;
  if (this.id == ToolId.TOOL_CLONE_STAMP || this.id == ToolId.TOOL_HEAL_BRUSH) {
    var cloneCenterDoc = this.getCloneOffset(),
      cloneOverlaySize = 11;
    cloneCenterDoc = doc.pathViewport.docToScreenPoint(rawDocPoint.x - cloneCenterDoc.x, rawDocPoint.y - cloneCenterDoc.y);
    var cloneOverlayHalf = cloneOverlaySize >>> 1,
      cloneOverlayRect = new Rect(Math.round(cloneCenterDoc.x) - cloneOverlayHalf, Math.round(cloneCenterDoc.y) - cloneOverlayHalf, cloneOverlaySize, cloneOverlaySize),
      cloneOverlayPixels = allocBuffer(cloneOverlayRect.area() * 4);
    fillBuffer(cloneOverlayPixels, 16777215);
    for (var overlayRow = 0; overlayRow < cloneOverlaySize; overlayRow++) cloneOverlayPixels[(overlayRow * cloneOverlaySize + cloneOverlayHalf) * 4 + 3] = cloneOverlayPixels[(cloneOverlaySize * cloneOverlayHalf + overlayRow) * 4 + 3] = 255;
    doc.toolOverlayState.floatingBitmapOverlays = [
      [cloneOverlayPixels, cloneOverlayRect]
    ];
    doc.dirty = true
  }
};
PaintTool.prototype.onDocumentStateChange = function(doc, dispatcher, appData, keyboard) {
  if (appData.activeToolId != this.id) return;
  if (this.id != ToolId.TOOL_QUICK_SELECT || doc == null) return;
  if (doc.selectionMask == null || doc.selectedLayerIndices[0] != this.quickSelectActiveLayerIndex) {
    this.quickSelectActiveLayerIndex = doc.selectedLayerIndices[0];
    this.dispatchToolOptionUpdate({
      qsmode: 0
    }, dispatcher)
  }
};
PaintTool.prototype.invalidatePaintDirtyRegion = function(doc, dirtyBounds) {
  if (doc.activeChannels.length != 0) {
    doc.dirty = true;
    return
  }
  var activeLayer = doc.layers[doc.selectedLayerIndices[0]];
  if (dirtyBounds == null) {
    dirtyBounds = this.strokeData.getSegmentBounds();
    if (this.usesPerPixelBuffer() && activeLayer.pixelContent <= 0) dirtyBounds = dirtyBounds.intersect(this.sourceSampleRect)
  }
  if (dirtyBounds.isEmpty()) return;
  if (activeLayer.pixelContent <= 0) {
    activeLayer.markDirty(dirtyBounds)
  }
  if (activeLayer.pixelContent == 1) {
    activeLayer.getMask().maskCombineDirty = true;
    activeLayer.invalidate(doc)
  }
  if (activeLayer.pixelContent == 3) {
    activeLayer.markDirty()
  }
  doc.markDirty(doc.root.getExpandedDirtyRect(dirtyBounds, doc, doc.selectedLayerIndices[0], true))
};
PaintTool.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (this.strokeData == null) return;
  this.strokeData.finish();
  if (this.id != ToolId.TOOL_SPOT_HEAL && this.id != ToolId.TOOL_HEAL_BRUSH && this.id != ToolId.TOOL_QUICK_SELECT) this.applyStroke(doc);
  if (this.id == ToolId.TOOL_CLONE_STAMP || this.id == ToolId.TOOL_HEAL_BRUSH) {
    doc.toolOverlayState.floatingBitmapOverlays = [];
    doc.dirty = true
  }
  if (this.id == ToolId.TOOL_QUICK_SELECT) {
    var selectionAfterStroke = doc.selectionMask;
    doc.selectionMask = this.selectionBeforeStroke;
    var setSelectionEvent = new AppEvent(EventType.documentAction, true);
    setSelectionEvent.data = {
      actionKind: "setsel",
      historyLabelKey: this.name,
      selectionMask: selectionAfterStroke
    };
    setSelectionEvent.routingChannel = ToolId.TOOL_RECT_SELECT;
    dispatcher.dispatch(setSelectionEvent);
    if (this.toolOptions.qsmode == 0) this.dispatchToolOptionUpdate({
      qsmode: 1
    }, dispatcher)
  } else {
    this.finish(doc, this.strokeData.getDirtyBounds());
    this.strokeData = null;
    this.strokeHealBuffer = null
  }
};
PaintTool.prototype.dispatchToolOptionUpdate = function(optionUpdates, dispatcher) {
  for (var optionKey in optionUpdates) this.toolOptions[optionKey] = optionUpdates[optionKey];
  var uiDispatchEvent = new AppEvent(EventType.uiDispatch, true);
  uiDispatchEvent.data = {
    dispatchKind: UiCommand.forwardActiveToolGesture,
    routingChannel: this.id,
    optionUpdates: optionUpdates
  };
  dispatcher.dispatch(uiDispatchEvent)
};
PaintTool.prototype.usesPerPixelBuffer = function() {
  var toolId = this.id;
  return toolId == ToolId.TOOL_QUICK_SELECT || toolId == ToolId.TOOL_ERASER || toolId == ToolId.TOOL_DODGE || toolId == ToolId.TOOL_BURN || toolId == ToolId.TOOL_SPONGE || toolId == ToolId.TOOL_RED_EYE;
};
PaintTool.prototype.finish = function(doc, dirtyRect, historyLabelKey, clearSelectionAfter, captureSelectionBefore) {
  var paintTarget = this.resolvePaintTarget(doc),
    layerIndex = paintTarget.layerIndex,
    targetLayer = paintTarget.layer,
    pixelContentKind = paintTarget.pixelContentKind,
    maskOrContentTarget = paintTarget.maskTarget,
    contentRect = maskOrContentTarget ? maskOrContentTarget.rect : targetLayer.rect,
    snapshotPixelBuffer;
  if (this.usesPerPixelBuffer() || !contentRect.equals(this.sourceSampleRect)) {
    if (maskOrContentTarget == null) {
      if (this.usesPerPixelBuffer()) targetLayer.trimToContent();
      else {
        var mergedContentRect = dirtyRect.union(this.sourceSampleRect),
          expandedLayerBuffer = allocBuffer(mergedContentRect.area() * 4);
        copyPixels(targetLayer.buffer, targetLayer.rect, expandedLayerBuffer, mergedContentRect);
        targetLayer.buffer = expandedLayerBuffer;
        targetLayer.rect = mergedContentRect
      }
    } else maskOrContentTarget.trimToContent();
    this.invalidatePaintDirtyRegion(doc, contentRect)
  }
  if (pixelContentKind <= 0) {
    snapshotPixelBuffer = allocBuffer(dirtyRect.area() * 4);
    copyPixels(this.sourcePixelBuffer, this.sourceSampleRect, snapshotPixelBuffer, dirtyRect)
  } else {
    snapshotPixelBuffer = allocBuffer(dirtyRect.area());
    snapshotPixelBuffer.fill(maskOrContentTarget.color);
    copyChannel(this.sourcePixelBuffer, this.sourceSampleRect, snapshotPixelBuffer, dirtyRect)
  }
  this.pushPaintHistory(doc, false, historyLabelKey ? historyLabelKey : this.name, layerIndex, pixelContentKind, dirtyRect, snapshotPixelBuffer, clearSelectionAfter, captureSelectionBefore)
};
PaintTool.prototype.pushPaintHistory = function(doc, redoImmediately, historyLabelKey, layerIndex, pixelContentKind, dirtyRect, pixelBuffer, clearSelectionAfter, captureSelectionBefore) {
  var historyPixelBuffer = pixelBuffer;
  if (pixelContentKind > 0) {
    historyPixelBuffer = allocBuffer(dirtyRect.area() * 4);
    blitChannelToBuffer(pixelBuffer, dirtyRect, 0, historyPixelBuffer, dirtyRect)
  }
  var historyEntry = new HistoryEntry(historyLabelKey, this);
  historyEntry.data = [{
    layerIndex: layerIndex,
    pixelContentKind: pixelContentKind,
    dirtyRect: dirtyRect,
    pixBuf: historyPixelBuffer
  }];
  if (clearSelectionAfter) historyEntry.data.selectionSnapshots = [doc.selectionMask, null];
  if (captureSelectionBefore) historyEntry.data.selectionSnapshots = [this.selectionBeforeStroke, doc.selectionMask];
  doc.pushHistory(historyEntry);
  if (redoImmediately) this.redo(historyEntry.data, doc);
  else if (clearSelectionAfter) doc.selectionMask = null;
  TrackerRegistry.AdjustmentPreviewTracker.writeSnapshotsToDocument(doc, historyEntry.data)
};
PaintTool.prototype.undo = function(historyData, doc) {
  this.applyPaintHistoryEntry(historyData, doc, false)
};
PaintTool.prototype.redo = function(historyData, doc) {
  this.applyPaintHistoryEntry(historyData, doc, true)
};
PaintTool.prototype.applyPaintHistoryEntry = function(historyData, doc, isRedo) {
  if (historyData.actionKind == "drawtemp") {
    var pixCacheSnapshot = isRedo ? historyData.pixCacheAfter : historyData.pixCacheBefore,
      targetLayer = doc.layers[historyData.layerIndex];
    targetLayer.pixCache.selectionPixels = pixCacheSnapshot;
    targetLayer.syncSelectionOverlay(doc, 0, 0, doc.selectionMask);
    targetLayer.markDirty();
    doc.stateChanged = true
  } else {
    TrackerRegistry.AdjustmentPreviewTracker.restoreSnapshotsOnUndoRedo(doc, historyData);
    if (historyData.selectionSnapshots) {
      doc.selectionMask = historyData.selectionSnapshots[isRedo ? 1 : 0];
      doc.needsComposite = true
    }
  }
  doc.markDirty()
};
PaintTool.prototype.applyStroke = function(doc) {
  this.compositeStrokeToLayer(doc, this.strokeCompositeMode, this.strokeData.getBuffer(), this.strokeData.getSelectionRect(), this.strokeData.getSegmentBounds());
  this.invalidatePaintDirtyRegion(doc)
};
PaintTool.prototype.compositeStrokeToLayer = function(doc, compositeMode, strokeBuffer, strokeRect, segmentBounds) {
  var toolOptions = this.toolOptions,
    activeLayer = doc.layers[doc.selectedLayerIndices[0]],
    maskOrContentTarget = doc.activeChannels.length != 0 ? doc.extraChannels[doc.activeChannels[0]] : activeLayer.pixelContent <= 0 ? null : activeLayer.pixelContent == 1 ? activeLayer.getMask() : activeLayer.getLinkedPlacedItem(doc).d,
    destCompositeBuffer = allocBuffer(segmentBounds.area() * 4),
    preservedAlphaChannel, isTransparencyLocked = activeLayer.isLockBitSet(0);
  if (maskOrContentTarget == null) {
    if (this.id == ToolId.TOOL_CONTENT_AWARE_MOVE && compositeMode == "heal") copyPixels(activeLayer.buffer, activeLayer.rect, destCompositeBuffer, segmentBounds);
    else copyPixels(this.sourcePixelBuffer, this.sourceSampleRect, destCompositeBuffer, segmentBounds);
    if (isTransparencyLocked) {
      preservedAlphaChannel = allocBuffer(segmentBounds.area());
      extractChannelByte(destCompositeBuffer, preservedAlphaChannel, 3)
    }
  } else {
    blitChannelToBuffer(this.sourcePixelBuffer, this.sourceSampleRect, maskOrContentTarget.color, destCompositeBuffer, segmentBounds)
  }
  if (doc.selectionMask && compositeMode != "qselect") {
    var selectionIntersectRect = segmentBounds.intersect(doc.selectionMask.rect),
      maskedStrokeBuffer = allocBuffer(selectionIntersectRect.area() * 4);
    if (compositeMode == "copy") {
      var selectionMaskChannel = allocBuffer(selectionIntersectRect.area());
      copyChannel(doc.selectionMask.channel, doc.selectionMask.rect, selectionMaskChannel, selectionIntersectRect);
      copyPixels(destCompositeBuffer, segmentBounds, maskedStrokeBuffer, selectionIntersectRect);
      compositeLayer(strokeBuffer, strokeRect, maskedStrokeBuffer, selectionIntersectRect, selectionMaskChannel, selectionIntersectRect, 0, selectionIntersectRect, 1, false)
    } else {
      copyPixels(strokeBuffer, strokeRect, maskedStrokeBuffer, selectionIntersectRect);
      scaleRgbaAlphaByMask(doc.selectionMask.channel, doc.selectionMask.rect, maskedStrokeBuffer, selectionIntersectRect)
    }
    strokeBuffer = maskedStrokeBuffer;
    strokeRect = selectionIntersectRect
  }

  if (compositeMode == "idraw" || compositeMode == "ierase") {
    if (this.strokeHealBuffer == null) this.strokeHealBuffer = allocBuffer(this.sourceSampleRect.area());
    var sampleMode = this.toolOptions.samp,
      bgColor = this.appData.bgColor,
      clampedLastPoint = clampPointToDocRect(this.lastStrokePointDoc, segmentBounds),
      sampleAnchorPoint = sampleMode == 0 ? clampedLastPoint : this.straightLineAnchorDoc,
      anchorX = sampleAnchorPoint.x,
      anchorY = sampleAnchorPoint.y,
      sampleColors = readSampleColors(this.sourcePixelBuffer, this.sourceSampleRect, [sampleAnchorPoint, new Point(anchorX - 2, anchorY), new Point(anchorX + 2, anchorY), new Point(anchorX, anchorY - 2), new Point(anchorX, anchorY + 2)]);
    if (sampleMode == 2) sampleColors = [
      [bgColor >>> 16 & 255, bgColor >>> 8 & 255, bgColor >>> 0 & 255, 255]
    ];
    var floodMask = floodSelectMask(destCompositeBuffer, segmentBounds, clampedLastPoint, sampleColors, this.toolOptions.wconf),
      healChannelScratch = allocBuffer(segmentBounds.area());
    copyChannel(this.strokeHealBuffer, this.sourceSampleRect, healChannelScratch, segmentBounds);
    union(floodMask, healChannelScratch, healChannelScratch);
    copyChannel(healChannelScratch, segmentBounds, this.strokeHealBuffer, this.sourceSampleRect);
    scaleRgbaAlphaByMask(healChannelScratch, segmentBounds, strokeBuffer, strokeRect);
    compositeMode = compositeMode.slice(1)
  }
  if (compositeMode == "erase" && (TrackerRegistry.AdjustmentPreviewTracker.getBottomLayerBackgroundColor(doc) != 16777215 || maskOrContentTarget)) compositeMode = "draw";
  if (compositeMode == "draw") composite(toolOptions.bmode, strokeBuffer, strokeRect, destCompositeBuffer, segmentBounds, segmentBounds, toolOptions.Opct);
  else if (compositeMode == "erase") {
    var eraseScratchBuffer = allocBuffer(segmentBounds.area() * 4);
    copyPixels(strokeBuffer, strokeRect, eraseScratchBuffer, segmentBounds);
    if (maskOrContentTarget == null) {
      var eraseAlphaMask = allocBuffer(segmentBounds.area());
      extractChannelByte(eraseScratchBuffer, eraseAlphaMask, 3);
      scaleBuffer(eraseAlphaMask, toolOptions.Opct);
      invert(eraseAlphaMask);
      scaleRgbaAlphaByMask(eraseAlphaMask, segmentBounds, destCompositeBuffer, segmentBounds)
    } else {
      fillBuffer(eraseScratchBuffer, 0, 4278190080);
      composite("norm", eraseScratchBuffer, segmentBounds, destCompositeBuffer, segmentBounds, segmentBounds, toolOptions.Opct)
    }
  } else if (compositeMode == "clone" || compositeMode == "heal") {
    this.compositeCloneHeal(compositeMode, strokeBuffer, strokeRect, destCompositeBuffer, segmentBounds, maskOrContentTarget)
  } else if (compositeMode == "dodge" || compositeMode == "burn") {
    this.compositeDodgeBurn(compositeMode, strokeBuffer, strokeRect, destCompositeBuffer, segmentBounds)
  } else if (compositeMode == "sponge" || compositeMode == "redeye") {
    this.compositeSpongeRedeye(compositeMode, strokeBuffer, strokeRect, destCompositeBuffer, segmentBounds)
  } else if (compositeMode == "copy") copyPixels(strokeBuffer, strokeRect, destCompositeBuffer, segmentBounds);
  else if (compositeMode == "sheal") {
    this.compositeSpotHeal(strokeBuffer, strokeRect, destCompositeBuffer, segmentBounds, maskOrContentTarget)
  } else if (compositeMode == "qselect") {
    this.compositeQuickSelect(doc)
  }
  if (maskOrContentTarget == null) {
    if (isTransparencyLocked) extractChannel(preservedAlphaChannel, destCompositeBuffer, 3);
    copyPixels(destCompositeBuffer, segmentBounds, activeLayer.buffer, activeLayer.rect)
  } else PaintTool.copyCompositeToMask(destCompositeBuffer, segmentBounds, maskOrContentTarget)
};
/** Clone-stamp / healing-brush composite: sample at the clone offset, then blend or Poisson-heal. */
PaintTool.prototype.compositeCloneHeal = function(compositeMode, strokeBuffer, strokeRect, destCompositeBuffer, segmentBounds, maskOrContentTarget) {
  var toolOptions = this.toolOptions,
    cloneOffset = this.getCloneOffset(),
    offsetCloneRect = this.cloneSampleRect.clone();
  offsetCloneRect.offset(cloneOffset.x, cloneOffset.y);
  var inflatedSegmentBounds = segmentBounds.clone();
  inflatedSegmentBounds.inflate(1, 1);
  var strokeRgbaBuffer = allocBuffer(inflatedSegmentBounds.area() * 4),
    strokeAlphaMask = allocBuffer(inflatedSegmentBounds.area());
  copyPixels(strokeBuffer, strokeRect, strokeRgbaBuffer, inflatedSegmentBounds);
  extractChannelByte(strokeRgbaBuffer, strokeAlphaMask, 3);
  fillBuffer(strokeRgbaBuffer, 0);
  if (maskOrContentTarget == null) {
    copyPixels(this.cloneSamplePixels, offsetCloneRect, strokeRgbaBuffer, inflatedSegmentBounds);
    var cloneAlphaProduct = allocBuffer(inflatedSegmentBounds.area());
    extractChannelByte(strokeRgbaBuffer, cloneAlphaProduct, 3);
    multiplyBuffers(cloneAlphaProduct, strokeAlphaMask)
  } else blitChannelToBuffer(this.cloneSamplePixels, offsetCloneRect, maskOrContentTarget.color, strokeRgbaBuffer, inflatedSegmentBounds);
  if (compositeMode == "clone") {
    extractChannel(strokeAlphaMask, strokeRgbaBuffer, 3);
    composite(toolOptions.bmode, strokeRgbaBuffer, inflatedSegmentBounds, destCompositeBuffer, segmentBounds, segmentBounds, toolOptions.Opct)
  }
  if (compositeMode == "heal") {
    var roundedAlphaForHeal = strokeAlphaMask.slice(0);
    round(roundedAlphaForHeal, 20);
    var healBaseBuffer = allocBuffer(inflatedSegmentBounds.area() * 4);
    if (maskOrContentTarget == null) copyPixels(this.sourcePixelBuffer, this.sourceSampleRect, healBaseBuffer, inflatedSegmentBounds);
    else blitChannelToBuffer(this.sourcePixelBuffer, this.sourceSampleRect, maskOrContentTarget.color, healBaseBuffer, inflatedSegmentBounds);
    compositeLayer(strokeRgbaBuffer, inflatedSegmentBounds, healBaseBuffer, inflatedSegmentBounds, roundedAlphaForHeal, inflatedSegmentBounds, 0, inflatedSegmentBounds, 1, false);
    solvePoissonFill(healBaseBuffer, roundedAlphaForHeal, inflatedSegmentBounds);
    compositeLayer(healBaseBuffer, inflatedSegmentBounds, destCompositeBuffer, segmentBounds, strokeAlphaMask, inflatedSegmentBounds, 0, segmentBounds, 1, false)
  }
};
/** Sponge (saturate/desaturate) and red-eye: run a hue2 adjustment under the stroke alpha. */
PaintTool.prototype.compositeSpongeRedeye = function(compositeMode, strokeBuffer, strokeRect, destCompositeBuffer, segmentBounds) {
  var strokeRgbaBuffer = allocBuffer(segmentBounds.area() * 4),
    strokeAlphaMask = allocBuffer(segmentBounds.area());
  copyPixels(strokeBuffer, strokeRect, strokeRgbaBuffer, segmentBounds);
  extractChannelByte(strokeRgbaBuffer, strokeAlphaMask, 3);
  copyBuffer(destCompositeBuffer, strokeRgbaBuffer);
  var spongeMode = this.toolOptions.smode;
  if (this.usePenPressure) spongeMode = 1 - spongeMode;
  var hueAdjustmentDescriptor = FilterDefs.create("hue2");
  if (compositeMode == "sponge") HueSaturationParser.setChannelData(hueAdjustmentDescriptor, 0, [0, [-50, 46][spongeMode],
    [6, 5][spongeMode]
  ]);
  else HueSaturationParser.setChannelData(hueAdjustmentDescriptor, 1, {
    bounds: [265, 305, 25, 55],
    hslShift: [0, -90, -70]
  });
  var shaderOptions = AdjustmentEngine.buildShaderOptions("hue2", hueAdjustmentDescriptor);
  AdjustmentEngine.applySoftware(shaderOptions, strokeRgbaBuffer, strokeRgbaBuffer, segmentBounds);
  compositeLayer(strokeRgbaBuffer, segmentBounds, destCompositeBuffer, segmentBounds, strokeAlphaMask, segmentBounds, 0, segmentBounds, 1, false)
};
/** Spot-heal: content-aware fill of the stroked region from surrounding pixels. */
PaintTool.prototype.compositeSpotHeal = function(strokeBuffer, strokeRect, destCompositeBuffer, segmentBounds, maskOrContentTarget) {
  var strokeRgbaBuffer = allocBuffer(segmentBounds.area() * 4),
    strokeAlphaMask = allocBuffer(segmentBounds.area());
  copyPixels(strokeBuffer, strokeRect, strokeRgbaBuffer, segmentBounds);
  extractChannelByte(strokeRgbaBuffer, strokeAlphaMask, 3);
  strokeRgbaBuffer.fill(0);
  var clonePixelsForHeal = this.cloneSamplePixels,
    cloneSampleRectRef = this.cloneSampleRect;
  if (maskOrContentTarget) {
    clonePixelsForHeal = allocBuffer(cloneSampleRectRef.area() * 4);
    blitChannelToBuffer(this.cloneSamplePixels, cloneSampleRectRef, 0, clonePixelsForHeal, cloneSampleRectRef)
  }
  var healFillResult = runHealingBrushFill(clonePixelsForHeal, cloneSampleRectRef, strokeAlphaMask, strokeRgbaBuffer, segmentBounds);
  if (healFillResult != 0) copyPixels(clonePixelsForHeal, cloneSampleRectRef, strokeRgbaBuffer, segmentBounds);
  if (this.toolOptions.sfrom == 0) copyPixels(strokeRgbaBuffer, segmentBounds, destCompositeBuffer, segmentBounds);
  else {
    copyPixels(this.sourcePixelBuffer, this.sourceSampleRect, destCompositeBuffer, segmentBounds);
    extractChannel(strokeAlphaMask, strokeRgbaBuffer, 3);
    composite("norm", strokeRgbaBuffer, segmentBounds, destCompositeBuffer, segmentBounds, segmentBounds, 1)
  }
};
/**
 * Quick-select: copy the stroke's marks into the session's scribble buffer and
 * let the graph cut around them decide what the selection is.
 *
 * The stroke buffer carries every mark of the gesture, white where the brush
 * added and black where it subtracted, so the scribbles are rewritten from it
 * in full each time; the session tracks which of them it has already resolved.
 */
PaintTool.prototype.compositeQuickSelect = function(doc) {
  var quickSelectBounds = this.sourceSampleRect,
    pixelCount = quickSelectBounds.width * quickSelectBounds.height,
    strokeBufferRef = this.strokeData.getBuffer(),
    session = quickSelectSession,
    brushMaskBuffer = session.brushMaskBuffer;
  brushMaskBuffer.fill(128);
  for (var pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    var maskValue = strokeBufferRef[pixelIndex << 2],
      strokeAlpha = strokeBufferRef[(pixelIndex << 2) + 3];
    if (strokeAlpha == 255 && (maskValue == 0 || maskValue == 255)) brushMaskBuffer[pixelIndex] = maskValue
  }
  // The brush sets how far one dab of it reaches past what it covered.
  session.brushRadius = this.toolOptions.brush.Brsh.v.diameter.v.val / 2;
  recomputeQuickSelectSelection(session);
  doc.selectionMask = {
    rect: quickSelectBounds,
    channel: session.selectionMaskBuffer.slice(0)
  };
  // Remembered so the next stroke can tell whether the document's selection is
  // still the one this session produced.
  session.emittedSelection = doc.selectionMask;
  doc.needsComposite = true
};
/**
 * Dodge/burn a stroke segment. The exposure curve depends only on the channel
 * value, so it is precomputed into a 256-entry table; each pixel then blends
 * the adjusted value with the original by brush alpha.
 */
PaintTool.prototype.compositeDodgeBurn = function(compositeMode, strokeBuffer, strokeRect, destCompositeBuffer, segmentBounds) {
  var strokeRgbaBuffer = allocBuffer(segmentBounds.area() * 4),
    exposureStrength = 1,
    multiplyFactor = 0,
    gammaExponent = 0,
    exposureOffset = 0;
  copyPixels(strokeBuffer, strokeRect, strokeRgbaBuffer, segmentBounds);
  var rgbaByteCount = segmentBounds.area() * 4;
  if (this.usePenPressure) {
    if (compositeMode == "dodge") compositeMode = "burn";
    else compositeMode = "dodge"
  }
  var rangeIndex = this.toolOptions.rng;
  if (compositeMode == "dodge") {
    multiplyFactor = [1 - exposureStrength / 2, 1, 1 + exposureStrength][rangeIndex];
    gammaExponent = [1, 1 / (1 + exposureStrength), 1][rangeIndex];
    exposureOffset = [exposureStrength / 2, 0, 0][rangeIndex]
  }
  if (compositeMode == "burn") {
    multiplyFactor = [1 / (1 - exposureStrength / 2), 1, 1 - exposureStrength / 2][rangeIndex];
    gammaExponent = [1, 1 + exposureStrength, 1][rangeIndex];
    exposureOffset = [-(exposureStrength / 2) / (1 - exposureStrength / 2), 0, 0][rangeIndex]
  }
  var adjustedByValue = new Float64Array(256);
  for (var channelValue = 0; channelValue < 256; channelValue++) {
    adjustedByValue[channelValue] = exposureOffset + multiplyFactor * Math.pow(channelValue * (1 / 255), gammaExponent);
  }
  for (var pixelIndex = 0; pixelIndex < rgbaByteCount; pixelIndex += 4) {
    var brushAlpha = strokeRgbaBuffer[pixelIndex + 3];
    for (var channelOffset = 0; channelOffset < 3; channelOffset++) {
      var srcValue = destCompositeBuffer[pixelIndex + channelOffset],
        blendedChannel = Math.round(adjustedByValue[srcValue] * brushAlpha + srcValue * (1 / 255) * (255 - brushAlpha));
      destCompositeBuffer[pixelIndex + channelOffset] = Math.max(0, Math.min(255, blendedChannel))
    }
  }
};
PaintTool.applyBrushFlowOpacity = function(channelValue, multiplyFactor, gammaExponent, exposureOffset, brushAlpha) {
  var normalizedChannel = channelValue * (1 / 255),
    adjustedChannel = exposureOffset + multiplyFactor * Math.pow(normalizedChannel, gammaExponent),
    blendedChannel = Math.round(adjustedChannel * brushAlpha + normalizedChannel * (255 - brushAlpha));
  return Math.max(0, Math.min(255, blendedChannel))
};

PaintTool.copyCompositeToMask = function(rgbaBuffer, rect, maskTarget) {
  var grayChannelBuffer = allocBuffer(rect.area());
  rgbaToGrayChannel(rgbaBuffer, grayChannelBuffer);
  copyChannel(grayChannelBuffer, rect, maskTarget.channel, maskTarget.rect)
};

}

function installPaintSubclassPrototypes() {
PaintBucketTool.prototype.enable = function(doc, dispatcher, appData, keyboard) {
  dispatchCursorOverlay(dispatcher, "default");
};
PaintBucketTool.prototype.onUpdate = function(appData, popupType) {};
PaintBucketTool.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (this.forwardEyedropperIfAlt(keyboard, dispatcher, pointerState)) return;
  if (!doc.ensureLayerEditableForTools()) return;
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y),
    wandSelection = sampleSelectionAtPoint(doc, docPoint, this.toolOptions.wconf);
  if (wandSelection == null) return;
  var fillRgbaBuffer = allocBuffer(wandSelection.rect.area() * 4);
  fillBuffer(fillRgbaBuffer, (appData.colorInt & 255) << 16 | (appData.colorInt >> 8 & 255) << 8 | (appData.colorInt >> 16 & 255) << 0);
  extractChannel(wandSelection.channel, fillRgbaBuffer, 3);
  this.capturePaintSourceBuffers(doc);
  this.compositeStrokeToLayer(doc, "draw", fillRgbaBuffer, wandSelection.rect, wandSelection.rect);
  this.invalidatePaintDirtyRegion(doc, wandSelection.rect);
  this.finish(doc, wandSelection.rect)
};

BrushTool.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (this.forwardEyedropperIfAlt(keyboard, dispatcher, pointerState)) return;
  this.beginStroke(doc, appData, keyboard, pointerState, this.toolOptions.flow);
  if (this.strokeData == null) return;
  this.applyStroke(doc)
};
BrushTool.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.syncBrushScaleToZoom(doc, dispatcher, appData);
  if (this.rightDragAnchor) this.updateBrushSizeFromRightDrag(doc, appData, pointerState);
  if (this.strokeData == null) {
    this.refreshHoverCursor(doc, dispatcher, appData, keyboard, pointerState);
    return
  }
  if (!pointerState.isDown) return;
  this.continueStroke(doc, appData, keyboard, pointerState);
  this.applyStroke(doc)
};

PencilTool.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (this.forwardEyedropperIfAlt(keyboard, dispatcher, pointerState)) return;
  this.beginStroke(doc, appData, keyboard, pointerState, this.toolOptions.flow);
  if (this.strokeData == null) return;
  this.applyStroke(doc)
};
PencilTool.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.syncBrushScaleToZoom(doc, dispatcher, appData);
  if (this.rightDragAnchor) this.updateBrushSizeFromRightDrag(doc, appData, pointerState);
  if (this.strokeData == null) {
    this.refreshHoverCursor(doc, dispatcher, appData, keyboard, pointerState);
    return
  }
  if (!pointerState.isDown) return;
  this.continueStroke(doc, appData, keyboard, pointerState);
  this.applyStroke(doc)
};

EraserTool.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.beginStroke(doc, appData, keyboard, pointerState, this.toolOptions.flow);
  if (this.strokeData == null) return;
  this.applyStroke(doc)
};
EraserTool.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.syncBrushScaleToZoom(doc, dispatcher, appData);
  if (this.rightDragAnchor) this.updateBrushSizeFromRightDrag(doc, appData, pointerState);
  if (this.strokeData == null) {
    this.refreshHoverCursor(doc, dispatcher, appData, keyboard, pointerState);
    return
  }
  if (!pointerState.isDown) return;
  this.continueStroke(doc, appData, keyboard, pointerState);
  this.applyStroke(doc)
};

BackgroundEraserTool.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (this.forwardEyedropperIfAlt(keyboard, dispatcher, pointerState)) return;
  this.beginStroke(doc, appData, keyboard, pointerState, this.toolOptions.flow);
  if (this.strokeData == null) return;
  this.applyStroke(doc)
};
BackgroundEraserTool.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.syncBrushScaleToZoom(doc, dispatcher, appData);
  if (this.rightDragAnchor) this.updateBrushSizeFromRightDrag(doc, appData, pointerState);
  if (this.strokeData == null) {
    this.refreshHoverCursor(doc, dispatcher, appData, keyboard, pointerState);
    return
  }
  if (!pointerState.isDown) return;
  this.continueStroke(doc, appData, keyboard, pointerState);
  this.applyStroke(doc)
};
}

export function PaintBucketTool() {
  PaintTool.call(this, "tools.paintBucketTool", ToolId.TOOL_PAINT_BUCKET, "tools/pbucket")
};

export function BrushTool() {
  PaintTool.call(this, "tools.brushTool", ToolId.TOOL_BRUSH, "tools/brush");
  this.strokeCompositeMode = "draw"
};

export function PencilTool() {
  PaintTool.call(this, "tools.pencilTool", ToolId.TOOL_PENCIL, "tools/pencil");
  this.strokeCompositeMode = "draw"
};

export function EraserTool() {
  PaintTool.call(this, "tools.eraserTool", ToolId.TOOL_ERASER, "tools/eraser");
  this.strokeCompositeMode = "erase"
};

export function BackgroundEraserTool() {
  PaintTool.call(this, "tools.backgroundEraser", ToolId.TOOL_BACKGROUND_ERASER, "tools/beraser");
  this.strokeCompositeMode = "ierase"
};


export function GradientTool() {
  ToolBase.call(this, "tools.gradientTool", ToolId.TOOL_GRADIENT, "tools/gradient");
  this.toolOptions = createDefaultGradientToolOptions();
  this.isDraggingGradient = false;
  this.gradientStartPoint = null;
}

function installGradientToolPrototype() {
GradientTool.prototype.enable = function(doc, dispatcher, appData, keyboard) {
  dispatchCursorOverlay(dispatcher, "default");
};
GradientTool.prototype.applyAction = function(actionPayload) {
  this.toolOptions = actionPayload.toolOptions
};
GradientTool.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (!doc.ensureLayerEditableForTools()) return;
  this.gradientStartPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
  this.gradientStartPoint = snapPointToGuides(doc, this.gradientStartPoint, appData);
  this.isDraggingGradient = true
};
GradientTool.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (!this.isDraggingGradient) return;
  var dragEndPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
  dragEndPoint = snapPointToGuides(doc, dragEndPoint, appData);
  if (keyboard.isPressed(KeyboardHandler.Shift)) dragEndPoint = constrainEndpointToAxis(this.gradientStartPoint, dragEndPoint);
  doc.toolOverlayState.overlayTransform = {
    coords: [this.gradientStartPoint.x, this.gradientStartPoint.y, dragEndPoint.x, dragEndPoint.y],
    commands: ["M", "L"]
  };
  doc.toolOverlayState.squareMarkerCoords = [this.gradientStartPoint.x, this.gradientStartPoint.y, dragEndPoint.x, dragEndPoint.y];
  doc.dirty = true
};
GradientTool.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (!this.isDraggingGradient) return;
  var targetLayer = doc.layers[doc.selectedLayerIndices[0]],
    dragEndPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
  dragEndPoint = snapPointToGuides(doc, dragEndPoint, appData);
  if (keyboard.isPressed(KeyboardHandler.Shift)) dragEndPoint = constrainEndpointToAxis(this.gradientStartPoint, dragEndPoint);
  var gradientDelta = dragEndPoint.subtract(this.gradientStartPoint),
    gradientCenter = Point.lerp(this.gradientStartPoint, dragEndPoint, .5),
    gradientAngle = Math.atan2(gradientDelta.y, gradientDelta.x),
    gradientLength = Point.dist(this.gradientStartPoint, dragEndPoint),
    sinAngle = Math.sin(gradientAngle),
    cosAngle = Math.cos(gradientAngle);
  if (gradientLength > 2) {
    var fillRect;
    if (doc.selectionMask) fillRect = doc.selectionMask.rect;
    else fillRect = new Rect(0, 0, doc.width, doc.height);
    var pixelBuffer = allocBuffer(fillRect.area() * 4),
      options = this.toolOptions,
      gradientStyleKey = options.gradientStyle;
    if (gradientStyleKey != "Lnr") {
      gradientLength *= 2;
      gradientCenter = this.gradientStartPoint
    }
    applyGradient(options.gradientPreset, pixelBuffer, fillRect, [cosAngle * 1 / gradientLength, sinAngle * 1 / gradientLength, -sinAngle * 1 / gradientLength, cosAngle * 1 / gradientLength], gradientCenter.x, gradientCenter.y, options.reverseGradient, LayerEffectDefs.gradientTypeOptions.types.indexOf(gradientStyleKey), appData.colorInt, appData.bgColor, null, options.ditherGradient);
    var opacityByteScale = Math.round(options.opacity * 256),
      bufferByteLength = pixelBuffer.length;
    if (opacityByteScale != 256)
      for (var bufferIdx = 0; bufferIdx < bufferByteLength; bufferIdx += 4) pixelBuffer[bufferIdx + 3] = pixelBuffer[bufferIdx + 3] * opacityByteScale >>> 8;
    var fillActionEvent = new AppEvent(EventType.documentAction);
    fillActionEvent.routingChannel = ToolId.TOOL_ERASER;
    fillActionEvent.data = {
      actionKind: "fillBMP",
      fillPixels: pixelBuffer,
      fillBlendMode: options.gradientBlendMode,
      historyLabelKey: this.name
    };
    dispatcher.dispatch(fillActionEvent)
  }
  doc.toolOverlayState.overlayTransform = null;
  doc.toolOverlayState.squareMarkerCoords = [];
  doc.dirty = true;
  this.isDraggingGradient = false
};

GradientTool.renderGradientPreviewDataUrl = function(gradientDescriptor, width, height, angleRadians, foregroundColorInt, backgroundColorInt, canvasEl) {
  if (canvasEl == null) canvasEl = makeElement("canvas", "");
  var canvasCtx = canvasEl.getContext("2d");
  canvasEl.width = width;
  canvasEl.height = height;
  var previewRect = new Rect(0, 0, width, height),
    checkerboardBuffer = allocBuffer(width * height * 4);
  drawCheckerboard(checkerboardBuffer, width, height, 4);
  var sinAngle = Math.sin(angleRadians),
    cosAngle = Math.cos(angleRadians),
    gradientBuffer = allocBuffer(width * height * 4);
  applyGradient(gradientDescriptor, gradientBuffer, previewRect, [cosAngle * 1 / width, sinAngle * 1 / width, -sinAngle * 1 / height, cosAngle * 1 / height], width / 2, height / 2, false, 0, foregroundColorInt, backgroundColorInt);
  composite("norm", gradientBuffer, previewRect, checkerboardBuffer, previewRect, previewRect, 1);
  var imageData = canvasCtx.getImageData(0, 0, width, height);
  copyBuffer(checkerboardBuffer, imageData.data);
  canvasCtx.putImageData(imageData, 0, 0);
  return canvasEl.toDataURL()
};
GradientTool.resolveGradientPresetColors = function(gradientDescriptor, foregroundColorInt, backgroundColorInt) {
  var resolvedGradient = JSON.parse(JSON.stringify(gradientDescriptor));
  for (var stopIdx = 0; stopIdx < resolvedGradient.Clrs.v.length; stopIdx++) {
    var colorStop = resolvedGradient.Clrs.v[stopIdx].v,
      colorSourceKey = colorStop.Type.v.Clry;
    if (colorSourceKey == "UsrS") continue;
    var sourceColorInt = colorSourceKey == "FrgC" ? foregroundColorInt : backgroundColorInt;
    colorStop.Type.v.Clry = "UsrS";
    colorStop.Clr = {
      t: "Objc",
      v: toRGBDesc({
        h: sourceColorInt >> 16 & 255,
        l: sourceColorInt >> 8 & 255,
        O: sourceColorInt & 255
      })
    }
  }
  return resolvedGradient
};
}

// Chain each tool's prototype onto the base it extends. The bases are
// imported, so they are fully built by the time this runs.
PaintTool.prototype = Object.create(ToolBase.prototype);
installPaintToolPrototype();
GradientTool.prototype = Object.create(ToolBase.prototype);
installGradientToolPrototype();
PaintBucketTool.prototype = Object.create(PaintTool.prototype);
BrushTool.prototype = Object.create(PaintTool.prototype);
PencilTool.prototype = Object.create(PaintTool.prototype);
EraserTool.prototype = Object.create(PaintTool.prototype);
BackgroundEraserTool.prototype = Object.create(PaintTool.prototype);
installPaintSubclassPrototypes();

