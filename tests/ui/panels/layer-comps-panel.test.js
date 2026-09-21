/**
 * LayerCompsPanel list build, footer actions, LayerCompListItem dispatch.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { addClass, clearElement, removeClass } from "../../../src/core/dom.js";

installBrowserGlobals();

let LayerCompsPanel;
let LayerCompListItem;

before(async () => {
  ({ LayerCompsPanel, LayerCompListItem } = await import(
    "../../../src/ui/panels/layer-comps-panel.js"
  ));
});

function sampleDoc() {
  return {
    layerComps: {
      lastAppliedComp: { v: 10 },
      list: {
        v: [{ v: { Nm: { v: "Comp A" }, compID: { v: 10 }, capturedInfo: { v: 7 } } }],
      },
    },
  };
}

describe("ui/panels/layer-comps-panel.js", () => {
  it("resolveAppliedCompId returns last applied id or zero", () => {
    assert.equal(LayerCompsPanel.resolveAppliedCompId(sampleDoc()), 10);
    assert.equal(LayerCompsPanel.resolveAppliedCompId({ layerComps: { list: { v: [] } } }), 0);
  });

  it("buildCompDescriptorList prepends Last Document State", () => {
    const rows = LayerCompsPanel.buildCompDescriptorList(sampleDoc());
    assert.equal(rows.length, 2);
    assert.equal(rows[0].v.compID.v, 0);
    assert.equal(rows[0].v.Nm.v, "Last Document State");
    assert.equal(rows[1].v.compID.v, 10);
  });

  it("LayerCompListItem dispatches editLC / setLC payloads", () => {
    const item = Object.create(LayerCompListItem.prototype);
    item.compId = 3;
    item.attrButtons = [{}, {}];
    const payloads = [];
    item.dispatch = (evt) => payloads.push(evt.data);
    item.onAttrToggleClick({ currentTarget: item.attrButtons[1] });
    item.onRenameConfirm("New Name");
    item.onSetCurrentClick({});
    assert.deepEqual(payloads, [
      { actionKind: "editLC", capturedFlagIndex: 1, idx: 3 },
      { actionKind: "editLC", newName: "New Name", idx: 3 },
      { actionKind: "setLC", idx: 3 },
    ]);
  });

  it("footer buttons dispatch updLC / addLC / delLC and clear selection on delete", () => {
    const panel = Object.create(LayerCompsPanel.prototype);
    panel.footerButtons = [{}, {}, {}];
    panel.selectedCompId = 5;
    const payloads = [];
    panel.dispatch = (evt) => payloads.push(evt.data);
    panel.onFooterBtnClick({ currentTarget: panel.footerButtons[0] });
    panel.onFooterBtnClick({ currentTarget: panel.footerButtons[1] });
    panel.onFooterBtnClick({ currentTarget: panel.footerButtons[2] });
    assert.deepEqual(payloads, [
      { actionKind: "updLC", idx: 5 },
      { actionKind: "addLC", idx: 5 },
      { actionKind: "delLC", idx: 5 },
    ]);
    assert.equal(panel.selectedCompId, -1);
  });

  it("open rebuilds comp rows and preserves selection highlight", () => {
    const panel = Object.create(LayerCompsPanel.prototype);
    panel.panelBody = document.createElement("div");
    panel.containerEl = { appendChild() {} };
    panel.compItems = [];
    panel.selectedCompId = 10;
    LayerCompsPanel.prototype.open.call(panel, sampleDoc());
    assert.equal(panel.compItems.length, 2);
    assert.deepEqual(panel.compItems.map((item) => item.compId), [0, 10]);
    assert.equal(panel.compItems[1].compId, panel.selectedCompId);
  });

  it("footer reload/delete require a selected comp", () => {
    const panel = Object.create(LayerCompsPanel.prototype);
    panel.footerButtons = [{}, {}, {}];
    panel.selectedCompId = -1;
    const payloads = [];
    panel.dispatch = (evt) => payloads.push(evt.data);
    panel.onFooterBtnClick({ currentTarget: panel.footerButtons[0] });
    assert.equal(payloads.length, 0);
    panel.onFooterBtnClick({ currentTarget: panel.footerButtons[1] });
    assert.deepEqual(payloads, [{ actionKind: "addLC", idx: -1 }]);
  });
});
