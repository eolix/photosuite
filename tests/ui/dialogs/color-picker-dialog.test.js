/**
 * Golden I/O for ColorPickerDialog pure helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ColorPickerDialog;

before(async () => {
  ({ ColorPickerDialog } = await import("../../../src/ui/dialogs/color-picker-dialog.js"));
});

describe("ui/dialogs/color-picker-dialog.js", () => {
  it("packRgbIntFromNormalizedChannels packs {h,l,O}", () => {
    const proto = ColorPickerDialog.prototype;
    assert.equal(proto.packRgbIntFromNormalizedChannels({ h: 0, l: 0, O: 0 }), 0);
    assert.equal(proto.packRgbIntFromNormalizedChannels({ h: 1, l: 1, O: 1 }), 0xffffff);
    assert.equal(proto.packRgbIntFromNormalizedChannels({ h: 1, l: 0, O: 0 }), 0xff0000);
    assert.equal(
      proto.packRgbIntFromNormalizedChannels({ h: 0.5, l: 0.25, O: 0.125 }),
      (128 << 16) | (64 << 8) | 32
    );
  });

  it("clamp helpers bound RGB bytes and unit floats", () => {
    const proto = ColorPickerDialog.prototype;
    assert.equal(proto.clampRgbByte(300), 255);
    assert.equal(proto.clampRgbByte(-1), 0);
    assert.equal(proto.clampUnitFloat(1.5), 1);
    assert.equal(proto.clampUnitFloat(-0.1), 0);
  });
});
