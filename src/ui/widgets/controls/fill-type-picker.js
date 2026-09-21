/**
 * Fill-type preview button with a floating editor panel. The trigger canvas
 * shows a live preview of the current fill; clicking opens a popup with a
 * four-way type menu (none / color / gradient / pattern) and the matching editor
 * for the active type — a color swatch grid, or a gradient/pattern LayerEffectRow.
 *
 * A fill value is `{ fillKind, fillDescriptor }`, where fillKind indexes the
 * type menu (0 none, 1 color, 2 gradient, 3 pattern) and fillDescriptor is the
 * PSD-style fill descriptor. Previews are keyed by buildFillPreviewCacheKey so
 * unchanged fills are not re-rendered.
 */

import { ColorSampleWidget, ColorSwatchGrid } from "./color-controls.js";
import { ButtonMenu } from "./popup-controls.js";
import { PatternPickerButton } from "./effect-pickers.js";
import { BaseWidget } from "../base-widget.js";

import { Locale } from "../../../core/i18n/locale.js";

import { LayerEffectDefs } from "../../../document/formats/psd/effect-defs.js";
import { LayerStyleRenderer } from "../../../features/layer-styles/style-renderer.js";
import { PopupTypes } from "../../config/popup-types.js";
import { LayerEffectRow } from "../../panels/layer-effect-row.js";
import { findPattern } from "../../../document/formats/psd/layer-data-parsers.js";
import { EventType, UiCommand } from "../../../core/event-bus.js";
import { appendBreak, getDevicePixelRatio, makeElement, setElementCssSizeForDeviceRatio } from "../../../core/dom.js";
import { AppEvent } from "../../../core/event-bus.js";
import { GradientTool } from "../../../document/tools/paint-tools.js";
import { rgbToHex } from "../../../engine/compositing/color-math.js";
import { psdColorToRgb } from "../../../engine/compositing/psd-color-utils.js";

/** Gradient effect-row widget keys (PSD / effect wire names). */
const GRADIENT_FILL_WIDGET_KEYS = "Grad Type Algn Angl Rvrs Scl Ofst".split(" ");

/** Pattern effect-row widget keys. */
const PATTERN_FILL_WIDGET_KEYS = ["Ptrn", "Scl", "Algn", "phase"];

/** Swatch size, in CSS pixels. Matches the stroke preview beside it. */
const FILL_SWATCH_WIDTH = 24;
const FILL_SWATCH_HEIGHT = 16;

const FILL_TYPE_LABEL_KEYS = [
  "colour.labels.none",
  "colour.title",
  "properties.gradient",
  "properties.pattern"
];

/**
 * Toolbar fill picker: canvas preview + floating fill-type editor.
 * @param {string} labelLocaleKey
 */
function FillTypePicker(labelLocaleKey) {
  BaseWidget.call(this);
  this.fillTypePresets = null;
  this.doc = null;
  this.documentContext = null;
  this.activeFillPanelEl = null;
  this.fillTypeMenuHtmlItems = [];
  this.fillTypePreviewCacheKeys = [];
  this.labelLocaleKey = labelLocaleKey;
  this.lastPreviewCacheKey = null;
  mountFillTypePickerChrome(this);
  mountFillTypePopupPanels(this)
}

FillTypePicker.prototype = Object.create(BaseWidget.prototype);
FillTypePicker.prototype.constructor = FillTypePicker;

FillTypePicker.prototype.onUpdate = function(documentModel, popupType) {
  if (popupType == PopupTypes.PATTERNS) {
    this.fillTypeMenuHtmlItems = [];
    this.fillTypePreviewCacheKeys = [];
    if (this.fillTypePresets) this.setValue(this.documentContext, this.getValue(), this.fillTypePresets)
  }
  this.doc = documentModel;
  this.gradientEffectRow.onUpdate(documentModel, popupType);
  this.patternEffectRow.onUpdate(documentModel, popupType)
};

FillTypePicker.prototype.buildUI = function() {
  this.labelEl.textContent = Locale.get(this.labelLocaleKey) + ": ";
  this.fillTypeMenu.buildUI();
  this.colorDataWidget.buildUI();
  this.gradientEffectRow.buildUI();
  this.patternEffectRow.buildUI()
};

FillTypePicker.prototype.onChange = function(changeEvent) {
  const eventTarget = changeEvent.currentTarget;
  if (eventTarget == this.fillTypeMenu) {
    const fillKind = this.fillTypeMenu.getValue(),
      fillValue = {
        fillKind: fillKind,
        fillDescriptor: this.fillTypePresets[fillKind]
      };
    if (fillKind > 0 && fillValue.fillDescriptor == null) {
      fillValue.fillDescriptor = LayerEffectDefs.getFillLayerDefault(fillKind - 1)
    }
    if (this.fillTypePresets) this.setValue(this.documentContext, fillValue, this.fillTypePresets)
  }
  if (eventTarget == this.swatchGridWidget) this.colorDataWidget.setPackedRgb(eventTarget.getValue());
  this.dispatch(new AppEvent(EventType.widgetSelect, false))
};

FillTypePicker.prototype.togglePopup = function() {
  const canvasRect = this.canvas.getBoundingClientRect(),
    overlayEvent = new AppEvent(EventType.uiDispatch, true);
  overlayEvent.data = {
    dispatchKind: UiCommand.showFloatingOverlay,
    overlayWidget: this.floatWrap,
    x: canvasRect.left,
    y: canvasRect.top + canvasRect.height + 4
  };
  this.dispatch(overlayEvent);
  this.swatchGridWidget.setValue(this.colorDataWidget.getPackedRgb())
};

FillTypePicker.prototype.setValue = function(documentContext, fillValue, fillTypePresets) {
  this.fillTypePresets = fillTypePresets;
  this.documentContext = documentContext;
  syncFillTypeMenuThumbnails(this, fillTypePresets);
  this.fillTypeMenu.setValue(fillValue.fillKind);
  const cacheKey = buildFillPreviewCacheKey(fillValue);
  if (cacheKey != this.lastPreviewCacheKey) {
    renderFillPreview(this.ctx2d, fillValue, this.doc, this.documentContext, FILL_SWATCH_WIDTH, FILL_SWATCH_HEIGHT)
  }
  this.lastPreviewCacheKey = cacheKey;
  applyFillDescriptorToActivePanel(this, documentContext, fillValue);
  switchActiveFillPanel(this, resolveActiveFillPanelEl(this, fillValue.fillKind))
};

FillTypePicker.prototype.getValue = function() {
  const fillValue = {
    fillKind: this.fillTypeMenu.getValue()
  };
  if (fillValue.fillKind == 1) {
    fillValue.fillDescriptor = LayerEffectDefs.getFillLayerDefault(0);
    fillValue.fillDescriptor.Clr.v = this.colorDataWidget.getValue()
  }
  if (fillValue.fillKind == 2) fillValue.fillDescriptor = this.gradientEffectRow.getValue();
  if (fillValue.fillKind == 3) fillValue.fillDescriptor = this.patternEffectRow.getValue();
  return fillValue
};

FillTypePicker.buildFillPreviewCacheKey = buildFillPreviewCacheKey;
FillTypePicker.renderFillPreview = renderFillPreview;
FillTypePicker.scratchCtx2d = makeElement("canvas").getContext("2d");

export {
  FillTypePicker,
  buildFillPreviewCacheKey,
  renderFillPreview,
  FILL_TYPE_LABEL_KEYS
};

// --- DOM mount ---------------------------------------------------------------

function mountFillTypePickerChrome(picker) {
  picker.el = makeElement("span", "fitem fillbutton");
  picker.floatWrap = new BaseWidget();
  picker.floatWrap.el = makeElement("div", "floatcont form");
  picker.floatWrap.el.setAttribute("style", "width: 21em;");
  picker.floatWrap.parent = picker;
  picker.labelEl = makeElement("label", "flabel");
  picker.el.appendChild(picker.labelEl);
  picker.canvas = makeElement("canvas");
  picker.ctx2d = picker.canvas.getContext("2d");
  picker.el.appendChild(picker.canvas);
  // The swatch shows the fill itself, so its dropdown marker sits beside it as
  // the same chevron every other options-bar control uses.
  picker.chevronEl = makeElement("span", "chevron");
  picker.el.appendChild(picker.chevronEl);
  const openPopup = picker.togglePopup.bind(picker);
  picker.canvas.addEventListener("click", openPopup, false);
  picker.chevronEl.addEventListener("click", openPopup, false)
}

function mountFillTypePopupPanels(picker) {
  picker.fillTypeMenu = new ButtonMenu("properties.fillType", ["", "Color", "Grad", "Patt"]);
  picker.floatWrap.el.appendChild(picker.fillTypeMenu.el);
  picker.fillTypeMenu.on(EventType.widgetSelect, picker.onChange, picker);
  picker.floatWrap.el.appendChild(makeElement("hr"));
  picker.emptyFillPanelEl = makeElement("span");
  picker.colorDataWidget = new ColorSampleWidget(true);
  picker.colorDataWidget.parent = picker.floatWrap;
  picker.colorDataWidget.on(EventType.widgetSelect, picker.onChange, picker);
  picker.swatchGridWidget = new ColorSwatchGrid(10);
  picker.swatchGridWidget.on(EventType.widgetSelect, picker.onChange, picker);
  picker.colorFillPanelEl = makeElement("div", "marged hiline");
  picker.colorFillPanelEl.appendChild(picker.colorDataWidget.el);
  appendBreak(picker.colorFillPanelEl);
  picker.colorFillPanelEl.appendChild(picker.swatchGridWidget.el);
  picker.gradientEffectRow = new LayerEffectRow("GrFl", true);
  picker.gradientEffectRow.parent = picker.floatWrap;
  picker.gradientEffectRow.on(EventType.widgetSelect, picker.onChange, picker);
  picker.gradientFillPanelEl = makeElement("div", "marged hiline");
  appendEffectRowWidgets(picker.gradientFillPanelEl, picker.gradientEffectRow, GRADIENT_FILL_WIDGET_KEYS);
  picker.patternEffectRow = new LayerEffectRow("patternFill", true);
  picker.patternEffectRow.parent = picker.floatWrap;
  picker.patternEffectRow.on(EventType.widgetSelect, picker.onChange, picker);
  picker.patternFillPanelEl = makeElement("div", "marged hiline");
  appendEffectRowWidgets(picker.patternFillPanelEl, picker.patternEffectRow, PATTERN_FILL_WIDGET_KEYS)
}

function appendEffectRowWidgets(panelEl, effectRow, widgetKeys) {
  for (let widgetIdx = 0; widgetIdx < widgetKeys.length; widgetIdx++) {
    panelEl.appendChild(effectRow.widgets[widgetKeys[widgetIdx]].el)
  }
}

// --- Value / panel sync ------------------------------------------------------

function syncFillTypeMenuThumbnails(picker, fillTypePresets) {
  const menuHtmlItems = picker.fillTypeMenuHtmlItems,
    menuCacheKeys = picker.fillTypePreviewCacheKeys;
  let menuItemsDirty = false;
  for (let fillKind = 0; fillKind < 4; fillKind++) {
    const presetFillValue = {
        fillKind: fillKind,
        fillDescriptor: fillTypePresets[fillKind]
      },
      cacheKey = buildFillPreviewCacheKey(presetFillValue);
    if (menuCacheKeys[fillKind] == cacheKey) continue;
    menuItemsDirty = true;
    const previewDataUrl = renderFillPreview(null, presetFillValue, picker.doc, picker.documentContext, 22, 22, false);
    menuHtmlItems[fillKind] = "<img width=\"22\" height=\"22\" src=\"" + previewDataUrl + "\" />";
    menuCacheKeys[fillKind] = cacheKey
  }
  if (menuItemsDirty) picker.fillTypeMenu.setItems(menuHtmlItems, FILL_TYPE_LABEL_KEYS)
}

function resolveActiveFillPanelEl(picker, fillKind) {
  if (fillKind == 0) return picker.emptyFillPanelEl;
  if (fillKind == 1) return picker.colorFillPanelEl;
  if (fillKind == 2) return picker.gradientFillPanelEl;
  if (fillKind == 3) return picker.patternFillPanelEl;
  return picker.emptyFillPanelEl
}

function applyFillDescriptorToActivePanel(picker, documentContext, fillValue) {
  const fillKind = fillValue.fillKind;
  if (fillKind == 1) picker.colorDataWidget.setValue(fillValue.fillDescriptor.Clr.v);
  if (fillKind == 2) picker.gradientEffectRow.update(documentContext, fillValue.fillDescriptor);
  if (fillKind == 3) picker.patternEffectRow.update(documentContext, fillValue.fillDescriptor)
}

function switchActiveFillPanel(picker, activePanelEl) {
  if (activePanelEl == picker.activeFillPanelEl) return;
  if (picker.activeFillPanelEl != null) picker.floatWrap.el.removeChild(picker.activeFillPanelEl);
  picker.floatWrap.el.appendChild(activePanelEl);
  picker.activeFillPanelEl = activePanelEl
}

// --- Preview cache / render --------------------------------------------------

function buildFillPreviewCacheKey(fillValue) {
  const fillKind = fillValue.fillKind,
    fillPayload = fillValue.fillDescriptor;
  let cacheKey = "empty";
  if (fillKind == 1) {
    cacheKey = psdColorToRgb(fillPayload.Clr.v);
    cacheKey = cacheKey.h + "," + cacheKey.l + "," + cacheKey.O
  }
  if (fillKind == 2) cacheKey = JSON.stringify(fillPayload.Grad.v);
  if (fillKind == 3) cacheKey = fillPayload.Ptrn.v.Idnt.v;
  return cacheKey
}

function renderFillPreview(ctx2d, fillValue, documentModel, documentContext, widthPx, heightPx) {
  if (ctx2d == null) ctx2d = FillTypePicker.scratchCtx2d;
  const pixelWidth = Math.floor(widthPx * getDevicePixelRatio()),
    pixelHeight = Math.floor(heightPx * getDevicePixelRatio()),
    canvasEl = ctx2d.canvas;
  canvasEl.width = pixelWidth;
  canvasEl.height = pixelHeight;
  setElementCssSizeForDeviceRatio(canvasEl, pixelWidth, pixelHeight);
  paintFillPreviewContent(ctx2d, fillValue, documentModel, documentContext, pixelWidth, pixelHeight);
  if (ctx2d == FillTypePicker.scratchCtx2d) return canvasEl.toDataURL()
}

function paintFillPreviewContent(ctx2d, fillValue, documentModel, documentContext, pixelWidth, pixelHeight) {
  const fillKind = fillValue.fillKind;
  if (fillKind == 0) {
    paintEmptyFillPreview(ctx2d, pixelWidth, pixelHeight);
    return
  }
  if (fillKind == 1) {
    paintSolidColorFillPreview(ctx2d, fillValue.fillDescriptor.Clr.v, pixelWidth, pixelHeight);
    return
  }
  if (fillKind == 2) {
    GradientTool.renderGradientPreviewDataUrl(
      fillValue.fillDescriptor.Grad.v,
      pixelWidth,
      pixelHeight,
      0,
      documentModel.colorInt,
      documentModel.bgColor,
      ctx2d.canvas
    );
    return
  }
  if (fillKind == 3) {
    paintPatternFillPreview(ctx2d, fillValue.fillDescriptor.Ptrn.v, documentModel, documentContext, pixelWidth, pixelHeight)
  }
}

function paintEmptyFillPreview(ctx2d, pixelWidth, pixelHeight) {
  ctx2d.fillStyle = "#ffffff";
  ctx2d.fillRect(0, 0, pixelWidth, pixelHeight);
  ctx2d.strokeStyle = "#ff0000";
  ctx2d.lineWidth = 2;
  ctx2d.moveTo(0, 0);
  ctx2d.lineTo(pixelWidth, pixelHeight);
  ctx2d.moveTo(0, pixelHeight);
  ctx2d.lineTo(pixelWidth, 0);
  ctx2d.stroke()
}

function paintSolidColorFillPreview(ctx2d, psdColorDesc, pixelWidth, pixelHeight) {
  const rgb = psdColorToRgb(psdColorDesc);
  ctx2d.fillStyle = "#" + rgbToHex(rgb.h << 16 | rgb.l << 8 | rgb.O);
  ctx2d.fillRect(0, 0, pixelWidth, pixelHeight)
}

function paintPatternFillPreview(ctx2d, patternDesc, documentModel, documentContext, pixelWidth, pixelHeight) {
  let patternResource = null;
  if (documentContext != null) patternResource = findPattern(patternDesc, documentContext.add.Patt);
  if (patternResource == null) patternResource = findPattern(patternDesc, documentModel.patternPresets);
  PatternPickerButton.renderPatternPreviewDataUrl(patternResource, pixelWidth, pixelHeight, ctx2d.canvas)
}
