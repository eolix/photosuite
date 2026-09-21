/**
 * Golden I/O for popup type ids and preset resource metadata.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

let PopupTypes;
let defaultExportFilename;

before(async () => {
  ({ PopupTypes, defaultExportFilename } = await import("../../../src/ui/config/popup-types.js"));
});

const POPUP_TYPE_NAME_GOLDEN = [
  "ALL", "BRUSHES", "GRADIENTS", "CONTOURS", "STYLES", "PATTERNS", "SHAPES",
  "SWATCHES", "ACTIONS", "TOOL_PRESETS", "COLOR_PROFILES", "FONTS", "OPEN_RECENT",
  "EXPORT_AS", "PLACE_IMAGE", "SHAPE_STROKE", "SCRIPTS", "ABOUT", "COLOR_CHANGE",
  "TOGGLE_RULERS", "TOGGLE_EXTRAS", "PREFERENCES", "KEYBOARD_SHORTCUTS", "PLUGINS",
  "CANVAS_SIZE", "IMAGE_SIZE", "ROTATE_CANVAS", "OPEN_FILE", "SAVE_AS",
  "NEW_DOCUMENT", "CHANGE_LANGUAGE", "CHANGE_THEME", "STARTUP_RESOURCES",
];

const PRESET_META_GOLDEN = {
  BRUSHES: { extension: "abr", bundleName: "brushes", localeKey: "panels.brush", parser: null, optionFlags: 0, thumbWidth: undefined, thumbHeight: undefined, usesTreePicker: false },
  GRADIENTS: { extension: "grd", bundleName: "gradients", localeKey: "properties.gradient", parser: null, optionFlags: 0, thumbWidth: undefined, thumbHeight: undefined, usesTreePicker: false },
  CONTOURS: { extension: "shc", bundleName: "contours", localeKey: "properties.contour", parser: null, optionFlags: 0, thumbWidth: undefined, thumbHeight: undefined, usesTreePicker: false },
  STYLES: { extension: "asl", bundleName: "styles", localeKey: "properties.style", parser: null, optionFlags: 0, thumbWidth: undefined, thumbHeight: undefined, usesTreePicker: false },
  PATTERNS: { extension: "pat", bundleName: "patterns", localeKey: "properties.pattern", parser: null, optionFlags: 0, thumbWidth: undefined, thumbHeight: undefined, usesTreePicker: false },
  SHAPES: { extension: "csh", bundleName: "shapes", localeKey: "properties.shapes", parser: null, optionFlags: 0, thumbWidth: undefined, thumbHeight: undefined, usesTreePicker: false },
  SWATCHES: { extension: "aco", bundleName: "swatches", localeKey: "panels.swatches", parser: null, optionFlags: 0, thumbWidth: 22, thumbHeight: 22, usesTreePicker: true },
  ACTIONS: { extension: "atn", bundleName: "actions", localeKey: "panels.actions", parser: null, optionFlags: 0, thumbWidth: undefined, thumbHeight: undefined, usesTreePicker: false },
  TOOL_PRESETS: { extension: "tpl", bundleName: "tpresets", localeKey: "panels.toolPresets", parser: null, optionFlags: 0, thumbWidth: undefined, thumbHeight: undefined, usesTreePicker: false },
  COLOR_PROFILES: { extension: "icc", bundleName: "profiles", localeKey: "ICCs", parser: null, optionFlags: 0, thumbWidth: undefined, thumbHeight: undefined, usesTreePicker: false },
};

function metaSnapshot(meta) {
  return {
    extension: meta.extension,
    bundleName: meta.bundleName,
    localeKey: meta.localeKey,
    parser: meta.parser,
    optionFlags: meta.optionFlags,
    thumbWidth: meta.thumbWidth,
    thumbHeight: meta.thumbHeight,
    usesTreePicker: meta.usesTreePicker,
  };
}

describe("ui/config/popup-types.js", () => {
  it("PopupTypes ids equal their own names", () => {
    assert.equal(PopupTypes.SAVE_AS, "SAVE_AS");
    assert.equal(PopupTypes.ALL, "ALL");
    const namedKeys = Object.keys(PopupTypes).filter((key) => key === PopupTypes[key]);
    assert.deepEqual(namedKeys, POPUP_TYPE_NAME_GOLDEN);
  });

  it("presetResources metadata matches goldens", () => {
    for (const [kindName, golden] of Object.entries(PRESET_META_GOLDEN)) {
      const meta = metaSnapshot(PopupTypes.presetResources[PopupTypes[kindName]]);
      assert.deepEqual(meta, golden, kindName);
    }
  });

  it("preset lookup helpers resolve extensions and tree picker flags", () => {
    assert.equal(PopupTypes.findPresetKindByExtension("grd"), PopupTypes.GRADIENTS);
    assert.equal(PopupTypes.findPresetKindByExtension("pat"), PopupTypes.PATTERNS);
    assert.equal(PopupTypes.findPresetKindByExtension("xyz"), "");
    assert.equal(PopupTypes.getPresetResource(PopupTypes.BRUSHES).extension, "abr");
    assert.equal(PopupTypes.getPresetResource("NOPE"), null);
    assert.equal(PopupTypes.usesTreePicker(PopupTypes.SWATCHES), true);
    assert.equal(PopupTypes.usesTreePicker(PopupTypes.BRUSHES), false);
  });

  it("defaultExportFilename joins bundleName and extension", () => {
    assert.equal(defaultExportFilename(PopupTypes.getPresetResource(PopupTypes.SWATCHES)), "swatches.aco");
    assert.equal(defaultExportFilename({ bundleName: "x", extension: "y" }), "x.y");
  });

});
