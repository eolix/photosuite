/**
 * Image displacement warps and Photoshop-style layer envelope warps
 * (imageWarp / layerWarp).
 */

import { Rect } from '../../core/math/rect.js';
import { Matrix2D } from '../../core/math/matrix2d.js';
import { lerpCoordPairs, transformCoordPairs } from "./anti-alias.js";
import { sampleBilinearPixel } from "./homography.js";
import { rotateMeshControlPoints90 } from "./image-renderer.js";
import { meshControlPointsFromRect } from "./image-renderer.js";


export function applyWarp(src, dst, imgWidth, imgHeight, region, field, fieldWidth, fieldHeight, sampleFlag) {
  const srcPixels = new Uint32Array(src.buffer);
  const dstPixels = new Uint32Array(dst.buffer);
  const fieldScaleX = fieldWidth / imgWidth;
  const fieldScaleY = fieldHeight / imgHeight;
  const invScaleX = 1 / fieldScaleX;
  const invScaleY = 1 / fieldScaleY;
  const displacement = new Float64Array(2);
  let regionX = 0;
  let regionY = 0;
  let regionWidth = imgWidth;
  let regionHeight = imgHeight;
  if (region) {
    regionX = region.x;
    regionY = region.y;
    regionWidth = region.width;
    regionHeight = region.height
  }
  for (let row = 0; row < regionHeight; row++)
    for (let col = 0; col < regionWidth; col++) {
      const x = regionX + col;
      const y = regionY + row;
      const index = y * imgWidth + x;
      sampleDisplacementField(field, fieldWidth, fieldHeight, (x + .5) * fieldScaleX, (y + .5) * fieldScaleY, displacement);
      const dx = displacement[0] * invScaleX;
      const dy = displacement[1] * invScaleY;
      if (dx == 0 && dy == 0) dstPixels[index] = srcPixels[index];
      else {
        sampleBilinearPixel(x + dx + .5, y + dy + .5, srcPixels, imgWidth, imgHeight, dstPixels, index, sampleFlag)
      }
    }
}

/** Bilinear sample of a packed XY displacement field into out[0]/out[1]. */
export function sampleDisplacementField(field, fieldWidth, fieldHeight, sampleX, sampleY, out) {
  sampleX -= .499999;
  sampleY -= .499999;
  const floorX = ~~sampleX;
  const floorY = ~~sampleY;
  const fracX = sampleX - floorX;
  const fracY = sampleY - floorY;
  const weightTopLeft = (1 - fracY) * (1 - fracX);
  const weightTopRight = (1 - fracY) * fracX;
  const weightBottomLeft = fracY * (1 - fracX);
  const weightBottomRight = fracY * fracX;
  const ceilX = floorX < fieldWidth - 1 ? floorX + 1 : floorX;
  const ceilY = floorY < fieldHeight - 1 ? floorY + 1 : floorY;
  const offsetTopLeft = floorY * fieldWidth + floorX << 1;
  const offsetTopRight = floorY * fieldWidth + ceilX << 1;
  const offsetBottomLeft = ceilY * fieldWidth + floorX << 1;
  const offsetBottomRight = ceilY * fieldWidth + ceilX << 1;
  out[0] = weightTopLeft * field[offsetTopLeft] + weightTopRight * field[offsetTopRight] + weightBottomLeft * field[offsetBottomLeft] + weightBottomRight * field[offsetBottomRight];
  out[1] = weightTopLeft * field[offsetTopLeft + 1] + weightTopRight * field[offsetTopRight + 1] + weightBottomLeft * field[offsetBottomLeft + 1] + weightBottomRight * field[offsetBottomRight + 1]
}

export function calcArcCosOffset(cosAngle) {
  return (4 - cosAngle) * (1 / 3)
}

export function calcArcSinOffset(cosAngle, sinAngle) {
  return (1 - cosAngle) * (3 - cosAngle) / (3 * sinAngle)
}

/** Shared arc / shell geometry for bend-based warp styles. */
function buildBendArcGeometry(halfW, halfH, bendAmount) {
  const bendAbs = Math.abs(bendAmount);
  const tanSlope = Math.tan((1 - bendAbs) * Math.PI / 2);
  const hypot = Math.sqrt(tanSlope * tanSlope + 1);
  const arcAngle = Math.atan2(1, tanSlope);
  const arcRadius = halfW * hypot;
  const arcRadiusExt = halfW * hypot + halfH * 2;
  const cosArc = Math.cos(arcAngle);
  const sinArc = Math.sin(arcAngle);
  const cosOffset = calcArcCosOffset(cosArc);
  const sinOffset = calcArcSinOffset(cosArc, sinArc);
  const shellBaseY = -tanSlope * halfW + cosOffset * arcRadius;
  return {
    tanSlope: tanSlope,
    arcAngle: arcAngle,
    arcRadius: arcRadius,
    arcRadiusExt: arcRadiusExt,
    cosArc: cosArc,
    sinArc: sinArc,
    cosOffset: cosOffset,
    sinOffset: sinOffset,
    shellBaseY: shellBaseY
  };
}

export function isIdentityWarp(warpDesc) {
  const warpStyle = warpDesc.warpStyle.v.warpStyle;
  if (warpStyle == "warpNone") return true;
  else if (warpStyle == "warpCustom") {
    let meshDeformed = false;
    const meshArr = warpDesc.customEnvelopeWarp.v.meshPoints.v.arr;
    const horizArr = meshArr[0].arr;
    const vertArr = meshArr[1].arr;
    for (let col = 0; col < 4; col++)
      for (let row = 0; row < 4; row++) {
        if (Math.abs(horizArr[col] - horizArr[row * 4 + col]) > 1 || Math.abs(vertArr[col * 4] - vertArr[col * 4 + row]) > 1) meshDeformed = true
      }
    return !meshDeformed
  } else return warpDesc.warpValue.v == 0 && warpDesc.warpPerspective.v == 0 && warpDesc.warpPerspectiveOther.v == 0
}

export function defaultWarpDescriptor(boundsRect) {
  const warpDesc = {
    classID: "warp",
    warpStyle: {
      t: "enum",
      v: {
        warpStyle: "warpNone"
      }
    },
    warpValue: {
      t: "doub",
      v: 0
    },
    warpPerspective: {
      t: "doub",
      v: 0
    },
    warpPerspectiveOther: {
      t: "doub",
      v: 0
    },
    warpRotate: {
      t: "enum",
      v: {
        Ornt: "Hrzn"
      }
    }
  };
  if (boundsRect) {
    warpDesc.bounds = {
      t: "Objc",
      v: {
        classID: "Rctn",
        Top: {
          t: "UntF",
          v: {
            type: "#Pxl",
            val: boundsRect.y
          }
        },
        Left: {
          t: "UntF",
          v: {
            type: "#Pxl",
            val: boundsRect.x
          }
        },
        Btom: {
          t: "UntF",
          v: {
            type: "#Pxl",
            val: boundsRect.y + boundsRect.height
          }
        },
        Rght: {
          t: "UntF",
          v: {
            type: "#Pxl",
            val: boundsRect.x + boundsRect.width
          }
        }
      }
    };
    warpDesc.uOrder = {
      t: "long",
      v: 4
    };
    warpDesc.vOrder = {
      t: "long",
      v: 4
    }
  }
  return warpDesc
}

export function applyPerspectiveScale(coords, bounds, horizPersp, vertPersp) {
  for (let ptOff = 0; ptOff < coords.length; ptOff += 2) {
    let px = coords[ptOff];
    let py = coords[ptOff + 1];
    let normX = (px - bounds.x) / bounds.width;
    let normY = (py - bounds.y) / bounds.height;
    const horizMin = (1 - horizPersp) / 2;
    const horizMax = 1 - horizMin;
    const horizScale = horizMin + normX * (horizMax - horizMin);
    normY = .5 + (normY - .5) * horizScale * 2;
    const vertMin = (1 - vertPersp) / 2;
    const vertMax = 1 - vertMin;
    const vertScale = vertMin + normY * (vertMax - vertMin);
    normX = .5 + (normX - .5) * vertScale * 2;
    px = bounds.x + normX * bounds.width;
    py = bounds.y + normY * bounds.height;
    coords[ptOff] = px;
    coords[ptOff + 1] = py
  }
}

export function pointsToCustomEnvelope(coords, warpDescOut) {
  const horizArr = [];
  const vertArr = [];
  for (let ptOff = 0; ptOff < coords.length; ptOff += 2) {
    horizArr.push(coords[ptOff]);
    vertArr.push(coords[ptOff + 1])
  }
  const meshPointArr = [];
  meshPointArr.push({
    id: "Hrzn",
    type: "UnFl",
    uID: "#Pxl",
    arr: horizArr
  });
  meshPointArr.push({
    id: "Vrtc",
    type: "UnFl",
    uID: "#Pxl",
    arr: vertArr
  });
  warpDescOut.warpStyle.v.warpStyle = "warpCustom";
  warpDescOut.customEnvelopeWarp = {
    t: "Objc",
    v: {
      classID: "customEnvelopeWarp",
      meshPoints: {
        t: "ObAr",
        v: {
          classID: "rationalPoint",
          arr: meshPointArr
        }
      }
    }
  }
}

export function getWarpControlPoints(warpDesc, boundsRect) {
  if (boundsRect == null) {
    const boundsObj = warpDesc.bounds.v;
    const left = boundsObj.Left.v.val;
    const right = boundsObj.Rght.v.val;
    const top = boundsObj.Top.v.val;
    const bottom = boundsObj.Btom.v.val;
    boundsRect = new Rect(left, top, right - left, bottom - top)
  }
  if (boundsRect.isEmpty()) boundsRect.width = boundsRect.height = 1;
  let controlPoints = [];
  const warpStyle = warpDesc.warpStyle.v.warpStyle;
  if (warpStyle == "warpCustom") {
    const meshArr = warpDesc.customEnvelopeWarp.v.meshPoints.v.arr;
    const horizArr = meshArr[0].arr;
    const vertArr = meshArr[1].arr;
    for (let ptIdx = 0; ptIdx < 16; ptIdx++) controlPoints.push(horizArr[ptIdx], vertArr[ptIdx])
  } else controlPoints = computeWarpGrid(boundsRect, warpStyle, warpDesc.warpRotate.v.Ornt == "Hrzn", warpDesc.warpValue.v / 100, warpDesc.warpPerspective.v / 100, warpDesc.warpPerspectiveOther.v / 100);
  return controlPoints
}

export function computeWarpGrid(bounds, warpStyle, isHorizontal, bendAmount, perspH, perspV) {
  let coords = meshControlPointsFromRect(bounds.x, bounds.y, bounds.width, bounds.height);
  if (warpStyle == "warpNone") return coords;
  const savedBounds = JSON.parse(JSON.stringify(bounds));
  const rotMatrix = new Matrix2D;
  if (!isHorizontal) {
    rotMatrix.translate(-bounds.x, -bounds.y);
    rotMatrix.rotate(-Math.PI / 2);
    rotMatrix.translate(bounds.height, 0);
    transformCoordPairs(coords, rotMatrix, coords);
    bounds = new Rect(0, 0, bounds.height, bounds.width);
    coords = rotateMeshControlPoints90(coords, false)
  }
  applyWarpStyle(coords, bounds, warpStyle, bendAmount, perspH, perspV);
  if (!isHorizontal) {
    coords = rotateMeshControlPoints90(coords, true);
    bounds = savedBounds;
    rotMatrix.invert();
    transformCoordPairs(coords, rotMatrix, coords)
  }
  if (bendAmount == 0) applyPerspectiveScale(coords, bounds, perspH, perspV);
  else {
    const normMatrix = new Matrix2D(1 / bounds.width, 0, 0, 1 / bounds.height, -bounds.x, -bounds.y);
    normMatrix.translate(-.5, -.5);
    transformCoordPairs(coords, normMatrix, coords);
    applyPerspectiveGrid(coords, perspV, perspH);
    normMatrix.invert();
    transformCoordPairs(coords, normMatrix, coords)
  }
  return coords
}

export function applyWarpStyle(coords, bounds, warpStyle, bendAmount, perspH, perspV) {
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const coordOff = 2 * (4 * row + col);
      let localX = coords[coordOff] - bounds.x;
      let localY = coords[coordOff + 1] - bounds.y;
      let warpedX = localX;
      let warpedY = localY;
      if (bendAmount != 0) {
        const halfW = bounds.width / 2;
        const halfH = bounds.height / 2;
        warpedX -= halfW;
        warpedY -= halfH;
        let arcLeftX = warpedX;
        let arcRightX = warpedX;
        let arcTopY = -halfH;
        let arcBotY = halfH;
        const arc = buildBendArcGeometry(halfW, halfH, bendAmount);
        const tanSlope = arc.tanSlope;
        const arcAngle = arc.arcAngle;
        const arcParam = warpedX / halfW * arcAngle;
        const arcRadius = arc.arcRadius;
        const arcRadiusExt = arc.arcRadiusExt;
        const cosOffset = arc.cosOffset;
        const sinOffset = arc.sinOffset;
        const shellBaseY = arc.shellBaseY;
        if (warpStyle == "warpArc") {
          arcLeftX = Math.sin(arcParam) * arcRadiusExt;
          arcTopY = tanSlope * halfW - Math.cos(arcAngle) * arcRadiusExt + halfH;
          arcRightX = Math.sin(arcParam) * arcRadius;
          arcBotY = tanSlope * halfW - Math.cos(arcAngle) * arcRadius + halfH;
          if (col == 1 || col == 2) {
            arcLeftX = col == 1 ? -sinOffset * arcRadiusExt : sinOffset * arcRadiusExt;
            arcRightX = col == 1 ? -sinOffset * arcRadius : sinOffset * arcRadius;
            arcTopY = tanSlope * halfW + halfH - cosOffset * arcRadiusExt;
            arcBotY = tanSlope * halfW + halfH - cosOffset * arcRadius
          }
          if (bendAmount < 0) {
            let swapX = arcLeftX;
            arcLeftX = arcRightX;
            arcRightX = swapX;
            swapX = arcTopY;
            arcTopY = -arcBotY;
            arcBotY = -swapX
          }
        }
        if (warpStyle == "warpArcLower") {
          if (col == 1 || col == 2) {
            arcRightX = col == 1 ? -sinOffset * arcRadius : sinOffset * arcRadius;
            arcBotY = bendAmount < 0 ? halfH - shellBaseY : halfH + shellBaseY
          }
        }
        if (warpStyle == "warpArcUpper" || warpStyle == "warpArch" || warpStyle == "warpBulge") {
          if (col == 1 || col == 2) {
            arcLeftX = col == 1 ? -sinOffset * arcRadius : sinOffset * arcRadius;
            arcTopY = bendAmount < 0 ? -halfH + shellBaseY : -halfH - shellBaseY
          }
          if (warpStyle == "warpArch") {
            arcRightX = arcLeftX;
            arcBotY = arcTopY + 2 * halfH
          }
          if (warpStyle == "warpBulge") {
            arcRightX = arcLeftX;
            arcBotY = -arcTopY
          }
        }
        if (warpStyle == "warpFish" || warpStyle == "warpFlag" || warpStyle == "warpWave") {
          if (col == 1) {
            arcTopY -= bendAmount * 4 * halfH;
            arcBotY += bendAmount * 4 * halfH
          }
          if (col == 2) {
            arcTopY += bendAmount * 4 * halfH;
            arcBotY -= bendAmount * 4 * halfH
          }
          if (warpStyle == "warpFlag" || warpStyle == "warpWave") arcTopY = arcBotY - 2 * halfH
        }
        if (warpStyle == "warpRise") {
          if (col < 2) arcTopY = -halfH + bendAmount * halfH * 4;
          arcBotY = arcTopY + 2 * halfH
        }
        const rowInterp = (warpedY + halfH) / bounds.height;
        warpedX = arcLeftX + rowInterp * (arcRightX - arcLeftX);
        warpedY = arcTopY + rowInterp * (arcBotY - arcTopY);
        if (warpStyle == "warpWave") {
          if (row == 0) warpedY = -halfH;
          if (row == 3) warpedY = halfH;
          if (row == 1 || row == 2) warpedY = 2 * halfH * (row / 3 - .5) * (1 / 3) + warpedY * (2 / 3)
        }
        if (warpStyle == "warpFisheye") {
          if ((row == 1 || row == 2) && (col == 1 || col == 2)) {
            warpedX = warpedX + 4 * warpedX * bendAmount;
            warpedY = warpedY + 4 * warpedY * bendAmount
          }
        }
        if (warpStyle == "warpInflate") {
          const edgeBlend = 2 / 3;
          if ((row == 1 || row == 2) && (col == 1 || col == 2)) {
            warpedX = warpedX + .5 * warpedX * bendAmount;
            warpedY = warpedY + .5 * warpedY * bendAmount
          } else if (row == 1 || row == 2) warpedX = warpedX + edgeBlend * warpedX * bendAmount;
          else if (col == 1 || col == 2) warpedY = warpedY + edgeBlend * warpedY * bendAmount
        }
        if (warpStyle == "warpSqueeze") {
          const squeezeBlend = 2 / 3;
          if ((row == 1 || row == 2) && (col == 1 || col == 2)) {
            if (bendAmount > 0) warpedX = warpedX - squeezeBlend * warpedX * bendAmount;
            else warpedY = warpedY + squeezeBlend * warpedY * bendAmount
          } else if (row == 1 || row == 2) warpedX = warpedX - squeezeBlend * warpedX * bendAmount;
          else if (col == 1 || col == 2) warpedY = warpedY + squeezeBlend * warpedY * bendAmount
        }
        if (warpStyle == "warpTwist") {
          if ((row == 1 || row == 2) && (col == 1 || col == 2)) {
            const twistAngle = bendAmount * Math.PI / 2;
            const twistScale = 1 + Math.abs(bendAmount) * 2;
            const rotX = warpedX * Math.cos(twistAngle) - warpedY * Math.sin(twistAngle);
            const rotY = warpedX * Math.sin(twistAngle) + warpedY * Math.cos(twistAngle);
            warpedX = rotX * twistScale;
            warpedY = rotY * twistScale
          }
        }
        if (warpStyle == "warpShellLower" || warpStyle == "warpShellUpper") {
          let shellRow = row;
          if (warpStyle == "warpShellUpper") {
            shellRow = 3 - row;
            warpedY = -warpedY
          }
          if (shellRow > 2 || shellRow == 2 && (col == 0 || col == 3)) {
            if (bendAmount > 0) {
              const shellRadius = arcRadius + shellRow / 3 * 2 * halfH;
              warpedX = Math.sin(arcParam) * shellRadius;
              warpedY = -tanSlope * halfW - halfH + Math.cos(arcAngle) * shellRadius;
              if (col == 1 || col == 2) {
                warpedX = col == 1 ? -sinOffset * shellRadius : sinOffset * shellRadius;
                warpedY = -tanSlope * halfW - halfH + cosOffset * shellRadius
              }
            } else {
              if ((col == 1 || col == 2) && shellRow == 3) {
                warpedX = col == 1 ? -sinOffset * arcRadius : sinOffset * arcRadius;
                warpedY = tanSlope * halfW - cosOffset * arcRadius + halfH
              } else if (shellRow == 2) {
                warpedY = halfH - halfH * (2 / 3) * Math.cos(arcParam);
                warpedX = warpedX + halfH * (2 / 3) * Math.sin(arcParam)
              }
            }
          }
          if (warpStyle == "warpShellUpper") {
            shellRow = 3 - shellRow;
            warpedY = -warpedY
          }
        }
        warpedX += halfW;
        warpedY += halfH
      }
      localX = warpedX;
      localY = warpedY;
      coords[coordOff] = localX + bounds.x;
      coords[coordOff + 1] = localY + bounds.y
    }
  }
}

export function applyPerspectiveGrid(coords, vertPersp, horizPersp) {
  const horizWeights = [];
  for (let col = 0; col < 4; col++) horizWeights.push(1 - horizPersp + col / 3 * 2 * horizPersp);
  const vertWeights = [];
  for (let col = 0; col < 4; col++) vertWeights.push(1 - vertPersp + col / 3 * 2 * vertPersp);
  const colMeanX = [0, 0, 0, 0];
  const colMeanY = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 4; col++) {
      const coordOff = 2 * (4 * row + col);
      let px = coords[coordOff];
      let py = coords[coordOff + 1];
      colMeanX[col] += px / 4;
      colMeanY[col] += py / 4
    }
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 4; col++) {
      const horizWeight = horizWeights[col];
      const coordOff = 2 * (4 * row + col);
      let px = coords[coordOff];
      let py = coords[coordOff + 1];
      const meanX = colMeanX[col];
      const meanY = colMeanY[col];
      coords[coordOff] = meanX + horizWeight * (px - meanX);
      coords[coordOff + 1] = meanY + horizWeight * (py - meanY)
    }
  const coordsBefore = coords.slice(0);
  for (let row = 0; row < 4; row++)
    for (let col = 1; col < 3; col++) {
      const coordOff = 2 * (4 * row + col);
      let px = coords[coordOff];
      let py = coords[coordOff + 1];
      const neighborOff = coordOff + (col == 1 ? -2 : 2);
      const neighborX = coords[neighborOff];
      const neighborY = coords[neighborOff + 1];
      coords[coordOff] = px - neighborX;
      coords[coordOff + 1] = py - neighborY
    }
  const topLeftX = coords[0];
  const topLeftY = coords[1];
  const topRightX = coords[8];
  const topRightY = coords[9];
  const botLeftX = coords[16];
  const botLeftY = coords[17];
  const botRightX = coords[24];
  const botRightY = coords[25];
  const topInnerX = coords[6];
  const topInnerY = coords[7];
  const midInnerX = coords[14];
  const midInnerY = coords[15];
  const botInnerX = coords[22];
  const botInnerY = coords[23];
  const cornerInnerX = coords[30];
  const cornerInnerY = coords[31];
  const topEdgeDx = topInnerX - topLeftX;
  const topEdgeDy = topInnerY - topLeftY;
  const midEdgeDx = midInnerX - topRightX;
  const midEdgeDy = midInnerY - topRightY;
  const botEdgeDx = botInnerX - botLeftX;
  const botEdgeDy = botInnerY - botLeftY;
  const cornerEdgeDx = cornerInnerX - botRightX;
  const cornerEdgeDy = cornerInnerY - botRightY;
  const leftEdgeDx = botRightX - topLeftX;
  const leftEdgeDy = botRightY - topLeftY;
  const rightEdgeDx = cornerInnerX - botLeftX;
  const rightEdgeDy = cornerInnerY - botLeftY;
  for (let row = 0; row < 4; row++) {
    const rowOff = 2 * row * 4;
    let shearDx = 0;
    let shearDy = 0;
    const blend = row == 1 ? .33 : .66;
    const blendInv = 1 - blend;
    if (row == 0) {
      shearDx = topEdgeDx;
      shearDy = topEdgeDy
    }
    if (row == 1) {
      shearDx = blendInv * topEdgeDx + blend * -leftEdgeDx;
      shearDy = blendInv * topEdgeDy + blend * -leftEdgeDy
    }
    if (row == 2) {
      shearDx = blendInv * topEdgeDx + blend * -leftEdgeDx;
      shearDy = blendInv * topEdgeDy + blend * -leftEdgeDy
    }
    if (row == 3) {
      shearDx = -leftEdgeDx;
      shearDy = -leftEdgeDy
    }
    coords[rowOff] = coords[rowOff] + shearDx / 2;
    coords[rowOff + 1] = coords[rowOff + 1] + shearDy / 2;
    coords[rowOff + 6] = coords[rowOff + 6] - shearDx / 2;
    coords[rowOff + 7] = coords[rowOff + 7] - shearDy / 2
  }
  for (let row = 0; row < 4; row++)
    for (let col = 1; col < 3; col++) {
      const coordOff = 2 * (4 * row + col);
      let px = coords[coordOff];
      let py = coords[coordOff + 1];
      const neighborOff = coordOff + (col == 1 ? -2 : 2);
      const neighborX = coords[neighborOff];
      const neighborY = coords[neighborOff + 1];
      const rowBlend = 2 * row / 3;
      coords[coordOff] = neighborX + rowBlend * px;
      coords[coordOff + 1] = neighborY + rowBlend * py
    }
  for (let row = 1; row < 3; row++)
    for (let col = 1; col < 3; col++) {
      const coordOff = 2 * (4 * row + col);
      let px = coords[coordOff];
      let py = coords[coordOff + 1];
      const upperOffset = row == 1 ? -8 : -16;
      const lowerOffset = row == 1 ? 16 : 8;
      const upperX = coords[coordOff + upperOffset];
      const upperY = coords[coordOff + upperOffset + 1];
      const lowerX = coords[coordOff + lowerOffset];
      const lowerY = coords[coordOff + lowerOffset + 1];
      const rowBlend = row / 3;
      px = (1 - rowBlend) * upperX + rowBlend * lowerX;
      py = (1 - rowBlend) * upperY + rowBlend * lowerY;
      coords[coordOff] = px;
      coords[coordOff + 1] = py
    }
  lerpCoordPairs(coordsBefore, coords, coords, vertPersp)
}


/** The warp styles a text or layer warp descriptor can name, by i18n key. */
export const WARP_STYLE_LABELS = {
  warpNone: "warp.styles.none",
  warpCustom: "warp.styles.custom",
  warpArc: "warp.styles.arc",
  warpArcLower: "warp.styles.arcLower",
  warpArcUpper: "warp.styles.arcUpper",
  warpArch: "warp.styles.arch",
  warpBulge: "warp.styles.bulge",
  warpShellLower: "warp.styles.shellLower",
  warpShellUpper: "warp.styles.shellUpper",
  warpFlag: "warp.styles.flag",
  warpWave: "warp.styles.wave",
  warpFish: "warp.styles.fish",
  warpRise: "warp.styles.rise",
  warpFisheye: "warp.styles.fishEye",
  warpInflate: "warp.styles.inflate",
  warpSqueeze: "warp.styles.squeeze",
  warpTwist: "warp.styles.twist"
  };

