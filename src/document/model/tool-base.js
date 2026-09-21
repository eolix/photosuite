/**
 * The tool system: the base class every tool extends, and the id tables tools
 * are selected and routed by.
 *
 * `ToolBase` is the default tool lifecycle (activate, pointer input, cursors);
 * specialised bases (`SelectTool`, `PaintTool`, …) extend it in sibling tool
 * modules, each of which exports the tools it defines and chains their
 * prototypes onto the base it extends.
 */

import { Rect } from "../../core/math/rect.js";
import { Locale } from "../../core/i18n/locale.js";

import { EventType, UiCommand } from "../../core/event-bus.js";
import { AppEvent } from "../../core/event-bus.js";
import { formatDocLength } from "../../engine/compositing/geometry.js";

/**
 * Every tool the editor can activate. Tools are compared, registered and
 * selected by these constants; nothing resolves one from a string, and the
 * values never leave the session, so an id is only ever itself.
 *
 * The transform tools carry no toolbar widget; they are grouped in
 * {@link TRANSFORM_TOOL_IDS} rather than by a numeric range.
 */
export const ToolId = Object.freeze(Object.fromEntries(
  [
    "TOOL_MOVE", "TOOL_RECT_SELECT", "TOOL_ELLIPSE_SELECT", "TOOL_OBJECT_SELECT",
    "TOOL_LASSO_SELECT", "TOOL_POLYGON_LASSO", "TOOL_MAGNETIC_LASSO", "TOOL_QUICK_SELECT",
    "TOOL_MAGIC_WAND", "TOOL_CROP", "TOOL_PERSPECTIVE_CROP", "TOOL_SLICE", "TOOL_SLICE_SELECT",
    "TOOL_EYEDROPPER", "TOOL_RULER", "TOOL_SPOT_HEAL", "TOOL_HEAL_BRUSH", "TOOL_PATCH",
    "TOOL_CONTENT_AWARE_MOVE", "TOOL_RED_EYE", "TOOL_BRUSH", "TOOL_PENCIL", "TOOL_COLOR_REPLACEMENT",
    "TOOL_CLONE_STAMP", "TOOL_ERASER", "TOOL_BACKGROUND_ERASER", "TOOL_GRADIENT", "TOOL_PAINT_BUCKET",
    "TOOL_BLUR", "TOOL_SHARPEN", "TOOL_SMUDGE", "TOOL_DODGE", "TOOL_BURN", "TOOL_SPONGE",
    "TOOL_PEN", "TOOL_FREE_PEN", "TOOL_TYPE", "TOOL_PATH_SELECT", "TOOL_DIRECT_SELECT",
    "TOOL_RECT_SHAPE", "TOOL_ELLIPSE_SHAPE", "TOOL_PARAMETRIC_SHAPE", "TOOL_LINE_SHAPE",
    "TOOL_CUSTOM_SHAPE", "TOOL_HAND", "TOOL_ROTATE_VIEW", "TOOL_ZOOM", "TOOL_FREE_TRANSFORM",
    "TOOL_WARP", "TOOL_CONTENT_AWARE_SCALE", "TOOL_PUPPET_WARP",
  ].map((name) => [name, name]),
));

/** Transform tools have no persisted toolbar widget row. */
export const TRANSFORM_TOOL_IDS = new Set([
  ToolId.TOOL_FREE_TRANSFORM,
  ToolId.TOOL_WARP,
  ToolId.TOOL_CONTENT_AWARE_SCALE,
  ToolId.TOOL_PUPPET_WARP,
]);

/**
 * Routing channels for document events. An event's `routingChannel` is matched
 * against these to pick the tracker that handles it, and each id's value is its
 * own name (`EventChannel.EVENT_DOCUMENT === "EVENT_DOCUMENT"`).
 */
export const EventChannel = Object.freeze(Object.fromEntries(
  [
    "EVENT_ADJUSTMENT",
    "EVENT_ADJUSTMENT_LEGACY",
    "EVENT_HISTORY",
    "EVENT_DOCUMENT",
    "EVENT_PLUGIN",
    "EVENT_SMART_FILTER",
    "EVENT_FILTER_STACK",
  ].map((name) => [name, name]),
));

const TOOL_OVERLAY_WIDTH = 130;
const TOOL_OVERLAY_FONT_SIZE_PX = 14;
const TOOL_OVERLAY_LINE_HEIGHT = 17;
const TOOL_OVERLAY_VERTICAL_PADDING = 8;

export function ToolBase(name, id, iconId) {
  this.name = name;
  this.id = id;
  this.appDispatcher = null;
  if (iconId != null) this.iconId = iconId;
}

ToolBase.prototype.handleInput = function handleInput(event, dispatcher, doc, keyboard, appData) {};
ToolBase.prototype.enable = function enable(doc, dispatcher, appData, keyboard, pointerState, gestureOptions) {
  dispatcher.dispatch(createDefaultCursorOverlayEvent());
};
ToolBase.prototype.disable = function disable(doc, dispatcher, appData, keyboard, pointerState) {};
ToolBase.prototype.shouldSwitchToHandOnPointerDown = function shouldSwitchToHandOnPointerDown(doc, dispatcher, appData, keyboard, pointerState) {
  return false;
};
ToolBase.prototype.onMouseDown = function onMouseDown(doc, dispatcher, appData, keyboard, pointerState) {};
ToolBase.prototype.onRightMouseDown = function onRightMouseDown(doc, dispatcher, appData, keyboard, pointerState) {};
ToolBase.prototype.onMouseMove = function onMouseMove(doc, dispatcher, appData, keyboard, pointerState) {};
ToolBase.prototype.onMouseUp = function onMouseUp(doc, dispatcher, appData, keyboard, pointerState) {};
ToolBase.prototype.onRightMouseUp = function onRightMouseUp(doc, dispatcher, appData, keyboard, pointerState) {};
ToolBase.prototype.onKeyEvent = function onKeyEvent(doc, dispatcher, appData, keyboard) {};
ToolBase.prototype.onDocumentStateChange = function onDocumentStateChange(doc, dispatcher, appData, keyboard) {};
ToolBase.prototype.redo = function redo(historyData, doc) {};
ToolBase.prototype.undo = function undo(historyData, doc) {};
ToolBase.prototype.applyAction = function applyAction(actionPayload, dispatcher, doc, keyboard, appData) {};
ToolBase.prototype.onUpdate = function onUpdate(appData, popupType) {};
ToolBase.prototype.isModifierKey = function isModifierKey(keyCode, keyboard) {
  return false;
};
ToolBase.prototype.wantsInput = function wantsInput(pointerState, keyboard) {
  return false;
};
ToolBase.prototype.isActive = function isActive() {
  return false;
};
ToolBase.prototype.canActivateWithGesture = function canActivateWithGesture(doc, appData) {
  return true;
};
ToolBase.prototype.getCursorStyle = function getCursorStyle() {
  return null;
};
ToolBase.prototype.syncToolbarWidget = function syncToolbarWidget(widgetState, routingHint, dispatcher) {};
ToolBase.prototype.shouldFollowTabDrag = function shouldFollowTabDrag() {
  return false;
};
ToolBase.prototype.onTabDragStart = function onTabDragStart(doc, dispatcher, appData, keyboard) {};
ToolBase.prototype.track = function track(historyPayload) {
  const historyEvent = new AppEvent(EventType.historyGrouped, true);
  historyEvent.data = historyPayload;
  historyPayload.skipActionRecording = true;
  this.appDispatcher.dispatch(historyEvent);
};

ToolBase.drawDimensionOverlay = function drawDimensionOverlay(screenX, screenY, dimensionRect, doc, appData) {
  ToolBase.drawToolOverlay(screenX, screenY, buildDimensionOverlayLabels(dimensionRect, doc, appData), doc);
};

ToolBase.drawToolOverlay = function drawToolOverlay(screenX, screenY, labelLines, doc) {
  const overlayHeight = labelLines.length * TOOL_OVERLAY_LINE_HEIGHT + TOOL_OVERLAY_VERTICAL_PADDING;
  const overlayRect = new Rect(
    screenX,
    screenY - overlayHeight,
    TOOL_OVERLAY_WIDTH,
    overlayHeight,
  );
  const overlayCanvas = getOrCreateOverlayCanvas();
  overlayCanvas.width = TOOL_OVERLAY_WIDTH;
  overlayCanvas.height = overlayHeight;

  const ctx = overlayCanvas.getContext("2d");
  ctx.fillStyle = "rgba(0,0,1,1)";
  ctx.fillRect(0, 0, TOOL_OVERLAY_WIDTH, overlayHeight);
  ctx.font = TOOL_OVERLAY_FONT_SIZE_PX + "px monospace";
  ctx.fillStyle = "rgba(255,255,255,1)";
  for (let lineIdx = 0; lineIdx < labelLines.length; lineIdx++) {
    ctx.fillText(labelLines[lineIdx], 6, (lineIdx + 1) * TOOL_OVERLAY_LINE_HEIGHT);
  }
  doc.toolOverlayState.floatingBitmapOverlays = [
    [ctx.getImageData(0, 0, TOOL_OVERLAY_WIDTH, overlayHeight).data, overlayRect.clone()],
  ];
};

ToolBase.overlayCanvas = null;

function createDefaultCursorOverlayEvent() {
  const splashEvent = new AppEvent(EventType.uiDispatch, true);
  splashEvent.data = {
    dispatchKind: UiCommand.splashOptionsUpdate,
    cursorOverlayId: "default",
  };
  return splashEvent;
}

function buildDimensionOverlayLabels(dimensionRect, doc, appData) {
  return [
    Locale.get("properties.width").charAt(0) +
      ": " +
      formatDocLength(dimensionRect.width, doc.dpi, appData, doc.width, true),
    Locale.get("properties.height").charAt(0) +
      ": " +
      formatDocLength(dimensionRect.height, doc.dpi, appData, doc.height, true),
  ];
}

function getOrCreateOverlayCanvas() {
  if (ToolBase.overlayCanvas == null) {
    ToolBase.overlayCanvas = document.createElement("canvas");
  }
  return ToolBase.overlayCanvas;
}

function registerStringConstants(target, constantsByName) {
  for (const [name, value] of Object.entries(constantsByName)) {
    target[name] = value;
  }
}

// Brush-family tools that carry tool presets: their toolbar icon and the
// Photoshop FourCC tool class codes (PbTl/PcTl/ErTl) a preset descriptor uses to
// name the tool. Those codes are wire keys from action descriptors / .tpl presets.
export const TOOL_BRUSH_PRESET_MAP = Object.freeze({
  [ToolId.TOOL_BRUSH]: { iconPath: "tools/brush", actionClassIds: ["PbTl"] },
  [ToolId.TOOL_PENCIL]: { iconPath: "tools/pencil", actionClassIds: ["PcTl"] },
  [ToolId.TOOL_ERASER]: { iconPath: "tools/eraser", actionClassIds: ["ErTl"] },
});

/** The preset-carrying tool an action descriptor names, or null. */
export function findToolIdForActionClass(actionDescriptor) {
  let matchedToolId = null;
  for (const toolId in TOOL_BRUSH_PRESET_MAP) {
    if (TOOL_BRUSH_PRESET_MAP[toolId].actionClassIds.indexOf(actionDescriptor[1].classID) !== -1) {
      matchedToolId = toolId;
    }
  }
  return matchedToolId;
}

