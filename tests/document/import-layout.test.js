import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";
import { installWebviewConfirm } from "../../src/core/user-prompts.js";

let computeDocumentDownscale;
let readRect;
let restoreBrowserGlobals;
let confirmUserResult;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  await import("../../src/engine/layer-system.js");
  installWebviewConfirm(() => confirmUserResult);
  ({ computeDocumentDownscale, readRect } = await import("../../src/document/import-layout.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/import-layout.js", () => {
  it("readRect builds a Rect from a frame object", () => {
    const rect = readRect({ x: 10, y: 20, width: 100, height: 50 });
    assert.equal(rect.x, 10);
    assert.equal(rect.y, 20);
    assert.equal(rect.width, 100);
    assert.equal(rect.height, 50);
  });

  it("computeDocumentDownscale returns 1 when within budget", () => {
    confirmUserResult = true;
    const scale = computeDocumentDownscale({ width: 4000, height: 3000 }, 8192 * 8192);
    assert.equal(scale, 1);
  });

  it("computeDocumentDownscale returns 2 when pixel budget requires downscale", () => {
    confirmUserResult = true;
    const scale = computeDocumentDownscale({ width: 12000, height: 12000 }, 8192 * 8192);
    assert.equal(scale, 2);
  });

  it("computeDocumentDownscale returns 1 when user declines downscale", () => {
    confirmUserResult = false;
    const scale = computeDocumentDownscale({ width: 12000, height: 12000 }, 8192 * 8192);
    assert.equal(scale, 1);
  });
});
