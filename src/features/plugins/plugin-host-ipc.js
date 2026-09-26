/**
 * Host-side plugin IPC for sidebar panels.
 *
 * Plugins post `{ psPlugin: 1, cmd, requestId, … }` objects. Replies go back to
 * the requesting iframe via `event.source.postMessage`.
 *
 * Only frames the sidebar created are answered. `getComposite` hands back the
 * user's document as pixels, so any other frame the app embeds must not be able
 * to ask for it just by knowing the message shape.
 *
 * Supported commands:
 * - `getComposite` — temporary composite (no layer flatten) as PNG bytes
 * - `getSelectionMask` — current selection's coverage, as a raw byte buffer
 * - `ping` — readiness check
 */

import { FileFormatRegistry } from "../../document/formats/registry/file-format-registry.js";

/** Marker on every plugin IPC message. */
export const PLUGIN_IPC_MARKER = 1;

/** Attribute {@link PluginPanel} stamps on the iframes it creates. */
export const PLUGIN_FRAME_ATTRIBUTE = "data-plugin-panel";

/**
 * @param {*} data
 * @returns {boolean}
 */
export function isPluginIpcMessage(data) {
  return data != null
    && typeof data === "object"
    && !(data instanceof ArrayBuffer)
    && data.psPlugin === PLUGIN_IPC_MARKER
    && typeof data.cmd === "string";
}

/**
 * True when `source` is the window of an iframe the sidebar created for a plugin.
 * Identity is compared against the live frames rather than a registry, so a panel
 * that has been torn down stops being trusted the moment its element is gone.
 * @param {MessageEventSource|null} source
 * @param {{ querySelectorAll: (selector: string) => ArrayLike<*> }} [root]
 * @returns {boolean}
 */
export function isPluginPanelFrame(source, root) {
  if (source == null) return false;
  const container = root != null ? root : (typeof document !== "undefined" ? document : null);
  if (container == null || typeof container.querySelectorAll !== "function") return false;
  const frames = container.querySelectorAll("iframe[" + PLUGIN_FRAME_ATTRIBUTE + "]");
  for (let frameIdx = 0; frameIdx < frames.length; frameIdx++) {
    if (frames[frameIdx].contentWindow === source) return true;
  }
  return false;
}

/**
 * @param {*} controller AppController
 * @param {{ psPlugin: number, cmd: string, requestId?: string }} message
 * @param {MessageEventSource|null} source
 */
export function handlePluginIpcMessage(controller, message, source) {
  // Unrecognised senders get no reply at all: an error response would confirm
  // both that the app is listening and which commands it knows.
  if (!isPluginPanelFrame(source)) return;
  const requestId = typeof message.requestId === "string" ? message.requestId : null;
  try {
    if (message.cmd === "ping") {
      replyToPlugin(source, {
        psPlugin: PLUGIN_IPC_MARKER,
        cmd: "pong",
        requestId
      });
      return;
    }
    if (message.cmd === "getComposite") {
      handleGetComposite(controller, requestId, source);
      return;
    }
    if (message.cmd === "getSelectionMask") {
      handleGetSelectionMask(controller, requestId, source);
      return;
    }
    replyToPlugin(source, {
      psPlugin: PLUGIN_IPC_MARKER,
      cmd: "error",
      requestId,
      error: "Unknown plugin command: " + message.cmd
    });
  } catch (err) {
    replyToPlugin(source, {
      psPlugin: PLUGIN_IPC_MARKER,
      cmd: "error",
      requestId,
      error: err && err.message ? err.message : String(err)
    });
  }
}

/**
 * @param {MessageEventSource|null} source
 * @param {object} payload
 * @param {Transferable[]} [transfer]
 */
function replyToPlugin(source, payload, transfer) {
  // Target origin stays "*" because a sandboxed plugin's origin is opaque and
  // cannot be named. The frame-identity check on the way in is what limits who
  // ever reaches this point.
  if (source == null || typeof source.postMessage !== "function") return;
  if (transfer && transfer.length) source.postMessage(payload, "*", transfer);
  else source.postMessage(payload, "*");
}

/**
 * Composite the active document into a PNG without permanently flattening layers.
 * @param {*} controller
 * @param {string|null} requestId
 * @param {MessageEventSource|null} source
 */
function handleGetComposite(controller, requestId, source) {
  const doc = controller.getCurrentDoc && controller.getCurrentDoc();
  if (doc == null) {
    replyToPlugin(source, {
      psPlugin: PLUGIN_IPC_MARKER,
      cmd: "error",
      requestId,
      error: "No open document"
    });
    return;
  }

  const sourceWidth = doc.width | 0;
  const sourceHeight = doc.height | 0;
  if (sourceWidth < 1 || sourceHeight < 1) {
    replyToPlugin(source, {
      psPlugin: PLUGIN_IPC_MARKER,
      cmd: "error",
      requestId,
      error: "Document has empty bounds"
    });
    return;
  }

  const rgba = doc.getRasterData();
  if (rgba == null) {
    replyToPlugin(source, {
      psPlugin: PLUGIN_IPC_MARKER,
      cmd: "error",
      requestId,
      error: "Composite buffer unavailable"
    });
    return;
  }

  const outBuffer = copyBytesToArrayBuffer(rgba);

  const pngFormat = FileFormatRegistry.getFormat("PNG");
  if (pngFormat == null || typeof pngFormat.encode !== "function") {
    replyToPlugin(source, {
      psPlugin: PLUGIN_IPC_MARKER,
      cmd: "error",
      requestId,
      error: "PNG encoder unavailable"
    });
    return;
  }

  const encoded = pngFormat.encode([[outBuffer, 0]], sourceWidth, sourceHeight);
  const pngBytes = toArrayBuffer(encoded);

  // width/height/scale are kept alongside sourceWidth/sourceHeight for wire
  // compatibility with clients written against the old downscaled reply;
  // the composite is always full resolution now, so width == sourceWidth
  // and scale is always 1.
  replyToPlugin(source, {
    psPlugin: PLUGIN_IPC_MARKER,
    cmd: "composite",
    requestId,
    width: sourceWidth,
    height: sourceHeight,
    sourceWidth,
    sourceHeight,
    scale: 1,
    mime: "image/png",
    png: pngBytes
  }, [pngBytes]);
}

/**
 * Export the current selection's coverage as a raw, tightly packed byte buffer:
 * one byte per pixel over the selection's bounding rect, 0 excluded, 255 fully
 * included, intermediate values for feathering and antialiasing. No selection
 * (as opposed to "Select All", which is a full-coverage selection like any
 * other) is reported as an error rather than an all-255 or all-0 buffer.
 * @param {*} controller
 * @param {string|null} requestId
 * @param {MessageEventSource|null} source
 */
function handleGetSelectionMask(controller, requestId, source) {
  const doc = controller.getCurrentDoc && controller.getCurrentDoc();
  if (doc == null) {
    replyToPlugin(source, {
      psPlugin: PLUGIN_IPC_MARKER,
      cmd: "error",
      requestId,
      error: "No open document"
    });
    return;
  }

  const selectionMask = doc.selectionMask;
  if (selectionMask == null) {
    replyToPlugin(source, {
      psPlugin: PLUGIN_IPC_MARKER,
      cmd: "error",
      requestId,
      error: "No selection"
    });
    return;
  }

  const rect = selectionMask.rect;
  const maskBuffer = copyBytesToArrayBuffer(selectionMask.channel);

  replyToPlugin(source, {
    psPlugin: PLUGIN_IPC_MARKER,
    cmd: "selectionMask",
    requestId,
    documentWidth: doc.width | 0,
    documentHeight: doc.height | 0,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    mime: "application/octet-stream",
    mask: maskBuffer
  }, [maskBuffer]);
}

/**
 * @param {ArrayBuffer|Uint8Array|*} encoded
 * @returns {ArrayBuffer}
 */
function toArrayBuffer(encoded) {
  if (encoded instanceof ArrayBuffer) return encoded;
  if (encoded && encoded.buffer) {
    return encoded.buffer.slice(
      encoded.byteOffset || 0,
      (encoded.byteOffset || 0) + encoded.byteLength
    );
  }
  return new Uint8Array(encoded).buffer;
}

/**
 * @param {Uint8Array|Uint8ClampedArray|ArrayBuffer} bytes
 * @returns {ArrayBuffer}
 */
function copyBytesToArrayBuffer(bytes) {
  if (bytes instanceof ArrayBuffer) return bytes.slice(0);
  const view = new Uint8Array(
    bytes.buffer || bytes,
    bytes.byteOffset || 0,
    bytes.byteLength != null ? bytes.byteLength : bytes.length
  );
  return view.slice(0).buffer;
}
