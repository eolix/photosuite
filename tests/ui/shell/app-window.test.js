/**
 * AppWindow shell host: skip-chrome construct, overlay uiDispatch routing, resize.
 *
 * Golden values covering the module’s public behaviour.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { UiCommand } from "../../../src/core/event-bus.js";

installBrowserGlobals();

let AppWindow;
let routeOverlayUiDispatch;
let mountChildWidget;

before(async () => {
  ({
    AppWindow,
    routeOverlayUiDispatch,
    mountChildWidget
  } = await import("../../../src/ui/shell/app-window.js"));
});

describe("ui/shell/app-window.js", () => {
  // AppController takes this prototype rather than an instance of it, so the
  // shell methods are reachable without any chrome having been built.
  it("the prototype carries the shell methods without constructing chrome", () => {
    const shell = Object.create(AppWindow.prototype);
    assert.equal(shell.overlayManager, undefined);
    assert.equal(shell.documentView, undefined);
    assert.equal(shell.linkBar, undefined);
    assert.equal(shell.keyboardHandler, undefined);
    assert.equal(typeof shell.buildUI, "function");
    assert.equal(typeof shell.onUiDispatch, "function");
    assert.equal(typeof shell.resize, "function");
  });

  it("routeOverlayUiDispatch matches overlay call mapping", () => {
    const calls = [];
    const overlayManager = {
      showPopup(data) {
        calls.push(["showPopup", data.dispatchKind]);
      },
      removePopup(data) {
        calls.push(["removePopup", data.dispatchKind]);
      },
      showLoadingBar(label) {
        calls.push(["showLoadingBar", label]);
      },
      hideLoadingBar(label) {
        calls.push(["hideLoadingBar", label]);
      },
      removeScrollablePopups() {
        calls.push(["removeScrollablePopups"]);
      }
    };

    const cases = [
      {
        data: { dispatchKind: UiCommand.showFloatingOverlay },
        expected: [["showPopup", "showFloatingOverlay"]]
      },
      {
        data: { dispatchKind: UiCommand.closeFloatingOverlay },
        expected: [["removePopup", "closeFloatingOverlay"]]
      },
      {
        data: {
          dispatchKind: UiCommand.showAnalysisLoadingBanner,
          bannerLabel: "Analyzing"
        },
        expected: [["showLoadingBar", "Analyzing"]]
      },
      {
        data: {
          dispatchKind: UiCommand.hideAnalysisLoadingBanner,
          bannerLabel: "Analyzing"
        },
        expected: [["hideLoadingBar", "Analyzing"]]
      },
      {
        data: { dispatchKind: UiCommand.removeScrollableOverlayPopups },
        expected: [["removeScrollablePopups"]]
      },
      {
        data: { dispatchKind: "noop" },
        expected: []
      }
    ];

    for (const testCase of cases) {
      calls.length = 0;
      routeOverlayUiDispatch(overlayManager, testCase.data);
      assert.deepEqual(calls, testCase.expected);
    }
  });

  it("onUiDispatch on prototype routes through overlay manager (post-construct shape)", () => {
    const calls = [];
    const host = Object.create(AppWindow.prototype);
    host.overlayManager = {
      showPopup(data) {
        calls.push(["showPopup", data.dispatchKind]);
      },
      removePopup() {},
      showLoadingBar() {},
      hideLoadingBar() {},
      removeScrollablePopups() {}
    };
    host.onUiDispatch({
      data: { dispatchKind: UiCommand.showFloatingOverlay }
    });
    assert.deepEqual(calls, [["showPopup", "showFloatingOverlay"]]);
  });

  it("resize forwards viewport size to overlay and document view", () => {
    const calls = [];
    const host = Object.create(AppWindow.prototype);
    host.overlayManager = {
      resize(widthPx, heightPx) {
        calls.push(["om.resize", widthPx, heightPx]);
      }
    };
    host.documentView = {
      resize(widthPx, heightPx) {
        calls.push(["dv.resize", widthPx, heightPx]);
      }
    };
    host.resize(640, 480);
    assert.deepEqual(calls, [
      ["om.resize", 640, 480],
      ["dv.resize", 640, 480]
    ]);
  });

  it("mountChildWidget sets parent and appends child.el", () => {
    const parent = { id: "parent" };
    const hostEl = {
      children: [],
      appendChild(child) {
        this.children.push(child);
        return child;
      }
    };
    const child = { el: { tag: "child-el" } };
    const mounted = mountChildWidget(parent, child, hostEl);
    assert.equal(mounted, child);
    assert.equal(child.parent, parent);
    assert.deepEqual(hostEl.children, [child.el]);
  });
});
