/**
 * Builds every right-click context menu used by the Layers panel and hangs
 * them on the panel instance. Each menu is an InputHandler built from two
 * parallel arrays: `items` (labels, sub-menus, and per-row enable/checked/label
 * state resolved from the current document) and `actions` (the AppEvent
 * dispatched when an item is chosen). There is one menu per row type: layer
 * rows, smart-filter stacks and their items, layer-effect stacks and their
 * items, and the raster / filter / vector mask rows.
 *
 * Short FourCC keys reached through `layer.add` (TySh, SoCo, GdFl, PtFl, lmfx,
 * vmsk, placedData, filterFX, enab, masterFXSwitch, …) are PSD descriptor wire
 * keys, not identifiers to rename.
 */
import { Locale } from "../../core/i18n/locale.js";

import { ToolId, EventChannel } from "../../document/model/tool-base.js";
import { ActionDescUtil } from "../../features/scripting/action-desc.js";
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { Layer } from "../../document/model/layer.js";
import { InputHandler } from "../tool-options/input-handler.js";
import { LayerStyleDialog } from "../dialogs/layer-style-dialog.js";
import { TextEngineData } from "../../features/text/text-engine.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { AppEvent } from "../../core/event-bus.js";

/** Construct all Layers-panel context menus and assign them onto `panel`. */
export function installLayersPanelContextMenus(panel) {
  const placedLayerEffectMenuItems = LayerStyleDialog.buildLayerEffectMenuItems(true),
    placedLayerEffectMenuActions = LayerStyleDialog.buildLayerEffectMenuActions(true);
  panel.placedLayerEffectsMenu = new InputHandler(placedLayerEffectMenuItems, placedLayerEffectMenuActions);
  const layerRowContextMenuItems = [{
      name: "layerEffects.blendingOptions"
    }, {
      name: "layerEffects.selectPixels",
      separatorAfter: true
    }, {
      name: "layer.duplicateLayer"
    }, {
      name: "dialogs.duplicateInto"
    }, {
      name: "clipboard.delete",
      separatorAfter: true
    }, {
      name: "layer.convertToSmartObject"
    }, {
      name: "New Smart Obj. via Copy",
      resolveRowState: function(docModel) {
        return {
          enabled: docModel.layers[docModel.selectedLayerIndices[0]].add.placedData != null
        };
      },
      separatorAfter: true
    }, {
      name: "layer.rasterise",
      resolveRowState: function(docModel) {
        const layer = docModel.layers[docModel.selectedLayerIndices[0]];
        if (layer.add.TySh || layer.add.placedData || layer.add.SoCo || layer.add.GdFl || layer.add.PtFl) return {
          enabled: true
        };
        return {
          enabled: false
        }
      }
    }, {
      name: "layer.rasteriseLayerStyle",
      resolveRowState: function(docModel) {
        const layer = docModel.layers[docModel.selectedLayerIndices[0]];
        return {
          enabled: layer.add.lmfx != null && !layer.isGroup()
        }
      }
    }, {
      name: "layer.convertToShape",
      separatorAfter: true,
      resolveRowState: function(docModel) {
        const layer = docModel.layers[docModel.selectedLayerIndices[0]];
        return {
          enabled: layer.add.TySh != null
        };
      }
    }, {
      name: "",
      separatorAfter: true,
      resolveRowState: function(docModel) {
        const layer = docModel.layers[docModel.selectedLayerIndices[0]],
          textLayer = layer.add.TySh,
          textEngineData = textLayer ? textLayer.engineData : null;
        return {
          enabled: textLayer != null && textEngineData.Curve == null,
          labelOverride: Locale.get(
            textLayer && TextEngineData.getTextType(textEngineData) == 0
              ? "text.convertToParagraphText"
              : "text.convertToPointText",
          )
        };
      }
    }, {
      name: "layer.clippingMask",
      separatorAfter: true,
      resolveRowState: function(docModel) {
        return {
          enabled: docModel.canMoveLayerUp(docModel.selectedLayerIndices[0]),
          checked: docModel.layers[docModel.selectedLayerIndices[0]].isClippingMask
        }
      }
    }, {
      name: "dialogs.layerStyle",
      separatorAfter: true,
      sub: [{
        name: "clipboard.copy",
        resolveRowState: function(docModel) {
          const layer = docModel.layers[docModel.selectedLayerIndices[0]];
          return {
            enabled: layer.add.lmfx != null
          }
        }
      }, {
        name: "clipboard.paste"
      }, {
        name: "edit.clear",
        resolveRowState: function(docModel) {
          const layer = docModel.layers[docModel.selectedLayerIndices[0]];
          return {
            enabled: layer.add.lmfx != null
          }
        }
      }]
    }, {
      name: "layer.mergeDown",
      resolveRowState: function(docModel) {
        return {
          enabled: docModel.selectedLayerIndices.length == 1 && docModel.selectedLayerIndices[0] != 0 && !docModel.layers[docModel.selectedLayerIndices[0]].isGroup()
        }
      }
    }, {
      name: "layer.mergeLayers",
      resolveRowState: function(docModel) {
        return {
          enabled: docModel.selectedLayerIndices.length > 1 || docModel.layers[docModel.selectedLayerIndices[0]].isGroup()
        }
      }
    }, {
      name: "layer.flattenImage",
      separatorAfter: true
    }, {
      name: "colour.title",
      sub: function() {
        const colorLabelKeys = [
            "colour.labels.none",
            "colour.labels.red",
            "colour.labels.orange",
            "colour.labels.yellow",
            "colour.labels.green",
            "colour.labels.blue",
            "colour.labels.purple",
            "colour.labels.grey"
          ],
          colorMenuItems = [];
        for (let colorIdx = 0; colorIdx < colorLabelKeys.length; colorIdx++) colorMenuItems.push({
          name: colorLabelKeys[colorIdx]
        });
        return colorMenuItems
      }()
    }],
    layerRowContextMenuActions = [{
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "layerstyle"
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: ToolId.TOOL_RECT_SELECT,
      payload: {
        actionKind: "fromlayer",
        selectionSource: [null, 0, 0]
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.duplicateLayer
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "duplinto"
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.deleteLayer
      }
    }, {
      appEventType: EventType.historyGrouped,
      payload: {
        uf: "newPlacedLayer"
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.duplicateSmartObject
      }
    }, {
      appEventType: EventType.historyGrouped,
      payload: {
        uf: "rasterizeLayer",
        actionDescriptor: {
          classID: "rasterizeLayer",
          null: ActionDescUtil.buildTargetRef("Lyr", true)
        }
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.rasterizeLayerStyle
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.convertTextToShape
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: ToolId.TOOL_TYPE,
      payload: {
        actionKind: "switchPntPrgr"
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.toggleClippingMask
      }
    }, {
      sub: [{
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_PLUGIN,
        payload: {
          actionKind: "st_copy"
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_PLUGIN,
        payload: {
          actionKind: "st_paste"
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_PLUGIN,
        payload: {
          actionKind: "st_clear"
        }
      }]
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.mergeDown
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.mergeCopy
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.flattenImage
      }
    }, {
      sub: function() {
        const layerLabelColorActions = [];
        for (let colorIdx = 0; colorIdx < 8; colorIdx++) layerLabelColorActions.push({
          appEventType: EventType.documentAction,
          documentModelType: EventChannel.EVENT_DOCUMENT,
          payload: {
            actionKind: Layer.setLayerLabelColor,
            labelColorIndex: colorIdx
          }
        });
        return layerLabelColorActions
      }()
    }];
  panel.layerRowContextMenu = new InputHandler(layerRowContextMenuItems, layerRowContextMenuActions);
  const smartFilterMenuItems = [{
      name: "layer.addFilterMask",
      resolveRowState: function(docModel) {
        const layer = docModel.layers[docModel.selectedLayerIndices[0]];
        return {
          enabled: layer.getLinkedPlacedItem(docModel).d == null
        }
      }
    }, {
      name: "enab/disab",
      resolveRowState: function(docModel) {
        const layer = docModel.layers[docModel.selectedLayerIndices[0]];
        if (!layer.hasSmartFilters()) return {
          enabled: false
        };
        return {
          labelOverride: Locale.get(layer.add.placedData.filterFX.v.enab.v ? "layer.disableSmartFilters" : "layer.enableSmartFilters")
        }
      }
    }, {
      name: "layer.clearSmartFilters"
    }],
    smartFilterMenuActions = [{
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.addFilterMask
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.toggleSmartFiltersMaster
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.clearSmartFilters
      }
    }];
  panel.smartFilterMenu = new InputHandler(smartFilterMenuItems, smartFilterMenuActions);
  const smartFilterItemActions = [{
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.toggleSmartFilterVariant,
        layerIndex: 0,
        index: 0
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.deleteSmartFilter,
        sourceLayerIndex: 0,
        filterIndex: 0
      }
    }],
    smartFilterItemMenuItems = [{
      name: "enab/disab",
      resolveRowState: function(docModel) {
        const layer = docModel.layers[docModel.selectedLayerIndices[0]],
          filterIndex = panel.smartFilterContextIndex;
        if (filterIndex == null || filterIndex < 0 || !layer.hasSmartFilters()) return {
          enabled: false
        };
        const filter = layer.add.placedData.filterFX.v.filterFXList.v[filterIndex].v;
        return {
          labelOverride: Locale.get(filter.enab.v ? "layer.disableSmartFilters" : "layer.enableSmartFilters")
        }
      }.bind(this)
    }, {
      name: "layer.deleteSmartFilter"
    }];
  panel.smartFilterItemMenu = new InputHandler(smartFilterItemMenuItems, smartFilterItemActions);
  const layerEffectsStackMenuItems = [{
      name: "enab/disab",
      resolveRowState: function(docModel) {
        const layer = docModel.layers[docModel.selectedLayerIndices[0]];
        if (layer.add.lmfx == null) return {
          enabled: false
        };
        return {
          labelOverride: Locale.get(layer.add.lmfx.masterFXSwitch.v ? "layer.disableLayerEffects" : "layer.enableLayerEffects")
        }
      }
    }, {
      name: "edit.clear"
    }],
    layerEffectsStackMenuActions = [{
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.toggleLayerEffectsMaster,
        layerIndex: 0
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_PLUGIN,
      payload: {
        actionKind: "st_clear",
        layerIndex: 0
      }
    }];
  panel.layerEffectsStackMenu = new InputHandler(layerEffectsStackMenuItems, layerEffectsStackMenuActions);
  const layerEffectItemMenuItems = [{
      name: "enab/disab",
      resolveRowState: function(docModel) {
        const layer = docModel.layers[docModel.selectedLayerIndices[0]],
          effectIndex = panel.layerEffectContextIndex;
        if (effectIndex == null || layer.add.lmfx == null) return {
          enabled: false
        };
        const effect = layer.add.lmfx[LayerEffectDefs.effectKeys[effectIndex[0]]].v[effectIndex[1]].v;
        return {
          labelOverride: Locale.get(effect.enab.v ? "layer.disableLayerEffects" : "layer.enableLayerEffects")
        }
      }.bind(this)
    }, {
      name: "clipboard.delete"
    }],
    layerEffectItemMenuActions = [{
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.toggleLayerEffectVariant,
        layerIndex: 0,
        index: [0, 0]
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_PLUGIN,
      payload: {
        actionKind: "st_delsingle",
        layerIndex: 0,
        effectPathIndices: [0, 0]
      }
    }];
  panel.layerEffectItemMenu = new InputHandler(layerEffectItemMenuItems, layerEffectItemMenuActions);
  const rasterMaskMenuItems = [{
      name: "enab/disab",
      resolveRowState: function(docModel) {
        return {
          labelOverride: Locale.get(docModel.layers[docModel.selectedLayerIndices[0]].getMask().isEnabled ? "layer.disableRasterMask" : "layer.enableRasterMask")
        };
      }
    }, {
      name: "layer.deleteRasterMask"
    }, {
      name: "clipboard.apply",
      resolveRowState: function(docModel) {
        return {
          enabled: docModel.ensureLayerEditableForTools(false, true)
        }
      }
    }],
    rasterMaskMenuActions = [{
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.toggleRasterMask
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.deleteRasterMask
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.applyClipboardLayer
      }
    }];
  panel.rasterMaskMenu = new InputHandler(rasterMaskMenuItems, rasterMaskMenuActions);
  const filterMaskMenuItems = [{
      name: "enab/disab",
      resolveRowState: function(docModel) {
        return {
          labelOverride: Locale.get(docModel.layers[docModel.selectedLayerIndices[0]].getLinkedPlacedItem(docModel).d.isEnabled ? "layer.disableFilterMask" : "layer.enableFilterMask")
        }
      }
    }, {
      name: "layer.deleteFilterMask"
    }],
    filterMaskMenuActions = [{
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.toggleFilterMask
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.deleteFilterMask
      }
    }];
  panel.filterMaskMenu = new InputHandler(filterMaskMenuItems, filterMaskMenuActions);
  const vectorMaskMenuItems = [{
      name: "enab/disab",
      resolveRowState: function(docModel) {
        return {
          labelOverride: Locale.get(docModel.layers[docModel.selectedLayerIndices[0]].add.vmsk.isEnabled ? "layer.disableVectorMask" : "layer.enableVectorMask")
        }
      }
    }, {
      name: "layer.deleteVectorMask"
    }],
    vectorMaskMenuActions = [{
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.toggleVectorMask
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.deleteVectorMask
      }
    }];
  panel.vectorMaskMenu = new InputHandler(vectorMaskMenuItems, vectorMaskMenuActions);
  panel.adjustmentLayerMenu = new InputHandler(LayerStyleDialog.buildAdjustmentLayerMenuItems(true), LayerStyleDialog.buildAdjustmentLayerMenuActions(true));
  panel.layerStyleMenu = new InputHandler(LayerStyleDialog.buildLayerEffectMenuItems(), LayerStyleDialog.buildLayerEffectMenuActions());
}
