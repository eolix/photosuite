/**
 * recent blank-document preset persistence.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";

installBrowserGlobals();

let normalizeRecentDocumentPresets;
let recentDocumentPresetToPresetRow;
let MAX_RECENT_DOCUMENT_PRESETS;

before(async () => {
  ({
    normalizeRecentDocumentPresets,
    recentDocumentPresetToPresetRow,
    MAX_RECENT_DOCUMENT_PRESETS
  } = await import("../../src/core/recent-document-presets.js"));
});

describe("core/recent-document-presets.js", () => {
  it("normalizeRecentDocumentPresets caps and validates rows", () => {
    assert.equal(MAX_RECENT_DOCUMENT_PRESETS, 5);
    const normalized = normalizeRecentDocumentPresets([
      {
        name: "Poster",
        width: 1920,
        height: 1080,
        dpi: 72,
        unitIndex: 0,
        unit: "px",
        unitWidth: 1920,
        unitHeight: 1080,
        backgroundFillIndex: 1
      },
      { width: 0, height: 100 },
      null
    ]);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].name, "Poster");
    assert.equal(normalized[0].backgroundFillIndex, 1);
  });

  it("recentDocumentPresetToPresetRow preserves display units", () => {
    const row = recentDocumentPresetToPresetRow({
      name: "A4 Print",
      label: "A4 Print",
      unitWidth: 210,
      unitHeight: 297,
      unit: "mm",
      dpi: 300,
      width: 2480,
      height: 3508,
      unitIndex: 2,
      backgroundFillIndex: 0
    });
    assert.deepEqual(row, ["A4 Print", 210, 297, "mm", 300]);
  });
});
