import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppEvent, EventType } from "../../src/core/event-bus.js";

describe("core/event-bus.js", () => {
  it("EventType values are frozen routing strings", () => {
    assert.equal(EventType.documentAction, "documentAction");
    assert.equal(EventType.uiDispatch, "uiDispatch");
    assert.equal(EventType.historyGrouped, "historyGrouped");
    assert.equal(EventType.widgetSelect, "widgetSelect");
    assert.equal(EventType.layerEffectsFlush, "layerEffectsFlush");
    assert.equal(EventType.chromeRepaint, "chromeRepaint");
    assert.equal(EventType.animationFrame, "animationFrame");
    assert.ok(Object.isFrozen(EventType));
  });

  it("AppEvent constructor sets defaults", () => {
    const evt = new AppEvent(EventType.uiDispatch);
    assert.equal(evt.type, "uiDispatch");
    assert.equal(evt.target, null);
    assert.equal(evt.currentTarget, null);
    assert.equal(evt.bubbles, false);
    assert.equal(evt.routingChannel, null);
    assert.equal(evt.fromDialog, false);
    assert.equal(evt.data, undefined);
  });

  it("AppEvent accepts bubbles flag", () => {
    const evt = new AppEvent("select", true);
    assert.equal(evt.type, "select");
    assert.equal(evt.bubbles, true);
  });

});
