/**
 * Document window, URL import, merge-channels, and numeric-prompt dialogs.
 */

import { Locale } from "../../core/i18n/locale.js";
import { Point } from "../../core/math/point.js";
import { AdjustmentEngine } from "../../features/adjustments/adjustment-engine.js";
import { Document } from "../../document/model/document.js";
import { RangeInput } from "../widgets/controls/number-inputs.js";
import { ButtonMenu, Dropdown } from "../widgets/controls/popup-controls.js";
import { Button, TextInput } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { appendBreak, makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";

/** Origin used by DocumentWindowDialog; y is inset by the title-bar chrome. */
function dialogOriginFromBounds(bounds) {
  return new Point(bounds[0], bounds[1] - 33);
}

function dialogFormSizeStyle(bounds) {
  return "width:" + (bounds[2] - bounds[0]) + "px; height:" + (bounds[3] - bounds[1]) + "px";
}

function copyRgbChannelsIntoBuffer(pixelBuffer, channelRasters) {
  for (let pixelIdx = 0; pixelIdx < pixelBuffer.length; pixelIdx += 4) {
    pixelBuffer[pixelIdx] = channelRasters[0][pixelIdx];
    pixelBuffer[pixelIdx + 1] = channelRasters[1][pixelIdx];
    pixelBuffer[pixelIdx + 2] = channelRasters[2][pixelIdx];
  }
}

function dispatchDeferredDialogResult(dialog, deferred, resultValue) {
  const appEventType = deferred.appEventType;
  const documentModelType = deferred.documentModelType !== undefined ? deferred.documentModelType : null;
  const payload = deferred.payload !== undefined ? deferred.payload : {};
  const appEvent = new AppEvent(appEventType, true);
  appEvent.routingChannel = documentModelType != null ? documentModelType : null;
  appEvent.data = payload;
  appEvent.data.dialogResult = resultValue;
  appEvent.fromDialog = true;
  dialog.dispatch(appEvent);
}

function DocumentWindowDialog(titleLocaleKey, dialogClassId, bounds) {
  BaseDialog.call(this, titleLocaleKey, "cwindow");
  this.dialogOriginOffset = dialogOriginFromBounds(bounds);
  this.formDiv = makeElement("div", "form");
  this.formDiv.setAttribute("style", dialogFormSizeStyle(bounds));
  this.body.appendChild(this.formDiv);
}
DocumentWindowDialog.prototype = Object.create(BaseDialog.prototype);
DocumentWindowDialog.prototype.constructor = DocumentWindowDialog;
DocumentWindowDialog.prototype.getOffset = function(dialogWidth, dialogHeight) {
  return this.dialogOriginOffset.clone();
};

function OpenURLDialog() {
  BaseDialog.call(this, "file.openFromURL", "open_from_url");
  this.placeIntoDocumentTabIndex = null;
  const formDiv = makeElement("div", "form");
  this.body.appendChild(formDiv);
  this.urlTextInput = new TextInput("properties.url", null, 22);
  formDiv.appendChild(this.urlTextInput.el);
  appendBreak(formDiv);
  this.placeIntoTargetMenu = new ButtonMenu("importExport.placeInto", [
    "importExport.newProject",
    "importExport.currentProject"
  ]);
  formDiv.appendChild(this.placeIntoTargetMenu.el);
  this.openUrlOkButton = new Button("clipboard.ok", true, null, true);
  this.openUrlOkButton.on("click", this.onOK, this);
  formDiv.appendChild(this.openUrlOkButton.el);
}
OpenURLDialog.prototype = Object.create(BaseDialog.prototype);
OpenURLDialog.prototype.constructor = OpenURLDialog;
OpenURLDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.placeIntoTargetMenu.buildUI();
};
OpenURLDialog.prototype.open = function(currentDoc, dialogPayload, openDocs) {
  this.urlTextInput.focusAndSelectAll();
  this.placeIntoDocumentTabIndex = null;
  if (currentDoc && openDocs.indexOf(currentDoc) != -1) this.placeIntoDocumentTabIndex = openDocs.indexOf(currentDoc);
};
OpenURLDialog.prototype.onOK = function(clickEvent) {
  const dispatchEvent = new AppEvent(EventType.uiDispatch, true);
  const urlString = this.urlTextInput.getValue();
  dispatchEvent.data = {
    dispatchKind: UiCommand.importFromUrl,
    importSpec: {
      url: urlString,
      placeIntoDocIndex: this.placeIntoTargetMenu.getValue() == 1 ? this.placeIntoDocumentTabIndex : null
    }
  };
  this.dispatch(dispatchEvent);
  this.close();
};

function MergeChannelsDialog() {
  BaseDialog.call(this, "dialogs.mergeChannels", "mergechannels");
  this.sourceDocuments = null;
  const formDiv = makeElement("div", "form");
  this.body.appendChild(formDiv);
  this.channelSourceDropdowns = [];
  for (let channelIdx = 0; channelIdx < 3; channelIdx++) {
    const channelDropdown = new Dropdown(AdjustmentEngine.rgbColorLabels[channelIdx], []);
    this.channelSourceDropdowns.push(channelDropdown);
    formDiv.appendChild(channelDropdown.el);
    appendBreak(formDiv);
  }
  this.okBtn = new Button("clipboard.ok", true, null, true);
  this.okBtn.on("click", this.onOK, this);
  formDiv.appendChild(this.okBtn.el);
}
MergeChannelsDialog.prototype = Object.create(BaseDialog.prototype);
MergeChannelsDialog.prototype.constructor = MergeChannelsDialog;
MergeChannelsDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  for (let channelIdx = 0; channelIdx < 3; channelIdx++) this.channelSourceDropdowns[channelIdx].buildUI();
};
MergeChannelsDialog.prototype.open = function(currentDoc, dialogPayload, openDocs, keyboard) {
  this.sourceDocuments = openDocs;
  const documentNames = [];
  for (let docIdx = 0; docIdx < openDocs.length; docIdx++) documentNames.push(openDocs[docIdx].name);
  for (let channelIdx = 0; channelIdx < 3; channelIdx++) {
    const channelDropdown = this.channelSourceDropdowns[channelIdx];
    channelDropdown.setItems(documentNames);
    channelDropdown.setValue(Math.min(channelIdx, openDocs.length - 1));
  }
};
MergeChannelsDialog.prototype.onOK = function(clickEvent) {
  const sourceDocuments = this.sourceDocuments;
  const firstDoc = sourceDocuments[0];
  const historyEvent = new AppEvent(EventType.historyGrouped, true);
  historyEvent.data = Document.buildMakeDocumentEvent(firstDoc.width, firstDoc.height, firstDoc.dpi, "Merged Document", "Wht");
  this.dispatch(historyEvent);
  const channelRasters = [];
  for (let channelIdx = 0; channelIdx < 3; channelIdx++) {
    channelRasters.push(sourceDocuments[this.channelSourceDropdowns[channelIdx].getValue()].getRasterData());
  }
  const lastDoc = sourceDocuments[sourceDocuments.length - 1];
  const backgroundLayer = lastDoc.layers[0];
  copyRgbChannelsIntoBuffer(backgroundLayer.buffer, channelRasters);
  backgroundLayer.markDirty();
  lastDoc.markDirty();
  this.close();
};

function NumericInputDialog(valueInputKind, dialogClassId, titleLocaleKey, initialValue, useResultCallback) {
  BaseDialog.call(this, titleLocaleKey, dialogClassId);
  this.useResultCallback = useResultCallback;
  this.dialogPayload = null;
  this.formDiv = makeElement("div", "form");
  this.body.appendChild(this.formDiv);
  this.valueInput = valueInputKind == 0 ? new TextInput(titleLocaleKey) : new RangeInput(titleLocaleKey, 0, 500, initialValue, 1);
  this.valueInput.on(EventType.widgetSelect, this.onInputValueChange, this);
  this.formDiv.appendChild(this.valueInput.el);
  this.okBtn = new Button("clipboard.ok", true, null, true);
  this.okBtn.on("click", this.onOK, this);
  this.formDiv.appendChild(this.okBtn.el);
  this.on("closebtn", this.onCancel, this);
}
NumericInputDialog.prototype = Object.create(BaseDialog.prototype);
NumericInputDialog.prototype.constructor = NumericInputDialog;
NumericInputDialog.prototype.isActive = function() {
  return true;
};
NumericInputDialog.prototype.onInputValueChange = function(widgetEvent) {
  const inputValue = this.valueInput.getValue();
  if (this.useResultCallback) this.completeWithResult(inputValue);
};
NumericInputDialog.prototype.onCancel = function(closeEvent) {
  if (this.useResultCallback) this.completeWithResult("cancel");
};
NumericInputDialog.prototype.onOK = function(clickEvent) {
  if (this.useResultCallback) this.completeWithResult("confirm");
  else this.completeWithResult(this.valueInput.getValue());
  this.close();
};
NumericInputDialog.prototype.completeWithResult = function(resultValue) {
  if (this.dialogPayload.onDialogComplete) this.dialogPayload.onDialogComplete(resultValue);
  else if (this.dialogPayload.deferredDispatch) {
    dispatchDeferredDialogResult(this, this.dialogPayload.deferredDispatch, resultValue);
  }
};
NumericInputDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  if (this.valueInput) this.valueInput.buildUI();
};
NumericInputDialog.prototype.open = function(currentDoc, dialogPayload) {
  this.dialogPayload = dialogPayload;
  this.valueInput.setValue(dialogPayload.initialValue);
  this.valueInput.focusAndSelectAll();
  this.onInputValueChange(null);
};

export {
  DocumentWindowDialog,
  OpenURLDialog,
  MergeChannelsDialog,
  NumericInputDialog,
  dialogOriginFromBounds,
  dialogFormSizeStyle,
};
