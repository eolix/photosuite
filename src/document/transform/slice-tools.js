/**
 * Slice drawing and slice selection tools, plus shared slice bounds helpers used
 * by crop, move snap, export, and plugin panels.
 */

import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";

import { InputHandler } from "../../ui/tool-options/input-handler.js";
import { PopupTypes } from "../../ui/config/popup-types.js";
import { HistoryEntry } from "../model/document.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { AppEvent } from "../../core/event-bus.js";
import { ToolBase, ToolId } from "../model/tool-base.js";
import { snapPointToGuides, snapRectCornersToGuides, updateLayerDragPositions } from "../model/guide-snapping.js";
import {
  createDefaultSliceDescriptor,
  readSliceBoundsArray,
  writeSliceBoundsToDescriptor,
} from "../formats/psd/slice-descriptor.js";


/**
 * Build a slice history payload from before/after JSON snapshots.
 * @param {object} tool
 * @param {string} slicesJsonAfter
 * @param {string} selectedSlicesJsonAfter
 */
function buildSlicesHistoryData(tool, slicesJsonAfter, selectedSlicesJsonAfter) {
  return {
    slicesJsonBefore: tool.slicesJsonBefore,
    slicesJsonAfter,
    selectedSlicesJsonBefore: tool.selectedSlicesJsonBefore,
    selectedSlicesJsonAfter,
  };
}

/**
 * @param {object[]} slices
 * @param {object} docPoint
 * @returns {number}
 */
function findSliceIndexAtPoint(slices, docPoint) {
  for (let sliceIdx = 0; sliceIdx < slices.length; sliceIdx++) {
    const bounds = readSliceBoundsArray(slices, sliceIdx);
    if (
      bounds[0] <= docPoint.x &&
      docPoint.x <= bounds[2] &&
      bounds[1] <= docPoint.y &&
      docPoint.y <= bounds[3]
    ) {
      return sliceIdx;
    }
  }
  return -1;
}

/**
 * @param {number[]} bounds
 */
function normalizeAxisAlignedBounds(bounds) {
  if (bounds[2] < bounds[0]) {
    const swapCoord = bounds[0];
    bounds[0] = bounds[2];
    bounds[2] = swapCoord;
  }
  if (bounds[2] === bounds[0]) {
    bounds[2]++;
  }
  if (bounds[3] < bounds[1]) {
    const swapCoord = bounds[1];
    bounds[1] = bounds[3];
    bounds[3] = swapCoord;
  }
  if (bounds[3] === bounds[1]) {
    bounds[3]++;
  }
}

/**
 * @param {object[]} slices
 * @param {number[]} selectedIndices
 * @returns {number[]}
 */
function getUnionBoundsOfSliceIndices(slices, selectedIndices) {
  let minX = 1e9;
  let maxX = -1e9;
  let minY = 1e9;
  let maxY = -1e9;
  for (let sliceIdx = 0; sliceIdx < selectedIndices.length; sliceIdx++) {
    const bounds = readSliceBoundsArray(slices, selectedIndices[sliceIdx]);
    minX = Math.min(minX, bounds[0]);
    minY = Math.min(minY, bounds[1]);
    maxX = Math.max(maxX, bounds[2]);
    maxY = Math.max(maxY, bounds[3]);
  }
  return [minX, minY, maxX, maxY];
}

/**
 * @param {number[]} bounds
 * @param {number[]} canvasBounds
 */
function clampBoundsToCanvas(bounds, canvasBounds) {
  if (bounds[0] < canvasBounds[0]) {
    bounds[0] = canvasBounds[0];
  }
  if (bounds[1] < canvasBounds[1]) {
    bounds[1] = canvasBounds[1];
  }
  if (canvasBounds[2] < bounds[2]) {
    bounds[2] = canvasBounds[2];
  }
  if (canvasBounds[3] < bounds[3]) {
    bounds[3] = canvasBounds[3];
  }
}

/**
 * @param {number[]} bounds
 * @param {Point|{x:number,y:number}} delta
 */
function offsetSliceBoundsByDelta(bounds, delta) {
  bounds[0] = Math.round(bounds[0] + delta.x);
  bounds[2] = Math.round(bounds[2] + delta.x);
  bounds[1] = Math.round(bounds[1] + delta.y);
  bounds[3] = Math.round(bounds[3] + delta.y);
}

/**
 * @param {object} doc
 * @param {Point|{x:number,y:number}} delta
 */
function nudgeSelectedSlicesByDelta(doc, delta) {
  const slices = doc.slices;
  for (let sliceIdx = 0; sliceIdx < doc.selectedSliceIndices.length; sliceIdx++) {
    const sliceIndex = doc.selectedSliceIndices[sliceIdx];
    const bounds = readSliceBoundsArray(slices, sliceIndex);
    offsetSliceBoundsByDelta(bounds, delta);
    writeSliceBoundsToDescriptor(slices, sliceIndex, bounds);
  }
}

/**
 * @param {object[]} slices
 * @param {Rect} newCanvasRect
 * @param {Rect} oldCanvasRect
 * @param {boolean} rescaleSlices
 */
function rescaleSlicesForCanvas(slices, newCanvasRect, oldCanvasRect, rescaleSlices) {
  const canvasOffset = new Point(-newCanvasRect.x, -newCanvasRect.y);
  const scaleX = newCanvasRect.width / oldCanvasRect.width;
  const scaleY = newCanvasRect.height / oldCanvasRect.height;
  const canvasBounds = [0, 0, newCanvasRect.width, newCanvasRect.height];
  for (let sliceIdx = 0; sliceIdx < slices.length; sliceIdx++) {
    const bounds = readSliceBoundsArray(slices, sliceIdx);
    if (rescaleSlices) {
      bounds[0] = Math.round(bounds[0] * scaleX);
      bounds[1] = Math.round(bounds[1] * scaleY);
      bounds[2] = Math.round(bounds[2] * scaleX);
      bounds[3] = Math.round(bounds[3] * scaleY);
    } else {
      offsetSliceBoundsByDelta(bounds, canvasOffset);
      clampBoundsToCanvas(bounds, canvasBounds);
    }
    if (bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) {
      slices.splice(sliceIdx, 1);
      sliceIdx--;
      continue;
    }
    writeSliceBoundsToDescriptor(slices, sliceIdx, bounds);
  }
}

/**
 * @param {object} docPoint
 * @param {number} hitSlop
 * @param {object[]} slices
 * @param {number[]} selectedIndices
 * @returns {number[]}
 */
function findSliceAtPoint(docPoint, hitSlop, slices, selectedIndices) {
  const pointX = docPoint.x;
  const pointY = docPoint.y;
  const hitTargets = [];
  let resizeAxis = -1;
  const slicesOnAxis = [];
  for (let sliceIdx = 0; sliceIdx < selectedIndices.length; sliceIdx++) {
    const sliceIndex = selectedIndices[sliceIdx];
    const bounds = readSliceBoundsArray(slices, sliceIndex);
    const left = bounds[0];
    const top = bounds[1];
    const right = bounds[2];
    const bottom = bounds[3];
    if (pointX < left - hitSlop || right + hitSlop < pointX || pointY < top - hitSlop || bottom + hitSlop < pointY) {
      continue;
    }
    const cornerFlags = [
      pointX < left + hitSlop,
      pointY < top + hitSlop,
      right - hitSlop < pointX,
      bottom - hitSlop < pointY,
    ];
    let axisCandidate = -1;
    for (let cornerIdx = 0; cornerIdx < 4; cornerIdx++) {
      if (cornerFlags[cornerIdx] && cornerFlags[(cornerIdx + 1) & 3]) {
        axisCandidate = 1 + 2 * (cornerIdx & 1);
      }
      if (cornerFlags[cornerIdx]) {
        hitTargets.push(sliceIndex, cornerIdx);
      }
    }
    if (axisCandidate === -1) {
      if (cornerFlags[0] || cornerFlags[2]) {
        axisCandidate = 0;
      }
      if (cornerFlags[1] || cornerFlags[3]) {
        axisCandidate = 2;
      }
    }
    if (axisCandidate !== -1) {
      resizeAxis = axisCandidate;
      slicesOnAxis.push(sliceIndex);
    }
  }
  const hitCount = hitTargets.length;
  for (let targetIdx = 0; targetIdx < hitCount; targetIdx += 2) {
    const sliceIndex = hitTargets[targetIdx];
    const boundsIndex = hitTargets[targetIdx + 1];
    const sharedCoord = readSliceBoundsArray(slices, sliceIndex)[boundsIndex];
    for (let selectedIdx = 0; selectedIdx < selectedIndices.length; selectedIdx++) {
      const otherSliceIndex = selectedIndices[selectedIdx];
      if (slicesOnAxis.indexOf(otherSliceIndex) !== -1) {
        continue;
      }
      const otherBounds = readSliceBoundsArray(slices, otherSliceIndex);
      if (otherBounds[boundsIndex & 1] === sharedCoord) {
        hitTargets.push(otherSliceIndex, boundsIndex & 1);
      }
      if (otherBounds[2 + (boundsIndex & 1)] === sharedCoord) {
        hitTargets.push(otherSliceIndex, 2 + (boundsIndex & 1));
      }
    }
  }
  hitTargets.push(resizeAxis);
  return hitTargets;
}

/** How close to a slice edge the pointer counts as being on it, in screen pixels. */
const SLICE_EDGE_HIT_SLOP_PX = 4;

/** Resize cursors by the axis {@link findSliceAtPoint} reports. */
const SLICE_EDGE_CURSORS = ["ew", "nwse", "ns", "nesw"];

/** Every slice index, so a hit test can cover slices that are not selected. */
function allSliceIndices(slices) {
  const indices = [];
  for (let sliceIdx = 0; sliceIdx < slices.length; sliceIdx++) {
    indices.push(sliceIdx);
  }
  return indices;
}

/**
 * Slice edges under `docPoint`, as `[sliceIndex, boundsIndex, …]` with the axis
 * they lie on appended. Empty (bar the axis) when the point is off every edge.
 */
function findSliceEdgesAtPoint(doc, docPoint, sliceIndices) {
  return findSliceAtPoint(
    docPoint,
    SLICE_EDGE_HIT_SLOP_PX / doc.pathViewport.zoomScale,
    doc.slices,
    sliceIndices,
  );
}

/** Tell the shell which cursor the pointer is over. */
function dispatchCursorStyle(dispatcher, cursorStyle) {
  const cursorEvent = new AppEvent(EventType.uiDispatch, true);
  cursorEvent.data = {
    dispatchKind: UiCommand.splashOptionsUpdate,
    cursorOverlayId: cursorStyle,
  };
  dispatcher.dispatch(cursorEvent);
}

/** Move every edge in `hitTargets` onto `docPoint`, snapping to guides first. */
function dragSliceEdgesToPoint(doc, appData, docPoint, hitTargets) {
  const slices = doc.slices;
  const snappedPoint = snapPointToGuides(doc, docPoint, appData, [true, null, false]);
  const coordX = Math.round(snappedPoint.x);
  const coordY = Math.round(snappedPoint.y);
  for (let targetIdx = 0; targetIdx < hitTargets.length; targetIdx += 2) {
    const sliceIndex = hitTargets[targetIdx];
    const boundsIndex = hitTargets[targetIdx + 1];
    const bounds = readSliceBoundsArray(slices, sliceIndex);
    bounds[boundsIndex] = (boundsIndex & 1) === 0 ? coordX : coordY;
    normalizeAxisAlignedBounds(bounds);
    writeSliceBoundsToDescriptor(slices, sliceIndex, bounds);
  }
}

export function SliceTool(nameKey, toolId, iconPath) {
  ToolBase.call(
    this,
    nameKey ? nameKey : "tools.sliceTool",
    toolId ? toolId : ToolId.TOOL_SLICE,
    iconPath ? iconPath : "tools/slice",
  );
  this.contextMenuDocument = null;
  this.contextMenuDispatcher = null;
  this.slicesJsonBefore = null;
  this.selectedSlicesJsonBefore = null;
  this.dragStartDocPoint = null;
  this.sliceContextMenu = null;
  this.resizeHandleTargets = null;
}

export function SliceSelectTool() {
  SliceTool.call(this, "tools.sliceSelectTool", ToolId.TOOL_SLICE_SELECT, "tools/sselect");
  this.dragStartDocPoint = null;
  this.dragStartUnionBounds = null;
  this.resizeHandleTargets = null;
  this.dragStartBoundsPerSlice = null;
  this.didDragSlices = false;
}

function installSliceToolPrototype() {
  SliceTool.prototype.handleInput = function (sliceDescriptor, dispatcher, doc, keyboard, appData) {
    this.beginSlicesHistorySnapshot(doc);
    doc.slices[doc.selectedSliceIndices[0]].v = sliceDescriptor;
    doc.dirty = true;
    this.commitSlicesHistoryIfChanged(doc);
  };

  SliceTool.prototype.enable = function (doc, dispatcher, appData, keyboard, pointerState, gestureOptions) {
    ToolBase.prototype.enable.call(
      this,
      doc,
      dispatcher,
      appData,
      keyboard,
      pointerState,
      gestureOptions,
    );
    if (!appData.prefs.slices) {
      const presetEvent = new AppEvent(EventType.uiDispatch, true);
      presetEvent.data = {
        dispatchKind: UiCommand.openResourcePresetPopup,
        popupType: PopupTypes.ROTATE_CANVAS,
      };
      dispatcher.dispatch(presetEvent);
    }
  };

  SliceTool.prototype.disable = function () {
    this.contextMenuDocument = null;
    this.contextMenuDispatcher = null;
  };

  SliceTool.prototype.onRightMouseUp = function (doc, dispatcher, appData, keyboard, pointerState) {
    const docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
    const sliceIndex = findSliceIndexAtPoint(doc.slices, docPoint);
    if (sliceIndex === -1) {
      return;
    }
    this.contextMenuDocument = doc;
    this.contextMenuDispatcher = dispatcher;
    doc.selectedSliceIndices = [sliceIndex];
    doc.dirty = true;
    if (this.sliceContextMenu == null) {
      this.sliceContextMenu = new InputHandler([
        { name: "clipboard.delete" },
        { name: "view.sliceOptions", opensDialog: true },
      ]);
      this.sliceContextMenu.on("select", this.onSliceContextMenuSelect, this);
    }
    const contextMenu = this.sliceContextMenu;
    contextMenu.parent = dispatcher;
    contextMenu.buildUI();
    contextMenu.update(doc, appData);
    const overlayEvent = new AppEvent(EventType.uiDispatch, true);
    overlayEvent.data = {
      dispatchKind: UiCommand.showFloatingOverlay,
      overlayWidget: contextMenu,
      x: pointerState.screenX + 2,
      y: pointerState.screenY + 1,
    };
    dispatcher.dispatch(overlayEvent);
  };

  SliceTool.prototype.onSliceContextMenuSelect = function (selectEvent) {
    const menuItemIndex = this.sliceContextMenu.getSelectedIndices()[0];
    const doc = this.contextMenuDocument;
    if (menuItemIndex === 0) {
      this.beginSlicesHistorySnapshot(doc);
      doc.slices.splice(doc.selectedSliceIndices[0], 1);
      doc.selectedSliceIndices = [];
      doc.dirty = true;
      this.commitSlicesHistoryIfChanged(doc);
    }
    if (menuItemIndex === 1) {
      const dialogEvent = new AppEvent(EventType.uiDispatch, true);
      dialogEvent.data = {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "soptions",
        sliceDescriptor: doc.slices[doc.selectedSliceIndices[0]].v,
      };
      this.contextMenuDispatcher.dispatch(dialogEvent);
    }
  };

  SliceTool.prototype.onMouseDown = function (doc, dispatcher, appData, keyboard, pointerState) {
    if (doc == null) {
      return;
    }
    this.beginSlicesHistorySnapshot(doc);
    const pressDocPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
    // Pressing on the edge of an existing slice moves that edge, the way the
    // cursor over it says it will, rather than starting a new slice.
    const edgeTargets = findSliceEdgesAtPoint(doc, pressDocPoint, allSliceIndices(doc.slices));
    edgeTargets.pop();
    if (edgeTargets.length !== 0) {
      this.dragStartDocPoint = pressDocPoint;
      this.resizeHandleTargets = edgeTargets;
      return;
    }
    let docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
    docPoint = snapPointToGuides(doc, docPoint, appData, [true, null, false]);
    docPoint.x = Math.round(docPoint.x);
    docPoint.y = Math.round(docPoint.y);
    this.dragStartDocPoint = docPoint;
    doc.slices.unshift(createDefaultSliceDescriptor());
    doc.selectedSliceIndices = [0];
    writeSliceBoundsToDescriptor(doc.slices, 0, [
      docPoint.x,
      docPoint.y,
      docPoint.x + 20,
      docPoint.y + 20,
    ]);
    doc.dirty = true;
  };

  SliceTool.prototype.onMouseMove = function (doc, dispatcher, appData, keyboard, pointerState) {
    if (this.resizeHandleTargets) {
      const dragDocPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
      dragSliceEdgesToPoint(doc, appData, dragDocPoint, this.resizeHandleTargets);
      doc.dirty = true;
      return;
    }
    if (this.slicesJsonBefore == null) {
      // Not drawing: the cursor reports whether an edge would be grabbed here.
      if (doc == null) {
        return;
      }
      const hoverDocPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
      const hoverTargets = findSliceEdgesAtPoint(doc, hoverDocPoint, allSliceIndices(doc.slices));
      const hoverAxis = hoverTargets.pop();
      dispatchCursorStyle(
        dispatcher,
        hoverTargets.length === 0 ? "default" : SLICE_EDGE_CURSORS[hoverAxis] + "-resize",
      );
      return;
    }
    let docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
    const dragStartDocPoint = this.dragStartDocPoint;
    docPoint = snapPointToGuides(doc, docPoint, appData, [true, null, false]);
    docPoint.x = Math.round(docPoint.x);
    docPoint.y = Math.round(docPoint.y);
    const bounds = [dragStartDocPoint.x, dragStartDocPoint.y, docPoint.x, docPoint.y];
    normalizeAxisAlignedBounds(bounds);
    writeSliceBoundsToDescriptor(doc.slices, 0, bounds);
    doc.dirty = true;
  };

  SliceTool.prototype.onMouseUp = function (doc, dispatcher, appData, keyboard, pointerState) {
    this.commitSlicesHistoryIfChanged(doc);
    if (this.resizeHandleTargets) {
      doc.toolOverlayState.snapGuides = null;
      doc.dirty = true;
    }
    this.dragStartDocPoint = null;
    this.resizeHandleTargets = null;
  };

  SliceTool.prototype.beginSlicesHistorySnapshot = function (doc) {
    this.slicesJsonBefore = JSON.stringify(doc.slices);
    this.selectedSlicesJsonBefore = JSON.stringify(doc.selectedSliceIndices);
  };

  SliceTool.prototype.commitSlicesHistoryIfChanged = function (doc) {
    const slicesJson = JSON.stringify(doc.slices);
    if (slicesJson !== this.slicesJsonBefore) {
      const historyEntry = new HistoryEntry(this.name, this);
      historyEntry.data = buildSlicesHistoryData(
        this,
        slicesJson,
        JSON.stringify(doc.selectedSliceIndices),
      );
      doc.pushHistory(historyEntry);
    }
    this.slicesJsonBefore = null;
  };

  SliceTool.prototype.undo = function (historyData, doc) {
    doc.slices = JSON.parse(historyData.slicesJsonBefore);
    doc.selectedSliceIndices = JSON.parse(historyData.selectedSlicesJsonBefore);
    doc.dirty = true;
  };

  SliceTool.prototype.redo = function (historyData, doc) {
    doc.slices = JSON.parse(historyData.slicesJsonAfter);
    doc.selectedSliceIndices = JSON.parse(historyData.selectedSlicesJsonAfter);
    doc.dirty = true;
  };

  SliceTool.prototype.isModifierKey = function (keyCode, doc) {
    return (
      doc != null &&
      doc.selectedSliceIndices.length !== 0 &&
      (keyCode === KeyboardHandler.Delete || keyCode === KeyboardHandler.Backspace)
    );
  };

  SliceTool.prototype.onKeyEvent = function (doc, dispatcher, appData, keyboard) {
    if (doc == null) {
      return;
    }
    this.beginSlicesHistorySnapshot(doc);
    const arrowMovement = keyboard.getArrowMovement();
    if (arrowMovement.x !== 0 || arrowMovement.y !== 0) {
      nudgeSelectedSlicesByDelta(doc, arrowMovement);
    }
    if (keyboard.isPressed(KeyboardHandler.Delete) || keyboard.isPressed(KeyboardHandler.Backspace)) {
      const slicesCopy = doc.slices.slice(0);
      for (let sliceIdx = 0; sliceIdx < doc.selectedSliceIndices.length; sliceIdx++) {
        doc.slices.splice(doc.slices.indexOf(slicesCopy[doc.selectedSliceIndices[sliceIdx]]), 1);
      }
      doc.selectedSliceIndices = [];
    }
    this.commitSlicesHistoryIfChanged(doc);
  };

  SliceTool.prototype.applyAction = function (actionData, dispatcher, doc, keyboard, appData) {
    if (doc == null || doc.selectedSliceIndices.length === 0) {
      return;
    }
    this.beginSlicesHistorySnapshot(doc);
    const slices = doc.slices;
    const selectedIndices = doc.selectedSliceIndices;
    selectedIndices.sort(function (leftIdx, rightIdx) {
      return leftIdx - rightIdx;
    });
    const remainingSlices = slices.slice(0);
    const newSelectedIndices = [];
    const movedSlices = [];
    for (let sliceIdx = 0; sliceIdx < selectedIndices.length; sliceIdx++) {
      const sliceIndex = selectedIndices[sliceIdx];
      const sliceDescriptor = slices[sliceIndex];
      movedSlices.push(sliceDescriptor);
      remainingSlices.splice(remainingSlices.indexOf(sliceDescriptor), 1);
    }
    const insertIndex = Math.max(0, Math.min(remainingSlices.length, selectedIndices[0] - actionData.dir));
    for (let sliceIdx = 0; sliceIdx < movedSlices.length; sliceIdx++) {
      remainingSlices.splice(insertIndex + sliceIdx, 0, movedSlices[sliceIdx]);
      newSelectedIndices.push(insertIndex + sliceIdx);
    }
    doc.slices = remainingSlices;
    doc.selectedSliceIndices = newSelectedIndices;
    this.commitSlicesHistoryIfChanged(doc);
  };
}

function installSliceSelectToolPrototype() {
  SliceSelectTool.prototype.onMouseDown = function (doc, dispatcher, appData, keyboard, pointerState) {
    if (doc == null) {
      return;
    }
    const docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
    const hitTargets = findSliceEdgesAtPoint(doc, docPoint, doc.selectedSliceIndices);
    hitTargets.pop();
    if (hitTargets.length !== 0) {
      this.dragStartDocPoint = docPoint;
      this.resizeHandleTargets = hitTargets;
      this.beginSlicesHistorySnapshot(doc);
      return;
    }
    const slices = doc.slices;
    const sliceIndex = findSliceIndexAtPoint(slices, docPoint);
    if (sliceIndex === -1) {
      doc.selectedSliceIndices = [];
    } else {
      const selectedIndex = doc.selectedSliceIndices.indexOf(sliceIndex);
      if (keyboard.isPressed(KeyboardHandler.Shift)) {
        if (selectedIndex === -1) {
          doc.selectedSliceIndices.push(sliceIndex);
        } else {
          doc.selectedSliceIndices.splice(selectedIndex, 1);
        }
      } else {
        doc.selectedSliceIndices.sort(function (leftIdx, rightIdx) {
          return leftIdx - rightIdx;
        });
        if (selectedIndex === -1) {
          doc.selectedSliceIndices = [sliceIndex];
        }
        this.dragStartDocPoint = docPoint;
        this.beginSlicesHistorySnapshot(doc);
        this.dragStartUnionBounds = getUnionBoundsOfSliceIndices(slices, doc.selectedSliceIndices);
        this.dragStartBoundsPerSlice = [];
        for (let sliceIdx = 0; sliceIdx < doc.selectedSliceIndices.length; sliceIdx++) {
          this.dragStartBoundsPerSlice.push(
            readSliceBoundsArray(slices, doc.selectedSliceIndices[sliceIdx]),
          );
        }
        if (keyboard.isPressed(KeyboardHandler.Alt)) {
          const slicesCopy = slices.slice(0);
          const selectedIndices = doc.selectedSliceIndices;
          const duplicateIndices = [];
          for (let sliceIdx = 0; sliceIdx < selectedIndices.length; sliceIdx++) {
            const sourceSliceIndex = selectedIndices[sliceIdx];
            const sliceDescriptor = slices[sourceSliceIndex];
            const sourceIndex = slices.indexOf(sliceDescriptor);
            duplicateIndices.push(sourceIndex);
            slices.splice(sourceIndex, 0, JSON.parse(JSON.stringify(sliceDescriptor)));
          }
          doc.selectedSliceIndices = duplicateIndices;
        }
      }
    }
    doc.dirty = true;
  };

  SliceSelectTool.prototype.onMouseMove = function (doc, dispatcher, appData, keyboard, pointerState) {
    let docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
    if (this.dragStartDocPoint == null) {
      const hitTargets = findSliceEdgesAtPoint(doc, docPoint, doc.selectedSliceIndices);
      const resizeAxis = hitTargets.pop();
      dispatchCursorStyle(
        dispatcher,
        hitTargets.length === 0 ? "default" : SLICE_EDGE_CURSORS[resizeAxis] + "-resize",
      );
      return;
    }
    if (!this.didDragSlices && docPoint.equals(this.dragStartDocPoint)) {
      return;
    }
    this.didDragSlices = true;
    const slices = doc.slices;
    const hitTargets = this.resizeHandleTargets;
    if (hitTargets) {
      dragSliceEdgesToPoint(doc, appData, docPoint, hitTargets);
    } else {
      const dragDelta = docPoint.subtract(this.dragStartDocPoint);
      const unionBoundsCopy = this.dragStartUnionBounds.slice(0);
      offsetSliceBoundsByDelta(unionBoundsCopy, dragDelta);
      const dragRect = new Rect(
        unionBoundsCopy[0],
        unionBoundsCopy[1],
        unionBoundsCopy[2] - unionBoundsCopy[0],
        unionBoundsCopy[3] - unionBoundsCopy[1],
      );
      const snapOffsets = snapRectCornersToGuides(
        doc,
        dragRect,
        appData,
        [true, null, false],
        true,
      );
      updateLayerDragPositions(doc, dragRect, snapOffsets);
      dragDelta.x += snapOffsets[0];
      dragDelta.y += snapOffsets[1];
      for (let sliceIdx = 0; sliceIdx < doc.selectedSliceIndices.length; sliceIdx++) {
        writeSliceBoundsToDescriptor(
          slices,
          doc.selectedSliceIndices[sliceIdx],
          this.dragStartBoundsPerSlice[sliceIdx],
        );
      }
      nudgeSelectedSlicesByDelta(doc, dragDelta);
    }
    doc.dirty = true;
  };

  SliceSelectTool.prototype.onMouseUp = function (doc, dispatcher, appData, keyboard, pointerState) {
    if (this.dragStartDocPoint == null) {
      return;
    }
    this.commitSlicesHistoryIfChanged(doc);
    doc.toolOverlayState.snapGuides = null;
    doc.dirty = true;
    this.dragStartDocPoint = null;
    this.resizeHandleTargets = null;
    this.dragStartBoundsPerSlice = null;
    this.didDragSlices = false;
  };
}

function installSliceToolStatics() {
  SliceTool.findSliceIndexAtPoint = findSliceIndexAtPoint;
  SliceTool.normalizeAxisAlignedBounds = normalizeAxisAlignedBounds;
  SliceTool.readSliceBoundsArray = readSliceBoundsArray;
  SliceTool.getUnionBoundsOfSliceIndices = getUnionBoundsOfSliceIndices;
  SliceTool.clampBoundsToCanvas = clampBoundsToCanvas;
  SliceTool.offsetSliceBoundsByDelta = offsetSliceBoundsByDelta;
  SliceTool.writeSliceBoundsToDescriptor = writeSliceBoundsToDescriptor;
  SliceTool.nudgeSelectedSlicesByDelta = nudgeSelectedSlicesByDelta;
  SliceTool.rescaleSlicesForCanvas = rescaleSlicesForCanvas;
  SliceTool.createDefaultSliceDescriptor = createDefaultSliceDescriptor;
  SliceSelectTool.findSliceAtPoint = findSliceAtPoint;
}

/**
 * Chain SliceTool onto ToolBase, and SliceSelectTool onto SliceTool.
 */
export function installSliceTools() {
  SliceTool.prototype = Object.create(ToolBase.prototype);
  installSliceToolPrototype();
  SliceSelectTool.prototype = Object.create(SliceTool.prototype);
  installSliceSelectToolPrototype();
  installSliceToolStatics();
}
