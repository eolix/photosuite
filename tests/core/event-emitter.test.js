import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";

let EventEmitter;
let AppEvent;
let EventType;

before(async () => {
  installBrowserGlobals();
  const bus = await import("../../src/core/event-bus.js");
  AppEvent = bus.AppEvent;
  EventType = bus.EventType;
  ({ EventEmitter } = await import("../../src/core/event-emitter.js"));
});

describe("core/event-emitter.js", () => {
  it("dispatches listeners in registration order", () => {
    const emitter = new EventEmitter();
    const order = [];
    emitter.on("test", () => order.push(1));
    emitter.on("test", () => order.push(2));
    emitter.dispatch(new AppEvent("test"));
    assert.deepEqual(order, [1, 2]);
  });

  it("removeEventListener stops further delivery", () => {
    const emitter = new EventEmitter();
    let count = 0;
    const handler = () => count++;
    emitter.on("tick", handler);
    emitter.dispatch(new AppEvent("tick"));
    emitter.removeEventListener("tick", handler);
    emitter.dispatch(new AppEvent("tick"));
    assert.equal(count, 1);
  });

  it("hasListeners reflects registration state", () => {
    const emitter = new EventEmitter();
    assert.equal(emitter.hasListeners(EventType.animationFrame), false);
    const handler = () => {};
    emitter.on(EventType.animationFrame, handler);
    assert.equal(emitter.hasListeners(EventType.animationFrame), true);
    emitter.removeEventListener(EventType.animationFrame, handler);
    assert.equal(emitter.hasListeners(EventType.animationFrame), false);
  });

  // A subclass takes its base's prototype with Object.create, so the base
  // constructor runs per instance. Building the prototype from an instance
  // instead would run it once and hand every subclass object the same
  // listener table.
  it("subclass instances keep their own listener tables", () => {
    function Widget() {
      EventEmitter.call(this);
    }
    Widget.prototype = Object.create(EventEmitter.prototype);

    const first = new Widget();
    const second = new Widget();
    assert.notEqual(first._listeners, second._listeners);

    const handler = () => {};
    first.on(EventType.animationFrame, handler);
    assert.equal(first.hasListeners(EventType.animationFrame), true);
    assert.equal(second.hasListeners(EventType.animationFrame), false);
    // Nothing was left on the prototype for them to share in the first place.
    assert.equal(Widget.prototype._listeners, undefined);
  });
});
