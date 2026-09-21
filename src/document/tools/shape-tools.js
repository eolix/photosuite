/**
 * Vector shape tools: rectangle, ellipse, line, parametric, custom, and free pen.
 * Built on PolyToolBase; draw into path, shape layer, or pixel fill per tool draw mode.
 */

import { Point, constrainEndpointToAxis } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";

import { Layer } from "../model/layer.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { PathRecordCodec } from "../formats/psd/path-record-codec.js";
import { LayerEffectDefs } from "../formats/psd/effect-defs.js";
import { VectorMask } from "../model/layer-masks.js";
import { TrackerRegistry } from "../../features/trackers/tracker-registry.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { AppEvent } from "../../core/event-bus.js";
import { ToolBase, ToolId } from "../model/tool-base.js";
import { snapPointToGuides, snapRectCornersToGuides, updateLayerDragPositions } from "../model/guide-snapping.js";
import { PolyToolBase } from "./pen-path-tools.js";
import { buildShapePathAction } from "./shape-actions.js";
import { allocBuffer, extractChannel, fillBuffer } from "../../engine/compositing/buffer-utils.js";
import { flattenPathRecordsToPath } from "../../engine/compositing/anti-alias.js";
import { arrowPathRecords, ellipsePathRecords, linePathRecords, rectanglePathRecords, regularPolygonPathRecords, starBurstPathRecords, starPathRecords } from "../../engine/compositing/shape-primitives.js";
import { simplifyPolylineToPathRecords } from "../../engine/compositing/selection-utils.js";
import { countSubpaths, transformPathRecordCoords } from "../../engine/compositing/path-records.js";
import { buildKeyOriginDescriptor, createEmptyKeyOrigin, keyOriginFromShapeDescriptor } from "../../engine/compositing/key-origins.js";


/** Default tool-options bag shared by every shape tool (wire keys preserved). */
function createDefaultShapeToolOptions() {
  return {
    tmode: 1,
    shape: PathRecordCodec.create(),
    pshape: 0,
    binop: 0,
    crad: 0,
    irad: 40,
    length: 4,
    sides: 5,
    width: 5,
    tolr: 5,
    tsiz: 300,
    cstr: {
      constraintMode: 0,
    },
  };
}

function dispatchCursorOverlay(dispatcher, cursorOverlayId) {
  const cursorEvent = new AppEvent(EventType.uiDispatch, true);
  cursorEvent.data = {
    dispatchKind: UiCommand.splashOptionsUpdate,
    cursorOverlayId,
  };
  dispatcher.dispatch(cursorEvent);
}

/**
 * Open the create-shape size dialog for a click without drag.
 * Payload keys are read by CreateShapeDialog.
 */
function openCreateShapeDialog(tool, doc, dispatcher, appData, keyboard, endPoint) {
  const createShapeEvent = new AppEvent(EventType.uiDispatch);
  createShapeEvent.data = {
    dispatchKind: UiCommand.dispatchAppDialogRouter,
    dialogRouteId: "createshape",
    onConfirm: tool.onCreateShapeDialogConfirm.bind(tool),
    toolNameKey: tool.name,
    confirmArgs: [doc, dispatcher, appData, keyboard, endPoint],
  };
  dispatcher.dispatch(createShapeEvent);
}

/** Commit a finished drag: path boolean, new shape layer, or raster fill. */
function commitFinishedShapeStroke(tool, doc, dispatcher, appData, endPoint, keyboard) {
  const booleanOp = tool.toolOptions.binop;
  const drawMode = tool.toolOptions.tmode;
  const previewResult = tool.buildShapePreviewPaths(doc, endPoint, keyboard);
  const pathRecords = previewResult[0];

  if (drawMode == 0 && pathRecords.length > 2) {
    pathRecords[2].fillRule = [1, 2, 3, 0][booleanOp];
    const pathTuple = doc.getPaths(true);
    const pathList = pathTuple[0];
    const selectedPathIndices = pathTuple[1];
    const activePath = pathList[selectedPathIndices.pop()];
    const vectorMask = activePath.add.vmsk;
    const keyOrigins = activePath.add.vogk;
    const maskBefore = vectorMask.clone();
    const maskAfter = vectorMask.clone();
    const keyOriginsBeforeJson = JSON.stringify(keyOrigins);
    maskAfter.pathRecords = maskAfter.pathRecords.concat(pathRecords.slice(2));
    maskAfter.C = [countSubpaths(maskAfter.pathRecords) - 1];
    const keyOriginEntry = keyOriginFromShapeDescriptor(previewResult[1]);
    keyOrigins.push(keyOriginEntry ? keyOriginEntry : createEmptyKeyOrigin());
    tool.applyPathMaskToLayer(doc, activePath.idx, maskAfter, keyOrigins);
    tool.pushPathHistory(
      doc,
      tool.name,
      activePath.idx,
      maskBefore,
      maskAfter,
      null,
      keyOriginsBeforeJson,
      JSON.stringify(keyOrigins),
    );
    return;
  }

  if (drawMode == 1) {
    tool.dispatchShapePathAction(doc, dispatcher, appData, previewResult);
    return;
  }

  if (drawMode == 2) {
    const rasterMask = new VectorMask();
    rasterMask.pathRecords = rasterMask.pathRecords.concat(pathRecords.slice(2));
    const maskChannel = rasterMask.getMask();
    const rgbaBuffer = allocBuffer(maskChannel.rect.area() * 4);
    fillBuffer(
      rgbaBuffer,
      (appData.colorInt & 255) << 16 |
        (appData.colorInt >> 8 & 255) << 8 |
        (appData.colorInt >> 16 & 255) << 0,
    );
    extractChannel(maskChannel.channel, rgbaBuffer, 3);
    const drawEvent = new AppEvent(EventType.documentAction, true);
    drawEvent.routingChannel = ToolId.TOOL_BRUSH;
    drawEvent.data = {
      actionKind: "draw",
      clipboardPixelPayload: {
        buffer: rgbaBuffer,
        rect: maskChannel.rect.clone(),
      },
      historyLabelKey: tool.name,
    };
    dispatcher.dispatch(drawEvent);
  }
}

function clearShapeDragState(tool, doc) {
  tool.shapeStartPoint = null;
  doc.toolOverlayState.overlayTransform = null;
  doc.toolOverlayState.snapGuides = null;
  doc.toolOverlayState.floatingBitmapOverlays = [];
  doc.pathViewport.dimensionOverlay = null;
  doc.dirty = true;
}

/** Adjust parametric shape options from arrow keys; returns payload or null. */
function parametricOptionDeltaFromArrows(toolOptions, arrowDelta) {
  let optionKey = null;
  let optionValue = null;

  if (arrowDelta.y != 0) {
    const deltaY = -arrowDelta.y;
    const shapeKind = toolOptions.pshape;
    if (shapeKind < 2) {
      optionKey = "sides";
      optionValue = Math.max(3, Math.min(100, toolOptions.sides + deltaY));
    } else if (shapeKind == 2) {
      optionKey = "width";
      optionValue = Math.max(1, Math.min(100, toolOptions.width + deltaY));
    } else if (shapeKind == 3) {
      optionKey = "length";
      optionValue = Math.max(4, Math.min(40, toolOptions.length + deltaY));
    }
  }

  if (arrowDelta.x != 0) {
    optionKey = "pshape";
    optionValue = Math.max(0, Math.min(3, toolOptions.pshape + arrowDelta.x));
  }

  if (!optionKey) return null;
  return { optionKey, optionValue };
}

export function ShapeToolBase(labelKey, toolId, iconPath, snapShapeToPixelGrid) {
  PolyToolBase.call(this, labelKey, toolId, iconPath);
  this.toolOptions = createDefaultShapeToolOptions();
  this.snapShapeToPixelGrid = snapShapeToPixelGrid;
  this.shapeStartPoint = null;
  this.spacePanOffset = null;
  this.shapePathCoords = null;
}

function installShapeToolBasePrototype() {
  ShapeToolBase.prototype.wantsInput = function(pointerState) {
    return pointerState.isDown && this.id != ToolId.TOOL_FREE_PEN;
  };

  ShapeToolBase.prototype.enable = function(doc, dispatcher, appData, keyboard, embedInDialog) {
    this.doc = appData;
    dispatchCursorOverlay(dispatcher, "crosshair");
  };

  ShapeToolBase.prototype.buildShapePaths = function(startPoint, endPoint, isShiftPressed, shapePathCoords) {};

  ShapeToolBase.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
    const drawMode = this.toolOptions.tmode;
    if (drawMode != 2) this.ensurePathEditingPrefs(dispatcher, appData);
    if (drawMode == 2 && !doc.ensureLayerEditableForTools()) return;
    let docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
    docPoint = snapPointToGuides(doc, docPoint, appData);
    this.shapePathCoords = [docPoint.x, docPoint.y];
    this.shapeStartPoint = docPoint;
    this.spacePanOffset = new Point(0, 0);
  };

  ShapeToolBase.prototype.buildShapePreviewPaths = function(doc, pointerPoint, keyboard) {
    let shapePoints = [this.shapeStartPoint.clone(), pointerPoint.clone()];
    if (this.snapShapeToPixelGrid) {
      shapePoints = ShapeToolBase.constrainShapePoints(
        shapePoints[0],
        shapePoints[1],
        keyboard,
        true,
        this.toolOptions.cstr,
      );
    }
    if (doc) {
      doc.pathViewport.dimensionOverlay = new Rect(
        shapePoints[0].x,
        shapePoints[0].y,
        shapePoints[1].x - shapePoints[0].x,
        shapePoints[1].y - shapePoints[0].y,
      );
    }
    return this.buildShapePaths(
      shapePoints[0],
      shapePoints[1],
      keyboard.isPressed(KeyboardHandler.Shift),
      this.shapePathCoords,
    );
  };

  ShapeToolBase.prototype.snapShapePointerForDraw = function(doc, pointerState, appData) {
    let docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
    const constraintOpts = this.toolOptions.cstr;
    if (constraintOpts.constraintMode == 2) {
      const anchorRect = new Rect(
        docPoint.x - constraintOpts.constraintWidth,
        docPoint.y - constraintOpts.constraintHeight,
        constraintOpts.constraintWidth,
        constraintOpts.constraintHeight,
      );
      const cornerSnap = snapRectCornersToGuides(doc, anchorRect, appData);
      docPoint.x += cornerSnap[0];
      docPoint.y += cornerSnap[1];
      updateLayerDragPositions(doc, anchorRect, cornerSnap);
    } else {
      docPoint = snapPointToGuides(doc, docPoint, appData);
    }
    return docPoint;
  };

  ShapeToolBase.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
    if (this.shapeStartPoint == null) return;
    const pathCoords = this.shapePathCoords;
    const coordCount = pathCoords.length;
    const pointerPoint = pointerState
      ? this.snapShapePointerForDraw(doc, pointerState, appData)
      : new Point(pathCoords[coordCount - 2], pathCoords[coordCount - 1]);
    if (keyboard.isPressed(KeyboardHandler.Space)) {
      this.shapeStartPoint = pointerPoint.subtract(this.spacePanOffset);
    } else {
      this.spacePanOffset = pointerPoint.subtract(this.shapeStartPoint);
    }
    pathCoords.push(pointerPoint.x, pointerPoint.y);
    if (this.toolOptions.shape == null) this.toolOptions.shape = appData.customShapePresets[0];
    const previewPaths = this.buildShapePreviewPaths(doc, pointerPoint, keyboard)[0];
    const overlayPath = flattenPathRecordsToPath(previewPaths);
    doc.toolOverlayState.overlayTransform = overlayPath;
    if (
      this.id != ToolId.TOOL_FREE_PEN &&
      this.id != ToolId.TOOL_PARAMETRIC_SHAPE &&
      this.id != ToolId.TOOL_LINE_SHAPE
    ) {
      ToolBase.drawDimensionOverlay(
        pointerState.x + 10,
        pointerState.y - 10,
        doc.pathViewport.dimensionOverlay,
        doc,
        appData,
      );
    }
    doc.dirty = true;
  };

  ShapeToolBase.prototype.onCreateShapeDialogConfirm = function(dialogArgs, width, height, centerOnPoint) {
    const anchorPoint = dialogArgs[4].clone();
    if (centerOnPoint) {
      anchorPoint.x -= width / 2;
      anchorPoint.y -= height / 2;
    }
    const shapePaths = this.buildShapePaths(
      anchorPoint,
      new Point(anchorPoint.x + width, anchorPoint.y + height),
      false,
      this.shapePathCoords,
    );
    this.dispatchShapePathAction(dialogArgs[0], dialogArgs[1], dialogArgs[2], shapePaths);
  };

  ShapeToolBase.prototype.dispatchShapePathAction = function(doc, dispatcher, appData, shapePathsResult) {
    const historyEvent = new AppEvent(EventType.historyGrouped, true);
    historyEvent.data = buildShapePathAction(shapePathsResult[1], appData);
    dispatcher.dispatch(historyEvent);
    if (shapePathsResult[1].v.classID == "customShape" && shapePathsResult[1].v.Nm.v.startsWith("--")) {
      const pathTuple = doc.getPaths();
      const pathList = pathTuple[0];
      const selectedPathIndices = pathTuple[1];
      const activePath = pathList[selectedPathIndices.pop()];
      const vectorMask = activePath.add.vmsk;
      const keyOrigins = activePath.add.vogk;
      const maskClone = vectorMask.clone();
      maskClone.pathRecords = shapePathsResult[0];
      this.applyPathMaskToLayer(doc, activePath.idx, maskClone, keyOrigins);
    }
  };

  ShapeToolBase.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
    if (this.shapeStartPoint == null) return;
    const endPoint = this.snapShapePointerForDraw(doc, pointerState, appData);
    const pathCoords = this.shapePathCoords;
    const coordCount = pathCoords.length;

    if (this.id == ToolId.TOOL_FREE_PEN && coordCount <= 4) {
      // Free-pen click without enough samples — discard (no size dialog).
    } else if (coordCount <= 4) {
      endPoint.x = Math.round(endPoint.x);
      endPoint.y = Math.round(endPoint.y);
      openCreateShapeDialog(this, doc, dispatcher, appData, keyboard, endPoint);
    } else if (coordCount != 2) {
      commitFinishedShapeStroke(this, doc, dispatcher, appData, endPoint, keyboard);
    }

    clearShapeDragState(this, doc);
  };

  ShapeToolBase.prototype.applyAction = function(actionPayload, dispatcher, appData, keyboard, pointerState) {
    for (const optionKey in actionPayload) this.toolOptions[optionKey] = actionPayload[optionKey];
  };
}

ShapeToolBase.constrainShapePoints = function(startPoint, endPoint, keyboard, snapToPixelGrid, constraintOpts) {
  let startX = startPoint.x;
  let startY = startPoint.y;
  let endX = endPoint.x;
  let endY = endPoint.y;

  if (constraintOpts && constraintOpts.constraintMode == 2) {
    if (snapToPixelGrid) {
      endX = Math.round(endX);
      endY = Math.round(endY);
    }
    startX = endX - constraintOpts.constraintWidth;
    startY = endY - constraintOpts.constraintHeight;
  } else {
    let aspectRatio = 0;
    if (constraintOpts && constraintOpts.constraintMode == 1) {
      aspectRatio = constraintOpts.constraintHeight / constraintOpts.constraintWidth;
    } else if (keyboard && keyboard.isPressed(KeyboardHandler.Shift)) {
      aspectRatio = 1;
    }
    if (aspectRatio != 0) {
      if (snapToPixelGrid) {
        if (startX < endX) startX = Math.floor(startX);
        else startX = Math.ceil(startX);
        if (startY < endY) startY = Math.floor(startY);
        else startY = Math.ceil(startY);
      }
      const deltaX = Math.abs(endX - startX);
      const deltaY = Math.abs(endY - startY);
      let constrainedDeltaX = deltaX;
      if (deltaY / deltaX < aspectRatio) constrainedDeltaX *= deltaY / deltaX / aspectRatio;
      endX = endX > startX ? startX + constrainedDeltaX : startX - constrainedDeltaX;
      endY = endY > startY ? startY + constrainedDeltaX * aspectRatio : startY - constrainedDeltaX * aspectRatio;
    }
    if (keyboard && keyboard.isPressed(KeyboardHandler.Alt)) {
      startX -= endX - startX;
      startY -= endY - startY;
    }
  }

  const constrainedStart = new Point(startX, startY);
  const constrainedEnd = new Point(endX, endY);
  if (snapToPixelGrid) ShapeToolBase.applyShapeConstraint(constrainedStart, constrainedEnd);
  return [constrainedStart, constrainedEnd];
};

ShapeToolBase.applyShapeConstraint = function(startPoint, endPoint) {
  if (startPoint.x > endPoint.x) {
    const swapX = startPoint.x;
    startPoint.x = endPoint.x;
    endPoint.x = swapX;
  }
  if (startPoint.y > endPoint.y) {
    const swapY = startPoint.y;
    startPoint.y = endPoint.y;
    endPoint.y = swapY;
  }
  startPoint.x = Math.floor(startPoint.x);
  startPoint.y = Math.floor(startPoint.y);
  endPoint.x = Math.ceil(endPoint.x);
  endPoint.y = Math.ceil(endPoint.y);
};







export function FreePenTool() {
  ShapeToolBase.call(this, "tools.freePen", ToolId.TOOL_FREE_PEN, "tools/fpen", false);
}

function installFreePenToolPrototype() {
  FreePenTool.prototype.buildShapePaths = function(startPoint, endPoint, isShiftPressed, shapePathCoords) {
    return [
      simplifyPolylineToPathRecords(shapePathCoords, this.toolOptions.tolr),
      buildKeyOriginDescriptor("customShape", [0, 0, 1, 1], null, null, null, "--"),
    ];
  };
}

export function RectShapeTool() {
  ShapeToolBase.call(this, "tools.rectangle", ToolId.TOOL_RECT_SHAPE, "tools/rect", true);
}

function installRectShapeToolPrototype() {
  RectShapeTool.prototype.buildShapePaths = function(startPoint, endPoint, isShiftPressed) {
    const cornerRadius = this.toolOptions.crad;
    const width = endPoint.x - startPoint.x;
    const height = endPoint.y - startPoint.y;
    return [
      rectanglePathRecords(
        startPoint.x,
        startPoint.y,
        width,
        height,
        cornerRadius,
      ),
      buildKeyOriginDescriptor(
        "Rctn",
        [startPoint.x, startPoint.y, endPoint.x, endPoint.y],
        [cornerRadius, cornerRadius, cornerRadius, cornerRadius],
      ),
    ];
  };
}

export function EllipseShapeTool() {
  ShapeToolBase.call(this, "tools.ellipse", ToolId.TOOL_ELLIPSE_SHAPE, "tools/ellipse", true);
}

function installEllipseShapeToolPrototype() {
  EllipseShapeTool.prototype.buildShapePaths = function(startPoint, endPoint, isShiftPressed) {
    const width = endPoint.x - startPoint.x;
    const height = endPoint.y - startPoint.y;
    return [
      ellipsePathRecords(startPoint.x, startPoint.y, width, height),
      buildKeyOriginDescriptor("Elps", [startPoint.x, startPoint.y, endPoint.x, endPoint.y]),
    ];
  };
}

export function ParametricShapeTool() {
  ShapeToolBase.call(this, "tools.parametricShape", ToolId.TOOL_PARAMETRIC_SHAPE, "tools/pshape", false);
}

function installParametricShapeToolPrototype() {
  ParametricShapeTool.prototype.buildShapePaths = function(startPoint, endPoint, isShiftPressed) {
    const shapeKind = this.toolOptions.pshape;
    const cornerRadius = this.toolOptions.crad;
    const starInsetRatio = this.toolOptions.irad / 100;
    const arrowWidth = this.toolOptions.width;
    const arrowHeadScale = this.toolOptions.tsiz;
    const burstSpokeCount = this.toolOptions.length;
    endPoint = endPoint.clone();
    if (isShiftPressed) {
      if (Math.abs(endPoint.x - startPoint.x) < Math.abs(endPoint.y - startPoint.y)) endPoint.x = startPoint.x;
      else endPoint.y = startPoint.y;
    }
    const centerX = startPoint.x;
    const centerY = startPoint.y;
    const endX = endPoint.x;
    const endY = endPoint.y;
    const radius = Math.sqrt((endX - centerX) * (endX - centerX) + (endY - centerY) * (endY - centerY));
    const angle = Math.atan2(-endY + centerY, endX - centerX);
    const buildByKind = [
      () => regularPolygonPathRecords(centerX, centerY, radius, angle, this.toolOptions.sides, cornerRadius),
      () => starPathRecords(centerX, centerY, radius, angle, this.toolOptions.sides, cornerRadius, starInsetRatio),
      () => arrowPathRecords(startPoint.x, startPoint.y, endPoint.x, endPoint.y, arrowWidth, arrowHeadScale / 100),
      () => starBurstPathRecords(centerX, centerY, radius, angle, burstSpokeCount),
    ];
    const pathRecords = buildByKind[shapeKind]();
    return [
      pathRecords,
      buildKeyOriginDescriptor(
        "customShape",
        [startPoint.x, startPoint.y, endPoint.x, endPoint.y],
        null,
        null,
        null,
        "--",
      ),
    ];
  };

  ParametricShapeTool.prototype.onKeyEvent = function(doc, dispatcher, appData, keyboard) {
    const arrowDelta = keyboard.getArrowMovement();
    const toolOptions = this.toolOptions;
    const optionChange = parametricOptionDeltaFromArrows(toolOptions, arrowDelta);
    if (!optionChange) return;

    const { optionKey, optionValue } = optionChange;
    const toolGestureEvent = new AppEvent(EventType.uiDispatch, true);
    const optionPayload = {};
    optionPayload[optionKey] = optionValue;
    toolOptions[optionKey] = optionValue;
    toolGestureEvent.data = {
      dispatchKind: UiCommand.forwardActiveToolGesture,
      routingChannel: this.id,
      operation: "vals",
      optionValues: optionPayload,
    };
    dispatcher.dispatch(toolGestureEvent);
    this.onMouseMove(doc, dispatcher, appData, keyboard);
  };
}

export function LineShapeTool() {
  ShapeToolBase.call(this, "tools.line", ToolId.TOOL_LINE_SHAPE, "tools/line", false);
}

function installLineShapeToolPrototype() {
  LineShapeTool.prototype.buildShapePaths = function(startPoint, endPoint, isShiftPressed) {
    const strokeWidth = this.toolOptions.width;
    endPoint = endPoint.clone();
    if (isShiftPressed) {
      endPoint = constrainEndpointToAxis(startPoint, endPoint);
    }
    return [
      linePathRecords(
        startPoint.x,
        startPoint.y,
        endPoint.x,
        endPoint.y,
        strokeWidth,
      ),
      buildKeyOriginDescriptor(
        "Ln",
        null,
        null,
        [startPoint.x, startPoint.y, endPoint.x, endPoint.y],
        strokeWidth,
      ),
    ];
  };
}

export function CustomShapeTool() {
  ShapeToolBase.call(this, "tools.customShape", ToolId.TOOL_CUSTOM_SHAPE, "tools/cshape", true);
}

function installCustomShapeToolPrototype() {
  CustomShapeTool.prototype.buildShapePaths = function(startPoint, endPoint, isShiftPressed) {
    const shapePreset = this.toolOptions.shape;
    const aspectRatio = shapePreset.boundsRect.width / shapePreset.boundsRect.height;
    const pathRecords = VectorMask.clonePathRecords(shapePreset.pathRecords);
    endPoint = endPoint.clone();
    if (isShiftPressed) {
      endPoint.y = startPoint.y + (endPoint.x - startPoint.x) / aspectRatio;
    }
    const scaleX = endPoint.x - startPoint.x;
    const scaleY = endPoint.y - startPoint.y;
    transformPathRecordCoords(
      pathRecords,
      new Matrix2D(scaleX, 0, 0, scaleY, startPoint.x, startPoint.y),
    );
    return [
      pathRecords,
      buildKeyOriginDescriptor(
        "customShape",
        [startPoint.x, startPoint.y, endPoint.x, endPoint.y],
        null,
        null,
        null,
        shapePreset.categoryName,
      ),
    ];
  };
}

// Chain each tool's prototype onto the base it extends. The bases are
// imported, so they are fully built by the time this runs.
ShapeToolBase.prototype = Object.create(PolyToolBase.prototype);
installShapeToolBasePrototype();

const shapeToolInstallers = [
  [FreePenTool, installFreePenToolPrototype],
  [RectShapeTool, installRectShapeToolPrototype],
  [EllipseShapeTool, installEllipseShapeToolPrototype],
  [ParametricShapeTool, installParametricShapeToolPrototype],
  [LineShapeTool, installLineShapeToolPrototype],
  [CustomShapeTool, installCustomShapeToolPrototype],
];
for (const [ToolConstructor, installPrototype] of shapeToolInstallers) {
  ToolConstructor.prototype = Object.create(ShapeToolBase.prototype);
  installPrototype();
}

