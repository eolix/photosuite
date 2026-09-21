/**
 * Empty-state home screen: sidebar actions, recent files grid, cursor overlay,
 * and document tab double-click handling.
 */


import { EventChannel } from "../../document/model/tool-base.js";
import { Layer } from "../../document/model/layer.js";
import { Locale } from "../../core/i18n/locale.js";
import { stripFileExtension } from "../../core/file-names.js";
import { DocumentTab } from "../layout/document-tab.js";
import { isTauriNativeFileDropEnabled } from "./tauri-home-file-drop.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, addPointerUpListener, clearElement, makeElement, removeClass, removePointerUpListener } from "../../core/dom.js";
import { CursorOverlay } from "./cursor-overlay.js";
import { dispatchDataTransferImports } from "./file-loader.js";
import { AppEvent } from "../../core/event-bus.js";
import {
  clearRecentFiles,
  formatRecentFileAge,
  getRecentFiles,
  refreshRecentThumbnailUrls
} from "../../core/recent-files.js";
import {
  formatAppVersionHeading,
  loadAppVersionInfo
} from "../../core/app-version.js";

/** Max gap (ms) between pointer-ups that counts as a double-click. */
const DOUBLE_CLICK_WINDOW_MS = 300;

const HOME_LOGO_CSS_PX = 88;
const HOME_APP_ICON_URL = "/assets/img/icon_full.png";

const HOME_ACTION_KEYS = [
  "clipboard.new",
  "file.openFromComputer"
];

/**
 * Empty-state document strip with Photoshop-style home screen.
 * @param {*} parentWidget
 */
function SplashScreen(parentWidget) {
  DocumentTab.call(this, parentWidget);
  this.lastTabClickTime = 0;
  this.onPanelTabDoubleClickHandler = this.onPanelTabDoubleClick.bind(this);
  this.cursorOverlayStack = ["default"];
  this.versionHeadingText = "PhotoSuite";
  addPointerUpListener(this.tabBarEl, this.onTabBarDoubleClick.bind(this));
  this.onHomeDragEnter = this.onHomeDragEnter.bind(this);
  this.onHomeDragLeave = this.onHomeDragLeave.bind(this);
  this.onHomeDragOver = this.onHomeDragOver.bind(this);
  this.homeFileDragDepth = 0;
  this.attachDragHandlers(this.containerEl);
  this.homePanel = buildHomePanel(this);
  this.homePanelRoot = this.homePanel.rootEl;
  this.cursorOverlay = new CursorOverlay(this.containerEl);
  loadAppVersionInfo().then(function(version) {
    this.versionHeadingText = formatAppVersionHeading(version);
    if (this.homePanel.titleEl) {
      this.homePanel.titleEl.textContent = this.versionHeadingText;
    }
  }.bind(this));
}

SplashScreen.prototype = Object.create(DocumentTab.prototype);

SplashScreen.prototype.onTabBarDoubleClick = function(pointerEvent) {
  if (pointerEvent.target != this.tabBarEl) return;
  if (!consumeDoubleClick(this)) return;
  this.dispatch(buildUiDispatchEvent({
    dispatchKind: UiCommand.dispatchAppDialogRouter,
    dialogRouteId: "newproject"
  }));
};

SplashScreen.prototype.updateCursorOverlayStack = function(cursorToken, pushOntoStack) {
  if (pushOntoStack) {
    this.cursorOverlayStack.push(cursorToken);
  } else {
    const stackTopIndex = this.cursorOverlayStack.length - 1;
    if (this.cursorOverlayStack[stackTopIndex] == cursorToken) {
      if (cursorToken != null && typeof cursorToken != "string") this.refreshCursorOverlay();
      return;
    }
    this.cursorOverlayStack[stackTopIndex] = cursorToken;
  }
  this.refreshCursorOverlay();
};

SplashScreen.prototype.dismissIntroOverlay = function() {
  this.cursorOverlayStack.pop();
  this.refreshCursorOverlay();
};

SplashScreen.prototype.refreshCursorOverlay = function() {
  const topCursorToken = this.cursorOverlayStack[this.cursorOverlayStack.length - 1];
  this.cursorOverlay.open(topCursorToken, this.containerStyleString);
  if (topCursorToken != null && typeof topCursorToken != "string") this.cursorOverlay.refresh();
};

SplashScreen.prototype.onHomeActionClick = function(clickEvent) {
  const actionIndex = this.homePanel.actionButtons.indexOf(clickEvent.currentTarget);
  const uiEvent = buildUiDispatchEvent(resolveHomeActionPayload(actionIndex));
  if (uiEvent.data) this.dispatch(uiEvent);
};

SplashScreen.prototype.acceptsHomeFileDrop = function(controller) {
  return controller.appData.intro === true
    && controller.openDocs.length === 0
    && this.homePanelRoot != null;
};

SplashScreen.prototype.onPanelDrop = function(evt) {
  if (DocumentTab.isExternalFileDrag(evt)) {
    const hostController = this.hostController;
    if (hostController && this.acceptsHomeFileDrop(hostController)) {
      this.homeFileDragDepth = 0;
      this.setHomeDropHighlight(false);
      DocumentTab.cancel(evt);
      if (isTauriNativeFileDropEnabled()) return;
      if (hostController.runSavedScriptIfAny("open")) return;
      dispatchDataTransferImports(evt, this, null);
      return;
    }
  }
  DocumentTab.prototype.onPanelDrop.call(this, evt);
};

SplashScreen.prototype.setHomeDropHighlight = function(active) {
  if (!this.homePanelRoot) return;
  if (active) addClass(this.homePanelRoot, "home-screen--drop-target");
  else removeClass(this.homePanelRoot, "home-screen--drop-target");
};

/** Empty the recent list, then redraw the grid. */
SplashScreen.prototype.onClearHistoryClick = function() {
  const splashScreen = this;
  clearRecentFiles().then(function() {
    splashScreen.refreshRecentEntries();
  });
};

SplashScreen.prototype.onRecentFileClick = function(clickEvent) {
  const cardEl = clickEvent.currentTarget;
  const filePath = cardEl.getAttribute("data-recent-path");
  if (filePath == null || filePath === "") return;
  this.dispatch(buildUiDispatchEvent({
    dispatchKind: UiCommand.openRecentFile,
    filePath: filePath,
    fileName: cardEl.getAttribute("data-recent-name") || ""
  }));
};

SplashScreen.prototype.buildUI = function() {
  for (let actionIdx = 0; actionIdx < this.homePanel.actionButtons.length; actionIdx++) {
    this.homePanel.actionButtons[actionIdx].textContent =
      Locale.get(HOME_ACTION_KEYS[actionIdx]);
  }
  if (this.homePanel.recentHeadingEl) {
    this.homePanel.recentHeadingEl.textContent = Locale.get("file.recent");
  }
  if (this.homePanel.clearHistoryEl) {
    this.homePanel.clearHistoryEl.textContent = Locale.get("file.clearHistory");
  }
  this.refreshRecentEntries();
};

SplashScreen.prototype.open = function(activeDoc, openDocsList) {
  for (let docIdx = 0; docIdx < openDocsList.length; docIdx++) {
    const openDoc = openDocsList[docIdx];
    this.panels[docIdx].setName(openDoc.name + (openDoc.isModified() ? " *" : ""));
  }
  DocumentTab.prototype.open.call(this, activeDoc, openDocsList);
};

SplashScreen.prototype.createEmptyStateWidget = function() {
  return this.homePanelRoot;
};

SplashScreen.prototype.setHomeScreenMode = function(active) {
  this.setTabBarPosition(active ? 1 : 0);
  this.syncHomeFileDropHandlers(active);
};

SplashScreen.prototype.syncHomeFileDropHandlers = function(active) {
  const rootEl = this.homePanelRoot;
  if (!rootEl) return;
  rootEl.removeEventListener("dragenter", this.onHomeDragEnter, true);
  rootEl.removeEventListener("dragleave", this.onHomeDragLeave, true);
  rootEl.removeEventListener("dragover", this.onHomeDragOver, true);
  if (!active) {
    this.homeFileDragDepth = 0;
    this.setHomeDropHighlight(false);
    return;
  }
  rootEl.addEventListener("dragenter", this.onHomeDragEnter, true);
  rootEl.addEventListener("dragleave", this.onHomeDragLeave, true);
  rootEl.addEventListener("dragover", this.onHomeDragOver, true);
};

SplashScreen.prototype.onHomeDragEnter = function(dragEvent) {
  const hostController = this.hostController;
  if (!hostController || !this.acceptsHomeFileDrop(hostController)) return;
  if (!DocumentTab.isExternalFileDrag(dragEvent)) return;
  DocumentTab.cancel(dragEvent);
  this.homeFileDragDepth += 1;
  this.setHomeDropHighlight(true);
};

SplashScreen.prototype.onHomeDragLeave = function(dragEvent) {
  DocumentTab.cancel(dragEvent);
  this.homeFileDragDepth = Math.max(0, this.homeFileDragDepth - 1);
  if (this.homeFileDragDepth === 0) this.setHomeDropHighlight(false);
};

SplashScreen.prototype.onHomeDragOver = function(dragEvent) {
  const hostController = this.hostController;
  if (!hostController || !this.acceptsHomeFileDrop(hostController)) return;
  if (!DocumentTab.isExternalFileDrag(dragEvent)) return;
  DocumentTab.cancel(dragEvent);
};

SplashScreen.prototype.refreshRecentEntries = function() {
  if (!this.homePanel || !this.homePanel.recentGridEl) return;
  const splashScreen = this;
  refreshRecentThumbnailUrls().then(function() {
    const gridEl = splashScreen.homePanel.recentGridEl;
    clearElement(gridEl);
    const recentEntries = getRecentFiles();
    for (let entryIdx = 0; entryIdx < recentEntries.length; entryIdx++) {
      gridEl.appendChild(buildRecentFileCard(splashScreen, recentEntries[entryIdx]));
    }
    // Nothing to clean when the list is already empty.
    if (splashScreen.homePanel.clearHistoryEl) {
      splashScreen.homePanel.clearHistoryEl.hidden = recentEntries.length === 0;
    }
  });
};

SplashScreen.prototype.resize = function(widthPx, heightPx) {
  heightPx = DocumentTab.prototype.resize.call(this, widthPx, heightPx);
  this.containerStyleString =
    "height:" + heightPx + "px; width:" + widthPx + "px; overflow:hidden; position:relative;";
  this.refreshCursorOverlay();
  if (this.homePanelRoot) {
    this.homePanelRoot.setAttribute("style", computeHomePanelStyle(widthPx, heightPx));
  }
};

SplashScreen.prototype.attachPanel = function(panelWidget) {
  DocumentTab.prototype.attachPanel.call(this, panelWidget);
  addPointerUpListener(panelWidget.tabEl, this.onPanelTabDoubleClickHandler);
};

SplashScreen.prototype.detachPanelAt = function(panelIndex) {
  const panelWidget = this.panels[panelIndex];
  removePointerUpListener(panelWidget.tabEl, this.onPanelTabDoubleClickHandler);
  DocumentTab.prototype.detachPanelAt.call(this, panelIndex);
};

SplashScreen.prototype.onPanelTabDoubleClick = function(pointerEvent) {
  if (!consumeDoubleClick(this)) return;
  const tabIndex = this.indexOfTabElement(pointerEvent.currentTarget);
  const docName = this.panels[tabIndex].pluginDocument.name;
  this.dispatch(buildUiDispatchEvent({
    dispatchKind: UiCommand.dispatchAppDialogRouter,
    dialogRouteId: "namewindow",
    initialValue: stripFileExtension(docName),
    deferredDispatch: {
      appEventType: EventType.documentAction,
      documentModelType: EventChannel.EVENT_DOCUMENT,
      payload: {
        actionKind: Layer.renameDocument
      }
    }
  }));
};

/**
 * @param {SplashScreen} splashScreen
 * @param {{ path: string, name: string, openedAt: number, thumbnail?: string }} entry
 * @returns {HTMLElement}
 */
function buildRecentFileCard(splashScreen, entry) {
  const cardEl = makeElement("button", "home-recent-card");
  cardEl.setAttribute("type", "button");
  cardEl.setAttribute("data-recent-path", entry.path);
  cardEl.setAttribute("data-recent-name", entry.name);
  cardEl.addEventListener("click", splashScreen.onRecentFileClick.bind(splashScreen));

  const thumbWrapEl = makeElement("div", "home-recent-thumb-wrap");
  if (entry.thumbnail) {
    const thumbImg = makeElement("img", "home-recent-thumb");
    thumbImg.setAttribute("src", entry.thumbnail);
    thumbImg.setAttribute("alt", "");
    thumbWrapEl.appendChild(thumbImg);
  } else {
    thumbWrapEl.appendChild(makeElement("div", "home-recent-thumb home-recent-thumb--empty"));
  }
  cardEl.appendChild(thumbWrapEl);

  const nameEl = makeElement("div", "home-recent-name");
  nameEl.textContent = entry.name;
  cardEl.appendChild(nameEl);

  const ageEl = makeElement("div", "home-recent-age");
  ageEl.textContent = formatRecentFileAge(entry.openedAt);
  cardEl.appendChild(ageEl);
  return cardEl;
}

/**
 * @param {SplashScreen} splashScreen
 */
function buildHomePanel(splashScreen) {
  const rootEl = makeElement("div", "home-screen");
  const sidebarEl = makeElement("aside", "home-sidebar");
  const logoEl = makeElement("img", "home-logo");
  logoEl.setAttribute("src", HOME_APP_ICON_URL);
  logoEl.setAttribute("alt", "PhotoSuite");
  logoEl.setAttribute("width", String(HOME_LOGO_CSS_PX));
  logoEl.setAttribute("height", String(HOME_LOGO_CSS_PX));
  sidebarEl.appendChild(logoEl);

  const actionButtons = [];
  for (let actionIdx = 0; actionIdx < HOME_ACTION_KEYS.length; actionIdx++) {
    const actionBtn = makeElement("button", "home-action-btn");
    actionBtn.setAttribute("type", "button");
    actionBtn.textContent = Locale.get(HOME_ACTION_KEYS[actionIdx]);
    actionBtn.addEventListener("click", splashScreen.onHomeActionClick.bind(splashScreen));
    sidebarEl.appendChild(actionBtn);
    actionButtons.push(actionBtn);
  }
  rootEl.appendChild(sidebarEl);

  const mainEl = makeElement("main", "home-main");
  const titleEl = makeElement("h1", "home-title");
  titleEl.textContent = splashScreen.versionHeadingText;
  mainEl.appendChild(titleEl);

  const recentHeaderEl = makeElement("div", "home-recent-header");
  const recentHeadingEl = makeElement("h2", "home-recent-heading");
  recentHeadingEl.textContent = Locale.get("file.recent");
  recentHeaderEl.appendChild(recentHeadingEl);

  const clearHistoryEl = makeElement("button", "home-recent-clear");
  clearHistoryEl.textContent = Locale.get("file.clearHistory");
  clearHistoryEl.addEventListener("click", splashScreen.onClearHistoryClick.bind(splashScreen), false);
  recentHeaderEl.appendChild(clearHistoryEl);
  mainEl.appendChild(recentHeaderEl);

  const recentGridEl = makeElement("div", "home-recent-grid");
  mainEl.appendChild(recentGridEl);
  rootEl.appendChild(mainEl);

  return {
    rootEl: rootEl,
    titleEl: titleEl,
    recentHeadingEl: recentHeadingEl,
    clearHistoryEl: clearHistoryEl,
    recentGridEl: recentGridEl,
    actionButtons: actionButtons
  };
}

function computeHomePanelStyle(widthPx, heightPx) {
  return "width:" + widthPx + "px; height:" + heightPx + "px;";
}

function consumeDoubleClick(splashScreen) {
  const lastClickTime = splashScreen.lastTabClickTime;
  splashScreen.lastTabClickTime = Date.now();
  return Date.now() - lastClickTime <= DOUBLE_CLICK_WINDOW_MS;
}

function resolveHomeActionPayload(actionIndex) {
  if (actionIndex == 0) {
    return {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "newproject"
    };
  }
  if (actionIndex == 1) {
    return {
      dispatchKind: UiCommand.pickLocalFiles,
      imagesOnly: true
    };
  }
  return null;
}

function buildUiDispatchEvent(data) {
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = data;
  return uiEvent;
}

export {
  SplashScreen,
  computeHomePanelStyle,
  resolveHomeActionPayload,
  consumeDoubleClick,
  DOUBLE_CLICK_WINDOW_MS,
  HOME_LOGO_CSS_PX
};
