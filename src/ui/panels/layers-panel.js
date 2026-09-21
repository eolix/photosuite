/**
 * Layers sidebar panel. Renders the document's layer tree as nested rows, with
 * a header of layer controls (blend mode, opacity, lock flags, fill) that track
 * the active layer, and a footer toolbar (link, layer style, adjustment layer,
 * mask, folder, new layer, delete). Rows and the footer are drop targets so
 * layers, masks, effects, and smart filters can be dragged to reorder or delete.
 * Right-clicking a row opens the context menu matching that row's type.
 *
 * Collaborators:
 *   LayerGroupItem       ./layer-group-item.js         — a group/layer tree row
 *   LayerStyleRow        ./layer-style-row.js          — effect/filter sub-row
 *   context menus        ./layers-panel-context-menus.js
 *   drag helpers         ./layers-panel-drag.js
 *
 * `rowData.pixelContent` codes the row type a right-click landed on: 1 raster
 * mask, 2 vector mask, 3 filter mask, 4 smart-filter stack, 5 placed layer
 * effects, 6 smart-filter item, 7 layer-effects stack, 8 layer-effect item,
 * anything else the layer itself.
 */
import { Point } from "../../core/math/point.js";
import { BlendModes } from "../../document/model/blend-modes.js";

import { EventChannel } from "../../document/model/tool-base.js";
import { Layer } from "../../document/model/layer.js";
import { BaseTool } from "../widgets/base-tool.js";
import { Button } from "../widgets/form-controls.js";
import { SliderDropdown } from "../widgets/controls/number-inputs.js";
import { Dropdown, RadioOption } from "../widgets/controls/popup-controls.js";
import { LayerGroupItem } from "./layer-group-item.js";
import { installLayersPanelContextMenus } from "./layers-panel-context-menus.js";
import { readLayerDragPayload } from "./layers-panel-drag.js";
import { getIconUrl, iconImgHtml } from "../../assets/icon-registry.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, addPointerDownListener, cancel, isInDOM, makeElement, removeClass } from "../../core/dom.js";
import { dispatchDataTransferImports } from "../shell/file-loader.js";
import { AppEvent } from "../../core/event-bus.js";

/** Construct the Layers panel: build the header controls, body, and footer. */
function LayersPanel() {
  BaseTool.call(this, "panels.layers", false, getIconUrl("panels/layers"), BaseTool.PanelId.LAYERS, true);
  this.layerTreeRoot = null;
  this.doc = null;
  this.openDocs = null;
  this.headerEl = makeElement("div", "lphead");
  this.containerEl = makeElement("div", "lpbody scrollable");
  this.footerEl = makeElement("div", "lpfoot");
  this.blendModeDropdown = new Dropdown(null, BlendModes.uiLabels, false, BlendModes.groupSizes);
  this.blendModeDropdown.on(EventType.widgetSelect, this.onBlendModeChange, this);
  this.headerEl.appendChild(this.blendModeDropdown.el);
  this.opacitySlider = new SliderDropdown("properties.opacity", 0, 100, "%", 0);
  this.opacitySlider.on(EventType.widgetSelect, this.onOpacityChange, this);
  this.opacitySlider.parent = this;
  this.headerEl.appendChild(this.opacitySlider.el);
  this.lockFlagsRadio = new RadioOption("layer.lock", ["<img src=\"" + getIconUrl("trsp3") + "\" class=\"autoscale gsicon\" />", "<img src=\"" + getIconUrl("tools/brush") + "\" class=\"autoscale gsicon\" />", "<img src=\"" + getIconUrl("pos") + "\" class=\"autoscale gsicon\" />", "<img src=\"" + getIconUrl("lrs/lock") + "\" class=\"autoscale gsicon\" />"], true, ["Transparency", "properties.drawMode.pixels",
    "properties.position",
    "select.all"
  ]);
  this.lockFlagsRadio.on(EventType.widgetSelect, this.onLockFlagsChange, this);
  this.headerEl.appendChild(this.lockFlagsRadio.el);
  this.fillSlider = new SliderDropdown("properties.fill", 0, 100, "%", 0);
  this.fillSlider.on(EventType.widgetSelect, this.onFillChange, this);
  this.fillSlider.parent = this;
  this.headerEl.appendChild(this.fillSlider.el);
  this.footerButtons = [];
  this.buildFooterToolbar();
  this.panelBody.appendChild(this.headerEl);
  this.panelBody.appendChild(this.containerEl);
  this.containerEl.addEventListener("dragover", function(dragEvent) {
    dragEvent.preventDefault();
    if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = "move"
  }, false);
  this.containerEl.addEventListener("dragenter", cancel, false);
  this.containerEl.addEventListener("drop", this.onPanelBodyDrop.bind(this), false);
  this.panelBody.appendChild(this.footerEl);
  this.panelBody.addEventListener("contextmenu", cancel, false);
  installLayersPanelContextMenus(this);
  this.on("rclick", this.onLayerRowRightClick, this)
}

LayersPanel.prototype = Object.create(BaseTool.prototype);
LayersPanel.prototype.onPanelBodyDrop = function(dropEvent) {
  cancel(dropEvent);
  const payloadText = readLayerDragPayload(dropEvent.dataTransfer),
    dropRatio = 1,
    insertIndex = 0;
  if (payloadText == "") {
    dispatchDataTransferImports(dropEvent, this, this.openDocs.indexOf(this.doc), insertIndex + (dropRatio > .5 ? 0 : 1))
  } else if (payloadText != "--panel") {
    const payload = JSON.parse(payloadText),
      dragKind = payload.kind;
    if (dragKind == "l") this.applyEvent({
      actionKind: Layer.moveLayer,
      source: payload.layerIndex,
      target: insertIndex,
      dropPositionRatio: dropRatio
    })
  }
};
LayersPanel.prototype.getPreferredSize = function() {
  return new Point(253, 0);
};
/**
 * Right-click on a layer row. Selects the row's layer if not already selected,
 * then picks the context menu matching the row type (see the pixelContent codes
 * in the file header), primes any per-row indices into the menu's action
 * payloads, and shows it as a floating overlay at the pointer.
 */
LayersPanel.prototype.onLayerRowRightClick = function(menuEvent) {
  const doc = this.doc,
    rowData = menuEvent.data;
  let contextMenu;
  if (doc.selectedLayerIndices.indexOf(rowData.layerIndex) == -1) {
    const selectEvent = {
      actionKind: Layer.selectLayer,
      layerIndex: menuEvent.target.sectionNode.index,
      pixelContentKind: rowData.pixelContent
    };
    this.applyEvent(selectEvent)
  }
  if (doc.selectedLayerIndices.indexOf(rowData.layerIndex) == -1) return;
  if (rowData.pixelContent == 1) {
    contextMenu = this.rasterMaskMenu
  } else if (rowData.pixelContent == 2) {
    contextMenu = this.vectorMaskMenu
  } else if (rowData.pixelContent == 3) {
    contextMenu = this.filterMaskMenu
  } else if (rowData.pixelContent == 4) {
    contextMenu = this.smartFilterMenu
  } else if (rowData.pixelContent == 6) {
    this.smartFilterContextIndex = rowData.styleIndex;
    const smartFilterActions = this.smartFilterItemMenu.menuActionDescriptors;
    smartFilterActions[0].payload.layerIndex = rowData.layerIndex;
    smartFilterActions[0].payload.index = rowData.styleIndex;
    smartFilterActions[1].payload.sourceLayerIndex = rowData.layerIndex;
    smartFilterActions[1].payload.styleIndex = rowData.styleIndex;
    contextMenu = this.smartFilterItemMenu
  } else if (rowData.pixelContent == 7) {
    const layerEffectsStackActions = this.layerEffectsStackMenu.menuActionDescriptors;
    layerEffectsStackActions[0].payload.layerIndex = rowData.layerIndex;
    layerEffectsStackActions[1].payload.layerIndex = rowData.layerIndex;
    contextMenu = this.layerEffectsStackMenu
  } else if (rowData.pixelContent == 8) {
    this.layerEffectContextIndex = rowData.styleIndex;
    const layerEffectItemActions = this.layerEffectItemMenu.menuActionDescriptors;
    layerEffectItemActions[0].payload.layerIndex = rowData.layerIndex;
    layerEffectItemActions[0].payload.index = rowData.styleIndex;
    layerEffectItemActions[1].payload.layerIndex = rowData.layerIndex;
    layerEffectItemActions[1].payload.effectPathIndices = rowData.styleIndex;
    contextMenu = this.layerEffectItemMenu
  } else if (rowData.pixelContent == 5) {
    contextMenu = this.placedLayerEffectsMenu
  } else {
    contextMenu = this.layerRowContextMenu
  }
  contextMenu.buildUI();
  contextMenu.update(doc);
  contextMenu.parent = this;
  const overlayEvent = new AppEvent(EventType.uiDispatch, true);
  overlayEvent.data = {
    dispatchKind: UiCommand.showFloatingOverlay,
    overlayWidget: contextMenu,
    x: rowData.contextMenuPointer.x + 1,
    y: rowData.contextMenuPointer.y + 1
  };
  this.dispatch(overlayEvent)
};
LayersPanel.prototype.buildUI = function() {
  BaseTool.prototype.buildUI.call(this);
  this.blendModeDropdown.buildUI();
  this.opacitySlider.buildUI();
  this.lockFlagsRadio.buildUI();
  this.fillSlider.buildUI();
  if (this.doc) this.open(this.doc);
  const footerIconIds = "lrs/link lrs/fx lrs/adj lrs/mask lrs/folder lrs/newlayer lrs/bin".split(" ");
  for (let buttonIdx = 0; buttonIdx < this.footerButtons.length; buttonIdx++) {
    const footerButton = this.footerButtons[buttonIdx];
    footerButton.setLabel(iconImgHtml(footerIconIds[buttonIdx]))
  }
};
/**
 * Rebuild the panel for `doc`. Rebuilds the layer tree, enables/disables the
 * panel, and syncs the header controls (blend mode, opacity, locks, fill) to
 * the active layer. Groups get an extra "pass through" blend option. Bails
 * early when the document has not changed.
 */
LayersPanel.prototype.open = function(doc, allOpenDocs) {
  if (doc && !doc.stateChanged) return;
  if (doc == null) addClass(this.panelBody, "disabled");
  else removeClass(this.panelBody, "disabled");
  this.doc = doc;
  this.openDocs = allOpenDocs;
  if (this.layerTreeRoot != null) {
    this.containerEl.removeChild(this.layerTreeRoot.containerEl);
    this.layerTreeRoot = null
  }
  if (doc == null) return;
  this.layerTreeRoot = new LayerGroupItem(doc.root, this, doc, {
    colorIntArgb: 0
  });
  this.containerEl.appendChild(this.layerTreeRoot.containerEl);
  if (doc.selectedLayerIndices.length == 0 || doc.layers[doc.selectedLayerIndices[0]] == null) addClass(this.headerEl, "disabled");
  else {
    removeClass(this.headerEl, "disabled");
    if (doc.selectedLayerIndices.length == 1 && doc.needsScrollToSelected) this.layerTreeRoot.scrollIndicesIntoView(doc.selectedLayerIndices);
    const activeLayer = doc.layers[doc.selectedLayerIndices[0]];
    if (activeLayer.isGroup()) {
      this.blendModeDropdown.setItems([
        "brushAndMessages.blendModes.passThrough"
      ].concat(BlendModes.uiLabels), [1].concat(BlendModes.groupSizes));
      const blendModeIndex = BlendModes.psdCodes.indexOf(activeLayer.blendMode);
      this.blendModeDropdown.setValue(blendModeIndex + 1)
    } else {
      this.blendModeDropdown.setItems(BlendModes.uiLabels, BlendModes.groupSizes);
      const blendModeIndex = BlendModes.psdCodes.indexOf(activeLayer.blendMode);
      this.blendModeDropdown.setValue(blendModeIndex)
    }
    this.opacitySlider.setValue(Math.round(100 * activeLayer.Opct / 255));
    this.lockFlagsRadio.setValue([activeLayer.isLockBitSet(0), activeLayer.isLockBitSet(1), activeLayer.isLockBitSet(2), activeLayer.isLockBitSet(31)]);
    this.fillSlider.setValue(Math.round(100 * (activeLayer.add.iOpa != null ? activeLayer.add.iOpa / 255 : 1)))
  }
};
LayersPanel.prototype.resize = function(_width, panelHeight) {
  const headerHeight = this.headerEl.getBoundingClientRect().height;
  let chromeHeight = 59;
  if (headerHeight > 70) chromeHeight = 84;
  if (headerHeight > 100) chromeHeight = 108;
  const bodyHeight = panelHeight - (chromeHeight + 37);
  this.containerEl.style.height = bodyHeight + "px"
};
LayersPanel.prototype.onBlendModeChange = function() {
  this.applyEvent({
    actionKind: Layer.setBlendMode,
    layerPropertyValue: this.blendModeDropdown.getValue()
  })
};
LayersPanel.prototype.onOpacityChange = function() {
  this.applyEvent({
    actionKind: Layer.setLayerOpacity,
    layerPropertyValue: Math.round(255 * this.opacitySlider.getValue() / 100)
  })
};
LayersPanel.prototype.onLockFlagsChange = function() {
  this.applyEvent({
    actionKind: Layer.toggleLayerLocks,
    layerPropertyValue: [this.lockFlagsRadio.getValue(), [0, 1, 2, 31]]
  })
};
LayersPanel.prototype.onFillChange = function() {
  this.applyEvent({
    actionKind: Layer.setFillOpacity,
    layerPropertyValue: Math.round(255 * this.fillSlider.getValue() / 100)
  })
};
LayersPanel.prototype.onNewAdjustmentLayer = function(clickEvent) {
  this.showMenuAtFooterButton(clickEvent, this.adjustmentLayerMenu)
};
LayersPanel.prototype.onLayerStyleFooterClick = function(clickEvent) {
  this.showMenuAtFooterButton(clickEvent, this.layerStyleMenu)
};
LayersPanel.prototype.showMenuAtFooterButton = function(clickEvent, menuHandler) {
  const buttonEl = clickEvent.currentTarget;
  if (isInDOM(menuHandler.el)) return;
  clickEvent.stopPropagation();
  const anchorRect = buttonEl.getBoundingClientRect();
  menuHandler.buildUI();
  menuHandler.update(this.doc);
  menuHandler.parent = this;
  const overlayEvent = new AppEvent(EventType.uiDispatch, true);
  overlayEvent.data = {
    dispatchKind: UiCommand.showFloatingOverlay,
    overlayWidget: menuHandler,
    x: anchorRect.left,
    y: anchorRect.top,
    anchorAbove: true
  };
  this.dispatch(overlayEvent)
};
LayersPanel.prototype.onAddRasterMask = function() {
  this.applyEvent({
    actionKind: Layer.routeMaskFromSelection
  })
};
LayersPanel.prototype.onNewFolder = function() {
  this.applyEvent({
    actionKind: this.doc.selectedLayerIndices.length > 1 ? Layer.groupOrUngroup : Layer.newFolder
  })
};
LayersPanel.prototype.onNewLayer = function() {
  this.applyEvent({
    actionKind: Layer.newLayer
  })
};
LayersPanel.prototype.onDeleteLayer = function() {
  this.applyEvent({
    actionKind: Layer.deleteLayer
  })
};
LayersPanel.prototype.onLinkLayers = function() {
  this.applyEvent({
    actionKind: Layer.linkLayers
  })
};
LayersPanel.prototype.applyEvent = function(eventData) {
  const docEvent = new AppEvent(EventType.documentAction, true);
  docEvent.data = eventData;
  docEvent.routingChannel = EventChannel.EVENT_DOCUMENT;
  this.dispatch(docEvent)
};
LayersPanel.prototype.buildFooterToolbar = function() {
  const footerLabelKeys = [
      "layer.linkLayers",
      "dialogs.layerStyle",
      "layer.newAdjustmentLayer",
      "layer.addRasterMask",
      "layer.newFolder",
      "layer.newLayer",
      "layer.deleteLayer"
    ],
    footerClickHandlers = [this.onLinkLayers, this.onLayerStyleFooterClick, this.onNewAdjustmentLayer, this.onAddRasterMask, this.onNewFolder, this.onNewLayer, this.onDeleteLayer],
    onFooterDrop = this.onFooterToolbarDrop.bind(this);
  for (let buttonIdx = 0; buttonIdx < footerLabelKeys.length; buttonIdx++) {
    const footerButton = new Button("W", false, footerLabelKeys[buttonIdx]);
    this.footerButtons.push(footerButton);
    addPointerDownListener(footerButton.el, footerClickHandlers[buttonIdx].bind(this));
    this.footerEl.appendChild(footerButton.el);
    if (buttonIdx >= footerLabelKeys.length - 3) {
      const dropTargetEl = footerButton.el;
      dropTargetEl.addEventListener("drop", onFooterDrop, false);
      dropTargetEl.addEventListener("dragover", function(dragEvent) {
        dragEvent.preventDefault()
      }, false);
      dropTargetEl.addEventListener("dragenter", cancel, false)
    }
  }
};
/**
 * Handle a row dragged onto one of the last three footer buttons (folder,
 * new layer, delete). Dropping a layer runs group/duplicate/delete by which
 * button; dropping a mask, effect, or smart filter onto the delete button
 * removes that piece from its layer.
 */
LayersPanel.prototype.onFooterToolbarDrop = function(dropEvent) {
  cancel(dropEvent);
  const footerButtons = this.footerButtons;
  let buttonIndex = 0;
  while (footerButtons[buttonIndex].el != dropEvent.currentTarget) buttonIndex++;
  footerButtons[buttonIndex].clearActive();
  const payloadText = readLayerDragPayload(dropEvent.dataTransfer);
  if (payloadText == "") return;
  const payload = JSON.parse(payloadText);
  if (payload.kind == "l") {
    const layerAction = {
      actionKind: [Layer.groupOrUngroup, Layer.duplicateLayer, Layer.deleteLayer][buttonIndex - 4]
    };
    if (this.doc.selectedLayerIndices.indexOf(payload.layerIndex) == -1) layerAction.overrideLayerIndex = payload.layerIndex;
    this.applyEvent(layerAction)
  }
  if (buttonIndex != 6) return;
  if (payload.kind == "sm" || payload.kind == "s") {
    const pluginEvent = new AppEvent(EventType.documentAction, true);
    pluginEvent.routingChannel = EventChannel.EVENT_PLUGIN;
    pluginEvent.data = {
      actionKind: payload.kind == "sm" ? "st_clear" : "st_delsingle",
      layerIndex: payload.layerIndex,
      effectPathIndices: payload.styleIndex
    };
    this.dispatch(pluginEvent)
  }
  if (payload.kind == "fm" || payload.kind == "f") {
    this.applyEvent({
      actionKind: payload.kind == "fm" ? Layer.clearSmartFilters : Layer.deleteSmartFilter,
      sourceLayerIndex: payload.layerIndex,
      filterIndex: payload.styleIndex
    })
  }
  if (payload.kind == "m" || payload.kind == "vm") {
    this.applyEvent({
      actionKind: payload.kind == "m" ? Layer.deleteRasterMask : Layer.deleteVectorMask,
      layerIndex: payload.layerIndex
    })
  }
};

export { LayersPanel };