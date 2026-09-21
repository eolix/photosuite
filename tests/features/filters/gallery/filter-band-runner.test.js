import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

let FilterBandRunner;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ FilterBandRunner } = await import("../../../../src/features/filters/gallery/filter-band-runner.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("filter-gallery/filter-band-runner.js", () => {
  it("setPoolSize updates pool size", () => {
    const prev = FilterBandRunner.poolSize;
    FilterBandRunner.setPoolSize(3);
    assert.equal(FilterBandRunner.poolSize, 3);
    FilterBandRunner.setPoolSize(prev);
  });

  it("exports benchFilter helper", () => {
    assert.equal(typeof FilterBandRunner.benchFilter, "function");
  });
});
