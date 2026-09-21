/**
 * Layer property, mask, and style actions attached onto
 * LayerEffectsTracker.actionHandlers. Stack mutations live in
 * layer-effects-stack-actions.js; undo/redo in layer-effects-history.js.
 */
import { LayerEffectsTracker } from "./layer-effects-tracker.js";
import "./layer-effects-stack-actions.js";
import "./layer-effects-history.js";
import { EventChannel } from "../../document/model/tool-base.js";
import { TrackerRegistry } from "./tracker-registry.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { fileExtension } from "../../core/file-names.js";

import { BlendModes } from "../../document/model/blend-modes.js";
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { FilterDefs } from "../filters/filter-apply.js";
import { Layer, LayerSectionType, getVectorStrokeStyleSnapshot } from "../../document/model/layer.js";
import { Document} from "../../document/model/document.js";
import { ScriptEngine } from "../scripting/script-engine.js";
import { TextEngineData } from "../text/text-engine.js";
import { ActionDescUtil } from "../scripting/action-desc.js";
import { LayerStyleRenderer } from "../layer-styles/style-renderer.js";
import { findPattern } from "../../document/formats/psd/layer-data-parsers.js";
import { Mask, VectorMask } from "../../document/model/layer-masks.js";
import { EventType } from "../../core/event-bus.js";
import { showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";
import { PolyToolBase } from "../../document/tools/pen-path-tools.js";
import { SelectTool } from "../../document/tools/selection-tools.js";
import { allocBuffer, extractChannelByte } from "../../engine/compositing/buffer-utils.js";
import { scaleRgbaAlphaByMask } from "../../engine/compositing/pixel-ops.js";
import { applyHomographyToKeyOrigins } from "../../engine/compositing/key-origins.js";
import { invert } from "../../engine/compositing/color-math.js";
import {
  applyLockToggleBits,
  collectKeyOriginPairs,
  commitHistoryAndRedo,
  createHistoryEntry,
  lastMatchingHistoryEntry,
  opacityByteToPercent,
  resolveSelectedLayerIndices,
} from "./layer-effects-action-helpers.js";

const actionHandlers = LayerEffectsTracker.actionHandlers;

function handleSetBlendMode(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const blendModeCodes = targetLayer.isGroup() ? ["pass"].concat(BlendModes.psdCodes) : BlendModes.psdCodes;
  const selectedLayerIndices = resolveSelectedLayerIndices(event, doc);
  const blendModesBefore = [];
  for (let loopIdx = 0; loopIdx < selectedLayerIndices.length; loopIdx++) {
    blendModesBefore.push(doc.layers[selectedLayerIndices[loopIdx]].blendMode);
  }
  const historyEntry = createHistoryEntry("layer.blendingChange", this, {
      actionKind: eventCode,
    layerIndicesJson: JSON.stringify(selectedLayerIndices),
    blendModesBefore,
    layerPropertyValue: blendModeCodes[event.layerPropertyValue],
  });
  commitHistoryAndRedo(this, doc, historyEntry);
  this.track(
    ActionDescUtil.buildSetLayerPropertyAction("Md", {
      t: "enum",
      v: { blendMode: BlendModes.psdNames[event.layerPropertyValue] },
    }),
  );
}

function handleSetLayerOpacity(event, dispatcher, doc, panelContext, appData, eventCode) {
  const selectedLayerIndices = resolveSelectedLayerIndices(event, doc);
  const layerIndicesJson = JSON.stringify(selectedLayerIndices);
  let historyEntry = lastMatchingHistoryEntry(
    doc,
    eventCode,
    (last) => last.data.layerIndicesJson == layerIndicesJson,
  );
  if (!historyEntry) {
    const opacityActionDesc = ActionDescUtil.buildSetLayerPropertyAction("Opct", {
        t: "UntF",
      v: { type: "#Prc", val: 0 },
      });
      this.track(opacityActionDesc);
    const opacitiesBefore = [];
    for (let loopIdx = 0; loopIdx < selectedLayerIndices.length; loopIdx++) {
      opacitiesBefore.push(doc.layers[selectedLayerIndices[loopIdx]].Opct);
    }
    historyEntry = createHistoryEntry("layer.layerOpacityChange", this, {
        actionKind: eventCode,
      layerIndicesJson,
      opacitiesBefore,
        layerPropertyValue: event.layerPropertyValue,
      opacityActionDescriptor: opacityActionDesc.actionDescriptor,
    });
    doc.pushHistory(historyEntry);
    }
    historyEntry.data.layerPropertyValue = event.layerPropertyValue;
  historyEntry.data.opacityActionDescriptor.T.v.Opct.v.val = opacityByteToPercent(event.layerPropertyValue);
  this.redo(historyEntry.data, doc);
}

function handleSetFillOpacity(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
    if (targetLayer.add.iOpa == null) targetLayer.add.iOpa = 255;
  let historyEntry = lastMatchingHistoryEntry(
    doc,
    eventCode,
    (last) => last.data.layerIndex == layerIndex,
  );
  if (!historyEntry) {
    historyEntry = createHistoryEntry("Fill Opacity Change", this, {
        actionKind: eventCode,
      layerIndex,
        fillOpacityBefore: targetLayer.add.iOpa,
      layerPropertyValue: event.layerPropertyValue,
    });
    doc.pushHistory(historyEntry);
    }
    historyEntry.data.layerPropertyValue = event.layerPropertyValue;
  this.redo(historyEntry.data, doc);
}

function handleToggleLayerLocks(event, dispatcher, doc, panelContext, appData, eventCode) {
  const lockToggleRows = event.layerPropertyValue;
  const selectedLayerIndices = event.layerIndex != null ? [event.layerIndex] : doc.selectedLayerIndices.slice(0);
  const lockFlagsBefore = [];
  const lockFlagsAfter = [];
  for (let layerIdx = 0; layerIdx < selectedLayerIndices.length; layerIdx++) {
    const loopLayer = doc.layers[selectedLayerIndices[layerIdx]];
      if (loopLayer.add.lspf == null) loopLayer.add.lspf = 0;
    lockFlagsBefore.push(loopLayer.add.lspf);
    lockFlagsAfter.push(applyLockToggleBits(loopLayer.add.lspf, lockToggleRows));
  }
  const layerIndicesJson = JSON.stringify(selectedLayerIndices);
  let historyEntry = lastMatchingHistoryEntry(
    doc,
    eventCode,
    (last) => JSON.stringify(last.data.layerIndicesJson) == layerIndicesJson,
  );
  if (historyEntry) {
    historyEntry.data.layerPropertyValue = lockFlagsAfter;
    } else {
    historyEntry = createHistoryEntry("layer.lockChange", this, {
        actionKind: eventCode,
      layerIndicesJson,
      lockFlagsBefore,
      layerPropertyValue: lockFlagsAfter,
    });
    doc.pushHistory(historyEntry);
  }
  this.redo(historyEntry.data, doc);
}

function handleSetLayerType(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  let previousMetadataKey = "----";
  const newLayerTypeKey = event.newLayerTypeKey;
  let textLayerPayload = null;
  for (let scriptKeyIdx = 0; scriptKeyIdx < ScriptEngine.ScriptEval.layerFillResourceKeys.length; scriptKeyIdx++) {
    if (targetLayer.add[ScriptEngine.ScriptEval.layerFillResourceKeys[scriptKeyIdx]]) {
      previousMetadataKey = ScriptEngine.ScriptEval.layerFillResourceKeys[scriptKeyIdx];
    }
  }
  const previousMetadataValue = targetLayer.add[previousMetadataKey];
  if (newLayerTypeKey == "TySh") {
    textLayerPayload = TextEngineData.createTextLayerData(50, 50, appData.currentTextStyle);
  }
  const historyEntry = createHistoryEntry("Layer Type", this, {
      actionKind: eventCode,
    layerIndex,
      layerMetadataBefore: [previousMetadataKey, previousMetadataValue],
    layerMetadataAfter: [newLayerTypeKey, textLayerPayload],
  });
  commitHistoryAndRedo(this, doc, historyEntry);
}

function collectSoloVisibilityToggleIndices(doc, layerIndex) {
  const visibilityToggleIndices = [];
  let layerSection = doc.root.getSectionByIndex(layerIndex);
  const ancestorIndices = doc.resolveLayerSelection(null, layerIndex);
      while (layerSection.parent != doc.root) {
        ancestorIndices.push(layerSection.parent.index);
    layerSection = layerSection.parent;
  }
  for (let loopIdx = 0; loopIdx < doc.layers.length; loopIdx++) {
    const loopLayer = doc.layers[loopIdx];
    const isVisible = loopLayer.isVisible();
    const isAncestorSelected = ancestorIndices.indexOf(loopIdx) != -1;
        if (!isAncestorSelected && isVisible) visibilityToggleIndices.push(loopIdx);
    if (loopIdx == layerIndex && !isVisible) visibilityToggleIndices.push(loopIdx);
  }
  return visibilityToggleIndices;
}

function handleToggleVisibility(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex) {
  let visibilityToggleIndices = [];
  if (panelContext.isPressed(KeyboardHandler.Alt)) {
    const lastHistoryEntry = doc.getLastHistoryEntry();
    const lastVisibilityData = lastHistoryEntry ? lastHistoryEntry.data : null;
    if (
      lastHistoryEntry != null &&
      lastHistoryEntry.routingChannel == this &&
      lastVisibilityData.actionKind == Layer.toggleVisibility &&
      lastVisibilityData.visibilityLayerIndices.length != 1
    ) {
      const stepBackEvent = new AppEvent(EventType.documentAction);
      stepBackEvent.routingChannel = EventChannel.EVENT_HISTORY;
      stepBackEvent.data = { actionKind: "h_stepbck" };
      dispatcher.dispatch(stepBackEvent);
      if (lastVisibilityData.layerIndex == layerIndex) return;
    }
    visibilityToggleIndices = collectSoloVisibilityToggleIndices(doc, layerIndex);
    } else {
      visibilityToggleIndices.push(layerIndex);
    const isVisible = doc.layers[layerIndex].isVisible();
    this.track({
          uf: isVisible ? "hide" : "show",
          actionDescriptor: {
            classID: isVisible ? "Hd" : "Shw",
        null: { t: "VlLs", v: [ActionDescUtil.buildTargetRef("Lyr", true)] },
      },
    });
  }
  const historyEntry = createHistoryEntry(
    "Layer visibility",
    this,
    { actionKind: eventCode, visibilityLayerIndices: visibilityToggleIndices, layerIndex },
    true,
  );
  commitHistoryAndRedo(this, doc, historyEntry);
}

function applySelectLayerModifiers(event, doc, panelContext, layerIndex, selectionActionDesc) {
  let namedSelectionLayerIndex;
  let escapeSelectionSideEffects = false;
    if (panelContext.isPressed(KeyboardHandler.Ctrl) || event.selectionModifierMode == 0) {
    const selectionSlotIdx = doc.selectedLayerIndices.indexOf(layerIndex);
      if (selectionSlotIdx == -1) doc.selectedLayerIndices.push(layerIndex);
      else if (doc.selectedLayerIndices.length > 1) doc.selectedLayerIndices.splice(selectionSlotIdx, 1);
    doc.selectedLayerIndices.sort((leftIdx, rightIdx) => leftIdx - rightIdx);
      selectionActionDesc.actionDescriptor.selectionModifier = {
        t: "enum",
      v: { selectionModifierType: "addToSelection" },
    };
    namedSelectionLayerIndex = layerIndex;
  } else if (
    panelContext.isPressed(KeyboardHandler.Shift) &&
    !panelContext.isPressed(KeyboardHandler.Alt) &&
    event.pixelContentKind > 0
  ) {
    escapeSelectionSideEffects = true;
  } else if (
    (panelContext.isPressed(KeyboardHandler.Shift) || event.selectionModifierMode == 1) &&
    doc.selectedLayerIndices.length > 0
  ) {
    const rangeStartIdx = Math.min(layerIndex, doc.selectedLayerIndices[0]);
    const rangeEndIdx = Math.max(layerIndex, doc.selectedLayerIndices[doc.selectedLayerIndices.length - 1]);
      doc.selectedLayerIndices = [];
    for (let loopIdx = rangeStartIdx; loopIdx <= rangeEndIdx; loopIdx++) {
      if (doc.layers[loopIdx].add.lsct != LayerSectionType.BoundingDivider) {
        doc.selectedLayerIndices.push(loopIdx);
      }
    }
      selectionActionDesc.actionDescriptor.selectionModifier = {
        t: "enum",
      v: { selectionModifierType: "addToSelectionContinuous" },
      };
    namedSelectionLayerIndex = layerIndex;
    } else {
      namedSelectionLayerIndex = layerIndex;
    const loopLayer = doc.layers[layerIndex];
    if (loopLayer && loopLayer.isGroup() && event.expandGroupOnSelect) {
      loopLayer.add.lsct = LayerSectionType.OpenGroup;
    } else if (
      doc.selectedLayerIndices.length == 1 &&
      doc.selectedLayerIndices[0] == layerIndex &&
      event.pixelContentKind == loopLayer.pixelContent
    ) {
      return { namedSelectionLayerIndex, escapeSelectionSideEffects, skip: true };
      }
      doc.selectedLayerIndices = [layerIndex];
    doc.expandParentGroups();
  }
  return { namedSelectionLayerIndex, escapeSelectionSideEffects, skip: false };
}

function applySelectLayerPixelFocus(event, doc) {
      if (doc.selectedLayerIndices.length == 1) {
    const soleSelectionIdx = doc.selectedLayerIndices[0];
    for (let loopIdx = 0; loopIdx < doc.layers.length; loopIdx++) {
          if (loopIdx == soleSelectionIdx) continue;
      const loopLayer = doc.layers[loopIdx];
          loopLayer.pixelContent = 0;
      loopLayer.pathLayerActive = false;
        }
    const selectedLayer = doc.layers[soleSelectionIdx];
        if (event.pixelContentKind == 2) {
          selectedLayer.pathLayerActive = !selectedLayer.pathLayerActive;
      doc.selectedWorkPaths = [];
        } else if (selectedLayer) {
          selectedLayer.pixelContent = event.pixelContentKind <= 0 ? 0 : event.pixelContentKind;
          if (event.pixelContentKind == 1 || event.pixelContentKind == 3) {
        const activeMask =
          event.pixelContentKind == 3
            ? selectedLayer.getLinkedPlacedItem(doc).d
            : selectedLayer.getMask();
        activeMask.active = false;
      }
    }
  } else {
    for (let loopIdx = 0; loopIdx < doc.layers.length; loopIdx++) {
      const loopLayer = doc.layers[loopIdx];
          loopLayer.pixelContent = 0;
      loopLayer.pathLayerActive = false;
    }
        }
      doc.selectedLayerPaths = null;
  doc.panelsDirty = true;
}

function handleSelectLayer(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex) {
  const selectionActionDesc = {
    uf: "select",
    actionDescriptor: {
      classID: "null",
      MkVs: { t: "bool", v: false },
    },
  };
  if (doc.pathViewport.channelVisibility.join("") != "111") {
    doc.pathViewport.channelVisibility = [1, 1, 1];
    doc.dirty = true;
  }
  const selectionResult = applySelectLayerModifiers(event, doc, panelContext, layerIndex, selectionActionDesc);
  if (selectionResult.skip) return;
  if (selectionResult.namedSelectionLayerIndex != null && selectionResult.namedSelectionLayerIndex < doc.layers.length) {
    selectionActionDesc.actionDescriptor.null = {
      t: "obj ",
      v: [
        {
          t: "name",
          v: {
            classID: "Lyr",
            val: doc.layers[selectionResult.namedSelectionLayerIndex].getName(),
          },
        },
      ],
    };
    this.track(selectionActionDesc);
  }
  if (!selectionResult.escapeSelectionSideEffects) applySelectLayerPixelFocus(event, doc);
}

function handleToggleVectorMask(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const mask = targetLayer.add.vmsk;
  if (mask == null) return;
  const historyEntry = createHistoryEntry(
    mask.isEnabled ? "layer.disableVectorMask" : "layer.enableVectorMask",
    this,
    { actionKind: eventCode, layerIndex },
  );
  commitHistoryAndRedo(this, doc, historyEntry);
}

function handleToggleGroupExpanded(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const toggledSectionType =
    targetLayer.add.lsct == LayerSectionType.OpenGroup
      ? LayerSectionType.ClosedGroup
      : LayerSectionType.OpenGroup;
    if (panelContext.isPressed(KeyboardHandler.Ctrl)) {
    const parentSection = doc.root.getSectionByIndex(doc.layers.indexOf(targetLayer)).parent;
    for (let loopIdx = 0; loopIdx < parentSection.children.length; loopIdx++) {
      const siblingLayer = parentSection.children[loopIdx].layer;
      if (siblingLayer.isGroup()) siblingLayer.add.lsct = toggledSectionType;
    }
  } else {
    targetLayer.add.lsct = toggledSectionType;
  }
  doc.panelsDirty = true;
}

function handleToggleClippingMask(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
    if (!doc.canMoveLayerUp(layerIndex)) return;
  const historyEntry = createHistoryEntry(
    targetLayer.isClippingMask ? "layer.disableClippingMask" : "layer.enableClippingMask",
    this,
    { actionKind: eventCode, layerIndex },
  );
    doc.pushHistory(historyEntry);
  if (event.layerPropertyValue == null || event.layerPropertyValue != targetLayer.isClippingMask) {
    this.redo(historyEntry.data, doc);
  }
    this.track({
      uf: "groupEvent",
      actionDescriptor: {
        classID: "GrpL",
      null: { t: "obj ", v: [ActionDescUtil.buildTargetRef("Lyr", true)] },
    },
  });
}

function handleToggleEffectsExpanded(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
    if (targetLayer.isEffectsExpanded()) targetLayer.layerFlags -= 32;
    else targetLayer.layerFlags += 32;
  doc.panelsDirty = true;
}

function handleCopyLayerStyle(event, dispatcher, doc) {
    if (event.sourceLayerIndex == event.destinationLayerIndex) return;
  const sourceLayer = doc.layers[event.sourceLayerIndex];
  const destLayer = doc.layers[event.destinationLayerIndex];
  const sourceEffectsJsonBefore = sourceLayer.add.lmfx ? JSON.stringify(sourceLayer.add.lmfx) : "";
  const destEffectsJsonBefore = destLayer.add.lmfx ? JSON.stringify(destLayer.add.lmfx) : "";
    if (destLayer.add.lmfx == null) {
      destLayer.add.lmfx = LayerEffectDefs.createLmfxRootTemplate();
    for (let loopIdx = 0; loopIdx < LayerEffectDefs.order.length; loopIdx++) {
      destLayer.add.lmfx[LayerEffectDefs.effectKeys[loopIdx]] = { t: "VlLs", v: [] };
      }
    }
    if (event.effectPathIndices == null) {
      destLayer.add.lmfx = JSON.parse(sourceEffectsJsonBefore);
    if (!event.keepSourceOnCopy) delete sourceLayer.add.lmfx;
    } else {
    const effectKindIdx = event.effectPathIndices[0];
    const effectKey = LayerEffectDefs.effectKeys[effectKindIdx];
    if (LayerEffectDefs.singleSlotEffectKinds.indexOf(LayerEffectDefs.order[effectKindIdx]) == -1) {
      destLayer.add.lmfx[effectKey].v = [];
    }
      destLayer.add.lmfx[effectKey].v.push(sourceLayer.add.lmfx[effectKey].v[event.effectPathIndices[1]]);
    if (!event.keepSourceOnCopy) sourceLayer.add.lmfx[effectKey].v.splice(event.effectPathIndices[1], 1);
    }
  const sourceEffectsJsonAfter = sourceLayer.add.lmfx ? JSON.stringify(sourceLayer.add.lmfx) : "";
  const destEffectsJsonAfter = destLayer.add.lmfx ? JSON.stringify(destLayer.add.lmfx) : "";
    if (!destLayer.isEffectsExpanded()) destLayer.layerFlags += 32;
  const historyEntry = createHistoryEntry("Move Layer Styles", this, {
    actionKind: event.actionKind,
      sourceLayerIndex: event.sourceLayerIndex,
      destinationLayerIndex: event.destinationLayerIndex,
    sourceEffectsJsonBefore,
    destEffectsJsonBefore,
    sourceEffectsJsonAfter,
    destEffectsJsonAfter,
  });
  commitHistoryAndRedo(this, doc, historyEntry);
}

function handleDeleteSmartFilter(event, dispatcher, doc) {
  const sourceLayer = doc.layers[event.sourceLayerIndex];
  const placedDataJsonBefore = JSON.stringify(sourceLayer.add.placedData);
  const placedDataClone = JSON.parse(placedDataJsonBefore);
  placedDataClone.filterFX.v.filterFXList.v.splice(event.filterIndex, 1);
  const historyEntry = createHistoryEntry("layer.deleteSmartFilter", this, {
      actionKind: Layer.mutatePlacedDataLocks,
    placedDataLockEntries: [
      {
        layerIndex: event.sourceLayerIndex,
        placedDataJsonPair: [placedDataJsonBefore, JSON.stringify(placedDataClone)],
      },
    ],
  });
  commitHistoryAndRedo(this, doc, historyEntry);
}

function moveSmartFilterSameLayer(event, placedDataClone, placedDataJsonBefore, lockStateEntries) {
  const filterFxList = placedDataClone.filterFX.v.filterFXList.v;
      filterFxList.splice(event.insertFilterIndex, 0, filterFxList[event.sourceFilterIndex]);
  if (!event.keepSourceOnCopy) {
    filterFxList.splice(event.sourceFilterIndex + (event.sourceFilterIndex < event.insertFilterIndex ? 0 : 1), 1);
  }
      lockStateEntries.push({
        layerIndex: event.sourceLayerIndex,
    placedDataJsonPair: [placedDataJsonBefore, JSON.stringify(placedDataClone)],
  });
}

function moveEntireFilterFxStack(event, doc, sourceLayer, destLayer, placedDataClone, placedDataJsonBefore, sourceFileLoader, lockStateEntries) {
  const movedFilterFx = placedDataClone.filterFX;
      if (!event.keepSourceOnCopy) {
        delete placedDataClone.filterFX;
        lockStateEntries.push({
          layerIndex: event.sourceLayerIndex,
          placedDataJsonPair: [placedDataJsonBefore, JSON.stringify(placedDataClone)],
      linkedItemPair: [sourceFileLoader, null],
    });
  }
  const destFileLoaderBefore = destLayer.hasSmartFilters() ? destLayer.getLinkedPlacedItem(doc) : null;
  const clonedLinkedItem = Document.cloneLinkedItem(sourceFileLoader);
  const destPlacedDataJsonBefore = JSON.stringify(destLayer.add.placedData);
  const destPlacedDataClone = JSON.parse(destPlacedDataJsonBefore);
      destPlacedDataClone.placed.v = clonedLinkedItem.id;
      destPlacedDataClone.filterFX = movedFilterFx;
      lockStateEntries.push({
        layerIndex: event.destinationLayerIndex,
        placedDataJsonPair: [destPlacedDataJsonBefore, JSON.stringify(destPlacedDataClone)],
    linkedItemPair: [destFileLoaderBefore, clonedLinkedItem],
  });
}

function moveSingleSmartFilter(event, destLayer, placedDataClone, placedDataJsonBefore, lockStateEntries) {
  const filterFxList = placedDataClone.filterFX.v.filterFXList.v;
  const movedFilterDescriptor = filterFxList[event.sourceFilterIndex];
      if (!event.keepSourceOnCopy) {
        filterFxList.splice(event.sourceFilterIndex, 1);
        lockStateEntries.push({
          layerIndex: event.sourceLayerIndex,
      placedDataJsonPair: [placedDataJsonBefore, JSON.stringify(placedDataClone)],
    });
      }
  const destPlacedDataJsonBefore = JSON.stringify(destLayer.add.placedData);
  const destPlacedDataClone = JSON.parse(destPlacedDataJsonBefore);
      if (destPlacedDataClone.filterFX == null) destPlacedDataClone.filterFX = FilterDefs.createEmptyFilterFxStyle();
  destPlacedDataClone.filterFX.v.filterFXList.v.splice(event.insertFilterIndex, 0, movedFilterDescriptor);
  const destLockEntry = {
        layerIndex: event.destinationLayerIndex,
    placedDataJsonPair: [destPlacedDataJsonBefore, JSON.stringify(destPlacedDataClone)],
      };
      if (!destLayer.hasSmartFilters()) {
    destLockEntry.linkedItemPair = [null, Document.createBlankLinkedItem(destLayer.add.placedData.placed.v)];
  }
  lockStateEntries.push(destLockEntry);
}

function handleMoveSmartFilter(event, dispatcher, doc) {
  const sourceLayer = doc.layers[event.sourceLayerIndex];
  const destLayer = doc.layers[event.destinationLayerIndex];
  const lockStateEntries = [];
  if (sourceLayer != destLayer && destLayer.add.placedData == null) {
    showToast("Target layer is not a smart object!");
    return;
  }
  if (
    sourceLayer == destLayer &&
    !event.keepSourceOnCopy &&
    (event.sourceFilterIndex == event.insertFilterIndex || event.sourceFilterIndex == -1)
  ) {
    return;
  }
  const sourceFileLoader = sourceLayer.getLinkedPlacedItem(doc);
  const placedDataJsonBefore = JSON.stringify(sourceLayer.add.placedData);
  const placedDataClone = JSON.parse(placedDataJsonBefore);
  if (sourceLayer == destLayer) {
    moveSmartFilterSameLayer(event, placedDataClone, placedDataJsonBefore, lockStateEntries);
  } else if (event.sourceFilterIndex == -1) {
    moveEntireFilterFxStack(
      event,
      doc,
      sourceLayer,
      destLayer,
      placedDataClone,
      placedDataJsonBefore,
      sourceFileLoader,
      lockStateEntries,
    );
  } else {
    moveSingleSmartFilter(event, destLayer, placedDataClone, placedDataJsonBefore, lockStateEntries);
  }
  const historyEntry = createHistoryEntry("layer.moveSmartFilter", this, {
      actionKind: Layer.mutatePlacedDataLocks,
    placedDataLockEntries: lockStateEntries,
  });
  commitHistoryAndRedo(this, doc, historyEntry);
}

function handleToggleRasterMaskEnabled(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const mask = targetLayer.getMask();
  const historyEntry = createHistoryEntry(
    mask.enabled ? "layer.unlinkRasterMask" : "layer.linkRasterMask",
    this,
    { actionKind: eventCode, layerIndex },
  );
  commitHistoryAndRedo(this, doc, historyEntry);
    this.track({
      uf: "set",
      actionDescriptor: {
        classID: "setd",
      null: { t: "obj ", v: [ActionDescUtil.buildTargetRef("Lyr", true)] },
        T: {
          t: "Objc",
        v: { classID: "Lyr", Usrs: { t: "bool", v: mask.enabled } },
      },
    },
  });
}

function handleToggleVectorMaskEnabled(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const mask = targetLayer.add.vmsk;
  const historyEntry = createHistoryEntry(
    mask.enabled ? "layer.unlinkVectorMask" : "layer.linkVectorMask",
    this,
    { actionKind: eventCode, layerIndex },
  );
  commitHistoryAndRedo(this, doc, historyEntry);
}

function handleTransformKeyOrigins(event, dispatcher, doc, panelContext, appData, eventCode) {
  const keyOriginsBefore = collectKeyOriginPairs(doc);
    applyHomographyToKeyOrigins(doc, event.artboardBoundsRect, event.artboardCornerRadii);
  const keyOriginsAfter = collectKeyOriginPairs(doc);
  let historyEntry;
  const lastHistoryEntry = doc.getLastHistoryEntry();
    if (lastHistoryEntry && lastHistoryEntry.data && lastHistoryEntry.data.actionKind == eventCode) {
    let matchesPriorEntry = true;
    for (let loopIdx = 0; loopIdx < keyOriginsBefore.length; loopIdx += 2) {
      if (keyOriginsBefore[loopIdx] != lastHistoryEntry.data.keyOriginsBefore[loopIdx]) matchesPriorEntry = false;
    }
      if (matchesPriorEntry) {
        historyEntry = lastHistoryEntry;
      historyEntry.data.keyOriginsAfter = keyOriginsAfter;
      }
    }
    if (historyEntry == null) {
    historyEntry = createHistoryEntry("properties.editLiveShape", this, {
        actionKind: eventCode,
      keyOriginsBefore,
      keyOriginsAfter,
    });
    doc.pushHistory(historyEntry);
  }
  this.redo(historyEntry.data, doc);
}

function handleEditArtboard(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  let historyEntry = lastMatchingHistoryEntry(
    doc,
    eventCode,
    (last) => last.data.layerIndex == layerIndex,
  );
  if (historyEntry) {
    historyEntry.data.artboardJsonAfter = JSON.stringify(event.artboardPayload);
  } else {
    historyEntry = createHistoryEntry("Editing Artboard", this, {
        actionKind: eventCode,
      layerIndex,
        artboardJsonBefore: JSON.stringify(targetLayer.add.artb),
      artboardJsonAfter: JSON.stringify(event.artboardPayload),
    });
    doc.pushHistory(historyEntry);
  }
  this.redo(historyEntry.data, doc);
}

function applyExtraChannelFromAction(event, doc, extraChannelsAfter, activeChannelsAfter, selectionMaskAfter) {
  const actionKind = event.recordedActionPayload.uf;
  const actionDescriptor = event.recordedActionPayload.actionDescriptor;
  let selectionAfter = selectionMaskAfter;
      if (actionKind == "make" || actionKind == "duplicate") {
    let insertChannelIndex = extraChannelsAfter.length;
    let fromSelection = false;
    const invertChannel = false;
        if (doc.getQuickMask()) insertChannelIndex--;
    const newChannelMask = new Mask();
        newChannelMask.name = "Alpha " + (insertChannelIndex + 1);
        if (actionKind == "make") {
      const makeChannelDesc = actionDescriptor.Nw.v;
          newChannelMask.color = 255;
      activeChannelsAfter.length = 0;
      activeChannelsAfter.push(insertChannelIndex);
      newChannelMask.active = true;
          newChannelMask.displayOpacity = makeChannelDesc.Opct.v;
          if (makeChannelDesc.Nm) newChannelMask.name = makeChannelDesc.Nm.v;
          if (makeChannelDesc.classID == "SCch") {
        fromSelection = true;
        selectionAfter = null;
        newChannelMask.indicatorFlags = 1;
          }
        } else {
      const channelRef = actionDescriptor.null.v[0].v;
      if (channelRef.keyID == "fsel") fromSelection = true;
          else {
        const loadChannelIndex = SelectTool.getDefaultChannelIndexForLoad(doc);
        selectionAfter = SelectTool.loadChannelAsSelectionMask(doc, loadChannelIndex);
            newChannelMask.color = 0;
        newChannelMask.rect = selectionAfter.rect;
        newChannelMask.channel = selectionAfter.channel;
          }
        }
        if (fromSelection) {
          newChannelMask.color = 0;
          if (doc.selectionMask) {
            newChannelMask.rect = doc.selectionMask.rect.clone();
        newChannelMask.channel = doc.selectionMask.channel.slice(0);
          }
          if (invertChannel) {
            newChannelMask.color = 255 - newChannelMask.color;
        invert(newChannelMask.channel);
          }
        }
    extraChannelsAfter.splice(insertChannelIndex, 0, newChannelMask);
      } else if (actionKind == "delete") {
    const sortedActiveChannels = doc.activeChannels;
    sortedActiveChannels.sort((leftIdx, rightIdx) => rightIdx - leftIdx);
    if (sortedActiveChannels.length == 0) return { selectionAfter, abort: true };
    for (let loopIdx = 0; loopIdx < sortedActiveChannels.length; loopIdx++) {
      extraChannelsAfter.splice(sortedActiveChannels[loopIdx], 1);
    }
    activeChannelsAfter.length = 0;
      } else if (actionKind == "hide") {
        extraChannelsAfter[activeChannelsAfter[0]] = extraChannelsAfter[activeChannelsAfter[0]].clone();
    extraChannelsAfter[activeChannelsAfter[0]].active = false;
  }
  return { selectionAfter, abort: false };
}

function handleExtraChannelOp(event, dispatcher, doc, panelContext, appData, eventCode) {
  const extraChannelsAfter = doc.extraChannels.slice(0);
  const activeChannelsAfter = doc.activeChannels.slice(0);
  const selectionMaskBefore = doc.selectionMask;
  let selectionMaskAfter = doc.selectionMask;
  if (event.operation == "fromAction") {
    const result = applyExtraChannelFromAction(
      event,
      doc,
      extraChannelsAfter,
      activeChannelsAfter,
      selectionMaskAfter,
    );
    if (result.abort) return;
    selectionMaskAfter = result.selectionAfter;
    }
    if (event.operation == "rnm") {
      extraChannelsAfter[event.idx] = extraChannelsAfter[event.idx].clone();
    extraChannelsAfter[event.idx].name = event.name;
    }
  const historyEntry = createHistoryEntry("Channel Edit", this, {
      actionKind: eventCode,
      extraChannelsBefore: doc.extraChannels.slice(0),
      activeChannelsBefore: doc.activeChannels.slice(0),
    extraChannelsAfter,
    activeChannelsAfter,
    selectionMaskBefore,
    selectionMaskAfter,
  });
    this.redo(historyEntry.data, doc);
    doc.pushHistory(historyEntry);
}

function handleRouteMaskFromSelection(event, dispatcher, doc, panelContext, appData) {
  if (doc.selectedLayerIndices.length != 1) return;
  const selectedLayerIndex = doc.selectedLayerIndices[0];
  const altPressed = panelContext.isPressed(KeyboardHandler.Alt);
  if (doc.layers[selectedLayerIndex].getMask() == null) {
    event.maskRevealMode = doc.selectionMask ? (!altPressed ? "RvlS" : "HdSl") : !altPressed ? "RvlA" : "HdAl";
    event.actionKind = Layer.addRasterMask;
    } else {
    event.actionKind = Layer.addVectorMask;
  }
  this.handleInput(event, dispatcher, doc, panelContext, appData);
}

function handleDeleteRasterMask(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex) {
    if (doc.selectedLayerIndices.length != 1) return;
  if (doc.layers[layerIndex].getMask() != null) {
    const historyEntry = createHistoryEntry("layer.deleteRasterMask", this, {
        actionKind: eventCode,
      layerIndex,
      maskSnapshot: doc.layers[layerIndex].getMask(),
    });
    commitHistoryAndRedo(this, doc, historyEntry);
  }
}

function handleApplyClipboardLayer(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const layersBefore = doc.layers.slice(0);
  const pastedLayerClone = targetLayer.clone();
  const layerMask = pastedLayerClone.getMask();
  scaleRgbaAlphaByMask(
    layerMask.rasterizeTo(pastedLayerClone.rect),
    pastedLayerClone.rect,
    pastedLayerClone.buffer,
    pastedLayerClone.rect,
  );
    TrackerRegistry.LayerEffectsTracker.refreshLayerAfterHistory(doc, pastedLayerClone);
    doc.layers[doc.selectedLayerIndices[0]] = pastedLayerClone;
  const historyEntry = createHistoryEntry("clipboard.apply", this, {
      actionKind: Layer.replaceLayerStack,
    layersBefore,
      layersAfter: doc.layers.slice(),
      selectedLayerIndicesBefore: doc.selectedLayerIndices.slice(0),
    selectedLayerIndicesAfter: doc.selectedLayerIndices.slice(0),
  });
  commitHistoryAndRedo(this, doc, historyEntry);
}

function handleAddFilterMask(event, dispatcher, doc, panelContext, appData, eventCode) {
    if (doc.selectedLayerIndices.length != 1) return;
  const selectedLayerIndex = doc.selectedLayerIndices[0];
    if (doc.layers[selectedLayerIndex].getLinkedPlacedItem(doc).d == null) {
    const historyEntry = createHistoryEntry("layer.addFilterMask", this, {
        actionKind: eventCode,
        layerIndex: selectedLayerIndex,
      maskSnapshot: new Mask(),
    });
    commitHistoryAndRedo(this, doc, historyEntry);
  }
}

function handleDeleteFilterMask(event, dispatcher, doc, panelContext, appData, eventCode) {
    if (doc.selectedLayerIndices.length != 1) return;
  const selectedLayerIndex = doc.selectedLayerIndices[0];
    if (doc.layers[selectedLayerIndex].getLinkedPlacedItem(doc).d != null) {
    const historyEntry = createHistoryEntry("layer.deleteFilterMask", this, {
        actionKind: eventCode,
        layerIndex: selectedLayerIndex,
      maskSnapshot: doc.layers[selectedLayerIndex].getLinkedPlacedItem(doc).d,
    });
    commitHistoryAndRedo(this, doc, historyEntry);
  }
}

function handleClearSmartFilters(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex) {
    if (event.layerIndex == null && doc.selectedLayerIndices.length != 1) return;
    if (doc.layers[layerIndex].hasSmartFilters()) {
    const placedDataJson = JSON.stringify(doc.layers[layerIndex].add.placedData);
    const placedDataClone = JSON.parse(placedDataJson);
      delete placedDataClone.filterFX;
    const historyEntry = createHistoryEntry("layer.clearSmartFilters", this, {
        actionKind: Layer.mutatePlacedDataLocks,
      placedDataLockEntries: [
        {
          layerIndex,
          placedDataJsonPair: [placedDataJson, JSON.stringify(placedDataClone)],
          linkedItemPair: [doc.layers[layerIndex].getLinkedPlacedItem(doc), null],
        },
      ],
    });
    commitHistoryAndRedo(this, doc, historyEntry);
  }
}

function handleAddVectorMask(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
    if (doc.selectedLayerIndices.length != 1) return;
    if (targetLayer.add.vmsk == null) {
    const pathsTuple = doc.getPaths();
    const activePathIndices = pathsTuple[1];
    const pathsByName = pathsTuple[0];
    let vectorMask;
    let keyOrigins;
      if (event.applyActivePath && activePathIndices.length != 0) {
      const pathLayerAdd = pathsByName[activePathIndices[0]].add;
        vectorMask = pathLayerAdd.vmsk.clone();
      keyOrigins = pathLayerAdd.vogk;
      } else {
      vectorMask = new VectorMask();
        keyOrigins = [];
      vectorMask.pathRecords[1].all = event.revealVectorMaskPixels ? 0 : 1;
      }
    const historyEntry = createHistoryEntry("layer.addVectorMask", this, {
        actionKind: eventCode,
      layerIndex,
      pathLayerActive: true,
        maskSnapshot: vectorMask,
        KeyOrigins: JSON.stringify(keyOrigins),
      StrokeStyleDefs: null,
    });
      if (targetLayer.hasFillContent()) {
      historyEntry.data.StrokeStyleDefs = JSON.stringify(LayerEffectDefs.StrokeStyleDefs.default);
    }
    commitHistoryAndRedo(this, doc, historyEntry);
  }
}

function handleMoveVectorMask(event, dispatcher, doc, panelContext, appData, eventCode) {
  const sourceLayer = doc.layers[event.sourceLayerIndex];
  const destLayer = doc.layers[event.destinationLayerIndex];
    if (destLayer.add.vmsk) return;
  const sourceVectorMask = sourceLayer.add.vmsk;
  const historyEntry = createHistoryEntry("layer.addVectorMask", this, {
      layerIndex: event.destinationLayerIndex,
      pathLayerActive: sourceLayer.pathLayerActive,
      maskSnapshot: sourceVectorMask.clone(),
      KeyOrigins: JSON.stringify(sourceLayer.add.vogk),
    StrokeStyleDefs: sourceLayer.add.vstk ? JSON.stringify(sourceLayer.add.vstk) : null,
  });
    if (event.keepSourceOnCopy) {
    historyEntry.data.actionKind = Layer.addVectorMask;
    } else {
      historyEntry.data.actionKind = eventCode;
      historyEntry.data.sourceLayerIndex = event.sourceLayerIndex;
    historyEntry.data.destinationLayerIndex = event.destinationLayerIndex;
  }
  commitHistoryAndRedo(this, doc, historyEntry);
}

function handleDeleteVectorMask(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex) {
    if (doc.selectedLayerIndices.length != 1) return;
  const layer = doc.layers[layerIndex];
  const vectorMask = layer.add.vmsk;
    if (vectorMask != null) {
    const historyEntry = createHistoryEntry("layer.deleteVectorMask", this, {
        actionKind: eventCode,
      layerIndex,
        pathLayerActive: layer.pathLayerActive,
        maskSnapshot: vectorMask,
        KeyOrigins: JSON.stringify(layer.add.vogk),
      StrokeStyleDefs: layer.add.vstk ? JSON.stringify(layer.add.vstk) : null,
    });
    commitHistoryAndRedo(this, doc, historyEntry);
  }
}

function handleUpdateMetadata(event, dispatcher, doc, panelContext, appData, eventCode) {
  const historyEntry = createHistoryEntry("Metadata", this, {
      actionKind: eventCode,
      xmpMetadataBefore: JSON.stringify(doc.xmpMetadata),
    xmpMetadataAfter: JSON.stringify(event.xmpMetadataAfter),
  });
  commitHistoryAndRedo(this, doc, historyEntry);
}

function handleRenameDocument(event, dispatcher, doc, panelContext, appData, eventCode) {
  const targetDoc = event.targetDocument ? event.targetDocument : doc;
  const oldName = targetDoc.name;
  // A typed name without an extension keeps the one the document already has,
  // so renaming a JPG tab does not turn it into a PSD.
  const newName = fileExtension(event.documentBaseName) !== ""
    ? event.documentBaseName
    : event.documentBaseName + "." + (fileExtension(oldName) || "psd");
  if (oldName == newName) return;
  const historyEntry = createHistoryEntry("layer.nameChange", this, {
      actionKind: eventCode,
      documentNameBefore: oldName,
    documentNameAfter: newName,
  });
  if (event.skipHistoryPush != true) targetDoc.pushHistory(historyEntry);
  this.redo(historyEntry.data, targetDoc);
}

function handleRenameLayer(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const oldName = targetLayer.getName();
  const newName = event.name.substring(0, 255);
    if (oldName == newName) return;
  const historyEntry = createHistoryEntry("layer.nameChange", this, {
      actionKind: eventCode,
    renameEntries: [[layerIndex, oldName, newName, targetLayer.add.lnsr, null]],
  });
  commitHistoryAndRedo(this, doc, historyEntry);
  this.track(
    ActionDescUtil.buildSetLayerPropertyAction("Nm", {
      t: "TEXT",
      v: newName,
    }),
  );
}

function handleSetLayerLabelColor(event, dispatcher, doc, panelContext, appData, eventCode) {
  const selectedIndices = doc.resolveLayerSelection();
  const colorsBefore = [];
  const colorsAfter = [];
  for (let loopIdx = 0; loopIdx < selectedIndices.length; loopIdx++) {
      colorsBefore.push(doc.layers[selectedIndices[loopIdx]].add.lclr);
    colorsAfter.push(event.labelColorIndex);
    }
  const historyEntry = createHistoryEntry("layer.colourChange", this, {
      actionKind: eventCode,
      layerIndices: selectedIndices,
    colorsBefore,
    colorsAfter,
  });
  commitHistoryAndRedo(this, doc, historyEntry);
}

function handleMaskDensityFeather(event, dispatcher, doc, panelContext, appData, eventCode) {
  const maskType = event.maskSettings.maskType;
  let coalescedHistoryEntry = doc.history[doc.historyIndex];
  const canCoalesceMaskHistory =
    coalescedHistoryEntry != null &&
    coalescedHistoryEntry.routingChannel == this &&
    coalescedHistoryEntry.data.actionKind == eventCode &&
    coalescedHistoryEntry.data.layerIndex == event.layerIndex &&
    coalescedHistoryEntry.data.maskSettingsAfter != null &&
    coalescedHistoryEntry.data.maskSettingsAfter.maskType == maskType;
    if (canCoalesceMaskHistory) coalescedHistoryEntry.data.maskSettingsAfter = event.maskSettings;
    else {
    coalescedHistoryEntry = createHistoryEntry("Mask Density / Feather", this, {
        actionKind: eventCode,
        layerIndex: event.layerIndex,
        maskSettingsBefore: doc.layers[event.layerIndex].getMaskSettings(maskType),
      maskSettingsAfter: event.maskSettings,
    });
    doc.pushHistory(coalescedHistoryEntry);
  }
  this.redo(coalescedHistoryEntry.data, doc);
}

function handleUpdateContentStyle(event, dispatcher, doc, panelContext, appData, eventCode) {
  const strokeStyleJson = JSON.stringify(event.contentStylePayload);
  const parsedStrokeStyle = JSON.parse(strokeStyleJson);
  let coalescedHistoryEntry = doc.history[doc.historyIndex];
  if (
    coalescedHistoryEntry != null &&
    coalescedHistoryEntry.routingChannel == this &&
    coalescedHistoryEntry.data.actionKind == eventCode &&
    coalescedHistoryEntry.data.updateContentFill == event.updateContentFill &&
    coalescedHistoryEntry.data.contentLayerIndices.join(",") == event.contentLayerIndices.join(",")
  ) {
    for (let loopIdx = 0; loopIdx < event.contentLayerIndices.length; loopIdx++) {
      coalescedHistoryEntry.data.contentStylesAfter[loopIdx] = parsedStrokeStyle;
    }
    if (coalescedHistoryEntry.data.actionDescriptor && parsedStrokeStyle.fillKind != 0) {
      TrackerRegistry.LayerEffectsTracker.copyContentFillToDescriptor(
        parsedStrokeStyle.fillDescriptor,
        coalescedHistoryEntry.data.actionDescriptor.T.v,
        parsedStrokeStyle.fillKind - 1,
      );
    }
    } else {
    coalescedHistoryEntry = createHistoryEntry("dialogs.layerStyle", this, {
        actionKind: eventCode,
        contentLayerIndices: event.contentLayerIndices,
        updateContentFill: event.updateContentFill,
        contentStylesBefore: [],
      contentStylesAfter: [],
    });
    let hasStrokeStyleChange = false;
    for (let loopIdx = 0; loopIdx < event.contentLayerIndices.length; loopIdx++) {
      const contentLayerIndex = event.contentLayerIndices[loopIdx];
      const layer = doc.layers[contentLayerIndex];
      const strokeStyleSnapshot = event.updateContentFill
        ? getVectorStrokeStyleSnapshot(doc, contentLayerIndex)
        : JSON.parse(JSON.stringify(layer.add.vstk));
        coalescedHistoryEntry.data.contentStylesBefore.push(strokeStyleSnapshot);
        coalescedHistoryEntry.data.contentStylesAfter.push(parsedStrokeStyle);
      if (JSON.stringify(strokeStyleSnapshot) != strokeStyleJson) hasStrokeStyleChange = true;
      }
      if (!hasStrokeStyleChange) return;
      doc.pushHistory(coalescedHistoryEntry);
      if (event.updateContentFill && parsedStrokeStyle.fillKind > 0) {
      const setContentDescriptor = (coalescedHistoryEntry.data.actionDescriptor = {
            classID: "setd",
        null: ActionDescUtil.buildTargetRef("contentLayer", true),
        T: { t: "Objc", v: {} },
      });
      const fillLayerKey = ["SoCo", "GdFl", "PtFl"][parsedStrokeStyle.fillKind - 1];
      TrackerRegistry.LayerEffectsTracker.copyContentFillToDescriptor(
        parsedStrokeStyle.fillDescriptor,
        setContentDescriptor.T.v,
        parsedStrokeStyle.fillKind - 1,
      );
      this.track({ uf: "set", actionDescriptor: setContentDescriptor });
    }
  }
  if (event.updateContentFill && parsedStrokeStyle.fillKind == 3) {
    doc.registerPattern(findPattern(parsedStrokeStyle.fillDescriptor.Ptrn.v, appData.patternPresets));
  }
    if (!event.updateContentFill) {
    const strokeContentDesc = parsedStrokeStyle.strokeStyleContent.v;
    if (strokeContentDesc.classID == LayerEffectDefs.StrokeStyleDefs.fillLayerTypes[2]) {
      doc.registerPattern(findPattern(strokeContentDesc.Ptrn.v, appData.patternPresets));
    }
  }
  this.redo(coalescedHistoryEntry.data, doc);
}

function handleToggleRasterOrFilterMask(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const isRasterMaskEvent = eventCode == Layer.toggleRasterMask;
  const mask = isRasterMaskEvent ? targetLayer.getMask() : targetLayer.getLinkedPlacedItem(doc).d;
    if (mask == null) return;
  const historyLabel = mask.isEnabled
    ? isRasterMaskEvent
      ? "layer.disableRasterMask"
      : "layer.disableFilterMask"
    : isRasterMaskEvent
      ? "layer.enableRasterMask"
      : "layer.enableFilterMask";
  const historyEntry = createHistoryEntry(historyLabel, this, { actionKind: eventCode, layerIndex });
  commitHistoryAndRedo(this, doc, historyEntry);
}

function handleToggleMasterFx(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  let historyEntry;
  if (eventCode == Layer.toggleLayerEffectsMaster) {
    historyEntry = createHistoryEntry(
      targetLayer.add.lmfx.masterFXSwitch.v ? "layer.disableLayerEffects" : "layer.enableLayerEffects",
      this,
      { actionKind: eventCode, layerIndex },
    );
  }
  if (eventCode == Layer.toggleSmartFiltersMaster) {
    historyEntry = createHistoryEntry(
      targetLayer.add.placedData.filterFX.v.enab.v ? "layer.disableSmartFilters" : "layer.enableSmartFilters",
      this,
      { actionKind: eventCode, layerIndex },
    );
  }
  commitHistoryAndRedo(this, doc, historyEntry);
}

function handleToggleEffectVariant(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const effectPathIdx = event.index;
  let historyEntry;
  if (eventCode == Layer.toggleLayerEffectVariant) {
    historyEntry = createHistoryEntry(
      targetLayer.add.lmfx[LayerEffectDefs.effectKeys[effectPathIdx[0]]].v[effectPathIdx[1]].v.enab.v
        ? "layer.disableLayerEffects"
        : "layer.enableLayerEffects",
      this,
      { actionKind: eventCode, layerIndex, index: event.index },
    );
  }
  if (eventCode == Layer.toggleSmartFilterVariant) {
    historyEntry = createHistoryEntry(
      targetLayer.add.placedData.filterFX.v.filterFXList.v[effectPathIdx].v.enab.v
        ? "layer.disableSmartFilters"
        : "layer.enableSmartFilters",
      this,
      { actionKind: eventCode, layerIndex, index: event.index },
    );
  }
  commitHistoryAndRedo(this, doc, historyEntry);
}

function buildRasterMaskFromRevealMode(event, doc, layer) {
  const newMask = new Mask();
  const maskRevealMode = event.maskRevealMode;
  const fromSelection = maskRevealMode == "RvlS" || maskRevealMode == "HdSl";
      if (maskRevealMode == "RvlS" || maskRevealMode == "HdAl" || maskRevealMode == "Trns") newMask.color = 0;
      if (fromSelection) {
        newMask.channel = doc.selectionMask.channel.slice(0);
        newMask.rect = doc.selectionMask.rect.clone();
    if (maskRevealMode == "HdSl") invert(newMask.channel);
      }
      if (maskRevealMode == "Trns") {
        newMask.rect = layer.rect.clone();
        newMask.channel = allocBuffer(layer.rect.area());
    extractChannelByte(layer.buffer, newMask.channel, 3);
  }
  return { newMask, fromSelection, maskRevealMode };
}

function handleAddRasterMask(event, dispatcher, doc) {
  if (doc.selectedLayerIndices.length != 1) return;
  const selectedLayerIndex = doc.selectedLayerIndices[0];
  const layer = doc.layers[selectedLayerIndex];
  if (layer.add.vmsk && layer.d == null) layer.invalidate(doc);
  const existingMask = layer.getMask();
  if (existingMask == null || event.forceNewMask) {
    const { newMask, fromSelection, maskRevealMode } = buildRasterMaskFromRevealMode(event, doc, layer);
    const historyEntry = createHistoryEntry("layer.addRasterMask", this, {
      actionKind: event.actionKind,
        layerIndex: selectedLayerIndex,
        maskSnapshot: newMask,
        existingMaskSnapshot: existingMask,
      activeChannelPair: fromSelection ? [doc.selectionMask, null] : null,
    });
    commitHistoryAndRedo(this, doc, historyEntry);
      doc.layers[selectedLayerIndex].pixelContent = 1;
      this.track({
        uf: "make",
        actionDescriptor: {
          __name: "Make",
          classID: "Mk",
        Nw: { t: "type", v: { classID: "Chnl" } },
          At: {
            t: "obj ",
          v: [{ t: "Enmr", v: { classID: "Chnl", typeID: "Chnl", enum: "Msk" } }],
        },
        Usng: { t: "enum", v: { UsrM: maskRevealMode } },
      },
    });
  }
}

function handleCopyRasterMask(event, dispatcher, doc, panelContext) {
  const sourceLayer = doc.layers[event.sourceLayerIndex];
  const destLayer = doc.layers[event.destinationLayerIndex];
    if (destLayer.getMask()) return;
  const sourceMask = sourceLayer.getMask();
  const historyEntry = createHistoryEntry("layer.addRasterMask", this, {});
    if (event.keepSourceOnCopy) {
    const clonedMask = sourceMask.clone();
      historyEntry.data = {
        actionKind: Layer.addRasterMask,
        layerIndex: event.destinationLayerIndex,
      maskSnapshot: clonedMask,
      };
      if (panelContext.isPressed(KeyboardHandler.Shift)) {
        invert(clonedMask.channel);
      clonedMask.color = 255 - clonedMask.color;
      }
    } else {
      historyEntry.data = {
      actionKind: event.actionKind,
        sourceLayerIndex: event.sourceLayerIndex,
        destinationLayerIndex: event.destinationLayerIndex,
      maskSnapshot: sourceMask,
    };
  }
  commitHistoryAndRedo(this, doc, historyEntry);
}

actionHandlers[Layer.setBlendMode] = handleSetBlendMode;
actionHandlers[Layer.setLayerOpacity] = handleSetLayerOpacity;
actionHandlers[Layer.setFillOpacity] = handleSetFillOpacity;
actionHandlers[Layer.toggleLayerLocks] = handleToggleLayerLocks;
actionHandlers[Layer.setLayerType] = handleSetLayerType;
actionHandlers[Layer.toggleVisibility] = handleToggleVisibility;
actionHandlers[Layer.selectLayer] = handleSelectLayer;
actionHandlers[Layer.toggleVectorMask] = handleToggleVectorMask;
actionHandlers[Layer.toggleGroupExpanded] = handleToggleGroupExpanded;
actionHandlers[Layer.toggleClippingMask] = handleToggleClippingMask;
actionHandlers[Layer.toggleEffectsExpanded] = handleToggleEffectsExpanded;
actionHandlers[Layer.copyLayerStyle] = handleCopyLayerStyle;
actionHandlers[Layer.deleteSmartFilter] = handleDeleteSmartFilter;
actionHandlers[Layer.moveSmartFilter] = handleMoveSmartFilter;
actionHandlers[Layer.toggleRasterMaskEnabled] = handleToggleRasterMaskEnabled;
actionHandlers[Layer.toggleVectorMaskEnabled] = handleToggleVectorMaskEnabled;
actionHandlers[Layer.transformKeyOrigins] = handleTransformKeyOrigins;
actionHandlers[Layer.editArtboard] = handleEditArtboard;
actionHandlers[Layer.extraChannelOp] = handleExtraChannelOp;
actionHandlers[Layer.routeMaskFromSelection] = handleRouteMaskFromSelection;
actionHandlers[Layer.deleteRasterMask] = handleDeleteRasterMask;
actionHandlers[Layer.applyClipboardLayer] = handleApplyClipboardLayer;
actionHandlers[Layer.addFilterMask] = handleAddFilterMask;
actionHandlers[Layer.deleteFilterMask] = handleDeleteFilterMask;
actionHandlers[Layer.clearSmartFilters] = handleClearSmartFilters;
actionHandlers[Layer.addVectorMask] = handleAddVectorMask;
actionHandlers[Layer.moveVectorMask] = handleMoveVectorMask;
actionHandlers[Layer.deleteVectorMask] = handleDeleteVectorMask;
actionHandlers[Layer.updateMetadata] = handleUpdateMetadata;
actionHandlers[Layer.renameDocument] = handleRenameDocument;
actionHandlers[Layer.renameLayer] = handleRenameLayer;
actionHandlers[Layer.setLayerLabelColor] = handleSetLayerLabelColor;
actionHandlers[Layer.maskDensityFeather] = handleMaskDensityFeather;
actionHandlers[Layer.updateContentStyle] = handleUpdateContentStyle;
actionHandlers[Layer.toggleRasterMask] = actionHandlers[Layer.toggleFilterMask] = handleToggleRasterOrFilterMask;
actionHandlers[Layer.toggleLayerEffectsMaster] = actionHandlers[Layer.toggleSmartFiltersMaster] = handleToggleMasterFx;
actionHandlers[Layer.toggleLayerEffectVariant] = actionHandlers[Layer.toggleSmartFilterVariant] =
  handleToggleEffectVariant;
actionHandlers[Layer.addRasterMask] = handleAddRasterMask;
actionHandlers[Layer.copyRasterMask] = handleCopyRasterMask;
