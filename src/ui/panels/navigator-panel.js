/**
 * Sidebar Navigator panel. Draws a small thumbnail of the whole document with a
 * red rectangle marking the part currently visible in the canvas viewport, and
 * a zoom slider beneath it. Dragging on the thumbnail pans the document;
 * moving the slider zooms. The thumbnail is rendered from a mip pyramid of the
 * composited image so it stays cheap regardless of document size.
 *
 * Zoom documentAction payloads use the wire key `S` for the target scale step.
 */

import { Rect } from "../../core/math/rect.js";
import { ToolId } from "../../document/model/tool-base.js";
import { BaseTool } from "../widgets/base-tool.js";
import { RangeInput } from "../widgets/controls/number-inputs.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { EventType } from "../../core/event-bus.js";
import { addPointerDownListener, addPointerMoveListener, addPointerUpListener, disableTouchGestures, getDevicePixelRatio, getEventPos, isInDOM, makeElement, removePointerMoveListener, removePointerUpListener, setElementCssSizeForDeviceRatio } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { HandTool, ZoomTool } from "../../document/tools/view-tools.js";
import { buildMipPyramidAlpha, copyBuffer } from "../../engine/compositing/buffer-utils.js";

const DEFAULT_THUMB_CANVAS_PX = 100;
const MAX_THUMB_PX = 300;

function NavigatorPanel() {
  BaseTool.call(this, "panels.navigator", false, getIconUrl("panels/navigator"), BaseTool.PanelId.NAVIGATOR, true);
  this.activeDoc = null;
  this.onPointerMoveBound = this.onThumbPointerMove.bind(this);
  this.onPointerUpBound = this.onThumbPointerUp.bind(this);
  installNavigatorPanelLayout(this)
}
NavigatorPanel.prototype = Object.create(BaseTool.prototype);

NavigatorPanel.prototype.resize = function(_width, _height) {
  this.redraw()
};

NavigatorPanel.prototype.onZoomChange = function(_evt) {
  this.dispatch(buildZoomDocumentAction(this.zoomSlider.getValue()))
};

NavigatorPanel.prototype.onThumbPointerDown = function(_evt) {
  if (this.activeDoc == null) return;
  addPointerMoveListener(window, this.onPointerMoveBound);
  addPointerUpListener(window, this.onPointerUpBound)
};

NavigatorPanel.prototype.onThumbPointerMove = function(evt) {
  const doc = this.activeDoc;
  if (doc == null) return;
  const pos = getEventPos(evt, this.offscreenCanvas),
    relative = computeThumbRelativeOffset(pos, this.offscreenCanvas, getDevicePixelRatio()),
    panOrigin = computePanOriginFromThumb(doc, relative.x, relative.y);
  HandTool.setViewScrollOrigin(doc, panOrigin.x, panOrigin.y)
};

NavigatorPanel.prototype.onThumbPointerUp = function(_evt) {
  detachThumbPointerTracking(this)
};

NavigatorPanel.prototype.open = function(doc) {
  if (doc == null && this.activeDoc != null) this.offscreenCanvas.width = DEFAULT_THUMB_CANVAS_PX;
  this.activeDoc = doc;
  this.redraw()
};

NavigatorPanel.prototype.redraw = function() {
  const doc = this.activeDoc;
  if (doc == null || doc.pathViewport.zoomScale == 0) return;
  const view = doc.pathViewport;
  if (!isInDOM(this.panelBody)) return;
  syncZoomSliderFromViewport(this, view);
  paintNavigatorThumbnail(this, doc, view)
};

NavigatorPanel.prototype.onUpdate = function(_doc, _popupType) {};

NavigatorPanel.prototype.refresh = function() {
  this.redraw()
};

/**
 * Map slider index (0 = min zoom) to a ZOOM_STEPS scale value.
 */
NavigatorPanel.zoomLevelFromSliderValue = zoomLevelFromSliderValue;

/**
 * Map current viewport scale to slider index (inverted step order).
 */
NavigatorPanel.sliderValueFromZoomScale = sliderValueFromZoomScale;

/**
 * Document pan origin from normalized thumb click offset.
 */
NavigatorPanel.computePanOriginFromThumb = computePanOriginFromThumb;

export { NavigatorPanel };

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function installNavigatorPanelLayout(panel) {
  const wrapper = makeElement("div", "padded");
  wrapper.setAttribute("style", "min-width:15em");
  panel.panelBody.appendChild(wrapper);
  const thumbWrap = makeElement("div");
  wrapper.appendChild(thumbWrap);
  thumbWrap.setAttribute("style", "cursor:grab;");
  panel.offscreenCanvas = makeElement("canvas");
  panel.offscreenCanvas.width = DEFAULT_THUMB_CANVAS_PX;
  thumbWrap.appendChild(panel.offscreenCanvas);
  disableTouchGestures(panel.offscreenCanvas);
  addPointerDownListener(panel.offscreenCanvas, panel.onThumbPointerDown.bind(panel));
  panel.zoomSlider = new RangeInput(null, 0, ZoomTool.ZOOM_STEPS.length - 1);
  panel.zoomSlider.on(EventType.widgetSelect, panel.onZoomChange, panel);
  wrapper.appendChild(panel.zoomSlider.el)
}

function detachThumbPointerTracking(panel) {
  removePointerMoveListener(window, panel.onPointerMoveBound);
  removePointerUpListener(window, panel.onPointerUpBound)
}

// ---------------------------------------------------------------------------
// Zoom dispatch + slider sync
// ---------------------------------------------------------------------------

function zoomLevelFromSliderValue(sliderValue) {
  const steps = ZoomTool.ZOOM_STEPS;
  return steps[steps.length - 1 - sliderValue]
}

function sliderValueFromZoomScale(zoomScale) {
  return ZoomTool.ZOOM_STEPS.length - 1 - ZoomTool.findZoomStepIndex(zoomScale)
}

function buildZoomDocumentAction(sliderValue) {
  const dispatchEvt = new AppEvent(EventType.documentAction, true);
  dispatchEvt.routingChannel = ToolId.TOOL_ZOOM;
  dispatchEvt.data = {
    actionKind: "zoom",
    S: zoomLevelFromSliderValue(sliderValue)
  };
  return dispatchEvt
}

function syncZoomSliderFromViewport(panel, view) {
  panel.zoomSlider.setValue(sliderValueFromZoomScale(view.zoomScale))
}

// ---------------------------------------------------------------------------
// Thumbnail paint
// ---------------------------------------------------------------------------

function computeThumbRelativeOffset(pointerPos, canvas, devicePixelRatio) {
  const thumbW = canvas.width,
    thumbH = canvas.height;
  return {
    x: (pointerPos.x * devicePixelRatio - thumbW / 2) / thumbW,
    y: (pointerPos.y * devicePixelRatio - thumbH / 2) / thumbH
  }
}

function computePanOriginFromThumb(doc, relX, relY) {
  return {
    x: Math.round(-doc.pathViewport.zoomScale * doc.width * relX),
    y: Math.round(-doc.pathViewport.zoomScale * doc.height * relY)
  }
}

function selectMipIndex(mipChain, maxThumbPx) {
  let mipIndex = 0;
  while (Math.max(mipChain[mipIndex + 1].width, mipChain[mipIndex + 1].height) > maxThumbPx) {
    mipIndex += 2
  }
  return mipIndex
}

/**
 * Composite the document, pick a mip level small enough for the thumbnail,
 * size the canvas to it, blit the pixels, and overlay the viewport rectangle.
 */
function paintNavigatorThumbnail(panel, doc, view) {
  const maxThumbPx = MAX_THUMB_PX * getDevicePixelRatio(),
    mipChain = [doc.getRasterData(), new Rect(0, 0, doc.width, doc.height)];
  buildMipPyramidAlpha(mipChain);
  const mipIndex = selectMipIndex(mipChain, maxThumbPx),
    pixels = mipChain[mipIndex],
    rect = mipChain[mipIndex + 1],
    canvasW = rect.width,
    canvasH = rect.height,
    canvas = panel.offscreenCanvas;
  canvas.width = canvasW;
  canvas.height = canvasH;
  setElementCssSizeForDeviceRatio(canvas, canvasW, canvasH);
  const ctx = canvas.getContext("2d"),
    imageData = ctx.createImageData(canvasW, canvasH);
  copyBuffer(pixels, imageData.data);
  ctx.putImageData(imageData, 0, 0);
  strokeViewportIndicator(ctx, view, doc, canvasW)
}

function strokeViewportIndicator(ctx, view, doc, canvasW) {
  const viewportRect = view.viewportRect,
    topLeft = view.screenToDocPoint(viewportRect.x, viewportRect.y),
    bottomRight = view.screenToDocPoint(viewportRect.x + viewportRect.width, viewportRect.y + viewportRect.height),
    scale = canvasW / doc.width;
  ctx.scale(scale, scale);
  ctx.lineWidth = 4 / scale;
  ctx.strokeStyle = "#ff0000";
  ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y)
}
