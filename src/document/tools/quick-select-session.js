/**
 * The quick-select session: one superpixel graph of the layer being selected,
 * plus the selection the user has scribbled out of it so far.
 *
 * Breaking a layer into superpixels and measuring the boundaries between them
 * is expensive, so it happens once per layer and is kept here, keyed by a
 * fingerprint of the layer's index, bounds and first pixels. Painting with the
 * quick-select brush writes foreground or background marks into
 * `brushMaskBuffer`; `recomputeQuickSelectSelection` then resolves the marks
 * the graph has not seen yet into a minimum cut around them and folds the
 * result into the selection, so a stroke keeps adding to what earlier strokes
 * already claimed rather than starting over.
 *
 * There is one session because there is one layer being quick-selected at a
 * time; `syncQuickSelectOverlay` rebuilds it when that layer changes, off the
 * main thread of the gesture and behind a banner when the layer is large.
 */

import { AppEvent, EventType, UiCommand } from "../../core/event-bus.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { buildQuickSelectColorAnalysis } from "../../engine/compositing/color-range.js";
import { copyChannel } from "../../engine/compositing/pixel-ops.js";
import {
  buildSuperpixelGraph,
  collectMarkedSegments,
  cutRegionFromSeeds,
  fitColorClusters,
  rasterizeSegmentSelection,
  refineMaskBoundary,
} from "../../engine/compositing/quick-select-graph-cut.js";

/** The live session. Its `key` is empty until a layer has been analysed. */
export const quickSelectSession = { key: "" };

/**
 * How far in from a selection rectangle's edges the foreground crosshair is
 * drawn, as a fraction of the rectangle. The object-select tool draws its
 * marquee with the same inset so what the user sees is what gets marked.
 */
export const CROSSHAIR_INSET_RATIO = 0.12;

/** Brush-mask value for an unmarked pixel: neither foreground nor background. */
const UNMARKED = 128;

/**
 * Rebuild the shared quick-select session when the target layer changes.
 * `analyseNow` runs the analysis inline, for the gesture that needs the
 * session in the same tick; otherwise it is deferred so the banner can paint.
 */
export function syncQuickSelectOverlay(doc, sessionState, dispatcher, analyseNow) {
  if (!doc || doc.selectedLayerIndices.length == 0) return;
  if (sessionState.key == getLayerFingerprint(doc)) return;
  sessionState.key = getLayerFingerprint(doc);
  const layerPixelCount = doc.layers[doc.selectedLayerIndices[0]].rect.area();
  if (layerPixelCount == 0) return;
  const loadingLabel = "Image Analysis ...";
  const showLoadingBanner = layerPixelCount > 1e6 && analyseNow != true;
  if (showLoadingBanner) {
    const loadingEvent = new AppEvent(EventType.uiDispatch, true);
    loadingEvent.data = {
      dispatchKind: UiCommand.showAnalysisLoadingBanner,
      bannerLabel: loadingLabel,
    };
    dispatcher.dispatch(loadingEvent);
  }
  const analyse = function() {
    const analysedSession = createQuickSelectSession(doc);
    for (const sessionKey in analysedSession) sessionState[sessionKey] = analysedSession[sessionKey];
    if (showLoadingBanner) {
      const hideLoadingEvent = new AppEvent(EventType.uiDispatch, true);
      hideLoadingEvent.data = {
        dispatchKind: UiCommand.hideAnalysisLoadingBanner,
        bannerLabel: loadingLabel,
      };
      dispatcher.dispatch(hideLoadingEvent);
    }
  };
  if (analyseNow) analyse();
  else setTimeout(analyse, 30);
}

export function getLayerFingerprint(doc) {
  const layerIndex = doc.selectedLayerIndices[0];
  const layer = doc.layers[layerIndex];
  const layerRect = layer.rect;
  const layerBuffer = layer.buffer;
  return [layerIndex, layerRect.x, layerRect.y, layerRect.width, layerRect.height, layerBuffer[0], layerBuffer[1], layerBuffer[2], layerBuffer[3]].join(",");
}

export function createQuickSelectSession(doc) {
  const layer = doc.layers[doc.selectedLayerIndices[0]];
  const layerRect = layer.rect;
  const rectWidth = layerRect.width;
  const rectHeight = layerRect.height;
  const pixelCount = rectWidth * rectHeight;
  const layerBuffer = layer.buffer;
  const brushMaskBuffer = allocBuffer(pixelCount);
  brushMaskBuffer.fill(UNMARKED);
  const segmentation = buildQuickSelectColorAnalysis(layerBuffer, rectWidth, rectHeight);
  const graph = buildSuperpixelGraph(layerBuffer, rectWidth, rectHeight, segmentation);
  return {
    key: getLayerFingerprint(doc),
    layerRgbaBuffer: layerBuffer,
    rect: layerRect.clone(),
    imageWidth: rectWidth,
    imageHeight: rectHeight,
    brushMaskBuffer: brushMaskBuffer,
    segmentation: segmentation,
    graph: graph,
    selectedSegments: new Uint8Array(graph.segmentCount),
    resolvedForeground: new Uint8Array(graph.segmentCount),
    resolvedBackground: new Uint8Array(graph.segmentCount),
    selectionMaskBuffer: allocBuffer(pixelCount),
    brushRadius: 0,
    baseSelectionMask: null,
    baseSelectionSegments: null,
    emittedSelection: null,
  };
}

/** Drop the scribbles and the selection, for a stroke that starts fresh. */
export function resetQuickSelectSelection(sessionState) {
  if (sessionState.graph == null) return;
  sessionState.brushMaskBuffer.fill(UNMARKED);
  sessionState.selectedSegments.fill(0);
  sessionState.resolvedForeground.fill(0);
  sessionState.resolvedBackground.fill(0);
  sessionState.selectionMaskBuffer.fill(0);
  sessionState.baseSelectionMask = null;
  sessionState.baseSelectionSegments = null;
  sessionState.emittedSelection = null;
}

/**
 * Start again from the selection the document holds now.
 *
 * The session's scribbles only describe the selection it produced itself, so
 * once the document's selection comes from somewhere else — a history step, a
 * marquee, a deselect — they describe nothing. The scribbles are dropped and
 * the selection that is there becomes the ground the next stroke adds to: it
 * is kept pixel for pixel, so a feathered or hand-drawn selection survives
 * being added to, and only what a stroke marks as background is taken back
 * out of it.
 */
export function adoptDocumentSelection(sessionState, selectionMask) {
  if (sessionState.graph == null) return;
  resetQuickSelectSelection(sessionState);
  if (selectionMask == null) return;
  const graph = sessionState.graph;
  const pixelCount = sessionState.imageWidth * sessionState.imageHeight;
  const baseMask = allocBuffer(pixelCount);
  copyChannel(selectionMask.channel, selectionMask.rect, baseMask, sessionState.rect);
  sessionState.baseSelectionMask = baseMask;
  sessionState.selectionMaskBuffer.set(baseMask);
  // Which superpixels the adopted selection covers. A background stroke over
  // one of them has to be able to cut the region it belongs to back out, so
  // they join the superpixels this session selected itself as ground a
  // subtracting cut may take.
  const coveredCounts = new Uint32Array(graph.segmentCount);
  const segmentSizes = new Uint32Array(graph.segmentCount);
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    const segId = graph.labels[pixelIdx];
    segmentSizes[segId]++;
    if (baseMask[pixelIdx] > 127) coveredCounts[segId]++;
  }
  const baseSegments = new Uint8Array(graph.segmentCount);
  for (let segId = 0; segId < graph.segmentCount; segId++) {
    if (coveredCounts[segId] * 2 > segmentSizes[segId]) baseSegments[segId] = 1;
  }
  sessionState.baseSelectionSegments = baseSegments;
}

/** True when the document's selection is no longer the one this session made. */
export function hasDocumentSelectionDiverged(sessionState, selectionMask) {
  return sessionState.graph != null && sessionState.emittedSelection !== selectionMask;
}

/**
 * Fold whatever the brush has marked since the last pass into the selection.
 *
 * Foreground marks grow a cut around themselves and are added; background
 * marks cut a region back out of what is already selected. Marks the graph has
 * already resolved are left alone, so dragging the brush back over ground it
 * has covered neither re-runs the cut nor undoes it.
 */
export function recomputeQuickSelectSelection(sessionState, options) {
  const graph = sessionState.graph;
  if (graph == null) return;
  const settings = options == null ? {} : options;
  const pixelCount = sessionState.imageWidth * sessionState.imageHeight;
  const marks = collectMarkedSegments(graph, sessionState.brushMaskBuffer, pixelCount);
  const selectedSegments = sessionState.selectedSegments;

  const freshForeground = marks.foregroundSegments.filter((segId) => sessionState.resolvedForeground[segId] == 0);
  const freshBackground = marks.backgroundSegments.filter((segId) => sessionState.resolvedBackground[segId] == 0);
  if (freshForeground.length == 0 && freshBackground.length == 0) return;

  if (freshForeground.length != 0) {
    const grown = cutRegionFromSeeds(graph, freshForeground, marks.backgroundSegments, {
      modelSegments: marks.foregroundSegments,
      brushRadius: sessionState.brushRadius,
      windowRect: settings.windowRect,
    });
    for (let segId = 0; segId < graph.segmentCount; segId++) if (grown[segId]) selectedSegments[segId] = 1;
  }
  let removedSegments = null;
  if (freshBackground.length != 0) {
    removedSegments = cutRegionFromSeeds(graph, freshBackground, marks.foregroundSegments, {
      modelSegments: marks.backgroundSegments,
      brushRadius: sessionState.brushRadius,
      candidateSegments: subtractableSegments(sessionState, selectedSegments),
      windowRect: settings.windowRect,
    });
    for (let segId = 0; segId < graph.segmentCount; segId++) if (removedSegments[segId]) selectedSegments[segId] = 0;
    for (let i = 0; i < marks.backgroundSegments.length; i++) removedSegments[marks.backgroundSegments[i]] = 1;
  }
  // What the brush was dragged over is what the user asked for, whichever way
  // the cut around it went.
  for (let i = 0; i < marks.foregroundSegments.length; i++) {
    const segId = marks.foregroundSegments[i];
    selectedSegments[segId] = 1;
    sessionState.resolvedForeground[segId] = 1;
    sessionState.resolvedBackground[segId] = 0;
  }
  for (let i = 0; i < marks.backgroundSegments.length; i++) {
    const segId = marks.backgroundSegments[i];
    selectedSegments[segId] = 0;
    sessionState.resolvedBackground[segId] = 1;
    sessionState.resolvedForeground[segId] = 0;
  }

  const selectionMaskBuffer = sessionState.selectionMaskBuffer;
  rasterizeSegmentSelection(graph.labels, selectedSegments, selectionMaskBuffer, pixelCount);
  const boundaryModels = fitBoundaryColorModels(graph, selectedSegments);
  if (boundaryModels != null) {
    refineMaskBoundary(sessionState.layerRgbaBuffer, sessionState.imageWidth, sessionState.imageHeight,
      selectionMaskBuffer, boundaryModels.foreground, boundaryModels.background);
  }
  const baseMask = sessionState.baseSelectionMask;
  if (baseMask == null) return;
  // The selection this session inherited is kept as it was, minus whatever a
  // background scribble has since cut out of it.
  if (removedSegments != null) {
    for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) if (removedSegments[graph.labels[pixelIdx]]) baseMask[pixelIdx] = 0;
  }
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    if (baseMask[pixelIdx] > selectionMaskBuffer[pixelIdx]) selectionMaskBuffer[pixelIdx] = baseMask[pixelIdx];
  }
}

/**
 * Seed the quick-select session's brush mask for a scripted object selection:
 * background marks around the rectangle border, foreground crosshair at the
 * centre, then cut within the rectangle.
 */
export function seedObjectSelectionMask(shapeRect) {
  const sessionState = quickSelectSession;
  const maskRect = sessionState.rect;
  const brushMaskBuffer = sessionState.brushMaskBuffer;
  const maskWidth = maskRect.width;
  const maskHeight = maskRect.height;
  const leftEdge = shapeRect.x - maskRect.x;
  const rightEdge = leftEdge + shapeRect.width - 1;
  const centerX = Math.max(leftEdge, Math.min(rightEdge, leftEdge + rightEdge >>> 1));
  const topEdge = shapeRect.y - maskRect.y;
  const bottomEdge = topEdge + shapeRect.height - 1;
  const centerY = Math.max(topEdge, Math.min(bottomEdge, topEdge + bottomEdge >>> 1));
  const clipLeft = Math.max(leftEdge, 0);
  const clipRight = Math.min(rightEdge, maskWidth);
  const clipTop = Math.max(topEdge, 0);
  const clipBottom = Math.min(bottomEdge, maskHeight);
  resetQuickSelectSelection(sessionState);
  if (0 <= topEdge) {
    for (let x = clipLeft; x < clipRight; x++) brushMaskBuffer[topEdge * maskWidth + x] = 0;
  }
  if (bottomEdge < maskHeight) {
    for (let x = clipLeft; x < clipRight; x++) brushMaskBuffer[bottomEdge * maskWidth + x] = 0;
  }
  if (0 <= leftEdge) {
    for (let y = clipTop; y < clipBottom; y++) brushMaskBuffer[y * maskWidth + leftEdge] = 0;
  }
  if (rightEdge < maskWidth) {
    for (let y = clipTop; y < clipBottom; y++) brushMaskBuffer[y * maskWidth + rightEdge] = 0;
  }
  const crosshairHalfWidth = Math.round(shapeRect.width * CROSSHAIR_INSET_RATIO);
  const crosshairHalfHeight = Math.round(shapeRect.height * CROSSHAIR_INSET_RATIO);
  for (let x = Math.max(0, centerX - crosshairHalfWidth); x < Math.min(maskWidth, centerX + crosshairHalfWidth); x++) brushMaskBuffer[centerY * maskWidth + x] = 255;
  for (let y = Math.max(0, centerY - crosshairHalfHeight); y < Math.min(maskHeight, centerY + crosshairHalfHeight); y++) brushMaskBuffer[y * maskWidth + centerX] = 255;
  recomputeQuickSelectSelection(sessionState, { windowRect: shapeRect });
  return {
    channel: sessionState.selectionMaskBuffer.slice(0),
    rect: maskRect.clone(),
  };
}

/**
 * The superpixels a background stroke is allowed to cut out: the ones this
 * session selected, plus the ones the selection it adopted covers.
 */
function subtractableSegments(sessionState, selectedSegments) {
  const baseSegments = sessionState.baseSelectionSegments;
  if (baseSegments == null) return selectedSegments.slice(0);
  const subtractable = selectedSegments.slice(0);
  for (let segId = 0; segId < subtractable.length; segId++) if (baseSegments[segId]) subtractable[segId] = 1;
  return subtractable;
}

/**
 * Colour models for pulling the mask boundary off the superpixel grid: the
 * selected superpixels on one side, and the unselected superpixels that touch
 * them on the other. Null when the selection has no boundary to refine.
 */
function fitBoundaryColorModels(graph, selectedSegments) {
  const foregroundSegments = [];
  const backgroundSegments = [];
  for (let segId = 0; segId < graph.segmentCount; segId++) {
    if (selectedSegments[segId]) {
      foregroundSegments.push(segId);
      continue;
    }
    const arcEnd = graph.arcStart[segId + 1];
    for (let arc = graph.arcStart[segId]; arc < arcEnd; arc++) {
      if (selectedSegments[graph.arcSegment[arc]]) {
        backgroundSegments.push(segId);
        break;
      }
    }
  }
  if (foregroundSegments.length == 0 || backgroundSegments.length == 0) return null;
  return {
    foreground: fitColorClusters(graph, foregroundSegments, 4),
    background: fitColorClusters(graph, backgroundSegments, 4),
  };
}
