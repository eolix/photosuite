/**
 * builtin FilterParameterPanel registration + setFields goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let FilterParameterPanel;
let FilterDefs;
let BlendModes;

const BUILTIN_PANEL_KEYS = [
  "Bokh", "oilPaint", "TrcC", "Dfs ", "Embs", "Wnd ", "lightFilterGradient", "LnsF",
  "Clds", "DfrC", "blendOptions", "adaptCorrect", "boxblur", "GsnB", "MtnB",
  "RdlB", "Dspl", "Pnch", "Plr ", "Rple", "Shr ", "Sphr", "Twrl", "Wave", "surfaceBlur",
  "AdNs", "DstS", "Mdn ", "ClrH", "Crst", "Mztn", "Msc ", "Pntl", "smartSharpen",
  "UnsM", "HghP", "Mxm ", "Mnm ", "Ofst",
];

before(async () => {
  await import("../../../src/ui/filter-panels/filter-parameter-panel.js");
  await import("../../../src/ui/filter-panels/builtin-filter-panels.js");
  ({ FilterParameterPanel } = await import("../../../src/ui/filter-panels/filter-parameter-panel.js"));
  ({ FilterDefs } = await import("../../../src/features/filters/filter-apply.js"));
  ({ BlendModes } = await import("../../../src/document/model/blend-modes.js"));
});

function setFieldsSelf(extra = {}) {
  return {
    paramWidgets: [{ setItems() {}, setValue() {} }],
    mezzotintTypeWireIds: "FnDt MdmD GrnD CrsD ShrL MdmL LngL ShSt MdmS LngS".split(" "),
    ...extra,
  };
}

function captureSetFields(panelKey, valueCount, mutateDescriptor) {
  const descriptor = FilterDefs.create(panelKey);
  if (mutateDescriptor) mutateDescriptor(descriptor);
  const values = new Array(valueCount).fill(0);
  FilterParameterPanel[panelKey].prototype.setFields.call(setFieldsSelf(), descriptor, values);
  return values;
}

describe("ui/filter-panels/builtin-filter-panels.js", () => {
  it("registers every builtin filter panel constructor", () => {
    for (const key of BUILTIN_PANEL_KEYS) {
      assert.equal(typeof FilterParameterPanel[key], "function", JSON.stringify(key));
    }
  });

  it("setFields goldens for simple wire panels", () => {
    assert.deepEqual(captureSetFields("TrcC", 2), [128, 0]);
    assert.deepEqual(captureSetFields("Dfs ", 1), [0]);
    assert.deepEqual(captureSetFields("Wnd ", 2), [0, 1]);
    assert.deepEqual(
      captureSetFields("blendOptions", 2, (descriptor) => {
        descriptor.Opct.v.val = 55;
        descriptor.Md.v.blendMode = BlendModes.psdNames[2];
      }),
      [2, 55],
    );
    assert.deepEqual(captureSetFields("boxblur", 1), [15]);
    assert.deepEqual(captureSetFields("RdlB", 4), [10, 0, 0.5, 0.5]);
    assert.deepEqual(captureSetFields("Sphr", 2), [100, 0]);
    assert.deepEqual(captureSetFields("surfaceBlur", 2), [15, 15]);
    assert.deepEqual(captureSetFields("smartSharpen", 2), [150, 1]);
    assert.deepEqual(captureSetFields("Crst", 1), [10]);
    assert.deepEqual(captureSetFields("Pntl", 1), [10]);
    assert.deepEqual(captureSetFields("Mdn ", 1), [7]);
    assert.deepEqual(captureSetFields("lightFilterGradient", 6), [0, 100, false, 100, 100, 100]);
    assert.deepEqual(captureSetFields("LnsF", 4), [100, 0, 19, 19]);
    assert.deepEqual(captureSetFields("Clds", 1), ["1857132644"]);
    assert.deepEqual(captureSetFields("adaptCorrect", 7), [50, 25, 12, 0, 0, 0, 0]);
    assert.deepEqual(captureSetFields("Wave", 10), [1, 101, 102, 36, 37, 100, 100, 0, 0, 743887]);
    assert.deepEqual(captureSetFields("ClrH", 4), [8, 10, 40, 70]);
    assert.deepEqual(captureSetFields("oilPaint", 7), [3, 2, 1, 0, true, 1, 45]);
    assert.deepEqual(captureSetFields("Mztn", 1), [0]);
    assert.equal(FilterParameterPanel.LnsF.prototype.hasOverlay(), true);
    assert.equal(
      FilterParameterPanel.DfrC.prototype.setFields,
      FilterParameterPanel.Clds.prototype.setFields,
    );
  });

  it("Bokh setFields golden", () => {
    assert.deepEqual(captureSetFields("Bokh", 10), [0, 0, 3, 30, 0, 0, 255, 0, 0, false]);
  });
});
