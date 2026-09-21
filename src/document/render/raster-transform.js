/**
 * Redraws a layer's pixels under a transform.
 *
 * `rasterizeWithMatrix` is the one both the transform tools and the format
 * codecs need: hand it a layer's mip chain and a matrix and it returns the
 * pixels as they should look. A smart object re-rasterises through it when its
 * placement changes, and the vector importers bake a page into a bitmap with it.
 *
 * It knows nothing about documents beyond the buffers and rect it is given,
 * which is why it sits here rather than with the gesture code that drives it.
 */

import { Matrix2D, scaleIgnoringRotation } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { isConvexTransformQuad } from "../transform/transform-box.js";
import { allocBuffer, buildMipPyramidAlpha } from "../../engine/compositing/buffer-utils.js";
import { pixelAlignBoundsFromCoords } from "../../engine/compositing/anti-alias.js";
import { composeHomographies, drawImageThroughHomography, isAffine, matrix2DToHomography, toMatrix2D, transformPointsArray } from "../../engine/compositing/homography.js";
import { drawImageThroughMesh } from "../../engine/compositing/image-renderer.js";
import { getWarpControlPoints, isIdentityWarp } from "../../engine/compositing/warp.js";
import { convolveRGBA, normalizeKernel } from "../../engine/compositing/spatial-filters.js";

export function rasterizeWithMatrix(
  mipChain,
  interpolationMode,
  homography,
  warpMesh,
  reuseBuffer,
  clipRect,
  clipBounds,
  contentAware,
) {
  if (contentAware == null) {
    contentAware = false;
  }
  if (contentAware && clipBounds) {
    throw new Error("content-aware rasterize does not support clipBounds");
  }
  const result = {};
  let mipLevel = 0;
  let scaleThreshold = 0.3;
  if (warpMesh && !isIdentityWarp(warpMesh)) {
    const warpControlPoints = getWarpControlPoints(warpMesh);
    transformPointsArray(homography, warpControlPoints);
    result.rect = pixelAlignBoundsFromCoords(warpControlPoints);
    result.buffer = allocBuffer(result.rect.area() * 4);
    drawImageThroughMesh(
      warpControlPoints,
      mipChain[0],
      mipChain[1].width,
      mipChain[1].height,
      result.buffer,
      result.rect,
      interpolationMode === 0,
    );
    return result;
  }
  buildMipPyramidAlpha(mipChain);
  let pixelBuffer = mipChain[0];
  let sourceRect = mipChain[1];
  const outputArea =
    sourceRect.area() *
    scaleIgnoringRotation(toMatrix2D(homography));
  if (contentAware && outputArea > 4e6) {
    scaleThreshold = outputArea > 8e6 ? 2.2 : 1.2;
  }
  while (
    mipLevel + 3 < mipChain.length &&
    mipChain[mipLevel + 3].area() > 16 &&
    isAffine(homography) &&
    scaleIgnoringRotation(toMatrix2D(homography)) < scaleThreshold
  ) {
    mipLevel += 2;
    const mipBuffer = mipChain[mipLevel];
    const mipRect = mipChain[mipLevel + 1];
    const scaleX = sourceRect.width / mipRect.width;
    const scaleY = sourceRect.height / mipRect.height;
    homography = composeHomographies(homography, [
      1,
      0,
      sourceRect.x,
      0,
      1,
      sourceRect.y,
      0,
      0,
    ]);
    homography = composeHomographies(homography, [
      scaleX,
      0,
      0,
      0,
      scaleY,
      0,
      0,
      0,
    ]);
    homography = composeHomographies(homography, [
      1,
      0,
      -sourceRect.x,
      0,
      1,
      -sourceRect.y,
      0,
      0,
    ]);
    sourceRect = mipRect;
    pixelBuffer = mipBuffer;
  }
  const composedHomography = composeHomographies(
    homography,
    matrix2DToHomography(
      new Matrix2D(sourceRect.width, 0, 0, sourceRect.height, sourceRect.x, sourceRect.y),
    ),
  );
  const unitSquare = [0, 0, 1, 0, 1, 1, 0, 1];
  transformPointsArray(composedHomography, unitSquare);
  result.rect = pixelAlignBoundsFromCoords(unitSquare);
  if (clipBounds) {
    result.rect = result.rect.intersect(clipBounds);
  }
  if (contentAware) {
    while ((result.rect.width & 3) !== 0) {
      result.rect.width++;
    }
    while ((result.rect.height & 3) !== 0) {
      result.rect.height++;
    }
  }
  if (
    !isConvexTransformQuad(unitSquare) ||
    result.rect.width > 1e5 ||
    result.rect.height > 1e5 ||
    result.rect.area() > 3e4 * 3e4
  ) {
    return null;
  }
  const bufferBytes = result.rect.area() * 4;
  if (reuseBuffer && reuseBuffer.byteLength >= bufferBytes && bufferBytes >= reuseBuffer.byteLength >> 2) {
    result.buffer = new Uint8Array(reuseBuffer);
  } else {
    result.buffer = allocBuffer(bufferBytes);
  }
  drawImageThroughHomography(
    composedHomography,
    pixelBuffer,
    sourceRect.width,
    sourceRect.height,
    result.buffer,
    result.rect,
    interpolationMode === 0,
    clipRect,
    contentAware,
  );
  if (interpolationMode === 2 && result.buffer) {
    const width = result.rect.width;
    const height = result.rect.height;
    let sharpenKernel = [0, -1, 0, -1, 16, -1, 0, -1, 0];
    sharpenKernel = normalizeKernel(sharpenKernel);
    const tempBuffer = result.buffer.slice(0);
    convolveRGBA(
      tempBuffer,
      result.buffer,
      width,
      height,
      sharpenKernel,
      255,
      false,
      true,
    );
  }
  if (result.buffer) {
    return result;
  }
}

export function transformPixels(
  rasterPair,
  matrix2D,
  contentAware,
  reuseBuffer,
  clipRect,
  extraFlag,
) {
  if (contentAware == null) {
    contentAware = false;
  }
  return rasterizeWithMatrix(
    rasterPair,
    contentAware ? 0 : 1,
    matrix2DToHomography(matrix2D),
    null,
    reuseBuffer,
    clipRect,
    extraFlag,
    contentAware,
  );
}
