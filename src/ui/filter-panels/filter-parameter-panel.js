/**
 * Base class for filter / adjustment / filter-gallery parameter dialogs, plus
 * constructor lookup for a filter id ({@link getFilterPanelConstructorOrFallback}).
 *
 * Subclasses attach as `FilterParameterPanel.<filterId>` (PSD / FilterDefs ids such
 * as `GEfc`, `curv`, `LqFy`). Not smart-object filter FX (`placedData.filterFX`).
 */

import { FilterDefs } from "../../features/filters/filter-apply.js";
import { Locale } from "../../core/i18n/locale.js";
import { BaseWidget } from "../widgets/base-widget.js";
import { Checkbox, Label } from "../widgets/form-controls.js";
import { ColorSampleWidget } from "../widgets/controls/color-controls.js";
import { EventType } from "../../core/event-bus.js";
import { addClass, appendBreak, appendHorizontalRule, makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";

/** When the 6th `setValue` arg is omitted, the 5th slot is treated as dialog extra. */
function resolveDialogExtra(dialogContext, rasterUnderLayer) {
  if (dialogContext === undefined) return rasterUnderLayer;
  return dialogContext;
}

function writeValuesToWidgets(widgets, values) {
  let valueIdx = 0;
  for (let i = 0; i < widgets.length; i++) {
    if (!(widgets[i] instanceof Label)) widgets[i].setValue(values[valueIdx++]);
  }
}

function readValuesFromWidgets(widgets) {
  const values = [];
  let valueIdx = 0;
  for (let i = 0; i < widgets.length; i++) {
    if (!(widgets[i] instanceof Label)) values[valueIdx++] = widgets[i].getValue();
  }
  return values;
}

/** Keep linked min/max range widgets ordered after either side changes. */
function syncLinkedRangePairs(paramWidgets, linkedRangePairIndices, widgetEvent) {
  for (let i = 0; i < linkedRangePairIndices.length; i += 2) {
    const minWidget = paramWidgets[linkedRangePairIndices[i]];
    const maxWidget = paramWidgets[linkedRangePairIndices[i + 1]];
    const minVal = minWidget.getValue();
    const maxVal = maxWidget.getValue();
    if (widgetEvent.target == minWidget) maxWidget.setValue(Math.max(minVal, maxVal));
    else minWidget.setValue(Math.min(minVal, maxVal));
  }
}

/**
 * Base class every filter/adjustment parameter dialog extends. A subclass fills
 * `this.paramWidgets` (and optionally `this.linkedRangePairIndices`) and provides
 * `setFields`/`getFields` to move data between the filter descriptor and the
 * widgets. The base class handles layout ({@link FilterParameterPanel#mountFormLayout}),
 * pushing descriptor values into widgets ({@link FilterParameterPanel#setValue}),
 * and collecting edited values back into a descriptor ({@link FilterParameterPanel#getValue}).
 * @param {string} filterClassId FilterDefs / PSD id this panel edits, e.g. `GsnB`.
 */
export function FilterParameterPanel(filterClassId) {
  BaseWidget.call(this);
  this.filterClassId = filterClassId;
  this.el = makeElement("div", "");
  this.paramWidgets = [];
  this.linkedRangePairIndices = [];
}

FilterParameterPanel.prototype = Object.create(BaseWidget.prototype);
FilterParameterPanel.prototype.constructor = FilterParameterPanel;

FilterParameterPanel.prototype.appendCategoryHeader = function(headerEl) {};

/** Extra class the hosting dialog puts on its window element, or null. */
FilterParameterPanel.prototype.dialogClassName = null;

/** When true, host opens a modal dialog instead of inline / auto-apply. */
FilterParameterPanel.prototype.opensAsModalDialog = function() {
  return false;
};

/** @returns {{ width: number, height: number }|null} */
FilterParameterPanel.prototype.getPreferredDialogSize = function(maxW, maxH) {
  return null;
};

FilterParameterPanel.prototype.resize = function(width, height) {};
FilterParameterPanel.prototype.onUpdate = function(doc, changeKind) {};

/** Forwarded from adjust / gallery dialogs when app palette changes. */
FilterParameterPanel.prototype.onDocumentUpdate = function(doc, changeKind) {};

/** Optional per-channel histogram overlay (curves / levels). */
FilterParameterPanel.prototype.setChannelHistograms = function() {};

/**
 * Loads a filter descriptor into the dialog's widgets. Delegates to a registered
 * FilterDefs serializer for this filter id when one exists, otherwise to the
 * subclass `setFields`; the resulting flat `values` array is written into the
 * non-Label widgets in order.
 * @param {object} descriptor
 * @param {Uint8Array|null} [sourceBuffer]
 * @param {object|null} [sourceRect]
 * @param {object|null} [previewRect] Document bounds from AdjustFilterDialog#open.
 * @param {Uint8Array|null} [rasterUnderLayer] Composited pixels below the active layer, or null.
 * @param {Array|null} [dialogContext] `[linkedFiles, extraChannels, document]` for panels that need them.
 */
FilterParameterPanel.prototype.setValue = function(
  descriptor, sourceBuffer, sourceRect, previewRect, rasterUnderLayer, dialogContext
) {
  const extra = resolveDialogExtra(dialogContext, rasterUnderLayer);
  const values = [];
  const serialize = FilterDefs.filterPresetSerialize[this.filterClassId];
  if (serialize) serialize(descriptor, values, extra);
  else this.setFields(descriptor, values, extra);
  writeValuesToWidgets(this.paramWidgets, values);
};

/**
 * Builds a fresh descriptor for this filter id from the current widget values —
 * the inverse of {@link FilterParameterPanel#setValue}. Uses the registered
 * FilterDefs deserializer when present, otherwise the subclass `getFields`.
 * @returns {object} The filter descriptor to apply.
 */
FilterParameterPanel.prototype.getValue = function() {
  const descriptor = FilterDefs.create(this.filterClassId);
  const values = readValuesFromWidgets(this.paramWidgets);
  const deserialize = FilterDefs.filterPresetDeserialize[this.filterClassId];
  if (deserialize) deserialize(descriptor, values);
  else this.getFields(descriptor, values);
  return descriptor;
};

FilterParameterPanel.prototype.onKeyEvent = function(keyEvent) {};

FilterParameterPanel.prototype.refresh = function(widgetEvent) {
  syncLinkedRangePairs(this.paramWidgets, this.linkedRangePairIndices, widgetEvent);
  this.dispatch(new AppEvent(EventType.widgetSelect));
};

FilterParameterPanel.prototype.buildUI = function() {
  for (let i = 0; i < this.paramWidgets.length; i++) this.paramWidgets[i].buildUI();
};

/**
 * @param {number[]|null} [ruleAfterWidgetIndices] widget indices after which to insert a horizontal rule
 */
FilterParameterPanel.prototype.mountFormLayout = function(ruleAfterWidgetIndices) {
  addClass(this.el, "form");
  const widgets = this.paramWidgets;
  for (let i = 0; i < widgets.length; i++) {
    const widget = widgets[i];
    this.mountPlainFormWidget(widget);
    if (widget instanceof Checkbox && widgets[i + 1] instanceof ColorSampleWidget) continue;
    if (ruleAfterWidgetIndices && ruleAfterWidgetIndices.indexOf(i) != -1) {
      appendHorizontalRule(this.el);
    } else {
      appendBreak(this.el);
    }
  }
};

/**
 * Lay the widgets out with some of them collected into titled boxes. Each
 * section is `{ from, to, labelKey }` covering `paramWidgets[from..to]`;
 * widgets outside every section sit directly in the form, exactly as
 * {@link FilterParameterPanel#mountFormLayout} places them.
 *
 * @param {Array<{from: number, to: number, labelKey?: string}>} sections
 */
FilterParameterPanel.prototype.mountSectionedFormLayout = function(sections) {
  addClass(this.el, "form");
  const widgets = this.paramWidgets;
  for (let i = 0; i < widgets.length; i++) {
    const section = sections.find(function(candidate) {
      return i >= candidate.from && i <= candidate.to;
    });
    if (section == null) {
      this.mountPlainFormWidget(widgets[i]);
      appendBreak(this.el);
      continue;
    }
    if (i !== section.from) continue;
    const groupEl = makeElement("div", "optiongroup");
    if (section.labelKey) {
      const titleEl = makeElement("div", "optiongroup-title");
      titleEl.textContent = Locale.get(section.labelKey);
      groupEl.appendChild(titleEl);
    }
    for (let memberIdx = section.from; memberIdx <= section.to; memberIdx++) {
      this.mountPlainFormWidget(widgets[memberIdx], groupEl);
      if (memberIdx !== section.to) appendBreak(groupEl);
    }
    this.el.appendChild(groupEl);
  }
};

/** Parent a widget, subscribe to its edits, and append it to `hostEl`. */
FilterParameterPanel.prototype.mountPlainFormWidget = function(widget, hostEl) {
  widget.parent = this;
  widget.on(EventType.widgetSelect, this.refresh, this);
  (hostEl || this.el).appendChild(widget.el);
};

FilterParameterPanel.prototype.hasOverlay = function() {
  return false;
};

FilterParameterPanel.prototype.onMouseDown = function() {};
FilterParameterPanel.prototype.onMouseMove = function() {};
FilterParameterPanel.prototype.onMouseUp = function() {};
FilterParameterPanel.prototype.getFields = function(descriptor, values) {};
FilterParameterPanel.prototype.setFields = function(descriptor, values) {};

/** Generic fallback panels, cached per filter id. */
const fallbackFilterPanelConstructors = Object.create(null);

function createFallbackFilterPanel(filterId) {
  function FallbackFilterPanel() {
    FilterParameterPanel.call(this, filterId);
    this.mountFormLayout();
  }
  FallbackFilterPanel.prototype = Object.create(FilterParameterPanel.prototype);
  FallbackFilterPanel.prototype.constructor = FallbackFilterPanel;
  return FallbackFilterPanel;
}

/**
 * Panel constructor for a filter id: its registered {@link FilterParameterPanel}
 * subclass when one exists (attached by the adjustment / builtin panel modules),
 * otherwise a cached generic fallback panel.
 */
export function getFilterPanelConstructorOrFallback(filterId) {
  if (filterId === "Adobe Camera Raw Filter") filterId = "cameraRaw";
  const registered = FilterParameterPanel[filterId];
  if (typeof registered === "function") return registered;
  let fallback = fallbackFilterPanelConstructors[filterId];
  if (!fallback) {
    fallback = createFallbackFilterPanel(filterId);
    fallbackFilterPanelConstructors[filterId] = fallback;
  }
  return fallback;
}
