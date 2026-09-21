/**
 * Liquify (`LqFy`) filter parameter panel: warp map editing with brush tools,
 * undo snapshots, and a live preview view.
 *
 * Wire key `LqMe` holds the serialized displacement map bytes.
 */

import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";

import { CachedLayerData } from "../../features/filters/filter-data-cache.js";
import { BrushStroke } from "../../features/brush/brush-stroke.js";
import { BrushPresetUtil } from "../../features/brush/brush-presets.js";
import { FilterDefs } from "../../features/filters/filter-apply.js";
import { ToolBar } from "../tool-options/option-bar.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { TextRangeInput } from "../widgets/controls/number-inputs.js";
import { PanelWrapper } from "../widgets/controls/panel-widgets.js";
import { Button, Checkbox } from "../widgets/form-controls.js";
import { FilterParameterPanel } from "./filter-parameter-panel.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { PaintTool } from "../../document/tools/paint-tools.js";
import { allocBuffer, copyBuffer } from "../../engine/compositing/buffer-utils.js";
import { copyPixels } from "../../engine/compositing/pixel-ops.js";
import { pixelAlignRect } from "../../engine/compositing/anti-alias.js";
import { composite } from "../../engine/compositing/compositing-ops.js";
import { ditheringPatterns } from "../../engine/compositing/dithering.js";
import { applyWarp } from "../../engine/compositing/warp.js";

/** Per-tool [min, max] strength pairs indexed by `activeToolIndex`. */
const LIQUIFY_TOOL_STRENGTH_TABLE = [.005, .015, 0, 0, .2, .2, .01, .01, .05, .35, .1, .1, .005, .015];

const LIQUIFY_DEFAULT_PARAM_VALUES = [100, 50, 100, false, 100];
const LIQUIFY_UNDO_STACK_MAX = 50;
const LIQUIFY_MAP_RESOLUTION_MIN_RATIO = .22;

function buildLiquifyToolbarSpec() {
  return {
    toolbarGroups: [
      [{ tool: { id: 0, name: "filters.menu.liquify.smudge", iconId: "liq/smudge" } }],
      [{ tool: { id: 1, name: "filters.menu.liquify.reconstruct", iconId: "liq/reconstruct" } }],
      [{ tool: { id: 2, name: "filters.menu.liquify.smoothen", iconId: "liq/smooth" } }],
      [{ tool: { id: 3, name: "filters.menu.distort.twirl", iconId: "liq/twirl" } }],
      [{ tool: { id: 4, name: "filters.menu.liquify.shrink", iconId: "liq/shrink" } }],
      [{ tool: { id: 5, name: "filters.menu.liquify.blow", iconId: "liq/blow" } }],
      [{ tool: { id: 6, name: "filters.menu.liquify.pushLeft", iconId: "liq/pleft" } }],
    ],
    toolbarShortcutKeys: [],
  };
}

function computePreferredLiquifyDialogSize(maxW, maxH) {
  return {
    // Like the Layer Style / Blending Options workspace, Liquify should make
    // useful use of a large display without becoming an overwhelming sheet.
    width: Math.min(Math.max(Math.round(maxW * .74), 720), Math.min(1120, maxW)),
    height: Math.min(Math.max(Math.round(maxH * .70), 520), Math.min(800, maxH)),
  };
}

function resolveLiquifyToolStrength(toolIndex, densityNorm) {
  const minStrength = LIQUIFY_TOOL_STRENGTH_TABLE[toolIndex * 2];
  const maxStrength = LIQUIFY_TOOL_STRENGTH_TABLE[toolIndex * 2 + 1];
  return (1 - densityNorm) * minStrength + densityNorm * maxStrength;
}

/** Upsample an undersized warp map so brush edits stay usable at preview size. */
function ensureDisplacementMapForPreview(displacementState, previewWidth, previewHeight) {
  if (displacementState.gridWidth / previewWidth < LIQUIFY_MAP_RESOLUTION_MIN_RATIO) {
    const nextState = {
      gridWidth: Math.floor(previewWidth / 4),
      gridHeight: Math.floor(previewHeight / 4),
    };
    nextState.map = new Float32Array(nextState.gridWidth * nextState.gridHeight * 2);
    return nextState;
  }
  return displacementState;
}

function serializeDisplacementToByteList(displacementState) {
  const serializedBytes = new Uint8Array(CachedLayerData.serialize(displacementState));
  const byteList = [];
  for (let byteIdx = 0; byteIdx < serializedBytes.length; byteIdx++) {
    byteList.push(serializedBytes[byteIdx]);
  }
  return byteList;
}

function prepareLiquifySourceBuffers(sourceBuffer, sourceRect, previewRect) {
  sourceRect = sourceRect.clone();
  if (!previewRect.equals(sourceRect)) {
    const unionRect = sourceRect.union(previewRect);
    const unionBuffer = allocBuffer(unionRect.area() * 4);
    copyPixels(sourceBuffer, sourceRect, unionBuffer, unionRect);
    sourceBuffer = unionBuffer;
    sourceRect = unionRect;
  }
  sourceRect.x = sourceRect.y = 0;
  return {
    sourceBuffer: sourceBuffer,
    sourceRect: sourceRect,
  };
}

/**
 * The Liquify dialog panel. Holds a brush toolbar, a live preview view, and the
 * warp state: a displacement map (`this.displacementState`) that brush strokes
 * push around, plus source/work/preview pixel buffers and an undo stack of map
 * snapshots. `setValue` seeds the buffers and map from the layer; drag handlers
 * paint the map and re-warp the preview; `getValue` serializes the map back into
 * the `LqMe` wire key of a fresh `LqFy` descriptor.
 */
FilterParameterPanel.LqFy = function() {
  FilterParameterPanel.call(this, "LqFy");
  this.altKeyHeld = false;
  this.dragAnchor = null;
  this.lastDragPoint = null;
  this.activeToolIndex = 0;
  this.toolbarSpec = buildLiquifyToolbarSpec();
  this.toolBar = new ToolBar(this.toolbarSpec, false);
  this.toolBar.setActiveToolById(0);
  this.toolBar.on(EventType.uiDispatch, this.onToolbarDispatch, this);
  this.brushDescriptor = BrushPresetUtil.getDefaultBrushDescriptor();
  this.displacementState = null;
  this.undoStack = [];
  this.undoIndex = -1;
  this.previewRect = null;
  this.backgroundBuffer = null;
  this.sourceBuffer = null;
  this.workBuffer = null;
  this.previewBuffer = null;
  const flexRowEl = makeElement("div", "flexrow");
  addClass(flexRowEl, "liquify-panel");
  this.containerEl = flexRowEl;
  this.el.appendChild(flexRowEl);
  flexRowEl.appendChild(this.toolBar.el);
  this.view = new PanelWrapper(true);
  addClass(this.view.el, "liquify-preview");
  this.view.resize(100, 100);
  this.view.on("mousedown", this.onDragStart, this);
  this.view.on("mousemove", this.onDrag, this);
  this.view.on("mouseup", this.onDragEnd, this);
  this.view.on("zoom", this.updateCursor, this);
  flexRowEl.appendChild(this.view.el);
  const optionsFormEl = makeElement("div", "form");
  addClass(optionsFormEl, "liquify-options");
  flexRowEl.appendChild(optionsFormEl);
  this.optionsFormEl = optionsFormEl;
  optionsFormEl.style.width = "230px";
  this.paramInputs = [
    new TextRangeInput("properties.size.title", 0, 1e3, null, false, true),
    new TextRangeInput("properties.density", 0, 100, null, false, false),
    new TextRangeInput("properties.rate", 0, 100, null, false, false),
    new Checkbox("properties.background"),
    new TextRangeInput("properties.opacity", 0, 100, null, false, false),
  ];
  const brushShapeDesc = this.brushDescriptor.Brsh.v;
  brushShapeDesc.diameter.v.val = 100;
  for (let paramIdx = 0; paramIdx < this.paramInputs.length; paramIdx++) {
    const paramInput = this.paramInputs[paramIdx];
    paramInput.setValue(LIQUIFY_DEFAULT_PARAM_VALUES[paramIdx]);
    paramInput.on(EventType.widgetSelect, this.onLiquifyParamChange, this);
    optionsFormEl.appendChild(paramInput.el);
  }
  const resetButton = new Button("properties.reset", true, null, true);
  addClass(resetButton.el, "liquify-reset");
  resetButton.on("click", this.onResetClick, this);
  optionsFormEl.appendChild(resetButton.el);
  this.floatingOptionsHost = new BaseWidget();
  this.floatingOptionsHost.el = makeElement("div", "floatcont");
  this.menuButton = new Button("properties.menu", false, null, true);
  this.menuButton.on("click", this.openOptionsMenu, this);
  const menuButtonEl = this.menuButton.el;
  menuButtonEl.setAttribute("style", "position:absolute; right:13px; top:47px");
};
FilterParameterPanel.LqFy.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.LqFy.prototype.opensAsModalDialog = function() {
  return true;
};
FilterParameterPanel.LqFy.prototype.getPreferredDialogSize = function(maxW, maxH) {
  return computePreferredLiquifyDialogSize(maxW, maxH);
};
FilterParameterPanel.LqFy.prototype.appendCategoryHeader = function(headerEl) {
  addClass(headerEl, "liquify-confirm");
  this.optionsFormEl.appendChild(headerEl);
};
FilterParameterPanel.LqFy.prototype.openOptionsMenu = function(clickEvt) {
  const menuRect = this.menuButton.el.getBoundingClientRect();
  this.floatingOptionsHost.el.appendChild(this.optionsFormEl);
  const dispatchEvt = new AppEvent(EventType.uiDispatch, true);
  dispatchEvt.data = {
    dispatchKind: UiCommand.showFloatingOverlay,
    overlayWidget: this.floatingOptionsHost,
    x: menuRect.right + menuRect.width - 290,
    y: menuRect.top + menuRect.height,
  };
  this.dispatch(dispatchEvt);
};
FilterParameterPanel.LqFy.prototype.onKeyEvent = function(keyEvt) {
  this.altKeyHeld = keyEvt.isPressed(KeyboardHandler.Alt);
  const updatedBrush = PaintTool.adjustBrushSizeFromKeys(this.brushDescriptor, keyEvt);
  if (updatedBrush != null) {
    this.brushDescriptor = updatedBrush;
    this.updateCursor();
    this.paramInputs[0].setValue(updatedBrush.Brsh.v.diameter.v.val);
  } else if (keyEvt.isPressed(KeyboardHandler.Ctrl) && keyEvt.isPressed(KeyboardHandler.KeyZ)) {
    const undoSnapshots = this.undoStack;
    if (keyEvt.isPressed(KeyboardHandler.Shift)) {
      if (this.undoIndex + 1 < undoSnapshots.length) this.undoIndex++;
    } else if (this.undoIndex > 0) {
      this.undoIndex--;
    }
    this.displacementState.map = undoSnapshots[this.undoIndex].slice(0);
    this.redraw(null);
  } else {
    this.view.onKeyEvent(keyEvt);
  }
};
FilterParameterPanel.LqFy.prototype.onToolbarDispatch = function(dispatchEvt) {
  if (dispatchEvt.data.dispatchKind == UiCommand.setActiveToolPanelMode) {
    this.activeToolIndex = dispatchEvt.data.routingChannel;
    this.toolBar.setActiveToolById(this.activeToolIndex);
  }
};
FilterParameterPanel.LqFy.prototype.onLiquifyParamChange = function(widgetEvt) {
  const targetInput = widgetEvt.currentTarget;
  const paramIndex = this.paramInputs.indexOf(targetInput);
  const brushShapeDesc = this.brushDescriptor.Brsh.v;
  if (paramIndex == 0) {
    brushShapeDesc.diameter.v.val = targetInput.getValue();
    this.updateCursor();
  }
  if (paramIndex > 2) this.redraw(null);
};
// Records a copy of the current warp map as an undo step, truncating any redo
// entries and capping the stack at LIQUIFY_UNDO_STACK_MAX. Ctrl+Z / Ctrl+Shift+Z
// in onKeyEvent step `undoIndex` through these snapshots.
FilterParameterPanel.LqFy.prototype.pushUndoSnapshot = function() {
  let undoSnapshots = this.undoStack;
  this.undoIndex++;
  undoSnapshots[this.undoIndex] = this.displacementState.map.slice(0);
  while (undoSnapshots.length > this.undoIndex + 1) undoSnapshots.pop();
  while (undoSnapshots.length > LIQUIFY_UNDO_STACK_MAX) {
    undoSnapshots = undoSnapshots.slice(1);
    this.undoIndex--;
  }
};
FilterParameterPanel.LqFy.prototype.onDragStart = function(dragEvt) {
  this.ensureAnimationLoop();
  this.dragAnchor = this.view.pointerToDocPoint();
  this.lastDragPoint = new Point(0, 0);
  this.on(EventType.animationFrame, this.onAnimationFrame, this);
};
FilterParameterPanel.LqFy.prototype.onDrag = function(dragEvt) {
  const docPoint = this.view.pointerToDocPoint();
  const delta = new Point(docPoint.x - this.dragAnchor.x, docPoint.y - this.dragAnchor.y);
  if (this.activeToolIndex == 0 || this.activeToolIndex == 6) this.renderPreview(delta);
  this.dragAnchor = docPoint;
};
FilterParameterPanel.LqFy.prototype.onDragEnd = function(dragEvt) {
  this.pushUndoSnapshot();
  this.ensureAnimationLoop();
};
FilterParameterPanel.LqFy.prototype.ensureAnimationLoop = function() {
  if (this.hasListeners(EventType.animationFrame, this.onAnimationFrame)) {
    this.removeEventListener(EventType.animationFrame, this.onAnimationFrame, this);
  }
};
FilterParameterPanel.LqFy.prototype.onAnimationFrame = function(frameEvt) {
  if (this.activeToolIndex != 0 && this.activeToolIndex != 6) {
    this.renderPreview(new Point(0, 0));
  }
};
// Applies the active brush along the drag vector `delta`: walks the stroke in
// short steps, writes the tool's displacement into the warp map at each step
// (scaled from document space into map-grid space by `mapScale`), then re-warps
// only the affected region of the preview.
FilterParameterPanel.LqFy.prototype.renderPreview = function(delta) {
  const displacementState = this.displacementState;
  const mapScale = displacementState.gridWidth / this.previewRect.width;
  const brushAnchor = this.dragAnchor;
  const brushShapeDesc = this.brushDescriptor.Brsh.v;
  const brushDiameter = brushShapeDesc.diameter.v.val;
  const mapWidth = displacementState.gridWidth;
  const mapHeight = displacementState.gridHeight;
  const dragLength = Math.sqrt(delta.x * delta.x + delta.y * delta.y);
  const stepCount = Math.max(1, Math.ceil(dragLength / 2));
  const stepDeltaX = delta.x / stepCount;
  const stepDeltaY = delta.y / stepCount;
  const stepAnchor = brushAnchor.clone();
  const toolIndex = this.activeToolIndex;
  const densityNorm = this.paramInputs[1].getValue() / 100;
  const rateNorm = this.paramInputs[2].getValue() / 100;
  const blendedStrength = resolveLiquifyToolStrength(toolIndex, densityNorm);
  const brushRadiusMap = brushDiameter * mapScale / 2;
  for (let stepIdx = 0; stepIdx < stepCount; stepIdx++) {
    const ditherScratch = [];
    stepAnchor.x += stepDeltaX;
    stepAnchor.y += stepDeltaY;
    ditheringPatterns.applyPatternDithering(
      displacementState.map, mapWidth, mapHeight, toolIndex,
      stepAnchor.x * mapScale, stepAnchor.y * mapScale, brushRadiusMap,
      densityNorm, rateNorm, stepDeltaX * mapScale, stepDeltaY * mapScale,
      ditherScratch, this.altKeyHeld,
    );
    ditheringPatterns.applyThreshold(
      mapWidth, mapHeight, displacementState.map, ditherScratch,
      2 * blendedStrength * rateNorm,
    );
  }
  let brushRectMap = new Rect(brushAnchor.x * mapScale, brushAnchor.y * mapScale, 0, 0);
  brushRectMap.inflate(brushDiameter * mapScale * .5, brushDiameter * mapScale * .5);
  const sweptRectMap = brushRectMap.clone();
  sweptRectMap.offset(delta.x * mapScale, delta.y * mapScale);
  brushRectMap = brushRectMap.union(sweptRectMap);
  let dirtyRectDoc = new Rect(
    brushRectMap.x / mapScale, brushRectMap.y / mapScale,
    brushRectMap.width / mapScale, brushRectMap.height / mapScale,
  );
  dirtyRectDoc = pixelAlignRect(dirtyRectDoc).intersect(this.previewRect);
  this.redraw(dirtyRectDoc);
};
FilterParameterPanel.LqFy.prototype.updateCursor = function() {
  const cursorGlyph = BrushStroke.createCursorGlyph(
    this.brushDescriptor, null, this.view.getViewTransform().zoomScale,
  );
  this.view.setDefaultCursor(cursorGlyph);
};
FilterParameterPanel.LqFy.prototype.setValue = function(
  filterDescriptor, sourceBuffer, sourceRect, previewRect, backgroundBuffer, _dialogContext,
) {
  if (sourceBuffer == null) return;
  const prepared = prepareLiquifySourceBuffers(sourceBuffer, sourceRect, previewRect);
  sourceBuffer = prepared.sourceBuffer;
  sourceRect = prepared.sourceRect;
  this.sourceBuffer = sourceBuffer;
  this.backgroundBuffer = backgroundBuffer;
  this.previewBuffer = sourceBuffer.slice(0);
  this.workBuffer = sourceBuffer.slice(0);
  this.previewRect = sourceRect;
  this.displacementState = ensureDisplacementMapForPreview(
    CachedLayerData.parse(new Uint8Array(filterDescriptor.LqMe.v).buffer),
    sourceRect.width,
    sourceRect.height,
  );
  this.undoStack = [];
  this.undoIndex = -1;
  this.pushUndoSnapshot();
  this.redraw(null);
  this.updateCursor();
};
FilterParameterPanel.LqFy.prototype.getValue = function() {
  this.ensureAnimationLoop();
  const filterDescriptor = FilterDefs.create("LqFy");
  filterDescriptor.LqMe.v = serializeDisplacementToByteList(this.displacementState);
  return filterDescriptor;
};
FilterParameterPanel.LqFy.prototype.resize = function(width, height) {
  this.toolBar.resize(width, height);
  const menuButtonEl = this.menuButton.el;
  const optionsFormEl = this.optionsFormEl;
  this.containerEl.appendChild(optionsFormEl);
  this.containerEl.appendChild(menuButtonEl);
  if (width > 450) {
    optionsFormEl.style.marginLeft = "1em";
    this.containerEl.removeChild(menuButtonEl);
    this.view.resize(width - 238 - 45, height);
  } else {
    optionsFormEl.style.marginLeft = "";
    this.containerEl.removeChild(optionsFormEl);
    this.view.resize(width - 40, height);
  }
};
FilterParameterPanel.LqFy.prototype.buildUI = function() {
  this.toolBar.buildUI();
  for (let paramIdx = 0; paramIdx < this.paramInputs.length; paramIdx++) {
    this.paramInputs[paramIdx].buildUI();
  }
};
FilterParameterPanel.LqFy.prototype.onResetClick = function() {
  this.ensureAnimationLoop();
  this.displacementState.map.fill(0);
  this.pushUndoSnapshot();
  this.redraw(null);
};
// Re-warps the source pixels through the current displacement map into the work
// buffer (optionally limited to `dirtyRect`), then presents them in the view.
// When the "background" option is on, the warped result is composited over the
// under-layer pixels at the chosen opacity; otherwise the work buffer is shown
// as-is.
FilterParameterPanel.LqFy.prototype.redraw = function(dirtyRect) {
  const previewRect = this.previewRect;
  const sourcePixels = this.sourceBuffer;
  const previewPixels = this.previewBuffer;
  const displacementState = this.displacementState;
  applyWarp(
    sourcePixels, this.workBuffer, previewRect.width, previewRect.height, dirtyRect,
    displacementState.map, displacementState.gridWidth, displacementState.gridHeight, 0,
  );
  if (this.paramInputs[3].isPressed()) {
    copyPixels(
      this.backgroundBuffer, previewRect, previewPixels, previewRect,
      dirtyRect ? dirtyRect : previewRect,
    );
    composite(
      "norm", this.workBuffer, previewRect, previewPixels, previewRect,
      dirtyRect ? dirtyRect : previewRect, this.paramInputs[4].getValue() / 100,
    );
  } else {
    copyBuffer(this.workBuffer, previewPixels);
  }
  this.view.setValue([{
    rect: previewRect,
    data: previewPixels.buffer,
  }]);
};

export {
  buildLiquifyToolbarSpec,
  computePreferredLiquifyDialogSize,
  resolveLiquifyToolStrength,
  ensureDisplacementMapForPreview,
  LIQUIFY_TOOL_STRENGTH_TABLE,
  LIQUIFY_DEFAULT_PARAM_VALUES,
};
