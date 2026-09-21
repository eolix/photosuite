/**
 * Attaches the tracker classes onto `TrackerRegistry`.
 *
 * A tracker handles one routing channel of document events — layer edits, the
 * layer-style dialog, layer comps, adjustment previews, smart-filter applies —
 * and `AppController` instantiates them by reading them off the registry. The
 * tracker modules define their classes and export them; this is the one place
 * that decides which of them the application runs, and `core/startup-wiring.js`
 * calls it at boot.
 *
 * Importing `layer-effects-actions.js` and its siblings fills
 * `LayerEffectsTracker.actionHandlers` / `undoHandlers` / `redoHandlers` —
 * tables keyed by the action id a `Layer` dispatches. Those imports live here
 * so the whole registration step reads as one thing.
 */

import "./layer-effects-actions.js";
import { LayerEffectsTracker } from "./layer-effects-tracker.js";
import { LayerStyleDialogTracker } from "./layer-style-dialog-tracker.js";
import { LayerCompTracker } from "./layer-comp-tracker.js";
import { AdjustmentPreviewTracker } from "./adjustment-preview-tracker.js";
import { SmartFilterApplyTracker } from "./smart-filter-apply-tracker.js";

/**
 * Register every tracker the application runs.
 * @param {object} registry the `TrackerRegistry` singleton
 */
export function registerTrackers(registry) {
  registry.LayerEffectsTracker = LayerEffectsTracker;
  registry.LayerStyleDialogTracker = LayerStyleDialogTracker;
  registry.LayerCompTracker = LayerCompTracker;
  registry.AdjustmentPreviewTracker = AdjustmentPreviewTracker;
  registry.SmartFilterApplyTracker = SmartFilterApplyTracker;
}
