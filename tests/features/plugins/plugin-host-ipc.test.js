/**
 * host side of the plugin request channel.
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let isPluginIpcMessage;
let isPluginPanelFrame;
let handlePluginIpcMessage;
let PLUGIN_FRAME_ATTRIBUTE;
let realDocument;

/** A stand-in for a plugin iframe's window that records what the host sends it. */
function makeFrameWindow() {
  const window = { replies: [] };
  window.postMessage = (payload) => window.replies.push(payload);
  return window;
}

/** Make `document.querySelectorAll` report exactly these windows as plugin frames. */
function withPluginFrames(frameWindows) {
  globalThis.document = {
    querySelectorAll(selector) {
      assert.equal(selector, "iframe[" + PLUGIN_FRAME_ATTRIBUTE + "]");
      return frameWindows.map((contentWindow) => ({ contentWindow }));
    }
  };
}

before(async () => {
  realDocument = globalThis.document;
  ({
    isPluginIpcMessage,
    isPluginPanelFrame,
    handlePluginIpcMessage,
    PLUGIN_FRAME_ATTRIBUTE
  } = await import("../../../src/features/plugins/plugin-host-ipc.js"));
});

after(() => {
  globalThis.document = realDocument;
});

describe("features/plugins/plugin-host-ipc.js", () => {
  it("recognises the request shape and nothing else", () => {
    assert.equal(isPluginIpcMessage({ psPlugin: 1, cmd: "ping" }), true);
    // Action scripts and file drops travel the same window as requests, so the
    // shape test has to leave both of them alone.
    assert.equal(isPluginIpcMessage("app.echoToOE('hi')"), false);
    assert.equal(isPluginIpcMessage(new ArrayBuffer(8)), false);
    assert.equal(isPluginIpcMessage({ psPlugin: 2, cmd: "ping" }), false);
    assert.equal(isPluginIpcMessage({ psPlugin: 1 }), false);
    assert.equal(isPluginIpcMessage(null), false);
  });

  it("trusts a frame by identity, not by message shape", () => {
    const pluginWindow = makeFrameWindow();
    const otherWindow = makeFrameWindow();
    withPluginFrames([pluginWindow]);

    assert.equal(isPluginPanelFrame(pluginWindow), true);
    assert.equal(isPluginPanelFrame(otherWindow), false);
    assert.equal(isPluginPanelFrame(null), false);
  });

  it("answers a plugin frame's ping", () => {
    const pluginWindow = makeFrameWindow();
    withPluginFrames([pluginWindow]);

    handlePluginIpcMessage({}, { psPlugin: 1, cmd: "ping", requestId: "r1" }, pluginWindow);
    assert.deepEqual(pluginWindow.replies, [{ psPlugin: 1, cmd: "pong", requestId: "r1" }]);
  });

  it("stays silent for a frame the sidebar did not create", () => {
    // getComposite hands back the user's document as pixels. Any other embedded
    // page knowing the message shape must not be able to ask for it, and must not
    // even learn that anything is listening.
    const pluginWindow = makeFrameWindow();
    const intruderWindow = makeFrameWindow();
    withPluginFrames([pluginWindow]);

    handlePluginIpcMessage({}, { psPlugin: 1, cmd: "getComposite", requestId: "r2" }, intruderWindow);
    handlePluginIpcMessage({}, { psPlugin: 1, cmd: "ping", requestId: "r3" }, intruderWindow);
    handlePluginIpcMessage({}, { psPlugin: 1, cmd: "nope", requestId: "r4" }, intruderWindow);
    assert.deepEqual(intruderWindow.replies, []);
  });

  it("reports an unknown command and a missing document as errors", () => {
    const pluginWindow = makeFrameWindow();
    withPluginFrames([pluginWindow]);

    handlePluginIpcMessage({}, { psPlugin: 1, cmd: "nope", requestId: "r5" }, pluginWindow);
    assert.equal(pluginWindow.replies[0].cmd, "error");
    assert.match(pluginWindow.replies[0].error, /Unknown plugin command: nope/);

    handlePluginIpcMessage(
      { getCurrentDoc: () => null },
      { psPlugin: 1, cmd: "getComposite", requestId: "r6" },
      pluginWindow
    );
    assert.equal(pluginWindow.replies[1].cmd, "error");
    assert.equal(pluginWindow.replies[1].requestId, "r6");
    assert.match(pluginWindow.replies[1].error, /No open document/);
  });

  it("reports no selection, and no document, for getSelectionMask", () => {
    const pluginWindow = makeFrameWindow();
    withPluginFrames([pluginWindow]);

    handlePluginIpcMessage(
      { getCurrentDoc: () => null },
      { psPlugin: 1, cmd: "getSelectionMask", requestId: "r7" },
      pluginWindow
    );
    assert.equal(pluginWindow.replies[0].cmd, "error");
    assert.match(pluginWindow.replies[0].error, /No open document/);

    handlePluginIpcMessage(
      { getCurrentDoc: () => ({ width: 10, height: 10, selectionMask: null }) },
      { psPlugin: 1, cmd: "getSelectionMask", requestId: "r8" },
      pluginWindow
    );
    assert.equal(pluginWindow.replies[1].cmd, "error");
    assert.match(pluginWindow.replies[1].error, /No selection/);
  });

  it("returns the selection's bounding rect and coverage bytes", () => {
    const pluginWindow = makeFrameWindow();
    withPluginFrames([pluginWindow]);

    const channel = new Uint8Array([0, 128, 255, 255]);
    const doc = {
      width: 100,
      height: 80,
      selectionMask: { rect: { x: 5, y: 6, width: 2, height: 2 }, channel }
    };

    handlePluginIpcMessage(
      { getCurrentDoc: () => doc },
      { psPlugin: 1, cmd: "getSelectionMask", requestId: "r9" },
      pluginWindow
    );

    const reply = pluginWindow.replies[0];
    assert.equal(reply.cmd, "selectionMask");
    assert.equal(reply.requestId, "r9");
    assert.deepEqual(reply.rect, { x: 5, y: 6, width: 2, height: 2 });
    assert.equal(reply.documentWidth, 100);
    assert.equal(reply.documentHeight, 80);
    assert.deepEqual(new Uint8Array(reply.mask), channel);
    // The reply must own its bytes, not alias the document's live buffer.
    assert.notEqual(reply.mask, channel.buffer);
  });
});
