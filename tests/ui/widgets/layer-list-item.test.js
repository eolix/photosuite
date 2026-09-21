/**
 * LayerListItem selection-event goldens.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { EventType } from "../../../src/core/event-bus.js";
import { getDevicePixelRatio } from "../../../src/core/dom.js";

installBrowserGlobals();

let ToolId;
let LayerListItem;
let selectionModifierFlagsFromPointerEvent;
let isCompositeChannelRowIndex;
let compositeChannelEnumForRowIndex;
let resolveVisibilityEyeCssSize;

before(async () => {
  ({ ToolId } = await import("../../../src/document/model/tool-base.js"));
  ({
    LayerListItem,
    selectionModifierFlagsFromPointerEvent,
    isCompositeChannelRowIndex,
    compositeChannelEnumForRowIndex,
    resolveVisibilityEyeCssSize
  } = await import("../../../src/ui/widgets/layer-list-item.js"));
});

function pointerMods(shiftKey, altKey) {
  return { shiftKey: !!shiftKey, altKey: !!altKey };
}

describe("ui/widgets/layer-list-item.js", () => {
  it("selectionModifierFlagsFromPointerEvent packs shift/alt", () => {
    assert.equal(selectionModifierFlagsFromPointerEvent(pointerMods(false, false)), 0);
    assert.equal(selectionModifierFlagsFromPointerEvent(pointerMods(true, false)), 1);
    assert.equal(selectionModifierFlagsFromPointerEvent(pointerMods(false, true)), 2);
    assert.equal(selectionModifierFlagsFromPointerEvent(pointerMods(true, true)), 3);
  });

  it("composite channel row index / enum map", () => {
    assert.equal(isCompositeChannelRowIndex(-1), true);
    assert.equal(isCompositeChannelRowIndex(-4), true);
    assert.equal(isCompositeChannelRowIndex(-5), false);
    assert.equal(isCompositeChannelRowIndex(0), false);
    assert.equal(compositeChannelEnumForRowIndex(-1), "RGB");
    assert.equal(compositeChannelEnumForRowIndex(-2), "Rd");
    assert.equal(compositeChannelEnumForRowIndex(-3), "Grn");
    assert.equal(compositeChannelEnumForRowIndex(-4), "Bl");
  });

  // Clicking a composite channel row loads that channel as the selection. The
  // modifier decides how it combines with what is already selected, and the
  // channel reaches Photoshop as an Enmr reference inside the action.
  it("buildSelectionEvent goldens — composite channels", () => {
    // The channel and the selection swap places between combine modes, so find
    // the reference that carries the channel enum rather than assuming a slot.
    function channelEnumOf(evt) {
      const descriptor = evt.data.actionDescriptor;
      for (const ref of Object.values(descriptor)) {
        const enumEntry = ref?.v?.find?.((entry) => entry.t === "Enmr");
        if (enumEntry) return enumEntry.v.enum;
      }
      return null;
    }

    var rgb = LayerListItem.buildSelectionEvent(true, -1, pointerMods(false, false));
    assert.equal(rgb.type, EventType.historyGrouped);
    assert.equal(rgb.data.uf, "set");
    assert.equal(channelEnumOf(rgb), "RGB");

    var rdShift = LayerListItem.buildSelectionEvent(true, -2, pointerMods(true, false));
    assert.equal(rdShift.data.uf, "add");
    assert.equal(channelEnumOf(rdShift), "Rd");

    var grnAlt = LayerListItem.buildSelectionEvent(true, -3, pointerMods(false, true));
    assert.equal(grnAlt.data.uf, "subtract");
    assert.equal(channelEnumOf(grnAlt), "Grn");

    var blBoth = LayerListItem.buildSelectionEvent(true, -4, pointerMods(true, true));
    assert.equal(blBoth.data.uf, "interfaceIconFrameDimmed");
    assert.equal(channelEnumOf(blBoth), "Bl");
  });

  it("buildSelectionEvent goldens — fromchannel / frompath", () => {
    var fromCh = LayerListItem.buildSelectionEvent(true, 3, pointerMods(true, false));
    assert.equal(fromCh.type, EventType.documentAction);
    // A channel selection is routed to the rectangular-marquee tool.
    assert.equal(fromCh.routingChannel, ToolId.TOOL_RECT_SELECT);
    assert.deepEqual(fromCh.data, {
      actionKind: "fromchannel",
      selectionSource: [3, 0, 1]
    });

    var fromPath = LayerListItem.buildSelectionEvent(false, 2, pointerMods(false, true));
    assert.deepEqual(fromPath.data, {
      actionKind: "frompath",
      selectionSource: [2, 0, 2]
    });

    var boundary = LayerListItem.buildSelectionEvent(true, -5, pointerMods(false, false));
    assert.deepEqual(boundary.data, {
      actionKind: "fromchannel",
      selectionSource: [-5, 0, 0]
    });
  });

  // The eye is drawn from a fixed device-pixel bitmap, so a fractional ratio
  // has to be divided back out; whole ratios already land on pixel bounds.
  it("resolveVisibilityEyeCssSize scales fractional DPR", () => {
    const previous = window.devicePixelRatio;
    window.devicePixelRatio = 1.25;
    assert.equal(resolveVisibilityEyeCssSize(15), 15 / 1.25);
    window.devicePixelRatio = 1;
    assert.equal(resolveVisibilityEyeCssSize(15), 15);
    window.devicePixelRatio = 2;
    assert.equal(resolveVisibilityEyeCssSize(15), 15);
    window.devicePixelRatio = previous;
  });
});
