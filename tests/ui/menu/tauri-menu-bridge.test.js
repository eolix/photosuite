/**
 * Tauri menu bridge (HTML bar hide, action/path dispatch, install).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { EventType } from "../../../src/core/event-bus.js";

installBrowserGlobals();

let setHtmlMenuBarHidden;
let installTauriMenuActionBridge;
let installNativeMenuFromMenuBarData;
let refreshNativeMenuFromMenuBarData;
let isNativeMenuBarInstalled;
let PHOTOSUITE_MENU_ACTION_EVENT;
let PHOTOSUITE_CHROME_EVENT;

before(async () => {
  ({
    setHtmlMenuBarHidden,
    installTauriMenuActionBridge,
    installNativeMenuFromMenuBarData,
    refreshNativeMenuFromMenuBarData,
    isNativeMenuBarInstalled,
    PHOTOSUITE_MENU_ACTION_EVENT,
    PHOTOSUITE_CHROME_EVENT,
  } = await import("../../../src/ui/menu/tauri-menu-bridge.js"));
});

function installBodyClassList() {
  const classes = new Set();
  globalThis.document.body = {
    classList: {
      add(name) {
        classes.add(name);
      },
      remove(name) {
        classes.delete(name);
      },
      has(name) {
        return classes.has(name);
      },
    },
  };
  return classes;
}

describe("ui/menu/tauri-menu-bridge.js", () => {
  it("export / event name goldens", () => {
    assert.equal(PHOTOSUITE_MENU_ACTION_EVENT, "photosuite:menu-action");
    assert.equal(PHOTOSUITE_CHROME_EVENT, "photosuite:chrome");
    assert.equal(isNativeMenuBarInstalled(), false);
  });

  it("setHtmlMenuBarHidden toggles body class", () => {
    const classes = installBodyClassList();
    setHtmlMenuBarHidden(true);
    assert.equal(classes.has("photosuite-hide-html-menu"), true);
    setHtmlMenuBarHidden(false);
    assert.equal(classes.has("photosuite-hide-html-menu"), false);
  });

  it("installTauriMenuActionBridge is a no-op without Tauri", () => {
    const dispose = installTauriMenuActionBridge({
      getMenuData: () => [],
      dispatchTarget: {},
    });
    assert.equal(typeof dispose, "function");
    dispose();
  });

  it("installNativeMenuFromMenuBarData resolves without Tauri", async () => {
    const result = await installNativeMenuFromMenuBarData({
      getMenuData: () => [],
    });
    assert.equal(result, undefined);
    assert.equal(await refreshNativeMenuFromMenuBarData({ getMenuData: () => [] }), undefined);
  });

  it("menu-action path payload dispatches resolved descriptor", async () => {
    installBodyClassList();
    const listeners = {};
    const events = [];
    const dispatchTarget = {
      dispatch(evt) {
        events.push(evt);
      },
    };
    globalThis.window.__TAURI__ = {
      event: {
        listen(name, handler) {
          listeners[name] = handler;
          return Promise.resolve(() => {
            delete listeners[name];
          });
        },
      },
    };
    const dispose = installTauriMenuActionBridge({
      getMenuData: () => [
        {
          menuActions: [{ appEventType: EventType.uiDispatch, payload: { dispatchKind: 1 } }],
        },
      ],
      dispatchTarget,
    });
    await Promise.resolve();
    listeners[PHOTOSUITE_MENU_ACTION_EVENT]({ payload: { path: [0, 0] } });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, EventType.uiDispatch);
    dispose();
    delete globalThis.window.__TAURI__;
  });

  it("menu-action descriptor payload dispatches without path", async () => {
    const listeners = {};
    const events = [];
    const dispatchTarget = {
      dispatch(evt) {
        events.push(evt);
      },
    };
    globalThis.window.__TAURI__ = {
      event: {
        listen(name, handler) {
          listeners[name] = handler;
          return Promise.resolve(() => {});
        },
      },
    };
    installTauriMenuActionBridge({
      getMenuData: () => [],
      dispatchTarget,
    });
    await Promise.resolve();
    listeners[PHOTOSUITE_MENU_ACTION_EVENT]({
      payload: {
        action: { appEventType: EventType.uiDispatch, payload: { ok: true } },
      },
    });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].data, { ok: true });
    delete globalThis.window.__TAURI__;
  });

  it("chrome hideHtmlMenuBar hides strip and fires resize", async () => {
    const classes = installBodyClassList();
    const listeners = {};
    let resized = false;
    globalThis.window.dispatchEvent = (evt) => {
      if (evt.type === "resize") resized = true;
    };
    globalThis.window.__TAURI__ = {
      event: {
        listen(name, handler) {
          listeners[name] = handler;
          return Promise.resolve(() => {});
        },
      },
    };
    installTauriMenuActionBridge({
      getMenuData: () => [],
      dispatchTarget: {},
    });
    await Promise.resolve();
    listeners[PHOTOSUITE_CHROME_EVENT]({ payload: { hideHtmlMenuBar: true } });
    assert.equal(classes.has("photosuite-hide-html-menu"), true);
    assert.equal(resized, true);
    delete globalThis.window.__TAURI__;
  });
});
