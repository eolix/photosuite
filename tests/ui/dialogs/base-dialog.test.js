/**
 * Behavioral tests for BaseDialog shell (construct, resize, measure, dismiss).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { EventType } from "../../../src/core/event-bus.js";
import { isInDOM } from "../../../src/core/dom.js";

installBrowserGlobals();

document.createElement = function () {
  const attrs = {};
  return {
    width: 0,
    height: 0,
    // nodeType 9 is DOCUMENT_NODE: core/dom.js isInDOM() walks parentNode for
    // it, and a dialog only measures itself once it is on screen.
    parentNode: document,
    style: {},
    className: "",
    children: [],
    scrollWidth: 0,
    scrollHeight: 0,
    offsetWidth: 0,
    offsetTop: 0,
    setAttribute(name, value) {
      attrs[name] = value;
      if (name === "class") this.className = value;
    },
    getAttribute(name) {
      if (name === "class") return attrs.class != null ? attrs.class : this.className || null;
      return attrs[name] != null ? attrs[name] : null;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    getContext() {
      return null;
    },
  };
};

let BaseDialog;
let Locale;

before(async () => {
  ({ Locale } = await import("../../../src/core/i18n/locale.js"));
  Locale.get = function (key) {
    return key;
  };
  ({ BaseDialog } = await import("../../../src/ui/dialogs/base-dialog.js"));
});

describe("ui/dialogs/base-dialog.js", () => {
  it("exposes chrome / content size constants", () => {
    assert.equal(BaseDialog.DEFAULT_CONTENT_WIDTH, 920);
    assert.equal(BaseDialog.DEFAULT_CONTENT_HEIGHT, 600);
    assert.equal(BaseDialog.CHROME_HEADER_HEIGHT, 34);
    assert.equal(BaseDialog.CONTENT_SIZE_PAD, 10);
    assert.equal(BaseDialog.CONTENT_SIZE_MIN_W, 200);
    assert.equal(BaseDialog.CONTENT_SIZE_MIN_H, 80);
  });

  it("null titleLocaleKey seeds prototype without building DOM", () => {
    const seed = new BaseDialog(null, "unused");
    assert.equal(seed.titleLocaleKey, undefined);
    assert.equal(seed.isActive(), false);
    assert.equal(seed.canOpen(), true);
    assert.equal(seed.hasOverlay(), false);
  });

  it("constructs chrome and stores titleLocaleKey", () => {
    const dialog = new BaseDialog("dialogs.testTitle", "testdialog");
    assert.equal(dialog.id, "testdialog");
    assert.equal(dialog.titleLocaleKey, "dialogs.testTitle");
    assert.match(dialog.el.className, /window testdialog/);
    assert.equal(dialog.userResizeEnabled, false);
    assert.equal(dialog.isUserResizable(), false);
    assert.match(dialog.closeBtn.getAttribute("style") || "", /background-image:url\(/);
  });

  it("enableUserResize installs grip and clamps getUserContentSize", () => {
    const dialog = new BaseDialog("dialogs.testTitle", "resize_me");
    dialog.enableUserResize({ width: 700, height: 400, minWidth: 500, minHeight: 300 });
    assert.equal(dialog.isUserResizable(), true);
    assert.match(dialog.el.className, /wuserresize/);
    assert.ok(dialog.resizeGripEl);
    assert.deepEqual(dialog.getUserContentSize(600, 350), { width: 600, height: 350 });
    assert.equal(dialog.userContentWidth, 600);
    assert.equal(dialog.userContentHeight, 350);
  });

  it("measureBodyContentSize clamps measured body size", () => {
    const dialog = new BaseDialog("dialogs.testTitle", "measure_me");
    Object.defineProperty(dialog.body, "scrollWidth", { value: 50, configurable: true });
    Object.defineProperty(dialog.body, "scrollHeight", { value: 40, configurable: true });
    assert.deepEqual(dialog.measureBodyContentSize(500, 400), {
      width: 200,
      height: 80,
    });
    dialog.body.setAttribute("class", "body flexrow");
    Object.defineProperty(dialog.body, "offsetWidth", { value: 300, configurable: true });
    Object.defineProperty(dialog.body, "scrollHeight", { value: 100, configurable: true });
    assert.deepEqual(dialog.measureBodyContentSize(500, 400, 10), {
      width: 310,
      height: 110,
    });
  });

  it("dismissFromCloseControl dispatches closebtn then layerEffectsFlush", () => {
    const dialog = new BaseDialog("dialogs.testTitle", "close_me");
    const types = [];
    dialog.dispatch = function (evt) {
      types.push(evt.type);
    };
    dialog.dismissFromCloseControl();
    assert.deepEqual(types, ["closebtn", EventType.layerEffectsFlush]);
  });
});
