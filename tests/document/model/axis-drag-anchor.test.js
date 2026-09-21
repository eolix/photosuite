import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { Point } from "../../../src/core/math/point.js";
import { KeyboardHandler } from "../../../src/core/keyboard-handler.js";
import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let AxisDragAnchor;
let restoreBrowserGlobals;

const keyboard = {
  isPressed(key) {
    return key === KeyboardHandler.Shift;
  },
};

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ AxisDragAnchor } = await import("../../../src/document/model/axis-drag-anchor.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/model/axis-drag-anchor.js", () => {
  it("constrainAxisDragPoint locks to vertical axis when Shift is held", () => {
    const anchor = new AxisDragAnchor(new Point(0, 0), 0);
    const first = anchor.constrainAxisDragPoint(new Point(5, 20), keyboard);
    assert.equal(first.x, 0);
    assert.equal(first.y, 20);
    const second = anchor.constrainAxisDragPoint(new Point(40, 25), keyboard);
    assert.equal(second.x, 0);
    assert.equal(second.y, 25);
  });

  it("constrainAxisDragPoint returns pointer when Shift is not pressed", () => {
    const anchor = new AxisDragAnchor(new Point(10, 10), 0);
    const unconstrainedKeyboard = { isPressed: () => false };
    const point = anchor.constrainAxisDragPoint(new Point(30, 40), unconstrainedKeyboard);
    assert.equal(point.x, 30);
    assert.equal(point.y, 40);
  });
});
