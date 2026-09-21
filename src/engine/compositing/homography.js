/**
 * Homography fitting, composition, pixel warping, and bilinear sampling helpers.
 */

import { Point } from "../../core/math/point.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { solveLinearSystem } from "./matrix-math.js";

const EPS_AFFINE = 1e-10;
const EPS_PERSPECTIVE_FREE = 1e-9;
const EPS_INTEGRAL_COEFF = 1e-9;
const UNIT_QUAD_DST = [0, 0, 1, 0, 1, 1, 0, 1];
const BILINEAR_OFFSET = 0.499999;
const WRAP_OFFSET = 50;
const AFFINE_FAST_PATH_AREA = 4e6;
const SUPERSAMPLE_MAG_THRESHOLD = 1.1;
const SUPERSAMPLE_SCALE = 2.3;
const EDGE_CLAMP_MIN = 0.001;
const EDGE_CLAMP_MAX_FRAC = 0.999;

/** Photoshop quad order: TL, TR, BR, BL as flat x,y pairs. */
function unpackQuadCorners(flatCorners) {
  return {
    topLeftX: flatCorners[0],
    topLeftY: flatCorners[1],
    topRightX: flatCorners[2],
    topRightY: flatCorners[3],
    bottomRightX: flatCorners[6],
    bottomRightY: flatCorners[7],
    bottomLeftX: flatCorners[4],
    bottomLeftY: flatCorners[5],
  };
}

function destinationCornersForBounds(boundsRect) {
  if (!boundsRect) {
    return UNIT_QUAD_DST;
  }
  const left = boundsRect.x;
  const top = boundsRect.y;
  const right = boundsRect.x + boundsRect.width;
  const bottom = boundsRect.y + boundsRect.height;
  return [left, top, right, top, right, bottom, left, bottom];
}

function buildHomographySystem(srcCorners, dstCorners) {
  const src = unpackQuadCorners(srcCorners);
  const dst = unpackQuadCorners(dstCorners);
  return [
    [dst.topLeftX, dst.topLeftY, 1, 0, 0, 0, -dst.topLeftX * src.topLeftX, -dst.topLeftY * src.topLeftX, src.topLeftX],
    [0, 0, 0, dst.topLeftX, dst.topLeftY, 1, -dst.topLeftX * src.topLeftY, -dst.topLeftY * src.topLeftY, src.topLeftY],
    [dst.topRightX, dst.topRightY, 1, 0, 0, 0, -dst.topRightX * src.topRightX, -dst.topRightY * src.topRightX, src.topRightX],
    [0, 0, 0, dst.topRightX, dst.topRightY, 1, -dst.topRightX * src.topRightY, -dst.topRightY * src.topRightY, src.topRightY],
    [dst.bottomRightX, dst.bottomRightY, 1, 0, 0, 0, -dst.bottomRightX * src.bottomRightX, -dst.bottomRightY * src.bottomRightX, src.bottomRightX],
    [0, 0, 0, dst.bottomRightX, dst.bottomRightY, 1, -dst.bottomRightX * src.bottomRightY, -dst.bottomRightY * src.bottomRightY, src.bottomRightY],
    [dst.bottomLeftX, dst.bottomLeftY, 1, 0, 0, 0, -dst.bottomLeftX * src.bottomLeftX, -dst.bottomLeftY * src.bottomLeftX, src.bottomLeftX],
    [0, 0, 0, dst.bottomLeftX, dst.bottomLeftY, 1, -dst.bottomLeftX * src.bottomLeftY, -dst.bottomLeftY * src.bottomLeftY, src.bottomLeftY],
  ];
}

function homographyCoefficientsAreIntegral(homography, srcWidth, srcHeight) {
  let integralSum = 0;
  let coeffsIntegral = true;
  for (let coeffIdx = 0; coeffIdx < 8; coeffIdx++) {
    const roundedCoeff = Math.round(homography[coeffIdx]);
    if (coeffIdx != 2 && coeffIdx != 5) {
      integralSum += Math.abs(roundedCoeff);
    }
    if (Math.abs(roundedCoeff - homography[coeffIdx]) > EPS_INTEGRAL_COEFF) {
      coeffsIntegral = false;
    }
  }
  return coeffsIntegral && integralSum == srcWidth + srcHeight;
}

function computeBaseMagnification(homography, srcWidth, srcHeight) {
  return 1 / Math.sqrt(Math.abs(homography[0] / srcWidth * homography[4] / srcHeight - homography[1] / srcWidth * homography[3] / srcHeight));
}

function computePerspectiveMagnification(homography, normX, normY, col, row, dstRect, srcWidth, srcHeight) {
  let docX = normX + 1 / srcWidth;
  let docY = normY;
  let invW = 1 / (homography[6] * docX + homography[7] * docY + 1);
  let deltaX = (homography[0] * docX + homography[1] * docY + homography[2]) * invW - (col + dstRect.x + 0.5);
  let deltaY = (homography[3] * docX + homography[4] * docY + homography[5]) * invW - (row + dstRect.y + 0.5);
  const magX = deltaX * deltaX + deltaY * deltaY;
  docX = normX;
  docY = normY + 1 / srcHeight;
  invW = 1 / (homography[6] * docX + homography[7] * docY + 1);
  deltaX = (homography[0] * docX + homography[1] * docY + homography[2]) * invW - (col + dstRect.x + 0.5);
  deltaY = (homography[3] * docX + homography[4] * docY + homography[5]) * invW - (row + dstRect.y + 0.5);
  const magY = deltaX * deltaX + deltaY * deltaY;
  return 1 / Math.sqrt(Math.max(magX, magY));
}

function writePremultipliedAverage(dstPixels, dstOff, sumR, sumG, sumB, sumA, subpixelStep) {
  if (sumA == 0) {
    return;
  }
  const invAlpha = 1 / sumA;
  sumR = ~~(sumR * invAlpha + 0.5);
  sumG = ~~(sumG * invAlpha + 0.5);
  sumB = ~~(sumB * invAlpha + 0.5);
  sumA = ~~(sumA * subpixelStep * subpixelStep + 0.5);
  dstPixels[dstOff] = (sumA << 24) | (sumB << 16) | (sumG << 8) | sumR;
}

function sampleCornerPixels(edgeMode, floorX, floorY, width, height, srcPixels) {
  let topLeft = 0;
  let topRight = 0;
  let bottomLeft = 0;
  let bottomRight = 0;
  if (edgeMode == 0) {
    const srcOff = floorY * width + floorX;
    const inLeft = floorX >= 0 && floorX < width;
    const inRight = floorX + 1 >= 0 && floorX + 1 < width;
    const inTop = floorY >= 0 && floorY < height;
    const inBottom = floorY + 1 >= 0 && floorY + 1 < height;
    if (inLeft && inTop) {
      topLeft = srcPixels[srcOff];
    }
    if (inRight && inTop) {
      topRight = srcPixels[srcOff + 1];
    }
    if (inLeft && inBottom) {
      bottomLeft = srcPixels[srcOff + width];
    }
    if (inRight && inBottom) {
      bottomRight = srcPixels[srcOff + width + 1];
    }
  } else if (edgeMode == 1) {
    const clampX0 = floorX < 0 ? 0 : floorX > width - 1 ? width - 1 : floorX;
    const clampX1 = floorX < -1 ? 0 : floorX > width - 2 ? width - 1 : floorX + 1;
    const clampY0 = floorY < 0 ? 0 : floorY > height - 1 ? height - 1 : floorY;
    const clampY1 = floorY < -1 ? 0 : floorY > height - 2 ? height - 1 : floorY + 1;
    topLeft = srcPixels[clampY0 * width + clampX0];
    topRight = srcPixels[clampY0 * width + clampX1];
    bottomLeft = srcPixels[clampY1 * width + clampX0];
    bottomRight = srcPixels[clampY1 * width + clampX1];
  } else {
    const wrapX0 = (floorX + WRAP_OFFSET * width) % width;
    const wrapX1 = (floorX + WRAP_OFFSET * width) % width;
    const wrapY0 = (floorY + WRAP_OFFSET * height) % height;
    const wrapY1 = (floorY + WRAP_OFFSET * height) % height;
    topLeft = srcPixels[wrapY0 * width + wrapX0];
    topRight = srcPixels[wrapY0 * width + wrapX1];
    bottomLeft = srcPixels[wrapY1 * width + wrapX0];
    bottomRight = srcPixels[wrapY1 * width + wrapX1];
  }
  return { topLeft, topRight, bottomLeft, bottomRight };
}

function buildPolarRadiusLookup(stripHeight, radialPower, radiusScale) {
  const radiusLut = [];
  const lutLen = stripHeight * 4;
  const lutInv = 1 / lutLen;
  for (let lutIdx = 0; lutIdx < lutLen; lutIdx++) {
    radiusLut.push(Math.pow(lutIdx * lutInv, 1 / radialPower) * stripHeight * radiusScale);
  }
  return radiusLut;
}

function buildRadialUnitDirections(angularCount, angleOffset, aspectScale, radiusScale) {
  const unitDirs = [];
  const angleStep = (1 + 2 * angleOffset) / angularCount;
  for (let angleIdx = 0; angleIdx < angularCount; angleIdx++) {
    const angleTurns = -0.25 + angleOffset - angleIdx * angleStep;
    unitDirs.push(Math.cos(2 * Math.PI * angleTurns) * aspectScale / radiusScale);
    unitDirs.push(Math.sin(2 * Math.PI * angleTurns) / radiusScale);
  }
  return unitDirs;
}

function computeAffineVisibleSpan(colOrigin, rowOrigin, dstWidth, docToSrcXFromCol, docToSrcYFromCol, invDocToSrcXFromCol, invDocToSrcYFromCol, srcWidth, srcHeight) {
  let spanStart = 0;
  let spanEnd = dstWidth;
  if (docToSrcXFromCol != 0) {
    if (invDocToSrcXFromCol > 0) {
      spanStart = Math.max(spanStart, -colOrigin * invDocToSrcXFromCol);
      spanEnd = Math.min(spanEnd, (srcWidth - colOrigin) * invDocToSrcXFromCol);
    } else {
      spanEnd = Math.min(spanEnd, -colOrigin * invDocToSrcXFromCol);
      spanStart = Math.max(spanStart, (srcWidth - colOrigin) * invDocToSrcXFromCol);
    }
  }
  if (docToSrcYFromCol != 0) {
    if (invDocToSrcYFromCol > 0) {
      spanStart = Math.max(spanStart, -rowOrigin * invDocToSrcYFromCol);
      spanEnd = Math.min(spanEnd, (srcHeight - rowOrigin) * invDocToSrcYFromCol);
    } else {
      spanEnd = Math.min(spanEnd, -rowOrigin * invDocToSrcYFromCol);
      spanStart = Math.max(spanStart, (srcHeight - rowOrigin) * invDocToSrcYFromCol);
    }
  }
  if (spanEnd < 0) {
    spanEnd = 0;
  }
  if (spanStart > spanEnd) {
    spanStart = spanEnd;
  }
  return { spanStart: Math.ceil(spanStart), spanEnd: ~~spanEnd };
}

export function cornersToHomography(srcCorners, boundsRect) {
  return solveHomographyMatrix(srcCorners, destinationCornersForBounds(boundsRect));
}

export function solveHomographyMatrix(srcCorners, dstCorners) {
  const system = buildHomographySystem(srcCorners, dstCorners);
  const rhs = [0, 0, 0, 0, 0, 0, 0, 0];
  const solveErr = solveLinearSystem(system, rhs);
  if (solveErr != 0) {
    return [0, 0, 0, 0, 0, 0, 0, 0];
  }
  return rhs;
}

export function isAffine(homography) {
  return Math.abs(homography[6]) < EPS_AFFINE && Math.abs(homography[7]) < EPS_AFFINE;
}

export function toMatrix2D(homography) {
  return new Matrix2D(homography[0], homography[3], homography[1], homography[4], homography[2], homography[5]);
}

export function matrix2DToHomography(matrix) {
  return [matrix.a, matrix.c, matrix.tx, matrix.b, matrix.d, matrix.ty, 0, 0];
}

export function transformPointsArray(homography, coords) {
  const outXY = new Float64Array(2);
  for (let ptOff = 0; ptOff < coords.length; ptOff += 2) {
    const px = coords[ptOff];
    const py = coords[ptOff + 1];
    homographyTransformXY(px, py, homography, outXY);
    coords[ptOff] = outXY[0];
    coords[ptOff + 1] = outXY[1];
  }
}

export function homographyTransformXY(px, py, homography, outXY) {
  const invW = 1 / (homography[6] * px + homography[7] * py + 1);
  outXY[0] = (homography[0] * px + homography[1] * py + homography[2]) * invW;
  outXY[1] = (homography[3] * px + homography[4] * py + homography[5]) * invW;
}

export function homographyTransformPoint(homography, point) {
  const outXY = new Float64Array(2);
  homographyTransformXY(point.x, point.y, homography, outXY);
  return new Point(outXY[0], outXY[1]);
}

export function transposePixels(srcRgba, dstRgba, width, height) {
  const srcBuf32 = new Uint32Array(srcRgba.buffer);
  const dstBuf32 = new Uint32Array(dstRgba.buffer);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      dstBuf32[col * height + row] = srcBuf32[row * width + col];
    }
  }
}

export function flipPixelsHoriz(srcRgba, dstRgba, width, height) {
  const srcBuf32 = new Uint32Array(srcRgba.buffer);
  const dstBuf32 = new Uint32Array(dstRgba.buffer);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      dstBuf32[row * width + col] = srcBuf32[row * width + width - 1 - col];
    }
  }
}

export function isPerspectiveFree(homography) {
  return Math.abs(homography[6]) < EPS_PERSPECTIVE_FREE && Math.abs(homography[7]) < EPS_PERSPECTIVE_FREE;
}

export function isAxisAligned(homography) {
  return (
    (Math.abs(homography[0]) < EPS_PERSPECTIVE_FREE && Math.abs(homography[4]) < EPS_PERSPECTIVE_FREE) ||
    (Math.abs(homography[1]) < EPS_PERSPECTIVE_FREE && Math.abs(homography[3]) < EPS_PERSPECTIVE_FREE)
  );
}

export function drawImageThroughHomography(homography, srcPixels, srcWidth, srcHeight, dstPixels, dstRect, forceAffine, clampEdges, useFastPath) {
  if (forceAffine == null) {
    forceAffine = false;
  }
  if (clampEdges == null) {
    clampEdges = false;
  }
  const invHomography = invert(homography);
  const baseMagnification = computeBaseMagnification(homography, srcWidth, srcHeight);
  const coeffsIntegral = homographyCoefficientsAreIntegral(homography, srcWidth, srcHeight);
  const perspectiveFree = isPerspectiveFree(homography);
  const axisAligned = isAxisAligned(homography) && perspectiveFree;
  const edgeMode = axisAligned ? 1 : 0;
  if (forceAffine || (coeffsIntegral && perspectiveFree)) {
    warpImageAffine(invHomography, srcPixels, srcWidth, srcHeight, dstPixels, dstRect, clampEdges, perspectiveFree, useFastPath);
    return;
  }
  const rectWidth = dstRect.width;
  const rectHeight = dstRect.height;
  const dstBuf32 = new Uint32Array(dstPixels.buffer);
  const srcBuf32 = new Uint32Array(srcPixels.buffer);
  for (let row = 0; row < rectHeight; row++) {
    for (let col = 0; col < rectWidth; col++) {
      const dstOff = row * rectWidth + col;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumA = 0;
      dstBuf32[dstOff] = 0;
      let docX = col + dstRect.x + 0.5;
      let docY = row + dstRect.y + 0.5;
      let hom = invHomography;
      let invW = 1 / (hom[6] * docX + hom[7] * docY + 1);
      let normX = (hom[0] * docX + hom[1] * docY + hom[2]) * invW;
      let normY = (hom[3] * docX + hom[4] * docY + hom[5]) * invW;
      let srcX = normX * srcWidth;
      let srcY = normY * srcHeight;
      const outOfBounds = srcX < -1 || srcX > srcWidth + 1 || srcY < -1 || srcY > srcHeight + 1;
      if (clampEdges) {
        srcX = Math.max(EDGE_CLAMP_MIN, Math.min(srcWidth - 1, srcX));
        srcY = Math.max(EDGE_CLAMP_MIN, Math.min(srcHeight - 1, srcY));
      } else if (outOfBounds) {
        continue;
      }
      let magScale = baseMagnification;
      if (!perspectiveFree) {
        magScale = computePerspectiveMagnification(homography, normX, normY, col, row, dstRect, srcWidth, srcHeight);
      }
      if (magScale < SUPERSAMPLE_MAG_THRESHOLD) {
        sampleBilinearPixel(srcX, srcY, srcBuf32, srcWidth, srcHeight, dstBuf32, dstOff, edgeMode);
        continue;
      }
      let sampleCount = Math.round(magScale * SUPERSAMPLE_SCALE);
      if (!clampEdges && (srcX < 0.6 || srcX > srcWidth - 0.6 || srcY < 0.6 || srcY > srcHeight - 0.6)) {
        sampleCount = Math.max(sampleCount, 5);
      }
      if (clampEdges && outOfBounds) {
        sampleCount = 1;
      }
      const subpixelStep = 1 / sampleCount;
      const originX = dstRect.x + col;
      const originY = dstRect.y + row;
      hom = invHomography;
      for (let sy = 0; sy < sampleCount; sy++) {
        for (let sx = 0; sx < sampleCount; sx++) {
          docX = originX + (sx + 0.5) * subpixelStep;
          docY = originY + (sy + 0.5) * subpixelStep;
          invW = 1 / (hom[6] * docX + hom[7] * docY + 1);
          srcX = (hom[0] * docX + hom[1] * docY + hom[2]) * invW;
          srcY = (hom[3] * docX + hom[4] * docY + hom[5]) * invW;
          if (clampEdges) {
            srcX = Math.max(EDGE_CLAMP_MIN, Math.min(EDGE_CLAMP_MAX_FRAC, srcX));
            srcY = Math.max(EDGE_CLAMP_MIN, Math.min(EDGE_CLAMP_MAX_FRAC, srcY));
          } else if (srcX < 0 || srcX >= 1 || srcY < 0 || srcY >= 1) {
            continue;
          }
          srcX = Math.floor(srcX * srcWidth);
          srcY = Math.floor(srcY * srcHeight);
          const srcIdx = srcY * srcWidth + srcX;
          const px = srcBuf32[srcIdx];
          const alpha = px >>> 24;
          sumR += (px & 255) * alpha;
          sumG += ((px >>> 8) & 255) * alpha;
          sumB += ((px >>> 16) & 255) * alpha;
          sumA += alpha;
        }
      }
      writePremultipliedAverage(dstBuf32, dstOff, sumR, sumG, sumB, sumA, subpixelStep);
    }
  }
}

export function warpImageAffine(invHomography, srcPixels, srcWidth, srcHeight, dstPixels, dstRect, clampEdges, perspectiveFree, useFastPath) {
  if (perspectiveFree && !clampEdges && dstRect.area() > AFFINE_FAST_PATH_AREA && useFastPath) {
    warpImageAffineInner(invHomography, srcPixels, srcWidth, srcHeight, dstPixels, dstRect, clampEdges, perspectiveFree, useFastPath);
    return;
  }
  const rectRight = dstRect.x + dstRect.width;
  const rectBottom = dstRect.y + dstRect.height;
  let dstOff = 0;
  const dstBuf32 = new Uint32Array(dstPixels.buffer);
  const srcBuf32 = new Uint32Array(srcPixels.buffer);
  const docToSrcXFromDocX = invHomography[0] * srcWidth;
  const docToSrcXFromDocY = invHomography[1] * srcWidth;
  const docToSrcXOffset = invHomography[2] * srcWidth;
  const docToSrcYFromDocX = invHomography[3] * srcHeight;
  const docToSrcYFromDocY = invHomography[4] * srcHeight;
  const docToSrcYOffset = invHomography[5] * srcHeight;
  const perspectiveDenomX = invHomography[6];
  const perspectiveDenomY = invHomography[7];
  if (perspectiveFree && !clampEdges) {
    for (let docY = dstRect.y + 0.5; docY < rectBottom; docY++) {
      for (let docX = dstRect.x + 0.5; docX < rectRight; docX++) {
        const srcX = docToSrcXFromDocX * docX + docToSrcXFromDocY * docY + docToSrcXOffset;
        const srcY = docToSrcYFromDocX * docX + docToSrcYFromDocY * docY + docToSrcYOffset;
        if (0 < srcX && srcX < srcWidth && 0 < srcY && srcY < srcHeight) {
          const srcIdx = ~~srcY * srcWidth + ~~srcX;
          dstBuf32[dstOff] = srcBuf32[srcIdx];
        } else {
          dstBuf32[dstOff] = 0;
        }
        dstOff++;
      }
    }
    return;
  }
  for (let docY = dstRect.y + 0.5; docY < rectBottom; docY++) {
    for (let docX = dstRect.x + 0.5; docX < rectRight; docX++) {
      const invW = 1 / (perspectiveDenomX * docX + perspectiveDenomY * docY + 1);
      let srcX = (docToSrcXFromDocX * docX + docToSrcXFromDocY * docY + docToSrcXOffset) * invW;
      let srcY = (docToSrcYFromDocX * docX + docToSrcYFromDocY * docY + docToSrcYOffset) * invW;
      if (clampEdges) {
        srcX = Math.max(EDGE_CLAMP_MIN, Math.min(srcWidth - 1, srcX));
        srcY = Math.max(EDGE_CLAMP_MIN, Math.min(srcHeight - 1, srcY));
      }
      if (0 < srcX && srcX < srcWidth && 0 < srcY && srcY < srcHeight) {
        const srcIdx = Math.floor(srcY) * srcWidth + Math.floor(srcX);
        dstBuf32[dstOff] = srcBuf32[srcIdx];
      } else {
        dstBuf32[dstOff] = 0;
      }
      dstOff++;
    }
  }
}

export function warpImageAffineInner(invHomography, srcPixels, srcWidth, srcHeight, dstPixels, dstRect, clampEdges, perspectiveFree, useFastPath) {
  const dstBuf32 = new Uint32Array(dstPixels.buffer);
  const srcBuf32 = new Uint32Array(srcPixels.buffer);
  let dstOff = 0;
  if (useFastPath && (dstRect.width & 3) != 0) {
    throw new Error("warpImageAffineInner fast path requires dstRect.width to be a multiple of 4");
  }
  const docToSrcXFromCol = invHomography[0] * srcWidth;
  const docToSrcXFromRow = invHomography[1] * srcWidth;
  const docToSrcXOffset = invHomography[2] * srcWidth;
  const docToSrcYFromCol = invHomography[3] * srcHeight;
  const docToSrcYFromRow = invHomography[4] * srcHeight;
  const docToSrcYOffset = invHomography[5] * srcHeight;
  const dstWidth = dstRect.width;
  const dstHeight = dstRect.height;
  const originX = dstRect.x + 0.5;
  const originY = dstRect.y + 0.5;
  const srcWidthInt = ~~srcWidth;
  const invDocToSrcXFromCol = docToSrcXFromCol == 0 ? 0 : 1 / docToSrcXFromCol;
  const invDocToSrcYFromCol = docToSrcYFromCol == 0 ? 0 : 1 / docToSrcYFromCol;
  for (let row = 0; row < dstHeight; row++) {
    const colOrigin = originX * docToSrcXFromCol + docToSrcXFromRow * (row + originY) + docToSrcXOffset;
    const rowOrigin = originX * docToSrcYFromCol + docToSrcYFromRow * (row + originY) + docToSrcYOffset;
    const { spanStart, spanEnd } = computeAffineVisibleSpan(
      colOrigin,
      rowOrigin,
      dstWidth,
      docToSrcXFromCol,
      docToSrcYFromCol,
      invDocToSrcXFromCol,
      invDocToSrcYFromCol,
      srcWidth,
      srcHeight,
    );
    dstOff = ~~(row * dstWidth);
    for (let col = 0; col < spanStart; col++) {
      dstBuf32[dstOff++] = 0;
    }
    for (let col = spanStart; col < spanEnd; col += 4) {
      const srcX = docToSrcXFromCol * col + colOrigin;
      const srcY = docToSrcYFromCol * col + rowOrigin;
      const srcIdx = ~~srcY * srcWidthInt + ~~srcX;
      const pixel = srcBuf32[srcIdx];
      dstBuf32[dstOff++] = pixel;
      dstBuf32[dstOff++] = pixel;
      dstBuf32[dstOff++] = pixel;
      dstBuf32[dstOff++] = pixel;
    }
    for (let col = spanEnd; col < dstWidth; col++) {
      dstBuf32[dstOff++] = 0;
    }
  }
}

export function invert(homography) {
  const inv00 = homography[4] - homography[5] * homography[7];
  const inv01 = homography[2] * homography[7] - homography[1];
  const inv02 = homography[1] * homography[5] - homography[2] * homography[4];
  const inv10 = homography[5] * homography[6] - homography[3];
  const inv11 = homography[0] - homography[2] * homography[6];
  const inv12 = homography[3] * homography[2] - homography[0] * homography[5];
  const inv20 = homography[3] * homography[7] - homography[4] * homography[6];
  const inv21 = homography[1] * homography[6] - homography[0] * homography[7];
  const detInv = 1 / (homography[0] * homography[4] - homography[1] * homography[3]);
  return [inv00 * detInv, inv01 * detInv, inv02 * detInv, inv10 * detInv, inv11 * detInv, inv12 * detInv, inv20 * detInv, inv21 * detInv];
}

export function composeHomographies(leftHomography, rightHomography) {
  const left0 = leftHomography[0];
  const left1 = leftHomography[1];
  const left2 = leftHomography[2];
  const left3 = leftHomography[3];
  const left4 = leftHomography[4];
  const left5 = leftHomography[5];
  const left6 = leftHomography[6];
  const left7 = leftHomography[7];
  const right0 = rightHomography[0];
  const right1 = rightHomography[1];
  const right2 = rightHomography[2];
  const right3 = rightHomography[3];
  const right4 = rightHomography[4];
  const right5 = rightHomography[5];
  const right6 = rightHomography[6];
  const right7 = rightHomography[7];
  const out = [
    left0 * right0 + left1 * right3 + left2 * right6,
    left0 * right1 + left1 * right4 + left2 * right7,
    left0 * right2 + left1 * right5 + left2,
    left3 * right0 + left4 * right3 + left5 * right6,
    left3 * right1 + left4 * right4 + left5 * right7,
    left3 * right2 + left4 * right5 + left5,
    left6 * right0 + left7 * right3 + right6,
    left6 * right1 + left7 * right4 + right7,
  ];
  const scale = 1 / (left6 * right2 + left7 * right5 + 1);
  for (let coeffIdx = 0; coeffIdx < 8; coeffIdx++) {
    out[coeffIdx] *= scale;
  }
  return out;
}

export function sampleBilinearPixel(srcX, srcY, srcPixels, width, height, dstPixels, dstOff, edgeMode) {
  let px = srcX;
  let py = srcY;
  px -= BILINEAR_OFFSET;
  py -= BILINEAR_OFFSET;
  const floorX = Math.floor(px);
  const floorY = Math.floor(py);
  const { topLeft, topRight, bottomLeft, bottomRight } = sampleCornerPixels(edgeMode, floorX, floorY, width, height, srcPixels);
  const fracX = px - floorX;
  const fracY = py - floorY;
  const weightTopLeft = (1 - fracY) * (1 - fracX) * (topLeft >>> 24);
  const weightTopRight = (1 - fracY) * fracX * (topRight >>> 24);
  const weightBottomLeft = fracY * (1 - fracX) * (bottomLeft >>> 24);
  const weightBottomRight = fracY * fracX * (bottomRight >>> 24);
  let alphaSum = weightTopLeft + weightTopRight + weightBottomLeft + weightBottomRight;
  let outR = weightTopLeft * (topLeft & 255) + weightTopRight * (topRight & 255) + weightBottomLeft * (bottomLeft & 255) + weightBottomRight * (bottomRight & 255);
  let outG = weightTopLeft * ((topLeft >>> 8) & 255) + weightTopRight * ((topRight >>> 8) & 255) + weightBottomLeft * ((bottomLeft >>> 8) & 255) + weightBottomRight * ((bottomRight >>> 8) & 255);
  let outB = weightTopLeft * ((topLeft >>> 16) & 255) + weightTopRight * ((topRight >>> 16) & 255) + weightBottomLeft * ((bottomLeft >>> 16) & 255) + weightBottomRight * ((bottomRight >>> 16) & 255);
  if (alphaSum == 0) {
    dstPixels[dstOff] = 0;
    return;
  }
  const invAlpha = 1 / alphaSum;
  outR = ~~(outR * invAlpha + 0.5);
  outG = ~~(outG * invAlpha + 0.5);
  outB = ~~(outB * invAlpha + 0.5);
  alphaSum = ~~(alphaSum + 0.5);
  dstPixels[dstOff] = (alphaSum << 24) | (outB << 16) | (outG << 8) | outR;
}

export function sampleBilinearFloat(srcX, srcY, floatRgba, rowStride, unused, outRgba) {
  const px = srcX - BILINEAR_OFFSET;
  const py = srcY - BILINEAR_OFFSET;
  const floorX = ~~px;
  const floorY = ~~py;
  const fracX = px - floorX;
  const fracY = py - floorY;
  const weightTopLeft = (1 - fracY) * (1 - fracX);
  const weightTopRight = (1 - fracY) * fracX;
  const weightBottomLeft = fracY * (1 - fracX);
  const weightBottomRight = fracY * fracX;
  const offTl = (floorY * rowStride + floorX) << 2;
  const offBl = ((floorY + 1) * rowStride + floorX) << 2;
  outRgba[0] = weightTopLeft * floatRgba[offTl] + weightTopRight * floatRgba[offTl + 4] + weightBottomLeft * floatRgba[offBl] + weightBottomRight * floatRgba[offBl + 4];
  outRgba[1] = weightTopLeft * floatRgba[offTl + 1] + weightTopRight * floatRgba[offTl + 5] + weightBottomLeft * floatRgba[offBl + 1] + weightBottomRight * floatRgba[offBl + 5];
  outRgba[2] = weightTopLeft * floatRgba[offTl + 2] + weightTopRight * floatRgba[offTl + 6] + weightBottomLeft * floatRgba[offBl + 2] + weightBottomRight * floatRgba[offBl + 6];
  outRgba[3] = weightTopLeft * floatRgba[offTl + 3] + weightTopRight * floatRgba[offTl + 7] + weightBottomLeft * floatRgba[offBl + 3] + weightBottomRight * floatRgba[offBl + 7];
}

export function sampleBilinearWrap(srcX, srcY, grid, gridWidth, gridHeight) {
  const px = srcX - BILINEAR_OFFSET;
  const py = srcY - BILINEAR_OFFSET;
  const floorX = Math.floor(px);
  const floorY = Math.floor(py);
  const fracX = px - floorX;
  const fracY = py - floorY;
  const weightTopLeft = (1 - fracY) * (1 - fracX);
  const weightTopRight = (1 - fracY) * fracX;
  const weightBottomLeft = fracY * (1 - fracX);
  const weightBottomRight = fracY * fracX;
  const wrapX0 = (floorX + WRAP_OFFSET * gridWidth) % gridWidth;
  const wrapX1 = (floorX + 1 + WRAP_OFFSET * gridWidth) % gridWidth;
  const wrapY0 = (floorY + WRAP_OFFSET * gridHeight) % gridHeight;
  const wrapY1 = (floorY + 1 + WRAP_OFFSET * gridHeight) % gridHeight;
  const topLeft = grid[wrapY0 * gridWidth + wrapX0];
  const topRight = grid[wrapY0 * gridWidth + wrapX1];
  const bottomLeft = grid[wrapY1 * gridWidth + wrapX0];
  const bottomRight = grid[wrapY1 * gridWidth + wrapX1];
  if (topLeft == null || bottomRight == null) {
    throw new Error("sampleBilinearWrap: grid sample index out of range");
  }
  return weightTopLeft * topLeft + weightTopRight * topRight + weightBottomLeft * bottomLeft + weightBottomRight * bottomRight;
}

export function sampleRadialStrip(srcPixels, srcWidth, srcHeight, dstPixels, angularCount, radialCount, centerXNorm, centerYNorm, radialPower, angleOffset, radiusScale, aspectScale) {
  const srcBuf32 = new Uint32Array(srcPixels.buffer);
  const dstBuf32 = new Uint32Array(dstPixels.buffer);
  const unitDirs = buildRadialUnitDirections(angularCount, angleOffset, aspectScale, radiusScale);
  const centerX = centerXNorm * srcWidth;
  const centerY = centerYNorm * srcHeight;
  for (let radialIdx = 0; radialIdx < radialCount; radialIdx++) {
    const radius = Math.pow(radialIdx / radialCount, radialPower) * radialCount;
    for (let angleIdx = 0; angleIdx < angularCount; angleIdx++) {
      const srcX = centerX + unitDirs[angleIdx << 1] * radius;
      const srcY = centerY + unitDirs[(angleIdx << 1) + 1] * radius;
      const pixelX = ~~(0.5 + (srcX < 0 ? 0 : srcX > srcWidth - 1 ? srcWidth - 1 : srcX));
      const pixelY = ~~(0.5 + (srcY < 0 ? 0 : srcY > srcHeight - 1 ? srcHeight - 1 : srcY));
      dstBuf32[radialIdx * angularCount + angleIdx] = srcBuf32[pixelY * srcWidth + pixelX];
    }
  }
}

export function samplePolarStrip(stripPixels, stripWidth, stripHeight, dstPixels, dstWidth, dstHeight, centerXNorm, centerYNorm, radialPower, angleOffset, radiusScale, aspectScale) {
  const stripBuf32 = new Uint32Array(stripPixels.buffer);
  const dstBuf32 = new Uint32Array(dstPixels.buffer);
  const centerScale = 1 / aspectScale;
  const radiusLut = buildPolarRadiusLookup(stripHeight, radialPower, radiusScale);
  const centerX = centerXNorm * dstWidth;
  const centerY = centerYNorm * dstHeight;
  for (let dstRow = 0; dstRow < dstHeight; dstRow++) {
    for (let dstCol = 0; dstCol < dstWidth; dstCol++) {
      const deltaX = centerScale * (dstCol - centerX);
      const deltaY = dstRow - centerY;
      let angleNorm = 1.75 - Math.atan2(deltaY, deltaX) * (1 / (2 * Math.PI));
      angleNorm = angleNorm - ~~angleNorm;
      angleNorm = (angleNorm + angleOffset) * (1 / (1 + 2 * angleOffset));
      const radius = radiusLut[~~(Math.sqrt(deltaX * deltaX + deltaY * deltaY) * 4)];
      sampleBilinearPixel(angleNorm * stripWidth + 0.5, radius + 0.5, stripBuf32, stripWidth, stripHeight, dstBuf32, dstRow * dstWidth + dstCol, 1);
    }
  }
}

export function warpWithAffineParams(srcRgba, srcStride, unusedWidth, dstRgba, affineParams) {
  const dstWidth = affineParams[0];
  const dstHeight = affineParams[1];
  for (let row = 0; row < dstHeight; row++) {
    for (let col = 0; col < dstWidth; col++) {
      const srcX = affineParams[2] * col + affineParams[3] * row + affineParams[4];
      const srcY = affineParams[5] * col + affineParams[6] * row + affineParams[7];
      const dstOff = (row * dstWidth + col) << 2;
      const srcOff = (srcY * srcStride + srcX) << 2;
      dstRgba[dstOff] = srcRgba[srcOff + 0];
      dstRgba[dstOff + 1] = srcRgba[srcOff + 1];
      dstRgba[dstOff + 2] = srcRgba[srcOff + 2];
      dstRgba[dstOff + 3] = srcRgba[srcOff + 3];
    }
  }
}
