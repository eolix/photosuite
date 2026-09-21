// Retouch tools: patch / clone / heal / blur family built on PaintTool.

import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";

import { Locale } from "../../core/i18n/locale.js";
import { BrushStroke } from "../../features/brush/brush-stroke.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { AppEvent } from "../../core/event-bus.js";
import { ToolId } from "../model/tool-base.js";
import { PaintTool } from "./paint-tools.js";
import { offsetSelectionRect } from "../model/layer-translate.js";
import { buildPolygonSelectionAction, buildSelectAllAction, resolveSelectionCombineMode } from "./selection-actions.js";
import { allocBuffer, extractChannel } from "../../engine/compositing/buffer-utils.js";
import { copyChannel, hitTestChannel } from "../../engine/compositing/pixel-ops.js";


function dispatchCursorOverlay(dispatcher, cursorOverlayId) {
  const cursorEvent = new AppEvent(EventType.uiDispatch, true);
  cursorEvent.data = {
    dispatchKind: UiCommand.splashOptionsUpdate,
    cursorOverlayId,
  };
  dispatcher.dispatch(cursorEvent);
}

/** Clip the document selection mask to the document bounds and replace it in place. */
function clipSelectionMaskToDocument(doc) {
  const fullDocRect = new Rect(0, 0, doc.width, doc.height);
  const selectionClip = fullDocRect.intersect(doc.selectionMask.rect);
  if (selectionClip.isEmpty()) return null;
  const selectionChannel = allocBuffer(selectionClip.area());
  copyChannel(doc.selectionMask.channel, doc.selectionMask.rect, selectionChannel, selectionClip);
  doc.selectionMask = {
    channel: selectionChannel,
    rect: selectionClip,
  };
  return selectionClip;
}

/**
 * Shared retouch stroke drag loop: zoom sync, optional right-drag brush sizing,
 * then continue + apply when a stroke is active.
 */
function advanceRetouchStroke(tool, doc, dispatcher, appData, keyboard, pointerState, options = {}) {
  tool.syncBrushScaleToZoom(doc, dispatcher, appData);
  if (tool.rightDragAnchor) tool.updateBrushSizeFromRightDrag(doc, appData, pointerState);
  if (tool.strokeData == null) {
    if (options.refreshHoverWhenIdle) {
      tool.refreshHoverCursor(doc, dispatcher, appData, keyboard, pointerState);
    }
    return;
  }
  if (!pointerState.isDown) return;
  if (options.requireCloneSource && tool.cloneSourcePoint == null) return;
  tool.continueStroke(doc, appData, keyboard, pointerState);
  tool.applyStroke(doc);
}

export function PatchToolBase(isContentAwareMove, useBarePaintToolBase) {
  if (useBarePaintToolBase) PaintTool.call(this);
  else if (isContentAwareMove) {
    PaintTool.call(
      this,
      "tools.contentAwareMoveTool",
      ToolId.TOOL_CONTENT_AWARE_MOVE,
      "tools/camove",
    );
  } else {
    PaintTool.call(this, "tools.patchTool", ToolId.TOOL_PATCH, "tools/patch");
  }
  this.patchPolygonLastPoint = null;
  this.patchPolygonOverlay = null;
  this.cloneOffset = null;
  this.healDragAnchor = null;
  this.healOffsetInSelection = new Point();
  this.healSelectionRectSnapshot = null;
  this.healMaskBuffer = null;
}

function installPatchToolBasePrototype() {
  PatchToolBase.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
    const docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
    if (doc.selectionMask && hitTestChannel(docPoint, doc.selectionMask.channel, doc.selectionMask.rect)) {
      if (!doc.ensureLayerEditableForTools()) return;
      const selectionClip = clipSelectionMaskToDocument(doc);
      if (selectionClip == null) return;
      this.capturePaintSourceBuffers(doc);
      this.bindSourceBuffersForStroke(doc);
      this.healDragAnchor = docPoint;
      this.healOffsetInSelection = new Point(
        docPoint.x - doc.selectionMask.rect.x,
        docPoint.y - doc.selectionMask.rect.y,
      );
      this.healMaskBuffer = allocBuffer(doc.selectionMask.rect.area() * 4);
      this.healMaskBuffer.fill(255);
      if (this.toolOptions.patch == 1) {
        const targetLayer = doc.layers[doc.selectedLayerIndices[0]];
        targetLayer.updatePixCache(doc, doc.selectionMask, true);
        if (targetLayer.pixCache == null) this.healDragAnchor = null;
      }
      this.healSelectionRectSnapshot = doc.selectionMask.rect.clone();
    } else {
      this.patchPolygonOverlay = {
        coords: [docPoint.x, docPoint.y],
        commands: ["M"],
      };
      this.patchPolygonLastPoint = docPoint;
    }
  };

  PatchToolBase.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
    const docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
    if (this.healDragAnchor) {
      if (this.toolOptions.patch == 1) {
        if (doc.activeChannels.length == 0) {
          const pixCache = doc.layers[doc.selectedLayerIndices[0]].pixCache;
          const selectionLeft = docPoint.x - this.healOffsetInSelection.x;
          const selectionTop = docPoint.y - this.healOffsetInSelection.y;
          offsetSelectionRect(
            doc,
            doc.selectedLayerIndices[0],
            Math.round(selectionLeft - pixCache.selectionRect.x),
            Math.round(selectionTop - pixCache.selectionRect.y),
          );
        }
      } else {
        this.compositeHealStrokeAtPointer(doc, docPoint, "clone");
      }
    }
    if (this.patchPolygonLastPoint) {
      this.patchPolygonOverlay.commands.push("L");
      this.patchPolygonOverlay.coords.push(docPoint.x, docPoint.y);
      this.patchPolygonLastPoint = docPoint;
      doc.toolOverlayState.overlayTransform = this.patchPolygonOverlay;
      doc.dirty = true;
    }
  };

  PatchToolBase.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
    const docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
    if (this.healDragAnchor) {
      let dirtyRect = doc.selectionMask.rect.clone();
      if (this.id == ToolId.TOOL_CONTENT_AWARE_MOVE) {
        const targetLayer = doc.layers[doc.selectedLayerIndices[0]];
        targetLayer.restoreFromPixCache(doc, targetLayer.pixCache);
        doc.selectionMask.rect = this.healSelectionRectSnapshot.clone();
        const selectionRgba = allocBuffer(doc.selectionMask.rect.area() * 4);
        extractChannel(doc.selectionMask.channel, selectionRgba, 3);
        this.compositeStrokeToLayer(doc, "sheal", selectionRgba, doc.selectionMask.rect, doc.selectionMask.rect);
        doc.selectionMask.rect = dirtyRect;
        dirtyRect = dirtyRect.union(this.healSelectionRectSnapshot);
      }
      this.compositeHealStrokeAtPointer(doc, docPoint, "heal");
      this.finish(doc, dirtyRect, null, null, true);
      doc.markDirty(dirtyRect);
      this.healDragAnchor = null;
    }
    if (this.patchPolygonLastPoint) {
      const combineMode = resolveSelectionCombineMode(
        this.toolOptions.setop,
        keyboard.isPressed(KeyboardHandler.Shift),
        keyboard.isPressed(KeyboardHandler.Alt),
      );
      const selectionEvent = new AppEvent(EventType.historyGrouped, true);
      if (this.patchPolygonOverlay.coords.length <= 4) {
        selectionEvent.data = buildSelectAllAction();
      } else {
        selectionEvent.data = buildPolygonSelectionAction(
          this.patchPolygonOverlay.coords,
          combineMode,
        );
      }
      dispatcher.dispatch(selectionEvent);
      this.patchPolygonLastPoint = null;
      doc.toolOverlayState.overlayTransform = null;
      doc.dirty = true;
    }
  };

  PatchToolBase.prototype.getCloneOffset = function() {
    return this.cloneOffset;
  };

  PatchToolBase.prototype.applyAction = function(actionPayload, dispatcher, doc, keyboard, appData) {
    PaintTool.prototype.applyAction.call(this, actionPayload, dispatcher, doc, keyboard, appData);
    this.updateCursor(appData, keyboard);
  };

  PatchToolBase.prototype.updateCursor = function(appData, keyboard) {
    let cursorStyle = "default";
    if (
      (keyboard != null && keyboard.isPressed(KeyboardHandler.Shift) && !keyboard.isPressed(KeyboardHandler.Alt)) ||
      this.toolOptions.setop == "union"
    ) {
      cursorStyle = "copy";
    }
    if (this.caller) dispatchCursorOverlay(this.caller, cursorStyle);
  };

  PatchToolBase.prototype.compositeHealStrokeAtPointer = function(doc, docPoint, compositeMode) {
    const cloneOffset = new Point(
      Math.round(this.healDragAnchor.x - docPoint.x),
      Math.round(this.healDragAnchor.y - docPoint.y),
    );
    if (this.toolOptions.patch == 1) cloneOffset.setXY(-cloneOffset.x, -cloneOffset.y);
    this.cloneOffset = cloneOffset;
    this.compositeStrokeToLayer(doc, compositeMode, this.healMaskBuffer, doc.selectionMask.rect, doc.selectionMask.rect);
    this.invalidatePaintDirtyRegion(doc, doc.selectionMask.rect);
  };
}

export function CloneStampTool(name, id, iconId) {
  PaintTool.call(
    this,
    name == "" ? null : name ? name : "tools.cloneTool",
    id ? id : ToolId.TOOL_CLONE_STAMP,
    iconId ? iconId : "tools/clone",
  );
  this.strokeCompositeMode = "clone";
  this.cloneSourcePoint = null;
  this.cloneOffset = null;
}

function installCloneStampToolPrototype() {
  CloneStampTool.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
    const toolOptions = this.toolOptions;
    const altSampleOptionActive = toolOptions.alt[0];
    if (keyboard.isPressed(KeyboardHandler.Alt) || keyboard.isPressed(KeyboardHandler.KeyK) || altSampleOptionActive) {
      this.cloneSourcePoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
      this.cloneOffset = null;
      if (altSampleOptionActive) {
        this.dispatchToolOptionUpdate({ alt: [false] }, dispatcher);
      }
      this.bindSourceBuffersForStroke(doc);
      this.updateCursor(appData, keyboard, doc, pointerState);
      return;
    }
    if (this.cloneSourcePoint == null) {
      alert(Locale.get("brushAndMessages.toolHints.cloneSource"));
      return;
    }
    this.updateCursor(appData, keyboard);
    this.beginStroke(doc, appData, keyboard, pointerState, this.toolOptions.flow);
    if (this.strokeData == null) return;
    this.cloneOffset = this.resolveCloneOffsetForPoint(
      doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y),
    );
    this.applyStroke(doc);
  };

  CloneStampTool.prototype.resolveCloneOffsetForPoint = function(docPoint) {
    let cloneOffset = this.cloneOffset;
    if (cloneOffset == null || !this.toolOptions.algnd) {
      cloneOffset = new Point(
        Math.round(docPoint.x - this.cloneSourcePoint.x),
        Math.round(docPoint.y - this.cloneSourcePoint.y),
      );
    }
    return cloneOffset;
  };

  CloneStampTool.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
    advanceRetouchStroke(this, doc, dispatcher, appData, keyboard, pointerState, {
      refreshHoverWhenIdle: true,
      requireCloneSource: true,
    });
  };

  CloneStampTool.prototype.getCloneOffset = function() {
    return this.cloneOffset;
  };
}

export function ContentAwareMoveTool() {
  PatchToolBase.call(this, true);
  this.toolOptions.patch = 1;
}

/**
 * Single-gesture stroke tools. They all share one behavior — begin a stroke on
 * mouse-down with a per-tool flow and brush mode, apply it, and run the shared
 * drag loop — so each is declared as data: only the label/id/icon, composite
 * mode, flow source, optional brush mode, and small option tweaks differ.
 *
 * The key is the constructor name the tool registers under; `toolId` is the id
 * it activates by.
 */
const STROKE_TOOL_SPECS = {
  SharpenTool: {
    label: "tools.sharpenTool",
    toolId: ToolId.TOOL_SHARPEN,
    icon: "tools/sharpen",
    compositeMode: "copy",
    strokeFlow: (tool) => tool.toolOptions.strn,
    strokeMode: (tool, keyboard) =>
      keyboard.isPressed(KeyboardHandler.Alt)
        ? BrushStroke.MODE_BLUR
        : tool.toolOptions.pdetail
          ? BrushStroke.MODE_SMUDGE
          : BrushStroke.MODE_SHARPEN,
  },
  SpotHealTool: {
    label: "tools.spotHealingBrushTool",
    toolId: ToolId.TOOL_SPOT_HEAL,
    icon: "tools/shbrush",
    compositeMode: "draw",
    initOptions: (toolOptions) => {
      toolOptions.Opct = 0.5;
    },
    strokeFlow: () => 1,
    bindSourceOnDown: true,
    healOnMouseUp: "sheal",
  },
  SmudgeTool: {
    label: "tools.smudgeTool",
    toolId: ToolId.TOOL_SMUDGE,
    icon: "tools/smudge",
    compositeMode: "copy",
    strokeFlow: (tool) => tool.toolOptions.strn,
    strokeMode: () => BrushStroke.MODE_PENCIL,
  },
  SpongeTool: {
    label: "tools.spongeTool",
    toolId: ToolId.TOOL_SPONGE,
    icon: "tools/sponge",
    compositeMode: "sponge",
    strokeFlow: (tool) => tool.toolOptions.flow,
  },
  BlurTool: {
    label: "tools.blurTool",
    toolId: ToolId.TOOL_BLUR,
    icon: "tools/blur",
    compositeMode: "copy",
    refreshHoverWhenIdle: true,
    strokeFlow: (tool) => tool.toolOptions.strn,
    strokeMode: (tool, keyboard) =>
      keyboard.isPressed(KeyboardHandler.Alt) ? BrushStroke.MODE_SMUDGE : BrushStroke.MODE_BLUR,
  },
  ColorReplacementTool: {
    label: "tools.colourReplacement",
    toolId: ToolId.TOOL_COLOR_REPLACEMENT,
    icon: "tools/crepl",
    compositeMode: "idraw",
    refreshHoverWhenIdle: true,
    forwardEyedropperOnAlt: true,
    initOptions: (toolOptions) => {
      toolOptions.bmode = "hue ";
    },
    strokeFlow: (tool) => tool.toolOptions.flow,
  },
  RedEyeTool: {
    label: "tools.redEyeTool",
    toolId: ToolId.TOOL_RED_EYE,
    icon: "tools/redeye",
    compositeMode: "redeye",
    refreshHoverWhenIdle: true,
    initOptions: (toolOptions) => {
      toolOptions.smode = 0;
    },
    strokeFlow: (tool) => tool.toolOptions.flow,
  },
  BurnTool: {
    label: "tools.burnTool",
    toolId: ToolId.TOOL_BURN,
    icon: "tools/burn",
    compositeMode: "burn",
    refreshHoverWhenIdle: true,
    strokeFlow: (tool) => tool.toolOptions.expo / Math.E,
  },
  DodgeTool: {
    label: "tools.dodgeTool",
    toolId: ToolId.TOOL_DODGE,
    icon: "tools/dodge",
    compositeMode: "dodge",
    refreshHoverWhenIdle: true,
    strokeFlow: (tool) => tool.toolOptions.expo / Math.PI,
  },
};

/**
 * Composite the finished stroke as a heal, invalidate, and run the base
 * mouse-up. Returns false when no stroke was active.
 */
function finishHealStroke(tool, doc, dispatcher, appData, keyboard, pointerState, healMode) {
  if (tool.strokeData == null) return false;
  tool.compositeStrokeToLayer(
    doc,
    healMode,
    tool.strokeData.getBuffer(),
    tool.strokeData.getSelectionRect(),
    tool.strokeData.getDirtyBounds(),
  );
  tool.invalidatePaintDirtyRegion(doc, tool.strokeData.getDirtyBounds());
  PaintTool.prototype.onMouseUp.call(tool, doc, dispatcher, appData, keyboard, pointerState);
  return true;
}

/** Apply a stroke-tool spec to a freshly constructed tool. */
function initStrokeTool(tool, spec) {
  PaintTool.call(tool, spec.label, spec.toolId, spec.icon);
  tool.strokeCompositeMode = spec.compositeMode;
  if (spec.initOptions) spec.initOptions(tool.toolOptions);
}

export function SharpenTool() {
  initStrokeTool(this, STROKE_TOOL_SPECS.SharpenTool);
}

export function SpotHealTool() {
  initStrokeTool(this, STROKE_TOOL_SPECS.SpotHealTool);
}

export function SmudgeTool() {
  initStrokeTool(this, STROKE_TOOL_SPECS.SmudgeTool);
}

export function SpongeTool() {
  initStrokeTool(this, STROKE_TOOL_SPECS.SpongeTool);
}

export function BlurTool() {
  initStrokeTool(this, STROKE_TOOL_SPECS.BlurTool);
}

export function ColorReplacementTool() {
  initStrokeTool(this, STROKE_TOOL_SPECS.ColorReplacementTool);
}

export function RedEyeTool() {
  initStrokeTool(this, STROKE_TOOL_SPECS.RedEyeTool);
}

export function BurnTool() {
  initStrokeTool(this, STROKE_TOOL_SPECS.BurnTool);
}

export function DodgeTool() {
  initStrokeTool(this, STROKE_TOOL_SPECS.DodgeTool);
}

/** Each stroke tool paired with the spec that drives it. */
const STROKE_TOOLS = {
  SharpenTool,
  SpotHealTool,
  SmudgeTool,
  SpongeTool,
  BlurTool,
  ColorReplacementTool,
  RedEyeTool,
  BurnTool,
  DodgeTool,
};

function installStrokeToolPrototype(ToolConstructor, spec) {
  ToolConstructor.prototype.onMouseDown = function(doc, dispatcher, appData, keyboard, pointerState) {
    if (spec.forwardEyedropperOnAlt && this.forwardEyedropperIfAlt(keyboard, dispatcher, pointerState)) return;
    this.beginStroke(
      doc,
      appData,
      keyboard,
      pointerState,
      spec.strokeFlow(this),
      spec.strokeMode ? spec.strokeMode(this, keyboard) : undefined,
    );
    if (this.strokeData == null) return;
    if (spec.bindSourceOnDown) this.bindSourceBuffersForStroke(doc);
    this.applyStroke(doc);
  };
  ToolConstructor.prototype.onMouseMove = function(doc, dispatcher, appData, keyboard, pointerState) {
    advanceRetouchStroke(
      this,
      doc,
      dispatcher,
      appData,
      keyboard,
      pointerState,
      spec.refreshHoverWhenIdle ? { refreshHoverWhenIdle: true } : {},
    );
  };
  if (spec.healOnMouseUp) {
    ToolConstructor.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
      finishHealStroke(this, doc, dispatcher, appData, keyboard, pointerState, spec.healOnMouseUp);
    };
  }
}

export function HealBrushTool() {
  CloneStampTool.call(this, "tools.healingBrushTool", ToolId.TOOL_HEAL_BRUSH, "tools/hbrush");
}

function installHealBrushToolPrototype() {
  HealBrushTool.prototype.onMouseUp = function(doc, dispatcher, appData, keyboard, pointerState) {
    if (!finishHealStroke(this, doc, dispatcher, appData, keyboard, pointerState, "heal")) return;
    if (!this.toolOptions.algnd) this.cloneOffset = null;
  };
}

// Chain each tool's prototype onto the base it extends. The bases are
// imported, so they are fully built by the time this runs.
PatchToolBase.prototype = Object.create(PaintTool.prototype);
installPatchToolBasePrototype();

CloneStampTool.prototype = Object.create(PaintTool.prototype);
installCloneStampToolPrototype();

ContentAwareMoveTool.prototype = Object.create(PatchToolBase.prototype);

for (const [specName, ToolConstructor] of Object.entries(STROKE_TOOLS)) {
  ToolConstructor.prototype = Object.create(PaintTool.prototype);
  installStrokeToolPrototype(ToolConstructor, STROKE_TOOL_SPECS[specName]);
}

HealBrushTool.prototype = Object.create(CloneStampTool.prototype);
installHealBrushToolPrototype();

