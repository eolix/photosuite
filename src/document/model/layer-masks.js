/**
 * The two ways a layer hides part of itself.
 *
 * A **raster mask** (`Mask`) is an 8-bit channel: per-pixel coverage, with a
 * density and feather, optionally inverted, and a flag for whether it moves
 * with the layer. A **vector mask** (`VectorMask`) is a path: subpath records
 * with fill rules, rasterised when the layer is drawn.
 *
 * A layer may carry both: `layer.d` holds the raster mask, `layer.add.vmsk` the
 * vector one. The PSD codecs read and write each independently of the layer
 * that owns it, so both types stand on their own here.
 */

import { Rect } from "../../core/math/rect.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { copyChannel, extend, multiplyMaskByRegion, scaleBuffer, trimChannelToContent } from "../../engine/compositing/pixel-ops.js";
import { pixelAlignRect } from "../../engine/compositing/anti-alias.js";
import { boundsOfPathRecords, minimumCornerAngleRad, rasterizePathToMaskChannel } from "../../engine/compositing/selection-utils.js";
import { transformPathRecordCoords, usesCompoundFill } from "../../engine/compositing/path-records.js";
import { invert } from "../../engine/compositing/color-math.js";
import { gaussianBlurByte } from "../../engine/compositing/blur.js";

export class Mask {
  constructor() {

  this.name = "Mask";
  this.active = false;
  this.overlayTintRgb = {
    h: 255,
    l: 0,
    O: 0
  };
  this.displayOpacity = 50;
  this.indicatorFlags = 0;
  this.color = 255;
  this.enabled = true;
  this.isEnabled = true;
  this.parametersApplied = false;
  this.density = 255;
  this.feather = 0;
  this.rect = new Rect;
  this.channel = allocBuffer(0);
  this.reservedChannelCache = null;
  this.reservedChannelAux = null;
  this.maskCombineDirty = true
  }

  combineWith(otherMask) {
  if (!this.isEnabled) return otherMask;
  var instance = new Mask;
  instance.color = Math.round(this.getThreshold() * otherMask.getThreshold() / 255);
  if (this.getThreshold() == 0 && otherMask.getThreshold() == 0) instance.rect = this.getSelectionRect().intersect(otherMask.getSelectionRect());
  else if (otherMask.getThreshold() == 0) instance.rect = otherMask.getSelectionRect().clone();
  else if (this.getThreshold() == 0) instance.rect = this.getSelectionRect().clone();
  else instance.rect = this.getSelectionRect().union(otherMask.getSelectionRect());
  instance.channel = this.rasterizeTo(instance.rect);
  instance.density = 255;
  instance.feather = 0;
  var rasterizeTo = otherMask.rasterizeTo(instance.rect);
  multiplyMaskByRegion(rasterizeTo, instance.rect, instance.channel, instance.rect);
  return instance;
  }

  getSelectionRect() {
  if (this.feather == 0) return this.rect;
  var ceil = Math.ceil(this.feather * 2.2),
    clonedRect = this.rect.clone();
  clonedRect.inflate(ceil, ceil);
  return clonedRect;
  }

  getMaskBuffer() {
  if (this.feather == 0 && this.density == 255) return this.channel;
  if (this.feather == 0) {
    var densityAdjusted = this.channel.slice(0);
    invert(densityAdjusted);
    scaleBuffer(densityAdjusted, this.density / 255);
    invert(densityAdjusted);
    return densityAdjusted;
  }
  var selectionRect = this.getSelectionRect(),
    maskForRect = this.getMaskForRect(selectionRect),
    blurredBuffer = allocBuffer(selectionRect.area());
  gaussianBlurByte(maskForRect, blurredBuffer, selectionRect, this.feather);
  if (this.density != 255) {
    invert(blurredBuffer);
    scaleBuffer(blurredBuffer, this.density / 255);
    invert(blurredBuffer)
  }
  return blurredBuffer;
  }

  getThreshold() {
  return Math.round(255 - (255 - this.color) * (this.density / 255));
  }

  extend(expandBy) {
  extend(this, expandBy, this.color)
  }

  trimToContent() {
  if (this.color == 255) invert(this.channel);
  trimChannelToContent(this);
  if (this.color == 255) invert(this.channel)
  }

  clone() {
  var instance = new Mask;
  instance.name = this.name;
  instance.active = this.active;
  instance.overlayTintRgb = this.overlayTintRgb;
  instance.displayOpacity = this.displayOpacity;
  instance.indicatorFlags = this.indicatorFlags;
  instance.color = this.color;
  instance.enabled = this.enabled;
  instance.isEnabled = this.isEnabled;
  instance.parametersApplied = this.parametersApplied;
  instance.density = this.density;
  instance.feather = this.feather;
  instance.rect = this.rect.clone();
  instance.channel = this.channel.slice(0);
  return instance;
  }

  getMaskForRect(targetRect, destBuffer) {
  if (destBuffer == null) destBuffer = allocBuffer(targetRect.area());
  destBuffer.fill(this.color);
  copyChannel(this.channel, this.rect, destBuffer, targetRect);
  return destBuffer
  }

  rasterizeTo(destRect, destBuffer) {
  var selectionRect = this.getSelectionRect(),
    maskBuffer = this.getMaskBuffer();
  if (destBuffer == null) destBuffer = allocBuffer(destRect.area());
  destBuffer.fill(this.getThreshold());
  copyChannel(maskBuffer, selectionRect, destBuffer, destRect);
  return destBuffer
  }

}

export class VectorMask {
  constructor() {

  this.enabled = true;
  this.isEnabled = true;
  this.density = 255;
  this.feather = 0;
  this.evenOddFill = 1;
  this.pathRecords = [{
    type: 6
  }, {
    type: 8,
    all: 0
  }];
  this.textOnPathParams = [-3, -3];
  this.reversed = false;
  this.warpData = null;
  this.maskCombineDirty = true;
  this.C = [];
  this.selectedComponents = []
  }

  offset(deltaX, deltaY) {
  this.warpData = this.getMask();
  transformPathRecordCoords(this.pathRecords, new Matrix2D(1, 0, 0, 1, deltaX, deltaY));
  this.warpData.rect.offset(deltaX, deltaY)
  }

  getMask(strokeStyle) {
  if (!this.maskCombineDirty && this.warpData && strokeStyle == null) {
    this.warpData.isEnabled = this.isEnabled;
    return this.warpData;
  }
  var pathBounds = boundsOfPathRecords(this.pathRecords),
    strokeAlignKey = "strokeStyleLineAlignment",
    strokeJoinKey = "strokeStyleLineJoinType";
  if (pathBounds.area() > 3e4 * 3e4) pathBounds = new Rect(0, 0, 100, 100);
  if (strokeStyle && strokeStyle[strokeAlignKey].v[strokeAlignKey] != "strokeStyleAlignInside") {
    var scale = 1;
    if (strokeStyle[strokeJoinKey].v[strokeJoinKey] == "strokeStyleMiterJoin") {
      var cornerAngleRad = minimumCornerAngleRad(this.pathRecords),
        halfAngle = cornerAngleRad / 2,
        sinHalf = Math.sin(halfAngle),
        cosHalf = Math.cos(halfAngle);
      cosHalf /= sinHalf;
      sinHalf = 1;
      var scale = Math.sqrt(cosHalf * cosHalf + sinHalf * sinHalf);
      if (isNaN(scale) || scale < 1) scale = 1
    }
    scale *= strokeStyle[strokeAlignKey].v[strokeAlignKey] == "strokeStyleAlignOutside" ? 1 : .5;
    var ceil = Math.ceil(strokeStyle.strokeStyleLineWidth.v.val * scale);
    ceil = Math.min(ceil, 600);
    pathBounds.inflate(ceil, ceil)
  }
  pathBounds = pixelAlignRect(pathBounds);
  var instance = new Mask;
  instance.color = usesCompoundFill(this.pathRecords) ? 0 : 255;
  instance.enabled = this.enabled;
  instance.isEnabled = this.isEnabled;
  instance.parametersApplied = true;
  instance.rect = pathBounds;
  instance.density = this.density;
  instance.feather = this.feather;
  instance.channel = allocBuffer(instance.rect.area());
  if (!pathBounds.isEmpty()) rasterizePathToMaskChannel(this.pathRecords, instance.channel, instance.rect, strokeStyle);
  if (strokeStyle == null) {
    this.warpData = instance;
    this.maskCombineDirty = false
  }
  return instance;
  }

  clone() {
  var instance = new VectorMask;
  instance.enabled = this.enabled;
  instance.isEnabled = this.isEnabled;
  instance.density = this.density;
  instance.feather = this.feather;
  instance.evenOddFill = this.evenOddFill;
  instance.pathRecords = VectorMask.clonePathRecords(this.pathRecords);
  instance.textOnPathParams = this.textOnPathParams.slice(0);
  instance.reversed = this.reversed;
  instance.C = this.C.slice(0);
  instance.selectedComponents = this.selectedComponents.slice(0);
  return instance;
  }

  concat(otherVectorMask) {
  var sliceCopy = otherVectorMask.pathRecords.slice(2);
  if (sliceCopy.length == 0) return;
  sliceCopy[0].fillRule = 3;
  this.pathRecords = this.pathRecords.concat(sliceCopy)
  }

  resetFillRules() {
  var length = this.pathRecords;
  for (var counter = 3; counter < length.length; counter++)
    if (length[counter].type == 0 || length[counter].type == 3) length[counter].fillRule = -1
  }

  static clonePathRecords(pathRecords) {
  if (!pathRecords) return [];
  var items = [];
  for (var cursor = 0; cursor < pathRecords.length; cursor++) {
    var type = pathRecords[cursor];
    if (type.type > 5 || type.type == 0 || type.type == 3) items.push(JSON.parse(JSON.stringify(type)));
    else items.push({
      type: type.type,
      cp1: type.cp1.clone(),
      anchor: type.anchor.clone(),
      anchorOut: type.anchorOut.clone()
    })
  }
  return items;
  }

  static pathsMatchForStrokeReuse(pathA, pathB, ignoreFillRule) {
  if (pathA.length != pathB.length) return false;
  for (var pathIdx = 2; pathIdx < pathA.length; pathIdx++) {
    var recordA = pathA[pathIdx],
      recordB = pathB[pathIdx];
    if (recordA.type != recordB.type) return false;
    if (recordA.type == 0 || recordA.type == 3) {
      if (recordA.length != recordB.length || !ignoreFillRule && recordA.fillRule != recordB.fillRule) return false
    } else if (!recordA.cp1.equals(recordB.cp1) || !recordA.anchor.equals(recordB.anchor) || !recordA.anchorOut.equals(recordB.anchorOut)) return false
  }
  return true
  }

}
