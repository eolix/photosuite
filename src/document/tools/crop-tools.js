/**
 * Crop, perspective-crop, slice, and slice-select tools. Crop sessions edit canvas
 * bounds or layer pixels; slice tools maintain export slice descriptors on the
 * document. `registerCropTools` chains them onto ToolBase.
 */

import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";

import { Matrix2D } from "../../core/math/matrix2d.js";
import { FontRegistry } from "../../fonts/font-registry.js";
import { HistoryEntry } from "../model/document.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { AppEvent } from "../../core/event-bus.js";
import { ToolBase, ToolId } from "../model/tool-base.js";
import { TransformToolBase } from "../transform/transform-static.js";
import { TransformBox } from "../transform/transform-box.js";
import { ShapeToolBase } from "./shape-tools.js";
import { SliceTool } from "../transform/slice-tools.js";
import { snapPointToGuides } from "../model/guide-snapping.js";
import { translateLayersByDelta } from "../model/layer-translate.js";
import { resizeDocumentCanvas, transformArtboardBounds } from "../model/layer-translate.js";
import { computeContentBoundsRgba } from "../../engine/compositing/pixel-ops.js";
import { pixelAlignBoundsFromCoords, rectToPathOutline, transformCoordPairs } from "../../engine/compositing/anti-alias.js";
import { cornersToHomography, invert, isAffine, matrix2DToHomography, toMatrix2D } from "../../engine/compositing/homography.js";
import { estimatePanoramaHomographies } from "../../engine/compositing/feature-matcher.js";



function createDefaultAspectConstraint() {
  return {
    constraintMode: 0,
    constraintWidth: 0,
    constraintHeight: 0,
  };
}

function rectToCornerCoords(cropRect) {
  return [
    cropRect.x,
    cropRect.y,
    cropRect.x + cropRect.width,
    cropRect.y,
    cropRect.x + cropRect.width,
    cropRect.y + cropRect.height,
    cropRect.x,
    cropRect.y + cropRect.height,
  ];
}

function dispatchCursorOverlay(dispatcher, cursorOverlayId) {
  const cursorEvent = new AppEvent(EventType.uiDispatch, true);
  cursorEvent.data = {
    dispatchKind: UiCommand.splashOptionsUpdate,
    cursorOverlayId,
  };
  dispatcher.dispatch(cursorEvent);
}

/** Descriptor helpers for the unit-valued (UntF) action-descriptor fields. */
function pixelUnit(val) {
  return { t: "UntF", v: { type: "#Pxl", val } };
}
function angleUnit(val) {
  return { t: "UntF", v: { type: "#Ang", val } };
}
function resolutionUnit(val) {
  return { t: "UntF", v: { type: "#Rsl", val } };
}


export function CropToolBase(nameKey, toolId, iconPath) {
  ToolBase.call(this, nameKey, toolId, iconPath);
  this.cropOptions = {
    aspectConstraint: createDefaultAspectConstraint(),
    deleteCroppedPixels: false,
  };
  this.activeOp = null;
  this.cursor = null;
  this.lastCropMouseUpTime = 0;
  this.lastPointerState = null;
  this.startPos = null;
  this.marqueePreviewRect = null
};
CropToolBase.prototype.isActive = function() {
  return this.activeOp != null;
};
CropToolBase.prototype.wantsInput = function(keyboard) {
  return this.activeOp && this.activeOp.isHandleDragActive();
};
CropToolBase.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.lastPointerState = pointerState;
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
  docPoint.x = Math.round(docPoint.x);
  docPoint.y = Math.round(docPoint.y);
  var aspectController = this.cropOptions.aspectConstraint,
    aspectRatio = aspectController.constraintMode != 0 ? aspectController.constraintWidth / aspectController.constraintHeight : null;
  if (this.activeOp) this.activeOp.onMouseDown(doc, appData, keyboard, docPoint, aspectRatio, false);
  else this.startPos = snapPointToGuides(doc, docPoint, appData)
};
CropToolBase.prototype.createCropActionRecord = function(cropRect, lockAspectRatio) {
  var cornerCoords = rectToCornerCoords(cropRect);
  return new TransformBox(cornerCoords, true, false, this.id == ToolId.TOOL_PERSPECTIVE_CROP, true, lockAspectRatio, this.id == ToolId.TOOL_PERSPECTIVE_CROP ? 2 : 0, this.id == ToolId.TOOL_PERSPECTIVE_CROP);
};
CropToolBase.prototype.updateCursor = function(dispatcher) {
  dispatchCursorOverlay(dispatcher, this.cursor);
};
CropToolBase.prototype.enable = function(doc, dispatcher, appData, keyboard) {
  this.appDispatcher = dispatcher;
  this.cursor = "crosshair";
  this.updateCursor(dispatcher);
  if (doc != null && doc.selectionMask) {
    var aspectController = this.cropOptions.aspectConstraint = {
      constraintMode: 0,
      constraintWidth: 0,
      constraintHeight: 0
    };
    this.emitEvent(dispatcher, EventType.uiDispatch, {
      dispatchKind: UiCommand.forwardActiveToolGesture,
      routingChannel: this.id,
      showCropConfirm: false,
      aspectController: aspectController
    });
    this.applyAction({
      subAction: "cropby",
      cropSourceMode: 3
    }, dispatcher, doc, keyboard, appData)
  }
};
CropToolBase.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.lastPointerState = pointerState;
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
  if (!pointerState.isDown) {
    var cursorName = "crosshair";
    if (this.activeOp) {
      var handleCursor = this.activeOp.getHandleCursor(docPoint, doc.pathViewport.zoomScale);
      if (handleCursor) cursorName = handleCursor;
      else cursorName = "default"
    }
    if (cursorName != this.cursor) {
      this.cursor = cursorName;
      this.updateCursor(dispatcher)
    }
  }
  if (this.activeOp) this.activeOp.onMouseMove(doc, appData, keyboard, docPoint);
  else if (this.startPos) {
    var constrainedPoints = ShapeToolBase.constrainShapePoints(this.startPos, snapPointToGuides(doc, docPoint, appData), keyboard, true, this.cropOptions.aspectConstraint),
      startX = constrainedPoints[0].x,
      startY = constrainedPoints[0].y,
      previewRect = this.marqueePreviewRect = new Rect(startX, startY, constrainedPoints[1].x - startX, constrainedPoints[1].y - startY);
    doc.toolOverlayState.overlayTransform = rectToPathOutline(previewRect);
    doc.dirty = true;
    ToolBase.drawDimensionOverlay(pointerState.x + 10, pointerState.y - 10, previewRect, doc, appData)
  }
};
CropToolBase.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.lastPointerState = pointerState;
  if (this.activeOp == null) {
    if (this.startPos) {
      var previewRect = this.marqueePreviewRect;
      if (previewRect) {
        var aspectController = this.cropOptions.aspectConstraint;
        this.activeOp = this.createCropActionRecord(previewRect, aspectController.constraintMode != 0);
        this.activeOp.redrawOverlay(doc, appData);
        this.marqueePreviewRect = null;
        this.emitEvent(dispatcher, EventType.uiDispatch, {
          dispatchKind: UiCommand.forwardActiveToolGesture,
          routingChannel: this.id,
          showCropConfirm: true
        })
      }
      this.startPos = null;
      doc.toolOverlayState.floatingBitmapOverlays = [];
      doc.dirty = true
    }
    return
  }
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
  this.activeOp.onMouseUp(doc, appData, keyboard, docPoint);
  this.emitEvent(dispatcher, EventType.uiDispatch, {
    dispatchKind: UiCommand.forwardActiveToolGesture,
    routingChannel: this.id,
    showCropConfirm: true
  });
  var cornerCoords = this.activeOp.getCornerCoords();
  if (Math.abs(cornerCoords[0] - cornerCoords[4]) < 2 && Math.abs(cornerCoords[1] - cornerCoords[5]) < 2) {
    this.disable(doc, dispatcher, null, keyboard);
    return
  }
  if (Date.now() - this.lastCropMouseUpTime < 200 && this.activeOp.containsDocPoint(docPoint)) {
    this.commitCrop(doc, appData);
    this.disable(doc, dispatcher, appData, keyboard);
    return
  }
  this.lastCropMouseUpTime = Date.now()
};
CropToolBase.prototype.onKeyEvent = function(doc, dispatcher, appData, keyboard) {
  var activeCropOp = this.activeOp;
  if (activeCropOp == null || this.lastPointerState && this.lastPointerState.isDown) return;
  if (keyboard.isPressed(KeyboardHandler.Enter)) {
    this.commitCrop(doc, appData);
    this.disable(doc, dispatcher, appData, keyboard)
  } else if (keyboard.isPressed(KeyboardHandler.Escape)) {
    this.disable(doc, dispatcher, appData, keyboard)
  } else activeCropOp.onKeyEvent(doc, appData, keyboard)
};
CropToolBase.buildCropAction = function(cropBounds, angleDeg) {
  var cropDescriptor = {
    classID: "null",
    T: {
      t: "Objc",
      v: {
        classID: "Rctn",
        Top: pixelUnit(cropBounds[1]),
        Left: pixelUnit(cropBounds[0]),
        Btom: pixelUnit(cropBounds[1] + cropBounds[3]),
        Rght: pixelUnit(cropBounds[0] + cropBounds[2])
      }
    },
    Angl: angleUnit(angleDeg != null ? angleDeg : 0),
    Dlt: {
      t: "bool",
      v: true
    },
    cropAspectRatioModeKey: {
      t: "enum",
      v: {
        cropAspectRatioModeClass: "pureAspectRatio"
      }
    },
    CnsP: {
      t: "bool",
      v: false
    }
  };
  return {
    uf: "crop",
    actionDescriptor: cropDescriptor
  }
};
CropToolBase.buildTrimAction = function(trimModeIndex, trimSides) {
  if (trimSides == null) trimSides = [true, true, true, true];
  var trimDescriptor = {
      classID: "trim",
      trimBasedOn: {
        t: "enum",
        v: {
          trimBasedOn: ["topLeftPixelColor", "bottomRightPixelColor", "Trns"][trimModeIndex]
        }
      }
    },
    sideKeys = ["Top", "Left", "Btom", "Rght"];
  for (var sideIdx = 0; sideIdx < 4; sideIdx++) trimDescriptor[sideKeys[sideIdx]] = {
    t: "bool",
    v: trimSides[sideIdx]
  };
  return {
    uf: "trim",
    actionDescriptor: trimDescriptor
  }
};
CropToolBase.buildImageSizeAction = function(width, height, resolutionDpi, interpolationIndex) {
  var imageSizeDescriptor = {
    classID: "null"
  };
  if (interpolationIndex != null) {
    imageSizeDescriptor.Wdth = pixelUnit(width);
    imageSizeDescriptor.Hght = pixelUnit(height);
    imageSizeDescriptor.Intr = {
      t: "enum",
      v: {
        Intp: ["Nrst", "Blnr", "bicubicSharper"][interpolationIndex]
      }
    }
  }
  if (resolutionDpi != null) imageSizeDescriptor.Rslt = resolutionUnit(resolutionDpi);
  return {
    uf: "imageSize",
    actionDescriptor: imageSizeDescriptor
  }
};
CropToolBase.buildCanvasSizeAction = function(width, height, anchorIndex) {
  if (anchorIndex == null) anchorIndex = 4;
  var anchorRow = Math.floor(anchorIndex / 3),
    anchorCol = anchorIndex % 3;
  return {
    uf: "canvasSize",
    actionDescriptor: {
      classID: "null",
      Wdth: pixelUnit(width),
      Hght: pixelUnit(height),
      Hrzn: {
        t: "enum",
        v: {
          HrzL: ["Left", "Cntr", "Rght"][anchorCol]
        }
      },
      Vrtc: {
        t: "enum",
        v: {
          VrtL: ["Top", "Cntr", "Btom"][anchorRow]
        }
      }
    }
  };
};
/**
 * Translate a scripted image-size / canvas-size / trim / crop action descriptor
 * into the internal crop event handleInput consumes. Returns null for an
 * unrecognised action.
 */
function resolveScriptAction(event, doc) {
  var actionPayload = event.scriptActionPayload,
    actionType = actionPayload.uf,
    descriptor = actionPayload.actionDescriptor,
    docAspectRatio = doc.width / doc.height,
    targetWidth = descriptor.Wdth ? descriptor.Wdth.v.val : -1,
    targetHeight = descriptor.Hght ? descriptor.Hght.v.val : -1,
    dpi = descriptor.Rslt ? descriptor.Rslt.v.val : null,
    unitType = descriptor.Wdth ? descriptor.Wdth.v.type : descriptor.Hght ? descriptor.Hght.v.type : -1,
    resolvedInterpolation = 1;
  if (actionType == "imageSize") {
    if (descriptor.Intr) {
      if (descriptor.Intr.v.Intp == "Nrst") resolvedInterpolation = 0;
      if (descriptor.Intr.v.Intp == "bicubicSharper") resolvedInterpolation = 2;
      if (targetWidth == -1 && targetHeight == -1) {
        var dpiScale = dpi / doc.dpi;
        targetWidth = Math.round(doc.width * dpiScale);
        targetHeight = Math.round(doc.height * dpiScale)
      } else if (unitType == "#Prc") {
        if (targetWidth != -1) targetWidth = Math.round(doc.width * targetWidth / 100);
        if (targetHeight != -1) targetHeight = Math.round(doc.height * targetHeight / 100)
      }
      if (descriptor.CnsP && descriptor.CnsP.v) {
        if (targetWidth == -1) targetWidth = Math.round(targetHeight * docAspectRatio);
        if (targetHeight == -1) targetHeight = Math.round(targetWidth / docAspectRatio)
      }
    } else {
      if (unitType == "#Prc") dpi = Math.round(doc.dpi / ((targetWidth != -1 ? targetWidth : targetHeight) / 100));
      else if (unitType == -1) dpi = Math.round(dpi);
      else throw "crop: unsupported image-size unit " + unitType;
      targetWidth = doc.width;
      targetHeight = doc.height
    }
    return {
      actionKind: "imgsize",
      targetWidth: targetWidth,
      targetHeight: targetHeight,
      dpi: dpi,
      interpolationMode: resolvedInterpolation
    };
  }
  if (actionType == "canvasSize") {
    if (targetWidth == -1) targetWidth = doc.width;
    if (targetHeight == -1) targetHeight = doc.height;
    if (descriptor.Rltv && descriptor.Rltv.v == true) {
      if (descriptor.Wdth) targetWidth += doc.width;
      if (descriptor.Hght) targetHeight += doc.height
    }
    var verticalAnchor = descriptor.Vrtc ? descriptor.Vrtc.v.VrtL : "Cntr",
      horizontalAnchor = descriptor.Hrzn ? descriptor.Hrzn.v.HrzL : "Cntr";
    return {
      actionKind: "canvsize",
      targetWidth: targetWidth,
      targetHeight: targetHeight,
      canvasAnchorIndex: 3 * ["Top", "Cntr", "Btom"].indexOf(verticalAnchor) + ["Left", "Cntr", "Rght"].indexOf(horizontalAnchor)
    };
  }
  if (actionType == "revealAll") return { actionKind: "revealAll" };
  if (actionType == "trim") {
    var trimMode = {
      topLeftPixelColor: 0,
      bottomRightPixelColor: 1,
      Trns: 2
    } [descriptor.trimBasedOn.v.trimBasedOn];
    if (trimMode == null) throw "crop: unknown trim mode " + descriptor.trimBasedOn.v.trimBasedOn;
    var sideKeys = ["Top", "Left", "Btom", "Rght"],
      sideFlags = [true, true, true, true];
    for (var sideIdx = 0; sideIdx < 4; sideIdx++)
      if (descriptor[sideKeys[sideIdx]]) sideFlags[sideIdx] = descriptor[sideKeys[sideIdx]].v;
    return {
      actionKind: "trim",
      trimMode: trimMode,
      trimSides: sideFlags
    };
  }
  if (actionType == "crop") {
    var rectDescriptor = descriptor.T.v,
      cropLeft = Math.round(rectDescriptor.Left.v.val),
      cropTop = Math.round(rectDescriptor.Top.v.val),
      cropWidth = Math.round(rectDescriptor.Rght.v.val) - cropLeft,
      cropHeight = Math.round(rectDescriptor.Btom.v.val) - cropTop;
    return {
      actionKind: "canvsize",
      targetWidth: cropWidth,
      targetHeight: cropHeight,
      cropOffset: new Point(cropLeft, cropTop)
    };
  }
  console.log(actionPayload);
  return null;
}
CropToolBase.prototype.handleInput = function(event, dispatcher, doc, keyboard, resampleMode) {
  var targetRect = new Rect(0, 0, doc.width, doc.height),
    historyLabelKey = "dialogs.canvasSize",
    dpi = doc.dpi,
    centerX = doc.width / 2,
    centerY = doc.height / 2,
    interpolationMode = 1,
    transformSnapshot,
    homography;
  if (event.actionKind == "fromAction") {
    var resolvedEvent = resolveScriptAction(event, doc);
    if (resolvedEvent) this.handleInput(resolvedEvent, dispatcher, doc, keyboard, resampleMode);
    return
  } else if (event.actionKind == "imgsize") {
    targetRect = new Rect(0, 0, event.targetWidth, event.targetHeight);
    if (event.dpi) dpi = event.dpi;
    interpolationMode = event.interpolationMode
  } else if (event.actionKind == "canvsize") {
    var anchorIndex = event.canvasAnchorIndex != null ? event.canvasAnchorIndex : 0;
    targetRect = new Rect(0, 0, event.targetWidth, event.targetHeight);
    var widthDelta = doc.width - event.targetWidth,
      heightDelta = doc.height - event.targetHeight,
      offsetX = Math.round(widthDelta / 2),
      offsetY = Math.round(heightDelta / 2);
    if (anchorIndex == 1 || anchorIndex == 4 || anchorIndex == 7) targetRect.x = offsetX;
    if (anchorIndex == 2 || anchorIndex == 5 || anchorIndex == 8) targetRect.x = widthDelta;
    if (anchorIndex == 3 || anchorIndex == 4 || anchorIndex == 5) targetRect.y = offsetY;
    if (anchorIndex == 6 || anchorIndex == 7 || anchorIndex == 8) targetRect.y = heightDelta;
    if (event.cropOffset) {
      targetRect.x = event.cropOffset.x;
      targetRect.y = event.cropOffset.y
    }
  } else if (event.actionKind == "rot" && (event.gestureValue + 2 * Math.PI) % (Math.PI / 2) != 0) {
    var pathCoords = rectToPathOutline(targetRect).coords,
      rotationMatrix = new Matrix2D;
    rotationMatrix.translate(-centerX, -centerY);
    rotationMatrix.rotate(event.gestureValue);
    rotationMatrix.translate(centerX, centerY);
    transformCoordPairs(pathCoords, rotationMatrix, pathCoords);
    targetRect = pixelAlignBoundsFromCoords(pathCoords)
  } else if (event.actionKind == "rot" && event.gestureValue != Math.PI && event.gestureValue != -Math.PI) {
    targetRect = new Rect(centerX - doc.height / 2, centerY - doc.width / 2, doc.height, doc.width);
    if ((doc.width + doc.height & 1) == 1) {
      centerX = Math.floor(centerX);
      centerY = Math.floor(centerY);
      targetRect = new Rect(centerX - Math.floor(doc.height / 2), centerY - Math.floor(doc.width / 2), doc.height, doc.width);
      if ((doc.width & 1) == 1 && event.gestureValue != -Math.PI / 2) targetRect.y--;
      if ((doc.height & 1) == 1 && event.gestureValue == -Math.PI / 2) targetRect.x--
    }
  } else if (event.actionKind == "trim") {
    historyLabelKey = "dialogs.trim";
    var rasterData = doc.getRasterData(),
      fullBounds = new Rect(0, 0, doc.width, doc.height);
    targetRect = computeContentBoundsRgba(rasterData, fullBounds, event.trimMode, event.trimSides);
    if (targetRect.isEmpty()) targetRect = fullBounds
  } else if (event.actionKind == "cropbysel") {
    historyLabelKey = "dialogs.crop";
    targetRect = doc.selectionMask.rect.clone()
  } else if (event.actionKind == "revealAll") {
    historyLabelKey = "dialogs.revealAll";
    targetRect = doc.root.getSelectionRect(doc, true)
  }
  if (event.actionKind == "imgsize" || event.actionKind == "rot" || event.actionKind == "scl") {
    var transformMatrix = new Matrix2D;
    if (event.actionKind == "imgsize") {
      historyLabelKey = "dialogs.imageSize";
      transformMatrix.scale(event.targetWidth / doc.width, event.targetHeight / doc.height)
    } else {
      transformMatrix.translate(-centerX, -centerY);
      if (event.actionKind == "rot") transformMatrix.rotate(event.gestureValue);
      if (event.actionKind == "scl") transformMatrix.scale(event.gestureValue.x, event.gestureValue.y);
      transformMatrix.translate(centerX, centerY);
      historyLabelKey = event.historyLabelKey
    }
    homography = matrix2DToHomography(transformMatrix);
    transformSnapshot = this.applyCropTransformToDocument(doc, resampleMode, true, homography, interpolationMode)
  } else if (event.actionKind == "auto-align") {
    if (doc.selectedLayerIndices.length < 2) {
      alert("Select two or more layers.");
      return
    }
    var layerRasterPairs = [];
    for (var layerIdx = 0; layerIdx < doc.selectedLayerIndices.length; layerIdx++) {
      var layer = doc.layers[doc.selectedLayerIndices[layerIdx]];
      if (!layer.hasPixelData() && layer.add.placedData == null) {
        alert("Unsupported layer selected.");
        return
      }
      if (layer.rect.isEmpty()) {
        alert("Empty layer selected.");
        return
      }
      layerRasterPairs.push([layer.buffer, layer.rect])
    }
    var panoramaHomographies = estimatePanoramaHomographies(layerRasterPairs, 0);
    if (panoramaHomographies == null) {
      alert("No similarity found.");
      return
    }
    homography = panoramaHomographies[1];
    var savedLayerSelection = doc.selectedLayerIndices;
    doc.selectedLayerIndices = doc.selectedLayerIndices.slice(1);
    transformSnapshot = this.applyCropTransformToDocument(doc, resampleMode, false, panoramaHomographies.slice(1), interpolationMode);
    doc.selectedLayerIndices = savedLayerSelection;
    targetRect = doc.root.getSelectionRect(doc, true);
    historyLabelKey = "edit.autoAlign"
  }
  var fullCanvasRect = new Rect(0, 0, doc.width, doc.height);
  if (!targetRect.isEmpty() && (!targetRect.equals(fullCanvasRect) || transformSnapshot != null)) {
    var historyEntry = new HistoryEntry(historyLabelKey, this);
    historyEntry.data = {
      rectBefore: fullCanvasRect,
      rectAfter: targetRect,
      dpiBefore: doc.dpi,
      dpiAfter: dpi,
      layerTransformSnapshot: transformSnapshot,
      homography: homography,
      sliceSnapshots: CropToolBase.snapshotSlicesForHistory(doc, targetRect, fullCanvasRect, transformSnapshot != null)
    };
    doc.pushHistory(historyEntry);
    this.redo(historyEntry.data, doc)
  }
};
CropToolBase.snapshotSlicesForHistory = function(doc, newCanvasRect, previousFullRect, rescaleSlices) {
  if (doc.slices.length == 0) return null;
  var slicesBeforeJson = JSON.stringify(doc.slices),
    rescaledSlices = JSON.parse(slicesBeforeJson);
  SliceTool.rescaleSlicesForCanvas(rescaledSlices, newCanvasRect, previousFullRect, rescaleSlices);
  rescaledSlices = JSON.stringify(rescaledSlices);
  return [slicesBeforeJson, rescaledSlices]
};
CropToolBase.prototype.applyCropTransformToDocument = function(doc, resampleMode, includeAllLayers, homography, interpolationMode, clipBounds) {
  var layerTransformState = {
    targetIndices: [],
    snapshotsBefore: null,
    snapshotsAfter: null
  };
  if (includeAllLayers) {
    for (var layerIdx = 0; layerIdx < doc.layers.length; layerIdx++) layerTransformState.targetIndices.push(layerIdx);
    for (var pathIdx = 0; pathIdx < doc.paths.length; pathIdx++) layerTransformState.targetIndices.push(-1 - pathIdx);
    for (var channelIdx = 0; channelIdx < doc.extraChannels.length; channelIdx++) layerTransformState.targetIndices.push(-1e3 - channelIdx)
  } else layerTransformState.targetIndices = doc.selectedLayerIndices.slice(0);
  layerTransformState.snapshotsBefore = TransformToolBase.captureLayerSnapshots(doc, layerTransformState.targetIndices, true);
  TransformToolBase.applyTransformToLayers(doc, FontRegistry.instance, layerTransformState.targetIndices, layerTransformState.snapshotsBefore, interpolationMode, homography, null, true, clipBounds);
  layerTransformState.snapshotsAfter = TransformToolBase.captureLayerSnapshots(doc, layerTransformState.targetIndices, true);
  return layerTransformState
};
CropToolBase.prototype.redo = function(historyData, doc) {
  if (historyData.dpiAfter) doc.dpi = historyData.dpiAfter;
  if (historyData.sliceSnapshots) doc.slices = JSON.parse(historyData.sliceSnapshots[1]);
  if (historyData.layerTransformSnapshot) {
    transformArtboardBounds(doc, toMatrix2D(historyData.homography));
    TransformToolBase.restoreLayerSnapshots(doc, historyData.layerTransformSnapshot.targetIndices, historyData.layerTransformSnapshot.snapshotsAfter)
  }
  resizeDocumentCanvas(doc, historyData.rectAfter)
};
CropToolBase.prototype.undo = function(historyData, doc) {
  if (historyData.dpiBefore) doc.dpi = historyData.dpiBefore;
  if (historyData.sliceSnapshots) doc.slices = JSON.parse(historyData.sliceSnapshots[0]);
  var restoredCanvasRect = historyData.rectBefore.clone();
  restoredCanvasRect.offset(-historyData.rectAfter.x, -historyData.rectAfter.y);
  resizeDocumentCanvas(doc, restoredCanvasRect);
  if (historyData.panOffsetBefore) doc.pathViewport.panOffset.copyFrom(historyData.panOffsetBefore);
  doc.invalidateAllLayers();
  if (historyData.layerTransformSnapshot) {
    var invertedHomography = toMatrix2D(historyData.homography).clone();
    invertedHomography.invert();
    transformArtboardBounds(doc, invertedHomography);
    TransformToolBase.restoreLayerSnapshots(doc, historyData.layerTransformSnapshot.targetIndices, historyData.layerTransformSnapshot.snapshotsBefore)
  }
};


CropToolBase.prototype.applyAction = function(actionPayload, dispatcher, doc, keyboard, appData) {
  if (actionPayload.subAction == "commit") {
    this.commitCrop(doc, appData);
    this.disable(doc, dispatcher, null, keyboard)
  } else if (actionPayload.subAction == "cancel") {
    this.disable(doc, dispatcher, null, keyboard)
  }
  var initialCropRect = null,
    fullCanvasRect = new Rect(0, 0, doc.width, doc.height),
    aspectController = this.cropOptions.aspectConstraint;
  if (actionPayload.subAction == "config") {
    this.cropOptions = actionPayload.cropOptions;
    aspectController = this.cropOptions.aspectConstraint;
    if (this.cropOptions.deleteCroppedPixels != null) return;
    if (doc == null) return;
    initialCropRect = fullCanvasRect;
    if (aspectController.constraintMode == 1) {
      var lockedAspectRatio = aspectController.constraintWidth / aspectController.constraintHeight;
      initialCropRect.height = Math.round(initialCropRect.width / lockedAspectRatio)
    }
    if (aspectController.constraintMode == 2) {
      initialCropRect.width = aspectController.constraintWidth;
      initialCropRect.height = aspectController.constraintHeight
    }
    initialCropRect.x = Math.round((doc.width - initialCropRect.width) / 2);
    initialCropRect.y = Math.round((doc.height - initialCropRect.height) / 2)
  }
  if (actionPayload.subAction == "cropby") {
    if (doc == null) return;
    var cropSourceMode = actionPayload.cropSourceMode,
      initialCropRect;
    if (cropSourceMode == 0) initialCropRect = doc.root.getSelectionRect(doc, true);
    if (cropSourceMode == 1) {
      if (doc.selectedLayerIndices.length == 0) alert("No layer is selected.");
      else {
        var layerSection = doc.root.getSectionByIndex(doc.selectedLayerIndices[0]);
        initialCropRect = layerSection.getSelectionRect(doc, true)
      }
    }
    if (cropSourceMode == 2) {
      if (doc.selectedLayerIndices.length == 0) alert("No layer is selected.");
      else {
        initialCropRect = computeContentBoundsRgba(doc.getRasterData(), fullCanvasRect, 0);
        if (initialCropRect.isEmpty()) initialCropRect = fullCanvasRect.clone()
      }
    }
    if (cropSourceMode == 3) {
      if (doc.selectionMask != null) initialCropRect = doc.selectionMask.rect;
      else alert("There is no selection.")
    }
  }
  if (initialCropRect && initialCropRect.isEmpty()) initialCropRect = null;
  if (initialCropRect != null) {
    this.activeOp = this.createCropActionRecord(initialCropRect, aspectController.constraintMode != 0);
    this.activeOp.redrawOverlay(doc, appData);
    this.emitEvent(dispatcher, EventType.uiDispatch, {
      dispatchKind: UiCommand.forwardActiveToolGesture,
      routingChannel: this.id,
      showCropConfirm: true
    })
  }
};
CropToolBase.prototype.commitCrop = function(doc, resampleMode) {
  var cornerCoords = this.activeOp.getCornerCoords(),
    alignedBounds = pixelAlignBoundsFromCoords(cornerCoords),
    cropRect = this.cropRectFromTransformCorners(doc, cornerCoords),
    usedFixedSize = false,
    aspectController = this.cropOptions.aspectConstraint,
    deleteCroppedPixels = this.cropOptions.deleteCroppedPixels,
    fixedWidth = aspectController.constraintWidth,
    fixedHeight = aspectController.constraintHeight,
    layerTransformSnapshot;
  if (this.id == ToolId.TOOL_CROP && aspectController.constraintMode == 2 && cropRect.area() != fixedWidth * fixedHeight) {
    cropRect = new Rect(cropRect.x, cropRect.y, fixedWidth, fixedHeight);
    usedFixedSize = true
  }
  var homography = cornersToHomography(cornerCoords, cropRect);
  homography = invert(homography);
  var isAxisAligned = isAffine(homography),
    rotationAngle = Math.atan2(homography[3], homography[0]);
  if (Math.abs(rotationAngle) > 1e-9 || !isAxisAligned || usedFixedSize || deleteCroppedPixels) layerTransformSnapshot = this.applyCropTransformToDocument(doc, resampleMode, true, homography, 1, alignedBounds);
  var historyEntry = new HistoryEntry(this.name, this),
    fullCanvasRect = new Rect(0, 0, doc.width, doc.height);
  historyEntry.data = {
    rectBefore: fullCanvasRect,
    rectAfter: cropRect,
    layerTransformSnapshot: layerTransformSnapshot,
    homography: homography,
    panOffsetBefore: doc.pathViewport.panOffset.clone(),
    sliceSnapshots: CropToolBase.snapshotSlicesForHistory(doc, cropRect, fullCanvasRect, false)
  };
  doc.pushHistory(historyEntry);
  this.redo(historyEntry.data, doc);
  this.track(CropToolBase.buildCropAction([alignedBounds.x, alignedBounds.y, alignedBounds.width, alignedBounds.height]))
};
CropToolBase.prototype.cropRectFromTransformCorners = function(doc, cornerCoords) {
  var homography = cornersToHomography(cornerCoords),
    isAxisAligned = isAffine(homography),
    decomposedMatrix = toMatrix2D(homography),
    translateX = decomposedMatrix.tx,
    translateY = decomposedMatrix.ty,
    rotationAngle = Math.atan2(decomposedMatrix.b, decomposedMatrix.a);
  decomposedMatrix.rotate(rotationAngle);
  var cropRect = new Rect(translateX, translateY, decomposedMatrix.a, decomposedMatrix.d);
  if (!isAxisAligned) {
    function edgeLength(coords, fromIdx, toIdx) {
      var deltaX = coords[fromIdx] - coords[toIdx],
        deltaY = coords[fromIdx + 1] - coords[toIdx + 1];
      return Math.sqrt(deltaX * deltaX + deltaY * deltaY)
    }
    var topEdgeLength = edgeLength(cornerCoords, 0, 2),
      bottomEdgeLength = edgeLength(cornerCoords, 4, 6),
      maxHorizontalEdge = Math.max(topEdgeLength, bottomEdgeLength),
      leftEdgeLength = edgeLength(cornerCoords, 2, 4),
      rightEdgeLength = edgeLength(cornerCoords, 6, 0),
      maxVerticalEdge = Math.max(leftEdgeLength, rightEdgeLength),
      quadAspectRatio = CropToolBase.aspectRatioFromQuadCorners(cornerCoords, doc.width / 2, doc.height / 2),
      cropWidth,
      cropHeight;
    if (isNaN(quadAspectRatio) || quadAspectRatio == Infinity || quadAspectRatio == -Infinity || Math.min(quadAspectRatio, 1 / quadAspectRatio) < .1) quadAspectRatio = (topEdgeLength + bottomEdgeLength) / (leftEdgeLength + rightEdgeLength);
    if (maxHorizontalEdge / maxVerticalEdge > quadAspectRatio) {
      cropWidth = maxHorizontalEdge * 1;
      cropHeight = cropWidth / quadAspectRatio
    } else {
      cropHeight = maxVerticalEdge * 1;
      cropWidth = cropHeight * quadAspectRatio
    }
    cropRect.width = cropWidth;
    cropRect.height = cropHeight
  }
  cropRect.x = Math.round(cropRect.x);
  cropRect.y = Math.round(cropRect.y);
  cropRect.width = Math.round(cropRect.width);
  cropRect.height = Math.round(cropRect.height);
  return cropRect
};
CropToolBase.aspectRatioFromQuadCorners = function(cornerCoords, centerX, centerY) {
  var topLeftX = cornerCoords[0] - centerX,
    topLeftY = cornerCoords[1] - centerY,
    topRightX = cornerCoords[2] - centerX,
    topRightY = cornerCoords[3] - centerY,
    bottomLeftX = cornerCoords[6] - centerX,
    bottomLeftY = cornerCoords[7] - centerY,
    bottomRightX = cornerCoords[4] - centerX,
    bottomRightY = cornerCoords[5] - centerY,
    vanishU = ((topLeftY - bottomRightY) * bottomLeftX - (topLeftX - bottomRightX) * bottomLeftY + topLeftX * bottomRightY - topLeftY * bottomRightX) / ((topRightY - bottomRightY) * bottomLeftX - (topRightX - bottomRightX) * bottomLeftY + topRightX * bottomRightY - topRightY * bottomRightX),
    vanishV = ((topLeftY - bottomRightY) * topRightX - (topLeftX - bottomRightX) * topRightY + topLeftX * bottomRightY - topLeftY * bottomRightX) / ((bottomLeftY - bottomRightY) * topRightX - (bottomLeftX - bottomRightX) * topRightY + bottomLeftX * bottomRightY - bottomLeftY * bottomRightX),
    focalScale = -((vanishV * bottomLeftY - topLeftY) * (vanishU * topRightY - topLeftY) + (vanishV * bottomLeftX - topLeftX) * (vanishU * topRightX - topLeftX)) / ((vanishV - 1) * (vanishU - 1));

  function square(value) {
    return value * value
  }
  var aspectRatio = Math.sqrt((square(vanishU - 1) + square(vanishU * topRightY - topLeftY) / focalScale + square(vanishU * topRightX - topLeftX) / focalScale) / (square(vanishV - 1) + square(vanishV * bottomLeftY - topLeftY) / focalScale + square(vanishV * bottomLeftX - topLeftX) / focalScale));
  if (vanishU == 1 && vanishV == 1) aspectRatio = Math.sqrt((square(topRightY - topLeftY) + square(topRightX - topLeftX)) / (square(bottomLeftY - topLeftY) + square(bottomLeftX - topLeftX)));
  return aspectRatio
};
CropToolBase.prototype.disable = function(doc, dispatcher, appData, keyboard) {
  if (doc == null) return;
  if (this.activeOp) this.activeOp.clear(doc);
  this.activeOp = null;
  this.emitEvent(dispatcher, EventType.uiDispatch, {
    dispatchKind: UiCommand.forwardActiveToolGesture,
    routingChannel: this.id,
    showCropConfirm: false
  })
};
CropToolBase.prototype.emitEvent = function(dispatcher, eventType, eventData, routingChannel) {
  var appEvent = new AppEvent(eventType, true);
  appEvent.data = eventData;
  if (routingChannel) appEvent.routingChannel = routingChannel;
  dispatcher.dispatch(appEvent)
};

export function CropTool() {
  CropToolBase.call(this, "tools.cropTool", ToolId.TOOL_CROP, "tools/rcrop");
}

export function PerspectiveCropTool() {
  CropToolBase.call(this, "tools.perspectiveCrop", ToolId.TOOL_PERSPECTIVE_CROP, "tools/pcrop");
}

// Chain each tool's prototype onto the base it extends. The bases are
// imported, so they are fully built by the time this runs.
// Chain ToolBase as the parent without discarding the methods already defined
// on CropToolBase.prototype above; replacing the prototype here would wipe them.
Object.setPrototypeOf(CropToolBase.prototype, ToolBase.prototype);
CropTool.prototype = Object.create(CropToolBase.prototype);
PerspectiveCropTool.prototype = Object.create(CropToolBase.prototype);

