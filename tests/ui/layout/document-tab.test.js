/**
 * DocumentTab layout strip (expand/collapse, attach, select).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";
import { UiCommand } from "../../../src/core/event-bus.js";

installBrowserGlobals();

// The tab strip builds its panel-menu button from an icon URL at construction.

let DocumentTab;

before(async () => {
  ({ DocumentTab } = await import("../../../src/ui/layout/document-tab.js"));
});

function makeStubPanel(name) {
  const tabEl = globalThis.document.createElement("div");
  const panelBody = globalThis.document.createElement("div");
  const sidebarBtnEl = globalThis.document.createElement("button");
  return {
    name,
    tabEl,
    panelBody,
    parent: null,
    sidebarBtn: {
      el: sidebarBtnEl,
      parent: null,
      on() {},
      removeEventListener() {},
      clearActive() {},
      markActive() {},
      isPressed() {
        return false;
      },
    },
    on() {},
    removeEventListener() {},
    getPreferredSize() {
      return { x: 120, y: 80 };
    },
    getEditorMode() {
      return null;
    },
    resize() {},
    onUpdate() {},
    open() {},
    refresh() {},
    dismissPanel() {},
  };
}

describe("ui/layout/document-tab.js", () => {
  it("constructor goldens and drag instance ids", () => {
    const before = DocumentTab.nextDragInstanceId;
    const tab = new DocumentTab(null);
    assert.equal(tab.isBodyExpanded, true);
    assert.equal(tab.activePanelIndex, -1);
    assert.equal(tab.panels.length, 0);
    assert.equal(tab.tabBarLayoutMode, 0);
    assert.equal(tab.createEmptyStateWidget(), null);
    assert.equal(tab.getPanelCount(), 0);
    assert.equal(tab.dragInstanceId, before);
    const tab2 = new DocumentTab(null);
    assert.equal(tab2.dragInstanceId, before + 1);
    assert.equal(tab.allowsCrossDocumentLayerDrop(), false);
    const hosted = new DocumentTab({});
    assert.equal(hosted.allowsCrossDocumentLayerDrop(), true);
  });

  it("expand / collapse toggles body chrome", () => {
    const tab = new DocumentTab(null);
    assert.equal(tab.isBodyExpanded, true);
    tab.collapse();
    assert.equal(tab.isBodyExpanded, false);
    tab.collapse();
    assert.equal(tab.isBodyExpanded, false);
    tab.expand();
    assert.equal(tab.isBodyExpanded, true);
    tab.expand();
    assert.equal(tab.isBodyExpanded, true);
  });

  it("setTabBarPosition updates layout mode", () => {
    const tab = new DocumentTab(null);
    tab.setTabBarPosition(1);
    assert.equal(tab.tabBarLayoutMode, 1);
    tab.setTabBarPosition(0);
    assert.equal(tab.tabBarLayoutMode, 0);
  });

  it("attachPanel + selectPanelAt mounts body and selects last panel", () => {
    const tab = new DocumentTab(null);
    const panel = makeStubPanel("a");
    tab.attachPanel(panel);
    assert.equal(panel.parent, tab);
    assert.equal(tab.getPanelCount(), 1);
    assert.equal(tab.getActivePanelIndex(), 0);
    assert.equal(tab.activePanelBodyEl, panel.panelBody);

    const panelB = makeStubPanel("b");
    tab.attachPanel(panelB);
    assert.equal(tab.getPanelCount(), 2);
    assert.equal(tab.getActivePanelIndex(), 1);
    assert.equal(tab.activePanelBodyEl, panelB.panelBody);
  });

  it("detachPanelAt empties strip and restores empty-state hook", () => {
    const tab = new DocumentTab(null);
    let emptyCalls = 0;
    tab.createEmptyStateWidget = function() {
      emptyCalls++;
      return globalThis.document.createElement("div");
    };
    const panel = makeStubPanel("solo");
    tab.attachPanel(panel);
    tab.detachPanelAt(0);
    assert.equal(tab.getPanelCount(), 0);
    assert.ok(tab.emptyStateWidgetEl);
    assert.ok(emptyCalls >= 2);
  });

  it("getPreferredSize takes max across panels", () => {
    const tab = new DocumentTab(null);
    const a = makeStubPanel("a");
    a.getPreferredSize = () => ({ x: 10, y: 50 });
    const b = makeStubPanel("b");
    b.getPreferredSize = () => ({ x: 40, y: 20 });
    tab.attachPanel(a);
    tab.attachPanel(b);
    const size = tab.getPreferredSize();
    assert.equal(size.x, 40);
    assert.equal(size.y, 50);
  });

  it("cross-doc drop payload uses targetDocumentTabIndex", () => {
    const tab = new DocumentTab({});
    const events = [];
    tab.dispatch = function(evt) {
      events.push(evt);
    };
    const target = tab.containerEl;
    tab.activePanelIndex = 0;
    tab.panels = [makeStubPanel("doc")];
    tab.onPanelDrop({
      currentTarget: target,
      target,
      dataTransfer: {
        getData() {
          return "layer-payload";
        },
        types: [],
      },
      stopPropagation() {},
      preventDefault() {},
    });
    const cross = events.find(
      (e) => e.data && e.data.dispatchKind === UiCommand.dragLayerAcrossDocuments
    );
    assert.ok(cross);
    assert.equal(cross.data.targetDocumentTabIndex, 0);
    assert.equal(cross.data.alw, undefined);
  });
});
