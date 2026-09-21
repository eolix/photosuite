/**
 * 4×4 affine color matrices (column-major) for channel mixing, hue/saturation
 * shifts, and RGBA buffer transforms.
 */

/** 4×4 affine color matrix stored in column-major 16-element arrays. */

const AFFINE_IDENTITY = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];

const BYTE_BIAS = 255;

const XYZ_TO_RGB_3X3 = [3.1338561, -1.6168667, -0.4906146, -0.9787684, 1.9161415, 0.033454, 0.0719453, -0.2289914, 1.4052427];

const XYZ_TO_RGB_ALT_3X3 = [1.9624274, -0.6105343, -0.3413404, -0.9787684, 1.9161415, 0.033454, 0.0286869, -0.1406752, 1.3487655];

export function clampToByte(value) {
  const rounded = ~~(value + 0.5);
  if (rounded < 0) {
    return 0;
  }
  if (rounded > 255) {
    return 255;
  }
  return rounded;
}

function applyAffineToRgb(red, green, blue, matrix) {
  return [
    clampToByte(matrix[0] * red + matrix[1] * green + matrix[2] * blue + matrix[3] * BYTE_BIAS),
    clampToByte(matrix[4] * red + matrix[5] * green + matrix[6] * blue + matrix[7] * BYTE_BIAS),
    clampToByte(matrix[8] * red + matrix[9] * green + matrix[10] * blue + matrix[11] * BYTE_BIAS),
  ];
}

export function transformPlanarRgb(src, dst, matrix) {
  const count = src.h.length;
  for (let idx = 0; idx < count; idx++) {
    const [outRed, outGreen, outBlue] = applyAffineToRgb(src.h[idx], src.l[idx], src.O[idx], matrix);
    dst.h[idx] = outRed;
    dst.l[idx] = outGreen;
    dst.O[idx] = outBlue;
  }
}

export function transformInterleaved(src, dst, matrix) {
  const length = src.length;
  for (let idx = 0; idx < length; idx += 4) {
    const [outRed, outGreen, outBlue] = applyAffineToRgb(src[idx], src[idx + 1], src[idx + 2], matrix);
    dst[idx] = outRed;
    dst[idx + 1] = outGreen;
    dst[idx + 2] = outBlue;
  }
}

export function buildChannelMatrix(scales) {
  const sum = scales[0] + scales[1] + scales[2];
  const matrix = AFFINE_IDENTITY.slice();
  if (sum == 1) {
    const oneIndex = scales.indexOf(1);
    matrix[oneIndex] = matrix[oneIndex + 4] = matrix[oneIndex + 8] = 1;
  } else {
    matrix[0] = scales[0];
    matrix[5] = scales[1];
    matrix[10] = scales[2];
  }
  return matrix;
}

export function colorTranslationMatrix(red, green, blue) {
  return [1, 0, 0, red, 0, 1, 0, green, 0, 0, 1, blue, 0, 0, 0, 1];
}

export function colorScaleMatrix(red, green, blue) {
  return [red, 0, 0, 0, 0, green, 0, 0, 0, 0, blue, 0, 0, 0, 0, 1];
}

export function to3x3(matrix) {
  return [matrix[0], matrix[1], matrix[2], matrix[4], matrix[5], matrix[6], matrix[8], matrix[9], matrix[10]];
}

export function from3x3(matrix) {
  return [matrix[0], matrix[1], matrix[2], 0, matrix[3], matrix[4], matrix[5], 0, matrix[6], matrix[7], matrix[8], 0, 0, 0, 0, 1];
}

export function multiplyVec4(matrix, vector) {
  return [
    matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2] + matrix[3] * vector[3],
    matrix[4] * vector[0] + matrix[5] * vector[1] + matrix[6] * vector[2] + matrix[7] * vector[3],
    matrix[8] * vector[0] + matrix[9] * vector[1] + matrix[10] * vector[2] + matrix[11] * vector[3],
    matrix[12] * vector[0] + matrix[13] * vector[1] + matrix[14] * vector[2] + matrix[15] * vector[3],
  ];
}

export function transposeColorMatrix(matrix) {
  return [
    matrix[0], matrix[4], matrix[8], matrix[12],
    matrix[1], matrix[5], matrix[9], matrix[13],
    matrix[2], matrix[6], matrix[10], matrix[14],
    matrix[3], matrix[7], matrix[11], matrix[15],
  ];
}

export function multiplyColorMatrices(matrixA, matrixB) {
  const result = [];
  result[0] = matrixA[0] * matrixB[0] + matrixA[1] * matrixB[4] + matrixA[2] * matrixB[8] + matrixA[3] * matrixB[12];
  result[1] = matrixA[0] * matrixB[1] + matrixA[1] * matrixB[5] + matrixA[2] * matrixB[9] + matrixA[3] * matrixB[13];
  result[2] = matrixA[0] * matrixB[2] + matrixA[1] * matrixB[6] + matrixA[2] * matrixB[10] + matrixA[3] * matrixB[14];
  result[3] = matrixA[0] * matrixB[3] + matrixA[1] * matrixB[7] + matrixA[2] * matrixB[11] + matrixA[3] * matrixB[15];
  result[4] = matrixA[4] * matrixB[0] + matrixA[5] * matrixB[4] + matrixA[6] * matrixB[8] + matrixA[7] * matrixB[12];
  result[5] = matrixA[4] * matrixB[1] + matrixA[5] * matrixB[5] + matrixA[6] * matrixB[9] + matrixA[7] * matrixB[13];
  result[6] = matrixA[4] * matrixB[2] + matrixA[5] * matrixB[6] + matrixA[6] * matrixB[10] + matrixA[7] * matrixB[14];
  result[7] = matrixA[4] * matrixB[3] + matrixA[5] * matrixB[7] + matrixA[6] * matrixB[11] + matrixA[7] * matrixB[15];
  result[8] = matrixA[8] * matrixB[0] + matrixA[9] * matrixB[4] + matrixA[10] * matrixB[8] + matrixA[11] * matrixB[12];
  result[9] = matrixA[8] * matrixB[1] + matrixA[9] * matrixB[5] + matrixA[10] * matrixB[9] + matrixA[11] * matrixB[13];
  result[10] = matrixA[8] * matrixB[2] + matrixA[9] * matrixB[6] + matrixA[10] * matrixB[10] + matrixA[11] * matrixB[14];
  result[11] = matrixA[8] * matrixB[3] + matrixA[9] * matrixB[7] + matrixA[10] * matrixB[11] + matrixA[11] * matrixB[15];
  result[12] = matrixA[12] * matrixB[0] + matrixA[13] * matrixB[4] + matrixA[14] * matrixB[8] + matrixA[15] * matrixB[12];
  result[13] = matrixA[12] * matrixB[1] + matrixA[13] * matrixB[5] + matrixA[14] * matrixB[9] + matrixA[15] * matrixB[13];
  result[14] = matrixA[12] * matrixB[2] + matrixA[13] * matrixB[6] + matrixA[14] * matrixB[10] + matrixA[15] * matrixB[14];
  result[15] = matrixA[12] * matrixB[3] + matrixA[13] * matrixB[7] + matrixA[14] * matrixB[11] + matrixA[15] * matrixB[15];
  return result;
}

export function invertColorMatrix(matrix) {
  const inverse = [];
  inverse[0] = matrix[5] * matrix[10] * matrix[15] - matrix[5] * matrix[14] * matrix[11] - matrix[6] * matrix[9] * matrix[15] + matrix[6] * matrix[13] * matrix[11] + matrix[7] * matrix[9] * matrix[14] - matrix[7] * matrix[13] * matrix[10];
  inverse[1] = -matrix[1] * matrix[10] * matrix[15] + matrix[1] * matrix[14] * matrix[11] + matrix[2] * matrix[9] * matrix[15] - matrix[2] * matrix[13] * matrix[11] - matrix[3] * matrix[9] * matrix[14] + matrix[3] * matrix[13] * matrix[10];
  inverse[2] = matrix[1] * matrix[6] * matrix[15] - matrix[1] * matrix[14] * matrix[7] - matrix[2] * matrix[5] * matrix[15] + matrix[2] * matrix[13] * matrix[7] + matrix[3] * matrix[5] * matrix[14] - matrix[3] * matrix[13] * matrix[6];
  inverse[3] = -matrix[1] * matrix[6] * matrix[11] + matrix[1] * matrix[10] * matrix[7] + matrix[2] * matrix[5] * matrix[11] - matrix[2] * matrix[9] * matrix[7] - matrix[3] * matrix[5] * matrix[10] + matrix[3] * matrix[9] * matrix[6];
  inverse[4] = -matrix[4] * matrix[10] * matrix[15] + matrix[4] * matrix[14] * matrix[11] + matrix[6] * matrix[8] * matrix[15] - matrix[6] * matrix[12] * matrix[11] - matrix[7] * matrix[8] * matrix[14] + matrix[7] * matrix[12] * matrix[10];
  inverse[5] = matrix[0] * matrix[10] * matrix[15] - matrix[0] * matrix[14] * matrix[11] - matrix[2] * matrix[8] * matrix[15] + matrix[2] * matrix[12] * matrix[11] + matrix[3] * matrix[8] * matrix[14] - matrix[3] * matrix[12] * matrix[10];
  inverse[6] = -matrix[0] * matrix[6] * matrix[15] + matrix[0] * matrix[14] * matrix[7] + matrix[2] * matrix[4] * matrix[15] - matrix[2] * matrix[12] * matrix[7] - matrix[3] * matrix[4] * matrix[14] + matrix[3] * matrix[12] * matrix[6];
  inverse[7] = matrix[0] * matrix[6] * matrix[11] - matrix[0] * matrix[10] * matrix[7] - matrix[2] * matrix[4] * matrix[11] + matrix[2] * matrix[8] * matrix[7] + matrix[3] * matrix[4] * matrix[10] - matrix[3] * matrix[8] * matrix[6];
  inverse[8] = matrix[4] * matrix[9] * matrix[15] - matrix[4] * matrix[13] * matrix[11] - matrix[5] * matrix[8] * matrix[15] + matrix[5] * matrix[12] * matrix[11] + matrix[7] * matrix[8] * matrix[13] - matrix[7] * matrix[12] * matrix[9];
  inverse[9] = -matrix[0] * matrix[9] * matrix[15] + matrix[0] * matrix[13] * matrix[11] + matrix[1] * matrix[8] * matrix[15] - matrix[1] * matrix[12] * matrix[11] - matrix[3] * matrix[8] * matrix[13] + matrix[3] * matrix[12] * matrix[9];
  inverse[10] = matrix[0] * matrix[5] * matrix[15] - matrix[0] * matrix[13] * matrix[7] - matrix[1] * matrix[4] * matrix[15] + matrix[1] * matrix[12] * matrix[7] + matrix[3] * matrix[4] * matrix[13] - matrix[3] * matrix[12] * matrix[5];
  inverse[11] = -matrix[0] * matrix[5] * matrix[11] + matrix[0] * matrix[9] * matrix[7] + matrix[1] * matrix[4] * matrix[11] - matrix[1] * matrix[8] * matrix[7] - matrix[3] * matrix[4] * matrix[9] + matrix[3] * matrix[8] * matrix[5];
  inverse[12] = -matrix[4] * matrix[9] * matrix[14] + matrix[4] * matrix[13] * matrix[10] + matrix[5] * matrix[8] * matrix[14] - matrix[5] * matrix[12] * matrix[10] - matrix[6] * matrix[8] * matrix[13] + matrix[6] * matrix[12] * matrix[9];
  inverse[13] = matrix[0] * matrix[9] * matrix[14] - matrix[0] * matrix[13] * matrix[10] - matrix[1] * matrix[8] * matrix[14] + matrix[1] * matrix[12] * matrix[10] + matrix[2] * matrix[8] * matrix[13] - matrix[2] * matrix[12] * matrix[9];
  inverse[14] = -matrix[0] * matrix[5] * matrix[14] + matrix[0] * matrix[13] * matrix[6] + matrix[1] * matrix[4] * matrix[14] - matrix[1] * matrix[12] * matrix[6] - matrix[2] * matrix[4] * matrix[13] + matrix[2] * matrix[12] * matrix[5];
  inverse[15] = matrix[0] * matrix[5] * matrix[10] - matrix[0] * matrix[9] * matrix[6] - matrix[1] * matrix[4] * matrix[10] + matrix[1] * matrix[8] * matrix[6] + matrix[2] * matrix[4] * matrix[9] - matrix[2] * matrix[8] * matrix[5];
  const determinant = matrix[0] * inverse[0] + matrix[1] * inverse[4] + matrix[2] * inverse[8] + matrix[3] * inverse[12];
  for (let idx = 0; idx < 16; idx++) {
    inverse[idx] /= determinant;
  }
  return inverse;
}

export function colorMatrixDeterminant(matrix) {
  const cofactor0 = matrix[5] * matrix[10] * matrix[15] - matrix[5] * matrix[14] * matrix[11] - matrix[6] * matrix[9] * matrix[15] + matrix[6] * matrix[13] * matrix[11] + matrix[7] * matrix[9] * matrix[14] - matrix[7] * matrix[13] * matrix[10];
  const cofactor1 = -matrix[4] * matrix[10] * matrix[15] + matrix[4] * matrix[14] * matrix[11] + matrix[6] * matrix[8] * matrix[15] - matrix[6] * matrix[12] * matrix[11] - matrix[7] * matrix[8] * matrix[14] + matrix[7] * matrix[12] * matrix[10];
  const cofactor2 = matrix[4] * matrix[9] * matrix[15] - matrix[4] * matrix[13] * matrix[11] - matrix[5] * matrix[8] * matrix[15] + matrix[5] * matrix[12] * matrix[11] + matrix[7] * matrix[8] * matrix[13] - matrix[7] * matrix[12] * matrix[9];
  const cofactor3 = -matrix[4] * matrix[9] * matrix[14] + matrix[4] * matrix[13] * matrix[10] + matrix[5] * matrix[8] * matrix[14] - matrix[5] * matrix[12] * matrix[10] - matrix[6] * matrix[8] * matrix[13] + matrix[6] * matrix[12] * matrix[9];
  return matrix[0] * cofactor0 + matrix[1] * cofactor1 + matrix[2] * cofactor2 + matrix[3] * cofactor3;
}

/** sRGB primaries: the 4x4 forms of the XYZ conversions, built once. */
export const xyzToRgb = from3x3(XYZ_TO_RGB_3X3);
export const xyzToRgbAlt = from3x3(XYZ_TO_RGB_ALT_3X3);
export const rgbToXyz = invertColorMatrix(xyzToRgb);
