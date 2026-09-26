#!/usr/bin/env node
// Converts the Font Awesome Free SVG icons vendored as a submodule at
// src/vendor/fontawesome into src/resources/libraries/shapes.csh. Only
// the `solid` and `regular` style directories are used — `brands` icons are
// third-party trademarks (excluded from Font Awesome's own CC BY 4.0 grant
// for redistribution as generic shapes) and must never be bundled here.
//
// Each icon's SVG <path> is converted directly into Photoshop-style path-knot
// records (the same wire format PathRecordCodec/ShapeFile already read and
// write), preserving the original bezier curves rather than flattening to a
// polygon approximation. Multiple subpaths (e.g. icons with a hole, like
// "circle") are chained with fillRule -1 on every subpath after the first, so
// the shared canvas fill call in selection-utils.js's traceSubpathOnContext
// combines them into one evenodd fill and the hole renders correctly
// regardless of each contour's winding direction — see the fill deferral
// check there (`pathRecords[recIdx + 1 + knotCount].fillRule != -1`).
//
// Invoked by build.sh; re-run that after bumping the submodule pin.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { installBrowserGlobals } from "../../../../tests/helpers/stub-browser-globals.js";
installBrowserGlobals();

const { ShapeFile } = await import("../../../features/shape/shape-file.js");
const { Rect } = await import("../../../core/math/rect.js");
const { Point } = await import("../../../core/math/point.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../..");
const FA_SVG_ROOT = path.join(ROOT, "src/vendor/fontawesome/svgs");
const OUT_FILE = path.join(ROOT, "src/resources/libraries/shapes.csh");

// Excludes `brands`: those are third-party company logos/trademarks, not
// covered by the CC BY 4.0 grant that applies to the generic solid/regular
// icon glyphs, and not appropriate to ship as generic shape presets.
const STYLES = [
  { dir: "solid", suffix: "(solid)" },
  { dir: "regular", suffix: "(regular)" },
];

// ---- SVG path `d` parsing --------------------------------------------------

function tokenizePathData(d) {
  const tokens = [];
  let i = 0;
  const n = d.length;
  while (i < n) {
    const ch = d[i];
    if (/[A-Za-z]/.test(ch)) {
      tokens.push({ cmd: ch });
      i++;
    } else if (ch === "," || /\s/.test(ch)) {
      i++;
    } else {
      const start = i;
      if (d[i] === "+" || d[i] === "-") i++;
      while (i < n && /[0-9]/.test(d[i])) i++;
      if (d[i] === ".") {
        i++;
        while (i < n && /[0-9]/.test(d[i])) i++;
      }
      if (d[i] === "e" || d[i] === "E") {
        i++;
        if (d[i] === "+" || d[i] === "-") i++;
        while (i < n && /[0-9]/.test(d[i])) i++;
      }
      tokens.push({ num: parseFloat(d.slice(start, i)) });
    }
  }
  return tokens;
}

/** Convert an SVG elliptical arc segment into a list of cubic bezier segments. */
function arcToCubicSegments(x1, y1, rx, ry, xAxisRotationDeg, largeArcFlag, sweepFlag, x2, y2) {
  if (rx === 0 || ry === 0) return [{ c1x: x1, c1y: y1, c2x: x2, c2y: y2, x: x2, y: y2 }];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (xAxisRotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  let rxSq = rx * rx;
  let rySq = ry * ry;
  const x1pSq = x1p * x1p;
  const y1pSq = y1p * y1p;
  const radiiCheck = x1pSq / rxSq + y1pSq / rySq;
  if (radiiCheck > 1) {
    const scale = Math.sqrt(radiiCheck);
    rx *= scale;
    ry *= scale;
    rxSq = rx * rx;
    rySq = ry * ry;
  }

  const sign = largeArcFlag !== sweepFlag ? 1 : -1;
  let sq = (rxSq * rySq - rxSq * y1pSq - rySq * x1pSq) / (rxSq * y1pSq + rySq * x1pSq);
  sq = sq < 0 ? 0 : sq;
  const coef = sign * Math.sqrt(sq);
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (coef * -(ry * x1p)) / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  function angle(ux, uy, vx, vy) {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt(ux * ux + uy * uy) * Math.sqrt(vx * vx + vy * vy);
    let ang = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) ang = -ang;
    return ang;
  }

  const startVecX = (x1p - cxp) / rx;
  const startVecY = (y1p - cyp) / ry;
  const endVecX = (-x1p - cxp) / rx;
  const endVecY = (-y1p - cyp) / ry;

  const startAngle = angle(1, 0, startVecX, startVecY);
  let deltaAngle = angle(startVecX, startVecY, endVecX, endVecY);
  if (!sweepFlag && deltaAngle > 0) deltaAngle -= 2 * Math.PI;
  if (sweepFlag && deltaAngle < 0) deltaAngle += 2 * Math.PI;

  const segmentCount = Math.max(1, Math.ceil(Math.abs(deltaAngle) / (Math.PI / 2)));
  const segAngle = deltaAngle / segmentCount;
  const alpha = (4 / 3) * Math.tan(segAngle / 4);

  const segments = [];
  let theta = startAngle;
  for (let segIdx = 0; segIdx < segmentCount; segIdx++) {
    const theta2 = theta + segAngle;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const cosT2 = Math.cos(theta2);
    const sinT2 = Math.sin(theta2);

    // Point + tangent at theta, theta2 on the unit circle, then ellipse+rotate+translate.
    function ellipsePoint(cosA, sinA) {
      const ex = rx * cosA;
      const ey = ry * sinA;
      return { x: cosPhi * ex - sinPhi * ey + cx, y: sinPhi * ex + cosPhi * ey + cy };
    }
    function ellipseTangent(cosA, sinA) {
      const ex = -rx * sinA;
      const ey = ry * cosA;
      return { x: cosPhi * ex - sinPhi * ey, y: sinPhi * ex + cosPhi * ey };
    }

    const p1 = ellipsePoint(cosT, sinT);
    const p2 = ellipsePoint(cosT2, sinT2);
    const t1 = ellipseTangent(cosT, sinT);
    const t2 = ellipseTangent(cosT2, sinT2);

    segments.push({
      c1x: p1.x + alpha * t1.x,
      c1y: p1.y + alpha * t1.y,
      c2x: p2.x - alpha * t2.x,
      c2y: p2.y - alpha * t2.y,
      x: p2.x,
      y: p2.y,
    });
    theta = theta2;
  }
  return segments;
}

/**
 * Parse an SVG path `d` string into subpaths of knots:
 * `{ cp1: {x,y}, anchor: {x,y}, anchorOut: {x,y} }[][]`.
 * Each returned subpath is closed and cyclic (no duplicated closing point).
 */
function parsePathToSubpaths(d) {
  const tokens = tokenizePathData(d);
  const subpaths = [];
  let cur = null; // current open subpath: array of knots being built
  let curX = 0, curY = 0;
  let startX = 0, startY = 0;
  let lastCmd = "";
  let lastCubicC2X = 0, lastCubicC2Y = 0;
  let lastQuadCX = 0, lastQuadCY = 0;

  function readNum(ti) {
    return tokens[ti].num;
  }

  function pushLineVertex(x, y) {
    cur.push({ cp1: { x, y }, anchor: { x, y }, anchorOut: { x, y } });
    curX = x;
    curY = y;
  }

  /** Set the outgoing handle of the last knot and start a new knot's incoming handle. */
  function pushCurveVertex(c1x, c1y, c2x, c2y, x, y) {
    if (cur.length > 0) {
      cur[cur.length - 1].anchorOut = { x: c1x, y: c1y };
    }
    cur.push({ cp1: { x: c2x, y: c2y }, anchor: { x, y }, anchorOut: { x, y } });
    curX = x;
    curY = y;
  }

  function closeCurrentSubpath() {
    if (cur == null || cur.length === 0) return;
    // If the path explicitly re-drew the start point right before Z, drop the
    // duplicate — the knot list is cyclic, so the loop closes implicitly.
    const first = cur[0];
    const last = cur[cur.length - 1];
    if (cur.length > 1 && Math.abs(last.anchor.x - first.anchor.x) < 1e-6 && Math.abs(last.anchor.y - first.anchor.y) < 1e-6) {
      first.cp1 = last.cp1;
      cur.pop();
    }
    subpaths.push(cur);
    cur = null;
  }

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.cmd == null) throw new Error("expected command, got number at token " + i);
    let cmd = tok.cmd;
    i++;

    // Implicit repeat: extra coordinate groups after M behave as L (or m as l).
    const isRelative = cmd === cmd.toLowerCase();
    const upper = cmd.toUpperCase();

    if (upper === "M") {
      closeCurrentSubpath();
      let x = readNum(i++), y = readNum(i++);
      if (isRelative) { x += curX; y += curY; }
      cur = [];
      curX = x; curY = y; startX = x; startY = y;
      cur.push({ cp1: { x, y }, anchor: { x, y }, anchorOut: { x, y } });
      lastCmd = "M";
      // Subsequent bare coordinate pairs are implicit lineto.
      while (i < tokens.length && tokens[i].num !== undefined) {
        let lx = readNum(i++), ly = readNum(i++);
        if (isRelative) { lx += curX; ly += curY; }
        pushLineVertex(lx, ly);
        lastCmd = "L";
      }
    } else if (upper === "L") {
      while (i < tokens.length && tokens[i].num !== undefined) {
        let x = readNum(i++), y = readNum(i++);
        if (isRelative) { x += curX; y += curY; }
        pushLineVertex(x, y);
      }
      lastCmd = "L";
    } else if (upper === "H") {
      while (i < tokens.length && tokens[i].num !== undefined) {
        let x = readNum(i++);
        if (isRelative) x += curX;
        pushLineVertex(x, curY);
      }
      lastCmd = "H";
    } else if (upper === "V") {
      while (i < tokens.length && tokens[i].num !== undefined) {
        let y = readNum(i++);
        if (isRelative) y += curY;
        pushLineVertex(curX, y);
      }
      lastCmd = "V";
    } else if (upper === "C") {
      while (i < tokens.length && tokens[i].num !== undefined) {
        let c1x = readNum(i++), c1y = readNum(i++);
        let c2x = readNum(i++), c2y = readNum(i++);
        let x = readNum(i++), y = readNum(i++);
        if (isRelative) { c1x += curX; c1y += curY; c2x += curX; c2y += curY; x += curX; y += curY; }
        pushCurveVertex(c1x, c1y, c2x, c2y, x, y);
        lastCubicC2X = c2x; lastCubicC2Y = c2y;
      }
      lastCmd = "C";
    } else if (upper === "S") {
      while (i < tokens.length && tokens[i].num !== undefined) {
        let c2x = readNum(i++), c2y = readNum(i++);
        let x = readNum(i++), y = readNum(i++);
        if (isRelative) { c2x += curX; c2y += curY; x += curX; y += curY; }
        const reflected = lastCmd === "C" || lastCmd === "S"
          ? { x: 2 * curX - lastCubicC2X, y: 2 * curY - lastCubicC2Y }
          : { x: curX, y: curY };
        pushCurveVertex(reflected.x, reflected.y, c2x, c2y, x, y);
        lastCubicC2X = c2x; lastCubicC2Y = c2y;
        lastCmd = "S";
      }
    } else if (upper === "Q") {
      while (i < tokens.length && tokens[i].num !== undefined) {
        let qx = readNum(i++), qy = readNum(i++);
        let x = readNum(i++), y = readNum(i++);
        if (isRelative) { qx += curX; qy += curY; x += curX; y += curY; }
        // Elevate quadratic -> cubic.
        const c1x = curX + (2 / 3) * (qx - curX), c1y = curY + (2 / 3) * (qy - curY);
        const c2x = x + (2 / 3) * (qx - x), c2y = y + (2 / 3) * (qy - y);
        pushCurveVertex(c1x, c1y, c2x, c2y, x, y);
        lastQuadCX = qx; lastQuadCY = qy;
        lastCmd = "Q";
      }
    } else if (upper === "T") {
      while (i < tokens.length && tokens[i].num !== undefined) {
        let x = readNum(i++), y = readNum(i++);
        if (isRelative) { x += curX; y += curY; }
        const reflected = lastCmd === "Q" || lastCmd === "T"
          ? { x: 2 * curX - lastQuadCX, y: 2 * curY - lastQuadCY }
          : { x: curX, y: curY };
        const qx = reflected.x, qy = reflected.y;
        const c1x = curX + (2 / 3) * (qx - curX), c1y = curY + (2 / 3) * (qy - curY);
        const c2x = x + (2 / 3) * (qx - x), c2y = y + (2 / 3) * (qy - y);
        pushCurveVertex(c1x, c1y, c2x, c2y, x, y);
        lastQuadCX = qx; lastQuadCY = qy;
        lastCmd = "T";
      }
    } else if (upper === "A") {
      while (i < tokens.length && tokens[i].num !== undefined) {
        const rx = readNum(i++), ry = readNum(i++);
        const rot = readNum(i++);
        const largeArc = readNum(i++) !== 0;
        const sweep = readNum(i++) !== 0;
        let x = readNum(i++), y = readNum(i++);
        if (isRelative) { x += curX; y += curY; }
        const segs = arcToCubicSegments(curX, curY, rx, ry, rot, largeArc, sweep, x, y);
        for (const seg of segs) {
          pushCurveVertex(seg.c1x, seg.c1y, seg.c2x, seg.c2y, seg.x, seg.y);
        }
      }
      lastCmd = "A";
    } else if (upper === "Z") {
      if (cur != null) {
        // Close back to the subpath start with a straight edge if not already there.
        if (Math.abs(curX - startX) > 1e-6 || Math.abs(curY - startY) > 1e-6) {
          pushLineVertex(startX, startY);
        }
      }
      closeCurrentSubpath();
      lastCmd = "Z";
    } else {
      throw new Error("unsupported path command: " + cmd);
    }
  }
  closeCurrentSubpath();
  return subpaths;
}

// ---- ShapeFile record building ---------------------------------------------

/**
 * The box the glyph's knots occupy, handles included.
 * @param {{cp1: object, anchor: object, anchorOut: object}[][]} subpaths
 */
function measureSubpathBounds(subpaths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const knots of subpaths) {
    for (const knot of knots) {
      for (const point of [knot.cp1, knot.anchor, knot.anchorOut]) {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.y > maxY) maxY = point.y;
      }
    }
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Scale the glyph into the unit square, in place.
 *
 * A `.csh` knot coordinate is 8.24 fixed point, so it holds about ±128 — while
 * a Font Awesome icon is drawn in a 512-unit viewBox. Writing those raw
 * overflowed the field and wrapped: 256 came back as 0, 397.4 as -114.6, and
 * every icon in the library came out as scribble. The format expects 0..1
 * coordinates with the design box carrying the proportions, which is also what
 * `ShapeFile.parse` re-derives on read.
 *
 * Scaling by the glyph's own bounds rather than the viewBox keeps that
 * re-derivation a no-op, so the proportions the design box records are the
 * proportions the shape is drawn at.
 */
function normalizeSubpathsToUnitSquare(subpaths, bounds) {
  const scaleX = bounds.width > 0 ? 1 / bounds.width : 1;
  const scaleY = bounds.height > 0 ? 1 / bounds.height : 1;
  for (const knots of subpaths) {
    for (const knot of knots) {
      for (const point of [knot.cp1, knot.anchor, knot.anchorOut]) {
        point.x = (point.x - bounds.x) * scaleX;
        point.y = (point.y - bounds.y) * scaleY;
      }
    }
  }
}

function buildShapePathRecords(subpaths) {
  const pathRecords = [{ type: 6 }, { type: 8, all: 0 }];
  for (const knots of subpaths) {
    if (knots.length < 2) continue;
    pathRecords.push({
      type: 0, // closed subpath
      fillRule: 1, // corrected for real by fixupFillRules() below
      length: knots.length,
      subpathUint32A: 0,
      subpathUint32B: 0,
      subpathHeaderFlags: 1,
    });
    for (const knot of knots) {
      pathRecords.push({
        type: 1, // closed-subpath knot
        cp1: new Point(knot.cp1.x, knot.cp1.y),
        anchor: new Point(knot.anchor.x, knot.anchor.y),
        anchorOut: new Point(knot.anchorOut.x, knot.anchorOut.y),
      });
    }
  }
  return pathRecords;
}

/** First subpath fillRule = 1 (starts the fill); every later one = -1 so it
 * chains into the same deferred fill (see file header comment). */
function fixupFillRules(pathRecords) {
  let seenFirst = false;
  for (const rec of pathRecords) {
    if (rec.type === 0 || rec.type === 3) {
      rec.fillRule = seenFirst ? -1 : 1;
      seenFirst = true;
    }
  }
}

function svgFileToShapeEntries(filePath, labelSuffix) {
  const src = fs.readFileSync(filePath, "utf8");
  const pathMatches = [...src.matchAll(/<path[^>]*\sd="([^"]+)"/g)];
  if (pathMatches.length === 0) return null;

  const allSubpaths = [];
  for (const m of pathMatches) {
    allSubpaths.push(...parsePathToSubpaths(m[1]));
  }
  if (allSubpaths.length === 0) return null;

  // The design box is the glyph's own box, not the viewBox: an icon rarely
  // fills its viewBox, and this is what tells the app the shape's proportions
  // once the knots below are flattened into the unit square.
  const designBounds = measureSubpathBounds(allSubpaths);
  if (!(designBounds.width > 0) || !(designBounds.height > 0)) return null;
  normalizeSubpathsToUnitSquare(allSubpaths, designBounds);

  const pathRecords = buildShapePathRecords(allSubpaths);
  fixupFillRules(pathRecords);

  const iconName = path.basename(filePath, ".svg");
  return {
    categoryName: `${iconName} ${labelSuffix}`,
    shapeName: crypto.randomUUID(),
    pathRecords,
    boundsRect: new Rect(0, 0, designBounds.width, designBounds.height),
  };
}

// ---- Main -------------------------------------------------------------------

const shapes = [];
let failed = 0;
for (const style of STYLES) {
  const dir = path.join(FA_SVG_ROOT, style.dir);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".svg")).sort();
  for (const file of files) {
    try {
      const entry = svgFileToShapeEntries(path.join(dir, file), style.suffix);
      if (entry) shapes.push(entry);
    } catch (err) {
      failed++;
      console.error(`  ! ${style.dir}/${file}: ${err.message}`);
    }
  }
}

console.log(`Built ${shapes.length} shape entries (${failed} failed).`);

const bytes = Buffer.from(ShapeFile.serialize(shapes));
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, bytes);
console.log(`Wrote ${OUT_FILE} (${bytes.length} bytes).`);

// Round-trip sanity check. Counting shapes is not enough: a knot coordinate
// outside the 8.24 fixed-point range wraps silently, which is how a whole
// library of scribble shipped once already. Compare the geometry itself.
const reparsed = ShapeFile.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
console.log(`Round-trip parsed ${reparsed.length} shapes.`);
if (reparsed.length !== shapes.length) {
  console.error("MISMATCH between built and reparsed shape counts!");
  process.exitCode = 1;
}

const COORD_LIMIT = 128; // 8.24 fixed point holds roughly +/-128.
let outOfRange = 0;
let geometryDrift = 0;
for (let shapeIdx = 0; shapeIdx < shapes.length; shapeIdx++) {
  const builtKnots = shapes[shapeIdx].pathRecords.filter((rec) => rec.anchor);
  const readKnots = reparsed[shapeIdx].pathRecords.filter((rec) => rec.anchor);
  if (builtKnots.length !== readKnots.length) {
    geometryDrift++;
    continue;
  }
  for (let knotIdx = 0; knotIdx < builtKnots.length; knotIdx++) {
    const built = builtKnots[knotIdx].anchor;
    const read = readKnots[knotIdx].anchor;
    if (Math.abs(built.x) >= COORD_LIMIT || Math.abs(built.y) >= COORD_LIMIT) outOfRange++;
    if (Math.abs(built.x - read.x) > 1e-3 || Math.abs(built.y - read.y) > 1e-3) {
      geometryDrift++;
      break;
    }
  }
}
console.log(`Coordinates outside the encodable range: ${outOfRange}. Shapes that did not survive the round trip: ${geometryDrift}.`);
if (outOfRange !== 0 || geometryDrift !== 0) {
  console.error("Geometry did not survive serialization — the library would ship distorted.");
  process.exitCode = 1;
}
