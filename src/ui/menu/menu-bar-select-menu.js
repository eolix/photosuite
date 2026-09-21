/**
 * Select top-level menu (and optional Free Transform shortcut for tool options).
 */

import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { ToolId } from "../../document/model/tool-base.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { SelectTool } from "../../document/tools/selection-tools.js";

/**
 * Build the Select menu (items + menuActions).
 * @param {boolean} includeFreeTransformShortcut
 * @returns {{ name: string, items: Array, menuActions: Array }}
 */
export function buildSelectMenu(includeFreeTransformShortcut) {
  const keyboard = KeyboardHandler,
    ctrlMod = keyboard.Ctrl,
    shiftMod = keyboard.Shift,
    altMod = keyboard.Alt,
    // `items` (labels / shortcuts / row-state) and `menuActions` (dispatch
    // descriptors) are parallel arrays: index N in one lines up with index N
    // in the other, including nested `sub` arrays.
    selectMenu = {
      name: "topMenu.select",
      items: [
        // Whole-canvas selection: select all, deselect, invert.
        {
        name: "select.all",
        shortcut: [ctrlMod, keyboard.KeyA]
      }, {
        name: "select.deselect",
        shortcut: [ctrlMod, keyboard.KeyD],
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null && currentDoc.selectionMask != null
          }
        }
      }, {
        name: "select.inverse",
        shortcut: [shiftMod, ctrlMod, keyboard.KeyI],
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null && currentDoc.selectionMask != null
          }
        },
        separatorAfter: true
      },
        // Edge refinement, AI cutout, and colour-range dialogs.
        {
        name: "select.refineEdge",
        opensDialog: true,
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null && currentDoc.selectedLayerIndices.length != 0 && !currentDoc.layers[currentDoc.selectedLayerIndices[0]].rect.isEmpty()
          };
        }
,
        separatorAfter: true
      }, {
        name: "select.colourRange",
        opensDialog: true
      }, {
        // Modify submenu: grow / shrink / smooth / feather the mask.
        name: "select.modify",
        separatorAfter: true,
        sub: [{
          name: "select.border",
          opensDialog: true,
          resolveRowState: function(currentDoc) {
            return {
              enabled: currentDoc != null && currentDoc.selectionMask != null
            }
          }
        }, {
          name: "styleOptions.bevelTechnique.smooth",
          opensDialog: true,
          resolveRowState: function(currentDoc) {
            return {
              enabled: currentDoc != null && currentDoc.selectionMask != null
            }
          }
        }, {
          name: "select.expand",
          opensDialog: true,
          resolveRowState: function(currentDoc) {
            return {
              enabled: currentDoc != null && currentDoc.selectionMask != null
            }
          }
        }, {
          name: "select.contract",
          opensDialog: true,
          resolveRowState: function(currentDoc) {
            return {
              enabled: currentDoc != null && currentDoc.selectionMask != null
            }
          }
        }, {
          name: "select.feather",
          opensDialog: true,
          resolveRowState: function(currentDoc) {
            return {
              enabled: currentDoc != null && currentDoc.selectionMask != null
            }
          },
          shortcut: "Shift+F6"
        }]
      }, {
        // Transform the marquee, toggle Quick Mask mode, save the selection.
        name: "select.transformSelection",
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null && currentDoc.selectionMask != null
          }
        },
        separatorAfter: true
      }, {
        name: "layer.quickMaskMode",
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null,
            checked: currentDoc != null && currentDoc.getQuickMask()
          };
        },
        shortcut: [keyboard.KeyQ],
        separatorAfter: true
      }, {
        name: "Save Selection"
      }],
      // Dispatch descriptors, one per `items` row above (same order / nesting).
      menuActions: [{
        appEventType: EventType.historyGrouped,
        payload: SelectTool.buildSelectAllAction(true)
      }, {
        appEventType: EventType.historyGrouped,
        payload: SelectTool.buildSelectAllAction()
      }, {
        appEventType: EventType.historyGrouped,
        payload: {
          uf: "inverse"
        }
      }, {
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.dispatchAppDialogRouter,
          dialogRouteId: "redge"
        }

      }, {
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.dispatchAppDialogRouter,
          dialogRouteId: "crange"
        }
      }, {
        sub: [{
          appEventType: EventType.uiDispatch,
          payload: {
            dispatchKind: UiCommand.dispatchAppDialogRouter,
            dialogRouteId: "sel_border"
          }
        }, {
          appEventType: EventType.uiDispatch,
          payload: {
            dispatchKind: UiCommand.dispatchAppDialogRouter,
            dialogRouteId: "sel_smoothness"
          }
        }, {
          appEventType: EventType.uiDispatch,
          payload: {
            dispatchKind: UiCommand.dispatchAppDialogRouter,
            dialogRouteId: "sel_expand"
          }
        }, {
          appEventType: EventType.uiDispatch,
          payload: {
            dispatchKind: UiCommand.dispatchAppDialogRouter,
            dialogRouteId: "sel_contract"
          }
        }, {
          appEventType: EventType.uiDispatch,
          payload: {
            dispatchKind: UiCommand.dispatchAppDialogRouter,
            dialogRouteId: "sel_feather"
          }
        }]
      }, {
        appEventType: EventType.uiDispatch,
        documentModelType: ToolId.TOOL_WARP,
        payload: {
          dispatchKind: UiCommand.setActiveToolPanelMode
        }
      }, {
        appEventType: EventType.documentAction,
        documentModelType: ToolId.TOOL_RECT_SELECT,
        payload: {
          actionKind: "qmask"
        }
      }, {
        appEventType: EventType.historyGrouped,
        payload: {
          uf: "duplicate",
          actionDescriptor: {
            classID: "null",
            null: {
              t: "obj ",
              v: [{
                t: "prop",
                v: {
                  classID: "Chnl",
                  keyID: "fsel"
                }
              }]
            }
          }
        }
      }]
    };
  // Optionally surface a Free Transform row, inserted just before the trailing
  // "Save Selection" entry and mirrored into menuActions to keep them aligned.
  if (includeFreeTransformShortcut) {
    const freeTransformInsertIndex = selectMenu.items.length - 1;
    selectMenu.items.splice(freeTransformInsertIndex, 0, {
      name: "tools.freeTransform",
      shortcut: [altMod, ctrlMod, keyboard.KeyT]
    });
    selectMenu.menuActions.splice(freeTransformInsertIndex, 0, {
      appEventType: EventType.uiDispatch,
      documentModelType: ToolId.TOOL_FREE_TRANSFORM,
      payload: {
        dispatchKind: UiCommand.setActiveToolPanelMode
      }
    })
  }
  return selectMenu


}
