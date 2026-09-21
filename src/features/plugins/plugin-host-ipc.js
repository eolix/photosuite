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
 * - `ping` — readiness check
 */

import { FileFormatRegistry } from "../../document/formats/registry/file-format-registry.js";

/** Marker on every plugin IPC message. */
export const PLUGIN_IPC_MARKER = 1;

/** Attribute {@link PluginPanel} stamps on the iframes it creates. */
export const PLUGIN_FRAME_ATTRIBUTE = "data-plugin-panel";

/** Soft cap so OCR round-trips stay responsive. */
const MAX_COMPOSITE_EDGE_PX = 2048;

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

  const scale = Math.min(1, MAX_COMPOSITE_EDGE_PX / Math.max(sourceWidth, sourceHeight));
  let outWidth = sourceWidth;
  let outHeight = sourceHeight;
  let outBuffer;

  if (scale < 1) {
    outWidth = Math.max(1, Math.round(sourceWidth * scale));
    outHeight = Math.max(1, Math.round(sourceHeight * scale));
    outBuffer = downscaleRgba(rgba, sourceWidth, sourceHeight, outWidth, outHeight);
  } else {
    outBuffer = copyRgbaToArrayBuffer(rgba);
  }

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

  const encoded = pngFormat.encode([[outBuffer, 0]], outWidth, outHeight);
  const pngBytes = toArrayBuffer(encoded);

  replyToPlugin(source, {
    psPlugin: PLUGIN_IPC_MARKER,
    cmd: "composite",
    requestId,
    width: outWidth,
    height: outHeight,
    sourceWidth,
    sourceHeight,
    scale: outWidth / sourceWidth,
    mime: "image/png",
    png: pngBytes
  }, [pngBytes]);
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
 * @param {Uint8Array|Uint8ClampedArray|ArrayBuffer} rgba
 * @returns {ArrayBuffer}
 */
function copyRgbaToArrayBuffer(rgba) {
  if (rgba instanceof ArrayBuffer) return rgba.slice(0);
  const view = new Uint8Array(
    rgba.buffer || rgba,
    rgba.byteOffset || 0,
    rgba.byteLength != null ? rgba.byteLength : rgba.length
  );
  return view.slice(0).buffer;
}

/**
 * Nearest-neighbor RGBA downscale for OCR (fast; lossy is fine).
 * @param {Uint8Array|Uint8ClampedArray|ArrayBuffer} rgba
 * @param {number} srcW
 * @param {number} srcH
 * @param {number} dstW
 * @param {number} dstH
 * @returns {ArrayBuffer}
 */
function downscaleRgba(rgba, srcW, srcH, dstW, dstH) {
  const src = rgba instanceof ArrayBuffer
    ? new Uint8Array(rgba)
    : new Uint8Array(
      rgba.buffer || rgba,
      rgba.byteOffset || 0,
      rgba.byteLength != null ? rgba.byteLength : rgba.length
    );
  const dst = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const srcY = Math.min(srcH - 1, Math.floor(y * srcH / dstH));
    for (let x = 0; x < dstW; x++) {
      const srcX = Math.min(srcW - 1, Math.floor(x * srcW / dstW));
      const si = (srcY * srcW + srcX) * 4;
      const di = (y * dstW + x) * 4;
      dst[di] = src[si];
      dst[di + 1] = src[si + 1];
      dst[di + 2] = src[si + 2];
      dst[di + 3] = src[si + 3];
    }
  }
  return dst.buffer;
}
