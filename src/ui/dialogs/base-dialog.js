/**
 * Draggable modal dialog shell: title bar, close control, and body slot.
 * Concrete dialogs extend `BaseDialog` and populate `this.body`.
 */

import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { Locale } from "../../core/i18n/locale.js";
import { Point } from "../../core/math/point.js";

import { BaseWidget } from "../widgets/base-widget.js";
import { getIconUrl, isIconTinted } from "../../assets/icon-registry.js";
import { EventType } from "../../core/event-bus.js";
import { addClass, addPointerDownListener, addPointerMoveListener, addPointerUpListener, disableTouchGestures, getEventPos, isInDOM, makeElement, removePointerMoveListener, removePointerUpListener } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { ZoomTool } from "../../document/tools/view-tools.js";

/**
 * Draggable modal shell: header, close control, body slot. Concrete dialogs
 * extend this and populate `this.body`.
 *
 * @param {string|null} titleLocaleKey i18n key (or resolved title text) for the window title;
 *   null seeds the prototype without building DOM.
 * @param {string} dialogId Stable id used on the root element class (`window <id>`).
 */
function BaseDialog(titleLocaleKey, dialogId) {
  BaseWidget.call(this);
  if (titleLocaleKey == null) return;
  this.id = dialogId;
  this.titleLocaleKey = titleLocaleKey;
  /** Offset from dialog origin to pointer at drag start. */
  this.dragPointerOffsetInDialog = null;
  /** Last applied window position; used by getOffset / getLastWindowPosition. */
  this.lastWindowPosition = null;
  this.el = makeElement("div", "window " + dialogId);
  this.headerEl = makeElement("div", "whead");
  this.titleEl = makeElement("span", "wname");
  this.headerEl.appendChild(this.titleEl);
  this.el.appendChild(this.headerEl);
  this.onHeaderPointerDown = this.onHeaderPointerDown.bind(this);
  this.onHeaderPointerMove = this.onHeaderPointerMove.bind(this);
  this.onHeaderPointerUp = this.onHeaderPointerUp.bind(this);
  disableTouchGestures(this.headerEl);
  addPointerDownListener(this.headerEl, this.onHeaderPointerDown);
  this.closeBtn = makeElement("span", "cross");
  this.headerEl.appendChild(this.closeBtn);
  BaseDialog.prototype.buildUI.call(this);
  addPointerUpListener(this.closeBtn, this.onCloseClick.bind(this));
  this.body = makeElement("div", "body");
  this.el.appendChild(this.body);
  this.userResizeEnabled = false;
  this.onResizeGripPointerDown = this.onResizeGripPointerDown.bind(this);
  this.onResizeGripPointerMove = this.onResizeGripPointerMove.bind(this);
  this.onResizeGripPointerUp = this.onResizeGripPointerUp.bind(this);
}

BaseDialog.DEFAULT_CONTENT_WIDTH = 920;
BaseDialog.DEFAULT_CONTENT_HEIGHT = 600;
/** Title-bar height; mirrors `--h-dialog-header` in all.css. */
BaseDialog.CHROME_HEADER_HEIGHT = 34;
BaseDialog.CONTENT_SIZE_PAD = 10;
BaseDialog.CONTENT_SIZE_MIN_W = 200;
BaseDialog.CONTENT_SIZE_MIN_H = 80;

BaseDialog.prototype = Object.create(BaseWidget.prototype);
BaseDialog.prototype.constructor = BaseDialog;

function applyCloseButtonIconStyle(closeBtn) {
  const crossInvert = isIconTinted("cross") ? "filter:invert(var(--icon_cross_invrt));" : "";
  closeBtn.setAttribute("style", "background-image:url(" + getIconUrl("cross") + ");" + crossInvert);
}

function withTemporaryBodyMeasureStyles(dialog, measureFn) {
  const prevElW = dialog.el.style.width,
    prevElMaxW = dialog.el.style.maxWidth,
    prevBodyW = dialog.body.style.width,
    prevBodyH = dialog.body.style.height,
    prevOverflow = dialog.body.style.overflow;
  dialog.el.style.width = "auto";
  dialog.el.style.maxWidth = "none";
  dialog.body.style.width = "auto";
  dialog.body.style.height = "auto";
  dialog.body.style.overflow = "visible";
  const result = measureFn();
  dialog.el.style.width = prevElW;
  dialog.el.style.maxWidth = prevElMaxW;
  dialog.body.style.width = prevBodyW;
  dialog.body.style.height = prevBodyH;
  dialog.body.style.overflow = prevOverflow;
  return result;
}

function ensureResizeGrip(dialog) {
  if (dialog.resizeGripEl != null) return;
  dialog.resizeGripEl = makeElement("div", "wresize");
  dialog.resizeGripEl.setAttribute("title", Locale.get("properties.resize"));
  addPointerDownListener(dialog.resizeGripEl, dialog.onResizeGripPointerDown);
  dialog.el.appendChild(dialog.resizeGripEl);
}

BaseDialog.prototype.isActive = function () {
  return false;
};
BaseDialog.prototype.hasOverlay = function () {
  return false;
};
BaseDialog.prototype.buildUI = function () {
  if (this.titleLocaleKey == null) return;
  this.titleEl.textContent = Locale.get(this.titleLocaleKey);
  applyCloseButtonIconStyle(this.closeBtn);
};
/** Retitle the window, for dialogs that serve more than one command. */
BaseDialog.prototype.setTitleLocaleKey = function (titleLocaleKey) {
  this.titleLocaleKey = titleLocaleKey;
  this.titleEl.textContent = Locale.get(titleLocaleKey);
};
BaseDialog.prototype.onMouseDown = function () {};
BaseDialog.prototype.onRightMouseDown = function () {};
BaseDialog.prototype.onMouseMove = function () {};
BaseDialog.prototype.onMouseUp = function () {};
BaseDialog.prototype.onRightMouseUp = function () {};
BaseDialog.prototype.onKeyEvent = function (doc, view, handler, keys) {
  if (keys.isPressed(KeyboardHandler.Enter) && this.onOK) this.onOK();
  if (keys.isPressed(KeyboardHandler.Ctrl)) {
    const zoomEvt = new AppEvent(EventType.documentAction);
    zoomEvt.fromDialog = true;
    ZoomTool.bindZoomKeyboardShortcuts(keys, zoomEvt);
    if (zoomEvt.data) view.dispatch(zoomEvt);
  }
};
BaseDialog.prototype.isModifierKey = function () {
  return false;
};
BaseDialog.prototype.canOpen = function () {
  return true;
};
BaseDialog.prototype.open = function () {};
BaseDialog.prototype.onUpdate = function () {};
BaseDialog.prototype.getOffset = function () {
  return null;
};

/**
 * Measure `.body` scroll size (caller clamps to maxW/maxH).
 * @returns {{ width: number, height: number }|null}
 */
BaseDialog.prototype.measureBodyContentSize = function (maxW, maxH, pad) {
  const padding = pad == null ? BaseDialog.CONTENT_SIZE_PAD : pad,
    minW = BaseDialog.CONTENT_SIZE_MIN_W,
    minH = BaseDialog.CONTENT_SIZE_MIN_H;
  if (!isInDOM(this.body)) return null;
  const bodyClass = this.body.getAttribute("class") || "";
  const measured = withTemporaryBodyMeasureStyles(this, function () {
    const measuredH = Math.ceil(this.body.scrollHeight) + padding;
    let measuredW;
    if (bodyClass.split(" ").indexOf("flexrow") !== -1) {
      measuredW = Math.ceil(this.body.offsetWidth) + padding;
    } else {
      measuredW = Math.ceil(this.body.scrollWidth) + padding;
    }
    return { width: measuredW, height: measuredH };
  }.bind(this));
  return {
    width: Math.min(Math.max(measured.width, minW), maxW),
    height: Math.min(Math.max(measured.height, minH), maxH),
  };
};

/**
 * Optional intrinsic content size before layout (clamped to maxW/maxH by caller).
 * Default null: use available viewport (layer style, gradient editor, etc.).
 * Compact dialogs override and call {@link measureBodyContentSize}.
 * @returns {{ width: number, height: number }|null}
 */
BaseDialog.prototype.getPreferredContentSize = function (maxW, maxH) {
  if (this.userResizeEnabled === true) return null;
  const bodyClass = this.body.getAttribute("class") || "";
  if (bodyClass.split(" ").indexOf("flexrow") === -1) return null;
  return this.measureBodyContentSize(maxW, maxH);
};

BaseDialog.prototype.getLastWindowPosition = function () {
  return this.lastWindowPosition;
};
BaseDialog.prototype.resize = function () {};

/**
 * @param {{ width?: number, height?: number, minWidth?: number, minHeight?: number }} [options]
 */
BaseDialog.prototype.enableUserResize = function (options) {
  if (this.userResizeEnabled) return;
  this.userResizeEnabled = true;
  const opts = options || {};
  this.userContentWidth = opts.width != null ? opts.width : BaseDialog.DEFAULT_CONTENT_WIDTH;
  this.userContentHeight = opts.height != null ? opts.height : BaseDialog.DEFAULT_CONTENT_HEIGHT;
  this.userResizeMinWidth = opts.minWidth != null ? opts.minWidth : 520;
  this.userResizeMinHeight = opts.minHeight != null ? opts.minHeight : 380;
  addClass(this.el, "wuserresize");
  ensureResizeGrip(this);
};

BaseDialog.prototype.isUserResizable = function () {
  return this.userResizeEnabled === true;
};

BaseDialog.prototype.getUserContentSize = function (maxWidth, maxHeight) {
  let contentWidth = this.userContentWidth,
    contentHeight = this.userContentHeight;
  contentWidth = Math.max(this.userResizeMinWidth, Math.min(contentWidth, maxWidth));
  contentHeight = Math.max(this.userResizeMinHeight, Math.min(contentHeight, maxHeight));
  this.userContentWidth = contentWidth;
  this.userContentHeight = contentHeight;
  return {
    width: contentWidth,
    height: contentHeight,
  };
};

BaseDialog.prototype.getPointerClientPos = function (evt) {
  if (evt.touches) evt = evt.touches.item(0);
  return {
    x: evt.clientX,
    y: evt.clientY,
  };
};

BaseDialog.prototype.applyContentSizedLayout = function (pos, contentWidth, contentHeight, bodyOverflow) {
  this.lastWindowPosition = pos.clone();
  let topOffset = 0;
  if (this.parent != null && this.parent.el) topOffset = this.parent.el.offsetTop;
  const chromeH = BaseDialog.CHROME_HEADER_HEIGHT;
  this.el.style.left = pos.x + "px";
  this.el.style.top = topOffset + pos.y + "px";
  this.el.style.height = contentHeight + chromeH + "px";
  this.body.style.width = "fit-content";
  this.body.style.maxWidth = "none";
  this.body.style.height = contentHeight + "px";
  this.body.style.overflow = bodyOverflow == null ? "auto" : bodyOverflow;
  this.body.style.boxSizing = "border-box";
  this.resize(contentWidth, contentHeight);
  // The body is laid out at `fit-content`, so once its columns have settled its
  // own width is what the content actually came to. A content-sized window takes
  // that back, spending the measurement's slack on nothing rather than leaving
  // it as a margin down the right-hand side. A window the user sizes keeps the
  // width they gave it.
  if (!this.isUserResizable() && isInDOM(this.body)) {
    const snugW = Math.ceil(this.body.offsetWidth);
    if (snugW > 0) contentWidth = snugW;
  }
  this.el.style.width = contentWidth + "px";
  this.el.style.maxWidth = contentWidth + "px";
};

BaseDialog.prototype.applyUserDialogLayout = function (pos, contentWidth, contentHeight) {
  this.applyContentSizedLayout(pos, contentWidth, contentHeight, "hidden");
};

BaseDialog.prototype.onResizeGripPointerDown = function (evt) {
  evt.preventDefault();
  evt.stopPropagation();
  this.resizeDragStart = this.getPointerClientPos(evt);
  this.resizeSizeStart = {
    width: this.userContentWidth,
    height: this.userContentHeight,
  };
  addPointerMoveListener(window, this.onResizeGripPointerMove);
  addPointerUpListener(window, this.onResizeGripPointerUp);
};

BaseDialog.prototype.onResizeGripPointerMove = function (evt) {
  const pos = this.getPointerClientPos(evt),
    dx = pos.x - this.resizeDragStart.x,
    dy = pos.y - this.resizeDragStart.y,
    parent = this.parent,
    viewW = parent != null ? parent.viewWidth : window.innerWidth,
    viewH = parent != null ? parent.viewHeight : window.innerHeight,
    maxW = viewW,
    maxH = viewH - BaseDialog.CHROME_HEADER_HEIGHT,
    newW = Math.max(this.userResizeMinWidth, Math.min(this.resizeSizeStart.width + dx, maxW)),
    newH = Math.max(this.userResizeMinHeight, Math.min(this.resizeSizeStart.height + dy, maxH));
  let currentPos = this.lastWindowPosition;
  if (currentPos == null) {
    currentPos = new Point(parseInt(this.el.style.left, 10) || 0, parseInt(this.el.style.top, 10) || 0);
    if (parent != null && parent.el) currentPos.y -= parent.el.offsetTop;
  }
  this.userContentWidth = newW;
  this.userContentHeight = newH;
  this.applyUserDialogLayout(currentPos, newW, newH);
};

BaseDialog.prototype.onResizeGripPointerUp = function () {
  removePointerMoveListener(window, this.onResizeGripPointerMove);
  removePointerUpListener(window, this.onResizeGripPointerUp);
};

BaseDialog.prototype.close = function () {
  this.dispatch(new AppEvent(EventType.layerEffectsFlush));
};

/** Same as clicking the window ×: run `closebtn` listeners (typically revert / cleanup), then pop the modal. */
BaseDialog.prototype.dismissFromCloseControl = function () {
  this.dispatch(new AppEvent("closebtn"));
  this.close();
};

BaseDialog.prototype.onHeaderPointerDown = function (evt) {
  this.dragPointerOffsetInDialog = getEventPos(evt, this.el);
  addPointerMoveListener(window, this.onHeaderPointerMove);
  addPointerUpListener(window, this.onHeaderPointerUp);
};

BaseDialog.prototype.onHeaderPointerMove = function (evt) {
  const parent = this.el.parentNode,
    pos = getEventPos(evt, parent),
    topOffset = parent ? parent.offsetTop : 0,
    x = Math.round(pos.x - this.dragPointerOffsetInDialog.x),
    relY = Math.max(
      0,
      Math.min(window.innerHeight - 36 - topOffset, Math.round(pos.y - this.dragPointerOffsetInDialog.y))
    );
  this.lastWindowPosition = new Point(x, relY);
  this.el.style.left = x + "px";
  this.el.style.top = topOffset + relY + "px";
};

BaseDialog.prototype.onHeaderPointerUp = function () {
  removePointerMoveListener(window, this.onHeaderPointerMove);
  removePointerUpListener(window, this.onHeaderPointerUp);
};

BaseDialog.prototype.onCloseClick = function () {
  this.dismissFromCloseControl();
};

export { BaseDialog };
