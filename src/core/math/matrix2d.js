import { Point } from "./point.js";

var NEAR_ZERO = 1e-9;

/**
 * 2D affine transform stored as column vectors:
 *
 *   | a  c  tx |     x' = a*x + c*y + tx
 *   | b  d  ty |     y' = b*x + d*y + ty
 *   | 0  0   1 |
 *
 * Constructor args: (a, b, c, d, tx, ty). Called with no args → identity.
 */
function Matrix2D(matA, matB, matC, matD, translateX, translateY) {
  if (typeof matA === "undefined") {
    this.a = 1;
    this.b = 0;
    this.c = 0;
    this.d = 1;
    this.tx = 0;
    this.ty = 0;
  } else {
    this.a = matA;
    this.b = matB;
    this.c = matC;
    this.d = matD;
    this.tx = translateX;
    this.ty = translateY;
  }
}

/** Uniform scale magnitude √( |det| ), det = a·d − b·c. */
Matrix2D.prototype.getScale = function () {
  return Math.sqrt(Math.abs(this.a * this.d - this.b * this.c));
};

/** Snaps components with |v| < 1e-9 to zero (in place). */
Matrix2D.prototype.roundNearZero = function () {
  var matA = this.a;
  var matB = this.b;
  var matC = this.c;
  var matD = this.d;
  var translateX = this.tx;
  var translateY = this.ty;
  this.a = Math.abs(matA) < NEAR_ZERO ? 0 : matA;
  this.b = Math.abs(matB) < NEAR_ZERO ? 0 : matB;
  this.c = Math.abs(matC) < NEAR_ZERO ? 0 : matC;
  this.d = Math.abs(matD) < NEAR_ZERO ? 0 : matD;
  this.tx = Math.abs(translateX) < NEAR_ZERO ? 0 : translateX;
  this.ty = Math.abs(translateY) < NEAR_ZERO ? 0 : translateY;
};

Matrix2D.prototype.transformPoint = function (point) {
  var x = point.x;
  var y = point.y;
  return new Point(
    x * this.a + y * this.c + this.tx,
    x * this.b + y * this.d + this.ty
  );
};

Matrix2D.prototype.translate = function (dx, dy) {
  this.tx += dx;
  this.ty += dy;
};

/** Post-multiplies by a rotation matrix (angle in radians). */
Matrix2D.prototype.rotate = function (angle) {
  var cos = Math.cos(angle);
  var sin = Math.sin(angle);
  var matA = this.a;
  var matB = this.b;
  var matC = this.c;
  var matD = this.d;
  var translateX = this.tx;
  var translateY = this.ty;
  this.a = matA * cos + matB * sin;
  this.b = -matA * sin + matB * cos;
  this.c = matC * cos + matD * sin;
  this.d = -matC * sin + matD * cos;
  this.tx = translateX * cos + translateY * sin;
  this.ty = -translateX * sin + translateY * cos;
};

/** Post-multiplies by a scale matrix. */
Matrix2D.prototype.scale = function (sx, sy) {
  this.a *= sx;
  this.b *= sy;
  this.c *= sx;
  this.d *= sy;
  this.tx *= sx;
  this.ty *= sy;
};

/** Replaces this with this × other (apply other after this when transforming points). */
Matrix2D.prototype.concat = function (other) {
  var a1 = this.a;
  var b1 = this.b;
  var c1 = this.c;
  var d1 = this.d;
  var tx1 = this.tx;
  var ty1 = this.ty;
  var a2 = other.a;
  var b2 = other.b;
  var c2 = other.c;
  var d2 = other.d;
  this.a = a1 * a2 + b1 * c2;
  this.b = a1 * b2 + b1 * d2;
  this.c = c1 * a2 + d1 * c2;
  this.d = c1 * b2 + d1 * d2;
  this.tx = tx1 * a2 + ty1 * c2 + other.tx;
  this.ty = tx1 * b2 + ty1 * d2 + other.ty;
};

/** Replaces this with its inverse (in place). */
Matrix2D.prototype.invert = function () {
  var matA = this.a;
  var matB = this.b;
  var matC = this.c;
  var matD = this.d;
  var translateX = this.tx;
  var translateY = this.ty;
  var det = matA * matD - matB * matC;
  var invDet = 1 / det;
  this.a = matD * invDet;
  this.b = -matB * invDet;
  this.c = -matC * invDet;
  this.d = matA * invDet;
  this.tx = (matC * translateY - matD * translateX) * invDet;
  this.ty = (matB * translateX - matA * translateY) * invDet;
};

Matrix2D.prototype.clone = function () {
  return new Matrix2D(this.a, this.b, this.c, this.d, this.tx, this.ty);
};

Matrix2D.prototype.copyFrom = function (source) {
  this.a = source.a;
  this.b = source.b;
  this.c = source.c;
  this.d = source.d;
  this.tx = source.tx;
  this.ty = source.ty;
};

export { Matrix2D };

/**
 * Average absolute scale of a 2x3 matrix, with any rotation removed first.
 * A transform handle uses it to show one scale figure for a rotated box.
 * @param {Matrix2D} matrix
 */
export function scaleIgnoringRotation(matrix) {
  const matrixCopy = matrix.clone();
  const rotationAngle = Math.atan2(-matrixCopy.b, matrixCopy.a);
  const unrotateMatrix = new Matrix2D();
  unrotateMatrix.rotate(-rotationAngle);
  matrixCopy.concat(unrotateMatrix);
  return (Math.abs(matrixCopy.a) + Math.abs(matrixCopy.d)) / 2;
}
