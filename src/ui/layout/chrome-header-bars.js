/**
 * App chrome header strips:
 * - ConfirmBar — hosts the active tool option panel while a confirmable
 *   tool mode is open
 * - LinkBar — scrollable viewport that wraps the top chrome row
 *   (menu / confirm / tool chrome) when it overflows
 *
 * Wired together in the shell: the confirm bar sits in the header row that
 * LinkBar scrolls.
 */
import { Point } from "../../core/math/point.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { addPointerDownListener, addPointerMoveListener, addPointerUpListener, clearElement, getEventPos, makeElement, preventDomDefaultAction, removePointerMoveListener, removePointerUpListener } from "../../core/dom.js";

const CONFIRM_BAR_CSS_CLASS = "confbar";

function buildLinkBarViewportStyle(width, height) {
  return "position:relative; width: " + width + "px; height: " + height + "px; overflow:hidden; white-space: nowrap; ";
}

function clampScrollAxisOffset(offset, minOffset) {
  return Math.min(0, Math.max(minOffset, offset));
}

/** Rubber-band horizontal drag anchors when the content hits its scroll limits. */
function adjustHorizontalDragAnchors(linkBar, contentOffsetX, minOffsetX, pointerPos) {
  if (contentOffsetX - 10 > 0) {
    linkBar.dragStartPointerPos.x = pointerPos.x - 10;
    linkBar.dragStartContentPos.x = 0;
  }
  if (contentOffsetX + 10 < minOffsetX) {
    linkBar.dragStartPointerPos.x = pointerPos.x + 10;
    linkBar.dragStartContentPos.x = minOffsetX;
  }
}

/**
 * Thin bar that shows a tool option panel during confirmable tool workflows
 * (crop, transform, and similar). The confbar CSS class is defined in all.css.
 */
export function ConfirmBar() {
  BaseWidget.call(this);
  this.el = makeElement("div", CONFIRM_BAR_CSS_CLASS);
}
ConfirmBar.prototype = Object.create(BaseWidget.prototype);

/** Replaces the bar contents with the given option panel and parents it for event bubbling. */
ConfirmBar.prototype.setOptionPanel = function(optionPanel) {
  optionPanel.parent = this;
  clearElement(this.el);
  this.el.appendChild(optionPanel.el);
};

/**
 * Scrollable chrome viewport. Horizontal mode pans on X; otherwise on Y.
 * @param {boolean} isHorizontal
 */
export function LinkBar(isHorizontal) {
  BaseWidget.call(this);
  this.el = makeElement("div");
  this.scrollContent = null;
  this.viewportWidth = 0;
  this.viewportHeight = 0;
  this.isHorizontal = isHorizontal;
  this.boundOnDragStart = this.onDragStart.bind(this);
  this.boundOnDragMove = this.onDrag.bind(this);
  this.boundOnDragEnd = this.onDragEnd.bind(this);
  this.dragStartContentPos = null;
  this.dragStartPointerPos = null;
  this.contentClientRect = null;
  addPointerDownListener(this.el, this.boundOnDragStart);
  this.el.addEventListener("touchmove", preventDomDefaultAction, false);
  this.isUiReady = true;
}
LinkBar.prototype = Object.create(BaseWidget.prototype);
LinkBar.prototype.buildUI = function() {};

LinkBar.prototype.onDragStart = function(event) {
  if (event.skipOverlayDismiss) {
    event.preventDefault();
    event.stopPropagation();
  }
  let dragTarget = window;
  addPointerMoveListener(dragTarget, this.boundOnDragMove);
  addPointerUpListener(dragTarget, this.boundOnDragEnd);
  dragTarget = this.scrollContent;
  this.dragStartContentPos = new Point(parseInt(dragTarget.style.left), parseInt(dragTarget.style.top));
  this.dragStartPointerPos = getEventPos(event, this.el);
  this.contentClientRect = dragTarget.getBoundingClientRect();
};

LinkBar.prototype.onDrag = function(event) {
  const pointerPos = getEventPos(event, this.el);
  const contentOffsetX = this.dragStartContentPos.x + pointerPos.x - this.dragStartPointerPos.x;
  const contentOffsetY = this.dragStartContentPos.y + pointerPos.y - this.dragStartPointerPos.y;
  const minOffsetX = this.viewportWidth - this.contentClientRect.width;
  const minOffsetY = this.viewportHeight - this.contentClientRect.height;
  if (this.isHorizontal) {
    this.scrollContent.style.left = clampScrollAxisOffset(contentOffsetX, minOffsetX) + "px";
  } else {
    this.scrollContent.style.top = clampScrollAxisOffset(contentOffsetY, minOffsetY) + "px";
  }
  adjustHorizontalDragAnchors(this, contentOffsetX, minOffsetX, pointerPos);
};

LinkBar.prototype.onDragEnd = function(event) {
  const dragTarget = window;
  removePointerMoveListener(dragTarget, this.boundOnDragMove);
  removePointerUpListener(dragTarget, this.boundOnDragEnd);
};

LinkBar.prototype.setScrollContent = function(scrollContentEl) {
  if (this.scrollContent) {
    this.el.removeChild(this.scrollContent);
  }
  this.scrollContent = scrollContentEl;
  this.el.appendChild(scrollContentEl);
  // Absolute so it can be panned past the viewport edge, but floored at the
  // viewport size: left to shrink-wrap it would stop at its widest bar, and
  // the rules those bars draw would end short of the window edge.
  scrollContentEl.style.position = "absolute";
  if (this.isHorizontal) {
    scrollContentEl.style.left = 0;
    scrollContentEl.style.minWidth = "100%";
  } else {
    scrollContentEl.style.top = 0;
    scrollContentEl.style.minHeight = "100%";
  }
};

LinkBar.prototype.resize = function(width, height) {
  this.viewportWidth = width;
  this.viewportHeight = height;
  this.el.setAttribute("style", buildLinkBarViewportStyle(width, height));
};
