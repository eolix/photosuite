/**
 * Wires binary preset parsers onto PopupTypes.presetResources after popup-types.js
 * defines metadata. Kept in its own module so popup-types.js does not import heavy codecs.
 */
import { PopupTypes } from "./popup-types.js";
import { PatternFile } from "../../features/pattern/pattern-file.js";
import { GradientFile } from "../../features/gradient/gradient-file.js";
import { BrushFileCodec } from "../../features/brush/brush-file.js";
import { ColorLookupParser } from "../../features/adjustments/color-lookup-file.js";
import { ToolPresetParser } from "../../features/tool-preset/tool-preset-file.js";
import { ShapeFile } from "../../features/shape/shape-file.js";
import { SwatchFile } from "../../features/swatch/swatch-file.js";
import { ContourParser } from "../../features/layer-styles/contour-file.js";
import { ActionParser } from "../../features/scripting/action-file.js";
import { StyleParser } from "../../features/layer-styles/style-file.js";

const PRESET_PARSER_BINDINGS = [
  [PopupTypes.BRUSHES, BrushFileCodec],
  [PopupTypes.GRADIENTS, GradientFile],
  [PopupTypes.CONTOURS, ContourParser],
  [PopupTypes.STYLES, StyleParser],
  [PopupTypes.PATTERNS, PatternFile],
  [PopupTypes.SHAPES, ShapeFile],
  [PopupTypes.SWATCHES, SwatchFile],
  [PopupTypes.ACTIONS, ActionParser],
  [PopupTypes.TOOL_PRESETS, ToolPresetParser],
  [PopupTypes.COLOR_PROFILES, ColorLookupParser],
];

/**
 * Attach codec implementations to preset resource metadata entries.
 * @param {Record<string, { parser?: unknown }>} [presetResources]
 */
export function installPresetResourceParsers(presetResources = PopupTypes.presetResources) {
  for (let i = 0; i < PRESET_PARSER_BINDINGS.length; i++) {
    const [kind, parser] = PRESET_PARSER_BINDINGS[i];
    presetResources[kind].parser = parser;
  }
}

installPresetResourceParsers();
