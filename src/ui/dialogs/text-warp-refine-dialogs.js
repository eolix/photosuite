/**
 * Text warp and refine-edge / magic-cut selection dialogs.
 */

import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { Locale } from "../../core/i18n/locale.js";
import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { ToolId, EventChannel } from "../../document/model/tool-base.js";
import { BrushStroke } from "../../features/brush/brush-stroke.js";
import { Layer } from "../../document/model/layer.js";
import { BrushPresetUtil } from "../../features/brush/brush-presets.js";
import { PopupTypes } from "../config/popup-types.js";
import { BrushPickerButton } from "../widgets/controls/brush-preset-controls.js";
import { SliderDropdown } from "../widgets/controls/number-inputs.js";
import { DisplayOptions, PanelWrapper } from "../widgets/controls/panel-widgets.js";
import { Dropdown, IconRenderer } from "../widgets/controls/popup-controls.js";
import { Button } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { EventType } from "../../core/event-bus.js";
import { makeElement } from "../../core/dom.js";
import { showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";
import { PaintTool } from "../../document/tools/paint-tools.js";
import { SelectTool } from "../../document/tools/selection-tools.js";
import { allocBuffer, extractChannel, extractChannelByte, fillBuffer } from "../../engine/compositing/buffer-utils.js";
import { copyChannel, copyPixels } from "../../engine/compositing/pixel-ops.js";
import { composite } from "../../engine/compositing/compositing-ops.js";
import { computeDistanceField } from "../../engine/compositing/distance-field-stroke.js";
import { fill } from "../../engine/compositing/content-aware-fill.js";

function TextWarpDialog() {
  BaseDialog.call(this, "dialogs.warp", "textwarp");
  this.warpDisplayOptions = new DisplayOptions();
  this.warpDisplayOptions.on(EventType.widgetSelect, this.refresh, this);
  this.warpDisplayOptions.parent = this;
  this.formDiv = makeElement("div", "form");
  this.formDiv.setAttribute("style", "width:20em");
  this.body.appendChild(this.formDiv);
  this.formDiv.appendChild(this.warpDisplayOptions.warpStyleList.el);
  this.formDiv.appendChild(this.warpDisplayOptions.warpOrientationDropdown.el);
  this.formDiv.appendChild(this.warpDisplayOptions.warpBendControl.el);
  this.formDiv.appendChild(this.warpDisplayOptions.horizontalDistortionControl.el);
  this.formDiv.appendChild(this.warpDisplayOptions.verticalDistortionControl.el);
  this.okButton = new Button("clipboard.ok", true, null, true);
  this.okButton.on("click", this.onOK, this);
  this.formDiv.appendChild(this.okButton.el);
  this.on("closebtn", this.onCancel, this)
}
TextWarpDialog.prototype = Object.create(BaseDialog.prototype);
TextWarpDialog.prototype.constructor = TextWarpDialog;
TextWarpDialog.prototype.isActive = function() {
  return true
};
TextWarpDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.warpDisplayOptions.buildUI()
};
TextWarpDialog.prototype.refresh = function(widgetEvent) {
  const warpDescriptor = this.warpDisplayOptions.getValue();
  this.dispatchWarpAction({
    actionKind: "warp",
    warpMesh: warpDescriptor
  })
};
TextWarpDialog.prototype.dispatchWarpAction = function(warpActionPayload) {
  const docActionEvent = new AppEvent(EventType.documentAction, true);
  docActionEvent.routingChannel = ToolId.TOOL_TYPE;
  docActionEvent.data = warpActionPayload;
  docActionEvent.fromDialog = true;
  this.dispatch(docActionEvent)
};
TextWarpDialog.prototype.onCancel = function(clickEvent) {
  this.dispatchWarpAction({
    actionKind: "warpCancel"
  })
};
TextWarpDialog.prototype.onOK = function(clickEvent) {
  this.dispatchWarpAction({
    actionKind: "warpConfirm"
  });
  this.close()
};
TextWarpDialog.prototype.open = function(currentDoc, dialogPayload) {
  const textLayer = currentDoc.layers[currentDoc.selectedLayerIndices[0]];
  this.warpDisplayOptions.setValue(textLayer.add.TySh.warpDescriptor)
};


/** A computed-style length in pixels; 0 before the element has been laid out. */
function cssPixels(styleValue) {
  const parsed = parseFloat(styleValue);
  return isFinite(parsed) ? parsed : 0;
}

/** Gap between the two preview panes, and above them. Mirrors `.previewpair`. */
const PREVIEW_ROW_GAP_PX = 12;
/** Floor for a preview pane, so a short viewport still shows something. */
const MIN_PREVIEW_SIZE_PX = 120;
/** Toolbar height before the strip has been laid out. */
const TOOLBAR_FALLBACK_HEIGHT_PX = 34;

function RefineEdgeDialog() {
  BaseDialog.call(this, "select.refineEdge", "redge");
  this.lastLayoutSize = null;
  this.activePath = {};
  this.strokeData = null;
  this.hostDocument = null;
  this.targetDocument = null;
  this.activeKeyboardState = null;
  this.lastStrokePoint = null;
  this.maskUndoStacks = [];
  this.maskUndoIndex = -1;
  this.formDiv = makeElement("div", "form hbar");
  this.body.appendChild(this.formDiv);
  this.brushPickerButton = new BrushPickerButton();
  this.brushPickerButton.parent = this;
  this.brushPickerButton.on(EventType.widgetSelect, this.updateCursor, this);
  this.formDiv.appendChild(this.brushPickerButton.el);
  const toolIconPaths = ["#ffffff", "#888888", "#000000"]
    .concat(getIconUrl("tools/hand"), getIconUrl("zoomIn"), getIconUrl("zoomOut"));
  const toolIconLabels = ["properties.foreground", "properties.unknown", "properties.background"];
  this.toolModeIconBar = new IconRenderer(null, toolIconPaths, toolIconLabels, 28);
  this.toolModeIconBar.on(EventType.widgetSelect, this.onKeyEvent, this);
  this.formDiv.appendChild(this.toolModeIconBar.el);
  this.borderWidthSlider = new SliderDropdown("select.border", 0, 50, null);
  this.borderWidthSlider.parent = this;
  this.borderWidthSlider.on(EventType.widgetSelect, this.rebuildTriMapFromSelection, this);
  this.formDiv.appendChild(this.borderWidthSlider.el);
  const clearMaskBtn = this.clearMaskButton = new Button("edit.clear", false, null, true);
  clearMaskBtn.on("click", this.onClearMaskClicked, this);
  this.formDiv.appendChild(clearMaskBtn.el);
  const helpBtn = this.helpButton = new Button("properties.help", false, null, true);
  helpBtn.on("click", function() {
    showToast(Locale.get("brushAndMessages.toolHints.triMapGuide"))
  }, this);
  this.formDiv.appendChild(helpBtn.el);
  // Output controls close the toolbar; the strip pushes this group to its far
  // edge, so it stays on the row instead of overlapping the previews below.
  const rightControlsSpan = makeElement("span", "form");
  this.formDiv.appendChild(rightControlsSpan);
  this.previewBackgroundIconBar = new IconRenderer("properties.background", ["checker", "#ffffff", "#000000"]);
  this.previewBackgroundIconBar.on(EventType.widgetSelect, this.refreshOutputPreviewPanel, this);
  rightControlsSpan.appendChild(this.previewBackgroundIconBar.el);
  this.outputTargetDropdown = new Dropdown(null, [
    "layer.newLayer",
    "layer.rasterMask",
    "sampleScope.selection"
  ]);
  rightControlsSpan.appendChild(this.outputTargetDropdown.el);
  this.okButton = new Button("clipboard.ok", false, null, true);
  this.okButton.on("click", this.onOK, this);
  rightControlsSpan.appendChild(this.okButton.el);
  const previewRowDiv = makeElement("div", "flexrow previewpair");
  this.body.appendChild(previewRowDiv);
  this.leftPreviewPanel = new PanelWrapper(true);
  this.rightPreviewPanel = new PanelWrapper();
  this.leftPreviewPanel.linkViewSync(this.rightPreviewPanel);
  this.rightPreviewPanel.linkViewSync(this.leftPreviewPanel);
  this.leftPreviewPanel.on("mousedown", this.onDragStart, this);
  this.leftPreviewPanel.on("mousemove", this.onDrag, this);
  this.leftPreviewPanel.on("mouseup", this.onDragEnd, this);
  this.leftPreviewPanel.on("zoom", this.updateCursor, this);
  this.rightPreviewPanel.on("zoom", this.updateCursor, this);
  previewRowDiv.appendChild(this.leftPreviewPanel.el);
  previewRowDiv.appendChild(this.rightPreviewPanel.el)
}
RefineEdgeDialog.prototype = Object.create(BaseDialog.prototype);
RefineEdgeDialog.prototype.constructor = RefineEdgeDialog;
RefineEdgeDialog.prototype.canOpen = function(currentDoc, dialogPayload) {
  const layerHasContent = currentDoc != null && !currentDoc.layers[currentDoc.selectedLayerIndices[0]].rect.isEmpty();
  if (!layerHasContent) showToast(Locale.get("dialogs.layerEmpty"));
  return layerHasContent;
};
RefineEdgeDialog.prototype.getOffset = function() {
  return new Point(0, 0);
};
RefineEdgeDialog.prototype.isActive = function() {
  return true
};
/**
 * The two previews share whatever the toolbar leaves. Both the toolbar height
 * and the body's padding are measured rather than assumed, so the dialog keeps
 * fitting the viewport when either changes.
 */
RefineEdgeDialog.prototype.resize = function(dialogWidth, dialogHeight) {
  // Kept so open() can size the previews again once the toolbar is built and
  // its height is final; the first layout runs before that.
  this.lastLayoutSize = { width: dialogWidth, height: dialogHeight };
  const bodyStyle = getComputedStyle(this.body);
  const windowStyle = getComputedStyle(this.el);
  const chromeV = cssPixels(bodyStyle.paddingTop) + cssPixels(bodyStyle.paddingBottom)
    + cssPixels(windowStyle.borderTopWidth) + cssPixels(windowStyle.borderBottomWidth);
  const chromeH = cssPixels(bodyStyle.paddingLeft) + cssPixels(bodyStyle.paddingRight)
    + cssPixels(windowStyle.borderLeftWidth) + cssPixels(windowStyle.borderRightWidth);
  const toolbarHeight = this.formDiv.offsetHeight || TOOLBAR_FALLBACK_HEIGHT_PX;
  const previewHeight = Math.max(
    MIN_PREVIEW_SIZE_PX,
    Math.floor(dialogHeight - chromeV - toolbarHeight - PREVIEW_ROW_GAP_PX)
  );
  const previewWidth = Math.max(
    MIN_PREVIEW_SIZE_PX,
    Math.floor((dialogWidth - chromeH - PREVIEW_ROW_GAP_PX) / 2)
  );
  this.leftPreviewPanel.resize(previewWidth, previewHeight);
  this.rightPreviewPanel.resize(previewWidth, previewHeight)
};
RefineEdgeDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.brushPickerButton.buildUI();
  this.borderWidthSlider.buildUI();
  this.okButton.buildUI();
  this.previewBackgroundIconBar.buildUI();
  this.outputTargetDropdown.buildUI();
  this.clearMaskButton.buildUI();
  this.helpButton.buildUI()
};
RefineEdgeDialog.prototype.noopPointerHandler = function(pointerEvent) {
  return
};
RefineEdgeDialog.prototype.onUpdate = function(appData, popupType) {
  this.hostDocument = appData;
  if (popupType == PopupTypes.BRUSHES || popupType == PopupTypes.ALL) {
    this.brushPickerButton.setPresets(appData.brushPresets);
    this.brushPickerButton.setValue(BrushPresetUtil.getDefaultBrushDescriptor(), appData.brushPresets.samples, appData.brushPresets.patterns)
  }
};
RefineEdgeDialog.prototype.onKeyEvent = function(doc, view, appData, keyboard) {
  const toolModeIndex = this.toolModeIconBar.getValue();
  if (keyboard == null) {
    keyboard = new KeyboardHandler();
    if (toolModeIndex >= 3) keyboard.onKeyDown("Space");
    if (toolModeIndex >= 4) {
      keyboard.onKeyDown("ControlLeft");
      if (toolModeIndex == 5) keyboard.onKeyDown("AltLeft")
    }
    this.leftPreviewPanel.onKeyEvent(keyboard);
    return
  }
  this.activeKeyboardState = keyboard;
  const adjustedBrush = PaintTool.adjustBrushSizeFromKeys(this.brushPickerButton.getValue(), keyboard);
  if (adjustedBrush != null) {
    this.brushPickerButton.setValue(adjustedBrush);
    this.updateCursor()
  } else if (keyboard.isPressed(KeyboardHandler.Ctrl) && keyboard.isPressed(KeyboardHandler.Keydoc)) {
    const undoStacks = this.maskUndoStacks;
    let undoDirection = 0;
    if (keyboard.isPressed(KeyboardHandler.Shift)) {
      if (this.maskUndoIndex + 1 < undoStacks.length) undoDirection = 1
    } else if (this.maskUndoIndex > 0) undoDirection = -1;
    if (undoDirection != 0) {
      this.maskUndoIndex += undoDirection;
      const targetUndoIndex = this.maskUndoIndex,
        workingPath = this.activePath;
      if (undoDirection == 1) copyPixels(undoStacks[targetUndoIndex][2], undoStacks[targetUndoIndex][0], workingPath.trimapRgba, workingPath.rect);
      else copyPixels(undoStacks[targetUndoIndex + 1][1], undoStacks[targetUndoIndex + 1][0], workingPath.trimapRgba, workingPath.rect);
      workingPath.brushCompositeRect = workingPath.rect;
      this.redraw()
    }
  } else if (toolModeIndex < 3) this.leftPreviewPanel.onKeyEvent(keyboard)
};
RefineEdgeDialog.prototype.pushMaskUndoSnapshot = function(dirtyRect) {
  const workingPath = this.activePath,
    beforeSnapshot = allocBuffer(dirtyRect.area() * 4);
  let undoStacks = this.maskUndoStacks;
  copyPixels(workingPath.trimapUndoSnapshot, workingPath.rect, beforeSnapshot, dirtyRect);
  workingPath.trimapUndoSnapshot = null;
  const afterSnapshot = allocBuffer(dirtyRect.area() * 4);
  copyPixels(workingPath.trimapRgba, workingPath.rect, afterSnapshot, dirtyRect);
  this.maskUndoIndex++;
  undoStacks[this.maskUndoIndex] = [dirtyRect.clone(), beforeSnapshot, afterSnapshot];
  while (undoStacks.length > this.maskUndoIndex + 1) undoStacks.pop();
  while (undoStacks.length > 50) {
    undoStacks = undoStacks.slice(1);
    this.maskUndoIndex--
  }
};
RefineEdgeDialog.prototype.updateCursor = function() {
  const hostDoc = this.hostDocument,
    cursorGlyph = BrushStroke.createCursorGlyph(this.brushPickerButton.getValue(), hostDoc.brushPresets.samples, this.leftPreviewPanel.getViewTransform().zoomScale);
  this.leftPreviewPanel.setDefaultCursor(cursorGlyph)
};
RefineEdgeDialog.prototype.onDragStart = function(pointerEvent) {
  const hostDoc = this.hostDocument,
    workingPath = this.activePath,
    keyboard = this.activeKeyboardState,
    brushDescriptor = this.brushPickerButton.getValue(),
    docPoint = this.leftPreviewPanel.pointerToDocPoint(),
    strokeColor = [16777215, 8421504, 0][this.toolModeIconBar.getValue()];
  this.strokeData = new BrushStroke(brushDescriptor, hostDoc.brushPresets.list[0].samples, hostDoc.brushPresets.list[0].patterns, {
    opacity: 1,
    pixelSnap: true
  }, strokeColor, hostDoc.bgColor, workingPath.rect);
  workingPath.trimapUndoSnapshot = workingPath.trimapRgba.slice(0);
  if (keyboard != null && keyboard.isPressed(KeyboardHandler.Shift) && this.lastStrokePoint) {
    this.strokeData.moveTo(this.lastStrokePoint.x, this.lastStrokePoint.y);
    this.strokeData.lineTo(docPoint.x, docPoint.y)
  } else this.strokeData.moveTo(docPoint.x, docPoint.y);
  this.applyStrokeToWorkingMask()
};
RefineEdgeDialog.prototype.onDrag = function(pointerEvent) {
  const workingPath = this.activePath,
    docPoint = this.leftPreviewPanel.pointerToDocPoint();
  this.strokeData.lineTo(docPoint.x, docPoint.y);
  this.applyStrokeToWorkingMask()
};
RefineEdgeDialog.prototype.onDragEnd = function(pointerEvent) {
  this.lastStrokePoint = this.leftPreviewPanel.pointerToDocPoint();
  this.pushMaskUndoSnapshot(this.strokeData.getDirtyBounds());
  this.redraw()
};
RefineEdgeDialog.prototype.applyStrokeToWorkingMask = function() {
  const workingPath = this.activePath,
    stroke = this.strokeData,
    dirtyRect = stroke.getSegmentBounds();
  if (dirtyRect.isEmpty()) return;
  workingPath.brushCompositeRect = dirtyRect;
  composite("norm", stroke.getBuffer(), stroke.getSelectionRect(), workingPath.trimapRgba, workingPath.rect, dirtyRect, 1);
  this.compositeStrokeOverlayIntoPreview()
};
RefineEdgeDialog.prototype.onClearMaskClicked = function(clickEvent) {
  const workingPath = this.activePath;
  workingPath.trimapUndoSnapshot = workingPath.trimapRgba.slice(0);
  workingPath.brushCompositeRect = workingPath.rect;
  fillBuffer(workingPath.trimapRgba, 4278190080);
  this.pushMaskUndoSnapshot(workingPath.rect);
  this.redraw()
};
RefineEdgeDialog.prototype.open = function(currentDoc, dialogPayload) {
  this.targetDocument = currentDoc;
  if (this.lastLayoutSize) this.resize(this.lastLayoutSize.width, this.lastLayoutSize.height);
  const sourceLayer = currentDoc.layers[currentDoc.selectedLayerIndices[0]],
    layerRect = sourceLayer.rect.clone(),
    layerWidth = layerRect.width,
    layerHeight = layerRect.height;
  this.borderWidthSlider.setValue(3);
  this.toolModeIconBar.setValue(currentDoc.selectionMask == null ? 0 : 1);
  this.borderWidthSlider.disable();
  if (currentDoc.selectionMask != null) this.borderWidthSlider.enable();
  const maskChannel = allocBuffer(layerRect.area()),
    distanceField = new Float32Array(layerRect.area());
  if (currentDoc.selectionMask) {
    copyChannel(currentDoc.selectionMask.channel, currentDoc.selectionMask.rect, maskChannel, layerRect);
    const edgeMask = allocBuffer(layerRect.area());
    for (let row = 0; row < layerHeight; row++)
      for (let col = 0; col < layerWidth; col++) {
        const flatIndex = row * layerWidth + col,
          maskValue = maskChannel[flatIndex];
        if (col > 0 && maskChannel[flatIndex - 1] != maskValue || col < layerWidth - 1 && maskChannel[flatIndex + 1] != maskValue || row > 0 && maskChannel[flatIndex - layerWidth] != maskValue || row < layerHeight - 1 && maskChannel[flatIndex + layerWidth] != maskValue) edgeMask[flatIndex] = 255
      }
    computeDistanceField(edgeMask, distanceField, layerWidth, layerHeight)
  } else distanceField.fill(1e9);
  layerRect.x = layerRect.y = 0;
  this.activePath = {
    rect: layerRect,
    layerRgbaBuffer: sourceLayer.buffer,
    sourceMaskChannel: maskChannel,
    borderDistanceField: distanceField,
    leftPreviewRgba: allocBuffer(layerRect.area() * 4),
    rightPreviewRgba: allocBuffer(layerRect.area() * 4),
    trimapRgba: allocBuffer(layerRect.area() * 4),
    trimapUndoSnapshot: null,
    refinedOutputRgba: null,
    brushCompositeRect: layerRect
  };
  this.rebuildTriMapFromSelection();
  this.maskUndoStacks = [1];
  this.maskUndoIndex = 0;
  this.leftPreviewPanel.fitToBounds();
  const brushDescriptor = this.brushPickerButton.getValue();
  brushDescriptor.Brsh.v.diameter.v.val = Math.round(layerRect.width / 10);
  this.brushPickerButton.setValue(brushDescriptor);
  this.updateCursor()
};
RefineEdgeDialog.prototype.rebuildTriMapFromSelection = function() {
  const workingPath = this.activePath,
    pixelCount = workingPath.rect.area(),
    borderWidth = this.borderWidthSlider.getValue(),
    workingMask = workingPath.sourceMaskChannel.slice(0);
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++)
    if (workingPath.borderDistanceField[pixelIdx] < borderWidth) workingMask[pixelIdx] = 128;
  fillBuffer(workingPath.trimapRgba, 4294967295);
  extractChannel(workingMask, workingPath.trimapRgba, 0);
  extractChannel(workingMask, workingPath.trimapRgba, 1);
  extractChannel(workingMask, workingPath.trimapRgba, 2);
  workingPath.brushCompositeRect = workingPath.rect;
  this.redraw()
};
RefineEdgeDialog.prototype.redraw = function() {
  const workingPath = this.activePath;
  let refinedBuffer, blackCount = 0,
    whiteCount = 0,
    grayCount = 0;
  this.compositeStrokeOverlayIntoPreview();
  const workRect = workingPath.rect,
    width = workRect.width,
    height = workRect.height,
    trimapChannel = allocBuffer(workRect.area()),
    layerBuffer = workingPath.layerRgbaBuffer;
  extractChannelByte(workingPath.trimapRgba, trimapChannel, 0);
  for (let pixelIdx = 0; pixelIdx < trimapChannel.length; pixelIdx++) {
    if (layerBuffer[(pixelIdx << 2) + 3] != 255) continue;
    const trimapValue = trimapChannel[pixelIdx];
    if (trimapValue == 0) blackCount++;
    else if (trimapValue == 255) whiteCount++;
    else grayCount++
  }
  if (blackCount * whiteCount * grayCount != 0) {
    refinedBuffer = fill(workRect, layerBuffer, trimapChannel);
  } else {
    refinedBuffer = layerBuffer.slice(0);
    extractChannel(trimapChannel, refinedBuffer, 3)
  }
  for (let pixelIdx = 3; pixelIdx < refinedBuffer.length; pixelIdx += 4)
    if (refinedBuffer[pixelIdx] > layerBuffer[pixelIdx]) refinedBuffer[pixelIdx] = layerBuffer[pixelIdx];
  if (workRect.equals(workingPath.rect)) workingPath.refinedOutputRgba = refinedBuffer;
  else copyPixels(refinedBuffer, workRect, workingPath.refinedOutputRgba, workingPath.rect);
  this.refreshOutputPreviewPanel()
};
RefineEdgeDialog.prototype.compositeStrokeOverlayIntoPreview = function(unusedEvent) {
  const workingPath = this.activePath,
    compositeRect = workingPath.brushCompositeRect;
  copyPixels(workingPath.layerRgbaBuffer, workingPath.rect, workingPath.leftPreviewRgba, workingPath.rect, compositeRect);
  let trimapSource = workingPath.trimapRgba;
  composite("norm", trimapSource, workingPath.rect, workingPath.leftPreviewRgba, workingPath.rect, compositeRect, .3);
  this.leftPreviewPanel.setValue([{
    rect: workingPath.rect,
    data: workingPath.leftPreviewRgba.buffer
  }])
};
RefineEdgeDialog.prototype.refreshOutputPreviewPanel = function(widgetEvent) {
  const workingPath = this.activePath;
  fillBuffer(workingPath.rightPreviewRgba, [0, 4294967295, 4278190080][this.previewBackgroundIconBar.getValue()]);
  composite("norm", workingPath.refinedOutputRgba, workingPath.rect, workingPath.rightPreviewRgba, workingPath.rect, workingPath.rect, 1);
  this.rightPreviewPanel.setValue([{
    rect: workingPath.rect,
    data: workingPath.rightPreviewRgba.buffer
  }])
};
RefineEdgeDialog.prototype.onOK = function(clickEvent) {
  const targetDoc = this.targetDocument,
    workingPath = this.activePath,
    outputTarget = this.outputTargetDropdown.getValue(),
    activeLayer = targetDoc.layers[targetDoc.selectedLayerIndices[0]],
    docActionEvent = new AppEvent(EventType.documentAction, true);
  docActionEvent.fromDialog = true;
  const outputRect = activeLayer.rect.clone();
  if (outputTarget == 0 && activeLayer.isVisible() || outputTarget != 0 && !activeLayer.isVisible()) {
    docActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
    docActionEvent.data = {
      actionKind: Layer.toggleVisibility,
      layerIndex: targetDoc.selectedLayerIndices[0]
    };
    this.dispatch(docActionEvent)
  }
  if (targetDoc.selectionMask != null) {
    docActionEvent.routingChannel = ToolId.TOOL_RECT_SELECT;
    docActionEvent.data = {
      actionKind: "fromAction",
      scriptActionPayload: SelectTool.buildSelectAllAction()
    };
    this.dispatch(docActionEvent)
  }
  if (outputTarget == 0) {
    const layerStack = targetDoc.layers.slice(0),
      newLayer = targetDoc.newLayer();
    newLayer.setName(activeLayer.getName());
    layerStack.splice(targetDoc.selectedLayerIndices[0] + 1, 0, newLayer);
    newLayer.rect = outputRect;
    newLayer.buffer = workingPath.refinedOutputRgba;
    newLayer.markDirty();
    docActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
    docActionEvent.data = {
      actionKind: Layer.replaceLayerStack,
      layersAfter: layerStack,
      selectedLayerIndices: [targetDoc.selectedLayerIndices[0] + 1],
      historyLabelKey: "select.refineEdge"
    };
    this.dispatch(docActionEvent)
  }
  if (outputTarget == 1) {
    const existingMask = activeLayer.getMask();
    docActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
    docActionEvent.data = {
      actionKind: Layer.addRasterMask,
      forceNewMask: true
    };
    this.dispatch(docActionEvent);
    const rasterMask = activeLayer.getMask();
    rasterMask.channel = allocBuffer(outputRect.area());
    rasterMask.rect = outputRect;
    rasterMask.color = 0;
    rasterMask.maskCombineDirty = true;
    extractChannelByte(workingPath.refinedOutputRgba, rasterMask.channel, 3);
    if (existingMask) {
      const combinedMask = rasterMask.combineWith(existingMask);
      rasterMask.rect = combinedMask.rect;
      rasterMask.channel = combinedMask.channel;
      rasterMask.color = combinedMask.color
    }
    rasterMask.trimToContent();
    activeLayer.invalidate()
  }
  if (outputTarget == 2) {
    const selectionMask = {
      rect: outputRect,
      channel: allocBuffer(outputRect.area())
    };
    extractChannelByte(workingPath.refinedOutputRgba, selectionMask.channel, 3);
    docActionEvent.routingChannel = ToolId.TOOL_RECT_SELECT;
    docActionEvent.data = {
      actionKind: "setsel",
      selectionMask: selectionMask,
      historyLabelKey: this.titleLocaleKey
    };
    this.dispatch(docActionEvent)
  }
  this.close()
};

export { TextWarpDialog, RefineEdgeDialog };
