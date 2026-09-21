/**
 * Photoshop 10-byte colour record codec (colour space + four channels) for swatch
 * libraries and PSD layer fields. Swatch file loading lives in `features/swatch/`.
 */

import { BinaryUtils } from "../../../core/binary/binary-utils.js";
import { hsvToRgb, labToRgb } from "../../../engine/compositing/color-math.js";
import { psdColorToRgb } from "../../../engine/compositing/psd-color-utils.js";

/** Photoshop color-space tag: RGB (0–255 in channels 0–2). */
const SWATCH_COLOR_SPACE_RGB = 0;
/** Photoshop color-space tag: HSV. */
const SWATCH_COLOR_SPACE_HSV = 1;
/** Photoshop color-space tag: CMYK. */
const SWATCH_COLOR_SPACE_CMYK = 2;
/** Photoshop color-space tag: Lab. */
const SWATCH_COLOR_SPACE_LAB = 7;
/** Photoshop color-space tag: grayscale. */
const SWATCH_COLOR_SPACE_GRAY = 8;

function SwatchColorCodec() {}

SwatchColorCodec.readSwatchColorAt = function (bytes, offset) {
  var readUint16 = BinaryUtils.readUint16,
    readInt16 = BinaryUtils.readInt16BE,
    colorSpace = readUint16(bytes, offset);
  offset += 2;
  var channel0 = readUint16(bytes, offset);
  offset += 2;
  var channel1 = readUint16(bytes, offset);
  offset += 2;
  var channel2 = readUint16(bytes, offset);
  offset += 2;
  var channel3 = readUint16(bytes, offset);
  offset += 2;
  if (colorSpace == SWATCH_COLOR_SPACE_RGB) {
    return readRgbSwatchColor(channel0, channel1, channel2);
  }
  if (colorSpace == SWATCH_COLOR_SPACE_HSV) {
    return readHsvSwatchColor(channel0, channel1, channel2);
  }
  if (colorSpace == SWATCH_COLOR_SPACE_CMYK) {
    return readCmykSwatchColor(channel0, channel1, channel2, channel3);
  }
  if (colorSpace == SWATCH_COLOR_SPACE_LAB) {
    return readLabSwatchColor(bytes, offset, channel0);
  }
  if (colorSpace == SWATCH_COLOR_SPACE_GRAY) {
    return readGraySwatchColor(channel0, channel1, channel2);
  }
  throw "e " + colorSpace + ", ";
};

SwatchColorCodec.writeSwatchColorAt = function (bytes, offset, color) {
  var rgbScale = 65535 / 255,
    writeUint16 = BinaryUtils.writeUint16Raw;
  writeUint16(bytes, offset, SWATCH_COLOR_SPACE_RGB);
  writeUint16(bytes, offset + 2, Math.round(color.h * rgbScale));
  writeUint16(bytes, offset + 4, Math.round(color.l * rgbScale));
  writeUint16(bytes, offset + 6, Math.round(color.O * rgbScale));
  writeUint16(bytes, offset + 8, 0);
};

function readRgbSwatchColor(channel0, channel1, channel2) {
  var byteScale = 255 / 65535;
  return {
    h: channel0 * byteScale,
    l: channel1 * byteScale,
    O: channel2 * byteScale,
  };
}

function readHsvSwatchColor(channel0, channel1, channel2) {
  var rgbScale = 1 / 65535,
    color = hsvToRgb(channel0 * rgbScale, channel1 * rgbScale, channel2 * rgbScale);
  color.h *= 255;
  color.l *= 255;
  color.O *= 255;
  return color;
}

function readCmykSwatchColor(channel0, channel1, channel2, channel3) {
  var cmykScale = 100 / 65535;
  return psdColorToRgb({
    classID: "CMYC",
    Cyn: { t: "doub", v: 100 - channel0 * cmykScale },
    Mgnt: { t: "doub", v: 100 - channel1 * cmykScale },
    Ylw: { t: "doub", v: 100 - channel2 * cmykScale },
    Blck: { t: "doub", v: 100 - channel3 * cmykScale },
  });
}

function readLabSwatchColor(bytes, offset, channel0) {
  var readInt16 = BinaryUtils.readInt16BE;
  return labToRgb(
    channel0 / 100,
    readInt16(bytes, offset - 6) / 100,
    readInt16(bytes, offset - 4) / 100,
  );
}

function readGraySwatchColor(channel0, channel1, channel2) {
  var grayScale = 255 / 1e4;
  return {
    h: 255 - channel0 * grayScale,
    l: 255 - channel1 * grayScale,
    O: 255 - channel2 * grayScale,
  };
}

export { SwatchColorCodec };
