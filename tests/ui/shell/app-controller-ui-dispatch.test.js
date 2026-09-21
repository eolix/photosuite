/**
 * AppController UI-dispatch: pure helpers + applyUiDispatchHandlers install.
 *
 * Golden values:
 * - dialogScriptPairs flat list from
 *   "open_from_url openFromURL camera takePic templates showTemplates newproject new eassets exportLayers".split(" ")
 * - selectionExportKind 0 builds pattern record with name/id/raster pair
 * - "$active" placeIntoDocIndex resolves against openDocs/activeDocIndex
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { promptConfirmUser } from "../../../src/core/user-prompts.js";
import { installWebviewConfirm } from "../../../src/core/user-prompts.js";

installBrowserGlobals();

let applyUiDispatchHandlers;
let DIALOG_SCRIPT_PAIRS;
let SELECTION_EXPORT_PATTERN;
let SELECTION_EXPORT_BRUSH;
let SELECTION_EXPORT_SHAPE;
let buildPatternPresetRecord;
let resolvePlaceIntoActiveDocIndex;
let lookupDialogScriptMethod;
let confirmDiscardUnsavedDocuments;

before(async () => {
  ({
    applyUiDispatchHandlers,
    DIALOG_SCRIPT_PAIRS,
    SELECTION_EXPORT_PATTERN,
    SELECTION_EXPORT_BRUSH,
    SELECTION_EXPORT_SHAPE,
    buildPatternPresetRecord,
    resolvePlaceIntoActiveDocIndex,
    lookupDialogScriptMethod,
    confirmDiscardUnsavedDocuments
  } = await import("../../../src/ui/shell/app-controller-ui-dispatch.js"));
});

describe("ui/shell/app-controller-ui-dispatch.js", () => {
  it("DIALOG_SCRIPT_PAIRS matches flat list golden", () => {
    assert.deepEqual(DIALOG_SCRIPT_PAIRS, [
      "open_from_url", "openFromURL",
      "camera", "takePic",
      "templates", "showTemplates",
      "newproject", "new",
      "eassets", "exportLayers"
    ]);
    assert.equal(DIALOG_SCRIPT_PAIRS.length, 10);
  });

  it("lookupDialogScriptMethod returns paired method or null", () => {
    assert.equal(lookupDialogScriptMethod("open_from_url"), "openFromURL");
    assert.equal(lookupDialogScriptMethod("eassets"), "exportLayers");
    assert.equal(lookupDialogScriptMethod("unknown_route"), null);
  });

  it("selectionExportKind constants match branch discriminators", () => {
    assert.equal(SELECTION_EXPORT_PATTERN, 0);
    assert.equal(SELECTION_EXPORT_BRUSH, 1);
    assert.equal(SELECTION_EXPORT_SHAPE, 2);
  });

  it("buildPatternPresetRecord golden shape uses rasterAndBounds", () => {
    const raster = new Uint8Array([1, 2, 3, 4]);
    const bounds = { x: 0, y: 0, width: 2, height: 2 };
    const record = buildPatternPresetRecord("photo", "uid-d71c", raster, bounds);
    assert.equal(record.name, "photo");
    assert.equal(record.id, "uid-d71c");
    assert.ok(Array.isArray(record.rasterAndBounds));
    assert.equal(record.rasterAndBounds[0], raster);
    assert.equal(record.rasterAndBounds[1], bounds);
    assert.equal(Object.prototype.hasOwnProperty.call(record, "jL"), false);
  });

  it("resolvePlaceIntoActiveDocIndex handles $active sentinel", () => {
    assert.equal(
      resolvePlaceIntoActiveDocIndex({ openDocs: [], activeDocIndex: 0 }, "$active"),
      null
    );
    assert.equal(
      resolvePlaceIntoActiveDocIndex(
        { openDocs: ["a", "b", "c"], activeDocIndex: 1 },
        "$active"
      ),
      1
    );
    assert.equal(
      resolvePlaceIntoActiveDocIndex(
        { openDocs: ["a", "b"], activeDocIndex: null },
        "$active"
      ),
      0
    );
    assert.equal(
      resolvePlaceIntoActiveDocIndex(
        { openDocs: ["a"], activeDocIndex: 99 },
        "$active"
      ),
      0
    );
    assert.equal(
      resolvePlaceIntoActiveDocIndex({ openDocs: ["a"], activeDocIndex: 0 }, 3),
      3
    );
  });

  it("applyUiDispatchHandlers installs onUiDispatch and save helpers", () => {
    function FakeController() {}
    applyUiDispatchHandlers(FakeController);
    assert.equal(typeof FakeController.prototype.onUiDispatch, "function");
    assert.equal(typeof FakeController.prototype.documentFormatIsEncodable, "function");
    assert.equal(typeof FakeController.prototype.encodeDocumentBytes, "function");
    assert.equal(typeof FakeController.prototype.saveDocumentToOrigin, "function");
    assert.equal(typeof FakeController.prototype.saveDocumentToNewFile, "function");
    assert.equal(typeof FakeController.prototype.markDocumentSaved, "function");
  });

  // Quitting asks about each document that still holds unsaved work. Declining
  // any one prompt abandons the quit, so the walk must stop on the first "no"
  // and must never reach the documents after it.
  describe("confirmDiscardUnsavedDocuments", () => {
    function fakeDoc(name, modified) {
      return { name, isModified: () => modified };
    }

    it("clears immediately when nothing is open", () => {
      let decision = null;
      confirmDiscardUnsavedDocuments(null, 0, (ok) => { decision = ok; });
      assert.equal(decision, true);
      confirmDiscardUnsavedDocuments([], 0, (ok) => { decision = ok; });
      assert.equal(decision, true);
    });

    it("does not prompt for documents without unsaved work", () => {
      const asked = [];
      installWebviewConfirm((message) => {
        asked.push(message);
        return true;
      });
      try {
        let decision = null;
        confirmDiscardUnsavedDocuments(
          [fakeDoc("clean-a", false), fakeDoc("clean-b", false)],
          0,
          (ok) => { decision = ok; }
        );
        assert.equal(decision, true);
        assert.deepEqual(asked, []);
      } finally {
        installWebviewConfirm(null);
      }
    });

    it("stops at the first declined document and leaves the rest unasked", () => {
      const asked = [];
      installWebviewConfirm((message) => {
        asked.push(message);
        return false;
      });
      try {
        let decision = null;
        confirmDiscardUnsavedDocuments(
          [fakeDoc("dirty-a", true), fakeDoc("dirty-b", true)],
          0,
          (ok) => { decision = ok; }
        );
        assert.equal(decision, false);
        assert.equal(asked.length, 1);
        assert.ok(asked[0].includes("dirty-a"));
      } finally {
        installWebviewConfirm(null);
      }
    });

    it("clears once every modified document is confirmed", () => {
      const asked = [];
      installWebviewConfirm((message) => {
        asked.push(message);
        return true;
      });
      try {
        let decision = null;
        confirmDiscardUnsavedDocuments(
          [fakeDoc("dirty-a", true), fakeDoc("clean", false), fakeDoc("dirty-b", true)],
          0,
          (ok) => { decision = ok; }
        );
        assert.equal(decision, true);
        assert.equal(asked.length, 2);
      } finally {
        installWebviewConfirm(null);
      }
    });
  });
});
