/**
 * Typography controls for the Character/Paragraph panels and type tool options.
 *
 * FontComboBox is the full editor — family, size, leading, tracking, scale,
 * baseline, fill color, character-style toggles (bold/italic/caps/…), alignment,
 * direction, and indent/spacing. FontNameInput is the family + subfamily picker
 * it embeds, with search, favorites, and local OTF/TTF loading. Both read and
 * write the text-engine style keys (FontSize, Leading, Tracking, Justification,
 * StartIndent, …) rather than PSD descriptors.
 */

import { ColorSampleWidget } from "./color-controls.js";
import { SliderDropdown } from "./number-inputs.js";
import { ButtonMenu } from "./popup-controls.js";
import { BaseWidget } from "../base-widget.js";
import { Button, Checkbox, TextInput } from "../form-controls.js";

import { KeyboardHandler } from "../../../core/keyboard-handler.js";
import { FontRegistry } from "../../../fonts/font-registry.js";
import { ToolId } from "../../../document/model/tool-base.js";
import { PopupTypes } from "../../config/popup-types.js";
import { TextEngineData } from "../../../features/text/text-engine.js";
import { getIconUrl, iconImgHtml } from "../../../assets/icon-registry.js";
import { EventType, UiCommand } from "../../../core/event-bus.js";
import { addClass, addPointerDownListener, cancel, getDevicePixelRatio, isInDOM, makeElement } from "../../../core/dom.js";
import { AppEvent } from "../../../core/event-bus.js";

const TEXT_FILL_VALUE_PRECISION = 1e3;

/** Text-engine FillColor object from a packed 0xRRGGBB integer. */
function packTextFillColorFromPackedRgb(packedRgb) {
  const fillColor = {
    Type: 1,
    Values: [
      1,
      (packedRgb >> 16 & 255) / 255,
      (packedRgb >> 8 & 255) / 255,
      (packedRgb >> 0 & 255) / 255
    ]
  };
  for (let channelIdx = 0; channelIdx < 4; channelIdx++) {
    fillColor.Values[channelIdx] =
      Math.round(fillColor.Values[channelIdx] * TEXT_FILL_VALUE_PRECISION) / TEXT_FILL_VALUE_PRECISION
  }
  return fillColor
}

function iconButtonHtml(iconPath) {
  return "<img src=\"" + getIconUrl(iconPath) + "\" class=\"autoscale gsicon\" />"
}

function indentIconHtml(iconKey) {
  return "<img src=\"" + getIconUrl("par/" + iconKey) + "\" class=\"autoscale gsicon\" /> "
}

function familyPassesListFilters(fontEntry, searchQueryLower, favoritesOnly, isFavorite) {
  if (searchQueryLower.length > 0 && fontEntry[0].toLowerCase().indexOf(searchQueryLower) == -1) return false;
  if (favoritesOnly && !isFavorite) return false;
  return true
}

// --- FontComboBox ------------------------------------------------------------

/**
 * Character + paragraph style editor. Holds a working copy of the current
 * text-style snapshot (`textStyle` + `paraStyle` + `fontSet`); every field edit
 * mutates that snapshot in place and calls `refresh()` to push it back to the
 * active text layer. Hosted by CharacterPanel, ParagraphPanel, and type options.
 */
function FontComboBox() {
  BaseWidget.call(this);
  this.fontNameInput = new FontNameInput();
  this.fontNameInput.on(EventType.widgetSelect, this.onFontFamilyChange, this);
  this.fontNameInput.parent = this;
  this.fontSizeInput = new SliderDropdown("properties.size.title", 1, 150, "px", 0, true);
  this.fontSizeInput.on(EventType.widgetSelect, this.onTypographyFieldChange, this);
  this.fontSizeInput.parent = this;
  this.leadingInput = new SliderDropdown("text.leading", 0.01, 100, "px", 2, true, null, 5);
  this.leadingInput.on(EventType.widgetSelect, this.onTypographyFieldChange, this);
  this.leadingInput.parent = this;
  this.autoLeadingCheckbox = new Checkbox("Auto");
  this.autoLeadingCheckbox.on(EventType.widgetSelect, this.onTypographyFieldChange, this);
  this.trackingInput = new SliderDropdown("text.tracking", -500, 5e3, "%", 0, true);
  this.trackingInput.on(EventType.widgetSelect, this.onTypographyFieldChange, this);
  this.trackingInput.parent = this;
  this.verticalScaleInput = new SliderDropdown("\u2B0D", 1, 300, "%", null, null, null, null, [
    "edit.scaleVar",
    "warp.orientation.vertically"
  ]);
  this.verticalScaleInput.on(EventType.widgetSelect, this.onTypographyFieldChange, this);
  this.verticalScaleInput.parent = this;
  this.horizontalScaleInput = new SliderDropdown("\u2B0C", 1, 300, "%", null, null, null, null, [
    "edit.scaleVar",
    "warp.orientation.horizontally"
  ]);
  this.horizontalScaleInput.on(EventType.widgetSelect, this.onTypographyFieldChange, this);
  this.horizontalScaleInput.parent = this;
  this.baselineShiftInput = new SliderDropdown("text.baselineShift", -10, 10, "px");
  this.baselineShiftInput.on(EventType.widgetSelect, this.onTypographyFieldChange, this);
  this.baselineShiftInput.parent = this;
  this.fillColorPicker = new ColorSampleWidget(true);
  this.fillColorPicker.on(EventType.widgetSelect, this.onFillColorChange, this);
  this.fillColorPicker.parent = this;
  this.installCharacterStyleButtons();
  this.installAlignmentButtons();
  this.installIndentControls();
  this.directionMenu = new ButtonMenu("properties.direction", ["Abc ...", "... \u0623\u064A \u0628\u064A"]);
  this.directionMenu.on(EventType.widgetSelect, this.onTypographyFieldChange, this);
  this.directionMenu.parent = this
}

FontComboBox.prototype = Object.create(BaseWidget.prototype);
FontComboBox.prototype.constructor = FontComboBox;

FontComboBox.prototype.installCharacterStyleButtons = function() {
  this.boldButton = new Button(iconButtonHtml("type/bold"));
  this.italicButton = new Button(iconButtonHtml("type/italic"));
  this.allCapsButton = new Button(iconButtonHtml("type/caps"));
  this.smallCapsButton = new Button(iconButtonHtml("type/scaps"));
  this.subscriptButton = new Button(iconButtonHtml("type/sub"));
  this.superscriptButton = new Button(iconButtonHtml("type/sup"));
  this.underlineButton = new Button(iconButtonHtml("type/under"));
  this.strikethroughButton = new Button(iconButtonHtml("type/strike"));
  const characterStyleButtons = [
    this.boldButton,
    this.italicButton,
    this.allCapsButton,
    this.smallCapsButton,
    this.subscriptButton,
    this.superscriptButton,
    this.underlineButton,
    this.strikethroughButton
  ];
  for (let buttonIdx = 0; buttonIdx < characterStyleButtons.length; buttonIdx++) {
    characterStyleButtons[buttonIdx].on("click", this.onCharacterStyleToggle, this)
  }
};

FontComboBox.prototype.installAlignmentButtons = function() {
  this.alignLeftButton = new Button(iconButtonHtml("par/left"));
  this.alignRightButton = new Button(iconButtonHtml("par/right"));
  this.alignCenterButton = new Button(iconButtonHtml("par/center"));
  this.justifyLeftButton = new Button(iconButtonHtml("par/jleft"));
  this.justifyRightButton = new Button(iconButtonHtml("par/jright"));
  this.justifyCenterButton = new Button(iconButtonHtml("par/jcenter"));
  this.justifyAllButton = new Button(iconButtonHtml("par/jall"));
  this.alignmentButtons = [
    this.alignLeftButton,
    this.alignRightButton,
    this.alignCenterButton,
    this.justifyLeftButton,
    this.justifyCenterButton,
    this.justifyRightButton,
    this.justifyAllButton
  ];
  for (let buttonIdx = 0; buttonIdx < this.alignmentButtons.length; buttonIdx++) {
    this.alignmentButtons[buttonIdx].on("click", this.onTypographyFieldChange, this)
  }
};

FontComboBox.prototype.installIndentControls = function() {
  const indentIconKeys = ["lind", "rind", "flind", "bind", "aind"],
    indentIcons = [];
  for (let iconIdx = 0; iconIdx < 5; iconIdx++) indentIcons.push(indentIconHtml(indentIconKeys[iconIdx]));
  this.startIndentInput = new SliderDropdown(indentIcons[0], -20, 20, "px");
  this.startIndentInput.on(EventType.widgetSelect, this.onTypographyFieldChange, this);
  this.startIndentInput.parent = this;
  this.endIndentInput = new SliderDropdown(indentIcons[1], -20, 20, "px");
  this.endIndentInput.on(EventType.widgetSelect, this.onTypographyFieldChange, this);
  this.endIndentInput.parent = this;
  this.firstLineIndentInput = new SliderDropdown(indentIcons[2], -20, 20, "px");
  this.firstLineIndentInput.on(EventType.widgetSelect, this.onTypographyFieldChange, this);
  this.firstLineIndentInput.parent = this;
  this.spaceBeforeInput = new SliderDropdown(indentIcons[3], -20, 20, "px");
  this.spaceBeforeInput.on(EventType.widgetSelect, this.onTypographyFieldChange, this);
  this.spaceBeforeInput.parent = this;
  this.spaceAfterInput = new SliderDropdown(indentIcons[4], -20, 20, "px");
  this.spaceAfterInput.on(EventType.widgetSelect, this.onTypographyFieldChange, this);
  this.spaceAfterInput.parent = this
};

FontComboBox.prototype.buildUI = function() {
  this.fontNameInput.buildUI();
  this.fontSizeInput.buildUI();
  this.leadingInput.buildUI();
  this.trackingInput.buildUI();
  this.baselineShiftInput.buildUI();
  this.verticalScaleInput.buildUI();
  this.horizontalScaleInput.buildUI();
  this.directionMenu.buildUI()
};

FontComboBox.prototype.setValue = function(textStyleSnapshot, fontRegistry, recentFamilies) {
  this.textStyleSnapshot = JSON.parse(JSON.stringify(textStyleSnapshot));
  let snapshot = this.textStyleSnapshot,
    textStyle = snapshot.textStyle,
    paraStyle = snapshot.paraStyle;
  this.boldButton.setValue(textStyle.FauxBold != null ? textStyle.FauxBold : false);
  this.italicButton.setValue(textStyle.FauxItalic != null ? textStyle.FauxItalic : false);
  this.allCapsButton.setValue(textStyle.FontCaps == 2);
  this.smallCapsButton.setValue(textStyle.FontCaps == 1);
  this.superscriptButton.setValue(textStyle.FontBaseline == 1);
  this.subscriptButton.setValue(textStyle.FontBaseline == 2);
  this.underlineButton.setValue(textStyle.Underline);
  this.strikethroughButton.setValue(textStyle.Strikethrough);
  this.fontNameInput.setValue(
    textStyle.Font == null ? null : snapshot.fontSet[textStyle.Font].Name,
    fontRegistry,
    recentFamilies
  );
  const fontSize = textStyle.FontSize == null ? 20 : textStyle.FontSize;
  this.fontSizeInput.setValue(fontSize);
  const tracking = textStyle.Tracking;
  this.trackingInput.setValue(tracking == null ? 0 : tracking);
  this.leadingInput.setValue(textStyle.Leading != null && textStyle.Leading != 0 ? textStyle.Leading : fontSize);
  this.autoLeadingCheckbox.setValue(textStyle.AutoLeading);
  this.verticalScaleInput.setValue((textStyle.VerticalScale != null ? textStyle.VerticalScale : 0) * 100);
  this.horizontalScaleInput.setValue((textStyle.HorizontalScale != null ? textStyle.HorizontalScale : 0) * 100);
  this.baselineShiftInput.setValue(textStyle.BaselineShift != null ? textStyle.BaselineShift : 0);
  if (textStyle.FillColor) {
    const fillRgb = TextEngineData.fillColorToRgb(textStyle);
    this.fillColorPicker.setPackedRgb(
      Math.round(fillRgb.h) << 16 | Math.round(fillRgb.l) << 8 | Math.round(fillRgb.O)
    )
  } else this.fillColorPicker.setPackedRgb(0);
  const textDirection = paraStyle._Direction != null ? paraStyle._Direction : 0,
    activeAlignmentIndex = TextEngineData.getJustification(paraStyle);
  for (let buttonIdx = 0; buttonIdx < this.alignmentButtons.length; buttonIdx++) {
    this.alignmentButtons[buttonIdx].setValue(activeAlignmentIndex == buttonIdx)
  }
  this.directionMenu.setValue(textDirection);
  this.startIndentInput.setValue(paraStyle.StartIndent != null ? paraStyle.StartIndent : 0);
  this.endIndentInput.setValue(paraStyle.EndIndent != null ? paraStyle.EndIndent : 0);
  this.firstLineIndentInput.setValue(paraStyle.FirstLineIndent != null ? paraStyle.FirstLineIndent : 0);
  this.spaceBeforeInput.setValue(paraStyle.SpaceBefore != null ? paraStyle.SpaceBefore : 0);
  this.spaceAfterInput.setValue(paraStyle.SpaceAfter != null ? paraStyle.SpaceAfter : 0)
};

FontComboBox.prototype.refresh = function() {
  const exportEvent = new AppEvent(EventType.uiDispatch, true);
  exportEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.EXPORT_AS,
    currentTextStyle: this.textStyleSnapshot
  };
  this.dispatch(exportEvent);
  const stylesEvent = new AppEvent(EventType.documentAction, true);
  stylesEvent.routingChannel = ToolId.TOOL_TYPE;
  stylesEvent.data = {
    actionKind: "updateStyles"
  };
  this.dispatch(stylesEvent)
};

FontComboBox.prototype.onCharacterStyleToggle = function(clickEvent) {
  const textStyle = this.textStyleSnapshot.textStyle,
    styleButton = clickEvent.target,
    pressed = !styleButton.isPressed();
  if (styleButton == this.boldButton) textStyle.FauxBold = pressed;
  if (styleButton == this.italicButton) textStyle.FauxItalic = pressed;
  if (styleButton == this.allCapsButton) textStyle.FontCaps = pressed ? 2 : 0;
  if (styleButton == this.smallCapsButton) textStyle.FontCaps = pressed ? 1 : 0;
  if (styleButton == this.superscriptButton) textStyle.FontBaseline = pressed ? 1 : 0;
  if (styleButton == this.subscriptButton) textStyle.FontBaseline = pressed ? 2 : 0;
  if (styleButton == this.underlineButton) textStyle.Underline = pressed;
  if (styleButton == this.strikethroughButton) textStyle.Strikethrough = pressed;
  this.refresh()
};

FontComboBox.prototype.onTypographyFieldChange = function(changeEvent) {
  const textStyle = this.textStyleSnapshot.textStyle,
    paraStyle = this.textStyleSnapshot.paraStyle,
    sourceWidget = changeEvent.target;
  if (sourceWidget == this.trackingInput) textStyle.Tracking = this.trackingInput.getValue();
  if (sourceWidget == this.leadingInput) {
    textStyle.AutoLeading = false;
    textStyle.Leading = this.leadingInput.getValue()
  }
  if (sourceWidget == this.autoLeadingCheckbox) textStyle.AutoLeading = this.autoLeadingCheckbox.getValue();
  if (sourceWidget == this.fontSizeInput) textStyle.FontSize = sourceWidget.getValue();
  if (sourceWidget == this.verticalScaleInput) textStyle.VerticalScale = sourceWidget.getValue() / 100;
  if (sourceWidget == this.horizontalScaleInput) textStyle.HorizontalScale = sourceWidget.getValue() / 100;
  if (sourceWidget == this.baselineShiftInput) textStyle.BaselineShift = sourceWidget.getValue();
  if (this.alignmentButtons.indexOf(sourceWidget) != -1) {
    paraStyle.Justification = TextEngineData.getJustification(
      paraStyle,
      this.alignmentButtons.indexOf(sourceWidget)
    )
  }
  if (sourceWidget == this.startIndentInput) paraStyle.StartIndent = sourceWidget.getValue();
  if (sourceWidget == this.endIndentInput) paraStyle.EndIndent = sourceWidget.getValue();
  if (sourceWidget == this.firstLineIndentInput) paraStyle.FirstLineIndent = sourceWidget.getValue();
  if (sourceWidget == this.spaceBeforeInput) paraStyle.SpaceBefore = sourceWidget.getValue();
  if (sourceWidget == this.spaceAfterInput) paraStyle.SpaceAfter = sourceWidget.getValue();
  if (sourceWidget == this.directionMenu) paraStyle._Direction = sourceWidget.getValue();
  this.refresh()
};

FontComboBox.prototype.onFontFamilyChange = function() {
  let snapshot = this.textStyleSnapshot,
    familyName = this.fontNameInput.getValue(),
    fontIndex = -1;
  for (let entryIdx = 0; entryIdx < snapshot.fontSet.length; entryIdx++) {
    if (snapshot.fontSet[entryIdx].Name == familyName) fontIndex = entryIdx
  }
  if (fontIndex == -1) {
    fontIndex = snapshot.fontSet.length;
    const newFontEntry = JSON.parse(JSON.stringify(snapshot.fontSet[0]));
    newFontEntry.Name = familyName;
    snapshot.fontSet.splice(fontIndex, 0, newFontEntry)
  }
  snapshot.textStyle.Font = fontIndex;
  this.refresh()
};

FontComboBox.prototype.onFillColorChange = function() {
  this.textStyleSnapshot.textStyle.FillColor = packTextFillColorFromPackedRgb(
    this.fillColorPicker.getPackedRgb()
  );
  this.refresh()
};

// --- FontNameInput -----------------------------------------------------------

/** Family / subfamily picker with search, favorites, and local font load. */
function FontNameInput() {
  BaseWidget.call(this);
  this.el = makeElement("span", "fontinput");
  this.registry = null;
  this.recentFamilies = null;
  this.selectedFamilyId = null;
  this.searchQueryLower = "";
  this.familyRowElementsById = {};
  this.visibleFamilyIds = [];
  this.familyRowStyleCache = {};
  this.skipScrollRestore = false;
  this.mountFamilyTrigger();
  this.mountFamilyPickerOverlay();
  this.mountSubfamilyPicker()
}

FontNameInput.prototype = Object.create(BaseWidget.prototype);
FontNameInput.prototype.constructor = FontNameInput;

FontNameInput.prototype.mountFamilyTrigger = function() {
  this.familyTriggerButton = makeElement("button", "fitem");
  this.familyTriggerButton.setAttribute("style", "width:9em;");
  this.familyTriggerButton.textContent = "Family Name";
  addClass(this.familyTriggerButton, "chevron");
  this.el.appendChild(this.familyTriggerButton);
  addPointerDownListener(this.familyTriggerButton, this.onPickerTriggerPointerDown.bind(this))
};

FontNameInput.prototype.mountFamilyPickerOverlay = function() {
  this.familyPickerOverlay = new BaseWidget();
  this.familyPickerOverlay.parent = this;
  this.familyPickerOverlay.el = makeElement("div", "floatcont");
  this.familyPickerOverlay.el.addEventListener("keyup", this.onFamilyPickerKeyup.bind(this), false);
  const toolbarEl = makeElement("div", "fontpicker-toolbar");
  this.familyPickerOverlay.el.appendChild(toolbarEl);
  this.favoritesOnlyButton = new Button(iconImgHtml("tools/cshape", null, "autoscale"), false, "Show Favorites Only");
  this.favoritesOnlyButton.on("click", this.onFavoritesOnlyToggle, this);
  toolbarEl.appendChild(this.favoritesOnlyButton.el);
  this.searchInput = new TextInput("properties.find", null, 9);
  this.searchInput.on("input", this.onSearchInput, this);
  toolbarEl.appendChild(this.searchInput.el);
  this.loadFontFileButton = new Button(
    ["history.loadVar", "warp.fontWarning.font"],
    false,
    "Load OTF / TTF file from your computer",
    true
  );
  this.loadFontFileButton.on("click", this.onLoadFontFileClick, this);
  toolbarEl.appendChild(this.loadFontFileButton.el);
  this.familyListEl = makeElement("div", "fontlist scrollable");
  this.familyListEl.style.height = "30em";
  this.familyPickerOverlay.el.appendChild(this.familyListEl)
};

FontNameInput.prototype.mountSubfamilyPicker = function() {
  this.subfamilyTriggerButton = makeElement("button", "fitem");
  this.subfamilyTriggerButton.setAttribute("style", "width:7em;");
  this.subfamilyTriggerButton.textContent = "SubFamily Name";
  addClass(this.subfamilyTriggerButton, "chevron");
  this.el.appendChild(this.subfamilyTriggerButton);
  addPointerDownListener(this.subfamilyTriggerButton, this.onPickerTriggerPointerDown.bind(this));
  this.subfamilyPickerOverlay = new BaseWidget();
  this.subfamilyPickerOverlay.parent = this;
  this.subfamilyPickerOverlay.el = makeElement("div", "floatcont");
  this.subfamilyListEl = makeElement("div", "fontlist scrollable");
  this.subfamilyPickerOverlay.el.appendChild(this.subfamilyListEl)
};

FontNameInput.prototype.onFamilyPickerKeyup = function(keyEvent) {
  let step = 0;
  if (KeyboardHandler.hasKeyCode(keyEvent.code, KeyboardHandler.ArrowUp)) step = -1;
  if (KeyboardHandler.hasKeyCode(keyEvent.code, KeyboardHandler.ArrowDown)) step = 1;
  if (step == 0) return;
  const visibleIds = this.visibleFamilyIds,
    visibleCount = visibleIds.length,
    currentSubfamily = this.registry.getCatalogMap()[this.selectedFamilyId];
  if (currentSubfamily == null && visibleCount == 0) return;
  let currentIdx = visibleIds.indexOf(currentSubfamily[0]);
  if (currentIdx == -1) return;
  currentIdx = (currentIdx + step + visibleCount) % visibleCount;
  this.applyFamilySelection(visibleIds[currentIdx], null)
};

FontNameInput.prototype.onLoadFontFileClick = function() {
  const pickEvent = new AppEvent(EventType.uiDispatch, true);
  pickEvent.data = {
    dispatchKind: UiCommand.pickLocalFiles,
    fileAccept: ".otf,.ttf,.ttc"
  };
  this.dispatch(pickEvent)
};

FontNameInput.prototype.buildUI = function() {
  this.loadFontFileButton.buildUI();
  this.favoritesOnlyButton.setLabel(iconImgHtml("tools/cshape", null, "autoscale"))
};

FontNameInput.prototype.onFavoritesOnlyToggle = function() {
  this.favoritesOnlyButton.setValue(!this.favoritesOnlyButton.isPressed());
  this.refreshFamilyList()
};

FontNameInput.prototype.onSearchInput = function() {
  this.searchQueryLower = this.searchInput.getValue().toLowerCase();
  this.refreshFamilyList()
};

FontNameInput.prototype.onPickerTriggerPointerDown = function(pointerEvent) {
  cancel(pointerEvent);
  const triggerEl = pointerEvent.currentTarget,
    triggerRect = triggerEl.getBoundingClientRect(),
    isFamilyTrigger = triggerEl == this.familyTriggerButton,
    overlayWidget = isFamilyTrigger ? this.familyPickerOverlay : this.subfamilyPickerOverlay;
  if (isInDOM(overlayWidget.el)) {
    this.closePickerOverlay(overlayWidget);
    return
  }
  if (!isFamilyTrigger && this.registry.getCatalogMap()[this.selectedFamilyId] == null) return;
  const showEvent = new AppEvent(EventType.uiDispatch, true);
  showEvent.data = {
    dispatchKind: UiCommand.showFloatingOverlay,
    overlayWidget: overlayWidget,
    x: triggerRect.left,
    y: triggerRect.top + triggerRect.height
  };
  this.dispatch(showEvent);
  if (isFamilyTrigger) {
    this.refreshFamilyList();
    this.searchInput.focusAndSelectAll()
  }
};

FontNameInput.prototype.onFamilyRowClick = function(clickEvent) {
  const familyName = clickEvent.currentTarget.firstChild.nextSibling.textContent;
  if (clickEvent.target.tagName.toLowerCase() == "button") {
    let favorites = this.recentFamilies.slice(0),
      favoriteIdx = favorites.indexOf(familyName);
    if (favoriteIdx == -1) {
      favorites = favorites.slice(Math.max(0, favorites.length - 29));
      favorites.push(familyName)
    } else favorites.splice(favoriteIdx, 1);
    const favoritesEvent = new AppEvent(EventType.uiDispatch, true);
    favoritesEvent.data = {
      dispatchKind: UiCommand.openResourcePresetPopup,
      popupType: PopupTypes.ABOUT,
      fontFavorites: favorites
    };
    this.dispatch(favoritesEvent);
    this.skipScrollRestore = true;
    this.refreshFamilyList()
  } else {
    this.applyFamilySelection(familyName, null);
    this.searchInput.focusAndSelectAll()
  }
};

FontNameInput.prototype.onSubfamilyRowClick = function(clickEvent) {
  this.applyFamilySelection(null, clickEvent.currentTarget.firstChild.textContent)
};

FontNameInput.prototype.applyFamilySelection = function(familyName, subfamilyName) {
  const overlayToClose = familyName == null ? this.subfamilyPickerOverlay : this.familyPickerOverlay,
    registry = this.registry;
  if (familyName == null) familyName = registry.getCatalogMap()[this.selectedFamilyId][0];
  else {
    const subfamilies = registry.getSubfamilyList(familyName),
      currentStyle = registry.getCatalogMap()[this.selectedFamilyId];
    subfamilyName = FontRegistry.findClosestStyle(subfamilies, currentStyle ? currentStyle[1] : "regular")
  }
  const fontPostScriptName = registry.lookupByFamilyStyle(familyName, subfamilyName)[2];
  this.setValue(fontPostScriptName, registry);
  this.dispatch(new AppEvent(EventType.widgetSelect, false));
  this.closePickerOverlay(overlayToClose);
  this.refreshFamilyList()
};

FontNameInput.prototype.closePickerOverlay = function(overlayWidget) {
  const closeEvent = new AppEvent(EventType.uiDispatch, true);
  closeEvent.data = {
    dispatchKind: UiCommand.closeFloatingOverlay,
    overlayWidget: overlayWidget
  };
  this.dispatch(closeEvent)
};

FontNameInput.prototype.getValue = function() {
  return this.selectedFamilyId
};

FontNameInput.prototype.setValue = function(fontPostScriptName, registry, recentFamilies) {
  if (fontPostScriptName != null) this.selectedFamilyId = fontPostScriptName;
  else fontPostScriptName = this.selectedFamilyId;
  this.registry = registry;
  if (recentFamilies != null) this.recentFamilies = recentFamilies;
  if (fontPostScriptName == null) return;
  const catalogEntry = registry.getCatalogMap()[fontPostScriptName];
  let familyLabel,
    subfamilyLabel;
  if (catalogEntry == null) {
    familyLabel = "- " + fontPostScriptName;
    subfamilyLabel = "-------"
  } else {
    familyLabel = catalogEntry[0];
    subfamilyLabel = catalogEntry[1];
    const subfamilyNames = registry.getSubfamilyList(familyLabel);
    subfamilyNames.sort(FontRegistry.compareByWeight);
    const onSubfamilyClick = this.onSubfamilyRowClick.bind(this);
    this.subfamilyListEl.textContent = "";
    for (let subfamilyIdx = 0; subfamilyIdx < subfamilyNames.length; subfamilyIdx++) {
      const fontEntry = registry.lookupByFamilyStyle(familyLabel, subfamilyNames[subfamilyIdx]);
      this.subfamilyListEl.appendChild(
        this.createFontListRow(fontEntry, fontEntry[1], onSubfamilyClick, false)
      )
    }
  }
  this.familyTriggerButton.textContent = familyLabel.substring(0, 15);
  this.familyTriggerButton.setAttribute("title", familyLabel);
  this.subfamilyTriggerButton.textContent = subfamilyLabel.substring(0, 10);
  this.subfamilyTriggerButton.setAttribute("title", subfamilyLabel)
};

FontNameInput.prototype.refreshFamilyList = function() {
  let currentEntry = this.registry.getCatalogMap()[this.selectedFamilyId],
    recentFamilies = this.recentFamilies || [],
    scrollTarget = null,
    subfamilyMap = this.registry.getSubfamilyMap(),
    onFamilyClick = this.onFamilyRowClick.bind(this),
    favoritesOnly = this.favoritesOnlyButton.isPressed();
  this.visibleFamilyIds = [];
  for (let familyId in subfamilyMap) {
    let defaultStyle = FontRegistry.findClosestStyle(subfamilyMap[familyId], "regular"),
      fontEntry = this.registry.lookupByFamilyStyle(familyId, defaultStyle),
      isFavorite = recentFamilies.indexOf(familyId) != -1,
      isVisible = familyPassesListFilters(fontEntry, this.searchQueryLower, favoritesOnly, isFavorite),
      familyRow = this.familyRowElementsById[familyId];
    if (familyRow == null) {
      familyRow = this.createFontListRow(fontEntry, familyId, onFamilyClick, true);
      this.familyRowElementsById[familyId] = familyRow;
      this.familyListEl.appendChild(familyRow)
    }
    if (isVisible) this.visibleFamilyIds.push(familyId);
    const isSelected = currentEntry != null && currentEntry[0] == familyId,
      rowDisplayStyle = isVisible ? "" : "display:none; ",
      starOpacityStyle = "opacity: " + (isFavorite ? "1" : "0.25"),
      rowStateKey = rowDisplayStyle + starOpacityStyle + isSelected;
    if (isSelected) scrollTarget = familyRow;
    if (this.familyRowStyleCache[familyId] != rowStateKey) {
      familyRow.setAttribute("style", rowDisplayStyle);
      familyRow.setAttribute("class", isSelected ? "fontitem selected" : "fontitem");
      familyRow.querySelector(".star").setAttribute("style", starOpacityStyle);
      this.familyRowStyleCache[familyId] = rowStateKey
    }
  }
  if (scrollTarget && !this.skipScrollRestore) this.familyListEl.scrollTop = scrollTarget.offsetTop - 210;
  this.skipScrollRestore = false
};

FontNameInput.prototype.createFontListRow = function(fontEntry, labelText, clickHandler, showFavoriteStar) {
  let rowEl = makeElement("div", "fontitem"),
    thumbStyle = "";
  rowEl.addEventListener("click", clickHandler, false);
  if (showFavoriteStar) rowEl.appendChild(makeElement("button", "star"));
  const labelEl = makeElement("span", "label");
  labelEl.setAttribute("title", labelText);
  labelEl.textContent = labelText;
  rowEl.appendChild(labelEl);
  const deviceRatio = getDevicePixelRatio(),
    cssScale = 1 / deviceRatio,
    thumbWidthCss = FontRegistry.THUMBNAIL_WIDTH * cssScale,
    thumbHeightCss = FontRegistry.THUMBNAIL_HEIGHT * cssScale;
  if (1 < deviceRatio && deviceRatio < 1.5) {
    thumbStyle = "width:" + thumbWidthCss + "px; height:" + thumbHeightCss + "px;"
  }
  // Each row previews the family name rendered in that font via CSS font-family,
  // so no preview sprite sheet is needed.
  const thumbEl = makeElement("span", "thumb");
  thumbEl.textContent = "Preview";
  thumbStyle += "background:none; background-image:none;";
  thumbStyle += "display:inline-block; overflow:hidden; white-space:nowrap;";
  thumbStyle += "font-family:" + JSON.stringify(labelText) + ";";
  thumbEl.setAttribute("style", thumbStyle);
  rowEl.appendChild(thumbEl);
  return rowEl
};

export {
  FontComboBox,
  FontNameInput,
  packTextFillColorFromPackedRgb,
  iconButtonHtml,
  indentIconHtml
};
