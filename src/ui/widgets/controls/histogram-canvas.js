/**
 * Levels-style range strip: a channel gradient bar with four draggable
 * triangular handles, used by the Blend-If control (ModeDropdown) to set the
 * "this layer" and "underlying" blend ranges. Its value is the four threshold
 * bytes `[shadowStart, shadowEnd, highlightStart, highlightEnd]`. Handles split
 * into pairs (0/1 and 2/3); dragging one moves both unless they are already
 * split or Alt is held, which drags the two apart independently.
 */

import { BaseWidget } from "../base-widget.js";

import { Locale } from "../../../core/i18n/locale.js";
import { EventType } from "../../../core/event-bus.js";
import { addPointerDownListener, addPointerMoveListener, addPointerUpListener, getDevicePixelRatio, getEventPos, makeElement, removePointerMoveListener, removePointerUpListener, resizeCanvasForDevicePixelRatio } from "../../../core/dom.js";
import { AppEvent } from "../../../core/event-bus.js";

/** Gradient end colors by channel index: gray, R, G, B. */
const CHANNEL_GRADIENT_END_HEX = ["ffffff", "ff0000", "00ff00", "0000ff"];

const HANDLE_HIT_RADIUS_PX = 8;
const LEVEL_CANVAS_INSET_PX = 8;
const LABEL_SPAN_WIDTHS_EM = [8, 2, 7, 2, 2];

/**
 * Levels-style histogram strip with four triangular handles.
 * @param {string} labelLocaleKey
 */
function HistogramCanvas(labelLocaleKey) {
  BaseWidget.call(this);
  this.el = makeElement("div");
  this.offscreenCanvas = makeElement("canvas");
  this.labelLocaleKey = labelLocaleKey;
  this.levelThresholds = [0, 20, 200, 255];
  this.channelIndex = 0;
  this.activeHandleIndex = -1;
  this.labelSpans = [];
  mountHistogramLabelSpans(this);
  this.boundOnDragStart = this.onDragStart.bind(this);
  this.boundOnDrag = this.onDrag.bind(this);
  this.boundOnDragEnd = this.onDragEnd.bind(this);
  addPointerDownListener(this.offscreenCanvas, this.boundOnDragStart);
  this.el.appendChild(this.offscreenCanvas);
  this.redraw()
}

HistogramCanvas.prototype = Object.create(BaseWidget.prototype);
HistogramCanvas.prototype.constructor = HistogramCanvas;

HistogramCanvas.prototype.buildUI = function() {
  this.redraw()
};

HistogramCanvas.prototype.setValue = function(levelThresholds, channelIndex) {
  this.levelThresholds = levelThresholds;
  this.channelIndex = channelIndex;
  this.redraw()
};

HistogramCanvas.prototype.getValue = function() {
  return this.levelThresholds.slice(0)
};

HistogramCanvas.prototype.onDragStart = function(pointerEvent) {
  const thresholds = this.levelThresholds,
    pointerPos = getEventPos(pointerEvent, this.offscreenCanvas),
    markerX = pointerPos.x - LEVEL_CANVAS_INSET_PX,
    handleIndex = hitTestLevelHandle(markerX, thresholds);
  if (handleIndex == -1) return;
  this.activeHandleIndex = handleIndex;
  this.linkOppositeHandlesOnDrag = shouldLinkOppositeHandlesOnDrag(
    pointerEvent.altKey,
    handleIndex,
    thresholds
  );
  addPointerMoveListener(window, this.boundOnDrag);
  addPointerUpListener(window, this.boundOnDragEnd)
};

HistogramCanvas.prototype.onDrag = function(pointerEvent) {
  const thresholds = this.levelThresholds,
    handleIndex = this.activeHandleIndex,
    pairStart = (handleIndex >>> 1) * 2,
    pairEnd = pairStart + 1,
    pointerPos = getEventPos(pointerEvent, this.offscreenCanvas),
    level = clampLevelByte(pointerPos.x - LEVEL_CANVAS_INSET_PX);
  thresholds[handleIndex] = level;
  if (this.linkOppositeHandlesOnDrag && thresholds[pairStart] >= thresholds[pairEnd]) {
    this.linkOppositeHandlesOnDrag = false
  }
  if (!this.linkOppositeHandlesOnDrag) thresholds[pairStart] = thresholds[pairEnd] = level;
  this.redraw();
  this.dispatch(new AppEvent(EventType.widgetSelect, false))
};

HistogramCanvas.prototype.onDragEnd = function() {
  removePointerMoveListener(window, this.boundOnDrag);
  removePointerUpListener(window, this.boundOnDragEnd)
};

HistogramCanvas.prototype.redraw = function() {
  redrawHistogramCanvas(this)
};

export {
  HistogramCanvas,
  hitTestLevelHandle,
  shouldLinkOppositeHandlesOnDrag,
  clampLevelByte,
  CHANNEL_GRADIENT_END_HEX
};

// --- Construction / hit-test -------------------------------------------------

function mountHistogramLabelSpans(widget) {
  for (let spanIdx = 0; spanIdx < 5; spanIdx++) {
    const labelSpan = makeElement("span");
    labelSpan.setAttribute(
      "style",
      "display:inline-block;width:" + LABEL_SPAN_WIDTHS_EM[spanIdx] + "em"
    );
    widget.labelSpans.push(labelSpan);
    widget.el.appendChild(labelSpan)
  }
}

/**
 * Pick the nearest in-range handle. Even handles only accept left approaches;
 * odd handles only accept right approaches (matches triangular marker faces).
 */
function hitTestLevelHandle(markerX, thresholds) {
  let handleIndex = -1,
    nearestDistance = 1e9;
  for (let handleIdx = 0; handleIdx < 4; handleIdx++) {
    const offset = markerX - thresholds[handleIdx],
      distance = Math.abs(offset);
    if (
      distance < HANDLE_HIT_RADIUS_PX &&
      distance < nearestDistance &&
      (((handleIdx & 1) == 0 && offset < 0) || ((handleIdx & 1) == 1 && offset > 0))
    ) {
      nearestDistance = distance;
      handleIndex = handleIdx
    }
  }
  return handleIndex
}

/** Alt or already-split pair → keep handles independent while dragging. */
function shouldLinkOppositeHandlesOnDrag(altKey, handleIndex, thresholds) {
  const pairStart = (handleIndex >>> 1) * 2,
    pairEnd = pairStart + 1;
  return altKey || thresholds[pairStart] != thresholds[pairEnd]
}

function clampLevelByte(rawX) {
  return Math.round(Math.max(0, Math.min(255, rawX)))
}

// --- Redraw ------------------------------------------------------------------

function redrawHistogramCanvas(widget) {
  const canvasEl = widget.offscreenCanvas;
  resizeCanvasForDevicePixelRatio(canvasEl, 255 + 16, 16);
  const ctx = canvasEl.getContext("2d"),
    markerHeight = canvasEl.height,
    deviceRatio = getDevicePixelRatio(),
    gradientWidth = Math.round(255 * deviceRatio),
    markerWidth = Math.round(LEVEL_CANVAS_INSET_PX * deviceRatio);
  ctx.translate(markerWidth, 0);
  drawChannelGradientBar(ctx, gradientWidth, markerWidth, widget.channelIndex);
  updateHistogramLabels(widget);
  drawLevelHandleMarkers(ctx, widget.levelThresholds, markerWidth, deviceRatio)
}

function drawChannelGradientBar(ctx, gradientWidth, markerWidth, channelIndex) {
  const gradient = ctx.createLinearGradient(0, 0, gradientWidth, 0);
  gradient.addColorStop(0, "black");
  gradient.addColorStop(1, "#" + CHANNEL_GRADIENT_END_HEX[channelIndex]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, gradientWidth, markerWidth)
}

function updateHistogramLabels(widget) {
  const labelSpans = widget.labelSpans;
  labelSpans[0].textContent = Locale.get(widget.labelLocaleKey) + ":";
  for (let handleIdx = 0; handleIdx < 4; handleIdx++) {
    labelSpans[1 + handleIdx].textContent = widget.levelThresholds[handleIdx]
  }
}

function drawLevelHandleMarkers(ctx, levelThresholds, markerWidth, deviceRatio) {
  for (let handleIdx = 0; handleIdx < 4; handleIdx++) {
    const markerX = Math.round(levelThresholds[handleIdx] * deviceRatio),
      tipDirection = (handleIdx & 1) == 0 ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(markerX, markerWidth);
    ctx.lineTo(markerX, markerWidth + markerWidth);
    ctx.lineTo(markerX + tipDirection * markerWidth, markerWidth + markerWidth);
    ctx.closePath();
    ctx.fillStyle = "#cccccc";
    ctx.fill();
    ctx.strokeStyle = "black";
    ctx.stroke()
  }
}
