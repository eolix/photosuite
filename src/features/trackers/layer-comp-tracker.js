// Layer-composition tracker: list/edit/switch/update comps and apply captured
// per-layer settings (visibility, offset, effects, blend) through history.
import { BlendModes } from "../../document/model/blend-modes.js";
import { LayerSectionType } from "../../document/model/layer.js";
import { EventChannel } from "../../document/model/tool-base.js";
import { PSDResourceParser } from "../../document/formats/psd/psd-resource-parser.js";
import { HistoryEntry } from "../../document/model/document.js";
import { TrackerRegistry } from "./tracker-registry.js";
import { MoveTool } from "../../document/tools/move-tools.js";
import { translateLayersByDelta } from "../../document/model/layer-translate.js";

const COMP_LAYER_SETTING_KEYS =
  "compList enab Ofst blendOptions Lefx FXRefPoint imageMask vectorMask layerSpecific".split(" ");
const DEFAULT_CAPTURED_INFO_FLAGS = 7;

export function LayerCompTracker() {
  TrackerRegistry.TrackerBase.call(this, EventChannel.EVENT_FILTER_STACK);
}

LayerCompTracker.prototype = Object.create(TrackerRegistry.TrackerBase.prototype);
installLayerCompTrackerPrototype(LayerCompTracker);

/**
 * Per-action handlers keyed by comp event `actionKind`. Each mutates `ctx` for finalize.
 */
LayerCompTracker.actionHandlers = {
  delLC(ctx) {
    handleDeleteComp(ctx);
  },
  editLC(ctx) {
    handleEditComp(ctx);
  },
  setLC(ctx) {
    handleSwitchComp(ctx);
  },
  updLC(ctx) {
    handleUpdateComp(ctx);
  },
  addLC(ctx) {
    handleAddComp(ctx);
  },
};

/**
 * @param {object} layerComps PSD comp list descriptor.
 * @param {number} compId Target comp id.
 * @returns {number} List index or `-1`.
 */
LayerCompTracker.findCompIndexById = function (layerComps, compId) {
  const compList = layerComps.list.v;
  for (let listIdx = 0; listIdx < compList.length; listIdx++) {
    if (compList[listIdx].v.compID.v == compId) return listIdx;
  }
  return -1;
};

/**
 * Shift a descriptor `{ Hrzn, Vrtc }` point by pixel deltas.
 * @param {object} descriptorPoint `{ v: { Hrzn, Vrtc } }`.
 * @param {number} deltaX
 * @param {number} deltaY
 */
LayerCompTracker.offsetDescriptorPoint = function (descriptorPoint, deltaX, deltaY) {
  descriptorPoint.v.Hrzn.v += deltaX;
  descriptorPoint.v.Vrtc.v += deltaY;
};

/**
 * Merge sparse cmls layer-settings rows and fill default enable/offset slots.
 * @param {object} cmlsMetadata Layer `add.shmd.cmls` block.
 */
LayerCompTracker.normalizeCompLayerSettings = function (cmlsMetadata) {
  const layerSettings = cmlsMetadata.layerSettings.v;
  if (layerSettings.length == 0) return;
  let mergedSettings = null;
  const firstEntry = layerSettings[0].v;
  if (firstEntry.enab == null) {
    firstEntry.enab = { t: "bool", v: true };
  }
  if (firstEntry.Ofst == null) {
    firstEntry.Ofst = {
      t: "Objc",
      v: {
        classID: "null",
        Hrzn: { t: "long", v: 0 },
        Vrtc: { t: "long", v: 0 },
      },
    };
  }
  for (let listIdx = 0; listIdx < layerSettings.length; listIdx++) {
    const entry = layerSettings[listIdx].v;
    if (mergedSettings == null) {
      mergedSettings = JSON.parse(JSON.stringify(entry));
    } else {
      for (let keyIdx = 0; keyIdx < COMP_LAYER_SETTING_KEYS.length; keyIdx++) {
        const settingKey = COMP_LAYER_SETTING_KEYS[keyIdx];
        if (entry[settingKey]) mergedSettings[settingKey] = JSON.parse(JSON.stringify(entry[settingKey]));
      }
    }
    layerSettings[listIdx].v = JSON.parse(JSON.stringify(mergedSettings));
  }
};

/**
 * @param {object} layer
 * @param {number} compId
 * @returns {number}
 */
LayerCompTracker.findCompSettingsIndex = function (layer, compId) {
  const layerSettings = layer.add.shmd.cmls.layerSettings.v;
  for (let settingsIdx = 0; settingsIdx < layerSettings.length; settingsIdx++) {
    const entryCompId = layerSettings[settingsIdx].v.compList.v[0].v;
    if (entryCompId == compId) return settingsIdx;
  }
  return -1;
};

/**
 * @param {object} layer
 * @param {number} compId
 * @returns {object|null}
 */
LayerCompTracker.getCompSettingsForLayer = function (layer, compId) {
  const settingsIdx = LayerCompTracker.findCompSettingsIndex(layer, compId);
  return settingsIdx == -1 ? null : layer.add.shmd.cmls.layerSettings.v[settingsIdx].v;
};

/**
 * Apply one comp's captured settings to every layer in the document.
 * @param {object} layerState
 * @param {number} compId
 * @param {number} capturedInfoFlags Bit flags for visibility / position / appearance.
 */
LayerCompTracker.applyCompStateToDocument = function (layerState, compId, capturedInfoFlags) {
  for (let layerIdx = 0; layerIdx < layerState.layers.length; layerIdx++) {
    const targetLayer = layerState.layers[layerIdx];
    const cmlsMetadata = targetLayer.add.shmd.cmls;
    if (cmlsMetadata == null) continue;
    const compSettings = LayerCompTracker.getCompSettingsForLayer(targetLayer, compId);
    if (compSettings == null) {
      targetLayer.setVisible(false);
      continue;
    }
    applyCompVisibility(targetLayer, compSettings, capturedInfoFlags);
    applyCompLayerOffset(layerState, layerIdx, targetLayer, compSettings, capturedInfoFlags);
    applyCompAppearance(targetLayer, compSettings, capturedInfoFlags);
  }
};

/**
 * Snapshot per-layer comp settings for undo on update.
 * @param {object} layerState
 * @param {number} compId
 * @returns {Record<string, object>}
 */
LayerCompTracker.captureCompLayerSettingsMap = function (layerState, compId) {
  const settingsMap = {};
  for (let layerIdx = 0; layerIdx < layerState.layers.length; layerIdx++) {
    const targetLayer = layerState.layers[layerIdx];
    if (targetLayer.add.shmd == null || targetLayer.add.shmd.cmls == null) continue;
    settingsMap["l" + targetLayer.add.lyid] = JSON.parse(
      JSON.stringify(LayerCompTracker.getCompSettingsForLayer(targetLayer, compId)),
    );
  }
  return settingsMap;
};

/**
 * Build a comp-state map for every layer at the current document state.
 * @param {object} layerState
 * @param {number} compId
 * @returns {Record<string, object>}
 */
LayerCompTracker.buildCompStateMapForDocument = function (layerState, compId) {
  const stateMap = {};
  for (let layerIdx = 0; layerIdx < layerState.layers.length; layerIdx++) {
    const targetLayer = layerState.layers[layerIdx];
    stateMap["l" + targetLayer.add.lyid] = LayerCompTracker.buildLayerCompSettingsEntry(
      layerState,
      targetLayer,
      compId,
    );
  }
  return stateMap;
};

/**
 * Serialize one layer's comp settings entry for a comp id.
 * @param {object} layerState
 * @param {object} targetLayer
 * @param {number} compId
 * @returns {object}
 */
LayerCompTracker.buildLayerCompSettingsEntry = function (layerState, targetLayer, compId) {
  const cmlsMetadata = targetLayer.add.shmd ? targetLayer.add.shmd.cmls : null;
  const layerBounds = targetLayer.getTransformBounds(layerState);
  const originDescriptor = buildOriginDescriptor(layerBounds.x, layerBounds.y);
  const settingsEntry = { classID: "null" };
  settingsEntry.compList = {
    t: "VlLs",
    v: [{ t: "long", v: compId }],
  };
  settingsEntry.enab = { t: "bool", v: targetLayer.isVisible() };
  settingsEntry.Ofst = JSON.parse(JSON.stringify(originDescriptor));
  settingsEntry.FXRefPoint = JSON.parse(
    JSON.stringify(cmlsMetadata && cmlsMetadata.origFXRefPoint ? cmlsMetadata.origFXRefPoint : originDescriptor),
  );
  settingsEntry.blendOptions = buildBlendOptionsDescriptor(targetLayer);
  if (targetLayer.add.vmsk) {
    settingsEntry.vectorMask = { t: "Objc", v: { classID: "null" } };
    settingsEntry.vectorMask.v.Ofst = JSON.parse(JSON.stringify(originDescriptor));
  }
  if (targetLayer.add.lmfx) {
    settingsEntry.Lefx = { t: "Objc", v: JSON.parse(JSON.stringify(targetLayer.add.lmfx)) };
    PSDResourceParser.Wm(settingsEntry.Lefx.v);
  }
  return settingsEntry;
};

/**
 * Ensure `add.shmd.cmls` exists with a default comp-0 settings row.
 * @param {object} layerState
 * @param {object} targetLayer
 */
LayerCompTracker.ensureLayerHasCompMetadata = function (layerState, targetLayer) {
  const layerId = targetLayer.add.lyid;
  if (targetLayer.add.shmd == null) targetLayer.add.shmd = {};
  if (targetLayer.add.shmd.cmls == null) {
    targetLayer.add.shmd.cmls = {
      classID: "null",
      LyrI: { t: "long", v: layerId },
      layerSettings: {
        t: "VlLs",
        v: [
          {
            t: "Objc",
            v: LayerCompTracker.buildLayerCompSettingsEntry(layerState, targetLayer, 0),
          },
        ],
      },
    };
  }
};

/**
 * Write comp settings rows from a state map onto document layers.
 * @param {object} layerState
 * @param {Record<string, object>} stateMap
 * @param {number} compId
 */
LayerCompTracker.applyCompStateMapToDocument = function (layerState, stateMap, compId) {
  for (let layerIdx = 0; layerIdx < layerState.layers.length; layerIdx++) {
    const targetLayer = layerState.layers[layerIdx];
    const layerId = targetLayer.add.lyid;
    LayerCompTracker.ensureLayerHasCompMetadata(layerState, targetLayer);
    const layerSettings = targetLayer.add.shmd.cmls.layerSettings.v;
    let settingsEntry = stateMap["l" + layerId];
    if (settingsEntry != null) {
      settingsEntry = { t: "Objc", v: JSON.parse(JSON.stringify(settingsEntry)) };
    }
    const settingsIdx = LayerCompTracker.findCompSettingsIndex(targetLayer, compId);
    if (settingsIdx == -1) {
      if (settingsEntry == null) continue;
      layerSettings.push(settingsEntry);
    } else if (settingsEntry == null) {
      layerSettings.splice(settingsIdx, 1);
    } else {
      layerSettings[settingsIdx] = settingsEntry;
    }
  }
};

/**
 * Rebase comp origin descriptors when document bounds shift (PSD read/write).
 * @param {object} layerState
 * @param {boolean} negateOffset
 */
LayerCompTracker.offsetAllCompOrigins = function (layerState, negateOffset) {
  for (let layerIdx = 0; layerIdx < layerState.layers.length; layerIdx++) {
    const targetLayer = layerState.layers[layerIdx];
    if (targetLayer.add.shmd == null || targetLayer.add.shmd.cmls == null) continue;
    const layerBounds = targetLayer.getTransformBounds(layerState);
    let originX = Math.round(layerBounds.x);
    let originY = Math.round(layerBounds.y);
    if (!negateOffset) {
      originX = -originX;
      originY = -originY;
    }
    const cmlsMetadata = targetLayer.add.shmd.cmls;
    const layerSettings = cmlsMetadata.layerSettings.v;
    if (cmlsMetadata.origFXRefPoint) {
      LayerCompTracker.offsetDescriptorPoint(cmlsMetadata.origFXRefPoint, -originX, -originY);
    }
    for (let settingsIdx = 0; settingsIdx < layerSettings.length; settingsIdx++) {
      const entry = layerSettings[settingsIdx].v;
      LayerCompTracker.offsetDescriptorPoint(entry.Ofst, originX, originY);
      const imageMask = entry.imageMask;
      const vectorMask = entry.vectorMask;
      if (imageMask && imageMask.v.Ofst) LayerCompTracker.offsetDescriptorPoint(imageMask.v.Ofst, originX, originY);
      if (vectorMask && vectorMask.v.Ofst) LayerCompTracker.offsetDescriptorPoint(vectorMask.v.Ofst, originX, originY);
    }
  }
};

/**
 * Capture document state into comp id 0 when no comp has been applied yet.
 * @param {object} layerState
 */
LayerCompTracker.ensureDefaultCompCaptured = function (layerState) {
  if (layerState.layerComps.lastAppliedComp != null || !layerState.layerCompsModified) return;
  const defaultStateMap = LayerCompTracker.buildCompStateMapForDocument(layerState, 0);
  LayerCompTracker.applyCompStateMapToDocument(layerState, defaultStateMap, 0);
  layerState.layerCompsModified = false;
};

function installLayerCompTrackerPrototype(Tracker) {
  Tracker.prototype.handleInput = function (compEvent, docModel, layerState, keyboardCtx) {
    const ctx = createCompActionContext(compEvent, layerState);
    const handler = Tracker.actionHandlers[compEvent.actionKind];
    if (handler) handler(ctx);
    const historyEntry = new HistoryEntry(ctx.historyLabel, this);
    historyEntry.data = {
      layerCompsBefore: ctx.layerCompsBefore,
      layerCompsAfter: ctx.layerCompsAfter,
      capturedSettingsMapBefore: ctx.capturedSettingsMapBefore,
      compStateMapAfter: ctx.compStateMapAfter,
      compId: ctx.activeCompId,
      shouldRedraw: ctx.shouldRedraw,
    };
    this.redo(historyEntry.data, layerState);
    layerState.pushHistory(historyEntry);
  };

  Tracker.prototype.redo = function (historySnapshot, layerState) {
    layerState.layerComps = historySnapshot.layerCompsAfter;
    layerState.stateChanged = true;
    if (historySnapshot.compStateMapAfter) {
      LayerCompTracker.applyCompStateMapToDocument(
        layerState,
        historySnapshot.compStateMapAfter,
        historySnapshot.compId,
      );
    }
    if (historySnapshot.shouldRedraw) {
      redrawAppliedComp(layerState);
    }
  };

  Tracker.prototype.undo = function (historySnapshot, layerState) {
    layerState.layerComps = historySnapshot.layerCompsBefore;
    layerState.stateChanged = true;
    if (historySnapshot.capturedSettingsMapBefore) {
      LayerCompTracker.applyCompStateMapToDocument(
        layerState,
        historySnapshot.capturedSettingsMapBefore,
        historySnapshot.compId,
      );
    }
    if (historySnapshot.shouldRedraw) {
      redrawAppliedComp(layerState);
    }
  };
}

function createCompActionContext(compEvent, layerState) {
  return {
    compEvent,
    layerState,
    layerCompsBefore: JSON.parse(JSON.stringify(layerState.layerComps)),
    layerCompsAfter: JSON.parse(JSON.stringify(layerState.layerComps)),
    historyLabel: null,
    capturedSettingsMapBefore: null,
    compStateMapAfter: null,
    activeCompId: -1,
    shouldRedraw: false,
  };
}

function handleDeleteComp(ctx) {
  const compListIdx = LayerCompTracker.findCompIndexById(ctx.layerState.layerComps, ctx.compEvent.idx);
  const lastAppliedId = ctx.layerState.layerComps.lastAppliedComp ? ctx.layerState.layerComps.lastAppliedComp.v : 0;
  ctx.layerCompsAfter.list.v.splice(compListIdx, 1);
  if (lastAppliedId == ctx.compEvent.idx) delete ctx.layerCompsAfter.lastAppliedComp;
  ctx.historyLabel = "Delete Layer Comp";
}

function handleEditComp(ctx) {
  const compListIdx = LayerCompTracker.findCompIndexById(ctx.layerState.layerComps, ctx.compEvent.idx);
  const compEntry = ctx.layerCompsAfter.list.v[compListIdx].v;
  if (ctx.compEvent.newName != null) compEntry.Nm.v = ctx.compEvent.newName;
  if (ctx.compEvent.capturedFlagIndex != null) {
    compEntry.capturedInfo.v = toggleCapturedInfoFlag(
      compEntry.capturedInfo.v,
      ctx.compEvent.capturedFlagIndex
    );
  }
  ctx.historyLabel = "Layer Comp properties";
}

function handleSwitchComp(ctx) {
  LayerCompTracker.ensureDefaultCompCaptured(ctx.layerState);
  if (ctx.compEvent.idx == 0) delete ctx.layerCompsAfter.lastAppliedComp;
  else {
    ctx.layerCompsAfter.lastAppliedComp = { t: "long", v: ctx.compEvent.idx };
  }
  ctx.historyLabel = "Switch Layer Comp";
  ctx.shouldRedraw = true;
}

function handleUpdateComp(ctx) {
  LayerCompTracker.ensureDefaultCompCaptured(ctx.layerState);
  ctx.capturedSettingsMapBefore = LayerCompTracker.captureCompLayerSettingsMap(ctx.layerState, ctx.compEvent.idx);
  ctx.compStateMapAfter = LayerCompTracker.buildCompStateMapForDocument(ctx.layerState, ctx.compEvent.idx);
  ctx.layerCompsAfter.lastAppliedComp = { t: "long", v: ctx.compEvent.idx };
  ctx.historyLabel = "Update Layer Comp";
  ctx.activeCompId = ctx.compEvent.idx;
  ctx.shouldRedraw = true;
}

function handleAddComp(ctx) {
  LayerCompTracker.ensureDefaultCompCaptured(ctx.layerState);
  let newCompId = 1;
  for (let listIdx = 0; listIdx < ctx.layerCompsAfter.list.v.length; listIdx++) {
    newCompId = Math.max(newCompId, ctx.layerCompsAfter.list.v[listIdx].v.compID.v) + 1;
  }
  newCompId += Math.floor(Math.random() * 1e4);
  const newCompDescriptor = {
    t: "Objc",
    v: {
      classID: "Comp",
      Nm: { t: "TEXT", v: "New Comp " + (ctx.layerCompsAfter.list.v.length + 1) },
      compID: { t: "long", v: newCompId },
      capturedInfo: { t: "long", v: DEFAULT_CAPTURED_INFO_FLAGS },
    },
  };
  ctx.layerCompsAfter.list.v.push(newCompDescriptor);
  ctx.layerCompsAfter.lastAppliedComp = { t: "long", v: newCompId };
  ctx.historyLabel = "New Layer Comp";
  const newCompStateMap = LayerCompTracker.buildCompStateMapForDocument(ctx.layerState, newCompId);
  LayerCompTracker.applyCompStateMapToDocument(ctx.layerState, newCompStateMap, newCompId);
}

function toggleCapturedInfoFlag(capturedInfo, flagBitIndex) {
  const lowerBits = capturedInfo & ((1 << flagBitIndex) - 1);
  let upperFlags = capturedInfo >> flagBitIndex;
  if ((upperFlags & 1) == 1) upperFlags--;
  else upperFlags++;
  return (upperFlags << flagBitIndex) + lowerBits;
}

function redrawAppliedComp(layerState) {
  const appliedCompId = layerState.layerComps.lastAppliedComp ? layerState.layerComps.lastAppliedComp.v : 0;
  const compListIdx = LayerCompTracker.findCompIndexById(layerState.layerComps, appliedCompId);
  const compEntry = compListIdx == -1 ? null : layerState.layerComps.list.v[compListIdx].v;
  const capturedInfoFlags = compEntry ? compEntry.capturedInfo.v : DEFAULT_CAPTURED_INFO_FLAGS;
  LayerCompTracker.applyCompStateToDocument(layerState, appliedCompId, capturedInfoFlags);
  layerState.markDirty();
}

function applyCompVisibility(targetLayer, compSettings, capturedInfoFlags) {
  if ((capturedInfoFlags & 1) == 0) return;
  if (compSettings.enab) targetLayer.setVisible(compSettings.enab.v);
  else targetLayer.setVisible(true);
}

function applyCompLayerOffset(layerState, layerIdx, targetLayer, compSettings, capturedInfoFlags) {
  if ((capturedInfoFlags & 2) == 0 || !compSettings.Ofst) return;
  const offsetDesc = compSettings.Ofst.v;
  const layerBounds = targetLayer.getTransformBounds(layerState);
  const deltaX = Math.round(offsetDesc.Hrzn.v - layerBounds.x);
  const deltaY = Math.round(offsetDesc.Vrtc.v - layerBounds.y);
  if (deltaX != 0 || deltaY != 0) {
    translateLayersByDelta(layerState, [layerIdx], null, deltaX, deltaY);
  }
}

function applyCompAppearance(targetLayer, compSettings, capturedInfoFlags) {
  if ((capturedInfoFlags & 4) == 0) return;
  if (compSettings.Lefx) {
    const layerEffectsCopy = JSON.parse(JSON.stringify(compSettings.Lefx.v));
    PSDResourceParser.mV(layerEffectsCopy);
    if (JSON.stringify(layerEffectsCopy) != JSON.stringify(targetLayer.add.lmfx)) {
      targetLayer.add.lmfx = layerEffectsCopy;
      targetLayer.renderCache.dirty = true;
    }
  } else {
    delete targetLayer.add.lmfx;
  }
  if (compSettings.blendOptions) {
    const blendOptions = compSettings.blendOptions.v;
    if (blendOptions.Opct) targetLayer.Opct = Math.round((255 * blendOptions.Opct.v.val) / 100);
    if (blendOptions.fillOpacity) targetLayer.add.iOpa = Math.round((255 * blendOptions.fillOpacity.v.val) / 100);
    if (blendOptions.Md) {
      targetLayer.blendMode =
        targetLayer.add.lsct == LayerSectionType.BoundingDivider
          ? "norm"
          : BlendModes.fromPSD(blendOptions.Md.v.blendMode);
    }
  } else {
    targetLayer.Opct = 255;
    targetLayer.blendMode = targetLayer.isGroup() ? "pass" : "norm";
    targetLayer.add.iOpa = 255;
  }
}

function buildOriginDescriptor(originX, originY) {
  return {
    t: "Objc",
    v: {
      classID: "null",
      Hrzn: { t: "long", v: originX },
      Vrtc: { t: "long", v: originY },
    },
  };
}

function buildBlendOptionsDescriptor(targetLayer) {
  return {
    t: "Objc",
    v: {
      classID: "null",
      Md: { t: "enum", v: { blendMode: BlendModes.toPSD(targetLayer.blendMode) } },
      Opct: {
        t: "UntF",
        v: { type: "#Prc", val: (100 * targetLayer.Opct) / 255 },
      },
      fillOpacity: {
        t: "UntF",
        v: {
          type: "#Prc",
          val: targetLayer.add.iOpa != null ? (100 * targetLayer.add.iOpa) / 255 : 100,
        },
      },
    },
  };
}
