/**
 * Every tool's prototype is chained onto the base it extends, by the module
 * that defines it. A tool whose chaining is dropped imports cleanly and
 * constructs fine — it simply inherits nothing — so the chain is asserted here.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";

let ToolId;
let EventChannel;
let ToolBase;
let PaintTool;
let SelectTool;
let PolyToolBase;
let ShapeToolBase;
let TransformToolBase;
let CropToolBase;
let tools;
let packDoublesList;
let placedTransformToMatrix;

before(async () => {
  installBrowserGlobals();
  await import("../../src/engine/layer-system.js");
  ({ packDoublesList, placedTransformToMatrix } = await import(
    "../../src/document/formats/psd/descriptor-codec.js"
  ));
  ({ ToolId, EventChannel, ToolBase } = await import("../../src/document/model/tool-base.js"));
  ({ PaintTool } = await import("../../src/document/tools/paint-tools.js"));
  ({ SelectTool } = await import("../../src/document/tools/selection-tools.js"));
  ({ PolyToolBase } = await import("../../src/document/tools/pen-path-tools.js"));
  ({ ShapeToolBase } = await import("../../src/document/tools/shape-tools.js"));
  ({ CropToolBase } = await import("../../src/document/tools/crop-tools.js"));
  ({ TransformToolBase } = await import("../../src/document/transform/transform-static.js"));

  const [paint, pen, select, retouch, shape, crop, move, text, view, transform] = await Promise.all([
    import("../../src/document/tools/paint-tools.js"),
    import("../../src/document/tools/pen-path-tools.js"),
    import("../../src/document/tools/selection-tools.js"),
    import("../../src/document/tools/retouch-tools.js"),
    import("../../src/document/tools/shape-tools.js"),
    import("../../src/document/tools/crop-tools.js"),
    import("../../src/document/tools/move-tools.js"),
    import("../../src/document/tools/text-tools.js"),
    import("../../src/document/tools/view-tools.js"),
    import("../../src/document/transform/transform-tools.js"),
  ]);
  // One representative per pipeline step, with the base it must reach.
  tools = [
    ["PaintTool", paint.PaintTool, () => ToolBase],
    ["PenTool", pen.PenTool, () => PolyToolBase],
    ["SelectTool", select.SelectTool, () => ToolBase],
    ["SpotHealTool", retouch.SpotHealTool, () => PaintTool],
    ["RectShapeTool", shape.RectShapeTool, () => ShapeToolBase],
    ["CropTool", crop.CropTool, () => CropToolBase],
    ["MoveTool", move.MoveTool, () => ToolBase],
    ["TextTool", text.TextTool, () => ToolBase],
    ["ZoomTool", view.ZoomTool, () => ToolBase],
    ["FreeTransformTool", transform.FreeTransformTool, () => TransformToolBase],
  ];
});

describe("tool prototype chains", () => {
  it("chains every tool family onto the base it extends", () => {
    for (const [name, Tool, base] of tools) {
      assert.equal(typeof Tool, "function", `${name} is not a constructor`);
      assert.ok(
        new Tool() instanceof base(),
        `${name} does not inherit from its base`,
      );
    }
  });

  it("gives every tool a distinct id", () => {
    const ids = Object.values(ToolId);
    assert.ok(ids.length > 40, "the toolbar is missing tool ids");
    assert.equal(new Set(ids).size, ids.length, "two tools share an id and would collide");
    for (const id of ids) assert.equal(typeof id, "string");
  });

  it("names the document routing channels tools dispatch on", () => {
    for (const channel of [
      "EVENT_DOCUMENT", "EVENT_HISTORY", "EVENT_FILTER_STACK",
      "EVENT_SMART_FILTER", "EVENT_PLUGIN",
    ]) {
      assert.notEqual(EventChannel[channel], undefined, `${channel} is missing`);
    }
  });

  // A placed layer's quad maps onto the size it was placed at; an untransformed
  // 100x100 placement is the identity.
  it("reads a placed layer's transform out of its descriptor", () => {
    const matrix = placedTransformToMatrix({
      Trnf: packDoublesList([0, 0, 100, 0, 100, 100, 0, 100]),
      Sz: { v: { Wdth: { v: 100 }, Hght: { v: 100 } } },
    });
    assert.deepEqual([matrix.a, matrix.d, matrix.tx, matrix.ty], [1, 1, 0, 0]);
  });
});
