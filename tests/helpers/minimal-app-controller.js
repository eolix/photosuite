/**
 * Minimal AppController-shaped fixture for contract tests.
 * Matches the object graph callers pass into persistence helpers.
 */

/** @returns {import("../../src/ui/shell/app-controller.js")} */
export function makeMinimalAppController(overrides = {}) {
  const defaultPrefs = {
    guides: true,
    showGrid: false,
    gridSize: 20,
    gridUnits: 1,
    gridType: 0,
    AppWindow: 0,
    showSelectionEdges: true,
    paths: true,
    showPixelGrid: false,
    slices: true,
  };

  const appData = {
    theme: 2,
    effectRows: [0, 1, 2],
    prefs: { ...defaultPrefs, ...(overrides.prefs || {}) },
    ...(overrides.appData || {}),
  };

  return {
    appData,
    applyPersistedAppState(persistedState) {
      const data = this.appData;
      if (persistedState.theme != null) data.theme = persistedState.theme;
      if (persistedState.panels != null) data.effectRows = persistedState.panels.slice();
      if (persistedState.eparams) {
        const { applyEditorParamsToPrefs } = overrides.applyFn || {};
        if (applyEditorParamsToPrefs) {
          applyEditorParamsToPrefs(data.prefs, persistedState.eparams);
        }
      }
    },
    ...overrides.controller,
  };
}

/** In-memory Tauri store mock for settings persistence tests. */
export function makeMockSettingsStore() {
  const saved = {};
  return {
    saved,
    store: {
      async set(key, value) {
        saved[key] = value;
      },
      async get(key) {
        return saved[key];
      },
      async save() {},
    },
  };
}

/** @param {Record<string, unknown>} [storeApi] */
export function installTauriWindowMock(storeApi) {
  const previous = globalThis.window;
  globalThis.window = {
    __TAURI__: {
      store: storeApi || {
        load() {
          return Promise.resolve(makeMockSettingsStore().store);
        },
      },
    },
  };
  return () => {
    globalThis.window = previous;
  };
}
