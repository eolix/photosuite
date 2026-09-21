/**
 * Application preferences and keyboard-shortcut reference dialogs.
 */

import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { Locale } from "../../core/i18n/locale.js";
import { PopupTypes } from "../config/popup-types.js";
import { RangeInput } from "../widgets/controls/number-inputs.js";
import { Dropdown } from "../widgets/controls/popup-controls.js";
import { Checkbox } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { appendBreak, escapeHtml, makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { UNIT_NAMES } from "../../engine/compositing/geometry.js";

const SHORTCUT_COLUMN_OPEN =
  "<div style=\"line-height:1.4em; column-count:3; column-gap:3em; column-rule-width:1px;\" class=\"\">";

/** Triplets of [localeKey, shortcut, commandPaletteToolIndex] for the Tools section. */
const TOOL_SHORTCUT_KEY_ROWS = [
  "tools.moveTool", "V", 0, "tools.rectangleSelect", "M", 1, "tools.ellipseSelect", "M", 2, "tools.lassoSelect", "L", 5, "tools.polygonalLassoSelect", "L", 6, "tools.magneticLassoSelect", "L", 7, "tools.objectSelection", "W", 3, "tools.quickSelection", "W", 8, "tools.magicWand", "W", 9, "tools.cropTool", "C", 10, "tools.perspectiveCrop", "C", 11, "tools.sliceTool", "C", 12, "tools.sliceSelectTool", "C", 13, "tools.eyedropper", "I", 14, "tools.ruler", "I", 16, "tools.spotHealingBrushTool", "J", 18, "tools.healingBrushTool", "J", 19, "tools.patchTool", "J", 20, "tools.redEyeTool", "J", 22, "tools.brushTool", "B", 23, "tools.pencilTool", "B", 24, "tools.colourReplacement", "B", 25, "tools.cloneTool", "S", 27, "tools.eraserTool", "E", 31, "tools.backgroundEraser", "E", 32, "tools.gradientTool", "G", 34, "tools.paintBucketTool", "G", 35, "tools.blurTool", null, 36, "tools.sharpenTool", null, 37, "tools.smudgeTool", null, 38, "tools.dodgeTool", "O", 39, "tools.burnTool", "O", 40, "tools.spongeTool", "O", 41, "tools.typeTool", "T", 47, "tools.pen", "P", 42, "tools.freePen", "P", 43, "tools.pathSelect", "A", 51, "tools.directSelect", "A", 52, "tools.rectangle", "U", 54, "tools.ellipse", "U", 55, "tools.line", "U", 57, "tools.parametricShape", "U", 56, "tools.customShape", "U", 58, "tools.handTool", "H", 59, "tools.zoomTool", "Z", 61
];

function applyPrefsToWidgets(preferenceWidgets, prefs) {
  preferenceWidgets[0].setValue(prefs.guides);
  preferenceWidgets[1].setValue(prefs.showGrid);
  preferenceWidgets[2].setValue(prefs.gridType);
  preferenceWidgets[3].setValue(prefs.gridSize);
  preferenceWidgets[4].setValue(prefs.gridUnits);
  preferenceWidgets[5].setValue(prefs.AppWindow);
  preferenceWidgets[6].setValue(prefs.gpuAcceleration !== false);
}

function snapshotPrefsFromWidgets(preferenceWidgets, prefs) {
  const prefsCopy = JSON.parse(JSON.stringify(prefs));
  prefsCopy.guides = preferenceWidgets[0].getValue();
  prefsCopy.showGrid = preferenceWidgets[1].getValue();
  prefsCopy.gridType = preferenceWidgets[2].getValue();
  prefsCopy.gridSize = preferenceWidgets[3].getValue();
  prefsCopy.gridUnits = preferenceWidgets[4].getValue();
  prefsCopy.AppWindow = preferenceWidgets[5].getValue();
  prefsCopy.gpuAcceleration = preferenceWidgets[6].getValue();
  if (prefsCopy.gridUnits != 4) prefsCopy.gridSize = Math.round(prefsCopy.gridSize);
  return prefsCopy;
}

/** Drop the command-palette index from each triplet, skipping tools with no shortcut. */
function flattenToolShortcutKeyRows(toolShortcutKeyRows) {
  const flatShortcutRows = [];
  for (let rowIdx = 0; rowIdx < toolShortcutKeyRows.length; rowIdx += 3) {
    if (toolShortcutKeyRows[rowIdx + 1]) {
      flatShortcutRows.push(toolShortcutKeyRows[rowIdx], toolShortcutKeyRows[rowIdx + 1]);
    }
  }
  return flatShortcutRows;
}

function PreferencesDialog() {
  BaseDialog.call(this, "properties.preferences", "preferences");
  this.doc = null;
  const formDiv = makeElement("div", "form");
  this.body.appendChild(formDiv);
  this.preferenceWidgets = [new Checkbox("view.guides"), new Checkbox("view.grid"), new Dropdown("properties.gridType", [
    "properties.shapeType.square",
    "properties.isometric"
  ]), new RangeInput("properties.gridGap", 1, 100, null, 2), new Dropdown(null, UNIT_NAMES), new Dropdown("properties.rulerUnits", UNIT_NAMES), new Checkbox("properties.gpuAcceleration")];
  // The grid-gap field and the unit dropdown that follows it are one control:
  // they share a row so the units read as belonging to the gap above them.
  const GRID_GAP_FIELD_INDEX = 3;
  for (let widgetIdx = 0; widgetIdx < this.preferenceWidgets.length; widgetIdx++) {
    const preferenceWidget = this.preferenceWidgets[widgetIdx];
    if (widgetIdx === GRID_GAP_FIELD_INDEX) {
      const gridGapRowEl = makeElement("span", "fieldrow");
      gridGapRowEl.appendChild(preferenceWidget.el);
      gridGapRowEl.appendChild(this.preferenceWidgets[widgetIdx + 1].el);
      formDiv.appendChild(gridGapRowEl);
      appendBreak(formDiv);
    } else if (widgetIdx !== GRID_GAP_FIELD_INDEX + 1) {
      formDiv.appendChild(preferenceWidget.el);
      appendBreak(formDiv);
    }
    preferenceWidget.on(EventType.widgetSelect, this.onPreferenceWidgetChange, this);
  }
}
PreferencesDialog.prototype = Object.create(BaseDialog.prototype);
PreferencesDialog.prototype.constructor = PreferencesDialog;
PreferencesDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  for (let widgetIdx = 0; widgetIdx < this.preferenceWidgets.length; widgetIdx++) this.preferenceWidgets[widgetIdx].buildUI();
};
PreferencesDialog.prototype.open = function(currentDoc, dialogPayload, openDocs) {};
PreferencesDialog.prototype.onUpdate = function(appData, popupType) {
  this.doc = appData;
  applyPrefsToWidgets(this.preferenceWidgets, appData.prefs);
};
PreferencesDialog.prototype.onPreferenceWidgetChange = function(widgetEvent) {
  const prefsCopy = snapshotPrefsFromWidgets(this.preferenceWidgets, this.doc.prefs);
  const dispatchEvent = new AppEvent(EventType.uiDispatch, true);
  dispatchEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.PREFERENCES,
    prefsSnapshot: prefsCopy
  };
  this.dispatch(dispatchEvent);
};

function KeyboardShortcutsDialog() {
  BaseDialog.call(this, "dialogs.keyboardShortcuts", "shortcuts");
  const shortcutsScrollRoot = this.shortcutsScrollRoot = makeElement("div", "scrollable");
  shortcutsScrollRoot.setAttribute("style", "min-width:700px; max-height:500px; padding:1.5em");
  this.body.appendChild(shortcutsScrollRoot);
  this.renderShortcutHelpHtml();
}
KeyboardShortcutsDialog.prototype = Object.create(BaseDialog.prototype);
KeyboardShortcutsDialog.prototype.constructor = KeyboardShortcutsDialog;
KeyboardShortcutsDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.renderShortcutHelpHtml();
};
KeyboardShortcutsDialog.prototype.renderShortcutHelpHtml = function() {
  const keyboardHandler = KeyboardHandler;
  const ctrlKey = keyboardHandler.Ctrl;
  const shiftKey = keyboardHandler.Shift;
  const altKey = keyboardHandler.Alt;
  let htmlParts = "";
  htmlParts += "<h2 style=\"margin-top:0;\">Main Menu</h2>";
  htmlParts += SHORTCUT_COLUMN_OPEN;
  htmlParts += this.formatShortcutTableRows([
      "topMenu.file", "---", "file.open",
      [ctrlKey, keyboardHandler.KeyO],
      "file.save",
      [ctrlKey, keyboardHandler.KeyS],
      "file.saveAsPSD",
      [shiftKey, ctrlKey, keyboardHandler.KeyS],
      "file.exportAs",
      [altKey, shiftKey, ctrlKey, keyboardHandler.KeyS],
      "topMenu.edit", "---", "edit.stepForward",
      [shiftKey, ctrlKey, keyboardHandler.KeyZ],
      "edit.stepBackward",
      [ctrlKey, keyboardHandler.KeyZ],
      "clipboard.cut",
      [ctrlKey, keyboardHandler.KeyX],
      "clipboard.copy",
      [ctrlKey, keyboardHandler.KeyC],
      "clipboard.paste",
      [ctrlKey, keyboardHandler.KeyV],
      "edit.clear", "Delete", "edit.fill",
      [altKey, keyboardHandler.Backspace],
      "tools.freeTransform",
      [altKey, ctrlKey, keyboardHandler.KeyT],
      "properties.preferences",
      [ctrlKey, keyboardHandler.KeyK],
      "adjustmentsMenuTitle", "---", "adjustments.levels",
      [ctrlKey, keyboardHandler.KeyL],
      "adjustments.curves",
      [ctrlKey, keyboardHandler.KeyM],
      "adjustments.hueSaturation",
      [ctrlKey, keyboardHandler.KeyU],
      "adjustments.invert",
      [ctrlKey, keyboardHandler.KeyI],
      "topMenu.layer", "---", "layer.duplicateLayer",
      [ctrlKey, keyboardHandler.KeyJ],
      "layer.clippingMask",
      [altKey, ctrlKey, keyboardHandler.KeyG],
      "layer.groupLayers",
      [ctrlKey, keyboardHandler.KeyG],
      "layer.mergeDown",
      [ctrlKey, keyboardHandler.KeyE],
      "topMenu.select", "---", "select.all",
      [ctrlKey, keyboardHandler.KeyA],
      "select.deselect",
      [ctrlKey, keyboardHandler.KeyD],
      "select.inverse",
      [shiftKey, ctrlKey, keyboardHandler.KeyI],
      "topMenu.view", "---", "view.zoomIn",
      [ctrlKey, keyboardHandler.Plus],
      "view.zoomOut",
      [ctrlKey, keyboardHandler.Minus],
      "view.rulers",
      [ctrlKey, keyboardHandler.KeyR],
      "view.guides",
      [ctrlKey, keyboardHandler.Semicolon],
      "view.grid",
      [ctrlKey, keyboardHandler.Quote],
      "dialogs.keyboardShortcuts", "?"
    ]);
  htmlParts += "</div>";
  htmlParts += "<h2 style=\"margin-top:1.5em;\">Navigation</h2>";
  htmlParts += SHORTCUT_COLUMN_OPEN;
  htmlParts += this.formatShortcutTableRows(["Vertical scroll", "Wheel", "Horizontal scroll", [ctrlKey, "Wheel"], "Zooming", [altKey, "Wheel"]]);
  htmlParts += "</div>";
  htmlParts += "<h2 style=\"margin-top:1.5em;\">Quick tools (press to enable, release to disable)</h2>";
  htmlParts += SHORTCUT_COLUMN_OPEN;
  htmlParts += this.formatShortcutTableRows([
    "tools.moveTool",
    [ctrlKey],
    "tools.handTool", "Space", "tools.zoomTool",
    [ctrlKey, keyboardHandler.Space]
  ]);
  htmlParts += "</div>";
  const flatShortcutRows = flattenToolShortcutKeyRows(TOOL_SHORTCUT_KEY_ROWS).concat([
    "filters.menu.other.title", "---", "warp.defaultWhiteAndBlack", "D", "warp.swapColours", "X", "layer.quickMaskMode", "Q", "Decrease Brush Size", "[", "Increase Brush Size", "]", "Decrease Hardness", "{", "Increase Hardness", "}"
  ]);
  htmlParts += "<h2 style=\"margin-top:1.5em;\">Tools</h2>";
  htmlParts += SHORTCUT_COLUMN_OPEN;
  htmlParts += this.formatShortcutTableRows(flatShortcutRows);
  htmlParts += "</div>";
  this.shortcutsScrollRoot.innerHTML = htmlParts;
};
KeyboardShortcutsDialog.prototype.formatShortcutTableRows = function(shortcutRows) {
  let rowsHtml = "";
  let isFirstSection = true;
  for (let rowIdx = 0; rowIdx < shortcutRows.length; rowIdx += 2) {
    const localeKeyOrLabel = shortcutRows[rowIdx];
    const formattedShortcut = KeyboardHandler.formatShortcut(shortcutRows[rowIdx + 1]);
    if (formattedShortcut == null) {
      isFirstSection = false;
      continue;
    }
    const escapedLabel = escapeHtml(Locale.get(localeKeyOrLabel));
    if (formattedShortcut == "---") {
      if (!isFirstSection) rowsHtml += "<br/>";
      rowsHtml += "<div style=\"font-weight:bold; border-bottom: 1px solid;\">" + escapedLabel + "</div>";
    } else {
      rowsHtml += "<div>" + escapedLabel + " <span style=\"float:right; font-weight:bold;\">" + formattedShortcut + "</span> </div>";
    }
    isFirstSection = false;
  }
  return rowsHtml;
};
KeyboardShortcutsDialog.toolShortcutKeyRows = TOOL_SHORTCUT_KEY_ROWS;

export {
  PreferencesDialog,
  KeyboardShortcutsDialog,
  TOOL_SHORTCUT_KEY_ROWS,
  flattenToolShortcutKeyRows,
  snapshotPrefsFromWidgets,
};
