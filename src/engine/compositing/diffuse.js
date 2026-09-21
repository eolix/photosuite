/**
 * Anisotropic diffusion / oil-paint style filter (structure tensor + flow blur).
 *
 * The WebGL path renders through `LayerSystem`.
 */

import { sampleBilinearFloat } from "./homography.js";
import { gaussianBlurFloat } from "./blur.js";
import { LayerSystem as layerSystem } from "../layer-system.js";

const SOBEL_X = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
const SOBEL_Y = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
const BRISTLE_PHASE_SCALE = Math.sin(11);
const STRUCTURE_TENSOR_BLUR_SCALE = 1 / 2.4;
const FLOW_ENCODE_CENTER = 128;
const FLOW_ENCODE_RANGE = 127;

function lerpScalar(a, b, t) {
  return (1 - t) * a + t * b;
}

function clampByte(value, minVal, maxVal) {
  return Math.max(minVal, Math.min(maxVal, value));
}

export function hash(u, v) {
  const mixed = Math.sin(u * 11.697096 + v * 73.32456) * 12157.47691;
  return mixed - Math.floor(mixed);
}

export function convolveKernel(rgba, centerOff, rowStride, kernel) {
  return (
    rgba[centerOff - rowStride - 4] * kernel[0] +
    rgba[centerOff - rowStride] * kernel[1] +
    rgba[centerOff - rowStride + 4] * kernel[2] +
    rgba[centerOff - 4] * kernel[3] +
    rgba[centerOff] * kernel[4] +
    rgba[centerOff + 4] * kernel[5] +
    rgba[centerOff + rowStride - 4] * kernel[6] +
    rgba[centerOff + rowStride] * kernel[7] +
    rgba[centerOff + rowStride + 4] * kernel[8]
  );
}

function copyTensorPixel(tensor, srcPixelIdx, dstPixelIdx) {
  const srcOff = srcPixelIdx * 4;
  const dstOff = dstPixelIdx * 4;
  tensor[dstOff] = tensor[srcOff];
  tensor[dstOff + 1] = tensor[srcOff + 1];
  tensor[dstOff + 2] = tensor[srcOff + 2];
}

export function padBorder(tensor, width, height) {
  const lastCol = width - 1;
  const lastRow = height - 1;
  copyTensorPixel(tensor, width + 1, 0);
  copyTensorPixel(tensor, 2 * width - 2, width - 1);
  for (let col = 1; col < lastCol; col++) {
    copyTensorPixel(tensor, width + col, col);
  }
  for (let row = 1; row < lastRow; row++) {
    copyTensorPixel(tensor, row * width + 1, row * width);
    copyTensorPixel(tensor, row * width + width - 2, row * width + width - 1);
  }
  for (let col = 1; col < lastCol; col++) {
    copyTensorPixel(tensor, (height - 2) * width + col, (height - 1) * width + col);
  }
  copyTensorPixel(tensor, (lastRow - 2) * width + 1, (lastRow - 1) * width);
  copyTensorPixel(tensor, (lastRow - 1) * width - 2, lastRow * width - 1);
}

export function computeStructureTensor(rgba, width, height, tensorOut) {
  const lastCol = width - 1;
  const lastRow = height - 1;
  const rowStride = width * 4;
  for (let row = 1; row < lastRow; row++) {
    for (let col = 1; col < lastCol; col++) {
      const pixelIdx = row * width + col;
      const rgbaOff = pixelIdx * 4;
      const gradX0 = convolveKernel(rgba, rgbaOff, rowStride, SOBEL_X);
      const gradY0 = convolveKernel(rgba, rgbaOff, rowStride, SOBEL_Y);
      const gradX1 = convolveKernel(rgba, rgbaOff + 1, rowStride, SOBEL_X);
      const gradY1 = convolveKernel(rgba, rgbaOff + 1, rowStride, SOBEL_Y);
      const gradX2 = convolveKernel(rgba, rgbaOff + 2, rowStride, SOBEL_X);
      const gradY2 = convolveKernel(rgba, rgbaOff + 2, rowStride, SOBEL_Y);
      tensorOut[rgbaOff] = gradX0 * gradX0 + gradX1 * gradX1 + gradX2 * gradX2;
      tensorOut[rgbaOff + 1] = gradX0 * gradY0 + gradX1 * gradY1 + gradX2 * gradY2;
      tensorOut[rgbaOff + 2] = gradY0 * gradY0 + gradY1 * gradY1 + gradY2 * gradY2;
    }
  }
  padBorder(tensorOut, width, height);
}

export function bristleValue(x, y, invScale, mix) {
  const scaledX = (x + 613) * invScale;
  const scaledY = (y + 117) * invScale;
  const cellX = ~~scaledX;
  const cellY = ~~scaledY;
  const fracX = scaledX - cellX;
  const fracY = scaledY - cellY;
  const cosX0 = Math.cos(cellX) * BRISTLE_PHASE_SCALE;
  const cosX1 = Math.cos(cellX + 1) * BRISTLE_PHASE_SCALE;
  const cosY0 = Math.cos(cellY) * BRISTLE_PHASE_SCALE;
  const cosY1 = Math.cos(cellY + 1) * BRISTLE_PHASE_SCALE;
  const hash00 = hash(cosX0, cosY0);
  const hash10 = hash(cosX1, cosY0);
  const hash01 = hash(cosX0, cosY1);
  const hash11 = hash(cosX1, cosY1);
  const lerpX0 = lerpScalar(hash00, hash10, fracX);
  const lerpX1 = lerpScalar(hash01, hash11, fracX);
  let cellValue = lerpScalar(lerpX0, lerpX1, fracY);
  cellValue = cellValue < 0.5 ? 0 : 1;
  const noise = cellValue + mix * hash(Math.cos(scaledX) * BRISTLE_PHASE_SCALE, Math.cos(scaledY) * BRISTLE_PHASE_SCALE);
  return noise * (1 / 3);
}

export function lightDotProduct(col, row, rgba, width, height, lightDirection) {
  const alphaLeft = rgba[(row * width + Math.max(0, col - 1)) * 4 + 3];
  const alphaRight = rgba[(row * width + Math.min(width - 1, col + 1)) * 4 + 3];
  const alphaUp = rgba[(Math.max(0, row - 1) * width + col) * 4 + 3];
  const alphaDown = rgba[(Math.min(height - 1, row + 1) * width + col) * 4 + 3];
  const bumpScaleX = 0.7;
  const bumpScaleY = 0.7;
  const gradX = (alphaRight - alphaLeft) * (1 / 255);
  const gradY = (alphaDown - alphaUp) * (1 / 255);
  const normalX = -gradX * bumpScaleY;
  const normalY = -bumpScaleX * gradY;
  const normalZ = bumpScaleX * bumpScaleY;
  const normalLen = Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ);
  const invLen = 1 / normalLen;
  const nx = normalX * invLen;
  const ny = normalY * invLen;
  const nz = normalZ * invLen;
  return lightDirection[0] * nx + lightDirection[1] * ny + lightDirection[2] * nz;
}

function blurStructureTensorChannels(structureTensor, rect, pixelCount, blurSigma) {
  const tensorBuffer = new ArrayBuffer(pixelCount * 4);
  const tensorT00 = new Float32Array(tensorBuffer);
  const tensorT01 = new Float32Array(pixelCount);
  const tensorT11 = new Float32Array(pixelCount);
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    const tensorOff = pixelIdx * 4;
    tensorT00[pixelIdx] = structureTensor[tensorOff];
    tensorT01[pixelIdx] = structureTensor[tensorOff + 1];
    tensorT11[pixelIdx] = structureTensor[tensorOff + 2];
  }
  const channelSigma = blurSigma * STRUCTURE_TENSOR_BLUR_SCALE;
  gaussianBlurFloat(tensorT00, tensorT00, rect, channelSigma, 2);
  gaussianBlurFloat(tensorT01, tensorT01, rect, channelSigma, 2);
  gaussianBlurFloat(tensorT11, tensorT11, rect, channelSigma, 2);
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    const tensorOff = pixelIdx * 4;
    structureTensor[tensorOff] = tensorT00[pixelIdx];
    structureTensor[tensorOff + 1] = tensorT01[pixelIdx];
    structureTensor[tensorOff + 2] = tensorT11[pixelIdx];
  }
  return tensorBuffer;
}

function buildFlowFieldFromTensor(structureTensor, pixelCount, tensorBuffer) {
  const flowField = new Uint8Array(tensorBuffer);
  for (let pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    const tensorOff = pixelIdx * 4;
    const rgbaOff = pixelIdx * 4;
    const tensor00 = structureTensor[tensorOff];
    const tensor01 = structureTensor[tensorOff + 1];
    const tensor11 = structureTensor[tensorOff + 2];
    const tensorDisc = Math.sqrt((tensor00 - tensor11) * (tensor00 - tensor11) + 4 * tensor01 * tensor01);
    const lambdaMin = (tensor00 + tensor11 - tensorDisc) * 0.5;
    let flowX = lambdaMin - tensor11;
    let flowY = tensor01;
    const flowLenSq = flowX * flowX + flowY * flowY;
    if (flowLenSq != 0) {
      const invLen = 1 / Math.sqrt(flowLenSq);
      flowX *= invLen;
      flowY *= invLen;
    }
    flowField[rgbaOff] = FLOW_ENCODE_CENTER + FLOW_ENCODE_RANGE * flowX;
    flowField[rgbaOff + 1] = FLOW_ENCODE_CENTER + FLOW_ENCODE_RANGE * flowY;
  }
  return flowField;
}

export function applyBristle(bristleInvScale, bristleMix, rgba, width, height) {
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const bristleAlpha = bristleValue(col + 0.5, row + 0.5, bristleInvScale, bristleMix);
      rgba[(row * width + col) * 4 + 3] = clampByte(bristleAlpha * 255, 0, 255);
    }
  }
}

export function applySpecular(width, height, destRgba, lightDirection, specularAmount) {
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const rgbaOff = (row * width + col) << 2;
      const shade = 1 + lightDotProduct(col, row, destRgba, width, height, lightDirection) * specularAmount;
      destRgba[rgbaOff] = Math.max(0, Math.min(255, destRgba[rgbaOff] * shade));
      destRgba[rgbaOff + 1] = Math.max(0, Math.min(255, destRgba[rgbaOff + 1] * shade));
      destRgba[rgbaOff + 2] = Math.max(0, Math.min(255, destRgba[rgbaOff + 2] * shade));
    }
  }
}

export function anisotropicBlur(sourceRgba, destRgba, flowField, width, height, blurRadius) {
  const maxSteps = Math.ceil(2 * blurRadius);
  const gaussCoeff = -1 / (2 * blurRadius * blurRadius);
  const weightLut = [];
  const stepLen = 1;
  for (let lutIdx = 0; lutIdx < maxSteps + 20; lutIdx++) {
    weightLut[lutIdx] = Math.exp(lutIdx * lutIdx * gaussCoeff);
  }
  const sampleScratch = [0, 0, 0, 0];
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const pixelIdx = row * width + col;
      const rgbaOff = pixelIdx * 4;
      let weightSum = 1;
      let accumR = sourceRgba[rgbaOff];
      let accumG = sourceRgba[rgbaOff + 1];
      let accumB = sourceRgba[rgbaOff + 2];
      let accumA = sourceRgba[rgbaOff + 3];
      const flowX = (flowField[rgbaOff] - FLOW_ENCODE_CENTER) * (1 / FLOW_ENCODE_RANGE);
      const flowY = (flowField[rgbaOff + 1] - FLOW_ENCODE_CENTER) * (1 / FLOW_ENCODE_RANGE);
      let dirX = flowX;
      let dirY = flowY;
      const startCol = col == 0 ? 0.51 : 0.49;
      const startRow = row == 0 ? 0.51 : 0.49;
      for (let direction = 0; direction < 2; direction++) {
        let walkCol = col + startCol;
        let walkRow = row + startRow;
        let dist = 0;
        while (dist < maxSteps) {
          if (walkCol < 0.5 || width - 0.5 < walkCol || walkRow < 0.5 || height - 0.5 < walkRow) {
            break;
          }
          const floorCol = ~~walkCol;
          const floorRow = ~~walkRow;
          const flowOff = (floorRow * width + floorCol) * 4;
          let stepX = (flowField[flowOff] - FLOW_ENCODE_CENTER) * (1 / FLOW_ENCODE_RANGE);
          let stepY = (flowField[flowOff + 1] - FLOW_ENCODE_CENTER) * (1 / FLOW_ENCODE_RANGE);
          if (stepX * dirX + stepY * dirY < 0) {
            stepX = -stepX;
            stepY = -stepY;
          }
          dirX = stepX;
          dirY = stepY;
          walkCol += stepLen * stepX;
          walkRow += stepLen * stepY;
          if (walkCol < 0.5 || width - 0.5 < walkCol || walkRow < 0.5 || height - 0.5 < walkRow) {
            break;
          }
          dist += stepLen;
          const kernelWeight = weightLut[~~dist];
          sampleBilinearFloat(walkCol, walkRow, sourceRgba, width, height, sampleScratch);
          accumR += sampleScratch[0] * kernelWeight;
          accumG += sampleScratch[1] * kernelWeight;
          accumB += sampleScratch[2] * kernelWeight;
          accumA += sampleScratch[3] * kernelWeight;
          weightSum += kernelWeight;
        }
        dirX = -flowX;
        dirY = -flowY;
      }
      const invWeight = 1 / weightSum;
      destRgba[rgbaOff] = ~~(0.5 + accumR * invWeight);
      destRgba[rgbaOff + 1] = ~~(0.5 + accumG * invWeight);
      destRgba[rgbaOff + 2] = ~~(0.5 + accumB * invWeight);
      destRgba[rgbaOff + 3] = ~~(0.5 + accumA * invWeight);
    }
  }
}

function applyCpuDiffusePath(workRgba, destRgba, flowField, width, height, blurRadius, enableBristleSpecular, bristleScale, bristleMix, lightDirection, specularAmount) {
  if (enableBristleSpecular) {
    applyBristle(1 / bristleScale, bristleMix, workRgba, width, height);
  }
  anisotropicBlur(workRgba, destRgba, flowField, width, height, blurRadius);
  if (enableBristleSpecular) {
    applySpecular(width, height, destRgba, lightDirection, specularAmount);
  }
}

function applyWebglDiffusePath(workRgba, destRgba, flowField, width, height, rect, blurRadius, enableBristleSpecular, bristleScale, bristleMix, lightDirection, specularAmount) {
  const invSize = new Float32Array([1 / width, 1 / height]);
  const colorTex = layerSystem.getPooledTexture(0, width, height);
  colorTex.set(workRgba);
  const flowTex = layerSystem.getPooledTexture(1, width, height);
  flowTex.set(flowField);
  layerSystem.bindRenderTarget(colorTex, rect);
  if (enableBristleSpecular) {
    colorTex.saveBackup(rect);
    layerSystem.filter.render({
      type: layerSystem.filter.BRISTLE,
      invTexelSize: invSize,
      noiseScale: 1 / bristleScale,
      bristleStrength: bristleMix,
    }, colorTex.backupTexture);
  }
  colorTex.saveBackup(rect);
  layerSystem.filter.render({
    type: layerSystem.filter.ANISOTROPIC,
    tangentMapTexture: flowTex.glTexture,
    invTexelSize: invSize,
    blurSigma: blurRadius,
    blurExponent: 2,
  }, colorTex.backupTexture);
  if (enableBristleSpecular) {
    colorTex.saveBackup(rect);
    layerSystem.filter.render({
      type: layerSystem.filter.SPECULAR,
      invTexelSize: invSize,
      lightDirection: new Float32Array(lightDirection),
      shine: specularAmount,
    }, colorTex.backupTexture);
  }
  colorTex.get(destRgba);
}

function copySourceAlpha(sourceRgba, destRgba, pixelCount) {
  const alphaEnd = pixelCount * 4;
  for (let alphaOff = 3; alphaOff < alphaEnd; alphaOff += 4) {
    destRgba[alphaOff] = sourceRgba[alphaOff];
  }
}

export function filter(sourceRgba, rect, destRgba, filterParams) {
  const width = rect.width;
  const height = rect.height;
  const pixelCount = width * height;
  const diffusionScale = filterParams[0];
  const anisotropyStrength = filterParams[1];
  const bristleScale = filterParams[2];
  const bristleContrast = filterParams[3];
  const enableBristleSpecular = filterParams[4];
  const specularAmount = filterParams[5];
  const lightDirection = filterParams[6];
  const structureTensor = new Float32Array(width * height * 4);
  computeStructureTensor(sourceRgba, width, height, structureTensor);
  const blurSigma = Math.ceil(diffusionScale * Math.sqrt(-2 * Math.log(0.1)));
  const tensorBuffer = blurStructureTensorChannels(structureTensor, rect, pixelCount, blurSigma);
  const flowField = buildFlowFieldFromTensor(structureTensor, pixelCount, tensorBuffer);
  const blurRadius = 1.3 * anisotropyStrength + 2;
  const bristleMix = bristleContrast * (2 / 10);
  const workRgba = sourceRgba.slice();
  if (layerSystem.webglEnabled) {
    applyWebglDiffusePath(
      workRgba,
      destRgba,
      flowField,
      width,
      height,
      rect,
      blurRadius,
      enableBristleSpecular,
      bristleScale,
      bristleMix,
      lightDirection,
      specularAmount,
    );
  } else {
    applyCpuDiffusePath(
      workRgba,
      destRgba,
      flowField,
      width,
      height,
      blurRadius,
      enableBristleSpecular,
      bristleScale,
      bristleMix,
      lightDirection,
      specularAmount,
    );
  }
  copySourceAlpha(sourceRgba, destRgba, pixelCount);
}

