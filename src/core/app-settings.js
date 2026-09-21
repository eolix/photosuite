/**
 * Tauri plugin-store persistence for application settings and editor prefs sync.
 */

import { Locale } from "./i18n/locale.js";
import { snapshotEditorParamsFromPrefs } from "./editor-persisted-params.js";

/** Persisted under app_data_dir; see tauri-plugin-store. */
export const APP_SETTINGS_FILE = "settings.json";

const SETTINGS_VERSION = 1;

/** @type {Promise<import("@tauri-apps/plugin-store").Store> | null} */
let settingsStorePromise = null;

function getTauriStoreApi() {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  return tauri && tauri.store ? tauri.store : null;
}

async function openSettingsStore() {

  const storeApi = getTauriStoreApi();
  if (!storeApi || typeof storeApi.load !== "function") return null;

  if (!settingsStorePromise) {
    settingsStorePromise = storeApi.load(APP_SETTINGS_FILE, {
      autoSave: 100,
    });
  }

  return settingsStorePromise;
}

/** Copy store keys into the launch `environment` object shape when present. */
async function readEnvironmentFieldsFromStore(store) {
  const state = {};
  const lang = await store.get("lang");
  const theme = await store.get("theme");
  const panels = await store.get("panels");
  const eparams = await store.get("eparams");

  if (lang != null) state.lang = lang;
  if (theme != null) state.theme = theme;
  if (panels != null) state.panels = panels;
  if (eparams != null) state.eparams = eparams;

  return Object.keys(state).length !== 0 ? state : null;
}

/**
 * Reads disk settings and returns a plain object for
 * {@link AppController.prototype.applyPersistedAppState}.
 * Keys match the launch `environment` payload (`lang`, `theme`, `panels`, `eparams`, …).
 */
export async function loadPersistedAppStateFromStore() {
  const store = await openSettingsStore();
  if (!store) return null;
  return readEnvironmentFieldsFromStore(store);
}

/** Snapshot editor prefs from the live controller into `eparams` for persistence. */
function buildEditorParamsSnapshot(prefs) {
  return snapshotEditorParamsFromPrefs(prefs);
}

/**
 * Snapshots user-facing prefs from the live controller into the store file.
 * Does not write `filesystem` — the Rust open dialog owns `lastOpenDirectory`.
 */
export async function persistAppSettings(appController) {

  const store = await openSettingsStore();
  if (!store) return;

  const appData = appController.appData;
  if (!appData || !appData.prefs) return;

  await store.set("version", SETTINGS_VERSION);
  await store.set("lang", Locale.getCurrentLanguageCode());
  await store.set("theme", appData.theme);
  await store.set("panels", appData.effectRows.slice());
  await store.set("eparams", buildEditorParamsSnapshot(appData.prefs));
  await store.save();
}

/**
 * Loads store settings into the controller, then continues startup.
 * URL / query-string launch config still wins when present (applied afterward).
 */
export async function applyStoredSettingsOnStartup(appController) {

  try {
    const storedState = await loadPersistedAppStateFromStore();
    if (storedState) appController.applyPersistedAppState(storedState);
  } catch (err) {
    console.warn("PhotoSuite: failed to load app settings", err);
  }
}
