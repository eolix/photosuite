/**
 * GuidesPanel.distributeGuides goldens + guide dispatch shape.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ToolId;
let GuidesPanel;
let DocumentModel;

before(async () => {
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  ({ DocumentModel } = await import("../../../src/document/model/tool-base.js"));
  ({ GuidesPanel } = await import("../../../src/ui/panels/guides-panel.js"));
});

describe("ui/panels/guides-panel.js", () => {
  it("distributeGuides goldens", () => {
    assert.deepEqual(GuidesPanel.distributeGuides([10, 20, 0, 0, 0], 0, 100), [10, 80]);
    assert.deepEqual(GuidesPanel.distributeGuides([0, 0, 3, 20, 0], 0, 100), [0, 100, 20, 40, 60, 80]);
    assert.deepEqual(GuidesPanel.distributeGuides([0, 0, 2, 0, 10], 0, 100), [0, 100, 45, 55]);
    assert.deepEqual(GuidesPanel.distributeGuides([0, 0, 0, 25, 5], 0, 100), [0, 100, 30, 35, 65, 70]);
    assert.deepEqual(GuidesPanel.distributeGuides([0, 0, 0, 0, 0], 0, 100), []);
    assert.deepEqual(GuidesPanel.distributeGuides([5, 5, 4, 0, 0], 10, 110), [15, 105, 37.5, 60, 82.5]);
  });

  it("dispatchGuidesUpdate uses gids + guidesAfter", () => {
    const panel = Object.create(GuidesPanel.prototype);
    const events = [];
    panel.dispatch = (evt) => events.push(evt);
    const guides = [[10, 50], [20]];
    panel.dispatchGuidesUpdate(guides);
    assert.equal(events.length, 1);
    assert.equal(events[0].routingChannel, ToolId.TOOL_MOVE);
    assert.equal(events[0].data.actionKind, "gids");
    assert.deepEqual(events[0].data.guidesAfter, guides);
  });

  it("onInputChange clears conflicting size/gap/count on same axis", () => {
    const panel = Object.create(GuidesPanel.prototype);
    const values = [0, 0, 0, 0, 3, 0, 20, 0, 5, 0];
    panel.guideInputs = values.map((v, i) => ({
      getValue: () => values[i],
      setValue: (next) => {
        values[i] = next;
      },
    }));
    // fieldIndex 2 = column width (index 6), axis 0 → clears gap (index 8) when count+size+gap all set
    panel.onInputChange({ target: panel.guideInputs[6] });
    assert.equal(values[8], 0);
    assert.equal(values[6], 20);
    assert.equal(values[4], 3);
  });

  it("clear guides button dispatches empty sorted guides", () => {
    const panel = Object.create(GuidesPanel.prototype);
    panel.activeDoc = { width: 100, height: 80, selectionMask: null, guides: [[1], [2]] };
    panel.guideInputs = [];
    panel.items = [{}, {}, {}, {}, {}, {}, {}, {}];
    const events = [];
    panel.dispatch = (evt) => events.push(evt);
    // itemIndex 1 = Clear Guides
    panel.onItemClick({ target: panel.items[1] });
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].data.guidesAfter, [[], []]);
  });
});
