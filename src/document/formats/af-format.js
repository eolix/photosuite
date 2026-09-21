// Affinity (.af) loader — reads the Affinity 2 unified file format used by
// Affinity Designer / Photo / Publisher (single ".af" container; also the older
// .afdesign/.afphoto/.afpub share the object grammar).
//
// Reverse-engineered from sample files (format version 12). The container layout
// and field grammar were cross-checked against the open-source `afread` project
// (which covers versions 7–11); v12 adds a few structural node markers in the
// metadata objects that the tree walk below tolerates by resyncing.
//
// Pipeline:  bytes ──► container (FAT) ──► extract "doc.dat" (zstd) ──►
//            object tree walk ──► vector model {layers, paths, fills, transforms}
//            ──► emitted into the document via VectorPageBuilder (Fill / Stroke).
//
// Format reference
// ----------------
//   Container:  magic 00 FF 4B 41 ("..KA", LE u32 0x414BFF00)
//               "#Inf" header → u64 offsets to FAT (#FAT/#FT2/#FT3/#FT4) + thumb
//               files: zstd (alg 2) or zlib (alg 1); key file = "doc.dat"
//               thumbnail: 0xFFFFFFFF + "Thmb" → stored PNG;  trailing "Meta" = JSON
//   Object tree (doc.dat): magic 00 FF 4B 53 ("..KS")
//               fields = [type:u8][tag:fourCC-LE][value];  type&0x80 = array flag
//   Vector geometry:  Crvs → PCvD → Data → "curve18" node array
//               (type 0xAC, count:u32, size:u16=18, N×{x:f64, y:f64, f0:u8, f1:u8})
//               three entries per node:  (1,0)=anchor  (0,1)=in-handle  (0,2)=out-handle
//
// Geometry/colour decoders here are deliberately structural (scan for the
// curve18 / RGBA signatures) so the visual content survives v12 metadata quirks;
// the generic tree walk recovers hierarchy, names and transforms on top of that.

import { Point } from "../../core/math/point.js";
import { Matrix2D } from "../../core/math/matrix2d.js";
import { Rect } from "../../core/math/rect.js";
import { FileFormatRegistry } from "./registry/file-format-registry.js";
import { allocBuffer } from "../../engine/compositing/buffer-utils.js";
import { BinaryUtils } from "../../core/binary/binary-utils.js";

/* global TextDecoder, pako */

// ---- fourCC helpers ---------------------------------------------------------
// Tags are stored little-endian, so the bytes read back reversed vs. the
// human-readable name (file "svrC" == tag "Crvs").
function fourCC(s) { return s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24); }
function tagToString(t) { return String.fromCharCode(t & 0xff, (t >> 8) & 0xff, (t >> 16) & 0xff, (t >> 24) & 0xff); }

const TAG_FILE = 0x414bff00;          // container magic
const TAG_DOC  = 0x534bff00;          // doc.dat object-stream magic
const TAG_INF  = fourCC("#Inf");
const TAG_PROT = fourCC("Prot");
const TAG_FIL  = fourCC("#Fil");
const TAG_THMB = fourCC("Thmb");
const TAG_FAT  = fourCC("#FAT");
const TAG_FT2  = fourCC("#FT2");
const TAG_FT4  = fourCC("#FT4");
const FAT_TAGS = new Set([TAG_FAT, TAG_FT2, fourCC("#FT3"), TAG_FT4]);

function AffinityLoader() {}

// ============================================================================
// Public reader — pure, no document side effects. Returns a vector model.
// ============================================================================
AffinityLoader.read = function (buffer) {
  var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  var container = AffinityLoader.parseContainer(bytes);
  var docDat = container.docDat;
  if (docDat == null) throw "af: no doc.dat stream";

  var model = AffinityLoader.buildModel(docDat);
  model.version = container.version;
  model.thumbnailPng = container.thumbnailPng;
  model.meta = container.meta;
  if (model.meta && model.meta.document) {
    model.title = model.meta.document.title || model.title;
  }
  return model;
};

// ----------------------------------------------------------------------------
// Container: header → FAT chain → file list → extract doc.dat + thumbnail + meta
// ----------------------------------------------------------------------------
AffinityLoader.parseContainer = function (bytes) {
  var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  var u8 = function (o) { return dv.getUint8(o); };
  var u16 = function (o) { return dv.getUint16(o, true); };
  var u32 = function (o) { return dv.getUint32(o, true); };
  var u64 = function (o) { return Number(dv.getBigUint64(o, true)); };

  if (u32(0) !== TAG_FILE) throw "af: bad magic";
  var version = u16(4);
  var flag = u16(6);
  var classTag = u32(8);
  var p = 12;
  if (u32(p) !== TAG_INF) throw "af: missing #Inf";
  p += 4;
  var inf = {
    fatOffset: u64(p), thmbOffset: u64(p + 8), someLength: u64(p + 16),
    unknown1: u64(p + 24), creationDate: u64(p + 32), revision: u32(p + 40), someNum2: u32(p + 44),
  };
  p += 48;
  if (version > 7) { if (u32(p) !== TAG_PROT) throw "af: missing Prot"; p += 8; }

  // FAT chain — collect every file revision, keep the newest per name.
  var byName = {};
  for (var off = inf.fatOffset; off !== 0;) {
    var q = off;
    var fatTag = u32(q); q += 4;
    if (!FAT_TAGS.has(fatTag)) throw "af: bad FAT tag @" + off;
    var next = u64(q); q += 8;
    q += 32;                                        // creation_date, some_offset, some_length, unknown5
    var filesCount = u32(q); q += 4;
    q += 8;                                          // unknown7, unknown8
    var dirsCount = u16(q); q += 2; q += 1;         // unknown10

    for (var i = 0; i < filesCount; i++) {
      var id = u32(q); q += 4;
      var fflag = u8(q); q += 1;
      var fileEntry = { id: id, flag: fflag };
      if (fflag === 0 || fflag === 1) {
        fileEntry.offset = u64(q); fileEntry.size = u64(q + 8); fileEntry.compressedSize = u64(q + 16);
        fileEntry.crc32 = u32(q + 24); fileEntry.compression = u8(q + 28); q += 29;
        if (fatTag !== TAG_FAT) q += 4;             // unknown6
        if (fatTag === TAG_FT4) q += 4;             // unknown_fat4
        if (fatTag === TAG_FAT || fatTag === TAG_FT2) {
          fileEntry.compression = ({ 1: 0x01, 2: 0x41, 3: 0x81, 4: 0xc1 })[fileEntry.compression] || 0;
        }
      }
      if (fflag === 0) {
        var n = u16(q); q += 2;
        fileEntry.name = AffinityLoader.utf8(bytes, q, n); q += n;
        if (fileEntry.size > 0) byName[fileEntry.name] = fileEntry;          // newer FAT entries override
      }
    }
    for (var d = 0; d < dirsCount; d++) {
      var sl = u16(q); q += 2 + 2 + 8 + sl;          // str_len, some_len, files_num, name
    }
    off = next;
  }

  var docFile = byName["doc.dat"];
  return {
    version: version, flag: flag, classTag: tagToString(classTag), info: inf,
    files: Object.keys(byName),
    getFile: function (name) { return byName[name] ? AffinityLoader.extractFile(bytes, byName[name]) : null; },
    docDat: docFile ? AffinityLoader.extractFile(bytes, docFile) : null,
    thumbnailPng: AffinityLoader.carveThumbnail(bytes, inf.thmbOffset),
    meta: AffinityLoader.readMeta(bytes),
  };
};

AffinityLoader.extractFile = function (bytes, fileEntry) {
  var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(fileEntry.offset, true) !== TAG_FIL) throw "af: bad #Fil tag for " + fileEntry.name;
  var start = fileEntry.offset + 4;
  var alg = fileEntry.compression & 3;
  var comp = bytes.subarray(start, start + fileEntry.compressedSize);
  if (alg === 2) return AffinityLoader.zstd(comp, fileEntry.size);
  if (alg === 1) return pako.inflate(comp);
  return bytes.slice(start, start + fileEntry.size);
};

// zstd via the vendored decompress-only WASM (shared with the AI codec; the
// instance is attached to afCodec.zstdWasmExports by codecs/vector.js at load time).
AffinityLoader.zstd = function (compressed, expectedSize) {
  var wasm = AffinityLoader.zstdWasm;
  if (!wasm) throw "af: zstd WASM not ready";
  var srcLen = compressed.length, mult = expectedSize ? Math.ceil(expectedSize / srcLen) + 1 : 8;
  FileFormatRegistry.growWasmMemory(wasm, 1e6 + srcLen);
  var srcPtr = wasm.malloc(srcLen);
  new Uint8Array(wasm.memory.buffer).set(compressed, srcPtr);
  for (;;) {
    FileFormatRegistry.growWasmMemory(wasm, srcLen * (mult + 2) + 1e6);
    var dstPtr = wasm.malloc(srcLen * mult);
    var r = wasm.ZSTD_decompress(dstPtr, srcLen * mult, srcPtr, srcLen);
    if (r === -70) { wasm.free(dstPtr); if (mult > 256) throw "af: zstd too large"; mult += 4; continue; }
    var out = new Uint8Array(wasm.memory.buffer).slice(dstPtr, dstPtr + r);
    wasm.free(dstPtr); wasm.free(srcPtr);
    return out;
  }
};

AffinityLoader.carveThumbnail = function (bytes, thmbOffset) {
  if (!thmbOffset || thmbOffset + 8 > bytes.length) return null;
  var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(thmbOffset, true) !== 0xffffffff || dv.getUint32(thmbOffset + 4, true) !== TAG_THMB) return null;
  for (var i = thmbOffset; i < bytes.length - 8; i++) {
    if (bytes[i] === 0x89 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x4e && bytes[i + 3] === 0x47) {
      for (var j = i + 8; j < bytes.length - 8; j++)
        if (bytes[j] === 0x49 && bytes[j + 1] === 0x45 && bytes[j + 2] === 0x4e && bytes[j + 3] === 0x44)
          return bytes.slice(i, j + 8);
    }
  }
  return null;
};

// Trailing "Meta" chunk carries a small JSON sidecar (title, page count, app version).
AffinityLoader.readMeta = function (bytes) {
  var idx = BinaryUtils.indexOfBytes(bytes, "{\"document\"");
  if (idx < 0) return null;
  var end = idx;
  while (end < bytes.length && bytes[end] !== 0x00) end++;
  try { return JSON.parse(AffinityLoader.utf8(bytes, idx, end - idx)); } catch (e) { return null; }
};

// ============================================================================
// Object tree → vector model
// ============================================================================
AffinityLoader.buildModel = function (docDat) {
  var dv = new DataView(docDat.buffer, docDat.byteOffset, docDat.byteLength);
  if (dv.getUint32(0, true) !== TAG_DOC) throw "af: doc.dat bad magic";

  // 1) Walk the tree (resilient) to recover the shared-object graph: every
  //    persisted object, its type tag, fields, and child references.
  var tree = AffinityLoader.walkTree(docDat);

  // 2) Pull the geometry + per-object style/transform with structural scanners
  //    (robust to v12 metadata markers). These are matched back onto tree nodes.
  var curves = AffinityLoader.scanCurves(docDat);     // [{offset, nodes, closed}]
  var shapes = AffinityLoader.scanShapes(docDat);     // [{offset, rect}] parametric
  var colors = AffinityLoader.scanColors(docDat);     // [{offset, rgba}]
  var gradients = AffinityLoader.scanGradients(docDat); // [{offset, kind, pts, stops}]
  var names = AffinityLoader.scanNames(docDat);       // [{offset, name}]
  var transforms = AffinityLoader.scanTransforms(docDat); // [{offset, matrix}]

  // 3) Assemble layers. A curve object is one or more contours: the primary
  //    contour plus any holes/counters (compound paths). Secondary contours have
  //    no Data header and fold into the preceding primary item.
  var items = [], lastCurve = null;
  curves.forEach(function (c) {
    if (c.primary || !lastCurve) {
      lastCurve = { offset: c.offset, kind: "curve", contours: [c.nodes], closed: c.closed };
      items.push(lastCurve);
    } else {
      lastCurve.contours.push(c.nodes);
    }
  });
  shapes.forEach(function (s) { items.push({ offset: s.offset, kind: "shape", contours: [AffinityLoader.rectNodes(s.rect)], closed: true, rect: s.rect }); });
  items.sort(function (a, b) { return a.offset - b.offset; });   // ascending = writer order (bottom-up)

  // Each Desc name and each Grad fill is written at the head of its object body,
  // just ahead of the geometry, so bind both to the nearest following item.
  names.slice().sort(function (a, b) { return a.offset - b.offset; }).forEach(function (nm) {
    for (var j = 0; j < items.length; j++) {
      if (!items[j].name && items[j].offset > nm.offset) { items[j].name = nm.name; break; }
    }
  });
  gradients.slice().sort(function (a, b) { return a.offset - b.offset; }).forEach(function (gr) {
    for (var j = 0; j < items.length; j++) {
      if (!items[j].grad && items[j].offset > gr.offset) { items[j].grad = gr; break; }
    }
  });

  // Reverse to top-down (index 0 = topmost), matching the panel/z-order
  // convention; the back-to-front render loop consumes this directly.
  items.reverse();

  var layers = items.map(function (it, i) {
    var bbox = AffinityLoader.contoursBounds(it.contours);
    // Solid fill colour position depends on object kind: a curve writes its fill
    // ahead of the geometry (so read *before* — reading after grabs the next
    // object's fill, which only shows on the topmost layer, e.g. the S tip going
    // blue), while a parametric shape writes its bbox first and the fill after.
    // Curves with no colour before them (a default fill) fall back to after.
    var fill;
    if (it.kind === "shape") {
      fill = AffinityLoader.nearestAfter(colors, it.offset);
    } else {
      var before = AffinityLoader.nearestBefore(colors, it.offset);
      fill = (before && it.offset - before.offset < 1500) ? before : AffinityLoader.nearestAfter(colors, it.offset);
    }
    var tr = AffinityLoader.nearestBefore(transforms, it.offset);
    return {
      name: it.name || ((it.kind === "shape" ? "Shape " : "Curve ") + (i + 1)),
      kind: it.kind,
      contours: it.contours,
      nodes: it.contours[0],
      closed: it.closed,
      fill: fill ? fill.rgba : null,
      gradient: AffinityLoader.gradientFill(it.grad, bbox),
      stroke: null,
      transform: tr ? tr.matrix : null,
      bbox: bbox,
    };
  });

  var bounds = AffinityLoader.unionBounds(layers);
  return {
    width: Math.ceil(bounds.width) || 0,
    height: Math.ceil(bounds.height) || 0,
    origin: { x: bounds.x, y: bounds.y },
    title: null,
    layers: layers,
    objectCount: tree.objects.length,
    tree: tree,
  };
};

// ---- resilient generic walk -------------------------------------------------
// Decodes the self-describing [type][tag][value] grammar. On any desync it
// resyncs to the next class marker (0x31/0x32 + printable fourCC). Produces a
// flat object list plus a shared-id map; enough to reconstruct hierarchy.
AffinityLoader.walkTree = function (docDat) {
  var dv = new DataView(docDat.buffer, docDat.byteOffset, docDat.byteLength);
  var byteLen = docDat.length;
  var objects = [];
  var shared = {};

  // doc header: magic u32, file_ver u16, type_tag u32, type_ver u16, [ver u32 if file_ver>=2]
  var fileVer = dv.getUint16(4, true);
  var p = 12 + (fileVer >= 2 ? 4 : 0);

  var reader = {
    p: p, dv: dv, n: byteLen,
    u8: function () { return dv.getUint8(this.p++); },
    u16: function () { var v = dv.getUint16(this.p, true); this.p += 2; return v; },
    u32: function () { var v = dv.getUint32(this.p, true); this.p += 4; return v; },
    f64: function () { var v = dv.getFloat64(this.p, true); this.p += 8; return v; },
  };

  function printableFourCC(o) {
    for (var byteIdx = 0; byteIdx < 4; byteIdx++) { var byteVal = docDat[o + byteIdx]; if (byteVal < 0x30 || byteVal > 0x7a) return false; }
    return true;
  }
  // v12 emits structural node markers (e.g. "Node", "LogN") inside object bodies
  // as a bare fourCC whose first byte lands in the struct type-range (0x35-0x74).
  // A letter-fourCC there is a marker, not a struct field.
  function letterFourCC(o) {
    for (var byteIdx = 0; byteIdx < 4; byteIdx++) { var byteVal = docDat[o + byteIdx]; var alpha = (byteVal >= 0x41 && byteVal <= 0x5a) || (byteVal >= 0x61 && byteVal <= 0x7a); if (!alpha) return false; }
    return true;
  }
  function looksLikeFieldStart(o) {
    if (o >= byteLen) return false;
    var t = docDat[o] & 0x7f;
    if (t === 0x00) return false;
    if (t >= 0x35 && t <= 0x74) return letterFourCC(o);   // marker
    return t <= 0x77;                                       // any other valid type code
  }
  function resync() {
    // advance to the next plausible class field: [type 0x30-0x32 | 0xb0-0xb2][fourCC]
    for (var o = reader.p; o < byteLen - 5; o++) {
      var t = docDat[o] & 0x7f;
      if ((t === 0x30 || t === 0x31 || t === 0x32) && printableFourCC(o + 1)) { reader.p = o; return true; }
    }
    reader.p = byteLen; return false;
  }

  function readValue(type, array) {
    // scalar widths
    var scalarWidths = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 1, 6: 2, 7: 4, 8: 8, 9: 4, 0x0a: 8, 0x2f: 4, 0x34: 4 };
    if (scalarWidths[type] != null) { var count = array ? reader.u32() : 1; reader.p += scalarWidths[type] * count; return; }
    if (type >= 0x15 && type <= 0x19) { var vecWidth = type - 0x13, count2 = array ? reader.u32() : 1; reader.p += 4 * vecWidth * count2; return; }
    if (type >= 0x1f && type <= 0x23) { var vecWidth3 = type - 0x1d, count3 = array ? reader.u32() : 1; reader.p += 4 * vecWidth3 * count3; return; }
    if (type >= 0x24 && type <= 0x28) { var vecWidth4 = type - 0x22, count4 = array ? reader.u32() : 1; reader.p += 8 * vecWidth4 * count4; return; }
    if (type === 0x29) { if (!array) { reader.p += 1; } else { var bitCount = reader.u32(); reader.p += (bitCount + 7) >> 3; } return; }   // bool / bit-packed
    if (type === 0x2a) { if (!array) { reader.p += 4; } else { var enumCount = reader.u32(); reader.p += 2 + 2 * enumCount; } return; }       // EnumT
    if (type === 0x2b || type === 0x2e) {                                                                       // string
      if (!array) { var byteCount = reader.u32(); reader.p += byteCount; } else { reader.u32(); var strCount = reader.u32(); for (var s = 0; s < strCount; s++) { var byteCount2 = reader.u32(); reader.p += byteCount2; } } return;
    }
    if (type === 0x2c) { var curveCount = array ? reader.u32() : 1, curveStride = reader.u16(); reader.p += curveStride * curveCount; return; }                   // curve struct
    if (type === 0x2d) { var blobLen = reader.u32(); reader.p += blobLen; return; }                                                 // binary
    if (type === 0x33) { reader.u32(); var embeddedSize = reader.u32(); reader.p += embeddedSize; return; }                                        // embedded
    if (type === 0x75) { reader.u16(); var flagCount = reader.u8(); reader.p += flagCount; return; }                                         // flags
    if (type >= 0x35 && type <= 0x74) { var structSize = type - 0x34, structCount = array ? reader.u32() : 1; reader.p += structSize * structCount; return; } // fixed struct
    throw "unknown type 0x" + type.toString(16);
  }

  function loadFields(withTag, depth) {
    if (depth > 64) { resync(); return; }
    for (;;) {
      if (reader.p >= byteLen) return;
      // v12 structural node marker: bare fourCC (optionally + u32) before fields.
      if ((docDat[reader.p] >= 0x35 && docDat[reader.p] <= 0x74) && letterFourCC(reader.p)) {
        reader.p += 4;                                      // consume marker tag
        if (!looksLikeFieldStart(reader.p)) reader.p += 4;       // ...and its u32 value, if present
        continue;
      }
      var raw = reader.u8();
      var array = (raw & 0x80) !== 0;
      var type = raw & 0x7f;
      if (type === 0x00) return;                       // end of fields
      var tag = withTag ? reader.u32() : 0;
      if (type === 0x30 || type === 0x31 || type === 0x32) {
        if (!withTag) { resync(); return; }
        loadClass(type, array, depth + 1);
      } else {
        try { readValue(type, array); }
        catch (e) { resync(); return; }
      }
    }
  }

  function loadClass(type, array, depth) {
    var count = 1, h32 = null;
    if (array) { count = reader.u32(); if (type === 0x32) { reader.u32(); reader.u16(); } }
    for (var i = 0; i < count; i++) {
      if (type === 0x30) { loadFields(false, depth); continue; }
      var flag = reader.u8();
      if (flag === 0) continue;                        // null
      if (flag === 2) { reader.u32(); continue; }           // link to existing shared id
      if (flag === 1) {
        var id = reader.u32();
        var typeTag = 0;
        var tf = reader.u8();
        if (tf === 0) { typeTag = reader.u32(); reader.u32(); }   // TagId: type tag + type id (class31)
        else if (tf === 1) { typeTag = reader.u32(); }       // Tag only
        else if (tf === 2) { /* end */ }
        else { resync(); return; }
        if (type === 0x32) { typeTag = reader.u32(); reader.u16(); } // class32: type tag + u16 id
        var obj = { id: id, type: tagToString(typeTag), offset: reader.p };
        shared[id] = obj; objects.push(obj);
        loadFields(true, depth);
      } else { resync(); return; }
    }
  }

  // Harvest mode: object bodies are emitted roughly sequentially, but the strict
  // nesting walk can desync on undocumented v12 fields. Rather than lose the rest
  // of the tree, keep resyncing to the next object marker until EOF. This recovers
  // the full object inventory (types, ids, field offsets) even past a desync.
  var guard = 0;
  while (reader.p < byteLen - 5 && guard < 200000) {
    guard++;
    var before = reader.p;
    try { loadFields(true, 0); } catch (e) { /* tolerate */ }
    if (reader.p >= byteLen - 5) break;
    if (!resync()) break;
    if (reader.p <= before) reader.p++;
  }
  return { objects: objects, shared: shared };
};

// Layer/object names are stored in the "Desc" (cseD) string field. Scan them so
// each geometry object can be labelled even when strict hierarchy is incomplete.
AffinityLoader.scanNames = function (docDat) {
  var dv = new DataView(docDat.buffer, docDat.byteOffset, docDat.byteLength);
  var n = docDat.length, out = [], TAG = fourCC("cseD"); // "Desc" reversed
  for (var i = 0; i < n - 8; i++) {
    if (dv.getUint32(i + 1, true) === TAG && (docDat[i] & 0x7f) === 0x2b) {
      var len = dv.getUint32(i + 5, true);
      if (len > 0 && len < 256 && i + 9 + len <= n) {
        var s = AffinityLoader.utf8(docDat, i + 9, len);
        if (/^[\x20-\x7e]+$/.test(s)) out.push({ offset: i, name: s });
      }
    }
  }
  return out;
};

// Parametric shapes (rectangles, ellipses, …) are "ShpN" objects carrying a
// "ShpB" bounding box = vec_d<4> (x, y, w, h) in document space. Emit them as
// rectangle paths so shape-based documents render too (not just curve layers).
AffinityLoader.scanShapes = function (docDat) {
  var dv = new DataView(docDat.buffer, docDat.byteOffset, docDat.byteLength);
  var n = docDat.length, out = [], TAG = fourCC("BphS"); // "ShpB" reversed
  for (var i = 0; i < n - 36; i++) {
    if (dv.getUint32(i, true) === TAG) {
      var o = i + 4, boxValues = [];
      for (var boxIdx = 0; boxIdx < 4; boxIdx++) boxValues.push(dv.getFloat64(o + boxIdx * 8, true));
      if (boxValues.every(function (v) { return isFinite(v) && Math.abs(v) < 1e7; }) && boxValues[2] !== 0 && boxValues[3] !== 0) {
        out.push({ offset: i, rect: { x: boxValues[0], y: boxValues[1], w: boxValues[2], h: boxValues[3] } });
      }
    }
  }
  return out;
};

// ---- structural scanners (source of truth for visuals) ----------------------
AffinityLoader.scanCurves = function (docDat) {
  var dv = new DataView(docDat.buffer, docDat.byteOffset, docDat.byteLength);
  var n = docDat.length, out = [];
  for (var i = 0; i < n - 7;) {
    if (docDat[i] === 0xac && dv.getUint16(i + 5, true) === 18) {
      var cnt = dv.getUint32(i + 1, true), base = i + 7;
      if (cnt >= 2 && cnt <= 1e6 && base + cnt * 18 <= n) {
        var entries = [], ok = true;
        for (var entryIdx = 0; entryIdx < cnt; entryIdx++) {
          var o = base + entryIdx * 18, x = dv.getFloat64(o, true), y = dv.getFloat64(o + 8, true);
          if (!isFinite(x) || !isFinite(y) || Math.abs(x) > 1e7 || Math.abs(y) > 1e7) { ok = false; break; }
          entries.push({ x: x, y: y, f0: docDat[o + 16], f1: docDat[o + 17] });
        }
        if (ok) {
          out.push({ offset: i, nodes: AffinityLoader.entriesToNodes(entries), closed: true,
                     primary: AffinityLoader.hasDataHeader(docDat, i) });
          i = base + cnt * 18; continue;
        }
      }
    }
    i++;
  }
  return out;
};

// A primary contour is introduced by its Curve object's "Data" (ataD) field a
// few bytes ahead of the curve18 array. Additional contours of a compound curve
// (the counters/holes of a letter) are emitted under a "@cpr" sub-array with no
// Data header — those belong to the preceding primary contour.
AffinityLoader.hasDataHeader = function (docDat, curveOffset) {
  var DATA = fourCC("ataD"); // "Data" reversed
  var dv = new DataView(docDat.buffer, docDat.byteOffset, docDat.byteLength);
  for (var o = curveOffset - 8; o >= curveOffset - 40 && o >= 1; o--) {
    var t = docDat[o] & 0x7f;
    if ((t === 0x30 || t === 0x31 || t === 0x32) && dv.getUint32(o + 1, true) === DATA) return true;
  }
  return false;
};

// curve18 entries → bezier nodes. An anchor is f0=1 (corner) or f0=2 (smooth);
// both are real on-path vertices and differ only in editing continuity. Each
// anchor is bracketed by its two control points in stream order: the in-handle
// (f1=2) precedes the anchor it arrives at, and the out-handle (f1=1) follows the
// anchor it leaves from. So an f1=2 entry belongs to the *next* anchor's in,
// while f1=1 belongs to the current anchor's out. Closed paths repeat the first
// anchor at the end carrying node 0's in-handle; fold it back so there is no
// zero-length closing segment.
AffinityLoader.entriesToNodes = function (entries) {
  var nodes = [], cur = null, pendingIn = null;
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.f0 === 1 || e.f0 === 2) {
      if (cur) nodes.push(cur);
      cur = { x: e.x, y: e.y, inX: e.x, inY: e.y, outX: e.x, outY: e.y, smooth: e.f0 === 2 };
      if (pendingIn) { cur.inX = pendingIn.x; cur.inY = pendingIn.y; pendingIn = null; }
    } else if (e.f1 === 1) {                    // out-handle: follows its anchor
      if (cur) { cur.outX = e.x; cur.outY = e.y; }
    } else if (e.f1 === 2) {                    // in-handle: precedes the next anchor
      pendingIn = { x: e.x, y: e.y };
    }
  }
  if (cur) nodes.push(cur);
  // Fold a trailing duplicate of the first anchor (the explicit close) into node 0.
  if (nodes.length > 1) {
    var first = nodes[0], last = nodes[nodes.length - 1];
    if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) {
      first.inX = last.inX; first.inY = last.inY;
      nodes.pop();
    }
  }
  return nodes;
};

// Solid colours: RGBA struct = 4 float32 (size-16 struct under tag "_col"/"RGBA").
AffinityLoader.scanColors = function (docDat) {
  var dv = new DataView(docDat.buffer, docDat.byteOffset, docDat.byteLength);
  var n = docDat.length, out = [], TAG = fourCC("ABGR"); // "RGBA" stored reversed
  for (var i = 0; i < n - 32; i++) {
    if (dv.getUint32(i, true) === TAG) {
      // a 16-byte color struct (4×f32, RGBA) sits a few bytes after the tag; the
      // exact gap varies, so probe a window and prefer a non-zero (real) colour.
      var found = null;
      for (var d = 4; d <= 20 && i + d + 16 <= n; d++) {
        var o = i + d, r = dv.getFloat32(o, true), g = dv.getFloat32(o + 4, true), blue = dv.getFloat32(o + 8, true), a = dv.getFloat32(o + 12, true);
        if ([r, g, blue, a].every(function (v) { return v >= -0.001 && v <= 1.001; })) {
          if (!found) found = [r, g, blue, a];
          if (r + g + blue > 0.001 && a > 0.001) { found = [r, g, blue, a]; break; }
        }
      }
      if (found) out.push({ offset: i, rgba: found });
    }
  }
  return out;
};

// Gradient fills: a "Grad" object carries "Type" (0 linear / 1 radial), a "Posn"
// array of unit-space stop positions (vec_d<2>), and a "Cols" array of stop
// colours. Each stop colour is a 16-byte "_col" struct (4×f32) tagged by its
// colourspace just ahead of it ("RGBA" via "ABGR", "HSLA" via "ALSH", …).
// Returns one entry per gradient, in document order.
AffinityLoader.scanGradients = function (docDat) {
  var dv = new DataView(docDat.buffer, docDat.byteOffset, docDat.byteLength);
  var n = docDat.length, out = [];
  var GRAD = fourCC("darG"), POSN = fourCC("nsoP"), COLS = fourCC("sloC"),
      TYPE = fourCC("epyT"), COL = fourCC("loc_"), FDEX = fourCC("XeDF");
  var CS = AffinityLoader.colorspaceTags();
  var colorDefs = AffinityLoader.scanColorDefs(docDat);   // shared id → stop colour
  function tagBack(from, tag, span) { for (var o = from; o >= from - span && o >= 1; o--) { var t = docDat[o] & 0x7f; if (t >= 0x14 && t <= 0x32 && dv.getUint32(o + 1, true) === tag) return o; } return -1; }
  function tagFwd(from, tag, span) { for (var o = from; o < from + span && o < n - 8; o++) { var t = docDat[o] & 0x7f; if (t >= 0x14 && t <= 0x32 && dv.getUint32(o + 1, true) === tag) return o; } return -1; }
  for (var i = 0; i < n - 8; i++) {
    var ty = docDat[i] & 0x7f;
    if ((ty !== 0x30 && ty !== 0x31 && ty !== 0x32) || dv.getUint32(i + 1, true) !== GRAD) continue;
    var typeOff = tagBack(i - 1, TYPE, 40);
    var kind = (typeOff >= 0 && dv.getUint32(typeOff + 5, true) === 1) ? "radial" : "linear";
    var pts = [], posnOff = tagFwd(i, POSN, 40);
    if (posnOff >= 0) {
      var pc = dv.getUint32(posnOff + 5, true);
      if (pc > 0 && pc < 64) for (var ptIdx = 0; ptIdx < pc; ptIdx++) { var po = posnOff + 9 + ptIdx * 16; pts.push([dv.getFloat64(po, true), dv.getFloat64(po + 8, true)]); }
    }
    // Walk the Cols array element-by-element: each stop is either inline
    // ([flag=1][id][tf][colourspace][_col]) or a shared reference ([flag=2][id]).
    var stops = [], colsOff = tagFwd(i, COLS, 160);
    if (colsOff >= 0) {
      var sc = dv.getUint32(colsOff + 5, true), p = colsOff + 9;
      for (var si = 0; si < sc && p < n - 4; si++) {
        var flag = docDat[p++];
        if (flag === 2) {                               // reference to a shared colour
          var refId = dv.getUint32(p, true); p += 4;
          if (colorDefs[refId]) stops.push(colorDefs[refId]);
        } else if (flag === 1) {                        // inline colour
          p += 4;                                       // id
          var tf = docDat[p++];
          var csTag = 0;
          if (tf === 0) { csTag = dv.getUint32(p, true); p += 8; }
          else if (tf === 1) { csTag = dv.getUint32(p, true); p += 4; }
          var colOff = -1;
          for (var q = p; q < p + 24 && q < n - 21; q++) { if (docDat[q] === 0x44 && dv.getUint32(q + 1, true) === COL) { colOff = q; break; } }
          if (colOff < 0) break;
          var colorChannels = [dv.getFloat32(colOff + 5, true), dv.getFloat32(colOff + 9, true), dv.getFloat32(colOff + 13, true), dv.getFloat32(colOff + 17, true)];
          var cs = CS[csTag];
          if (!cs) for (var bk = colOff - 4; bk >= colOff - 16 && bk >= 0; bk--) { var hit = CS[dv.getUint32(bk, true)]; if (hit) { cs = hit; break; } }
          stops.push(AffinityLoader.colorToStop(cs || "RGBA", colorChannels));
          p = colOff + 21;
          while (p < n && docDat[p] === 0) p++;          // skip end-of-fields terminator(s)
        } else break;                                   // null / unexpected
      }
    }
    // Fill transform ("FDeX" = vec_d<6> affine) maps the unit-space gradient line
    // into document space — this is what orients/rotates the gradient.
    var mat = null, fdexOff = tagFwd(i, FDEX, 500);
    if (fdexOff >= 0) {
      var m = [];
      for (var mi = 0; mi < 6; mi++) m.push(dv.getFloat64(fdexOff + 5 + mi * 8, true));
      if (m.every(function (v) { return isFinite(v) && Math.abs(v) < 1e7; })) mat = m;
    }
    if (stops.length) out.push({ offset: i, kind: kind, pts: pts, stops: stops, mat: mat });
  }
  return out;
};
AffinityLoader.hslToRgb = function (h, s, l) {
  if (s === 0) return [l, l, l];
  var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  function hueSegment(t) { t = (t + 1) % 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 0.5) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; }
  return [hueSegment(h + 1 / 3), hueSegment(h), hueSegment(h - 1 / 3)];
};

// Colourspace fourCCs as stored (reversed) in a "_col" struct's type tag.
AffinityLoader.colorspaceTags = function () {
  var m = {};
  m[fourCC("ABGR")] = "RGBA"; m[fourCC("ALSH")] = "HSLA";
  m[fourCC("KMYC")] = "CMYK"; m[fourCC("YARG")] = "GRAY";
  return m;
};
AffinityLoader.colorToStop = function (cs, colorChannels) {
  var rgb = cs === "HSLA" ? AffinityLoader.hslToRgb(colorChannels[0], colorChannels[1], colorChannels[2])
          : cs === "GRAY" ? [colorChannels[0], colorChannels[0], colorChannels[0]]
          : [colorChannels[0], colorChannels[1], colorChannels[2]];
  return { rgb: rgb, a: colorChannels[3] };
};

// Map every inline colour definition by its shared id. A colour is written as
// [flag=1][id:u32][tf=1][colourspace tag][_col struct of 4×f32]; gradient stops
// can reference one of these by id (flag=2) instead of repeating it inline.
AffinityLoader.scanColorDefs = function (docDat) {
  var dv = new DataView(docDat.buffer, docDat.byteOffset, docDat.byteLength);
  var n = docDat.length, map = {}, COL = fourCC("loc_"), CS = AffinityLoader.colorspaceTags();
  for (var o = 0; o < n - 31; o++) {
    if (docDat[o] === 1 && docDat[o + 5] === 1 && CS[dv.getUint32(o + 6, true)] &&
        docDat[o + 10] === 0x44 && dv.getUint32(o + 11, true) === COL) {
      var colorChannels = [dv.getFloat32(o + 15, true), dv.getFloat32(o + 19, true), dv.getFloat32(o + 23, true), dv.getFloat32(o + 27, true)];
      if (colorChannels.every(function (v) { return v >= -0.01 && v <= 1.01; }))
        map[dv.getUint32(o + 1, true)] = AffinityLoader.colorToStop(CS[dv.getUint32(o + 6, true)], colorChannels);
    }
  }
  return map;
};

// Resolve a raw gradient (unit-space Posn + stops) against a layer's bounding box
// into a renderable fill: a document-space line and stops with offsets in [0,1].
AffinityLoader.gradientFill = function (grad, bbox) {
  if (!grad || !grad.stops || !grad.stops.length) return null;
  var pts = grad.pts && grad.pts.length ? grad.pts : [[0, 0.5], [1, 0.5]];
  var p0 = pts[0], p1 = pts[pts.length - 1];
  var stops = grad.stops.map(function (s, si) {
    var u = pts[si] ? pts[si][0] : (grad.stops.length > 1 ? si / (grad.stops.length - 1) : 0);
    return { rgb: s.rgb, a: s.a == null ? 1 : s.a, loc: Math.max(0, Math.min(1, u)) };
  });
  if (grad.mat) {
    // The fill transform maps a unit gradient into document space, but the colour
    // varies with u = the inverse transform's first coord, whose gradient ∇u =
    // (d,−c)/det is the true colour-gradient direction (NOT the u-axis (a,b) — they
    // differ when the matrix is sheared). ∇u's perpendicular is (c,d), the real
    // iso-colour lines, so a plain linear gradient along ∇u reproduces the fill
    // exactly. Build the line from the u=1 iso-point through the u=0 iso-point
    // (passing through the shape centre): stop 0 sits at u=1, last stop at u=0.
    var m = grad.mat;
    var det = m[0] * m[3] - m[1] * m[2] || 1;
    var c2d2 = m[2] * m[2] + m[3] * m[3] || 1;
    var cx = bbox.x + bbox.width / 2, cy = bbox.y + bbox.height / 2;
    var uc = (m[3] * (cx - m[4]) - m[2] * (cy - m[5])) / det;   // u at the shape centre
    var sx = m[3] * det / c2d2, sy = -m[2] * det / c2d2;        // doc displacement per +1 in u
    var d0 = [cx + (1 - uc) * sx, cy + (1 - uc) * sy];          // u=1  → stop 0
    var d1 = [cx - uc * sx, cy - uc * sy];                      // u=0  → last stop
    return { kind: grad.kind, mat: m, line: { x0: d0[0], y0: d0[1], x1: d1[0], y1: d1[1] }, stops: stops };
  }
  return {
    kind: grad.kind, stops: stops,
    line: { x0: bbox.x + p0[0] * bbox.width, y0: bbox.y + p0[1] * bbox.height,
            x1: bbox.x + p1[0] * bbox.width, y1: bbox.y + p1[1] * bbox.height },
  };
};

// Affinity object transforms: "Trns"/"Xfrm" = vec_d_t<6> (6×f64 affine a,b,c,d,tx,ty).
AffinityLoader.scanTransforms = function (docDat) {
  var dv = new DataView(docDat.buffer, docDat.byteOffset, docDat.byteLength);
  var n = docDat.length, out = [], TAGS = [fourCC("snrT"), fourCC("mrfX")]; // Trns, Xfrm reversed
  for (var i = 0; i < n - 52; i++) {
    var t = dv.getUint32(i, true);
    if (TAGS.indexOf(t) >= 0) {
      var o = i + 4;
      // expect a 6-double array preceded by a small count/header; probe a couple of offsets
      for (var d = 1; d <= 6; d++) {
        var m = [];
        for (var coeffIdx = 0; coeffIdx < 6; coeffIdx++) m.push(dv.getFloat64(o + d + coeffIdx * 8, true));
        if (m.every(function (v) { return isFinite(v) && Math.abs(v) < 1e7; }) && (Math.abs(m[0]) + Math.abs(m[3]) > 1e-6)) {
          out.push({ offset: i, matrix: m }); break;
        }
      }
    }
  }
  return out;
};

// ---- small geometry/util helpers -------------------------------------------
AffinityLoader.pathBounds = function (nodes) {
  var r = new Rect();
  if (!nodes.length) return r;
  var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (var i = 0; i < nodes.length; i++) {
    var nd = nodes[i];
    minx = Math.min(minx, nd.x, nd.inX, nd.outX); miny = Math.min(miny, nd.y, nd.inY, nd.outY);
    maxx = Math.max(maxx, nd.x, nd.inX, nd.outX); maxy = Math.max(maxy, nd.y, nd.inY, nd.outY);
  }
  return new Rect(minx, miny, maxx - minx, maxy - miny);
};
AffinityLoader.contoursBounds = function (contours) {
  var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (var i = 0; i < contours.length; i++) {
    var contourBounds = AffinityLoader.pathBounds(contours[i]);
    if (!contourBounds.width && !contourBounds.height) continue;
    minx = Math.min(minx, contourBounds.x); miny = Math.min(miny, contourBounds.y);
    maxx = Math.max(maxx, contourBounds.x + contourBounds.width); maxy = Math.max(maxy, contourBounds.y + contourBounds.height);
  }
  if (!isFinite(minx)) return new Rect(0, 0, 0, 0);
  return new Rect(minx, miny, maxx - minx, maxy - miny);
};
AffinityLoader.unionBounds = function (layers) {
  var minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (var i = 0; i < layers.length; i++) {
    var layerBounds = layers[i].bbox; if (!layerBounds || layerBounds.width === 0 && layerBounds.height === 0) continue;
    minx = Math.min(minx, layerBounds.x); miny = Math.min(miny, layerBounds.y);
    maxx = Math.max(maxx, layerBounds.x + layerBounds.width); maxy = Math.max(maxy, layerBounds.y + layerBounds.height);
  }
  if (!isFinite(minx)) return new Rect(0, 0, 0, 0);
  return new Rect(minx, miny, maxx - minx, maxy - miny);
};
AffinityLoader.nearestBefore = function (arr, off) {
  var best = null; for (var i = 0; i < arr.length; i++) if (arr[i].offset <= off && (!best || arr[i].offset > best.offset)) best = arr[i]; return best;
};
AffinityLoader.nearestAfter = function (arr, off) {
  var best = null; for (var i = 0; i < arr.length; i++) if (arr[i].offset >= off && (!best || arr[i].offset < best.offset)) best = arr[i]; return best;
};
AffinityLoader.nearest = function (arr, off, maxDist) {
  var best = null, bd = maxDist == null ? Infinity : maxDist;
  for (var i = 0; i < arr.length; i++) { var dd = Math.abs(arr[i].offset - off); if (dd <= bd) { bd = dd; best = arr[i]; } }
  return best;
};
AffinityLoader.rectNodes = function (r) {
  function pt(x, y) { return { x: x, y: y, inX: x, inY: y, outX: x, outY: y }; }
  return [pt(r.x, r.y), pt(r.x + r.w, r.y), pt(r.x + r.w, r.y + r.h), pt(r.x, r.y + r.h)];
};
AffinityLoader.utf8 = function (bytes, off, len) { return new TextDecoder("utf-8").decode(bytes.subarray(off, off + len)); };

// ---- one node's bezier path as a canvas path {cmds, crds} -------------------
AffinityLoader.nodesToCanvasPath = function (nodes, closed) {
  var cmds = [], crds = [];
  AffinityLoader.appendContour(cmds, crds, nodes, closed);
  return { cmds: cmds, crds: crds };
};
// A compound path: every contour as a subpath in one canvas path. Holes/counters
// punch out under the engine's fill rule.
AffinityLoader.contoursToCanvasPath = function (contours, closed) {
  var cmds = [], crds = [];
  for (var i = 0; i < contours.length; i++) AffinityLoader.appendContour(cmds, crds, contours[i], closed);
  return { cmds: cmds, crds: crds };
};
AffinityLoader.appendContour = function (cmds, crds, nodes, closed) {
  if (!nodes.length) return;
  cmds.push("M"); crds.push(nodes[0].x, nodes[0].y);
  var segs = closed ? nodes.length : nodes.length - 1;
  for (var i = 0; i < segs; i++) {
    var a = nodes[i], nextNode = nodes[(i + 1) % nodes.length];
    cmds.push("C"); crds.push(a.outX, a.outY, nextNode.inX, nextNode.inY, nextNode.x, nextNode.y);
  }
  if (closed) cmds.push("Z");
};

// ============================================================================
// Registry entry: read the model and emit it into the document via VectorPageBuilder.
// ============================================================================
AffinityLoader.parse = function (buffer, doc, codecLoaders) {
  var model = AffinityLoader.read(buffer);

  // Document canvas at a sensible raster size (vector stays resolution-free via
  // the page matrix; this only sizes the backing buffer for preview).
  var dpi = 72;
  var docWidth = Math.max(1, model.width), docHeight = Math.max(1, model.height);
  var scale = Math.min(1, (8192) / Math.max(docWidth, docHeight));   // keep buffer within engine limits
  doc.dpi = dpi;
  doc.width = Math.round(docWidth * scale);
  doc.height = Math.round(docHeight * scale);
  doc.buffer = allocBuffer(doc.width * doc.height * 4);

  // page matrix: document space → pixel space (translate origin to 0, scale)
  var pageMatrix = new Matrix2D(scale, 0, 0, scale, -model.origin.x * scale, -model.origin.y * scale);
  var cp = new codecLoaders.VectorPageBuilder(doc, pageMatrix, false);
  // Affinity layers are independent objects; keep one Path layer per curve and do
  // not collapse adjacent same-colour fills (VectorPageBuilder's PDF-style optimisation).
  cp.mergeFills = false;
  cp.StartPage(model.origin.x, model.origin.y, model.origin.x + docWidth, model.origin.y + docHeight, docWidth * docHeight);

  // Full-canvas clip as a straight-edged rectangle so the engine recognises it as
  // the page box (UDOC.G.isBox) and does not wrap the layers in a "Mask" group.
  var ox = model.origin.x, oy = model.origin.y;
  var clip = { cmds: ["M", "L", "L", "L", "Z"], crds: [ox, oy, ox + docWidth, oy, ox + docWidth, oy + docHeight, ox, oy + docHeight] };

  // emit back-to-front: layers are top-down (index 0 = top), so paint from the
  // last (bottom) up to index 0 (top)
  for (var i = model.layers.length - 1; i >= 0; i--) {
    var layerModel = model.layers[i];
    if (!layerModel.contours || !layerModel.contours.length || !layerModel.nodes.length) continue;
    var path = AffinityLoader.contoursToCanvasPath(layerModel.contours, layerModel.closed);
    var pageState;
    if (layerModel.gradient) {
      var g = layerModel.gradient, ln = g.line;
      // VectorPageBuilder's linear gradient maps the line's midpoint→end, so pass a
      // start pre-shifted to twice the offset; the engine then spans start→end.
      pageState = {
        pth: path, cpth: clip, ca: 1,
        colr: {
          typ: g.kind === "radial" ? "rad" : "lin",
          mat: [1, 0, 0, 1, 0, 0],
          crds: [2 * ln.x0 - ln.x1, 2 * ln.y0 - ln.y1, ln.x1, ln.y1],
          grad: g.stops.map(function (s) { return [s.loc, s.rgb, s.a]; }),
        },
      };
    } else {
      var rgba = layerModel.fill || [0.5, 0.5, 0.5, 1];
      pageState = {
        pth: path,
        cpth: clip,
        colr: [rgba[0], rgba[1], rgba[2]],   // solid fill: rgb fractions
        ca: rgba[3] == null ? 1 : rgba[3],   // fill alpha
      };
    }
    var layerCountBefore = cp.doc.layers.length;
    try { cp.Fill(pageState); } catch (e) { /* skip un-fillable path */ }
    if (cp.doc.layers.length > layerCountBefore && layerModel.name) cp.getLastLayer().setName(layerModel.name);
  }
  cp.ShowPage && cp.ShowPage();
  cp.Done && cp.Done();
  doc.initArtboardDocument(1);
  doc.layers[doc.layers.length - 1].setArtboardRect(new Rect(0, 0, doc.width, doc.height));
};

export { AffinityLoader };
