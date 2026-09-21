/**
 * Serialize {@link MenuBar.data} for `photosuite_install_native_menu`.
 * Labels, enabled state, and paths match the HTML menu. See `src/ui/menu/README.md`.
 */

import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { Locale } from "../../core/i18n/locale.js";

const ACCEL_CMD_OR_CTRL = "CmdOrCtrl";

/** Maps {@link KeyboardHandler} modifier tokens to Tauri accelerator segments. */
const MODIFIER_ACCELERATOR_PARTS = new Map([
  [KeyboardHandler.Ctrl, ACCEL_CMD_OR_CTRL],
  [KeyboardHandler.CtrlOrAlt, ACCEL_CMD_OR_CTRL],
  [KeyboardHandler.Shift, "Shift"],
  [KeyboardHandler.Alt, "Alt"],
  [KeyboardHandler.Plus, "Plus"],
  [KeyboardHandler.Minus, "Minus"],
  [KeyboardHandler.Digit0, "Digit0"],
  [KeyboardHandler.Digit1, "Digit1"],
]);

/** Maps printable shortcut labels to Tauri key segments. */
const LETTER_ACCELERATOR_PARTS = {
  "+": "Plus",
  "-": "Minus",
  " ": "Space",
  "F5": "F5",
  "F6": "F6",
};

/**
 * @param {string|Array<string>} nameKey
 * @param {object} itemDescriptor
 * @param {*} doc
 * @param {*} appData
 * @param {number} rowIndex
 */
function resolveMenuItemLabel(nameKey, itemDescriptor, doc, appData, rowIndex) {
  let label = resolveLabelFromNameKey(nameKey);
  if (itemDescriptor.resolveRowState) {
    const state = itemDescriptor.resolveRowState(doc, appData, rowIndex);
    if (state.labelOverride != null && state.labelOverride !== "") {
      label = state.labelOverride;
    }
  }
  if (itemDescriptor.opensDialog) label += "...";
  return formatNativeMenuLabel(label);
}

/** macOS treats `&` as a keyboard mnemonic; double it for a literal ampersand in labels. */
function formatNativeMenuLabel(label) {
  return label.replace(/&/g, "&&");
}

/**
 * @param {string|Array<string>} nameKey
 * @returns {string}
 */
function resolveLabelFromNameKey(nameKey) {
  if (Array.isArray(nameKey)) {
    const composite = Locale.get(nameKey);
    if (composite != null && composite !== "") return composite;
    return nameKey.map(function(keyPart) {
      return Locale.get(keyPart) || keyPart;
    }).join(" ");
  }
  const resolved = Locale.get(nameKey);
  if (resolved != null && resolved !== "") return resolved;
  return typeof nameKey === "string" ? nameKey : "";
}

/**
 * Same rules as {@link InputHandler} `update`: `resolveRowState` may return `{ enabled: boolean }`.
 * When `resolveRowState` is absent, the item stays enabled (see `src/ui/menu/README.md`).
 */
function resolveMenuItemEnabled(itemDescriptor, doc, appData, rowIndex) {
  if (!itemDescriptor.resolveRowState) return true;
  const state = itemDescriptor.resolveRowState(doc, appData, rowIndex);
  if (state == null || state.enabled == null) return true;
  return !!state.enabled;
}

/**
 * @returns {boolean|null} `null` when the row is not a checkable item.
 */
function resolveMenuItemChecked(itemDescriptor, doc, appData, rowIndex) {
  if (!itemDescriptor.resolveRowState) return null;
  const state = itemDescriptor.resolveRowState(doc, appData, rowIndex);
  if (state == null || state.checked == null) return null;
  return !!state.checked;
}

/**
 * @param {string|Array|object} shortcutKeys
 * @returns {string|null} Tauri accelerator string (e.g. `CmdOrCtrl+Shift+Z`)
 */
export function shortcutKeysToTauriAccelerator(shortcutKeys) {
  if (shortcutKeys == null) return null;
  if (typeof shortcutKeys === "string") return shortcutKeys;
  if (!Array.isArray(shortcutKeys)) return null;
  const parts = [];
  for (let i = 0; i < shortcutKeys.length; i++) {
    const segment = mapShortcutKeyToAcceleratorPart(shortcutKeys[i]);
    if (segment) parts.push(segment);
  }
  return parts.length ? parts.join("+") : null;
}

/**
 * @param {*} shortcutKey
 * @returns {string|null}
 */
function mapShortcutKeyToAcceleratorPart(shortcutKey) {
  if (shortcutKey == null) return null;
  if (MODIFIER_ACCELERATOR_PARTS.has(shortcutKey)) {
    return MODIFIER_ACCELERATOR_PARTS.get(shortcutKey);
  }
  if (shortcutKey.label) {
    const letter = shortcutKey.label;
    if (letter.length === 1 && /[a-zA-Z]/.test(letter)) {
      return "Key" + letter.toUpperCase();
    }
    if (LETTER_ACCELERATOR_PARTS[letter] != null) {
      return LETTER_ACCELERATOR_PARTS[letter];
    }
  }
  return null;
}

/**
 * Walk parallel `items` / `menuActions` trees (same indexing as {@link InputHandler}).
 *
 * @param {Array<object>|null} itemDescriptors
 * @param {Array<object>|null} actionDescriptors
 * @param {number[]} pathPrefix
 * @param {*} doc
 * @param {*} appData
 * @returns {Array<{ label: string, path?: number[], submenu?: object[], accelerator?: string, separatorAfter?: boolean, enabled?: boolean, checked?: boolean }>}
 */
function buildNativeMenuItemsFromLevel(itemDescriptors, actionDescriptors, pathPrefix, doc, appData) {
  const entries = [];
  if (!itemDescriptors) return entries;
  for (let rowIndex = 0; rowIndex < itemDescriptors.length; rowIndex++) {
    const itemDescriptor = itemDescriptors[rowIndex];
    const actionDescriptor = actionDescriptors ? actionDescriptors[rowIndex] : null;
    const entry = createNativeMenuEntry(itemDescriptor, doc, appData, rowIndex);
    attachNativeMenuEntryDispatch(entry, itemDescriptor, actionDescriptor, pathPrefix, rowIndex, doc, appData);
    const accelerator = shortcutKeysToTauriAccelerator(itemDescriptor.shortcut);
    if (accelerator) entry.accelerator = accelerator;
    // The rule follows the row that carries the flag, matching how the in-window
    // menu draws it.
    if (itemDescriptor.separatorAfter) entry.separatorAfter = true;
    entries.push(entry);
  }
  return entries;
}

/**
 * @param {object} itemDescriptor
 * @param {*} doc
 * @param {*} appData
 * @param {number} rowIndex
 */
function createNativeMenuEntry(itemDescriptor, doc, appData, rowIndex) {
  const entry = {
    label: resolveMenuItemLabel(itemDescriptor.name, itemDescriptor, doc, appData, rowIndex),
    enabled: resolveMenuItemEnabled(itemDescriptor, doc, appData, rowIndex)
  };
  const checked = resolveMenuItemChecked(itemDescriptor, doc, appData, rowIndex);
  if (checked != null) entry.checked = checked;
  return entry;
}

/**
 * @param {object} entry
 * @param {object} itemDescriptor
 * @param {object|null} actionDescriptor
 * @param {number[]} pathPrefix
 * @param {number} rowIndex
 * @param {*} doc
 * @param {*} appData
 */
function attachNativeMenuEntryDispatch(entry, itemDescriptor, actionDescriptor, pathPrefix, rowIndex, doc, appData) {
  const childPath = pathPrefix.concat([rowIndex]);
  const itemSub = itemDescriptor.sub;
  const actionSub = actionDescriptor && actionDescriptor.sub;
  if (itemSub && actionSub) {
    entry.submenu = buildNativeMenuItemsFromLevel(itemSub, actionSub, childPath, doc, appData);
    return;
  }
  if (actionDescriptor && actionDescriptor.appEventType) {
    entry.path = childPath;
    return;
  }
  if (actionSub && !itemSub) {
    entry.submenu = buildNativeMenuItemsFromLevel(null, actionSub, childPath, doc, appData);
  }
}

/**
 * True when running on macOS (Tauri webview or browser).
 * Reads navigator.userAgentData.platform when present, else navigator.platform.
 */
export function isMacOSHost() {
  if (typeof navigator === "undefined") return false;
  return platformStringLooksLikeMac(readHostPlatformString());
}

function readHostPlatformString() {
  if (navigator.userAgentData && navigator.userAgentData.platform) {
    return navigator.userAgentData.platform;
  }
  return navigator.platform || "";
}

function platformStringLooksLikeMac(platform) {
  return /mac/i.test(platform);
}

/**
 * @param {Array<{ name: string, items: object[], menuActions: object[] }>} menuData
 * @param {*} [doc]
 * @param {*} [appData]
 */
export function buildNativeMenuSpec(menuData, doc, appData) {
  const menus = [];
  for (let topIndex = 0; topIndex < menuData.length; topIndex++) {
    const topMenu = menuData[topIndex];
    menus.push({
      title: formatNativeMenuLabel(Locale.get(topMenu.name) || topMenu.name),
      items: buildNativeMenuItemsFromLevel(topMenu.items, topMenu.menuActions, [topIndex], doc, appData)
    });
  }
  return {
    menus: menus,
    hideHtmlMenuBar: isMacOSHost()
  };
}
