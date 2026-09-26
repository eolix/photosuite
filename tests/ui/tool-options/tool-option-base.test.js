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
let AirbrushOption;
let BrushTool;
let EraserTool;

before(async () => {
  ({ ToolOptionBase, BrushOptionBase, CropOptionBase } = await import(
    "../../../src/ui/tool-options/tool-option-base.js"
  ));
  ({ PaintBrushOption, AirbrushOption } = await import(
    "../../../src/ui/tool-options/brush-fill-tool-options.js"
  ));
  ({ BrushTool, EraserTool } = await import("../../../src/document/tools/paint-tools.js"));
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

  /** The options bar with every widget reporting a known value. */
  function optionBarWith(OptionPanel, values) {
    const panel = new OptionPanel();
    for (const widgetKey of Object.keys(panel.widgets)) {
      const widgetValue = Object.prototype.hasOwnProperty.call(values, widgetKey) ? values[widgetKey] : 0;
      panel.widgets[widgetKey].getValue = () => widgetValue;
    }
    panel.sent = [];
    panel.dispatch = (evt) => panel.sent.push(evt);
    return panel;
  }

  // The bug this covers: the opacity slider emitted "opacity" while every paint
  // tool read "Opct", so opacity never reached the stroke — the brush and the
  // eraser painted at full strength whatever the slider said, and only flow
  // appeared to work.
  describe("options reach the tool that paints", () => {
    it("carries the opacity slider to the brush and the eraser", () => {
      const panel = optionBarWith(PaintBrushOption, { Opct: 5, flow: 40 });
      panel.emitToolSettings();
      const payload = panel.sent[0].data;
      assert.equal(payload.Opct, 0.05, "the payload does not carry opacity as the tool names it");
      assert.equal(payload.flow, 0.4);

      for (const Tool of [BrushTool, EraserTool]) {
        const tool = new Tool();
        tool.applyAction(payload, null, null, { isPressed: () => false }, {});
        assert.equal(tool.toolOptions.Opct, 0.05, Tool.name + " ignored the opacity slider");
        assert.equal(tool.toolOptions.flow, 0.4);
      }
    });

    // `applyAction` copies whatever it is handed onto the tool's options, so a
    // key the tool does not already have is one nothing reads.
    it("emits no option the tool does not already know", () => {
      for (const [OptionPanel, Tool] of [[PaintBrushOption, BrushTool], [AirbrushOption, EraserTool]]) {
        const panel = optionBarWith(OptionPanel, {});
        panel.emitToolSettings();
        const payload = panel.sent[0].data;
        const toolOptions = new Tool().toolOptions;
        for (const optionKey of Object.keys(payload)) {
          if (optionKey === "dispatchKind" || optionKey === "routingChannel") continue;
          assert.ok(
            Object.prototype.hasOwnProperty.call(toolOptions, optionKey),
            OptionPanel.name + " emits " + optionKey + ", which " + Tool.name + " never reads",
          );
        }
      }
    });
  });
});
