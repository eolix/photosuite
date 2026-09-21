/**
 * MenuBar HTML strip (buttons, context, command palette dispatch).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { EventType, UiCommand } from "../../../src/core/event-bus.js";
import { addPointerDownListener, clearElement, isInDOM, preventDomDefaultAction } from "../../../src/core/dom.js";
import { iconImgHtml } from "../../../src/assets/icon-registry.js";

installBrowserGlobals();

let MenuBar;
let AppEvent;
let PopupTypes;

before(async () => {
  ({ PopupTypes } = await import("../../../src/ui/config/popup-types.js"));
  const { Locale } = await import("../../../src/core/i18n/locale.js");
  Locale.get = (key) => (typeof key === "string" ? key : String(key));
  ({ MenuBar } = await import("../../../src/ui/menu/menu-bar.js"));
});

function installMenuBarDomStubs() {
  const childrenByEl = new WeakMap();
  const prev = globalThis.document.createElement.bind(globalThis.document);
  globalThis.document.createElement = function (tag, className) {
    const el = prev(tag);
    // The bar is built off screen in these goldens, so the menu code skips the
    // work it only does for a mounted bar.
    el.parentNode = null;
    el.className = className || "";
    el.children = [];
    el.style = el.style || {};
    el.textContent = "";
    el.setAttribute = () => {};
    el.getAttribute = () => null;
    el.addEventListener = () => {};
    el.removeEventListener = () => {};
    Object.defineProperty(el, "firstChild", {
      get() {
        return this.children[0];
      },
      configurable: true,
    });
    el.appendChild = function (child) {
      this.children.push(child);
      return child;
    };
    el.removeChild = function (child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) this.children.splice(idx, 1);
      return child;
    };
    el.getBoundingClientRect = () => ({
      left: 10,
      top: 20,
      width: 40,
      height: 18,
      right: 50,
      bottom: 38,
    });
    childrenByEl.set(el, el.children);
    return el;
  };
}

describe("ui/menu/menu-bar.js", () => {
  it("constructor goldens", () => {
    installMenuBarDomStubs();
    MenuBar.data = [
      { name: "topMenu.file", items: [], menuActions: [] },
      { name: "topMenu.edit", items: [], menuActions: [] },
    ];
    const bar = new MenuBar();
    assert.equal(bar.topLevelMenuButtons.length, 2);
    assert.equal(bar.menuDropdowns.length, 0);
    assert.equal(bar.lastOpenMenuIndex, 0);
    assert.equal(bar.menuContextDoc, null);
    assert.equal(bar.menuContextAppData, null);
    assert.ok(bar.searchButton);
  });

  it("setMenuContext stores doc and appData", () => {
    installMenuBarDomStubs();
    MenuBar.data = [{ name: "topMenu.file", items: [], menuActions: [] }];
    const bar = new MenuBar();
    const doc = { id: 1 };
    const appData = { theme: 0 };
    bar.setMenuContext(doc, appData);
    assert.equal(bar.menuContextDoc, doc);
    assert.equal(bar.menuContextAppData, appData);
  });

  it("onOpenCommandPaletteClick dispatches openCommandPaletteSearch", () => {
    installMenuBarDomStubs();
    MenuBar.data = [{ name: "topMenu.file", items: [], menuActions: [] }];
    const bar = new MenuBar();
    const events = [];
    bar.dispatch = (evt) => events.push(evt);
    bar.onOpenCommandPaletteClick({});
    assert.equal(events.length, 1);
    assert.equal(events[0].type, EventType.uiDispatch);
    assert.equal(events[0].data.dispatchKind, UiCommand.openCommandPaletteSearch);
  });

  it("onUpdate with PopupTypes.ALL respects menuVisibility", () => {
    installMenuBarDomStubs();
    MenuBar.data = [
      { name: "topMenu.file", items: [{ name: "a" }], menuActions: [{}] },
      { name: "topMenu.edit", items: [{ name: "b" }], menuActions: [{}] },
    ];
    const bar = new MenuBar();
    bar.menuDropdowns = [
      { applyRowVisibility() {}, update() {}, buildUI() {} },
      { applyRowVisibility() {}, update() {}, buildUI() {} },
    ];
    let visibilityApplied = false;
    bar.menuDropdowns[0].applyRowVisibility = (rows) => {
      visibilityApplied = rows.length === 1;
    };
    bar.onUpdate({ menuVisibility: [ [0], null ] }, PopupTypes.ALL);
    assert.equal(bar.menuButtonsHost.children.length, 1);
    assert.equal(visibilityApplied, true);
  });

  it("onDragStart dispatches floating overlay for the selected dropdown", () => {
    installMenuBarDomStubs();
    MenuBar.data = [
      { name: "topMenu.file", items: [], menuActions: [] },
      { name: "topMenu.edit", items: [], menuActions: [] },
    ];
    const bar = new MenuBar();
    const firstDropdown = { el: globalThis.document.createElement("div"), update() {}, buildUI() {} };
    const secondDropdown = { el: globalThis.document.createElement("div"), update() {}, buildUI() {} };
    bar.menuDropdowns = [firstDropdown, secondDropdown];
    bar.ensureMenuDropdownsInitialized = function() {};
    const events = [];
    bar.dispatch = (evt) => events.push(evt);
    const button = bar.topLevelMenuButtons[1];
    const evt = { type: "pointerdown", currentTarget: button, target: button, skipOverlayDismiss: false };
    bar.onDragStart(evt);
    assert.equal(evt.skipOverlayDismiss, true);
    assert.equal(bar.lastOpenMenuIndex, 1);
    assert.equal(events[0].data.dispatchKind, UiCommand.showFloatingOverlay);
    assert.equal(events[0].data.overlayWidget, secondDropdown);
    assert.equal(events[0].data.pinToAnchorY, true);
  });
});
