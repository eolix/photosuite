/**
 * Native Tauri drag-and-drop onto the empty-state home screen.
 * Uses window-level `tauri://drag-*` events so dropped files keep absolute
 * paths and load through the same `read_file_raw` path as File → Open.
 */

import { addClass, removeClass } from "../../core/dom.js";

/**
 * True when the Photoshop-style home screen is showing and accepts file opens.
 * @param {{ appData: { intro?: boolean }, openDocs: Array<unknown> }} controller
 * @returns {boolean}
 */
export function homeScreenAcceptsFileDrop(controller) {
  return controller.appData.intro === true && controller.openDocs.length === 0;
}

/** True when Tauri window-level drag-drop events are available. */
export function isTauriNativeFileDropEnabled() {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  return !!(tauri && tauri.event && typeof tauri.event.listen === "function");
}

/**
 * Hit-test a Tauri drag-drop cursor position against a DOM element.
 * Tauri reports physical pixels relative to the webview; layout rects are CSS px.
 *
 * @param {{ x: number, y: number }|null|undefined} position
 * @param {Element|null|undefined} element
 * @returns {boolean}
 */
export function dropPositionOverElement(position, element) {
  if (element == null) return false;
  if (position == null || typeof position.x !== "number" || typeof position.y !== "number") {
    return true;
  }
  const rect = element.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const x = position.x / scale;
  const y = position.y / scale;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * @param {*} controller AppController instance (needs fileLoader + splashScreen).
 * @returns {function(): void} Unlisten disposer; no-op when Tauri events are unavailable.
 */
export function installTauriHomeScreenFileDrop(controller) {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (!tauri || !tauri.event || typeof tauri.event.listen !== "function") {
    return function() {};
  }

  let dragDepth = 0;
  const unlistenFns = [];

  function homeDropTargetEl() {
    const splash = controller.splashScreen;
    return splash && splash.homePanelRoot ? splash.homePanelRoot : null;
  }

  function setHighlight(active) {
    const splash = controller.splashScreen;
    if (!splash || !splash.homePanelRoot) return;
    if (active) addClass(splash.homePanelRoot, "home-screen--drop-target");
    else removeClass(splash.homePanelRoot, "home-screen--drop-target");
  }

  function acceptsDropAt(position) {
    if (!homeScreenAcceptsFileDrop(controller)) return false;
    return dropPositionOverElement(position, homeDropTargetEl());
  }

  function onDragEnter(event) {
    if (!acceptsDropAt(event.payload && event.payload.position)) return;
    dragDepth += 1;
    setHighlight(true);
  }

  function onDragLeave() {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setHighlight(false);
  }

  function onDragDrop(event) {
    dragDepth = 0;
    setHighlight(false);
    const payload = event.payload;
    if (!acceptsDropAt(payload && payload.position)) return;
    const paths = payload && payload.paths;
    if (!paths || paths.length === 0) return;
    if (controller.runSavedScriptIfAny("open")) return;
    controller.fileLoader.openFilesByPaths(paths, null);
  }

  const listenPromises = [
    tauri.event.listen("tauri://drag-enter", onDragEnter),
    tauri.event.listen("tauri://drag-leave", onDragLeave),
    tauri.event.listen("tauri://drag-drop", onDragDrop)
  ];

  Promise.all(listenPromises).then(function(handles) {
    for (let handleIdx = 0; handleIdx < handles.length; handleIdx++) {
      unlistenFns.push(handles[handleIdx]);
    }
  }).catch(function(err) {
    console.warn("photosuite: home-screen file drop listeners failed", err);
  });

  return function disposeTauriHomeScreenFileDrop() {
    for (let handleIdx = 0; handleIdx < unlistenFns.length; handleIdx++) {
      unlistenFns[handleIdx]();
    }
    unlistenFns.length = 0;
    dragDepth = 0;
    setHighlight(false);
  };
}
