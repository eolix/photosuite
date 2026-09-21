/**
 * Clipboard / history-recording / preset-store / text-font refresh handlers
 * mixed onto AppController.prototype.
 */
import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";

import { FileFormatRegistry } from "../../document/formats/registry/file-format-registry.js";
import { ToolId, EventChannel } from "../../document/model/tool-base.js";
import { PathRecordCodec } from "../../document/formats/psd/path-record-codec.js";
import { TextLayout } from "../../features/text/text-layout.js";
import { TextRenderer } from "../../features/text/text-renderer.js";
import { ActionDescUtil } from "../../features/scripting/action-desc.js";
import { Layer } from "../../document/model/layer.js";
import { ScriptEngine } from "../../features/scripting/script-engine.js";
import { PopupTypes } from "../config/popup-types.js";
import {
  CLIPBOARD_SIGNATURE_PENDING,
  readClipboardImageSignature,
  readSystemClipboardForPaste,
  writeClipboardRgba,
  writeClipboardText
} from "../../core/system-clipboard.js";
import { FileLoader } from "./file-loader.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";
import { PolyToolBase } from "../../document/tools/pen-path-tools.js";
import { allocBuffer, extractChannel, grayChannelToRgba } from "../../engine/compositing/buffer-utils.js";
import { copyPixels, scaleRgbaAlphaByMask } from "../../engine/compositing/pixel-ops.js";

/** Return value from copySelectionToClipboard when a path selection was copied. */
export const COPY_RESULT_PATH = 1;

/**
 * Panel types that map 1:1 onto appData preset store arrays (same order).
 */
export const PRESET_PANEL_TYPES = [
  PopupTypes.BRUSHES,
  PopupTypes.GRADIENTS,
  PopupTypes.CONTOURS,
  PopupTypes.PATTERNS,
  PopupTypes.SHAPES,
  PopupTypes.STYLES,
  PopupTypes.SWATCHES,
  PopupTypes.ACTIONS,
  PopupTypes.TOOL_PRESETS,
  PopupTypes.COLOR_PROFILES
];

/**
 * Mixes clipboard / action-recording / font-refresh methods onto AppController.
 * @param {Function} AppController
 */
export function applyClipboardHandlers(AppController) {
  AppController.prototype.onHistoryGrouped = function(event) {
    const appData = this.appData;
    if (!event.data.skipActionRecording) {
      ActionDescUtil.dispatchRecordedAction(event.data, this, appData, this.getCurrentDoc());
    }
    appendRecordedActionStep(appData, event.data);
    if (appData.recordingActionSet != null) this.updateAllPanels(PopupTypes.ACTIONS)
  };

  AppController.prototype.runSavedScriptIfAny = function(scriptKey) {
    const scriptSource = this.appData.customIO[scriptKey];
    if (scriptSource) {
      const dispatchEvent = new AppEvent(EventType.uiDispatch, true);
      dispatchEvent.data = {
        dispatchKind: UiCommand.runExtensionScriptSnippet,
        scriptSource: scriptSource
      };
      this.dispatch(dispatchEvent)
    }
    return scriptSource != null
  };

  AppController.prototype.getPresetStore = function(panelType) {
    return resolvePresetStore(this.appData, panelType)
  };

  AppController.prototype.cutSelectionOrLayers = function() {
    if (isEditingTextLayer(this)) {
      dispatchTextCut(this);
      return;
    }
    const copyKind = this.copySelectionToClipboard();
    const doc = this.getCurrentDoc();
    if (doc == null || doc.selectedLayerIndices.length == 0) return;
    if (copyKind == COPY_RESULT_PATH) {
      dispatchPathCut(this);
      return
    }
    if (this.appData.clipboardPixelPayload == null) return;
    const cutEvent = new AppEvent(EventType.historyGrouped);
    cutEvent.data = { uf: "delete" };
    this.dispatch(cutEvent);
  };

  AppController.prototype.copySelectionToClipboard = function(copyFullDoc, layerIndex) {
    if (copyFullDoc == null) copyFullDoc = false;
    if (isEditingTextLayer(this)) return;
    const appData = this.appData;
    const doc = this.getCurrentDoc();
    if (doc == null || doc.selectedLayerIndices.length == 0) return;
    const activeLayer = doc.layers[layerIndex == null ? doc.selectedLayerIndices[0] : layerIndex];
    const pathSets = doc.getPaths();
    const workPaths = pathSets[0];
    const activePathIndex = pathSets[1];
    const activePath = workPaths[activePathIndex[0]];
    if (!copyFullDoc && activePath != null && activePath.add.vmsk.C.length != 0) {
      storePathClipboard(appData, activePath);
      return COPY_RESULT_PATH
    }
    if (doc.selectionMask == null) return;
    const extracted = extractPixelCopyPayload(doc, activeLayer, copyFullDoc);
    if (extracted == null) return;
    storePixelClipboardPayload(this, appData, extracted.pixelBuffer, extracted.copyRect, doc);
  };

  AppController.prototype.pasteFromInternalClipboard = function(skipInternalClipboard, pasteIntoLayerSequence) {
    if (isEditingTextLayer(this)) return;
    if (pasteIntoLayerSequence) this.pasteIntoLayerSequence = true;
    const appData = this.appData;
    const internalCopy = appData.clipboardPixelPayload;
    if (this.openDocs.length == 0) {
      pasteWithNoOpenDocuments(this, skipInternalClipboard, internalCopy, appData);
      return
    }
    const pasteEvent = buildPasteDocumentAction(this, appData, internalCopy, skipInternalClipboard, pasteIntoLayerSequence);
    if (pasteEvent == null) return;
    this.dispatch(pasteEvent)
  };

  AppController.prototype.refreshTextLayerFonts = function() {
    for (let docIdx = 0; docIdx < this.openDocs.length; docIdx++) {
      refreshTextFontsOnDocument(this, this.openDocs[docIdx])
    }
  };
}

export {
  buildRecordedActionStep,
  resolvePresetStore,
  isEditingTextLayer
};

// ---------------------------------------------------------------------------
// Action recording
// ---------------------------------------------------------------------------

/**
 * Build an in-memory action step matching ActionParser field names.
 * @param {{ uf: string, actionDescriptor?: object }} eventData
 */
function buildRecordedActionStep(eventData) {
  const stepRecord = {
    expanded: false,
    enabled: true,
    dialogOptionsEnabled: false,
    dialogOptions: 0,
    uf: eventData.uf
  };
  if (eventData.actionDescriptor) {
    stepRecord.actionDescriptor = JSON.parse(JSON.stringify(eventData.actionDescriptor));
  }
  return stepRecord
}

function appendRecordedActionStep(appData, eventData) {
  const historyCursor = appData.recordingActionSet;
  const actionSets = appData.actionSets;
  if (historyCursor == null) return;
  const stepRecord = buildRecordedActionStep(eventData);
  if (historyCursor[2] == null) {
    historyCursor[2] = actionSets[historyCursor[0]].children[historyCursor[1]].children.length - 1;
  }
  actionSets[historyCursor[0]].children[historyCursor[1]].children.splice(historyCursor[2] + 1, 0, stepRecord);
  historyCursor[2]++;
}

// ---------------------------------------------------------------------------
// Preset stores
// ---------------------------------------------------------------------------

function resolvePresetStore(appData, panelType) {
  const stores = [
    appData.brushPresets,
    appData.gradientPresets,
    appData.contourPresets,
    appData.patternPresets,
    appData.customShapePresets,
    appData.stylePresets,
    appData.swatchPresets,
    appData.actionSets,
    appData.toolPresets,
    appData.colorProfilePresets
  ];
  return stores[PRESET_PANEL_TYPES.indexOf(panelType)]
}

// ---------------------------------------------------------------------------
// Text / cut helpers
// ---------------------------------------------------------------------------

function isEditingTextLayer(controller) {
  const entry = controller.toolRegistry && controller.toolRegistry.entriesById[ToolId.TOOL_TYPE];
  const tool = entry && entry.tool;
  return tool && typeof tool.isActive === "function" && tool.isActive();
}

function dispatchTextCut(controller) {
  const textCut = new AppEvent(EventType.documentAction, true);
  textCut.routingChannel = ToolId.TOOL_TYPE;
  textCut.data = { actionKind: "textCut" };
  controller.dispatch(textCut);
}

function dispatchPathCut(controller) {
  const cutEvent = new AppEvent(EventType.documentAction);
  cutEvent.routingChannel = ToolId.TOOL_PATH_SELECT;
  cutEvent.data = {
    actionKind: "remove",
    historyLabelKey: "Cut Paths"
  };
  controller.dispatch(cutEvent);
}

// ---------------------------------------------------------------------------
// Copy path / pixels
// ---------------------------------------------------------------------------

function storePathClipboard(appData, activePath) {
  const pathClipboard = PolyToolBase.clonePathSelectionState(activePath.add.vmsk, activePath.add.vogk);
  // Paths travel as text on the system clipboard, so another window can paste them.
  pathClipboard[0] = PathRecordCodec.pathToSerializable(pathClipboard[0]);
  writeClipboardText("vcb;" + JSON.stringify(pathClipboard));
}

function extractPixelCopyPayload(doc, activeLayer, copyFullDoc) {
  let pixelBuffer;
  let copyRect;
  if (copyFullDoc) {
    const docBounds = new Rect(0, 0, doc.width, doc.height);
    copyRect = docBounds.intersect(doc.selectionMask.rect);
    pixelBuffer = allocBuffer(copyRect.area() * 4);
    copyPixels(doc.getRasterData(), docBounds, pixelBuffer, copyRect);
    scaleRgbaAlphaByMask(doc.selectionMask.channel, doc.selectionMask.rect, pixelBuffer, copyRect)
  } else if (doc.activeChannels.length != 0) {
    copyRect = doc.selectionMask.rect.clone();
    pixelBuffer = allocBuffer(copyRect.area() * 4);
    const channel = doc.extraChannels[doc.activeChannels[0]];
    const channelRaster = channel.rasterizeTo(copyRect);
    grayChannelToRgba(channelRaster, pixelBuffer);
    extractChannel(doc.selectionMask.channel, pixelBuffer, 3)
  } else {
    const selectionPayload = activeLayer.extractSelectionData(doc, doc.selectionMask);
    if (selectionPayload == null) {
      showToast("Copied area is empty");
      return null
    }
    pixelBuffer = selectionPayload.pixBuf;
    copyRect = selectionPayload.rect
  }
  applySingleChannelVisibilityToBuffer(doc, pixelBuffer);
  return { pixelBuffer, copyRect }
}

function applySingleChannelVisibilityToBuffer(doc, pixelBuffer) {
  const channelWeights = doc.pathViewport.channelVisibility;
  const weightSum = channelWeights[0] + channelWeights[1] + channelWeights[2];
  if (weightSum != 1) return;
  const dominantChannel = channelWeights.indexOf(1);
  for (let px = 0; px < pixelBuffer.length; px += 4) {
    pixelBuffer[px] = pixelBuffer[px + 1] = pixelBuffer[px + 2] = pixelBuffer[px + dominantChannel]
  }
}

function storePixelClipboardPayload(controller, appData, pixelBuffer, copyRect, doc) {
  const docSizePoint = new Point(doc.width, doc.height);
  appData.clipboardPixelPayload = {
    buffer: pixelBuffer,
    rect: copyRect,
    sourceDocSize: docSizePoint
  };
  appData.isInternalClipboardCopy = false;
  controller.internalClipboardPasteState = {
    rect: copyRect,
    sourceDocSize: docSizePoint
  };
  scheduleOsClipboardBaseline(appData, pixelBuffer, copyRect.width, copyRect.height);
  appData.clipboardCopyRect = copyRect.clone();
  appData.pathClipboard = null;
  appData.copiedLayerIndices = null
}

function scheduleOsClipboardBaseline(appData, rgbaCopy, copyW, copyH) {
  // Full-resolution pixels stay in clipboardPixelPayload. The OS pasteboard only
  // receives images within the write cap; clipboardOsBaselineSig records the
  // post-copy image signature so paste can tell whether the pasteboard is still
  // this copy or another app has replaced it.
  appData.clipboardOsBaselineSig = CLIPBOARD_SIGNATURE_PENDING;
  setTimeout(function() {
    writeClipboardRgba(rgbaCopy, copyW, copyH)
      .then(function() {
        return readClipboardImageSignature();
      })
      .then(function(signature) {
        appData.clipboardOsBaselineSig = signature;
      });
  }, 0);
}

// ---------------------------------------------------------------------------
// Paste
// ---------------------------------------------------------------------------

function pasteWithNoOpenDocuments(controller, skipInternalClipboard, internalCopy, appData) {
  if (!skipInternalClipboard) {
    if (controller._pasteInFlight) return;
    const selfNoDoc = controller;
    controller._pasteInFlight = true;
    readSystemClipboardForPaste(controller, null, FileLoader, appData.clipboardOsBaselineSig).then(function(applied) {
      setTimeout(function() {
        selfNoDoc._pasteInFlight = false;
      }, 0);
      if (!applied && internalCopy) {
        openDocumentFromInternalCopy(selfNoDoc, internalCopy);
      }
    });
    return;
  }
  if (internalCopy) openDocumentFromInternalCopy(controller, internalCopy);
}

function openDocumentFromInternalCopy(controller, internalCopy) {
  const openedDocument = FileFormatRegistry.openFiles("image.psd", [{
    data: internalCopy.buffer.buffer,
    rect: internalCopy.rect
  }]);
  const tabEvt = new AppEvent(EventType.uiDispatch);
  tabEvt.data = {
    dispatchKind: UiCommand.focusDocumentTab,
    openedDocument: openedDocument
  };
  controller.dispatch(tabEvt);
}

/**
 * @returns {AppEvent|null} Event to dispatch, or null when paste is deferred / aborted.
 */
function buildPasteDocumentAction(controller, appData, internalCopy, skipInternalClipboard, pasteIntoLayerSequence) {
  const doc = controller.getCurrentDoc();
  const targetLayer = doc.layers[
    doc.selectedLayerIndices.length == 0 ? doc.layers.length - 1 : doc.selectedLayerIndices[0]
  ];
  let activePath = null;
  if (appData.pathClipboard) {
    const pathState = doc.getPaths(true);
    const workPaths = pathState[0];
    const pathIndex = pathState[1];
    activePath = workPaths[pathIndex[0]]
  }
  const pasteEvent = new AppEvent(EventType.documentAction, true);
  if (appData.pathClipboard != null && activePath != null) {
    pasteEvent.routingChannel = ToolId.TOOL_PATH_SELECT;
    pasteEvent.data = {
      actionKind: "append",
      historyLabelKey: "Paste Paths",
      pathSegmentClipboard: appData.pathClipboard
    };
    return pasteEvent
  }
  if (!skipInternalClipboard && !appData.pathClipboard) {
    if (controller._pasteInFlight) return null;
    const selfDoc = controller;
    controller._pasteInFlight = true;
    readSystemClipboardForPaste(controller, controller.applyClipboardImage.bind(controller), FileLoader, appData.clipboardOsBaselineSig).then(function(applied) {
      setTimeout(function() {
        selfDoc._pasteInFlight = false;
      }, 0);
      if (!applied) {
        selfDoc.pasteFromInternalClipboard(true, pasteIntoLayerSequence);
      }
    });
    return null
  }
  if (appData.copiedLayerIndices != null) {
    pasteEvent.data = { actionKind: Layer.duplicateLayer };
    pasteEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
    if (JSON.stringify(appData.copiedLayerIndices) != JSON.stringify(doc.selectedLayerIndices)) {
      pasteEvent.data.layerIndex = appData.copiedLayerIndices[0]
    }
    return pasteEvent
  }
  if (internalCopy == null) return null;
  if (doc.ensureLayerEditableForTools(false) && (doc.activeChannels.length != 0 || targetLayer.pixelContent > 0 || targetLayer.rect.isEmpty())) {
    pasteEvent.routingChannel = ToolId.TOOL_BRUSH;
    pasteEvent.data = {
      actionKind: "draw",
      clearSelectionAfter: true,
      historyLabelKey: "clipboard.paste"
    }
  } else {
    pasteEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
    pasteEvent.data = {
      actionKind: Layer.newLayerFromClipboard,
      pasteIntoSelection: controller.pasteIntoLayerSequence
    };
    controller.pasteIntoLayerSequence = false
  }
  pasteEvent.data.clipboardPixelPayload = internalCopy;
  return pasteEvent
}

// ---------------------------------------------------------------------------
// Text font refresh
// ---------------------------------------------------------------------------

function refreshTextFontsOnDocument(controller, doc) {
  let allFontsReady = true;
  for (let layerIdx = 0; layerIdx < doc.layers.length; layerIdx++) {
    const textData = doc.layers[layerIdx].add.TySh;
    if (textData != null && !TextRenderer.checkFonts(textData, controller.appData.fontRegistry)) {
      allFontsReady = false
    }
  }
  if (!allFontsReady) return;
  // Rasterize every text layer in one synchronous pass, then composite once.
  // Spreading across animation frames forced a full-document recomposite each
  // frame and dragged text in piece by piece.
  doc.pendingTextRasterization = false;
  for (let layerIdx = 0; layerIdx < doc.layers.length; layerIdx++) {
    const layer = doc.layers[layerIdx];
    const textData = layer.add.TySh;
    if (textData == null || !TextRenderer.checkFonts(textData, controller.appData.fontRegistry)) continue;
    if (layer.textHasEmbeddedBuffer) continue;
    const engineData = new TextLayout(textData.engineData, controller.appData.fontRegistry);
    const rendered = TextRenderer.renderText(engineData, textData);
    layer.rect = rendered.rect;
    layer.buffer = rendered.buffer;
    layer.markDirty();
    doc.markDirty()
  }
  if (doc.isInitialized) return;
  doc.isInitialized = true;
  if (doc.scriptHostData && doc.scriptHostData.startupScript) {
    ScriptEngine.execute(doc.scriptHostData.startupScript, controller);
  }
  controller.onComplete();
}
