/**
 * Golden I/O for preference snapshot helper and tool-shortcut flattening.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let TOOL_SHORTCUT_KEY_ROWS;
let flattenToolShortcutKeyRows;
let snapshotPrefsFromWidgets;

before(async () => {
  ({ TOOL_SHORTCUT_KEY_ROWS, flattenToolShortcutKeyRows, snapshotPrefsFromWidgets } = await import(
    "../../../src/ui/dialogs/preferences-dialogs.js"
  ));
});

describe("ui/dialogs/preferences-dialogs.js", () => {
  it("TOOL_SHORTCUT_KEY_ROWS matches goldens", () => {
    assert.equal(TOOL_SHORTCUT_KEY_ROWS.length, 135);
    assert.deepEqual(TOOL_SHORTCUT_KEY_ROWS.slice(0, 6), [
      "tools.moveTool",
      "V",
      0,
      "tools.rectangleSelect",
      "M",
      1,
    ]);
    const nullShortcutCount = TOOL_SHORTCUT_KEY_ROWS.filter((value, idx) => idx % 3 === 1 && value == null).length;
    assert.equal(nullShortcutCount, 3);
  });

  it("flattenToolShortcutKeyRows drops null shortcuts and palette indexes", () => {
    const flat = flattenToolShortcutKeyRows(TOOL_SHORTCUT_KEY_ROWS);
    assert.equal(flat.length, 84);
    assert.deepEqual(flat.slice(0, 4), ["tools.moveTool", "V", "tools.rectangleSelect", "M"]);
    assert.equal(flat.includes("tools.blurTool"), false);
  });

  it("snapshotPrefsFromWidgets copies widget values and rounds gridSize", () => {
    const widgets = [0, 1, 2, 3, 4, 5, 6].map((value) => ({ getValue: () => value }));
    widgets[3] = { getValue: () => 12.7 };
    widgets[4] = { getValue: () => 1 };
    widgets[6] = { getValue: () => false };
    const snapped = snapshotPrefsFromWidgets(widgets, { extra: true });
    assert.equal(snapped.guides, 0);
    assert.equal(snapped.showGrid, 1);
    assert.equal(snapped.gridType, 2);
    assert.equal(snapped.gridSize, 13);
    assert.equal(snapped.gridUnits, 1);
    assert.equal(snapped.AppWindow, 5);
    assert.equal(snapped.gpuAcceleration, false);
    assert.equal(snapped.extra, true);
  });
});
