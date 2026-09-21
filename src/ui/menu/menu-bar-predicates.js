/**
 * Shared `resolveRowState(doc, appData, rowIndex)` helpers for menu bar rows.
 *
 * Return shape: `{ enabled?: boolean, labelOverride?: string, checked?: boolean }`.
 * Rows without `resolveRowState` are always enabled.
 */

import { Locale } from "../../core/i18n/locale.js";
import { ToolId } from "../../document/model/tool-base.js";
import { canWriteClipboard } from "../../core/tauri-host.js";

/** Document is open. */
export function menuWhenDocOpen(doc) {
  return { enabled: doc != null };
}

/** Document open and at least one layer index selected. */
export function menuWhenHasLayerSelection(doc) {
  return { enabled: doc != null && doc.selectedLayerIndices.length !== 0 };
}

/** Document open with an editable target layer for tool operations. */
export function menuWhenEditableLayer(doc) {
  return { enabled: doc != null && doc.ensureLayerEditableForTools(false) };
}

/** Document open with an active pixel or vector selection mask. */
export function menuWhenHasSelection(doc) {
  return { enabled: doc != null && doc.selectionMask != null };
}

/** Copy / copy merged — document must be open. */
export function menuWhenCanCopy(doc) {
  return menuWhenDocOpen(doc);
}

/** Cut — same gates as a successful copy (pixels, paths, text, or layer content). */
export function menuWhenCanCut(doc, appData) {
  return { enabled: canCutFromDocument(doc, appData) };
}

/** Paste — system clipboard or internal buffers. */
export function menuWhenCanPaste(doc, appData) {
  return { enabled: hasPasteableClipboard(appData) };
}

/**
 * Whether a sidebar panel is open in the workspace (`appData.effectRows`).
 *
 * Window menu: clicking a checked row only focuses the panel ({@link RightSidebar#attachPanelByPanelId});
 * it does not remove the row. The checkmark clears only when the user closes the panel
 * from its tab context menu / close control ({@link BaseTool#closePanel} → `PopupTypes.FONTS` del).
 */

/** Canonical id for `effectRows` (numeric slots as numbers; plugin ids unchanged). */
export function normalizePanelId(panelId) {
  const numericId = parseFloat(panelId);
  return isNaN(numericId) ? panelId : numericId;
}

export function findPanelInEffectRowsIndex(panelId, effectRows) {
  if (effectRows == null) return -1;
  const targetId = normalizePanelId(panelId);
  for (let i = 0; i < effectRows.length; i++) {
    if (effectRows[i] == targetId) return i;
  }
  return -1;
}

export function removePanelFromEffectRows(panelId, appData) {
  if (appData == null || appData.effectRows == null) return false;
  const idx = findPanelInEffectRowsIndex(panelId, appData.effectRows);
  if (idx === -1) return false;
  appData.effectRows.splice(idx, 1);
  return true;
}

export function isPanelInEffectRows(panelId, appData) {
  if (appData == null || appData.effectRows == null) return false;
  return findPanelInEffectRowsIndex(panelId, appData.effectRows) !== -1;
}

/** Window menu checkmark — panel is open, not merely focused. */
export function menuWhenPanelVisible(panelId) {
  return function(doc, appData) {
    return { checked: isPanelInEffectRows(panelId, appData) };
  };
}

/** More → Language: exactly one row checked (radio-style). */
export function menuWhenLocaleSelected(localeCode) {
  return function(doc, appData) {
    return { checked: localeCode === Locale.getCurrentLanguageCode() };
  };
}

/** More → Theme: exactly one row checked (radio-style). */
export function menuWhenThemeSelected(themeIndex) {
  return function(doc, appData) {
    const activeIndex = appData == null ? 0 : appData.theme;
    return { checked: activeIndex === themeIndex };
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function canCutFromDocument(doc, appData) {
  if (doc == null || doc.selectedLayerIndices.length === 0) return false;
  if (isActiveTextLayerCuttable(doc, appData)) return true;
  if (doc.selectionMask != null) return true;
  if (doc.selectedLayerIndices.length > 1) return true;
  if (hasPathSelection(doc)) return true;
  return hasLayerPixelContent(doc.layers[doc.selectedLayerIndices[0]]);
}

function isActiveTextLayerCuttable(doc, appData) {
  if (appData == null || appData.activeToolId !== ToolId.TOOL_TYPE) return false;
  const textLayer = doc.layers[doc.selectedLayerIndices[0]];
  return textLayer != null && textLayer.add.TySh != null;
}

function hasPathSelection(doc) {
  const paths = doc.getPaths();
  return paths[1].length !== 0;
}

function hasLayerPixelContent(layer) {
  return layer != null && (layer.pixelContent > 0 || layer.buffer != null);
}

function hasPasteableClipboard(appData) {
  if (appData == null) return canWriteClipboard();
  return canWriteClipboard()
    || appData.clipboardPixelPayload != null
    || appData.pathClipboard != null
    || appData.lastClipboardTextImportUrl != null;
}
