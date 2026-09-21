// Layer Style dialog tracker: live lmfx / blending edits, copy-paste-clear,
// and history undo/redo for the plugin-channel style session.

import { BlendModes } from "../../document/model/blend-modes.js";
import { EventChannel } from "../../document/model/tool-base.js";
import { normalizeLayerEffectsOnWrite } from "../../document/formats/psd/psd-layer-effects.js";
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { ActionDescUtil } from "../scripting/action-desc.js";
import { HistoryEntry} from "../../document/model/document.js";
import { LayerStyleRenderer } from "../layer-styles/style-renderer.js";
import { TrackerRegistry } from "./tracker-registry.js";
import { findPattern } from "../../document/formats/psd/layer-data-parsers.js";
import { EventType } from "../../core/event-bus.js";
import { AppEvent } from "../../core/event-bus.js";

// Glow effect order slots that share exclusive Clr / Grad fill slots.
const OUTER_INNER_GLOW_ORDER_INDICES = [3, 8];

export function LayerStyleDialogTracker() {
  TrackerRegistry.TrackerBase.call(this, EventChannel.EVENT_PLUGIN);
  this.blendingOptionsJsonBefore = null;
  this.effectsJsonBefore = null;
  this.blendingOptionsSnapshot = null;
  this.effectDefaults = [];
  this.copiedStyleJson = null;
}

LayerStyleDialogTracker.prototype = Object.create(TrackerRegistry.TrackerBase.prototype);
installLayerStyleDialogTrackerPrototype(LayerStyleDialogTracker);

function resolveStyleLayerIndex(styleEvent, layerState) {
  if (styleEvent.layerIndex != null) return styleEvent.layerIndex;
  return layerState.selectedLayerIndices[0];
}

function ensureLmfxRoot(targetLayer) {
  if (targetLayer.add.lmfx != null) return;
  targetLayer.add.lmfx = LayerEffectDefs.createLmfxRootTemplate();
  for (let effectKindIdx = 0; effectKindIdx < LayerEffectDefs.order.length; effectKindIdx++) {
    targetLayer.add.lmfx[LayerEffectDefs.effectKeys[effectKindIdx]] = { t: "VlLs", v: [] };
  }
}

function captureSessionBaseline(tracker, layerState, targetLayer) {
  if (tracker.blendingOptionsJsonBefore != null) return;
  tracker.blendingOptionsSnapshot = LayerStyleDialogTracker.snapshotBlendingOptions(layerState, targetLayer);
  tracker.blendingOptionsJsonBefore = JSON.stringify(tracker.blendingOptionsSnapshot);
  if (targetLayer.add.lmfx) tracker.effectsJsonBefore = JSON.stringify(targetLayer.add.lmfx);
}

function resolveEffectTemplate(tracker, effectOrderIndex) {
  const cachedTemplate = tracker.effectDefaults[effectOrderIndex];
  if (cachedTemplate == null) return LayerEffectDefs.getEffectDefaultByOrderIndex(effectOrderIndex);
  return JSON.parse(cachedTemplate);
}

function ensureEffectVariant(tracker, targetLayer, effectPathIdx) {
  const defaultEffectTemplate = resolveEffectTemplate(tracker, effectPathIdx[0]);
  const effectVariantList = targetLayer.add.lmfx[LayerEffectDefs.effectKeys[effectPathIdx[0]]].v;
  if (effectVariantList[effectPathIdx[1]] == null) {
    effectVariantList[effectPathIdx[1]] = { t: "Objc", v: defaultEffectTemplate };
  }
  const activeEffectDesc = effectVariantList[effectPathIdx[1]].v;
  for (const defaultPropKey in defaultEffectTemplate) {
    if (activeEffectDesc[defaultPropKey] == null) {
      activeEffectDesc[defaultPropKey] = defaultEffectTemplate[defaultPropKey];
    }
  }
  return activeEffectDesc;
}

function applyChangeProp(tracker, styleEvent, layerState, targetLayer, effectPathIdx, activeEffectDesc) {
  if (effectPathIdx == 0) {
    tracker.blendingOptionsSnapshot[styleEvent.descriptorKey].v = styleEvent.value;
    LayerStyleDialogTracker.applyBlendingSnapshot(layerState, targetLayer, tracker.blendingOptionsSnapshot);
    return;
  }
  if (styleEvent.descriptorKey == "lagl") {
    if (activeEffectDesc.uglg && activeEffectDesc.uglg.v) {
      layerState.setRotationAngle(styleEvent.value.val);
      tracker.blendingOptionsSnapshot.rotationAngle = layerState.getRotationAngle();
    } else {
      activeEffectDesc[styleEvent.descriptorKey].v = styleEvent.value;
    }
    return;
  }
  if (styleEvent.descriptorKey == "Lald") {
    if (activeEffectDesc.uglg.v) {
      layerState.setGlobalLightAngle(styleEvent.value.val);
      tracker.blendingOptionsSnapshot.globalLightAngle = layerState.getGlobalLightAngle();
    } else {
      activeEffectDesc[styleEvent.descriptorKey].v = styleEvent.value;
    }
    return;
  }
  const isGlowClrGrad =
    (effectPathIdx[0] == OUTER_INNER_GLOW_ORDER_INDICES[0] ||
      effectPathIdx[0] == OUTER_INNER_GLOW_ORDER_INDICES[1]) &&
    (styleEvent.descriptorKey == "Clr" || styleEvent.descriptorKey == "Grad");
  if (isGlowClrGrad) {
    if (styleEvent.descriptorKey == "Clr") {
      activeEffectDesc.Clr = { t: "Objc", v: styleEvent.value };
      delete activeEffectDesc.Grad;
    }
    if (styleEvent.descriptorKey == "Grad") {
      activeEffectDesc.Grad = { t: "Objc", v: styleEvent.value };
      delete activeEffectDesc.Clr;
    }
    return;
  }
  activeEffectDesc[styleEvent.descriptorKey].v = styleEvent.value;
}

function buildStyleHistoryData(layerIndices, effectsBefore, effectsAfter, blendingBefore, blendingAfter) {
  return {
    layerIndices,
    effectsBeforeJson: effectsBefore,
    effectsAfterJson: effectsAfter,
    blendingBeforeJson: blendingBefore,
    blendingAfterJson: blendingAfter,
  };
}

function applyEffectsJsonToLayer(targetLayer, effectsJson) {
  if (effectsJson == null) delete targetLayer.add.lmfx;
  else targetLayer.add.lmfx = JSON.parse(effectsJson);
}

function clearSessionBaseline(tracker) {
  tracker.blendingOptionsJsonBefore = null;
  tracker.effectsJsonBefore = null;
}

function resetBlendingSnapshotToDefaults(blendingSnapshot) {
  blendingSnapshot.lrMd.v = 0;
  blendingSnapshot.Opct.v.val = 100;
  blendingSnapshot.iOpa.v.val = 100;
  blendingSnapshot.blIf = { v: [] };
  for (let blendIfBandIdx = 0; blendIfBandIdx < 10; blendIfBandIdx++) {
    blendingSnapshot.blIf.v.push(0, 0, 255, 255);
  }
}

function dispatchLefxHistoryGrouped(docModel, effectsJsonAfter) {
  if (effectsJsonAfter == null) return;
  const parsedEffects = JSON.parse(effectsJsonAfter);
  normalizeLayerEffectsOnWrite(parsedEffects);
  parsedEffects.classID = "Lefx";
  delete parsedEffects.masterFXSwitch;
  const groupedHistoryEvent = new AppEvent(EventType.historyGrouped);
  groupedHistoryEvent.fromDialog = true;
  groupedHistoryEvent.data = {
    uf: "set",
    skipActionRecording: true,
  };
  const layerActionRef = ActionDescUtil.buildTargetRef("Lyr", true);
  layerActionRef.v.splice(0, 0, {
    t: "prop",
    v: {
      classID: "Prpr",
      keyID: "Lefx",
    },
  });
  groupedHistoryEvent.data.actionDescriptor = {
    __name: "Set",
    classID: "setd",
    null: layerActionRef,
    T: {
      t: "Objc",
      v: parsedEffects,
    },
  };
  docModel.dispatch(groupedHistoryEvent);
}

function handleScaleEffects(tracker, styleEvent, docModel, layerState, keyboardCtx, appData, targetLayer) {
  if (styleEvent.dialogResult == "confirm" || styleEvent.dialogResult == "cancel") {
    tracker.handleInput({ actionKind: styleEvent.dialogResult }, docModel, layerState, keyboardCtx, appData);
    return true;
  }
  targetLayer.add.lmfx = JSON.parse(tracker.effectsJsonBefore);
  LayerStyleRenderer.scaleLayerEffectSizes(targetLayer.add.lmfx, styleEvent.dialogResult / 100);
  return false;
}

function handleSetStyle(tracker, styleEvent, layerState, targetLayer, appData) {
  const lefxDescriptor = styleEvent.value.Lefx;
  if (lefxDescriptor) LayerStyleRenderer.refreshPatternPickerWidgets(lefxDescriptor, layerState, appData.patternPresets);
  LayerStyleRenderer.applyGlobalLightAngle(styleEvent.value, targetLayer);
  tracker.blendingOptionsSnapshot = LayerStyleDialogTracker.snapshotBlendingOptions(layerState, targetLayer);
}

function handleDuplicateSingle(styleEvent, targetLayer) {
  const effectVariants = targetLayer.add.lmfx[LayerEffectDefs.effectKeys[styleEvent.effectPathIndices[0]]].v;
  if (effectVariants[styleEvent.effectPathIndices[1]] == null) return false;
  const clonedVariant = JSON.parse(JSON.stringify(effectVariants[styleEvent.effectPathIndices[1]]));
  effectVariants.splice(styleEvent.effectPathIndices[1], 0, clonedVariant);
  return true;
}

function handleMoveSingle(styleEvent, targetLayer) {
  const moveFromIdx = styleEvent.effectPathIndices[1];
  const effectVariants = targetLayer.add.lmfx[LayerEffectDefs.effectKeys[styleEvent.effectPathIndices[0]]].v;
  if (effectVariants[styleEvent.effectPathIndices[1]] == null) return false;
  const moveToIdx = Math.max(0, Math.min(effectVariants.length - 1, moveFromIdx + styleEvent.moveDelta));
  const swapTemp = effectVariants[moveToIdx];
  effectVariants[moveToIdx] = effectVariants[moveFromIdx];
  effectVariants[moveFromIdx] = swapTemp;
  return true;
}

function handleCancel(tracker, layerState, targetLayer) {
  if (tracker.effectsJsonBefore == null) delete targetLayer.add.lmfx;
  else targetLayer.add.lmfx = JSON.parse(tracker.effectsJsonBefore);
  LayerStyleDialogTracker.applyBlendingSnapshot(
    layerState,
    targetLayer,
    JSON.parse(tracker.blendingOptionsJsonBefore),
  );
  clearSessionBaseline(tracker);
}

function handleConfirm(tracker, docModel, layerState, layerIndex, targetLayer) {
  const effectsJsonAfter = JSON.stringify(targetLayer.add.lmfx);
  const historyEntry = new HistoryEntry("dialogs.layerStyle", tracker);
  historyEntry.data = buildStyleHistoryData(
    [layerIndex],
    [tracker.effectsJsonBefore],
    [effectsJsonAfter],
    [tracker.blendingOptionsJsonBefore],
    [JSON.stringify(tracker.blendingOptionsSnapshot)],
  );
  layerState.pushHistory(historyEntry);
  clearSessionBaseline(tracker);
  dispatchLefxHistoryGrouped(docModel, effectsJsonAfter);
}

function handleCopyStyle(tracker) {
  tracker.copiedStyleJson = [tracker.blendingOptionsJsonBefore, tracker.effectsJsonBefore];
  clearSessionBaseline(tracker);
}

function handlePasteOrClear(tracker, styleEvent, layerState) {
  if (styleEvent.actionKind == "st_paste" && tracker.copiedStyleJson == null) return;
  const targetLayerIndices =
    styleEvent.layerIndex != null ? [styleEvent.layerIndex] : layerState.selectedLayerIndices.slice(0);
  const effectsBeforeSnapshots = [];
  const effectsAfterSnapshots = [];
  const blendingBeforeSnapshots = [];
  const blendingAfterSnapshots = [];
  for (let loopIdx = 0; loopIdx < targetLayerIndices.length; loopIdx++) {
    const pasteTargetLayer = layerState.layers[targetLayerIndices[loopIdx]];
    const blendingSnapshot = LayerStyleDialogTracker.snapshotBlendingOptions(layerState, pasteTargetLayer);
    effectsBeforeSnapshots.push(pasteTargetLayer.add.lmfx ? JSON.stringify(pasteTargetLayer.add.lmfx) : null);
    blendingBeforeSnapshots.push(JSON.stringify(blendingSnapshot));
    if (styleEvent.actionKind == "st_paste") {
      effectsAfterSnapshots.push(tracker.copiedStyleJson[1]);
      blendingAfterSnapshots.push(tracker.copiedStyleJson[0]);
    } else {
      effectsAfterSnapshots.push(null);
      resetBlendingSnapshotToDefaults(blendingSnapshot);
      blendingAfterSnapshots.push(JSON.stringify(blendingSnapshot));
    }
  }
  const historyEntry = new HistoryEntry("dialogs.layerStyle", tracker);
  historyEntry.data = buildStyleHistoryData(
    targetLayerIndices,
    effectsBeforeSnapshots,
    effectsAfterSnapshots,
    blendingBeforeSnapshots,
    blendingAfterSnapshots,
  );
  tracker.redo(historyEntry.data, layerState);
  layerState.pushHistory(historyEntry);
  clearSessionBaseline(tracker);
}

function handleCommitOther(tracker, styleEvent, layerState, layerIndex, targetLayer) {
  const pendingBlendingSnapshot = tracker.blendingOptionsSnapshot;
  let effectsJsonAfter = null;
  if (styleEvent.actionKind == "st_delsingle") {
    effectsJsonAfter = JSON.parse(tracker.effectsJsonBefore);
    effectsJsonAfter[LayerEffectDefs.effectKeys[styleEvent.effectPathIndices[0]]].v.splice(
      styleEvent.effectPathIndices[1],
      1,
    );
    effectsJsonAfter = JSON.stringify(effectsJsonAfter);
  }
  applyEffectsJsonToLayer(targetLayer, effectsJsonAfter);
  if (pendingBlendingSnapshot != null) {
    LayerStyleDialogTracker.applyBlendingSnapshot(layerState, targetLayer, pendingBlendingSnapshot);
  }
  const historyEntry = new HistoryEntry("dialogs.layerStyle", tracker);
  historyEntry.data = buildStyleHistoryData(
    [layerIndex],
    [tracker.effectsJsonBefore],
    [effectsJsonAfter],
    [tracker.blendingOptionsJsonBefore],
    [JSON.stringify(pendingBlendingSnapshot)],
  );
  layerState.pushHistory(historyEntry);
  clearSessionBaseline(tracker);
}

function installLayerStyleDialogTrackerPrototype(Tracker) {
  Tracker.prototype.handleInput = function (styleEvent, docModel, layerState, keyboardCtx, appData) {
    const layerIndex = resolveStyleLayerIndex(styleEvent, layerState);
    const targetLayer = layerState.layers[layerIndex];
    captureSessionBaseline(this, layerState, targetLayer);
    ensureLmfxRoot(targetLayer);

    if (styleEvent.actionKind == "scaleeffects") {
      if (handleScaleEffects(this, styleEvent, docModel, layerState, keyboardCtx, appData, targetLayer)) {
        return;
      }
    } else if (styleEvent.actionKind == "changeprop") {
      const effectPathIdx = styleEvent.idx;
      let activeEffectDesc = null;
      if (effectPathIdx != 0) activeEffectDesc = ensureEffectVariant(this, targetLayer, effectPathIdx);
      if (styleEvent.actionKind == "changeprop") {
        applyChangeProp(this, styleEvent, layerState, targetLayer, effectPathIdx, activeEffectDesc);
        if (effectPathIdx != 0) this.effectDefaults[effectPathIdx[0]] = JSON.stringify(activeEffectDesc);
      }
      if (effectPathIdx != 0 && activeEffectDesc && activeEffectDesc.Ptrn) {
        layerState.registerPattern(findPattern(activeEffectDesc.Ptrn.v, appData.patternPresets));
      }
    } else if (styleEvent.actionKind == "setstl") {
      handleSetStyle(this, styleEvent, layerState, targetLayer, appData);
    } else if (styleEvent.actionKind == "st_dupsingle") {
      if (!handleDuplicateSingle(styleEvent, targetLayer)) return;
    } else if (styleEvent.actionKind == "st_movsingle") {
      if (!handleMoveSingle(styleEvent, targetLayer)) return;
    } else if (styleEvent.actionKind == "cancel") {
      handleCancel(this, layerState, targetLayer);
    } else if (styleEvent.actionKind == "confirm") {
      handleConfirm(this, docModel, layerState, layerIndex, targetLayer);
    } else if (styleEvent.actionKind == "st_copy") {
      handleCopyStyle(this);
    } else if (styleEvent.actionKind == "st_paste" || styleEvent.actionKind == "st_clear") {
      handlePasteOrClear(this, styleEvent, layerState);
    } else {
      handleCommitOther(this, styleEvent, layerState, layerIndex, targetLayer);
    }

    targetLayer.renderCache.dirty = true;
    layerState.stateChanged = true;
    layerState.markDirty();
  };

  Tracker.prototype.undo = function (historyData, layerState) {
    for (let loopIdx = 0; loopIdx < historyData.layerIndices.length; loopIdx++) {
      const targetLayer = layerState.layers[historyData.layerIndices[loopIdx]];
      applyEffectsJsonToLayer(targetLayer, historyData.effectsBeforeJson[loopIdx]);
      LayerStyleDialogTracker.applyBlendingSnapshot(
        layerState,
        targetLayer,
        JSON.parse(historyData.blendingBeforeJson[loopIdx]),
      );
      targetLayer.renderCache.dirty = true;
    }
    layerState.stateChanged = true;
    layerState.markDirty();
  };

  Tracker.prototype.redo = function (historyData, layerState) {
    for (let loopIdx = 0; loopIdx < historyData.layerIndices.length; loopIdx++) {
      const targetLayer = layerState.layers[historyData.layerIndices[loopIdx]];
      applyEffectsJsonToLayer(targetLayer, historyData.effectsAfterJson[loopIdx]);
      LayerStyleDialogTracker.applyBlendingSnapshot(
        layerState,
        targetLayer,
        JSON.parse(historyData.blendingAfterJson[loopIdx]),
      );
      targetLayer.renderCache.dirty = true;
    }
    layerState.stateChanged = true;
    layerState.markDirty();
  };
}

LayerStyleDialogTracker.snapshotBlendingOptions = function (layerState, layer) {
  if (layer.add.iOpa == null) layer.add.iOpa = 255;
  if (layer.add.brst == null) layer.add.brst = [1, 1, 1];
  const blendModeCodes = layer.isGroup() ? ["pass"].concat(BlendModes.psdCodes) : BlendModes.psdCodes;
  return {
    lrMd: { v: blendModeCodes.indexOf(layer.blendMode) },
    Opct: {
      v: {
        type: "#Prc",
        val: Math.round((layer.Opct * 100) / 255),
      },
      t: "UntF",
    },
    iOpa: {
      v: {
        type: "#Prc",
        val: Math.round((layer.add.iOpa * 100) / 255),
      },
      t: "UntF",
    },
    blIf: { v: layer.blendIfData.slice(0) },
    brst: { v: layer.add.brst },
    rotationAngle: layerState.getRotationAngle(),
    globalLightAngle: layerState.getGlobalLightAngle(),
    isGroup: layer.isGroup(),
  };
};

LayerStyleDialogTracker.applyBlendingSnapshot = function (layerState, layer, blendingSnapshot) {
  const blendModeCodes = layer.isGroup() ? ["pass"].concat(BlendModes.psdCodes) : BlendModes.psdCodes;
  layer.blendMode = blendModeCodes[blendingSnapshot.lrMd.v];
  layer.Opct = Math.round((blendingSnapshot.Opct.v.val * 255) / 100);
  layer.add.iOpa = Math.round((blendingSnapshot.iOpa.v.val * 255) / 100);
  layer.blendIfData = blendingSnapshot.blIf.v.slice(0);
  layer.add.brst = blendingSnapshot.brst.v.slice(0);
  layerState.setRotationAngle(blendingSnapshot.rotationAngle);
  layerState.setGlobalLightAngle(blendingSnapshot.globalLightAngle);
};
