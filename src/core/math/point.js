/**
 * 2D point (x, y). Falsy constructor args become 0 (same as `x || 0`).
 *
 * Also hosts {@link Point.vec4} and {@link Point.mat4} — small Float32Array helpers
 * used by 3D-style pipelines (column-major 4×4 layout).
 */
function Point(x, y) {
  this.x = x || 0;
  this.y = y || 0;
}

Point.prototype.add = function (other) {
  return new Point(this.x + other.x, this.y + other.y);
};

Point.prototype.clone = function () {
  return new Point(this.x, this.y);
};

Point.prototype.copyFrom = function (other) {
  this.x = other.x;
  this.y = other.y;
};

Point.prototype.equals = function (other) {
  return this.x == other.x && this.y == other.y;
};

/** Scales this vector to length `targetLength` (in place). */
Point.prototype.normalize = function (targetLength) {
  var len = Math.sqrt(this.x * this.x + this.y * this.y);
  this.x *= targetLength / len;
  this.y *= targetLength / len;
};

Point.prototype.offset = function (dx, dy) {
  this.x += dx;
  this.y += dy;
};

Point.prototype.setXY = function (x, y) {
  this.x = x;
  this.y = y;
};

Point.prototype.subtract = function (other) {
  return new Point(this.x - other.x, this.y - other.y);
};

/** Distance between two points. */
Point.dist = function (a, b) {
  return Point.distance(a.x, a.y, b.x, b.y);
};

Point.lerp = function (from, to, t) {
  return new Point(from.x + t * (to.x - from.x), from.y + t * (to.y - from.y));
};

Point.fromPolar = function (radius, angle) {
  return new Point(radius * Math.cos(angle), radius * Math.sin(angle));
};

Point.distance = function (x1, y1, x2, y2) {
  var dx = x2 - x1;
  var dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
};

// ---------------------------------------------------------------------------
// vec4 (homogeneous 4-vectors, Float32Array length 4)
// ---------------------------------------------------------------------------

Point.vec4 = {};

Point.vec4.create = function () {
  return new Float32Array(4);
};

Point.vec4.add = function (a, b, out) {
  out[0] = a[0] + b[0];
  out[1] = a[1] + b[1];
  out[2] = a[2] + b[2];
  out[3] = a[3] + b[3];
};

Point.vec4.set = function (src, dest) {
  dest[0] = src[0];
  dest[1] = src[1];
  dest[2] = src[2];
  dest[3] = src[3];
};

// ---------------------------------------------------------------------------
// mat4 (column-major 4×4, Float32Array length 16)
// ---------------------------------------------------------------------------

Point.mat4 = {};

Point.mat4.create = function (source) {
  var out = new Float32Array(16);
  out[0] = out[5] = out[10] = out[15] = 1;
  if (source) Point.mat4.set(source, out);
  return out;
};

Point.mat4.set = function (src, dest) {
  for (var i = 0; i < 16; i++) dest[i] = src[i];
};

/** out = left × right (column-major). */
Point.mat4.multiply = function (left, right, out) {
  var a00 = left[0];
  var a01 = left[1];
  var a02 = left[2];
  var a03 = left[3];
  var a10 = left[4];
  var a11 = left[5];
  var a12 = left[6];
  var a13 = left[7];
  var a20 = left[8];
  var a21 = left[9];
  var a22 = left[10];
  var a23 = left[11];
  var a30 = left[12];
  var a31 = left[13];
  var a32 = left[14];
  var a33 = left[15];

  var b0 = right[0];
  var b1 = right[1];
  var b2 = right[2];
  var b3 = right[3];

  out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

  b0 = right[4];
  b1 = right[5];
  b2 = right[6];
  b3 = right[7];

  out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

  b0 = right[8];
  b1 = right[9];
  b2 = right[10];
  b3 = right[11];

  out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

  b0 = right[12];
  b1 = right[13];
  b2 = right[14];
  b3 = right[15];

  out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;

  return out;
};

/** Writes inverse of `src` into `dest`; returns null if singular. */
Point.mat4.inverse = function (src, dest) {
  var m00 = src[0];
  var m01 = src[1];
  var m02 = src[2];
  var m03 = src[3];
  var m10 = src[4];
  var m11 = src[5];
  var m12 = src[6];
  var m13 = src[7];
  var m20 = src[8];
  var m21 = src[9];
  var m22 = src[10];
  var m23 = src[11];
  var m30 = src[12];
  var m31 = src[13];
  var m32 = src[14];
  var m33 = src[15];

  var det2x2_00 = m00 * m11 - m01 * m10;
  var det2x2_01 = m00 * m12 - m02 * m10;
  var det2x2_02 = m00 * m13 - m03 * m10;
  var det2x2_10 = m01 * m12 - m02 * m11;
  var det2x2_11 = m01 * m13 - m03 * m11;
  var det2x2_12 = m02 * m13 - m03 * m12;
  var det2x2_20 = m20 * m31 - m21 * m30;
  var det2x2_21 = m20 * m32 - m22 * m30;
  var det2x2_22 = m20 * m33 - m23 * m30;
  var det2x2_30 = m21 * m32 - m22 * m31;
  var det2x2_31 = m21 * m33 - m23 * m31;
  var det2x2_32 = m22 * m33 - m23 * m32;

  var det =
    det2x2_00 * det2x2_32 -
    det2x2_01 * det2x2_31 +
    det2x2_02 * det2x2_30 +
    det2x2_10 * det2x2_22 -
    det2x2_11 * det2x2_21 +
    det2x2_12 * det2x2_20;

  if (!det) {
    return null;
  }

  var invDet = 1 / det;

  dest[0] = (m11 * det2x2_32 - m12 * det2x2_31 + m13 * det2x2_30) * invDet;
  dest[1] = (m02 * det2x2_31 - m01 * det2x2_32 - m03 * det2x2_30) * invDet;
  dest[2] = (m31 * det2x2_12 - m32 * det2x2_11 + m33 * det2x2_10) * invDet;
  dest[3] = (m22 * det2x2_11 - m20 * det2x2_12 - m23 * det2x2_10) * invDet;
  dest[4] = (m12 * det2x2_22 - m10 * det2x2_32 - m13 * det2x2_21) * invDet;
  dest[5] = (m00 * det2x2_32 - m02 * det2x2_22 + m03 * det2x2_21) * invDet;
  dest[6] = (m32 * det2x2_02 - m30 * det2x2_12 - m33 * det2x2_01) * invDet;
  dest[7] = (m20 * det2x2_12 - m22 * det2x2_02 + m23 * det2x2_01) * invDet;
  dest[8] = (m10 * det2x2_31 - m11 * det2x2_22 + m13 * det2x2_20) * invDet;
  dest[9] = (m01 * det2x2_22 - m00 * det2x2_31 - m03 * det2x2_20) * invDet;
  dest[10] = (m30 * det2x2_11 - m31 * det2x2_02 + m33 * det2x2_00) * invDet;
  dest[11] = (m21 * det2x2_02 - m20 * det2x2_11 - m23 * det2x2_00) * invDet;
  dest[12] = (m11 * det2x2_21 - m10 * det2x2_30 - m12 * det2x2_20) * invDet;
  dest[13] = (m00 * det2x2_30 - m01 * det2x2_21 + m02 * det2x2_20) * invDet;
  dest[14] = (m31 * det2x2_01 - m30 * det2x2_10 - m32 * det2x2_00) * invDet;
  dest[15] = (m20 * det2x2_10 - m21 * det2x2_01 + m22 * det2x2_00) * invDet;

  return dest;
};

/** 2D affine slice: out[0..1] = mat × (point[0], point[1], 0, 1) in XY. */
Point.mat4.transformPoint2D = function (mat, point, out) {
  var x = point[0];
  var y = point[1];
  out[0] = x * mat[0] + y * mat[4] + mat[12];
  out[1] = x * mat[1] + y * mat[5] + mat[13];
};

Point.mat4.transformVec4 = function (mat, vec, out) {
  var x = vec[0];
  var y = vec[1];
  var z = vec[2];
  var wComponent = vec[3];
  out[0] = mat[0] * x + mat[4] * y + mat[8] * z + mat[12] * wComponent;
  out[1] = mat[1] * x + mat[5] * y + mat[9] * z + mat[13] * wComponent;
  out[2] = mat[2] * x + mat[6] * y + mat[10] * z + mat[14] * wComponent;
  out[3] = mat[3] * x + mat[7] * y + mat[11] * z + mat[15] * wComponent;
};

export { Point };

/**
 * Snap a drag to the nearest 45-degree axis through its start point, keeping
 * the drag's length. A drag more than twice as long on one axis as the other
 * flattens onto that axis; anything between goes diagonal. Held-shift drags of
 * gradients, pen segments, shapes, lasso edges and transform handles all
 * constrain through here.
 *
 * @param {Point} startPoint
 * @param {Point} endpointPoint
 * @returns {Point}
 */
export function constrainEndpointToAxis(startPoint, endpointPoint) {
  if (startPoint.equals(endpointPoint)) return startPoint;
  var deltaX = endpointPoint.x - startPoint.x,
    deltaY = endpointPoint.y - startPoint.y,
    absDeltaX = Math.abs(deltaX),
    absDeltaY = Math.abs(deltaY);
  if (absDeltaX > absDeltaY) absDeltaY = absDeltaX / 2 > absDeltaY ? 0 : absDeltaX;
  if (absDeltaY > absDeltaX) absDeltaX = absDeltaY / 2 > absDeltaX ? 0 : absDeltaY;
  var signedDeltaX = deltaX > 0 ? absDeltaX : -absDeltaX,
    signedDeltaY = deltaY > 0 ? absDeltaY : -absDeltaY,
    scaleFactor = Math.sqrt(deltaX * deltaX + deltaY * deltaY) / Math.sqrt(signedDeltaX * signedDeltaX + signedDeltaY * signedDeltaY);
  return new Point(startPoint.x + signedDeltaX * scaleFactor, startPoint.y + signedDeltaY * scaleFactor);
}
