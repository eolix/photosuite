/**
 * LayerStyleRow visibility affordance.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let LayerStyleRow;

before(async () => {
  ({ LayerStyleRow } = await import("../../../src/ui/panels/layer-style-row.js"));
});

describe("ui/panels/layer-style-row.js", () => {
  it("setVisible adjusts eye icon opacity", () => {
    const row = Object.create(LayerStyleRow.prototype);
    row.styleVisibilityEyeEl = {
      setAttribute() {},
      style: {},
    };
    LayerStyleRow.prototype.setVisible.call(row, false);
    assert.equal(row.styleVisibilityEyeEl.style.opacity, 0.2);
    LayerStyleRow.prototype.setVisible.call(row, true);
    assert.equal(row.styleVisibilityEyeEl.style.opacity, 1);
  });
});
