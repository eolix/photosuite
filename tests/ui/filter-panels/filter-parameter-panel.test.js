/**
 * FilterParameterPanel base + getFilterPanelConstructorOrFallback
 * (includes the folded filter-panel-registry resolver).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let FilterParameterPanel;
let getFilterPanelConstructorOrFallback;
let FilterDefs;

before(async () => {
  ({ FilterParameterPanel, getFilterPanelConstructorOrFallback } = await import(
    "../../../src/ui/filter-panels/filter-parameter-panel.js"
  ));
  await import("../../../src/ui/filter-panels/builtin-filter-panels.js");
  await import("../../../src/ui/filter-panels/adjustment-panels.js");
  ({ FilterDefs } = await import("../../../src/features/filters/filter-apply.js"));
});

describe("ui/filter-panels/filter-parameter-panel.js", () => {
  it("base stubs", () => {
    const panel = new FilterParameterPanel("thrs");
    assert.equal(panel.opensAsModalDialog(), false);
    assert.equal(panel.hasOverlay(), false);
    assert.equal(panel.getPreferredDialogSize(), null);
    assert.deepEqual(panel.linkedRangePairIndices, []);
  });

  it("setValue/getValue round-trip via subclass setFields", () => {
    const panel = new FilterParameterPanel.boxblur();
    const descriptor = FilterDefs.create("boxblur");
    descriptor.Rds.v.val = 33;
    panel.setValue(descriptor);
    assert.equal(panel.getValue().Rds.v.val, 33);
  });

  it("setValue treats 5th arg as dialog extra when 6th is omitted", () => {
    // Displace reads the dialog extra to name the map its descriptor points at:
    // `DspF` carries a linked-file tag, the extra carries that document's items.
    const panel = new FilterParameterPanel.Dspl();
    const descriptor = FilterDefs.create("Dspl");
    descriptor.DspF.v.pth = "tag1";
    panel.setValue(descriptor, null, null, null, [[{ fileName: " a.psd ", tag: "tag1" }]]);
    const mapChooser = panel.paramWidgets[2];
    assert.equal(mapChooser.getValue(), "tag1");
    assert.equal(mapChooser.fileNameEl.textContent, "a.psd");
  });

  it("Displace round-trips scale, map tag, fit mode and undefined areas", () => {
    const panel = new FilterParameterPanel.Dspl();
    const descriptor = FilterDefs.create("Dspl");
    descriptor.HrzS.v = -25;
    descriptor.VrtS.v = 40;
    descriptor.DspF.v.pth = "tag1";
    descriptor.DspM.v.DspM = "Tile";
    descriptor.UndA.v.UndA = "WrpA";
    panel.setValue(descriptor, null, null, null, [[{ fileName: "map.psd", tag: "tag1" }]]);
    const edited = panel.getValue();
    assert.equal(edited.HrzS.v, -25);
    assert.equal(edited.VrtS.v, 40);
    assert.equal(edited.DspF.v.pth, "tag1");
    assert.equal(edited.DspM.v.DspM, "Tile");
    assert.equal(edited.UndA.v.UndA, "WrpA");
  });

  it("Displace keeps an empty map tag until one is chosen", () => {
    const panel = new FilterParameterPanel.Dspl();
    panel.setValue(FilterDefs.create("Dspl"), null, null, null, [[]]);
    assert.equal(panel.paramWidgets[2].getValue(), null);
    assert.equal(panel.getValue().DspF.v.pth, "");
  });

  it("returns the registered subclass when one is attached", () => {
    function RegisteredPanel() {}
    FilterParameterPanel.__testRegistered = RegisteredPanel;
    try {
      assert.equal(getFilterPanelConstructorOrFallback("__testRegistered"), RegisteredPanel);
    } finally {
      delete FilterParameterPanel.__testRegistered;
    }
  });

  it("returns a cached generic fallback for unregistered ids", () => {
    const first = getFilterPanelConstructorOrFallback("__unregisteredA");
    const again = getFilterPanelConstructorOrFallback("__unregisteredA");
    assert.equal(typeof first, "function");
    assert.equal(again, first, "same fallback constructor is reused per id");
    assert.notEqual(
      getFilterPanelConstructorOrFallback("__unregisteredB"),
      first,
      "a different id gets its own fallback constructor",
    );
    assert.equal(getFilterPanelConstructorOrFallback("boxblur"), FilterParameterPanel.boxblur);
  });
});
