/**
 * DOM helpers shared by every widget: element construction, class lists, the
 * pointer-event listeners, device-pixel-ratio sizing, and event cancellation.
 *
 * The webview is WebKit on macOS and Linux and WebView2 on Windows, so the
 * pointer helpers fall back to mouse plus touch listeners where `PointerEvent`
 * is missing, and canvas sizing always goes through `getDevicePixelRatio`
 * rather than assuming 1:1 CSS pixels.
 */

import { Locale } from "./i18n/locale.js";

export function escapeHtml(html) {
  return html.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function setWidthHeightLabels(widthWidget, heightWidget) {
  widthWidget.setLabel(Locale.get("properties.width").charAt(0) + ":");
  heightWidget.setLabel(Locale.get("properties.height").charAt(0) + ":");
}

export function makeElement(tagName, className) {
  const el = document.createElement(tagName);
  if (className != null) el.setAttribute("class", className);
  return el;
}

export function clearElement(parent) {
  while (parent.firstChild) parent.removeChild(parent.firstChild);
}

export function addClass(el, cssClassName) {
  let list = el.getAttribute("class");
  if (list == null) list = "";
  const tokens = list.split(" ");
  if (tokens.indexOf(cssClassName) === -1) tokens.push(cssClassName);
  el.setAttribute("class", tokens.join(" "));
}

export function removeClass(el, cssClassName) {
  const list = el.getAttribute("class");
  if (list == null) return;
  const tokens = list.split(" ");
  const index = tokens.indexOf(cssClassName);
  if (index !== -1) tokens.splice(index, 1);
  el.setAttribute("class", tokens.join(" "));
}

/** Whether `domNode` is attached to a live document (supports iframes and embedded webviews). */
export function isInDOM(domNode) {
  for (let current = domNode; current != null; current = current.parentNode) {
    if (current.nodeType === 9) return true;
  }
  return false;
}

export function appendBreak(parent) {
  parent.appendChild(makeElement("br"));
}

export function appendHorizontalRule(parent) {
  parent.appendChild(makeElement("hr"));
}

/** Global for the active UI frame (`window`): `XMLHttpRequest`, `document`, `location`, etc. */

function addPointerListener(target, type, handler) {
  if (window.PointerEvent) {
    target.addEventListener(type, handler, false);
    return;
  }
  const fallbacks =
    type === "pointerdown"
      ? ["mousedown", "touchstart"]
      : type === "pointermove"
        ? ["mousemove", "touchmove"]
        : ["mouseup", "touchend"];
  for (const fallbackType of fallbacks) {
    target.addEventListener(fallbackType, handler, false);
  }
}

function removePointerListener(target, type, handler) {
  if (window.PointerEvent) {
    target.removeEventListener(type, handler, false);
    return;
  }
  const fallbacks =
    type === "pointerdown"
      ? ["mousedown", "touchstart"]
      : type === "pointermove"
        ? ["mousemove", "touchmove"]
        : ["mouseup", "touchend"];
  for (const fallbackType of fallbacks) {
    target.removeEventListener(fallbackType, handler, false);
  }
}

export function addPointerDownListener(target, handler) {
  addPointerListener(target, "pointerdown", handler);
}

export function addPointerMoveListener(target, handler) {
  addPointerListener(target, "pointermove", handler);
}

export function addPointerUpListener(target, handler) {
  addPointerListener(target, "pointerup", handler);
}

export function removePointerDownListener(target, handler) {
  removePointerListener(target, "pointerdown", handler);
}

export function removePointerMoveListener(target, handler) {
  removePointerListener(target, "pointermove", handler);
}

export function removePointerUpListener(target, handler) {
  removePointerListener(target, "pointerup", handler);
}

export function disableTouchGestures(target) {
  const block = preventDomDefaultAction;
  target.addEventListener("touchstart", block, false);
  target.addEventListener("touchmove", block, false);
  target.addEventListener("touchend", block, false);
  target.addEventListener("gesturestart", block, false);
  target.addEventListener("gesturechange", block, false);
  target.addEventListener("gestureend", block, false);
}

export function resizeCanvasForDevicePixelRatio(
  canvas,
  cssWidth,
  cssHeight,
  ctx2d
) {
  const scale = getDevicePixelRatio();
  canvas.width = Math.floor(cssWidth * scale);
  canvas.height = Math.floor(cssHeight * scale);
  canvas.style.width = canvas.width / scale + "px";
  canvas.style.height = canvas.height / scale + "px";
  if (ctx2d) ctx2d.setTransform(scale, 0, 0, scale, 0, 0);
}

export function setElementCssSizeForDeviceRatio(
  el,
  devicePixelsWidth,
  devicePixelsHeight
) {
  const cssScale = getDevicePixelRatio();
  el.setAttribute(
    "style",
    `width:${devicePixelsWidth / cssScale}px; height:${devicePixelsHeight / cssScale}px`
  );
}

export function getEventPos(evt, relativeToEl) {
  if (relativeToEl == null) relativeToEl = evt.currentTarget;
  const rect = relativeToEl.getBoundingClientRect();
  if (evt.touches) evt = evt.touches.item(0);
  return {
    x: evt.clientX - rect.left,
    y: evt.clientY - rect.top,
  };
}

export function getDevicePixelRatio() {
  return window.devicePixelRatio || 1;
}

export function cancel(evt) {
  evt.stopPropagation();
  evt.preventDefault();
}

export function preventDomDefaultAction(evt) {
  evt.preventDefault();
}
