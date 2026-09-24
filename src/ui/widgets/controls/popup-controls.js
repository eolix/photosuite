/**
 * Popup buttons, dropdowns, and compact option widgets for panels and tool options.
 *
 * Each widget extends BaseWidget and follows the same contract: `buildUI()`
 * (re)renders localized text, `getValue()` / `setValue()` read and write the
 * widget's state, and user interaction dispatches an `EventType.widgetSelect` event
 * that bubbles to the owning panel. The pure helpers at the top hold the index
 * math and filtering logic, kept free of DOM so they can be unit-tested.
 */

import { HistogramCanvas } from "./histogram-canvas.js";
import { SliderDropdown } from "./number-inputs.js";
import { BaseWidget } from "../base-widget.js";
import { Button, Checkbox, Label, MenuList } from "../form-controls.js";
import { PresetTreeList } from "../preset-tree-list.js";
import { InputHandler } from "../../tool-options/input-handler.js";

import { Locale } from "../../../core/i18n/locale.js";
import { Matrix2D } from "../../../core/math/matrix2d.js";
import { Rect } from "../../../core/math/rect.js";
import { getFontCatalog } from "../../../fonts/system-font-catalog.js";

import { AdjustmentEngine } from "../../../features/adjustments/adjustment-engine.js";
import { PopupTypes } from "../../config/popup-types.js";
import { getIconUrl, iconImgHtml } from "../../../assets/icon-registry.js";
import { EventType, UiCommand } from "../../../core/event-bus.js";
import { clearElement, getDevicePixelRatio, isInDOM, makeElement, setElementCssSizeForDeviceRatio } from "../../../core/dom.js";
import { allocateNextUniqueId } from "../../../core/uid.js";
import { AppEvent } from "../../../core/event-bus.js";
import { GradientTool } from "../../../document/tools/paint-tools.js";
import { normalizePathToCubics, rectToPathOutline, subdividePathByFlatness, toTyprPath, transformCoordPairs } from "../../../engine/compositing/anti-alias.js";
import { rgbToHex } from "../../../engine/compositing/color-math.js";
import { warpCoordsThroughMesh } from "../../../engine/compositing/image-renderer.js";
import { WARP_STYLE_LABELS, computeWarpGrid } from "../../../engine/compositing/warp.js";

const BLEND_IF_VALUES_PER_MODE = 8;
const BLEND_IF_CURRENT_LAYER_SECTION = 1;
const WARP_PREVIEW_ICON_INSET = 0.3;

// --- Pure helpers (exported for tests) -----------------------------------------

function accumulateGroupBreakPositions(groupBreaks) {
  if (!groupBreaks) return [];
  const breakPositions = [groupBreaks[0]];
  for (let breakIdx = 1; breakIdx < groupBreaks.length; breakIdx++) {
    breakPositions.push(breakPositions[breakIdx - 1] + groupBreaks[breakIdx]);
  }
  return breakPositions;
}

function buildDropdownOptionIndexMap(itemCount, groupBreakPositions) {
  const optionIndexMap = [];
  let separatorCount = 0;
  for (let itemIdx = 0; itemIdx < itemCount; itemIdx++) {
    optionIndexMap.push(itemIdx + separatorCount);
    if (groupBreakPositions.indexOf(itemIdx + 1) != -1 && itemIdx != itemCount - 1) {
      separatorCount++;
    }
  }
  return optionIndexMap;
}

function resolveDropdownLogicalIndex(optionIndexMap, selectSelectedIndex) {
  return optionIndexMap.indexOf(selectSelectedIndex);
}

function buildImportExtensionFilter(presetExtension) {
  return presetExtension == "ICC" ? "icc .cube .look .3dl" : presetExtension;
}

/**
 * Count a clicked row as though "Define New" were always the first one, so the
 * row→action map has a single numbering to work from.
 */
function adjustPresetActionIndex(actionIndex, hasDefineNew) {
  if (!hasDefineNew) actionIndex++;
  return actionIndex;
}

function computeBlendIfSectionOffset(grayModeIndex, sectionIdx) {
  return grayModeIndex * BLEND_IF_VALUES_PER_MODE + (sectionIdx == BLEND_IF_CURRENT_LAYER_SECTION ? 0 : 4);
}

function normalizeSwatchPickColor(color) {
  if (color.h != null) return color;
  return { h: color.l, l: color.i, O: color.c, name: color.name };
}

function collectWarpStyleIds(showCustomWarpStyle) {
  const warpStyleIds = [];
  for (let warpStyleId in WARP_STYLE_LABELS) {
    if (warpStyleId == "warpCustom" && !showCustomWarpStyle) continue;
    warpStyleIds.push(warpStyleId);
  }
  return warpStyleIds;
}

function dispatchFloatingOverlay(widget, dispatchFn, anchorRect, measureForPosition, yOffset) {
  const overlayEvent = new AppEvent(EventType.uiDispatch, true);
  overlayEvent.data = {
    dispatchKind: UiCommand.showFloatingOverlay,
    overlayWidget: widget,
    x: anchorRect.left,
    y: anchorRect.top + anchorRect.height + (yOffset == null ? 0 : yOffset),
    measureForPosition: measureForPosition == null ? false : measureForPosition
  };
  dispatchFn(overlayEvent);
}

// --- PopupButton ---------------------------------------------------------------

/**
 * Labeled trigger button that drops down a preset picker (gradients, swatches,
 * brushes, styles, …). Shows a preview thumbnail plus a chevron; clicking opens
 * a floating overlay hosting a MenuList or PresetTreeList of `presets`, and an
 * overflow menu offers define-new / import / export / view-mode actions. The
 * `popupTypeId` (a PopupTypes value) selects which resource kind and picker
 * style to use. Subclasses override `onPick` / `openEditor` / `populatePopup`.
 */
function PopupButton(
  labelLocaleKey,
  opensEditorOnClick,
  itemClassName,
  popupWidthEm,
  popupHeightEm,
  popupTypeId,
  compactIconLayout
) {
  BaseWidget.call(this);
  mountPopupButtonDom(
    this,
    labelLocaleKey,
    opensEditorOnClick,
    itemClassName,
    popupWidthEm,
    popupHeightEm,
    popupTypeId,
    compactIconLayout
  );
}

PopupButton.prototype = Object.create(BaseWidget.prototype);
PopupButton.prototype.constructor = PopupButton;

PopupButton.prototype.listBundledPresetUrls = function() {
  return [];
};

PopupButton.prototype.onMenuPick = function(pickEvent) {
  this.onPick(pickEvent);
  this.menuList.highlightRowAtIndex(this.menuList.getValue());
};

PopupButton.prototype.openEditor = function() {};

PopupButton.prototype.buildUI = function() {
  this.presetActionsMenu.buildUI();
  this.menuList.buildUI();
  if (this.labelKey) this.labelEl.textContent = Locale.get(this.labelKey) + ":";
};

PopupButton.prototype.populatePopup = function() {
  if (!this.popupContentStale) return;
  if (this.usesTreeList) {
    this.menuList.setPresetTree(this.presets);
    this.popupContentStale = false;
  }
};

PopupButton.prototype.onDefineNewPreset = function() {
  if (this.menuList.defineNewPreset) this.menuList.defineNewPreset(this.getValue());
};

PopupButton.prototype.setLabel = function(labelText) {
  this.labelEl.textContent = labelText;
};

PopupButton.prototype.setPresets = function(presetList) {
  const popupTypeId = this.popupTypeId;
  let priorCount = 0;
  if (popupTypeId == PopupTypes.COLOR_PROFILES && Array.isArray(presetList)) {
    priorCount = this.presets ? this.presets.length : 0;
    presetList = presetList.slice(0);
  }
  this.presets = Array.isArray(presetList) ? presetList : [];
  this.popupContentStale = true;
  if (isInDOM(this.menuList.el)) this.populatePopup();
  if (
    popupTypeId == PopupTypes.COLOR_PROFILES &&
    this.presets.length - priorCount == 1 &&
    isInDOM(this.el)
  ) {
    this.setValue(this.presets[priorCount]);
    this.popupContentStale = true;
    this.populatePopup();
    this.menuList.highlightRowAtIndex(priorCount);
    this.dispatch(new AppEvent(EventType.widgetSelect));
  }
};

PopupButton.prototype.selectItem = function(selectEvent) {
  const actionIndex = adjustPresetActionIndex(
    selectEvent.target.getSelectedIndices()[0],
    this.defineNewPresetKind != null
  );
  const uiEvent = buildPresetActionUiDispatch(this, actionIndex);
  if (uiEvent) this.dispatch(uiEvent);
};

PopupButton.prototype.getEditorPresetPayload = function() {
  return [this.getValue()];
};

PopupButton.prototype.openOverflowMenu = function(clickEvent) {
  const actionsMenu = this.presetActionsMenu;
  actionsMenu.buildUI();
  actionsMenu.update(null);
  const buttonRect = clickEvent.currentTarget.getBoundingClientRect(),
    overlayEvent = new AppEvent(EventType.uiDispatch, true);
  overlayEvent.data = {
    dispatchKind: UiCommand.showFloatingOverlay,
    overlayWidget: actionsMenu,
    x: buttonRect.left,
    y: buttonRect.top + buttonRect.height
  };
  this.dispatch(overlayEvent);
};

PopupButton.prototype.togglePopup = function(clickEvent) {
  this.populatePopup();
  dispatchFloatingOverlay(
    this.floatWrap,
    this.dispatch.bind(this),
    this.triggerButton.getBoundingClientRect(),
    true
  );
};

function mountPopupButtonDom(
  popupButton,
  labelLocaleKey,
  opensEditorOnClick,
  itemClassName,
  popupWidthEm,
  popupHeightEm,
  popupTypeId,
  compactIconLayout
) {
  popupButton.el = makeElement("span", "fitem " + itemClassName);
  popupButton.floatWrap = new BaseWidget();
  popupButton.floatWrap.el = makeElement("div", "floatcont");
  popupButton.floatWrap.el.setAttribute("style", "width: " + (popupWidthEm + 1.5) + "em;");
  popupButton.floatWrap.parent = popupButton;
  popupButton.popupHeader = makeElement("div");
  popupButton.floatWrap.el.appendChild(popupButton.popupHeader);
  popupButton.popupToolbar = makeElement("div");
  popupButton.floatWrap.el.appendChild(popupButton.popupToolbar);
  if (labelLocaleKey) {
    popupButton.labelKey = labelLocaleKey;
    popupButton.labelEl = makeElement("label", "flabel");
    popupButton.el.appendChild(popupButton.labelEl);
  }
  popupButton.triggerButton = makeElement("button", compactIconLayout ? "nopadding" : "");
  popupButton.triggerButton.setAttribute("style", "position:relative;");
  popupButton.triggerButton.addEventListener(
    "click",
    (opensEditorOnClick ? popupButton.openEditor : popupButton.togglePopup).bind(popupButton),
    false
  );
  popupButton.el.appendChild(popupButton.triggerButton);
  popupButton.previewImageEl = makeElement("img", compactIconLayout ? "gsicon" : "");
  popupButton.triggerButton.appendChild(popupButton.previewImageEl);
  mountPopupButtonChevron(popupButton, opensEditorOnClick);
  mountPopupButtonMenuList(popupButton, popupWidthEm, popupHeightEm, popupTypeId, compactIconLayout);
  mountPopupButtonPresetActions(popupButton, popupTypeId);
  popupButton.popupTypeId = popupTypeId;
  popupButton.presets = null;
  popupButton.popupContentStale = true;
  popupButton.styleData = null;
}

function mountPopupButtonChevron(popupButton, opensEditorOnClick) {
  if (opensEditorOnClick) {
    const popupChevronBtn = makeElement("button", "chevron");
    popupChevronBtn.addEventListener("click", popupButton.togglePopup.bind(popupButton), false);
    popupButton.el.appendChild(popupChevronBtn);
  } else {
    // Positioned by class, not inline, so a caller can move it out of the
    // corner where the trigger is too small to carry it.
    const inlineChevron = makeElement("span", "chevron chevron-corner");
    popupButton.triggerButton.appendChild(inlineChevron);
  }
}

function mountPopupButtonMenuList(popupButton, popupWidthEm, popupHeightEm, popupTypeId, compactIconLayout) {
  const menuHost = makeElement("span");
  popupButton.popupToolbar.appendChild(menuHost);
  menuHost.setAttribute("style", "display:inline-block;  vertical-align:top; width:" + popupWidthEm + "em;");
  popupButton.usesTreeList = PopupTypes.usesTreePicker(popupTypeId);
  popupButton.menuList = popupButton.usesTreeList
    ? new PresetTreeList(compactIconLayout, popupTypeId)
    : new MenuList(compactIconLayout, popupTypeId);
  menuHost.appendChild(popupButton.menuList.el);
  popupButton.menuList.parent = popupButton.floatWrap;
  popupButton.menuList.on(EventType.widgetSelect, popupButton.onMenuPick, popupButton);
  if (popupButton.usesTreeList) {
    popupButton.menuList.on("define_new", popupButton.onDefineNewPreset, popupButton);
  }
  popupButton.menuList.el.style.height = popupHeightEm + "em";
  popupButton.overflowMenuButton = makeElement("button", "chevron");
  popupButton.overflowMenuButton.setAttribute("style", "padding:3px");
  popupButton.overflowMenuButton.addEventListener("click", popupButton.openOverflowMenu.bind(popupButton), false);
  popupButton.popupToolbar.appendChild(popupButton.overflowMenuButton);
}

function mountPopupButtonPresetActions(popupButton, popupTypeId) {
  const bundledPresetUrls = popupButton.listBundledPresetUrls(),
    defineNewKind =
      popupTypeId != PopupTypes.STYLES && popupTypeId != PopupTypes.SHAPES ? popupTypeId : null,
    presetExtension = popupTypeId == null ? "" : PopupTypes.getPresetResource(popupTypeId).extension.toUpperCase(),
    presetActionItems = buildPresetActionMenuItems(bundledPresetUrls, defineNewKind, presetExtension);
  popupButton.presetActionsMenu = new InputHandler(presetActionItems);
  popupButton.presetActionsMenu.parent = popupButton.floatWrap;
  popupButton.presetActionsMenu.on("select", popupButton.selectItem, popupButton);
  popupButton.defineNewPresetKind = defineNewKind;
}

function buildPresetActionMenuItems(bundledPresetUrls, defineNewKind, presetExtension) {
  let presetActionItems = defineNewKind ? [{ name: "properties.defineNew" }] : [];
  presetActionItems = presetActionItems.concat([
    { name: ["VAR0 / VAR1", "templates.thumbnails", "templates.list"] },
    {
      name: ["history.loadVar", "." + buildImportExtensionFilter(presetExtension)]
    },
    {
      name: ["VAR0 ." + presetExtension, "file.exportAs"],
      separatorAfter: bundledPresetUrls.length != 0
    }
  ]);
  for (let presetIdx = 0; presetIdx < bundledPresetUrls.length; presetIdx++) {
    presetActionItems.push({ name: bundledPresetUrls[presetIdx].split("/").pop() });
  }
  return presetActionItems;
}

/**
 * Fixed rows every preset menu offers, after the optional "Define New" row:
 * thumbnails/list, load from disk, export. Bundled libraries follow them.
 */
const PRESET_ACTION_ROWS_AFTER_DEFINE_NEW = 3;

/**
 * Map a menu row to its action.
 *
 * `actionIndex` is always counted as though "Define New" were there: pickers
 * that cannot define a preset from the current state — shapes and layer styles
 * — omit that row, and {@link adjustPresetActionIndex} has already added the
 * one place back. So the fixed rows below sit at 1, 2 and 3 for every picker.
 *
 * @param {*} popupButton
 * @param {number} actionIndex row index, counted with "Define New" at 0
 * @returns {AppEvent|null}
 */
function buildPresetActionUiDispatch(popupButton, actionIndex) {
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  const offersDefineNew = popupButton.defineNewPresetKind != null;
  if (offersDefineNew && actionIndex == 0) {
    const editorPayload = popupButton.getEditorPresetPayload();
    if (popupButton.popupTypeId == PopupTypes.COLOR_PROFILES && editorPayload[0].profile == null) {
      return null;
    }
    uiEvent.data = {
      dispatchKind: UiCommand.openResourcePresetPopup,
      scriptHostData: "add",
      popupType: popupButton.defineNewPresetKind,
      presetPayload: editorPayload
    };
    return uiEvent;
  }
  const rowIndex = actionIndex - 1;
  if (rowIndex == 0) {
    popupButton.menuList.setViewMode(1 - popupButton.menuList.getViewMode());
    return null;
  }
  if (rowIndex == 1) {
    uiEvent.data = { dispatchKind: UiCommand.pickLocalFiles };
    return uiEvent;
  }
  if (rowIndex == 2) {
    uiEvent.data = {
      dispatchKind: UiCommand.exportPopupResourceBundle,
      popupTypeId: popupButton.popupTypeId
    };
    return uiEvent;
  }
  const bundledPresetUrls = popupButton.listBundledPresetUrls();
  const bundledUrl = bundledPresetUrls[rowIndex - PRESET_ACTION_ROWS_AFTER_DEFINE_NEW];
  if (bundledUrl == null) return null;
  uiEvent.data = {
    dispatchKind: UiCommand.importFromUrl,
    importSpec: {
      // Underscore-safe bundled paths; avoid percent-encoding — Tauri's asset
      // protocol does not resolve %20 back to spaces in filenames.
      url: "resources/" + bundledUrl
    }
  };
  return uiEvent;
}

// --- ModeDropdown --------------------------------------------------------------

/**
 * Blend-If control for the layer-style dialog. A channel dropdown (gray or one
 * RGB channel) plus two histogram range sliders — one for "this layer", one for
 * the underlying layers. Its value is the flat array of blend-if band edges:
 * BLEND_IF_VALUES_PER_MODE (8) entries per channel, four per section.
 */
function ModeDropdown() {
  BaseWidget.call(this);
  this.el = makeElement("div");
  this.blendIfValues = false;
  this.sectionWidgets = [
    new Dropdown("properties.blendIf", ["colour.labels.grey"].concat(AdjustmentEngine.rgbColorLabels)),
    new HistogramCanvas("sampleScope.currentLayer"),
    new HistogramCanvas("properties.background")
  ];
  for (let widgetIdx = 0; widgetIdx < 3; widgetIdx++) {
    const sectionWidget = this.sectionWidgets[widgetIdx];
    this.el.appendChild(sectionWidget.el);
    sectionWidget.on(EventType.widgetSelect, this.onChange, this);
  }
  this.buildUI();
}

ModeDropdown.prototype = Object.create(BaseWidget.prototype);
ModeDropdown.prototype.constructor = ModeDropdown;

ModeDropdown.prototype.buildUI = function() {
  for (let widgetIdx = 0; widgetIdx < 3; widgetIdx++) this.sectionWidgets[widgetIdx].buildUI();
};

ModeDropdown.prototype.getValue = function() {
  return this.blendIfValues.slice(0);
};

ModeDropdown.prototype.setValue = function(blendIfValues) {
  this.blendIfValues = blendIfValues.slice(0);
  const sectionWidgets = this.sectionWidgets,
    grayModeIndex = sectionWidgets[0].getValue();
  sectionWidgets[1].setValue(blendIfValues.slice(grayModeIndex * 8, grayModeIndex * 8 + 4), grayModeIndex);
  sectionWidgets[2].setValue(blendIfValues.slice(grayModeIndex * 8 + 4, grayModeIndex * 8 + 8), grayModeIndex);
};

ModeDropdown.prototype.onChange = function(changeEvent) {
  const sectionWidgets = this.sectionWidgets,
    sectionIdx = sectionWidgets.indexOf(changeEvent.currentTarget);
  if (sectionIdx == 0) {
    this.setValue(this.blendIfValues);
    return;
  }
  const valueOffset = computeBlendIfSectionOffset(sectionWidgets[0].getValue(), sectionIdx),
    sectionValues = sectionWidgets[sectionIdx].getValue();
  for (let channelIdx = 0; channelIdx < 4; channelIdx++) {
    this.blendIfValues[valueOffset + channelIdx] = sectionValues[channelIdx];
  }
  this.dispatch(new AppEvent(EventType.widgetSelect, false));
};

// --- ButtonMenu / IconRenderer -------------------------------------------------

/**
 * Horizontal row of buttons acting as a single-choice selector; the active
 * button is highlighted and `getValue()` returns its index. IconRenderer is the
 * same control with each item rendered as an icon image (swatch, checker, or a
 * source URL) rasterized to a data URL at a fixed pixel size.
 */
function ButtonMenu(labelLocaleKey, itemLabels, itemTitles) {
  BaseWidget.call(this);
  if (!itemLabels) return;
  this.selectedIndex = 0;
  this.el = makeElement("span", "fitem bbmenu");
  if (labelLocaleKey) {
    this.labelKey = labelLocaleKey;
    this.labelEl = makeElement("label", "flabel");
    this.labelEl.textContent = labelLocaleKey + ":";
    this.el.appendChild(this.labelEl);
  }
  this.buttons = [];
  this.itemLabels = null;
  this.setItems(itemLabels, itemTitles);
  this.setValue(0);
}

ButtonMenu.prototype = Object.create(BaseWidget.prototype);
ButtonMenu.prototype.constructor = ButtonMenu;

ButtonMenu.prototype.setLabel = function(labelLocaleKey) {
  this.labelKey = labelLocaleKey;
  this.buildUI();
};

ButtonMenu.prototype.buildUI = function() {
  if (this.labelKey != null) this.labelEl.textContent = Locale.get(this.labelKey) + ": ";
  for (let buttonIdx = 0; buttonIdx < this.buttons.length; buttonIdx++) this.buttons[buttonIdx].buildUI();
};

ButtonMenu.prototype.getValue = function() {
  return this.selectedIndex;
};

ButtonMenu.prototype.setItems = function(itemLabels, itemTitles) {
  while (this.buttons.length > 0) this.el.removeChild(this.buttons.pop().el);
  this.itemLabels = itemLabels;
  for (let itemIdx = 0; itemIdx < itemLabels.length; itemIdx++) {
    const itemButton = new Button(itemLabels[itemIdx], false, itemTitles ? itemTitles[itemIdx] : null);
    itemButton.on("click", this.onInput, this);
    this.el.appendChild(itemButton.el);
    this.buttons.push(itemButton);
  }
  this.buildUI();
};

ButtonMenu.prototype.setValue = function(selectedIndex) {
  this.selectedIndex = selectedIndex;
  for (let buttonIdx = 0; buttonIdx < this.buttons.length; buttonIdx++) this.buttons[buttonIdx].clearActive();
  this.buttons[selectedIndex].markActive();
};

ButtonMenu.prototype.onInput = function(clickEvent) {
  const buttonIdx = this.buttons.indexOf(clickEvent.target);
  this.setValue(buttonIdx);
  this.dispatch(new AppEvent(EventType.widgetSelect, false));
};

function IconRenderer(labelLocaleKey, iconSources, itemTitles, iconSizePx) {
  if (iconSizePx == null) iconSizePx = 16;
  ButtonMenu.call(this, labelLocaleKey, buildIconMenuItemLabels(iconSources, iconSizePx), itemTitles);
}

IconRenderer.prototype = Object.create(ButtonMenu.prototype);
IconRenderer.prototype.constructor = IconRenderer;
IconRenderer.scratchCanvas = makeElement("canvas");

function buildIconMenuItemLabels(iconSources, iconSizePx) {
  const scratchCanvas = IconRenderer.scratchCanvas,
    menuItems = [];
  for (let sourceIdx = 0; sourceIdx < iconSources.length; sourceIdx++) {
    menuItems.push(buildIconMenuItemMarkup(iconSources[sourceIdx], scratchCanvas, iconSizePx));
  }
  return menuItems;
}

function buildIconMenuItemMarkup(iconSource, scratchCanvas, iconSizePx) {
  const scratchCtx = scratchCanvas.getContext("2d"),
    halfSize = iconSizePx >>> 1;
  scratchCanvas.width = scratchCanvas.height = iconSizePx;
  if (iconSource == "checker") {
    scratchCtx.fillStyle = "white";
    scratchCtx.fillRect(0, 0, iconSizePx, iconSizePx);
    scratchCtx.fillStyle = "#bbbbbb";
    scratchCtx.fillRect(halfSize, 0, halfSize, halfSize);
    scratchCtx.fillRect(0, halfSize, halfSize, halfSize);
  } else if (iconSource.startsWith("#")) {
    scratchCtx.fillStyle = iconSource;
    scratchCtx.fillRect(0, 0, iconSizePx, iconSizePx);
  }
  if (iconSource == "checker" || iconSource.startsWith("#")) {
    return "<img src=\"" + scratchCanvas.toDataURL() + "\" />";
  }
  return "<img src=\"" + iconSource + "\" class=\"autoscale gsicon\" />";
}

// --- Dropdown ------------------------------------------------------------------

/**
 * Native `<select>` dropdown with a localized label. `groupBreaks` inserts
 * disabled separator options between item groups; `optionIndexMap` maps each
 * logical item index to its `<select>` option index (accounting for those
 * separators) so `getValue()` / `setValue()` speak in item indices.
 */
function Dropdown(labelLocaleKey, itemLabels, labelInTitle, groupBreaks) {
  BaseWidget.call(this);
  if (!itemLabels) return;
  if (labelInTitle == null) labelInTitle = false;
  this.selectedIndex = 0;
  this.labelInTitle = labelInTitle;
  this.labelKey = labelLocaleKey;
  this.optionIndexMap = null;
  this.groupBreaks = groupBreaks;
  const selectId = "dd" + allocateNextUniqueId();
  this.el = makeElement("span", "fitem ddmenu");
  if (labelLocaleKey && !labelInTitle) {
    this.labelEl = makeElement("label", "flabel");
    this.el.appendChild(this.labelEl);
    this.labelEl.setAttribute("for", selectId);
  }
  this.selectEl = makeElement("select", "bbtn");
  this.selectEl.setAttribute("id", selectId);
  this.el.appendChild(this.selectEl);
  this.selectEl.addEventListener("change", this.onInput.bind(this), false);
  this.optionElements = [];
  this.itemLabels = null;
  this.setItems(itemLabels, groupBreaks);
  this.buildUI();
}

Dropdown.prototype = Object.create(BaseWidget.prototype);
Dropdown.prototype.constructor = Dropdown;

Dropdown.prototype.setLabel = function(labelLocaleKey) {
  this.labelKey = labelLocaleKey;
  this.buildUI();
};

Dropdown.prototype.buildUI = function() {
  if (this.labelKey != null) {
    const labelText = Locale.get(this.labelKey);
    if (this.labelInTitle) this.selectEl.setAttribute("title", labelText);
    else this.labelEl.textContent = labelText + ":";
  }
  if (this.itemLabels) this.setItems(this.itemLabels, this.groupBreaks);
  this.setValue(this.selectedIndex);
};

Dropdown.prototype.getValue = function() {
  return this.selectedIndex;
};

Dropdown.prototype.setItems = function(itemLabels, groupBreaks) {
  clearElement(this.selectEl);
  const groupBreakPositions = accumulateGroupBreakPositions(groupBreaks);
  this.itemLabels = itemLabels;
  this.groupBreaks = groupBreaks;
  this.optionElements = [];
  this.optionIndexMap = buildDropdownOptionIndexMap(itemLabels.length, groupBreakPositions);
  for (let itemIdx = 0; itemIdx < itemLabels.length; itemIdx++) {
    const optionEl = makeElement("option");
    optionEl.textContent = Locale.get(itemLabels[itemIdx]);
    optionEl.setAttribute("value", itemIdx);
    this.selectEl.appendChild(optionEl);
    this.optionElements.push(optionEl);
    if (groupBreakPositions.indexOf(itemIdx + 1) != -1 && itemIdx != itemLabels.length - 1) {
      const separatorOption = makeElement("option");
      separatorOption.setAttribute("disabled", "");
      separatorOption.textContent = "";
      this.selectEl.appendChild(separatorOption);
    }
  }
};

Dropdown.prototype.setValue = function(selectedIndex) {
  this.selectedIndex = selectedIndex;
  this.selectEl.selectedIndex = this.optionIndexMap[selectedIndex];
};

Dropdown.prototype.onInput = function(inputEvent) {
  this.selectedIndex = resolveDropdownLogicalIndex(this.optionIndexMap, this.selectEl.selectedIndex);
  this.dispatch(new AppEvent(EventType.widgetSelect, false));
};

// --- GradientPickerButton ------------------------------------------------------

/**
 * PopupButton specialized for gradients. The popup shows a thumbnail grid of
 * gradient presets, the trigger shows a wide preview strip, and clicking opens
 * the gradient editor dialog. Previews are rendered via
 * GradientTool against the current foreground/background colors
 * (colorInt / bgColor); `previewCacheKey` skips re-rendering unchanged state.
 * `getValue()` returns the gradient with preset colors resolved when
 * `resolvePresetColors` is set, otherwise a deep copy of the raw style data.
 */
function GradientPickerButton(resolvePresetColors, labelLocaleKey, showNewProjectDialog) {
  PopupButton.call(this, labelLocaleKey, true, "gradientbutton", 18, 10, PopupTypes.GRADIENTS);
  this.colorInt = -1;
  this.bgColor = -1;
  this.previewCacheKey = null;
  this.resolvePresetColors = resolvePresetColors;
  this.showNewProjectDialog = showNewProjectDialog;
}

GradientPickerButton.prototype = Object.create(PopupButton.prototype);
GradientPickerButton.prototype.constructor = GradientPickerButton;

GradientPickerButton.prototype.listBundledPresetUrls = function() {
  return ["basic/extra_gradients.grd"];
};

GradientPickerButton.prototype.onPick = function(pickEvent) {
  const presets = this.presets;
  this.setValue(presets[this.menuList.getValue()]);
  this.dispatch(new AppEvent(EventType.widgetSelect));
};

GradientPickerButton.prototype.openEditor = function(clickEvent) {
  const editorEvent = new AppEvent(EventType.uiDispatch, true);
  editorEvent.data = {
    dispatchKind: UiCommand.dispatchAppDialogRouter,
    dialogRouteId: "gradienteditor",
    gradientStyleData: this.styleData,
    onDialogResult: this.onEditorApply.bind(this),
    allowContinuousMirrorUpdates: this.showNewProjectDialog
  };
  this.dispatch(editorEvent);
};

GradientPickerButton.prototype.onEditorApply = function(gradientData) {
  this.setValue(gradientData);
  this.dispatch(new AppEvent(EventType.widgetSelect));
};

GradientPickerButton.prototype.populatePopup = function() {
  if (!this.popupContentStale) return;
  const thumbWidth = Math.floor(36 * getDevicePixelRatio()),
    thumbHeight = Math.floor(36 * getDevicePixelRatio()),
    previewUrls = [],
    presetLabels = [],
    presets = this.presets;
  for (let presetIdx = 0; presetIdx < presets.length; presetIdx++) {
    const preset = presets[presetIdx];
    presetLabels.push(preset.Nm ? preset.Nm.v.split("=").pop() : "");
    previewUrls.push(
      GradientTool.renderGradientPreviewDataUrl(
        preset,
        thumbWidth,
        thumbHeight,
        Math.PI / 4,
        this.colorInt,
        this.bgColor
      )
    );
  }
  this.menuList.setThumbnailGrid(previewUrls, presetLabels, thumbWidth, thumbHeight);
  this.popupContentStale = false;
};

GradientPickerButton.prototype.setContextColors = function(colorInt, bgColor) {
  this.updatePreview(this.styleData, colorInt, bgColor);
};

GradientPickerButton.prototype.setValue = function(gradientData) {
  this.updatePreview(gradientData, this.colorInt, this.bgColor);
};

GradientPickerButton.prototype.updatePreview = function(gradientData, colorInt, bgColor) {
  this.colorInt = colorInt;
  this.bgColor = bgColor;
  if (gradientData == null) return;
  const gradientJson = JSON.stringify(gradientData),
    cacheKey = gradientJson + colorInt + "," + bgColor;
  if (cacheKey == this.previewCacheKey) return;
  this.previewCacheKey = cacheKey;
  this.styleData = JSON.parse(gradientJson);
  const previewWidth = Math.floor(80 * getDevicePixelRatio()),
    previewHeight = Math.floor(16 * getDevicePixelRatio()),
    previewUrl = GradientTool.renderGradientPreviewDataUrl(
      this.styleData,
      previewWidth,
      previewHeight,
      0,
      this.colorInt,
      this.bgColor
    );
  this.previewImageEl.setAttribute("src", previewUrl);
  setElementCssSizeForDeviceRatio(this.previewImageEl, previewWidth, previewHeight);
};

GradientPickerButton.prototype.getValue = function() {
  if (this.resolvePresetColors) {
    return GradientTool.resolveGradientPresetColors(this.styleData, this.colorInt, this.bgColor);
  }
  return JSON.parse(JSON.stringify(this.styleData));
};

// --- SwatchButton --------------------------------------------------------------

/**
 * PopupButton specialized for color swatches. The popup lists swatch presets
 * (including a bundled Pantone set); picking one stores the color and paints a
 * small solid preview. Preview data URLs are cached per hex color in
 * `previewDataUrlCache`.
 */
function SwatchButton(labelLocaleKey) {
  PopupButton.call(this, labelLocaleKey, false, "swatchbutton", 16, 8.75, PopupTypes.SWATCHES);
}

SwatchButton.prototype = Object.create(PopupButton.prototype);
SwatchButton.prototype.constructor = SwatchButton;

SwatchButton.prototype.listBundledPresetUrls = function() {
  return ["swatches/pantone.aco"];
};

SwatchButton.prototype.setPresets = function(presetList) {
  PopupButton.prototype.setPresets.call(this, presetList);
  if (this.usesTreeList) {
    this.menuList.setPresetTree(this.presets);
    this.popupContentStale = false;
  }
};

SwatchButton.prototype.togglePopup = function(evt) {
  this.populatePopup();
  PopupButton.prototype.togglePopup.call(this, evt);
};

SwatchButton.prototype.onPick = function() {
  const color = this.menuList.getSelectedPreset();
  if (color == null) return;
  this.setValue(normalizeSwatchPickColor(color));
  this.dispatch(new AppEvent(EventType.widgetSelect));
};

SwatchButton.prototype.setValue = function(color) {
  this.styleData = JSON.parse(JSON.stringify(color));
  this.renderPreview();
};

SwatchButton.prototype.renderPreview = function() {
  const previewWidth = Math.floor(24 * getDevicePixelRatio()),
    previewHeight = Math.floor(20 * getDevicePixelRatio()),
    previewUrl = SwatchButton.renderSwatchPreviewDataUrl(this.styleData, previewWidth, previewHeight);
  this.previewImageEl.setAttribute("src", previewUrl);
  setElementCssSizeForDeviceRatio(this.previewImageEl, previewWidth, previewHeight);
};

SwatchButton.prototype.getValue = function() {
  return JSON.parse(JSON.stringify(this.styleData));
};

SwatchButton.previewDataUrlCache = {};

SwatchButton.renderSwatchPreviewDataUrl = function(color, width, height) {
  let renderCtx = SwatchButton.previewRenderCtx,
    cache = SwatchButton.previewDataUrlCache,
    hexKey = rgbToHex(color.h << 16 | color.l << 8 | color.O);
  if (cache[hexKey]) return cache[hexKey];
  if (renderCtx == null) {
    const canvas = makeElement("canvas");
    renderCtx = SwatchButton.previewRenderCtx = canvas.getContext("2d");
  }
  const canvas = renderCtx.canvas;
  canvas.width = width;
  canvas.height = height;
  renderCtx.fillStyle = "#" + hexKey;
  renderCtx.fillRect(0, 0, width, height);
  return (cache[hexKey] = canvas.toDataURL());
};

// --- RadioOption ---------------------------------------------------------------

/**
 * Group of independent on/off options rendered either as checkboxes or as
 * toggle buttons (`useButtons`). `getValue()` / `setValue()` use a boolean array
 * parallel to `optionLabels` — each entry is toggled independently, so this is a
 * multi-toggle group rather than a single-choice radio.
 */
function RadioOption(labelLocaleKey, optionLabels, useButtons, optionTitles) {
  BaseWidget.call(this);
  this.el = makeElement("span", "fitem mbox");
  this.useButtons = useButtons;
  if (labelLocaleKey) {
    this.labelKey = labelLocaleKey;
    this.labelEl = makeElement("label", "flabel");
    this.el.appendChild(this.labelEl);
  }
  this.optionLabels = optionLabels;
  this.optionWidgets = [];
  for (let optionIdx = 0; optionIdx < optionLabels.length; optionIdx++) {
    const optionWidget = useButtons
      ? new Button(optionLabels[optionIdx], false, optionTitles ? optionTitles[optionIdx] : null)
      : new Checkbox(optionLabels[optionIdx], true, "");
    optionWidget.on(useButtons ? "click" : EventType.widgetSelect, this.onInput, this);
    this.optionWidgets.push(optionWidget);
    this.el.appendChild(optionWidget.el);
  }
  this.buildUI();
}

RadioOption.prototype = Object.create(BaseWidget.prototype);
RadioOption.prototype.constructor = RadioOption;

RadioOption.prototype.setValue = function(values) {
  for (let optionIdx = 0; optionIdx < this.optionLabels.length; optionIdx++) {
    this.optionWidgets[optionIdx].setValue(values[optionIdx]);
  }
};

RadioOption.prototype.getValue = function() {
  const values = [];
  for (let optionIdx = 0; optionIdx < this.optionLabels.length; optionIdx++) {
    values[optionIdx] = this.optionWidgets[optionIdx].getValue();
  }
  return values;
};

RadioOption.prototype.buildUI = function() {
  if (this.labelKey) this.labelEl.innerHTML = Locale.get(this.labelKey) + ": ";
  for (let optionIdx = 0; optionIdx < this.optionWidgets.length; optionIdx++) this.optionWidgets[optionIdx].buildUI();
};

RadioOption.prototype.onInput = function(inputEvent) {
  const optionIdx = this.optionWidgets.indexOf(inputEvent.currentTarget);
  if (this.useButtons) this.optionWidgets[optionIdx].setValue(!this.optionWidgets[optionIdx].getValue());
  this.dispatch(new AppEvent(EventType.widgetSelect, false));
};

// --- RadioGroup ----------------------------------------------------------------

/**
 * Single-choice group of native radio inputs sharing one `name`, so the browser
 * enforces that exactly one option is selected. `getValue()` returns the
 * selected index; `setValue(index)` selects one. Use {@link RadioOption} when
 * the options toggle independently instead.
 */
function RadioGroup(labelLocaleKey, optionLabels) {
  BaseWidget.call(this);
  this.el = makeElement("span", "fitem mbox");
  this.optionLabels = optionLabels;
  if (labelLocaleKey) {
    this.labelKey = labelLocaleKey;
    this.labelEl = makeElement("label", "flabel");
    this.el.appendChild(this.labelEl);
  }
  /** Shared `name` for this group's inputs; the browser keys exclusivity off it. */
  this.groupName = "rg" + allocateNextUniqueId();
  this.inputElements = [];
  this.labelElements = [];
  for (let optionIdx = 0; optionIdx < optionLabels.length; optionIdx++) {
    const inputId = this.groupName + "_" + optionIdx;
    const inputEl = makeElement("input", "");
    inputEl.setAttribute("type", "radio");
    inputEl.setAttribute("name", this.groupName);
    inputEl.setAttribute("id", inputId);
    inputEl.checked = optionIdx === 0;
    inputEl.addEventListener("change", this.onInput.bind(this), false);
    const optionLabelEl = makeElement("label", "");
    optionLabelEl.setAttribute("for", inputId);
    this.el.appendChild(inputEl);
    this.el.appendChild(optionLabelEl);
    this.inputElements.push(inputEl);
    this.labelElements.push(optionLabelEl);
  }
  this.buildUI();
}

RadioGroup.prototype = Object.create(BaseWidget.prototype);
RadioGroup.prototype.constructor = RadioGroup;

RadioGroup.prototype.setValue = function(selectedIndex) {
  for (let optionIdx = 0; optionIdx < this.inputElements.length; optionIdx++) {
    this.inputElements[optionIdx].checked = optionIdx === selectedIndex;
  }
};

RadioGroup.prototype.getValue = function() {
  for (let optionIdx = 0; optionIdx < this.inputElements.length; optionIdx++) {
    if (this.inputElements[optionIdx].checked) return optionIdx;
  }
  return -1;
};

RadioGroup.prototype.buildUI = function() {
  if (this.labelKey) this.labelEl.textContent = Locale.get(this.labelKey) + ": ";
  for (let optionIdx = 0; optionIdx < this.labelElements.length; optionIdx++) {
    this.labelElements[optionIdx].textContent = Locale.get(this.optionLabels[optionIdx]);
  }
};

RadioGroup.prototype.onInput = function() {
  this.dispatch(new AppEvent(EventType.widgetSelect, false));
};

// --- AntialiasingOption --------------------------------------------------------

/**
 * Magic-wand / selection option bar: a tolerance slider (0–255) plus anti-alias
 * and contiguous checkboxes. `getValue()` returns the three values as a tuple
 * `[tolerance, antiAlias, contiguous]`.
 */
function AntialiasingOption() {
  BaseWidget.call(this);
  this.activePath = [16, true, true];
  this.el = makeElement("span", "");
  this.childWidgets = [
    new SliderDropdown("properties.tolerance", 0, 255),
    new Checkbox("Anti-alias"),
    new Checkbox("properties.contiguous")
  ];
  for (let widgetIdx = 0; widgetIdx < 3; widgetIdx++) {
    const childWidget = this.childWidgets[widgetIdx];
    childWidget.parent = this;
    childWidget.setValue(this.activePath[widgetIdx]);
    this.el.appendChild(childWidget.el);
    childWidget.on(EventType.widgetSelect, this.onChange, this);
  }
}

AntialiasingOption.prototype = Object.create(BaseWidget.prototype);
AntialiasingOption.prototype.constructor = AntialiasingOption;

AntialiasingOption.prototype.onChange = function() {
  for (let widgetIdx = 0; widgetIdx < 3; widgetIdx++) {
    this.activePath[widgetIdx] = this.childWidgets[widgetIdx].getValue();
  }
  this.dispatch(new AppEvent(EventType.widgetSelect, false));
};

AntialiasingOption.prototype.setValue = function(values) {
  this.activePath = values.slice(0);
  for (let widgetIdx = 0; widgetIdx < 3; widgetIdx++) this.childWidgets[widgetIdx].setValue(values[widgetIdx]);
};

AntialiasingOption.prototype.getValue = function() {
  return this.activePath.slice(0);
};

AntialiasingOption.prototype.buildUI = function() {
  for (let widgetIdx = 0; widgetIdx < 3; widgetIdx++) this.childWidgets[widgetIdx].buildUI();
};

// --- DocumentSelector ----------------------------------------------------------

/**
 * Path/shape combine-mode selector: four icon buttons — replace, unite,
 * subtract, intersect. `getValue()` returns the active mode id ("front",
 * "union", "difference", "intersection").
 */
function DocumentSelector(showLabel) {
  BaseWidget.call(this);
  this.el = makeElement("span", "fitem");
  this.labelWidget = null;
  if (showLabel) {
    this.labelWidget = new Label("");
    this.el.appendChild(this.labelWidget.el);
  }
  this.combineModeIds = ["front", "union", "difference", "intersection"];
  const modeTitleKeys = ["pathOps.replace", "pathOps.unite", "pathOps.subtract", "pathOps.intersect"];
  this.modeButtons = [];
  this.selectedIndex = 0;
  for (let modeIdx = 0; modeIdx < this.combineModeIds.length; modeIdx++) {
    const modeButton = new Button(
      "<img src=\"" + getIconUrl("set/" + this.combineModeIds[modeIdx]) + "\" class=\"autoscale gsicon\" />",
      false,
      modeTitleKeys[modeIdx]
    );
    modeButton.on("click", this.onModeButtonClick, this);
    this.el.appendChild(modeButton.el);
    this.modeButtons.push(modeButton);
  }
  this.modeButtons[0].markActive();
}

DocumentSelector.prototype = Object.create(BaseWidget.prototype);
DocumentSelector.prototype.constructor = DocumentSelector;

DocumentSelector.prototype.getSelectedIndex = function() {
  return this.selectedIndex;
};

DocumentSelector.prototype.getValue = function() {
  return this.combineModeIds[this.selectedIndex];
};

DocumentSelector.prototype.setValue = function(modeId) {
  this.selectedIndex = this.combineModeIds.indexOf(modeId);
  for (let buttonIdx = 0; buttonIdx < this.modeButtons.length; buttonIdx++) this.modeButtons[buttonIdx].clearActive();
  this.modeButtons[this.selectedIndex].markActive();
};

DocumentSelector.prototype.onModeButtonClick = function(clickEvent) {
  this.setValue(this.combineModeIds[this.modeButtons.indexOf(clickEvent.currentTarget)]);
  this.dispatch(new AppEvent(EventType.widgetSelect, false));
};

DocumentSelector.prototype.buildUI = function() {
  if (this.labelWidget) this.labelWidget.setValue(Locale.get("properties.mode") + ":");
  for (let buttonIdx = 0; buttonIdx < this.modeButtons.length; buttonIdx++) this.modeButtons[buttonIdx].buildUI();
};

// --- CheckboxList --------------------------------------------------------------

/**
 * Warp-style picker for the transform/warp tool. Opens a thumbnail grid where
 * each cell shows a warp style deforming a small grid icon, drawn by pushing the
 * icon outline through the style's warp mesh. The
 * trigger button shows the selected style's thumbnail; `getValue()` returns the
 * warp style id. Pass `showCustomWarpStyle` to include the "warpCustom" entry.
 */
function CheckboxList(labelLocaleKey, showCustomWarpStyle) {
  BaseWidget.call(this);
  if (showCustomWarpStyle == null) showCustomWarpStyle = false;
  this.previewDataUrls = [];
  this.previewWidthPx = 0;
  this.previewHeightPx = 0;
  this.selectedIndex = 0;
  this.warpStyleIds = collectWarpStyleIds(showCustomWarpStyle);
  this.warpStyleValues = this.warpStyleIds.map(function(warpStyleId) {
    return WARP_STYLE_LABELS[warpStyleId];
  });
  mountCheckboxListDom(this, labelLocaleKey);
  this.buildUI();
}

CheckboxList.prototype = Object.create(BaseWidget.prototype);
CheckboxList.prototype.constructor = CheckboxList;

CheckboxList.prototype.setLabel = function(labelText) {
  this.labelEl.textContent = labelText;
};

CheckboxList.prototype.buildUI = function() {
  if (this.labelLocaleKey) this.labelEl.innerHTML = Locale.get(this.labelLocaleKey) + ":";
  const previewMetrics = buildWarpStylePreviewThumbnails(this.warpStyleIds);
  this.previewDataUrls = previewMetrics.previewDataUrls;
  this.previewWidthPx = previewMetrics.previewWidthPx;
  this.previewHeightPx = previewMetrics.previewHeightPx;
  this.floatWrap.el.setAttribute(
    "style",
    "width:" + Math.floor(8 + previewMetrics.previewWidthPx / getDevicePixelRatio()) + "px;"
  );
  this.menuList.setThumbnailGrid(
    this.previewDataUrls,
    null,
    previewMetrics.previewWidthPx,
    previewMetrics.previewHeightPx
  );
  this.renderPreview();
};

CheckboxList.prototype.togglePopup = function(clickEvent) {
  dispatchFloatingOverlay(this.floatWrap, this.dispatch.bind(this), this.triggerButton.getBoundingClientRect(), false, 4);
};

CheckboxList.prototype.onMenuSelect = function(selectEvent) {
  const closeEvent = new AppEvent(EventType.uiDispatch, true);
  closeEvent.data = {
    dispatchKind: UiCommand.closeFloatingOverlay,
    overlayWidget: this.floatWrap
  };
  this.dispatch(closeEvent);
  this.selectedIndex = selectEvent.target.getValue();
  this.renderPreview();
  this.dispatch(new AppEvent(EventType.widgetSelect));
};

CheckboxList.prototype.renderPreview = function() {
  this.menuList.highlightRowAtIndex(this.selectedIndex);
  this.triggerButton.innerHTML =
    "<img src=\"" + this.previewDataUrls[this.selectedIndex] + "\" class=\"gsicon\" />";
  setElementCssSizeForDeviceRatio(this.triggerButton.firstChild, this.previewWidthPx, this.previewHeightPx);
};

CheckboxList.prototype.getValue = function() {
  return this.warpStyleIds[this.selectedIndex];
};

CheckboxList.prototype.setValue = function(warpStyleId) {
  this.selectedIndex = this.warpStyleIds.indexOf(warpStyleId);
  this.renderPreview();
};

function mountCheckboxListDom(checkboxList, labelLocaleKey) {
  checkboxList.el = makeElement("span", "fitem warpbutton");
  checkboxList.floatWrap = new BaseWidget();
  checkboxList.floatWrap.el = makeElement("div", "floatcont");
  if (labelLocaleKey) {
    checkboxList.labelLocaleKey = labelLocaleKey;
    checkboxList.labelEl = makeElement("label", "flabel");
    checkboxList.el.appendChild(checkboxList.labelEl);
  }
  checkboxList.triggerButton = makeElement("button");
  checkboxList.el.appendChild(checkboxList.triggerButton);
  checkboxList.triggerButton.addEventListener("click", checkboxList.togglePopup.bind(checkboxList), false);
  checkboxList.menuList = new MenuList(true);
  checkboxList.floatWrap.el.appendChild(checkboxList.menuList.el);
  checkboxList.menuList.on(EventType.widgetSelect, checkboxList.onMenuSelect, checkboxList);
}

function buildWarpStylePreviewThumbnails(warpStyleIds) {
  const previewCanvas = makeElement("canvas", ""),
    previewCtx = previewCanvas.getContext("2d");
  let maxLabelWidth = 0;
  previewCtx.font = Math.floor(13 * getDevicePixelRatio()) + "px sans-serif";
  for (let styleIdx = 0; styleIdx < warpStyleIds.length; styleIdx++) {
    maxLabelWidth = Math.max(
      maxLabelWidth,
      previewCtx.measureText(Locale.get(WARP_STYLE_LABELS[warpStyleIds[styleIdx]])).width
    );
  }
  const previewWidthPx = Math.floor(50 * getDevicePixelRatio() + maxLabelWidth),
    previewHeightPx = Math.floor(23 * getDevicePixelRatio()),
    previewDataUrls = [];
  previewCanvas.width = previewWidthPx;
  previewCanvas.height = previewHeightPx;
  previewCtx.font = Math.floor(13 * getDevicePixelRatio()) + "px sans-serif";
  previewCtx.lineWidth = 1;
  previewCtx.strokeStyle = "#000000";
  const iconSizePx = Math.floor(16 * getDevicePixelRatio()),
    iconBounds = new Rect(0, 0, iconSizePx, iconSizePx);
  for (let styleIdx = 0; styleIdx < warpStyleIds.length; styleIdx++) {
    previewDataUrls.push(
      renderWarpStylePreviewDataUrl(
        previewCanvas,
        previewCtx,
        iconBounds,
        iconSizePx,
        warpStyleIds[styleIdx]
      )
    );
  }
  return { previewDataUrls: previewDataUrls, previewWidthPx: previewWidthPx, previewHeightPx: previewHeightPx };
}

function renderWarpStylePreviewDataUrl(previewCanvas, previewCtx, iconBounds, iconSizePx, warpStyleId) {
  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  let warpGrid = computeWarpGrid(
      iconBounds,
      warpStyleId,
      true,
      WARP_PREVIEW_ICON_INSET,
      0,
      0
    ),
    pathOutline = rectToPathOutline(iconBounds);
  pathOutline.commands.push("M", "L", "M", "L");
  pathOutline.coords.push(0, iconSizePx / 2, iconSizePx, iconSizePx / 2);
  pathOutline.coords.push(iconSizePx / 2, 0, iconSizePx / 2, iconSizePx);
  pathOutline = normalizePathToCubics(pathOutline);
  pathOutline = subdividePathByFlatness(pathOutline, iconSizePx / 5);
  warpCoordsThroughMesh(warpGrid, pathOutline.coords, iconBounds);
  transformCoordPairs(
    pathOutline.coords,
    new Matrix2D(1, 0, 0, 1, Math.floor(8 * getDevicePixelRatio()) + 0.5, Math.floor(3 * getDevicePixelRatio()) + 0.5),
    pathOutline.coords
  );
  previewCtx.beginPath();
  Typr.U.pathToContext(toTyprPath(pathOutline), previewCtx);
  previewCtx.stroke();
  previewCtx.fillText(
    Locale.get(WARP_STYLE_LABELS[warpStyleId]),
    Math.floor(40 * getDevicePixelRatio()),
    Math.floor(16 * getDevicePixelRatio())
  );
  return previewCanvas.toDataURL();
}

// --- ConfirmWidget -------------------------------------------------------------

/**
 * Inline yes/no confirm control for option bars: a cancel (cross) and confirm
 * (checkmark) button. Clicking either sets `confirmed` and dispatches a "click"
 * event; `getValue()` reports whether confirm was pressed.
 */
function ConfirmWidget() {
  BaseWidget.call(this);
  this.el = makeElement("span", "fitem");
  this.confirmed = false;
  this.cancelBtn = new Button("No", false, "Cancel");
  this.okBtn = new Button("Yes", false, "Confirm");
  this.el.appendChild(this.cancelBtn.el);
  this.el.appendChild(this.okBtn.el);
  this.cancelBtn.on("click", this.onButtonClick, this);
  this.okBtn.on("click", this.onButtonClick, this);
  this.buildUI();
}

ConfirmWidget.prototype = Object.create(BaseWidget.prototype);
ConfirmWidget.prototype.constructor = ConfirmWidget;

ConfirmWidget.prototype.buildUI = function() {
  this.cancelBtn.setLabel(iconImgHtml("cross", null, "autoscale"));
  this.okBtn.setLabel(iconImgHtml("checkmark", null, "autoscale"));
};

ConfirmWidget.prototype.onButtonClick = function(clickEvent) {
  this.confirmed = clickEvent.target == this.okBtn;
  this.dispatch(new AppEvent("click", false));
};

ConfirmWidget.prototype.getValue = function() {
  return this.confirmed;
};

export {
  accumulateGroupBreakPositions,
  buildDropdownOptionIndexMap,
  resolveDropdownLogicalIndex,
  buildImportExtensionFilter,
  adjustPresetActionIndex,
  computeBlendIfSectionOffset,
  normalizeSwatchPickColor,
  PopupButton,
  ModeDropdown,
  ButtonMenu,
  IconRenderer,
  Dropdown,
  GradientPickerButton,
  SwatchButton,
  RadioOption,
  RadioGroup,
  AntialiasingOption,
  DocumentSelector,
  CheckboxList,
  ConfirmWidget
};
