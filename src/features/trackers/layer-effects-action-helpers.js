// Shared history/apply helpers for LayerEffectsTracker action and undo/redo tables.
import { Layer } from "../../document/model/layer.js";
import { HistoryEntry } from "../../document/model/document.js";
import { rebuildVectorMaskFromKeyOrigins } from "../../engine/compositing/key-origins.js";

// Selected layer indices; event.layerIndex overrides the document selection.
export function resolveSelectedLayerIndices(event, doc) {
  return event.layerIndex != null ? [event.layerIndex] : doc.selectedLayerIndices;
}

// Push a history entry and immediately redo it.
export function commitHistoryAndRedo(tracker, doc, historyEntry) {
  doc.pushHistory(historyEntry);
  tracker.redo(historyEntry.data, doc);
}

// Convert an 0-255 opacity byte to a percent integer for PSD Opct descriptors.
export function opacityByteToPercent(opacityByte) {
  return Math.round((opacityByte * 100) / 255);
}

// Apply lock-toggle rows (enabled bits + bit indices) onto a layer lock flags integer.
export function applyLockToggleBits(lockFlags, toggleRows) {
  let lockFlagsAfter = lockFlags;
  for (let bitIdx = 0; bitIdx < toggleRows[0].length; bitIdx++) {
    const lockBitMask = 1 << toggleRows[1][bitIdx];
    if ((lockFlagsAfter & lockBitMask) == 0 && toggleRows[0][bitIdx]) lockFlagsAfter ^= lockBitMask;
    else if ((lockFlagsAfter & lockBitMask) != 0 && !toggleRows[0][bitIdx]) lockFlagsAfter ^= lockBitMask;
  }
  return lockFlagsAfter;
}

// History payload for a layer-stack replacement.
export function buildReplaceStackHistoryData(doc, layersAfter, selectedLayerIndicesAfter, extra = {}) {
  const payload = {
    actionKind: Layer.replaceLayerStack,
    layersBefore: extra.layersBefore != null ? extra.layersBefore : doc.layers.slice(0),
    layersAfter,
    selectedLayerIndicesBefore:
      extra.selectedLayerIndicesBefore != null
        ? extra.selectedLayerIndicesBefore
        : doc.selectedLayerIndices.slice(0),
    selectedLayerIndicesAfter,
  };
  if (extra.activeChannelPair) payload.activeChannelPair = extra.activeChannelPair;
  return payload;
}

// Last history entry matching actionKind, with an optional extra predicate.
export function lastMatchingHistoryEntry(doc, actionKind, extraMatch) {
  const lastHistoryEntry = doc.getLastHistoryEntry();
  if (!lastHistoryEntry || !lastHistoryEntry.data || lastHistoryEntry.data.actionKind != actionKind) {
    return null;
  }
  if (extraMatch && !extraMatch(lastHistoryEntry)) return null;
  return lastHistoryEntry;
}

// Apply rename tuples. Undo reads name slot 1 / lnsr slot 3; redo reads name slot 2 / lnsr slot 4.
export function applyRenameEntries(layerState, renameEntries, nameSlot, lnsrSlot) {
  for (let loopIdx = 0; loopIdx < renameEntries.length; loopIdx++) {
    const renameEntry = renameEntries[loopIdx];
    const loopLayer = layerState.layers[renameEntry[0]];
    loopLayer.setName(renameEntry[nameSlot]);
    if (renameEntry[lnsrSlot]) loopLayer.add.lnsr = renameEntry[lnsrSlot];
    else delete loopLayer.add.lnsr;
  }
}

// Collect index + JSON.stringify(vogk) pairs for selected layers and work paths.
export function collectKeyOriginPairs(doc) {
  const keyOrigins = [];
  for (let loopIdx = 0; loopIdx < doc.selectedLayerIndices.length; loopIdx++) {
    const pathOrLayerIndex = doc.selectedLayerIndices[loopIdx];
    const layerOrPath = doc.layers[pathOrLayerIndex];
    if (layerOrPath.add.vogk) keyOrigins.push(pathOrLayerIndex, JSON.stringify(layerOrPath.add.vogk));
  }
  for (let loopIdx = 0; loopIdx < doc.selectedWorkPaths.length; loopIdx++) {
    const pathOrLayerIndex = doc.selectedWorkPaths[loopIdx];
    const layerOrPath = doc.paths[pathOrLayerIndex];
    if (layerOrPath.add.vogk) keyOrigins.push(-1 - pathOrLayerIndex, JSON.stringify(layerOrPath.add.vogk));
  }
  return keyOrigins;
}

// Write key-origin JSON pairs back onto layers / paths and rebuild vector masks.
export function applyKeyOriginPairs(layerState, keyOriginPairs) {
  for (let loopIdx = 0; loopIdx < keyOriginPairs.length; loopIdx += 2) {
    const pathOrLayerIndex = keyOriginPairs[loopIdx];
    const loopLayer =
      pathOrLayerIndex >= 0 ? layerState.layers[pathOrLayerIndex] : layerState.paths[-1 - pathOrLayerIndex];
    loopLayer.add.vogk = JSON.parse(keyOriginPairs[loopIdx + 1]);
    rebuildVectorMaskFromKeyOrigins(loopLayer.add.vogk, loopLayer.add.vmsk);
    if (pathOrLayerIndex >= 0) loopLayer.invalidate(layerState);
  }
  layerState.markDirty();
}

// Flip visibility on every index in visibilityLayerIndices.
export function toggleVisibilityFromHistory(historySnapshot, layerState) {
  for (let loopIdx = 0; loopIdx < historySnapshot.visibilityLayerIndices.length; loopIdx++) {
    const loopLayer = layerState.layers[historySnapshot.visibilityLayerIndices[loopIdx]];
    loopLayer.setVisible(!loopLayer.isVisible());
  }
  layerState.markDirty();
}

// Toggle vector-mask enabled and swap raster/warp scratch buffers.
export function toggleVectorMaskEnabledState(targetLayer, layerState) {
  const layerMask = targetLayer.add.vmsk;
  layerMask.isEnabled = !layerMask.isEnabled;
  if (!layerMask.isEnabled) {
    if (targetLayer.warpData) {
      targetLayer.d = targetLayer.warpData;
      targetLayer.warpData = null;
    } else {
      targetLayer.d = null;
    }
  } else if (targetLayer.d) {
    targetLayer.warpData = targetLayer.d;
    targetLayer.d = null;
  }
  targetLayer.invalidate(layerState);
  layerState.markDirty();
}

// Timeline merge: index of the duration bucket covering timelineOffset.
export function findDurationBucketIndex(durationList, timelineOffset) {
  let bucketIdx = 0;
  let accumulatedDuration = 0;
  while (accumulatedDuration + durationList[bucketIdx] <= timelineOffset) {
    accumulatedDuration += durationList[bucketIdx];
    bucketIdx++;
  }
  return bucketIdx;
}

// Write a full group-index list onto every layer.
export function assignGroupIndices(layerState, groupIndexList) {
  for (let loopIdx = 0; loopIdx < groupIndexList.length; loopIdx++) {
    layerState.layers[loopIdx].groupIndex = groupIndexList[loopIdx];
  }
}

// Create a HistoryEntry bound to tracker with data already assigned.
export function createHistoryEntry(historyLabel, tracker, data, excludeFromHistoryUI) {
  const historyEntry = new HistoryEntry(historyLabel, tracker, excludeFromHistoryUI);
  historyEntry.data = data;
  return historyEntry;
}
