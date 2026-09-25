/**
 * Calls into the Tauri host: the native save dialog, writing a chosen file,
 * opening a URL in the OS browser, and printing.
 *
 * The app runs only as a Tauri desktop application, so the bridge is always
 * there. The webview is WebKit on macOS and Linux and WebView2 on Windows, and
 * none of them may touch the filesystem directly — every path here goes through
 * an `invoke` the Rust side answers.
 */

/**
 * True when the native clipboard plugin can be used. A plugin panel runs in a
 * nested frame and writes through its host instead.
 */
export function canWriteClipboard() {
  return window.top === window.self;
}

function toUint8Array(bytes) {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/**
 * Show the native Save dialog. Resolves to the chosen absolute path, or null if
 * the user cancelled. Does not encode or write file data.
 *
 * `opts.directoryKey` selects which remembered folder seeds the dialog
 * ("lastExportDirectory" for exports, "lastSaveDirectory" for Save As); when
 * `opts.defaultDirectory` is set it takes precedence.
 */
export function pickSavePath(defaultName, opts) {
  opts = opts || {};
  return window.__TAURI__.core.invoke("pick_save_path", {
    defaultName,
    defaultDirectory: opts.defaultDirectory || null,
    directoryKey: opts.directoryKey || "lastExportDirectory",
  });
}

/**
 * Show the native Save dialog, then write `bytes` to the chosen file.
 * Resolves to the absolute path that was written, or null if the user cancelled.
 */
export function nativeSaveAs(bytes, defaultName, opts) {
  return pickSavePath(defaultName, opts).then(function(path) {
    if (!path) return null;
    return nativeWriteFile(path, bytes).then(function() {
      return path
    });
  });
}

/** Overwrite an existing file at `path` with `bytes`, without prompting. */
export function nativeWriteFile(path, bytes) {
  return window.__TAURI__.core.invoke("save_file", toUint8Array(bytes), {
    headers: {
      // Header values carry visible ASCII only, and a header holding a
      // non-Latin-1 character cannot be constructed at all. Percent-encoding
      // keeps accented and non-Latin paths working; Rust decodes it back.
      "X-PhotoSuite-Path": encodeURIComponent(path),
    },
  });
}
/**
 * The third-party notices packaged with the application, as Markdown text.
 * Rejects when the file is not where the host expects it.
 */
export function readThirdPartyNotices() {
  return window.__TAURI__.core.invoke("read_third_party_notices");
}

/**
 * Open an external URL in the OS default browser via the Tauri shell plugin.
 * Fire-and-forget; no-op when the Tauri bridge is unavailable.
 */
export function openExternalUrl(url) {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (tauri && tauri.core && typeof tauri.core.invoke === "function") {
    tauri.core.invoke("plugin:shell|open", { path: String(url) }).catch(() => {});
  }
}

/**
 * List the host's printers with the paper sizes and job options each one
 * offers. Resolves to `{ printers, warning }`; `warning` explains a short or
 * empty list (a stopped print service, or no printer set up) so the dialog can
 * say why rather than showing an empty menu.
 */
export function listPrinters() {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (!(tauri && tauri.core && typeof tauri.core.invoke === "function")) {
    return Promise.resolve({ printers: [], warning: "the print service is unavailable" });
  }
  return tauri.core.invoke("list_printers");
}

/**
 * Send a composed page PDF to a printer. Resolves to the job id.
 *
 * The PDF travels as the raw invoke body and the job settings as a header, the
 * way {@link nativeWriteFile} sends file bytes: a page carrying a large image
 * would otherwise be re-encoded into a JSON array on the way across.
 */
export function submitPrintJob(pdfBytes, options) {
  return window.__TAURI__.core.invoke("submit_print_job", toUint8Array(pdfBytes), {
    headers: {
      // Header values carry visible ASCII only, and the job name may be a
      // document title in any script, so the settings travel percent-encoded.
      "X-PhotoSuite-Print": encodeURIComponent(JSON.stringify(options)),
    },
  });
}

/**
 * Show the native Open dialog and read the first chosen file.
 * Resolves to `{ name, path, bytes }`, or null when the user cancelled.
 *
 * `imagesOnly` seeds the dialog with the supported image/document extensions.
 * Bytes come back through `read_file_raw`, which answers with binary rather
 * than a base64 JSON string.
 */
export function pickAndReadFile(imagesOnly) {
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (!(tauri && tauri.core && typeof tauri.core.invoke === "function")) return Promise.resolve(null);
  return tauri.core.invoke("open_files", { imagesOnly: imagesOnly === true }).then(function(files) {
    if (!files || files.length === 0) return null;
    const chosen = files[0];
    return tauri.core.invoke("read_file_raw", { path: chosen.path }).then(function(buf) {
      return {
        name: chosen.name,
        path: chosen.path,
        bytes: new Uint8Array(buf)
      };
    });
  });
}
