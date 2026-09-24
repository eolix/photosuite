/**
 * Move tool: drag layers, selections, guides, and artboards; auto-select and
 * align/distribute helpers. History records what moved (layer stack vs selection).
 */

import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";

import { InputHandler } from "../../ui/tool-options/input-handler.js";
import { Locale } from "../../core/i18n/locale.js";
import { Layer } from "../model/layer.js"
import { Matrix2D } from "../../core/math/matrix2d.js";
import { AxisDragAnchor } from "../model/axis-drag-anchor.js";
import { FileFormatRegistry } from "../formats/registry/file-format-registry.js";
import {
  ensureFormatLoaders,
  hasFormatLoaders,
} from "../formats/registry/format-loader-imports.js";
import { HistoryEntry } from "../model/document.js";
import { PopupTypes } from "../../ui/config/popup-types.js";
import { AdjustmentEngine } from "../../features/adjustments/adjustment-engine.js";
import { adjustmentKeyOf } from "../formats/psd/adjustment-parsers.js";
import { ActionDescUtil } from "../../features/scripting/action-desc.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { getDevicePixelRatio } from "../../core/dom.js";
import { showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";
import { packDoublesList, unpackDoublesList } from "../formats/psd/descriptor-codec.js";
import { EventChannel, ToolBase, ToolId } from "../model/tool-base.js";
import { TransformToolBase } from "../transform/transform-static.js";
import { TransformBox } from "../transform/transform-box.js";
import { CropToolBase } from "./crop-tools.js";
import { SliceTool } from "../transform/slice-tools.js";
import { TextTool } from "./text-tools.js";
import { snapPointToGuides, snapRectCornersToGuides, updateLayerDragPositions } from "../model/guide-snapping.js";
import { applyLayerTranslations, offsetSelectionRect, repeatOffsetForLayers, resizeDocumentCanvas, transformArtboardBounds, translateLayersByDelta } from "../model/layer-translate.js";
import { allocBuffer, extractChannelByte } from "../../engine/compositing/buffer-utils.js";
import { computeContentBoundsRgba } from "../../engine/compositing/pixel-ops.js";
import { pixelAlignBoundsFromCoords, pixelAlignRect, rectToPathOutline } from "../../engine/compositing/anti-alias.js";
import { matrix2DToHomography } from "../../engine/compositing/homography.js";
import { UNIT_NAMES, formatDocLength, rulerThicknessPx } from "../../engine/compositing/geometry.js";

// What the MoveTool is dragging, and which move a history entry records.
// dragTargetKind uses all of these; a move history entry's actionKind reuses the
// same codes (MARQUEE_SELECT records no history - it only re-picks the selection).
const MOVE_TARGET = {
  LAYER: 0,
  SELECTION: 1,
  GUIDE: 2,
  MARQUEE_SELECT: 3,
  CHANNEL: 4,
};

/** History labels per align mode index (0-7); indices 3 and 7 both distribute. */
const ALIGN_HISTORY_LABELS = [
  "align.options.alignLeftEdges",
  "align.options.centreHorizontally",
  "align.options.alignRightEdges",
  "align.options.equalGaps",
  "align.options.alignTopEdges",
  "align.options.centreVertically",
  "align.options.alignBottomEdges",
  "align.options.equalGaps",
];


function createDefaultMoveToolOptions() {
  return {
    autoSelectLayers: false,
    showTransformControls: false,
    showMeasurementGuides: false,
  };
}

function buildDpiUnitPickerRows() {
  const rows = [];
  for (let unitIdx = 0; unitIdx < UNIT_NAMES.length; unitIdx++) {
    rows.push({
      name: UNIT_NAMES[unitIdx],
      resolveRowState(row, appData, unitIndex) {
        return {
          checked: appData.prefs.AppWindow == unitIndex,
        };
      },
    });
  }
  return rows;
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

export function MoveTool() {
  ToolBase.call(this, "tools.moveTool", ToolId.TOOL_MOVE, "tools/move");
  this.pointerDownScreen = new Point(0, 0);
  this.pointerDownDoc = new Point(0, 0);
  this.overlayLabelScreenPoint = null;
  this.pathKnotAtPointer = null;
  this.accumulatedDelta = new Point(0, 0);
  this.contextMenuDocument = null;
  this.appData = null;
  this.appDispatcher = null;
  this.lastClickTimeMs = 0;
  this.selectedLayers = null;
  this.layerEditFlagsBefore = [];
  this.selectionRectAtDragStart = null;
  this.isDragging = false;
  this.dragTargetKind = MOVE_TARGET.LAYER;
  this.dragMarqueeRect = null;
  this.guidesSnapshot = null;
  this.pendingHistoryEntry = null;
  this.embedInDialog = false;
  this.toolOptions = createDefaultMoveToolOptions();
  this.autoSelectSavedBeforeCtrl = false;
  this.ctrlKeyWasPressed = false;
  this.activeOp = null;
  this.layerPickerHandler = null;
  this.contextMenuLayerIndices = null;
  this.dpiUnitPicker = new InputHandler(buildDpiUnitPickerRows());
  this.dpiUnitPicker.on("select", this.openPreferencesFromPicker, this);
};

function installMoveToolPrototype() {

MoveTool.prototype.shouldFollowTabDrag = function() {
  return this.isDragging && this.dragTargetKind == MOVE_TARGET.LAYER
};
MoveTool.prototype.onTabDragStart = function(doc, dispatcher, appData, keyboard) {
  this.applyPointerDelta(doc, -this.accumulatedDelta.x, -this.accumulatedDelta.y);
  this.accumulatedDelta.setXY(0, 0);
  this.finishPointerGesture(doc, null, appData);
  this.refreshGuidesAndOverlays(doc)
};
MoveTool.prototype.getCursorStyle = function() {
  var options = this.toolOptions;
  return [options.autoSelectLayers ? 1 : 0, options.showTransformControls ? 1 : 0, options.showMeasurementGuides ? 1 : 0]
};
MoveTool.prototype.syncToolbarWidget = function(widgetState, routingHint, dispatcher) {
  var options = this.toolOptions;
  if (widgetState && widgetState[0] != null) options.autoSelectLayers = widgetState[0] == 1;
  if (widgetState && widgetState[1] != null) options.showTransformControls = widgetState[1] == 1;
  if (widgetState && widgetState[2] != null) options.showMeasurementGuides = widgetState[2] == 1;
  dispatchForwardToolGesture(dispatcher, this.id, {
    toolOptions: options,
    visibleSectionFlags: routingHint,
  });
};
MoveTool.exportDocumentLayers = function(doc, formatIds, scale, appData, layerIndices, encodeOptionsPerFormat, trimFlags) {
  if (trimFlags == null) trimFlags = [false, true];
  var fullDocRect = new Rect(0, 0, doc.width, doc.height),
    selectedIndices = doc.resolveLayerSelection(null, layerIndices, true),
    exportDoc = doc.extractLayersAsPSD(selectedIndices, trimFlags[0] ? fullDocRect : null, trimFlags[1] ? null : fullDocRect).doc;
  if (trimFlags[1]) {
    var contentBounds = computeContentBoundsRgba(exportDoc.getRasterData(), new Rect(0, 0, exportDoc.width, exportDoc.height), 2);
    resizeDocumentCanvas(exportDoc, contentBounds)
  }
  if (scale != 1) {
    var scaledBounds = new Rect(0, 0, Math.round(exportDoc.width * scale), Math.round(exportDoc.height * scale));
    resizeDocumentCanvas(exportDoc, scaledBounds);
    var allLayerIndices = [];
    for (var layerIdx = 0; layerIdx < exportDoc.layers.length; layerIdx++) allLayerIndices.push(layerIdx);
    var layerSnapshots = TransformToolBase.captureLayerSnapshots(exportDoc, allLayerIndices, true);
    transformArtboardBounds(exportDoc, new Matrix2D(scale, 0, 0, scale, 0, 0));
    TransformToolBase.applyTransformToLayers(exportDoc, appData.fontRegistry, allLayerIndices, layerSnapshots, 1, matrix2DToHomography(new Matrix2D(scale, 0, 0, scale, 0, 0)), null, true);
    exportDoc.composite()
  }
  var encodedBlobs = [];
  for (var formatIdx = 0; formatIdx < formatIds.length; formatIdx++)
    if (exportDoc.width * exportDoc.height != 0) encodedBlobs.push(FileFormatRegistry.encodeDocument(exportDoc, formatIds[formatIdx].toUpperCase(), null, null, encodeOptionsPerFormat ? encodeOptionsPerFormat[formatIdx] : null, appData));
  return encodedBlobs
};
MoveTool.prototype.exportSelectionAsFormat = function(doc, format, scale, appData, dispatcher) {
  if (doc == null || doc.selectedLayerIndices.length == 0) return;
  // The SVG writer ships in the same on-demand module as the SVG parser, so a
  // session that has never opened an SVG has nothing to export with yet.
  if (!hasFormatLoaders(format)) {
    var self = this;
    ensureFormatLoaders(format).then(function() {
      self.exportSelectionAsFormat(doc, format, scale, appData, dispatcher)
    }, function(err) {
      console.error("[export] could not load the " + format + " writer:", err);
      showToast("Could not export: " + String(format).toUpperCase() + " support failed to load.")
    });
    return
  }
  var encodedBlob = MoveTool.exportDocumentLayers(doc, [format], scale, appData, null)[0],
    downloadEvent = new AppEvent(EventType.uiDispatch, true);
  downloadEvent.data = {
    dispatchKind: UiCommand.downloadBlobSaveAs,
    data: encodedBlob,
    name: doc.layers[doc.selectedLayerIndices[0]].getName() + (scale == 1 ? "" : "@" + scale + "x") + "." + format
  };
  dispatcher.dispatch(downloadEvent)
};
MoveTool.prototype.applyAction = function(actionPayload, dispatcher, doc, keyboard, appData) {
  if (actionPayload.operation == "getPNG") {
    this.exportSelectionAsFormat(doc, "png", actionPayload.exportScaleIndex, appData, dispatcher)
  } else if (actionPayload.operation == "getSVG") {
    this.exportSelectionAsFormat(doc, "svg", actionPayload.exportScaleIndex, appData, dispatcher)
  }
  if (actionPayload.operation == "prms") {
    this.toolOptions = actionPayload;
    this.refreshGuidesAndOverlays(doc)
  }
};
MoveTool.distributeGuideSpacings = function(spanPairs) {
  var segmentCount = spanPairs.length,
    totalSpan = 0;
  spanPairs.sort(function(segmentA, segmentB) {
    return segmentA[0] + segmentA[1] / 2 - (segmentB[0] + segmentB[1] / 2)
  });
  var axisLength = spanPairs[segmentCount - 1][0] + spanPairs[segmentCount - 1][1] - spanPairs[0][0];
  for (var segmentIdx = 0; segmentIdx < segmentCount; segmentIdx++) totalSpan += spanPairs[segmentIdx][1];
  var gap = Math.round((axisLength - totalSpan) / (segmentCount - 1)),
    nextPos = spanPairs[0][0];
  for (var segmentIdx = 0; segmentIdx < segmentCount; segmentIdx++) {
    spanPairs[segmentIdx][0] = nextPos;
    nextPos += spanPairs[segmentIdx][1] + gap
  }
};
MoveTool.prototype.handleInput = function(event, dispatcher, doc, keyboard, appData) {
  var eventKind = event.actionKind;
  if (eventKind == "trsl") {
    var deltaX = Math.round(event.translateDeltaX),
      deltaY = Math.round(event.translateDeltaY);
    this.accumulatedDelta.setXY(deltaX, deltaY);
    this.beginPointerGesture(doc, dispatcher, keyboard, appData, false, event.layerIndex);
    this.applyPointerDelta(doc, deltaX, deltaY);
    this.finishPointerGesture(doc, null, appData)
  } else if (eventKind == "gids" || eventKind == "gidsFromLayer") {
    var guidesBefore = event.guidesBefore,
      guidesAfter, historyLabel;
    if (guidesBefore == null) guidesBefore = JSON.parse(JSON.stringify(doc.guides));
    if (eventKind == "gids") {
      guidesAfter = event.guidesAfter;
      var beforeGuideCount = guidesBefore[0].length + guidesBefore[1].length,
        afterGuideCount = guidesAfter[0].length + guidesAfter[1].length;
      historyLabel = beforeGuideCount == afterGuideCount ? "history.moveGuide" : beforeGuideCount > afterGuideCount ? "history.deleteGuide" : "history.addGuide";
      if (afterGuideCount == 0) historyLabel = "dialogs.clearGuides"
    } else if (eventKind == "gidsFromLayer") {
      var layerGuideCoords = [
        [],
        []
      ];
      for (var layerIdx = 0; layerIdx < doc.selectedLayerIndices.length; layerIdx++) {
        var layerRect = doc.layers[doc.selectedLayerIndices[layerIdx]].rect;
        if (layerRect.isEmpty()) continue;
        layerGuideCoords[0].push(layerRect.x, layerRect.x + layerRect.width);
        layerGuideCoords[1].push(layerRect.y, layerRect.y + layerRect.height)
      }
      historyLabel = "dialogs.guidesFromLayer";
      guidesAfter = JSON.parse(JSON.stringify(doc.guides));
      MoveTool.mergeLayerIndexLists(guidesAfter, layerGuideCoords)
    }
    if (JSON.stringify(guidesBefore) == JSON.stringify(guidesAfter)) return;
    var guideHistoryEntry = new HistoryEntry(historyLabel, this);
    guideHistoryEntry.data = {
      actionKind: MOVE_TARGET.GUIDE,
      guidesBefore: guidesBefore,
      guidesAfter: guidesAfter
    };
    doc.pushHistory(guideHistoryEntry);
    this.redo(guideHistoryEntry.data, doc)
  } else if (eventKind == "algn") {
    this.alignSelectedLayers(event.value, dispatcher, doc, keyboard, appData)
  }
};
MoveTool.prototype.alignSelectedLayers = function(alignMode, dispatcher, doc, keyboard, appData) {
  if (doc == null) return;
  if (doc.selectedLayerIndices.length < 2 && !(doc.selectionMask != null && alignMode != 3 && alignMode != 7)) {
    alert(Locale.get("brushAndMessages.toolHints.selectMultipleLayers"));
    return
  }
  var savedSelection = doc.selectionMask;
  doc.selectionMask = null;
  var alignBoundsRect = savedSelection ? savedSelection.rect : TransformToolBase.getSelectionRect(doc);
  this.beginPointerGesture(doc, dispatcher, keyboard, appData, false);
  if (!this.isDragging) return;
  var selectedLayerIndices = this.selectedLayers,
    rootGroupSlotByLayer = [],
    rootGroupIndices = [],
    rootGroupOffsets = [];
  for (var layerIdx = 0; layerIdx < selectedLayerIndices.length; layerIdx++) {
    var layerIndex = selectedLayerIndices[layerIdx];
    while (doc.layers[layerIndex].getName() == "</Layer group>") layerIndex++;
    var section = doc.root.getSectionByIndex(layerIndex),
      topSection = section;
    while (section.parent != null) {
      section = section.parent;
      if (selectedLayerIndices.indexOf(section.index) != -1) topSection = section
    }
    var rootSlotIndex = rootGroupIndices.indexOf(topSection.index);
    if (rootSlotIndex == -1) {
      rootSlotIndex = rootGroupIndices.length;
      rootGroupIndices.push(topSection.index)
    }
    rootGroupSlotByLayer[layerIdx] = rootSlotIndex
  }
  var axisSpans = [],
    distributeSpans = [],
    groupRects = [];
  for (var groupIdx = 0; groupIdx < rootGroupIndices.length; groupIdx++) {
    var groupRect = TransformToolBase.getSelectionRect(doc, doc.resolveLayerSelection(true, rootGroupIndices[groupIdx]));
    groupRects.push(groupRect);
    var spanPair = alignMode == 3 ? [groupRect.y, groupRect.height] : [groupRect.x, groupRect.width];
    axisSpans[groupIdx] = spanPair;
    distributeSpans.push(spanPair)
  }
  MoveTool.distributeGuideSpacings(distributeSpans);
  for (var groupIdx = 0; groupIdx < rootGroupIndices.length; groupIdx++) {
    var groupRect = groupRects[groupIdx],
      newX = groupRect.x,
      newY = groupRect.y;
    if (alignMode == 0) newX = alignBoundsRect.x;
    if (alignMode == 1) newX = alignBoundsRect.x + (alignBoundsRect.width - groupRect.width) / 2;
    if (alignMode == 2) newX = alignBoundsRect.x + (alignBoundsRect.width - groupRect.width);
    if (alignMode == 3) newY = axisSpans[groupIdx][0];
    if (alignMode == 4) newY = alignBoundsRect.y;
    if (alignMode == 5) newY = alignBoundsRect.y + (alignBoundsRect.height - groupRect.height) / 2;
    if (alignMode == 6) newY = alignBoundsRect.y + (alignBoundsRect.height - groupRect.height);
    if (alignMode == 7) newX = axisSpans[groupIdx][0];
    rootGroupOffsets.push(Math.round(newX - groupRect.x), Math.round(newY - groupRect.y))
  }
  var layerOffsetPairs = [];
  for (var layerIdx = 0; layerIdx < selectedLayerIndices.length; layerIdx++) {
    var rootSlot = rootGroupSlotByLayer[layerIdx];
    layerOffsetPairs[2 * layerIdx] = rootGroupOffsets[2 * rootSlot];
    layerOffsetPairs[2 * layerIdx + 1] = rootGroupOffsets[2 * rootSlot + 1]
  }
  this.applyPointerDelta(doc, 0, 0, null, layerOffsetPairs);
  this.finishPointerGesture(doc, null, appData, layerOffsetPairs, ALIGN_HISTORY_LABELS[alignMode]);
  doc.selectionMask = savedSelection
};
MoveTool.mergeLayerIndexLists = function(guideLists, coordsToMerge) {
  for (var axisIdx = 0; axisIdx < coordsToMerge.length; axisIdx++)
    for (var coordIdx = 0; coordIdx < coordsToMerge[axisIdx].length; coordIdx++)
      if (guideLists[axisIdx].indexOf(coordsToMerge[axisIdx][coordIdx]) == -1) guideLists[axisIdx].push(coordsToMerge[axisIdx][coordIdx])
};
MoveTool.prototype.enable = function(doc, dispatcher, appData, keyboard, embedInDialog) {
  this.appData = appData;
  this.appDispatcher = dispatcher;
  this.embedInDialog = embedInDialog ? true : false;
  this.refreshGuidesAndOverlays(doc);
  this.updateCursor("default", dispatcher)
};
MoveTool.prototype.disable = function(doc, dispatcher, appData, keyboard) {
  this.clearMoveOverlays(doc)
};
MoveTool.prototype.clearMoveOverlays = function(doc) {
  if (doc == null) return;
  if (this.activeOp) {
    this.activeOp.clear(doc);
    this.activeOp = null
  }
  if (doc.toolOverlayState.measureOverlay) {
    doc.toolOverlayState.measureOverlay = null;
    doc.dirty = true
  }
  if (doc.toolOverlayState.snapGuides) {
    doc.toolOverlayState.snapGuides = null;
    doc.dirty = true
  }
  if (doc.toolOverlayState.perToolOverlays[this.id]) {
    delete doc.toolOverlayState.perToolOverlays[this.id];
    doc.dirty = true
  }
  if (doc.toolOverlayState.floatingBitmapOverlays.length != 0) {
    doc.toolOverlayState.floatingBitmapOverlays = [];
    doc.dirty = true
  }
};
MoveTool.prototype.onDocumentStateChange = function(doc, dispatcher, appData, keyboard) {
  if (appData.activeToolId != this.id) return;
  this.refreshGuidesAndOverlays(doc)
};
MoveTool.prototype.refreshGuidesAndOverlays = function(doc, pointerDocPoint) {
  if (doc == null) return;
  var options = this.toolOptions;
  this.clearMoveOverlays(doc);
  if (!this.embedInDialog) {
    var selectionRect;
    if (options.showTransformControls || options.showMeasurementGuides) selectionRect = pixelAlignRect(TransformToolBase.getSelectionRect(doc));
    if (options.showTransformControls && !selectionRect.isEmpty()) {
      this.activeOp = new TransformBox([selectionRect.x, selectionRect.y, selectionRect.x + selectionRect.width, selectionRect.y, selectionRect.x + selectionRect.width, selectionRect.y + selectionRect.height, selectionRect.x, selectionRect.y + selectionRect.height], true);
      this.activeOp.redrawOverlay(doc, this.appData)
    }
    if (options.showMeasurementGuides) {
      var artboardRect = doc.getArtboardForLayer(doc.selectedLayerIndices[0]),
        hoverLayerBounds = null,
        isNestedContainment = false;
      if (artboardRect == null) artboardRect = new Rect(0, 0, doc.width, doc.height);
      doc.toolOverlayState.measureOverlay = {
        highlightRects: [selectionRect],
        guideSegments: []
      };
      var snapGuideSegments = doc.toolOverlayState.measureOverlay.guideSegments,
        selectionRight = selectionRect.x + selectionRect.width,
        selectionBottom = selectionRect.y + selectionRect.height,
        selectionCenterX = selectionRect.x + Math.floor(selectionRect.width / 2),
        selectionCenterY = selectionRect.y + Math.floor(selectionRect.height / 2);
      if (pointerDocPoint) {
        var hitNode = doc.root.hitTestPoint(new Point(Math.floor(pointerDocPoint.x), Math.floor(pointerDocPoint.y)));
        if (hitNode) {
          hoverLayerBounds = pixelAlignRect(hitNode.layer.getTransformBounds(doc));
          if (hoverLayerBounds.overlaps(selectionRect)) {
            isNestedContainment = (hoverLayerBounds.containsRect(selectionRect) || selectionRect.containsRect(hoverLayerBounds)) && !selectionRect.equals(hoverLayerBounds);
            if (!isNestedContainment) hoverLayerBounds = null
          }
        }
      }
      this.appendRectCenterGuides(selectionRect, snapGuideSegments);
      if (hoverLayerBounds != null) {
        doc.toolOverlayState.measureOverlay.highlightRects.push(hoverLayerBounds);
        var hoverRight = hoverLayerBounds.x + hoverLayerBounds.width,
          hoverBottom = hoverLayerBounds.y + hoverLayerBounds.height,
          hoverCenterX = hoverLayerBounds.x + Math.floor(hoverLayerBounds.width / 2),
          hoverCenterY = hoverLayerBounds.y + Math.floor(hoverLayerBounds.height / 2);
        if (isNestedContainment) {
          var guideCenterX = selectionCenterX,
            guideCenterY = selectionCenterY;
          if (selectionRect.containsRect(hoverLayerBounds)) {
            guideCenterX = hoverCenterX;
            guideCenterY = hoverCenterY
          }
          snapGuideSegments.push(selectionRect.x, guideCenterY, hoverLayerBounds.x, guideCenterY);
          snapGuideSegments.push(selectionRight, guideCenterY, hoverRight, guideCenterY);
          snapGuideSegments.push(guideCenterX, selectionRect.y, guideCenterX, hoverLayerBounds.y);
          snapGuideSegments.push(guideCenterX, selectionBottom, guideCenterX, hoverBottom)
        } else {
          this.appendRectCenterGuides(hoverLayerBounds, snapGuideSegments);
          var spansVertically = selectionBottom < hoverLayerBounds.y || hoverBottom < selectionRect.y,
            spansHorizontally = selectionRight < hoverLayerBounds.x || hoverRight < selectionRect.x;
          if (selectionRight < hoverLayerBounds.x) snapGuideSegments.push(selectionRight, selectionCenterY, hoverLayerBounds.x, selectionCenterY);
          if (hoverRight < selectionRect.x) snapGuideSegments.push(hoverRight, selectionCenterY, selectionRect.x, selectionCenterY);
          if (selectionBottom < hoverLayerBounds.y) snapGuideSegments.push(selectionCenterX, selectionBottom, selectionCenterX, hoverLayerBounds.y);
          if (hoverBottom < selectionRect.y) snapGuideSegments.push(selectionCenterX, hoverBottom, selectionCenterX, selectionRect.y);
          if (spansVertically && !spansHorizontally) {
            if (selectionRect.x < hoverLayerBounds.x) snapGuideSegments.push(selectionRect.x, hoverCenterY, hoverLayerBounds.x, hoverCenterY);
            if (hoverLayerBounds.x < selectionRect.x) snapGuideSegments.push(hoverLayerBounds.x, selectionCenterY, selectionRect.x, selectionCenterY)
          }
        }
      } else {
        if (selectionRect.y > artboardRect.y) snapGuideSegments.push(selectionCenterX, artboardRect.y, selectionCenterX, selectionRect.y);
        if (selectionBottom < artboardRect.y + artboardRect.height) snapGuideSegments.push(selectionCenterX, selectionBottom, selectionCenterX, artboardRect.y + artboardRect.height);
        if (selectionRect.x > artboardRect.x) snapGuideSegments.push(artboardRect.x, selectionCenterY, selectionRect.x, selectionCenterY);
        if (selectionRight < artboardRect.x + artboardRect.width) snapGuideSegments.push(selectionRight, selectionCenterY, artboardRect.x + artboardRect.width, selectionCenterY)
      }
      doc.dirty = true
    }
  }
  if (this.dragTargetKind == MOVE_TARGET.GUIDE && this.isDragging) {
    var guideHit = this.selectedLayers,
      guideAxis = guideHit[0],
      guideLabel = (guideAxis == 0 ? "X" : "Y") + ": " + formatDocLength(doc.guides[guideAxis][guideHit[1]], doc.dpi, this.appData, guideAxis == 0 ? doc.width : doc.height, true);
    ToolBase.drawToolOverlay(Math.round(this.overlayLabelScreenPoint.x) + 10, Math.round(this.overlayLabelScreenPoint.y) - 10, [guideLabel], doc);
    doc.dirty = true
  }
  if (this.dragTargetKind == MOVE_TARGET.MARQUEE_SELECT && this.isDragging) {
    var marqueeOutline = rectToPathOutline(this.dragMarqueeRect);
    doc.toolOverlayState.perToolOverlays[this.id] = {
      overlayTransform: marqueeOutline
    };
    doc.dirty = true
  }
};
MoveTool.prototype.appendRectCenterGuides = function(rect, guideSegments) {
  var rectWidth = rect.width,
    rectHeight = rect.height,
    innerGuideX = rect.x + Math.floor(rectWidth * .2),
    innerGuideY = rect.y + Math.floor(rectHeight * .2);
  guideSegments.push(innerGuideX, rect.y, innerGuideX, rect.y + rectHeight);
  guideSegments.push(rect.x, innerGuideY, rect.x + rectWidth, innerGuideY)
};
MoveTool.prototype.updateCursor = function(cursorStyle, dispatcher) {
  var cursorPayload = {
      dispatchKind: UiCommand.splashOptionsUpdate,
      cursorOverlayId: cursorStyle
    },
    cursorEvent = new AppEvent(EventType.uiDispatch, true);
  cursorEvent.data = cursorPayload;
  dispatcher.dispatch(cursorEvent)
};
MoveTool.prototype.onContextLayerPickerSelect = function(pickerHandler) {
  var selectedRow = this.layerPickerHandler.getSelectedIndices()[0],
    doc = this.contextMenuDocument,
    layerIndex = this.contextMenuLayerIndices[selectedRow];
  this.selectSingleLayer(doc, layerIndex)
};
MoveTool.prototype.openPreferencesFromPicker = function(pickerHandler) {
  var prefsCopy = JSON.parse(JSON.stringify(this.appData.prefs));
  prefsCopy.AppWindow = this.dpiUnitPicker.getSelectedIndices()[0];
  var prefsEvent = new AppEvent(EventType.uiDispatch, true);
  prefsEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.PREFERENCES,
    prefsSnapshot: prefsCopy
  };
  this.appDispatcher.dispatch(prefsEvent)
};
MoveTool.prototype.onRightMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (this.isDragging) this.onMouseUp(doc, dispatcher, appData, keyboard, pointerState);
  this.contextMenuDocument = doc;
  this.appData = appData;
  this.appDispatcher = dispatcher;
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y),
    overlayHandler;
  if (MoveTool.isPointerOnRuler(appData, pointerState, doc.pathViewport)) {
    overlayHandler = this.dpiUnitPicker
  } else {
    if (this.layerPickerHandler) this.layerPickerHandler.removeEventListener("select", this.onContextLayerPickerSelect);
    var hitLayerIndices = [];
    doc.root.hitTestPoint(docPoint, hitLayerIndices);
    if (hitLayerIndices.length == 0) return;
    var layerPickerRows = [];
    this.contextMenuLayerIndices = hitLayerIndices;
    for (var layerIdx = 0; layerIdx < hitLayerIndices.length; layerIdx++) layerPickerRows.push({
      name: doc.layers[hitLayerIndices[layerIdx]].getName()
    });
    overlayHandler = this.layerPickerHandler = new InputHandler(layerPickerRows);
    overlayHandler.on("select", this.onContextLayerPickerSelect, this)
  }
  overlayHandler.parent = dispatcher;
  overlayHandler.buildUI();
  overlayHandler.update(doc, appData);
  var overlayEvent = new AppEvent(EventType.uiDispatch, true);
  overlayEvent.data = {
    dispatchKind: UiCommand.showFloatingOverlay,
    overlayWidget: overlayHandler,
    x: pointerState.screenX + 2,
    y: pointerState.screenY + 1
  };
  dispatcher.dispatch(overlayEvent)
};
MoveTool.prototype.shouldSwitchToHandOnPointerDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  return MoveTool.isPointerOnRuler(appData, pointerState, doc.pathViewport);
};
MoveTool.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.overlayLabelScreenPoint = pointerState;
  this.pointerDownScreen.setXY(pointerState.x, pointerState.y);
  this.pointerDownDoc = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
  this.pathKnotAtPointer = new AxisDragAnchor(this.pointerDownDoc);
  this.beginPointerGesture(doc, dispatcher, keyboard, appData, true)
};
MoveTool.isPointerOnRuler = function(appData, pointerState, viewState) {
  var rulerSize = rulerThicknessPx(),
    viewHeight = viewState.viewportRect.height;
  return appData.rulers && (0 < pointerState.x && pointerState.x < rulerSize || 0 < pointerState.y && pointerState.y < rulerSize || 0 < pointerState.x && pointerState.x < 4 * rulerSize && viewHeight - rulerSize < pointerState.y && pointerState.y < viewHeight);
};
MoveTool.prototype.beginPointerGesture = function(doc, dispatcher, keyboard, appData, isPointerDown, layerIndicesOverride) {
  var guidesBeforeDrag, pointerDocPoint = this.pointerDownDoc,
    isDraggingSelection = false;
  if (isPointerDown) {
    var guidesEnabled = appData.extras && appData.prefs.guides;
    if (MoveTool.isPointerOnRuler(appData, this.pointerDownScreen, doc.pathViewport)) {
      guidesBeforeDrag = JSON.parse(JSON.stringify(doc.guides));
      if (this.pointerDownScreen.x < rulerThicknessPx()) doc.guides[0].push(pointerDocPoint.x);
      if (this.pointerDownScreen.y < rulerThicknessPx()) doc.guides[1].push(pointerDocPoint.y);
      if (!guidesEnabled) {
        var uiEvent = new AppEvent(EventType.uiDispatch);
        if (!appData.prefs.guides) {
          uiEvent.data = {
            dispatchKind: UiCommand.openResourcePresetPopup,
            popupType: PopupTypes.KEYBOARD_SHORTCUTS
          };
          dispatcher.dispatch(uiEvent)
        }
        if (!appData.extras) {
          uiEvent.data = {
            dispatchKind: UiCommand.openResourcePresetPopup,
            popupType: PopupTypes.TOGGLE_EXTRAS
          };
          dispatcher.dispatch(uiEvent)
        }
        guidesEnabled = true
      }
    }
    var guideHit = this.hitTestGuideAtPoint(doc, pointerDocPoint);
    if (guidesEnabled && guideHit) {
      this.dragTargetKind = MOVE_TARGET.GUIDE;
      this.guidesSnapshot = guidesBeforeDrag ? guidesBeforeDrag : JSON.parse(JSON.stringify(doc.guides));
      this.selectedLayers = guideHit;
      this.isDragging = true;
      this.selectionRectAtDragStart = TransformToolBase.getSelectionRect(doc);
      return
    }
    if (doc.activeChannels.length != 0) {
      this.dragTargetKind = MOVE_TARGET.CHANNEL;
      this.selectionRectAtDragStart = doc.extraChannels[doc.activeChannels[0]].rect.clone();
      this.isDragging = true;
      return
    }
    if (this.activeOp && this.activeOp.getHandleCursor(pointerDocPoint, doc.pathViewport.zoomScale, true) != null) {
      var uiEvent = new AppEvent(EventType.uiDispatch);
      uiEvent.data = {
        dispatchKind: UiCommand.setActiveToolPanelMode,
        documentModelType: ToolId.TOOL_FREE_TRANSFORM
      };
      dispatcher.dispatch(uiEvent);
      var transformEvent = new AppEvent(EventType.documentAction);
      transformEvent.routingChannel = ToolId.TOOL_FREE_TRANSFORM;
      transformEvent.data = {
        actionKind: "doMouseDown",
        pointerState: this.pointerDownScreen
      };
      dispatcher.dispatch(transformEvent);
      return
    }
    if (doc.selectionMask && doc.selectionMask.rect.containsPoint(pointerDocPoint)) {
      var sampleX = Math.round(pointerDocPoint.x),
        sampleY = Math.round(pointerDocPoint.y),
        selectionRect = doc.selectionMask.rect;
      isDraggingSelection = doc.selectionMask.channel[(sampleY - selectionRect.y) * selectionRect.width + sampleX - selectionRect.x] > 128
    }
    if (!isDraggingSelection && (!this.embedInDialog && this.toolOptions.autoSelectLayers || this.embedInDialog && this.toolOptions.autoSelectLayers && (keyboard.isPressed(KeyboardHandler.Shift) || doc.selectedLayerIndices.length < 2))) {
      var pickedLayer = this.pickLayerAtPoint(doc, pointerDocPoint, keyboard);
      if (!pickedLayer) {
        doc.selectedLayerIndices = [];
        doc.selectedLayerPaths = null;
        doc.stateChanged = doc.allowViewUpdate = true;
        this.dragTargetKind = MOVE_TARGET.MARQUEE_SELECT;
        this.dragMarqueeRect = new Rect;
        this.isDragging = true;
        return
      }
    }
    if (keyboard.isPressed(KeyboardHandler.Alt) && !isDraggingSelection) {
      var duplicateEvent = new AppEvent(EventType.documentAction);
      duplicateEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
      duplicateEvent.data = {
        actionKind: Layer.duplicateLayer,
        duplicateInPlace: true
      };
      dispatcher.dispatch(duplicateEvent)
    }
  }
  if (doc.activeChannels.length != 0) {
    this.dragTargetKind = MOVE_TARGET.CHANNEL;
    this.selectionRectAtDragStart = doc.extraChannels[doc.activeChannels[0]].rect.clone();
    this.isDragging = true;
    return
  }
  this.selectedLayers = doc.resolveLayerSelection(layerIndicesOverride == null, layerIndicesOverride, null, true);
  for (var layerIdx = 0; layerIdx < this.selectedLayers.length; layerIdx++) {
    var layer = doc.layers[this.selectedLayers[layerIdx]];
    if (layer.isLockBitSet(2) || layer.isLockBitSet(31)) {
      alert(Locale.get("layer.thisLayerIsLocked"));
      return
    }
  }
  this.layerEditFlagsBefore = MoveTool.captureLayerEditFlags(doc, this.selectedLayers);
  this.dragTargetKind = MOVE_TARGET.LAYER;
  if (doc.selectionMask && (!isPointerDown || isDraggingSelection) && doc.selectedLayerIndices.length == 1 && doc.ensureLayerEditableForTools(false)) {
    if (!doc.checkSelectionNonEmpty()) {
      this.isDragging = false;
      return
    }
    var activeLayer = doc.layers[doc.selectedLayerIndices[0]],
      isAltDuplicate = keyboard.isPressed(KeyboardHandler.Alt);
    this.dragTargetKind = MOVE_TARGET.SELECTION;
    var topHistoryEntry = doc.history[doc.historyIndex];
    if (topHistoryEntry.routingChannel == this && topHistoryEntry.data.actionKind == MOVE_TARGET.SELECTION && topHistoryEntry.data.layerIndex == doc.selectedLayerIndices[0] && activeLayer.pixelContent == activeLayer.pixCache.pixelContent && !isAltDuplicate) {
      this.pendingHistoryEntry = topHistoryEntry
    } else {
      var previousPixCache = activeLayer.pixCache,
        usedPixCacheReset = false,
        selectionChannel;
      if (!activeLayer.checkPixelCache(doc, doc.selectionMask) || isAltDuplicate) {
        usedPixCacheReset = true;
        activeLayer.updatePixCache(doc, doc.selectionMask, isAltDuplicate)
      }
      if (activeLayer.pixCache.pixelContent <= 0) {
        selectionChannel = allocBuffer(activeLayer.pixCache.selectionPixels.length >> 2);
        extractChannelByte(activeLayer.pixCache.selectionPixels, selectionChannel, 3)
      } else selectionChannel = doc.selectionMask.channel.slice(0);
      var selectionAfter = {
        rect: activeLayer.pixCache.selectionRect.clone(),
        channel: selectionChannel
      };
      this.pendingHistoryEntry = new HistoryEntry(isAltDuplicate ? "properties.duplicate" : "properties.move", this);
      this.pendingHistoryEntry.data = {
        actionKind: MOVE_TARGET.SELECTION,
        layerIndex: doc.selectedLayerIndices[0],
        pixCache: activeLayer.pixCache,
        previousPixCache: previousPixCache,
        usedPixCacheReset: usedPixCacheReset,
        selectionBefore: doc.selectionMask,
        selectionAfter: selectionAfter,
        selectionDragDelta: new Point(0, 0)
      };
      doc.pushHistory(this.pendingHistoryEntry);
      doc.selectionMask = selectionAfter;
      doc.needsComposite = true
    }
  }
  this.isDragging = true;
  this.selectionRectAtDragStart = TransformToolBase.getSelectionRect(doc)
};
MoveTool.prototype.pickLayerAtPoint = function(doc, docPoint, keyboard) {
  var hitNode = doc.root.hitTestPoint(new Point(Math.floor(docPoint.x), Math.floor(docPoint.y)));
  if (hitNode) {
    if (hitNode.layer.add.vmsk) doc.dirty = true;
    var layerIndex = doc.layers.indexOf(hitNode.layer);
    if (keyboard.isPressed(KeyboardHandler.Shift)) {
      var selectedIdx = doc.selectedLayerIndices.indexOf(layerIndex);
      if (selectedIdx == -1) doc.selectedLayerIndices.push(layerIndex);
      else if (doc.selectedLayerIndices.length > 1) doc.selectedLayerIndices.splice(selectedIdx, 1)
    } else if (doc.selectedLayerIndices.indexOf(layerIndex) == -1) {
      this.selectSingleLayer(doc, layerIndex)
    }
  }
  return hitNode != null
};
MoveTool.prototype.selectSingleLayer = function(doc, layerIndex) {
  doc.layers[layerIndex].pixelContent = 0;
  doc.selectedLayerIndices = [layerIndex];
  doc.selectedLayerPaths = null;
  doc.expandParentGroups();
  doc.needsScrollToSelected = true;
  doc.stateChanged = true
};
MoveTool.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.overlayLabelScreenPoint = pointerState;
  var docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y),
    snapDelta, snappedRect;
  if (this.pathKnotAtPointer && this.dragTargetKind < 2) docPoint = this.pathKnotAtPointer.constrainAxisDragPoint(docPoint, keyboard);
  if (!this.isDragging) {
    if (appData.extras && appData.prefs.guides) {
      var guideHit = this.hitTestGuideAtPoint(doc, docPoint),
        cursorStyle = "default";
      if (guideHit) cursorStyle = ["col-resize", "row-resize"][guideHit[0]];
      else if (this.activeOp) {
        var transformCursor = this.activeOp.getHandleCursor(docPoint, doc.pathViewport.zoomScale);
        if (transformCursor) cursorStyle = transformCursor
      }
      this.updateCursor(cursorStyle, dispatcher)
    }
    this.refreshGuidesAndOverlays(doc, docPoint);
    return
  }
  var dragOrigin = this.pointerDownDoc,
    deltaX = Math.round(docPoint.x - dragOrigin.x) - this.accumulatedDelta.x,
    deltaY = Math.round(docPoint.y - dragOrigin.y) - this.accumulatedDelta.y;
  if (this.selectionRectAtDragStart) {
    if (this.dragTargetKind == MOVE_TARGET.GUIDE) {
      docPoint = snapPointToGuides(doc, docPoint, appData, [false, doc.selectionMask ? doc.selectionMask.rect : this.selectionRectAtDragStart, true])
    } else {
      snappedRect = this.selectionRectAtDragStart.clone();
      snappedRect.offset(this.accumulatedDelta.x + deltaX, this.accumulatedDelta.y + deltaY);
      snapDelta = snapRectCornersToGuides(doc, snappedRect, appData);
      deltaX += Math.round(snapDelta[0]);
      deltaY += Math.round(snapDelta[1])
    }
  }
  this.accumulatedDelta.x += deltaX;
  this.accumulatedDelta.y += deltaY;
  this.applyPointerDelta(doc, deltaX, deltaY, docPoint, null, keyboard.isPressed(KeyboardHandler.Shift));
  this.refreshGuidesAndOverlays(doc, docPoint);
  if (snapDelta) updateLayerDragPositions(doc, snappedRect, snapDelta)
};
MoveTool.prototype.hitTestGuideAtPoint = function(doc, docPoint) {
  docPoint = [docPoint.x, docPoint.y];
  for (var axisIdx = 0; axisIdx < 2; axisIdx++)
    for (var guideIdx = 0; guideIdx < doc.guides[axisIdx].length; guideIdx++)
      if (Math.abs(doc.guides[axisIdx][guideIdx] - docPoint[axisIdx]) * doc.pathViewport.zoomScale < 4) return [axisIdx, guideIdx];
  return null
};
MoveTool.prototype.applyPointerDelta = function(doc, deltaX, deltaY, pointerDocPoint, layerOffsetPairs, snapToGrid) {
  if (this.dragTargetKind == MOVE_TARGET.LAYER) {
    if (layerOffsetPairs) applyLayerTranslations(doc, this.selectedLayers, this.layerEditFlagsBefore, layerOffsetPairs);
    else translateLayersByDelta(doc, this.selectedLayers, this.layerEditFlagsBefore, deltaX, deltaY)
  } else if (this.dragTargetKind == MOVE_TARGET.SELECTION) {
    var selectionHistory = this.pendingHistoryEntry.data;
    selectionHistory.selectionDragDelta.offset(deltaX, deltaY);
    offsetSelectionRect(doc, selectionHistory.layerIndex, deltaX, deltaY)
  } else if (this.dragTargetKind == MOVE_TARGET.GUIDE) {
    var snapStep = 1e-5;
    if (snapToGrid) snapStep = doc.pathViewport.zoomScale <= 1 ? 10 : 1;
    else if (doc.pathViewport.zoomScale <= 1) snapStep = 1;
    var snappedX = snapStep * Math.round(pointerDocPoint.x / snapStep),
      snappedY = snapStep * Math.round(pointerDocPoint.y / snapStep),
      snappedCoords = [snappedX, snappedY],
      guideHit = this.selectedLayers;
    doc.guides[guideHit[0]][guideHit[1]] = snappedCoords[guideHit[0]]
  } else if (this.dragTargetKind == MOVE_TARGET.MARQUEE_SELECT) {
    var dragStart = this.pointerDownDoc,
      marqueeRect = pixelAlignBoundsFromCoords([dragStart.x, dragStart.y, pointerDocPoint.x, pointerDocPoint.y]);
    this.dragMarqueeRect = marqueeRect;
    var hitLayerIndices = [];
    doc.root.hitTestRect(marqueeRect, hitLayerIndices);
    if (JSON.stringify(doc.selectedLayerIndices) != JSON.stringify(hitLayerIndices)) {
      doc.selectedLayerIndices = hitLayerIndices;
      doc.stateChanged = doc.allowViewUpdate = true
    }
  } else if (this.dragTargetKind == MOVE_TARGET.CHANNEL) {
    for (var channelIdx = 0; channelIdx < doc.activeChannels.length; channelIdx++) doc.extraChannels[doc.activeChannels[channelIdx]].rect.offset(deltaX, deltaY);
    doc.dirty = true
  }
};

MoveTool.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.finishPointerGesture(doc, pointerState, appData);
  this.refreshGuidesAndOverlays(doc);
  if (Date.now() - this.lastClickTimeMs < 300) {
    var textLayerIndex = TextTool.findTextLayerAtPoint(doc, doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y));
    if (textLayerIndex != -1) {
      var editTextEvent = new AppEvent(EventType.documentAction, true);
      editTextEvent.routingChannel = ToolId.TOOL_TYPE;
      editTextEvent.data = {
        actionKind: "editCurr",
        targetLayerIndex: textLayerIndex
      };
      dispatcher.dispatch(editTextEvent)
    } else if (MoveTool.isPointerOnRuler(appData, pointerState, doc.pathViewport)) {
      var zoomDialogEvent = new AppEvent(EventType.uiDispatch);
      zoomDialogEvent.data = {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "doczoom",
        initialValue: doc.pathViewport.zoomScale * 100,
        deferredDispatch: {
          appEventType: EventType.documentAction,
          documentModelType: ToolId.TOOL_ZOOM,
          payload: {
            actionKind: "pzoom"
          }
        }
      };
      dispatcher.dispatch(zoomDialogEvent)
    }
  }
  this.lastClickTimeMs = Date.now()
};
MoveTool.prototype.finishPointerGesture = function(doc, pointerState, appData, layerOffsetPairs, historyLabel) {
  if (!this.isDragging) return;
  this.isDragging = false;
  if (this.dragTargetKind == MOVE_TARGET.LAYER) {
    if (layerOffsetPairs) {
      this.recordMoveHistory(doc, null, layerOffsetPairs, historyLabel)
    } else {
      if (this.accumulatedDelta.x == 0 && this.accumulatedDelta.y == 0) return;
      this.recordMoveHistory(doc, this.accumulatedDelta.clone())
    }
    doc.panelsDirty = true
  } else if (this.dragTargetKind == MOVE_TARGET.GUIDE) {
    var guideHistoryKind = 0;
    pointerState = [pointerState.x, pointerState.y];
    var guideHit = this.selectedLayers,
      guidesBeforeCount = this.guidesSnapshot[0].length + this.guidesSnapshot[1].length,
      guidesAfterCount = doc.guides[0].length + doc.guides[1].length;
    if (appData.rulers && pointerState[guideHit[0]] < rulerThicknessPx()) {
      doc.guides[guideHit[0]].splice(guideHit[1], 1);
      guideHistoryKind = 1;
      if (guidesBeforeCount == guidesAfterCount - 1) return
    }
    if (guidesBeforeCount < guidesAfterCount) guideHistoryKind = 2;
    var guideHistoryEntry = new HistoryEntry(["history.moveGuide", "history.deleteGuide", "history.addGuide"][guideHistoryKind], this);
    guideHistoryEntry.data = {
      actionKind: MOVE_TARGET.GUIDE,
      guidesBefore: this.guidesSnapshot,
      guidesAfter: JSON.parse(JSON.stringify(doc.guides))
    };
    doc.pushHistory(guideHistoryEntry)
  } else if (this.dragTargetKind == MOVE_TARGET.CHANNEL) {
    var channelMoveEntry = new HistoryEntry("properties.move", this);
    channelMoveEntry.data = {
      actionKind: MOVE_TARGET.CHANNEL,
      channelIndices: doc.activeChannels.slice(0),
      moveDelta: this.accumulatedDelta.clone()
    };
    doc.pushHistory(channelMoveEntry)
  }
  this.accumulatedDelta.setXY(0, 0)
};
MoveTool.prototype.onKeyEvent = function(doc, dispatcher, appData, keyboard) {
  var arrowDelta = keyboard.getArrowMovement();
  if (doc != null && (arrowDelta.x != 0 || arrowDelta.y != 0)) {
    if (keyboard.isPressed(KeyboardHandler.Alt) && doc.selectionMask == null) {
      var duplicateEvent = new AppEvent(EventType.documentAction);
      duplicateEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
      duplicateEvent.data = {
        actionKind: Layer.duplicateLayer,
        duplicateInPlace: true
      };
      dispatcher.dispatch(duplicateEvent)
    }
    this.accumulatedDelta.setXY(arrowDelta.x, arrowDelta.y);
    this.beginPointerGesture(doc, dispatcher, keyboard, appData, false);
    if (!this.isDragging) return;
    this.applyPointerDelta(doc, arrowDelta.x, arrowDelta.y);
    this.finishPointerGesture(doc, null, appData);
    this.refreshGuidesAndOverlays(doc)
  }
  var ctrlPressed = keyboard.isPressed(KeyboardHandler.Ctrl);
  if (!this.embedInDialog && this.ctrlKeyWasPressed != ctrlPressed) {
    if (ctrlPressed) {
      this.autoSelectSavedBeforeCtrl = this.toolOptions.autoSelectLayers;
      this.toolOptions.autoSelectLayers = true
    } else {
      this.toolOptions.autoSelectLayers = this.autoSelectSavedBeforeCtrl
    }
    this.ctrlKeyWasPressed = ctrlPressed;
    var toolOptionsEvent = new AppEvent(EventType.uiDispatch, true);
    toolOptionsEvent.data = {
      dispatchKind: UiCommand.forwardActiveToolGesture,
      routingChannel: this.id,
      toolOptions: this.toolOptions
    };
    dispatcher.dispatch(toolOptionsEvent)
  }
};
MoveTool.prototype.undo = function(historyData, doc) {
  if (historyData.actionKind == MOVE_TARGET.LAYER) applyLayerTranslations(doc, historyData.layerIndices, historyData.layerEditFlags, historyData.layerOffsetPairs, true);
  else if (historyData.actionKind == MOVE_TARGET.GUIDE) {
    doc.guides = JSON.parse(JSON.stringify(historyData.guidesBefore));
    doc.dirty = true
  } else if (historyData.actionKind == MOVE_TARGET.CHANNEL) {
    for (var channelIdx = 0; channelIdx < historyData.channelIndices.length; channelIdx++) doc.extraChannels[historyData.channelIndices[channelIdx]].rect.offset(-historyData.moveDelta.x, -historyData.moveDelta.y);
    doc.dirty = true
  } else {
    var layer = doc.layers[historyData.layerIndex];
    if (historyData.usedPixCacheReset) {
      layer.restoreFromPixCache(doc, historyData.previousPixCache);
      doc.selectionMask = historyData.selectionBefore;
      doc.needsComposite = true;
      doc.markDirty();
      layer.markDirty()
    } else {
      offsetSelectionRect(doc, historyData.layerIndex, -historyData.selectionDragDelta.x, -historyData.selectionDragDelta.y)
    }
  }
};
MoveTool.prototype.redo = function(historyData, doc) {
  if (historyData.actionKind == MOVE_TARGET.LAYER) applyLayerTranslations(doc, historyData.layerIndices, historyData.layerEditFlags, historyData.layerOffsetPairs);
  else if (historyData.actionKind == MOVE_TARGET.GUIDE) {
    doc.guides = JSON.parse(JSON.stringify(historyData.guidesAfter));
    doc.dirty = true
  } else if (historyData.actionKind == MOVE_TARGET.CHANNEL) {
    for (var channelIdx = 0; channelIdx < historyData.channelIndices.length; channelIdx++) doc.extraChannels[historyData.channelIndices[channelIdx]].rect.offset(historyData.moveDelta.x, historyData.moveDelta.y);
    doc.dirty = true
  } else {
    var layer = doc.layers[historyData.layerIndex];
    if (historyData.usedPixCacheReset) {
      layer.pixCache = historyData.pixCache;
      doc.selectionMask = historyData.selectionAfter;
      offsetSelectionRect(doc, historyData.layerIndex, 0, 0);
      layer.markDirty()
    } else {
      offsetSelectionRect(doc, historyData.layerIndex, historyData.selectionDragDelta.x, historyData.selectionDragDelta.y)
    }
  }
};
MoveTool.prototype.recordMoveHistory = function(doc, moveDelta, layerOffsetPairs, historyLabel) {
  if (layerOffsetPairs) {
    var allZero = true;
    for (var pairIdx = 0; pairIdx < layerOffsetPairs.length; pairIdx++)
      if (layerOffsetPairs[pairIdx] != 0) allZero = false;
    if (allZero) return
  }
  var topHistoryEntry = doc.history[doc.historyIndex];
  if (topHistoryEntry.data && topHistoryEntry.routingChannel == this && topHistoryEntry.data.actionKind == MOVE_TARGET.LAYER && layerOffsetPairs == null && JSON.stringify(topHistoryEntry.data.layerIndices) == JSON.stringify(this.selectedLayers) && JSON.stringify(topHistoryEntry.data.layerEditFlags) == JSON.stringify(this.layerEditFlagsBefore)) {
    var offsetPairs = topHistoryEntry.data.layerOffsetPairs,
      offsetDescriptor = topHistoryEntry.data.moveActionDescriptor.actionDescriptor.T.v;
    offsetDescriptor.Hrzn.v.val += moveDelta.x;
    offsetDescriptor.Vrtc.v.val += moveDelta.y;
    for (var pairIdx = 0; pairIdx < offsetPairs.length; pairIdx += 2) {
      offsetPairs[pairIdx] += moveDelta.x;
      offsetPairs[pairIdx + 1] += moveDelta.y
    }
  } else {
    if (moveDelta == null) moveDelta = new Point(layerOffsetPairs[0], layerOffsetPairs[1]);
    var actionDescriptor = {
        uf: "move",
        actionDescriptor: {
          classID: "null",
          null: ActionDescUtil.buildTargetRef("Lyr", true),
          T: {
            t: "Objc",
            v: {
              classID: "Ofst",
              Hrzn: {
                t: "UntF",
                v: {
                  type: "#Rlt",
                  val: moveDelta.x
                }
              },
              Vrtc: {
                t: "UntF",
                v: {
                  type: "#Rlt",
                  val: moveDelta.y
                }
              }
            }
          }
        }
      },
      historyEntry = new HistoryEntry(historyLabel ? historyLabel : "properties.move", this);
    if (layerOffsetPairs) historyEntry.data = {
      actionKind: MOVE_TARGET.LAYER,
      layerIndices: this.selectedLayers,
      layerEditFlags: this.layerEditFlagsBefore,
      layerOffsetPairs: layerOffsetPairs
    };
    else historyEntry.data = {
      actionKind: MOVE_TARGET.LAYER,
      layerIndices: this.selectedLayers,
      layerEditFlags: this.layerEditFlagsBefore,
      layerOffsetPairs: repeatOffsetForLayers(this.selectedLayers, moveDelta.x, moveDelta.y)
    };
    historyEntry.data.moveActionDescriptor = actionDescriptor;
    doc.pushHistory(historyEntry);
    this.track(actionDescriptor)
  }
};



MoveTool.captureLayerEditFlags = function(doc, layerIndices) {
  var editFlags = [];
  for (var layerIdx = 0; layerIdx < layerIndices.length; layerIdx++) {
    var layer = doc.layers[layerIndices[layerIdx]];
    editFlags.push(layer.getTransformableChannels(doc))
  }
  return editFlags
};




}

// Chain each tool's prototype onto the base it extends. The bases are
// imported, so they are fully built by the time this runs.
MoveTool.prototype = Object.create(ToolBase.prototype);
installMoveToolPrototype();

