/**
 * FilterStackPanel param round-trip + stack render goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let FilterStackPanel;
let GalleryFilterDefs;

before(async () => {
  ({ FilterStackPanel } = await import("../../../src/ui/filter-panels/filter-stack-panel.js"));
  ({ GalleryFilterDefs } = await import("../../../src/features/filters/gallery/gallery-filter-defs.js"));
});

describe("ui/filter-panels/filter-stack-panel.js", () => {
  it("builds a param widget per gallery filter name", () => {
    const stack = new FilterStackPanel({ on() {}, dispatch() {} });
    const nameKeys = Object.keys(GalleryFilterDefs.names);
    assert.equal(Object.keys(stack.filterParamWidgets).length, nameKeys.length);
    assert.equal(stack.footerButtons.length, 2);
  });

  it("setValue/getValue goldens for Sz / TxtT / InvT", () => {
    const stack = new FilterStackPanel({ on() {}, dispatch() {} });

    const szDesc = GalleryFilterDefs.create("NGlw");
    szDesc.Sz.v = 7;
    stack.filterParamWidgets.NGlw.setValue(szDesc);
    assert.equal(stack.getParamValue("NGlw").Sz.v, 7);

    const txtDesc = GalleryFilterDefs.create("RghP");
    stack.filterParamWidgets.RghP.setValue(txtDesc);
    assert.equal(stack.getParamValue("RghP").TxtT.v.TxtT, "TxCa");

    txtDesc.InvT.v = true;
    stack.filterParamWidgets.RghP.setValue(txtDesc);
    assert.equal(stack.getParamValue("RghP").InvT.v, true);
  });

  it("offers each filter only the texture set it uses", () => {
    // A texture serves one of two purposes: Glass refracts the image through
    // one, the relief filters light one as a material surface. Offering all
    // seven everywhere lets a user pick a glass block as a canvas weave.
    const stack = new FilterStackPanel({ on() {}, dispatch() {} });

    assert.deepEqual(GalleryFilterDefs.textureWireIdsFor("Gls"),
      ["TxBl", "TxCa", "TxFr", "TxTL"]);
    for (const reliefFilter of ["Txtz", "Undr", "RghP", "CntC"]) {
      assert.deepEqual(GalleryFilterDefs.textureWireIdsFor(reliefFilter),
        ["TxBr", "TxBu", "TxCa", "TxSt"], `${reliefFilter} offers the relief set`);
    }

    // Each filter's own default has to be one of the options it shows, or the
    // menu opens on nothing.
    for (const filterKey of ["Gls", "Txtz", "Undr", "RghP", "CntC"]) {
      const offered = GalleryFilterDefs.textureWireIdsFor(filterKey);
      const defaultTexture = GalleryFilterDefs.create(filterKey).TxtT.v.TxtT;
      assert.ok(offered.includes(defaultTexture),
        `${filterKey} defaults to ${defaultTexture}, which it does not offer`);
    }

    // Every option a menu lists must name a texture the loader can resolve.
    for (const filterKey of ["Gls", "Txtz"]) {
      for (const wireId of GalleryFilterDefs.textureWireIdsFor(filterKey)) {
        assert.notEqual(GalleryFilterDefs.textureTypeWireIds.indexOf(wireId), -1,
          `${wireId} is not a known texture`);
      }
    }

    // Round-trip every option through the widget it belongs to.
    for (const filterKey of ["Gls", "Txtz"]) {
      for (const wireId of GalleryFilterDefs.textureWireIdsFor(filterKey)) {
        const descriptor = GalleryFilterDefs.create(filterKey);
        descriptor.TxtT.v.TxtT = wireId;
        stack.filterParamWidgets[filterKey].setValue(descriptor);
        assert.equal(stack.getParamValue(filterKey).TxtT.v.TxtT, wireId,
          `${filterKey} lost ${wireId} on round trip`);
      }
    }
  });

  it("falls back to the first option for a texture the filter does not offer", () => {
    // A file written elsewhere can name a texture outside this filter's set;
    // the menu shows its first entry rather than opening on nothing.
    const stack = new FilterStackPanel({ on() {}, dispatch() {} });
    const descriptor = GalleryFilterDefs.create("Gls");
    descriptor.TxtT.v.TxtT = "TxBr";   // a relief texture on Glass
    stack.filterParamWidgets.Gls.setValue(descriptor);
    assert.equal(stack.getParamValue("Gls").TxtT.v.TxtT, "TxBl");
  });

  it("render returns active filter key", () => {
    const stack = new FilterStackPanel({ on() {}, dispatch() {} });
    const firstKey = Object.keys(GalleryFilterDefs.names)[0];
    const entry = GalleryFilterDefs.create(firstKey);
    entry.GELv = { t: "bool", v: true };
    const activeKey = stack.render({ GEfs: { v: [{ v: entry }] } }, 0);
    assert.equal(activeKey, firstKey);
  });
});
