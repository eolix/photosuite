/**
 * Application shell controller — the top-level object that wires the whole editor
 * together.
 *
 * AppController extends AppWindow (the shell host: document column, overlays, rAF
 * loop) and owns the rest of the shell: the open-document list, the chrome
 * widgets (menu bar, toolbar, right sidebar, confirm bar, splash/tab strip),
 * pointer routing to the active tool, the system clipboard bridge, and startup.
 * It holds the single `appData` session-state object every subsystem reads and
 * writes.
 *
 * Behavior is split across cohesive companion modules that each attach more
 * prototype methods to this class: `app-controller-launch`, `-clipboard`,
 * `-ui-dispatch`, `-tools`, and `-keyboard`. The `apply*Handlers(AppController)`
 * calls near the bottom of this file install them. The tool table itself lives in
 * `app-controller-tool-registry`.
 *
 * Events flow through two channels dispatched on this controller: `EventType.*`
 * (event types such as `uiDispatch`, `documentAction`) carrying a payload whose
 * `dispatchKind`/`actionKind` is one of `UiCommand.*`. Tools, panels, and the
 * shell all listen on these.
 */
import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { Locale } from "../../core/i18n/locale.js";

import { FontRegistry } from "../../fonts/font-registry.js";
import { LayerSystem } from "../../engine/layer-system.js";
import { FileFormatRegistry } from "../../document/formats/registry/file-format-registry.js";
import { EventChannel, TRANSFORM_TOOL_IDS, ToolId } from "../../document/model/tool-base.js";
import { PathRecordCodec } from "../../document/formats/psd/path-record-codec.js";
import { TextEngineData } from "../../features/text/text-engine.js";
import { TextRenderer } from "../../features/text/text-renderer.js";
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { Layer } from "../../document/model/layer.js";
import { PopupTypes } from "../config/popup-types.js";
import {
  ensureDefaultBrushPresets,
  ensureDefaultSwatchPresets,
  getSwatchPresetStore,
} from "../config/default-presets.js";
import { SwatchFile } from "../../features/swatch/swatch-file.js";
import { PluginToolPanel } from "../panels/plugin-tool-panel.js";
import { ToolBar } from "../tool-options/option-bar.js";
import {
  installNativeMenuFromMenuBarData,
  installTauriMenuActionBridge,
  refreshNativeMenuFromMenuBarData
} from "../menu/tauri-menu-bridge.js";
import { installTauriHomeScreenFileDrop } from "./tauri-home-file-drop.js";
import { normalizePanelId } from "../menu/menu-bar-predicates.js";
import { AppWindow } from "./app-window.js";
import { ConfirmBar } from "../layout/chrome-header-bars.js";
import {
  applyDataTransferToController,
  dataTransferHasImage,
  readSystemClipboardForPaste
} from "../../core/system-clipboard.js";
import { FileLoader, FileProcessor, listenForOsFileOpens, openPendingOsFiles } from "./file-loader.js";
import { loadStartupPresetResources, loadSavedResources } from "./startup-resources.js";
import { SplashScreen } from "./splash-screen.js";
import { RightSidebar } from "../layout/right-sidebar.js";
import { MenuBar } from "../menu/menu-bar.js";

import { createToolRegistry, initToolRegistryMap } from "./app-controller-tool-registry.js";
import { applyLaunchHandlers } from "./app-controller-launch.js";
import { applyClipboardHandlers } from "./app-controller-clipboard.js";
import { applyUiDispatchHandlers, applyGpuAccelerationPreference } from "./app-controller-ui-dispatch.js";
import { applyToolHandlers } from "./app-controller-tools.js";
import { applyKeyboardHandlers } from "./app-controller-keyboard.js";
import { applyStoredSettingsOnStartup } from "../../core/app-settings.js";
import {
  loadDiscoveredSidebarPlugins,
  registerDiscoveredSidebarPlugins
} from "../../features/plugins/plugin-loader.js";
import {
  handlePluginIpcMessage,
  isPluginIpcMessage
} from "../../features/plugins/plugin-host-ipc.js";
import {
  captureDocumentThumbnailDataUrl,
  loadRecentFilesFromStore,
  recordRecentFile
} from "../../core/recent-files.js";
import { createMenuBarData } from "../menu/menu-bar-data.js";
import { applyEditorParamsToPrefs } from "../../core/editor-persisted-params.js";
import { BrushPresetUtil } from "../../features/brush/brush-presets.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, escapeHtml, isInDOM, makeElement } from "../../core/dom.js";
import { canWriteClipboard } from "../../core/tauri-host.js";
import { showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";
import { ZoomTool } from "../../document/tools/view-tools.js";

/** Chrome shows menu + confirm + toolbar + sidebar. */
export const CHROME_LAYOUT_NORMAL = 0;
/** Chrome shows menu + document only. */
export const CHROME_LAYOUT_MENU_ONLY = 1;
/** Fullscreen document chrome (no menu chrome in page). */
export const CHROME_LAYOUT_FULLSCREEN = 2;

const FONT_LOADING_PANEL_PREFIX = "font-loading:";
const FONT_I18N_LOADING_LABEL = "history.loading";
const FONT_I18N_LOAD_NAMED = "history.loadVar";
const EDGE_AUTO_PAN_MARGIN_PX = 16;
const NATIVE_MENU_REFRESH_DEBOUNCE_MS = 400;

/** Cap / marketing paragraph when the link-inject branch does not apply. */
const CAP_HOWTO_PARAGRAPH =
  "Create a new image or open existing files from your computer. Save your work as PSD (File - Save as PSD) or as JPG / PNG / SVG (File - Export as).";

/**
 * Build the live editor: initialize session state (`appData`), the tool
 * registry, chrome widgets and their DOM, native menus, and system input
 * listeners; load the default resource bundle; activate the move tool; and
 * schedule deferred startup on the next tick.
 * @constructor
 */
function AppController() {
  AppWindow.call(this);
  this.pointerState = { x: 0, y: 0, isDown: false };
  this.uiReady = false;
  this.localDocUrlCounter = 0;
  this.chromeLayoutMode = CHROME_LAYOUT_NORMAL;
  this.startupComplete = false;

  window.onmessage = function(messageEvent) {
    handleHostWindowMessage(this, messageEvent);
  }.bind(this);

  // Reading the saved libraries is async and can land before full appData is
  // assigned, so the store it writes into exists from the start.
  this.appData = {
    startupResourceStore: {
      storedFiles: {}
    }
  };

  this.toolRegistry = createToolRegistry();
  initToolRegistryMap(this.toolRegistry);
  bootstrapSavedResources(this);

  const preservedStoredFiles = this.appData.startupResourceStore.storedFiles;
  this.appData = createInitialAppData();
  if (preservedStoredFiles) {
    Object.assign(this.appData.startupResourceStore.storedFiles, preservedStoredFiles);
  }

  this.internalClipboardPasteState = {
    rect: new Rect(),
    sourceDocSize: new Point()
  };
  this.appData.currentTextStyle = TextEngineData.getDefaultTextStyle();
  installFontLoadingListeners(this);
  this.appData.fontRegistry.on(EventType.uiDispatch, this.onUiDispatch, this);

  applyNavigatorLanguagePreference();
  assembleChromeWidgets(this);
  wireChromeEvents(this);
  installNativeMenus(this);
  installSystemInputListeners(this);

  this.activeDocIndex = 0;
  this.openDocs = [];
  this.fileLoader = new FileLoader(FileProcessor.processLoadedBytes);
  this.fileLoader.parent = this;

  mountWorkspaceDom(this);
  ensureDefaultBrushPresets(this.appData.brushPresets);
  ensureDefaultSwatchPresets(this.appData.swatchPresets);
  BrushPresetUtil.sanitizeBrushPresetList(this.appData.brushPresets.list);
  loadStartupPresetResources(this.fileLoader);
  this.activateTool(ToolId.TOOL_MOVE);
  setTimeout(this.runDeferredStartup.bind(this), 0);
}

AppController.prototype = Object.create(AppWindow.prototype);

AppController.prototype.scheduleNativeMenuBarRefresh = function() {
  const self = this;
  if (this._nativeMenuRefreshTimer != null) {
    clearTimeout(this._nativeMenuRefreshTimer);
  }
  this._nativeMenuRefreshTimer = setTimeout(function() {
    self._nativeMenuRefreshTimer = null;
    self.refreshNativeMenuBar();
  }, NATIVE_MENU_REFRESH_DEBOUNCE_MS);
};

AppController.prototype.refreshNativeMenuBar = function() {
  const self = this;
  refreshNativeMenuFromMenuBarData({
    getMenuData: function() {
      return MenuBar.data;
    },
    getCurrentDoc: function() {
      return self.getCurrentDoc();
    },
    getAppData: function() {
      return self.appData;
    }
  }).catch(function(err) {
    console.warn("photosuite: native menu refresh failed", err);
  });
};

AppController.prototype.refreshRecentFilesUi = function() {
  MenuBar.data = createMenuBarData(function getPanelRegistry() {
    return RightSidebar.panelRegistry;
  });
  this.menuBar.menuDropdowns = [];
  this.splashScreen.refreshRecentEntries();
  this.refreshNativeMenuBar();
};

AppController.prototype.syncHomeScreenChrome = function() {
  const showHome = this.appData.intro && this.openDocs.length === 0;
  if (showHome) {
    this.splashScreen.setHomeScreenMode(true);
    this.setChromeLayoutMode(CHROME_LAYOUT_MENU_ONLY);
    this.splashScreen.refreshRecentEntries();
  } else {
    this.splashScreen.setHomeScreenMode(false);
    if (this.chromeLayoutMode === CHROME_LAYOUT_MENU_ONLY) {
      this.setChromeLayoutMode(CHROME_LAYOUT_NORMAL);
    }
  }
};

AppController.prototype.onComplete = function(completionPayload) {
  const outboundEvent = new AppEvent(EventType.uiDispatch);
  outboundEvent.data = {
    dispatchKind: UiCommand.postClipboardEmbedMessage,
    embedMessage: completionPayload ? completionPayload : "done"
  };
  this.dispatch(outboundEvent);
};

// Second startup phase, run on the tick after construction: apply stored user
// settings, act on any launch request in the query string, build the UI, then
// signal completion. Runs the same finish path whether settings load succeeds
// or fails so the editor always comes up.
AppController.prototype.runDeferredStartup = function() {
  this.startupComplete = true;
  const appController = this;
  applyStoredSettingsOnStartup(appController).then(function() {
    applyGpuAccelerationPreference(appController.appData.prefs);
    return loadRecentFilesFromStore();
  }).catch(function(err) {
    // Settings and recent files are conveniences; a failure there must not cost
    // the user their installed plugins or the rest of the launch sequence.
    console.warn("PhotoSuite: settings bootstrap failed", err);
  }).then(function() {
    return loadDiscoveredSidebarPlugins();
  }).then(function(discoveredPlugins) {
    registerDiscoveredSidebarPlugins(appController.rightSidebar, discoveredPlugins);
  }).then(function() {
    MenuBar.data = createMenuBarData(function getPanelRegistry() {
      return RightSidebar.panelRegistry;
    });
    appController.finishLaunchFromQueryString();
    appController.initUI();
    appController.onComplete();
    // Only once the editor is up: a file the OS asked for opens into a ready UI.
    listenForOsFileOpens(appController);
    return openPendingOsFiles(appController);
  }).catch(function(err) {
    console.warn("PhotoSuite: launch failed", err);
    appController.finishLaunchFromQueryString();
    appController.initUI();
    appController.onComplete();
  });
};

AppController.prototype.initUI = function() {
  this.uiReady = true;
  if (!this.appData.intro) this.splashScreen.homePanelRoot = null;
  else this.splashScreen.animateOut();
  this.syncHomeScreenChrome();
  ensureDefaultBrushPresets(this.appData.brushPresets);
  ensureDefaultSwatchPresets(getSwatchPresetStore(this.appData));
  this.buildUI();
  this.onResize();
  this.rightSidebar.open(this.getCurrentDoc(), this.openDocs, this.appData);
  ensureDefaultSwatchPresets(getSwatchPresetStore(this.appData));
  this.updateAllPanels(PopupTypes.SWATCHES);
  const appController = this;
  setTimeout(function() {
    appController.updateAllPanels(PopupTypes.ALL);
  }, 0);
  appController.refreshNativeMenuBar();
};

AppController.prototype.applyPersistedAppState = function(persistedState) {
  applyPersistedFieldsToAppData(this, persistedState);
};

AppController.prototype.buildUI = function() {
  populateCapMarketingCopy();
  this.linkBar.buildUI();
  this.menuBar.buildUI();
  this.rightSidebar.buildUI();
  this.toolBar.buildUI();
  this.documentView.buildUI();
  this.splashScreen.buildUI();
  for (const toolId in this.toolRegistry.entriesById) {
    if (this.toolRegistry.entriesById[toolId].optionPanel) {
      this.toolRegistry.entriesById[toolId].optionPanel.buildUI();
    }
  }
};

/** Chrome bar heights used before the stylesheet has laid the bars out. */
const MENU_BAR_FALLBACK_HEIGHT_PX = 30;
const OPTIONS_BAR_FALLBACK_HEIGHT_PX = 38;

/** A bar's laid-out height including its edges, or `fallback` before layout. */
function measuredBarHeight(barEl, fallback) {
  const measured = barEl.offsetHeight;
  return measured > 0 ? measured : fallback;
}

AppController.prototype.resize = function(widthPx, heightPx) {
  widthPx = Math.floor(widthPx);
  heightPx = Math.floor(heightPx);
  AppWindow.prototype.resize.call(this, widthPx, heightPx);
  // The chrome viewport clips what it holds, so it is measured from the bars
  // themselves — their heights and edges are set in the stylesheet.
  let chromeTopOffset = 0;
  if (isInDOM(this.menuBar.el) && !document.body.classList.contains("photosuite-hide-html-menu")) {
    chromeTopOffset += measuredBarHeight(this.menuBar.el, MENU_BAR_FALLBACK_HEIGHT_PX);
  }
  if (isInDOM(this.confirmBar.el)) {
    chromeTopOffset += measuredBarHeight(this.confirmBar.el, OPTIONS_BAR_FALLBACK_HEIGHT_PX);
  }
  this.linkBar.isUiReady = this.uiReady;
  this.linkBar.resize(widthPx, chromeTopOffset);
  const contentHeight = heightPx - chromeTopOffset;
  this.toolBar.resize(widthPx, contentHeight);
  this.rightSidebar.resize(widthPx, contentHeight);
  this.splashScreen.resize(
    widthPx - this.toolBar.getWidth() - this.rightSidebar.getWidth(),
    contentHeight
  );
};

AppController.prototype.onSystemCopy = function() {};

// Window "paste" handler. Ignores pastes aimed at the type tool or a text input,
// guards against re-entrancy, then routes by source: an image on the system
// clipboard is imported; an internal pixel/path clipboard becomes a
// paste-layers dispatch; otherwise the system clipboard is read asynchronously.
AppController.prototype.onSystemPaste = function(pasteEvent) {
  const textEntry = this.toolRegistry.entriesById[ToolId.TOOL_TYPE];
  if (textEntry && textEntry.tool && textEntry.tool.isActive()) return;
  const targetTag = pasteEvent.target.tagName.toLowerCase();
  if (this.textInputTagNames.indexOf(targetTag) != -1) return;
  if (this._pasteInFlight) return;
  this._pasteInFlight = true;
  const self = this;
  const releasePasteLock = function() {
    setTimeout(function() {
      self._pasteInFlight = false;
    }, 0);
  };
  const fileLoaderRef = createFileLoaderProcessRef();
  const appData = this.appData;
  if (pasteEvent.clipboardData && dataTransferHasImage(pasteEvent.clipboardData)) {
    applyDataTransferToController(
      this,
      pasteEvent.clipboardData,
      this.applyClipboardImage.bind(this),
      fileLoaderRef
    );
    releasePasteLock();
    return;
  }
  if (appData.pathClipboard != null || appData.clipboardPixelPayload != null) {
    const internalPaste = new AppEvent(EventType.uiDispatch, true);
    internalPaste.data = {
      dispatchKind: UiCommand.clipboardPasteLayers,
      skipInternalClipboard: true
    };
    this.dispatch(internalPaste);
    releasePasteLock();
    return;
  }
  readSystemClipboardForPaste(this, this.applyClipboardImage.bind(this), fileLoaderRef)
    .finally(releasePasteLock);
};

AppController.prototype.onClipboardTextUrl = function(textUrl) {
  if (!textUrl.startsWith("http")) return;
  if (textUrl == this.appData.lastClipboardTextImportUrl) return;
  this.appData.lastClipboardTextImportUrl = textUrl;
  const importEvent = new AppEvent(EventType.uiDispatch, true);
    importEvent.data = {
    dispatchKind: UiCommand.importFromUrl,
    importSpec: { url: textUrl }
  };
  this.dispatch(importEvent);
};

AppController.prototype.applyClipboardImage = function(imageBuffer, pasteRectArg) {
  const self = this;
  setTimeout(function() {
    self._pasteInFlight = false;
  }, 0);
  let pasteRect = pasteRectArg;
  if (pasteRect != null && typeof pasteRect.clone !== "function") {
    pasteRect = new Rect(pasteRect.x, pasteRect.y, pasteRect.width, pasteRect.height);
  }
  const internalPastePayload = {
      buffer: imageBuffer,
      rect: pasteRect
  };
  const appData = this.appData;
  if (canWriteClipboard()) {
    const internalPasteState = this.internalClipboardPasteState;
    const priorPasteRect = internalPasteState.rect;
    if (priorPasteRect.width == pasteRect.width && priorPasteRect.height == pasteRect.height) {
      internalPastePayload.rect = priorPasteRect;
      internalPastePayload.sourceDocSize = internalPasteState.sourceDocSize;
    }
  } else if (appData.clipboardPixelPayload) {
    const historyBackEvent = new AppEvent(EventType.documentAction, true);
      historyBackEvent.routingChannel = EventChannel.EVENT_HISTORY;
    historyBackEvent.data = { actionKind: "h_stepbck" };
    this.dispatch(historyBackEvent);
  }
  appData.clipboardPixelPayload = internalPastePayload;
  appData.isInternalClipboardCopy = false;
  const pasteDispatchEvent = new AppEvent(EventType.uiDispatch, true);
  pasteDispatchEvent.data = {
    dispatchKind: UiCommand.clipboardPasteLayers,
    skipInternalClipboard: true
  };
  this.dispatch(pasteDispatchEvent);
};

AppController.prototype.showCloseOverlayOrConfirmAlert = function() {
  if (this.documentView.getTopDialog() != null) {
    showToast(Locale.get("brushAndMessages.toolHints.closeTheCurrentWindowFirst"));
  } else {
    showToast("Escape or Confirm the current action (in the top menu).");
  }
};

// Register a freshly loaded document: focus it if already open, otherwise give
// it a local source URL, prepare its layers and fonts, rebuild its layer tree,
// finish rasterization, add it to the open-doc list, and attach a tab panel.
AppController.prototype.onDocumentOpened = function(openedDoc) {
  const existingTabIndex = this.openDocs.indexOf(openedDoc);
  if (existingTabIndex != -1) {
    this.splashScreen.selectPanelAt(existingTabIndex);
    return;
  }
  if (openedDoc.sourceUrl == null) {
    openedDoc.sourceUrl = "local," + this.localDocUrlCounter + "," + openedDoc.name;
    this.localDocUrlCounter++;
  }
  prepareOpenedDocumentLayers(openedDoc, this.appData.fontRegistry);
  if (LayerSystem.webglEnabled) {
    LayerSystem.checkTextureSize(Math.max(openedDoc.width, openedDoc.height));
  }
  openedDoc.rebuildLayerTree();
  finishOpenedDocumentRaster(openedDoc);
  this.openDocs.push(openedDoc);
  this.splashScreen.attachPanel(new PluginToolPanel(openedDoc));
  this.syncHomeScreenChrome();
  if (openedDoc.nativeFilePath) {
    const controller = this;
    const thumbnailDataUrl = captureDocumentThumbnailDataUrl(openedDoc);
    recordRecentFile({
      path: openedDoc.nativeFilePath,
      thumbnailDataUrl: thumbnailDataUrl
    }).then(function() {
      controller.refreshRecentFilesUi();
    });
  }
  openedDoc.stateChanged = true;
  openedDoc.dirty = true;
  const controller = this;
  if (openedDoc.pendingTextRasterization) {
    requestAnimationFrame(function() {
      controller.refreshTextLayerFonts();
    });
  } else {
    this.refreshTextLayerFonts();
  }
};

AppController.prototype.getCurrentDoc = function() {
  const resolved = resolveCurrentDocFromOpenList(this.openDocs, this.activeDocIndex);
  this.activeDocIndex = resolved.activeDocIndex;
  return resolved.doc;
};

AppController.prototype.isDocumentViewIdle = function() {
  return this.documentView.getTopDialog() == null;
};

AppController.prototype.onDocumentTabSelect = function(tabEvent, tabStep) {
  this.disableCurrentTool();
  const openDocCount = this.openDocs.length;
  if (tabStep != null) {
    this.splashScreen.selectPanelAt(
      (this.splashScreen.getActivePanelIndex() + tabStep + openDocCount) % openDocCount
    );
  }
  this.activeDocIndex = this.splashScreen.getActivePanelIndex();
  const activeDoc = this.getCurrentDoc();
  this.menuBar.setMenuContext(activeDoc, this.appData);
  this.rightSidebar.open(activeDoc, this.openDocs, this.appData);
  this.onResize();
  this.refreshNativeMenuBar();
  if (activeDoc) activeDoc.stateChanged = true;
};

AppController.prototype.onDocumentTabClose = function(closeEvent) {
  this.disableCurrentTool();
  let docIndex = closeEvent.data && closeEvent.data.docTabIndex != null
    ? closeEvent.data.docTabIndex
    : -1;
  if (docIndex < 0 && closeEvent.target && closeEvent.target.pluginDocument) {
    docIndex = this.openDocs.indexOf(closeEvent.target.pluginDocument);
  }
  if (docIndex < 0) return;
  this.openDocs.splice(docIndex, 1);
  if (this.openDocs.length == 0) {
    this.onDocumentTabSelect(closeEvent);
    this.syncHomeScreenChrome();
    if (LayerSystem.webglEnabled) {
      LayerSystem.getOffscreenCanvas().parentNode.removeChild(LayerSystem.getOffscreenCanvas());
    }
  }
};

AppController.prototype.onDocumentTabReorder = function(reorderEvent) {
  const reorderedDocs = [];
  const tabReorderIndices = reorderEvent.data.tabReorderIndices;
  for (let reorderIdx = 0; reorderIdx < tabReorderIndices.length; reorderIdx++) {
    reorderedDocs[reorderIdx] = this.openDocs[tabReorderIndices[reorderIdx]];
  }
  this.openDocs = reorderedDocs;
  this.activeDocIndex = this.splashScreen.getActivePanelIndex();
};

AppController.prototype.onTabBarChromeRepaint = function() {
  const splashScreen = this.splashScreen;
  const hoverTabIndex = splashScreen.getHoverTabIndex();
  const activeToolEntry = this.getActiveToolEntry();
  if (hoverTabIndex == splashScreen.getActivePanelIndex() || !activeToolEntry.shouldFollowTabDrag()) {
    return;
  }
  this.duplicateLayersOnTabDrag(hoverTabIndex, activeToolEntry);
};

AppController.prototype.duplicateLayersOnTabDrag = function(targetDocIndex, activeToolEntry) {
  const appData = this.appData;
  const splashScreen = this.splashScreen;
  const sourceDoc = this.getCurrentDoc();
  const targetDoc = this.openDocs[targetDocIndex];
  const duplicateLayersEvent = new AppEvent(EventType.documentAction, true);
  duplicateLayersEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
  duplicateLayersEvent.data = {
    actionKind: Layer.pasteLayers,
    layersToInsert: sourceDoc.duplicateLayers(null, true),
    sourceDocument: sourceDoc,
    targetDocument: targetDoc
  };
  this.dispatch(duplicateLayersEvent);
  let pointerState = this.pointerState;
  const rulersVisible = appData.rulers;
  appData.rulers = false;
  pointerState = sourceDoc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
  if (activeToolEntry) activeToolEntry.onTabDragStart(sourceDoc, this, appData, this.keyboardHandler);
  splashScreen.selectPanelAt(targetDocIndex);
  pointerState = targetDoc.pathViewport.docToScreenPoint(pointerState.x, pointerState.y);
  pointerState.x += 49;
  pointerState.y += 112;
  if (activeToolEntry) {
    activeToolEntry.onMouseDown(targetDoc, this, appData, this.keyboardHandler, pointerState);
  }
  appData.rulers = rulersVisible;
};

AppController.prototype.onPointerEvent = function(pointerEvent) {
  routePointerEvent(this, pointerEvent);
};

// Per-frame hook driven by AppWindow's rAF loop: apply edge auto-pan while
// dragging near the viewport edge, then run the update/composite pass.
AppController.prototype.onAnimationFrame = function() {
  maybeEdgeAutoPanDocument(this);
  this.update();
};

// Per-frame update for the active document: notify tools of state changes,
// re-composite the dirty region, repaint the canvas and tab strip when needed,
// sync the sidebar/toolbar, and clear the document's dirty flags.
AppController.prototype.update = function(forceRepaint) {
  const currentDoc = this.getCurrentDoc();
  if (currentDoc == null) return;
  notifyToolsOfDocumentStateChange(this, currentDoc);
  if (currentDoc.dirtyRect) currentDoc.composite();
  maybeRepaintSplashAndView(this, currentDoc, forceRepaint);
  maybeSyncSidebarAndToolbar(this, currentDoc);
  clearDocumentViewDirtyFlags(currentDoc);
};

AppController.prototype.setChromeLayoutMode = function(layoutMode) {
  applyChromeLayoutMode(this, layoutMode);
};

applyLaunchHandlers(AppController);
applyClipboardHandlers(AppController);
applyUiDispatchHandlers(AppController);
applyToolHandlers(AppController);
applyKeyboardHandlers(AppController);

export {
  AppController,
  scheduleWhenIdle,
  computeEdgeAutoPanDeltas,
  scaleEdgeAutoPanForFrame,
  resolveCurrentDocFromOpenList,
  buildCapFormatBlurbHtml,
  createFileLoaderProcessRef,
  createInitialAppData
};

// ---------------------------------------------------------------------------
// Startup / host message
// ---------------------------------------------------------------------------

function scheduleWhenIdle(fn, timeoutMs) {
  if (typeof requestIdleCallback == "function") {
    requestIdleCallback(fn, { timeout: timeoutMs == null ? 2e3 : timeoutMs });
  } else {
    setTimeout(fn, 0);
  }
}

function handleHostWindowMessage(controller, messageEvent) {
  if (messageEvent.data instanceof ArrayBuffer) {
    const detectedFormatId = FileFormatRegistry.detectFormat(messageEvent.data);
    const formatHandler = FileFormatRegistry.getFormat(detectedFormatId);
    FileLoader.processLoadedBytes({ url: "file" }, messageEvent.data, controller);
    if (formatHandler == null) controller.onComplete();
    return;
  }
  if (isPluginIpcMessage(messageEvent.data)) {
    handlePluginIpcMessage(controller, messageEvent.data, messageEvent.source);
    return;
  }
  if (
    messageEvent.data instanceof Object
    || messageEvent.data.startsWith("{")
    || messageEvent.data.startsWith("amp-")
    || messageEvent.data.startsWith("0=goog")
    || messageEvent.data.startsWith("3PCoo")
  ) {
    return;
  }
  const scriptDispatchEvent = new AppEvent(EventType.uiDispatch, true);
  scriptDispatchEvent.data = {
    dispatchKind: UiCommand.runExtensionScriptSnippet,
    scriptSource: messageEvent.data
  };
  controller.dispatch(scriptDispatchEvent);
  controller.onComplete();
}

function applyNavigatorLanguagePreference() {
  const navigatorLanguages = navigator.languages;
  if (navigatorLanguages && navigatorLanguages.length != 0) {
    Locale.setLanguageByCode(navigatorLanguages[0]);
  }
}

// ---------------------------------------------------------------------------
// App data
// ---------------------------------------------------------------------------

/**
 * Fresh in-memory app session state (presets, prefs, clipboard, fonts).
 * Persisted preference wire keys (fcolor, panels, eparams, …) are applied later.
 */
function createInitialAppData() {
  return {
    hasLaunched: false,
    activeToolId: null,
    brushPresets: {
      patterns: [],
      samples: [],
      list: [],
      activeBrushPreset: null
    },
    toolPresets: [],
    colorProfilePresets: [],
    gradientPresets: [],
    contourPresets: [],
    patternPresets: [],
    swatchPresets: [],
    // Spare preset/resource slots retained for host embeds that poke appData.
    auxiliaryPresetList: [],
    auxiliaryResourceList: [],
    customShapePresets: [PathRecordCodec.create()],
    stylePresets: [],
    actionSets: [],
    recordingActionSet: null,
    currentFill: {
      fillKind: 1,
      fillDescriptor: LayerEffectDefs.getFillLayerDefault(0)
    },
    currentStroke: LayerEffectDefs.getStrokeStyleDefault(),
    fillPresetsByKind: [null].concat(LayerEffectDefs.fillLayerDefaults),
    strokeFillPresetsByKind: [null].concat(LayerEffectDefs.fillLayerDefaults),
    fontRegistry: new FontRegistry(),
    currentTextStyle: {
      fontSet: [],
      textStyle: null,
      paraStyle: null
    },
    favoriteFontFamilies: [],
    // Default palette: black foreground on white background — the same pair the
    // reset-colors action (operation 3 in app-controller-ui-dispatch) restores.
    colorInt: 0,
    bgColor: 16777215,
    rulers: false,
    extras: true,
    prefs: {
      guides: true,
      showGrid: false,
      showSelectionEdges: true,
      paths: true,
      showPixelGrid: true,
      slices: true,
      gridSize: 20,
      gridUnits: 0,
      gridType: 0,
      AppWindow: 0,
      gpuAcceleration: true
    },
    snapEnabled: true,
    showToggles: [true, true, false, true, true],
    // Right-sidebar layout. The persisted-prefs key is effectRows; each
    // integer is a BaseTool.PanelId value, and order here determines tab
    // ordering in each sidebar column.
    // 0   HISTORY      1   SWATCHES     2   LAYERS       3   INFO
    // 5   PROPERTIES   6   CSS          7   BRUSH        9   CHARACTER
    // 10  PARAGRAPH    16  CHANNELS     17  PATHS        101 WEB_IMAGES
    effectRows: [0, 1, 2, 3, 5, 6, 7, 9, 10, 16, 17, 101],
    theme: 1,
    customIO: {},
    hideIntro: true,
    compact: false,
    intro: true,
    startupResourceStore: {
      hasPromptedPersist: false,
      persistConfirmed: false,
      storedFiles: {}
    },
    lastClipboardImageFileSize: 0,
    clipboardCopyRect: null,
    clipboardPixelPayload: null,
    auxiliaryClipboardValue: null,
    pathClipboard: null,
    copiedLayerIndices: null
  };
}

function applyPersistedFieldsToAppData(controller, persistedState) {
  const appData = controller.appData;
  if (persistedState.fcolor != null) appData.colorInt = persistedState.fcolor;
  if (persistedState.bcolor != null) appData.bgColor = persistedState.bcolor;
  if (persistedState.rulers != null) appData.rulers = persistedState.rulers;
  if (persistedState.extras != null) appData.extras = persistedState.extras;
  if (persistedState.favFam != null) appData.favoriteFontFamilies = persistedState.favFam;
  if (persistedState.panels != null) {
    appData.effectRows = persistedState.panels.map(normalizePanelId);
  }
  if (persistedState.eparams) {
    applyEditorParamsToPrefs(appData.prefs, persistedState.eparams);
  }
  if (persistedState.lang != null) Locale.setLanguageByCode(persistedState.lang);
  if (persistedState.theme != null) appData.theme = persistedState.theme;
  if (persistedState.topt || appData.serverToolbarOptions) {
    const toolbarOptionsFromState = persistedState.topt ? persistedState.topt : {};
    const toolbarOptionsFromServer = appData.serverToolbarOptions
      ? appData.serverToolbarOptions
      : {};
    for (const toolId in controller.toolRegistry.entriesById) {
      if (TRANSFORM_TOOL_IDS.has(toolId)) continue;
      const toolbarWidgetKey = "t" + toolId;
      if (toolbarOptionsFromState[toolbarWidgetKey] || toolbarOptionsFromServer[toolbarWidgetKey]) {
        controller.toolRegistry.entriesById[toolId].tool.syncToolbarWidget(
          toolbarOptionsFromState[toolbarWidgetKey],
          toolbarOptionsFromServer[toolbarWidgetKey],
          controller
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Saved resource libraries + loading UI
// ---------------------------------------------------------------------------

function bootstrapSavedResources(controller) {
  loadSavedResources().then(function(storedFiles) {
    controller.appData.startupResourceStore.storedFiles = storedFiles;
    restoreStartupResources(controller, storedFiles);
  });
}

function restoreStartupResources(controller, storedFiles) {
  for (const resourceKey in storedFiles) {
    if (resourceKey === "_all_.aco") {
      restorePersistedSwatchBlob(controller, resourceKey, storedFiles[resourceKey]);
      continue;
    }
    if (!resourceKey.endsWith(".jsx")) {
      FileLoader.processLoadedBytes({
        url: resourceKey,
        suppressPresetAddedAlert: true
      }, storedFiles[resourceKey], controller);
    }
  }
}

function restorePersistedSwatchBlob(controller, resourceKey, savedAco) {
  scheduleWhenIdle(function() {
    try {
      if (savedAco instanceof ArrayBuffer) {
        const restored = SwatchFile.parse(savedAco, resourceKey);
        if (restored && restored.length) controller.appData.swatchPresets = restored;
      } else if (typeof savedAco == "string") {
        const parsedSwatches = JSON.parse(savedAco);
        if (parsedSwatches && parsedSwatches.length) {
          controller.appData.swatchPresets = parsedSwatches;
          SwatchFile.migrateStoreToTree(controller.appData.swatchPresets);
        }
      }
      ensureDefaultSwatchPresets(getSwatchPresetStore(controller.appData));
      if (controller.uiReady) controller.updateAllPanels(PopupTypes.SWATCHES);
    } catch (_) {
      ensureDefaultSwatchPresets(getSwatchPresetStore(controller.appData));
      if (controller.uiReady) controller.updateAllPanels(PopupTypes.SWATCHES);
    }
  }, 1e3);
}

function installFontLoadingListeners(controller) {
  try {
    controller._fontsInFlight = 0;
    window.addEventListener("photosuite:font-loading", function() {
      onFontLoadingEvent(controller, arguments[0]);
    }.bind(controller));
    // Rebuild text only when the in-flight queue drains. Rebuilding per font
    // lets loadFontFace return an early fallback face and rasterize with the
    // wrong typeface.
    window.addEventListener("photosuite:font-loaded", function() {
      onFontLoadedEvent(controller, arguments[0]);
    }.bind(controller));
  } catch (_) {}
}

function readFontEventDetail(eventLike) {
  try {
    return eventLike && eventLike.detail ? eventLike.detail : null;
  } catch (_) {
    return null;
  }
}

function onFontLoadingEvent(controller, eventLike) {
  controller._fontsInFlight++;
  const detail = readFontEventDetail(eventLike);
  const requestedKey = detail ? (detail.requestedKey || detail.key || null) : null;
  const mappedKey = detail ? (detail.mappedKey || detail.key || null) : null;
  // System catalog bootstrap uses key "catalog" only — no per-font panel.
  const isCatalogBootstrap = requestedKey === "catalog" && mappedKey === "catalog";
  if (isCatalogBootstrap || !(mappedKey || requestedKey)) return;
  const displayRequested = requestedKey || mappedKey;
  const displayMapped = mappedKey || requestedKey;
  const fontLineText = displayMapped !== displayRequested
    ? Locale.get(FONT_I18N_LOADING_LABEL) + ": " + displayRequested + " \u2192 " + displayMapped
    : Locale.get([FONT_I18N_LOAD_NAMED, displayRequested]);
  controller.overlayManager.showLoadingBar({
    id: FONT_LOADING_PANEL_PREFIX + (displayMapped || displayRequested),
    text: fontLineText
  });
}

function onFontLoadedEvent(controller, eventLike) {
  const prevInFlight = controller._fontsInFlight;
  controller._fontsInFlight = Math.max(0, controller._fontsInFlight - 1);
  try {
    const detail = readFontEventDetail(eventLike);
    const mappedKey = detail ? (detail.mappedKey || detail.key || null) : null;
    const requestedKey = detail ? (detail.requestedKey || null) : null;
    const idKey = mappedKey || requestedKey;
    if (idKey) controller.overlayManager.hideLoadingBar({ id: FONT_LOADING_PANEL_PREFIX + idKey });
  } catch (_) {}

  // Only rebuild when we actually had fonts in flight (paired loading events).
  // Orphan font-loaded while prevInFlight===0 would re-enter refreshTextLayerFonts
  // during loadFontFace and can stack-overflow.
  if (controller._fontsInFlight === 0 && prevInFlight > 0) {
    try {
      if (controller.openDocs && controller.openDocs.length) {
        for (let i = 0; i < controller.openDocs.length; i++) {
          controller.openDocs[i].pendingTextRasterization = true;
        }
      }
    } catch (_) {}
    controller.refreshTextLayerFonts();
  }
}

// ---------------------------------------------------------------------------
// Chrome assembly
// ---------------------------------------------------------------------------

function assembleChromeWidgets(controller) {
  controller.menuBar = new MenuBar();
  controller.confirmBar = new ConfirmBar();
  controller.toolBar = new ToolBar(controller.toolRegistry, true);
  controller.rightSidebar = new RightSidebar();
  controller.splashScreen = new SplashScreen(controller);
  addClass(controller.splashScreen.el, "mainblock");
  controller.linkBar.parent = controller.menuBar.parent = controller.confirmBar.parent =
    controller.toolBar.parent = controller.rightSidebar.parent =
    controller.splashScreen.parent = controller;
}

function wireChromeEvents(controller) {
  controller.splashScreen.on(EventType.widgetSelect, controller.onDocumentTabSelect, controller);
  controller.splashScreen.on(EventType.layerEffectsFlush, controller.onDocumentTabClose, controller);
  controller.splashScreen.on("shuffleItems", controller.onDocumentTabReorder, controller);
  controller.splashScreen.on(EventType.chromeRepaint, controller.onTabBarChromeRepaint, controller);
  controller.on("mouse", controller.onPointerEvent, controller);
  controller.on(EventType.documentAction, controller.handleInput, controller);
  controller.on(EventType.historyGrouped, controller.onHistoryGrouped, controller);
}

function installNativeMenus(controller) {
  installTauriMenuActionBridge({
    getMenuData: function() {
      return MenuBar.data;
    },
    dispatchTarget: controller
  });
  installTauriHomeScreenFileDrop(controller);
  installNativeMenuFromMenuBarData({
    getMenuData: function() {
      return MenuBar.data;
    },
    getCurrentDoc: function() {
      return controller.getCurrentDoc();
    },
    getAppData: function() {
      return controller.appData;
    },
    onHtmlMenuBarHidden: function() {
      controller.onResize();
    }
  }).catch(function(err) {
    console.warn("photosuite: native menu install failed", err);
  });
}

function installSystemInputListeners(controller) {
  document.body.addEventListener("keydown", controller.onDocumentKeyDown.bind(controller), false);
  window.addEventListener("keyup", controller.onDocumentKeyUp.bind(controller), false);
  window.addEventListener("paste", controller.onSystemPaste.bind(controller), false);
  window.addEventListener("copy", controller.onSystemCopy.bind(controller), false);
  window.addEventListener("wheel", function(wheelEvent) {
    if (wheelEvent.ctrlKey) wheelEvent.preventDefault();
  }, { passive: false });
}

function mountWorkspaceDom(controller) {
  const mainColumnEl = controller.mainColumn;
  const chromeHeaderRowEl = controller.chromeHeaderRow = makeElement("div");
  chromeHeaderRowEl.appendChild(controller.menuBar.el);
  chromeHeaderRowEl.appendChild(controller.confirmBar.el);
  controller.linkBar.setScrollContent(chromeHeaderRowEl);
  const workspaceRowEl = controller.workspaceRow = makeElement("div", "flexrow");
  mainColumnEl.appendChild(workspaceRowEl);
  workspaceRowEl.appendChild(controller.toolBar.el);
  workspaceRowEl.appendChild(controller.splashScreen.el);
  workspaceRowEl.appendChild(controller.rightSidebar.el);
}

function applyChromeLayoutMode(controller, layoutMode) {
  const workspaceRowEl = controller.workspaceRow;
  const mainColumnEl = controller.mainColumn;
  controller.chromeLayoutMode = layoutMode;
  const isInDom = isInDOM;
  const menuBarEl = controller.menuBar.el;
  if (isInDom(menuBarEl)) controller.chromeHeaderRow.removeChild(menuBarEl);
  const confirmBarEl = controller.confirmBar.el;
  if (isInDom(confirmBarEl)) controller.chromeHeaderRow.removeChild(confirmBarEl);
  const toolBarEl = controller.toolBar.el;
  if (isInDom(toolBarEl)) workspaceRowEl.removeChild(toolBarEl);
  const splashScreenEl = controller.splashScreen.el;
  if (isInDom(splashScreenEl)) workspaceRowEl.removeChild(splashScreenEl);
  const rightSidebarEl = controller.rightSidebar.el;
  if (isInDom(rightSidebarEl)) workspaceRowEl.removeChild(rightSidebarEl);
  if (layoutMode == CHROME_LAYOUT_NORMAL) {
    controller.chromeHeaderRow.appendChild(menuBarEl);
    controller.chromeHeaderRow.appendChild(confirmBarEl);
    mainColumnEl.appendChild(workspaceRowEl);
    workspaceRowEl.appendChild(toolBarEl);
    workspaceRowEl.appendChild(splashScreenEl);
    workspaceRowEl.appendChild(rightSidebarEl);
  }
  if (layoutMode == CHROME_LAYOUT_MENU_ONLY) {
    controller.chromeHeaderRow.appendChild(menuBarEl);
    workspaceRowEl.appendChild(splashScreenEl);
  }
  if (layoutMode == CHROME_LAYOUT_FULLSCREEN) {
    workspaceRowEl.appendChild(splashScreenEl);
  }
  controller.splashScreen.setTabBarPosition(
    layoutMode == CHROME_LAYOUT_FULLSCREEN ? 1 : 0
  );
  if (document.fullscreenEnabled) {
    if (layoutMode == CHROME_LAYOUT_FULLSCREEN) document.body.requestFullscreen();
    else if (document.fullscreenElement) document.exitFullscreen();
  }
  controller.onResize();
}

// ---------------------------------------------------------------------------
// Cap marketing copy / clipboard ref / doc index
// ---------------------------------------------------------------------------

/**
 * Format-support blurb for the #cap marketing block.
 * @param {boolean} narrowViewport
 */
function buildCapFormatBlurbHtml(narrowViewport) {
  let capHtml = escapeHtml(
    "Free online editor supporting PSD, XCF, Sketch, XD and CDR formats."
  );
  const highlightedFormats = ["PSD", "XCF", "Sketch", "XD", "CDR"];
  for (let formatIdx = 0; formatIdx < highlightedFormats.length; formatIdx++) {
    const formatName = highlightedFormats[formatIdx];
    capHtml = capHtml.replace(formatName, "<b>" + formatName + "</b>");
  }
  if (!narrowViewport) {
    capHtml += " (<b>Adobe Photoshop</b>, <b>GIMP</b>, <b>Sketch App</b>,  <b>Adobe XD</b>, <b>CorelDRAW</b>).";
  }
  return capHtml;
}

function populateCapMarketingCopy() {
  const capRoot = document.getElementById("cap");
  if (!capRoot) return;
  const narrowViewport = window.innerWidth < 500;
  const titleHeading = capRoot.getElementsByTagName("h1")[0];
  titleHeading.textContent = narrowViewport
    ? "PhotoSuite"
    : "PhotoSuite: advanced image editor";
  const capParagraphs = capRoot.getElementsByTagName("p");
  capParagraphs[0].innerHTML = buildCapFormatBlurbHtml(narrowViewport);
  // Howto copy has no angle brackets, so the optional link-wrapping path never
  // matches; always assign the plain paragraph.
  capParagraphs[1].innerHTML = CAP_HOWTO_PARAGRAPH;
}

/** Callback bag for system-clipboard paste (processLoadedBytes entry). */
function createFileLoaderProcessRef() {
  return { processLoadedBytes: FileLoader.processLoadedBytes };
}

/**
 * Clamp activeDocIndex and return the document at that slot.
 * @param {any[]|null|undefined} openDocs
 * @param {number|null|undefined} activeDocIndex
 */
function resolveCurrentDocFromOpenList(openDocs, activeDocIndex) {
  if (!openDocs || openDocs.length === 0) {
    return { doc: null, activeDocIndex: activeDocIndex == null ? 0 : activeDocIndex };
  }
  let index = activeDocIndex;
  if (index == null) index = 0;
  if (index < 0) index = 0;
  if (index >= openDocs.length) index = openDocs.length - 1;
  return { doc: openDocs[index] || null, activeDocIndex: index };
}

// ---------------------------------------------------------------------------
// Document open / pointer / update
// ---------------------------------------------------------------------------

function prepareOpenedDocumentLayers(openedDoc, fontRegistry) {
  for (let layerIdx = 0; layerIdx < openedDoc.layers.length; layerIdx++) {
    const layer = openedDoc.layers[layerIdx];
    if (layer.add.placedData != null) {
      Date.now();
    }
    if (!openedDoc.pendingTextRasterization && layer.add.TySh != null) {
      TextRenderer.checkFonts(openedDoc.layers[layerIdx].add.TySh, fontRegistry);
    }
  }
}

function finishOpenedDocumentRaster(openedDoc) {
  if (openedDoc.needsFillRasterization) {
    openedDoc.finishImportFillDeferred();
    if (openedDoc.layers.length <= 200) {
      requestAnimationFrame(function() {
        openedDoc.recalculateBounds();
      });
    }
  } else {
    openedDoc.recalculateBounds();
  }
  if (openedDoc.needsBufferInit) openedDoc.initCompositeBuffer();
  else openedDoc.markDirty();
  openedDoc.needsBufferInit = false;
}

// Core pointer dispatch. Records pointer state, forks multi-touch to the zoom
// tool, applies the temporary space/hand-tool override, then picks a gesture
// target — a modal dialog's overlay when one is up, otherwise the active tool —
// and forwards the down/move/up gesture to it and to the right sidebar, updating
// temporary-tool and dirty state and handling scroll/wheel as pan or zoom.
function routePointerEvent(controller, pointerEvent) {
  const currentDoc = controller.getCurrentDoc();
  const keyboard = controller.keyboardHandler;
  const appData = controller.appData;
  let pointerState = pointerEvent.pointerState;
  if (pointerState) controller.pointerState = pointerState;
  if (pointerEvent.action.startsWith("multi")) {
    dispatchMultiTouchDocumentAction(controller, pointerEvent);
    return;
  }
  const handTool = controller.toolRegistry.entriesById[ToolId.TOOL_MOVE].tool;
  maybeEnableTemporaryHandTool(
    controller, pointerEvent, currentDoc, appData, keyboard, handTool, pointerState
  );
  const topDialog = controller.documentView.getTopDialog();
  const gestureTarget = topDialog != null && topDialog.hasOverlay()
    && controller.toolRegistry.temporaryToolId == null
    ? topDialog
    : controller.getActiveToolEntry();
  if (
    topDialog != null
    && gestureTarget != topDialog
    && controller.documentView.isActive()
    && gestureTarget.id != ToolId.TOOL_HAND
    && gestureTarget.id != ToolId.TOOL_ZOOM
  ) {
    return;
  }
  dispatchPointerToGestureTarget(
    gestureTarget, pointerEvent, currentDoc, controller, appData, keyboard, pointerState
  );
  dispatchPointerToRightSidebar(
    controller.rightSidebar, pointerEvent, currentDoc, controller, appData, keyboard, pointerState
  );
  if (pointerEvent.action == "down" || pointerEvent.action == "up") {
    controller.updateTemporaryToolFromModifiers();
  }
  if (
    pointerEvent.action == "down"
    || pointerEvent.action == "up"
    || pointerEvent.action == "ctx"
  ) {
    currentDoc.stateChanged = true;
  }
  if (
    (pointerEvent.action == "up" || pointerEvent.action == "rup")
    && controller.toolRegistry.pointerDownToolId
  ) {
    controller.toolRegistry.pointerDownToolId = null;
    handTool.disable(currentDoc, controller, appData, keyboard);
  }
  if (pointerEvent.action == "scroll") {
    dispatchScrollDocumentAction(controller, pointerEvent, keyboard, pointerState);
  }
}

function dispatchMultiTouchDocumentAction(controller, pointerEvent) {
  const multiTouchEvent = new AppEvent(EventType.documentAction, true);
    multiTouchEvent.data = {
    actionKind: pointerEvent.action,
    touchPoints: pointerEvent.touchPoints
    };
    multiTouchEvent.routingChannel = ToolId.TOOL_ZOOM;
  controller.dispatch(multiTouchEvent);
}

function maybeEnableTemporaryHandTool(
  controller, pointerEvent, currentDoc, appData, keyboard, handTool, pointerState
) {
  if (
    (pointerEvent.action == "down" || pointerEvent.action == "rdown")
    && appData.activeToolId != ToolId.TOOL_MOVE
    && controller.toolRegistry.temporaryToolId != ToolId.TOOL_MOVE
    && handTool.shouldSwitchToHandOnPointerDown(
      currentDoc, controller, appData, keyboard, pointerState
    )
  ) {
    controller.toolRegistry.pointerDownToolId = ToolId.TOOL_MOVE;
    handTool.enable(currentDoc, controller, appData, keyboard, true);
  }
}

function dispatchPointerToGestureTarget(
  gestureTarget, pointerEvent, currentDoc, controller, appData, keyboard, pointerState
) {
  if (pointerEvent.action == "down") {
    gestureTarget.onMouseDown(currentDoc, controller, appData, keyboard, pointerState);
  }
  if (pointerEvent.action == "rdown") {
    gestureTarget.onRightMouseDown(currentDoc, controller, appData, keyboard, pointerState);
  }
  if (pointerEvent.action == "move") {
    gestureTarget.onMouseMove(currentDoc, controller, appData, keyboard, pointerState);
  }
  if (pointerEvent.action == "up") {
    gestureTarget.onMouseUp(currentDoc, controller, appData, keyboard, pointerState);
  }
  if (pointerEvent.action == "rup") {
    gestureTarget.onRightMouseUp(currentDoc, controller, appData, keyboard, pointerState);
  }
}

function dispatchPointerToRightSidebar(
  rightSidebar, pointerEvent, currentDoc, controller, appData, keyboard, pointerState
) {
  if (pointerEvent.action == "down") {
    rightSidebar.onMouseDown(currentDoc, controller, appData, keyboard, pointerState);
  }
  if (pointerEvent.action == "move") {
    rightSidebar.onMouseMove(currentDoc, controller, appData, keyboard, pointerState);
  }
  if (pointerEvent.action == "up") {
    rightSidebar.onMouseUp(currentDoc, controller, appData, keyboard, pointerState);
  }
}

function dispatchScrollDocumentAction(controller, pointerEvent, keyboard, pointerState) {
  const preferPinchZoom = !keyboard.isPressed(KeyboardHandler.Ctrl)
    && pointerEvent.wheelActsAsPinch;
  const scrollEvent = new AppEvent(EventType.documentAction, true);
    scrollEvent.data = {
    actionKind: "scroll",
    scrollDelta: pointerEvent.scrollDelta.clone(),
      pointerState: pointerState
    };
  scrollEvent.routingChannel = keyboard.isPressed(KeyboardHandler.Alt) || preferPinchZoom
    ? ToolId.TOOL_ZOOM
    : ToolId.TOOL_HAND;
  controller.dispatch(scrollEvent);
}

/**
 * Raw edge-margin pan deltas before per-frame scaling.
 * @param {{x:number,y:number}} pointerState
 * @param {number} contentWidth
 * @param {number} contentHeight
 * @param {number} [edgeMargin]
 */
function computeEdgeAutoPanDeltas(pointerState, contentWidth, contentHeight, edgeMargin) {
  if (edgeMargin == null) edgeMargin = EDGE_AUTO_PAN_MARGIN_PX;
  let scrollDeltaX = 0;
  let scrollDeltaY = 0;
    if (pointerState.x < edgeMargin) scrollDeltaX = edgeMargin - pointerState.x;
  if (pointerState.x > contentWidth - edgeMargin) {
    scrollDeltaX = pointerState.x - (contentWidth - edgeMargin);
  }
    if (pointerState.y < edgeMargin) scrollDeltaY = edgeMargin - pointerState.y;
  if (pointerState.y > contentHeight - edgeMargin) {
    scrollDeltaY = pointerState.y - (contentHeight - edgeMargin);
  }
  return { scrollDeltaX, scrollDeltaY };
}

/**
 * Cap and flip edge pan for one animation frame.
 * @param {number} scrollDeltaX
 * @param {number} scrollDeltaY
 * @param {{x:number,y:number}} pointerState
 * @param {number} [edgeMargin]
 */
function scaleEdgeAutoPanForFrame(scrollDeltaX, scrollDeltaY, pointerState, edgeMargin) {
  if (edgeMargin == null) edgeMargin = EDGE_AUTO_PAN_MARGIN_PX;
      scrollDeltaX = Math.min(5, scrollDeltaX * .5);
      scrollDeltaY = Math.min(5, scrollDeltaY * .5);
      if (!(pointerState.x < edgeMargin || pointerState.y < edgeMargin)) {
        scrollDeltaX = -scrollDeltaX;
    scrollDeltaY = -scrollDeltaY;
  }
  return { scrollDeltaX, scrollDeltaY };
}

function maybeEdgeAutoPanDocument(controller) {
  const currentDoc = controller.getCurrentDoc();
  const pointerState = controller.pointerState;
  if (!currentDoc || !controller.getActiveToolEntry().wantsInput(pointerState, controller.keyboardHandler)) {
    return;
  }
  const docView = currentDoc.pathViewport;
  const contentWidth = docView.viewportRect.width;
  const contentHeight = docView.viewportRect.height;
  let deltas = computeEdgeAutoPanDeltas(pointerState, contentWidth, contentHeight);
  if (
    (deltas.scrollDeltaX != 0 || deltas.scrollDeltaY != 0)
    && (
      currentDoc.width * docView.zoomScale > contentWidth
      || currentDoc.height * docView.zoomScale > contentHeight
    )
  ) {
    deltas = scaleEdgeAutoPanForFrame(deltas.scrollDeltaX, deltas.scrollDeltaY, pointerState);
    docView.panOffset.x += deltas.scrollDeltaX;
    docView.panOffset.y += deltas.scrollDeltaY;
    controller.onPointerEvent({
      pointerState: controller.pointerState,
        action: "move"
      });
    currentDoc.panelsDirty = true;
  }
}

function notifyToolsOfDocumentStateChange(controller, currentDoc) {
  if (!currentDoc.stateChanged) return;
  const toolEntriesById = controller.toolRegistry.entriesById;
  for (const toolId in toolEntriesById) {
    if (toolEntriesById[toolId].tool.onDocumentStateChange) {
      toolEntriesById[toolId].tool.onDocumentStateChange(
        currentDoc, controller, controller.appData, controller.keyboardHandler
      );
    }
  }
  if (!controller._pasteInFlight) {
    controller.scheduleNativeMenuBarRefresh();
  }
}

function maybeRepaintSplashAndView(controller, currentDoc, forceRepaint) {
  const docView = currentDoc.pathViewport;
  const needsRepaint = currentDoc.dirtyRect
    || currentDoc.needsComposite
    || currentDoc.dirty
    || currentDoc.panelsDirty
    || forceRepaint
    || docView.gestureZoomScale != docView.zoomScale
    || !docView.gesturePanOffset.equals(docView.panOffset);
  if (!needsRepaint) return;
  settleGestureZoomTowardTarget(docView);
  controller.splashScreen.onUpdate(controller.appData, null);
  controller.splashScreen.open(currentDoc, controller.openDocs);
}

function settleGestureZoomTowardTarget(docView) {
  const previousZoom = docView.gestureZoomScale;
    if (docView.gestureZoomScale != docView.zoomScale) {
    const targetZoomStep = ZoomTool.stepZoomLevel(
      docView.zoomScale,
      docView.gestureZoomScale > docView.zoomScale
    );
    if (docView.gestureZoomScale < docView.zoomScale && docView.gestureZoomScale < targetZoomStep) {
      docView.gestureZoomScale = targetZoomStep;
    }
    if (docView.gestureZoomScale > docView.zoomScale && docView.gestureZoomScale > targetZoomStep) {
      docView.gestureZoomScale = targetZoomStep;
    }
    const zoomDelta = Math.abs(docView.zoomScale - targetZoomStep) * (1 / (.12 * 60));
    if (docView.gestureZoomScale < docView.zoomScale) {
      docView.gestureZoomScale = Math.min(docView.zoomScale, docView.gestureZoomScale + zoomDelta);
    } else {
      docView.gestureZoomScale = Math.max(docView.zoomScale, docView.gestureZoomScale - zoomDelta);
    }
  }
  const zoomLerp = previousZoom == docView.zoomScale
    ? 0
    : (docView.gestureZoomScale - docView.zoomScale) / (previousZoom - docView.zoomScale);
  docView.gesturePanOffset.x = docView.panOffset.x
    + zoomLerp * (docView.gesturePanOffset.x - docView.panOffset.x);
  docView.gesturePanOffset.y = docView.panOffset.y
    + zoomLerp * (docView.gesturePanOffset.y - docView.panOffset.y);
}

function maybeSyncSidebarAndToolbar(controller, currentDoc) {
  if (
    !(currentDoc.dirtyRect || currentDoc.panelsDirty || currentDoc.stateChanged)
    || (controller.pointerState.isDown && !currentDoc.allowViewUpdate)
  ) {
    return;
  }
  if (currentDoc.stateChanged) currentDoc.recalculateBounds();
  controller.rightSidebar.open(currentDoc, controller.openDocs, controller.appData);
  controller.toolBar.syncFromDocument(currentDoc, controller.keyboardHandler);
  currentDoc.needsScrollToSelected = false;
}

function clearDocumentViewDirtyFlags(currentDoc) {
  currentDoc.allowViewUpdate = false;
  currentDoc.stateChanged = false;
  currentDoc.dirtyRect = null;
  currentDoc.needsComposite = currentDoc.dirty = currentDoc.panelsDirty = false;
}
