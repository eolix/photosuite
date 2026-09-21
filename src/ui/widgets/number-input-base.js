/**
 * Base class for labeled numeric inputs: slider track, drag-to-scrub label,
 * logarithmic range mapping, and unit suffix display.
 */


import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { Locale } from "../../core/i18n/locale.js";
import { BaseWidget } from "./base-widget.js";
import { EventType } from "../../core/event-bus.js";
import { addPointerDownListener, addPointerMoveListener, addPointerUpListener, cancel, getEventPos, makeElement, removePointerMoveListener, removePointerUpListener } from "../../core/dom.js";
import { allocateNextUniqueId } from "../../core/uid.js";
import { AppEvent } from "../../core/event-bus.js";

/** Slider track max when useLogarithmicRangeMapper is on. */
const LOG_RANGE_SLIDER_MAX = 400;

/** Power curve exponent for size-style logarithmic range mapping. */
const LOG_RANGE_CURVE_EXPONENT = 2.7;

/** Pointer-drag sensitivity: full span maps across this many CSS pixels. */
const LABEL_DRAG_SPAN_PIXELS = 120;

/** Double-click window on the range track (ms). */
const RANGE_DOUBLE_CLICK_MS = 300;

/** Ignore range input events this close after a track click (ms). */
const RANGE_CLICK_INPUT_GUARD_MS = 10;

/**
 * Shared numeric field: optional label, range slider, text entry, optional unit
 * suffix. Used by RangeInput, SliderDropdown, and TextRangeInput.
 *
 * @param {string|null} labelKey i18n key or HTML fragment for the quantity label.
 * @param {number} minValue
 * @param {number} maxValue
 * @param {string|number|null|Array} initialValueOrSuffix Default numeric value, unit
 *        suffix string, or array of allowed unit suffixes (first is active).
 * @param {number} decimalPlaces 0 for integers.
 * @param {boolean} appendUnitToValueDisplay When true, append unitSuffixString to the text field.
 * @param {boolean} useLogarithmicRangeMapper Maps the slider through a power curve.
 * @param {string|null} tooltipLocaleKey Optional i18n key for title on label + input.
 * @param {boolean} [emitWidgetSelectOnRangeChangeEndOnly] When true, range input does not
 *        dispatch; range change does.
 */
function NumberInputBase(
  labelKey,
  minValue,
  maxValue,
  initialValueOrSuffix,
  decimalPlaces,
  appendUnitToValueDisplay,
  useLogarithmicRangeMapper,
  tooltipLocaleKey,
  emitWidgetSelectOnRangeChangeEndOnly,
) {
  BaseWidget.call(this);
  this.el = makeElement("span", "fitem");
  this.labelKey = labelKey;
  this.tooltipLocaleKey = tooltipLocaleKey;
  this.emitWidgetSelectOnRangeChangeEndOnly = emitWidgetSelectOnRangeChangeEndOnly;
  this.minValue = minValue;
  this.maxValue = maxValue;
  this.decimalPlaces = decimalPlaces;
  this.appendUnitToValueDisplay = appendUnitToValueDisplay;
  this.useLogarithmicRangeMapper = useLogarithmicRangeMapper;
  this.lastRangeClickTimestamp = 0;
  this.dragStartPointerX = 0;
  this.dragStartNumericValue = 0;
  this.didDragRescale = false;
  applyInitialUnitState(this, initialValueOrSuffix);
  mountNumberInputDom(this, minValue, maxValue, decimalPlaces, useLogarithmicRangeMapper);
  wireNumberInputListeners(this, emitWidgetSelectOnRangeChangeEndOnly)
}

NumberInputBase.prototype = Object.create(BaseWidget.prototype);
NumberInputBase.prototype.constructor = NumberInputBase;

NumberInputBase.prototype.setDecimalPlaces = function(decimalPlaces) {
  this.decimalPlaces = decimalPlaces
};

NumberInputBase.prototype.setLabel = function(text) {
  this.quantityLabelEl.textContent = text
};

NumberInputBase.prototype.buildUI = function() {
  applyQuantityLabelContent(this.quantityLabelEl, this.labelKey);
  applyTooltipTitles(this.quantityLabelEl, this.inputEl, this.labelKey, this.tooltipLocaleKey)
};

NumberInputBase.prototype.setValue = function(value, shouldEmit) {
  const minEqualsMax = this.minValue == this.maxValue;
  if (!minEqualsMax && this.minValue >= 0) value = Math.max(this.minValue, value);
  if (this.decimalPlaces == 0) value = Math.round(value);
  this.inputEl.value = formatNumericFieldDisplay(
    value,
    this.decimalPlaces,
    this.appendUnitToValueDisplay,
    this.unitSuffixString
  );
  this.rangeEl.value = this.useLogarithmicRangeMapper
    ? mapValueToLogRangeSlider(value, this.minValue, this.maxValue)
    : value;
  if (shouldEmit) this.emitChange()
};

NumberInputBase.prototype.getValue = function() {
  let parsed = parseFloat(this.inputEl.value);
  if (isNaN(parsed)) parsed = 0;
  return parsed
};

NumberInputBase.prototype.getDisplaySuffix = function() {
  return this.unitSuffixString
};

NumberInputBase.prototype.onInput = function(evt) {
  let nextValue = 0;
  if (evt.currentTarget == this.inputEl) {
    nextValue = parseNumericFieldInput(this, evt.target.value)
  } else {
    if (Date.now() - this.lastRangeClickTimestamp < RANGE_CLICK_INPUT_GUARD_MS) return;
    nextValue = parseFloat(evt.target.value);
    if (this.useLogarithmicRangeMapper) {
      nextValue = mapLogRangeSliderToValue(nextValue, this.minValue, this.maxValue);
      nextValue = this.snapMagnitudeNearRange(nextValue)
    }
  }
  this.setValue(nextValue);
  if (evt.type == "input" && this.emitWidgetSelectOnRangeChangeEndOnly) return;
  this.emitChange()
};

NumberInputBase.prototype.emitChange = function() {
  this.dispatch(new AppEvent(EventType.widgetSelect))
};

NumberInputBase.prototype.snapMagnitudeNearRange = function(value) {
  return snapMagnitudeNearRangeSpan(value, this.minValue, this.maxValue)
};

NumberInputBase.prototype.onQuantityKeyDown = function(evt) {
  let direction = 0;
  if (KeyboardHandler.hasKeyCode(evt.code, KeyboardHandler.ArrowUp)) direction = 1;
  if (KeyboardHandler.hasKeyCode(evt.code, KeyboardHandler.ArrowDown)) direction = -1;
  if (direction != 0) this.applyWheelStep(direction, evt.shiftKey)
};

NumberInputBase.prototype.onQuantityWheel = function(evt) {
  this.applyWheelStep(evt.deltaY > 0 ? -1 : 1, evt.shiftKey)
};

NumberInputBase.prototype.applyWheelStep = function(direction, shiftHeld) {
  const current = this.getValue();
  let next = current + computeQuantityWheelStep(current, this.decimalPlaces, direction, shiftHeld);
  if (!this.useLogarithmicRangeMapper && this.maxValue != this.minValue) next = Math.min(this.maxValue, next);
  this.setValue(next);
  this.emitChange()
};

NumberInputBase.prototype.onRangeTrackClick = function(evt) {
  const deltaMs = Date.now() - this.lastRangeClickTimestamp;
  this.lastRangeClickTimestamp = Date.now();
  if (deltaMs > RANGE_DOUBLE_CLICK_MS) return;
  this.setValue(resolveDoubleClickRangeMidpoint(this.minValue, this.maxValue));
  this.emitChange()
};

NumberInputBase.prototype.onLabelPointerDown = function(evt) {
  addPointerMoveListener(document, this.onLabelPointerMoveBound);
  addPointerUpListener(document, this.onLabelPointerUpBound);
  this.dragStartPointerX = getEventPos(evt, document.body).x;
  this.dragStartNumericValue = this.getValue()
};

NumberInputBase.prototype.onLabelPointerMove = function(evt) {
  cancel(evt);
  const pointerX = getEventPos(evt, document.body).x,
    dragState = applyLabelDragValue(
      this,
      pointerX,
      this.dragStartPointerX,
      this.dragStartNumericValue
    );
  this.dragStartPointerX = dragState.dragStartPointerX;
  this.dragStartNumericValue = dragState.dragStartNumericValue;
  this.didDragRescale = true;
  this.setValue(dragState.nextValue);
  this.emitChange()
};

NumberInputBase.prototype.onLabelPointerUp = function(evt) {
  if (!this.didDragRescale) this.inputEl.focus();
  this.didDragRescale = false;
  removePointerMoveListener(document, this.onLabelPointerMoveBound);
  removePointerUpListener(document, this.onLabelPointerUpBound)
};

/** Focus the numeric field and select its text. Matches {@link TextInput#focusAndSelectAll}
 * so dialogs can drive either widget family through one name. */
NumberInputBase.prototype.focusAndSelectAll = function() {
  this.inputEl.select();
  this.inputEl.focus()
};

export {
  NumberInputBase,
  mapValueToLogRangeSlider,
  mapLogRangeSliderToValue,
  formatNumericFieldDisplay,
  snapMagnitudeNearRangeSpan,
  resolveDoubleClickRangeMidpoint,
  computeQuantityWheelStep,
  scanLeadingNumericPrefixLength,
  LOG_RANGE_SLIDER_MAX,
  LOG_RANGE_CURVE_EXPONENT
};

// --- Construction helpers ----------------------------------------------------

function applyInitialUnitState(item, initialValueOrSuffix) {
  item.allowedUnitSuffixes = null;
  let displaySeed = initialValueOrSuffix;
  if (initialValueOrSuffix instanceof Array) {
    item.allowedUnitSuffixes = initialValueOrSuffix;
    displaySeed = initialValueOrSuffix[0]
  }
  item.unitSuffixString = displaySeed
}

function mountNumberInputDom(item, minValue, maxValue, decimalPlaces, useLogarithmicRangeMapper) {
  const inputDomId = allocateNextUniqueId();
  item.quantityLabelEl = makeElement("label", "flabel");
  item.quantityLabelEl.innerHTML = item.labelKey;
  item.quantityLabelEl.setAttribute("style", "cursor:col-resize;");
  item.rangeEl = makeElement("input", "");
  item.rangeEl.setAttribute("type", "range");
  configureRangeElementBounds(item.rangeEl, minValue, maxValue, decimalPlaces, useLogarithmicRangeMapper);
  item.inputEl = makeElement("input", "");
  item.inputEl.setAttribute("type", "text");
  item.inputEl.setAttribute("id", inputDomId);
  item.unitSuffixEl = makeElement("span", "");
  item.unitSuffixEl.innerHTML = item.unitSuffixString
}

function configureRangeElementBounds(rangeEl, minValue, maxValue, decimalPlaces, useLogarithmicRangeMapper) {
  if (useLogarithmicRangeMapper) {
    rangeEl.min = 0;
    rangeEl.max = LOG_RANGE_SLIDER_MAX;
    return
  }
  rangeEl.min = minValue;
  rangeEl.max = maxValue;
  if (decimalPlaces != 0) rangeEl.step = (maxValue - minValue) / 200
}

function wireNumberInputListeners(item, emitWidgetSelectOnRangeChangeEndOnly) {
  item.inputEl.addEventListener("change", item.onInput.bind(item), false);
  item.inputEl.addEventListener("keydown", item.onQuantityKeyDown.bind(item), false);
  item.inputEl.addEventListener("wheel", item.onQuantityWheel.bind(item), false);
  item.rangeEl.addEventListener("input", item.onInput.bind(item), false);
  if (emitWidgetSelectOnRangeChangeEndOnly) item.rangeEl.addEventListener("change", item.onInput.bind(item), false);
  item.rangeEl.addEventListener("click", item.onRangeTrackClick.bind(item), false);
  item.onLabelPointerDownBound = item.onLabelPointerDown.bind(item);
  item.onLabelPointerMoveBound = item.onLabelPointerMove.bind(item);
  item.onLabelPointerUpBound = item.onLabelPointerUp.bind(item);
  addPointerDownListener(item.quantityLabelEl, item.onLabelPointerDownBound);
  item.quantityLabelEl.addEventListener("dragstart", cancel, false)
}

function applyQuantityLabelContent(labelEl, labelKey) {
  if (!labelKey) return;
  if (typeof labelKey == "string" && labelKey.startsWith("<")) labelEl.innerHTML = labelKey;
  else labelEl.textContent = Locale.get(labelKey) + ":"
}

function applyTooltipTitles(labelEl, inputEl, labelKey, tooltipLocaleKey) {
  if (!tooltipLocaleKey) return;
  const tipText = Locale.get(tooltipLocaleKey);
  if (labelKey) labelEl.setAttribute("title", tipText);
  inputEl.setAttribute("title", tipText)
}

// --- Value math / formatting -------------------------------------------------

function mapValueToLogRangeSlider(value, minValue, maxValue) {
  return LOG_RANGE_SLIDER_MAX * Math.pow((value - minValue) / (maxValue - minValue), 1 / LOG_RANGE_CURVE_EXPONENT)
}

function mapLogRangeSliderToValue(sliderValue, minValue, maxValue) {
  return minValue + Math.pow(sliderValue / LOG_RANGE_SLIDER_MAX, LOG_RANGE_CURVE_EXPONENT) * (maxValue - minValue)
}

function formatNumericFieldDisplay(value, decimalPlaces, appendUnitToValueDisplay, unitSuffixString) {
  const numericText = decimalPlaces != 0 ? value.toFixed(decimalPlaces) : value;
  if (!(appendUnitToValueDisplay && unitSuffixString)) return numericText + "";
  const needsSpace = unitSuffixString.toLowerCase() != unitSuffixString.toUpperCase();
  return numericText + (needsSpace ? " " : "") + unitSuffixString
}

function snapMagnitudeNearRangeSpan(value, minValue, maxValue) {
  if (maxValue - minValue > 50 && value > 10) value = Math.round(value);
  return value
}

function resolveDoubleClickRangeMidpoint(minValue, maxValue) {
  let midpoint = (maxValue + minValue) / 2;
  if (minValue < 0 && maxValue > 0) midpoint = 0;
  else if (minValue < 1 && maxValue > 1 && maxValue < 10) midpoint = 1;
  return midpoint
}

function computeQuantityWheelStep(currentValue, decimalPlaces, direction, shiftHeld) {
  let step = direction * (decimalPlaces == null || decimalPlaces == 0 || currentValue > 5 ? 1 : 0.1);
  if (shiftHeld) step *= 10;
  return step
}

function scanLeadingNumericPrefixLength(rawText) {
  let scan = 0;
  while (
    scan < rawText.length &&
    (rawText.charAt(scan) == "." || 48 <= rawText.charCodeAt(scan) && rawText.charCodeAt(scan) <= 57)
  ) {
    scan++
  }
  return scan
}

function parseNumericFieldInput(item, rawText) {
  const scan = scanLeadingNumericPrefixLength(rawText);
  let nextValue = rawText == "" ? 0 : parseFloat(rawText);
  if (isNaN(nextValue)) nextValue = 0;
  const trailingUnit = rawText.slice(scan).trim();
  if (item.allowedUnitSuffixes && item.allowedUnitSuffixes.indexOf(trailingUnit) != -1) {
    item.unitSuffixString = trailingUnit
  }
  return nextValue
}

/**
 * Update drag anchors when the scrubbed value hits min/max (sticky ends).
 */
function applyLabelDragValue(item, pointerX, dragStartPointerX, dragStartNumericValue) {
  const minEqualsMax = item.minValue == item.maxValue,
    deltaX = (pointerX - dragStartPointerX) * (minEqualsMax ? 1 : 1 / LABEL_DRAG_SPAN_PIXELS * (item.maxValue - item.minValue));
  let nextValue = dragStartNumericValue + deltaX,
    nextDragStartX = dragStartPointerX,
    nextDragStartValue = dragStartNumericValue;
  if (minEqualsMax) {
    return {
      nextValue: Math.round(nextValue),
      dragStartPointerX: nextDragStartX,
      dragStartNumericValue: nextDragStartValue
    }
  }
  nextValue = Math.max(item.minValue, nextValue);
  if (nextValue == item.minValue) {
    nextDragStartX = pointerX;
    nextDragStartValue = item.minValue
  }
  if (!item.useLogarithmicRangeMapper) {
    nextValue = Math.min(item.maxValue, nextValue);
    if (nextValue == item.maxValue) {
      nextDragStartX = pointerX;
      nextDragStartValue = item.maxValue
    }
  }
  nextValue = item.snapMagnitudeNearRange(nextValue);
  return {
    nextValue: nextValue,
    dragStartPointerX: nextDragStartX,
    dragStartNumericValue: nextDragStartValue
  }
}
