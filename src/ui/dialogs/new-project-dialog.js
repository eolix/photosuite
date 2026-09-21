/**
 * New-document dialog.
 *
 * Three-column layout: preset categories (left), preset thumbnails (center),
 * and document settings (right). Recent stores the last five blank documents
 * created from this dialog.
 */

import { Locale } from "../../core/i18n/locale.js";
import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { Document } from "../../document/model/document.js";
import {
  getRecentDocumentPresets,
  loadRecentDocumentPresetsFromStore,
  recentDocumentPresetToPresetRow,
  recordRecentDocumentPreset
} from "../../core/recent-document-presets.js";
import { FileLoader } from "../shell/file-loader.js";
import { ColorSampleWidget } from "../widgets/controls/color-controls.js";
import { LayerEffectOption } from "../widgets/controls/stroke-layer-controls.js";
import { Dropdown } from "../widgets/controls/popup-controls.js";
import { Button, MenuList, TextInput } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { EventType } from "../../core/event-bus.js";
import { addClass, clearElement, getDevicePixelRatio, makeElement, removeClass } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";

/** Static preset tables grouped by category name (locale key or literal label). */
const DOCUMENT_PRESET_CATEGORIES = [{
  name: "properties.presetCategory.photo",
  presetRows: [
    ["Wallet", 2, 3, "in", 300],
    ["Enprint", 3.5, 5, "in", 300],
    [null, 5, 7, "in", 300],
    [null, 8, 12, "in", 300],
    [null, 12, 18, "in", 300],
    [null, 16, 24, "in", 300],
    [null, 20, 30, "in", 300],
    [null, 24, 36, "in", 300]
  ]
}, {
  name: "properties.presetCategory.print",
  presetRows: [
    ["A3", 297, 420, "mm", 300],
    ["A4", 210, 297, "mm", 300],
    ["A5", 148, 210, "mm", 300],
    ["B3", 353, 500, "mm", 300],
    ["B4", 250, 353, "mm", 300],
    ["B5", 176, 250, "mm", 300],
    ["Letter", 8.5, 11, "in", 300],
    ["Ledger", 11, 17, "in", 300],
    ["Business Card", 3.5, 2, "in", 300]
  ]
}, {
  name: "properties.presetCategory.screen",
  presetRows: [
    ["VGA", 640, 480, "px", 0],
    ["XGA", 1024, 768, "px", 0],
    ["HD", 1280, 720, "px", 0],
    [null, 1366, 768, "px", 0],
    [null, 1600, 900, "px", 0],
    ["Full HD", 1920, 1080, "px", 0],
    ["2K", 2048, 1080, "px", 0],
    ["UHD", 3840, 2160, "px", 0],
    ["4K", 4096, 2160, "px", 0]
  ]
}, {
  name: "properties.presetCategory.mobile",
  presetRows: [
    ["iPhone 13 mini", 1080, 2340, "px", 476],
    ["iPhone 13 / 14", 1170, 2532, "px", 460],
    ["iPhone 15 / 16", 1179, 2556, "px", 460],
    ["iPhone 16 Pro", 1206, 2622, "px", 460],
    ["iPhone 16 Pro Max", 1320, 2868, "px", 460],
    ["Google Pixel 8a", 1080, 2400, "px", 0],
    ["Google Pixel 9", 1080, 2424, "px", 0],
    ["Google Pixel 9 Pro", 1280, 2856, "px", 0],
    ["Samsung Galaxy S24", 1080, 2340, "px", 0],
    ["Samsung Galaxy S24 Ultra", 1440, 3120, "px", 0],
    ["Samsung Galaxy Z Fold 6 cover", 968, 2376, "px", 0],
    ["iPad mini (7th gen)", 1488, 2266, "px", 326],
    ["iPad Air 11\" (M2/M3)", 1640, 2360, "px", 264],
    ["iPad Pro 11\" (M4)", 1668, 2420, "px", 264],
    ["iPad Pro 13\" (M4)", 2064, 2752, "px", 264],
    ["Samsung Galaxy Tab S10 Ultra", 1848, 2960, "px", 0]
  ]
}, {
  name: "Social",
  presetRows: [
    ["FB Page Cover", 1640, 664, "px", 0],
    ["FB Shared Image", 1200, 630, "px", 0],
    ["FB Event Image", 1920, 1080, "px", 0],
    ["FB Group Header", 1640, 856, "px", 0],
    ["Instagram", 1080, 1080, "px", 0],
    ["Insta Story", 1080, 1920, "px", 0],
    ["Youtube Profile", 800, 800, "px", 0],
    ["Youtube Cover", 2560, 1440, "px", 0],
    ["Twitter Profile", 400, 400, "px", 0],
    ["Twitter Header", 1500, 500, "px", 0]
  ]
}, {
  name: "properties.presetCategory.ads",
  presetRows: [
    ["Small Square", 200, 200, "px", 0],
    ["Square", 250, 250, "px", 0],
    ["Medium Rect", 300, 250, "px", 0],
    ["Large Rect", 336, 280, "px", 0],
    ["Mobile Leaderboard", 320, 50, "px", 0],
    ["Large Mobile", 320, 100, "px", 0],
    ["Banner", 468, 60, "px", 0],
    ["Leaderboard", 728, 90, "px", 0],
    ["Large Leaderboard", 970, 90, "px", 0],
    ["Billboard", 970, 250, "px", 0],
    ["Vertical Rect", 240, 400, "px", 0],
    ["Skyscraper", 120, 600, "px", 0],
    ["Wide Skyscraper", 160, 600, "px", 0],
    ["Half Page", 300, 600, "px", 0],
    ["Portrait", 300, 1050, "px", 0]
  ]
}, {
  name: "properties.shapeType.square",
  presetRows: [
    [null, 16, 16, "px", 0],
    [null, 32, 32, "px", 0],
    [null, 64, 64, "px", 0],
    [null, 128, 128, "px", 0],
    [null, 256, 256, "px", 0],
    [null, 512, 512, "px", 0],
    [null, 1024, 1024, "px", 0],
    [null, 2048, 2048, "px", 0],
    [null, 4096, 4096, "px", 0]
  ]
}];

const NEW_DOC_BACKGROUND_FILL_MODES = ["Wht", "Trns", "BckC"];
const NEW_DOC_DEFAULT_BACKGROUND_COLOR = 16777215;
const NEW_DOC_CATEGORY_SIDEBAR_WIDTH_PX = 148;
const NEW_DOC_SETTINGS_PANEL_WIDTH_PX = 304;

function formatNewDocSettingsLabel(labelKey, fallbackText) {
  const resolved = Locale.get(labelKey);
  const labelText = resolved != null && resolved !== "" ? resolved : fallbackText;
  return labelText.replace(/:$/, "");
}

/**
 * Restack width / height / resolution controls to match the New Document sidebar:
 * equal-width value fields, units beside width/resolution, and orientation toggles.
 */
function createNewDocOrientationButton(orientationKind) {
  const button = makeElement("button", "new-doc-orientation-btn");
  button.setAttribute("type", "button");
  button.setAttribute(
    "title",
    orientationKind === "portrait"
      ? formatNewDocSettingsLabel("properties.orientationPortrait", "Portrait")
      : formatNewDocSettingsLabel("properties.orientationLandscape", "Landscape")
  );
  const iconEl = makeElement("span", "new-doc-orientation-icon new-doc-orientation-icon--" + orientationKind);
  button.appendChild(iconEl);
  return button;
}

function applyNewDocUnitDropdownLabels(unitDropdown) {
  const displayLabels = [
    Locale.get("properties.drawMode.pixels"),
    Locale.get("properties.units.percent"),
    Locale.get("properties.units.millimeters"),
    Locale.get("properties.units.inches"),
  ];
  const optionElements = unitDropdown.selectEl.options;
  for (let optionIdx = 0; optionIdx < optionElements.length && optionIdx < displayLabels.length; optionIdx++) {
    optionElements[optionIdx].textContent = displayLabels[optionIdx];
  }
}

function clearNewDocNumericInputStyle(numberInput) {
  numberInput.inputEl.style.width = "100%";
  numberInput.inputEl.style.boxSizing = "border-box";
}

function installNewDocSizeOptionLayout(sizeOption, dialog) {
  const root = sizeOption.el;
  if (root.getAttribute("data-new-doc-layout") === "1") return;
  root.setAttribute("data-new-doc-layout", "1");
  root.classList.add("new-doc-size-fields");

  const widthField = makeElement("div", "new-doc-field");
  const widthControls = makeElement("div", "new-doc-control-row new-doc-control-row--paired");
  const heightOrientationRow = makeElement("div", "new-doc-size-row--height-orientation");
  const heightColumn = makeElement("div", "new-doc-field");
  const heightControls = makeElement("div", "new-doc-control-row new-doc-control-row--value");
  const orientationColumn = makeElement("div", "new-doc-field new-doc-field--orientation");
  const orientationButtons = makeElement("div", "new-doc-orientation-buttons");
  const resolutionField = makeElement("div", "new-doc-field");
  const resolutionControls = makeElement("div", "new-doc-control-row new-doc-control-row--paired");

  addClass(sizeOption.widthInput.quantityLabelEl, "new-doc-field-label");
  addClass(sizeOption.heightInput.quantityLabelEl, "new-doc-field-label");
  addClass(sizeOption.dpiInput.quantityLabelEl, "new-doc-field-label");

  widthField.appendChild(sizeOption.widthInput.quantityLabelEl);
  widthControls.appendChild(sizeOption.widthInput.inputEl);
  widthControls.appendChild(sizeOption.unitDropdown.el);
  widthField.appendChild(widthControls);

  heightColumn.appendChild(sizeOption.heightInput.quantityLabelEl);
  heightControls.appendChild(sizeOption.heightInput.inputEl);
  heightColumn.appendChild(heightControls);

  const orientationLabelEl = makeElement("span", "new-doc-field-label");
  orientationLabelEl.textContent = formatNewDocSettingsLabel("properties.orientation", "Orientation");
  orientationColumn.appendChild(orientationLabelEl);
  dialog.portraitOrientationButton = createNewDocOrientationButton("portrait");
  dialog.landscapeOrientationButton = createNewDocOrientationButton("landscape");
  dialog.portraitOrientationButton.addEventListener("click", dialog.onPortraitOrientationClick.bind(dialog));
  dialog.landscapeOrientationButton.addEventListener("click", dialog.onLandscapeOrientationClick.bind(dialog));
  orientationButtons.appendChild(dialog.portraitOrientationButton);
  orientationButtons.appendChild(dialog.landscapeOrientationButton);
  orientationColumn.appendChild(orientationButtons);
  heightOrientationRow.appendChild(heightColumn);
  heightOrientationRow.appendChild(orientationColumn);

  sizeOption.dpiInput.quantityLabelEl.textContent = formatNewDocSettingsLabel(
    "properties.resolution",
    "Resolution"
  );
  resolutionField.appendChild(sizeOption.dpiInput.quantityLabelEl);
  resolutionControls.appendChild(sizeOption.dpiInput.inputEl);
  const resolutionUnitSelect = makeElement("select", "bbtn new-doc-unit-select");
  resolutionUnitSelect.setAttribute("aria-label", Locale.get("properties.resolutionUnits"));
  const resolutionUnitOption = makeElement("option");
  resolutionUnitOption.textContent = Locale.get("properties.pixelsPerInch");
  resolutionUnitSelect.appendChild(resolutionUnitOption);
  resolutionUnitSelect.disabled = true;
  resolutionControls.appendChild(resolutionUnitSelect);
  resolutionField.appendChild(resolutionControls);

  clearNewDocNumericInputStyle(sizeOption.widthInput);
  clearNewDocNumericInputStyle(sizeOption.heightInput);
  clearNewDocNumericInputStyle(sizeOption.dpiInput);

  clearElement(root);
  root.appendChild(widthField);
  root.appendChild(heightOrientationRow);
  root.appendChild(resolutionField);
}

function applyNewDocSettingsFieldLabels(dialog) {
  dialog.newDocumentNameField.quantityLabelEl.textContent = formatNewDocSettingsLabel(
    "properties.name",
    "Name"
  );
  addClass(dialog.newDocumentNameField.quantityLabelEl, "new-doc-field-label");

  dialog.backgroundFillDropdown.labelEl.textContent = formatNewDocSettingsLabel(
    "dialogs.newProjectBackground",
    "Background Contents"
  );
  addClass(dialog.backgroundFillDropdown.labelEl, "new-doc-field-label");

  dialog.sizeOption.widthInput.quantityLabelEl.textContent = formatNewDocSettingsLabel(
    "properties.width",
    "Width"
  );
  dialog.sizeOption.heightInput.quantityLabelEl.textContent = formatNewDocSettingsLabel(
    "properties.height",
    "Height"
  );
}

function installNewDocBackgroundLayout(dialog) {
  const dropdown = dialog.backgroundFillDropdown;
  const swatch = dialog.backgroundColorSwatch;
  if (dropdown.el.getAttribute("data-new-doc-layout") === "1") return;
  dropdown.el.setAttribute("data-new-doc-layout", "1");

  const fieldEl = makeElement("div", "new-doc-field new-doc-field--background");
  const controlsEl = makeElement("div", "new-doc-control-row new-doc-control-row--background");
  fieldEl.appendChild(dropdown.labelEl);
  controlsEl.appendChild(dropdown.selectEl);
  controlsEl.appendChild(swatch.el);
  fieldEl.appendChild(controlsEl);
  clearElement(dropdown.el);
  dropdown.el.appendChild(fieldEl);
}

function resolveNewDocBackgroundFillMode(fillIndex) {
  return NEW_DOC_BACKGROUND_FILL_MODES[fillIndex] || NEW_DOC_BACKGROUND_FILL_MODES[0];
}

/**
 * Human-readable size label for a preset row `[label, width, height, unit, dpi]`.
 */
function formatPresetMenuLabel(presetRow) {
  let presetLabel = presetRow[1] + " x " + presetRow[2] + " " + presetRow[3];
  if (presetRow[3] == "in") {
    presetLabel = (presetRow[1] * 25.4).toFixed(0) + " x " + (presetRow[2] * 25.4).toFixed(0) + " mm";
  }
  if (presetRow[3] == "mm") {
    presetLabel = (presetRow[1] / 25.4).toFixed(1) + " x " + (presetRow[2] / 25.4).toFixed(1) + " in";
  }
  if (presetRow[4]) presetLabel = presetLabel + " @ " + presetRow[4] + " ppi";
  return presetLabel;
}

/**
 * Convert a preset row's unit-relative dimensions to pixels.
 */
function resolvePresetPixelDimensions(presetRow) {
  let dpi = presetRow[4];
  if (dpi == 0) dpi = 72;
  const unitIndex = ["px", "%", "mm", "in"].indexOf(presetRow[3]);
  const unitScale = [1, 1, 25.4 / dpi, 1 / dpi][unitIndex];
  return {
    width: Math.round(presetRow[1] / unitScale),
    height: Math.round(presetRow[2] / unitScale),
    dpi: dpi,
    unitIndex: unitIndex
  };
}

/** @returns {Array<{ name: string, presetRows: Array, isRecent?: boolean }>} */
function buildDocumentPresetCategories() {
  const recentPresets = getRecentDocumentPresets();
  const categories = [{
    name: "properties.presetCategory.recent",
    isRecent: true,
    presetRows: recentPresets.map(recentDocumentPresetToPresetRow)
  }];
  for (let categoryIdx = 0; categoryIdx < DOCUMENT_PRESET_CATEGORIES.length; categoryIdx++) {
    categories.push(DOCUMENT_PRESET_CATEGORIES[categoryIdx]);
  }
  return categories;
}

function resolveCategoryLabel(category) {
  const resolved = Locale.get(category.name);
  return resolved != null && resolved !== "" ? resolved : category.name;
}

function NewProjectDialog() {
  BaseDialog.call(this, "dialogs.newProject", "newproject");
  this.data = null;
  this.openContextDocumentList = null;
  this.activeCategoryIndex = 0;
  this.presetCategories = [];
  this.categoryButtons = [];

  const layoutRowEl = makeElement("div", "flexrow new-doc-dialog");
  this.mainLayoutFlexRow = layoutRowEl;
  this.body.appendChild(layoutRowEl);

  this.categorySidebarEl = makeElement("nav", "new-doc-categories");
  layoutRowEl.appendChild(this.categorySidebarEl);

  this.presetPanelEl = makeElement("section", "new-doc-presets");
  layoutRowEl.appendChild(this.presetPanelEl);
  this.presetSectionHeadingEl = makeElement("h2", "new-doc-presets-heading");
  this.presetPanelEl.appendChild(this.presetSectionHeadingEl);
  this.presetDimensionMenuList = new MenuList(true);
  this.presetDimensionMenuList.on(EventType.widgetSelect, this.applyChosenPresetDimensions, this);
  this.presetPanelEl.appendChild(this.presetDimensionMenuList.el);
  this.presetEmptyStateEl = makeElement("p", "new-doc-presets-empty");
  this.presetEmptyStateEl.hidden = true;
  this.presetPanelEl.appendChild(this.presetEmptyStateEl);

  const settingsPanelEl = makeElement("aside", "new-doc-settings");
  this.settingsPanelEl = settingsPanelEl;
  layoutRowEl.appendChild(settingsPanelEl);

  this.settingsHeadingEl = makeElement("h2", "new-doc-settings-heading");
  settingsPanelEl.appendChild(this.settingsHeadingEl);

  const settingsFieldsEl = makeElement("div", "new-doc-settings-fields");
  settingsPanelEl.appendChild(settingsFieldsEl);

  const nameGroupEl = makeElement("div", "new-doc-settings-group");
  settingsFieldsEl.appendChild(nameGroupEl);
  this.newDocumentNameField = new TextInput("properties.name");
  nameGroupEl.appendChild(this.newDocumentNameField.el);

  const sizeGroupEl = makeElement("div", "new-doc-settings-group new-doc-settings-group--size");
  settingsFieldsEl.appendChild(sizeGroupEl);
  this.sizeOption = new LayerEffectOption(true);
  this.sizeOption.setValue(new Point(1280, 720), 72);
  this.sizeOptionWrapperEl = makeElement("div", "new-doc-size-option");
  this.sizeOptionWrapperEl.appendChild(this.sizeOption.el);
  sizeGroupEl.appendChild(this.sizeOptionWrapperEl);

  const backgroundGroupEl = makeElement("div", "new-doc-settings-group");
  settingsFieldsEl.appendChild(backgroundGroupEl);
  this.backgroundFillDropdown = new Dropdown("properties.background", [
    "colour.labels.white",
    "colour.labels.transparent",
    "properties.custom"
  ]);
  this.backgroundFillDropdown.on(EventType.widgetSelect, this.onBackgroundFillChanged, this);
  this.backgroundColorSwatch = new ColorSampleWidget(true);
  this.backgroundColorSwatch.parent = this;
  this.backgroundColorSwatch.setPackedRgb(NEW_DOC_DEFAULT_BACKGROUND_COLOR);
  this.backgroundColorSwatch.on(EventType.widgetSelect, this.onBackgroundColorPicked, this);
  backgroundGroupEl.appendChild(this.backgroundFillDropdown.el);

  const settingsActionsEl = makeElement("div", "new-doc-settings-actions");
  settingsPanelEl.appendChild(settingsActionsEl);
  this.confirmCreateDocumentButton = new Button("properties.create", true, null, true);
  this.confirmCreateDocumentButton.on("click", this.onOK, this);
  settingsActionsEl.appendChild(this.confirmCreateDocumentButton.el);

  this.enableUserResize({
    width: 960,
    height: 580,
    minWidth: 860,
    minHeight: 520
  });
}
NewProjectDialog.prototype = Object.create(BaseDialog.prototype);
NewProjectDialog.prototype.constructor = NewProjectDialog;

NewProjectDialog.prototype.getOffset = function(dialogWidth, dialogHeight) {
  return new Point(
    Math.max(0, (dialogWidth - 960) / 2),
    Math.max(0, (dialogHeight - 580) / 2)
  );
};

NewProjectDialog.prototype.resize = function(dialogWidth, dialogHeight) {
  const bodyHeight = Math.max(360, dialogHeight - 40);
  this.categorySidebarEl.setAttribute(
    "style",
    "width:" + NEW_DOC_CATEGORY_SIDEBAR_WIDTH_PX + "px; min-height:" + bodyHeight + "px;"
  );
  this.settingsPanelEl.setAttribute(
    "style",
    "width:" + NEW_DOC_SETTINGS_PANEL_WIDTH_PX + "px; min-height:" + bodyHeight + "px;"
  );
  const presetPanelWidth = Math.max(
    280,
    dialogWidth - NEW_DOC_CATEGORY_SIDEBAR_WIDTH_PX - NEW_DOC_SETTINGS_PANEL_WIDTH_PX - 32
  );
  this.presetPanelEl.setAttribute(
    "style",
    "width:" + presetPanelWidth + "px; min-height:" + bodyHeight + "px;"
  );
  this.presetDimensionMenuList.el.style.height = Math.max(240, bodyHeight - 48) + "px";
};

NewProjectDialog.prototype.rebuildCategorySidebar = function() {
  this.presetCategories = buildDocumentPresetCategories();
  clearElement(this.categorySidebarEl);
  this.categoryButtons = [];
  for (let categoryIdx = 0; categoryIdx < this.presetCategories.length; categoryIdx++) {
    const categoryButton = makeElement("button", "new-doc-category-btn");
    categoryButton.setAttribute("type", "button");
    categoryButton.textContent = resolveCategoryLabel(this.presetCategories[categoryIdx]);
    categoryButton.addEventListener("click", this.onCategoryButtonClick.bind(this, categoryIdx));
    this.categorySidebarEl.appendChild(categoryButton);
    this.categoryButtons.push(categoryButton);
  }
  if (this.activeCategoryIndex >= this.presetCategories.length) {
    this.activeCategoryIndex = 0;
  }
  this.highlightActiveCategoryButton();
};

NewProjectDialog.prototype.onCategoryButtonClick = function(categoryIndex) {
  this.activeCategoryIndex = categoryIndex;
  this.highlightActiveCategoryButton();
  this.refreshPresetMenuThumbnailsList();
};

NewProjectDialog.prototype.highlightActiveCategoryButton = function() {
  for (let buttonIdx = 0; buttonIdx < this.categoryButtons.length; buttonIdx++) {
    if (buttonIdx === this.activeCategoryIndex) {
      addClass(this.categoryButtons[buttonIdx], "active");
    } else {
      removeClass(this.categoryButtons[buttonIdx], "active");
    }
  }
};

NewProjectDialog.prototype.getActivePresetCategory = function() {
  return this.presetCategories[this.activeCategoryIndex];
};

NewProjectDialog.prototype.applyRecentDocumentPreset = function(snapshot) {
  this.newDocumentNameField.setValue(snapshot.name);
  this.sizeOption.setValue(new Point(snapshot.width, snapshot.height), snapshot.dpi);
  this.sizeOption.setUnitIndex(snapshot.unitIndex);
  this.backgroundFillDropdown.setValue(snapshot.backgroundFillIndex);
  if (typeof snapshot.backgroundColorPacked === "number") {
    this.backgroundColorSwatch.setPackedRgb(snapshot.backgroundColorPacked);
  }
  this.syncBackgroundSwatchPreview();
  this.syncNewDocOrientationButtons();
};

NewProjectDialog.prototype.syncBackgroundSwatchPreview = function() {
  const fillIndex = this.backgroundFillDropdown.getValue();
  if (fillIndex === 1) {
    addClass(this.backgroundColorSwatch.el, "new-doc-background-swatch--transparent");
    return;
  }
  removeClass(this.backgroundColorSwatch.el, "new-doc-background-swatch--transparent");
  if (fillIndex === 0) {
    this.backgroundColorSwatch.setPackedRgb(NEW_DOC_DEFAULT_BACKGROUND_COLOR);
  }
};

NewProjectDialog.prototype.onBackgroundFillChanged = function() {
  this.syncBackgroundSwatchPreview();
};

NewProjectDialog.prototype.onBackgroundColorPicked = function() {
  if (this.backgroundFillDropdown.getValue() !== 2) {
    this.backgroundFillDropdown.setValue(2);
  }
  removeClass(this.backgroundColorSwatch.el, "new-doc-background-swatch--transparent");
};

NewProjectDialog.prototype.syncNewDocOrientationButtons = function() {
  if (this.portraitOrientationButton == null || this.landscapeOrientationButton == null) return;
  const sizePoint = this.sizeOption.getValue();
  const portraitActive = sizePoint.y >= sizePoint.x;
  if (portraitActive) {
    addClass(this.portraitOrientationButton, "active");
    removeClass(this.landscapeOrientationButton, "active");
  } else {
    removeClass(this.portraitOrientationButton, "active");
    addClass(this.landscapeOrientationButton, "active");
  }
};

NewProjectDialog.prototype.onPortraitOrientationClick = function() {
  const sizePoint = this.sizeOption.getValue();
  if (sizePoint.x > sizePoint.y) this.sizeOption.onSwapDimensionsClick();
  this.syncNewDocOrientationButtons();
};

NewProjectDialog.prototype.onLandscapeOrientationClick = function() {
  const sizePoint = this.sizeOption.getValue();
  if (sizePoint.y > sizePoint.x) this.sizeOption.onSwapDimensionsClick();
  this.syncNewDocOrientationButtons();
};

NewProjectDialog.prototype.applyChosenPresetDimensions = function() {
  const presetIndex = this.presetDimensionMenuList.getValue();
  const activeCategory = this.getActivePresetCategory();
  if (activeCategory == null) return;
  if (activeCategory.isRecent) {
    const recentPresets = getRecentDocumentPresets();
    if (recentPresets[presetIndex]) {
      this.applyRecentDocumentPreset(recentPresets[presetIndex]);
      this.presetDimensionMenuList.highlightRowAtIndex(presetIndex);
    }
    return;
  }
  const presetRow = activeCategory.presetRows[presetIndex];
  const resolved = resolvePresetPixelDimensions(presetRow);
  this.sizeOption.setValue(new Point(resolved.width, resolved.height), resolved.dpi);
  this.sizeOption.setUnitIndex(resolved.unitIndex);
  this.presetDimensionMenuList.highlightRowAtIndex(presetIndex);
  this.syncNewDocOrientationButtons();
};

NewProjectDialog.prototype.refreshPresetMenuThumbnailsList = function() {
  const activeCategory = this.getActivePresetCategory();
  if (activeCategory == null) return;
  const presetRows = activeCategory.presetRows;
  this.presetSectionHeadingEl.textContent = resolveCategoryLabel(activeCategory);
  if (activeCategory.isRecent && presetRows.length === 0) {
    this.presetEmptyStateEl.textContent = Locale.get("dialogs.newProjectRecentEmpty");
    this.presetEmptyStateEl.hidden = false;
    this.presetDimensionMenuList.el.hidden = true;
    return;
  }
  this.presetEmptyStateEl.hidden = true;
  this.presetDimensionMenuList.el.hidden = false;
  const thumbnailDataUrls = [];
  const presetLabels = [];
  const thumbWidth = Math.round(106 * getDevicePixelRatio());
  const thumbHeight = Math.round(106 * getDevicePixelRatio());
  let maxPresetDimension = 0;
  for (let presetIdx = 0; presetIdx < presetRows.length; presetIdx++) {
    maxPresetDimension = Math.max(maxPresetDimension, presetRows[presetIdx][1], presetRows[presetIdx][2]);
  }
  for (let presetIdx = 0; presetIdx < presetRows.length; presetIdx++) {
    const presetRow = presetRows[presetIdx];
    presetLabels.push(formatPresetMenuLabel(presetRow));
    thumbnailDataUrls.push(
      NewProjectDialog.buildPresetThumbnailDataUrl(presetRow, thumbWidth, thumbHeight, maxPresetDimension)
    );
  }
  this.presetDimensionMenuList.setThumbnailGrid(thumbnailDataUrls, presetLabels, thumbWidth, thumbHeight);
};

NewProjectDialog.buildPresetThumbnailDataUrl = function(presetRow, thumbWidth, thumbHeight, maxPresetDimension) {
  const canvas = makeElement("canvas", "");
  const ctx = canvas.getContext("2d");
  canvas.width = thumbWidth;
  canvas.height = thumbHeight;
  const bottomMargin = Math.round(thumbWidth / 8);
  const labelFontSize = Math.floor(11 * getDevicePixelRatio());
  const presetWidth = presetRow[1];
  const presetHeight = presetRow[2];
  ctx.fillStyle = "#000000";
  ctx.font = Math.round(labelFontSize * 0.9) + "px \"Open Sans\", Sans-Serif";
  const dimensionLabel = presetWidth + " x " + presetHeight + " " + presetRow[3];
  const labelMetrics = ctx.measureText(dimensionLabel);
  ctx.fillText(
    dimensionLabel,
    Math.round((thumbWidth - labelMetrics.width) / 2),
    thumbHeight - Math.round(bottomMargin / 2)
  );
  if (presetRow[0] != null) {
    ctx.font = "bold " + labelFontSize + "px \"Open Sans\", Sans-Serif";
    const titleLabel = presetRow[0];
    const titleMetrics = ctx.measureText(titleLabel);
    ctx.fillText(
      titleLabel,
      Math.round((thumbWidth - titleMetrics.width) / 2),
      thumbHeight - Math.round(bottomMargin / 2) - Math.round(labelFontSize * 1.3)
    );
  }
  let drawableHeight = thumbHeight - Math.round(2.5 * labelFontSize);
  let thumbScale = Math.min(
    (thumbWidth - bottomMargin) / presetWidth,
    (drawableHeight - bottomMargin) / presetHeight
  );
  thumbScale *= 0.5 + 0.5 * (Math.max(presetWidth, presetHeight) / maxPresetDimension);
  const thumbOffsetX = (thumbWidth - presetWidth * thumbScale) / 2;
  const thumbOffsetY = (drawableHeight - presetHeight * thumbScale) / 2;
  ctx.strokeRect(
    Math.round(thumbOffsetX) + 0.5,
    Math.round(thumbOffsetY) + 0.5,
    Math.round(presetWidth * thumbScale),
    Math.round(presetHeight * thumbScale)
  );
  return canvas.toDataURL();
};

NewProjectDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.settingsHeadingEl.textContent = formatNewDocSettingsLabel(
    "dialogs.newProjectDetails",
    "Preset Details"
  );
  this.sizeOption.buildUI();
  this.newDocumentNameField.buildUI();
  this.backgroundFillDropdown.buildUI();
  this.backgroundColorSwatch.buildUI();
  this.confirmCreateDocumentButton.buildUI();
  applyNewDocSettingsFieldLabels(this);
  installNewDocSizeOptionLayout(this.sizeOption, this);
  applyNewDocUnitDropdownLabels(this.sizeOption.unitDropdown);
  installNewDocBackgroundLayout(this);
  this.syncBackgroundSwatchPreview();
  this.sizeOption.on(EventType.widgetSelect, this.syncNewDocOrientationButtons, this);
  this.syncNewDocOrientationButtons();
  this.newDocumentNameField.setValue(Locale.get("dialogs.newProject"));
};

NewProjectDialog.prototype.captureRecentDocumentPresetSnapshot = function() {
  const sizePoint = this.sizeOption.getValue();
  const unitIndex = this.sizeOption.unitDropdown.getValue();
  const unitLabels = ["px", "%", "mm", "in"];
  return {
    name: this.newDocumentNameField.getValue(),
    width: sizePoint.x,
    height: sizePoint.y,
    dpi: this.sizeOption.getDpi(),
    unitIndex: unitIndex,
    unit: unitLabels[unitIndex] || "px",
    unitWidth: parseFloat(this.sizeOption.widthInput.getValue()),
    unitHeight: parseFloat(this.sizeOption.heightInput.getValue()),
    backgroundFillIndex: this.backgroundFillDropdown.getValue(),
    backgroundColorPacked:
      this.backgroundFillDropdown.getValue() === 2
        ? this.backgroundColorSwatch.getPackedRgb()
        : null,
    label: this.newDocumentNameField.getValue(),
    usedAt: Date.now()
  };
};

NewProjectDialog.prototype.onOK = function() {
  const sizePoint = this.sizeOption.getValue();
  const snapshot = this.captureRecentDocumentPresetSnapshot();
  const fillIndex = this.backgroundFillDropdown.getValue();
  const fillMode = resolveNewDocBackgroundFillMode(fillIndex);
  this.close();
  recordRecentDocumentPreset(snapshot);
  const makeDocEvent = new AppEvent(EventType.historyGrouped, true);
  makeDocEvent.data = Document.buildMakeDocumentEvent(
    sizePoint.x,
    sizePoint.y,
    this.sizeOption.getDpi(),
    this.newDocumentNameField.getValue(),
    fillMode
  );
  if (fillMode === "BckC") {
    makeDocEvent.data.backgroundColorPacked = this.backgroundColorSwatch.getPackedRgb();
  }
  this.dispatch(makeDocEvent);
};

NewProjectDialog.prototype.open = function(currentDoc, dialogPayload, openDocs) {
  this.openContextDocumentList = openDocs;
  if (currentDoc != null && currentDoc.selectionMask != null) {
    const selectionRect = new Rect(0, 0, currentDoc.width, currentDoc.height).intersect(
      currentDoc.selectionMask.rect
    );
    this.sizeOption.setValue(new Point(selectionRect.width, selectionRect.height));
  }
  this.data = dialogPayload;
  this.rebuildCategorySidebar();
  this.refreshPresetMenuThumbnailsList();
  const dialog = this;
  loadRecentDocumentPresetsFromStore().then(function() {
    dialog.rebuildCategorySidebar();
    dialog.refreshPresetMenuThumbnailsList();
  });
  this.newDocumentNameField.focusAndSelectAll();
  FileLoader.readClipboardWithCallback(this, this.applyClipboardImageSizeToOption.bind(this));
};

NewProjectDialog.prototype.applyClipboardImageSizeToOption = function(callbackContext, clipboardImageSize) {
  this.sizeOption.setValue(new Point(clipboardImageSize.width, clipboardImageSize.height));
};

export {
  NewProjectDialog,
  DOCUMENT_PRESET_CATEGORIES,
  buildDocumentPresetCategories,
  formatPresetMenuLabel,
  resolvePresetPixelDimensions
};
