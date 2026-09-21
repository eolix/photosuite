/**
 * Startup wiring: the one module that imports every layer, so that no other
 * module has to.
 *
 * It does three things, in order:
 *
 * 1. registers the trackers that handle document events
 *    (`features/trackers/register-trackers.js`),
 * 2. installs the name bindings that user scripts resolve against
 *    (`features/scripting/script-host-context.js`),
 * 3. bridges the filter and layer-style implementations into the gallery
 *    filter definitions.
 *
 * Nothing here is published on `globalThis`. Application modules import the
 * symbols they use from the module that defines them.
 */

import * as EventDispatcher from "./event-emitter.js";
import * as KeyboardManager from "./keyboard-handler.js";
import * as BinaryUtils from "./binary/binary-utils.js";
import * as BinarySchemaDecoder from "./binary/binary-schema-decoder.js";
import * as LocaleMod from "./i18n/locale.js";
import * as MathPoint from "./math/point.js";
import * as MathMatrix2D from "./math/matrix2d.js";
import * as MathRect from "./math/rect.js";
import * as EngineCore from "../engine/layer-system.js";
import * as BlendModesMod from "../document/model/blend-modes.js";
import * as FontsMod from "../fonts/font-registry.js";
import * as GalleryFilter from "../features/filters/gallery/gallery-filter-defs.js";
import * as LayerAdjEngine from "../features/adjustments/adjustment-engine.js";
import "../features/filters/filter-registry.js";
import * as LayerFilterDefs from "../features/filters/filter-apply.js";
import { installLayerSymbols } from "../features/filters/gallery/gallery-filter-defs.js";
import * as TextEngineMod from "../features/text/text-engine.js";
import * as TextLayoutMod from "../features/text/text-layout.js";
import * as TextRendererMod from "../features/text/text-renderer.js";
import * as BrushStrokeMod from "../features/brush/brush-stroke.js";
import * as LayerEffectDefsMod from "../document/formats/psd/effect-defs.js";
import * as TrackerRegistryMod from "../features/trackers/tracker-registry.js";
import "../document/tools/paint-tools.js";
import "../document/tools/pen-path-tools.js";
import "../document/tools/selection-tools.js";
import "../document/tools/lasso-tools.js";
import "../document/tools/crop-tools.js";
import "../document/tools/retouch-tools.js";
import "../document/tools/shape-tools.js";
import "../document/tools/view-tools.js";
import "../document/tools/move-tools.js";
import "../document/tools/text-tools.js";
import "../document/transform/transform-tools.js";
import { registerTrackers } from "../features/trackers/register-trackers.js";
import * as LayerPopupActionDesc from "../features/scripting/action-desc.js";
import { Layer, LayerSectionType } from "../document/model/layer.js";
import { CanvasViewport } from "../document/model/canvas-viewport.js";
import { AxisDragAnchor } from "../document/model/axis-drag-anchor.js";
import { LayerGroup } from "../document/model/layer-group.js";
import { Document, HistoryEntry } from "../document/model/document.js";
import "../document/model/placed-layer.js";
import * as LayerLayerStyleRenderUtil from "../features/layer-styles/style-renderer.js";
import * as LayerScriptEngine from "../features/scripting/script-engine.js";
import {
  installScriptHostBindings,
  installScriptHostModule,
} from "../features/scripting/script-host-context.js";
import * as LayerTextEncoded from "../features/text/engine-data.js";
import * as XmpMetadata from "../document/formats/metadata/xmp-metadata.js";
import { showToast } from "./user-prompts.js";
import { preloadRotateCursorIcon } from "../ui/shell/cursor-overlay.js";
import { installWebviewConfirm } from "./user-prompts.js";
import * as UserPrompts from "./user-prompts.js";

/** Core namespaces bound for script evaluation. */
const CORE_SCRIPT_HOST_MODULES = [
  // A script may tell the user something; it may not reach the DOM helpers or
  // the host bridge.
  UserPrompts,
  EventDispatcher,
  KeyboardManager,
  BinaryUtils,
  BinarySchemaDecoder,
  LocaleMod,
  MathPoint,
  MathMatrix2D,
  MathRect,
  EngineCore,
  BlendModesMod,
  FontsMod,
];

/** Layer and filter namespaces bound after the core symbols. */
const LAYER_SCRIPT_HOST_MODULES = [
  GalleryFilter,
  TrackerRegistryMod,
  LayerPopupActionDesc,
  LayerAdjEngine,
  LayerFilterDefs,
  LayerLayerStyleRenderUtil,
  TextEngineMod,
  TextLayoutMod,
  TextRendererMod,
  BrushStrokeMod,
  LayerTextEncoded,
  LayerScriptEngine,
  XmpMetadata,
  LayerEffectDefsMod,
];

const MODEL_TYPE_EXPORTS = {
  Layer,
  LayerSectionType,
  LayerGroup,
  Document,
  HistoryEntry,
  CanvasViewport,
  AxisDragAnchor,
};

/**
 * WKWebView and some embeds replace `confirm` with an async or blocked implementation.
 * App code treats `confirm()` as synchronous — patch to fail closed and avoid stalls.
 */
function installBlockedDialogFallback() {
  if (typeof window === "undefined" || typeof window.confirm !== "function") return;

  function invokeConfirmSafely(nativeConfirm, message) {
    try {
      return nativeConfirm.call(window, message);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  const originalConfirm = window.confirm;
  installWebviewConfirm(originalConfirm);

  window.confirm = function patchedConfirm(message) {
    const raw = invokeConfirmSafely(originalConfirm, message);
    if (raw != null && typeof raw.then === "function") {
      raw.then(
        () => {},
        () => {}
      );
      console.warn("[PhotoSuite] confirm() unavailable or async — treating as Cancel:", message);
      return false;
    }
    return !!raw;
  };

  const originalAlert = window.alert;
  if (typeof originalAlert === "function") {
    window.alert = function patchedAlert(message) {
      try {
        const raw = originalAlert.call(window, message);
        if (raw != null && typeof raw.then === "function") {
          raw.catch(() => {
            console.warn("[PhotoSuite] alert() unavailable:", message);
          });
        }
      } catch {
        console.warn("[PhotoSuite] alert() failed:", message);
      }
    };
  }

  function patchGlobalDialogConfirm() {
    const dialogNs =
      typeof globalThis.dialog === "object" && globalThis.dialog != null
        ? globalThis.dialog
        : null;
    if (dialogNs == null || typeof dialogNs.confirm !== "function") return;
    if (dialogNs.__photosuiteConfirmPatched) return;

    const dlgConfirm = dialogNs.confirm.bind(dialogNs);
    dialogNs.confirm = function patchedDialogConfirm(opts) {
      let raw;
      try {
        raw = dlgConfirm(opts);
      } catch (err) {
        raw = Promise.reject(err);
      }
      if (raw != null && typeof raw.then === "function") {
        raw.then(
          () => {},
          () => {}
        );
        console.warn(
          "[PhotoSuite] dialog.confirm unavailable — resolving as confirmed.",
          opts
        );
        return Promise.resolve(true);
      }
      return raw;
    };
    dialogNs.__photosuiteConfirmPatched = true;
  }

  patchGlobalDialogConfirm();
  if (typeof queueMicrotask === "function") {
    queueMicrotask(patchGlobalDialogConfirm);
  }
  if (typeof window !== "undefined") {
    window.setTimeout(patchGlobalDialogConfirm, 0);
    window.addEventListener("load", patchGlobalDialogConfirm, { once: true });
  }

  globalThis.confirm = window.confirm;
}

/**
 * Host services scripts expect by name. `alert` is the flying-banner toast, so
 * a script reporting progress does not block the interpreter waiting on a
 * dialog.
 */
const HOST_SCRIPT_BINDINGS = {
  alert: function alertFromScript(message, durationMs) {
    showToast(String(message), durationMs);
  },
};

function installScriptHostContext() {
  for (const moduleNamespace of CORE_SCRIPT_HOST_MODULES) {
    installScriptHostModule(moduleNamespace);
  }
  for (const moduleNamespace of LAYER_SCRIPT_HOST_MODULES) {
    installScriptHostModule(moduleNamespace);
  }
  installScriptHostBindings(MODEL_TYPE_EXPORTS);
  installScriptHostBindings(HOST_SCRIPT_BINDINGS);
}

function installLayerSymbolBridges() {
  installLayerSymbols({
    FilterDefs: LayerFilterDefs.FilterDefs,
    LayerStyleRenderer: LayerLayerStyleRenderUtil.LayerStyleRenderer,
  });
}

function warmupRotateCursorAsset() {
  if (preloadRotateCursorIcon) {
    preloadRotateCursorIcon().catch(() => {});
  }
}

installBlockedDialogFallback();
registerTrackers(TrackerRegistryMod.TrackerRegistry);
installScriptHostContext();
installLayerSymbolBridges();
warmupRotateCursorAsset();
