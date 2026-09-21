/**
 * On-canvas overlay drawing for the plugin tool view: mask tint/edge overlays,
 * vector path handles, artboard labels, measure-tool readouts, slices, guides,
 * document/pixel grids, tool markers (pins, points), and rulers. These methods
 * are attached onto PluginToolPanel.prototype and drawn on top of the
 * composited image; each returns whether it drew anything so the caller can
 * decide if the overlay canvas needs to be kept.
 */

import { Point } from "../../core/math/point.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";

import { ThemeConfig } from "../config/theme-config.js";
import { PanelWrapper } from "../widgets/controls/panel-widgets.js";
import { getDevicePixelRatio } from "../../core/dom.js";
import { SliceTool } from "../../document/transform/slice-tools.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { renderMaskBoundaryOverlay, renderMaskFillOverlay, resampleUint8WithMatrix } from "../../engine/compositing/pixel-ops.js";
import { appendPath, clonePath, flattenPathRecordsToPath, rectToPathOutline, toTyprPath, transformCoordPairs } from "../../engine/compositing/anti-alias.js";
import { pointOnPathAtParam } from "../../engine/compositing/selection-utils.js";
import { docUnitsToPixels, drawRulersOnView, formatDocLength, rulerThicknessPx, subtractRects } from "../../engine/compositing/geometry.js";

/** Half-extent of the rectangle that stands in for "everywhere", in document units. */
const FULL_PLANE_EXTENT_PX = 1e5;

/** How far the area a tool will discard is darkened. */
const DISCARD_SHADE_ALPHA = 0.3;

/**
 * Attach overlay draw methods onto PluginToolPanel.prototype.
 * @param {Function} PluginToolPanel
 */
export function installPluginToolOverlays(PluginToolPanel) {
  PluginToolPanel.prototype.drawActiveMaskOverlays = function(pluginDocument) {
    return drawActiveMaskOverlays(this, PluginToolPanel, pluginDocument);
  };
  PluginToolPanel.prototype.drawChannelMaskOverlay = function(maskChannel, docView, noiseMode, fillValue, colorDesc) {
    drawChannelMaskOverlay(this, PluginToolPanel, maskChannel, docView, noiseMode, fillValue, colorDesc);
  };
  PluginToolPanel.prototype.drawGuideAndOverlayGraphics = function(pluginDocument, canvasCtx, docView) {
    return drawGuideAndOverlayGraphics(this, PluginToolPanel, pluginDocument, canvasCtx, docView);
  };
  PluginToolPanel.prototype.drawDocumentGrid = function(pluginDocument, canvasCtx, gridStepX, gridStepY, opacity, gridStyle) {
    drawDocumentGrid(PluginToolPanel, pluginDocument, canvasCtx, gridStepX, gridStepY, opacity, gridStyle);
  };
  PluginToolPanel.prototype.appendPathToCanvasContext = appendPathToCanvasContext;
}

function collectActiveMaskChannels(pluginDocument) {
  const activeMasks = [];
  for (let selIdx = 0; selIdx < pluginDocument.selectedLayerIndices.length; selIdx++) {
    const layerNode = pluginDocument.layers[pluginDocument.selectedLayerIndices[selIdx]];
    if (layerNode == null) continue;
    const pixelKind = layerNode.pixelContent;
    if (pixelKind != 1 && pixelKind != 3) continue;
    const maskChannel = pixelKind == 1 ? layerNode.getMask() : layerNode.getLinkedPlacedItem(pluginDocument).d;
    if (maskChannel.active) activeMasks.push(maskChannel);
  }
  for (let extraIdx = 0; extraIdx < pluginDocument.extraChannels.length; extraIdx++)
    if (pluginDocument.extraChannels[extraIdx].active) activeMasks.push(pluginDocument.extraChannels[extraIdx]);
  return activeMasks;
}

/**
 * Draw the tinted/edged overlay for every active mask channel (layer masks,
 * filter masks, extra channels) plus the selection marching-ants, and the
 * guide/path/grid overlays. A lone active mask over hidden RGB channels is
 * drawn as a solid fill (mode 2); otherwise as an edge outline (mode 1).
 */
function drawActiveMaskOverlays(panel, PluginToolPanel, pluginDocument) {
  const docView = pluginDocument.pathViewport,
    channelSum = docView.channelVisibility[0] + docView.channelVisibility[1] + docView.channelVisibility[2],
    activeMasks = collectActiveMaskChannels(pluginDocument);
  let drewOverlay = false;
  for (let maskIdx = 0; maskIdx < activeMasks.length; maskIdx++) {
    const maskChannel = activeMasks[maskIdx];
    panel.drawChannelMaskOverlay(maskChannel, docView, activeMasks.length == 1 && channelSum == 0 ? 2 : 1, maskChannel.color, maskChannel.overlayTintRgb);
    drewOverlay = true;
  }
  const appData = panel.appData;
  drewOverlay = panel.drawGuideAndOverlayGraphics(pluginDocument, panel.mainCanvasCtx, docView) || drewOverlay;
  if (pluginDocument.selectionMask && appData.extras && appData.prefs.showSelectionEdges) {
    panel.drawChannelMaskOverlay(pluginDocument.selectionMask, docView, 0, 0, null);
    drewOverlay = true;
  }
  return drewOverlay;
}

/**
 * Resample one mask channel through the view matrix and paint it as an overlay.
 * `noiseMode` 0 renders only the mask boundary (marching-ants style), non-zero
 * renders a tinted fill; the result is clipped to the document/viewport rect.
 */
function drawChannelMaskOverlay(panel, PluginToolPanel, maskChannel, docView, noiseMode, fillValue, colorDesc) {
  let clipRect, clipMatrix;
  const viewMatrix = docView.getViewMatrix(true),
    childrenBuffer = docView.viewportRect,
    docBoundsRect = new Rect(0, 0, docView.documentBounds.width, docView.documentBounds.height);
  if (docView.scratchUint8Buffer.length != childrenBuffer.area()) {
    docView.scratchUint8Buffer = allocBuffer(childrenBuffer.area());
    docView.scratchRgbaBuffer = allocBuffer(childrenBuffer.area() * 4);
  }
  docView.scratchUint8Buffer.fill(fillValue);
  docView.scratchRgbaBuffer.fill(0);
  const channelData = maskChannel.channel,
    maskRect = maskChannel.rect;
  resampleUint8WithMatrix(channelData, maskRect, viewMatrix, docView.scratchUint8Buffer, childrenBuffer);
  if (noiseMode == 0) renderMaskBoundaryOverlay(docView.scratchUint8Buffer, docView.scratchRgbaBuffer, childrenBuffer, childrenBuffer);
  else renderMaskFillOverlay(docView.scratchUint8Buffer, docView.scratchRgbaBuffer, childrenBuffer, childrenBuffer, noiseMode);
  PluginToolPanel.patchZeroBlueForWebglImageData(docView.scratchRgbaBuffer);
  const overlayImage = new ImageData(new Uint8ClampedArray(docView.scratchRgbaBuffer.buffer), childrenBuffer.width, childrenBuffer.height);
  panel.overlayCanvasCtx.putImageData(overlayImage, 0, 0);
  panel.mainCanvasCtx.save();
  if (noiseMode == 0) {
    clipRect = childrenBuffer.clone();
    clipRect.inflate(-1, -1);
    clipMatrix = new Matrix2D();
  } else {
    clipRect = new Rect(0, 0, docBoundsRect.width, docBoundsRect.height);
    clipMatrix = viewMatrix.clone();
    clipMatrix.invert();
  }
  panel.appendPathToCanvasContext(rectToPathOutline(clipRect), clipMatrix, panel.mainCanvasCtx);
  panel.mainCanvasCtx.clip();
  panel.mainCanvasCtx.drawImage(panel.overlayCanvas, 0, 0);
  panel.mainCanvasCtx.restore();
}

/**
 * Draw artboard name labels above each visible artboard.
 * @returns {boolean} whether any label was drawn
 */
function drawArtboardNameLabels(PluginToolPanel, pluginDocument, canvasCtx, docView, fontSizeDocUnits) {
  if (!pluginDocument.add.artd) return false;
  let artboardLabelGrayHex = PluginToolPanel.getCanvasBackgroundRgba(pluginDocument)[0];
  artboardLabelGrayHex = artboardLabelGrayHex < .5 ? artboardLabelGrayHex + .5 : artboardLabelGrayHex - .5;
  artboardLabelGrayHex = "" + Math.round(artboardLabelGrayHex * 255).toString(16);
  while (artboardLabelGrayHex.length < 2) artboardLabelGrayHex = "0" + artboardLabelGrayHex;
  canvasCtx.fillStyle = "#" + artboardLabelGrayHex + artboardLabelGrayHex + artboardLabelGrayHex;
  canvasCtx.font = fontSizeDocUnits + "px sans-serif";
  let drewOverlay = false;
  for (let layerIdx = 0; layerIdx < pluginDocument.layers.length; layerIdx++) {
    const layerNode = pluginDocument.layers[layerIdx];
    if (layerNode.add.artb == null || !layerNode.isVisible()) continue;
    const artboardRect = layerNode.getArtboardRect();
    canvasCtx.fillText(layerNode.getName(), artboardRect.x, artboardRect.y - 6 / docView.zoomScale);
    drewOverlay = true;
  }
  return drewOverlay;
}

/**
 * Stroke document paths and selected knot / text-on-path handles.
 * @returns {boolean}
 */
function drawVectorPathOverlays(panel, PluginToolPanel, pluginDocument, canvasCtx, docView, pathStrokeCss, whiteFillCss) {
  let drewOverlay = false;
  canvasCtx.fillStyle = canvasCtx.strokeStyle = pathStrokeCss;
  canvasCtx.lineWidth = 1.5 / docView.zoomScale;
  const pathLists = pluginDocument.getPaths(),
    pathLayers = pathLists[0],
    pathIndices = pathLists[1];
  for (let pathListIdx = 0; pathListIdx < pathIndices.length; pathListIdx++) {
    const pathLayer = pathLayers[pathIndices[pathListIdx]],
      vectorMask = pathLayer.add.vmsk,
      pathRecords = vectorMask.pathRecords,
      flattenedPath = flattenPathRecordsToPath(pathRecords);
    panel.appendPathToCanvasContext(flattenedPath, null, canvasCtx);
    canvasCtx.stroke();
    drewOverlay = true;
    const handleRadius = 3 * getDevicePixelRatio() / docView.zoomScale,
      lastRecordIndex = pathRecords.length - 3;
    for (let loopIdx = 0; loopIdx < vectorMask.textOnPathParams.length; loopIdx++) {
      const pathPoint = pointOnPathAtParam(pathRecords, vectorMask.textOnPathParams[loopIdx]);
      if (pathPoint == null) continue;
      const pointX = pathPoint.x,
        pointY = pathPoint.y;
      canvasCtx.beginPath();
      let drawAsCornerCross = loopIdx == 0;
      if (vectorMask.reversed) drawAsCornerCross = !drawAsCornerCross;
      if (drawAsCornerCross) {
        canvasCtx.moveTo(pointX - handleRadius, pointY - handleRadius);
        canvasCtx.lineTo(pointX + handleRadius, pointY + handleRadius);
        canvasCtx.moveTo(pointX - handleRadius, pointY + handleRadius);
        canvasCtx.lineTo(pointX + handleRadius, pointY - handleRadius);
        canvasCtx.stroke();
      } else {
        canvasCtx.arc(pointX, pointY, handleRadius * 1, 0, 2 * Math.PI);
        canvasCtx.fill();
      }
      drewOverlay = true;
    }
    if (pluginDocument.selectedLayerIndices.length != 1) continue;
    let subpathIndex = -1;
    for (let recordIdx = 0; recordIdx < pathRecords.length; recordIdx++) {
      if (pathRecords[recordIdx].type > 5) continue;
      if (pathRecords[recordIdx].type == 0 || pathRecords[recordIdx].type == 3) {
        if (pathRecords[recordIdx].fillRule != -1) subpathIndex++;
        continue;
      }
      if (vectorMask.C.indexOf(subpathIndex) != -1) {
        const selectedAnchorX = pathRecords[recordIdx].anchor.x,
          selectedAnchorY = pathRecords[recordIdx].anchor.y;
        canvasCtx.fillRect(selectedAnchorX - handleRadius * .8, selectedAnchorY - handleRadius * .8, 2 * handleRadius * .8, 2 * handleRadius * .8);
      }
      if (vectorMask.selectedComponents.indexOf(recordIdx) != -1) {
        const handlePoints = [pathRecords[recordIdx].anchor];
        canvasCtx.beginPath();
        canvasCtx.moveTo(pathRecords[recordIdx].cp1.x, pathRecords[recordIdx].cp1.y);
        canvasCtx.lineTo(pathRecords[recordIdx].anchor.x, pathRecords[recordIdx].anchor.y);
        canvasCtx.lineTo(pathRecords[recordIdx].anchorOut.x, pathRecords[recordIdx].anchorOut.y);
        canvasCtx.stroke();
        if (!pathRecords[recordIdx].anchor.equals(pathRecords[recordIdx].cp1)) handlePoints.push(pathRecords[recordIdx].cp1);
        if (!pathRecords[recordIdx].anchor.equals(pathRecords[recordIdx].anchorOut)) handlePoints.push(pathRecords[recordIdx].anchorOut);
        for (let handleIdx = 0; handleIdx < handlePoints.length; handleIdx++) {
          const handlePoint = handlePoints[handleIdx],
            handleX = handlePoint.x,
            handleY = handlePoint.y;
          if (handleIdx == 0 && (pathRecords[recordIdx].type == 2 || pathRecords[recordIdx].type == 5)) canvasCtx.fillRect(handleX - 1.2 * handleRadius, handleY - 1.2 * handleRadius, 2.4 * handleRadius, 2.4 * handleRadius);
          else {
            canvasCtx.beginPath();
            canvasCtx.arc(handleX, handleY, handleRadius * 1.2, 0, 2 * Math.PI);
            canvasCtx.fill();
            if (handleIdx != 0) canvasCtx.fillStyle = whiteFillCss;
            canvasCtx.beginPath();
            canvasCtx.arc(handleX, handleY, handleRadius * .8, 0, 2 * Math.PI);
            canvasCtx.fill();
            canvasCtx.fillStyle = pathStrokeCss;
          }
        }
      }
      drewOverlay = true;
    }
  }
  return drewOverlay;
}

/**
 * Draw measure-tool highlight rects, guide segments, and length labels.
 * @returns {boolean}
 */
function drawMeasureToolOverlay(panel, PluginToolPanel, pluginDocument, canvasCtx, docView, appData, fontSizeDocUnits, halfPixelOffset) {
  const measureState = pluginDocument.toolOverlayState.measureOverlay,
    measureSegmentCoords = measureState.guideSegments,
    measurePathShape = {
      commands: [],
      coords: []
    };
  for (let rectIdx = 0; rectIdx < measureState.highlightRects.length; rectIdx++)
    appendPath(measurePathShape, rectToPathOutline(measureState.highlightRects[rectIdx]));
  measurePathShape.coords = measurePathShape.coords.concat(measureSegmentCoords);
  for (let segCmdIdx = 0; segCmdIdx < measureSegmentCoords.length; segCmdIdx += 4) {
    measurePathShape.commands.push("M", "L");
  }
  for (let coordIdx = 0; coordIdx < measurePathShape.coords.length; coordIdx++) {
    measurePathShape.coords[coordIdx] += halfPixelOffset;
  }
  canvasCtx.strokeStyle = PluginToolPanel.unitRgbaToCssString([.9, .2, .2, 1]);
  panel.appendPathToCanvasContext(measurePathShape, null, canvasCtx);
  canvasCtx.stroke();
  const devicePixelRatio = getDevicePixelRatio(),
    labelPadDoc = 2 / docView.zoomScale;
  canvasCtx.font = fontSizeDocUnits * .9 + "px sans-serif";
  for (let segIdx = 0; segIdx < measureSegmentCoords.length; segIdx += 4) {
    const pointX = measureSegmentCoords[segIdx],
      pointY = measureSegmentCoords[segIdx + 1],
      lineEndX = measureSegmentCoords[segIdx + 2],
      lineEndY = measureSegmentCoords[segIdx + 3];
    let formattedLength = Math.sqrt((lineEndY - pointY) * (lineEndY - pointY) + (lineEndX - pointX) * (lineEndX - pointX));
    formattedLength = formatDocLength(formattedLength, pluginDocument.dpi, appData, pointY == lineEndY ? pluginDocument.width : pluginDocument.height);
    const labelCenter = new Point((pointX + lineEndX) / 2, (pointY + lineEndY) / 2);
    canvasCtx.fillStyle = PluginToolPanel.unitRgbaToCssString([.9, .2, .2, 1]);
    const textWidth = canvasCtx.measureText(formattedLength).width;
    canvasCtx.fillRect(labelCenter.x - textWidth / 2 - labelPadDoc * devicePixelRatio, labelCenter.y - 3.5 * labelPadDoc * devicePixelRatio, textWidth + 2 * labelPadDoc * devicePixelRatio, 7 * labelPadDoc * devicePixelRatio);
    canvasCtx.fillStyle = PluginToolPanel.unitRgbaToCssString([1, 1, 1, 1]);
    canvasCtx.save();
    canvasCtx.translate(labelCenter.x - textWidth / 2, labelCenter.y + 2 * labelPadDoc * devicePixelRatio);
    canvasCtx.scale(.1, .1);
    canvasCtx.font = fontSizeDocUnits * 9 + "px sans-serif";
    canvasCtx.fillText(formattedLength, 0, 0);
    canvasCtx.restore();
  }
  return true;
}

/**
 * Draw slice outlines, numbers, and selected-slice handles.
 * @returns {boolean}
 */
function drawDocumentSliceOverlays(PluginToolPanel, pluginDocument, canvasCtx, fontSizeDocUnits, halfPixelOffset) {
  const slices = pluginDocument.slices;
  if (slices.length == 0) return false;
  canvasCtx.font = fontSizeDocUnits * .8 + "px sans-serif";
  const selectedSliceBoundsList = [];
  let unselectedSliceRects = [];
  for (let sliceIdx = 0; sliceIdx < slices.length; sliceIdx++) {
    const sliceBounds = SliceTool.readSliceBoundsArray(slices, sliceIdx);
    unselectedSliceRects.push(sliceBounds);
    if (pluginDocument.selectedSliceIndices.indexOf(sliceIdx) != -1) selectedSliceBoundsList.push(sliceBounds);
  }
  unselectedSliceRects.reverse();
  const sliceAnimTimestamp = Date.now();
  unselectedSliceRects = subtractRects([0, 0, pluginDocument.width, pluginDocument.height], unselectedSliceRects);
  for (let passIdx = 0; passIdx < 2; passIdx++)
    for (let loopIdx = 0; loopIdx < unselectedSliceRects.length; loopIdx++) {
      const sliceRect = unselectedSliceRects[loopIdx],
        sliceMetaIdx = sliceRect[4],
        sliceMeta = sliceMetaIdx != null ? slices[sliceMetaIdx] : null;
      if (sliceMeta && passIdx == 0 || sliceMeta == null && passIdx == 1) continue;
      const pointX = Math.round(sliceRect[0]),
        pointY = Math.round(sliceRect[1]),
        lineEndX = Math.round(sliceRect[2]),
        lineEndY = Math.round(sliceRect[3]);
      canvasCtx.strokeStyle = canvasCtx.fillStyle = PluginToolPanel.unitRgbaToCssString(sliceMeta ? [0, .7, .7, 1] : [.8, .8, .8, 1]);
      canvasCtx.strokeRect(pointX + halfPixelOffset, pointY + halfPixelOffset, lineEndX - pointX, lineEndY - pointY);
      const sliceNumber = loopIdx + 1,
        sliceLabelMetrics = canvasCtx.measureText(sliceNumber),
        textWidth = sliceLabelMetrics.width;
      canvasCtx.fillRect(pointX, pointY, textWidth + fontSizeDocUnits / 2, fontSizeDocUnits);
      canvasCtx.fillStyle = PluginToolPanel.unitRgbaToCssString([1, 1, 1, 1]);
      canvasCtx.fillText(sliceNumber, pointX + fontSizeDocUnits / 4, pointY + fontSizeDocUnits * .8);
    }
  const labelPadDoc = 2 / pluginDocument.pathViewport.zoomScale,
    handleSize = 2 * labelPadDoc;
  for (let selSliceIdx = 0; selSliceIdx < selectedSliceBoundsList.length; selSliceIdx++) {
    const selectedSliceRect = selectedSliceBoundsList[selSliceIdx],
      selectedSliceLeft = Math.round(selectedSliceRect[0]),
      selectedSliceTop = Math.round(selectedSliceRect[1]),
      selectedSliceRight = Math.round(selectedSliceRect[2]),
      selectedSliceBottom = Math.round(selectedSliceRect[3]);
    canvasCtx.strokeStyle = canvasCtx.fillStyle = PluginToolPanel.unitRgbaToCssString([0, .7, .7, 1]);
    canvasCtx.strokeRect(selectedSliceLeft + halfPixelOffset, selectedSliceTop + halfPixelOffset, selectedSliceRight - selectedSliceLeft, selectedSliceBottom - selectedSliceTop);
    const sliceCornerCoords = [selectedSliceLeft, selectedSliceTop, selectedSliceRight, selectedSliceTop, selectedSliceRight, selectedSliceBottom, selectedSliceLeft, selectedSliceBottom];
    for (let cornerPairIdx = 0; cornerPairIdx < sliceCornerCoords.length; cornerPairIdx += 2) {
      const guideX = sliceCornerCoords[cornerPairIdx],
        guideY = sliceCornerCoords[cornerPairIdx + 1],
        adjacentX = sliceCornerCoords[cornerPairIdx + 2 & 7],
        adjacentY = sliceCornerCoords[cornerPairIdx + 3 & 7];
      canvasCtx.fillRect(guideX - labelPadDoc, guideY - labelPadDoc, handleSize, handleSize);
      canvasCtx.fillRect(Math.round((guideX + adjacentX) / 2) - labelPadDoc, Math.round((guideY + adjacentY) / 2) - labelPadDoc, handleSize, handleSize);
    }
  }
  return true;
}

/**
 * Rasterize horizontal and vertical rulers and the zoom bar into the overlay canvas.
 */
function drawViewportRulers(panel, PluginToolPanel, pluginDocument, canvasCtx, docView, appData, prefs) {
  if (pluginDocument.pathViewport.horizontalRulerImageData == null || pluginDocument.pathViewport.horizontalRulerImageData.width != pluginDocument.pathViewport.viewportRect.width || pluginDocument.pathViewport.verticalRulerImageData.height != pluginDocument.pathViewport.viewportRect.height) {
    pluginDocument.pathViewport.horizontalRulerImageData = canvasCtx.createImageData(pluginDocument.pathViewport.viewportRect.width, rulerThicknessPx());
    pluginDocument.pathViewport.verticalRulerImageData = canvasCtx.createImageData(rulerThicknessPx(), pluginDocument.pathViewport.viewportRect.height);
  }
  const themeColors = ThemeConfig.themes[appData.theme],
    rulerCenterOffsetX = docView.zoomScale * pluginDocument.width / 2,
    rulerCenterOffsetY = docView.zoomScale * pluginDocument.height / 2,
    rulerUnitFactor = [1, pluginDocument.dpi, pluginDocument.dpi / 2.54, pluginDocument.dpi / 25.4, pluginDocument.width / 100][prefs.AppWindow],
    savedZoom = docView.zoomScale,
    savedPan = docView.panOffset.clone(),
    savedOriginMode = docView.rotationRadians;
  docView.zoomScale *= rulerUnitFactor;
  docView.panOffset.x += rulerCenterOffsetX * rulerUnitFactor - rulerCenterOffsetX;
  docView.panOffset.y += rulerCenterOffsetY * rulerUnitFactor - rulerCenterOffsetY;
  docView.rotationRadians = 0;
  drawRulersOnView(docView, themeColors["--text-color"], themeColors["--bg-input"], Math.floor(panel.lastPointerState.x), Math.floor(panel.lastPointerState.y));
  docView.zoomScale = savedZoom;
  docView.panOffset = savedPan;
  docView.rotationRadians = savedOriginMode;
  const zoomBarImage = PanelWrapper.renderZoomBarImage(docView.zoomScale, PluginToolPanel.unitRgbaToCssString([1, 1, 1, 1]));
  PluginToolPanel.patchZeroBlueForWebglImageData(pluginDocument.pathViewport.verticalRulerImageData.data);
  PluginToolPanel.patchZeroBlueForWebglImageData(pluginDocument.pathViewport.horizontalRulerImageData.data);
  canvasCtx.putImageData(pluginDocument.pathViewport.verticalRulerImageData, 0, 0);
  canvasCtx.putImageData(pluginDocument.pathViewport.horizontalRulerImageData, 0, 0);
  canvasCtx.putImageData(zoomBarImage, 0, pluginDocument.pathViewport.viewportRect.height - zoomBarImage.height);
}

// Draw the small tool markers stored on toolOverlayState: square handles,
// filled circles, and puppet-warp pins (outer ring plus a colored core, blue
// when selected).
function drawToolMarkerOverlays(PluginToolPanel, pluginDocument, canvasCtx, docView) {
  let drewOverlay = false,
    handleRadius = (4 * getDevicePixelRatio() + .5) / docView.zoomScale,
    markerCoordPairs = pluginDocument.toolOverlayState.squareMarkerCoords;
  canvasCtx.beginPath();
  for (let squareIdx = 0; squareIdx < markerCoordPairs.length; squareIdx += 2) {
    drewOverlay = true;
    const squareMarkerX = markerCoordPairs[squareIdx],
      squareMarkerY = markerCoordPairs[squareIdx + 1];
    canvasCtx.rect(squareMarkerX - handleRadius, squareMarkerY - handleRadius, 2 * handleRadius, 2 * handleRadius);
  }
  canvasCtx.stroke();
  markerCoordPairs = pluginDocument.toolOverlayState.circleMarkerCoords;
  canvasCtx.beginPath();
  handleRadius = 4 * getDevicePixelRatio() / docView.zoomScale;
  for (let circleIdx = 0; circleIdx < markerCoordPairs.length; circleIdx += 2) {
    drewOverlay = true;
    const circleMarkerX = markerCoordPairs[circleIdx],
      circleMarkerY = markerCoordPairs[circleIdx + 1];
    canvasCtx.moveTo(circleMarkerX + handleRadius, circleMarkerY);
    canvasCtx.arc(circleMarkerX, circleMarkerY, handleRadius, 0, 2 * Math.PI);
  }
  canvasCtx.fill();
  markerCoordPairs = pluginDocument.toolOverlayState.pinMarkerCoords;
  canvasCtx.fillStyle = PluginToolPanel.unitRgbaToCssString([1, 1, 1, 1]);
  canvasCtx.beginPath();
  handleRadius = 6 * getDevicePixelRatio() / docView.zoomScale;
  for (let pinOuterIdx = 0; pinOuterIdx < markerCoordPairs.length; pinOuterIdx += 2) {
    drewOverlay = true;
    const pinOuterX = markerCoordPairs[pinOuterIdx],
      pinOuterY = markerCoordPairs[pinOuterIdx + 1];
    canvasCtx.moveTo(pinOuterX + handleRadius, pinOuterY);
    canvasCtx.arc(pinOuterX, pinOuterY, handleRadius, 0, 2 * Math.PI);
  }
  canvasCtx.fill();
  handleRadius = 4 * getDevicePixelRatio() / docView.zoomScale;
  for (let pinInnerIdx = 0; pinInnerIdx < markerCoordPairs.length; pinInnerIdx += 2) {
    drewOverlay = true;
    const pinInnerX = markerCoordPairs[pinInnerIdx],
      pinInnerY = markerCoordPairs[pinInnerIdx + 1];
    canvasCtx.fillStyle = PluginToolPanel.unitRgbaToCssString(pluginDocument.toolOverlayState.selectedPinIndices.indexOf(pinInnerIdx >>> 1) != -1 ? [0, .6, 1, 1] : [.7, .7, .7, 1]);
    canvasCtx.beginPath();
    canvasCtx.moveTo(pinInnerX + handleRadius, pinInnerY);
    canvasCtx.arc(pinInnerX, pinInnerY, handleRadius, 0, 2 * Math.PI);
    canvasCtx.fill();
  }
  return drewOverlay;
}

// Stroke the user's vertical and horizontal ruler guides across the document,
// extended well past the document edges so they span the whole viewport.
function drawGuideLines(PluginToolPanel, pluginDocument, canvasCtx, halfPixelOffset) {
  let guideLineExtent = Math.max(pluginDocument.pathViewport.viewportRect.width, pluginDocument.pathViewport.viewportRect.height) / pluginDocument.pathViewport.zoomScale;
  guideLineExtent = Math.max(Math.max(pluginDocument.width, pluginDocument.height) * 2, guideLineExtent);
  canvasCtx.beginPath();
  canvasCtx.strokeStyle = PluginToolPanel.unitRgbaToCssString([0, 1, 1, 1]);
  for (let verticalGuideIdx = 0; verticalGuideIdx < pluginDocument.guides[0].length; verticalGuideIdx++) {
    const guideX = Math.round(pluginDocument.guides[0][verticalGuideIdx]) + halfPixelOffset;
    canvasCtx.moveTo(guideX, -guideLineExtent);
    canvasCtx.lineTo(guideX, guideLineExtent);
  }
  for (let horizontalGuideIdx = 0; horizontalGuideIdx < pluginDocument.guides[1].length; horizontalGuideIdx++) {
    const guideY = Math.round(pluginDocument.guides[1][horizontalGuideIdx]) + halfPixelOffset;
    canvasCtx.moveTo(-guideLineExtent, guideY);
    canvasCtx.lineTo(guideLineExtent, guideY);
  }
  canvasCtx.stroke();
}

/**
 * Master overlay pass drawn in document space: artboard labels, vector path
 * handles, transform/selection outlines, brush-stamp and floating bitmap
 * previews, measure readout, grids, guides, slices, snap guides, and (in screen
 * space) the rulers. Which layers appear depends on the extras/prefs flags.
 * Returns whether anything was drawn.
 */
function drawGuideAndOverlayGraphics(panel, PluginToolPanel, pluginDocument, canvasCtx, docView) {
  let drewOverlay = pluginDocument.toolOverlayState.textSelectionPath != null || pluginDocument.toolOverlayState.overlayTransform != null || pluginDocument.toolOverlayState.snapGuides != null || pluginDocument.toolOverlayState.brushStampOverlays.length != 0 || pluginDocument.toolOverlayState.floatingBitmapOverlays.length != 0;
  const appData = panel.appData,
    prefs = appData.prefs,
    labelFontPx = Math.round(12 * getDevicePixelRatio()),
    fontSizeDocUnits = labelFontPx / pluginDocument.pathViewport.zoomScale,
    invertedViewMatrix = docView.getViewMatrix(true);
  invertedViewMatrix.invert();
  canvasCtx.save();
  canvasCtx.setTransform(invertedViewMatrix.a, invertedViewMatrix.b, invertedViewMatrix.c, invertedViewMatrix.d, invertedViewMatrix.tx, invertedViewMatrix.ty);
  if (drawArtboardNameLabels(PluginToolPanel, pluginDocument, canvasCtx, docView, fontSizeDocUnits)) drewOverlay = true;
  const pathStrokeCss = PluginToolPanel.unitRgbaToCssString([.1, .5, 1, 1]),
    whiteFillCss = PluginToolPanel.unitRgbaToCssString([1, 1, 1, 1]);
  if (appData.extras && prefs.paths) {
    if (drawVectorPathOverlays(panel, PluginToolPanel, pluginDocument, canvasCtx, docView, pathStrokeCss, whiteFillCss)) drewOverlay = true;
  }
  canvasCtx.fillStyle = canvasCtx.strokeStyle = PluginToolPanel.unitRgbaToCssString([0, 0, 0, 1], true);
  canvasCtx.lineWidth = 1 / docView.zoomScale;
  const halfPixelMatrix = new Matrix2D(1, 0, 0, 1, .5 / docView.zoomScale, .5 / docView.zoomScale);
  if (pluginDocument.toolOverlayState.textSelectionPath) {
    panel.appendPathToCanvasContext(pluginDocument.toolOverlayState.textSelectionPath, null, canvasCtx);
    canvasCtx.fill();
  }
  // Shade what the tool will discard before its outline is stroked, so the
  // outline stays crisp on top of the shading.
  if (pluginDocument.toolOverlayState.discardShadeOverlay) {
    const previousFill = canvasCtx.fillStyle;
    canvasCtx.fillStyle = PluginToolPanel.unitRgbaToCssString([0, 0, 0, DISCARD_SHADE_ALPHA]);
    panel.appendPathToCanvasContext(pluginDocument.toolOverlayState.discardShadeOverlay, null, canvasCtx, true);
    canvasCtx.fill("evenodd");
    canvasCtx.fillStyle = previousFill;
    drewOverlay = true;
  }
  if (pluginDocument.toolOverlayState.overlayTransform) {
    panel.appendPathToCanvasContext(pluginDocument.toolOverlayState.overlayTransform, halfPixelMatrix, canvasCtx);
    canvasCtx.stroke();
  }
  for (let nestedOverlayKey in pluginDocument.toolOverlayState.perToolOverlays)
    if (pluginDocument.toolOverlayState.perToolOverlays[nestedOverlayKey].overlayTransform) {
      panel.appendPathToCanvasContext(pluginDocument.toolOverlayState.perToolOverlays[nestedOverlayKey].overlayTransform, null, canvasCtx);
      canvasCtx.stroke();
      drewOverlay = true;
    }
  if (drawToolMarkerOverlays(PluginToolPanel, pluginDocument, canvasCtx, docView)) drewOverlay = true;
  if (pluginDocument.toolOverlayState.brushStampOverlays.length != 0) {
    for (let stampIdx = 0; stampIdx < pluginDocument.toolOverlayState.brushStampOverlays.length; stampIdx++) {
      const bitmapOverlayEntry = pluginDocument.toolOverlayState.brushStampOverlays[stampIdx],
        bitmapOverlayRect = bitmapOverlayEntry[1];
      canvasCtx.putImageData(new ImageData(new Uint8ClampedArray(bitmapOverlayEntry[0].buffer), bitmapOverlayRect.width, bitmapOverlayRect.height), bitmapOverlayRect.x, bitmapOverlayRect.y);
    }
  }
  const halfPixelOffset = .5 / docView.zoomScale;
  canvasCtx.lineWidth = 1 / docView.zoomScale;
  if (pluginDocument.toolOverlayState.measureOverlay) {
    drawMeasureToolOverlay(panel, PluginToolPanel, pluginDocument, canvasCtx, docView, appData, fontSizeDocUnits, halfPixelOffset);
    drewOverlay = true;
  }
  if (appData.extras) {
    if (prefs.showGrid) {
      const gridStepX = docUnitsToPixels(prefs.gridSize, pluginDocument, prefs.gridUnits);
      let gridStepY = gridStepX;
      if (prefs.gridUnits == 4) gridStepY *= pluginDocument.height / pluginDocument.width;
      panel.drawDocumentGrid(pluginDocument, canvasCtx, gridStepX, gridStepY, 1, prefs.gridType);
      drewOverlay = true;
    }
    if (prefs.showPixelGrid && pluginDocument.pathViewport.zoomScale > 7) {
      panel.drawDocumentGrid(pluginDocument, canvasCtx, 1, 1, .5, prefs.gridType);
      drewOverlay = true;
    }
    if (prefs.guides) drawGuideLines(PluginToolPanel, pluginDocument, canvasCtx, halfPixelOffset);
    if (prefs.slices && drawDocumentSliceOverlays(PluginToolPanel, pluginDocument, canvasCtx, fontSizeDocUnits, halfPixelOffset)) drewOverlay = true;
  }
  canvasCtx.strokeStyle = PluginToolPanel.unitRgbaToCssString([1, 0, 0, 1]);
  if (pluginDocument.toolOverlayState.snapGuides) {
    panel.appendPathToCanvasContext(pluginDocument.toolOverlayState.snapGuides, halfPixelMatrix, canvasCtx);
    canvasCtx.stroke();
  }
  canvasCtx.restore();
  if (appData.rulers) drawViewportRulers(panel, PluginToolPanel, pluginDocument, canvasCtx, docView, appData, prefs);
  if (pluginDocument.toolOverlayState.floatingBitmapOverlays.length != 0) {
    for (let floatIdx = 0; floatIdx < pluginDocument.toolOverlayState.floatingBitmapOverlays.length; floatIdx++) {
      const floatingEntry = pluginDocument.toolOverlayState.floatingBitmapOverlays[floatIdx],
        floatingRect = floatingEntry[1];
      canvasCtx.putImageData(new ImageData(new Uint8ClampedArray(floatingEntry[0].buffer), floatingRect.width, floatingRect.height), floatingRect.x, floatingRect.y);
    }
  }
  return drewOverlay || appData.rulers || pluginDocument.guides[0].length + pluginDocument.guides[1].length > 0;
}

/**
 * Stroke the document grid. `gridStyle` 0 is a rectangular grid; non-zero is an
 * isometric grid. The step is doubled until at least 4 device pixels apart so
 * the lines never crowd at low zoom.
 */
function drawDocumentGrid(PluginToolPanel, pluginDocument, canvasCtx, gridStepX, gridStepY, opacity, gridStyle) {
  while (gridStepX * pluginDocument.pathViewport.zoomScale < 4) {
    gridStepX *= 2;
    gridStepY *= 2;
  }
  const docWidth = pluginDocument.width,
    docHeight = pluginDocument.height,
    halfPixelOffset = .5 / pluginDocument.pathViewport.zoomScale;
  canvasCtx.strokeStyle = PluginToolPanel.unitRgbaToCssString([.5, .5, .5, opacity], true);
  canvasCtx.save();
  canvasCtx.rect(0, 0, docWidth, docHeight);
  canvasCtx.clip();
  canvasCtx.beginPath();
  for (let xPos = 0; xPos <= docWidth; xPos += gridStepX) {
    canvasCtx.moveTo(xPos + halfPixelOffset, 0);
    canvasCtx.lineTo(xPos + halfPixelOffset, docHeight);
  }
  if (gridStyle == 0) {
    for (let yPos = 0; yPos <= docHeight; yPos += gridStepY) {
      canvasCtx.moveTo(0, yPos + halfPixelOffset);
      canvasCtx.lineTo(docWidth, yPos + halfPixelOffset);
    }
  } else {
    gridStepY *= Math.sqrt(4 / 3);
    const isoSpan = gridStepY * Math.floor(docWidth / gridStepY),
      isoSlope = docWidth * (gridStepY / (2 * gridStepX));
    for (let isoGuideY = -isoSpan; isoGuideY <= docHeight + isoSpan; isoGuideY += gridStepY) {
      canvasCtx.moveTo(0, isoGuideY);
      canvasCtx.lineTo(docWidth, isoGuideY - isoSlope);
      canvasCtx.moveTo(0, isoGuideY);
      canvasCtx.lineTo(docWidth, isoGuideY + isoSlope);
    }
  }
  canvasCtx.stroke();
  canvasCtx.restore();
}

/**
 * Begin a canvas path from a document path shape, optionally transforming its
 * coordinate pairs by `transformMatrix` first, and feed it into the 2D context.
 */
/**
 * Start a path on `canvasCtx` from `pathShape`, optionally transformed.
 *
 * With `encloseInFullPlane` the path is seeded with a rectangle far larger than
 * any document, so an even-odd fill paints everything *except* `pathShape` —
 * the shape becomes a hole.
 */
function appendPathToCanvasContext(pathShape, transformMatrix, canvasCtx, encloseInFullPlane) {
  canvasCtx.beginPath();
  if (encloseInFullPlane) {
    canvasCtx.rect(-FULL_PLANE_EXTENT_PX, -FULL_PLANE_EXTENT_PX, FULL_PLANE_EXTENT_PX * 2, FULL_PLANE_EXTENT_PX * 2);
  }
  const pathClone = clonePath(pathShape);
  if (transformMatrix) transformCoordPairs(pathClone.coords, transformMatrix, pathClone.coords);
  Typr.U.pathToContext(toTyprPath(pathClone), canvasCtx);
}
