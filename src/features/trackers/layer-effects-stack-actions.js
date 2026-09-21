/**
 * Layer-stack mutations (add, remove, reorder, merge, smart-object, timeline)
 * attached onto LayerEffectsTracker.actionHandlers.
 */
import { LayerEffectsTracker } from "./layer-effects-tracker.js";
import { TrackerRegistry } from "./tracker-registry.js";
import { Point } from "../../core/math/point.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { Locale } from "../../core/i18n/locale.js";
import { replaceFileExtension } from "../../core/file-names.js";
import { KeyboardHandler } from "../../core/keyboard-handler.js";

import { BaseTool } from "../../ui/widgets/base-tool.js";
import { FileFormatRegistry } from "../../document/formats/registry/file-format-registry.js";
import { TextRenderer } from "../text/text-renderer.js";
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { AdjustmentEngine } from "../adjustments/adjustment-engine.js";
import { FilterDefs } from "../filters/filter-apply.js";
import { Layer, LayerSectionType } from "../../document/model/layer.js";
import { Document} from "../../document/model/document.js";
import { TextLayout } from "../text/text-layout.js";
import { ActionDescUtil } from "../scripting/action-desc.js";
import { LayerStyleRenderer } from "../layer-styles/style-renderer.js";
import { findPattern } from "../../document/formats/psd/layer-data-parsers.js";
import { Mask, VectorMask } from "../../document/model/layer-masks.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";
import { allocBuffer, extractChannel, extractChannelByte, fillBuffer } from "../../engine/compositing/buffer-utils.js";
import { computeContentBoundsRgba, copyPixels, hasNonOpaquePixels, round } from "../../engine/compositing/pixel-ops.js";
import { buildCanvasPathRecords, splitPathBySubpathId } from "../../engine/compositing/anti-alias.js";
import { rectanglePathRecords, regularPolygonPathRecords } from "../../engine/compositing/shape-primitives.js";

import { keyOriginFromShapeDescriptor, rebuildVectorMaskFromKeyOrigins, unitRectToBBoxArray } from "../../engine/compositing/key-origins.js";
import { transformPathRecordCoords } from "../../engine/compositing/path-records.js";
import { composite } from "../../engine/compositing/compositing-ops.js";
import {
  commitHistoryAndRedo,
  buildReplaceStackHistoryData,
  createHistoryEntry,
  findDurationBucketIndex,
  resolveSelectedLayerIndices,
} from "./layer-effects-action-helpers.js";
import { solvePoissonFill } from "../../engine/compositing/content-aware-fill.js";

const actionHandlers = LayerEffectsTracker.actionHandlers;

const FILL_KIND_BY_CLASS_ID = {
  solidColorLayer: 0,
  gradientLayer: 1,
  patternLayer: 2,
};
const FILL_LAYER_KEYS = ["SoCo", "GdFl", "PtFl"];
const FILL_LAYER_NAME_KEYS = [
  "layer.newFillLayer.colourFill",
  "layer.newFillLayer.gradientFill",
  "layer.newFillLayer.patternFill",
];
const SHAPE_TOOL_HISTORY_LABELS = {
  Rctn: "tools.rectangle",
  Ln: "tools.line",
  Elps: "tools.ellipse",
  Plgn: "properties.shapeType.polygon",
  customShape: "tools.customShape",
};

function compareAscending(leftIdx, rightIdx) {
  return leftIdx - rightIdx;
}

function compareDurationDesc(leftEntry, rightEntry) {
  return rightEntry[2] - leftEntry[2];
}

function compareOriginalFolderIndex(leftEntry, rightEntry) {
  return leftEntry[3] - rightEntry[3];
}

/**
 * Push a replace-stack history entry and immediately redo it.
 * @param {object} tracker
 * @param {object} doc
 * @param {string} historyLabel
 * @param {object[]} layersAfter
 * @param {number[]} selectedLayerIndicesAfter
 * @param {object} [extra]
 */
function commitReplaceStack(tracker, doc, historyLabel, layersAfter, selectedLayerIndicesAfter, extra) {
  const historyEntry = createHistoryEntry(
    historyLabel,
    tracker,
    buildReplaceStackHistoryData(doc, layersAfter, selectedLayerIndicesAfter, extra),
  );
  commitHistoryAndRedo(tracker, doc, historyEntry);
}

/**
 * Remap placed-item tags when pasting layers from one document into another.
 * @param {object} sourceDoc
 * @param {object} destDoc
 * @param {object[]} layersToInsert
 */
function remapPlacedItemTagsAcrossDocuments(sourceDoc, destDoc, layersToInsert) {
  const placedItemTags = [];
  const remappedTags = [];
  for (let loopIdx = 0; loopIdx < layersToInsert.length; loopIdx++) {
    const loopLayer = layersToInsert[loopIdx];
    if (loopLayer.add.placedData == null) continue;
    const placedItemTag = loopLayer.add.placedData.Idnt.v;
    if (placedItemTags.indexOf(placedItemTag) == -1) {
      placedItemTags.push(placedItemTag);
      remappedTags.push(Document.generateUID());
    }
    loopLayer.add.placedData.Idnt.v = remappedTags[placedItemTags.indexOf(placedItemTag)];
    const sourceFileLoader = loopLayer.getLinkedPlacedItem(sourceDoc);
    if (sourceFileLoader) {
      sourceDoc.removePlacedItemId(sourceFileLoader);
      destDoc.addPlacedItemId(sourceFileLoader);
    }
  }
  if (placedItemTags.length > 0) {
    if (destDoc.add.lnk2 == null) destDoc.add.lnk2 = [];
    for (let loopIdx = 0; loopIdx < placedItemTags.length; loopIdx++) {
      const sourceLinkedItem = sourceDoc.findLinkedItemByTag(placedItemTags[loopIdx]);
      const clonedLinkedItem = sourceLinkedItem.clone();
      clonedLinkedItem.tag = remappedTags[loopIdx];
      destDoc.add.lnk2.push(clonedLinkedItem);
    }
  }
}

/**
 * Merge selected layers: concatenate vector masks, rasterize into bounds, or flatten via a smart object.
 * @param {object} doc
 * @param {number[]} sortedSelection
 * @param {boolean} allLayersHaveVectorContent
 * @param {Rect} mergeBoundsRect
 * @param {Rect} documentBounds
 * @returns {object}
 */
function mergeSelectedLayersToLayer(doc, sortedSelection, allLayersHaveVectorContent, mergeBoundsRect, documentBounds) {
  if (allLayersHaveVectorContent) {
    const mergedLayer = doc.layers[sortedSelection[0]].clone();
    const combinedVectorMask = mergedLayer.add.vmsk;
    for (let loopIdx = 1; loopIdx < sortedSelection.length; loopIdx++) {
      const sourceLayer = doc.layers[sortedSelection[loopIdx]];
      const sourcePathRecords = VectorMask.clonePathRecords(sourceLayer.add.vmsk.pathRecords);
      combinedVectorMask.pathRecords = combinedVectorMask.pathRecords.concat(sourcePathRecords.slice(2));
      mergedLayer.add.vogk = mergedLayer.add.vogk.concat(JSON.parse(JSON.stringify(sourceLayer.add.vogk)));
    }
    mergedLayer.add.vmsk.maskCombineDirty = true;
    mergedLayer.invalidate(doc);
    return mergedLayer;
  }
  if (documentBounds.containsRect(mergeBoundsRect)) {
    const mergedLayer = doc.newLayer();
    mergedLayer.setName(doc.layers[sortedSelection[sortedSelection.length - 1]].getName());
    mergedLayer.rect = mergeBoundsRect;
    mergedLayer.buffer = allocBuffer(mergeBoundsRect.area() * 4);
    const rasterPixels = doc.getRasterData(sortedSelection);
    copyPixels(rasterPixels, documentBounds, mergedLayer.buffer, mergeBoundsRect);
    mergedLayer.markDirty();
    return mergedLayer;
  }
  doc.mergeLayersToSmartObject(sortedSelection, true);
  const mergedLayer = doc.layers[doc.selectedLayerIndices[0]];
  doc.layers.splice(doc.selectedLayerIndices[0], 1);
  const linkedItem = doc.findLinkedItemByTag(mergedLayer.add.placedData.Idnt.v);
  doc.add.lnk2.splice(doc.add.lnk2.indexOf(linkedItem), 1);
  delete mergedLayer.add.placedData;
  return mergedLayer;
}

/**
 * Apply fill, vector mask, and stroke from a new-shape-layer action descriptor.
 * @param {object} newLayer
 * @param {object} event
 * @param {object} doc
 * @param {object} appData
 * @returns {{ shapeDesc: *, fillKindIndex: number, fillLayerDefaultName?: string }}
 */
function buildNewShapeLayerFill(newLayer, event, doc, appData) {
  const fillActionDesc = event.actionDescriptor;
  const usingDesc = fillActionDesc.Usng.v;
  const fillTypeDesc = usingDesc.Type.v;
  const shapeDesc = usingDesc.Shp;
  if (shapeDesc == null) {
    applyWorkPathOrSelectionMask(newLayer, doc);
  } else {
    applyShapeDescriptorGeometry(newLayer, usingDesc, shapeDesc, appData);
  }
  const fillKindIndex = FILL_KIND_BY_CLASS_ID[fillTypeDesc.classID];
  const fillLayerKey = FILL_LAYER_KEYS[fillKindIndex];
  newLayer.add[fillLayerKey] = LayerEffectDefs.getFillLayerDefault(fillKindIndex);
  LayerEffectsTracker.copyContentFillToDescriptor(fillTypeDesc, newLayer.add[fillLayerKey], fillKindIndex);
  let fillLayerDefaultName;
  if (shapeDesc == null) fillLayerDefaultName = Locale.get(FILL_LAYER_NAME_KEYS[fillKindIndex]);
  if (fillLayerKey == "PtFl") {
    doc.registerPattern(findPattern(newLayer.add[fillLayerKey].Ptrn.v, appData.patternPresets));
  }
  newLayer.invalidate(doc);
  return { shapeDesc, fillKindIndex, fillLayerDefaultName };
}

function applyWorkPathOrSelectionMask(newLayer, doc) {
  const pathsTuple = doc.getPaths();
  const pathsByName = pathsTuple[0];
  const activePathIndices = pathsTuple[1];
  if (activePathIndices.length != 0) {
    const pathLayerAdd = pathsByName[activePathIndices[0]].add;
    newLayer.add.vmsk = pathLayerAdd.vmsk.clone();
    newLayer.add.vstk = LayerEffectDefs.getStrokeStyleDefault();
    newLayer.add.vogk = JSON.parse(JSON.stringify(pathLayerAdd.vogk));
    doc.selectedWorkPaths = [];
  } else {
    newLayer.d = LayerEffectsTracker.cloneMaskFromActiveMask(doc);
  }
}

function applyShapeDescriptorGeometry(newLayer, usingDesc, shapeDesc, appData) {
  newLayer.add.vmsk = new VectorMask();
  newLayer.add.vstk = usingDesc.strokeStyle
    ? JSON.parse(JSON.stringify(usingDesc.strokeStyle.v))
    : LayerEffectDefs.getStrokeStyleDefault();
  newLayer.add.vogk = [];
  if (shapeDesc) {
    const shapeKeyOrigin = keyOriginFromShapeDescriptor(shapeDesc);
    if (shapeKeyOrigin) {
      newLayer.add.vogk = [shapeKeyOrigin];
      newLayer.add.vmsk.pathRecords.push({
        type: 0,
        fillRule: 1,
        length: 0,
      });
      rebuildVectorMaskFromKeyOrigins(newLayer.add.vogk, newLayer.add.vmsk);
    } else {
      const shapeValue = shapeDesc.v;
      const shapeClassId = shapeValue.classID;
      if (shapeClassId == "Plgn") {
        let polygonCenter = shapeValue.Cntr.v;
        let polygonCorner = shapeValue.corner.v;
        polygonCenter = new Point(polygonCenter.Hrzn.v.val, polygonCenter.Vrtc.v.val);
        polygonCorner = new Point(polygonCorner.Hrzn.v.val, polygonCorner.Vrtc.v.val);
        newLayer.add.vmsk.pathRecords = regularPolygonPathRecords(
          polygonCenter.x,
          polygonCenter.y,
          Math.sqrt(polygonCorner.x * polygonCorner.x + polygonCorner.y * polygonCorner.y),
          Math.atan2(polygonCorner.y, polygonCorner.x),
          shapeValue.sides.v,
          0,
        );
      } else if (shapeClassId == "customShape") {
        const shapeBBox = unitRectToBBoxArray(shapeValue);
        const shapeWidth = shapeBBox[2] - shapeBBox[0];
        const shapeHeight = shapeBBox[3] - shapeBBox[1];
        const customShapes = appData.customShapePresets;
        let matchingShape;
        let pathRecords;
        for (let loopIdx = 0; loopIdx < customShapes.length; loopIdx++) {
          if (customShapes[loopIdx].categoryName == shapeValue.Nm.v) matchingShape = customShapes[loopIdx];
        }
        if (matchingShape) {
          pathRecords = VectorMask.clonePathRecords(matchingShape.pathRecords);
          transformPathRecordCoords(
            pathRecords,
            new Matrix2D(shapeWidth, 0, 0, shapeHeight, shapeBBox[0], shapeBBox[1]),
          );
        } else {
          pathRecords = rectanglePathRecords(
            shapeBBox[0],
            shapeBBox[1],
            shapeWidth,
            shapeHeight,
            0,
          );
        }
        newLayer.add.vmsk.pathRecords = pathRecords;
      }
      newLayer.updateVectorOrigins();
    }
  }
}

/**
 * Splice index for a newly created layer; may replace an empty pixel placeholder.
 * @param {object} doc
 * @param {object} event
 * @param {*} eventCode
 * @param {object} newLayer
 * @returns {{ insertIndex: number, replaceEmptyLayer: boolean }}
 */
function chooseNewLayerInsertIndex(doc, event, eventCode, newLayer) {
  let replaceEmptyLayer = false;
  const anchorLayerIndex =
    doc.selectedLayerIndices.length == 0
      ? doc.layers.length - 1
      : doc.selectedLayerIndices[doc.selectedLayerIndices.length - 1];
  const anchorLayer = doc.layers[anchorLayerIndex];
  let insertIndex;
  if (eventCode == Layer.newShapeLayer && anchorLayer.hasPixelData() && anchorLayer.rect.isEmpty()) {
    replaceEmptyLayer = true;
    newLayer.setName(anchorLayer.getName());
    insertIndex = anchorLayerIndex;
  } else {
    insertIndex = anchorLayerIndex + 1;
    if (anchorLayer && anchorLayer.add.lsct == LayerSectionType.OpenGroup) insertIndex--;
  }
  if (event.insertBelowTarget) insertIndex = Math.max(0, insertIndex - 1);
  return { insertIndex, replaceEmptyLayer };
}

/**
 * History locale key for a new-layer family action.
 * @param {object} event
 * @param {*} eventCode
 * @returns {string}
 */
function historyLabelForNewLayer(event, eventCode) {
  let historyActionId = "clipboard.paste";
  if (eventCode == Layer.newLayer) historyActionId = "layer.newLayer";
  if (eventCode == Layer.newAdjustmentLayer) historyActionId = "layer.newAdjustmentLayer";
  if (eventCode == Layer.newShapeLayer) {
    historyActionId = "layer.newFillLayer.title";
    const shapeDesc = event.actionDescriptor.Usng.v.Shp;
    if (shapeDesc) {
      const shapeToolHistoryId = SHAPE_TOOL_HISTORY_LABELS[shapeDesc.v.classID];
      if (shapeToolHistoryId) historyActionId = shapeToolHistoryId;
    }
  }
  if (eventCode == Layer.newLayerViaCopy) {
    historyActionId = "layer.layerViaCopy";
  }
  if (eventCode == Layer.newLayerViaCut) {
    historyActionId = "layer.layerViaCut";
  }
  return historyActionId;
}

function applyNewLayerViaCopy(newLayer, doc) {
  const sourceLayer = doc.layers[doc.selectedLayerIndices[0]];
  const selectionPixels = sourceLayer.extractSelectionData(doc, doc.selectionMask);
  if (selectionPixels == null) {
    showToast("Copied area is empty");
    return false;
  }
  newLayer.rect = selectionPixels.rect;
  newLayer.buffer = selectionPixels.pixBuf;
  newLayer.rasterize(doc);
  return true;
}

/**
 * Layer via Cut: fill `newLayer` with the selected pixels and return a copy of the
 * source layer with those pixels erased. The caller substitutes that copy into the
 * same stack commit, so the lift and the erase undo as one step. Returns null when
 * the selection and the layer's content do not overlap.
 */
function applyNewLayerViaCut(newLayer, doc) {
  const sourceLayer = doc.layers[doc.selectedLayerIndices[0]];
  const selectionPixels = sourceLayer.extractSelectionData(doc, doc.selectionMask, true);
  if (selectionPixels == null) {
    showToast("Copied area is empty");
    return null;
  }
  newLayer.rect = selectionPixels.rect;
  newLayer.buffer = selectionPixels.pixBuf;
  newLayer.rasterize(doc);
  const cutSourceLayer = sourceLayer.clone();
  cutSourceLayer.rect = selectionPixels.cutRect;
  cutSourceLayer.buffer = selectionPixels.cutBuffer;
  return cutSourceLayer;
}

function applyNewLayerFromClipboard(newLayer, event, doc) {
  newLayer.rect = LayerEffectsTracker.getLayerBoundsForMask(event.clipboardPixelPayload, doc);
  newLayer.buffer = event.clipboardPixelPayload.buffer.slice(0);
  if (event.pasteIntoSelection && doc.selectionMask) {
    newLayer.d = new Mask();
    newLayer.d.rect = doc.selectionMask.rect;
    newLayer.d.color = 0;
    newLayer.d.channel = doc.selectionMask.channel.slice(0);
  }
}

function applyNewAdjustmentLayer(newLayer, event, doc) {
  newLayer.layerFlags |= 16;
  const usingDesc = event.actionDescriptor.Usng.v;
  const typeDesc = usingDesc.Type.v;
  const adjustmentKey = AdjustmentEngine.figmaDescriptorKeys[typeDesc.classID];
  const defaultLayerName = Locale.get(AdjustmentEngine.names[adjustmentKey]);
  const customName = usingDesc.Nm ? usingDesc.Nm.v : undefined;
  newLayer.add[adjustmentKey] = FilterDefs.create(adjustmentKey);
  if (newLayer.add[adjustmentKey] == null) newLayer.add[adjustmentKey] = {};
  for (const propKey in typeDesc) {
    newLayer.add[adjustmentKey][propKey] = JSON.parse(JSON.stringify(typeDesc[propKey]));
  }
  newLayer.d = LayerEffectsTracker.cloneMaskFromActiveMask(doc);
  return { defaultLayerName, customName, hasDescriptorName: !!usingDesc.Nm };
}

/**
 * Resolve the drop / arrange target for a layer move.
 * @param {object} event
 * @param {*} eventCode
 * @param {object} doc
 * @param {number} sourceLayerIndex
 * @param {number[]} affectedLayerIndices
 * @returns {{ targetIndex: number, insertBeforeTarget: boolean }|null}
 */
function resolveMoveTargetIndex(event, eventCode, doc, sourceLayerIndex, affectedLayerIndices) {
  let targetIndex;
  let insertBeforeTarget;
  if (eventCode == Layer.moveLayer) {
    targetIndex = event.target;
    insertBeforeTarget = event.dropPositionRatio > 0.5;
  } else if (event.target != null) {
    targetIndex = event.target;
    insertBeforeTarget = true;
    doc.needsScrollToSelected = true;
  } else {
    const moveOperation = event.operation;
    insertBeforeTarget = moveOperation > 1;
    if (moveOperation == 0) {
      targetIndex = doc.layers.length - 1;
    }
    if (moveOperation == 1) {
      targetIndex = affectedLayerIndices[affectedLayerIndices.length - 1] + 1;
      const groupMembers = doc.collectGroupLayers(targetIndex);
      if (groupMembers.indexOf(sourceLayerIndex) == -1) targetIndex += groupMembers.length - 1;
    }
    if (moveOperation == 2) {
      targetIndex = affectedLayerIndices[0] - 1;
      const groupMembers = doc.collectGroupLayers(targetIndex);
      if (groupMembers.indexOf(sourceLayerIndex) == -1) targetIndex -= groupMembers.length - 1;
    }
    if (moveOperation == 3) {
      targetIndex = 0;
    }
    if (targetIndex < 0 || targetIndex > doc.layers.length - 1) return null;
    doc.needsScrollToSelected = true;
  }
  return { targetIndex, insertBeforeTarget };
}

/**
 * Folder indices (and names) whose children are all animation frames.
 * @param {object} doc
 * @returns {{ animationFolderIndices: number[], animationFolderNames: string[] }}
 */
function collectAnimationFolders(doc) {
  const animationFolderIndices = [];
  const rootSections = doc.root.children;
  for (let loopIdx = 0; loopIdx < rootSections.length; loopIdx++) {
    const sectionNode = rootSections[loopIdx];
    const folderLayer = sectionNode.layer;
    const sectionChildren = sectionNode.children;
    let allLayersAreAnimationFrames = true;
    if (!folderLayer.isGroup() || sectionChildren.length == 0) continue;
    for (let childIdx = 0; childIdx < sectionChildren.length; childIdx++) {
      if (!sectionChildren[childIdx].layer.getName().startsWith("_a_")) {
        allLayersAreAnimationFrames = false;
        break;
      }
    }
    if (allLayersAreAnimationFrames) animationFolderIndices.push(doc.layers.indexOf(folderLayer));
  }
  const selectedAnimationFolderIndices = [];
  for (let loopIdx = 0; loopIdx < animationFolderIndices.length; loopIdx++) {
    if (doc.selectedLayerIndices.indexOf(animationFolderIndices[loopIdx]) != -1) {
      selectedAnimationFolderIndices.push(animationFolderIndices[loopIdx]);
    }
  }
  let resolvedIndices = animationFolderIndices;
  if (selectedAnimationFolderIndices.length >= 2) resolvedIndices = selectedAnimationFolderIndices;
  const animationFolderNames = [];
  for (let loopIdx = 0; loopIdx < resolvedIndices.length; loopIdx++) {
    animationFolderNames.push(doc.layers[resolvedIndices[loopIdx]].getName());
  }
  return { animationFolderIndices: resolvedIndices, animationFolderNames };
}

function readFolderFrameTimings(doc, animationFolderIndices) {
  const folderTimingData = [];
  for (let folderIdx = 0; folderIdx < animationFolderIndices.length; folderIdx++) {
    const sectionNode = doc.root.getSectionByIndex(animationFolderIndices[folderIdx]);
    const folderEntry = [[], [], 0, folderIdx];
    folderTimingData.push(folderEntry);
    for (let loopIdx = 0; loopIdx < sectionNode.children.length; loopIdx++) {
      const frameLayer = sectionNode.children[loopIdx].layer;
      const layerName = frameLayer.getName();
      let frameDuration = 20;
      const nameParts = layerName.split(",");
      if (nameParts.length > 1) {
        const parsedDuration = parseInt(nameParts.pop());
        if (!isNaN(parsedDuration) && parsedDuration != 0) frameDuration = parsedDuration;
      }
      folderEntry[0].push(frameLayer);
      folderEntry[1].push(frameDuration);
      folderEntry[2] += frameDuration;
    }
  }
  return folderTimingData;
}

/**
 * Repeat and scale shorter folders so every timeline matches the longest folder.
 * @param {Array} folderTimingData
 */
function rescaleFolderTimings(folderTimingData) {
  folderTimingData.sort(compareDurationDesc);
  const longestFolderEntry = folderTimingData[0];
  const masterTimelineLength = longestFolderEntry[2];
  for (let folderIdx = 1; folderIdx < folderTimingData.length; folderIdx++) {
    const folderEntry = folderTimingData[folderIdx];
    let repeatCount = 1;
    let scaledDurations = folderEntry[1].slice(0);
    let rescaledTotalDuration = 0;
    while ((repeatCount + 1) * folderEntry[2] <= longestFolderEntry[2]) {
      repeatCount++;
      scaledDurations = scaledDurations.concat(folderEntry[1]);
    }
    folderEntry[1] = scaledDurations;
    folderEntry[2] *= repeatCount;
    const durationScaleFactor = longestFolderEntry[2] / folderEntry[2];
    for (let loopIdx = 0; loopIdx < folderEntry[1].length; loopIdx++) {
      const rescaledDuration = Math.floor(folderEntry[1][loopIdx] * durationScaleFactor);
      folderEntry[1][loopIdx] = rescaledDuration;
      rescaledTotalDuration += rescaledDuration;
    }
    while (rescaledTotalDuration < masterTimelineLength) {
      rescaledTotalDuration++;
      folderEntry[1][folderEntry[1].length - 1]++;
    }
    folderEntry[2] = rescaledTotalDuration;
  }
  return masterTimelineLength;
}

function computeMergedFrameDurations(folderTimingData, masterTimelineLength) {
  const folderFrameCursors = [];
  const folderTimeOffsets = [];
  const frameDurations = [];
  for (let loopIdx = 0; loopIdx < folderTimingData.length; loopIdx++) {
    folderFrameCursors.push(0);
    folderTimeOffsets.push(0);
  }
  let timelinePosition = 0;
  while (timelinePosition < masterTimelineLength) {
    let frameGap = 1e9;
    let nextFolderIndex = -1;
    for (let loopIdx = 0; loopIdx < folderTimingData.length; loopIdx++) {
      const durationList = folderTimingData[loopIdx][1];
      const frameCursor = folderFrameCursors[loopIdx];
      if (frameCursor != durationList.length && folderTimeOffsets[loopIdx] + durationList[frameCursor] < timelinePosition + frameGap) {
        nextFolderIndex = loopIdx;
        frameGap = folderTimeOffsets[loopIdx] + durationList[frameCursor] - timelinePosition;
      }
    }
    folderTimeOffsets[nextFolderIndex] += folderTimingData[nextFolderIndex][1][folderFrameCursors[nextFolderIndex]];
    folderFrameCursors[nextFolderIndex]++;
    if (frameGap != 0) {
      frameDurations.push(frameGap);
      timelinePosition += frameGap;
    }
  }
  for (let loopIdx = 0; loopIdx < frameDurations.length; loopIdx++) {
    const shortFrameDuration = frameDurations[loopIdx];
    const halfDuration = shortFrameDuration >>> 1;
    if (shortFrameDuration < 17) {
      const lastIdx = frameDurations.length - 1;
      if (loopIdx == 0) frameDurations[1] += shortFrameDuration;
      else if (loopIdx == frameDurations.length - 1) frameDurations[lastIdx - 1] += shortFrameDuration;
      else {
        frameDurations[loopIdx - 1] += halfDuration;
        frameDurations[loopIdx + 1] += shortFrameDuration - halfDuration;
      }
      frameDurations.splice(loopIdx, 1);
      loopIdx--;
    }
  }
  return frameDurations;
}

/**
 * Composite aligned animation-folder frames into a closed group of frame layers.
 * @param {object} tracker
 * @param {object} doc
 * @param {number[]} animationFolderIndices
 * @param {string[]} animationFolderNames
 * @param {Array} folderTimingData
 * @param {number[]} frameDurations
 */
function mergeAnimationFoldersToFrames(
  tracker,
  doc,
  animationFolderIndices,
  animationFolderNames,
  folderTimingData,
  frameDurations,
) {
  const savedVisibilityStates = [];
  const documentBounds = new Rect(0, 0, doc.width, doc.height);
  for (let loopIdx = 0; loopIdx < doc.layers.length; loopIdx++) {
    savedVisibilityStates[loopIdx] = doc.layers[loopIdx].isVisible();
    doc.layers[loopIdx].setVisible(false);
  }
  const selectionBefore = doc.selectedLayerIndices.slice(0);
  doc.selectedLayerIndices = animationFolderIndices;
  const sortedSelection = doc.resolveLayerSelection();
  sortedSelection.sort(compareAscending);
  const layersAfterMerge = [];
  for (let loopIdx = 0; loopIdx < doc.layers.length; loopIdx++) {
    if (sortedSelection.indexOf(loopIdx) == -1) layersAfterMerge.push(doc.layers[loopIdx]);
  }
  folderTimingData.sort(compareOriginalFolderIndex);
  let timelinePosition = 0;
  layersAfterMerge.splice(sortedSelection[0], 0, doc.createGroupEndLayer());
  for (let frameIdx = 0; frameIdx < frameDurations.length; frameIdx++) {
    const activeFrameLayers = [];
    for (let loopIdx = 0; loopIdx < folderTimingData.length; loopIdx++) {
      const frameCursor =
        findDurationBucketIndex(folderTimingData[loopIdx][1], timelinePosition) % folderTimingData[loopIdx][0].length;
      const frameLayer = folderTimingData[loopIdx][0][frameCursor];
      activeFrameLayers.push(frameLayer);
    }
    const compositeFrameLayer = doc.newLayer();
    for (let loopIdx = 0; loopIdx < folderTimingData.length; loopIdx++) {
      const visibleFrameLayer = activeFrameLayers[loopIdx];
      const folderLayer = doc.layers[animationFolderIndices[loopIdx]];
      visibleFrameLayer.setVisible(true);
      folderLayer.setVisible(true);
    }
    doc.markDirty();
    doc.composite();
    const compositePixels = doc.getRasterData();
    compositeFrameLayer.rect = computeContentBoundsRgba(compositePixels, documentBounds);
    compositeFrameLayer.buffer = allocBuffer(compositeFrameLayer.rect.area() * 4);
    copyPixels(compositePixels, documentBounds, compositeFrameLayer.buffer, compositeFrameLayer.rect);
    for (let loopIdx = 0; loopIdx < folderTimingData.length; loopIdx++) {
      const visibleFrameLayer = activeFrameLayers[loopIdx];
      const folderLayer = doc.layers[animationFolderIndices[loopIdx]];
      visibleFrameLayer.setVisible(false);
      folderLayer.setVisible(false);
    }
    compositeFrameLayer.setVisible(frameIdx == 0);
    compositeFrameLayer.setName("_a_frm" + frameIdx + "," + frameDurations[frameIdx]);
    layersAfterMerge.splice(sortedSelection[0] + 1 + frameIdx, 0, compositeFrameLayer);
    timelinePosition += frameDurations[frameIdx];
  }
  const mergedFolderLayer = doc.newLayer();
  mergedFolderLayer.setName(animationFolderNames.join(" + "));
  mergedFolderLayer.blendMode = "pass";
  mergedFolderLayer.add.lsct = LayerSectionType.ClosedGroup;
  mergedFolderLayer.layerFlags = 24;
  layersAfterMerge.splice(sortedSelection[0] + 1 + frameDurations.length, 0, mergedFolderLayer);
  for (let loopIdx = 0; loopIdx < doc.layers.length; loopIdx++) {
    doc.layers[loopIdx].setVisible(savedVisibilityStates[loopIdx]);
  }
  commitReplaceStack(
    tracker,
    doc,
    "layer.mergeLayers",
    layersAfterMerge,
    [sortedSelection[0] + 1 + frameDurations.length],
    { layersBefore: doc.layers, selectedLayerIndicesBefore: selectionBefore },
  );
}

/**
 * Remove a group closer and opener, leaving the former children selected.
 * @param {object} tracker
 * @param {object} doc
 * @param {number} layerIndex
 * @param {object} targetLayer
 */
function ungroupLayers(tracker, doc, layerIndex, targetLayer) {
  if (targetLayer == null || !targetLayer.isGroup()) return;
  const sectionNode = doc.root.getSectionByIndex(layerIndex);
  const groupStartIndex = doc.layers.indexOf(sectionNode.beginSectionLayer);
  const layersAfterUngroup = doc.layers.slice(0);
  layersAfterUngroup.splice(layerIndex, 1);
  layersAfterUngroup.splice(groupStartIndex, 1);
  const newSelectionIndices = [];
  for (let loopIdx = groupStartIndex; loopIdx < layerIndex - 1; loopIdx++) newSelectionIndices.push(loopIdx);
  commitReplaceStack(tracker, doc, "Ungroup Layers", layersAfterUngroup, newSelectionIndices);
}

/**
 * Wrap the current selection in a new folder (open for one layer, closed for many).
 * @param {object} tracker
 * @param {object} event
 * @param {object} doc
 */
function groupSelectedLayers(tracker, event, doc) {
  const folderLayer = doc.newLayer();
  const folderNamePrefix = Locale.get("topMenu.folder") + " ";
  folderLayer.setName(folderNamePrefix + (LayerEffectsTracker.nextDuplicateLayerNameSuffix(doc, folderNamePrefix) + 1));
  folderLayer.blendMode = "pass";
  if (event.layerName) folderLayer.setName(event.layerName);
  folderLayer.add.lsct = doc.selectedLayerIndices.length == 1 ? LayerSectionType.OpenGroup : LayerSectionType.ClosedGroup;
  folderLayer.layerFlags = 24;
  const groupEndLayer = doc.createGroupEndLayer();
  const selectedIndices = doc.resolveLayerSelection();
  if (selectedIndices.length == 0) return;
  selectedIndices.sort(compareAscending);
  const layersAfterGroup = [];
  for (let loopIdx = 0; loopIdx < doc.layers.length; loopIdx++) {
    if (selectedIndices.indexOf(loopIdx) == -1) layersAfterGroup.push(doc.layers[loopIdx]);
  }
  const lastSelectedIndex = doc.selectedLayerIndices[doc.selectedLayerIndices.length - 1] - selectedIndices.length;
  layersAfterGroup.splice(lastSelectedIndex + 1, 0, groupEndLayer);
  for (let loopIdx = 0; loopIdx < selectedIndices.length; loopIdx++) {
    layersAfterGroup.splice(lastSelectedIndex + 2 + loopIdx, 0, doc.layers[selectedIndices[loopIdx]]);
  }
  layersAfterGroup.splice(lastSelectedIndex + 2 + selectedIndices.length, 0, folderLayer);
  commitReplaceStack(tracker, doc, "layer.groupLayers", layersAfterGroup, [layersAfterGroup.indexOf(folderLayer)]);
  const trackPayload = {
    uf: "make",
    skipActionRecording: true,
  };
  trackPayload.actionDescriptor = {
    classID: "Mk",
    null: ActionDescUtil.buildTargetRef("layerSection"),
    From: ActionDescUtil.buildTargetRef("Lyr", true),
    Usng: {
      t: "Objc",
      v: {
        classID: "layerSection",
        Nm: {
          t: "TEXT",
          v: folderLayer.getName(),
        },
      },
    },
  };
  tracker.track(trackPayload);
}

function applyLinkOrUnlinkGroupIndices(doc, linkLayerIndices) {
  let maxGroupIndex = 0;
  let hasUnlinkedLayer = false;
  const groupIndicesBefore = [];
  for (let loopIdx = 0; loopIdx < doc.layers.length; loopIdx++) {
    const groupIndex = doc.layers[loopIdx].groupIndex;
    groupIndicesBefore.push(groupIndex);
    maxGroupIndex = Math.max(maxGroupIndex, groupIndex);
  }
  let primaryGroupIndex = -1;
  let secondaryGroupIndex = -1;
  for (let loopIdx = 0; loopIdx < linkLayerIndices.length; loopIdx++) {
    const groupIndex = doc.layers[linkLayerIndices[loopIdx]].groupIndex;
    if (groupIndex == 0) hasUnlinkedLayer = true;
    else if (primaryGroupIndex == -1 || primaryGroupIndex == groupIndex) primaryGroupIndex = groupIndex;
    else secondaryGroupIndex = groupIndex;
  }
  if (!hasUnlinkedLayer) {
    for (let loopIdx = 0; loopIdx < linkLayerIndices.length; loopIdx++) doc.layers[linkLayerIndices[loopIdx]].groupIndex = 0;
  } else if (primaryGroupIndex != -1 && secondaryGroupIndex == -1) {
    for (let loopIdx = 0; loopIdx < linkLayerIndices.length; loopIdx++) {
      doc.layers[linkLayerIndices[loopIdx]].groupIndex = primaryGroupIndex;
    }
  } else {
    for (let loopIdx = 0; loopIdx < linkLayerIndices.length; loopIdx++) {
      doc.layers[linkLayerIndices[loopIdx]].groupIndex = maxGroupIndex + 1;
    }
  }
  const groupMemberCounts = [];
  for (let loopIdx = 0; loopIdx < doc.layers.length; loopIdx++) {
    const groupIndex = doc.layers[loopIdx].groupIndex;
    if (groupMemberCounts[groupIndex] == null) groupMemberCounts[groupIndex] = 0;
    groupMemberCounts[groupIndex]++;
  }
  for (let loopIdx = 0; loopIdx < doc.layers.length; loopIdx++) {
    const groupIndex = doc.layers[loopIdx].groupIndex;
    if (groupMemberCounts[groupIndex] == 1) doc.layers[loopIdx].groupIndex = 0;
  }
  const groupIndicesAfter = [];
  for (let loopIdx = 0; loopIdx < doc.layers.length; loopIdx++) {
    const groupIndex = doc.layers[loopIdx].groupIndex;
    groupIndicesAfter.push(groupIndex);
    maxGroupIndex = Math.max(maxGroupIndex, groupIndex);
  }
  return { hasUnlinkedLayer, groupIndicesBefore, groupIndicesAfter };
}

function handleReplaceLayerStack(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  commitReplaceStack(this, doc, event.historyLabelKey, event.layersAfter, event.selectedLayerIndices);
}

function handleDeleteLayer(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const deleteLayerIndices = doc.resolveLayerSelection(null, event.layerIndex);
  let insertBeforeIndex = 1e10;
  if (deleteLayerIndices.length == 0) return;
  if (doc.layers.length == deleteLayerIndices.length) {
    showToast("Project must have at least 1 layer");
    return;
  }
  const layersAfterDelete = [];
  for (let loopIdx = 0; loopIdx < doc.layers.length; loopIdx++) {
    if (deleteLayerIndices.indexOf(loopIdx) == -1) layersAfterDelete.push(doc.layers[loopIdx]);
  }
  for (let loopIdx = 0; loopIdx < deleteLayerIndices.length; loopIdx++) {
    insertBeforeIndex = Math.min(insertBeforeIndex, deleteLayerIndices[loopIdx]);
  }
  insertBeforeIndex = Math.max(insertBeforeIndex - 1, 0);
  while (layersAfterDelete[insertBeforeIndex].name == "</Layer group>") insertBeforeIndex++;
  this.track({
    uf: "delete",
    actionDescriptor: {
      classID: "Dlt",
      null: ActionDescUtil.buildTargetRef("Lyr", true),
    },
  });
  commitReplaceStack(this, doc, "layer.deleteLayer", layersAfterDelete, [insertBeforeIndex]);
}

function handleLinkLayers(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const linkLayerIndices = event.linkLayerIndices ? event.linkLayerIndices : doc.selectedLayerIndices;
  if (linkLayerIndices.length == 0) return;
  if (linkLayerIndices.length == 1 && doc.layers[linkLayerIndices[0]].groupIndex == 0) {
    showToast(Locale.get("brushAndMessages.toolHints.selectMultipleLayers"));
    return;
  }
  const linkResult = applyLinkOrUnlinkGroupIndices(doc, linkLayerIndices);
  const historyEntry = createHistoryEntry(
    linkResult.hasUnlinkedLayer ? "layer.linkLayers" : "layer.unlinkLayers",
    this,
    {
      actionKind: Layer.linkLayers,
      layerGroupIndicesBefore: linkResult.groupIndicesBefore,
      layerGroupIndicesAfter: linkResult.groupIndicesAfter,
    },
  );
  commitHistoryAndRedo(this, doc, historyEntry);
}

function handlePasteLayers(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const sourceDoc = event.sourceDocument;
  const destDoc = event.targetDocument;
  if (sourceDoc != destDoc) {
    remapPlacedItemTagsAcrossDocuments(sourceDoc, destDoc, event.layersToInsert);
  }
  const sortedSelection = destDoc.selectedLayerIndices.slice(0);
  sortedSelection.sort(compareAscending);
  const layersAfterInsert = destDoc.layers.slice(0);
  const newSelectionIndices = [];
  let insertIndex = -1;
  for (let loopIdx = 0; loopIdx < sortedSelection.length; loopIdx++) {
    insertIndex = Math.max(insertIndex, sortedSelection[loopIdx]);
  }
  if (event.pasteInsertIndex != null) insertIndex = event.pasteInsertIndex;
  insertIndex++;
  for (let loopIdx = 0; loopIdx < event.layersToInsert.length; loopIdx++) {
    const insertedLayer = event.layersToInsert[loopIdx];
    layersAfterInsert.splice(insertIndex, 0, insertedLayer);
    newSelectionIndices.push(insertIndex);
    insertIndex++;
  }
  if (event.layersToInsert[event.layersToInsert.length - 1].isGroup()) {
    newSelectionIndices.length = 0;
    newSelectionIndices.push(insertIndex - 1);
  }
  const historyEntry = createHistoryEntry(
    "layer.duplicateLayer",
    this,
    buildReplaceStackHistoryData(destDoc, layersAfterInsert, newSelectionIndices, {
      selectedLayerIndicesBefore: sortedSelection,
    }),
  );
  destDoc.pushHistory(historyEntry);
  this.redo(historyEntry.data, destDoc);
}

function handleRasterizeLayers(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const rasterizeLayerIndices = event.layerIndex != null ? [event.layerIndex] : doc.resolveLayerSelection();
  const layersAfterRasterize = doc.layers.slice(0);
  for (let loopIdx = 0; loopIdx < rasterizeLayerIndices.length; loopIdx++) {
    const rasterizedLayer = doc.layers[rasterizeLayerIndices[loopIdx]].clone();
    rasterizedLayer.rasterize(doc);
    layersAfterRasterize.splice(rasterizeLayerIndices[loopIdx], 1, rasterizedLayer);
  }
  commitReplaceStack(
    this,
    doc,
    "layer.rasterise",
    layersAfterRasterize,
    doc.selectedLayerIndices.slice(0),
  );
}

function handleExplodeLayerStyles(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const layersAfterSplit = doc.layers.slice(0);
  const sourceLayer = (layersAfterSplit[doc.selectedLayerIndices[0]] = layersAfterSplit[doc.selectedLayerIndices[0]].clone());
  const layerEffectsJson = sourceLayer.add.lmfx;
  let belowEffectsInsertCount = 0;
  delete sourceLayer.add.lmfx;
  const alphaChannelScratch = allocBuffer(sourceLayer.rect.area());
  extractChannelByte(sourceLayer.buffer, alphaChannelScratch, 3);
  const effectStackByKind = LayerStyleRenderer.buildLayerStyleEffectStack(
    layerEffectsJson,
    null,
    alphaChannelScratch,
    sourceLayer.rect,
    doc,
    sourceLayer.rect,
  ).type;
  for (let effectKindIdx = 0; effectKindIdx < LayerEffectDefs.order.length; effectKindIdx++) {
    const effectKindName = LayerEffectDefs.order[effectKindIdx];
    const effectInstances = effectStackByKind[effectKindName];
    const isBelowEffects = effectKindIdx > 7;
    for (let instanceIdx = 0; instanceIdx < effectInstances.length; instanceIdx++) {
      const effectRaster = effectInstances[instanceIdx];
      const effectLayer = doc.newLayer();
      effectLayer.blendMode = effectRaster.blendModeCode;
      effectLayer.Opct = Math.round(255 * effectRaster.blendOpacity);
      effectLayer.isClippingMask = !isBelowEffects;
      effectLayer.buffer = effectRaster.rgbaBuffer;
      effectLayer.rect = effectRaster.effectRect;
      effectLayer.rect.offset(sourceLayer.rect.x, sourceLayer.rect.y);
      effectLayer.setName(sourceLayer.getName() + "'s " + Locale.get(LayerEffectDefs.names[effectKindIdx]));
      layersAfterSplit.splice(doc.selectedLayerIndices[0] + (isBelowEffects ? 0 : 1), 0, effectLayer);
      if (isBelowEffects) belowEffectsInsertCount++;
    }
  }
  commitReplaceStack(
    this,
    doc,
    "Styles to Layers",
    layersAfterSplit,
    [doc.selectedLayerIndices[0] + belowEffectsInsertCount],
  );
}

function handleRasterizeLayerStyle(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const selectedIndices = doc.resolveLayerSelection();
  const layersAfterRasterize = doc.layers.slice(0);
  const documentBounds = new Rect(0, 0, doc.width, doc.height);
  for (let loopIdx = 0; loopIdx < selectedIndices.length; loopIdx++) {
    const sourceLayer = doc.layers[selectedIndices[loopIdx]];
    const wasVisible = sourceLayer.isVisible();
    sourceLayer.setVisible(true);
    const layerSection = doc.root.getSectionByIndex(selectedIndices[loopIdx]);
    if (sourceLayer.isGroup()) continue;
    if (layerSection == null) continue;
    const rasterizedLayer = sourceLayer.clone();
    rasterizedLayer.rasterize(doc);
    const compositeRect = layerSection.getSelectionRect(doc, true);
    const savedLayerList = doc.layers;
    doc.setLayers([sourceLayer]);
    doc.markDirty();
    doc.composite();
    rasterizedLayer.buffer = allocBuffer(compositeRect.area() * 4);
    copyPixels(doc.getRasterData(), documentBounds, rasterizedLayer.buffer, compositeRect);
    rasterizedLayer.rect = compositeRect;
    rasterizedLayer.Opct = 255;
    rasterizedLayer.add.iOpa = 255;
    rasterizedLayer.blendMode = "norm";
    rasterizedLayer.markDirty();
    rasterizedLayer.renderCache.dirty = true;
    doc.setLayers(savedLayerList);
    if (rasterizedLayer.add.lmfx) delete rasterizedLayer.add.lmfx;
    rasterizedLayer.d = rasterizedLayer.warpData = null;
    layersAfterRasterize.splice(selectedIndices[loopIdx], 1, rasterizedLayer);
    rasterizedLayer.setVisible(wasVisible);
    sourceLayer.setVisible(wasVisible);
  }
  commitReplaceStack(
    this,
    doc,
    "layer.rasteriseLayerStyle",
    layersAfterRasterize,
    doc.selectedLayerIndices.slice(0),
  );
}

function handleConvertTextToShape(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const selectedIndices = doc.resolveLayerSelection();
  const layersAfterConvert = doc.layers.slice(0);
  for (let loopIdx = 0; loopIdx < selectedIndices.length; loopIdx++) {
    const textLayer = doc.layers[selectedIndices[loopIdx]];
    const textLayerData = textLayer.add.TySh;
    if (textLayerData == null) continue;
    const textCurveData = new TextLayout(textLayerData.engineData, appData.fontRegistry);
    const pathsByColorId = splitPathBySubpathId(TextRenderer.buildTextPaths(textCurveData, textLayerData));
    for (const colorIdKey in pathsByColorId) {
      const pathRecords = pathsByColorId[colorIdKey];
      const shapeLayer = textLayer.clone();
      delete shapeLayer.add.TySh;
      shapeLayer.layerFlags = shapeLayer.layerFlags | (1 << 4);
      shapeLayer.add.SoCo = LayerEffectDefs.getFillLayerDefault(0);
      const solidColorDesc = shapeLayer.add.SoCo.Clr.v;
      solidColorDesc.Rd.v = parseInt(colorIdKey.slice(1, 3), 16);
      solidColorDesc.Grn.v = parseInt(colorIdKey.slice(3, 5), 16);
      solidColorDesc.Bl.v = parseInt(colorIdKey.slice(5, 7), 16);
      const vectorMask = new VectorMask();
      vectorMask.pathRecords = buildCanvasPathRecords(pathRecords, false);
      if (shapeLayer.add.vmsk != null) {
        shapeLayer.add.vmsk.resetFillRules();
        vectorMask.concat(shapeLayer.add.vmsk);
      }
      shapeLayer.add.vmsk = vectorMask;
      shapeLayer.add.vstk = LayerEffectDefs.getStrokeStyleDefault();
      shapeLayer.updateVectorOrigins();
      shapeLayer.invalidate(doc);
      layersAfterConvert.splice(layersAfterConvert.indexOf(textLayer), 0, shapeLayer);
    }
    layersAfterConvert.splice(layersAfterConvert.indexOf(textLayer), 1);
  }
  const newSelectionIndices = doc.selectedLayerIndices.slice(0);
  for (let loopIdx = newSelectionIndices.length - 1; loopIdx >= 0; loopIdx--) {
    if (newSelectionIndices[loopIdx] >= layersAfterConvert.length) newSelectionIndices.splice(loopIdx, 1);
  }
  commitReplaceStack(this, doc, "layer.convertToShape", layersAfterConvert, newSelectionIndices);
}

function handleAutoBlendLayers(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const selectedLayerCount = doc.selectedLayerIndices.length;
  if (selectedLayerCount < 2) {
    showToast("Select two or more layers.");
    return;
  }
  if (!doc.ensureSelectedLayersPixelEditable()) return;
  const blendTargetLayer = doc.layers[doc.selectedLayerIndices[0]].clone();
  const layersAfterBlend = [];
  for (let loopIdx = 0; loopIdx < doc.layers.length; loopIdx++) {
    if (doc.selectedLayerIndices.indexOf(loopIdx) == -1) layersAfterBlend.push(doc.layers[loopIdx]);
  }
  layersAfterBlend.splice(doc.selectedLayerIndices[0], 0, blendTargetLayer);
  for (let loopIdx = 1; loopIdx < selectedLayerCount; loopIdx++) {
    if (doc.layers[doc.selectedLayerIndices[loopIdx]].rect.area() > 2e6) {
      showToast("Blended areas are too large.");
      return;
    }
  }
  for (let loopIdx = 1; loopIdx < selectedLayerCount; loopIdx++) {
    const sourceLayer = doc.layers[doc.selectedLayerIndices[loopIdx]];
    const paddedRect = sourceLayer.rect.clone();
    paddedRect.inflate(1, 1);
    const sourcePixelsBuffer = allocBuffer(paddedRect.area() * 4);
    copyPixels(sourceLayer.buffer, sourceLayer.rect, sourcePixelsBuffer, paddedRect);
    blendTargetLayer.extend(paddedRect);
    const targetPixelsBuffer = allocBuffer(paddedRect.area() * 4);
    copyPixels(blendTargetLayer.buffer, blendTargetLayer.rect, targetPixelsBuffer, paddedRect);
    const alphaMaskBuffer = allocBuffer(paddedRect.area());
    extractChannelByte(sourcePixelsBuffer, alphaMaskBuffer, 3);
    round(alphaMaskBuffer, 200);
    extractChannel(alphaMaskBuffer, sourcePixelsBuffer, 3);
    composite("norm", sourcePixelsBuffer, paddedRect, targetPixelsBuffer, paddedRect, paddedRect, 1);
    solvePoissonFill(targetPixelsBuffer, alphaMaskBuffer, paddedRect);
    copyPixels(targetPixelsBuffer, paddedRect, blendTargetLayer.buffer, blendTargetLayer.rect);
  }
  commitReplaceStack(this, doc, "edit.autoBlend", layersAfterBlend, [doc.selectedLayerIndices[0]]);
}

function handleSplitOpenVectorPaths(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const layersAfterSplit = doc.layers.slice(0);
  const selectionAfterSplit = doc.selectedLayerIndices.slice(0);
  for (let layerIdx = 0; layerIdx < layersAfterSplit.length; layerIdx++) {
    let layer = layersAfterSplit[layerIdx];
    let vectorMask = layer.add.vmsk;
    if (layer.hasFillContent() && vectorMask && layer.add.vstk.strokeEnabled.v && !layer.add.vstk.fillEnabled.v) {
      let pathRecords = vectorMask.pathRecords;
      let openSubpathCount = 0;
      let openSubpathRecordIdx = -1;
      for (let recordIdx = 0; recordIdx < pathRecords.length; recordIdx++) {
        if ((pathRecords[recordIdx].type == 0 || pathRecords[recordIdx].type == 3) && pathRecords[recordIdx].fillRule != -1) {
          openSubpathCount++;
          if (pathRecords[recordIdx].type == 3 && openSubpathRecordIdx == -1) {
            pathRecords[recordIdx].subpathHeaderFlags = pathRecords[recordIdx].fillRule = 1;
            openSubpathRecordIdx = recordIdx;
          }
        }
      }
      if (openSubpathCount > 1 && openSubpathRecordIdx != -1) {
        layer = layer.clone();
        vectorMask = layer.add.vmsk;
        pathRecords = vectorMask.pathRecords;
        const openSubpathLength = pathRecords[openSubpathRecordIdx].length;
        const splitOffLayer = layer.clone();
        splitOffLayer.add.lyid = doc.generateLayerId();
        vectorMask.pathRecords = pathRecords.slice(0, 2).concat(pathRecords.slice(openSubpathRecordIdx, openSubpathRecordIdx + openSubpathLength + 1));
        vectorMask.C = [];
        layer.invalidate(doc);
        layer.markDirty();
        const splitPathRecords = splitOffLayer.add.vmsk.pathRecords;
        splitOffLayer.add.vmsk.pathRecords = splitPathRecords
          .slice(0, openSubpathRecordIdx)
          .concat(splitPathRecords.slice(openSubpathRecordIdx + openSubpathLength + 1, splitPathRecords.length));
        splitOffLayer.add.vmsk.C = [];
        splitOffLayer.invalidate(doc);
        layersAfterSplit[layerIdx] = layer;
        layersAfterSplit.splice(layerIdx + 1, 0, splitOffLayer);
        for (let recordIdx = 0; recordIdx < selectionAfterSplit.length; recordIdx++) {
          if (selectionAfterSplit[recordIdx] > layerIdx) selectionAfterSplit[recordIdx]++;
        }
        const selectionSlotIdx = selectionAfterSplit.indexOf(layerIdx);
        if (selectionSlotIdx != -1) {
          selectionAfterSplit.splice(selectionSlotIdx + 1, 0, layerIdx + 1);
        }
      }
    }
  }
  if (layersAfterSplit.length != doc.layers.length) {
    commitReplaceStack(this, doc, "Splitting open paths", layersAfterSplit, selectionAfterSplit);
  }
}

function handleCreateSmartObject(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  this.handleInput(
    {
      actionKind: Layer.splitOpenVectorPaths,
    },
    dispatcher,
    doc,
    panelContext,
    appData,
  );
  const selectionBefore = doc.selectedLayerIndices.slice(0);
  const layersBefore = doc.layers.slice(0);
  const mergeLayerIndices = doc.resolveLayerSelection();
  if (mergeLayerIndices.length == 0) return;
  doc.mergeLayersToSmartObject(mergeLayerIndices, false, event.linkedFileExtension);
  commitReplaceStack(this, doc, "layer.smartObject.creatingSmartObject", doc.layers.slice(), doc.selectedLayerIndices.slice(0), {
    layersBefore,
    selectedLayerIndicesBefore: selectionBefore,
  });
}

function handleDispatch$(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const placedData = targetLayer.add.placedData;
  if (placedData == null) return;
  const placedItemTag = placedData.Idnt.v;
  const linkedItem = doc.findLinkedItemByTag(placedItemTag);
  linkedItem.getRasterData(false);
  const rasterPixels = linkedItem.rasterCache[0];
  const rasterBounds = linkedItem.rasterCache[1];
  if (hasNonOpaquePixels(rasterPixels)) {
    showToast("The smart object contains transparency.");
    return;
  }
  const jpegBytes = FileFormatRegistry.getFormat("jpg").encode([[rasterPixels.buffer]], rasterBounds.width, rasterBounds.height, [90]);
  this.handleInput(
    {
      actionKind: Layer.updateLinkedItem,
      openedDocument: doc,
      data: new Uint8Array(jpegBytes),
      id: placedItemTag,
      linkedFileExtension: "jpg",
    },
    dispatcher,
    doc,
    panelContext,
    appData,
  );
}

function handleUpdateLinkedItem(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const linkedItemBefore = event.openedDocument.findLinkedItemByTag(event.id);
  const linkedItemAfter = linkedItemBefore.clone();
  linkedItemAfter.raw = event.data;
  if (event.linkedFileExtension) {
    linkedItemAfter.creatorFourCC = "    ";
    linkedItemAfter.fileTypeFourCC = "    ";
    linkedItemAfter.fileName = replaceFileExtension(linkedItemAfter.fileName, event.linkedFileExtension);
  } else {
    linkedItemAfter.creatorFourCC = "8BIM";
    linkedItemAfter.fileTypeFourCC = "8BPB";
    linkedItemAfter.fileName = replaceFileExtension(linkedItemAfter.fileName, "psd");
  }
  linkedItemAfter.getRasterData(false);
  linkedItemBefore.getRasterData(false);
  const historyEntry = createHistoryEntry("layer.smartObject.updatingSmartObject", this, {
    actionKind: Layer.updateLinkedItem,
    id: event.id,
    linkedItemBefore,
    linkedItemAfter,
  });
  event.openedDocument.pushHistory(historyEntry);
  this.redo(historyEntry.data, event.openedDocument);
}

function handleSetSmartObjectStackMode(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const historyEntry = createHistoryEntry("layer.smartObject.stackMode", this, {
    actionKind: eventCode,
    layerIndex,
    placedFilterClassId: targetLayer.add.placedData.Impr.v.classID,
    stackModeClassId: event.stackModeClassId,
  });
  commitHistoryAndRedo(this, doc, historyEntry);
}

function handlePlaceSmartObject(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  let embeddedPsdBytes;
  let smartObjectName;
  if (event.embeddedFileName) {
    embeddedPsdBytes = event.importFileBytes;
    smartObjectName = event.embeddedFileName;
  } else {
    event.openedDocument.rebuildLayerTree();
    event.openedDocument.recalculateBounds();
    event.openedDocument.markDirty();
    event.openedDocument.composite();
    event.openedDocument.getRasterData();
    embeddedPsdBytes = FileFormatRegistry.getFormat("PSD").encode(event.openedDocument, 0, 0, [true, true]);
    smartObjectName = event.openedDocument.name;
  }
  if (!(embeddedPsdBytes instanceof ArrayBuffer)) throw new Error("Expected embedded PSD bytes as ArrayBuffer");
  embeddedPsdBytes = new Uint8Array(embeddedPsdBytes);
  const insertIndex =
    event.insertLayerIndex != null ? event.insertLayerIndex : doc.selectedLayerIndices[doc.selectedLayerIndices.length - 1] + 1;
  const smartObjectLayer = doc.createSmartObjectLayer(embeddedPsdBytes, smartObjectName, 0, 0, true);
  const layersAfterInsert = doc.layers.slice(0);
  layersAfterInsert.splice(insertIndex, 0, smartObjectLayer);
  commitReplaceStack(
    this,
    doc,
    "layer.smartObject.placingSmartObject",
    layersAfterInsert,
    [layersAfterInsert.indexOf(smartObjectLayer)],
    { layersBefore: doc.layers.slice() },
  );
}

function handleFlattenImage(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const backgroundLayer = doc.newLayer();
  backgroundLayer.rect = new Rect(0, 0, doc.width, doc.height);
  backgroundLayer.buffer = allocBuffer(backgroundLayer.rect.area() * 4);
  fillBuffer(backgroundLayer.buffer, 4294967295);
  composite(
    "norm",
    doc.getRasterData(),
    backgroundLayer.rect,
    backgroundLayer.buffer,
    backgroundLayer.rect,
    backgroundLayer.rect,
    1,
  );
  backgroundLayer.setName("Background");
  backgroundLayer.add.lspf = 1 << 2;
  commitReplaceStack(this, doc, "layer.flattenImage", [backgroundLayer], [0], { layersBefore: doc.layers.slice() });
}

function handleNewFolder(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const folderLayer = doc.newLayer();
  folderLayer.setName(Locale.get("topMenu.folder") + " " + doc.layers.length);
  folderLayer.blendMode = "pass";
  folderLayer.add.lsct = LayerSectionType.OpenGroup;
  folderLayer.layerFlags = 24;
  const groupEndLayer = doc.createGroupEndLayer();
  const insertIndex = layerIndex + 1;
  const layersAfterInsert = doc.layers.slice(0);
  layersAfterInsert.splice(insertIndex, 0, groupEndLayer, folderLayer);
  commitReplaceStack(this, doc, "layer.newFolder", layersAfterInsert, [insertIndex + 1]);
}

function handleGroupOrUngroup(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  if (event.ungroupMode) ungroupLayers(this, doc, layerIndex, targetLayer);
  else groupSelectedLayers(this, event, doc);
}

function handleDuplicateLayer(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  if (eventCode == Layer.duplicateLayer && !(event.layerIndex != null || doc.selectedLayerIndices.length != 0)) return;
  const duplicatedLayers = doc.duplicateLayers(eventCode == Layer.duplicateLayer ? event.layerIndex : layerIndex, null, event.duplicateInPlace);
  if (eventCode == Layer.duplicateSmartObject) {
    const duplicatedLayer = duplicatedLayers[0];
    const placedItemTag = duplicatedLayer.add.placedData.Idnt.v;
    const clonedLinkedItem = doc.findLinkedItemByTag(placedItemTag).clone();
    duplicatedLayer.add.placedData.Idnt.v = clonedLinkedItem.tag = Document.generateUID();
    doc.add.lnk2.push(clonedLinkedItem);
  }
  if (eventCode == Layer.duplicateLayer) {
    const duplicateActionDesc = {
      uf: "duplicate",
      actionDescriptor: {
        classID: "null",
        null: ActionDescUtil.buildTargetRef("Lyr", true),
      },
    };
    if (event.layerName) {
      duplicatedLayers[0].setName(event.layerName);
      duplicateActionDesc.Nm = {
        t: "TEXT",
        v: event.layerName,
      };
    }
    this.track(duplicateActionDesc);
    event.pasteInsertIndex = event.layerIndex;
  }
  event.layersToInsert = duplicatedLayers;
  event.sourceDocument = doc;
  event.targetDocument = doc;
  event.actionKind = Layer.pasteLayers;
  this.handleInput(event, dispatcher, doc, panelContext, appData);
}

function handleMergeLayers(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const layersBefore = doc.layers.slice(0);
  const selectionBefore = doc.selectedLayerIndices.slice(0);
  let allLayersHaveVectorContent = true;
  if (eventCode == Layer.mergeDown) doc.selectedLayerIndices = [layerIndex, layerIndex - 1];
  if (eventCode == Layer.mergeLayers) {
    doc.selectedLayerIndices = [];
    for (let loopIdx = 0; loopIdx < doc.layers.length; loopIdx++) {
      if (doc.layers[loopIdx].isVisible()) doc.selectedLayerIndices.push(loopIdx);
    }
  }
  const sortedSelection = doc.resolveLayerSelection();
  sortedSelection.sort(compareAscending);
  let mergeBoundsRect = new Rect();
  const documentBounds = new Rect(0, 0, doc.width, doc.height);
  for (let loopIdx = 0; loopIdx < sortedSelection.length; loopIdx++) {
    const mergeIndex = sortedSelection[loopIdx];
    const layer = doc.layers[mergeIndex];
    allLayersHaveVectorContent = allLayersHaveVectorContent && layer.hasFillContent() && layer.add.vmsk != null;
    mergeBoundsRect = mergeBoundsRect.union(doc.root.getSectionByIndex(mergeIndex).getSelectionRect(doc, true));
  }
  const mergedLayer = mergeSelectedLayersToLayer(
    doc,
    sortedSelection,
    allLayersHaveVectorContent,
    mergeBoundsRect,
    documentBounds,
  );
  let altDuplicateInPlace = panelContext.isPressed(KeyboardHandler.Alt);
  let replaceLayerIndex = -1;
  if (event.actionDescriptor && event.actionDescriptor.Dplc && event.actionDescriptor.Dplc.v) altDuplicateInPlace = true;
  if (
    altDuplicateInPlace &&
    eventCode == Layer.mergeLayers &&
    doc.layers[selectionBefore[0]].hasPixelData() &&
    doc.layers[selectionBefore[0]].rect.isEmpty()
  ) {
    replaceLayerIndex = selectionBefore[0];
    mergedLayer.setName(doc.layers[replaceLayerIndex].getName());
  }
  const layersAfterMerge = [];
  for (let loopIdx = 0; loopIdx < doc.layers.length; loopIdx++) {
    if (altDuplicateInPlace || sortedSelection.indexOf(loopIdx) == -1) {
      if (loopIdx != replaceLayerIndex) layersAfterMerge.push(doc.layers[loopIdx]);
    }
  }
  const lastSelectedIndex = sortedSelection[sortedSelection.length - 1];
  const layerAfterSelection = lastSelectedIndex == doc.layers.length - 1 ? null : doc.layers[lastSelectedIndex + 1];
  const insertIndex = layerAfterSelection ? layersAfterMerge.indexOf(layerAfterSelection) : layersAfterMerge.length;
  layersAfterMerge.splice(insertIndex, 0, mergedLayer);
  commitReplaceStack(this, doc, "layer.mergeLayers", layersAfterMerge, [insertIndex], {
    layersBefore,
    selectedLayerIndicesBefore: selectionBefore,
  });
}

function handleNewLayer(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const liftsFromSourceLayer = eventCode == Layer.newLayerViaCopy || eventCode == Layer.newLayerViaCut;
  const newLayer = liftsFromSourceLayer ? doc.layers[doc.selectedLayerIndices[0]].clone() : doc.newLayer();
  let defaultLayerName = Locale.get("topMenu.layer");
  let customName = event.layerName;
  let shapeDesc;
  let fillKindIndex;
  if (eventCode == Layer.newShapeLayer) defaultLayerName = Locale.get("properties.drawMode.shape");
  if (eventCode == Layer.newLayerViaCopy) {
    if (!applyNewLayerViaCopy(newLayer, doc)) return;
  }
  let cutSourceLayer;
  if (eventCode == Layer.newLayerViaCut) {
    cutSourceLayer = applyNewLayerViaCut(newLayer, doc);
    if (cutSourceLayer == null) return;
  }
  if (eventCode == Layer.newLayerFromClipboard) {
    applyNewLayerFromClipboard(newLayer, event, doc);
  }
  if (eventCode == Layer.newLayer) {
    this.track({
      uf: "make",
      actionDescriptor: {
        classID: "Mk",
        null: ActionDescUtil.buildTargetRef("Lyr"),
      },
    });
  }
  if (eventCode == Layer.newAdjustmentLayer) {
    const adjustmentResult = applyNewAdjustmentLayer(newLayer, event, doc);
    defaultLayerName = adjustmentResult.defaultLayerName;
    if (adjustmentResult.hasDescriptorName) customName = adjustmentResult.customName;
  }
  if (eventCode == Layer.newShapeLayer) {
    newLayer.layerFlags |= 16;
    const shapeFill = buildNewShapeLayerFill(newLayer, event, doc, appData);
    shapeDesc = shapeFill.shapeDesc;
    fillKindIndex = shapeFill.fillKindIndex;
    if (shapeFill.fillLayerDefaultName) defaultLayerName = shapeFill.fillLayerDefaultName;
  }
  const nameSuffix = LayerEffectsTracker.nextDuplicateLayerNameSuffix(doc, defaultLayerName + " ");
  newLayer.setName(defaultLayerName + " " + (nameSuffix + 1));
  if (customName) newLayer.setName(customName);
  const insertChoice = chooseNewLayerInsertIndex(doc, event, eventCode, newLayer);
  const layersAfterInsert = doc.layers.slice(0);
  if (cutSourceLayer) layersAfterInsert[doc.selectedLayerIndices[0]] = cutSourceLayer;
  layersAfterInsert.splice(insertChoice.insertIndex, insertChoice.replaceEmptyLayer ? 1 : 0, newLayer);
  let selectionMaskPair;
  if (liftsFromSourceLayer || eventCode == Layer.newShapeLayer || eventCode == Layer.newLayerFromClipboard) {
    if (doc.selectionMask) selectionMaskPair = [doc.selectionMask, null];
  }
  commitReplaceStack(
    this,
    doc,
    historyLabelForNewLayer(event, eventCode),
    layersAfterInsert,
    [insertChoice.insertIndex],
    { activeChannelPair: selectionMaskPair },
  );
  if ((eventCode == Layer.newShapeLayer && shapeDesc == null && fillKindIndex != 0) || eventCode == Layer.newAdjustmentLayer) {
    const uiDispatchEvent = new AppEvent(EventType.uiDispatch);
    uiDispatchEvent.data = {
      dispatchKind: UiCommand.registerFontFaceFromUrlParam,
      dialogRouteId: BaseTool.PanelId.PROPERTIES,
    };
    dispatcher.dispatch(uiDispatchEvent);
  }
}

function handleMoveLayer(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  const sourceLayerIndex = eventCode == Layer.moveLayer ? event.source : doc.selectedLayerIndices[0];
  const sourceIsInSelection = doc.selectedLayerIndices.indexOf(sourceLayerIndex) != -1;
  const altDuplicate = panelContext.isPressed(KeyboardHandler.Alt) | event.duplicateInPlaceFromAction;
  let affectedLayerIndices;
  if (sourceIsInSelection) affectedLayerIndices = doc.resolveLayerSelection();
  else affectedLayerIndices = doc.collectGroupLayers(sourceLayerIndex);
  affectedLayerIndices.sort(compareAscending);
  const moveTarget = resolveMoveTargetIndex(event, eventCode, doc, sourceLayerIndex, affectedLayerIndices);
  if (moveTarget == null) return;
  const { targetIndex, insertBeforeTarget } = moveTarget;
  if (affectedLayerIndices.indexOf(targetIndex) != -1 && !altDuplicate) return;
  const targetLayerAtIndex = doc.layers[targetIndex];
  let layersAfterReorder = [];
  if (altDuplicate) layersAfterReorder = doc.layers.slice(0);
  else {
    for (let loopIdx = 0; loopIdx < doc.layers.length; loopIdx++) {
      if (affectedLayerIndices.indexOf(loopIdx) == -1) layersAfterReorder.push(doc.layers[loopIdx]);
    }
  }
  let targetIndexInNewList = layersAfterReorder.indexOf(targetLayerAtIndex);
  if (
    eventCode == Layer.moveLayer &&
    targetLayerAtIndex.isGroup() &&
    targetLayerAtIndex.add.lsct == LayerSectionType.ClosedGroup &&
    event.dropPositionRatio > 0.8
  ) {
    targetIndexInNewList -= doc.collectGroupLayers(targetIndex).length - 1;
  }
  const newSelectionIndices = [];
  const duplicatedLayers = altDuplicate ? doc.duplicateLayers(sourceIsInSelection ? null : sourceLayerIndex) : null;
  for (let loopIdx = 0; loopIdx < affectedLayerIndices.length; loopIdx++) {
    const insertSlot = targetIndexInNewList + (insertBeforeTarget ? 0 : 1) + loopIdx;
    const layerToInsert = altDuplicate ? duplicatedLayers[loopIdx] : doc.layers[affectedLayerIndices[loopIdx]];
    layersAfterReorder.splice(insertSlot, 0, layerToInsert);
    newSelectionIndices.push(insertSlot);
  }
  commitReplaceStack(
    this,
    doc,
    altDuplicate ? "layer.duplicateLayer" : "layer.layerOrder",
    layersAfterReorder,
    newSelectionIndices,
  );
  const moveActionDesc = {
    classID: "move",
    null: ActionDescUtil.buildTargetRef("Lyr", true),
    T: {
      t: "obj ",
      v: [
        {
          t: "indx",
          v: {
            classID: "Lyr",
            val: targetIndexInNewList + (insertBeforeTarget ? 0 : 1),
          },
        },
      ],
    },
    Adjs: {
      t: "bool",
      v: false,
    },
    Vrsn: {
      t: "long",
      v: 5,
    },
    Dplc: {
      t: "long",
      v: altDuplicate,
    },
  };
  this.track({
    uf: "move",
    actionDescriptor: moveActionDesc,
  });
}

function handleTimelineFrames(event, dispatcher, doc, panelContext, appData, eventCode, layerIndex, targetLayer) {
  if (event.operation == "merge") {
    const collected = collectAnimationFolders(doc);
    const animationFolderIndices = collected.animationFolderIndices;
    if (animationFolderIndices.length < 2) {
      showToast("At least two animation folders needed (whose layers start with \"_a_\").");
      return;
    }
    const folderTimingData = readFolderFrameTimings(doc, animationFolderIndices);
    const masterTimelineLength = rescaleFolderTimings(folderTimingData);
    const frameDurations = computeMergedFrameDurations(folderTimingData, masterTimelineLength);
    mergeAnimationFoldersToFrames(
      this,
      doc,
      animationFolderIndices,
      collected.animationFolderNames,
      folderTimingData,
      frameDurations,
    );
  }
  if (event.operation == "makeframes") {
    const renameEntries = [];
    for (let loopIdx = 0; loopIdx < doc.selectedLayerIndices.length; loopIdx++) {
      const selectedIndex = doc.selectedLayerIndices[loopIdx];
      const layer = doc.layers[selectedIndex];
      const originalName = layer.getName();
      if (originalName.startsWith("_a_") || layer.add.lsct == LayerSectionType.BoundingDivider) continue;
      renameEntries.push([selectedIndex, originalName, "_a_" + originalName, layer.add.lnsr, null]);
    }
    const historyEntry = createHistoryEntry("layer.nameChange", this, {
      actionKind: Layer.renameLayer,
      renameEntries,
    });
    commitHistoryAndRedo(this, doc, historyEntry);
  }
}

actionHandlers[Layer.replaceLayerStack] = handleReplaceLayerStack;
actionHandlers[Layer.deleteLayer] = handleDeleteLayer;
actionHandlers[Layer.linkLayers] = handleLinkLayers;
actionHandlers[Layer.pasteLayers] = handlePasteLayers;
actionHandlers[Layer.rasterizeLayers] = handleRasterizeLayers;
actionHandlers[Layer.explodeLayerStyles] = handleExplodeLayerStyles;
actionHandlers[Layer.rasterizeLayerStyle] = handleRasterizeLayerStyle;
actionHandlers[Layer.convertTextToShape] = handleConvertTextToShape;
actionHandlers[Layer.autoBlendLayers] = handleAutoBlendLayers;
actionHandlers[Layer.splitOpenVectorPaths] = handleSplitOpenVectorPaths;
actionHandlers[Layer.createSmartObject] = handleCreateSmartObject;
actionHandlers[Layer.dispatch$] = handleDispatch$;
actionHandlers[Layer.updateLinkedItem] = handleUpdateLinkedItem;
actionHandlers[Layer.setSmartObjectStackMode] = handleSetSmartObjectStackMode;
actionHandlers[Layer.placeSmartObject] = handlePlaceSmartObject;
actionHandlers[Layer.flattenImage] = handleFlattenImage;
actionHandlers[Layer.newFolder] = handleNewFolder;
actionHandlers[Layer.groupOrUngroup] = handleGroupOrUngroup;
actionHandlers[Layer.duplicateLayer] = actionHandlers[Layer.duplicateSmartObject] = handleDuplicateLayer;
actionHandlers[Layer.mergeDown] = actionHandlers[Layer.mergeCopy] = actionHandlers[Layer.mergeLayers] = handleMergeLayers;
actionHandlers[Layer.newLayer] =
  actionHandlers[Layer.newAdjustmentLayer] =
  actionHandlers[Layer.newShapeLayer] =
  actionHandlers[Layer.newLayerFromClipboard] =
  actionHandlers[Layer.newLayerViaCopy] =
  actionHandlers[Layer.newLayerViaCut] =
    handleNewLayer;
actionHandlers[Layer.moveLayer] = actionHandlers[Layer.moveSelection] = handleMoveLayer;
actionHandlers[Layer.timelineFrames] = handleTimelineFrames;
