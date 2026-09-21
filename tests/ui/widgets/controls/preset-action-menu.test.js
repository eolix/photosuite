/**
 * preset popup action menu: bundled-library rows and row mapping.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { existsSync } from "node:fs";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

installBrowserGlobals();
globalThis.SmartFilterBase = globalThis.SmartFilterBase || {};

let PopupButton;
let GradientPickerButton;
let SwatchButton;
let BrushPickerButton;
let PatternPickerButton;
let ContourSizeButton;

before(async () => {
  ({ PopupButton, GradientPickerButton, SwatchButton } = await import(
    "../../../../src/ui/widgets/controls/popup-controls.js"
  ));
  ({ BrushPickerButton } = await import(
    "../../../../src/ui/widgets/controls/brush-preset-controls.js"
  ));
  ({ PatternPickerButton } = await import(
    "../../../../src/ui/widgets/controls/effect-pickers.js"
  ));
  ({ ContourSizeButton } = await import(
    "../../../../src/ui/widgets/controls/stroke-layer-controls.js"
  ));
});

describe("preset popup bundled libraries", () => {
  it("every library a picker offers is actually shipped", () => {
    // These are runtime strings resolved under resources/. A missing file shows a menu
    // row that silently does nothing when clicked.
    const pickers = [
      GradientPickerButton, SwatchButton, BrushPickerButton,
      PatternPickerButton, ContourSizeButton
    ];
    for (const picker of pickers) {
      for (const url of picker.prototype.listBundledPresetUrls.call({})) {
        assert.ok(
          existsSync("src/resources/" + url),
          url + " is offered by a picker but missing from src/resources/"
        );
      }
    }
  });

  it("each preset kind points at its own library", () => {
    const urlOf = (picker) => picker.prototype.listBundledPresetUrls.call({});
    assert.deepEqual(urlOf(BrushPickerButton), ["basic/extra_brushes.abr"]);
    assert.deepEqual(urlOf(GradientPickerButton), ["basic/extra_gradients.grd"]);
    assert.deepEqual(urlOf(PatternPickerButton), ["basic/extra_patterns.pat"]);
    assert.deepEqual(urlOf(ContourSizeButton), ["basic/extra_shapes.csh"]);
    assert.deepEqual(PopupButton.prototype.listBundledPresetUrls.call({}), []);
  });
});
