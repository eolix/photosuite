/**
 * effect-pickers descriptor / scale goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ensureContourPointContinuityFlags;
let buildPatternPtrnDescriptor;
let buildShadowOffsetDescriptor;
let computePatternPreviewScales;
let ContourButton;
let PatternPickerButton;
let ShadowOffsetWidget;
let DEFAULT_PATTERN_URL;

before(async () => {
  ({
    ensureContourPointContinuityFlags,
    buildPatternPtrnDescriptor,
    buildShadowOffsetDescriptor,
    computePatternPreviewScales,
    ContourButton,
    PatternPickerButton,
    ShadowOffsetWidget,
    DEFAULT_PATTERN_URL
  } = await import("../../../../src/ui/widgets/controls/effect-pickers.js"));
});

describe("ui/widgets/controls/effect-pickers.js", () => {
  it("buildShadowOffsetDescriptor absolute / percent goldens", () => {
    assert.deepEqual(buildShadowOffsetDescriptor(10, -5, false), {
      classID: "Pnt",
      Hrzn: { v: 10, t: "doub" },
      Vrtc: { v: -5, t: "doub" }
    });
    assert.deepEqual(buildShadowOffsetDescriptor(25, 50, true), {
      classID: "Pnt",
      Hrzn: { t: "UntF", v: { type: "#Prc", val: 25 } },
      Vrtc: { t: "UntF", v: { type: "#Prc", val: 50 } }
    });
  });

  it("buildPatternPtrnDescriptor wire shape", () => {
    assert.deepEqual(buildPatternPtrnDescriptor("Clouds", "id-1"), {
      classID: "Ptrn",
      Nm: { t: "TEXT", v: "Clouds" },
      Idnt: { t: "TEXT", v: "id-1" }
    });
  });

  it("computePatternPreviewScales goldens", () => {
    assert.deepEqual(computePatternPreviewScales(50, 50, 100, 100), {
      scaleY: 0.5,
      scaleXClamped: 0.5
    });
    assert.deepEqual(computePatternPreviewScales(50, 50, 1000, 10), {
      scaleY: 0.05,
      scaleXClamped: 0.2
    });
  });

  it("ensureContourPointContinuityFlags fills missing Cnty", () => {
    var points = [
      { v: { Hrzn: { v: 0 }, Vrtc: { v: 0 } } },
      { v: { Hrzn: { v: 255 }, Vrtc: { v: 255 }, Cnty: { t: "bool", v: false } } }
    ];
    ensureContourPointContinuityFlags(points);
    assert.deepEqual(points[0].v.Cnty, { t: "bool", v: true });
    assert.deepEqual(points[1].v.Cnty, { t: "bool", v: false });
  });

  it("DEFAULT_PATTERN_URL + constructors", () => {
    assert.equal(DEFAULT_PATTERN_URL, "resources/basic/default.pat");
    assert.equal(typeof ContourButton, "function");
    assert.equal(typeof PatternPickerButton, "function");
    assert.equal(typeof ShadowOffsetWidget, "function");
  });
});
