/**
 * tool activation helpers (temporary override, active id, path/shape set).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let ToolId;
let applyToolHandlers;
let resolveTemporaryToolOverride;
let resolveActiveToolId;
let isHandOrZoomChannel;
let isPathOrShapeToolId;
let PATH_OR_SHAPE_TOOL_IDS;
let DocumentModel;

before(async () => {
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  ({ DocumentModel } = await import("../../../src/document/model/tool-base.js"));
  ({
    applyToolHandlers,
    resolveTemporaryToolOverride,
    resolveActiveToolId,
    isHandOrZoomChannel,
    isPathOrShapeToolId,
    PATH_OR_SHAPE_TOOL_IDS
  } = await import("../../../src/ui/shell/app-controller-tools.js"));
});

describe("ui/shell/app-controller-tools.js", () => {
  it("isHandOrZoomChannel", () => {
    assert.equal(isHandOrZoomChannel(ToolId.TOOL_HAND), true);
    assert.equal(isHandOrZoomChannel(ToolId.TOOL_ZOOM), true);
    assert.equal(isHandOrZoomChannel(9999), false);
  });

  it("PATH_OR_SHAPE_TOOL_IDS lists nine tools; isPathOrShapeToolId gates", () => {
    assert.equal(PATH_OR_SHAPE_TOOL_IDS.size, 9);
    assert.equal(isPathOrShapeToolId(9999), false);
    assert.equal(isPathOrShapeToolId("not-a-tool"), false);
  });

  it("resolveTemporaryToolOverride picks first matching modifiers", () => {
    const keyboard = {
      isPressed: (k) => k === "Space"
    };
    const toolRegistry = {
      modifierToolOverrides: [
        {
          documentModelType: 50,
          activateWhileToolInactive: false,
          requiredModifierKeys: ["Space"]
        },
        {
          documentModelType: 51,
          activateWhileToolInactive: true,
          requiredModifierKeys: ["Ctrl"]
        }
      ]
    };
    const result = resolveTemporaryToolOverride(
      toolRegistry,
      keyboard,
      10,
      { isActive: () => false }
    );
    assert.equal(result.temporaryToolId, 50);
    assert.equal(result.activateWhileInactive, false);
  });

  it("resolveTemporaryToolOverride respects allowedBaseToolIds", () => {
    const keyboard = { isPressed: () => true };
    const toolRegistry = {
      modifierToolOverrides: [{
        documentModelType: 70,
        activateWhileToolInactive: true,
        requiredModifierKeys: ["Ctrl"],
        allowedBaseToolIds: [71]
      }]
    };
    const miss = resolveTemporaryToolOverride(
      toolRegistry,
      keyboard,
      10,
      { isActive: () => false }
    );
    assert.equal(miss.temporaryToolId, null);
    const hit = resolveTemporaryToolOverride(
      toolRegistry,
      keyboard,
      71,
      { isActive: () => false }
    );
    assert.equal(hit.temporaryToolId, 70);
  });

  it("resolveActiveToolId prefers pointerDown then temporary", () => {
    const controller = {
      appData: { activeToolId: 1 },
      toolRegistry: { pointerDownToolId: null, temporaryToolId: 7 }
    };
    assert.equal(resolveActiveToolId(controller, null), 7);
    assert.equal(resolveActiveToolId(controller, false), 1);
    controller.toolRegistry.pointerDownToolId = 9;
    assert.equal(resolveActiveToolId(controller, null), 9);
  });

  it("applyToolHandlers installs activateTool and getActiveToolEntry", () => {
    function FakeController() {}
    applyToolHandlers(FakeController);
    assert.equal(typeof FakeController.prototype.activateTool, "function");
    assert.equal(typeof FakeController.prototype.getActiveToolEntry, "function");
    assert.equal(typeof FakeController.prototype.updateTemporaryToolFromModifiers, "function");
  });
});
