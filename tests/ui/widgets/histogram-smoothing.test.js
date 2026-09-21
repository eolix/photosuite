/**
 * Histogram smoothing: what the Camera Raw window plots.
 *
 * Develop output is quantised to eight bits, so output levels the tone mapping
 * never lands on read as empty and the plot combs. Smoothing is display-only,
 * and it must leave a histogram's trailing totals — pixel count and alpha sum —
 * alone, because the plot's vertical scale is derived from them.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let smoothHistogramBins;

before(async () => {
  ({ smoothHistogramBins } = await import("../../../src/ui/widgets/controls/panel-widgets.js"));
});

/** A comb: every other bin empty, as freshly quantised output produces. */
function combedBins() {
  const bins = new Float64Array(256);
  for (let binIdx = 40; binIdx < 200; binIdx += 2) bins[binIdx] = 1000;
  return bins;
}

describe("ui/widgets histogram smoothing", () => {
  it("fills the gaps a comb leaves without moving the total", () => {
    const raw = combedBins();
    const smoothed = smoothHistogramBins(raw, 2);
    for (let binIdx = 60; binIdx < 180; binIdx++) {
      assert.ok(smoothed[binIdx] > 0, `bin ${binIdx} still empty after smoothing`);
    }
    const sum = (bins) => { let t = 0; for (let i = 0; i < 256; i++) t += bins[i]; return t; };
    assert.ok(Math.abs(sum(smoothed) - sum(raw)) / sum(raw) < 0.02, "smoothing should conserve the population");
  });

  it("flattens the comb by an order of magnitude", () => {
    const raw = combedBins();
    const smoothed = smoothHistogramBins(raw, 2);
    const largestStep = (bins) => {
      let step = 0;
      for (let binIdx = 61; binIdx < 180; binIdx++) {
        step = Math.max(step, Math.abs(bins[binIdx] - bins[binIdx - 1]));
      }
      return step;
    };
    const before = largestStep(raw);
    const after = largestStep(smoothed);
    assert.ok(after * 8 < before, `comb only fell from ${before.toFixed(0)} to ${after.toFixed(0)}`);
  });

  it("leaves a flat distribution flat", () => {
    const flat = new Float64Array(256).fill(500);
    const smoothed = smoothHistogramBins(flat, 2);
    for (let binIdx = 10; binIdx < 246; binIdx++) {
      assert.ok(Math.abs(smoothed[binIdx] - 500) < 1e-9, "flat input should be unchanged away from the edges");
    }
  });
});
