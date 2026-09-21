/**
 * Snapping a drag to what is already on the canvas.
 *
 * A pointer or a rectangle is pulled towards the nearest guide, grid line,
 * slice edge, other layer's edge or centre, or the canvas bounds — whichever
 * lies within a few screen pixels of it. The move, crop, shape, text, pen and
 * slice tools all drag through here, so the rule for what counts as "near"
 * lives in one place and every tool snaps alike.
 *
 * `computeGuideSnapDelta` returns `[dx, dy, snappedX, snappedY]`, where a
 * coordinate of 1e9 means that axis found nothing to snap to.
 */

import { Point } from "../../core/math/point.js";
import { getDevicePixelRatio } from "../../core/dom.js";
import { readSliceBoundsArray } from "../formats/psd/slice-descriptor.js";
import { docUnitsToPixels } from "../../engine/compositing/geometry.js";

export function snapPointToGuides(doc, docPoint, appData, snapOptions) {
  var snapDelta = computeGuideSnapDelta(doc, [
    [docPoint.x],
    [docPoint.y]
  ], appData, snapOptions);
  return new Point(docPoint.x + snapDelta[0], docPoint.y + snapDelta[1]);
}

export function snapRectCornersToGuides(doc, rect, appData, snapOptions, useCenterOnly) {
  var centerWeight = useCenterOnly == true ? 0 : 1,
    snapDelta = computeGuideSnapDelta(doc, [
      [rect.x, rect.x + (rect.width >>> centerWeight), rect.x + rect.width],
      [rect.y, rect.y + (rect.height >>> centerWeight), rect.y + rect.height]
    ], appData, snapOptions);
  return snapDelta
}

export function computeGuideSnapDelta(doc, sampleCoords, appData, snapOptions) {
  if (snapOptions == null) snapOptions = [true, null, true];
  var snapDelta = [0, 0, 1e9, 1e9];
  if (!appData.snapEnabled) return snapDelta;
  var adjustedCoords = JSON.parse(JSON.stringify(sampleCoords));
  for (var axisIdx = 0; axisIdx < 2; axisIdx++) {
    var bestOffset = 1e9,
      axisSamples = sampleCoords[axisIdx],
      snappedCoord = 0;
    for (var sampleIdx = 0; sampleIdx < axisSamples.length; sampleIdx++) {
      var snappedValue = snapCoordinateToGuide(doc, axisSamples[sampleIdx], adjustedCoords[1 - axisIdx][sampleIdx], axisIdx, appData, snapOptions);
      if (snappedValue != 1e9) adjustedCoords[axisIdx][sampleIdx] = snappedValue;
      if (snappedValue != 1e9 && Math.abs(snappedValue - axisSamples[sampleIdx]) < Math.abs(bestOffset)) {
        bestOffset = snappedValue - axisSamples[sampleIdx];
        snappedCoord = snappedValue
      }
    }
    if (bestOffset != 1e9) {
      snapDelta[axisIdx] = bestOffset;
      snapDelta[axisIdx + 2] = snappedCoord
    }
  }
  return snapDelta
}

export function snapCoordinateToGuide(doc, coordinate, orthoSample, axisIndex, appData, snapOptions) {
  var nearestSnap = 1e9,
    snapToggles = appData.showToggles,
    prefs = appData.prefs,
    layerStack = [doc.root];
  while (layerStack.length != 0 && snapToggles[2]) {
    var treeNode = layerStack.pop(),
      layer = treeNode.layer,
      layerRect = layer.rect;
    if (!layer.isVisible()) continue;
    if (treeNode.children)
      for (var childIdx = 0; childIdx < treeNode.children.length; childIdx++) layerStack.push(treeNode.children[childIdx]);
    if (doc.selectedLayerIndices.indexOf(treeNode.index) != -1 || layerRect.isEmpty()) continue;
    if (axisIndex == 0) {
      var layerWidth = layerRect.width,
        halfWidth = layerWidth >>> 1;
      if (Math.abs(layerRect.x - coordinate) < Math.abs(nearestSnap - coordinate)) nearestSnap = layerRect.x;
      if (Math.abs(layerRect.x + halfWidth - coordinate) < Math.abs(nearestSnap - coordinate)) nearestSnap = layerRect.x + halfWidth;
      if (Math.abs(layerRect.x + layerWidth - coordinate) < Math.abs(nearestSnap - coordinate)) nearestSnap = layerRect.x + layerWidth
    } else {
      var layerHeight = layerRect.height,
        halfHeight = layerHeight >>> 1;
      if (Math.abs(layerRect.y - coordinate) < Math.abs(nearestSnap - coordinate)) nearestSnap = layerRect.y;
      if (Math.abs(layerRect.y + halfHeight - coordinate) < Math.abs(nearestSnap - coordinate)) nearestSnap = layerRect.y + halfHeight;
      if (Math.abs(layerRect.y + layerHeight - coordinate) < Math.abs(nearestSnap - coordinate)) nearestSnap = layerRect.y + layerHeight
    }
  }
  if (snapOptions[0] && snapToggles[0] && prefs.guides && appData.extras) {
    var guideCoords = doc.guides[axisIndex];
    for (var guideIdx = 0; guideIdx < guideCoords.length; guideIdx++)
      if (Math.abs(guideCoords[guideIdx] - coordinate) < Math.abs(nearestSnap - coordinate)) nearestSnap = guideCoords[guideIdx]
  }
  if (snapToggles[1] && prefs.showGrid && appData.extras) {
    var gridSpacing = Math.round(docUnitsToPixels(prefs.gridSize, doc, prefs.gridUnits));
    if (axisIndex == 1 && prefs.gridType == 1) {
      var triangleOffset = orthoSample * .5 * Math.sqrt(4 / 3),
        gridCoord;
      gridSpacing *= Math.sqrt(4 / 3);
      gridCoord = Math.round((coordinate - triangleOffset) / gridSpacing) * gridSpacing + triangleOffset;
      if (Math.abs(gridCoord - coordinate) < Math.abs(nearestSnap - coordinate)) nearestSnap = gridCoord;
      gridCoord = Math.round((coordinate + triangleOffset) / gridSpacing) * gridSpacing - triangleOffset;
      if (Math.abs(gridCoord - coordinate) < Math.abs(nearestSnap - coordinate)) nearestSnap = gridCoord
    } else {
      var gridCoord = Math.round(coordinate / gridSpacing) * gridSpacing;
      if (Math.abs(gridCoord - coordinate) < Math.abs(nearestSnap - coordinate)) nearestSnap = gridCoord
    }
  }
  var sliceList = doc.slices;
  if (snapToggles[3] && prefs.slices && appData.extras && sliceList.length != 0) {
    for (var sliceIdx = 0; sliceIdx < sliceList.length; sliceIdx++) {
      if (!snapOptions[2] && doc.selectedSliceIndices.indexOf(sliceIdx) != -1) continue;
      var sliceBounds = readSliceBoundsArray(sliceList, sliceIdx);
      for (var boundIdx = 0; boundIdx < 3; boundIdx += 2)
        if (sliceBounds[boundIdx + axisIndex] != coordinate && Math.abs(sliceBounds[boundIdx + axisIndex] - coordinate) < Math.abs(nearestSnap - coordinate)) nearestSnap = sliceBounds[boundIdx + axisIndex]
    }
  }
  if (snapOptions[1]) {
    var referenceRect = snapOptions[1],
      refWidth = referenceRect.width,
      refHeight = referenceRect.height,
      refSnapCoords = [referenceRect.x, referenceRect.y, referenceRect.x + (refWidth >>> 1), referenceRect.y + (refHeight >>> 1), referenceRect.x + refWidth, referenceRect.y + refHeight];
    for (var boundIdx = 0; boundIdx < 6; boundIdx += 2)
      if (Math.abs(refSnapCoords[boundIdx + axisIndex] - coordinate) < Math.abs(nearestSnap - coordinate)) nearestSnap = refSnapCoords[boundIdx + axisIndex]
  }
  if (snapToggles[4]) {
    var docWidth = doc.width,
      docHeight = doc.height,
      docSnapCoords = [0, 0, docWidth >>> 1, docHeight >>> 1, docWidth, docHeight];
    for (var boundIdx = 0; boundIdx < 6; boundIdx += 2)
      if (Math.abs(docSnapCoords[boundIdx + axisIndex] - coordinate) < Math.abs(nearestSnap - coordinate)) nearestSnap = docSnapCoords[boundIdx + axisIndex]
  }
  var snappedCoordinate = Math.abs(nearestSnap - coordinate) <= 4 * getDevicePixelRatio() / doc.pathViewport.zoomScale ? nearestSnap : 1e9;
  return snappedCoordinate
}

export function updateLayerDragPositions(doc, snappedRect, snapDelta) {
  var snapGuideOverlay = doc.toolOverlayState.snapGuides = {
      coords: [],
      commands: []
    },
    snapX = snappedRect.x + snapDelta[0],
    snapY = snappedRect.y + snapDelta[1];
  if (snapDelta[2] != 1e9) {
    snapGuideOverlay.commands.push("M", "L");
    snapGuideOverlay.coords.push(snapDelta[2], snapY, snapDelta[2], snapY + snappedRect.height)
  }
  if (snapDelta[3] != 1e9) {
    snapGuideOverlay.commands.push("M", "L");
    snapGuideOverlay.coords.push(snapX, snapDelta[3], snapX + snappedRect.width, snapDelta[3])
  }
  doc.dirty = true
}
