/**
 * Golden bindings for preset resource parsers (popup-type-parsers.js).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let PopupTypes;
let installPresetResourceParsers;
let BrushFileCodec;
let GradientFile;
let ContourParser;
let StyleParser;
let PatternFile;
let ShapeFile;
let SwatchFile;
let ActionParser;
let ToolPresetParser;
let ColorLookupParser;

before(async () => {
  ({ PopupTypes } = await import("../../../src/ui/config/popup-types.js"));
  ({ installPresetResourceParsers } = await import(
    "../../../src/ui/config/popup-type-parsers.js"
  ));
  ({ BrushFileCodec } = await import("../../../src/features/brush/brush-file.js"));
  ({ GradientFile } = await import("../../../src/features/gradient/gradient-file.js"));
  ({ ContourParser } = await import("../../../src/features/layer-styles/contour-file.js"));
  ({ StyleParser } = await import("../../../src/features/layer-styles/style-file.js"));
  ({ PatternFile } = await import("../../../src/features/pattern/pattern-file.js"));
  ({ ShapeFile } = await import("../../../src/features/shape/shape-file.js"));
  ({ SwatchFile } = await import("../../../src/features/swatch/swatch-file.js"));
  ({ ActionParser } = await import("../../../src/features/scripting/action-file.js"));
  ({ ToolPresetParser } = await import("../../../src/features/tool-preset/tool-preset-file.js"));
  ({ ColorLookupParser } = await import(
    "../../../src/features/adjustments/color-lookup-file.js"
  ));
});

const EXPECTED_PARSER_BY_KIND = [
  ["BRUSHES", () => BrushFileCodec],
  ["GRADIENTS", () => GradientFile],
  ["CONTOURS", () => ContourParser],
  ["STYLES", () => StyleParser],
  ["PATTERNS", () => PatternFile],
  ["SHAPES", () => ShapeFile],
  ["SWATCHES", () => SwatchFile],
  ["ACTIONS", () => ActionParser],
  ["TOOL_PRESETS", () => ToolPresetParser],
  ["COLOR_PROFILES", () => ColorLookupParser],
];

describe("ui/config/popup-type-parsers.js", () => {
  it("installPresetResourceParsers wires each preset kind to its codec", () => {
    for (const [kindName, getParser] of EXPECTED_PARSER_BY_KIND) {
      const kind = PopupTypes[kindName];
      assert.equal(PopupTypes.presetResources[kind].parser, getParser(), kindName);
    }
  });

  it("installPresetResourceParsers re-applies a binding after it was cleared", () => {
    const resources = PopupTypes.presetResources;
    resources[PopupTypes.PATTERNS].parser = null;
    installPresetResourceParsers(resources);
    assert.equal(resources[PopupTypes.PATTERNS].parser, PatternFile);
  });
});
