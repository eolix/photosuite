/**
 * The document viewport widget and the modal dialog stack layered over it.
 *
 * DocumentView is the region of the shell that holds the open document and any
 * dialogs the user opens on top of it. It owns a stack of dialog instances
 * (open one over another; the one underneath is disabled), positions each dialog
 * in the viewport, and forwards document updates to every registered dialog.
 *
 * Dialog instances register lazily: the shared "core" catalog (color picker,
 * canvas size, export, etc.) is built the first time any core dialog opens, and
 * an AdjustFilterDialog is built per `afw_*` route id when that adjustment/filter
 * is first opened. AppController drives this by calling `openDialog`.
 */
import { Point } from "../../core/math/point.js";
import { BaseDialog } from "../dialogs/base-dialog.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { PopupTypes } from "../config/popup-types.js";
import { ColorPickerDialog } from "../dialogs/color-picker-dialog.js";
import { ContourEditorDialog, GradientEditorDialog } from "../dialogs/gradient-contour-dialogs.js";
import { ExportAssetsDialog, ExportColorLUTDialog, WriteFileDialog } from "../dialogs/export-dialogs.js";
import { PrintDialog } from "../dialogs/print-dialog.js";
import { AdjustFilterDialog } from "../dialogs/adjust-filter-dialog.js";
import { FillDialog, StrokeDialog } from "../dialogs/fill-stroke-dialogs.js";
import { LayerStyleDialog } from "../dialogs/layer-style-dialog.js";
import { RefineEdgeDialog, TextWarpDialog } from "../dialogs/text-warp-refine-dialogs.js";
import { CameraDialog, TemplatesDialog } from "../dialogs/camera-template-dialogs.js";
import { FileInfoDialog } from "../dialogs/file-info-dialog.js";
import { ImportRawDialog } from "../dialogs/import-raw-dialog.js";
import { ResourceManagerDialog, ScriptDialog } from "../dialogs/script-storage-dialogs.js";
import { AddGuidesDialog, CanvasSizeDialog, ImageSizeDialog } from "../dialogs/guides-size-dialogs.js";
import { ColorRangeDialog, DuplicateIntoDialog } from "../dialogs/duplicate-color-dialogs.js";
import { NewProjectDialog } from "../dialogs/new-project-dialog.js";
import { VectorizeBitmapDialog } from "../dialogs/vectorize-bitmap-dialog.js";
import { CameraRawDialog } from "../dialogs/camera-raw-dialog.js";
import { KeyboardShortcutsDialog, PreferencesDialog } from "../dialogs/preferences-dialogs.js";
import { MergeChannelsDialog, NumericInputDialog, OpenURLDialog } from "../dialogs/document-input-dialogs.js";
import { CreateShapeDialog, MakeSelectionDialog, SelectOptionsDialog, SelectionOptionsDialog } from "../dialogs/selection-shape-dialogs.js";
import { WebImagesDialog } from "../dialogs/web-images-dialog.js";
import { EventType } from "../../core/event-bus.js";
import { addClass, makeElement, removeClass } from "../../core/dom.js";
import { showToast } from "../../core/user-prompts.js";

/** Registry key for the shared (non-adjust-filter) dialog catalog. */
export const CORE_DIALOG_REGISTRY_KEY = "-";

/** Prefix for AdjustFilterDialog route ids (slice after this for the filter key). */
export const ADJUST_FILTER_DIALOG_ID_PREFIX = "afw_";

/**
 * Viewport widget that hosts the open document and a stack of modal dialogs.
 * `dialogStack` is the currently-open dialogs (top of stack is frontmost);
 * `registeredDialogs` is every built dialog instance; `lazyDialogInitFlags`
 * tracks which catalogs have been built so each registers only once.
 */
function DocumentView() {
  BaseWidget.call(this);
  this.el = makeElement("div", "");
  this.viewWidth = 0;
  this.viewHeight = 0;
  this.doc = null;
  this.focusTrapSpacer = makeElement("div", "");
  this.focusTrapSpacer.setAttribute("style", "width:200em; height:100em; position:absolute;");
  this.dialogStack = [];
  this.registeredDialogs = [];
  this.lazyDialogInitFlags = {}
}
DocumentView.prototype = Object.create(BaseWidget.prototype);

DocumentView.prototype.ensureDialogRegistered = function(dialogRegistryKey) {
  const dialogInstances = dialogRegistryKey == CORE_DIALOG_REGISTRY_KEY
    ? createCoreDialogCatalog()
    : createAdjustFilterDialogCatalog(dialogRegistryKey);
  this.registerDialogInstances(dialogInstances);
  this.lazyDialogInitFlags[dialogRegistryKey] = true
};

DocumentView.prototype.registerDialogInstances = function(dialogInstances) {
  const currentDoc = this.doc;
  for (let dialogIdx = 0; dialogIdx < dialogInstances.length; dialogIdx++) {
    const dialogInstance = dialogInstances[dialogIdx];
    dialogInstance.parent = this;
    this.registeredDialogs.push(dialogInstance);
    this.layoutDialog(dialogInstance);
    dialogInstance.buildUI();
    if (currentDoc) dialogInstance.onUpdate(currentDoc, PopupTypes.ALL);
    dialogInstance.on(EventType.layerEffectsFlush, this.onDialogClosedFromEvent, this)
  }
};

DocumentView.prototype.resize = function(widthPx, heightPx) {
  this.viewWidth = widthPx;
  this.viewHeight = heightPx;
  for (let dialogIdx = 0; dialogIdx < this.registeredDialogs.length; dialogIdx++) {
    this.layoutDialog(this.registeredDialogs[dialogIdx])
  }
};

DocumentView.prototype.buildUI = function() {
  for (let dialogIdx = 0; dialogIdx < this.registeredDialogs.length; dialogIdx++) {
    this.registeredDialogs[dialogIdx].buildUI()
  }
};

DocumentView.prototype.getTopDialog = function() {
  return getTopDialogFromStack(this.dialogStack)
};

DocumentView.prototype.isActive = function() {
  for (let stackIdx = 0; stackIdx < this.dialogStack.length; stackIdx++) {
    if (this.dialogStack[stackIdx].isActive()) return true;
  }
  return false
};

/**
 * Open a dialog by id (or an already-built instance). Builds the dialog's
 * catalog on first use, blocks opening while another action is mid-flight,
 * lets the dialog veto via `canOpen`, and either re-focuses an already-stacked
 * dialog or pushes a fresh one onto the stack.
 */
DocumentView.prototype.openDialog = function(dialogId, currentDoc, dialogPayload, openDocs, keyboard) {
  ensureDialogCatalogForOpen(this, dialogId);
  const dialogInstance = resolveDialogInstance(this, dialogId);
  if (this.isActive() && dialogInstance.isActive()) {
    showToast("Finish the current action first");
    return
  }
  if (!dialogInstance.canOpen(currentDoc)) return;
  if (this.dialogStack.indexOf(dialogInstance) != -1) {
    reopenStackedColorPickerIfNeeded(this, dialogId, dialogInstance, currentDoc, dialogPayload, openDocs, keyboard);
    return
  }
  pushDialogOntoStack(this, dialogInstance, currentDoc, dialogPayload, openDocs, keyboard)
};

DocumentView.prototype.layoutDialog = function(dialogInstance) {
  layoutDialogInViewport(this, dialogInstance)
};

DocumentView.prototype.onUpdate = function(appData, popupType) {
  this.doc = appData;
  for (let dialogIdx = 0; dialogIdx < this.registeredDialogs.length; dialogIdx++) {
    this.registeredDialogs[dialogIdx].onUpdate(appData, popupType)
  }
};

// Fires when a dialog emits its close event: pops it off the stack, removes its
// DOM, and re-enables the dialog now on top.
DocumentView.prototype.onDialogClosedFromEvent = function(_closeEvent) {
  const closedDialog = this.dialogStack.pop();
  this.el.removeChild(closedDialog.el);
  const newStackTopIndex = this.dialogStack.length - 1;
  if (newStackTopIndex >= 0) removeClass(this.dialogStack[newStackTopIndex].el, "wdisabled");
  if (this.focusTrapSpacer.parentNode == this.el) this.el.removeChild(this.focusTrapSpacer)
};

export {
  DocumentView,
  isAdjustFilterDialogId,
  getTopDialogFromStack,
  computeCascadeStackPosition,
  computeCenteredContentPosition
};

// ---------------------------------------------------------------------------
// Dialog catalogs
// ---------------------------------------------------------------------------

function createCoreDialogCatalog() {
  return [
    new AddGuidesDialog(),
    new FileInfoDialog(),
    new MergeChannelsDialog(),
    new WriteFileDialog(),
    new PrintDialog(),
    new SelectionOptionsDialog(),
    new NewProjectDialog(),
    new OpenURLDialog(),
    new ScriptDialog(),
    new CameraDialog(),
    new PreferencesDialog(),
    new KeyboardShortcutsDialog(),
    new ColorPickerDialog(),
    new GradientEditorDialog(),
    new ContourEditorDialog(),
    new LayerStyleDialog(),
    new CanvasSizeDialog(),
    new ImageSizeDialog(),
    new ImportRawDialog(),
    new DuplicateIntoDialog(),
    new TextWarpDialog(),
    new ColorRangeDialog(),
    new CameraRawDialog(),
    new FillDialog(),
    new StrokeDialog(),
    new VectorizeBitmapDialog(),
    new RefineEdgeDialog(),
    new ExportAssetsDialog(),
    new ExportColorLUTDialog(),
    new CreateShapeDialog(),
    new ResourceManagerDialog(),
    new TemplatesDialog(),
    new MakeSelectionDialog(),
    new WebImagesDialog(),
    new SelectOptionsDialog("border", "select.border", "px"),
    new SelectOptionsDialog("smoothness", "styleOptions.bevelTechnique.smooth", "px"),
    new SelectOptionsDialog("expand", "select.expand", "px"),
    new SelectOptionsDialog("contract", "select.contract", "px"),
    new SelectOptionsDialog("feather", "select.feather", "px"),
    new NumericInputDialog(0, "namewindow", "properties.name"),
    new NumericInputDialog(1, "cornerradius", "properties.cornerRadius", "px", true),
    new NumericInputDialog(1, "scaleeffects", "Scale Effects", "%", true),
    new NumericInputDialog(1, "doczoom", "Zoom", "%", true)
  ]
}

function createAdjustFilterDialogCatalog(dialogRegistryKey) {
  return [new AdjustFilterDialog(dialogRegistryKey.slice(ADJUST_FILTER_DIALOG_ID_PREFIX.length))]
}

function isAdjustFilterDialogId(dialogId) {
  return typeof dialogId == "string" && dialogId.startsWith(ADJUST_FILTER_DIALOG_ID_PREFIX)
}

// ---------------------------------------------------------------------------
// Open / stack
// ---------------------------------------------------------------------------

function getTopDialogFromStack(dialogStack) {
  return dialogStack.length == 0 ? null : dialogStack[dialogStack.length - 1]
}

function ensureDialogCatalogForOpen(documentView, dialogId) {
  if (typeof dialogId == "object") return;
  if (!isAdjustFilterDialogId(dialogId) && !documentView.lazyDialogInitFlags[CORE_DIALOG_REGISTRY_KEY]) {
    documentView.ensureDialogRegistered(CORE_DIALOG_REGISTRY_KEY)
  }
  if (isAdjustFilterDialogId(dialogId) && !documentView.lazyDialogInitFlags[dialogId]) {
    documentView.ensureDialogRegistered(dialogId)
  }
}

function resolveDialogInstance(documentView, dialogId) {
  if (typeof dialogId == "object") {
    const dialogInstance = dialogId;
    if (!dialogInstance.hasListeners(EventType.layerEffectsFlush, documentView.onDialogClosedFromEvent)) {
      dialogInstance.on(EventType.layerEffectsFlush, documentView.onDialogClosedFromEvent, documentView);
    }
    dialogInstance.parent = documentView;
    return dialogInstance
  }
  for (let dialogIdx = 0; dialogIdx < documentView.registeredDialogs.length; dialogIdx++) {
    if (documentView.registeredDialogs[dialogIdx].id == dialogId) {
      return documentView.registeredDialogs[dialogIdx]
    }
  }
  return null
}

function reopenStackedColorPickerIfNeeded(documentView, dialogId, dialogInstance, currentDoc, dialogPayload, openDocs, keyboard) {
  if (dialogId == "colorpicker") {
    dialogInstance.open(currentDoc, dialogPayload, openDocs, keyboard);
    documentView.layoutDialog(dialogInstance);
  }
}

function pushDialogOntoStack(documentView, dialogInstance, currentDoc, dialogPayload, openDocs, keyboard) {
  const previousStackTopIndex = documentView.dialogStack.length - 1;
  if (previousStackTopIndex >= 0) {
    addClass(documentView.dialogStack[previousStackTopIndex].el, "wdisabled");
  }
  documentView.el.appendChild(dialogInstance.el);
  documentView.dialogStack.push(dialogInstance);
  dialogInstance.open(currentDoc, dialogPayload, openDocs, keyboard);
  documentView.layoutDialog(dialogInstance)
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function layoutDialogInViewport(documentView, dialogInstance) {
  const viewW = documentView.viewWidth;
  const viewH = documentView.viewHeight;
  const headerChrome = BaseDialog.CHROME_HEADER_HEIGHT;
  const offset = dialogInstance.getOffset(viewW, viewH);
  let insetX = 0;
  let insetY = 0;
  if (offset != null) {
    insetX = offset.x;
    insetY = offset.y
  }
  const dialogW = viewW - insetX * 2;
  const dialogH = viewH - insetY * 2 - headerChrome;
  const intrinsic = dialogInstance.getPreferredContentSize
    ? dialogInstance.getPreferredContentSize(dialogW, dialogH)
    : null;

  if (dialogInstance.isUserResizable && dialogInstance.isUserResizable()) {
    layoutUserResizableDialog(dialogInstance, viewW, viewH, headerChrome, dialogW, dialogH, intrinsic);
    return
  }
  if (intrinsic != null) {
    layoutIntrinsicSizedDialog(dialogInstance, viewW, viewH, headerChrome, intrinsic);
    return
  }
  layoutOffsetOrCascadeDialog(documentView, dialogInstance, viewW, viewH, offset, dialogW, dialogH)
}

function layoutUserResizableDialog(dialogInstance, viewW, viewH, headerChrome, dialogW, dialogH, intrinsic) {
  if (intrinsic != null && dialogInstance.getLastWindowPosition() == null) {
    dialogInstance.userContentWidth = intrinsic.width;
    dialogInstance.userContentHeight = intrinsic.height
  }
  const preferred = dialogInstance.getUserContentSize(dialogW, dialogH);
  let pos = dialogInstance.getLastWindowPosition();
  if (pos == null) {
    pos = computeCenteredContentPosition(viewW, viewH, preferred.width, preferred.height, headerChrome)
  }
  dialogInstance.applyUserDialogLayout(pos, preferred.width, preferred.height)
}

/** Window edge width; mirrors the `.window` border in all.css. */
const DIALOG_BORDER_PX = 1;

function layoutIntrinsicSizedDialog(dialogInstance, viewW, viewH, headerChrome, intrinsic) {
  let pos = dialogInstance.getLastWindowPosition();
  if (pos == null) {
    pos = computeCenteredContentPosition(viewW, viewH, intrinsic.width, intrinsic.height, headerChrome)
  }
  // A dialog that grows keeps where it was put, so the position is pulled back
  // far enough for the taller window to stay on screen.
  pos = clampContentPositionToViewport(pos, viewW, viewH, intrinsic.width, intrinsic.height, headerChrome);
  dialogInstance.applyContentSizedLayout(pos, intrinsic.width, intrinsic.height)
}

/** `pos` moved the least amount that keeps a `contentWidth` x `contentHeight` window in view. */
function clampContentPositionToViewport(pos, viewW, viewH, contentWidth, contentHeight, headerChrome) {
  const maxX = Math.max(0, viewW - contentWidth - DIALOG_BORDER_PX * 2);
  const maxY = Math.max(0, viewH - contentHeight - headerChrome - DIALOG_BORDER_PX * 2);
  return new Point(
    Math.min(Math.max(0, pos.x), maxX),
    Math.min(Math.max(0, pos.y), maxY)
  )
}

function layoutOffsetOrCascadeDialog(documentView, dialogInstance, viewW, viewH, offset, dialogW, dialogH) {
  let pos;
  if (offset != null) {
    pos = offset.clone()
  } else {
    pos = dialogInstance.getLastWindowPosition();
    if (pos == null) {
      const stackIdx = documentView.dialogStack.indexOf(dialogInstance) + 1;
      pos = computeCascadeStackPosition(viewW, viewH, stackIdx)
    }
  }
  dialogInstance.el.style.left = pos.x + "px";
  dialogInstance.el.style.top = documentView.el.offsetTop + pos.y + "px";
  dialogInstance.el.style.width = "";
  dialogInstance.el.style.maxWidth = "";
  dialogInstance.el.style.height = "";
  dialogInstance.body.style.height = "";
  dialogInstance.body.style.overflow = "";
  dialogInstance.body.style.boxSizing = "";
  dialogInstance.resize(dialogW, dialogH)
}

/**
 * Center a content-sized dialog in the viewport (header chrome subtracted from Y).
 */
function computeCenteredContentPosition(viewW, viewH, contentWidth, contentHeight, headerChrome) {
  return new Point(
    Math.max(0, Math.floor((viewW - contentWidth) / 2)),
    Math.max(0, Math.floor((viewH - contentHeight - headerChrome) / 2))
  )
}

/**
 * Cascaded stack position: origin on tiny viewports, else 150px * stack index.
 */
function computeCascadeStackPosition(viewW, viewH, stackIdx) {
  if (viewW < 450 || viewH < 450) return new Point(0, 0);
  return new Point(stackIdx * 150, stackIdx * 150)
}
