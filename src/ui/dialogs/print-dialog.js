/**
 * Print dialog: choose a printer and its job settings, place the document on
 * the sheet, and send the page.
 *
 * Laid out as a workspace, like the Camera Raw and Lens Correction windows: the
 * page fills the left of the window and the settings sit in a column on the
 * right. The preview is the page as it will be printed — sheet, the printer's
 * unprintable border, the margins set here, and the image within them — so what
 * comes out of the printer is decided here rather than by a driver's own
 * fitting.
 */

import { Locale } from "../../core/i18n/locale.js";
import { EventType } from "../../core/event-bus.js";
import { addClass, makeElement } from "../../core/dom.js";
import { showToast } from "../../core/user-prompts.js";
import { listPrinters, submitPrintJob } from "../../core/tauri-host.js";
import { FileFormatRegistry } from "../../document/formats/registry/file-format-registry.js";
import {
  LARGE_PAGE_JPEG_QUALITY,
  STANDARD_PAPERS,
  buildPagePdf,
  computePagePlacement,
  defaultPaperIndex,
  labelAndSortPapers,
  mmToPoints,
  pointsToMm,
  shouldCompressPage,
} from "../../features/print/print-page.js";
import { Dropdown } from "../widgets/controls/popup-controls.js";
import { Button, Checkbox, Label, TextInput } from "../widgets/form-controls.js";
import { BaseDialog } from "./base-dialog.js";

/** Settings column width; matches the Lens Correction workspace. */
const WORKSPACE_WIDTH = 320;
/** Breathing room around the sheet in the preview pane. */
const PREVIEW_PADDING = 20;
/** Height reserved under the sheet for the printed-size line. */
const SUMMARY_HEIGHT = 34;
/** Longest edge of the document thumbnail drawn into the preview. */
const THUMBNAIL_MAX_EDGE = 900;
/** Default margin on every side, in millimetres. */
const DEFAULT_MARGIN_MM = 10;

/** Scale rows, in dropdown order. */
const SCALE_MODES = ["fit", "fill", "actual", "custom"];
/**
 * Range the scale slider covers. The box beside it takes any number, so a
 * placement past the slider's reach stays exact and parks the handle at its end.
 */
const MIN_SCALE_PERCENT = 1;
const MAX_SCALE_PERCENT = 400;
const DUPLEX_LABELS = { none: "dialogs.print.sidesOne", long: "dialogs.print.sidesLong", short: "dialogs.print.sidesShort" };
const COLOR_LABELS = { color: "dialogs.print.colourColour", mono: "dialogs.print.colourMono" };
const QUALITY_LABELS = { draft: "dialogs.print.qualityDraft", normal: "dialogs.print.qualityNormal", high: "dialogs.print.qualityHigh" };

/** Open a titled group of fields in the settings column. */
function appendSection(parentEl, titleLocaleKey) {
  const sectionEl = makeElement("div", "print-section");
  const headingEl = makeElement("div", "print-section-heading");
  headingEl.textContent = Locale.get(titleLocaleKey);
  sectionEl.appendChild(headingEl);
  const fieldsEl = makeElement("div", "print-section-fields");
  sectionEl.appendChild(fieldsEl);
  parentEl.appendChild(sectionEl);
  return fieldsEl;
}

function PrintDialog() {
  BaseDialog.call(this, "dialogs.print.title", "print");
  this.doc = null;
  /** Printers as the host last reported them. */
  this.printers = [];
  /** Paper sizes offered for the selected printer, named and ordered. */
  this.papers = [];
  /** Duplex / colour / quality keys behind the dropdown rows. */
  this.duplexKeys = ["none"];
  this.colorKeys = ["color"];
  this.qualityKeys = ["normal"];
  this.thumbnail = null;
  this.submitting = false;
  /** Preview pane size, set by {@link PrintDialog#resize}. */
  this.previewAreaWidth = 320;
  this.previewAreaHeight = 420;

  this.layoutEl = makeElement("div", "print-layout");
  this.body.appendChild(this.layoutEl);

  const previewPaneEl = makeElement("div", "print-preview-pane");
  this.layoutEl.appendChild(previewPaneEl);
  this.previewCanvas = makeElement("canvas", "print-preview");
  previewPaneEl.appendChild(this.previewCanvas);
  this.summaryEl = makeElement("div", "print-summary");
  previewPaneEl.appendChild(this.summaryEl);

  const workspaceEl = makeElement("div", "print-workspace");
  this.layoutEl.appendChild(workspaceEl);
  const controlsEl = makeElement("div", "print-controls scrollable");
  workspaceEl.appendChild(controlsEl);

  const printerFields = appendSection(controlsEl, "dialogs.print.sectionPrinter");
  this.printerDropdown = new Dropdown("dialogs.print.printer", [""]);
  this.printerDropdown.on(EventType.widgetSelect, this.onPrinterChange, this);
  printerFields.appendChild(this.printerDropdown.el);
  this.printerStatusLabel = new Label("");
  addClass(this.printerStatusLabel.el, "print-printer-status");
  printerFields.appendChild(this.printerStatusLabel.el);

  const paperFields = appendSection(controlsEl, "dialogs.print.sectionPaper");
  this.paperDropdown = new Dropdown("dialogs.print.paper", [""]);
  this.paperDropdown.on(EventType.widgetSelect, this.refresh, this);
  paperFields.appendChild(this.paperDropdown.el);
  this.orientationDropdown = new Dropdown("dialogs.print.orientation", [
    "dialogs.print.portrait",
    "dialogs.print.landscape",
  ]);
  this.orientationDropdown.on(EventType.widgetSelect, this.refresh, this);
  paperFields.appendChild(this.orientationDropdown.el);

  const jobFields = appendSection(controlsEl, "dialogs.print.sectionJob");
  this.copiesInput = new TextInput("dialogs.print.copies", null, 4);
  this.copiesInput.setValue("1");
  this.copiesInput.on(EventType.widgetSelect, this.refresh, this);
  jobFields.appendChild(this.copiesInput.el);
  this.colorDropdown = new Dropdown("dialogs.print.colour", [COLOR_LABELS.color]);
  jobFields.appendChild(this.colorDropdown.el);
  this.qualityDropdown = new Dropdown("dialogs.print.quality", [QUALITY_LABELS.normal]);
  jobFields.appendChild(this.qualityDropdown.el);
  this.duplexDropdown = new Dropdown("dialogs.print.sides", [DUPLEX_LABELS.none]);
  jobFields.appendChild(this.duplexDropdown.el);

  const layoutFields = appendSection(controlsEl, "dialogs.print.sectionLayout");
  this.scaleDropdown = new Dropdown("dialogs.print.scale", [
    "dialogs.print.scaleFit",
    "dialogs.print.scaleFill",
    "dialogs.print.scaleActual",
    "dialogs.print.scaleCustom",
  ]);
  this.scaleDropdown.on(EventType.widgetSelect, this.refresh, this);
  layoutFields.appendChild(this.scaleDropdown.el);
  this.scalePercentInput = new TextInput("dialogs.print.scaleAmount", "%", 3);
  this.scalePercentInput.setValue("100");
  this.scalePercentInput.on(EventType.widgetSelect, this.refresh, this);
  addClass(this.scalePercentInput.el, "print-scale-field");
  // The slider shares the field's row, after the per-cent sign, and drives the
  // same number the box holds.
  this.scaleSliderEl = makeElement("input", "print-scale-slider");
  this.scaleSliderEl.setAttribute("type", "range");
  this.scaleSliderEl.setAttribute("min", String(MIN_SCALE_PERCENT));
  this.scaleSliderEl.setAttribute("max", String(MAX_SCALE_PERCENT));
  this.scaleSliderEl.setAttribute("step", "0.5");
  this.scaleSliderEl.value = "100";
  this.scaleSliderEl.addEventListener("input", this.onScaleSliderInput.bind(this), false);
  this.scalePercentInput.el.appendChild(this.scaleSliderEl);
  layoutFields.appendChild(this.scalePercentInput.el);

  layoutFields.appendChild(buildFieldGridHeading("dialogs.print.margins"));
  this.marginInputs = {};
  const marginGridEl = makeElement("div", "print-field-grid");
  const marginLabels = {
    left: "dialogs.print.marginLeft",
    top: "dialogs.print.marginTop",
    right: "dialogs.print.marginRight",
    bottom: "dialogs.print.marginBottom",
  };
  for (const side of ["left", "top", "right", "bottom"]) {
    const input = new TextInput(marginLabels[side], "mm", 3);
    input.setValue(String(DEFAULT_MARGIN_MM));
    input.on(EventType.widgetSelect, this.refresh, this);
    this.marginInputs[side] = input;
    marginGridEl.appendChild(input.el);
  }
  layoutFields.appendChild(marginGridEl);

  this.centredCheckbox = new Checkbox("dialogs.print.centre");
  this.centredCheckbox.setValue(true);
  this.centredCheckbox.on(EventType.widgetSelect, this.refresh, this);
  layoutFields.appendChild(this.centredCheckbox.el);

  this.positionHeadingEl = buildFieldGridHeading("dialogs.print.position");
  layoutFields.appendChild(this.positionHeadingEl);
  this.positionGridEl = makeElement("div", "print-field-grid");
  this.offsetXInput = new TextInput("dialogs.print.offsetX", "mm", 3);
  this.offsetXInput.setValue("0");
  this.offsetXInput.on(EventType.widgetSelect, this.refresh, this);
  this.offsetYInput = new TextInput("dialogs.print.offsetY", "mm", 3);
  this.offsetYInput.setValue("0");
  this.offsetYInput.on(EventType.widgetSelect, this.refresh, this);
  this.positionGridEl.appendChild(this.offsetXInput.el);
  this.positionGridEl.appendChild(this.offsetYInput.el);
  layoutFields.appendChild(this.positionGridEl);

  const actionsEl = makeElement("div", "print-actions");
  workspaceEl.appendChild(actionsEl);
  this.printButton = new Button("dialogs.print.send", true, null, true);
  this.printButton.on("click", this.onOK, this);
  actionsEl.appendChild(this.printButton.el);

  this.enableUserResize({ minWidth: 720, minHeight: 480 });
}

/** Small heading above a grid of related fields. */
function buildFieldGridHeading(titleLocaleKey) {
  const headingEl = makeElement("div", "print-field-grid-heading");
  headingEl.textContent = Locale.get(titleLocaleKey);
  return headingEl;
}

PrintDialog.prototype = Object.create(BaseDialog.prototype);
PrintDialog.prototype.constructor = PrintDialog;

PrintDialog.prototype.canOpen = function (currentDoc) {
  return currentDoc != null;
};

PrintDialog.prototype.isActive = function () {
  return true;
};

PrintDialog.prototype.buildUI = function () {
  BaseDialog.prototype.buildUI.call(this);
  for (const widget of [
    this.printerDropdown,
    this.paperDropdown,
    this.orientationDropdown,
    this.colorDropdown,
    this.qualityDropdown,
    this.duplexDropdown,
    this.scaleDropdown,
    this.printButton,
  ]) {
    if (widget) widget.buildUI();
  }
};

/**
 * Open at a share of the window rather than at a fixed size, so the page is
 * previewed as large as the screen allows, within bounds that keep the
 * settings column legible on a small display and the sheet a sensible shape on
 * a large one.
 */
PrintDialog.prototype.getPreferredContentSize = function (maxW, maxH) {
  return {
    width: Math.min(Math.max(Math.round(maxW * 0.7), 760), Math.min(1100, maxW)),
    height: Math.min(Math.max(Math.round(maxH * 0.72), 520), Math.min(860, maxH)),
  };
};

/** Fit the panes to the window, then redraw the page at the new preview size. */
PrintDialog.prototype.resize = function (contentWidth, contentHeight) {
  this.layoutEl.style.width = contentWidth + "px";
  this.layoutEl.style.height = contentHeight + "px";
  this.previewAreaWidth = Math.max(80, contentWidth - WORKSPACE_WIDTH - PREVIEW_PADDING * 2);
  this.previewAreaHeight = Math.max(80, contentHeight - SUMMARY_HEIGHT - PREVIEW_PADDING * 2);
  if (this.doc != null) this.refresh();
};

PrintDialog.prototype.open = function (currentDoc) {
  this.doc = currentDoc;
  if (currentDoc.dirtyRect) currentDoc.composite();
  this.thumbnail = buildDocumentThumbnail(currentDoc, THUMBNAIL_MAX_EDGE);
  this.submitting = false;
  this.printButton.enable();
  this.printerStatusLabel.setValue(Locale.get("dialogs.print.findingPrinters"));
  this.applyPrinters([], null);
  listPrinters().then(
    (result) => this.applyPrinters(result.printers || [], result.warning || null),
    (error) => this.applyPrinters([], String(error)),
  );
};

/**
 * Take a printer listing: fill the printer menu, select the host's default,
 * and fall back to standard paper sizes when nothing was reported.
 */
PrintDialog.prototype.applyPrinters = function (printers, warning) {
  this.printers = printers;
  this.listingWarning = warning;
  if (printers.length === 0) {
    this.printerDropdown.setItems([Locale.get("dialogs.print.noPrinters")]);
    this.printerDropdown.setValue(0);
  } else {
    this.printerDropdown.setItems(printers.map((printer) => printer.name));
    const defaultIndex = printers.findIndex((printer) => printer.isDefault);
    this.printerDropdown.setValue(defaultIndex < 0 ? 0 : defaultIndex);
  }
  this.onPrinterChange();
};

/** The printer the menu is on, or null when none were reported. */
PrintDialog.prototype.selectedPrinter = function () {
  if (this.printers.length === 0) return null;
  return this.printers[Math.min(this.printerDropdown.getValue(), this.printers.length - 1)] || null;
};

/**
 * Re-offer the paper sizes and job options of the printer now selected,
 * keeping the current choice where the new printer also supports it.
 */
PrintDialog.prototype.onPrinterChange = function () {
  const printer = this.selectedPrinter();

  const offered = printer && printer.papers.length > 0 ? printer.papers : STANDARD_PAPERS;
  this.papers = labelAndSortPapers(offered);
  const previousPaperId = this.selectedPaperId;
  this.paperDropdown.setItems(this.papers.map((paper) => paper.label));
  let paperIndex = this.papers.findIndex((paper) => paper.id === previousPaperId);
  if (paperIndex < 0) {
    paperIndex = defaultPaperIndex(this.papers, printer ? printer.defaultPaperId : null);
  }
  this.paperDropdown.setValue(paperIndex);

  this.duplexKeys = printer && printer.duplexModes.length > 0 ? printer.duplexModes : ["none"];
  this.duplexDropdown.setItems(this.duplexKeys.map((key) => DUPLEX_LABELS[key] || key));
  this.duplexDropdown.setValue(0);

  this.colorKeys = printer && printer.colorModes.length > 0 ? printer.colorModes : ["color"];
  this.colorDropdown.setItems(this.colorKeys.map((key) => COLOR_LABELS[key] || key));
  this.colorDropdown.setValue(0);

  this.qualityKeys = printer && printer.qualities.length > 0 ? printer.qualities : ["normal"];
  this.qualityDropdown.setItems(this.qualityKeys.map((key) => QUALITY_LABELS[key] || key));
  this.qualityDropdown.setValue(Math.max(0, this.qualityKeys.indexOf("normal")));

  this.refresh();
};

/** Number in a text field, falling back when it has been cleared or mistyped. */
function readNumber(input, fallback) {
  const parsed = parseFloat(input.getValue());
  return isFinite(parsed) ? parsed : fallback;
}

/** The placement the current settings describe. */
PrintDialog.prototype.currentPlacement = function () {
  const paper = this.papers[Math.min(this.paperDropdown.getValue(), this.papers.length - 1)];
  this.selectedPaperId = paper.id;
  return computePagePlacement({
    paper,
    landscape: this.orientationDropdown.getValue() === 1,
    marginsPt: {
      left: mmToPoints(readNumber(this.marginInputs.left, DEFAULT_MARGIN_MM)),
      top: mmToPoints(readNumber(this.marginInputs.top, DEFAULT_MARGIN_MM)),
      right: mmToPoints(readNumber(this.marginInputs.right, DEFAULT_MARGIN_MM)),
      bottom: mmToPoints(readNumber(this.marginInputs.bottom, DEFAULT_MARGIN_MM)),
    },
    docWidthPx: this.doc.width,
    docHeightPx: this.doc.height,
    docDpi: this.doc.dpi,
    scaleMode: SCALE_MODES[this.scaleDropdown.getValue()],
    scalePercent: readNumber(this.scalePercentInput, 100),
    centered: this.centredCheckbox.getValue(),
    offsetXPt: mmToPoints(readNumber(this.offsetXInput, 0)),
    offsetYPt: mmToPoints(readNumber(this.offsetYInput, 0)),
  });
};

/** Redraw the preview and restate the printed size after any change. */
PrintDialog.prototype.refresh = function () {
  if (this.doc == null || this.papers.length === 0) return;

  // Fit, fill and actual size each work out a scale of their own, so the
  // amount is shown only where it can be set. The slider sits inside that
  // field, and goes with it.
  const customScale = SCALE_MODES[this.scaleDropdown.getValue()] === "custom";
  this.scalePercentInput.el.style.display = customScale ? "" : "none";
  const centred = this.centredCheckbox.getValue();
  this.positionHeadingEl.style.display = centred ? "none" : "";
  this.positionGridEl.style.display = centred ? "none" : "";

  const placement = this.currentPlacement();
  // Leaving the box holding the scale the other modes worked out means
  // switching to custom starts from the size on screen rather than from 100%.
  if (!customScale) this.scalePercentInput.setValue(placement.scalePercent.toFixed(1));
  this.scaleSliderEl.value = String(
    Math.min(MAX_SCALE_PERCENT, Math.max(MIN_SCALE_PERCENT, placement.scalePercent)),
  );
  this.drawPreview(placement);
  this.updateStatusText(placement);
};

/** Dragging the slider sets the amount in the box beside it. */
PrintDialog.prototype.onScaleSliderInput = function () {
  this.scalePercentInput.setValue(parseFloat(this.scaleSliderEl.value).toFixed(1));
  this.refresh();
};

/** Say which printer is selected and why the list may be short. */
PrintDialog.prototype.updateStatusText = function (placement) {
  const printer = this.selectedPrinter();
  const statusParts = [];
  if (this.listingWarning) {
    statusParts.push(this.listingWarning);
  } else if (printer) {
    if (printer.state === "stopped" || !printer.acceptingJobs) {
      statusParts.push(Locale.get("dialogs.print.printerStopped"));
    }
    if (printer.location) statusParts.push(printer.location);
  }
  this.printerStatusLabel.setValue(statusParts.join(" — "));

  const summaryLines = [
    Locale.get("dialogs.print.printedSize")
      .replace("VAR0", pointsToMm(placement.widthPt).toFixed(1))
      .replace("VAR1", pointsToMm(placement.heightPt).toFixed(1))
      .replace("VAR2", String(Math.round(placement.effectiveDpi))),
  ];
  if (placement.overflows) summaryLines.push(Locale.get("dialogs.print.doesNotFit"));
  this.summaryEl.textContent = summaryLines.join("  ·  ");
};

/**
 * Draw the sheet, the printer's unprintable border, the margin box and the
 * image, all at one scale so the preview is a true picture of the page.
 */
PrintDialog.prototype.drawPreview = function (placement) {
  const canvas = this.previewCanvas;
  const areaWidth = this.previewAreaWidth;
  const areaHeight = this.previewAreaHeight;
  const scale = Math.min(areaWidth / placement.pageWidthPt, areaHeight / placement.pageHeightPt);
  const sheetWidth = Math.max(1, Math.round(placement.pageWidthPt * scale));
  const sheetHeight = Math.max(1, Math.round(placement.pageHeightPt * scale));

  const ratio = window.devicePixelRatio || 1;
  canvas.style.width = sheetWidth + "px";
  canvas.style.height = sheetHeight + "px";
  canvas.width = Math.round(sheetWidth * ratio);
  canvas.height = Math.round(sheetHeight * ratio);
  const ctx = canvas.getContext("2d");
  if (ctx == null) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, sheetWidth, sheetHeight);

  if (this.thumbnail != null && placement.widthPt > 0 && placement.heightPt > 0) {
    ctx.save();
    // The sheet is the page: anything placed past its edge is not printed, and
    // the preview should not suggest otherwise.
    ctx.beginPath();
    ctx.rect(0, 0, sheetWidth, sheetHeight);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      this.thumbnail,
      placement.leftPt * scale,
      placement.topPt * scale,
      placement.widthPt * scale,
      placement.heightPt * scale,
    );
    ctx.restore();
  }

  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = placement.overflows ? "#d9534f" : "#4a90d9";
  ctx.strokeRect(
    placement.contentLeftPt * scale,
    placement.contentTopPt * scale,
    placement.contentWidthPt * scale,
    placement.contentHeightPt * scale,
  );
  ctx.setLineDash([]);
};

PrintDialog.prototype.onOK = function () {
  if (this.submitting) return;
  const printer = this.selectedPrinter();
  if (printer == null) {
    showToast(Locale.get("dialogs.print.noPrinters"));
    return;
  }

  const placement = this.currentPlacement();
  const options = {
    printerId: printer.id,
    jobName: this.doc.name || Locale.get("dialogs.print.untitledJob"),
    copies: Math.max(1, Math.round(readNumber(this.copiesInput, 1))),
    paperId: this.papers[this.paperDropdown.getValue()].id,
    duplex: this.duplexKeys[this.duplexDropdown.getValue()] || "none",
    colorMode: this.colorKeys[this.colorDropdown.getValue()] || "color",
    quality: this.qualityKeys[this.qualityDropdown.getValue()] || "normal",
    landscape: this.orientationDropdown.getValue() === 1,
  };

  this.submitting = true;
  this.printButton.disable();
  if (this.doc.dirtyRect) this.doc.composite();

  let pagePdf;
  try {
    pagePdf = buildPagePdf(placement, pageImageBytes(this.doc), this.doc.width, this.doc.height);
  } catch (error) {
    this.submitting = false;
    this.printButton.enable();
    showToast(Locale.get("dialogs.print.buildFailed"));
    console.error("print: composing the page failed", error);
    return;
  }

  this.close();
  showToast(Locale.get("dialogs.print.sending"));
  submitPrintJob(pagePdf, options).then(
    () => {
      this.submitting = false;
      this.printButton.enable();
      showToast(Locale.get("dialogs.print.sent").replace("VAR0", printer.name));
    },
    (error) => {
      this.submitting = false;
      this.printButton.enable();
      showToast(String(error), 7000);
    },
  );
};

/**
 * The bytes the page's image stream carries: the document's own composite, or
 * a JPEG of it when sending the pixels uncompressed would make a spool file
 * too large for the queue to take promptly.
 */
function pageImageBytes(doc) {
  const composite = doc.getRasterData();
  if (!shouldCompressPage(doc.width, doc.height)) return composite;
  const encoded = FileFormatRegistry.getFormat("JPG").encode(
    [[composite.buffer]],
    doc.width,
    doc.height,
    [LARGE_PAGE_JPEG_QUALITY],
  );
  return new Uint8Array(encoded);
}

/**
 * A small canvas copy of the document's composite for the preview.
 *
 * Sampling straight into the thumbnail keeps a large document off a full-size
 * intermediate canvas, which for a high-megapixel image would cost more memory
 * than the document itself.
 */
function buildDocumentThumbnail(doc, maxEdge) {
  const composite = doc.getRasterData();
  if (composite == null) return null;
  const step = Math.max(1, Math.ceil(Math.max(doc.width, doc.height) / maxEdge));
  const thumbWidth = Math.max(1, Math.floor(doc.width / step));
  const thumbHeight = Math.max(1, Math.floor(doc.height / step));

  const canvas = makeElement("canvas");
  canvas.width = thumbWidth;
  canvas.height = thumbHeight;
  const ctx = canvas.getContext("2d");
  if (ctx == null) return null;

  const thumbPixels = new Uint8ClampedArray(thumbWidth * thumbHeight * 4);
  for (let y = 0; y < thumbHeight; y++) {
    const sourceRow = y * step * doc.width;
    const targetRow = y * thumbWidth;
    for (let x = 0; x < thumbWidth; x++) {
      const source = (sourceRow + x * step) * 4;
      const target = (targetRow + x) * 4;
      thumbPixels[target] = composite[source];
      thumbPixels[target + 1] = composite[source + 1];
      thumbPixels[target + 2] = composite[source + 2];
      thumbPixels[target + 3] = composite[source + 3];
    }
  }
  ctx.putImageData(new ImageData(thumbPixels, thumbWidth, thumbHeight), 0, 0);
  return canvas;
}

export { PrintDialog };
