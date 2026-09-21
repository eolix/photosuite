/**
 * Color swatches, sample chip, HSV wheel, and crop-constraint controls.
 *
 * Colors here use the engine's internal RGB triple `{ h, l, O }` — h is red,
 * l is green, O is blue, each 0–255 — the same shape the PSD colour readers
 * produce. `packRgbChannels` / `unpackPackedRgb` convert to and from a single
 * packed 0xRRGGBB integer.
 */

import { SliderDropdown } from "./number-inputs.js";
import { Dropdown } from "./popup-controls.js";
import { BaseWidget } from "../base-widget.js";

import { Point } from "../../../core/math/point.js";
import { EventType, UiCommand } from "../../../core/event-bus.js";
import { addPointerDownListener, addPointerMoveListener, addPointerUpListener, disableTouchGestures, getDevicePixelRatio, getEventPos, makeElement, removePointerMoveListener, removePointerUpListener, setWidthHeightLabels } from "../../../core/dom.js";
import { AppEvent } from "../../../core/event-bus.js";
import { hsvToRgb, rgbToHex, rgbToHsv } from "../../../engine/compositing/color-math.js";
import { psdColorToRgb, toRGBDesc } from "../../../engine/compositing/psd-color-utils.js";

/** Default swatch palette (packed 0xRRGGBB). */
const DEFAULT_SWATCH_COLORS = [
  16711680, 65280, 255, 65535, 16711935, 16776960, 0, 8421504, 16777215
];

const COLOR_WHEEL_PLANE_SIZE = 256;
const COLOR_WHEEL_SLIDER_WIDTH = 20;
const HUE_PLANE_RERENDER_EPSILON = 0.002;

/**
 * Fixed grid of clickable color swatches.
 * @param {number} swatchCount
 */
function ColorSwatchGrid(swatchCount) {
  BaseWidget.call(this);
  this.el = makeElement("span", "fitem cswatch");
  this.selectedIndex = 0;
  this.swatchColors = [];
  this.items = [];
  mountSwatchGridCells(this, swatchCount);
  seedDefaultSwatchColors(this.swatchColors, swatchCount);
  this.rebuild()
}

ColorSwatchGrid.prototype = Object.create(BaseWidget.prototype);
ColorSwatchGrid.prototype.constructor = ColorSwatchGrid;

ColorSwatchGrid.prototype.onSwatchClick = function(clickEvent) {
  this.selectedIndex = this.items.indexOf(clickEvent.currentTarget);
  this.dispatch(new AppEvent(EventType.widgetSelect))
};

ColorSwatchGrid.prototype.getValue = function() {
  return this.swatchColors[this.selectedIndex]
};

ColorSwatchGrid.prototype.setValue = function(packedRgb) {
  const colors = this.swatchColors,
    existingIdx = colors.indexOf(packedRgb);
  if (existingIdx != -1) colors.splice(existingIdx, 1);
  else colors.pop();
  colors.unshift(packedRgb);
  this.rebuild()
};

ColorSwatchGrid.prototype.rebuild = function() {
  for (let swatchIdx = 0; swatchIdx < this.swatchColors.length; swatchIdx++) {
    this.items[swatchIdx].setAttribute(
      "style",
      "background-color:#" + rgbToHex(this.swatchColors[swatchIdx])
    )
  }
};

/**
 * Single clickable color chip that opens the color-picker dialog.
 * Channels use the internal { h, l, O } RGB shape.
 * @param {boolean} allowNewProjectDialog Continuous mirror updates while picking.
 */
function ColorSampleWidget(allowNewProjectDialog) {
  BaseWidget.call(this);
  this.rgbChannels = {
    h: 0,
    l: 0,
    O: 0
  };
  this.allowNewProjectDialog = allowNewProjectDialog;
  this.el = makeElement("span", "fitem colorsample");
  this.el.addEventListener("click", this.openColorPicker.bind(this), false)
}

ColorSampleWidget.prototype = Object.create(BaseWidget.prototype);
ColorSampleWidget.prototype.constructor = ColorSampleWidget;

ColorSampleWidget.prototype.buildUI = function() {};

ColorSampleWidget.prototype.openColorPicker = function() {
  const rgb = this.rgbChannels;
  this.dispatch(new AppEvent("click"));
  const pickerEvent = new AppEvent(EventType.uiDispatch, true);
  pickerEvent.data = {
    dispatchKind: UiCommand.dispatchAppDialogRouter,
    dialogRouteId: "colorpicker",
    colorIntArgb: packRgbChannels(rgb.h, rgb.l, rgb.O),
    onDialogResult: this.onColorPicked.bind(this),
    allowContinuousMirrorUpdates: this.allowNewProjectDialog
  };
  this.dispatch(pickerEvent)
};

ColorSampleWidget.prototype.onColorPicked = function(packedRgb) {
  this.setPackedRgb(packedRgb);
  this.dispatch(new AppEvent(EventType.widgetSelect))
};

ColorSampleWidget.prototype.triggerColorPicker = function() {
  this.openColorPicker()
};

ColorSampleWidget.prototype.getPackedRgb = function() {
  const rgb = this.rgbChannels;
  return packRgbChannels(rgb.h, rgb.l, rgb.O)
};

ColorSampleWidget.prototype.getValue = function() {
  return toRGBDesc(this.rgbChannels)
};

ColorSampleWidget.prototype.setPackedRgb = function(packedRgb) {
  this.rgbChannels = unpackPackedRgb(packedRgb);
  this.updateSwatchStyle()
};

ColorSampleWidget.prototype.setValue = function(psdColorDesc) {
  this.rgbChannels = psdColorToRgb(psdColorDesc);
  this.updateSwatchStyle()
};

ColorSampleWidget.prototype.updateSwatchStyle = function() {
  const rgb = this.rgbChannels;
  this.el.setAttribute(
    "style",
    "background-color:#" + rgbToHex(packRgbChannels(rgb.h, rgb.l, rgb.O))
  )
};

/**
 * HSV saturation-value plane + hue slider.
 * @param {number} displaySizePx CSS size of the plane.
 */
function ColorWheel(displaySizePx) {
  BaseWidget.call(this);
  this.storedValue = {
    h: 0,
    l: 0,
    O: 0
  };
  if (Math.abs(displaySizePx - COLOR_WHEEL_PLANE_SIZE / getDevicePixelRatio()) < 10) {
    displaySizePx = COLOR_WHEEL_PLANE_SIZE / getDevicePixelRatio()
  }
  mountColorWheelDom(this, displaySizePx)
}

ColorWheel.prototype = Object.create(BaseWidget.prototype);
ColorWheel.prototype.constructor = ColorWheel;

ColorWheel.prototype.resize = function(widthPx) {
  this.canvas.style.width = widthPx + "px"
};

ColorWheel.prototype.setValue = function(rgbValue) {
  this.storedValue = rgbValue;
  this.update()
};

ColorWheel.prototype.getValue = function() {
  return JSON.parse(JSON.stringify(this.storedValue))
};

ColorWheel.prototype.update = function() {
  const rgbValue = this.storedValue,
    hsv = rgbToHsv(rgbValue.h, rgbValue.l, rgbValue.O);
  if (hsv.value == 0) hsv.saturation = this.saturationValuePoint.x / 255;
  if (hsv.saturation == 0 || hsv.value == 0) {
    hsv.hue = (255 - clampByte(this.hueSliderPoint.y)) / 255
  }
  if (hsv.value != 0) this.saturationValuePoint.x = hsv.saturation * 255;
  this.saturationValuePoint.y = (1 - hsv.value) * 255;
  this.hueSliderPoint.y = (1 - hsv.hue) * 255;
  const planeImageData = this.saturationPlaneImageData;
  if (Math.abs(hsv.hue - this.lastRenderedHue) > HUE_PLANE_RERENDER_EPSILON) {
    fillSaturationPlaneImageData(planeImageData.data, COLOR_WHEEL_PLANE_SIZE, COLOR_WHEEL_PLANE_SIZE, hsv.hue);
    this.lastRenderedHue = hsv.hue
  }
  this.ctx2d.putImageData(planeImageData, 0, 0);
  drawSaturationValueCrosshair(this.ctx2d, this.saturationValuePoint);
  this.hueSliderCtx.putImageData(this.hueSliderImageData, 0, 0);
  drawHueSliderCaret(this.hueSliderCtx, this.hueSliderPoint.y)
};

ColorWheel.prototype.fillSaturationPlaneImageData = function(pixelData, width, height, hue) {
  fillSaturationPlaneImageData(pixelData, width, height, hue)
};

ColorWheel.prototype.fillHueSliderGradient = function(pixelData, width, height) {
  fillHueSliderGradient(pixelData, width, height)
};

ColorWheel.prototype.onSaturationPlanePointerDown = function(pointerEvent) {
  addPointerMoveListener(window, this.boundOnSaturationPlaneMove);
  addPointerUpListener(window, this.boundOnSaturationPlaneUp);
  this.onSaturationPlanePointerMove(pointerEvent)
};

ColorWheel.prototype.onSaturationPlanePointerUp = function() {
  removePointerMoveListener(window, this.boundOnSaturationPlaneMove);
  removePointerUpListener(window, this.boundOnSaturationPlaneUp)
};

ColorWheel.prototype.onSaturationPlanePointerMove = function(pointerEvent) {
  const pointerPos = getEventPos(pointerEvent, this.canvas);
  pointerPos.x = pointerPos.x * (COLOR_WHEEL_PLANE_SIZE / parseFloat(this.canvas.style.width));
  pointerPos.y = pointerPos.y * (COLOR_WHEEL_PLANE_SIZE / parseFloat(this.canvas.style.height));
  this.saturationValuePoint.setXY(clampByte(pointerPos.x), clampByte(pointerPos.y));
  this.emitChange()
};

ColorWheel.prototype.emitChange = function() {
  this.storedValue = this.computeRgbFromWheelState();
  this.dispatch(new AppEvent(EventType.widgetSelect))
};

ColorWheel.prototype.computeRgbFromWheelState = function() {
  return computeRgbFromWheelState(this.hueSliderPoint, this.saturationValuePoint)
};

ColorWheel.prototype.onHueSliderPointerDown = function(pointerEvent) {
  addPointerMoveListener(window, this.boundOnHueSliderMove);
  addPointerUpListener(window, this.boundOnHueSliderUp);
  this.onHueSliderPointerMove(pointerEvent)
};

ColorWheel.prototype.onHueSliderPointerUp = function() {
  removePointerMoveListener(window, this.boundOnHueSliderMove);
  removePointerUpListener(window, this.boundOnHueSliderUp)
};

ColorWheel.prototype.onHueSliderPointerMove = function(pointerEvent) {
  const pointerPos = getEventPos(pointerEvent, this.hueSliderCanvas);
  pointerPos.y = pointerPos.y * (COLOR_WHEEL_PLANE_SIZE / parseFloat(this.hueSliderCanvas.style.height));
  this.hueSliderPoint.setXY(clampByte(pointerPos.x), clampByte(pointerPos.y));
  this.emitChange()
};

ColorWheel.prototype.clampByte = clampByte;
ColorWheel.prototype.clampUnit = clampUnit;

/**
 * Crop / transform constraint mode + width/height fields.
 * Value shape: { constraintMode, constraintWidth, constraintHeight }.
 */
function CropConstraintWidget() {
  BaseWidget.call(this);
  this.activeModeIndex = 0;
  this.modeDimensionCache = [0, 0, 1, 1, 100, 100];
  this.el = makeElement("span", "fitem");
  this.constraintModeDropdown = new Dropdown(null, [
    "properties.cropConstraint.free",
    "properties.cropConstraint.fixedRatio",
    "properties.cropConstraint.fixedSize"
  ]);
  this.el.appendChild(this.constraintModeDropdown.el);
  this.constraintModeDropdown.on(EventType.widgetSelect, this.onChange, this);
  this.widthInput = new SliderDropdown("W", 0, 0, null, 0, false, true);
  this.el.appendChild(this.widthInput.el);
  this.widthInput.on(EventType.widgetSelect, this.onChange, this);
  this.heightInput = new SliderDropdown("H", 0, 0, null, 0, false, true);
  this.el.appendChild(this.heightInput.el);
  this.heightInput.on(EventType.widgetSelect, this.onChange, this);
  this.setValue({
    constraintMode: 0,
    constraintWidth: 0,
    constraintHeight: 0
  })
}

CropConstraintWidget.prototype = Object.create(BaseWidget.prototype);
CropConstraintWidget.prototype.constructor = CropConstraintWidget;

CropConstraintWidget.prototype.buildUI = function() {
  setWidthHeightLabels(this.widthInput, this.heightInput);
  this.constraintModeDropdown.buildUI()
};

CropConstraintWidget.prototype.onChange = function(changeEvent) {
  if (changeEvent.target == this.constraintModeDropdown) {
    const currentValue = this.getValue(),
      dimensionCache = this.modeDimensionCache;
    dimensionCache[this.activeModeIndex * 2] = currentValue.constraintWidth;
    dimensionCache[this.activeModeIndex * 2 + 1] = currentValue.constraintHeight;
    this.activeModeIndex = currentValue.constraintMode;
    this.setValue({
      constraintMode: currentValue.constraintMode,
      constraintWidth: dimensionCache[currentValue.constraintMode * 2],
      constraintHeight: dimensionCache[currentValue.constraintMode * 2 + 1]
    })
  }
  if (this.widthInput.getValue() < 1) this.widthInput.setValue(1);
  if (this.heightInput.getValue() < 1) this.heightInput.setValue(1);
  this.dispatch(new AppEvent(EventType.widgetSelect, false))
};

CropConstraintWidget.prototype.setValue = function(value) {
  this.constraintModeDropdown.setValue(value.constraintMode);
  this.widthInput.setValue(value.constraintWidth);
  this.heightInput.setValue(value.constraintHeight);
  if (value.constraintMode == 0) {
    this.widthInput.disable();
    this.heightInput.disable()
  } else {
    this.widthInput.enable();
    this.heightInput.enable()
  }
};

CropConstraintWidget.prototype.getValue = function() {
  return {
    constraintMode: this.constraintModeDropdown.getValue(),
    constraintWidth: this.widthInput.getValue(),
    constraintHeight: this.heightInput.getValue()
  }
};

export {
  ColorSwatchGrid,
  ColorSampleWidget,
  ColorWheel,
  CropConstraintWidget,
  packRgbChannels,
  unpackPackedRgb,
  clampByte,
  clampUnit,
  DEFAULT_SWATCH_COLORS
};

// --- Swatch grid helpers -----------------------------------------------------

function mountSwatchGridCells(grid, swatchCount) {
  const onSwatchClick = grid.onSwatchClick.bind(grid);
  for (let swatchIdx = 0; swatchIdx < swatchCount; swatchIdx++) {
    grid.swatchColors.push(0);
    const swatchEl = makeElement("span", "colorsample");
    swatchEl.addEventListener("click", onSwatchClick, false);
    grid.items.push(swatchEl);
    grid.el.appendChild(swatchEl)
  }
}

function seedDefaultSwatchColors(swatchColors, swatchCount) {
  const presetCount = Math.min(swatchCount, DEFAULT_SWATCH_COLORS.length);
  for (let swatchIdx = 0; swatchIdx < presetCount; swatchIdx++) {
    swatchColors[swatchIdx] = DEFAULT_SWATCH_COLORS[swatchIdx]
  }
}

// --- Packed RGB ({ h, l, O }) ------------------------------------------------

function packRgbChannels(red, green, blue) {
  return red << 16 | green << 8 | blue
}

function unpackPackedRgb(packedRgb) {
  return {
    h: packedRgb >> 16 & 255,
    l: packedRgb >> 8 & 255,
    O: packedRgb & 255
  }
}

function clampByte(value) {
  return Math.max(0, Math.min(255, value))
}

function clampUnit(value) {
  return Math.max(0, Math.min(1, value))
}

// --- Color wheel helpers -----------------------------------------------------

function mountColorWheelDom(wheel, displaySizePx) {
  const rowEl = wheel.el = makeElement("div", "flexrow");
  wheel.saturationValuePoint = new Point();
  wheel.hueSliderPoint = new Point();
  wheel.boundOnSaturationPlaneMove = wheel.onSaturationPlanePointerMove.bind(wheel);
  wheel.boundOnSaturationPlaneUp = wheel.onSaturationPlanePointerUp.bind(wheel);
  wheel.canvas = makeElement("canvas", "");
  wheel.ctx2d = wheel.canvas.getContext("2d");
  wheel.canvas.width = wheel.canvas.height = COLOR_WHEEL_PLANE_SIZE;
  wheel.saturationPlaneImageData = wheel.ctx2d.getImageData(0, 0, COLOR_WHEEL_PLANE_SIZE, COLOR_WHEEL_PLANE_SIZE);
  wheel.lastRenderedHue = -1;
  disableTouchGestures(wheel.canvas);
  addPointerDownListener(wheel.canvas, wheel.onSaturationPlanePointerDown.bind(wheel));
  rowEl.appendChild(wheel.canvas);
  wheel.boundOnHueSliderMove = wheel.onHueSliderPointerMove.bind(wheel);
  wheel.boundOnHueSliderUp = wheel.onHueSliderPointerUp.bind(wheel);
  wheel.hueSliderCanvas = makeElement("canvas", "");
  wheel.hueSliderCtx = wheel.hueSliderCanvas.getContext("2d");
  wheel.hueSliderCanvas.width = COLOR_WHEEL_SLIDER_WIDTH;
  wheel.hueSliderCanvas.height = COLOR_WHEEL_PLANE_SIZE;
  wheel.hueSliderImageData = wheel.hueSliderCtx.getImageData(0, 0, COLOR_WHEEL_SLIDER_WIDTH, COLOR_WHEEL_PLANE_SIZE);
  fillHueSliderGradient(wheel.hueSliderImageData.data, COLOR_WHEEL_SLIDER_WIDTH, COLOR_WHEEL_PLANE_SIZE);
  disableTouchGestures(wheel.hueSliderCanvas);
  addPointerDownListener(wheel.hueSliderCanvas, wheel.onHueSliderPointerDown.bind(wheel));
  rowEl.appendChild(wheel.hueSliderCanvas);
  wheel.canvas.setAttribute("style", "width:" + displaySizePx + "px; height:" + displaySizePx + "px");
  wheel.hueSliderCanvas.setAttribute(
    "style",
    "width:" + COLOR_WHEEL_SLIDER_WIDTH / getDevicePixelRatio() + "px; height:" + displaySizePx + "px"
  )
}

function fillSaturationPlaneImageData(pixelData, width, height, hue) {
  const invWidth = 1 / width,
    invHeight = 1 / height;
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const rgb = hsvToRgb(hue, col * invWidth, (height - row - 1) * invHeight),
        pixelOffset = row * width + col << 2;
      pixelData[pixelOffset + 0] = ~~(rgb.h * 255);
      pixelData[pixelOffset + 1] = ~~(rgb.l * 255);
      pixelData[pixelOffset + 2] = ~~(rgb.O * 255);
      pixelData[pixelOffset + 3] = 255
    }
  }
}

function fillHueSliderGradient(pixelData, width, height) {
  const pixels32 = new Uint32Array(pixelData.buffer);
  for (let row = 0; row < height; row++) {
    const rgb = hsvToRgb(1 - row / height, 1, 1),
      packedPixel = 255 << 24 | rgb.O * 255 << 16 | rgb.l * 255 << 8 | rgb.h * 255;
    for (let col = 0; col < width; col++) pixels32[row * width + col] = packedPixel
  }
}

function drawSaturationValueCrosshair(ctx, saturationValuePoint) {
  ctx.strokeStyle = "#000000";
  ctx.beginPath();
  ctx.arc(saturationValuePoint.x + 1, saturationValuePoint.y + 1, 5, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.strokeStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(saturationValuePoint.x, saturationValuePoint.y, 5, 0, 2 * Math.PI);
  ctx.stroke()
}

function drawHueSliderCaret(ctx, sliderY) {
  ctx.strokeStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(0, sliderY);
  ctx.lineTo(COLOR_WHEEL_SLIDER_WIDTH, sliderY);
  ctx.lineWidth = 2;
  ctx.stroke()
}

function computeRgbFromWheelState(hueSliderPoint, saturationValuePoint) {
  const rgb = hsvToRgb(
    (255 - clampByte(hueSliderPoint.y)) / 255,
    clampUnit(saturationValuePoint.x / 255),
    clampUnit(1 - saturationValuePoint.y / 255)
  );
  return {
    h: rgb.h,
    l: rgb.l,
    O: rgb.O
  }
}
