/**
 * Free-transform on-canvas controllers: TransformBox (bounding box + corner
 * handles) and WarpMesh (warp/puppet mesh handles). Driven by the transform,
 * move, text, and shape tools.
 */

import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Point, constrainEndpointToAxis } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { bytesToBase64 } from "../formats/registry/registry-helpers.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { getDevicePixelRatio } from "../../core/dom.js";
import { getRotateCursorImage } from "../../ui/shell/cursor-overlay.js";
import { ToolBase } from "../model/tool-base.js";
import { snapPointToGuides, snapRectCornersToGuides, updateLayerDragPositions } from "../model/guide-snapping.js";
import { boundsFromCoordPairs, isPolygonConvex, transformCoordPairs } from "../../engine/compositing/anti-alias.js";
import { cornersToHomography, homographyTransformXY, invert, transformPointsArray } from "../../engine/compositing/homography.js";
import { getWarpControlPoints, pointsToCustomEnvelope } from "../../engine/compositing/warp.js";


/** 3×3 handle grid indices (centre = 4). */
const HANDLE = {
  TOP_LEFT: 0,
  TOP_EDGE: 1,
  TOP_RIGHT: 2,
  LEFT_EDGE: 3,
  CENTER: 4,
  RIGHT_EDGE: 5,
  BOTTOM_LEFT: 6,
  BOTTOM_EDGE: 7,
  BOTTOM_RIGHT: 8,
  CUSTOM_PIVOT: 9,
  INTERIOR: 10,
  ROTATE: 11,
};

/** How corner drags interpret Shift / Alt / Ctrl. */
const CONSTRAINT = {
  FREE: 0,
  FORCE_ALL_MODIFIERS: 1,
  FORCE_CTRL_UNLESS_SHIFT_DOWN: 2,
  DISABLE_CTRL: 3,
  INTERIOR_HIT_ONLY: 4,
};

/** Bezier path order around a 4×4 warp control lattice (ring, then crossbars). */
const WARP_ENVELOPE_RING = [0, 1, 2, 3, 7, 11, 15, 14, 13, 12, 8, 4, 0];
const WARP_CROSSBAR_ORDER = [4, 0, 1, 2, 3, 7, 11, 15, 14, 13, 12, 8];

const OPPOSITE_HANDLE_RING = [0, 1, 2, 5, 8, 7, 6, 3];
const CORNER_TO_COORD_INDEX = [0, 0, 2, 0, 0, 0, 6, 0, 4, 0];
const RESIZE_CURSOR_ANGLES = [135, 90, 45, 180, 0, 0, 225, 270, 315];
const RESIZE_CURSOR_NAMES = "ew nesw ns nwse ew nesw ns nwse".split(" ");

/**
 * Orthogonal projection of (pointX, pointY) onto the infinite line through
 * segment endpoints. Returns `[projectedX, projectedY, distance]`.
 */
function projectOntoSegment(segmentStartX, segmentStartY, segmentEndX, segmentEndY, pointX, pointY) {
  const deltaX = segmentEndX - segmentStartX;
  const deltaY = segmentEndY - segmentStartY;
  const pointDeltaX = pointX - segmentStartX;
  const pointDeltaY = pointY - segmentStartY;
  const segmentLengthSq = deltaX * deltaX + deltaY * deltaY;
  const projectionT = (pointDeltaX * deltaX + pointDeltaY * deltaY) / segmentLengthSq;
  const projectedX = segmentStartX + projectionT * deltaX;
  const projectedY = segmentStartY + projectionT * deltaY;
  const distanceX = pointX - projectedX;
  const distanceY = pointY - projectedY;
  return [projectedX, projectedY, Math.sqrt(distanceX * distanceX + distanceY * distanceY)];
}

/**
 * True when the corner quad (or its reverse winding) is a convex polygon.
 * @param {number[]} cornerCoords Flat `[x0,y0,…,x3,y3]`.
 */
export function isConvexTransformQuad(cornerCoords) {
  return (
    isPolygonConvex(cornerCoords) ||
    isPolygonConvex([
      cornerCoords[6],
      cornerCoords[7],
      cornerCoords[4],
      cornerCoords[5],
      cornerCoords[2],
      cornerCoords[3],
      cornerCoords[0],
      cornerCoords[1],
    ])
  );
}

function isCornerHandleIndex(handleIndex) {
  return (
    handleIndex === HANDLE.TOP_LEFT ||
    handleIndex === HANDLE.TOP_RIGHT ||
    handleIndex === HANDLE.BOTTOM_LEFT ||
    handleIndex === HANDLE.BOTTOM_RIGHT
  );
}

function isEdgeHandleIndex(handleIndex) {
  return (
    handleIndex === HANDLE.TOP_EDGE ||
    handleIndex === HANDLE.LEFT_EDGE ||
    handleIndex === HANDLE.RIGHT_EDGE ||
    handleIndex === HANDLE.BOTTOM_EDGE
  );
}

function unitSquareNormalizedGrid() {
  const points = [];
  for (let gridRow = 0; gridRow < 3; gridRow++) {
    for (let gridCol = 0; gridCol < 3; gridCol++) {
      points.push(new Point(gridCol / 2, gridRow / 2));
    }
  }
  return points;
}

function oppositeHandleIndex(handleIndex) {
  const ringIndex = OPPOSITE_HANDLE_RING.indexOf(handleIndex);
  return OPPOSITE_HANDLE_RING[(ringIndex + 4) % 8];
}

/**
 * The interactive transform quad: the eight handles a user drags to scale,
 * rotate, skew or distort, plus the state of the drag in progress.
 */
export function TransformBox(
  cornerCoords,
  allowInteriorMove,
  allowSkewFromCorners,
  usePerspectiveCornerDrag,
  clampScalePositive,
  uniformCornerScale,
  handleConstraintMode,
  showThirdsGrid,
) {
  this.dragStartCornerCoords = null;
  this.cornerCoords = cornerCoords ? cornerCoords.slice(0) : null;
  this.activeHandleIndex = HANDLE.CENTER;
  this.cursorPos = null;
  this.scaleOriginPoint = null;
  this.dragAnchorPoint = null;
  this.dragHandleIndex = -1;
  this.pointerDocPoint = null;
  this.shiftKeyAtMouseDown = false;
  this.rotateCursorBitmaps = null;
  this.allowInteriorMove = allowInteriorMove;
  this.allowSkewFromCorners = allowSkewFromCorners;
  this.usePerspectiveCornerDrag = usePerspectiveCornerDrag;
  this.clampScalePositive = clampScalePositive;
  this.uniformCornerScale = uniformCornerScale;
  this.handleConstraintMode = handleConstraintMode;
  this.showThirdsGrid = showThirdsGrid;
}

installTransformBoxPrototype();
TransformBox.projectOntoSegment = projectOntoSegment;
TransformBox.isConvexTransformQuad = isConvexTransformQuad;

/** The warp grid laid over a transform: its control points and the drag state. */
export function WarpMesh(warpDescriptor) {
  this.warpDescriptor = null;
  this.dragHandleIndex = -1;
  this.setWarpDescriptor(warpDescriptor);
}

installWarpMeshPrototype();

function installTransformBoxPrototype() {
  TransformBox.prototype.isHandleDragActive = function () {
    return this.dragHandleIndex !== -1;
  };

  TransformBox.prototype.getCornerCoords = function () {
    return this.cornerCoords.slice(0);
  };

  TransformBox.prototype.setCornerCoords = function (cornerCoords) {
    this.cornerCoords = cornerCoords;
  };

  TransformBox.prototype.getTransformHandlePoints = function () {
    return this.getHandlePoints(this.cornerCoords);
  };

  TransformBox.prototype.getActiveHandleIndex = function () {
    return this.activeHandleIndex;
  };

  TransformBox.prototype.setActiveHandleIndex = function (activeHandleIndex) {
    this.activeHandleIndex = activeHandleIndex;
  };

  TransformBox.prototype.getActiveHandlePoint = function (cornerCoords) {
    if (cornerCoords == null) cornerCoords = this.cornerCoords;
    if (this.activeHandleIndex === HANDLE.CUSTOM_PIVOT) return this.cursorPos;
    return this.getHandlePoints(cornerCoords)[this.activeHandleIndex];
  };

  TransformBox.prototype.setActiveHandleFromDocPoint = function (docPoint) {
    if (this.activeHandleIndex === HANDLE.CUSTOM_PIVOT) {
      this.cursorPos = docPoint.clone();
      return;
    }
    const activeHandlePoint = this.getActiveHandlePoint();
    const translateMatrix = new Matrix2D(
      1,
      0,
      0,
      1,
      docPoint.x - activeHandlePoint.x,
      docPoint.y - activeHandlePoint.y,
    );
    transformCoordPairs(this.cornerCoords, translateMatrix, this.cornerCoords);
  };

  TransformBox.prototype.ensureRotateCursors = function () {
    const icon = getRotateCursorImage();
    if (this.rotateCursorBitmaps) {
      if (!icon || typeof this.rotateCursorBitmaps[0].pixelSource !== "string") return;
      this.rotateCursorBitmaps = null;
    }
    this.rotateCursorBitmaps = [];
    for (let cursorIdx = 0; cursorIdx < 8; cursorIdx++) {
      const angle = -45 - cursorIdx * 45;
      if (icon) {
        this.rotateCursorBitmaps.push(buildRotateCursorBitmap(icon, -0.5, -0.5, angle));
      } else {
        this.rotateCursorBitmaps.push(
          buildRotatedThumbnailSvg(0, globalThis.getIconUrl("rotate"), -0.5, -0.5, angle),
        );
      }
    }
  };

  TransformBox.prototype.getHandleCursor = function (docPoint, zoomScale, suppressMoveCursor) {
    const hitIndex = this.hitTestHandle(docPoint, zoomScale);
    if (hitIndex === HANDLE.CUSTOM_PIVOT) return "default";
    if (hitIndex === HANDLE.INTERIOR) {
      if (suppressMoveCursor) return null;
      return !this.allowInteriorMove ? "move" : null;
    }
    if (hitIndex === -1 || hitIndex === HANDLE.CENTER) return null;
    if (hitIndex === HANDLE.ROTATE) {
      this.ensureRotateCursors();
      const rotateVector = this.getActiveHandlePoint().subtract(docPoint);
      let cursorAngle = 90 - (Math.atan2(rotateVector.y, rotateVector.x) * 180) / Math.PI;
      let cursorSlot = Math.round(8 * (cursorAngle / 360));
      cursorSlot = (cursorSlot + 8) % 8;
      return this.rotateCursorBitmaps[cursorSlot];
    }
    let cursorAngle = RESIZE_CURSOR_ANGLES[hitIndex];
    const homography = cornersToHomography(this.cornerCoords);
    cursorAngle += (Math.atan2(-homography[3], homography[0]) * 180) / Math.PI;
    let cursorSlot = Math.round(8 * (cursorAngle / 360));
    cursorSlot = (cursorSlot + 8) % 8;
    return RESIZE_CURSOR_NAMES[cursorSlot] + "-resize";
  };

  TransformBox.prototype.docPointToNormalized = function (docPoint, cornerCoords) {
    const inverseHomography = invert(
      cornersToHomography(cornerCoords),
    );
    const normalizedXY = new Float64Array(2);
    homographyTransformXY(docPoint.x, docPoint.y, inverseHomography, normalizedXY);
    return new Point(normalizedXY[0], normalizedXY[1]);
  };

  TransformBox.prototype.containsDocPoint = function (docPoint) {
    const normalizedPoint = this.docPointToNormalized(docPoint, this.cornerCoords);
    return (
      0 <= normalizedPoint.x &&
      normalizedPoint.x <= 1 &&
      0 <= normalizedPoint.y &&
      normalizedPoint.y <= 1
    );
  };

  TransformBox.prototype.onMouseDown = function (
    doc,
    appData,
    keyboard,
    docPoint,
    aspectRatio,
    shiftKeyAtMouseDown,
  ) {
    this.shiftKeyAtMouseDown = shiftKeyAtMouseDown;
    this.pointerDocPoint = docPoint;
    const zoomScale = doc.pathViewport.zoomScale;
    let hitIndex;
    if (this.cornerCoords == null) {
      docPoint = snapPointToGuides(doc, docPoint, appData);
    }
    this.dragAnchorPoint = docPoint.clone();
    if (this.cornerCoords == null) {
      this.dragAnchorPoint.offset(1, 1);
      const aspectScale = aspectRatio == null ? 1 : 1 / aspectRatio;
      this.cornerCoords = [
        docPoint.x,
        docPoint.y,
        docPoint.x + 1,
        docPoint.y,
        docPoint.x + 1,
        docPoint.y + aspectScale,
        docPoint.x,
        docPoint.y + aspectScale,
      ];
      hitIndex = HANDLE.BOTTOM_RIGHT;
    } else {
      hitIndex = this.hitTestHandle(docPoint, zoomScale);
      if (0 <= hitIndex && hitIndex <= HANDLE.BOTTOM_RIGHT) {
        this.dragAnchorPoint = this.getHandlePoints(this.cornerCoords)[hitIndex];
      }
    }
    this.dragStartCornerCoords = this.cornerCoords.slice(0);
    this.dragHandleIndex = hitIndex;
    this.redrawOverlay(doc, appData);
    this.scaleOriginPoint = this.getActiveHandlePoint();
    return hitIndex !== -1;
  };

  TransformBox.prototype.hitTestHandle = function (docPoint, zoomScale) {
    let hitIndex = -1;
    const handlePoints = this.getHandlePoints();
    const hitRadius = (6 * getDevicePixelRatio()) / zoomScale;
    if (Point.dist(this.getActiveHandlePoint(), docPoint) < hitRadius) {
      hitIndex = HANDLE.CUSTOM_PIVOT;
    }
    if (hitIndex === -1) {
      for (let handleIdx = 0; handleIdx < handlePoints.length; handleIdx++) {
        if (handleIdx !== HANDLE.CENTER && Point.dist(handlePoints[handleIdx], docPoint) < hitRadius) {
          hitIndex = handleIdx;
        }
      }
    }
    if (hitIndex === -1 || this.handleConstraintMode === CONSTRAINT.INTERIOR_HIT_ONLY) {
      if (this.containsDocPoint(docPoint)) {
        if (this.allowInteriorMove) hitIndex = HANDLE.INTERIOR;
      } else {
        const normalizedPoint = this.docPointToNormalized(docPoint, this.cornerCoords);
        const paddedUnitRect = new Rect(0, 0, 1, 1);
        paddedUnitRect.inflate(0.2, 0.2);
        hitIndex =
          paddedUnitRect.containsPoint(normalizedPoint) &&
          this.handleConstraintMode !== CONSTRAINT.DISABLE_CTRL
            ? HANDLE.ROTATE
            : HANDLE.INTERIOR;
      }
    }
    return hitIndex;
  };

  TransformBox.prototype.onMouseMove = function (doc, appData, keyboard, docPoint) {
    if (this.dragHandleIndex === -1) return;
    this.pointerDocPoint = docPoint;
    const modifiers = {
      shift: keyboard.isPressed(KeyboardHandler.Shift),
      alt: keyboard.isPressed(KeyboardHandler.Alt),
      ctrl: keyboard.isPressed(KeyboardHandler.Ctrl),
    };
    const zoomScale = doc.pathViewport.zoomScale;
    const snappedAnchorPoint = snapPointToGuides(
      doc,
      this.dragAnchorPoint,
      appData,
    );
    const snappedDocPoint = snapPointToGuides(doc, docPoint, appData);
    let guideSnapResult = null;
    let dragBoundsRect = null;

    if (this.dragHandleIndex === HANDLE.CUSTOM_PIVOT) {
      applyCustomPivotDrag(this, snappedAnchorPoint, snappedDocPoint, zoomScale, modifiers.shift);
    } else if (this.dragHandleIndex === HANDLE.INTERIOR) {
      const moveResult = applyInteriorMoveDrag(
        this,
        doc,
        appData,
        docPoint,
        this.dragAnchorPoint,
      );
      guideSnapResult = moveResult.guideSnapResult;
      dragBoundsRect = moveResult.dragBoundsRect;
    } else if (this.dragHandleIndex === HANDLE.ROTATE) {
      applyRotateDrag(this, docPoint, this.dragAnchorPoint, modifiers.shift);
    } else {
      applyScaleOrPerspectiveDrag(
        this,
        snappedAnchorPoint,
        snappedDocPoint,
        modifiers,
      );
    }

    this.redrawOverlay(doc, appData);
    if (guideSnapResult) {
      updateLayerDragPositions(doc, dragBoundsRect, guideSnapResult);
    }
  };

  TransformBox.prototype.isAxisAlignedQuad = function () {
    const cornerCoords = this.cornerCoords;
    return (
      (Math.abs(cornerCoords[1] - cornerCoords[3]) < 1e-6 &&
        Math.abs(cornerCoords[2] - cornerCoords[4]) < 1e-6) ||
      (Math.abs(cornerCoords[0] - cornerCoords[2]) < 1e-6 &&
        Math.abs(cornerCoords[3] - cornerCoords[5]) < 1e-6)
    );
  };

  TransformBox.prototype.onMouseUp = function (doc) {
    this.dragHandleIndex = -1;
    this.pointerDocPoint = null;
    doc.toolOverlayState.snapGuides = null;
    doc.toolOverlayState.floatingBitmapOverlays = [];
    doc.dirty = true;
  };

  TransformBox.prototype.onKeyEvent = function (doc, appData, keyboard) {
    const arrowDelta = keyboard.getArrowMovement();
    if (arrowDelta.x || arrowDelta.y) {
      const translateMatrix = new Matrix2D(1, 0, 0, 1, arrowDelta.x, arrowDelta.y);
      transformCoordPairs(this.cornerCoords, translateMatrix, this.cornerCoords);
      this.redrawOverlay(doc, appData);
      return true;
    }
    return false;
  };

  TransformBox.prototype.getHandlePoints = function (cornerCoords) {
    if (cornerCoords == null) cornerCoords = this.cornerCoords;
    const bottomLeftDeltaX = cornerCoords[6] - cornerCoords[0];
    const bottomLeftDeltaY = cornerCoords[7] - cornerCoords[1];
    const topRightDeltaX = cornerCoords[4] - cornerCoords[2];
    const topRightDeltaY = cornerCoords[5] - cornerCoords[3];
    const edgeCoords = [
      cornerCoords[0],
      cornerCoords[1],
      cornerCoords[2],
      cornerCoords[3],
      cornerCoords[0] + bottomLeftDeltaX / 2,
      cornerCoords[1] + bottomLeftDeltaY / 2,
      cornerCoords[2] + topRightDeltaX / 2,
      cornerCoords[3] + topRightDeltaY / 2,
      cornerCoords[6],
      cornerCoords[7],
      cornerCoords[4],
      cornerCoords[5],
    ];
    const handlePoints = [];
    for (let rowIdx = 0; rowIdx < 3; rowIdx++) {
      const coordOffset = rowIdx * 4;
      const cornerX = edgeCoords[coordOffset];
      const cornerY = edgeCoords[coordOffset + 1];
      const adjacentX = edgeCoords[coordOffset + 2];
      const adjacentY = edgeCoords[coordOffset + 3];
      handlePoints.push(new Point(cornerX, cornerY));
      handlePoints.push(
        new Point(cornerX + (adjacentX - cornerX) / 2, cornerY + (adjacentY - cornerY) / 2),
      );
      handlePoints.push(new Point(adjacentX, adjacentY));
    }
    return handlePoints;
  };

  TransformBox.prototype.redrawOverlay = function (doc, appData, skipHandleCoords) {
    if (skipHandleCoords == null) skipHandleCoords = false;
    const handlePoints = this.getHandlePoints();
    const topLeft = handlePoints[HANDLE.TOP_LEFT];
    const topRight = handlePoints[HANDLE.TOP_RIGHT];
    const bottomLeft = handlePoints[HANDLE.BOTTOM_LEFT];
    const bottomRight = handlePoints[HANDLE.BOTTOM_RIGHT];
    doc.toolOverlayState.overlayTransform = {
      commands: [],
      coords: [],
    };
    doc.toolOverlayState.overlayTransform.commands.push("M", "L", "L", "L", "Z");
    doc.toolOverlayState.overlayTransform.coords.push(
      topLeft.x,
      topLeft.y,
      topRight.x,
      topRight.y,
      bottomRight.x,
      bottomRight.y,
      bottomLeft.x,
      bottomLeft.y,
    );
    if (this.showThirdsGrid) {
      // The quad on its own, captured before the grid lines join it: the
      // overlay pass shades everything outside it, so the area the crop will
      // discard reads as dimmed.
      doc.toolOverlayState.discardShadeOverlay = {
        commands: doc.toolOverlayState.overlayTransform.commands.slice(0),
        coords: doc.toolOverlayState.overlayTransform.coords.slice(0),
      };
      appendThirdsGridLines(
        doc.toolOverlayState.overlayTransform,
        topLeft,
        topRight,
        bottomLeft,
        bottomRight,
      );
    }
    doc.pathViewport.dimensionOverlay = new Rect(
      0,
      0,
      Point.dist(handlePoints[HANDLE.TOP_LEFT], handlePoints[HANDLE.TOP_RIGHT]),
      Point.dist(handlePoints[HANDLE.TOP_LEFT], handlePoints[HANDLE.BOTTOM_LEFT]),
    );
    if (this.dragHandleIndex !== -1 && this.dragHandleIndex < 9 && this.pointerDocPoint) {
      const screenPoint = doc.pathViewport.docToScreenPoint(
        this.pointerDocPoint.x,
        this.pointerDocPoint.y,
      );
      ToolBase.drawDimensionOverlay(
        screenPoint.x + 10,
        screenPoint.y - 10,
        doc.pathViewport.dimensionOverlay,
        doc,
        appData,
      );
    }
    if (!skipHandleCoords) {
      doc.toolOverlayState.squareMarkerCoords = [];
      for (let handleIdx = 0; handleIdx < handlePoints.length; handleIdx++) {
        if (handleIdx !== HANDLE.CENTER) {
          doc.toolOverlayState.squareMarkerCoords.push(handlePoints[handleIdx].x, handlePoints[handleIdx].y);
        }
      }
      const activeHandlePoint = this.getActiveHandlePoint();
      doc.toolOverlayState.squareMarkerCoords.push(activeHandlePoint.x, activeHandlePoint.y);
    }
    doc.dirty = true;
  };

  TransformBox.prototype.clear = function (doc) {
    doc.pathViewport.dimensionOverlay = null;
    doc.toolOverlayState.snapGuides = null;
    doc.toolOverlayState.overlayTransform = null;
    doc.toolOverlayState.discardShadeOverlay = null;
    doc.toolOverlayState.squareMarkerCoords = [];
    doc.dirty = true;
  };
}

function applyCustomPivotDrag(box, snappedAnchorPoint, snappedDocPoint, zoomScale, shiftPressed) {
  const handlePointsForHover = box.getHandlePoints();
  let nearestHandleIdx = -1;
  for (let handleIdx = 0; handleIdx < handlePointsForHover.length; handleIdx++) {
    if (Point.dist(handlePointsForHover[handleIdx], snappedDocPoint) * zoomScale < 10) {
      nearestHandleIdx = handleIdx;
    }
  }
  box.activeHandleIndex = nearestHandleIdx === -1 ? HANDLE.CUSTOM_PIVOT : nearestHandleIdx;
  box.cursorPos = shiftPressed
    ? constrainEndpointToAxis(snappedAnchorPoint, snappedDocPoint)
    : snappedDocPoint.clone();
}

function applyInteriorMoveDrag(box, doc, appData, docPoint, dragAnchorPoint) {
  const dragBoundsRect = boundsFromCoordPairs(box.dragStartCornerCoords);
  const boundsOriginX = dragBoundsRect.x;
  const boundsOriginY = dragBoundsRect.y;
  dragBoundsRect.offset(docPoint.x - dragAnchorPoint.x, docPoint.y - dragAnchorPoint.y);
  if (box.isAxisAlignedQuad()) {
    dragBoundsRect.x = Math.round(dragBoundsRect.x);
    dragBoundsRect.y = Math.round(dragBoundsRect.y);
  }
  const guideSnapResult = snapRectCornersToGuides(doc, dragBoundsRect, appData);
  const translateMatrix = new Matrix2D(
    1,
    0,
    0,
    1,
    dragBoundsRect.x - boundsOriginX + guideSnapResult[0],
    dragBoundsRect.y - boundsOriginY + guideSnapResult[1],
  );
  transformCoordPairs(
    box.dragStartCornerCoords,
    translateMatrix,
    box.cornerCoords,
  );
  return { guideSnapResult, dragBoundsRect };
}

function applyRotateDrag(box, docPoint, dragAnchorPoint, shiftPressed) {
  const rotateCenter = box.getActiveHandlePoint(box.dragStartCornerCoords);
  const currentVector = rotateCenter.subtract(docPoint);
  const startVector = rotateCenter.subtract(dragAnchorPoint);
  const currentAngle = Math.atan2(currentVector.y, currentVector.x);
  const startAngle = Math.atan2(startVector.y, startVector.x);
  const rotateMatrix = new Matrix2D(1, 0, 0, 1, -rotateCenter.x, -rotateCenter.y);
  const snapAngle = Math.PI / 12;
  if (shiftPressed) {
    rotateMatrix.rotate(Math.round((startAngle - currentAngle) / snapAngle) * snapAngle);
  } else {
    rotateMatrix.rotate(startAngle - currentAngle);
  }
  rotateMatrix.translate(rotateCenter.x, rotateCenter.y);
  transformCoordPairs(
    box.dragStartCornerCoords,
    rotateMatrix,
    box.cornerCoords,
  );
}

function resolveDragModifiers(box, activeDragHandle, modifiers) {
  let { shift: shiftPressed, alt: altPressed, ctrl: ctrlPressed } = modifiers;
  const corner = isCornerHandleIndex(activeDragHandle);
  if (box.handleConstraintMode === CONSTRAINT.FORCE_ALL_MODIFIERS) {
    if (corner) shiftPressed = altPressed = ctrlPressed = true;
  } else if (
    box.handleConstraintMode === CONSTRAINT.FORCE_CTRL_UNLESS_SHIFT_DOWN &&
    corner &&
    box.shiftKeyAtMouseDown !== true
  ) {
    ctrlPressed = true;
  }
  if (box.handleConstraintMode === CONSTRAINT.DISABLE_CTRL) ctrlPressed = false;
  return { shiftPressed, altPressed, ctrlPressed };
}

function applyScaleOrPerspectiveDrag(box, snappedAnchorPoint, snappedDocPoint, modifiers) {
  const startCornerCoords = box.dragStartCornerCoords;
  const activeDragHandle = box.dragHandleIndex;
  const { shiftPressed, altPressed, ctrlPressed } = resolveDragModifiers(
    box,
    activeDragHandle,
    modifiers,
  );
  const corner = isCornerHandleIndex(activeDragHandle);
  let nextCornerCoords;

  if (box.usePerspectiveCornerDrag && corner && ctrlPressed) {
    nextCornerCoords = computePerspectiveCornerDrag(
      startCornerCoords,
      activeDragHandle,
      snappedDocPoint,
      shiftPressed,
      altPressed,
    );
  } else if (corner && altPressed) {
    nextCornerCoords = computeScaleFromOriginDrag(
      startCornerCoords,
      box.scaleOriginPoint,
      snappedAnchorPoint,
      snappedDocPoint,
      shiftPressed,
    );
  } else {
    nextCornerCoords = computeFreeScaleSkewDrag(
      box,
      startCornerCoords,
      activeDragHandle,
      snappedDocPoint,
      snappedAnchorPoint,
      altPressed,
      shiftPressed,
      ctrlPressed,
    );
  }

  if (TransformBox.isConvexTransformQuad(nextCornerCoords)) {
    box.cornerCoords = nextCornerCoords;
  }
}

function computePerspectiveCornerDrag(
  startCornerCoords,
  activeDragHandle,
  snappedDocPoint,
  shiftPressed,
  altPressed,
) {
  const draggedCornerIdx = CORNER_TO_COORD_INDEX[activeDragHandle];
  let oppositeCornerIdx = -1;
  let draggedX = snappedDocPoint.x;
  let draggedY = snappedDocPoint.y;

  if (shiftPressed) {
    const adjacentCornerIdxA = (draggedCornerIdx + 6) & 7;
    const adjacentCornerIdxB = (draggedCornerIdx + 10) & 7;
    const projectionA = projectOntoSegment(
      startCornerCoords[draggedCornerIdx],
      startCornerCoords[draggedCornerIdx + 1],
      startCornerCoords[adjacentCornerIdxA],
      startCornerCoords[adjacentCornerIdxA + 1],
      snappedDocPoint.x,
      snappedDocPoint.y,
    );
    const projectionB = projectOntoSegment(
      startCornerCoords[draggedCornerIdx],
      startCornerCoords[draggedCornerIdx + 1],
      startCornerCoords[adjacentCornerIdxB],
      startCornerCoords[adjacentCornerIdxB + 1],
      snappedDocPoint.x,
      snappedDocPoint.y,
    );
    const nearerProjection = projectionA[2] < projectionB[2] ? projectionA : projectionB;
    draggedX = nearerProjection[0];
    draggedY = nearerProjection[1];
    if (altPressed) {
      oppositeCornerIdx = projectionA[2] < projectionB[2] ? adjacentCornerIdxA : adjacentCornerIdxB;
    }
  } else if (altPressed) {
    oppositeCornerIdx = (draggedCornerIdx + 4) & 7;
  }

  const nextCornerCoords = startCornerCoords.slice(0);
  if (oppositeCornerIdx !== -1) {
    const oppositeX = startCornerCoords[oppositeCornerIdx];
    const oppositeY = startCornerCoords[oppositeCornerIdx + 1];
    const midpointX = (startCornerCoords[draggedCornerIdx] + oppositeX) / 2;
    const midpointY = (startCornerCoords[draggedCornerIdx + 1] + oppositeY) / 2;
    nextCornerCoords[oppositeCornerIdx] = midpointX - (draggedX - midpointX);
    nextCornerCoords[oppositeCornerIdx + 1] = midpointY - (draggedY - midpointY);
  }
  nextCornerCoords[draggedCornerIdx] = draggedX;
  nextCornerCoords[draggedCornerIdx + 1] = draggedY;
  return nextCornerCoords;
}

function computeScaleFromOriginDrag(
  startCornerCoords,
  scaleOrigin,
  snappedAnchorPoint,
  snappedDocPoint,
  shiftPressed,
) {
  const originX = scaleOrigin.x;
  const originY = scaleOrigin.y;
  const startDeltaX = snappedAnchorPoint.x - originX;
  const startDeltaY = snappedAnchorPoint.y - originY;
  let scaleX = 1;
  let scaleY = 1;
  if (Math.abs(startDeltaX) >= 1) scaleX = (snappedDocPoint.x - originX) / startDeltaX;
  if (Math.abs(startDeltaY) >= 1) scaleY = (snappedDocPoint.y - originY) / startDeltaY;
  if (shiftPressed) scaleX = scaleY = (scaleX + scaleY) / 2;
  const scaleMatrix = new Matrix2D();
  scaleMatrix.translate(-originX, -originY);
  scaleMatrix.scale(scaleX, scaleY);
  scaleMatrix.translate(originX, originY);
  const nextCornerCoords = startCornerCoords.slice(0);
  transformCoordPairs(nextCornerCoords, scaleMatrix, nextCornerCoords);
  return nextCornerCoords;
}

function computeFreeScaleSkewDrag(
  box,
  startCornerCoords,
  activeDragHandle,
  snappedDocPoint,
  snappedAnchorPoint,
  altPressed,
  shiftPressed,
  ctrlPressed,
) {
  if (box.isAxisAlignedQuad()) {
    snappedDocPoint.x = Math.round(snappedDocPoint.x);
    snappedDocPoint.y = Math.round(snappedDocPoint.y);
  }
  const oppositeHandleIdx = oppositeHandleIndex(activeDragHandle);
  const normalizedGridPoints = unitSquareNormalizedGrid();
  const scaleOrigin = box.scaleOriginPoint;
  const currentNormalized = box.docPointToNormalized(snappedDocPoint, startCornerCoords);
  const startNormalized = box.docPointToNormalized(snappedAnchorPoint, startCornerCoords);
  const scalePivot =
    altPressed &&
    (box.activeHandleIndex === HANDLE.CENTER || box.activeHandleIndex === HANDLE.CUSTOM_PIVOT)
      ? box.docPointToNormalized(scaleOrigin, startCornerCoords)
      : normalizedGridPoints[oppositeHandleIdx];
  const scaleMatrix = new Matrix2D();
  const skewMatrix = new Matrix2D();
  let scaleX = (currentNormalized.x - scalePivot.x) / (startNormalized.x - scalePivot.x);
  if (scaleX === 0) scaleX = 1e-4;
  let scaleY = (currentNormalized.y - scalePivot.y) / (startNormalized.y - scalePivot.y);
  if (scaleY === 0) scaleY = 1e-4;
  if (box.clampScalePositive) {
    scaleX = Math.max(scaleX, 0);
    scaleY = Math.max(scaleY, 0);
  }
  if (isCornerHandleIndex(activeDragHandle)) {
    if (shiftPressed || box.uniformCornerScale) scaleMatrix.scale(scaleX, scaleX);
    else scaleMatrix.scale(scaleX, scaleY);
  }
  if (isEdgeHandleIndex(activeDragHandle)) {
    const uniformEdgeScale = box.uniformCornerScale;
    if (activeDragHandle === HANDLE.TOP_EDGE || activeDragHandle === HANDLE.BOTTOM_EDGE) {
      scaleMatrix.scale(uniformEdgeScale ? scaleY : 1, scaleY);
    } else {
      scaleMatrix.scale(scaleX, uniformEdgeScale ? scaleX : 1);
    }
    if (box.allowSkewFromCorners && ctrlPressed) {
      if (activeDragHandle === HANDLE.TOP_EDGE || activeDragHandle === HANDLE.BOTTOM_EDGE) {
        skewMatrix.c = (currentNormalized.x - scalePivot.x) / (currentNormalized.y - scalePivot.y);
      } else {
        // Vertical shear on a left/right edge drag: Matrix2D.b sets y' += b*x.
        skewMatrix.b = (currentNormalized.y - scalePivot.y) / (currentNormalized.x - scalePivot.x);
      }
    }
  }
  const compositeMatrix = new Matrix2D();
  compositeMatrix.translate(-scalePivot.x, -scalePivot.y);
  compositeMatrix.concat(scaleMatrix);
  compositeMatrix.concat(skewMatrix);
  compositeMatrix.translate(scalePivot.x, scalePivot.y);
  const nextCornerCoords = [0, 0, 1, 0, 1, 1, 0, 1];
  transformCoordPairs(nextCornerCoords, compositeMatrix, nextCornerCoords);
  const startHomography = cornersToHomography(startCornerCoords);
  transformPointsArray(startHomography, nextCornerCoords);
  return nextCornerCoords;
}

function appendThirdsGridLines(overlayTransform, topLeft, topRight, bottomLeft, bottomRight) {
  const topEdge = topRight.subtract(topLeft);
  const leftEdge = bottomLeft.subtract(topLeft);
  const rightEdge = bottomRight.subtract(topRight);
  const bottomEdge = bottomRight.subtract(bottomLeft);
  for (let thirdIdx = 0; thirdIdx < 3; thirdIdx++) {
    overlayTransform.commands.push("M", "L", "M", "L");
    const thirdFraction = (thirdIdx + 1) * 0.25;
    overlayTransform.coords.push(
      topLeft.x + topEdge.x * thirdFraction,
      topLeft.y + topEdge.y * thirdFraction,
      bottomLeft.x + bottomEdge.x * thirdFraction,
      bottomLeft.y + bottomEdge.y * thirdFraction,
    );
    overlayTransform.coords.push(
      topLeft.x + leftEdge.x * thirdFraction,
      topLeft.y + leftEdge.y * thirdFraction,
      topRight.x + rightEdge.x * thirdFraction,
      topRight.y + rightEdge.y * thirdFraction,
    );
  }
}

function installWarpMeshPrototype() {
  WarpMesh.prototype.cloneWarpDescriptor = function () {
    return JSON.parse(JSON.stringify(this.warpDescriptor));
  };

  WarpMesh.prototype.setWarpDescriptor = function (warpDescriptor) {
    this.warpDescriptor = JSON.parse(JSON.stringify(warpDescriptor));
  };

  WarpMesh.prototype.containsDocPoint = function () {
    return true;
  };

  WarpMesh.prototype.getHandleCursor = function (docPoint, zoomScale) {
    const hitIndex = this.hitTestHandle(docPoint, zoomScale);
    if (hitIndex === -1) return "default";
    return "pointer";
  };

  WarpMesh.prototype.onMouseDown = function (doc, appData, keyboard, docPoint) {
    this.dragHandleIndex = this.hitTestHandle(docPoint, doc.pathViewport.zoomScale);
    return this.dragHandleIndex !== -1;
  };

  WarpMesh.prototype.hitTestHandle = function (docPoint, zoomScale) {
    let hitIndex = -1;
    const hitRadius = 20 * getDevicePixelRatio();
    const controlPoints = this.getWarpControlPointsAsPoints();
    for (let pointIdx = 0; pointIdx < controlPoints.length; pointIdx++) {
      if (Point.dist(controlPoints[pointIdx], docPoint) * zoomScale < hitRadius) {
        hitIndex = pointIdx;
      }
    }
    return hitIndex;
  };

  WarpMesh.prototype.onMouseMove = function (doc, appData, keyboard, docPoint) {
    if (this.dragHandleIndex === -1) return;
    const activeHandleIdx = this.dragHandleIndex;
    const warpPoints = getWarpControlPoints(this.warpDescriptor);
    warpPoints[activeHandleIdx * 2] = docPoint.x;
    warpPoints[activeHandleIdx * 2 + 1] = docPoint.y;
    pointsToCustomEnvelope(warpPoints, this.warpDescriptor);
  };

  WarpMesh.prototype.onMouseUp = function (doc) {
    this.dragHandleIndex = -1;
    doc.dirty = true;
  };

  WarpMesh.prototype.onKeyEvent = function (doc, appData, keyboard) {
    const arrowDelta = keyboard.getArrowMovement();
    if (arrowDelta.x || arrowDelta.y) {
      const translateMatrix = new Matrix2D(1, 0, 0, 1, arrowDelta.x, arrowDelta.y);
      const warpPoints = getWarpControlPoints(this.warpDescriptor);
      transformCoordPairs(warpPoints, translateMatrix, warpPoints);
      pointsToCustomEnvelope(warpPoints, this.warpDescriptor);
      this.redrawOverlay(doc);
      return true;
    }
    return false;
  };

  WarpMesh.prototype.getWarpControlPointsAsPoints = function () {
    const warpPoints = getWarpControlPoints(this.warpDescriptor);
    const controlPoints = [];
    for (let coordIdx = 0; coordIdx < warpPoints.length; coordIdx += 2) {
      controlPoints.push(new Point(warpPoints[coordIdx], warpPoints[coordIdx + 1]));
    }
    return controlPoints;
  };

  WarpMesh.prototype.redrawOverlay = function (doc) {
    const controlPoints = this.getWarpControlPointsAsPoints();
    doc.toolOverlayState.overlayTransform = {
      commands: [],
      coords: [],
    };
    doc.toolOverlayState.overlayTransform.commands.push("M", "C", "C", "C", "C");
    for (let orderIdx = 0; orderIdx < WARP_ENVELOPE_RING.length; orderIdx++) {
      const point = controlPoints[WARP_ENVELOPE_RING[orderIdx]];
      doc.toolOverlayState.overlayTransform.coords.push(point.x, point.y);
    }
    doc.toolOverlayState.overlayTransform.commands.push(
      "M",
      "L",
      "L",
      "M",
      "L",
      "L",
      "M",
      "L",
      "L",
      "M",
      "L",
      "L",
    );
    for (let orderIdx = 0; orderIdx < WARP_CROSSBAR_ORDER.length; orderIdx++) {
      const point = controlPoints[WARP_CROSSBAR_ORDER[orderIdx]];
      doc.toolOverlayState.overlayTransform.coords.push(point.x, point.y);
    }
    doc.toolOverlayState.squareMarkerCoords = [];
    for (let pointIdx = 0; pointIdx < controlPoints.length; pointIdx++) {
      doc.toolOverlayState.squareMarkerCoords.push(
        controlPoints[pointIdx].x,
        controlPoints[pointIdx].y,
      );
    }
    doc.dirty = true;
  };

  WarpMesh.prototype.clear = function (doc) {
    doc.toolOverlayState.overlayTransform = null;
    doc.toolOverlayState.squareMarkerCoords = [];
    doc.dirty = true;
  };
}

/** Raster rotate handle cursor (pixel buffer). SVG data URLs with external xlink fail in WebKit img overlays. */
function buildRotateCursorBitmap(iconImage, spriteCol, spriteRow, angleDeg) {
  const size = 128;
  const devicePixelRatio = getDevicePixelRatio();
  const scale = 0.25 * Math.round(devicePixelRatio);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.translate(size / 2, size / 2);
  ctx.scale(scale, scale);
  ctx.save();
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.drawImage(iconImage, 80 * spriteCol, 80 * spriteRow, 80, 80);
  ctx.restore();
  const imageData = ctx.getImageData(0, 0, size, size);
  return {
    pixelSource: new Uint8Array(imageData.data),
    boundsRect: new Rect(0, 0, size, size),
    hotspot: new Point(64, 64),
  };
}

function buildRotatedThumbnailSvg(showArrow, imageDataUrl, spriteCol, spriteRow, rotationDeg) {
  if (rotationDeg == null) rotationDeg = 0;
  const glowFilterDefs =
    '<defs> \t<filter id="sofGlow" height="300%" width="300%" x="-75%" y="-75%"> \t\t<!-- Thicken out the original shape --> \t<feMorphology operator="dilate" radius="3" in="SourceAlpha" result="thicken" /> \t\t<!-- Use a gaussian blur to create the soft blurriness of the glow -->\t\t<feGaussianBlur in="thicken" stdDeviation="4" result="blurred" />\t\t<!-- Change the colour -->\t\t<feFlood flood-color="rgb(255,255,255)" result="glowColor" />\t\t<!-- Color in the glows -->\t\t<feComposite in="glowColor" in2="blurred" operator="in" result="softGlow_colored" />\t\t<!--\tLayer the effects together -->\t\t<feMerge>\t\t\t<feMergeNode in="softGlow_colored"/>\t\t\t<feMergeNode in="SourceGraphic"/>\t\t</feMerge>\t</filter></defs>';
  let svgMarkup =
    '<svg  xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"  width="128"  height="128"> ' +
    glowFilterDefs +
    '<g transform="translate(64 64) scale(' +
    0.25 * Math.round(getDevicePixelRatio()) +
    ')">';
  if (showArrow === 1) {
    svgMarkup +=
      '<g transform="scale(0.07 0.07) translate(-550 -112)"  style="fill:#ffffff; stroke:#000000; stroke-width:60px;">' +
      '<path d="m 555.1899,112.08836 0,120.71094 0,920.7109 232.42188,-232.42184 111.90429,270.44924 169.76363,-84.8828 -114.09371,-273.8555 320.71481,0 z"/>' +
      "</g>";
  }
  svgMarkup +=
    '<g filter="url(#sofGlow)"><image transform="rotate(' +
    rotationDeg +
    ')" xlink:href="' +
    imageDataUrl +
    '" x="' +
    80 * spriteCol +
    '" y="' +
    80 * spriteRow +
    '" height="80" width="80"/></g></g></svg>';
  const svgUtf8Bytes = new Uint8Array(svgMarkup.length);
  BinaryUtils.encodeUtf8Into(svgMarkup, svgUtf8Bytes, 0);
  const dataUrl = "data:image/svg+xml;base64," + bytesToBase64(svgUtf8Bytes.buffer);
  return {
    pixelSource: dataUrl,
    boundsRect: new Rect(0, 0, 128, 128),
    hotspot: new Point(64, 64),
  };
}
