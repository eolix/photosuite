/**
 * Top-level shell host: document canvas column, overlay stack, link bar, and rAF loop.
 *
 * AppController takes this prototype and chains to the constructor, so the
 * default chrome is installed once per shell.
 */

import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { ThemeConfig } from "../config/theme-config.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { DocumentView } from "./document-view.js";
import { OverlayManager } from "./overlay-manager.js";
import { LinkBar } from "../layout/chrome-header-bars.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { makeElement } from "../../core/dom.js";

function AppWindow() {
  BaseWidget.call(this);
  installDefaultChrome(this);
}

AppWindow.prototype = Object.create(BaseWidget.prototype);

/**
 * rAF tick: subclasses implement onAnimationFrame; this schedules the next frame.
 * @param {number} [_frameTime] DOMHighResTimeStamp from requestAnimationFrame (unused).
 */
AppWindow.prototype.scheduleAnimationFrame = function(_frameTime) {
  this.onAnimationFrame();
  window.requestAnimationFrame(this.animationFrameHandle);
};

/** No-op hook; AppController overrides to build menus, sidebars, and document chrome. */
AppWindow.prototype.buildUI = function() {};

/**
 * Window resize listener — reads viewport and forwards to child hosts.
 * @param {Event} [_resizeEvent]
 */
AppWindow.prototype.onResize = function(_resizeEvent) {
  this.resize(window.innerWidth, window.innerHeight);
};

/**
 * Resize overlay stack and document view to the given viewport size.
 * @param {number} widthPx
 * @param {number} heightPx
 */
AppWindow.prototype.resize = function(widthPx, heightPx) {
  this.overlayManager.resize(widthPx, heightPx);
  this.documentView.resize(widthPx, heightPx);
};

/**
 * Handle overlay-related uiDispatch events on the shell host.
 * @param {{ data: object }} dispatchEvent
 */
AppWindow.prototype.onUiDispatch = function(dispatchEvent) {
  routeOverlayUiDispatch(this.overlayManager, dispatchEvent.data);
};

export { AppWindow, mountChildWidget, routeOverlayUiDispatch };

// ---------------------------------------------------------------------------
// Construction phases
// ---------------------------------------------------------------------------

/**
 * Install theme, DOM column, keyboard, child hosts, uiDispatch listener, and rAF loop.
 * @param {AppWindow} appWindow
 */
function installDefaultChrome(appWindow) {
  ThemeConfig.applyTheme(1);
  appWindow.el = makeElement("div", "flexrow app");
  appWindow.mainColumn = makeElement("div");
  appWindow.el.appendChild(appWindow.mainColumn);

  appWindow.keyboardHandler = new KeyboardHandler();
  bindWindowLifecycle(appWindow);

  const mainColumnEl = appWindow.mainColumn;
  appWindow.documentView = mountChildWidget(appWindow, new DocumentView(), mainColumnEl);
  appWindow.overlayManager = mountChildWidget(appWindow, new OverlayManager(), mainColumnEl);
  appWindow.linkBar = mountChildWidget(appWindow, new LinkBar(true), mainColumnEl);

  appWindow.on(EventType.uiDispatch, appWindow.onUiDispatch, appWindow);
  startShellAnimationLoop(appWindow);
}

/**
 * Bind blur (keyboard reset) and resize to the window for this shell host.
 * @param {AppWindow} appWindow
 */
function bindWindowLifecycle(appWindow) {
  window.addEventListener(
    "blur",
    function() {
      appWindow.keyboardHandler.reset();
    },
    false
  );
  window.addEventListener("resize", appWindow.onResize.bind(appWindow), false);
}

/**
 * Start the continuous requestAnimationFrame loop for the shell.
 * @param {AppWindow} appWindow
 */
function startShellAnimationLoop(appWindow) {
  appWindow.animationFrameHandle = appWindow.scheduleAnimationFrame.bind(appWindow);
  window.requestAnimationFrame(appWindow.animationFrameHandle);
}

// ---------------------------------------------------------------------------
// Child mounting + overlay dispatch
// ---------------------------------------------------------------------------

/**
 * Set child.parent and append child.el under hostEl.
 * @param {object} parentWidget
 * @param {{ el: Element, parent?: object }} childWidget
 * @param {Element} hostEl
 * @returns {typeof childWidget}
 */
function mountChildWidget(parentWidget, childWidget, hostEl) {
  childWidget.parent = parentWidget;
  hostEl.appendChild(childWidget.el);
  return childWidget;
}

/**
 * Map overlay uiDispatch kinds onto OverlayManager methods.
 * Unknown kinds are ignored (AppController handles the rest).
 * @param {object} overlayManager
 * @param {{ dispatchKind: string, bannerLabel?: string }} dispatchData
 */
function routeOverlayUiDispatch(overlayManager, dispatchData) {
  const dispatchKind = dispatchData.dispatchKind;
  if (dispatchKind === UiCommand.showFloatingOverlay) {
    overlayManager.showPopup(dispatchData);
    return;
  }
  if (dispatchKind === UiCommand.closeFloatingOverlay) {
    overlayManager.removePopup(dispatchData);
    return;
  }
  if (dispatchKind === UiCommand.showAnalysisLoadingBanner) {
    overlayManager.showLoadingBar(dispatchData.bannerLabel);
    return;
  }
  if (dispatchKind === UiCommand.hideAnalysisLoadingBanner) {
    overlayManager.hideLoadingBar(dispatchData.bannerLabel);
    return;
  }
  if (dispatchKind === UiCommand.removeScrollableOverlayPopups) {
    overlayManager.removeScrollablePopups();
  }
}
