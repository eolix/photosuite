// Marquee / wand / quick-select tools and the SelectTool base every selection
// tool extends. Selection commits flow through action descriptors (see
// selection-actions.js) so scripting, history, and direct tool use share one
// path. Lasso tools live in lasso-tools.js and register through here.
import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";

import { Layer, LayerSectionType } from "../model/layer.js";
import { HistoryEntry } from "../model/document.js";
import { PopupTypes } from "../../ui/config/popup-types.js";
import {
  buildColorRangeSelection,
  invertSelectionOverCanvas,
  buildMagicWandAtPointAction,
  buildModifySelectionAction,
  buildPolygonSelectionAction,
  buildRectSelectionAction,
  buildSelectAllAction,
  buildSelectChannelAction,
  buildSetSelectionAction,
  channelToSelectionMask,
  getDefaultChannelIndexForLoad,
  growOrShrinkSelection,
  loadChannelAsSelectionMask,
  refineSelectionMask,
  resolveSelectionCombineMode,
} from "./selection-actions.js";
import { Mask } from "../model/layer-masks.js";
import { ActionDescUtil } from "../../features/scripting/action-desc.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { ToolBase, ToolId } from "../model/tool-base.js";
import { PaintTool } from "./paint-tools.js";
import { ShapeToolBase } from "./shape-tools.js";
import { snapPointToGuides, snapRectCornersToGuides, updateLayerDragPositions } from "../model/guide-snapping.js";
import { sampleSelectionAtPoint } from "./flood-select.js";
import { allocBuffer, extractChannelByte } from "../../engine/compositing/buffer-utils.js";
import { copyChannel, hitTestChannel, isBufferUniform, round, trimChannelToContent } from "../../engine/compositing/pixel-ops.js";
import { pixelAlignBoundsFromCoords, rectToPathOutline, toTyprPath } from "../../engine/compositing/anti-alias.js";
import { invert } from "../../engine/compositing/color-math.js";
import { applyChannelOp } from "../../engine/compositing/selection-utils.js";
import { stroke } from "../../engine/compositing/distance-field-stroke.js";
import { showToast } from "../../core/user-prompts.js";
import {
  adoptDocumentSelection,
  hasDocumentSelectionDiverged,
  quickSelectSession,
  resetQuickSelectSelection,
  seedObjectSelectionMask,
  syncQuickSelectOverlay,
} from "./quick-select-session.js";


function createDefaultSelectToolOptions() {
  return {
    combineMode: "front",
    feather: 0,
    aspectController: {
      constraintMode: 0,
      constraintWidth: 3,
      constraintHeight: 2,
    },
    magicWandOptions: [16, true, true],
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

/** Rect from a Rctn/Elps wire descriptor (Top/Left/Btom/Rght pixel units). */
function rectFromShapeDescriptor(shapeDescriptor) {
  const top = shapeDescriptor.Top.v.val;
  const left = shapeDescriptor.Left.v.val;
  return new Rect(left, top, shapeDescriptor.Rght.v.val - left, shapeDescriptor.Btom.v.val - top);
}

/** Path overlay from the polygon descriptor's paired coordinate arrays. */
function pathOverlayFromPolygonPoints(pointArrays) {
  const horizontalCoords = pointArrays[0].arr;
  const verticalCoords = pointArrays[1].arr;
  const pathOverlay = { coords: [], commands: [] };
  for (let pointIdx = 0; pointIdx < horizontalCoords.length; pointIdx++) {
    pathOverlay.commands.push(pointIdx == 0 ? "M" : "L");
    pathOverlay.coords.push(horizontalCoords[pointIdx], verticalCoords[pointIdx]);
  }
  pathOverlay.commands.push("Z");
  return pathOverlay;
}


export function SelectTool(name, id, iconId) {
  ToolBase.call(this, name, id, iconId);
  this.toolOptions = createDefaultSelectToolOptions();
  this.startPos = new Point(-1, -1);
  this.cursorPos = new Point(-1, -1);
  this.defaultCursorStyle = "default";
  this.appDispatcher = null;
  this.antialiasSelectionMask = true;
  this.exceededDragThreshold = false;
  this.shiftAtMouseDown = false;
  this.altAtMouseDown = false;
  this.shiftModifierStage = 0;
  this.altModifierStage = 0;
  this.isDraggingSelection = false;
  this.selectionRectBeforeDrag = null;
  this.spacePanDragOffset = null;
  this.suppressMoveDuringRightDrag = false;
}

// Consumers reach the builders and mask math through SelectTool statics.
SelectTool.buildSetSelectionAction = buildSetSelectionAction;
SelectTool.buildRectSelectionAction = buildRectSelectionAction;
SelectTool.buildPolygonSelectionAction = buildPolygonSelectionAction;
SelectTool.buildMagicWandAtPointAction = buildMagicWandAtPointAction;
SelectTool.buildSelectAllAction = buildSelectAllAction;
SelectTool.buildModifySelectionAction = buildModifySelectionAction;
SelectTool.buildSelectChannelAction = buildSelectChannelAction;
SelectTool.resolveSelectionCombineMode = resolveSelectionCombineMode;
SelectTool.refineSelectionMask = refineSelectionMask;
SelectTool.growOrShrinkSelection = growOrShrinkSelection;
SelectTool.channelToSelectionMask = channelToSelectionMask;
SelectTool.getDefaultChannelIndexForLoad = getDefaultChannelIndexForLoad;
SelectTool.loadChannelAsSelectionMask = loadChannelAsSelectionMask;
SelectTool.buildColorRangeSelection = buildColorRangeSelection;
SelectTool.invertSelectionOverCanvas = invertSelectionOverCanvas;

SelectTool.dispatchSelectionPrefPopups = function(dispatcher, appData) {
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.TOGGLE_EXTRAS,
  };
  if (!appData.extras) dispatcher.dispatch(uiEvent);
  uiEvent.data = {
    dispatchKind: UiCommand.openResourcePresetPopup,
    popupType: PopupTypes.OPEN_FILE,
  };
  if (!appData.prefs.showSelectionEdges) dispatcher.dispatch(uiEvent);
};

function installSelectToolPrototype() {

SelectTool.prototype.getCursorStyle = function() {
  const toolOptions = this.toolOptions;
  const cursorStyleParts = [
    { front: 0, union: 1, difference: 2, intersection: 3 }[toolOptions.combineMode],
    toolOptions.feather,
  ];
  if (this.id == ToolId.TOOL_MAGIC_WAND) cursorStyleParts.push(toolOptions.magicWandOptions);
  return cursorStyleParts;
};
SelectTool.prototype.syncToolbarWidget = function(widgetState, routingHint, dispatcher) {
  const options = this.toolOptions;
  options.combineMode = ["front", "union", "difference", "intersection"][widgetState[0]];
  options.feather = widgetState[1];
  options.magicWandOptions = widgetState[2];
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = {
    dispatchKind: UiCommand.forwardActiveToolGesture,
    routingChannel: this.id,
    toolOptions: options,
  };
  dispatcher.dispatch(uiEvent);
};

/**
 * Route a selection-changing event (scripted action, quick-mask toggle,
 * setsel, colour range, or load-from-source) into one history entry.
 */
SelectTool.prototype.handleInput = function(event, dispatcher, doc, keyboard, appData) {
  SelectTool.dispatchSelectionPrefPopups(dispatcher, appData);
  this.appDispatcher = dispatcher;
  const eventKind = event.actionKind;
  let outcome = null;
  if (eventKind == "fromAction") {
    outcome = this.applyScriptedSelection(event.scriptActionPayload, dispatcher, doc, keyboard, appData);
  } else if (eventKind == "qmask") {
    outcome = this.toggleQuickMask(doc);
  } else if (eventKind == "setsel") {
    outcome = { selection: event.selectionMask, label: event.historyLabelKey };
  } else if (eventKind == "crange") {
    let colorRangeSelection = buildColorRangeSelection(doc, event.labMin, event.labMax, event.fuzziness);
    if (event.invert) colorRangeSelection = invertSelectionOverCanvas(colorRangeSelection, doc);
    outcome = {
      selection: colorRangeSelection,
      label: "select.colourRange",
    };
    this.trackColorRangeAction(event);
  } else if (eventKind == "fromlayer" || eventKind == "fromchannel" || eventKind == "frompath") {
    outcome = this.selectionFromSource(eventKind, event, doc);
  }
  if (outcome == null) return;
  let newSelection = outcome.selection;
  let historyLabel = outcome.label;
  if (newSelection != null && isBufferUniform(newSelection.channel, 0)) {
    newSelection = null;
    historyLabel = "select.deselect";
  }
  if (newSelection) trimChannelToContent(newSelection);
  const historyEntry = new HistoryEntry(historyLabel, this);
  historyEntry.data = {
    actionKind: "changesel",
    selectionMaskBefore: doc.selectionMask,
    selectionMaskAfter: newSelection,
    isQuickMaskToggle: outcome.isQuickMaskToggle || false,
    quickMaskBefore: outcome.quickMaskBefore,
    quickMaskAfter: outcome.quickMaskNew,
    pathSelectionsBefore: outcome.pathSelectionsBefore,
    pathSelectionsAfter: outcome.pathSelectionsAfter,
  };
  doc.pushHistory(historyEntry);
  this.redo(historyEntry.data, doc);
};

/**
 * Scripted selection action (Select menu / recorded action). Returns
 * { selection, label } to commit, or null when the action was delegated to a
 * nested event or aborted.
 */
SelectTool.prototype.applyScriptedSelection = function(actionPayload, dispatcher, doc, keyboard, appData) {
  const operationKind = actionPayload.uf;
  const descriptorBody = actionPayload.actionDescriptor;
  const canvasRect = new Rect(0, 0, doc.width, doc.height);
  const effectAtBoundsNode = descriptorBody ? descriptorBody.selectionModifyEffectAtCanvasBounds : null;
  const effectAtCanvasBounds = effectAtBoundsNode && effectAtBoundsNode.v;
  let outcome = this.applyScriptedModify(operationKind, descriptorBody, doc, canvasRect, effectAtCanvasBounds);
  if (outcome === undefined) {
    outcome = this.applyScriptedShapeSelection(operationKind, descriptorBody, dispatcher, doc, keyboard, appData, canvasRect);
    if (outcome == null) return null;
    if (descriptorBody.Fthr) outcome.selection = refineSelectionMask(outcome.selection, descriptorBody.Fthr.v.val, false);
    const combineModeIndex = ["set", "addTo", "subtractFrom", "interfaceWhite"].indexOf(operationKind);
    if (operationKind != "set" && doc.selectionMask != null) {
      outcome.selection = applyChannelOp(outcome.selection, doc.selectionMask, ["", "union", "difference", "intersection"][combineModeIndex]);
    }
  }
  if (outcome == null) return null;
  if (operationKind == "expand" || operationKind == "contract") {
    if (!effectAtCanvasBounds && !canvasRect.contains(outcome.selection.rect)) {
      const clampedRect = outcome.selection.rect.intersect(canvasRect);
      const clampedBuffer = allocBuffer(clampedRect.area());
      copyChannel(outcome.selection.channel, outcome.selection.rect, clampedBuffer, clampedRect);
      outcome.selection.channel = clampedBuffer;
      outcome.selection.rect = clampedRect;
    }
  }
  return outcome;
};

/**
 * Select > Modify family (inverse / expand / contract / border / feather /
 * smoothness). Returns undefined when the operation is not a modify op, null
 * on abort.
 */
SelectTool.prototype.applyScriptedModify = function(operationKind, descriptorBody, doc, canvasRect, effectAtCanvasBounds) {
  if (operationKind == "inverse") {
    if (doc.selectionMask == null) {
      alert("No selection!");
      return null;
    }
    const invertedSelection = {
      channel: allocBuffer(canvasRect.area()),
      rect: canvasRect,
    };
    copyChannel(doc.selectionMask.channel, doc.selectionMask.rect, invertedSelection.channel, invertedSelection.rect);
    invert(invertedSelection.channel);
    return { selection: invertedSelection, label: "select.inverse" };
  }
  if (operationKind == "expand") {
    const pixelAmount = descriptorBody.By.v.val;
    const expandedRect = doc.selectionMask.rect.clone();
    expandedRect.inflate(pixelAmount, pixelAmount);
    const expandedBuffer = allocBuffer(expandedRect.area());
    const sourceCopy = allocBuffer(expandedRect.area());
    copyChannel(doc.selectionMask.channel, doc.selectionMask.rect, sourceCopy, expandedRect);
    stroke(sourceCopy, expandedBuffer, expandedRect, pixelAmount);
    return { selection: { channel: expandedBuffer, rect: expandedRect }, label: "select.expand" };
  }
  if (operationKind == "contract") {
    const pixelAmount = descriptorBody.By.v.val;
    let contractRect = doc.selectionMask.rect.clone();
    contractRect.inflate(1, 1);
    if (!effectAtCanvasBounds) contractRect = contractRect.intersect(canvasRect);
    const sourceCopy = allocBuffer(contractRect.area());
    const contractedBuffer = allocBuffer(sourceCopy.length);
    copyChannel(doc.selectionMask.channel, doc.selectionMask.rect, sourceCopy, contractRect);
    invert(sourceCopy);
    stroke(sourceCopy, contractedBuffer, contractRect, pixelAmount);
    invert(contractedBuffer);
    const contractedSelection = { channel: contractedBuffer, rect: contractRect };
    trimChannelToContent(contractedSelection);
    return { selection: contractedSelection, label: "select.contract" };
  }
  if (operationKind == "border") {
    const pixelAmount = descriptorBody.Wdth.v.val;
    return {
      selection: growOrShrinkSelection(doc.selectionMask, pixelAmount / 2, pixelAmount / 2),
      label: "select.border",
    };
  }
  if (operationKind == "feather" || operationKind == "smoothness") {
    const pixelAmount = descriptorBody.Rds.v.val;
    return {
      selection: refineSelectionMask(doc.selectionMask, pixelAmount, operationKind == "smoothness", canvasRect, effectAtCanvasBounds),
      label: operationKind == "feather" ? "select.feather" : "styleOptions.bevelTechnique.smooth",
    };
  }
  return undefined;
};

/**
 * Shape / channel branch of a scripted selection: marquee shapes, object
 * select, polygon, wand point, all/none, or a nested channel/path load.
 * Returns { selection, label } or null when delegated.
 */
SelectTool.prototype.applyScriptedShapeSelection = function(operationKind, descriptorBody, dispatcher, doc, keyboard, appData, canvasRect) {
  const selectionShape = descriptorBody.T ? descriptorBody.T.v : null;
  if (selectionShape && selectionShape.classID == "Elps") {
    return {
      selection: this.bezierPathToSelectionMask(EllipseSelectTool.ellipseToBezierPath(rectFromShapeDescriptor(selectionShape))),
      label: "tools.ellipseSelect",
    };
  }
  if (selectionShape && selectionShape.classID == "Rctn") {
    const shapeRect = rectFromShapeDescriptor(selectionShape);
    const rectSelection = {
      channel: allocBuffer(shapeRect.area()),
      rect: shapeRect.clone(),
    };
    rectSelection.channel.fill(255);
    return { selection: rectSelection, label: "tools.rectangleSelect" };
  }
  if (selectionShape && selectionShape.classID == "ObSl") {
    return {
      selection: seedObjectSelectionMask(rectFromShapeDescriptor(selectionShape)),
      label: "tools.objectSelection",
    };
  }
  if (selectionShape && selectionShape.classID == "Plgn") {
    return {
      selection: this.bezierPathToSelectionMask(pathOverlayFromPolygonPoints(selectionShape.Pts.v.arr)),
      // Plgn covers every traced outline — freehand, polygonal and magnetic all
      // commit through buildPolygonSelectionAction — so the history step is
      // named for the family, not one member of it.
      label: "tools.lassoSelect",
    };
  }
  if (selectionShape && selectionShape.classID == "Pnt") {
    return {
      selection: sampleSelectionAtPoint(doc, new Point(selectionShape.Hrzn.v.val, selectionShape.Vrtc.v.val), [descriptorBody.Tlrn.v, descriptorBody.AntA == null || descriptorBody.AntA.v, descriptorBody.Cntg == null || descriptorBody.Cntg.v]),
      label: "tools.magicWand",
    };
  }
  if (selectionShape && selectionShape.Ordn == "None") {
    return { selection: null, label: "select.deselect" };
  }
  if (selectionShape && selectionShape.Ordn == "Al") {
    const allSelection = {
      channel: allocBuffer(canvasRect.area()),
      rect: canvasRect,
    };
    allSelection.channel.fill(255);
    return { selection: allSelection, label: "select.all" };
  }
  if (selectionShape && selectionShape[0] && selectionShape[0].v.keyID == "WrPt") {
    this.handleInput({ actionKind: "frompath", selectionSource: [-1, 0, 0] }, dispatcher, doc, keyboard, appData);
    return null;
  }
  // Channel loads delegate to a fromlayer / fromchannel event.
  const channelCombineModeIndex = ["set", "add", "subtract", "interfaceIconFrameDimmed"].indexOf(operationKind);
  const channelDescriptorList = operationKind == "set" ? selectionShape : descriptorBody.null.v;
  if (channelDescriptorList == null) return null;
  const channelEnum = channelDescriptorList[0].v.enum;
  let nestedEvent;
  if (channelEnum == "Trsp" || channelEnum == "Msk" || channelEnum == "vectorMask") {
    let layerIndex = doc.selectedLayerIndices[0];
    if (channelDescriptorList.length == 2) layerIndex = ActionDescUtil.resolveLayerIndexFromRef(doc, channelDescriptorList[1]);
    const layerChannelKind = ["Trsp", "Msk", "vectorMask"].indexOf(channelEnum);
    nestedEvent = {
      actionKind: "fromlayer",
      selectionSource: [layerIndex, layerChannelKind, channelCombineModeIndex],
    };
  } else if (channelDescriptorList[0].t == "name") {
    let extraChannelIndex = 0;
    for (let channelIdx = 0; channelIdx < doc.extraChannels.length; channelIdx++) {
      if (doc.extraChannels[channelIdx].name == channelDescriptorList[0].v.val) extraChannelIndex = channelIdx;
    }
    nestedEvent = {
      actionKind: "fromchannel",
      selectionSource: [-5 - extraChannelIndex, 0, channelCombineModeIndex],
    };
  } else {
    const rgbChannelIndex = ["RGB", "Rd", "Grn", "Bl"].indexOf(channelEnum);
    nestedEvent = {
      actionKind: "fromchannel",
      selectionSource: [-1 - rgbChannelIndex, 0, channelCombineModeIndex],
    };
  }
  this.handleInput(nestedEvent, dispatcher, doc, keyboard, appData);
  return null;
};

/** Toggle quick-mask mode; the mask channel round-trips with the selection. */
SelectTool.prototype.toggleQuickMask = function(doc) {
  const fullCanvasRect = new Rect(0, 0, doc.width, doc.height);
  const existingQuickMask = doc.getQuickMask();
  const outcome = {
    selection: null,
    label: "layer.quickMaskMode",
    isQuickMaskToggle: true,
    quickMaskBefore: undefined,
    quickMaskNew: undefined,
  };
  if (existingQuickMask) {
    outcome.selection = existingQuickMask.rect.equals(fullCanvasRect) && isBufferUniform(existingQuickMask.channel, 255) ? null : {
      rect: existingQuickMask.rect.clone(),
      channel: existingQuickMask.channel.slice(0),
    };
    outcome.quickMaskBefore = existingQuickMask;
  } else {
    const quickMask = new Mask();
    quickMask.color = 0;
    quickMask.name = "Quick Mask";
    quickMask.active = true;
    if (doc.selectionMask) {
      quickMask.rect = doc.selectionMask.rect.clone();
      quickMask.channel = doc.selectionMask.channel.slice(0);
    } else {
      quickMask.rect = fullCanvasRect;
      quickMask.channel = allocBuffer(quickMask.rect.area());
      quickMask.channel.fill(255);
    }
    outcome.quickMaskNew = quickMask;
  }
  return outcome;
};

/** Record the Colour Range action descriptor for scripting/history. */
SelectTool.prototype.trackColorRangeAction = function(event) {
  const labColorDescriptor = (lab) => ({
    t: "Objc",
    v: {
      classID: "LbCl",
      Lmnc: { t: "doub", v: lab.labL },
      A: { t: "doub", v: lab.labA },
      B: { t: "doub", v: lab.labB },
    },
  });
  this.track({
    uf: "colorRange",
    actionDescriptor: {
      __name: "Color Range",
      classID: "ClrR",
      Fzns: { t: "long", v: Math.round(event.fuzziness * 200) },
      Mnm: labColorDescriptor(event.labMin),
      Mxm: labColorDescriptor(event.labMax),
      colorModel: { t: "long", v: 0 },
    },
  });
};

/**
 * Load a selection from a layer channel, an RGB/extra channel, or a path.
 * Returns { selection, label, … } or null on abort.
 */
SelectTool.prototype.selectionFromSource = function(eventKind, event, doc) {
  const canvasRect = new Rect(0, 0, doc.width, doc.height);
  let sourceIndex = event.selectionSource[0];
  const layerChannelKind = event.selectionSource[1];
  const combineModeIndex = event.selectionSource[2];
  const outcome = { selection: null, label: "layerEffects.selectPixels" };
  if (eventKind == "fromlayer") {
    if (sourceIndex == null) sourceIndex = doc.selectedLayerIndices[0];
    const layer = doc.layers[sourceIndex];
    if (layerChannelKind == 0) {
      if (layer.rect.isEmpty()) return null;
      const maskBuffer = allocBuffer(layer.buffer.length >>> 2);
      extractChannelByte(layer.buffer, maskBuffer, 3);
      outcome.selection = { channel: maskBuffer, rect: layer.rect.clone() };
    } else {
      if (layer.d == null) layer.invalidate(doc);
      const maskSource = layerChannelKind == 1 ? layer.getMask() : layer.d;
      outcome.selection = channelToSelectionMask(maskSource, canvasRect);
    }
    this.track(buildSelectChannelAction(combineModeIndex, ["Trsp", "Msk"][layerChannelKind], layer.getName()));
  } else if (eventKind == "frompath") {
    const pathLists = doc.getPaths();
    const workPaths = pathLists[0];
    const selectedPathIndices = pathLists[1];
    if (sourceIndex == null && (workPaths.length == 0 || selectedPathIndices.length == 0)) return null;
    let selectedPath = workPaths[selectedPathIndices[0]];
    if (sourceIndex != null) {
      for (let pathIdx = 0; pathIdx < workPaths.length; pathIdx++) {
        if (workPaths[pathIdx].idx == sourceIndex) selectedPath = workPaths[pathIdx];
      }
    }
    const maskSource = selectedPath.add.vmsk.getMask();
    const pathSelectionRect = maskSource.getSelectionRect();
    if (pathSelectionRect.area() == 0) return null;
    let maskBuffer = maskSource.getMaskBuffer();
    if (event.selectionSource[3] != null) this.antialiasSelectionMask = event.selectionSource[3];
    if (this.antialiasSelectionMask) {
      maskBuffer = maskBuffer.slice(0);
      round(maskBuffer);
    }
    outcome.pathSelectionsBefore = [JSON.stringify(doc.selectedWorkPaths), JSON.stringify(doc.selectedLayerPaths)];
    outcome.pathSelectionsAfter = ["[]", "[]"];
    doc.selectedWorkPaths = [];
    doc.selectedLayerPaths = [];
    outcome.selection = { channel: maskBuffer, rect: pathSelectionRect };
  } else {
    if (sourceIndex == null) sourceIndex = getDefaultChannelIndexForLoad(doc);
    outcome.selection = loadChannelAsSelectionMask(doc, sourceIndex);
  }
  if (combineModeIndex != 0 && doc.selectionMask) {
    outcome.selection = applyChannelOp(outcome.selection, doc.selectionMask, ["", "union", "difference", "intersection"][combineModeIndex]);
  }
  return outcome;
};

SelectTool.prototype.wantsInput = function(pointerState) {
  return this.isDraggingSelection || pointerState.isDown && this.id != ToolId.TOOL_LASSO_SELECT;
};
SelectTool.prototype.emitEvent = function(dispatcher, eventType, eventData) {
  const appEvent = new AppEvent(eventType, true);
  appEvent.data = eventData;
  dispatcher.dispatch(appEvent);
};
SelectTool.prototype.updateSelectionCursor = function(dispatcher, cursorStyle) {
  dispatchCursorOverlay(dispatcher, cursorStyle);
};
SelectTool.prototype.getSelectionRect = function(doc, keyboard, clampToCanvas) {
  keyboard = doc.selectionMask == null || this.shiftModifierStage > 1 || this.altModifierStage > 1 ? keyboard : null;
  const startPoint = this.startPos;
  const endPoint = this.cursorPos;
  if (clampToCanvas) {
    startPoint.x = Math.max(0, Math.min(doc.width, startPoint.x));
    startPoint.y = Math.max(0, Math.min(doc.height, startPoint.y));
    endPoint.x = Math.max(0, Math.min(doc.width, endPoint.x));
    endPoint.y = Math.max(0, Math.min(doc.height, endPoint.y));
  }
  const constrainedPoints = ShapeToolBase.constrainShapePoints(startPoint, endPoint, keyboard, true, this.toolOptions.aspectController);
  const left = constrainedPoints[0].x;
  const top = constrainedPoints[0].y;
  return new Rect(left, top, constrainedPoints[1].x - left, constrainedPoints[1].y - top);
};
SelectTool.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (this.shouldCancelMouseDown()) return;
  this.appDispatcher = dispatcher;
  this.exceededDragThreshold = false;
  this.shiftAtMouseDown = keyboard.isPressed(KeyboardHandler.Shift);
  this.altAtMouseDown = keyboard.isPressed(KeyboardHandler.Alt);
  this.shiftModifierStage = this.shiftAtMouseDown ? 0 : 1;
  this.altModifierStage = this.altAtMouseDown ? 0 : 1;
  this.startPos = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
  this.startPos = snapPointToGuides(doc, this.startPos, appData);
  if (this.isHitOnExistingSelection(doc, this.startPos, keyboard)) {
    this.isDraggingSelection = true;
    this.selectionRectBeforeDrag = doc.selectionMask.rect.clone();
    return;
  }
  this.onDragStart(doc, appData, keyboard, pointerState);
  doc.pathViewport.dimensionOverlay = new Rect();
};
SelectTool.prototype.isHitOnExistingSelection = function(doc, docPoint, keyboard) {
  const shiftDown = keyboard.isPressed(KeyboardHandler.Shift);
  const altDown = keyboard.isPressed(KeyboardHandler.Alt);
  if (doc.selectionMask && !shiftDown && !altDown && this.toolOptions.combineMode == "front") {
    return hitTestChannel(docPoint, doc.selectionMask.channel, doc.selectionMask.rect);
  }
  return false;
};
SelectTool.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.appDispatcher = dispatcher;
  if (this.suppressMoveDuringRightDrag) return;
  const docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
  if (Point.dist(this.startPos, docPoint) * doc.pathViewport.zoomScale > 5) this.exceededDragThreshold = true;
  if (keyboard.isPressed(KeyboardHandler.Space)) {
    if (this.spacePanDragOffset == null) this.spacePanDragOffset = new Point(docPoint.x - this.startPos.x, docPoint.y - this.startPos.y);
    this.startPos.x = docPoint.x - this.spacePanDragOffset.x;
    this.startPos.y = docPoint.y - this.spacePanDragOffset.y;
  } else this.spacePanDragOffset = null;
  this.cursorPos = docPoint;
  // The freehand lasso samples a point per pointer move, so snapping every
  // sample would pull the traced outline onto guides, grid lines and layer
  // edges. Its anchor is still snapped at mouse-down.
  if (!this.isDraggingSelection && this.id != ToolId.TOOL_LASSO_SELECT) {
    this.cursorPos = snapPointToGuides(doc, this.cursorPos, appData);
  }
  if (this.isHitOnExistingSelection(doc, this.cursorPos, keyboard)) this.updateSelectionCursor(dispatcher, "move");
  else this.updateSelectionCursor(dispatcher, this.defaultCursorStyle);
  if (this.isDraggingSelection) {
    const dragPreviewRect = this.selectionRectBeforeDrag.clone();
    dragPreviewRect.x += this.cursorPos.x - this.startPos.x;
    dragPreviewRect.y += this.cursorPos.y - this.startPos.y;
    const guideSnapDelta = snapRectCornersToGuides(doc, dragPreviewRect, appData);
    doc.selectionMask.rect.x = Math.round(this.cursorPos.x - this.startPos.x + this.selectionRectBeforeDrag.x + guideSnapDelta[0]);
    doc.selectionMask.rect.y = Math.round(this.cursorPos.y - this.startPos.y + this.selectionRectBeforeDrag.y + guideSnapDelta[1]);
    doc.needsComposite = true;
    updateLayerDragPositions(doc, dragPreviewRect, guideSnapDelta);
    return;
  }
  this.onDrag(doc, appData, keyboard, pointerState);
  if (doc.pathViewport.dimensionOverlay) doc.pathViewport.dimensionOverlay = this.getSelectionRect(doc, keyboard);
};
SelectTool.prototype.shouldCancelMouseDown = function() {
  return false;
};
SelectTool.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
  doc.pathViewport.dimensionOverlay = null;
  this.cursorPos = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
  this.cursorPos = snapPointToGuides(doc, this.cursorPos, appData);
  if (this.isDraggingSelection) {
    this.isDraggingSelection = false;
    if (this.cursorPos.equals(this.startPos) && this.getSelectionCombineMode() == "front") {
      this.emitEvent(dispatcher, EventType.historyGrouped, buildSelectAllAction());
      return;
    }
    this.recordSelectionRectMove(doc, this.selectionRectBeforeDrag, doc.selectionMask.rect.clone());
    if (doc != null && doc.toolOverlayState.snapGuides) {
      doc.toolOverlayState.snapGuides = null;
      doc.dirty = true;
    }
    return;
  }
  this.onDragEnd(doc, appData, keyboard, pointerState);
  SelectTool.dispatchSelectionPrefPopups(dispatcher, appData);
};
SelectTool.prototype.recordSelectionRectMove = function(doc, rectBefore, rectAfter) {
  let historyEntry = doc.getLastHistoryEntry();
  const coalesce = historyEntry != null && historyEntry.routingChannel == this && historyEntry.data.actionKind == "movesel";
  if (!coalesce) {
    historyEntry = new HistoryEntry("select.moveSelection", this);
    historyEntry.data = {
      actionKind: "movesel",
      rectBefore: rectBefore,
    };
    doc.pushHistory(historyEntry);
  }
  historyEntry.data.rectAfter = rectAfter;
  this.redo(historyEntry.data, doc);
};
SelectTool.prototype.onRightMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.suppressMoveDuringRightDrag = true;
};
SelectTool.prototype.onRightMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = {
    dispatchKind: UiCommand.forwardActiveToolGesture,
    routingChannel: this.id,
    pointerState: pointerState,
    doc: doc,
    appData: appData,
  };
  dispatcher.dispatch(uiEvent);
  this.suppressMoveDuringRightDrag = false;
};
SelectTool.prototype.onKeyEvent = function(doc, dispatcher, appData, keyboard) {
  const shiftDown = keyboard.isPressed(KeyboardHandler.Shift);
  const altDown = keyboard.isPressed(KeyboardHandler.Alt);
  if (this.exceededDragThreshold) {
    if (this.shiftModifierStage == 0 && !shiftDown) this.shiftModifierStage++;
    if (this.shiftModifierStage == 1 && shiftDown) this.shiftModifierStage++;
    if (this.altModifierStage == 0 && !altDown) this.altModifierStage++;
    if (this.altModifierStage == 1 && altDown) this.altModifierStage++;
  }
  if (doc != null && doc.selectionMask != null) {
    const arrowDelta = keyboard.getArrowMovement();
    if (arrowDelta.x != 0 || arrowDelta.y != 0) {
      const nudgedRect = doc.selectionMask.rect.clone();
      nudgedRect.x += arrowDelta.x;
      nudgedRect.y += arrowDelta.y;
      this.recordSelectionRectMove(doc, doc.selectionMask.rect.clone(), nudgedRect);
    }
  }
  const resolvedCombineMode = resolveSelectionCombineMode(this.toolOptions.combineMode, shiftDown, altDown);
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = {
    dispatchKind: UiCommand.forwardActiveToolGesture,
    routingChannel: this.id,
    combineMode: resolvedCombineMode,
  };
  dispatcher.dispatch(uiEvent);
};
SelectTool.prototype.finish = function(doc, appData, keyboard, pointerState) {
  let selectionAction = this.getSelection(doc, appData, keyboard, pointerState);
  if (selectionAction == null) selectionAction = buildSelectAllAction();
  else {
    const featherRadius = this.toolOptions.feather;
    const combineMode = this.getSelectionCombineMode();
    if (featherRadius != 0) selectionAction.actionDescriptor.Fthr = {
      t: "UntF",
      v: { type: "#Pxl", val: featherRadius },
    };
    if (combineMode != "front" && combineMode != "xor") selectionAction.uf = {
      union: "addTo",
      difference: "subtractFrom",
      intersection: "interfaceWhite",
    }[combineMode];
  }
  this.emitEvent(this.appDispatcher, EventType.historyGrouped, selectionAction);
  this.startPos.setXY(-1, -1);
  this.cursorPos.setXY(-1, -1);
};
SelectTool.prototype.getSelectionCombineMode = function() {
  return resolveSelectionCombineMode(this.toolOptions.combineMode, this.shiftAtMouseDown, this.altAtMouseDown);
};
SelectTool.prototype.getSelection = function(doc, appData, keyboard, pointerState) {
  return null;
};
SelectTool.prototype.onDragStart = function(doc, appData, keyboard, pointerState) {};
SelectTool.prototype.onDrag = function(doc, appData, keyboard, pointerState) {};
SelectTool.prototype.onDragEnd = function(doc, appData, keyboard, pointerState) {};
SelectTool.prototype.undo = function(historyData, doc) {
  const historyKind = historyData.actionKind;
  if (historyKind == "changesel") doc.selectionMask = historyData.selectionMaskBefore;
  if (historyKind == "movesel") doc.selectionMask.rect = historyData.rectBefore;
  if (historyData.isQuickMaskToggle) {
    if (historyData.quickMaskBefore) {
      doc.activeChannels = [doc.extraChannels.length];
      doc.extraChannels.push(historyData.quickMaskBefore);
    } else {
      doc.extraChannels.pop();
      doc.activeChannels = [];
    }
  }
  if (historyData.pathSelectionsBefore) {
    doc.selectedWorkPaths = JSON.parse(historyData.pathSelectionsBefore[0]);
    doc.selectedLayerPaths = JSON.parse(historyData.pathSelectionsBefore[1]);
  }
  doc.needsComposite = true;
};
SelectTool.prototype.redo = function(historyData, doc) {
  const historyKind = historyData.actionKind;
  if (historyKind == "changesel") doc.selectionMask = historyData.selectionMaskAfter;
  if (historyKind == "movesel") doc.selectionMask.rect = historyData.rectAfter;
  if (historyData.isQuickMaskToggle) {
    if (historyData.quickMaskAfter) {
      doc.activeChannels = [doc.extraChannels.length];
      doc.extraChannels.push(historyData.quickMaskAfter);
    } else {
      doc.extraChannels.pop();
      doc.activeChannels = [];
    }
  }
  if (historyData.pathSelectionsAfter) {
    doc.selectedWorkPaths = JSON.parse(historyData.pathSelectionsAfter[0]);
    doc.selectedLayerPaths = JSON.parse(historyData.pathSelectionsAfter[1]);
  }
  doc.needsComposite = true;
};
SelectTool.prototype.applyAction = function(actionPayload) {
  this.toolOptions = actionPayload;
};
SelectTool.prototype.bezierPathToSelectionMask = function(pathOverlay) {
  const alignedBounds = pixelAlignBoundsFromCoords(pathOverlay.coords);
  if (alignedBounds.isEmpty()) return null;
  const scratchCanvas = makeElement("canvas", "");
  scratchCanvas.width = alignedBounds.width;
  scratchCanvas.height = alignedBounds.height;
  const ctx = scratchCanvas.getContext("2d");
  ctx.beginPath();
  ctx.translate(-alignedBounds.x, -alignedBounds.y);
  Typr.U.pathToContext(toTyprPath(pathOverlay), ctx);
  ctx.closePath();
  ctx.fill();
  const alphaBuffer = allocBuffer(alignedBounds.area());
  const imageData = ctx.getImageData(0, 0, scratchCanvas.width, scratchCanvas.height);
  extractChannelByte(imageData.data, alphaBuffer, 3);
  return { rect: alignedBounds, channel: alphaBuffer };
};

}

export function MagicWandTool() {
  SelectTool.call(this, "tools.magicWand", ToolId.TOOL_MAGIC_WAND, "tools/mwand");
}

function installMagicWandToolPrototype() {

MagicWandTool.prototype.getCursorStyle = SelectTool.prototype.getCursorStyle;
MagicWandTool.prototype.syncToolbarWidget = SelectTool.prototype.syncToolbarWidget;
MagicWandTool.prototype.onDragStart = function(doc, appData, keyboard, pointerState) {
  this.finish(doc, appData, keyboard, pointerState);
};
MagicWandTool.prototype.getSelection = function(doc, appData, keyboard, pointerState) {
  const cursorPos = this.cursorPos;
  return buildMagicWandAtPointAction(new Point(Math.floor(cursorPos.x), Math.floor(cursorPos.y)), this.toolOptions.magicWandOptions);
};






}

export function QuickSelectTool() {
  PaintTool.call(this, "tools.quickSelection", ToolId.TOOL_QUICK_SELECT, "tools/qselect");
  this.strokeCompositeMode = "qselect";
}

function installQuickSelectToolPrototype() {

QuickSelectTool.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
  if (doc.selectedLayerIndices.length == 0) {
    showToast("Select a layer first.");
    return;
  }
  // The stroke needs the segmentation in this same tick, so the analysis runs
  // inline here rather than on the deferred path the hover uses.
  syncQuickSelectOverlay(doc, quickSelectSession, dispatcher, true);
  // The first stroke replaces the selection, and every stroke after it adds to
  // what that one claimed: `qsmode` moves to add on mouse-up.
  if (this.toolOptions.qsmode == 0) {
    resetQuickSelectSelection(quickSelectSession);
  } else if (hasDocumentSelectionDiverged(quickSelectSession, doc.selectionMask)) {
    // The document's selection came from somewhere else — a step through
    // history, a marquee, a deselect — so the scribbles this session is
    // holding describe a selection the document has since replaced. This
    // stroke starts over from what the document holds now.
    adoptDocumentSelection(quickSelectSession, doc.selectionMask);
    this.strokeData = null;
  }
  this.beginStroke(doc, appData, keyboard, pointerState, 1);
  if (this.strokeData == null) return;
  this.applyStroke(doc);
};
QuickSelectTool.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
  this.syncBrushScaleToZoom(doc, dispatcher, appData);
  syncQuickSelectOverlay(doc, quickSelectSession, dispatcher);
  if (this.rightDragAnchor) this.updateBrushSizeFromRightDrag(doc, appData, pointerState);
  if (this.strokeData == null) return;
  if (!pointerState.isDown) return;
  const strokeStatus = this.continueStroke(doc, appData, keyboard, pointerState);
  if (strokeStatus != 1) this.applyStroke(doc);
};





}

export function RectSelectTool() {
  SelectTool.call(this, "tools.rectangleSelect", ToolId.TOOL_RECT_SELECT, "tools/rselect");
  this.defaultCursorStyle = "crosshair";
}

function installRectSelectToolPrototype() {

RectSelectTool.prototype.onDrag = function(doc, appData, keyboard, pointerState) {
  if (!pointerState.isDown || !this.exceededDragThreshold) return;
  const selectionRect = this.getSelectionRect(doc, keyboard, true);
  doc.toolOverlayState.overlayTransform = rectToPathOutline(selectionRect);
  doc.dirty = true;
  ToolBase.drawDimensionOverlay(pointerState.x + 10, pointerState.y - 10, selectionRect, doc, appData);
};
RectSelectTool.prototype.onDragEnd = function(doc, appData, keyboard, pointerState) {
  doc.toolOverlayState.overlayTransform = null;
  doc.toolOverlayState.floatingBitmapOverlays = [];
  doc.dirty = true;
  this.finish(doc, appData, keyboard, pointerState);
};
RectSelectTool.prototype.getSelection = function(doc, appData, keyboard, pointerState) {
  if (this.startPos.equals(this.cursorPos) || !this.exceededDragThreshold) return null;
  const selectionRect = this.getSelectionRect(doc, keyboard, true);
  if (selectionRect.isEmpty()) return null;
  return buildRectSelectionAction("Rctn", selectionRect);
};

}

export function EllipseSelectTool() {
  SelectTool.call(this, "tools.ellipseSelect", ToolId.TOOL_ELLIPSE_SELECT, "tools/eselect");
  this.defaultCursorStyle = "crosshair";
}

function installEllipseSelectToolPrototype() {

EllipseSelectTool.prototype.onDrag = function(doc, appData, keyboard, pointerState) {
  if (!pointerState.isDown || !this.exceededDragThreshold) return;
  const selectionRect = this.getSelectionRect(doc, keyboard);
  doc.toolOverlayState.overlayTransform = EllipseSelectTool.ellipseToBezierPath(selectionRect);
  doc.dirty = true;
  ToolBase.drawDimensionOverlay(pointerState.x + 10, pointerState.y - 10, selectionRect, doc, appData);
};
EllipseSelectTool.prototype.onDragEnd = function(doc, appData, keyboard, pointerState) {
  doc.toolOverlayState.overlayTransform = null;
  doc.toolOverlayState.floatingBitmapOverlays = [];
  doc.dirty = true;
  this.finish(doc, appData, keyboard, pointerState);
};
EllipseSelectTool.prototype.getSelection = function(doc, appData, keyboard, pointerState) {
  if (this.startPos.equals(this.cursorPos) || !this.exceededDragThreshold) return null;
  const selectionRect = this.getSelectionRect(doc, keyboard);
  if (!selectionRect.overlaps(new Rect(0, 0, doc.width, doc.height))) return null;
  return buildRectSelectionAction("Elps", selectionRect);
};
/** Four-arc cubic approximation of the ellipse inscribed in `rect`. */
EllipseSelectTool.ellipseToBezierPath = function(rect) {
  const leftX = rect.x;
  const topY = rect.y;
  const rightX = rect.x + rect.width;
  const bottomY = rect.y + rect.height;
  const centerX = (leftX + rightX) / 2;
  const centerY = (topY + bottomY) / 2;
  const halfWidth = (leftX - rightX) / 2;
  const halfHeight = (topY - bottomY) / 2;
  const bezierKappa = 0.5522848;
  const path = {
    coords: [centerX, centerY - halfHeight],
    commands: ["M", "C", "C", "C", "C"],
  };
  path.coords.push(centerX + bezierKappa * halfWidth, centerY - halfHeight, centerX + halfWidth, centerY - bezierKappa * halfHeight, centerX + halfWidth, centerY);
  path.coords.push(centerX + halfWidth, centerY + bezierKappa * halfHeight, centerX + bezierKappa * halfWidth, centerY + halfHeight, centerX, centerY + halfHeight);
  path.coords.push(centerX - bezierKappa * halfWidth, centerY + halfHeight, centerX - halfWidth, centerY + bezierKappa * halfHeight, centerX - halfWidth, centerY);
  path.coords.push(centerX - halfWidth, centerY - bezierKappa * halfHeight, centerX - bezierKappa * halfWidth, centerY - halfHeight, centerX, centerY - halfHeight);
  return path;
};

}

// Chain each tool's prototype onto the base it extends. The bases are
// imported, so they are fully built by the time this runs.
SelectTool.prototype = Object.create(ToolBase.prototype);
installSelectToolPrototype();
MagicWandTool.prototype = Object.create(SelectTool.prototype);
installMagicWandToolPrototype();
QuickSelectTool.prototype = Object.create(PaintTool.prototype);
installQuickSelectToolPrototype();
RectSelectTool.prototype = Object.create(SelectTool.prototype);
installRectSelectToolPrototype();
EllipseSelectTool.prototype = Object.create(SelectTool.prototype);
installEllipseSelectToolPrototype();

