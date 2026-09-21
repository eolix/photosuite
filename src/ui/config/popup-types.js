/**
 * Central popup type ids and preset-library resource metadata for dialogs and panels.
 */

function normalizeTreePickerFlag(spec) {
  return spec.usesTreePicker === true;
}

// Build a preset resource descriptor from a partial spec (parser attached later
// in popup-type-parsers.js).
function createPresetResourceMeta(spec) {
  return {
    extension: spec.extension,
    bundleName: spec.bundleName,
    parser: spec.parser ?? null,
    localeKey: spec.localeKey,
    optionFlags: spec.optionFlags ?? 0,
    thumbWidth: spec.thumbWidth,
    thumbHeight: spec.thumbHeight,
    usesTreePicker: normalizeTreePickerFlag(spec),
  };
}

function getPresetResource(presetResources, kind) {
  return presetResources[kind] || null;
}

function findPresetKindByExtension(presetResources, extension) {
  for (const kind in presetResources) {
    if (presetResources[kind].extension === extension) return kind;
  }
  return "";
}

function usesTreePicker(presetResources, kind) {
  const meta = presetResources[kind];
  return meta != null && meta.usesTreePicker;
}

/** Default on-disk export name for a preset bundle (`bundleName.extension`). */
export function defaultExportFilename(meta) {
  return meta.bundleName + "." + meta.extension;
}

// Each PopupTypes.FOO value equals "FOO" so consumers can compare and index by name.
const POPUP_TYPE_NAMES = [
  "ALL", "BRUSHES", "GRADIENTS", "CONTOURS", "STYLES", "PATTERNS", "SHAPES",
  "SWATCHES", "ACTIONS", "TOOL_PRESETS", "COLOR_PROFILES", "FONTS", "OPEN_RECENT",
  "EXPORT_AS", "PLACE_IMAGE", "SHAPE_STROKE", "SCRIPTS", "ABOUT", "COLOR_CHANGE",
  "TOGGLE_RULERS", "TOGGLE_EXTRAS", "PREFERENCES", "KEYBOARD_SHORTCUTS", "PLUGINS",
  "CANVAS_SIZE", "IMAGE_SIZE", "ROTATE_CANVAS", "OPEN_FILE", "SAVE_AS",
  "NEW_DOCUMENT", "CHANGE_LANGUAGE", "CHANGE_THEME", "STARTUP_RESOURCES",
];

function buildPopupTypeIds(names) {
  return Object.fromEntries(names.map((name) => [name, name]));
}

export const PopupTypes = buildPopupTypeIds(POPUP_TYPE_NAMES);

// Preset-library metadata (parser wired later in popup-type-parsers.js).
const PRESET_RESOURCE_SPEC_ENTRIES = [
  [PopupTypes.BRUSHES, { extension: "abr", bundleName: "brushes", localeKey: "panels.brush" }],
  [PopupTypes.GRADIENTS, { extension: "grd", bundleName: "gradients", localeKey: "properties.gradient" }],
  [PopupTypes.CONTOURS, { extension: "shc", bundleName: "contours", localeKey: "properties.contour" }],
  [PopupTypes.STYLES, { extension: "asl", bundleName: "styles", localeKey: "properties.style" }],
  [PopupTypes.PATTERNS, { extension: "pat", bundleName: "patterns", localeKey: "properties.pattern" }],
  [PopupTypes.SHAPES, { extension: "csh", bundleName: "shapes", localeKey: "properties.shapes" }],
  [
    PopupTypes.SWATCHES,
    {
      extension: "aco",
      bundleName: "swatches",
      localeKey: "panels.swatches",
      thumbWidth: 22,
      thumbHeight: 22,
      usesTreePicker: true,
    },
  ],
  [PopupTypes.ACTIONS, { extension: "atn", bundleName: "actions", localeKey: "panels.actions" }],
  [PopupTypes.TOOL_PRESETS, { extension: "tpl", bundleName: "tpresets", localeKey: "panels.toolPresets" }],
  [PopupTypes.COLOR_PROFILES, { extension: "icc", bundleName: "profiles", localeKey: "ICCs" }],
];

function buildPresetResources(entries) {
  const resources = {};
  for (let i = 0; i < entries.length; i++) {
    const [kind, spec] = entries[i];
    resources[kind] = createPresetResourceMeta(spec);
  }
  return resources;
}

function attachPresetResourceApi(popupTypes) {
  popupTypes.getPresetResource = function (kind) {
    return getPresetResource(popupTypes.presetResources, kind);
  };
  popupTypes.findPresetKindByExtension = function (extension) {
    return findPresetKindByExtension(popupTypes.presetResources, extension);
  };
  popupTypes.usesTreePicker = function (kind) {
    return usesTreePicker(popupTypes.presetResources, kind);
  };
}

PopupTypes.presetResources = buildPresetResources(PRESET_RESOURCE_SPEC_ENTRIES);
attachPresetResourceApi(PopupTypes);
