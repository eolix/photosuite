/**
 * Liquify brush dithering: radial falloff ramps, pattern displacement modes,
 * and Laplacian-style threshold smoothing on vector fields.
 */

const RAMP_STEPS = 1000;
const RAMP_STEP = 0.001;
const MODE_FORWARD = 0;
const MODE_SHRINK = 1;
const MODE_TWIRL = 3;
const MODE_PUSH_IN = 4;
const MODE_PUSH_OUT = 5;
const MODE_CROSS = 6;

/**
 * Smooth a vector field at selected cells by subtracting a local Laplacian
 * of neighboring samples (horizontal and vertical), scaled by strength.
 */
function applyThreshold(gridWidth, gridHeight, gradient, indices, strength) {
  const invWidth = 1 / gridWidth;
  const count = indices.length;
  for (let k = 0; k < count; k++) {
    const cell = indices[k];
    const gi = cell << 1;
    const row = ~~(cell * invWidth);
    const col = cell - gridWidth * row;
    const gx = gradient[gi];
    const gy = gradient[gi + 1];
    let adjX = 0;
    let adjY = 0;
    if (col != 0 && col != gridWidth - 1) {
      const leftIdx = cell - 1 << 1;
      const rightIdx = cell + 1 << 1;
      const deltaX = gx - (gradient[leftIdx] + gradient[rightIdx]) * 0.5;
      const deltaY = gy - (gradient[leftIdx + 1] + gradient[rightIdx + 1]) * 0.5;
      adjX -= deltaX * strength;
      adjY -= deltaY * strength;
    }
    if (row != 0 && row != gridHeight - 1) {
      const upIdx = cell - gridWidth << 1;
      const downIdx = cell + gridWidth << 1;
      const deltaX = gx - (gradient[upIdx] + gradient[downIdx]) * 0.5;
      const deltaY = gy - (gradient[upIdx + 1] + gradient[downIdx + 1]) * 0.5;
      adjX -= deltaX * strength;
      adjY -= deltaY * strength;
    }
    gradient[gi] = gx + adjX;
    gradient[gi + 1] = gy + adjY;
  }
}

function buildErrorDiffusionRamp(mix, scale) {
  const ramp = [];
  for (let i = 0; i <= RAMP_STEPS; i++) {
    const t = i * RAMP_STEP;
    const sqrtT = Math.sqrt(t);
    const falloff = Math.exp(-4 * sqrtT);
    const curve = 0.96 * (1 - sqrtT * sqrtT);
    ramp[i] = scale * ((1 - mix) * falloff + mix * curve);
  }
  return ramp;
}

function patternOffsetForMode(mode, rampVal, nx, ny, dirX, dirY) {
  if (mode == MODE_FORWARD) {
    return { offsetX: dirX * rampVal, offsetY: dirY * rampVal };
  }
  if (mode == MODE_TWIRL) {
    return { offsetX: rampVal * ny, offsetY: -rampVal * nx };
  }
  if (mode == MODE_PUSH_IN) {
    return { offsetX: rampVal * nx, offsetY: rampVal * ny };
  }
  if (mode == MODE_PUSH_OUT) {
    return { offsetX: -rampVal * nx, offsetY: -rampVal * ny };
  }
  if (mode == MODE_CROSS) {
    return { offsetX: dirY * rampVal, offsetY: -dirX * rampVal };
  }
  return { offsetX: 0, offsetY: 0 };
}

function sampleEdgeBasis(field, fi, rowStride, width, height, col, row, offsetX, offsetY) {
  const curX = field[fi];
  const curY = field[fi + 1];
  let edgeX;
  let edgeY;
  let edgeXAlt;
  let edgeYAlt;
  if (col == 0 || (col != width - 1 && offsetX < 0)) {
    edgeX = 1 + field[fi + 2] - curX;
    edgeY = field[fi + 3] - curY;
  } else {
    edgeX = curX - field[fi - 2] + 1;
    edgeY = curY - field[fi - 1];
  }
  if (row == 0 || (row != height - 1 && offsetY < 0)) {
    edgeXAlt = field[fi + rowStride] - curX;
    edgeYAlt = 1 + field[fi + rowStride + 1] - curY;
  } else {
    edgeXAlt = curX - field[fi - rowStride];
    edgeYAlt = curY - field[fi - rowStride + 1] + 1;
  }
  return { curX, curY, edgeX, edgeY, edgeXAlt, edgeYAlt };
}

/**
 * Apply a brush-shaped dither pattern into a packed XY vector field.
 * Writes touched cell indices into {@code outIndices} in order (grows Array length).
 */
function runPatternDithering(
  patterns,
  field,
  width,
  height,
  mode,
  centerX,
  centerY,
  radius,
  mix,
  strength,
  dirX,
  dirY,
  outIndices,
  invert,
) {
  const minX = Math.max(0, Math.floor(centerX - radius - 1));
  const maxX = Math.min(width, Math.ceil(centerX + radius + 1));
  const minY = Math.max(0, Math.floor(centerY - radius - 1));
  const maxY = Math.min(height, Math.ceil(centerY + radius + 1));
  const rowStride = 2 * width;
  const invRadius = 1 / radius;
  let outCount = 0;
  if (invert && (mode == MODE_TWIRL || mode == MODE_CROSS)) {
    strength = -strength;
  }
  const ramp = patterns.applyErrorDiffusion(mix, strength);
  for (let row = minY; row < maxY; row++) {
    for (let col = minX; col < maxX; col++) {
      const cell = row * width + col;
      const fi = cell << 1;
      const nx = (centerX - col) * invRadius;
      const ny = (centerY - row) * invRadius;
      const distSq = nx * nx + ny * ny;
      if (distSq >= 1) {
        continue;
      }
      outIndices[outCount] = cell;
      const rampVal = ramp[~~(distSq * RAMP_STEPS)];
      if (mode == MODE_SHRINK) {
        field[fi] = field[fi] * (1 - rampVal * 0.05);
        field[fi + 1] = field[fi + 1] * (1 - rampVal * 0.05);
      } else {
        const { offsetX, offsetY } = patternOffsetForMode(mode, rampVal, nx, ny, dirX, dirY);
        const { curX, curY, edgeX, edgeY, edgeXAlt, edgeYAlt } = sampleEdgeBasis(
          field,
          fi,
          rowStride,
          width,
          height,
          col,
          row,
          offsetX,
          offsetY,
        );
        field[fi] = -(edgeX * offsetX + edgeXAlt * offsetY - curX);
        field[fi + 1] = -(edgeY * offsetX + edgeYAlt * offsetY - curY);
      }
      outCount++;
    }
  }
}

/**
 * Axis-aligned bounds of a flat [x,y,x,y,…] point list.
 * @param {number[]} points
 * @returns {[number, number, number, number]} [minX, minY, maxX, maxY]
 */
function computePointBounds(points) {
  let minX = points[0];
  let maxX = points[0];
  let minY = points[1];
  let maxY = points[1];
  for (let i = 0; i < points.length; i += 2) {
    const px = points[i];
    const py = points[i + 1];
    if (px < minX) {
      minX = px;
    } else if (px > maxX) {
      maxX = px;
    }
    if (py < minY) {
      minY = py;
    } else if (py > maxY) {
      maxY = py;
    }
  }
  return [minX, minY, maxX, maxY];
}


/**
 * Dithering ditheringPatterns. The error-diffusion ramp is cached by its mix and scale,
 * since a filter asks for the same pair for every pixel it walks.
 */
export const ditheringPatterns = {
    errorDiffusionCacheKey: "",
    errorDiffusionCache: [],
    applyThreshold,
    applyErrorDiffusion(mix, scale) {
      const key = mix + "," + scale;
      if (ditheringPatterns.errorDiffusionCacheKey == key) {
        return ditheringPatterns.errorDiffusionCache;
      }
      const ramp = buildErrorDiffusionRamp(mix, scale);
      ditheringPatterns.errorDiffusionCache = ramp;
      ditheringPatterns.errorDiffusionCacheKey = key;
      return ramp;
    },
    applyPatternDithering(field, width, height, mode, centerX, centerY, radius, mix, strength, dirX, dirY, outIndices, invert) {
      runPatternDithering(
        ditheringPatterns,
        field,
        width,
        height,
        mode,
        centerX,
        centerY,
        radius,
        mix,
        strength,
        dirX,
        dirY,
        outIndices,
        invert,
      );
    },
    computePointBounds,
  };
