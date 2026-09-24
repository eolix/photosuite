/**
 * `App.Dispatch` UI action router mixed onto `AppController`: dialogs, panels,
 * presets, placement, and document chrome updates from dispatched `AppEvent`s.
 */

import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { Locale } from "../../core/i18n/locale.js";
import { basenameFromPath, stripFileExtension } from "../../core/file-names.js";

import { LayerSystem } from "../../engine/layer-system.js";
import { FileFormatRegistry } from "../../document/formats/registry/file-format-registry.js";
import {
  ensureFormatLoaders,
  hasFormatLoaders,
} from "../../document/formats/registry/format-loader-imports.js";
import { EventChannel, ToolId, findToolIdForActionClass } from "../../document/model/tool-base.js";
import { PathRecordCodec } from "../../document/formats/psd/path-record-codec.js";
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { ActionDescUtil } from "../../features/scripting/action-desc.js";
import { Document } from "../../document/model/document.js";
import { Layer } from "../../document/model/layer.js";
import {
  LayerStyleRenderer,
} from "../../features/layer-styles/style-renderer.js";
import { ScriptEngine } from "../../features/scripting/script-engine.js";
import { PopupTypes } from "../config/popup-types.js";
import {
  ensureDefaultBrushPresets,
  ensureDefaultSwatchPresets,
  getSwatchPresetStore,
} from "../config/default-presets.js";
import { PresetTreeList } from "../widgets/preset-tree-list.js";
import { syncSavedResources } from "./startup-resources.js";
import { removeRecentFile } from "../../core/recent-files.js";
import {
  isPanelInEffectRows,
  normalizePanelId,
  removePanelFromEffectRows,
} from "../menu/menu-bar-predicates.js";
import { AppWindow } from "./app-window.js";
import { FileLoader, FileProcessor } from "./file-loader.js";
import { persistAppSettings } from "../../core/app-settings.js";
import { BrushPresetUtil } from "../../features/brush/brush-presets.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { nativeWriteFile, openExternalUrl, pickSavePath } from "../../core/tauri-host.js";
import { confirmUser, promptConfirmUser, promptUnsavedCloseForClose, showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";
import { allocBuffer, fillBuffer, rgbaToGrayChannel } from "../../engine/compositing/buffer-utils.js";
import { contentBoundsChannel, copyChannel } from "../../engine/compositing/pixel-ops.js";
import { boundsOfPathRecords } from "../../engine/compositing/selection-utils.js";
import { transformPathRecordCoords } from "../../engine/compositing/path-records.js";
import { composite } from "../../engine/compositing/compositing-ops.js";
import { invert } from "../../engine/compositing/color-math.js";
import { toRGBDesc } from "../../engine/compositing/psd-color-utils.js";

/**
 * Dialog route id / script-method pairs for dispatchAppDialogRouter.
 * Flat list: routeId, methodName, routeId, methodName, ...
 */
export const DIALOG_SCRIPT_PAIRS =
  "open_from_url openFromURL camera takePic templates showTemplates newproject new eassets exportLayers".split(" ");

/** selectionExportKind: pattern preset from document raster. */
export const SELECTION_EXPORT_PATTERN = 0;
/** selectionExportKind: brush tip + brush preset from selection alpha. */
export const SELECTION_EXPORT_BRUSH = 1;
/** selectionExportKind: shape path preset from selected vector path. */
export const SELECTION_EXPORT_SHAPE = 2;


/**
 * Pattern preset record written into the patterns store / openResourcePresetPopup add payload.
 * @param {string} name
 * @param {string} id
 * @param {*} rasterSlice
 * @param {*} docBounds
 */
export function buildPatternPresetRecord(name, id, rasterSlice, docBounds) {
  return { name, id, rasterAndBounds: [rasterSlice, docBounds] };
}

/**
 * Resolve placeIntoDocIndex when the caller uses the "$active" sentinel.
 * Non-sentinel values pass through unchanged.
 * @param {{ openDocs?: any[], activeDocIndex?: number }} controller
 * @param {*} placeIntoDocIndex
 */
export function resolvePlaceIntoActiveDocIndex(controller, placeIntoDocIndex) {
  if (placeIntoDocIndex !== "$active") return placeIntoDocIndex;
  if (!controller.openDocs || controller.openDocs.length === 0) return null;
  if (controller.activeDocIndex == null || controller.activeDocIndex < 0) return 0;
  return Math.min(controller.activeDocIndex, controller.openDocs.length - 1);
}

/**
 * Ask before writing a PSD that Adobe Photoshop would choke on. Both limits are
 * Photoshop's, not the format's: it crashes past 8000 layers and past 10 levels
 * of layer nesting, so the file is worth writing only if the user says so.
 * @returns {boolean} true to go ahead with the write.
 */
export function confirmPhotoshopStructureLimits(doc) {
  if (doc.layers.length > 8e3 && !confirmUser(
    "Your document has " + doc.layers.length + " layers." +
    " Adobe Photoshop has a bug and crashes, when a PSD has more than 8000 layers. Do you want to proceed?"
  )) return false;
  const pathCollectOutput = { deepestPath: [] };
  doc.root.collectPaths([], pathCollectOutput);
  const deepestNestPath = pathCollectOutput.deepestPath;
  if (deepestNestPath.length > 11 && !confirmUser(
    "One layer is nested " + (deepestNestPath.length - 1) + " times." +
    " Adobe Photoshop crashes, when a layer in a PSD is nested more than 10 times. Do you want to proceed?\n\nLongest nesting: " +
    deepestNestPath.join(" \uD83E\uDC1A ") + "."
  )) return false;
  return true;
}

/**
 * Map a dialog route id to the customIO script method name, or null.
 * @param {string} dialogRouteId
 */
export function lookupDialogScriptMethod(dialogRouteId) {
  for (let pairIdx = 0; pairIdx < DIALOG_SCRIPT_PAIRS.length; pairIdx += 2) {
    if (DIALOG_SCRIPT_PAIRS[pairIdx] === dialogRouteId) return DIALOG_SCRIPT_PAIRS[pairIdx + 1];
  }
  return null;
}

/**
 * Walk `openDocs` from `docIdx`, asking about each document that holds unsaved
 * work. Unmodified documents pass straight through. The prompt is a native
 * modal, so the walk is a callback chain rather than a loop; `onDecision` gets
 * true when every document has been cleared and false as soon as one prompt is
 * declined.
 *
 * @param {Array<object>} openDocs
 * @param {number} docIdx
 * @param {function(boolean): void} onDecision
 */
export function confirmDiscardUnsavedDocuments(openDocs, docIdx, onDecision) {
  if (openDocs == null || docIdx >= openDocs.length) {
    onDecision(true);
    return;
  }
  promptUnsavedCloseForClose(openDocs[docIdx], function(keepGoing) {
    if (!keepGoing) {
      onDecision(false);
      return;
    }
    confirmDiscardUnsavedDocuments(openDocs, docIdx + 1, onDecision);
  });
}

/**
 * Mixes UI-dispatch and save helpers onto AppController.prototype.
 * @param {Function} AppController
 */
export function applyUiDispatchHandlers(AppController) {
  AppController.prototype.onUiDispatch = function(dispatchEvent) {
    handleUiDispatch(this, dispatchEvent);
  };

  /** True when the file format can be re-encoded by the registry (raster formats, PSD…). */
  AppController.prototype.documentFormatIsEncodable = function(fmt) {
    if (!fmt) return false;
    const handler = FileFormatRegistry.getFormat(fmt.toUpperCase());
    return !!(handler && handler.encode)
  };

  /** Encode the document to fmt, returning the bytes. Composites first if needed. */
  AppController.prototype.encodeDocumentBytes = function(doc, fmt) {
    if (doc.dirtyRect) doc.composite();
    const lower = (fmt || "").toLowerCase();
    // PSB is the PSD writer with 64-bit lengths, and has its own codec entry:
    // writing PSD bytes into a .psb would produce a file neither app can trust.
    if (lower == "psd" || lower == "psb") return new Uint8Array(FileFormatRegistry.getFormat(lower).encode(doc));
    // jpg/webp are lossy and need a quality; encode in place at a high default.
    const formatSpec = lower == "jpg" || lower == "jpeg" || lower == "webp" ? lower + ":0.92" : lower;
    return new Uint8Array(FileProcessor.encodeDocumentWithFormat(doc, formatSpec, this.appData))
  };

  /** Clear the modified marker and repaint chrome after a successful save. */
  AppController.prototype.markDocumentSaved = function(doc) {
    doc.savedHistoryIndex = doc.historyIndex;
    doc.dirty = true;
    this.refreshNativeMenuBar()
  };

  /**
   * Save back over the file the document was opened from. PSD/PSB keep everything;
   * raster formats that would drop layers ask whether to flatten or save a new file.
   */
  AppController.prototype.saveDocumentToOrigin = function(doc) {
    const self = this,
      fmt = (doc.formatType || "").toLowerCase(),
      preservesEverything = fmt == "psd" || fmt == "psb";
    if (!preservesEverything && !this.documentFormatIsEncodable(fmt)) {
      // Vector/document originals (svg, pdf…) can't be written back; save a new file.
      this.saveDocumentToNewFile(doc);
      return
    }
    if (!preservesEverything && doc.layers.length > 1) {
      promptConfirmUser(Locale.get(["layer.flattenToSaveOverOriginal", String(doc.layers.length), fmt.toUpperCase()]), {
        title: "PhotoSuite"
      }, function(flatten) {
        if (flatten) self.writeDocumentToPath(doc, doc.nativeFilePath, fmt);
        else self.saveDocumentToNewFile(doc)
      });
      return
    }
    this.writeDocumentToPath(doc, doc.nativeFilePath, fmt)
  };

  /**
   * The writer for a format lives in the same lazily imported module as its
   * parser, so a session that has never opened that format has nothing to
   * encode with. Fetch it, then run `retry`. Reports whether it took over.
   */
  AppController.prototype.deferSaveUntilFormatLoaders = function(fmt, retry) {
    if (hasFormatLoaders(fmt)) return false;
    ensureFormatLoaders(fmt).then(retry, function(err) {
      console.error("[file-save] could not load the " + fmt + " writer:", err);
      showToast("Could not save this file: " + String(fmt).toUpperCase() + " support failed to load.");
    });
    return true;
  };

  /** Encode and overwrite an existing path without prompting. */
  AppController.prototype.writeDocumentToPath = function(doc, path, fmt) {
    const self = this;
    if (this.deferSaveUntilFormatLoaders(fmt, function() {
      self.writeDocumentToPath(doc, path, fmt);
    })) return;
    let bytes;
    try {
      bytes = this.encodeDocumentBytes(doc, fmt)
    } catch (err) {
      console.error("[file-save] encode failed:", err);
      showToast("Could not prepare this document for saving.");
      return
    }
    nativeWriteFile(path, bytes).then(function() {
      self.markDocumentSaved(doc)
    }).catch(function(err) {
      console.error("[file-save] write failed:", err);
      showToast("Could not save the file. " + (err && err.message ? err.message : err))
    })
  };

  AppController.prototype.savePathDialogOpts = function(doc) {
    return {
      directoryKey: "lastSaveDirectory",
      defaultDirectory: doc.nativeFilePath ? doc.nativeFilePath.replace(/[/\\][^/\\]*$/, "") : null
    }
  };

  AppController.prototype.adoptDocumentSavePath = function(doc, path, fmt) {
    doc.nativeFilePath = path;
    doc.formatType = fmt;
    doc.name = basenameFromPath(path);
    this.markDocumentSaved(doc)
  };

  /** Prompt for a destination. New or layered documents default to PSD. */
  AppController.prototype.saveDocumentToNewFile = function(doc) {
    const self = this;
    let fmt = (doc.formatType || "psd").toLowerCase();
    const preservesEverything = fmt == "psd" || fmt == "psb";
    if (!preservesEverything && (doc.layers.length > 1 || !this.documentFormatIsEncodable(fmt))) fmt = "psd";
    // `fmt` is derived from the document, so the retry lands on the same format.
    if (this.deferSaveUntilFormatLoaders(fmt, function() {
      self.saveDocumentToNewFile(doc);
    })) return;
    const baseName = stripFileExtension(doc.name || "untitled"),
      defaultName = baseName + "." + fmt;
    pickSavePath(defaultName, this.savePathDialogOpts(doc)).then(function(path) {
      if (!path) return;
      let bytes;
      try {
        bytes = self.encodeDocumentBytes(doc, fmt)
      } catch (err) {
        console.error("[file-save] encode failed:", err);
        showToast("Could not prepare this document for saving.");
        return
      }
      nativeWriteFile(path, bytes).then(function() {
        self.adoptDocumentSavePath(doc, path, fmt)
      }).catch(function(err) {
        console.error("[file-save] write failed:", err);
        showToast("Could not save the file. " + (err && err.message ? err.message : err))
      })
    }).catch(function(err) {
      console.error("[file-save] save dialog failed:", err);
      showToast("Could not save the file. " + (err && err.message ? err.message : err))
    })
  };

  /** Show the native Save dialog for already-encoded bytes, then adopt the chosen path. */
  AppController.prototype.saveEncodedDocumentToNewFile = function(doc, bytes, fmt) {
    const self = this,
      baseName = stripFileExtension(doc.name || "untitled"),
      defaultName = baseName + "." + fmt;
    pickSavePath(defaultName, this.savePathDialogOpts(doc)).then(function(path) {
      if (!path) return;
      nativeWriteFile(path, bytes).then(function() {
        self.adoptDocumentSavePath(doc, path, fmt)
      }).catch(function(err) {
        console.error("[file-save] write failed:", err);
        showToast("Could not save the file. " + (err && err.message ? err.message : err))
      })
    }).catch(function(err) {
      console.error("[file-save] save dialog failed:", err);
      showToast("Could not save the file. " + (err && err.message ? err.message : err))
    })
  };
}

/**
 * What each {@link UiCommand} asks the shell to do. `handleUiDispatch` looks the
 * command up here, so a command with no entry is simply not something the shell
 * performs.
 *
 * Handlers read the trackers at call time, never at
 * module load: startup fills them after this module evaluates.
 */
const UI_COMMAND_HANDLERS = {
  replayRecordedActionPair(controller, data) {
    ActionDescUtil.playActionSetSteps(
      controller.getCurrentDoc(),
      controller.appData.actionSets,
      data.recordedActionPair[0],
      data.recordedActionPair[1],
      controller
    );
  },
  dragLayerAcrossDocuments(controller, data) {
    controller.duplicateLayersOnTabDrag(data.targetDocumentTabIndex);
  },
  rebuildAppChrome(controller) {
    controller.buildUI();
    controller.onResize();
  },
  documentLayoutInvalidate(controller) {
    controller.onResize();
  },
  splashOptionsUpdate(controller, data) {
    controller.splashScreen.updateCursorOverlayStack(data.cursorOverlayId, data.push);
  },
  splashIntroDismiss(controller) {
    controller.splashScreen.dismissIntroOverlay();
  },
  panCanvasByWheelDirection(controller, data) {
    controller.onDocumentTabSelect(null, data.dir);
  },
  focusDocumentTabByIndex(controller, data) {
    controller.splashScreen.detachPanelAt(controller.openDocs.indexOf(data.targetDocument));
  },
  propagateKeyboardShortcutToDocument(controller, data) {
    if (data.isDown) controller.keyboardHandler.onKeyDown(data.key);
    else controller.keyboardHandler.onKeyUp(data.key);
    controller.onKeyEvent(data.isDown ? "down" : "up");
  },
  extractDocSelectionAsPreset(controller, data) {
    handleExtractSelectionAsPreset(controller, data);
  },
  importFromUrl(controller, data) {
    handleImportFromUrl(controller, data);
  },
  pickLocalFiles(controller, data) {
    handlePickLocalFiles(controller, data);
  },
  openRecentFile(controller, data) {
    handleOpenRecentFile(controller, data);
  },
  openRecentFileFailed(controller, data) {
    handleOpenRecentFileFailed(controller, data);
  },
  exitApplication(controller) {
    handleExitApplication(controller);
    return;
  },
  exportPopupResourceBundle(controller, data) {
    handleExportPopupResourceBundle(controller, data);
  },
  confirmPersistStartupResource(controller, data) {
    handleConfirmPersistResource(controller, data);
  },
  saveOrCommitDocument(controller, data) {
    handleSaveOrCommit(controller, data);
  },
  saveDocumentAsPSD(controller, data) {
    handleSaveDocumentAsPsd(controller, data);
  },
  openTranslateLink(controller, data) {
    openExternalUrl(data.link);
  },
  editPlacedLayerSource(controller) {
    handleEditPlacedLayerSource(controller);
  },
  cutPathsOrClearSelection(controller) {
    controller.cutSelectionOrLayers();
  },
  clipboardCopyLayers(controller, data) {
    handleClipboardCopyLayers(controller, data);
  },
  clipboardPasteLayers(controller, data) {
    handleClipboardPasteLayers(controller, data);
  },
  pasteVectorPathsFromClipboard(controller, data) {
    handlePasteVectorPathsFromClipboard(controller, data);
  },
  runExtensionScriptSnippet(controller, data) {
    ScriptEngine.execute(data.scriptSource, controller);
  },
  postClipboardEmbedMessage(controller, data) {
    if (window.parent != window) window.parent.postMessage(data.embedMessage, "*");
    controller.rightSidebar.broadcastMessage(data.embedMessage);
  },
  registerFontFaceFromUrlParam(controller, data) {
    handleRegisterFontFaceFromUrlParam(controller, data);
  },
  openCommandPaletteSearch(controller) {
    controller.overlayManager.openCommandPalette(controller.getCurrentDoc(), controller.appData);
  },
  dispatchAppDialogRouter(controller, data, dispatchEvent) {
    handleDispatchAppDialogRouter(controller, dispatchEvent);
  },
  downloadBlobSaveAs(controller, data) {
    FileLoader.save(data.data, data.name, data.saveOptions);
  },
  saveEncodedDocumentAs(controller, data) {
    handleSaveEncodedDocumentAs(controller, data);
  },
  focusDocumentTab(controller, data, dispatchEvent) {
    if (!controller.documentView.isActive() || dispatchEvent.fromDialog) {
      controller.onDocumentOpened(data.openedDocument);
    }
  },
  applyDocumentMutationAndCloseExtra(controller, data) {
    handleApplyDocumentMutationAndCloseExtra(controller, data);
  },
  importDroppedFiles(controller, data) {
    controller.fileLoader.loadLocalFiles(
      data.data,
      null,
      data.placeIntoDocIndex,
      data.insertLayerIndex,
      data.fileHandles
    );
  },
  setActiveToolPanelMode(controller, data, dispatchEvent) {
    handleSetActiveToolPanelMode(controller, dispatchEvent);
  },
  focusExtendedToolChrome(controller) {
    if (controller.toolRegistry.savedActiveToolId) {
      controller.activateTool(controller.toolRegistry.savedActiveToolId);
    }
  },
  applyDocumentToolAction(controller, data) {
    const activeToolInstance = controller.toolRegistry.entriesById[data.routingChannel].tool;
    const doc = controller.getCurrentDoc();
    activeToolInstance.applyAction(data, controller, doc, controller.keyboardHandler, controller.appData);
    if (doc) doc.stateChanged = true;
    controller.updateTemporaryToolFromModifiers();
  },
  forwardActiveToolGesture(controller, data) {
    const toolRegistryEntry = controller.toolRegistry.entriesById[data.routingChannel];
    controller.ensureToolOptionPanel(toolRegistryEntry);
    toolRegistryEntry.optionPanel.onToolEvent(data);
  },
  openResourcePresetPopup(controller, data) {
    handleOpenResourcePresetPopup(controller, data);
  },
};

/** Route one `uiDispatch` event to the handler for its command. */
function handleUiDispatch(controller, dispatchEvent) {
  AppWindow.prototype.onUiDispatch.call(controller, dispatchEvent);
  const data = dispatchEvent.data;
  const runCommand = UI_COMMAND_HANDLERS[data.dispatchKind];
  if (runCommand) runCommand(controller, data, dispatchEvent);
}

/**
 * Point the renderer at the GPU or the CPU, following the user's preference.
 *
 * The preference is intent; `LayerSystem.webglEnabled` is what the renderer acts
 * on this moment. They are deliberately separate: a document whose textures
 * exceed the GPU limit drops the renderer to CPU for that session without
 * rewriting what the user asked for. A machine with no GL context stays on CPU
 * whatever the preference says.
 *
 * @param {Record<string, unknown>} prefs
 */
export function applyGpuAccelerationPreference(prefs) {
  const wantsGpu = prefs == null || prefs.gpuAcceleration !== false;
  LayerSystem.webglEnabled = wantsGpu && LayerSystem.glContextAvailable === true;
}

function handleExtractSelectionAsPreset(controller, data) {
  const doc = controller.getCurrentDoc();
  const rasterSlice = doc.getRasterData().slice(0);
  const activeLayer = doc.layers[doc.selectedLayerIndices[0]];
  const docBounds = new Rect(0, 0, doc.width, doc.height);
  const presetUid = Document.generateUID();
  const outboundEvent = new AppEvent(EventType.uiDispatch, true);

  if (data.selectionExportKind == SELECTION_EXPORT_PATTERN) {
    outboundEvent.data = {
      dispatchKind: UiCommand.openResourcePresetPopup,
      scriptHostData: "add",
      popupType: PopupTypes.PATTERNS,
      presetPayload: [buildPatternPresetRecord(stripFileExtension(doc.name), presetUid, rasterSlice, docBounds)]
    };
    controller.dispatch(outboundEvent);
  }
  if (data.selectionExportKind == SELECTION_EXPORT_BRUSH) {
    dispatchBrushPresetFromSelection(controller, outboundEvent, rasterSlice, docBounds, presetUid);
  }
  if (data.selectionExportKind == SELECTION_EXPORT_SHAPE) {
    dispatchShapePresetFromSelection(controller, outboundEvent, doc, activeLayer, presetUid);
  }
}

function dispatchBrushPresetFromSelection(controller, outboundEvent, rasterSlice, docBounds, presetUid) {
  const rgbaBuffer = allocBuffer(docBounds.area() * 4);
  fillBuffer(rgbaBuffer, 4294967295);
  composite("norm", rasterSlice, docBounds, rgbaBuffer, docBounds, docBounds, 1);
  const grayChannel = allocBuffer(docBounds.area());
  rgbaToGrayChannel(rgbaBuffer, grayChannel);
  invert(grayChannel);
  let alphaBounds = contentBoundsChannel(grayChannel, docBounds);
  if (alphaBounds.isEmpty()) alphaBounds = docBounds;
  const sampleChannel = allocBuffer(alphaBounds.area());
  copyChannel(grayChannel, docBounds, sampleChannel, alphaBounds);
  const brushSample = {
    boundsRect: alphaBounds,
    id: presetUid,
    channel: sampleChannel
  };
  const brushDescriptor = BrushPresetUtil.getDefaultBrushDescriptor(presetUid);
  const brushShape = brushDescriptor.Brsh.v;
  brushShape.diameter.v.val = alphaBounds.width;
  brushShape.Spcn.v.val = 10;
  outboundEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    scriptHostData: "add",
    popupType: PopupTypes.BRUSHES,
    presetPayload: {
      list: [{
        t: "Objc",
        v: brushDescriptor
      }],
      samples: [brushSample],
      patterns: []
    }
  };
  controller.dispatch(outboundEvent);
  outboundEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.SCRIPTS,
    brushPreset: brushDescriptor
  };
  controller.dispatch(outboundEvent);
}

function dispatchShapePresetFromSelection(controller, outboundEvent, doc, activeLayer, presetUid) {
  const pathsState = doc.getPaths();
  const selectedPath = pathsState[0][pathsState[1][0]];
  const shapeRecord = {
    categoryName: activeLayer.getName(),
    shapeName: presetUid,
    pathRecords: selectedPath.add.vmsk.clone().b
  };
  const shapeBounds = boundsOfPathRecords(shapeRecord.pathRecords);
  const normalizeMatrix = new Matrix2D(shapeBounds.width, 0, 0, shapeBounds.height, shapeBounds.x, shapeBounds.y);
  normalizeMatrix.invert();
  transformPathRecordCoords(shapeRecord.pathRecords, normalizeMatrix);
  shapeBounds.x = shapeBounds.y = 0;
  shapeRecord.boundsRect = shapeBounds.clone();
  outboundEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    scriptHostData: "add",
    popupType: PopupTypes.SHAPES,
    presetPayload: [shapeRecord]
  };
  controller.dispatch(outboundEvent);
}

function handleImportFromUrl(controller, data) {
  const importSpec = data.importSpec;
  if (importSpec) {
    importSpec.placeIntoDocIndex = resolvePlaceIntoActiveDocIndex(controller, importSpec.placeIntoDocIndex);
  }
  controller.fileLoader.enqueueUrlLoad(importSpec);
}

function handlePickLocalFiles(controller, data) {
  const preferSplashPanel = data.openAsPlaced;
  if (preferSplashPanel != true && controller.runSavedScriptIfAny("open")) return;
  const pickerOptions = {
    imagesOnly: data.imagesOnly === true
  };
  if (data.fileAccept) pickerOptions.accept = data.fileAccept;
  controller.fileLoader.openFilePicker(
    preferSplashPanel ? controller.splashScreen.getActivePanelIndex() : null,
    pickerOptions
  );
}

function handleOpenRecentFile(controller, data) {
  if (data.filePath == null || data.filePath === "") return;
  if (controller.runSavedScriptIfAny("open")) return;
  controller.fileLoader.openFileByPath(data.filePath, data.fileName, null);
}

function handleOpenRecentFileFailed(controller, data) {
  if (data.filePath == null || data.filePath === "") return;
  removeRecentFile(data.filePath).then(function() {
    controller.refreshRecentFilesUi();
  });
}

/**
 * Quit the application. Every route into this - the macOS App menu Quit row,
 * the window close button, and the File - Exit item on Windows and Linux -
 * arrives here so unsaved work is always prompted for first. Declining any one
 * prompt abandons the quit and leaves every document open.
 */
function handleExitApplication(controller) {
  confirmDiscardUnsavedDocuments(controller.openDocs, 0, function(shouldQuit) {
    if (shouldQuit) exitHostApplication();
  });
}

function exitHostApplication() {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (tauri && tauri.core && typeof tauri.core.invoke === "function") {
    tauri.core.invoke("photosuite_exit_app").catch(function() {});
  }
}

function handleExportPopupResourceBundle(controller, data) {
  let presetKind = data.popupTypeId;
  let exportPayload = controller.getPresetStore(presetKind);
  if (presetKind == PopupTypes.STYLES) {
    const scratchDoc = new Document();
    for (let styleIdx = 0; styleIdx < exportPayload.length; styleIdx++) {
      const layerEffectsDesc = exportPayload[styleIdx].styleEffects.Lefx;
      if (layerEffectsDesc) {
        LayerStyleRenderer.refreshPatternPickerWidgets(layerEffectsDesc, scratchDoc, controller.appData.patternPresets);
      }
    }
    exportPayload = {
      patterns: scratchDoc.add.Patt ? scratchDoc.add.Patt : [],
      layerStyles: exportPayload
    };
  }
  if (presetKind == PopupTypes.TOOL_PRESETS) {
    exportPayload = {
      samples: [],
      patterns: [],
      list: exportPayload
    };
  }
  if (presetKind == PopupTypes.ACTIONS) exportPayload = exportPayload[data.actionSetIndex];
  const resource = PopupTypes.getPresetResource(presetKind);
  const encodedBundle = resource.parser.serialize(exportPayload);
  FileLoader.save(encodedBundle, resource.bundleName + "." + resource.extension);
}

/**
 * Keep an imported library for next startup and show it in the Resource Manager.
 */
export function handleConfirmPersistResource(controller, data) {
  const startupResourceStore = controller.appData.startupResourceStore;
  startupResourceStore.storedFiles[data.storageEntryName] = data.fileByteBuffer;
  const outboundEvent = new AppEvent(EventType.uiDispatch);
  outboundEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.STARTUP_RESOURCES
  };
  controller.dispatch(outboundEvent);
}

function handleSaveOrCommit(controller, data) {
  const doc = controller.getCurrentDoc();
  let saveHandled = false;
  if (doc == null) return;
  if (doc.dirtyRect) doc.composite();
  if (data.activeChannelEncodeArgs) {
    const activeChannelBytes = FileProcessor.encodeFromActiveChannel(doc, data.activeChannelEncodeArgs, controller.appData);
    controller.onComplete(activeChannelBytes);
    saveHandled = true;
  } else if (doc.parentDocRef) {
    if (controller.openDocs.indexOf(doc.parentDocRef.sourceDocument) != -1) {
      const smartObjectPsdBytes = new Uint8Array(FileFormatRegistry.getFormat("PSD").encode(doc, null, null, [true, false]));
      const outboundEvent = new AppEvent(EventType.documentAction, true);
      outboundEvent.data = {
        actionKind: Layer.updateLinkedItem,
        openedDocument: doc.parentDocRef.sourceDocument,
        data: smartObjectPsdBytes,
        id: doc.parentDocRef.linkedItemTag
      };
      outboundEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
      controller.dispatch(outboundEvent);
      showToast("Smart Object updated");
    }
    saveHandled = true;
  } else if (controller.runSavedScriptIfAny("save")) {
    saveHandled = true;
  } else {
    // Write back to the file the document came from, or prompt for a location
    // when it has no on-disk origin yet.
    if (doc.nativeFilePath) controller.saveDocumentToOrigin(doc);
    else controller.saveDocumentToNewFile(doc);
    return;
  }
  if (doc.localFileHandle && doc.formatType == "psd") {
    const outboundEvent = new AppEvent(EventType.uiDispatch, true);
    outboundEvent.data = {
      dispatchKind: UiCommand.saveDocumentAsPSD,
      writeToExistingFileHandle: true
    };
    controller.dispatch(outboundEvent);
    return;
  }
  if (saveHandled) {
    doc.savedHistoryIndex = doc.historyIndex;
    doc.dirty = true;
  } else {
    const outboundEvent = new AppEvent(EventType.uiDispatch, true);
    outboundEvent.data = {
      dispatchKind: UiCommand.saveDocumentAsPSD
    };
    controller.dispatch(outboundEvent);
  }
}

function handleSaveDocumentAsPsd(controller, data) {
  if (controller.runSavedScriptIfAny("saveAsPSD")) return;
  const splitPathsEvent = new AppEvent(EventType.documentAction, true);
  splitPathsEvent.data = {
    actionKind: Layer.splitOpenVectorPaths
  };
  splitPathsEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
  controller.dispatch(splitPathsEvent);
  const doc = controller.getCurrentDoc();
  if (doc == null) return;
  if (doc.dirtyRect) doc.composite();
  if (!confirmPhotoshopStructureLimits(doc)) return;
  if (!data.writeToExistingFileHandle) {
    const baseName = stripFileExtension(doc.name || "untitled");
    const defaultName = baseName + ".psd";
    pickSavePath(defaultName, controller.savePathDialogOpts(doc)).then(function(path) {
      if (!path) return;
      const psdBytes = FileFormatRegistry.getFormat("PSD").encode(doc);
      nativeWriteFile(path, new Uint8Array(psdBytes)).then(function() {
        controller.adoptDocumentSavePath(doc, path, "psd");
      }).catch(function(err) {
        console.error("[file-save] write failed:", err);
        showToast("Could not save the file. " + (err && err.message ? err.message : err));
      });
    }).catch(function(err) {
      console.error("[file-save] save dialog failed:", err);
      showToast("Could not save the file. " + (err && err.message ? err.message : err));
    });
    return;
  }
  const psdBytes = FileFormatRegistry.getFormat("PSD").encode(doc);
  if (data.writeToExistingFileHandle) {
    doc.localFileHandle.createWritable().then(function(fileHandle) {
      fileHandle.write(psdBytes);
      return fileHandle;
    }).then(function(fileHandle) {
      fileHandle.close();
    });
  } else {
    FileLoader.save(psdBytes, doc.name);
  }
  doc.savedHistoryIndex = doc.historyIndex;
  doc.dirty = true;
}

/**
 * Write bytes the Save As dialog already encoded to a file of the user's
 * choosing, and hand that file to the document. PSD and PSB pass the Photoshop
 * structure limits first: the prompt is about the file being written, so it
 * belongs here rather than in the dialog that produced the bytes.
 */
function handleSaveEncodedDocumentAs(controller, data) {
  const writesPsd = data.formatId === "psd" || data.formatId === "psb";
  if (writesPsd && !confirmPhotoshopStructureLimits(data.targetDocument)) return;
  controller.saveEncodedDocumentToNewFile(data.targetDocument, data.data, data.formatId);
}

function handleEditPlacedLayerSource(controller) {
  if (controller.documentView.isActive()) {
    controller.showCloseOverlayOrConfirmAlert();
    return;
  }
  const doc = controller.getCurrentDoc();
  const placedLayer = doc.layers[doc.selectedLayerIndices[0]];
  const linkedAsset = doc.findLinkedItemByTag(placedLayer.add.placedData.Idnt.v);
  for (let openDocIdx = 0; openDocIdx < controller.openDocs.length; openDocIdx++) {
    const openDocParentRef = controller.openDocs[openDocIdx].parentDocRef;
    if (
      openDocParentRef != null &&
      openDocParentRef.linkedItemTag == linkedAsset.tag &&
      openDocParentRef.sourceDocument == doc
    ) {
      controller.splashScreen.selectPanelAt(openDocIdx);
      return;
    }
  }
  FileLoader.processLoadedBytes({
    name: linkedAsset.fileName,
    parentDocRef: {
      linkedItemTag: placedLayer.add.placedData.Idnt.v,
      sourceDocument: doc
    }
  }, linkedAsset.raw.buffer, controller);
}

function handleClipboardCopyLayers(controller, data) {
  const textEntry = controller.toolRegistry.entriesById[ToolId.TOOL_TYPE];
  if (textEntry && textEntry.tool && textEntry.tool.isActive()) {
    textEntry.tool.copyTextSelection(controller.appData);
  } else {
    controller.copySelectionToClipboard(data.copyMerged, data.layerIndex);
  }
}

function handleClipboardPasteLayers(controller, data) {
  const textEntry = controller.toolRegistry.entriesById[ToolId.TOOL_TYPE];
  if (textEntry && textEntry.tool && textEntry.tool.isActive()) {
    textEntry.tool.pasteTextFromClipboard(controller.appData);
  } else {
    controller.pasteFromInternalClipboard(data.skipInternalClipboard, data.pasteIntoSelection);
  }
}

function handlePasteVectorPathsFromClipboard(controller, data) {
  const vectorClipboardText = data.value;
  if (vectorClipboardText.startsWith("vcb;")) {
    const parsedPathBundle = JSON.parse(vectorClipboardText.slice(4));
    parsedPathBundle[0] = PathRecordCodec.serializableToPath(parsedPathBundle[0]);
    const outboundEvent = new AppEvent(EventType.documentAction, true);
    outboundEvent.routingChannel = ToolId.TOOL_PATH_SELECT;
    outboundEvent.data = {
      actionKind: "append",
      historyLabelKey: "Paste Paths",
      pathSegmentClipboard: parsedPathBundle
    };
    controller.dispatch(outboundEvent);
  }
}

function handleRegisterFontFaceFromUrlParam(controller, data) {
  const panelId = data.dialogRouteId;
  if (!isPanelInEffectRows(panelId, controller.appData)) {
    const outboundEvent = new AppEvent(EventType.uiDispatch, true);
    outboundEvent.data = {
      dispatchKind: UiCommand.openResourcePresetPopup,
      popupType: PopupTypes.FONTS,
      value: panelId,
      scriptHostData: "add"
    };
    controller.dispatch(outboundEvent);
  }
  controller.rightSidebar.attachPanelByPanelId(panelId);
  controller.refreshNativeMenuBar();
}

function handleDispatchAppDialogRouter(controller, dispatchEvent) {
  const scriptMethod = lookupDialogScriptMethod(dispatchEvent.data.dialogRouteId);
  if (scriptMethod != null && controller.runSavedScriptIfAny(scriptMethod)) return;
  controller.documentView.openDialog(
    dispatchEvent.data.dialogRouteId,
    controller.getCurrentDoc(),
    dispatchEvent.data,
    controller.openDocs,
    controller.keyboardHandler
  );
}

function handleApplyDocumentMutationAndCloseExtra(controller, data) {
  controller.splashScreen.selectPanelAt(data.target);
  const outboundEvent = new AppEvent(EventType.documentAction, true);
  outboundEvent.data = {
    actionKind: Layer.placeSmartObject,
    openedDocument: data.openedDocument,
    importFileBytes: data.importFileBytes,
    embeddedFileName: data.embeddedFileName,
    insertLayerIndex: data.insertLayerIndex
  };
  outboundEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
  controller.dispatch(outboundEvent);
  controller.activateTool(ToolId.TOOL_FREE_TRANSFORM);
}

function handleSetActiveToolPanelMode(controller, dispatchEvent) {
  if (controller.documentView.getTopDialog() == null) {
    const toolId = dispatchEvent.routingChannel != null
      ? dispatchEvent.routingChannel
      : dispatchEvent.data && (
        dispatchEvent.data.routingChannel != null
          ? dispatchEvent.data.routingChannel
          : dispatchEvent.data.documentModelType
      );
    if (toolId != null && controller.toolRegistry.entriesById[toolId]) {
      controller.activateTool(toolId, dispatchEvent.data && dispatchEvent.data.toolOptions);
    }
  }
}

/**
 * Resource-preset popup mutations and side effects (set / add / del / rename / tree / colors).
 * Early-returns without updateAllPanels when TOOL_PRESETS add aborts or rename finds a missing slot.
 * @param {*} controller
 * @param {*} data
 */
function handleOpenResourcePresetPopup(controller, data) {
  const doc = controller.getCurrentDoc();
  let popupType = data.popupType;
  let presetPayload = data.presetPayload;
  const appData = controller.appData;

  // Text style snapshot updates (FontComboBox / text options).
  // These events do not use scriptHostData set/add/del but still must update appData.currentTextStyle
  // so the active TextTool can apply updateStyles.
  if (popupType == PopupTypes.EXPORT_AS && data.currentTextStyle) {
    appData.currentTextStyle = data.currentTextStyle;
  }
  if (data.scriptHostData == "set") {
    handlePresetPopupSet(controller, appData, presetPayload);
  }
  if (data.scriptHostData == "add") {
    const addResult = handlePresetPopupAdd(controller, doc, appData, popupType, presetPayload, data);
    if (addResult.aborted) return;
    presetPayload = addResult.presetPayload;
  }
  if (data.scriptHostData == "del") {
    handlePresetPopupDelete(controller, appData, popupType, data);
  }
  if (data.scriptHostData == "rnm") {
    if (handlePresetPopupRename(controller, popupType, data) === false) return;
  }
  if (data.scriptHostData == "mdf" && PopupTypes.usesTreePicker(popupType)) {
    handlePresetPopupModifyTree(controller, appData, popupType);
  }

  applyPresetPopupSideEffects(controller, doc, appData, popupType, data);

  if (popupType == PopupTypes.BRUSHES && ensureDefaultBrushPresets(appData.brushPresets)) {
    popupType = PopupTypes.ALL;
  }
  if (popupType == PopupTypes.SWATCHES && ensureDefaultSwatchPresets(getSwatchPresetStore(appData))) {
    popupType = PopupTypes.ALL;
  }
  controller.updateAllPanels(popupType);
}

function handlePresetPopupSet(controller, appData, presetPayload) {
  const toolIdForPreset = findToolIdForActionClass(presetPayload);
  if (appData.activeToolId != toolIdForPreset) controller.activateTool(toolIdForPreset);
  controller.toolRegistry.entriesById[toolIdForPreset].optionPanel.applyPreset(presetPayload, appData);
}

/**
 * @returns {{ aborted: boolean, presetPayload: * }}
 */
function handlePresetPopupAdd(controller, doc, appData, popupType, presetPayload, data) {
  const resource = PopupTypes.getPresetResource(popupType);
  if (popupType == PopupTypes.FONTS) {
    appData.effectRows.push(normalizePanelId(data.value));
    appData.effectRows.sort(function(panelIdLeft, panelIdRight) {
      return panelIdLeft - panelIdRight;
    });
    controller.refreshNativeMenuBar();
    return { aborted: false, presetPayload: presetPayload };
  }
  if (resource == null) {
    if (presetPayload) appData.fontRegistry.registerParsedFace(presetPayload, data.suppressPresetAddedAlert);
    return { aborted: false, presetPayload: presetPayload };
  }

  let presetStore = controller.getPresetStore(popupType);
  if (popupType == PopupTypes.BRUSHES) {
    presetStore.samples = presetStore.samples.concat(presetPayload.samples);
    presetStore.patterns = presetStore.patterns.concat(presetPayload.patterns);
    presetStore = presetStore.list;
    presetPayload = presetPayload.list;
  }
  if (popupType == PopupTypes.STYLES && doc) {
    for (let styleEntryIdx = 0; styleEntryIdx < presetPayload.length; styleEntryIdx++) {
      const layerEffectsDesc = presetPayload[styleEntryIdx].styleEffects.Lefx;
      if (layerEffectsDesc) {
        LayerStyleRenderer.reloadPatternPresetsIfMoved(layerEffectsDesc, doc, appData.patternPresets);
      }
    }
  }
  if (popupType == PopupTypes.TOOL_PRESETS && presetPayload == null) {
    const currentToolPreset = controller.toolRegistry.entriesById[appData.activeToolId].optionPanel.getCurrentPreset();
    if (currentToolPreset == null) return { aborted: true, presetPayload: null };
    presetPayload = [currentToolPreset];
  }
  if (PopupTypes.usesTreePicker(popupType) && presetPayload && presetPayload.length && presetPayload[0] && presetPayload[0][0] == "_all_") {
    presetPayload = presetPayload[0][2];
  }
  for (let payloadEntryIdx = 0; payloadEntryIdx < presetPayload.length; payloadEntryIdx++) {
    if (popupType == PopupTypes.SWATCHES) {
      const rootName = presetPayload[payloadEntryIdx][0];
      let hasRoot = false;
      for (let storeScanIdx = 0; storeScanIdx < presetStore.length; storeScanIdx++) {
        if (presetStore[storeScanIdx] && presetStore[storeScanIdx][0] == rootName) {
          hasRoot = true;
          break;
        }
      }
      if (hasRoot) continue;
    }
    presetStore.push(presetPayload[payloadEntryIdx]);
  }
  if (popupType == PopupTypes.BRUSHES) {
    BrushPresetUtil.sanitizeBrushPresetList(appData.brushPresets.list);
    if (appData.brushPresets.activeBrushPreset == null) {
      for (let brushListIdx = 0; brushListIdx < appData.brushPresets.list.length; brushListIdx++) {
        const brushPreset = BrushPresetUtil.getBrushPresetFromListEntry(appData.brushPresets.list[brushListIdx]);
        if (brushPreset != null) {
          appData.brushPresets.activeBrushPreset = JSON.parse(JSON.stringify(brushPreset));
          break;
        }
      }
    }
  }
  if (data.suppressPresetAddedAlert != true) {
    if (
      presetStore.length != presetPayload.length ||
      popupType == PopupTypes.SWATCHES ||
      popupType == PopupTypes.STYLES ||
      popupType == PopupTypes.ACTIONS
    ) {
      showToast(Locale.get(resource.localeKey) + " " + Locale.get("history.added") + ".");
    }
  }
  return { aborted: false, presetPayload: presetPayload };
}

function handlePresetPopupDelete(controller, appData, popupType, data) {
  if (popupType == PopupTypes.FONTS) {
    removePanelFromEffectRows(data.value, appData);
    controller.refreshNativeMenuBar();
    return;
  }
  const resource = PopupTypes.getPresetResource(popupType);
  const deleteIndices = data.presetSelectionPath;
  let presetStore = controller.getPresetStore(popupType);
  if (popupType == PopupTypes.BRUSHES) presetStore = presetStore.list;
  for (let deleteIdx = 0; deleteIdx < deleteIndices.length; deleteIdx++) {
    presetStore[deleteIndices[deleteIdx]] = null;
  }
  for (let storeScanIdx = 0; storeScanIdx < presetStore.length; storeScanIdx++) {
    if (presetStore[storeScanIdx] == null) {
      presetStore.splice(storeScanIdx, 1);
      storeScanIdx--;
    }
  }
  showToast(Locale.get(resource.localeKey) + " deleted.");
}

/**
 * @returns {boolean} false when the rename target is missing (caller should skip panel update)
 */
function handlePresetPopupRename(controller, popupType, data) {
  const resource = PopupTypes.getPresetResource(popupType);
  let presetStore = controller.getPresetStore(popupType);
  if (popupType == PopupTypes.BRUSHES) presetStore = presetStore.list;
  if (PopupTypes.usesTreePicker(popupType) && Array.isArray(data.presetSelectionPath)) {
    const treeNode = PresetTreeList.getNodeAtPath(presetStore, data.presetSelectionPath);
    if (treeNode) treeNode[0] = data.value;
  } else {
    if (presetStore[data.presetSelectionPath[0]] == null) return false;
    resource.parser.setName(presetStore[data.presetSelectionPath[0]], data.value);
  }
  return true;
}

function handlePresetPopupModifyTree(controller, appData, popupType) {
  const treeResource = PopupTypes.getPresetResource(popupType);
  appData.startupResourceStore.storedFiles = appData.startupResourceStore.storedFiles || {};
  try {
    appData.startupResourceStore.storedFiles["_all_." + treeResource.extension] =
      treeResource.parser.serializeTree(controller.getPresetStore(popupType));
  } catch (_) {}
}

function applyPresetPopupSideEffects(controller, doc, appData, popupType, data) {
  if (popupType == PopupTypes.PLACE_IMAGE) {
    const popupPayload = data.value;
    appData.currentFill = popupPayload;
    appData.fillPresetsByKind[popupPayload.fillKind] = popupPayload.fillDescriptor;
  }
  if (popupType == PopupTypes.SHAPE_STROKE) {
    const popupPayload = data.value;
    appData.currentStroke = popupPayload;
    const strokeEnabled = popupPayload.strokeEnabled.v;
    const strokeStyleContent = popupPayload.strokeStyleContent.v;
    const strokeFillRef = strokeEnabled
      ? {
        fillKind: 1 + LayerEffectDefs.StrokeStyleDefs.fillLayerTypes.indexOf(strokeStyleContent.classID),
        fillDescriptor: strokeStyleContent
      }
      : { fillKind: 0 };
    appData.strokeFillPresetsByKind[strokeFillRef.fillKind] = strokeFillRef.fillDescriptor;
  }
  if (popupType == PopupTypes.EXPORT_AS) {
    appData.currentTextStyle = data.currentTextStyle;
  }
  if (popupType == PopupTypes.SCRIPTS) {
    appData.brushPresets.activeBrushPreset = data.brushPreset;
  }
  if (popupType == PopupTypes.ABOUT) {
    appData.favoriteFontFamilies = data.fontFavorites;
  }
  if (popupType == PopupTypes.COLOR_CHANGE) {
    applyColorChangePopup(controller, doc, appData, data);
  }
  if (popupType == PopupTypes.TOGGLE_RULERS) {
    appData.rulers = !appData.rulers;
    controller.onResize();
  }
  if (popupType == PopupTypes.TOGGLE_EXTRAS) {
    appData.extras = !appData.extras;
    controller.onResize();
  }
  const uiPrefs = appData.prefs;
  if (popupType == PopupTypes.OPEN_FILE) {
    uiPrefs.showSelectionEdges = !uiPrefs.showSelectionEdges;
    controller.onResize();
  }
  if (popupType == PopupTypes.CANVAS_SIZE) {
    uiPrefs.paths = !uiPrefs.paths;
    controller.onResize();
  }
  if (popupType == PopupTypes.KEYBOARD_SHORTCUTS) {
    uiPrefs.guides = !uiPrefs.guides;
    controller.onResize();
  }
  if (popupType == PopupTypes.PLUGINS) {
    uiPrefs.showGrid = !uiPrefs.showGrid;
    controller.onResize();
  }
  if (popupType == PopupTypes.IMAGE_SIZE) {
    uiPrefs.showPixelGrid = !uiPrefs.showPixelGrid;
    controller.onResize();
  }
  if (popupType == PopupTypes.ROTATE_CANVAS) {
    uiPrefs.slices = !uiPrefs.slices;
    controller.onResize();
  }
  if (popupType == PopupTypes.PREFERENCES) {
    appData.prefs = data.prefsSnapshot;
    applyGpuAccelerationPreference(appData.prefs);
    controller.onResize();
    if (controller.openDocs.length > 0) controller.getCurrentDoc().markDirty();
    persistAppSettings(controller).catch(function(err) {
      console.warn("PhotoSuite: failed to save preferences", err);
    });
  }
  if (popupType == PopupTypes.SAVE_AS) {
    appData.snapEnabled = !appData.snapEnabled;
    controller.onResize();
  }
  if (popupType == PopupTypes.NEW_DOCUMENT) {
    appData.showToggles[data.showToggleIndex] = !appData.showToggles[data.showToggleIndex];
    controller.onResize();
  }
  if (popupType == PopupTypes.CHANGE_LANGUAGE) {
    Locale.setActiveTableIndex(data.lang);
    controller.buildUI();
    controller.onResize();
    controller.refreshNativeMenuBar();
    persistAppSettings(controller).catch(function(err) {
      console.warn("PhotoSuite: failed to save language", err);
    });
  }
  if (popupType == PopupTypes.CHANGE_THEME) {
    appData.theme = data.theme;
    controller.buildUI();
    controller.refreshNativeMenuBar();
    persistAppSettings(controller).catch(function(err) {
      console.warn("PhotoSuite: failed to save theme", err);
    });
  }
  if (popupType == PopupTypes.STARTUP_RESOURCES) {
    syncSavedResources(appData.startupResourceStore.storedFiles, function(resourceName) {
      showToast("Could not save " + resourceName, 7e3);
    });
  }
}

function applyColorChangePopup(controller, doc, appData, data) {
  let colorActionDesc;
  let colorPropertyKey = "Clrs";
  if (data.operation < 2) {
    const packedColor = data.value;
    const isForeground = data.operation == 0;
    const rgbColorDesc = toRGBDesc({
      h: packedColor >>> 16,
      l: packedColor >>> 8 & 255,
      O: packedColor & 255
    });
    if (isForeground) appData.colorInt = packedColor;
    else appData.bgColor = packedColor;
    colorPropertyKey = isForeground ? "FrgC" : "BckC";
    colorActionDesc = {
      uf: "set",
      actionDescriptor: {
        __name: "Set",
        classID: "setd",
        T: {
          t: "Objc",
          v: rgbColorDesc
        }
      }
    };
  }
  if (data.operation == 2) {
    const swappedColor = appData.colorInt;
    appData.colorInt = appData.bgColor;
    appData.bgColor = swappedColor;
    colorActionDesc = {
      uf: "exchange",
      actionDescriptor: {
        __name: "Exchange",
        classID: "Exch"
      }
    };
  }
  if (data.operation == 3) {
    appData.colorInt = 0;
    appData.bgColor = 16777215;
    if (doc != null && doc.selectedLayerIndices.length != 0 && doc.layers[doc.selectedLayerIndices[0]].pixelContent == 1) {
      const swappedColor = appData.colorInt;
      appData.colorInt = appData.bgColor;
      appData.bgColor = swappedColor;
    }
    colorActionDesc = {
      uf: "reset",
      actionDescriptor: {
        __name: "Reset",
        classID: "Rset"
      }
    };
  }
  if (colorActionDesc) {
    colorActionDesc.actionDescriptor.null = {
      t: "obj ",
      v: [{
        t: "prop",
        v: {
          classID: "Clr",
          keyID: colorPropertyKey
        }
      }]
    };
    const toolRegistryEntry = controller.getActiveToolEntry();
    toolRegistryEntry.appDispatcher = controller;
    toolRegistryEntry.track(colorActionDesc);
  }
}
