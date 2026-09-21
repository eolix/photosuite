/**
 * Golden I/O for export / Save for Web / LUT dialog helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ExportColorLUTDialog;
let WriteFileDialog;
let ExportAssetsDialog;
let defaultFormatIndex;
let previewModeForFormat;
let getFormat;
let listEncodableFormats;
let listSaveFormats;

before(async () => {
  ({ ExportColorLUTDialog, WriteFileDialog, ExportAssetsDialog, defaultFormatIndex, previewModeForFormat } =
    await import("../../../src/ui/dialogs/export-dialogs.js"));
  ({ getFormat } = await import(
    "../../../src/document/formats/registry/registry-helpers.js"
  ));
  ({ listEncodableFormats, listSaveFormats } = await import(
    "../../../src/document/formats/registry/registry-api.js"
  ));
});

describe("ui/dialogs/export-dialogs.js", () => {
  // Save As and Export As share this dialog: it opens on the format the file was
  // read from, so the native dialog offers the file its own name back.
  describe("defaultFormatIndex", () => {
    const flat = { formatType: "jpg", width: 800, height: 600, layers: [{}] };
    const layered = { formatType: "jpg", width: 800, height: 600, layers: [{}, {}] };

    it("keeps the document's own format when it loses nothing", () => {
      const saveFormats = listSaveFormats();
      assert.equal(saveFormats[defaultFormatIndex(saveFormats, flat)], "JPG");
      assert.equal(
        saveFormats[defaultFormatIndex(saveFormats, { formatType: "psd", width: 8, height: 8 })],
        "PSD"
      );
    });

    it("falls to PSD when Save As would otherwise flatten the document", () => {
      const saveFormats = listSaveFormats();
      assert.equal(saveFormats[defaultFormatIndex(saveFormats, layered)], "PSD");
      // Past the PSD size ceiling only PSB can hold the document.
      assert.equal(
        saveFormats[defaultFormatIndex(saveFormats, { formatType: "psd", width: 40000, height: 10 })],
        "PSB"
      );
    });

    it("keeps the document's format on export, where every format is a rendering", () => {
      const exportFormats = listEncodableFormats();
      assert.equal(exportFormats[defaultFormatIndex(exportFormats, layered)], "JPG");
      // PSD has no export row, and a document built from scratch has no format.
      assert.equal(
        exportFormats[defaultFormatIndex(exportFormats, { formatType: "psd", width: 8, height: 8 })],
        "PNG"
      );
      assert.equal(exportFormats[defaultFormatIndex(exportFormats, { width: 8, height: 8 })], "PNG");
    });
  });

  // Only a decoded preview shows what the options did to the image. PSD and PSB
  // have no such question: they store the document, so they show the document.
  it("previewModeForFormat picks a preview source per format", () => {
    const modeFor = (formatId) => previewModeForFormat(formatId, getFormat(formatId));
    assert.equal(modeFor("PSD"), "document");
    assert.equal(modeFor("PSB"), "document");
    assert.equal(modeFor("PNG"), "decode");
    assert.equal(modeFor("JPG"), "decode");
    assert.equal(modeFor("SVG"), "viewer");
    assert.equal(modeFor("PDF"), "viewer");
    assert.equal(modeFor("DXF"), "none");
    assert.equal(modeFor("RAW"), "none");
  });

  it("fillsNeutralRgbGradientSliceBuffer writes RGB cube slice", () => {
    const buf = new Uint8ClampedArray(2 * 2 * 4);
    ExportColorLUTDialog.prototype.fillNeutralRgbGradientSliceBuffer(2, 0, buf);
    assert.deepEqual(Array.from(buf), [0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 255, 255, 0, 255]);
    ExportColorLUTDialog.prototype.fillNeutralRgbGradientSliceBuffer(2, 1, buf);
    assert.deepEqual(Array.from(buf), [0, 0, 255, 255, 255, 0, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255]);
  });

  // Export Layers picks its rows from one of three scopes: layers whose name
  // carries the "-e-" marker, every layer in the document, or just the current
  // selection — the scope the move tool's PNG/SVG buttons ask for.
  describe("ExportAssetsDialog layer scope", () => {
    function layer(name, isGroup, isEmpty) {
      return {
        getName: () => name,
        isGroup: () => isGroup,
        rect: { isEmpty: () => isEmpty }
      };
    }

    function dialogWithDoc(scopeIndex, doc) {
      const dialog = Object.create(ExportAssetsDialog.prototype);
      dialog.sourceDocument = doc;
      dialog.layerScopeRadioGroup = { getValue: () => scopeIndex };
      return dialog;
    }

    const doc = {
      selectedLayerIndices: [1, 3],
      layers: [
        layer("-e-icon", false, false),
        layer("plain", false, false),
        layer("group", true, false),
        layer("empty", false, true)
      ]
    };

    it("scope 0 exports exactly the document's layer selection", () => {
      assert.deepEqual(dialogWithDoc(0, doc).getExportableLayerIndices(), [1, 3]);
    });

    it("scope 1 exports only the -e- prefixed rows, groups included", () => {
      assert.deepEqual(dialogWithDoc(1, doc).getExportableLayerIndices(), [0]);
    });

    it("scope 2 exports non-empty pixel layers plus the -e- rows", () => {
      assert.deepEqual(dialogWithDoc(2, doc).getExportableLayerIndices(), [0, 1]);
    });

    it("returns nothing when no document is open", () => {
      assert.deepEqual(dialogWithDoc(2, null).getExportableLayerIndices(), []);
    });

    it("skips selection entries that name a missing layer", () => {
      const staleDoc = { selectedLayerIndices: [0, 9], layers: [layer("a", false, false)] };
      assert.deepEqual(dialogWithDoc(0, staleDoc).getExportableLayerIndices(), [0]);
    });
  });
});
