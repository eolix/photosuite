/**
 * Pen, free pen, path-select, and direct-select tools. Builds and edits vector
 * paths on shape layers; `PolyToolBase` is shared with shape-tools.js.
 */

import { Point, constrainEndpointToAxis } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";

import { Layer, getVectorStrokeStyleSnapshot } from "../model/layer.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { AxisDragAnchor } from "../model/axis-drag-anchor.js";
import { Document, HistoryEntry } from "../model/document.js";

import { PopupTypes } from "../../ui/config/popup-types.js";
import { TextEngineData } from "../../features/text/text-engine.js";
import { TextLayout } from "../../features/text/text-layout.js";
import { TextRenderer } from "../../features/text/text-renderer.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { getDevicePixelRatio, makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { EventChannel, ToolBase, ToolId } from "../model/tool-base.js";
import { snapPointToGuides, snapRectCornersToGuides, updateLayerDragPositions } from "../model/guide-snapping.js";
import { buildShapeAction, buildShapePathAction } from "./shape-actions.js";
import { allocBuffer, extractChannelByte } from "../../engine/compositing/buffer-utils.js";
import { copyChannel } from "../../engine/compositing/pixel-ops.js";
import { buildCanvasPathRecords, findNearestVertexIndex, rectToPathOutline, transformCoordPairs } from "../../engine/compositing/anti-alias.js";
import { matrix2DToHomography } from "../../engine/compositing/homography.js";
import { boundsOfPathRecords, filterPathExcludingSubpaths, filterPathKeepingSubpaths, hitTestPoint, pointOnPathAtParam, removeSelectedSubpathsFromPath, roundCornersOnSubpath, selectPointsInRect } from "../../engine/compositing/selection-utils.js";
import { subpathIndicesIntersectingRect } from "../../engine/compositing/path-paper-bridge.js";
import { countSubpaths, recordIndexForSubpath, subpathIndexForRecord, transformPathRecordCoords } from "../../engine/compositing/path-records.js";
import { buildKeyOriginDescriptor, createEmptyKeyOrigin, createForSubpaths, invalidateKeyOriginAtIndex, transformKeyOriginsWithMatrix } from "../../engine/compositing/key-origins.js";
import { composite } from "../../engine/compositing/compositing-ops.js";
import { toRGBDesc } from "../../engine/compositing/psd-color-utils.js";
import { convolveChannel3x3, normalizeKernel } from "../../engine/compositing/spatial-filters.js";
import { getPathRecords, traceContours } from "../../engine/compositing/bitmap-contour-tracer.js";


function dispatchCursorOverlay(dispatcher, cursorOverlayId) {
  const cursorEvent = new AppEvent(EventType.uiDispatch, true);
  cursorEvent.data = {
    dispatchKind: UiCommand.splashOptionsUpdate,
    cursorOverlayId,
  };
  dispatcher.dispatch(cursorEvent);
}

function dispatchForwardToolGesture(dispatcher, routingChannel, gesturePayload) {
  const gestureEvent = new AppEvent(EventType.uiDispatch, true);
  gestureEvent.data = {
    dispatchKind: UiCommand.forwardActiveToolGesture,
    routingChannel,
    ...gesturePayload,
  };
  dispatcher.dispatch(gestureEvent);
}

function dispatchOpenPresetPopup(dispatcher, popupType, payload = {}) {
  const popupEvent = new AppEvent(EventType.uiDispatch, true);
  popupEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType,
    ...payload,
  };
  dispatcher.dispatch(popupEvent);
}

function scalePathCursorGeometry(geometry, devicePixelRatio) {
  if (devicePixelRatio >= 1.5) return geometry;
  const scaleFactor = 0.66;
  return {
    stemLength: geometry.stemLength * scaleFactor,
    wingSpan: geometry.wingSpan * scaleFactor,
    baseHalfWidth: geometry.baseHalfWidth * scaleFactor,
    baseDepth: geometry.baseDepth * scaleFactor,
  };
}

function drawPathCursorGlyph(ctx, cursorModeKey, geometry, lineWidth, rotation) {
  const { stemLength, wingSpan, baseHalfWidth, baseDepth } = geometry;
  ctx.beginPath();
  if (cursorModeKey == "cnv") {
    ctx.moveTo(-stemLength, wingSpan);
    ctx.lineTo(0, 0);
    ctx.lineTo(stemLength, wingSpan);
    ctx.stroke();
    return;
  }
  ctx.moveTo(0, 0);
  ctx.lineTo(stemLength, wingSpan);
  ctx.lineTo(baseHalfWidth, baseDepth);
  ctx.lineTo(-baseHalfWidth, baseDepth);
  ctx.lineTo(-stemLength, wingSpan);
  ctx.lineTo(0, 0);
  ctx.moveTo(0, 0);
  ctx.lineTo(0, wingSpan);
  ctx.fillStyle = "white";
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "black";
  ctx.fillRect(-baseHalfWidth - 1, baseDepth, 2 * baseHalfWidth + 2, 6);
  ctx.beginPath();
  ctx.arc(0, wingSpan - 2, 2.5, 0, 2 * Math.PI, false);
  ctx.fill();
  ctx.rotate(-rotation);
  ctx.translate(24, 7);
  ctx.beginPath();
  if (cursorModeKey == "add" || cursorModeKey == "del" || cursorModeKey == "new") {
    ctx.moveTo(-5, 0);
    ctx.lineTo(5, 0);
    if (cursorModeKey == "add") {
      ctx.moveTo(0, -5);
      ctx.lineTo(0, 5);
    }
    if (cursorModeKey == "new") {
      ctx.moveTo(-2.5, -4.5);
      ctx.lineTo(2.5, 4.5);
      ctx.moveTo(2.5, -4.5);
      ctx.lineTo(-2.5, 4.5);
    }
  } else if (cursorModeKey == "fin") {
    ctx.arc(0, 0, 5, 0, 2 * Math.PI, false);
  } else if (cursorModeKey == "mov" || cursorModeKey == "mva") {
    for (var arrowIdx = 0; arrowIdx < 4; arrowIdx++) {
      ctx.moveTo(0, 0);
      ctx.lineTo(-7, 0);
      var strokeInset = 1 + lineWidth;
      ctx.moveTo(-7 + strokeInset, -strokeInset);
      ctx.lineTo(-7, 0);
      ctx.lineTo(-7 + strokeInset, strokeInset);
      ctx.rotate(Math.PI / 2);
    }
  } else if (cursorModeKey == "mon") {
    var moveCoords = [-7, 0, -3, 0, -3, -3, 3, -3, 3, 0, 7, 0, 3, 0, 3, 3, -3, 3, -3, 0];
    ctx.moveTo(moveCoords[0], moveCoords[1]);
    for (var coordIdx = 2; coordIdx < moveCoords.length; coordIdx += 2) {
      ctx.lineTo(moveCoords[coordIdx], moveCoords[coordIdx + 1]);
    }
  }
  ctx.stroke();
}

function softenPathCursorAlpha(rgbaPixels, canvasSize) {
  var alphaChannel = allocBuffer(canvasSize * canvasSize);
  extractChannelByte(rgbaPixels, alphaChannel, 3);
  var blurredChannel = allocBuffer(canvasSize * canvasSize);
  var kernel = normalizeKernel([3, 5, 3, 4, 8, 4, 3, 5, 3]);
  convolveChannel3x3(alphaChannel, blurredChannel, canvasSize, canvasSize, kernel);
  for (var pixelIdx = 0; pixelIdx < blurredChannel.length; pixelIdx++) {
    blurredChannel[pixelIdx] = Math.min(255, blurredChannel[pixelIdx] * 2);
  }
  convolveChannel3x3(blurredChannel, alphaChannel, canvasSize, canvasSize, kernel);
  for (var softIdx = 0; softIdx < alphaChannel.length; softIdx++) {
    alphaChannel[softIdx] = Math.min(255, alphaChannel[softIdx] * 2);
  }
  var whiteOverlay = new Uint8ClampedArray(rgbaPixels);
  rgbaPixels.fill(255);
  for (var alphaIdx = 0; alphaIdx < alphaChannel.length; alphaIdx++) {
    rgbaPixels[(alphaIdx << 2) + 3] = alphaChannel[alphaIdx];
  }
  composite(
    "norm",
    whiteOverlay,
    new Rect(0, 0, canvasSize, canvasSize),
    rgbaPixels,
    new Rect(0, 0, canvasSize, canvasSize),
    new Rect(0, 0, canvasSize, canvasSize),
    1,
  );
  return rgbaPixels;
}

export function PolyToolBase(labelKey, toolId, iconPath) {
  ToolBase.call(this, labelKey, toolId, iconPath);
  this.activeDocument = null;
  this.appData = null;
  this.appDispatcher = null;
  this.pathStyleDialogDebounceMs = 0
};


function installPolyToolBasePrototype() {


PolyToolBase.prototype.enable = function(doc, dispatcher, appData, keyboard, embedInDialog) {
  this.appData = appData;
  dispatchCursorOverlay(dispatcher, "default");
};
PolyToolBase.prototype.onRightMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (doc.getPaths()[0].length == 0) return;
  dispatchForwardToolGesture(dispatcher, this.id, {
    pointerState: pointerState,
    doc: doc,
    appData: appData,
  });
};
PolyToolBase.prototype.ensurePathEditingPrefs = function(dispatcher, appData) {
  if (!appData.extras) dispatchOpenPresetPopup(dispatcher, PopupTypes.TOGGLE_EXTRAS);
  if (!appData.prefs.paths) dispatchOpenPresetPopup(dispatcher, PopupTypes.CANVAS_SIZE);
};
PolyToolBase.prototype.onDocumentStateChange = function(doc, dispatcher, appData, keyboard) {
  if (appData.activeToolId != this.id) return;
  if (doc.selectedLayerIndices.length == 0) return;
  var layer = doc.layers[doc.selectedLayerIndices[0]],
    vectorMask = layer.add.vmsk,
    vectorStroke = layer.add.vstk,
    fillSnapshot = getVectorStrokeStyleSnapshot(doc, doc.selectedLayerIndices[0]);
  this.activeDocument = doc;
  this.appDispatcher = dispatcher;
  if (layer.hasFillContent() && vectorMask != null && (JSON.stringify(vectorStroke) != JSON.stringify(appData.currentStroke) || JSON.stringify(fillSnapshot) != JSON.stringify(appData.currentFill))) {
    this.pathStyleDialogDebounceMs = Date.now();
    dispatchOpenPresetPopup(dispatcher, PopupTypes.PLACE_IMAGE, { value: fillSnapshot });
    dispatchOpenPresetPopup(dispatcher, PopupTypes.SHAPE_STROKE, { value: vectorStroke });
  }
};
PolyToolBase.prototype.onUpdate = function(appData, popupType) {
  if (this.activeDocument == null) return;
  if (popupType == PopupTypes.ALL || popupType == PopupTypes.PLACE_IMAGE || popupType == PopupTypes.SHAPE_STROKE) {
    if (Date.now() - this.pathStyleDialogDebounceMs < 50) return;
    var isFillUpdate = popupType == PopupTypes.PLACE_IMAGE,
      doc = this.activeDocument,
      stylePayload = isFillUpdate ? appData.currentFill : appData.currentStroke,
      vectorLayerIndices = [];
    for (var layerIdx = 0; layerIdx < doc.selectedLayerIndices.length; layerIdx++) {
      var layerIndex = doc.selectedLayerIndices[layerIdx],
        layer = doc.layers[layerIndex];
      if (!layer.hasFillContent() || layer.add.vmsk == null) continue;
      vectorLayerIndices.push(layerIndex)
    }
    var styleApplyEvent = new AppEvent(EventType.documentAction, true);
    styleApplyEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
    styleApplyEvent.data = {
      actionKind: Layer.updateContentStyle,
      contentLayerIndices: vectorLayerIndices,
      updateContentFill: isFillUpdate,
      contentStylePayload: stylePayload
    };
    if (vectorLayerIndices.length != 0) this.appDispatcher.dispatch(styleApplyEvent)
  }
};
PolyToolBase.prototype.applyShapeFillColorFromPicker = function(colorInt) {
  if (typeof colorInt == "number") {
    var historyEvent = new AppEvent(EventType.historyGrouped, true);
    historyEvent.data = buildShapeAction(0);
    historyEvent.data.actionDescriptor.Usng.v.Type.v.Clr.v = toRGBDesc({
      h: colorInt >>> 16 & 255,
      l: colorInt >>> 8 & 255,
      O: colorInt >>> 0 & 255
    });
    this.appDispatcher.dispatch(historyEvent)
  }
};
PolyToolBase.prototype.handleInput = function(event, dispatcher, doc, keyboard, appData) {
  this.appDispatcher = dispatcher;
  if (event.actionKind == "newfill") {
    if (event.openSolidFillColorPicker) {
      var colorPickerEvent = new AppEvent(EventType.uiDispatch, true);
      colorPickerEvent.data = {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "colorpicker",
        colorIntArgb: appData.colorInt,
        onDialogResult: this.applyShapeFillColorFromPicker.bind(this)
      };
      dispatcher.dispatch(colorPickerEvent)
    }
  } else if (event.actionKind == "pathedit") {
    var pathOperation = event.operation,
      historyLabel = "",
      pathsBefore = doc.paths.slice(0),
      selectedPathsBefore = doc.selectedWorkPaths.slice(0),
      pathsAfter = doc.paths.slice(0),
      selectedPathsAfter = doc.selectedWorkPaths.slice(0);
    if (pathOperation == "rnm") {
      var workPathIndex = -1 - event.idx,
        renamedPath = pathsBefore[workPathIndex],
        renamedEntry = Document.createPathEntry(event.name, renamedPath.add);
      if (workPathIndex != 0) pathsAfter[workPathIndex] = renamedEntry;
      else {
        selectedPathsAfter = [pathsAfter.length];
        pathsAfter.push(renamedEntry);
        pathsAfter[0] = Document.createPathEntry("Work Path")
      }
      historyLabel = "Rename"
    } else if (pathOperation == "new") {
      pathsAfter.push(Document.createPathEntry("Path " + pathsBefore.length));
      selectedPathsAfter = [pathsAfter.length - 1];
      historyLabel = "New"
    } else if (pathOperation == "del") {
      if (selectedPathsAfter.length == 0) return;
      selectedPathsAfter.sort(function(indexA, indexB) {
        return indexA - indexB
      });
      if (selectedPathsAfter[0] == 0) {
        pathsAfter[0] = Document.createPathEntry(pathsBefore[0].name);
        selectedPathsAfter = selectedPathsAfter.slice(1)
      }
      var removedCount = 0;
      while (selectedPathsAfter.length != 0) {
        pathsAfter.splice(selectedPathsAfter[0] - removedCount, 1);
        selectedPathsAfter = selectedPathsAfter.slice(1);
        removedCount++
      }
      historyLabel = "Delete"
    } else if (pathOperation == "fromsel") {
      var workPath = pathsAfter[0] = Document.createPathEntry("Work Path");
      selectedPathsAfter = [0];
      if (doc.selectionMask == null) return;
      var selectionChannel = doc.selectionMask.channel.slice(0);
      for (var pixelIdx = 0; pixelIdx < selectionChannel.length; pixelIdx++) selectionChannel[pixelIdx] = selectionChannel[pixelIdx] > 128 ? 2 : 1;
      var traceRect = doc.selectionMask.rect.clone();
      traceRect.inflate(1, 1);
      var traceBuffer = allocBuffer(traceRect.area());
      copyChannel(selectionChannel, doc.selectionMask.rect, traceBuffer, traceRect);
      var contourTree = traceContours(traceBuffer, traceRect.width, traceRect.height, Math.round(traceRect.area() * 5e-4)),
        contourPaths = getPathRecords(contourTree),
        selectionOffset = new Matrix2D(1, 0, 0, 1, -1 + doc.selectionMask.rect.x, -1 + doc.selectionMask.rect.y);
      for (var pathIdx = 0; pathIdx < contourPaths.length; pathIdx++) transformCoordPairs(contourPaths[pathIdx].path.coords, selectionOffset, contourPaths[pathIdx].path.coords);
      for (var pathIdx = 0; pathIdx < contourPaths.length; pathIdx++) {
        var contourEntry = contourPaths[pathIdx];
        if (contourEntry.color == 1 && contourEntry.parent == -1) continue;
        var pathRecords = buildCanvasPathRecords(contourPaths[pathIdx].path, false);
        workPath.add.vmsk.pathRecords = workPath.add.vmsk.pathRecords.concat(pathRecords.slice(2))
      }
      workPath.add.vogk = createForSubpaths(workPath.add.vmsk.pathRecords);
      historyLabel = "Selection to"
    }
    var pathHistoryEntry = new HistoryEntry(historyLabel + " Path", this);
    pathHistoryEntry.data = {
      pathHistoryPathsBefore: pathsBefore,
      selectedWorkPathsBefore: selectedPathsBefore,
      pathHistoryPathsAfter: pathsAfter,
      selectedWorkPathsAfter: selectedPathsAfter
    };
    if (pathOperation == "fromsel") {
      pathHistoryEntry.data.selectionMaskBefore = doc.selectionMask;
      pathHistoryEntry.data.selectionMaskAfter = null
    }
    doc.pushHistory(pathHistoryEntry);
    this.redo(pathHistoryEntry.data, doc)
  } else {
    var activePathTuple = doc.getPaths(event.actionKind == "append"),
      pathList = activePathTuple[0],
      selectedPathIndices = activePathTuple[1],
      activePath = pathList[selectedPathIndices[0]],
      vectorMask = activePath.add.vmsk,
      keyOrigins = activePath.add.vogk,
      maskBefore = vectorMask.clone(),
      maskAfter = vectorMask.clone(),
      keyOriginsBeforeJson = JSON.stringify(keyOrigins);
    if (event.actionKind == "remove") {
      if (maskAfter.C.length == 0) return;
      var removedCount = 0;
      for (var componentIdx = 0; componentIdx < maskAfter.C.length; componentIdx++) {
        keyOrigins.splice(maskAfter.C[componentIdx] + removedCount, 1);
        removedCount--
      }
      maskAfter.pathRecords = filterPathExcludingSubpaths(maskAfter.pathRecords, maskAfter.C);
      maskAfter.C = [];
      maskAfter.selectedComponents = []
    }
    if (event.actionKind == "append") {
      PolyToolBase.mergePathSegments(event.pathSegmentClipboard, maskAfter, keyOrigins)
    }
    this.applyPathMaskToLayer(doc, activePath.idx, maskAfter, keyOrigins);
    this.pushPathHistory(doc, event.historyLabelKey, activePath.idx, maskBefore, maskAfter.clone(), null, keyOriginsBeforeJson, JSON.stringify(keyOrigins))
  }
};
PolyToolBase.clonePathSelectionState = function(vectorMask, keyOrigins) {
  var filteredPath = filterPathKeepingSubpaths(vectorMask.pathRecords, vectorMask.C),
    selectedOrigins = [];
  for (var componentIdx = 0; componentIdx < vectorMask.C.length; componentIdx++) selectedOrigins.push(JSON.parse(JSON.stringify(keyOrigins[vectorMask.C[componentIdx]])));
  return [filteredPath, selectedOrigins]
};
PolyToolBase.mergePathSegments = function(segmentPayload, vectorMask, keyOrigins) {
  var subpathCountBefore = countSubpaths(vectorMask.pathRecords),
    appendedSubpathCount = countSubpaths(segmentPayload[0]);
  vectorMask.pathRecords = vectorMask.pathRecords.concat(segmentPayload[0].slice(2));
  vectorMask.C = [];
  for (var subpathIdx = 0; subpathIdx < appendedSubpathCount; subpathIdx++) vectorMask.C.push(subpathCountBefore + subpathIdx);
  for (var subpathIdx = 0; subpathIdx < appendedSubpathCount; subpathIdx++) keyOrigins.push(JSON.parse(JSON.stringify(segmentPayload[1][subpathIdx])))
};
PolyToolBase.prototype.isModifierKey = function(keyCode, doc) {
  if (doc == null) return false;
  var pathTuple = doc.getPaths(),
    pathList = pathTuple[0],
    selectedPathIndices = pathTuple[1];
  if (selectedPathIndices.length == 0) return false;
  var activePath = pathList[selectedPathIndices[0]],
    vectorMask = activePath.add.vmsk;
  if (vectorMask && vectorMask.C.length + vectorMask.selectedComponents.length != 0) return [KeyboardHandler.Delete, KeyboardHandler.Backspace].indexOf(keyCode) != -1;
};
PolyToolBase.prototype.onKeyEvent = function(doc, dispatcher, appData, keyboard) {
  if (doc == null) return;
  var pathTuple = doc.getPaths(),
    pathList = pathTuple[0],
    selectedPathIndices = pathTuple[1];
  if (selectedPathIndices.length == 0) return;
  var activePath = pathList[selectedPathIndices[0]],
    vectorMask = activePath.add.vmsk;
  if (keyboard.isPressed(KeyboardHandler.Escape) || keyboard.isPressed(KeyboardHandler.Enter)) {
    vectorMask.selectedComponents = [];
    doc.dirty = true
  }
  if (vectorMask.C.length != 0) {
    var arrowDelta = keyboard.getArrowMovement();
    if (arrowDelta.x != 0 || arrowDelta.y != 0) {
      var maskBefore = vectorMask.clone(),
        maskAfter = vectorMask.clone(),
        translateMatrix = new Matrix2D(1, 0, 0, 1, arrowDelta.x, arrowDelta.y),
        keyOrigins = activePath.add.vogk,
        keyOriginsBeforeJson = JSON.stringify(keyOrigins);
      transformPathRecordCoords(maskAfter.pathRecords, translateMatrix, maskAfter.C);
      transformKeyOriginsWithMatrix(keyOrigins, matrix2DToHomography(translateMatrix), maskAfter.C);
      this.applyPathMaskToLayer(doc, activePath.idx, maskAfter, keyOrigins);
      this.pushPathHistory(doc, "Move Paths", activePath.idx, maskBefore, maskAfter.clone(), true, keyOriginsBeforeJson, JSON.stringify(keyOrigins))
    }
    if (keyboard.isPressed(KeyboardHandler.Delete) || keyboard.isPressed(KeyboardHandler.Backspace)) this.handleInput({
      actionKind: "remove",
      historyLabelKey: "Delete Paths"
    }, dispatcher, doc, keyboard, appData)
  }
};
PolyToolBase.prototype.pushPathHistory = function(doc, historyLabel, layerKey, maskBefore, maskAfter, isMovePaths, keyOriginsBeforeJson, keyOriginsAfterJson) {
  var historyEntry = new HistoryEntry(historyLabel, this);
  historyEntry.data = {
    pathLayerKey: layerKey,
    pathHistoryMaskBefore: maskBefore,
    pathHistoryMaskAfter: maskAfter,
    pathHistoryIsMovePaths: isMovePaths,
    pathHistoryKeyOriginsBeforeJson: keyOriginsBeforeJson,
    pathHistoryKeyOriginsAfterJson: keyOriginsAfterJson
  };
  doc.pushHistory(historyEntry)
};
PolyToolBase.prototype.redo = function(historyData, doc) {
  if (historyData.pathLayerKey != null) this.applyPathMaskToLayer(doc, historyData.pathLayerKey, historyData.pathHistoryMaskAfter.clone(), JSON.parse(historyData.pathHistoryKeyOriginsAfterJson));
  else {
    doc.paths = historyData.pathHistoryPathsAfter.slice(0);
    doc.selectedWorkPaths = historyData.selectedWorkPathsAfter.slice(0);
    doc.dirty = doc.stateChanged = true
  }
  if (historyData.selectionMaskBefore || historyData.selectionMaskAfter) {
    doc.selectionMask = historyData.selectionMaskAfter;
    doc.needsComposite = true
  }
};
PolyToolBase.prototype.undo = function(historyData, doc) {
  if (historyData.pathLayerKey != null) this.applyPathMaskToLayer(doc, historyData.pathLayerKey, historyData.pathHistoryMaskBefore.clone(), JSON.parse(historyData.pathHistoryKeyOriginsBeforeJson));
  else {
    doc.paths = historyData.pathHistoryPathsBefore.slice(0);
    doc.selectedWorkPaths = historyData.selectedWorkPathsBefore.slice(0);
    doc.dirty = doc.stateChanged = true
  }
  if (historyData.selectionMaskBefore || historyData.selectionMaskAfter) {
    doc.selectionMask = historyData.selectionMaskBefore;
    doc.needsComposite = true
  }
};
PolyToolBase.prototype.applyPathMaskToLayer = function(doc, layerKey, vectorMask, keyOrigins) {
  var pathOwner = layerKey < 0 ? doc.paths[-1 - layerKey] : layerKey < 1e6 ? doc.layers[layerKey] : doc.layers[layerKey - 1e6].add.TySh;
  pathOwner.add.vmsk = vectorMask;
  pathOwner.add.vogk = keyOrigins;
  if (1e6 <= layerKey) {
    TextEngineData.syncCurveToVmsk(pathOwner);
    var textLayer = doc.layers[layerKey - 1e6],
      textShape = pathOwner,
      appData = this.appData,
      curveData = new TextLayout(textShape.engineData, appData.fontRegistry),
      textRender = TextRenderer.renderText(curveData, textShape);
    textLayer.rect = textRender.rect;
    textLayer.buffer = textRender.buffer;
    textLayer.markDirty();
    doc.markDirty()
  } else if (0 <= layerKey) {
    vectorMask.maskCombineDirty = true;
    pathOwner.invalidate(doc);
    doc.markDirty()
  }
  doc.dirty = doc.stateChanged = true
};



}

export function PenTool() {
  PolyToolBase.call(this, "tools.pen", ToolId.TOOL_PEN, "tools/pen");
  this.pathMaskBeforeDrag = null;
  this.keyOriginsJsonBefore = null;
  this.pathEditMode = 1;
  this.pathFillRuleIndex = 0;
  this.penDragAnchor = null;
  this.isClosingPath = false;
  this.swapHandlesWhileDragging = false;
  this.smoothPointFromAltDrag = false;
  this.lastPointerState = null;
  this.isDraggingPathHandle = false;
  this.activeHandleHitKind = 0
};


PenTool.pathCursorPreviewCache = {};
PenTool.buildPathCursorPreview = function(cursorModeKey) {
  var cachedPreview = PenTool.pathCursorPreviewCache[cursorModeKey];
  if (cachedPreview) return cachedPreview;
  var canvasSize = 64;
  var lineWidth = 2;
  var rotation = -0.38;
  var canvas = makeElement("canvas");
  canvas.width = canvasSize;
  canvas.height = canvasSize;
  var ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvasSize, canvasSize);
  ctx.save();
  ctx.lineWidth = lineWidth;
  ctx.translate(4 - lineWidth / 2, 4 - lineWidth / 2);
  ctx.rotate(rotation);
  ctx.lineJoin = "miter";
  var geometry = scalePathCursorGeometry(
    { stemLength: 10, wingSpan: 25, baseHalfWidth: 5, baseDepth: 35 },
    getDevicePixelRatio(),
  );
  drawPathCursorGlyph(ctx, cursorModeKey, geometry, lineWidth, rotation);
  ctx.restore();
  var rgbaPixels = softenPathCursorAlpha(
    new Uint8ClampedArray(ctx.getImageData(0, 0, canvasSize, canvasSize).data),
    canvasSize,
  );
  cachedPreview = {
    pixelSource: new Uint8Array(rgbaPixels.buffer),
    boundsRect: new Rect(0, 0, canvasSize, canvasSize),
    hotspot: new Point(4, 4),
  };
  PenTool.pathCursorPreviewCache[cursorModeKey] = cachedPreview;
  return cachedPreview;
};


function installPenToolPrototype() {
PenTool.prototype.getPathCursorMode = function(doc, appData, keyboard, pointerState) {
  if (pointerState) this.lastPointerState = pointerState;
  var resolvedPointer = pointerState || this.lastPointerState;
  if (resolvedPointer == null) return "nrm";
  var docPoint = doc.pathViewport.screenToDocPoint(resolvedPointer.x, resolvedPointer.y);
  docPoint = snapPointToGuides(doc, docPoint, appData);
  docPoint.x = Math.round(docPoint.x);
  docPoint.y = Math.round(docPoint.y);
  var hitRadius = 4 * getDevicePixelRatio() / doc.pathViewport.zoomScale,
    keys = keyboard && keyboard.isPressed ? keyboard : null,
    ctrl = keys ? keys.isPressed(KeyboardHandler.Ctrl) : false,
    pathTuple = doc.getPaths(this.pathEditMode == 0),
    pathList = pathTuple[0],
    selectedPathIndices = pathTuple[1];
  if (selectedPathIndices.length == 0) return ctrl ? "default" : "new";
  var activePath = pathList[selectedPathIndices[selectedPathIndices.length - 1]],
    vectorMask = activePath ? activePath.add.vmsk : null;
  if (vectorMask == null || vectorMask.pathRecords == null || vectorMask.pathRecords.length < 2) return ctrl ? "default" : "new";
  if (keys && keys.isPressed(KeyboardHandler.Alt) && !ctrl) return "cnv";
  var selectionHits = selectPointsInRect(vectorMask.pathRecords, new Rect(docPoint.x - hitRadius, docPoint.y - hitRadius, hitRadius * 2, hitRadius * 2), vectorMask.selectedComponents),
    hitTestResult = hitTestPoint(vectorMask.pathRecords, docPoint, true, hitRadius);
  if (hitTestResult.idx != -1 && selectionHits[0].length == 0) return "add";
  if (vectorMask.selectedComponents.length >= 1 && vectorMask.pathRecords.length > 4) {
    var selectedRecordIdx = vectorMask.selectedComponents[0],
      subpathIdx = subpathIndexForRecord(vectorMask.pathRecords, selectedRecordIdx),
      subpathStartIdx = recordIndexForSubpath(vectorMask.pathRecords, subpathIdx);
    if (Point.dist(docPoint, vectorMask.pathRecords[subpathStartIdx + 1].anchor) < hitRadius) return "fin"
  }
  if (selectionHits[0].length == 1 && vectorMask.pathRecords[selectionHits[0][0] - 1] && (vectorMask.pathRecords[selectionHits[0][0] - 1].fillRule == null || vectorMask.pathRecords[selectionHits[0][0] - 1].type == 0 || vectorMask.pathRecords[selectionHits[0][0] - 1].length == 1)) return ctrl ? "mov" : "del";
  if (selectionHits[0].length != 0) return ctrl ? "mov" : "del";
  if (selectionHits[1].length != 0 || selectionHits[2].length != 0) return "mva";
  if (ctrl) return "default";
  return "nrm"
};
PenTool.prototype.updatePathCursor = function(doc, dispatcher, appData, keyboard, pointerState) {
  var cursorMode = this.getPathCursorMode(doc, appData, keyboard, pointerState),
    cursorPreview = cursorMode == "default" ? "default" : PenTool.buildPathCursorPreview(cursorMode);
  dispatchCursorOverlay(dispatcher, cursorPreview);
};
PenTool.prototype.enable = function(doc, dispatcher, appData, keyboard) {
  this.appData = appData;
  this.updatePathCursor(doc, dispatcher, appData, keyboard, null)
};
PenTool.prototype.wantsInput = function(pointerState) {
  return this.pathMaskBeforeDrag != null
};
PenTool.prototype.onKeyEvent = function(doc, dispatcher, appData, keyboard) {
  PolyToolBase.prototype.onKeyEvent.call(this, doc, dispatcher, appData, keyboard);
  if (!keyboard.isPressed(KeyboardHandler.Alt)) this.smoothPointFromAltDrag = false;
  this.updatePathCursor(doc, dispatcher, appData, keyboard, this.lastPointerState)
};
PenTool.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.ensurePathEditingPrefs(dispatcher, appData);
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y),
    hitTestResult, selectionHits;
  docPoint.x = Math.round(docPoint.x);
  docPoint.y = Math.round(docPoint.y);
  var snappedPoint = snapPointToGuides(doc, docPoint, appData),
    pathTuple = doc.getPaths(this.pathEditMode == 0),
    pathList = pathTuple[0],
    selectedPathIndices = pathTuple[1],
    activePath = pathList[selectedPathIndices.pop()],
    vectorMask = activePath ? activePath.add.vmsk : null,
    hitRadius = 4 * getDevicePixelRatio() / doc.pathViewport.zoomScale;
  if (vectorMask) hitTestResult = hitTestPoint(vectorMask.pathRecords, docPoint, true, hitRadius);
  var altPressed = keyboard.isPressed(KeyboardHandler.Alt),
    ctrl = keyboard.isPressed(KeyboardHandler.Ctrl);
  if (this.pathEditMode == 1 && (vectorMask == null || vectorMask.selectedComponents.length == 0 && hitTestResult.idx == -1)) {
    activePath = this.createShapeLayerForNewPath(doc, dispatcher, appData);
    vectorMask = activePath.add.vmsk
  }
  var keyOrigins = activePath.add.vogk;
  this.pathMaskBeforeDrag = vectorMask.clone();
  this.keyOriginsJsonBefore = JSON.stringify(keyOrigins);
  var pathRecords = vectorMask.pathRecords;
  selectionHits = selectPointsInRect(vectorMask.pathRecords, new Rect(docPoint.x - hitRadius, docPoint.y - hitRadius, hitRadius * 2, hitRadius * 2), vectorMask.selectedComponents);
  hitTestResult = hitTestPoint(vectorMask.pathRecords, docPoint, true, hitRadius);
  var totalHitCount = selectionHits[0].length + selectionHits[1].length + selectionHits[2].length;
  if (hitTestResult.idx != -1 && selectionHits[0].length == 0 && hitTestResult.segmentIndex != null) {
    this.insertAnchorOnSegment(vectorMask, hitTestResult, snappedPoint)
  } else if (totalHitCount != 0 && altPressed && !ctrl) {
    this.convertAnchorAtHit(vectorMask, selectionHits)
  } else if (totalHitCount != 0 && ctrl) {
    this.beginHandleDrag(vectorMask, selectionHits, snappedPoint)
  } else if (selectionHits[0].length == 1 && pathRecords[selectionHits[0][0] - 1] && pathRecords[selectionHits[0][0] - 1].fillRule == null && !ctrl) {
    this.removeAnchorAtHit(vectorMask, selectionHits)
  } else {
    if (this.appendAnchorOrClosePath(doc, activePath, vectorMask, keyOrigins, docPoint, snappedPoint, keyboard)) return
  }
  this.applyPathMaskToLayer(doc, activePath.idx, vectorMask, keyOrigins);
  doc.dirty = true
};
/** Start a fresh shape layer (pathEditMode 1) when nothing is hit; returns its path entry. */
PenTool.prototype.createShapeLayerForNewPath = function(doc, dispatcher, appData) {
  var createLayerEvent = new AppEvent(EventType.historyGrouped, true),
    emptyShapeDescriptor = buildKeyOriginDescriptor("customShape", [0, 0, 1, 1], null, null, null, "--");
  createLayerEvent.data = buildShapePathAction(emptyShapeDescriptor, appData);
  dispatcher.dispatch(createLayerEvent);
  var pathTuple = doc.getPaths(true),
    pathList = pathTuple[0],
    selectedPathIndices = pathTuple[1],
    activePath = pathList[selectedPathIndices.pop()];
  activePath.add.vmsk.pathRecords = activePath.add.vmsk.pathRecords.slice(0, 2);
  return activePath
};
/** Insert a new anchor into the curve segment under the pointer. */
PenTool.prototype.insertAnchorOnSegment = function(vectorMask, hitTestResult, snappedPoint) {
  var pathRecords = vectorMask.pathRecords,
    recordIdx = recordIndexForSubpath(pathRecords, hitTestResult.idx);
  while (pathRecords[recordIdx].length <= hitTestResult.segmentIndex) {
    hitTestResult.segmentIndex -= pathRecords[recordIdx].length;
    recordIdx += pathRecords[recordIdx].length + 1
  }
  pathRecords[recordIdx].length++;
  pathRecords.splice(recordIdx + 2 + hitTestResult.segmentIndex, 0, {
    type: 4,
    cp1: snappedPoint.clone(),
    anchor: snappedPoint.clone(),
    anchorOut: snappedPoint.clone()
  });
  vectorMask.selectedComponents = [recordIdx + 2 + hitTestResult.segmentIndex]
};
/** Alt-click: toggle the hit anchor between corner and smooth. */
PenTool.prototype.convertAnchorAtHit = function(vectorMask, selectionHits) {
  var selectedRecordIdx = 0;
  for (var hitKindIdx = 0; hitKindIdx < 3; hitKindIdx++)
    if (selectionHits[hitKindIdx].length != 0) {
      selectedRecordIdx = selectionHits[hitKindIdx][0];
      this.swapHandlesWhileDragging = hitKindIdx == 1;
      break
    } if (selectionHits[0].length != 0) {
    var lastRecordIdx = vectorMask.pathRecords.length - 1,
      pathKnot = vectorMask.pathRecords[selectedRecordIdx];
    pathKnot.anchorOut = pathKnot.anchor.clone();
    var knotTypeBase = pathKnot.type >= 3 ? 3 : 0;
    if (selectedRecordIdx != lastRecordIdx) {
      pathKnot.cp1 = pathKnot.anchor.clone();
      pathKnot.type = knotTypeBase + 1;
      this.smoothPointFromAltDrag = true
    } else pathKnot.type = knotTypeBase + 2
  }
  vectorMask.selectedComponents = [selectedRecordIdx]
};
/** Ctrl-click on a point: select it and start dragging that anchor or handle. */
PenTool.prototype.beginHandleDrag = function(vectorMask, selectionHits, snappedPoint) {
  var selectedRecordIdx = 0,
    hitKind = 0;
  for (var hitKindIdx = 0; hitKindIdx < 3; hitKindIdx++)
    if (selectionHits[hitKindIdx].length != 0) {
      selectedRecordIdx = selectionHits[hitKindIdx][0];
      hitKind = hitKindIdx;
      this.swapHandlesWhileDragging = hitKindIdx == 1;
      break
    }
  vectorMask.selectedComponents = [selectedRecordIdx];
  this.penDragAnchor = snappedPoint.clone();
  this.isDraggingPathHandle = true;
  this.activeHandleHitKind = hitKind
};
/** Click on an existing interior anchor: delete it from its subpath. */
PenTool.prototype.removeAnchorAtHit = function(vectorMask, selectionHits) {
  var pathRecords = vectorMask.pathRecords,
    selectedRecordIdx = selectionHits[0][0],
    recordIdx = subpathIndexForRecord(pathRecords, selectedRecordIdx);
  recordIdx = recordIndexForSubpath(pathRecords, recordIdx);
  var subpathEndIdx = recordIdx + pathRecords[recordIdx].length;
  if (selectedRecordIdx != subpathEndIdx) {
    pathRecords[recordIdx].length--;
    pathRecords.splice(selectedRecordIdx, 1);
    subpathEndIdx--
  }
  vectorMask.selectedComponents = [subpathEndIdx]
};
/**
 * Append a new anchor to the active subpath (or start a new one), or close the
 * subpath when the click lands on its first anchor. Returns true when the
 * close-path branch already applied the mask and onMouseDown should stop.
 */
PenTool.prototype.appendAnchorOrClosePath = function(doc, activePath, vectorMask, keyOrigins, docPoint, snappedPoint, keyboard) {
  var pathRecords = vectorMask.pathRecords,
    subpathCount = countSubpaths(pathRecords),
    hitRadius = 4 * getDevicePixelRatio() / doc.pathViewport.zoomScale,
    insertIdx = 0;
  if (vectorMask.selectedComponents.length != 1) {
    vectorMask.C = [subpathCount];
    pathRecords.push({
      type: 3,
      length: 1,
      fillRule: [1, 2, 3, 0][this.pathFillRuleIndex],
      subpathHeaderFlags: 0,
      subpathUint32A: 0,
      subpathUint32B: 0
    });
    insertIdx = pathRecords.length;
    keyOrigins.push(createEmptyKeyOrigin())
  } else {
    var selectedRecordIdx = vectorMask.selectedComponents[0],
      subpathIdx = subpathIndexForRecord(pathRecords, selectedRecordIdx),
      recordIdx = recordIndexForSubpath(pathRecords, subpathIdx);
    selectedRecordIdx = recordIdx + pathRecords[recordIdx].length;
    if (Point.dist(docPoint, pathRecords[recordIdx + 1].anchor) < hitRadius) {
      pathRecords[recordIdx].type = 0;
      vectorMask.selectedComponents = [recordIdx + 1];
      this.penDragAnchor = snappedPoint;
      this.isClosingPath = true;
      this.applyPathMaskToLayer(doc, activePath.idx, vectorMask, keyOrigins);
      doc.dirty = true;
      return true
    }
    pathRecords[recordIdx].length++;
    insertIdx = selectedRecordIdx + 1;
    if (selectedRecordIdx == recordIdx + 1 && pathRecords[recordIdx].length != 2) insertIdx = recordIdx + 1
  }
  if (keyboard.isPressed(KeyboardHandler.Shift) && pathRecords[insertIdx - 1] && pathRecords[insertIdx - 1].anchor) snappedPoint = constrainEndpointToAxis(pathRecords[insertIdx - 1].anchor, snappedPoint);
  pathRecords.splice(insertIdx, 0, {
    type: 4,
    cp1: snappedPoint.clone(),
    anchor: snappedPoint.clone(),
    anchorOut: snappedPoint.clone()
  });
  vectorMask.selectedComponents = [insertIdx];
  this.penDragAnchor = snappedPoint;
  return false
};
PenTool.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (this.pathMaskBeforeDrag == null) {
    this.updatePathCursor(doc, dispatcher, appData, keyboard, pointerState);
    return
  }
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y),
    snappedPoint = snapPointToGuides(doc, docPoint, appData),
    pathTuple = doc.getPaths(this.pathEditMode == 0),
    pathList = pathTuple[0],
    selectedPathIndices = pathTuple[1],
    activePath = pathList[selectedPathIndices.pop()],
    vectorMask = activePath.add.vmsk,
    pathRecords = vectorMask.pathRecords,
    selectedKnot = pathRecords[vectorMask.selectedComponents[0]];
  if (this.isDraggingPathHandle) {
    if (keyboard.isPressed(KeyboardHandler.Shift)) snappedPoint = constrainEndpointToAxis(this.penDragAnchor, snappedPoint);
    var dragDx = snappedPoint.x - this.penDragAnchor.x,
      dragDy = snappedPoint.y - this.penDragAnchor.y;
    if (this.activeHandleHitKind == 0) {
      selectedKnot.anchor.x += dragDx;
      selectedKnot.anchor.y += dragDy;
      selectedKnot.cp1.x += dragDx;
      selectedKnot.cp1.y += dragDy;
      selectedKnot.anchorOut.x += dragDx;
      selectedKnot.anchorOut.y += dragDy
    } else {
      var handlePt = this.activeHandleHitKind == 1 ? selectedKnot.cp1 : selectedKnot.anchorOut,
        otherPt = this.activeHandleHitKind == 1 ? selectedKnot.anchorOut : selectedKnot.cp1;
      handlePt.x += dragDx;
      handlePt.y += dragDy;
      if (selectedKnot.type == 1 || selectedKnot.type == 4) {
        var distH = Point.dist(handlePt, selectedKnot.anchor),
          distO = Point.dist(otherPt, selectedKnot.anchor);
        if (distO != 0) {
          otherPt.x = selectedKnot.anchor.x - (handlePt.x - selectedKnot.anchor.x) * (distO / distH);
          otherPt.y = selectedKnot.anchor.y - (handlePt.y - selectedKnot.anchor.y) * (distO / distH)
        }
      }
    }
    this.penDragAnchor = snappedPoint.clone();
    this.applyPathMaskToLayer(doc, activePath.idx, vectorMask, activePath.add.vogk);
    doc.dirty = true;
    return
  }
  if (keyboard.isPressed(KeyboardHandler.Space)) {
    if (keyboard.isPressed(KeyboardHandler.Shift)) snappedPoint = constrainEndpointToAxis(this.penDragAnchor, snappedPoint);
    var anchorOutOffset = selectedKnot.anchor.subtract(selectedKnot.anchorOut),
      cp1Offset = selectedKnot.cp1.subtract(selectedKnot.anchor);
    selectedKnot.anchorOut = snappedPoint;
    selectedKnot.anchor = snappedPoint.add(anchorOutOffset);
    selectedKnot.cp1 = selectedKnot.anchor.add(cp1Offset)
  } else {
    if (keyboard.isPressed(KeyboardHandler.Shift)) snappedPoint = constrainEndpointToAxis(selectedKnot.anchor, snappedPoint);
    if (this.swapHandlesWhileDragging) {
      var swappedHandle = selectedKnot.cp1;
      selectedKnot.cp1 = selectedKnot.anchorOut;
      selectedKnot.anchorOut = swappedHandle
    }
    if (this.isClosingPath) {
      var closeDist = Point.dist(selectedKnot.anchor, snappedPoint),
        handleRatio = closeDist == 0 ? 0 : Point.dist(selectedKnot.anchor, selectedKnot.anchorOut) / closeDist;
      selectedKnot.anchorOut.x = selectedKnot.anchor.x + handleRatio * (snappedPoint.x - selectedKnot.anchor.x);
      selectedKnot.anchorOut.y = selectedKnot.anchor.y + handleRatio * (snappedPoint.y - selectedKnot.anchor.y)
    } else selectedKnot.anchorOut = snappedPoint;
    if (keyboard.isPressed(KeyboardHandler.Alt) && !this.smoothPointFromAltDrag && !keyboard.isPressed(KeyboardHandler.Ctrl)) selectedKnot.type = 5;
    else {
      selectedKnot.type = 4;
      selectedKnot.cp1 = selectedKnot.anchor.add(selectedKnot.anchor.subtract(snappedPoint))
    }
    this.penDragAnchor = snappedPoint;
    if (this.swapHandlesWhileDragging) {
      var swappedHandle = selectedKnot.cp1;
      selectedKnot.cp1 = selectedKnot.anchorOut;
      selectedKnot.anchorOut = swappedHandle
    }
  }
  this.applyPathMaskToLayer(doc, activePath.idx, vectorMask, activePath.add.vogk);
  doc.dirty = true
};
PenTool.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (this.pathMaskBeforeDrag == null) return;
  var pathTuple = doc.getPaths(this.pathEditMode == 0),
    pathList = pathTuple[0],
    selectedPathIndices = pathTuple[1],
    activePath = pathList[selectedPathIndices.pop()],
    vectorMask = activePath.add.vmsk,
    keyOrigins = activePath.add.vogk;
  if (this.isClosingPath) {
    vectorMask.selectedComponents = [];
    this.applyPathMaskToLayer(doc, activePath.idx, vectorMask, activePath.add.vogk)
  }
  var moveAnchor = this.isDraggingPathHandle;
  this.pushPathHistory(doc, this.isClosingPath ? "Close Path" : moveAnchor ? "Move" : "Add Anchor Point", activePath.idx, this.pathMaskBeforeDrag, vectorMask.clone(), null, this.keyOriginsJsonBefore, JSON.stringify(keyOrigins));
  this.isClosingPath = false;
  this.swapHandlesWhileDragging = false;
  this.smoothPointFromAltDrag = false;
  this.isDraggingPathHandle = false;
  this.activeHandleHitKind = 0;
  this.pathMaskBeforeDrag = null;
  this.updatePathCursor(doc, dispatcher, appData, keyboard, pointerState)
};
PenTool.prototype.applyAction = function(actionPayload, dispatcher, appData, keyboard, pointerState) {
  this.pathEditMode = actionPayload.tmode;
  this.pathFillRuleIndex = actionPayload.binop
};


}

export function PathSelectTool() {
  PolyToolBase.call(this, "tools.pathSelect", ToolId.TOOL_PATH_SELECT, "tools/pselect");
  this.dragStartDocPoint = null;
  this.isDraggingPathSelection = false;
  this.activeVectorLayerEntry = null;
  this.pathMaskBeforeDrag = null;
  this.pathMaskAltClone = null;
  this.keyOriginsJsonBefore = null;
  this.keyOriginsJsonAltClone = null;
  this.selectionBoundsAtDrag = null;
  this.textOnPathCurveDragState = null;
  this.pathKnotAtPointer = null
};


function installPathSelectToolPrototype() {
PathSelectTool.prototype.wantsInput = function(pointerState) {
  return pointerState.isDown;
};
PathSelectTool.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y),
    pathTuple = doc.getPaths(),
    pathList = pathTuple[0],
    selectedPathIndices = pathTuple[1],
    hitPathEntry, hitSubpathIdx;
  for (var pathIdx = 0; pathIdx < selectedPathIndices.length; pathIdx++) {
    var pathEntry = pathList[selectedPathIndices[pathIdx]],
      vectorMask = pathEntry.add.vmsk,
      hitRecordIdx = hitTestPoint(vectorMask.pathRecords, docPoint).idx;
    if (hitRecordIdx != -1) {
      this.activeVectorLayerEntry = hitPathEntry = pathEntry;
      hitSubpathIdx = hitRecordIdx
    }
    for (var textOnPathParamIdx = 0; textOnPathParamIdx < vectorMask.textOnPathParams.length; textOnPathParamIdx++) {
      var pointOnPath = pointOnPathAtParam(vectorMask.pathRecords, vectorMask.textOnPathParams[textOnPathParamIdx]);
      if (pointOnPath == null) continue;
      var distToPath = Point.dist(pointOnPath, docPoint);
      if (distToPath < 4 * getDevicePixelRatio() / doc.pathViewport.zoomScale) {
        var textShape = doc.layers[pathEntry.idx - 1e6].add.TySh,
          curveBlock = textShape.engineData.Curve,
          textTransform = textShape.transform,
          reversedSaved = curveBlock.Reversed;
        curveBlock.Reversed = false;
        var curveBlock = TextLayout.computePathData(textShape.engineData.Curve);
        curveBlock.Reversed = reversedSaved;
        transformCoordPairs(curveBlock[0], textTransform, curveBlock[0]);
        this.textOnPathCurveDragState = [curveBlock, textOnPathParamIdx, textTransform.a * textTransform.d - textTransform.b * textTransform.c];
        this.activeVectorLayerEntry = hitPathEntry = pathEntry;
        hitSubpathIdx = 0
      }
    }
    if (this.textOnPathCurveDragState) break
  }
  if (hitPathEntry != null) {
    var vectorMask = hitPathEntry.add.vmsk;
    vectorMask.selectedComponents = [];
    var componentIdxInSelection = vectorMask.C.indexOf(hitSubpathIdx);
    if (keyboard.isPressed(KeyboardHandler.Shift)) {
      if (componentIdxInSelection == -1) {
        vectorMask.C.push(hitSubpathIdx);
        this.isDraggingPathSelection = true
      } else vectorMask.C.splice(componentIdxInSelection, 1)
    } else {
      if (componentIdxInSelection == -1) vectorMask.C = [hitSubpathIdx];
      this.isDraggingPathSelection = true
    }
    this.selectionBoundsAtDrag = boundsOfPathRecords(vectorMask.pathRecords, vectorMask.C)
  }
  this.dragStartDocPoint = docPoint;
  this.pathKnotAtPointer = new AxisDragAnchor(docPoint);
  doc.stateChanged = true;
  doc.dirty = true
};
PathSelectTool.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (this.dragStartDocPoint == null) return;
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
  if (this.isDraggingPathSelection) {
    docPoint = this.pathKnotAtPointer.constrainAxisDragPoint(docPoint, keyboard);
    var activePathEntry = this.activeVectorLayerEntry;
    if (this.pathMaskBeforeDrag == null) {
      this.pathMaskBeforeDrag = this.pathMaskAltClone = activePathEntry.add.vmsk.clone();
      this.keyOriginsJsonBefore = this.keyOriginsJsonAltClone = JSON.stringify(activePathEntry.add.vogk);
      if (keyboard.isPressed(KeyboardHandler.Alt)) {
        var altPathMask = this.pathMaskBeforeDrag.clone(),
          altKeyOrigins = JSON.parse(this.keyOriginsJsonBefore),
          altSelectionState = PolyToolBase.clonePathSelectionState(altPathMask, altKeyOrigins);
        PolyToolBase.mergePathSegments(altSelectionState, altPathMask, altKeyOrigins);
        this.pathMaskAltClone = altPathMask;
        this.keyOriginsJsonAltClone = JSON.stringify(altKeyOrigins)
      }
    }
    var pathMaskClone = this.pathMaskAltClone.clone(),
      keyOrigins = JSON.parse(this.keyOriginsJsonAltClone);
    if (this.textOnPathCurveDragState) {
      var textOnPathState = this.textOnPathCurveDragState,
        pathCoords = textOnPathState[0][0],
        nearestVertexIdx = findNearestVertexIndex(pathCoords, docPoint.x, docPoint.y);
      pathMaskClone.textOnPathParams[textOnPathState[1]] = textOnPathState[0][1][nearestVertexIdx];
      var coordX = pathCoords[nearestVertexIdx * 2],
        coordY = pathCoords[nearestVertexIdx * 2 + 1],
        crossProduct = (pathCoords[nearestVertexIdx * 2 + 2] - coordX) * (docPoint.y - coordY) - (pathCoords[nearestVertexIdx * 2 + 3] - coordY) * (docPoint.x - coordX);
      if (textOnPathState[2] < 0) crossProduct = -crossProduct;
      pathMaskClone.reversed = crossProduct > 0
    } else {
      var selectionBounds = this.selectionBoundsAtDrag.clone(),
        boundsX = selectionBounds.x,
        boundsY = selectionBounds.y;
      selectionBounds.offset(docPoint.x - this.dragStartDocPoint.x, docPoint.y - this.dragStartDocPoint.y);
      selectionBounds.x = Math.round(selectionBounds.x);
      selectionBounds.y = Math.round(selectionBounds.y);
      var cornerSnap = snapRectCornersToGuides(doc, selectionBounds, appData),
        translateMatrix = new Matrix2D(1, 0, 0, 1, selectionBounds.x - boundsX + cornerSnap[0], selectionBounds.y - boundsY + cornerSnap[1]);
      transformPathRecordCoords(pathMaskClone.pathRecords, translateMatrix, pathMaskClone.C);
      transformKeyOriginsWithMatrix(keyOrigins, matrix2DToHomography(translateMatrix), pathMaskClone.C);
      updateLayerDragPositions(doc, selectionBounds, cornerSnap)
    }
    this.applyPathMaskToLayer(doc, activePathEntry.idx, pathMaskClone, keyOrigins)
  } else {
    var dragStart = this.dragStartDocPoint;
    doc.toolOverlayState.overlayTransform = rectToPathOutline(new Rect(dragStart.x, dragStart.y, docPoint.x - dragStart.x, docPoint.y - dragStart.y));
    doc.dirty = true
  }
};
PathSelectTool.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (this.dragStartDocPoint == null) return;
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y),
    activePathEntry = this.activeVectorLayerEntry,
    vectorMask = activePathEntry ? activePathEntry.add.vmsk : null;
  if (this.isDraggingPathSelection) {
    var keyOriginsJsonAfter = JSON.stringify(activePathEntry.add.vogk);
    if (!this.dragStartDocPoint.equals(docPoint)) this.pushPathHistory(doc, "Move Paths", activePathEntry.idx, this.pathMaskBeforeDrag, vectorMask, null, this.keyOriginsJsonBefore, keyOriginsJsonAfter);
    if (doc != null && doc.toolOverlayState.snapGuides) {
      doc.toolOverlayState.snapGuides = null;
      doc.dirty = true
    }
  } else {
    if (vectorMask) {
      var dragStart = this.dragStartDocPoint,
        marqueeRect = new Rect(dragStart.x, dragStart.y, docPoint.x - dragStart.x, docPoint.y - dragStart.y),
        subpathsInRect = subpathIndicesIntersectingRect(vectorMask.pathRecords, marqueeRect);
      if (keyboard.isPressed(KeyboardHandler.Shift)) {
        for (var subpathIdx = 0; subpathIdx < subpathsInRect.length; subpathIdx++)
          if (vectorMask.C.indexOf(subpathsInRect[subpathIdx]) == -1) vectorMask.C.push(subpathsInRect[subpathIdx])
      } else vectorMask.C = subpathsInRect
    }
    doc.toolOverlayState.overlayTransform = null;
    doc.dirty = true
  }
  this.dragStartDocPoint = null;
  this.pathMaskBeforeDrag = null;
  this.textOnPathCurveDragState = null;
  this.isDraggingPathSelection = false;
  this.pathKnotAtPointer = null
};
PathSelectTool.prototype.onDocumentStateChange = function(doc, dispatcher, appData, keyboard) {
  PolyToolBase.prototype.onDocumentStateChange.call(this, doc, dispatcher, appData, keyboard);
  if (appData.activeToolId != this.id) return;
  if (doc.selectedLayerIndices.length == 0) return;
  var pathTuple = doc.getPaths(),
    pathList = pathTuple[0],
    selectedPathIndices = pathTuple[1];
  if (selectedPathIndices.length == 0) return;
  var activePath = pathList[selectedPathIndices[0]],
    vectorMask = activePath.add.vmsk,
    vectorStroke = activePath.add.vstk,
    keyOrigins = activePath.add.vogk,
    pathPanelEvent = new AppEvent(EventType.uiDispatch, true);
  pathPanelEvent.data = {
    dispatchKind: UiCommand.forwardActiveToolGesture,
    routingChannel: this.id,
    subAction: "main",
    vectorMask: vectorMask ? vectorMask : null,
    KeyOrigins: keyOrigins
  };
  dispatcher.dispatch(pathPanelEvent)
};
PathSelectTool.prototype.applyAction = function(actionPayload, dispatcher, doc, keyboard, pointerState) {
  var menuState = actionPayload.pathEditPayload;
  if (menuState.vectorMask) {
    var pathPair = doc.getPaths(),
      workPaths = pathPair[0],
      selectedPathIndices = pathPair[1];
    if (selectedPathIndices.length == 0) return;
    var pathEntry = workPaths[selectedPathIndices[0]],
      vectorMaskBefore = pathEntry.add.vmsk.clone(),
      keyOriginsJsonBefore = JSON.stringify(pathEntry.add.vogk),
      mergedPathMask = menuState.vectorMask;
    this.applyPathMaskToLayer(doc, pathEntry.idx, mergedPathMask, menuState.KeyOrigins);
    var historyLabelKey = "pathOps.merge";
    if (vectorMaskBefore.pathRecords.length == mergedPathMask.pathRecords.length) historyLabelKey = vectorMaskBefore.C[0] == mergedPathMask.C[0] ? "Fill Rule" : "Path Order";
    this.pushPathHistory(doc, historyLabelKey, pathEntry.idx, vectorMaskBefore, mergedPathMask, null, keyOriginsJsonBefore, JSON.stringify(menuState.KeyOrigins))
  }
};


}

export function DirectSelectTool() {
  PolyToolBase.call(this, "tools.directSelect", ToolId.TOOL_DIRECT_SELECT, "tools/dselect");
  this.activeAnchorIndex = -1;
  this.activeHandleKind = -1;
  this.anchorDragStartPoint = null;
  this.dragStartDocPoint = null;
  this.activeVectorLayerEntry = null;
  this.pathMaskBeforeDrag = null;
  this.keyOriginsJsonBefore = null;
  this.activeDocument = null;
  this.lastAnchorClickTime = 0;
  this.directSelectPrefs = {
    psnap: false
  };
  this.pathKnotAtPointer = null
};


function installDirectSelectToolPrototype() {
DirectSelectTool.prototype.wantsInput = function(pointerState) {
  return pointerState.isDown;
};
DirectSelectTool.prototype.applyAction = function(prefsPayload) {
  this.directSelectPrefs = prefsPayload
};
DirectSelectTool.prototype.handleInput = function(event, dispatcher, doc, keyboard, appData) {
  if (event.actionKind == "crnr") {
    if (doc == null) return;
    var pathTuple = doc.getPaths(),
      pathList = pathTuple[0],
      selectedPathIndices = pathTuple[1];
    if (selectedPathIndices.length == 0) {
      alert("No paths selected");
      return
    }
    var activePath = pathList[selectedPathIndices[0]],
      vectorMask = activePath.add.vmsk;
    if (vectorMask.selectedComponents.length == 0) {
      alert("No corners selected");
      return
    }
    for (var componentIdx = 0; componentIdx < vectorMask.selectedComponents.length; componentIdx++) {
      var pathKnot = vectorMask.pathRecords[vectorMask.selectedComponents[componentIdx]];
      if (!pathKnot.anchor.equals(pathKnot.anchorOut) || !pathKnot.anchor.equals(pathKnot.cp1)) {
        alert("Only sharp corners can be rounded");
        return
      }
    }
    if (this.pathMaskBeforeDrag == null) {
      this.pathMaskBeforeDrag = activePath.add.vmsk.clone();
      this.keyOriginsJsonBefore = JSON.stringify(activePath.add.vogk);
      this.activeVectorLayerEntry = activePath;
      this.activeDocument = doc
    }
    var cornerRadiusEvent = new AppEvent(EventType.uiDispatch, true);
    cornerRadiusEvent.data = {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "cornerradius",
      initialValue: 5,
      onDialogComplete: this.onCornerRadiusDialogResult.bind(this)
    };
    dispatcher.dispatch(cornerRadiusEvent)
  } else PolyToolBase.prototype.handleInput.call(this, event, dispatcher, doc, keyboard, appData)
};
DirectSelectTool.prototype.onCornerRadiusDialogResult = function(dialogResult) {
  if (dialogResult == "confirm") {
    var doc = this.activeDocument,
      vectorLayerEntry = this.activeVectorLayerEntry,
      vectorMaskAfter = vectorLayerEntry.add.vmsk,
      keyOriginsAfter = vectorLayerEntry.add.vogk;
    this.pushPathHistory(doc, "properties.cornerRadius", vectorLayerEntry.idx, this.pathMaskBeforeDrag, vectorMaskAfter, null, this.keyOriginsJsonBefore, JSON.stringify(keyOriginsAfter));
    this.resetPathEditDragState();
    return
  }
  var vectorMask = this.pathMaskBeforeDrag.clone(),
    keyOrigins = JSON.parse(this.keyOriginsJsonBefore),
    selectedComponents = vectorMask.selectedComponents;
  if (dialogResult == "cancel") {} else {
    var processedSubpaths = [];
    for (var componentIdx = 0; componentIdx < selectedComponents.length; componentIdx++) {
      var componentRef = selectedComponents[componentIdx],
        subpathIndex = subpathIndexForRecord(vectorMask.pathRecords, componentRef, true),
        addedCornerCount = 0;
      if (processedSubpaths.indexOf(subpathIndex) != -1) continue;
      processedSubpaths.push(subpathIndex);
      var recordIndex = recordIndexForSubpath(vectorMask.pathRecords, subpathIndex, true),
        subpathLength = vectorMask.pathRecords[recordIndex].length,
        cornerRadii = [];
      for (var knotIdx = 0; knotIdx < subpathLength; knotIdx++) {
        var cornerRadius = vectorMask.selectedComponents.indexOf(recordIndex + knotIdx + 1) == -1 ? 0 : dialogResult;
        cornerRadii.push(cornerRadius);
        if (cornerRadius != 0) addedCornerCount++
      }
      roundCornersOnSubpath(vectorMask.pathRecords, recordIndex, cornerRadii);
      for (var adjustIdx = 0; adjustIdx < selectedComponents.length; adjustIdx++)
        if (selectedComponents[adjustIdx] > recordIndex + subpathLength) selectedComponents[adjustIdx] += addedCornerCount
    }
    this.syncKeyOriginsForSelectedAnchors(vectorMask, keyOrigins);
    vectorMask.selectedComponents = []
  }
  this.applyPathMaskToLayer(this.activeDocument, this.activeVectorLayerEntry.idx, vectorMask, keyOrigins);
  if (dialogResult == "cancel") this.resetPathEditDragState()
};
DirectSelectTool.prototype.disable = function(doc, dispatcher, appData, keyboard) {
  this.clearAnchorHighlightOverlay(doc)
};
DirectSelectTool.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.clearAnchorHighlightOverlay(doc);
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y),
    activePathEntry, vectorMask, selectionHits;
  this.anchorDragStartPoint = docPoint.clone();
  var pathTuple = doc.getPaths(),
    pathList = pathTuple[0],
    selectedPathIndices = pathTuple[1];
  if (selectedPathIndices.length == 0) return;
  var hitRadius = 4 * getDevicePixelRatio() / doc.pathViewport.zoomScale,
    hitRect = new Rect(docPoint.x - hitRadius, docPoint.y - hitRadius, hitRadius * 2, hitRadius * 2);
  for (var pathIdx = 0; pathIdx < selectedPathIndices.length; pathIdx++) {
    activePathEntry = this.activeVectorLayerEntry = pathList[selectedPathIndices[pathIdx]];
    vectorMask = activePathEntry.add.vmsk;
    selectionHits = selectPointsInRect(vectorMask.pathRecords, hitRect);
    if (selectionHits[0].length + selectionHits[1].length + selectionHits[2].length != 0) break
  }
  var kindAlreadySelected = [false, false, false];
  for (var hitKindIdx = 0; hitKindIdx < 3; hitKindIdx++) {
    for (var hitIdx = 0; hitIdx < selectionHits[hitKindIdx].length; hitIdx++)
      if (vectorMask.selectedComponents.indexOf(selectionHits[hitKindIdx][hitIdx]) != -1) {
        selectionHits[hitKindIdx] = [selectionHits[hitKindIdx][hitIdx]];
        kindAlreadySelected[hitKindIdx] = true;
        break
      }
  }
  if (selectionHits[0].length != 0 && (kindAlreadySelected[0] || !kindAlreadySelected[1] && !kindAlreadySelected[2])) {
    var anchorRecordIdx = selectionHits[0][0],
      componentIdxInSelection = vectorMask.selectedComponents.indexOf(anchorRecordIdx);
    if (keyboard.isPressed(KeyboardHandler.Shift)) {
      if (componentIdxInSelection == -1) vectorMask.selectedComponents.push(anchorRecordIdx);
      else {
        vectorMask.selectedComponents.splice(componentIdxInSelection, 1);
        doc.dirty = true;
        return
      }
    } else if (componentIdxInSelection == -1) vectorMask.selectedComponents = [anchorRecordIdx];
    this.activeAnchorIndex = anchorRecordIdx;
    this.activeHandleKind = 0
  } else if (selectionHits[1].length != 0 && (kindAlreadySelected[1] || !kindAlreadySelected[2])) {
    this.activeAnchorIndex = selectionHits[1][0];
    this.activeHandleKind = 1
  } else if (selectionHits[2].length != 0) {
    this.activeAnchorIndex = selectionHits[2][0];
    this.activeHandleKind = 2
  } else {
    var hitTestResult = hitTestPoint(vectorMask.pathRecords, docPoint, true, hitRadius);
    if (hitTestResult.idx == -1) this.dragStartDocPoint = docPoint;
    else {
      vectorMask.C = [hitTestResult.idx];
      vectorMask.selectedComponents = []
    }
  }
  if (this.pathMaskBeforeDrag == null) {
    this.pathMaskBeforeDrag = activePathEntry.add.vmsk.clone();
    this.keyOriginsJsonBefore = JSON.stringify(activePathEntry.add.vogk)
  }
  this.pathKnotAtPointer = new AxisDragAnchor(docPoint);
  doc.dirty = true
};
DirectSelectTool.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (doc == null) return;
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y),
    activePathEntry = this.activeVectorLayerEntry;
  if (this.activeAnchorIndex != -1) {
    var maskClone = this.pathMaskBeforeDrag.clone(),
      keyOrigins = activePathEntry.add.vogk,
      handlePoint = maskClone.pathRecords[this.activeAnchorIndex];
    handlePoint = [handlePoint.anchor, handlePoint.cp1, handlePoint.anchorOut][this.activeHandleKind];
    if (keyboard.isPressed(KeyboardHandler.Shift)) {
      docPoint = this.pathKnotAtPointer.constrainAxisDragPoint(docPoint, keyboard);
      docPoint.x += handlePoint.x - this.anchorDragStartPoint.x;
      docPoint.y += handlePoint.y - this.anchorDragStartPoint.y
    } else {
      if (this.directSelectPrefs.psnap) {
        docPoint.x = Math.round(docPoint.x);
        docPoint.y = Math.round(docPoint.y)
      }
      docPoint = snapPointToGuides(doc, docPoint, appData)
    }
    if (this.activeHandleKind == 0) {
      var translateMatrix = new Matrix2D(1, 0, 0, 1, docPoint.x - handlePoint.x, docPoint.y - handlePoint.y);
      transformPathRecordCoords(maskClone.pathRecords, translateMatrix, null, maskClone.selectedComponents)
    } else {
      var pathKnot = maskClone.pathRecords[this.activeAnchorIndex],
        cp1Point = pathKnot.cp1,
        anchorOutPoint = pathKnot.anchorOut;
      if (this.activeHandleKind == 2) {
        cp1Point = pathKnot.anchorOut;
        anchorOutPoint = pathKnot.cp1
      }
      cp1Point.setXY(docPoint.x, docPoint.y);
      if (pathKnot.type == 1 || pathKnot.type == 4) {
        var distCp1 = Point.dist(cp1Point, pathKnot.anchor),
          distAnchorOut = Point.dist(anchorOutPoint, pathKnot.anchor);
        if (distAnchorOut != 0) {
          anchorOutPoint.x = pathKnot.anchor.x - (cp1Point.x - pathKnot.anchor.x) * (distAnchorOut / distCp1);
          anchorOutPoint.y = pathKnot.anchor.y - (cp1Point.y - pathKnot.anchor.y) * (distAnchorOut / distCp1)
        }
      }
    }
    this.syncKeyOriginsForSelectedAnchors(maskClone, keyOrigins);
    this.applyPathMaskToLayer(doc, activePathEntry.idx, maskClone, keyOrigins)
  } else if (this.dragStartDocPoint != null) {
    var dragStart = this.dragStartDocPoint;
    doc.toolOverlayState.overlayTransform = rectToPathOutline(new Rect(dragStart.x, dragStart.y, docPoint.x - dragStart.x, docPoint.y - dragStart.y));
    doc.dirty = true
  } else {
    var pathTuple = doc.getPaths(),
      pathList = pathTuple[0],
      selectedPathIndices = pathTuple[1],
      vectorMask, selectionHits;
    if (selectedPathIndices.length == 0) return;
    var hitRadius = 4 * getDevicePixelRatio() / doc.pathViewport.zoomScale,
      hitRect = new Rect(docPoint.x - hitRadius, docPoint.y - hitRadius, hitRadius * 2, hitRadius * 2);
    for (var pathIdx = 0; pathIdx < selectedPathIndices.length; pathIdx++) {
      activePathEntry = pathList[selectedPathIndices[pathIdx]];
      vectorMask = activePathEntry.add.vmsk;
      selectionHits = selectPointsInRect(vectorMask.pathRecords, hitRect);
      if (selectionHits[0].length + selectionHits[1].length + selectionHits[2].length != 0) break
    }
    this.clearAnchorHighlightOverlay(doc);
    for (var hitKindIdx = 0; hitKindIdx < 3; hitKindIdx++) {
      for (var hitIdx = 0; hitIdx < selectionHits[hitKindIdx].length; hitIdx++) {
        var recordIdx = selectionHits[hitKindIdx][hitIdx],
          highlightPoint = vectorMask.pathRecords[recordIdx];
        highlightPoint = hitKindIdx == 0 ? highlightPoint.anchor : hitKindIdx == 1 ? highlightPoint.cp1 : highlightPoint.anchorOut;
        doc.toolOverlayState.selectedPinIndices.push(doc.toolOverlayState.pinMarkerCoords.length >>> 1);
        doc.toolOverlayState.pinMarkerCoords.push(highlightPoint.x, highlightPoint.y);
        doc.dirty = true
      }
    }
  }
};
DirectSelectTool.prototype.clearAnchorHighlightOverlay = function(doc) {
  if (doc && doc.toolOverlayState.pinMarkerCoords.length != 0) {
    doc.toolOverlayState.pinMarkerCoords = [];
    doc.toolOverlayState.selectedPinIndices = [];
    doc.dirty = true
  }
};
DirectSelectTool.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y),
    activePathEntry = this.activeVectorLayerEntry,
    vectorMask = activePathEntry ? activePathEntry.add.vmsk : null,
    keyOrigins = activePathEntry ? activePathEntry.add.vogk : null;
  if (this.activeAnchorIndex != -1) {
    if (Date.now() - this.lastAnchorClickTime < 300) {
      var pathKnot = vectorMask.pathRecords[this.activeAnchorIndex],
        handleKind = this.activeHandleKind,
        historyLabel = null;
      if (handleKind == 0) {
        var cp1AtAnchor = pathKnot.cp1.equals(pathKnot.anchor),
          anchorOutAtAnchor = pathKnot.anchorOut.equals(pathKnot.anchor);
        if (!cp1AtAnchor && !anchorOutAtAnchor) {
          historyLabel = "Anchor Type";
          if (pathKnot.type == 1 || pathKnot.type == 4) pathKnot.type++;
          else {
            pathKnot.type--;
            pathKnot.anchorOut = pathKnot.anchor.add(pathKnot.anchor.subtract(pathKnot.cp1))
          }
        } else {
          historyLabel = "Add Handles";
          if (cp1AtAnchor && anchorOutAtAnchor) {
            pathKnot.cp1.x -= 30;
            pathKnot.anchorOut.x += 30
          } else if (cp1AtAnchor) pathKnot.cp1 = pathKnot.anchor.add(pathKnot.anchor.subtract(pathKnot.anchorOut));
          else if (anchorOutAtAnchor) pathKnot.anchorOut = pathKnot.anchor.add(pathKnot.anchor.subtract(pathKnot.cp1))
        }
      } else {
        historyLabel = "Remove Handle";
        if (handleKind == 1) pathKnot.cp1.copyFrom(pathKnot.anchor);
        else pathKnot.anchorOut.copyFrom(pathKnot.anchor)
      }
      this.syncKeyOriginsForSelectedAnchors(vectorMask, keyOrigins);
      this.applyPathMaskToLayer(doc, activePathEntry.idx, vectorMask, keyOrigins);
      this.pushPathHistory(doc, historyLabel, activePathEntry.idx, this.pathMaskBeforeDrag, vectorMask, null, this.keyOriginsJsonBefore, JSON.stringify(keyOrigins))
    } else if (!this.anchorDragStartPoint.equals(docPoint)) {
      this.pushPathHistory(doc, "Drag Anchors", activePathEntry.idx, this.pathMaskBeforeDrag, vectorMask, null, this.keyOriginsJsonBefore, JSON.stringify(keyOrigins))
    }
    this.lastAnchorClickTime = Date.now()
  } else if (this.dragStartDocPoint != null) {
    var dragStart = this.dragStartDocPoint,
      marqueeRect = new Rect(dragStart.x, dragStart.y, docPoint.x - dragStart.x, docPoint.y - dragStart.y);
    if (marqueeRect.width < 0) marqueeRect.x += marqueeRect.width;
    if (marqueeRect.height < 0) marqueeRect.y += marqueeRect.height;
    marqueeRect.width = Math.abs(marqueeRect.width);
    marqueeRect.height = Math.abs(marqueeRect.height);
    var marqueeHits = selectPointsInRect(vectorMask.pathRecords, marqueeRect);
    vectorMask.selectedComponents = marqueeHits[0].concat(keyboard.isPressed(KeyboardHandler.Shift) ? vectorMask.selectedComponents : []);
    doc.toolOverlayState.overlayTransform = null
  }
  this.resetPathEditDragState();
  doc.dirty = true
};
DirectSelectTool.prototype.resetPathEditDragState = function() {
  this.activeVectorLayerEntry = null;
  this.pathMaskBeforeDrag = null;
  this.dragStartDocPoint = null;
  this.activeAnchorIndex = this.activeHandleKind = -1;
  this.pathKnotAtPointer = null
};
DirectSelectTool.prototype.syncKeyOriginsForSelectedAnchors = function(vectorMask, keyOrigins) {
  for (var componentIdx = 0; componentIdx < vectorMask.selectedComponents.length; componentIdx++) {
    var subpathIdx = subpathIndexForRecord(vectorMask.pathRecords, vectorMask.selectedComponents[componentIdx]);
    invalidateKeyOriginAtIndex(keyOrigins, subpathIdx)
  }
};
DirectSelectTool.prototype.onKeyEvent = function(doc, dispatcher, appData, keyboard) {
  if (doc == null) return;
  var pathTuple = doc.getPaths(),
    pathList = pathTuple[0],
    selectedPathIndices = pathTuple[1];
  if (selectedPathIndices.length == 0) return;
  var activePath = pathList[selectedPathIndices[0]],
    vectorMask = activePath.add.vmsk;
  if (vectorMask == null || vectorMask.selectedComponents.length == 0) return;
  var keyOrigins = activePath.add.vogk,
    keyOriginsBeforeJson = JSON.stringify(keyOrigins),
    arrowDelta = keyboard.getArrowMovement();
  if (arrowDelta.x != 0 || arrowDelta.y != 0) {
    var maskBefore = vectorMask.clone(),
      maskAfter = vectorMask.clone(),
      translateMatrix = new Matrix2D(1, 0, 0, 1, arrowDelta.x, arrowDelta.y);
    transformPathRecordCoords(maskAfter.pathRecords, translateMatrix, null, maskAfter.selectedComponents);
    this.syncKeyOriginsForSelectedAnchors(maskAfter, keyOrigins);
    this.applyPathMaskToLayer(doc, activePath.idx, maskAfter, keyOrigins);
    this.pushPathHistory(doc, "Move Anchors", activePath.idx, maskBefore, maskAfter.clone(), true, keyOriginsBeforeJson, JSON.stringify(keyOrigins))
  }
  if (keyboard.isPressed(KeyboardHandler.Delete) || keyboard.isPressed(KeyboardHandler.Backspace)) {
    var maskBefore = vectorMask.clone(),
      maskAfter = vectorMask.clone();
    maskAfter.pathRecords = removeSelectedSubpathsFromPath(maskAfter.pathRecords, maskAfter.selectedComponents, keyOrigins);
    var subpathCount = countSubpaths(maskAfter.pathRecords);
    for (var subpathIdx = 0; subpathIdx < maskAfter.C.length; subpathIdx++)
      if (maskAfter.C[subpathIdx] >= subpathCount) {
        maskAfter.C.splice(subpathIdx, 1);
        subpathIdx--
      } maskAfter.selectedComponents = [];
    this.applyPathMaskToLayer(doc, activePath.idx, maskAfter, keyOrigins);
    this.pushPathHistory(doc, "Delete Anchors", activePath.idx, maskBefore, maskAfter.clone(), true, keyOriginsBeforeJson, JSON.stringify(keyOrigins))
  }
};
DirectSelectTool.prototype.pushPathHistory = function(doc, historyLabel, layerKey, maskBefore, maskAfter, isMovePaths, keyOriginsBeforeJson, keyOriginsAfterJson) {
  var historyEntry = doc.getLastHistoryEntry();
  if (isMovePaths && historyEntry != null && historyEntry.routingChannel == this && historyEntry.data.pathHistoryIsMovePaths && historyEntry.data.pathLayerKey == layerKey && JSON.stringify(historyEntry.data.pathHistoryMaskBefore.selectedComponents) == JSON.stringify(maskBefore.selectedComponents)) {
    historyEntry.data.pathHistoryMaskAfter = maskAfter;
    historyEntry.data.pathHistoryKeyOriginsAfterJson = keyOriginsAfterJson
  } else {
    PolyToolBase.prototype.pushPathHistory.call(this, doc, historyLabel, layerKey, maskBefore, maskAfter, isMovePaths, keyOriginsBeforeJson, keyOriginsAfterJson)
  }
};
}

// Chain each tool's prototype onto the base it extends. The bases are
// imported, so they are fully built by the time this runs.
PolyToolBase.prototype = Object.create(ToolBase.prototype);
installPolyToolBasePrototype();
PenTool.prototype = Object.create(PolyToolBase.prototype);
installPenToolPrototype();
PathSelectTool.prototype = Object.create(PolyToolBase.prototype);
installPathSelectToolPrototype();
DirectSelectTool.prototype = Object.create(PolyToolBase.prototype);
installDirectSelectToolPrototype();

