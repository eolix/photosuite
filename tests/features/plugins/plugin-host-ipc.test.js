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
});
