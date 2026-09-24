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

// The layer-style and shape pickers drop the "Define New" row, so their rows
// sit one place earlier than every other picker's. Mapping a click back to the
// wrong row is not a no-op: "Load" one place off is "Export", which opens a
// Save panel over the library the user was trying to load.
describe("preset popup row mapping", () => {
  function pickerStub(defineNewPresetKind, bundledUrls) {
    const dispatched = [];
    let viewMode = 0;
    return {
      dispatched,
      defineNewPresetKind,
      popupTypeId: "STYLES",
      menuList: {
        setViewMode(mode) { viewMode = mode; },
        getViewMode() { return viewMode; }
      },
      listBundledPresetUrls() { return bundledUrls || []; },
      getEditorPresetPayload() { return [{}]; },
      dispatch(event) { dispatched.push(event); }
    };
  }

  /** What clicking the row at `rowIndex` of the open menu actually does. */
  function pickRow(picker, rowIndex) {
    PopupButton.prototype.selectItem.call(picker, {
      target: { getSelectedIndices: () => [rowIndex] }
    });
    const event = picker.dispatched.pop();
    return event ? event.data.dispatchKind : "viewMode";
  }

  it("maps each row of a picker without Define New", () => {
    const picker = pickerStub(null, ["basic/extra.asl"]);
    assert.equal(pickRow(picker, 0), "viewMode");
    assert.equal(pickRow(picker, 1), "pickLocalFiles", "Load did not open the file picker");
    assert.equal(pickRow(picker, 2), "exportPopupResourceBundle");
    assert.equal(pickRow(picker, 3), "importFromUrl");
  });

  it("maps each row of a picker with Define New", () => {
    const picker = pickerStub("PATTERNS", ["basic/extra_patterns.pat"]);
    assert.equal(pickRow(picker, 0), "openResourcePresetPopup");
    assert.equal(pickRow(picker, 1), "viewMode");
    assert.equal(pickRow(picker, 2), "pickLocalFiles");
    assert.equal(pickRow(picker, 3), "exportPopupResourceBundle");
    assert.equal(pickRow(picker, 4), "importFromUrl");
  });
});
