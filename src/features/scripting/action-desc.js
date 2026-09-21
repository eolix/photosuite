// Action descriptor helpers: build PSD action refs, label recorded steps, and
// replay recorded actions into document / UI dispatch events.
import {
  AppEvent
} from "../../core/event-bus.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Point } from "../../core/math/point.js";
import { BlendModes } from "../../document/model/blend-modes.js";
import { ToolId, EventChannel } from "../../document/model/tool-base.js";
import { PSDResourceParser } from "../../document/formats/psd/psd-resource-parser.js";
import { AdjustmentEngine } from "../adjustments/adjustment-engine.js";
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { TrackerRegistry } from "../trackers/tracker-registry.js";
import { Document } from "../../document/model/document.js";
import { Layer } from "../../document/model/layer.js"
import { FilterDefs } from "../filters/filter-registry.js";
import { GalleryFilterDefs } from "../filters/gallery/gallery-filter-defs.js";
import { PopupTypes } from "../../ui/config/popup-types.js";
import { TextEngineData } from "../text/text-engine.js";
import { adjustmentKeyOf } from "../../document/formats/psd/adjustment-parsers.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { confirmUser, showToast } from "../../core/user-prompts.js";
import { psdColorToRgb } from "../../engine/compositing/psd-color-utils.js";

function readPrimaryTargetRef(actionValues) {
  let targetRef = null;
  if (actionValues && actionValues.null) targetRef = actionValues.null.v[0];
  if (actionValues && targetRef == null && actionValues.At) targetRef = actionValues.At.v[0];
  if (targetRef && targetRef.t == "obj ") targetRef = targetRef.v[0];
  return targetRef;
}

function targetClassIdFromRef(targetRef) {
  return targetRef ? targetRef.v.classID : null;
}

function evaluateActionCondition(doc, conditionType, activeLayer) {
  if (conditionType == "Bckg") return false;
  if (conditionType == "Pxel" && doc.ensureLayerEditableForTools(false)) return true;
  if (conditionType == "Adjs" && adjustmentKeyOf(activeLayer.add)) return true;
  if (conditionType == "Shp" && activeLayer.add.vogk) return true;
  if (conditionType == "Grup" && activeLayer.isGroup()) return true;
  return false;
}

function localeKeyForMakeVerb(targetRef, targetClassId, actionValues) {
  if (targetRef) {
    if (targetClassId == "AdjL") return "layer.newAdjustmentLayer";
    if (targetClassId == "layerSection") return "layer.groupLayers";
    if (targetClassId == "Lyr") return "layer.newLayer";
    if (targetClassId == "Chnl" && targetRef.v.enum == "Msk") return "layer.rasterMask";
    if (targetClassId == "contentLayer") return "layer.newFillLayer.title";
    if (targetClassId == "BckL") return "Make Background Layer";
    if (targetClassId == "Path") return "Make Path";
    if (targetClassId == "TxLr") return "Make Text Layer";
  }
  if (actionValues.Nw) {
    targetClassId = actionValues.Nw.v.classID;
    if (targetClassId == "Dcmn") return "dialogs.newProject";
    if (targetClassId == "Chnl" || targetClassId == "SCch") return "New Channel";
  }
  return null;
}

function localeKeyForSelectVerb(targetRef, targetClassId) {
  if (targetClassId == "Chnl") return "Select " + (targetRef.v.enum == "Msk" ? "Mask " : "") + "Channel";
  if (targetClassId == "Mn") return "Select Panel \"" + targetRef.v.enum + "\"";
  if (targetClassId == "Lyr") {
    if (targetRef.t == "Enmr") return "Select " + ({ Bckw: "Backward" }[targetRef.v.enum]) + " Layer";
    return "Select Layer \"" + targetRef.v.val + "\"";
  }
  if (targetClassId == "Dcmn") return "Select Document";
  return null;
}

function buildActionLocaleKeyMap(actionValues) {
  return {
    cut: "clipboard.cut",
    copyEvent: "clipboard.copy",
    copyToLayer: "layer.layerViaCopy",
    copyMerged: "clipboard.copyMerged",
    paste: "clipboard.paste",
    close: "file.close",
    save: "file.save",
    groupEvent: "layer.enableClippingMask",
    duplicate: "layer.duplicateLayer",
    mergeLayersNew: "layer.mergeLayers",
    mergeVisible: "layer.mergeVisible",
    flattenImage: "layer.flattenImage",
    updatePlacedLayer: "layer.smartObject.updatingSmartObject",
    fade: "edit.fade",
    applyImageEvent: "edit.applyImage",
    fill: "edit.fill",
    colorRange: "select.colourRange",
    desaturate: "styleOptions.desaturate",
    delete: actionValues ? "layer.deleteLayer" : "edit.clear",
    align: "align.options.alignLeftEdges",
    applyLocking: "layer.lockChange",
    crop: "dialogs.crop",
    placedLayerEditContents: "layer.smartObject.editContents",
    convertMode: "dialogs.convertMode",
    newPlacedLayer: "layer.convertToSmartObject",
    canvasSize: "dialogs.canvasSize",
    imageSize: "dialogs.imageSize",
    rasterizeLayer: "layer.rasterise",
    revealAll: "dialogs.revealAll",
    conditional: "panels.actionConditionalStep"
  };
}

const ActionDescUtil = {};
ActionDescUtil.buildTargetRef = function(classId, useTargetEnum) {
  let refDescriptor = {
    t: "Clss",
    v: {
      classID: classId
    }
  };
  if (useTargetEnum) refDescriptor = {
    t: "Enmr",
    v: {
      classID: classId,
      typeID: "Ordn",
      enum: "Trgt"
    }
  };
  return {
    t: "obj ",
    v: [refDescriptor]
  }
};
ActionDescUtil.buildSetLayerPropertyAction = function(propertyKey, propertyValue) {
  const layerDescriptor = {
    classID: "Lyr"
  };
  layerDescriptor[propertyKey] = propertyValue;
  return {
    uf: "set",
    actionDescriptor: {
      classID: "null",
      null: ActionDescUtil.buildTargetRef("Lyr", true),
      T: {
        t: "Objc",
        v: layerDescriptor
      }
    }
  };
};
ActionDescUtil.playActionSetSteps = function(doc, actionSets, setIndex, stepIndex, dispatcher) {
  const historyEvent = new AppEvent(EventType.historyGrouped, true);
  const stepStack = [];
  let stepCount = 0;
  const unusedStepCount = ActionDescUtil.collectActionStepsFromSet(actionSets, setIndex, stepIndex, stepStack);
  while (stepStack.length != 0) {
    const step = stepStack.pop();
    stepCount++;
    if (!step.enabled) continue;
    if (step.uf == "conditional") {
      const activeLayer = doc.layers[doc.selectedLayerIndices[0]];
      const conditionType = step.actionDescriptor.null.v.Cndt;
      const conditionMet = evaluateActionCondition(doc, conditionType, activeLayer);
      const thenBranch = step.actionDescriptor.then.v;
      if (conditionMet) ActionDescUtil.collectActionStepsFromSet(actionSets, thenBranch[0].v.val, thenBranch[1].v.val, stepStack)
    } else if (step.uf == "stop") {
      if (step.actionDescriptor.Cntn && step.actionDescriptor.Cntn.v == true) confirmUser(step.actionDescriptor.Msge.v);
      else {
        showToast(step.actionDescriptor.Msge.v);
        break
      }
    } else if (step.uf == "play") {
      const playRefs = step.actionDescriptor.null.v;
      const uiDispatchEvent = new AppEvent(EventType.uiDispatch, true);
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.replayRecordedActionPair,
        recordedActionPair: [playRefs[0].v.val, playRefs[1].v.val]
      };
      dispatcher.dispatch(uiDispatchEvent)
    } else {
      historyEvent.data = {
        uf: step.uf,
        actionDescriptor: step.actionDescriptor
      };
      dispatcher.dispatch(historyEvent)
    }
  }
};
ActionDescUtil.collectActionStepsFromSet = function(actionSets, setIndex, stepIndex, outStack) {
  let steps;
  for (let setIdx = 0; setIdx < actionSets.length; setIdx++) {
    if (actionSets[setIdx].name != stepIndex) continue;
    const actions = actionSets[setIdx].children;
    for (let actionIdx = 0; actionIdx < actions.length; actionIdx++) {
      if (actions[actionIdx].name != setIndex) continue;
      steps = actions[actionIdx].children
    }
  }
  let stepCount = steps.length;
  for (let pushIdx = 0; pushIdx < stepCount; pushIdx++) outStack.push(steps[stepCount - 1 - pushIdx])
};
// Returns the registry key whose value equals `actionVerb` (e.g. the adjustment
// id for a script verb, or the filter key for a filter verb). Each registry's
// value->key index is built once, on first lookup, and cached by registry object.
const registryReverseIndexes = new WeakMap();
function registryKeyForActionVerb(registry, actionVerb) {
  let reverseIndex = registryReverseIndexes.get(registry);
  if (reverseIndex === undefined) {
    reverseIndex = {};
    for (const key in registry) reverseIndex[registry[key]] = key;
    registryReverseIndexes.set(registry, reverseIndex);
  }
  return reverseIndex[actionVerb];
}

ActionDescUtil.getActionStepLocaleKey = function(actionStep) {
  const actionVerb = actionStep.uf;
  const actionValues = actionStep.actionDescriptor;
  let targetRef = readPrimaryTargetRef(actionValues);
  let targetClassId = targetClassIdFromRef(targetRef);
  let adjustmentId;
  let filterScriptKey;
  let galleryFilterKey;
  if (["purge"].indexOf(actionVerb) != -1) return actionVerb[0].toUpperCase() + actionVerb.slice(1);
  adjustmentId = registryKeyForActionVerb(AdjustmentEngine.eventNames, actionVerb);
  filterScriptKey = registryKeyForActionVerb(FilterDefs.filterScriptKeys, actionVerb);
  galleryFilterKey = registryKeyForActionVerb(GalleryFilterDefs.filterClassIdAliases, actionVerb);
  if (adjustmentId) {
    const autoLevelsMode = AdjustmentEngine.getAutoLevelsMode(adjustmentId, actionValues);
    if (autoLevelsMode != -1) return ["adjustments.autoTone", "adjustments.autoContrast", "adjustments.autoColour"][autoLevelsMode];
    return AdjustmentEngine.names[adjustmentId];
  }
  if (filterScriptKey) return FilterDefs.names[filterScriptKey];
  if (galleryFilterKey) return GalleryFilterDefs.names[galleryFilterKey];
  const channelOperationLabels = ActionDescUtil.channelOperationLabels;
  if (actionVerb == "make") {
    const makeKey = localeKeyForMakeVerb(targetRef, targetClassId, actionValues);
    if (makeKey) return makeKey;
  } else if (actionVerb == "select") {
    const selectKey = localeKeyForSelectVerb(targetRef, targetClassId);
    if (selectKey) return selectKey;
  } else if (channelOperationLabels[actionVerb] && targetClassId == "Chnl") {
    const isSelectionChannel = targetRef.v.keyID == "fsel";
    return channelOperationLabels[actionVerb] + " " + (isSelectionChannel ? "Selection" : "Channel")
  } else if (actionVerb == "set") {
    if (targetClassId == "Lyr") return "Set Current Layer";
    if (targetClassId == "AdjL") return "layer.editAdjustmentLayer";
    if (targetClassId == "contentLayer") return "layer.newFillLayer.modifyFillLayer";
    if (targetClassId == "Prpr") return "dialogs.layerStyle";
    if (targetClassId == "Clr") return "Set " + (targetRef.v.keyID == "FrgC" ? "Foreground" : "Background") + " color";
    if (targetClassId == "Brsh") return "Set Brush";
  } else if (actionVerb == "move") {
    if (targetClassId == "Lyr") return "Move Layer"
  } else if (actionVerb == "show" || actionVerb == "hide") {
    let visibilityTargetLabel = "";
    if (targetClassId == "Lyr") visibilityTargetLabel = "Layer";
    if (targetClassId == "Chnl") visibilityTargetLabel = "Channel";
    if (targetClassId == "filterFX") visibilityTargetLabel = "Filter Effect";
    return (actionVerb == "show" ? "Show" : "Hide") + " " + visibilityTargetLabel;
  } else if (actionVerb == "reset") {
    if (targetClassId == "Clr") return "Reset Colors"
  } else if (actionVerb == "exchange") {
    if (targetClassId == "Clr") return "warp.swapColours"
  } else if (actionVerb == "rotateEventEnum") return "edit.rotate";
  else if (actionVerb == "flip") {
    const flipHorizontal = actionValues.Axis.v.Ornt == "Hrzn";
    return [
      "edit.flipVar",
      flipHorizontal ? "warp.orientation.horizontally" : "warp.orientation.vertically"
    ]
  }
  if (targetClassId == "Chnl") {
    if (actionVerb == "duplicate") {
      if (targetRef.v.keyID == "fsel") return "select.channel.selectionToChannel";
      return "select.channel.duplicateChannel"
    }
    if (actionVerb == "delete") return "select.channel.deleteChannel"
  }
  if (actionVerb == "transform") return targetRef.v.keyID == "fsel" ? "select.transformSelection" : "tools.freeTransform";
  let localeKey = buildActionLocaleKeyMap(actionValues)[actionVerb];
  if (localeKey == null) localeKey = ActionDescUtil.selectionChannelActionLabels[actionVerb];
  if (localeKey) return localeKey;
  return actionVerb
};
ActionDescUtil.selectionChannelActionLabels = {
  border: "select.border",
  smoothness: "styleOptions.bevelTechnique.smooth",
  expand: "select.expand",
  contract: "select.contract",
  feather: "select.feather",
  inverse: "select.inverse"
};
ActionDescUtil.channelOperationLabels = {
  set: "Set",
  add: "Add Transparency",
  addTo: "Add To",
  subtract: "Subtract Transparency",
  subtractFrom: "Subtract From",
  interfaceIconFrameDimmed: "Intersect Transparency",
  interfaceWhite: "Intersect With"
};
ActionDescUtil.dispatchRecordedAction = function(actionPayload, appController, appData, doc) {
  const actionVerb = actionPayload.uf;
  const actionValues = actionPayload.actionDescriptor;
  const documentEvent = new AppEvent(EventType.documentAction, true);
  let adjustmentId;
  let filterScriptKey;
  let galleryFilterKey;
  let targetDescriptors;
  documentEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
  const uiDispatchEvent = new AppEvent(EventType.uiDispatch, true);
  const skipVerbs = ["purge", "updatePlacedLayer", "convertMode"];
  if (skipVerbs.indexOf(actionVerb) != -1) return;
  adjustmentId = registryKeyForActionVerb(AdjustmentEngine.eventNames, actionVerb);
  filterScriptKey = registryKeyForActionVerb(FilterDefs.filterScriptKeys, actionVerb);
  galleryFilterKey = registryKeyForActionVerb(GalleryFilterDefs.filterClassIdAliases, actionVerb);
  if (actionVerb == "fade") adjustmentId = actionVerb;
  if (actionVerb == "applyImageEvent") adjustmentId = "aply";
  if (adjustmentId) {
    documentEvent.routingChannel = EventChannel.EVENT_ADJUSTMENT;
    documentEvent.data = {
      actionKind: "start",
      adjustmentKey: adjustmentId,
      operationData: actionValues
    }
  } else if (filterScriptKey) {
    documentEvent.routingChannel = EventChannel.EVENT_SMART_FILTER;
    documentEvent.data = {
      actionKind: "start",
      operationId: filterScriptKey,
      operationData: actionValues
    }
  } else if (galleryFilterKey) {
    documentEvent.routingChannel = EventChannel.EVENT_SMART_FILTER;
    documentEvent.data = {
      actionKind: "start",
      operationId: "GEfc",
      operationData: actionValues
    }
  } else if (actionVerb == "imageSize" || actionVerb == "canvasSize" || actionVerb == "revealAll" || actionVerb == "trim" || actionVerb == "crop") {
    documentEvent.routingChannel = ToolId.TOOL_CROP;
    documentEvent.data = {
      actionKind: "fromAction",
      scriptActionPayload: actionPayload
    }
  } else if (actionVerb == "fill" || actionVerb == "delete" && actionValues == null) {
    documentEvent.routingChannel = ToolId.TOOL_BRUSH;
    documentEvent.data = {
      actionKind: "fromAction",
      scriptActionPayload: actionPayload
    }
  } else if (actionVerb == "colorRange") {
    const minLab = actionValues.Mnm.v;
    const maxLab = actionValues.Mxm.v;
    documentEvent.routingChannel = ToolId.TOOL_RECT_SELECT;
    documentEvent.data = {
      actionKind: "crange",
      labMin: {
        lq: minLab.Lmnc.v,
        w: minLab.A.v,
        O: minLab.B.v
      },
      labMax: {
        lq: maxLab.Lmnc.v,
        w: maxLab.A.v,
        O: maxLab.B.v
      },
      fuzziness: actionValues.Fzns.v / 200
    }
  } else if (ActionDescUtil.selectionChannelActionLabels[actionVerb] || ActionDescUtil.channelOperationLabels[actionVerb] && (false || actionValues.With && actionValues.With.v[0].v.keyID == "fsel" || actionValues.From && actionValues.From.v[0].v.keyID == "fsel" || actionValues.null && actionValues.null.v[0].v.keyID == "fsel" || actionValues.T.v[0] && actionValues.T.v[0].v.keyID == "fsel")) {
    documentEvent.routingChannel = ToolId.TOOL_RECT_SELECT;
    documentEvent.data = {
      actionKind: "fromAction",
      scriptActionPayload: actionPayload
    }
  }

  const layerOpMap = {
    copyToLayer: Layer.newLayerViaCopy,
    cutToLayer: Layer.newLayerViaCut,
    mergeLayersNew: doc && doc.selectedLayerIndices.length == 1 ? Layer.mergeDown : Layer.mergeCopy,
    rasterizeLayer: Layer.rasterizeLayers,
    mergeVisible: Layer.mergeLayers,
    flattenImage: Layer.flattenImage,
    newPlacedLayer: Layer.createSmartObject
  };

  if (layerOpMap[actionVerb]) documentEvent.data = {
    actionKind: layerOpMap[actionVerb],
    actionDescriptor: actionValues
  };
  if (documentEvent.data) {
    appController.dispatch(documentEvent);
    return
  }
  if (actionVerb == "desaturate") {
    documentEvent.routingChannel = EventChannel.EVENT_ADJUSTMENT;
    documentEvent.data = {
      actionKind: "auto",
      autoToneMode: 3
    };
    if (doc && doc.layers[doc.selectedLayerIndices[0]].add.placedData == null) appController.dispatch(documentEvent);
    return
  }
  if (actionVerb == "close") {
    if (actionValues.Svng.v.YsN == "Ys") {
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.saveOrCommitDocument
      };
      appController.dispatch(uiDispatchEvent)
    }
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.focusDocumentTabByIndex,
      targetDocument: doc
    };
    appController.dispatch(uiDispatchEvent);
    return
  }
  if (actionVerb == "save") {
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.saveOrCommitDocument
    };
    appController.dispatch(uiDispatchEvent);
    return
  }

  const clipboardDispatchMap = {
    placedLayerEditContents: UiCommand.editPlacedLayerSource,
    copyEvent: UiCommand.clipboardCopyLayers,
    paste: UiCommand.clipboardPasteLayers
  };

  if (clipboardDispatchMap[actionVerb]) uiDispatchEvent.data = {
    actionKind: clipboardDispatchMap[actionVerb]
  };
  if (uiDispatchEvent.data) {
    appController.dispatch(uiDispatchEvent);
    return
  }
  if (actionValues.null || actionValues.At) targetDescriptors = (actionValues.null ? actionValues.null : actionValues.At).v;
  else targetDescriptors = [{
    t: "----",
    v: actionValues
  }];
  if (targetDescriptors[0].t == "obj ") {
    if (targetDescriptors.length != 1) throw new Error("Expected a single obj target ref");
    targetDescriptors = targetDescriptors[0].v
  }
  for (let targetIdx = 0; targetIdx < targetDescriptors.length; targetIdx++) {
    let targetRef = targetDescriptors[targetIdx];
    let targetClassId = targetRef.v.classID;
    documentEvent.data = null;
    if (actionVerb == "make") {
      if (actionValues.null == null && actionValues.Nw) targetClassId = actionValues.Nw.v.classID;
      if (targetClassId == "AdjL") {
        documentEvent.data = {
          actionKind: Layer.newAdjustmentLayer,
          actionDescriptor: actionValues
        }
      } else if (targetClassId == "layerSection") {
        documentEvent.data = {
          actionKind: Layer.groupOrUngroup
        };
        if (actionValues.Usng) documentEvent.data.VT = actionValues.Usng.v.Nm.v
      } else if (targetClassId == "Lyr") {
        if (actionValues.Usng && actionValues.Usng.v.length == 2) documentEvent.data = {
          actionKind: Layer.explodeLayerStyles
        };
        else {
          documentEvent.data = {
            actionKind: Layer.newLayer
          };
          if (actionValues.Usng) documentEvent.data.VT = actionValues.Usng.v.Nm.v;
          if (actionValues.below && actionValues.below.v) documentEvent.data.insertBelowTarget = true
        }
      } else if (targetClassId == "Chnl" && targetRef.v.enum == "Msk") {
        documentEvent.data = {
          actionKind: Layer.addRasterMask,
          maskRevealMode: actionValues.Usng.v.UsrM
        }
      } else if (targetClassId == "Chnl" || targetClassId == "SCch") {
        documentEvent.data = {
          actionKind: Layer.extraChannelOp,
          operation: "fromAction",
          recordedActionPayload: actionPayload
        }
      } else if (targetClassId == "contentLayer") {
        documentEvent.data = {
          actionKind: Layer.newShapeLayer,
          actionDescriptor: actionValues
        }
      } else if (targetClassId == "BckL") {
        doc.layers[doc.selectedLayerIndices[0]].convertToBackground();
        continue
      } else if (targetClassId == "Dcmn") {
        const newDocDescriptor = actionValues.Nw.v;
        let creationOptions = appData;
        if (typeof actionPayload.backgroundColorPacked === "number") {
          creationOptions = Object.assign({}, appData, {
            bgColor: actionPayload.backgroundColorPacked
          });
        }
        uiDispatchEvent.data = {
          dispatchKind: UiCommand.focusDocumentTab,
          openedDocument: Document.createNewDocument(newDocDescriptor, creationOptions)
        }
      } else if (targetClassId == "Ptrn") uiDispatchEvent.data = {
        dispatchKind: UiCommand.extractDocSelectionAsPreset,
        selectionExportKind: 0
      };
      else if (targetClassId == "Path") {
        documentEvent.routingChannel = ToolId.TOOL_PATH_SELECT;
        documentEvent.data = {
          actionKind: "pathedit",
          operation: "fromsel"
        }
      } else if (targetClassId == "TxLr") {
        documentEvent.routingChannel = ToolId.TOOL_TYPE;
        documentEvent.data = {
          actionKind: "fromAction",
          scriptActionPayload: actionPayload
        }
      } else {
        throw new Error("Unhandled make target class: " + targetClassId)
      }
    } else if (actionVerb == "select") {
      const panelToolMap = {
        PcTl: ToolId.TOOL_PENCIL,
        magicWandTool: ToolId.TOOL_MAGIC_WAND
      };
      if (targetClassId == "Lyr") {
        const selectionModifier = actionValues.selectionModifier;
        const selectionModifierType = selectionModifier ? selectionModifier.v.selectionModifierType : null;
        var layerIndex = ActionDescUtil.resolveLayerIndexFromRef(doc, targetRef);
        if (layerIndex == -1) {
          showToast("Layer " + targetRef.v.val + " does not exist.");
          throw new Error("Layer not found: " + targetRef.v.val)
        }
        documentEvent.data = {
          actionKind: Layer.selectLayer,
          layerIndex: layerIndex,
          selectionModifierMode: selectionModifierType ? ["addToSelection", "addToSelectionContinuous"].indexOf(selectionModifierType) : null,
          pixelContentKind: 0,
          expandGroupOnSelect: true
        }
      } else if (targetClassId == "Chnl") {
        documentEvent.data = {
          actionKind: Layer.selectLayer,
          layerIndex: layerIndex,
          pixelContentKind: 1
        }
      } else if (targetClassId == "Dcmn") {
        if (appController.openDocs.length < 2) return;
        uiDispatchEvent.data = {
          dispatchKind: UiCommand.panCanvasByWheelDirection,
          dir: actionValues.null.v[0].v.val
        }
      } else if (panelToolMap[targetClassId]) {
        uiDispatchEvent.data = {
          dispatchKind: UiCommand.setActiveToolPanelMode,
          T: panelToolMap[targetClassId]
        }
      }
    } else if ((actionVerb == "set" || actionVerb == "reset" || actionVerb == "exchange") && targetClassId == "Clr") {
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.openResourcePresetPopup,
        popupType: PopupTypes.COLOR_CHANGE,
        operation: actionVerb == "reset" ? 3 : 2
      };
      if (actionVerb == "set") {
        uiDispatchEvent.data.operation = targetRef.v.keyID == "FrgC" ? 0 : 1;
        const packedRgb = psdColorToRgb(actionValues.T.v);
        uiDispatchEvent.data.value = packedRgb.h << 16 | packedRgb.l << 8 | packedRgb.O
      }
    } else if (actionVerb == "set") {
      if (targetClassId == "AdjL") {
        let adjustmentWireKey = actionValues.T.v.classID;
        adjustmentWireKey = AdjustmentEngine.figmaDescriptorKeys[adjustmentWireKey];
        documentEvent.routingChannel = EventChannel.EVENT_ADJUSTMENT;
        if (adjustmentWireKey) documentEvent.data = {
          actionKind: "edit_layer",
          value: actionValues.T.v
        }
      } else if (targetClassId == "Lyr") {
        var layerProps = actionValues.T.v;
        var layerIndex = ActionDescUtil.resolveLayerIndexFromRef(doc, targetRef);
        if (layerProps.Nm) documentEvent.data = {
          actionKind: Layer.renameLayer,
          name: layerProps.Nm.v
        };
        else if (layerProps.Opct) documentEvent.data = {
          actionKind: Layer.setLayerOpacity,
          layerPropertyValue: Math.round(layerProps.Opct.v.val * 255 / 100)
        };
        else if (layerProps.fillOpacity) documentEvent.data = {
          actionKind: Layer.setFillOpacity,
          layerPropertyValue: Math.round(layerProps.fillOpacity.v.val * 255 / 100)
        };
        else if (layerProps.Md) documentEvent.data = {
          actionKind: Layer.setBlendMode,
          layerPropertyValue: BlendModes.psdNames.indexOf(layerProps.Md.v.blendMode) + (doc.layers[layerIndex].isGroup() ? 1 : 0)
        };
        else if (layerProps.Usrs) documentEvent.data = {
          actionKind: Layer.toggleRasterMaskEnabled,
          layerIndex: layerIndex
        };
        else if (layerProps.Blnd) {
          documentEvent.routingChannel = EventChannel.EVENT_PLUGIN;
          documentEvent.data = {
            actionKind: "setstl",
            layerIndex: layerIndex,
            value: {
              blendOptions: {
                t: "objc",
                v: layerProps
              }
            }
          };
          appController.dispatch(documentEvent);
          documentEvent.data = {
            actionKind: "confirm",
            layerIndex: layerIndex
          }
        } else if (layerProps.Clr) {
          const labelColorIndex = {
            Rd: 1,
            Ylw: 3,
            Vlt: 6
          } [layerProps.Clr.v.Clr];
          if (labelColorIndex == null) throw new Error("Unknown layer label color: " + layerProps.Clr.v.Clr);
          documentEvent.data = {
            actionKind: Layer.setLayerLabelColor,
            labelColorIndex: labelColorIndex
          }
        } else if (targetDescriptors[0].t == "prop") continue;
        else {
          throw new Error("Unhandled set-Lyr layer property")
        }
        var layerEntry = doc.layers[layerIndex];
        layerEntry.convertFromBackground()
      } else if (targetClassId == "Prpr") {
        var layerProps = JSON.parse(JSON.stringify(actionValues.T.v));
        if (targetRef.v.keyID == "TxtS") {
          var layerIndex = ActionDescUtil.resolveLayerIndexFromRef(doc, actionValues.null.v[1]);
          var layerEntry = doc.layers[layerIndex];
          const textShape = layerEntry.add.TySh;
          const engineDataCopy = JSON.parse(JSON.stringify(textShape.engineData));
          const layerText = TextEngineData.getLayerText(engineDataCopy);
          const textStyleRange = TextEngineData.getTextStyle(engineDataCopy, 0, layerText.length - 2);
          if (layerProps.Undl && layerProps.Undl.v.Undl == "underlineOnLeftInVertical") textStyleRange.textStyle.Underline = true;
          TextEngineData.applyStyle(engineDataCopy, 0, layerText.length - 1, textStyleRange);
          documentEvent.routingChannel = ToolId.TOOL_TYPE;
          documentEvent.data = {
            actionKind: "newED",
            targetLayerIndex: layerIndex,
            engineData: engineDataCopy
          };
          targetIdx = 1e9
        } else {
          for (let effectKey in layerProps)
            if (layerProps[effectKey].v) {
              if (effectKey == "Scl") layerProps[effectKey].v.val = 100;
              if (layerProps[effectKey].v.TrnS && layerProps[effectKey].v.TrnS.v.Crv == null) {
                layerProps[effectKey].v.TrnS = LayerEffectDefs.getEffectDefaultByOrderIndex(9).TrnS
              }
            } PSDResourceParser.mV(layerProps);
          if (layerProps.masterFXSwitch == null) layerProps.masterFXSwitch = {
            t: "bool",
            v: true
          };
          var layerIndex = ActionDescUtil.resolveLayerIndexFromRef(doc, actionValues.null.v[1]);
          documentEvent.routingChannel = EventChannel.EVENT_PLUGIN;
          documentEvent.data = {
            actionKind: "setstl",
            layerIndex: layerIndex,
            value: {
              Lefx: {
                t: "objc",
                v: layerProps
              }
            }
          };
          appController.dispatch(documentEvent);
          documentEvent.data = {
            actionKind: "confirm",
            layerIndex: layerIndex
          }
        }
      } else if (targetClassId == "contentLayer") {
        var layerIndex = ActionDescUtil.resolveLayerIndexFromRef(doc, targetRef);
        var layerProps = actionValues.T.v;
        if (layerProps.classID == "shapeStyle") layerProps = layerProps.FlCn.v;

        const fillLayerKind = {
            solidColorLayer: 0,
            gradientLayer: 1,
            patternLayer: 2
          } [layerProps.classID];

        const fillDescriptor = LayerEffectDefs.getFillLayerDefault(fillLayerKind);
        TrackerRegistry.LayerEffectsTracker.copyContentFillToDescriptor(layerProps, fillDescriptor, fillLayerKind);
        documentEvent.data = {
          actionKind: Layer.updateContentStyle,
          contentLayerIndices: [layerIndex],
          updateContentFill: true,
          contentStylePayload: {
            fillKind: fillLayerKind + 1,
            fillDescriptor: fillDescriptor
          }
        }
      } else if (targetClassId == "Brsh") {
        const brushPreset = JSON.parse(JSON.stringify(appData.brushPresets.activeBrushPreset));
        const brushParams = actionValues.T.v;
        if (brushParams.masterDiameter) brushPreset.Brsh.v.diameter.v.val = brushParams.masterDiameter.v.val;
        uiDispatchEvent.data = {
          dispatchKind: UiCommand.openResourcePresetPopup,
          popupType: PopupTypes.SCRIPTS,
          brushPreset: brushPreset
        }
      } else {
        throw new Error("Unhandled set target class: " + targetClassId)
      }
    } else if (actionVerb == "move") {
      if (targetClassId == "Lyr") {
        var layerProps = actionValues.T.v;
        if (layerProps.classID == "Ofst") {
          documentEvent.data = {
            actionKind: "trsl",
            translateDeltaX: layerProps.Hrzn.v.val,
            translateDeltaY: layerProps.Vrtc.v.val
          };
          documentEvent.routingChannel = ToolId.TOOL_MOVE
        } else {
          let moveTargetIndex;
          let moveOperation;
          if (layerProps[0].t == "Enmr") {
            if (layerProps[0].v.enum == "Frnt") moveOperation = 0;
            else if (layerProps[0].v.enum == "Prvs") moveOperation = 2;
            else if (layerProps[0].v.enum == "Back") moveOperation = 3;
            else throw new Error("Unknown move enum: " + layerProps[0].v.enum)
          } else moveTargetIndex = layerProps[0].v.val;
          documentEvent.data = {
            actionKind: Layer.moveSelection,
            target: moveTargetIndex,
            operation: moveOperation,
            duplicateInPlaceFromAction: actionValues.Dplc ? actionValues.Dplc.v : false
          }
        }
      }
    } else if (actionVerb == "groupEvent") documentEvent.data = {
      actionKind: Layer.toggleClippingMask
    };
    else if (actionVerb == "show" || actionVerb == "hide") {
      if (targetClassId == "Lyr") {
        var layerIndex = ActionDescUtil.resolveLayerIndexFromRef(doc, targetRef);
        if (layerIndex == -1) continue;
        const layerWasVisible = doc.layers[layerIndex].isVisible();
        if (actionVerb == "show" && layerWasVisible || actionVerb == "hide" && !layerWasVisible) continue;
        documentEvent.data = {
          actionKind: Layer.toggleVisibility,
          layerIndex: layerIndex
        }
      } else if (targetClassId == "Chnl") {
        documentEvent.data = {
          actionKind: Layer.extraChannelOp,
          operation: "fromAction",
          recordedActionPayload: actionPayload
        }
      }
    } else if (actionVerb == "rotateEventEnum") {
      documentEvent.routingChannel = ToolId.TOOL_CROP;
      const rotateAngle = actionValues.Angl.v.val;
      documentEvent.data = {
        actionKind: "rot",
        historyLabelKey: "edit.rotate",
        gestureValue: -rotateAngle * Math.PI / 180
      }
    } else if (actionVerb == "flip") {
      documentEvent.routingChannel = ToolId.TOOL_CROP;
      const flipHorizontal = actionValues.Axis.v.Ornt == "Hrzn";
      const flipScale = flipHorizontal ? new Point(-1, 1) : new Point(1, -1);
      documentEvent.data = {
        actionKind: "scl",
        historyLabelKey: [
          "edit.flipVar",
          flipHorizontal ? "warp.orientation.horizontally" : "warp.orientation.vertically"
        ],
        gestureValue: flipScale
      }
    } else if (actionVerb == "transform") {
      let scaleX = 1;
      let scaleY = 1;
      let skewHoriz = 0;
      let skewVert = 0;
      let rotateDeg = 0;
      let offsetX = 0;
      let offsetY = 0;
      if (actionValues.Wdth) scaleX = actionValues.Wdth.v.val / 100;
      if (actionValues.Hght) scaleY = actionValues.Hght.v.val / 100;
      if (actionValues.Skew) {
        const skewValues = actionValues.Skew.v;
        skewHoriz = skewValues.Hrzn.v.val;
        skewVert = skewValues.Vrtc.v.val
      }
      if (actionValues.Ofst) {
        const offsetValues = actionValues.Ofst.v;
        offsetX = offsetValues.Hrzn.v.val;
        offsetY = offsetValues.Vrtc.v.val
      }
      if (actionValues.Angl) rotateDeg = actionValues.Angl.v.val;
      const transformMatrix = new Matrix2D;
      transformMatrix.concat(new Matrix2D(scaleX, scaleX * Math.tan(skewVert * Math.PI / 180), scaleY * Math.tan(skewHoriz * Math.PI / 180), scaleY, 0, 0));
      transformMatrix.rotate(-rotateDeg * Math.PI / 180);
      transformMatrix.translate(offsetX, offsetY);

      const transformAnchor = {
        Qcsa: 4,
        Qcs0: 0,
        Qcs1: 2,
        Qcs2: 8,
        Qcs3: 6,
        Qcs4: 1,
        Qcs5: 5,
        Qcs6: 7,
        Qcs7: 3
      } [actionValues.FTcs.v.QCSt];

      if (transformAnchor == null) throw new Error("Unknown transform anchor: " + actionValues.FTcs.v.QCSt);
      let transformTargetRef = actionValues.null;
      if (transformTargetRef && transformTargetRef.v instanceof Array) transformTargetRef = transformTargetRef.v[0];
      var layerIndex = transformTargetRef ? ActionDescUtil.resolveLayerIndexFromRef(doc, transformTargetRef) : null;
      if (layerIndex == -1) layerIndex = null;
      documentEvent.routingChannel = transformTargetRef && transformTargetRef.v.keyID == "fsel" ? ToolId.TOOL_WARP : ToolId.TOOL_FREE_TRANSFORM;
      documentEvent.data = {
        actionKind: "mat",
        transformAnchorIndex: transformAnchor,
        gestureValue: transformMatrix,
        targetLayerIndex: layerIndex
      }
    } else if (targetClassId == "Chnl") {
      documentEvent.data = {
        actionKind: Layer.extraChannelOp,
        operation: "fromAction",
        recordedActionPayload: actionPayload
      }
    } else if (actionVerb == "duplicate") documentEvent.data = {
      actionKind: Layer.duplicateLayer,
      layerName: actionValues.Nm ? actionValues.Nm.v : null
    };
    else if (actionVerb == "delete") documentEvent.data = {
      actionKind: Layer.deleteLayer
    };
    else if (actionVerb == "align") {
      if (actionValues.Aply && actionValues.Aply.v.projection == "Auto") {
        documentEvent.routingChannel = ToolId.TOOL_CROP;
        documentEvent.data = {
          actionKind: "auto-align"
        }
      } else {
        documentEvent.routingChannel = ToolId.TOOL_MOVE;
        const alignMode = {
          AdLf: 0
        } [actionValues.Usng.v.ADSt];
        if (alignMode == null) throw new Error("Unknown align mode: " + actionValues.Usng.v.ADSt);
        documentEvent.data = {
          actionKind: "algn",
          value: alignMode
        }
      }
    } else if (actionVerb == "applyLocking") {
      const layerLocking = actionValues.layerLocking.v;
      let lockMask;
      if (layerLocking.protectTransparency) lockMask = [
        [layerLocking.protectTransparency.v],
        [0]
      ];
      else if (layerLocking.protectNone) lockMask = [
        [false, false, false, false],
        [0, 1, 2, 31]
      ];
      else {
        throw new Error("Unknown layer locking mode")
      }
      documentEvent.data = {
        actionKind: Layer.toggleLayerLocks,
        layerPropertyValue: lockMask
      }
    }
    if (documentEvent.data) appController.dispatch(documentEvent);
    else if (uiDispatchEvent.data) appController.dispatch(uiDispatchEvent);
    else {
      showToast("Unknown action \"" + actionVerb + "\"");
      throw new Error("Unknown action: " + actionVerb)
    }
  }
};
ActionDescUtil.resolveLayerIndexFromRef = function(doc, refDescriptor) {
  const refType = refDescriptor.t;
  var layerIndex = -1;
  if (refType == "name") {
    const layerName = refDescriptor.v.val;
    var layerIndex = -1;
    for (let layerIdx = 0; layerIdx < doc.layers.length; layerIdx++)
      if (doc.layers[layerIdx].getName() == layerName) {
        layerIndex = layerIdx;
        break
      }
  }
  if (refType == "Enmr" && doc.selectedLayerIndices.length != 0) layerIndex = doc.selectedLayerIndices[0];
  if (refType == "Enmr" && refDescriptor.v.enum == "Frwr") layerIndex = doc.selectedLayerIndices[0] + 1;
  if (refType == "Enmr" && refDescriptor.v.enum == "Bckw") layerIndex = doc.selectedLayerIndices[0] - 1;
  if (refType == "prop") {
    if (refDescriptor.v.keyID == "Bckg") layerIndex = 0
  }
  return layerIndex
};

export { ActionDescUtil };
