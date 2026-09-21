/**
 * Duplicate-into and color-range selection dialogs.
 */

import { Locale } from "../../core/i18n/locale.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Document } from "../../document/model/document.js";
import { Layer } from "../../document/model/layer.js";
import { ToolId, EventChannel } from "../../document/model/tool-base.js";
import { TextRangeInput } from "../widgets/controls/number-inputs.js";
import { ButtonMenu, Dropdown } from "../widgets/controls/popup-controls.js";
import { Button, Checkbox, TextInput } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { appendBreak, getDevicePixelRatio, makeElement, setElementCssSizeForDeviceRatio } from "../../core/dom.js";
import { iconImgHtml } from "../../assets/icon-registry.js";
import { AppEvent } from "../../core/event-bus.js";
import { TransformToolBase } from "../../document/transform/transform-static.js";
import { transformPixels } from "../../document/render/raster-transform.js";
import { SelectTool } from "../../document/tools/selection-tools.js";
import { allocBuffer, extractChannel, fillBuffer } from "../../engine/compositing/buffer-utils.js";
import { rgbToLab } from "../../engine/compositing/color-math.js";

function clampDocumentPixelCoordinate(pixelCoord, docExtent) {
  return Math.max(0, Math.min(docExtent - 1, Math.floor(pixelCoord)));
}

function DuplicateIntoDialog() {
  BaseDialog.call(this, "dialogs.duplicateInto", "duplinto");
  this.sourceDocument = null;
  this.targetDocuments = null;
  const formDiv = makeElement("div", "form");
  formDiv.setAttribute("style", "max-width:26em");
  this.body.appendChild(formDiv);
  this.destinationDropdown = new Dropdown("properties.destination", ["abc", "def"]);
  this.destinationDropdown.on(EventType.widgetSelect, this.onDestinationChange, this);
  formDiv.appendChild(this.destinationDropdown.el);
  appendBreak(formDiv);
  this.newDocumentNameInput = new TextInput("properties.name", null, 14);
  formDiv.appendChild(this.newDocumentNameInput.el);
  this.okBtn = new Button("clipboard.ok", true, null, true);
  this.okBtn.on("click", this.onOK, this);
  formDiv.appendChild(this.okBtn.el)
}
DuplicateIntoDialog.prototype = Object.create(BaseDialog.prototype);
DuplicateIntoDialog.prototype.constructor = DuplicateIntoDialog;
DuplicateIntoDialog.prototype.isActive = function() {
  return true
};
DuplicateIntoDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.destinationDropdown.buildUI();
  this.newDocumentNameInput.buildUI()
};
DuplicateIntoDialog.prototype.onDestinationChange = function(widgetEvent) {
  const selectedDestinationIndex = this.destinationDropdown.getValue();
  if (selectedDestinationIndex == this.targetDocuments.length) this.newDocumentNameInput.enable();
  else this.newDocumentNameInput.disable()
};
DuplicateIntoDialog.prototype.open = function(currentDoc, dialogPayload, openDocs) {
  this.sourceDocument = currentDoc;
  this.targetDocuments = openDocs;
  this.newDocumentNameInput.setValue(currentDoc.selectedLayerIndices.length == 0 ? "Layer" : currentDoc.layers[currentDoc.selectedLayerIndices[0]].getName());
  const docNameItems = [];
  for (let docIdx = 0; docIdx < openDocs.length; docIdx++) docNameItems.push(openDocs[docIdx].name);
  docNameItems.push("dialogs.newProject");
  this.destinationDropdown.setItems(docNameItems);
  this.destinationDropdown.setValue(openDocs.indexOf(currentDoc));
  this.onDestinationChange(null)
};
DuplicateIntoDialog.prototype.onOK = function(clickEvent) {
  const destinationIndex = this.destinationDropdown.getValue();
  if (destinationIndex == this.targetDocuments.length) {
    const newPsdDoc = new Document(this.newDocumentNameInput.getValue() + ".psd");
    newPsdDoc.width = this.sourceDocument.width;
    newPsdDoc.height = this.sourceDocument.height;
    newPsdDoc.buffer = allocBuffer(newPsdDoc.width * newPsdDoc.height * 4);
    const backgroundLayer = newPsdDoc.newLayer();
    backgroundLayer.setName("Background");
    newPsdDoc.setLayers([backgroundLayer]);
    const focusTabEvent = new AppEvent(EventType.uiDispatch, true);
    focusTabEvent.fromDialog = true;
    focusTabEvent.data = {
      dispatchKind: UiCommand.focusDocumentTab,
      openedDocument: newPsdDoc
    };
    this.dispatch(focusTabEvent)
  }
  const duplicatedLayerIds = this.sourceDocument.duplicateLayers(null, this.sourceDocument != this.targetDocuments[destinationIndex]),
    layerDupEvent = new AppEvent(EventType.documentAction, true);
  layerDupEvent.data = {
    actionKind: Layer.pasteLayers,
    layersToInsert: duplicatedLayerIds,
    sourceDocument: this.sourceDocument,
    targetDocument: this.targetDocuments[destinationIndex]
  };
  layerDupEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
  layerDupEvent.fromDialog = true;
  this.dispatch(layerDupEvent);
  this.close()
};

function ColorRangeDialog() {
  BaseDialog.call(this, "select.colourRange", "crange");
  this.colorPickSourceDocument = null;
  this.colorRangeLowHslBounds = {
    labL: 73,
    labA: 4.45,
    labB: 4
  };
  this.colorRangeHighHslBounds = {
    labL: 73,
    labA: 4.45,
    labB: 4
  };
  const formDiv = makeElement("div", "form");
  formDiv.setAttribute("style", "width:18em");
  this.body.appendChild(formDiv);
  this.colorFuzzinessRangeInput = new TextRangeInput("properties.fuzziness", 0, 200);
  this.colorFuzzinessRangeInput.setValue(40);
  this.colorFuzzinessRangeInput.on(EventType.widgetSelect, this.redraw, this);
  formDiv.appendChild(this.colorFuzzinessRangeInput.el);
  this.offscreenCanvas = makeElement("canvas", "crange-preview");
  formDiv.appendChild(this.offscreenCanvas);
  // Sampling mode and Invert share the row under the preview: three eyedroppers
  // for how the next click combines with the range, then what to do with it.
  const pickRowEl = makeElement("div", "crange-pickrow");
  formDiv.appendChild(pickRowEl);
  this.colorRangeMaskBlendMenu = new ButtonMenu(null, [
    iconImgHtml("tools/eyedropper", "", "autoscale gsicon"),
    iconImgHtml("tools/eyedropper_add", "", "autoscale gsicon"),
    iconImgHtml("tools/eyedropper_rm", "", "autoscale gsicon")
  ], [
    "select.colourRangeSample", "select.colourRangeAdd", "select.colourRangeSubtract"
  ]);
  pickRowEl.appendChild(this.colorRangeMaskBlendMenu.el);
  this.invertSelectionCheckbox = new Checkbox("adjustments.invert");
  this.invertSelectionCheckbox.on(EventType.widgetSelect, this.redraw, this);
  pickRowEl.appendChild(this.invertSelectionCheckbox.el);
  this.confirmColorRangeSelectionButton = new Button("clipboard.ok", true, null, true);
  this.confirmColorRangeSelectionButton.on("click", this.onOK, this);
  this.body.appendChild(this.confirmColorRangeSelectionButton.el)
}
ColorRangeDialog.prototype = Object.create(BaseDialog.prototype);
ColorRangeDialog.prototype.constructor = ColorRangeDialog;
ColorRangeDialog.prototype.canOpen = function(currentDoc, dialogPayload) {
  return currentDoc != null
};
ColorRangeDialog.prototype.hasOverlay = function() {
  return true
};
ColorRangeDialog.prototype.isActive = function() {
  return true
};
ColorRangeDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.colorFuzzinessRangeInput.buildUI();
  this.colorRangeMaskBlendMenu.buildUI();
  this.invertSelectionCheckbox.buildUI()
};
ColorRangeDialog.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  const docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
  this.pickColorAtDocumentPixel(docPoint.x, docPoint.y)
};
ColorRangeDialog.prototype.pickColorAtDocumentPixel = function(pixelX, pixelY) {
  const min = Math.min,
    max = Math.max,
    sourceDocument = this.colorPickSourceDocument,
    clampedPixelX = clampDocumentPixelCoordinate(pixelX, sourceDocument.width),
    clampedPixelY = clampDocumentPixelCoordinate(pixelY, sourceDocument.height),
    rasterPixels = sourceDocument.getRasterData(),
    pixelOffset = (clampedPixelY * sourceDocument.width + clampedPixelX) * 4,
    red = rasterPixels[pixelOffset],
    green = rasterPixels[pixelOffset + 1],
    blue = rasterPixels[pixelOffset + 2],
    pickedLabColor = rgbToLab(red, green, blue),
    blendModeIndex = this.colorRangeMaskBlendMenu.getValue(),
    lowBounds = this.colorRangeLowHslBounds,
    highBounds = this.colorRangeHighHslBounds;
  if (blendModeIndex == 0) {
    this.colorRangeLowHslBounds = JSON.parse(JSON.stringify(pickedLabColor));
    this.colorRangeHighHslBounds = pickedLabColor
  } else if (blendModeIndex == 1) {
    lowBounds.labL = min(lowBounds.labL, pickedLabColor.labL);
    lowBounds.labA = min(lowBounds.labA, pickedLabColor.labA);
    lowBounds.labB = min(lowBounds.labB, pickedLabColor.labB);
    highBounds.labL = max(highBounds.labL, pickedLabColor.labL);
    highBounds.labA = max(highBounds.labA, pickedLabColor.labA);
    highBounds.labB = max(highBounds.labB, pickedLabColor.labB)
  } else if (blendModeIndex == 2) {
    const midLabL = (lowBounds.labL + highBounds.labL) / 2,
      midLabA = (lowBounds.labA + highBounds.labA) / 2,
      midLabB = (lowBounds.labB + highBounds.labB) / 2;
    if (pickedLabColor.labL < midLabL) lowBounds.labL = max(lowBounds.labL, pickedLabColor.labL + 10);
    else highBounds.labL = min(highBounds.labL, pickedLabColor.labL - 10);
    if (pickedLabColor.labA < midLabA) lowBounds.labA = max(lowBounds.labA, pickedLabColor.labA + 1);
    else highBounds.labA = min(highBounds.labA, pickedLabColor.labA - 1);
    if (pickedLabColor.labB < midLabB) lowBounds.labB = max(lowBounds.labB, pickedLabColor.labB + 1);
    else highBounds.labB = min(highBounds.labB, pickedLabColor.labB - 1)
  }
  this.redraw()
};
ColorRangeDialog.prototype.onOK = function(clickEvent) {
  const colorRangeEvent = new AppEvent(EventType.documentAction, true);
  colorRangeEvent.routingChannel = ToolId.TOOL_RECT_SELECT;
  colorRangeEvent.data = {
    actionKind: "crange",
    labMin: this.colorRangeLowHslBounds,
    labMax: this.colorRangeHighHslBounds,
    fuzziness: this.colorFuzzinessRangeInput.getValue() / 200,
    invert: this.invertSelectionCheckbox.getValue()
  };
  colorRangeEvent.fromDialog = true;
  this.dispatch(colorRangeEvent);
  this.close()
};
ColorRangeDialog.prototype.open = function(currentDoc, dialogPayload) {
  this.colorPickSourceDocument = currentDoc;
  this.pickColorAtDocumentPixel(0, 0)
};
ColorRangeDialog.prototype.redraw = function() {
  const sourceDocument = this.colorPickSourceDocument;
  let colorRangeSelection = SelectTool.buildColorRangeSelection(
    sourceDocument, this.colorRangeLowHslBounds, this.colorRangeHighHslBounds,
    this.colorFuzzinessRangeInput.getValue() / 200);
  // The preview shows what OK will select, invert included.
  if (this.invertSelectionCheckbox.getValue()) {
    colorRangeSelection = SelectTool.invertSelectionOverCanvas(colorRangeSelection, sourceDocument);
  }
  const selectionRect = colorRangeSelection.rect,
    selectionChannel = colorRangeSelection.channel,
    previewCanvas = this.offscreenCanvas,
    canvasCtx = previewCanvas.getContext("2d"),
    canvasWidth = Math.floor(230 * getDevicePixelRatio()),
    canvasHeight = Math.floor(canvasWidth * (selectionRect.height / selectionRect.width));
  previewCanvas.width = canvasWidth;
  previewCanvas.height = canvasHeight;
  setElementCssSizeForDeviceRatio(previewCanvas, canvasWidth, canvasHeight);
  const previewBuffer = allocBuffer(selectionChannel.length * 4);
  fillBuffer(previewBuffer, 4294967295);
  for (let channelIdx = 0; channelIdx < 3; channelIdx++) extractChannel(selectionChannel, previewBuffer, channelIdx);
  const scaledTransformResult = transformPixels([previewBuffer, selectionRect], new Matrix2D(canvasWidth / selectionRect.width, 0, 0, canvasHeight / selectionRect.height, 0, 0)),
    scaledRect = scaledTransformResult.rect,
    previewImageData = new ImageData(new Uint8ClampedArray(scaledTransformResult.buffer.buffer), scaledRect.width, scaledRect.height);
  canvasCtx.putImageData(previewImageData, 0, 0)
};

export { DuplicateIntoDialog, ColorRangeDialog };
