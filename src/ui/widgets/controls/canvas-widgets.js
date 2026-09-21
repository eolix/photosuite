/**
 * Canvas-backed input widgets: an angle/altitude dial (DrawingCanvas, used for
 * lighting-angle effect inputs) and a tone-curve editor (CurveEditor, used by
 * the Curves adjustment and contour editing). The related levels-style
 * HistogramCanvas is in histogram-canvas.js.
 */

import { ChannelModeSelect } from "./panel-widgets.js";
import { BaseWidget } from "../base-widget.js";

import { Locale } from "../../../core/i18n/locale.js";
import { Point } from "../../../core/math/point.js";
import { ThemeConfig } from "../../config/theme-config.js";
import { EventType } from "../../../core/event-bus.js";
import { addPointerDownListener, addPointerMoveListener, addPointerUpListener, disableTouchGestures, getEventPos, makeElement, removePointerMoveListener, removePointerUpListener, resizeCanvasForDevicePixelRatio } from "../../../core/dom.js";
import { allocateNextUniqueId } from "../../../core/uid.js";
import { AppEvent } from "../../../core/event-bus.js";
import { buildCurveTable, createCurvePoint } from "../../../engine/compositing/tone-curves.js";

const CURVE_CANVAS_SIZE = 256;
const CURVE_POINT_HIT_RADIUS = 5;
const CURVE_POINT_MERGE_THRESHOLD = 2;
const DIAL_CLEAR_SIZE = 100;

/**
 * Angle + altitude dial. getValue returns { oc, alt } (degrees) for effect /
 * filter wire consumers.
 * @param {string} [labelLocaleKey]
 * @param {{ zeroAtTop?: boolean }} [options] When `zeroAtTop` is true, 0° draws
 *   and picks as straight up (rotation dials). Default keeps 0° to the right
 *   (lighting / effect angle convention).
 */
function DrawingCanvas(labelLocaleKey, options) {
  BaseWidget.call(this);
  this.oc = 0;
  this.alt = 0;
  this.dialRadiusPx = 20;
  this.zeroAtTop = !!(options && options.zeroAtTop);
  mountDrawingCanvasDom(this, labelLocaleKey);
  this.setValue(this.oc, this.alt)
}

DrawingCanvas.prototype = Object.create(BaseWidget.prototype);
DrawingCanvas.prototype.constructor = DrawingCanvas;

DrawingCanvas.prototype.buildUI = function() {
  this.labelEl.textContent = Locale.get(this.labelKey) + ":"
};

DrawingCanvas.prototype.setLabel = function(labelText) {
  this.labelEl.textContent = labelText
};

DrawingCanvas.prototype.getValue = function() {
  return {
    oc: this.oc,
    alt: this.alt
  }
};

DrawingCanvas.prototype.setValue = function(angleDeg, altitudeDeg, dispatchChange) {
  if (angleDeg != null) this.oc = angleDeg;
  if (altitudeDeg != null) this.alt = altitudeDeg;
  this.inputEl.value = this.oc;
  drawAngleDial(
    this.ctx2d,
    this.dialRadiusPx,
    dialDisplayAngleDegrees(this, this.oc),
    this.alt
  );
  if (dispatchChange) this.onInput()
};

DrawingCanvas.prototype.onInput = function() {
  const angleDeg = normalizeAngleDegrees(parseInt(this.inputEl.value));
  this.setValue(angleDeg);
  this.dispatch(new AppEvent(EventType.widgetSelect, false))
};

DrawingCanvas.prototype.onPointerDown = function(pointerEvent) {
  addPointerMoveListener(window, this.boundOnPointerMove);
  addPointerUpListener(window, this.boundOnPointerUp);
  this.onPointerMove(pointerEvent)
};

DrawingCanvas.prototype.onPointerMove = function(pointerEvent) {
  const pointerPos = getEventPos(pointerEvent, this.canvas),
    dial = pointerOffsetToAngleAltitude(
      pointerPos.x - this.dialRadiusPx,
      pointerPos.y - this.dialRadiusPx,
      this.dialRadiusPx
    );
  this.setValue(dialStoredAngleDegrees(this, dial.angleDeg), dial.altitudeDeg);
  this.dispatch(new AppEvent(EventType.widgetSelect, false))
};

DrawingCanvas.prototype.onPointerUp = function() {
  this.dispatch(new AppEvent(EventType.widgetSelect, false));
  removePointerMoveListener(window, this.boundOnPointerMove);
  removePointerUpListener(window, this.boundOnPointerUp)
};

/**
 * Editable tone curve (knot mode) or freehand 256-sample curve.
 * Knot coords use PSD wire keys Hrzn / Vrtc.
 * @param {boolean} swapAxes
 * @param {boolean} allowEndpointHorizontalDrag
 */
function CurveEditor(swapAxes, allowEndpointHorizontalDrag) {
  BaseWidget.call(this);
  this.el = makeElement("span", "fitem curveeditor");
  this.histogramData = null;
  this.histogramScale = 0;
  this.histogramColorHex = "";
  this.mode = 0;
  this.swapAxes = swapAxes;
  this.allowEndpointHorizontalDrag = allowEndpointHorizontalDrag;
  this.curveData = null;
  this.activePoint = null;
  this.dragPointer = new Point();
  this.boundOnPointerMove = this.onPointerMove.bind(this);
  this.boundOnPointerUp = this.onPointerUp.bind(this);
  this.canvas = makeElement("canvas", "");
  this.ctx2d = this.canvas.getContext("2d");
  disableTouchGestures(this.canvas);
  resizeCanvasForDevicePixelRatio(this.canvas, CURVE_CANVAS_SIZE, CURVE_CANVAS_SIZE, this.ctx2d);
  this.el.appendChild(this.canvas);
  addPointerDownListener(this.canvas, this.onPointerDown.bind(this))
}

CurveEditor.prototype = Object.create(BaseWidget.prototype);
CurveEditor.prototype.constructor = CurveEditor;

CurveEditor.prototype.setValue = function(curveValue, activePointIndex) {
  const curveJson = JSON.stringify(curveValue);
  if (curveJson == JSON.stringify(this.curveData)) return;
  this.mode = curveValue.length == CURVE_CANVAS_SIZE ? 1 : 0;
  this.curveData = JSON.parse(curveJson);
  if (activePointIndex != null) this.activePoint = this.curveData[activePointIndex];
  this.redraw()
};

CurveEditor.prototype.setHistogramOverlay = function(histogramData, histogramScale, histogramColorHex) {
  this.histogramData = histogramData;
  this.histogramScale = histogramScale;
  this.histogramColorHex = histogramColorHex;
  this.redraw()
};

CurveEditor.prototype.getValue = function() {
  return JSON.parse(JSON.stringify(this.curveData))
};

CurveEditor.prototype.getActivePointIndex = function() {
  return this.curveData.indexOf(this.activePoint)
};

CurveEditor.prototype.onPointerDown = function(pointerEvent) {
  const coords = pointerEventToCurveCoords(pointerEvent, this.canvas, this.swapAxes);
  this.dragPointer.setXY(coords.canvasX, coords.canvasY);
  if (this.mode == 0) {
    this.activePoint = hitOrCreateCurveKnot(this.curveData, coords.canvasX, coords.canvasY)
  }
  addPointerMoveListener(document.body, this.boundOnPointerMove);
  addPointerUpListener(document.body, this.boundOnPointerUp);
  this.onPointerMove(pointerEvent)
};

CurveEditor.prototype.onPointerMove = function(pointerEvent) {
  const coords = pointerEventToCurveCoords(pointerEvent, this.canvas, this.swapAxes);
  if (this.mode == 0) {
    applyKnotModePointerDrag(
      this.curveData,
      this.activePoint,
      coords.canvasX,
      coords.canvasY,
      this.allowEndpointHorizontalDrag
    )
  } else {
    applyPencilModePointerDrag(this.curveData, this.dragPointer, coords.canvasX, coords.canvasY)
  }
  this.dragPointer.setXY(coords.canvasX, coords.canvasY);
  this.redraw();
  this.dispatch(new AppEvent(EventType.widgetSelect))
};

CurveEditor.prototype.onPointerUp = function() {
  removePointerMoveListener(document.body, this.boundOnPointerMove);
  removePointerUpListener(document.body, this.boundOnPointerUp);
  this.dispatch(new AppEvent(EventType.widgetSelect))
};

CurveEditor.prototype.redraw = function() {
  redrawCurveEditor(this)
};

export {
  DrawingCanvas,
  CurveEditor,
  pointerOffsetToAngleAltitude,
  normalizeAngleDegrees,
  pointerToCurveCanvasCoords,
  CURVE_CANVAS_SIZE
};

// --- DrawingCanvas helpers ---------------------------------------------------

function mountDrawingCanvasDom(dial, labelLocaleKey) {
  const inputId = "ai" + allocateNextUniqueId();
  dial.el = makeElement("span", "fitem angleinput");
  if (labelLocaleKey) {
    dial.labelEl = makeElement("label", "flabel");
    dial.labelKey = labelLocaleKey;
    dial.el.appendChild(dial.labelEl);
    dial.labelEl.setAttribute("for", inputId)
  }
  dial.canvas = makeElement("canvas", "gsicon");
  dial.ctx2d = dial.canvas.getContext("2d");
  resizeCanvasForDevicePixelRatio(
    dial.canvas,
    dial.dialRadiusPx * 2 + 1,
    dial.dialRadiusPx * 2 + 1,
    dial.ctx2d
  );
  dial.el.appendChild(dial.canvas);
  addPointerDownListener(dial.canvas, dial.onPointerDown.bind(dial));
  dial.boundOnPointerMove = dial.onPointerMove.bind(dial);
  dial.boundOnPointerUp = dial.onPointerUp.bind(dial);
  dial.inputEl = makeElement("input", "");
  dial.inputEl.setAttribute("type", "text");
  dial.el.appendChild(dial.inputEl);
  dial.inputEl.setAttribute("id", inputId);
  dial.inputEl.addEventListener("change", dial.onInput.bind(dial), false);
  dial.degreeSymbolEl = makeElement("span", "");
  dial.degreeSymbolEl.innerHTML = "\xB0";
  dial.el.appendChild(dial.degreeSymbolEl)
}

function normalizeAngleDegrees(angleDeg) {
  return angleDeg % 360
}

/** Visual angle on the dial (0° right by default; +90° when zeroAtTop). */
function dialDisplayAngleDegrees(dial, storedAngleDeg) {
  return dial.zeroAtTop ? storedAngleDeg + 90 : storedAngleDeg;
}

/** Convert a pointer atan2 angle (0° = right) back to the dial's stored value. */
function dialStoredAngleDegrees(dial, displayAngleDeg) {
  return dial.zeroAtTop ? displayAngleDeg - 90 : displayAngleDeg;
}

/**
 * Map dial-centered pointer offset to rounded angle / altitude degrees.
 */
function pointerOffsetToAngleAltitude(offsetX, offsetY, dialRadiusPx) {
  const angleDeg = 180 * Math.atan2(-offsetY, offsetX) / Math.PI,
    altitudeDeg = 90 - 90 * Math.min(1, Math.sqrt(offsetX * offsetX + offsetY * offsetY) / (0.9 * dialRadiusPx));
  return {
    angleDeg: Math.round(angleDeg),
    altitudeDeg: Math.round(altitudeDeg)
  }
}

function drawAngleDial(ctx, dialRadiusPx, angleDegrees, altitudeDegrees) {
  const angleRad = Math.PI * angleDegrees / 180,
    altitudeRadius = 0.9 * dialRadiusPx * (90 - altitudeDegrees) / 90,
    centerPx = dialRadiusPx + 0.5,
    tipX = centerPx + Math.cos(angleRad) * altitudeRadius,
    tipY = centerPx - Math.sin(angleRad) * altitudeRadius;
  ctx.clearRect(0, 0, DIAL_CLEAR_SIZE, DIAL_CLEAR_SIZE);
  ctx.strokeStyle = "#000000";
  ctx.beginPath();
  ctx.arc(centerPx, centerPx, 0.9 * dialRadiusPx, 0, 2 * Math.PI);
  ctx.moveTo(centerPx, centerPx);
  ctx.lineTo(
    centerPx + Math.cos(angleRad) * dialRadiusPx * 0.9,
    centerPx - Math.sin(angleRad) * dialRadiusPx * 0.9
  );
  ctx.stroke();
  ctx.strokeStyle = "#ff0000";
  ctx.beginPath();
  ctx.moveTo(tipX - 3, tipY);
  ctx.lineTo(tipX + 3, tipY);
  ctx.moveTo(tipX, tipY - 3);
  ctx.lineTo(tipX, tipY + 3);
  ctx.stroke()
}

// --- CurveEditor helpers -----------------------------------------------------

function pointerToCurveCanvasCoords(pointerX, pointerY, swapAxes) {
  let canvasX = pointerX,
    canvasY = CURVE_CANVAS_SIZE - pointerY;
  if (swapAxes) {
    const swapped = canvasX;
    canvasX = CURVE_CANVAS_SIZE - canvasY;
    canvasY = swapped
  }
  return {
    canvasX: canvasX,
    canvasY: canvasY
  }
}

function pointerEventToCurveCoords(pointerEvent, canvas, swapAxes) {
  const pointerPos = getEventPos(pointerEvent, canvas);
  return pointerToCurveCanvasCoords(pointerPos.x, pointerPos.y, swapAxes)
}

function hitOrCreateCurveKnot(curveData, canvasX, canvasY) {
  let hitPoint = null;
  for (let pointIdx = 0; pointIdx < curveData.length; pointIdx++) {
    const pointValue = curveData[pointIdx].v,
      deltaX = pointValue.Hrzn.v - canvasX,
      deltaY = pointValue.Vrtc.v - canvasY,
      distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    if (distance < CURVE_POINT_HIT_RADIUS) hitPoint = curveData[pointIdx]
  }
  if (hitPoint == null) {
    hitPoint = createCurvePoint(canvasX, canvasY, true);
    curveData.push(hitPoint)
  }
  return hitPoint
}

function applyKnotModePointerDrag(curvePoints, activePoint, canvasX, canvasY, allowEndpointHorizontalDrag) {
  const activeIdx = curvePoints.indexOf(activePoint),
    isEndpoint = activeIdx == 0 || activeIdx == curvePoints.length - 1;
  let minHorizontal = 0,
    maxHorizontal = 255,
    keepPoint = true;
  if (isEndpoint) {
    minHorizontal = 1;
    maxHorizontal = 254
  }
  if (!allowEndpointHorizontalDrag || !isEndpoint) {
    activePoint.v.Hrzn.v = Math.max(minHorizontal, Math.min(maxHorizontal, Math.round(canvasX)))
  }
  activePoint.v.Vrtc.v = Math.max(0, Math.min(255, Math.round(canvasY)));
  for (let pointIdx = 0; pointIdx < curvePoints.length; pointIdx++) {
    if (curvePoints[pointIdx] == activePoint) continue;
    if (Math.abs(curvePoints[pointIdx].v.Hrzn.v - activePoint.v.Hrzn.v) < CURVE_POINT_MERGE_THRESHOLD) {
      keepPoint = false
    }
  }
  if (canvasX < 0 || canvasX > 255 || canvasY < 0 || canvasY > 255) keepPoint = false;
  if (keepPoint && curvePoints.indexOf(activePoint) == -1) curvePoints.push(activePoint);
  if (
    !keepPoint &&
    curvePoints.indexOf(activePoint) != -1 &&
    curvePoints.length > 2 &&
    (!allowEndpointHorizontalDrag || !isEndpoint)
  ) {
    curvePoints.splice(curvePoints.indexOf(activePoint), 1)
  }
  if (curvePoints[0].v.Hrzn.v == curvePoints[1].v.Hrzn.v) {
    if (curvePoints[0].v.Hrzn.v == 0) curvePoints[1].v.Hrzn.v = 1;
    else curvePoints[0].v.Hrzn.v--
  }
  curvePoints.sort(function(leftPoint, rightPoint) {
    return leftPoint.v.Hrzn.v - rightPoint.v.Hrzn.v
  })
}

function applyPencilModePointerDrag(curveData, dragPointer, canvasX, canvasY) {
  canvasX = Math.round(canvasX);
  canvasY = Math.round(canvasY);
  canvasX = Math.max(0, Math.min(255, canvasX));
  canvasY = Math.max(0, Math.min(255, canvasY));
  let rangeStart = dragPointer.x,
    rangeEnd = canvasX,
    valueStart = dragPointer.y,
    valueEnd = canvasY;
  if (canvasX < dragPointer.x) {
    rangeEnd = rangeStart;
    rangeStart = canvasX;
    valueEnd = valueStart;
    valueStart = canvasY
  }
  curveData[canvasX] = canvasY;
  if (rangeStart != rangeEnd) {
    for (let sampleX = rangeStart; sampleX <= rangeEnd; sampleX++) {
      curveData[sampleX] = Math.round(
        valueStart + (sampleX - rangeStart) * (valueEnd - valueStart) / (rangeEnd - rangeStart)
      )
    }
  }
}

function redrawCurveEditor(editor) {
  const ctx = editor.ctx2d;
  const palette = ThemeConfig.getCanvasPalette();
  ctx.fillStyle = palette.plate;
  ctx.fillRect(0, 0, CURVE_CANVAS_SIZE, CURVE_CANVAS_SIZE);
  drawCurveHistogramOverlay(ctx, editor);
  drawCurveGrid(ctx, palette);
  if (editor.swapAxes) {
    ctx.save();
    ctx.transform(0, 1, -1, 0, CURVE_CANVAS_SIZE, 0)
  }
  if (editor.mode == 0) drawKnotCurve(ctx, editor.curveData, editor.activePoint, palette);
  else drawPencilCurve(ctx, editor.curveData, palette);
  if (editor.swapAxes) ctx.restore()
}

function drawCurveHistogramOverlay(ctx, editor) {
  if (!editor.histogramData) return;
  ctx.translate(0, CURVE_CANVAS_SIZE);
  ctx.scale(1, -1);
  ChannelModeSelect.drawHistogramBand(
    ctx,
    editor.histogramData,
    5700 / editor.histogramScale,
    editor.histogramColorHex
  );
  ctx.scale(1, -1);
  ctx.translate(0, -CURVE_CANVAS_SIZE)
}

function drawCurveGrid(ctx, palette) {
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gridIdx = 1; gridIdx < 4; gridIdx++) {
    ctx.moveTo(0, 64 * gridIdx - 0.5);
    ctx.lineTo(255, 64 * gridIdx - 0.5);
    ctx.moveTo(64 * gridIdx - 0.5, 0);
    ctx.lineTo(64 * gridIdx - 0.5, 255)
  }
  ctx.stroke();
  ctx.strokeStyle = palette.frame;
  ctx.strokeRect(0.5, 0.5, CURVE_CANVAS_SIZE - 1, CURVE_CANVAS_SIZE - 1)
}

function drawKnotCurve(ctx, curvePoints, activePoint, palette) {
  const curveTable = buildCurveTable(curvePoints, CURVE_CANVAS_SIZE);
  ctx.strokeStyle = palette.trace;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, 255.5 - curveTable[0]);
  for (let sampleIdx = 0; sampleIdx < CURVE_CANVAS_SIZE; sampleIdx++) {
    ctx.lineTo(sampleIdx, 255.5 - curveTable[sampleIdx])
  }
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = palette.handleStroke;
  for (let pointIdx = 0; pointIdx < curvePoints.length; pointIdx++) {
    const pointCoords = curvePoints[pointIdx].v;
    ctx.fillStyle = activePoint == curvePoints[pointIdx] ? palette.handleActiveFill : palette.handleFill;
    ctx.beginPath();
    ctx.moveTo(pointCoords.Hrzn.v, 255.5 - pointCoords.Vrtc.v);
    ctx.arc(pointCoords.Hrzn.v, 255.5 - pointCoords.Vrtc.v, 3.5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke()
  }
}

function drawPencilCurve(ctx, curveTable, palette) {
  ctx.strokeStyle = palette.trace;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, 255.5 - curveTable[0]);
  for (let sampleIdx = 0; sampleIdx < CURVE_CANVAS_SIZE; sampleIdx++) {
    ctx.lineTo(sampleIdx, 255.5 - curveTable[sampleIdx])
  }
  ctx.stroke()
}
