import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { KeyboardHandler } from "../../../src/core/keyboard-handler.js";
import { Point } from "../../../src/core/math/point.js";
import { Rect } from "../../../src/core/math/rect.js";
import { makeElement } from "../../../src/core/dom.js";
import { UiCommand } from "../../../src/core/event-bus.js";
import { allocBuffer, fillBuffer } from "../../../src/engine/compositing/buffer-utils.js";

let ToolId;
let restoreBrowserGlobals;
let BrushTool;
let GradientTool;
let PaintBucketTool;
let PaintTool;

function patchDomForInputHandler() {
}

// Chain the tool prototypes these tests construct from.
function chainToolPrototypes() {
}

before(async () => {
  restoreBrowserGlobals = installBrowserGlobals();
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  await import("../../../src/engine/layer-system.js");
  patchDomForInputHandler();
  await import("../../../src/document/tools/paint-tools.js");
  ({ BrushTool, GradientTool, PaintBucketTool, PaintTool } = await import("../../../src/document/tools/paint-tools.js"));
});

after(() => {
  if (restoreBrowserGlobals) restoreBrowserGlobals();
});

describe("document/tools/paint-tools.js", () => {
  it("registerPaintTools wires paint and gradient tool constructors", () => {
    chainToolPrototypes();
    const brushTool = new BrushTool();
    const gradientTool = new GradientTool();

    assert.equal(typeof PaintTool, "function");
    assert.equal(brushTool.strokeCompositeMode, "draw");
    assert.equal(brushTool.id, ToolId.TOOL_BRUSH);
    assert.equal(gradientTool.id, ToolId.TOOL_GRADIENT);
    assert.equal(brushTool.rightDragAnchor, null);
    assert.equal(typeof brushTool.onMouseDown, "function");
    assert.equal(brushTool.toolOptions.bmode, "norm");
    assert.equal(gradientTool.toolOptions.gradientStyle, "Lnr");
  });

  it("buildFillAction maps foreground fill into descriptor", () => {
    chainToolPrototypes();
    const action = PaintTool.buildFillAction("FrgC", "norm", 0.5);

    assert.equal(action.uf, "fill");
    assert.equal(action.actionDescriptor.classID, "Fl");
    assert.equal(action.actionDescriptor.Usng.v.FlCn, "FrgC");
    assert.equal(action.actionDescriptor.Opct.v.val, 50);
    assert.equal(action.actionDescriptor.Md.v.blendMode, "Nrml");
  });

  it("adjustBrushSizeFromKeys shrinks diameter on bracket-left", () => {
    chainToolPrototypes();
    const brushDescriptor = {
      Brsh: {
        v: {
          diameter: { v: { val: 20 } },
          Hrdn: { v: { val: 50 } },
        },
      },
    };
    const keyboard = {
      isPressed(code) {
        return code === KeyboardHandler.BracketLeft;
      },
    };
    const adjusted = PaintTool.adjustBrushSizeFromKeys(
      JSON.parse(JSON.stringify(brushDescriptor)),
      keyboard,
    );

    assert.equal(adjusted.Brsh.v.diameter.v.val, 15);
    assert.equal(adjusted.Brsh.v.Hrdn.v.val, 50);
  });

  it("applyBrushFlowOpacity blends channel value with brush alpha", () => {
    chainToolPrototypes();
    const result = PaintTool.applyBrushFlowOpacity(128, 1, 1, 0, 200);
    assert.equal(result, 128);
  });

it("red-eye channel payload matches the setChannelData {bounds, hslShift} contract", async () => {
    const { HueSaturationParser } = await import("../../../src/document/formats/psd/adjustment-parsers.js");
    const { FilterDefs } = await import("../../../src/features/filters/filter-registry.js");
    const descriptor = FilterDefs.create("hue2");
    // The exact payload compositeSpongeRedeye sends for red-eye removal.
    HueSaturationParser.setChannelData(descriptor, 1, {
      bounds: [265, 305, 25, 55],
      hslShift: [0, -90, -70],
    });
    const entry = descriptor.Adjs.v.find((node) => node.v.LclR && node.v.LclR.v === 1).v;
    assert.equal(entry.H.v, 0);
    assert.equal(entry.Strt.v, -90);
    assert.equal(entry.Lght.v, -70);
    assert.deepEqual([entry.BgnR.v, entry.BgnS.v, entry.EndS.v, entry.EndR.v], [265, 305, 25, 55]);
  });

  it("compositeDodgeBurn lookup table matches applyBrushFlowOpacity exactly", () => {
    chainToolPrototypes();
    const apply = PaintTool.applyBrushFlowOpacity;
    // midtones-dodge parameters (rng=1): factor 1/(1+1), gamma 1/2 path
    const exposure = 1;
    const params = [
      [1 - exposure / 2, 1, exposure / 2],
      [1, 1 / (1 + exposure), 0],
      [1 / (1 - exposure / 2), 1, -(exposure / 2) / (1 - exposure / 2)],
    ];
    for (const [mf, gamma, off] of params) {
      const lut = new Float64Array(256);
      for (let v = 0; v < 256; v++) lut[v] = off + mf * Math.pow(v * (1 / 255), gamma);
      for (let v = 0; v < 256; v += 5) {
        for (let a = 0; a < 256; a += 7) {
          const viaLut = Math.max(0, Math.min(255, Math.round(lut[v] * a + v * (1 / 255) * (255 - a))));
          assert.equal(viaLut, apply(v, mf, gamma, off, a));
        }
      }
    }
  });

  it("resolvePaintTarget resolves layer pixels vs raster mask", () => {
    chainToolPrototypes();
    const tool = new BrushTool();
    const pixelLayer = { pixelContent: 0, buffer: new Uint8Array(16), rect: new Rect(0, 0, 2, 2) };
    const doc = { activeChannels: [], selectedLayerIndices: [0], layers: [pixelLayer], extraChannels: [] };
    const target = tool.resolvePaintTarget(doc);
    assert.equal(target.layerIndex, 0);
    assert.equal(target.maskTarget, null);
    assert.equal(target.pixelBuffer, pixelLayer.buffer);
    assert.deepEqual(target.sampleRect, pixelLayer.rect);

    const mask = { channel: new Uint8Array(4), rect: new Rect(1, 1, 2, 2) };
    const maskLayer = { pixelContent: 1, buffer: new Uint8Array(16), rect: new Rect(0, 0, 2, 2), getMask: () => mask };
    const maskDoc = { activeChannels: [], selectedLayerIndices: [0], layers: [maskLayer], extraChannels: [] };
    const maskTarget = tool.resolvePaintTarget(maskDoc);
    assert.equal(maskTarget.maskTarget, mask);
    assert.equal(maskTarget.pixelBuffer, mask.channel);
    assert.equal(maskTarget.pixelContentKind, 1);
  });

  it("clone-overlay crosshair fill uses the (buffer, value) signature", () => {
    const overlay = allocBuffer(11 * 11 * 4);
    fillBuffer(overlay, 16777215);
    // White RGB, transparent alpha — the crosshair loop then raises alpha.
    assert.equal(overlay[0], 255);
    assert.equal(overlay[1], 255);
    assert.equal(overlay[2], 255);
    assert.equal(overlay[3], 0);
  });

  it("dispatchBrushPresetPopup uses brushPreset wire on SCRIPTS popup dispatch", () => {
    chainToolPrototypes();
    const brushTool = new BrushTool();
    const dispatched = [];
    const dispatcher = {
      dispatch(event) {
        dispatched.push(event.data);
      },
      caller: {
        dispatch(event) {
          dispatched.push(event.data);
        },
      },
    };
    const brushDescriptor = { Brsh: { v: { diameter: { v: { val: 12 } } } } };
    brushTool.caller = dispatcher.caller;

    brushTool.dispatchBrushPresetPopup(brushDescriptor);

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].dispatchKind, UiCommand.openResourcePresetPopup);
    assert.equal(dispatched[0].brushPreset, brushDescriptor);
    assert.equal(dispatched[0].Un, undefined);
  });

  it("PaintBucketTool.enable dispatches default cursor overlay", () => {
    chainToolPrototypes();
    const paintBucketTool = new PaintBucketTool();
    const dispatched = [];
    const dispatcher = {
      dispatch(event) {
        dispatched.push(event.data);
      },
    };

    paintBucketTool.enable(null, dispatcher, {}, null);

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].dispatchKind, UiCommand.splashOptionsUpdate);
    assert.equal(dispatched[0].cursorOverlayId, "default");
  });
});
