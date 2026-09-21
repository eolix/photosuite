import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { Rect } from "../../../src/core/math/rect.js";

let TextRenderer;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../../src/engine/layer-system.js");
  ({ TextRenderer } = await import("../../../src/features/text/text-renderer.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("features/text/text-engine.js renderText contract", () => {
  it("returns { buffer, rect, layoutBounds } for an empty layout", () => {
    const emptyCurveData = { getBounds: () => new Rect() };
    const result = TextRenderer.renderText(emptyCurveData, {});
    assert.deepEqual(
      Object.keys(result).sort(),
      ["buffer", "layoutBounds", "rect"],
    );
    assert.equal(result.buffer.length, 0);
    assert.ok(result.rect instanceof Rect);
    assert.ok(result.layoutBounds instanceof Rect);
  });
});
