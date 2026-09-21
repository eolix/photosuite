/**
 * Moving layers and the selection across the canvas.
 *
 * Offsetting a layer means offsetting everything pinned to it: its pixel rect,
 * its raster and vector masks, its artboard bounds, a text layer's baseline
 * transform, a smart object's placement quad and the effects riding on it. A
 * layer whose fill is aligned to the canvas repaints instead of shifting.
 *
 * The move tool drags layers through here and layer comps replay recorded
 * offsets. Cropping goes further: `resizeDocumentCanvas` re-origins the whole
 * document, shifting guides, channels, the selection and artboard bounds by
 * the same delta so everything stays where it sat relative to the pixels.
 */

import { Rect } from "../../core/math/rect.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { adjustmentKeyOf } from "../formats/psd/adjustment-parsers.js";
import { packDoublesList, unpackDoublesList } from "../formats/psd/descriptor-codec.js";
import { pixelAlignBoundsFromCoords, rectToPathOutline, transformCoordPairs } from "../../engine/compositing/anti-alias.js";
import { usesCompoundFill } from "../../engine/compositing/path-records.js";
import { transformKeyOriginsWithMatrix } from "../../engine/compositing/key-origins.js";


export function translateLayersByDelta(doc, layerIndices, layerEditFlags, deltaX, deltaY) {
  applyLayerTranslations(doc, layerIndices, layerEditFlags, repeatOffsetForLayers(layerIndices, deltaX, deltaY))
}

export function applyLayerTranslations(doc, layerIndices, layerEditFlags, offsetPairs, invertDelta) {
  if (layerIndices.length == 0) return;
  if (layerEditFlags == null) {
    layerEditFlags = [];
    for (var layerIdx = 0; layerIdx < layerIndices.length; layerIdx++) {
      layerEditFlags.push(doc.layers[layerIndices[layerIdx]].getTransformableChannels(doc, true))
    }
  }
  var dirtyUnion = new Rect,
    fullDocRect = new Rect(0, 0, doc.width, doc.height);
  for (var layerIdx = 0; layerIdx < layerIndices.length; layerIdx++) {
    var deltaX = offsetPairs[2 * layerIdx],
      deltaY = offsetPairs[2 * layerIdx + 1];
    if (invertDelta) {
      deltaX = -deltaX;
      deltaY = -deltaY
    }
    var layer = doc.layers[layerIndices[layerIdx]],
      transformChannels = layerEditFlags[layerIdx];
    if (layer.add.fxrp && (transformChannels.indexOf(0) != -1 || layer.hasFillContent())) layer.add.fxrp.offset(deltaX, deltaY);
    for (var channelIdx = 0; channelIdx < transformChannels.length; channelIdx++) {
      var channelKind = transformChannels[channelIdx];
      if (channelKind == 0) {
        layer.rect.offset(deltaX, deltaY);
        if (layer.hasSmartFilters() && layer.getLinkedPlacedItem(doc)) layer.getLinkedPlacedItem(doc).rect.offset(deltaX, deltaY);
        if (layer.add.artb) {
          var artboardRect = layer.getArtboardRect();
          artboardRect.offset(deltaX, deltaY);
          layer.setArtboardRect(artboardRect)
        }
        if (layer.add.TySh) {
          layer.add.TySh.transform.translate(deltaX, deltaY);
          if (layer.add.TySh.add) {
            layer.add.TySh.add.vmsk.offset(deltaX, deltaY)
          }
        }
        if (layer.add.placedData) {
          var translateMatrix = new Matrix2D(1, 0, 0, 1, deltaX, deltaY),
            placedData = layer.add.placedData,
            affineCoords = unpackDoublesList(placedData.Trnf),
            warpCoords = unpackDoublesList(placedData.nonAffineTransform);
          transformCoordPairs(affineCoords, translateMatrix, affineCoords);
          transformCoordPairs(warpCoords, translateMatrix, warpCoords);
          placedData.Trnf = packDoublesList(affineCoords);
          placedData.nonAffineTransform = packDoublesList(warpCoords);
          transformSmartObjectFilters(placedData, translateMatrix)
        }
      }
      if (channelKind == 1) layer.getMask().rect.offset(deltaX, deltaY);
      if (channelKind == 2) {
        layer.add.vmsk.offset(deltaX, deltaY);
        if (layer.add.vogk) transformKeyOriginsWithMatrix(layer.add.vogk, [1, 0, deltaX, 0, 1, deltaY, 0, 0], [])
      }
      if (channelKind == 3) {
        layer.getLinkedPlacedItem(doc).d.rect.offset(deltaX, deltaY);
        if (transformChannels.length == 1) layer.markDirty()
      }
    }
    if (transformChannels.length > 0) {
      var gradientFill = layer.add.GdFl;
      if (gradientFill == null) gradientFill = layer.add.PtFl;
      if (layer.hasFillContent() && !layer.isVectorShape() && layer.add.vmsk != null && usesCompoundFill(layer.add.vmsk.pathRecords) && layer.add.vmsk.density == 255 && (gradientFill == null || gradientFill.Algn && gradientFill.Algn.v)) {
        layer.rect.offset(deltaX, deltaY)
      } else layer.invalidate(doc);
      var layerDirtyRect = doc.root.getExpandedDirtyRect(layer.getTransformBounds(doc), doc, layerIndices[layerIdx]);
      dirtyUnion = dirtyUnion.union(layerDirtyRect);
      layerDirtyRect.offset(-deltaX, -deltaY);
      dirtyUnion = dirtyUnion.union(layerDirtyRect);
      if (layer.add.SoCo || layer.add.GdFl || layer.add.PtFl || adjustmentKeyOf(layer.add) != null) dirtyUnion = dirtyUnion.union(fullDocRect);
      layer.invalidateAlignedFills()
    }
  }
  doc.markDirty(dirtyUnion)
}

export function repeatOffsetForLayers(layerIndices, deltaX, deltaY) {
  var offsetPairs = [];
  for (var layerIdx = 0; layerIdx < layerIndices.length; layerIdx++) offsetPairs.push(deltaX, deltaY);
  return offsetPairs
}

export function offsetSelectionRect(doc, layerIndex, deltaX, deltaY) {
  var layer = doc.layers[layerIndex];
  doc.selectionMask.rect.offset(deltaX, deltaY);
  layer.syncSelectionOverlay(doc, deltaX, deltaY, doc.selectionMask);
  doc.needsComposite = true;
  doc.markDirty()
}

/** Re-place every artboard's bounds under a transform. */
export function transformArtboardBounds(doc, transformMatrix) {
  for (var layerIdx = 0; layerIdx < doc.layers.length; layerIdx++) {
    var layer = doc.layers[layerIdx];
    if (layer.add.artb == null) continue;
    var artboardCoords = rectToPathOutline(layer.getArtboardRect()).coords;
    transformCoordPairs(artboardCoords, transformMatrix, artboardCoords);
    var alignedBounds = pixelAlignBoundsFromCoords(artboardCoords);
    layer.setArtboardRect(alignedBounds)
  }
}

/**
 * Move the canvas to `newCanvasRect` and take the document's contents with it:
 * layers, guides, extra channels, the selection and artboards all shift by the
 * same delta, so nothing appears to move relative to the pixels.
 */
export function resizeDocumentCanvas(doc, newCanvasRect) {
  doc.width = newCanvasRect.width;
  doc.height = newCanvasRect.height;
  var layerIndices = [];
  for (var layerIdx = 0; layerIdx < doc.layers.length; layerIdx++) layerIndices.push(layerIdx);
  translateLayersByDelta(doc, layerIndices, null, -newCanvasRect.x, -newCanvasRect.y);
  for (var layerIdx = 0; layerIdx < doc.layers.length; layerIdx++) {
    doc.layers[layerIdx].invalidate(doc)
  }
  doc.invalidateAllLayers();
  doc.pathViewport.panOffset.setXY(0, 0);
  if (doc.selectionMask) doc.selectionMask.rect.offset(-newCanvasRect.x, -newCanvasRect.y);
  for (var axisIdx = 0; axisIdx < 2; axisIdx++)
    for (var guideIdx = 0; guideIdx < doc.guides[axisIdx].length; guideIdx++) doc.guides[axisIdx][guideIdx] -= axisIdx == 0 ? newCanvasRect.x : newCanvasRect.y;
  for (var channelIdx = 0; channelIdx < doc.extraChannels.length; channelIdx++) doc.extraChannels[channelIdx].rect.offset(-newCanvasRect.x, -newCanvasRect.y)
}

/**
 * Carry a smart object's puppet-warp pins along with a transform. The pins and
 * their deformed vertex arrays are stored inside the smart filter descriptor,
 * so moving the object without moving them would tear the warp off its mesh.
 */
export function transformSmartObjectFilters(placedData, matrix) {
  let filterList = placedData.filterFX;
  if (filterList) {
    filterList = filterList.v.filterFXList;
  }
  if (filterList) {
    filterList = filterList.v;
  }
  if (filterList) {
    for (let filterIdx = 0; filterIdx < filterList.length; filterIdx++) {
      let filterDescriptor = filterList[filterIdx].v.Fltr;
      if (filterDescriptor == null || filterDescriptor.v.classID !== "rigidTransform") {
        continue;
      }
      filterDescriptor = filterDescriptor.v;
      const cornerCoords = [];
      for (let cornerIdx = 0; cornerIdx < 4; cornerIdx++) {
        cornerCoords.push(
          filterDescriptor["PuX" + cornerIdx].v,
          filterDescriptor["PuY" + cornerIdx].v,
        );
      }
      transformCoordPairs(cornerCoords, matrix, cornerCoords);
      for (let cornerIdx = 0; cornerIdx < 4; cornerIdx++) {
        filterDescriptor["PuX" + cornerIdx].v = cornerCoords[cornerIdx * 2];
        filterDescriptor["PuY" + cornerIdx].v = cornerCoords[cornerIdx * 2 + 1];
      }
      const puppetKeyNames = ["PinP", "posFinalPins"];
      const vertexKeyNames = ["originalVertexArray", "deformedVertexArray"];
      const puppetShapes = filterDescriptor.puppetShapeList.v;
      for (let shapeIdx = 0; shapeIdx < puppetShapes.length; shapeIdx++) {
        const shapeEntry = puppetShapes[shapeIdx].v;
        for (let keyIdx = 0; keyIdx < puppetKeyNames.length; keyIdx++) {
          let packedCoords = unpackDoublesList(shapeEntry[puppetKeyNames[keyIdx]]);
          transformCoordPairs(packedCoords, matrix, packedCoords);
          shapeEntry[puppetKeyNames[keyIdx]] = packDoublesList(packedCoords);
          const vertexBytes = new Uint8Array(shapeEntry[vertexKeyNames[keyIdx]].v);
          const vertexFloats = new Float32Array(vertexBytes.buffer);
          transformCoordPairs(vertexFloats, matrix, vertexFloats);
          const byteArray = [];
          for (let byteIdx = 0; byteIdx < vertexBytes.length; byteIdx++) {
            byteArray[byteIdx] = vertexBytes[byteIdx];
          }
          shapeEntry[vertexKeyNames[keyIdx]].v = byteArray;
        }
      }
    }
  }
}
