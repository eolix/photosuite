/**
 * Channels panel: RGB / layer-mask / extra-channel list with visibility and
 * selection footer actions.
 */

import { Rect } from "../../core/math/rect.js";
import { ToolId, EventChannel } from "../../document/model/tool-base.js";
import { AdjustmentEngine } from "../../features/adjustments/adjustment-engine.js";
import { ActionDescUtil } from "../../features/scripting/action-desc.js";
import { Layer } from "../../document/model/layer.js";
import { InputHandler } from "../tool-options/input-handler.js";
import { BaseTool } from "../widgets/base-tool.js";
import { LayerListItem } from "../widgets/layer-list-item.js";
import { Button } from "../widgets/form-controls.js";
import { LayerThumbnails } from "../../document/layer-thumbnails.js";
import { getIconUrl, iconImgHtml } from "../../assets/icon-registry.js";
import { EventType, UiCommand } from "../../core/event-bus.js";
import { addPointerDownListener, cancel, clearElement, isInDOM, makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";

/** Footer button indices after the lead "selection" control. */
const FOOTER_SAVE_SELECTION = 0;
const FOOTER_NEW_CHANNEL = 1;

/**
 * Sidebar panel listing the document channels (RGB, layer masks, filter
 * masks, extra channels). The visibility eye toggles mask.active (or RGB
 * channelVisibility via setcls). Row clicks choose which channels
 * participate in rendering. Footer buttons: channel from selection, save
 * selection as channel, duplicate, delete.
 */
function ChannelsPanel() {
  BaseTool.call(this, "properties.channels", false, getIconUrl("panels/channels"), BaseTool.PanelId.CHANNELS, true);
  this.channelMask = null;
  this.activeDoc = null;
  this.containerEl = makeElement("div", "lpbody scrollable");
  this.footerEl = makeElement("div", "lpfoot");
  this.panelBody.appendChild(this.containerEl);
  this.panelBody.appendChild(this.footerEl);
  this.thumbContexts = [];
  this.on("click", this.onLayerClick, this);
  this.footerBtns = [];
  ChannelsPanel.buildFooterButtons([
    "sampleScope.selection", "Save Selection as Channel", "clipboard.new",
    "clipboard.delete"
  ], this.footerBtns, this.footerEl, this.onFooterPointerDown.bind(this), this.onFooterDrop.bind(this));
  this.editorMenu = new InputHandler([{
    name: "Merge Channels",
    opensDialog: true
  }]);
  this.editorMenu.on("select", this.onMergeChannels, this)
}
ChannelsPanel.prototype = Object.create(BaseTool.prototype);

ChannelsPanel.prototype.onMergeChannels = function(evt) {
  if (this.activeDoc == null) return;
  const dispatchEvt = new AppEvent(EventType.uiDispatch, true);
  dispatchEvt.data = {
    dispatchKind: UiCommand.dispatchAppDialogRouter,
    dialogRouteId: "mergechannels"
  };
  this.dispatch(dispatchEvt)
};

ChannelsPanel.prototype.getEditorMode = function() {
  return this.editorMenu
};

/**
 * Shared helper: append a labelled icon button per titles[i] to host,
 * wire pointer-down and drop handlers, and collect the buttons in bucket.
 * Used by ChannelsPanel, PathsPanel, and the filter-stack panel.
 */
ChannelsPanel.buildFooterButtons = function(titles, bucket, host, onPointerDown, onDrop) {
  for (let i = 0; i < titles.length; i++) {
    const btn = new Button("W", false, titles[i]);
    bucket.push(btn);
    addPointerDownListener(btn.el, onPointerDown);
    host.appendChild(btn.el);
    const btnEl = btn.el;
    btnEl.addEventListener("drop", onDrop, false);
    btnEl.addEventListener("dragover", function(evt) {
      evt.preventDefault()
    }, false);
    btnEl.addEventListener("dragenter", cancel, false)
  }
};

/** Locate the button whose element is evt.currentTarget. */
ChannelsPanel.indexOfButton = function(buttons, evt) {
  for (let i = 0; i < buttons.length; i++)
    if (buttons[i].el == evt.currentTarget) return i
};

/** Swap each footer button label for an htmlPackagedIconImg(...). */
ChannelsPanel.applyFooterIcons = function(buttons, iconKeys) {
  for (let i = 0; i < buttons.length; i++) {
    buttons[i].setLabel(iconImgHtml(iconKeys[i]))
  }
};

ChannelsPanel.prototype.onFooterPointerDown = function(evt) {
  const btnIndex = ChannelsPanel.indexOfButton(this.footerBtns, evt);
  if (btnIndex == 0) {
    this.dispatch(LayerListItem.buildSelectionEvent(true, null, evt));
    return
  }
  const actionIndex = btnIndex - 1;
  const actionEvt = new AppEvent(EventType.historyGrouped, true);
  actionEvt.data = {
    uf: ["duplicate", "make", "delete"][actionIndex],
    actionDescriptor: buildFooterChannelDescriptor(actionIndex)
  };
  this.dispatch(actionEvt)
};

ChannelsPanel.prototype.onFooterDrop = function(evt) {
  const btnIndex = ChannelsPanel.indexOfButton(this.footerBtns, evt);
  if (btnIndex == 2) {
    const actionEvt = new AppEvent(EventType.historyGrouped, true),
      payload = {
        classID: "null"
      };
    payload.null = ActionDescUtil.buildTargetRef("Chnl", true);
    actionEvt.data = {
      uf: "duplicate",
      actionDescriptor: payload
    };
    this.dispatch(actionEvt)
  } else this.onFooterPointerDown(evt)
};

ChannelsPanel.prototype.getThumbCtx = function(index) {
  const ctxs = this.thumbContexts;
  let ctx = ctxs[index];
  if (ctx == null) {
    const canvas = makeElement("canvas");
    ctx = canvas.getContext("2d");
    ctxs.push(ctx)
  }
  return ctx
};

ChannelsPanel.prototype.onLayerClick = function(evt) {
  const idx = evt.data.idx,
    eyeClick = evt.data.isVisibilityEyeClick,
    doc = this.activeDoc;
  if (-5 < idx && idx < 0) {
    applyRgbChannelClick(this, doc, idx, eyeClick);
    return
  }
  if (-1 < idx) applyLayerMaskChannelClick(doc, idx, eyeClick);
  else applyExtraChannelClick(doc, idx, eyeClick);
  doc.dirty = doc.panelsDirty = true
};

ChannelsPanel.prototype.refresh = function() {
  this.rebuild()
};

ChannelsPanel.prototype.open = function(doc) {
  this.activeDoc = doc;
  this.rebuild()
};

ChannelsPanel.prototype.rebuild = function() {
  const doc = this.activeDoc,
    container = this.containerEl;
  clearElement(container);
  if (doc == null || !isInDOM(container)) return;
  const thumbSize = computeChannelThumbSize(doc.width, doc.height),
    channelMask = this.channelMask = doc.pathViewport.channelVisibility.slice(0);
  let nextThumbIdx = 4;
  appendRgbChannelRows(this, doc, container, thumbSize, channelMask);
  nextThumbIdx = appendLayerMaskRows(this, doc, container, thumbSize, nextThumbIdx);
  appendExtraChannelRows(this, doc, container, thumbSize, nextThumbIdx)
};

ChannelsPanel.prototype.resize = function(width, height) {
  this.containerEl.style.height = height - 9 - 25 + "px"
};

ChannelsPanel.prototype.buildUI = function() {
  BaseTool.prototype.buildUI.call(this);
  this.rebuild();
  ChannelsPanel.applyFooterIcons(this.footerBtns, ["lrs/makesel", "lrs/mask", "lrs/newlayer", "lrs/bin"])
};

export { ChannelsPanel };

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function buildFooterChannelDescriptor(actionIndex) {
  const payload = {
    classID: "null"
  };
  if (actionIndex == FOOTER_SAVE_SELECTION) {
    payload.null = {
      t: "obj ",
      v: [{
        t: "prop",
        v: {
          classID: "Chnl",
          keyID: "fsel"
        }
      }]
    }
  } else if (actionIndex == FOOTER_NEW_CHANNEL) {
    payload.Nw = {
      t: "Objc",
      v: {
        classID: "Chnl",
        ClrI: {
          t: "enum",
          v: {
            MskI: "SlcA"
          }
        },
        Opct: {
          t: "long",
          v: 50
        }
      }
    }
  } else {
    payload.null = ActionDescUtil.buildTargetRef("Chnl", true)
  }
  return payload
}

function applyRgbChannelClick(panel, doc, idx, eyeClick) {
  let maskCopy = panel.channelMask.slice(0);
  const sumRGB = maskCopy[0] + maskCopy[1] + maskCopy[2],
    rgbChannelIdx = -idx - 1;
  if (eyeClick) {
    if (rgbChannelIdx == 0) maskCopy = sumRGB == 3 ? [0, 0, 0] : [1, 1, 1];
    else {
      if (maskCopy[rgbChannelIdx - 1] == 0) maskCopy[rgbChannelIdx - 1] = 1;
      else maskCopy[rgbChannelIdx - 1] = 0
    }
  } else {
    if (rgbChannelIdx == 0) maskCopy = [1, 1, 1];
    else {
      maskCopy = [0, 0, 0];
      maskCopy[rgbChannelIdx - 1] = 1
    }
    doc.activeChannels = []
  }
  const dispatchEvt = new AppEvent(EventType.documentAction, true);
  dispatchEvt.routingChannel = ToolId.TOOL_HAND;
  dispatchEvt.data = {
    actionKind: "setcls",
    channelVisibility: maskCopy
  };
  panel.dispatch(dispatchEvt)
}

function resolveLayerMaskChannel(layer, doc) {
  return layer.pixelContent == 1 ? layer.getMask() : layer.getLinkedPlacedItem(doc).d
}

function applyLayerMaskChannelClick(doc, idx, eyeClick) {
  const layer = doc.layers[idx],
    maskCh = resolveLayerMaskChannel(layer, doc);
  if (eyeClick) maskCh.active = !maskCh.active;
  else {
    for (let i = 0; i < doc.extraChannels.length; i++) doc.extraChannels[i].active = false;
    doc.activeChannels = []
  }
}

function applyExtraChannelClick(doc, idx, eyeClick) {
  const extraIdx = -idx - 5,
    extraCh = doc.extraChannels[extraIdx];
  if (eyeClick) extraCh.active = !extraCh.active;
  else {
    for (let i = 0; i < doc.extraChannels.length; i++) doc.extraChannels[i].active = false;
    extraCh.active = true;
    doc.activeChannels = [extraIdx]
  }
}

function computeChannelThumbSize(docW, docH) {
  let thumbW = 34,
    thumbH = 34;
  if (docW > docH) thumbH = Math.round(thumbH * docH / docW);
  else thumbW = Math.round(thumbW * docW / docH);
  return {
    thumbW: thumbW,
    thumbH: thumbH,
    docRect: new Rect(0, 0, docW, docH)
  }
}

function appendRgbChannelRows(panel, doc, container, thumbSize, channelMask) {
  const sumRGB = channelMask[0] + channelMask[1] + channelMask[2],
    channelLabels = ["RGB"].concat(AdjustmentEngine.rgbColorLabels),
    thumbW = thumbSize.thumbW,
    thumbH = thumbSize.thumbH,
    docRect = thumbSize.docRect;
  for (let i = 0; i < 4; i++) {
    const thumbCtx = panel.getThumbCtx(i);
    LayerThumbnails.drawRasterThumbnail(thumbCtx, thumbW, thumbH, docRect, doc.getRasterData(), docRect, false, i == 0 ? null : i - 1);
    const isOn = i == 0 ? sumRGB == 3 : channelMask[i - 1] == 1,
      item = new LayerListItem(-1 - i, true, true, thumbCtx, channelLabels[i], isOn, isOn);
    item.parent = panel;
    container.appendChild(item.el)
  }
}

function appendLayerMaskRows(panel, doc, container, thumbSize, nextThumbIdx) {
  const thumbW = thumbSize.thumbW,
    thumbH = thumbSize.thumbH,
    docRect = thumbSize.docRect;
  for (let i = 0; i < doc.selectedLayerIndices.length; i++) {
    const layer = doc.layers[doc.selectedLayerIndices[i]],
      pixelKind = layer.pixelContent;
    if (pixelKind != 1 && pixelKind != 3) continue;
    const maskCh = resolveLayerMaskChannel(layer, doc),
      thumbCtx = panel.getThumbCtx(nextThumbIdx + i);
    nextThumbIdx++;
    LayerThumbnails.drawMaskChannelThumbnail(thumbCtx, thumbW, thumbH, docRect, maskCh);
    const item = new LayerListItem(doc.selectedLayerIndices[i], true, true, thumbCtx, layer.getName() + (pixelKind == 1 ? "" : " Filter") + " Mask", true, maskCh.active);
    item.parent = panel;
    container.appendChild(item.el)
  }
  return nextThumbIdx
}

function appendExtraChannelRows(panel, doc, container, thumbSize, nextThumbIdx) {
  const thumbW = thumbSize.thumbW,
    thumbH = thumbSize.thumbH,
    docRect = thumbSize.docRect;
  for (let i = 0; i < doc.extraChannels.length; i++) {
    const extraCh = doc.extraChannels[i],
      thumbCtx = panel.getThumbCtx(nextThumbIdx + i);
    LayerThumbnails.drawMaskChannelThumbnail(thumbCtx, thumbW, thumbH, docRect, extraCh);
    const item = new LayerListItem(-5 - i, true, extraCh.name == "Quick Mask", thumbCtx, extraCh.name, doc.activeChannels.indexOf(i) != -1, extraCh.active, EventChannel.EVENT_DOCUMENT, {
      actionKind: Layer.extraChannelOp,
      operation: "rnm",
      idx: i
    });
    item.parent = panel;
    container.appendChild(item.el)
  }
}
