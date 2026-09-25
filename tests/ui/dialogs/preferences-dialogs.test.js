/**
 * Golden I/O for preference snapshot helper and tool-shortcut flattening.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let PREFERENCE_SECTIONS;
let TOOL_SHORTCUT_KEY_ROWS;
let flattenToolShortcutKeyRows;
let placedPreferenceKeys;
let sectionRows;
let snapshotPrefsFromWidgets;
let DEFAULT_EDITOR_PREFS;

before(async () => {
  ({
    PREFERENCE_SECTIONS,
    TOOL_SHORTCUT_KEY_ROWS,
    flattenToolShortcutKeyRows,
    placedPreferenceKeys,
    sectionRows,
    snapshotPrefsFromWidgets,
  } = await import("../../../src/ui/dialogs/preferences-dialogs.js"));
  ({ DEFAULT_EDITOR_PREFS } = await import("../../../src/core/editor-preferences.js"));
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

  it("snapshotPrefsFromWidgets reads each widget into the preference it edits", () => {
    const widgets = {
      guides: { getValue: () => false },
      gridSize: { getValue: () => 12.7 },
      gridUnits: { getValue: () => 1 },
      gpuAcceleration: { getValue: () => false },
    };
    const snapped = snapshotPrefsFromWidgets(widgets, { extra: true, slices: true });
    assert.equal(snapped.guides, false);
    assert.equal(snapped.gridUnits, 1);
    assert.equal(snapped.gpuAcceleration, false);
    // The rounding rule belongs to the preference, not to this function.
    assert.equal(snapped.gridSize, 13);
    assert.equal(snapped.extra, true, "an unrelated pref was dropped");
    assert.equal(snapped.slices, true);
  });

  it("snapshotPrefsFromWidgets keeps a percentage grid gap unrounded", () => {
    const widgets = {
      gridSize: { getValue: () => 12.7 },
      gridUnits: { getValue: () => 4 },
    };
    assert.equal(snapshotPrefsFromWidgets(widgets, {}).gridSize, 12.7);
  });

  // The section table is the whole layout: what it lists is what is built,
  // edited and saved, so the checks that matter are that it names real
  // preferences and names each of them once.
  describe("PREFERENCE_SECTIONS", () => {
    it("places every row against a declared preference or a dialog control", () => {
      for (const section of PREFERENCE_SECTIONS) {
        for (const row of sectionRows(section)) {
          if (row.control != null) {
            assert.ok(["theme", "language"].includes(row.control), "unknown control " + row.control);
            continue;
          }
          assert.notEqual(DEFAULT_EDITOR_PREFS[row.pref], undefined, row.pref + " is not a preference");
          assert.equal(typeof row.widget, "function", row.pref + " has no widget");
        }
      }
    });

    it("gives every preference it places exactly one row", () => {
      const placed = placedPreferenceKeys();
      assert.deepEqual([...placed].sort(), [...new Set(placed)].sort(), "a preference is placed twice");
    });

    it("names each section once, with a label to translate", () => {
      const ids = PREFERENCE_SECTIONS.map((section) => section.id);
      assert.deepEqual(ids, ["general", "interface", "tools", "units", "guides"]);
      assert.equal(new Set(ids).size, ids.length);
      for (const section of PREFERENCE_SECTIONS) {
        assert.match(section.labelKey, /^dialogs\.preferenceSections\./);
      }
    });

    it("puts each preference in the section it belongs to", () => {
      const sectionOf = (prefKey) =>
        PREFERENCE_SECTIONS.find((section) =>
          sectionRows(section).some((row) => row.pref === prefKey),
        ).id;
      assert.equal(sectionOf("gpuAcceleration"), "general");
      assert.equal(sectionOf("zoomWithScrollWheel"), "tools");
      assert.equal(sectionOf("AppWindow"), "units");
      assert.equal(sectionOf("guides"), "guides");
      assert.equal(sectionOf("gridType"), "guides");
      const interfaceRows = sectionRows(PREFERENCE_SECTIONS[1]).map((row) => row.control);
      assert.deepEqual(interfaceRows, ["theme", "language"]);
    });

    it("gives every group rows, and every label a key to translate", () => {
      for (const section of PREFERENCE_SECTIONS) {
        assert.ok(section.groups.length > 0, section.id + " has no groups");
        for (const group of section.groups) {
          assert.ok(group.rows.length > 0, section.id + " has an empty group");
          if (group.labelKey != null) assert.match(group.labelKey, /^[a-z]+\./);
        }
      }
    });
  });
});
