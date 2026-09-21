/**
 * PathsPanel footer actions and path selection order.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { EventType } from "../../../src/core/event-bus.js";

installBrowserGlobals();

let ToolId;
let PathsPanel;
let DocumentModel;
let ChannelsPanel;

before(async () => {
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  ({ DocumentModel } = await import("../../../src/document/model/tool-base.js"));
  ({ ChannelsPanel } = await import("../../../src/ui/panels/channels-panel.js"));
  ({ PathsPanel } = await import("../../../src/ui/panels/paths-panel.js"));
});

function makeDoc(paths, selectedIndices = []) {
  return {
    selectedWorkPaths: [],
    selectedLayerPaths: [],
    panelsDirty: false,
    dirty: false,
    getPaths: () => [paths, selectedIndices],
  };
}

describe("ui/panels/paths-panel.js", () => {
  it("buildSelectionToPathAction uses make + 2px Tlrn", () => {
    const evt = PathsPanel.buildSelectionToPathAction();
    assert.equal(evt.type, EventType.historyGrouped);
    assert.equal(evt.data.uf, "make");
    assert.equal(evt.data.actionDescriptor.Tlrn.v.val, 2);
    assert.equal(evt.data.actionDescriptor.null.v[0].v.classID, "Path");
  });

  it("resolvePathSelectionOrder maps work and layer path ids", () => {
    const doc = makeDoc([{ idx: 0 }, { idx: 2 }, { idx: -1 }]);
    assert.deepEqual(PathsPanel.resolvePathSelectionOrder(doc, 2), {
      pathOrder: 1,
      activeList: doc.selectedLayerPaths,
      inactiveList: doc.selectedWorkPaths,
    });
    assert.deepEqual(PathsPanel.resolvePathSelectionOrder(doc, -1), {
      pathOrder: 0,
      activeList: doc.selectedWorkPaths,
      inactiveList: doc.selectedLayerPaths,
    });
  });

  it("onLayerClick selects layer path and clears work paths", () => {
    const panel = Object.create(PathsPanel.prototype);
    panel.activeDoc = makeDoc([{ idx: 0 }, { idx: 2 }]);
    PathsPanel.prototype.onLayerClick.call(panel, {
      data: { idx: 2, isMultiSelectModifier: false },
    });
    assert.deepEqual(panel.activeDoc.selectedLayerPaths, [1]);
    assert.deepEqual(panel.activeDoc.selectedWorkPaths, []);
    assert.equal(panel.activeDoc.dirty, true);
  });

  it("onLayerClick with multi-select toggles path order", () => {
    const panel = Object.create(PathsPanel.prototype);
    panel.activeDoc = makeDoc([{ idx: 0 }, { idx: 5 }]);
    PathsPanel.prototype.onLayerClick.call(panel, {
      data: { idx: 5, isMultiSelectModifier: true },
    });
    assert.deepEqual(panel.activeDoc.selectedLayerPaths, [1]);
    PathsPanel.prototype.onLayerClick.call(panel, {
      data: { idx: 5, isMultiSelectModifier: true },
    });
    assert.deepEqual(panel.activeDoc.selectedLayerPaths, []);
  });

  it("footer new/delete dispatch pathedit operations", () => {
    const panel = Object.create(PathsPanel.prototype);
    panel.footerBtns = [{}, {}, {}, {}];
    const events = [];
    panel.dispatch = (evt) => events.push(evt);
    const origIndex = ChannelsPanel.indexOfButton;
    ChannelsPanel.indexOfButton = () => 2;
    PathsPanel.prototype.onFooterPointerDown.call(panel, {});
    ChannelsPanel.indexOfButton = () => 3;
    PathsPanel.prototype.onFooterPointerDown.call(panel, {});
    ChannelsPanel.indexOfButton = origIndex;
    assert.equal(events[0].data.operation, "new");
    assert.equal(events[1].data.operation, "del");
    assert.equal(events[0].routingChannel, ToolId.TOOL_PATH_SELECT);
  });
});
