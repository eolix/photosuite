// Undo/redo handler tables for LayerEffectsTracker, keyed by history actionKind.
import { LayerEffectsTracker as Tracker } from "./layer-effects-tracker.js";

import { TrackerRegistry } from "./tracker-registry.js";
import { Layer, LayerSectionType, applyVectorStrokeStyleSnapshot } from "../../document/model/layer.js";
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { showToast } from "../../core/user-prompts.js";
import { PolyToolBase } from "../../document/tools/pen-path-tools.js";
import {
  applyKeyOriginPairs,
  applyRenameEntries,
  assignGroupIndices,
  toggleVectorMaskEnabledState,
  toggleVisibilityFromHistory,
} from "./layer-effects-action-helpers.js";

const undoHandlers = Tracker.undoHandlers;
const redoHandlers = Tracker.redoHandlers;

function markLayerEffectsDirty(targetLayer, layerState) {
  targetLayer.renderCache.dirty = true;
  layerState.markDirty();
}

function applyBlendModes(historySnapshot, layerState, useBefore) {
  const layerIndexList = JSON.parse(historySnapshot.layerIndicesJson);
  for (let loopIdx = 0; loopIdx < layerIndexList.length; loopIdx++) {
    layerState.layers[layerIndexList[loopIdx]].blendMode = useBefore
      ? historySnapshot.blendModesBefore[loopIdx]
      : historySnapshot.layerPropertyValue;
  }
  layerState.markDirty();
}

function applyOpacities(historySnapshot, layerState, useBefore) {
  const layerIndexList = JSON.parse(historySnapshot.layerIndicesJson);
  for (let loopIdx = 0; loopIdx < layerIndexList.length; loopIdx++) {
    layerState.layers[layerIndexList[loopIdx]].Opct = useBefore
      ? historySnapshot.opacitiesBefore[loopIdx]
      : historySnapshot.layerPropertyValue;
  }
  layerState.markDirty();
}

function applyLockFlags(historySnapshot, layerState, useBefore) {
  const layerIndexList = JSON.parse(historySnapshot.layerIndicesJson);
  const flags = useBefore ? historySnapshot.lockFlagsBefore : historySnapshot.layerPropertyValue;
  for (let loopIdx = 0; loopIdx < layerIndexList.length; loopIdx++) {
    const loopLayer = layerState.layers[layerIndexList[loopIdx]];
    if (loopLayer.add.lsct != LayerSectionType.BoundingDivider) loopLayer.add.lspf = flags[loopIdx];
  }
}

function toggleRasterMaskEnabled(targetLayer, layerState) {
  const layerMask = targetLayer.getMask();
  layerMask.isEnabled = !layerMask.isEnabled;
  targetLayer.invalidate(layerState);
  layerState.markDirty();
}

function toggleFilterMaskEnabled(targetLayer, layerState) {
  const layerMask = targetLayer.getLinkedPlacedItem(layerState).d;
  layerMask.isEnabled = !layerMask.isEnabled;
  targetLayer.markDirty();
  layerState.markDirty();
}

function applyFilterFxStack(historySnapshot, targetLayer, layerState, useBefore) {
  const json = useBefore ? historySnapshot.filterFxJsonBefore : historySnapshot.filterFxJsonAfter;
  targetLayer.add.placedData.filterFX.v = JSON.parse(JSON.stringify(json));
  targetLayer.applySmartFilters(layerState);
  layerState.markDirty();
}

function applyReplaceLayerStack(historySnapshot, layerState, useBefore) {
  if (useBefore) {
    if (historySnapshot.selectedLayerIndicesBefore) {
      layerState.selectedLayerIndices = historySnapshot.selectedLayerIndicesBefore;
    }
    if (historySnapshot.activeChannelPair) layerState.selectionMask = historySnapshot.activeChannelPair[0];
    layerState.selectedLayerPaths = null;
    layerState.markDirty();
    layerState.setLayers(historySnapshot.layersBefore);
    return;
  }
  const layerOrder = historySnapshot.layersAfter;
  let artboardDepth = 0;
  let artboardErrorMsg;
  for (let loopIdx = 0; loopIdx < layerOrder.length; loopIdx++) {
    const loopLayer = layerOrder[loopIdx];
    const sectionType = loopLayer.add.lsct;
    if (sectionType == LayerSectionType.BoundingDivider) artboardDepth++;
    else if (sectionType == LayerSectionType.OpenGroup || sectionType == LayerSectionType.ClosedGroup) {
      artboardDepth--;
    }
    if (loopLayer.add.artb && artboardDepth != 0) artboardErrorMsg = "Artboards can not be inside folders.";
  }
  if (artboardErrorMsg) {
    layerState.history.pop();
    layerState.historyIndex--;
    showToast(artboardErrorMsg);
    return;
  }
  if (historySnapshot.selectedLayerIndicesAfter) {
    layerState.selectedLayerIndices = historySnapshot.selectedLayerIndicesAfter;
  }
  if (historySnapshot.activeChannelPair) layerState.selectionMask = historySnapshot.activeChannelPair[1];
  layerState.selectedLayerPaths = null;
  layerState.markDirty();
  layerState.setLayers(historySnapshot.layersAfter);
}

function applyRasterMaskHistory(historySnapshot, layerState, targetLayer, useBefore) {
  if (useBefore) {
    Tracker.refreshLayerAfterHistory(layerState, targetLayer);
    if (historySnapshot.existingMaskSnapshot) {
      Tracker.applyLayerSnapshotData(layerState, targetLayer, historySnapshot.existingMaskSnapshot);
    }
    if (historySnapshot.activeChannelPair) {
      const activeChannel = historySnapshot.activeChannelPair[0];
      if (activeChannel == null) delete layerState.selectionMask;
      else layerState.selectionMask = activeChannel;
    }
    return;
  }
  if (historySnapshot.existingMaskSnapshot) Tracker.refreshLayerAfterHistory(layerState, targetLayer);
  Tracker.applyLayerSnapshotData(layerState, targetLayer, historySnapshot.maskSnapshot);
  if (historySnapshot.activeChannelPair) {
    const activeChannel = historySnapshot.activeChannelPair[1];
    if (activeChannel == null) delete layerState.selectionMask;
    else layerState.selectionMask = activeChannel;
  }
}

function applyCopyRasterMaskHistory(historySnapshot, layerState, useBefore) {
  if (useBefore) {
    Tracker.refreshLayerAfterHistory(layerState, layerState.layers[historySnapshot.destinationLayerIndex]);
    Tracker.applyLayerSnapshotData(
      layerState,
      layerState.layers[historySnapshot.sourceLayerIndex],
      historySnapshot.maskSnapshot,
    );
    return;
  }
  Tracker.refreshLayerAfterHistory(layerState, layerState.layers[historySnapshot.sourceLayerIndex]);
  Tracker.applyLayerSnapshotData(
    layerState,
    layerState.layers[historySnapshot.destinationLayerIndex],
    historySnapshot.maskSnapshot,
  );
}

function applyMoveVectorMaskHistory(historySnapshot, layerState, useBefore) {
  if (useBefore) {
    Tracker.clearVectorLayerEditState(
      layerState,
      layerState.layers[historySnapshot.destinationLayerIndex],
      historySnapshot.maskSnapshot.isEnabled,
    );
    Tracker.restoreVectorLayerFromHistory(
      layerState,
      layerState.layers[historySnapshot.sourceLayerIndex],
      historySnapshot,
    );
    return;
  }
  Tracker.clearVectorLayerEditState(
    layerState,
    layerState.layers[historySnapshot.sourceLayerIndex],
    historySnapshot.maskSnapshot.isEnabled,
  );
  Tracker.restoreVectorLayerFromHistory(
    layerState,
    layerState.layers[historySnapshot.destinationLayerIndex],
    historySnapshot,
  );
}

function applyContentStyleHistory(historySnapshot, layerState, useBefore) {
  const strokeStyleSnapshots = useBefore
    ? historySnapshot.contentStylesBefore
    : historySnapshot.contentStylesAfter;
  for (let loopIdx = 0; loopIdx < historySnapshot.contentLayerIndices.length; loopIdx++) {
    const loopLayer = layerState.layers[historySnapshot.contentLayerIndices[loopIdx]];
    const strokeStyleSnapshot = strokeStyleSnapshots[loopIdx];
    if (!historySnapshot.updateContentFill) {
      loopLayer.add.vstk = JSON.parse(JSON.stringify(strokeStyleSnapshot));
    } else {
      applyVectorStrokeStyleSnapshot(
        loopLayer,
        JSON.parse(JSON.stringify(strokeStyleSnapshot)),
      );
    }
    loopLayer.renderFillContent(layerState);
  }
  layerState.markDirty();
}

function applyLabelColors(historySnapshot, layerState, useBefore) {
  const colors = useBefore ? historySnapshot.colorsBefore : historySnapshot.colorsAfter;
  for (let loopIdx = 0; loopIdx < historySnapshot.layerIndices.length; loopIdx++) {
    layerState.layers[historySnapshot.layerIndices[loopIdx]].add.lclr = colors[loopIdx];
  }
}

undoHandlers[Layer.updateLinkedItem] = function (historySnapshot, layerState) {
  layerState.add.lnk2.splice(
    layerState.add.lnk2.indexOf(historySnapshot.linkedItemAfter),
    1,
    historySnapshot.linkedItemBefore,
  );
  Tracker.rescaleLinkedPlacedLayers(
    layerState,
    historySnapshot.id,
    historySnapshot.linkedItemAfter.rasterCache[1],
    historySnapshot.linkedItemBefore.rasterCache[1],
  );
};
redoHandlers[Layer.updateLinkedItem] = function (historySnapshot, layerState) {
  layerState.add.lnk2.splice(
    layerState.add.lnk2.indexOf(historySnapshot.linkedItemBefore),
    1,
    historySnapshot.linkedItemAfter,
  );
  Tracker.rescaleLinkedPlacedLayers(
    layerState,
    historySnapshot.id,
    historySnapshot.linkedItemBefore.rasterCache[1],
    historySnapshot.linkedItemAfter.rasterCache[1],
  );
};

undoHandlers[Layer.setSmartObjectStackMode] = function (historySnapshot, layerState, targetLayer) {
  targetLayer.add.placedData.Impr.v.classID = historySnapshot.placedFilterClassId;
  targetLayer.rasterizeSmartObject(layerState);
};
redoHandlers[Layer.setSmartObjectStackMode] = function (historySnapshot, layerState, targetLayer) {
  targetLayer.add.placedData.Impr.v.classID = historySnapshot.stackModeClassId;
  targetLayer.rasterizeSmartObject(layerState);
};

undoHandlers[Layer.setBlendMode] = function (historySnapshot, layerState) {
  applyBlendModes(historySnapshot, layerState, true);
};
redoHandlers[Layer.setBlendMode] = function (historySnapshot, layerState) {
  applyBlendModes(historySnapshot, layerState, false);
};

undoHandlers[Layer.setLayerOpacity] = function (historySnapshot, layerState) {
  applyOpacities(historySnapshot, layerState, true);
};
redoHandlers[Layer.setLayerOpacity] = function (historySnapshot, layerState) {
  applyOpacities(historySnapshot, layerState, false);
};

undoHandlers[Layer.toggleLayerLocks] = function (historySnapshot, layerState) {
  applyLockFlags(historySnapshot, layerState, true);
};
redoHandlers[Layer.toggleLayerLocks] = function (historySnapshot, layerState) {
  applyLockFlags(historySnapshot, layerState, false);
};

undoHandlers[Layer.setLayerType] = function (historySnapshot, layerState, targetLayer) {
  const removedMetadataPair = historySnapshot.layerMetadataAfter;
  const restoredMetadataPair = historySnapshot.layerMetadataBefore;
  delete targetLayer.add[removedMetadataPair[0]];
  if (restoredMetadataPair[0] != "----") targetLayer.add[restoredMetadataPair[0]] = restoredMetadataPair[1];
};
redoHandlers[Layer.setLayerType] = function (historySnapshot, layerState, targetLayer) {
  const restoredMetadataPair = historySnapshot.layerMetadataBefore;
  const removedMetadataPair = historySnapshot.layerMetadataAfter;
  delete targetLayer.add[restoredMetadataPair[0]];
  if (removedMetadataPair[0] != "----") targetLayer.add[removedMetadataPair[0]] = removedMetadataPair[1];
};

undoHandlers[Layer.setFillOpacity] = function (historySnapshot, layerState, targetLayer) {
  targetLayer.add.iOpa = historySnapshot.fillOpacityBefore;
  layerState.markDirty();
};
redoHandlers[Layer.setFillOpacity] = function (historySnapshot, layerState, targetLayer) {
  targetLayer.add.iOpa = historySnapshot.layerPropertyValue;
  layerState.markDirty();
};

undoHandlers[Layer.toggleVisibility] = redoHandlers[Layer.toggleVisibility] = toggleVisibilityFromHistory;

undoHandlers[Layer.toggleRasterMask] = redoHandlers[Layer.toggleRasterMask] = function (
  historySnapshot,
  layerState,
  targetLayer,
) {
  toggleRasterMaskEnabled(targetLayer, layerState);
};

undoHandlers[Layer.toggleFilterMask] = redoHandlers[Layer.toggleFilterMask] = function (
  historySnapshot,
  layerState,
  targetLayer,
) {
  toggleFilterMaskEnabled(targetLayer, layerState);
};

undoHandlers[Layer.toggleVectorMask] = redoHandlers[Layer.toggleVectorMask] = function (
  historySnapshot,
  layerState,
  targetLayer,
) {
  toggleVectorMaskEnabledState(targetLayer, layerState);
};

undoHandlers[Layer.toggleClippingMask] = redoHandlers[Layer.toggleClippingMask] = function (
  historySnapshot,
  layerState,
  targetLayer,
) {
  targetLayer.isClippingMask = !targetLayer.isClippingMask;
  layerState.markDirty();
};

undoHandlers[Layer.toggleLayerEffectsMaster] = redoHandlers[Layer.toggleLayerEffectsMaster] = function (
  historySnapshot,
  layerState,
  targetLayer,
) {
  targetLayer.add.lmfx.masterFXSwitch.v = !targetLayer.add.lmfx.masterFXSwitch.v;
  markLayerEffectsDirty(targetLayer, layerState);
};

undoHandlers[Layer.toggleSmartFiltersMaster] = redoHandlers[Layer.toggleSmartFiltersMaster] = function (
  historySnapshot,
  layerState,
  targetLayer,
) {
  targetLayer.add.placedData.filterFX.v.enab.v = !targetLayer.add.placedData.filterFX.v.enab.v;
  targetLayer.applySmartFilters(layerState);
  layerState.markDirty();
};

undoHandlers[Layer.toggleLayerEffectVariant] = redoHandlers[Layer.toggleLayerEffectVariant] = function (
  historySnapshot,
  layerState,
  targetLayer,
) {
  const effectPathIdx = historySnapshot.index;
  const effectVariantDesc = targetLayer.add.lmfx[LayerEffectDefs.effectKeys[effectPathIdx[0]]].v[effectPathIdx[1]].v;
  effectVariantDesc.enab.v = !effectVariantDesc.enab.v;
  markLayerEffectsDirty(targetLayer, layerState);
};

undoHandlers[Layer.copyLayerStyle] = function (historySnapshot, layerState) {
  const sourceLayer = layerState.layers[historySnapshot.sourceLayerIndex];
  const destLayer = layerState.layers[historySnapshot.destinationLayerIndex];
  const sourceEffectsJson = historySnapshot.sourceEffectsJsonBefore;
  const destEffectsJson = historySnapshot.destEffectsJsonBefore;
  if (sourceEffectsJson == "") delete sourceLayer.add.lmfx;
  else sourceLayer.add.lmfx = JSON.parse(sourceEffectsJson);
  if (destEffectsJson == "") delete destLayer.add.lmfx;
  else destLayer.add.lmfx = JSON.parse(destEffectsJson);
  sourceLayer.renderCache.dirty = true;
  destLayer.renderCache.dirty = true;
  layerState.markDirty();
};
redoHandlers[Layer.copyLayerStyle] = function (historySnapshot, layerState) {
  const sourceLayer = layerState.layers[historySnapshot.sourceLayerIndex];
  const destLayer = layerState.layers[historySnapshot.destinationLayerIndex];
  const sourceEffectsJson = historySnapshot.sourceEffectsJsonAfter;
  const destEffectsJson = historySnapshot.destEffectsJsonAfter;
  if (sourceEffectsJson == "") delete sourceLayer.add.lmfx;
  else sourceLayer.add.lmfx = JSON.parse(sourceEffectsJson);
  if (destEffectsJson == "") delete destLayer.add.lmfx;
  else destLayer.add.lmfx = JSON.parse(destEffectsJson);
  sourceLayer.renderCache.dirty = true;
  destLayer.renderCache.dirty = true;
  layerState.markDirty();
};

undoHandlers[Layer.toggleSmartFilterVariant] = redoHandlers[Layer.toggleSmartFilterVariant] = function (
  historySnapshot,
  layerState,
  targetLayer,
) {
  const filterFxEntry = targetLayer.add.placedData.filterFX.v.filterFXList.v[historySnapshot.index].v;
  filterFxEntry.enab.v = !filterFxEntry.enab.v;
  targetLayer.applySmartFilters(layerState);
  layerState.markDirty();
};

undoHandlers[Layer.restoreFilterFxStack] = function (historySnapshot, layerState, targetLayer) {
  applyFilterFxStack(historySnapshot, targetLayer, layerState, true);
};
redoHandlers[Layer.restoreFilterFxStack] = function (historySnapshot, layerState, targetLayer) {
  applyFilterFxStack(historySnapshot, targetLayer, layerState, false);
};

undoHandlers[Layer.toggleRasterMaskEnabled] = redoHandlers[Layer.toggleRasterMaskEnabled] = function (
  historySnapshot,
  layerState,
  targetLayer,
) {
  const layerMask = targetLayer.getMask();
  layerMask.enabled = !layerMask.enabled;
};

undoHandlers[Layer.toggleVectorMaskEnabled] = redoHandlers[Layer.toggleVectorMaskEnabled] = function (
  historySnapshot,
  layerState,
  targetLayer,
) {
  const layerMask = targetLayer.add.vmsk;
  layerMask.enabled = !layerMask.enabled;
};

undoHandlers[Layer.transformKeyOrigins] = function (historySnapshot, layerState) {
  applyKeyOriginPairs(layerState, historySnapshot.keyOriginsBefore);
};
redoHandlers[Layer.transformKeyOrigins] = function (historySnapshot, layerState) {
  applyKeyOriginPairs(layerState, historySnapshot.keyOriginsAfter);
};

undoHandlers[Layer.editArtboard] = function (historySnapshot, layerState, targetLayer) {
  targetLayer.add.artb = JSON.parse(historySnapshot.artboardJsonBefore);
  layerState.markDirty();
};
redoHandlers[Layer.editArtboard] = function (historySnapshot, layerState, targetLayer) {
  targetLayer.add.artb = JSON.parse(historySnapshot.artboardJsonAfter);
  layerState.markDirty();
};

undoHandlers[Layer.extraChannelOp] = function (historySnapshot, layerState) {
  layerState.selectionMask = historySnapshot.selectionMaskBefore;
  layerState.extraChannels = historySnapshot.extraChannelsBefore.slice(0);
  layerState.activeChannels = historySnapshot.activeChannelsBefore.slice(0);
  layerState.dirty = layerState.panelsDirty = true;
};
redoHandlers[Layer.extraChannelOp] = function (historySnapshot, layerState) {
  layerState.selectionMask = historySnapshot.selectionMaskAfter;
  layerState.extraChannels = historySnapshot.extraChannelsAfter.slice(0);
  layerState.activeChannels = historySnapshot.activeChannelsAfter.slice(0);
  layerState.dirty = layerState.panelsDirty = true;
};

undoHandlers[Layer.linkLayers] = function (historySnapshot, layerState) {
  assignGroupIndices(layerState, historySnapshot.layerGroupIndicesBefore);
};
redoHandlers[Layer.linkLayers] = function (historySnapshot, layerState) {
  assignGroupIndices(layerState, historySnapshot.layerGroupIndicesAfter);
};

undoHandlers[Layer.replaceLayerStack] = function (historySnapshot, layerState) {
  applyReplaceLayerStack(historySnapshot, layerState, true);
};
redoHandlers[Layer.replaceLayerStack] = function (historySnapshot, layerState) {
  applyReplaceLayerStack(historySnapshot, layerState, false);
};

undoHandlers[Layer.addRasterMask] = function (historySnapshot, layerState, targetLayer) {
  applyRasterMaskHistory(historySnapshot, layerState, targetLayer, true);
};
redoHandlers[Layer.addRasterMask] = function (historySnapshot, layerState, targetLayer) {
  applyRasterMaskHistory(historySnapshot, layerState, targetLayer, false);
};

undoHandlers[Layer.copyRasterMask] = function (historySnapshot, layerState) {
  applyCopyRasterMaskHistory(historySnapshot, layerState, true);
};
redoHandlers[Layer.copyRasterMask] = function (historySnapshot, layerState) {
  applyCopyRasterMaskHistory(historySnapshot, layerState, false);
};

undoHandlers[Layer.deleteRasterMask] = function (historySnapshot, layerState, targetLayer) {
  Tracker.applyLayerSnapshotData(layerState, targetLayer, historySnapshot.maskSnapshot);
};
redoHandlers[Layer.deleteRasterMask] = function (historySnapshot, layerState, targetLayer) {
  Tracker.refreshLayerAfterHistory(layerState, targetLayer);
};

undoHandlers[Layer.addFilterMask] = function (historySnapshot, layerState, targetLayer) {
  targetLayer.getLinkedPlacedItem(layerState).d = null;
  targetLayer.markDirty();
  layerState.markDirty();
};
redoHandlers[Layer.addFilterMask] = function (historySnapshot, layerState, targetLayer) {
  targetLayer.getLinkedPlacedItem(layerState).d = historySnapshot.maskSnapshot;
  targetLayer.pixelContent = 0;
  targetLayer.markDirty();
  layerState.markDirty();
};

undoHandlers[Layer.deleteFilterMask] = function (historySnapshot, layerState, targetLayer) {
  targetLayer.getLinkedPlacedItem(layerState).d = historySnapshot.maskSnapshot;
  targetLayer.markDirty();
  layerState.markDirty();
};
redoHandlers[Layer.deleteFilterMask] = function (historySnapshot, layerState, targetLayer) {
  targetLayer.getLinkedPlacedItem(layerState).d = null;
  targetLayer.pixelContent = 0;
  targetLayer.markDirty();
  layerState.markDirty();
};

undoHandlers[Layer.mutatePlacedDataLocks] = function (historySnapshot, layerState) {
  Tracker.setLayerLockState(layerState, historySnapshot.placedDataLockEntries, 0);
};
redoHandlers[Layer.mutatePlacedDataLocks] = function (historySnapshot, layerState) {
  Tracker.setLayerLockState(layerState, historySnapshot.placedDataLockEntries, 1);
};

undoHandlers[Layer.addVectorMask] = function (historySnapshot, layerState, targetLayer) {
  Tracker.clearVectorLayerEditState(layerState, targetLayer, true);
};
redoHandlers[Layer.addVectorMask] = function (historySnapshot, layerState, targetLayer) {
  Tracker.restoreVectorLayerFromHistory(layerState, targetLayer, historySnapshot);
};

undoHandlers[Layer.moveVectorMask] = function (historySnapshot, layerState) {
  applyMoveVectorMaskHistory(historySnapshot, layerState, true);
};
redoHandlers[Layer.moveVectorMask] = function (historySnapshot, layerState) {
  applyMoveVectorMaskHistory(historySnapshot, layerState, false);
};

undoHandlers[Layer.deleteVectorMask] = function (historySnapshot, layerState, targetLayer) {
  Tracker.restoreVectorLayerFromHistory(layerState, targetLayer, historySnapshot);
};
redoHandlers[Layer.deleteVectorMask] = function (historySnapshot, layerState, targetLayer) {
  Tracker.clearVectorLayerEditState(layerState, targetLayer, historySnapshot.maskSnapshot.isEnabled);
};

undoHandlers[Layer.updateMetadata] = function (historySnapshot, layerState) {
  layerState.xmpMetadata = JSON.parse(historySnapshot.xmpMetadataBefore);
};
redoHandlers[Layer.updateMetadata] = function (historySnapshot, layerState) {
  layerState.xmpMetadata = JSON.parse(historySnapshot.xmpMetadataAfter);
};

undoHandlers[Layer.renameDocument] = function (historySnapshot, layerState) {
  layerState.name = historySnapshot.documentNameBefore;
};
redoHandlers[Layer.renameDocument] = function (historySnapshot, layerState) {
  layerState.name = historySnapshot.documentNameAfter;
};

undoHandlers[Layer.renameLayer] = function (historySnapshot, layerState) {
  applyRenameEntries(layerState, historySnapshot.renameEntries, 1, 3);
};
redoHandlers[Layer.renameLayer] = function (historySnapshot, layerState) {
  applyRenameEntries(layerState, historySnapshot.renameEntries, 2, 4);
};

undoHandlers[Layer.setLayerLabelColor] = function (historySnapshot, layerState) {
  applyLabelColors(historySnapshot, layerState, true);
};
redoHandlers[Layer.setLayerLabelColor] = function (historySnapshot, layerState) {
  applyLabelColors(historySnapshot, layerState, false);
};

undoHandlers[Layer.updateContentStyle] = function (historySnapshot, layerState) {
  applyContentStyleHistory(historySnapshot, layerState, true);
};
redoHandlers[Layer.updateContentStyle] = function (historySnapshot, layerState) {
  applyContentStyleHistory(historySnapshot, layerState, false);
};

undoHandlers[Layer.maskDensityFeather] = function (historySnapshot, layerState, targetLayer) {
  targetLayer.applyMaskSettings(historySnapshot.maskSettingsBefore);
  targetLayer.invalidate(layerState);
  layerState.markDirty();
};
redoHandlers[Layer.maskDensityFeather] = function (historySnapshot, layerState, targetLayer) {
  targetLayer.applyMaskSettings(historySnapshot.maskSettingsAfter);
  targetLayer.invalidate(layerState);
  layerState.markDirty();
};
