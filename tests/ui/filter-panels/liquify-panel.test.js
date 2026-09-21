/**
 * Liquify (LqFy) panel helpers + dialog-size goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let FilterParameterPanel;
let buildLiquifyToolbarSpec;
let computePreferredLiquifyDialogSize;
let resolveLiquifyToolStrength;
let ensureDisplacementMapForPreview;
let LIQUIFY_TOOL_STRENGTH_TABLE;
let LIQUIFY_DEFAULT_PARAM_VALUES;

before(async () => {
  await import("../../../src/ui/filter-panels/filter-parameter-panel.js");
  ({
    buildLiquifyToolbarSpec,
    computePreferredLiquifyDialogSize,
    resolveLiquifyToolStrength,
    ensureDisplacementMapForPreview,
    LIQUIFY_TOOL_STRENGTH_TABLE,
    LIQUIFY_DEFAULT_PARAM_VALUES,
  } = await import("../../../src/ui/filter-panels/liquify-panel.js"));
  ({ FilterParameterPanel } = await import("../../../src/ui/filter-panels/filter-parameter-panel.js"));
});

describe("ui/filter-panels/liquify-panel.js", () => {
  it("registers LqFy and opens as a modal with preferred size goldens", () => {
    assert.equal(typeof FilterParameterPanel.LqFy, "function");
    const proto = FilterParameterPanel.LqFy.prototype;
    assert.equal(proto.opensAsModalDialog(), true);
    assert.deepEqual(proto.getPreferredDialogSize(2000, 1500), { width: 1120, height: 800 });
    assert.deepEqual(proto.getPreferredDialogSize(500, 300), { width: 500, height: 300 });
    assert.deepEqual(computePreferredLiquifyDialogSize(2000, 1500), { width: 1120, height: 800 });
  });

  it("toolbar / strength / default param goldens", () => {
    const spec = buildLiquifyToolbarSpec();
    assert.equal(spec.toolbarGroups.length, 7);
    assert.deepEqual(
      spec.toolbarGroups.map((group) => group[0].tool.id),
      [0, 1, 2, 3, 4, 5, 6],
    );
    assert.equal(spec.toolbarGroups[0][0].tool.iconId, "liq/smudge");
    assert.equal(spec.toolbarGroups[6][0].tool.iconId, "liq/pleft");
    assert.deepEqual(LIQUIFY_DEFAULT_PARAM_VALUES, [100, 50, 100, false, 100]);
    assert.equal(LIQUIFY_TOOL_STRENGTH_TABLE.length, 14);
    assert.equal(resolveLiquifyToolStrength(0, 0), .005);
    assert.equal(resolveLiquifyToolStrength(0, 1), .015);
    assert.equal(resolveLiquifyToolStrength(0, 0.5), (.005 + .015) / 2);
  });

  it("ensureDisplacementMapForPreview upsamples undersized maps", () => {
    const small = {
      gridWidth: 10,
      gridHeight: 10,
      map: new Float32Array(10 * 10 * 2),
    };
    const next = ensureDisplacementMapForPreview(small, 400, 300);
    assert.equal(next.gridWidth, 100);
    assert.equal(next.gridHeight, 75);
    assert.equal(next.map.length, 100 * 75 * 2);

    const largeEnough = {
      gridWidth: 200,
      gridHeight: 150,
      map: new Float32Array(2),
    };
    assert.equal(ensureDisplacementMapForPreview(largeEnough, 400, 300), largeEnough);
  });
});
