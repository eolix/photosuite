
import { Rect } from "./math/rect.js";
import { EventType } from "./event-bus.js";
import { UiCommand } from "./event-bus.js";
import { AppEvent } from "./event-bus.js";
import { allocBuffer } from "../engine/compositing/buffer-utils.js";

/**
 * System clipboard for PhotoSuite (Tauri 2: macOS, Linux, Windows).
 *
 * Read/write uses `tauri-plugin-clipboard-manager` (arboard on the host OS).
 * The WebView async Clipboard API is not used.
 *
 * `appData.clipboardPixelPayload` holds the in-app session buffer for fast
 * repeat-paste of the last PhotoSuite copy. `paste` event `clipboardData` is
 * consulted when the OS pasteboard carries an image file during the paste gesture.
 */

const OS_CLIPBOARD_WRITE_MAX_PIXELS = 1024 * 1024;

/**
 * Baseline signature meaning "an in-app copy just happened but the pasteboard
 * probe has not resolved yet". Until it resolves, a paste treats the OS image
 * as stale so it uses the in-app pixel payload rather than whatever the
 * pasteboard still holds from before the copy.
 */
export const CLIPBOARD_SIGNATURE_PENDING = "pending";

/** Size-only signature of a clipboard image ({ width, height }), for freshness comparison. */
export function clipboardImageSignature(frame) {
  if (!frame || !frame.width || !frame.height) return "none";
  return frame.width + "x" + frame.height;
}

/**
 * True when the OS pasteboard image is unchanged since the last in-app copy, so
 * a paste should use the in-app pixel payload instead of re-importing it.
 * `baselineSignature` is captured at copy time; `null`/`undefined` means no
 * in-app copy is being tracked (external content wins).
 */
export function isStaleClipboardFrame(frame, baselineSignature) {
  if (!frame || baselineSignature == null) return false;
  if (baselineSignature === CLIPBOARD_SIGNATURE_PENDING) return true;
  return clipboardImageSignature(frame) === baselineSignature;
}

/** @returns {import("@tauri-apps/plugin-clipboard-manager").ClipboardManager | null} */
export function getTauriClipboardManager() {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  return tauri && tauri.clipboardManager ? tauri.clipboardManager : null;
}

export function writeClipboardText(text) {
  const clipboard = getTauriClipboardManager();
  if (clipboard && typeof clipboard.writeText === "function") {
    return clipboard.writeText(text).catch((err) => {
      console.warn("clipboard writeText failed", err);
    });
  }
  return Promise.resolve();
}

/** Tauri `JsImage::Rgba` expects a JSON array for rgba, not a TypedArray. */
function serializeBytesForTauriIpc(bytes) {
  if (Array.isArray(bytes)) return bytes;
  return Array.from(bytes);
}

/**
 * Writes RGBA to the system clipboard (Tauri `write_image` with JsImage::Rgba).
 * Deferred by the caller so copy/paste handlers return immediately.
 */
export function writeClipboardRgba(rgba, width, height) {

  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== "function") {
    return Promise.resolve();
  }

  if (width <= 0 || height <= 0) return Promise.resolve();
  if (width * height > OS_CLIPBOARD_WRITE_MAX_PIXELS) return Promise.resolve();

  const pixels = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
  if (pixels.length !== width * height * 4) return Promise.resolve();

  return tauri.core
    .invoke("plugin:clipboard-manager|write_image", {
      image: {
        rgba: serializeBytesForTauriIpc(pixels),
        width,
        height,
      },
    })
    .catch((err) => {
      console.warn("clipboard writeImage failed", err);
    });
}

/** Plain-text clipboard payload (paths prefix, URLs, etc.). */
export function writeClipboardBlob(blob) {
  if (blob.type === "text/plain" || blob.type.indexOf("text/") === 0) {
    return blob.text().then((text) => writeClipboardText(text));
  }
  return Promise.resolve();
}

export function readClipboardText() {
  const clipboard = getTauriClipboardManager();
  if (clipboard && typeof clipboard.readText === "function") {
    return clipboard.readText().catch(() => "");
  }
  return Promise.resolve("");
}

/**
 * @returns {Promise<{ rgba: Uint8ClampedArray, width: number, height: number } | null>}
 */
export function readClipboardRgba() {
  const clipboard = getTauriClipboardManager();
  if (!clipboard || typeof clipboard.readImage !== "function") {
    return Promise.resolve(null);
  }

  return clipboard
    .readImage()
    .then((image) => {
      if (!image || typeof image.rgba !== "function") return null;

      return image.rgba().then((rgba) => {
        const sizePromise = typeof image.size === "function" ? image.size() : null;
        if (sizePromise && typeof sizePromise.then === "function") {
          return sizePromise.then((size) => ({
            rgba: new Uint8ClampedArray(rgba),
            width: size.width,
            height: size.height,
          }));
        }
        return {
          rgba: new Uint8ClampedArray(rgba),
          width: image.width,
          height: image.height,
        };
      });
    })
    .catch(() => null);
}

/**
 * Reads a size-only signature of the current OS pasteboard image without
 * pulling pixel data. Resolves to "WxH", or "none" when no image is present or
 * the read fails.
 * @returns {Promise<string>}
 */
export function readClipboardImageSignature() {
  const clipboard = getTauriClipboardManager();
  if (!clipboard || typeof clipboard.readImage !== "function") {
    return Promise.resolve("none");
  }
  return clipboard
    .readImage()
    .then((image) => {
      if (!image) return "none";
      if (typeof image.size === "function") {
        const size = image.size();
        if (size && typeof size.then === "function") {
          return size.then((dims) => clipboardImageSignature(dims));
        }
        return clipboardImageSignature(size);
      }
      return clipboardImageSignature(image);
    })
    .catch(() => "none");
}

function encodeRgbaToPngBytes(rgba, width, height) {
  if (width <= 0 || height <= 0 || !rgba) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const clamped = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
  ctx.putImageData(new ImageData(clamped, width, height), 0, 0);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        resolve(null);
        return;
      }
      blob.arrayBuffer().then((buf) => {
        resolve(new Uint8Array(buf));
      });
    }, "image/png");
  });
}

function dispatchVectorPathClipboardText(controller, text) {
  if (!text || text.indexOf("vcb;") !== 0) return false;

  const evt = new AppEvent(EventType.uiDispatch, true);
  evt.data = {
    dispatchKind: UiCommand.pasteVectorPathsFromClipboard,
    value: text,
  };
  controller.dispatch(evt);
  return true;
}

function dispatchUrlClipboardText(controller, text) {
  if (!text || text.indexOf("http") !== 0) return false;
  if (typeof controller.onClipboardTextUrl === "function") {
    controller.onClipboardTextUrl(text);
    return true;
  }
  return false;
}

function normalizeRgbaPixelBuffer(rgba, width, height) {
  const byteLength = width * height * 4;
  if (!rgba || rgba.length !== byteLength) return null;
  if (rgba instanceof Uint8Array && !(rgba instanceof Uint8ClampedArray)) return rgba;

  const out = allocBuffer(byteLength);
  out.set(rgba);
  return out;
}

function importRgbaClipboardFrame(
  controller,
  frame,
  imageCallback,
  processLoadedBytesFn
) {
  if (!frame || !frame.rgba || frame.width <= 0 || frame.height <= 0) return false;

  const pixels = normalizeRgbaPixelBuffer(frame.rgba, frame.width, frame.height);
  if (!pixels) return false;

  if (imageCallback && typeof controller.applyClipboardImage === "function") {
    imageCallback(pixels, new Rect(0, 0, frame.width, frame.height));
    return true;
  }

  if (processLoadedBytesFn) {
    encodeRgbaToPngBytes(pixels, frame.width, frame.height).then((pngBytes) => {
      if (pngBytes) {
        processLoadedBytesFn({ name: "image.png" }, pngBytes.buffer, controller, imageCallback);
      }
    });
    return true;
  }

  return false;
}

export function dataTransferHasImage(dataTransfer) {
  if (!dataTransfer || !dataTransfer.items) return false;
  for (let i = 0; i < dataTransfer.items.length; i++) {
    if (dataTransfer.items[i].type.indexOf("image") === 0) return true;
  }
  return false;
}

export function dataTransferHasExternalContent(dataTransfer) {
  if (!dataTransfer || !dataTransfer.items) return false;
  for (let i = 0; i < dataTransfer.items.length; i++) {
    const type = dataTransfer.items[i].type;
    if (type.indexOf("image") === 0 || type.indexOf("text") === 0) return true;
  }
  return false;
}

export function applyDataTransferToController(
  controller,
  dataTransfer,
  imageCallback,
  fileLoaderRef
) {
  if (!dataTransfer || !dataTransfer.items) return false;

  const items = dataTransfer.items;
  let imageHandled = false;
  let handled = false;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (item.type.indexOf("text") !== -1) {
      item.getAsString((value) => {
        if (dispatchVectorPathClipboardText(controller, value)) return;
        dispatchUrlClipboardText(controller, value);
      });
      handled = true;
    }

    if (!imageHandled && item.type.indexOf("image") !== -1) {
      const file = item.getAsFile();
      if (file && controller.appData) {
        if (file.size === controller.appData.lastClipboardImageFileSize) continue;
        controller.appData.lastClipboardImageFileSize = file.size;
        file.name = "image.png";
        if (controller.fileLoader) {
          controller.fileLoader.loadLocalFiles([file], imageCallback);
          imageHandled = true;
          handled = true;
        }
      }
    }
  }

  return handled;
}

/**
 * Menu / programmatic paste from the OS clipboard.
 * @param {string} [baselineSignature] Pasteboard image signature captured at the
 *   last in-app copy. When the current pasteboard image matches it (unchanged
 *   since the copy) the image is treated as stale and skipped, so the caller
 *   falls back to the full-resolution in-app pixel payload.
 * @returns {Promise<boolean>} true when payload was applied
 */
export function readSystemClipboardForPaste(controller, imageCallback, fileLoaderRef, baselineSignature) {
  const processLoadedBytesFn = fileLoaderRef ? fileLoaderRef.processLoadedBytes : null;

  return readClipboardRgba().then((frame) => {
    if (
      frame &&
      !isStaleClipboardFrame(frame, baselineSignature) &&
      importRgbaClipboardFrame(controller, frame, imageCallback, processLoadedBytesFn)
    ) {
      return true;
    }

    return readClipboardText().then((text) => {
      if (dispatchVectorPathClipboardText(controller, text)) return true;
      if (dispatchUrlClipboardText(controller, text)) return true;
      return false;
    });
  });
}
