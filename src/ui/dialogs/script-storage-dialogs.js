/**
 * ExtendScript editor and local persisted resource browser.
 */

import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { formatByteSize } from "../../core/file-names.js";
import { Locale } from "../../core/i18n/locale.js";
import { PopupTypes } from "../config/popup-types.js";
import { Button, Label } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { WriteFileDialog } from "./export-dialogs.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, clearElement, makeElement, removeClass } from "../../core/dom.js";
import { showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";

/** Built-in JSX demo snippets shown in the script dialog toolbar. */
const SCRIPT_DEMO_SNIPPETS = [{
  label: "dialogs.script.demoHello",
  sourceText: "\nalert(\"Hello PhotoSuite!\");\n"
}, {
  label: "dialogs.script.demoProcessLayers",
  sourceText: "\nvar lays = app.activeDocument.layers;\n\nfor(var i=0; i<lays.length; i++)\n{\n" + "\t//lays[i].visible = false;\n" + "\t//lays[i].opacity = 50;\n" + "\tlays[i].name = \"My Layer \"+i;\n}"
}, {
  label: "dialogs.script.demoCloneLayers",
  sourceText: "\nvar orig = app.activeDocument.activeLayer;\n" + "var cnt = 12;\n" + "var angle = Math.floor(360 / cnt);\n" + "\n" + "for(var i=1; i<cnt; i++)\n" + "{\n" + "\tvar nlay = orig.duplicate();\n" + "\t//nlay.translate(30*i, 20*i);\n" + "\tnlay.rotate(angle * i, AnchorPosition.BOTTOMCENTER);\n" + "}"
}];

/** Resource manager size, in CSS pixels. */
const DIALOG_WIDTH_PX = 460;
const DIALOG_HEIGHT_PX = 400;

/** Uppercased extension shown as the row's kind badge. */
function fileKindLabel(fileName) {
  const parts = fileName.split(".");
  return parts.length > 1 ? parts.pop().toUpperCase() : "?";
}

function compareStoredResourceFileNames(nameA, nameB) {
  const partsA = nameA.split(".");
  const partsB = nameB.split(".");
  if (partsA[1] === partsB[1]) return partsA[0] < partsB[0] ? -1 : 1;
  return partsA[1] < partsB[1] ? -1 : 1;
}

function ScriptDialog() {
  BaseDialog.call(this, "file.script", "script");
  const formDiv = makeElement("div", "form");
  formDiv.setAttribute("style", "width:44em");
  this.body.appendChild(formDiv);
  this.doc = null;
  this.items = [];
  this.savedJsxFilenames = [];
  this.activeJsxBasename = null;
  const saveScriptToolbarButtonEl = this.saveScriptToolbarButton = new Button("file.save", false, null, true);
  saveScriptToolbarButtonEl.on("click", this.promptSaveScriptFilenameChooser, this);
  formDiv.appendChild(saveScriptToolbarButtonEl.el);
  const jsRefButton = new Button("dialogs.script.jsReference", false, null, true);
  jsRefButton.on("click", this.openJavascriptReferencePdf, this);
  formDiv.appendChild(jsRefButton.el);
  formDiv.appendChild(new Label("dialogs.script.demos").el);
  this.demoSnippetButtons = [];
  const demoSnippets = SCRIPT_DEMO_SNIPPETS;
  for (let demoIdx = 0; demoIdx < demoSnippets.length; demoIdx++) {
    const demoButton = new Button(demoSnippets[demoIdx].label, false, null, true);
    this.demoSnippetButtons.push(demoButton);
    formDiv.appendChild(demoButton.el);
    demoButton.on("click", this.onDemoSnippetButtonClicked, this)
  }
  this.scriptSourceTextarea = makeElement("textarea");
  this.scriptSourceTextarea.setAttribute("rows", 16);
  this.scriptSourceTextarea.setAttribute("style", "display:block;tab-size:4; font-family:monospace;width:100%;");
  formDiv.appendChild(this.scriptSourceTextarea);
  const runButton = new Button("dialogs.script.run", true, null, true);
  runButton.on("click", this.onOK, this);
  formDiv.appendChild(runButton.el);
  this.savedScriptsChipsStrip = makeElement("div");
  formDiv.appendChild(this.savedScriptsChipsStrip)
}
ScriptDialog.prototype = Object.create(BaseDialog.prototype);
ScriptDialog.prototype.constructor = ScriptDialog;
ScriptDialog.prototype.buildUI = function() {
  this.saveScriptToolbarButton.buildUI()
};
ScriptDialog.prototype.promptSaveScriptFilenameChooser = function() {
  let basename = this.activeJsxBasename;
  if (basename == null) basename = "script.jsx";
  const dispatchEvent = new AppEvent(EventType.uiDispatch, true);
  dispatchEvent.data = {
    dispatchKind: UiCommand.dispatchAppDialogRouter,
    dialogRouteId: "namewindow",
    initialValue: basename.slice(0, basename.length - 4),
    onDialogComplete: this.persistScriptSaveAfterSubsetConfirm.bind(this)
  };
  this.dispatch(dispatchEvent)
};
ScriptDialog.prototype.persistScriptSaveAfterSubsetConfirm = function(confirmedBasename) {
  const scriptText = this.scriptSourceTextarea.value,
    utf8Bytes = BinaryUtils.encodeUtf8(scriptText),
    dispatchEvent = new AppEvent(EventType.uiDispatch, true);
  dispatchEvent.data = {
    dispatchKind: UiCommand.confirmPersistStartupResource,
    fileByteBuffer: utf8Bytes.buffer,
    storageEntryName: confirmedBasename + ".jsx",
    forcePersistWithoutPrompt: true
  };
  this.dispatch(dispatchEvent)
};
ScriptDialog.prototype.onSavedScriptChipClicked = function(widgetEvent) {
  const chipIndex = this.items.indexOf(widgetEvent.target),
    jsxFilename = this.activeJsxBasename = this.savedJsxFilenames[chipIndex],
    scriptBytes = this.doc.startupResourceStore.storedFiles[jsxFilename],
    byteArray = new Uint8Array(scriptBytes),
    scriptText = BinaryUtils.readUtf8(byteArray, 0, byteArray.length);
  this.scriptSourceTextarea.value = scriptText
};
ScriptDialog.prototype.open = function(currentDoc, dialogPayload, openDocs) {
  this.scriptSourceTextarea.value = SCRIPT_DEMO_SNIPPETS[0].sourceText;
  this.refreshSavedScriptChipsUi()
};
ScriptDialog.prototype.refreshSavedScriptChipsUi = function() {
  const startupResourceStore = this.doc.startupResourceStore,
    chipsStrip = this.savedScriptsChipsStrip;
  clearElement(chipsStrip);
  this.items = [];
  this.savedJsxFilenames = [];
  chipsStrip.textContent = Locale.get("dialogs.script.savedScripts");
  for (let filename in startupResourceStore.storedFiles) {
    if (filename.endsWith(".jsx")) {
      const chipButton = new Button(filename, false, null, true);
      this.items.push(chipButton);
      this.savedJsxFilenames.push(filename);
      chipButton.on("click", this.onSavedScriptChipClicked, this);
      chipsStrip.appendChild(chipButton.el)
    }
  }
};
ScriptDialog.prototype.onUpdate = function(appData, popupType) {
  this.doc = appData;
  if (popupType == PopupTypes.STARTUP_RESOURCES) this.refreshSavedScriptChipsUi()
};
ScriptDialog.prototype.openJavascriptReferencePdf = function(clickEvent) {
  const dispatchEvent = new AppEvent(EventType.uiDispatch, true);
  dispatchEvent.data = {
    dispatchKind: UiCommand.openTranslateLink,
    link: "https://github.com/Adobe-CEP/CEP-Resources/tree/master/Documentation/Product%20specific%20Documentation/Photoshop%20Scripting"
  };
  this.dispatch(dispatchEvent)
};
ScriptDialog.prototype.onOK = function(clickEvent) {
  const dispatchEvent = new AppEvent(EventType.uiDispatch, true);
  dispatchEvent.data = {
    dispatchKind: UiCommand.runExtensionScriptSnippet,
    scriptSource: this.scriptSourceTextarea.value
  };
  this.dispatch(dispatchEvent)
};
ScriptDialog.prototype.onDemoSnippetButtonClicked = function(widgetEvent) {
  const demoIdx = this.demoSnippetButtons.indexOf(widgetEvent.currentTarget);
  this.scriptSourceTextarea.value = SCRIPT_DEMO_SNIPPETS[demoIdx].sourceText
};


function ResourceManagerDialog() {
  BaseDialog.call(this, "file.resourceManager", "resmgr");
  this.doc = null;
  this.sortedResourceKeys = [];
  this.selectedResourceIndex = -1;
  this.totalStoredBytesSum = 0;
  this.rowElements = [];
  const bodyEl = this.body;
  this.introParagraphEl = makeElement("p", "resmgr-intro");
  bodyEl.appendChild(this.introParagraphEl);
  this.resourceListEl = makeElement("div", "resmgr-list");
  bodyEl.appendChild(this.resourceListEl);
  const footerEl = makeElement("div", "resmgr-foot");
  bodyEl.appendChild(footerEl);
  this.totalBytesSummaryLabelEl = makeElement("span", "resmgr-total");
  footerEl.appendChild(this.totalBytesSummaryLabelEl);
  this.deleteSelectedResourceButton = new Button("clipboard.delete", false, null, true);
  this.deleteSelectedResourceButton.on("click", this.deleteSelectedStoredResource, this);
  footerEl.appendChild(this.deleteSelectedResourceButton.el);
  this.onResourceRowClick = this.onResourceRowClick.bind(this)
}
ResourceManagerDialog.prototype = Object.create(BaseDialog.prototype);
ResourceManagerDialog.prototype.constructor = ResourceManagerDialog;
ResourceManagerDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.introParagraphEl.textContent = Locale.get("dialogs.resourceManager.intro");
  this.totalBytesSummaryLabelEl.textContent =
    Locale.get("colour.total") + ": " + formatByteSize(this.totalStoredBytesSum);
  this.deleteSelectedResourceButton.buildUI();
  this.renderResourceRows()
};
ResourceManagerDialog.prototype.onUpdate = function(appData, popupType) {
  this.doc = appData;
  if (popupType == PopupTypes.STARTUP_RESOURCES) this.open()
};
ResourceManagerDialog.prototype.getPreferredContentSize = function(maxW, maxH) {
  return {
    width: Math.min(DIALOG_WIDTH_PX, maxW),
    height: Math.min(DIALOG_HEIGHT_PX, maxH)
  }
};
ResourceManagerDialog.prototype.open = function(currentDoc, dialogPayload) {
  const storedFiles = this.doc.startupResourceStore.storedFiles;
  this.sortedResourceKeys = Object.keys(storedFiles).sort(compareStoredResourceFileNames);
  this.selectedResourceIndex = -1;
  let totalBytes = 0;
  for (let keyIdx = 0; keyIdx < this.sortedResourceKeys.length; keyIdx++) {
    totalBytes += storedFiles[this.sortedResourceKeys[keyIdx]].byteLength
  }
  this.totalStoredBytesSum = totalBytes;
  this.buildUI()
};

/** One row per stored file: kind badge, name, size. Empty state when there are none. */
ResourceManagerDialog.prototype.renderResourceRows = function() {
  const storedFiles = this.doc == null ? {} : this.doc.startupResourceStore.storedFiles;
  clearElement(this.resourceListEl);
  this.rowElements = [];
  if (this.sortedResourceKeys.length === 0) {
    const emptyEl = makeElement("p", "resmgr-empty");
    emptyEl.textContent = Locale.get("dialogs.resourceManager.empty");
    this.resourceListEl.appendChild(emptyEl);
    this.syncDeleteButtonEnabled();
    return
  }
  for (let keyIdx = 0; keyIdx < this.sortedResourceKeys.length; keyIdx++) {
    const resourceKey = this.sortedResourceKeys[keyIdx];
    const rowEl = makeElement("div", "resmgr-row");
    rowEl.setAttribute("title", resourceKey);
    const kindEl = makeElement("span", "resmgr-kind");
    kindEl.textContent = fileKindLabel(resourceKey);
    rowEl.appendChild(kindEl);
    const nameEl = makeElement("span", "resmgr-name");
    nameEl.textContent = resourceKey;
    rowEl.appendChild(nameEl);
    const sizeEl = makeElement("span", "resmgr-size");
    sizeEl.textContent = formatByteSize(storedFiles[resourceKey].byteLength);
    rowEl.appendChild(sizeEl);
    rowEl.addEventListener("click", this.onResourceRowClick, false);
    this.rowElements.push(rowEl);
    this.resourceListEl.appendChild(rowEl)
  }
  this.syncSelectedRowClass();
  this.syncDeleteButtonEnabled()
};
ResourceManagerDialog.prototype.onResourceRowClick = function(clickEvent) {
  this.selectedResourceIndex = this.rowElements.indexOf(clickEvent.currentTarget);
  this.syncSelectedRowClass();
  this.syncDeleteButtonEnabled()
};
ResourceManagerDialog.prototype.syncSelectedRowClass = function() {
  for (let rowIdx = 0; rowIdx < this.rowElements.length; rowIdx++) {
    const isSelected = rowIdx === this.selectedResourceIndex;
    if (isSelected) addClass(this.rowElements[rowIdx], "selected");
    else removeClass(this.rowElements[rowIdx], "selected")
  }
};
ResourceManagerDialog.prototype.syncDeleteButtonEnabled = function() {
  const buttonEl = this.deleteSelectedResourceButton.el;
  if (this.selectedResourceIndex === -1) addClass(buttonEl, "disabled");
  else removeClass(buttonEl, "disabled")
};
ResourceManagerDialog.prototype.deleteSelectedStoredResource = function(clickEvent) {
  if (this.selectedResourceIndex === -1) {
    showToast(Locale.get("dialogs.resourceManager.selectFileFirst"));
    return
  }
  const storedFiles = this.doc.startupResourceStore.storedFiles;
  delete storedFiles[this.sortedResourceKeys[this.selectedResourceIndex]];
  this.selectedResourceIndex = -1;
  const dispatchEvent = new AppEvent(EventType.uiDispatch, true);
  dispatchEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.STARTUP_RESOURCES
  };
  this.dispatch(dispatchEvent)
};

export { ScriptDialog, ResourceManagerDialog, SCRIPT_DEMO_SNIPPETS };
