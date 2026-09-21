import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

let ImportLayout;
let computeDocumentDownscale;
let readRect;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  const mod = await import("../../../src/document/import-layout.js");
  ImportLayout = mod.ImportLayout;
  computeDocumentDownscale = mod.computeDocumentDownscale;
  readRect = mod.readRect;
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/import-layout.js", () => {
  it("ImportLayout exposes shared layout helpers", () => {
    assert.equal(typeof ImportLayout.computeDocumentDownscale, "function");
    assert.equal(typeof ImportLayout.readRect, "function");
  });

  it("readRect maps frame JSON to Rect", () => {
    const rect = readRect({ x: 1, y: 2, width: 3, height: 4 });
    assert.equal(rect.width, 3);
    assert.equal(rect.height, 4);
  });

  it("computeDocumentDownscale returns 1 for small bounds", () => {
    assert.equal(computeDocumentDownscale({ width: 100, height: 100, x: 0, y: 0 }, 8192 * 8192), 1);
  });
});
