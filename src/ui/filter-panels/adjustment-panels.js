/**
 * FilterParameterPanel subclasses for PSD adjustment filters
 * (`brit`, `curv`, `levl`, `hue2`, …). Each constructor key matches the
 * FilterDefs / adjustment id used when opening the filter dialog.
 *
 * Wire keys on descriptors (`Brgh`, `ShdL`, `Clrz`, `Hrzn`, …) stay as PSD
 * FourCC / TypeID names.
 */
import { Point } from "../../core/math/point.js";
import { Locale } from "../../core/i18n/locale.js";
import { BlendModes } from "../../document/model/blend-modes.js";

import {
  SelectiveColorParser,
  CurvesParser,
  HueSaturationParser,
  LevelsParser,
} from "../../document/formats/psd/adjustment-parsers.js";
import { AdjustmentEngine } from "../../features/adjustments/adjustment-engine.js";
import { FilterDefs } from "../../features/filters/filter-apply.js";
import { PopupTypes } from "../config/popup-types.js";
import { CurveEditor } from "../widgets/controls/canvas-widgets.js";
import { ColorSampleWidget } from "../widgets/controls/color-controls.js";
import { TextRangeInput } from "../widgets/controls/number-inputs.js";
import { ICCProfileButton } from "../widgets/controls/panel-widgets.js";
import { Dropdown, GradientPickerButton, IconRenderer } from "../widgets/controls/popup-controls.js";
import { Checkbox, Label, TextInput } from "../widgets/form-controls.js";
import { FilterParameterPanel } from "./filter-parameter-panel.js";
import { ThemeConfig } from "../config/theme-config.js";
import { EventType } from "../../core/event-bus.js";
import { addPointerDownListener, addPointerMoveListener, addPointerUpListener, appendBreak, disableTouchGestures, getEventPos, makeElement, removePointerMoveListener, removePointerUpListener, resizeCanvasForDevicePixelRatio } from "../../core/dom.js";
import { EyedropperTool } from "../../document/tools/view-tools.js";
import { rgbToHsv, rgbToLab } from "../../engine/compositing/color-math.js";
import { psdColorToRgb } from "../../engine/compositing/psd-color-utils.js";

const CURVE_HISTOGRAM_SCALE = [1, .33, .33, .33];

function cloneDescriptor(value) {
  return JSON.parse(JSON.stringify(value));
}

function unpackPackedRgb(packedColor) {
  return [
    packedColor >>> 16 & 255,
    packedColor >>> 8 & 255,
    packedColor & 255,
  ];
}

function copyLabToWireColor(labColor, wireColor) {
  wireColor.Lmnc.v = labColor.labL;
  wireColor.A.v = labColor.labA;
  wireColor.B.v = labColor.labB;
}

/** Midtone handle position between black/white input points (0…1). */
function gammaHandleFraction(gammaPercent) {
  let gammaHandleT = Math.log(gammaPercent / 100) / Math.log(9.99);
  return .5 - gammaHandleT / 2;
}

function gammaPercentFromInputSpan(levelFromX, blackLevel, whiteLevel) {
  let gammaT = (levelFromX - blackLevel) / (whiteLevel - blackLevel);
  gammaT = 1 - 2 * gammaT;
  gammaT = Math.pow(9.99, gammaT);
  return Math.min(999, Math.max(10, Math.round(gammaT * 100)));
}

function paintHandleSquare(ctx2d, handlePoint, fillColor) {
  ctx2d.fillStyle = fillColor;
  ctx2d.fillRect(handlePoint.x - 5, handlePoint.y, 10, 10);
  // Outline keeps the black and white level markers legible against a plate
  // of either polarity.
  ctx2d.strokeStyle = ThemeConfig.getCanvasPalette().handleStroke;
  ctx2d.lineWidth = 1;
  ctx2d.strokeRect(handlePoint.x - 4.5, handlePoint.y + 0.5, 9, 9);
}

function mergeRgbHistogramThroughLuts(channelHistograms, levelsDescriptor) {
  channelHistograms[0].fill(0);
  const mergedDescriptor = cloneDescriptor(levelsDescriptor);
  LevelsParser.setChannelLevel(mergedDescriptor, 0, [0, 255, 0, 255, 100]);
  const shaderOptions = AdjustmentEngine.buildShaderOptions("levl", mergedDescriptor);
  const perChannelLuts = [shaderOptions.lutR, shaderOptions.lutG, shaderOptions.lutB];
  for (let lutIdx = 0; lutIdx < 3; lutIdx++) {
    const channelHistogram = channelHistograms[1 + lutIdx];
    const channelLut = perChannelLuts[lutIdx];
    for (let binIdx = 0; binIdx < 256; binIdx++) {
      channelHistograms[0][channelLut[binIdx]] += channelHistogram[binIdx];
    }
  }
}

function paintHistogramBars(ctx2d, canvasWidth, canvasHeight, activeHistogram) {
  let histogramSum = 0;
  for (let binIdx = 0; binIdx < activeHistogram.length; binIdx++) {
    histogramSum += activeHistogram[binIdx];
  }
  ctx2d.fillStyle = ThemeConfig.getCanvasPalette().histogram;
  ctx2d.beginPath();
  ctx2d.moveTo(8, canvasHeight - 16);
  for (let binIdx = 0; binIdx < 256; binIdx++) {
    const barHeight = 55 * activeHistogram[binIdx] / histogramSum;
    ctx2d.lineTo(
      8 + binIdx / 256 * (canvasWidth - 16),
      Math.max(8, canvasHeight - 16 - canvasHeight * barHeight),
    );
  }
  ctx2d.lineTo(canvasWidth - 8, canvasHeight - 16);
  ctx2d.closePath();
  ctx2d.fill();
}

// --- Color Balance ----------------------------------------------------------

FilterParameterPanel.blnc = function() {
  FilterParameterPanel.call(this);
  const panelEl = this.el;
  this.balanceDescriptor = null;
  this.dropdown = new Dropdown("properties.range", [
    "styleOptions.toneRange.shadows",
    "styleOptions.toneRange.midtones",
    "styleOptions.toneRange.highlights",
  ]);
  this.dropdown.on(EventType.widgetSelect, this.redraw, this);
  panelEl.appendChild(this.dropdown.el);
  this.rgbInputs = [];
  for (let channelIdx = 0; channelIdx < 3; channelIdx++) {
    const rgbInput = new TextRangeInput(AdjustmentEngine.rgbColorLabels[channelIdx], -100, 100);
    rgbInput.on(EventType.widgetSelect, this.refresh, this);
    this.rgbInputs.push(rgbInput);
    panelEl.appendChild(rgbInput.el);
  }
  this.preserveLuminosityCheckbox = new Checkbox("colour.preserveLuminosity");
  this.preserveLuminosityCheckbox.on(EventType.widgetSelect, this.refresh, this);
  panelEl.appendChild(this.preserveLuminosityCheckbox.el);
};
FilterParameterPanel.blnc.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.blnc.prototype.buildUI = function() {
  this.dropdown.buildUI();
  for (let channelIdx = 0; channelIdx < 3; channelIdx++) this.rgbInputs[channelIdx].buildUI();
  this.preserveLuminosityCheckbox.buildUI();
};
FilterParameterPanel.blnc.prototype.setValue = function(descriptor) {
  this.balanceDescriptor = cloneDescriptor(descriptor);
  this.redraw();
};
FilterParameterPanel.blnc.prototype.getValue = function(unusedDescriptor) {
  const rangeWireKeys = ["ShdL", "MdtL", "HghL"];
  const activeRangeValues = this.balanceDescriptor[rangeWireKeys[this.dropdown.getValue()]].v;
  for (let channelIdx = 0; channelIdx < 3; channelIdx++) {
    activeRangeValues[channelIdx].v = this.rgbInputs[channelIdx].getValue();
  }
  this.balanceDescriptor.PrsL.v = this.preserveLuminosityCheckbox.getValue();
  return cloneDescriptor(this.balanceDescriptor);
};
FilterParameterPanel.blnc.prototype.redraw = function(unusedEvt) {
  const rangeWireKeys = ["ShdL", "MdtL", "HghL"];
  const activeRangeValues = this.balanceDescriptor[rangeWireKeys[this.dropdown.getValue()]].v;
  for (let channelIdx = 0; channelIdx < 3; channelIdx++) {
    this.rgbInputs[channelIdx].setValue(activeRangeValues[channelIdx].v);
  }
  this.preserveLuminosityCheckbox.setValue(this.balanceDescriptor.PrsL.v);
};

// --- Brightness / Contrast --------------------------------------------------

FilterParameterPanel.brit = function() {
  FilterParameterPanel.call(this, "brit");
  this.paramWidgets.push(new TextRangeInput("properties.brightness", -150, 150, ""));
  this.paramWidgets.push(new TextRangeInput("properties.contrast", -100, 100, ""));
  this.paramWidgets.push(new Checkbox("properties.useLegacy"));
  this.mountFormLayout()
};
FilterParameterPanel.brit.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.brit.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.Brgh ? descriptor.Brgh.v : 0;
  values[1] = descriptor.Cntr ? descriptor.Cntr.v : 0;
  values[2] = descriptor.useLegacy ? descriptor.useLegacy.v : false;
};
FilterParameterPanel.brit.prototype.getFields = function(descriptor, values) {
  descriptor.Brgh.v = values[0];
  descriptor.Cntr.v = values[1];
  descriptor.useLegacy.v = values[2];
};

// --- Curves -----------------------------------------------------------------

FilterParameterPanel.curv = function() {
  FilterParameterPanel.call(this);
  this.value = null;
  this.channelHistograms = null;
  const panelEl = this.el;
  this.channelDropdown = new Dropdown("properties.channel", [
    "RGB",
    "colour.labels.red",
    "colour.labels.green",
    "colour.labels.blue",
  ]);
  this.channelDropdown.on(EventType.widgetSelect, this.redraw, this);
  panelEl.appendChild(this.channelDropdown.el);
  this.curveModeDropdown = new Dropdown(null, ["filters.options.spline", "filters.gallery.groups.sketch"]);
  this.curveModeDropdown.on(EventType.widgetSelect, this.onCurveModeChange, this);
  panelEl.appendChild(this.curveModeDropdown.el);
  this.curveEditor = new CurveEditor();
  this.curveEditor.on(EventType.widgetSelect, this.syncCurveFromDescriptor, this);
  panelEl.appendChild(this.curveEditor.el);
  this.sampleIconRenderer = new IconRenderer("filters.options.sampleFromImage", ["#000000", "#888888", "#ffffff"]);
  panelEl.appendChild(this.sampleIconRenderer.el);
};
FilterParameterPanel.curv.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.curv.prototype.buildUI = function() {
  this.channelDropdown.buildUI();
};
FilterParameterPanel.curv.prototype.onCurveModeChange = function(unusedEvt) {
  const masterCurve = CurvesParser.getChannelCurve(this.value, 0);
  const curveModeFlag = masterCurve.length == 256 ? 1 : 0;
  const targetMode = this.curveModeDropdown.getValue();
  if (curveModeFlag == targetMode) return;
  const freshDescriptor = FilterDefs.create("curv");
  if (targetMode == 1) {
    const identityCurve = [];
    for (let curveIdx = 0; curveIdx < 256; curveIdx++) identityCurve.push(curveIdx);
    CurvesParser.setChannelCurve(freshDescriptor, 0, identityCurve);
  }
  this.setValue(freshDescriptor);
  this.refresh();
};
FilterParameterPanel.curv.prototype.syncCurveFromDescriptor = function() {
  CurvesParser.setChannelCurve(this.value, this.channelDropdown.getValue(), this.curveEditor.getValue());
  this.refresh();
};
FilterParameterPanel.curv.prototype.redraw = function() {
  const channelIndex = this.channelDropdown.getValue();
  const channelCurve = CurvesParser.getChannelCurve(this.value, channelIndex);
  const curveModeFlag = channelCurve.length == 256 ? 1 : 0;
  this.curveModeDropdown.setValue(curveModeFlag);
  if (this.channelHistograms) {
    this.curveEditor.setHistogramOverlay(
      this.channelHistograms[channelIndex],
      this.channelHistograms[4] * CURVE_HISTOGRAM_SCALE[channelIndex],
      ThemeConfig.getCanvasPalette().histogramChannels[channelIndex],
    );
  }
  this.curveEditor.setValue(channelCurve);
};
FilterParameterPanel.curv.prototype.hasOverlay = function() {
  return true;
};
FilterParameterPanel.curv.prototype.onMouseUp = function(doc, unusedMode, unusedView, unusedModifier, pointerPos) {
  const savedDescriptor = this.value;
  const sampleModeIndex = this.sampleIconRenderer.getValue();
  this.value = FilterDefs.create("curv");
  this.refresh();
  const rgbSamples = unpackPackedRgb(EyedropperTool.sampleCompositeColor(doc, pointerPos, 1));
  for (let channelIdx = 0; channelIdx < 3; channelIdx++) {
    const channelCurve = CurvesParser.getChannelCurve(savedDescriptor, 1 + channelIdx);
    if (sampleModeIndex == 0) channelCurve[0].v.Hrzn.v = rgbSamples[channelIdx];
    if (sampleModeIndex == 1) {
      const grayAverage = (rgbSamples[0] + rgbSamples[1] + rgbSamples[2]) * .333;
      const logRatio = Math.log(rgbSamples[channelIdx] / 255) / Math.log(grayAverage / 255);
      const mappedValue = Math.min(999, Math.max(10, Math.round(100 * logRatio)));
      if (channelCurve.length == 2) channelCurve.splice(1, 0, cloneDescriptor(channelCurve[0]));
      channelCurve[1].v.Hrzn.v = 127 - Math.log(mappedValue / 100) * 127;
      channelCurve[1].v.Vrtc.v = 127;
    }
    if (sampleModeIndex == 2) channelCurve[channelCurve.length - 1].v.Hrzn.v = rgbSamples[channelIdx];
    CurvesParser.setChannelCurve(savedDescriptor, 1 + channelIdx, channelCurve);
  }
  this.setValue(savedDescriptor);
  this.refresh();
};
FilterParameterPanel.curv.prototype.setValue = function(descriptor) {
  this.value = descriptor;
  this.redraw();
};
FilterParameterPanel.curv.prototype.setChannelHistograms = function(histograms) {
  this.channelHistograms = histograms;
  this.redraw();
};
FilterParameterPanel.curv.prototype.getValue = function(unusedDescriptor) {
  return cloneDescriptor(this.value);
};

// --- Exposure ---------------------------------------------------------------

FilterParameterPanel.expA = function() {
  FilterParameterPanel.call(this, "expA");
  this.paramWidgets.push(new TextRangeInput("properties.exposure", -20, 20, null, 3));
  this.paramWidgets.push(new TextRangeInput("properties.offset", -.5, .5, null, 3));
  this.paramWidgets.push(new TextRangeInput("properties.gammaCorrection", .01, 6.99, null, 3));
  this.mountFormLayout()
};
FilterParameterPanel.expA.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.expA.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.Exps.v;
  values[1] = descriptor.Ofst.v;
  values[2] = descriptor.gammaCorrection.v;
};
FilterParameterPanel.expA.prototype.getFields = function(descriptor, values) {
  descriptor.Exps.v = values[0];
  descriptor.Ofst.v = values[1];
  descriptor.gammaCorrection.v = values[2];
};

// --- Gradient Map -----------------------------------------------------------

FilterParameterPanel.grdm = function() {
  FilterParameterPanel.call(this, "grdm");
  this.paramWidgets.push(new GradientPickerButton(true, null, true));
  this.paramWidgets.push(new Checkbox("properties.reverse"));
  this.mountFormLayout()
};
FilterParameterPanel.grdm.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.grdm.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.Grad.v;
  values[1] = descriptor.Rvrs ? descriptor.Rvrs.v : false;
};
FilterParameterPanel.grdm.prototype.getFields = function(descriptor, values) {
  descriptor.Grad.v = values[0];
  descriptor.Rvrs = {
    t: "bool",
    v: values[1],
  };
};
FilterParameterPanel.grdm.prototype.onUpdate = function(doc, popupType) {
  this.paramWidgets[0].setContextColors(doc.colorInt, doc.bgColor);
  if (popupType == PopupTypes.ALL || popupType == PopupTypes.COLOR_CHANGE || popupType == PopupTypes.GRADIENTS) {
    this.paramWidgets[0].setPresets(doc.gradientPresets);
  }
};

// --- Selective Color --------------------------------------------------------

FilterParameterPanel.selc = function() {
  FilterParameterPanel.call(this);
  const panelEl = this.el;
  this.cmykInputs = [];
  this.selectiveDescriptor = null;
  this.dropdown = new Dropdown("properties.colours", AdjustmentEngine.hueSatColorLabels.concat([
    "colour.labels.white",
    "colour.labels.neutral",
    "colour.labels.black",
  ]));
  this.dropdown.on(EventType.widgetSelect, this.emitChange, this);
  panelEl.appendChild(this.dropdown.el);
  for (let inputIdx = 0; inputIdx < 4; inputIdx++) {
    const cmykInput = new TextRangeInput(AdjustmentEngine.cmykColorLabels[inputIdx], -100, 100, "%");
    cmykInput.on(EventType.widgetSelect, this.emitChange, this);
    this.cmykInputs.push(cmykInput);
    panelEl.appendChild(cmykInput.el);
  }
  this.absoluteCheckbox = new Checkbox("colour.absolute");
  panelEl.appendChild(this.absoluteCheckbox.el);
  this.absoluteCheckbox.on(EventType.widgetSelect, this.emitChange, this);
};
FilterParameterPanel.selc.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.selc.prototype.buildUI = function() {
  this.dropdown.buildUI();
  this.absoluteCheckbox.buildUI();
  for (let inputIdx = 0; inputIdx < 4; inputIdx++) this.cmykInputs[inputIdx].buildUI();
};
FilterParameterPanel.selc.prototype.setValue = function(descriptor) {
  this.selectiveDescriptor = cloneDescriptor(descriptor);
  this.redraw();
};
FilterParameterPanel.selc.prototype.getValue = function(unusedDescriptor) {
  return cloneDescriptor(this.selectiveDescriptor);
};
FilterParameterPanel.selc.prototype.emitChange = function(widgetEvt) {
  if (widgetEvt.target != this.dropdown) {
    const selectiveDesc = this.selectiveDescriptor;
    const cmykValues = [];
    for (let inputIdx = 0; inputIdx < 4; inputIdx++) cmykValues[inputIdx] = this.cmykInputs[inputIdx].getValue();
    SelectiveColorParser.apply(selectiveDesc, this.dropdown.getValue(), cmykValues);
    selectiveDesc.Mthd = {
      t: "enum",
      v: {
        CrcM: this.absoluteCheckbox.getValue() ? "Absl" : "Rltv",
      },
    };
  }
  this.redraw();
  this.refresh();
};
FilterParameterPanel.selc.prototype.redraw = function() {
  const selectiveDesc = this.selectiveDescriptor;
  const extractedValues = SelectiveColorParser.extract(selectiveDesc, this.dropdown.getValue());
  for (let inputIdx = 0; inputIdx < 4; inputIdx++) this.cmykInputs[inputIdx].setValue(extractedValues[inputIdx]);
  this.absoluteCheckbox.setValue(selectiveDesc.Mthd ? selectiveDesc.Mthd.v.CrcM == "Absl" : false);
};

// --- Black & White ----------------------------------------------------------

FilterParameterPanel.blwh = function() {
  FilterParameterPanel.call(this, "blwh");
  this.paramWidgets.push(new Checkbox("properties.colourise"));
  this.paramWidgets.push(new ColorSampleWidget(true));
  for (let colorIdx = 0; colorIdx < 6; colorIdx++) {
    this.paramWidgets.push(new TextRangeInput(AdjustmentEngine.hueSatColorLabels[colorIdx], -200, 300));
  }
  this.mountFormLayout()
};
FilterParameterPanel.blwh.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.blwh.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.useTint.v;
  values[1] = descriptor.tintColor.v;
  const channelWireKeys = "Rd Yllw Grn Cyn Bl Mgnt".split(" ");
  for (let channelIdx = 0; channelIdx < 6; channelIdx++) {
    values[2 + channelIdx] = descriptor[channelWireKeys[channelIdx]].v;
  }
};
FilterParameterPanel.blwh.prototype.getFields = function(descriptor, values) {
  descriptor.useTint.v = values[0];
  descriptor.tintColor.v = values[1];
  const channelWireKeys = "Rd Yllw Grn Cyn Bl Mgnt".split(" ");
  for (let channelIdx = 0; channelIdx < 6; channelIdx++) {
    descriptor[channelWireKeys[channelIdx]].v = values[2 + channelIdx];
  }
};

// --- Hue / Saturation -------------------------------------------------------

FilterParameterPanel.hue2 = function() {
  FilterParameterPanel.call(this);
  this.value = null;
  this.saturationDragStartX = null;
  this.saturationAtDragStart = null;
  const panelEl = this.el;
  this.dropdown = new Dropdown("properties.range", ["filters.options.master"].concat(AdjustmentEngine.hueSatColorLabels));
  this.dropdown.on(EventType.widgetSelect, this.redraw, this);
  panelEl.appendChild(this.dropdown.el);
  this.hueInput = new TextRangeInput("properties.hue", -180, 180);
  this.hueInput.on(EventType.widgetSelect, this.onHslInputChange, this);
  panelEl.appendChild(this.hueInput.el);
  this.saturationInput = new TextRangeInput("properties.saturation", -100, 100);
  this.saturationInput.on(EventType.widgetSelect, this.onHslInputChange, this);
  panelEl.appendChild(this.saturationInput.el);
  this.lightnessInput = new TextRangeInput("properties.lightness", -100, 100);
  this.lightnessInput.on(EventType.widgetSelect, this.onHslInputChange, this);
  panelEl.appendChild(this.lightnessInput.el);
  this.colorizeCheckbox = new Checkbox("properties.colourise");
  this.colorizeCheckbox.on(EventType.widgetSelect, this.onColorizeToggle, this);
  panelEl.appendChild(this.colorizeCheckbox.el);
  this.applySummaryLabel = new Label("...", true);
  panelEl.appendChild(this.applySummaryLabel.el)
};
FilterParameterPanel.hue2.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.hue2.prototype.buildUI = function() {
  this.hueInput.buildUI();
  this.saturationInput.buildUI();
  this.lightnessInput.buildUI();
  this.colorizeCheckbox.buildUI();
  this.dropdown.buildUI();
};
FilterParameterPanel.hue2.prototype.onColorizeToggle = function(unusedEvt) {
  const colorizeEnabled = this.colorizeCheckbox.getValue();
  this.value.Clrz.v = colorizeEnabled;
  if (colorizeEnabled) this.dropdown.setValue(0);
  this.redraw();
  this.refresh();
};
FilterParameterPanel.hue2.prototype.onHslInputChange = function(unusedEvt) {
  const colorizeEnabled = this.value.Clrz.v;
  const rangeIndex = this.dropdown.getValue();
  const channelData = HueSaturationParser.getChannelData(this.value, rangeIndex);
  const hslShift = rangeIndex == 0 ? channelData : channelData.hslShift;
  hslShift[0] = this.hueInput.getValue();
  const saturationValue = this.saturationInput.getValue();
  hslShift[1] = colorizeEnabled ? Math.max(0, saturationValue) : saturationValue;
  hslShift[2] = this.lightnessInput.getValue();
  HueSaturationParser.setChannelData(this.value, rangeIndex, channelData);
  this.redraw();
  this.refresh();
};
FilterParameterPanel.hue2.prototype.redraw = function() {
  const colorizeEnabled = this.value.Clrz ? this.value.Clrz.v : false;
  let applySummary = "";
  this.colorizeCheckbox.setValue(colorizeEnabled);
  if (colorizeEnabled) this.dropdown.disable();
  else this.dropdown.enable();
  let rangeIndex = this.dropdown.getValue();
  const channelData = HueSaturationParser.getChannelData(this.value, rangeIndex);
  const hslShift = rangeIndex == 0 ? channelData : channelData.hslShift;
  this.hueInput.setValue(hslShift[0]);
  this.saturationInput.setValue(hslShift[1]);
  this.lightnessInput.setValue(hslShift[2]);
  if (!colorizeEnabled) {
    applySummary += Locale.get("clipboard.apply") + ": ";
    rangeIndex = this.dropdown.getValue();
    if (rangeIndex == 0) applySummary += Locale.get("colour.total");
    else applySummary += channelData.bounds;
  }
  this.applySummaryLabel.setValue(applySummary);
};
FilterParameterPanel.hue2.prototype.hasOverlay = function() {
  return true;
};
FilterParameterPanel.hue2.prototype.onMouseDown = function(doc, unusedMode, unusedView, unusedModifier, pointerPos) {
  const savedDescriptor = this.value;
  this.value = FilterDefs.create("hue2");
  this.refresh();
  const rgbSamples = unpackPackedRgb(EyedropperTool.sampleCompositeColor(doc, pointerPos, 1));
  const hsvSample = rgbToHsv(rgbSamples[0] / 255, rgbSamples[1] / 255, rgbSamples[2] / 255);
  this.dropdown.setValue(1 + Math.round(hsvSample.hue * 6) % 6);
  this.setValue(savedDescriptor);
  this.refresh();
  this.saturationDragStartX = pointerPos.x;
  this.saturationAtDragStart = this.saturationInput.getValue();
};
FilterParameterPanel.hue2.prototype.onMouseMove = function(doc, unusedMode, unusedView, unusedModifier, pointerPos) {
  if (this.saturationDragStartX != null) {
    let deltaX = pointerPos.x - this.saturationDragStartX;
    deltaX = Math.max(-100, Math.min(100, this.saturationAtDragStart + .5 * deltaX));
    this.saturationInput.setValue(deltaX);
    this.onHslInputChange();
  }
};
FilterParameterPanel.hue2.prototype.onMouseUp = function(doc, unusedMode, unusedView, unusedModifier, pointerPos) {
  this.saturationDragStartX = null;
};
FilterParameterPanel.hue2.prototype.setValue = function(descriptor) {
  this.value = cloneDescriptor(descriptor);
  this.redraw();
};
FilterParameterPanel.hue2.prototype.getValue = function(unusedDescriptor) {
  return cloneDescriptor(this.value);
};

// --- Levels -----------------------------------------------------------------

FilterParameterPanel.levl = function() {
  FilterParameterPanel.call(this);
  this.value = null;
  this.channelHistograms = null;
  this.handlePoints = [new Point(0, 0), new Point(0, 0), new Point(0, 0), new Point(0, 0), new Point(0, 0)];
  this.activeHandleIndex = -1;
  this.boundHandleDragMove = this.onHandleDragMove.bind(this);
  this.boundHandleDragEnd = this.onHandleDragEnd.bind(this);
  const panelEl = this.el;
  this.channelDropdown = new Dropdown("properties.channel", [
    "RGB",
    "colour.labels.red",
    "colour.labels.green",
    "colour.labels.blue",
  ]);
  this.channelDropdown.on(EventType.widgetSelect, this.redraw, this);
  panelEl.appendChild(this.channelDropdown.el);
  // `levelsrow` lays the plate across the full width and drops the level
  // fields onto a three-column track so each sits under its handle.
  const histogramRowEl = makeElement("div", "levelsrow");
  panelEl.appendChild(histogramRowEl);
  const outputRowEl = makeElement("div", "levelsrow levelsrow-output");
  panelEl.appendChild(outputRowEl);
  this.canvas = makeElement("canvas");
  histogramRowEl.appendChild(this.canvas);
  this.ctx2d = this.canvas.getContext("2d");
  this.histogramCanvasSize = new Point(256, 120);
  this.canvas.setAttribute("style", "display:block");
  resizeCanvasForDevicePixelRatio(this.canvas, this.histogramCanvasSize.x, this.histogramCanvasSize.y, this.ctx2d);
  disableTouchGestures(this.canvas);
  addPointerDownListener(this.canvas, this.onAutoLevels.bind(this));
  this.outputCanvas = makeElement("canvas", "");
  outputRowEl.appendChild(this.outputCanvas);
  this.outputCtx2d = this.outputCanvas.getContext("2d");
  this.outputCanvasSize = new Point(this.histogramCanvasSize.x, 40);
  this.outputCanvas.setAttribute("style", "display:block");
  resizeCanvasForDevicePixelRatio(this.outputCanvas, this.outputCanvasSize.x, this.outputCanvasSize.y, this.outputCtx2d);
  disableTouchGestures(this.outputCanvas);
  addPointerDownListener(this.outputCanvas, this.onResetChannel.bind(this));
  const levelInputs = this.levelInputs = [];
  for (let inputIdx = 0; inputIdx < 5; inputIdx++) {
    const textInput = new TextInput(null, null, 3);
    levelInputs.push(textInput);
    textInput.on(EventType.widgetSelect, this.onChannelSelect, this);
    (inputIdx < 2 || inputIdx == 4 ? histogramRowEl : outputRowEl).appendChild(textInput.el);
  }
  histogramRowEl.appendChild(levelInputs[1].el);
  this.sampleIconRenderer = new IconRenderer("filters.options.sampleFromImage", ["#000000", "#888888", "#ffffff"]);
  panelEl.appendChild(this.sampleIconRenderer.el);
};
FilterParameterPanel.levl.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.levl.prototype.buildUI = function() {
  this.channelDropdown.buildUI();
};
FilterParameterPanel.levl.prototype.onChannelSelect = function(unusedEvt) {
  const clampedLevels = [];
  for (let inputIdx = 0; inputIdx < 5; inputIdx++) {
    let maxValue = 255;
    let scale = 1;
    if (inputIdx == 4) {
      maxValue = 999;
      scale = 100;
    }
    const parsedValue = parseFloat(this.levelInputs[inputIdx].getValue());
    clampedLevels[inputIdx] = Math.max(0, Math.min(maxValue, parsedValue * scale));
  }
  LevelsParser.setChannelLevel(this.value, this.channelDropdown.getValue(), clampedLevels);
  this.redraw();
  this.refresh();
};
FilterParameterPanel.levl.prototype.redraw = function(unusedEvt) {
  const canvasWidth = this.histogramCanvasSize.x;
  const canvasHeight = this.histogramCanvasSize.y;
  const channelIndex = this.channelDropdown.getValue();
  const histogramCtx = this.ctx2d;
  histogramCtx.clearRect(0, 0, canvasWidth, canvasHeight);
  const levelsPalette = ThemeConfig.getCanvasPalette();
  histogramCtx.fillStyle = levelsPalette.plate;
  histogramCtx.fillRect(8, 8, canvasWidth - 16, canvasHeight - 16 - 8);
  histogramCtx.strokeStyle = levelsPalette.frame;
  histogramCtx.lineWidth = 1;
  histogramCtx.strokeRect(8.5, 8.5, canvasWidth - 17, canvasHeight - 25);
  if (this.channelHistograms) {
    if (channelIndex == 0) {
      mergeRgbHistogramThroughLuts(this.channelHistograms, this.value);
    }
    paintHistogramBars(histogramCtx, canvasWidth, canvasHeight, this.channelHistograms[channelIndex]);
  }
  const channelLevels = LevelsParser.getChannelLevel(this.value, channelIndex);
  for (let inputIdx = 0; inputIdx < 5; inputIdx++) {
    this.levelInputs[inputIdx].setValue(channelLevels[inputIdx] / (inputIdx == 4 ? 100 : 1));
  }
  this.handlePoints[0].setXY(8 + channelLevels[0] / 255 * (canvasWidth - 16), canvasHeight - 14);
  this.handlePoints[1].setXY(8 + channelLevels[1] / 255 * (canvasWidth - 16), canvasHeight - 14);
  const gammaHandleT = gammaHandleFraction(channelLevels[4]);
  this.handlePoints[4].setXY(
    this.handlePoints[0].x + gammaHandleT * (this.handlePoints[1].x - this.handlePoints[0].x),
    canvasHeight - 14,
  );
  paintHandleSquare(histogramCtx, this.handlePoints[0], "#000000");
  paintHandleSquare(histogramCtx, this.handlePoints[1], "#ffffff");
  paintHandleSquare(histogramCtx, this.handlePoints[4], "#777777");

  const outputWidth = this.outputCanvasSize.x;
  const outputHeight = this.outputCanvasSize.y;
  const outputCtx = this.outputCtx2d;
  outputCtx.clearRect(0, 0, outputWidth, outputHeight);
  const outputGradient = outputCtx.createLinearGradient(0, 0, outputWidth - 16, 0);
  outputGradient.addColorStop(0, "black");
  outputGradient.addColorStop(1, "white");
  outputCtx.fillStyle = outputGradient;
  outputCtx.fillRect(8, 8, outputWidth - 16, 16);
  this.handlePoints[2].setXY(8 + channelLevels[2] / 255 * (outputWidth - 16), outputHeight - 14);
  this.handlePoints[3].setXY(8 + channelLevels[3] / 255 * (outputWidth - 16), outputHeight - 14);
  paintHandleSquare(outputCtx, this.handlePoints[2], "#000000");
  paintHandleSquare(outputCtx, this.handlePoints[3], "#ffffff");
};
FilterParameterPanel.levl.prototype.onEyedropperPick = function(ctx2d, handlePoint, fillColor) {
  paintHandleSquare(ctx2d, handlePoint, fillColor);
};
FilterParameterPanel.levl.prototype.onAutoLevels = function(evt) {
  const pointerPos = getEventPos(evt, this.canvas);
  for (let handleIdx = 0; handleIdx < 2; handleIdx++) {
    if (Point.dist(this.handlePoints[handleIdx], pointerPos) < 10) this.activeHandleIndex = handleIdx;
  }
  if (Point.dist(this.handlePoints[4], pointerPos) < 10) this.activeHandleIndex = 4;
  this.beginHandleDrag();
};
FilterParameterPanel.levl.prototype.onResetChannel = function(evt) {
  const pointerPos = getEventPos(evt, this.outputCanvas);
  for (let handleIdx = 2; handleIdx < 4; handleIdx++) {
    if (Point.dist(this.handlePoints[handleIdx], pointerPos) < 10) this.activeHandleIndex = handleIdx;
  }
  this.beginHandleDrag();
};
FilterParameterPanel.levl.prototype.beginHandleDrag = function() {
  if (this.activeHandleIndex == -1) return;
  addPointerMoveListener(document.body, this.boundHandleDragMove);
  addPointerUpListener(document.body, this.boundHandleDragEnd);
};
FilterParameterPanel.levl.prototype.onHandleDragMove = function(evt) {
  const channelLevels = LevelsParser.getChannelLevel(this.value, this.channelDropdown.getValue());
  const pointerPos = getEventPos(
    evt,
    this.activeHandleIndex == 2 || this.activeHandleIndex == 3 ? this.outputCanvas : this.canvas,
  );
  let levelFromX = 255 * (pointerPos.x - 8) / (this.histogramCanvasSize.x - 16);
  levelFromX = Math.max(0, Math.min(255, levelFromX));
  if (this.activeHandleIndex == 0) levelFromX = Math.min(levelFromX, channelLevels[1] - 2);
  if (this.activeHandleIndex == 1) levelFromX = Math.max(levelFromX, channelLevels[0] + 2);
  if (this.activeHandleIndex != 4) channelLevels[this.activeHandleIndex] = Math.round(levelFromX);
  else {
    channelLevels[4] = gammaPercentFromInputSpan(levelFromX, channelLevels[0], channelLevels[1]);
  }
  LevelsParser.setChannelLevel(this.value, this.channelDropdown.getValue(), channelLevels);
  this.redraw();
  this.refresh();
};
FilterParameterPanel.levl.prototype.onHandleDragEnd = function(unusedEvt) {
  removePointerMoveListener(document.body, this.boundHandleDragMove);
  removePointerUpListener(document.body, this.boundHandleDragEnd);
  this.activeHandleIndex = -1;
};
FilterParameterPanel.levl.prototype.hasOverlay = function() {
  return true;
};
FilterParameterPanel.levl.prototype.onMouseUp = function(doc, unusedMode, unusedView, unusedModifier, pointerPos) {
  const savedDescriptor = this.value;
  const sampleModeIndex = this.sampleIconRenderer.getValue();
  this.value = FilterDefs.create("levl");
  this.refresh();
  const rgbSamples = unpackPackedRgb(EyedropperTool.sampleCompositeColor(doc, pointerPos, 1));
  for (let channelIdx = 0; channelIdx < 3; channelIdx++) {
    const channelLevels = LevelsParser.getChannelLevel(savedDescriptor, 1 + channelIdx);
    if (sampleModeIndex == 0) channelLevels[0] = rgbSamples[channelIdx];
    if (sampleModeIndex == 1) {
      const logRatio = Math.log(rgbSamples[channelIdx] / 255)
        / Math.log((rgbSamples[0] + rgbSamples[1] + rgbSamples[2]) * .333 / 255);
      channelLevels[4] = Math.min(999, Math.max(10, Math.round(100 * logRatio)));
    }
    if (sampleModeIndex == 2) channelLevels[1] = rgbSamples[channelIdx];
    LevelsParser.setChannelLevel(savedDescriptor, 1 + channelIdx, channelLevels);
  }
  this.setValue(savedDescriptor);
  this.refresh();
};
FilterParameterPanel.levl.prototype.setValue = function(descriptor) {
  this.value = descriptor;
  this.redraw();
};
FilterParameterPanel.levl.prototype.setChannelHistograms = function(histograms) {
  this.channelHistograms = histograms;
  this.redraw();
};
FilterParameterPanel.levl.prototype.getValue = function(unusedDescriptor) {
  return cloneDescriptor(this.value);
};

// --- Photo Filter -----------------------------------------------------------

FilterParameterPanel.phfl = function() {
  FilterParameterPanel.call(this, "phfl");
  this.paramWidgets.push(new ColorSampleWidget);
  this.paramWidgets.push(new TextRangeInput("properties.density", 0, 100, "%"));
  this.paramWidgets.push(new Checkbox("colour.preserveLuminosity"));
  this.mountFormLayout()
};
FilterParameterPanel.phfl.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.phfl.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.Clr.v;
  values[1] = descriptor.Dnst.v;
  values[2] = descriptor.PrsL.v;
};
FilterParameterPanel.phfl.prototype.getFields = function(descriptor, values) {
  const rgbColor = psdColorToRgb(values[0]);
  const labWireColor = descriptor.Clr.v;
  const labColor = rgbToLab(rgbColor.h, rgbColor.l, rgbColor.O);
  copyLabToWireColor(labColor, labWireColor);
  descriptor.Dnst.v = values[1];
  descriptor.PrsL.v = values[2];
};

// --- Vibrance ---------------------------------------------------------------

FilterParameterPanel.vibA = function() {
  FilterParameterPanel.call(this, "vibA");
  this.paramWidgets.push(new TextRangeInput("properties.vibrance", -100, 100, null));
  this.paramWidgets.push(new TextRangeInput("properties.saturation", -100, 100, null));
  this.mountFormLayout()
};
FilterParameterPanel.vibA.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.vibA.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.vibrance ? descriptor.vibrance.v : 0;
  values[1] = descriptor.Strt ? descriptor.Strt.v : 0;
};
FilterParameterPanel.vibA.prototype.getFields = function(descriptor, values) {
  descriptor.vibrance.v = values[0];
  descriptor.Strt.v = values[1];
};

// --- Threshold --------------------------------------------------------------

FilterParameterPanel.thrs = function() {
  FilterParameterPanel.call(this, "thrs");
  this.paramWidgets.push(new TextRangeInput("adjustments.threshold", 1, 255, null));
  this.mountFormLayout()
};
FilterParameterPanel.thrs.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.thrs.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.Lvl.v;
};
FilterParameterPanel.thrs.prototype.getFields = function(descriptor, values) {
  descriptor.Lvl.v = values[0];
};

// --- Invert -----------------------------------------------------------------

FilterParameterPanel.nvrt = function() {
  FilterParameterPanel.call(this, "nvrt");
  this.mountFormLayout()
};
FilterParameterPanel.nvrt.prototype = Object.create(FilterParameterPanel.prototype);

// --- Channel Mixer ----------------------------------------------------------

FilterParameterPanel.mixr = function() {
  FilterParameterPanel.call(this);
  const panelEl = this.el;
  this.channelMixInputs = [];
  this.mixerDescriptor = null;
  this.dropdown = new Dropdown("properties.channel", [
    "colour.labels.red",
    "colour.labels.green",
    "colour.labels.blue",
  ]);
  this.dropdown.on(EventType.widgetSelect, this.emitChange, this);
  panelEl.appendChild(this.dropdown.el);
  appendBreak(panelEl);
  this.monochromaticCheckbox = new Checkbox("properties.monochromatic");
  panelEl.appendChild(this.monochromaticCheckbox.el);
  this.monochromaticCheckbox.on(EventType.widgetSelect, this.emitChange, this);
  for (let inputIdx = 0; inputIdx < 4; inputIdx++) {
    const rangeInput = new TextRangeInput([
      "colour.labels.red",
      "colour.labels.green",
      "colour.labels.blue",
      "colour.total",
    ][inputIdx], -200, 200, "%");
    rangeInput.on(EventType.widgetSelect, this.emitChange, this);
    this.channelMixInputs.push(rangeInput);
    panelEl.appendChild(rangeInput.el);
  }
};
FilterParameterPanel.mixr.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.mixr.prototype.buildUI = function() {
  this.dropdown.buildUI();
  this.monochromaticCheckbox.buildUI();
  for (let inputIdx = 0; inputIdx < 4; inputIdx++) this.channelMixInputs[inputIdx].buildUI();
};
FilterParameterPanel.mixr.prototype.setValue = function(descriptor) {
  this.mixerDescriptor = cloneDescriptor(descriptor);
  this.redraw();
};
FilterParameterPanel.mixr.prototype.getValue = function(unusedDescriptor) {
  return cloneDescriptor(this.mixerDescriptor);
};
FilterParameterPanel.mixr.prototype.emitChange = function(widgetEvt) {
  if (widgetEvt.target != this.dropdown) {
    const mixerData = AdjustmentEngine.parseChannelMixer(this.mixerDescriptor);
    if (widgetEvt.target == this.monochromaticCheckbox) {
      mixerData.isMonochrome = this.monochromaticCheckbox.getValue();
      if (mixerData.isMonochrome) {
        mixerData.channelValues = [40, 40, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      } else {
        mixerData.channelValues = [100, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0];
      }
    } else {
      const channelBaseOffset = (mixerData.isMonochrome ? 0 : this.dropdown.getValue()) * 5;
      const inputIdx = this.channelMixInputs.indexOf(widgetEvt.target);
      mixerData.channelValues[channelBaseOffset + (inputIdx < 3 ? inputIdx : 4)] = widgetEvt.target.getValue();
    }
    this.mixerDescriptor = AdjustmentEngine.channelMixerToDescriptor(mixerData);
  }
  this.redraw();
  this.refresh();
};
FilterParameterPanel.mixr.prototype.redraw = function() {
  const mixerData = AdjustmentEngine.parseChannelMixer(this.mixerDescriptor);
  this.monochromaticCheckbox.setValue(mixerData.isMonochrome);
  const channelBaseOffset = (mixerData.isMonochrome ? 0 : this.dropdown.getValue()) * 5;
  for (let inputIdx = 0; inputIdx < 4; inputIdx++) {
    this.channelMixInputs[inputIdx].setValue(mixerData.channelValues[channelBaseOffset + (inputIdx < 3 ? inputIdx : 4)]);
  }
};

// --- Posterize --------------------------------------------------------------

FilterParameterPanel.post = function() {
  FilterParameterPanel.call(this, "post");
  this.paramWidgets.push(new TextRangeInput("adjustments.levels", 2, 255, null));
  this.mountFormLayout()
};
FilterParameterPanel.post.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.post.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.Lvls.v;
};
FilterParameterPanel.post.prototype.getFields = function(descriptor, values) {
  descriptor.Lvls.v = values[0];
};

// --- Color Lookup -----------------------------------------------------------
// Remaps colours through a 3D LUT (ICC abstract profile / .CUBE / .3DL / .look).
// The panel is a single LUT picker; choosing a preset writes `profile` (+ Nm,
// Dthr, lookupType) onto the colorLookup descriptor for AdjustmentEngine.

FilterParameterPanel.clrL = function() {
  FilterParameterPanel.call(this, "clrL");
  this.paramWidgets.push(new ICCProfileButton("filters.options.luts"));
  this.mountFormLayout()
};
FilterParameterPanel.clrL.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.clrL.prototype.setFields = function(descriptor, values) {
  // Reset / default descriptors have no profile — push the empty picker chip so
  // the LUT label clears instead of keeping the previous file name.
  values[0] = descriptor && descriptor.profile ? descriptor : {
    classID: "null",
    Dthr: {
      t: "bool",
      v: true
    },
    Nm: {
      t: "TEXT",
      v: "ICC / 3DL / look / cube"
    },
    lookupType: {
      t: "enum",
      v: {
        colorLookupType: "abstractProfile"
      }
    }
  };
};
FilterParameterPanel.clrL.prototype.getFields = function(descriptor, values) {
  const sourceDescriptor = values[0];
  if (sourceDescriptor == null || typeof sourceDescriptor != "object") return;
  for (const wireKey in sourceDescriptor) {
    // Picker resources use classID "null"; keep the adjustment wire classID.
    if (wireKey == "classID" && sourceDescriptor[wireKey] == "null") continue;
    if (wireKey == "__name") continue;
    descriptor[wireKey] = sourceDescriptor[wireKey];
  }
};
FilterParameterPanel.clrL.prototype.onUpdate = function(appData, changeKind) {
  if (changeKind == PopupTypes.ALL || changeKind == PopupTypes.COLOR_PROFILES) {
    const presets = appData && appData.colorProfilePresets;
    this.paramWidgets[0].setPresets(Array.isArray(presets) ? presets : []);
  }
};

// --- Replace Color ----------------------------------------------------------

FilterParameterPanel.rplc = function() {
  FilterParameterPanel.call(this, "rplc");
  this.paramWidgets.push(new TextRangeInput("properties.fuzziness", 0, 200));
  this.paramWidgets.push(new ColorSampleWidget);
  this.paramWidgets.push(new TextRangeInput("properties.hue", -180, 180));
  this.paramWidgets.push(new TextRangeInput("properties.saturation", -100, 100));
  this.paramWidgets.push(new TextRangeInput("properties.lightness", -100, 100));
  this.mountFormLayout()
};
FilterParameterPanel.rplc.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.rplc.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.Fzns.v;
  values[1] = descriptor.Mxm.v;
  values[2] = descriptor.H.v;
  values[3] = descriptor.Strt.v;
  values[4] = descriptor.Lght.v;
};
FilterParameterPanel.rplc.prototype.getFields = function(descriptor, values) {
  descriptor.Fzns.v = values[0];
  descriptor.H.v = values[2];
  descriptor.Strt.v = values[3];
  descriptor.Lght.v = values[4];
  const rgbColor = psdColorToRgb(values[1]);
  const labColor = rgbToLab(rgbColor.h, rgbColor.l, rgbColor.O);
  copyLabToWireColor(labColor, descriptor.Mnm.v);
  copyLabToWireColor(labColor, descriptor.Mxm.v);
};

// --- Fade -------------------------------------------------------------------

FilterParameterPanel.fade = function() {
  FilterParameterPanel.call(this, "fade");
  this.paramWidgets.push(new TextRangeInput("properties.opacity", 0, 100, "%"));
  this.paramWidgets.push(new Dropdown("properties.blendMode", BlendModes.uiLabels, false, BlendModes.groupSizes));
  this.mountFormLayout()
};
FilterParameterPanel.fade.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.fade.prototype.setFields = function(descriptor, values) {
  values[0] = descriptor.Opct.v.val;
  values[1] = BlendModes.psdNames.indexOf(descriptor.Md.v.blendMode);
};
FilterParameterPanel.fade.prototype.getFields = function(descriptor, values) {
  descriptor.Opct.v.val = values[0];
  descriptor.Md.v.blendMode = BlendModes.psdNames[values[1]];
};

// --- Apply Image ------------------------------------------------------------

FilterParameterPanel.aply = function() {
  FilterParameterPanel.call(this, "aply");
  this.paramWidgets.push(new Dropdown("topMenu.layer", []));
  this.paramWidgets.push(new Dropdown("properties.channel", ["RGB"].concat(AdjustmentEngine.rgbColorLabels).concat(["properties.transparency"])));
  this.paramWidgets.push(new Checkbox("adjustments.invert"));
  this.paramWidgets.push(new Dropdown("properties.blendMode", BlendModes.uiLabels, false, BlendModes.groupSizes));
  this.paramWidgets.push(new TextRangeInput("properties.opacity", 0, 100, "%"));
  this.paramWidgets.push(new Checkbox("properties.preserveTransparency"));
  this.mountFormLayout([2]);
  this.applyImageLayerNames = null;
};
FilterParameterPanel.aply.prototype = Object.create(FilterParameterPanel.prototype);
FilterParameterPanel.aply.prototype.setFields = function(descriptor, values, dialogContext) {
  let layerNames;
  if (dialogContext) {
    const layerList = dialogContext[2].layers;
    layerNames = this.applyImageLayerNames = [];
    for (let layerIdx = 0; layerIdx < layerList.length; layerIdx++) {
      layerNames.push(layerList[layerIdx].getName());
    }
    layerNames.reverse();
    this.paramWidgets[0].setItems([
      "clipboard.copyMerged",
    ].concat(layerNames), [1, layerNames.length]);
  } else {
    layerNames = this.applyImageLayerNames;
  }
  const withPayload = descriptor.With.v;
  const targetWireList = withPayload.T.v;
  values[0] = targetWireList[1].t == "name" ? 1 + layerNames.indexOf(targetWireList[1].v.val) : 0;
  values[1] = ["RGB", "Rd", "Grn", "Bl", "Trsp"].indexOf(targetWireList[0].v.enum);
  values[2] = withPayload.Invr.v;
  values[3] = BlendModes.psdNames.indexOf(withPayload.Clcl.v.Clcn);
  values[4] = withPayload.Opct.v.val;
  values[5] = withPayload.PrsT.v;
};
FilterParameterPanel.aply.prototype.getFields = function(descriptor, values) {
  const withPayload = descriptor.With.v;
  const targetWireList = withPayload.T.v;
  if (values[0] == 0) {
    targetWireList[1] = {
      t: "Enmr",
      v: {
        classID: "Lyr",
        typeID: "Ordn",
        enum: "Mrgd",
      },
    };
  } else {
    targetWireList[1] = {
      t: "name",
      v: {
        classID: "Lyr",
        val: this.applyImageLayerNames[this.applyImageLayerNames.length - 1 - values[0]],
      },
    };
  }
  targetWireList[0].v.enum = ["RGB", "Rd", "Grn", "Bl", "Trsp"][values[1]];
  withPayload.Invr.v = values[2];
  withPayload.Clcl.v.Clcn = BlendModes.psdNames[values[3]];
  withPayload.Opct.v.val = values[4];
  withPayload.PrsT.v = values[5];
};
