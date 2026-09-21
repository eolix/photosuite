/**
 * Transform tool registration: live preview on TransformToolBase, concrete transform
 * tools (free transform, warp, content-aware scale), object selection, and wiring
 * for puppet-warp and slice tool modules.
 */

import { Rect } from "../../core/math/rect.js";
import { installPuppetWarpTool } from "./puppet-warp-tool.js";
import { installSliceTools } from "./slice-tools.js";
import { rasterizeWithMatrix } from "../render/raster-transform.js";
import { ToolId } from "../model/tool-base.js";
import { TransformToolBase } from "./transform-static.js";
import { buildRectSelectionAction } from "../tools/selection-actions.js";
import { quickSelectSession, syncQuickSelectOverlay } from "../tools/quick-select-session.js";
import { CROSSHAIR_INSET_RATIO } from "../tools/quick-select-session.js";
import { SelectTool } from "../tools/selection-tools.js";
import { allocBuffer, extractChannel, extractChannelByte } from "../../engine/compositing/buffer-utils.js";
import { copyPixels, trimChannelToContent } from "../../engine/compositing/pixel-ops.js";
import { boundsFromCoordPairs } from "../../engine/compositing/anti-alias.js";
import { composeHomographies, cornersToHomography, invert, toMatrix2D, transformPointsArray } from "../../engine/compositing/homography.js";
import { getWarpControlPoints, isIdentityWarp } from "../../engine/compositing/warp.js";
import { resize } from "../../engine/compositing/seam-carving.js";


/** Which document surface a transform session mutates (layers, quick mask, selection). */
const TRANSFORM_SCOPE = {
  LAYERS: 0,
  QUICK_MASK: 1,
  SELECTION: 2,
};

/**
 * Compose the preview homography from the active handle box and base matrix.
 * @param {object} tool
 * @returns {object}
 */
function composePreviewHomography(tool) {
  let cornerHomography = cornersToHomography(
    tool.activeOp.getCornerCoords(),
    tool.transformBounds,
  );
  return composeHomographies(
    cornerHomography,
    invert(tool.boundsBaseMatrix),
  );
}

/**
 * Preview transform applied to layer pixels (including content-aware scale).
 * @param {object} tool
 * @param {object} doc
 * @param {object} appData
 * @param {number} interpolationMode
 * @param {object} cornerHomography
 * @param {object|null} warpMesh
 * @param {boolean} livePreviewFlag
 */
function previewTransformLayers(
  tool,
  doc,
  appData,
  interpolationMode,
  cornerHomography,
  warpMesh,
  livePreviewFlag,
) {
  const gestureMatrix = (tool.repeatGestureMatrix =
    toMatrix2D(cornerHomography));
  if (tool.id === ToolId.TOOL_CONTENT_AWARE_SCALE) {
    const pixelSnapshot = tool.layerSnapshotsBefore[0][0];
    const rasterPair = pixelSnapshot.rasterPair;
    const sourceRect = rasterPair[1];
    const scaledWidth = ~~(sourceRect.width * Math.max(0, gestureMatrix.a));
    const scaledHeight = ~~(sourceRect.height * Math.max(0, gestureMatrix.d));
    const outputRect = new Rect(
      Math.round(gestureMatrix.a * sourceRect.x + gestureMatrix.tx),
      Math.round(gestureMatrix.d * sourceRect.y + gestureMatrix.ty),
      scaledWidth,
      scaledHeight,
    );
    const resizedBuffer = resize(tool.contentAwareBuffer, outputRect);
    const targetLayer = doc.layers[tool.targetIndices[0]];
      targetLayer.buffer = resizedBuffer;
      targetLayer.rect = outputRect;
      targetLayer.markDirty();
    doc.markDirty();
  } else {
    TransformToolBase.applyTransformToLayers(
      doc,
      appData.fontRegistry,
      tool.targetIndices,
      tool.layerSnapshotsBefore,
      interpolationMode,
      cornerHomography,
      warpMesh,
      null,
      null,
      livePreviewFlag,
    );
  }
}

/**
 * Preview transform applied to the quick-mask channel and selection overlay.
 * @param {object} tool
 * @param {object} doc
 * @param {number} interpolationMode
 * @param {object} cornerHomography
 * @param {object|null} warpMesh
 */
function previewTransformQuickMask(tool, doc, interpolationMode, cornerHomography, warpMesh) {
  const targetLayer = doc.layers[tool.targetIndices[0]];
  let quickMaskRect = tool.quickMaskSnapshot.rect;
    if (targetLayer.pixelContent <= 0) {
    let pixBuf = tool.quickMaskSnapshot.pixBuf;
    const selectionBefore = tool.selectionBefore;
    if (
      warpMesh &&
      !isIdentityWarp(warpMesh) &&
      !selectionBefore.rect.equals(quickMaskRect)
    ) {
      const tempBuffer = allocBuffer(selectionBefore.rect.area() * 4);
        copyPixels(pixBuf, quickMaskRect, tempBuffer, selectionBefore.rect);
        pixBuf = tempBuffer;
      quickMaskRect = selectionBefore.rect;
    }
    const rasterResult = rasterizeWithMatrix(
      [pixBuf, quickMaskRect],
      interpolationMode,
      cornerHomography,
      warpMesh,
    );
      if (rasterResult) {
      targetLayer.pixCache.selectionPixels = rasterResult.buffer;
      targetLayer.pixCache.selectionRect = rasterResult.rect;
      const channelBuffer = allocBuffer(rasterResult.rect.area());
      extractChannelByte(targetLayer.pixCache.selectionPixels, channelBuffer, 3);
        doc.selectionMask = {
          channel: channelBuffer,
        rect: targetLayer.pixCache.selectionRect.clone(),
      };
      }
    } else {
    const rgbaBuffer = allocBuffer(quickMaskRect.area() * 4);
    extractChannel(tool.quickMaskSnapshot.pixBuf, rgbaBuffer, 3);
    const rasterResult = rasterizeWithMatrix(
      [rgbaBuffer, quickMaskRect],
      interpolationMode,
      cornerHomography,
      warpMesh,
    );
      if (rasterResult) {
      targetLayer.pixCache.selectionPixels = allocBuffer(rasterResult.rect.area());
      extractChannelByte(rasterResult.buffer, targetLayer.pixCache.selectionPixels, 3);
      targetLayer.pixCache.selectionRect = rasterResult.rect;
    }
    tool.previewSelectionTransform(doc, interpolationMode, cornerHomography, warpMesh);
    }
    targetLayer.syncSelectionOverlay(doc, 0, 0, doc.selectionMask);
  if (interpolationMode !== 0) {
      targetLayer.trimToContent();
    trimChannelToContent(doc.selectionMask);
  }
  doc.needsComposite = true;
  doc.markDirty();
}

function installTransformToolBasePreviewMethods() {
  TransformToolBase.prototype.syncWarpBoundsFromMesh = function () {
    const warpBounds = boundsFromCoordPairs(
      getWarpControlPoints(this.warpMesh.cloneWarpDescriptor()),
    );
    const cornerHomography = cornersToHomography(
      this.activeOp.getCornerCoords(),
      this.transformBounds,
    );
    const cornerCoords = [
      warpBounds.x,
      warpBounds.y,
      warpBounds.x + warpBounds.width,
      warpBounds.y,
      warpBounds.x + warpBounds.width,
      warpBounds.y + warpBounds.height,
      warpBounds.x,
      warpBounds.y + warpBounds.height,
    ];
    transformPointsArray(cornerHomography, cornerCoords);
    this.activeOp.setCornerCoords(cornerCoords);
    this.transformBounds = warpBounds;
  };

  TransformToolBase.prototype.previewTransform = function (
    doc,
    appData,
    interpolationMode,
    livePreviewFlag,
  ) {
    const cornerHomography = composePreviewHomography(this);
    const warpMesh = this.warpMesh ? this.warpMesh.cloneWarpDescriptor() : null;
    if (this.transformScope === TRANSFORM_SCOPE.LAYERS) {
      previewTransformLayers(
        this,
        doc,
        appData,
        interpolationMode,
        cornerHomography,
        warpMesh,
        livePreviewFlag,
      );
    } else if (this.transformScope === TRANSFORM_SCOPE.QUICK_MASK) {
      previewTransformQuickMask(this, doc, interpolationMode, cornerHomography, warpMesh);
    } else if (this.transformScope === TRANSFORM_SCOPE.SELECTION) {
      this.previewSelectionTransform(doc, interpolationMode, cornerHomography, warpMesh);
    }
  };

  TransformToolBase.prototype.previewSelectionTransform = function (
    doc,
    interpolationMode,
    homography,
    warpMesh,
  ) {
    const selectionRect = this.selectionBefore.rect;
    const rgbaBuffer = allocBuffer(selectionRect.area() * 4);
  extractChannel(this.selectionBefore.channel, rgbaBuffer, 3);
    const rasterResult = rasterizeWithMatrix(
      [rgbaBuffer, selectionRect],
      interpolationMode,
      homography,
      warpMesh,
    );
    const channelBuffer = allocBuffer(rasterResult.rect.area());
  extractChannelByte(rasterResult.buffer, channelBuffer, 3);
  doc.selectionMask = {
    channel: channelBuffer,
      rect: rasterResult.rect,
    };
    doc.needsComposite = true;
  };

  TransformToolBase.prototype.disable = function (doc, dispatcher, appData, keyboard) {
    if (this.activeOp) {
      this.commitTransform(doc, dispatcher, null, true);
    }
  };
}

export function FreeTransformTool() {
  TransformToolBase.call(
    this,
    "tools.freeTransform",
    ToolId.TOOL_FREE_TRANSFORM,
    "tools/transform",
  );
}

export function WarpTool() {
  TransformToolBase.call(this, "dialogs.warp", ToolId.TOOL_WARP, "tools/transform");
}

export function ContentAwareScaleTool() {
  TransformToolBase.call(
    this,
    "tools.contentAwareScale",
    ToolId.TOOL_CONTENT_AWARE_SCALE,
    "tools/transform",
  );
}

export function ObjectSelectTool() {
  SelectTool.call(
    this,
    "tools.objectSelection",
    ToolId.TOOL_OBJECT_SELECT,
    "tools/oselect",
  );
  this.defaultCursorStyle = "crosshair";
  this.crosshairHintAlertCount = 0;
}

function installObjectSelectToolPrototype() {
  ObjectSelectTool.prototype.onDragStart = function (doc, appData, keyboard, pointerState) {
    if (Math.random() < 1 / (1 + this.crosshairHintAlertCount)) {
      alert("The cross should be fully inside the object.", 3500);
      this.crosshairHintAlertCount++;
    }
  };

  ObjectSelectTool.prototype.onDrag = function (doc, appData, keyboard, pointerState) {
    syncQuickSelectOverlay(
      doc,
      quickSelectSession,
      this.appDispatcher,
    );
    if (!pointerState.isDown || !this.exceededDragThreshold) {
      return;
    }
    const selectionRect = this.getSelectionRect(doc, keyboard, false);
    const rectWidth = selectionRect.width;
    const rectHeight = selectionRect.height;
    const left = selectionRect.x;
    const top = selectionRect.y;
    const right = selectionRect.x + rectWidth;
    const bottom = selectionRect.y + rectHeight;
    const centerX = left + rectWidth / 2;
    const centerY = top + rectHeight / 2;
    const insetRatio = CROSSHAIR_INSET_RATIO;
  doc.toolOverlayState.overlayTransform = {
      coords: [
        left,
        top,
        right,
        top,
        right,
        bottom,
        left,
        bottom,
        centerX - rectWidth * insetRatio,
        centerY,
        centerX + rectWidth * insetRatio,
        centerY,
        centerX,
        centerY - rectHeight * insetRatio,
        centerX,
        centerY + rectHeight * insetRatio,
      ],
      commands: "M L L L Z M L M L".split(" "),
    };
    doc.dirty = true;
  };

  ObjectSelectTool.prototype.onDragEnd = function (doc, appData, keyboard, pointerState) {
    doc.toolOverlayState.overlayTransform = null;
    doc.dirty = true;
    this.finish(doc, appData, keyboard, pointerState);
  };

  ObjectSelectTool.prototype.getSelection = function (doc, appData, keyboard, pointerState) {
    if (this.startPos.equals(this.cursorPos) || !this.exceededDragThreshold) {
      return null;
    }
    const selectionRect = this.getSelectionRect(doc, keyboard, false);
    const targetLayer = doc.layers[doc.selectedLayerIndices[0]];
    if (selectionRect.isEmpty() || !selectionRect.overlaps(targetLayer.rect)) {
      return null;
    }
    return buildRectSelectionAction("ObSl", selectionRect);
  };
}

// Chain each tool's prototype onto the base it extends. The bases are
// imported, so they are fully built by the time this runs.
installTransformToolBasePreviewMethods();

FreeTransformTool.prototype = Object.create(TransformToolBase.prototype);

WarpTool.prototype = Object.create(TransformToolBase.prototype);

ContentAwareScaleTool.prototype = Object.create(TransformToolBase.prototype);

ObjectSelectTool.prototype = Object.create(SelectTool.prototype);
installObjectSelectToolPrototype();

installPuppetWarpTool();
installSliceTools();

