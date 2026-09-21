/**
 * One layer row (and, for open groups, its nested child rows) in the Layers
 * panel tree. Each row builds the visibility eye, layer / mask thumbnails,
 * name label, and the lock / link / effects icons, plus the expandable
 * layer-styles and smart-filters sub-stack. It also wires drag-and-mouse
 * reordering, mask link toggles, inline rename, and click / context-menu
 * dispatch back to the panel.
 */
import { Locale } from "../../core/i18n/locale.js";

import { AdjustmentEngine } from "../../features/adjustments/adjustment-engine.js";
import { FilterDefs } from "../../features/filters/filter-apply.js";
import { LayerEffectDefs } from "../../document/formats/psd/effect-defs.js";
import { ToolId, EventChannel } from "../../document/model/tool-base.js";
import { Layer, LayerSectionType } from "../../document/model/layer.js"
import { BaseWidget } from "../widgets/base-widget.js";
import { BaseTool } from "../widgets/base-tool.js";
import { LayerStyleRow } from "./layer-style-row.js";
import { adjustmentKeyOf } from "../../document/formats/psd/adjustment-parsers.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addClass, cancel, getDevicePixelRatio, getEventPos, makeElement } from "../../core/dom.js";
import { dispatchDataTransferImports } from "../shell/file-loader.js";
import { AppEvent } from "../../core/event-bus.js";
import { psdColorToRgb, toRGBDesc } from "../../engine/compositing/psd-color-utils.js";
import {
  dispatchLayerStyleDragReorder,
  layerPanelDragState,
  layerPanelEventYRatioInElement,
  readLayerDragPayload,
} from "./layers-panel-drag.js";

/**
 * Build the row for one layer. The constructor assembles every part of the
 * row's DOM from the layer's current state and recurses into child rows when
 * the layer is an open group.
 *
 * @param {object} sectionNode tree node for this layer (index, depth, layer,
 *   children)
 * @param {object} layersPanel owning Layers panel; receives dispatched actions
 * @param {object} doc active document model
 * @param {{colorIntArgb:number}} options inherited label colour for the row
 */
function LayerGroupItem(sectionNode, layersPanel, doc, options) {
  BaseWidget.call(this);
  this.parent = layersPanel;
  this.sectionNode = sectionNode;
  this.childRows = [];
  this.el = makeElement("div", "layeritem");
  const layer = sectionNode.layer;
  let eyeIconSizePx = 15,
    hasLinkedLayerInGroup = false;
  this.headerEl = makeElement("div", doc.selectedLayerIndices.indexOf(sectionNode.index) != -1 ? "head selected" : "head");
  if (sectionNode.layer.add.artb != null) addClass(this.headerEl, "artb");
  this.headerEl.setAttribute("style", "height: " + (layer.thumbnailHeight + 10) + "px");
  const headerLeftEl = makeElement("div", "headL"),
    headerRightEl = makeElement("div", "headR"),
    effectsPanelEl = makeElement("div", "lpineck");
  this.containerEl = makeElement("div", "lpibody");
  this.el.appendChild(this.headerEl);
  this.headerEl.appendChild(headerLeftEl);
  this.headerEl.appendChild(headerRightEl);
  if (layer.hasLayerEffects() || layer.hasSmartFilters())
    if (layer.isEffectsExpanded()) this.el.appendChild(effectsPanelEl);
  const dragHeaderEl = this.headerEl;
  dragHeaderEl.__layerGroupItemRow = this;
  dragHeaderEl.setAttribute("draggable", "false");
  dragHeaderEl.addEventListener("mousedown", this.onRowPointerDown.bind(this), false);
  dragHeaderEl.addEventListener("dragstart", this.onHeaderDragStart.bind(this), false);
  dragHeaderEl.addEventListener("drop", this.onDrop.bind(this), false);
  dragHeaderEl.addEventListener("dragover", this.onDragOver.bind(this), false);
  dragHeaderEl.addEventListener("dragenter", cancel, false);
  dragHeaderEl.addEventListener("dragleave", this.onDragLeave.bind(this), false);
  const leftSlotEls = [],
    rightSlotEls = [],
    visibilityWrapEl = makeElement("div");
  this.visibilityEyeEl = makeElement("div", "eye");
  visibilityWrapEl.appendChild(this.visibilityEyeEl);
  const depthSpacerEl = makeElement("div", "space");
  this.nameLabelEl = makeElement("div", "label");
  this.nameLabelEl.setAttribute("style", "max-width:calc(100% - " + (96 + sectionNode.depth * 20) + "px)");
  this.nameLabelEl.textContent = layer.getName();
  this.lockIconEl = makeElement("div", "lock");
  this.effectsArrowEl = makeElement("div", "lrfx");
  this.expandEffectsBtn = makeElement("div", "arfx");
  const onContextMenuBound = this.onRowContextMenu.bind(this),
    onRowClickBound = this.onRowClick.bind(this);
  this.headerEl.addEventListener("click", onRowClickBound, false);
  this.headerEl.addEventListener("contextmenu", onContextMenuBound, false);
  const layerColorPalette = [0, 16711680, 16748544, 16763904, 4513024, 22015, 11141375, 7829367];
  let labelColorArgb = layer.add.lclr == null ? 0 : layerColorPalette[layer.add.lclr];
  if (labelColorArgb == 0) labelColorArgb = options.colorIntArgb;
  const labelBgRgb = [labelColorArgb >> 16, labelColorArgb >> 8 & 255, labelColorArgb & 255];
  for (let channelIdx = 0; channelIdx < 3; channelIdx++) {
    labelBgRgb[channelIdx] = Math.round(.5 * labelBgRgb[channelIdx] + .5 * 220)
  }
  if (1 < getDevicePixelRatio() && getDevicePixelRatio() < 1.5) eyeIconSizePx = eyeIconSizePx / getDevicePixelRatio();
  visibilityWrapEl.setAttribute("style", "background-color:rgba(" + labelBgRgb.join(",") + "," + (labelColorArgb == 0 ? 0 : 1) + ");");
  this.visibilityEyeEl.setAttribute("style", "background-size: " + eyeIconSizePx + "px " + eyeIconSizePx + "px;");
  this.visibilityEyeEl.style.opacity = layer.isVisible() ? 1 : 0.25;
  const onVisibilityEyeBound = this.onVisibilityEyeEvent.bind(this);
  visibilityWrapEl.addEventListener("mousedown", onVisibilityEyeBound, false);
  visibilityWrapEl.addEventListener("mouseover", onVisibilityEyeBound, false);
  this.nameLabelEl.addEventListener("pointerup", this.onLayerNamePointerUp.bind(this), false);
  this.expandEffectsBtn.addEventListener("click", this.onToggleEffectsExpand.bind(this), false);
  leftSlotEls[0] = visibilityWrapEl;
  leftSlotEls[1] = depthSpacerEl;
  leftSlotEls[10] = this.nameLabelEl;

  const row = this;
  function mountThumbCanvas(thumbWrapEl, thumbCanvasHost, enableDrag) {
    const canvasEl = thumbCanvasHost.canvas;
    canvasEl.setAttribute("draggable", "false");
    if (enableDrag) {
      thumbWrapEl.setAttribute("draggable", "true");
      thumbWrapEl.addEventListener("dragstart", row.onDragStart.bind(row), false)
    }
    thumbWrapEl.appendChild(canvasEl);
    canvasEl.setAttribute("style", canvasEl.getAttribute("style") + "; pointer-events:none;-webkit-user-drag:none")
  }
  if (layer.isGroup()) {
    const folderArrowEl = makeElement("div", "arrow"),
      folderIconEl = makeElement("div", "folder");
    folderArrowEl.addEventListener("click", this.onGroupFolderToggle.bind(this), false);
    leftSlotEls[2] = folderArrowEl;
    leftSlotEls[3] = folderIconEl;
    if (layer.add.lsct == LayerSectionType.OpenGroup) {
      for (let childIdx = sectionNode.children.length - 1; childIdx >= 0; childIdx--) {
        const childRow = new LayerGroupItem(sectionNode.children[childIdx], layersPanel, doc, {
          colorIntArgb: labelColorArgb
        });
        this.childRows.push(childRow);
        this.containerEl.appendChild(childRow.el)
      }
      this.el.appendChild(this.containerEl)
    }
    folderArrowEl.setAttribute("class", layer.add.lsct == LayerSectionType.OpenGroup ? "open" : "closed")
  } else {
    this.layerThumbWrap = makeElement("div", "thumb");
    leftSlotEls[5] = this.layerThumbWrap;
    mountThumbCanvas(this.layerThumbWrap, layer.layerCanvas)
  }
  const rasterMask = layer.getMask();
  if (rasterMask) {
    this.maskChainBtn = makeElement("div", "chain");
    this.rasterMaskThumbWrap = makeElement("div", "thumb");
    mountThumbCanvas(this.rasterMaskThumbWrap, sectionNode.layer.rasterMaskCanvas, true);
    this.maskChainBtn.style.opacity = rasterMask.enabled ? 1 : 0;
    this.maskChainBtn.addEventListener("click", this.onRasterMaskLinkClick.bind(this), false)
  }
  const vectorMaskIsFill = layer.hasFillContent() && layer.add.vmsk;
  if (layer.add.vmsk && !vectorMaskIsFill) {
    this.vectorMaskChainBtn = makeElement("div", "chain");
    this.vectorMaskThumbWrap = makeElement("div", "thumb");
    mountThumbCanvas(this.vectorMaskThumbWrap, sectionNode.layer.vectorMaskCanvas, true);
    this.vectorMaskChainBtn.style.opacity = layer.add.vmsk.enabled ? 1 : 0;
    this.vectorMaskChainBtn.addEventListener("click", this.onVectorMaskLinkClick.bind(this), false)
  }
  if (layer.hasSmartFilters() && layer.getLinkedPlacedItem(doc).d) {
    this.smartObjectThumbWrap = makeElement("div", "thumb");
    mountThumbCanvas(this.smartObjectThumbWrap, sectionNode.layer.smartObjectCanvas, false);
    this.smartObjectThumbWrap.addEventListener("click", onRowClickBound, false);
    this.smartObjectThumbWrap.addEventListener("contextmenu", onContextMenuBound, false)
  }
  if (layer.hasLayerEffects() || layer.hasSmartFilters()) {
    if (layer.hasLayerEffects()) this.effectsStackEl = effectsPanelEl;
    effectsPanelEl.addEventListener("contextmenu", onContextMenuBound, false);
  }
  if (layer.hasLayerEffects()) {
    const styleRow = new LayerStyleRow(Locale.get("properties.effects"), "sm", "layerstyle", sectionNode.depth, 0, null);
    styleRow.parent = this;
    effectsPanelEl.appendChild(styleRow.el);
    const layerEffects = layer.add.lmfx,
      effectsEnabled = layerEffects.masterFXSwitch.v;
    styleRow.setVisible(effectsEnabled);
    for (let effectKindIdx = 0; effectKindIdx < LayerEffectDefs.order.length; effectKindIdx++) {
      const effectInstances = layerEffects[LayerEffectDefs.effectKeys[effectKindIdx]].v;
      if (effectInstances.length == 0) continue;
      for (let effectInstIdx = 0; effectInstIdx < effectInstances.length; effectInstIdx++) {
        const styleRow = new LayerStyleRow(Locale.get(LayerEffectDefs.names[effectKindIdx]), "s", "layerstyle", sectionNode.depth, 1, [effectKindIdx, effectInstIdx]);
        styleRow.setVisible(effectsEnabled && effectInstances[effectInstIdx].v.enab.v);
        styleRow.parent = this;
        effectsPanelEl.appendChild(styleRow.el)
      }
    }
  }
  if (layer.hasSmartFilters()) {
    const styleRow = new LayerStyleRow(Locale.get("properties.smartFilters"), "fm", null, sectionNode.depth, 0, -1, layer.getLinkedPlacedItem(doc).d ? this.smartObjectThumbWrap : null);
    styleRow.parent = this;
    effectsPanelEl.appendChild(styleRow.el);
    this.smartFiltersAnchorEl = styleRow.el;
    const filterFx = layer.add.placedData.filterFX.v,
      filterList = filterFx.filterFXList.v,
      filtersEnabled = filterFx.enab.v;
    styleRow.setVisible(filtersEnabled);
    for (let filterIdx = filterList.length - 1; filterIdx >= 0; filterIdx--) {
      const filterEntry = filterList[filterIdx].v;
      let filterClassId = FilterDefs.getFilterClassIdFromFx(filterEntry);
      if (AdjustmentEngine.descriptorKeyMap[filterClassId]) filterClassId = AdjustmentEngine.descriptorKeyMap[filterClassId];
      let filterLabel = filterEntry.Nm.v;
      if (FilterDefs.names[filterClassId]) filterLabel = Locale.get(FilterDefs.names[filterClassId]);
      if (AdjustmentEngine.names[filterClassId]) filterLabel = Locale.get(AdjustmentEngine.names[filterClassId]);
      const filterDialogRoute = "afw_" + filterClassId,
        styleRow = new LayerStyleRow(filterLabel, "f", filterDialogRoute, sectionNode.depth, 1, filterIdx);
      styleRow.setVisible(filtersEnabled && filterEntry.enab.v);
      styleRow.parent = this;
      effectsPanelEl.appendChild(styleRow.el)
    }
  }
  if (doc.layers.indexOf(layer) == doc.selectedLayerIndices[0]) {
    const activePixelKind = layer.pixelContent;
    let activeThumbWrap;
    if (activePixelKind <= 0) activeThumbWrap = this.layerThumbWrap;
    else if (activePixelKind == 1) activeThumbWrap = this.rasterMaskThumbWrap;
    else if (activePixelKind == 3) activeThumbWrap = this.smartObjectThumbWrap;
    if (activeThumbWrap) activeThumbWrap.setAttribute("class", "thumb active");
    if (layer.pathLayerActive && this.vectorMaskThumbWrap) this.vectorMaskThumbWrap.setAttribute("class", "thumb active")
  }
  depthSpacerEl.setAttribute("style", "width:" + Math.max(0, sectionNode.depth - 1) * 18 + "px");
  const showLockIcon = layer.add.lspf != null && layer.add.lspf != 0;
  this.lockIconEl.style.opacity = layer.isLockBitSet(31) ? 1 : 0.5;
  leftSlotEls[4] = layer.isClippingMask ? makeElement("div", "clipp") : null;
  leftSlotEls[6] = rasterMask ? this.maskChainBtn : null;
  leftSlotEls[7] = rasterMask ? this.rasterMaskThumbWrap : null;
  leftSlotEls[8] = layer.add.vmsk && !vectorMaskIsFill ? this.vectorMaskChainBtn : null;
  leftSlotEls[9] = layer.add.vmsk && !vectorMaskIsFill ? this.vectorMaskThumbWrap : null;
  const linkGroupId = layer.groupIndex,
    selectedLayerIndices = doc.selectedLayerIndices;
  if (linkGroupId != 0)
    for (let selIdx = 0; selIdx < selectedLayerIndices.length; selIdx++)
      if (doc.layers[selectedLayerIndices[selIdx]].groupIndex == linkGroupId) {
        hasLinkedLayerInGroup = true;
        break
      } rightSlotEls[0] = hasLinkedLayerInGroup ? makeElement("div", "link") : null;
  rightSlotEls[1] = showLockIcon ? this.lockIconEl : null;
  rightSlotEls[2] = layer.hasLayerEffects() ? this.effectsArrowEl : null;
  rightSlotEls[3] = layer.hasLayerEffects() || layer.hasSmartFilters() ? this.expandEffectsBtn : null;
  this.expandEffectsBtn.setAttribute("class", layer.isEffectsExpanded() ? "arfx open  gsicon" : "arfx closed  gsicon");
  let slotEls = leftSlotEls;
  for (let slotIdx = 0; slotIdx < slotEls.length; slotIdx++)
    if (slotEls[slotIdx]) headerLeftEl.appendChild(slotEls[slotIdx]);
  slotEls = rightSlotEls;
  for (let slotIdx = 0; slotIdx < slotEls.length; slotIdx++)
    if (slotEls[slotIdx]) headerRightEl.appendChild(slotEls[slotIdx])
}
LayerGroupItem.prototype = Object.create(BaseWidget.prototype);
LayerGroupItem.prototype.scrollIndicesIntoView = function(selectedIndices) {
  const layerIndex = this.sectionNode.index;
  if (selectedIndices.indexOf(layerIndex) != -1) {
    if (this.el.scrollIntoView) this.el.scrollIntoView({
      block: "nearest"
    })
  }
  for (let childIdx = 0; childIdx < this.childRows.length; childIdx++) this.childRows[childIdx].scrollIndicesIntoView(selectedIndices)
};
LayerGroupItem.findRowAtPoint = function(clientX, clientY) {
  let el = document.elementFromPoint(clientX, clientY);
  while (el != null) {
    if (el.__layerGroupItemRow) return el.__layerGroupItemRow;
    el = el.parentElement
  }
  return null
};
LayerGroupItem.findRowByLayerIndex = function(panel, layerIndex) {
  if (panel == null || panel.layerTreeRoot == null) return null;
  function walk(row) {
    if (row.sectionNode.index == layerIndex) return row;
    for (let childIdx = 0; childIdx < row.childRows.length; childIdx++) {
      const found = walk(row.childRows[childIdx]);
      if (found != null) return found
    }
    return null
  }
  return walk(panel.layerTreeRoot)
};
LayerGroupItem.clearDropIndicators = function() {
  if (layerPanelDragState.activeDropRow != null) {
    layerPanelDragState.activeDropRow.clearDropIndicator();
    layerPanelDragState.activeDropRow = null
  }
};
LayerGroupItem.prototype.showDropIndicator = function(ratio) {
  const intoGroup = this.sectionNode.layer.isGroup() && .5 < ratio && ratio < .8;
  this.headerEl.style.boxShadow = "inset 0 " + (intoGroup ? 0 : ratio > .5 ? -3 : 3) + "px " + (intoGroup ? "6px" : 0) + " var(--text-color)"
};
LayerGroupItem.prototype.clearDropIndicator = function() {
  this.headerEl.style.boxShadow = ""
};
LayerGroupItem.prototype.isLayerReorderGripTarget = function(target) {
  if (target == null) return false;
  if (target == this.expandEffectsBtn || target == this.maskChainBtn || target == this.vectorMaskChainBtn) return false;
  if (target.tagName && target.tagName.toLowerCase() == "input") return false;
  if (this.visibilityEyeEl && (target == this.visibilityEyeEl || this.visibilityEyeEl.contains(target))) return false;
  if (this.lockIconEl && (target == this.lockIconEl || this.lockIconEl.contains(target))) return false;
  return true
};
LayerGroupItem.prototype.commitLayerReorderAt = function(targetRow, ratio) {
  const doc = this.parent.doc;
  let targetIndex = targetRow.sectionNode.index,
    dropRatio = ratio;
  if (dropRatio > .8) {
    let onlyTop = true,
      node = doc.root.getSectionByIndex(targetIndex);
    while (node.parent != null) {
      const parentNode = node.parent,
        siblings = parentNode.children;
      if (siblings.indexOf(node) != 0) onlyTop = false;
      node = node.parent
    }
    if (onlyTop) {
      targetIndex = 0;
      dropRatio = 1
    }
  }
  this.parent.applyEvent({
    actionKind: Layer.moveLayer,
    source: this.sectionNode.index,
    target: targetIndex,
    dropPositionRatio: dropRatio
  })
};
LayerGroupItem.prototype.onHeaderDragStart = function(evt) {
  if (this.rasterMaskThumbWrap != null && this.rasterMaskThumbWrap.contains(evt.target) || this.vectorMaskThumbWrap != null && this.vectorMaskThumbWrap.contains(evt.target)) {
    this.onDragStart(evt);
    return
  }
  evt.preventDefault();
  evt.stopPropagation()
};
LayerGroupItem.prototype.onRowPointerDown = function(evt) {
  if (evt.button != 0 || !this.isLayerReorderGripTarget(evt.target)) return;
  evt.preventDefault();
  const sourceRow = this,
    startX = evt.clientX,
    startY = evt.clientY;
  let dragActive = false,
    suppressClick = false;
  function onMove(e) {
    if (!dragActive) {
      if (Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) < 4) return;
      dragActive = true;
      suppressClick = true;
      sourceRow.clearDropIndicator();
      layerPanelDragState.pointerDrag = {
        source: sourceRow
      };
      document.body.style.cursor = "move";
      e.preventDefault()
    }
    const targetRow = LayerGroupItem.findRowAtPoint(e.clientX, e.clientY);
    LayerGroupItem.clearDropIndicators();
    if (targetRow != null) {
      const ratio = layerPanelEventYRatioInElement(e, targetRow.headerEl);
      targetRow.showDropIndicator(ratio);
      layerPanelDragState.activeDropRow = targetRow;
      if (layerPanelDragState.pointerDrag) {
        layerPanelDragState.pointerDrag.target = targetRow;
        layerPanelDragState.pointerDrag.dropPositionRatio = ratio
      }
    }
  }
  function onUp(e) {
    document.removeEventListener("mousemove", onMove, false);
    document.removeEventListener("mouseup", onUp, false);
    document.body.style.cursor = "";
    const drag = layerPanelDragState.pointerDrag;
    layerPanelDragState.pointerDrag = null;
    LayerGroupItem.clearDropIndicators();
    if (dragActive && drag && drag.target) {
      if (drag.target !== sourceRow) sourceRow.commitLayerReorderAt(drag.target, drag.dropPositionRatio);
      else if (drag.dropPositionRatio != null) {
        const neighbor = drag.dropPositionRatio > .5 ? drag.target.sectionNode.index + 1 : drag.target.sectionNode.index - 1;
        if (0 <= neighbor && neighbor < sourceRow.parent.doc.layers.length) {
          const neighborRow = LayerGroupItem.findRowByLayerIndex(sourceRow.parent, neighbor);
          if (neighborRow != null) sourceRow.commitLayerReorderAt(neighborRow, drag.dropPositionRatio > .5 ? 0 : 1)
        }
      }
    }
    if (suppressClick) sourceRow._suppressNextClick = true
  }
  document.addEventListener("mousemove", onMove, false);
  document.addEventListener("mouseup", onUp, false)
};
LayerGroupItem.prototype.onDragStart = function(evt) {
  evt.stopPropagation();
  const dragKind = evt.target == this.rasterMaskThumbWrap ? "m" : evt.target == this.vectorMaskThumbWrap ? "vm" : "l";
  const payload = JSON.stringify({
    kind: dragKind,
    layerIndex: this.sectionNode.index
  });
  evt.dataTransfer.effectAllowed = "move";
  evt.dataTransfer.setData("Text", payload);
  try {
    evt.dataTransfer.setData("text/plain", payload)
  } catch (e) {}
};
LayerGroupItem.prototype.onDragLeave = function(evt) {
  cancel(evt);
  this.clearDropIndicator()
};
LayerGroupItem.prototype.onDrop = function(evt) {
  cancel(evt);
  this.clearDropIndicator();
  const payloadText = readLayerDragPayload(evt.dataTransfer),
    doc = this.parent.doc;
  let dropRatio = layerPanelEventYRatioInElement(evt, this.headerEl),
    targetIndex = this.sectionNode.index;
  if (dropRatio > .8) {
    let onlyTopLevel = true,
      sectionNode = doc.root.getSectionByIndex(targetIndex);
    while (sectionNode.parent != null) {
      const parentNode = sectionNode.parent,
        siblings = parentNode.children;
      if (siblings.indexOf(sectionNode) != 0) onlyTopLevel = false;
      sectionNode = sectionNode.parent
    }
    if (onlyTopLevel) {
      targetIndex = 0;
      dropRatio = 1
    }
  }
  if (payloadText == "") {
    dispatchDataTransferImports(evt, this, this.parent.openDocs.indexOf(doc), targetIndex + (dropRatio > .5 ? 0 : 1))
  } else if (payloadText != "--panel") {
    const payload = JSON.parse(payloadText),
      dragKind = payload.kind;
    if (dragKind == "l") this.parent.applyEvent({
      actionKind: Layer.moveLayer,
      source: payload.layerIndex,
      target: targetIndex,
      dropPositionRatio: dropRatio
    });
    else if (dragKind == "m" || dragKind == "vm") this.applyEvent({
      actionKind: dragKind == "m" ? Layer.copyRasterMask : Layer.moveVectorMask,
      sourceLayerIndex: payload.layerIndex,
      destinationLayerIndex: targetIndex,
      keepSourceOnCopy: evt.altKey
    });
    else dispatchLayerStyleDragReorder(evt, payload, this)
  }
};
LayerGroupItem.prototype.onDragOver = function(evt) {
  cancel(evt);
  LayerGroupItem.clearDropIndicators();
  const dropRatio = layerPanelEventYRatioInElement(evt, this.headerEl);
  this.showDropIndicator(dropRatio);
  layerPanelDragState.activeDropRow = this
};
LayerGroupItem.lastEyeToggleLayerIndex = -1;
LayerGroupItem.visibilityPointerDown = false;
LayerGroupItem.endVisibilityPointer = function(evt) {
  LayerGroupItem.visibilityPointerDown = false;
  document.body.removeEventListener("mouseup", LayerGroupItem.endVisibilityPointer)
};
LayerGroupItem.prototype.onVisibilityEyeEvent = function(evt) {
  if (evt.button != 0) return;
  if (evt.type == "mousedown") {
    LayerGroupItem.visibilityPointerDown = true;
    document.body.addEventListener("mouseup", LayerGroupItem.endVisibilityPointer, false)
  }
  if (evt.type == "mouseover" && (!LayerGroupItem.visibilityPointerDown || LayerGroupItem.lastEyeToggleLayerIndex == this.sectionNode.index)) return;
  cancel(evt);
  this.applyEvent({
    actionKind: Layer.toggleVisibility,
    layerIndex: this.sectionNode.index
  });
  LayerGroupItem.lastEyeToggleLayerIndex = this.sectionNode.index
};
LayerGroupItem.prototype.onGroupFolderToggle = function(evt) {
  cancel(evt);
  this.applyEvent({
    actionKind: Layer.toggleGroupExpanded,
    layerIndex: this.sectionNode.index
  })
};
LayerGroupItem.prototype.onRasterMaskLinkClick = function(evt) {
  this.applyEvent({
    actionKind: Layer.toggleRasterMaskEnabled,
    layerIndex: this.sectionNode.index
  })
};
LayerGroupItem.prototype.onVectorMaskLinkClick = function(evt) {
  this.applyEvent({
    actionKind: Layer.toggleVectorMaskEnabled,
    layerIndex: this.sectionNode.index
  })
};
LayerGroupItem.lastNamePointerTime = 0;
LayerGroupItem.prototype.onLayerNamePointerUp = function(evt) {
  const lastPointerTime = LayerGroupItem.lastNamePointerTime;
  LayerGroupItem.lastNamePointerTime = Date.now();
  if (Date.now() - lastPointerTime > 300) return;
  evt.preventDefault();
  evt.stopPropagation();
  this.headerEl.setAttribute("draggable", "false");
  const row = this;
  new BaseTool.InlineRenameInput(this.nameLabelEl, function(newName) {
    row.applyLayerRename(newName)
  }, function() {
    row.headerEl.setAttribute("draggable", "false")
  })
};
LayerGroupItem.prototype.applyLayerRename = function(newName) {
  this.applyEvent({
    actionKind: Layer.renameLayer,
    layerIndex: this.sectionNode.index,
    name: newName
  })
};
LayerGroupItem.prototype.onToggleEffectsExpand = function(evt) {
  this.applyEvent({
    actionKind: Layer.toggleEffectsExpanded,
    layerIndex: this.sectionNode.index
  })
};
LayerGroupItem.prototype.onRowContextMenu = function(evt) {
  if (this.dispatchSelectPixelsFromLayerModifiers(evt, evt.target, this.pixelContent(evt))) return;
  const touchDerived = evt.sourceCapabilities && evt.sourceCapabilities.firesTouchEvents;
  if (evt.type !== "contextmenu" && evt.button != 2 && !touchDerived) return;
  cancel(evt);
  let pixelKind = this.pixelContent(evt);
  if (pixelKind != 3 && evt.currentTarget == this.smartFiltersAnchorEl) pixelKind = 4;
  if (evt.target == this.effectsArrowEl || evt.currentTarget == this.effectsStackEl) pixelKind = 5;
  const rclickEvt = new AppEvent("rclick", true);
  rclickEvt.data = {
    layerIndex: this.sectionNode.index,
    pixelContent: pixelKind,
    contextMenuPointer: getEventPos(evt, document.body)
  };
  this.dispatch(rclickEvt)
};
LayerGroupItem.prototype.handleStyleItemContextMenu = function(evt, styleRow) {
  if (this.dispatchSelectPixelsFromLayerModifiers(evt, evt.target, -1)) return;
  const touchDerived = evt.sourceCapabilities && evt.sourceCapabilities.firesTouchEvents;
  if (evt.type !== "contextmenu" && evt.button != 2 && !touchDerived) return;
  cancel(evt);
  evt.stopPropagation();
  let pixelContent = 5;
  if (styleRow.dragKind === "fm") pixelContent = 4;
  else if (styleRow.dragKind === "f") pixelContent = 6;
  else if (styleRow.dragKind === "sm") pixelContent = 7;
  else if (styleRow.dragKind === "s") pixelContent = 8;
  const rclickEvt = new AppEvent("rclick", true);
  rclickEvt.data = {
    layerIndex: this.sectionNode.index,
    pixelContent: pixelContent,
    styleIndex: styleRow.index,
    contextMenuPointer: getEventPos(evt, document.body)
  };
  this.dispatch(rclickEvt)
};
LayerGroupItem.prototype.pixelContent = function(evt) {
  const clickTarget = evt.target;
  return clickTarget == this.vectorMaskThumbWrap ? 2 : clickTarget == this.rasterMaskThumbWrap ? 1 : clickTarget == this.layerThumbWrap ? 0 : clickTarget == this.smartObjectThumbWrap ? 3 : -1
};
LayerGroupItem.prototype.onRowClick = function(clickEvent) {
  const clickTarget = clickEvent.target;
  let maskViewMode;
  if (this._suppressNextClick) {
    this._suppressNextClick = false;
    return
  }
  if (clickTarget == this.expandEffectsBtn || clickTarget == this.maskChainBtn || clickTarget == this.vectorMaskChainBtn || clickTarget.tagName && clickTarget.tagName.toLowerCase() == "input") return;
  const pixelContent = this.pixelContent(clickEvent),
    doc = this.parent.doc,
    layerIndex = this.sectionNode.index,
    layer = doc.layers[layerIndex];
  if (clickTarget == this.visibilityEyeEl) {
    cancel(clickEvent);
    const willShow = !layer.isVisible();
    this.applyEvent({
      actionKind: Layer.toggleVisibility,
      layerIndex: layerIndex
    });
    this.visibilityEyeEl.style.opacity = willShow ? 1 : 0.25;
    return
  }
  if (clickTarget == this.lockIconEl) {
    this.applyEvent({
      actionKind: Layer.toggleLayerLocks,
      layerIndex: layerIndex,
      layerPropertyValue: [
        [false, false, false, false, false],
        [0, 1, 2, 3, 31]
      ]
    });
    return
  }
  if (clickEvent.button == 0 && clickEvent.detail == 2) {
    if (clickTarget == this.nameLabelEl) return;
    const docActionEvt = new AppEvent(EventType.documentAction, true),
      uiDispatchEvt = new AppEvent(EventType.uiDispatch, true),
      historyGroupedEvt = new AppEvent(EventType.historyGrouped, true);
    if (pixelContent == 0 && layer.add.SoCo) {
      const fillRgb = psdColorToRgb(layer.add.SoCo.Clr.v);
      uiDispatchEvt.data = {
        dispatchKind: UiCommand.dispatchAppDialogRouter,
        dialogRouteId: "colorpicker",
        colorIntArgb: fillRgb.h << 16 | fillRgb.l << 8 | fillRgb.O,
        onDialogResult: function(packedRgb) {
          let colorDesc = toRGBDesc({
            O: packedRgb & 255,
            l: packedRgb >>> 8 & 255,
            h: packedRgb >> 16 & 255
          });
          colorDesc = {
            classID: "null",
            Clr: {
              t: "Objc",
              v: colorDesc
            }
          };
          const fillChangeEvt = new AppEvent(EventType.documentAction, true);
          fillChangeEvt.routingChannel = EventChannel.EVENT_DOCUMENT;
          fillChangeEvt.data = {
            actionKind: Layer.updateContentStyle,
            contentLayerIndices: [layerIndex],
            updateContentFill: true,
            contentStylePayload: {
              fillKind: 1,
              fillDescriptor: colorDesc
            }
          };
          this.dispatch(fillChangeEvt)
        }.bind(this),
        allowContinuousMirrorUpdates: true
      }
    } else if (pixelContent == 0 && (adjustmentKeyOf(layer.add) || layer.add.SoCo || layer.add.GdFl || layer.add.PtFl)) uiDispatchEvt.data = {
      dispatchKind: UiCommand.registerFontFaceFromUrlParam,
      dialogRouteId: BaseTool.PanelId.PROPERTIES
    };
    else if (pixelContent != 0 && pixelContent != -1) uiDispatchEvt.data = {
      dispatchKind: UiCommand.registerFontFaceFromUrlParam,
      dialogRouteId: BaseTool.PanelId.PROPERTIES
    };
    else if (pixelContent == 0 && layer.add.placedData) historyGroupedEvt.data = {
      uf: "placedLayerEditContents",
      actionDescriptor: {
        classID: "placedLayerEditContents"
      }
    };
    else if (pixelContent == 0 && layer.add.TySh) {
      docActionEvt.routingChannel = ToolId.TOOL_TYPE;
      docActionEvt.data = {
        actionKind: "editCurr",
        targetLayerIndex: layerIndex
      }
    } else uiDispatchEvt.data = {
      dispatchKind: UiCommand.dispatchAppDialogRouter,
      dialogRouteId: "layerstyle",
      layerIndex: layerIndex
    };
    this.dispatch(historyGroupedEvt.data ? historyGroupedEvt : uiDispatchEvt.data ? uiDispatchEvt : docActionEvt);
    return
  }
  if (this.dispatchSelectPixelsFromLayerModifiers(clickEvent, clickTarget, pixelContent)) return;
  if (clickEvent.button != 0) return;
  if (pixelContent == 1 || pixelContent == 3) {
    const activeMask = pixelContent == 3 ? layer.getLinkedPlacedItem(doc).d : layer.getMask();
    maskViewMode = activeMask.active ? doc.pathViewport.channelVisibility.join("") == "111" ? 1 : 2 : 0
  }
  const selectLayerEvent = {
    actionKind: Layer.selectLayer,
    layerIndex: layerIndex,
    pixelContentKind: pixelContent
  };
  this.applyEvent(selectLayerEvent);
  if (clickEvent.altKey) {
    if (pixelContent == 1 || pixelContent == 3) {
      const maskViewEvt = new AppEvent(EventType.documentAction, true);
      maskViewEvt.routingChannel = ToolId.TOOL_ZOOM;
      maskViewEvt.data = {
        actionKind: "mskView",
        maskViewMode: maskViewMode != 0 ? 0 : clickEvent.shiftKey ? 1 : 2
      };
      this.dispatch(maskViewEvt)
    } else {
      this.applyEvent({
        actionKind: Layer.toggleClippingMask,
        layerIndex: layerIndex
      })
    }
    return
  }
};
LayerGroupItem.prototype.dispatchSelectPixelsFromLayerModifiers = function(evt, target, pixelKind) {
  if ((evt.ctrlKey || evt.metaKey) && (pixelKind == 0 || pixelKind == 1 || pixelKind == 2)) {
    let modifierMode = 0;
    if (evt.shiftKey) modifierMode++;
    if (evt.altKey) modifierMode += 2;
    const selectEvt = new AppEvent(EventType.documentAction, true);
    selectEvt.routingChannel = ToolId.TOOL_RECT_SELECT;
    selectEvt.data = {
      actionKind: "fromlayer",
      selectionSource: [this.sectionNode.index, pixelKind, modifierMode]
    };
    this.dispatch(selectEvt);
    return true
  }
  return false
};
LayerGroupItem.prototype.applyEvent = function(eventData) {
  const docEvt = new AppEvent(EventType.documentAction, true);
  docEvt.data = eventData;
  docEvt.routingChannel = EventChannel.EVENT_DOCUMENT;
  this.dispatch(docEvt)
};
export { LayerGroupItem };
