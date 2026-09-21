/**
 * The cursor the document view draws for itself: a crosshair, a brush-size ring,
 * or a rotated bitmap, painted above the canvas chrome.
 *
 * A CSS cursor cannot scale with the brush or spin with the rotate tool, so the
 * overlay tracks the pointer and draws the shape at document scale, hiding the
 * native cursor while the pointer is over the working area.
 */

import { Point } from "../../core/math/point.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import {
  addPointerMoveListener,
  getDevicePixelRatio,
  getEventPos,
  makeElement,
  removePointerMoveListener,
} from "../../core/dom.js";

let rotateCursorImage = null;
let rotateCursorLoadPromise = null;

/** The loaded rotate-tool cursor bitmap, or null before it arrives. */
export function getRotateCursorImage() {
  return rotateCursorImage;
}

/** Preload the rotate-tool cursor bitmap; safe to call repeatedly. */
export function preloadRotateCursorIcon() {
  if (rotateCursorImage) return Promise.resolve(rotateCursorImage);
  if (rotateCursorLoadPromise) return rotateCursorLoadPromise;

  const iconUrl = getIconUrl("rotate") || "/assets/icons/rotate.png";

  rotateCursorLoadPromise = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      rotateCursorImage = img;
      resolve(img);
    };
    img.onerror = reject;
    img.src = iconUrl;
  });

  return rotateCursorLoadPromise;
}


/**
 * Renders either a CSS cursor string or a positioned bitmap preview that
 * follows the pointer inside `containerEl`.
 */
export function CursorOverlay(containerEl) {
  this.containerEl = containerEl;
  this.previewImgEl = makeElement("img");
  this.previewCanvasEl = makeElement("canvas");
  this.cursorOrPreview = null;
  this.cursorExtraStyle = "";
  this.activePreviewEl = null;
  this.pointerPos = new Point(0, 0);
  this._lastClientX = null;
  this._lastClientY = null;
  this._bitmapPreviewHidden = false;
  this._trackingWindow = false;
  this._workingCanvasEl = null;
  this._workingAreaLeaveBound = this._onWorkingAreaPointerLeave.bind(this);
  this._workingAreaEnterBound = this._onWorkingAreaPointerEnter.bind(this);
  this._refreshBound = this.refresh.bind(this);
  this._windowMoveBound = this._onWindowPointerMove.bind(this);
  this._previewLoadBound = this._onPreviewImageLoad.bind(this);
  addPointerMoveListener(this.containerEl, this._refreshBound);
}

function isBitmapCursorPreview(cursorOrPreview) {
  return cursorOrPreview != null && typeof cursorOrPreview !== "string";
}

CursorOverlay.prototype._findDocumentViewportEl = function () {
  return this.containerEl ? this.containerEl.querySelector(".pbody") : null;
}

CursorOverlay.prototype._findWorkingCanvasEl = function () {
  if (!this.containerEl) return null;
  const viewportEl = this._findDocumentViewportEl();
  if (viewportEl) {
    const canvasInViewport = viewportEl.querySelector("canvas");
    if (canvasInViewport) return canvasInViewport;
  }
  return (
    this.containerEl.querySelector("canvas.canv") ||
    this.containerEl.querySelector("canvas")
  );
}

CursorOverlay.prototype._getDisplayScale = function (cursorOrPreview) {
  const devicePixelRatio = getDevicePixelRatio();
  const bounds = cursorOrPreview.boundsRect;
  if (bounds && bounds.width === 64 && bounds.height === 64) {
    return Math.max(devicePixelRatio, 2);
  }
  return devicePixelRatio;
}

function readPointerClientPosition(evt) {
  if (!evt) return null;
  const pointerEvt = evt.touches ? evt.touches.item(0) : evt;
  if (pointerEvt == null || pointerEvt.clientX == null) return null;
  return { x: pointerEvt.clientX, y: pointerEvt.clientY };
}

CursorOverlay.prototype._rememberPointerClientPos = function (evt) {
  const clientPos = readPointerClientPosition(evt);
  if (clientPos == null) return;
  this._lastClientX = clientPos.x;
  this._lastClientY = clientPos.y;
  this.pointerPos = getEventPos(evt, this.containerEl);
}

function isClientPointInsideRect(clientX, clientY, rect) {
  return (
    clientX >= rect.left &&
    clientX < rect.right &&
    clientY >= rect.top &&
    clientY < rect.bottom
  );
}

CursorOverlay.prototype._isClientPointInWorkingArea = function (clientX, clientY) {
  const canvasEl = this._findWorkingCanvasEl();
  if (canvasEl == null) return false;
  return isClientPointInsideRect(clientX, clientY, canvasEl.getBoundingClientRect());
}

CursorOverlay.prototype._isPointerInWorkingArea = function (evt) {
  const clientPos = readPointerClientPosition(evt);
  if (clientPos == null) {
    if (this._lastClientX == null || this._lastClientY == null) return false;
    return this._isClientPointInWorkingArea(this._lastClientX, this._lastClientY);
  }
  return this._isClientPointInWorkingArea(clientPos.x, clientPos.y);
}

CursorOverlay.prototype._shouldHideBitmapPreview = function (evt) {
  if (this.shouldSuppressBitmapPreview && this.shouldSuppressBitmapPreview(evt)) {
    return true;
  }
  const clientPos = readPointerClientPosition(evt);
  if (clientPos != null) {
    return !this._isClientPointInWorkingArea(clientPos.x, clientPos.y);
  }
  if (this._lastClientX != null && this._lastClientY != null) {
    return !this._isClientPointInWorkingArea(this._lastClientX, this._lastClientY);
  }
  return true;
}

CursorOverlay.prototype._setWindowTracking = function (enabled) {
  if (enabled === this._trackingWindow) return;
  this._trackingWindow = enabled;
  if (enabled) {
    addPointerMoveListener(window, this._windowMoveBound);
  } else {
    removePointerMoveListener(window, this._windowMoveBound);
  }
}

CursorOverlay.prototype._bindWorkingAreaListeners = function () {
  const canvasEl = this._findWorkingCanvasEl();
  if (canvasEl === this._workingCanvasEl) return;

  if (this._workingCanvasEl) {
    this._workingCanvasEl.removeEventListener(
      "pointerleave",
      this._workingAreaLeaveBound,
      false
    );
    this._workingCanvasEl.removeEventListener(
      "pointerenter",
      this._workingAreaEnterBound,
      false
    );
  }

  this._workingCanvasEl = canvasEl;
  if (canvasEl) {
    canvasEl.addEventListener("pointerleave", this._workingAreaLeaveBound, false);
    canvasEl.addEventListener("pointerenter", this._workingAreaEnterBound, false);
  }
}

CursorOverlay.prototype._syncWorkingAreaCursor = function (cursorCss) {
  if (!this.containerEl) return;
  const viewportEl = this._findDocumentViewportEl();
  const canvasEl = this._findWorkingCanvasEl();
  if (viewportEl) viewportEl.style.cursor = cursorCss;
  if (canvasEl) canvasEl.style.cursor = cursorCss;
}

CursorOverlay.prototype._removeBitmapPreviewEl = function () {
  if (this.activePreviewEl) {
    this.containerEl.removeChild(this.activePreviewEl);
    this.activePreviewEl = null;
  }
}

CursorOverlay.prototype._onPreviewImageLoad = function () {
  this.refresh();
}

CursorOverlay.prototype._hideBitmapPreview = function () {
  this._removeBitmapPreviewEl();
  this._bitmapPreviewHidden = true;
  this.containerEl.setAttribute("style", "cursor:default; " + this.cursorExtraStyle);
  this._syncWorkingAreaCursor("default");
}

CursorOverlay.prototype._onWorkingAreaPointerLeave = function () {
  if (isBitmapCursorPreview(this.cursorOrPreview)) {
    this._hideBitmapPreview();
  }
}

CursorOverlay.prototype._onWorkingAreaPointerEnter = function (evt) {
  if (!isBitmapCursorPreview(this.cursorOrPreview)) return;
  this._bitmapPreviewHidden = false;
  this.refresh(evt);
}

CursorOverlay.prototype._onWindowPointerMove = function (evt) {
  if (!isBitmapCursorPreview(this.cursorOrPreview)) return;
  if (!this._isPointerInWorkingArea(evt)) {
    this._hideBitmapPreview();
    return;
  }
  this._bitmapPreviewHidden = false;
  this.refresh(evt);
}

/** Activate `cursorOrPreview` (CSS cursor name or bitmap preview descriptor). */
CursorOverlay.prototype.open = function open(cursorOrPreview, cursorExtraStyle) {
  this.cursorOrPreview = cursorOrPreview;
  if (cursorExtraStyle) this.cursorExtraStyle = cursorExtraStyle;
  this._bitmapPreviewHidden = false;
  this._setWindowTracking(isBitmapCursorPreview(cursorOrPreview));
  this._bindWorkingAreaListeners();
  this.refresh();
}

/** Reposition the preview or re-apply the CSS cursor after pointer or content changes. */
CursorOverlay.prototype.refresh = function refresh(evt) {
  if (evt) this._rememberPointerClientPos(evt);

  const cursorOrPreview = this.cursorOrPreview;
  const isCssCursor = typeof cursorOrPreview === "string";

  if (!isCssCursor) {
    this._bindWorkingAreaListeners();

    if (this._shouldHideBitmapPreview(evt)) {
      this._hideBitmapPreview();
      return;
    }

    if (this._bitmapPreviewHidden) this._bitmapPreviewHidden = false;

    const displayScale = this._getDisplayScale(cursorOrPreview);
    const pointerPos = this.pointerPos;
    const previewWidth = cursorOrPreview.boundsRect.width;
    const previewHeight = cursorOrPreview.boundsRect.height;
    const previewUsesImageUrl = typeof cursorOrPreview.pixelSource === "string";
    const previewEl = previewUsesImageUrl ? this.previewImgEl : this.previewCanvasEl;

    if (previewUsesImageUrl) {
      previewEl.onload = this._previewLoadBound;
      previewEl.onerror = this._previewLoadBound;
      previewEl.setAttribute("src", cursorOrPreview.pixelSource);
    } else {
      previewEl.width = previewWidth;
      previewEl.height = previewHeight;
      const ctx = previewEl.getContext("2d");
      const imageData = new ImageData(
        new Uint8ClampedArray(cursorOrPreview.pixelSource.buffer),
        previewWidth,
        previewHeight
      );
      ctx.putImageData(imageData, 0, 0);
    }

    const top =
      pointerPos.y - cursorOrPreview.hotspot.y / displayScale;
    const left =
      pointerPos.x - cursorOrPreview.hotspot.x / displayScale;
    const width = previewWidth / displayScale;
    const height = previewHeight / displayScale;

    previewEl.setAttribute(
      "style",
      "position:absolute;pointer-events:none;user-select:none;z-index:10000;" +
        `top:${top}px;left:${left}px;width:${width}px;height:${height}px`
    );

    const existingPreviewEl = this.activePreviewEl;
    if (existingPreviewEl == null || existingPreviewEl !== previewEl) {
      if (existingPreviewEl) this.containerEl.removeChild(existingPreviewEl);
      this.containerEl.appendChild(previewEl);
      this.activePreviewEl = previewEl;
    }

    this.containerEl.setAttribute("style", "cursor:default; " + this.cursorExtraStyle);
    this._syncWorkingAreaCursor("none");
    return;
  }

  this._setWindowTracking(false);
  this._removeBitmapPreviewEl();
  this._bitmapPreviewHidden = false;
  this.containerEl.setAttribute(
    "style",
    "cursor:" + cursorOrPreview + "; " + this.cursorExtraStyle
  );
  this._syncWorkingAreaCursor(cursorOrPreview);
}
