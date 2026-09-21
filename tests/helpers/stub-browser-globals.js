/**
 * Minimal browser globals for importing format loaders in Node tests.
 * @returns {() => void} restore previous globals
 */
export function installBrowserGlobals() {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    getComputedStyle: globalThis.getComputedStyle,
  };

  const eventListeners = new Map();

  globalThis.window = {
    // All three target webviews (WebKit, WebKitGTK, WebView2) fire pointer
    // events, so core/dom.js takes its direct path rather than the mouse and
    // touch fallbacks.
    PointerEvent: class PointerEvent {},
    addEventListener(type, handler) {
      if (!eventListeners.has(type)) eventListeners.set(type, []);
      eventListeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = eventListeners.get(type);
      if (!list) return;
      const index = list.indexOf(handler);
      if (index !== -1) list.splice(index, 1);
    },
    requestAnimationFrame() {
      return 0;
    },
    cancelAnimationFrame() {},
    alert() {},
    WebAssembly: {
      Module: class WebAssemblyModule {},
      Instance: class WebAssemblyInstance {},
      instantiate() {
        return Promise.resolve({ instance: { exports: {} } });
      },
    },
  };

  globalThis.document = {
    // nodeType 9 is DOCUMENT_NODE: core/dom.js isInDOM() walks parentNode
    // looking for it, so anything this fake creates counts as attached.
    nodeType: 9,
    createElement() {
      return {
        width: 0,
        height: 0,
        // Detached until something appends it, as in a real document.
        parentNode: null,
        style: {},
        className: "",
        children: [],
        setAttribute() {},
        getAttribute() {
          return null;
        },
        // core/dom.js clearElement() drains firstChild, so the fake tracks it.
        get firstChild() {
          return this.children[0];
        },
        appendChild(child) {
          this.children.push(child);
          if (child != null) child.parentNode = this;
          return child;
        },
        removeChild(child) {
          const index = this.children.indexOf(child);
          if (index !== -1) this.children.splice(index, 1);
          return child;
        },
        addEventListener() {},
        removeEventListener() {},
        getContext() {
          return null;
        },
      };
    },
    createTextNode(text) {
      return { textContent: String(text) };
    },
    body: {
      appendChild(child) {
        if (child != null) child.parentNode = this;
        return child;
      },
      removeChild() {},
      // Chrome widgets listen on the body for dismiss gestures.
      addEventListener() {},
      removeEventListener() {},
      // Widgets measure drag offsets against the body rect.
      getBoundingClientRect() {
        return { left: 0, top: 0, right: 1280, bottom: 800, width: 1280, height: 800 };
      },
    },
  };

  // The body hangs off the document, so anything appended to it is on screen.
  globalThis.document.body.parentNode = globalThis.document;

  // A top-level window, as the app's own is; a plugin panel's frame is not.
  globalThis.window.self = globalThis.window;
  globalThis.window.top = globalThis.window;

  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame;

  // Layout code reads padding and border widths off computed style. Nothing
  // here lays anything out, so every length reads as zero unless a test's own
  // element carries a `computedStyle` of its own.
  globalThis.getComputedStyle = function getComputedStyle(element) {
    return (element && element.computedStyle) || {};
  };
  globalThis.window.getComputedStyle = globalThis.getComputedStyle;

  globalThis.BINDB = new Proxy(
    { "wasm/jpg": "about:blank", "wasm/webp": "about:blank" },
    {
      get(target, key) {
        if (key in target) return target[key];
        return "about:blank";
      },
    }
  );
  globalThis.pako = {
    inflateRaw(bytes) {
      return bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
    },
    deflateRaw(bytes) {
      return bytes;
    },
  };
  globalThis.UZIP = { deflateRaw(bytes) { return bytes; } };
  globalThis.btoa = function (text) {
    return Buffer.from(text, "binary").toString("base64");
  };
  globalThis.WebAssembly = globalThis.window.WebAssembly;
  globalThis.XMLHttpRequest = class XMLHttpRequest {
    open() {}
    overrideMimeType() {}
    send() {
      this.responseText = "";
    }
  };

  return function restoreBrowserGlobals() {
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    globalThis.getComputedStyle = previous.getComputedStyle;
    globalThis.requestAnimationFrame = previous.requestAnimationFrame;
    globalThis.cancelAnimationFrame = previous.cancelAnimationFrame;
  };
}
