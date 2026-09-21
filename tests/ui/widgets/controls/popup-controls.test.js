/**
 * popup-controls pure helper goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let accumulateGroupBreakPositions;
let buildDropdownOptionIndexMap;
let resolveDropdownLogicalIndex;
let buildImportExtensionFilter;
let adjustPresetActionIndex;
let computeBlendIfSectionOffset;
let normalizeSwatchPickColor;
let PopupButton;
let ModeDropdown;
let ButtonMenu;
let IconRenderer;
let Dropdown;
let GradientPickerButton;
let SwatchButton;
let RadioOption;
let RadioGroup;
let AntialiasingOption;
let DocumentSelector;
let CheckboxList;
let ConfirmWidget;

before(async () => {
  ({
    accumulateGroupBreakPositions,
    buildDropdownOptionIndexMap,
    resolveDropdownLogicalIndex,
    buildImportExtensionFilter,
    adjustPresetActionIndex,
    computeBlendIfSectionOffset,
    normalizeSwatchPickColor,
    PopupButton,
    ModeDropdown,
    ButtonMenu,
    IconRenderer,
    Dropdown,
    GradientPickerButton,
    SwatchButton,
    RadioOption,
    RadioGroup,
    AntialiasingOption,
    DocumentSelector,
    CheckboxList,
    ConfirmWidget
  } = await import("../../../../src/ui/widgets/controls/popup-controls.js"));
});

describe("ui/widgets/controls/popup-controls.js", () => {
  it("accumulateGroupBreakPositions goldens", () => {
    assert.deepEqual(accumulateGroupBreakPositions([3, 2]), [3, 5]);
    assert.deepEqual(accumulateGroupBreakPositions(null), []);
  });

  it("dropdown option index map goldens", () => {
    var optionIndexMap = buildDropdownOptionIndexMap(6, [3, 5]);
    assert.deepEqual(optionIndexMap, [0, 1, 2, 4, 5, 7]);
    assert.equal(resolveDropdownLogicalIndex(optionIndexMap, 4), 3);
  });

  it("buildImportExtensionFilter goldens", () => {
    assert.equal(buildImportExtensionFilter("ICC"), "icc .cube .look .3dl");
    assert.equal(buildImportExtensionFilter("PNG"), "PNG");
  });

  it("adjustPresetActionIndex goldens", () => {
    assert.equal(adjustPresetActionIndex(0, true), 0);
    assert.equal(adjustPresetActionIndex(0, false), 1);
  });

  it("computeBlendIfSectionOffset goldens", () => {
    assert.equal(computeBlendIfSectionOffset(1, 1), 8);
    assert.equal(computeBlendIfSectionOffset(1, 2), 12);
  });

  it("normalizeSwatchPickColor golden", () => {
    assert.deepEqual(normalizeSwatchPickColor({ l: 1, i: 2, c: 3, name: "x" }), {
      h: 1,
      l: 2,
      O: 3,
      name: "x"
    });
    assert.deepEqual(normalizeSwatchPickColor({ h: 9, l: 2, O: 3 }), { h: 9, l: 2, O: 3 });
  });

  it("exports constructors", () => {
    assert.equal(typeof PopupButton, "function");
    assert.equal(typeof ModeDropdown, "function");
    assert.equal(typeof ButtonMenu, "function");
    assert.equal(typeof IconRenderer, "function");
    assert.equal(typeof Dropdown, "function");
    assert.equal(typeof GradientPickerButton, "function");
    assert.equal(typeof SwatchButton, "function");
    assert.equal(typeof RadioOption, "function");
    assert.equal(typeof AntialiasingOption, "function");
    assert.equal(typeof DocumentSelector, "function");
    assert.equal(typeof CheckboxList, "function");
    assert.equal(typeof ConfirmWidget, "function");
  });

  // RadioGroup backs a single-choice form row with native radio inputs sharing
  // one name, so selecting one clears the rest. RadioOption beside it is a
  // multi-toggle group and deliberately does not behave this way.
  describe("RadioGroup", () => {
    it("starts on the first option and reports the selected index", () => {
      const group = new RadioGroup(null, ["a", "b"]);
      assert.equal(group.getValue(), 0);
      group.setValue(1);
      assert.equal(group.getValue(), 1);
    });

    it("keeps exactly one option selected", () => {
      const group = new RadioGroup(null, ["a", "b", "c"]);
      group.setValue(2);
      assert.equal(group.inputElements.filter((el) => el.checked).length, 1);
      assert.equal(group.inputElements[2].checked, true);
    });

    it("builds one input and one label per option", () => {
      const group = new RadioGroup(null, ["a", "b"]);
      assert.equal(group.inputElements.length, 2);
      assert.equal(group.labelElements.length, 2);
    });

    it("does not share a group name with a second RadioGroup", () => {
      const first = new RadioGroup(null, ["a", "b"]);
      const second = new RadioGroup(null, ["a", "b"]);
      assert.notEqual(first.groupName, second.groupName);
    });
  });
});
