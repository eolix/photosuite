/**
 * Layer-panel thumbnail drawing: raster/mask/vector previews, fill/adjustment
 * glyphs, and smart-object / linked-layer frame badges.
 */

import { Rect } from '../core/math/rect.js';
import { Locale } from '../core/i18n/locale.js';
import { LayerEffectDefs } from './formats/psd/effect-defs.js';
import { findPattern } from './formats/psd/layer-data-parsers.js';
import { ADJUSTMENT_NAMES, adjustmentKeyOf } from "./formats/psd/adjustment-parsers.js";
import { getDevicePixelRatio, makeElement, resizeCanvasForDevicePixelRatio } from "../core/dom.js";
import { fillBuffer } from "../engine/compositing/buffer-utils.js";
import { renderPathOnContext } from "../engine/compositing/selection-utils.js";
import { checkerboardCell, rgbToHex } from "../engine/compositing/color-math.js";
import { applyGradient, psdColorToRgb } from "../engine/compositing/psd-color-utils.js";

/**
 * Thumbnail painters for the layers, channels and paths panels, plus the redraw
 * caches they share. A thumbnail is repainted on every panel refresh, so the
 * frame overlays, the stroke-style template and the raster scratch buffer are
 * built once and reused.
 *
 * Declared before the functions it holds so they can reach the caches; the
 * painters are attached at the bottom of the file.
 */
export const LayerThumbnails = {
  smartObjectFrameCacheBySize: [],
  linkedLayerFrameCacheBySize: [],
  vectorMaskStrokeStyleTemplate: null,
  thumbImageDataCache: null,
  textLayerThumbCache: null,
};

/** Alias used inside this module's painters. */
const renderer = LayerThumbnails;

function ensureCanvasBackingStore(ctx, cssWidth, cssHeight) {
  const canvas = ctx.canvas;
  const dpr = getDevicePixelRatio();
  const floor = Math.floor;
  if (canvas.width != floor(cssWidth * dpr) || canvas.height != floor(cssHeight * dpr)) {
    resizeCanvasForDevicePixelRatio(canvas, cssWidth, cssHeight, ctx);
  }
}

/** Device-pixel size for a CSS thumbnail box. */
function devicePixelExtent(cssWidth, cssHeight) {
  const dpr = getDevicePixelRatio();
  return {
    dpr: dpr,
    pixelWidth: Math.floor(cssWidth * dpr),
    pixelHeight: Math.floor(cssHeight * dpr)
  };
}

/** Bottom-right badge placement shared by smart-object and linked-layer frames. */
function cornerBadgePlacement(cssWidth, cssHeight) {
  const dpr = getDevicePixelRatio();
  const pixelWidth = Math.floor(dpr * cssWidth);
  const pixelHeight = Math.floor(dpr * cssHeight);
  const frameSize = Math.ceil(Math.max(pixelWidth, pixelHeight) * .35);
  return {
    pixelWidth: pixelWidth,
    pixelHeight: pixelHeight,
    frameSize: frameSize,
    destX: pixelWidth - frameSize,
    destY: pixelHeight - frameSize
  };
}

function sampleMaskGray(maskChannel, docX, docY) {
  const channel = maskChannel.channel;
  const channelRect = maskChannel.rect;
  if (docX < channelRect.x || docX >= channelRect.x + channelRect.width ||
      docY < channelRect.y || docY >= channelRect.y + channelRect.height) {
    return maskChannel.color;
  }
  return channel[(docY - channelRect.y) * channelRect.width + (docX - channelRect.x)];
}

function drawMaskChannelThumbnail(ctx, cssWidth, cssHeight, docRect, maskChannel, previewDim) {
  ensureCanvasBackingStore(ctx, cssWidth, cssHeight);
  if (previewDim == null) previewDim = false;
  const showDisabledOverlay = !maskChannel.isEnabled;
  const extent = devicePixelExtent(cssWidth, cssHeight);
  const pixelWidth = extent.pixelWidth;
  const pixelHeight = extent.pixelHeight;
  if (pixelWidth * pixelHeight == 0) return;
  let imageData = ctx.createImageData(pixelWidth, pixelHeight);
  const pixels = imageData.data;
  const invPixelW = 1 / pixelWidth;
  const invPixelH = 1 / pixelHeight;
  for (let row = 0; row < pixelHeight; row++) {
    for (let col = 0; col < pixelWidth; col++) {
      const flatIdx = row * pixelWidth + col;
      const byteIdx = flatIdx * 4;
      const docX = Math.round(docRect.x + col * invPixelW * docRect.width);
      const docY = Math.round(docRect.y + row * invPixelH * docRect.height);
      let gray = sampleMaskGray(maskChannel, docX, docY);
      gray = 255 * (255 - maskChannel.density) + gray * maskChannel.density >>> 8;
      if (previewDim) gray = 170 + Math.round(.4 * (gray - 170));
      pixels[byteIdx] = gray;
      pixels[byteIdx + 1] = gray;
      pixels[byteIdx + 2] = gray;
      pixels[byteIdx + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  if (showDisabledOverlay) drawDisabledMaskCross(ctx, pixelWidth, pixelHeight);
}

function buildSmartObjectFrameImageData(frameSize) {
  const scratchCanvas = makeElement("canvas");
  const scratchCtx = scratchCanvas.getContext("2d");
  scratchCanvas.width = scratchCanvas.height = frameSize;
  scratchCtx.fillStyle = '#eeeeee';
  scratchCtx.fillRect(0, 0, frameSize, frameSize);
  const inset = Math.round(frameSize * .27);
  const strokeW = scratchCtx.lineWidth = Math.max(1, Math.round(frameSize * .12));
  const halfStroke = strokeW / 2;
  scratchCtx.strokeRect(1 + halfStroke, 1 + halfStroke, frameSize - strokeW - 2, frameSize - strokeW - 2);
  scratchCtx.strokeRect(inset + halfStroke, inset + halfStroke,
    frameSize - inset - inset - strokeW, frameSize - inset - inset - strokeW);
  return scratchCtx.getImageData(0, 0, frameSize, frameSize);
}

function drawSmartObjectFrameOverlay(ctx, cssWidth, cssHeight, placedData) {
  const place = cornerBadgePlacement(cssWidth, cssHeight);
  const frameSize = place.frameSize;
  let cachedFrame = renderer.smartObjectFrameCacheBySize[frameSize];
  if (cachedFrame == null) {
    cachedFrame = renderer.smartObjectFrameCacheBySize[frameSize] =
      buildSmartObjectFrameImageData(frameSize);
  }
  ctx.putImageData(cachedFrame, place.destX, place.destY);
}

function buildLinkedLayerFrameImageData(frameSize) {
  const scratchCanvas = makeElement("canvas");
  const scratchCtx = scratchCanvas.getContext("2d");
  scratchCanvas.width = scratchCanvas.height = frameSize;
  scratchCtx.fillStyle = '#eeeeee';
  scratchCtx.fillRect(0, 0, frameSize, frameSize);
  scratchCtx.lineWidth = 1;
  scratchCtx.strokeRect(2.5, 2.5, frameSize - 5, frameSize - 5);
  const cornerDot = scratchCtx.createImageData(3, 3);
  fillBuffer(cornerDot.data, 4278190080);
  cornerDot.data[4 * 4] = cornerDot.data[4 * 4 + 1] = cornerDot.data[4 * 4 + 2] = 238;
  scratchCtx.putImageData(cornerDot, 1, 1);
  scratchCtx.putImageData(cornerDot, frameSize - 4, 1);
  scratchCtx.putImageData(cornerDot, 1, frameSize - 4);
  scratchCtx.putImageData(cornerDot, frameSize - 4, frameSize - 4);
  return scratchCtx.getImageData(0, 0, frameSize, frameSize);
}

function drawLinkedLayerFrameOverlay(ctx, cssWidth, cssHeight) {
  const place = cornerBadgePlacement(cssWidth, cssHeight);
  const frameSize = place.frameSize;
  let cachedFrame = renderer.linkedLayerFrameCacheBySize[frameSize];
  if (cachedFrame == null) {
    cachedFrame = renderer.linkedLayerFrameCacheBySize[frameSize] =
      buildLinkedLayerFrameImageData(frameSize);
  }
  ctx.putImageData(cachedFrame, place.destX, place.destY);
}

function ensureVectorMaskStrokeStyle() {
  let strokeStyle = renderer.vectorMaskStrokeStyleTemplate;
  if (strokeStyle == null) {
    strokeStyle = renderer.vectorMaskStrokeStyleTemplate =
      LayerEffectDefs.getStrokeStyleDefault();
    strokeStyle.strokeEnabled.v = true;
  }
  return strokeStyle;
}

function drawVectorMaskThumbnail(ctx, cssWidth, cssHeight, docRect, vectorMask) {
  ensureCanvasBackingStore(ctx, cssWidth, cssHeight);
  cssWidth = Math.floor(cssWidth * getDevicePixelRatio());
  cssHeight = Math.floor(cssHeight * getDevicePixelRatio());
  const scale = cssWidth / docRect.width;
  if (cssWidth * cssHeight == 0) return;
  ctx.fillStyle = '#999999';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  let strokeStyle = ensureVectorMaskStrokeStyle();
  strokeStyle.strokeStyleLineWidth.v.val = 1 * getDevicePixelRatio() / scale;
  ctx.fillStyle = '#ffffff';
  ctx.scale(scale, scale);
  renderPathOnContext(vectorMask.pathRecords, ctx, 0, 0);
  renderPathOnContext(vectorMask.pathRecords, ctx, 0, 0, strokeStyle);
}

function drawRasterThumbnail(ctx, cssWidth, cssHeight, docRect, rgba, sampleRect, showDisabled, channelIndex) {
  ensureCanvasBackingStore(ctx, cssWidth, cssHeight);
  cssWidth = Math.floor(cssWidth * getDevicePixelRatio());
  cssHeight = Math.floor(cssHeight * getDevicePixelRatio());
  if (cssWidth * cssHeight == 0) return;
  let cacheSide = Math.max(cssWidth, cssHeight);
  let imageData = renderer.thumbImageDataCache;
  if (imageData == null || imageData.width < cacheSide || imageData.height < cacheSide) {
    renderer.thumbImageDataCache = imageData = ctx.createImageData(cacheSide, cacheSide);
  }
  cacheSide = imageData.width;
  const pixels = imageData.data;
  const scaleX = docRect.width / cssWidth;
  const scaleY = docRect.height / cssHeight;
  const clipLeft = sampleRect.x;
  const clipRight = sampleRect.x + sampleRect.width;
  const clipTop = sampleRect.y;
  const clipBottom = sampleRect.y + sampleRect.height;
  for (let row = 0; row < cssHeight; row++) {
    for (let col = 0; col < cssWidth; col++) {
      const cacheIdx = row * cacheSide + col;
      const byteIdx = cacheIdx * 4;
      const docX = ~~(docRect.x + col * scaleX);
      const docY = ~~(docRect.y + row * scaleY);
      const checker = checkerboardCell(row, col, 2);
      if (docX < clipLeft || docX >= clipRight || docY < clipTop || docY >= clipBottom) {
        pixels[byteIdx] = checker;
        pixels[byteIdx + 1] = checker;
        pixels[byteIdx + 2] = checker;
        pixels[byteIdx + 3] = 255;
      } else {
        const rgbaIdx = (docY - sampleRect.y) * sampleRect.width + (docX - sampleRect.x) << 2;
        const alpha = rgba[rgbaIdx + 3] * (1 / 255);
        pixels[byteIdx] = rgba[rgbaIdx] * alpha + checker * (1 - alpha);
        pixels[byteIdx + 1] = rgba[rgbaIdx + 1] * alpha + checker * (1 - alpha);
        pixels[byteIdx + 2] = rgba[rgbaIdx + 2] * alpha + checker * (1 - alpha);
        pixels[byteIdx + 3] = 255;
      }
    }
  }
  if (channelIndex != null) {
    for (let byteOff = 0; byteOff < pixels.length; byteOff += 4) {
      pixels[byteOff] = pixels[byteOff + 1] = pixels[byteOff + 2] = pixels[byteOff + channelIndex];
    }
  }
  ctx.putImageData(imageData, 0, 0);
  if (showDisabled) drawDisabledMaskCross(ctx, cssWidth, cssHeight);
}

function drawSolidColorFillThumbnail(ctx, cssWidth, cssHeight, solidColor) {
  ensureCanvasBackingStore(ctx, cssWidth, cssHeight);
  ctx.fillStyle = solidFillColorToCss(solidColor.Clr.v);
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  drawLayerStyleThumbFooter(ctx, cssWidth, cssHeight);
}

function drawTextLayerThumbnail(ctx, cssWidth, cssHeight, typeShape) {
  ensureCanvasBackingStore(ctx, cssWidth, cssHeight);
  const canvasW = ctx.canvas.width;
  const canvasH = ctx.canvas.height;
  const cached = renderer.textLayerThumbCache;
  if (cached == null || cached.width != canvasW || cached.height != canvasH) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = '#000000';
    ctx.font = '' + cssHeight * .7 + 'px serif';
    ctx.fillText('T', (cssWidth - cssHeight * .43) / 2, cssHeight * .75);
    ctx.fillText('T', (cssWidth - cssHeight * .43) / 2, cssHeight * .75);
    renderer.textLayerThumbCache = ctx.getImageData(0, 0, canvasW, canvasH);
  } else {
    ctx.putImageData(cached, 0, 0);
  }
}

function drawMissingLayerThumbnail(ctx, cssWidth, cssHeight) {
  ensureCanvasBackingStore(ctx, cssWidth, cssHeight);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.font = cssHeight * .7 + 'px serif';
  ctx.fillText(':(', (cssWidth - cssHeight * .43) / 2, cssHeight * .7);
}

function drawAdjustmentLayerThumbnail(ctx, cssWidth, cssHeight, adjustmentKey) {
  ensureCanvasBackingStore(ctx, cssWidth, cssHeight);
  const adjId = adjustmentKeyOf(adjustmentKey);
  const label = Locale.get(ADJUSTMENT_NAMES[adjId]).substring(0, 3);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = '#000000';
  ctx.font = cssHeight * .55 + 'px sans-serif';
  const metrics = ctx.measureText(label);
  ctx.fillText(label, (cssWidth - metrics.width) / 2, cssHeight * .67);
  ctx.fillRect(0, 0, cssWidth, cssHeight * .1);
  ctx.fillRect(0, cssHeight * .9, cssWidth, cssHeight * .1);
}

function drawGradientFillThumbnail(ctx, cssWidth, cssHeight, gradientFill) {
  ensureCanvasBackingStore(ctx, cssWidth, cssHeight);
  const canvasW = ctx.canvas.width;
  const canvasH = ctx.canvas.height;
  let imageData = ctx.getImageData(0, 0, canvasW, canvasH);
  applyGradient(gradientFill.Grad.v, new Uint8Array(imageData.data.buffer),
    new Rect(0, 0, canvasW, canvasH), [1 / canvasW, 0, 0, 1 / canvasH], canvasW / 2, canvasH / 2, false, 0, 16711680, 65280);
  ctx.putImageData(imageData, 0, 0);
  drawLayerStyleThumbFooter(ctx, cssWidth, cssHeight);
}

function drawPatternFillThumbnail(ctx, cssWidth, cssHeight, patternFill, doc) {
  ensureCanvasBackingStore(ctx, cssWidth, cssHeight);
  const pattern = findPattern(patternFill.Ptrn.v, doc.add.Patt);
  if (pattern == null) return;
  const patternRect = pattern.pixelData[1];
  drawRasterThumbnail(ctx, cssWidth, cssHeight, patternRect, pattern.pixelData[0], patternRect, false);
  drawLayerStyleThumbFooter(ctx, cssWidth, cssHeight);
}

function drawDisabledMaskCross(ctx, pixelWidth, pixelHeight) {
  ctx.strokeStyle = '#bb0000';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(pixelWidth * .15, pixelHeight * .15);
  ctx.lineTo(pixelWidth * .85, pixelHeight * .85);
  ctx.moveTo(pixelWidth * .85, pixelHeight * .15);
  ctx.lineTo(pixelWidth * .15, pixelHeight * .85);
  ctx.closePath();
  ctx.stroke();
}

function drawLayerStyleThumbFooter(ctx, cssWidth, cssHeight) {
  ctx.fillStyle = '#eeeeee';
  ctx.fillRect(0, cssHeight * .75, cssWidth, cssHeight * .25);
  ctx.beginPath();
  ctx.moveTo(0, cssHeight * .75);
  ctx.lineTo(cssWidth, cssHeight * .75);
  ctx.moveTo(cssWidth * .1, cssHeight * .875);
  ctx.lineTo(cssWidth * .9, cssHeight * .875);
  ctx.moveTo(cssWidth * .65, cssHeight * .825);
  ctx.lineTo(cssWidth * .65, cssHeight * .95);
  ctx.closePath();
  ctx.stroke();
}

function solidFillColorToCss(psdColor) {
  const rgb = psdColorToRgb(psdColor);
  const packed = Math.round(rgb.h) << 16 | Math.round(rgb.l) << 8 | Math.round(rgb.O);
  return '#' + rgbToHex(packed);
}

/** Attach the painters onto {@link LayerThumbnails}. */
function installThumbnailRendererApi(renderer) {
  renderer.ensureCanvasBackingStore = ensureCanvasBackingStore;
  renderer.drawMaskChannelThumbnail = drawMaskChannelThumbnail;
  renderer.drawSmartObjectFrameOverlay = drawSmartObjectFrameOverlay;
  renderer.drawLinkedLayerFrameOverlay = drawLinkedLayerFrameOverlay;
  renderer.drawVectorMaskThumbnail = drawVectorMaskThumbnail;
  renderer.drawRasterThumbnail = drawRasterThumbnail;
  renderer.drawSolidColorFillThumbnail = drawSolidColorFillThumbnail;
  renderer.drawTextLayerThumbnail = drawTextLayerThumbnail;
  renderer.drawMissingLayerThumbnail = drawMissingLayerThumbnail;
  renderer.drawAdjustmentLayerThumbnail = drawAdjustmentLayerThumbnail;
  renderer.drawGradientFillThumbnail = drawGradientFillThumbnail;
  renderer.drawPatternFillThumbnail = drawPatternFillThumbnail;
  renderer.drawDisabledMaskCross = drawDisabledMaskCross;
  renderer.drawLayerStyleThumbFooter = drawLayerStyleThumbFooter;
  renderer.solidFillColorToCss = solidFillColorToCss;
}

installThumbnailRendererApi(LayerThumbnails);
