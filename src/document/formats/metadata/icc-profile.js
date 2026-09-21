/**
 * ICC colour profile reader and colour-LUT builder.
 *
 * - `ICC.parse(buffer)` → `{ header, tags }`
 * - `ICC.buildSampledLUT(profile, n)` → Float64 RGB samples on an n³ grid
 * - `ICC.lutToRGBA8(samples, n)` → clamped Uint8 RGBA view
 * - `ICC.applyLUT(samples, n, src, dst)` → trilinear RGBA remap
 *
 * Interprets the A2B0 device→PCS path (`mAB` / `mft1`) used by the adjustment engine.
 */

// ---- byte readers (all big-endian, as ICC mandates) ----------------------------------
const _s16 = new Int16Array(1);
const _s16bytes = new Uint8Array(_s16.buffer);

function readU16(b, o) { return (b[o] << 8) | b[o + 1]; }
function readS16(b, o) { _s16bytes[0] = b[o + 1]; _s16bytes[1] = b[o]; return _s16[0]; }
function readU32(b, o) { return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]; }
function readASCII(b, o, len) {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(b[o + i]);
  return s;
}
function readUTF16(b, o, len) {
  let s = "";
  for (let i = 0; i < len; i++) { const c = (b[o++] << 8) | b[o++]; s += String.fromCharCode(c); }
  return s;
}
function u8Fixed8(b, o) { return b[o] + b[o + 1] / 256; }          // u8Fixed8Number
function s15Fixed16(b, o) { return readS16(b, o) + readU16(b, o + 2) / 65536; } // s15Fixed16Number
function readXYZ(b, o) { return [s15Fixed16(b, o), s15Fixed16(b, o + 4), s15Fixed16(b, o + 8)]; }

// ---- profile parsing -----------------------------------------------------------------
function parse(buffer) {
  const bytes = new Uint8Array(buffer);
  return { header: parseHeader(bytes, 0), tags: parseTagTable(bytes, 128) };
}

function parseHeader(b, o) {
  const h = {};
  h.cmm = readASCII(b, 4, 4);
  h.version = b[8] + "." + (b[9] >>> 4) + "." + (b[9] & 15);
  h.deviceClass = readASCII(b, 12, 4);
  h.colorSpace = readASCII(b, 16, 4);
  h.pcs = readASCII(b, 20, 4);
  h.date = readU16(b, 24);
  for (let i = 0; i < 5; i++) h.date += "." + readU16(b, 26 + 2 * i);
  h.platform = readASCII(b, 40, 4);
  h.flags = readU32(b, 44);
  h.manufacturer = readASCII(b, 48, 4);
  h.model = readU32(b, 52);
  h.attributes = [readU32(b, 56), readU32(b, 60)];
  h.renderingIntent = readU32(b, 64);
  h.illuminant = readXYZ(b, 68);
  h.creator = readASCII(b, 80, 4);
  return h;
}

function parseTagTable(b, o) {
  const tags = {};
  const count = readU32(b, o);
  o += 4;
  for (let i = 0; i < count; i++) {
    const sig = readASCII(b, o, 4); o += 4;
    const offset = readU32(b, o); o += 4;
    const length = readU32(b, o); o += 4;
    tags[sig] = parseTag(b, offset, length);
  }
  return tags;
}

function parseTag(b, o, length) {
  const type = readASCII(b, o, 4);
  const tag = { type, byteLength: length };
  o += 8; // type signature + reserved
  if (type === "mluc") parseMluc(tag, b, o, length);
  else if (type === "text") tag.value = readASCII(b, o, length - 9);
  else if (type === "desc") parseDesc(tag, b, o, length);
  else if (type === "mAB ") parseMab(tag, b, o, length);
  else if (type === "mft1") parseMft1(tag, b, o, length);
  else if (type === "XYZ ") tag.value = readXYZ(b, o);
  else if (type === "para") parsePara(tag, b, o, length);
  else if (type === "curv") parseCurv(tag, b, o, length);
  else if (type !== "pseq") console.log("unknown tag", type, o, length);
  if ((tag.byteLength & 3) !== 0) tag.byteLength += 4 - (tag.byteLength & 3); // pad to 4 bytes
  return tag;
}

function parseMluc(tag, b, o, length) {
  const base = o - 8;
  const records = readU32(b, o); o += 4;
  o += 4; // record size
  tag.records = [];
  for (let i = 0; i < records; i++) {
    const rec = {};
    tag.records.push(rec);
    rec.code = readASCII(b, o, 4);
    const len = readU32(b, o + 4), off = readU32(b, o + 8);
    o += 12;
    rec.text = readUTF16(b, base + off, len >>> 1);
  }
}

function parseDesc(tag, b, o, length) {
  const asciiLen = readU32(b, o); o += 4;
  tag.ascii = readASCII(b, o, asciiLen - 1); o += asciiLen;
  o += 4; // unicode language code
  const uniLen = readU32(b, o); o += 4;
  tag.unicode = readUTF16(b, o, uniLen); o += uniLen;
  o += 2; // scriptcode code
  const macLen = b[o]; o++;
  tag.macintosh = readASCII(b, o, macLen);
}

// lutAtoBType (mAB): A-curves -> CLUT -> M-curves -> matrix -> B-curves
function parseMab(tag, b, o, length) {
  const base = o - 8;
  tag.inputChannels = b[o++];
  tag.outputChannels = b[o++];
  o += 2; // reserved
  const offB = readU32(b, o); o += 4;     // B-curves
  const offMatrix = readU32(b, o); o += 4;
  const offM = readU32(b, o); o += 4;     // M-curves
  const offClut = readU32(b, o); o += 4;
  const offA = readU32(b, o); o += 4;     // A-curves
  if (offB !== 0) {
    tag.bCurves = [];
    o = base + offB;
    for (let i = 0; i < tag.outputChannels; i++) { const c = parseTag(b, o, 0); o += c.byteLength; tag.bCurves.push(c); }
  }
  if (offMatrix !== 0) {
    tag.matrix = [];
    for (let i = 0; i < 12; i++) tag.matrix.push(s15Fixed16(b, base + offMatrix + i * 4));
  }
  if (offM !== 0) {
    tag.mCurves = [];
    o = base + offM;
    for (let i = 0; i < tag.outputChannels; i++) { const c = parseTag(b, o, 0); o += c.byteLength; tag.mCurves.push(c); }
  }
  if (offClut !== 0) {
    tag.clut = [];
    o = base + offClut;
    tag.gridPoints = [];
    for (let i = 0; i < tag.inputChannels; i++) tag.gridPoints.push(b[o + i]);
    o += 16;
    const precision = b[o]; o += 4;
    let entries = tag.outputChannels;
    for (let i = 0; i < tag.inputChannels; i++) entries *= tag.gridPoints[i];
    if (precision === 1) for (let i = 0; i < entries; i++) tag.clut.push(b[o + i] * (1 / 255));
    if (precision === 2) for (let i = 0; i < entries; i++) tag.clut.push(readU16(b, o + 2 * i) * (1 / 65535));
  }
  if (offA !== 0) {
    tag.aCurves = [];
    o = base + offA;
    for (let i = 0; i < tag.inputChannels; i++) { const c = parseTag(b, o, 0); o += c.byteLength; tag.aCurves.push(c); }
  }
}

// lut8Type (mft1)
function parseMft1(tag, b, o, length) {
  parseLut8Header(tag, b, o);
  o += 40;
  tag.inputTables = readByteTables(b, o, tag.inputChannels, 256);
  o += tag.inputChannels * 256;
  tag.clut = [];
  const clutEntries = Math.round(Math.pow(tag.gridPoints, tag.inputChannels)) * tag.outputChannels;
  for (let i = 0; i < clutEntries; i++) tag.clut.push(b[o + i] * (1 / 255));
  o += clutEntries;
  tag.outputTables = readByteTables(b, o, tag.outputChannels, 256);
  o += tag.outputChannels * 256;
}

function parseLut8Header(tag, b, o) {
  tag.inputChannels = b[o++];
  tag.outputChannels = b[o++];
  tag.gridPoints = b[o++];
  o++; // reserved
  tag.matrix = [];
  for (let i = 0; i < 9; i++) { tag.matrix.push(s15Fixed16(b, o)); o += 4; }
}

function readByteTables(b, o, rows, cols) {
  const tables = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    tables.push(row);
    for (let c = 0; c < cols; c++) { row.push(b[o]); o++; }
  }
  return tables;
}

function parsePara(tag, b, o, length) {
  tag.functionType = readU16(b, o);
  o += 4; // type + reserved
  const paramCount = [1, 3, 4, 5, 7];
  tag.params = [];
  for (let i = 0; i < paramCount[tag.functionType]; i++) tag.params.push(s15Fixed16(b, o + i * 4));
}

function parseCurv(tag, b, o, length) {
  const count = readU32(b, o); o += 4;
  tag.curve = [];
  if (count === 1) tag.curve.push(u8Fixed8(b, o)); // gamma value
  else for (let i = 0; i < count; i++) tag.curve.push(readU16(b, o + i * 2));
  tag.byteLength = 12 + 2 * count;
}

// ============================ colour LUT utilities ====================================

// D50-adapted matrices (sRGB primaries) and the sRGB transfer functions.
const XYZ_TO_RGB = [3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.033454, 0.0719453, -0.2289914, 1.4052427];
const RGB_TO_XYZ = [0.4360747, 0.3850649, 0.14308038, 0.2225045, 0.7168786, 0.0606169, 0.0139322, 0.0971045, 0.7141733];

function srgbEncode(v) { return v < 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; }
function srgbDecode(v) { return v < 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }

// Precomputed lookups over [0,2) in 0.001 steps: [0] linearised sRGB, [1] Lab f().
const _tables = (function () {
  const lin = [], labF = [];
  for (let i = 0; i < 2000; i++) {
    const u = i / 1000;
    lin[i] = srgbDecode(u);
    labF[i] = u > 0.008856 ? Math.pow(u, 1 / 3) : (903.3 * u + 16) * (1 / 116);
  }
  return [lin, labF];
})();

function rgbToLab(r, g, bl) {
  const lin = _tables[0];
  r = lin[~~(r * (1000 / 255))];
  g = lin[~~(g * (1000 / 255))];
  bl = lin[~~(bl * (1000 / 255))];
  const m = RGB_TO_XYZ;
  let x = m[0] * r + m[1] * g + m[2] * bl;
  let y = m[3] * r + m[4] * g + m[5] * bl;
  let z = m[6] * r + m[7] * g + m[8] * bl;
  x = x * (100 / 96.72);
  y = y * (100 / 100);
  z = z * (100 / 81.427);
  return xyzToLab(x, y, z);
}

function xyzToLab(x, y, z) {
  const f = _tables[1];
  const fx = f[~~(x * 1000)], fy = f[~~(y * 1000)], fz = f[~~(z * 1000)];
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function labToRgb(L, a, bl) {
  const kappa = 903.3, eps = 0.008856;
  const fy = (L + 16) / 116, fy3 = fy * fy * fy;
  const fz = fy - bl / 200, fz3 = fz * fz * fz;
  const fx = a / 500 + fy, fx3 = fx * fx * fx;
  const zr = fz3 > eps ? fz3 : (116 * fz - 16) / kappa;
  const yr = fy3 > eps ? fy3 : (116 * fy - 16) / kappa;
  const xr = fx3 > eps ? fx3 : (116 * fx - 16) / kappa;
  const X = (xr * 96.72) / 100, Y = (yr * 100) / 100, Z = (zr * 81.427) / 100;
  const m = XYZ_TO_RGB;
  const rgb = [m[0] * X + m[1] * Y + m[2] * Z, m[3] * X + m[4] * Y + m[5] * Z, m[6] * X + m[7] * Y + m[8] * Z];
  for (let i = 0; i < 3; i++) rgb[i] = Math.max(0, Math.min(255, srgbEncode(rgb[i]) * 255));
  return { r: rgb[0], g: rgb[1], b: rgb[2] };
}

// Build an n×n×n grid of device-RGB samples mapped through the profile's A2B0 transform.
function buildSampledLUT(profile, n) {
  const cells = n * n * n;
  const flat = cells * 3;
  const inv = 1 / (n - 1);
  const grid = [];
  for (let r = 0; r < n; r++)
    for (let g = 0; g < n; g++)
      for (let bl = 0; bl < n; bl++) grid.push(r * inv, g * inv, bl * inv);

  const a2b = profile.tags.A2B0;
  const colorSpace = profile.header.colorSpace.toLowerCase();
  if (a2b.type === "mAB ") {
    const mCurves = a2b.mCurves && a2b.mCurves[0].curve.length > 1 ? a2b.mCurves : null;
    for (let i = 0; i < flat; i += 3) {
      if (mCurves) applyCurves3(grid, i, mCurves);
      clut3(grid, i, a2b.clut, a2b.gridPoints[0]);
      if (a2b.matrix) applyMatrix3(grid, i, a2b.matrix);
    }
  } else if (a2b.type === "mft1") {
    if (colorSpace === "rgb ") {
      for (let i = 0; i < flat; i += 3) clut3(grid, i, a2b.clut, a2b.gridPoints);
    } else {
      for (let i = 0; i < flat; i += 3) {
        const lab = rgbToLab(grid[i] * 255, grid[i + 1] * 255, grid[i + 2] * 255);
        grid[i] = lab.L / 100;
        grid[i + 1] = (128 + lab.a) / 255;
        grid[i + 2] = (128 + lab.b) / 255;
        clut3(grid, i, a2b.clut, a2b.gridPoints);
        const rgb = labToRgb(grid[i] * 100, -128 + 255 * grid[i + 1], -128 + 255 * grid[i + 2]);
        grid[i] = rgb.r / 255;
        grid[i + 1] = rgb.g / 255;
        grid[i + 2] = rgb.b / 255;
      }
    }
  }
  return grid;
}

// 3×3 matrix (+ 3 offsets) applied in place to one RGB triple, clamped to [0,1].
function applyMatrix3(buf, o, m) {
  const r = buf[o], g = buf[o + 1], b = buf[o + 2];
  buf[o] = Math.max(0, Math.min(1, m[0] * r + m[1] * g + m[2] * b + m[9]));
  buf[o + 1] = Math.max(0, Math.min(1, m[3] * r + m[4] * g + m[5] * b + m[10]));
  buf[o + 2] = Math.max(0, Math.min(1, m[6] * r + m[7] * g + m[8] * b + m[11]));
}

function applyCurves3(buf, o, curves) {
  buf[o] = interpCurve(buf[o], curves[0].curve);
  buf[o + 1] = interpCurve(buf[o + 1], curves[1].curve);
  buf[o + 2] = interpCurve(buf[o + 2], curves[2].curve);
}

function interpCurve(v, curve) {
  const len = curve.length;
  const pos = v * (len - 1) * 0.99999;
  const i = ~~pos, frac = pos - i;
  return ((1 - frac) * curve[i] + frac * curve[i + 1]) * (1 / 65535);
}

function lerp3(a, b, buf, frac, out, outBuf) {
  const inv = 1 - frac;
  outBuf[out + 0] = inv * buf[a] + frac * buf[b];
  outBuf[out + 1] = inv * buf[a + 1] + frac * buf[b + 1];
  outBuf[out + 2] = inv * buf[a + 2] + frac * buf[b + 2];
}

// Trilinear lookup of one RGB triple in `clut` (cubic grid of side `n`), in place.
function clut3(buf, o, clut, n) {
  const tmp = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const scale = n - 1.000001;
  const fr = scale * buf[o + 0], fg = scale * buf[o + 1], fb = scale * buf[o + 2];
  const ir = ~~fr, ig = ~~fg, ib = ~~fb;
  lerp3(3 * (ib + n * ig + n * n * ir), 3 * (ib + 1 + n * ig + n * n * ir), clut, fb - ib, 0, tmp);
  lerp3(3 * (ib + n * (ig + 1) + n * n * ir), 3 * (ib + 1 + n * (ig + 1) + n * n * ir), clut, fb - ib, 3, tmp);
  lerp3(0, 3, tmp, fg - ig, 6, tmp);
  lerp3(3 * (ib + n * ig + n * n * (ir + 1)), 3 * (ib + 1 + n * ig + n * n * (ir + 1)), clut, fb - ib, 0, tmp);
  lerp3(3 * (ib + n * (ig + 1) + n * n * (ir + 1)), 3 * (ib + 1 + n * (ig + 1) + n * n * (ir + 1)), clut, fb - ib, 3, tmp);
  lerp3(0, 3, tmp, fg - ig, 9, tmp);
  lerp3(6, 9, tmp, fr - ir, 0, tmp);
  buf[o] = tmp[0];
  buf[o + 1] = tmp[1];
  buf[o + 2] = tmp[2];
}

// Pack the sample grid into an RGBA8 view (and clamp the grid in place).
function lutToRGBA8(samples, n) {
  const cells = n * n * n;
  const rgba = new Uint8Array(cells * 4);
  for (let i = 0; i < cells; i++) {
    const s = i * 3, d = s + i;
    const r = Math.max(0, Math.min(1, samples[s]));
    const g = Math.max(0, Math.min(1, samples[s + 1]));
    const b = Math.max(0, Math.min(1, samples[s + 2]));
    rgba[d] = ~~(0.5 + r * 255);
    rgba[d + 1] = ~~(0.5 + g * 255);
    rgba[d + 2] = ~~(0.5 + b * 255);
    rgba[d + 3] = 255;
    samples[s] = r; samples[s + 1] = g; samples[s + 2] = b;
  }
  return rgba;
}

// Trilinearly map an RGBA8 pixel buffer `src` through the n×n×n RGB grid `samples` into `dst`.
function applyLUT(samples, n, src, dst) {
  const tmp = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const scale = (n - 1.000001) / 255;
  const w = 3;
  for (let m = 0; m < src.length; m += 4) {
    const fr = scale * src[m], fg = scale * src[m + 1], fb = scale * src[m + 2];
    const ir = ~~fr, ig = ~~fg, ib = ~~fb;
    lerp3(w * (ib + n * ig + n * n * ir), w * (ib + 1 + n * ig + n * n * ir), samples, fb - ib, 0, tmp);
    lerp3(w * (ib + n * (ig + 1) + n * n * ir), w * (ib + 1 + n * (ig + 1) + n * n * ir), samples, fb - ib, 3, tmp);
    lerp3(0, 3, tmp, fg - ig, 6, tmp);
    lerp3(w * (ib + n * ig + n * n * (ir + 1)), w * (ib + 1 + n * ig + n * n * (ir + 1)), samples, fb - ib, 0, tmp);
    lerp3(w * (ib + n * (ig + 1) + n * n * (ir + 1)), w * (ib + 1 + n * (ig + 1) + n * n * (ir + 1)), samples, fb - ib, 3, tmp);
    lerp3(0, 3, tmp, fg - ig, 9, tmp);
    lerp3(6, 9, tmp, fr - ir, 0, tmp);
    dst[m] = ~~(0.5 + tmp[0] * 255);
    dst[m + 1] = ~~(0.5 + tmp[1] * 255);
    dst[m + 2] = ~~(0.5 + tmp[2] * 255);
  }
}

export const ICC = {
  parse,
  buildSampledLUT,
  lutToRGBA8,
  applyLUT,
};
