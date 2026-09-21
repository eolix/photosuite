import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { makeElement } from "../../../src/core/dom.js";

let ToolId;
let restoreBrowserGlobals;
let TextTool;


// Chain the tool prototypes these tests construct from.
function chainToolPrototypes() {
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  globalThis.alert = () => {};
  await import("../../../src/engine/layer-system.js");
  await import("../../../src/document/tools/text-tools.js");
  ({ TextTool } = await import("../../../src/document/tools/text-tools.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/tools/text-tools.js", () => {
  it("registerTextTools wires TextTool", () => {
    chainToolPrototypes();
    const tool = new TextTool();
    assert.equal(typeof TextTool, "function");
    assert.equal(tool.id, ToolId.TOOL_TYPE);
    assert.equal(tool.name, "tools.typeTool");
    assert.equal(tool.isActive(), false);
    assert.equal(typeof TextTool.findTextLayerAtPoint, "function");
    assert.equal(typeof tool.listTextLayerIndices, "function");
    assert.equal(typeof tool.captureTextLayerSnapshots, "function");
  });

  it("findWordStartIndex/EndIndex match delimiter scan", () => {
    chainToolPrototypes();
    const tool = new TextTool();
    assert.equal(tool.findWordStartIndex("hello world", 4), 0);
    assert.equal(tool.findWordEndIndex("hello world", 0), 5);
    assert.equal(tool.findWordStartIndex("hello world", 7), 6);
    assert.equal(tool.findWordEndIndex("hello world", 6), 10);
    assert.equal(tool.findWordStartIndex("a,b", 2), 2);
  });

  it("textSnapshotsMatchLayerOrder compares layerIndex sequences", () => {
    chainToolPrototypes();
    assert.equal(
      TextTool.textSnapshotsMatchLayerOrder(
        [{ layerIndex: 1 }, { layerIndex: 3 }],
        [{ layerIndex: 1 }, { layerIndex: 3 }],
      ),
      true,
    );
    assert.equal(
      TextTool.textSnapshotsMatchLayerOrder(
        [{ layerIndex: 1 }],
        [{ layerIndex: 2 }],
      ),
      false,
    );
    assert.equal(
      TextTool.textSnapshotsMatchLayerOrder([{ layerIndex: 1 }], []),
      false,
    );
  });

  it("listTextLayerIndices returns selected TySh layers only", () => {
    chainToolPrototypes();
    const tool = new TextTool();
    const doc = {
      selectedLayerIndices: [0, 2, 3],
      layers: [
        { add: { TySh: {} } },
        { add: {} },
        { add: { TySh: {} } },
        null,
      ],
    };
    assert.deepEqual(tool.listTextLayerIndices(doc), [0, 2]);
  });

  it("findTextLayerAtPoint prefers top visible text layer", () => {
    chainToolPrototypes();
    const doc = {
      layers: [
        {
          add: { TySh: {} },
          rect: { containsPoint: () => true },
          isLockBitSet: () => false,
        },
        {
          add: { TySh: {} },
          rect: { containsPoint: () => true },
          isLockBitSet: (bit) => bit === 2,
        },
      ],
      isLayerVisible: () => true,
    };
    assert.equal(TextTool.findTextLayerAtPoint(doc, { x: 1, y: 1 }), -2);
    doc.layers[1].isLockBitSet = () => false;
    assert.equal(TextTool.findTextLayerAtPoint(doc, { x: 1, y: 1 }), 1);
  });

  it("findWordStartIndex/findWordEndIndex split on delimiters", () => {
    chainToolPrototypes();
    const tool = new TextTool();
    const text = "hello world, foo\n";
    assert.equal(tool.findWordStartIndex(text, 7), 6);   // inside "world" -> its start
    assert.equal(tool.findWordEndIndex(text, 7), 11);    // -> delimiter after "world"
    assert.equal(tool.findWordStartIndex(text, 0), 0);
    assert.equal(tool.findWordEndIndex(text, 13), 16);   // "foo" -> newline index
  });
});
