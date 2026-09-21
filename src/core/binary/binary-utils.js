/**
 * Low-level binary I/O helpers: FourCC conversion, typed reads/writes, UTF-8
 * strings, buffer search, CRC, zlib chunks, and PDF string escaping. Shared by
 * PSD parsers, format codecs, and the Figma binary-schema decoder.
 */

import { Matrix2D } from "../math/matrix2d.js";
import { Rect } from "../math/rect.js";

function BinaryUtils() {}

// ---------------------------------------------------------------------------
// Shared typed-array buffers for numeric reinterpret-casts.
// All 16/32-bit read/write helpers alias into these instead of allocating.
// ---------------------------------------------------------------------------

var i16AB = new ArrayBuffer(2);
var i16Arr = new Int16Array(i16AB);
var i16Bytes = new Uint8Array(i16AB);

var i32AB = new ArrayBuffer(4);
var i32Arr = new Int32Array(i32AB);
var u32Arr = new Uint32Array(i32AB);
var i32Bytes = new Uint8Array(i32AB);
var f32Arr = new Float32Array(i32AB);

var f64AB = new ArrayBuffer(8);
var f64Arr = new Float64Array(f64AB);
var f64Bytes = new Uint8Array(f64AB);

BinaryUtils.int16Buf = i16Arr;
BinaryUtils.int16Bytes = i16Bytes;
BinaryUtils.int32Buf = i32Arr;
BinaryUtils.uint32Buf = u32Arr;
BinaryUtils.int32Bytes = i32Bytes;
BinaryUtils.float32Buf = f32Arr;

// Pre-computed character codes for PDF string escaping
var CH_BACKSLASH = 0x5C;
var CH_LPAREN = 0x28;
var CH_RPAREN = 0x29;

// ---------------------------------------------------------------------------
// FourCC (4-byte type codes used by PSD, e.g. "8BIM", "norm")
// ---------------------------------------------------------------------------

BinaryUtils.uint32ToFourCC = function (val) {
  return String.fromCharCode(
    val >> 24 & 255,
    val >> 16 & 255,
    val >> 8 & 255,
    val & 255
  );
};

BinaryUtils.fourCCToUint32 = function (str) {
  var out = 0;
  for (var i = str.length - 1; i >= 0; i--) out |= str.charCodeAt(i) << (3 - i) * 8;
  return out;
};

// ---------------------------------------------------------------------------
// Buffer search
// ---------------------------------------------------------------------------

BinaryUtils.indexOf = function (buf, byte, start, end) {
  if (start == null) start = 0;
  if (end == null) end = buf.length;
  if (end > buf.length) end = buf.length;
  for (var i = start; i < end; i++)
    if (buf[i] === byte) return i;
  return -1;
};

BinaryUtils.indexOfBytes = function (buf, needle, start) {
  if (start == null) start = 0;
  var nLen = needle.length;
  var limit = buf.length - nLen;
  if (typeof needle === "string") {
    var arr = new Array(nLen);
    for (var i = 0; i < nLen; i++) arr[i] = needle.charCodeAt(i);
    needle = arr;
  }
  if (nLen === 0) return -1;
  var first = needle[0];
  for (var i = start; i < limit; i++) {
    if (buf[i] !== first) continue;
    var match = true;
    for (var j = 1; j < nLen; j++) {
      if (buf[i + j] !== needle[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
};

BinaryUtils.indexOfAsciiString = function (buf, start, str) {
  var sLen = str.length;
  var limit = buf.length - sLen;
  for (var i = start; i < limit; i++) {
    var j = 0;
    while (j < sLen && buf[i + j] === str.charCodeAt(j)) j++;
    if (j === sLen) return i;
  }
};

// ---------------------------------------------------------------------------
// PDF string encoding (backslash-escaped UTF-16, used by PDF codec)
// ---------------------------------------------------------------------------

BinaryUtils.readPdfString = function (buf, start, end) {
  var raw = [];
  var pos = start;
  while (pos < end) {
    var byte = buf[pos++];
    if (byte === CH_BACKSLASH) raw.push(buf[pos++]);
    else raw.push(byte);
  }
  var out = [];
  for (var i = 0; i < raw.length; i += 2)
    out.push(String.fromCharCode(raw[i] << 8 | raw[i + 1]));
  return out.join("");
};

BinaryUtils.writePdfStringRaw = function (dest, pos, str) {
  var pair = new Uint8Array(2);
  for (var i = 0; i < str.length; i++) {
    BinaryUtils.writeUint16Raw(pair, 0, str.charCodeAt(i));
    if (pair[0] === CH_RPAREN || pair[0] === CH_LPAREN || pair[0] === CH_BACKSLASH) {
      dest[pos++] = CH_BACKSLASH;
    }
    dest[pos++] = pair[0];
    if (pair[1] === CH_RPAREN || pair[1] === CH_LPAREN || pair[1] === CH_BACKSLASH) {
      dest[pos++] = CH_BACKSLASH;
    }
    dest[pos++] = pair[1];
  }
  return pos;
};

BinaryUtils.writePdfString = function (wbuf, pos, str) {
  wbuf.ensureCapacity(pos, 4 * str.length);
  return BinaryUtils.writePdfStringRaw(wbuf.data, pos, str);
};

// ---------------------------------------------------------------------------
// Unicode string (UTF-16) read/write
// ---------------------------------------------------------------------------

BinaryUtils.readStringLE = function (buf, offset, charCount) {
  var parts = new Array(charCount);
  var pos = offset;
  for (var i = 0; i < charCount; i++) {
    parts[i] = String.fromCharCode(buf[pos] | buf[pos + 1] << 8);
    pos += 2;
  }
  return parts.join("");
};

BinaryUtils.readStringBE = function (buf, offset, charCount) {
  var parts = new Array(charCount);
  var pos = offset;
  for (var i = 0; i < charCount; i++) {
    parts[i] = String.fromCharCode(buf[pos] << 8 | buf[pos + 1]);
    pos += 2;
  }
  return parts.join("");
};

BinaryUtils.writeStringLERaw = function (dest, offset, str) {
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i);
    BinaryUtils.writeUint16LEraw(dest, offset + 2 * i, code);
  }
};

BinaryUtils.writeStringLE = function (dest, offset, str) {
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i);
    BinaryUtils.writeUint16Raw(dest, offset + 2 * i, code);
  }
};

BinaryUtils.writeStringLEBuf = function (wbuf, pos, str) {
  wbuf.ensureCapacity(pos, 2 * str.length);
  BinaryUtils.writeStringLE(wbuf.data, pos, str);
};

// --- length-prefixed unicode strings ---

BinaryUtils.readUnicodeStringLE = function (buf, offset) {
  var count = BinaryUtils.readFloat32(buf, offset);
  return BinaryUtils.readStringLE(buf, offset + 4, count);
};

BinaryUtils.readUnicodeString = function (buf, offset) {
  var count = BinaryUtils.readUint32BE(buf, offset);
  return BinaryUtils.readStringBE(buf, offset + 4, count);
};

BinaryUtils.readUnicodeName = function (buf, offset) {
  var count = BinaryUtils.readUint32BE(buf, offset);
  return BinaryUtils.readStringBE(buf, offset + 4, count - 1);
};

BinaryUtils.writeUnicodeStringLERaw = function (dest, offset, str) {
  BinaryUtils.writeFloat32Raw(dest, offset, str.length);
  BinaryUtils.writeStringLERaw(dest, offset + 4, str);
};

BinaryUtils.writeUnicodeStringRaw = function (dest, offset, str) {
  BinaryUtils.writeUint32BE(dest, offset, str.length);
  BinaryUtils.writeStringLE(dest, offset + 4, str);
};

BinaryUtils.writeUnicodeString = function (wbuf, pos, str) {
  wbuf.ensureCapacity(pos, 4 + 2 * str.length);
  BinaryUtils.writeUnicodeStringRaw(wbuf.data, pos, str);
};

BinaryUtils.writeUnicodeStringLE = function (wbuf, pos, str) {
  wbuf.ensureCapacity(pos, 4 + 2 * str.length);
  BinaryUtils.writeUnicodeStringLERaw(wbuf.data, pos, str);
};

// ---------------------------------------------------------------------------
// ASCII / char array
// ---------------------------------------------------------------------------

BinaryUtils.readCharArray = function (buf, offset, count) {
  var out = new Array(count);
  for (var i = 0; i < count; i++) out[i] = String.fromCharCode(buf[offset + i]);
  return out;
};

BinaryUtils.readString = function (buf, offset, count) {
  var parts = new Array(count);
  for (var i = 0; i < count; i++) parts[i] = String.fromCharCode(buf[offset + i]);
  return parts.join("");
};

BinaryUtils.writeAsciiRaw = function (dest, offset, str) {
  for (var i = 0; i < str.length; i++) dest[offset + i] = str.charCodeAt(i);
};

BinaryUtils.writeAscii = function (wbuf, pos, str) {
  wbuf.ensureCapacity(pos, str.length);
  BinaryUtils.writeAsciiRaw(wbuf.data, pos, str);
};

// ---------------------------------------------------------------------------
// UTF-8
// ---------------------------------------------------------------------------

BinaryUtils.decodeUtf8Codepoints = function (buf, pos, byteLen) {
  var codepoints = [];
  var end = pos + byteLen;
  while (pos < end) {
    var byte = buf[pos++];
    var cp;
    if ((byte & 0x80) === 0) {
      cp = byte;
    } else if ((byte & 0xE0) === 0xC0) {
      cp = (byte & 0x1F) << 6 | buf[pos++] & 0x3F;
    } else if ((byte & 0xF0) === 0xE0) {
      cp = (byte & 0x0F) << 12 | (buf[pos++] & 0x3F) << 6;
      cp |= buf[pos++] & 0x3F;
    } else if ((byte & 0xF8) === 0xF0) {
      cp = (byte & 0x07) << 18 | (buf[pos++] & 0x3F) << 12;
      cp |= (buf[pos++] & 0x3F) << 6;
      cp |= buf[pos++] & 0x3F;
    } else {
      throw "binary-utils: invalid UTF-8 lead byte";
    }
    codepoints.push(cp);
  }
  return codepoints;
};

BinaryUtils.textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8") : null;

BinaryUtils.readUtf8 = function (buf, start, byteLen) {
  if (start == null) start = 0;
  if (byteLen == null) byteLen = buf.length;
  if (BinaryUtils.textDecoder) {
    var view = start === 0 && byteLen === buf.length ? buf : buf.subarray(start, start + byteLen);
    return BinaryUtils.textDecoder.decode(view);
  }
  var cps = BinaryUtils.decodeUtf8Codepoints(buf, start, byteLen);
  var parts = new Array(cps.length);
  for (var i = 0; i < cps.length; i++) parts[i] = String.fromCharCode(cps[i]);
  return parts.join("");
};

BinaryUtils.textEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

BinaryUtils.encodeUtf8 = function (str) {
  if (BinaryUtils.textEncoder) return BinaryUtils.textEncoder.encode(str);
  var out = new Uint8Array(str.length * 4);
  var written = BinaryUtils.encodeUtf8Into(str, out, 0);
  return out.slice(0, written);
};

BinaryUtils.encodeUtf8Into = function (str, dest, destOffset) {
  var len = str.length;
  var written = 0;
  for (var i = 0; i < len; i++) {
    var cp = str.charCodeAt(i);
    if (cp < 0x80) {
      dest[destOffset + written++] = cp;
    } else if (cp < 0x800) {
      dest[destOffset + written] = 0xC0 | cp >> 6;
      dest[destOffset + written + 1] = 0x80 | cp & 0x3F;
      written += 2;
    } else if (cp < 0x10000) {
      dest[destOffset + written] = 0xE0 | cp >> 12;
      dest[destOffset + written + 1] = 0x80 | cp >> 6 & 0x3F;
      dest[destOffset + written + 2] = 0x80 | cp & 0x3F;
      written += 3;
    } else if (cp < 0x200000) {
      dest[destOffset + written] = 0xF0 | cp >> 18;
      dest[destOffset + written + 1] = 0x80 | cp >> 12 & 0x3F;
      dest[destOffset + written + 2] = 0x80 | cp >> 6 & 0x3F;
      dest[destOffset + written + 3] = 0x80 | cp & 0x3F;
      written += 4;
    } else {
      throw "binary-utils: code point out of UTF-8 range";
    }
  }
  return written;
};

BinaryUtils.readLengthPrefixedUtf8 = function (buf, offset) {
  var byteLen = BinaryUtils.readUint32BE(buf, offset);
  var str = BinaryUtils.readUtf8(buf, offset + 4, byteLen - 1);
  return { str: str, size: 4 + byteLen };
};

// ---------------------------------------------------------------------------
// Pascal string (1-byte length prefix, even-padded, ASCII)
// ---------------------------------------------------------------------------

BinaryUtils.readPascalString = function (buf, offset) {
  var strLen = buf[offset];
  var str = BinaryUtils.readString(buf, offset + 1, strLen);
  var paddedLen = strLen + (1 - strLen % 2);
  return { str: str, length: paddedLen + 1 };
};

BinaryUtils.writePascalStringRaw = function (dest, offset, str) {
  var len = str.length;
  dest[offset] = len;
  BinaryUtils.writeAsciiRaw(dest, offset + 1, str);
  if (len % 2 === 0) {
    dest[offset + 1 + len] = 0;
    ++len;
  }
  return len + 1;
};

BinaryUtils.writePascalString = function (wbuf, pos, str) {
  wbuf.ensureCapacity(pos, str.length + 2);
  return BinaryUtils.writePascalStringRaw(wbuf.data, pos, str);
};

// ---------------------------------------------------------------------------
// Debug
// ---------------------------------------------------------------------------

BinaryUtils.formatBytesDebug = function (buf, offset, count) {
  var parts = [];
  for (var i = 0; i < count; i++) {
    var byte = buf[offset + i];
    if (byte < 10) parts.push("  " + byte + ", ");
    else if (byte < 100) parts.push(" " + byte + ", ");
    else parts.push(byte + ", ");
  }
  return parts.join("");
};

// ---------------------------------------------------------------------------
// uint16
// ---------------------------------------------------------------------------

BinaryUtils.readUint16 = function (buf, offset) {
  return buf[offset] << 8 | buf[offset + 1];
};

BinaryUtils.writeUint16Raw = function (dest, offset, val) {
  dest[offset] = val >> 8 & 0xFF;
  dest[offset + 1] = val & 0xFF;
};

BinaryUtils.writeUint16 = function (wbuf, pos, val) {
  wbuf.ensureCapacity(pos, 4);
  BinaryUtils.writeUint16Raw(wbuf.data, pos, val);
};

BinaryUtils.readFixed16_16 = function (buf, offset) {
  var whole = BinaryUtils.readUint16(buf, offset);
  var frac = BinaryUtils.readUint16(buf, offset + 2);
  return whole + frac * (1 / 65536);
};

BinaryUtils.writeFixed16_16Raw = function (dest, offset, val) {
  var whole = Math.floor(val);
  var frac = Math.floor((val - whole) * 65536);
  BinaryUtils.writeUint16Raw(dest, offset, whole);
  BinaryUtils.writeUint16Raw(dest, offset + 2, frac);
};

BinaryUtils.readUint16LE = function (buf, offset) {
  return buf[offset + 1] << 8 | buf[offset];
};

BinaryUtils.writeUint16LEraw = function (dest, offset, val) {
  dest[offset + 1] = val >> 8 & 0xFF;
  dest[offset] = val & 0xFF;
};

BinaryUtils.writeUint16LE = function (wbuf, pos, val) {
  wbuf.ensureCapacity(pos, 4);
  BinaryUtils.writeUint16LEraw(wbuf.data, pos, val);
};

// ---------------------------------------------------------------------------
// int16
// ---------------------------------------------------------------------------

BinaryUtils.readInt16BE = function (buf, offset) {
  i16Bytes[0] = buf[offset + 1];
  i16Bytes[1] = buf[offset];
  return i16Arr[0];
};

BinaryUtils.readInt16LE = function (buf, offset) {
  i16Bytes[0] = buf[offset];
  i16Bytes[1] = buf[offset + 1];
  return i16Arr[0];
};

// ---------------------------------------------------------------------------
// int32 / uint32
// ---------------------------------------------------------------------------

BinaryUtils.copyBytes4 = function (src, srcOff, dest, destOff) {
  dest[destOff] = src[srcOff];
  dest[destOff + 1] = src[srcOff + 1];
  dest[destOff + 2] = src[srcOff + 2];
  dest[destOff + 3] = src[srcOff + 3];
};

BinaryUtils.readInt32BE = function (buf, offset) {
  i32Bytes[3] = buf[offset];
  i32Bytes[2] = buf[offset + 1];
  i32Bytes[1] = buf[offset + 2];
  i32Bytes[0] = buf[offset + 3];
  return i32Arr[0];
};

BinaryUtils.writeInt32BE = function (dest, offset, val) {
  i32Arr[0] = val;
  dest[offset] = i32Bytes[3];
  dest[offset + 1] = i32Bytes[2];
  dest[offset + 2] = i32Bytes[1];
  dest[offset + 3] = i32Bytes[0];
};

BinaryUtils.writeInt32 = function (wbuf, pos, val) {
  wbuf.ensureCapacity(pos, 4);
  BinaryUtils.writeInt32BE(wbuf.data, pos, val);
};

BinaryUtils.readInt32LE = function (buf, offset) {
  i32Bytes[0] = buf[offset];
  i32Bytes[1] = buf[offset + 1];
  i32Bytes[2] = buf[offset + 2];
  i32Bytes[3] = buf[offset + 3];
  return i32Arr[0];
};

BinaryUtils.writeInt32LERaw = function (dest, offset, val) {
  i32Arr[0] = val;
  dest[offset] = i32Bytes[0];
  dest[offset + 1] = i32Bytes[1];
  dest[offset + 2] = i32Bytes[2];
  dest[offset + 3] = i32Bytes[3];
};

BinaryUtils.writeInt32LE = function (wbuf, pos, val) {
  wbuf.ensureCapacity(pos, 4);
  BinaryUtils.writeInt32LERaw(wbuf.data, pos, val);
};

BinaryUtils.readUint32BE = function (buf, offset) {
  return buf[offset] * 0x1000000 + (buf[offset + 1] << 16 | buf[offset + 2] << 8 | buf[offset + 3]);
};

BinaryUtils.writeUint32BE = function (dest, offset, val) {
  dest[offset] = val >> 24 & 0xFF;
  dest[offset + 1] = val >> 16 & 0xFF;
  dest[offset + 2] = val >> 8 & 0xFF;
  dest[offset + 3] = val & 0xFF;
};

BinaryUtils.writeSize = function (wbuf, pos, val) {
  wbuf.ensureCapacity(pos, 4);
  BinaryUtils.writeUint32BE(wbuf.data, pos, val);
};

// ---------------------------------------------------------------------------
// int64
// ---------------------------------------------------------------------------

BinaryUtils.readInt64BE = function (buf, offset) {
  return BinaryUtils.readUint32BE(buf, offset) << 32 | BinaryUtils.readUint32BE(buf, offset + 4);
};

BinaryUtils.writeInt64BERaw = function (dest, offset, val) {
  BinaryUtils.writeUint32BE(dest, offset, val >> 16 >> 16);
  BinaryUtils.writeUint32BE(dest, offset + 4, val & 0xFFFFFFFF);
};

BinaryUtils.writeInt64BE = function (wbuf, pos, val) {
  wbuf.ensureCapacity(pos, 8);
  BinaryUtils.writeInt64BERaw(wbuf.data, pos, val);
};

// ---------------------------------------------------------------------------
// float32
//
// Despite the names, these read and write 4 bytes as a little-endian uint32,
// not a float: they are the generic LE-uint32 accessor (the
// readUnicodeStringLE length prefix, for one).
// ---------------------------------------------------------------------------

BinaryUtils.readFloat32 = function (buf, offset) {
  i32Bytes[0] = buf[offset];
  i32Bytes[1] = buf[offset + 1];
  i32Bytes[2] = buf[offset + 2];
  i32Bytes[3] = buf[offset + 3];
  return u32Arr[0];
};

BinaryUtils.writeFloat32Raw = function (dest, offset, val) {
  u32Arr[0] = val;
  dest[offset] = i32Bytes[0];
  dest[offset + 1] = i32Bytes[1];
  dest[offset + 2] = i32Bytes[2];
  dest[offset + 3] = i32Bytes[3];
};

BinaryUtils.writeFloat32 = function (wbuf, pos, val) {
  wbuf.ensureCapacity(pos, 4);
  BinaryUtils.writeFloat32Raw(wbuf.data, pos, val);
};

BinaryUtils.readFloat32BE = function (buf, offset) {
  i32Bytes[3] = buf[offset];
  i32Bytes[2] = buf[offset + 1];
  i32Bytes[1] = buf[offset + 2];
  i32Bytes[0] = buf[offset + 3];
  return f32Arr[0];
};

BinaryUtils.readFloat32LE = function (buf, offset) {
  i32Bytes[0] = buf[offset];
  i32Bytes[1] = buf[offset + 1];
  i32Bytes[2] = buf[offset + 2];
  i32Bytes[3] = buf[offset + 3];
  return f32Arr[0];
};

BinaryUtils.writeFloat32BERaw = function (dest, offset, val) {
  f32Arr[0] = val;
  dest[offset] = i32Bytes[3];
  dest[offset + 1] = i32Bytes[2];
  dest[offset + 2] = i32Bytes[1];
  dest[offset + 3] = i32Bytes[0];
};

BinaryUtils.writeFloat32BE = function (wbuf, pos, val) {
  wbuf.ensureCapacity(pos, 4);
  BinaryUtils.writeFloat32BERaw(wbuf.data, pos, val);
};

BinaryUtils.writeFloat32LERaw = function (dest, offset, val) {
  f32Arr[0] = val;
  dest[offset] = i32Bytes[0];
  dest[offset + 1] = i32Bytes[1];
  dest[offset + 2] = i32Bytes[2];
  dest[offset + 3] = i32Bytes[3];
};

BinaryUtils.writeFloat32LE = function (wbuf, pos, val) {
  wbuf.ensureCapacity(pos, 4);
  BinaryUtils.writeFloat32LERaw(wbuf.data, pos, val);
};

// ---------------------------------------------------------------------------
// fixed-point 8.24
// ---------------------------------------------------------------------------

BinaryUtils.readFixed8_24 = function (buf, offset) {
  return BinaryUtils.readInt32BE(buf, offset) * (1 / (1 << 24));
};

BinaryUtils.writeFixed8_24Raw = function (dest, offset, val) {
  BinaryUtils.writeInt32BE(dest, offset, Math.floor(val * (1 << 24)));
};

BinaryUtils.writeFixed8_24 = function (wbuf, pos, val) {
  wbuf.ensureCapacity(pos, 4);
  BinaryUtils.writeFixed8_24Raw(wbuf.data, pos, val);
};

// ---------------------------------------------------------------------------
// float64 — shared f64AB buffer avoids per-call allocation
// ---------------------------------------------------------------------------

BinaryUtils.readFloat64BE = function (buf, offset) {
  f64Bytes[7] = buf[offset];
  f64Bytes[6] = buf[offset + 1];
  f64Bytes[5] = buf[offset + 2];
  f64Bytes[4] = buf[offset + 3];
  f64Bytes[3] = buf[offset + 4];
  f64Bytes[2] = buf[offset + 5];
  f64Bytes[1] = buf[offset + 6];
  f64Bytes[0] = buf[offset + 7];
  return f64Arr[0];
};

BinaryUtils.readFloat64LE = function (buf, offset) {
  f64Bytes[0] = buf[offset];
  f64Bytes[1] = buf[offset + 1];
  f64Bytes[2] = buf[offset + 2];
  f64Bytes[3] = buf[offset + 3];
  f64Bytes[4] = buf[offset + 4];
  f64Bytes[5] = buf[offset + 5];
  f64Bytes[6] = buf[offset + 6];
  f64Bytes[7] = buf[offset + 7];
  return f64Arr[0];
};

BinaryUtils.writeFloat64BERaw = function (dest, offset, val) {
  f64Arr[0] = val;
  dest[offset] = f64Bytes[7];
  dest[offset + 1] = f64Bytes[6];
  dest[offset + 2] = f64Bytes[5];
  dest[offset + 3] = f64Bytes[4];
  dest[offset + 4] = f64Bytes[3];
  dest[offset + 5] = f64Bytes[2];
  dest[offset + 6] = f64Bytes[1];
  dest[offset + 7] = f64Bytes[0];
};

BinaryUtils.writeFloat64BE = function (wbuf, pos, val) {
  wbuf.ensureCapacity(pos, 8);
  BinaryUtils.writeFloat64BERaw(wbuf.data, pos, val);
};

// ---------------------------------------------------------------------------
// Rect (PSD int32-BE: top, left, bottom, right)
// ---------------------------------------------------------------------------

BinaryUtils.readRect = function (buf, offset) {
  var top = BinaryUtils.readInt32BE(buf, offset);
  var left = BinaryUtils.readInt32BE(buf, offset + 4);
  var bottom = BinaryUtils.readInt32BE(buf, offset + 8);
  var right = BinaryUtils.readInt32BE(buf, offset + 12);
  return new Rect(left, top, right - left, bottom - top);
};

BinaryUtils.writePsdRectRaw = function (dest, offset, rect) {
  BinaryUtils.writeInt32BE(dest, offset, rect.y);
  BinaryUtils.writeInt32BE(dest, offset + 4, rect.x);
  BinaryUtils.writeInt32BE(dest, offset + 8, rect.y + rect.height);
  BinaryUtils.writeInt32BE(dest, offset + 12, rect.x + rect.width);
};

BinaryUtils.writePsdRect = function (wbuf, pos, rect) {
  wbuf.ensureCapacity(pos, 16);
  BinaryUtils.writePsdRectRaw(wbuf.data, pos, rect);
};

BinaryUtils.readFloat32Rect = function (buf, offset) {
  var left = BinaryUtils.readFloat32BE(buf, offset);
  var top = BinaryUtils.readFloat32BE(buf, offset + 4);
  var right = BinaryUtils.readFloat32BE(buf, offset + 8);
  var bottom = BinaryUtils.readFloat32BE(buf, offset + 12);
  return new Rect(left, top, right - left, bottom - top);
};

BinaryUtils.writeFloat32RectRaw = function (dest, offset, rect) {
  BinaryUtils.writeFloat32BERaw(dest, offset, rect.x);
  BinaryUtils.writeFloat32BERaw(dest, offset + 4, rect.y);
  BinaryUtils.writeFloat32BERaw(dest, offset + 8, rect.x + rect.width);
  BinaryUtils.writeFloat32BERaw(dest, offset + 12, rect.y + rect.height);
};

BinaryUtils.writeFloat32Rect = function (wbuf, pos, rect) {
  wbuf.ensureCapacity(pos, 16);
  BinaryUtils.writeFloat32RectRaw(wbuf.data, pos, rect);
};

// ---------------------------------------------------------------------------
// Matrix2D (6x float64 BE)
// ---------------------------------------------------------------------------

BinaryUtils.readMatrix2D = function (buf, offset) {
  var matrix = new Matrix2D;
  matrix.a = BinaryUtils.readFloat64BE(buf, offset);
  matrix.b = BinaryUtils.readFloat64BE(buf, offset + 8);
  matrix.c = BinaryUtils.readFloat64BE(buf, offset + 16);
  matrix.d = BinaryUtils.readFloat64BE(buf, offset + 24);
  matrix.tx = BinaryUtils.readFloat64BE(buf, offset + 32);
  matrix.ty = BinaryUtils.readFloat64BE(buf, offset + 40);
  return matrix;
};

BinaryUtils.writeMatrix2DRaw = function (dest, offset, matrix) {
  BinaryUtils.writeFloat64BERaw(dest, offset, matrix.a);
  BinaryUtils.writeFloat64BERaw(dest, offset + 8, matrix.b);
  BinaryUtils.writeFloat64BERaw(dest, offset + 16, matrix.c);
  BinaryUtils.writeFloat64BERaw(dest, offset + 24, matrix.d);
  BinaryUtils.writeFloat64BERaw(dest, offset + 32, matrix.tx);
  BinaryUtils.writeFloat64BERaw(dest, offset + 40, matrix.ty);
};

BinaryUtils.writeMatrix2D = function (wbuf, pos, matrix) {
  wbuf.ensureCapacity(pos, 48);
  BinaryUtils.writeMatrix2DRaw(wbuf.data, pos, matrix);
};

// ---------------------------------------------------------------------------
// Raw byte copy / fill
// ---------------------------------------------------------------------------

BinaryUtils.readBytes = function (buf, offset, count) {
  return buf.slice(offset, offset + count);
};

BinaryUtils.writeBytesRaw = function (dest, offset, bytes) {
  dest.set(bytes, offset);
};

BinaryUtils.writeBytes = function (wbuf, pos, bytes) {
  wbuf.ensureCapacity(pos, bytes.length);
  BinaryUtils.writeBytesRaw(wbuf.data, pos, bytes);
};

BinaryUtils.fillBytesRaw = function (dest, offset, value, count) {
  if (!count) count = 1;
  dest.fill(value, offset, offset + count);
};

BinaryUtils.fillBytes = function (wbuf, pos, value, count) {
  if (!count) count = 1;
  wbuf.ensureCapacity(pos, count);
  BinaryUtils.fillBytesRaw(wbuf.data, pos, value, count);
};


export { BinaryUtils };
