// Levels / curves / auto-tone preview: snapshot pixels, apply software
// adjustments, then commit or restore through history.
import { Rect } from "../../core/math/rect.js";

import { BlendModes } from "../../document/model/blend-modes.js";
import { defaultShapeStyleParams } from "../../engine/layer-system.js";
import { EventChannel } from "../../document/model/tool-base.js";
import { HueSaturationParser, LevelsParser } from "../../document/formats/psd/adjustment-parsers.js";
import { AdjustmentEngine } from "../adjustments/adjustment-engine.js";
import { FilterDefs } from "../filters/filter-apply.js";
import { ActionDescUtil } from "../scripting/action-desc.js";
import { HistoryEntry } from "../../document/model/document.js";
import { LayerStyleRenderer } from "../layer-styles/style-renderer.js";
import { TrackerRegistry } from "./tracker-registry.js";
import { adjustmentKeyOf } from "../../document/formats/psd/adjustment-parsers.js";
import { EventType } from "../../core/event-bus.js";
import { showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";
import { PaintTool } from "../../document/tools/paint-tools.js";
import { allocBuffer, copyBuffer, extractChannel, extractChannelByte } from "../../engine/compositing/buffer-utils.js";
import { blitChannelToBuffer, computeHistogram, copyChannel, copyPixels } from "../../engine/compositing/pixel-ops.js";
import { composite, compositeLayer } from "../../engine/compositing/compositing-ops.js";
import { invert, invertRgb } from "../../engine/compositing/color-math.js";

const APPLY_IMAGE_CHANNEL_ENUMS = ["RGB", "Rd", "Grn", "Bl", "Trsp"];
const WHITE_PACKED_RGB = 16777215;

export function AdjustmentPreviewTracker() {
  TrackerRegistry.TrackerBase.call(this, EventChannel.EVENT_ADJUSTMENT);
  this.previewSnapshots = null;
  this.lastFilterArgs = null;
}

AdjustmentPreviewTracker.prototype = Object.create(TrackerRegistry.TrackerBase.prototype);
installAdjustmentPreviewTrackerPrototype(AdjustmentPreviewTracker);

/**
 * Histogram-derived input/output stops for auto levels (`[inLow, inHigh, outLow, outHigh, 100]`).
 * @param {number[]} channelHistogram 256-bin counts.
 * @param {number} targetSampleCount Cumulative count to skip at each end.
 * @param {number} pixelCount Total pixels (used when extending ends).
 * @param {boolean} extendEnds Widen stops and map overflow into output levels.
 * @returns {number[]}
 */
AdjustmentPreviewTracker.buildLevelsStopFromHistogram = function (
  channelHistogram,
  targetSampleCount,
  pixelCount,
  extendEnds,
) {
  if (extendEnds) targetSampleCount /= 4;
  let lowIdx = 0;
  let lowSum = 0;
  let highIdx = 255;
  let highSum = 0;
  let shadowOut = 0;
  let highlightOut = 255;
  while (lowSum + channelHistogram[lowIdx] < targetSampleCount) {
    lowSum += channelHistogram[lowIdx];
    lowIdx++;
  }
  while (highSum + channelHistogram[highIdx] < targetSampleCount) {
    highSum += channelHistogram[highIdx];
    highIdx--;
  }
  if (extendEnds) {
    lowIdx -= Math.round(channelHistogram[lowIdx] / (pixelCount / 32));
    highIdx += Math.round(channelHistogram[highIdx] / (pixelCount / 32));
    if (lowIdx < 0) shadowOut = Math.round((-lowIdx * 255) / (highIdx - lowIdx));
    if (highIdx > 255) highlightOut = 255 - Math.round(((highIdx - 255) * 255) / (highIdx - lowIdx));
  }
  return [Math.max(lowIdx, 0), Math.min(highIdx, 255), shadowOut, highlightOut, 100];
};

/**
 * Copy selected layer (or extra-channel) pixels into preview snapshots.
 * @param {object} layerState Document layer state.
 * @param {boolean} [expandToDocument]
 * @param {object[]} [fadeSnapshotList]
 * @returns {object[]}
 */
AdjustmentPreviewTracker.captureLayerPixelSnapshots = function (
  layerState,
  expandToDocument,
  fadeSnapshotList,
) {
  const snapshots = [];
  const documentRect = new Rect(0, 0, layerState.width, layerState.height);
  const layerIndices =
    layerState.activeChannels.length != 0
      ? [-1 - layerState.activeChannels[0]]
      : layerState.selectedLayerIndices;
  for (let idx = 0; idx < layerIndices.length; idx++) {
    const layerIndex = layerIndices[idx];
    const targetLayer = layerIndex < 0 ? null : layerState.layers[layerIndex];
    const snapshot = {
      layerIndex,
      pixelContentKind: layerIndex < 0 ? 1 : targetLayer.pixelContent,
    };
    snapshots.push(snapshot);
    let channelSource = layerState.extraChannels[-1 - layerIndex];
    if (0 <= layerIndex) {
      channelSource =
        targetLayer.pixelContent <= 0
          ? null
          : targetLayer.pixelContent == 1
            ? targetLayer.getMask()
            : targetLayer.getLinkedPlacedItem(layerState).d;
    }
    const sourceRect = channelSource ? channelSource.rect : targetLayer.rect;
    if (layerState.selectionMask) {
      snapshot.dirtyRect =
        channelSource != null
          ? layerState.selectionMask.rect.intersect(documentRect)
          : layerState.selectionMask.rect.intersect(sourceRect);
    } else {
      snapshot.dirtyRect =
        expandToDocument || channelSource != null ? sourceRect.union(documentRect) : sourceRect.clone();
    }
    if (fadeSnapshotList) snapshot.dirtyRect = fadeSnapshotList[idx].dirtyRect.clone();
    const pixelCount = snapshot.dirtyRect.area();
    snapshot.pixBuf = allocBuffer(pixelCount * 4);
    if (channelSource) {
      blitChannelToBuffer(
        channelSource.channel,
        channelSource.rect,
        channelSource.color,
        snapshot.pixBuf,
        snapshot.dirtyRect,
      );
    } else {
      copyPixels(targetLayer.buffer, sourceRect, snapshot.pixBuf, snapshot.dirtyRect);
    }
    snapshot.savedPixelBuffer = snapshot.pixBuf.slice(0);
    if (layerState.selectionMask) {
      snapshot.selectionMask = allocBuffer(pixelCount);
      copyChannel(layerState.selectionMask.channel, layerState.selectionMask.rect, snapshot.selectionMask, snapshot.dirtyRect);
    }
  }
  return snapshots;
};

/**
 * Replace auto-levels descriptors with histogram-derived channel stops.
 * @param {string} filterClassId
 * @param {object} filterDescriptor
 * @param {Uint8Array} rgbaBuffer
 * @returns {object}
 */
AdjustmentPreviewTracker.buildToneCurvePresetStops = function (
  filterClassId,
  filterDescriptor,
  rgbaBuffer,
) {
  if (filterDescriptor == null) return filterDescriptor;
  const autoLevelsMode = AdjustmentEngine.getAutoLevelsMode(filterClassId, filterDescriptor);
  if (autoLevelsMode == -1) return filterDescriptor;
  const pixelCount = rgbaBuffer.length >>> 2;
  const histogram = computeHistogram(rgbaBuffer);
  const sampleTarget = 0.001 * pixelCount;
  let channelStops;
  if (autoLevelsMode == 0 || autoLevelsMode == 2) {
    channelStops = [
      [0, 255, 0, 255, 100],
      AdjustmentPreviewTracker.buildLevelsStopFromHistogram(
        histogram[1],
        sampleTarget,
        pixelCount,
        autoLevelsMode == 2,
      ),
      AdjustmentPreviewTracker.buildLevelsStopFromHistogram(
        histogram[2],
        sampleTarget,
        pixelCount,
        autoLevelsMode == 2,
      ),
      AdjustmentPreviewTracker.buildLevelsStopFromHistogram(
        histogram[3],
        sampleTarget,
        pixelCount,
        autoLevelsMode == 2,
      ),
    ];
  }
  if (autoLevelsMode == 1) {
    channelStops = [
      AdjustmentPreviewTracker.buildLevelsStopFromHistogram(histogram[0], sampleTarget * 0.33, pixelCount, false),
      [0, 255, 0, 255, 100],
      [0, 255, 0, 255, 100],
      [0, 255, 0, 255, 100],
    ];
  }
  const levelsDescriptor = FilterDefs.create("levl");
  for (let channelIdx = 0; channelIdx < 4; channelIdx++) {
    LevelsParser.setChannelLevel(levelsDescriptor, channelIdx, channelStops[channelIdx]);
  }
  return levelsDescriptor;
};

/**
 * Record a scripted apply for the last filter args (history grouping).
 * @param {object} docModel
 * @param {Array} lastFilterArgs `[filterClassId, filterDescriptor]`
 */
AdjustmentPreviewTracker.dispatchAdjustmentApplyUi = function (docModel, lastFilterArgs) {
  const filterClassId = lastFilterArgs[0];
  const filterDescriptor = lastFilterArgs[1];
  let scriptEventName;
  let scriptPayload;
  // Adjustments and filters record the event name only. The descriptor rides
  // along for the two below, which replay their exact parameters.
  if (AdjustmentEngine.eventNames[filterClassId]) {
    scriptEventName = AdjustmentEngine.eventNames[filterClassId];
  }
  if (FilterDefs.filterScriptKeys[filterClassId]) {
    scriptEventName = FilterDefs.filterScriptKeys[filterClassId];
  }
  if (filterClassId == "fade") {
    scriptEventName = "fade";
    scriptPayload = filterDescriptor;
  }
  if (filterClassId == "aply") {
    scriptEventName = "applyImageEvent";
    scriptPayload = filterDescriptor;
  }
  if (scriptEventName == null) return;
  const groupedHistoryEvent = new AppEvent(EventType.historyGrouped, true);
  groupedHistoryEvent.data = {
    skipActionRecording: true,
    uf: scriptEventName,
  };
  if (scriptPayload) {
    scriptPayload = JSON.parse(JSON.stringify(scriptPayload));
    scriptPayload.classID = "null";
    delete scriptPayload.__name;
    groupedHistoryEvent.data.actionDescriptor = scriptPayload;
  }
  docModel.dispatch(groupedHistoryEvent);
};

AdjustmentPreviewTracker.cancelPreviewSnapshots = function (layerState, snapshots) {
  AdjustmentPreviewTracker.restoreSnapshotsOnUndoRedo(layerState, snapshots);
};

/**
 * Trim snapshot targets, drop scratch buffers, and push a history entry.
 * @param {object} layerState
 * @param {object[]} snapshots
 * @param {string} historyLabel
 * @param {object} tracker
 */
AdjustmentPreviewTracker.commitPreviewToHistory = function (layerState, snapshots, historyLabel, tracker) {
  for (let snapshotIdx = 0; snapshotIdx < snapshots.length; snapshotIdx++) {
    const snapshot = snapshots[snapshotIdx];
    const targetLayer = layerState.layers[snapshot.layerIndex];
    const channelSource =
      snapshot.layerIndex < 0
        ? layerState.extraChannels[-1 - snapshot.layerIndex]
        : snapshot.pixelContentKind <= 0
          ? null
          : snapshot.pixelContentKind == 1
            ? targetLayer.getMask()
            : targetLayer.getLinkedPlacedItem(layerState).d;
    if (channelSource) {
      channelSource.trimToContent();
      channelSource.maskCombineDirty = true;
      if (targetLayer) targetLayer.invalidate(layerState);
    } else {
      targetLayer.trimToContent();
      targetLayer.markDirty();
    }
    delete snapshot.savedPixelBuffer;
    delete snapshot.selectionMask;
  }
  const historyEntry = new HistoryEntry(historyLabel, tracker);
  historyEntry.data = snapshots;
  layerState.pushHistory(historyEntry);
  layerState.stateChanged = true;
};

/**
 * Blit preview buffers back onto layers or masks.
 * @param {object} layerState
 * @param {object[]} snapshots
 * @param {boolean} [keepOriginalPixels]
 */
AdjustmentPreviewTracker.applyFilterPreviewToSnapshots = function (layerState, snapshots, keepOriginalPixels) {
  for (let snapshotIdx = 0; snapshotIdx < snapshots.length; snapshotIdx++) {
    const snapshot = snapshots[snapshotIdx];
    const targetLayer = layerState.layers[snapshot.layerIndex];
    const previewBuffer = keepOriginalPixels ? snapshot.pixBuf : snapshot.savedPixelBuffer;
    const dirtyRect = snapshot.dirtyRect;
    if (snapshot.pixelContentKind == 0) {
      targetLayer.extend(dirtyRect);
      if (snapshot.selectionMask) {
        copyPixels(snapshot.pixBuf, dirtyRect, targetLayer.buffer, targetLayer.rect);
        compositeLayer(
          previewBuffer,
          dirtyRect,
          targetLayer.buffer,
          targetLayer.rect,
          snapshot.selectionMask,
          dirtyRect,
          0,
          dirtyRect,
          1,
        );
      } else {
        copyPixels(previewBuffer, dirtyRect, targetLayer.buffer, targetLayer.rect);
      }
    } else {
      const channelSource =
        snapshot.layerIndex < 0
          ? layerState.extraChannels[-1 - snapshot.layerIndex]
          : snapshot.pixelContentKind == 1
            ? targetLayer.getMask()
            : targetLayer.getLinkedPlacedItem(layerState).d;
      channelSource.extend(dirtyRect);
      if (snapshot.selectionMask) {
        const compositeScratch = allocBuffer(dirtyRect.area() * 4);
        copyBuffer(snapshot.pixBuf, compositeScratch);
        compositeLayer(
          previewBuffer,
          dirtyRect,
          compositeScratch,
          dirtyRect,
          snapshot.selectionMask,
          dirtyRect,
          0,
          dirtyRect,
          1,
        );
        PaintTool.copyCompositeToMask(compositeScratch, dirtyRect, channelSource);
      } else {
        PaintTool.copyCompositeToMask(previewBuffer, dirtyRect, channelSource);
      }
      channelSource.maskCombineDirty = true;
      if (targetLayer) targetLayer.invalidate(layerState);
    }
    if (targetLayer) targetLayer.markDirty();
  }
  if (!keepOriginalPixels) AdjustmentPreviewTracker.writeSnapshotsToDocument(layerState, snapshots);
};

/**
 * Swap current pixels with snapshot `pixBuf` for undo/redo of raster previews.
 * @param {object} layerState
 * @param {object[]} snapshots
 */
AdjustmentPreviewTracker.restoreSnapshotsOnUndoRedo = function (layerState, snapshots) {
  if (!snapshots) return;
  for (let snapshotIdx = 0; snapshotIdx < snapshots.length; snapshotIdx++) {
    const snapshot = snapshots[snapshotIdx];
    const targetLayer = layerState.layers[snapshot.layerIndex];
    const dirtyRect = snapshot.dirtyRect;
    const restoreBuffer = allocBuffer(dirtyRect.area() * 4);
    if (snapshot.pixelContentKind == 0) {
      copyPixels(targetLayer.buffer, targetLayer.rect, restoreBuffer, dirtyRect);
      targetLayer.extend(dirtyRect);
      copyPixels(snapshot.pixBuf, dirtyRect, targetLayer.buffer, targetLayer.rect);
      targetLayer.trimToContent();
    } else {
      const channelSource =
        snapshot.layerIndex < 0
          ? layerState.extraChannels[-1 - snapshot.layerIndex]
          : snapshot.pixelContentKind == 1
            ? targetLayer.getMask()
            : targetLayer.getLinkedPlacedItem(layerState).d;
      blitChannelToBuffer(
        channelSource.channel,
        channelSource.rect,
        channelSource.color,
        restoreBuffer,
        dirtyRect,
      );
      channelSource.extend(dirtyRect);
      PaintTool.copyCompositeToMask(snapshot.pixBuf, dirtyRect, channelSource);
      channelSource.trimToContent();
      channelSource.maskCombineDirty = true;
      if (targetLayer) targetLayer.invalidate(layerState);
    }
    snapshot.pixBuf = restoreBuffer;
    if (targetLayer) targetLayer.markDirty();
  }
  layerState.stateChanged = true;
};

/**
 * Re-apply snapshot RGB into the document while preserving background-channel bits.
 * @param {object} layerState
 * @param {object[]} snapshots
 */
AdjustmentPreviewTracker.writeSnapshotsToDocument = function (layerState, snapshots) {
  const bgMask = AdjustmentPreviewTracker.getBottomLayerBackgroundColor(layerState);
  const fgMask = ~bgMask;
  if (bgMask == WHITE_PACKED_RGB) return;
  for (let snapshotIdx = 0; snapshotIdx < snapshots.length; snapshotIdx++) {
    const snapshot = snapshots[snapshotIdx];
    const targetLayer = layerState.layers[snapshot.layerIndex];
    const dirtyRect = snapshot.dirtyRect;
    if (snapshot.pixelContentKind != 0) continue;
    targetLayer.extend(dirtyRect);
    const offsetX = dirtyRect.x - targetLayer.rect.x;
    const offsetY = dirtyRect.y - targetLayer.rect.y;
    const layerWidth = targetLayer.rect.width;
    const snapshotUint32 = new Uint32Array(snapshot.pixBuf.buffer);
    const layerUint32 = new Uint32Array(targetLayer.buffer.buffer);
    for (let row = 0; row < dirtyRect.height; row++) {
      for (let col = 0; col < dirtyRect.width; col++) {
        const snapshotIndex = row * dirtyRect.width + col;
        const layerIndex = (row + offsetY) * layerWidth + (col + offsetX);
        layerUint32[layerIndex] = (layerUint32[layerIndex] & bgMask) | (snapshotUint32[snapshotIndex] & fgMask);
      }
    }
    targetLayer.trimToContent();
    targetLayer.markDirty();
  }
  layerState.markDirty();
};

/**
 * Pack bottom-layer RGB channel visibility into a 24-bit mask.
 * @param {object} layerState
 * @returns {number}
 */
AdjustmentPreviewTracker.getBottomLayerBackgroundColor = function (layerState) {
  const bgRgbPlanar = layerState.pathViewport.channelVisibility;
  return (bgRgbPlanar[2] * 16711680) | (bgRgbPlanar[1] * 65280) | (bgRgbPlanar[0] * 255);
};

function installAdjustmentPreviewTrackerPrototype(Tracker) {
  Tracker.prototype.handleInput = function (adjustmentEvent, docModel, layerState, keyboardCtx, colorEnv) {
    const eventKind = adjustmentEvent.actionKind;
    if (eventKind == "auto") {
      applyAutoToneToLayers(this, adjustmentEvent, layerState);
    }
    if (eventKind == "edit_layer") {
      this.editSingleLayerAdjustment(adjustmentEvent, docModel, layerState, keyboardCtx);
    }
    if (eventKind == "edit" || eventKind == "confirm" || eventKind == "cancel") {
      this.handleAdjustmentSession(adjustmentEvent, docModel, layerState, colorEnv, true);
    }
    if (eventKind == "start") {
      startAdjustmentSession(this, adjustmentEvent, docModel, layerState, colorEnv);
    }
  };

  Tracker.prototype.editSingleLayerAdjustment = function (adjustmentEvent, docModel, layerState, keyboardCtx) {
    const layerIndex = layerState.selectedLayerIndices[0];
    const targetLayer = layerState.layers[layerIndex];
    const adjustmentKey = adjustmentKeyOf(targetLayer.add);
    const descriptorCopy = JSON.parse(JSON.stringify(adjustmentEvent.value));
    for (const figmaKey in AdjustmentEngine.figmaDescriptorKeys) {
      if (AdjustmentEngine.figmaDescriptorKeys[figmaKey] == adjustmentKey) descriptorCopy.classID = figmaKey;
    }
    const topHistory = layerState.history[layerState.historyIndex];
    let historyEntry;
    if (topHistory && topHistory.routingChannel == this && topHistory.data.adjustmentDescBefore != null && topHistory.data.layerIndex == layerIndex) {
      historyEntry = topHistory;
    } else {
      const groupedHistoryEvent = new AppEvent(EventType.historyGrouped, true);
      const setDescriptorPayload = {
        classID: "setd",
        null: ActionDescUtil.buildTargetRef("AdjL", true),
        T: {
          t: "Objc",
          v: descriptorCopy,
        },
      };
      groupedHistoryEvent.data = {
        skipActionRecording: true,
        uf: "set",
        actionDescriptor: setDescriptorPayload,
      };
      docModel.dispatch(groupedHistoryEvent);
      historyEntry = new HistoryEntry("layer.editAdjustmentLayer", this);
      historyEntry.data = {
        layerIndex,
        adjustmentDescBefore: targetLayer.add[adjustmentKey],
        adjustmentDescAfter: adjustmentEvent.value,
        setDescriptorPayload,
      };
      layerState.pushHistory(historyEntry);
    }
    historyEntry.data.adjustmentDescAfter = adjustmentEvent.value;
    historyEntry.data.setDescriptorPayload.T.v = descriptorCopy;
    this.redo(historyEntry.data, layerState);
  };

  Tracker.prototype.handleAdjustmentSession = function (adjustmentEvent, docModel, layerState, colorEnv) {
    ensurePreviewSnapshots(this, adjustmentEvent, layerState);
    if (adjustmentEvent.actionKind == "edit") {
      applyEditPreview(this, adjustmentEvent, layerState);
    }
    if (adjustmentEvent.actionKind == "cancel") {
      AdjustmentPreviewTracker.cancelPreviewSnapshots(layerState, this.previewSnapshots);
      this.previewSnapshots = null;
    }
    if (adjustmentEvent.actionKind == "confirm") {
      confirmPreviewSession(this, adjustmentEvent, docModel, layerState);
    }
    layerState.markDirty();
  };

  Tracker.prototype.undo = function (historySnapshot, layerState) {
    const targetLayer = layerState.layers[historySnapshot.layerIndex];
    if (historySnapshot.adjustmentDescBefore != null) {
      targetLayer.add[adjustmentKeyOf(targetLayer.add)] = historySnapshot.adjustmentDescBefore;
    } else {
      AdjustmentPreviewTracker.restoreSnapshotsOnUndoRedo(layerState, historySnapshot);
    }
    layerState.markDirty();
  };

  Tracker.prototype.redo = function (historySnapshot, layerState) {
    const targetLayer = layerState.layers[historySnapshot.layerIndex];
    if (historySnapshot.adjustmentDescBefore != null) {
      targetLayer.add[adjustmentKeyOf(targetLayer.add)] = historySnapshot.adjustmentDescAfter;
    } else {
      AdjustmentPreviewTracker.restoreSnapshotsOnUndoRedo(layerState, historySnapshot);
    }
    layerState.markDirty();
  };
}

function applyAutoToneToLayers(tracker, adjustmentEvent, layerState) {
  const autoToneMode = adjustmentEvent.autoToneMode;
  const snapshots = AdjustmentPreviewTracker.captureLayerPixelSnapshots(layerState);
  for (let snapshotIdx = 0; snapshotIdx < snapshots.length; snapshotIdx++) {
    const snapshot = snapshots[snapshotIdx];
    let shaderOptions;
    if (autoToneMode >= 3) {
      const desaturateDesc = FilterDefs.create("hue2");
      HueSaturationParser.setChannelData(desaturateDesc, 0, [0, -100, 0]);
      shaderOptions = AdjustmentEngine.buildShaderOptions("hue2", desaturateDesc);
    }
    AdjustmentEngine.applySoftware(shaderOptions, snapshot.pixBuf, snapshot.savedPixelBuffer, snapshot.dirtyRect);
  }
  AdjustmentPreviewTracker.applyFilterPreviewToSnapshots(layerState, snapshots);
  AdjustmentPreviewTracker.commitPreviewToHistory(
    layerState,
    snapshots,
    autoToneMode < 3
      ? ["adjustments.autoTone", "adjustments.autoContrast", "adjustments.autoColour"][autoToneMode]
      : "styleOptions.desaturate",
    tracker,
  );
  layerState.markDirty();
}

function startAdjustmentSession(tracker, adjustmentEvent, docModel, layerState, colorEnv) {
  if (layerState.selectedLayerIndices.length == 0) return;
  const activeLayer = layerState.layers[layerState.selectedLayerIndices[0]];
  if (activeLayer.add.placedData && activeLayer.pixelContent <= 0) {
    const smartFilterStartEvent = new AppEvent(EventType.documentAction, true);
    smartFilterStartEvent.routingChannel = EventChannel.EVENT_SMART_FILTER;
    smartFilterStartEvent.data = {
      actionKind: "start",
      operationId: adjustmentEvent.adjustmentKey,
    };
    docModel.dispatch(smartFilterStartEvent);
    return;
  }
  layerState.ensureSelectedLayersPixelEditable(docModel, null, true, function (allowed) {
    if (!allowed) return;
    if (adjustmentEvent.operationData == null) {
      if (layerState.selectedLayerIndices.length != 1) {
        showToast("Will be applied to " + layerState.selectedLayerIndices.length + " layers.");
      }
      const startEvent = new AppEvent(EventType.uiDispatch, true);
      startEvent.data = TrackerRegistry.SmartFilterApplyTracker.buildFilterStartDispatch(
        adjustmentEvent.adjustmentKey,
        TrackerRegistry.SmartFilterApplyTracker.prototype.getPlacedLayerFilterTarget(
          layerState,
          adjustmentEvent.adjustmentKey,
        ),
      );
      docModel.dispatch(startEvent);
    } else {
      tracker.handleAdjustmentSession(
        {
          actionKind: "edit",
          operationData: adjustmentEvent.operationData,
          operationId: adjustmentEvent.adjustmentKey,
        },
        docModel,
        layerState,
        colorEnv,
      );
      tracker.handleAdjustmentSession(
        {
          actionKind: "confirm",
          operationId: adjustmentEvent.adjustmentKey,
        },
        docModel,
        layerState,
        colorEnv,
      );
    }
  });
}

function ensurePreviewSnapshots(tracker, adjustmentEvent, layerState) {
  if (tracker.previewSnapshots != null) return;
  if (adjustmentEvent.operationId == "aply") {
    layerState.layers[layerState.selectedLayerIndices[0]].extend(new Rect(0, 0, layerState.width, layerState.height));
  }
  tracker.previewSnapshots = AdjustmentPreviewTracker.captureLayerPixelSnapshots(
    layerState,
    null,
    adjustmentEvent.operationId == "fade" ? layerState.getLastHistoryEntry().data : null,
  );
  if (adjustmentEvent.operationId == "aply") {
    tracker.previewSnapshots[0].applyImageRaster = layerState.getRasterData();
  }
}

function applyEditPreview(tracker, adjustmentEvent, layerState) {
  tracker.lastFilterArgs = [adjustmentEvent.operationId, adjustmentEvent.operationData];
  const primarySnapshot = tracker.previewSnapshots[0];
  let levelsDescriptor = AdjustmentPreviewTracker.buildToneCurvePresetStops(
    adjustmentEvent.operationId,
    adjustmentEvent.operationData,
    primarySnapshot.pixBuf,
  );
  let shaderOptions = AdjustmentEngine.buildShaderOptions(adjustmentEvent.operationId, levelsDescriptor);
  if (adjustmentEvent.operationId == "fade" || adjustmentEvent.operationId == "aply") shaderOptions = adjustmentEvent.operationData;
  for (let snapshotIdx = 0; snapshotIdx < tracker.previewSnapshots.length; snapshotIdx++) {
    const snapshot = tracker.previewSnapshots[snapshotIdx];
    // No shader (e.g. Color Lookup with no profile after Reset) → identity:
    // copy the captured original back into the preview buffer.
    if (adjustmentEvent.skipCanvasPreview || shaderOptions == null) {
      copyBuffer(snapshot.pixBuf, snapshot.savedPixelBuffer);
    } else if (adjustmentEvent.operationId == "fade") {
      applyFadePreview(snapshot, adjustmentEvent, layerState, snapshotIdx);
    } else if (adjustmentEvent.operationId == "aply") {
      shaderOptions = applyImagePreview(snapshot, shaderOptions, layerState);
    } else {
      AdjustmentEngine.applySoftware(shaderOptions, snapshot.pixBuf, snapshot.savedPixelBuffer, snapshot.dirtyRect);
    }
  }
  AdjustmentPreviewTracker.applyFilterPreviewToSnapshots(layerState, tracker.previewSnapshots);
}

function applyFadePreview(snapshot, adjustmentEvent, layerState, snapshotIdx) {
  const blendMode = BlendModes.fromPSD(adjustmentEvent.operationData.Md.v.blendMode);
  const opacity = adjustmentEvent.operationData.Opct.v.val / 100;
  const fadeHistorySnapshot = layerState.getLastHistoryEntry().data[snapshotIdx];
  copyBuffer(fadeHistorySnapshot.pixBuf, snapshot.savedPixelBuffer);
  if (blendMode == "norm") {
    compositeLayer(
      snapshot.pixBuf,
      snapshot.dirtyRect,
      snapshot.savedPixelBuffer,
      snapshot.dirtyRect,
      null,
      null,
      null,
      snapshot.dirtyRect,
      opacity,
    );
    return;
  }
  let shapeStyleParams = defaultShapeStyleParams();
  shapeStyleParams.preserveDestAlpha = true;
  for (let channelOffset = 0; channelOffset < fadeHistorySnapshot.pixBuf.length; channelOffset += 4) {
    if (fadeHistorySnapshot.pixBuf[channelOffset + 3] != snapshot.pixBuf[channelOffset + 3]) {
      shapeStyleParams = null;
      break;
    }
  }
  composite(
    blendMode,
    snapshot.pixBuf,
    snapshot.dirtyRect,
    snapshot.savedPixelBuffer,
    snapshot.dirtyRect,
    snapshot.dirtyRect,
    opacity,
    shapeStyleParams,
  );
}

function applyImagePreview(snapshot, shaderOptions, layerState) {
  shaderOptions = shaderOptions.With.v;
  const sourceRef = shaderOptions.T.v;
  let sourceBuffer;
  let sourceRect;
  if (sourceRef[1].t == "name") {
    let namedLayerIndex = 0;
    for (let layerIdx = 0; layerIdx < layerState.layers.length; layerIdx++) {
      if (layerState.layers[layerIdx].getName() == sourceRef[1].v.val) namedLayerIndex = layerIdx;
    }
    if (namedLayerIndex == snapshot.layerIndex) {
      sourceBuffer = snapshot.pixBuf;
      sourceRect = snapshot.dirtyRect;
    } else {
      const namedLayer = layerState.layers[namedLayerIndex];
      sourceBuffer = namedLayer.buffer;
      sourceRect = namedLayer.rect;
    }
  } else {
    sourceRect = new Rect(0, 0, layerState.width, layerState.height);
    sourceBuffer = snapshot.applyImageRaster;
  }
  const calcKey = shaderOptions.Clcl ? shaderOptions.Clcl.v.Clcn : null;
  const blendMode = calcKey ? BlendModes.fromPSD(calcKey) : "norm";
  const opacity = shaderOptions.Opct ? shaderOptions.Opct.v.val / 100 : 1;
  const channelEnumIdx = APPLY_IMAGE_CHANNEL_ENUMS.indexOf(sourceRef[0].v.enum);
  const invertSource = shaderOptions.Invr && shaderOptions.Invr.v;
  if (invertSource || channelEnumIdx != 0) {
    sourceBuffer = sourceBuffer.slice(0);
    if (invertSource) invertRgb(sourceBuffer);
    if (channelEnumIdx != 0) {
      const channelScratch = allocBuffer(sourceRect.area());
      extractChannelByte(sourceBuffer, channelScratch, channelEnumIdx - 1);
      if (channelEnumIdx == 4) invert(channelScratch);
      for (let channelIdx = 0; channelIdx < 3; channelIdx++) {
        extractChannel(channelScratch, sourceBuffer, channelIdx);
      }
    }
  }
  if (calcKey == "Sbtr") {
    const scale = 1 / shaderOptions.Scl.v;
    const offset = shaderOptions.Ofst.v;
    const destView = new Uint8ClampedArray(snapshot.savedPixelBuffer.buffer);
    for (let rgbaOffset = 0; rgbaOffset < sourceBuffer.length; rgbaOffset += 4) {
      destView[rgbaOffset] = (snapshot.pixBuf[rgbaOffset] - sourceBuffer[rgbaOffset]) * scale + offset;
      destView[rgbaOffset + 1] = (snapshot.pixBuf[rgbaOffset + 1] - sourceBuffer[rgbaOffset + 1]) * scale + offset;
      destView[rgbaOffset + 2] = (snapshot.pixBuf[rgbaOffset + 2] - sourceBuffer[rgbaOffset + 2]) * scale + offset;
    }
  } else {
    const shapeStyleParams = defaultShapeStyleParams();
    shapeStyleParams.preserveDestAlpha = shaderOptions.PrsT && shaderOptions.PrsT.v;
    snapshot.savedPixelBuffer.fill(0);
    snapshot.savedPixelBuffer.set(snapshot.pixBuf);
    composite(
      blendMode,
      sourceBuffer,
      sourceRect,
      snapshot.savedPixelBuffer,
      snapshot.dirtyRect,
      snapshot.dirtyRect,
      opacity,
      shapeStyleParams,
    );
  }
  return shaderOptions;
}

function confirmPreviewSession(tracker, adjustmentEvent, docModel, layerState) {
  let historyLabel =
    adjustmentEvent.operationId == "fade"
      ? "edit.fade"
      : adjustmentEvent.operationId == "aply"
        ? "edit.applyImage"
        : AdjustmentEngine.names[adjustmentEvent.operationId];
  const autoLevelsMode = AdjustmentEngine.getAutoLevelsMode(adjustmentEvent.operationId, tracker.lastFilterArgs[1]);
  if (autoLevelsMode != -1) {
    historyLabel = ["adjustments.autoTone", "adjustments.autoContrast", "adjustments.autoColour"][autoLevelsMode];
  }
  AdjustmentPreviewTracker.commitPreviewToHistory(layerState, tracker.previewSnapshots, historyLabel, tracker);
  tracker.previewSnapshots = null;
  if (autoLevelsMode == -1) AdjustmentPreviewTracker.dispatchAdjustmentApplyUi(docModel, tracker.lastFilterArgs);
}
