/**
 * File and Edit top-level menus for the application menu bar.
 */

import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { Locale } from "../../core/i18n/locale.js";
import { getRecentFiles } from "../../core/recent-files.js";
import { ToolId, EventChannel } from "../../document/model/tool-base.js";
import { Layer } from "../../document/model/layer.js";
import { AdjustFilterDialog } from "../dialogs/adjust-filter-dialog.js";
import { getFreeTransformMenuItems, getFreeTransformActions } from "../tool-options/free-transform-menu-data.js";
import { isMacOSHost } from "./native-menu-spec.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { PuppetWarpTool } from "../../document/transform/puppet-warp-tool.js";
import {
  menuWhenCanCopy,
  menuWhenCanCut,
  menuWhenCanPaste,
  menuWhenDocOpen
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

/** Save row enabled state and label based on local handle, smart-object parent, or custom IO. */
function resolveSaveRowState(currentDoc, appData) {
  const saveLabel = Locale.get("file.save") + (currentDoc == null ? "" : currentDoc.parentDocRef ? " (Smart Object)" : "");
  return {
    enabled: currentDoc != null,
    labelOverride: saveLabel
  };
}

/** File → Open Recent rows and parallel dispatch actions. */
function buildOpenRecentSubmenu() {
  const recentEntries = getRecentFiles();
  if (recentEntries.length === 0) {
    return {
      items: [{
        name: "file.recentEmpty",
        resolveRowState: function() {
          return { enabled: false };
        }
      }],
      actions: [{
        appEventType: EventType.uiDispatch,
        payload: { dispatchKind: UiCommand.openRecentFile, filePath: "" }
      }]
    };
  }
  const items = [];
  const actions = [];
  for (let entryIdx = 0; entryIdx < recentEntries.length; entryIdx++) {
    const entry = recentEntries[entryIdx];
    items.push({ name: entry.name });
    actions.push({
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.openRecentFile,
        filePath: entry.path,
        fileName: entry.name
      }
    });
  }
  return { items: items, actions: actions };
}

/**
 * Build the File menu.
 * @returns {{ name: string, items: Array, menuActions: Array }}
 */
export function buildFileMenu() {
  const mods = keyboardMods(),
    keyboard = mods.keyboard,
    ctrlMod = mods.ctrlMod,
    shiftMod = mods.shiftMod,
    altMod = mods.altMod;
  const openRecentSubmenu = buildOpenRecentSubmenu();
  // `items` and `menuActions` are parallel arrays, index-for-index (nested
  // `sub` arrays too): the row at position N dispatches the action at N.
  return {
    name: "topMenu.file",
    items: [
    // Create / open documents.
    {
      name: "clipboard.new",
      shortcut: [altMod, ctrlMod, keyboard.KeyN],
      title: "dialogs.newProject",
      opensDialog: true
    }, {
      name: "file.open",
      shortcut: [ctrlMod, keyboard.KeyO],
      opensDialog: true
    }, {
      name: "file.openPlace",
      opensDialog: true
    }, {
      name: "file.openFromURL",
      opensDialog: true
    }, {
      name: "file.openRecent",
      sub: openRecentSubmenu.items,
      separatorAfter: true
    }, {
      // Writing files: save over the origin, Save as (the document's own file,
      // any writable format), and the Export submenu, whose products never
      // become the document's file.
      name: "Save ...",
      shortcut: [ctrlMod, keyboard.KeyS],
      resolveRowState: resolveSaveRowState
    }, {
      name: "file.saveAs",
      shortcut: [shiftMod, ctrlMod, keyboard.KeyS],
      opensDialog: true,
      resolveRowState: menuWhenDocOpen
    }, {
      name: "file.export",
      separatorAfter: true,
      resolveRowState: menuWhenDocOpen,
      sub: [{
        name: "file.exportAs",
        shortcut: [altMod, shiftMod, ctrlMod, keyboard.KeyS],
        opensDialog: true,
        resolveRowState: menuWhenDocOpen
      }, {
        name: "file.exportLayers",
        opensDialog: true,
        resolveRowState: menuWhenDocOpen
      }, {
        name: "Export Color Lookup",
        opensDialog: true,
        resolveRowState: menuWhenDocOpen
      }]
    }, {
      name: "file.fileInfo",
      opensDialog: true,
      resolveRowState: menuWhenDocOpen
    }, {
      name: "file.print",
      shortcut: [ctrlMod, keyboard.KeyP],
      opensDialog: true,
      resolveRowState: menuWhenDocOpen,
      separatorAfter: true
    }, {
      name: "file.script",
      separatorAfter: !isMacOSHost()
    // Exit is a menu row only off macOS; on macOS quit lives in the app menu.
    }].concat(isMacOSHost() ? [] : [{
      name: "file.exit"
    }]),
    menuActions: [{
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "newproject"
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.pickLocalFiles,
        imagesOnly: true
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.pickLocalFiles,
        imagesOnly: true,
        openAsPlaced: true
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "open_from_url"
      }
    }, {
      sub: openRecentSubmenu.actions
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.saveOrCommitDocument
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "writefile",
        adoptsDocumentFile: true
      }
    }, {
      sub: [{
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.dispatchAppDialogRouter,
          dialogRouteId: "writefile"
        }
      }, {
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.dispatchAppDialogRouter,
          dialogRouteId: "eassets"
        }
      }, {
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.dispatchAppDialogRouter,
          dialogRouteId: "exlut"
        }
      }]
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "finfo"
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "print"
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "script"
      }
    }].concat(isMacOSHost() ? [] : [{
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.exitApplication
      }
    }])
  };
}

/**
 * Build the Edit menu.
 * @returns {{ name: string, items: Array, menuActions: Array }}
 */
export function buildEditMenu() {
  const mods = keyboardMods(),
    keyboard = mods.keyboard,
    ctrlMod = mods.ctrlMod,
    shiftMod = mods.shiftMod,
    altMod = mods.altMod;
  // `items` and `menuActions` are parallel arrays, index-for-index.
  return {
    name: "topMenu.edit",
    items: [
    // History navigation: undo/redo, step forward/back.
    {
      name: "edit.undoRedo",
      resolveRowState: menuWhenDocOpen
    }, {
      name: "edit.stepForward",
      shortcut: [shiftMod, ctrlMod, keyboard.KeyZ],
      resolveRowState: menuWhenDocOpen
    }, {
      name: "edit.stepBackward",
      shortcut: [ctrlMod, keyboard.KeyZ],
      separatorAfter: true,
      resolveRowState: menuWhenDocOpen
    }, {
      name: "edit.fade",
      shortcut: [shiftMod, ctrlMod, keyboard.KeyF],
      separatorAfter: true,
      opensDialog: true,
      resolveRowState: function(currentDoc, appData) {
        return {
          enabled: AdjustFilterDialog.canOpenFadeOnActiveLayers(currentDoc) && appData.activeToolId != ToolId.TOOL_FREE_TRANSFORM
        };
      }
    }, {
      // Clipboard: cut, copy, copy merged, paste, clear.
      name: "clipboard.cut",
      shortcut: [ctrlMod, keyboard.KeyX],
      resolveRowState: menuWhenCanCut
    }, {
      name: "clipboard.copy",
      shortcut: [ctrlMod, keyboard.KeyC],
      resolveRowState: menuWhenCanCopy
    }, {
      name: "clipboard.copyMerged",
      shortcut: [shiftMod, ctrlMod, keyboard.KeyC],
      resolveRowState: menuWhenCanCopy
    }, {
      name: "clipboard.paste",
      shortcut: [ctrlMod, keyboard.KeyV],
      resolveRowState: menuWhenCanPaste
    }, {
      name: "edit.clear",
      resolveRowState: function(currentDoc) {
        return {
          enabled: currentDoc != null && currentDoc.selectionMask != null
        }
      },
      shortcut: "Delete",
      separatorAfter: true
    }, {
      // Fill and stroke the selection / layer.
      name: "edit.fill",
      resolveRowState: function(currentDoc) {
        return {
          enabled: currentDoc != null
        }
      },
      opensDialog: true,
      shortcut: [shiftMod, keyboard.F5]
    }, {
      name: "layerEffects.stroke",
      resolveRowState: function(currentDoc) {
        return {
          enabled: currentDoc != null
        }
      },
      opensDialog: true,
      separatorAfter: true
    }, {
      // Transform / align: content-aware scale, puppet warp, free transform,
      // the transform submenu, and auto-align / auto-blend of layers.
      name: "tools.contentAwareScale",
      resolveRowState: function(currentDoc) {
        return {
          enabled: currentDoc != null && currentDoc.ensureLayerEditableForTools(false)
        }
      }
    }, {
      name: "tools.puppetWarp",
      resolveRowState: function(currentDoc) {
        return {
          enabled: PuppetWarpTool.canActivatePuppetWarp(currentDoc)
        };
      }
    }, {
      name: "tools.freeTransform",
      shortcut: [altMod, ctrlMod, keyboard.KeyT],
      resolveRowState: menuWhenDocOpen
    }, {
      name: "edit.transform",
      resolveRowState: menuWhenDocOpen,
      sub: getFreeTransformMenuItems()
    }, {
      name: "edit.autoAlign",
      resolveRowState: menuWhenDocOpen
    }, {
      name: "edit.autoBlend",
      separatorAfter: true,
      resolveRowState: menuWhenDocOpen
    }, {
      // Define reusable presets from the current document (pattern, brush,
      // custom shape), then preferences and the startup-resource manager.
      name: "properties.defineNew",
      sub: [{
        name: "properties.pattern",
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null
          }
        }
      }, {
        name: "panels.brush",
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null
          }
        }
      }, {
        name: "tools.customShape",
        resolveRowState: function(currentDoc) {
          return {
            enabled: currentDoc != null && currentDoc.getPaths()[1].length != 0
          };
        }
      }]
    }, {
      name: "properties.preferences",
      opensDialog: true,
      shortcut: [ctrlMod, keyboard.KeyK]
    }, {
      name: "file.resourceManager",
      opensDialog: true
    }],
    menuActions: [{
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_HISTORY,
      payload: {
        actionKind: "h_undoredo"
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_HISTORY,
      payload: {
        actionKind: "h_stepfwd"
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_HISTORY,
      payload: {
        actionKind: "h_stepbck"
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "afw_fade"
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.cutPathsOrClearSelection
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.clipboardCopyLayers
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.clipboardCopyLayers,
        copyMerged: true
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.clipboardPasteLayers
      }
    }, {
      appEventType: EventType.historyGrouped,
      payload: {
        uf: "delete"
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "fill"
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "stroke"
      }
    }, {
      appEventType: EventType.uiDispatch,
      documentModelType: ToolId.TOOL_CONTENT_AWARE_SCALE,
      payload: {
        dispatchKind: UiCommand.setActiveToolPanelMode
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_SMART_FILTER,
      payload: {
        actionKind: "start",
        operationId: "rigidTransform"
      }
    }, {
      appEventType: EventType.uiDispatch,
      documentModelType: ToolId.TOOL_FREE_TRANSFORM,
      payload: {
        dispatchKind: UiCommand.setActiveToolPanelMode
      }
    }, {
      sub: getFreeTransformActions()
    }, {
      appEventType: EventType.historyGrouped,
      payload: {
        uf: "align",
        actionDescriptor: {
          classID: "null",
          null: {
            t: "obj ",
            v: [{
              t: "Enmr",
              v: {
                classID: "Lyr",
                typeID: "Ordn",
                enum: "Trgt"
              }
            }]
          },
          Usng: {
            t: "enum",
            v: {
              ADSt: "ADSContent"
            }
          },
          alignToCanvas: {
            t: "bool",
            v: false
          },
          Aply: {
            t: "enum",
            v: {
              projection: "Auto"
            }
          },
          vignette: {
            t: "bool",
            v: false
          },
          radialDistort: {
            t: "bool",
            v: false
          }
        }
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.autoBlendLayers
      }
    }, {
      sub: [{
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.extractDocSelectionAsPreset,
          selectionExportKind: 0
        }
      }, {
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.extractDocSelectionAsPreset,
          selectionExportKind: 1
        }
      }, {
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.extractDocSelectionAsPreset,
          selectionExportKind: 2
        }
      }]
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "preferences"
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "resmgr"
      }
    }]
  };
}
