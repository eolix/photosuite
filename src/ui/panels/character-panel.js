/**
 * Character / Paragraph sidebar panels. Both host a FontComboBox; character
 * mode lays out typeface metrics and style toggles, paragraph mode lays out
 * alignment, indents, and spacing.
 *
 * The first refresh() after mount lazily builds the form and seeds it from
 * the active document text style.
 */
import { PopupTypes } from "../config/popup-types.js";
import { BaseTool } from "../widgets/base-tool.js";
import { FontComboBox } from "../widgets/controls/font-controls.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { isInDOM, makeElement } from "../../core/dom.js";

/**
 * @param {boolean} isCharacterMode true for Character panel, false for Paragraph
 */
function CharacterPanel(isCharacterMode) {
  BaseTool.call(
    this,
    isCharacterMode ? "panels.character" : "panels.paragraph",
    false,
    isCharacterMode ? getIconUrl("panels/character") : getIconUrl("panels/paragraph"),
    isCharacterMode ? BaseTool.PanelId.CHARACTER : BaseTool.PanelId.PARAGRAPH,
    true
  );
  this.panelBody.setAttribute("style", "min-width:240px;");
  this.isCharacterMode = isCharacterMode;
  this.fontBox = null;
  this.doc = null
}
CharacterPanel.prototype = Object.create(BaseTool.prototype);

CharacterPanel.prototype.buildFormLayout = function() {
  this.fontBox = new FontComboBox();
  this.fontBox.parent = this;
  if (this.isCharacterMode) appendCharacterForm(this.panelBody, this.fontBox);
  else appendParagraphForm(this.panelBody, this.fontBox)
};

CharacterPanel.prototype.refresh = function() {
  if (!isInDOM(this.panelBody)) return;
  if (this.fontBox == null) {
    this.buildFormLayout();
    seedFontBoxFromDoc(this.fontBox, this.doc);
    this.fontBox.buildUI()
  }
};

CharacterPanel.prototype.buildUI = function() {
  BaseTool.prototype.buildUI.call(this);
  if (this.fontBox) this.fontBox.buildUI()
};

CharacterPanel.prototype.onUpdate = function(doc, popupType) {
  this.doc = doc;
  if (!shouldSyncFontStyle(popupType)) return;
  if (this.fontBox) seedFontBoxFromDoc(this.fontBox, doc)
};

export { CharacterPanel };

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function shouldSyncFontStyle(popupType) {
  return popupType == PopupTypes.ALL
    || popupType == PopupTypes.EXPORT_AS
    || popupType == PopupTypes.OPEN_RECENT
    || popupType == PopupTypes.ABOUT
}

function seedFontBoxFromDoc(fontBox, doc) {
  if (!doc) return;
  fontBox.setValue(doc.currentTextStyle, doc.fontRegistry, doc.favoriteFontFamilies)
}

function appendCharacterForm(body, fontBox) {
  const fontRow = makeElement("div", "marged");
  body.appendChild(fontRow);
  fontRow.appendChild(fontBox.fontNameInput.el);
  body.appendChild(makeElement("hr"));
  const sizeRow = makeElement("div", "marged");
  body.appendChild(sizeRow);
  sizeRow.appendChild(fontBox.fontSizeInput.el);
  sizeRow.appendChild(fontBox.trackingInput.el);
  const spacingRow = makeElement("div", "marged");
  body.appendChild(spacingRow);
  spacingRow.appendChild(fontBox.leadingInput.el);
  spacingRow.appendChild(fontBox.autoLeadingCheckbox.el);
  body.appendChild(makeElement("hr"));
  const scaleRow = makeElement("div", "marged");
  body.appendChild(scaleRow);
  scaleRow.appendChild(fontBox.verticalScaleInput.el);
  scaleRow.appendChild(fontBox.horizontalScaleInput.el);
  const trackingRow = makeElement("div", "marged");
  body.appendChild(trackingRow);
  trackingRow.appendChild(fontBox.baselineShiftInput.el);
  trackingRow.appendChild(fontBox.fillColorPicker.el);
  body.appendChild(makeElement("hr"));
  const stylesRow = makeElement("div", "marged");
  body.appendChild(stylesRow);
  stylesRow.appendChild(fontBox.boldButton.el);
  stylesRow.appendChild(fontBox.italicButton.el);
  stylesRow.appendChild(fontBox.allCapsButton.el);
  stylesRow.appendChild(fontBox.smallCapsButton.el);
  stylesRow.appendChild(fontBox.superscriptButton.el);
  stylesRow.appendChild(fontBox.subscriptButton.el);
  stylesRow.appendChild(fontBox.underlineButton.el);
  stylesRow.appendChild(fontBox.strikethroughButton.el)
}

function appendParagraphForm(body, fontBox) {
  const alignRow = makeElement("div", "marged");
  body.appendChild(alignRow);
  alignRow.appendChild(fontBox.alignLeftButton.el);
  alignRow.appendChild(fontBox.alignCenterButton.el);
  alignRow.appendChild(fontBox.alignRightButton.el);
  alignRow.appendChild(fontBox.justifyLeftButton.el);
  alignRow.appendChild(fontBox.justifyCenterButton.el);
  alignRow.appendChild(fontBox.justifyRightButton.el);
  alignRow.appendChild(fontBox.justifyAllButton.el);
  body.appendChild(makeElement("hr"));
  const indentRow = makeElement("div", "marged");
  body.appendChild(indentRow);
  indentRow.appendChild(fontBox.startIndentInput.el);
  indentRow.appendChild(fontBox.endIndentInput.el);
  indentRow.appendChild(fontBox.firstLineIndentInput.el);
  body.appendChild(makeElement("hr"));
  const spaceRow = makeElement("div", "marged");
  body.appendChild(spaceRow);
  spaceRow.appendChild(fontBox.spaceBeforeInput.el);
  spaceRow.appendChild(fontBox.spaceAfterInput.el);
  spaceRow.appendChild(fontBox.directionMenu.el)
}
