/**
 * Guides panel: margin / column / row controls that dispatch vertical and
 * horizontal guide lists to the document (actionKind "gids").
 *
 * Ten SliderDropdowns cover paired H/V fields, then Add/Clear buttons and six
 * single-guide presets (centre and edges on each axis).
 */

import { Rect } from "../../core/math/rect.js";
import { ToolId } from "../../document/model/tool-base.js";
import { BaseTool } from "../widgets/base-tool.js";
import { SliderDropdown } from "../widgets/controls/number-inputs.js";
import { Button } from "../widgets/form-controls.js";
import { getIconUrl } from "../../assets/icon-registry.js";
import { EventType } from "../../core/event-bus.js";
import { makeElement } from "../../core/dom.js";
import { AppEvent } from "../../core/event-bus.js";
import { MoveTool } from "../../document/tools/move-tools.js";

/** Field labels for the ten guide inputs (comma-split once at construct). */
const GUIDE_FIELD_LABELS = "Margin Left,Margin Top,Margin Right,Margin Bottom,Column Count,Row Count,Column Width,Row Height,Column Gap,Row Gap";

function GuidesPanel() {
  BaseTool.call(this, "panels.guides", false, getIconUrl("panels/guides"), BaseTool.PanelId.GUIDES, true);
  this.activeDoc = null;
  this.guideInputs = [];
  this.items = [];
  const form = makeElement("div", "form padded");
  form.setAttribute("style", "width:200px");
  this.panelBody.appendChild(form);
  const iconCanvas = makeElement("canvas"),
    ctx = iconCanvas.getContext("2d");
  iconCanvas.width = iconCanvas.height = 160;
  installGuideFieldInputs(this, form, iconCanvas, ctx);
  installGuideActionButtons(this, form);
  installGuidePresetButtons(this, form, iconCanvas, ctx)
}
GuidesPanel.prototype = Object.create(BaseTool.prototype);

GuidesPanel.prototype.onInputChange = function(evt) {
  clearConflictingAxisField(this.guideInputs, this.guideInputs.indexOf(evt.target))
};

GuidesPanel.prototype.onItemClick = function(evt) {
  const doc = this.activeDoc,
    itemIndex = this.items.indexOf(evt.target);
  let guides = [
    [],
    []
  ];
  if (doc == null) return;
  const selOrDocRect = doc.selectionMask ? doc.selectionMask.rect : new Rect(0, 0, doc.width, doc.height),
    selW = selOrDocRect.width,
    selH = selOrDocRect.height;
  if (itemIndex == 0) {
    guides = buildDistributedGuidesFromInputs(this.guideInputs, selOrDocRect, selW, selH);
    MoveTool.mergeLayerIndexLists(guides, doc.guides)
  } else if (itemIndex == 1) {} else {
    guides = buildPresetGuides(itemIndex - 2, selOrDocRect, selW, selH);
    MoveTool.mergeLayerIndexLists(guides, doc.guides)
  }
  const sortAsc = function(a, b) {
    return a - b
  };
  guides[0].sort(sortAsc);
  guides[1].sort(sortAsc);
  this.dispatchGuidesUpdate(guides)
};

GuidesPanel.prototype.dispatchGuidesUpdate = function(guides) {
  const evt = new AppEvent(EventType.documentAction, true);
  evt.routingChannel = ToolId.TOOL_MOVE;
  evt.data = {
    actionKind: "gids",
    guidesAfter: guides
  };
  this.dispatch(evt)
};

/**
 * Spread evenly distributed guides along one axis, given the axis settings
 * [marginA, marginB, count, size, gap] and the start/end of the segment.
 */
GuidesPanel.distributeGuides = function(settings, start, end) {
  const result = [],
    size = settings[3];
  let count = settings[2],
    gap = settings[4],
    zeroCount = 0;
  if (count == 0) zeroCount++;
  if (size == 0) zeroCount++;
  if (gap == 0) zeroCount++;
  if (zeroCount > 1 && count == 0 && size == 0) {
    if (settings[0] != 0) result.push(start + settings[0]);
    if (settings[1] != 0) result.push(end - settings[1]);
    return result
  }
  const inner = end - start - settings[0] - settings[1];
  if (count == 0) {
    if (gap == 0) {
      count = Math.floor(inner / size);
      gap = (inner - count * size) / (count - 1)
    } else {
      count = 1;
      while (size * count + gap * (count - 1) + size + gap <= inner) count++
    }
  } else if (count != 0 && size != 0) {
    if (count * size > inner) count = Math.floor(inner / size);
    gap = (inner - count * size) / (count - 1)
  }
  result.push(start + settings[0], end - settings[1]);
  const stride = (inner - gap * (count - 1)) / count;
  for (let i = 1; i < count; i++) {
    if (gap == 0) result.push(start + settings[0] + i * stride);
    else result.push(start + settings[0] + i * stride + (i - 1) * gap, start + settings[0] + i * stride + i * gap)
  }
  return result
};

GuidesPanel.prototype.open = function(doc) {
  this.activeDoc = doc
};

export { GuidesPanel };

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function installGuideFieldInputs(panel, form, iconCanvas, ctx) {
  const marginGeom = [32, 0, 16, 160, 0, 32, 160, 16, 0, 112, 160, 16],
    labels = GUIDE_FIELD_LABELS.split(","),
    initialValues = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 10; i++) {
    paintGuideFieldIcon(ctx, i, marginGeom);
    const iconHtml = "<img src=\"" + iconCanvas.toDataURL() + "\" class=\"autoscale gsicon\" /> ",
      input = new SliderDropdown(iconHtml, 0, 200, i == 4 || i == 5 ? null : "px", null, null, null, 4, labels[i]);
    input.parent = panel;
    input.on(EventType.widgetSelect, panel.onInputChange, panel);
    input.setValue(initialValues[i]);
    input.buildUI();
    panel.guideInputs.push(input);
    form.appendChild(input.el)
  }
}

function paintGuideFieldIcon(ctx, fieldIndex, marginGeom) {
  ctx.clearRect(0, 0, 160, 160);
  ctx.setTransform(1, 0, 0, 1, 80, 80);
  ctx.rotate((fieldIndex & 3) * Math.PI / 2);
  ctx.translate(-80, -80);
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  if (fieldIndex < 4) paintMarginIcon(ctx, marginGeom);
  else if (fieldIndex < 6) paintCountIcon(ctx);
  else if (fieldIndex < 8) paintSizeIcon(ctx);
  else paintGapIcon(ctx)
}

function paintMarginIcon(ctx, marginGeom) {
  for (let k = 0; k < 12; k += 4) {
    ctx.fillStyle = k == 0 ? "#000000" : "rgba(0,0,0,0.3)";
    ctx.fillRect(marginGeom[k], marginGeom[k + 1], marginGeom[k + 2], marginGeom[k + 3])
  }
}

function paintCountIcon(ctx) {
  const stripeW = 8 * 6;
  ctx.fillRect(0, 0, stripeW, 160);
  ctx.fillRect(8 * 7, 0, stripeW, 160);
  ctx.fillStyle = "#000000";
  ctx.fillRect(8 * 14, 0, stripeW, 160)
}

function paintSizeIcon(ctx) {
  ctx.fillRect(0, 0, 16, 160);
  ctx.fillRect(160 - 16, 0, 16, 160);
  ctx.fillRect(32, 0, 160 - 64, 160);
  ctx.fillStyle = "#000000";
  ctx.fillRect(32, 80 - 8, 160 - 64, 8 * 1)
}

function paintGapIcon(ctx) {
  ctx.fillRect(0, 0, 8 * 7, 160);
  ctx.fillRect(8 * 13, 0, 160, 160);
  ctx.fillStyle = "#000000";
  ctx.fillRect(8 * 7, 80 - 8, 8 * 6, 8 * 1)
}

function installGuideActionButtons(panel, form) {
  const actionLabels = ["Add Guides", "Clear Guides"];
  for (let i = 0; i < actionLabels.length; i++) {
    const actionBtn = new Button(actionLabels[i], true, null, true);
    panel.items.push(actionBtn);
    actionBtn.on("click", panel.onItemClick, panel);
    form.appendChild(actionBtn.el)
  }
}

function installGuidePresetButtons(panel, form, iconCanvas, ctx) {
  for (let i = 0; i < 6; i++) {
    paintPresetGuideIcon(ctx, i);
    const presetIconHtml = "<img src=\"" + iconCanvas.toDataURL() + "\" class=\"autoscale gsicon\" /> ",
      presetBtn = new Button(presetIconHtml, false, null, false);
    panel.items.push(presetBtn);
    presetBtn.on("click", panel.onItemClick, panel);
    form.appendChild(presetBtn.el)
  }
}

function paintPresetGuideIcon(ctx, presetIndex) {
  ctx.setTransform(1, 0, 0, 1, 80, 80);
  ctx.rotate(Math.floor(presetIndex / 3) * Math.PI / 2);
  ctx.translate(-80, -80);
  ctx.clearRect(0, 0, 160, 160);
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(0, 0, 160, 160);
  ctx.clearRect(16, 16, 128, 128);
  ctx.fillStyle = "#000000";
  const col = presetIndex % 3;
  ctx.fillRect([0, 9, 18][col] * 8, 0, 16, 160)
}

function clearConflictingAxisField(inputs, inputIndex) {
  const fieldIndex = Math.floor(inputIndex / 2),
    axis = inputIndex & 1,
    axisValues = [];
  for (let i = 0; i < 4; i++) axisValues.push(inputs[2 * i + axis].getValue());
  let resetIndex = -1;
  if (fieldIndex == 2 && axisValues[2] != 0 && axisValues[3] != 0 && axisValues[4] != 0) resetIndex = 4;
  if (fieldIndex == 3 && axisValues[3] != 0 && axisValues[2] != 0 && axisValues[4] != 0) resetIndex = 4;
  if (fieldIndex == 4 && axisValues[4] != 0 && axisValues[2] != 0 && axisValues[3] != 0) resetIndex = 3;
  if (resetIndex != -1) inputs[2 * resetIndex + axis].setValue(0)
}

function buildDistributedGuidesFromInputs(guideInputs, selOrDocRect, selW, selH) {
  const axisInputs = [
    [],
    []
  ];
  for (let i = 0; i < guideInputs.length; i++) axisInputs[i & 1].push(guideInputs[i].getValue());
  return [
    GuidesPanel.distributeGuides(axisInputs[0], selOrDocRect.x, selOrDocRect.x + selW),
    GuidesPanel.distributeGuides(axisInputs[1], selOrDocRect.y, selOrDocRect.y + selH)
  ]
}

function buildPresetGuides(presetIndex, selOrDocRect, selW, selH) {
  const axis = Math.floor(presetIndex / 3),
    guides = [
      [],
      []
    ];
  guides[axis].push([selOrDocRect.x, selOrDocRect.x + selW / 2, selOrDocRect.x + selW, selOrDocRect.y, selOrDocRect.y + selH / 2, selOrDocRect.y + selH][presetIndex]);
  return guides
}
