import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { BinaryUtils } from "../../../../src/core/binary/binary-utils.js";
import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let SwatchColorCodec;
let restoreBrowserGlobals;

/** Goldens from SwatchColorCodec.read/writeSwatchColorAt. */
const GOLDEN_RGB_BYTES = [0, 0, 128, 128, 64, 64, 32, 32, 0, 0];
const GOLDEN_RGB_OUT = [128, 64, 32];
const GOLDEN_GRAY_OUT = [229.5, 204, 178.5];
const GOLDEN_HSV_OUT = [0, 127.4961088603559, 127.50194552529183];

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../../src/engine/layer-system.js");
  ({ SwatchColorCodec } = await import(
    "../../../../src/document/formats/psd/swatch-color-codec.js"
  ));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/formats/psd/swatch-color-codec.js", () => {

  it("writeSwatchColorAt then readSwatchColorAt round-trips RGB space 0", () => {
    const bytes = new Uint8Array(10);
    SwatchColorCodec.writeSwatchColorAt(bytes, 0, { h: 128, l: 64, O: 32 });
    assert.deepEqual(Array.from(bytes), GOLDEN_RGB_BYTES);
    const color = SwatchColorCodec.readSwatchColorAt(bytes, 0);
    assert.deepEqual([color.h, color.l, color.O], GOLDEN_RGB_OUT);
  });

  it("readSwatchColorAt decodes gray color space 8", () => {
    const bytes = new Uint8Array(10);
    BinaryUtils.writeUint16Raw(bytes, 0, 8);
    BinaryUtils.writeUint16Raw(bytes, 2, 1000);
    BinaryUtils.writeUint16Raw(bytes, 4, 2000);
    BinaryUtils.writeUint16Raw(bytes, 6, 3000);
    const color = SwatchColorCodec.readSwatchColorAt(bytes, 0);
    assert.deepEqual([color.h, color.l, color.O], GOLDEN_GRAY_OUT);
  });

  it("readSwatchColorAt decodes HSV color space 1", () => {
    const bytes = new Uint8Array(10);
    BinaryUtils.writeUint16Raw(bytes, 0, 1);
    BinaryUtils.writeUint16Raw(bytes, 2, 32768);
    BinaryUtils.writeUint16Raw(bytes, 4, 65535);
    BinaryUtils.writeUint16Raw(bytes, 6, 32768);
    const color = SwatchColorCodec.readSwatchColorAt(bytes, 0);
    assert.deepEqual([color.h, color.l, color.O], GOLDEN_HSV_OUT);
  });

  it("readSwatchColorAt throws on unknown color space", () => {
    const bytes = new Uint8Array(10);
    BinaryUtils.writeUint16Raw(bytes, 0, 99);
    assert.throws(() => SwatchColorCodec.readSwatchColorAt(bytes, 0), /e 99/);
  });
});
