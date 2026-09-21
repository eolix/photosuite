import { Locale } from "./i18n/locale.js";

/**
 * How the app talks to the person using it: the flying-banner toast, the
 * blocking acknowledgement dialog, and the confirmations shown before work is
 * discarded.
 *
 * {@link showToast} is the ordinary notification — it auto-dismisses and blocks
 * nothing. {@link alert} is a modal the person has to acknowledge, so it is for
 * the rare case where the app must not continue until they have read it.
 */

/**
 * The webview's own `confirm`, captured at startup before the app wraps it.
 * Set by `core/startup-wiring.js`.
 */
let webviewConfirm = null;

/** Remember the webview's unwrapped `confirm`. */
export function installWebviewConfirm(nativeConfirm) {
  webviewConfirm = nativeConfirm;
}

/**
 * Ask the webview's own `confirm` and return its answer, or null when it is
 * unavailable or answers asynchronously. Callers that cannot wait use this to
 * decide whether a synchronous answer is possible at all.
 */
export function tryNativeConfirmSync(message) {
  let nativeConfirm = webviewConfirm;
  if (typeof nativeConfirm !== "function") {
    nativeConfirm = typeof window !== "undefined" ? window.confirm : null;
  }
  if (typeof nativeConfirm !== "function") return null;

  try {
    const result = nativeConfirm.call(window, message);
    if (result != null && typeof result.then === "function") {
      result.then(() => {}, () => {});
      return null;
    }
    return !!result;
  } catch {
    return null;
  }
}

/**
 * Modal informational dialog with an OK button, via the native Tauri message
 * dialog. Reserve this for the rare case that genuinely needs the user to
 * acknowledge before continuing. Routine notifications ("… added", "No
 * selection", validation hints) use showToast — a flying banner, not a
 * modal. Fire-and-forget; returns immediately.
 */
export function showModalMessage(message) {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (tauri && tauri.core && typeof tauri.core.invoke === "function") {
    tauri.core
      .invoke("plugin:dialog|message", { message: String(message), title: "PhotoSuite", kind: "info" })
      .catch(() => {});
  }
}

/** Paints the banner. `OverlayManager` supplies it once the chrome exists. */
let paintToast = null;

/** Give the toast its painter. Called by `OverlayManager` when it builds the chrome. */
export function installToastPainter(painter) {
  paintToast = painter;
}

/**
 * Show a transient flying-banner toast that auto-dismisses (default ~1.5s).
 * This is the app's standard non-blocking notification — use it for status
 * messages, not {@link showModalMessage}, which is a modal the person has to acknowledge.
 * Silent before the chrome exists.
 * @param {string} message
 * @param {number} [durationMs]
 */
export function showToast(message, durationMs) {
  if (paintToast) paintToast(message, durationMs);
}

/**
 * User confirmation. Returns false when the host blocks dialogs (fail-closed).
 * Pass { whenBlocked: "proceed" } only when proceeding without a dialog is safe.
 */
export function confirmUser(message, options) {
  options = options || {};
  const sync = tryNativeConfirmSync(message);
  if (sync !== null) return sync;
  return options.whenBlocked === "proceed";
}

export function promptConfirmUser(message, options, callback) {
  options = options || {};
  const sync = tryNativeConfirmSync(message);
  if (sync !== null) {
    callback(sync);
    return;
  }

  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (tauri && tauri.core && typeof tauri.core.invoke === "function") {
    tauri.core
      .invoke("confirm_dialog", {
        message,
        title: options.title || "PhotoSuite",
      })
      .then((ok) => {
        callback(!!ok);
      })
      .catch(() => {
        callback(options.whenBlocked === "proceed");
      });
    return;
  }

  callback(options.whenBlocked === "proceed");
}

export function confirmUnsavedClose(message) {
  return confirmUser(message);
}

export function buildUnsavedCloseMessage(doc) {
  return (
    Locale.get("layer.thereIsUnsavedWorkIn") +
    " " +
    doc.name +
    ". " +
    Locale.get("layer.doYouReallyWantToCloseIt")
  );
}

export function promptUnsavedCloseForClose(doc, callback) {
  if (!doc.isModified()) {
    callback(true);
    return;
  }
  promptConfirmUser(
    buildUnsavedCloseMessage(doc),
    { title: "PhotoSuite" },
    callback
  );
}
