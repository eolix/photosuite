/**
 * Filter / adjustment dialog with live canvas preview.
 */

import { Locale } from "../../core/i18n/locale.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { Rect } from "../../core/math/rect.js";
import { EventChannel } from "../../document/model/tool-base.js";
import { AdjustmentEngine } from "../../features/adjustments/adjustment-engine.js";
import { FilterDefs } from "../../features/filters/filter-apply.js";
import { TrackerRegistry } from "../../features/trackers/tracker-registry.js";
import { PopupTypes } from "../config/popup-types.js";
import { getFilterPanelConstructorOrFallback } from "../filter-panels/filter-parameter-panel.js";
import { Button, Checkbox } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { EventType } from "../../core/event-bus.js";
import { addClass, makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { computeHistogram } from "../../engine/compositing/pixel-ops.js";


function fadeSnapshotLayerIndex(historyEntry) {
  return historyEntry.layerIndex != null ? historyEntry.layerIndex : historyEntry.overrideLayerIndex;
}

function fadeSnapshotPixelKind(historyEntry) {
  return historyEntry.pixelContentKind != null ? historyEntry.pixelContentKind : historyEntry.D3;
}

function fadeHistoryEntryAllowsFade(currentDoc, historyEntry) {
  const layerIndex = fadeSnapshotLayerIndex(historyEntry);
  if (layerIndex < 0 && currentDoc.extraChannels[-1 - layerIndex]) return { allow: true, done: true };
  if (layerIndex == null || currentDoc.layers[layerIndex] == null || currentDoc.layers[layerIndex].pixelContent != fadeSnapshotPixelKind(historyEntry)) {
    return { allow: false, done: false };
  }
  if (currentDoc.selectedLayerIndices.indexOf(layerIndex) === -1) return { allow: false, done: false };
  return { allow: true, done: false };
}

function AdjustFilterDialog(filterId) {
  let dialogTitle = FilterDefs.names[filterId];
  if (dialogTitle == null) dialogTitle = AdjustmentEngine.names[filterId];
  if (filterId == "aply") dialogTitle = "Apply Image";
  if (filterId == "fade") dialogTitle = "edit.fade";
  if (filterId == "blendOptions") dialogTitle = "layerEffects.blendingOptions";
  BaseDialog.call(this, dialogTitle, "afw_" + filterId);
  this.filterId = filterId;
  this.smartFilterRef = null;
  this.pendingConfirmedFilterState = null;
  this.filterPanelWidget = new (getFilterPanelConstructorOrFallback(filterId))();
  // Panels with their own workspace styling name the class their window needs.
  if (this.filterPanelWidget.dialogClassName) {
    addClass(this.el, this.filterPanelWidget.dialogClassName);
  }
  this.filterPanelWidget.on(EventType.widgetSelect, this.refresh, this);
  this.filterPanelWidget.parent = this;
  this.body.appendChild(this.filterPanelWidget.el);
  this.previewOnCanvasCheckbox = new Checkbox("filters.menu.preview");
  this.previewOnCanvasCheckbox.setValue(true);
  this.previewOnCanvasCheckbox.on(EventType.widgetSelect, this.refresh, this);
  this.resetFilterButton = new Button("properties.reset", true, null, true);
  this.resetFilterButton.on("click", this.onResetFilterClicked, this);
  this.okBtn = new Button("clipboard.ok", true, null, true);
  this.okBtn.on("click", this.onOK, this);
  if (this.usesFullscreenFilterPanel()) this.filterPanelWidget.appendCategoryHeader(this.okBtn.el);
  else {
    addClass(this.filterPanelWidget.el, "form");
    addClass(this.body, "flexrow");
    this.filterPanelWidget.el.setAttribute("style", "width:20em");
    const actionsColumnEl = makeElement("div", "dialog-actions");
    this.body.appendChild(actionsColumnEl);
    actionsColumnEl.appendChild(this.okBtn.el);
    actionsColumnEl.appendChild(this.resetFilterButton.el);
    actionsColumnEl.appendChild(this.previewOnCanvasCheckbox.el)
  }
  this.on("closebtn", this.onCancel, this);
  if (this.usesFullscreenFilterPanel()) {
    this.enableUserResize({
      minWidth: 480,
      minHeight: 360
    });
    this.body.style.padding = "0"
  }
}
AdjustFilterDialog.prototype = Object.create(BaseDialog.prototype);
AdjustFilterDialog.prototype.constructor = AdjustFilterDialog;
AdjustFilterDialog.prototype.isActive = function() {
  return true
};
AdjustFilterDialog.prototype.usesFullscreenFilterPanel = function() {
  return this.filterPanelWidget != null && this.filterPanelWidget.opensAsModalDialog()
};
AdjustFilterDialog.prototype.getOffset = function() {
  if (this.isUserResizable && this.isUserResizable()) return null;
  return BaseDialog.prototype.getOffset.call(this);
};
AdjustFilterDialog.prototype.getPreferredContentSize = function(maxW, maxH) {
  if (this.usesFullscreenFilterPanel()) {
    if (this.filterPanelWidget && this.filterPanelWidget.getPreferredDialogSize) {
      const panelSize = this.filterPanelWidget.getPreferredDialogSize(maxW, maxH);
      if (panelSize != null) return panelSize
    }
    return {
      width: Math.min(720, maxW),
      height: Math.min(480, maxH)
    }
  }
  return this.getCompactFilterPreferredSize(maxW, maxH)
};
AdjustFilterDialog.prototype.getCompactFilterPreferredSize = function(maxW, maxH) {
  const measured = this.measureBodyContentSize(maxW, maxH, 12);
  if (measured != null) {
    return {
      width: Math.min(Math.max(measured.width, 200), maxW),
      height: Math.min(Math.max(measured.height, 100), maxH)
    }
  }
  const baseFontPx = 16;
  return {
    width: Math.min(Math.round(20 * baseFontPx + 6.5 * baseFontPx + 28), maxW),
    height: Math.min(Math.round(12 * baseFontPx), maxH)
  };
};
AdjustFilterDialog.prototype.hasOverlay = function() {
  return this.filterPanelWidget.hasOverlay()
};
AdjustFilterDialog.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.filterPanelWidget.onMouseDown(doc, dispatcher, appData, keyboard, pointerState)
};
AdjustFilterDialog.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.filterPanelWidget.onMouseMove(doc, dispatcher, appData, keyboard, pointerState)
};
AdjustFilterDialog.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.filterPanelWidget.onMouseUp(doc, dispatcher, appData, keyboard, pointerState)
};
AdjustFilterDialog.prototype.canOpen = function(currentDoc, dialogPayload) {
  if (this.filterId == "fade") return AdjustFilterDialog.canOpenFadeOnActiveLayers(currentDoc);
  return true
};
AdjustFilterDialog.prototype.onResetFilterClicked = function(clickEvent) {
  this.filterPanelWidget.setValue(FilterDefs.create(this.filterId));
  this.refresh()
};
AdjustFilterDialog.prototype.refresh = function(widgetEvent) {
  this.applyEvent({
    actionKind: "edit",
    operationData: this.filterPanelWidget.getValue(),
    skipCanvasPreview: !this.previewOnCanvasCheckbox.getValue()
  })
};
AdjustFilterDialog.prototype.onCancel = function(clickEvent) {
  this.applyEvent({
    actionKind: "cancel"
  })
};
AdjustFilterDialog.prototype.onOK = function(clickEvent) {
  if (!this.previewOnCanvasCheckbox.getValue()) {
    this.previewOnCanvasCheckbox.setValue(true);
    this.refresh()
  }
  this.pendingConfirmedFilterState = this.filterPanelWidget.getValue();
  if (this.usesFullscreenFilterPanel()) this.refresh();
  this.applyEvent({
    actionKind: "confirm"
  });
  this.close()
};
AdjustFilterDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.previewOnCanvasCheckbox.buildUI();
  if (this.filterPanelWidget) this.filterPanelWidget.buildUI()
};
AdjustFilterDialog.prototype.onUpdate = function(appData, popupType) {
  if (this.filterPanelWidget) this.filterPanelWidget.onUpdate(appData, popupType)
};
AdjustFilterDialog.prototype.forwardPaletteUpdateToPanel = function(appData, popupType) {
  if (this.filterPanelWidget && this.filterPanelWidget.na) this.filterPanelWidget.na(appData, popupType)
};
AdjustFilterDialog.prototype.onKeyEvent = function(doc, view, appData, keyboard) {
  if (this.usesFullscreenFilterPanel()) this.filterPanelWidget.onKeyEvent(keyboard);
  else BaseDialog.prototype.onKeyEvent.call(this, doc, view, appData, keyboard)
};
AdjustFilterDialog.prototype.open = function(currentDoc, dialogPayload, openDocs, keyboard) {
  this.smartFilterRef = dialogPayload.smartFilterRef;
  const hostPaletteSource = this.parent && this.parent.doc;
  if (hostPaletteSource != null) {
    if (this.filterPanelWidget.na) this.filterPanelWidget.na(hostPaletteSource, PopupTypes.ALL);
    else this.filterPanelWidget.onUpdate(hostPaletteSource, PopupTypes.ALL)
  }
  const linkedItems = currentDoc.add.lnk2 ? currentDoc.add.lnk2 : [],
    docBounds = new Rect(0, 0, currentDoc.width, currentDoc.height),
    activeLayer = currentDoc.layers[currentDoc.selectedLayerIndices[0]];
  let layerBuffer = activeLayer.buffer,
    layerRect = activeLayer.rect,
    rasterData = null;
  if (this.usesFullscreenFilterPanel()) rasterData = currentDoc.getRasterData(currentDoc.selectedLayerIndices[0] - 1);
  const defaultFilterState = FilterDefs.create(this.filterId),
    panelContext = [linkedItems, currentDoc.extraChannels, currentDoc];
  if (dialogPayload.smartFilterRef == null) {
    this.filterPanelWidget.setValue(defaultFilterState, layerBuffer, layerRect, docBounds, rasterData, panelContext);
    if (AdjustmentEngine.names[this.filterId]) {
      if (keyboard.isPressed(KeyboardHandler.Alt) && this.pendingConfirmedFilterState) this.filterPanelWidget.setValue(this.pendingConfirmedFilterState);
      const pixelSnapshots = TrackerRegistry.AdjustmentPreviewTracker.captureLayerPixelSnapshots(currentDoc),
        histogram = computeHistogram(pixelSnapshots[0].pixBuf);
      this.filterPanelWidget.setChannelHistograms(histogram)
    }
  } else {
    const activeLayer = currentDoc.layers[this.smartFilterRef.layerIndex];
    let filterLoaded = false;
    if (activeLayer.hasSmartFilters()) {
      const linkedPlacedItem = activeLayer.getLinkedPlacedItem(currentDoc);
      layerBuffer = linkedPlacedItem.buffer;
      layerRect = linkedPlacedItem.rect;
      const filterFxList = activeLayer.add.placedData.filterFX.v.filterFXList.v;
      if (filterFxList[this.smartFilterRef.index]) {
        const smartFilterEntry = filterFxList[this.smartFilterRef.index].v;
        this.filterPanelWidget.setValue(this.filterId == "blendOptions" ? smartFilterEntry.blendOptions.v : smartFilterEntry.Fltr.v, layerBuffer, layerRect, docBounds, rasterData, panelContext);
        this.filterPanelWidget.setChannelHistograms(computeHistogram(layerBuffer));
        filterLoaded = true
      }
    }
    if (!filterLoaded) {
      this.filterPanelWidget.setValue(defaultFilterState, layerBuffer, layerRect, docBounds, rasterData, panelContext);
      this.filterPanelWidget.setChannelHistograms(computeHistogram(layerBuffer))
    }
  }
  if (!this.usesFullscreenFilterPanel()) this.refresh()
};
AdjustFilterDialog.prototype.applyEvent = function(actionPayload) {
  const docActionEvent = new AppEvent(EventType.documentAction, true);
  actionPayload.operationId = this.filterId;
  actionPayload.smartFilterRef = this.smartFilterRef;
  docActionEvent.data = actionPayload;
  docActionEvent.routingChannel = FilterDefs.names[this.filterId] || this.smartFilterRef ? EventChannel.EVENT_SMART_FILTER : EventChannel.EVENT_ADJUSTMENT;
  docActionEvent.fromDialog = true;
  this.dispatch(docActionEvent)
};
AdjustFilterDialog.prototype.resize = function(dialogWidth, dialogHeight) {
  const sidePadding = this.usesFullscreenFilterPanel() ? 0 : 26;
  this.filterPanelWidget.resize(dialogWidth - sidePadding, dialogHeight - sidePadding)
};
AdjustFilterDialog.canOpenFadeOnActiveLayers = function(currentDoc) {
  if (currentDoc == null) return false;
  const lastHistory = currentDoc.getLastHistoryEntry();
  if (lastHistory == null || !(lastHistory.data instanceof Array) || lastHistory.data.length != currentDoc.selectedLayerIndices.length) return false;
  for (let selIdx = 0; selIdx < lastHistory.data.length; selIdx++) {
    const fadeCheck = fadeHistoryEntryAllowsFade(currentDoc, lastHistory.data[selIdx]);
    if (fadeCheck.done) return true;
    if (!fadeCheck.allow) return false;
  }
  return true;
};

export { AdjustFilterDialog };
