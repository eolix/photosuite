/**
 * ChannelsPanel footer actions + RGB channel visibility clicks.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { addPointerDownListener, cancel } from "../../../src/core/dom.js";
import { iconImgHtml } from "../../../src/assets/icon-registry.js";

installBrowserGlobals();

let ToolId;
let ChannelsPanel;
let DocumentModel;

before(async () => {
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  ({ DocumentModel } = await import("../../../src/document/model/tool-base.js"));
  ({ ChannelsPanel } = await import("../../../src/ui/panels/channels-panel.js"));
});

function fakeButtonEvt(panel, index) {
  return { currentTarget: panel.footerBtns[index].el };
}

describe("ui/panels/channels-panel.js", () => {
  it("constructs four footer buttons and merge-channels editor menu", () => {
    const panel = new ChannelsPanel();
    assert.equal(panel.footerBtns.length, 4);
    assert.ok(panel.getEditorMode());
    assert.equal(ChannelsPanel.indexOfButton(panel.footerBtns, fakeButtonEvt(panel, 2)), 2);
  });

  it("footer 0 dispatches fromchannel selection event", () => {
    const panel = new ChannelsPanel();
    const events = [];
    panel.dispatch = (evt) => events.push(evt);
    panel.onFooterPointerDown(fakeButtonEvt(panel, 0));
    assert.equal(events.length, 1);
    assert.equal(events[0].data.actionKind, "fromchannel");
    assert.deepEqual(events[0].data.selectionSource, [null, 0, 0]);
  });

  it("footer 1–3 historyGrouped uf + descriptor goldens", () => {
    const panel = new ChannelsPanel();
    const events = [];
    panel.dispatch = (evt) => events.push(evt);

    panel.onFooterPointerDown(fakeButtonEvt(panel, 1));
    assert.equal(events[0].data.uf, "duplicate");
    assert.equal(events[0].data.actionDescriptor.null.v[0].v.keyID, "fsel");
    assert.equal(events[0].data.actionDescriptor.null.v[0].v.classID, "Chnl");

    panel.onFooterPointerDown(fakeButtonEvt(panel, 2));
    assert.equal(events[1].data.uf, "make");
    assert.equal(events[1].data.actionDescriptor.Nw.v.classID, "Chnl");
    assert.equal(events[1].data.actionDescriptor.Nw.v.ClrI.v.MskI, "SlcA");
    assert.equal(events[1].data.actionDescriptor.Nw.v.Opct.v, 50);

    panel.onFooterPointerDown(fakeButtonEvt(panel, 3));
    assert.equal(events[2].data.uf, "delete");
  });

  it("RGB row click sets channelVisibility via setcls", () => {
    const panel = new ChannelsPanel();
    panel.channelMask = [1, 0, 0];
    panel.activeDoc = { activeChannels: [3], dirty: false, panelsDirty: false };
    const events = [];
    panel.dispatch = (evt) => events.push(evt);

    panel.onLayerClick({ data: { idx: -1, isVisibilityEyeClick: false } });
    assert.equal(events[0].data.actionKind, "setcls");
    assert.deepEqual(events[0].data.channelVisibility, [1, 1, 1]);
    assert.equal(events[0].routingChannel, ToolId.TOOL_HAND);
    assert.deepEqual(panel.activeDoc.activeChannels, []);

    panel.channelMask = [1, 1, 1];
    panel.onLayerClick({ data: { idx: -1, isVisibilityEyeClick: true } });
    assert.deepEqual(events[1].data.channelVisibility, [0, 0, 0]);

    panel.channelMask = [1, 0, 0];
    panel.onLayerClick({ data: { idx: -2, isVisibilityEyeClick: true } });
    assert.deepEqual(events[2].data.channelVisibility, [0, 0, 0]);
  });

  it("extra channel eye toggles active without dispatch", () => {
    const panel = new ChannelsPanel();
    panel.channelMask = [1, 1, 1];
    const extra = { active: true, name: "Alpha 1" };
    panel.activeDoc = {
      layers: [],
      extraChannels: [extra],
      activeChannels: [0],
      dirty: false,
      panelsDirty: false,
    };
    panel.onLayerClick({ data: { idx: -5, isVisibilityEyeClick: true } });
    assert.equal(extra.active, false);
    assert.equal(panel.activeDoc.dirty, true);
    assert.equal(panel.activeDoc.panelsDirty, true);
  });

  it("applyFooterIcons sets packaged icon labels", () => {
    const panel = new ChannelsPanel();
    ChannelsPanel.applyFooterIcons(panel.footerBtns, [
      "lrs/makesel",
      "lrs/mask",
      "lrs/newlayer",
      "lrs/bin",
    ]);
    assert.match(panel.footerBtns[0].el.innerHTML || panel.footerBtns[0].label || "", /makesel|img/);
  });
});
