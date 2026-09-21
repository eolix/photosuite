/**
 * DocumentView dialog stack helpers (ids, cascade, top-of-stack).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let DocumentView;
let isAdjustFilterDialogId;
let getTopDialogFromStack;
let computeCascadeStackPosition;
let computeCenteredContentPosition;
let CORE_DIALOG_REGISTRY_KEY;
let ADJUST_FILTER_DIALOG_ID_PREFIX;

before(async () => {
  ({
    DocumentView,
    isAdjustFilterDialogId,
    getTopDialogFromStack,
    computeCascadeStackPosition,
    computeCenteredContentPosition,
    CORE_DIALOG_REGISTRY_KEY,
    ADJUST_FILTER_DIALOG_ID_PREFIX
  } = await import("../../../src/ui/shell/document-view.js"));
});

describe("ui/shell/document-view.js", () => {
  it("isAdjustFilterDialogId detects afw_ prefix", () => {
    assert.equal(ADJUST_FILTER_DIALOG_ID_PREFIX, "afw_");
    assert.equal(isAdjustFilterDialogId("afw_fade"), true);
    assert.equal(isAdjustFilterDialogId("colorpicker"), false);
    assert.equal(isAdjustFilterDialogId({}), false);
  });

  it("CORE_DIALOG_REGISTRY_KEY is hyphen sentinel", () => {
    assert.equal(CORE_DIALOG_REGISTRY_KEY, "-");
  });

  it("getTopDialogFromStack returns null or last entry", () => {
    assert.equal(getTopDialogFromStack([]), null);
    assert.equal(getTopDialogFromStack([{ id: "a" }, { id: "b" }]).id, "b");
  });

  it("computeCascadeStackPosition matches margins", () => {
    const tiny = computeCascadeStackPosition(400, 400, 2);
    assert.equal(tiny.x, 0);
    assert.equal(tiny.y, 0);
    const roomy = computeCascadeStackPosition(800, 600, 2);
    assert.equal(roomy.x, 300);
    assert.equal(roomy.y, 300);
    const edge = computeCascadeStackPosition(450, 450, 1);
    assert.equal(edge.x, 150);
    assert.equal(edge.y, 150);
  });

  it("computeCenteredContentPosition floors and clamps", () => {
    const pos = computeCenteredContentPosition(1000, 800, 400, 200, 32);
    assert.equal(pos.x, 300);
    assert.equal(pos.y, 284);
    const tiny = computeCenteredContentPosition(100, 100, 200, 200, 32);
    assert.equal(tiny.x, 0);
    assert.equal(tiny.y, 0);
  });

  it("DocumentView getTopDialog / isActive on empty stack", () => {
    const view = Object.create(DocumentView.prototype);
    view.dialogStack = [];
    assert.equal(DocumentView.prototype.getTopDialog.call(view), null);
    assert.equal(DocumentView.prototype.isActive.call(view), false);
    view.dialogStack = [{ isActive: () => false }, { isActive: () => true }];
    assert.equal(DocumentView.prototype.isActive.call(view), true);
  });
});
