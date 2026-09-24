/**
 * Async open/save bridge: URL load queue, native file picker, clipboard helpers,
 * drag-and-drop imports, and byte→document dispatch via `FileProcessor`.
 */

import { BinaryUtils } from "../../core/binary/binary-utils.js";
import { Locale } from "../../core/i18n/locale.js";
import { basenameFromPath, fileExtension, stripFileExtension } from "../../core/file-names.js";

import { FileFormatRegistry } from "../../document/formats/registry/file-format-registry.js";
import { Document } from "../../document/model/document.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { PopupTypes } from "../config/popup-types.js";
import { StyleParser } from "../../features/layer-styles/style-file.js";
import { ToolPresetParser } from "../../features/tool-preset/tool-preset-file.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { nativeSaveAs } from "../../core/tauri-host.js";
import { showToast } from "../../core/user-prompts.js";
import { AppEvent } from "../../core/event-bus.js";
import { normalize } from "../../engine/compositing/raw-functions.js";
import {
  ensureFormatLoaders,
  hasFormatLoaders,
} from "../../document/formats/registry/format-loader-imports.js";
import { DETECT_ONLY_FORMAT_NAMES } from "../../document/formats/registry/registry-helpers.js";
import {
  readSystemClipboardForPaste,
  writeClipboardBlob
} from "../../core/system-clipboard.js";

/** Formats that can be placed into an existing document as a layer. */
const PLACE_INTO_DOC_FORMATS = "jpg png gif webp avif heic pdf svg psd".split(" ");

/**
 * Why a format decoded off the main open path can fail. AVIF is handed to the
 * host WebView, which may not support it; HEIC is decoded by libheif, whose
 * WebAssembly binary is fetched on first use.
 */
const ASYNC_DECODE_ERROR_TOASTS = {
  avif: "Could not decode this AVIF file. Your system WebView may not support AVIF.",
  heic: "Could not decode this HEIC file. It may use a codec libheif cannot read.",
};

function asyncDecodeErrorToast(formatId) {
  return ASYNC_DECODE_ERROR_TOASTS[formatId] || "Could not decode this " + formatId.toUpperCase() + " file.";
}

/** Zip entry extensions treated as text/metadata and skipped when unpacking. */
const ZIP_SKIP_TEXT_EXTENSIONS = "xml rels plist iwa db ds_store txt rtf".split(" ");

/**
 * Async open/save bridge: URL load queue, the Tauri native open picker,
 * clipboard helpers, and byte→document dispatch via FileProcessor.
 * @param {Function} processLoadedBytesFn
 */
function FileLoader(processLoadedBytesFn) {
  BaseWidget.call(this);
  FileLoader.processLoadedBytes = processLoadedBytesFn;
  this.doc = null;
  this.pendingLoadSpecs = [];
  this.urlLoadInProgress = false;
  this._openBusyCount = 0;
  this.filePickerTargetDocIndex = null;
}

FileLoader.prototype = Object.create(BaseWidget.prototype);
FileLoader.processLoadedBytes = null;

FileLoader.writeBlobToClipboard = function(blob) {
  writeClipboardBlob(blob);
};

FileLoader.readClipboardWithCallback = function(controller, imageCallback) {
  readSystemClipboardForPaste(controller, imageCallback, FileLoader);
};

FileLoader.queryClipboardReadPermission = function(callback) {
  navigator.permissions.query({
    name: "clipboard-read"
  }).then(function(permissionState) {
    callback(permissionState.state)
  }).catch(function() {
    // Tauri WebView does not support clipboard-read permission query; treat as denied.
    callback("denied");
  })
};

/**
 * Opening a file shows the full-window blocking veil for the whole operation —
 * disk read and parse alike — for every format. Thin ref-counted wrappers so
 * nested / parallel opens balance to a single veil.
 */
FileLoader.prototype.showOpenVeil = function() {
  this._setOpenBusy(true)
};

FileLoader.prototype.hideOpenVeil = function() {
  this._setOpenBusy(false)
};

FileLoader.prototype.openFilePicker = function(targetDocIndex, pickerOptions) {
  this.filePickerTargetDocIndex = targetDocIndex;
  const imagesOnly = pickerOptions && pickerOptions.imagesOnly === true,
    self = this,
    tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (!(tauri && tauri.core && typeof tauri.core.invoke === "function")) return;
  tauri.core.invoke("open_files", { imagesOnly: imagesOnly }).then(function(files) {
    if (!files || files.length === 0) return;
    // Block input + show feedback for the async read window. Bytes come back as
    // ArrayBuffers via read_file_raw (tauri::ipc::Response) — no base64/JSON IPC,
    // which is what made an 87MB file take ~6.7s. Reads run in parallel.
    self._setOpenBusy(true);
    return Promise.all(files.map(function(fileEntry) {
      return tauri.core.invoke("read_file_raw", { path: fileEntry.path })
        .then(function(buf) {
          const fileObj = new File([new Uint8Array(buf)], fileEntry.name);
          // Remember the on-disk origin so Save can overwrite it in place.
          fileObj.nativeFilePath = fileEntry.path;
          return fileObj
        });
    })).then(function(fileObjs) {
      // loadLocalFiles raises its own veil ref per file before we release the
      // read-phase ref, so the veil never blinks off between read and parse.
      self.loadLocalFiles(fileObjs, null, self.filePickerTargetDocIndex, null, null);
      self._setOpenBusy(false);
      self.filePickerTargetDocIndex = null
    });
  }).catch(function(err) {
    console.error("[PS] open_files failed:", err);
    self._setOpenBusy(false);
    showToast("Could not open the file picker.");
  });
};

/**
 * Open one file from a known absolute path (recent-files menu / home screen).
 * @param {string} filePath
 * @param {string} [fileName]
 * @param {number|null} [targetDocIndex]
 */
FileLoader.prototype.openFileByPath = function(filePath, fileName, targetDocIndex) {
  if (filePath == null || filePath === "") return;
  this.openFilesByPaths([filePath], targetDocIndex, fileName ? [fileName] : null);
};

/**
 * Open one or more files from absolute native paths (recent list, drag-drop, …).
 * Reads bytes through `read_file_raw` so large files avoid JSON/base64 IPC.
 *
 * @param {string[]} filePaths
 * @param {number|null} [targetDocIndex]
 * @param {string[]|null} [fileNames] Optional display names parallel to `filePaths`.
 */
FileLoader.prototype.openFilesByPaths = function(filePaths, targetDocIndex, fileNames) {
  if (filePaths == null || filePaths.length === 0) return;
  const self = this;
  const tauri = typeof window !== "undefined" ? window.__TAURI__ : null;
  if (!(tauri && tauri.core && typeof tauri.core.invoke === "function")) return;
  this.filePickerTargetDocIndex = targetDocIndex == null ? null : targetDocIndex;
  self._setOpenBusy(true);
  Promise.all(filePaths.map(function(filePath, pathIdx) {
    return tauri.core.invoke("read_file_raw", { path: filePath }).then(function(buf) {
      const overrideName = fileNames && fileNames[pathIdx];
      const resolvedName = overrideName && overrideName !== ""
        ? overrideName
        : basenameFromNativePath(filePath);
      const fileObj = new File([new Uint8Array(buf)], resolvedName);
      fileObj.nativeFilePath = filePath;
      return fileObj;
    });
  })).then(function(fileObjs) {
    self.loadLocalFiles(fileObjs, null, self.filePickerTargetDocIndex, null, null);
    self._setOpenBusy(false);
    self.filePickerTargetDocIndex = null;
  }).catch(function(err) {
    console.error("[PS] openFilesByPaths failed:", err);
    self._setOpenBusy(false);
    self.filePickerTargetDocIndex = null;
    showToast("Could not open the file.");
    if (filePaths.length === 1) {
      const failedEvent = new AppEvent(EventType.uiDispatch, true);
      failedEvent.data = {
        dispatchKind: UiCommand.openRecentFileFailed,
        filePath: filePaths[0]
      };
      self.dispatch(failedEvent);
    }
  });
};

function basenameFromNativePath(filePath) {
  const normalized = String(filePath).replace(/\\/g, "/");
  const slashIdx = normalized.lastIndexOf("/");
  return slashIdx === -1 ? normalized : normalized.slice(slashIdx + 1);
}

/**
 * Full-window veil during async file read: blocks clicks (so a second document
 * cannot be opened mid-load) and shows immediate Loading feedback.
 */
FileLoader.prototype._setOpenBusy = function(on) {
  if (on) {
    this._openBusyCount++;
    if (this._openVeil) return;
    const openVeilEl = this._openVeil = document.createElement("div");
    openVeilEl.setAttribute("class", "busyveil");
    const openVeilCardEl = document.createElement("div");
    openVeilCardEl.setAttribute("class", "alertpanel");
    openVeilCardEl.textContent = Locale.get("history.loading") + "…";
    openVeilEl.appendChild(openVeilCardEl);
    document.body.appendChild(openVeilEl);
  } else {
    if (this._openBusyCount > 0) this._openBusyCount--;
    if (this._openBusyCount > 0) return;
    if (this._openVeil) {
      this._openVeil.remove();
      this._openVeil = null;
    }
  }
};

FileLoader.prototype.enqueueUrlLoad = function(loadSpec) {
  this.pendingLoadSpecs.push(loadSpec);
  this.processNextUrlLoad()
};

FileLoader.prototype.processNextUrlLoad = function() {
  const pendingSpecs = this.pendingLoadSpecs;
  if (pendingSpecs.length == 0 || this.urlLoadInProgress) return;
  this.urlLoadInProgress = true;
  const loadSpec = pendingSpecs.shift();
  this.showOpenVeil();
  if (loadSpec.scriptHostData == null) loadSpec.scriptHostData = {};
  const xhr = new XMLHttpRequest();
  attachAsyncLoadContext(xhr, loadSpec, null);
  const requestUrl = loadSpec.url;
  xhr.open("GET", requestUrl);
  applyRequestHeaders(xhr, loadSpec.requestHeaders);
  xhr.responseType = "arraybuffer";
  xhr.onload = this.onBytesLoaded.bind(this);
  xhr.onerror = function() {
    this.hideOpenVeil();
    this.urlLoadInProgress = false;
    this.processNextUrlLoad();
  }.bind(this);
  xhr.send()
};

FileLoader.prototype.loadLocalFiles = function(fileList, channelRasterCallback, targetDocIndex, mutationWire, fileHandles) {
  for (let fileIdx = 0; fileIdx < fileList.length; fileIdx++) {
    this.showOpenVeil();
    const fileBlob = fileList[fileIdx],
      reader = new FileReader();
    fileBlob.placeIntoDocIndex = targetDocIndex;
    fileBlob.insertLayerIndex = mutationWire;
    fileBlob.nativeFilePath = fileBlob.nativeFilePath || null;
    if (fileHandles) fileBlob.localFileHandle = fileHandles[fileIdx];
    attachAsyncLoadContext(reader, fileBlob, channelRasterCallback);
    reader.onload = this.onBytesLoaded.bind(this);
    reader.onerror = function() {
      this.hideOpenVeil()
    }.bind(this);
    reader.readAsArrayBuffer(fileBlob)
  }
};

FileLoader.prototype.onBytesLoaded = function(loadEvent) {
  let bytes;
  const loadTarget = loadEvent.target,
    loadSpec = loadTarget.loadContext;
  if (loadTarget instanceof XMLHttpRequest) bytes = loadTarget.response;
  else bytes = loadTarget.result;
  let decodePending = false;
  try {
    decodePending = FileLoader.processLoadedBytes(loadSpec, bytes, this, loadTarget.channelRasterCallback);
  } finally {
    if (!decodePending) this.hideOpenVeil();
  }
  if (loadTarget instanceof XMLHttpRequest) {
    this.urlLoadInProgress = false;
    this.processNextUrlLoad()
  }
};

FileLoader.save = function(bytes, filename, opts) {
  nativeSaveAs(bytes, filename, opts).catch(function(err) {
    console.error("[file-save] native save failed:", err)
  });
};

const FileProcessor = {};

/**
 * Parse "format:option" encode specs into registry encode options.
 * @param {string} formatSpec
 * @returns {{ formatId: string, encodeOptions: * }}
 */
function parseEncodeFormatSpec(formatSpec) {
  const formatParts = formatSpec.split(":"),
    formatId = formatParts[0];
  let encodeOptions = null;
  if (formatParts.length == 2) {
    if (formatId == "jpg" || formatId == "webp") {
      encodeOptions = [Math.round(100 * parseFloat(formatParts[1]))];
    }
    if (formatId == "psd") encodeOptions = [true, true]
  }
  return { formatId: formatId, encodeOptions: encodeOptions }
}

FileProcessor.encodeDocumentWithFormat = function(doc, formatSpec, appData) {
  const parsed = parseEncodeFormatSpec(formatSpec);
  return FileFormatRegistry.encodeDocument(
    doc,
    parsed.formatId.toUpperCase(),
    null,
    null,
    parsed.encodeOptions,
    appData
  )
};

FileProcessor.encodeFromActiveChannel = function(doc, channelSpec, appData) {
  doc.getRasterData();
  const formatSpec = channelSpec[0];
  return FileProcessor.encodeDocumentWithFormat(doc, formatSpec, appData)
};

FileProcessor.processLoadedBytes = function(loadSpec, bytes, fileLoader, channelRasterCallback) {
  try {
    return FileProcessor.dispatchOpenBytes(loadSpec, bytes, fileLoader, channelRasterCallback);
  } catch (err) {
    if (err == "user_abort") return false;
    if (err == "low_ram") {
      showToast("Not enough memory to open this file at the required resolution.", 1e4);
    } else {
      console.error("[file-load] processing error:", err, err && err.stack);
      let errorMessage = "An error occurred while processing this file.";
      if (FileFormatRegistry.detectFormat(bytes) == "eps") {
        errorMessage =
          "We support only basic EPS files. Convert your file into PDF (with an online converter) and open the PDF in PhotoSuite.";
      }
      showToast(errorMessage, 1e4)
    }
    return false;
  }
};

/**
 * Drop the open veil. Not every open goes through a `FileLoader` — a paste and
 * a startup resource pass the controller instead, and neither shows a veil.
 */
function hideOpenVeilIfPresent(fileLoader) {
  if (fileLoader && typeof fileLoader.hideOpenVeil === "function") fileLoader.hideOpenVeil();
}

FileProcessor.dispatchOpenBytes = function(loadSpec, bytes, fileLoader, channelRasterCallback) {
  const names = resolveLoadDisplayNames(loadSpec),
    byteView = new Uint8Array(bytes),
    formatId = detectOpenFormatId(byteView, bytes, names.displayName);

  // The parser for this format may not be in the bundle yet. Fetch it, then
  // start the open again — reporting "decode pending" so the caller waits for
  // the document rather than assuming nothing happened.
  //
  // Reporting pending also hands us the open veil: whoever reports it owns
  // hiding it, exactly as the async image codecs do below. The retry is only
  // finished when it comes back not-pending; if it reports pending in turn,
  // that path hides the veil itself.
  if (!hasFormatLoaders(formatId)) {
    ensureFormatLoaders(formatId).then(function() {
      const retryPending = FileProcessor.processLoadedBytes(
        loadSpec, bytes, fileLoader, channelRasterCallback,
      );
      if (!retryPending) hideOpenVeilIfPresent(fileLoader);

    }, function(err) {
      console.error("[file-load] could not load the " + formatId + " parser:", err);
      showToast(
        "Could not open this file: " + String(formatId).toUpperCase() + " support failed to load.",
        1e4,
      );
      hideOpenVeilIfPresent(fileLoader);
    });
    return true;
  }

  if (tryOpenRawExtension(loadSpec, bytes, fileLoader, names.displayName)) return false;
  if (tryOpenJsonFromFormat(byteView, formatId)) return false;
  if (tryOpenHtmlFromFormat(loadSpec, byteView, fileLoader, formatId)) return false;
  if (tryOpenRegisteredFormat(loadSpec, bytes, fileLoader, channelRasterCallback, names, formatId)) {
    return tryOpenRegisteredFormat.lastDecodePending === true;
  }
  openZipOrPresetResource(loadSpec, bytes, fileLoader, channelRasterCallback, names, formatId);
  return false;
};

/**
 * Names for an incoming file: `fileName` is what the document is called (the
 * on-disk name, extension included), `baseName` the same without the extension,
 * `displayName` the full path or URL used for extension sniffing.
 * @param {Object} loadSpec
 * @returns {{ fileName: string, baseName: string, displayName: string }}
 */
function resolveLoadDisplayNames(loadSpec) {
  let fileName;
  if (loadSpec.name) fileName = basenameFromPath(loadSpec.name);
  else if (loadSpec.url.substring(0, 5) == "data:") fileName = "image";
  else fileName = basenameFromPath(loadSpec.url.split(/[?#]/)[0]).slice(0, 50);
  return {
    fileName: fileName,
    baseName: stripFileExtension(fileName),
    displayName: loadSpec.name ? loadSpec.name : loadSpec.url
  }
}

function detectOpenFormatId(byteView, bytes, displayName) {
  let formatId = FileFormatRegistry.detectFormat(bytes);
  if (formatId == null) formatId = BinaryUtils.readString(byteView, 0, 4);
  // Modern Figma saves are PK zips with canvas.fig; registry-detect handles that,
  // but force FIG when the user picked a .fig path so we never fan out zip entries.
  if (displayName && displayName.toLowerCase().endsWith(".fig")) formatId = "fig";
  if (displayName && displayName.toLowerCase().endsWith(".avif")) formatId = "avif";
  // `.heif` is also used for AVIF-in-HEIF, so leave a detected AVIF alone.
  if (formatId !== "avif" && displayName && /\.(heic|heif)$/.test(displayName.toLowerCase())) {
    formatId = "heic";
  }
  return formatId
}

function tryOpenRawExtension(loadSpec, bytes, fileLoader, displayName) {
  if (!(displayName && displayName.toLowerCase().endsWith(".raw"))) return false;
  dispatchUi(fileLoader, {
    dispatchKind: UiCommand.dispatchAppDialogRouter,
    dialogRouteId: "importraw",
    fileByteBuffer: bytes,
    rawFileName: basenameFromPath(displayName),
    nativeFilePath: loadSpec.nativeFilePath || null,
    localFileHandle: loadSpec.localFileHandle || null,
    sourceUrl: loadSpec.url || null,
  });
  return true
}

function tryOpenJsonFromFormat(byteView, formatId) {
  if (formatId != "json") return false;
  let jsonText = "";
  for (let byteIdx = 0; byteIdx < byteView.length; byteIdx++) {
    jsonText += String.fromCharCode(byteView[byteIdx]);
  }
  jsonText = decodeURIComponent(escape(jsonText));
  showToast("Unknown JSON file opened. See the content in the console.", 5e3);
  console.log(JSON.parse(jsonText));
  return true
}

function tryOpenHtmlFromFormat(loadSpec, byteView, fileLoader, formatId) {
  if (formatId != "html") return false;
  const htmlText = BinaryUtils.readUtf8(byteView, 0, byteView.length),
    domParser = new DOMParser(),
    htmlDoc = domParser.parseFromString(htmlText, "text/html"),
    metaTags = htmlDoc.getElementsByTagName("meta");
  for (let metaIdx = 0; metaIdx < metaTags.length; metaIdx++) {
    const metaTag = metaTags[metaIdx],
      ogProperty = metaTag.getAttribute("property"),
      ogContent = metaTag.getAttribute("content");
    let imageUrl = null;
    if (ogProperty == "og:image") imageUrl = ogContent;
    if (imageUrl == null) continue;
    dispatchUi(fileLoader, {
      dispatchKind: UiCommand.importFromUrl,
      importSpec: {
        url: imageUrl,
        placeIntoDocIndex: loadSpec.placeIntoDocIndex
      }
    })
  }
  return true
}

function tryOpenRegisteredFormat(loadSpec, bytes, fileLoader, channelRasterCallback, names, formatId) {
  tryOpenRegisteredFormat.lastDecodePending = false;
  if (!FileFormatRegistry.getFormat(formatId)) return false;

  const formatHandler = FileFormatRegistry.getFormat(formatId);
  if (typeof formatHandler.decodeAsync === "function") {
    tryOpenRegisteredFormat.lastDecodePending = true;
    formatHandler.decodeAsync(bytes).then(function(decodedImages) {
      try {
        completeRegisteredFormatOpen(
          loadSpec,
          bytes,
          fileLoader,
          channelRasterCallback,
          names,
          formatId,
          formatHandler,
          decodedImages,
        );
      } catch (err) {
        console.error("[file-load] post-decode open error:", err, err && err.stack);
        showToast("An error occurred while opening this " + formatId.toUpperCase() + " file.", 1e4);
      } finally {
        fileLoader.hideOpenVeil();
      }
    }).catch(function(err) {
      console.error("[file-load] async decode error:", err, err && err.stack);
      showToast(asyncDecodeErrorToast(formatId), 1e4);
      fileLoader.hideOpenVeil();
    });
    return true;
  }

  return completeRegisteredFormatOpen(
    loadSpec,
    bytes,
    fileLoader,
    channelRasterCallback,
    names,
    formatId,
    formatHandler,
    formatHandler.isLayered ? null : formatHandler.decode(bytes),
  );
}

function completeRegisteredFormatOpen(
  loadSpec,
  bytes,
  fileLoader,
  channelRasterCallback,
  names,
  formatId,
  formatHandler,
  decodedImages,
) {
  if (
    loadSpec.placeIntoDocIndex != null &&
    PLACE_INTO_DOC_FORMATS.indexOf(formatId) != -1
  ) {
    dispatchUi(fileLoader, {
      dispatchKind: UiCommand.applyDocumentMutationAndCloseExtra,
      target: loadSpec.placeIntoDocIndex,
      insertLayerIndex: loadSpec.insertLayerIndex,
      importFileBytes: bytes,
      embeddedFileName: names.baseName
    });
    return true;
  }

  // Names coming from a data: URL or an extensionless file get the extension of
  // the format detection reports, so every tab title names a real format.
  const documentName =
    fileExtension(names.fileName) === "" ? names.fileName + "." + formatId : names.fileName;

  let openedDoc;
  if (formatHandler.isLayered) {
    openedDoc = new Document(documentName);
    formatHandler.decode(bytes, openedDoc);
  } else {
    if (decodedImages == null || decodedImages.length == 0) return true;
    if (decodedImages[0].t33421 || decodedImages[0].t50706) {
      normalize(decodedImages[0], bytes);
      dispatchUi(fileLoader, {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "rawdevelop",
        rawImageDescriptor: decodedImages[0],
        documentName: documentName,
        // Path survives the develop modal so OK can register the recent entry.
        nativeFilePath: loadSpec.nativeFilePath || null,
        localFileHandle: loadSpec.localFileHandle || null,
        sourceUrl: loadSpec.url || null,
      });
      return true;
    }
    if (channelRasterCallback) {
      channelRasterCallback(new Uint8Array(decodedImages[0].data), decodedImages[0].rect);
      return true;
    }
    openedDoc = FileFormatRegistry.openFiles(documentName, decodedImages);
  }

  openedDoc.formatType = formatId;
  openedDoc.scriptHostData = loadSpec.scriptHostData;
  openedDoc.sourceUrl = loadSpec.url;
  openedDoc.parentDocRef = loadSpec.parentDocRef;
  openedDoc.localFileHandle = loadSpec.localFileHandle;
  openedDoc.nativeFilePath = loadSpec.nativeFilePath || null;
  if (openedDoc.layers.length != 0) {
    dispatchUi(fileLoader, {
      dispatchKind:
        loadSpec.placeIntoDocIndex == null
          ? UiCommand.focusDocumentTab
          : UiCommand.applyDocumentMutationAndCloseExtra,
      target: loadSpec.placeIntoDocIndex,
      insertLayerIndex: loadSpec.insertLayerIndex,
      openedDocument: openedDoc
    });
  }
  return true;
}

function openZipOrPresetResource(loadSpec, bytes, fileLoader, channelRasterCallback, names, formatId) {
  const displayName = names.displayName,
    fontSubsetConfirmEvent = buildUiEvent({
      dispatchKind: UiCommand.confirmPersistStartupResource,
      fileByteBuffer: bytes,
      storageEntryName: loadSpec.name
    }),
    isUnmarkedLocalFile = loadSpec instanceof File && loadSpec.suppressPresetAddedAlert != true,
    uiEvent = buildUiEvent({
      dispatchKind: UiCommand.openResourcePresetPopup,
      scriptHostData: "add",
      popupType: null,
      presetPayload: null,
      suppressPresetAddedAlert: loadSpec.suppressPresetAddedAlert
    });

  if (formatId == "zip") {
    unpackZipEntries(bytes, fileLoader, channelRasterCallback);
    return
  }
  if (formatId == "jsx" || (displayName && displayName.toLowerCase().endsWith(".jsx"))) {
    const scriptSource = BinaryUtils.readUtf8(new Uint8Array(bytes));
    dispatchUi(fileLoader, {
      dispatchKind: UiCommand.runExtensionScriptSnippet,
      scriptSource: scriptSource
    });
    return
  }
  if (formatId == "otf") {
    if (isUnmarkedLocalFile) fileLoader.dispatch(fontSubsetConfirmEvent);
    const parsedFonts = Typr.parse(bytes);
    uiEvent.data.popupType = PopupTypes.OPEN_RECENT;
    for (let fontIdx = 0; fontIdx < parsedFonts.length; fontIdx++) {
      uiEvent.data.presetPayload = parsedFonts[fontIdx];
      fileLoader.dispatch(uiEvent)
    }
    return
  }
  if (formatId == "asl") {
    if (isUnmarkedLocalFile) fileLoader.dispatch(fontSubsetConfirmEvent);
    const parsedAsl = StyleParser.parse(bytes);
    uiEvent.data.popupType = PopupTypes.PATTERNS;
    uiEvent.data.presetPayload = parsedAsl.patterns;
    fileLoader.dispatch(uiEvent);
    uiEvent.data.popupType = PopupTypes.STYLES;
    uiEvent.data.presetPayload = parsedAsl.layerStyles;
    fileLoader.dispatch(uiEvent);
    return
  }
  if (formatId == "tpl") {
    dispatchTplPresets(uiEvent, bytes, fileLoader);
    return
  }

  let presetKind = "";
  presetKind = PopupTypes.findPresetKindByExtension(formatId);
  if (presetKind != "") {
    if (isUnmarkedLocalFile) fileLoader.dispatch(fontSubsetConfirmEvent);
    uiEvent.data.presetPayload = PopupTypes.getPresetResource(presetKind).parser.parse(bytes, displayName);
    uiEvent.data.popupType = presetKind;
    fileLoader.dispatch(uiEvent)
  } else if (DETECT_ONLY_FORMAT_NAMES[formatId]) {
    // Detected, but nothing decodes it. Say which format it is: "unknown" is
    // wrong here, and leaves the user guessing whether the file is corrupt.
    showToast("PhotoSuite cannot open " + DETECT_ONLY_FORMAT_NAMES[formatId] + " files.", 1e4)
  } else {
    showToast("Unknown file format: " + JSON.stringify(formatId))
  }
}

function unpackZipEntries(bytes, fileLoader, channelRasterCallback) {
  const zipEntries = UZIP.parse(bytes);
  for (let zipPath in zipEntries) {
    if (shouldSkipZipEntry(zipPath, zipEntries[zipPath])) continue;
    const entryBaseName = zipPath.split("/").pop();
    FileProcessor.processLoadedBytes(
      { name: entryBaseName },
      zipEntries[zipPath].buffer,
      fileLoader,
      channelRasterCallback
    )
  }
}

function shouldSkipZipEntry(zipPath, entryBytes) {
  for (let extIdx = 0; extIdx < ZIP_SKIP_TEXT_EXTENSIONS.length; extIdx++) {
    if (zipPath.toLowerCase().endsWith("." + ZIP_SKIP_TEXT_EXTENSIONS[extIdx])) return true;
  }
  if (zipPath.startsWith("__MACOSX/") || entryBytes.length == 0) return true;
  return false
}

function dispatchTplPresets(uiEvent, bytes, fileLoader) {
  const parsedTpl = ToolPresetParser.parse(bytes);
  uiEvent.data.popupType = PopupTypes.BRUSHES;
  uiEvent.data.presetPayload = {
    samples: parsedTpl.samples,
    patterns: parsedTpl.patterns,
    list: []
  };
  fileLoader.dispatch(uiEvent);
  if (parsedTpl.shapes.length != 0) {
    uiEvent.data.popupType = PopupTypes.SHAPES;
    uiEvent.data.presetPayload = parsedTpl.shapes;
    fileLoader.dispatch(uiEvent)
  }
  if (parsedTpl.layerStyles.length != 0) {
    uiEvent.data.popupType = PopupTypes.STYLES;
    uiEvent.data.presetPayload = parsedTpl.layerStyles;
    fileLoader.dispatch(uiEvent)
  }
  uiEvent.data.popupType = PopupTypes.TOOL_PRESETS;
  uiEvent.data.presetPayload = parsedTpl.list;
  fileLoader.dispatch(uiEvent)
}

/**
 * Attach load metadata to an XHR or FileReader so onBytesLoaded can recover it.
 * @param {XMLHttpRequest|FileReader} asyncTarget
 * @param {Object} loadContext
 * @param {Function|null} channelRasterCallback
 */
function attachAsyncLoadContext(asyncTarget, loadContext, channelRasterCallback) {
  asyncTarget.loadContext = loadContext;
  asyncTarget.channelRasterCallback = channelRasterCallback;
}

function applyRequestHeaders(xhr, requestHeaders) {
  if (!requestHeaders) return;
  for (let headerName in requestHeaders) {
    xhr.setRequestHeader(headerName, requestHeaders[headerName]);
  }
}

function buildUiEvent(data) {
  const uiEvent = new AppEvent(EventType.uiDispatch, true);
  uiEvent.data = data;
  return uiEvent
}

function dispatchUi(fileLoader, data) {
  fileLoader.dispatch(buildUiEvent(data))
}

export {
  FileLoader,
  FileProcessor,
  parseEncodeFormatSpec,
  resolveLoadDisplayNames,
  shouldSkipZipEntry
};

// ---------------------------------------------------------------------------
// Files opened from the operating system
// ---------------------------------------------------------------------------

/**
 * Event Rust emits with paths the OS asked PhotoSuite to open — a double-clicked
 * document, or "Open With". The extensions that route here are declared as
 * `bundle.fileAssociations` in `tauri.conf.json`; without that declaration the OS
 * never offers the app in the first place.
 */
export const OPEN_FILES_EVENT = "photosuite:open-files";

function getTauriRuntime() {
  return typeof window !== "undefined" ? window.__TAURI__ : null;
}

/**
 * Open each path in its own document tab.
 * @param {*} controller AppController
 * @param {string[]} filePaths
 */
export function openFilePathsFromOs(controller, filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return;
  const fileLoader = controller != null ? controller.fileLoader : null;
  if (fileLoader == null || typeof fileLoader.openFileByPath !== "function") return;
  for (let pathIdx = 0; pathIdx < filePaths.length; pathIdx++) {
    const filePath = filePaths[pathIdx];
    if (typeof filePath !== "string" || filePath === "") continue;
    fileLoader.openFileByPath(filePath, basenameFromPath(filePath), null);
  }
}

/**
 * Open whatever the OS queued before the webview was listening. A file arrives as
 * a process argument on Windows and Linux and as an application open event on
 * macOS, either of which can land before the editor exists; Rust holds them until
 * this call drains the queue.
 * @param {*} controller AppController
 * @returns {Promise<void>}
 */
export async function openPendingOsFiles(controller) {
  const tauri = getTauriRuntime();
  if (tauri == null || tauri.core == null || typeof tauri.core.invoke !== "function") return;
  try {
    openFilePathsFromOs(controller, await tauri.core.invoke("take_pending_open_files"));
  } catch (err) {
    console.warn("PhotoSuite: could not read pending open files", err);
  }
}

/**
 * Listen for files the OS sends while the app is already running, which macOS
 * does for every subsequent "Open With".
 * @param {*} controller AppController
 * @returns {Promise<Function|null>} unlisten handle, or null when unavailable
 */
export async function listenForOsFileOpens(controller) {
  const tauri = getTauriRuntime();
  if (tauri == null || tauri.event == null || typeof tauri.event.listen !== "function") return null;
  try {
    return await tauri.event.listen(OPEN_FILES_EVENT, function onOpenFiles(event) {
      openFilePathsFromOs(controller, event && event.payload);
    });
  } catch (err) {
    console.warn("PhotoSuite: could not listen for OS file opens", err);
    return null;
  }
}

export function dispatchDataTransferImports(
  dataTransferEvt,
  emitter,
  targetDocIndex,
  extraImportFlags
) {
  const uriListText = dataTransferEvt.dataTransfer.getData("text/uri-list");
  if (uriListText != null && uriListText.startsWith("http")) {
    const openUrlEvt = new AppEvent(EventType.uiDispatch, true);
    openUrlEvt.data = {
      dispatchKind: UiCommand.importFromUrl,
      importSpec: {
        url: uriListText,
        placeIntoDocIndex: targetDocIndex,
        insertLayerIndex: extraImportFlags,
      },
    };
    emitter.dispatch(openUrlEvt);
  }

  if (dataTransferEvt.dataTransfer.files.length === 0) return;

  if (window.showOpenFilePicker) {
    const handles = [];
    const itemTotal = dataTransferEvt.dataTransfer.items.length;
    const fileList = dataTransferEvt.dataTransfer.files;

    for (const item of dataTransferEvt.dataTransfer.items) {
      item.getAsFileSystemHandle().then((entry) => {
        handles.push(entry);
        if (handles.length === itemTotal) {
          const filesEvt = new AppEvent(EventType.uiDispatch, true);
          filesEvt.data = {
            dispatchKind: UiCommand.importDroppedFiles,
            data: fileList,
            placeIntoDocIndex: targetDocIndex,
            insertLayerIndex: extraImportFlags,
            fileHandles: handles,
          };
          emitter.dispatch(filesEvt);
        }
      });
    }
  } else {
    const fallbackEvt = new AppEvent(EventType.uiDispatch, true);
    fallbackEvt.data = {
      dispatchKind: UiCommand.importDroppedFiles,
      data: dataTransferEvt.dataTransfer.files,
      placeIntoDocIndex: targetDocIndex,
      insertLayerIndex: extraImportFlags,
    };
    emitter.dispatch(fallbackEvt);
  }
}

