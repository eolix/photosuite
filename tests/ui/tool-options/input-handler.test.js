/**
 * InputHandler pure helpers (labels, visibility, action fields).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let InputHandler;
let formatMenuRowLabel;
let isVisibleMenuRowState;
let shouldApplyNestedVisibility;
let readContextMenuActionFields;
let SUBMENU_OPEN_DELAY_MS;
let Locale;

before(async () => {
  ({
    InputHandler,
    formatMenuRowLabel,
    isVisibleMenuRowState,
    shouldApplyNestedVisibility,
    readContextMenuActionFields,
    SUBMENU_OPEN_DELAY_MS
  } = await import("../../../src/ui/tool-options/input-handler.js"));
  ({ Locale } = await import("../../../src/core/i18n/locale.js"));
  if (!Locale.get || Locale.get.length === 0) {
    // Locale may already be stubbed; ensure identity for keys used below.
  }
});

describe("ui/tool-options/input-handler.js", () => {
  it("formatMenuRowLabel appends dialog ellipsis", () => {
    const prev = Locale.get;
    Locale.get = (key) => (typeof key === "string" ? key : String(key));
    try {
      assert.equal(formatMenuRowLabel({ name: "file.open" }), "file.open");
      assert.equal(
        formatMenuRowLabel({ name: "file.open", opensDialog: true }),
        "file.open..."
      );
    } finally {
      Locale.get = prev;
    }
  });

  it("visibility helpers match rules", () => {
    assert.equal(isVisibleMenuRowState(0), false);
    assert.equal(isVisibleMenuRowState(null), false);
    assert.equal(isVisibleMenuRowState(1), true);
    assert.equal(isVisibleMenuRowState([1, 0]), true);
    assert.equal(shouldApplyNestedVisibility(1), false);
    assert.equal(shouldApplyNestedVisibility([1, 1]), true);
  });

  it("readContextMenuActionFields uses modern descriptor keys only", () => {
    assert.deepEqual(
      readContextMenuActionFields({
        appEventType: "uiDispatch",
        documentModelType: 7,
        payload: { a: 1 }
      }),
      {
        appEventType: "uiDispatch",
        routingChannel: 7,
        payload: { a: 1 }
      }
    );
    assert.deepEqual(
      readContextMenuActionFields({ appEventType: "select" }),
      {
        appEventType: "select",
        routingChannel: null,
        payload: undefined
      }
    );
  });

  it("SUBMENU_OPEN_DELAY_MS is 300", () => {
    assert.equal(SUBMENU_OPEN_DELAY_MS, 300);
  });

  it("exports InputHandler constructor", () => {
    assert.equal(typeof InputHandler, "function");
  });
});
