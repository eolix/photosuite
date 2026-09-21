/**
 * LayerGroupItem tree lookup helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let LayerGroupItem;

before(async () => {
  ({ LayerGroupItem } = await import("../../../src/ui/panels/layer-group-item.js"));
});

describe("ui/panels/layer-group-item.js", () => {
  it("findRowByLayerIndex walks nested childRows", () => {
    const child = { sectionNode: { index: 2 }, childRows: [] };
    const root = { sectionNode: { index: 0 }, childRows: [child] };
    const panel = { layerTreeRoot: root };
    assert.equal(LayerGroupItem.findRowByLayerIndex(panel, 2), child);
    assert.equal(LayerGroupItem.findRowByLayerIndex(panel, 9), null);
    assert.equal(LayerGroupItem.findRowByLayerIndex(null, 0), null);
  });
});
