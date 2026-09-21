/**
 * Euclidean distance transforms and stroke masks for selection / layer-style effects.
 */

const EMPTY_OFFSET_SENTINEL = 16383;
const EMPTY_DISTANCE = 1e9;

export function positionHash(index) {
  index = index ^ 61 ^ index >> 16;
  index = index + (index << 3);
  index = index ^ index >> 4;
  index = index * 668265261;
  index = index ^ index >> 15;
  return index & 255;
}

export function edtEdgeSubpixelCorrection(normX, normY, edgeAlpha) {
  return (0.5 - edgeAlpha) * normX;
}

function maskIsBinary(maskChannel) {
  for (let idx = 0; idx < maskChannel.length; idx++) {
    if (maskChannel[idx] != 0 && maskChannel[idx] != 255) {
      return false;
    }
  }
  return true;
}

function seedEmptyOffsets(maskChannel, offsets, pixelCount) {
  for (let idx = 0; idx < pixelCount; idx++) {
    if (maskChannel[idx] == 0) {
      offsets[idx * 2] = EMPTY_OFFSET_SENTINEL;
      offsets[idx * 2 + 1] = EMPTY_OFFSET_SENTINEL;
    }
  }
}

export function relaxNearestOffsetBinary(offsets, width, offsetIdx, colStep) {
  const neighborIdx = (offsetIdx >>> 1) + colStep << 1;
  const offsetX = offsets[offsetIdx];
  const offsetY = offsets[offsetIdx + 1];
  const candidateX = offsets[neighborIdx] + colStep;
  const candidateY = offsets[neighborIdx + 1];
  const candidateDistSq = candidateX * candidateX + candidateY * candidateY;
  const currentDistSq = offsetX * offsetX + offsetY * offsetY;
  if (candidateY != EMPTY_OFFSET_SENTINEL && (offsetX == EMPTY_OFFSET_SENTINEL || candidateDistSq < currentDistSq)) {
    offsets[offsetIdx] = candidateX;
    offsets[offsetIdx + 1] = candidateY;
  }
}

export function initNearestOffsetBinary(offsets, width, offsetIdx, rowStep) {
  const neighborIdx = (offsetIdx >>> 1) + rowStep * width << 1;
  const offsetX = offsets[offsetIdx];
  const offsetY = offsets[offsetIdx + 1];
  const candidateX = offsets[neighborIdx];
  const candidateY = offsets[neighborIdx + 1] + rowStep;
  const candidateDistSq = candidateX * candidateX + candidateY * candidateY;
  const currentDistSq = offsetX * offsetX + offsetY * offsetY;
  if (candidateX != EMPTY_OFFSET_SENTINEL && (offsetX == EMPTY_OFFSET_SENTINEL || candidateDistSq < currentDistSq)) {
    offsets[offsetIdx] = candidateX;
    offsets[offsetIdx + 1] = candidateY;
  }
}

function antialiasedOffsetCost(offsets, maskChannel, width, offsetIdx, offsetX, offsetY) {
  return (
    Math.sqrt(offsetX * offsetX + offsetY * offsetY) +
    (0.5 - maskChannel[(offsetIdx >>> 1) + offsetY * width + offsetX] * (1 / 255))
  );
}

export function relaxNearestOffset(offsets, maskChannel, width, offsetIdx, colStep) {
  const neighborIdx = (offsetIdx >>> 1) + colStep << 1;
  const offsetX = offsets[offsetIdx];
  const offsetY = offsets[offsetIdx + 1];
  const candidateX = offsets[neighborIdx] + colStep;
  const candidateY = offsets[neighborIdx + 1];
  if (
    candidateY != EMPTY_OFFSET_SENTINEL &&
    (offsetX == EMPTY_OFFSET_SENTINEL ||
      antialiasedOffsetCost(offsets, maskChannel, width, offsetIdx, candidateX, candidateY) <
        antialiasedOffsetCost(offsets, maskChannel, width, offsetIdx, offsetX, offsetY))
  ) {
    offsets[offsetIdx] = candidateX;
    offsets[offsetIdx + 1] = candidateY;
  }
}

export function initNearestOffset(offsets, maskChannel, width, offsetIdx, rowStep) {
  const neighborIdx = (offsetIdx >>> 1) + rowStep * width << 1;
  const offsetX = offsets[offsetIdx];
  const offsetY = offsets[offsetIdx + 1];
  const candidateX = offsets[neighborIdx];
  const candidateY = offsets[neighborIdx + 1] + rowStep;
  if (
    candidateX != EMPTY_OFFSET_SENTINEL &&
    (offsetX == EMPTY_OFFSET_SENTINEL ||
      antialiasedOffsetCost(offsets, maskChannel, width, offsetIdx, candidateX, candidateY) <
        antialiasedOffsetCost(offsets, maskChannel, width, offsetIdx, offsetX, offsetY))
  ) {
    offsets[offsetIdx] = candidateX;
    offsets[offsetIdx + 1] = candidateY;
  }
}

export function propagateNearestOffsetsBinary(maskChannel, offsets, width, height) {
  const pixelCount = width * height;
  seedEmptyOffsets(maskChannel, offsets, pixelCount);
  for (let row = 1; row <= height - 1; row++) {
    const rowBase = row * width;
    for (let col = 0; col <= width - 1; col++) {
      initNearestOffsetBinary(offsets, width, rowBase + col << 1, -1);
    }
    for (let col = 1; col <= width - 1; col++) {
      relaxNearestOffsetBinary(offsets, width, rowBase + col << 1, -1);
    }
    for (let col = width - 2; col >= 0; col--) {
      relaxNearestOffsetBinary(offsets, width, rowBase + col << 1, 1);
    }
  }
  for (let row = height - 2; row >= 0; row--) {
    const rowBase = row * width;
    for (let col = 0; col <= width - 1; col++) {
      initNearestOffsetBinary(offsets, width, rowBase + col << 1, 1);
    }
    for (let col = 1; col <= width - 1; col++) {
      relaxNearestOffsetBinary(offsets, width, rowBase + col << 1, -1);
    }
    for (let col = width - 2; col >= 0; col--) {
      relaxNearestOffsetBinary(offsets, width, rowBase + col << 1, 1);
    }
  }
}

export function propagateNearestOffsetsAntialiased(maskChannel, offsets, width, height) {
  const pixelCount = width * height;
  seedEmptyOffsets(maskChannel, offsets, pixelCount);
  for (let row = 1; row <= height - 1; row++) {
    const rowBase = row * width;
    for (let col = 0; col <= width - 1; col++) {
      initNearestOffset(offsets, maskChannel, width, rowBase + col << 1, -1);
    }
    for (let col = 1; col <= width - 1; col++) {
      relaxNearestOffset(offsets, maskChannel, width, rowBase + col << 1, -1);
    }
    for (let col = width - 2; col >= 0; col--) {
      relaxNearestOffset(offsets, maskChannel, width, rowBase + col << 1, 1);
    }
  }
  for (let row = height - 2; row >= 0; row--) {
    const rowBase = row * width;
    for (let col = 0; col <= width - 1; col++) {
      initNearestOffset(offsets, maskChannel, width, rowBase + col << 1, 1);
    }
    for (let col = 1; col <= width - 1; col++) {
      relaxNearestOffset(offsets, maskChannel, width, rowBase + col << 1, -1);
    }
    for (let col = width - 2; col >= 0; col--) {
      relaxNearestOffset(offsets, maskChannel, width, rowBase + col << 1, 1);
    }
  }
}

export function computeNearestOffsets(maskChannel, width, height, binaryOnly) {
  if (binaryOnly == null) {
    binaryOnly = maskIsBinary(maskChannel);
  }
  const offsets = new Int16Array(width * height * 2);
  if (binaryOnly) {
    propagateNearestOffsetsBinary(maskChannel, offsets, width, height);
  } else {
    propagateNearestOffsetsAntialiased(maskChannel, offsets, width, height);
  }
  return offsets;
}

export function computeDistanceField(maskChannel, distanceOut, width, height) {
  let anyOpaque = 0;
  const pixelCount = width * height;
  for (let idx = 0; idx < pixelCount; idx++) {
    anyOpaque |= maskChannel[idx];
  }
  if (anyOpaque == 0) {
    distanceOut.fill(EMPTY_DISTANCE);
    return;
  }
  const nearestOffsets = computeNearestOffsets(maskChannel, width, height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col;
      const offsetX = nearestOffsets[idx * 2];
      const offsetY = nearestOffsets[idx * 2 + 1];
      const nearestIdx = (row + offsetY) * width + col + offsetX;
      if (offsetX == 0 && offsetY == 0) {
        distanceOut[idx] = 0;
        continue;
      }
      const dist = Math.sqrt(offsetX * offsetX + offsetY * offsetY);
      const edgeAlpha = maskChannel[nearestIdx] * (1 / 255);
      const invDist = 1 / dist;
      let absOffX = Math.abs(offsetX) * invDist;
      let absOffY = Math.abs(offsetY) * invDist;
      if (absOffY > absOffX) {
        const swap = absOffY;
        absOffY = absOffX;
        absOffX = swap;
      }
      distanceOut[idx] = dist + edtEdgeSubpixelCorrection(absOffX, absOffY, edgeAlpha);
    }
  }
}

export function applyStrokeMask(destChannel, destRect, distanceField, fieldRect, strokeWidth) {
  const clip = destRect.intersect(fieldRect);
  const clipW = clip.width;
  const clipH = clip.height;
  strokeWidth += 0.5;
  const destOffsetX = clip.x - destRect.x;
  const destOffsetY = clip.y - destRect.y;
  const destStride = destRect.width;
  const fieldOffsetX = clip.x - fieldRect.x;
  const fieldOffsetY = clip.y - fieldRect.y;
  const fieldStride = fieldRect.width;
  for (let row = 0; row < clipH; row++) {
    const fieldRowBase = (row + fieldOffsetY) * fieldStride + fieldOffsetX;
    const destRowBase = (row + destOffsetY) * destStride + destOffsetX;
    for (let col = 0; col < clipW; col++) {
      const alpha = Math.max(0, Math.min(1, strokeWidth - distanceField[fieldRowBase + col]));
      destChannel[destRowBase + col] = Math.round(alpha * 255);
    }
  }
}

export function stroke(maskChannel, destChannel, destRect, strokeWidth) {
  const width = destRect.width;
  const height = destRect.height;
  const distanceField = new Float64Array(width * height);
  computeDistanceField(maskChannel, distanceField, width, height);
  applyStrokeMask(destChannel, destRect, distanceField, destRect, strokeWidth);
}

export function computeSurfaceNormals(heightField, width, height, normalsOut) {
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col;
      const center = heightField[idx];
      let gradX = 0;
      let gradY = 0;
      if (col == 0 || row == 0) {
        gradX = heightField[idx + 1] - center;
        gradY = heightField[idx + width] - center;
      } else if (col == width - 1 || row == height - 1) {
        gradX = center - heightField[idx - 1];
        gradY = center - heightField[idx - width];
      } else {
        gradX = heightField[idx + 1] - heightField[idx - 1];
        gradY = heightField[idx + width] - heightField[idx - width];
      }
      if (gradX != 0 || gradY != 0) {
        const invLen = 1 / Math.sqrt(gradX * gradX + gradY * gradY);
        gradX *= invLen;
        gradY *= invLen;
      }
      normalsOut[idx + idx] = gradX;
      normalsOut[idx + idx + 1] = gradY;
    }
  }
}

export function computeDistanceFieldFast(maskChannel, distanceOut, width, height, threshold) {
  const pixelCount = width * height;
  const sentinel = (width + height + 1) * 1.01;
  for (let idx = 0; idx < pixelCount; idx++) {
    if (maskChannel[idx] <= threshold) {
      distanceOut[idx] = sentinel;
    }
  }
  for (let col = 1; col < width; col++) {
    distanceOut[col] = Math.min(distanceOut[col], distanceOut[col - 1]);
  }
  for (let row = 1; row < height; row++) {
    let idx = row * width;
    distanceOut[idx] = Math.min(distanceOut[idx], Math.min(distanceOut[idx - width] + 1, distanceOut[idx - width + 1] + Math.SQRT2));
    for (let col = 1; col < width - 1; col++) {
      const cur = distanceOut[++idx];
      const best = Math.min(
        distanceOut[idx - 1] + 1,
        Math.min(distanceOut[idx - width - 1] + Math.SQRT2, Math.min(distanceOut[idx - width] + 1, distanceOut[idx - width + 1] + Math.SQRT2)),
      );
      if (best < cur) {
        distanceOut[idx] = best;
      }
    }
    idx++;
    distanceOut[idx] = Math.min(
      distanceOut[idx],
      Math.min(distanceOut[idx - 1] + 1, Math.min(distanceOut[idx - width - 1] + Math.SQRT2, distanceOut[idx - width] + 1)),
    );
  }
  for (let col = width - 2; col >= 0; col--) {
    distanceOut[col + pixelCount - width] = Math.min(distanceOut[col + pixelCount - width], distanceOut[col + pixelCount - width + 1]);
  }
  for (let row = height - 2; row >= 0; row--) {
    let idx = row * width + width - 1;
    distanceOut[idx] = Math.min(distanceOut[idx], Math.min(distanceOut[idx + width] + 1, distanceOut[idx + width - 1] + Math.SQRT2));
    for (let col = width - 2; col >= 1; col--) {
      const cur = distanceOut[--idx];
      const best = Math.min(
        distanceOut[idx + 1] + 1,
        Math.min(distanceOut[idx + width - 1] + Math.SQRT2, Math.min(distanceOut[idx + width] + 1, distanceOut[idx + width + 1] + Math.SQRT2)),
      );
      if (best < cur) {
        distanceOut[idx] = best;
      }
    }
    idx--;
    distanceOut[idx] = Math.min(
      distanceOut[idx],
      Math.min(distanceOut[idx + 1] + 1, Math.min(distanceOut[idx + width] + 1, distanceOut[idx + width + 1] + Math.SQRT2)),
    );
  }
}

export function computeColumnDistanceTransform(maskChannel, columnDist, width, height, threshold) {
  const scratch = new Int32Array(height);
  for (let col = 0; col < width; col++) {
    let runLen = width + height;
    for (let row = height - 1; row >= 0; row--) {
      if (maskChannel[row * width + col] > threshold) {
        runLen = 0;
      } else {
        runLen++;
      }
      scratch[row] = runLen;
    }
    runLen = width + height;
    for (let row = 0; row < height; row++) {
      if (maskChannel[row * width + col] > threshold) {
        runLen = 0;
      } else {
        runLen++;
      }
      columnDist[row * width + col] = runLen < scratch[row] ? -runLen : scratch[row];
    }
  }
}

export function computeParabolicDistanceEnvelope(columnDist, offsetsOut, width, height) {
  const maxDist = (width + height) * (width + height);
  const envelopeZ = new Float64Array(width);
  const envelopeV = new Uint16Array(width);
  for (let row = 0; row < height; row++) {
    const rowBase = row * width;
    let stackTop = 0;
    envelopeV[0] = 0;
    envelopeZ[0] = -maxDist;
    envelopeZ[1] = +maxDist;
    for (let col = 1; col < width; col++) {
      const parabola = columnDist[col + rowBase] * columnDist[col + rowBase] + col * col;
      let intersection =
        (parabola -
          (columnDist[envelopeV[stackTop] + rowBase] * columnDist[envelopeV[stackTop] + rowBase] +
            envelopeV[stackTop] * envelopeV[stackTop])) /
        (2 * col - 2 * envelopeV[stackTop]);
      while (intersection <= envelopeZ[stackTop]) {
        stackTop--;
        intersection =
          (parabola -
            (columnDist[envelopeV[stackTop] + rowBase] * columnDist[envelopeV[stackTop] + rowBase] +
              envelopeV[stackTop] * envelopeV[stackTop])) /
          (2 * col - 2 * envelopeV[stackTop]);
      }
      stackTop++;
      envelopeV[stackTop] = col;
      envelopeZ[stackTop] = intersection;
      envelopeZ[stackTop + 1] = maxDist;
    }
    stackTop = 0;
    for (let col = 0; col < width; col++) {
      while (envelopeZ[stackTop + 1] < col) {
        stackTop++;
      }
      const offsetX = envelopeV[stackTop] - col;
      const offsetY = columnDist[envelopeV[stackTop] + rowBase];
      const outIdx = row * width + col << 1;
      offsetsOut[outIdx] = offsetX;
      offsetsOut[outIdx + 1] = offsetY;
    }
  }
}

export function computeEuclideanDistance(maskChannel, offsetsOut, width, height, threshold) {
  const columnDist = new Int32Array(width * height);
  computeColumnDistanceTransform(maskChannel, columnDist, width, height, threshold);
  computeParabolicDistanceEnvelope(columnDist, offsetsOut, width, height);
}

export function applyStrokeNoise(channel, noiseAmount, scaleWithOpacity) {
  if (scaleWithOpacity) {
    for (let idx = 0; idx < channel.length; idx++) {
      const value = channel[idx];
      if (value > 0) {
        channel[idx] = Math.max(0, Math.min(255, value + noiseAmount * 2 * (positionHash(idx) - 128)));
      }
    }
  } else {
    for (let idx = 0; idx < channel.length; idx++) {
      const value = channel[idx];
      if (value > 0) {
        channel[idx] = Math.max(0, Math.min(255, value + Math.min(value * 3, noiseAmount * 2 * (positionHash(idx) - 128))));
      }
    }
  }
}

