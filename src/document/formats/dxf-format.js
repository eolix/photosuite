/**
 * DXF (AutoCAD Drawing Interchange) read and write.
 *
 * `FromDXF.Parse(buffer, writer)` parses ASCII DXF, measures the drawing, fits
 * it onto a page, and drives the document writer interface (`StartPage`, `Stroke`,
 * `Fill`, `PutText`, `ShowPage`, `Done`) consumed by {@link VectorPageBuilder}
 * and PDF export. Geometry uses the global UDOC path/matrix helpers (`UDOC.G`,
 * `UDOC.M`).
 */

// Group codes whose value is a number rather than a string.
const NUMERIC_CODES = [
  10, 11, 12, 13, 14, 20, 21, 22, 23, 24, 30, 31, 32, 33, 34,
  40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53,
  62, 70, 71, 72, 73, 74, 90, 370,
];

// AutoCAD Color Index -> RGB (the subset the source supported).
const ACI_COLORS = {
  c0: [0, 0, 0], c1: [1, 0, 0], c2: [1, 1, 0], c4: [0, 1, 1], c5: [0, 0, 1],
  c7: [0, 0, 0], c8: [0, 0, 0], c242: [0.64, 0, 0.16], c250: [0, 0, 0],
};

const PAGE_WIDTH = 2000;
const PAGE_MARGIN = 100;

// First-pass writer: records the extent of all geometry so Parse can compute the page
// transform. Every drawing call just grows the bounding box; nothing is emitted.
class BoundsProbe {
  constructor() { this.bb = [1e9, 1e9, -1e9, -1e9]; }
  StartPage() {}
  PutImage() {}
  ShowPage() {}
  Done() {}
  Stroke(gst) { this._extend(gst.pth.crds); }
  Fill(gst) { this._extend(gst.pth.crds); }
  PutText(gst, text, width, box) {
    const quad = [0, 0, width * gst.font.Tfs, 0, 0, -gst.font.Tfs, 0, gst.font.Tfs];
    if (box) { quad[2] = box[0]; quad[5] = -box[1]; }
    UDOC.M.multArray(gst.ctm, quad);
    UDOC.M.multArray(gst.font.Tm, quad);
    this._extend(quad);
  }
  _extend(coords) {
    const bb = this.bb;
    for (let i = 0; i < coords.length; i += 2) {
      const x = coords[i], y = coords[i + 1];
      bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y);
      bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y);
    }
  }
}

// Expand MTEXT/TEXT inline formatting into plain text.
function decodeMText(text, gst) {
  if (text.startsWith("%%u")) { text = text.slice(3); gst.font.Tun = 1; }
  text = text.split("\\P").join("\n");
  text = text.split("%%d").join("'");
  text = text.split("{").join("");
  text = text.split("}").join("");
  while (true) {
    const at = text.indexOf("\\U+");
    if (at === -1) break;
    text = text.slice(0, at) + String.fromCharCode(parseInt(text.slice(at + 3, at + 7), 16)) + text.slice(at + 7);
  }
  while (true) {
    const open = text.indexOf("\\"), close = text.indexOf(";");
    if (open === -1 || close === -1) break;
    let code = text.slice(open + 1, close);
    if (code.startsWith("pi")) code = " ".repeat(0.5 * parseFloat(code.slice(2)));
    else code = "";
    text = text.slice(0, open) + code + text.slice(close + 1);
  }
  return text;
}

// Cox-de Boor basis function for a B-spline (degree `deg`, knot vector `knots`).
function splineBasis(i, deg, knots, t) {
  const n = new Float64Array(deg + 1);
  let saved, term;
  const last = knots.Length - 1;
  if ((i === 0 && t === knots[0]) || (i === last - deg - 1 && t === knots[last])) return 1;
  if (t < knots[i] || t >= knots[i + deg + 1]) return 0;
  for (let j = 0; j <= deg; j++) n[j] = (t >= knots[i + j] && t < knots[i + j + 1]) ? 1 : 0;
  for (let k = 1; k <= deg; k++) {
    saved = n[0] === 0 ? 0 : (t - knots[i]) * n[0] / (knots[i + k] - knots[i]);
    for (let j = 0; j < deg - k + 1; j++) {
      const left = knots[i + j + 1], right = knots[i + j + k + 1];
      if (n[j + 1] === 0) { n[j] = saved; saved = 0; }
      else { term = n[j + 1] / (right - left); n[j] = saved + (right - t) * term; saved = (t - left) * term; }
    }
  }
  return n[0];
}

// Evaluate a B-spline point at parameter t from control points (xs, ys).
function splinePoint(xs, ys, deg, knots, t) {
  let x = 0, y = 0;
  for (let i = 0; i < xs.length; i++) {
    const b = splineBasis(i, deg, knots, t);
    x += xs[i] * b; y += ys[i] * b;
  }
  return [x, y];
}

// Parse a run of DXF records [start, end) into writer calls. Recurses for INSERT blocks.
function parseEntities(lines, writer, gst, ctx, start, end, section) {
  let entity, fields, accum;
  let i = start;
  while (i < end) {
    const code = parseInt(lines[i++]);
    let value = lines[i++];
    const numeric = NUMERIC_CODES.indexOf(code) !== -1;
    const multi =
      (entity === "LWPOLYLINE" && (code === 10 || code === 20 || code === 30)) ||
      (entity === "LTYPE" && code === 49) ||
      (entity === "SPLINE" && (code === 10 || code === 20 || code === 30 || code === 40)) ||
      (entity === "OLE2FRAME" && code === 310);
    if (numeric) value = parseFloat(value);

    if (code === 999) { /* comment */ }
    else if (value === "SECTION") section = -1;
    else if (value === "ENDSEC") { /* end of section */ }
    else if (section === -1) section = value;
    else if (value === "EOF") { /* end of file */ }
    else if (section === "HEADER" || section === "CLASSES") { /* ignored */ }
    else if (section === "TABLES" || section === "BLOCKS") {
      if (code === 0) { entity = value; fields = {}; continue; }
      if (multi) (fields[code] = fields[code] || []).push(value);
      else fields[code] = value;
      if (lines[i] !== "0") continue;
      if (entity === "LTYPE") {
        if (ctx.tabs[entity][fields[2]] != null) throw "dxf: duplicate tab entry for entity field";
        ctx.tabs[entity][fields[2]] = fields;
      } else if (entity === "BLOCK") {
        accum = ctx.blocks[fields[2]] = [i];
      } else if (entity === "ENDBLK") {
        accum[1] = i - 2;
        accum = null;
      }
    }
    else if (section === "ENTITIES") {
      if (code === 0) { entity = value; fields = {}; }
      else if (multi) (fields[code] = fields[code] || []).push(value);
      else fields[code] = value;
      if (lines[i] !== "0") continue;

      // At an entity boundary (not mid POLYLINE/VERTEX run), set up its graphics
      // state — colour, line type / dash — and begin a fresh path.
      if (accum == null) {
        gst.colr = [0, 0, 0]; gst.ca = 1; gst.COLR = [0, 0, 0]; gst.dash = [];
        if (fields[62] != null && fields[62] != 256) {
          const col = ACI_COLORS["c" + fields[62]];
          if (col) gst.COLR = col;
          else { gst.COLR = [0, 1, 0]; console.log(entity + " " + fields[62]); }
        }
        if (fields[6] != null) {
          const lt = ctx.tabs.LTYPE[fields[6]];
          if (lt[49] != null) {
            const dash = lt[49].slice(0);
            for (let k = 0; k < dash.length; k++) dash[k] = Math.abs(dash[k]) * (fields[48] ? fields[48] : 1);
            gst.dash = dash;
          }
        }
        if (fields[8] === "H") gst.dash = [0.1, 0.02];
        UDOC.G.newPath(gst);
      }

      // Small parallax offset applied to z-bearing coordinates, matching the source.
      const zo = -1 / 3.17;
      if (entity === "LINE") {
        const b = (fields[30] ? fields[30] : 0) * zo, j = (fields[31] ? fields[31] : 0) * zo;
        UDOC.G.moveTo(gst, fields[10] + b, fields[20] - b);
        UDOC.G.lineTo(gst, fields[11] + j, fields[21] - j);
        writer.Stroke(gst, false);
      } else if (entity === "POLYLINE") {
        accum = [fields, []];
      } else if (entity === "VERTEX") {
        accum[1].push(fields);
      } else if (entity === "SEQEND") {
        if (accum == null) continue;
        const head = accum[0], verts = accum[1], count = verts.length;
        const total = head[70] == 1 ? count + 1 : count;
        UDOC.G.moveTo(gst, verts[0][10], verts[0][20]);
        for (let k = 1; k < total; k++) {
          const x = verts[k % count][10], y = verts[k % count][20];
          let bulge = verts[k - 1][42];
          if (bulge == null) bulge = 0;
          if (bulge === 0) UDOC.G.lineTo(gst, x, y);
          else {
            const prev = verts[k - 1], px = prev[10], py = prev[20];
            const dx = x - px, dy = y - py;
            const ang = -bulge * Math.PI / 2, k0 = 0.42;
            const sin = Math.sin(ang), cos = Math.cos(ang);
            const c1x = cos * dx - sin * dy, c1y = sin * dx + cos * dy;
            const c2x = cos * dx + sin * dy, c2y = -sin * dx + cos * dy;
            UDOC.G.curveTo(gst, px + k0 * c1x, py + k0 * c1y, x - k0 * c2x, y - k0 * c2y, x, y);
          }
        }
        writer.Stroke(gst, false);
        accum = null;
      } else if (entity === "OLE2FRAME") {
        const H = 57, W = 295, hex = fields[310].join(""), pixels = W * H;
        const raw = new Uint8Array(hex.length >>> 1);
        for (let k = 0; k < raw.length; k++) raw[k] = parseInt(hex.slice(k * 2, k * 2 + 2), 16);
        const rgba = new Uint8Array(pixels * 4);
        new Uint32Array(rgba.buffer).fill(4281563135);
        const savedCtm = gst.ctm, m = [1, 0, 0, 1, 0, 0];
        UDOC.M.scale(m, fields[11] - fields[10], fields[21] - fields[20]);
        UDOC.M.translate(m, fields[10], fields[20]);
        UDOC.M.concat(m, gst.ctm);
        gst.ctm = m;
        writer.PutImage(gst, rgba, W, H);
        gst.ctm = savedCtm;
      } else if (entity === "INSERT") {
        const block = ctx.blocks[fields[2]], savedCtm = gst.ctm.slice(0), m = [1, 0, 0, 1, 0, 0];
        if (fields[50] != null) UDOC.M.rotate(m, fields[50] * Math.PI / 180);
        if (fields[41] != null) UDOC.M.scale(m, fields[41], fields[42]);
        UDOC.M.translate(m, fields[10], fields[20]);
        UDOC.M.concat(m, gst.ctm);
        gst.ctm = m;
        parseEntities(lines, writer, gst, ctx, block[0], block[1], section);
        gst.ctm = savedCtm;
      } else if (entity === "3DFACE" || entity === "SOLID") {
        const b = fields[30] * zo, j = fields[31] * zo, c = fields[32] * zo, d = fields[33] * zo;
        UDOC.G.moveTo(gst, fields[10] + b, fields[20] - b);
        UDOC.G.lineTo(gst, fields[11] + j, fields[21] - j);
        UDOC.G.lineTo(gst, fields[12] + c, fields[22] - c);
        UDOC.G.lineTo(gst, fields[13] + d, fields[23] - d);
        UDOC.G.closePath(gst);
        if (entity === "3DFACE") { gst.colr = [Math.random(), Math.random(), Math.random()]; gst.ca = 0.5; }
        writer.Fill(gst, false);
      } else if (entity === "LWPOLYLINE") {
        for (let k = 0; k < fields[90]; k++) {
          (k === 0 ? UDOC.G.moveTo : UDOC.G.lineTo)(gst, fields[10][k], fields[20][k]);
        }
        if (fields[70] == 1) UDOC.G.closePath(gst);
        writer.Stroke(gst, false);
      } else if (entity === "CIRCLE") {
        UDOC.G.arc(gst, fields[10], fields[20], fields[40], 0, Math.PI * 2);
        writer.Stroke(gst, false);
      } else if (entity === "ELLIPSE") {
        const savedCtm = gst.ctm.slice(0);
        const cx = fields[10], cy = fields[20], mx = fields[11], my = fields[21];
        const major = Math.sqrt(mx * mx + my * my), m = [1, 0, 0, 1, 0, 0];
        UDOC.M.scale(m, 1, fields[40]);
        UDOC.M.rotate(m, -Math.atan2(my, mx));
        UDOC.M.translate(m, cx, cy);
        UDOC.M.concat(m, gst.ctm);
        gst.ctm = m;
        UDOC.G.arc(gst, 0, 0, major, fields[41], fields[42]);
        writer.Stroke(gst, false);
        gst.ctm = savedCtm;
      } else if (entity === "ARC") {
        UDOC.G.arc(gst, fields[10], fields[20], fields[40], fields[50] * Math.PI / 180, fields[51] * Math.PI / 180);
        writer.Stroke(gst, false);
      } else if (entity === "SPLINE") {
        const xs = fields[10], ys = fields[20], knots = fields[40].slice(0);
        UDOC.G.moveTo(gst, xs[0], ys[0]);
        if (fields[71] == 3 && fields[73] == 4) {
          UDOC.G.curveTo(gst, xs[1], ys[1], xs[2], ys[2], xs[3], ys[3]);
        } else {
          let lo = 1e6, hi = -1e6;
          for (let k = 0; k < knots.length; k++) { if (knots[k] < lo) lo = knots[k]; if (knots[k] > hi) hi = knots[k]; }
          for (let k = 0; k < knots.length; k++) knots[k] = (knots[k] - lo) / (hi - lo);
          const steps = xs.length * 10;
          for (let s = 1; s < steps; s++) {
            const p = splinePoint(xs, ys, fields[71], knots, s / steps);
            UDOC.G.lineTo(gst, p[0], p[1]);
          }
          UDOC.G.lineTo(gst, xs[xs.length - 1], ys[ys.length - 1]);
        }
        if (fields[70] & 1) UDOC.G.closePath(gst);
        writer.Stroke(gst, false);
      } else if (entity === "ATTRIB" || entity === "TEXT" || entity === "MTEXT") {
        gst.font.Tun = 0; gst.font.Tal = 0; gst.font.Tm = [1, 0, 0, 1, 0, 0];
        if (fields[50]) UDOC.M.rotate(gst.font.Tm, -fields[50] * Math.PI / 180);
        UDOC.M.translate(gst.font.Tm, fields[10], fields[20]);
        gst.font.Tfs = fields[40];
        let text = decodeMText(fields[1], gst), box = null;
        const align = fields[71] == null ? 0 : (fields[71] - 1) % 3;
        gst.font.Tal = [0, 2, 1][align];
        if (entity === "MTEXT" && fields[41] != null && fields[41] != 0) {
          let h = text.length * gst.font.Tfs / fields[41];
          h = Math.max(h, text.split("\n").length);
          box = [fields[41], h * gst.font.Tfs * 1.5];
          if (align === 2) UDOC.M.translate(gst.font.Tm, -fields[41], 0);
          else if (align === 1) UDOC.M.translate(gst.font.Tm, -fields[41] / 2, 0);
        } else if (entity === "MTEXT" && fields[71] != null) {
          if (fields[71] <= 3) UDOC.M.translate(gst.font.Tm, 0, -gst.font.Tfs * 0.8);
          else if (fields[71] <= 6) UDOC.M.translate(gst.font.Tm, 0, -gst.font.Tfs * 0.4);
        }
        writer.PutText(gst, text, text.length * 0.5, box);
      } else {
        console.log("unknown command", entity);
      }
    }
    else if (section === "OBJECTS" || section === "ACDSDATA") { /* ignored */ }
    else { console.log(section, code, value); throw section; }
  }
}

// Run the entity stream into `writer` within a page of `bounds`.
function render(lines, writer, gst, bounds) {
  if (gst == null) {
    bounds = [0, 0, 1e3, 1e3];
    gst = UDOC.getState(bounds);
  }
  writer.StartPage(bounds[0], bounds[1], bounds[2], bounds[3]);
  const ctx = { tabs: { LTYPE: {} }, blocks: {} };
  parseEntities(lines, writer, gst, ctx, 0, lines.length);
  writer.ShowPage();
  writer.Done();
}

function parse(buffer, writer) {
  const lines = new TextDecoder().decode(new Uint8Array(buffer)).split("\n");
  for (let i = 0; i < lines.length; i++) lines[i] = lines[i].trim();
  while (lines[lines.length - 1] === "") lines.pop();

  // First pass: measure the drawing.
  const probe = new BoundsProbe();
  render(lines, probe);
  const bb = probe.bb;

  // Fit into a PAGE_WIDTH page with a margin, flipping Y (DXF is y-up).
  const scale = (PAGE_WIDTH - PAGE_MARGIN * 2) / (bb[2] - bb[0]);
  const pageHeight = Math.round((bb[3] - bb[1]) * scale + PAGE_MARGIN * 2);
  const bounds = [0, 0, PAGE_WIDTH, pageHeight];
  const gst = UDOC.getState(bounds);
  gst.lwidth = 1 / scale;
  gst.ctm = [scale, 0, 0, -scale, PAGE_MARGIN - bb[0] * scale, -PAGE_MARGIN + bb[1] * scale + pageHeight];

  // Second pass: render into the real writer.
  render(lines, writer, gst, bounds);
}

export const FromDXF = { Parse: parse };

// DXF writer for vector export. Implements the document writer interface
// (StartPage / Fill / Stroke / PutText / ShowPage / Done) that
// VectorPageExporter.renderDocumentToPdf drives, collecting drawing operations
// into a DXF ENTITIES section and serialising them on Done().
//
// Vector only: text becomes MTEXT, straight path segments become LINE, cubic
// curves become a degree-3 SPLINE. Fills and images have no DXF equivalent here
// and are dropped (filled areas still export via their outline through Stroke).
export class ToDXF {
  constructor() {
    this.buffer = null;
    this._ent = null; // flat list of DXF [groupCode, value, groupCode, value, ...]
  }

  StartPage() {
    if (this._ent == null) this._ent = [0, "SECTION", 2, "ENTITIES"];
  }

  ShowPage() {}

  Done() {
    this._ent.push(0, "ENDSEC", 0, "EOF", "");
    const str = this._ent.join("\n");
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
    this.buffer = bytes.buffer;
    this._ent = null;
  }

  PutImage() {}
  Fill() {}

  PutText(gst, str) {
    while (str.endsWith("\n")) str = str.slice(0, str.length - 1);
    this._ent.push(0, "MTEXT");
    this._ent.push(40, gst.font.Tfs);
    this._ent.push(10, gst.ctm[4], 20, gst.ctm[5]);
    this._ent.push(1, str);
  }

  Stroke(gst) {
    const cmds = gst.pth.cmds, crds = gst.pth.crds;
    let c = 0, startX = 0, startY = 0, x = 0, y = 0;
    for (let i = 0; i < cmds.length; i++) {
      const cmd = cmds[i];
      if (cmd === "M") {
        x = crds[c++]; y = crds[c++];
        startX = x; startY = y;
      } else if (cmd === "L" || cmd === "Z") {
        if (cmd === "Z" && x === startX && y === startY) continue;
        this._ent.push(0, "LINE", 10, x, 20, y);
        if (cmd === "L") { x = crds[c++]; y = crds[c++]; }
        else { x = startX; y = startY; }
        this._ent.push(11, x, 21, y);
      } else if (cmd === "C") {
        // Cubic bezier -> degree-3 SPLINE: 4 control points, knots [0,0,0,0,1,1,1,1].
        this._ent.push(0, "SPLINE");
        this._ent.push(210, 0, 220, 0, 230, 0);
        this._ent.push(70, 8, 71, 3, 72, 8, 73, 4, 74, 0, 42, 0, 43, 0);
        for (let k = 0; k < 8; k++) this._ent.push(40, k < 4 ? 0 : 1);
        this._ent.push(10, x, 20, y);
        for (let k = 0; k < 3; k++) {
          x = crds[c++]; y = crds[c++];
          this._ent.push(10, x, 20, y);
        }
      }
    }
  }
}
