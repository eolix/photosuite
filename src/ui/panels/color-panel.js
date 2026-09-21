/**
 * Sidebar Color panel: foreground / background swatches plus a ColorWheel.
 * Selecting a swatch routes the wheel to that slot; wheel edits dispatch a
 * COLOR_CHANGE popup (payload key `value` holds the 0xRRGGBB int). Wheel→doc echo
 * is throttled via lastChangeTime so the panel does not fight its own updates.
 */

import { PopupTypes } from "../config/popup-types.js";
import { BaseTool } from "../widgets/base-tool.js";
import { ColorSampleWidget, ColorWheel } from "../widgets/controls/color-controls.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";

/** Ignore doc→wheel echo for this many ms after a local wheel edit. */
const WHEEL_ECHO_GUARD_MS = 100;

function ColorPanel() {
  BaseTool.call(this, "colour.title", false, getIconUrl("panels/colour"), BaseTool.PanelId.COLOR, true);
  this.activeColorIndex = 0;
  this.lastChangeTime = 0;
  this.doc = null;
  installColorPanelLayout(this)
}
ColorPanel.prototype = Object.create(BaseTool.prototype);

ColorPanel.prototype.onSwatchClick = function(evt) {
  this.activeColorIndex = this.colorSwatches.indexOf(evt.currentTarget);
  this.redraw()
};

ColorPanel.prototype.onWheelChange = function(evt) {
  const rgb = this.colorWheel.getValue();
  this.colorWheel.setValue(rgb);
  const dispatchEvt = new AppEvent(EventType.uiDispatch, true);
  dispatchEvt.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.COLOR_CHANGE,
    operation: this.activeColorIndex,
    value: packNormalizedRgb(rgb)
  };
  this.dispatch(dispatchEvt);
  this.lastChangeTime = Date.now()
};

ColorPanel.prototype.redraw = function() {
  const doc = this.doc,
    activeIndex = this.activeColorIndex,
    packedColors = [doc.colorInt, doc.bgColor];
  syncSwatchAppearance(this.colorSwatches, packedColors, activeIndex);
  if (Date.now() - this.lastChangeTime > WHEEL_ECHO_GUARD_MS) {
    this.colorWheel.setValue(unpackPackedRgb(packedColors[activeIndex]))
  }
};

ColorPanel.prototype.onUpdate = function(doc, popupType) {
  this.doc = doc;
  if (popupType == PopupTypes.ALL || popupType == PopupTypes.COLOR_CHANGE) this.redraw()
};

ColorPanel.prototype.refresh = function() {
  this.redraw()
};

export { ColorPanel };

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function installColorPanelLayout(panel) {
  const row = makeElement("div", "flexrow padded");
  panel.panelBody.appendChild(row);
  const swatchCol = makeElement("div");
  row.appendChild(swatchCol);
  panel.colorSwatches = [];
  for (let i = 0; i < 2; i++) {
    const swatch = new ColorSampleWidget();
    panel.colorSwatches.push(swatch);
    swatch.on("click", panel.onSwatchClick, panel);
    swatchCol.appendChild(swatch.el)
  }
  panel.colorWheel = new ColorWheel(192);
  panel.colorWheel.on(EventType.widgetSelect, panel.onWheelChange, panel);
  row.appendChild(panel.colorWheel.el)
}

function packNormalizedRgb(rgb) {
  return Math.round(rgb.h * 255) << 16 | Math.round(rgb.l * 255) << 8 | Math.round(rgb.O * 255)
}

function unpackPackedRgb(packedRgb) {
  return {
    h: (packedRgb >>> 16) / 255,
    l: (packedRgb >>> 8 & 255) / 255,
    O: (packedRgb & 255) / 255
  }
}

function syncSwatchAppearance(swatches, packedColors, activeIndex) {
  for (let i = 0; i < 2; i++) {
    const swatch = swatches[i],
      style = swatch.el.style;
    swatch.setPackedRgb(packedColors[i]);
    if (i == activeIndex) delete style.borderColor;
    else style.borderColor = "var(--bg-color)"
  }
}
