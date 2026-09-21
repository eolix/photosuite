import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";

let RenderBuffer;
let restoreBrowserGlobals;

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ RenderBuffer } = await import("../../src/core/render-buffer.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("core/render-buffer.js", () => {
  it("ensureCapacity grows backing store", () => {
    const buf = new RenderBuffer();
    buf.ensureCapacity(0, 16);
    assert.ok(buf.data.length >= 16);
    const first = buf.data;
    buf.ensureCapacity(0, 1024);
    assert.ok(buf.data.length >= 1024);
    assert.notEqual(buf.data, first);
  });

  it("ensureCapacity preserves existing bytes", () => {
    const buf = new RenderBuffer();
    buf.ensureCapacity(0, 4);
    buf.data[0] = 42;
    buf.ensureCapacity(0, 8);
    assert.equal(buf.data[0], 42);
  });
});
