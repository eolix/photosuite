/**
 * View tools: ruler measure, zoom, eyedropper sample, hand pan, and rotate-view.
 */

import { Point, constrainEndpointToAxis } from "../../core/math/point.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";

import { InputHandler } from "../../ui/tool-options/input-handler.js";
import { PopupTypes } from "../../ui/config/popup-types.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { getDevicePixelRatio } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { ToolBase, ToolId } from "../model/tool-base.js";


function dispatchCursorOverlay(dispatcher, cursorOverlayId) {
  const cursorEvent = new AppEvent(EventType.uiDispatch, true);
  cursorEvent.data = {
    dispatchKind: UiCommand.splashOptionsUpdate,
    cursorOverlayId,
  };
  dispatcher.dispatch(cursorEvent);
}

function dispatchUiPayload(dispatcher, data) {
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = data;
  dispatcher.dispatch(uiEvent);
}

function pinchSpan(touchPair) {
  const deltaX = touchPair[0].x - touchPair[1].x;
  const deltaY = touchPair[0].y - touchPair[1].y;
  return Math.sqrt(deltaX * deltaX + deltaY * deltaY);
}

function pinchCenter(touchPair) {
  return new Point((touchPair[0].x + touchPair[1].x) / 2, (touchPair[0].y + touchPair[1].y) / 2);
}

/** Snap a continuous pinch scale onto the nearest ZOOM_STEPS entry for <1×. */
/** Rounded centre of the visible viewport, used as a default zoom pivot. */
function viewportCenterPoint(viewport) {
  return new Point(
    Math.round(viewport.viewportRect.width / 2),
    Math.round(viewport.viewportRect.height / 2),
  );
}

function snapPinchScaleToZoomStep(targetScale) {
  if (targetScale >= 1) return Math.min(32, Math.round(targetScale));
  let bestStepIndex = 0;
  let bestDelta = 1e9;
  const zoomSteps = ZoomTool.ZOOM_STEPS;
  for (let stepIdx = 0; stepIdx < zoomSteps.length; stepIdx++) {
    const stepDelta = Math.abs(1 - targetScale / zoomSteps[stepIdx]);
    if (stepDelta < bestDelta) {
      bestDelta = stepDelta;
      bestStepIndex = stepIdx;
    }
  }
  return zoomSteps[bestStepIndex];
}

export function RulerTool() {
  ToolBase.call(this, "tools.ruler", ToolId.TOOL_RULER, "tools/ruler");
  this.rulerEndpoints = null;
  this.dragHandleIndices = null;
  this.dragGrabPoint = null;
  this.rulerEndpointsAtDragStart = null;
}

function installRulerToolPrototype() {
  RulerTool.prototype.wantsInput = function(pointerState) {
    return pointerState.isDown;
  };

  RulerTool.prototype.disable = function(doc, dispatcher, appData, keyboard) {
    this.rulerEndpoints = this.dragHandleIndices = null;
    if (doc) this.refreshRulerOverlay(doc);
  };

  RulerTool.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
    const viewScale = doc.pathViewport.zoomScale / getDevicePixelRatio();
    const docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
    docPoint.x = Math.round(docPoint.x);
    docPoint.y = Math.round(docPoint.y);
    const endpoints = this.rulerEndpoints;
    if (endpoints && Point.dist(docPoint, endpoints[0]) * viewScale < 6) {
      this.dragHandleIndices = [0];
    } else if (endpoints && Point.dist(docPoint, endpoints[1]) * viewScale < 6) {
      this.dragHandleIndices = [1];
    } else if (
      endpoints &&
      RulerTool.pointToSegmentDistance(endpoints[0], endpoints[1], docPoint) * viewScale < 6 &&
      Math.min(endpoints[0].x, endpoints[1].x) - 5 <= docPoint.x &&
      docPoint.x <= Math.max(endpoints[0].x, endpoints[1].x) + 5 &&
      Math.min(endpoints[0].y, endpoints[1].y) - 5 <= docPoint.y &&
      docPoint.y <= Math.max(endpoints[0].y, endpoints[1].y) + 5
    ) {
      this.dragHandleIndices = [0, 1];
      this.rulerEndpointsAtDragStart = [endpoints[0].clone(), endpoints[1].clone()];
      this.dragGrabPoint = docPoint;
    } else {
      this.rulerEndpoints = [docPoint.clone(), docPoint.clone()];
      this.dragHandleIndices = [1];
    }
  };

  RulerTool.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
    if (this.dragHandleIndices == null) return;
    const endpoints = this.rulerEndpoints;
    const draggedHandles = this.dragHandleIndices;
    const docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
    docPoint.x = Math.round(docPoint.x);
    docPoint.y = Math.round(docPoint.y);
    if (draggedHandles.length == 2) {
      const deltaX = docPoint.x - this.dragGrabPoint.x;
      const deltaY = docPoint.y - this.dragGrabPoint.y;
      endpoints[0] = this.rulerEndpointsAtDragStart[0].clone();
      endpoints[0].offset(deltaX, deltaY);
      endpoints[1] = this.rulerEndpointsAtDragStart[1].clone();
      endpoints[1].offset(deltaX, deltaY);
    } else {
      endpoints[draggedHandles[0]].setXY(docPoint.x, docPoint.y);
      if (keyboard.isPressed(KeyboardHandler.Shift)) {
        endpoints[draggedHandles[0]] = constrainEndpointToAxis(
          endpoints[1 - draggedHandles[0]],
          endpoints[draggedHandles[0]],
        );
      }
    }
    this.refreshRulerOverlay(doc);
    this.emitEvent(dispatcher, EventType.uiDispatch, {
      dispatchKind: UiCommand.forwardActiveToolGesture,
      routingChannel: this.id,
      rulerStart: endpoints[0],
      rulerEnd: endpoints[1],
      dpi: doc.dpi,
      referenceDocWidth: doc.width,
    });
  };

  RulerTool.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
    this.dragHandleIndices = null;
  };

  RulerTool.prototype.emitEvent = function(dispatcher, eventType, eventData) {
    const uiEvent = new AppEvent(eventType, true);
    uiEvent.data = eventData;
    dispatcher.dispatch(uiEvent);
  };

  RulerTool.prototype.refreshRulerOverlay = function(doc) {
    const endpoints = this.rulerEndpoints;
    if (endpoints == null) {
      doc.toolOverlayState.overlayTransform = null;
      doc.toolOverlayState.squareMarkerCoords = [];
    } else {
      const overlayCoords = [endpoints[0].x, endpoints[0].y, endpoints[1].x, endpoints[1].y];
      doc.toolOverlayState.overlayTransform = {
        commands: ["M", "L"],
        coords: overlayCoords,
      };
      doc.toolOverlayState.squareMarkerCoords = overlayCoords;
    }
    doc.dirty = true;
  };
}

RulerTool.pointToSegmentDistance = function(segmentStart, segmentEnd, point) {
  const deltaX = segmentEnd.x - segmentStart.x;
  const deltaY = segmentEnd.y - segmentStart.y;
  const crossProduct = Math.abs(
    deltaY * point.x - deltaX * point.y + segmentEnd.x * segmentStart.y - segmentEnd.y * segmentStart.x,
  );
  const segmentLength = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  return crossProduct / segmentLength;
};

export function ZoomTool() {
  ToolBase.call(this, "tools.zoomTool", ToolId.TOOL_ZOOM, "tools/zoom");
  this.invert = false;
  this.zoomInOnGesture = true;
  this.lastEnableTimeMs = 0;
  this.pinchGestureState = null;
  this.dragStartScreenPoint = null;
  this.scaleAtDragStart = 0;
  this.scrollOriginAtDragStart = null;
  this.scrollWheelAccumulator = 0;
  this.zoomMenuHandler = new InputHandler(
    [
      { name: "view.zoomIn", shortcut: "Ctrl + +" },
      { name: "view.zoomOut", shortcut: "Ctrl + -", separatorAfter: true },
      { name: "align.fitTheArea", shortcut: "Ctrl + 0" },
      { name: ["VAR0: 100%", "align.pixelToPixel"], shortcut: "Ctrl + 1" },
    ],
    [
      {
        appEventType: EventType.documentAction,
        documentModelType: ToolId.TOOL_ZOOM,
        payload: { actionKind: "zoom", zoomInOnGesture: true },
      },
      {
        appEventType: EventType.documentAction,
        documentModelType: ToolId.TOOL_ZOOM,
        payload: { actionKind: "zoom", zoomInOnGesture: false },
      },
      {
        appEventType: EventType.documentAction,
        documentModelType: ToolId.TOOL_ZOOM,
        payload: { actionKind: "adapt", adaptTarget: "fitscr" },
      },
      {
        appEventType: EventType.documentAction,
        documentModelType: ToolId.TOOL_ZOOM,
        payload: { actionKind: "adapt", adaptTarget: "pixel" },
      },
    ],
  );
}

function installZoomToolPrototype() {
  ZoomTool.prototype.onRightMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
    const zoomMenu = this.zoomMenuHandler;
    zoomMenu.buildUI();
    zoomMenu.parent = dispatcher;
    zoomMenu.update(doc, appData);
    dispatchUiPayload(dispatcher, {
      dispatchKind: UiCommand.showFloatingOverlay,
      overlayWidget: zoomMenu,
      x: pointerState.screenX + 2,
      y: pointerState.screenY + 1,
    });
  };

  ZoomTool.prototype.enable = function(doc, dispatcher, appData, keyboard) {
    this.updateZoomCursor(dispatcher, keyboard);
    if (doc && Date.now() - this.lastEnableTimeMs < 300) {
      this.handleInput({ actionKind: "adapt", adaptTarget: "pixel" }, dispatcher, doc, keyboard, appData);
    }
    this.lastEnableTimeMs = Date.now();
  };

  ZoomTool.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
    this.dragStartScreenPoint = new Point(pointerState.x, pointerState.y);
    this.scaleAtDragStart = doc.pathViewport.zoomScale;
    this.scrollOriginAtDragStart = doc.pathViewport.panOffset.clone();
  };

  ZoomTool.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
    if (this.dragStartScreenPoint == null) return;
    let targetScale = Math.exp(Math.log(this.scaleAtDragStart) + (pointerState.x - this.dragStartScreenPoint.x) / 64);
    targetScale = Math.max(0.02, Math.min(32, targetScale));
    doc.pathViewport.zoomScale = this.scaleAtDragStart;
    doc.pathViewport.panOffset = this.scrollOriginAtDragStart.clone();
    this.handleInput(
      {
        actionKind: "zoom",
        targetScale,
        pointerState: this.dragStartScreenPoint,
      },
      dispatcher,
      doc,
      keyboard,
      appData,
    );
  };

  ZoomTool.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
    if (Point.dist(this.dragStartScreenPoint, pointerState) < 4) {
      const zoomIn = this.resolveZoomInFromModifiers(keyboard);
      this.handleInput(
        {
          actionKind: "zoom",
          zoomInOnGesture: zoomIn,
          pointerState,
        },
        dispatcher,
        doc,
        keyboard,
        appData,
      );
    }
    this.dragStartScreenPoint = null;
  };

  /**
   * Route a zoom/view event to its handler. A "pzoom" dialog result is
   * normalized to a "zoom" at the chosen percentage before dispatch.
   */
  ZoomTool.prototype.handleInput = function(event, dispatcher, doc, keyboard, appData) {
    if (event.actionKind == "pzoom") {
      if (typeof event.dialogResult == "string") return;
      event = { actionKind: "zoom", targetScale: event.dialogResult / 100 };
    }
    if (event.actionKind == "adapt") this.zoomToFit(doc, event.adaptTarget);
    else if (event.actionKind.startsWith("multi")) this.applyPinchZoom(doc, event);
    else if (event.actionKind == "scroll") this.applyScrollWheelZoom(doc, event);
    else if (event.actionKind == "zoom") this.applyPointZoom(doc, event);
    else if (event.actionKind == "mskView") this.setMaskViewMode(doc, event);
  };

  /** Fit the whole document ("fitscr") or reset to 100% ("pixel"). */
  ZoomTool.prototype.zoomToFit = function(doc, adaptTarget) {
    const viewport = doc.pathViewport;
    let fitScale = 0;
    if (adaptTarget == "pixel") fitScale = 1;
    if (adaptTarget == "fitscr") {
      fitScale = Math.min(
        (viewport.viewportRect.width - 14) / doc.width,
        (viewport.viewportRect.height - 14) / doc.height,
      );
    }
    ZoomTool.setDocumentZoom(viewport, viewportCenterPoint(viewport), false, fitScale);
    doc.panelsDirty = true;
  };

  /** Two-finger pinch: capture on multidown, scale + pan-track otherwise. */
  ZoomTool.prototype.applyPinchZoom = function(doc, event) {
    const viewport = doc.pathViewport;
    const touchPair = event.touchPoints;
    const pinchMidpoint = pinchCenter(touchPair);
    if (event.actionKind == "multidown") {
      this.pinchGestureState = [
        touchPair,
        viewport.zoomScale,
        viewport.screenToDocPoint(pinchMidpoint.x, pinchMidpoint.y),
      ];
      return;
    }
    let targetScale = this.pinchGestureState[1] * pinchSpan(touchPair) / pinchSpan(this.pinchGestureState[0]);
    targetScale = snapPinchScaleToZoomStep(targetScale);
    if (targetScale != viewport.zoomScale) {
      ZoomTool.setDocumentZoom(viewport, pinchMidpoint, false, targetScale);
    }
    const anchorDocPoint = this.pinchGestureState[2];
    const anchorScreenPoint = viewport.docToScreenPoint(anchorDocPoint.x, anchorDocPoint.y);
    const scrollOrigin = viewport.panOffset;
    scrollOrigin.x = Math.round(scrollOrigin.x + pinchMidpoint.x - anchorScreenPoint.x);
    scrollOrigin.y = Math.round(scrollOrigin.y + pinchMidpoint.y - anchorScreenPoint.y);
    doc.panelsDirty = true;
  };

  /** Trackpad/wheel zoom: step in or out once the accumulator crosses ±14. */
  ZoomTool.prototype.applyScrollWheelZoom = function(doc, event) {
    this.scrollWheelAccumulator += event.scrollDelta.y;
    const wheelThreshold = 14;
    let zoomIn;
    if (this.scrollWheelAccumulator < -wheelThreshold) {
      zoomIn = true;
      this.scrollWheelAccumulator = Math.max(this.scrollWheelAccumulator + wheelThreshold, -(wheelThreshold - 1));
    } else if (this.scrollWheelAccumulator > wheelThreshold) {
      zoomIn = false;
      this.scrollWheelAccumulator = Math.min(this.scrollWheelAccumulator - wheelThreshold, wheelThreshold - 1);
    } else {
      return;
    }
    ZoomTool.setDocumentZoom(doc.pathViewport, event.pointerState, zoomIn, 0);
    doc.panelsDirty = true;
  };

  /** Click / drag / menu zoom at a pivot: explicit scale, or step by direction. */
  ZoomTool.prototype.applyPointZoom = function(doc, event) {
    const viewport = doc.pathViewport;
    const zoomPivot = event.pointerState ? event.pointerState : viewportCenterPoint(viewport);
    let targetScale = 0;
    let zoomIn = false;
    if (event.targetScale != null) targetScale = event.targetScale;
    else zoomIn = event.zoomInOnGesture;
    ZoomTool.setDocumentZoom(viewport, zoomPivot, zoomIn, targetScale);
    doc.panelsDirty = true;
  };

  /** Mask viewing: 0 hides the mask, 1 shows it over RGB, 2 shows mask only. */
  ZoomTool.prototype.setMaskViewMode = function(doc, event) {
    const activeLayer = doc.layers[doc.selectedLayerIndices[0]];
    const maskTarget = activeLayer.pixelContent == 3
      ? activeLayer.getLinkedPlacedItem(doc).d
      : activeLayer.getMask();
    doc.pathViewport.channelVisibility = event.maskViewMode == 2 ? [0, 0, 0] : [1, 1, 1];
    maskTarget.active = event.maskViewMode != 0;
    for (let channelIdx = 0; channelIdx < doc.extraChannels.length; channelIdx++) {
      doc.extraChannels[channelIdx].active = false;
    }
    doc.activeChannels = [];
    doc.dirty = true;
  };

  ZoomTool.prototype.onKeyEvent = function(doc, dispatcher, appData, keyboard) {
    if (this.invert != keyboard.isPressed(KeyboardHandler.Alt)) {
      this.invert = keyboard.isPressed(KeyboardHandler.Alt);
      dispatchUiPayload(dispatcher, {
        dispatchKind: UiCommand.forwardActiveToolGesture,
        routingChannel: this.id,
        invert: this.invert,
      });
      this.updateZoomCursor(dispatcher, keyboard);
    }
  };

  ZoomTool.prototype.updateZoomCursor = function(dispatcher, keyboard) {
    const zoomIn = this.resolveZoomInFromModifiers(keyboard);
    dispatchCursorOverlay(dispatcher, zoomIn ? "zoom-in" : "zoom-out");
  };

  ZoomTool.prototype.applyAction = function(actionPayload, dispatcher, doc, keyboard) {
    this.zoomInOnGesture = actionPayload.zoomInOnGesture;
    this.updateZoomCursor(dispatcher, keyboard);
  };

  ZoomTool.prototype.resolveZoomInFromModifiers = function(keyboard) {
    let zoomIn = this.zoomInOnGesture;
    if (keyboard.isPressed(KeyboardHandler.Space) && keyboard.isPressed(KeyboardHandler.Ctrl)) zoomIn = true;
    if (this.invert) zoomIn = !zoomIn;
    return zoomIn;
  };
}

ZoomTool.ZOOM_STEPS = [
  32, 16, 12, 8, 6, 5, 4, 3, 2, 1, 2 / 3, 1 / 2, 1 / 2 * (2 / 3), 1 / 4, 1 / 4 * (2 / 3),
  1 / 8, 1 / 8 * (2 / 3), 1 / 16, 1 / 16 * (2 / 3), 1 / 32, 1 / 32 * (2 / 3), 1 / 64,
];

ZoomTool.fitZoomToBounds = function(docWidth, docHeight, viewWidth, viewHeight) {
  let scale = 1;
  while (docWidth * scale * 1 / 2 > viewWidth || docHeight * scale * 1 / 2 > viewHeight) scale *= 1 / 2;
  if (docWidth * scale * 2 / 3 > viewWidth || docHeight * scale * 2 / 3 > viewHeight) scale *= 1 / 2;
  else if (docWidth * scale > viewWidth || docHeight * scale > viewHeight) scale *= 2 / 3;
  return scale;
};

ZoomTool.stepZoomLevel = function(currentScale, zoomIn) {
  const stepIndex = ZoomTool.findZoomStepIndex(currentScale);
  if (zoomIn && stepIndex == 0) return currentScale;
  if (!zoomIn && stepIndex == ZoomTool.ZOOM_STEPS.length - 1) return currentScale;
  return ZoomTool.ZOOM_STEPS[zoomIn ? stepIndex - 1 : stepIndex + 1];
};

ZoomTool.findZoomStepIndex = function(currentScale) {
  let stepIndex = 0;
  while (ZoomTool.ZOOM_STEPS[stepIndex] > currentScale) stepIndex++;
  return stepIndex;
};

ZoomTool.setDocumentZoom = function(viewState, screenPoint, zoomIn, targetScale) {
  const documentBounds = viewState.documentBounds;
  if (targetScale == 0 || targetScale == null) {
    targetScale = ZoomTool.stepZoomLevel(viewState.zoomScale, zoomIn);
    if (targetScale == viewState.zoomScale) return;
  }
  const docPoint = viewState.screenToDocPoint(screenPoint.x, screenPoint.y);
  if (documentBounds.width * targetScale <= viewState.viewportRect.width &&
      documentBounds.height * targetScale <= viewState.viewportRect.height) {
    viewState.panOffset.setXY(0, 0);
    viewState.zoomScale = targetScale;
  } else {
    const viewMatrix = viewState.getViewMatrix();
    const scaleRatio = viewState.zoomScale / targetScale;
    viewMatrix.translate(-docPoint.x, -docPoint.y);
    viewMatrix.scale(scaleRatio, scaleRatio);
    viewMatrix.translate(docPoint.x, docPoint.y);
    viewState.applyViewMatrixFromTransform(viewMatrix);
  }
};

ZoomTool.bindZoomKeyboardShortcuts = function(keyboard, shortcutPayload) {
  if (keyboard.isPressed(KeyboardHandler.Plus) || keyboard.isPressed(KeyboardHandler.Equal)) {
    shortcutPayload.routingChannel = ToolId.TOOL_ZOOM;
    shortcutPayload.data = {
      actionKind: "zoom",
      zoomInOnGesture: true,
    };
  }
  if (keyboard.isPressed(KeyboardHandler.Minus)) {
    shortcutPayload.routingChannel = ToolId.TOOL_ZOOM;
    shortcutPayload.data = {
      actionKind: "zoom",
      zoomInOnGesture: false,
    };
  }
  if (keyboard.isPressed(KeyboardHandler.Digit0)) {
    shortcutPayload.routingChannel = ToolId.TOOL_ZOOM;
    shortcutPayload.data = {
      actionKind: "adapt",
      adaptTarget: "fitscr",
    };
  }
  if (keyboard.isPressed(KeyboardHandler.Digit1)) {
    shortcutPayload.routingChannel = ToolId.TOOL_ZOOM;
    shortcutPayload.data = {
      actionKind: "adapt",
      adaptTarget: "pixel",
    };
  }
};

export function EyedropperTool() {
  ToolBase.call(this, "tools.eyedropper", ToolId.TOOL_EYEDROPPER, "tools/eyedropper");
  this.isSampleDragActive = false;
  this.sampleSizePixels = 1;
}

function installEyedropperToolPrototype() {
  EyedropperTool.prototype.enable = function(doc, dispatcher, appData, keyboard) {
    dispatchCursorOverlay(dispatcher, "crosshair");
  };

  EyedropperTool.prototype.wantsInput = function(pointerState) {
    return pointerState.isDown;
  };

  EyedropperTool.prototype.handleInput = function(event, dispatcher, doc, keyboard, appData) {
    if (event.actionKind == "pickhere") {
      this.dispatchSampledColor(doc, dispatcher, appData, keyboard, event.pointerState);
    }
  };

  EyedropperTool.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
    this.isSampleDragActive = true;
    this.dispatchSampledColor(doc, dispatcher, appData, keyboard, pointerState);
  };

  EyedropperTool.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
    if (this.isSampleDragActive) {
      this.dispatchSampledColor(doc, dispatcher, appData, keyboard, pointerState);
    }
  };

  EyedropperTool.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
    this.isSampleDragActive = false;
  };

  EyedropperTool.prototype.dispatchSampledColor = function(doc, dispatcher, appData, keyboard, pointerState) {
    const sampledColorRgb = EyedropperTool.sampleCompositeColor(doc, pointerState, this.sampleSizePixels);
    const colorChangeEvent = new AppEvent(EventType.uiDispatch);
    colorChangeEvent.data = {
      dispatchKind: UiCommand.openResourcePresetPopup,
      popupType: PopupTypes.COLOR_CHANGE,
      operation: 0,
      value: sampledColorRgb,
    };
    dispatcher.dispatch(colorChangeEvent);
  };

  EyedropperTool.prototype.applyAction = function(actionPayload) {
    this.sampleSizePixels = actionPayload.sampleSizePixels;
  };
}

EyedropperTool.sampleCompositeColor = function(doc, pointerState, sampleSizePixels) {
  const docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
  const centerX = Math.floor(docPoint.x);
  const centerY = Math.floor(docPoint.y);
  const sampleRadius = (sampleSizePixels - 1) / 2;
  const minX = Math.max(0, centerX - sampleRadius);
  const minY = Math.max(0, centerY - sampleRadius);
  const maxX = Math.min(doc.width, centerX + sampleRadius + 1);
  const maxY = Math.min(doc.height, centerY + sampleRadius + 1);
  const pixelCount = (maxX - minX) * (maxY - minY);
  const rasterData = doc.getRasterData();
  let sumRed = 0;
  let sumGreen = 0;
  let sumBlue = 0;
  for (let pixelX = minX; pixelX < maxX; pixelX++) {
    for (let pixelY = minY; pixelY < maxY; pixelY++) {
      const pixelOffset = 4 * (pixelY * doc.width + pixelX);
      sumRed += rasterData[pixelOffset];
      sumGreen += rasterData[pixelOffset + 1];
      sumBlue += rasterData[pixelOffset + 2];
    }
  }
  sumRed = Math.round(sumRed / pixelCount);
  sumGreen = Math.round(sumGreen / pixelCount);
  sumBlue = Math.round(sumBlue / pixelCount);
  return sumRed << 16 | sumGreen << 8 | sumBlue;
};

export function HandTool() {
  ToolBase.call(this, "tools.handTool", ToolId.TOOL_HAND, "tools/hand");
  this.dragStartScreenPoint = new Point(0, 0);
  this.scrollOriginAtDragStart = null;
}

function installHandToolPrototype() {
  HandTool.prototype.handleInput = function(event, dispatcher, doc, keyboard, resampleMode) {
    const eventKind = event.actionKind;
    if (eventKind == "setcls") {
      doc.pathViewport.channelVisibility = event.channelVisibility;
      doc.dirty = true;
      doc.panelsDirty = true;
    }
    // Whether a wheel gesture scrolls or zooms is settled by the router in
    // app-controller before it is dispatched — including the Alt case, which
    // "Zoom with Scroll Wheel" flips — so a scroll that arrives here pans.
    if (eventKind == "scroll") {
      if (keyboard.isPressed(KeyboardHandler.Ctrl)) {
        HandTool.setViewScrollOrigin(
          doc,
          doc.pathViewport.panOffset.x - event.scrollDelta.y,
          doc.pathViewport.panOffset.y - event.scrollDelta.x,
        );
      } else {
        HandTool.setViewScrollOrigin(
          doc,
          doc.pathViewport.panOffset.x - event.scrollDelta.x,
          doc.pathViewport.panOffset.y - event.scrollDelta.y,
        );
      }
    }
  };

  HandTool.prototype.enable = function(doc, dispatcher, appData, keyboard) {
    this.scrollOriginAtDragStart = null;
    dispatchCursorOverlay(dispatcher, "grab");
  };

  HandTool.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
    this.scrollOriginAtDragStart = doc.pathViewport.panOffset.clone();
    this.dragStartScreenPoint.setXY(pointerState.x, pointerState.y);
  };

  HandTool.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
    if (!pointerState.isDown) return;
    if (this.scrollOriginAtDragStart == null) {
      this.onMouseDown(doc, dispatcher, appData, keyboard, pointerState);
    }
    HandTool.setViewScrollOrigin(
      doc,
      this.scrollOriginAtDragStart.x + (pointerState.x - this.dragStartScreenPoint.x),
      this.scrollOriginAtDragStart.y + (pointerState.y - this.dragStartScreenPoint.y),
    );
  };

  HandTool.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
    this.scrollOriginAtDragStart = null;
  };
}

HandTool.setViewScrollOrigin = function(doc, scrollX, scrollY) {
  const zoomScale = doc.pathViewport.zoomScale;
  if (doc.width * zoomScale < doc.pathViewport.viewportRect.width &&
      doc.height * zoomScale < doc.pathViewport.viewportRect.height) {
    doc.pathViewport.panOffset.setXY(0, 0);
  } else {
    doc.pathViewport.panOffset.x = scrollX;
    doc.pathViewport.panOffset.y = scrollY;
  }
  doc.panelsDirty = true;
};

export function RotateViewTool() {
  ToolBase.call(this, "tools.rotateView", ToolId.TOOL_ROTATE_VIEW, "tools/rview");
  this.dragStartScreenPoint = new Point(0, 0);
  this.rotationPivotDoc = null;
  this.viewMatrixAtDragStart = null;
}

function installRotateViewToolPrototype() {
  RotateViewTool.prototype.enable = function(doc, dispatcher, appData, keyboard) {
    dispatchCursorOverlay(dispatcher, "grab");
    if (doc) this.emitRotationChanged(doc, dispatcher);
  };

  RotateViewTool.prototype.disable = function(doc, dispatcher, appData, keyboard, resampleMode) {
    if (doc) this.emitRotationChanged(doc, dispatcher);
  };

  RotateViewTool.prototype.onTabDragStart = function(doc, dispatcher, appData, keyboard) {
    if (doc) this.emitRotationChanged(doc, dispatcher);
  };

  RotateViewTool.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
    this.dragStartScreenPoint.setXY(pointerState.x, pointerState.y);
    const viewport = doc.pathViewport;
    this.rotationPivotDoc = viewport.screenToDocPoint(
      viewport.viewportRect.width / 2,
      viewport.viewportRect.height / 2,
    );
    this.viewMatrixAtDragStart = viewport.getViewMatrix();
  };

  RotateViewTool.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
    if (!pointerState.isDown) return;
    const viewport = doc.pathViewport;
    const rotationPivotDoc = this.rotationPivotDoc;
    const dragStartScreenPoint = this.dragStartScreenPoint;
    const screenCenter = new Point(viewport.viewportRect.width / 2, viewport.viewportRect.height / 2);
    const pointerAngle = Math.atan2(pointerState.y - screenCenter.y, pointerState.x - screenCenter.x);
    const dragStartAngle = Math.atan2(
      dragStartScreenPoint.y - screenCenter.y,
      dragStartScreenPoint.x - screenCenter.x,
    );
    this.applyViewRotation(
      doc,
      dispatcher,
      this.viewMatrixAtDragStart.clone(),
      rotationPivotDoc,
      pointerAngle - dragStartAngle,
    );
  };

  RotateViewTool.prototype.applyAction = function(actionPayload, dispatcher, doc, keyboard) {
    this.applyViewRotation(
      doc,
      dispatcher,
      null,
      null,
      actionPayload.rotationRadians - doc.pathViewport.rotationRadians,
    );
    doc.pathViewport.rotationRadians = actionPayload.rotationRadians;
  };

  RotateViewTool.prototype.applyViewRotation = function(doc, dispatcher, viewMatrix, rotationPivotDoc, rotationDelta) {
    const viewport = doc.pathViewport;
    if (viewMatrix == null) viewMatrix = viewport.getViewMatrix();
    if (rotationPivotDoc == null) {
      rotationPivotDoc = viewport.screenToDocPoint(
        viewport.viewportRect.width / 2,
        viewport.viewportRect.height / 2,
      );
    }
    viewMatrix.translate(-rotationPivotDoc.x, -rotationPivotDoc.y);
    viewMatrix.rotate(rotationDelta);
    viewMatrix.translate(rotationPivotDoc.x, rotationPivotDoc.y);
    viewport.applyViewMatrixFromTransform(viewMatrix);
    if (doc.width * viewport.zoomScale < viewport.viewportRect.width &&
        doc.height * viewport.zoomScale < viewport.viewportRect.height) {
      viewport.panOffset.setXY(0, 0);
    }
    doc.dirty = true;
    this.emitRotationChanged(doc, dispatcher);
  };

  RotateViewTool.prototype.emitRotationChanged = function(doc, dispatcher) {
    dispatchUiPayload(dispatcher, {
      dispatchKind: UiCommand.forwardActiveToolGesture,
      routingChannel: this.id,
      rotationRadians: doc.pathViewport.rotationRadians,
    });
  };
}

// Chain each tool's prototype onto the base it extends. The bases are
// imported, so they are fully built by the time this runs.
RulerTool.prototype = Object.create(ToolBase.prototype);
installRulerToolPrototype();

ZoomTool.prototype = Object.create(ToolBase.prototype);
installZoomToolPrototype();

EyedropperTool.prototype = Object.create(ToolBase.prototype);
installEyedropperToolPrototype();

HandTool.prototype = Object.create(ToolBase.prototype);
installHandToolPrototype();

RotateViewTool.prototype = Object.create(ToolBase.prototype);
installRotateViewToolPrototype();

