/**
 * SplashScreen home screen helpers.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { UiCommand } from "../../../src/core/event-bus.js";

installBrowserGlobals();

// The tab strip builds its panel-menu button from an icon URL at construction.

let SplashScreen;
let computeHomePanelStyle;
let resolveHomeActionPayload;
let consumeDoubleClick;
let DOUBLE_CLICK_WINDOW_MS;
let HOME_LOGO_CSS_PX;

before(async () => {
  ({
    SplashScreen,
    computeHomePanelStyle,
    resolveHomeActionPayload,
    consumeDoubleClick,
    DOUBLE_CLICK_WINDOW_MS,
    HOME_LOGO_CSS_PX
  } = await import("../../../src/ui/shell/splash-screen.js"));
});

describe("ui/shell/splash-screen.js", () => {
  it("computeHomePanelStyle fills the viewport", () => {
    assert.equal(HOME_LOGO_CSS_PX, 88);
    assert.equal(computeHomePanelStyle(1200, 800), "width:1200px; height:800px;");
  });

  it("resolveHomeActionPayload maps sidebar buttons", () => {
    assert.deepEqual(resolveHomeActionPayload(0), {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "newproject"
    });
    assert.deepEqual(resolveHomeActionPayload(1), {
      dispatchKind: UiCommand.pickLocalFiles,
      imagesOnly: true
    });
    assert.equal(resolveHomeActionPayload(2), null);
  });

  it("consumeDoubleClick window is 300ms", () => {
    assert.equal(DOUBLE_CLICK_WINDOW_MS, 300);
    const state = { lastTabClickTime: 0 };
    const realNow = Date.now;
    let fake = 1000;
    Date.now = () => fake;
    try {
      assert.equal(consumeDoubleClick(state), false);
      fake = 1200;
      assert.equal(consumeDoubleClick(state), true);
      fake = 1600;
      assert.equal(consumeDoubleClick(state), false);
    } finally {
      Date.now = realNow;
    }
  });

  it("exports SplashScreen constructor", () => {
    assert.equal(typeof SplashScreen, "function");
  });
});
