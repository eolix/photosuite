/**
 * Layer tree section node: nested groups, sibling order, hit-testing and the
 * geometry queries built on them. Each `LayerGroup` owns the open/closed
 * section layers that bracket its child stack.
 *
 * This is the tree, not the picture — turning it into pixels is
 * `document/render/layer-compositor.js`.
 */

import { Rect } from "../../core/math/rect.js";
import { LayerSectionType } from "./layer.js";
import { adjustmentKeyOf } from "../formats/psd/adjustment-parsers.js";
import { hitTestChannel, hitTestRgba } from "../../engine/compositing/pixel-ops.js";
import { pixelAlignRect } from "../../engine/compositing/anti-alias.js";
import { hitTestPoint } from "../../engine/compositing/selection-utils.js";

/** Lock bits that exclude a layer from hit-testing. */
const HIT_TEST_LOCK_BITS = [2, 31];

function isLayerBlockedFromHitTest(layer) {
  if (!layer.isVisible()) return true;
  for (let bitIdx = 0; bitIdx < HIT_TEST_LOCK_BITS.length; bitIdx++) {
    if (layer.isLockBitSet(HIT_TEST_LOCK_BITS[bitIdx])) return true;
  }
  return false;
}

class LayerGroup {
  constructor() {
    this.depth = 0;
    this.index = -1;
    this.layer = null;
    this.beginSectionLayer = null;
    this.groupEndIndex = -1;
    this.children = null;
    this.parent = null;
    this.layerIndexTable = null;
  }

  collectPaths(pathStack, pathCollectOutput) {
    if (this.depth !== 0) pathStack.push(this.layer.getName());
    if (this.children) {
      for (let childIdx = 0; childIdx < this.children.length; childIdx++) {
        this.children[childIdx].collectPaths(pathStack, pathCollectOutput);
      }
    }
    if (pathStack.length > pathCollectOutput.deepestPath.length) {
      pathCollectOutput.deepestPath = pathStack.slice(0);
    }
    if (this.depth !== 0) pathStack.pop();
  }

  calculateSize() {
    let totalBytes = 0;
    if (this.layer.isGroup()) {
      for (let childIdx = 0; childIdx < this.children.length; childIdx++) {
        totalBytes += this.children[childIdx].calculateSize();
      }
    } else if (this.layer.buffer) {
      totalBytes += this.layer.buffer.length;
    }
    return totalBytes;
  }

  getSectionByIndex(layerIndex) {
    return this.layerIndexTable[layerIndex];
  }

  hitTestRect(testRect, outIndices) {
    const layer = this.layer;
    if (isLayerBlockedFromHitTest(layer)) return null;
    if (layer.isVectorShape()) {
      const shapeOverlaps = layer.d.rect.overlaps(testRect);
      if (!shapeOverlaps && layer.d.color === 0) return;
    }
    if (layer.isGroup()) {
      for (let childIdx = 0; childIdx < this.children.length; childIdx++) {
        this.children[childIdx].hitTestRect(testRect, outIndices);
      }
    } else if (layer.rect.overlaps(testRect)) {
      outIndices.push(this.index);
    }
  }

  hitTestPoint(docPoint, outIndicesOrNull) {
    const layer = this.layer;
    if (isLayerBlockedFromHitTest(layer)) return null;
    if (layer.isVectorShape()) {
      if (layer.d.rect.containsPoint(docPoint)) {
        if (!hitTestChannel(docPoint, layer.d.channel, layer.d.rect)) return null;
      } else if (layer.d.color === 0) {
        return null;
      }
    }
    if (layer.isGroup()) {
      for (let childIdx = this.children.length - 1; childIdx >= 0; childIdx--) {
        const hitResult = this.children[childIdx].hitTestPoint(docPoint, outIndicesOrNull);
        if (hitResult && outIndicesOrNull == null) return hitResult;
      }
      return null;
    }
    if (
      (layer.add.TySh && layer.rect.containsPoint(docPoint)) ||
      hitTestRgba(docPoint, layer.buffer, layer.rect)
    ) {
      if (outIndicesOrNull == null) return this;
      outIndicesOrNull.push(this.index);
    }
    return null;
  }

  hitTestVectorMaskPath(docPoint) {
    const layer = this.layer;
    if (isLayerBlockedFromHitTest(layer)) return null;
    const vectorMask = layer.add.vmsk;
    if (vectorMask && vectorMask.isEnabled) {
      const pathIdx = hitTestPoint(vectorMask.vectorMask, docPoint).idx;
      if (pathIdx !== -1) {
        return {
          sectionNode: this,
          pathRecordIndex: pathIdx,
        };
      }
    }
    if (layer.isGroup()) {
      for (let childIdx = this.children.length - 1; childIdx >= 0; childIdx--) {
        const hitResult = this.children[childIdx].hitTestVectorMaskPath(docPoint);
        if (hitResult) return hitResult;
      }
      return null;
    }
    return null;
  }

  collectLayerIndices(outIndices, skipPassThroughGroup) {
    outIndices.push(this.index);
    if (!this.layer.isGroup()) return;
    outIndices.push(this.groupEndIndex);
    if (
      skipPassThroughGroup &&
      this.layer.pixelContent === 1 &&
      this.layer.getMask().enabled === false
    ) {
      return;
    }
    for (let childIdx = 0; childIdx < this.children.length; childIdx++) {
      this.children[childIdx].collectLayerIndices(outIndices);
    }
  }

  buildFromLayers(layers, startIndex, depth, indexTable) {
    this.depth = depth;
    const startLayer = layers[startIndex];
    if (indexTable == null) indexTable = [];
    this.layerIndexTable = indexTable;

    if (startLayer.add.lsct !== LayerSectionType.BoundingDivider) {
      this.layer = startLayer;
      this.index = startIndex - 1;
      indexTable[this.index] = this;
      return startIndex + 1;
    }

    this.beginSectionLayer = startLayer;
    this.groupEndIndex = startIndex - 1;
    this.children = [];
    let layerCursor = startIndex + 1;
    while (true) {
      const cursorLayer = layers[layerCursor];
      if (cursorLayer == null) console.log(layerCursor, layers.length);
      if (
        cursorLayer.add.lsct === LayerSectionType.OpenGroup ||
        cursorLayer.add.lsct === LayerSectionType.ClosedGroup
      ) {
        if (startLayer.add.lyid === cursorLayer.add.lyid) startLayer.add.lyid += 16777215;
        this.layer = cursorLayer;
        this.index = layerCursor - 1;
        indexTable[this.index] = this;
        indexTable[startIndex - 1] = this;
        break;
      }
      const childSection = new LayerGroup();
      childSection.parent = this;
      layerCursor = childSection.buildFromLayers(layers, layerCursor, depth + 1, indexTable);
      this.children.push(childSection);
    }
    return layerCursor + 1;
  }

  getExpandedDirtyRect(dirtyRect, doc, layerIndex, includeEffects) {
    let section = this.getSectionByIndex(layerIndex);
    let expandedRect = dirtyRect;
    while (section.parent != null) {
      expandedRect = section.layer.expandRectForEffects(expandedRect, doc, includeEffects);
      section = section.parent;
    }
    return expandedRect;
  }

  getSelectionRect(doc, includeEffects) {
    const layer = this.layer;
    let unionRect = new Rect();
    if (!layer.isVisible()) return unionRect;
    const mask = layer.getMask();
    if (layer.isGroup()) {
      for (let childIdx = 0; childIdx < this.children.length; childIdx++) {
        unionRect = unionRect.union(this.children[childIdx].getSelectionRect(doc, true));
      }
    } else if (adjustmentKeyOf(layer.add) != null) {
      unionRect =
        layer.isVectorShape() && layer.d.color === 0
          ? layer.d.getSelectionRect().clone()
          : new Rect(0, 0, doc.width, doc.height);
    } else if (
      layer.hasFillContent() &&
      layer.add.vmsk &&
      layer.add.vmsk.isEnabled &&
      layer.add.vstk
    ) {
      unionRect = layer.rect.clone();
    } else if (layer.hasFillContent() && mask && mask.isEnabled && mask.getThreshold() !== 0) {
      unionRect = new Rect(0, 0, doc.width, doc.height);
    } else {
      unionRect = layer.getTransformBounds(doc, false, true);
      if (layer.add.vmsk) unionRect = pixelAlignRect(unionRect);
    }
    return includeEffects ? layer.expandRectForEffects(unionRect, doc) : unionRect;
  }

}

export { LayerGroup };
