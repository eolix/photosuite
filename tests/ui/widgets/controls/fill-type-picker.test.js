/**
 * FillTypePicker preview cache-key goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let buildFillPreviewCacheKey;
let FillTypePicker;
let FILL_TYPE_LABEL_KEYS;

before(async () => {
  ({
    buildFillPreviewCacheKey,
    FillTypePicker,
    FILL_TYPE_LABEL_KEYS
  } = await import("../../../../src/ui/widgets/controls/fill-type-picker.js"));
});

describe("ui/widgets/controls/fill-type-picker.js", () => {
  it("buildFillPreviewCacheKey goldens", () => {
    assert.equal(buildFillPreviewCacheKey({ fillKind: 0 }), "empty");
    assert.equal(
      buildFillPreviewCacheKey({
        fillKind: 1,
        fillDescriptor: {
          Clr: {
            v: {
              classID: "RGBC",
              Rd: { t: "doub", v: 255 },
              Grn: { t: "doub", v: 0 },
              Bl: { t: "doub", v: 0 }
            }
          }
        }
      }),
      "255,0,0"
    );
    assert.equal(
      buildFillPreviewCacheKey({
        fillKind: 3,
        fillDescriptor: { Ptrn: { v: { Idnt: { v: "pat-9" } } } }
      }),
      "pat-9"
    );
  });

  it("FILL_TYPE_LABEL_KEYS + constructor", () => {
    assert.equal(FILL_TYPE_LABEL_KEYS.length, 4);
    assert.equal(typeof FillTypePicker, "function");
    assert.equal(FillTypePicker.buildFillPreviewCacheKey, buildFillPreviewCacheKey);
  });
});
