/**
 * Brush panel: tip shape, tip dynamics, scatter, and color-dynamics editors
 * with a live stroke preview.
 */

import { Rect } from "../../core/math/rect.js";
import { BrushStroke } from "../../features/brush/brush-stroke.js";
import { BrushPresetUtil } from "../../features/brush/brush-presets.js";
import { PopupTypes } from "../config/popup-types.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { BaseTool } from "../widgets/base-tool.js";
import { TextRangeInput } from "../widgets/controls/number-inputs.js";
import { Checkbox, Label, MenuList } from "../widgets/form-controls.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { getDevicePixelRatio, isInDOM, makeElement, setElementCssSizeForDeviceRatio } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { copyPixels } from "../../engine/compositing/pixel-ops.js";

/**
 * Base class for one row in the Brush sub-panel layout. Each row owns a
 * fragment of the brush descriptor (brushSettings) and emits a
 * "brushchange" event up the chain when the user mutates it.
 *
 * Subclasses implement:
 *   - setPresets(presets): receive the current preset registry
 *   - isPressed(): whether this row's effect is currently enabled
 *   - setEffectEnabled(on): toggle the effect
 *   - redraw(): mirror this.brushSettings into UI widgets
 *   - buildUI(): wire child widgets after they are attached to the DOM
 */
function BrushEffectRow(labelKey) {
  BaseWidget.call(this);
  this.labelKey = labelKey;
  this.el = makeElement("div", "");
  this.brushSettings = null;
}
BrushEffectRow.prototype = Object.create(BaseWidget.prototype);
BrushEffectRow.prototype.setPresets = function(presets) {};
BrushEffectRow.prototype.setValue = function(brushSettings) {
  this.brushSettings = JSON.parse(JSON.stringify(brushSettings));
  this.el.setAttribute("class", this.isPressed() ? "" : "disabled");
  this.redraw();
};
BrushEffectRow.prototype.setEffectEnabled = function(enabled) {};
BrushEffectRow.prototype.isPressed = function() {
  return false;
};
BrushEffectRow.prototype.buildUI = function() {};
BrushEffectRow.prototype.redraw = function() {};
BrushEffectRow.prototype.notifyChange = function() {
  this.dispatch(new AppEvent("brushchange"));
};
Object.defineProperty(BrushEffectRow.prototype, "Un", {
  get: function() { return this.brushSettings; },
  set: function(value) { this.brushSettings = value; }
});

/**
 * Tip Shape row: preset thumbnail grid plus size, angle, roundness, hardness,
 * and spacing. Roundness and hardness only apply to specific brush kinds, so
 * redraw() re-attaches the relevant inputs when the brush kind changes.
 */
function BrushTipShapeRow() {
  BrushEffectRow.call(this, "brushAndMessages.tipShape");
  this.presets = null;
  this.lastBrushKind = null;
  this.presetGrid = new MenuList(true);
  this.el.appendChild(this.presetGrid.el);
  this.presetGrid.on(EventType.widgetSelect, this.onPresetSelect, this);
  this.presetGrid.el.style.height = "10.7em";
  this.sizeInput = new TextRangeInput("properties.size.title", 1, 1e3, " px", 0, true);
  this.sizeInput.on(EventType.widgetSelect, this.onSizeChange, this);
  this.angleInput = new TextRangeInput("properties.angle", 0, 359, " \xB0");
  this.angleInput.on(EventType.widgetSelect, this.onAngleChange, this);
  this.roundnessInput = new TextRangeInput("properties.roundness", 0, 100, " %");
  this.roundnessInput.on(EventType.widgetSelect, this.onRoundnessChange, this);
  this.hardnessInput = new TextRangeInput("properties.hardness", 0, 100, " %");
  this.hardnessInput.on(EventType.widgetSelect, this.onHardnessChange, this);
  this.spacingInput = new TextRangeInput("properties.spacing", 1, 300, " %");
  this.spacingInput.on(EventType.widgetSelect, this.onSpacingChange, this);
  this.inputs = [this.sizeInput, this.angleInput, this.roundnessInput, this.hardnessInput, this.spacingInput]
}
BrushTipShapeRow.prototype = Object.create(BrushEffectRow.prototype);
BrushTipShapeRow.prototype.buildUI = function() {
  this.sizeInput.buildUI();
  this.angleInput.buildUI();
  this.roundnessInput.buildUI();
  this.hardnessInput.buildUI();
  this.spacingInput.buildUI();
};
BrushTipShapeRow.prototype.isPressed = function() {
  return true;
};
BrushTipShapeRow.prototype.setPresets = function(presets) {
  this.presets = presets;
  const thumbs = buildPresetThumbnailUrls(presets);
  const thumbW = Math.floor(30 * getDevicePixelRatio());
  const thumbH = Math.floor(40 * getDevicePixelRatio());
  this.presetGrid.setThumbnailGrid(thumbs, null, thumbW, thumbH);
};
BrushTipShapeRow.prototype.redraw = function() {
  syncTipShapeInputs(this, this.brushSettings.Brsh.v);
};
BrushTipShapeRow.prototype.onPresetSelect = function(evt) {
  const preset = resolvePresetAtThumbnailIndex(this.presets, this.presetGrid.getValue());
  if (preset == null) return;
  this.brushSettings = preset;
  this.notifyChange();
};
BrushTipShapeRow.prototype.onSizeChange = function(evt) {
  this.brushSettings.Brsh.v.diameter.v.val = evt.target.getValue();
  this.notifyChange();
};
BrushTipShapeRow.prototype.onAngleChange = function(evt) {
  this.brushSettings.Brsh.v.Angl.v.val = evt.target.getValue();
  this.notifyChange();
};
BrushTipShapeRow.prototype.onRoundnessChange = function(evt) {
  this.brushSettings.Brsh.v.Rndn.v.val = evt.target.getValue();
  this.notifyChange();
};
BrushTipShapeRow.prototype.onHardnessChange = function(evt) {
  this.brushSettings.Brsh.v.Hrdn.v.val = evt.target.getValue();
  this.notifyChange();
};
BrushTipShapeRow.prototype.onSpacingChange = function(evt) {
  this.brushSettings.Brsh.v.Spcn.v.val = evt.target.getValue();
  this.notifyChange();
};

/**
 * Tip Dynamics row: size / angle / roundness jitter plus minimum-diameter
 * and minimum-roundness floors.
 */
function BrushTipDynamicsRow() {
  BrushEffectRow.call(this, "brushAndMessages.tipDynamics");
  this.sizeJitter = bindRangeInput(this, "brushAndMessages.shapeDynamics.sizeJitter", 0, 100, " %", this.onSizeJitterChange);
  this.minDiameter = bindRangeInput(this, "brushAndMessages.shapeDynamics.minimalDiameter", 0, 100, " %", this.onMinDiameterChange);
  this.angleJitter = bindRangeInput(this, "brushAndMessages.shapeDynamics.angleJitter", 0, 100, " %", this.onAngleJitterChange);
  this.roundnessJitter = bindRangeInput(this, "brushAndMessages.shapeDynamics.roundnessJitter", 0, 100, " %", this.onRoundnessJitterChange);
  this.minRoundness = bindRangeInput(this, "brushAndMessages.shapeDynamics.minimalRoundness", 0, 100, " %", this.onMinRoundnessChange);
}
BrushTipDynamicsRow.prototype = Object.create(BrushEffectRow.prototype);
BrushTipDynamicsRow.prototype.buildUI = function() {
  this.sizeJitter.buildUI();
  this.minDiameter.buildUI();
  this.angleJitter.buildUI();
  this.roundnessJitter.buildUI();
  this.minRoundness.buildUI();
};
BrushTipDynamicsRow.prototype.isPressed = function() {
  return this.brushSettings.useTipDynamics.v;
};
BrushTipDynamicsRow.prototype.setEffectEnabled = function(enabled) {
  this.brushSettings.useTipDynamics.v = enabled;
  BrushPresetUtil.brushDescriptorSchema.normalize(this.brushSettings);
  this.notifyChange();
};
BrushTipDynamicsRow.prototype.redraw = function() {
  const brushDesc = this.brushSettings;
  if (brushDesc.useTipDynamics.v == false) return;
  this.sizeJitter.setValue(brushDesc.szVr.v.jitter.v.val);
  this.minDiameter.setValue(brushDesc.minimumDiameter.v.val);
  this.angleJitter.setValue(brushDesc.angleDynamics.v.jitter.v.val);
  this.roundnessJitter.setValue(brushDesc.roundnessDynamics.v.jitter.v.val);
  this.minRoundness.setValue(brushDesc.minimumRoundness.v.val);
};
BrushTipDynamicsRow.prototype.onSizeJitterChange = function(evt) {
  this.brushSettings.szVr.v.jitter.v.val = evt.target.getValue();
  this.notifyChange();
};
BrushTipDynamicsRow.prototype.onMinDiameterChange = function(evt) {
  this.brushSettings.minimumDiameter.v.val = evt.target.getValue();
  this.notifyChange();
};
BrushTipDynamicsRow.prototype.onAngleJitterChange = function(evt) {
  this.brushSettings.angleDynamics.v.jitter.v.val = evt.target.getValue();
  this.notifyChange();
};
BrushTipDynamicsRow.prototype.onRoundnessJitterChange = function(evt) {
  this.brushSettings.roundnessDynamics.v.jitter.v.val = evt.target.getValue();
  this.notifyChange();
};
BrushTipDynamicsRow.prototype.onMinRoundnessChange = function(evt) {
  this.brushSettings.minimumRoundness.v.val = evt.target.getValue();
  this.notifyChange();
};

/**
 * Scatter row: position jitter, count, and count jitter.
 */
function BrushScatterRow() {
  BrushEffectRow.call(this, "brushAndMessages.scatter");
  this.positionJitter = bindRangeInput(this, "brushAndMessages.scattering.positionJitter", 0, 1e3, " %", this.onPositionJitterChange);
  this.count = bindRangeInput(this, "brushAndMessages.scattering.count", 1, 20, null, this.onCountChange);
  this.countJitter = bindRangeInput(this, "brushAndMessages.scattering.countJitter", 0, 100, " %", this.onCountJitterChange);
}
BrushScatterRow.prototype = Object.create(BrushEffectRow.prototype);
BrushScatterRow.prototype.buildUI = function() {
  this.positionJitter.buildUI();
  this.count.buildUI();
  this.countJitter.buildUI();
};
BrushScatterRow.prototype.isPressed = function() {
  return this.brushSettings.useScatter.v;
};
BrushScatterRow.prototype.setEffectEnabled = function(enabled) {
  this.brushSettings.useScatter.v = enabled;
  BrushPresetUtil.brushDescriptorSchema.normalize(this.brushSettings);
  this.notifyChange();
};
BrushScatterRow.prototype.redraw = function() {
  const brushDesc = this.brushSettings;
  if (brushDesc.useScatter.v == false) return;
  this.positionJitter.setValue(brushDesc.scatterDynamics.v.jitter.v.val);
  this.count.setValue(brushDesc.Cnt.v);
  this.countJitter.setValue(brushDesc.countDynamics.v.jitter.v.val);
};
BrushScatterRow.prototype.onPositionJitterChange = function(evt) {
  this.brushSettings.scatterDynamics.v.jitter.v.val = evt.target.getValue();
  this.notifyChange();
};
BrushScatterRow.prototype.onCountChange = function(evt) {
  this.brushSettings.Cnt.v = evt.target.getValue();
  this.notifyChange();
};
BrushScatterRow.prototype.onCountJitterChange = function(evt) {
  this.brushSettings.countDynamics.v.jitter.v.val = evt.target.getValue();
  this.notifyChange();
};

/**
 * Color Dynamics row: foreground/background jitter, hue, saturation, and
 * brightness jitter.
 */
function BrushColorDynamicsRow() {
  BrushEffectRow.call(this, "brushAndMessages.colourDynamics.title");
  this.fgBgJitter = bindRangeInput(this, "brushAndMessages.colourDynamics.foregroundBackgroundJitter", 0, 100, " %", this.onFgBgJitterChange);
  this.hueJitter = bindRangeInput(this, "brushAndMessages.colourDynamics.hueJitter", 0, 100, " %", this.onHueJitterChange);
  this.satJitter = bindRangeInput(this, "brushAndMessages.colourDynamics.saturationJitter", 0, 100, " %", this.onSatJitterChange);
  this.brightnessJitter = bindRangeInput(this, "brushAndMessages.colourDynamics.brightnessJitter", 0, 100, " %", this.onBrightnessJitterChange);
}
BrushColorDynamicsRow.prototype = Object.create(BrushEffectRow.prototype);
BrushColorDynamicsRow.prototype.buildUI = function() {
  this.fgBgJitter.buildUI();
  this.hueJitter.buildUI();
  this.satJitter.buildUI();
  this.brightnessJitter.buildUI();
};
BrushColorDynamicsRow.prototype.isPressed = function() {
  return this.brushSettings.useColorDynamics.v;
};
BrushColorDynamicsRow.prototype.setEffectEnabled = function(enabled) {
  this.brushSettings.useColorDynamics.v = enabled;
  BrushPresetUtil.brushDescriptorSchema.normalize(this.brushSettings);
  this.notifyChange();
};
BrushColorDynamicsRow.prototype.redraw = function() {
  const brushDesc = this.brushSettings;
  if (brushDesc.useColorDynamics.v == false) return;
  this.fgBgJitter.setValue(brushDesc.clVr.v.jitter.v.val);
  this.hueJitter.setValue(brushDesc.H.v.val);
  this.satJitter.setValue(brushDesc.Strt.v.val);
  this.brightnessJitter.setValue(brushDesc.Brgh.v.val);
};
BrushColorDynamicsRow.prototype.onFgBgJitterChange = function(evt) {
  this.brushSettings.clVr.v.jitter.v.val = evt.target.getValue();
  this.notifyChange();
};
BrushColorDynamicsRow.prototype.onHueJitterChange = function(evt) {
  this.brushSettings.H.v.val = evt.target.getValue();
  this.notifyChange();
};
BrushColorDynamicsRow.prototype.onSatJitterChange = function(evt) {
  this.brushSettings.Strt.v.val = evt.target.getValue();
  this.notifyChange();
};
BrushColorDynamicsRow.prototype.onBrightnessJitterChange = function(evt) {
  this.brushSettings.Brgh.v.val = evt.target.getValue();
  this.notifyChange();
};

/**
 * Sidebar Brush panel: pick a brush preset and dial in shape / dynamics /
 * scatter / color-dynamics. The bottom strip is a live preview rendered with
 * BrushStroke.
 *
 * Lazily builds widgets on first refresh() so the preview canvas is not
 * created until the panel becomes visible.
 */
function BrushPanel() {
  BaseTool.call(this, "panels.brush", false, getIconUrl("panels/brush"), BaseTool.PanelId.BRUSH, true);
  this.presets = null;
  this.brushSettings = null;
  this.doc = null;
}
BrushPanel.prototype = Object.create(BaseTool.prototype);

BrushPanel.prototype.buildPanelLayout = function() {
  const wrapper = makeElement("div", "");
  this.panelBody.appendChild(wrapper);
  this.listEl = makeElement("div", "bordered cell");
  this.listEl.setAttribute("style", "width:10em; height:28.5em;");
  wrapper.appendChild(this.listEl);
  this.rowEls = [];
  this.tipShapeLabel = null;
  this.rowCheckboxes = [];
  this.effectRows = [
    new BrushTipShapeRow,
    new BrushTipDynamicsRow,
    new BrushScatterRow,
    new BrushColorDynamicsRow
  ];
  installEffectRowSidebar(this);
  this.editorEl = makeElement("div", "cell padded");
  wrapper.appendChild(this.editorEl);
  for (let i = 0; i < this.effectRows.length; i++) {
    this.effectRows[i].on("brushchange", this.onBrushChange, this);
  }
  this.setActiveRow(0);
  this.previewCanvas = makeElement("canvas", "");
  this.previewCanvas.width = Math.floor(380 * getDevicePixelRatio());
  this.previewCanvas.height = Math.floor(80 * getDevicePixelRatio());
  setElementCssSizeForDeviceRatio(this.previewCanvas, this.previewCanvas.width, this.previewCanvas.height);
  wrapper.appendChild(this.previewCanvas);
  this.previewCtx = this.previewCanvas.getContext("2d");
  this.redraw();
};

BrushPanel.prototype.refresh = function() {
  if (!isInDOM(this.panelBody)) return;
  if (this.listEl) {
    this.redraw();
    return;
  }
  this.buildPanelLayout();
  this.buildUI();
  this.onUpdate(this.doc, PopupTypes.ALL);
};

BrushPanel.prototype.buildUI = function() {
  BaseTool.prototype.buildUI.call(this);
  if (this.listEl == null) return;
  this.tipShapeLabel.buildUI();
  for (let i = 1; i < this.rowCheckboxes.length; i++) this.rowCheckboxes[i].buildUI();
  for (let i = 0; i < this.effectRows.length; i++) this.effectRows[i].buildUI();
};

BrushPanel.prototype.onBrushChange = function(evt) {
  const rowIndex = this.effectRows.indexOf(evt.currentTarget);
  const snapshot = JSON.parse(JSON.stringify(this.effectRows[rowIndex].brushSettings));
  const dispatchEvt = new AppEvent(EventType.uiDispatch, true);
  dispatchEvt.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.SCRIPTS,
    brushPreset: snapshot
  };
  this.dispatch(dispatchEvt);
};

BrushPanel.prototype.onCheckboxChange = function(evt) {
  this.toggleEffect(this.rowCheckboxes.indexOf(evt.currentTarget), evt.currentTarget.isPressed());
};

BrushPanel.prototype.onRowClick = function(evt) {
  const rowIndex = this.rowEls.indexOf(evt.currentTarget);
  if (evt.target.tagName.toLowerCase() == "input") return;
  if (this.rowCheckboxes[rowIndex] && !this.rowCheckboxes[rowIndex].isPressed()) {
    this.rowCheckboxes[rowIndex].markActive();
    this.toggleEffect(rowIndex, true);
  }
  this.setActiveRow(rowIndex);
};

BrushPanel.prototype.toggleEffect = function(rowIndex, enabled) {
  this.effectRows[rowIndex].setEffectEnabled(enabled);
};

BrushPanel.prototype.setActiveRow = function(rowIndex) {
  for (let i = 0; i < this.effectRows.length; i++) this.rowEls[i].setAttribute("class", "listitem");
  if (this.editorEl.firstChild) this.editorEl.removeChild(this.editorEl.firstChild);
  this.rowEls[rowIndex].setAttribute("class", "listitem selected");
  this.editorEl.appendChild(this.effectRows[rowIndex].el);
};

BrushPanel.prototype.onUpdate = function(doc, popupType) {
  this.doc = doc;
  if (popupType == PopupTypes.BRUSHES || popupType == PopupTypes.ALL) {
    this.presets = doc.brushPresets;
    if (this.listEl != null) {
      for (let i = 0; i < this.effectRows.length; i++) this.effectRows[i].setPresets(this.presets);
    }
  }
  if (this.listEl == null) return;
  if (popupType == PopupTypes.SCRIPTS || popupType == PopupTypes.ALL) {
    this.brushSettings = doc.brushPresets.activeBrushPreset;
    if (this.brushSettings == null) {
      this.brushSettings = firstValidBrushPreset(doc.brushPresets);
    }
    this.redraw();
  }
  if (popupType == PopupTypes.COLOR_CHANGE) this.redraw();
};

BrushPanel.prototype.redraw = function() {
  if (this.brushSettings) this.enable();
  else {
    this.disable();
    return;
  }
  if (!isInDOM(this.panelBody)) return;
  const doc = this.doc;
  for (let i = 0; i < this.effectRows.length; i++) {
    this.effectRows[i].setValue(this.brushSettings);
    if (this.rowCheckboxes[i]) this.rowCheckboxes[i].setValue(this.effectRows[i].isPressed());
  }
  paintBrushPreview(this, doc);
};

export {
  BrushPanel,
  BrushEffectRow,
  BrushTipShapeRow,
  BrushTipDynamicsRow,
  BrushScatterRow,
  BrushColorDynamicsRow,
};

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function bindRangeInput(row, localeKey, min, max, unitSuffix, handler) {
  const input = unitSuffix == null
    ? new TextRangeInput(localeKey, min, max)
    : new TextRangeInput(localeKey, min, max, unitSuffix);
  input.on(EventType.widgetSelect, handler, row);
  row.el.appendChild(input.el);
  return input;
}

function buildPresetThumbnailUrls(presets) {
  const thumbs = [];
  const thumbW = Math.floor(30 * getDevicePixelRatio());
  const thumbH = Math.floor(40 * getDevicePixelRatio());
  for (let i = 0; i < presets.list.length; i++) {
    const preset = BrushPresetUtil.getBrushPresetFromListEntry(presets.list[i]);
    if (preset == null) continue;
    thumbs.push(BrushStroke.renderPreview(preset, presets.samples, presets.patterns, thumbW, thumbH));
  }
  return thumbs;
}

function resolvePresetAtThumbnailIndex(presets, thumbnailIndex) {
  let preset = null;
  let seen = -1;
  for (let i = 0; i < presets.list.length; i++) {
    preset = BrushPresetUtil.getBrushPresetFromListEntry(presets.list[i]);
    if (preset == null) continue;
    seen++;
    if (seen == thumbnailIndex) break;
    preset = null;
  }
  return preset;
}

function detachAllTipInputs(row) {
  for (let i = 0; i < row.inputs.length; i++) {
    if (row.el.contains(row.inputs[i].el)) row.el.removeChild(row.inputs[i].el);
  }
}

function syncTipShapeInputs(row, brush) {
  const brushKindChanged = brush.classID != row.lastBrushKind;
  row.lastBrushKind = brush.classID;
  if (brushKindChanged) detachAllTipInputs(row);
  row.sizeInput.setValue(brush.diameter.v.val);
  if (brushKindChanged) row.el.appendChild(row.sizeInput.el);
  row.angleInput.setValue(brush.Angl.v.val);
  if (brushKindChanged) row.el.appendChild(row.angleInput.el);
  if (brush.classID == "computedBrush" || brush.classID == "sampledBrush") {
    row.roundnessInput.setValue(brush.Rndn.v.val);
    if (brushKindChanged) row.el.appendChild(row.roundnessInput.el);
  }
  if (brush.classID == "computedBrush") {
    row.hardnessInput.setValue(brush.Hrdn.v.val);
    if (brushKindChanged) row.el.appendChild(row.hardnessInput.el);
  }
  row.spacingInput.setValue(brush.Spcn.v.val);
  if (brushKindChanged) row.el.appendChild(row.spacingInput.el);
}

function installEffectRowSidebar(panel) {
  const onRowClick = panel.onRowClick.bind(panel);
  for (let i = 0; i < panel.effectRows.length; i++) {
    const rowEl = makeElement("div", "listitem");
    const labelKey = panel.effectRows[i].labelKey;
    let checkbox = null;
    if (i == 0) {
      panel.tipShapeLabel = new Label(labelKey);
      rowEl.appendChild(panel.tipShapeLabel.el);
    } else {
      checkbox = new Checkbox(labelKey, false);
      checkbox.on(EventType.widgetSelect, panel.onCheckboxChange, panel);
      rowEl.appendChild(checkbox.el);
    }
    panel.rowCheckboxes.push(checkbox);
    panel.listEl.appendChild(rowEl);
    panel.rowEls.push(rowEl);
    rowEl.addEventListener("click", onRowClick, false);
  }
}

function firstValidBrushPreset(brushPresets) {
  for (let i = 0; i < brushPresets.list.length; i++) {
    const preset = BrushPresetUtil.getBrushPresetFromListEntry(brushPresets.list[i]);
    if (preset != null) return preset;
  }
  return null;
}

function paintBrushPreview(panel, doc) {
  const clampedBrush = JSON.parse(JSON.stringify(panel.brushSettings));
  clampedBrush.Brsh.v.diameter.v.val = Math.min(clampedBrush.Brsh.v.diameter.v.val, 50);
  const previewRect = new Rect(0, 0, panel.previewCanvas.width, panel.previewCanvas.height);
  const stroke = new BrushStroke(
    clampedBrush,
    panel.presets ? panel.presets.samples : null,
    panel.presets ? panel.presets.patterns : null,
    { opacity: 1 },
    doc.colorInt,
    doc.bgColor,
    previewRect
  );
  const margin = 40 * getDevicePixelRatio();
  const strokeLen = 300 * getDevicePixelRatio();
  stroke.moveTo(margin, margin);
  for (let x = 0; x <= strokeLen; x += 10) {
    stroke.lineTo(margin + x, margin + 20 * Math.sin(2 * Math.PI * x / strokeLen));
  }
  stroke.finish();
  const imageData = panel.previewCtx.createImageData(previewRect.width, previewRect.height);
  copyPixels(stroke.getBuffer(), stroke.getSelectionRect(), imageData.data, previewRect);
  panel.previewCtx.putImageData(imageData, 0, 0);
}
