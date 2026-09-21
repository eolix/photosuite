// Layer-effects tracker: dispatch document layer actions and shared
// fill, mask, lock, and vector-history helpers used by the action tables.
import { EventChannel } from "../../document/model/tool-base.js";
import { TrackerRegistry } from "./tracker-registry.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { Layer } from "../../document/model/layer.js";
import { Mask } from "../../document/model/layer-masks.js";
import { TransformToolBase } from "../../document/transform/transform-static.js";
import { packDoublesList, unpackDoublesList } from "../../document/formats/psd/descriptor-codec.js";
import { rectToPathOutline } from "../../engine/compositing/anti-alias.js";
import { composeHomographies, cornersToHomography, matrix2DToHomography, transformPointsArray } from "../../engine/compositing/homography.js";
import { invert } from "../../engine/compositing/color-math.js";

const FILL_LAYER_CLASS_IDS = ["solidColorLayer", "gradientLayer", "patternLayer"];

export function LayerEffectsTracker() {
  TrackerRegistry.TrackerBase.call(this, EventChannel.EVENT_DOCUMENT);
  this.appDispatcher = null;
}

LayerEffectsTracker.prototype = Object.create(TrackerRegistry.TrackerBase.prototype);
installLayerEffectsTrackerPrototype(LayerEffectsTracker);

LayerEffectsTracker.actionHandlers = {};
LayerEffectsTracker.undoHandlers = {};
LayerEffectsTracker.redoHandlers = {};

function resolveEventLayerIndex(event, doc) {
  if (event.layerIndex != null) return event.layerIndex;
  if (doc.selectedLayerIndices.length != 0) return doc.selectedLayerIndices[0];
  return doc.layers.length - 1;
}

function copyPresentFillProperties(sourceFill, targetDescriptor, propertyKeys) {
  for (let keyIdx = 0; keyIdx < propertyKeys.length; keyIdx++) {
    const propertyKey = propertyKeys[keyIdx];
    if (sourceFill[propertyKey]) {
      targetDescriptor[propertyKey] = JSON.parse(JSON.stringify(sourceFill[propertyKey]));
    }
  }
}

function parseDuplicateNameSuffix(layerName, namePrefix) {
  if (!layerName.startsWith(namePrefix)) return null;
  const suffixPart = layerName.slice(namePrefix.length).trim();
  const parsedSuffix = parseInt(suffixPart);
  if (isNaN(parsedSuffix) || parsedSuffix + "" != suffixPart) return null;
  return parsedSuffix;
}

function applyPlacedLockEntry(layerState, lockEntry, lockPhase) {
  const targetLayer = layerState.layers[lockEntry.layerIndex];
  if (lockEntry.placedDataJsonPair) {
    targetLayer.add.placedData = JSON.parse(lockEntry.placedDataJsonPair[lockPhase]);
  }
  if (lockEntry.linkedItemPair) {
    if (lockEntry.linkedItemPair[1 - lockPhase] != null) {
      layerState.removePlacedItemId(lockEntry.linkedItemPair[1 - lockPhase]);
    }
    if (lockEntry.linkedItemPair[lockPhase] != null) {
      layerState.addPlacedItemId(lockEntry.linkedItemPair[lockPhase]);
    } else {
      targetLayer.pixelContent = 0;
    }
  }
  targetLayer.rasterizeSmartObject(layerState);
}

function rescalePlacedLayerTransform(placedData, oldBoundsRect, newBoundsRect, destCornerCoords) {
  const scaleX = newBoundsRect.width / oldBoundsRect.width;
  const scaleY = newBoundsRect.height / oldBoundsRect.height;
  if (scaleX == 1 && scaleY == 1) return;
  const centerX = newBoundsRect.width / 2;
  const centerY = newBoundsRect.height / 2;
  const oldTransformCorners = unpackDoublesList(placedData.nonAffineTransform);
  const oldHomography = cornersToHomography(oldTransformCorners, newBoundsRect);
  const scaleMatrix = new Matrix2D();
  scaleMatrix.translate(-centerX, -centerY);
  scaleMatrix.scale(scaleX, scaleY);
  scaleMatrix.translate(centerX, centerY);
  const composedHomography = composeHomographies(
    oldHomography,
    matrix2DToHomography(scaleMatrix),
  );
  const transformedCorners = destCornerCoords.slice(0);
  transformPointsArray(composedHomography, transformedCorners);
  placedData.Trnf = packDoublesList(transformedCorners);
  placedData.nonAffineTransform = packDoublesList(transformedCorners);
}

function installLayerEffectsTrackerPrototype(Tracker) {
  Tracker.prototype.handleInput = function (event, dispatcher, doc, panelContext, appData) {
    this.appDispatcher = dispatcher;
    let eventCode = event.actionKind;
    const layerIndex = resolveEventLayerIndex(event, doc);
    const targetLayer = doc.layers[layerIndex];
    doc.stateChanged = true;
    if (eventCode == Layer.newLayerViaCopy && doc.selectionMask == null) eventCode = Layer.duplicateLayer;
    if (eventCode == Layer.newLayerViaCut && doc.selectionMask == null) return;
    const actionHandler = Tracker.actionHandlers[eventCode];
    if (actionHandler) {
      actionHandler.call(this, event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer);
    }
  };

  Tracker.prototype.undo = function (historySnapshot, layerState) {
    const historyKind = historySnapshot.actionKind;
    const targetLayer = layerState.layers[historySnapshot.layerIndex];
    layerState.stateChanged = true;
    const handler = Tracker.undoHandlers[historyKind];
    if (handler) handler.call(this, historySnapshot, layerState, targetLayer, historyKind);
    layerState.panelsDirty = true;
  };

  Tracker.prototype.redo = function (historySnapshot, layerState) {
    const historyKind = historySnapshot.actionKind;
    const targetLayer = layerState.layers[historySnapshot.layerIndex];
    layerState.stateChanged = true;
    const handler = Tracker.redoHandlers[historyKind];
    if (handler) handler.call(this, historySnapshot, layerState, targetLayer, historyKind);
    layerState.panelsDirty = true;
  };
}

LayerEffectsTracker.copyContentFillToDescriptor = function (sourceFill, targetDescriptor, fillKindIndex) {
  const propertyKeys = LayerEffectDefs.fillPropertyKeyGroups[fillKindIndex];
  if (targetDescriptor.classID == null) targetDescriptor.classID = FILL_LAYER_CLASS_IDS[fillKindIndex];
  copyPresentFillProperties(sourceFill, targetDescriptor, propertyKeys);
};

LayerEffectsTracker.cloneMaskFromActiveMask = function (doc) {
  const clonedMask = new Mask();
  if (doc.selectionMask != null) {
    clonedMask.color = 0;
    clonedMask.channel = doc.selectionMask.channel.slice(0);
    clonedMask.rect = doc.selectionMask.rect.clone();
  }
  return clonedMask;
};

LayerEffectsTracker.rescaleLinkedPlacedLayers = function (layerState, placedItemId, oldBoundsRect, newBoundsRect) {
  const destCornerCoords = rectToPathOutline(newBoundsRect).coords;
  for (let layerIdx = 0; layerIdx < layerState.layers.length; layerIdx++) {
    const layer = layerState.layers[layerIdx];
    const placedData = layer.add.placedData;
    if (placedData == null || placedData.Idnt.v != placedItemId) continue;
    rescalePlacedLayerTransform(placedData, oldBoundsRect, newBoundsRect, destCornerCoords);
    layer.rasterizeSmartObject(layerState);
  }
  layerState.markDirty();
};

LayerEffectsTracker.invertMaskChannel = function (layerState, mask, layer) {
  mask.color = 255 - mask.color;
  invert(mask.channel);
  mask.maskCombineDirty = true;
  layerState.invalidate(layer);
  layer.markDirty();
};

LayerEffectsTracker.nextDuplicateLayerNameSuffix = function (layerState, namePrefix) {
  let maxSuffix = 0;
  for (let layerIdx = 0; layerIdx < layerState.layers.length; layerIdx++) {
    const parsedSuffix = parseDuplicateNameSuffix(layerState.layers[layerIdx].getName(), namePrefix);
    if (parsedSuffix != null) maxSuffix = parsedSuffix;
  }
  return maxSuffix;
};

LayerEffectsTracker.setLayerLockState = function (layerState, lockEntries, lockPhase) {
  for (let entryIdx = 0; entryIdx < lockEntries.length; entryIdx++) {
    applyPlacedLockEntry(layerState, lockEntries[entryIdx], lockPhase);
  }
};

LayerEffectsTracker.getLayerBoundsForMask = function (maskContext, documentSize) {
  const refSize = maskContext.sourceDocSize;
  const boundsRect = maskContext.rect.clone();
  if (refSize != null && (refSize.x != documentSize.width || refSize.y != documentSize.height)) {
    boundsRect.x = Math.floor((documentSize.width - boundsRect.width) / 2);
    boundsRect.y = Math.floor((documentSize.height - boundsRect.height) / 2);
  }
  return boundsRect;
};

LayerEffectsTracker.refreshLayerAfterHistory = function (layerState, layer) {
  if (layer.warpData) layer.warpData = null;
  else layer.d = null;
  layer.invalidate(layerState);
  layerState.markDirty();
  layer.pixelContent = 0;
};

LayerEffectsTracker.applyLayerSnapshotData = function (layerState, layer, snapshotData) {
  if (layer.d) layer.warpData = snapshotData;
  else layer.d = snapshotData;
  layer.invalidate(layerState);
  layerState.markDirty();
};

LayerEffectsTracker.clearVectorLayerEditState = function (layerState, layer, restoreWarp) {
  if (layer.warpData && restoreWarp) {
    layer.d = layer.warpData;
    layer.warpData = null;
  } else if (layer.d && restoreWarp) {
    layer.d = null;
  }
  delete layer.add.vogk;
  delete layer.add.vstk;
  delete layer.add.vmsk;
  layer.invalidate(layerState);
  layer.pathLayerActive = false;
  layerState.selectedLayerPaths = [];
  layerState.markDirty();
};

LayerEffectsTracker.restoreVectorLayerFromHistory = function (layerState, layer, vectorHistoryPayload) {
  layer.add.vogk = JSON.parse(vectorHistoryPayload.KeyOrigins);
  if (vectorHistoryPayload.StrokeStyleDefs) {
    layer.add.vstk = JSON.parse(vectorHistoryPayload.StrokeStyleDefs);
  } else {
    delete layer.add.vstk;
  }
  layer.add.vmsk = vectorHistoryPayload.maskSnapshot.clone();
  if (layer.d && layer.add.vmsk.isEnabled) layer.warpData = layer.d;
  layer.invalidate(layerState);
  layer.pathLayerActive = vectorHistoryPayload.pathLayerActive;
  layerState.selectedLayerPaths = [layerState.layers.indexOf(layer)];
  layerState.selectedWorkPaths = [];
  layerState.markDirty();
};
