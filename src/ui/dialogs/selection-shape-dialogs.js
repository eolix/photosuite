/**
 * Slice options, selection-modify, make-selection, and create-shape dialogs.
 */

import { Locale } from "../../core/i18n/locale.js";
import { ToolId } from "../../document/model/tool-base.js";
import { SliderDropdown } from "../widgets/controls/number-inputs.js";
import { DocumentSelector } from "../widgets/controls/popup-controls.js";
import { Button, Checkbox, TextInput } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { EventType } from "../../core/event-bus.js";
import { appendBreak, makeElement } from "../../core/dom.js";
import { showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";
import { SelectTool } from "../../document/tools/selection-tools.js";

const SLICE_FIELD_LABEL_BY_KEY = {
  Nm: "properties.name",
  url: "URL",
  null: "properties.target"
};

function copySliceTextFieldsFromInputs(sliceOptions, sliceOptionInputs, fieldLabelByKey) {
  for (const fieldKey in fieldLabelByKey) {
    sliceOptions[fieldKey] = {
      t: "TEXT",
      v: sliceOptionInputs[fieldKey].getValue()
    };
  }
  return sliceOptions;
}

function SelectionOptionsDialog() {
  BaseDialog.call(this, "view.sliceOptions", "soptions");
  this.initialSliceOptionsJson = null;
  const formDiv = makeElement("div", "form");
  formDiv.style.width = "20em";
  this.body.appendChild(formDiv);
  this.sliceFieldLabelByKey = SLICE_FIELD_LABEL_BY_KEY;
  this.sliceOptionInputs = {};
  for (const fieldKey in this.sliceFieldLabelByKey) {
    const textInput = new TextInput(this.sliceFieldLabelByKey[fieldKey], null, 15);
    this.sliceOptionInputs[fieldKey] = textInput;
    formDiv.appendChild(textInput.el);
  }
  const okButton = new Button("clipboard.ok", true, null, true);
  okButton.on("click", this.onOK, this);
  formDiv.appendChild(okButton.el);
}
SelectionOptionsDialog.prototype = Object.create(BaseDialog.prototype);
SelectionOptionsDialog.prototype.constructor = SelectionOptionsDialog;
SelectionOptionsDialog.prototype.open = function(currentDoc, dialogPayload, openDocs) {
  const sliceData = dialogPayload.sliceDescriptor;
  this.initialSliceOptionsJson = JSON.stringify(sliceData);
  for (const fieldKey in this.sliceFieldLabelByKey) {
    if (sliceData[fieldKey]) this.sliceOptionInputs[fieldKey].setValue(sliceData[fieldKey].v);
  }
};
SelectionOptionsDialog.prototype.onOK = function(clickEvent) {
  const sliceOptions = copySliceTextFieldsFromInputs(
    JSON.parse(this.initialSliceOptionsJson),
    this.sliceOptionInputs,
    this.sliceFieldLabelByKey,
  );
  const documentActionEvent = new AppEvent(EventType.documentAction, true);
  documentActionEvent.routingChannel = ToolId.TOOL_SLICE;
  documentActionEvent.data = sliceOptions;
  documentActionEvent.fromDialog = true;
  this.dispatch(documentActionEvent);
  this.close();
};

function SelectOptionsDialog(selectionToolOptionKind, titleLocaleKey, unitLabel) {
  BaseDialog.call(this, titleLocaleKey, "sel_" + selectionToolOptionKind);
  this.selectionToolOptionKind = selectionToolOptionKind;
  const formDiv = makeElement("div", "form");
  this.body.appendChild(formDiv);
  this.amountControlSlider = new SliderDropdown(titleLocaleKey, 0, 255, null, 0, false, true);
  formDiv.appendChild(this.amountControlSlider.el);
  this.amountControlSlider.setValue(1);
  const unitLabelSpan = makeElement("span");
  unitLabelSpan.textContent = unitLabel;
  formDiv.appendChild(unitLabelSpan);
  appendBreak(formDiv);
  this.applyAtCanvasBoundsCheckbox = new Checkbox("properties.applyAtCanvasBounds");
  if (selectionToolOptionKind != "border") formDiv.appendChild(this.applyAtCanvasBoundsCheckbox.el);
  this.okBtn = new Button("clipboard.ok", true, null, true);
  this.okBtn.on("click", this.onOK, this);
  formDiv.appendChild(this.okBtn.el);
}
SelectOptionsDialog.prototype = Object.create(BaseDialog.prototype);
SelectOptionsDialog.prototype.constructor = SelectOptionsDialog;
SelectOptionsDialog.prototype.canOpen = function(currentDoc, dialogPayload) {
  if (currentDoc == null) return;
  if (currentDoc.selectionMask == null) showToast(Locale.get("dialogs.noSelection"));
  return currentDoc.selectionMask != null;
};
SelectOptionsDialog.prototype.onOK = function(clickEvent) {
  const historyEvent = new AppEvent(EventType.historyGrouped, true);
  historyEvent.data = SelectTool.buildModifySelectionAction(
    this.selectionToolOptionKind,
    this.amountControlSlider.getValue(),
    this.applyAtCanvasBoundsCheckbox.getValue(),
  );
  historyEvent.fromDialog = true;
  this.dispatch(historyEvent);
  this.close();
};
SelectOptionsDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  if (this.amountControlSlider) this.amountControlSlider.buildUI();
};
SelectOptionsDialog.prototype.open = function(currentDoc, dialogPayload) {};

function MakeSelectionDialog() {
  BaseDialog.call(this, "dialogs.makeSelection", "makesel");
  this.doc = null;
  const formDiv = makeElement("div", "form");
  this.body.appendChild(formDiv);
  this.antiAliasCheckbox = new Checkbox("properties.antiAlias");
  this.antiAliasCheckbox.setValue(true);
  formDiv.appendChild(this.antiAliasCheckbox.el);
  appendBreak(formDiv);
  this.documentScopeSelector = new DocumentSelector(true);
  formDiv.appendChild(this.documentScopeSelector.el);
  this.makeSelectionOkButton = new Button("clipboard.ok", true, null, true);
  this.makeSelectionOkButton.on("click", this.onOK, this);
  this.body.appendChild(this.makeSelectionOkButton.el);
}
MakeSelectionDialog.prototype = Object.create(BaseDialog.prototype);
MakeSelectionDialog.prototype.constructor = MakeSelectionDialog;
MakeSelectionDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.documentScopeSelector.buildUI();
};
MakeSelectionDialog.prototype.onOK = function(clickEvent) {
  const documentActionEvent = new AppEvent(EventType.documentAction, true);
  documentActionEvent.routingChannel = ToolId.TOOL_RECT_SELECT;
  documentActionEvent.data = {
    actionKind: "frompath",
    selectionSource: [null, 0, this.documentScopeSelector.getSelectedIndex(), !this.antiAliasCheckbox.getValue()]
  };
  this.close();
  this.dispatch(documentActionEvent);
};

function CreateShapeDialog() {
  BaseDialog.call(this, "properties.drawMode.shape", "createshape");
  this.dialogPayload = null;
  const formDiv = makeElement("div", "form");
  formDiv.setAttribute("style", "width:20em");
  this.body.appendChild(formDiv);
  this.widthInput = new SliderDropdown("properties.width", 0, 0, null, 0, false, true);
  formDiv.appendChild(this.widthInput.el);
  appendBreak(formDiv);
  this.heightSlider = new SliderDropdown("properties.height", 0, 0, null, 0, false, true);
  formDiv.appendChild(this.heightSlider.el);
  appendBreak(formDiv);
  this.drawFromCenterCheckbox = new Checkbox("styleOptions.strokePosition.fromCentre");
  formDiv.appendChild(this.drawFromCenterCheckbox.el);
  this.widthInput.setValue(100);
  this.heightSlider.setValue(100);
  this.okBtn = new Button("clipboard.ok", true, null, true);
  this.okBtn.on("click", this.onOK, this);
  formDiv.appendChild(this.okBtn.el);
}
CreateShapeDialog.prototype = Object.create(BaseDialog.prototype);
CreateShapeDialog.prototype.constructor = CreateShapeDialog;
CreateShapeDialog.prototype.onOK = function(clickEvent) {
  this.dialogPayload.onConfirm(
    this.dialogPayload.confirmArgs,
    this.widthInput.getValue(),
    this.heightSlider.getValue(),
    this.drawFromCenterCheckbox.getValue(),
  );
  this.close();
};
CreateShapeDialog.prototype.buildUI = function() {
  if (this.dialogPayload) {
    this.titleLocaleKey = Locale.get("clipboard.new") + ": " + Locale.get(this.dialogPayload.toolNameKey);
  }
  BaseDialog.prototype.buildUI.call(this);
  this.widthInput.buildUI();
  this.heightSlider.buildUI();
  this.drawFromCenterCheckbox.buildUI();
};
CreateShapeDialog.prototype.open = function(currentDoc, dialogPayload) {
  this.dialogPayload = dialogPayload;
  this.buildUI();
};

export { SelectionOptionsDialog, SelectOptionsDialog, MakeSelectionDialog, CreateShapeDialog };
