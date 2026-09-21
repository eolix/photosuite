/**
 * Right-hand sidebar: two resizable columns of DocumentTab strips hosting
 * the registered tool panels (layers, history, color, plugins, …).
 */

import { BaseWidget } from "../widgets/base-widget.js";
import { ActionsPanel } from "../panels/actions-panel.js";
import { BrushPanel } from "../panels/brush-panel.js";
import { ChannelsPanel } from "../panels/channels-panel.js";
import { CharacterPanel } from "../panels/character-panel.js";
import { ColorPanel } from "../panels/color-panel.js";
import { CSSPanel } from "../panels/css-panel.js";
import { GlyphsPanel } from "../panels/glyphs-panel.js";
import { GuidesPanel } from "../panels/guides-panel.js";
import { HistogramPanel } from "../panels/histogram-panel.js";
import { HistoryPanel } from "../panels/history-panel.js";
import { InfoPanel } from "../panels/info-panel.js";
import { LayerCompsPanel } from "../panels/layer-comps-panel.js";
import { LayersPanel } from "../panels/layers-panel.js";
import { NavigatorPanel } from "../panels/navigator-panel.js";
import { PathsPanel } from "../panels/paths-panel.js";
import { PluginPanel } from "../panels/plugin-panel.js";
import { resolveSidebarPluginPanelId } from "../../features/plugins/plugin-spec.js";
import { PropertiesPanel } from "../panels/properties-panel.js";
import { SwatchesPanel } from "../panels/swatches-panel.js";
import { ToolPresetsPanel } from "../panels/tool-presets-panel.js";
import { WebImagesPanel } from "../panels/web-images-panel.js";
import { DocumentTab } from "./document-tab.js";
import { PanelColumn } from "./panel-column.js";
import { PopupTypes } from "../config/popup-types.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { clearElement, makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";

/** Primary / secondary column default widths (CSS px). */
const PRIMARY_COLUMN_WIDTH_PX = 380;
const SECONDARY_COLUMN_WIDTH_PX = 265;

/** Tab-bar slots map to panelRegistry `columnIndex` values 0..5. */
const TAB_BAR_SLOT_COUNT = 6;

/** Below this host width, all tab bars pack into the secondary column. */
const NARROW_HOST_PACK_WIDTH_PX = 500;

/** Secondary column collapses when the host is narrower than this. */
const SECONDARY_COLLAPSE_HOST_WIDTH_PX = 700;

/**
 * Top-level right sidebar. Owns two {@link PanelColumn}s and six tab-bar
 * slots ({@link DocumentTab}). Registered panels declare a `columnIndex`
 * (0–5) naming their slot; {@link RightSidebar#redraw} reads the active
 * document's `effectRows` layout and places the non-empty slots into the
 * primary or secondary column, packing everything into the secondary column
 * when the host is narrow.
 */
function RightSidebar() {
  BaseWidget.call(this);
  this.doc = null;
  this.panelEntries = RightSidebar.panelRegistry;
  this.cachedLayoutRowKey = "";
  this.el = makeElement("div", "rightbar");
  this.columns = [
    new PanelColumn(PRIMARY_COLUMN_WIDTH_PX),
    new PanelColumn(SECONDARY_COLUMN_WIDTH_PX)
  ];
  this.columnTabBars = createEmptyTabBarSlots();
  this.dynamicPanelIds = [];
}
RightSidebar.prototype = Object.create(BaseWidget.prototype);

RightSidebar.prototype.buildUI = function() {
  forEachPanelEntry(this.panelEntries, function(panel) {
    panel.buildUI();
  });
};

/**
 * Static registry of sidebar panels. Built lazily on first access so importing
 * this module does not construct every panel (canvas / Locale dependent).
 * @type {Array<{panel: object, columnIndex: number, windowMoreMenuOnly?: boolean}>}
 */
Object.defineProperties(RightSidebar, {
  panelRegistry: {
    configurable: true,
    enumerable: true,
    get: function() {
      if (!RightSidebar._panelRegistry) {
        RightSidebar._panelRegistry = buildStaticPanelRegistry();
      }
      return RightSidebar._panelRegistry;
    },
    set: function(value) {
      RightSidebar._panelRegistry = value;
    }
  }
});

RightSidebar.prototype.registerRuntimePlugins = function(pluginSpecs) {
  for (let pluginIdx = 0; pluginIdx < pluginSpecs.length; pluginIdx++) {
    const pluginSpec = pluginSpecs[pluginIdx];
    const pluginPanel = new PluginPanel(pluginSpec, resolveSidebarPluginPanelId(pluginSpec));
    this.panelEntries.push({
      panel: pluginPanel,
      columnIndex: 5
    });
    this.dynamicPanelIds.push(pluginPanel.panelId);
  }
  this.redraw();
};

RightSidebar.prototype.onUpdate = function(doc, popupType) {
  this.doc = doc;
  forEachPanelEntry(this.panelEntries, function(panel) {
    panel.onUpdate(doc, popupType);
  });
  if (popupType == PopupTypes.FONTS || popupType == PopupTypes.ALL) this.redraw();
};

RightSidebar.prototype.broadcastMessage = function(payload) {
  forEachPanelEntry(this.panelEntries, function(panel) {
    panel.broadcastMessage(payload);
  });
};

RightSidebar.prototype.resize = function(width, height) {
  this.hostWidth = width;
  this.hostHeight = height;
  this.columns[0].resize(width, height);
  this.columns[1].resize(width, height);
};

RightSidebar.prototype.redraw = function() {
  const doc = this.doc;
  const hostWidth = this.hostWidth;
  if (doc == null || hostWidth == 0) return;
  const layoutPanelIds = doc.effectRows.concat(this.dynamicPanelIds);
  const layoutKey = serializeLayoutRowKey(layoutPanelIds);
  if (layoutKey == this.cachedLayoutRowKey) return;
  this.cachedLayoutRowKey = layoutKey;
  rebuildSidebarLayout(this, layoutPanelIds, hostWidth);
};

RightSidebar.prototype.findEntryByPanelId = function(panelId) {
  return findRegistryEntryByPanelId(this.panelEntries, panelId);
};

RightSidebar.prototype.attachPanelByPanelId = function(panelId) {
  const entry = this.findEntryByPanelId(panelId);
  this.columnTabBars[entry.columnIndex].attachPanel(entry.panel);
};

RightSidebar.prototype.open = function(doc, docs, appData) {
  forEachPanelEntry(this.panelEntries, function(panel) {
    panel.open(doc, docs, appData);
  });
};

RightSidebar.prototype.onMouseDown = function(evt, doc, mode, view, pos) {
  forEachPanelEntry(this.panelEntries, function(panel) {
    panel.onMouseDown(evt, doc, mode, view, pos);
  });
};

RightSidebar.prototype.onMouseMove = function(evt, doc, mode, view, pos) {
  forEachPanelEntry(this.panelEntries, function(panel) {
    panel.onMouseMove(evt, doc, mode, view, pos);
  });
};

RightSidebar.prototype.onMouseUp = function(evt, doc, mode, view, pos) {
  forEachPanelEntry(this.panelEntries, function(panel) {
    panel.onMouseUp(evt, doc, mode, view, pos);
  });
};

// ---------------------------------------------------------------------------
// Layout helpers (exported for Tier I goldens)
// ---------------------------------------------------------------------------

/**
 * Which physical column hosts a tab-bar slot.
 * Slots 0–1 always pack into the secondary column; slots 2–5 use the primary
 * column when the host is wide enough.
 */
function resolveHostColumnIndex(tabBarIndex, hostWidth) {
  return tabBarIndex < 2 || hostWidth < NARROW_HOST_PACK_WIDTH_PX ? 1 : 0;
}

/** Whether the secondary (narrow) column should start collapsed after redraw. */
function shouldCollapseSecondaryColumn(hostWidth, doc, wasSecondaryExpanded) {
  return hostWidth < SECONDARY_COLLAPSE_HOST_WIDTH_PX || doc.compact || !wasSecondaryExpanded;
}

function serializeLayoutRowKey(layoutPanelIds) {
  return JSON.stringify(layoutPanelIds);
}

function findRegistryEntryByPanelId(entries, panelId) {
  for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
    if (entries[entryIdx].panel.panelId == panelId) return entries[entryIdx];
  }
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

function createEmptyTabBarSlots() {
  const bars = [];
  for (let i = 0; i < TAB_BAR_SLOT_COUNT; i++) bars.push(new DocumentTab());
  return bars;
}

function forEachPanelEntry(entries, visit) {
  for (let entryIdx = 0; entryIdx < entries.length; entryIdx++) {
    visit(entries[entryIdx].panel, entries[entryIdx], entryIdx);
  }
}

function buildStaticPanelRegistry() {
  return [
    { panel: new ActionsPanel(), columnIndex: 2 },
    { panel: new BrushPanel(), columnIndex: 3 },
    { panel: new ChannelsPanel(), columnIndex: 1 },
    { panel: new CharacterPanel(true), columnIndex: 4 },
    { panel: new ColorPanel(), columnIndex: 0 },
    { panel: new GlyphsPanel(), columnIndex: 4 },
    { panel: new HistogramPanel(), columnIndex: 2 },
    { panel: new HistoryPanel(), columnIndex: 0 },
    { panel: new InfoPanel(), columnIndex: 2 },
    { panel: new LayersPanel(), columnIndex: 1 },
    { panel: new LayerCompsPanel(), columnIndex: 3 },
    { panel: new NavigatorPanel(), columnIndex: 2 },
    { panel: new CharacterPanel(false), columnIndex: 4 },
    { panel: new PathsPanel(), columnIndex: 1 },
    { panel: new ToolPresetsPanel(), columnIndex: 4 },
    { panel: new PropertiesPanel(), columnIndex: 2 },
    { panel: new SwatchesPanel(), columnIndex: 0 },
    { panel: new CSSPanel(), columnIndex: 5, windowMoreMenuOnly: true },
    { panel: new GuidesPanel(), columnIndex: 5, windowMoreMenuOnly: true },
    { panel: new WebImagesPanel(), columnIndex: 5, windowMoreMenuOnly: true }
  ];
}

function rebuildSidebarLayout(sidebar, layoutPanelIds, hostWidth) {
  clearElement(sidebar.el);
  const columnExpandedBefore = clearColumnsForRebuild(sidebar.columns);
  const tabBarPanelCounts = resetTabBarsForRebuild(sidebar.columnTabBars);
  attachPanelsToTabBars(sidebar, layoutPanelIds, tabBarPanelCounts);
  const columnHasPanels = placeTabBarsIntoColumns(sidebar, tabBarPanelCounts, hostWidth);
  mountColumnsWithPanels(sidebar, columnHasPanels);
  sidebar.columns[0].collapse();
  if (shouldCollapseSecondaryColumn(hostWidth, sidebar.doc, columnExpandedBefore[1])) {
    sidebar.columns[1].collapse();
  }
  dispatchDocumentLayoutInvalidate(sidebar);
}

function clearColumnsForRebuild(columns) {
  const columnExpandedBefore = [];
  for (let columnIdx = 0; columnIdx < columns.length; columnIdx++) {
    const column = columns[columnIdx];
    columnExpandedBefore[columnIdx] = column.isExpanded();
    while (column.getPanelCount() != 0) column.removePanelAt(0);
    column.expand();
  }
  return columnExpandedBefore;
}

function resetTabBarsForRebuild(columnTabBars) {
  const tabBarPanelCounts = [];
  for (let tabBarIdx = 0; tabBarIdx < columnTabBars.length; tabBarIdx++) {
    const tabBar = columnTabBars[tabBarIdx];
    tabBar.expand();
    while (tabBar.getPanelCount() != 0) tabBar.detachPanelAt(0);
    tabBarPanelCounts.push(0);
  }
  return tabBarPanelCounts;
}

function attachPanelsToTabBars(sidebar, layoutPanelIds, tabBarPanelCounts) {
  for (let panelIdx = 0; panelIdx < layoutPanelIds.length; panelIdx++) {
    const registryEntry = sidebar.findEntryByPanelId(layoutPanelIds[panelIdx].toString());
    // A saved layout can name a panel that is not registered in this build
    // (for example a runtime plugin that is no longer installed).
    if (registryEntry == null) continue;
    sidebar.columnTabBars[registryEntry.columnIndex].attachPanel(registryEntry.panel);
    sidebar.columnTabBars[registryEntry.columnIndex].selectPanelAt(0);
    tabBarPanelCounts[registryEntry.columnIndex]++;
  }
}

function placeTabBarsIntoColumns(sidebar, tabBarPanelCounts, hostWidth) {
  const columnHasPanels = [];
  for (let tabBarIdx = 0; tabBarIdx < tabBarPanelCounts.length; tabBarIdx++) {
    if (tabBarPanelCounts[tabBarIdx] == 0) continue;
    const targetColumnIndex = resolveHostColumnIndex(tabBarIdx, hostWidth);
    const column = sidebar.columns[targetColumnIndex];
    column.parent = sidebar;
    column.addPanel(sidebar.columnTabBars[tabBarIdx]);
    columnHasPanels[targetColumnIndex] = true;
  }
  return columnHasPanels;
}

function mountColumnsWithPanels(sidebar, columnHasPanels) {
  for (let columnIdx = 0; columnIdx < sidebar.columns.length; columnIdx++) {
    if (columnHasPanels[columnIdx]) sidebar.el.appendChild(sidebar.columns[columnIdx].el);
  }
}

function dispatchDocumentLayoutInvalidate(sidebar) {
  const layoutEvt = new AppEvent(EventType.uiDispatch, true);
  layoutEvt.data = {
    dispatchKind: UiCommand.documentLayoutInvalidate
  };
  sidebar.dispatch(layoutEvt);
}

export {
  RightSidebar,
  resolveHostColumnIndex,
  shouldCollapseSecondaryColumn,
  serializeLayoutRowKey,
  findRegistryEntryByPanelId
};
