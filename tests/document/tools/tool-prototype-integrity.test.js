import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

// A tool defines its prototype methods, and then `registerX` chains it to its
// base. Chaining with `X.prototype = new ToolBase()` discards every one of
// them silently, leaving the tool on ToolBase's empty stubs — Image Size and
// Canvas Size then do nothing at all, with no error. For every registered
// tool, its overridden prototype methods must not be byte-identical to
// ToolBase's stub.
let DM;
let restore;

before(async () => {
  restore = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  await import("../../../src/document/tools/paint-tools.js");
  await import("../../../src/document/tools/pen-path-tools.js");
  await import("../../../src/document/tools/selection-tools.js");
  await import("../../../src/document/tools/lasso-tools.js");
  await import("../../../src/document/tools/crop-tools.js");
  await import("../../../src/document/tools/retouch-tools.js");
  await import("../../../src/document/tools/shape-tools.js");
  await import("../../../src/document/tools/view-tools.js");
  await import("../../../src/document/tools/move-tools.js");
  await import("../../../src/document/tools/text-tools.js");
  await import("../../../src/document/transform/transform-tools.js");
  const [base, paint, select, move, crop, pen, text, transform, wand] = await Promise.all([
    import("../../../src/document/model/tool-base.js"),
    import("../../../src/document/tools/paint-tools.js"),
    import("../../../src/document/tools/selection-tools.js"),
    import("../../../src/document/tools/move-tools.js"),
    import("../../../src/document/tools/crop-tools.js"),
    import("../../../src/document/tools/pen-path-tools.js"),
    import("../../../src/document/tools/text-tools.js"),
    import("../../../src/document/transform/transform-tools.js"),
    import("../../../src/document/tools/selection-tools.js"),
  ]);
  DM = {
    ToolBase: base.ToolBase,
    PaintTool: paint.PaintTool,
    SelectTool: select.SelectTool,
    MoveTool: move.MoveTool,
    CropTool: crop.CropTool,
    CropToolBase: crop.CropToolBase,
    PenTool: pen.PenTool,
    TextTool: text.TextTool,
    FreeTransformTool: transform.FreeTransformTool,
    MagicWandTool: wand.MagicWandTool,
  };
});

after(() => { if (restore) restore(); });

describe("tool prototype integrity after registration", () => {
  const norm = (fn) => fn.toString().replace(/\s/g, "");
  it("each tool's handleInput survived registration (not the ToolBase stub)", () => {
    const stub = norm(DM.ToolBase.prototype.handleInput);
    const tools = ["CropTool", "CropToolBase", "PaintTool", "SelectTool", "MoveTool", "TextTool", "PenTool", "MagicWandTool", "FreeTransformTool"];
    for (const name of tools) {
      const C = DM[name];
      if (!C || typeof C.prototype.handleInput !== "function") continue;
      assert.notEqual(norm(C.prototype.handleInput), stub, `${name}.handleInput is the empty ToolBase stub — prototype was wiped at registration`);
    }
  });
});
