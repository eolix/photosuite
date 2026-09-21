/**
 * tool-option panel split: exports + apply-tool dispatch shape.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { UiCommand } from "../../../src/core/event-bus.js";

installBrowserGlobals();

let ToolOptionBase;
let BrushOptionBase;
let CropOptionBase;
let PaintBrushOption;
let CompactCropOption;
let TextFontOptionBase;
let dispatchApplyDocumentToolAction;

before(async () => {
  ({ ToolOptionBase, BrushOptionBase, CropOptionBase } = await import(
    "../../../src/ui/tool-options/tool-option-base.js"
  ));
  ({ PaintBrushOption } = await import(
    "../../../src/ui/tool-options/brush-fill-tool-options.js"
  ));
  ({
    CompactCropOption,
    TextFontOptionBase,
    dispatchApplyDocumentToolAction
  } = await import("../../../src/ui/tool-options/shape-text-tool-options.js"));
});

describe("ui/tool-options split", () => {
  it("exports bases and concrete panels", () => {
    assert.equal(typeof ToolOptionBase, "function");
    assert.equal(typeof BrushOptionBase, "function");
    assert.equal(typeof CropOptionBase, "function");
    assert.equal(typeof PaintBrushOption, "function");
    assert.equal(typeof CompactCropOption, "function");
    assert.equal(typeof TextFontOptionBase, "function");
  });

  it("dispatchApplyDocumentToolAction sets dispatchKind (not opaque e)", () => {
    const sent = [];
    const panel = {
      routingChannel: 42,
      dispatch(evt) {
        sent.push(evt);
      }
    };
    dispatchApplyDocumentToolAction(panel, { subAction: "commit" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].data.dispatchKind, UiCommand.applyDocumentToolAction);
    assert.equal(sent[0].data.routingChannel, 42);
    assert.equal(sent[0].data.subAction, "commit");
    assert.equal(sent[0].data.e, undefined);
  });
});
