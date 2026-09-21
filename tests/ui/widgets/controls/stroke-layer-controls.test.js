/**
 * stroke-layer-controls pure helper goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let computeUnitScale;
let parseDashPatternTokens;
let strokeCanvasLineCap;
let strokeCanvasLineJoin;
let formatAspectRatioLabel;
let filterPresetIndicesBySearchQuery;
let buildFillMaskValueFromStroke;
let cloneContourShapeData;
let ContourSizeButton;
let StrokeButton;
let StrokeWidget;
let LayerEffectOption;

before(async () => {
  ({
    computeUnitScale,
    parseDashPatternTokens,
    strokeCanvasLineCap,
    strokeCanvasLineJoin,
    formatAspectRatioLabel,
    filterPresetIndicesBySearchQuery,
    buildFillMaskValueFromStroke,
    cloneContourShapeData,
    ContourSizeButton,
    StrokeButton,
    StrokeWidget,
    LayerEffectOption
  } = await import("../../../../src/ui/widgets/controls/stroke-layer-controls.js"));
});

describe("ui/widgets/controls/stroke-layer-controls.js", () => {
  it("computeUnitScale goldens", () => {
    assert.equal(computeUnitScale(2, 72).toFixed(4), "0.3528");
    assert.equal(computeUnitScale(3, 72).toFixed(4), "0.0139");
  });

  it("parseDashPatternTokens goldens", () => {
    assert.deepEqual(parseDashPatternTokens("4 2 1"), ["4", "2"]);
    assert.deepEqual(parseDashPatternTokens("4 2 1 3 5"), ["4", "2", "1", "3"]);
  });

  it("stroke canvas cap/join goldens", () => {
    assert.equal(strokeCanvasLineCap(1), "round");
    assert.equal(strokeCanvasLineJoin(2), "bevel");
  });

  it("formatAspectRatioLabel goldens", () => {
    assert.equal(formatAspectRatioLabel(1920, 1080), "  16 : 9");
    assert.equal(formatAspectRatioLabel(800, 600), "  4 : 3");
  });

  it("filterPresetIndicesBySearchQuery golden", () => {
    var presets = [{ categoryName: "Star" }, { categoryName: "Arrow" }];
    assert.deepEqual(filterPresetIndicesBySearchQuery(presets, "ar"), [0, 1]);
  });

  it("buildFillMaskValueFromStroke goldens", () => {
    assert.deepEqual(buildFillMaskValueFromStroke(false, null, ["solidColorLayer"]), { fillKind: 0 });
    var strokeContent = { classID: "gradientLayer" };
    assert.deepEqual(buildFillMaskValueFromStroke(true, strokeContent, ["solidColorLayer", "gradientLayer"]), {
      fillKind: 2,
      fillDescriptor: strokeContent
    });
  });

  it("exports constructors", () => {
    assert.equal(typeof ContourSizeButton, "function");
    assert.equal(typeof StrokeButton, "function");
    assert.equal(typeof StrokeWidget, "function");
    assert.equal(typeof LayerEffectOption, "function");
    assert.equal(typeof ContourSizeButton.renderShapePreviewDataUrl, "function");
    assert.equal(typeof cloneContourShapeData, "function");
  });
});
