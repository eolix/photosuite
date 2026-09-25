/**
 * Filter, View, Window, and More top-level menus for the application menu bar.
 */

import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { Locale } from "../../core/i18n/locale.js";
import { ToolId, EventChannel } from "../../document/model/tool-base.js";
import { FilterDefs } from "../../features/filters/filter-apply.js";
import { PopupTypes } from "../config/popup-types.js";
import { ThemeConfig } from "../config/theme-config.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import {
  menuWhenDocOpen,
  menuWhenPanelVisible,
  menuWhenLocaleSelected,
  menuWhenThemeSelected
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

/** Append FilterDefs groups (single filters and nested group submenus). */
function appendFilterMenuGroups(filterMenu) {
  for (let groupIdx = 0; groupIdx < FilterDefs.filterMenuGroups.length; groupIdx++) {
    const menuGroup = FilterDefs.filterMenuGroups[groupIdx];
    if (menuGroup.filterClassId != null) {
      filterMenu.items.push({
        name: FilterDefs.names[menuGroup.filterClassId],
        opensDialog: true,
        separatorAfter: menuGroup.separatorAfter,
        resolveRowState: menuWhenDocOpen
      });
      filterMenu.menuActions.push({
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_SMART_FILTER,
        payload: {
          actionKind: "start",
          operationId: menuGroup.filterClassId
        }
      });
      continue;
    }
    const submenuItem = {
      name: menuGroup.groupLabelKey,
      resolveRowState: menuWhenDocOpen,
      sub: []
    };
    filterMenu.items.push(submenuItem);
    const submenuActions = {
      sub: []
    };
    filterMenu.menuActions.push(submenuActions);
    for (let filterIdx = 0; filterIdx < menuGroup.filterIds.length; filterIdx++) {
      submenuItem.sub.push({
        name: FilterDefs.names[menuGroup.filterIds[filterIdx]],
        opensDialog: FilterDefs.create(menuGroup.filterIds[filterIdx]) != null,
        resolveRowState: menuWhenDocOpen
      });
      submenuActions.sub.push({
        appEventType: EventType.documentAction,
        documentModelType: EventChannel.EVENT_SMART_FILTER,
        payload: {
          actionKind: "start",
          operationId: menuGroup.filterIds[filterIdx]
        }
      });
    }
  }
}

/**
 * Build the Filter menu (last-filter + FilterDefs groups).
 * @returns {{ name: string, items: Array, menuActions: Array }}
 */
export function buildFilterMenu() {
  const mods = keyboardMods(),
    keyboard = mods.keyboard,
    ctrlMod = mods.ctrlMod,
    altMod = mods.altMod;
  const filterMenu = {
    name: "topMenu.filter",
    items: [{
      name: "filters.menu.lastFilter",
      shortcut: [altMod, ctrlMod, keyboard.KeyF],
      separatorAfter: true,
      resolveRowState: menuWhenDocOpen
    }],
    menuActions: [{
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_SMART_FILTER,
      payload: {
        actionKind: "applylast"
      }
    }]
  };
  appendFilterMenuGroups(filterMenu);
  return filterMenu;
}

/**
 * Build the View menu.
 * @returns {{ name: string, items: Array, menuActions: Array }}
 */
export function buildViewMenu() {
  const mods = keyboardMods(),
    keyboard = mods.keyboard,
    ctrlMod = mods.ctrlMod;
  // `items` and `menuActions` are parallel arrays, index-for-index.
  return {
    name: "topMenu.view",
    items: [
    // Zoom and fit.
    {
      name: "view.zoomIn",
      shortcut: [ctrlMod, keyboard.Plus]
    }, {
      name: "view.zoomOut",
      shortcut: [ctrlMod, keyboard.Minus]
    }, {
      name: "align.fitTheArea",
      shortcut: [ctrlMod, keyboard.Digit0]
    }, {
      name: "align.pixelToPixel",
      shortcut: [ctrlMod, keyboard.Digit1],
      separatorAfter: true
    }, {
      // Extras master toggle, and the Show submenu of overlay toggles
      // (selection edges, paths, guides, grid, pixel grid, slices). The Show
      // rows are enabled only while Extras is on.
      name: "Extras",
      shortcut: [ctrlMod, keyboard.KeyH],
      resolveRowState: function(currentDoc, appData) {
        return {
          checked: appData.extras
        };
      }
    }, {
      name: "view.show",
      separatorAfter: true,
      sub: [{
        name: "sampleScope.selection",
        resolveRowState: function(currentDoc, appData) {
          return {
            enabled: appData.extras,
            checked: appData.prefs.showSelectionEdges
          };
        }
      }, {
        name: "view.paths",
        resolveRowState: function(currentDoc, appData) {
          return {
            enabled: appData.extras,
            checked: appData.prefs.paths
          };
        }
      }, {
        name: "view.guides",
        resolveRowState: function(currentDoc, appData) {
          return {
            enabled: appData.extras,
            checked: appData.prefs.guides
          };
        },
        shortcut: [ctrlMod, keyboard.Semicolon]
      }, {
        name: "view.grid",
        resolveRowState: function(currentDoc, appData) {
          return {
            enabled: appData.extras,
            checked: appData.prefs.showGrid
          };
        },
        shortcut: [ctrlMod, keyboard.Quote]
      }, {
        name: "view.pixelGrid",
        resolveRowState: function(currentDoc, appData) {
          return {
            enabled: appData.extras,
            checked: appData.prefs.showPixelGrid
          };
        }
      }, {
        name: "view.slices",
        resolveRowState: function(currentDoc, appData) {
          return {
            enabled: appData.extras,
            checked: appData.prefs.slices
          };
        }
      }]
    }, {
      // Rulers, then snapping (master toggle + per-target Snap To submenu).
      name: "view.rulers",
      resolveRowState: function(currentDoc, appData) {
        return {
          checked: appData.rulers
        };
      },
      shortcut: [ctrlMod, keyboard.KeyR],
      separatorAfter: true
    }, {
      name: "view.snap",
      resolveRowState: function(currentDoc, appData) {
        return {
          checked: appData.snapEnabled
        }
      }
    }, {
      name: "view.snapTo",
      separatorAfter: true,
      sub: [{
        name: "view.guides",
        resolveRowState: function(currentDoc, appData) {
          return {
            checked: appData.showToggles[0]
          }
        }
      }, {
        name: "view.grid",
        resolveRowState: function(currentDoc, appData) {
          return {
            checked: appData.showToggles[1]
          }
        }
      }, {
        name: "panels.layers",
        resolveRowState: function(currentDoc, appData) {
          return {
            checked: appData.showToggles[2]
          }
        }
      }, {
        name: "view.slices",
        resolveRowState: function(currentDoc, appData) {
          return {
            checked: appData.showToggles[3]
          }
        }
      }, {
        name: "view.documentBounds",
        resolveRowState: function(currentDoc, appData) {
          return {
            checked: appData.showToggles[4]
          }
        }
      }]
    }, {
      // Guides: clear all, add via dialog, generate from the selected layer.
      name: "dialogs.clearGuides",
      resolveRowState: function(currentDoc, appData) {
        return {
          enabled: currentDoc != null
        }
      }
    }, {
      name: "dialogs.addGuides",
      resolveRowState: function(currentDoc, appData) {
        return {
          enabled: currentDoc != null
        }
      },
      opensDialog: true
    }, {
      name: "dialogs.guidesFromLayer",
      resolveRowState: function(currentDoc, appData) {
        return {
          enabled: currentDoc != null && currentDoc.selectedLayerIndices.length != 0
        }
      }
    }],
    menuActions: [{
      appEventType: EventType.documentAction,
      documentModelType: ToolId.TOOL_ZOOM,
      payload: {
        actionKind: "zoom",
        zoomInOnGesture: true
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: ToolId.TOOL_ZOOM,
      payload: {
        actionKind: "zoom",
        zoomInOnGesture: false
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: ToolId.TOOL_ZOOM,
      payload: {
        actionKind: "adapt",
        adaptTarget: "fitscr"
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: ToolId.TOOL_ZOOM,
      payload: {
        actionKind: "adapt",
        adaptTarget: "pixel"
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.openResourcePresetPopup,
        popupType: PopupTypes.TOGGLE_EXTRAS
      }
    }, {
      sub: [{
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.openResourcePresetPopup,
          popupType: PopupTypes.OPEN_FILE
        }
      }, {
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.openResourcePresetPopup,
          popupType: PopupTypes.CANVAS_SIZE
        }
      }, {
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.openResourcePresetPopup,
          popupType: PopupTypes.KEYBOARD_SHORTCUTS
        }
      }, {
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.openResourcePresetPopup,
          popupType: PopupTypes.PLUGINS
        }
      }, {
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.openResourcePresetPopup,
          popupType: PopupTypes.IMAGE_SIZE
        }
      }, {
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.openResourcePresetPopup,
          popupType: PopupTypes.ROTATE_CANVAS
        }
      }]
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.openResourcePresetPopup,
        popupType: PopupTypes.TOGGLE_RULERS
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.openResourcePresetPopup,
        popupType: PopupTypes.SAVE_AS
      }
    }, {
      sub: [{
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.openResourcePresetPopup,
          popupType: PopupTypes.NEW_DOCUMENT,
          showToggleIndex: 0
        }
      }, {
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.openResourcePresetPopup,
          popupType: PopupTypes.NEW_DOCUMENT,
          showToggleIndex: 1
        }
      }, {
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.openResourcePresetPopup,
          popupType: PopupTypes.NEW_DOCUMENT,
          showToggleIndex: 2
        }
      }, {
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.openResourcePresetPopup,
          popupType: PopupTypes.NEW_DOCUMENT,
          showToggleIndex: 3
        }
      }, {
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.openResourcePresetPopup,
          popupType: PopupTypes.NEW_DOCUMENT,
          showToggleIndex: 4
        }
      }]
    }, {
      appEventType: EventType.documentAction,
      documentModelType: ToolId.TOOL_MOVE,
      payload: {
        actionKind: "gids",
        guidesAfter: [
          [],
          []
        ]
      }
    }, {
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "addguides"
      }
    }, {
      appEventType: EventType.documentAction,
      documentModelType: ToolId.TOOL_MOVE,
      payload: {
        actionKind: "gidsFromLayer"
      }
    }]
  };
}

/**
 * Build the Window menu from right-sidebar panel rows.
 * @param {function(): Array} getRightSidebarRows
 * @returns {{ name: string, items: Array, menuActions: Array }}
 */
export function buildWindowMenu(getRightSidebarRows) {
    const windowMenu = {
      name: "topMenu.window",
      items: [{
        name: "topMenu.more",
        separatorAfter: true,
        sub: []
      }],
      menuActions: [{
        sub: []
      }]
    };
    // One row per registered sidebar panel. Rows flagged windowMoreMenuOnly go
    // into the leading "More" submenu (items[0]); the rest sit at top level.
    // A checked row means the panel is currently open (menuWhenPanelVisible).
    for (let panelRowIdx = 0; panelRowIdx < getRightSidebarRows().length; panelRowIdx++) {
      const panelRow = getRightSidebarRows()[panelRowIdx];
      const panelId = panelRow.panel.panelId;
      (panelRow.windowMoreMenuOnly ? windowMenu.items[0].sub : windowMenu.items).push({
        name: panelRow.panel.name,
        resolveRowState: menuWhenPanelVisible(panelId)
      });
      (panelRow.windowMoreMenuOnly ? windowMenu.menuActions[0].sub : windowMenu.menuActions).push({
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.registerFontFaceFromUrlParam,
          dialogRouteId: panelRow.panel.panelId
        }
      })
    }
    return windowMenu
}

/**
 * Build the More menu (language, theme, shortcuts, WebGL).
 * @returns {{ name: string, items: Array, menuActions: Array }}
 */
export function buildMoreMenu() {
    const moreMenu = {
        name: "topMenu.more",
        items: [],
        menuActions: []
      },
      languageSubmenu = {
        name: "topMenu.language",
        sub: []
      };
    moreMenu.items.push(languageSubmenu);
    const languageActions = {
      sub: []
    };
    moreMenu.menuActions.push(languageActions);
    const sortedLanguages = Locale.getSortedLanguages();
    for (let langIdx = 0; langIdx < sortedLanguages.length; langIdx++) {
      const langEntry = sortedLanguages[langIdx],
        langCode = langEntry.code,
        langTableIndex = Locale.findLanguageIndex(langCode);
      languageSubmenu.sub.push({
        name: langEntry.name,
        shortcut: langCode,
        resolveRowState: menuWhenLocaleSelected(langCode)
      });
      languageActions.sub.push({
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.openResourcePresetPopup,
          popupType: PopupTypes.CHANGE_LANGUAGE,
          lang: langTableIndex
        }
      })
    }
    languageSubmenu.sub.push({
      name: "topMenu.createTranslation"
    });
    languageActions.sub.push({
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.openTranslateLink,
        link: "https://github.com/eolix/photosuite"
      }
    });
    const themeSubmenu = {
      name: "topMenu.theme",
      sub: []
    };
    moreMenu.items.push(themeSubmenu);
    const themeActions = {
      sub: []
    };
    moreMenu.menuActions.push(themeActions);
    for (let themeIdx = 0; themeIdx < ThemeConfig.themes.length; themeIdx++) {
      themeSubmenu.sub.push({
        name: ThemeConfig.themes[themeIdx].name,
        resolveRowState: menuWhenThemeSelected(themeIdx)
      });
      themeActions.sub.push({
        appEventType: EventType.uiDispatch,
        payload: {
          dispatchKind: UiCommand.openResourcePresetPopup,
          popupType: PopupTypes.CHANGE_THEME,
          theme: themeIdx
        }
      })
    }
    moreMenu.items.push({
      name: "dialogs.keyboardShortcuts"
    });
    moreMenu.menuActions.push({
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "shortcuts"
      }
    });
    moreMenu.items.push({
      name: "dialogs.licences"
    });
    moreMenu.menuActions.push({
      appEventType: EventType.uiDispatch,
      payload: {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "licenses"
      }
    });
    return moreMenu
}
