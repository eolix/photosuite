/**
 * Golden I/O for AdjustFilterDialog fade eligibility helper.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();
globalThis.SmartFilterBase = {};

let AdjustFilterDialog;

before(async () => {
  ({ AdjustFilterDialog } = await import("../../../src/ui/dialogs/adjust-filter-dialog.js"));
});

describe("ui/dialogs/adjust-filter-dialog.js", () => {
  it("canOpenFadeOnActiveLayers rejects null document", () => {
    assert.equal(AdjustFilterDialog.canOpenFadeOnActiveLayers(null), false);
  });

  it("canOpenFadeOnActiveLayers accepts matching override-index history keys", () => {
    const doc = {
      selectedLayerIndices: [0],
      extraChannels: {},
      layers: [{ pixelContent: "buf1" }],
      getLastHistoryEntry() {
        return { data: [{ overrideLayerIndex: 0, D3: "buf1" }] };
      },
    };
    assert.equal(AdjustFilterDialog.canOpenFadeOnActiveLayers(doc), true);
  });

  it("canOpenFadeOnActiveLayers rejects pixel snapshot mismatch", () => {
    const doc = {
      selectedLayerIndices: [0],
      extraChannels: {},
      layers: [{ pixelContent: "buf1" }],
      getLastHistoryEntry() {
        return { data: [{ overrideLayerIndex: 0, D3: "buf2" }] };
      },
    };
    assert.equal(AdjustFilterDialog.canOpenFadeOnActiveLayers(doc), false);
  });

  it("canOpenFadeOnActiveLayers accepts adjustment-preview snapshot shape", () => {
    const doc = {
      selectedLayerIndices: [0],
      extraChannels: {},
      layers: [{ pixelContent: 0 }],
      getLastHistoryEntry() {
        return { data: [{ layerIndex: 0, pixelContentKind: 0 }] };
      },
    };
    assert.equal(AdjustFilterDialog.canOpenFadeOnActiveLayers(doc), true);
  });
});
