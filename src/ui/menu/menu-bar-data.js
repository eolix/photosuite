/**
 * Single source of truth for the application menu bar (HTML + macOS native).
 *
 * - `items` — labels, shortcuts, `resolveRowState`, submenus
 * - `menuActions` — parallel dispatch descriptors (`appEventType`, …)
 *
 * See `src/ui/menu/README.md`. Built by {@link createMenuBarData} so the Window menu
 * can read sidebar panels without importing ui.js.
 *
 * Menu builders live in sibling modules; this file only orchestrates the top-level order.
 */

import { buildSelectMenu } from "./menu-bar-select-menu.js";
import { buildFileMenu, buildEditMenu } from "./menu-bar-file-edit-menus.js";
import { buildImageMenu, buildLayerMenu } from "./menu-bar-image-layer-menus.js";
import {
  buildFilterMenu,
  buildViewMenu,
  buildWindowMenu,
  buildMoreMenu
} from "./menu-bar-filter-view-window-menus.js";

/**
 * Assemble the full menu bar: File, Edit, Image, Layer, Select, Filter, View, Window, More.
 * @param {function(): Array} getRightSidebarRows
 * @returns {Array<{ name: string, items: Array, menuActions: Array }>}
 */
export function createMenuBarData(getRightSidebarRows) {
  return [
    buildFileMenu(),
    buildEditMenu(),
    buildImageMenu(),
    buildLayerMenu(),
    buildSelectMenu(false),
    buildFilterMenu(),
    buildViewMenu(),
    buildWindowMenu(getRightSidebarRows),
    buildMoreMenu()
  ];
}
