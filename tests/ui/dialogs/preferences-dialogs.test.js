/**
 * Golden I/O for preference snapshot helper and tool-shortcut flattening.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let PREFERENCE_SECTIONS;
let PREF_WIDGET;
let TOOL_SHORTCUT_KEY_ROWS;
let flattenToolShortcutKeyRows;
let snapshotPrefsFromWidgets;

before(async () => {
  ({
    PREFERENCE_SECTIONS,
    PREF_WIDGET,
    TOOL_SHORTCUT_KEY_ROWS,
    flattenToolShortcutKeyRows,
    snapshotPrefsFromWidgets,
  } = await import("../../../src/ui/dialogs/preferences-dialogs.js"));
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

  // The sections are the growth path for new preferences, so what matters is
  // that every preference still has exactly one home: a widget listed twice
  // would be moved into the second pane and vanish from the first, and one
  // listed nowhere would stop being reachable at all.
  describe("PREFERENCE_SECTIONS", () => {
    const controlsOf = (section) => section.groups.flatMap((group) => group.controls);

    it("gives every preference widget exactly one section", () => {
      const placements = PREFERENCE_SECTIONS.flatMap(controlsOf).filter(
        (ref) => typeof ref === "number",
      );
      assert.deepEqual([...placements].sort(), [...new Set(placements)].sort(), "a widget is placed twice");
      // GRID_UNITS is the exception: it shares the grid-gap row, so the pane
      // that shows GRID_SIZE places it too.
      const expected = Object.values(PREF_WIDGET).filter((index) => index !== PREF_WIDGET.GRID_UNITS);
      assert.deepEqual([...placements].sort((a, b) => a - b), expected.sort((a, b) => a - b));
    });

    it("names each section once, with a label to translate", () => {
      const ids = PREFERENCE_SECTIONS.map((section) => section.id);
      assert.deepEqual(ids, ["general", "interface", "units", "guides"]);
      assert.equal(new Set(ids).size, ids.length);
      for (const section of PREFERENCE_SECTIONS) {
        assert.match(section.labelKey, /^dialogs\.preferenceSections\./);
      }
    });

    it("puts GPU acceleration in General and ruler units in Units & Rulers", () => {
      const sectionOf = (controlRef) =>
        PREFERENCE_SECTIONS.find((section) => controlsOf(section).includes(controlRef)).id;
      assert.equal(sectionOf(PREF_WIDGET.GPU_ACCELERATION), "general");
      assert.equal(sectionOf(PREF_WIDGET.RULER_UNITS), "units");
      assert.equal(sectionOf(PREF_WIDGET.GUIDES), "guides");
      assert.equal(sectionOf(PREF_WIDGET.GRID_TYPE), "guides");
      // Theme and language are not preferences; they belong to Interface.
      assert.equal(sectionOf("theme"), "interface");
      assert.equal(sectionOf("language"), "interface");
    });

    it("gives every group controls, and every label a key to translate", () => {
      for (const section of PREFERENCE_SECTIONS) {
        assert.ok(section.groups.length > 0, section.id + " has no groups");
        for (const group of section.groups) {
          assert.ok(group.controls.length > 0, section.id + " has an empty group");
          if (group.labelKey != null) assert.match(group.labelKey, /^[a-z]+\./);
        }
      }
    });
  });
});
