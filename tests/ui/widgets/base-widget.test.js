/**
 * BaseWidget ancestry / measure helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let BaseWidget;
let isWidgetInAncestorChain;
let measureElementOuterWidth;
let measureElementOuterHeight;

before(async () => {
  ({
    BaseWidget,
    isWidgetInAncestorChain,
    measureElementOuterWidth,
    measureElementOuterHeight
  } = await import("../../../src/ui/widgets/base-widget.js"));
});

describe("ui/widgets/base-widget.js", () => {
  it("isWidgetInAncestorChain walks parents", () => {
    const root = { parent: null };
    const mid = { parent: root };
    const leaf = { parent: mid };
    assert.equal(isWidgetInAncestorChain(leaf, leaf), true);
    assert.equal(isWidgetInAncestorChain(leaf, mid), true);
    assert.equal(isWidgetInAncestorChain(leaf, root), true);
    assert.equal(isWidgetInAncestorChain(mid, leaf), false);
    assert.equal(isWidgetInAncestorChain(root, mid), false);
  });

  it("measureElementOuterWidth/Height add client offsets", () => {
    const el = { offsetWidth: 100, clientLeft: 2, offsetHeight: 50, clientTop: 3 };
    assert.equal(measureElementOuterWidth(el), 102);
    assert.equal(measureElementOuterHeight(el), 53);
  });

  it("BaseWidget isDescendantOf uses parent chain", () => {
    const a = Object.create(BaseWidget.prototype);
    const b = Object.create(BaseWidget.prototype);
    a.parent = null;
    b.parent = a;
    assert.equal(b.isDescendantOf(a), true);
    assert.equal(a.isDescendantOf(b), false);
  });
});
