/**
 * Built-in round brush presets and default swatch folder seeded when stores are empty.
 */

import { BrushPresetUtil } from "../../features/brush/brush-presets.js";

const DEFAULT_ROUND_BRUSH_SPECS = [
  ["Soft Round", 15, 0],
  ["Hard Round", 15, 100],
  ["Medium Round", 30, 50],
  ["Large Soft", 60, 25],
  ["Small Hard", 5, 100],
];

const DEFAULT_SWATCH_COLOR_SPECS = [
  [0x000000, "Black"],
  [0x333333, "Dark Gray"],
  [0x666666, "Gray"],
  [0x999999, "Light Gray"],
  [0xcccccc, "Silver"],
  [0xffffff, "White"],
  [0xff0000, "Red"],
  [0xff6600, "Orange"],
  [0xffcc00, "Gold"],
  [0xffff00, "Yellow"],
  [0x99cc00, "Yellow Green"],
  [0x00cc00, "Green"],
  [0x00cccc, "Teal"],
  [0x00ccff, "Sky"],
  [0x0066ff, "Blue"],
  [0x6633ff, "Indigo"],
  [0xcc00ff, "Purple"],
  [0xff00cc, "Magenta"],
  [0xff0066, "Rose"],
  [0x8b4513, "Brown"],
  [0xf4a460, "Sandy Brown"],
  [0xffc0cb, "Pink"],
  [0x800000, "Maroon"],
  [0x000080, "Navy"],
];

function buildBrushListEntry(name, diameter, hardness) {
  const preset = BrushPresetUtil.getDefaultBrushDescriptor();
  const brush = preset.Brsh.v;
  preset.Nm.v = name;
  brush.diameter.v.val = diameter;
  brush.Hrdn.v.val = hardness;
  return { t: "Objc", v: preset };
}

function assignActiveBrushFromList(brushStore) {
  if (brushStore.activeBrushPreset != null) return;
  for (let i = 0; i < brushStore.list.length; i++) {
    const preset = BrushPresetUtil.getBrushPresetFromListEntry(brushStore.list[i]);
    if (preset != null) {
      brushStore.activeBrushPreset = JSON.parse(JSON.stringify(preset));
      return;
    }
  }
}

/**
 * Ensures appData.brushPresets has built-in round brushes when no .abr library is loaded.
 * @returns {boolean} true if defaults were inserted
 */
export function ensureDefaultBrushPresets(brushStore) {
  if (!brushStore || brushStore.list.length > 0) return false;
  for (let i = 0; i < DEFAULT_ROUND_BRUSH_SPECS.length; i++) {
    const [name, diameter, hardness] = DEFAULT_ROUND_BRUSH_SPECS[i];
    brushStore.list.push(buildBrushListEntry(name, diameter, hardness));
  }
  BrushPresetUtil.sanitizeBrushPresetList(brushStore.list);
  assignActiveBrushFromList(brushStore);
  return true;
}

/**
 * Returns the swatch library root list on appData, creating it when missing.
 * @param {object} appData
 * @returns {Array}
 */
export function getSwatchPresetStore(appData) {
  if (appData == null) return [];
  if (appData.swatchPresets == null) appData.swatchPresets = [];
  return appData.swatchPresets;
}

function hasDefaultSwatchFolder(swatchStore) {
  for (let i = 0; i < swatchStore.length; i++) {
    if (swatchStore[i] && swatchStore[i][0] === "Default") return true;
  }
  return false;
}

function rgbFromPackedHex(hex) {
  return {
    h: (hex >>> 16) & 255,
    l: (hex >>> 8) & 255,
    O: hex & 255,
  };
}

function buildDefaultSwatchChildren() {
  const children = [];
  for (let i = 0; i < DEFAULT_SWATCH_COLOR_SPECS.length; i++) {
    const [hex, name] = DEFAULT_SWATCH_COLOR_SPECS[i];
    const rgb = rgbFromPackedHex(hex);
    children.push([name, { h: rgb.h, l: rgb.l, O: rgb.O, name }, null]);
  }
  return children;
}

/**
 * Ensures a "Default" swatch folder exists (built-in colors).
 * Tree nodes: [name, data|null, children|thumb, expanded?]
 * @param {Array} swatchStore root folder list
 * @returns {boolean} true if defaults were inserted
 */
export function ensureDefaultSwatchPresets(swatchStore) {
  if (!swatchStore) return false;
  if (hasDefaultSwatchFolder(swatchStore)) return false;
  swatchStore.unshift(["Default", null, buildDefaultSwatchChildren(), true]);
  return true;
}
