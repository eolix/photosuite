/**
 * Numeric field variants built on NumberInputBase, plus a 3×3 origin grid dial.
 *
 * The three NumberInputBase variants differ only in layout: RangeInput shows the
 * slider inline before the field, TextRangeInput shows the field before an
 * inline slider, and SliderDropdown shows just the field with the slider hidden
 * behind a chevron in a floating overlay. All share the same value/min/max/unit
 * contract from NumberInputBase. AngleInput is unrelated — a nine-cell origin
 * picker whose value is a grid index (0–8, or 9 for center/none).
 */

import { BaseWidget } from "../base-widget.js";
import { NumberInputBase } from "../number-input-base.js";

import { Locale } from "../../../core/i18n/locale.js";
import { EventType, UiCommand } from "../../../core/event-bus.js";
import { addClass, addPointerDownListener, addPointerMoveListener, addPointerUpListener, getEventPos, isInDOM, makeElement, removePointerMoveListener, removePointerUpListener, resizeCanvasForDevicePixelRatio } from "../../../core/dom.js";
import { AppEvent } from "../../../core/event-bus.js";

/** Narrowest usable slider track in the dropdown overlay. */
const SLIDER_OVERLAY_MIN_TRACK_PX = 116;
/** Gap between a numeric field and the slider it reveals. */
const SLIDER_OVERLAY_GAP_PX = 2;

const ANGLE_GRID_CELL_COUNT = 3;
const ANGLE_GRID_CENTER_INDEX = 9;
const COMPACT_ANGLE_GRID_CSS_PX = 30;

/**
 * 3×3 origin grid dial (0–8 cells, 9 = center / no dot).
 * @param {string} [labelLocaleKey]
 * @param {number} canvasSizePx CSS canvas size.
 */
function AngleInput(labelLocaleKey, canvasSizePx) {
  BaseWidget.call(this);
  this.storedValue = 0;
  this.canvasSizePx = canvasSizePx;
  mountAngleInputDom(this, labelLocaleKey);
  this.setValue(0)
}

AngleInput.prototype = Object.create(BaseWidget.prototype);
AngleInput.prototype.constructor = AngleInput;

AngleInput.prototype.buildUI = function() {
  if (this.labelKey) this.labelEl.textContent = Locale.get(this.labelKey) + ":"
};

AngleInput.prototype.setLabel = function(labelText) {
  this.labelEl.textContent = labelText
};

AngleInput.prototype.getValue = function() {
  return this.storedValue
};

AngleInput.prototype.setValue = function(gridIndex) {
  this.storedValue = gridIndex;
  drawAngleGridDial(this.ctx2d, this.canvas.width, this.canvasSizePx, gridIndex)
};

AngleInput.prototype.onPointerDown = function(pointerEvent) {
  addPointerMoveListener(window, this.boundOnPointerMove);
  addPointerUpListener(window, this.boundOnPointerUp);
  this.onPointerMove(pointerEvent)
};

AngleInput.prototype.onPointerMove = function(pointerEvent) {
  const pointerPos = getEventPos(pointerEvent, this.canvas);
  this.setValue(pointerCssToGridIndex(pointerPos.x, pointerPos.y, this.canvasSizePx))
};

AngleInput.prototype.onPointerUp = function() {
  this.dispatch(new AppEvent(EventType.widgetSelect, false));
  removePointerMoveListener(window, this.boundOnPointerMove);
  removePointerUpListener(window, this.boundOnPointerUp)
};

/** Label + range + text field (unit suffix optional). */
function RangeInput(labelKey, minValue, maxValue, initialValueOrSuffix, decimalPlaces, useLogarithmicRangeMapper) {
  NumberInputBase.call(
    this,
    labelKey,
    minValue,
    maxValue,
    initialValueOrSuffix,
    decimalPlaces,
    false,
    useLogarithmicRangeMapper
  );
  mountRangeInputDom(this)
}

RangeInput.prototype = Object.create(NumberInputBase.prototype);
RangeInput.prototype.constructor = RangeInput;

/** Compact numeric field with optional floating range overlay. */
function SliderDropdown(
  labelKey,
  minValue,
  maxValue,
  initialValueOrSuffix,
  decimalPlaces,
  useLogarithmicRangeMapper,
  hideRangeToggle,
  inputWidthEm,
  tooltipLocaleKey
) {
  NumberInputBase.call(
    this,
    labelKey,
    minValue,
    maxValue,
    initialValueOrSuffix,
    decimalPlaces,
    true,
    useLogarithmicRangeMapper,
    tooltipLocaleKey
  );
  mountSliderDropdownDom(this, hideRangeToggle, inputWidthEm)
}

SliderDropdown.prototype = Object.create(NumberInputBase.prototype);
SliderDropdown.prototype.constructor = SliderDropdown;

SliderDropdown.prototype.onOpenRangeOverlay = function(pointerEvent) {
  if (isInDOM(this.rangeOverlayWidget.el)) return;
  pointerEvent.stopPropagation();
  // Line the slider up with the field it drives, not with the whole row: the
  // row starts at the label, which would leave the popup hanging to the left.
  const rowRect = this.el.getBoundingClientRect();
  const inputRect = this.inputEl.getBoundingClientRect();
  const toggleRect = isInDOM(this.rangeToggleButton)
    ? this.rangeToggleButton.getBoundingClientRect()
    : inputRect;
  const trackWidth = Math.max(
    SLIDER_OVERLAY_MIN_TRACK_PX,
    Math.round(Math.max(inputRect.right, toggleRect.right) - inputRect.left)
  );
  this.rangeEl.setAttribute("style", "width:" + trackWidth + "px;");
  const overlayEvent = new AppEvent(EventType.uiDispatch, true);
  overlayEvent.data = {
    dispatchKind: UiCommand.showFloatingOverlay,
    overlayWidget: this.rangeOverlayWidget,
    // Measured so the overlay manager keeps a field near the window edge
    // from opening its slider off-screen.
    measureForPosition: true,
    x: Math.round(inputRect.left),
    y: Math.round(rowRect.bottom + SLIDER_OVERLAY_GAP_PX)
  };
  this.dispatch(overlayEvent)
};

/** Text field with inline range slider (brush diameter / hardness header). */
function TextRangeInput(
  labelKey,
  minValue,
  maxValue,
  initialValueOrSuffix,
  decimalPlaces,
  useLogarithmicRangeMapper,
  emitWidgetSelectOnRangeChangeEndOnly
) {
  NumberInputBase.call(
    this,
    labelKey,
    minValue,
    maxValue,
    initialValueOrSuffix,
    decimalPlaces,
    true,
    useLogarithmicRangeMapper,
    null,
    emitWidgetSelectOnRangeChangeEndOnly
  );
  mountTextRangeInputDom(this)
}

TextRangeInput.prototype = Object.create(NumberInputBase.prototype);
TextRangeInput.prototype.constructor = TextRangeInput;

export {
  AngleInput,
  RangeInput,
  SliderDropdown,
  TextRangeInput,
  gridIndexToCell,
  pointerCssToGridIndex,
  buildAngleGridLinePositions,
  ANGLE_GRID_CELL_COUNT,
  ANGLE_GRID_CENTER_INDEX
};

// --- AngleInput helpers ------------------------------------------------------

function mountAngleInputDom(angleInput, labelLocaleKey) {
  angleInput.el = makeElement("span", "fitem angleinput");
  if (labelLocaleKey) {
    angleInput.labelEl = makeElement("label", "flabel");
    angleInput.labelKey = labelLocaleKey;
    angleInput.el.appendChild(angleInput.labelEl)
  }
  angleInput.canvas = makeElement("canvas", "gsicon");
  angleInput.ctx2d = angleInput.canvas.getContext("2d");
  resizeCanvasForDevicePixelRatio(angleInput.canvas, angleInput.canvasSizePx, angleInput.canvasSizePx);
  angleInput.el.appendChild(angleInput.canvas);
  addPointerDownListener(angleInput.canvas, angleInput.onPointerDown.bind(angleInput));
  angleInput.boundOnPointerMove = angleInput.onPointerMove.bind(angleInput);
  angleInput.boundOnPointerUp = angleInput.onPointerUp.bind(angleInput)
}

/** Map stored grid index to column / row (0–2 each). */
function gridIndexToCell(gridIndex) {
  const col = Math.floor(gridIndex / ANGLE_GRID_CELL_COUNT),
    row = gridIndex - ANGLE_GRID_CELL_COUNT * col;
  return {
    col: col,
    row: row
  }
}

/** Map CSS pointer position inside the dial to a grid index. */
function pointerCssToGridIndex(pointerX, pointerY, canvasSizePx) {
  const cellSize = canvasSizePx / ANGLE_GRID_CELL_COUNT,
    col = Math.max(0, Math.min(2, Math.floor(pointerX / cellSize))),
    row = Math.max(0, Math.min(2, Math.floor(pointerY / cellSize)));
  return row * ANGLE_GRID_CELL_COUNT + col
}

function buildAngleGridLinePositions(canvasPixelSize) {
  const third = Math.round(canvasPixelSize / ANGLE_GRID_CELL_COUNT);
  return [
    0.5,
    third + 0.5,
    2 * third + 0.5,
    canvasPixelSize - 0.5
  ]
}

function drawAngleGridDial(ctx, canvasPixelSize, canvasCssSizePx, gridIndex) {
  const cell = gridIndexToCell(gridIndex),
    dotX = (cell.row + 0.5) * canvasPixelSize / ANGLE_GRID_CELL_COUNT,
    dotY = (cell.col + 0.5) * canvasPixelSize / ANGLE_GRID_CELL_COUNT,
    gridLines = buildAngleGridLinePositions(canvasPixelSize),
    compactGrid = canvasCssSizePx < COMPACT_ANGLE_GRID_CSS_PX;
  ctx.clearRect(0, 0, canvasPixelSize, canvasPixelSize);
  drawAngleGridLines(ctx, canvasPixelSize, gridLines, compactGrid);
  if (gridIndex == ANGLE_GRID_CENTER_INDEX) return;
  if (!compactGrid) drawAngleGridSelectionHighlight(ctx, canvasPixelSize, dotX, dotY);
  drawAngleGridDot(ctx, dotX, dotY, canvasPixelSize / 8)
}

function drawAngleGridLines(ctx, canvasPixelSize, gridLines, compactGrid) {
  ctx.setLineDash([]);
  ctx.strokeStyle = compactGrid ? "rgba(0,0,0,0.5)" : "#000000";
  ctx.beginPath();
  for (let lineIdx = 0; lineIdx < gridLines.length; lineIdx++) {
    const linePos = gridLines[lineIdx];
    ctx.moveTo(linePos, 0);
    ctx.lineTo(linePos, canvasPixelSize);
    ctx.moveTo(0, linePos);
    ctx.lineTo(canvasPixelSize, linePos)
  }
  ctx.stroke()
}

function drawAngleGridSelectionHighlight(ctx, canvasPixelSize, dotX, dotY) {
  ctx.setLineDash([1, 2]);
  const highlightSize = canvasPixelSize * 0.53,
    highlightX = Math.max(0, Math.min(canvasPixelSize - highlightSize, dotX - highlightSize / 2)),
    highlightY = Math.max(0, Math.min(canvasPixelSize - highlightSize, dotY - highlightSize / 2));
  ctx.strokeRect(
    Math.round(highlightX) + 0.5,
    Math.round(highlightY) + 0.5,
    Math.round(highlightSize),
    Math.round(highlightSize)
  )
}

function drawAngleGridDot(ctx, dotX, dotY, dotRadius) {
  ctx.fillStyle = "#000000";
  ctx.beginPath();
  ctx.arc(dotX, dotY, dotRadius, 0, Math.PI * 2);
  ctx.fill()
}

// --- NumberInputBase layout variants -------------------------------------------

function mountRangeInputDom(rangeInput) {
  addClass(rangeInput.el, "rangeinput");
  rangeInput.el.appendChild(rangeInput.quantityLabelEl);
  const rangeContainerHost = makeElement("span", "rangecont");
  rangeInput.el.appendChild(rangeContainerHost);
  rangeContainerHost.appendChild(rangeInput.rangeEl);
  rangeInput.el.appendChild(rangeInput.inputEl);
  if (rangeInput.unitSuffixString) {
    addClass(rangeInput.unitSuffixEl, "unitsuffix");
    rangeInput.el.appendChild(rangeInput.unitSuffixEl)
  }
}

function mountSliderDropdownDom(sliderDropdown, hideRangeToggle, inputWidthEm) {
  addClass(sliderDropdown.el, "rangedropinput");
  sliderDropdown.el.appendChild(sliderDropdown.quantityLabelEl);
  sliderDropdown.inputEl.setAttribute("style", "width:" + (inputWidthEm ? inputWidthEm : 3.3) + "em");
  sliderDropdown.el.appendChild(sliderDropdown.inputEl);
  sliderDropdown.rangeOverlayHost = makeElement("span", "rangecont rangepopup");
  sliderDropdown.rangeOverlayHost.appendChild(sliderDropdown.rangeEl);
  sliderDropdown.rangeToggleButton = makeElement("button");
  addClass(sliderDropdown.rangeToggleButton, "chevron");
  addPointerDownListener(sliderDropdown.rangeToggleButton, sliderDropdown.onOpenRangeOverlay.bind(sliderDropdown));
  if (hideRangeToggle !== true) sliderDropdown.el.appendChild(sliderDropdown.rangeToggleButton);
  sliderDropdown.rangeOverlayWidget = new BaseWidget();
  sliderDropdown.rangeOverlayWidget.el = sliderDropdown.rangeOverlayHost
}

function mountTextRangeInputDom(textRangeInput) {
  addClass(textRangeInput.el, "trangeinput");
  textRangeInput.el.appendChild(textRangeInput.quantityLabelEl);
  textRangeInput.el.appendChild(textRangeInput.inputEl);
  const rangeContainerHost = makeElement("span", "rangecont");
  textRangeInput.el.appendChild(rangeContainerHost);
  rangeContainerHost.appendChild(textRangeInput.rangeEl)
}
