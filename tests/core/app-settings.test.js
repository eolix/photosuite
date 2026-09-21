import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import {
  EDITOR_PERSISTED_PARAM_MAP,
  applyEditorParamsToPrefs,
  snapshotEditorParamsFromPrefs,
} from "../../src/core/editor-persisted-params.js";
import {
  installTauriWindowMock,
  makeMinimalAppController,
  makeMockSettingsStore,
} from "../helpers/minimal-app-controller.js";

let persistAppSettings;
let restoreWindow;

before(async () => {
  const mock = makeMockSettingsStore();
  restoreWindow = installTauriWindowMock({
    load() {
      return Promise.resolve(mock.store);
    },
  });
  const settingsMod = await import("../../src/core/app-settings.js");
  persistAppSettings = settingsMod.persistAppSettings;
});

after(() => {
  if (restoreWindow) restoreWindow();
});

describe("contract: app-settings ↔ editor prefs", () => {
  it("snapshotEditorParamsFromPrefs maps every persisted key", () => {
    const prefs = {
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
      gpuAcceleration: true,
    };

    assert.deepEqual(snapshotEditorParamsFromPrefs(prefs), {
      guides: true,
      grid: false,
      gsize: 20,
      gunits: 1,
      gtype: 0,
      runits: 0,
      sels: true,
      paths: true,
      pgrid: false,
      slices: true,
      gpu: true,
    });
  });

  it("applyEditorParamsToPrefs round-trips snapshot fields", () => {
    const prefs = {
      guides: false,
      showGrid: true,
      gridSize: 10,
      gridUnits: 2,
      gridType: 1,
      AppWindow: 1,
      showSelectionEdges: false,
      paths: false,
      showPixelGrid: true,
      slices: false,
    };
    const snapshot = snapshotEditorParamsFromPrefs(prefs);
    const restored = {
      guides: null,
      showGrid: null,
      gridSize: null,
      gridUnits: null,
      gridType: null,
      AppWindow: null,
      showSelectionEdges: null,
      paths: null,
      showPixelGrid: null,
      slices: null,
    };
    applyEditorParamsToPrefs(restored, snapshot);
    assert.deepEqual(restored, prefs);
  });

  it("persistAppSettings reads appData.prefs (not appController.prefs)", async () => {
    const mock = makeMockSettingsStore();
    const restore = installTauriWindowMock({
      load() {
        return Promise.resolve(mock.store);
      },
    });

    const appController = makeMinimalAppController();

    try {
      await persistAppSettings(appController);
      assert.deepEqual(
        mock.saved.eparams,
        snapshotEditorParamsFromPrefs(appController.appData.prefs)
      );
      assert.equal(mock.saved.theme, 2);
      assert.deepEqual(mock.saved.panels, [0, 1, 2]);
    } finally {
      restore();
    }
  });

  it("field map keys match snapshot output keys", () => {
    const snapshotKeys = Object.keys(
      snapshotEditorParamsFromPrefs(makeMinimalAppController().appData.prefs)
    );
    assert.deepEqual(snapshotKeys.sort(), Object.keys(EDITOR_PERSISTED_PARAM_MAP).sort());
  });
});
