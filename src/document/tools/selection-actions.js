// Selection action-descriptor builders and selection-mask math shared by the
// selection tools, dialogs, and trackers. Pure functions: no tool state, no
// no tool dependencies. Descriptor FourCC keys are wire format.
import { Rect } from "../../core/math/rect.js";
import { Mask } from "../model/layer-masks.js";
import { allocBuffer, copyBuffer, extractChannelByte, rgbaToGrayChannel } from "../../engine/compositing/buffer-utils.js";
import { copyChannel, copyPixels } from "../../engine/compositing/pixel-ops.js";
import { invert, labSimilarity, rgbToLab } from "../../engine/compositing/color-math.js";
import { gaussianBlurByte } from "../../engine/compositing/blur.js";
import { intersect } from "../../engine/compositing/selection-utils.js";
import { stroke } from "../../engine/compositing/distance-field-stroke.js";

/** Combine-mode name → scripted operation verb for set-selection actions. */
const COMBINE_MODE_OPERATIONS = {
  front: "set",
  union: "addTo",
  difference: "subtractFrom",
  intersection: "interfaceWhite",
};

/**
 * Wire key carrying the pixel amount for each Select > Modify operation,
 * keyed by the operation's first letter (expand/contract → By,
 * border → Wdth, feather/smoothness → Rds).
 */
const MODIFY_AMOUNT_WIRE_KEYS = {
  e: "By",
  c: "By",
  b: "Wdth",
  f: "Rds",
  s: "Rds",
};

/** Base "set the selection channel" action; `selectionDescriptor` becomes T. */
export function buildSetSelectionAction(operationKind, selectionDescriptor) {
  const actionPayload = {
    uf: operationKind,
    actionDescriptor: {
      classID: "setd",
      null: {
        t: "obj ",
        v: [{
          t: "prop",
          v: {
            classID: "Chnl",
            keyID: "fsel",
          },
        }],
      },
    },
  };
  if (selectionDescriptor) actionPayload.actionDescriptor.T = selectionDescriptor;
  return actionPayload;
}

function pixelUnit(val) {
  return { t: "UntF", v: { type: "#Pxl", val } };
}

/** Rectangle / ellipse marquee selection (shapeClassId: Rctn or Elps). */
export function buildRectSelectionAction(shapeClassId, rect) {
  return buildSetSelectionAction("set", {
    t: "Objc",
    v: {
      classID: shapeClassId,
      Top: pixelUnit(rect.y),
      Left: pixelUnit(rect.x),
      Btom: pixelUnit(rect.y + rect.height),
      Rght: pixelUnit(rect.x + rect.width),
    },
  });
}

/** Polygon selection from flat [x0,y0,x1,y1,…] coordinates. */
export function buildPolygonSelectionAction(flatCoords, combineMode) {
  const horizontalCoords = [];
  const verticalCoords = [];
  for (let coordIdx = 0; coordIdx < flatCoords.length; coordIdx += 2) {
    horizontalCoords.push(flatCoords[coordIdx]);
    verticalCoords.push(flatCoords[coordIdx + 1]);
  }
  const polygonDescriptor = {
    t: "Objc",
    v: {
      classID: "Plgn",
      Pts: {
        t: "ObAr",
        v: {
          classID: "Pnt",
          arr: [
            { id: "Hrzn", type: "UnFl", uID: "#Pxl", arr: horizontalCoords },
            { id: "Vrtc", type: "UnFl", uID: "#Pxl", arr: verticalCoords },
          ],
        },
      },
    },
  };
  const operationKind = combineMode ? COMBINE_MODE_OPERATIONS[combineMode] : "set";
  return buildSetSelectionAction(operationKind, polygonDescriptor);
}

/** Magic-wand sample at a point with [tolerance, antialias, contiguous]. */
export function buildMagicWandAtPointAction(point, wandOptions) {
  const actionPayload = buildSetSelectionAction("set", {
    t: "Objc",
    v: {
      classID: "Pnt",
      Hrzn: pixelUnit(point.x),
      Vrtc: pixelUnit(point.y),
    },
  });
  actionPayload.actionDescriptor.Tlrn = { t: "long", v: wandOptions[0] };
  actionPayload.actionDescriptor.AntA = { t: "bool", v: wandOptions[1] };
  actionPayload.actionDescriptor.Cntg = { t: "bool", v: wandOptions[2] };
  return actionPayload;
}

/** Select All (true) or Deselect (false/omitted). */
export function buildSelectAllAction(selectAll) {
  return buildSetSelectionAction("set", {
    t: "enum",
    v: { Ordn: selectAll ? "Al" : "None" },
  });
}

/** Select > Modify (expand/contract/border/feather/smoothness) by pixels. */
export function buildModifySelectionAction(modifyOp, pixelAmount, effectAtCanvasBounds) {
  const descriptorBody = { classID: "null" };
  if (modifyOp != "border") {
    descriptorBody.selectionModifyEffectAtCanvasBounds = { t: "bool", v: effectAtCanvasBounds };
  }
  descriptorBody[MODIFY_AMOUNT_WIRE_KEYS[modifyOp[0]]] = pixelUnit(pixelAmount);
  return {
    uf: modifyOp,
    actionDescriptor: descriptorBody,
  };
}

/** Load a channel (RGB / layer transparency / mask / named extra) as selection. */
export function buildSelectChannelAction(combineModeIndex, channelEnum, layerName) {
  const selectionTarget = {
    t: "obj ",
    v: [{
      t: "prop",
      v: { classID: "Chnl", keyID: "fsel" },
    }],
  };
  const channelRef = {
    t: "obj ",
    v: [{
      t: "Enmr",
      v: { classID: "Chnl", typeID: "Chnl", enum: channelEnum },
    }],
  };
  if (layerName) {
    channelRef.v.push({
      t: "name",
      v: { classID: "Lyr", val: layerName },
    });
  }
  const descriptorVariants = [
    { classID: "null", null: selectionTarget, T: channelRef },
    { classID: "null", null: channelRef, T: selectionTarget },
    { classID: "null", null: channelRef, From: selectionTarget },
    { classID: "null", null: channelRef, With: selectionTarget },
  ];
  const operationKinds = ["set", "add", "subtract", "interfaceIconFrameDimmed"];
  return {
    uf: operationKinds[combineModeIndex],
    actionDescriptor: descriptorVariants[combineModeIndex],
  };
}

/** Shift forces union, Alt difference, both intersection. */
export function resolveSelectionCombineMode(baseMode, shiftDown, altDown) {
  if (shiftDown && altDown) return "intersection";
  if (altDown) return "difference";
  if (shiftDown) return "union";
  return baseMode;
}

/**
 * Feather (gaussian blur) or smooth (blur + hard remap around 128) a mask.
 */
export function refineSelectionMask(selectionMask, radius, smoothness, canvasRect, effectAtCanvasBounds) {
  if (smoothness) radius = Math.round(radius * 0.7);
  const blurPadding = Math.ceil(2.6 * radius);
  let workRect = selectionMask.rect.clone();
  workRect.inflate(blurPadding, blurPadding);
  if (canvasRect && !effectAtCanvasBounds) workRect = workRect.intersect(canvasRect);
  const blurredBuffer = allocBuffer(workRect.area());
  const sourceCopy = allocBuffer(blurredBuffer.length);
  copyChannel(selectionMask.channel, selectionMask.rect, sourceCopy, workRect);
  gaussianBlurByte(sourceCopy, blurredBuffer, workRect, radius);
  if (smoothness) {
    const remapScale = radius * 2.5;
    for (let pixelIdx = 0; pixelIdx < blurredBuffer.length; pixelIdx++) {
      const smoothedValue = (blurredBuffer[pixelIdx] - 128) * remapScale;
      blurredBuffer[pixelIdx] = Math.max(0, Math.min(255, Math.round(128 + smoothedValue)));
    }
  }
  return { channel: blurredBuffer, rect: workRect };
}

/**
 * Border-style grow/shrink via two distance-field strokes intersected.
 */
export function growOrShrinkSelection(selectionMask, growAmount, shrinkAmount) {
  const strokePadding = Math.max(1, Math.ceil(shrinkAmount));
  const workRect = selectionMask.rect.clone();
  workRect.inflate(strokePadding, strokePadding);
  const workArea = workRect.area();
  const resultMask = {
    channel: allocBuffer(workArea),
    rect: workRect,
  };
  const sourceCopy = allocBuffer(workArea);
  copyChannel(selectionMask.channel, selectionMask.rect, sourceCopy, resultMask.rect);
  if (shrinkAmount != 0) stroke(sourceCopy, resultMask.channel, resultMask.rect, shrinkAmount);
  else copyBuffer(sourceCopy, resultMask.channel);
  const invertedBuffer = allocBuffer(workArea);
  invert(sourceCopy);
  if (growAmount != 0) stroke(sourceCopy, invertedBuffer, resultMask.rect, growAmount);
  else copyBuffer(sourceCopy, invertedBuffer);
  intersect(resultMask.channel, invertedBuffer, resultMask.channel);
  return resultMask;
}

/** Rasterize a Mask-like channel into a plain { channel, rect } mask. */
export function channelToSelectionMask(channelMask, canvasRect) {
  let maskBuffer, maskRect;
  if (channelMask.getThreshold() == 0) {
    maskRect = channelMask.getSelectionRect();
    if (maskRect.area() == 0) return;
    maskBuffer = channelMask.getMaskBuffer();
  } else {
    maskRect = canvasRect;
    maskBuffer = allocBuffer(maskRect.area());
    channelMask.rasterizeTo(maskRect, maskBuffer);
  }
  return { channel: maskBuffer, rect: maskRect };
}

/** Channel index the Load Selection default should use for this document. */
export function getDefaultChannelIndexForLoad(doc) {
  if (doc.activeChannels.length != 0) return -5 - doc.activeChannels[0];
  if (JSON.stringify(doc.pathViewport.channelVisibility) == "[1,1,1]") return -1;
  return -2 - doc.pathViewport.channelVisibility.indexOf(1);
}

/** Load an RGB channel (-1..-4) or extra channel (≤ -5) as a selection mask. */
export function loadChannelAsSelectionMask(doc, channelIndex) {
  const canvasRect = new Rect(0, 0, doc.width, doc.height);
  if (-5 < channelIndex && channelIndex < 0) {
    const rgbChannelIndex = -channelIndex - 1;
    const rasterData = doc.getRasterData();
    const grayBuffer = allocBuffer(canvasRect.area());
    if (rgbChannelIndex == 0) rgbaToGrayChannel(rasterData, grayBuffer);
    else extractChannelByte(rasterData, grayBuffer, rgbChannelIndex - 1);
    return { channel: grayBuffer, rect: canvasRect.clone() };
  }
  if (channelIndex < -4) {
    return channelToSelectionMask(doc.extraChannels[-channelIndex - 5], canvasRect);
  }
  return undefined;
}

/**
 * Everything the canvas holds except `selection`. A selection mask is trimmed to
 * the pixels it covers, so it is first laid back onto a full-canvas buffer:
 * inverting in place would leave everything outside that rect unselected.
 */
export function invertSelectionOverCanvas(selection, doc) {
  const canvasRect = new Rect(0, 0, doc.width, doc.height);
  const inverted = {
    channel: allocBuffer(canvasRect.area()),
    rect: canvasRect,
  };
  copyChannel(selection.channel, selection.rect, inverted.channel, inverted.rect);
  invert(inverted.channel);
  return inverted;
}

/** Colour Range: per-pixel Lab similarity scaled by source alpha. */
export function buildColorRangeSelection(doc, labMin, labMax, fuzziness) {
  let sampleRect = new Rect(0, 0, doc.width, doc.height);
  let rasterData = doc.getRasterData();
  if (doc.selectionMask) {
    const clippedRect = doc.selectionMask.rect.intersect(sampleRect);
    const clippedPixels = allocBuffer(clippedRect.area() * 4);
    copyPixels(rasterData, sampleRect, clippedPixels, clippedRect);
    sampleRect = clippedRect;
    rasterData = clippedPixels;
  }
  const pixelCount = sampleRect.area();
  const selectionBuffer = allocBuffer(pixelCount);
  const fuzzinessScale = 1 / fuzziness;
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    const rgbaOffset = pixelIdx << 2;
    const labColor = rgbToLab(rasterData[rgbaOffset], rasterData[rgbaOffset + 1], rasterData[rgbaOffset + 2]);
    const similarity = labSimilarity(labColor, labMin, labMax, fuzziness, fuzzinessScale);
    selectionBuffer[pixelIdx] = rasterData[rgbaOffset + 3] * similarity;
  }
  return { rect: sampleRect, channel: selectionBuffer };
}
