/**
 * Swatches panel: quick recent-colour grid plus user swatch picker. Both
 * dispatch COLOR_CHANGE with `value` holding the packed 0xRRGGBB int.
 */

import { PopupTypes } from "../config/popup-types.js";
import { BaseTool } from "../widgets/base-tool.js";
import { SwatchFile } from "../../features/swatch/swatch-file.js";
import { ensureDefaultSwatchPresets, getSwatchPresetStore } from "../config/default-presets.js";
import { ColorSwatchGrid } from "../widgets/controls/color-controls.js";
import { SwatchButton } from "../widgets/controls/popup-controls.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { rgbToHex } from "../../engine/compositing/color-math.js";

/**
 * Construct the Swatches panel: a grid of recent colors above a swatch preset
 * picker. Selecting from either sets the foreground color. The `{ h, l, O }`
 * channel object is the shared RGB representation used across the color code.
 */
function SwatchesPanel() {
  BaseTool.call(this, "panels.swatches", false, getIconUrl("panels/swatches"), BaseTool.PanelId.SWATCHES, true);
  installSwatchesPanelLayout(this);
  this.swatchGrid.on(EventType.widgetSelect, this.onColorSelect, this);
  this.swatchPicker.on(EventType.widgetSelect, this.onColorSelect, this)
}
SwatchesPanel.prototype = Object.create(BaseTool.prototype);

SwatchesPanel.prototype.buildUI = function() {
  BaseTool.prototype.buildUI.call(this);
  this.swatchPicker.buildUI()
};

SwatchesPanel.prototype.onColorSelect = function(evt) {
  const packedColor = resolveSelectedPackedColor(this, evt.target);
  this.dispatch(buildColorChangeDispatch(packedColor))
};

SwatchesPanel.prototype.onUpdate = function(appData, popupType) {
  const isAll = popupType == PopupTypes.ALL;
  if (popupType == PopupTypes.COLOR_CHANGE || isAll) {
    syncActiveColorWidgets(this, appData.colorInt)
  }
  if (popupType == PopupTypes.SWATCHES || isAll) {
    syncSwatchPresets(this, appData)
  }
};

/**
 * Pack { h, l, O } channel ints into a 0xRRGGBB value.
 */
SwatchesPanel.packSwatchRgbChannels = packSwatchRgbChannels;

/**
 * Unpack a packed foreground int into a swatch picker value object.
 */
SwatchesPanel.unpackPackedColorToSwatchValue = unpackPackedColorToSwatchValue;

export { SwatchesPanel };

// ---------------------------------------------------------------------------
// Layout + dispatch
// ---------------------------------------------------------------------------

function installSwatchesPanelLayout(panel) {
  panel.container = makeElement("div", "padded");
  panel.panelBody.appendChild(panel.container);
  panel.swatchGrid = new ColorSwatchGrid(10);
  panel.container.appendChild(panel.swatchGrid.el);
  panel.container.appendChild(makeElement("hr"));
  panel.swatchPicker = new SwatchButton();
  panel.swatchPicker.parent = panel;
  panel.container.appendChild(panel.swatchPicker.popupToolbar)
}

function resolveSelectedPackedColor(panel, target) {
  if (target == panel.swatchGrid) return panel.swatchGrid.getValue();
  return packSwatchRgbChannels(panel.swatchPicker.getValue())
}

function packSwatchRgbChannels(rgb) {
  return Math.round(rgb.h) << 16 | Math.round(rgb.l) << 8 | Math.round(rgb.O)
}

function buildColorChangeDispatch(packedColor) {
  const dispatchEvt = new AppEvent(EventType.uiDispatch, true);
  dispatchEvt.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.COLOR_CHANGE,
    operation: 0,
    value: packedColor
  };
  return dispatchEvt
}

function unpackPackedColorToSwatchValue(packedFg) {
  return {
    h: packedFg >>> 16 & 255,
    l: packedFg >>> 8 & 255,
    O: packedFg >>> 0 & 255,
    name: "Color #" + rgbToHex(packedFg)
  }
}

function syncActiveColorWidgets(panel, packedFg) {
  panel.swatchGrid.setValue(packedFg);
  panel.swatchPicker.setValue(unpackPackedColorToSwatchValue(packedFg))
}

function syncSwatchPresets(panel, appData) {
  const swatchStore = getSwatchPresetStore(appData);
  ensureDefaultSwatchPresets(swatchStore);
  SwatchFile.migrateStoreToTree(swatchStore);
  panel.swatchPicker.setPresets(swatchStore)
}
