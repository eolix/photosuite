/**
 * DOM-backed UI node with parent chain, size getters, and bubbling event dispatch.
 * Most widgets and panels extend `BaseWidget`.
 */

import { EventEmitter } from "../../core/event-emitter.js";
import { addClass, removeClass } from "../../core/dom.js";

/**
 * DOM-backed UI node with parent chain, size getters, and bubbling dispatch.
 */
function BaseWidget() {
  EventEmitter.call(this);
  this.parent = null;
  this.el = null;
  this.width = 0;
  this.height = 0
}

BaseWidget.prototype = Object.create(EventEmitter.prototype);

BaseWidget.prototype.isDescendantOf = function(ancestor) {
  return isWidgetInAncestorChain(this, ancestor)
};

BaseWidget.prototype.getWidth = function() {
  return measureElementOuterWidth(this.el)
};

BaseWidget.prototype.getHeight = function() {
  return measureElementOuterHeight(this.el)
};

BaseWidget.prototype.update = function(evt) {};

BaseWidget.prototype.dispatch = function(evt) {
  bubbleDispatchThroughParents(this, evt)
};

BaseWidget.prototype.stopEvent = function(evt) {
  evt.stopPropagation();
  evt.preventDefault()
};

BaseWidget.prototype.buildUI = function() {};

/** @returns {string|*} i18n key or literal used for auto-generated row labels. */
BaseWidget.prototype.getLabelKey = function() {
  return this.labelKey != null ? this.labelKey : ""
};

BaseWidget.prototype.enable = function() {
  removeClass(this.el, "disabled")
};

BaseWidget.prototype.disable = function() {
  addClass(this.el, "disabled")
};

BaseWidget.prototype.setEnabled = function(enabled) {
  if (enabled) this.enable();
  else this.disable()
};

/**
 * Walk parent links; true when ancestor appears in the chain (including self).
 * @param {{ parent: * }} widget
 * @param {*} ancestor
 * @returns {boolean}
 */
function isWidgetInAncestorChain(widget, ancestor) {
  let node = widget;
  while (node != null) {
    if (node == ancestor) return true;
    node = node.parent
  }
  return false
}

function measureElementOuterWidth(el) {
  return el.offsetWidth + el.clientLeft
}

function measureElementOuterHeight(el) {
  return el.offsetHeight + el.clientTop
}

/**
 * Local EventEmitter dispatch, then bubble to parent when evt.bubbles.
 * @param {{ parent: *, dispatch: Function }} widget
 * @param {{ bubbles?: boolean }} evt
 */
function bubbleDispatchThroughParents(widget, evt) {
  EventEmitter.prototype.dispatch.call(widget, evt);
  if (evt.bubbles && widget.parent != null) widget.parent.dispatch(evt)
}

export {
  BaseWidget,
  isWidgetInAncestorChain,
  measureElementOuterWidth,
  measureElementOuterHeight
};
