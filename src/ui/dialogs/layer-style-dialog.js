/**
 * Layer Style dialog and menu builders for layer effects / adjustment layers.
 */

import { Locale } from "../../core/i18n/locale.js";
import { menuWhenDocOpen, menuWhenHasLayerSelection } from "../menu/menu-bar-predicates.js";
import { ToolId, EventChannel } from "../../document/model/tool-base.js";
import { ActionDescUtil } from "../../features/scripting/action-desc.js";
import { AdjustmentEngine } from "../../features/adjustments/adjustment-engine.js";
import { FilterDefs } from "../../features/filters/filter-apply.js";
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { TrackerRegistry } from "../../features/trackers/tracker-registry.js";
import { LayerStyleRenderer } from "../../features/layer-styles/style-renderer.js";
import { PopupTypes } from "../config/popup-types.js";
import { StyleButton } from "../widgets/controls/brush-preset-controls.js";
import { LayerEffectRow } from "../panels/layer-effect-row.js";
import { Button } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";
import { FilterParameterPanel } from "../filter-panels/filter-parameter-panel.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, clearElement, makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { ShapeToolBase } from "../../document/tools/shape-tools.js";
import { buildShapeAction } from "../../document/tools/shape-actions.js";


/** A share of `available`, held between `min` and `max` but never over `available`. */
function clampToViewport(available, ratio, min, max) {
  return Math.min(Math.max(Math.round(available * ratio), min), Math.min(max, available));
}

function buildMakeLayerEffectsActionDescriptor() {
  return {
    classID: "Mk",
    null: ActionDescUtil.buildTargetRef("Lyr"),
    Usng: {
      t: "obj ",
      v: [{
        t: "prop",
        v: {
          classID: "Prpr",
          keyID: "Lefx"
        }
      }, {
        t: "Enmr",
        v: {
          classID: "Lyr",
          typeID: "Ordn",
          enum: "Trgt"
        }
      }]
    }
  };
}

function appendScaleEffectMenuItems(menuItems) {
  menuItems[menuItems.length - 1].separatorAfter = true;
  menuItems.push({
    name: "Scale Effects",
    resolveRowState: function(doc) {
      return {
        enabled: doc != null && doc.selectedLayerIndices.length !== 0 && doc.layers[doc.selectedLayerIndices[0]].hasLayerEffects()
      };
    }
  });
  menuItems.push({
    name: ["VAR0 VAR1", "layer.enableLayerEffects", "layer.disableLayerEffects"],
    resolveRowState: function(doc) {
      return {
        enabled: doc != null && doc.selectedLayerIndices.length !== 0 && doc.layers[doc.selectedLayerIndices[0]].add.lmfx != null
      };
    }
  });
}

function appendScaleEffectMenuActions(menuActions) {
  menuActions.push({
    appEventType: EventType.uiDispatch,
    payload: {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "scaleeffects",
      initialValue: 100,
      deferredDispatch: {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_PLUGIN,
        payload: {
          actionKind: "scaleeffects"
        }
      }
    }
  });
  menuActions.push({
    appEventType: EventType.historyGrouped,
    payload: {
      uf: "make",
      actionDescriptor: buildMakeLayerEffectsActionDescriptor()
    }
  });
}

function buildAdjustmentLayerHistoryAction(adjTypeId) {
  let adjDescriptor = FilterDefs.create(adjTypeId);
  if (adjDescriptor == null) adjDescriptor = {};
  for (const figmaKey in AdjustmentEngine.figmaDescriptorKeys) {
    if (AdjustmentEngine.figmaDescriptorKeys[figmaKey] == adjTypeId) adjDescriptor.classID = figmaKey;
  }
  return {
    appEventType: EventType.historyGrouped,
    payload: {
      uf: "make",
      actionDescriptor: {
        classID: "Mk",
        null: ActionDescUtil.buildTargetRef("AdjL"),
        Usng: {
          t: "Objc",
          v: {
            classID: "AdjL",
            Type: {
              t: "Objc",
              v: adjDescriptor
            }
          }
        }
      }
    }
  };
}

/**
 * Opening height, as a share of the space the viewport allows: the effect list
 * is long and scrolls, so it takes what the screen can give. Width comes from
 * the columns themselves, which have a settled layout to keep.
 */
const DIALOG_HEIGHT_RATIO = 0.7;
const DIALOG_MIN_WIDTH = 620;
const DIALOG_MIN_HEIGHT = 420;
const DIALOG_MAX_HEIGHT = 760;

function LayerStyleDialog() {
  BaseDialog.call(this, "dialogs.layerStyle", "layerstyle");
  this.data = {};
  this.hostDocument = null;
  this.doc = null;
  this.effectRows = [];
  this.effectRowsByCategory = [];
  addClass(this.body, "flexrow");
  this.effectListColumnEl = makeElement("div", "bordered layerstyle-effect-list");
  this.body.appendChild(this.effectListColumnEl);
  this.effectDetailColumnEl = makeElement("div", "layerstyle-effect-detail");
  this.body.appendChild(this.effectDetailColumnEl);
  this.actionButtonColumnEl = makeElement("div", "form dialog-actions layerstyle-actions");
  this.body.appendChild(this.actionButtonColumnEl);
  this.okBtn = new Button("clipboard.ok", true, null, true);
  this.okBtn.on("click", this.onOK, this);
  this.actionButtonColumnEl.appendChild(this.okBtn.el);
  this.defineNewStyleButton = new Button("properties.defineNew", true, null, true);
  this.defineNewStyleButton.on("click", this.onDefineNewStyleClicked, this);
  this.actionButtonColumnEl.appendChild(this.defineNewStyleButton.el);
  this.stylePresetButton = new StyleButton();
  this.stylePresetButton.parent = this;
  this.stylePresetButton.on(EventType.widgetSelect, this.onStylePresetSelected, this);
  this.actionButtonColumnEl.appendChild(this.stylePresetButton.el);
  this.on("closebtn", this.onCancel, this);
  this.on("redrawall", this.reopenFromHostDocument, this)
}
LayerStyleDialog.prototype = Object.create(BaseDialog.prototype);
LayerStyleDialog.prototype.constructor = LayerStyleDialog;
LayerStyleDialog.prototype.getPreferredContentSize = function(maxW, maxH) {
  const measured = this.measureBodyContentSize(maxW, maxH);
  return {
    width: measured == null ? Math.min(DIALOG_MIN_WIDTH, maxW) : measured.width,
    height: clampToViewport(maxH, DIALOG_HEIGHT_RATIO, DIALOG_MIN_HEIGHT, DIALOG_MAX_HEIGHT)
  }
};
LayerStyleDialog.prototype.isActive = function() {
  return true
};
LayerStyleDialog.prototype.hasOverlay = function() {
  return true
};
LayerStyleDialog.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  const activeEffectRow = this.getActiveEffectRow();
  if (activeEffectRow) activeEffectRow.onMouseDown(doc, dispatcher, appData, keyboard, pointerState)
};
LayerStyleDialog.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
  const activeEffectRow = this.getActiveEffectRow();
  if (activeEffectRow) activeEffectRow.onMouseMove(doc, dispatcher, appData, keyboard, pointerState)
};
LayerStyleDialog.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
  const activeEffectRow = this.getActiveEffectRow();
  if (activeEffectRow) activeEffectRow.onMouseUp(doc, dispatcher, appData, keyboard, pointerState)
};
LayerStyleDialog.prototype.getActiveEffectRow = function(effectPathIndices) {
  if (effectPathIndices == null) effectPathIndices = this.data.index;
  return effectPathIndices == null ? null : effectPathIndices == 0 ? this.effectRows[0] : this.effectRowsByCategory[effectPathIndices[0]][effectPathIndices[1]];
};
LayerStyleDialog.prototype.onStylePresetSelected = function(widgetEvent) {
  const stylePresetValue = this.stylePresetButton.getValue();
  this.applyEvent({
    actionKind: "setstl",
    value: stylePresetValue.styleEffects
  });
  this.reopenFromHostDocument(null)
};
LayerStyleDialog.prototype.onDefineNewStyleClicked = function(clickEvent) {
  const hostDoc = this.hostDocument;
  let layerIndex = this.data.layerIndex;
  if (layerIndex == null) layerIndex = hostDoc.selectedLayerIndices[0];
  const targetLayer = this.hostDocument.layers[layerIndex],
    clonedEffectsJson = LayerStyleRenderer.cloneLayerEffectsJson(targetLayer),
    dispatchEvent = new AppEvent(EventType.uiDispatch, true);
  dispatchEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    scriptHostData: "add",
    popupType: PopupTypes.STYLES,
    presetPayload: [JSON.parse(JSON.stringify(clonedEffectsJson))]
  };
  this.dispatch(dispatchEvent)
};
LayerStyleDialog.prototype.onEffectRowListItemSelected = function(widgetEvent) {
  this.data.index = widgetEvent.currentTarget.effectPathIndices;
  this.showEffectEditorAtIndex(widgetEvent.currentTarget.effectPathIndices)
};
LayerStyleDialog.prototype.reopenFromHostDocument = function(redrawEvent) {
  this.open(this.hostDocument, this.data)
};
LayerStyleDialog.prototype.showEffectEditorAtIndex = function(effectPathIndices, enableOnSelect) {
  clearElement(this.effectDetailColumnEl);
  for (let categoryIdx = 0; categoryIdx < this.effectRows.length; categoryIdx++) this.effectRows[categoryIdx].clearListSelection();
  const activeEffectRow = this.getActiveEffectRow(effectPathIndices);
  this.effectDetailColumnEl.appendChild(activeEffectRow.mountSelectedSection());
  if (enableOnSelect) activeEffectRow.enableEffectOnSelect();
  const hostDoc = this.hostDocument;
  if (hostDoc) {
    const targetLayer = hostDoc.layers[this.data.layerIndex];
    this.effectRows[0].update(hostDoc, TrackerRegistry.LayerStyleDialogTracker.snapshotBlendingOptions(hostDoc, targetLayer));
    const layerEffects = targetLayer.add.lmfx;
    if (layerEffects == null) return;
    for (let categoryIdx = 0; categoryIdx < LayerEffectDefs.order.length; categoryIdx++) {
      const effectInstances = layerEffects[LayerEffectDefs.effectKeys[categoryIdx]].v;
      for (let instanceIdx = 0; instanceIdx < effectInstances.length; instanceIdx++) this.effectRowsByCategory[categoryIdx][instanceIdx].update(hostDoc, effectInstances[instanceIdx].v)
    }
  }
  if (enableOnSelect) activeEffectRow.enableEffectOnSelect()
};
LayerStyleDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.defineNewStyleButton.buildUI();
  this.stylePresetButton.buildUI();
  for (let effectRowIdx = 0; effectRowIdx < this.effectRows.length; effectRowIdx++) this.effectRows[effectRowIdx].buildUI()
};
LayerStyleDialog.prototype.open = function(currentDoc, dialogData) {
  const isFirstOpen = dialogData.layerIndex == null;
  this.data.layerIndex = dialogData.layerIndex;
  this.data.index = dialogData.index;
  dialogData = this.data;
  this.hostDocument = currentDoc;
  if (isFirstOpen) dialogData.layerIndex = currentDoc.selectedLayerIndices.length == 0 ? currentDoc.layers.length - 1 : currentDoc.selectedLayerIndices[0];
  clearElement(this.effectListColumnEl);
  const layerEffects = currentDoc.layers[dialogData.layerIndex].add.lmfx;
  this.syncStylePresetButton();
  this.effectRows = [new LayerEffectRow("bops", false, 0)];
  this.effectRowsByCategory = [];
  for (let categoryIdx = 0; categoryIdx < LayerEffectDefs.order.length; categoryIdx++) {
    this.effectRowsByCategory.push([]);
    const effectInstances = layerEffects == null ? [] : layerEffects[LayerEffectDefs.effectKeys[categoryIdx]].v;
    for (let instanceIdx = 0; instanceIdx < effectInstances.length; instanceIdx++) {
      const effectRow = new LayerEffectRow(LayerEffectDefs.order[categoryIdx], false, [categoryIdx, instanceIdx]);
      this.effectRows.push(effectRow);
      this.effectRowsByCategory[categoryIdx].push(effectRow)
    }
    if (effectInstances.length == 0) {
      const effectRow = new LayerEffectRow(LayerEffectDefs.order[categoryIdx], false, [categoryIdx, 0]);
      this.effectRows.push(effectRow);
      this.effectRowsByCategory[categoryIdx].push(effectRow)
    }
  }
  this.buildUI();
  this.updateAllEffectRows(this.doc, PopupTypes.ALL);
  for (let categoryIdx = 0; categoryIdx < this.effectRows.length; categoryIdx++) {
    this.effectRows[categoryIdx].parent = this;
    this.effectRows[categoryIdx].appendListItems(this.effectListColumnEl);
    this.effectRows[categoryIdx].on("showme", this.onEffectRowListItemSelected, this)
  }
  if (dialogData.index == null || dialogData.index == 0 || !isFirstOpen && layerEffects[LayerEffectDefs.effectKeys[dialogData.index[0]]].v.length == 0) {
    this.showEffectEditorAtIndex(0)
  } else this.showEffectEditorAtIndex(dialogData.index, isFirstOpen);
  this.on("afterchange", this.syncStylePresetButton, this)
};
LayerStyleDialog.prototype.syncStylePresetButton = function(unusedEvent) {
  const hostDoc = this.hostDocument;
  let layerIndex = this.data.layerIndex;
  if (layerIndex == null) layerIndex = hostDoc.selectedLayerIndices[0];
  const targetLayer = this.hostDocument.layers[layerIndex],
    clonedEffectsJson = LayerStyleRenderer.cloneLayerEffectsJson(targetLayer);
  this.stylePresetButton.setValue(clonedEffectsJson, hostDoc.add.Patt ? hostDoc.add.Patt : [], hostDoc.getRotationAngle(), hostDoc.getGlobalLightAngle())
};
LayerStyleDialog.prototype.onUpdate = function(appData, popupType) {
  this.doc = appData;
  this.updateAllEffectRows(appData, popupType);
  if (popupType == PopupTypes.STYLES || popupType == PopupTypes.ALL) {
    this.stylePresetButton.setPresets([appData.stylePresets, appData.patternPresets])
  }
  if (popupType == PopupTypes.SHAPES) {}
};
LayerStyleDialog.prototype.updateAllEffectRows = function(appData, popupType) {
  for (let effectRowIdx = 0; effectRowIdx < this.effectRows.length; effectRowIdx++) this.effectRows[effectRowIdx].onUpdate(appData, popupType)
};
LayerStyleDialog.prototype.onCancel = function(clickEvent) {
  this.applyEvent({
    actionKind: "cancel"
  })
};
LayerStyleDialog.prototype.onOK = function(clickEvent) {
  this.applyEvent({
    actionKind: "confirm"
  });
  this.close()
};
LayerStyleDialog.prototype.applyEvent = function(actionPayload) {
  actionPayload.layerIndex = this.data.layerIndex;
  const docActionEvent = new AppEvent(EventType.documentAction, true);
  docActionEvent.data = actionPayload;
  docActionEvent.routingChannel = EventChannel.EVENT_PLUGIN;
  docActionEvent.fromDialog = true;
  this.dispatch(docActionEvent);
  this.syncStylePresetButton()
};
LayerStyleDialog.buildLayerEffectMenuItems = function(includeScaleEffects) {
  const menuItems = [{
    name: "layerEffects.blendingOptions",
    separatorAfter: true,
    resolveRowState: menuWhenHasLayerSelection
  }];
  for (let nameIdx = 0; nameIdx < LayerEffectDefs.names.length; nameIdx++) menuItems.push({
    name: LayerEffectDefs.names[nameIdx],
    resolveRowState: menuWhenHasLayerSelection
  });
  if (includeScaleEffects) appendScaleEffectMenuItems(menuItems);
  return menuItems;
};
LayerStyleDialog.buildLayerEffectMenuActions = function(includeScaleEffects) {
  const menuActions = [{
    appEventType: EventType.uiDispatch,
    payload: {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "layerstyle"
    }
  }];
  for (let nameIdx = 0; nameIdx < LayerEffectDefs.names.length; nameIdx++) menuActions.push({
    appEventType: EventType.uiDispatch,
    payload: {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "layerstyle",
      index: [nameIdx, 0]
    }
  });
  if (includeScaleEffects) appendScaleEffectMenuActions(menuActions);
  return menuActions;
};
LayerStyleDialog.buildAdjustmentLayerMenuItems = function(includeFillLayers) {
  const menuItems = [];
  if (includeFillLayers) menuItems.push({
    name: "layer.newFillLayer.colourFill",
    opensDialog: true,
    resolveRowState: menuWhenDocOpen
  }, {
    name: "layer.newFillLayer.gradientFill",
    opensDialog: true,
    resolveRowState: menuWhenDocOpen
  }, {
    name: "layer.newFillLayer.patternFill",
    opensDialog: true,
    separatorAfter: true,
    resolveRowState: menuWhenDocOpen
  });
  for (let adjTypeId in AdjustmentEngine.names) menuItems.push({
    name: AdjustmentEngine.names[adjTypeId],
    separatorAfter: AdjustmentEngine.noGpuTypes.indexOf(adjTypeId) != -1,
    opensDialog: FilterParameterPanel[adjTypeId] != null,
    resolveRowState: menuWhenDocOpen
  });
  return menuItems;
};
LayerStyleDialog.buildAdjustmentLayerMenuActions = function(includeFillLayers) {
  const menuActions = [];
  if (includeFillLayers) {
    menuActions.push({
      appEventType: EventType.documentAction,
      documentModelType: ToolId.TOOL_RECT_SHAPE,
      payload: {
        actionKind: "newfill",
        openSolidFillColorPicker: true
      }
    });
    for (let fillKindIdx = 1; fillKindIdx < 3; fillKindIdx++) menuActions.push({
      appEventType: EventType.historyGrouped,
      payload: buildShapeAction(fillKindIdx)
    })
  }
  for (let adjTypeId in AdjustmentEngine.names) menuActions.push(buildAdjustmentLayerHistoryAction(adjTypeId));
  return menuActions;
};

export { LayerStyleDialog };
