/**
 * Shared transform-tool session: target resolution, layer snapshots, commit and cancel
 * history, and raster, vector, and smart-object apply helpers. Concrete tools extend
 * TransformToolBase; live preview lives in transform-tools.js.
 */


import { KeyboardHandler } from "../../core/keyboard-handler.js";
import { Locale } from "../../core/i18n/locale.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Point } from "../../core/math/point.js";
import { Rect } from "../../core/math/rect.js";
import { HistoryEntry } from "../model/document.js";
import { installTransformLayerApplyStatics } from "./transform-layer-apply.js";
import { TextRenderer } from "../../features/text/text-renderer.js";
import { ActionDescUtil } from "../../features/scripting/action-desc.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { AppEvent } from "../../core/event-bus.js";
import { ToolBase, ToolId } from "../model/tool-base.js";
import { unpackDoublesList } from "../formats/psd/descriptor-codec.js";
import { TransformBox, WarpMesh } from "./transform-box.js";
import { allocBuffer, extractChannelByte } from "../../engine/compositing/buffer-utils.js";
import { boundsFromCoordPairs, transformCoordPairs } from "../../engine/compositing/anti-alias.js";
import { cornersToHomography, homographyTransformPoint, invert, matrix2DToHomography, toMatrix2D, transformPointsArray } from "../../engine/compositing/homography.js";
import { defaultWarpDescriptor, getWarpControlPoints, isIdentityWarp } from "../../engine/compositing/warp.js";
import { computeSeams } from "../../engine/compositing/seam-carving.js";


/** How commit and cancel history records what was transformed. */
const TRANSFORM_SCOPE = {
  LAYERS: 0,
  QUICK_MASK: 1,
  SELECTION: 2,
};

/** Which handle surface receives pointer input (bounding box vs warp mesh). */
const HANDLE_SURFACE = {
  TRANSFORM_BOX: 0,
  WARP_MESH: 1,
};

/** Negative index floor encoding paths (−1−pathIdx) vs extra channels (−1000−channelIdx). */
const PATH_TARGET_FLOOR = -1000;

/** Indices within each per-target layer snapshot tuple from captureLayerSnapshots. */
const SNAPSHOT = {
  RASTER: 0,
  MASK: 1,
  VECTOR: 2,
  TEXT_MATRIX: 3,
  PLACED_DATA: 4,
  LINKED_CHANNEL: 5,
  LAYER_EFFECTS: 6,
  EXTRA_CHANNEL: 7,
};

const UNIT_FLOAT_TYPES = ["#Pxl", "#Prc", "#Ang"];

/**
 * PSD unit-float wrapper for transform action descriptors.
 * @param {number} value
 * @param {number} unitTypeIndex 0 = px, 1 = %, 2 = deg
 */
function makeUnitFloat(value, unitTypeIndex) {
  return {
    t: "UntF",
    v: {
      type: UNIT_FLOAT_TYPES[unitTypeIndex],
      val: value,
    },
  };
}

/**
 * Resolve layer, path, and extra-channel indices for the current transform session.
 * @param {object} doc
 * @param {boolean} includeSelection
 * @param {number[]|null} pathIndices
 * @returns {number[]}
 */
function resolveTransformTarget(doc, includeSelection, pathIndices) {
  doc.getPaths();
  const pathTargetIndices = [];
  if (pathIndices == null) {
    for (let pathIdx = 0; pathIdx < doc.selectedWorkPaths.length; pathIdx++) {
      if (doc.paths[doc.selectedWorkPaths[pathIdx]].add.vmsk.pathRecords.length > 2) {
        pathTargetIndices.push(-1 - doc.selectedWorkPaths[pathIdx]);
      }
    }
  }

  let targetIndices = [];
  const channelVisibility = doc.pathViewport.channelVisibility;
  if (channelVisibility[0] + channelVisibility[1] + channelVisibility[2] === 3) {
    if (
      pathIndices != null ||
      pathTargetIndices.length === 0 ||
      (doc.selectedLayerPaths != null && doc.selectedLayerPaths.length !== 0)
    ) {
      targetIndices = doc.resolveLayerSelection(includeSelection, pathIndices, null, true);
    }
  }
  targetIndices = targetIndices.concat(pathTargetIndices);
  for (let channelIdx = 0; channelIdx < doc.activeChannels.length; channelIdx++) {
    targetIndices.push(PATH_TARGET_FLOOR - doc.activeChannels[channelIdx]);
  }
  return targetIndices;
}

/**
 * Map a document-space point through the inverse warp homography when the warp mesh surface is active.
 * @param {object} tool TransformToolBase instance
 * @param {Point} docPoint
 * @returns {Point}
 */
function mapDocPointThroughWarpHomography(tool, docPoint) {
  const invertedHomography = invert(
    cornersToHomography(
      tool.activeOp.getCornerCoords(),
      tool.transformBounds,
    ),
  );
  return homographyTransformPoint(invertedHomography, docPoint);
}

/**
 * Layer, path, or extra-channel record for a transform target index.
 * @param {object} doc
 * @param {number} targetIndex
 */
function targetFromIndex(doc, targetIndex) {
  if (targetIndex >= 0) {
    return doc.layers[targetIndex];
  }
  if (targetIndex > PATH_TARGET_FLOOR) {
    return doc.paths[-1 - targetIndex];
  }
  return doc.extraChannels[PATH_TARGET_FLOOR - targetIndex];
}

/** Active bounding-box or warp-mesh handle operator for the current surface mode. */
function getHandleSurfaceOperator(tool) {
  return tool.warpMeshMode === HANDLE_SURFACE.TRANSFORM_BOX ? tool.activeOp : tool.warpMesh;
}

/**
 * Build rotate/flip action payload for the action tracker.
 * @param {boolean} isRotate
 * @param {number|string} angleOrAxis Angle in radians or flip axis enum key
 */
function buildRotateOrFlipAction(isRotate, angleOrAxis) {
  const actionDescriptor = {
    classID: "null",
    null: ActionDescUtil.buildTargetRef("Dcmn", true),
  };
  if (isRotate) {
    actionDescriptor.Angl = {
      t: "UntF",
      v: {
        type: "#Ang",
        val: angleOrAxis,
      },
    };
  } else {
    actionDescriptor.Axis = {
      t: "enum",
      v: {
        Ornt: angleOrAxis,
      },
    };
  }
  return {
    uf: isRotate ? "rotateEventEnum" : "flip",
    actionDescriptor,
  };
}



/**
 * History entry payload for commitTransform before pushHistory.
 * @param {object} tool
 * @param {object} doc
 * @param {string|null} historyLabel
 */
function buildCommitHistoryData(tool, doc, historyLabel) {
  const historyEntry = new HistoryEntry(historyLabel ? historyLabel : tool.name, tool);

  if (tool.transformScope === TRANSFORM_SCOPE.LAYERS) {
    historyEntry.data = {
      type: tool.transformScope,
      targetIndices: tool.targetIndices,
      snapshotsBefore: tool.layerSnapshotsBefore,
      snapshotsAfter: TransformToolBase.captureLayerSnapshots(doc, tool.targetIndices),
    };
  } else if (tool.transformScope === TRANSFORM_SCOPE.QUICK_MASK) {
    const targetLayer = doc.layers[tool.targetIndices[0]];
    let channelBuffer;
    if (targetLayer.pixCache.pixelContent <= 0) {
      channelBuffer = allocBuffer(targetLayer.pixCache.selectionRect.area());
      extractChannelByte(targetLayer.pixCache.selectionPixels, channelBuffer, 3);
    } else {
      channelBuffer = doc.selectionMask.channel;
    }
    const selectionAfter = {
      rect: targetLayer.pixCache.selectionRect.clone(),
      channel: channelBuffer,
    };
    historyEntry.data = {
      type: tool.transformScope,
      targetLayerIndex: tool.targetIndices[0],
      selectionBefore: tool.selectionBefore,
      selectionAfter,
      savedPixCache: tool.savedPixCache,
      maskViaAlternatePath: tool.maskViaAlternatePath,
      pixCache: targetLayer.pixCache,
      snapshotsBefore: tool.quickMaskSnapshot,
      snapshotsAfter: {
        rect: targetLayer.pixCache.selectionRect,
        pixBuf: targetLayer.pixCache.selectionPixels,
      },
    };
  } else if (tool.transformScope === TRANSFORM_SCOPE.SELECTION) {
    historyEntry.data = {
      type: tool.transformScope,
      selectionBefore: tool.selectionBefore,
      selectionAfter: {
        rect: doc.selectionMask.rect.clone(),
        channel: doc.selectionMask.channel.slice(0),
      },
    };
  }

  return historyEntry;
}

/**
 * Free-transform action descriptor for the action tracker after commit.
 * @param {object} tool
 * @param {object} doc
 */
function buildCommitActionDescriptor(tool, doc) {
  const bounds = tool.transformBounds;
  const centerPoint = new Point(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const cornerHomography = cornersToHomography(
    tool.activeOp.getCornerCoords(),
    bounds,
  );
  let decomposedMatrix = toMatrix2D(cornerHomography);
  const translateMatrix = new Matrix2D();
  translateMatrix.translate(centerPoint.x, centerPoint.y);
  translateMatrix.concat(decomposedMatrix);
  translateMatrix.translate(-centerPoint.x, -centerPoint.y);
  decomposedMatrix = translateMatrix.clone();
  const rotationAngle = -Math.atan2(-decomposedMatrix.b, decomposedMatrix.a);
  const rotateBackMatrix = new Matrix2D();
  rotateBackMatrix.rotate(rotationAngle);
  decomposedMatrix.concat(rotateBackMatrix);

  const layerRef = ActionDescUtil.buildTargetRef("Lyr", true);
  if (tool.id === ToolId.TOOL_WARP) {
    layerRef.v[0] = {
      t: "prop",
      v: {
        classID: "Chnl",
        keyID: "fsel",
      },
    };
  }

  return {
    classID: "null",
    null: layerRef,
    FTcs: {
      t: "enum",
      v: {
        QCSt: "Qcsa",
      },
    },
    Intr: {
      t: "enum",
      v: {
        Intp: "Bcbc",
      },
    },
    Ofst: {
      t: "Objc",
      v: {
        __name: "Offset",
        classID: "Ofst",
        Hrzn: makeUnitFloat(translateMatrix.tx, 0),
        Vrtc: makeUnitFloat(translateMatrix.ty, 0),
      },
    },
    Skew: {
      t: "Objc",
      v: {
        classID: "Pnt",
        Hrzn: makeUnitFloat((Math.atan(decomposedMatrix.c) * 180) / Math.PI, 2),
        Vrtc: makeUnitFloat(0, 2),
      },
    },
    Wdth: makeUnitFloat(decomposedMatrix.a * 100, 1),
    Hght: makeUnitFloat(decomposedMatrix.d * 100, 1),
    Angl: makeUnitFloat((rotationAngle * 180) / Math.PI, 2),
  };
}

/**
 * Restore document state for cancel before tearing down the transform session.
 * @param {object} tool
 * @param {object} doc
 */
function restoreSelectionScopedCancel(tool, doc) {
  if (tool.transformScope === TRANSFORM_SCOPE.LAYERS) {
    TransformToolBase.restoreLayerSnapshots(
      doc,
      tool.targetIndices,
      tool.layerSnapshotsBefore,
    );
  } else if (tool.transformScope === TRANSFORM_SCOPE.QUICK_MASK) {
    const targetLayer = doc.layers[tool.targetIndices[0]];
    doc.selectionMask = tool.selectionBefore;
    if (!tool.maskViaAlternatePath) {
      targetLayer.pixCache.selectionRect = tool.quickMaskSnapshot.rect;
      targetLayer.pixCache.selectionPixels = tool.quickMaskSnapshot.pixBuf;
      targetLayer.syncSelectionOverlay(doc, 0, 0, doc.selectionMask);
    } else {
      targetLayer.restoreFromPixCache(doc, tool.savedPixCache);
    }
    doc.markDirty();
    doc.needsComposite = true;
  } else if (tool.transformScope === TRANSFORM_SCOPE.SELECTION) {
    doc.selectionMask = tool.selectionBefore;
    doc.needsComposite = true;
  }
}

/**
 * Capture targets, scope, bounds, and on-canvas handle operators for a transform session.
 * @param {object} tool
 * @param {object} doc
 * @param {number|null} handleMode
 * @param {boolean} wasPuppetWarpActive
 */
function initTransformSessionImpl(tool, doc, handleMode, wasPuppetWarpActive) {
  const isWarpTool = tool.id === ToolId.TOOL_WARP;
  let showHandles = true;
  const firstTargetIndex = tool.targetIndices[0];
  const firstLayer = doc.layers[firstTargetIndex];
  let placedData = null;

  if (isWarpTool) {
    tool.transformScope = TRANSFORM_SCOPE.SELECTION;
    tool.selectionBefore = doc.selectionMask;
  } else if (
    doc.selectionMask &&
    tool.targetIndices.length === 1 &&
    firstTargetIndex >= 0 &&
    !firstLayer.rect.isEmpty()
  ) {
    tool.transformScope = TRANSFORM_SCOPE.QUICK_MASK;
    tool.selectionBefore = doc.selectionMask;
    tool.savedPixCache = firstLayer.pixCache;
    tool.maskViaAlternatePath = false;
    if (!firstLayer.checkPixelCache(doc, doc.selectionMask)) {
      tool.maskViaAlternatePath = true;
      firstLayer.updatePixCache(doc, doc.selectionMask, false);
    }
    tool.quickMaskSnapshot = {
      pixBuf: firstLayer.pixCache.selectionPixels,
      rect: firstLayer.pixCache.selectionRect,
    };
  } else {
    tool.transformScope = TRANSFORM_SCOPE.LAYERS;
    tool.layerSnapshotsBefore = TransformToolBase.captureLayerSnapshots(
      doc,
      tool.targetIndices,
      null,
      wasPuppetWarpActive,
    );
    for (let snapshotIdx = 0; snapshotIdx < tool.layerSnapshotsBefore.length; snapshotIdx++) {
      if (tool.layerSnapshotsBefore[snapshotIdx][SNAPSHOT.TEXT_MATRIX] != null) {
        showHandles = false;
      }
    }
  }

  let useWarpMesh = tool.transformScope === TRANSFORM_SCOPE.QUICK_MASK;
  if (tool.layerSnapshotsBefore && tool.layerSnapshotsBefore.length === 1) {
    const snapshotEntry = tool.layerSnapshotsBefore[0];
    if (snapshotEntry[SNAPSHOT.TEXT_MATRIX] == null) {
      useWarpMesh = true;
    }
    if (snapshotEntry[SNAPSHOT.PLACED_DATA] != null) {
      placedData = doc.layers[tool.targetIndices[0]].add.placedData;
      if (snapshotEntry[SNAPSHOT.MASK] || snapshotEntry[SNAPSHOT.VECTOR]) {
        useWarpMesh = false;
      }
    }
  }

  const selectionRect = isWarpTool
    ? doc.selectionMask.rect.clone()
    : TransformToolBase.getSelectionRect(doc, tool.targetIndices, wasPuppetWarpActive);
  tool.transformBounds = selectionRect;

  if (!isWarpTool && placedData) {
    const nonAffineCorners = unpackDoublesList(placedData.nonAffineTransform);
    tool.transformBounds = boundsFromCoordPairs(
      getWarpControlPoints(placedData.warp.v),
    );
    if (useWarpMesh) {
      tool.warpMesh = new WarpMesh(placedData.warp.v);
    }
    tool.boundsBaseMatrix = cornersToHomography(
      nonAffineCorners,
      tool.transformBounds,
    );
    tool.activeOp = new TransformBox(
      nonAffineCorners,
      true,
      true,
      showHandles,
      false,
      false,
      handleMode,
    );
  } else {
    if (useWarpMesh || isWarpTool) {
      tool.warpMesh = new WarpMesh(
        defaultWarpDescriptor(tool.transformBounds),
      );
    }
    tool.boundsBaseMatrix = [1, 0, 0, 0, 1, 0, 0, 0];
    if (tool.id === ToolId.TOOL_CONTENT_AWARE_SCALE) {
      handleMode = 3;
    }
    tool.activeOp = new TransformBox(
      [
        selectionRect.x,
        selectionRect.y,
        selectionRect.x + selectionRect.width,
        selectionRect.y,
        selectionRect.x + selectionRect.width,
        selectionRect.y + selectionRect.height,
        selectionRect.x,
        selectionRect.y + selectionRect.height,
      ],
      true,
      true,
      showHandles,
      false,
      false,
      handleMode,
    );
  }

  tool.baseTransformMatrix = [1, 0, 0, 0, 1, 0, 0, 0];
  if (tool.id === ToolId.TOOL_CONTENT_AWARE_SCALE) {
    const pixelSnapshot = tool.layerSnapshotsBefore[0][SNAPSHOT.RASTER];
    const rasterPair = pixelSnapshot.rasterPair;
    const rasterRect = rasterPair[1];
    tool.contentAwareBuffer = computeSeams(
      rasterPair[0],
      rasterRect.width,
      rasterRect.height,
    );
  }
}

/**
 * Apply a toolbar-supplied 2×3 matrix to the transform bounding corners.
 * @param {object} tool
 * @param {object} doc
 * @param {object} actionPayload
 */
function applyToolbarMatrixAction(tool, doc, actionPayload) {
  const translateHomography = matrix2DToHomography(actionPayload.transformMatrix);
  const bounds = tool.transformBounds;
  const cornerHomography = cornersToHomography(
    tool.activeOp.getCornerCoords(),
    tool.transformBounds,
  );
  translateHomography[6] = cornerHomography[6];
  translateHomography[7] = cornerHomography[7];
  const cornerCoords = [
    bounds.x,
    bounds.y,
    bounds.x + bounds.width,
    bounds.y,
    bounds.x + bounds.width,
    bounds.y + bounds.height,
    bounds.x,
    bounds.y + bounds.height,
  ];
  transformPointsArray(translateHomography, cornerCoords);
  tool.interpolationMode = actionPayload.interpolationMode;
  tool.activeOp.setCornerCoords(cornerCoords);
  tool.syncTransformOverlay(doc);
  tool.previewTransform(doc, tool.toolOptions, 0, true);
}

/**
 * Registers {@link TransformToolBase} on the document model namespace.
 */
/**
 * Shared base for the transform tools: free transform, warp, content-aware
 * scale and puppet warp. Holds the state one transform gesture needs — the
 * target layers, the snapshots to restore on cancel, the live matrix and mesh —
 * and the statics the format codecs use to rasterise a placed layer.
 */
export function TransformToolBase(labelKey, toolId, iconPath) {
  ToolBase.call(this, labelKey, toolId, iconPath);
  this.transformScope = TRANSFORM_SCOPE.LAYERS;
  this.targetIndices = null;
  this.layerSnapshotsBefore = null;
  this.toolOptions = null;
  this.interpolationMode = 1;
  this.isDragging = false;
  this.cursor = null;
  this.savedPixCache = null;
  this.selectionBefore = null;
  this.maskViaAlternatePath = false;
  this.quickMaskSnapshot = null;
  this.lastPointerDownMs = 0;
  this.repeatGestureMatrix = null;
  this.warpMeshMode = HANDLE_SURFACE.TRANSFORM_BOX;
  this.transformBounds = null;
  this.activeOp = null;
  this.warpMesh = null;
  this.boundsBaseMatrix = null;
  this.baseTransformMatrix = null;
  this.contentAwareBuffer = null;
}

TransformToolBase.prototype = Object.create(ToolBase.prototype);
installTransformToolBasePrototype();
installTransformToolBaseStatics();


function installTransformToolBasePrototype() {
  TransformToolBase.prototype.onRightMouseUp = function (doc, dispatcher, appData, keyboard, pointerState) {
    const appEvent = new AppEvent(EventType.uiDispatch, true);
    appEvent.data = {
      dispatchKind: UiCommand.forwardActiveToolGesture,
      routingChannel: this.id,
      pointerState,
      doc,
      appData,
    };
    dispatcher.dispatch(appEvent);
    this.suppressMoveDuringRightDrag = false;
  };

  TransformToolBase.prototype.wantsInput = function (unusedInputEvent) {
    return this.activeOp && this.activeOp.isHandleDragActive();
  };

  TransformToolBase.prototype.handleInput = function (event, dispatcher, doc, keyboard, appData) {
    this.toolOptions = appData;
    if (event.actionKind === "again" && this.repeatGestureMatrix == null) {
      return;
    }
    if (event.actionKind === "doMouseDown") {
      if (this.activeOp == null) {
        return;
      }
      this.onMouseDown(doc, dispatcher, appData, keyboard, event.pointerState);
      return;
    }
    if (!this.canActivateWithGesture(doc, appData)) {
      return;
    }
    if (this.activeOp) {
      this.applyTransformGesture(event, this.activeOp.getActiveHandlePoint());
      this.previewTransform(doc, appData, 0, true);
      this.syncTransformOverlay(doc);
      return;
    }
    this.resolveTransformTargetLayers(doc, event.targetLayerIndex == null, event.targetLayerIndex);
    this.initTransformSession(doc);
    this.applyTransformGesture(event);
    this.commitTransform(doc, dispatcher, event.historyLabelKey, false);
  };

  TransformToolBase.prototype.applyTransformGesture = function (gestureEvent, anchorPoint) {
    const bounds = this.transformBounds;
    if (anchorPoint == null) {
      const anchorIndex =
        gestureEvent.transformAnchorIndex != null ? gestureEvent.transformAnchorIndex : 4;
      anchorPoint = this.activeOp.getTransformHandlePoints()[anchorIndex];
    }
    let anchorX = anchorPoint.x;
    let anchorY = anchorPoint.y;
    if (
      gestureEvent.actionKind === "rot" &&
      gestureEvent.gestureValue !== Math.PI &&
      (bounds.width + bounds.height & 1) === 1
    ) {
      anchorX = Math.floor(anchorX);
      anchorY = Math.floor(anchorY);
    }
    let transformMatrix = new Matrix2D();
    transformMatrix.translate(-anchorX, -anchorY);
    if (gestureEvent.actionKind === "rot") {
      transformMatrix.rotate(gestureEvent.gestureValue);
    }
    if (gestureEvent.actionKind === "scl") {
      transformMatrix.scale(gestureEvent.gestureValue.x, gestureEvent.gestureValue.y);
    }
    if (gestureEvent.actionKind === "mat") {
      transformMatrix.concat(gestureEvent.gestureValue);
    }
    transformMatrix.translate(anchorX, anchorY);
    if (gestureEvent.actionKind === "again") {
      transformMatrix = this.repeatGestureMatrix;
    }
    const cornerCoords = this.activeOp.getCornerCoords();
    transformCoordPairs(cornerCoords, transformMatrix, cornerCoords);
    this.activeOp.setCornerCoords(cornerCoords);
  };

  TransformToolBase.prototype.isActive = function () {
    return true;
  };

  TransformToolBase.prototype.canActivateWithGesture = function (doc, appData) {
    if (doc == null) {
      return false;
    }
    if (this.id === ToolId.TOOL_WARP) {
      return doc.selectionMask != null;
    }
    const layerIndices = doc.resolveLayerSelection(true, null, null, true);
    if (
      this.id === ToolId.TOOL_CONTENT_AWARE_SCALE &&
      doc.layers[layerIndices[0]].rect.isEmpty()
    ) {
      alert("Layer is empty.");
      return false;
    }
    for (let layerIdx = 0; layerIdx < layerIndices.length; layerIdx++) {
      const layer = doc.layers[layerIndices[layerIdx]];
      if (layer.isLockBitSet(2) || layer.isLockBitSet(31)) {
        alert(Locale.get("layer.thisLayerIsLocked"));
        return false;
      }
      if (layer.add.artb) {
        alert("You can not transform the whole artboard");
        return false;
      }
      if (layer.add.TySh) {
        if (!TextRenderer.checkFonts(layer.add.TySh, appData.fontRegistry)) {
          return false;
        }
      }
      if (layer.add.placedData) {
        if (
          layerIndices.length === 1 &&
          !isIdentityWarp(layer.add.placedData.warp.v) &&
          ((layer.getMask() && layer.getMask().enabled) ||
            (layer.add.vmsk && layer.add.vmsk.enabled))
        ) {
          alert("Unlink masks before transforming Smart Object");
          return false;
        }
        if (!doc.isLinkedItemEditable(layer.add.placedData.Idnt.v)) {
          alert(
            "Unsupported format of the smart object (" +
              doc.findLinkedItemByTag(layer.add.placedData.Idnt.v).fileName +
              ")",
          );
          return false;
        }
      }
    }
    if (doc.selectionMask == null) {
      return true;
    }
    if (!doc.ensureLayerEditableForTools()) {
      return false;
    }
    return doc.checkSelectionNonEmpty();
  };

  TransformToolBase.prototype.onMouseDown = function (doc, dispatcher, appData, keyboard, pointerState) {
    let docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
    if (this.warpMeshMode === HANDLE_SURFACE.WARP_MESH) {
      docPoint = mapDocPointThroughWarpHomography(this, docPoint);
    }
    const activeHandleOp = getHandleSurfaceOperator(this);
    this.isDragging = activeHandleOp.onMouseDown(doc, appData, keyboard, docPoint);
    if (this.isDragging && activeHandleOp.containsDocPoint(docPoint)) {
      if (Date.now() - this.lastPointerDownMs < 250) {
        this.commitTransform(doc, dispatcher, null, true);
      }
      this.lastPointerDownMs = Date.now();
    }
  };

  TransformToolBase.prototype.updateCursor = function (dispatcher) {
    const appEvent = new AppEvent(EventType.uiDispatch, true);
    appEvent.data = {
      dispatchKind: UiCommand.splashOptionsUpdate,
      cursorOverlayId: this.cursor,
    };
    dispatcher.dispatch(appEvent);
  };

  TransformToolBase.prototype.onMouseMove = function (doc, dispatcher, appData, keyboard, pointerState) {
    let docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
    if (this.warpMeshMode === HANDLE_SURFACE.WARP_MESH) {
      docPoint = mapDocPointThroughWarpHomography(this, docPoint);
    }
    const activeHandleOp = getHandleSurfaceOperator(this);
    if (!pointerState.isDown) {
      let cursorStyle = "default";
      if (activeHandleOp) {
        const hitCursor = activeHandleOp.getHandleCursor(docPoint, doc.pathViewport.zoomScale);
        if (hitCursor) {
          cursorStyle = hitCursor;
        }
      }
      if (cursorStyle !== this.cursor || typeof cursorStyle !== typeof this.cursor) {
        this.cursor = cursorStyle;
        this.updateCursor(dispatcher);
      } else if (typeof cursorStyle !== "string") {
        this.updateCursor(dispatcher);
      }
    }
    if (!this.isDragging) {
      return;
    }
    activeHandleOp.onMouseMove(doc, appData, keyboard, docPoint);
    this.previewTransform(doc, appData, 0, true);
    this.syncTransformOverlay(doc);
    this.dispatchTransformToolbarState(dispatcher);
  };

  TransformToolBase.prototype.onMouseUp = function (doc, dispatcher, appData, keyboard, pointerState) {
    const docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
    this.activeOp.onMouseUp(doc, appData, keyboard, docPoint);
    this.isDragging = false;
  };

  TransformToolBase.prototype.onKeyEvent = function (doc, dispatcher, appData, keyboard) {
    if (keyboard.isPressed(KeyboardHandler.Enter)) {
      this.commitTransform(doc, dispatcher, null, true);
    } else if (keyboard.isPressed(KeyboardHandler.Escape)) {
      this.cancel(doc, dispatcher);
    } else {
      const keyHandled = this.activeOp.onKeyEvent(doc, appData, keyboard);
      if (keyHandled) {
        this.previewTransform(doc, appData, 0, true);
        this.dispatchTransformToolbarState(dispatcher);
      }
    }
  };

  TransformToolBase.prototype.applyAction = function (actionPayload, dispatcher, doc, keyboard) {
    if (actionPayload.subAction === "commit") {
      this.commitTransform(doc, dispatcher, null, true);
    } else if (actionPayload.subAction === "cancel") {
      this.cancel(doc, dispatcher);
    } else if (actionPayload.subAction === "switchWarp") {
      this.warpMeshMode =
        this.warpMeshMode === HANDLE_SURFACE.TRANSFORM_BOX
          ? HANDLE_SURFACE.WARP_MESH
          : HANDLE_SURFACE.TRANSFORM_BOX;
      this.syncWarpBoundsFromMesh();
      this.syncTransformOverlay(doc);
      this.dispatchTransformToolbarState(dispatcher);
    } else if (actionPayload.subAction === "wrp") {
      this.warpMesh.setWarpDescriptor(actionPayload.warpDescriptor);
      this.syncTransformOverlay(doc);
      this.previewTransform(doc, this.toolOptions, 0, true);
    } else if (actionPayload.subAction === "ctyp") {
      this.activeOp.setActiveHandleIndex(actionPayload.refPointIndex);
      this.syncTransformOverlay(doc);
      this.dispatchTransformToolbarState(dispatcher);
    } else if (actionPayload.subAction === "cen") {
      this.activeOp.setActiveHandleFromDocPoint(actionPayload.refPoint);
      this.syncTransformOverlay(doc);
      this.previewTransform(doc, this.toolOptions, 0, true);
      this.dispatchTransformToolbarState(dispatcher);
    } else if (actionPayload.subAction === "trn") {
      applyToolbarMatrixAction(this, doc, actionPayload);
    }
  };

  TransformToolBase.prototype.syncTransformOverlay = function (doc) {
    if (this.warpMeshMode === HANDLE_SURFACE.TRANSFORM_BOX) {
      this.activeOp.redrawOverlay(doc, this.toolOptions);
    } else {
      this.warpMesh.redrawOverlay(doc);
      const cornerHomography = cornersToHomography(
        this.activeOp.getCornerCoords(),
        this.transformBounds,
      );
      transformPointsArray(
        cornerHomography,
        doc.toolOverlayState.overlayTransform.coords,
      );
      transformPointsArray(
        cornerHomography,
        doc.toolOverlayState.squareMarkerCoords,
      );
    }
  };

  TransformToolBase.prototype.commitTransform = function (doc, dispatcher, historyLabel, skipRepeatOnDoubleClick) {
    this.previewTransform(doc, this.toolOptions, this.interpolationMode);
    const historyEntry = buildCommitHistoryData(this, doc, historyLabel);
    doc.pushHistory(historyEntry);
    const transformDescriptor = buildCommitActionDescriptor(this, doc);
    this.appDispatcher = dispatcher;
    this.track({
      uf: "transform",
      actionDescriptor: transformDescriptor,
    });
    this.escape(doc, dispatcher, skipRepeatOnDoubleClick);
  };

  TransformToolBase.prototype.cancel = function (doc, dispatcher) {
    restoreSelectionScopedCancel(this, doc);
    this.escape(doc, dispatcher, true);
  };

  TransformToolBase.prototype.escape = function (doc, dispatcher, focusChrome) {
    this.activeOp.clear(doc);
    this.activeOp = null;
    this.warpMesh = null;
    this.contentAwareBuffer = null;
    this.warpMeshMode = HANDLE_SURFACE.TRANSFORM_BOX;
    if (focusChrome) {
      this.emitEvent(dispatcher, EventType.uiDispatch, {
        dispatchKind: UiCommand.focusExtendedToolChrome,
      });
    }
  };

  TransformToolBase.prototype.redo = function (historyData, doc) {
    if (historyData.type === TRANSFORM_SCOPE.LAYERS) {
      TransformToolBase.restoreLayerSnapshots(
        doc,
        historyData.targetIndices,
        historyData.snapshotsAfter,
      );
    } else {
      if (historyData.type === TRANSFORM_SCOPE.QUICK_MASK) {
        const targetLayer = doc.layers[historyData.targetLayerIndex];
        if (historyData.maskViaAlternatePath) {
          targetLayer.pixCache = historyData.pixCache;
        } else {
          targetLayer.pixCache.selectionRect = historyData.snapshotsAfter.rect;
          targetLayer.pixCache.selectionPixels = historyData.snapshotsAfter.pixBuf;
        }
        targetLayer.syncSelectionOverlay(doc, 0, 0, doc.selectionMask);
        doc.markDirty();
      }
      doc.selectionMask = {
        rect: historyData.selectionAfter.rect.clone(),
        channel: historyData.selectionAfter.channel.slice(0),
      };
      doc.needsComposite = true;
    }
  };

  TransformToolBase.prototype.undo = function (historyData, doc) {
    if (historyData.type === TRANSFORM_SCOPE.LAYERS) {
      TransformToolBase.restoreLayerSnapshots(
        doc,
        historyData.targetIndices,
        historyData.snapshotsBefore,
      );
    } else {
      if (historyData.type === TRANSFORM_SCOPE.QUICK_MASK) {
        const targetLayer = doc.layers[historyData.targetLayerIndex];
        if (historyData.maskViaAlternatePath) {
          targetLayer.restoreFromPixCache(doc, historyData.savedPixCache);
        } else {
          targetLayer.pixCache.selectionRect = historyData.snapshotsBefore.rect;
          targetLayer.pixCache.selectionPixels = historyData.snapshotsBefore.pixBuf;
          targetLayer.syncSelectionOverlay(doc, 0, 0, doc.selectionMask);
        }
        doc.markDirty();
      }
      doc.selectionMask = historyData.selectionBefore;
      doc.needsComposite = true;
    }
  };

  TransformToolBase.prototype.resolveTransformTargetLayers = function (doc, includeSelection, pathIndices) {
    this.targetIndices = resolveTransformTarget(doc, includeSelection, pathIndices);
  };

  TransformToolBase.prototype.enable = function (
    doc,
    dispatcher,
    appData,
    keyboard,
    embedInDialog,
    gestureOptions,
    wasPuppetWarpActive,
  ) {
    if (this.cursor == null) {
      this.cursor = "default";
    }
    this.updateCursor(dispatcher);
    if (this.activeOp) {
      return;
    }
    this.toolOptions = appData;
    this.resolveTransformTargetLayers(doc, true);
    this.initTransformSession(
      doc,
      gestureOptions &&
        gestureOptions.transformChromeMode != null &&
        gestureOptions.transformChromeMode !== -1
        ? gestureOptions.transformChromeMode
        : null,
      wasPuppetWarpActive,
    );
    this.dispatchTransformToolbarState(dispatcher);
    this.syncTransformOverlay(doc);
    if (gestureOptions && gestureOptions.transformChromeMode === -1) {
      this.applyAction(
        {
          subAction: "switchWarp",
        },
        dispatcher,
        doc,
        keyboard,
      );
    }
  };

  TransformToolBase.prototype.dispatchTransformToolbarState = function (dispatcher) {
    const toolbarPayload = {
      dispatchKind: UiCommand.forwardActiveToolGesture,
      routingChannel: this.id,
    };
    if (this.warpMeshMode === HANDLE_SURFACE.TRANSFORM_BOX) {
      const cornerHomography = cornersToHomography(
        this.activeOp.getCornerCoords(),
        this.transformBounds,
      );
      const baseMatrix = toMatrix2D(cornerHomography);
      toolbarPayload.freeTransform = {
        decomposedMatrix: baseMatrix,
        refPointIndex: this.activeOp.getActiveHandleIndex(),
        refPoint: this.activeOp.getActiveHandlePoint(),
        boundsRect: this.transformBounds.clone(),
      };
    } else {
      toolbarPayload.warpDescriptor = this.warpMesh.cloneWarpDescriptor();
    }
    toolbarPayload.hasWarpMesh = this.warpMesh != null;
    this.emitEvent(dispatcher, EventType.uiDispatch, toolbarPayload);
  };

  TransformToolBase.prototype.initTransformSession = function (doc, handleMode, wasPuppetWarpActive) {
    initTransformSessionImpl(this, doc, handleMode, wasPuppetWarpActive);
  };

  TransformToolBase.prototype.emitEvent = function (dispatcher, eventType, data, routingChannel) {
    const appEvent = new AppEvent(eventType, true);
    appEvent.data = data;
    if (routingChannel) {
      appEvent.routingChannel = routingChannel;
    }
    dispatcher.dispatch(appEvent);
  };
}

function installTransformToolBaseStatics() {
  TransformToolBase.buildRotateOrFlipAction = buildRotateOrFlipAction;

  installTransformLayerApplyStatics(TransformToolBase);
}
