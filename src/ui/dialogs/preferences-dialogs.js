/**
 * Application preferences and keyboard-shortcut reference dialogs.
 */

import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { Locale } from "../../core/i18n/locale.js";
import { PopupTypes } from "../config/popup-types.js";
import { ThemeConfig } from "../config/theme-config.js";
import { RangeInput } from "../widgets/controls/number-inputs.js";
import { Dropdown } from "../widgets/controls/popup-controls.js";
import { Button, Checkbox, Label } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, appendBreak, appendHorizontalRule, escapeHtml, makeElement, removeClass } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { UNIT_NAMES } from "../../engine/compositing/geometry.js";
import { createDefaultEditorPrefs } from "../../core/editor-persisted-params.js";

const SHORTCUT_COLUMN_OPEN =
  "<div style=\"line-height:1.4em; column-count:3; column-gap:3em; column-rule-width:1px;\" class=\"\">";

/** Triplets of [localeKey, shortcut, commandPaletteToolIndex] for the Tools section. */
const TOOL_SHORTCUT_KEY_ROWS = [
  "tools.moveTool", "V", 0, "tools.rectangleSelect", "M", 1, "tools.ellipseSelect", "M", 2, "tools.lassoSelect", "L", 5, "tools.polygonalLassoSelect", "L", 6, "tools.magneticLassoSelect", "L", 7, "tools.objectSelection", "W", 3, "tools.quickSelection", "W", 8, "tools.magicWand", "W", 9, "tools.cropTool", "C", 10, "tools.perspectiveCrop", "C", 11, "tools.sliceTool", "C", 12, "tools.sliceSelectTool", "C", 13, "tools.eyedropper", "I", 14, "tools.ruler", "I", 16, "tools.spotHealingBrushTool", "J", 18, "tools.healingBrushTool", "J", 19, "tools.patchTool", "J", 20, "tools.redEyeTool", "J", 22, "tools.brushTool", "B", 23, "tools.pencilTool", "B", 24, "tools.colourReplacement", "B", 25, "tools.cloneTool", "S", 27, "tools.eraserTool", "E", 31, "tools.backgroundEraser", "E", 32, "tools.gradientTool", "G", 34, "tools.paintBucketTool", "G", 35, "tools.blurTool", null, 36, "tools.sharpenTool", null, 37, "tools.smudgeTool", null, 38, "tools.dodgeTool", "O", 39, "tools.burnTool", "O", 40, "tools.spongeTool", "O", 41, "tools.typeTool", "T", 47, "tools.pen", "P", 42, "tools.freePen", "P", 43, "tools.pathSelect", "A", 51, "tools.directSelect", "A", 52, "tools.rectangle", "U", 54, "tools.ellipse", "U", 55, "tools.line", "U", 57, "tools.parametricShape", "U", 56, "tools.customShape", "U", 58, "tools.handTool", "H", 59, "tools.zoomTool", "Z", 61
];

/**
 * Positions in `preferenceWidgets`. The array is the order the widgets are
 * created in, not the order they appear on screen — a section can show any of
 * them, and the two functions below are what keep prefs and widgets in step.
 */
const PREF_WIDGET = {
  GUIDES: 0,
  SHOW_GRID: 1,
  GRID_TYPE: 2,
  GRID_SIZE: 3,
  GRID_UNITS: 4,
  RULER_UNITS: 5,
  GPU_ACCELERATION: 6,
};

/**
 * The sections in the left-hand list, in order. Each holds one or more groups,
 * separated by a rule the way the Shadows/Highlights panel separates its tone
 * ranges. A group lists its controls: a {@link PREF_WIDGET} index for a
 * preference, or a name from {@link PreferencesDialog#extraWidgets} for a
 * control that is not one (the theme and language pickers dispatch on their
 * own, and do not live in `appData.prefs`).
 *
 * A group can carry a `labelKey`, which heads it the way that panel heads
 * "Shadows" and "Highlights". The groups here need none: the rule is enough to
 * separate a checkbox from the grid controls under it.
 */
const PREFERENCE_SECTIONS = [
  {
    id: "general",
    labelKey: "dialogs.preferenceSections.general",
    groups: [{ controls: [PREF_WIDGET.GPU_ACCELERATION] }],
  },
  {
    id: "interface",
    labelKey: "dialogs.preferenceSections.interface",
    groups: [{ controls: ["theme", "language"] }],
  },
  {
    id: "units",
    labelKey: "dialogs.preferenceSections.unitsAndRulers",
    groups: [{ controls: [PREF_WIDGET.RULER_UNITS] }],
  },
  {
    id: "guides",
    labelKey: "dialogs.preferenceSections.guidesGridSlices",
    groups: [
      { controls: [PREF_WIDGET.GUIDES] },
      { controls: [PREF_WIDGET.SHOW_GRID, PREF_WIDGET.GRID_TYPE, PREF_WIDGET.GRID_SIZE] },
    ],
  },
];

/** Every control a section places, flattened; a number is a PREF_WIDGET index. */
function sectionControlRefs(section) {
  const refs = [];
  for (let groupIdx = 0; groupIdx < section.groups.length; groupIdx++) {
    const groupControls = section.groups[groupIdx].controls;
    for (let controlIdx = 0; controlIdx < groupControls.length; controlIdx++) {
      refs.push(groupControls[controlIdx]);
    }
  }
  return refs;
}

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

/** Theme names for the Interface picker, in `ThemeConfig.themes` order. */
function themePickerLabels() {
  const labels = [];
  for (let themeIdx = 0; themeIdx < ThemeConfig.themes.length; themeIdx++) {
    labels.push(ThemeConfig.themes[themeIdx].name);
  }
  return labels;
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

/**
 * Preferences: a list of sections on the left, one pane at a time on the right.
 *
 * The sections are the growth path — new preferences get a pane rather than
 * another row on one long form — so the layout is built from
 * {@link PREFERENCE_SECTIONS} and adding to that list is all a new section
 * needs.
 *
 * Interface holds the theme and language pickers, which the More menu also
 * offers. Neither place owns the setting: both dispatch the same
 * CHANGE_THEME / CHANGE_LANGUAGE command, and both read their state back from
 * `appData` and `Locale`, so changing one shows up in the other.
 */
function PreferencesDialog() {
  BaseDialog.call(this, "properties.preferences", "preferences");
  this.doc = null;
  this.activeSectionId = PREFERENCE_SECTIONS[0].id;
  this.preferenceWidgets = [new Checkbox("view.guides"), new Checkbox("view.grid"), new Dropdown("properties.gridType", [
    "properties.shapeType.square",
    "properties.isometric"
  ]), new RangeInput("properties.gridGap", 1, 100, null, 2), new Dropdown(null, UNIT_NAMES), new Dropdown("properties.rulerUnits", UNIT_NAMES), new Checkbox("properties.gpuAcceleration")];
  for (let widgetIdx = 0; widgetIdx < this.preferenceWidgets.length; widgetIdx++) {
    this.preferenceWidgets[widgetIdx].on(EventType.widgetSelect, this.onPreferenceWidgetChange, this);
  }

  this.themeDropdown = new Dropdown("topMenu.theme", themePickerLabels());
  this.themeDropdown.on(EventType.widgetSelect, this.onThemePicked, this);
  /** Locale table index for each row of the language picker. */
  this.languageTableIndices = [];
  this.languageDropdown = new Dropdown("topMenu.language", this.buildLanguagePickerLabels());
  this.languageDropdown.on(EventType.widgetSelect, this.onLanguagePicked, this);
  /** Controls a section can place by name, for what is not a preference. */
  this.extraWidgets = { theme: this.themeDropdown, language: this.languageDropdown };

  addClass(this.body, "flexrow");
  const layoutEl = this.layoutEl = makeElement("div", "prefs-layout");
  this.body.appendChild(layoutEl);
  this.sectionListEl = makeElement("div", "prefs-nav");
  layoutEl.appendChild(this.sectionListEl);
  this.sectionPanesEl = makeElement("div", "prefs-panes");
  layoutEl.appendChild(this.sectionPanesEl);

  this.sectionButtons = [];
  this.sectionPanes = [];
  /** Group headings, for the relabel a language change needs. */
  this.groupLabels = [];
  for (let sectionIdx = 0; sectionIdx < PREFERENCE_SECTIONS.length; sectionIdx++) {
    const section = PREFERENCE_SECTIONS[sectionIdx];
    const sectionButton = makeElement("button", "prefs-nav-item");
    sectionButton.setAttribute("type", "button");
    sectionButton.addEventListener("click", this.setActiveSection.bind(this, section.id), false);
    this.sectionListEl.appendChild(sectionButton);
    this.sectionButtons.push(sectionButton);
    const paneEl = makeElement("div", "prefs-pane form form-labelled");
    paneEl.setAttribute("style", "--form-label-width:8.5em;");
    this.sectionPanesEl.appendChild(paneEl);
    this.sectionPanes.push(paneEl);
    this.fillSectionPane(paneEl, section);
  }

  // Same column the filter modals put their confirm actions in, so Preferences
  // reads like the rest of the app's dialogs.
  this.okButton = new Button("clipboard.ok", true, null, true);
  this.okButton.on("click", this.onOK, this);
  this.resetButton = new Button("properties.reset", true, null, true);
  this.resetButton.on("click", this.onResetToDefaults, this);
  const actionsColumnEl = makeElement("div", "dialog-actions");
  actionsColumnEl.appendChild(this.okButton.el);
  actionsColumnEl.appendChild(this.resetButton.el);
  this.body.appendChild(actionsColumnEl);

  this.setActiveSection(this.activeSectionId);
}
PreferencesDialog.prototype = Object.create(BaseDialog.prototype);
PreferencesDialog.prototype.constructor = PreferencesDialog;

/** Native language names, remembering which locale table each row selects. */
PreferencesDialog.prototype.buildLanguagePickerLabels = function() {
  const sortedLanguages = Locale.getSortedLanguages();
  const labels = [];
  this.languageTableIndices = [];
  for (let langIdx = 0; langIdx < sortedLanguages.length; langIdx++) {
    labels.push(sortedLanguages[langIdx].name);
    this.languageTableIndices.push(Locale.findLanguageIndex(sortedLanguages[langIdx].code));
  }
  return labels;
};

/** The widget a section's control reference names. */
PreferencesDialog.prototype.widgetForControlRef = function(controlRef) {
  if (typeof controlRef === "string") return this.extraWidgets[controlRef];
  return this.preferenceWidgets[controlRef];
};

/**
 * Lay a section out: its groups in order, separated by a rule. A group heads
 * itself with a label when it has one, and its controls follow one per row.
 */
PreferencesDialog.prototype.fillSectionPane = function(paneEl, section) {
  for (let groupIdx = 0; groupIdx < section.groups.length; groupIdx++) {
    const group = section.groups[groupIdx];
    if (groupIdx !== 0) appendHorizontalRule(paneEl);
    if (group.labelKey) {
      const groupLabel = new Label(group.labelKey);
      this.groupLabels.push(groupLabel);
      paneEl.appendChild(groupLabel.el);
      appendBreak(paneEl);
    }
    for (let controlIdx = 0; controlIdx < group.controls.length; controlIdx++) {
      const controlRef = group.controls[controlIdx];
      if (controlRef === PREF_WIDGET.GRID_SIZE) {
        // The gap field and the unit dropdown after it are one control: they
        // share a row so the units read as belonging to the gap.
        const gridGapRowEl = makeElement("span", "fieldrow");
        gridGapRowEl.appendChild(this.preferenceWidgets[PREF_WIDGET.GRID_SIZE].el);
        gridGapRowEl.appendChild(this.preferenceWidgets[PREF_WIDGET.GRID_UNITS].el);
        paneEl.appendChild(gridGapRowEl);
      } else {
        paneEl.appendChild(this.widgetForControlRef(controlRef).el);
      }
      appendBreak(paneEl);
    }
  }
};

/** Show one section and mark its row; the others are hidden, not unbuilt. */
PreferencesDialog.prototype.setActiveSection = function(sectionId) {
  this.activeSectionId = sectionId;
  for (let sectionIdx = 0; sectionIdx < PREFERENCE_SECTIONS.length; sectionIdx++) {
    const isActive = PREFERENCE_SECTIONS[sectionIdx].id === sectionId;
    const sectionButton = this.sectionButtons[sectionIdx];
    if (isActive) addClass(sectionButton, "selected");
    else removeClass(sectionButton, "selected");
    sectionButton.setAttribute("aria-selected", isActive ? "true" : "false");
    this.sectionPanes[sectionIdx].hidden = !isActive;
  }
};

PreferencesDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  if (this.sectionButtons == null) return;
  for (let widgetIdx = 0; widgetIdx < this.preferenceWidgets.length; widgetIdx++) {
    this.preferenceWidgets[widgetIdx].buildUI();
  }
  this.themeDropdown.buildUI();
  this.languageDropdown.buildUI();
  this.okButton.buildUI();
  this.resetButton.buildUI();
  for (let sectionIdx = 0; sectionIdx < PREFERENCE_SECTIONS.length; sectionIdx++) {
    this.sectionButtons[sectionIdx].textContent = Locale.get(PREFERENCE_SECTIONS[sectionIdx].labelKey);
  }
  for (let labelIdx = 0; labelIdx < this.groupLabels.length; labelIdx++) {
    this.groupLabels[labelIdx].buildUI();
  }
  this.setActiveSection(this.activeSectionId);
};

/**
 * A share of the window rather than a shrink-wrap around the controls: the
 * sections are a growing list, and a dialog that changed size with each one
 * would be the wrong shape for all of them. Same approach as the filter gallery
 * and Camera Raw, bounded so it stays a dialog on a large display and still
 * fits on a small one.
 */
PreferencesDialog.prototype.getPreferredContentSize = function(maxW, maxH) {
  return {
    width: Math.min(Math.max(Math.round(maxW * 0.56), 640), Math.min(960, maxW)),
    height: Math.min(Math.max(Math.round(maxH * 0.6), 420), Math.min(720, maxH)),
  };
};

/**
 * `applyContentSizedLayout` leaves the body at `fit-content` and then snaps the
 * window to whatever the content measured — so the size asked for above only
 * happens if the body claims it here.
 */
PreferencesDialog.prototype.resize = function(contentWidth, contentHeight) {
  this.body.style.width = contentWidth + "px";
};
PreferencesDialog.prototype.open = function(currentDoc, dialogPayload, openDocs) {};
PreferencesDialog.prototype.onUpdate = function(appData, popupType) {
  this.doc = appData;
  applyPrefsToWidgets(this.preferenceWidgets, appData.prefs);
  this.themeDropdown.setValue(appData.theme == null ? 0 : appData.theme);
  const activeLanguageRow = this.languageTableIndices.indexOf(Locale.activeTableIndex);
  if (activeLanguageRow !== -1) this.languageDropdown.setValue(activeLanguageRow);
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
PreferencesDialog.prototype.onOK = function(clickEvent) {
  // Every control here applies as it is changed, so there is nothing to commit.
  this.close();
};

/**
 * Put the preference values back to a fresh install's. Theme and language are
 * left alone: they are the two settings here that are not preferences, and
 * resetting the language out from under someone is not a kindness.
 */
PreferencesDialog.prototype.onResetToDefaults = function(clickEvent) {
  const prefsCopy = Object.assign({}, this.doc.prefs, createDefaultEditorPrefs());
  const dispatchEvent = new AppEvent(EventType.uiDispatch, true);
  dispatchEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.PREFERENCES,
    prefsSnapshot: prefsCopy
  };
  this.dispatch(dispatchEvent);
};
PreferencesDialog.prototype.onThemePicked = function(widgetEvent) {
  const dispatchEvent = new AppEvent(EventType.uiDispatch, true);
  dispatchEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.CHANGE_THEME,
    theme: this.themeDropdown.getValue()
  };
  this.dispatch(dispatchEvent);
};
PreferencesDialog.prototype.onLanguagePicked = function(widgetEvent) {
  const languageTableIndex = this.languageTableIndices[this.languageDropdown.getValue()];
  if (languageTableIndex == null || languageTableIndex === -1) return;
  const dispatchEvent = new AppEvent(EventType.uiDispatch, true);
  dispatchEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.CHANGE_LANGUAGE,
    lang: languageTableIndex
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
  PREFERENCE_SECTIONS,
  PREF_WIDGET,
  TOOL_SHORTCUT_KEY_ROWS,
  flattenToolShortcutKeyRows,
  snapshotPrefsFromWidgets,
};
