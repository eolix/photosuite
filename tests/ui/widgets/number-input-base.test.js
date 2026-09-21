/**
 * NumberInputBase value-math / format goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let mapValueToLogRangeSlider;
let mapLogRangeSliderToValue;
let formatNumericFieldDisplay;
let snapMagnitudeNearRangeSpan;
let resolveDoubleClickRangeMidpoint;
let computeQuantityWheelStep;
let scanLeadingNumericPrefixLength;
let NumberInputBase;

before(async () => {
  ({
    mapValueToLogRangeSlider,
    mapLogRangeSliderToValue,
    formatNumericFieldDisplay,
    snapMagnitudeNearRangeSpan,
    resolveDoubleClickRangeMidpoint,
    computeQuantityWheelStep,
    scanLeadingNumericPrefixLength,
    NumberInputBase
  } = await import("../../../src/ui/widgets/number-input-base.js"));
});

describe("ui/widgets/number-input-base.js", () => {
  it("snapMagnitudeNearRangeSpan rounds wide spans above 10", () => {
    assert.equal(snapMagnitudeNearRangeSpan(12.3, 0, 100), 12);
    assert.equal(snapMagnitudeNearRangeSpan(12.3, 0, 40), 12.3);
    assert.equal(snapMagnitudeNearRangeSpan(5.5, 0, 100), 5.5);
  });

  it("formatNumericFieldDisplay unit spacing goldens", () => {
    assert.equal(formatNumericFieldDisplay(10, 0, false, "%"), "10");
    assert.equal(formatNumericFieldDisplay(1.5, 1, true, "px"), "1.5 px");
    assert.equal(formatNumericFieldDisplay(50, 0, true, "%"), "50%");
    assert.equal(formatNumericFieldDisplay(50, 0, true, "px"), "50 px");
  });

  it("log range map endpoints and mid golden", () => {
    assert.equal(mapValueToLogRangeSlider(0, 0, 100), 0);
    assert.equal(mapValueToLogRangeSlider(100, 0, 100), 400);
    assert.equal(mapValueToLogRangeSlider(50, 0, 100), 309.4335503653203);
    assert.ok(Math.abs(mapLogRangeSliderToValue(309.4335503653203, 0, 100) - 50) < 1e-9);
  });

  it("resolveDoubleClickRangeMidpoint goldens", () => {
    assert.equal(resolveDoubleClickRangeMidpoint(-50, 50), 0);
    assert.equal(resolveDoubleClickRangeMidpoint(0, 5), 1);
    assert.equal(resolveDoubleClickRangeMidpoint(0, 100), 50);
  });

  it("computeQuantityWheelStep goldens", () => {
    assert.equal(computeQuantityWheelStep(10, 0, 1, false), 1);
    assert.equal(computeQuantityWheelStep(2, 1, 1, false), 0.1);
    assert.equal(computeQuantityWheelStep(2, 1, 1, true), 1);
    assert.equal(computeQuantityWheelStep(2, 1, -1, false), -0.1);
  });

  it("scanLeadingNumericPrefixLength stops at unit text", () => {
    assert.equal(scanLeadingNumericPrefixLength("12.5px"), 4);
    assert.equal(scanLeadingNumericPrefixLength("100%"), 3);
    assert.equal(scanLeadingNumericPrefixLength(""), 0);
  });

  it("exports NumberInputBase constructor", () => {
    assert.equal(typeof NumberInputBase, "function");
  });

  // Dialogs that host either a TextInput or a slider-backed numeric field call
  // focusAndSelectAll() when they open. Both widget families must answer to the
  // same name or opening the slider variant throws before its initial value is
  // published to the caller.
  it("shares the focusAndSelectAll name with TextInput", () => {
    assert.equal(typeof NumberInputBase.prototype.focusAndSelectAll, "function");
    let selected = false;
    let focused = false;
    NumberInputBase.prototype.focusAndSelectAll.call({
      inputEl: {
        select() { selected = true; },
        focus() { focused = true; }
      }
    });
    assert.equal(selected, true);
    assert.equal(focused, true);
  });
});
