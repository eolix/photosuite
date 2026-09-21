/**
 * Bitmap-to-vector trace dialog: quantise a raster layer into colour clusters,
 * trace their contours, and replace the layer with one shape layer per path.
 */

import { Locale } from "../../core/i18n/locale.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { EventChannel } from "../../document/model/tool-base.js";
import { FilterDefs } from "../../features/filters/filter-apply.js";
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { LayerSectionType, Layer } from "../../document/model/layer.js";
import { Button } from "../widgets/form-controls.js";
import { Checkbox } from "../widgets/form-controls.js";
import { PanelWrapper } from "../widgets/controls/panel-widgets.js";
import { RangeInput } from "../widgets/controls/number-inputs.js";
import { BaseDialog } from "./base-dialog.js";
import { VectorMask } from "../../document/model/layer-masks.js";
import { EventType } from "../../core/event-bus.js";
import { makeElement, resizeCanvasForDevicePixelRatio } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { copyChannel, patternFromImageData } from "../../engine/compositing/pixel-ops.js";
import { appendPath, buildCanvasPathRecords, canonicalPath, toTyprPath, transformCoordPairs } from "../../engine/compositing/anti-alias.js";
import { drawCheckerboard } from "../../engine/compositing/color-math.js";
import { toRGBDesc } from "../../engine/compositing/psd-color-utils.js";
import { buildQuantizedSegmentLabels, buildQuickSelectColorAnalysis, enumerateSolidColorTiles } from "../../engine/compositing/color-range.js";
import { selectWeightedMean } from "../../engine/compositing/spatial-filters.js";
import { getPathRecords, traceContours } from "../../engine/compositing/bitmap-contour-tracer.js";

/** Gap between the two preview panes, and above them. Mirrors `.previewpair`. */
const PREVIEW_ROW_GAP_PX = 12;
/** Floor for a preview pane, so a short viewport still shows something. */
const MIN_PREVIEW_SIZE_PX = 120;
/** Toolbar height before the strip has been laid out. */
const TOOLBAR_FALLBACK_HEIGHT_PX = 34;

/** A computed-style length in pixels; 0 before the element has been laid out. */
function cssPixels(styleValue) {
  const parsed = parseFloat(styleValue);
  return isFinite(parsed) ? parsed : 0;
}

function VectorizeBitmapDialog() {
  BaseDialog.call(this, "dialogs.vectorizeBitmap", "vbitmap");
  this.activePath = null;
  this.preprocessedRasterCache = null;
  this.paletteClusterArtifacts = null;
  this.flattenedBezierPathsOutput = null;
  this.boundRedrawLater = this.redraw.bind(this);
  this.formDiv = makeElement("div", "form hbar");
  this.body.appendChild(this.formDiv);
  this.colorClustersRangeInput = new RangeInput("properties.colours", 2, 50, null);
  this.colorClustersRangeInput.on(EventType.widgetSelect, this.redraw, this);
  this.formDiv.appendChild(this.colorClustersRangeInput.el);
  this.preprocessFingerprintTag = "";
  this.reduceNoiseBeforeTraceCheckbox = new Checkbox("properties.reduceNoise");
  this.reduceNoiseBeforeTraceCheckbox.on(EventType.widgetSelect, this.redraw, this);
  this.formDiv.appendChild(this.reduceNoiseBeforeTraceCheckbox.el);
  this.segmentRegionsBeforeTraceCheckbox = new Checkbox("properties.segmentize");
  this.segmentRegionsBeforeTraceCheckbox.on(EventType.widgetSelect, this.redraw, this);
  this.formDiv.appendChild(this.segmentRegionsBeforeTraceCheckbox.el);
  this.confirmTraceExportButton = new Button("clipboard.ok", false, null, true);
  this.confirmTraceExportButton.on("click", this.onOK, this);
  const confirmGroupEl = makeElement("span", "form");
  confirmGroupEl.appendChild(this.confirmTraceExportButton.el);
  this.formDiv.appendChild(confirmGroupEl);
  const previewLayoutFlexRow = makeElement("div", "flexrow previewpair"),
    checkerboardTileSizePx = 16;
  this.body.appendChild(previewLayoutFlexRow);
  this.rasterPanZoomPanel = new PanelWrapper();
  this.rasterPanZoomPanel.on("viewchange", this.repaintVectorPreviewCanvas, this);
  this.vectorPreviewCanvas = makeElement("canvas");
  this.vectorPreviewCanvas.setAttribute("style", "margin-left: 1px; cursor:grab;");
  this.vectorPreviewCanvasContext = this.vectorPreviewCanvas.getContext("2d");
  const checkerboardPixelBuffer = allocBuffer(16 * 16 * 4);
  drawCheckerboard(checkerboardPixelBuffer, checkerboardTileSizePx, checkerboardTileSizePx, 8);
  this.checkerboardFillPattern = patternFromImageData(checkerboardPixelBuffer, checkerboardTileSizePx, checkerboardTileSizePx);
  this.rasterPanZoomPanel.attachPointerHandlers(this.vectorPreviewCanvas);
  previewLayoutFlexRow.appendChild(this.rasterPanZoomPanel.el);
  previewLayoutFlexRow.appendChild(this.vectorPreviewCanvas)
}
VectorizeBitmapDialog.prototype = Object.create(BaseDialog.prototype);
VectorizeBitmapDialog.prototype.constructor = VectorizeBitmapDialog;
VectorizeBitmapDialog.prototype.getOffset = function() {
  return new Point(0, 0);
};
VectorizeBitmapDialog.prototype.isActive = function() {
  return true
};
/**
 * The source and traced previews share whatever the toolbar leaves. Both the
 * toolbar height and the body's padding are measured rather than assumed, so
 * the dialog keeps fitting the viewport when either changes.
 */
VectorizeBitmapDialog.prototype.resize = function(dialogWidth, dialogHeight) {
  const bodyStyle = getComputedStyle(this.body);
  const windowStyle = getComputedStyle(this.el);
  const chromeV = cssPixels(bodyStyle.paddingTop) + cssPixels(bodyStyle.paddingBottom)
    + cssPixels(windowStyle.borderTopWidth) + cssPixels(windowStyle.borderBottomWidth);
  const chromeH = cssPixels(bodyStyle.paddingLeft) + cssPixels(bodyStyle.paddingRight)
    + cssPixels(windowStyle.borderLeftWidth) + cssPixels(windowStyle.borderRightWidth);
  const toolbarHeight = this.formDiv.offsetHeight || TOOLBAR_FALLBACK_HEIGHT_PX;
  const previewHeight = Math.max(
    MIN_PREVIEW_SIZE_PX,
    Math.floor(dialogHeight - chromeV - toolbarHeight - PREVIEW_ROW_GAP_PX)
  );
  const previewWidth = Math.max(
    MIN_PREVIEW_SIZE_PX,
    Math.floor((dialogWidth - chromeH - PREVIEW_ROW_GAP_PX) / 2)
  );
  resizeCanvasForDevicePixelRatio(this.vectorPreviewCanvas, previewWidth, previewHeight);
  this.rasterPanZoomPanel.resize(previewWidth, previewHeight)
};
VectorizeBitmapDialog.prototype.onKeyEvent = function(doc, view, appData, keyboard) {
  this.rasterPanZoomPanel.onKeyEvent(keyboard)
};
VectorizeBitmapDialog.prototype.buildUI = function() {
  BaseDialog.prototype.buildUI.call(this);
  this.colorClustersRangeInput.buildUI();
  this.reduceNoiseBeforeTraceCheckbox.buildUI();
  this.segmentRegionsBeforeTraceCheckbox.buildUI();
  this.confirmTraceExportButton.buildUI()
};
VectorizeBitmapDialog.prototype.open = function(currentDoc, dialogPayload) {
  this.documentHostingVectorizedLayer = currentDoc;
  const sourceLayer = currentDoc.layers[currentDoc.selectedLayerIndices[0]],
    solidTileCount = enumerateSolidColorTiles(sourceLayer.buffer.buffer, sourceLayer.rect.width, sourceLayer.rect.height).solidTileCount,
    solidTileRatio = solidTileCount / ((sourceLayer.rect.width - 2) * (sourceLayer.rect.height - 2));
  this.reduceNoiseBeforeTraceCheckbox.setValue(solidTileRatio < .75);
  this.segmentRegionsBeforeTraceCheckbox.setValue(false);
  const normalizedLayerRect = sourceLayer.rect.clone();
  normalizedLayerRect.x = normalizedLayerRect.y = 0;
  this.activePath = {
    rect: normalizedLayerRect,
    data: sourceLayer.buffer.buffer.slice(0)
  };
  this.preprocessedRasterCache = null;
  this.rasterPanZoomPanel.setValue([this.activePath]);
  this.colorClustersRangeInput.setValue(20);
  setTimeout(this.boundRedrawLater, 20)
};
VectorizeBitmapDialog.prototype.redraw = function() {
  let rasterPath = this.activePath;
  const reduceNoiseEnabled = this.reduceNoiseBeforeTraceCheckbox.getValue(),
    segmentizeEnabled = this.segmentRegionsBeforeTraceCheckbox.getValue(),
    needsPreprocess = reduceNoiseEnabled || segmentizeEnabled,
    preprocessFingerprint = reduceNoiseEnabled + "," + segmentizeEnabled;
  if (needsPreprocess && (this.preprocessedRasterCache == null || this.preprocessFingerprintTag != preprocessFingerprint)) {
    this.preprocessFingerprintTag = preprocessFingerprint;
    const workingPixels = new Uint8Array(rasterPath.data.slice(0)),
      morphRadius = 15,
      gradientWeight = 35,
      rasterWidth = rasterPath.rect.width,
      rasterHeight = rasterPath.rect.height;
    if (reduceNoiseEnabled) {
      FilterDefs.applyMorphologicalGradientFill(workingPixels, workingPixels, rasterWidth, rasterHeight, morphRadius, selectWeightedMean, [gradientWeight], 2)
    }
    if (segmentizeEnabled) {
      const segmentAnalysis = buildQuickSelectColorAnalysis(workingPixels, rasterWidth, rasterHeight),
        segmentCount = segmentAnalysis.segmentCount,
        segmentAvgColors = new Uint8Array(segmentCount * 4);
      for (let loopIdx = 0; loopIdx < segmentCount; loopIdx++) {
        const colorOffset = loopIdx * 4,
          accumOffset = loopIdx * 6,
          invPixelCount = 1 / segmentAnalysis.segmentAccumulators[accumOffset + 5];
        segmentAvgColors[colorOffset] = segmentAnalysis.segmentAccumulators[accumOffset] * invPixelCount;
        segmentAvgColors[colorOffset + 1] = segmentAnalysis.segmentAccumulators[accumOffset + 1] * invPixelCount;
        segmentAvgColors[colorOffset + 2] = segmentAnalysis.segmentAccumulators[accumOffset + 2] * invPixelCount
      }
      for (let loopIdx = 0; loopIdx < workingPixels.length; loopIdx += 4) {
        const segmentColorOffset = segmentAnalysis.pixelSegmentIndices[loopIdx >>> 2] * 4;
        workingPixels[loopIdx] = segmentAvgColors[segmentColorOffset];
        workingPixels[loopIdx + 1] = segmentAvgColors[segmentColorOffset + 1];
        workingPixels[loopIdx + 2] = segmentAvgColors[segmentColorOffset + 2]
      }
    }
    this.preprocessedRasterCache = {
      rect: rasterPath.rect.clone(),
      data: workingPixels.buffer
    };
  }
  if (needsPreprocess) rasterPath = this.preprocessedRasterCache;
  const workingPixels = new Uint8Array(rasterPath.data),
    rasterWidth = rasterPath.rect.width,
    rasterHeight = rasterPath.rect.height;
  for (let loopIdx = 0; loopIdx < workingPixels.length; loopIdx += 4) {
    if (workingPixels[loopIdx + 3] < 10) workingPixels[loopIdx] = workingPixels[loopIdx + 1] = workingPixels[loopIdx + 2] = workingPixels[loopIdx + 3] = 0
  }
  const quantizeResult = buildQuantizedSegmentLabels(workingPixels, rasterWidth, rasterHeight, this.colorClustersRangeInput.getValue(), needsPreprocess ? .1 : 2e-4);
  const segmentLabels = quantizeResult.pixelSegmentIndices.slice(0);
  for (let loopIdx = 0; loopIdx < segmentLabels.length; loopIdx++) segmentLabels[loopIdx]++;
  const paddedLabelGrid = new Uint8Array((rasterWidth + 2) * (rasterHeight + 2));
  copyChannel(segmentLabels, new Rect(1, 1, rasterWidth, rasterHeight), paddedLabelGrid, new Rect(0, 0, rasterWidth + 2, rasterHeight + 2));
  const minContourLength = Math.round((rasterWidth + 2) * (rasterHeight + 2) / 1e4),
    contourTree = traceContours(paddedLabelGrid, rasterWidth + 2, rasterHeight + 2, Math.min(12, minContourLength)),
    pathRecords = getPathRecords(contourTree),
    pathCoordOffsetMatrix = new Matrix2D(1, 0, 0, 1, -1, -1);
  for (let loopIdx = 0; loopIdx < pathRecords.length; loopIdx++) transformCoordPairs(pathRecords[loopIdx].path.coords, pathCoordOffsetMatrix, pathRecords[loopIdx].path.coords);
  this.flattenedBezierPathsOutput = pathRecords;
  this.paletteClusterArtifacts = quantizeResult;
  for (let loopIdx = 0; loopIdx < pathRecords.length; loopIdx++) {
    const outerPathRecord = pathRecords[loopIdx];
    for (let innerPathIdx = loopIdx + 1; innerPathIdx < pathRecords.length; innerPathIdx++) {
      const holePathRecord = pathRecords[innerPathIdx];
      if (quantizeResult.colorClusters[holePathRecord.color - 1].est.q[3] > .05 || holePathRecord.parent != loopIdx) continue;
      const holePathCanonical = canonicalPath(holePathRecord.path);
      let reversedCommands = holePathCanonical.commands.slice(1);
      reversedCommands.reverse();
      reversedCommands = ["M"].concat(reversedCommands);
      const reversedCoords = [],
        coordsLength = holePathCanonical.coords.length;
      for (let coordIdx = 0; coordIdx < coordsLength; coordIdx += 2) {
        reversedCoords[coordIdx] = holePathCanonical.coords[coordsLength - 2 - coordIdx];
        reversedCoords[coordIdx + 1] = holePathCanonical.coords[coordsLength - 2 - coordIdx + 1]
      }
      appendPath(outerPathRecord.path, {
        commands: reversedCommands,
        coords: reversedCoords
      })
    }
  }
  for (let loopIdx = 0; loopIdx < pathRecords.length; loopIdx++) {
    const outerPathRecord = pathRecords[loopIdx],
      clusterOpacityEst = quantizeResult.colorClusters[outerPathRecord.color - 1].est.q;
    if (clusterOpacityEst[3] <= .05) {
      pathRecords.splice(loopIdx, 1);
      loopIdx--;
      continue
    }
  }
  for (let loopIdx = 1; loopIdx < pathRecords.length; loopIdx++) {
    const prevPathRecord = pathRecords[loopIdx - 1],
      outerPathRecord = pathRecords[loopIdx];
    if (prevPathRecord.color == outerPathRecord.color) {
      appendPath(prevPathRecord.path, outerPathRecord.path);
      pathRecords.splice(loopIdx, 1);
      loopIdx--;
      continue
    }
  }
  this.repaintVectorPreviewCanvas()
};
VectorizeBitmapDialog.prototype.repaintVectorPreviewCanvas = function(viewChangeEvent) {
  if (this.flattenedBezierPathsOutput == null) return;
  const previewWidth = this.activePath.rect.width,
    previewHeight = this.activePath.rect.height,
    pathRecords = this.flattenedBezierPathsOutput,
    colorClusters = this.paletteClusterArtifacts.colorClusters,
    canvasCtx = this.vectorPreviewCanvasContext,
    viewTransform = this.rasterPanZoomPanel.getViewTransform();
  canvasCtx.setTransform(1, 0, 0, 1, 0, 0);
  canvasCtx.clearRect(0, 0, canvasCtx.canvas.width, canvasCtx.canvas.height);
  canvasCtx.translate(canvasCtx.canvas.width / 2, canvasCtx.canvas.height / 2);
  canvasCtx.scale(viewTransform.zoomScale, viewTransform.zoomScale);
  canvasCtx.translate(viewTransform.panOffset.x / viewTransform.zoomScale - previewWidth / 2, viewTransform.panOffset.y / viewTransform.zoomScale - previewHeight / 2);
  canvasCtx.scale(1 / viewTransform.zoomScale, 1 / viewTransform.zoomScale);
  canvasCtx.fillStyle = this.checkerboardFillPattern;
  canvasCtx.fillRect(0, 0, previewWidth * viewTransform.zoomScale, previewHeight * viewTransform.zoomScale);
  canvasCtx.scale(viewTransform.zoomScale, viewTransform.zoomScale);
  const fillStylesByColor = [];
  for (let clusterIdx = 0; clusterIdx < colorClusters.length; clusterIdx++) {
    const clusterEstQ = colorClusters[clusterIdx].est.q;
    fillStylesByColor.push({
      h: Math.round(255 * clusterEstQ[0]),
      l: Math.round(255 * clusterEstQ[1]),
      O: Math.round(255 * clusterEstQ[2]),
      w: Math.round(255 * clusterEstQ[3])
    })
  }
  for (let pathIdx = 0; pathIdx < pathRecords.length; pathIdx++) {
    const pathRecord = pathRecords[pathIdx],
      fillStyle = fillStylesByColor[pathRecord.color - 1];
    if (fillStyle.w == 0) continue;
    canvasCtx.fillStyle = "rgba(" + fillStyle.h + "," + fillStyle.l + "," + fillStyle.O + "," + fillStyle.w / 255 + ")";
    canvasCtx.beginPath();
    Typr.U.pathToContext(toTyprPath(pathRecord.path), canvasCtx);
    canvasCtx.fill()
  }
};
VectorizeBitmapDialog.prototype.onOK = function(clickEvent) {
  const tracedPathRecords = this.flattenedBezierPathsOutput,
    singlePathOutput = tracedPathRecords.length == 1,
    documentModel = this.documentHostingVectorizedLayer,
    sourceLayerIndex = documentModel.selectedLayerIndices[0],
    sourceLayer = documentModel.layers[sourceLayerIndex],
    newLayerStack = documentModel.layers.slice(0, sourceLayerIndex);
  if (!singlePathOutput) newLayerStack.push(documentModel.createGroupEndLayer());
  for (let pathIdx = 0; pathIdx < tracedPathRecords.length; pathIdx++) {
    const pathRecord = tracedPathRecords[pathIdx],
      clusterEstQ = this.paletteClusterArtifacts.colorClusters[pathRecord.color - 1].est.q;
    transformCoordPairs(pathRecord.path.coords, new Matrix2D(1, 0, 0, 1, sourceLayer.rect.x, sourceLayer.rect.y), pathRecord.path.coords);
    const newLayer = documentModel.newLayer();
    newLayer.setName(Locale.get(["properties.pathN", String(pathIdx)]));
    newLayerStack.push(newLayer);
    newLayer.Opct = Math.round(clusterEstQ[3] * 255);
    newLayer.layerFlags |= 16;
    newLayer.add.SoCo = {
      classID: "null",
      Clr: {
        t: "Objc",
        v: toRGBDesc({
          h: 255 * clusterEstQ[0],
          l: 255 * clusterEstQ[1],
          O: 255 * clusterEstQ[2]
        })
      }
    };
    newLayer.add.vmsk = new VectorMask();
    newLayer.add.vstk = LayerEffectDefs.getStrokeStyleDefault();
    newLayer.add.vmsk.pathRecords = buildCanvasPathRecords(pathRecord.path, false);
    newLayer.add.vogk = [];
    newLayer.updateVectorOrigins();
    newLayer.invalidate(documentModel)
  }
  let topGroupLayer = newLayerStack[newLayerStack.length - 1];
  if (!singlePathOutput) {
    const newLayer = documentModel.newLayer();
    newLayer.setName(sourceLayer.getName());
    newLayer.add.lsct = LayerSectionType.OpenGroup;
    newLayer.blendMode = "pass";
    newLayer.layerFlags = 24;
    newLayerStack.push(newLayer);
    topGroupLayer = newLayer
  }
  const sourceLayerEffects = sourceLayer.add.lmfx;
  if (sourceLayerEffects) topGroupLayer.add.lmfx = JSON.parse(JSON.stringify(sourceLayerEffects));
  for (let pathIdx = sourceLayerIndex + 1; pathIdx < documentModel.layers.length; pathIdx++) newLayerStack.push(documentModel.layers[pathIdx]);
  const layerStackEvent = new AppEvent(EventType.documentAction, true);
  layerStackEvent.fromDialog = true;
  layerStackEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
  layerStackEvent.data = {
    actionKind: Layer.replaceLayerStack,
    layersAfter: newLayerStack,
    selectedLayerIndices: [sourceLayerIndex + tracedPathRecords.length + (singlePathOutput ? -1 : 1)],
    historyLabelKey: "dialogs.vectorizeBitmap"
  };
  this.dispatch(layerStackEvent);
  this.close()
};

export { VectorizeBitmapDialog };
