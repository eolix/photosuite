/**
 * launch URL parse, scriptHostData, environment toolbar options.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let applyLaunchHandlers;
let parseLaunchQueryFromHref;
let buildFileScriptHostData;
let applyEnvironmentConfig;

before(async () => {
  ({
    applyLaunchHandlers,
    parseLaunchQueryFromHref,
    buildFileScriptHostData,
    applyEnvironmentConfig
  } = await import("../../../src/ui/shell/app-controller-launch.js"));
});

describe("ui/shell/app-controller-launch.js", () => {
  it("parseLaunchQueryFromHref reads ?p= payload", () => {
    const parsed = parseLaunchQueryFromHref("https://app.example/?p=%7B%22x%22%3A1%7D");
    assert.equal(parsed.queryKey, "p");
    assert.equal(parsed.payloadText, "%7B%22x%22%3A1%7D");
  });

  it("parseLaunchQueryFromHref prefers hash as p payload", () => {
    const parsed = parseLaunchQueryFromHref("https://app.example/#%7B%22a%22%3A2%7D");
    assert.equal(parsed.queryKey, "p");
    assert.equal(parsed.payloadText, "%7B%22a%22%3A2%7D");
  });

  it("buildFileScriptHostData maps server/script fields", () => {
    assert.deepEqual(
      buildFileScriptHostData({ server: "https://host", script: "run()" }),
      { hostServer: "https://host", startupScript: "run()" }
    );
  });

  it("applyEnvironmentConfig sets serverToolbarOptions from tmnu wire", () => {
    const controller = {
      appData: { activeToolId: 1, hideIntro: false },
      rightSidebar: { registerRuntimePlugins: () => {} },
      setChromeLayoutMode: () => {},
      activateTool: () => {},
      dispatch: () => {}
    };
    applyEnvironmentConfig(controller, { tmnu: { t1: { a: 1 } }, vmode: 1 });
    assert.deepEqual(controller.appData.serverToolbarOptions, { t1: { a: 1 } });
    assert.equal(controller.appData.compact, true);
  });

  it("applyEnvironmentConfig showtools updates allowedToolIds", () => {
    const activated = [];
    const controller = {
      appData: { activeToolId: 99 },
      rightSidebar: { registerRuntimePlugins: () => {} },
      setChromeLayoutMode: () => {},
      activateTool: (id) => activated.push(id),
      dispatch: () => {}
    };
    applyEnvironmentConfig(controller, { showtools: [3, 5] });
    assert.deepEqual(controller.appData.allowedToolIds, [3, 5]);
    assert.deepEqual(activated, [3]);
  });

  it("applyLaunchHandlers installs finishLaunchFromQueryString", () => {
    function FakeController() {}
    applyLaunchHandlers(FakeController);
    assert.equal(typeof FakeController.prototype.finishLaunchFromQueryString, "function");
    const controller = Object.create(FakeController.prototype);
    controller.appData = { hasLaunched: true };
    FakeController.prototype.finishLaunchFromQueryString.call(controller);
    assert.equal(controller.appData.hasLaunched, true);
  });
});
