/**
 * Export Assets, Export Color LUT, and Save for Web dialogs.
 */

import { Locale } from "../../core/i18n/locale.js";
import { formatByteSize, stripFileExtension } from "../../core/file-names.js";
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { FileFormatRegistry } from "../../document/formats/registry/file-format-registry.js";

import { ColorLookupParser } from "../../features/adjustments/color-lookup-file.js";
import { FileLoader } from "../shell/file-loader.js";
import { ensureFormatLoaders, hasFormatLoaders } from "../../document/formats/registry/format-loader-imports.js";
import { SliderDropdown } from "../widgets/controls/number-inputs.js";
import { PanelTab, PanelWrapper } from "../widgets/controls/panel-widgets.js";
import { ButtonMenu, Dropdown, RadioGroup, RadioOption } from "../widgets/controls/popup-controls.js";
import { LayerEffectOption } from "../widgets/controls/stroke-layer-controls.js";
import { Button, Checkbox, Label } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, appendBreak, appendHorizontalRule, clearElement, getDevicePixelRatio, makeElement } from "../../core/dom.js";
import { confirmUser, showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";
import { MoveTool } from "../../document/tools/move-tools.js";
import { SliceTool } from "../../document/transform/slice-tools.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { copyPixels } from "../../engine/compositing/pixel-ops.js";
import { subtractRects } from "../../engine/compositing/geometry.js";

/** Which layers {@link ExportAssetsDialog} writes, in radio-row order. */
const EXPORT_SCOPE_SELECTED = 0;
const EXPORT_SCOPE_PREFIXED = 1;
const EXPORT_SCOPE_ALL = 2;

function ExportAssetsDialog() {
  BaseDialog.call(this, "file.exportLayers", "eassets");
  this.doc = null;
  this.sourceDocument = null;
  const formDiv = makeElement("div", "form");
  formDiv.setAttribute("style", "width:32em");
  this.body.appendChild(formDiv);
  this.layerScopeRadioGroup = new RadioGroup(null, [
    "dialogs.exportLayers.scopeSelectedLayers",
    "dialogs.exportLayers.onlyDashENamed",
    "dialogs.exportLayers.scopeAllLayers"
  ]);
  this.layerScopeRadioGroup.setValue(EXPORT_SCOPE_PREFIXED);
  this.layerScopeRadioGroup.on(EventType.widgetSelect, this.rebuild, this);
  // The three scopes are one choice, so they sit together in their own box
  // with the count of what the current scope covers.
  const scopeGroupEl = makeElement("div", "optiongroup");
  scopeGroupEl.appendChild(this.layerScopeRadioGroup.el);
  this.exportableLayersSummaryEl = makeElement("div", "optiongroup-note");
  scopeGroupEl.appendChild(this.exportableLayersSummaryEl);
  formDiv.appendChild(scopeGroupEl);
  this.trimOptionCheckboxes = [new Checkbox("dialogs.exportLayers.removeOutsideCanvas"), new Checkbox("dialogs.exportLayers.trimTransparent")];
  for (let optionIdx = 0; optionIdx < this.trimOptionCheckboxes.length; optionIdx++) {
    const checkbox = this.trimOptionCheckboxes[optionIdx];
    checkbox.setValue(true);
    checkbox.on(EventType.widgetSelect, this.rebuild, this);
    formDiv.appendChild(checkbox.el);
    appendBreak(formDiv)
  }
  this.scaleRadioGroup = new RadioOption("properties.size.title", ["1x", "2x", "3x", "4x"]);
  this.scaleRadioGroup.setValue([true, false, false, false]);
  formDiv.appendChild(this.scaleRadioGroup.el);
  appendHorizontalRule(formDiv);
  this.exportFormatLabels = ["PNG", "JPG", "SVG"];
  this.formatDropdown = new Dropdown("properties.format", this.exportFormatLabels);
  this.formatDropdown.on(EventType.widgetSelect, this.syncFormatPanelFromDropdown, this);
  formDiv.appendChild(this.formatDropdown.el);
  this.formatPanelTab = new PanelTab();
  formDiv.appendChild(this.formatPanelTab.el);
  this.exportLayersButton = new Button("file.exportLayers", true, null, true);
  this.exportLayersButton.on("click", this.onOK, this);
  formDiv.appendChild(this.exportLayersButton.el);
  this.on("closebtn", this.onExportDialogClose, this)
}
ExportAssetsDialog.prototype = Object.create(BaseDialog.prototype);
ExportAssetsDialog.prototype.constructor = ExportAssetsDialog;
ExportAssetsDialog.prototype.canOpen = function(doc) {
  return doc != null
};
ExportAssetsDialog.prototype.syncFormatPanelFromDropdown = function(widgetEvent) {
  this.formatPanelTab.setFormatContext(this.exportFormatLabels[this.formatDropdown.getValue()])
};
ExportAssetsDialog.prototype.onExportDialogClose = function(closeEvent) {
  this.sourceDocument = null
};
ExportAssetsDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.formatDropdown.buildUI();
  this.layerScopeRadioGroup.buildUI();
  this.scaleRadioGroup.buildUI();
  this.exportLayersButton.buildUI();
  this.formatPanelTab.buildUI()
};
ExportAssetsDialog.prototype.open = function(doc, dialogData, openDocs) {
  this.sourceDocument = doc;
  this.rebuild()
};
ExportAssetsDialog.prototype.rebuild = function() {
  const exportableLayerIndices = this.getExportableLayerIndices();
  // Substitution values go back through Locale.get, which takes strings.
  this.exportableLayersSummaryEl.textContent =
    Locale.get(["dialogs.exportLayers.exportableCount", String(exportableLayerIndices.length)]);
  this.syncFormatPanelFromDropdown(null)
};
/**
 * Layer indices the chosen scope covers. "All layers" takes every non-empty
 * pixel layer plus any "-e-" row (groups included); the "-e-" scope takes only
 * those rows; "Only selected layers" takes the document's layer selection.
 */
ExportAssetsDialog.prototype.getExportableLayerIndices = function() {
  const layerScope = this.layerScopeRadioGroup.getValue(),
    exportableIndices = [],
    sourceDoc = this.sourceDocument;
  if (sourceDoc == null || sourceDoc.layers == null) return exportableIndices;
  if (layerScope == EXPORT_SCOPE_SELECTED) {
    const selectedIndices = sourceDoc.selectedLayerIndices || [];
    for (let selectionIdx = 0; selectionIdx < selectedIndices.length; selectionIdx++) {
      if (sourceDoc.layers[selectedIndices[selectionIdx]] != null) {
        exportableIndices.push(selectedIndices[selectionIdx]);
      }
    }
    return exportableIndices
  }
  const includeEveryLayer = layerScope == EXPORT_SCOPE_ALL;
  for (let layerIdx = 0; layerIdx < sourceDoc.layers.length; layerIdx++) {
    const layer = sourceDoc.layers[layerIdx],
      layerName = layer.getName();
    if (includeEveryLayer && !layer.isGroup() && !layer.rect.isEmpty() || layerName.startsWith("-e")) {
      exportableIndices.push(layerIdx)
    }
  }
  return exportableIndices
};
ExportAssetsDialog.prototype.onUpdate = function(appData, popupType) {
  this.doc = appData
};
ExportAssetsDialog.prototype.onOK = function() {
  const sourceDoc = this.sourceDocument;
  if (sourceDoc == null) {
    showToast(Locale.get("brushAndMessages.toolHints.openADocumentFirst"));
    return
  }
  const formatLabels = [this.exportFormatLabels[this.formatDropdown.getValue()]],
    formatOptions = [this.formatPanelTab.getValue()],
    scaleFlags = this.scaleRadioGroup.getValue(),
    zipEntries = {},
    nameCollisionCounts = {},
    exportableIndices = this.getExportableLayerIndices();
  if (exportableIndices.length == 0) {
    showToast(Locale.get("dialogs.exportLayers.noLayers"));
    return
  }
  const trimFlags = [this.trimOptionCheckboxes[0].getValue(), this.trimOptionCheckboxes[1].getValue()];
  for (let exportIdx = 0; exportIdx < exportableIndices.length; exportIdx++) {
    const layerIndex = exportableIndices[exportIdx],
      layer = sourceDoc.layers[layerIndex];
    let layerName = layer.getName();
    if (nameCollisionCounts[layerName] != null) {
      nameCollisionCounts[layerName]++;
      layerName += " " + nameCollisionCounts[layerName]
    } else nameCollisionCounts[layerName] = 1;
    const wasVisible = layer.isVisible();
    layer.setVisible(true);
    for (let scaleIdx = 0; scaleIdx < scaleFlags.length; scaleIdx++) {
      if (!scaleFlags[scaleIdx]) continue;
      const scaleFactor = scaleIdx + 1,
        encodedLayers = MoveTool.exportDocumentLayers(sourceDoc, formatLabels, scaleFactor, this.doc, layerIndex, formatOptions, trimFlags);
      for (let formatIdx = 0; formatIdx < formatLabels.length; formatIdx++) {
        const formatLabel = formatLabels[formatIdx],
          assetFilename = layerName.slice(layerName.startsWith("-e-") ? 3 : 0) + (scaleFactor == 1 ? "" : "-" + scaleFactor + "x") + "." + formatLabel.toLowerCase();
        if (encodedLayers[formatIdx]) zipEntries[assetFilename] = new Uint8Array(encodedLayers[formatIdx])
      }
    }
    layer.setVisible(wasVisible)
  }
  const zipBytes = UZIP.encode(zipEntries),
    dispatchEvent = new AppEvent(EventType.uiDispatch, true);
  dispatchEvent.data = {
    dispatchKind: UiCommand.downloadBlobSaveAs,
    data: zipBytes,
    name: "assets.zip"
  };
  this.dispatch(dispatchEvent)
};

function ExportColorLUTDialog() {
  BaseDialog.call(this, "dialogs.exportColourLookupTables", "exlut");
  this.doc = null;
  this.lutSourceDocument = null;
  const formDiv = makeElement("div", "form");
  formDiv.setAttribute("style", "width:20em");
  this.body.appendChild(formDiv);
  this.lutExportOptionWidgets = [new SliderDropdown("properties.gridPoints", 1, 256), new ButtonMenu("properties.format", [".CUBE"])];
  const defaultWidgetValues = [16, 0];
  for (let widgetIdx = 0; widgetIdx < this.lutExportOptionWidgets.length; widgetIdx++) {
    const optionWidget = this.lutExportOptionWidgets[widgetIdx];
    optionWidget.setValue(defaultWidgetValues[widgetIdx]);
    optionWidget.parent = this;
    optionWidget.on(EventType.widgetSelect, this.rebuild, this);
    formDiv.appendChild(optionWidget.el);
    appendBreak(formDiv)
  }
  this.exportLutOkButton = new Button("clipboard.ok", true, null, true);
  this.exportLutOkButton.on("click", this.onOK, this);
  formDiv.appendChild(this.exportLutOkButton.el);
  this.on("closebtn", this.onCloseClearLutDocument, this)
}
ExportColorLUTDialog.prototype = Object.create(BaseDialog.prototype);
ExportColorLUTDialog.prototype.constructor = ExportColorLUTDialog;
ExportColorLUTDialog.prototype.canOpen = function(currentDoc, dialogPayload) {
  if (Math.min(currentDoc.width, currentDoc.height) < 16) {
    showToast(Locale.get("dialogs.exportLut.minSize"));
    return false
  }
  if (currentDoc.layers.length < 2) {
    showToast(Locale.get("dialogs.exportLut.needBgAndAdjustments"));
    return false
  }
  return true
};
ExportColorLUTDialog.prototype.onCloseClearLutDocument = function(closeEvent) {
  this.lutSourceDocument = null
};
ExportColorLUTDialog.prototype.onUpdate = function(appData, popupType) {
  this.doc = appData
};
ExportColorLUTDialog.prototype.open = function(currentDoc, dialogPayload, openDocs) {
  this.lutSourceDocument = currentDoc
};
ExportColorLUTDialog.prototype.onOK = function() {
  const lutDoc = this.lutSourceDocument,
    gridSize = this.lutExportOptionWidgets[0].getValue(),
    cubeSamples = [],
    fullDocRect = new Rect(0, 0, lutDoc.width, lutDoc.height),
    sliceBuffer = allocBuffer(gridSize * gridSize * 4),
    sampleScratch = sliceBuffer.slice(0),
    sampleRect = new Rect(lutDoc.width - gridSize >>> 1, lutDoc.height - gridSize >>> 1, gridSize, gridSize),
    backgroundLayer = lutDoc.layers[0],
    savedBuffer = backgroundLayer.buffer,
    savedRect = backgroundLayer.rect;
  backgroundLayer.rect = sampleRect;
  backgroundLayer.buffer = sliceBuffer;
  for (let sliceIdx = 0; sliceIdx < gridSize; sliceIdx++) {
    this.fillNeutralRgbGradientSliceBuffer(gridSize, sliceIdx, sliceBuffer);
    backgroundLayer.markDirty(sampleRect);
    lutDoc.markDirty(sampleRect);
    const rasterData = lutDoc.getRasterData();
    copyPixels(rasterData, fullDocRect, sampleScratch, sampleRect);
    for (let rowIdx = 0; rowIdx < gridSize; rowIdx++)
      for (let colIdx = 0; colIdx < gridSize; colIdx++) {
        const pixelOffset = rowIdx * gridSize + colIdx << 2;
        cubeSamples.push(sampleScratch[pixelOffset] / 255, sampleScratch[pixelOffset + 1] / 255, sampleScratch[pixelOffset + 2] / 255)
      }
  }
  const cubeBytes = ColorLookupParser.serializeCube(cubeSamples, gridSize, lutDoc.name);
  FileLoader.save(cubeBytes, stripFileExtension(lutDoc.name) + ".CUBE");
  backgroundLayer.buffer = savedBuffer;
  backgroundLayer.rect = savedRect;
  backgroundLayer.markDirty();
  lutDoc.markDirty()
};
ExportColorLUTDialog.prototype.fillNeutralRgbGradientSliceBuffer = function(gridSize, sliceIndex, rgbaBuffer) {
  const channelStep = 255 / (gridSize - 1),
    blueValue = Math.round(sliceIndex * channelStep);
  for (let rowIdx = 0; rowIdx < gridSize; rowIdx++)
    for (let colIdx = 0; colIdx < gridSize; colIdx++) {
      const pixelOffset = rowIdx * gridSize + colIdx << 2;
      rgbaBuffer[pixelOffset] = Math.round(colIdx * channelStep);
      rgbaBuffer[pixelOffset + 1] = Math.round(rowIdx * channelStep);
      rgbaBuffer[pixelOffset + 2] = blueValue;
      rgbaBuffer[pixelOffset + 3] = 255
    }
};
ExportColorLUTDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  for (let widgetIdx = 0; widgetIdx < this.lutExportOptionWidgets.length; widgetIdx++) this.lutExportOptionWidgets[widgetIdx].buildUI()
};

/** Longest edge of the fixed preview frame, and the chrome it shares its row with. */
const PREVIEW_MAX_EDGE_PX = 512;
const PREVIEW_WIDTH_INSET_PX = 240;
const PREVIEW_HEIGHT_INSET_PX = 120;

/**
 * Seed the native Save dialog with the folder the document was read from, so an
 * export of an opened file starts next to that file rather than wherever the
 * last export went.
 */
function saveDialogOptionsForDocument(doc) {
  return {
    directoryKey: "lastExportDirectory",
    defaultDirectory: doc.nativeFilePath ? doc.nativeFilePath.replace(/[/\\][^/\\]*$/, "") : null
  };
}

/** The document's own composite: what a PSD or PSB stores for other apps to read. */
const PREVIEW_FROM_DOCUMENT = "document";
/** Handed to the webview, which renders SVG and PDF itself. */
const PREVIEW_FROM_VIEWER = "viewer";
/** Decoded back from the bytes just written, so the options can be seen at work. */
const PREVIEW_FROM_DECODE = "decode";
/** Writers whose output this app cannot render back (EMF, DXF, camera raw). */
const PREVIEW_NONE = "none";

/**
 * How the left column shows a format. Only a decoded preview answers "what did
 * these options do to my image"; PSD and PSB have no such question — they store
 * the document itself, so what they show is the document's own composite.
 */
export function previewModeForFormat(formatId, formatHandler) {
  if (FileFormatRegistry.documentSaveFormatIds.indexOf(formatId) !== -1) {
    return PREVIEW_FROM_DOCUMENT;
  }
  if (formatHandler.noPreviewAvailable) return PREVIEW_NONE;
  return formatHandler.isLayered ? PREVIEW_FROM_VIEWER : PREVIEW_FROM_DECODE;
}

/** Shown under the format row when the chosen format cannot keep the layers. */
const FLATTEN_NOTICE = "Layers will be flattened.";

/** Longest side a PSD can address; past it the document has to be written as PSB. */
const PSD_MAX_EDGE_PX = 30000;

/**
 * Format the dialog opens on. The document's own format wins, so Save As offers
 * the file its own name and type back. Save As falls to PSD (PSB for a document
 * too large for PSD) when the document's format would drop layers or cannot be
 * written at all; Export As, where every format is a rendering, falls to PNG.
 */
export function defaultFormatIndex(formatIds, doc) {
  const fallbackFormat = pickFallbackFormat(formatIds, doc);
  const documentFormat = String(doc.formatType || "").toUpperCase();
  const documentFormatIndex = formatIds.indexOf(documentFormat);
  // Every export format is a rendering, so on Export As the document's own
  // format always wins. Save As keeps it only while it holds the whole document.
  const documentFormatWins =
    documentFormatIndex !== -1 &&
    (fallbackFormat === "PNG" || holdsWholeDocument(documentFormat, doc));
  if (documentFormatWins) return documentFormatIndex;
  return Math.max(0, formatIds.indexOf(fallbackFormat));
}

/** PSD/PSB where the list offers them (Save As), PNG where it does not (Export As). */
function pickFallbackFormat(formatIds, doc) {
  if (formatIds.indexOf("PSD") === -1) return "PNG";
  return holdsWholeDocument("PSD", doc) ? "PSD" : "PSB";
}

/** True when `formatId` can store this document without losing part of it. */
function holdsWholeDocument(formatId, doc) {
  if (formatId === "PSB") return true;
  if (formatId === "PSD") return doc.width <= PSD_MAX_EDGE_PX && doc.height <= PSD_MAX_EDGE_PX;
  return doc.layers == null || doc.layers.length <= 1;
}

function WriteFileDialog() {
  BaseDialog.call(this, "file.exportAs", "writefile");
  this.cachedDocumentDimensionsKey = "";
  /**
   * Save As writes the document's own file: the chosen path and format become
   * the document's and the modified marker clears. Export As writes a rendering
   * and leaves the document pointing at the file it came from.
   */
  this.adoptsDocumentFile = false;
  /** Format ids behind the dropdown rows, in the order they are listed. */
  this.formatIds = FileFormatRegistry.listEncodableFormats();
  this.on("closebtn", function() {
    this.previewPanelWrapper.stopFrameAnimation()
  }, this);
  this.previewMaxDimensions = new Point(512, 512);
  this.exportDocument = null;
  this.encodedFileBytes = null;
  this.decodedPreviewRasters = null;
  this.doc = null;
  addClass(this.body, "flexrow");
  const previewColumn = makeElement("div"),
    optionsColumn = makeElement("div");
  this.body.appendChild(previewColumn);
  this.body.appendChild(optionsColumn);
  this.previewContainer = makeElement("div", "imgcont writefile-preview");
  previewColumn.appendChild(this.previewContainer);
  this.previewPanelWrapper = new PanelWrapper();
  this.previewPanelWrapper.resize(this.previewMaxDimensions.x, this.previewMaxDimensions.y);
  this.outputSizeSummaryEl = makeElement("div", "writefile-summary");
  previewColumn.appendChild(this.outputSizeSummaryEl);
  this.formDiv = makeElement("div", "form cell");
  this.formDiv.setAttribute("style", "width:20em; padding-left:1em;");
  optionsColumn.appendChild(this.formDiv);
  this.outputFormatDropdown = new Dropdown("properties.format", this.formatIds);
  this.formDiv.appendChild(this.outputFormatDropdown.el);
  this.outputFormatDropdown.on(EventType.widgetSelect, this.rebuild, this);
  this.flattenNoticeLabel = new Label("");
  addClass(this.flattenNoticeLabel.el, "writefile-flatten-notice");
  this.formDiv.appendChild(this.flattenNoticeLabel.el);
  this.sizeOption = new LayerEffectOption(true, true, false, true);
  this.sizeOption.on(EventType.widgetSelect, this.rebuild, this);
  this.formDiv.appendChild(this.sizeOption.el);
  this.formatOptionsPanelTab = new PanelTab();
  this.formatOptionsPanelTab.on(EventType.widgetSelect, this.rebuild, this);
  this.formDiv.appendChild(this.formatOptionsPanelTab.el);
  this.saveToFileButton = new Button("file.save", true, null, true);
  this.saveToFileButton.on("click", this.onOK, this);
  this.formDiv.appendChild(this.saveToFileButton.el)
}
WriteFileDialog.prototype = Object.create(BaseDialog.prototype);
WriteFileDialog.prototype.constructor = WriteFileDialog;
WriteFileDialog.prototype.canOpen = function(currentDoc, dialogPayload) {
  return currentDoc != null
};
WriteFileDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.sizeOption.buildUI();
  this.outputFormatDropdown.buildUI();
  this.formatOptionsPanelTab.buildUI();
  this.saveToFileButton.buildUI()
};
WriteFileDialog.prototype.onOK = function(clickEvent) {
  const baseFilename = stripFileExtension(this.exportDocument.name),
    formatId = this.formatIds[this.outputFormatDropdown.getValue()],
    exportDoc = this.exportDocument,
    sliceList = exportDoc.slices;
  let outputBytes = this.encodedFileBytes,
    outputFilename = baseFilename + "." + formatId.toLowerCase();
  // Slices are cut from a rendering and shipped as a zip of images plus an HTML
  // page — an export product, never the document's own file.
  if (!this.adoptsDocumentFile && sliceList.length != 0 && (formatId == "JPG" || formatId == "PNG" || formatId == "GIF") && this.formatOptionsPanelTab.getValue().pop()) {
    const sliceBoundsList = [],
      zipEntries = {},
      fullDocRect = new Rect(0, 0, exportDoc.width, exportDoc.height),
      compositePixels = exportDoc.getRasterData();
    let htmlParts = "<!DOCTYPE html>\n<html>\n<style>div {position:absolute;}</style>\n<head></head>\n<body>\n";
    for (let sliceIdx = 0; sliceIdx < sliceList.length; sliceIdx++) sliceBoundsList.push(SliceTool.readSliceBoundsArray(sliceList, sliceIdx));
    sliceBoundsList.reverse();
    const uncoveredRects = subtractRects([0, 0, exportDoc.width, exportDoc.height], sliceBoundsList);
    for (let rectIdx = 0; rectIdx < uncoveredRects.length; rectIdx++) {
      const boundsArray = uncoveredRects[rectIdx],
        sliceRect = new Rect(boundsArray[0], boundsArray[1], boundsArray[2] - boundsArray[0], boundsArray[3] - boundsArray[1]),
        sliceMetadata = boundsArray.length == 5 ? sliceList[boundsArray[4]].v : null,
        slicePixels = allocBuffer(sliceRect.area() * 4);
      copyPixels(compositePixels, fullDocRect, slicePixels, sliceRect);
      const imagePath = "img/img" + (rectIdx + 1) + "." + formatId.toLowerCase();
      zipEntries[imagePath] = new Uint8Array(FileFormatRegistry.getFormat(formatId).encode([
        [slicePixels.buffer, 0]
      ], sliceRect.width, sliceRect.height, this.formatOptionsPanelTab.getValue()));
      htmlParts += "<div style=\"background-image:url('" + imagePath + "'); left:" + sliceRect.x + "px; top:" + sliceRect.y + "px; width:" + sliceRect.width + "px; height:" + sliceRect.height + "px\">";
      if (sliceMetadata && sliceMetadata.url.v != "") htmlParts += "\n\t<a href=\"" + sliceMetadata.url.v + "\" target=\"" + sliceMetadata.null.v + "\" style=\"display:block;width:100%;height:100%;\"></a>\n";
      htmlParts += "</div>\n"
    }
    htmlParts += "</body>\n</html>\n";
    const htmlBuffer = allocBuffer(Math.round(htmlParts.length * 1.5)),
      htmlByteLength = BinaryUtils.encodeUtf8Into(htmlParts, htmlBuffer, 0);
    zipEntries["index.html"] = htmlBuffer.slice(0, htmlByteLength);
    outputBytes = UZIP.encode(zipEntries);
    outputFilename = baseFilename + ".zip"
  }
  const dispatchEvent = new AppEvent(EventType.uiDispatch, true);
  dispatchEvent.data = this.adoptsDocumentFile
    ? {
        dispatchKind: UiCommand.saveEncodedDocumentAs,
        data: outputBytes,
        formatId: formatId.toLowerCase(),
        targetDocument: exportDoc
      }
    : {
        dispatchKind: UiCommand.downloadBlobSaveAs,
        data: outputBytes,
        name: outputFilename,
        saveOptions: saveDialogOptionsForDocument(exportDoc)
      };
  this.dispatch(dispatchEvent);
  this.previewPanelWrapper.stopFrameAnimation();
  this.close()
};
WriteFileDialog.prototype.open = function(currentDoc, dialogPayload) {
  this.adoptsDocumentFile = dialogPayload.adoptsDocumentFile === true;
  this.formatIds = this.adoptsDocumentFile
    ? FileFormatRegistry.listSaveFormats()
    : FileFormatRegistry.listEncodableFormats();
  this.outputFormatDropdown.setItems(this.formatIds);
  this.outputFormatDropdown.setValue(defaultFormatIndex(this.formatIds, currentDoc));
  this.setTitleLocaleKey(this.adoptsDocumentFile ? "file.saveAs" : "file.exportAs");
  this.saveToFileButton.setLabel(this.adoptsDocumentFile ? "file.save" : "file.export");
  this.exportDocument = currentDoc;
  const dimensionsKey = currentDoc.width + "," + currentDoc.height;
  if (dimensionsKey != this.cachedDocumentDimensionsKey) {
    this.cachedDocumentDimensionsKey = dimensionsKey;
    this.sizeOption.setValue(new Point(currentDoc.width, currentDoc.height), currentDoc.dpi)
  }
  this.formatOptionsPanelTab.resetRebuildCache();
  this.rebuild(null, true)
};
/**
 * Header plus the breathing room kept around the window when its content needs
 * more than the placement inset would otherwise leave.
 */
const DIALOG_CHROME_ALLOWANCE_PX = 82;

/**
 * Measured against the viewport rather than the placement inset. The inset
 * chosen by {@link WriteFileDialog#getOffset} positions the window; it must
 * not cap how tall a format's option set is allowed to make it.
 */
WriteFileDialog.prototype.getPreferredContentSize = function(maxW, maxH) {
  const available = this.availableViewportSize();
  return this.measureBodyContentSize(
    Math.max(maxW, available.x - DIALOG_CHROME_ALLOWANCE_PX),
    Math.max(maxH, available.y - DIALOG_CHROME_ALLOWANCE_PX)
  );
};

/** Space the host gives dialogs, falling back to the window before first layout. */
WriteFileDialog.prototype.availableViewportSize = function() {
  const host = this.parent;
  const width = host && host.viewWidth ? host.viewWidth : window.innerWidth;
  const height = host && host.viewHeight ? host.viewHeight : window.innerHeight;
  return new Point(width, height);
};
WriteFileDialog.prototype.getOffset = function(dialogWidth, dialogHeight) {
  return new Point(Math.max(0, Math.min(150, (dialogWidth - 770) / 2)), Math.max(0, Math.min(150, (dialogHeight - 590) / 2)));
};
WriteFileDialog.prototype.resize = function(dialogWidth, dialogHeight) {
  this.lastDialogInteriorWidth = dialogWidth;
  this.lastDialogInteriorHeight = dialogHeight;
  // The cap comes from the viewport, not from the window being laid out: the
  // window is sized to its content, and a preview measured against it would
  // feed its own size back in.
  const available = this.availableViewportSize();
  this.previewMaxDimensions.x = Math.max(50, Math.min(PREVIEW_MAX_EDGE_PX, available.x - PREVIEW_WIDTH_INSET_PX));
  this.previewMaxDimensions.y = Math.max(50, Math.min(PREVIEW_MAX_EDGE_PX, available.y - PREVIEW_HEIGHT_INSET_PX));
  // This is a viewport, not the dimensions of the encoded image. Keeping it
  // fixed makes every format—including a small ICO and formats without a
  // decoder—occupy the same left-hand column.
  this.previewContainer.style.width = this.previewMaxDimensions.x + "px";
  this.previewContainer.style.height = this.previewMaxDimensions.y + "px";
  if (this.exportDocument == null) return;
  const formatId = this.formatIds[this.outputFormatDropdown.getValue()],
    formatHandler = FileFormatRegistry.getFormat(formatId),
    previewMode = previewModeForFormat(formatId, formatHandler);
  if (previewMode == PREVIEW_FROM_VIEWER) {
    this.previewContainer.firstChild.setAttribute("style", "display:block; width:100%; height:100%; border:0;")
  } else if (previewMode != PREVIEW_NONE) {
    this.previewPanelWrapper.resize(this.previewMaxDimensions.x, this.previewMaxDimensions.y)
  }
  // One line under the preview: the format and its encoded size, with the exact
  // byte count on the tooltip rather than a second, dimmer line beside it.
  const encodedByteLength = this.encodedFileBytes.byteLength;
  this.outputSizeSummaryEl.textContent =
    formatId + " \u00B7 " + formatByteSize(encodedByteLength);
  this.outputSizeSummaryEl.setAttribute("title", encodedByteLength.toLocaleString() + " B")
};
WriteFileDialog.prototype.onUpdate = function(appData, popupType) {
  this.doc = appData
};
WriteFileDialog.prototype.rebuild = function(widgetEvent, isInitialOpen) {
  const exportDoc = this.exportDocument,
    outputSize = this.sizeOption.getValue(),
    formatIndex = this.outputFormatDropdown.getValue(),
    formatId = this.formatIds[formatIndex],
    writesDocumentItself = FileFormatRegistry.documentSaveFormatIds.indexOf(formatId) != -1,
    frameCount = FileFormatRegistry.collectArtboardLayerIndices(exportDoc)[0].length,
    isAnimated = ["GIF", "PNG", "WEBP"].indexOf(formatId) != -1 && frameCount > 1;
  // PSD and PSB store the document as it is: the size controls have nothing to
  // act on, and a rendering of a chosen size is not what gets written.
  this.sizeOption.el.style.display = writesDocumentItself ? "none" : "";
  this.flattenNoticeLabel.setValue(
    !writesDocumentItself && exportDoc.layers.length > 1 ? FLATTEN_NOTICE : ""
  );
  let outputWidth = writesDocumentItself ? exportDoc.width : outputSize.x,
    outputHeight = writesDocumentItself ? exportDoc.height : outputSize.y,
    previewStyleSuffix = "",
    fitPreviewToColumn = false;
  if (isAnimated && isInitialOpen && (frameCount > 4 && outputWidth * outputHeight > 1024 * 1024 || outputWidth * outputHeight * frameCount > 800 * 800 * 50)) {
    let scaleShift = 1;
    while (Math.max(outputWidth >>> scaleShift, outputHeight >>> scaleShift) > 800) scaleShift++;
    const userConfirmedScale = confirmUser("Your animation is large (" + outputWidth + " x " + outputHeight + " px). Press \"OK\" to scale it to " + (100 >>> scaleShift) + "%. Press \"Cancel\" to keep the size.");
    if (userConfirmedScale) {
      this.sizeOption.setValue(new Point(outputWidth >>> scaleShift, outputHeight >>> scaleShift), null, true);
      outputWidth = outputWidth >>> scaleShift;
      outputHeight = outputHeight >>> scaleShift
    }
  }
  const artboardDescriptor = exportDoc.add.artd,
    isSingleArtboard = artboardDescriptor == null || artboardDescriptor.Cnt.v == 1;
  this.formatOptionsPanelTab.setFormatContext(
    formatId,
    isAnimated,
    !this.adoptsDocumentFile && exportDoc.slices.length != 0,
    isSingleArtboard
  );
  const formatOptions = this.formatOptionsPanelTab.getValue();
  // The writers share the lazily imported parser modules, so a format this
  // session has never opened has nothing to encode with yet. Fetch it and
  // rebuild once it lands.
  if (!hasFormatLoaders(formatId)) {
    const dialog = this;
    this.encodedFileBytes = null;
    ensureFormatLoaders(formatId).then(function() {
      dialog.rebuild(widgetEvent, isInitialOpen);
    }, function(err) {
      console.error("[file-save] could not load the " + formatId + " writer:", err);
      showToast("Could not save this file: " + String(formatId).toUpperCase() + " support failed to load.");
    });
    return;
  }
  this.encodedFileBytes = FileFormatRegistry.encodeDocument(exportDoc, formatId, outputWidth, outputHeight, formatOptions, this.doc);
  if (this.encodedFileBytes == null) {
    this.exportDocument = null;
    return
  }
  clearElement(this.previewContainer);
  this.previewPanelWrapper.stopFrameAnimation();
  const formatHandler = FileFormatRegistry.getFormat(formatId);
  const previewMode = previewModeForFormat(formatId, formatHandler);
  if (previewMode == PREVIEW_FROM_DOCUMENT) {
    // A PSD carries a flattened composite beside its layers, for apps that read
    // only that. "Blank preview image" is exactly what leaves it out, so this
    // column shows the picture those apps get — or says there is none.
    const documentPreview = formatOptions[0] ? null : exportDoc.getRasterData();
    if (documentPreview == null) {
      const noPreviewEl = makeElement("div", "writefile-no-preview");
      noPreviewEl.textContent = "No preview stored";
      this.previewContainer.appendChild(noPreviewEl)
    } else {
      // The composite buffer is handed over as it stands: the panel reads it
      // through a view, so a full-size document costs no second copy.
      const previewRect = new Rect(0, 0, exportDoc.width, exportDoc.height);
      const previewFrames = this.previewPanelWrapper.frameSources;
      // This preview answers "what will other apps show", which is a question
      // about the whole image, so a new image is fitted to the column. Only a
      // new one: a zoom the user set survives the option checkboxes.
      fitPreviewToColumn = previewFrames == null || !previewFrames[0].rect.equals(previewRect);
      this.previewPanelWrapper.setValue([{ data: documentPreview.buffer, rect: previewRect }], 0);
      this.previewContainer.appendChild(this.previewPanelWrapper.el);
      previewStyleSuffix = "background: rgba(0,0,0,0);"
    }
  } else if (previewMode == PREVIEW_NONE) {
    const noPreviewEl = makeElement("div", "writefile-no-preview");
    noPreviewEl.textContent = "No Preview";
    this.previewContainer.appendChild(noPreviewEl)
  } else if (previewMode == PREVIEW_FROM_VIEWER) {
    let objectUrl;
    if (formatId == "PDF") {
      objectUrl = URL.createObjectURL(new Blob([this.encodedFileBytes], {
        type: "application/pdf"
      }))
    } else {
      objectUrl = URL.createObjectURL(new Blob([this.encodedFileBytes], {
        type: "image/svg+xml"
      }))
    }
    const previewFrame = makeElement("iframe");
    previewFrame.setAttribute("src", objectUrl);
    this.previewContainer.appendChild(previewFrame)
  } else {
    const decodedRasters = this.decodedPreviewRasters = formatHandler.decode(this.encodedFileBytes),
      rasterRect = decodedRasters[0].rect,
      rasterWidth = rasterRect.width,
      rasterHeight = rasterRect.height;
    this.previewPanelWrapper.setValue(decodedRasters, decodedRasters.length > 1 ? formatOptions[formatOptions.length - 3] : 0);
    this.previewContainer.appendChild(this.previewPanelWrapper.el);
    previewStyleSuffix = "background: rgba(0,0,0,0);"
  }
  this.previewContainer.setAttribute("style", "display:block; background-size:" + 16 / getDevicePixelRatio() + "px;" + previewStyleSuffix);
  this.resize(this.lastDialogInteriorWidth, this.lastDialogInteriorHeight);
  // After the resize: the fit is measured against the column's final width, and
  // the preview is scaled once, at the zoom it ends up being drawn at.
  if (fitPreviewToColumn) {
    this.previewPanelWrapper.fitToBounds();
    this.previewPanelWrapper.redraw();
  }
  // Each format brings its own option set, so the window is measured again for
  // the one now shown. The initial open is laid out by the host straight after.
  if (!isInitialOpen) this.relayoutForCurrentOptions()
};

/**
 * Re-measure and re-apply the window size around the options now mounted.
 * Twice: the first pass measures a body whose preview is still sized for the
 * previous format, and applying it gives every part its final size, which the
 * second pass then measures.
 */
WriteFileDialog.prototype.relayoutForCurrentOptions = function() {
  const host = this.parent;
  if (!host || typeof host.layoutDialog !== "function") return;
  host.layoutDialog(this);
  host.layoutDialog(this);
};

export { ExportAssetsDialog, ExportColorLUTDialog, WriteFileDialog };
