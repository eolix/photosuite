/**
 * Recently used blank-document settings from the New Project dialog (max five).
 * Separate from {@link ../recent-files.js} open-document history on the home screen.
 */

import { APP_SETTINGS_FILE } from "./app-settings.js";

export const MAX_RECENT_DOCUMENT_PRESETS = 5;

/** @type {Promise<import("@tauri-apps/plugin-store").Store>|null} */
let settingsStorePromise = null;

/** @type {Array<object>} */
let recentDocumentPresetsCache = [];

function getTauriStoreApi() {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  return tauri && tauri.store ? tauri.store : null;
}

async function openSettingsStore() {
  const storeApi = getTauriStoreApi();
  if (!storeApi || typeof storeApi.load !== "function") return null;
  if (!settingsStorePromise) {
    settingsStorePromise = storeApi.load(APP_SETTINGS_FILE, { autoSave: 100 });
  }
  return settingsStorePromise;
}

/**
 * @param {*} stored
 * @returns {Array<object>}
 */
export function normalizeRecentDocumentPresets(stored) {
  if (!Array.isArray(stored)) return [];
  const normalized = [];
  for (let entryIdx = 0; entryIdx < stored.length; entryIdx++) {
    const row = stored[entryIdx];
    if (row == null || typeof row.width !== "number" || typeof row.height !== "number") continue;
    if (row.width <= 0 || row.height <= 0) continue;
    normalized.push({
      name: typeof row.name === "string" && row.name !== "" ? row.name : "Untitled",
      width: Math.max(1, Math.round(row.width)),
      height: Math.max(1, Math.round(row.height)),
      dpi: typeof row.dpi === "number" && row.dpi > 0 ? row.dpi : 72,
      unitIndex: typeof row.unitIndex === "number" ? row.unitIndex : 0,
      unit: typeof row.unit === "string" ? row.unit : "px",
      unitWidth: typeof row.unitWidth === "number" ? row.unitWidth : row.width,
      unitHeight: typeof row.unitHeight === "number" ? row.unitHeight : row.height,
      backgroundFillIndex: typeof row.backgroundFillIndex === "number" ? row.backgroundFillIndex : 0,
      backgroundColorPacked:
        typeof row.backgroundColorPacked === "number" ? row.backgroundColorPacked : null,
      label: typeof row.label === "string" ? row.label : null,
      usedAt: typeof row.usedAt === "number" ? row.usedAt : 0
    });
    if (normalized.length >= MAX_RECENT_DOCUMENT_PRESETS) break;
  }
  return normalized;
}

/** @returns {Array<object>} */
export function getRecentDocumentPresets() {
  return recentDocumentPresetsCache.slice();
}

export async function loadRecentDocumentPresetsFromStore() {
  recentDocumentPresetsCache = [];
  const store = await openSettingsStore();
  if (!store) return;
  try {
    recentDocumentPresetsCache = normalizeRecentDocumentPresets(await store.get("recentDocumentPresets"));
  } catch (err) {
    console.warn("PhotoSuite: failed to load recent document presets", err);
    recentDocumentPresetsCache = [];
  }
}

async function persistRecentDocumentPresetsCache() {
  const store = await openSettingsStore();
  if (!store) return;
  await store.set("recentDocumentPresets", recentDocumentPresetsCache.slice());
  await store.save();
}

/**
 * Move one blank-document configuration to the front of the recent list.
 * @param {object} snapshot
 */
export async function recordRecentDocumentPreset(snapshot) {
  if (snapshot == null || typeof snapshot.width !== "number" || typeof snapshot.height !== "number") {
    return;
  }
  const nextRow = normalizeRecentDocumentPresets([snapshot])[0];
  if (!nextRow) return;

  const deduped = [];
  for (let entryIdx = 0; entryIdx < recentDocumentPresetsCache.length; entryIdx++) {
    const cached = recentDocumentPresetsCache[entryIdx];
    if (
      cached.name === nextRow.name &&
      cached.width === nextRow.width &&
      cached.height === nextRow.height &&
      cached.dpi === nextRow.dpi &&
      cached.backgroundFillIndex === nextRow.backgroundFillIndex &&
      cached.backgroundColorPacked === nextRow.backgroundColorPacked
    ) {
      continue;
    }
    deduped.push(cached);
  }
  recentDocumentPresetsCache = [nextRow].concat(deduped).slice(0, MAX_RECENT_DOCUMENT_PRESETS);
  try {
    await persistRecentDocumentPresetsCache();
  } catch (err) {
    console.warn("PhotoSuite: failed to persist recent document presets", err);
  }
}

/**
 * Build a preset-row tuple for thumbnail rendering.
 * @param {object} snapshot
 * @returns {Array}
 */
export function recentDocumentPresetToPresetRow(snapshot) {
  return [
    snapshot.label || snapshot.name,
    snapshot.unitWidth,
    snapshot.unitHeight,
    snapshot.unit,
    snapshot.dpi
  ];
}
