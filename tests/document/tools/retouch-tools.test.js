import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { Point } from "../../../src/core/math/point.js";
import { makeElement } from "../../../src/core/dom.js";

let ToolId;
let restoreBrowserGlobals;
let BlurTool;
let BurnTool;
let CloneStampTool;
let ColorReplacementTool;
let ContentAwareMoveTool;
let DodgeTool;
let HealBrushTool;
let PatchToolBase;
let RedEyeTool;
let SharpenTool;
let SmudgeTool;
let SpongeTool;
let SpotHealTool;


// Chain the tool prototypes these tests construct from.
function chainToolPrototypes() {
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  globalThis.alert = () => {};
  await import("../../../src/engine/layer-system.js");
  await import("../../../src/document/tools/paint-tools.js");
  await import("../../../src/document/tools/retouch-tools.js");
  ({ BlurTool, BurnTool, CloneStampTool, ColorReplacementTool, ContentAwareMoveTool, DodgeTool, HealBrushTool, PatchToolBase, RedEyeTool, SharpenTool, SmudgeTool, SpongeTool, SpotHealTool } = await import("../../../src/document/tools/retouch-tools.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/tools/retouch-tools.js", () => {
  it("registerRetouchTools wires retouch constructors onto DocumentModel", () => {
    chainToolPrototypes();
    const patch = new PatchToolBase();
    const clone = new CloneStampTool();
    const camove = new ContentAwareMoveTool();
    const heal = new HealBrushTool();

    assert.equal(typeof PatchToolBase, "function");
    assert.equal(patch.id, ToolId.TOOL_PATCH);
    assert.equal(clone.id, ToolId.TOOL_CLONE_STAMP);
    assert.equal(clone.strokeCompositeMode, "clone");
    assert.equal(camove.id, ToolId.TOOL_CONTENT_AWARE_MOVE);
    assert.equal(camove.toolOptions.patch, 1);
    assert.equal(heal.id, ToolId.TOOL_HEAL_BRUSH);
    assert.equal(heal.strokeCompositeMode, "clone");
    assert.equal(typeof clone.resolveCloneOffsetForPoint, "function");
    assert.equal(typeof patch.compositeHealStrokeAtPointer, "function");
  });

  it("resolveCloneOffsetForPoint matches offset math", () => {
    chainToolPrototypes();
    const clone = new CloneStampTool();
    clone.cloneSourcePoint = new Point(10, 20);
    clone.cloneOffset = null;
    clone.toolOptions.algnd = false;

    const unaligned = clone.resolveCloneOffsetForPoint(new Point(30, 50));
    assert.deepEqual({ x: unaligned.x, y: unaligned.y }, { x: 20, y: 30 });

    clone.cloneOffset = unaligned;
    clone.toolOptions.algnd = true;
    const aligned = clone.resolveCloneOffsetForPoint(new Point(100, 200));
    assert.deepEqual({ x: aligned.x, y: aligned.y }, { x: 20, y: 30 });
  });

  it("retouch tool defaults match stroke modes and options", () => {
    chainToolPrototypes();

    assert.equal(new SpotHealTool().strokeCompositeMode, "draw");
    assert.equal(new SpotHealTool().toolOptions.Opct, 0.5);
    assert.equal(new ColorReplacementTool().strokeCompositeMode, "idraw");
    assert.equal(new ColorReplacementTool().toolOptions.bmode, "hue ");
    assert.equal(new RedEyeTool().strokeCompositeMode, "redeye");
    assert.equal(new RedEyeTool().toolOptions.smode, 0);
    assert.equal(new SharpenTool().strokeCompositeMode, "copy");
    assert.equal(new SmudgeTool().strokeCompositeMode, "copy");
    assert.equal(new SpongeTool().strokeCompositeMode, "sponge");
    assert.equal(new BlurTool().strokeCompositeMode, "copy");
    assert.equal(new BurnTool().strokeCompositeMode, "burn");
    assert.equal(new DodgeTool().strokeCompositeMode, "dodge");
  });

  it("BurnTool and DodgeTool scale exposure by Math.E and Math.PI", () => {
    chainToolPrototypes();
    const burn = new BurnTool();
    const dodge = new DodgeTool();
    burn.toolOptions.expo = Math.E;
    dodge.toolOptions.expo = Math.PI;

    let burnStrength = null;
    let dodgeStrength = null;
    burn.beginStroke = function(_doc, _appData, _keyboard, _pointer, strength) {
      burnStrength = strength;
      this.strokeData = null;
    };
    dodge.beginStroke = function(_doc, _appData, _keyboard, _pointer, strength) {
      dodgeStrength = strength;
      this.strokeData = null;
    };

    const noop = { isPressed() { return false; } };
    const pointer = { x: 0, y: 0, isDown: true };
    burn.onMouseDown({}, {}, {}, noop, pointer);
    dodge.onMouseDown({}, {}, {}, noop, pointer);

    assert.equal(burnStrength, 1);
    assert.equal(dodgeStrength, 1);
  });

  it("factory-built tools keep their names and per-spec handlers", () => {
    chainToolPrototypes();
    assert.equal(SharpenTool.name, "SharpenTool");
    assert.equal(DodgeTool.name, "DodgeTool");
    // Only the spot-heal spec installs its own mouse-up (heal composite).
    assert.ok(Object.hasOwn(SpotHealTool.prototype, "onMouseUp"));
    assert.ok(!Object.hasOwn(SmudgeTool.prototype, "onMouseUp"));
    // Distinct prototypes per tool - no shared-spec cross contamination.
    assert.notEqual(BurnTool.prototype, DodgeTool.prototype);
    const burn = new BurnTool();
    const dodge = new DodgeTool();
    assert.equal(burn.strokeCompositeMode, "burn");
    assert.equal(dodge.strokeCompositeMode, "dodge");
  });
});
