/**
 * CharacterPanel / ParagraphPanel (shared FontComboBox host).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { isInDOM, makeElement } from "../../../src/core/dom.js";

installBrowserGlobals();

let CharacterPanel;
let PopupTypes;

before(async () => {
  ({ PopupTypes } = await import("../../../src/ui/config/popup-types.js"));
  ({ CharacterPanel } = await import("../../../src/ui/panels/character-panel.js"));
});

describe("ui/panels/character-panel.js", () => {
  it("character vs paragraph constructor goldens", () => {
    const character = new CharacterPanel(true);
    const paragraph = new CharacterPanel(false);
    assert.equal(character.isCharacterMode, true);
    assert.equal(paragraph.isCharacterMode, false);
    assert.equal(character.fontBox, null);
    assert.equal(paragraph.fontBox, null);
    assert.ok(character.panelBody);
    assert.ok(paragraph.panelBody);
  });

  it("onUpdate applies text style only for allowed popup types", () => {
    const panel = new CharacterPanel(true);
    const calls = [];
    panel.fontBox = {
      setValue: (...args) => calls.push(args),
      buildUI: () => {},
    };
    const doc = {
      currentTextStyle: { Sz: { t: "UntF", v: { val: 12 } } },
      fontRegistry: { list: [] },
      favoriteFontFamilies: ["Arial"],
    };
    panel.onUpdate(doc, PopupTypes.BRUSHES);
    assert.equal(calls.length, 0);

    panel.onUpdate(doc, PopupTypes.ALL);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], doc.currentTextStyle);
    assert.equal(calls[0][1], doc.fontRegistry);
    assert.deepEqual(calls[0][2], ["Arial"]);

    panel.onUpdate(doc, PopupTypes.EXPORT_AS);
    panel.onUpdate(doc, PopupTypes.OPEN_RECENT);
    panel.onUpdate(doc, PopupTypes.ABOUT);
    assert.equal(calls.length, 4);
  });

  it("refresh builds FontComboBox once when panel is in DOM", () => {
    const panel = new CharacterPanel(true);
    document.body.appendChild(panel.panelBody);
    panel.doc = {
      currentTextStyle: { Nm: { t: "TEXT", v: "x" } },
      fontRegistry: {},
      favoriteFontFamilies: [],
    };
    const setValues = [];
    let buildUiCount = 0;
    // Force layout path with a stub FontComboBox by temporarily wrapping buildFormLayout
    const original = CharacterPanel.prototype.buildFormLayout;
    CharacterPanel.prototype.buildFormLayout = function() {
      this.fontBox = {
        parent: null,
        setValue: (...args) => setValues.push(args),
        buildUI: () => {
          buildUiCount++;
        },
        fontNameInput: { el: makeElement("div", "") },
        fontSizeInput: { el: makeElement("div", "") },
        trackingInput: { el: makeElement("div", "") },
        leadingInput: { el: makeElement("div", "") },
        autoLeadingCheckbox: { el: makeElement("div", "") },
        verticalScaleInput: { el: makeElement("div", "") },
        horizontalScaleInput: { el: makeElement("div", "") },
        baselineShiftInput: { el: makeElement("div", "") },
        fillColorPicker: { el: makeElement("div", "") },
        boldButton: { el: makeElement("div", "") },
        italicButton: { el: makeElement("div", "") },
        allCapsButton: { el: makeElement("div", "") },
        smallCapsButton: { el: makeElement("div", "") },
        superscriptButton: { el: makeElement("div", "") },
        subscriptButton: { el: makeElement("div", "") },
        underlineButton: { el: makeElement("div", "") },
        strikethroughButton: { el: makeElement("div", "") },
      };
    };
    try {
      panel.refresh();
      assert.ok(panel.fontBox);
      assert.equal(setValues.length, 1);
      assert.equal(buildUiCount, 1);
      panel.refresh();
      assert.equal(buildUiCount, 1);
      assert.equal(setValues.length, 1);
    } finally {
      CharacterPanel.prototype.buildFormLayout = original;
    }
  });
});
