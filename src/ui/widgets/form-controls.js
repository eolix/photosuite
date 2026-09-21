/**
 * Generic form controls: buttons, checkboxes, text inputs, labels, and the
 * scrollable `MenuList` preset picker used in dialogs and popups.
 */


import { Locale } from "../../core/i18n/locale.js";
import { Point } from "../../core/math/point.js";
import { BaseWidget } from "./base-widget.js";
import { InputHandler } from "../tool-options/input-handler.js";
import { PopupTypes } from "../config/popup-types.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, addPointerDownListener, disableTouchGestures, getDevicePixelRatio, getEventPos, makeElement, preventDomDefaultAction, removeClass, resizeCanvasForDevicePixelRatio, setElementCssSizeForDeviceRatio } from "../../core/dom.js";
import { allocateNextUniqueId } from "../../core/uid.js";
import { AppEvent } from "../../core/event-bus.js";
import { luminanceFromRgb, rgbToHex } from "../../engine/compositing/color-math.js";

/** Hit regions on the fg/bg color canvas (VirtualList). */
const SWATCH_HIT_FOREGROUND = 0;
const SWATCH_HIT_BACKGROUND = 1;
const SWATCH_HIT_SWAP = 2;
const SWATCH_HIT_DEFAULTS = 3;

/**
 * Scrollable thumbnail / list picker with optional rename/delete context menu.
 * @param {boolean} useGsIconClass
 * @param {*|null} presetKind PopupTypes kind when context menu is enabled.
 */
function MenuList(useGsIconClass, presetKind) {
  BaseWidget.call(this);
  this.rowElements = [];
  this.selectedIndex = -1;
  this.useGsIconClass = useGsIconClass;
  this.presetKind = presetKind;
  this.viewMode = 0;
  this.activePath = null;
  this.lastMousePos = new Point(0, 0);
  // One stable reference, so re-registering it on a cell the caller supplied
  // and we reuse across redraws is a no-op rather than a second listener.
  this.boundRowMouseDown = this.onRowMouseDown.bind(this);
  if (presetKind != null) {
    this.contextMenu = new InputHandler([
      { name: "layer.nameChange" },
      { name: "clipboard.delete" }
    ]);
    this.contextMenu.parent = this;
    this.contextMenu.on("select", this.selectItem, this)
  }
  this.el = makeElement("div", "imageset scrollable");
  this.el.addEventListener("contextmenu", preventDomDefaultAction, false)
}

MenuList.prototype = Object.create(BaseWidget.prototype);
MenuList.prototype.constructor = MenuList;

MenuList.prototype.buildUI = function() {
  if (this.contextMenu) this.contextMenu.buildUI()
};

MenuList.prototype.selectItem = function() {
  const menuChoice = this.contextMenu.getSelectedIndices()[0],
    dispatchEvt = new AppEvent(EventType.uiDispatch, true),
    payload = {
      dispatchKind: UiCommand.openResourcePresetPopup,
      popupType: this.presetKind,
      presetSelectionPath: [this.selectedIndex]
    };
  if (menuChoice == 0) {
    const itemLabel = this.activePath[1][this.selectedIndex];
    payload.scriptHostData = "rnm";
    dispatchEvt.data = {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "namewindow",
      initialValue: itemLabel,
      deferredDispatch: {
        appEventType: EventType.uiDispatch,
        payload: payload
      }
    }
  } else {
    dispatchEvt.data = payload;
    payload.scriptHostData = "del"
  }
  this.dispatch(dispatchEvt)
};

MenuList.prototype.getViewMode = function() {
  return this.viewMode
};

MenuList.prototype.setViewMode = function(viewMode) {
  this.viewMode = viewMode;
  if (this.activePath) this.redraw()
};

MenuList.prototype.setThumbnailGrid = function(urlList, labelList, thumbW, thumbH) {
  this.activePath = [urlList, labelList, thumbW, thumbH];
  this.redraw()
};

MenuList.prototype.redraw = function() {
  const path = this.activePath,
    urlList = path[0],
    labelList = path[1],
    thumbW = path[2],
    thumbH = path[3],
    onThumbMouseDown = this.boundRowMouseDown,
    viewMode = this.viewMode;
  this.rowElements = [];
  this.el.innerHTML = "";
  if (viewMode == 0) addClass(this.el, "imageset");
  else removeClass(this.el, "imageset");
  for (let i = 0; i < urlList.length; i++) {
    const src = urlList[i];
    if (src == null) {
      this.rowElements.push(null);
      continue
    }
    const thumbEl = buildMenuListThumbElement(
      src,
      labelList,
      i,
      thumbW,
      thumbH,
      viewMode,
      this.useGsIconClass
    );
    thumbEl.addEventListener("mousedown", onThumbMouseDown, false);
    this.rowElements.push(thumbEl);
    this.el.appendChild(thumbEl)
  }
};

MenuList.prototype.onRowMouseDown = function(evt) {
  evt.preventDefault();
  this.selectedIndex = this.rowElements.indexOf(evt.currentTarget);
  this.lastMousePos = getEventPos(evt, evt.currentTarget);
  if (evt.button == 0) this.dispatch(new AppEvent(EventType.widgetSelect));
  if (evt.button == 2 && this.contextMenu) {
    const menu = this.contextMenu;
    menu.update(null);
    const bodyPos = getEventPos(evt, document.body),
      overlayEvt = new AppEvent(EventType.uiDispatch, true);
    overlayEvt.data = {
      dispatchKind: UiCommand.showFloatingOverlay,
      overlayWidget: menu,
      x: bodyPos.x,
      y: bodyPos.y + 2
    };
    this.dispatch(overlayEvt)
  }
};

MenuList.prototype.getValue = function() {
  return this.selectedIndex
};

MenuList.prototype.setValue = function(idx) {
  this.selectedIndex = idx
};

MenuList.prototype.getLastMousePosition = function() {
  const p = this.lastMousePos;
  return new Point(p.x, p.y)
};

MenuList.prototype.highlightRowAtIndex = function(idx) {
  for (let i = 0; i < this.rowElements.length; i++) {
    const row = this.rowElements[i];
    if (row == null) continue;
    if (i == idx) addClass(row, "active");
    else removeClass(row, "active")
  }
};

/**
 * Foreground / background color chip canvas with swap and defaults hits.
 */
function VirtualList() {
  BaseWidget.call(this);
  this.grayscalePreview = false;
  this.canvasSizePx = 20;
  this.swatchSizePx = 10;
  this.lastPickerTarget = 0;
  this.foregroundRgb = { h: 255, l: 0, O: 0 };
  this.backgroundRgb = { h: 0, l: 0, O: 0 };
  this.el = makeElement("canvas");
  this.redraw();
  disableTouchGestures(this.el);
  addPointerDownListener(this.el, this.onPointerDown.bind(this))
}

VirtualList.prototype = Object.create(BaseWidget.prototype);
VirtualList.prototype.constructor = VirtualList;

VirtualList.prototype.setVisible = function(visible) {
  if (this.grayscalePreview == visible) return;
  this.grayscalePreview = visible;
  this.redraw()
};

VirtualList.prototype.buildUI = function() {};

VirtualList.prototype.setColors = function(foregroundPacked, backgroundPacked) {
  if (foregroundPacked != null) this.foregroundRgb = unpackPackedRgb(foregroundPacked);
  if (backgroundPacked != null) this.backgroundRgb = unpackPackedRgb(backgroundPacked);
  this.redraw()
};

VirtualList.prototype.onPointerDown = function(pointerEvent) {
  const localPos = getEventPos(pointerEvent, this.el),
    xPx = localPos.x * getDevicePixelRatio(),
    yPx = localPos.y * getDevicePixelRatio(),
    hitRegion = hitTestFgBgSwatch(xPx, yPx, this.canvasSizePx, this.swatchSizePx),
    uiEvent = new AppEvent(EventType.uiDispatch, true);
  if (hitRegion > SWATCH_HIT_BACKGROUND) {
    uiEvent.data = {
      dispatchKind: UiCommand.openResourcePresetPopup,
      popupType: PopupTypes.COLOR_CHANGE,
      operation: hitRegion
    }
  } else {
    this.lastPickerTarget = hitRegion;
    const pickedRgb =
      hitRegion == SWATCH_HIT_FOREGROUND ? this.foregroundRgb : this.backgroundRgb;
    uiEvent.data = {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "colorpicker",
      colorIntArgb: packRgbChannels(pickedRgb),
      onDialogResult: this.onColorPicked.bind(this)
    }
  }
  this.dispatch(uiEvent)
};

VirtualList.prototype.onColorPicked = function(pickedPacked) {
  const colorEvent = new AppEvent(EventType.uiDispatch, true);
  colorEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.COLOR_CHANGE,
    operation: this.lastPickerTarget,
    value: pickedPacked
  };
  this.dispatch(colorEvent)
};

VirtualList.prototype.redraw = function() {
  const canvas = this.el,
    ctx = canvas.getContext("2d"),
    borderColor = "#aaaaaa",
    insetRatio = 0.65;
  resizeCanvasForDevicePixelRatio(canvas, 34, 34);
  canvas.setAttribute("style", canvas.getAttribute("style") + ";cursor:pointer");
  const canvasSizePx = this.canvasSizePx = canvas.width,
    swatchSizePx = this.swatchSizePx = Math.round(canvasSizePx * insetRatio);
  drawColorSwatch(
    ctx,
    canvasSizePx - swatchSizePx,
    canvasSizePx - swatchSizePx,
    swatchSizePx,
    rgbToCssHex(this.backgroundRgb, this.grayscalePreview)
  );
  drawColorSwatch(
    ctx,
    0,
    0,
    swatchSizePx,
    rgbToCssHex(this.foregroundRgb, this.grayscalePreview)
  );
  const innerSize = canvasSizePx - swatchSizePx,
    arrowArm = Math.round(innerSize * insetRatio);
  drawColorSwatch(
    ctx,
    canvasSizePx - arrowArm,
    innerSize - arrowArm,
    arrowArm,
    "white",
    borderColor
  );
  drawColorSwatch(ctx, canvasSizePx - innerSize, 0, arrowArm, "black", borderColor);
  drawSwapArrows(ctx, canvasSizePx, swatchSizePx, borderColor)
};

/**
 * @param {string} labelKey
 * @param {boolean} spread
 * @param {string|null} tooltipKey
 * @param {boolean} bigButton
 */
function Button(labelKey, spread, tooltipKey, bigButton) {
  BaseWidget.call(this);
  this.el = makeElement(
    "button",
    "fitem" + (spread ? " spread" : "") + (bigButton ? " bbtn" : "")
  );
  this.labelKey = labelKey;
  this.tooltipKey = tooltipKey;
  this.buildUI();
  this.el.addEventListener("click", this.onClick.bind(this), false)
}

Button.prototype = Object.create(BaseWidget.prototype);
Button.prototype.constructor = Button;

Button.prototype.buildUI = function() {
  const el = this.el,
    text = resolveLocaleText(this.labelKey);
  if (isHtmlMarkupLabel(text)) {
    el.innerHTML = text;
    el.setAttribute("style", "padding:2px")
  } else {
    el.textContent = text
  }
  if (this.tooltipKey) {
    el.setAttribute("title", resolveLocaleText(this.tooltipKey))
  }
};

Button.prototype.setTooltipText = function(title) {
  this.el.setAttribute("title", title)
};

Button.prototype.onClick = function() {
  this.dispatch(new AppEvent("click", false))
};

Button.prototype.markActive = function() {
  addClass(this.el, "bactive")
};

Button.prototype.clearActive = function() {
  removeClass(this.el, "bactive")
};

Button.prototype.setLabel = function(labelKey, tooltipKey) {
  if (labelKey) this.labelKey = labelKey;
  if (tooltipKey) this.tooltipKey = tooltipKey;
  this.buildUI()
};

Button.prototype.setValue = function(on) {
  if (on) this.markActive();
  else this.clearActive()
};

Button.prototype.isPressed = function() {
  return this.el.getAttribute("class").indexOf("bactive") != -1
};

Button.prototype.getValue = function() {
  return this.isPressed()
};

function Label(labelKey, spread) {
  BaseWidget.call(this);
  this.labelKey = labelKey;
  this.el = makeElement("span", "labelitem fitem" + (spread ? " spread" : ""));
  this.buildUI()
}

Label.prototype = Object.create(BaseWidget.prototype);
Label.prototype.constructor = Label;

Label.prototype.setValue = function(text) {
  this.el.textContent = text
};

Label.prototype.getValue = function() {
  return this.el.textContent
};

Label.prototype.enable = function() {
  this.el.removeAttribute("disabled")
};

Label.prototype.disable = function() {
  this.el.setAttribute("disabled", "")
};

Label.prototype.setLabel = function(text) {
  this.el.textContent = text
};

Label.prototype.buildUI = function() {
  this.el.textContent = Locale.get(this.labelKey)
};

Label.prototype.getLabelKey = function() {
  return this.labelKey
};

/**
 * @param {string|null} labelKey
 * @param {string|null} suffixText
 * @param {number|null} widthEm
 * @param {number|null} rows
 */
function TextInput(labelKey, suffixText, widthEm, rows) {
  BaseWidget.call(this);
  const inputId = allocateNextUniqueId();
  let style = "";
  this.el = makeElement("span", "fitem tinput");
  if (labelKey) {
    this.labelKey = labelKey;
    this.quantityLabelEl = makeElement("label", "flabel");
    this.el.appendChild(this.quantityLabelEl);
    this.quantityLabelEl.setAttribute("for", inputId);
    this.buildUI()
  }
  if (rows == null) {
    this.inputEl = makeElement("input", "");
    this.inputEl.setAttribute("type", "text")
  } else {
    this.inputEl = makeElement("textarea", "scrollable")
  }
  this.inputEl.setAttribute("id", inputId);
  if (widthEm) style += "width:" + widthEm + "em;";
  if (rows) this.inputEl.setAttribute("rows", rows);
  if (style != "") this.inputEl.setAttribute("style", style);
  this.el.appendChild(this.inputEl);
  if (suffixText) {
    this.unitSuffixEl = makeElement("span", "");
    this.unitSuffixEl.textContent = suffixText;
    this.el.appendChild(this.unitSuffixEl)
  }
  this.inputEl.addEventListener("change", this.onInput.bind(this), false);
  this.inputEl.addEventListener("input", this.onTextInput.bind(this), false)
}

TextInput.prototype = Object.create(BaseWidget.prototype);
TextInput.prototype.constructor = TextInput;

TextInput.prototype.buildUI = function() {
  if (this.labelKey) this.quantityLabelEl.textContent = Locale.get(this.labelKey) + ":"
};

TextInput.prototype.setLabel = function(text) {
  this.quantityLabelEl.textContent = text
};

TextInput.prototype.setValue = function(value) {
  this.inputEl.value = value == null ? "" : value
};

TextInput.prototype.getValue = function() {
  return this.inputEl.value
};

TextInput.prototype.focusAndSelectAll = function() {
  this.inputEl.select();
  this.inputEl.focus()
};

TextInput.prototype.onInput = function() {
  this.dispatch(new AppEvent(EventType.widgetSelect, false))
};

TextInput.prototype.onTextInput = function() {
  this.dispatch(new AppEvent("input", false))
};

/**
 * @param {string} labelKey
 * @param {boolean|null} linkLabel
 * @param {string|null} labelClass
 */
function Checkbox(labelKey, linkLabel, labelClass) {
  BaseWidget.call(this);
  this.el = makeElement("span", "fitem cbox");
  if (linkLabel == null) linkLabel = true;
  if (labelClass == null) labelClass = "flabel";
  const inputId = "cb" + allocateNextUniqueId();
  this.inputEl = makeElement("input", "");
  this.inputEl.setAttribute("type", "checkbox");
  this.inputEl.setAttribute("id", inputId);
  this.el.appendChild(this.inputEl);
  this.labelKey = labelKey;
  this.quantityLabelEl = makeElement("label", labelClass);
  if (linkLabel) this.quantityLabelEl.setAttribute("for", inputId);
  this.el.appendChild(this.quantityLabelEl);
  this.buildUI();
  this.inputEl.addEventListener("change", this.onInput.bind(this), false)
}

Checkbox.prototype = Object.create(BaseWidget.prototype);
Checkbox.prototype.constructor = Checkbox;

Checkbox.prototype.getLabelKey = function() {
  return this.labelKey
};

Checkbox.prototype.setLabel = function(text) {
  this.quantityLabelEl.textContent = text
};

Checkbox.prototype.buildUI = function() {
  const key = this.labelKey;
  if (typeof key == "string" && key.startsWith("<")) this.quantityLabelEl.innerHTML = key;
  else this.quantityLabelEl.textContent = Locale.get(key)
};

Checkbox.prototype.markActive = function() {
  this.inputEl.checked = true
};

Checkbox.prototype.clearActive = function() {
  this.inputEl.checked = false
};

Checkbox.prototype.isPressed = function() {
  return this.inputEl.checked
};

Checkbox.prototype.setValue = function(on) {
  this.inputEl.checked = on
};

Checkbox.prototype.getValue = Checkbox.prototype.isPressed;

Checkbox.prototype.onInput = function() {
  this.dispatch(new AppEvent(EventType.widgetSelect, false))
};

/**
 * Build one grid cell. `src` is either an image URL or a ready-made element
 * (a `<canvas>`, say) that the caller paints itself — the element form skips
 * the encode/decode round trip a data URL would cost per cell.
 */
function buildMenuListThumbElement(
  src,
  labelList,
  index,
  thumbW,
  thumbH,
  viewMode,
  useGsIconClass
) {
  const isElementSource = src instanceof Element;
  let thumbEl = isElementSource ? src : makeElement("img", "image");
  if (isElementSource) addClass(thumbEl, "image");
  if (thumbW) setElementCssSizeForDeviceRatio(thumbEl, thumbW, thumbH);
  if (useGsIconClass) addClass(thumbEl, "gsicon");
  if (!isElementSource) thumbEl.setAttribute("src", src);
  if (viewMode != 0) {
    const row = makeElement("div", "listitem");
    row.appendChild(thumbEl);
    const caption = makeElement("span");
    caption.textContent = labelList ? labelList[index] : "Item " + (index + 1);
    caption.setAttribute("style", "margin-left:4px;");
    row.appendChild(caption);
    thumbEl = row
  }
  if (labelList) thumbEl.setAttribute("title", labelList[index]);
  return thumbEl
}

/**
 * Unpack 24-bit RGB int into the app color shape { h, l, O }.
 * @param {number} packed
 * @returns {{ h: number, l: number, O: number }}
 */
function unpackPackedRgb(packed) {
  return {
    h: packed >> 16 & 255,
    l: packed >> 8 & 255,
    O: packed & 255
  }
}

function packRgbChannels(rgb) {
  return rgb.h << 16 | rgb.l << 8 | rgb.O
}

/**
 * @param {number} xPx device pixels
 * @param {number} yPx device pixels
 * @param {number} canvasSizePx
 * @param {number} swatchSizePx
 * @returns {number} SWATCH_HIT_*
 */
function hitTestFgBgSwatch(xPx, yPx, canvasSizePx, swatchSizePx) {
  if (xPx < swatchSizePx && yPx < swatchSizePx) return SWATCH_HIT_FOREGROUND;
  if (xPx > canvasSizePx - swatchSizePx && yPx > canvasSizePx - swatchSizePx) {
    return SWATCH_HIT_BACKGROUND
  }
  if (xPx < swatchSizePx) return SWATCH_HIT_SWAP;
  return SWATCH_HIT_DEFAULTS
}

function rgbToCssHex(rgb, grayscale) {
  let r = rgb.h,
    g = rgb.l,
    blue = rgb.O;
  if (grayscale) r = g = blue = Math.round(luminanceFromRgb(r, g, blue));
  return "#" + rgbToHex(r << 16 | g << 8 | blue)
}

function drawColorSwatch(ctx, x, y, size, fillCss, borderCss) {
  ctx.fillStyle = borderCss ? borderCss : "black";
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = fillCss;
  ctx.fillRect(x + 1, y + 1, size - 2, size - 2)
}

function drawSwapArrows(ctx, canvasSizePx, swatchSizePx, borderColor) {
  ctx.save();
  ctx.fillStyle = borderColor;
  ctx.translate(0, canvasSizePx);
  ctx.rotate(-Math.PI / 2);
  const innerSize = canvasSizePx - swatchSizePx,
    arrowOffset = Math.round(innerSize * 0.28),
    arrowHead = Math.round(innerSize * 0.25);
  for (let passIdx = 0; passIdx < 2; passIdx++) {
    ctx.fillRect(arrowOffset, arrowOffset, innerSize - arrowOffset, 1);
    ctx.beginPath();
    ctx.moveTo(innerSize - arrowHead, arrowOffset + 0.5 - arrowHead);
    ctx.lineTo(innerSize, arrowOffset + 0.5);
    ctx.lineTo(innerSize - arrowHead, arrowOffset + 0.5 + arrowHead);
    ctx.closePath();
    ctx.fill();
    ctx.transform(0, 1, 1, 0, 0, 0)
  }
  ctx.restore()
}

function resolveLocaleText(key) {
  const resolved = Locale.get(key);
  let text = resolved == null ? "" : resolved;
  if (typeof text !== "string") text = String(text);
  return text
}

function isHtmlMarkupLabel(text) {
  return text.startsWith("<img") || text.startsWith("<svg")
}

export {
  MenuList,
  VirtualList,
  Button,
  Label,
  TextInput,
  Checkbox,
  unpackPackedRgb,
  packRgbChannels,
  hitTestFgBgSwatch,
  SWATCH_HIT_FOREGROUND,
  SWATCH_HIT_BACKGROUND,
  SWATCH_HIT_SWAP,
  SWATCH_HIT_DEFAULTS
};
