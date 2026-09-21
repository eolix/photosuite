/**
 * Plugin document canvas panel: pointer and gesture input, open resize refresh,
 * and redraw orchestration. Composite and overlay drawing live in sibling modules.
 */

import { Point } from "../../core/math/point.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";

import { LayerSystem } from "../../engine/layer-system.js";

import { BaseTool } from "../widgets/base-tool.js";
import { installPluginToolComposite } from "./plugin-tool-composite.js";
import { installPluginToolOverlays } from "./plugin-tool-overlays.js";
import { EventType } from "../../core/event-bus.js";
import { addPointerDownListener, addPointerMoveListener, addPointerUpListener, cancel, disableTouchGestures, getDevicePixelRatio, getEventPos, isInDOM, removePointerMoveListener, removePointerUpListener, resizeCanvasForDevicePixelRatio } from "../../core/dom.js";
import { buildUnsavedCloseMessage, confirmUnsavedClose, promptUnsavedCloseForClose } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";
import { ZoomTool } from "../../document/tools/view-tools.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { drawCheckerboard } from "../../engine/compositing/color-math.js";
import { patternFromImageData } from "../../engine/compositing/pixel-ops.js";

function PluginToolPanel(pluginDocument) {
  BaseTool.call(this, pluginDocument.name, true);
  this.pluginDocument = pluginDocument;
  this.appData = null;
  this.activePointers = [];
  this.multiTouchActive = false;
  this.lastPointerState = {
    x: 0,
    y: 0,
    isDown: false
  };
  this.overlayCanvas = document.createElement("canvas");
  this.overlayCanvasCtx = this.overlayCanvas.getContext("2d");
  this.canvasEl = document.createElement("canvas");
  this.mainCanvasCtx = this.canvasEl.getContext("2d");
  this.checkerboardPattern = createCheckerboardPattern();
  this.pointerDownBound = this.onDragStart.bind(this);
  this.pointerMoveBound = this.onDrag.bind(this);
  this.pointerUpBound = this.onDragEnd.bind(this);
  attachPanelPointerListeners(this);
  this.cachedZoomScale = 0;
  this.cachedChannelMatrixJson = "";
  this.cachedWebglEnabled = 4;
  disableTouchGestures(this.panelBody)
}
PluginToolPanel.prototype = Object.create(BaseTool.prototype);
installPluginToolComposite(PluginToolPanel);
installPluginToolOverlays(PluginToolPanel);

function createCheckerboardPattern() {
  const checkerboardTilePx = 16,
    checkerboardPixels = allocBuffer(16 * 16 * 4);
  drawCheckerboard(checkerboardPixels, checkerboardTilePx, checkerboardTilePx, 8);
  return patternFromImageData(checkerboardPixels, checkerboardTilePx, checkerboardTilePx)
}

function attachPanelPointerListeners(panel) {
  const panelBodyEl = panel.panelBody;
  addPointerDownListener(panelBodyEl, panel.pointerDownBound);
  addPointerMoveListener(panelBodyEl, panel.pointerMoveBound);
  panelBodyEl.addEventListener("wheel", panel.onWheel.bind(panel), false);
  panelBodyEl.addEventListener("contextmenu", panel.onContextMenuSyntheticClick.bind(panel), false);
  const gestureHandlerBound = panel.onGestureEvent.bind(panel);
  panelBodyEl.addEventListener("gesturestart", gestureHandlerBound, false);
  panelBodyEl.addEventListener("gesturechange", gestureHandlerBound, false);
  panelBodyEl.addEventListener("gestureend", gestureHandlerBound, false)
}

PluginToolPanel.prototype.onGestureEvent = function(gestureEvt) {
  if (gestureEvt.type == "gesturestart") this.gestureBaselineScale = gestureEvt.scale;
  if (gestureEvt.type == "gesturechange") {
    const scrollEvt = new AppEvent("mouse", true);
    scrollEvt.action = "scroll";
    scrollEvt.wheelActsAsPinch = true;
    this.assignPointerStateToMouseEvent(gestureEvt, scrollEvt);
    const scaleDeltaRatio = (this.gestureBaselineScale - gestureEvt.scale) / this.gestureBaselineScale;
    scrollEvt.scrollDelta = new Point(0, 100 * scaleDeltaRatio);
    this.gestureBaselineScale = gestureEvt.scale;
    this.dispatch(scrollEvt)
  }
};
PluginToolPanel.prototype.canClose = function() {
  if (!this.pluginDocument.isModified()) return true;
  return confirmUnsavedClose(buildUnsavedCloseMessage(this.pluginDocument))
};
PluginToolPanel.prototype.dispatchCloseTab = function() {
  const closeEvt = new AppEvent(EventType.layerEffectsFlush, false);
  closeEvt.data = {
    docTabIndex: this.parent.panels.indexOf(this)
  };
  this.dispatch(closeEvt)
};
PluginToolPanel.prototype.closePanel = function(evt) {
  if (evt.stopPropagation) evt.stopPropagation();
  const panel = this;
  promptUnsavedCloseForClose(this.pluginDocument, function(confirmed) {
    if (confirmed) panel.dispatchCloseTab()
  })
};
PluginToolPanel.prototype.preventWheelDefault = function(wheelEvt) {
  wheelEvt.preventDefault()
};
PluginToolPanel.prototype.indexOfActivePointer = function(pointerEvt) {
  const activeList = this.activePointers;
  let pointerIndex = -1;
  for (let listIdx = 0; listIdx < activeList.length; listIdx++)
    if (activeList[listIdx].pointerId == pointerEvt.pointerId) pointerIndex = listIdx;
  return pointerIndex
};
PluginToolPanel.shouldIgnoreTouchWhenNoTouch = function(pointerEvt) {
  const pointerType = pointerEvt.pointerType,
    keyboard = window.__kb;
  return pointerType == "touch" && keyboard.isPressed(KeyboardHandler.NoTouch);
};
PluginToolPanel.prototype.onDragStart = function(pointerEvt) {
  if (PluginToolPanel.shouldIgnoreTouchWhenNoTouch(pointerEvt)) return;
  const pointerIndex = this.indexOfActivePointer(pointerEvt);
  if (pointerIndex != -1) this.activePointers[pointerIndex] = pointerEvt;
  else this.activePointers.push(pointerEvt);
  if (this.activePointers.length == 1) {
    const downAction = pointerEvt.button != null && pointerEvt.button != 0 ? "rdown" : "down",
      mouseEvt = new AppEvent("mouse", true);
    mouseEvt.action = downAction;
    this.assignPointerStateToMouseEvent(pointerEvt, mouseEvt);
    this.dispatch(mouseEvt);
    removePointerMoveListener(this.panelBody, this.pointerMoveBound);
    addPointerMoveListener(window, this.pointerMoveBound);
    addPointerUpListener(window, this.pointerUpBound)
  }
  if (this.activePointers.length == 2) {
    this.dispatchMultiTouchMouseEvent("multidown");
    this.multiTouchActive = true
  }
};
PluginToolPanel.prototype.onDrag = function(pointerEvt) {
  if (PluginToolPanel.shouldIgnoreTouchWhenNoTouch(pointerEvt)) return;
  const pointerIndex = this.indexOfActivePointer(pointerEvt);
  if (pointerIndex != -1) this.activePointers[pointerIndex] = pointerEvt;
  if (this.activePointers.length > 1) {
    this.dispatchMultiTouchMouseEvent("multimove")
  }
  if (this.multiTouchActive) return;
  const mouseEvt = new AppEvent("mouse", true);
  mouseEvt.action = "move";
  this.assignPointerStateToMouseEvent(pointerEvt, mouseEvt);
  this.dispatch(mouseEvt);
  if (this.appData && this.appData.rulers && !this.lastPointerState.isDown) this.redraw()
};
PluginToolPanel.prototype.onDragEnd = function(pointerEvt) {
  if (PluginToolPanel.shouldIgnoreTouchWhenNoTouch(pointerEvt)) return;
  const activeList = this.activePointers,
    pointerIndex = this.indexOfActivePointer(pointerEvt);
  activeList.splice(pointerIndex, 1);
  if (activeList.length == 0) {
    const upAction = pointerEvt.button != null && pointerEvt.button > 0 ? "rup" : "up",
      mouseEvt = new AppEvent("mouse", true);
    mouseEvt.action = upAction;
    this.assignPointerStateToMouseEvent(pointerEvt, mouseEvt);
    this.dispatch(mouseEvt);
    removePointerMoveListener(window, this.pointerMoveBound);
    removePointerUpListener(window, this.pointerUpBound);
    addPointerMoveListener(this.panelBody, this.pointerMoveBound);
    this.multiTouchActive = false
  }
};
PluginToolPanel.prototype.onWheel = function(wheelEvt) {
  this.preventWheelDefault(wheelEvt);
  if (wheelEvt.deltaX == 0 && wheelEvt.deltaY == 0) return;
  const mouseEvt = new AppEvent("mouse", true);
  mouseEvt.action = "scroll";
  mouseEvt.wheelActsAsPinch = wheelEvt.ctrlKey;
  this.assignPointerStateToMouseEvent(wheelEvt, mouseEvt);
  this.dispatch(mouseEvt)
};
PluginToolPanel.prototype.onContextMenuSyntheticClick = function(menuEvt) {
  cancel(menuEvt);
  let sourceCaps = menuEvt.sourceCapabilities;
  if (sourceCaps) sourceCaps = sourceCaps.firesTouchEvents;
  if (sourceCaps) {
    const mouseEvt = new AppEvent("mouse", true);
    this.assignPointerStateToMouseEvent(menuEvt, mouseEvt);
    mouseEvt.action = "rdown";
    this.dispatch(mouseEvt);
    mouseEvt.action = "rup";
    this.dispatch(mouseEvt)
  }
};
PluginToolPanel.prototype.dispatchMultiTouchMouseEvent = function(actionName) {
  const activeList = this.activePointers,
    devicePixelRatio = getDevicePixelRatio(),
    touchPositions = [];
  for (let pointerIdx = 0; pointerIdx < activeList.length; pointerIdx++) {
    const touchPos = touchPositions[pointerIdx] = getEventPos(activeList[pointerIdx], this.panelBody);
    touchPos.x *= devicePixelRatio;
    touchPos.y *= devicePixelRatio
  }
  const mouseEvt = new AppEvent("mouse", true);
  mouseEvt.action = actionName;
  mouseEvt.touchPoints = touchPositions;
  this.dispatch(mouseEvt)
};
PluginToolPanel.prototype.assignPointerStateToMouseEvent = function(sourceEvt, mouseEvt, panelPos) {
  const anyPointerDown = this.activePointers.length != 0;
  if (mouseEvt.action != "up") {
    const devicePixelRatio = getDevicePixelRatio();
    if (panelPos == null) panelPos = getEventPos(sourceEvt, this.panelBody);
    this.lastPointerState = mouseEvt.pointerState = {
      x: devicePixelRatio * panelPos.x,
      y: devicePixelRatio * panelPos.y,
      isDown: anyPointerDown
    };
    const bodyPos = getEventPos(sourceEvt, document.body);
    mouseEvt.pointerState.screenX = bodyPos.x;
    mouseEvt.pointerState.screenY = bodyPos.y
  } else this.lastPointerState = mouseEvt.pointerState = {
    x: this.lastPointerState.x,
    y: this.lastPointerState.y,
    isDown: anyPointerDown
  };
  mouseEvt.pointerState.pressure = .5;
  if (sourceEvt.pressure != null && sourceEvt.pressure != 0) mouseEvt.pointerState.pressure = sourceEvt.pressure;
  if (sourceEvt.pointerType == "mouse") mouseEvt.pointerState.pressure *= 2;
  if (sourceEvt.deltaX != null) {
    const wheelLineScale = sourceEvt.deltaMode == 0 ? 1 : 40;
    mouseEvt.scrollDelta = new Point(sourceEvt.deltaX * wheelLineScale, sourceEvt.deltaY * wheelLineScale)
  }
};
PluginToolPanel.prototype.onUpdate = function(appData, popupType) {
  this.appData = appData
};
PluginToolPanel.prototype.open = function(unusedDoc) {
  this.refresh();
  this.redraw()
};
PluginToolPanel.prototype.resize = function(width, height) {
  if (width <= 0 || height <= 0) return;
  this.labelLayoutWidthPx = width;
  this.panelWidthPx = width;
  this.panelHeightPx = height;
  const pluginDocument = this.pluginDocument,
    devicePixelRatio = getDevicePixelRatio();
  pluginDocument.pathViewport.viewportRect.width = Math.floor(width * devicePixelRatio);
  pluginDocument.pathViewport.viewportRect.height = Math.floor(height * devicePixelRatio);
  resizeCanvasForDevicePixelRatio(this.canvasEl, width, height);
  resizeCanvasForDevicePixelRatio(this.overlayCanvas, width, height);
  resizeCanvasForDevicePixelRatio(LayerSystem.getOffscreenCanvas(), width, height);
  if (pluginDocument.pathViewport.zoomScale == 0) pluginDocument.pathViewport.zoomScale = ZoomTool.fitZoomToBounds(pluginDocument.width, pluginDocument.height, width * devicePixelRatio, height * devicePixelRatio);
  this.redraw()
};
PluginToolPanel.prototype.refresh = function() {
  const firstChild = this.panelBody.firstChild;
  if (!LayerSystem.webglEnabled && firstChild == LayerSystem.getOffscreenCanvas() || LayerSystem.webglEnabled && firstChild == this.canvasEl) this.panelBody.removeChild(firstChild);
  const canvasEl = LayerSystem.webglEnabled ? LayerSystem.getOffscreenCanvas() : this.canvasEl;
  if (!isInDOM(canvasEl)) this.panelBody.appendChild(canvasEl)
};
PluginToolPanel.prototype.redraw = function() {
  if (LayerSystem.webglEnabled != this.cachedWebglEnabled) {
    this.cachedZoomScale = 0;
    this.cachedChannelMatrixJson = ""
  }
  this.cachedWebglEnabled = LayerSystem.webglEnabled;
  if (this.appData == null) return;
  if (LayerSystem.webglEnabled) this.drawWebglComposite();
  else this.drawCanvas2dComposite();
  const pluginDocument = this.pluginDocument;
  this.cachedZoomScale = pluginDocument.pathViewport.zoomScale;
  this.cachedChannelMatrixJson = JSON.stringify(pluginDocument.pathViewport.channelVisibility)
};

export { PluginToolPanel };
