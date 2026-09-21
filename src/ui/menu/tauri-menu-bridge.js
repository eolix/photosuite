/**
 * Tauri shell ↔ webview bridge: install/refresh native menus, handle
 * photosuite:menu-action, and turn a shell quit request into the app's own
 * exit flow. Menu definitions live in menu-bar-data.js only.
 * See src/ui/menu/README.md.
 */

import {
  dispatchMenuActionDescriptor,
  isMenuActionDescriptor,
  resolveMenuBarAction
} from "./menu-action-dispatch.js";
import { buildNativeMenuSpec } from "./native-menu-spec.js";
import { EventType, UiCommand } from "../../core/event-bus.js";

const PHOTOSUITE_MENU_ACTION_EVENT = "photosuite:menu-action";
const PHOTOSUITE_CHROME_EVENT = "photosuite:chrome";
const PHOTOSUITE_QUIT_REQUEST_EVENT = "photosuite:quit-requested";
const HTML_MENU_HIDDEN_CLASS = "photosuite-hide-html-menu";

let nativeMenuInstalled = false;

/** Show or hide the in-window HTML menu strip (macOS native menu uses the shell bar). */
export function setHtmlMenuBarHidden(hidden) {
  if (typeof document === "undefined" || !document.body) return;
  if (hidden) {
    document.body.classList.add(HTML_MENU_HIDDEN_CLASS);
  } else {
    document.body.classList.remove(HTML_MENU_HIDDEN_CLASS);
  }
}

/**
 * @param {object} options
 * @param {function(): Array<{ menuActions: Array<object> }>} options.getMenuData
 * @param {{ dispatch: function }} options.dispatchTarget
 * @returns {function(): void} Unlisten disposer; no-op when Tauri is unavailable.
 */
export function installTauriMenuActionBridge(options) {
  const getMenuData = options.getMenuData;
  const dispatchTarget = options.dispatchTarget;
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (!tauri || !tauri.event || typeof tauri.event.listen !== "function") {
    return function() {};
  }

  function handleMenuPayload(payload) {
    handleMenuActionPayload(payload, getMenuData, dispatchTarget);
  }

  function handleChromePayload(payload) {
    applyChromePayload(payload);
  }

  const unlistenMenuPromise = tauri.event.listen(PHOTOSUITE_MENU_ACTION_EVENT, function(ev) {
    handleMenuPayload(ev.payload);
  });
  unlistenMenuPromise.then(function(unlisten) {
    dispatchTarget._photosuiteTauriMenuUnlisten = unlisten;
  }).catch(function() {});

  const unlistenChromePromise = tauri.event.listen(PHOTOSUITE_CHROME_EVENT, function(ev) {
    handleChromePayload(ev.payload);
  });
  unlistenChromePromise.then(function(unlisten) {
    dispatchTarget._photosuiteTauriChromeUnlisten = unlisten;
  }).catch(function() {});

  // The shell holds the window open until the exit flow prompts for unsaved
  // work and invokes the exit command back on the shell.
  const unlistenQuitPromise = tauri.event.listen(PHOTOSUITE_QUIT_REQUEST_EVENT, function() {
    dispatchMenuActionDescriptor(dispatchTarget, {
      appEventType: EventType.uiDispatch,
      payload: { dispatchKind: UiCommand.exitApplication }
    });
  });
  unlistenQuitPromise.then(function(unlisten) {
    dispatchTarget._photosuiteTauriQuitUnlisten = unlisten;
  }).catch(function() {});

  return function() {
    clearMenuActionUnlisten(dispatchTarget);
    clearChromeUnlisten(dispatchTarget);
    clearQuitRequestUnlisten(dispatchTarget);
  };
}

/**
 * Push the full MenuBar.data tree to the macOS menu bar (exact labels + paths).
 *
 * @param {object} options
 * @param {function(): Array} options.getMenuData
 * @param {function(): *} [options.getCurrentDoc]
 * @param {function(): *} [options.getAppData]
 * @param {function(): void} [options.onHtmlMenuBarHidden] layout refresh after hiding HTML bar
 */
export function installNativeMenuFromMenuBarData(options) {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") {
    return Promise.resolve();
  }
  const spec = buildNativeMenuSpec(
    options.getMenuData(),
    options.getCurrentDoc ? options.getCurrentDoc() : null,
    options.getAppData ? options.getAppData() : null
  );
  if (spec.hideHtmlMenuBar) {
    setHtmlMenuBarHidden(true);
  }
  return tauri.core.invoke("photosuite_install_native_menu", { spec: spec }).then(function() {
    nativeMenuInstalled = true;
    if (spec.hideHtmlMenuBar && typeof options.onHtmlMenuBarHidden === "function") {
      options.onHtmlMenuBarHidden();
    }
  });
}

/** Rebuild macOS menu labels, enabled state, and accelerators from current doc + Locale. */
export function refreshNativeMenuFromMenuBarData(options) {
  return installNativeMenuFromMenuBarData(options);
}

export function isNativeMenuBarInstalled() {
  return nativeMenuInstalled;
}

export {
  PHOTOSUITE_MENU_ACTION_EVENT,
  PHOTOSUITE_CHROME_EVENT,
  PHOTOSUITE_QUIT_REQUEST_EVENT
};

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function handleMenuActionPayload(payload, getMenuData, dispatchTarget) {
  if (!payload) return;
  if (isMenuActionDescriptor(payload.action)) {
    dispatchMenuActionDescriptor(dispatchTarget, payload.action);
    return;
  }
  if (payload.path != null) {
    const node = resolveMenuBarAction(getMenuData(), payload.path);
    if (!node) return;
    dispatchMenuActionDescriptor(dispatchTarget, node);
  }
}

function applyChromePayload(payload) {
  if (!payload) return;
  if (payload.hideHtmlMenuBar) {
    setHtmlMenuBarHidden(true);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("resize"));
    }
  }
}

function clearMenuActionUnlisten(dispatchTarget) {
  if (typeof dispatchTarget._photosuiteTauriMenuUnlisten === "function") {
    dispatchTarget._photosuiteTauriMenuUnlisten();
    dispatchTarget._photosuiteTauriMenuUnlisten = null;
  }
}

function clearChromeUnlisten(dispatchTarget) {
  if (typeof dispatchTarget._photosuiteTauriChromeUnlisten === "function") {
    dispatchTarget._photosuiteTauriChromeUnlisten();
    dispatchTarget._photosuiteTauriChromeUnlisten = null;
  }
}

function clearQuitRequestUnlisten(dispatchTarget) {
  if (typeof dispatchTarget._photosuiteTauriQuitUnlisten === "function") {
    dispatchTarget._photosuiteTauriQuitUnlisten();
    dispatchTarget._photosuiteTauriQuitUnlisten = null;
  }
}
