/**
 * Golden I/O for new-project preset table and label helper.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let DOCUMENT_PRESET_CATEGORIES;
let buildDocumentPresetCategories;
let formatPresetMenuLabel;
let resolvePresetPixelDimensions;

before(async () => {
  ({
    DOCUMENT_PRESET_CATEGORIES,
    buildDocumentPresetCategories,
    formatPresetMenuLabel,
    resolvePresetPixelDimensions
  } = await import(
    "../../../src/ui/dialogs/new-project-dialog.js"
  ));
});

describe("ui/dialogs/new-project-dialog.js", () => {
  it("DOCUMENT_PRESET_CATEGORIES lists the built-in preset groups in dialog order", () => {
    assert.deepEqual(
      DOCUMENT_PRESET_CATEGORIES.map((category) => category.name),
      [
        "properties.presetCategory.photo",
        "properties.presetCategory.print",
        "properties.presetCategory.screen",
        "properties.presetCategory.mobile",
        "Social",
        "properties.presetCategory.ads",
        "properties.shapeType.square",
      ],
    );
    assert.equal(DOCUMENT_PRESET_CATEGORIES[0].presetRows.length, 8);
  });

  it("formatPresetMenuLabel matches conversion rules", () => {
    assert.equal(formatPresetMenuLabel(["A4", 210, 297, "mm", 300]), "8.3 x 11.7 in @ 300 ppi");
    assert.equal(formatPresetMenuLabel(["Letter", 8.5, 11, "in", 300]), "216 x 279 mm @ 300 ppi");
  });

  it("resolvePresetPixelDimensions converts mm presets to pixels", () => {
    const resolved = resolvePresetPixelDimensions(["A4", 210, 297, "mm", 300]);
    assert.equal(resolved.dpi, 300);
    assert.equal(resolved.unitIndex, 2);
    assert.equal(resolved.width, Math.round(210 / (25.4 / 300)));
    assert.equal(resolved.height, Math.round(297 / (25.4 / 300)));
  });

  it("buildDocumentPresetCategories always lists Recent blank presets first", () => {
    const categories = buildDocumentPresetCategories();
    assert.equal(categories.length, DOCUMENT_PRESET_CATEGORIES.length + 1);
    assert.equal(categories[0].name, "properties.presetCategory.recent");
    assert.equal(categories[0].isRecent, true);
    assert.equal(categories[0].presetRows.length, 0);
    // The built-in groups follow, unchanged and in their declared order.
    assert.equal(categories[1].name, DOCUMENT_PRESET_CATEGORIES[0].name);
  });
});
