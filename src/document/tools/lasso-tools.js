/**
 * Lasso selection tools: freehand, polygonal, and magnetic (intelligent scissors).
 * All extend `SelectTool` and commit via `buildPolygonSelectionAction`.
 * Registered from `selection-tools.js`.
 */
import { Point, constrainEndpointToAxis } from "../../core/math/point.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";

import { buildPolygonSelectionAction } from "./selection-actions.js";
import { EventType } from "../../core/event-bus.js";
import { getDevicePixelRatio } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { EventChannel, ToolId } from "../model/tool-base.js";
import { SelectTool } from "./selection-tools.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { luminanceFromRgb } from "../../engine/compositing/color-math.js";
import { buildEdgeCostField, initPathSearch, runDijkstra } from "../../engine/compositing/selection-utils.js";


export function PolygonLassoTool() {
  SelectTool.call(this, "tools.polygonalLassoSelect", ToolId.TOOL_POLYGON_LASSO, "tools/plasso");
  this.defaultCursorStyle = "crosshair";
  this.lassoModifierKeys = [];
  this.completedPolygonPath = null;
  this.polygonPathOverlay = null;
  this.lastVertexClickTime = 0;
}

function installPolygonLassoToolPrototype() {
  PolygonLassoTool.prototype.disable = function(doc, dispatcher, appData, keyboard) {
    this.clearPolygonPathOverlay(doc);
  };
  PolygonLassoTool.prototype.onDragStart = function(doc, appData, keyboard, pointerState) {
    this.lassoModifierKeys = [KeyboardHandler.Delete, KeyboardHandler.Backspace];
  };
  PolygonLassoTool.prototype.isModifierKey = function(keyCode) {
    return this.lassoModifierKeys.indexOf(keyCode) != -1;
  };
  PolygonLassoTool.prototype.wantsInput = function(pointerState) {
    return this.polygonPathOverlay != null;
  };
  PolygonLassoTool.prototype.isActive = function() {
    return this.polygonPathOverlay != null;
  };
  PolygonLassoTool.prototype.shouldCancelMouseDown = function() {
    return this.polygonPathOverlay != null;
  };
  PolygonLassoTool.prototype.onDrag = function(doc, appData, keyboard, pointerState) {
    if (this.polygonPathOverlay == null) return;
    const pathOverlay = this.polygonPathOverlay;
    const pathCoords = pathOverlay.coords;
    let trailingCoordIndex = pathCoords.length - 2;
    let dragPoint = this.cursorPos;
    if (this.altModifierStage > 1 && keyboard.isPressed(KeyboardHandler.Alt) && pointerState.isDown) {
      pathCoords.push(0, 0);
      pathOverlay.commands.push("L");
      trailingCoordIndex += 2;
    } else if (keyboard.isPressed(KeyboardHandler.Shift)) {
      dragPoint = constrainEndpointToAxis(new Point(pathCoords[trailingCoordIndex - 2], pathCoords[trailingCoordIndex - 1]), dragPoint);
    }
    pathCoords[trailingCoordIndex] = dragPoint.x;
    pathCoords[trailingCoordIndex + 1] = dragPoint.y;
    doc.toolOverlayState.overlayTransform = pathOverlay;
    doc.dirty = true;
  };
  PolygonLassoTool.prototype.onDragEnd = function(doc, appData, keyboard, pointerState) {
    const clickTimeMs = Date.now();
    if (this.polygonPathOverlay == null) {
      this.polygonPathOverlay = {
        coords: [this.cursorPos.x, this.cursorPos.y, this.cursorPos.x, this.cursorPos.y],
        commands: ["M", "L"],
      };
    } else {
      this.onDrag(doc, appData, keyboard, pointerState);
      const closeHitRadius = 5 * getDevicePixelRatio() / doc.pathViewport.zoomScale;
      if (clickTimeMs - this.lastVertexClickTime < 250 || Point.dist(this.cursorPos, new Point(this.polygonPathOverlay.coords[0], this.polygonPathOverlay.coords[1])) < closeHitRadius) {
        this.completedPolygonPath = this.polygonPathOverlay;
        this.finish(doc, appData, keyboard, pointerState);
        this.clearPolygonPathOverlay(doc);
        return;
      }
      this.polygonPathOverlay.commands.push("L");
      this.polygonPathOverlay.coords.push(this.cursorPos.x, this.cursorPos.y);
    }
    this.lastVertexClickTime = clickTimeMs;
    doc.toolOverlayState.overlayTransform = this.polygonPathOverlay;
  };
  PolygonLassoTool.prototype.clearPolygonPathOverlay = function(doc) {
    this.polygonPathOverlay = null;
    this.lassoModifierKeys = [];
    if (doc != null) {
      doc.toolOverlayState.overlayTransform = null;
      doc.dirty = true;
    }
  };
  PolygonLassoTool.prototype.onKeyEvent = function(doc, dispatcher, appData, keyboard) {
    SelectTool.prototype.onKeyEvent.call(this, doc, dispatcher, appData, keyboard);
    if (keyboard.isPressed(KeyboardHandler.Escape) && this.polygonPathOverlay == null && this.completedPolygonPath && doc.selectionMask != null) {
      const historyEvent = new AppEvent(EventType.documentAction);
      historyEvent.routingChannel = EventChannel.EVENT_HISTORY;
      historyEvent.data = { actionKind: "h_stepbck" };
      dispatcher.dispatch(historyEvent);
      this.onDragStart(doc, appData, keyboard, null);
      this.polygonPathOverlay = this.completedPolygonPath;
      return;
    }
    if (this.polygonPathOverlay == null) return;
    if (keyboard.isPressed(KeyboardHandler.Delete) || keyboard.isPressed(KeyboardHandler.Backspace)) {
      this.polygonPathOverlay.coords.pop();
      this.polygonPathOverlay.coords.pop();
      this.polygonPathOverlay.commands.pop();
      this.onDrag(doc, appData, keyboard);
    }
    if (keyboard.isPressed(KeyboardHandler.Enter)) {
      if (this.polygonPathOverlay.coords.length > 4) {
        this.completedPolygonPath = this.polygonPathOverlay;
        this.finish(doc, appData, keyboard);
      }
      this.polygonPathOverlay = null;
    }
    if (keyboard.isPressed(KeyboardHandler.Escape)) {
      this.polygonPathOverlay = null;
    }
    doc.toolOverlayState.overlayTransform = this.polygonPathOverlay;
    doc.dirty = true;
  };
  PolygonLassoTool.prototype.getSelection = function(doc, appData, keyboard, pointerState) {
    return buildPolygonSelectionAction(this.polygonPathOverlay.coords);
  };
}

export function MagneticLassoTool() {
  SelectTool.call(this, "tools.magneticLassoSelect", ToolId.TOOL_MAGNETIC_LASSO, "tools/mlasso");
  this.defaultCursorStyle = "crosshair";
  this.lassoModifierKeys = [];
  this.magneticAnchorPoints = [];
  this.nodeIndexByAnchor = [];
  this.nodes = [];
  this.edgeCostField = null;
  this.pathSearchState = null;
  this.visitCounts = null;
  this.lastAnchorClickTime = 0;
  this.altAddsVerticesOnDrag = 0;
}

function installMagneticLassoToolPrototype() {
  MagneticLassoTool.prototype.disable = function(doc, dispatcher, appData, keyboard) {
    this.clear(doc);
  };
  MagneticLassoTool.prototype.wantsInput = function(pointerState) {
    return this.magneticAnchorPoints.length != 0;
  };
  MagneticLassoTool.prototype.isActive = function() {
    return this.magneticAnchorPoints.length != 0;
  };
  MagneticLassoTool.prototype.isModifierKey = function(keyCode) {
    return this.lassoModifierKeys.indexOf(keyCode) != -1;
  };
  MagneticLassoTool.prototype.onDragStart = function(doc, appData, keyboard, pointerState) {
    this.lassoModifierKeys = [KeyboardHandler.Delete, KeyboardHandler.Backspace];
    let anchorPoint = this.clampPointToDocument(this.startPos, doc);
    const closeHitRadius = 4 * getDevicePixelRatio() / doc.pathViewport.zoomScale;
    if (this.magneticAnchorPoints.length != 0 && (Point.dist(anchorPoint, this.magneticAnchorPoints[0]) < closeHitRadius || Date.now() - this.lastAnchorClickTime < 300)) {
      this.appendMagneticAnchor(doc, this.magneticAnchorPoints[0]);
      this.finish(doc, appData, keyboard);
      this.clear(doc);
      return;
    }
    this.lastAnchorClickTime = Date.now();
    if (this.magneticAnchorPoints.length != 0) {
      anchorPoint = this.snapPointToLowestCost(anchorPoint, doc);
    } else {
      this.buildEdgeCostField(doc);
    }
    this.appendMagneticAnchor(doc, anchorPoint);
    this.altAddsVerticesOnDrag = keyboard.isPressed(KeyboardHandler.Alt) ? 1 : 0;
    this.redraw(doc);
  };
  /** Luminance-weighted edge cost field for the intelligent-scissors search. */
  MagneticLassoTool.prototype.buildEdgeCostField = function(doc) {
    const docWidth = doc.width;
    const docHeight = doc.height;
    const luminanceField = allocBuffer(docWidth * docHeight);
    const rasterData = doc.getRasterData();
    const rasterByteCount = docWidth * docHeight * 4;
    const inv255 = 1 / 255;
    for (let byteOffset = 0; byteOffset < rasterByteCount; byteOffset += 4) {
      luminanceField[byteOffset >>> 2] = ~~(0.5 + luminanceFromRgb(rasterData[byteOffset], rasterData[byteOffset + 1], rasterData[byteOffset + 2]) * (rasterData[byteOffset + 3] * inv255));
    }
    this.edgeCostField = buildEdgeCostField(luminanceField, docWidth, docHeight);
    this.visitCounts = new Uint16Array(luminanceField.length);
  };
  MagneticLassoTool.prototype.appendMagneticAnchor = function(doc, anchorPoint) {
    const anchorPoints = this.magneticAnchorPoints;
    this.nodeIndexByAnchor[anchorPoints.length] = this.nodes.length;
    if (anchorPoints.length != 0) {
      runDijkstra(this.pathSearchState, anchorPoint.y * doc.width + anchorPoint.x);
      const indexPath = this.buildIndexPathBetweenPoints(doc, anchorPoint);
      indexPath.reverse();
      const overlayCoords = MagneticLassoTool.indicesToOverlayCoords(doc, indexPath);
      this.nodes = this.nodes.concat(overlayCoords);
    }
    anchorPoints.push(anchorPoint);
    this.resetCostMapFromAnchor(doc);
  };
  MagneticLassoTool.prototype.resetCostMapFromAnchor = function(doc) {
    const lastAnchor = this.magneticAnchorPoints[this.magneticAnchorPoints.length - 1];
    const seedIndex = lastAnchor.y * doc.width + lastAnchor.x;
    this.pathSearchState = initPathSearch(this.edgeCostField.neighborOffsets, this.edgeCostField.edgeCosts, seedIndex);
    this.visitCounts.fill(0);
  };
  MagneticLassoTool.prototype.clampPointToDocument = function(docPoint, doc) {
    return new Point(Math.floor(Math.max(0, Math.min(doc.width - 1, docPoint.x))), Math.floor(Math.max(0, Math.min(doc.height - 1, docPoint.y))));
  };
  MagneticLassoTool.prototype.clear = function(doc) {
    this.nodes = [];
    this.magneticAnchorPoints = [];
    this.nodeIndexByAnchor = [];
    this.edgeCostField = null;
    this.pathSearchState = null;
    this.visitCounts = null;
    if (doc != null) {
      doc.toolOverlayState.overlayTransform = null;
      doc.toolOverlayState.squareMarkerCoords = [];
      doc.dirty = true;
    }
    this.lassoModifierKeys = [];
  };
  MagneticLassoTool.prototype.onDrag = function(doc, appData, keyboard, pointerState) {
    const anchorPoints = this.magneticAnchorPoints;
    const anchorCount = anchorPoints.length;
    if (anchorCount == 0) return;
    const snappedPoint = this.snapPointToLowestCost(this.clampPointToDocument(this.cursorPos, doc), doc);
    const indexPath = this.buildIndexPathBetweenPoints(doc, snappedPoint);
    for (let pathIdx = 0; pathIdx < indexPath.length; pathIdx++) {
      const pixelIndex = indexPath[pathIdx];
      const pathPoint = new Point(pixelIndex % doc.width, Math.floor(pixelIndex / doc.width));
      if (this.visitCounts[pixelIndex] > 30 && Point.dist(pathPoint, anchorPoints[anchorCount - 1]) > 20) {
        this.appendMagneticAnchor(doc, pathPoint);
        return;
      }
      this.visitCounts[pixelIndex]++;
    }
    if (this.altAddsVerticesOnDrag == 1 && pointerState.isDown) this.appendMagneticAnchor(doc, snappedPoint);
    this.redraw(doc);
  };
  MagneticLassoTool.prototype.redraw = function(doc) {
    const anchorPoints = this.magneticAnchorPoints;
    if (anchorPoints.length != 0) {
      const snappedPoint = this.snapPointToLowestCost(this.clampPointToDocument(this.cursorPos, doc), doc);
      const previewIndexPath = this.buildIndexPathBetweenPoints(doc, snappedPoint);
      previewIndexPath.reverse();
      const previewCoords = MagneticLassoTool.indicesToOverlayCoords(doc, previewIndexPath);
      const overlayCoords = this.nodes.concat(previewCoords);
      const pathOverlay = doc.toolOverlayState.overlayTransform = {
        coords: overlayCoords,
        commands: ["M"],
      };
      for (let coordIdx = 2; coordIdx < overlayCoords.length; coordIdx += 2) pathOverlay.commands.push("L");
    }
    doc.toolOverlayState.squareMarkerCoords = [];
    for (let anchorIdx = 0; anchorIdx < anchorPoints.length; anchorIdx++) {
      doc.toolOverlayState.squareMarkerCoords.push(anchorPoints[anchorIdx].x + 0.5, anchorPoints[anchorIdx].y + 0.5);
    }
    doc.dirty = true;
  };
  MagneticLassoTool.prototype.onDragEnd = function(doc, appData, keyboard, pointerState) {};
  MagneticLassoTool.prototype.onKeyEvent = function(doc, dispatcher, appData, keyboard) {
    if (this.magneticAnchorPoints.length == 0) return;
    if (keyboard.isPressed(KeyboardHandler.Delete) || keyboard.isPressed(KeyboardHandler.Backspace)) {
      this.magneticAnchorPoints.pop();
      this.nodes = this.nodes.slice(0, this.nodeIndexByAnchor[this.magneticAnchorPoints.length]);
      this.nodeIndexByAnchor.pop();
      if (this.magneticAnchorPoints.length == 0) this.clear(doc);
      else this.resetCostMapFromAnchor(doc);
      this.redraw(doc);
    }
    if (keyboard.isPressed(KeyboardHandler.Enter)) {
      const anchorPoint = this.clampPointToDocument(this.cursorPos, doc);
      this.appendMagneticAnchor(doc, anchorPoint);
      this.finish(doc, appData, keyboard);
      this.clear(doc);
    }
    if (keyboard.isPressed(KeyboardHandler.Escape)) {
      this.clear(doc);
    }
  };
  MagneticLassoTool.prototype.getSelection = function(doc, appData, keyboard, pointerState) {
    return buildPolygonSelectionAction(this.nodes);
  };
  MagneticLassoTool.prototype.buildIndexPathBetweenPoints = function(doc, endPoint) {
    const startAnchor = this.magneticAnchorPoints[this.magneticAnchorPoints.length - 1];
    const startIndex = startAnchor.y * doc.width + startAnchor.x;
    let endIndex = endPoint.y * doc.width + endPoint.x;
    if (this.altAddsVerticesOnDrag == 1) return [endIndex, startIndex];
    const indexPath = [endIndex];
    while (endIndex != startIndex) {
      endIndex = this.pathSearchState.predecessor[endIndex];
      indexPath.push(endIndex);
      if (indexPath.length > 5e3) {
        throw new Error("magnetic lasso: path search did not reach the previous anchor");
      }
    }
    return indexPath;
  };
  MagneticLassoTool.indicesToOverlayCoords = function(doc, indexPath) {
    const overlayCoords = [];
    const docWidth = doc.width;
    for (let pathIdx = 0; pathIdx < indexPath.length; pathIdx++) {
      const pixelIndex = indexPath[pathIdx];
      overlayCoords.push(pixelIndex % docWidth + 0.5, Math.floor(pixelIndex / docWidth) + 0.5);
    }
    return overlayCoords;
  };
  MagneticLassoTool.prototype.snapPointToLowestCost = function(docPoint, doc) {
    const docWidth = doc.width;
    const docHeight = doc.height;
    const snappedPoint = docPoint.clone();
    const searchRadius = 3;
    runDijkstra(this.pathSearchState, docPoint.y * docWidth + docPoint.x);
    const bestDistance = this.pathSearchState.distance[docPoint.y * docWidth + docPoint.x];
    for (let offsetY = -searchRadius + 1; offsetY < searchRadius; offsetY++) {
      for (let offsetX = -searchRadius + 1; offsetX < searchRadius; offsetX++) {
        const sampleX = docPoint.x + offsetX;
        const sampleY = docPoint.y + offsetY;
        if (sampleX < 0 || sampleX >= docWidth || sampleY < 0 || sampleY >= docHeight) continue;
        runDijkstra(this.pathSearchState, sampleY * docWidth + sampleX);
        if (this.pathSearchState.distance[sampleY * docWidth + sampleX] < bestDistance) snappedPoint.setXY(sampleX, sampleY);
      }
    }
    return snappedPoint;
  };
}

export function LassoTool() {
  SelectTool.call(this, "tools.lassoSelect", ToolId.TOOL_LASSO_SELECT, "tools/lasso");
  this.defaultCursorStyle = "crosshair";
  this.lastFreehandPoint = null;
  this.polygonPathOverlay = null;
  this.lassoPointerState = null;
}

function installLassoToolPrototype() {
  LassoTool.prototype.onDragStart = function(doc, appData, keyboard, pointerState) {
    this.lastFreehandPoint = this.startPos;
    this.polygonPathOverlay = {
      coords: [this.lastFreehandPoint.x, this.lastFreehandPoint.y],
      commands: ["M"],
    };
  };
  LassoTool.prototype.onDrag = function(doc, appData, keyboard, pointerState) {
    this.lassoPointerState = pointerState;
    const pathOverlay = this.polygonPathOverlay;
    if (pathOverlay == null) return;
    if (!pointerState.isDown) {
      if (this.polygonPathOverlay != null && this.altModifierStage > 1 && keyboard.isPressed(KeyboardHandler.Alt)) {
        pathOverlay.coords.pop();
        pathOverlay.coords.pop();
        pathOverlay.coords.push(this.cursorPos.x, this.cursorPos.y);
        doc.toolOverlayState.overlayTransform = pathOverlay;
        doc.dirty = true;
      }
      return;
    }
    pathOverlay.commands.push("L");
    pathOverlay.coords.push(this.cursorPos.x, this.cursorPos.y);
    this.lastFreehandPoint = this.cursorPos;
    if (this.exceededDragThreshold) {
      doc.toolOverlayState.overlayTransform = pathOverlay;
      doc.dirty = true;
    }
  };
  LassoTool.prototype.isActive = function() {
    return this.polygonPathOverlay != null;
  };
  LassoTool.prototype.shouldCancelMouseDown = function() {
    return this.polygonPathOverlay != null;
  };
  LassoTool.prototype.onKeyEvent = function(doc, dispatcher, appData, keyboard) {
    SelectTool.prototype.onKeyEvent.call(this, doc, dispatcher, appData, keyboard);
    if (this.polygonPathOverlay && this.altModifierStage > 1 && this.lassoPointerState && !this.lassoPointerState.isDown && !keyboard.isPressed(KeyboardHandler.Alt)) this.commitFreehandLasso(doc, appData, keyboard);
  };
  LassoTool.prototype.onDragEnd = function(doc, appData, keyboard, pointerState) {
    this.lassoPointerState = pointerState;
    const pathOverlay = this.polygonPathOverlay;
    if (pathOverlay == null) return;
    if (this.altModifierStage > 1 && keyboard.isPressed(KeyboardHandler.Alt)) {
      pathOverlay.commands.push("L");
      pathOverlay.coords.push(this.cursorPos.x, this.cursorPos.y);
      return;
    }
    this.commitFreehandLasso(doc, appData, keyboard);
  };
  LassoTool.prototype.commitFreehandLasso = function(doc, appData, keyboard) {
    this.finish(doc, appData, keyboard, this.lassoPointerState);
    this.polygonPathOverlay = null;
    doc.toolOverlayState.overlayTransform = null;
    doc.dirty = true;
  };
  LassoTool.prototype.getSelection = function(doc, appData, keyboard, pointerState) {
    if (this.startPos.equals(this.cursorPos) || !this.exceededDragThreshold) return null;
    return buildPolygonSelectionAction(this.polygonPathOverlay.coords);
  };
}

// Chain each tool's prototype onto the base it extends. The bases are
// imported, so they are fully built by the time this runs.
PolygonLassoTool.prototype = Object.create(SelectTool.prototype);
installPolygonLassoToolPrototype();
MagneticLassoTool.prototype = Object.create(SelectTool.prototype);
installMagneticLassoToolPrototype();
LassoTool.prototype = Object.create(SelectTool.prototype);
installLassoToolPrototype();

