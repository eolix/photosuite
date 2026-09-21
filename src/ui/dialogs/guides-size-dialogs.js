/**
 * Add-guides and canvas/image size dialogs.
 */

import { Locale } from "../../core/i18n/locale.js";
import { Point } from "../../core/math/point.js";
import { ToolId } from "../../document/model/tool-base.js";
import { AngleInput } from "../widgets/controls/number-inputs.js";
import { Dropdown } from "../widgets/controls/popup-controls.js";
import { LayerEffectOption } from "../widgets/controls/stroke-layer-controls.js";
import { Button, Checkbox, Label, TextInput } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { EventType } from "../../core/event-bus.js";
import { addClass, appendBreak, appendHorizontalRule, clearElement, makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { CropToolBase } from "../../document/tools/crop-tools.js";
import { UNIT_NAMES, formatDocLength, parseDocLengthToPixels } from "../../engine/compositing/geometry.js";

function formatGuidePositionList(guidePositions, documentModel, unitPrefs, docExtent) {
  const formatted = [];
  for (let guideIdx = 0; guideIdx < guidePositions.length; guideIdx++) {
    formatted.push(formatDocLength(guidePositions[guideIdx], documentModel.dpi, unitPrefs, docExtent));
  }
  return formatted.join(", ");
}

function tokenizeGuideInputText(rawInput) {
  const trimmedInput = rawInput.replace(/,/g, " ").replace(/  +/g, " ").trim();
  return trimmedInput === "" ? [] : trimmedInput.split(" ");
}

function AddGuidesDialog() {
  BaseDialog.call(this, "dialogs.addGuides", "addguides");
  this.editingDocument = null;
  this.doc = {
    prefs: {
      AppWindow: 0
    }
  };
  this.guidesJsonSnapshot = null;
  const formDiv = makeElement("div", "form form-labelled");
  formDiv.setAttribute("style", "--form-label-width:5.6em;");
  this.body.appendChild(formDiv);
  this.horizontalGuidesTextInput = new TextInput("warp.orientation.horizontal", null, 16);
  this.horizontalGuidesTextInput.on(EventType.widgetSelect, this.applyGuidesFromInputs, this);
  this.verticalGuidesTextInput = new TextInput("warp.orientation.vertical", null, 16);
  this.verticalGuidesTextInput.on(EventType.widgetSelect, this.applyGuidesFromInputs, this);
  this.measurementOriginDropdown = new Dropdown("properties.unitOfMeasure", UNIT_NAMES);
  this.measurementOriginDropdown.on(EventType.widgetSelect, this.applyGuidesFromInputs, this);
  formDiv.appendChild(this.horizontalGuidesTextInput.el);
  appendBreak(formDiv);
  formDiv.appendChild(this.verticalGuidesTextInput.el);
  appendBreak(formDiv);
  formDiv.appendChild(this.measurementOriginDropdown.el);
  this.okBtn = new Button("clipboard.ok", true, null, true);
  this.okBtn.on("click", this.onOK, this);
  formDiv.appendChild(this.okBtn.el);
  this.on("closebtn", this.revertGuidesOnCloseWithoutSave, this)
}
AddGuidesDialog.prototype = Object.create(BaseDialog.prototype);
AddGuidesDialog.prototype.constructor = AddGuidesDialog;
AddGuidesDialog.prototype.canOpen = function(currentDoc, dialogPayload) {
  return currentDoc != null
};
AddGuidesDialog.prototype.isActive = function() {
  return true
};
AddGuidesDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.horizontalGuidesTextInput.buildUI();
  this.verticalGuidesTextInput.buildUI();
  this.measurementOriginDropdown.buildUI()
};
AddGuidesDialog.prototype.onUpdate = function(appData, popupType) {
  const rulerUnits = appData.prefs.AppWindow;
  this.doc.prefs.AppWindow = rulerUnits;
  this.measurementOriginDropdown.setValue(rulerUnits)
};
AddGuidesDialog.prototype.open = function(currentDoc, dialogPayload) {
  this.editingDocument = currentDoc;
  this.guidesJsonSnapshot = JSON.stringify(currentDoc.guides);
  this.rebuild()
};
AddGuidesDialog.prototype.rebuild = function() {
  const editingDoc = this.editingDocument;
  const guides = editingDoc.guides;
  this.horizontalGuidesTextInput.setValue(formatGuidePositionList(guides[1], editingDoc, this.doc, editingDoc.height));
  this.verticalGuidesTextInput.setValue(formatGuidePositionList(guides[0], editingDoc, this.doc, editingDoc.width));
};
AddGuidesDialog.prototype.applyGuidesFromInputs = function(widgetEvent) {
  if (widgetEvent && widgetEvent.currentTarget == this.measurementOriginDropdown) this.doc.prefs.AppWindow = this.measurementOriginDropdown.getValue();
  else {
    const horizontalGuides = this.parseGuidePositionsFromTextInput(this.horizontalGuidesTextInput),
      verticalGuides = this.parseGuidePositionsFromTextInput(this.verticalGuidesTextInput),
      editingDoc = this.editingDocument;
    editingDoc.guides = [verticalGuides, horizontalGuides];
    editingDoc.dirty = true
  }
  this.rebuild()
};
AddGuidesDialog.prototype.parseGuidePositionsFromTextInput = function(textInputWidget) {
  const docExtent = textInputWidget == this.horizontalGuidesTextInput ? this.editingDocument.height : this.editingDocument.width;
  const tokenList = tokenizeGuideInputText(textInputWidget.getValue());
  for (let tokenIdx = 0; tokenIdx < tokenList.length; tokenIdx++) {
    tokenList[tokenIdx] = parseDocLengthToPixels(tokenList[tokenIdx], this.editingDocument.dpi, this.doc, docExtent);
  }
  return tokenList;
};
AddGuidesDialog.prototype.revertGuidesOnCloseWithoutSave = function(closeEvent) {
  const editingDoc = this.editingDocument;
  editingDoc.guides = JSON.parse(this.guidesJsonSnapshot);
  editingDoc.dirty = true;
  this.editingDocument = null
};
AddGuidesDialog.prototype.onOK = function(clickEvent) {
  this.applyGuidesFromInputs(clickEvent);
  const guidesHistoryEvent = new AppEvent(EventType.documentAction, true);
  guidesHistoryEvent.routingChannel = ToolId.TOOL_MOVE;
  guidesHistoryEvent.data = {
    actionKind: "gids",
    guidesBefore: JSON.parse(this.guidesJsonSnapshot),
    guidesAfter: JSON.parse(JSON.stringify(this.editingDocument.guides))
  };
  this.editingDocument = null;
  this.close();
  this.dispatch(guidesHistoryEvent)
};


// --- Canvas Size / Image Size ------------------------------------------------

/**
 * Centre cell of the 3x3 anchor grid — the canvas grows or shrinks evenly on
 * every side. Cells run left to right, top to bottom, 0 to 8.
 */
const ANCHOR_GRID_CENTER_CELL = 4;

/** Form width and label column both size dialogs lay their rows out on. */
const SIZE_DIALOG_FORM_STYLE = "width:21em;--form-label-width:4.6em;";

/** `1920 x 1080, 2.1 MPx` — the summary line above the fields. */
function formatPixelSizeSummary(width, height) {
  return width + " x " + height + ", " + (width * height / 1e6).toFixed(1) + " MPx";
}

/**
 * Regroup a size option into one labelled row per quantity. The option mounts
 * width, height, resolution and the relative toggle as a single inline run
 * broken by line breaks; the size dialogs want a label column beside a value
 * column, so each field moves into a `fieldrow` together with whatever belongs
 * next to it — the unit selector after width, the aspect-ratio lock and the
 * ratio it reports after height. Rows the option did not mount are left out.
 * Expects an option built with the aspect-ratio lock rather than the swap
 * button, which is what both size dialogs ask for.
 */
function installSizeOptionRows(sizeOption) {
  const rootEl = sizeOption.el;
  const mountsResolution = sizeOption.dpiInput.el.parentNode === rootEl;
  const mountsRelativeOffset = sizeOption.relativeOffsetCheckbox.el.parentNode === rootEl;
  addClass(rootEl, "size-fields");
  clearElement(rootEl);
  // The fields carry an inline width from the option's own inline layout; the
  // rows size them instead, so every field in the column is the same width.
  sizeOption.widthInput.inputEl.style.width = "";
  sizeOption.heightInput.inputEl.style.width = "";
  sizeOption.dpiInput.inputEl.style.width = "";
  appendSizeOptionRow(rootEl, [sizeOption.widthInput.el, sizeOption.unitDropdown.el]);
  appendSizeOptionRow(rootEl, [
    sizeOption.heightInput.el,
    sizeOption.aspectRatioLockButton.el,
    sizeOption.aspectRatioLabel.el
  ]);
  if (mountsResolution) appendSizeOptionRow(rootEl, [sizeOption.dpiInput.el]);
  if (mountsRelativeOffset) appendSizeOptionRow(rootEl, [sizeOption.relativeOffsetCheckbox.el]);
}

function appendSizeOptionRow(hostEl, rowElements) {
  const rowEl = makeElement("div", "fieldrow");
  for (let elementIdx = 0; elementIdx < rowElements.length; elementIdx++) {
    rowEl.appendChild(rowElements[elementIdx]);
  }
  hostEl.appendChild(rowEl);
}

/** Trailing row holding a dialog's confirm button against the right edge. */
function appendFormActionsRow(formEl, buttonWidget) {
  const actionsEl = makeElement("div", "form-actions");
  actionsEl.appendChild(buttonWidget.el);
  formEl.appendChild(actionsEl);
}


function CanvasSizeDialog() {
  BaseDialog.call(this, "dialogs.canvasSize", "csize");
  this.formDiv = makeElement("div", "form form-labelled");
  this.formDiv.setAttribute("style", SIZE_DIALOG_FORM_STYLE);
  this.body.appendChild(this.formDiv);
  this.canvasSizeSummaryLabel = new Label("");
  addClass(this.canvasSizeSummaryLabel.el, "size-summary");
  this.formDiv.appendChild(this.canvasSizeSummaryLabel.el);
  // Physical units and the Relative toggle, no resolution field: changing the
  // canvas reframes the pixels it already has, it never rescales them.
  this.sizeOption = new LayerEffectOption(true, true, true, true);
  this.sizeOption.setAspectRatioLock(false);
  this.sizeOption.on(EventType.widgetSelect, this.refreshCanvasSizeSummary, this);
  installSizeOptionRows(this.sizeOption);
  this.formDiv.appendChild(this.sizeOption.el);
  appendHorizontalRule(this.formDiv);
  this.anchorGridInput = new AngleInput("properties.anchor", 41);
  this.anchorGridInput.setValue(ANCHOR_GRID_CENTER_CELL);
  this.formDiv.appendChild(this.anchorGridInput.el);
  this.confirmCanvasResizeButton = new Button("clipboard.ok", true, null, true);
  this.confirmCanvasResizeButton.on("click", this.onOK, this);
  appendFormActionsRow(this.formDiv, this.confirmCanvasResizeButton)
}
CanvasSizeDialog.prototype = Object.create(BaseDialog.prototype);
CanvasSizeDialog.prototype.constructor = CanvasSizeDialog;
CanvasSizeDialog.prototype.canOpen = function(currentDoc, dialogPayload) {
  return currentDoc != null
};
CanvasSizeDialog.prototype.isActive = function() {
  return true
};
CanvasSizeDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.sizeOption.buildUI();
  this.anchorGridInput.buildUI()
};
CanvasSizeDialog.prototype.refreshCanvasSizeSummary = function(widgetEvent) {
  const canvasSize = this.sizeOption.getValue();
  this.canvasSizeSummaryLabel.setValue(formatPixelSizeSummary(canvasSize.x, canvasSize.y))
};
CanvasSizeDialog.prototype.onOK = function(clickEvent) {
  const sizePoint = this.sizeOption.getValue(),
    width = sizePoint.x,
    height = sizePoint.y,
    historyEvent = new AppEvent(EventType.historyGrouped, true);
  historyEvent.data = CropToolBase.buildCanvasSizeAction(width, height, this.anchorGridInput.getValue());
  this.close();
  this.dispatch(historyEvent)
};
CanvasSizeDialog.prototype.open = function(currentDoc, dialogPayload) {
  this.sizeOption.setValue(new Point(currentDoc.width, currentDoc.height), currentDoc.dpi);
  this.refreshCanvasSizeSummary()
};


function ImageSizeDialog() {
  BaseDialog.call(this, "dialogs.imageSize", "isize");
  this.formDiv = makeElement("div", "form form-labelled");
  this.formDiv.setAttribute("style", SIZE_DIALOG_FORM_STYLE);
  this.body.appendChild(this.formDiv);
  this.imageSizeSummaryLabel = new Label("");
  addClass(this.imageSizeSummaryLabel.el, "size-summary");
  this.formDiv.appendChild(this.imageSizeSummaryLabel.el);
  this.sizeOption = new LayerEffectOption(true, true);
  this.sizeOption.on(EventType.widgetSelect, this.refreshImageSizeSummary, this);
  installSizeOptionRows(this.sizeOption);
  this.formDiv.appendChild(this.sizeOption.el);
  appendHorizontalRule(this.formDiv);
  this.enableResampleCheckbox = new Checkbox("properties.resample");
  this.enableResampleCheckbox.setValue(true);
  this.enableResampleCheckbox.on(EventType.widgetSelect, this.onResampleInterpolationToggle, this);
  // The checkbox names the pair, so the method carries its name on the tooltip
  // rather than repeating it in the label column.
  this.imageInterpolationDropdown = new Dropdown("properties.size.interpolation", [
    "properties.size.nearestNeighbour",
    "properties.size.bilinear",
    "properties.size.bicubicSharper"
  ], true);
  this.imageInterpolationDropdown.setValue(1);
  const resampleRowEl = makeElement("div", "fieldrow");
  resampleRowEl.appendChild(this.enableResampleCheckbox.el);
  resampleRowEl.appendChild(this.imageInterpolationDropdown.el);
  this.formDiv.appendChild(resampleRowEl);
  this.confirmImageResizeButton = new Button("clipboard.ok", true, null, true);
  this.confirmImageResizeButton.on("click", this.onOK, this);
  appendFormActionsRow(this.formDiv, this.confirmImageResizeButton)
}
ImageSizeDialog.prototype = Object.create(BaseDialog.prototype);
ImageSizeDialog.prototype.constructor = ImageSizeDialog;
ImageSizeDialog.prototype.canOpen = function(currentDoc, dialogPayload) {
  return currentDoc != null
};
ImageSizeDialog.prototype.isActive = function() {
  return true
};
ImageSizeDialog.prototype.onResampleInterpolationToggle = function(widgetEvent) {
  const resampleEnabled = this.enableResampleCheckbox.getValue(),
    sizeOption = this.sizeOption,
    interpolationDropdown = this.imageInterpolationDropdown;
  if (resampleEnabled) interpolationDropdown.enable();
  else interpolationDropdown.disable();
  if (resampleEnabled) sizeOption.enablePixelResizing();
  else sizeOption.disablePixelResizing()
};
ImageSizeDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.imageInterpolationDropdown.buildUI();
  this.sizeOption.buildUI()
};
ImageSizeDialog.prototype.refreshImageSizeSummary = function(widgetEvent) {
  const imageSize = this.sizeOption.getValue();
  this.imageSizeSummaryLabel.setValue(formatPixelSizeSummary(imageSize.x, imageSize.y))
};
ImageSizeDialog.prototype.onOK = function(clickEvent) {
  this.close();
  const sizePoint = this.sizeOption.getValue(),
    width = sizePoint.x,
    height = sizePoint.y;
  let interpolationMode = this.imageInterpolationDropdown.getValue();
  if (!this.enableResampleCheckbox.getValue()) interpolationMode = null;
  const historyEvent = new AppEvent(EventType.historyGrouped, true);
  historyEvent.data = CropToolBase.buildImageSizeAction(width, height, this.sizeOption.getDpi(), interpolationMode);
  this.dispatch(historyEvent)
};
ImageSizeDialog.prototype.open = function(currentDoc, dialogPayload) {
  this.sizeOption.setValue(new Point(currentDoc.width, currentDoc.height), currentDoc.dpi);
  this.refreshImageSizeSummary()
};

export {
  AddGuidesDialog,
  CanvasSizeDialog,
  ImageSizeDialog,
  formatPixelSizeSummary,
  tokenizeGuideInputText
};
