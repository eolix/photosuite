/**
 * Lens Correction (`LnCr`) warp + colour effects.
 *
 * The geometric path builds a displacement map for
 * {@link applyWarp} — distortion, scale, rotation and
 * keystone. Chromatic aberration and vignette run afterward on the warped RGBA
 * buffer, and the chosen edge treatment fills whatever the warp left uncovered.
 */

/**
 * Keystone strength each perspective slider reaches at ±100.
 *
 * The two sliders share one projective denominator, so the pair can drive it to
 * `1 - 2 * LENS_KEYSTONE_REACH` at the far corner. Keeping that comfortably
 * above zero is what stops the transform from collapsing: at these limits the
 * strongest magnification the far edge can see is a little over three times,
 * and no slider position can produce a singularity.
 */
const LENS_KEYSTONE_REACH = 0.35;

/**
 * Edge treatments for the region the warp leaves uncovered, written to `LnFt`.
 *
 * Adobe does not publish the values behind this field, so these are the app's
 * own: `Transparency` and `EdgeExtension` pass straight through as the warp
 * sampler's own edge modes, and the two colour fills warp transparent and then
 * paint what is left.
 */
export const LENS_EDGE_TRANSPARENCY = 0;
export const LENS_EDGE_EXTENSION = 1;
export const LENS_EDGE_BLACK = 2;
export const LENS_EDGE_WHITE = 3;

/** Ceiling on the brightening a vignetting profile may ask for: two stops. */
const PROFILE_VIGNETTING_MAX_GAIN = 4;

/**
 * Radius units a profile's coefficients are measured against, in the pixels (or
 * grid cells) of whatever is being corrected.
 *
 * Coefficients belong to the frame they were measured on. Applying them to a
 * body with a different sensor means the same pixel sits at a different point in
 * the lens's image circle: a lens calibrated on APS-C reaches further out when
 * used on full frame, and correspondingly less the other way. The two families
 * disagree about where radius 1 falls, so each gets its own unit — half the
 * short side of the calibration frame for distortion and colour fringing, half
 * the diagonal of a 3:2 frame at the calibration crop for vignetting.
 *
 * @returns {{ coordinate: number, vignetting: number }}
 */
function profileRadiusUnits(calibration, width, height) {
  const calibrationCrop = calibration.calibrationCropFactor || 1;
  const imageCrop = calibration.imageCropFactor || calibrationCrop;
  const cropRatio = imageCrop / calibrationCrop;
  const shortSide = Math.min(width, height);
  const imageAspect = shortSide > 0 ? Math.max(width, height) / shortSide : 1;
  const calibrationAspect = calibration.calibrationAspectRatio || 1.5;
  const aspectRatio =
    Math.sqrt(imageAspect * imageAspect + 1) / Math.sqrt(calibrationAspect * calibrationAspect + 1);
  return {
    coordinate: Math.max(shortSide * 0.5 * cropRatio * aspectRatio, 1e-6),
    vignetting: Math.max(Math.sqrt(width * width + height * height) * 0.5 * cropRatio, 1e-6),
  };
}

/** Distortion model ids, matching `distortionModels` in the profile database. */
const PROFILE_DISTORTION_POLY3 = 0;
const PROFILE_DISTORTION_POLY5 = 1;

/** Dropdown labels paired with their `LnFt` value. */
export const LENS_EDGE_OPTIONS = [
  ["Transparency", LENS_EDGE_TRANSPARENCY],
  ["Edge Extension", LENS_EDGE_EXTENSION],
  ["Black", LENS_EDGE_BLACK],
  ["White", LENS_EDGE_WHITE],
];

function readNumber(descriptor, key, fallback) {
  const node = descriptor && descriptor[key];
  return node && node.v != null ? node.v : fallback;
}

function readFlag(descriptor, key) {
  const node = descriptor && descriptor[key];
  return !!(node && node.v);
}

/**
 * Warp sampler edge mode for a descriptor: the colour fills warp transparent
 * and are painted afterward by {@link fillUncoveredEdges}.
 */
export function resolveLensCorrectionEdgeMode(descriptor) {
  return readNumber(descriptor, "LnFt", LENS_EDGE_TRANSPARENCY) === LENS_EDGE_EXTENSION ? 1 : 0;
}

/**
 * Paint the region the warp left uncovered, when the edge treatment asks for a
 * flat colour. Pixels the warp reached keep their own alpha.
 */
export function fillUncoveredEdges(rgba, descriptor) {
  const edgeMode = readNumber(descriptor, "LnFt", LENS_EDGE_TRANSPARENCY);
  if (edgeMode !== LENS_EDGE_BLACK && edgeMode !== LENS_EDGE_WHITE) return;
  const fill = edgeMode === LENS_EDGE_WHITE ? 255 : 0;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    if (rgba[offset + 3] === 255) continue;
    // Uncovered pixels are fully transparent; partially covered edge pixels are
    // composited over the fill so the boundary stays smooth.
    const coverage = rgba[offset + 3] / 255;
    rgba[offset] = Math.round(rgba[offset] * coverage + fill * (1 - coverage));
    rgba[offset + 1] = Math.round(rgba[offset + 1] * coverage + fill * (1 - coverage));
    rgba[offset + 2] = Math.round(rgba[offset + 2] * coverage + fill * (1 - coverage));
    rgba[offset + 3] = 255;
  }
}

/**
 * Fill `warpMap.map` with per-cell source displacements for Lens Correction
 * geometry: distortion, scale, rotation and keystone.
 *
 * With Auto Scale on, the map is measured after it is built and rebuilt at
 * whatever magnification pulls the whole frame back inside the image.
 *
 * @param {{ gridWidth: number, gridHeight: number, map: Float32Array }} warpMap
 * @param {object} descriptor LnCr filter descriptor
 */
export function fillLensCorrectionWarpMap(warpMap, descriptor, calibration) {
  const lensSize = readNumber(descriptor, "LnSi", 100) / 100;
  const distortion = calibration && readFlag(descriptor, "LnAg") ? calibration.distortion : null;
  const radiusUnit = distortion
    ? profileRadiusUnits(calibration, warpMap.gridWidth, warpMap.gridHeight).coordinate
    : 0;
  fillWarpMapAtScale(warpMap, descriptor, lensSize, distortion, radiusUnit);
  if (!readFlag(descriptor, "LnAs")) return;
  const overreach = measureWarpOverreach(warpMap);
  if (overreach > 1.0001) {
    fillWarpMapAtScale(warpMap, descriptor, lensSize * overreach, distortion, radiusUnit);
  }
}

/**
 * Radial scale a measured distortion profile applies at normalised radius `ru`.
 *
 * `ru` is in the profile's own convention — 1 at the middle of the long edge,
 * which is half the short side of the frame. See the database README; poly3 and
 * ptlens are built so that radius holds still, poly5 is not.
 */
function evaluateProfileDistortion(distortion, ru) {
  const squared = ru * ru;
  if (distortion.model === PROFILE_DISTORTION_POLY3) {
    return 1 - distortion.c0 + distortion.c0 * squared;
  }
  if (distortion.model === PROFILE_DISTORTION_POLY5) {
    return 1 + distortion.c0 * squared + distortion.c1 * squared * squared;
  }
  const settled = 1 - distortion.c0 - distortion.c1 - distortion.c2;
  return distortion.c0 * squared * ru + distortion.c1 * squared + distortion.c2 * ru + settled;
}

/**
 * How far outside the frame the warp currently samples, as a multiple of the
 * half-frame. 1 means every output pixel already lands on the image.
 */
function measureWarpOverreach(warpMap) {
  const gridWidth = warpMap.gridWidth;
  const gridHeight = warpMap.gridHeight;
  const centreX = 0.5 * (gridWidth - 1);
  const centreY = 0.5 * (gridHeight - 1);
  if (centreX <= 0 || centreY <= 0) return 1;
  let overreach = 1;
  for (let mapRow = 0; mapRow < gridHeight; mapRow++) {
    for (let mapCol = 0; mapCol < gridWidth; mapCol++) {
      const mapOffset = (mapRow * gridWidth + mapCol) << 1;
      const sampledX = mapCol + warpMap.map[mapOffset] - centreX;
      const sampledY = mapRow + warpMap.map[mapOffset + 1] - centreY;
      const reach = Math.max(Math.abs(sampledX) / centreX, Math.abs(sampledY) / centreY);
      if (reach > overreach) overreach = reach;
    }
  }
  return overreach;
}

function fillWarpMapAtScale(warpMap, descriptor, lensSize, profileDistortion, profileRadiusUnit) {
  const gridWidth = warpMap.gridWidth;
  const gridHeight = warpMap.gridHeight;
  const gridCenterX = 0.5 * (gridWidth - 1);
  const gridCenterY = 0.5 * (gridHeight - 1);
  const edgeDistX = Math.max(Math.abs(0 - gridCenterX), Math.abs(1 - gridCenterX));
  const edgeDistY = Math.max(Math.abs(0 - gridCenterY), Math.abs(1 - gridCenterY));
  const maxRadius = Math.sqrt(edgeDistX * edgeDistX + edgeDistY * edgeDistY) || 1;

  const invLensSize = 1 / (lensSize || 1e-6);
  const distortAmount = readNumber(descriptor, "LnIa", 0) / 100;
  const distortScale = distortAmount == 0 ? 1e-6 : distortAmount * 4.6;
  const gridScale = invLensSize / maxRadius;

  const angleRad = readNumber(descriptor, "LnRa", 0) * Math.PI / 180;
  const cosA = Math.cos(-angleRad);
  const sinA = Math.sin(-angleRad);
  const vertKeystone = readNumber(descriptor, "LnVp", 0) / 100 * LENS_KEYSTONE_REACH;
  const horizKeystone = readNumber(descriptor, "LnHp", 0) / 100 * LENS_KEYSTONE_REACH;
  const invCenterX = 1 / Math.max(Math.abs(gridCenterX), 1e-6);
  const invCenterY = 1 / Math.max(Math.abs(gridCenterY), 1e-6);
  for (let mapRow = 0; mapRow < gridHeight; mapRow++) {
    for (let mapCol = 0; mapCol < gridWidth; mapCol++) {
      const dx = mapCol - gridCenterX;
      const dy = mapRow - gridCenterY;

      // Inverse rotation (sample from the pre-rotated location).
      const rotatedX = dx * cosA - dy * sinA;
      const rotatedY = dx * sinA + dy * cosA;

      // One projective denominator drives both axes, so the frame foreshortens
      // as it narrows instead of only stretching sideways.
      const projectiveW =
        1 + vertKeystone * (rotatedY * invCenterY) + horizKeystone * (rotatedX * invCenterX);
      let sampleX = rotatedX / projectiveW;
      let sampleY = rotatedY / projectiveW;

      // The measured profile corrects the lens; the sliders adjust from there.
      if (profileDistortion) {
        const profileRadius = Math.sqrt(sampleX * sampleX + sampleY * sampleY) / profileRadiusUnit;
        if (profileRadius > 1e-9) {
          const profileScale = evaluateProfileDistortion(profileDistortion, profileRadius);
          sampleX *= profileScale;
          sampleY *= profileScale;
        }
      }

      const normX = sampleX * gridScale;
      const normY = sampleY * gridScale;
      const scaledRadius = Math.sqrt(normX * normX + normY * normY) * distortScale;
      const atanRadius = Math.atan(scaledRadius);
      // Both ratios tend to 1 at the centre, where they are otherwise 0/0. A
      // grid with an odd cell count on both axes puts a cell exactly there.
      const lensFactor = scaledRadius < 1e-12
        ? 1
        : distortAmount > 0 ? atanRadius / scaledRadius : scaledRadius / atanRadius;
      const mappedX = gridCenterX + maxRadius * lensFactor * normX;
      const mappedY = gridCenterY + maxRadius * lensFactor * normY;
      const mapOffset = (mapRow * gridWidth + mapCol) << 1;
      warpMap.map[mapOffset] = mappedX - mapCol;
      warpMap.map[mapOffset + 1] = mappedY - mapRow;
    }
  }
}

function clampByte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value | 0;
}

function sampleChannelBilinear(src, width, height, x, y, channel) {
  if (x < 0 || y < 0 || x >= width - 1 || y >= height - 1) {
    const ix = Math.max(0, Math.min(width - 1, Math.round(x)));
    const iy = Math.max(0, Math.min(height - 1, Math.round(y)));
    return src[(iy * width + ix) * 4 + channel];
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const row = width * 4;
  const o00 = (y0 * width + x0) * 4 + channel;
  const o10 = o00 + 4;
  const o01 = o00 + row;
  const o11 = o01 + 4;
  return src[o00] * (1 - fx) * (1 - fy)
    + src[o10] * fx * (1 - fy)
    + src[o01] * (1 - fx) * fy
    + src[o11] * fx * fy;
}

/**
 * Radial per-channel scale to reduce color fringing (Photoshop Custom CA sliders).
 * Values are typically −100…100 on `LnRc` / `LnGm` / `LnBy`.
 */
export function applyChromaticAberration(rgba, width, height, redCyan, greenMagenta, blueYellow) {
  if (!redCyan && !greenMagenta && !blueYellow) return;
  const src = rgba.slice(0);
  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  const channelScale = [
    1 + (redCyan || 0) / 100 * 0.025,
    1 + (greenMagenta || 0) / 100 * 0.025,
    1 + (blueYellow || 0) / 100 * 0.025,
  ];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const destOffset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const scale = channelScale[channel];
        const sx = cx + dx / scale;
        const sy = cy + dy / scale;
        rgba[destOffset + channel] = clampByte(
          Math.round(sampleChannelBilinear(src, width, height, sx, sy, channel))
        );
      }
    }
  }
}

/**
 * Edge darken / lighten. `amount` is `LnSb` (−100…100); `midpoint` is `LnSt` (0…100).
 */
export function applyLensVignette(rgba, width, height, amount, midpoint) {
  if (!amount) return;
  const amt = amount / 100;
  const mid = Math.max(0, Math.min(0.99, (midpoint != null ? midpoint : 50) / 100));
  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  const maxDist = Math.sqrt(cx * cx + cy * cy) || 1;
  const falloffSpan = 1 - mid || 1e-6;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / maxDist;
      const dy = (y - cy) / maxDist;
      const radius = Math.sqrt(dx * dx + dy * dy);
      let t = (radius - mid) / falloffSpan;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      t = t * t;
      const factor = 1 + amt * t;
      const offset = (y * width + x) * 4;
      rgba[offset] = clampByte(Math.round(rgba[offset] * factor));
      rgba[offset + 1] = clampByte(Math.round(rgba[offset + 1] * factor));
      rgba[offset + 2] = clampByte(Math.round(rgba[offset + 2] * factor));
    }
  }
}

/**
 * Draw an alignment grid into `rgba` (preview / Show Grid). Spacing from `LnNa`.
 */
export function drawLensCorrectionGrid(rgba, width, height, spacing, rgbColor, opacity) {
  const step = Math.max(4, spacing | 0 || 64);
  const r = rgbColor && rgbColor.Rd != null ? rgbColor.Rd.v : 127;
  const g = rgbColor && rgbColor.Grn != null ? rgbColor.Grn.v : 127;
  const b = rgbColor && rgbColor.Bl != null ? rgbColor.Bl.v : 127;
  const alpha = opacity == null ? 0.55 : opacity;
  const inv = 1 - alpha;

  function blendPixel(offset) {
    rgba[offset] = clampByte(Math.round(rgba[offset] * inv + r * alpha));
    rgba[offset + 1] = clampByte(Math.round(rgba[offset + 1] * inv + g * alpha));
    rgba[offset + 2] = clampByte(Math.round(rgba[offset + 2] * inv + b * alpha));
  }

  for (let x = 0; x < width; x += step) {
    for (let y = 0; y < height; y++) blendPixel((y * width + x) * 4);
  }
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x++) blendPixel((y * width + x) * 4);
  }
}

/**
 * Remove the colour fringing a lens profile measured, by rescaling red and blue
 * radially against green.
 *
 * Each channel follows `Rd = Ru · (b·Ru² + c·Ru + v)` in the profile's radius
 * convention — 1 at half the short side of the frame.
 */
export function applyProfileChromaticAberration(rgba, width, height, calibration) {
  const tca = calibration && calibration.tca;
  if (!tca) return;
  const source = rgba.slice(0);
  const centreX = (width - 1) * 0.5;
  const centreY = (height - 1) * 0.5;
  const radiusUnit = profileRadiusUnits(calibration, width, height).coordinate;
  const channelTerms = [
    [tca.redB, tca.redC, tca.redV],
    null,
    [tca.blueB, tca.blueC, tca.blueV],
  ];
  for (let y = 0; y < height; y++) {
    const offsetY = y - centreY;
    for (let x = 0; x < width; x++) {
      const offsetX = x - centreX;
      const radius = Math.sqrt(offsetX * offsetX + offsetY * offsetY) / radiusUnit;
      const destOffset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel += 2) {
        const terms = channelTerms[channel];
        const scale = terms[0] * radius * radius + terms[1] * radius + terms[2];
        rgba[destOffset + channel] = clampByte(Math.round(sampleChannelBilinear(
          source, width, height,
          centreX + offsetX * scale, centreY + offsetY * scale, channel,
        )));
      }
    }
  }
}

/**
 * Undo the falloff a lens profile measured.
 *
 * The stored polynomial describes the attenuation the lens applies, with radius
 * 1 at the frame corner, so correcting divides by it.
 *
 * The gain is capped at two stops. Some fits are only well behaved inside the
 * frame and turn over near the extreme corner — a fast wide lens wide open can
 * evaluate to a negative attenuation at radius 1 — and past that the model has
 * stopped describing the lens. Capping also keeps corner noise from being
 * lifted into a smear, the visible failure when a correction is trusted too far
 * out.
 */
export function applyProfileVignetting(rgba, width, height, calibration) {
  const vignetting = calibration && calibration.vignetting;
  if (!vignetting) return;
  const centreX = (width - 1) * 0.5;
  const centreY = (height - 1) * 0.5;
  const cornerRadius = profileRadiusUnits(calibration, width, height).vignetting;
  for (let y = 0; y < height; y++) {
    const offsetY = (y - centreY) / cornerRadius;
    for (let x = 0; x < width; x++) {
      const offsetX = (x - centreX) / cornerRadius;
      const squared = offsetX * offsetX + offsetY * offsetY;
      const quartic = squared * squared;
      const attenuation =
        1 + vignetting.k1 * squared + vignetting.k2 * quartic + vignetting.k3 * quartic * squared;
      const gain = attenuation > 1 / PROFILE_VIGNETTING_MAX_GAIN
        ? 1 / attenuation
        : PROFILE_VIGNETTING_MAX_GAIN;
      const offset = (y * width + x) * 4;
      rgba[offset] = clampByte(Math.round(rgba[offset] * gain));
      rgba[offset + 1] = clampByte(Math.round(rgba[offset + 1] * gain));
      rgba[offset + 2] = clampByte(Math.round(rgba[offset + 2] * gain));
    }
  }
}

/**
 * Colour corrections after the geometric warp: what the lens profile measured
 * first, then the manual sliders on top of it.
 *
 * `lensProfileCalibration` is attached to the descriptor by the dialog once a
 * profile has been resolved. It carries the coefficients themselves rather than
 * a lens name so a committed filter keeps rendering the same way, whatever the
 * profile database says later.
 *
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {object} descriptor
 */
export function applyLensCorrectionColorEffects(rgba, width, height, descriptor) {
  const profile = descriptor && descriptor.lensProfileCalibration;
  if (profile) {
    if (readFlag(descriptor, "LnAc")) {
      applyProfileChromaticAberration(rgba, width, height, profile);
    }
    if (readFlag(descriptor, "LnAv")) {
      applyProfileVignetting(rgba, width, height, profile);
    }
  }
  applyChromaticAberration(
    rgba,
    width,
    height,
    readNumber(descriptor, "LnRc", 0),
    readNumber(descriptor, "LnGm", 0),
    readNumber(descriptor, "LnBy", 0),
  );
  applyLensVignette(
    rgba,
    width,
    height,
    readNumber(descriptor, "LnSb", 0),
    readNumber(descriptor, "LnSt", 50),
  );
}
