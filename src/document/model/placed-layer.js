/**
 * Placed and smart-object linked file payload (`Layer.LinkedFileItem`): decode
 * embedded bytes, stack modes, and re-rasterize when the transform or filter chain
 * changes.
 */

import { Rect } from "../../core/math/rect.js";
import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { detectFormat, getFormat } from "../formats/registry/registry-helpers.js";
import { Layer } from "./layer.js";
import { Document } from "./document.js";
import { allocBuffer, buildMipPyramidAlpha, extractChannelByte } from "../../engine/compositing/buffer-utils.js";
import { contentBoundsChannel, copyPixels } from "../../engine/compositing/pixel-ops.js";
import { combineLayerPlanes } from "../../engine/compositing/compositing-ops.js";

/** Photoshop smart-object stack modes (`placedData.Impr.v.classID`). */
const STACK_DECODE_MODES = new Set([
  "avrg",
  "maxx",
  "medn",
  "minn",
  "rang",
  "stdv",
  "summ",
  "vari",
]);

function isVectorOrPdfFormat(formatId) {
  return formatId === "svg" || formatId === "pdf";
}

function nestedDocumentTitle(linkedItem) {
  return linkedItem.fileName || "Smart Object";
}

function layerBufferAtDocumentSize(layer, documentBounds) {
  if (layer.rect.equals(documentBounds)) {
    return layer.buffer;
  }
  const fullCanvas = allocBuffer(documentBounds.area() * 4);
  copyPixels(layer.buffer, layer.rect, fullCanvas, documentBounds);
  return fullCanvas;
}

function collectLayerBuffersForStack(nestedDocument, documentBounds) {
  const layerBuffers = [];
  for (let layerIdx = 0; layerIdx < nestedDocument.layers.length; layerIdx++) {
    layerBuffers.push(
      layerBufferAtDocumentSize(nestedDocument.layers[layerIdx], documentBounds),
    );
  }
  return layerBuffers;
}

function rasterizeLayeredViaStack(nestedDocument, documentBounds, stackMode) {
  const layerBuffers = collectLayerBuffersForStack(nestedDocument, documentBounds);
  const rasterPixels = allocBuffer(documentBounds.area() * 4);
  combineLayerPlanes(layerBuffers, rasterPixels, stackMode);
  return rasterPixels;
}

function rasterizeLayeredViaComposite(nestedDocument) {
  for (let layerIdx = 0; layerIdx < nestedDocument.layers.length; layerIdx++) {
    const childLayer = nestedDocument.layers[layerIdx];
    if (childLayer.hasFillContent()) childLayer.invalidate(nestedDocument);
  }
  nestedDocument.rebuildLayerTree();
  nestedDocument.markDirty();
  nestedDocument.composite();
  return nestedDocument.getRasterData();
}

function trimRasterCacheToContent(rasterCache) {
  const [sourcePixels, sourceBounds] = rasterCache;
  const alphaChannel = allocBuffer(sourceBounds.area());
  extractChannelByte(sourcePixels, alphaChannel, 3);
  const contentBounds = contentBoundsChannel(alphaChannel, sourceBounds);
  const trimmedPixels = allocBuffer(contentBounds.area() * 4);
  copyPixels(sourcePixels, sourceBounds, trimmedPixels, contentBounds);
  return [trimmedPixels, contentBounds];
}

class LinkedFileItem {
  constructor() {
    this.type = null;
    this.descriptorVersion = 2;
    this.tag = null;
    this.fileName = "";
    this.fileTypeFourCC = "";
    this.creatorFourCC = "";
    this.open = 0;
    this.raw = null;
    this.rasterCache = null;
    this.rasterDecodeMode = "";
  }

  clone() {
    const clonedItem = new LinkedFileItem();
    clonedItem.type = this.type;
    clonedItem.descriptorVersion = this.descriptorVersion;
    clonedItem.tag = this.tag;
    clonedItem.fileName = this.fileName;
    clonedItem.fileTypeFourCC = this.fileTypeFourCC;
    clonedItem.creatorFourCC = this.creatorFourCC;
    clonedItem.open = this.open;
    clonedItem.raw = new Uint8Array(this.raw.buffer.slice(0));
    return clonedItem;
  }

  /**
   * Decode embedded bytes into `rasterCache` as `[pixels, bounds]`.
   * @param {0|1|null} trimToContentBounds When `1`, crop to non-transparent content.
   * @param {[number, number]|null} targetSize Requested raster size for vector/PDF relayout.
   * @param {string|null} decodeMode Stack mode class id or `"none"`.
   */
  getRasterData(trimToContentBounds, targetSize, decodeMode) {
    if (decodeMode == null) decodeMode = "none";

    const detectedFormat = detectFormat(this.raw.buffer);
    const vectorOrPdf = isVectorOrPdfFormat(detectedFormat);

    if (this.rasterCache) {
      const needsLargerRaster =
        targetSize &&
        vectorOrPdf &&
        Math.max(this.rasterCache[1].width, this.rasterCache[1].height) <
          Math.max(targetSize[0], targetSize[1]);
      if (!needsLargerRaster && decodeMode === this.rasterDecodeMode) {
        return;
      }
    }

    this.rasterDecodeMode = decodeMode;
    if (!vectorOrPdf) trimToContentBounds = 0;

    if (detectedFormat == null) {
      alert("Unsupported format: " + BinaryUtils.readString(this.raw, 0, 4));
      return null;
    }

    const formatHandler = getFormat(detectedFormat);
    if (formatHandler.isLayered) {
      const nestedDocument = new Document(nestedDocumentTitle(this));
      formatHandler.decode(this.raw.buffer, nestedDocument, targetSize);
      const documentBounds = new Rect(0, 0, nestedDocument.width, nestedDocument.height);
      const rasterPixels = STACK_DECODE_MODES.has(decodeMode)
        ? rasterizeLayeredViaStack(nestedDocument, documentBounds, decodeMode)
        : rasterizeLayeredViaComposite(nestedDocument);
      this.rasterCache = [rasterPixels, documentBounds];
    } else if (formatHandler) {
      const decodeResult = formatHandler.decode(this.raw.buffer)[0];
      this.rasterCache = [new Uint8Array(decodeResult.data), decodeResult.rect];
    }

    if (this.rasterCache) {
      if (trimToContentBounds === 1) {
        this.rasterCache = trimRasterCacheToContent(this.rasterCache);
      }
      buildMipPyramidAlpha(this.rasterCache);
    }
  }
}

Layer.LinkedFileItem = LinkedFileItem;

export { LinkedFileItem };
