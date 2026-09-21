/**
 * typr-worker message handling (mocked worker globals + Typr).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

let posted;
let onmessage;

before(async () => {
  posted = [];
  const selfMock = {
    postMessage: (msg) => posted.push(msg),
    set onmessage(fn) {
      onmessage = fn;
    },
    get onmessage() {
      return onmessage;
    },
  };
  globalThis.self = selfMock;
  globalThis.importScripts = () => {};
  // Typr stub: echoes byte length so we can assert the worker passes a byte view.
  globalThis.Typr = { parse: (bytes) => ({ byteLength: bytes.length }) };

  await import("../../src/fonts/typr-worker.js");
});

describe("fonts/typr-worker.js", () => {
  it("shims window onto self and installs an onmessage handler", () => {
    assert.equal(typeof onmessage, "function");
    assert.equal(globalThis.self.window, globalThis.self);
  });

  it("parses an ArrayBuffer as a byte view and posts ok:true", () => {
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    onmessage({ data: { id: 42, buf } });
    const msg = posted.at(-1);
    assert.equal(msg.id, 42);
    assert.equal(msg.ok, true);
    assert.deepEqual(msg.parsed, { byteLength: 4 });
  });

  it("reports parse failures as ok:false with a string error", () => {
    globalThis.Typr.parse = () => {
      throw new Error("bad font");
    };
    onmessage({ data: { id: 7, buf: new Uint8Array([0]) } });
    const msg = posted.at(-1);
    assert.equal(msg.id, 7);
    assert.equal(msg.ok, false);
    assert.equal(msg.error, "bad font");
  });
});
