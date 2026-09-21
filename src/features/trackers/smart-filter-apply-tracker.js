// Smart-filter apply tracker: raster preview and placed-object filter FX edits
// on the EVENT_SMART_FILTER channel.

import { EventChannel } from "../../document/model/tool-base.js";
import { AdjustmentEngine } from "../adjustments/adjustment-engine.js";
import { FilterDefs } from "../filters/filter-apply.js";
import { Document } from "../../document/model/document.js";
import { HistoryEntry } from "../../document/model/document.js";
import { TrackerRegistry } from "./tracker-registry.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";

export function SmartFilterApplyTracker() {
  TrackerRegistry.TrackerBase.call(this, EventChannel.EVENT_SMART_FILTER);
  this.previewSnapshots = null;
  this.lastAppliedOptionsJson = null;
  this.filterEditHistoryEntry = null;
  this.lastFilterArgs = null;
}

SmartFilterApplyTracker.prototype = Object.create(TrackerRegistry.TrackerBase.prototype);
installSmartFilterApplyTrackerPrototype(SmartFilterApplyTracker);

function resolveFilterDisplayName(filterClassId) {
  let displayNameKey = FilterDefs.names[filterClassId];
  if (displayNameKey == null) displayNameKey = AdjustmentEngine.names[filterClassId];
  if (filterClassId == "blendOptions") displayNameKey = "layerEffects.blendingOptions";
  return displayNameKey;
}

/**
 * Whether picking this filter from a menu leads to an editor. A filter with
 * parameters opens its dialog and a tool-linked one takes over its tool panel;
 * everything else has nothing to configure and applies straight away. The
 * Filter menu marks the same distinction by omitting the trailing ellipsis.
 */
function filterOpensEditor(filterClassId) {
  return FilterDefs.toolLinkedFilterIds[filterClassId] != null || FilterDefs.create(filterClassId) != null;
}

function writeFilterOptionsOntoFxEntry(fxEntry, filterClassId, filterEvent) {
  fxEntry.v.enab.v = filterEvent.skipCanvasPreview != true;
  if (filterClassId == "blendOptions") fxEntry.v.blendOptions.v = filterEvent.operationData;
  else fxEntry.v.Fltr.v = filterEvent.operationData;
}

function installSmartFilterApplyTrackerPrototype(Tracker) {
  Tracker.prototype.handleInput = function (filterEvent, docModel, layerState, keyboardCtx, colorEnv) {
    if (filterEvent.actionKind == "start") {
      if (layerState.selectedLayerIndices.length == 0) return;
      const activeLayer = layerState.layers[layerState.selectedLayerIndices[0]];
      const smartFilterTool = this;
      const onLayersEditable = function (allowed) {
        if (!allowed) return;
        const filterClassId = filterEvent.operationId;
        const cameFromMenu = filterEvent.operationData == null;
        if (cameFromMenu && layerState.selectedLayerIndices.length != 1) {
          showToast("Will be applied to " + layerState.selectedLayerIndices.length + " layers.");
        }
        if (cameFromMenu && filterOpensEditor(filterClassId)) {
          const startDispatchEvent = new AppEvent(EventType.uiDispatch, true);
          startDispatchEvent.data = SmartFilterApplyTracker.buildFilterStartDispatch(
            filterClassId,
            smartFilterTool.getPlacedLayerFilterTarget(layerState, filterClassId),
          );
          docModel.dispatch(startDispatchEvent);
        } else {
          const chainedFilterEvent = {
            actionKind: "edit",
            operationId: filterClassId,
            operationData: filterEvent.operationData,
            smartFilterRef: smartFilterTool.getPlacedLayerFilterTarget(layerState),
          };
          smartFilterTool.handleInput(chainedFilterEvent, docModel, layerState, keyboardCtx, colorEnv);
          // Handlers dispatch on actionKind; keep e then copy so confirm runs.
          chainedFilterEvent.e = "confirm";
          chainedFilterEvent.actionKind = chainedFilterEvent.e;
          delete chainedFilterEvent.operationData;
          smartFilterTool.handleInput(chainedFilterEvent, docModel, layerState, keyboardCtx, colorEnv);
        }
      };
      if (activeLayer.add.placedData && activeLayer.pixelContent <= 0) onLayersEditable(true);
      else layerState.ensureSelectedLayersPixelEditable(docModel, null, true, onLayersEditable);
      return;
    }
    if (filterEvent.actionKind == "edit" || filterEvent.actionKind == "cancel" || filterEvent.actionKind == "confirm") {
      if (filterEvent.actionKind == "edit") this.lastFilterArgs = [filterEvent.operationId, filterEvent.operationData];
      if (filterEvent.smartFilterRef) this.handlePlacedLayerFilterEdit(filterEvent, layerState, colorEnv);
      else this.handleRasterFilterPreview(filterEvent, docModel, layerState, colorEnv);
    }
    if (filterEvent.actionKind == "applylast" && this.lastFilterArgs != null) {
      const chainedFilterEvent = {
        actionKind: "edit",
        operationId: this.lastFilterArgs[0],
        operationData: this.lastFilterArgs[1],
        smartFilterRef: this.getPlacedLayerFilterTarget(layerState),
      };
      this.handleInput(chainedFilterEvent, docModel, layerState, keyboardCtx, colorEnv);
      chainedFilterEvent.e = "confirm";
      chainedFilterEvent.actionKind = chainedFilterEvent.e;
      delete chainedFilterEvent.operationData;
      this.handleInput(chainedFilterEvent, docModel, layerState, keyboardCtx, colorEnv);
    }
  };

  SmartFilterApplyTracker.buildFilterStartDispatch = function (filterClassId, placedTarget) {
    const linkedToolId = FilterDefs.toolLinkedFilterIds[filterClassId];
    if (linkedToolId) {
      return {
        dispatchKind: UiCommand.setActiveToolPanelMode,
        routingChannel: linkedToolId,
        toolOptions: {
          smartFilterRef: placedTarget,
        },
      };
    } else {
      return {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "afw_" + filterClassId,
        smartFilterRef: placedTarget,
      };
    }
  };

  Tracker.prototype.getPlacedLayerFilterTarget = function (layerState, filterClassId) {
    const activeLayer = layerState.layers[layerState.selectedLayerIndices[0]];
    let placedTarget;
    if (activeLayer.add.placedData && activeLayer.pixelContent <= 0) {
      placedTarget = {
        layerIndex: layerState.selectedLayerIndices[0],
        index: 0,
      };
      if (activeLayer.add.placedData.filterFX != null) {
        const fxList = activeLayer.add.placedData.filterFX.v.filterFXList.v;
        placedTarget.index = fxList.length;
        for (let fxIdx = 0; fxIdx < fxList.length; fxIdx++) {
          if (
            FilterDefs.getFilterClassIdFromFx(fxList[fxIdx].v) == filterClassId &&
            FilterDefs.toolLinkedFilterIds[filterClassId]
          ) {
            placedTarget.index = fxIdx;
          }
        }
      }
    }
    return placedTarget;
  };

  Tracker.prototype.handlePlacedLayerFilterEdit = function (filterEvent, layerState, colorEnv) {
    const targetLayer = layerState.layers[filterEvent.smartFilterRef.layerIndex];
    const filterClassId = filterEvent.operationId;
    if (filterEvent.actionKind == "edit") {
      if (this.filterEditHistoryEntry == null) {
        this.filterEditHistoryEntry = new HistoryEntry(resolveFilterDisplayName(filterClassId), this);
        this.filterEditHistoryEntry.data = {
          smartFilterRef: filterEvent.smartFilterRef,
          placedDataBefore: JSON.parse(JSON.stringify(targetLayer.add.placedData)),
        };
      }
      if (!targetLayer.hasSmartFilters()) {
        targetLayer.add.placedData.filterFX = FilterDefs.createEmptyFilterFxStyle();
        this.filterEditHistoryEntry.data.placedItemId = Document.createBlankLinkedItem(
          targetLayer.add.placedData.placed.v,
        );
        layerState.addPlacedItemId(this.filterEditHistoryEntry.data.placedItemId);
        targetLayer.rasterizeSmartObject(layerState);
      }
      const fxList = targetLayer.add.placedData.filterFX.v.filterFXList.v;
      if (fxList[filterEvent.smartFilterRef.index] == null) {
        fxList.push(FilterDefs.createFilterFxDescriptor(filterClassId, colorEnv));
      }
      if (filterEvent.operationData) {
        writeFilterOptionsOntoFxEntry(fxList[filterEvent.smartFilterRef.index], filterClassId, filterEvent);
      }
      this.filterEditHistoryEntry.data.placedDataAfter = JSON.parse(JSON.stringify(targetLayer.add.placedData));
      this.redo(this.filterEditHistoryEntry.data, layerState);
    }
    if (filterEvent.actionKind == "cancel") {
      if (this.filterEditHistoryEntry) this.undo(this.filterEditHistoryEntry.data, layerState);
      this.filterEditHistoryEntry = null;
    }
    if (filterEvent.actionKind == "confirm") {
      if (this.filterEditHistoryEntry) layerState.pushHistory(this.filterEditHistoryEntry);
      this.filterEditHistoryEntry = null;
    }
  };

  Tracker.prototype.unpackRgbFromColorInt = function (colorInt) {
    return {
      h: colorInt >>> 16,
      l: (colorInt >>> 8) & 255,
      O: colorInt & 255,
    };
  };

  Tracker.prototype.handleRasterFilterPreview = function (filterEvent, docModel, layerState, colorEnv) {
    if (this.previewSnapshots == null) {
      const padding = FilterDefs.filterPaddingForClassId(filterEvent.operationId, filterEvent.operationData);
      this.previewSnapshots = TrackerRegistry.AdjustmentPreviewTracker.captureLayerPixelSnapshots(
        layerState,
        padding.x != 0 || padding.y != 0,
      );
    }
    if (filterEvent.actionKind == "edit") {
      const optionsJson = JSON.stringify(filterEvent.operationData);
      if ((filterEvent.operationData == null || optionsJson != this.lastAppliedOptionsJson) && filterEvent.skipCanvasPreview != true) {
        for (let snapshotIdx = 0; snapshotIdx < this.previewSnapshots.length; snapshotIdx++) {
          const snapshot = this.previewSnapshots[snapshotIdx];
          const sourcePixels = {
            rect: snapshot.dirtyRect,
            buffer: snapshot.pixBuf,
          };
          const destPixels = {
            rect: snapshot.dirtyRect,
            buffer: snapshot.savedPixelBuffer,
          };
          FilterDefs.applyFilterToPixels(
            filterEvent.operationId,
            sourcePixels,
            filterEvent.operationData,
            this.unpackRgbFromColorInt(colorEnv.colorInt),
            this.unpackRgbFromColorInt(colorEnv.bgColor),
            destPixels,
            [
              layerState.add.lnk2 ? layerState.add.lnk2 : [],
              layerState.layers[layerState.selectedLayerIndices[0]].getMask(),
              layerState.extraChannels,
            ],
          );
          this.lastAppliedOptionsJson = optionsJson;
        }
      }
      TrackerRegistry.AdjustmentPreviewTracker.applyFilterPreviewToSnapshots(
        layerState,
        this.previewSnapshots,
        filterEvent.skipCanvasPreview,
      );
    }
    if (filterEvent.actionKind == "cancel") {
      TrackerRegistry.AdjustmentPreviewTracker.cancelPreviewSnapshots(layerState, this.previewSnapshots);
      this.previewSnapshots = null;
      this.lastAppliedOptionsJson = null;
    }
    if (filterEvent.actionKind == "confirm") {
      TrackerRegistry.AdjustmentPreviewTracker.commitPreviewToHistory(
        layerState,
        this.previewSnapshots,
        FilterDefs.names[filterEvent.operationId],
        this,
      );
      this.previewSnapshots = null;
      this.lastAppliedOptionsJson = null;
      TrackerRegistry.AdjustmentPreviewTracker.dispatchAdjustmentApplyUi(docModel, this.lastFilterArgs);
    }
    layerState.markDirty();
    layerState.stateChanged = true;
  };

  Tracker.prototype.undo = function (historySnapshot, layerState) {
    if (historySnapshot.smartFilterRef) {
      const targetLayer = layerState.layers[historySnapshot.smartFilterRef.layerIndex];
      if (historySnapshot.placedItemId) layerState.removePlacedItemId(historySnapshot.placedItemId);
      targetLayer.add.placedData = JSON.parse(JSON.stringify(historySnapshot.placedDataBefore));
      if (targetLayer.hasSmartFilters()) targetLayer.applySmartFilters(layerState);
      else {
        targetLayer.rasterizeSmartObject(layerState);
        targetLayer.pixelContent = 0;
      }
    } else {
      TrackerRegistry.AdjustmentPreviewTracker.restoreSnapshotsOnUndoRedo(layerState, historySnapshot);
    }
    layerState.markDirty();
    layerState.stateChanged = true;
  };

  Tracker.prototype.redo = function (historySnapshot, layerState) {
    if (historySnapshot.smartFilterRef) {
      const targetLayer = layerState.layers[historySnapshot.smartFilterRef.layerIndex];
      if (historySnapshot.placedItemId) layerState.addPlacedItemId(historySnapshot.placedItemId);
      targetLayer.add.placedData = JSON.parse(JSON.stringify(historySnapshot.placedDataAfter));
      if (targetLayer.hasSmartFilters()) targetLayer.applySmartFilters(layerState);
      else targetLayer.rasterizeSmartObject(layerState);
      if (!targetLayer.isEffectsExpanded()) targetLayer.layerFlags += 32;
    } else {
      TrackerRegistry.AdjustmentPreviewTracker.restoreSnapshotsOnUndoRedo(layerState, historySnapshot);
    }
    layerState.markDirty();
    layerState.stateChanged = true;
  };
}
