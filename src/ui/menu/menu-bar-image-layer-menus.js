/**
 * Image and Layer top-level menus for the application menu bar.
 */

import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { ToolId, EventChannel } from "../../document/model/tool-base.js";
import { AdjustmentEngine } from "../../features/adjustments/adjustment-engine.js";
import { ActionDescUtil } from "../../features/scripting/action-desc.js";
import { Layer } from "../../document/model/layer.js";
import { LayerStyleDialog } from "../dialogs/layer-style-dialog.js";
import { FilterParameterPanel } from "../filter-panels/filter-parameter-panel.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { TransformToolBase } from "../../document/transform/transform-static.js";
import { CropToolBase } from "../../document/tools/crop-tools.js";
import { ShapeToolBase } from "../../document/tools/shape-tools.js";
import { buildShapeAction } from "../../document/tools/shape-actions.js";
import {
  menuWhenDocOpen,
  menuWhenHasLayerSelection,
  menuWhenHasSelection
} from "./menu-bar-predicates.js";

function keyboardMods() {
  const keyboard = KeyboardHandler;
  return {
    keyboard: keyboard,
    ctrlMod: keyboard.Ctrl,
    shiftMod: keyboard.Shift,
    altMod: keyboard.Alt
  };
}

function menuWhenPlacedLayerSelected(currentDoc) {
  return {
    enabled: currentDoc != null && currentDoc.selectedLayerIndices.length != 0 && currentDoc.layers[currentDoc.selectedLayerIndices[0]].add.placedData != null
  };
}

/** Smart-object stack-mode submenu (stats ops) for Layer → Smart Object. */
function buildStatsStackModeMenus() {
  const statsMenuItems = [],
    statsMenuActions = [],
    statsOpCodes = "none maxx avrg medn minn rang stdv summ vari".split(" "),
    statsLocaleKeys = [
      "warp.styles.none",
      "filters.menu.other.maximum",
      "filters.menu.blur.average",
      "filters.menu.noise.median",
      "filters.menu.other.minimum",
      "properties.range", "Standard Deviation", "Summation", "Variance"
    ];
  for (let statsIdx = 0; statsIdx < statsOpCodes.length; statsIdx++) {
    statsMenuItems.push({
      name: statsLocaleKeys[statsIdx]
    });
    statsMenuActions.push({
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.setSmartObjectStackMode,
        stackModeClassId: statsOpCodes[statsIdx]
      }
    });
  }
  return { statsMenuItems: statsMenuItems, statsMenuActions: statsMenuActions };
}

/**
 * Build the Image menu.
 * @returns {{ name: string, items: Array, menuActions: Array }}
 */
export function buildImageMenu() {
  const mods = keyboardMods(),
    keyboard = mods.keyboard,
    ctrlMod = mods.ctrlMod,
    shiftMod = mods.shiftMod,
    altMod = mods.altMod;
  // `items` and `menuActions` are parallel arrays, index-for-index.
  return {
    name: "topMenu.image",
    items: [
    // Adjustments submenu, generated from AdjustmentEngine's registered ops.
    {
      name: "adjustmentsMenuTitle",
      resolveRowState: menuWhenDocOpen,
      sub: function() {
        const adjustmentMenuItems = [];
        for (let adjustmentKey in AdjustmentEngine.names) {
          adjustmentMenuItems.push({
            name: AdjustmentEngine.names[adjustmentKey],
            opensDialog: FilterParameterPanel[adjustmentKey] != null,
            shortcut: KeyboardHandler.formatShortcut(AdjustmentEngine.keys[adjustmentKey]),
            separatorAfter: AdjustmentEngine.noGpuTypes.indexOf(adjustmentKey) != -1,
            resolveRowState: menuWhenDocOpen
          });
          if (adjustmentKey == "selc") {
            adjustmentMenuItems.push({
              name: ["VAR0/VAR1", "styleOptions.toneRange.shadows", "styleOptions.toneRange.highlights"],
              opensDialog: true,
              separatorAfter: true
            });
            adjustmentMenuItems.push({
              name: "styleOptions.desaturate",
              shortcut: [ctrlMod, shiftMod, keyboard.KeyU],
              resolveRowState: function(currentDoc) {
                return {
                  enabled: currentDoc && currentDoc.selectedLayerIndices.length != 0 && currentDoc.layers[currentDoc.selectedLayerIndices[0]].add.placedData == null
                };
              }
            })
          }
        }
        return adjustmentMenuItems
      }()
    }, {
      // One-click auto corrections, then bitmap vectorization.
      name: "adjustments.autoTone",
      resolveRowState: function(currentDoc) {
        return {
          enabled: currentDoc != null && currentDoc.ensureLayerEditableForTools(false)
        }
      }
    }, {
      name: "adjustments.autoContrast",
      resolveRowState: function(currentDoc) {
        return {
          enabled: currentDoc != null && currentDoc.ensureLayerEditableForTools(false)
        }
      }
    }, {
      name: "adjustments.autoColour",
      resolveRowState: function(currentDoc) {
        return {
          enabled: currentDoc != null && currentDoc.ensureLayerEditableForTools(false)
        }
      },
      separatorAfter: true
    }, {
      name: "dialogs.vectorizeBitmap",
      resolveRowState: function(currentDoc) {
        return {
          enabled: currentDoc != null && currentDoc.ensureLayerEditableForTools(false)
        }
      },
      separatorAfter: true
    }, {
      // Canvas / image dimensions, whole-image rotate & flip.
      name: "dialogs.canvasSize",
      opensDialog: true,
      shortcut: [altMod, ctrlMod, keyboard.KeyC],
      resolveRowState: menuWhenDocOpen
    }, {
      name: "dialogs.imageSize",
      opensDialog: true,
      shortcut: [altMod, ctrlMod, keyboard.KeyI],
      resolveRowState: menuWhenDocOpen
    }, {
      name: "edit.transform",
      resolveRowState: menuWhenDocOpen,
      sub: [{
        name: ["VAR0 90\xB0 \u21BB", "edit.rotate"]
      }, {
        name: ["VAR0 90\xB0 \u21BA", "edit.rotate"]
      }, {
        name: ["VAR0 180\xB0", "edit.rotate"]
      }, {
        name: [
          "edit.flipVar",
          "warp.orientation.horizontally"
        ]
      }, {
        name: [
          "edit.flipVar",
          "warp.orientation.vertically"
        ]
      }]
    }, {
      // Crop to selection, trim edges, reveal-all, and Apply Image blend.
      name: "dialogs.crop",
      resolveRowState: function(currentDoc) {
        return {
          enabled: currentDoc != null && currentDoc.selectionMask != null
        }
      }
    }, {
      name: "dialogs.trim",
      resolveRowState: function(currentDoc) {
        return {
          enabled: currentDoc != null
        }
      },
      shortcut: [ctrlMod, keyboard.Period]
    }, {
      name: "dialogs.revealAll",
      resolveRowState: function(currentDoc) {
        return {
          enabled: currentDoc != null
        }
      },
      separatorAfter: true
    }, {
      name: "edit.applyImage",
      resolveRowState: function(currentDoc) {
        return {
          enabled: currentDoc != null && currentDoc.ensureLayerEditableForTools(false)
        }
      },
      opensDialog: true
    }],
    menuActions: [{
      sub: function() {
        const adjustmentActions = [];
        for (let adjustmentKey in AdjustmentEngine.names) {
          adjustmentActions.push({
            appEventType: EventType.documentAction,
            documentModelType: EventChannel.EVENT_ADJUSTMENT,
            payload: {
              actionKind: "start",
              adjustmentKey: adjustmentKey
            }
          });
          if (adjustmentKey == "selc") {
            adjustmentActions.push({
              appEventType: EventType.documentAction,
              documentModelType: EventChannel.EVENT_SMART_FILTER,
              payload: {
                actionKind: "start",
                operationId: "adaptCorrect"
              }
            });
            adjustmentActions.push({
              appEventType: EventType.historyGrouped,
              payload: {
                uf: "desaturate"
              }
            })
          }
        }
        return adjustmentActions
      }()
    }, {
      appEventType: EventType.historyGrouped,
      payload: {
        uf: "levels",
        actionDescriptor: {
          classID: "Lvls",
          Auto: {
            t: "bool",
            v: true
          }
        }
      }
    }, {
      appEventType: EventType.historyGrouped,
      payload: {
        uf: "levels",
        actionDescriptor: {
          classID: "Lvls",
          AuCo: {
            t: "bool",
            v: true
          }
        }
      }
    }, {
      appEventType: EventType.historyGrouped,
      payload: {
        uf: "levels",
        actionDescriptor: {
          classID: "Lvls",
          autoBlackWhite: {
            t: "bool",
            v: true
          },
          autoNeutrals: {
            t: "bool",
            v: true
          }
        }
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "vbitmap"
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "csize"
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "isize"
      }
    }, {
      sub: [{
        appEventType: EventType.historyGrouped,
        payload: TransformToolBase.buildRotateOrFlipAction(true, 90)
      }, {
        appEventType: EventType.historyGrouped,
        payload: TransformToolBase.buildRotateOrFlipAction(true, -90)
      }, {
        appEventType: EventType.historyGrouped,
        payload: TransformToolBase.buildRotateOrFlipAction(true, -180)
      }, {
        appEventType: EventType.historyGrouped,
        payload: TransformToolBase.buildRotateOrFlipAction(false, "Hrzn")
      }, {
        appEventType: EventType.historyGrouped,
        payload: TransformToolBase.buildRotateOrFlipAction(false, "Vrtc")
      }]
    }, {
      appEventType: EventType.documentAction,
      documentModelType: ToolId.TOOL_CROP,
      payload: {
        actionKind: "cropbysel"
      }
    }, {
      appEventType: EventType.historyGrouped,
      payload: CropToolBase.buildTrimAction(0)
    }, {
      appEventType: EventType.historyGrouped,
      payload: {
        uf: "revealAll",
        actionDescriptor: {
          classID: "RvlA"
        }
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_ADJUSTMENT,
      payload: {
        actionKind: "start",
        adjustmentKey: "aply"
      }
    }]
  };
}

/**
 * Build the Layer menu.
 * @returns {{ name: string, items: Array, menuActions: Array }}
 */
export function buildLayerMenu() {
  const mods = keyboardMods(),
    keyboard = mods.keyboard,
    ctrlMod = mods.ctrlMod,
    shiftMod = mods.shiftMod,
    altMod = mods.altMod,
    statsMenus = buildStatsStackModeMenus(),
    statsMenuItems = statsMenus.statsMenuItems,
    statsMenuActions = statsMenus.statsMenuActions;
  // `items` and `menuActions` are parallel arrays, index-for-index.
  return {
    name: "topMenu.layer",
    items: [
    // New: blank layer, folder, or layer via copy; then duplicate / delete.
    {
      name: "clipboard.new",
      resolveRowState: menuWhenDocOpen,
      sub: [{
        name: "topMenu.layer",
        resolveRowState: menuWhenDocOpen
      }, {
        name: "topMenu.folder",
        resolveRowState: menuWhenDocOpen
      }, {
        name: "layer.layerViaCopy",
        shortcut: [ctrlMod, keyboard.KeyJ],
        resolveRowState: menuWhenDocOpen
      }, {
        name: "layer.layerViaCut",
        shortcut: [shiftMod, ctrlMod, keyboard.KeyJ],
        resolveRowState: menuWhenHasSelection
      }]
    }, {
      name: "layer.duplicateLayer",
      resolveRowState: menuWhenHasLayerSelection,
      shortcut: [ctrlMod, keyboard.KeyJ]
    }, {
      name: "dialogs.duplicateInto",
      resolveRowState: menuWhenHasLayerSelection
    }, {
      name: "clipboard.delete",
      resolveRowState: menuWhenHasLayerSelection,
      separatorAfter: true
    }, {
      // Layer style (effects), fill layers, and adjustment layers — the last
      // two submenus are generated by LayerStyleDialog.
      name: "dialogs.layerStyle",
      separatorAfter: true,
      resolveRowState: menuWhenHasLayerSelection,
      sub: LayerStyleDialog.buildLayerEffectMenuItems(true)
    }, {
      name: "layer.newFillLayer.title",
      resolveRowState: menuWhenDocOpen,
      sub: [{
        name: "layer.newFillLayer.colourFill",
        resolveRowState: menuWhenDocOpen
      }, {
        name: "layer.newFillLayer.gradientFill",
        resolveRowState: menuWhenDocOpen
      }, {
        name: "layer.newFillLayer.patternFill",
        resolveRowState: menuWhenDocOpen
      }]
    }, {
      name: "layer.newAdjustmentLayer",
      separatorAfter: true,
      resolveRowState: menuWhenDocOpen,
      sub: LayerStyleDialog.buildAdjustmentLayerMenuItems()
    }, {
      // Masking: raster mask, vector mask, and clipping mask.
      name: "layer.rasterMask",
      sub: [{
        name: "layer.addRevealAll",
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null && currentDoc.selectedLayerIndices.length != 0 && currentDoc.layers[currentDoc.selectedLayerIndices[0]].getMask() == null
          };
        }
      }, {
        name: "layer.layerMask.addHideAll",
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null && currentDoc.selectedLayerIndices.length != 0 && currentDoc.layers[currentDoc.selectedLayerIndices[0]].getMask() == null
          };
        }
      }, {
        name: "layer.layerMask.revealSelection",
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null && currentDoc.selectedLayerIndices.length != 0 && currentDoc.layers[currentDoc.selectedLayerIndices[0]].getMask() == null && currentDoc.selectionMask != null
          };
        }
      }, {
        name: "layer.layerMask.hideSelection",
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null && currentDoc.selectedLayerIndices.length != 0 && currentDoc.layers[currentDoc.selectedLayerIndices[0]].getMask() == null && currentDoc.selectionMask != null
          };
        }
      }, {
        name: "layer.layerMask.fromTransparency",
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null && currentDoc.selectedLayerIndices.length != 0 && currentDoc.layers[currentDoc.selectedLayerIndices[0]].getMask() == null
          };
        },
        separatorAfter: true
      }, {
        name: "clipboard.delete",
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null && currentDoc.selectedLayerIndices.length != 0 && currentDoc.layers[currentDoc.selectedLayerIndices[0]].getMask() != null
          };
        }
      }, {
        name: "clipboard.apply",
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null && currentDoc.selectedLayerIndices.length != 0 && currentDoc.layers[currentDoc.selectedLayerIndices[0]].getMask() != null && currentDoc.ensureLayerEditableForTools(false, true)
          };
        }
      }, {
        name: ["VAR0/VAR1", "clipboard.enable", "clipboard.disable"],
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null && currentDoc.selectedLayerIndices.length != 0 && currentDoc.layers[currentDoc.selectedLayerIndices[0]].getMask() != null
          };
        }
      }]
    }, {
      name: "layer.vectorMask",
      sub: [{
        name: "layer.addRevealAll",
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null && currentDoc.selectedLayerIndices.length != 0 && currentDoc.layers[currentDoc.selectedLayerIndices[0]].add.vmsk == null
          }
        }
      }, {
        name: "layer.layerMask.addHideAll",
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null && currentDoc.selectedLayerIndices.length != 0 && currentDoc.layers[currentDoc.selectedLayerIndices[0]].add.vmsk == null
          }
        }
      }, {
        name: "Current Path",
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null && currentDoc.selectedLayerIndices.length != 0 && currentDoc.layers[currentDoc.selectedLayerIndices[0]].add.vmsk == null
          }
        },
        separatorAfter: true
      }, {
        name: "clipboard.delete",
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null && currentDoc.selectedLayerIndices.length != 0 && currentDoc.layers[currentDoc.selectedLayerIndices[0]].add.vmsk != null
          }
        }
      }, {
        name: ["VAR0/VAR1", "clipboard.enable", "clipboard.disable"],
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null && currentDoc.selectedLayerIndices.length != 0 && currentDoc.layers[currentDoc.selectedLayerIndices[0]].add.vmsk != null
          }
        }
      }]
    }, {
      name: "layer.clippingMask",
      shortcut: [altMod, ctrlMod, keyboard.KeyG],
      separatorAfter: true,
      resolveRowState: function(currentDoc) {
        return {
          checked: currentDoc != null && currentDoc.selectedLayerIndices.length != 0 && currentDoc.layers[currentDoc.selectedLayerIndices[0]].isClippingMask,
          enabled: currentDoc != null && currentDoc.canMoveLayerUp(currentDoc.selectedLayerIndices[0])
        }
      }
    }, {
      // Smart object: convert, stack mode (stats ops), edit contents, flatten.
      name: "Smart Object",
      separatorAfter: true,
      resolveRowState: menuWhenDocOpen,
      sub: [{
        name: "layer.convertToSmartObject",
        resolveRowState: menuWhenDocOpen
      }, {
        name: "layer.smartObject.stackMode",
        resolveRowState: menuWhenPlacedLayerSelected,
        sub: statsMenuItems
      }, {
        name: "file.open",
        resolveRowState: menuWhenPlacedLayerSelected,
        separatorAfter: true
      }, {
        name: "Turn into JPG",
        resolveRowState: menuWhenDocOpen
      }]
    }, {
      // Rasterize the layer or just its layer style.
      name: "layer.rasterise",
      resolveRowState: function(currentDoc) {
        if (currentDoc == null || currentDoc.selectedLayerIndices.length == 0) return {
          enabled: false
        };
        const activeLayer = currentDoc.layers[currentDoc.selectedLayerIndices[0]];
        if (activeLayer.add.TySh || activeLayer.add.placedData || activeLayer.add.SoCo || activeLayer.add.GdFl || activeLayer.add.PtFl) return {
          enabled: true
        };
        return {
          enabled: false
        }
      }
    }, {
      name: "layer.rasteriseLayerStyle",
      separatorAfter: true,
      resolveRowState: function(currentDoc) {
        if (currentDoc == null || currentDoc.selectedLayerIndices.length == 0) return {
          enabled: false
        };
        const activeLayer = currentDoc.layers[currentDoc.selectedLayerIndices[0]];
        return {
          enabled: activeLayer.add.lmfx != null && !activeLayer.isGroup()
        }
      }
    }, {
      // Group selected layers, then z-order arrange and animation frames.
      name: "layer.groupLayers",
      separatorAfter: true,
      shortcut: [ctrlMod, keyboard.KeyG],
      resolveRowState: menuWhenHasLayerSelection
    }, {
      name: "layer.arrange.title",
      separatorAfter: true,
      resolveRowState: menuWhenHasLayerSelection,
      sub: [{
        name: "layer.arrange.bringToFront",
        shortcut: [shiftMod, ctrlMod, keyboard.BracketRight],
        resolveRowState: menuWhenHasLayerSelection
      }, {
        name: "layer.arrange.bringForward",
        shortcut: [ctrlMod, keyboard.BracketRight],
        resolveRowState: menuWhenHasLayerSelection
      }, {
        name: "layer.arrange.sendBackward",
        shortcut: [ctrlMod, keyboard.BracketLeft],
        resolveRowState: menuWhenHasLayerSelection
      }, {
        name: "layer.arrange.sendToBack",
        shortcut: [shiftMod, ctrlMod, keyboard.BracketLeft],
        resolveRowState: menuWhenHasLayerSelection
      }]
    }, {
      name: "layer.animation",
      resolveRowState: menuWhenDocOpen,
      sub: [{
        name: ["Make Frames"],
        resolveRowState: menuWhenDocOpen
      }, {
        name: "pathOps.merge",
        resolveRowState: menuWhenDocOpen
      }]
    }, {
      // Merge down, merge selected / group, and flatten the whole image.
      name: "layer.mergeDown",
      resolveRowState: function(currentDoc) {
        return {
          enabled: currentDoc != null && currentDoc.selectedLayerIndices.length == 1 && currentDoc.selectedLayerIndices[0] != 0 && !currentDoc.layers[currentDoc.selectedLayerIndices[0]].isGroup()
        }
      },
      shortcut: [ctrlMod, keyboard.KeyE]
    }, {
      name: "layer.mergeLayers",
      resolveRowState: function(currentDoc) {
        return {
          enabled: currentDoc != null && currentDoc.selectedLayerIndices.length != 0 && (currentDoc.selectedLayerIndices.length > 1 || currentDoc.layers[currentDoc.selectedLayerIndices[0]].isGroup())
        }
      }
    }, {
      name: "layer.flattenImage",
      resolveRowState: menuWhenDocOpen
    }],
    menuActions: [{
      sub: [{
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.newLayer
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.newFolder
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.newLayerViaCopy
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.newLayerViaCut
        }
      }]
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
      sub: LayerStyleDialog.buildLayerEffectMenuActions(true)
    }, {
      sub: [{
        appEventType: EventType.documentAction,
        documentModelType: ToolId.TOOL_RECT_SHAPE,
        payload: {
          actionKind: "newfill",
          openSolidFillColorPicker: true
        }
      }, {
        appEventType: EventType.historyGrouped,
        payload: buildShapeAction(1)
      }, {
        appEventType: EventType.historyGrouped,
        payload: buildShapeAction(2)
      }]
    }, {
      sub: LayerStyleDialog.buildAdjustmentLayerMenuActions()
    }, {
      sub: [{
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.addRasterMask,
          maskRevealMode: "RvlA"
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.addRasterMask,
          maskRevealMode: "HdAl"
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.addRasterMask,
          maskRevealMode: "RvlS"
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.addRasterMask,
          maskRevealMode: "HdSl"
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.addRasterMask,
          maskRevealMode: "Trns"
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
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.toggleRasterMask
        }
      }]
    }, {
      sub: [{
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.addVectorMask,
          revealVectorMaskPixels: false
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.addVectorMask,
          revealVectorMaskPixels: true
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.addVectorMask,
          applyActivePath: true
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.deleteVectorMask
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.toggleVectorMask
        }
      }]
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.toggleClippingMask
      }
    }, {
      sub: [{
        appEventType: EventType.historyGrouped,
        payload: {
          uf: "newPlacedLayer"
        }
      }, {
        sub: statsMenuActions
      }, {
        appEventType: EventType.historyGrouped,
        payload: {
          uf: "placedLayerEditContents",
          actionDescriptor: {
            classID: "placedLayerEditContents"
          }
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.dispatch$
        }
      }]
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
        actionKind: Layer.groupOrUngroup
      }
    }, {
      sub: [{
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.moveSelection,
          operation: 0
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.moveSelection,
          operation: 1
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.moveSelection,
          operation: 2
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.moveSelection,
          operation: 3
        }
      }]
    }, {
      sub: [{
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.timelineFrames,
          operation: "makeframes"
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_DOCUMENT,
        payload: {
          actionKind: Layer.timelineFrames,
          operation: "merge"
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
      appEventType: EventType.historyGrouped,
      payload: {
        uf: "flattenImage"
      }
    }]
  };
}
