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
import { ensureFormatLoaders } from "../../../src/document/formats/registry/format-loader-imports.js";

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
    assert.equal(typeof FakeController.prototype.deferSaveUntilFormatLoaders, "function");
  });

  // A writer ships in the same on-demand module as its parser. Export As waits
  // for that import; Save has to as well, or a save in a format the session has
  // never opened encodes with an undefined loader and reports only "could not
  // prepare this document". PSD is bundled, so it never waits.
  describe("deferSaveUntilFormatLoaders", () => {
    function saveController() {
      function FakeController() {}
      applyUiDispatchHandlers(FakeController);
      return new FakeController();
    }

    it("saves straight through for a format whose writer is in the bundle", () => {
      let retried = 0;
      const deferred = saveController().deferSaveUntilFormatLoaders("png", () => { retried++; });
      assert.equal(deferred, false, "PNG encodes with a codec that is always present");
      assert.equal(retried, 0);
    });

    // The first save of a new document defaults to PSD, and smart objects
    // encode through the same writer whatever the document was opened from, so
    // a PSD save must never be the thing that waits on an import.
    it("saves straight through for PSD, which ships in the bundle", () => {
      let retried = 0;
      const deferred = saveController().deferSaveUntilFormatLoaders("psd", () => { retried++; });
      assert.equal(deferred, false, "the PSD writer is installed at startup");
      assert.equal(retried, 0);
      assert.equal(saveController().deferSaveUntilFormatLoaders("psb", () => {}), false);
    });

    it("defers a save in an on-demand format until the writer lands, then retries it", async () => {
      const controller = saveController();
      let retried = 0;
      const deferred = controller.deferSaveUntilFormatLoaders("xcf", () => { retried++; });
      assert.equal(deferred, true, "nothing in this process has imported the XCF parser yet");
      assert.equal(retried, 0, "the retry must not run before the import resolves");
      await ensureFormatLoaders("xcf");
      await Promise.resolve();
      assert.equal(retried, 1);
      assert.equal(
        controller.deferSaveUntilFormatLoaders("xcf", () => {}),
        false,
        "the parser is installed now, so the retry saves without deferring again",
      );
    });

    // `writeDocumentToPath` catches whatever the encode throws and toasts, so a
    // missing writer looks like a save failure rather than an error. Count the
    // encode instead: it must not happen at all until the writer is here.
    it("writeDocumentToPath encodes nothing while the writer is still missing", async () => {
      const controller = saveController();
      let encodes = 0;
      let retries = 0;
      controller.encodeDocumentBytes = () => { encodes++; return new Uint8Array(0); };
      const writeDocumentToPath = controller.writeDocumentToPath;
      // The retry goes through `self.writeDocumentToPath`, so an own property
      // catches it before it reaches the real write — this has no Tauri host.
      controller.writeDocumentToPath = () => { retries++; };

      writeDocumentToPath.call(controller, { layers: [] }, "/tmp/out.cdr", "cdr");
      assert.equal(encodes, 0, "encoded with a writer this session never imported");

      await ensureFormatLoaders("cdr");
      await Promise.resolve();
      assert.equal(retries, 1, "the save never resumed once the writer landed");
    });
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
