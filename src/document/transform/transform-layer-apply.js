/**
 * Layer snapshot capture, restore, and raster / vector / smart-object apply
 * helpers for TransformToolBase static methods.
 */

import { Matrix2D, scaleIgnoringRotation } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { LayerStyleRenderer } from "../../features/layer-styles/style-renderer.js";
import { TextEngineData } from "../../features/text/text-engine.js";
import { TextLayout } from "../../features/text/text-layout.js";
import { TextRenderer } from "../../features/text/text-renderer.js";
import { rasterizeWithMatrix, transformPixels } from "../render/raster-transform.js";
import { isConvexTransformQuad } from "./transform-box.js";
import { applyVectorStrokeStyleSnapshot, getVectorStrokeStyleSnapshot } from "../model/layer.js";
import { packDoublesList, unpackDoublesList } from "../formats/psd/descriptor-codec.js";
import { transformSmartObjectFilters } from "../model/layer-translate.js";
import { allocBuffer, extractChannel, extractChannelByte } from "../../engine/compositing/buffer-utils.js";
import { copyPixels } from "../../engine/compositing/pixel-ops.js";
import { boundsFromCoordPairs, pixelAlignBoundsFromCoords } from "../../engine/compositing/anti-alias.js";
import { cornersToHomography, isAffine, toMatrix2D, transformPointsArray } from "../../engine/compositing/homography.js";
import { applyMatrixToPathRecords, applyMatrixToPathRecordsSmooth, boundsOfPathRecords } from "../../engine/compositing/selection-utils.js";
import { invalidateAllKeyOrigins, rebuildVectorMaskFromKeyOrigins, transformKeyOriginsWithMatrix } from "../../engine/compositing/key-origins.js";
import { invert } from "../../engine/compositing/color-math.js";
import { getWarpControlPoints, isIdentityWarp } from "../../engine/compositing/warp.js";

/** Negative index floor: paths (−1−pathIdx) vs extra channels (−1000−channelIdx). */
const PATH_TARGET_FLOOR = -1000;

/** Indices within each per-target layer snapshot tuple. */
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

/** @type {object} */

function targetFromIndex(doc, targetIndex) {
  if (targetIndex >= 0) return doc.layers[targetIndex];
  if (targetIndex > PATH_TARGET_FLOOR) return doc.paths[-1 - targetIndex];
  return doc.extraChannels[PATH_TARGET_FLOOR - targetIndex];
}

/**
 * Installs capture, restore, apply, and rasterize statics on TransformToolBase.
 * @param {Function} TransformToolBase
 */
export function installTransformLayerApplyStatics(TransformToolBase) {

  // Both live in render/raster-transform.js; the tool carries them for the
  // gesture code that reaches them through the active tool.
  TransformToolBase.transformPixels = transformPixels;
  TransformToolBase.rasterizeWithMatrix = rasterizeWithMatrix;

  TransformToolBase.getSelectionRect = function (doc, targetIndices, wasPuppetWarpActive) {
    if (targetIndices == null) {
      targetIndices = doc.resolveLayerSelection(true, null, null, true);
    }
    let unionRect = new Rect();
    if (doc.selectionMask && targetIndices.length === 1 && targetIndices[0] >= 0) {
      unionRect = doc.selectionMask.rect.clone();
    } else {
      for (let idx = 0; idx < targetIndices.length; idx++) {
        const targetIndex = targetIndices[idx];
        const target = targetFromIndex(doc, targetIndex);
        const vectorMask = target.add ? target.add.vmsk : null;
        const bounds =
          targetIndex >= 0
            ? target.getTransformBounds(doc, targetIndices.length === 1, false, wasPuppetWarpActive)
            : targetIndex > PATH_TARGET_FLOOR
              ? boundsOfPathRecords(
                  vectorMask.pathRecords,
                  targetIndices.length === 1 && vectorMask.C.length !== 0 ? vectorMask.C : null,
                )
              : target.rect.clone();
        unionRect = unionRect.union(bounds);
      }
    }
    return unionRect;
  };

  TransformToolBase.captureLayerSnapshots = function (
    doc,
    targetIndices,
    channelFilter,
    wasPuppetWarpActive,
  ) {
    const snapshots = [];
    for (let idx = 0; idx < targetIndices.length; idx++) {
      const targetIndex = targetIndices[idx];
      let target;
      let channelKinds;
      if (targetIndex >= 0) {
        target = doc.layers[targetIndex];
        channelKinds = target.getTransformableChannels(doc, channelFilter, wasPuppetWarpActive);
      } else if (targetIndex > PATH_TARGET_FLOOR) {
        target = doc.paths[-1 - targetIndex];
        channelKinds = [2];
      } else {
        snapshots.push([
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          doc.extraChannels[PATH_TARGET_FLOOR - targetIndex].clone(),
        ]);
        continue;
      }

      const channelSnapshot = [];
      if (channelKinds.indexOf(0) !== -1) {
        const rasterSnapshot = {
          rasterPair: [target.buffer.slice(0), target.rect.clone()],
        };
        channelSnapshot.push(rasterSnapshot);
        if (target.hasSmartFilters()) {
          const smartObjectRender = target.getLinkedPlacedItem(doc);
          rasterSnapshot.smartFilterBuffer = smartObjectRender.buffer.slice(0);
          rasterSnapshot.smartFilterRect = smartObjectRender.rect.clone();
        }
      } else {
        channelSnapshot.push(null);
      }
      if (channelKinds.indexOf(1) !== -1) {
        channelSnapshot.push(target.getMask().clone());
      } else {
        channelSnapshot.push(null);
      }
      if (channelKinds.indexOf(2) !== -1) {
        channelSnapshot.push({
          vectorMask: target.add.vmsk.clone(),
          StrokeStyleDefs: target.add.vstk ? JSON.parse(JSON.stringify(target.add.vstk)) : null,
          strokeFillSnapshot: target.add.vstk
            ? getVectorStrokeStyleSnapshot(doc, targetIndex)
            : null,
          KeyOrigins: target.add.vogk ? JSON.parse(JSON.stringify(target.add.vogk)) : null,
        });
      } else {
        channelSnapshot.push(null);
      }
      if (target.add.TySh && channelSnapshot[SNAPSHOT.RASTER]) {
        TextEngineData.syncCurveToVmsk(target.add.TySh);
        channelSnapshot.push(target.add.TySh.transform.clone());
      } else {
        channelSnapshot.push(null);
      }
      if (target.add.placedData && channelSnapshot[SNAPSHOT.RASTER]) {
        channelSnapshot.push(JSON.parse(JSON.stringify(target.add.placedData)));
      } else {
        channelSnapshot.push(null);
      }
      if (channelKinds.indexOf(3) !== -1) {
        channelSnapshot.push(target.getLinkedPlacedItem(doc).d.clone());
      } else {
        channelSnapshot.push(null);
      }
      if (target.add.lmfx) {
        channelSnapshot.push(JSON.stringify(target.add.lmfx));
      } else {
        channelSnapshot.push(null);
      }
      snapshots.push(channelSnapshot);
    }
    return snapshots;
  };

  TransformToolBase.restoreLayerSnapshots = function (doc, targetIndices, snapshots) {
    for (let idx = 0; idx < targetIndices.length; idx++) {
      const targetIndex = targetIndices[idx];
      const target = targetFromIndex(doc, targetIndex);
      const snapshot = snapshots[idx];
      if (snapshot[SNAPSHOT.RASTER]) {
        target.rect = snapshot[SNAPSHOT.RASTER].rasterPair[1].clone();
        target.buffer = snapshot[SNAPSHOT.RASTER].rasterPair[0].slice(0);
        if (target.hasSmartFilters()) {
          const smartObjectRender = target.getLinkedPlacedItem(doc);
          smartObjectRender.buffer = snapshot[SNAPSHOT.RASTER].smartFilterBuffer.slice(0);
          smartObjectRender.rect = snapshot[SNAPSHOT.RASTER].smartFilterRect.clone();
        }
      }
      if (snapshot[SNAPSHOT.MASK]) {
        target.getMask().channel = snapshot[SNAPSHOT.MASK].channel.slice(0);
        target.getMask().rect = snapshot[SNAPSHOT.MASK].rect.clone();
        target.getMask().maskCombineDirty = true;
      }
      if (snapshot[SNAPSHOT.VECTOR]) {
        target.add.vmsk = snapshot[SNAPSHOT.VECTOR].vectorMask.clone();
        if (snapshot[SNAPSHOT.VECTOR].strokeFillSnapshot) {
          applyVectorStrokeStyleSnapshot(
            target,
            snapshot[SNAPSHOT.VECTOR].strokeFillSnapshot,
          );
        }
        if (snapshot[SNAPSHOT.VECTOR].StrokeStyleDefs) {
          target.add.vstk = JSON.parse(JSON.stringify(snapshot[SNAPSHOT.VECTOR].StrokeStyleDefs));
        }
        if (snapshot[SNAPSHOT.VECTOR].KeyOrigins) {
          target.add.vogk = JSON.parse(JSON.stringify(snapshot[SNAPSHOT.VECTOR].KeyOrigins));
        }
      }
      if (snapshot[SNAPSHOT.TEXT_MATRIX]) {
        target.add.TySh.transform = snapshot[SNAPSHOT.TEXT_MATRIX].clone();
        TextEngineData.syncVmskToCurve(target.add.TySh);
      }
      if (snapshot[SNAPSHOT.PLACED_DATA]) {
        target.add.placedData = JSON.parse(JSON.stringify(snapshot[SNAPSHOT.PLACED_DATA]));
      }
      if (snapshot[SNAPSHOT.LINKED_CHANNEL]) {
        const linkedChannel = target.getLinkedPlacedItem(doc).d;
        linkedChannel.channel = snapshot[SNAPSHOT.LINKED_CHANNEL].channel.slice(0);
        linkedChannel.rect = snapshot[SNAPSHOT.LINKED_CHANNEL].rect.clone();
      }
      if (snapshot[SNAPSHOT.LAYER_EFFECTS]) {
        target.add.lmfx = JSON.parse(snapshot[SNAPSHOT.LAYER_EFFECTS]);
      }
      if (snapshot[SNAPSHOT.EXTRA_CHANNEL]) {
        target.channel = snapshot[SNAPSHOT.EXTRA_CHANNEL].channel.slice(0);
        target.rect = snapshot[SNAPSHOT.EXTRA_CHANNEL].rect.clone();
        target.maskCombineDirty = true;
      }
      if (targetIndex >= 0) {
        target.invalidate(doc);
        target.markDirty();
      }
    }
    doc.markDirty();
  };

  TransformToolBase.applyTransformToLayers = function (
    doc,
    fontRegistry,
    targetIndices,
    layerSnapshots,
    interpolationMode,
    homographyOrArray,
    warpMesh,
    scaleEffects,
    clipRect,
    contentAwareFlag,
  ) {
    if (typeof homographyOrArray[0] === "number") {
      const homographyPerLayer = [];
      for (let idx = 0; idx < targetIndices.length; idx++) {
        homographyPerLayer[idx] = homographyOrArray;
      }
      homographyOrArray = homographyPerLayer;
    }
    for (let idx = 0; idx < targetIndices.length; idx++) {
      const layerHomography = homographyOrArray[idx];
      const layerMatrix = toMatrix2D(layerHomography);
      const scaleFactor = scaleIgnoringRotation(layerMatrix);
      const targetIndex = targetIndices[idx];
      const target = targetFromIndex(doc, targetIndex);
      const snapshot = layerSnapshots[idx];
      if (snapshot[SNAPSHOT.RASTER] && target.add.lmfx && scaleEffects) {
        LayerStyleRenderer.scaleLayerEffectSizes(target.add.lmfx, scaleFactor);
      }
      if (
        snapshot[SNAPSHOT.RASTER] &&
        !snapshot[SNAPSHOT.TEXT_MATRIX] &&
        !snapshot[SNAPSHOT.PLACED_DATA] &&
        !snapshot[SNAPSHOT.LINKED_CHANNEL]
      ) {
        let rasterPair = snapshot[SNAPSHOT.RASTER].rasterPair;
        if (clipRect) {
          const clipRectClone = clipRect.clone();
          const clipBuffer = allocBuffer(clipRectClone.area() * 4);
          copyPixels(rasterPair[0], rasterPair[1], clipBuffer, clipRectClone);
          rasterPair = [clipBuffer, clipRectClone];
        }
        const rasterResult = TransformToolBase.rasterizeWithMatrix(
          rasterPair,
          interpolationMode,
          layerHomography,
          warpMesh,
          interpolationMode === 0 ? target.buffer.buffer : null,
          null,
          null,
          contentAwareFlag,
        );
        if (rasterResult) {
          target.rect = rasterResult.rect;
          target.buffer = rasterResult.buffer;
        }
      }
      if (snapshot[SNAPSHOT.MASK]) {
        TransformToolBase.transformChannelMask(
          doc,
          snapshot[SNAPSHOT.MASK],
          target.getMask(),
          interpolationMode,
          layerHomography,
          warpMesh,
        );
      }
      if (snapshot[SNAPSHOT.VECTOR]) {
        const hasWarp = warpMesh && !isIdentityWarp(warpMesh);
        const vectorMaskClone = snapshot[SNAPSHOT.VECTOR].vectorMask.clone();
        let useComponentSelection = targetIndices.length === 1 && vectorMaskClone.C.length !== 0;
        const multiComponentSelected =
          targetIndices.length === 1 && vectorMaskClone.selectedComponents.length > 1;
        if (multiComponentSelected) {
          useComponentSelection = false;
        }
        const componentIndices = useComponentSelection ? vectorMaskClone.C : null;
        const selectedComponents = multiComponentSelected
          ? vectorMaskClone.selectedComponents
          : null;
        if (hasWarp) {
          const warpControlPoints = getWarpControlPoints(warpMesh);
          transformPointsArray(layerHomography, warpControlPoints);
          applyMatrixToPathRecordsSmooth(
            vectorMaskClone.pathRecords,
            warpControlPoints,
            componentIndices,
            selectedComponents,
          );
        } else {
          applyMatrixToPathRecords(
            vectorMaskClone.pathRecords,
            layerHomography,
            componentIndices,
            selectedComponents,
          );
        }
        if (target.add.vstk && scaleEffects) {
          target.add.vstk.strokeStyleLineWidth.v.val =
            snapshot[SNAPSHOT.VECTOR].StrokeStyleDefs.strokeStyleLineWidth.v.val * scaleFactor;
          let strokeStyleSnapshot = snapshot[SNAPSHOT.VECTOR].strokeFillSnapshot;
          if (strokeStyleSnapshot && strokeStyleSnapshot.fillKind === 3) {
            strokeStyleSnapshot = JSON.parse(JSON.stringify(strokeStyleSnapshot));
            const dashPhase = strokeStyleSnapshot.fillDescriptor.phase.v;
            strokeStyleSnapshot.fillDescriptor.Scl.v.val = Math.round(
              strokeStyleSnapshot.fillDescriptor.Scl.v.val * scaleFactor,
            );
            dashPhase.Hrzn.v = Math.round(dashPhase.Hrzn.v * scaleFactor);
            dashPhase.Vrtc.v = Math.round(dashPhase.Vrtc.v * scaleFactor);
            applyVectorStrokeStyleSnapshot(target, strokeStyleSnapshot);
          }
        }
        if (target.add.vogk) {
          target.add.vogk = JSON.parse(JSON.stringify(snapshot[SNAPSHOT.VECTOR].KeyOrigins));
          if (hasWarp || multiComponentSelected) {
            invalidateAllKeyOrigins(target.add.vogk);
          } else {
            transformKeyOriginsWithMatrix(
              target.add.vogk,
              layerHomography,
              targetIndices.length > 1 ? [] : vectorMaskClone.C,
              scaleEffects,
            );
          }
          vectorMaskClone.feather *= scaleFactor;
          target.add.vmsk = vectorMaskClone;
          if (target.add.vogk) {
            rebuildVectorMaskFromKeyOrigins(target.add.vogk, target.add.vmsk);
          }
        } else {
          vectorMaskClone.feather *= scaleFactor;
          target.add.vmsk = vectorMaskClone;
        }
      }
      if (snapshot[SNAPSHOT.TEXT_MATRIX]) {
        const textMatrix = snapshot[SNAPSHOT.TEXT_MATRIX].clone();
        textMatrix.concat(layerMatrix);
        target.add.TySh.transform = textMatrix;
        TextEngineData.syncVmskToCurve(target.add.TySh);
        const curveData = new TextLayout(target.add.TySh.engineData, fontRegistry);
        const textRender = TextRenderer.renderText(curveData, target.add.TySh);
        target.rect = textRender.rect;
        target.buffer = textRender.buffer;
      }
      if (snapshot[SNAPSHOT.PLACED_DATA]) {
        const placedData = target.add.placedData;
        let cornerCoords = unpackDoublesList(snapshot[SNAPSHOT.PLACED_DATA].nonAffineTransform);
        transformPointsArray(layerHomography, cornerCoords);
        const alignedBounds = pixelAlignBoundsFromCoords(cornerCoords);
        if (isConvexTransformQuad(cornerCoords)) {
          if (warpMesh) {
            const warpBounds = boundsFromCoordPairs(
              getWarpControlPoints(snapshot[SNAPSHOT.PLACED_DATA].warp.v),
            );
            const warpHomography = cornersToHomography(
              cornerCoords,
              warpBounds,
            );
            const identityCorners = boundsFromCoordPairs(
              getWarpControlPoints(warpMesh),
            );
            cornerCoords = [
              identityCorners.x,
              identityCorners.y,
              identityCorners.x + identityCorners.width,
              identityCorners.y,
              identityCorners.x + identityCorners.width,
              identityCorners.y + identityCorners.height,
              identityCorners.x,
              identityCorners.y + identityCorners.height,
            ];
            transformPointsArray(warpHomography, cornerCoords);
            placedData.warp.v = warpMesh;
          }
          let outputHomography = cornersToHomography(cornerCoords);
          let outputCorners = cornerCoords;
          if (!isAffine(outputHomography)) {
            outputHomography[6] = outputHomography[7] = 0;
            outputCorners = [0, 0, 1, 0, 1, 1, 0, 1];
            transformPointsArray(outputHomography, outputCorners);
          }
          placedData.Trnf = packDoublesList(outputCorners);
          placedData.nonAffineTransform = packDoublesList(cornerCoords);
          if (placedData.filterFX) {
            placedData.filterFX = JSON.parse(JSON.stringify(snapshot[SNAPSHOT.PLACED_DATA].filterFX));
          }
          transformSmartObjectFilters(placedData, layerMatrix);
          target.rasterizeSmartObject(doc, interpolationMode === 0);
        }
      }
      if (snapshot[SNAPSHOT.LINKED_CHANNEL]) {
        TransformToolBase.transformChannelMask(
          doc,
          snapshot[SNAPSHOT.LINKED_CHANNEL],
          target.getLinkedPlacedItem(doc).d,
          interpolationMode,
          layerHomography,
          warpMesh,
        );
      }
      if (snapshot[SNAPSHOT.EXTRA_CHANNEL]) {
        TransformToolBase.transformChannelMask(
          doc,
          snapshot[SNAPSHOT.EXTRA_CHANNEL],
          target,
          interpolationMode,
          layerHomography,
          warpMesh,
        );
      }
      if (targetIndex >= 0) {
        if (interpolationMode !== 0) {
          target.trimToContent();
        }
        target.invalidate(doc);
        target.markDirty();
      }
    }
    doc.markDirty();
  };

  TransformToolBase.transformChannelMask = function (
    doc,
    maskSnapshot,
    maskTarget,
    interpolationMode,
    homography,
    warpMesh,
  ) {
    if (maskSnapshot.color === 255) {
      invert(maskSnapshot.channel);
    }
    const snapshotRect = maskSnapshot.rect;
    const rgbaBuffer = allocBuffer(snapshotRect.area() * 4);
    extractChannel(maskSnapshot.channel, rgbaBuffer, 3);
    const rasterResult = TransformToolBase.rasterizeWithMatrix(
      [rgbaBuffer, snapshotRect],
      interpolationMode,
      homography,
      warpMesh,
    );
    if (rasterResult) {
      maskTarget.rect = rasterResult.rect;
      maskTarget.channel = allocBuffer(rasterResult.rect.area());
      extractChannelByte(rasterResult.buffer, maskTarget.channel, 3);
      maskTarget.maskCombineDirty = true;
    }
    if (maskSnapshot.color === 255) {
      invert(maskSnapshot.channel);
      if (rasterResult) {
        invert(maskTarget.channel);
      }
    }
  };


}
