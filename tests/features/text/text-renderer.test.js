/**
 * Smoke + empty-layout golden for TextRenderer.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let TextRenderer;

before(async () => {
  ({ TextRenderer } = await import("../../../src/features/text/text-renderer.js"));
});

describe("features/text/text-renderer.js", () => {
  it("renderText returns an empty buffer when layout bounds are empty", () => {
    const result = TextRenderer.renderText(
      {
        getBounds() {
          return { x: Infinity, isEmpty: () => true };
        },
        textStyle: [],
      },
      { transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 } },
    );
    assert.equal(result.buffer.length, 0);
    assert.equal(result.rect.width, 0);
    assert.equal(result.layoutBounds.width, 0);
  });

  it("mirroredChars includes paired brackets", () => {
    assert.equal(TextRenderer.mirroredChars.includes("()"), true);
  });
});
