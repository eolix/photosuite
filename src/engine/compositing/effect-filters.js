/**
 * Effect filters: lens-flare presets and shadow/highlight tone correction.
 */

import { Rect } from "../../core/math/rect.js";
import { allocBuffer } from "./buffer-utils.js";
import { luminanceFromRgb } from "./color-math.js";
import { gaussianBlurRgba } from "./blur.js";

const DEG_TO_RAD = Math.PI / 180;
const HUE_LUT_MAX = 300;
const CHROMA_RADIUS_LUT_SIZE = 32768;

function dist2d(colA, rowA, colB, rowB) {
  return Math.sqrt((colA - colB) * (colA - colB) + (rowA - rowB) * (rowA - rowB));
}

function fractPart(x) {
  return x - ~~x;
}

function fractComplement(x) {
  return 1 - fractPart(x);
}

function hueAtAngle(hueAngle) {
  const hueChroma = 0.8;
  const hueLightness = 0.2;
  const chromaLight = hueChroma * hueLightness;
  const hueMirror = (hueAngle / 60) % 2 - 1;
  const greenMix = chromaLight * (1 - hueMirror * hueMirror);
  const minChannel = hueLightness - chromaLight;
  let rgbTriplet;
  if (hueAngle < 60) {
    rgbTriplet = [chromaLight + minChannel, greenMix, 0];
  } else if (hueAngle < 120) {
    rgbTriplet = [greenMix, chromaLight, 0];
  } else if (hueAngle < 180) {
    rgbTriplet = [0, chromaLight, greenMix];
  } else if (hueAngle < 240) {
    rgbTriplet = [0, greenMix, chromaLight];
  } else if (hueAngle < 300) {
    rgbTriplet = [greenMix, 0, chromaLight];
  } else {
    rgbTriplet = [chromaLight, 0, greenMix];
  }
  return [(rgbTriplet[0] + minChannel) * 255, (rgbTriplet[1] + minChannel) * 255, (rgbTriplet[2] + minChannel) * 255];
}

function buildHueLut() {
  const hueLut = [];
  for (let hueIdx = 0; hueIdx <= HUE_LUT_MAX; hueIdx++) {
    hueLut[hueIdx] = hueAtAngle(hueIdx);
  }
  return hueLut;
}

function rgbOnly(rgba) {
  const out = rgba.slice(0, 3);
  out[3] = 0;
  return out;
}

/** Integer brush stamp point used by flare geometry. */
function FlarePoint(x, y) {
  this.x = Math.round(x);
  this.y = Math.round(y);
}

FlarePoint.prototype.polarLineTo = function (angleDeg, length) {
  angleDeg = angleDeg * DEG_TO_RAD;
  const endX = this.x + length * Math.cos(angleDeg);
  const endY = this.y + length * Math.sin(angleDeg);
  return new FlareSegment(this.x, this.y, endX, endY);
};

FlarePoint.prototype.polarOffset = function (angleDeg, length) {
  angleDeg = angleDeg * DEG_TO_RAD;
  const outX = this.x + length * Math.cos(angleDeg);
  const outY = this.y + length * Math.sin(angleDeg);
  return new FlarePoint(outX, outY);
};

function FlareSegment(startX, startY, endX, endY) {
  this.start = new FlarePoint(startX, startY);
  this.end = new FlarePoint(endX, endY);
}

FlareSegment.prototype.lerp = function (blend) {
  const x = blend * this.start.x + (1 - blend) * this.end.x;
  const y = blend * this.start.y + (1 - blend) * this.end.y;
  return new FlarePoint(x, y);
};

/**
 * Drawing surface + stamp helpers for one lens-flare render.
 */
function createFlareDrawer(width, height, destRgba, opacityScale) {
  const widthScale = width / 800;
  const hueLut = buildHueLut();

  function inBounds(col, row) {
    return col >= 0 && col < width && row >= 0 && row < height;
  }

  function clampCol(col) {
    if (col < 0) {
      return 0;
    }
    if (col >= width) {
      return width - 1;
    }
    return col;
  }

  function clampRow(row) {
    if (row < 0) {
      return 0;
    }
    if (row >= height) {
      return height - 1;
    }
    return row;
  }

  function scaleRadius(r) {
    return Math.round(r * widthScale);
  }

  function addPremulRgb(rgbaOff, rgba) {
    const alpha = rgba[3] * (1 / 255);
    let ch = destRgba[rgbaOff] + rgba[0] * alpha;
    if (ch > 255) {
      ch = 255;
    }
    destRgba[rgbaOff] = ch;
    ch = destRgba[rgbaOff + 1] + rgba[1] * alpha;
    if (ch > 255) {
      ch = 255;
    }
    destRgba[rgbaOff + 1] = ch;
    ch = destRgba[rgbaOff + 2] + rgba[2] * alpha;
    if (ch > 255) {
      ch = 255;
    }
    destRgba[rgbaOff + 2] = ch;
  }

  function stampAt(col, row, rgba) {
    if (!inBounds(col, row)) {
      return;
    }
    if (rgba[3] < 0) {
      rgba[3] = 0;
    }
    addPremulRgb((row * width + col) * 4, rgba);
  }

  function hueRgbAt(angle) {
    return hueLut[~~angle];
  }

  function drawSoftDiscCore(anchor, radius, rgba, alpha, feather, power, outerGlow, innerCut, skipScale) {
    if (power == null) {
      power = 0.5;
    }
    if (outerGlow == null) {
      outerGlow = 0;
    }
    if (innerCut == null) {
      innerCut = 0;
    }
    if (skipScale == null) {
      skipScale = false;
    }
    const centerX = anchor.x;
    const centerY = anchor.y;
    const stampRgba = rgba.slice(0);
    const baseAlpha = ~~(rgba[3] * opacityScale);
    alpha = alpha * opacityScale;
    if (!skipScale) {
      radius = scaleRadius(radius);
      feather = scaleRadius(feather);
      outerGlow = scaleRadius(outerGlow);
      innerCut = scaleRadius(innerCut);
    }
    const colMin = clampCol(centerX - radius);
    const colMax = clampCol(centerX + radius);
    for (let col = colMin; col <= colMax; col++) {
      const dx = col - centerX;
      const rowSpan = Math.floor(Math.sqrt(radius * radius - dx * dx));
      let rowMin = clampRow(centerY - rowSpan);
      const rowMid = clampRow(centerY);
      for (let row = rowMin; row <= rowMid; row++) {
        const dist = dist2d(col, row, centerX, centerY);
        if (dist > radius || dist <= radius - feather) {
          break;
        }
        const featherT = (dist - radius + feather) / feather;
        stampRgba[3] = baseAlpha - alpha * (power == 1 ? featherT : Math.pow(featherT, power));
        addPremulRgb((row * width + col) * 4, stampRgba);
      }
      rowMin = clampRow(centerY + rowSpan);
      for (let row = rowMin; row > rowMid; row--) {
        const dist = dist2d(col, row, centerX, centerY);
        if (dist > radius || dist <= radius - feather) {
          break;
        }
        const featherT = (dist - radius + feather) / feather;
        stampRgba[3] = baseAlpha - alpha * (power == 1 ? featherT : Math.pow(featherT, power));
        addPremulRgb((row * width + col) * 4, stampRgba);
      }
    }
    if (outerGlow > 0) {
      drawSoftDiscCore(anchor, radius + outerGlow, stampRgba, stampRgba[3], outerGlow, 1, 0, 0, true);
    }
    if (innerCut > 0) {
      drawSoftDiscCore(anchor, radius - feather, rgbOnly(rgba), -rgba[3], innerCut, 1, 0, 0, true);
    }
  }

  /** Disc of constant alpha out to {@code radius}, with a soft skirt beyond it. */
  function drawFlatDisc(anchor, radius, rgba, outerGlow) {
    drawSoftDiscCore(anchor, radius, rgba, 0, radius + 1, 1, outerGlow);
  }

  /** Narrow ring on {@code radius}: {@code feather} is its width in unscaled units. */
  function drawThinRing(anchor, radius, rgba, feather, outerGlow, innerCut) {
    drawSoftDiscCore(anchor, radius, rgba, 0, feather, 1, outerGlow, innerCut);
  }

  /**
   * Band {@code feather} wide inside {@code radius} whose alpha ramps linearly by
   * {@code rimDelta} from rim to inner edge. A positive delta fades outward (a glow);
   * a negative one fades inward (a ghost with a bright rim).
   */
  function drawRampedBand(anchor, radius, rgba, rimDelta, feather, outerGlow) {
    drawSoftDiscCore(anchor, radius, rgba, rimDelta, feather, 1, outerGlow);
  }

  /** Disc brightest at the centre, falling linearly to nothing at the rim. */
  function drawRadialGlow(anchor, radius, rgba, outerGlow) {
    drawSoftDiscCore(anchor, radius, rgba, rgba[3], radius + 1, 1, outerGlow);
  }

  function drawRainbowDisc(anchor, radius, feather, alpha, skipScale) {
    if (skipScale == null) {
      skipScale = false;
    }
    const centerX = anchor.x;
    const centerY = anchor.y;
    alpha *= opacityScale;
    if (!skipScale) {
      radius = scaleRadius(radius);
      feather = scaleRadius(feather);
    }
    const colMin = clampCol(centerX - radius);
    const colMax = clampCol(centerX + radius);
    for (let col = colMin; col < colMax; col++) {
      const dx = col - centerX;
      const rowSpan = ~~Math.sqrt(radius * radius - dx * dx);
      let rowMin = clampRow(centerY - rowSpan);
      const rowMid = clampRow(centerY);
      for (let row = rowMin; row <= rowMid; row++) {
        const dist = dist2d(col, row, centerX, centerY);
        if (dist > radius || dist <= radius - feather) {
          break;
        }
        const rainbowT = (radius - dist) / feather;
        const hueRgb = hueRgbAt(300 * rainbowT);
        hueRgb[3] = alpha;
        addPremulRgb((row * width + col) * 4, hueRgb);
      }
      rowMin = clampRow(centerY + rowSpan);
      for (let row = rowMin; row > rowMid; row--) {
        const dist = dist2d(col, row, centerX, centerY);
        if (dist > radius || dist <= radius - feather) {
          break;
        }
        const rainbowT = (radius - dist) / feather;
        const hueRgb = hueRgbAt(300 * rainbowT);
        hueRgb[3] = alpha;
        addPremulRgb((row * width + col) * 4, hueRgb);
      }
    }
  }

  function drawLineSegment(segment, rgba) {
    let start = segment.start;
    let end = segment.end;
    const stampRgba = rgba.slice(0);
    const lineAlpha = rgba[3] * opacityScale;
    const swapAxes = Math.abs(end.y - start.y) > Math.abs(end.x - start.x);
    if (swapAxes) {
      let tmp = start.x;
      start.x = start.y;
      start.y = tmp;
      tmp = end.x;
      end.x = end.y;
      end.y = tmp;
    }
    if (start.x > end.x) {
      const tmpSeg = start;
      start = end;
      end = tmpSeg;
    }
    const run = end.x - start.x;
    const rise = end.y - start.y;
    const slope = run == 0 ? 1 : rise / run;
    let xRounded = Math.round(start.x);
    let yAtRounded = start.y + slope * (xRounded - start.x);
    let xFrac = fractComplement(start.x + 0.5);
    const xCur = xRounded;
    const yFloor = ~~yAtRounded;
    if (swapAxes) {
      stampRgba[3] = lineAlpha * fractComplement(yAtRounded) * xFrac;
      stampAt(yFloor, xCur, stampRgba);
      stampRgba[3] = lineAlpha * fractPart(yAtRounded) * xFrac;
      stampAt(yFloor + 1, xCur, stampRgba);
    } else {
      stampRgba[3] = lineAlpha * fractComplement(yAtRounded) * xFrac;
      stampAt(xCur, yFloor, stampRgba);
      stampRgba[3] = lineAlpha * fractPart(yAtRounded) * xFrac;
      stampAt(xCur, yFloor + 1, stampRgba);
    }
    let yWalk = yAtRounded - slope;
    xRounded = Math.round(end.x);
    yAtRounded = end.y + slope * (xRounded - end.x);
    xFrac = fractPart(end.x + 0.5);
    const xEnd = xRounded;
    const yEndFloor = ~~yAtRounded;
    if (swapAxes) {
      stampRgba[3] = lineAlpha * fractComplement(yAtRounded) * xFrac;
      stampAt(yEndFloor, xEnd, stampRgba);
      stampRgba[3] = lineAlpha * fractPart(yAtRounded) * xFrac;
      stampAt(yEndFloor + 1, xEnd, stampRgba);
    } else {
      stampRgba[3] = lineAlpha * fractComplement(yAtRounded) * xFrac;
      stampAt(xEnd, yEndFloor, stampRgba);
      stampRgba[3] = lineAlpha * fractPart(yAtRounded) * xFrac;
      stampAt(xEnd, yEndFloor + 1, stampRgba);
    }
    if (swapAxes) {
      for (let xStep = xCur + 1; xStep <= xEnd - 1; xStep++) {
        stampRgba[3] = lineAlpha * fractComplement(yWalk);
        stampAt(~~yWalk, xStep, stampRgba);
        stampRgba[3] = lineAlpha * fractPart(yWalk);
        stampAt(~~yWalk + 1, xStep, stampRgba);
        yWalk += slope;
      }
    } else {
      for (let xStep = xCur + 1; xStep <= xEnd - 1; xStep++) {
        stampRgba[3] = lineAlpha * fractComplement(yWalk);
        stampAt(xStep, ~~yWalk, stampRgba);
        stampRgba[3] = lineAlpha * fractPart(yWalk);
        stampAt(xStep, ~~yWalk + 1, stampRgba);
        yWalk += slope;
      }
    }
  }

  function drawSpokes(anchor, angle, length, rgba) {
    for (let spokeIdx = 0; spokeIdx < 4; spokeIdx++) {
      const segment = anchor.polarLineTo(angle + 1.3 * spokeIdx, length);
      drawLineSegment(segment, rgba);
    }
  }

  function drawScatteredRays(anchor, rayCount, angleStepMax, lengthMin, lengthMax, rgba) {
    let rayAngle = Math.random() * angleStepMax;
    for (let rayIdx = 0; rayIdx < rayCount; rayIdx++) {
      rayAngle += Math.random() * angleStepMax;
      const rayLength = Math.random() * scaleRadius(lengthMax) + scaleRadius(lengthMin);
      drawLineSegment(anchor.polarLineTo(rayAngle, rayLength), rgba);
    }
  }

  /**
   * Evenly spaced long spikes plus shorter random fill rays. `bundleSpread`, in
   * degrees, fans every ray into a cluster of near-parallel hairs of differing
   * length; omit it (or pass 0) to draw each ray as a single hair.
   */
  function drawStarburstRays(anchor, primaryCount, scatterCount, primaryLength, scatterLengthMax, primaryRgba, scatterRgba, bundleSpread) {
    if (bundleSpread == null) {
      bundleSpread = 0;
    }
    const hairsPerRay = bundleSpread > 0 ? 4 : 1;
    function hairAngleOffset(hairIdx) {
      if (hairsPerRay == 1) {
        return 0;
      }
      return (hairIdx / (hairsPerRay - 1) - 0.5) * bundleSpread;
    }
    const primaryStep = 360 / primaryCount;
    let baseAngle = Math.random() * primaryStep;
    const primaryRgbaCopy = primaryRgba.slice(0);
    for (let rayIdx = 0; rayIdx < primaryCount; rayIdx++) {
      const rayAngle = baseAngle + primaryStep * rayIdx;
      for (let hairIdx = 0; hairIdx < hairsPerRay; hairIdx++) {
        const rayLength = scaleRadius(primaryLength) * (0.82 + Math.random() * 0.35);
        drawLineSegment(anchor.polarLineTo(rayAngle + hairAngleOffset(hairIdx), rayLength), primaryRgbaCopy);
      }
    }
    let scatterAngle = Math.random() * 22;
    const scatterRgbaCopy = scatterRgba.slice(0);
    for (let rayIdx = 0; rayIdx < scatterCount; rayIdx++) {
      scatterAngle += Math.random() * 16;
      for (let hairIdx = 0; hairIdx < hairsPerRay; hairIdx++) {
        const rayLength = Math.random() * scaleRadius(scatterLengthMax) + scaleRadius(primaryLength * 0.35);
        drawLineSegment(anchor.polarLineTo(scatterAngle + hairAngleOffset(hairIdx), rayLength), scatterRgbaCopy);
      }
    }
  }

  function drawAxisLineThroughImage(segment, rgba) {
    const flare = segment.lerp(1);
    const center = segment.lerp(0);
    const dx = center.x - flare.x;
    const dy = center.y - flare.y;
    const axisLen = Math.sqrt(dx * dx + dy * dy) || 1;
    const scale = (Math.max(width, height) * 2) / axisLen;
    drawLineSegment(
      new FlareSegment(flare.x - dx * scale, flare.y - dy * scale, flare.x + dx * scale, flare.y + dy * scale),
      rgba,
    );
  }

  function drawHorizontalThrough(row, rgba) {
    drawLineSegment(new FlareSegment(0, row, width - 1, row), rgba);
  }

  function drawHorizontalSegment(colStart, colEnd, row, rgba) {
    if (colStart > colEnd) {
      const tmp = colStart;
      colStart = colEnd;
      colEnd = tmp;
    }
    drawLineSegment(new FlareSegment(colStart, row, colEnd, row), rgba);
  }

  function drawAxisSegmentBetween(segment, axisT0, axisT1, rgba) {
    const start = segment.lerp(axisT0);
    const end = segment.lerp(axisT1);
    drawLineSegment(new FlareSegment(start.x, start.y, end.x, end.y), rgba);
  }

  function drawAxisParallelSegment(segment, axisT, halfLength, rgba) {
    const anchor = segment.lerp(axisT);
    const center = segment.lerp(0);
    const axisAngleDeg = Math.atan2(center.y - anchor.y, center.x - anchor.x) * (180 / Math.PI);
    drawLineSegment(anchor.polarLineTo(axisAngleDeg, halfLength), rgba);
    drawLineSegment(anchor.polarLineTo(axisAngleDeg + 180, halfLength), rgba);
  }

  function drawOffsetAxisSegment(segment, axisT, perpOffset, halfLength, rgba) {
    const anchor = segment.lerp(axisT);
    const center = segment.lerp(0);
    const axisRad = Math.atan2(center.y - anchor.y, center.x - anchor.x);
    const shifted = new FlarePoint(
      anchor.x + Math.cos(axisRad + Math.PI / 2) * perpOffset,
      anchor.y + Math.sin(axisRad + Math.PI / 2) * perpOffset,
    );
    const axisAngleDeg = axisRad * (180 / Math.PI);
    drawLineSegment(shifted.polarLineTo(axisAngleDeg, halfLength), rgba);
    drawLineSegment(shifted.polarLineTo(axisAngleDeg + 180, halfLength), rgba);
  }

  function drawPerpendicularSoftDisc(segment, axisT, perpOffset, radius, rgba, feather) {
    const anchor = segment.lerp(axisT);
    const center = segment.lerp(0);
    const axisRad = Math.atan2(center.y - anchor.y, center.x - anchor.x);
    const shifted = new FlarePoint(
      anchor.x + Math.cos(axisRad + Math.PI / 2) * perpOffset,
      anchor.y + Math.sin(axisRad + Math.PI / 2) * perpOffset,
    );
    drawRampedBand(shifted, radius, rgbOnly(rgba), -rgba[3], feather, 2);
  }

  return {
    width,
    height,
    scaleRadius,
    hueRgbAt,
    drawFlatDisc,
    drawThinRing,
    drawRampedBand,
    drawSoftDiscCore,
    drawRadialGlow,
    drawRainbowDisc,
    drawLineSegment,
    drawSpokes,
    drawScatteredRays,
    drawStarburstRays,
    drawAxisLineThroughImage,
    drawHorizontalThrough,
    drawHorizontalSegment,
    drawAxisSegmentBetween,
    drawAxisParallelSegment,
    drawOffsetAxisSegment,
    drawPerpendicularSoftDisc,
  };
}

/** PSD `Lns` enum values in UI order: Zoom, 35mm Prime, 105mm Prime, Movie Prime. */
export const LENS_FLARE_PRESET_WIRE_KEYS = ["Zm", "Nkn", "Nkn1", "PnVs"];

/** 50–300mm Zoom (`Zm`): warm starburst, rainbow tail ghosts, many axis reflections. */
function renderPresetZoom(draw, vignetteSegment) {
  const flareCenter = vignetteSegment.lerp(1);
  draw.drawFlatDisc(vignetteSegment.lerp(1.42), 280, [110, 25, 20, 22], 14);
  draw.drawFlatDisc(flareCenter, 110, [235, 55, 55, 35], 32);
  draw.drawRadialGlow(flareCenter, 58, [255, 35, 20, 55]);
  const whiteRgba = [255, 255, 255, 255];
  draw.drawSoftDiscCore(flareCenter, 62, whiteRgba, whiteRgba[3], 52, 0.45);
  draw.drawFlatDisc(flareCenter, 10, whiteRgba);
  whiteRgba[3] = 32;
  draw.drawRampedBand(flareCenter, 145, whiteRgba, whiteRgba[3], 140);
  draw.drawStarburstRays(
    flareCenter,
    12,
    36,
    320,
    340,
    [255, 120, 100, 38],
    [200, 70, 60, 22],
  );
  draw.drawRampedBand(vignetteSegment.lerp(1.1), 16, rgbOnly([190, 210, 70, 35]), -35, 10, 2);
  draw.drawFlatDisc(vignetteSegment.lerp(0.94), 12, [35, 55, 210, 50], 4);
  draw.drawFlatDisc(vignetteSegment.lerp(0.9), 9, [25, 45, 200, 40], 3);
  draw.drawRadialGlow(vignetteSegment.lerp(1), 125, [255, 255, 255, 6]);
  draw.drawThinRing(flareCenter, 68, [190, 35, 20, 75], 1, 3, 3);
  draw.drawRampedBand(vignetteSegment.lerp(0.38), 48, rgbOnly([175, 95, 35, 45]), -45, 38, 2);
  draw.drawRampedBand(vignetteSegment.lerp(0.35), 28, rgbOnly([120, 55, 15, 55]), -55, 22, 2);
  draw.drawRadialGlow(vignetteSegment.lerp(-0.02), 2, [70, 255, 120, 230]);
  draw.drawRampedBand(vignetteSegment.lerp(-0.48), 58, rgbOnly([165, 95, 30, 48]), -48, 42, 2);
  draw.drawRampedBand(vignetteSegment.lerp(-0.5), 38, rgbOnly([110, 60, 15, 60]), -60, 28, 2);
  draw.drawRadialGlow(vignetteSegment.lerp(-0.47), 3, [80, 255, 200, 200]);
  draw.drawFlatDisc(vignetteSegment.lerp(-0.68), 22, [25, 70, 210, 70], 5);
  draw.drawThinRing(vignetteSegment.lerp(-1.02), 78, [150, 130, 25, 45], 3, 2);
  draw.drawRampedBand(vignetteSegment.lerp(-1.02), 72, rgbOnly([45, 140, 75, 38]), -38, 38);
  draw.drawFlatDisc(vignetteSegment.lerp(-1.22), 155, [90, 120, 45, 14], 10);
  draw.drawRampedBand(vignetteSegment.lerp(-1.22), 140, rgbOnly([70, 100, 35, 12]), -12, 50, 2);
  draw.drawRainbowDisc(vignetteSegment.lerp(-1.26), 130, 10, 42);
  let hueDiscRgba = draw.hueRgbAt(0);
  hueDiscRgba[3] = 32;
  draw.drawRampedBand(vignetteSegment.lerp(-1.26), 134, hueDiscRgba, hueDiscRgba[3], 4);
  hueDiscRgba = draw.hueRgbAt(300);
  hueDiscRgba[3] = 32;
  draw.drawRampedBand(vignetteSegment.lerp(-1.26), 138, rgbOnly(hueDiscRgba), -hueDiscRgba[3], 3);
  draw.drawRadialGlow(vignetteSegment.lerp(-0.74), 18, [15, 45, 220, 85]);
}

/** 35mm Prime (`Nkn`): compact starburst, indigo mid ghost, large green distal ring. */
function renderPresetPrime35(draw, vignetteSegment) {
  const flareCenter = vignetteSegment.lerp(1);
  draw.drawFlatDisc(vignetteSegment.lerp(1.38), 250, [130, 35, 30, 6], 12);
  // Nested full-disc ramps, widest first. Their summed alpha traces one monotonic
  // falloff from the white-hot centre through the crimson aura around the ring at
  // radius 62 and out to a very large, near-neutral glow at ~5.5x that radius.
  draw.drawRampedBand(flareCenter, 340, [190, 182, 210, 32], 32, 340);
  draw.drawRampedBand(flareCenter, 217, [215, 196, 200, 21], 21, 217);
  draw.drawRampedBand(flareCenter, 155, [232, 178, 180, 20], 20, 155);
  draw.drawRampedBand(flareCenter, 112, [246, 132, 132, 54], 54, 112);
  draw.drawRampedBand(flareCenter, 81, [252, 112, 114, 28], 28, 81);
  draw.drawRampedBand(flareCenter, 65, [255, 108, 104, 51], 51, 65);
  draw.drawRampedBand(flareCenter, 46, [255, 186, 176, 112], 112, 46);
  draw.drawRampedBand(flareCenter, 31, [255, 240, 232, 76], 76, 31);
  draw.drawRampedBand(flareCenter, 12, [255, 250, 246, 200], 200, 12);
  draw.drawFlatDisc(flareCenter, 4, [255, 255, 255, 255]);
  draw.drawThinRing(flareCenter, 62, [170, 48, 26, 100], 1, 3, 3);
  // Bundled hairs read as a blurred starburst; lone spokes look drawn on.
  draw.drawStarburstRays(flareCenter, 22, 34, 250, 250, [255, 236, 228, 13], [255, 226, 212, 9], 2.6);
  draw.drawRampedBand(vignetteSegment.lerp(-0.1), 62, rgbOnly([65, 45, 155, 32]), -32, 50, 2);
  draw.drawFlatDisc(vignetteSegment.lerp(-1.02), 205, [40, 135, 85, 32], 20);
  draw.drawRampedBand(vignetteSegment.lerp(-1.02), 188, rgbOnly([25, 100, 65, 20]), -20, 65, 2);
  draw.drawRadialGlow(vignetteSegment.lerp(-0.96), 3, [70, 255, 220, 210]);
  draw.drawRampedBand(vignetteSegment.lerp(-0.93), 7, rgbOnly([245, 185, 195, 28]), -28, 7, 2);
}

/** 105mm Prime (`Nkn1`): cool starburst, brown axis halo, warm and blue tail ghosts. */
function renderPresetPrime105(draw, vignetteSegment) {
  const flareCenter = vignetteSegment.lerp(1);
  draw.drawFlatDisc(vignetteSegment.lerp(1.5), 295, [95, 75, 60, 18], 14);
  // Warm aura: wide and thin, so it reads as haze instead of a disc.
  draw.drawRampedBand(flareCenter, 300, [255, 232, 208, 24], 24, 300);
  draw.drawRampedBand(flareCenter, 175, [255, 238, 218, 30], 30, 175);
  // Bright white aura hugging the source, inside the warm haze.
  draw.drawSoftDiscCore(flareCenter, 64, [255, 252, 248, 185], 185, 58, 1);
  draw.drawSoftDiscCore(flareCenter, 32, [255, 253, 250, 255], 255, 27, 0.6);
  draw.drawFlatDisc(flareCenter, 18, [255, 245, 235, 255]);
  draw.drawFlatDisc(flareCenter, 78, [255, 170, 140, 10], 42);
  draw.drawStarburstRays(
    flareCenter,
    10,
    42,
    340,
    360,
    [255, 248, 240, 34],
    [230, 220, 210, 18],
  );
  draw.drawFlatDisc(vignetteSegment.lerp(1.52), 58, [40, 90, 165, 12]);
  draw.drawRadialGlow(vignetteSegment.lerp(0.58), 4, [255, 175, 35, 130]);
  draw.drawRampedBand(vignetteSegment.lerp(-0.78), 225, rgbOnly([85, 40, 12, 14]), -14, 95, 2);
  draw.drawRampedBand(vignetteSegment.lerp(-0.86), 40, rgbOnly([130, 165, 45, 32]), -32, 24, 2);
  draw.drawRampedBand(vignetteSegment.lerp(-0.9), 30, rgbOnly([105, 140, 38, 28]), -28, 20, 2);
  draw.drawFlatDisc(vignetteSegment.lerp(-1.1), 44, [235, 185, 40, 50], 6);
  draw.drawFlatDisc(vignetteSegment.lerp(-1.16), 20, [255, 245, 190, 75], 4);
  draw.drawRadialGlow(vignetteSegment.lerp(-1.3), 15, [25, 55, 230, 60]);
  draw.drawFlatDisc(vignetteSegment.lerp(-1.32), 11, [255, 255, 215, 85], 3);
}

/** Movie Prime / PanaVision (`PnVs`): anamorphic streaks and sparse teal axis ghosts. */
function renderPresetMoviePrime(draw, vignetteSegment) {
  const flareCenter = vignetteSegment.lerp(1);
  const streakRgba = [95, 175, 255, 210];
  const faintStreakRgba = [95, 175, 255, 120];
  draw.drawFlatDisc(vignetteSegment.lerp(1.22), 170, [115, 30, 18, 22], 10);
  // Red source: a wide warm bloom carrying a small white-hot centre.
  draw.drawRampedBand(flareCenter, 185, [225, 58, 42, 34], 34, 185);
  draw.drawRampedBand(flareCenter, 108, [240, 88, 62, 52], 52, 108);
  draw.drawRampedBand(flareCenter, 58, [252, 150, 120, 64], 64, 58);
  const whiteRgba = [255, 238, 230, 255];
  draw.drawSoftDiscCore(flareCenter, 40, whiteRgba, whiteRgba[3], 36, 0.85);
  draw.drawFlatDisc(flareCenter, 12, [255, 215, 195, 255]);
  draw.drawStarburstRays(flareCenter, 6, 18, 210, 190, [255, 120, 80, 46], [255, 95, 65, 26]);
  draw.drawRampedBand(vignetteSegment.lerp(0.52), 34, rgbOnly([15, 95, 105, 28]), -28, 26, 2);
  draw.drawPerpendicularSoftDisc(vignetteSegment, 0.5, draw.scaleRadius(14), 20, [10, 80, 90, 22], 16);
  draw.drawHorizontalThrough(~~flareCenter.y, streakRgba);
  draw.drawAxisSegmentBetween(vignetteSegment, 1.3, 0.16, streakRgba);
  // The second anamorphic cross lands on the reflection of the source through the
  // frame centre, so it sits in the opposite corner from the flare.
  draw.drawOffsetAxisSegment(vignetteSegment, -0.6, draw.scaleRadius(10), draw.scaleRadius(340), streakRgba);
  draw.drawOffsetAxisSegment(vignetteSegment, -0.72, draw.scaleRadius(-7), draw.scaleRadius(60), faintStreakRgba);
  const lowerStreakAnchor = vignetteSegment.lerp(-1);
  const lowerHalfWidth = draw.scaleRadius(190);
  draw.drawHorizontalSegment(
    ~~(lowerStreakAnchor.x - lowerHalfWidth),
    ~~(lowerStreakAnchor.x + lowerHalfWidth),
    ~~lowerStreakAnchor.y,
    faintStreakRgba,
  );
}

const PRESET_RENDERERS = [
  renderPresetZoom,
  renderPresetPrime35,
  renderPresetPrime105,
  renderPresetMoviePrime,
];

/**
 * Copy source into dest, then paint a lens-flare preset.
 * @param {Uint8Array|Uint8ClampedArray} sourceRgba
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Uint8ClampedArray} destRgba
 * @param {number[]} presetParams [presetIndex, opacity, anchorXNorm, anchorYNorm]
 */
export function renderLensFlare(sourceRgba, width, height, destRgba, presetParams) {
  for (let px = 0; px < sourceRgba.length; px++) {
    destRgba[px] = sourceRgba[px];
  }
  const vignetteSegment = new FlareSegment(width * presetParams[2], height * presetParams[3], width / 2, height / 2);
  const opacityScale = presetParams[1];
  const draw = createFlareDrawer(width, height, destRgba, opacityScale);
  const presetIndex = Math.max(0, Math.min(PRESET_RENDERERS.length - 1, presetParams[0]));
  return PRESET_RENDERERS[presetIndex](draw, vignetteSegment);
}

function buildShadowHighlightMasks(sourceRgba, width, height, shadowLumThreshold, highlightLumThreshold) {
  const pixelCount = width * height;
  const shadowMask = allocBuffer(pixelCount);
  const highlightMask = allocBuffer(pixelCount);
  const luminance = allocBuffer(pixelCount);
  const shadowMaskScale = 255 / shadowLumThreshold;
  const highlightMaskScale = 255 / (255 - highlightLumThreshold);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const pixelIdx = row * width + col;
      const rgbaOff = pixelIdx << 2;
      const lum = luminanceFromRgb(sourceRgba[rgbaOff], sourceRgba[rgbaOff + 1], sourceRgba[rgbaOff + 2]);
      luminance[pixelIdx] = lum;
      if (lum < shadowLumThreshold) {
        shadowMask[pixelIdx] = 255 - lum * shadowMaskScale;
      }
      if (lum > highlightLumThreshold) {
        highlightMask[pixelIdx] = 255 - (255 - lum) * highlightMaskScale;
      }
    }
  }
  return { shadowMask, highlightMask, luminance };
}

function blurShadowHighlightMasks(shadowMask, highlightMask, width, height, shadowAmount, shadowBlurRadius, highlightAmount, highlightBlurRadius) {
  const blurScratch = allocBuffer(width * height);
  if (shadowAmount * shadowBlurRadius > 0) {
    blurScratch.set(shadowMask);
    gaussianBlurRgba(blurScratch, shadowMask, new Rect(0, 0, width, height), shadowBlurRadius);
  }
  if (highlightAmount * highlightBlurRadius > 0) {
    blurScratch.set(highlightMask);
    gaussianBlurRgba(blurScratch, highlightMask, new Rect(0, 0, width, height), highlightBlurRadius);
  }
}

function buildToneAndChromaLuts(shadowGamma, highlightGamma, chromaRadiusScale) {
  const shadowToneLut = allocBuffer(256);
  const highlightToneLut = allocBuffer(256);
  for (let lutIdx = 0; lutIdx < 256; lutIdx++) {
    const normLum = lutIdx * (1 / 255);
    let mapped = (1 - Math.pow(1 - normLum, shadowGamma)) * 255;
    shadowToneLut[lutIdx] = Math.max(0, Math.min(255, ~~(mapped + 0.5)));
    mapped = Math.pow(normLum, highlightGamma) * 255;
    highlightToneLut[lutIdx] = Math.max(0, Math.min(255, ~~(mapped + 0.5)));
  }
  const chromaRadiusLut = new Float32Array(CHROMA_RADIUS_LUT_SIZE);
  for (let lutIdx = 0; lutIdx < CHROMA_RADIUS_LUT_SIZE; lutIdx++) {
    let chromaLookup = Math.sqrt(lutIdx) * (1 / 128);
    if (chromaRadiusScale > 1) {
      chromaLookup = (1 - chromaLookup) * (chromaRadiusScale - 1) + 1;
    } else {
      chromaLookup = chromaLookup * (chromaRadiusScale - 1) + 1;
    }
    chromaRadiusLut[lutIdx] = chromaLookup;
  }
  return { shadowToneLut, highlightToneLut, chromaRadiusLut };
}

function applyShadowHighlightPixels(sourceRgba, destRgba, width, height, luminance, shadowMask, highlightMask, shadowToneLut, highlightToneLut, chromaRadiusLut) {
  const destPixels = new Uint8ClampedArray(destRgba.buffer);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const pixelIdx = row * width + col;
      const rgbaOff = pixelIdx << 2;
      let toneLum = luminance[pixelIdx];
      const shadowBlend = shadowMask[pixelIdx] * (1 / 255);
      const highlightBlend = highlightMask[pixelIdx] * (1 / 255);
      toneLum = (1 - shadowBlend) * toneLum + shadowBlend * shadowToneLut[~~toneLum];
      toneLum = (1 - highlightBlend) * toneLum + highlightBlend * highlightToneLut[~~toneLum];
      const lum = toneLum;
      const srcR = sourceRgba[rgbaOff];
      const srcG = sourceRgba[rgbaOff + 1];
      const srcB = sourceRgba[rgbaOff + 2];
      let chromaB = -srcR * 0.168736 - srcG * 0.331264 + srcB * 0.5;
      let chromaR = srcR * 0.5 - srcG * 0.418688 - srcB * 0.081312;
      const chromaLookup = chromaRadiusLut[~~(0.5 + chromaB * chromaB + chromaR * chromaR)];
      const scaledChromaB = chromaB * chromaLookup;
      const scaledChromaR = chromaR * chromaLookup;
      const chromaPreserve = 1 - Math.min(2 - (shadowBlend + highlightBlend), 1);
      chromaB = chromaPreserve * chromaB + (1 - chromaPreserve) * scaledChromaB;
      chromaR = chromaPreserve * chromaR + (1 - chromaPreserve) * scaledChromaR;
      const outR = lum + 1.402 * chromaR;
      const outG = lum - 0.34414 * chromaB - 0.71414 * chromaR;
      const outB = lum + 1.772 * chromaB;
      destPixels[rgbaOff] = ~~(0.5 + outR);
      destPixels[rgbaOff + 1] = ~~(0.5 + outG);
      destPixels[rgbaOff + 2] = ~~(0.5 + outB);
    }
  }
}

/**
 * Shadow / highlight recovery with optional chroma radius correction.
 * {@code contrast} is accepted for descriptor wiring but unused by this path.
 */
export function applyShadowHighlightCorrection(
  sourceRgba,
  destRgba,
  width,
  height,
  shadowAmount,
  shadowWidth,
  shadowRadius,
  highlightAmount,
  highlightWidth,
  highlightRadius,
  colorCorrection,
  _contrast,
) {
  const shadowBlurRadius = shadowRadius;
  const highlightBlurRadius = highlightRadius;
  const shadowLumThreshold = shadowWidth * 255;
  const highlightLumThreshold = 255 - highlightWidth * 255;
  const shadowGamma = 1 + shadowAmount * 6;
  const highlightGamma = 1 + highlightAmount * 6;
  const chromaRadiusScale = 1 + colorCorrection;
  const { shadowMask, highlightMask, luminance } = buildShadowHighlightMasks(
    sourceRgba,
    width,
    height,
    shadowLumThreshold,
    highlightLumThreshold,
  );
  blurShadowHighlightMasks(
    shadowMask,
    highlightMask,
    width,
    height,
    shadowAmount,
    shadowBlurRadius,
    highlightAmount,
    highlightBlurRadius,
  );
  const { shadowToneLut, highlightToneLut, chromaRadiusLut } = buildToneAndChromaLuts(
    shadowGamma,
    highlightGamma,
    chromaRadiusScale,
  );
  applyShadowHighlightPixels(
    sourceRgba,
    destRgba,
    width,
    height,
    luminance,
    shadowMask,
    highlightMask,
    shadowToneLut,
    highlightToneLut,
    chromaRadiusLut,
  );
}

