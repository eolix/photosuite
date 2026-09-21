/**
 * File format registry API: format groups, open/save helpers, data-URL utilities.
 */
import { Matrix2D } from "../../../core/math/matrix2d.js";
import { Rect } from "../../../core/math/rect.js";
import { stripFileExtension } from "../../../core/file-names.js";
import { codecLoaders, getFormat, bytesToBase64, detectFormat } from "./registry-helpers.js";
import { Document } from "../../model/document.js";
import { Layer, LayerSectionType } from "../../model/layer.js";
import { Mask } from "../../model/layer-masks.js";
import { makeElement } from "../../../core/dom.js";
import { transformPixels } from "../../render/raster-transform.js";
import { allocBuffer } from "../../../engine/compositing/buffer-utils.js";
import { trimRgbaToContent } from "../../../engine/compositing/pixel-ops.js";
import { transformPathRecordCoords } from "../../../engine/compositing/path-records.js";


export const formatGroups = {
  primary: ["PNG", "JPG", "SVG", "GIF", "PDF"],
  additional: "WEBP BMP TIFF ICO DDS TGA PPM RAW EMF DXF AF".split(" "),
};

/**
 * Formats that store the document itself — layers, text, smart objects — rather
 * than a rendering of it. Save As offers these alongside the export formats;
 * Export As does not, because an export leaves the document where it is.
 */
export const documentSaveFormatIds = ["PSB", "PSD"];


let dataUrlCanvas = null;

/**
 * Writable format ids in alphabetical order — the order the export dropdowns
 * show. Pass `0` for the primary group or `1` for the additional one.
 */
export function listEncodableFormats(groupIndex) {
  const { primary, additional } = formatGroups;
  const candidates =
    groupIndex == null ? primary.concat(additional) : groupIndex === 0 ? primary : additional;
  const encodable = [];
  for (let formatIdx = 0; formatIdx < candidates.length; formatIdx++) {
    const formatId = candidates[formatIdx];
    if (getFormat(formatId).encode) encodable.push(formatId);
  }
  return encodable.sort();
}

/** Formats Save As offers: the export formats plus PSD and PSB, alphabetical. */
export function listSaveFormats() {
  return listEncodableFormats().concat(documentSaveFormatIds).sort();
}

export function parseDataUrlToBytes(dataUrl) {
  const base64Payload = atob(dataUrl.split(",").pop());
  const bytes = new Uint8Array(base64Payload.length);
  for (let charIdx = 0; charIdx < base64Payload.length; charIdx++) {
    bytes[charIdx] = base64Payload.charCodeAt(charIdx);
  }
  return bytes;
}

export function dataUrlToBuffer(rgbaBuffer, width, height, mimeType, quality) {
  const dataUrl = bufferToDataUrl(rgbaBuffer, width, height, mimeType, quality);
  return parseDataUrlToBytes(dataUrl).buffer;
}

export function bufferToDataUrl(rgbaBuffer, width, height, mimeType, quality, usePngEncoder) {
  if (!(rgbaBuffer instanceof ArrayBuffer)) {
    throw new TypeError("rgbaBuffer must be an ArrayBuffer");
  }
  if (mimeType == null) mimeType = "png";
  if (mimeType === "png" && usePngEncoder === true) {
    const encoded = getFormat("PNG").encode([[rgbaBuffer, 0]], width, height);
    return "data:image/png;base64," + bytesToBase64(encoded);
  }
  let canvas = dataUrlCanvas;
  if (canvas == null) canvas = dataUrlCanvas = makeElement("canvas");
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  const imageData = new ImageData(new Uint8ClampedArray(rgbaBuffer, 0, width * height * 4), width, height);
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/" + mimeType, quality);
}

export function base64ToBuffer(base64) {
  const decoded = atob(base64);
  const bytes = new Uint8Array(decoded.length);
  for (let charIdx = 0; charIdx < decoded.length; charIdx++) {
    bytes[charIdx] = decoded.charCodeAt(charIdx);
  }
  return bytes.buffer;
}

export function collectArtboardLayerIndices(doc) {
  const indices = [];
  const visibility = [];
  for (let layerIdx = 0; layerIdx < doc.layers.length; layerIdx++) {
    const layer = doc.layers[layerIdx];
    if (layer.getName().slice(0, 3) === "_a_") {
      indices.push(layerIdx);
      visibility.push(layer.isVisible());
    }
  }
  return [indices, visibility];
}

function rasterizeExtraChannels(doc, sourceRect) {
  if (doc.extraChannels.length === 0) return undefined;
  const extraChannelRasters = [];
  for (let channelIdx = 0; channelIdx < doc.extraChannels.length; channelIdx++) {
    extraChannelRasters.push(doc.extraChannels[channelIdx].rasterizeTo(sourceRect));
  }
  return extraChannelRasters;
}

function rasterizeDocumentAtSize(doc, width, height, sourceRect, scaleMatrix, copyBuffer = false) {
  if (width === doc.width && height === doc.height) {
    const buffer = doc.getRasterData().buffer;
    return copyBuffer ? buffer.slice(0) : buffer;
  }
  const scaledRaster = codecLoaders.transformPixels(
    [doc.getRasterData(), sourceRect],
    scaleMatrix,
  );
  return scaledRaster.buffer.buffer;
}

function applyAnimationEncodeOptions(framePayloads, encodeOptions) {
  if (!encodeOptions) return framePayloads;
  let payloads = framePayloads;
  const optionCount = encodeOptions.length;
  const reverseFrames = encodeOptions[optionCount - 2];
  const pingPongFrames = encodeOptions[optionCount - 1];
  const frameDurationScale = encodeOptions[optionCount - 4] / 100;
  if (frameDurationScale !== 1) {
    for (let frameIdx = 0; frameIdx < payloads.length; frameIdx++) {
      const duration = payloads[frameIdx][1];
      payloads[frameIdx][1] = Math.round((duration === 0 ? 16 : duration) / frameDurationScale);
    }
  }
  if (reverseFrames) payloads = payloads.slice().reverse();
  if (pingPongFrames) {
    const middleFrames = payloads.slice(1, payloads.length - 1).reverse();
    payloads = payloads.concat(middleFrames);
  }
  return payloads;
}

function encodeArtboardFrames(doc, width, height, sourceRect, scaleMatrix, encodeOptions, extraChannelRasters) {
  const artboardInfo = collectArtboardLayerIndices(doc);
  const artboardIndices = artboardInfo[0];
  const artboardVisibility = artboardInfo[1];
  const framePayloads = [];

  for (let artboardIdx = 0; artboardIdx < artboardIndices.length; artboardIdx++) {
    const activeArtboardIndex = artboardIndices[artboardIdx];
    for (let visibilityIdx = 0; visibilityIdx < artboardIndices.length; visibilityIdx++) {
      doc.layers[artboardIndices[visibilityIdx]].setVisible(
        artboardIndices[visibilityIdx] === activeArtboardIndex,
      );
    }
    doc.rebuildLayerTree();
    doc.markDirty();
    doc.composite();
    const pixelBuffer = rasterizeDocumentAtSize(doc, width, height, sourceRect, scaleMatrix, true);
    const nameParts = doc.layers[activeArtboardIndex].getName().split(",");
    framePayloads.push([
      pixelBuffer,
      nameParts[1] ? parseInt(nameParts[1]) : 100,
      doc.dpi,
      doc.xmpMetadata,
      extraChannelRasters,
    ]);
  }

  for (let artboardIdx = 0; artboardIdx < artboardIndices.length; artboardIdx++) {
    doc.layers[artboardIndices[artboardIdx]].setVisible(artboardVisibility[artboardIdx]);
  }
  doc.markDirty();
  doc.composite();

  return applyAnimationEncodeOptions(framePayloads, encodeOptions);
}

export function encodeDocument(doc, formatId, width, height, encodeOptions, layeredEncodeArg) {
  if (width == null) width = doc.width;
  if (height == null) height = doc.height;
  const sourceRect = new Rect(0, 0, doc.width, doc.height);
  const scaleMatrix = new Matrix2D(
    width / (doc.width + 0.001),
    0,
    0,
    height / (doc.height + 0.001),
    0,
    0,
  );
  formatId = formatId.toUpperCase();
  const codec = getFormat(formatId);

  if (codec.isLayered) {
    doc.getRasterData();
    return codec.encode(doc, width, height, encodeOptions, layeredEncodeArg);
  }

  const artboardInfo = collectArtboardLayerIndices(doc);
  const artboardIndices = artboardInfo[0];
  const extraChannelRasters = rasterizeExtraChannels(doc, sourceRect);

  if (artboardIndices.length < 2) {
    const pixelBuffer = rasterizeDocumentAtSize(doc, width, height, sourceRect, scaleMatrix);
    return codec.encode(
      [[pixelBuffer, 0, doc.dpi, doc.xmpMetadata, extraChannelRasters]],
      width,
      height,
      encodeOptions,
    );
  }

  const framePayloads = encodeArtboardFrames(
    doc,
    width,
    height,
    sourceRect,
    scaleMatrix,
    encodeOptions,
    extraChannelRasters,
  );
  return codec.encode(framePayloads, width, height, encodeOptions);
}

function importPathResources(document, pathResources, documentBounds) {
  for (let pathIdx = 0; pathIdx < pathResources.length; pathIdx++) {
    const pathEntry = pathResources[pathIdx];
    const pathLayer = Document.createPathEntry(pathEntry[0]);
    pathLayer.add.vmsk.pathRecords = pathEntry[1];
    transformPathRecordCoords(
      pathEntry[1],
      new Matrix2D(documentBounds.width, 0, 0, documentBounds.height, 0, 0),
    );
    document.paths.push(pathLayer);
  }
}

/**
 * Build a document from decoded frames. `documentName` is the document's full
 * name, extension included — the name of the file the frames came from.
 */
export function openFiles(documentName, frames) {
  const wrapInArtboardGroup = frames[0].layerName && frames[0].layerName.startsWith("_a_");
  let artboardGroupLayer;
  const document = new Document(documentName);
  let documentBounds = new Rect(0, 0, 1, 1);

  if (wrapInArtboardGroup) {
    artboardGroupLayer = document.newLayer();
    artboardGroupLayer.add.lsct = LayerSectionType.OpenGroup;
    artboardGroupLayer.setName(stripFileExtension(documentName));
    artboardGroupLayer.blendMode = "pass";
    artboardGroupLayer.layerFlags = 24;
    artboardGroupLayer.setVisible(true);
    document.layers.push(document.createGroupEndLayer());
  }

  for (let frameIdx = 0; frameIdx < frames.length; frameIdx++) {
    const frame = frames[frameIdx];
    documentBounds = documentBounds.union(frame.rect);
    const layer = document.newLayer();
    layer.setVisible(frameIdx === 0);
    layer.setName(frames.length === 1 ? "Background" : "Layer " + frameIdx);
    if (frameIdx === 0 && frame.dpi) document.dpi = frame.dpi;
    if (frameIdx === 0 && frame.xmpMetadata) document.xmpMetadata = frame.xmpMetadata;
    if (frame.layerName) layer.setName(frame.layerName);
    if (frame.pathResources) importPathResources(document, frame.pathResources, documentBounds);
    layer.rect = frame.rect.clone();
    layer.buffer = new Uint8Array(frame.data);
    trimRgbaToContent(layer);
    document.layers.push(layer);
  }

  if (wrapInArtboardGroup) document.layers.push(artboardGroupLayer);

  if (frames[0].extraChannels) {
    for (let channelIdx = 0; channelIdx < frames[0].extraChannels.length; channelIdx++) {
      const extraChannel = new Mask();
      document.extraChannels.push(extraChannel);
      extraChannel.rect = frames[0].rect.clone();
      extraChannel.channel = frames[0].extraChannels[channelIdx];
    }
  }

  document.selectedLayerIndices = [wrapInArtboardGroup ? document.layers.length - 1 : 0];
  document.width = documentBounds.width;
  document.height = documentBounds.height;
  document.buffer = allocBuffer(documentBounds.area() * 4);
  document.markDirty();
  return document;
}
