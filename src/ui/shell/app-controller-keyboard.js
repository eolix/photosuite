/**
 * Keyboard slice of AppController — the document-level shortcut dispatcher.
 *
 * `applyKeyboardHandlers(AppController)` installs the window key handlers
 * (`onDocumentKeyDown`/`onDocumentKeyUp`), which feed the shared KeyboardHandler
 * and then call `onKeyEvent`. The router (`handleDocumentKeyEvent`) reads which
 * modifiers are down and fans out to four shortcut tables — primary-modifier
 * (Ctrl/Cmd) chords, bare single keys, Shift-only chords, and delete/backspace —
 * before forwarding the raw key to the top dialog or the active tool.
 *
 * Each shortcut builds an `EventType.documentAction` / `historyGrouped` /
 * `uiDispatch` event carrying an `UiCommand.*` or `actionKind` payload and
 * dispatches it on the controller; nothing here mutates the document directly.
 * Keys are ignored while focus is in a text field (see `shouldIgnoreDocumentKeyDown`).
 * Short payload keys such as `uf` are action wire names, kept as sent.
 */

import { KeyboardHandler, mergeOpacityDigitPercent } from "../../core/keyboard-handler.js";
import { ToolId, EventChannel } from "../../document/model/tool-base.js";
import { BlendModes } from "../../document/model/blend-modes.js";
import { AdjustmentEngine } from "../../features/adjustments/adjustment-engine.js";
import { Layer } from "../../document/model/layer.js";
import { PopupTypes } from "../config/popup-types.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { AppEvent } from "../../core/event-bus.js";
import { CropToolBase } from "../../document/tools/crop-tools.js";
import { PaintTool } from "../../document/tools/paint-tools.js";
import { SelectTool } from "../../document/tools/selection-tools.js";
import { ZoomTool } from "../../document/tools/view-tools.js";

/** Mixes keyboard methods onto AppController.prototype. */
export function applyKeyboardHandlers(AppController) {
  AppController.prototype.textInputTagNames = ["input", "textarea", "select"];

  AppController.prototype.isNonModifierKeyInTextField = function(keyEvent) {
    return isNonModifierKeyInTextField(keyEvent)
  };

  AppController.prototype.onDocumentKeyDown = function(keyDownEvent) {
    if (shouldIgnoreDocumentKeyDown(this, keyDownEvent)) return;
    if (KeyboardHandler.shouldPreventDefault(keyDownEvent)) {
      keyDownEvent.preventDefault()
    }
    this.keyboardHandler.onKeyDown(KeyboardHandler.normalizeKeyCode(keyDownEvent));
    if (keyDownEvent.repeat && (keyDownEvent.metaKey || keyDownEvent.ctrlKey)) return;
    this.onKeyEvent("down")
  };

  AppController.prototype.onDocumentKeyUp = function(keyUpEvent) {
    if (keyUpEvent.key == " ") this.keyboardHandler.initLayoutMap();
    if (KeyboardHandler.hasKeyCode(keyUpEvent.code, KeyboardHandler.Meta)) this.keyboardHandler.reset();
    this.keyboardHandler.onKeyUp(KeyboardHandler.normalizeKeyCode(keyUpEvent));
    const tagName = keyUpEvent.target.tagName.toLowerCase();
    if (this.textInputTagNames.indexOf(tagName) != -1 && isNonModifierKeyInTextField(keyUpEvent)) return;
    if (KeyboardHandler.shouldPreventDefault(keyUpEvent)) {
      keyUpEvent.preventDefault()
    }
    this.onKeyEvent("up")
  };

  AppController.prototype.onKeyEvent = function(keyPhase) {
    handleDocumentKeyEvent(this, keyPhase)
  };

  AppController.prototype.isShortcutKeyHeld = function(shortcutKey) {
    return isShortcutKeyHeld(this, shortcutKey)
  };

  /** Request or cancel browser fullscreen on document.body. */
  AppController.toggleBrowserFullscreen = function() {
    toggleBrowserFullscreen()
  };
}

export {
  isNonModifierKeyInTextField,
  isEditingTextTool,
  computePathFromEnterMode,
  resolveBracketMoveOperation,
  resolveMaskViewModeFromChannelVisibility,
  buildInvertSelectionHistoryData
};

// ---------------------------------------------------------------------------
// Text-field gating
// ---------------------------------------------------------------------------

function isNonModifierKeyInTextField(keyEvent) {
  const keyCode = keyEvent.code;
  return !KeyboardHandler.hasKeyCode(keyCode, KeyboardHandler.Escape)
    && !KeyboardHandler.hasKeyCode(keyCode, KeyboardHandler.Ctrl)
    && !KeyboardHandler.hasKeyCode(keyCode, KeyboardHandler.Alt);
}

/** History payload for Ctrl+Shift+I (invert selection). */
function buildInvertSelectionHistoryData() {
  return { uf: "inverse" }
}

function shouldIgnoreDocumentKeyDown(controller, keyDownEvent) {
  const tagName = keyDownEvent.target.tagName.toLowerCase();
  const inputType = keyDownEvent.target.getAttribute("type");
  const isEnterKey = KeyboardHandler.hasKeyCode(keyDownEvent.code, KeyboardHandler.Enter);
  const inTextField = controller.textInputTagNames.indexOf(tagName) != -1
    && isNonModifierKeyInTextField(keyDownEvent)
    && !(isEnterKey && tagName == "input" && inputType == "range")
    && !(tagName == "input" && inputType == "checkbox")
    && !(keyDownEvent.ctrlKey && (
      KeyboardHandler.hasKeyCode(keyDownEvent.code, KeyboardHandler.Plus)
      || KeyboardHandler.hasKeyCode(keyDownEvent.code, KeyboardHandler.Minus)
    ));
  const buttonConsumesEnterOrTab = tagName == "button"
    && (isEnterKey || KeyboardHandler.hasKeyCode(keyDownEvent.code, KeyboardHandler.Tab));
  return inTextField || buttonConsumesEnterOrTab
}

function isEditingTextTool(controller) {
  const textToolEntry = controller.toolRegistry.entriesById[ToolId.TOOL_TYPE];
  const textToolInstance = textToolEntry && textToolEntry.tool;
  return textToolInstance
    && typeof textToolInstance.isActive === "function"
    && textToolInstance.isActive();
}

function isShortcutKeyHeld(controller, shortcutKey) {
  const keyboard = controller.keyboardHandler;
  const activeTool = controller.toolRegistry.entriesById[controller.appData.activeToolId].tool;
  const top = controller.documentView.getTopDialog();
  const currentDoc = controller.getCurrentDoc();
  return keyboard.isPressed(shortcutKey)
    && !activeTool.isModifierKey(shortcutKey, currentDoc)
    && (top == null || !top.isModifierKey(shortcutKey, currentDoc))
}

function isTopDialogActive(controller) {
  const top = controller.documentView.getTopDialog();
  return top != null && top.isActive()
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

// Top of the key dispatcher, run on every key down/up. Handles an open overlay
// popup first (Escape dismisses it), refreshes the temporary modifier tool, then
// computes the modifier state and routes to the matching shortcut table(s)
// before forwarding the key to the active dialog or tool.
function handleDocumentKeyEvent(controller, keyPhase) {
  const keyboard = controller.keyboardHandler;
  const currentDoc = controller.getCurrentDoc();
  const hasSelection = currentDoc != null && currentDoc.selectedLayerIndices.length != 0;

  if (controller.overlayManager.getTopPopup() != null) {
    if (keyboard.isPressed(KeyboardHandler.Escape)) {
      controller.overlayManager.dismissTopPopup()
    }
    return
  }

  controller.updateTemporaryToolFromModifiers();

  const ctrlHeld = controller.isShortcutKeyHeld(KeyboardHandler.Ctrl);
  const altHeld = keyboard.isPressed(KeyboardHandler.Alt);
  const shiftHeld = keyboard.isPressed(KeyboardHandler.Shift);
  const ctx = { keyboard, currentDoc, hasSelection, keyPhase, ctrlHeld, altHeld, shiftHeld };

  if (ctrlHeld && keyboard.isPressed(KeyboardHandler.KeyZ) && keyPhase == "down") {
    dispatchHistoryStep(controller, shiftHeld)
  }
  if (ctrlHeld) {
    handlePrimaryModifierShortcuts(controller, ctx)
  }
  if (!keyboard.isPressed(KeyboardHandler.Ctrl) && !altHeld && !shiftHeld && keyPhase == "down") {
    handleBareKeyShortcuts(controller, ctx)
  }
  if (!keyboard.isPressed(KeyboardHandler.Ctrl) && !altHeld && shiftHeld) {
    handleShiftOnlyShortcuts(controller, ctx)
  }
  handleDeleteOrBackspace(controller, ctx);
  forwardKeyToDialogOrTool(controller, ctx)
}

function dispatchHistoryStep(controller, shiftHeld) {
  const documentActionEvent = new AppEvent(EventType.documentAction);
  documentActionEvent.routingChannel = EventChannel.EVENT_HISTORY;
  documentActionEvent.data = {
    actionKind: shiftHeld ? "h_stepfwd" : "h_stepbck"
  };
  if (!isTopDialogActive(controller)) controller.dispatch(documentActionEvent)
}

// ---------------------------------------------------------------------------
// Ctrl / Cmd shortcuts
// ---------------------------------------------------------------------------

// Ctrl/Cmd chords (optionally with Alt/Shift): the main menu-command shortcut
// table — select/copy/cut, new/open/save, transform, group/clip, adjustments,
// zoom, and more. Each branch fills one of the three staged events, and the
// non-null ones are dispatched at the end unless a modal dialog is active.
function handlePrimaryModifierShortcuts(controller, ctx) {
  const { keyboard, currentDoc, keyPhase, altHeld, shiftHeld } = ctx;
  const isEditingText = isEditingTextTool(controller);
  const documentActionEvent = new AppEvent(EventType.documentAction);
  const historyGroupedEvent = new AppEvent(EventType.historyGrouped);
  const uiDispatchEvent = new AppEvent(EventType.uiDispatch);

  if (!altHeld && keyPhase == "down") {
    applyAdjustmentEngineShortcuts(keyboard, shiftHeld, documentActionEvent)
  }

  if (keyboard.isPressed(KeyboardHandler.KeyA)) {
    if (isEditingText) {
      dispatchTextToolAction(controller, "selectAll")
    } else {
      historyGroupedEvent.data = SelectTool.buildSelectAllAction(true)
    }
  }
  if (keyboard.isPressed(KeyboardHandler.KeyC)) {
    if (altHeld) {
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "csize"
      }
    } else if (isEditingText) {
      dispatchTextToolAction(controller, "textCopy")
    } else {
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.clipboardCopyLayers,
        copyMerged: shiftHeld
      }
    }
  }
  if (keyboard.isPressed(KeyboardHandler.KeyD)) {
    historyGroupedEvent.data = SelectTool.buildSelectAllAction()
  }
  if (keyboard.isPressed(KeyboardHandler.KeyE) && keyPhase == "down") {
    applyMergeShortcut(documentActionEvent, currentDoc, shiftHeld)
  }
  if (keyboard.isPressed(KeyboardHandler.KeyF)) {
    applyFindFilterShortcut(controller, documentActionEvent, uiDispatchEvent, shiftHeld, altHeld)
  }
  if (keyboard.isPressed(KeyboardHandler.KeyG)) {
    applyGroupClipShortcut(documentActionEvent, currentDoc, shiftHeld, altHeld)
  }
  if (keyboard.isPressed(KeyboardHandler.KeyH)) {
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.openResourcePresetPopup,
      popupType: PopupTypes.TOGGLE_EXTRAS
    }
  }
  if (keyboard.isPressed(KeyboardHandler.KeyI)) {
    applyInfoInvertShortcut(documentActionEvent, historyGroupedEvent, uiDispatchEvent, shiftHeld, altHeld)
  }
  if (keyboard.isPressed(KeyboardHandler.KeyJ)) {
    documentActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
    documentActionEvent.data = { actionKind: shiftHeld ? Layer.newLayerViaCut : Layer.newLayerViaCopy }
  }
  if (keyboard.isPressed(KeyboardHandler.KeyK)) {
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "preferences"
    }
  }
  if (keyboard.isPressed(KeyboardHandler.KeyN)) {
    if (shiftHeld) {
      documentActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
      documentActionEvent.data = { actionKind: Layer.newLayer }
    } else {
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "newproject"
      }
    }
  }
  if (keyboard.isPressed(KeyboardHandler.KeyO)) {
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.pickLocalFiles,
      imagesOnly: true
    };
    keyboard.reset()
  }
  if (keyboard.isPressed(KeyboardHandler.KeyP)) {
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "print"
    };
    keyboard.reset()
  }
  if (keyboard.isPressed(KeyboardHandler.KeyR)) {
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.openResourcePresetPopup,
      popupType: PopupTypes.TOGGLE_RULERS
    }
  }
  if (keyboard.isPressed(KeyboardHandler.KeyS) && keyPhase == "down") {
    applySaveShortcut(uiDispatchEvent, shiftHeld, altHeld)
  }
  if (keyboard.isPressed(KeyboardHandler.KeyT)) {
    if (shiftHeld) {
      documentActionEvent.routingChannel = ToolId.TOOL_FREE_TRANSFORM;
      documentActionEvent.data = { actionKind: "again" }
    } else {
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.setActiveToolPanelMode,
        documentModelType: ToolId.TOOL_FREE_TRANSFORM
      }
    }
  }
  if (keyboard.isPressed(KeyboardHandler.KeyV) && isEditingText) {
    dispatchTextToolAction(controller, "textPaste")
  }
  if (keyboard.isPressed(KeyboardHandler.KeyX)) {
    if (isEditingText) {
      dispatchTextToolAction(controller, "textCut")
    } else {
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.cutPathsOrClearSelection
      }
    }
  }
  if (keyboard.isPressed(KeyboardHandler.BracketLeft) || keyboard.isPressed(KeyboardHandler.BracketRight)) {
    documentActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
    documentActionEvent.data = {
      actionKind: Layer.moveSelection,
      operation: resolveBracketMoveOperation(keyboard, shiftHeld)
    }
  }
  if (keyboard.isPressed(KeyboardHandler.Enter) && currentDoc) {
    documentActionEvent.routingChannel = ToolId.TOOL_RECT_SELECT;
    documentActionEvent.data = {
      actionKind: "frompath",
      selectionSource: [null, 0, computePathFromEnterMode(shiftHeld, altHeld)]
    }
  }
  if (keyboard.isPressed(KeyboardHandler.Period)) {
    historyGroupedEvent.data = CropToolBase.buildTrimAction(0)
  }
  if (keyboard.isPressed(KeyboardHandler.Tab)) {
    const openDocCount = controller.openDocs.length;
    if (openDocCount > 1) {
      controller.splashScreen.selectPanelAt((controller.splashScreen.getActivePanelIndex() + 1) % openDocCount)
    }
  }
  if (keyboard.isPressed(KeyboardHandler.Semicolon)) {
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.openResourcePresetPopup,
      popupType: PopupTypes.KEYBOARD_SHORTCUTS
    }
  }
  if (keyboard.isPressed(KeyboardHandler.Quote)) {
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.openResourcePresetPopup,
      popupType: PopupTypes.PLUGINS
    }
  }

  ZoomTool.bindZoomKeyboardShortcuts(keyboard, documentActionEvent);

  if (!isTopDialogActive(controller)) {
    if (documentActionEvent.data) controller.dispatch(documentActionEvent);
    if (historyGroupedEvent.data) controller.dispatch(historyGroupedEvent);
    if (uiDispatchEvent.data) controller.dispatch(uiDispatchEvent)
  }
}

function applyAdjustmentEngineShortcuts(keyboard, shiftHeld, documentActionEvent) {
  for (const adjustmentShortcutKey in AdjustmentEngine.keys) {
    const requiredKeyCodes = AdjustmentEngine.keys[adjustmentShortcutKey];
    let allModifiersPressed = true;
    for (let modifierKeyIdx = 0; modifierKeyIdx < requiredKeyCodes.length; modifierKeyIdx++) {
      if (!keyboard.isPressed(requiredKeyCodes[modifierKeyIdx])) allModifiersPressed = false;
    }
    if (!allModifiersPressed) continue;
    documentActionEvent.routingChannel = EventChannel.EVENT_ADJUSTMENT;
    if (adjustmentShortcutKey == "hue2" && shiftHeld) {
      documentActionEvent.data = {
        actionKind: "auto",
        autoToneMode: 3
      }
    } else {
      documentActionEvent.data = {
        actionKind: "start",
        adjustmentKey: adjustmentShortcutKey
      }
    }
  }
}

function applyMergeShortcut(documentActionEvent, currentDoc, shiftHeld) {
  documentActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
  if (shiftHeld) {
    documentActionEvent.data = { actionKind: Layer.mergeLayers };
    return
  }
  if (
    currentDoc
    && currentDoc.selectedLayerIndices.length == 1
    && currentDoc.selectedLayerIndices[0] != 0
    && !currentDoc.layers[currentDoc.selectedLayerIndices[0]].isGroup()
  ) {
    documentActionEvent.data = { actionKind: Layer.mergeDown }
  } else {
    documentActionEvent.data = { actionKind: Layer.mergeCopy }
  }
}

function applyFindFilterShortcut(controller, documentActionEvent, uiDispatchEvent, shiftHeld, altHeld) {
  if (shiftHeld && controller.appData.activeToolId != ToolId.TOOL_FREE_TRANSFORM) {
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "afw_fade"
    }
  } else if (altHeld) {
    documentActionEvent.routingChannel = EventChannel.EVENT_SMART_FILTER;
    documentActionEvent.data = { actionKind: "applylast" }
  } else {
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.openCommandPaletteSearch
    }
  }
}

function applyGroupClipShortcut(documentActionEvent, currentDoc, shiftHeld, altHeld) {
  documentActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
  if (altHeld && currentDoc && currentDoc.canMoveLayerUp(currentDoc.selectedLayerIndices[0])) {
    documentActionEvent.data = { actionKind: Layer.toggleClippingMask }
  } else {
    documentActionEvent.data = {
      actionKind: Layer.groupOrUngroup,
      ungroupMode: shiftHeld
    }
  }
}

function applyInfoInvertShortcut(documentActionEvent, historyGroupedEvent, uiDispatchEvent, shiftHeld, altHeld) {
  if (shiftHeld) {
    documentActionEvent.data = null;
    if (altHeld) {
      uiDispatchEvent.data = {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "finfo"
      }
    } else {
      historyGroupedEvent.data = buildInvertSelectionHistoryData()
    }
  } else if (altHeld) {
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "isize"
    }
  }
}

function applySaveShortcut(uiDispatchEvent, shiftHeld, altHeld) {
  if (shiftHeld) {
    // Shift+Ctrl+S saves the document under a new name; adding Alt exports a
    // rendering and leaves the document on the file it came from.
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "writefile",
      adoptsDocumentFile: !altHeld
    }
  } else {
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.saveOrCommitDocument
    }
  }
}

function dispatchTextToolAction(controller, actionKind) {
  const textEvt = new AppEvent(EventType.documentAction, true);
  textEvt.routingChannel = ToolId.TOOL_TYPE;
  textEvt.data = { actionKind: actionKind };
  controller.dispatch(textEvt)
}

/**
 * Bracket layer-move operation: 0 top, 1 up, 2 down, 3 bottom.
 */
function resolveBracketMoveOperation(keyboard, shiftHeld) {
  if (keyboard.isPressed(KeyboardHandler.BracketLeft)) return shiftHeld ? 3 : 2;
  return shiftHeld ? 0 : 1
}

/**
 * Path→selection mode bits: bit0 = shift, bit1 = alt.
 */
function computePathFromEnterMode(shiftHeld, altHeld) {
  let pathFromEnterMode = 0;
  if (shiftHeld) pathFromEnterMode++;
  if (altHeld) pathFromEnterMode += 2;
  return pathFromEnterMode
}

// ---------------------------------------------------------------------------
// Bare keys (no Ctrl/Alt/Shift)
// ---------------------------------------------------------------------------

function handleBareKeyShortcuts(controller, ctx) {
  const { keyboard, currentDoc, hasSelection } = ctx;
  const documentActionEvent = new AppEvent(EventType.documentAction);
  const uiDispatchEvent = new AppEvent(EventType.uiDispatch);
  const activeToolEntry = controller.toolRegistry.entriesById[controller.appData.activeToolId];

  let matchedToolbarGroupIndex = -1;
  for (let toolbarGroupIdx = 0; toolbarGroupIdx < controller.toolRegistry.toolbarShortcutKeys.length; toolbarGroupIdx++) {
    if (
      controller.toolRegistry.toolbarShortcutKeys[toolbarGroupIdx]
      && controller.isShortcutKeyHeld(controller.toolRegistry.toolbarShortcutKeys[toolbarGroupIdx])
    ) {
      matchedToolbarGroupIndex = toolbarGroupIdx;
    }
  }
  if (matchedToolbarGroupIndex != -1) {
    applyToolbarGroupShortcut(controller, activeToolEntry, matchedToolbarGroupIndex, uiDispatchEvent)
  }
  if (keyboard.isPressed(KeyboardHandler.KeyX)) {
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.openResourcePresetPopup,
      popupType: PopupTypes.COLOR_CHANGE,
      operation: 2
    }
  }
  if (keyboard.isPressed(KeyboardHandler.KeyD)) {
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.openResourcePresetPopup,
      popupType: PopupTypes.COLOR_CHANGE,
      operation: 3
    }
  }
  if (uiDispatchEvent.data) controller.dispatch(uiDispatchEvent);

  if (currentDoc && currentDoc.selectedLayerIndices.length != 0) {
    dispatchMaskViewShortcuts(controller, currentDoc, keyboard, documentActionEvent)
  }

  const activeDigit = keyboard.getActiveDigit();
  if (hasSelection && activeDigit != -1 && controller.isShortcutKeyHeld(KeyboardHandler.DIGIT_KEYS[activeDigit])) {
    const selectedLayerIndex = currentDoc.selectedLayerIndices[0];
    const activeLayer = currentDoc.layers[selectedLayerIndex];
    const mergedOpacityPercent = mergeOpacityDigitPercent(
      Math.round(100 * activeLayer.Opct / 255),
      activeDigit
    );
    documentActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
    documentActionEvent.data = {
      actionKind: Layer.setLayerOpacity,
      layerPropertyValue: Math.round(255 * mergedOpacityPercent / 100)
    };
    controller.dispatch(documentActionEvent)
  }

  if (keyboard.isPressed(KeyboardHandler.Tab)) {
    controller.setChromeLayoutMode(controller.chromeLayoutMode == 0 ? 1 : 0)
  }
  if (keyboard.isPressed(KeyboardHandler.KeyF) || (keyboard.isPressed(KeyboardHandler.Escape) && controller.chromeLayoutMode == 2)) {
    controller.setChromeLayoutMode(controller.chromeLayoutMode == 0 ? 2 : 0)
  }
  if (keyboard.isPressed(KeyboardHandler.KeyQ) && !controller.pointerState.isDown) {
    documentActionEvent.routingChannel = ToolId.TOOL_RECT_SELECT;
    documentActionEvent.data = { actionKind: "qmask" };
    controller.dispatch(documentActionEvent)
  }
}

function applyToolbarGroupShortcut(controller, activeToolEntry, matchedToolbarGroupIndex, uiDispatchEvent) {
  let nextVariantIndex;
  if (activeToolEntry.toolbarGroupIndex != matchedToolbarGroupIndex) {
    nextVariantIndex = controller.toolRegistry.selectedVariantByGroup[matchedToolbarGroupIndex];
  }
  if (activeToolEntry.toolbarGroupIndex == matchedToolbarGroupIndex) {
    nextVariantIndex = (activeToolEntry.variantIndexInGroup + 1)
      % controller.toolRegistry.toolbarGroups[matchedToolbarGroupIndex].length;
  }
  const shortcutToolId = controller.toolRegistry.toolbarGroups[matchedToolbarGroupIndex][nextVariantIndex].tool.id;
  const allowedToolIdList = controller.appData.allowedToolIds;
  if ((allowedToolIdList == null || allowedToolIdList.indexOf(shortcutToolId) != -1) && !controller.pointerState.isDown) {
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.setActiveToolPanelMode,
      routingChannel: shortcutToolId
    }
  }
}

function dispatchMaskViewShortcuts(controller, currentDoc, keyboard, documentActionEvent) {
  const activeLayer = currentDoc.layers[currentDoc.selectedLayerIndices[0]];
  const pixelContentKind = activeLayer.pixelContent;
  if (pixelContentKind != 1 && pixelContentKind != 3) return;
  const maskOrLoader = pixelContentKind == 3
    ? activeLayer.getLinkedPlacedItem(currentDoc).d
    : activeLayer.getMask();
  const maskViewMode = resolveMaskViewModeFromChannelVisibility(maskOrLoader, currentDoc);
  documentActionEvent.routingChannel = ToolId.TOOL_ZOOM;
  if (maskOrLoader && keyboard.isPressed(KeyboardHandler.Escape) && maskViewMode != 0) {
    documentActionEvent.data = {
      actionKind: "mskView",
      maskViewMode: 0
    }
  }
  if (maskOrLoader && keyboard.isPressed(KeyboardHandler.Backslash)) {
    documentActionEvent.data = {
      actionKind: "mskView",
      maskViewMode: maskViewMode == 1 ? 0 : 1
    }
  }
  if (maskOrLoader && keyboard.isPressed(KeyboardHandler.Backquote)) {
    documentActionEvent.data = {
      actionKind: "mskView",
      maskViewMode: maskViewMode == 2 ? 0 : 2
    }
  }
  if (documentActionEvent.data) controller.dispatch(documentActionEvent)
}

/**
 * 0 = mask inactive / RGB view, 1 = mask overlay off (RGB on), 2 = isolate mask.
 */
function resolveMaskViewModeFromChannelVisibility(maskOrLoader, currentDoc) {
  if (!maskOrLoader || !maskOrLoader.active) return 0;
  return currentDoc.pathViewport.channelVisibility.join("") == "111" ? 1 : 2
}

// ---------------------------------------------------------------------------
// Shift-only chords
// ---------------------------------------------------------------------------

function handleShiftOnlyShortcuts(controller, ctx) {
  const { keyboard, currentDoc, hasSelection } = ctx;
  const documentActionEvent = new AppEvent(EventType.documentAction);
  const uiDispatchEvent = new AppEvent(EventType.uiDispatch);

  if (keyboard.isPressed(KeyboardHandler.Comma)) {
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "shortcuts"
    }
  }
  if (keyboard.isPressed(KeyboardHandler.F5)) {
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "fill"
    }
  }
  if (keyboard.isPressed(KeyboardHandler.F6)) {
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "sel_feather"
    }
  }
  if (hasSelection && (keyboard.isPressed(KeyboardHandler.Plus) || keyboard.isPressed(KeyboardHandler.Minus))) {
    const selectedLayerIndex = currentDoc.selectedLayerIndices[0];
    const activeLayer = currentDoc.layers[selectedLayerIndex];
    const blendModeCodes = BlendModes.psdCodes;
    const blendModeCount = blendModeCodes.length;
    const currentBlendModeIndex = blendModeCodes.indexOf(activeLayer.blendMode);
    documentActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
    documentActionEvent.data = {
      actionKind: Layer.setBlendMode,
      layerPropertyValue: (currentBlendModeIndex + blendModeCount + (keyboard.isPressed(KeyboardHandler.Plus) ? 1 : -1)) % blendModeCount
    };
    controller.dispatch(documentActionEvent)
  }
  if (uiDispatchEvent.data) controller.dispatch(uiDispatchEvent)
}

// ---------------------------------------------------------------------------
// Delete / Backspace + dialog/tool forward
// ---------------------------------------------------------------------------

function handleDeleteOrBackspace(controller, ctx) {
  const { currentDoc, keyPhase, ctrlHeld, altHeld } = ctx;
  const isDeleteOrBackspaceDown = keyPhase == "down"
    && (controller.isShortcutKeyHeld(KeyboardHandler.Delete) || controller.isShortcutKeyHeld(KeyboardHandler.Backspace));

  if ((ctrlHeld || altHeld) && isDeleteOrBackspaceDown) {
    const fillEvent = new AppEvent(EventType.historyGrouped);
    fillEvent.data = PaintTool.buildFillAction(ctrlHeld ? "BckC" : "FrgC");
    controller.dispatch(fillEvent);
    return
  }
  if (!(currentDoc && isDeleteOrBackspaceDown && !controller.pointerState.isDown)) return;

  let documentActionEvent = new AppEvent(EventType.documentAction);
  if (currentDoc.selectionMask != null) {
    documentActionEvent = new AppEvent(EventType.historyGrouped);
    documentActionEvent.data = { uf: "delete" }
  } else {
    documentActionEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
    documentActionEvent.data = { actionKind: Layer.deleteLayer }
  }
  controller.dispatch(documentActionEvent)
}

function forwardKeyToDialogOrTool(controller, ctx) {
  const { keyboard, currentDoc } = ctx;
  if (controller.documentView.getTopDialog() != null) {
    if (keyboard.isPressed(KeyboardHandler.Escape)) {
      controller.documentView.getTopDialog().dismissFromCloseControl()
    } else {
      controller.documentView.getTopDialog().onKeyEvent(currentDoc, controller, controller.appData, keyboard)
    }
  }
  if (controller.appData.activeToolId == null) return;
  const activeToolInstance = controller.getActiveToolEntry();
  if (controller.documentView.getTopDialog() == null || controller.toolRegistry.temporaryToolId) {
    activeToolInstance.onKeyEvent(currentDoc, controller, controller.appData, keyboard)
  }
}

function toggleBrowserFullscreen() {
  const inFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
  if (!inFullscreen) {
    const bodyEl = document.body;
    const requestFullscreen = bodyEl.requestFullscreen || bodyEl.webkitRequestFullscreen;
    if (requestFullscreen) requestFullscreen.call(bodyEl)
  } else {
    const exitFullscreen = document.exitFullscreen || document.webkitExitFullscreen;
    if (exitFullscreen) exitFullscreen.call(document)
  }
}
