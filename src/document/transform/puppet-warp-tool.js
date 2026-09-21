/**
 * Puppet warp tool: mesh generation, pin editing, smart-filter history dispatch,
 * and live preview overlay sync.
 */

import { Matrix2D } from "../../core/math/matrix2d.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";

import { FilterDefs } from "../../features/filters/filter-apply.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { getDevicePixelRatio } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { unpackDoublesList } from "../formats/psd/descriptor-codec.js";
import { EventChannel, ToolBase, ToolId } from "../model/tool-base.js";
import { appendPath, findNearestVertexIndex, transformCoordPairs, wireframeTrianglesToPath } from "../../engine/compositing/anti-alias.js";
import { buildConstraintSystem, extractContours, pointInTriangleMesh, solveDeformation } from "../../engine/compositing/path-renderer.js";


/**
 * Wrap scalar values for PSD descriptor list nodes.
 * @param {number[]|boolean[]} values
 * @param {string} typeTag
 */
function wrapDescriptorValues(values, typeTag) {
  const wrappedValues = [];
  for (let valueIdx = 0; valueIdx < values.length; valueIdx++) {
    wrappedValues.push({ t: typeTag, v: values[valueIdx] });
  }
  return wrappedValues;
}

/**
 * Copy a typed array into a byte buffer backing a tdta descriptor field.
 * @param {number[]|Uint32Array|Float32Array} sourceArray
 * @param {number[]} destBytes
 * @param {boolean} [isUint32]
 */
function packTypedArrayToBytes(sourceArray, destBytes, isUint32) {
  const typedArray = new (isUint32 ? Uint32Array : Float32Array)(sourceArray);
  const byteView = new Uint8Array(typedArray.buffer);
  for (let byteIdx = 0; byteIdx < byteView.length; byteIdx++) {
    destBytes[byteIdx] = byteView[byteIdx];
  }
}

/**
 * Empty puppet-shape descriptor shell for one contour.
 * @returns {object}
 */
function createEmptyPuppetShapeDescriptor() {
  const shapeDescriptor = {
    classID: "puppetShape",
    rigidType: { t: "bool", v: true },
    VrsM: { t: "long", v: 1 },
    VrsN: { t: "long", v: 0 },
    originalVertexArray: { t: "tdta", v: [] },
    deformedVertexArray: { t: "tdta", v: [] },
    indexArray: { t: "tdta", v: [] },
    pinOffsets: { t: "VlLs", v: [] },
    posFinalPins: { t: "VlLs", v: [] },
    pinVertexIndices: { t: "VlLs", v: [] },
    PinP: { t: "VlLs", v: [] },
    PnRt: { t: "VlLs", v: [] },
    PnOv: { t: "VlLs", v: [] },
    PnDp: { t: "VlLs", v: [] },
    meshQuality: { t: "long", v: 2 },
    meshExpansion: { t: "long", v: 2 },
    meshRigidity: { t: "long", v: 2 },
    imageResolution: { t: "doub", v: 72 },
    selectedPin: { t: "VlLs", v: [] },
  };
  shapeDescriptor.meshBoundaryPath = {
    t: "Objc",
    v: {
      classID: "pathClass",
      pathComponents: {
        t: "VlLs",
        v: [
          {
            t: "Objc",
            v: {
              classID: "PaCm",
              shapeOperation: {
                t: "enum",
                v: { shapeOperation: "xor" },
              },
              SbpL: {
                t: "VlLs",
                v: [
                  {
                    t: "Objc",
                    v: {
                      classID: "Sbpl",
                      Clsp: { t: "bool", v: true },
                      Pts: { t: "VlLs", v: [] },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    },
  };
  return shapeDescriptor;
}

/**
 * Build path overlays from contour extraction output.
 * @param {object} sourcePaths
 * @param {number[]} meshSettings
 * @param {object} meshDescriptor
 * @returns {object[]}
 */
function buildContourPathOverlays(sourcePaths, meshSettings, meshDescriptor) {
  const pixelBuffer = sourcePaths.buffer;
  const sourceRect = sourcePaths.rect;
  const puppetShapeList = meshDescriptor.puppetShapeList.v;
  const contours = extractContours(
    pixelBuffer,
    sourceRect.width,
    sourceRect.height,
    meshSettings[1],
    meshSettings[2],
  );
  const pathOverlays = [];
  for (let contourIdx = 0; contourIdx < contours.length; contourIdx++) {
    const shapeDescriptor = createEmptyPuppetShapeDescriptor();
    puppetShapeList.push({ t: "Objc", v: shapeDescriptor });
    const contourData = contours[contourIdx];
    const restVertexCoords = contourData.restVertexCoords.slice(0);
    transformCoordPairs(
      restVertexCoords,
      new Matrix2D(1, 0, 0, 1, sourceRect.x, sourceRect.y),
      restVertexCoords,
    );
    const triangleIndices = contourData.triangleIndices;
    for (let triIdx = 0; triIdx < triangleIndices.length; triIdx += 3) {
      const swapVertex = triangleIndices[triIdx + 1];
      triangleIndices[triIdx + 1] = triangleIndices[triIdx + 2];
      triangleIndices[triIdx + 2] = swapVertex;
    }
    pathOverlays.push({
      triangleIndices,
      restVertexCoords,
      solverRestCoords: restVertexCoords,
      deformedVertexCoords: restVertexCoords,
      pinVertexIndices: [],
      pinOffsets: [],
      pinWorldCoords: [],
      constraintSystem: null,
      selectedPinIndices: [],
      pinRotation: [],
      pinOverlap: [],
      pinDepth: [],
    });
  }
  return pathOverlays;
}

/**
 * Copy pins from a prior mesh descriptor onto the first contour overlay.
 * @param {object[]} pathOverlays
 * @param {object} existingMeshDescriptor
 */
function copyPinsFromExistingMesh(pathOverlays, existingMeshDescriptor) {
  const priorOverlays = meshToPathOverlay(existingMeshDescriptor, []);
  const targetOverlay = pathOverlays[0];
  for (let overlayIdx = 0; overlayIdx < priorOverlays.length; overlayIdx++) {
    const priorOverlay = priorOverlays[overlayIdx];
    for (let pinIdx = 0; pinIdx < priorOverlay.selectedPinIndices.length; pinIdx++) {
      targetOverlay.selectedPinIndices.push(
        (targetOverlay.pinWorldCoords.length >>> 1) + priorOverlay.selectedPinIndices[pinIdx],
      );
    }
    for (let pinIdx = 0; pinIdx < priorOverlay.pinVertexIndices.length; pinIdx++) {
      const vertexCoordOffset = priorOverlay.pinVertexIndices[pinIdx] * 2;
      const clickX =
        priorOverlay.restVertexCoords[vertexCoordOffset] - priorOverlay.pinOffsets[pinIdx * 2];
      const clickY =
        priorOverlay.restVertexCoords[vertexCoordOffset + 1] -
        priorOverlay.pinOffsets[pinIdx * 2 + 1];
      addPuppetPin(
        targetOverlay,
        clickX,
        clickY,
        priorOverlay.pinWorldCoords[pinIdx * 2],
        priorOverlay.pinWorldCoords[pinIdx * 2 + 1],
        priorOverlay.pinDepth[pinIdx],
      );
    }
  }
}

/**
 * @param {object} pathOverlay
 * @param {number} clickX
 * @param {number} clickY
 * @param {number} pinWorldX
 * @param {number} pinWorldY
 * @param {number} pinDepth
 */
function addPuppetPin(pathOverlay, clickX, clickY, pinWorldX, pinWorldY, pinDepth) {
  const nearestVertexIdx = findNearestVertexIndex(
    pathOverlay.deformedVertexCoords,
    clickX,
    clickY,
  );
  pathOverlay.pinVertexIndices.push(nearestVertexIdx);
  pathOverlay.pinWorldCoords.push(pinWorldX, pinWorldY);
  pathOverlay.pinOffsets.push(
    pathOverlay.deformedVertexCoords[nearestVertexIdx * 2] - clickX,
    pathOverlay.deformedVertexCoords[nearestVertexIdx * 2 + 1] - clickY,
  );
  pathOverlay.pinRotation.push(0);
  pathOverlay.pinOverlap.push(false);
  pathOverlay.pinDepth.push(pinDepth);
}

/**
 * @param {object} sourcePaths
 * @param {number[]} meshSettings
 * @param {object} [existingMeshDescriptor]
 * @returns {object}
 */
function buildPuppetMesh(sourcePaths, meshSettings, existingMeshDescriptor) {
  const nonAffineCorners = sourcePaths.nonAffineCorners;
  const meshDescriptor = FilterDefs.create("rigidTransform");
  if (nonAffineCorners) {
    for (let cornerIdx = 0; cornerIdx < 4; cornerIdx++) {
      meshDescriptor["PuX" + cornerIdx].v = nonAffineCorners[cornerIdx * 2];
      meshDescriptor["PuY" + cornerIdx].v = nonAffineCorners[cornerIdx * 2 + 1];
    }
  }
  const pathOverlays = buildContourPathOverlays(sourcePaths, meshSettings, meshDescriptor);
  if (existingMeshDescriptor) {
    copyPinsFromExistingMesh(pathOverlays, existingMeshDescriptor);
  }
  drawPuppetOverlay(pathOverlays, meshSettings, meshDescriptor);
  return meshDescriptor;
}

/**
 * @param {object} meshDescriptor
 * @param {number[]} meshSettings
 * @returns {object[]}
 */
function meshToPathOverlay(meshDescriptor, meshSettings) {
  const shapeEntries = meshDescriptor.puppetShapeList.v;
  const pathOverlays = [];
  for (let shapeIdx = 0; shapeIdx < shapeEntries.length; shapeIdx++) {
    const shapeDescriptor = shapeEntries[shapeIdx].v;
    meshSettings[0] = shapeDescriptor.meshRigidity.v - 1;
    meshSettings[1] = shapeDescriptor.meshQuality.v - 1;
    meshSettings[2] = shapeDescriptor.meshExpansion.v;
    const pathComponents = shapeDescriptor.meshBoundaryPath.v.pathComponents.v;
    if (pathComponents.length !== 0) {
      const subpathPoints = pathComponents[0].v.SbpL.v[0].v.Pts;
      subpathPoints.v = [];
    }
    const triangleIndices = new Uint32Array(new Uint8Array(shapeDescriptor.indexArray.v).buffer);
    const originalVertices = new Float32Array(
      new Uint8Array(shapeDescriptor.originalVertexArray.v).buffer,
    );
    const deformedVertices = new Float32Array(
      new Uint8Array(shapeDescriptor.deformedVertexArray.v).buffer,
    );
    const triangleIndexList = [];
    const restVertexCoords = [];
    const deformedVertexCoords = [];
    for (let triIdx = 0; triIdx < triangleIndices.length; triIdx++) {
      triangleIndexList.push(triangleIndices[triIdx]);
    }
    for (let vertexIdx = 0; vertexIdx < originalVertices.length; vertexIdx++) {
      restVertexCoords.push(originalVertices[vertexIdx]);
      deformedVertexCoords.push(deformedVertices[vertexIdx]);
    }
    pathOverlays.push({
      triangleIndices: triangleIndexList,
      restVertexCoords,
      solverRestCoords: deformedVertexCoords.slice(0),
      deformedVertexCoords,
      pinVertexIndices: unpackDoublesList(shapeDescriptor.pinVertexIndices),
      pinOffsets: unpackDoublesList(shapeDescriptor.pinOffsets),
      pinWorldCoords: unpackDoublesList(shapeDescriptor.posFinalPins),
      pinRotation: unpackDoublesList(shapeDescriptor.PnRt),
      pinOverlap: unpackDoublesList(shapeDescriptor.PnOv),
      pinDepth: unpackDoublesList(shapeDescriptor.PnDp),
      constraintSystem: null,
      selectedPinIndices: unpackDoublesList(shapeDescriptor.selectedPin),
    });
  }
  return pathOverlays;
}

/**
 * @param {object[]} pathOverlays
 * @param {number[]} meshSettings
 * @param {object} meshDescriptor
 */
function drawPuppetOverlay(pathOverlays, meshSettings, meshDescriptor) {
  const shapeEntries = meshDescriptor.puppetShapeList.v;
  for (let overlayIdx = 0; overlayIdx < shapeEntries.length; overlayIdx++) {
    const pathOverlay = pathOverlays[overlayIdx];
    const shapeDescriptor = shapeEntries[overlayIdx].v;
    shapeDescriptor.meshRigidity.v = meshSettings[0] + 1;
    shapeDescriptor.meshQuality.v = meshSettings[1] + 1;
    shapeDescriptor.meshExpansion.v = meshSettings[2];
    packTypedArrayToBytes(pathOverlay.triangleIndices, shapeDescriptor.indexArray.v, true);
    packTypedArrayToBytes(pathOverlay.restVertexCoords, shapeDescriptor.originalVertexArray.v);
    packTypedArrayToBytes(pathOverlay.deformedVertexCoords, shapeDescriptor.deformedVertexArray.v);
    const pinClickCoords = [];
    for (let pinIdx = 0; pinIdx < pathOverlay.pinVertexIndices.length; pinIdx++) {
      const vertexCoordOffset = pathOverlay.pinVertexIndices[pinIdx] * 2;
      const offsetPairIdx = pinIdx * 2;
      pinClickCoords[offsetPairIdx] =
        pathOverlay.restVertexCoords[vertexCoordOffset] - pathOverlay.pinOffsets[offsetPairIdx];
      pinClickCoords[offsetPairIdx + 1] =
        pathOverlay.restVertexCoords[vertexCoordOffset + 1] -
        pathOverlay.pinOffsets[offsetPairIdx + 1];
    }
    shapeDescriptor.PinP.v = wrapDescriptorValues(pinClickCoords, "doub");
    shapeDescriptor.pinVertexIndices.v = wrapDescriptorValues(pathOverlay.pinVertexIndices, "long");
    shapeDescriptor.pinOffsets.v = wrapDescriptorValues(pathOverlay.pinOffsets, "doub");
    shapeDescriptor.posFinalPins.v = wrapDescriptorValues(pathOverlay.pinWorldCoords, "doub");
    shapeDescriptor.PnRt.v = wrapDescriptorValues(pathOverlay.pinRotation, "long");
    shapeDescriptor.PnOv.v = wrapDescriptorValues(pathOverlay.pinOverlap, "bool");
    shapeDescriptor.PnDp.v = wrapDescriptorValues(pathOverlay.pinDepth, "doub");
    shapeDescriptor.selectedPin.v = wrapDescriptorValues(pathOverlay.selectedPinIndices, "long");
  }
}

export function PuppetWarpTool(nameKey, toolId, iconPath) {
  ToolBase.call(
    this,
    "tools.puppetWarp",
    ToolId.TOOL_PUPPET_WARP,
    "tools/transform",
  );
  this.puppetMeshSettings = [1, 1, 2, true];
  this.puppetMeshModeId = "rigidTransform";
  this.puppetSourcePaths = null;
  this.layerVectorMaskRef = null;
  this.puppetMesh = null;
  this.activePath = null;
  this.activePuppetPinIndex = null;
  this.puppetReservedState = null;
  this.pinnedVertexPairs = [];
}

function installPuppetWarpToolPrototype() {
  PuppetWarpTool.prototype.isActive = function () {
    return true;
  };

  PuppetWarpTool.prototype.canActivateWithGesture = function (doc, appData) {
    return PuppetWarpTool.canActivatePuppetWarp(doc);
  };

  PuppetWarpTool.prototype.enable = function (
    doc,
    dispatcher,
    appData,
    keyboard,
    embedInDialog,
    gestureOptions,
    wasPuppetWarpActive,
  ) {
    this.layerVectorMaskRef = gestureOptions.smartFilterRef;
    const filterRef = gestureOptions.smartFilterRef;
    let existingMeshDescriptor;
    let nonAffineCorners = null;
    if (filterRef) {
      const filterLayer = doc.layers[filterRef.layerIndex];
      if (filterLayer.add.placedData.filterFX != null) {
        const filterList = filterLayer.add.placedData.filterFX.v.filterFXList.v;
        if (filterList[filterRef.index]) {
          existingMeshDescriptor = JSON.parse(JSON.stringify(filterList[filterRef.index].v.Fltr.v));
        }
      }
    }
    const isNewMesh = existingMeshDescriptor == null;
    const targetLayer = doc.layers[doc.selectedLayerIndices[0]];
    let pixelBuffer = targetLayer.buffer;
    let layerRect = targetLayer.rect;
    const placedData = targetLayer.add.placedData;
    if (placedData) {
      const cornerTransform = placedData.nonAffineTransform.v;
      nonAffineCorners = [];
      for (let cornerIdx = 0; cornerIdx < 4; cornerIdx++) {
        nonAffineCorners.push(
          cornerTransform[cornerIdx * 2].v,
          cornerTransform[cornerIdx * 2 + 1].v,
        );
      }
      if (isNewMesh) {
        this.dispatchPuppetMeshHistory("edit", dispatcher);
      }
      const loadedPixels = targetLayer.getLinkedPlacedItem(doc);
      pixelBuffer = loadedPixels.buffer;
      layerRect = loadedPixels.rect;
    }
    this.puppetSourcePaths = {
      buffer: pixelBuffer.slice(0),
      rect: layerRect.clone(),
      nonAffineCorners,
    };
    if (isNewMesh) {
      existingMeshDescriptor = buildPuppetMesh(this.puppetSourcePaths, this.puppetMeshSettings);
    }
    this.puppetMesh = existingMeshDescriptor;
    this.activePath = meshToPathOverlay(this.puppetMesh, this.puppetMeshSettings);
    this.updatePuppetMeshDepths();
    this.refreshPuppetPreview(doc);
    if (isNewMesh) {
      this.redraw(dispatcher);
    }
    const toolGestureEvent = new AppEvent(EventType.uiDispatch, true);
    toolGestureEvent.data = {
      dispatchKind: UiCommand.forwardActiveToolGesture,
      routingChannel: this.id,
      puppetMeshSettings: this.puppetMeshSettings,
    };
    dispatcher.dispatch(toolGestureEvent);
    toolGestureEvent.data = {
      dispatchKind: UiCommand.splashOptionsUpdate,
      cursorOverlayId: "default",
    };
    dispatcher.dispatch(toolGestureEvent);
  };

  PuppetWarpTool.prototype.disable = function (doc, dispatcher, appData, keyboard) {
    if (this.activePath) {
      this.commitPuppetWarp(doc, dispatcher, true);
    }
  };

  PuppetWarpTool.prototype.updatePuppetMeshDepths = function (resolveMesh) {
    const pathOverlays = this.activePath;
    this.pinnedVertexPairs = [];
    for (let overlayIdx = 0; overlayIdx < pathOverlays.length; overlayIdx++) {
      const pathOverlay = pathOverlays[overlayIdx];
      for (let pinIdx = 0; pinIdx < pathOverlay.selectedPinIndices.length; pinIdx++) {
        this.pinnedVertexPairs.push([overlayIdx, pathOverlay.selectedPinIndices[pinIdx]]);
      }
      pathOverlay.constraintSystem = buildConstraintSystem(pathOverlay);
      if (resolveMesh) {
        solveDeformation(pathOverlay);
      }
    }
  };

  PuppetWarpTool.prototype.applyAction = function (actionPayload, dispatcher, doc, keyboard) {
    if (actionPayload.subAction === "commit") {
      this.commitPuppetWarp(doc, dispatcher, true);
    } else if (actionPayload.subAction === "cancel") {
      this.cancel(doc, dispatcher, true);
    } else if (actionPayload.subAction === "prm") {
      let meshSettingsChanged = false;
      for (let settingIdx = 0; settingIdx < 3; settingIdx++) {
        if (this.puppetMeshSettings[settingIdx] !== actionPayload.puppetMeshSettings[settingIdx]) {
          meshSettingsChanged = true;
        }
      }
      this.puppetMeshSettings = actionPayload.puppetMeshSettings;
      if (meshSettingsChanged) {
        this.puppetMesh = buildPuppetMesh(
          this.puppetSourcePaths,
          this.puppetMeshSettings,
          this.puppetMesh,
        );
        this.activePath = meshToPathOverlay(this.puppetMesh, this.puppetMeshSettings);
        this.updatePuppetMeshDepths(true);
        this.redraw(dispatcher);
      }
      this.refreshPuppetPreview(doc);
    } else if (actionPayload.subAction === "moveDepth") {
      const pathOverlays = this.activePath;
      for (let overlayIdx = 0; overlayIdx < pathOverlays.length; overlayIdx++) {
        const pathOverlay = pathOverlays[overlayIdx];
        for (let settingIdx = 0; settingIdx < pathOverlay.selectedPinIndices.length; settingIdx++) {
          const selectedPinIdx = pathOverlay.selectedPinIndices[settingIdx];
          pathOverlay.pinDepth[selectedPinIdx] += actionPayload.increasePinDepth ? 1 : -1;
        }
      }
      this.redraw(dispatcher);
    }
  };

  PuppetWarpTool.prototype.isModifierKey = function (keyCode, keyboard) {
    return keyCode === KeyboardHandler.Delete || keyCode === KeyboardHandler.Backspace;
  };

  PuppetWarpTool.prototype.onKeyEvent = function (doc, dispatcher, appData, keyboard) {
    const arrowMovement = keyboard.getArrowMovement();
    if (keyboard.isPressed(KeyboardHandler.Enter)) {
      this.commitPuppetWarp(doc, dispatcher, true);
    } else if (keyboard.isPressed(KeyboardHandler.Escape)) {
      this.cancel(doc, dispatcher, true);
    } else if (
      keyboard.isPressed(KeyboardHandler.Delete) ||
      keyboard.isPressed(KeyboardHandler.Backspace)
    ) {
      const pathOverlays = this.activePath;
      for (let overlayIdx = 0; overlayIdx < pathOverlays.length; overlayIdx++) {
        const pathOverlay = pathOverlays[overlayIdx];
        pathOverlay.selectedPinIndices.sort(function (pinIdxA, pinIdxB) {
          return pinIdxB - pinIdxA;
        });
        for (let pinIdx = 0; pinIdx < pathOverlay.selectedPinIndices.length; pinIdx++) {
          const selectedPinIdx = pathOverlay.selectedPinIndices[pinIdx];
          const coordOffset = selectedPinIdx * 2;
          pathOverlay.pinDepth.splice(selectedPinIdx, 1);
          pathOverlay.pinOverlap.splice(selectedPinIdx, 1);
          pathOverlay.pinRotation.splice(selectedPinIdx, 1);
          pathOverlay.pinVertexIndices.splice(selectedPinIdx, 1);
          pathOverlay.pinOffsets.splice(coordOffset, 2);
          pathOverlay.pinWorldCoords.splice(coordOffset, 2);
        }
        pathOverlay.selectedPinIndices = [];
        if (pathOverlay.pinVertexIndices.length === 0) {
          pathOverlay.solverRestCoords = pathOverlay.restVertexCoords.slice(0);
          pathOverlay.deformedVertexCoords = pathOverlay.restVertexCoords.slice(0);
        }
      }
      this.updatePuppetMeshDepths(true);
      this.redraw(dispatcher);
      this.refreshPuppetPreview(doc);
    } else if (arrowMovement.x !== 0 || arrowMovement.y !== 0) {
      this.offsetPinnedPuppetVertices(doc, arrowMovement.x, arrowMovement.y, dispatcher);
      this.dragStartPinWorldCoords = null;
    }
  };

  PuppetWarpTool.prototype.commitPuppetWarp = function (doc, dispatcher, focusChrome) {
    this.dispatchPuppetMeshHistory("confirm", dispatcher);
    this.escape(doc, dispatcher, focusChrome);
  };

  PuppetWarpTool.prototype.cancel = function (doc, dispatcher, focusChrome) {
    this.dispatchPuppetMeshHistory("cancel", dispatcher);
    this.escape(doc, dispatcher, focusChrome);
  };

  PuppetWarpTool.prototype.escape = function (doc, dispatcher, focusChrome) {
    doc.toolOverlayState.overlayTransform = null;
    doc.toolOverlayState.pinMarkerCoords = [];
    doc.dirty = true;
    this.activePath = null;
    const focusChromeEvent = new AppEvent(EventType.uiDispatch, true);
    focusChromeEvent.data = {
      dispatchKind: UiCommand.focusExtendedToolChrome,
    };
    if (focusChrome) {
      dispatcher.dispatch(focusChromeEvent);
    }
  };

  PuppetWarpTool.prototype.onMouseDown = function (doc, dispatcher, appData, keyboard, pointerState) {
    const docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
    const docX = docPoint.x;
    const docY = docPoint.y;
    const pathOverlays = this.activePath;
    let hitPinPair = null;
    let hitMeshOverlayIdx = -1;
    const pinHitRadius = (getDevicePixelRatio() * 5) / doc.pathViewport.zoomScale;
    for (let overlayIdx = 0; overlayIdx < pathOverlays.length; overlayIdx++) {
      const pathOverlay = pathOverlays[overlayIdx];
      const nearestPinIdx = findNearestVertexIndex(
        pathOverlay.pinWorldCoords,
        docX,
        docY,
        pinHitRadius,
      );
      if (nearestPinIdx !== -1) {
        hitPinPair = [overlayIdx, nearestPinIdx];
      }
      if (
        hitMeshOverlayIdx === -1 &&
        pointInTriangleMesh(
          pathOverlay.deformedVertexCoords,
          pathOverlay.triangleIndices,
          docX,
          docY,
        )
      ) {
        hitMeshOverlayIdx = overlayIdx;
      }
    }
    if (hitPinPair == null && hitMeshOverlayIdx !== -1) {
      const pathOverlay = pathOverlays[hitMeshOverlayIdx];
      addPuppetPin(pathOverlay, docX, docY, docX, docY, 0);
      hitPinPair = [hitMeshOverlayIdx, pathOverlay.pinVertexIndices.length - 1];
      pathOverlay.constraintSystem = buildConstraintSystem(pathOverlay);
    }
    this.activePuppetPinIndex = docPoint;
    if (hitPinPair) {
      const pinAlreadySelected =
        pathOverlays[hitPinPair[0]].selectedPinIndices.indexOf(hitPinPair[1]) !== -1;
      if (keyboard.isPressed(KeyboardHandler.Shift) && !pinAlreadySelected) {
        pathOverlays[hitPinPair[0]].selectedPinIndices.push(hitPinPair[1]);
        this.pinnedVertexPairs.push(hitPinPair);
      } else if (!pinAlreadySelected) {
        pathOverlays[hitPinPair[0]].selectedPinIndices = [hitPinPair[1]];
        this.pinnedVertexPairs = [hitPinPair];
      }
    }
    this.refreshPuppetPreview(doc);
  };

  PuppetWarpTool.prototype.onMouseMove = function (doc, dispatcher, appData, keyboard, pointerState) {
    const docPoint = doc.pathViewport.screenToDocPoint(pointerState.x, pointerState.y);
    const dragStartDocPoint = this.activePuppetPinIndex;
    if (dragStartDocPoint) {
      this.offsetPinnedPuppetVertices(
        doc,
        docPoint.x - dragStartDocPoint.x,
        docPoint.y - dragStartDocPoint.y,
        dispatcher,
      );
    }
  };

  PuppetWarpTool.prototype.offsetPinnedPuppetVertices = function (
    doc,
    deltaX,
    deltaY,
    dispatcher,
  ) {
    const overlaysToSolve = {};
    const pinnedPairs = this.pinnedVertexPairs;
    const pathOverlays = this.activePath;
    if (this.dragStartPinWorldCoords == null) {
      this.dragStartPinWorldCoords = [];
      for (let overlayIdx = 0; overlayIdx < pathOverlays.length; overlayIdx++) {
        this.dragStartPinWorldCoords.push(pathOverlays[overlayIdx].pinWorldCoords.slice(0));
      }
    }
    for (let pairIdx = 0; pairIdx < pinnedPairs.length; pairIdx++) {
      const pinPair = this.pinnedVertexPairs[pairIdx];
      const overlayIdx = pinPair[0];
      const pathOverlay = pathOverlays[pinPair[0]];
      const coordOffset = pinPair[1] * 2;
      pathOverlay.pinWorldCoords[coordOffset + 0] =
        this.dragStartPinWorldCoords[overlayIdx][coordOffset + 0] + deltaX;
      pathOverlay.pinWorldCoords[coordOffset + 1] =
        this.dragStartPinWorldCoords[overlayIdx][coordOffset + 1] + deltaY;
      overlaysToSolve[overlayIdx] = overlayIdx;
    }
    for (const overlayIdx in overlaysToSolve) {
      solveDeformation(this.activePath[overlaysToSolve[overlayIdx]]);
    }
    this.refreshPuppetPreview(doc);
    this.redraw(dispatcher);
  };

  PuppetWarpTool.prototype.dispatchPuppetMeshHistory = function (historyEventKind, dispatcher) {
    const historyEvent = new AppEvent(EventType.documentAction, true);
    historyEvent.routingChannel = EventChannel.EVENT_SMART_FILTER;
    historyEvent.data = {
      actionKind: historyEventKind,
      smartFilterRef: this.layerVectorMaskRef,
      operationId: this.puppetMeshModeId,
      operationData: this.puppetMesh,
    };
    dispatcher.dispatch(historyEvent);
  };

  PuppetWarpTool.prototype.onMouseUp = function (doc, dispatcher, appData, keyboard, pointerState) {
    this.activePuppetPinIndex = null;
    this.dragStartPinWorldCoords = null;
  };

  PuppetWarpTool.prototype.redraw = function (dispatcher) {
    drawPuppetOverlay(this.activePath, this.puppetMeshSettings, this.puppetMesh);
    this.dispatchPuppetMeshHistory("edit", dispatcher);
  };

  PuppetWarpTool.prototype.refreshPuppetPreview = function (doc) {
    const pathOverlays = this.activePath;
    doc.toolOverlayState.overlayTransform = {
      coords: [],
      commands: [],
    };
    doc.toolOverlayState.pinMarkerCoords = [];
    doc.toolOverlayState.selectedPinIndices = [];
    for (let overlayIdx = 0; overlayIdx < pathOverlays.length; overlayIdx++) {
      const pathOverlay = pathOverlays[overlayIdx];
      for (let pinIdx = 0; pinIdx < pathOverlay.selectedPinIndices.length; pinIdx++) {
        doc.toolOverlayState.selectedPinIndices.push(
          (doc.toolOverlayState.pinMarkerCoords.length >>> 1) +
            pathOverlay.selectedPinIndices[pinIdx],
        );
      }
      doc.toolOverlayState.pinMarkerCoords =
        doc.toolOverlayState.pinMarkerCoords.concat(pathOverlay.pinWorldCoords);
      if (this.puppetMeshSettings[3]) {
        appendPath(
          doc.toolOverlayState.overlayTransform,
          wireframeTrianglesToPath(
            pathOverlay.deformedVertexCoords,
            pathOverlay.triangleIndices,
          ),
        );
      }
    }
    doc.dirty = true;
  };
}

function installPuppetWarpToolStatics() {
  PuppetWarpTool.canActivatePuppetWarp = function (doc) {
    if (doc == null) {
      return false;
    }
    if (doc.selectedLayerIndices.length !== 1) {
      return false;
    }
    const targetLayer = doc.layers[doc.selectedLayerIndices[0]];
    return targetLayer.add.placedData || doc.ensureLayerEditableForTools(false);
  };
  PuppetWarpTool.addPuppetPin = addPuppetPin;
  PuppetWarpTool.buildPuppetMesh = buildPuppetMesh;
  PuppetWarpTool.meshToPathOverlay = meshToPathOverlay;
  PuppetWarpTool.drawPuppetOverlay = drawPuppetOverlay;
}

/**
 * Chain PuppetWarpTool onto TransformToolBase.
 */
export function installPuppetWarpTool() {
  PuppetWarpTool.prototype = Object.create(ToolBase.prototype);
  installPuppetWarpToolPrototype();
  installPuppetWarpToolStatics();
}
