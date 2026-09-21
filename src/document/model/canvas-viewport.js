/**
 * Canvas viewport: pan, zoom, and rotation view state for a document, plus
 * screen↔document coordinate transforms. Owned by `doc.pathViewport`; mirrored by the navigator.
 */
import { Point } from "../../core/math/point.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";

function documentCenter(documentBounds) {
  return {
    x: documentBounds.width / 2,
    y: documentBounds.height / 2,
  };
}

function resolveViewState(viewport, useGestureState) {
  return {
    zoom: useGestureState ? viewport.gestureZoomScale : viewport.zoomScale,
    pan: useGestureState ? viewport.gesturePanOffset : viewport.panOffset,
  };
}

class CanvasViewport {
  /** @param {{ width: number, height: number }} documentBounds */
  constructor(documentBounds) {
    this.documentBounds = documentBounds;
    this.zoomScale = 0;
    this.gestureZoomScale = 1;
    this.panOffset = new Point(0, 0);
    this.gesturePanOffset = new Point(0, 0);
    this.rotationRadians = 0;
    this.channelVisibility = [1, 1, 1];
    this.viewportRect = new Rect(0, 0, 1, 1);
    this.fullDocumentRect = new Rect(0, 0, documentBounds.width, documentBounds.height);
    this.dimensionOverlay = null;
    this.zoomPreviewUpscaledBuffer = null;
    this.zoomPreviewSampleBuffer = new Uint32Array(0);
    this.horizontalRulerImageData = null;
    this.verticalRulerImageData = null;
    this.scratchUint8Buffer = allocBuffer(0);
    this.scratchRgbaBuffer = null;
    this.viewCanvasTexture = null;
  }

  getViewMatrix(useGestureState = false) {
    const matrix = new Matrix2D();
    const { zoom, pan } = resolveViewState(this, useGestureState);
    const { viewportRect, documentBounds, rotationRadians } = this;
    const translateX = Math.round((viewportRect.width - documentBounds.width * zoom) / 2 + pan.x);
    const translateY = Math.round((viewportRect.height - documentBounds.height * zoom) / 2 + pan.y);

    matrix.translate(-translateX, -translateY);
    matrix.scale(1 / zoom, 1 / zoom);

    const pivot = documentCenter(documentBounds);
    matrix.translate(-pivot.x, -pivot.y);
    matrix.rotate(rotationRadians);
    matrix.translate(pivot.x, pivot.y);
    return matrix;
  }

  applyViewMatrixFromTransform(matrix) {
    const { viewportRect, documentBounds } = this;
    const rotation = Math.atan2(-matrix.b, matrix.a);
    const pivot = documentCenter(documentBounds);

    matrix.translate(-pivot.x, -pivot.y);
    matrix.rotate(-rotation);
    matrix.translate(pivot.x, pivot.y);

    let scale = 1 / matrix.getScale();
    matrix.scale(scale, scale);

    const panX = -matrix.tx;
    const panY = -matrix.ty;
    const scrollX = Math.round(panX - (viewportRect.width - documentBounds.width * scale) / 2);
    const scrollY = Math.round(panY - (viewportRect.height - documentBounds.height * scale) / 2);

    if (Math.abs(scale - Math.round(scale)) < 1e-6) scale = Math.round(scale);

    this.rotationRadians = rotation;
    this.zoomScale = scale;
    this.panOffset = new Point(scrollX, scrollY);
  }

  screenToDocPoint(screenX, screenY) {
    return this.getViewMatrix().transformPoint(new Point(screenX, screenY));
  }

  docToScreenPoint(docX, docY) {
    const matrix = this.getViewMatrix();
    matrix.invert();
    return matrix.transformPoint(new Point(docX, docY));
  }
}

export { CanvasViewport };
