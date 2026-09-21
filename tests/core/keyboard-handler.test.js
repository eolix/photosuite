import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";

let KeyboardHandler;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ KeyboardHandler } = await import("../../src/core/keyboard-handler.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("core/keyboard-handler.js", () => {
  it("formatShortcut renders string shortcuts unchanged", () => {
    assert.equal(KeyboardHandler.formatShortcut("Ctrl+Z"), "Ctrl+Z");
  });

  it("tracks pressed keys", () => {
    const kb = new KeyboardHandler();
    kb.onKeyDown("KeyA");
    assert.equal(kb.isPressed(KeyboardHandler.KeyA), true);
    kb.onKeyUp("KeyA");
    assert.equal(kb.isPressed(KeyboardHandler.KeyA), false);
  });

  it("getArrowMovement respects shift step", () => {
    const kb = new KeyboardHandler();
    kb.onKeyDown("ArrowRight");
    const base = kb.getArrowMovement();
    assert.equal(base.x, 1);
    assert.equal(base.y, 0);
    kb.onKeyDown("ShiftLeft");
    const shifted = kb.getArrowMovement();
    assert.equal(shifted.x, 10);
    assert.equal(shifted.y, 0);
  });
});
