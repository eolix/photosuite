/**
 * Event dispatch primitive for widgets and the application shell.
 * See {@link EventEmitter} for listener registration and {@link EventEmitter#dispatch}.
 */

import { AppEvent, EventType } from "./event-bus.js";

/**
 * Minimal publish/subscribe emitter used by widgets and the app shell.
 * Listeners are registered with {@link EventEmitter#on} or
 * {@link EventEmitter#addEventListener}; {@link EventEmitter#dispatch} invokes
 * them in registration order.
 */
function EventEmitter() {
  /** @type {Record<string, Array<{ fn: Function, ctx: * }>>} */
  this._listeners = {};
}

/** Emitters that have at least one `animationFrame` listener. */
EventEmitter._rafEmitters = new Set();

EventEmitter._onAnimationFrame = function () {
  var subscribers = EventEmitter._rafEmitters;
  if (subscribers.size !== 0) {
    var frameEvent = new AppEvent(EventType.animationFrame);
    subscribers.forEach(function (emitter) {
      emitter.dispatch(frameEvent);
    });
  }
  window.requestAnimationFrame(EventEmitter._onAnimationFrame);
};

window.requestAnimationFrame(EventEmitter._onAnimationFrame);

EventEmitter.prototype.hasListeners = function (type) {
  var entries = this._listeners[type];
  return entries != null && entries.length > 0;
};

EventEmitter.prototype.addEventListener = function (type, handler) {
  this.on(type, handler, null);
};

EventEmitter.prototype.on = function (type, handler, context) {
  var entries = this._listeners[type];
  if (entries == null) {
    entries = [];
    this._listeners[type] = entries;
  }
  entries.push({ fn: handler, ctx: context });
  if (type === EventType.animationFrame) {
    EventEmitter._rafEmitters.add(this);
  }
};

EventEmitter.prototype.removeEventListener = function (type, handler) {
  var entries = this._listeners[type];
  if (entries == null) return;

  for (var i = 0; i < entries.length; i++) {
    if (entries[i].fn === handler) {
      entries.splice(i, 1);
      if (type === EventType.animationFrame && entries.length === 0) {
        EventEmitter._rafEmitters.delete(this);
      }
      return;
    }
  }
};

EventEmitter.prototype.dispatch = function (evt) {
  evt.currentTarget = this;
  if (evt.target == null) evt.target = this;

  var entries = this._listeners[evt.type];
  if (entries == null) return;

  // Snapshot before iteration: re-entrant add/remove during dispatch won't corrupt the loop.
  var snapshot = entries.slice();
  for (var i = 0; i < snapshot.length; i++) {
    var entry = snapshot[i];
    if (entry.ctx == null) {
      entry.fn(evt);
    } else {
      entry.fn.call(entry.ctx, evt);
    }
  }
};

export { EventEmitter };
