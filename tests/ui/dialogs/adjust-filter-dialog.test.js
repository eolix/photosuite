/**
 * Golden I/O for AdjustFilterDialog fade eligibility helper.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();
globalThis.SmartFilterBase = {};

function installCanvasContext() {
  const context = new Proxy({}, {
    get: (target, key) => {
      if (key === "canvas") return { width: 100, height: 100 };
      if (key === "measureText") return () => ({ width: 10 });
      if (key === "getImageData" || key === "createImageData") {
        return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      }
      if (key === "createLinearGradient" || key === "createPattern") {
        return () => ({ addColorStop() {} });
      }
      return typeof key === "string" && key in target ? target[key] : () => {};
    },
    set: () => true,
  });
  const createElement = globalThis.document.createElement.bind(globalThis.document);
  globalThis.document.createElement = (tag) => {
    const element = createElement(tag);
    if (tag === "canvas") element.getContext = () => context;
    return element;
  };
  const sample = createElement("div");
  if (!sample.querySelector) {
    const elementProto = Object.getPrototypeOf(sample);
    Object.defineProperty(elementProto, "querySelector", { value: () => null, enumerable: false });
    Object.defineProperty(elementProto, "querySelectorAll", { value: () => [], enumerable: false });
  }
}

let AdjustFilterDialog;

before(async () => {
  installCanvasContext();
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

  it("does not bind widgetSelect or live-edit canvas for fullscreen filter panel (LnCr)", async () => {
    await import("../../../src/ui/filter-panels/lens-correction-panel.js");
    const { EventType } = await import("../../../src/core/event-bus.js");
    const dialog = new AdjustFilterDialog("LnCr");
    assert.equal(dialog.usesFullscreenFilterPanel(), true);
    assert.equal(dialog.filterPanelWidget.hasListeners(EventType.widgetSelect), false);

    const dispatchedActions = [];
    dialog.on(EventType.documentAction, (evt) => {
      dispatchedActions.push(evt.data);
    });

    // Modifying controls or calling refresh on the panel must not trigger documentAction edit
    dialog.filterPanelWidget.refresh();
    assert.equal(dispatchedActions.length, 0, "no document action should fire during live preview");

    // Only when clicking OK should edit and confirm be applied to the canvas
    dialog.onOK();
    assert.equal(dispatchedActions.length, 2);
    assert.equal(dispatchedActions[0].actionKind, "edit");
    assert.equal(dispatchedActions[0].skipCanvasPreview, false);
    assert.equal(dispatchedActions[1].actionKind, "confirm");
  });

  it("binds widgetSelect to refresh for compact filter panel (GsnB)", async () => {
    await import("../../../src/ui/filter-panels/builtin-filter-panels.js");
    const { EventType } = await import("../../../src/core/event-bus.js");
    const dialog = new AdjustFilterDialog("GsnB");
    assert.equal(dialog.usesFullscreenFilterPanel(), false);
    assert.equal(dialog.filterPanelWidget.hasListeners(EventType.widgetSelect), true);
  });

  it("dispatches cancel action on cancel for fullscreen filter panel (LnCr)", async () => {
    await import("../../../src/ui/filter-panels/lens-correction-panel.js");
    const { EventType } = await import("../../../src/core/event-bus.js");
    const dialog = new AdjustFilterDialog("LnCr");
    const dispatchedActions = [];
    dialog.on(EventType.documentAction, (evt) => {
      dispatchedActions.push(evt.data);
    });
    dialog.onCancel();
    assert.equal(dispatchedActions.length, 1);
    assert.equal(dispatchedActions[0].actionKind, "cancel");
  });
});
