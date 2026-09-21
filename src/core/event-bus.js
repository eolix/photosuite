/**
 * Event-bus primitives shared across the codebase.
 *
 * {@link AppEvent} is the payload type; {@link EventType} lists the routed
 * event-kind strings and {@link UiCommand} the things the app shell can be
 * asked to do. {@link EventEmitter} in `core/event-emitter.js` dispatches these without
 * depending on `app/`. `app/app.js` re-exports `AppEvent`.
 */

/** DOM-style event object passed to {@link EventEmitter} listeners. */
class AppEvent {
  /**
   * @param {string} eventType — usually an {@link EventType} value.
   * @param {boolean} [bubbles=false]
   */
  constructor(eventType, bubbles = false) {
    /** @type {string} */
    this.type = eventType;
    /** @type {EventEmitter | null} */
    this.target = null;
    /** @type {EventEmitter | null} */
    this.currentTarget = null;
    /** @type {boolean} */
    this.bubbles = bubbles;
    /** Optional side-channel for dialog / overlay routing. */
    this.routingChannel = null;
    /** When true, handlers may treat the event as dialog-originated. */
    this.fromDialog = false;
  }
}

/**
 * Canonical event-kind strings. Values are part of the routing contract — do not rename.
 * @type {Readonly<Record<string, string>>}
 */
const EventType = Object.freeze({
  documentAction: "documentAction",
  uiDispatch: "uiDispatch",
  historyGrouped: "historyGrouped",
  widgetSelect: "widgetSelect",
  layerEffectsFlush: "layerEffectsFlush",
  chromeRepaint: "chromeRepaint",
  animationFrame: "animationFrame",
});

/**
 * What a `uiDispatch` event asks the app shell to do. The requester puts one of
 * these on `event.data.dispatchKind`; `ui/shell/app-controller-ui-dispatch.js`
 * maps it to the handler that carries it out.
 *
 * Tools, panels and dialogs all sit below the shell, so they name the command
 * rather than calling the controller.
 */
export const UiCommand = Object.freeze({
  // Window and chrome
  rebuildAppChrome: "rebuildAppChrome",
  documentLayoutInvalidate: "documentLayoutInvalidate",
  focusDocumentTab: "focusDocumentTab",
  focusDocumentTabByIndex: "focusDocumentTabByIndex",
  panCanvasByWheelDirection: "panCanvasByWheelDirection",
  exitApplication: "exitApplication",

  // Overlays and popups
  showFloatingOverlay: "showFloatingOverlay",
  closeFloatingOverlay: "closeFloatingOverlay",
  removeScrollableOverlayPopups: "removeScrollableOverlayPopups",
  openResourcePresetPopup: "openResourcePresetPopup",
  openCommandPaletteSearch: "openCommandPaletteSearch",
  dispatchAppDialogRouter: "dispatchAppDialogRouter",
  showAnalysisLoadingBanner: "showAnalysisLoadingBanner",
  hideAnalysisLoadingBanner: "hideAnalysisLoadingBanner",

  // Splash screen
  splashOptionsUpdate: "splashOptionsUpdate",
  splashIntroDismiss: "splashIntroDismiss",

  // Opening files
  importFromUrl: "importFromUrl",
  pickLocalFiles: "pickLocalFiles",
  openRecentFile: "openRecentFile",
  openRecentFileFailed: "openRecentFileFailed",
  importDroppedFiles: "importDroppedFiles",
  registerFontFaceFromUrlParam: "registerFontFaceFromUrlParam",

  // Saving and exporting
  saveDocumentAsPSD: "saveDocumentAsPSD",
  saveEncodedDocumentAs: "saveEncodedDocumentAs",
  saveOrCommitDocument: "saveOrCommitDocument",
  downloadBlobSaveAs: "downloadBlobSaveAs",
  exportPopupResourceBundle: "exportPopupResourceBundle",
  confirmPersistStartupResource: "confirmPersistStartupResource",

  // Editing the active document
  applyDocumentMutationAndCloseExtra: "applyDocumentMutationAndCloseExtra",
  applyDocumentToolAction: "applyDocumentToolAction",
  forwardActiveToolGesture: "forwardActiveToolGesture",
  setActiveToolPanelMode: "setActiveToolPanelMode",
  focusExtendedToolChrome: "focusExtendedToolChrome",
  editPlacedLayerSource: "editPlacedLayerSource",
  cutPathsOrClearSelection: "cutPathsOrClearSelection",
  extractDocSelectionAsPreset: "extractDocSelectionAsPreset",
  dragLayerAcrossDocuments: "dragLayerAcrossDocuments",
  propagateKeyboardShortcutToDocument: "propagateKeyboardShortcutToDocument",

  // Clipboard
  clipboardCopyLayers: "clipboardCopyLayers",
  clipboardPasteLayers: "clipboardPasteLayers",
  pasteVectorPathsFromClipboard: "pasteVectorPathsFromClipboard",
  postClipboardEmbedMessage: "postClipboardEmbedMessage",

  // Scripting and actions
  runExtensionScriptSnippet: "runExtensionScriptSnippet",
  replayRecordedActionPair: "replayRecordedActionPair",
  openTranslateLink: "openTranslateLink",
});

export { AppEvent, EventType };
