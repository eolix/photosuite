/**
 * Raw pixel buffer import dialog with layout guessing and live preview.
 */

import { Locale } from "../../core/i18n/locale.js";
import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { FileFormatRegistry } from "../../document/formats/registry/file-format-registry.js";
import { Layer } from "../../document/model/layer.js";
import { SliderDropdown } from "../widgets/controls/number-inputs.js";
import { ButtonMenu, Dropdown } from "../widgets/controls/popup-controls.js";
import { LayerEffectOption } from "../widgets/controls/stroke-layer-controls.js";
import { Button, Checkbox } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { Mask } from "../../document/model/layer-masks.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { makeElement, setElementCssSizeForDeviceRatio } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { allocBuffer, buildMipPyramidAlpha, extractChannel, grayChannelToRgba } from "../../engine/compositing/buffer-utils.js";

function compareRawLayoutCandidates(candidateA, candidateB) {
  if (candidateB[4] !== candidateA[4]) return candidateB[4] - candidateA[4];
  const aspectA = Math.max(candidateA[0], candidateA[1]) / Math.min(candidateA[0], candidateA[1]);
  const aspectB = Math.max(candidateB[0], candidateB[1]) / Math.min(candidateB[0], candidateB[1]);
  if (aspectA !== aspectB) return aspectA - aspectB;
  return candidateB[0] - candidateA[0];
}

function ImportRawDialog() {
  BaseDialog.call(this, "dialogs.importRaw", "importraw");
  const layoutRow = makeElement("div", "flexrow"),
    guessesRow = makeElement("div");
  guessesRow.setAttribute("style", "margin-bottom: 1em");
  this.body.appendChild(layoutRow);
  this.body.appendChild(guessesRow);
  const leftColumn = makeElement("div", "form");
  leftColumn.setAttribute("style", "width:18em");
  layoutRow.appendChild(leftColumn);
  const rightColumn = makeElement("div", "form");
  rightColumn.setAttribute("style", "width:15em");
  layoutRow.appendChild(rightColumn);
  this.activePath = null;
  this.rawSourceFileName = null;
  this.decodedRgbBuffer = null;
  this.nativeFilePath = null;
  this.localFileHandle = null;
  this.sourceUrl = null;
  this.extraImportedAlphaLayers = null;
  this.rawLayoutCandidateTuples = [];
  const depthLabels = [];
  for (let depthIdx = 0; depthIdx < ImportRawDialog.supportedBitsPerSample.length; depthIdx++) depthLabels.push(ImportRawDialog.supportedBitsPerSample[depthIdx] + " Bits");
  const controlWidgets = this.rawImportControlWidgets = [new LayerEffectOption(true, null, null, true), new SliderDropdown("properties.channels", 1, 8), new Checkbox("properties.lastChannelIsTransparency"), new ButtonMenu("properties.depth", depthLabels), new ButtonMenu("properties.byteOrder", ["12-34", "34-12"]), new Dropdown("properties.guesses", [])];
  for (let widgetIdx = 0; widgetIdx < controlWidgets.length; widgetIdx++) {
    const widget = controlWidgets[widgetIdx];
    widget.parent = this;
    widget.on(EventType.widgetSelect, widgetIdx == 5 ? this.syncControlsToSelectedGuess : this.emitChange, this);
    const widgetHost = widgetIdx == 0 ? leftColumn : widgetIdx == 5 ? guessesRow : rightColumn;
    widgetHost.appendChild(widget.el)
  }
  this.offscreenCanvas = makeElement("canvas");
  this.renderCtx = this.offscreenCanvas.getContext("2d");
  this.body.appendChild(this.offscreenCanvas);
  this.importConfirmButton = new Button("clipboard.ok", true, null, true);
  this.importConfirmButton.on("click", this.onOK, this);
  this.body.appendChild(this.importConfirmButton.el)
}
ImportRawDialog.prototype = Object.create(BaseDialog.prototype);
ImportRawDialog.prototype.constructor = ImportRawDialog;
ImportRawDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  const controlWidgets = this.rawImportControlWidgets;
  for (let widgetIdx = 0; widgetIdx < controlWidgets.length; widgetIdx++) controlWidgets[widgetIdx].buildUI()
};
ImportRawDialog.prototype.onOK = function(clickEvent) {
  this.close();
  const dimensions = this.rawImportControlWidgets[0].getValue(),
    openedDoc = FileFormatRegistry.openFiles(this.rawSourceFileName, [{
      data: this.decodedRgbBuffer,
      rect: new Rect(0, 0, dimensions.x, dimensions.y)
    }]);
  if (this.extraImportedAlphaLayers) openedDoc.extraChannels = this.extraImportedAlphaLayers;
  openedDoc.nativeFilePath = this.nativeFilePath;
  openedDoc.localFileHandle = this.localFileHandle;
  if (this.sourceUrl) openedDoc.sourceUrl = this.sourceUrl;
  const dispatchEvent = new AppEvent(EventType.uiDispatch, true);
  dispatchEvent.data = {
    dispatchKind: UiCommand.focusDocumentTab,
    openedDocument: openedDoc
  };
  this.dispatch(dispatchEvent)
};
ImportRawDialog.supportedBitsPerSample = [8, 16];
ImportRawDialog.prototype.open = function(currentDoc, dialogPayload) {
  this.activePath = new Uint8Array(dialogPayload.fileByteBuffer);
  this.rawSourceFileName = dialogPayload.rawFileName;
  this.nativeFilePath = dialogPayload.nativeFilePath || null;
  this.localFileHandle = dialogPayload.localFileHandle || null;
  this.sourceUrl = dialogPayload.sourceUrl || null;
  const byteLength = this.activePath.length,
    channelCounts = [1, 3, 4],
    layoutCandidates = this.rawLayoutCandidateTuples = [];
  for (let channelIdx = 0; channelIdx < 3; channelIdx++) {
    for (let depthIdx = 0; depthIdx < 2; depthIdx++) {
      const bitsPerSample = ImportRawDialog.supportedBitsPerSample[depthIdx],
        channelCount = channelCounts[channelIdx],
        bitsPerPixel = channelCount * bitsPerSample,
        pixelCount = Math.round(byteLength * 8 / bitsPerPixel);
      if (pixelCount != byteLength * 8 / bitsPerPixel) continue;
      for (let widthGuess = 0; widthGuess <= 4e3; widthGuess++)
        for (let heightGuess = 0; heightGuess <= 4e3; heightGuess++)
          if (widthGuess * heightGuess == pixelCount) {
            let score = 0;
            if (widthGuess == heightGuess) score += 64;
            if (Math.round(widthGuess / 100) == widthGuess / 100 && Math.round(heightGuess / 100) == heightGuess / 100) score += 32;
            if (Math.round(widthGuess / 10) == widthGuess / 10 && Math.round(heightGuess / 10) == heightGuess / 10) score += 16;
            if (Math.round(widthGuess / 2) == widthGuess / 2 && Math.round(heightGuess / 2) == heightGuess / 2) score += 8;
            layoutCandidates.push([widthGuess, heightGuess, channelCount, bitsPerSample, score])
          }
    }
  }
  layoutCandidates.sort(compareRawLayoutCandidates);
  const controlWidgets = this.rawImportControlWidgets,
    guessLabels = [];
  for (let candidateIdx = 0; candidateIdx < layoutCandidates.length; candidateIdx++) {
    const candidate = layoutCandidates[candidateIdx];
    guessLabels.push(candidate[0] + " x " + candidate[1] + ", " + candidate[2] + "ch, " + candidate[3] + "-bit")
  }
  controlWidgets[5].setItems(guessLabels);
  controlWidgets[5].setValue(0);
  this.syncControlsToSelectedGuess(null)
};
ImportRawDialog.prototype.syncControlsToSelectedGuess = function(widgetEvent) {
  const controlWidgets = this.rawImportControlWidgets,
    selectedGuess = this.rawLayoutCandidateTuples[this.rawImportControlWidgets[5].getValue()];
  controlWidgets[0].setValue(new Point(selectedGuess[0], selectedGuess[1]), 72);
  controlWidgets[1].setValue(selectedGuess[2]);
  controlWidgets[3].setValue(ImportRawDialog.supportedBitsPerSample.indexOf(selectedGuess[3]));
  this.emitChange()
};
ImportRawDialog.prototype.emitChange = function(widgetEvent) {
  const controlWidgets = this.rawImportControlWidgets,
    dimensions = controlWidgets[0].getValue(),
    bitsPerSample = ImportRawDialog.supportedBitsPerSample[controlWidgets[3].getValue()];
  let width = dimensions.x,
    height = dimensions.y,
    rawBytes = this.activePath;
  if (bitsPerSample == 16 && controlWidgets[4].getValue() == 1) {
    rawBytes = rawBytes.slice(0);
    for (let bytePairIdx = 0; bytePairIdx < rawBytes.length; bytePairIdx += 2) {
      const lowByte = rawBytes[bytePairIdx];
      rawBytes[bytePairIdx] = rawBytes[bytePairIdx + 1];
      rawBytes[bytePairIdx + 1] = lowByte
    }
  }
  const previewCanvas = this.offscreenCanvas,
    previewCtx = this.renderCtx;
  let rgbaBuffer = this.decodedRgbBuffer = this.decode(rawBytes, width, height, controlWidgets[1].getValue(), bitsPerSample, controlWidgets[2].getValue());
  const mipPyramid = [rgbaBuffer, new Rect(0, 0, width, height)];
  buildMipPyramidAlpha(mipPyramid);
  for (let mipIdx = 0; mipIdx < mipPyramid.length; mipIdx += 2)
    if (mipPyramid[mipIdx + 1].v < 300) {
      rgbaBuffer = mipPyramid[mipIdx];
      width = mipPyramid[mipIdx + 1].width;
      height = mipPyramid[mipIdx + 1].height;
      break
    } previewCanvas.width = width;
  previewCanvas.height = height;
  setElementCssSizeForDeviceRatio(previewCanvas, width, height);
  const imageData = new ImageData(new Uint8ClampedArray(rgbaBuffer.buffer), width, height);
  previewCtx.putImageData(imageData, 0, 0)
};
ImportRawDialog.prototype.decode = function(rawBytes, width, height, channelCount, bitsPerSample, lastChannelIsAlpha) {
  this.extraImportedAlphaLayers = null;
  const channelBuffers = [],
    pixelCount = width * height;
  for (let channelIdx = 0; channelIdx < channelCount; channelIdx++) {
    const channelBuffer = allocBuffer(pixelCount);
    channelBuffers.push(channelBuffer);
    if (bitsPerSample == 8)
      for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) channelBuffer[pixelIdx] = rawBytes[pixelIdx * channelCount + channelIdx];
    else if (bitsPerSample == 16)
      for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) channelBuffer[pixelIdx] = rawBytes[(pixelIdx * channelCount + channelIdx) * 2]
  }
  const rgbaBuffer = allocBuffer(pixelCount * 4);
  new Uint32Array(rgbaBuffer.buffer).fill(4278190080);
  if (lastChannelIsAlpha) {
    extractChannel(channelBuffers.pop(), rgbaBuffer, 3);
    channelCount--
  }
  if (channelCount == 0) {} else if (channelCount == 1) grayChannelToRgba(channelBuffers[0], rgbaBuffer);
  else {
    extractChannel(channelBuffers[0], rgbaBuffer, 0);
    extractChannel(channelBuffers[1], rgbaBuffer, 1);
    if (channelCount > 2) {
      extractChannel(channelBuffers[2], rgbaBuffer, 2);
      if (channelCount > 3) {
        this.extraImportedAlphaLayers = [];
        for (let extraChannelIdx = 3; extraChannelIdx < channelCount; extraChannelIdx++) {
          const alphaMask = new Mask();
          alphaMask.name = Locale.get(["properties.alphaN", String(extraChannelIdx - 2)]);
          alphaMask.rect = new Rect(0, 0, width, height);
          alphaMask.channel = channelBuffers[extraChannelIdx];
          this.extraImportedAlphaLayers.push(alphaMask)
        }
      }
    }
  }
  return rgbaBuffer
};

export { ImportRawDialog };
