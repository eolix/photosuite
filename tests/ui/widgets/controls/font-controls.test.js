/**
 * font-controls helper goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let packTextFillColorFromPackedRgb;
let iconButtonHtml;
let indentIconHtml;
let FontComboBox;
let FontNameInput;

before(async () => {
  ({
    packTextFillColorFromPackedRgb,
    iconButtonHtml,
    indentIconHtml,
    FontComboBox,
    FontNameInput
  } = await import("../../../../src/ui/widgets/controls/font-controls.js"));
});

describe("ui/widgets/controls/font-controls.js", () => {
  it("packTextFillColorFromPackedRgb goldens", () => {
    assert.deepEqual(packTextFillColorFromPackedRgb(0xff8000), {
      Type: 1,
      Values: [1, 1, 0.502, 0]
    });
    assert.deepEqual(packTextFillColorFromPackedRgb(0), {
      Type: 1,
      Values: [1, 0, 0, 0]
    });
  });

  it("iconButtonHtml / indentIconHtml markup", () => {
    assert.equal(
      iconButtonHtml("type/bold"),
      "<img src=\"/assets/ico/type/bold.svg\" class=\"autoscale gsicon\" />"
    );
    assert.equal(
      indentIconHtml("lind"),
      "<img src=\"/assets/ico/par/lind.svg\" class=\"autoscale gsicon\" /> "
    );
  });

  it("exports FontComboBox and FontNameInput", () => {
    assert.equal(typeof FontComboBox, "function");
    assert.equal(typeof FontNameInput, "function");
  });
});
